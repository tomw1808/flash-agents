/**
 * 0.1.13 watch tests, from a week of daily use on a Rust workspace (issue #5): a worker inside
 * its own `cargo test` is not idle while the test binaries below `cargo` work, `child` counts
 * the CPU of its whole subtree, the command a worker is waiting on heads `current` instead of a
 * background job nobody waits on, and such a job is marked once its worker has run several
 * commands past it.
 *
 * The process table is always a fake one and the runtime is the stand-in client below, so
 * nothing here reads a real home, a real `DSH_HOME`, the real temp state base or the real data
 * directory.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ACTIVE_CPU_SECONDS, ProcessWatch, observeTree } from '../lib/proctree.js'
import {
  FlashTaskService,
  activityWarnings,
  createActivity,
  createObserveState,
  describeActivity,
  observe,
  openCommands,
  WORKER_INSTRUCTIONS,
} from '../lib/service.js'
import { createToolCaller } from '../lib/index.js'
import { JobRegistry } from '../lib/jobs.js'

const AT = 1_700_000_000_000
const RUNTIME_PID = 5150

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A stand-in runtime that plays one script per prompt, as the Harness client would. */
class StandInClient {
  constructor(script) {
    this.script = script
    this.pid = RUNTIME_PID
    this.running = false
    this.prompts = []
    this.notificationHandlers = new Set()
    this.exitHandlers = new Set()
    this.diagnostics = ''
  }

  start() {
    this.running = true
    return this.pid
  }

  async initialize() {
    return { name: 'stand-in', version: '0.0.0' }
  }

  async prompt({ sessionId, text }) {
    this.prompts.push({ sessionId, text })
    queueMicrotask(() => {
      this.script({ emit: (method, params) => this.emit(method, params), sessionId }).catch(() => {})
    })
    return { messageId: `msg-${String(this.prompts.length)}` }
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  onExit(handler) {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
  }

  async shutdown() {
    this.running = false
  }

  emit(method, params) {
    for (const handler of this.notificationHandlers) handler(method, params)
  }
}

/**
 * A worker that starts `cargo test --workspace`, sends nothing for `silentMs`, and then
 * reports. `world.callAt` is when the call opened, for the fake table's start times.
 */
function cargoTestScript(world, silentMs) {
  return async ({ emit, sessionId }) => {
    const child = `child-${sessionId}`
    emit('session.status', { sessionId, status: 'running' })
    emit('subagent.started', { parentSessionId: sessionId, childSessionId: child })
    world.callAt = Date.now()
    emit('session.event', {
      sessionId: child,
      event: { type: 'tool/call', data: { id: 'call-test', name: 'bash', arguments: JSON.stringify({ command: 'cargo test --workspace' }) } },
    })
    await sleep(silentMs)
    emit('session.event', {
      sessionId: child,
      event: {
        type: 'tool/result',
        data: { id: 'call-test', message: { content: [{ type: 'tool-result', toolCallId: 'call-test', content: [{ type: 'text', text: '[exit code: 0]' }] }] } },
      },
    })
    emit('subagent.finished', {
      parentSessionId: sessionId,
      childSessionId: child,
      status: 'ok',
      stopReason: 'completed',
      provider: 'flash',
      lastAssistantMessage: [{ type: 'text', text: 'the tests pass' }],
    })
    emit('session.status', { sessionId, status: 'idle' })
  }
}

/**
 * A service over the stand-in runtime whose process watcher reads a fake table on the real
 * clock: `cargo` itself never uses CPU, and the test binary below it uses `cpuPerRead` more
 * CPU seconds at every read.
 */
function makeService({ cpuPerRead, silentMs, idleTimeoutMs }) {
  const root = mkdtempSync(join(tmpdir(), 'flash-watch-0113-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'flash-watch-0113-state-'))
  const world = { callAt: Date.now(), reads: 0 }
  const client = new StandInClient(cargoTestScript(world, silentMs))
  const service = new FlashTaskService({
    root,
    clientFactory: () => client,
    log: () => {},
    isolate: { mode: 'none', stateDir },
    honoursModelEnv: () => true,
    earlyRetryDelayMs: 0,
    progressIntervalMs: 5,
    idleTimeoutMs,
  })
  service.procWatch = new ProcessWatch({
    intervalMs: 0,
    list: async () => {
      world.reads += 1
      const start = world.callAt
      return [
        { pid: RUNTIME_PID, ppid: 1, cpuSeconds: 40, startedMs: start - 3_600_000, command: 'node dsh runtime' },
        { pid: 5200, ppid: RUNTIME_PID, cpuSeconds: 0.1, startedMs: start, command: "bash -c 'cargo test --workspace'" },
        { pid: 5201, ppid: 5200, cpuSeconds: 0, startedMs: start, command: 'cargo test --workspace' },
        { pid: 5202, ppid: 5201, cpuSeconds: world.reads * cpuPerRead, startedMs: start, command: 'target/debug/deps/core-0a1b2c' },
      ]
    },
  })
  return { root, service, world }
}

test('a worker inside its own busy cargo test is not stopped as idle', async () => {
  // The defect: nine workers on a loaded machine, one inside an eleven-minute `cargo test`
  // that sent no event; the call was stopped after the idle window with the tests passing.
  const { root, service, world } = makeService({ cpuPerRead: ACTIVE_CPU_SECONDS * 2, silentMs: 600, idleTimeoutMs: 150 })
  try {
    const result = await service.flashTask({ task: 'run the tests', cwd: root })
    assert.equal(result.status, 'ok')
    assert.ok(world.reads > 3, 'the tree was sampled while the command ran')
  } finally {
    await service.close()
  }
})

test('an idle stop while a quiet command runs says the worker was inside it', async () => {
  // A tree that does no work still ends the call — the idle stop must not be switched off by
  // a waiting process — but the reason names the command, so the caller knows the worker was
  // not lost in the model and its stored change may be whole.
  const { root, service } = makeService({ cpuPerRead: 0, silentMs: 5_000, idleTimeoutMs: 150 })
  try {
    await assert.rejects(service.flashTask({ task: 'run the tests', cwd: root }), (error) => {
      assert.equal(error.code, 'IDLE')
      assert.match(error.message, /the worker was inside its own command "cargo test --workspace" \(running \d+s, its processes had used 0 CPU s\), not waiting on the model, so its change may already be finished/)
      return true
    })
  } finally {
    await service.close()
  }
})

/** One observer session with `parent` and `child`, as the service's own event path makes it. */
function makeObserved() {
  const state = createObserveState()
  state.activity = createActivity(AT)
  const completion = { resolve: () => {}, reject: () => {} }
  const send = (method, params) => observe(state, method, params, 'parent', completion, () => {})
  send('subagent.started', { parentSessionId: 'parent', childSessionId: 'child' })
  const event = (type, data) => send('session.event', { sessionId: 'child', event: { type, data } })
  const call = (id, command, { background = false } = {}) =>
    event('tool/call', { id, name: 'bash', arguments: JSON.stringify({ command, ...(background ? { run_in_background: true } : {}) }) })
  const result = (id, text) =>
    event('tool/result', { id, message: { content: [{ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text }] }] } })
  return { state, call, result, event }
}

test('child and the progress line count the CPU of the whole tree under cargo', () => {
  const activity = createActivity(AT - 9 * 60_000)
  activity.what = 'reading a tool result'
  activity.openCalls.set('s:c', { session: 's', tool: 'bash', command: 'cargo test --workspace', since: AT - 11 * 60_000 })
  const table = (testCpu) => [
    { pid: 100, ppid: 1, cpuSeconds: 30, startedMs: AT - 3_600_000, command: 'node dsh runtime' },
    { pid: 200, ppid: 100, cpuSeconds: 0, startedMs: AT - 11 * 60_000, command: 'cargo test --workspace' },
    { pid: 201, ppid: 200, cpuSeconds: testCpu, startedMs: AT - 10 * 60_000, command: 'target/debug/deps/core-0a1b2c' },
    { pid: 202, ppid: 200, cpuSeconds: 2, startedMs: AT - 10 * 60_000, command: 'target/debug/deps/cli-3d4e5f' },
  ]
  const calls = [{ key: 's:c', tool: 'bash', command: 'cargo test --workspace', since: AT - 11 * 60_000 }]
  const first = observeTree(undefined, { pid: 100, table: table(300), at: AT - 60_000, calls })
  activity.proc = observeTree(first, { pid: 100, table: table(360), at: AT, calls })

  const [entry] = openCommands(activity, AT)
  assert.equal(entry.child.command, 'cargo test --workspace')
  assert.equal(entry.child.cpuSeconds, 0, 'cargo itself does nothing')
  assert.equal(entry.child.treeCpuSeconds, 362, 'its test binaries are the work')
  assert.equal(entry.child.treeProcesses, 3)
  const line = describeActivity(activity, AT)
  assert.match(line, /last event 9m0s ago; running "cargo test --workspace" for 11m0s \(362 CPU s so far\); its processes were working 0s ago$/)
})

test('the command a worker waits on heads current, and a background job it ran past is marked', () => {
  const { state, call, result } = makeObserved()
  // A background grep that never returns, then three commands that do, then the test run.
  call('call-grep', 'grep -rn needle .', { background: true })
  result('call-grep', 'started background job bash-1')
  for (const [index, command] of ['cargo build', 'git status', 'cargo fmt'].entries()) {
    call(`call-${String(index)}`, command)
    result(`call-${String(index)}`, '[exit code: 0]')
  }
  call('call-test', 'cargo test --workspace')

  const now = Date.now() + 28 * 60_000
  const current = openCommands(state.activity, now)
  assert.equal(current[0].command, 'cargo test --workspace', 'the worker is in its test run, not in the grep')
  assert.equal(current[1].background, 'bash-1')
  assert.equal(current[1].outlivedCommands, 4)
  assert.match(describeActivity(state.activity, now), /running "cargo test --workspace"/)
  assert.ok(
    activityWarnings(state.activity, now).some((warning) =>
      /^background job bash-1 \(grep -rn needle \.\) has run 28m\d+s while its worker ran 4 other commands without waiting on it; it may be stuck, or a server the worker meant to leave running$/.test(warning),
    ),
    activityWarnings(state.activity, now).join('\n'),
  )
})

test('a background job the worker waits on is no stranger, and one it just started is not marked', () => {
  const { state, call, result } = makeObserved()
  call('call-build', 'cargo build --release', { background: true })
  result('call-build', 'started background job bash-1')
  call('call-1', 'git status')
  result('call-1', '[exit code: 0]')
  call('call-wait', JSON.stringify({ job_id: 'bash-1' }))
  const current = openCommands(state.activity, Date.now())
  assert.equal(current.some((entry) => entry.outlivedCommands !== undefined), false)
  assert.deepEqual(activityWarnings(state.activity, Date.now()), [])
})

/** A worker's shell run that fails with `text` and exit 101, and a successful edit of `file`. */
function failingRun(observed, id, command, text) {
  observed.call(id, command)
  observed.result(id, `${text}\n[exit code: 101]`)
}
function editFile(observed, id, file) {
  observed.event('tool/call', { id, name: 'edit', arguments: JSON.stringify({ file_path: file, old_string: 'a', new_string: 'b' }) })
  observed.result(id, 'edited')
}

test('a test run that fails again after each fix is progress, not a repeated failure', () => {
  // Eight red `cargo test` runs while the worker fixed the tests its change had broken.
  const observed = makeObserved()
  for (let n = 0; n < 8; n += 1) {
    failingRun(observed, `run-${String(n)}`, 'cargo test -p core', 'error: test failed, to rerun pass `-p core --lib`')
    editFile(observed, `edit-${String(n)}`, 'src/lib.rs')
  }
  assert.deepEqual(activityWarnings(observed.state.activity), [])
})

test('edit scripts that differ are separate attempts, and so are failures that differ', () => {
  const observed = makeObserved()
  for (let n = 0; n < 3; n += 1) {
    failingRun(observed, `py-${String(n)}`, `python3 - <<'EOF'\nimport re\npattern = ${String(n)}\nEOF`, 'AssertionError: pattern not found')
  }
  for (let n = 0; n < 3; n += 1) {
    failingRun(observed, `clippy-${String(n)}`, 'cargo clippy --workspace', `error: unused variable \`x${String(n)}\``)
  }
  assert.deepEqual(activityWarnings(observed.state.activity), [])
})

test('the same failure three times with nothing changed is still a loop, named with its full count', () => {
  const observed = makeObserved()
  failingRun(observed, 'b-0', 'cargo build', 'error: linker `cc` not found')
  editFile(observed, 'e-0', 'build.rs')
  for (let n = 1; n <= 3; n += 1) failingRun(observed, `b-${String(n)}`, `cargo build -p app${String(n)}`, 'error: linker `cc` not found')
  const warnings = activityWarnings(observed.state.activity)
  assert.equal(warnings.length, 1, warnings.join('\n'))
  assert.match(
    warnings[0],
    /^"cargo build" failed 4 times, the last 3 the same way with no file changed between them in this call \(last: exit code 101, /,
  )
})

/**
 * Open and close one shell run that took `minutes` on the activity's clock: the call's `since`
 * is moved back, as a run that long would have set it.
 */
function timedRun(observed, id, command, minutes, { exit = 0 } = {}) {
  observed.call(id, command)
  for (const call of observed.state.activity.openCalls.values()) {
    if (call.id === id) call.since = Date.now() - minutes * 60_000
  }
  observed.result(id, `done\n[exit code: ${String(exit)}]`)
}

test('a command rerun with wider arguments and nothing changed between is warned about', () => {
  // `cargo mutants` widened run after run for 53 minutes; it never failed and always used CPU.
  const observed = makeObserved()
  for (const [index, sample] of [10, 20, 40, 80, 160].entries()) {
    timedRun(observed, `m-${String(index)}`, `cargo mutants --shard 1/${String(sample)}`, 10)
  }
  const warnings = activityWarnings(observed.state.activity)
  assert.equal(warnings.length, 1, warnings.join('\n'))
  assert.match(
    warnings[0],
    /^"cargo mutants" ran 5 times with 5 different argument lists in this call \(50m0s in total\) with no file changed between the runs; .*flash_cancel \(the change so far is kept as a patch\)$/,
  )
})

test('reruns with a fix between them, quick probes, or one argument list are not warned about', () => {
  const fixing = makeObserved()
  for (let n = 0; n < 6; n += 1) {
    timedRun(fixing, `t-${String(n)}`, `cargo test -p core case_${String(n)}`, 6, { exit: 101 })
    fixing.event('tool/call', { id: `e-${String(n)}`, name: 'edit', arguments: JSON.stringify({ file_path: 'src/lib.rs' }) })
    fixing.result(`e-${String(n)}`, 'edited')
  }
  assert.deepEqual(activityWarnings(fixing.state.activity).filter((line) => line.includes(' ran ')), [])

  const quick = makeObserved()
  for (let n = 0; n < 6; n += 1) timedRun(quick, `q-${String(n)}`, `rg needle${String(n)} src`, 0.1)
  assert.deepEqual(activityWarnings(quick.state.activity), [])
})

test('a call on an overloaded machine says so, and a short or unloaded one does not', async () => {
  const run = async (load, loadHintAfterMs) => {
    const { root, service } = makeService({ cpuPerRead: ACTIVE_CPU_SECONDS * 2, silentMs: 120, idleTimeoutMs: 60_000 })
    service.loadProbe = () => ({ load, threads: 24 })
    service.loadHintAfterMs = loadHintAfterMs
    try {
      return await service.flashTask({ task: 'run the tests', cwd: root })
    } finally {
      await service.close()
    }
  }
  // Nine workers on 24 threads at a load near 117.
  const loaded = await run(117, 0)
  assert.ok(
    (loaded.warnings ?? []).includes(
      "the machine's 1-minute load average reached 117.0 on 24 hardware threads during this call (4.9 per thread); " +
        'the workers were competing for CPU, so fewer calls at once may finish sooner',
    ),
    JSON.stringify(loaded.warnings),
  )
  const calm = await run(30, 0)
  assert.equal((calm.warnings ?? []).some((line) => line.includes('load average')), false, 'below twice the threads is just busy')
  const short = await run(117, 60_000)
  assert.equal((short.warnings ?? []).some((line) => line.includes('load average')), false, 'a call shorter than the 1-minute average is not named')
})

test('a build started beside a running background build of the same tool is warned about', () => {
  // Three times a worker started a second cargo command beside a background one; the second
  // waited on cargo's lock, and once the build broke until `cargo clean`.
  const observed = makeObserved()
  observed.call('call-build', 'cargo build --workspace', { background: true })
  observed.result('call-build', 'started background job bash-1')
  observed.call('call-dev', 'npm run dev', { background: true })
  observed.result('call-dev', 'started background job bash-2')
  observed.call('call-test', 'cd crates/core && cargo test')
  observed.call('call-lint', 'ruff check .')
  const warnings = activityWarnings(observed.state.activity)
  assert.deepEqual(
    warnings.filter((line) => line.includes('was still running;')),
    [
      'a worker started "cd crates/core && cargo test" while its background job bash-1 (cargo build --workspace) was still running; ' +
        "two cargo commands in one copy wait on each other's lock or break each other's build output",
    ],
  )
})

test('the worker is told to run one build at a time and to search with git grep or rg', () => {
  const text = WORKER_INSTRUCTIONS.join('\n')
  assert.ok(text.includes('Run one build or test at a time in this copy'))
  assert.ok(text.includes('Search with `git grep` or `rg`, which skip ignored folders such as `target/`'))
  assert.match(WORKER_INSTRUCTIONS.at(-1), /"Rules crossed"/)
})

test('a brief that names a file outside the root is warned about when the job starts and in its result', async () => {
  // A session put a worker's input files in its own /tmp scratch folder; the sandbox denied them.
  const scratch = mkdtempSync(join(tmpdir(), 'flash-watch-0113-scratch-'))
  const input = join(scratch, 'input.json')
  writeFileSync(input, '{}\n')
  const { root, service } = makeService({ cpuPerRead: 0, silentMs: 10, idleTimeoutMs: 60_000 })
  writeFileSync(join(root, 'inside.txt'), 'x\n')
  const task = `Read ${input}, then ${join(root, 'inside.txt')} and /tmp/does-not-exist-0113.json; never write to /tmp.`
  const expected =
    `the brief names 1 file(s) outside the service root (${input}); the worker's sandbox may not be able to read them — ` +
    'copy them into the root (an ignored folder such as .flash-tmp/) and name that path'
  try {
    const call = createToolCaller({ service, jobs: new JobRegistry() })
    const started = (await call('flash_task', { task, cwd: root, background: true })).structuredContent
    assert.deepEqual(started.warnings, [expected], 'the background answer says it before the job runs')
    const result = await service.flashTask({ task, cwd: root })
    assert.ok(result.warnings.includes(expected), JSON.stringify(result.warnings))
    const clean = await service.flashTask({ task: 'Read inside.txt.', cwd: root })
    assert.equal((clean.warnings ?? []).some((line) => line.startsWith('the brief names')), false)
  } finally {
    await service.close()
  }
})
