/**
 * 0.1.10 service tests: unknown arguments are refused, the repeated-failure warning knows
 * "no match" from failure and a later success from a loop, a queued call says where it
 * stands, a runtime from before an install replaces itself when idle, and the worker reads
 * two more lines. Everything goes through the tool caller (or the MCP handler) the server
 * really runs; the runtime is faked, so nothing here needs Harness, a real home, a real
 * `DSH_HOME`, the real temp state base or the real data directory.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { FlashTaskService, WINDOWS_SHELL_INSTRUCTION, WORKER_INSTRUCTIONS } from '../lib/service.js'
import { createService, createToolCaller, listTools } from '../lib/index.js'
import { JobRegistry } from '../lib/jobs.js'
import { serveStdio } from '../lib/mcp.js'

/**
 * Pools without an explicit state directory store patches in the durable data directory;
 * point it at a throwaway one so no test can read, prune or write the real one.
 */
process.env.FLASH_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'flash-0110-data-')))

/**
 * A runtime stand-in that replays one canned child run per prompt (a trimmed copy of the
 * one in service.test.mjs). `toolEvents` entries may carry their own `arguments`, so a file
 * tool's `file_path` can be modelled, not only a shell `command`.
 */
class FakeSdkClient {
  constructor() {
    this.pid = 4242
    this.running = false
    this.starts = 0
    this.shutdowns = 0
    this.toolEvents = undefined
    this.delayMs = 0
    this.cwd = undefined
    this.prompts = []
    this.notificationHandlers = new Set()
    this.exitHandlers = new Set()
    this.diagnostics = ''
    this.writes = undefined
  }

  start() {
    this.starts += 1
    this.running = true
    return this.pid
  }

  async initialize(params) {
    this.cwd = params.cwd
    return { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' }
  }

  async prompt({ sessionId, text }) {
    this.prompts.push({ sessionId, text })
    const replay = () => this.#replay(sessionId)
    if (this.delayMs > 0) setTimeout(replay, this.delayMs)
    else queueMicrotask(replay)
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
    this.shutdowns += 1
    this.running = false
  }

  emit(method, params) {
    for (const handler of this.notificationHandlers) handler(method, params)
  }

  async #replay(sessionId) {
    const child = `child-${sessionId}`
    if (this.writes !== undefined && this.cwd !== undefined) writeFileSync(join(this.cwd, this.writes), 'written\n')
    this.emit('session.status', { sessionId, status: 'running' })
    this.emit('subagent.started', { parentSessionId: sessionId, childSessionId: child })
    this.emit('session.event', {
      sessionId: child,
      event: { type: 'request/header', data: { header: { config: { provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' } } } },
    })
    for (const [index, entry] of (this.toolEvents ?? []).entries()) {
      const id = `call-${String(index)}`
      this.emit('session.event', {
        sessionId: child,
        event: {
          type: 'tool/call',
          data: {
            turn: 1,
            step: 1,
            id,
            name: entry.name ?? 'bash',
            arguments: JSON.stringify(entry.arguments ?? { command: entry.command }),
          },
        },
      })
      if (entry.holdMs !== undefined) await new Promise((resolve) => setTimeout(resolve, entry.holdMs))
      this.emit('session.event', {
        sessionId: child,
        event: {
          type: 'tool/result',
          data: {
            turn: 1,
            step: 1,
            id,
            message: { content: [{ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text: entry.text ?? '' }] }] },
            ...(entry.error === undefined ? {} : { error: entry.error }),
          },
        },
      })
    }
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

/** A service rooted at a fresh temporary directory, running in place. */
function makeService(overrides = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flash-0110-')))
  const client = new FakeSdkClient()
  const service = new FlashTaskService({
    root,
    clientFactory: () => client,
    log: () => {},
    isolate: { mode: 'none' },
    honoursModelEnv: () => true,
    earlyRetryDelayMs: 0,
    env: { DSH_HOME: join(root, 'no-harness-home') },
    ...overrides,
  })
  return { root, client, service }
}

/** A git-backed root with a pool of `slots` disposable trees in a throwaway state directory. */
function makeIsolatedService({ slots = 1, ...overrides } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flash-0110-iso-')))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  writeFileSync(join(root, 'README.md'), '# project\n')
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: root })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-0110-iso-state-')))
  const client = new FakeSdkClient()
  client.writes = 'worker-output.txt'
  const service = new FlashTaskService({
    root,
    clientFactory: () => client,
    log: () => {},
    isolate: { slots, stateDir },
    honoursModelEnv: () => true,
    earlyRetryDelayMs: 0,
    env: { DSH_HOME: join(root, 'no-harness-home') },
    ...overrides,
  })
  const cleanup = async () => {
    await service.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  }
  return { root, client, service, cleanup }
}

/** A service built by the server's own factory, with a stamp reader the test controls. */
function makeDriftService({ log = () => {}, ...overrides } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flash-0110-drift-')))
  const client = new FakeSdkClient()
  const service = createService(
    {
      root,
      model: 'deepseek-v4.1-flash:cloud',
      env: { DSH_HOME: '/fake/harness' },
      isolate: 'none',
      clientFactory: () => client,
      honoursModelEnv: () => true,
      earlyRetryDelayMs: 0,
      checkProfileStamp: true,
      ...overrides,
    },
    log,
  )
  return { root, client, service }
}

/** A stamp reader that answers "stale" for the writing profile until `setCurrent()`. */
function switchableStampReader() {
  const stale = 'the worker profile is stale: run node install.mjs, then reconnect'
  const calls = []
  let current = false
  return {
    stale,
    calls,
    reader: (profile) => {
      calls.push(profile)
      return profile === 'flash-service' && !current ? stale : undefined
    },
    setCurrent: () => {
      current = true
    },
  }
}

/** Wait (briefly) for a condition a concurrent call will reach. */
async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${label}`)
}

/** The tool caller over a service, as the server wires it. */
function callerFor(service) {
  const jobs = new JobRegistry()
  return { jobs, call: createToolCaller({ service, jobs }) }
}

/** The text of a tool result. */
function textOf(result) {
  return result.content[0].text
}

// ── 1. unknown arguments ───────────────────────────────────────────────────

test('flash_patch with "file" is refused naming "files", and the patch is never read', async () => {
  let reads = 0
  const { call } = callerFor({ flashPatch: () => (reads += 1) })
  const result = await call('flash_patch', { patchId: 'flash-0123456789abcdef', file: 'lib/a.js' })
  assert.equal(result.isError, true)
  assert.equal(textOf(result), 'flash_patch failed: unknown argument "file" for flash_patch; did you mean "files"?')
  assert.equal(reads, 0, 'a refused call must not page through the whole patch')
})

test('a name nothing is close to is refused with the tool’s own argument list', async () => {
  const { call } = callerFor({ flashApply: () => ({}) })
  const result = await call('flash_apply', { patchId: 'flash-0123456789abcdef', banana: true, dryrun: true })
  assert.equal(
    textOf(result),
    'flash_apply failed: unknown arguments "banana", "dryrun" (did you mean "dryRun"?) for flash_apply; ' +
      'its arguments are patchId, files, dryRun, force, threeWay',
  )
})

test('a background call with an unknown argument is refused at once and starts no job', async () => {
  let ran = 0
  const service = { checkArguments: () => {}, flashTask: async () => (ran += 1) }
  const { call, jobs } = callerFor(service)
  const result = await call('flash_task', { taks: 'do it', cwd: '/w', background: true })
  assert.equal(result.isError, true)
  assert.equal(textOf(result), 'flash_task failed: unknown argument "taks" for flash_task; did you mean "task"?')
  assert.deepEqual(jobs.counts(), { running: 0, ended: 0 })
  assert.equal(ran, 0)
})

test('a fleet task entry is checked against the entry schema, and a per-task model keeps its own refusal', async () => {
  const { root, service } = makeService()
  const { call } = callerFor(service)
  try {
    const misspelt = await call('flash_batch', {
      tasks: ['first', { task: 'second', acceptence: 'tests pass' }],
      cwd: root,
      background: true,
    })
    assert.equal(
      textOf(misspelt),
      'flash_batch failed: unknown argument "acceptence" in tasks[1] of flash_batch; did you mean "acceptance"?',
    )
    const model = await call('flash_batch', { tasks: [{ task: 'x', model: 'other' }], cwd: root })
    assert.match(textOf(model), /tasks\[0\] carries "model"; the model is chosen per fleet/)
  } finally {
    await service.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('every name a schema declares is accepted, so the check cannot drift from tools/list', async () => {
  const echo = async () => ({ ok: true })
  const service = {
    checkArguments: () => {},
    flashTask: echo,
    flashBatch: echo,
    flashApply: echo,
    flashPatch: echo,
  }
  const { call } = callerFor(service)
  for (const tool of listTools()) {
    const args = Object.fromEntries(Object.keys(tool.inputSchema.properties).map((name) => [name, undefined]))
    if (tool.name === 'flash_batch') args.tasks = [{ task: 'a', taskFile: undefined, acceptance: 'b' }]
    const result = await call(tool.name, args)
    assert.doesNotMatch(textOf(result), /unknown argument/, `${tool.name} refused one of its own names`)
  }
})

test('MCP-level fields are not refused: params._meta, and a _meta inside the arguments', async () => {
  const pages = []
  const { call } = callerFor({ flashPatch: (args) => (pages.push(args), { page: 1 }) })
  const input = new PassThrough()
  const output = new PassThrough()
  output.setEncoding('utf8')
  const frames = []
  let buffer = ''
  output.on('data', (chunk) => {
    buffer += chunk
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim() !== '') frames.push(JSON.parse(line))
    }
  })
  const connection = serveStdio({
    serverInfo: { name: 'flash-mcp', version: 'test' },
    listTools: () => listTools(),
    callTool: call,
    input,
    output,
  })
  const send = (message) => input.write(`${JSON.stringify(message)}\n`)
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'flash_patch',
        arguments: { patchId: 'flash-0123456789abcdef', _meta: { client: 'x' } },
        _meta: { progressToken: 'tok-1' },
      },
    })
    await waitFor(() => frames.some((frame) => frame.id === 2), 'the tools/call answer')
    const answer = frames.find((frame) => frame.id === 2)
    assert.equal(answer.result.isError, undefined, JSON.stringify(answer))
    assert.deepEqual(answer.result.structuredContent, { page: 1 })
    assert.equal(pages.length, 1)
  } finally {
    connection.close()
  }
})

// ── 2. the repeated-failure warning ────────────────────────────────────────

test('exit status 1 of grep, rg, git grep, diff and cmp is an answer, not a failure', async () => {
  const { root, client, service } = makeService()
  const { call } = callerFor(service)
  const times = (command, text) => Array.from({ length: 3 }, () => ({ command, text }))
  client.toolEvents = [
    ...times('grep -rn missingName src', '[exit code: 1]'),
    ...times('cd lib && rg missingName', '[exit code: 1]'),
    ...times('git grep -n missingName', '[exit code: 1]'),
    ...times('diff -u a.txt b.txt', '[exit code: 1]'),
    ...times('cat log | cmp - expected.log', '[exit code: 1]'),
    // Status 2 is grep's own error, and still counts.
    ...times('grep -E "(" src', 'grep: Unmatched ( or \\(\n[exit code: 2]'),
  ]
  try {
    const result = (await call('flash_task', { task: 'look for a name', cwd: root })).structuredContent
    assert.equal(result.warnings.length, 1, JSON.stringify(result.warnings))
    assert.match(result.warnings[0], /^"grep -E" failed 3 times in this call \(last: exit code 2, /)
  } finally {
    await service.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a command that failed three times and then succeeded says so, and does not suggest cancelling', async () => {
  const { root, client, service } = makeService({ progressIntervalMs: 5 })
  const { call } = callerFor(service)
  client.toolEvents = [
    { command: 'cargo build', text: '[exit code: 101]' },
    { command: 'cd app && cargo build --release', text: '[exit code: 101]' },
    { command: 'cargo build', text: '[exit code: 101]' },
    { command: 'cargo build', text: 'Finished\n[exit code: 0]' },
    // Something still running, so flash_status can see the job while it lives.
    { command: 'sleep 1', text: '[exit code: 0]', holdMs: 400 },
  ]
  try {
    const started = (await call('flash_task', { task: 'build it', cwd: root, background: true })).structuredContent
    const expected = /^"cargo build" failed 3 times in this call \(last: exit code 101, \d+m?\d*s ago\); a later run succeeded \d+m?\d*s ago$/
    await waitFor(async () => {
      const status = (await call('flash_status', { jobId: started.jobId })).structuredContent
      return status.state === 'running' && (status.warnings ?? []).some((line) => expected.test(line))
    }, 'flash_status to report the later success')
    const final = (await call('flash_result', { jobId: started.jobId, waitSeconds: 10 })).structuredContent
    assert.equal(final.warnings.length, 1, JSON.stringify(final.warnings))
    assert.match(final.warnings[0], expected)
    assert.doesNotMatch(final.warnings[0], /cancel/)
  } finally {
    await service.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failure after the later success is warned about as before', async () => {
  const { root, client, service } = makeService()
  const { call } = callerFor(service)
  client.toolEvents = [
    { command: 'npm test', text: '[exit code: 1]' },
    { command: 'npm test', text: '[exit code: 1]' },
    { command: 'npm test', text: '[exit code: 0]' },
    { command: 'npm test', text: '[exit code: 1]' },
  ]
  try {
    const result = (await call('flash_task', { task: 'test it', cwd: root })).structuredContent
    assert.match(result.warnings[0], /^"npm test" failed 3 times in this call \(last: exit code 1, .*check its report or cancel the call$/)
  } finally {
    await service.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('an edit that failed three times and was then written succeeds as an edit of that file', async () => {
  const { root, client, service } = makeService()
  const { call } = callerFor(service)
  const failedEdit = (oldText) => ({
    name: 'edit',
    arguments: { file_path: 'src/a.js', old_string: oldText, new_string: 'y' },
    text: 'cannot edit "src/a.js": old_string not found',
    error: { name: 'FsError', code: 'FS_EDIT_NO_MATCH' },
  })
  client.toolEvents = [
    // Three different edits of one file: one stuck step, so one key, whatever their text.
    failedEdit('const a = 1'),
    failedEdit('const  a = 1'),
    failedEdit('let a = 1'),
    { name: 'write', arguments: { file_path: 'src/a.js', content: 'const a = 2\n' }, text: 'wrote src/a.js' },
  ]
  try {
    const result = (await call('flash_task', { task: 'change a', cwd: root })).structuredContent
    assert.equal(result.warnings.length, 1, JSON.stringify(result.warnings))
    assert.match(
      result.warnings[0],
      /^"edit src\/a\.js" failed 3 times in this call \(last: tool error FsError, \d+m?\d*s ago\); a later edit of src\/a\.js succeeded \d+m?\d*s ago$/,
    )
  } finally {
    await service.close()
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 3. where a queued call stands ──────────────────────────────────────────

test('a queued job names its place in line, the order rule, and the job holding the tree', async () => {
  const { root, client, service, cleanup } = makeIsolatedService({ slots: 1, progressIntervalMs: 5 })
  const { call } = callerFor(service)
  client.delayMs = 500
  try {
    const holder = (await call('flash_task', { task: 'hold the only tree', cwd: root, background: true })).structuredContent
    await waitFor(() => service.isolation.inUse === 1, 'the first job to take the tree')
    const second = (await call('flash_task', { task: 'second in line', cwd: root, background: true })).structuredContent
    const third = (await call('flash_task', { task: 'third in line', cwd: root, background: true })).structuredContent

    let status
    await waitFor(async () => {
      status = (await call('flash_status', { jobId: third.jobId })).structuredContent
      return status.queue !== undefined && status.queue.of === 2
    }, 'the third job to report its queue')
    assert.equal(status.queue.position, 2)
    assert.equal(status.queue.holders.length, 1)
    assert.equal(status.queue.holders[0].jobId, holder.jobId)
    assert.equal(status.queue.holders[0].label, 'hold the only tree')
    assert.equal(typeof status.queue.holders[0].runningMs, 'number')
    assert.match(
      status.lastProgress.message,
      new RegExp(
        `queued \\d+m?\\d*s: 2nd in line for a free tree \\(first come, first served\\); ` +
          `tree held by ${holder.jobId} \\(hold the only tree, \\d+m?\\d*s\\)`,
      ),
    )
    const secondStatus = (await call('flash_status', { jobId: second.jobId })).structuredContent
    assert.equal(secondStatus.queue.position, 1)

    // First come, first served: the second job gets the tree before the third.
    const ended = []
    await Promise.all(
      [second, third].map(async (job) => {
        await call('flash_result', { jobId: job.jobId, waitSeconds: 20 })
        ended.push(job.jobId)
      }),
    )
    assert.deepEqual(ended, [second.jobId, third.jobId])
    const done = (await call('flash_status', { jobId: third.jobId })).structuredContent
    assert.equal(done.queue, undefined, 'an ended job carries no queue')
  } finally {
    await cleanup()
  }
})

test('a foreground holder has no job and is named by its label', async () => {
  const { root, client, service, cleanup } = makeIsolatedService({ slots: 1, progressIntervalMs: 5 })
  const { call } = callerFor(service)
  client.delayMs = 300
  try {
    const holding = call('flash_task', { task: 'review the parser', cwd: root })
    await waitFor(() => service.isolation.inUse === 1, 'the foreground call to take the tree')
    const queued = (await call('flash_task', { task: 'next', cwd: root, background: true })).structuredContent
    let status
    await waitFor(async () => {
      status = (await call('flash_status', { jobId: queued.jobId })).structuredContent
      return status.queue !== undefined
    }, 'the queued job to report its queue')
    assert.deepEqual(Object.keys(status.queue.holders[0]).sort(), ['label', 'runningMs'])
    assert.equal(status.queue.holders[0].label, 'review the parser')
    assert.match(status.lastProgress.message, /1st in line for a free tree \(first come, first served\); tree held by a foreground call \(review the parser, \d+m?\d*s\)/)
    await holding
    await call('flash_result', { jobId: queued.jobId, waitSeconds: 20 })
  } finally {
    await cleanup()
  }
})

// ── 4. a runtime from before the install ───────────────────────────────────

test('an idle runtime from before the install is replaced by the next call', async () => {
  const stamps = switchableStampReader()
  const logs = []
  const { root, client, service } = makeDriftService({ profileStampReader: stamps.reader, log: (line) => logs.push(line) })
  const { call } = callerFor(service)
  try {
    const stale = (await call('flash_task', { task: 'read the README', cwd: root })).structuredContent
    assert.ok(stale.warnings.includes(stamps.stale), JSON.stringify(stale.warnings))
    assert.equal(client.starts, 1)

    stamps.setCurrent()
    const fresh = (await call('flash_task', { task: 'read the README', cwd: root })).structuredContent
    assert.equal(fresh.warnings, undefined, JSON.stringify(fresh.warnings))
    assert.ok(logs.includes('the flash-service runtime was started before the install; replacing it'), JSON.stringify(logs))
    assert.equal(client.shutdowns, 1, 'the old runtime is shut down')
    assert.equal(client.starts, 2, 'a fresh runtime serves the call')

    // A current runtime is not asked again: nothing about it can go stale.
    const asked = stamps.calls.length
    await call('flash_task', { task: 'read the README', cwd: root })
    assert.equal(stamps.calls.length, asked)
    assert.equal(client.starts, 2)
  } finally {
    await service.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a busy runtime from before the install keeps serving, says it will be replaced, and is replaced once idle', async () => {
  const stamps = switchableStampReader()
  const logs = []
  const { root, client, service } = makeDriftService({ profileStampReader: stamps.reader, log: (line) => logs.push(line) })
  const { call } = callerFor(service)
  try {
    await call('flash_task', { task: 'boot the runtime', cwd: root })
    client.delayMs = 200
    const running = call('flash_task', { task: 'a long call', cwd: root })
    await waitFor(() => client.prompts.length === 2, 'the long call to be prompted')

    stamps.setCurrent()
    const beside = (await call('flash_task', { task: 'a call beside it', cwd: root })).structuredContent
    const suffix = '; this runtime was started before the install, and it will be replaced once its running calls end'
    assert.ok(beside.warnings.includes(`${stamps.stale}${suffix}`), JSON.stringify(beside.warnings))
    assert.equal(client.starts, 1, 'a busy runtime is not killed under its calls')
    await running
    assert.equal(
      logs.filter((line) => line === 'the flash-service runtime was started before the install; it will be replaced once its running calls end').length,
      1,
    )

    client.delayMs = 0
    const after = (await call('flash_task', { task: 'after they ended', cwd: root })).structuredContent
    assert.equal(after.warnings, undefined, JSON.stringify(after.warnings))
    assert.equal(client.starts, 2)
    assert.ok(logs.includes('the flash-service runtime was started before the install; replacing it'))
  } finally {
    await service.close()
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 5. worker guidance ─────────────────────────────────────────────────────

test('every worker is asked to list the rules its change crossed under their own heading', async () => {
  assert.equal(
    WORKER_INSTRUCTIONS.at(-1),
    'If a change touches code beside a stated rule (an "only", a "never", a "one place", a design note the task quotes), list it in the report under its own heading "Rules crossed", with the reason.',
  )
  const { root, client, service } = makeService()
  const { call } = callerFor(service)
  try {
    await call('flash_task', { task: 'x', cwd: root })
    assert.ok(client.prompts[0].text.includes('under its own heading "Rules crossed"'))
    assert.ok(!client.prompts[0].text.includes('PowerShell'), 'only a Windows worker reads the shell line')
  } finally {
    await service.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a Windows worker is told its commands run in PowerShell', async () => {
  assert.equal(
    WINDOWS_SHELL_INSTRUCTION,
    'Commands run in PowerShell here, not bash (PowerShell 7 when it is installed, otherwise Windows PowerShell 5.1): bash syntax does not work, `&&` works only in PowerShell 7, and a program in the current folder needs `.\\` in front of it.',
  )
  const { root, client, service } = makeService({ platform: 'win32' })
  const { call } = callerFor(service)
  try {
    await call('flash_task', { task: 'x', cwd: root })
    const text = client.prompts[0].text
    // Right after the standing instructions, before the task.
    assert.ok(text.includes(`${WORKER_INSTRUCTIONS.at(-1)}\n${WINDOWS_SHELL_INSTRUCTION}\n`), text)
  } finally {
    await service.close()
    rmSync(root, { recursive: true, force: true })
  }
})
