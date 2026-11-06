/**
 * 0.1.12 runtime lifecycle and reporting: an idle runtime of either sandbox mode is shut
 * down, a report is stored with isolation off and survives a restart, every result carries
 * a measured time breakdown, and two new standing worker rules reach the prompt.
 *
 * The runtime is a stand-in Harness client; the clock is Node's fake timer. Every directory
 * is made here and removed when the file finishes, so nothing touches a real home,
 * `DSH_HOME`, the temp state base or the data directory.
 */

import assert from 'node:assert/strict'
import test, { after, mock } from 'node:test'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'

import { FlashTaskService, WORKER_INSTRUCTIONS, buildChildPrompt } from '../lib/service.js'
import { createToolCaller } from '../lib/index.js'
import { rootDigest } from '../lib/isolation.js'
import { JobRegistry } from '../lib/jobs.js'

const madeDirs = []

/** How long the failing call's salvage is made to take, so its total can be checked. */
const SALVAGE_PAUSE_MS = 80

/** A fresh temporary directory, realpath'd so macOS `/var` vs `/private/var` cannot bite. */
function tempDir(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  madeDirs.push(dir)
  return dir
}

/** A throwaway durable data directory, so no test can reach the real one. */
process.env.FLASH_DATA_DIR = tempDir('flash-runtime0112-data-')

after(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true })
})

/** A committed repository; the isolated timing test needs one real copy. */
function makeRepo({ settings, gitignore } = {}) {
  const dir = tempDir('flash-runtime0112-repo-')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# project\n')
  if (gitignore !== undefined) writeFileSync(join(dir, '.gitignore'), gitignore)
  if (settings !== undefined) writeFileSync(join(dir, '.flash-agents.json'), JSON.stringify(settings))
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: dir })
  return dir
}

/**
 * A repository with one setup step that builds an ignored directory and keeps it between
 * calls, so the call after it finds the step's stamp and the kept output.
 */
function makeSetupRepo() {
  return makeRepo({
    gitignore: 'node_modules/\n',
    settings: {
      slotSetup: [
        {
          run: [process.execPath, '-e', "require('node:fs').mkdirSync('node_modules', { recursive: true })"],
          inputs: [],
          keep: ['node_modules'],
        },
      ],
    },
  })
}

/** Read the fleet payload back out of the dispatch prompt. */
function promptArgs(text) {
  const start = text.indexOf('<args>\n')
  const end = text.indexOf('\n</args>')
  assert.ok(start >= 0 && end > start, 'the dispatch prompt must carry an args block')
  return JSON.parse(text.slice(start + '<args>\n'.length, end))
}

/**
 * A stand-in Harness runtime speaking the same notification language the service observes.
 * `hold` keeps a prompt's replay pending, so a test can advance the idle clock while a call
 * is still using the runtime.
 */
class FakeRuntime {
  constructor(profile) {
    this.profile = profile
    this.pid = 4242
    this.shutdowns = 0
    this.prompts = []
    this.pending = new Map()
    this.notifications = new Set()
    this.exitHandlers = new Set()
    this.hold = false
    this.exitOnPrompt = false
    this.finalText = 'the worker report'
    this.memberTexts = []
    this.running = false
  }

  start() {
    this.running = true
    return this.pid
  }

  async initialize() {
    return { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' }
  }

  onNotification(handler) {
    this.notifications.add(handler)
    return () => this.notifications.delete(handler)
  }

  onExit(handler) {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
  }

  async prompt({ sessionId, text }) {
    this.prompts.push({ sessionId, text })
    this.pending.set(sessionId, text)
    if (this.exitOnPrompt) {
      // The process dies with the session running, which is how `#runSession` learns of it.
      this.running = false
      for (const handler of this.exitHandlers) handler()
      return { messageId: `message-${String(this.prompts.length)}` }
    }
    if (!this.hold) this.release(sessionId)
    return { messageId: `message-${String(this.prompts.length)}` }
  }

  /** Replay a prompt this fake was holding. */
  release(sessionId) {
    const text = this.pending.get(sessionId)
    if (text === undefined) return
    this.pending.delete(sessionId)
    this.#replay(sessionId, text)
  }

  async shutdown() {
    this.shutdowns += 1
    this.running = false
    this.pending.clear()
  }

  emit(method, params) {
    for (const handler of this.notifications) handler(method, params)
  }

  #replay(sessionId, text) {
    this.emit('session.status', { sessionId, status: 'running' })
    if (text.includes('<args>\n')) {
      this.#replayFleet(sessionId, text)
      return
    }
    const child = `child-${sessionId}`
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
      lastAssistantMessage: [{ type: 'text', text: this.finalText }],
    })
    this.emit('session.status', { sessionId, status: 'idle' })
  }

  #replayFleet(sessionId, text) {
    const { items, perItemChars } = promptArgs(text)
    const childId = (index) => `child-${sessionId}-${String(index)}`
    const message = (index) => this.memberTexts[index] ?? `fleet result ${String(index)}`
    for (const [index] of items.entries()) {
      this.emit('subagent.started', { parentSessionId: sessionId, childSessionId: childId(index) })
      this.emit('session.event', {
        sessionId: childId(index),
        event: { type: 'request/header', data: { header: { config: { provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' } } } },
      })
    }
    for (const [index] of items.entries()) {
      this.emit('subagent.finished', {
        provider: 'flash',
        agentId: `agent-${String(index)}`,
        parentSessionId: sessionId,
        childSessionId: childId(index),
        status: 'ok',
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: message(index) }],
      })
      this.emit('session.event', {
        sessionId,
        event: { type: 'tool-workflow/agent-start', data: { runId: 'run-1', seq: index + 1, label: `task-${String(index + 1)}`, childId: childId(index) } },
      })
      this.emit('session.event', { sessionId, event: { type: 'tool-workflow/agent-end', data: { runId: 'run-1', seq: index + 1, outcome: 'completed' } } })
    }
    this.emit('session.event', { sessionId, event: { type: 'tool-workflow/run-start', data: { runId: 'run-1', name: 'flash-batch' } } })
    const entries = items.map((_, index) => ({ index, ok: true, result: message(index).slice(0, perItemChars) }))
    this.emit('session.event', {
      sessionId,
      event: {
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          message: {
            source: { kind: 'tool', callId: 'call-1' },
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call-1',
                content: [{ type: 'text', text: `workflow "flash-batch" completed (${String(items.length)} agents).\nReturn value:\n${JSON.stringify(entries)}` }],
              },
            ],
          },
        },
      },
    })
    this.emit('session.status', { sessionId, status: 'idle' })
  }
}

/** A service over its own directories, a fresh stand-in per runtime, and captured logs. */
function makeService({ root, isolate, stateDir, configureClient, ...overrides } = {}) {
  const actualRoot = root ?? tempDir('flash-runtime0112-root-')
  const actualState = stateDir ?? tempDir('flash-runtime0112-state-')
  const clients = []
  const logs = []
  const service = new FlashTaskService({
    root: actualRoot,
    clientFactory: (profile) => {
      const client = new FakeRuntime(profile)
      configureClient?.(client)
      clients.push(client)
      return client
    },
    log: (line) => logs.push(line),
    isolate: isolate ?? { mode: 'none', stateDir: actualState },
    honoursModelEnv: () => true,
    earlyRetryDelayMs: 0,
    env: { DSH_HOME: join(actualRoot, 'no-harness-home') },
    ...overrides,
  })
  return { root: actualRoot, stateDir: actualState, clients, logs, service }
}

/** Let every pending microtask of one timer callback run. */
async function flush() {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
}

/** Wait for a condition reached by another pending call, without touching the fake clock. */
async function waitUntil(predicate, label) {
  for (let turn = 0; turn < 500; turn += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  assert.fail(`timed out waiting for ${label}`)
}

/** The structured payload of a tool result. */
function payload(result) {
  assert.notEqual(result.isError, true, result.content?.[0]?.text)
  return result.structuredContent
}

/** Every present timing part is a real measurement, and the parts fit inside the total. */
function assertTiming(timing, { copy }) {
  assert.ok(timing !== null && typeof timing === 'object', 'every result carries timing')
  for (const key of ['queuedMs', 'workerMs', 'totalMs']) {
    assert.equal(typeof timing[key], 'number', `${key} is measured`)
    assert.ok(timing[key] >= 0, `${key} is not negative`)
  }
  assert.ok(timing.workerMs > 0, 'a call whose worker ran measured a non-zero worker time')
  for (const key of copy ? ['prepareMs', 'collectMs'] : []) {
    assert.equal(typeof timing[key], 'number', `${key} is measured for a copied call`)
    assert.ok(timing[key] >= 0, `${key} is not negative`)
  }
  assert.equal('setupMs' in timing, false, 'no setup step ran, so the part is omitted')
  const parts = ['queuedMs', 'prepareMs', 'setupMs', 'workerMs', 'collectMs']
    .filter((key) => key in timing)
    .reduce((sum, key) => sum + timing[key], 0)
  assert.ok(parts <= timing.totalMs, `parts ${String(parts)} must fit in total ${String(timing.totalMs)}`)
}

/**
 * A failure whose copy was prepared carries the parts measured before it ended.
 *
 * The worker's run is one of them even when the worker is what ended the call — a timeout, an
 * idle silence, a runtime that exited — and the copy that was prepared is a real measurement,
 * not a zero.
 */
function assertFailureTiming(error) {
  assert.ok(error?.timing !== null && typeof error.timing === 'object', `the failure carries timing: ${error?.message}`)
  for (const key of ['queuedMs', 'prepareMs', 'workerMs', 'totalMs']) {
    assert.equal(typeof error.timing[key], 'number', `${key} is measured on failure`)
    assert.ok(error.timing[key] >= 0, `${key} is not negative`)
  }
  assert.ok(error.timing.prepareMs > 0, 'the copy was prepared, so making it took measured time')
  assert.ok(error.timing.workerMs > 0, 'the worker ran, so its run is measured even though it ended the call')
  const parts = ['queuedMs', 'prepareMs', 'setupMs', 'workerMs', 'collectMs']
    .filter((key) => key in error.timing)
    .reduce((sum, key) => sum + error.timing[key], 0)
  assert.ok(parts <= error.timing.totalMs, `parts ${String(parts)} must fit in total ${String(error.timing.totalMs)}`)
}

/** Sleep without spinning and without a timer: a synchronous stand-in for slow work. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * The reader another process runs while this one rewrites a report: read the path in a tight
 * loop, parse every read, and report how many reads parsed and how many saw a partial record.
 * It starts only once the parent is writing — `ready` on its first line — and stops when the
 * parent writes the stop file.
 */
const READER_SOURCE = `
const { existsSync, readFileSync } = require('node:fs')
const [path, stop] = process.argv.slice(1)
let reads = 0
let partial = 0
process.stdout.write('ready\\n')
while (!existsSync(stop)) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    partial += 1
    continue
  }
  reads += 1
  try {
    const record = JSON.parse(text)
    if (typeof record.report !== 'string') partial += 1
  } catch {
    partial += 1
  }
}
process.stdout.write(JSON.stringify({ reads, partial }) + '\\n')
`

// ── 1. idle runtimes stop ───────────────────────────────────────────────────

test('a read-only runtime is shut down after the idle time, and the shutdown is logged', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { root, clients, logs, service } = makeService({
      isolate: { mode: 'none', stateDir: tempDir('flash-runtime0112-idle-') },
      runtimeIdleTimeoutMs: 100,
    })
    const result = await service.flashTask({ task: 'review the change', cwd: root, mode: 'read-only' })
    assert.equal(result.mode, 'read-only')
    assert.equal(clients.length, 1)
    assert.equal(clients[0].shutdowns, 0, 'a just-used runtime stays for the next call')

    mock.timers.tick(99)
    await flush()
    assert.equal(clients[0].shutdowns, 0, 'the idle window has not passed')

    mock.timers.tick(1)
    await flush()
    assert.equal(clients[0].shutdowns, 1, 'the read-only runtime is shut down when idle')
    assert.ok(logs.some((line) => /shut down the idle .*readonly.*runtime/.test(line)), logs.join('\n'))
    await service.close()
    assert.equal(clients[0].shutdowns, 1, 'close does not shut a runtime down twice')
  } finally {
    mock.timers.reset()
  }
})

test('a writing runtime is shut down after the idle time too', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { root, clients, service } = makeService({
      isolate: { mode: 'none', stateDir: tempDir('flash-runtime0112-idle-write-') },
      runtimeIdleTimeoutMs: 100,
    })
    const result = await service.flashTask({ task: 'write a file', cwd: root })
    assert.equal(result.mode, 'workspace-write')
    assert.equal(clients.length, 1)
    assert.equal(clients[0].shutdowns, 0)

    mock.timers.tick(100)
    await flush()
    assert.equal(clients[0].shutdowns, 1, 'the writing runtime is shut down when idle')
    await service.close()
  } finally {
    mock.timers.reset()
  }
})

test('a call arriving before the idle timer fires cancels it', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  // The idle timer the first call armed is kept by handle, and every clearTimeout is recorded:
  // "no shutdown happened" alone proves nothing, because the shutdown callback declines on its
  // own while a session is open. What has to be true is that the arriving call *cancelled* the
  // timer, so nothing fires at all.
  const armed = []
  const cleared = new Set()
  const mockedSetTimeout = globalThis.setTimeout
  const mockedClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = mockedSetTimeout(callback, delay, ...args)
    if (delay === 100) armed.push(timer)
    return timer
  }
  globalThis.clearTimeout = (timer) => {
    cleared.add(timer)
    return mockedClearTimeout(timer)
  }
  try {
    const { root, clients, service } = makeService({
      isolate: { mode: 'none', stateDir: tempDir('flash-runtime0112-busy-') },
      runtimeIdleTimeoutMs: 100,
    })
    await service.flashTask({ task: 'first', cwd: root })
    const client = clients[0]
    client.hold = true
    const second = service.flashTask({ task: 'still working', cwd: root })
    await waitUntil(() => client.prompts.length === 2, 'the second call to reach the runtime')

    assert.equal(armed.length, 1, 'the first call armed one runtime idle timer')
    assert.ok(cleared.has(armed[0]), 'the arriving call cleared the idle timer the first call armed')
    // Nothing armed a replacement: the runtime is held by a call, not waiting to be shut down.
    assert.equal(armed.length, 1, 'no idle timer is armed while a call uses the runtime')
    // And the fake clock proves the cleared timer really is gone, not merely ignored.
    mock.timers.tick(100)
    await flush()
    assert.equal(client.shutdowns, 0, 'a busy runtime is left alone')

    client.release(client.prompts[1].sessionId)
    const result = await second
    assert.equal(result.status, 'ok')

    mock.timers.tick(100)
    await flush()
    assert.equal(client.shutdowns, 1, 'once the call ends, the idle window starts again')
    await service.close()
  } finally {
    globalThis.setTimeout = mockedSetTimeout
    globalThis.clearTimeout = mockedClearTimeout
    mock.timers.reset()
  }
})

test('a writing runtime rooted at a slot is shut down after the idle time', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const repo = makeRepo()
    const { clients, logs, service } = makeService({
      root: repo,
      isolate: { slots: 1, stateDir: tempDir('flash-runtime0112-idle-slot-') },
      runtimeIdleTimeoutMs: 100,
    })
    const result = await service.flashTask({ task: 'write a file', cwd: repo })
    assert.equal(result.mode, 'workspace-write')
    assert.equal(result.change.available, true)
    assert.equal(clients.length, 1)
    assert.equal(clients[0].shutdowns, 0, 'the slot keeps its warm runtime for the next call')

    mock.timers.tick(100)
    await flush()
    assert.equal(clients[0].shutdowns, 1, 'the runtime the slot left warm is shut down when idle')
    assert.ok(
      logs.some((line) => /shut down the idle .* runtime on .*slots/.test(line)),
      logs.join('\n'),
    )
    await service.close()
  } finally {
    mock.timers.reset()
  }
})

// ── 2. reports without isolation ────────────────────────────────────────────

test('with isolation off a report is stored in the state directory and flash_result reads it after a restart', async () => {
  const root = tempDir('flash-runtime0112-report-root-')
  const stateDir = tempDir('flash-runtime0112-report-state-')
  const first = makeService({ root, isolate: { mode: 'none', stateDir } })
  const result = await first.service.flashTask({ task: 'review it', cwd: root }, { jobId: 'job-deadbeef' })

  assert.equal(typeof result.reportPath, 'string', 'a report path is returned with isolation off')
  assert.ok(result.reportPath.startsWith(`${stateDir}/`) || result.reportPath.startsWith(`${stateDir}\\`), result.reportPath)
  const stored = JSON.parse(readFileSync(result.reportPath, 'utf8'))
  assert.equal(stored.key, 'job-deadbeef')
  assert.equal(stored.report, 'the worker report')
  assert.deepEqual(stored.timing, result.timing)
  await first.service.close()

  const second = makeService({ root, isolate: { mode: 'none', stateDir } })
  const jobs = new JobRegistry()
  const call = createToolCaller({ service: second.service, jobs })
  const read = payload(await call('flash_result', { jobId: 'job-deadbeef' }))
  assert.equal(read.jobId, 'job-deadbeef')
  assert.equal(read.report, 'the worker report')
  assert.equal(read.reportPath, result.reportPath)
  assert.deepEqual(read.timing, result.timing, 'flash_result after a restart keeps the stored timing')
  await second.service.close()
})

test('with isolation off reports use the configured state base, the base a pool would use', async () => {
  const root = tempDir('flash-runtime0112-base-root-')
  const base = tempDir('flash-runtime0112-base-')
  const { service } = makeService({ root, isolate: { mode: 'none', baseDir: base } })
  const result = await service.flashTask({ task: 'review it', cwd: root }, { jobId: 'job-c0ffee00' })

  assert.ok(
    result.reportPath.startsWith(join(base, rootDigest(root)) + sep),
    `a report must sit under the configured base, not the temp default: ${result.reportPath}`,
  )
  assert.equal(JSON.parse(readFileSync(result.reportPath, 'utf8')).report, 'the worker report')
  await service.close()
})

test('a reader never sees half a report while one is written again and again', async () => {
  // A reader on another server opens the report path while this one rewrites the same record.
  // Writing in place truncates the file and then fills it, so a reader can see an empty or a
  // half-written record — with a large report that window is wide. The write goes to a
  // temporary file renamed into place, so every read is a whole record.
  // Ends on a non-space, so the report is stored exactly as written.
  const big = `${'a whole report, rewritten while it is read. '.repeat(40_000)}END`
  const { root, service } = makeService({ configureClient: (client) => (client.finalText = big) })
  const first = await service.flashTask({ task: 'one', cwd: root }, { jobId: 'job-a70m1c000' })
  const path = first.reportPath
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).report.length, big.length, 'the first record is whole')

  const stop = join(dirname(path), 'reader-stop')
  const reader = spawn(process.execPath, ['-e', READER_SOURCE, path, stop], { stdio: ['ignore', 'pipe', 'inherit'] })
  reader.stdout.setEncoding('utf8')
  let output = ''
  let ready
  const started = new Promise((resolve) => (ready = resolve))
  reader.stdout.on('data', (chunk) => {
    output += chunk
    if (output.includes('ready\n')) ready()
  })
  // A reader that dies before it is ready must fail the test, not hang it.
  reader.on('exit', () => ready())
  try {
    await started
    for (let index = 0; index < 24; index += 1) {
      const again = await service.flashTask({ task: `again ${String(index)}`, cwd: root }, { jobId: 'job-a70m1c000' })
      assert.equal(again.reportPath, path, 'every call writes the same record')
    }
  } finally {
    writeFileSync(stop, 'stop\n')
  }
  const code = await new Promise((resolve) => reader.on('exit', resolve))
  assert.equal(code, 0, `the reader failed: ${output}`)
  const read = JSON.parse(output.trim().split('\n').at(-1))
  assert.ok(read.reads > 0, `the reader read the record while it was written: ${output}`)
  assert.equal(read.partial, 0, `every read parsed as a whole record (${String(read.reads)} reads): ${output}`)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).report, big, 'the last record is whole')
  assert.deepEqual(
    readdirSync(dirname(path)).filter((name) => name.endsWith('.tmp')),
    [],
    'no temporary file is left behind',
  )
  await service.close()
})

test('a report key outside the report alphabet does not fail a call whose worker ran', async () => {
  const { root, clients, service } = makeService()
  const task = await service.flashTask({ task: 'work', cwd: root }, { jobId: '../escape' })
  assert.equal(task.status, 'ok', 'the worker ran, so the call is not a failure')
  assert.equal(task.reportPath, undefined, 'no path is named when no report was stored')
  assert.ok(
    task.warnings.some((line) => /is not a report key/.test(line)),
    JSON.stringify(task.warnings),
  )
  assert.equal(clients[0].prompts.length, 1)

  const batch = await service.flashBatch({ tasks: ['one', 'two'], cwd: root }, { jobId: 'bad key' })
  assert.equal(batch.status, 'ok')
  assert.equal(batch.reportPath, undefined)
  assert.ok(batch.warnings.some((line) => /is not a report key/.test(line)), JSON.stringify(batch.warnings))
  await service.close()
})

// ── 3. the timing breakdown ─────────────────────────────────────────────────

test('flash_task timing names each measured part and leaves out setup when there is none', async () => {
  const plain = makeService({ isolate: { mode: 'none', stateDir: tempDir('flash-runtime0112-time-plain-') } })
  const direct = await plain.service.flashTask({ task: 'read', cwd: plain.root, mode: 'read-only' })
  assertTiming(direct.timing, { copy: false })
  await plain.service.close()

  const repo = makeRepo()
  const isolated = makeService({
    root: repo,
    isolate: { slots: 1, stateDir: tempDir('flash-runtime0112-time-copy-') },
  })
  const copied = await isolated.service.flashTask({ task: 'change it', cwd: repo })
  assertTiming(copied.timing, { copy: true })

  const fleet = await isolated.service.flashBatch({ tasks: ['one', 'two'], cwd: repo })
  assertTiming(fleet.timing, { copy: true })
  await isolated.service.close()
})

test('setupMs is reported only when a setup step actually ran', async () => {
  const repo = makeSetupRepo()
  const { service } = makeService({
    root: repo,
    isolate: { slots: 1, stateDir: tempDir('flash-runtime0112-time-setup-'), allowSlotSetup: true },
  })

  const first = await service.flashTask({ task: 'build it', cwd: repo })
  assert.deepEqual(first.setup.map((step) => step.ran), [true], 'the first call runs the step')
  assert.equal(typeof first.timing.setupMs, 'number', 'a step that ran measured its time')
  assert.ok(first.timing.setupMs >= 0)

  // The same slot again: the stamp matches and the kept output is restored, so no step runs.
  const second = await service.flashTask({ task: 'build it again', cwd: repo })
  assert.deepEqual(second.setup.map((step) => step.ran), [false], 'the second call skips the step')
  assert.equal('setupMs' in second.timing, false, 'a skipped setup measured no time at all')
  await service.close()
})

test('a timed-out call whose copy was prepared carries the timing measured so far', async () => {
  const repo = makeRepo()
  const { service } = makeService({
    root: repo,
    isolate: { slots: 1, stateDir: tempDir('flash-runtime0112-time-timeout-') },
    taskTimeoutMs: 120,
    configureClient: (client) => {
      client.hold = true
    },
  })
  await assert.rejects(service.flashTask({ task: 'hang', cwd: repo }), (error) => {
    assert.equal(error.code, 'TIMEOUT')
    assertFailureTiming(error)
    return true
  })
  await service.close()
})

test('an idle call whose copy was prepared carries the timing measured so far', async () => {
  const repo = makeRepo()
  const { service } = makeService({
    root: repo,
    isolate: { slots: 1, stateDir: tempDir('flash-runtime0112-time-idle-') },
    idleTimeoutMs: 60,
    configureClient: (client) => {
      client.hold = true
    },
  })
  await assert.rejects(service.flashTask({ task: 'go silent', cwd: repo }), (error) => {
    assert.equal(error.code, 'IDLE')
    assertFailureTiming(error)
    return true
  })
  await service.close()
})

test('a runtime that exits during the call still carries the worker time it measured', async () => {
  const repo = makeRepo()
  const { service } = makeService({
    root: repo,
    isolate: { slots: 1, stateDir: tempDir('flash-runtime0112-time-exit-') },
    configureClient: (client) => {
      // The process dies while the session runs: the failure is the runtime's, not the worker's.
      client.exitOnPrompt = true
    },
  })
  await assert.rejects(service.flashTask({ task: 'work', cwd: repo }), (error) => {
    assert.equal(error.code, 'RUNTIME_EXITED')
    assertFailureTiming(error)
    return true
  })
  await service.close()
})

test('a failed call’s total time reaches the end of the call, the salvage included', async () => {
  const repo = makeRepo()
  const { service } = makeService({
    root: repo,
    isolate: { slots: 1, stateDir: tempDir('flash-runtime0112-time-salvage-') },
    taskTimeoutMs: 120,
    configureClient: (client) => {
      client.hold = true
    },
  })
  // Salvaging a large copy is not instant. Pause inside the collect the failure runs, so the
  // total can be compared with a duration the test knows: a total closed before the salvage
  // cannot reach the timeout and the pause together.
  const pool = service.isolation
  const collect = pool.collect.bind(pool)
  let salvagedMs = 0
  pool.collect = (slot, options) => {
    if (options?.retiring === true) {
      sleepSync(SALVAGE_PAUSE_MS)
      salvagedMs += SALVAGE_PAUSE_MS
    }
    return collect(slot, options)
  }
  await assert.rejects(service.flashTask({ task: 'hang', cwd: repo }), (error) => {
    assert.equal(error.code, 'TIMEOUT')
    assert.equal(salvagedMs, SALVAGE_PAUSE_MS, 'the failure ran the salvage')
    assert.ok(
      error.timing.totalMs >= 120 + SALVAGE_PAUSE_MS - 5,
      `the total must reach past the salvage, not stop before it (${String(error.timing.totalMs)}ms)`,
    )
    assert.ok(error.timing.totalMs >= error.timing.prepareMs + error.timing.workerMs, 'the parts still fit inside it')
    return true
  })
  await service.close()
})

test('the answer to a failed foreground call carries its timing as a structured part', async () => {
  const repo = makeRepo()
  const { service } = makeService({
    root: repo,
    isolate: { slots: 1, stateDir: tempDir('flash-runtime0112-answer-fail-') },
    taskTimeoutMs: 120,
    configureClient: (client) => {
      client.hold = true
    },
  })
  const call = createToolCaller({ service, jobs: new JobRegistry() })
  const answer = await call('flash_task', { task: 'hang', cwd: repo })
  assert.equal(answer.isError, true, 'a timed-out call is an error answer')
  assert.match(answer.content[0].text, /timed out|exceeded its/)
  const structured = answer.structuredContent
  assert.ok(structured !== undefined, 'the answer carries a structured part, not only text')
  assert.equal(typeof structured.timing?.workerMs, 'number', 'the failure’s timing reaches the caller')
  assert.ok(structured.timing.workerMs > 0, 'the worker ran, so its time is not zero')
  assert.ok(structured.timing.totalMs >= structured.timing.prepareMs)
  // The salvage the cancellation path ran reaches the caller the same way flash_cancel
  // reports it: nothing changed in the copy, and the answer says so rather than leaving the
  // caller to parse the sentence.
  assert.equal(structured.stored, false, 'nothing could be salvaged from an untouched copy')
  assert.match(structured.storedNote, /no change/)
  await service.close()
})

test('the answer to a failed background job carries its timing too', async () => {
  const repo = makeRepo()
  const { service } = makeService({
    root: repo,
    isolate: { slots: 1, stateDir: tempDir('flash-runtime0112-answer-job-') },
    taskTimeoutMs: 120,
    configureClient: (client) => {
      client.hold = true
    },
  })
  const call = createToolCaller({ service, jobs: new JobRegistry() })
  const started = payload(await call('flash_task', { task: 'hang', cwd: repo, background: true }))
  const answer = await call('flash_result', { jobId: started.jobId, waitSeconds: 10 })
  assert.equal(answer.isError, true, 'the failed job is an error answer')
  const structured = answer.structuredContent
  assert.ok(structured !== undefined, 'the failed-job answer carries a structured part')
  assert.equal(typeof structured.timing?.workerMs, 'number', 'the job’s failure carries its timing')
  assert.ok(structured.timing.workerMs > 0)
  assert.equal(structured.stored, false, 'and the salvage the job ran')
  await service.close()
})

// ── 4. the two new standing instructions ────────────────────────────────────

test('the worker instructions carry the linter rule and the other-layer rule', () => {
  const linter = "When you change a package, run the project's linter on every package you changed, not only the one the brief names."
  const otherLayer =
    'When the brief needs a piece outside its scope that is missing, say that it belongs in another layer and stop that part, instead of building around it.'
  const text = WORKER_INSTRUCTIONS.join('\n')
  assert.ok(text.includes(linter), text)
  assert.ok(text.includes(otherLayer), text)
  const prompt = buildChildPrompt({ cwd: '/w', task: 'work' })
  assert.ok(prompt.includes(linter), prompt)
  assert.ok(prompt.includes(otherLayer), prompt)
})
