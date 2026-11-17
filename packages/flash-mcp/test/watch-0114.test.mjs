/**
 * 0.1.14 watch tests, from a day of four workers at once on a Rust workspace (issue #5): a
 * background job that ended leaves `current` (by the Harness's completion notice, or because its
 * process is gone) and never borrows another process as its child; edit scripts are not "the same
 * command rerun"; a worker in another slot's copy is named; a patch that deletes tests or grows a
 * file by thousands of lines says so beside its diffstat; and an idle stop names the last tool
 * result the worker was given.
 *
 * Process tables are fake, the runtime is a stand-in client, and every repository, state
 * directory, home and `DSH_HOME` is a throwaway temp directory.
 */

import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { ProcessWatch, observeTree } from '../lib/proctree.js'
import { patchShape } from '../lib/isolation.js'
import {
  FlashTaskService,
  activityWarnings,
  createActivity,
  createObserveState,
  observe,
  openCommands,
  raceWithBudget,
  WORKER_INSTRUCTIONS,
} from '../lib/service.js'

const AT = 1_700_000_000_000
const GIT_ID = ['-c', 'user.email=t@t', '-c', 'user.name=t']

const madeDirs = []

/** A fresh temporary directory, realpath'd so macOS `/var` vs `/private/var` cannot bite. */
function tempDir(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  madeDirs.push(dir)
  return dir
}

process.env.FLASH_DATA_DIR = tempDir('flash-watch0114-data-')

after(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true })
})

/** One observer session with `parent` and `child`, as the service's own event path makes it. */
function makeObserved() {
  const state = createObserveState()
  state.activity = createActivity(AT)
  const completion = { resolve: () => {}, reject: () => {} }
  const send = (method, params, sessionId = 'child') => observe(state, method, { ...params, sessionId }, 'parent', completion, () => {})
  observe(state, 'subagent.started', { parentSessionId: 'parent', childSessionId: 'child' }, 'parent', completion, () => {})
  observe(state, 'subagent.started', { parentSessionId: 'parent', childSessionId: 'other' }, 'parent', completion, () => {})
  const event = (type, data, sessionId) => send('session.event', { event: { type, data } }, sessionId)
  const call = (id, command, { background = false, sessionId } = {}) =>
    event('tool/call', { id, name: 'bash', arguments: JSON.stringify({ command, ...(background ? { run_in_background: true } : {}) }) }, sessionId)
  const result = (id, text, sessionId) =>
    event('tool/result', { id, message: { content: [{ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text }] }] } }, sessionId)
  return { state, call, result, event }
}

/** The Harness's completion notice for one job, word for word as `dsh-tool-jobs` writes it. */
function notice(jobId, label, status) {
  return `background job ${jobId} (bash: ${label}) finished [status: ${status}]. Read its output with job_output.`
}

const EDIT_SCRIPT = "python3 - <<'EOF'\nfrom pathlib import Path\nPath('tests/a.rs').write_text('x')\nEOF"

test('the completion notice ends a background job its worker never reads', () => {
  const { state, call, result, event } = makeObserved()
  call('c-1', EDIT_SCRIPT, { background: true })
  result('c-1', 'started background job bash-524')
  call('c-2', 'cargo build', { background: true })
  result('c-2', 'started background job bash-551')
  call('c-3', 'cargo test', { background: true, sessionId: 'other' })
  result('c-3', 'started background job bash-551', 'other')
  assert.equal(openCommands(state.activity, AT).length, 3)

  // As a user message the Harness injects into the worker's next step.
  event('user/message', { content: [{ type: 'text', text: notice('bash-524', 'python3 - <<EOF', 'completed, exit code: 0') }] })
  // And inside an inbox splice, with a failed exit: counted like a foreground failure.
  event('agent/inbox/spliced', { inserted: [{ content: [{ type: 'text', text: notice('bash-551', 'cargo build', 'failed, exit code: 101') }] }] })

  const left = openCommands(state.activity, AT)
  assert.deepEqual(left.map((entry) => entry.background), ['bash-551'], 'only the other worker’s job of the same id is still running')
  assert.equal(state.activity.failures.get('cargo build')?.count, 1)
  // A later read of the same job finds nothing to settle and counts nothing again.
  event('tool/call', { id: 'c-4', name: 'job_output', arguments: JSON.stringify({ job_id: 'bash-551' }) })
  result('c-4', 'error: E0308\n[status: failed, exit code: 101]')
  assert.equal(state.activity.failures.get('cargo build')?.count, 1)
})

test('a job quoted in a tool result or an assistant message is not ended by it', () => {
  const { state, call, result, event } = makeObserved()
  call('c-1', 'cargo test --workspace', { background: true })
  result('c-1', 'started background job bash-610')
  call('c-2', 'cat notes.txt')
  result('c-2', `${notice('bash-610', 'cargo test --workspace', 'completed, exit code: 0')}\n[exit code: 0]`)
  event('assistant/message', { message: { content: [{ type: 'text', text: notice('bash-610', 'cargo test', 'completed') }] } })
  assert.deepEqual(openCommands(state.activity, AT).map((entry) => entry.background), ['bash-610'])
})

/** A process watch over a fake table the test changes between reads. */
function watchOver(activity, tables) {
  let read = 0
  activity.runtimePid = 100
  return new ProcessWatch({ intervalMs: 0, list: async () => tables[Math.min(read++, tables.length - 1)] })
}

test('a background job whose process is gone leaves current, and one never seen gets no borrowed child', async () => {
  const { state, call, result } = makeObserved()
  const activity = state.activity
  // 19 edit scripts that end in a second, and one cargo test that really runs.
  for (let n = 0; n < 19; n += 1) {
    call(`py-${String(n)}`, `${EDIT_SCRIPT}\n# ${String(n)}`, { background: true })
    result(`py-${String(n)}`, `started background job bash-${String(700 + n)}`)
  }
  call('test', 'cargo test --workspace', { background: true })
  result('test', 'started background job bash-626')
  for (let n = 0; n < 4; n += 1) {
    call(`fg-${String(n)}`, 'git status')
    result(`fg-${String(n)}`, '[exit code: 0]')
  }
  const since = Date.now() - 1_000
  const runtime = { pid: 100, ppid: 1, cpuSeconds: 30, startedMs: since - 3_600_000, command: 'node dsh runtime' }
  const sleeper = { pid: 900, ppid: 100, cpuSeconds: 0, startedMs: since + 10, command: 'sleep 55' }
  const cargo = [
    { pid: 500, ppid: 100, cpuSeconds: 0.2, startedMs: since + 5, command: "bash -c 'cargo test --workspace'" },
    { pid: 501, ppid: 500, cpuSeconds: 40, startedMs: since + 5, command: 'cargo test --workspace' },
  ]
  const watch = watchOver(activity, [
    [runtime, sleeper, ...cargo],
    [runtime, sleeper],
  ])

  await watch.refresh(activity)
  let current = openCommands(activity, Date.now() + 20 * 60_000)
  assert.equal(current.length, 20)
  const scripts = current.filter((entry) => entry.background !== 'bash-626')
  assert.equal(scripts.some((entry) => entry.child !== undefined), false, 'no script borrows the sleep as its child')
  assert.equal(scripts.some((entry) => entry.outlivedCommands !== undefined), false, 'a script no sample found running is not called stuck')
  const test = current.find((entry) => entry.background === 'bash-626')
  assert.equal(test.child.command, 'cargo test --workspace')
  assert.equal(test.outlivedCommands, 4)
  const warnings = activityWarnings(activity, Date.now() + 20 * 60_000)
  assert.equal(warnings.filter((line) => line.includes('may be stuck')).length, 1, warnings.join('\n'))

  // The cargo run ends; the next sample no longer holds it, so it leaves current.
  await watch.refresh(activity)
  current = openCommands(activity, Date.now())
  assert.equal(current.some((entry) => entry.background === 'bash-626'), false)
})

test('observeTree reports a job whose process an earlier sample found as gone', () => {
  const calls = [{ key: 'job', tool: 'bash', command: 'cargo test', since: AT, jobId: 'bash-1', background: true }]
  const runtime = { pid: 100, ppid: 1, cpuSeconds: 1, startedMs: AT - 60_000, command: 'node dsh runtime' }
  const first = observeTree(undefined, { pid: 100, at: AT, calls, table: [runtime, { pid: 200, ppid: 100, cpuSeconds: 1, startedMs: AT, command: 'cargo test' }] })
  assert.deepEqual(first.gone, [])
  const second = observeTree(first, { pid: 100, at: AT + 60_000, calls, table: [runtime] })
  assert.deepEqual(second.gone, ['job'])
})

test('edit scripts with their own code are not one command rerun with no file changed', () => {
  // 82 `python3 - <<EOF` edit scripts, each rewriting a test file, were warned about as
  // "ran 82 times with 81 different argument lists … with no file changed between the runs".
  const { state, call, result } = makeObserved()
  for (let n = 0; n < 8; n += 1) {
    call(`py-${String(n)}`, `${EDIT_SCRIPT}\n# step ${String(n)}`)
    for (const open of state.activity.openCalls.values()) open.since = Date.now() - 5 * 60_000
    result(`py-${String(n)}`, '[exit code: 0]')
  }
  assert.deepEqual(activityWarnings(state.activity).filter((line) => line.includes(' ran ')), [])
})

test('an idle stop names the last tool result the worker was given, and its size', async () => {
  const { state, call, result } = makeObserved()
  call('c-1', 'cat target/big.log')
  result('c-1', `${'x'.repeat(250_000)}\n[exit code: 0]`)
  state.activity.lastResult.at = Date.now() - 14 * 60_000
  state.activity.at = Date.now() - 14 * 60_000
  await assert.rejects(
    raceWithBudget(new Promise(() => {}), { timeoutMs: 60_000, idleTimeoutMs: 20, activity: state.activity, label: 'flash_task', sessionId: 's' }),
    (error) => {
      assert.equal(error.code, 'IDLE')
      assert.match(error.message, /; the last tool result was "cat target\/big\.log", 250,015 characters, given to the model 14m0s ago; the session continues/)
      return true
    },
  )
})

test('patchShape counts tests removed and added per file, and how much existing files grew', () => {
  const patch = [
    'diff --git a/crates/core/src/lib.rs b/crates/core/src/lib.rs',
    '--- a/crates/core/src/lib.rs',
    '+++ b/crates/core/src/lib.rs',
    '@@ -1,9 +1,3 @@',
    '-#[test]',
    '-fn parses() {}',
    '-    #[tokio::test]',
    '-async fn serves() {}',
    '+#[test]',
    '+fn parses_again() {}',
    'diff --git a/tests/test_api.py b/tests/test_api.py',
    '--- a/tests/test_api.py',
    '+++ b/tests/test_api.py',
    '@@ -1,2 +0,0 @@',
    '-def test_get():',
    '-    pass',
    'diff --git a/web/app.test.js b/web/app.test.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/web/app.test.js',
    "+it('renders', () => {})",
    "+test.skip('later', () => {})",
  ].join('\n')
  const shape = patchShape(patch)
  assert.equal(shape.tests.removed, 3)
  assert.equal(shape.tests.added, 3)
  assert.deepEqual(shape.tests.byFile[0], { file: 'crates/core/src/lib.rs', removed: 2, added: 1 })
  assert.deepEqual(shape.grown, [], 'only shrinking files and a new one')
})

/** A committed repository holding `files`. */
function makeRepo(files) {
  const dir = tempDir('flash-watch0114-repo-')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', [...GIT_ID, 'commit', '-q', '-m', 'init'], { cwd: dir })
  return dir
}

/**
 * A runtime stand-in whose one worker writes `writes` into the tree it was given and runs the
 * commands `commands(tree)` returns, as the Harness reports them.
 */
class WorkerClient {
  constructor(writes, commands) {
    this.writes = writes
    this.commands = commands
    this.pid = 4343
    this.cwd = undefined
    this.diagnostics = ''
    this.notificationHandlers = new Set()
    this.exitHandlers = new Set()
  }

  start() {
    return this.pid
  }

  async initialize(params) {
    this.cwd = params.cwd
    return { name: 'fake-runtime', version: '0' }
  }

  async prompt({ sessionId }) {
    queueMicrotask(() => this.#replay(sessionId))
    return { messageId: 'msg-1' }
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  onExit(handler) {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
  }

  async shutdown() {}

  emit(method, params) {
    for (const handler of this.notificationHandlers) handler(method, params)
  }

  #replay(sessionId) {
    for (const [name, content] of Object.entries(this.writes)) {
      mkdirSync(dirname(join(this.cwd, name)), { recursive: true })
      writeFileSync(join(this.cwd, name), content)
    }
    const child = `child-${sessionId}`
    this.emit('session.status', { sessionId, status: 'running' })
    this.emit('subagent.started', { parentSessionId: sessionId, childSessionId: child })
    for (const [index, command] of this.commands(this.cwd).entries()) {
      const id = `call-${String(index)}`
      this.emit('session.event', { sessionId: child, event: { type: 'tool/call', data: { id, name: 'bash', arguments: JSON.stringify({ command }) } } })
      this.emit('session.event', {
        sessionId: child,
        event: { type: 'tool/result', data: { id, message: { content: [{ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text: '[exit code: 0]' }] }] } } },
      })
    }
    this.emit('subagent.finished', {
      provider: 'flash',
      parentSessionId: sessionId,
      childSessionId: child,
      status: 'ok',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'done' }],
    })
    this.emit('session.status', { sessionId, status: 'idle' })
  }
}

const RUST_TESTS = Array.from({ length: 12 }, (_, n) => `#[test]\nfn case_${String(n)}() {}\n`).join('')
const DOC = `${JSON.stringify({ blocks: Array.from({ length: 400 }, (_, n) => ({ id: n, kind: 'x' })) })}\n`

test('a flash_task result names a sibling copy the worker used, the tests its patch deletes and a file it reformatted', async () => {
  const repo = makeRepo({ 'src/lib.rs': RUST_TESTS, 'docs/blocks.json': DOC })
  const reformatted = `${JSON.stringify(JSON.parse(DOC), null, 2)}\n`
  const kept = Array.from({ length: 3 }, (_, n) => `#[test]\nfn case_${String(n)}() {}\n`).join('')
  let tree
  const client = new WorkerClient({ 'src/lib.rs': kept, 'docs/blocks.json': reformatted }, (cwd) => {
    tree = cwd
    const sibling = join(dirname(cwd), `${basename(cwd)}-twin`)
    return [
      `cd ${sibling} && CARGO_TARGET_DIR=${join(cwd, '.flash-cache', 'twin-target')} cargo test`,
      `ls ${join(cwd, 'src')}`,
    ]
  })
  const service = new FlashTaskService({
    root: repo,
    clientFactory: () => client,
    log: () => {},
    env: { DSH_HOME: tempDir('flash-watch0114-dsh-') },
    home: tempDir('flash-watch0114-home-'),
    isolate: { slots: 1, stateDir: tempDir('flash-watch0114-state-') },
  })
  try {
    const result = await service.flashTask({ task: 'remove the old constructs', cwd: repo })
    const twin = join(dirname(tree), `${basename(tree)}-twin`)
    const foreign = result.warnings.filter((line) => line.includes("another call's copy"))
    assert.deepEqual(foreign, [
      `a worker used ${twin}, another call's copy ("cd ${twin} && CARGO_TARGET_DIR=${join(tree, '.flash-cache', 'twin-target')} cargo test"): ` +
        'that tree holds another job\'s work in progress, so what it built or tested there says nothing about this change',
    ])
    assert.deepEqual(result.change.tests, { removed: 9, added: 0, byFile: [{ file: 'src/lib.rs', removed: 9, added: 0 }] })
    assert.ok(
      result.warnings.includes('the patch removes 9 test definition(s) and adds 0, 9 fewer in all: src/lib.rs (-9); check that each was meant to go'),
      result.warnings.join('\n'),
    )
    assert.ok(
      result.warnings.some((line) => /^1 existing file\(s\) grew by 1,000 lines or more: docs\/blocks\.json \(\+\d,\d{3}\); a reformat or a generated block looks like this$/.test(line)),
      result.warnings.join('\n'),
    )
  } finally {
    await service.close()
  }
})

test('a worker is told to stay in its own copy', () => {
  assert.ok(WORKER_INSTRUCTIONS.some((line) => line.startsWith('Work only in the directory you were given: never `cd` into, build or read a sibling copy')))
  assert.match(WORKER_INSTRUCTIONS.at(-1), /Rules crossed/)
})
