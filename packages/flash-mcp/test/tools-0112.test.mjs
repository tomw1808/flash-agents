/**
 * The five tool/queue/settings changes of 0.1.12: a short status listing, the taskFile
 * sentence, idle tree holders, flash_result over several jobs, and a per-machine state base.
 *
 * Everything runs through the real entry points: `createToolCaller` (the dispatcher the
 * server wires), `FlashTaskService` with a stand-in runtime, `parseOptions` (the CLI's own
 * parser), and the real `runDoctor`. Temp roots, temp state and data directories, and
 * injected commands keep away from the real home, `DSH_HOME`, state base and data directory.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createToolCaller, listTools, parseOptions, runClean, runDoctor } from '../lib/index.js'
import { FlashTaskService } from '../lib/service.js'
import { ENDED_RETENTION_MS, JobRegistry } from '../lib/jobs.js'
import { mergeConfig } from '../lib/config.js'

/** The server entry the CLI tests spawn; the state-base refusal must come from it too. */
const ENTRY = fileURLToPath(new URL('../lib/index.js', import.meta.url))

/** A configuration whose only relevant fact here is that it loads without the repo file. */
const config = mergeConfig({})

/**
 * A disposable data directory, so a pool that stores patches never touches the real one.
 * `defaultPatchDir` reads `FLASH_DATA_DIR` from the process environment, as the server does.
 */
process.env.FLASH_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'flash-tools-0112-data-')))

/** A promise the test resolves or rejects itself. */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

/** Let every queued microtask and one macrotask run. */
const tick = () => new Promise((resolve) => setImmediate(resolve))

/** Wait (briefly) for a condition a concurrent call will reach. */
async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${label}`)
}

const payloadOf = (result) => result.structuredContent
const textOf = (result) => result.content[0].text

/** A temporary directory, canonical on platforms whose temp path is a symlink. */
function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

// ── 1. short listing vs the full line by jobId ──────────────────────────────

/**
 * A service stand-in: each call parks on a gate the test controls, exactly as the jobs
 * tests' stand-in does, so a background job can be started and ended at will.
 */
class FakeService {
  constructor(reports = {}) {
    this.calls = []
    this.models = ['deepseek-v4.1-flash:cloud']
    this.reports = reports
  }

  checkModel() {}

  /** The single-id and group paths' fallback for a job the registry no longer holds. */
  readReport(key) {
    return this.reports[key]
  }

  flashTask(args, ctx) {
    return this.#park('flash_task', args, ctx)
  }

  flashBatch(args, ctx) {
    return this.#park('flash_batch', args, ctx)
  }

  #park(kind, args, ctx) {
    const gate = deferred()
    this.calls.push({ kind, args, signal: ctx.signal, progress: ctx.progress, gate })
    ctx.signal?.addEventListener('abort', () => gate.reject(new Error(`${kind} was cancelled by the client`)), {
      once: true,
    })
    return gate.promise
  }
}

/** A dispatcher over a fake service and a registry with an injected clock. */
function harness({ reports } = {}) {
  const service = new FakeService(reports)
  let now = 1_000_000
  const clock = {
    advance: (ms) => {
      now += ms
    },
  }
  const registry = new JobRegistry({ log: () => {}, now: () => now })
  const call = createToolCaller({ service, jobs: registry, log: () => {} })
  return { service, registry, clock, call }
}

/** Start a background call and return the job id it answers with. */
async function start(call, task) {
  const started = await call('flash_task', { task, cwd: '/tmp', background: true }, {})
  assert.equal(started.isError, undefined, textOf(started))
  return payloadOf(started).jobId
}

test('a status listing shortens an ended job’s progress to its first line and 160 characters', async () => {
  const { service, registry, call } = harness()
  const ended = await start(call, 'long progress line')
  const firstLine = `first line ${'x'.repeat(200)}`
  const full = `${firstLine}\nsecond line that must not appear in a listing`
  service.calls[0].progress({ message: full })
  service.calls[0].gate.resolve({ status: 'ok' })
  await registry.get(ended).settled

  const listed = payloadOf(await call('flash_status', {}, {}))
  const endedEntry = listed.jobs.find((job) => job.jobId === ended)
  assert.equal(endedEntry.lastProgress.message, `${firstLine.slice(0, 160)}…`)
  assert.equal(endedEntry.lastProgress.message.length, 161)
  assert.doesNotMatch(endedEntry.lastProgress.message, /second line/)
  // The timestamp travels with the shortened line.
  assert.equal(typeof endedEntry.lastProgress.at, 'string')

  // By id, the same job still returns the line whole.
  const one = payloadOf(await call('flash_status', { jobId: ended }, {}))
  assert.equal(one.lastProgress.message, full)

  // A running job keeps its whole line in a listing too.
  const running = await start(call, 'still running')
  service.calls[1].progress({ message: full })
  const withRunning = payloadOf(await call('flash_status', {}, {}))
  assert.equal(withRunning.jobs.find((job) => job.jobId === running).lastProgress.message, full)
})

// ── 2. the taskFile sentence in both tool schemas ───────────────────────────

test('both tools that describe taskFile say it is the whole task', () => {
  const tools = listTools()
  const sentence = '`taskFile` is the whole task: do not pass `task` with it.'
  const taskTool = tools.find((tool) => tool.name === 'flash_task')
  assert.ok(taskTool.inputSchema.properties.taskFile.description.includes(sentence), taskTool.inputSchema.properties.taskFile.description)
  const batchItem = tools
    .find((tool) => tool.name === 'flash_batch')
    .inputSchema.properties.tasks.items.oneOf.find((entry) => entry.type === 'object')
  assert.ok(batchItem.properties.taskFile.description.includes(sentence), batchItem.properties.taskFile.description)
})

// ── 3. idle holders in the queue line and queue.holders ─────────────────────

/**
 * A runtime stand-in that replays one canned child run per prompt (the shape the service
 * tests use). `delayMs` keeps the holder busy long enough for a second call to queue.
 */
class FakeSdkClient {
  constructor() {
    this.pid = 4242
    // The holder's replay waits on this gate, so the test — not a wall-clock delay — decides
    // when the tree is released and the queued call can start.
    this.gate = deferred()
    this.notificationHandlers = new Set()
    this.exitHandlers = new Set()
  }

  start() {
    return this.pid
  }

  async initialize() {
    return { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' }
  }

  async prompt({ sessionId }) {
    await this.gate.promise
    await this.#replay(sessionId)
    return { messageId: 'm1' }
  }

  /** Let every parked prompt replay: the holder finishes and the queued call can start. */
  release() {
    this.gate.resolve()
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

  async #replay(sessionId) {
    const child = `child-${sessionId}`
    this.emit('session.status', { sessionId, status: 'running' })
    this.emit('subagent.started', { parentSessionId: sessionId, childSessionId: child })
    this.emit('session.event', {
      sessionId: child,
      event: { type: 'request/header', data: { header: { config: { provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' } } } },
    })
    this.emit('subagent.finished', {
      provider: 'flash',
      agentId: 'agent-0',
      parentSessionId: sessionId,
      childSessionId: child,
      status: 'ok',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'worker result' }],
    })
    this.emit('session.status', { sessionId, status: 'idle' })
  }
}

/** A git-backed root with one disposable tree in a throwaway state directory. */
function makeIsolatedService() {
  const root = tempDir('flash-tools-0112-iso-')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  writeFileSync(join(root, 'README.md'), '# project\n')
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: root })
  const stateDir = tempDir('flash-tools-0112-state-')
  const client = new FakeSdkClient()
  const service = new FlashTaskService({
    root,
    clientFactory: () => client,
    log: () => {},
    isolate: { slots: 1, stateDir },
    honoursModelEnv: () => true,
    earlyRetryDelayMs: 0,
    progressIntervalMs: 5,
    env: { DSH_HOME: join(root, 'no-harness-home') },
  })
  const cleanup = async () => {
    await service.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  }
  return { root, service, client, cleanup }
}

test('a queued job names an idle tree holder, and a fresh holder has no idle part', async () => {
  const { root, service, client, cleanup } = makeIsolatedService()
  const jobs = new JobRegistry()
  const call = createToolCaller({ service, jobs, log: () => {} })
  try {
    const holder = payloadOf(await call('flash_task', { task: 'hold the only tree', cwd: root, background: true }))
    await waitFor(() => service.isolation.inUse === 1, 'the holder to take the tree')
    const queued = payloadOf(await call('flash_task', { task: 'wait behind it', cwd: root, background: true }))

    // A holder that has just reported is not idle: no `idleMs`, no idle part in the line.
    let queue
    await waitFor(async () => {
      queue = payloadOf(await call('flash_status', { jobId: queued.jobId })).queue
      return queue !== undefined && queue.holders.length === 1
    }, 'the queued job to report its queue')
    assert.deepEqual(Object.keys(queue.holders[0]).sort(), ['jobId', 'label', 'runningMs'])
    const freshLine = payloadOf(await call('flash_status', { jobId: queued.jobId })).lastProgress.message
    assert.doesNotMatch(freshLine, /idle/)

    // The service measures the holder's idle time from its last real activity. Move that
    // clock back six minutes and the tree's hold back 31 — the fake clock this test owns —
    // and the queue must say so, like a probe waiting behind a quiet call.
    const record = [...service.treeHolders.values()][0]
    assert.ok(record?.activity !== undefined, 'the holder carries its activity record')
    const sixMinutes = 6 * 60 * 1000
    record.since = Date.now() - 31 * 60 * 1000
    record.activity.at = Date.now() - sixMinutes

    await waitFor(async () => {
      queue = payloadOf(await call('flash_status', { jobId: queued.jobId })).queue
      return queue?.holders?.[0]?.idleMs !== undefined
    }, 'flash_status to report the idle holder')
    assert.equal(queue.holders[0].jobId, holder.jobId)
    assert.equal(queue.holders[0].label, 'hold the only tree')
    assert.ok(queue.holders[0].idleMs >= sixMinutes, String(queue.holders[0].idleMs))
    const line = payloadOf(await call('flash_status', { jobId: queued.jobId })).lastProgress.message
    assert.match(line, /tree held by .*hold the only tree, 31m\d+s, idle 6m\d+s/)
  } finally {
    client.release()
    await cleanup()
  }
})

// ── 4. flash_result over several jobs ───────────────────────────────────────

test('flash_result jobIds waits for whichever of two jobs ends first and names the rest pending', async () => {
  const { service, registry, call } = harness()
  const a = await start(call, 'job A')
  const b = await start(call, 'job B')

  const waiting = call('flash_result', { jobIds: [a, b], waitSeconds: 600 }, {})
  await tick()
  // B ends first, though it is second in the list.
  service.calls[1].gate.resolve({ status: 'ok', message: 'B is done' })
  const first = payloadOf(await waiting)
  assert.equal(first.message, 'B is done')
  assert.deepEqual(first.pending, [a])
  assert.equal(first.job.jobId, b)
  assert.equal(first.wait.endedBy, 'job-ended')

  // The other job still answers by id, and the group call then names no one as pending.
  service.calls[0].gate.resolve({ status: 'ok', message: 'A is done' })
  await registry.get(a).settled
  const second = payloadOf(await call('flash_result', { jobIds: [a, b] }, {}))
  assert.equal(second.message, 'A is done')
  assert.deepEqual(second.pending, [])
})

test('flash_result jobIds waits for a job that ends first from the other side too', async () => {
  const { service, call } = harness()
  const a = await start(call, 'job A')
  const b = await start(call, 'job B')
  const waiting = call('flash_result', { jobIds: [a, b], waitSeconds: 600 }, {})
  await tick()
  service.calls[0].gate.resolve({ status: 'ok', message: 'A is done' })
  const first = payloadOf(await waiting)
  assert.equal(first.message, 'A is done')
  assert.equal(first.job.jobId, a)
  assert.deepEqual(first.pending, [b])
})

test('flash_result jobIds without a wait returns the first job that has already ended, or the list', async () => {
  const { service, call } = harness()
  const a = await start(call, 'job A')
  const b = await start(call, 'job B')

  const nothing = payloadOf(await call('flash_result', { jobIds: [a, b] }, {}))
  assert.deepEqual(nothing, { pending: [a, b] })

  service.calls[1].gate.resolve({ status: 'ok', message: 'B is done' })
  await tick()
  const first = payloadOf(await call('flash_result', { jobIds: [a, b] }, {}))
  assert.equal(first.message, 'B is done')
  assert.deepEqual(first.pending, [a])
})

test('flash_result refuses jobId with jobIds, and a jobIds list outside 2 to 16 ids', async () => {
  const { call } = harness()
  const both = await call('flash_result', { jobId: 'job-deadbeef', jobIds: ['job-deadbeef', 'job-feedface'] }, {})
  assert.equal(both.isError, true)
  assert.match(textOf(both), /pass either jobId or jobIds, not both/)

  for (const count of [1, 17]) {
    const ids = Array.from({ length: count }, (_, index) => `job-${String(index).padStart(8, '0')}`)
    const refused = await call('flash_result', { jobIds: ids }, {})
    assert.equal(refused.isError, true, String(count))
    assert.match(textOf(refused), /jobIds must be an array of 2 to 16 job ids/)
  }
})

// ── 5. a per-machine state base in .flash-agents.local.json ─────────────────

/** Write `.flash-agents.local.json` under a temp root and return the root. */
function rootWithLocalSettings(settings) {
  const root = tempDir('flash-tools-0112-root-')
  writeFileSync(join(root, '.flash-agents.local.json'), JSON.stringify(settings))
  return root
}

/**
 * Spawn the server entry in a throwaway home with its own log, data directory and state
 * directory, and an empty stdin so it exits after the handshake.
 */
function runServe(root, extraArgs = []) {
  const home = tempDir('flash-tools-0112-serve-')
  const stateDir = join(home, 'state')
  const log = join(home, 'logs', 'flash.log')
  const run = spawnSync(
    process.execPath,
    [ENTRY, 'serve', '--root', root, '--isolate', 'none', '--state-dir', stateDir, ...extraArgs],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        DSH_HOME: join(home, 'dsh'),
        TMPDIR: join(home, 'tmp'),
        TEMP: join(home, 'tmp'),
        TMP: join(home, 'tmp'),
        FLASH_DATA_DIR: join(home, 'data'),
        FLASH_LOG_FILE: log,
      },
      encoding: 'utf8',
      timeout: 30_000,
      input: '',
    },
  )
  return { run, home, stateDir, log }
}

/** Run the real doctor for a root with fake commands and a throwaway harness home. */
async function doctorTextFor(root, env = {}) {
  const dshHome = tempDir('flash-tools-0112-doc-dsh-')
  const dataDir = tempDir('flash-tools-0112-doc-data-')
  const lines = []
  const code = await runDoctor(['--root', root], {
    env: { DSH_HOME: dshHome, FLASH_DATA_DIR: dataDir, ...env },
    write: (text) => lines.push(text),
    launcher: { command: 'dsh', prefix: [] },
    run: (command, args) => {
      if (command === 'dsh' && args[0] === '--version') return { status: 0, stdout: '0.2.0-rc.2\n', stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    },
    probe: async () => true,
    generate: async () => ({ ok: true, status: 200, ms: 10 }),
  })
  return { code, text: lines.join('') }
}

test('the local settings file’s stateBase wins over FLASH_STATE_BASE, and its platform section wins over the top level', () => {
  const root = rootWithLocalSettings({
    stateBase: join(tmpdir(), 'from-local-file'),
    platform: {
      linux: { stateBase: join(tmpdir(), 'from-platform-linux') },
      darwin: { stateBase: join(tmpdir(), 'from-platform-darwin') },
    },
  })
  const env = { FLASH_STATE_BASE: join(tmpdir(), 'from-env') }
  const top = parseOptions(['--root', root], env, config, { platform: 'win32' })
  assert.equal(top.stateBase, join(tmpdir(), 'from-local-file'))
  assert.equal(top.stateBaseSource, '.flash-agents.local.json')

  const linux = parseOptions(['--root', root], env, config, { platform: 'linux' })
  assert.equal(linux.stateBase, join(tmpdir(), 'from-platform-linux'))
  assert.equal(linux.stateBaseSource, '.flash-agents.local.json platform.linux')
})

test('an unusable stateBase in the local settings file is reported like a bad state_base before the server exits', () => {
  const root = rootWithLocalSettings({ stateBase: 'relative-base' })
  const home = tempDir('flash-tools-0112-home-')
  const log = join(home, 'logs', 'flash.log')
  const run = spawnSync(process.execPath, [ENTRY, 'serve', '--root', root], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      DSH_HOME: join(home, 'dsh'),
      TMPDIR: join(home, 'tmp'),
      TEMP: join(home, 'tmp'),
      TMP: join(home, 'tmp'),
      FLASH_DATA_DIR: join(home, 'data'),
      FLASH_LOG_FILE: log,
    },
    encoding: 'utf8',
    timeout: 30_000,
    input: '',
  })
  assert.equal(run.status, 2)
  const written = readFileSync(log, 'utf8')
  for (const text of [written, run.stderr]) {
    assert.match(text, /cannot start/)
    assert.match(text, /\.flash-agents\.local\.json/)
    assert.match(text, /"stateBase"/)
    assert.ok(text.includes(JSON.stringify('relative-base')), text)
    assert.match(text, /--state-base must be an absolute path \(got "relative-base"\)/)
  }
  assert.match(written, /^\d{4}-\d\d-\d\dT[\d:.]+Z \[flash-mcp\] cannot start/)
})

test('the doctor’s state-base row names the local settings file as the value’s source', async () => {
  const root = rootWithLocalSettings({ stateBase: join(tmpdir(), 'doctor-local-base') })
  const dshHome = tempDir('flash-tools-0112-dsh-')
  const dataDir = tempDir('flash-tools-0112-doctor-data-')
  const lines = []
  const code = await runDoctor(['--root', root], {
    env: { DSH_HOME: dshHome, FLASH_DATA_DIR: dataDir },
    write: (text) => lines.push(text),
    launcher: { command: 'dsh', prefix: [] },
    run: (command, args) => {
      if (command === 'dsh' && args[0] === '--version') return { status: 0, stdout: '0.2.0-rc.2\n', stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    },
    probe: async () => true,
    generate: async () => ({ ok: true, status: 200, ms: 10 }),
  })
  const text = lines.join('')
  assert.equal(code, 0, text)
  const row = text.split('\n').find((line) => /^ok\s+state-base\s/.test(line))
  assert.ok(row, text)
  assert.match(row, /from \.flash-agents\.local\.json/)
  assert.ok(row.includes(join(tmpdir(), 'doctor-local-base')), row)
  // The row names the absolute path of the file, exactly as `clean` does.
  assert.ok(row.includes(`at ${join(root, '.flash-agents.local.json')}`), row)
})

test('a local stateBase of null is reported as null, not replaced by the plugin setting', async () => {
  const root = rootWithLocalSettings({ stateBase: null })
  const { run, log } = runServe(root)
  assert.equal(run.status, 2, run.stderr)
  const written = readFileSync(log, 'utf8')
  for (const text of [written, run.stderr]) {
    assert.match(text, /cannot start/)
    assert.ok(text.includes('sets "stateBase" to null'), text)
    assert.doesNotMatch(text, /sets "stateBase" to ""/, text)
  }

  // The doctor's failed row reports the same value.
  const { code, text } = await doctorTextFor(root)
  assert.equal(code, 1, text)
  const row = text.split('\n').find((line) => /^fail\s+state-base\s/.test(line))
  assert.ok(row, text)
  assert.ok(row.includes('sets "stateBase" to null'), row)
})

test('an unreadable or invalid local settings file is reported at start and by the doctor, and a BOM is accepted', async () => {
  const root = tempDir('flash-tools-0112-invalid-json-')
  writeFileSync(join(root, '.flash-agents.local.json'), '{"stateBase":')
  const parsed = parseOptions(['--root', root], {}, config)
  assert.equal(parsed.localSettingsProblem?.path, join(root, '.flash-agents.local.json'))
  assert.match(parsed.localSettingsProblem.message, /not valid JSON/)

  const { run, log } = runServe(root)
  assert.equal(run.status, 0, run.stderr)
  const written = readFileSync(log, 'utf8')
  for (const text of [run.stderr, written]) {
    assert.ok(text.includes(join(root, '.flash-agents.local.json')), text)
    assert.match(text, /not valid JSON/)
  }

  // The doctor shows it as a warning, not a failure: the synced setting still starts the server.
  const { code, text } = await doctorTextFor(root)
  assert.equal(code, 0, text)
  const row = text.split('\n').find((line) => /^warn\s+local-settings\s/.test(line))
  assert.ok(row, text)
  assert.ok(row.includes(join(root, '.flash-agents.local.json')), row)
  assert.match(row, /not valid JSON/)

  // A UTF-8 BOM, which Notepad writes, is stripped before parsing, so the file still wins.
  const bomRoot = tempDir('flash-tools-0112-bom-')
  const bomBase = tempDir('flash-tools-0112-bom-base-')
  writeFileSync(join(bomRoot, '.flash-agents.local.json'), `\ufeff${JSON.stringify({ stateBase: bomBase })}`)
  const bom = parseOptions(['--root', bomRoot], {}, config)
  assert.equal(bom.stateBase, bomBase)
  assert.equal(bom.localSettingsProblem, undefined)

  // An unreadable file (a directory in its place) is ignored, and says so.
  const unreadableRoot = tempDir('flash-tools-0112-unreadable-')
  mkdirSync(join(unreadableRoot, '.flash-agents.local.json'))
  const envBase = tempDir('flash-tools-0112-unreadable-env-')
  const unreadable = parseOptions(['--root', unreadableRoot], { FLASH_STATE_BASE: envBase }, config)
  assert.equal(unreadable.stateBase, envBase, 'the local value is still ignored, not a refusal')
  assert.match(unreadable.localSettingsProblem.message, /could not be read/)
  assert.equal(unreadable.localSettingsProblem.path, join(unreadableRoot, '.flash-agents.local.json'))

  // The same problem is named at server start and warned about by the doctor.
  const unreadableServe = runServe(unreadableRoot)
  assert.equal(unreadableServe.run.status, 0, unreadableServe.run.stderr)
  const unreadableLog = readFileSync(unreadableServe.log, 'utf8')
  for (const text of [unreadableServe.run.stderr, unreadableLog]) {
    assert.ok(text.includes(join(unreadableRoot, '.flash-agents.local.json')), text)
    assert.match(text, /could not be read/)
  }
  const unreadableDoctor = await doctorTextFor(unreadableRoot)
  const unreadableRow = unreadableDoctor.text.split('\n').find((line) => /^warn\s+local-settings\s/.test(line))
  assert.ok(unreadableRow, unreadableDoctor.text)
  assert.ok(unreadableRow.includes(join(unreadableRoot, '.flash-agents.local.json')), unreadableRow)
  assert.match(unreadableRow, /could not be read/)
})

test('serve --help and -h print usage without validating the local stateBase', () => {
  const root = rootWithLocalSettings({ stateBase: 'relative-base' })
  for (const flag of ['--help', '-h']) {
    const { run } = runServe(root, [flag])
    assert.equal(run.status, 0, `${flag}: ${run.stderr}`)
    assert.match(run.stdout, /Usage: flash-agents/)
    assert.doesNotMatch(run.stderr, /cannot start/)
  }
})

test('the schemas state the listing cut and the stored report’s timing', () => {
  const tools = listTools()
  const status = tools.find((tool) => tool.name === 'flash_status')
  assert.ok(
    status.description.includes('its first line, cut at 160 characters (with … when cut)'),
    status.description,
  )
  assert.doesNotMatch(status.description, /at most 160 characters/)
  const result = tools.find((tool) => tool.name === 'flash_result')
  assert.match(result.description, /stored report carries the call's `timing` when it measured one\./)
})

// ── 6. the review's fixes around the same settings ─────────────────────────

test('the platform section is resolved before the top level, so only the winning value is validated', () => {
  const root = rootWithLocalSettings({
    stateBase: 123,
    platform: { linux: { stateBase: join(tmpdir(), 'from-platform-linux') } },
  })
  // The shared value is unusable on every platform, but this machine's section decides.
  const linux = parseOptions(['--root', root], {}, config, { platform: 'linux' })
  assert.equal(linux.stateBase, join(tmpdir(), 'from-platform-linux'))
  assert.equal(linux.stateBaseSource, '.flash-agents.local.json platform.linux')

  // Without a section for this machine the top-level value wins, and is refused.
  assert.throws(
    () => parseOptions(['--root', root], {}, config, { platform: 'darwin' }),
    /\.flash-agents\.local\.json sets "stateBase" to 123, which is not a path/,
  )
})

test('a present local stateBase that is not a non-empty string is refused, and a relative one by the path rule', () => {
  for (const value of [42, '', null, ['/tmp/x']]) {
    const root = rootWithLocalSettings({ stateBase: value })
    assert.throws(
      () => parseOptions(['--root', root], {}, config),
      (error) => {
        assert.equal(error.code, 'STATE_BASE_INVALID', JSON.stringify(value))
        assert.equal(error.stateBaseSource, '.flash-agents.local.json', JSON.stringify(value))
        assert.match(error.message, /which is not a path/, JSON.stringify(value))
        return true
      },
    )
  }
  const relative = rootWithLocalSettings({ stateBase: 'relative-base' })
  assert.throws(
    () => parseOptions(['--root', relative], {}, config),
    (error) => {
      assert.equal(error.code, 'STATE_BASE_INVALID')
      assert.equal(error.stateBaseSource, '.flash-agents.local.json')
      assert.match(error.message, /--state-base must be an absolute path \(got "relative-base"\)/)
      return true
    },
  )
})

test('clean takes the state base from the local settings file of --root, before FLASH_STATE_BASE', async () => {
  const localBase = tempDir('flash-tools-0112-clean-local-')
  const root = rootWithLocalSettings({ stateBase: localBase })
  const dataDir = tempDir('flash-tools-0112-clean-data-')
  const lines = []
  const code = await runClean(['--root', root], {
    env: { FLASH_STATE_BASE: join(tmpdir(), 'clean-env-loses'), FLASH_DATA_DIR: dataDir },
    write: (text) => lines.push(text),
    platform: 'linux',
  })
  assert.equal(code, 0)
  const text = lines.join('')
  assert.ok(text.includes(`flash-mcp state: ${localBase}`), text)
  // The report names the file the value came from, so a user edits the right one.
  assert.ok(text.includes(join(root, '.flash-agents.local.json')), text)

  // The explicit flag still wins over the local file, as it does for the server.
  const flagBase = tempDir('flash-tools-0112-clean-flag-')
  const flagLines = []
  const flagCode = await runClean(['--root', root, '--state-base', flagBase], {
    env: { FLASH_STATE_BASE: join(tmpdir(), 'clean-env-loses-too'), FLASH_DATA_DIR: dataDir },
    write: (text) => flagLines.push(text),
    platform: 'linux',
  })
  assert.equal(flagCode, 0)
  const flagText = flagLines.join('')
  assert.ok(flagText.includes(`flash-mcp state: ${flagBase}`), flagText)
  assert.doesNotMatch(flagText, /from \.flash-agents\.local\.json/)
})

test('clean reads the local settings file from the cwd when no --root is given', async () => {
  const localBase = tempDir('flash-tools-0112-clean-cwd-')
  const cwd = rootWithLocalSettings({ stateBase: localBase })
  const dataDir = tempDir('flash-tools-0112-clean-cwd-data-')
  const previous = process.cwd()
  const lines = []
  process.chdir(cwd)
  try {
    const code = await runClean([], {
      env: { FLASH_DATA_DIR: dataDir },
      write: (text) => lines.push(text),
      platform: 'linux',
    })
    assert.equal(code, 0)
    const text = lines.join('')
    assert.ok(text.includes(`flash-mcp state: ${localBase}`), text)
    assert.ok(text.includes(join(cwd, '.flash-agents.local.json')), text)
  } finally {
    process.chdir(previous)
  }
})

test('the doctor’s failed state-base row fixes the local file and its key, not the plugin option', async () => {
  const root = rootWithLocalSettings({ stateBase: 'relative-base' })
  const dshHome = tempDir('flash-tools-0112-doctor-bad-dsh-')
  const dataDir = tempDir('flash-tools-0112-doctor-bad-data-')
  const lines = []
  const code = await runDoctor(['--root', root], {
    env: { DSH_HOME: dshHome, FLASH_DATA_DIR: dataDir },
    write: (text) => lines.push(text),
    launcher: { command: 'dsh', prefix: [] },
    run: (command, args) => {
      if (command === 'dsh' && args[0] === '--version') return { status: 0, stdout: '0.2.0-rc.2\n', stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    },
    probe: async () => true,
    generate: async () => ({ ok: true, status: 200, ms: 10 }),
  })
  const text = lines.join('')
  assert.equal(code, 1, text)
  const row = text.split('\n').find((line) => /^fail\s+state-base\s/.test(line))
  assert.ok(row, text)
  assert.match(row, /\.flash-agents\.local\.json/)
  const fix = text.split('\n').find((line) => line.startsWith('Fix: state-base:'))
  assert.ok(fix, text)
  assert.match(fix, /\.flash-agents\.local\.json/)
  assert.match(fix, /"stateBase"/)
  assert.doesNotMatch(fix, /plugin option/)
})

// ── 7. jobIds: the count's endpoints, an evicted id, and an unknown one ─────

test('flash_result jobIds accepts exactly 2 and exactly 16 ids', async () => {
  const { call } = harness()
  const two = [await start(call, 'job one'), await start(call, 'job two')]
  const pair = payloadOf(await call('flash_result', { jobIds: two }, {}))
  assert.deepEqual(pair.pending, two, 'two ids are accepted and both are pending')

  const many = []
  for (let index = 0; index < 16; index += 1) many.push(await start(call, `job ${String(index)}`))
  const group = payloadOf(await call('flash_result', { jobIds: many }, {}))
  assert.deepEqual(group.pending, many, 'sixteen ids are accepted')
})

test('flash_result jobIds falls back to a stored report for an evicted id, and names a truly unknown one', async () => {
  const reports = {}
  const { service, registry, clock, call } = harness({ reports })
  const evicted = await start(call, 'job A')
  const running = await start(call, 'job B')
  service.calls[0].gate.resolve({ status: 'ok', message: 'A is done' })
  await registry.get(evicted).settled

  // The retention window drops the ended job from memory; the report on disk stays.
  clock.advance(ENDED_RETENTION_MS + 1)
  assert.equal(registry.get(evicted), undefined, 'the ended job was evicted')
  reports[evicted] = {
    kind: 'flash_task',
    status: 'ok',
    label: 'job A',
    createdAt: '2025-01-01T00:00:00.000Z',
    report: 'A whole stored report',
    reportPath: '/tmp/job-a.report.json',
    timing: { totalMs: 3 },
  }

  const stored = payloadOf(await call('flash_result', { jobIds: [evicted, running] }, {}))
  assert.equal(stored.jobId, evicted)
  assert.equal(stored.report, 'A whole stored report')
  assert.deepEqual(stored.timing, { totalMs: 3 }, 'the stored timing travels with the report')
  assert.deepEqual(stored.pending, [running])
  assert.equal(stored.unknown, undefined)
  assert.match(stored.note, /no longer held in memory/)

  // An id with neither a held job nor a stored report is listed; the rest still answers.
  service.calls[1].gate.resolve({ status: 'ok', message: 'B is done' })
  await registry.get(running).settled
  const withUnknown = payloadOf(await call('flash_result', { jobIds: [running, 'job-0000dead'] }, {}))
  assert.equal(withUnknown.message, 'B is done')
  assert.deepEqual(withUnknown.unknown, ['job-0000dead'])

  // Only a group whose every id is unknown is refused.
  const refused = await call('flash_result', { jobIds: ['job-0000dead', 'job-0000beef'] }, {})
  assert.equal(refused.isError, true)
  assert.match(textOf(refused), /flash_result failed: unknown jobs "job-0000dead", "job-0000beef"/)
})

test('flash_result jobIds lists an id the wait no longer found under unknown', async () => {
  const running = 'job-0000cafe'
  const dropped = 'job-0000dead'
  const jobsById = new Map([
    [running, { jobId: running, kind: 'flash_task', label: 'still running', state: 'running' }],
    [dropped, { jobId: dropped, kind: 'flash_task', label: 'about to be evicted', state: 'running' }],
  ])
  const registry = {
    get: (id) => jobsById.get(id),
    waitForAny: async () => {
      // The registry dropped the id while the group wait was running.
      jobsById.delete(dropped)
      return { job: undefined, missing: dropped, endedBy: 'not-waited' }
    },
  }
  const call = createToolCaller({ service: { models: [] }, jobs: registry, log: () => {} })
  const answer = payloadOf(await call('flash_result', { jobIds: [running, dropped], waitSeconds: 10 }, {}))
  assert.deepEqual(answer.unknown, [dropped], 'the missing id is named as unknown')
  assert.deepEqual(answer.pending, [running])
})

test('flash_result jobIds reads a report stored by a real service call', async () => {
  const root = tempDir('flash-tools-0112-real-root-')
  const stateDir = tempDir('flash-tools-0112-real-state-')
  const client = new FakeSdkClient()
  const service = new FlashTaskService({
    root,
    clientFactory: () => client,
    log: () => {},
    isolate: { mode: 'none', stateDir },
    honoursModelEnv: () => true,
    earlyRetryDelayMs: 0,
    env: { DSH_HOME: join(root, 'no-harness-home') },
  })
  let now = 1_000_000
  const registry = new JobRegistry({ log: () => {}, now: () => now })
  const call = createToolCaller({ service, jobs: registry, log: () => {} })
  try {
    const started = payloadOf(await call('flash_task', { task: 'store a report', cwd: root, background: true }, {}))
    const storedId = started.jobId
    client.release()
    await registry.get(storedId).settled

    // The record the real call wrote: the key is the job id and the shape is the store's own.
    const record = service.readReport(storedId)
    assert.ok(record, 'the real call stored its report')
    assert.equal(record.key, storedId)
    assert.equal(record.jobId, storedId)
    assert.equal(record.kind, 'flash_task')
    assert.equal(record.status, 'ok')
    assert.equal(typeof record.report, 'string')
    assert.equal(typeof record.timing?.totalMs, 'number')
    assert.ok(record.reportPath.startsWith(stateDir), record.reportPath)

    // Drop the job from memory; the report on disk is now the only handle on its answer.
    now += ENDED_RETENTION_MS + 1
    assert.equal(registry.get(storedId), undefined, 'the ended job was evicted')
    const waiting = registry.start({
      kind: 'flash_task',
      label: 'still running',
      run: () => new Promise(() => {}),
    })

    const answer = payloadOf(await call('flash_result', { jobIds: [storedId, waiting.jobId] }, {}))
    assert.equal(answer.jobId, storedId)
    assert.equal(answer.kind, 'flash_task')
    assert.equal(answer.status, 'ok')
    assert.equal(answer.report, record.report)
    assert.equal(answer.reportPath, record.reportPath)
    assert.equal(typeof answer.timing?.totalMs, 'number')
    assert.deepEqual(answer.pending, [waiting.jobId])
    assert.equal(answer.unknown, undefined)
  } finally {
    await service.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  }
})
