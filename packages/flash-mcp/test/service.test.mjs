/**
 * Service tests: one fresh session per call, a compact result, and a hard fence
 * around the workspace. The runtime is faked, so nothing here needs Harness.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import {
  BATCH_SCRIPT,
  FlashTaskService,
  FlashTaskError,
  WORKER_INSTRUCTIONS,
  WORKER_RULES,
  buildBatchPrompt,
  buildChildPrompt,
  buildOrchestrationPrompt,
  describeActivity,
  extractWorkflowValue,
  looksLikeWorkflowResult,
  normalizeTasks,
  parseWorkflowHeader,
  toolResultText,
} from '../lib/service.js'

/** Read the fleet payload back out of the dispatch prompt. */
function promptArgs(text) {
  const start = text.indexOf('<args>\n')
  const end = text.indexOf('\n</args>')
  assert.ok(start >= 0 && end > start, 'the dispatch prompt must carry an args block')
  return JSON.parse(text.slice(start + '<args>\n'.length, end))
}

/** A runtime stand-in that replays one canned child run per prompt. */
class FakeSdkClient {
  constructor({ script } = {}) {
    this.script = script ?? defaultScript
    this.pid = 4242
    this.running = false
    this.starts = 0
    this.initializes = []
    /** Every cwd a runtime was booted with, and every shutdown it received. */
    this.shutdowns = 0
    this.shutdownCwds = []
    /** When set, the "worker" writes this file into whatever tree it was given. */
    this.writes = undefined
    /** When set, the canned replay runs after this many milliseconds instead of a microtask. */
    this.delayMs = 0
    this.cwd = undefined
    this.prompts = []
    this.notificationHandlers = new Set()
    this.exitHandlers = new Set()
    this.diagnostics = ''
    /** The model this runtime reports on its children's request headers (tests). */
    this.routeModel = 'deepseek-v4.1-flash:cloud'
    /** Errors `initialize` rejects with, consumed one per call (tests). */
    this.initializeFailures = []
    /** When set, `initialize` waits this long before answering or failing (tests). */
    this.initializeDelayMs = 0
    /** When set, `shutdown` waits for this deferred before finishing (tests). */
    this.shutdownGate = undefined
  }

  start() {
    this.starts += 1
    this.running = true
    return this.pid
  }

  async initialize(params) {
    this.initializes.push(params)
    this.cwd = params.cwd
    if (this.initializeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.initializeDelayMs))
    }
    if (this.initializeFailures.length > 0) throw this.initializeFailures.shift()
    return { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' }
  }

  /** The environment a runtime was booted with, when the factory passed one on. */
  recordEnv(extraEnv) {
    this.extraEnv = extraEnv
  }

  async prompt({ sessionId, text }) {
    this.prompts.push({ sessionId, text })
    const replay = () => this.#replay(sessionId, text)
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
    this.shutdownCwds.push(this.cwd)
    // A test that models a slow shutdown parks here until it releases the gate.
    if (this.shutdownGate !== undefined) await this.shutdownGate.promise
    this.running = false
  }

  emit(method, params) {
    for (const handler of this.notificationHandlers) handler(method, params)
  }

  #replay(sessionId, text) {
    const script = this.script
    const childSessionId = `child-${sessionId}`
    if (this.writes !== undefined && this.cwd !== undefined) {
      writeFileSync(join(this.cwd, this.writes), 'written by the worker\n')
    }
    if (script === 'no-delegation') {
      this.emit('session.status', { sessionId, status: 'running' })
      this.emit('session.event', {
        sessionId,
        event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'I cannot do that.' }] } } },
      })
      this.emit('session.status', { sessionId, status: 'idle' })
      return
    }
    if (script === 'silent') return
    if (typeof script === 'string' && script.startsWith('batch')) {
      this.emit('session.status', { sessionId, status: 'running' })
      if (script === 'batch-no-fleet') {
        this.emit('session.status', { sessionId, status: 'idle' })
        return
      }
      const items = promptArgs(text).items
      const childId = (index) => `child-${sessionId}-${String(index)}`
      const finish = (index) =>
        this.emit('subagent.finished', {
          provider: 'flash',
          agentId: `agent-${String(index)}`,
          parentSessionId: sessionId,
          childSessionId: childId(index),
          status: script === 'batch-partial' && index === 1 ? 'error' : 'ok',
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: `worker ${String(index)}` }],
        })
      if (script === 'batch-sequential') {
        // One worker at a time: the fleet fanned out, but never in parallel.
        for (const [index] of items.entries()) {
          this.emit('subagent.started', { parentSessionId: sessionId, childSessionId: childId(index) })
          finish(index)
        }
        const entries2 = items.map((item, index) => ({ index, ok: true, result: `fleet result ${String(index)}` }))
        this.emit('session.event', {
          sessionId,
          event: {
            type: 'tool/result',
            data: {
              turn: 1,
              step: 1,
              message: {
                content: [
                  {
                    type: 'text',
                    text: `workflow "flash-batch" completed (${String(items.length)} agents).\nReturn value:\n${JSON.stringify(entries2)}`,
                  },
                ],
              },
            },
          },
        })
        this.emit('session.status', { sessionId, status: 'idle' })
        return
      }
      // Every member starts before any member finishes: a real fan-out.
      for (const [index] of items.entries()) {
        this.emit('subagent.started', { parentSessionId: sessionId, childSessionId: childId(index) })
        this.emit('session.event', {
          sessionId: childId(index),
          event: {
            type: 'request/header',
            data: { header: { config: { provider: 'ollama', model: this.routeModel } } },
          },
        })
      }
      for (const [index] of items.entries()) finish(index)
      if (script === 'batch-denied') {
        // Three shapes a member can hit: a guard refusal carrying a code, a
        // sandbox refusal carrying only a message, and an ordinary tool failure.
        const refused = (index, data) =>
          this.emit('session.event', {
            sessionId: childId(index),
            event: { type: 'tool/result', data: { turn: 1, step: 1, message: { content: [] }, ...data } },
          })
        const text = (value) => ({
          message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: value }] }] },
        })
        // The guard's reason is in its own message; the sandbox denial has only
        // a message; an ordinary tool failure has neither.
        refused(0, {
          ...text('Error: flash-guard denied write (PROTECTED_STATE): .git holds repository state'),
          error: { name: 'FlashGuardDeniedError', code: 'FLASH_GUARD_DENIED' },
        })
        refused(0, { ...text('Error: bash: /Users/tester/escape.txt: Operation not permitted') })
        refused(1, { ...text('Error: the command exited with code 1') })
      }
      // The engine reports each member under the label this service generated.
      if (script !== 'batch-unreadable-nolabels') {
        for (const [index] of items.entries()) {
          this.emit('session.event', {
            sessionId,
            event: { type: 'tool-workflow/agent-start', data: { runId: 'run-1', seq: index + 1, label: `task-${String(index + 1)}`, childId: childId(index) } },
          })
        }
        for (const [index] of items.entries()) {
          this.emit('session.event', {
            sessionId,
            event: {
              type: 'tool-workflow/agent-end',
              data: { runId: 'run-1', seq: index + 1, outcome: script === 'batch-partial' && index === 1 ? 'error' : 'completed' },
            },
          })
        }
      }
      this.emit('session.event', { sessionId, event: { type: 'tool-workflow/run-start', data: { runId: 'run-1', name: 'flash-batch' } } })
      this.emit('session.event', { sessionId, event: { type: 'tool-workflow/run-end', data: { runId: 'run-1', stopReason: 'completed' } } })
      const entries = items.map((item, index) => ({
        index,
        ok: !(script === 'batch-partial' && index === 1),
        // `batch-empty` is a member the engine reports as ok with nothing to say.
        result:
          script === 'batch-empty' && index === 1
            ? ''
            : `fleet result ${String(index)} from ${String(item.label)}`,
      }))
      const text2 = script.startsWith('batch-unreadable')
        ? 'workflow "flash-batch" completed (3 agents).\nthe renderer was truncated before the value'
        : `workflow "flash-batch" completed (${String(items.length)} agents).\nReturn value:\n${JSON.stringify(entries)}`
      // Harness nests a tool result's payload inside a `tool-result` block.
      this.emit('session.event', {
        sessionId,
        event: {
          type: 'tool/result',
          data: {
            turn: 1,
            step: 1,
            message: {
              source: { kind: 'tool', callId: 'call-1' },
              content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: text2 }] }],
            },
          },
        },
      })
      this.emit('session.status', { sessionId, status: 'idle' })
      return
    }
    if (script === 'runtime-exit') {
      this.emit('session.status', { sessionId, status: 'running' })
      for (const handler of this.exitHandlers) handler({ code: 1, signal: null })
      return
    }
    // Harness reports one stable child session id from `started` through `finished`.
    const count = script === 'two-children' ? 2 : 1
    const childId = (index) => (count === 1 ? `child-${sessionId}` : `child-${sessionId}-${String(index)}`)
    this.emit('session.status', { sessionId, status: 'running' })
    for (let index = 0; index < count; index += 1) {
      this.emit('subagent.started', { parentSessionId: sessionId, childSessionId: childId(index) })
      this.emit('session.event', {
        sessionId: childId(index),
        event: {
          type: 'request/header',
          data: { header: { config: { provider: 'ollama', model: this.routeModel } } },
        },
      })
    }
    // Another session's route must never leak into this call's result.
    this.emit('session.event', {
      sessionId: 'someone-elses-session',
      event: { type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'other' } } } },
    })
    for (let index = 0; index < count; index += 1) {
      this.emit('subagent.finished', {
        provider: 'flash',
        agentId: `agent-${String(index)}`,
        parentSessionId: sessionId,
        childSessionId: childId(index),
        status: script === 'child-error' ? 'error' : 'ok',
        stopReason: 'completed',
        // `empty-result` is the shape the caller reported: "ok"/"completed", no message.
        lastAssistantMessage:
          script === 'empty-result' ? [] : [{ type: 'text', text: `worker result ${String(index)}\n${text.slice(0, 10)}` }],
      })
    }
    this.emit('session.status', { sessionId, status: 'idle' })
  }
}

function defaultScript() {
  return 'ok'
}

/** The error `HarnessSdkClient` rejects with when the handshake misses its deadline. */
function initializeTimeout(timeoutMs) {
  const error = new Error(`dsh protocol request "initialize" timed out after ${String(timeoutMs)}ms`)
  error.code = 'TIMEOUT'
  return error
}

/** A promise the test resolves itself, to hold one runtime's shutdown open. */
function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

/** Wait (briefly) for a condition a concurrent call will reach. */
async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${label}`)
}

/** A service rooted at a fresh temporary directory. */
function makeService({ script, ...overrides } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flash-mcp-test-'))
  const client = new FakeSdkClient({ script })
  const service = new FlashTaskService({
    root,
    clientFactory: (profileName, cwd, extraEnv) => {
      client.recordEnv(extraEnv)
      return client
    },
    log: () => {},
    // These tests pin the contract of a call that runs in the root itself. What a
    // call does when it is isolated is exercised in its own block below.
    isolate: { mode: 'none' },
    // The installed profile is never read from this machine's home: the tests that
    // choose another model decide what the fake profile reports.
    honoursModelEnv: () => true,
    ...overrides,
  })
  return { root, client, service }
}

/** A git-backed root, and a worker that writes one file into whatever tree it gets. */
function makeIsolatedService({ slots = 2, file = 'worker-output.txt', script, ...overrides } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flash-mcp-iso-')))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  writeFileSync(join(root, 'README.md'), '# project\n')
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: root })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-mcp-iso-state-')))
  const client = new FakeSdkClient({ script })
  client.writes = file
  const service = new FlashTaskService({
    root,
    clientFactory: (profileName, cwd, extraEnv) => {
      client.recordEnv(extraEnv)
      return client
    },
    log: () => {},
    isolate: { slots, stateDir },
    honoursModelEnv: () => true,
    ...overrides,
  })
  return { root, client, service, stateDir }
}

/**
 * A service whose factory returns a fresh fake per runtime, so more than one model can be
 * observed at once. Each client reports the model it was booted for, unless the test pins
 * another one to model a worker that ran elsewhere.
 */
function makeModelService({ script, routeModel, models, ...overrides } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flash-mcp-model-')))
  const clients = []
  const logs = []
  const service = new FlashTaskService({
    root,
    models,
    clientFactory: (profileName, cwd, extraEnv) => {
      const resolved = typeof script === 'function' ? script(extraEnv?.FLASH_ROUTE_MODEL) : script
      const client = new FakeSdkClient({ script: resolved })
      client.routeModel = routeModel ?? extraEnv?.FLASH_ROUTE_MODEL ?? 'deepseek-v4.1-flash:cloud'
      client.recordEnv(extraEnv)
      clients.push(client)
      return client
    },
    log: (line) => logs.push(line),
    isolate: { mode: 'none' },
    honoursModelEnv: () => true,
    ...overrides,
  })
  return { root, clients, logs, service }
}

test('runs one task through one child and returns a compact result', async () => {
  const { root, client, service } = makeService()
  const result = await service.flashTask({ task: 'read the README', cwd: root, acceptance: 'summarize section 2' })

  assert.equal(result.status, 'ok')
  assert.equal(result.stopReason, 'completed')
  assert.equal(result.provider, 'flash')
  assert.deepEqual(result.route, { provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' })
  assert.equal(result.childSessionId, `child-${result.sessionId}`)
  assert.match(result.result, /^worker result 0/)
  assert.equal(result.resultTruncated, false)
  assert.equal(typeof result.durationMs, 'number')
  assert.equal(result.runtime.pid, 4242)
  assert.equal(result.runtime.sessions, 1)
  assert.equal(result.children, undefined)
  assert.equal(result.warnings, undefined)

  // The dispatch prompt names exactly one tool and carries the task text.
  assert.equal(client.prompts.length, 1)
  assert.match(client.prompts[0].text, /Call the `flash` tool exactly once/)
  assert.match(client.prompts[0].text, /Do not call `flash` a second time/)
  assert.match(client.prompts[0].text, new RegExp(`Working directory: ${service.root}`))
  assert.match(client.prompts[0].text, /read the README/)
  assert.match(client.prompts[0].text, /Acceptance criteria:\nsummarize section 2/)
  // No transcript, no unrelated session's route.
  assert.deepEqual(Object.keys(result).sort(), [
    'childSessionId',
    'durationMs',
    'instructions',
    'isolation',
    'mode',
    'provider',
    'queuedMs',
    'result',
    'resultTruncated',
    'route',
    'runtime',
    'sessionId',
    'status',
    'stopReason',
  ])
  // A call that never waited for a tree says so, and its run time is the session's own.
  assert.equal(result.queuedMs, 0)
})

/** An empty harness home, so the machine's real `~/.dsh/AGENTS.md` cannot reach a result. */
function emptyDshHome() {
  return mkdtempSync(join(tmpdir(), 'flash-mcp-dsh-'))
}

test('a result carries the instruction files its worker was given', async () => {
  const { service } = makeService({ env: { DSH_HOME: emptyDshHome() } })
  // The project root is the nearest `.git`, so the root's file reaches a nested worker.
  mkdirSync(join(service.root, '.git'))
  writeFileSync(join(service.root, 'AGENTS.md'), 'project rules\n')
  mkdirSync(join(service.root, 'packages'))
  writeFileSync(join(service.root, 'packages', 'CLAUDE.md'), 'package rules\n')

  const result = await service.flashTask({ task: 'work', cwd: join(service.root, 'packages') })
  assert.deepEqual(
    result.instructions.files.map((file) => file.path),
    ['AGENTS.md', 'packages/CLAUDE.md'],
  )
  assert.equal(result.instructions.bytes, Buffer.byteLength('project rules\n') + Buffer.byteLength('package rules\n'))
  assert.equal(result.instructions.overBudget, false)
  assert.equal(result.instructions.approxTokens, Math.ceil(result.instructions.bytes / 4))
})

test('a batch result carries the instruction files too', async () => {
  const { service } = makeService({ script: 'batch', env: { DSH_HOME: emptyDshHome() } })
  mkdirSync(join(service.root, '.git'))
  writeFileSync(join(service.root, 'AGENTS.md'), 'project rules\n')

  const result = await service.flashBatch({ tasks: ['one'], cwd: service.root })
  assert.deepEqual(
    result.instructions.files.map((file) => file.path),
    ['AGENTS.md'],
  )
  assert.equal(result.instructions.overBudget, false)
})

test('an instruction set over the harness budget is warned about', async () => {
  const { service } = makeService({ env: { DSH_HOME: emptyDshHome() } })
  mkdirSync(join(service.root, '.git'))
  writeFileSync(join(service.root, 'AGENTS.md'), 'x'.repeat(70_000))

  const result = await service.flashTask({ task: 'work', cwd: service.root })
  assert.equal(result.instructions.overBudget, true)
  assert.equal(result.instructions.bytes, 70_000)
  // 70,000 bytes is 68.4 KB, rounded up so the number always reads as over 64.
  assert.deepEqual(result.warnings, [
    "the project instruction files are 69 KB, over the harness's 64 KB budget; workers see only part of them (the most specific files first)",
  ])
})

test('a writing call measures the copy, because that is the tree the worker sees', async () => {
  const { service } = makeIsolatedService({ env: { DSH_HOME: emptyDshHome() } })
  // Uncommitted, so it is in the caller's tree and absent from a `head` copy.
  writeFileSync(join(service.root, 'AGENTS.md'), 'uncommitted rules\n')

  const fromHead = await service.flashTask({ task: 'work', cwd: service.root, source: 'head' })
  assert.deepEqual(fromHead.instructions.files, [])

  const fromWorkingTree = await service.flashTask({ task: 'work', cwd: service.root })
  assert.deepEqual(
    fromWorkingTree.instructions.files.map((file) => file.path),
    ['AGENTS.md'],
  )
})


test('the instruction files are measured before the worker runs, not after', async () => {
  // The "worker" writes an AGENTS.md into its copy. It was never given one, and the result
  // must say so rather than report the file it wrote as the project's instructions.
  const { service } = makeIsolatedService({ file: 'AGENTS.md', env: { DSH_HOME: emptyDshHome() } })
  const result = await service.flashTask({ task: 'write AGENTS.md', cwd: service.root })
  assert.deepEqual(result.change.filesChanged, ['AGENTS.md'])
  assert.deepEqual(result.instructions.files, [])
})


test('a result names an ignored file the worker rewrote, and warns that the patch cannot carry it', async () => {
  const { root, service } = makeIsolatedService({ file: 'generated.d.ts' })
  writeFileSync(join(root, '.gitignore'), 'generated.d.ts\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'ignore'], { cwd: root })
  // Shorter than what the fake worker writes, so the rewrite differs in size as well as mtime.
  writeFileSync(join(root, 'generated.d.ts'), 'old\n')

  const result = await service.flashTask({ task: 'regenerate the worker types', cwd: root })

  assert.deepEqual(result.change.ignoredChanged, [{ path: 'generated.d.ts', change: 'modified' }])
  // The path existed before the copy, so it is not a created path, and it is not in the patch.
  assert.equal(result.change.ignored, undefined)
  assert.deepEqual(result.change.filesChanged, [])
  assert.match(
    result.warnings.join('\n'),
    /the worker changed 1 git-ignored file\(s\) that the patch cannot carry: generated\.d\.ts; regenerate or copy them after applying/,
  )
  await service.close()
})

test('boots the runtime lazily and reuses it across calls', async () => {
  const { root, client, service } = makeService()
  assert.equal(client.starts, 0)
  await service.flashTask({ task: 'one', cwd: root })
  await service.flashTask({ task: 'two', cwd: root })
  assert.equal(client.starts, 1)
  assert.equal(client.initializes.length, 1)
  assert.deepEqual(client.initializes[0], {
    // The root is resolved through realpath(), which on macOS rewrites /var to /private/var.
    cwd: service.root,
    provider: 'ollama',
    model: 'deepseek-v4.1-flash:cloud',
  })
  assert.equal(client.prompts.length, 2)
  assert.notEqual(client.prompts[0].sessionId, client.prompts[1].sessionId)
})

// ── model choice: one dsh process per model, and a bound on how many ─────────

const DEFAULT_TEST_MODEL = 'deepseek-v4.1-flash:cloud'
const OTHER_TEST_MODEL = 'minimax-m3.1-flash:cloud'
const THIRD_TEST_MODEL = 'third-model:cloud'
const FOURTH_TEST_MODEL = 'fourth-model:cloud'

test('every runtime boots with FLASH_ROUTE_MODEL and initializes on the same model', async () => {
  const { root, clients, service } = makeModelService({ models: [DEFAULT_TEST_MODEL, OTHER_TEST_MODEL] })

  const first = await service.flashTask({ task: 'one', cwd: root })
  // The default is in the environment too: the profile always picks its model from it.
  assert.deepEqual(clients[0].extraEnv, { FLASH_ROUTE_MODEL: DEFAULT_TEST_MODEL })
  assert.equal(clients[0].initializes[0].model, DEFAULT_TEST_MODEL)
  assert.equal(first.status, 'ok')

  const second = await service.flashTask({ task: 'two', cwd: root, model: OTHER_TEST_MODEL })
  assert.deepEqual(clients[1].extraEnv, { FLASH_ROUTE_MODEL: OTHER_TEST_MODEL })
  assert.equal(clients[1].initializes[0].model, OTHER_TEST_MODEL)
  assert.equal(second.status, 'ok')
  // Two models are two dsh processes: the model is fixed for the life of one process.
  assert.equal(clients.length, 2)
  await service.close()
})

test('two calls on one model share its runtime; another model gets one of its own', async () => {
  const { root, clients, service } = makeModelService({ models: [DEFAULT_TEST_MODEL, OTHER_TEST_MODEL] })
  await service.flashTask({ task: 'one', cwd: root })
  await service.flashTask({ task: 'two', cwd: root })
  assert.equal(clients.length, 1, 'the same model reuses one runtime')
  assert.equal(clients[0].initializes.length, 1)
  assert.equal(clients[0].starts, 1)

  await service.flashTask({ task: 'three', cwd: root, model: OTHER_TEST_MODEL })
  assert.equal(clients.length, 2)
  assert.equal(clients[1].initializes[0].model, OTHER_TEST_MODEL)
  await service.close()
})

test('another model on the same tree retires the idle runtime, and spares another tree', async () => {
  const { root, clients, logs, service } = makeModelService({ models: [DEFAULT_TEST_MODEL, OTHER_TEST_MODEL] })
  mkdirSync(join(root, 'nested'))
  await service.flashTask({ task: 'one', cwd: root })
  await service.flashTask({ task: 'two', cwd: join(root, 'nested') })
  assert.equal(clients.length, 2, 'two trees, two runtimes')

  await service.flashTask({ task: 'three', cwd: root, model: OTHER_TEST_MODEL })

  // The root's default runtime had no session in flight, so the new model took the tree:
  // one process per tree rather than one per model the tree ever served.
  assert.equal(clients[0].shutdowns, 1)
  assert.equal(clients[1].shutdowns, 0, 'a runtime on another cwd is untouched')
  assert.equal(service.runtimes.size, 2)
  assert.ok(
    logs.some((line) => new RegExp(`shut down the ${DEFAULT_TEST_MODEL} runtime on flash-service in .*: ${OTHER_TEST_MODEL} now serves that tree`).test(line)),
    `expected one shutdown line, saw:\n${logs.join('\n')}`,
  )
  await service.close()
})

test('a fresh runtime under a key survives a stale retirement walk', async () => {
  const { root, clients, service } = makeModelService({
    models: [DEFAULT_TEST_MODEL, OTHER_TEST_MODEL, THIRD_TEST_MODEL, FOURTH_TEST_MODEL],
  })
  const keyFor = (model) => `${service.profile}@${root}@${model}`
  // Two idle runtimes on the one tree, as if two models had been booted while the other
  // was busy. Seeding them is what makes the stale snapshot contain both.
  const first = new FakeSdkClient()
  const second = new FakeSdkClient()
  for (const [model, client] of [
    [OTHER_TEST_MODEL, first],
    [THIRD_TEST_MODEL, second],
  ]) {
    service.runtimes.set(keyFor(model), {
      client,
      initialized: true,
      starting: undefined,
      startedAt: Date.now(),
      profile: service.profile,
      cwd: root,
      model,
      sessions: 0,
    })
  }
  // The third model's retirement blocks on the first runtime's shutdown. It runs on the
  // default model, so the two seeded models and it are three distinct keys.
  const gate = deferred()
  first.shutdownGate = gate
  const third = service.flashTask({ task: 'third model', cwd: root })
  await waitFor(() => first.shutdowns === 1, 'the third model to begin retiring')

  // A fourth model retires the second runtime, then the second model is called again and
  // boots a *fresh* runtime under the very key the stale walk still holds.
  const fourth = await service.flashTask({ task: 'fourth model', cwd: root, model: FOURTH_TEST_MODEL })
  assert.equal(fourth.status, 'ok')
  assert.equal(second.shutdowns, 1, 'the fourth model retired the second runtime')
  const fresh = await service.flashTask({ task: 'second model again', cwd: root, model: OTHER_TEST_MODEL })
  assert.equal(fresh.status, 'ok')
  const freshClient = clients.at(-1)
  assert.equal(service.runtimes.get(keyFor(OTHER_TEST_MODEL))?.client, freshClient, 'the fresh runtime is mapped')
  assert.equal(freshClient.shutdowns, 0)

  // Resume the stale walk. Its snapshot still names the old second runtime under the key,
  // but the map now holds the fresh one: the map, not the snapshot, decides.
  gate.resolve()
  const thirdResult = await third
  assert.equal(thirdResult.status, 'ok')
  assert.equal(
    service.runtimes.get(keyFor(OTHER_TEST_MODEL))?.client,
    freshClient,
    'the stale walk must not delete the fresh runtime',
  )
  assert.equal(freshClient.shutdowns, 0, 'and must not shut the fresh runtime down')
  assert.equal(second.shutdowns, 1, 'and must not shut the old runtime down twice')

  await service.close()
  assert.equal(freshClient.shutdowns, 1, 'close() still finds and stops the fresh runtime')
})

test('a runtime with a session in flight is never retired by another model', async () => {
  const { root, clients, service } = makeModelService({
    models: [DEFAULT_TEST_MODEL, OTHER_TEST_MODEL],
    // The first model holds its session open; the second finishes normally.
    script: (model) => (model === DEFAULT_TEST_MODEL ? 'silent' : 'ok'),
    taskTimeoutMs: 30_000,
  })
  const controller = new AbortController()
  const holding = service
    .flashTask({ task: 'hold the runtime', cwd: root }, { signal: controller.signal })
    .catch((error) => error)
  // Wait until the first runtime has really started its session.
  for (let attempt = 0; attempt < 400 && (clients[0]?.prompts.length ?? 0) === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(clients[0].prompts.length, 1)

  const other = await service.flashTask({ task: 'second model', cwd: root, model: OTHER_TEST_MODEL })
  assert.equal(other.status, 'ok')
  assert.equal(clients.length, 2)
  assert.equal(clients[0].shutdowns, 0, 'the busy runtime is left alone')

  controller.abort()
  const cancelled = await holding
  assert.equal(cancelled.code, 'CANCELLED')
  await service.close()
})

test('salvage shuts down a slot’s runtimes for every model', async () => {
  const { root, service } = makeIsolatedService({ slots: 1, script: 'silent', taskTimeoutMs: 100 })
  const slotDir = service.isolation.slots[0].dir
  const seeded = []
  // A tree that served two models can hold a runtime for each. They are busy here, so the
  // process bound leaves them alone; salvage must still take every one of them down. The
  // default model is deliberately not seeded: this call runs on it.
  for (const model of [OTHER_TEST_MODEL, 'another-model:cloud']) {
    const client = new FakeSdkClient({ script: 'silent' })
    seeded.push(client)
    service.runtimes.set(`${service.profile}@${slotDir}@${model}`, {
      client,
      initialized: true,
      starting: undefined,
      startedAt: Date.now(),
      profile: service.profile,
      cwd: slotDir,
      model,
      sessions: 1,
    })
  }

  const error = await service.flashTask({ task: 'never finishes', cwd: root }).catch((caught) => caught)

  assert.equal(error.code, 'TIMEOUT')
  assert.deepEqual(seeded.map((client) => client.shutdowns), [1, 1])
  assert.equal(service.runtimes.size, 0, 'no runtime on the retired tree survives')
  await service.close()
})

test('a model outside the allowlist is refused before anything starts', async () => {
  const { root, clients, service } = makeModelService({ models: [DEFAULT_TEST_MODEL, OTHER_TEST_MODEL] })
  const refused = (error) =>
    error instanceof FlashTaskError &&
    error.code === 'MODEL_NOT_ALLOWED' &&
    error.message.includes(DEFAULT_TEST_MODEL) &&
    error.message.includes(OTHER_TEST_MODEL)

  await assert.rejects(service.flashTask({ task: 'x', cwd: root, model: 'not-allowed:cloud' }), refused)
  await assert.rejects(service.flashBatch({ tasks: ['a', 'b'], cwd: root, model: 'not-allowed:cloud' }), refused)

  // Nothing was leased, copied, or booted.
  assert.equal(clients.length, 0)
  assert.equal(service.isolation, undefined)
  await service.close()
})

test('a model inside a batch item is refused: the model is chosen per fleet', async () => {
  const { root, clients, service } = makeModelService({ models: [DEFAULT_TEST_MODEL, OTHER_TEST_MODEL] })
  await assert.rejects(
    service.flashBatch({ tasks: [{ task: 'a', model: OTHER_TEST_MODEL }, 'b'], cwd: root }),
    (error) =>
      error instanceof FlashTaskError &&
      error.code === 'INVALID_ARGUMENT' &&
      /chosen per fleet/.test(error.message) &&
      /top level of flash_batch/.test(error.message),
  )
  assert.equal(clients.length, 0)
  await service.close()
})

test('a non-default model on an old profile is refused, and the default is never refused', async () => {
  let asked = 0
  const { root, clients, service } = makeModelService({
    models: [DEFAULT_TEST_MODEL, OTHER_TEST_MODEL],
    honoursModelEnv: () => {
      asked += 1
      return false
    },
  })
  const outdated = (error) =>
    error instanceof FlashTaskError &&
    error.code === 'PROFILE_OUTDATED' &&
    /predates model choice/.test(error.message) &&
    /install\.mjs/.test(error.message) &&
    !/and restart/.test(error.message) &&
    /would run as deepseek-v4\.1-flash:cloud/.test(error.message)

  await assert.rejects(service.flashTask({ task: 'x', cwd: root, model: OTHER_TEST_MODEL }), outdated)
  // A negative answer is not cached: the next non-default call checks again, so rerunning
  // the installer takes effect without a restart.
  await assert.rejects(service.flashBatch({ tasks: ['a'], cwd: root, model: OTHER_TEST_MODEL }), outdated)
  assert.equal(asked, 2)
  assert.equal(clients.length, 0)

  // The default model is what an old profile runs; it never consults the check.
  const result = await service.flashTask({ task: 'x', cwd: root })
  assert.equal(result.status, 'ok')
  assert.equal(asked, 2)
  await service.close()
})

test('a positive profile answer is cached, and a later install takes effect without a restart', async () => {
  let honoured = false
  let asked = 0
  const { root, service } = makeModelService({
    models: [DEFAULT_TEST_MODEL, OTHER_TEST_MODEL],
    honoursModelEnv: () => {
      asked += 1
      return honoured
    },
  })

  // The first non-default call refuses, and the negative answer is deliberately re-read.
  await assert.rejects(service.flashTask({ task: 'x', cwd: root, model: OTHER_TEST_MODEL }), /predates model choice/)
  honoured = true
  const installed = await service.flashTask({ task: 'x', cwd: root, model: OTHER_TEST_MODEL })
  assert.equal(installed.status, 'ok')
  assert.equal(asked, 2, 'the negative answer was re-checked, and the install was seen')

  // A positive answer is a fact for the life of the server: no further reads.
  const again = await service.flashTask({ task: 'x', cwd: root, model: OTHER_TEST_MODEL })
  assert.equal(again.status, 'ok')
  assert.equal(asked, 2, 'the positive answer is cached')
  await service.close()
})

test('DSH_HOME is resolved the way dsh reads it before the profile check', async () => {
  const home = mkdtempSync(join(tmpdir(), 'flash-mcp-home-'))
  const dshHome = join(home, 'harness')
  mkdirSync(join(dshHome, 'profiles', 'flash-service'), { recursive: true })
  writeFileSync(
    join(dshHome, 'profiles', 'flash-service', 'cordis.patch.yml'),
    'model: !!js process.env.FLASH_ROUTE_MODEL || "deepseek-v4.1-flash:cloud"\n',
  )
  const { root, service } = makeModelService({
    models: [DEFAULT_TEST_MODEL, OTHER_TEST_MODEL],
    // dsh trims the value and expands a leading ~; a literal read would miss this profile.
    env: { DSH_HOME: '  ~/harness  ' },
    home,
    // No injected answer: the real doctor helper must resolve the path and read the patch.
    honoursModelEnv: undefined,
  })
  const result = await service.flashTask({ task: 'x', cwd: root, model: OTHER_TEST_MODEL })
  assert.equal(result.status, 'ok')
  assert.equal(result.route.model, OTHER_TEST_MODEL)
  await service.close()
})

test('checkModel refuses what a synchronous call would, without starting anything', async () => {
  let asked = 0
  const { root, clients, service } = makeModelService({
    models: [DEFAULT_TEST_MODEL, OTHER_TEST_MODEL],
    honoursModelEnv: () => {
      asked += 1
      return false
    },
  })
  assert.throws(
    () => service.checkModel({ model: 'not-allowed:cloud' }, 'flash_task'),
    (error) => error instanceof FlashTaskError && error.code === 'MODEL_NOT_ALLOWED',
  )
  assert.throws(
    () => service.checkModel({ mode: 'nope' }, 'flash_task'),
    (error) => error instanceof FlashTaskError && error.code === 'MODE_UNAVAILABLE',
  )
  assert.throws(
    () => service.checkModel({ tasks: [{ task: 'a', model: OTHER_TEST_MODEL }] }, 'flash_batch'),
    (error) => error instanceof FlashTaskError && error.code === 'INVALID_ARGUMENT' && /chosen per fleet/.test(error.message),
  )
  // The installed-profile check is the same one a call makes.
  assert.throws(
    () => service.checkModel({ model: OTHER_TEST_MODEL }, 'flash_task'),
    (error) => error instanceof FlashTaskError && error.code === 'PROFILE_OUTDATED',
  )
  assert.equal(asked, 1)
  assert.equal(clients.length, 0, 'nothing was booted')
  await service.close()
})

test('a result says when the worker ran on another model than the one requested', async () => {
  const { root, service } = makeModelService({
    models: [DEFAULT_TEST_MODEL, OTHER_TEST_MODEL],
    routeModel: 'deepseek-v4.1-flash:1017-cloud',
  })
  const result = await service.flashTask({ task: 'x', cwd: root, model: OTHER_TEST_MODEL })
  assert.match(
    result.warnings.join('\n'),
    /the worker ran on deepseek-v4\.1-flash:1017-cloud, not the requested minimax-m3\.1-flash:cloud/,
  )
  await service.close()
})

test('a fleet warns per task when a worker ran on another model', async () => {
  const { root, service } = makeModelService({
    script: 'batch',
    models: [DEFAULT_TEST_MODEL, OTHER_TEST_MODEL],
    routeModel: 'deepseek-v4.1-flash:1017-cloud',
  })
  const result = await service.flashBatch({ tasks: ['a', 'b'], cwd: root, model: OTHER_TEST_MODEL })
  const warnings = result.warnings.join('\n')
  assert.match(warnings, /task 1: the worker ran on deepseek-v4\.1-flash:1017-cloud, not the requested minimax-m3\.1-flash:cloud/)
  assert.match(warnings, /task 2: the worker ran on deepseek-v4\.1-flash:1017-cloud, not the requested minimax-m3\.1-flash:cloud/)
  await service.close()
})

test('a fleet with no paired results still warns when it ran on another model', async () => {
  const { root, service } = makeModelService({
    // No label mapping and an unreadable return value: `results` is null, but the engine
    // still reported the model each worker ran on.
    script: 'batch-unreadable-nolabels',
    models: [DEFAULT_TEST_MODEL, OTHER_TEST_MODEL],
    routeModel: 'deepseek-v4.1-flash:1017-cloud',
  })
  const result = await service.flashBatch({ tasks: ['a', 'b'], cwd: root, model: OTHER_TEST_MODEL })
  assert.equal(result.results, null)
  const warnings = result.warnings.join('\n')
  const modelWarnings = result.warnings.filter((line) => line.startsWith('the fleet ran on '))
  assert.equal(modelWarnings.length, 1, `expected one fleet-level model warning, saw:\n${warnings}`)
  assert.match(
    modelWarnings[0],
    /^the fleet ran on deepseek-v4\.1-flash:1017-cloud, not the requested minimax-m3\.1-flash:cloud$/,
  )
  await service.close()
})

test('retries one initialize timeout and then succeeds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flash-mcp-test-'))
  const clients = []
  const logs = []
  const service = new FlashTaskService({
    root,
    initTimeoutMs: 1_500,
    clientFactory: () => {
      const client = new FakeSdkClient()
      if (clients.length === 0) {
        client.diagnostics = 'cold start stderr'
        client.initializeFailures.push(initializeTimeout(1_500))
      }
      clients.push(client)
      return client
    },
    log: (line) => logs.push(line),
    isolate: { mode: 'none' },
  })

  const result = await service.flashTask({ task: 'x', cwd: root })
  assert.equal(result.status, 'ok')
  // Exactly one retry: a second client, each asked to initialize once.
  assert.equal(clients.length, 2)
  assert.equal(clients[0].initializes.length, 1)
  assert.equal(clients[1].initializes.length, 1)
  assert.equal(clients[0].shutdowns, 1, 'the timed-out runtime is shut down before the retry')
  assert.ok(
    logs.some((line) => /the runtime did not answer initialize within 1\.5 s; starting it once more/.test(line)),
    `expected the retry log line, saw:\n${logs.join('\n')}`,
  )
})

test('two initialize timeouts fail as tried twice with the second stderr tail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flash-mcp-test-'))
  const clients = []
  const service = new FlashTaskService({
    root,
    initTimeoutMs: 2_000,
    clientFactory: () => {
      const client = new FakeSdkClient()
      client.diagnostics = clients.length === 0 ? 'first attempt stderr' : 'second attempt stderr'
      client.initializeFailures.push(initializeTimeout(2_000))
      clients.push(client)
      return client
    },
    log: () => {},
    isolate: { mode: 'none' },
  })

  await assert.rejects(
    service.flashTask({ task: 'x', cwd: root }),
    (error) =>
      error instanceof FlashTaskError &&
      error.code === 'RUNTIME_INIT_FAILED' &&
      /tried twice/.test(error.message) &&
      error.message.includes('--- dsh stderr ---\nsecond attempt stderr') &&
      !error.message.includes('first attempt stderr'),
  )
  assert.equal(clients.length, 2, 'only one retry happens')
  assert.deepEqual(clients.map((client) => client.shutdowns), [1, 1])
  assert.deepEqual(clients.map((client) => client.initializes.length), [1, 1])
})

test('does not retry a non-timeout initialize failure, and carries its stderr tail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flash-mcp-test-'))
  const clients = []
  const service = new FlashTaskService({
    root,
    clientFactory: () => {
      const client = new FakeSdkClient()
      client.diagnostics = 'identity mismatch stderr'
      client.initializeFailures.push(new Error('unexpected SDK runtime identity: {"name":"someone-else"}'))
      clients.push(client)
      return client
    },
    log: () => {},
    isolate: { mode: 'none' },
  })

  await assert.rejects(
    service.flashTask({ task: 'x', cwd: root }),
    (error) =>
      error instanceof FlashTaskError &&
      error.code === 'RUNTIME_INIT_FAILED' &&
      /unexpected SDK runtime identity/.test(error.message) &&
      error.message.includes('--- dsh stderr ---\nidentity mismatch stderr') &&
      !/tried twice/.test(error.message),
  )
  assert.equal(clients.length, 1, 'a verdict is not retried')
  assert.equal(clients[0].shutdowns, 1)
})

test('concurrent callers all receive the outcome of the initialize retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flash-mcp-test-'))
  const clients = []
  const logs = []
  const service = new FlashTaskService({
    root,
    initTimeoutMs: 1_000,
    clientFactory: () => {
      const client = new FakeSdkClient()
      if (clients.length === 0) {
        // Hold the first caller on `starting` long enough for the second to join it.
        client.initializeDelayMs = 20
        client.initializeFailures.push(initializeTimeout(1_000))
      }
      clients.push(client)
      return client
    },
    log: (line) => logs.push(line),
    isolate: { mode: 'none' },
  })

  const [first, second] = await Promise.all([
    service.flashTask({ task: 'first', cwd: root }),
    service.flashTask({ task: 'second', cwd: root }),
  ])
  assert.equal(first.status, 'ok')
  assert.equal(second.status, 'ok')
  assert.equal(clients.length, 2, 'both callers share one retry rather than starting their own')
  assert.equal(clients[1].initializes.length, 1)
  assert.equal(logs.filter((line) => /starting it once more/.test(line)).length, 1)
})

test('the provider stays pinned while the model is a per-call choice', async () => {
  const logs = []
  const { root, client, service } = makeService({
    models: ['deepseek-v4.1-flash:cloud', 'deepseek-v4.1-flash:1017-cloud'],
    log: (line) => logs.push(line),
  })
  client.routeModel = 'deepseek-v4.1-flash:1017-cloud'
  const result = await service.flashTask({
    task: 'x',
    cwd: root,
    provider: 'deepseek-official',
    model: 'deepseek-v4.1-flash:1017-cloud',
    sandbox: 'danger-full-access',
  })
  // The provider is fixed: the argument is only logged, and the request still says ollama.
  assert.deepEqual(result.route, { provider: 'ollama', model: 'deepseek-v4.1-flash:1017-cloud' })
  assert.equal(client.initializes[0].provider, 'ollama')
  assert.equal(client.initializes[0].model, 'deepseek-v4.1-flash:1017-cloud')
  assert.ok(logs.some((line) => /ignoring unsupported flash_task argument "provider"/.test(line)))
  assert.ok(logs.some((line) => /ignoring unsupported flash_task argument "sandbox"/.test(line)))
  assert.equal(logs.some((line) => /ignoring unsupported flash_task argument "model"/.test(line)), false)
  // The model a call asked for is on its start line, so the log says what it is spending on.
  assert.ok(
    logs.some((line) => /session .* prompted on deepseek-v4\.1-flash:1017-cloud/.test(line)),
    `expected the model on the start line, saw:\n${logs.join('\n')}`,
  )
})

test('fences cwd to the service root', async () => {
  const { root, service } = makeService()
  await assert.rejects(
    service.flashTask({ task: 'x', cwd: join(root, '..') }),
    (error) => error instanceof FlashTaskError && error.code === 'CWD_OUTSIDE_ROOT',
  )
  await assert.rejects(
    service.flashTask({ task: 'x', cwd: '/etc' }),
    (error) => error.code === 'CWD_OUTSIDE_ROOT',
  )
  const inside = await service.flashTask({ task: 'x', cwd: 'nested/deeper' })
  assert.equal(inside.status, 'ok')
})

test('requires a task and rejects a non-string acceptance', async () => {
  const { service, root } = makeService()
  await assert.rejects(service.flashTask({ cwd: root }), (error) => error.code === 'INVALID_ARGUMENT')
  await assert.rejects(service.flashTask({ task: '   ', cwd: root }), (error) => error.code === 'INVALID_ARGUMENT')
  await assert.rejects(service.flashTask({ task: 'x', cwd: root, acceptance: 7 }), (error) => error.code === 'INVALID_ARGUMENT')
})

// ── taskFile: a long brief goes in once, exactly as written ────────────────

test('reads the task from a file, relative to the service root and exactly as written', async () => {
  const logs = []
  const { root, client, service } = makeService({ log: (line) => logs.push(line) })
  const brief = 'Fix the parser.\n\nA long brief, with $(cat brief) left as literal text.\n'
  writeFileSync(join(root, 'brief.txt'), brief)

  const result = await service.flashTask({ taskFile: 'brief.txt', cwd: root })
  assert.equal(result.status, 'ok')
  assert.ok(client.prompts[0].text.includes(brief), 'the brief must arrive verbatim')
  assert.match(client.prompts[0].text, /Task:\nFix the parser\./)
  assert.ok(
    logs.some((line) => line === `task read from ${join(service.root, 'brief.txt')} (${String(brief.length)} chars)`),
    `expected a "task read from" log line, saw ${JSON.stringify(logs)}`,
  )
})

test('taskFile and task are mutually exclusive, and one of them is required', async () => {
  const { root, service } = makeService()
  writeFileSync(join(root, 'brief.txt'), 'do it\n')
  const rejects = (args, pattern) =>
    assert.rejects(
      service.flashTask({ cwd: root, ...args }),
      (error) => error.code === 'INVALID_ARGUMENT' && pattern.test(error.message),
    )
  await rejects({}, /exactly one of "task".*"taskFile"/)
  await rejects({ task: 'inline', taskFile: 'brief.txt' }, /task and taskFile cannot both be given/)
})

test('refuses a taskFile outside the root, a directory, an oversized file, and an empty one', async () => {
  const { root, service } = makeService()
  const outside = mkdtempSync(join(tmpdir(), 'flash-mcp-outside-'))
  writeFileSync(join(outside, 'brief.txt'), 'not yours\n')
  writeFileSync(join(root, 'empty.txt'), '  \n\t\n')
  writeFileSync(join(root, 'huge.txt'), 'x'.repeat(256 * 1024 + 1))
  const rejects = (args, code, pattern) =>
    assert.rejects(service.flashTask({ cwd: root, ...args }), (error) => error.code === code && pattern.test(error.message))

  await rejects({ taskFile: join(outside, 'brief.txt') }, 'TASK_FILE_OUTSIDE_ROOT', /is outside the service root/)
  await rejects({ taskFile: relative(root, join(outside, 'brief.txt')) }, 'TASK_FILE_OUTSIDE_ROOT', /is outside the service root/)
  await rejects({ taskFile: root }, 'INVALID_ARGUMENT', /is not a regular file/)
  await rejects({ taskFile: 'huge.txt' }, 'INVALID_ARGUMENT', /the most this service reads is 262144/)
  await rejects({ taskFile: 'empty.txt' }, 'INVALID_ARGUMENT', /is empty/)
  await rejects({ taskFile: 'missing.txt' }, 'INVALID_ARGUMENT', /could not be read/)
})

test('a fleet task may carry a taskFile instead of its text', async () => {
  const logs = []
  const { root, client, service } = makeService({ script: 'batch', log: (line) => logs.push(line) })
  writeFileSync(join(root, 'second.txt'), 'second task from a file\n')
  const outside = mkdtempSync(join(tmpdir(), 'flash-mcp-outside-'))
  writeFileSync(join(outside, 'brief.txt'), 'not yours\n')

  const result = await service.flashBatch({ tasks: ['first task', { taskFile: 'second.txt', acceptance: 'be brief' }], cwd: root })
  assert.equal(result.status, 'ok')
  const { items } = promptArgs(client.prompts[0].text)
  assert.match(items[1].prompt, /Task:\nsecond task from a file/)
  assert.match(items[1].prompt, /Acceptance criteria:\nbe brief/)
  assert.ok(logs.some((line) => /^task read from .*second\.txt \(\d+ chars\)$/.test(line)))

  // The same exactly-one rule applies per task, and the entry errors name the entry.
  await assert.rejects(
    service.flashBatch({ tasks: [{ task: 'inline', taskFile: 'second.txt' }], cwd: root }),
    (error) => error.code === 'INVALID_ARGUMENT' && /tasks\[0\] carries both "task" and "taskFile"/.test(error.message),
  )
  await assert.rejects(
    service.flashBatch({ tasks: [{ taskFile: join(outside, 'brief.txt') }], cwd: root }),
    (error) => error.message.includes('tasks[0].taskFile') && /is outside the service root/.test(error.message),
  )
})

test('reports a non-delegating orchestrator instead of hanging', async () => {
  const { root, service } = makeService({ script: 'no-delegation' })
  await assert.rejects(
    service.flashTask({ task: 'x', cwd: root }),
    (error) => error.code === 'NOT_DELEGATED' && /I cannot do that\./.test(error.message),
  )
})

test('reports the runtime dying mid-task', async () => {
  const { root, service } = makeService({ script: 'runtime-exit' })
  await assert.rejects(service.flashTask({ task: 'x', cwd: root }), (error) => error.code === 'RUNTIME_EXITED')
})

test('bounds the wait with the task budget', async () => {
  const { root, service } = makeService({ script: 'silent', taskTimeoutMs: 50 })
  await assert.rejects(
    service.flashTask({ task: 'x', cwd: root }),
    (error) => error.code === 'TIMEOUT' && /exceeded its 50ms budget/.test(error.message),
  )
})

test('honours client cancellation', async () => {
  const { root, service } = makeService({ script: 'silent' })
  const controller = new AbortController()
  const pending = service.flashTask({ task: 'x', cwd: root }, { signal: controller.signal })
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(pending, (error) => error.name === 'FlashTaskCancelled')
})

test('reports progress to the client on an interval, and stops when the call settles', async () => {
  const { root, client, service } = makeService({ progressIntervalMs: 10 })
  client.delayMs = 80
  const reports = []
  const result = await service.flashTask(
    { task: 'x', cwd: root },
    { progress: (report) => reports.push(report), progressToken: 'tok-1' },
  )

  assert.equal(result.status, 'ok')
  assert.ok(reports.length >= 2, `expected progress reports, saw ${String(reports.length)}`)
  assert.equal(typeof reports[0].progress, 'number')
  assert.equal(reports[0].total, Math.round(service.taskTimeoutMs / 1000))
  assert.match(reports[0].message, /^flash_task running \d+m?\d*s; .*last event \d+m?\d*s ago \(session flash-task-.*\)$/)
  for (let index = 1; index < reports.length; index += 1) {
    assert.ok(reports[index].progress > reports[index - 1].progress, 'progress must move forward')
  }
  // The interval is cleared when the call settles, so no late heartbeat arrives.
  const settled = reports.length
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(reports.length, settled, 'no progress after the call settled')
})

test('sends no progress when the request carried no progress token', async () => {
  const { root, client, service } = makeService({ progressIntervalMs: 5 })
  client.delayMs = 30
  const reports = []
  const result = await service.flashTask({ task: 'x', cwd: root }, { progress: (report) => reports.push(report) })
  assert.equal(result.status, 'ok')
  assert.deepEqual(reports, [], 'a request without a token must produce no notification')
})

test('reports progress while a queued call waits for a free tree', async () => {
  const { root, service } = makeIsolatedService({ slots: 1, script: 'silent', taskTimeoutMs: 1_000, progressIntervalMs: 5 })
  const holding = service.flashTask({ task: 'hold the only tree', cwd: root }).catch((error) => error)
  await new Promise((resolve) => setTimeout(resolve, 30))

  const reports = []
  const controller = new AbortController()
  const queued = service.flashTask(
    { task: 'queued', cwd: root },
    { signal: controller.signal, progress: (report) => reports.push(report), progressToken: 'tok-queued' },
  )
  await new Promise((resolve) => setTimeout(resolve, 40))
  controller.abort()
  const cancelled = await queued.catch((error) => error)

  assert.equal(cancelled.code, 'CANCELLED')
  assert.match(cancelled.message, /cancelled while waiting/)
  assert.ok(reports.length >= 2, `expected progress while waiting, saw ${String(reports.length)}`)
  // A call queued for a tree has no session event to report, so the heartbeat says what it
  // is waiting for instead of "last event … ago", which read as a hang.
  assert.match(reports[0].message, /^flash_task running \d+m?\d*s; queued \d+m?\d*s: waiting for a free tree \(1 of 1 in use\) \(session flash-task-.*\)$/)
  // A call that never got a tree is still a call the client must see living; but its
  // interval stops when it is cancelled, and nothing is salvaged because nothing ran.
  const settled = reports.length
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(reports.length, settled)
  await holding
  await service.close()
})

test('describeActivity renders a queued call as a wait, never as silence', () => {
  const pool = { inUse: 2, size: 2 }
  const activity = { at: 1_000, events: 0, what: 'queued: waiting for a free tree (2 of 2 in use)', queuedSince: 1_000, pool }
  assert.equal(
    describeActivity(activity, 1_000 + 6 * 60_000 + 12_000),
    'queued 6m12s: waiting for a free tree (2 of 2 in use)',
  )
  // The counts are read when the line is rendered, so a tree freeing up is visible.
  pool.inUse = 1
  assert.equal(describeActivity(activity, 2_000), 'queued 1s: waiting for a free tree (1 of 2 in use)')
  // Without a pool the counts recorded when the wait began are used.
  const detached = { ...activity, pool: undefined, queuedInUse: 2, queuedSize: 2 }
  assert.equal(describeActivity(detached, 2_000), 'queued 1s: waiting for a free tree (2 of 2 in use)')
  // The ordinary line is unchanged.
  assert.equal(describeActivity({ at: 1_000, events: 0, what: 'starting' }, 4_000), 'starting · last event 3s ago')
})

test('a call that waited for a tree reports queuedMs, separately from its run time', async () => {
  const { root, client, service } = makeIsolatedService({ slots: 1 })
  client.delayMs = 250
  const first = service.flashTask({ task: 'first', cwd: root })
  // Let the first call lease the only tree before the second asks for one, so the wait is real.
  await new Promise((resolve) => setTimeout(resolve, 30))
  const second = service.flashTask({ task: 'second', cwd: root })
  const [a, b] = await Promise.all([first, second])

  assert.equal(a.queuedMs, 0)
  assert.ok(b.queuedMs > 0, `expected the second call to report a wait, got ${String(b.queuedMs)}`)
  // durationMs keeps its meaning: the session's own run, not the time spent queueing.
  assert.equal(typeof a.durationMs, 'number')
  assert.equal(typeof b.durationMs, 'number')
  await service.close()
})

test('truncates an oversized child message and warns about a failed child', async () => {
  const { root, service } = makeService({ maxResultChars: 12 })
  const result = await service.flashTask({ task: 'x', cwd: root })
  assert.equal(result.resultTruncated, true)
  assert.match(result.result, /truncated/)

  const failing = makeService({ script: 'child-error' })
  const failed = await failing.service.flashTask({ task: 'x', cwd: failing.root })
  assert.equal(failed.status, 'error')
  assert.deepEqual(failed.warnings, ['the worker ended with status "error"'])
})

test('an ok call with an empty message and no change is reported as failed', async () => {
  const { root, service } = makeService({ script: 'empty-result' })
  const result = await service.flashTask({ task: 'x', cwd: root })

  // "ok"/"completed" alone is not evidence of work: nothing was said and nothing changed.
  assert.equal(result.status, 'error')
  assert.equal(result.stopReason, 'completed')
  assert.equal(result.result, '')
  assert.equal(result.emptyResult, true)
  assert.deepEqual(result.warnings, [
    'the worker ended with an empty final message and changed nothing; treat the call as failed and send the task again',
  ])
})

test('an empty message with a change keeps the status but warns that the account is missing', async () => {
  const { root, service } = makeIsolatedService({ script: 'empty-result', file: 'quiet.txt' })
  const result = await service.flashTask({ task: 'write one file', cwd: root })

  assert.equal(result.change.available, true)
  assert.deepEqual(result.change.filesChanged, ['quiet.txt'])
  assert.equal(result.status, 'ok')
  assert.equal(result.emptyResult, true)
  assert.deepEqual(result.warnings, [
    'the worker ended with an empty final message, so its account of the change is missing; review the diff before applying it',
  ])
  await service.close()
})

test('reports extra children rather than hiding them', async () => {
  const { root, service } = makeService({ script: 'two-children' })
  const result = await service.flashTask({ task: 'x', cwd: root })
  assert.equal(result.children.length, 2)
  assert.match(result.warnings[0], /delegated 2 times/)
  assert.equal(result.childSessionId, result.children[1].childSessionId)
  assert.equal(result.children[0].route.provider, 'ollama')
})

test('prompt builders keep the dispatcher on a single delegation', () => {
  const child = buildChildPrompt({ cwd: '/w', task: 'do it', acceptance: 'done' })
  // The two worker instructions travel with every call, copy or not; see WORKER_INSTRUCTIONS.
  assert.equal(child, `Working directory: /w\n\n${WORKER_INSTRUCTIONS.join('\n')}\n\nTask:\ndo it\n\nAcceptance criteria:\ndone`)
  const prompt = buildOrchestrationPrompt(child)
  assert.match(prompt, /<<<TASK\nWorking directory: \/w/)
  assert.match(prompt, /TASK$/)
})

test('every child prompt carries the standing worker instructions, in order', () => {
  // The first two are the originals; the other three exist so a caller reading the report
  // (never the transcript) learns about a deviation, a wrong contract, or an unfinished task.
  assert.equal(WORKER_INSTRUCTIONS.length, 5)
  assert.match(WORKER_INSTRUCTIONS[0], /^Do not commit unless the task explicitly asks/)
  assert.match(WORKER_INSTRUCTIONS[1], /^If the work reaches for an escape hatch/)
  assert.equal(
    WORKER_INSTRUCTIONS[2],
    'If you build a different interface or structure than the task names (another signature, the logic split across several places instead of one, a different data shape), say so first in your final report, with the reason.',
  )
  assert.equal(
    WORKER_INSTRUCTIONS[3],
    "If the task's contract or design looks wrong, report it rather than quietly working around it.",
  )
  assert.equal(
    WORKER_INSTRUCTIONS[4],
    'If you stop before the task is done, start your final report with why you stopped (for example: the context is full, a blocker, a test you could not make pass) and what is left.',
  )
  for (const prompt of [
    buildChildPrompt({ cwd: '/w', task: 'x' }),
    buildChildPrompt({ cwd: '/w', task: 'x', copy: true, uncommitted: { count: 0, files: [] }, discard: true }),
  ]) {
    assert.ok(prompt.startsWith(`Working directory: /w\n\n${WORKER_INSTRUCTIONS.join('\n')}`))
    for (const line of WORKER_INSTRUCTIONS) assert.ok(prompt.includes(line))
  }
})

test('the three new instructions reach the dispatched task and every fleet member', async () => {
  const { root, client, service } = makeService()
  await service.flashTask({ task: 'one', cwd: root })
  for (const line of WORKER_INSTRUCTIONS.slice(2)) assert.ok(client.prompts[0].text.includes(line))

  const fleet = makeService({ script: 'batch' })
  await fleet.service.flashBatch({ tasks: ['a', 'b'], cwd: fleet.root })
  const { items } = promptArgs(fleet.client.prompts[0].text)
  for (const item of items) {
    for (const line of WORKER_INSTRUCTIONS.slice(2)) assert.ok(item.prompt.includes(line))
  }
})

test('a discard call tells its worker that nothing it leaves behind survives', async () => {
  const copy = { copy: true, uncommitted: { count: 0, files: [] } }
  const kept = buildChildPrompt({ cwd: '/w', task: 'review', ...copy })
  const discarded = buildChildPrompt({ cwd: '/w', task: 'review', ...copy, discard: true })

  assert.match(kept, /it already exists and is left out of the reported change\./)
  assert.equal(discarded.includes('it already exists and is left out of the reported change'), false)
  assert.ok(
    discarded.includes(
      'This call keeps nothing: the copy, ./.flash-tmp/ included, is deleted when you finish, and no patch is stored. ' +
        'Anything that matters — a test that proves a finding, a proposed fix — must be written out in full in your final message (a fix as a unified diff).',
    ),
    discarded,
  )
  // It still tells the worker that ./.flash-tmp exists for scratch.
  assert.match(discarded, /Scratch files of your own .* go under \.\/\.flash-tmp\/ in this copy;/)
  // Without discard, the copy paragraph is byte-for-byte what 0.1.3 sent, spelled out here
  // rather than rebuilt with the function under test.
  assert.equal(
    kept,
    [
      'Working directory: /w',
      '',
      ...WORKER_INSTRUCTIONS,
      '',
      "This working directory is a disposable copy of the caller's repository, so its files are here at the same relative paths.",
      'Use relative paths: a path naming the original repository refers to a different directory that you cannot write, and',
      'anything outside this copy is discarded — only the change you leave here is reported back.',
      'Scratch files of your own (downloads, throwaway output, notes to yourself) go under ./.flash-tmp/ in this copy;',
      'it already exists and is left out of the reported change.',
      '',
      'Task:',
      'review',
    ].join('\n'),
  )
  // discard says nothing when there is no copy.
  assert.equal(buildChildPrompt({ cwd: '/w', task: 'x', discard: true }), buildChildPrompt({ cwd: '/w', task: 'x' }))
})

test('the base-patch paragraph appears only when a call continues from an earlier patch', () => {
  const copy = { copy: true, uncommitted: { count: 0, files: [] } }
  const base = { patchId: 'flash-1', filesChanged: ['a.txt', 'b.txt'], conflicts: [] }
  const without = buildChildPrompt({ cwd: '/w', task: 'x', ...copy })

  // Without the option the prompt is byte-for-byte what it was.
  assert.equal(without, buildChildPrompt({ cwd: '/w', task: 'x', ...copy, basePatch: undefined }))
  assert.doesNotMatch(without, /earlier call/)

  const withBase = buildChildPrompt({ cwd: '/w', task: 'x', ...copy, basePatch: base })
  assert.ok(
    withBase.includes(
      'The copy already contains the change from an earlier call (patch flash-1), applied before you started: a.txt, b.txt. Continue from it; do not redo it.',
    ),
    withBase,
  )
  assert.equal(withBase.includes('It did not apply cleanly'), false)

  const conflicted = buildChildPrompt({ cwd: '/w', task: 'x', ...copy, basePatch: { ...base, conflicts: ['a.txt'] } })
  assert.ok(conflicted.includes('It did not apply cleanly: a.txt hold conflict markers. Resolve them first.'), conflicted)

  // It follows the uncommitted-files paragraph, which still describes the caller's tree.
  const dirty = buildChildPrompt({ cwd: '/w', task: 'x', ...copy, uncommitted: { count: 1, files: ['mine.txt'] }, basePatch: base })
  assert.ok(dirty.indexOf("They are the caller's work in progress") < dirty.indexOf('The copy already contains'))

  // Only the first 20 files are named: the list is context, not an inventory.
  const many = Array.from({ length: 22 }, (_, index) => `f${String(index)}.txt`)
  const capped = buildChildPrompt({ cwd: '/w', task: 'x', ...copy, basePatch: { ...base, filesChanged: many } })
  assert.ok(capped.includes('f19.txt. Continue from it'))
  assert.equal(capped.includes('f20.txt'), false)
})

test('apply "discard" passes discard into the prompt and stores no patch', async () => {
  const { root, client, service } = makeIsolatedService({ file: 'scratch.txt' })
  const result = await service.flashTask({ task: 'review the parser', cwd: root, apply: 'discard' })

  assert.match(client.prompts[0].text, /This call keeps nothing:/)
  assert.equal(result.change.available, true)
  assert.equal(result.change.stored, false)
  await service.close()

  const fleet = makeIsolatedService({ file: 'scratch.txt', script: 'batch' })
  await fleet.service.flashBatch({ tasks: ['review'], cwd: fleet.root, apply: 'discard' })
  const { items } = promptArgs(fleet.client.prompts[0].text)
  assert.match(items[0].prompt, /This call keeps nothing:/)
  await fleet.service.close()
})

test('runs a fleet and returns one compact result per task, in task order', async () => {
  const { root, client, service } = makeService({ script: 'batch' })
  const result = await service.flashBatch({
    tasks: ['first task', { task: 'second task', acceptance: 'be brief' }, 'third task'],
    cwd: root,
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.requested, 3)
  assert.equal(result.agentsStarted, 3)
  assert.equal(result.runId, 'run-1')
  assert.equal(result.maxParallel, 3)
  assert.deepEqual(result.results.map((entry) => entry.index), [0, 1, 2])
  assert.deepEqual(result.results.map((entry) => entry.status), ['ok', 'ok', 'ok'])
  assert.match(result.results[1].result, /fleet result 1 from task-2/)
  assert.deepEqual(result.routes, [{ provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' }])
  assert.equal(result.workers.length, 3)
  assert.equal(result.workers[0].route.provider, 'ollama')
  assert.equal(result.runtime.sessions, 1)
  assert.equal(result.warnings, undefined)

  // One call is one workflow run: the dispatcher relays our constant script and
  // a plain data payload, so the fan-out shape cannot drift between calls.
  assert.equal(client.prompts.length, 1)
  const prompt = client.prompts[0].text
  assert.match(prompt, /Call the `workflow` tool exactly once/)
  assert.match(prompt, /Do not call any other tool/)
  assert.ok(prompt.includes(BATCH_SCRIPT), 'the script must be relayed verbatim')
  assert.match(prompt, /parallel\(args\.items\.map/)
  assert.match(prompt, /"perItemChars":4000/)
  assert.match(prompt, /"label":"task-2"/)
  assert.match(prompt, /second task/)
  assert.match(prompt, /Acceptance criteria:\\nbe brief/)
  // The engine starts fleet members without a persona row, so the equivalent
  // operating rules travel inside each item prompt.
  assert.ok(prompt.includes(WORKER_RULES.replaceAll('\n', '\\n')), 'item rules must be carried in the payload')
})

test('reports a partial fleet per task instead of collapsing it to one status', async () => {
  const { root, service } = makeService({ script: 'batch-partial' })
  const result = await service.flashBatch({ tasks: ['a', 'b', 'c'], cwd: root })

  assert.equal(result.status, 'partial')
  assert.deepEqual(result.results.map((entry) => entry.status), ['ok', 'error', 'ok'])
  assert.match(result.warnings.join('\n'), /at least one worker ended with a non-ok status/)
})

test('a fleet member reported ok with an empty message becomes an error for that task', async () => {
  const { root, service } = makeService({ script: 'batch-empty' })
  const result = await service.flashBatch({ tasks: ['a', 'b', 'c'], cwd: root })

  // The entry's text is the member's account of its work; an empty one cannot be "ok".
  assert.deepEqual(result.results.map((entry) => entry.status), ['ok', 'error', 'ok'])
  assert.equal(result.results[1].emptyResult, true)
  assert.equal(result.results[0].emptyResult, undefined)
  // The fleet status is computed from the corrected entries, so it is partial, not ok.
  assert.equal(result.status, 'partial')
})

test('an unreadable workflow value still pairs tasks through the engine member records', async () => {
  const { root, service } = makeService({ script: 'batch-unreadable' })
  const result = await service.flashBatch({ tasks: ['a', 'b', 'c'], cwd: root })

  assert.equal(result.status, 'ok')
  assert.deepEqual(result.results.map((entry) => entry.status), ['ok', 'ok', 'ok'])
  assert.deepEqual(result.results.map((entry) => entry.childSessionId !== undefined), [true, true, true])
  assert.match(result.results[1].result, /^worker 1$/)
  assert.match(result.warnings.join('\n'), /come from the engine's member records/)
})

test('with neither the return value nor member records, the mapping is reported absent', async () => {
  const { root, service } = makeService({ script: 'batch-unreadable-nolabels' })
  const result = await service.flashBatch({ tasks: ['a', 'b', 'c'], cwd: root })

  assert.equal(result.status, 'unknown')
  assert.equal(result.results, null)
  assert.equal(result.workers.length, 3)
  assert.match(result.warnings.join('\n'), /per-task results could not be read/)
})

test('reads a flat tool result as well as the nested shape Harness emits', () => {
  const nested = { content: [{ type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: 'nested payload' }] }] }
  assert.equal(toolResultText(nested), 'nested payload')
  assert.equal(toolResultText({ content: [{ type: 'text', text: 'flat payload' }] }), 'flat payload')
  assert.equal(toolResultText({ content: [] }), '')
  assert.equal(toolResultText(undefined), '')
})

test('refuses a fleet whose orchestrator never started a worker', async () => {
  const { root, service } = makeService({ script: 'batch-no-fleet' })
  await assert.rejects(
    service.flashBatch({ tasks: ['a'], cwd: root }),
    (error) => error instanceof FlashTaskError && error.code === 'NOT_DELEGATED' && /without starting the fleet/.test(error.message),
  )
})

test('read-only is the only selectable narrowing, and it runs its own process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flash-mcp-test-'))
  const clients = []
  const service = new FlashTaskService({
    root,
    clientFactory: (profileName) => {
      const client = new FakeSdkClient({ script: 'ok' })
      client.profileName = profileName
      clients.push(client)
      return client
    },
    log: () => {},
  })

  const writing = await service.flashTask({ task: 'read a file', cwd: root })
  assert.equal(writing.mode, 'workspace-write')
  assert.equal(writing.runtime.profile, 'flash-service')
  assert.deepEqual(clients.map((client) => client.profileName), ['flash-service'])

  const reading = await service.flashTask({ task: 'read a file', cwd: root, mode: 'read-only' })
  assert.equal(reading.mode, 'read-only')
  assert.equal(reading.runtime.profile, 'flash-service-readonly')
  assert.equal(reading.runtime.booted, true)
  // A second read-only call reuses that process rather than starting another.
  const again = await service.flashTask({ task: 'read another file', cwd: root, mode: 'read-only' })
  assert.equal(again.runtime.profile, 'flash-service-readonly')
  assert.deepEqual(clients.map((client) => client.profileName), ['flash-service', 'flash-service-readonly'])

  // An unknown mode is refused before any runtime is touched.
  await assert.rejects(
    () => service.flashTask({ task: 'x', cwd: root, mode: 'danger-full-access' }),
    (error) => error.code === 'MODE_UNAVAILABLE' && /read-only/.test(error.message),
  )
  await assert.rejects(() => service.flashBatch({ tasks: ['x'], cwd: root, mode: 'yolo' }), { code: 'MODE_UNAVAILABLE' })
  assert.deepEqual(clients.map((client) => client.profileName), ['flash-service', 'flash-service-readonly'])

  const batch = await service.flashBatch({ tasks: ['a', 'b'], cwd: root, mode: 'read-only' })
  assert.equal(batch.mode, 'read-only')
  assert.equal(batch.runtime.profile, 'flash-service-readonly')
  await service.close()
  assert.equal(clients.every((client) => client.running === false), true)
})

test('a worker refusal is reported per task, with the code the wall set', async () => {
  const { root, service } = makeService({ script: 'batch-denied' })
  const result = await service.flashBatch({ tasks: ['a', 'b', 'c'], cwd: root })

  assert.equal(result.status, 'ok')
  const denials = result.results[0].denials
  assert.equal(denials.length, 2)
  assert.deepEqual(denials.map((denial) => denial.code), ['FLASH_GUARD_DENIED', 'TOOL_ERROR'])
  assert.deepEqual(denials.map((denial) => denial.reason), ['PROTECTED_STATE', undefined])
  assert.deepEqual(denials.map((denial) => denial.index), [0, 0])
  assert.match(denials[0].message, /flash-guard denied write/)
  assert.match(denials[1].message, /Operation not permitted/)
  assert.equal(denials[0].childSessionId, result.results[0].childSessionId)
  // An ordinary tool failure is not a policy refusal, and a quiet task stays quiet.
  assert.equal(result.results[1].denials, undefined)
  assert.equal(result.results[2].denials, undefined)
  assert.equal(result.warnings, undefined)
})

test('a fleet shares one cwd and defaults acceptance to every task that lacks one', async () => {
  const { root, client, service } = makeService({ script: 'batch' })
  await service.flashBatch({ tasks: ['a', 'b'], cwd: root, acceptance: 'repo tests pass' })
  const { items } = promptArgs(client.prompts[0].text)
  assert.equal(items.length, 2)
  for (const item of items) {
    assert.match(item.prompt, new RegExp(`Working directory: ${service.root}`))
    assert.match(item.prompt, /Acceptance criteria:\nrepo tests pass/)
  }
  assert.deepEqual(items.map((item) => item.label), ['task-1', 'task-2'])
})

test('normalizes both task shapes and enforces the call ceiling', () => {
  assert.deepEqual(normalizeTasks(['do a thing'], 4), [{ task: 'do a thing', acceptance: undefined }])
  assert.deepEqual(normalizeTasks([{ task: 'x', acceptance: ' y ' }], 4), [{ task: 'x', acceptance: 'y' }])
  const rejects = (value, max, pattern) =>
    assert.throws(() => normalizeTasks(value, max), (error) => error instanceof FlashTaskError && pattern.test(error.message))
  rejects('not an array', 4, /must be an array/)
  rejects([], 4, /at least one task/)
  rejects(['a', 'b', 'c'], 2, /accepts at most 2 per call/)
  rejects([42], 4, /must be a string or an object/)
  rejects([null], 4, /must be a string or an object/)
  rejects([[]], 4, /must be a string or an object/)
  rejects([{ acceptance: 'x' }], 4, /tasks\[0\]\.task/)
  rejects([{ task: 'x', acceptance: 5 }], 4, /acceptance must be a string/)
  rejects(['   '], 4, /tasks\[0\] must be a non-empty string/)
})

test('reads the workflow return value and its header out of the rendered result', () => {
  const entries = [{ index: 0, ok: true, result: 'x' }]
  const rendered = `workflow "flash-batch" completed (2 agents).\nReturn value:\n${JSON.stringify(entries)}`
  assert.equal(looksLikeWorkflowResult(rendered), true)
  assert.equal(looksLikeWorkflowResult('workflow "x" completed (1 agent).'), false)
  // The marker is followed by the script's own value, which may be any JSON.
  assert.deepEqual(extractWorkflowValue(rendered).value, entries)
  assert.equal(extractWorkflowValue('workflow "x" completed (1 agent).\nReturn value:\n42').value, 42)
  assert.match(extractWorkflowValue('').error, /no result text/)
  assert.match(extractWorkflowValue('workflow "x" completed (1 agent).').error, /no return value/)
  assert.match(extractWorkflowValue('workflow "x" completed (1 agent).\nReturn value:\n').error, /was empty/)
  assert.match(extractWorkflowValue('workflow "x" completed (1 agent).\nReturn value:\n{truncated').error, /not readable JSON/)
  assert.deepEqual(parseWorkflowHeader(rendered), { name: 'flash-batch', agentsStarted: 2 })
  assert.deepEqual(parseWorkflowHeader('workflow "one" completed (1 agent).'), { name: 'one', agentsStarted: 1 })
  assert.deepEqual(parseWorkflowHeader('something else'), {})
})

test('reports observed fan-out, and warns when a fleet never ran in parallel', async () => {
  const parallelRun = makeService({ script: 'batch' })
  const parallel = await parallelRun.service.flashBatch({ tasks: ['a', 'b', 'c'], cwd: parallelRun.root })
  assert.equal(parallel.maxParallel, 3)
  assert.equal(parallel.warnings, undefined)

  const { root, service } = makeService({ script: 'batch-sequential' })
  const sequential = await service.flashBatch({ tasks: ['a', 'b', 'c'], cwd: root })
  assert.equal(sequential.status, 'ok')
  assert.equal(sequential.maxParallel, 1)
  assert.match(sequential.warnings.join('\n'), /never ran two workers at once \(peak concurrency 1\)/)

  // A single-task fleet is never accused of not being parallel.
  const singleRun = makeService({ script: 'batch-sequential' })
  const single = await singleRun.service.flashBatch({ tasks: ['only'], cwd: singleRun.root })
  assert.equal(single.maxParallel, 1)
  assert.equal(single.warnings, undefined)
})

test('the fleet script fans out through the engine hooks and keeps task order', () => {
  assert.match(BATCH_SCRIPT, /await parallel\(args\.items\.map/)
  assert.match(BATCH_SCRIPT, /await agent\(item\.prompt, \{ label: item\.label \}\)/)
  assert.match(BATCH_SCRIPT, /return settled\.map\(\(entry, index\) => entry \?\? \{ index, ok: false, result: null \}\)/)
  assert.doesNotMatch(BATCH_SCRIPT, /provider|model/, 'the script gains no route selector')
  assert.match(WORKER_RULES, /sandbox_permissions/)
})

test('the fleet prompt pins identity and asks for exactly one workflow call', () => {
  const prompt = buildBatchPrompt({ count: 2, script: 'return 1', args: { items: [] } })
  assert.match(prompt, /^You are a dispatcher\. Do exactly one thing and nothing else\./)
  assert.match(prompt, /"name":"flash-batch"/)
  assert.match(prompt, /reply with exactly: DELEGATED/)
  assert.ok(prompt.includes('<script>\nreturn 1\n</script>'))
  assert.ok(prompt.includes('<args>\n{"items":[]}\n</args>'))
  // Observed in a live run: the dispatcher relayed `args` as a *string*, the workflow
  // tool answered `"args" must be an object`, and the fleet never started. The prompt
  // therefore names the shape of each argument instead of only asking for a copy.
  assert.match(prompt, /passed as a JSON OBJECT/)
  assert.match(prompt, /objects, not text/)
})

// ── isolation: the worker gets a tree it is allowed to wreck ────────────────

test('a writing call runs in a disposable copy, not in the caller’s tree', async () => {
  const { root, client, service } = makeIsolatedService({ file: 'worker-output.txt' })
  const result = await service.flashTask({ task: 'write one file', cwd: root })

  assert.equal(result.isolation.mode, 'copy')
  assert.equal(result.isolation.slot, 0)
  assert.equal(result.change.available, true)
  assert.deepEqual(result.change.filesChanged, ['worker-output.txt'])
  assert.match(result.change.diff, /written by the worker/)
  assert.equal(result.change.applied, false)
  assert.equal(result.change.diffTruncated, false)
  assert.equal(typeof result.change.patchId, 'string')

  // The worker was told it is in a copy, and its runtime is rooted there.
  assert.match(client.prompts[0].text, /disposable copy of/)
  assert.match(client.prompts[0].text, /Use relative paths/)
  assert.notEqual(client.initializes[0].cwd, root)
  assert.match(client.initializes[0].cwd, /slots\/slot-0$/)

  // Nothing reached the caller's tree: the diff is the only way back.
  assert.equal(existsSync(join(root, 'worker-output.txt')), false)
  await service.close()
})

test('apply "auto" is the one path by which work reaches the caller', async () => {
  const { root, service } = makeIsolatedService({ file: 'auto.txt' })
  const result = await service.flashTask({ task: 'write one file', cwd: root, apply: 'auto' })
  assert.equal(result.change.applied, true)
  assert.equal(readFileSync(join(root, 'auto.txt'), 'utf8'), 'written by the worker\n')
  await service.close()
})

test('flash_apply applies a patch later, and a dry run only checks it', async () => {
  const { root, service } = makeIsolatedService({ file: 'later.txt' })
  const result = await service.flashTask({ task: 'write one file', cwd: root })
  assert.equal(existsSync(join(root, 'later.txt')), false)

  const checked = service.flashApply({ patchId: result.change.patchId, dryRun: true })
  assert.equal(checked.applied, false)
  assert.equal(existsSync(join(root, 'later.txt')), false)

  const applied = service.flashApply({ patchId: result.change.patchId })
  assert.equal(applied.applied, true)
  assert.equal(readFileSync(join(root, 'later.txt'), 'utf8'), 'written by the worker\n')
  await service.close()
})

test('a read-only call is not isolated: it cannot write, and it reads the caller’s tree', async () => {
  const { root, client, service } = makeIsolatedService({ file: 'never.txt' })
  const result = await service.flashTask({ task: 'read the README', cwd: root, mode: 'read-only' })
  assert.equal(result.mode, 'read-only')
  assert.equal(result.isolation.mode, 'none')
  assert.equal(result.isolation.slot, null)
  assert.equal(result.change, undefined)
  assert.equal(client.initializes[0].cwd, root)
  await service.close()
})

test('a patch is refused when the patch id is unknown, and apply needs isolation', async () => {
  const { root, service } = makeIsolatedService()
  assert.throws(() => service.flashApply({ patchId: 'flash-missing' }), (error) => error.code === 'APPLY_FAILED')
  await service.close()

  const plain = makeService()
  await assert.rejects(
    () => plain.service.flashTask({ task: 'x', cwd: plain.root, apply: 'auto' }),
    (error) => error.code === 'ISOLATION_DISABLED',
  )
  assert.throws(() => plain.service.flashApply({ patchId: 'flash-any' }), (error) => error.code === 'ISOLATION_DISABLED')
  await plain.service.close()
})

test('two concurrent calls get two different trees', async () => {
  const { root, client, service } = makeIsolatedService({ slots: 2 })
  const [first, second] = await Promise.all([
    service.flashTask({ task: 'first', cwd: root }),
    service.flashTask({ task: 'second', cwd: root }),
  ])
  assert.deepEqual([first.isolation.slot, second.isolation.slot].sort(), [0, 1])
  assert.equal(new Set(client.initializes.map((params) => params.cwd)).size, 2)
  assert.equal(existsSync(join(root, 'worker-output.txt')), false)
  await service.close()
})

test('a fleet is one call and therefore one tree', async () => {
  const { root, client, service } = makeIsolatedService({ slots: 2 })
  const result = await service.flashBatch({ tasks: ['one', 'two'], cwd: root, script: 'batch' })
  assert.equal(result.isolation.mode, 'copy')
  assert.equal(result.isolation.slot, 0)
  assert.equal(result.change.available, true)
  assert.equal(new Set(client.initializes.map((params) => params.cwd)).size, 1)
  await service.close()
})

test('one tree is one runtime, however many cwds a call names inside it', async () => {
  const { root, client, service } = makeIsolatedService({ slots: 2 })
  mkdirSync(join(root, 'packages', 'inner'), { recursive: true })
  writeFileSync(join(root, 'packages', 'inner', 'inner.txt'), 'inner\n')
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'sub'], { cwd: root })

  const first = await service.flashTask({ task: 'one', cwd: root })
  const second = await service.flashTask({ task: 'two', cwd: join(root, 'packages', 'inner') })

  // The sandbox root is fixed when a process starts, so keying a runtime on the
  // requested subdirectory started a process per directory that never exited. The
  // runtime is the tree; the subdirectory reaches the worker in the prompt instead.
  assert.equal(client.initializes.length, 1)
  assert.equal(first.runtime.pid, second.runtime.pid)
  assert.match(client.initializes[0].cwd, /slots\/slot-0$/)
  // Both prompts name the directory the caller asked for, inside the tree the worker got.
  assert.match(client.prompts[0].text, /Working directory: [^\n]*slots\/slot-0/)
  assert.match(client.prompts[1].text, /Working directory: [^\n]*packages\/inner/)
  await service.close()
})

test('the runtime keeps the platform TMPDIR, and the worker is told about .flash-tmp', async () => {
  const { root, client, service } = makeIsolatedService()
  await service.flashTask({ task: 'write one file', cwd: root })
  // The sandbox's writable roots are derived from the runtime's own TMPDIR. Narrowing it
  // to the tree withdrew the platform temp area from that grant, and toolchains that
  // reach it directly — the Swift toolchain does — failed with EPERM inside their own
  // scratch files while `touch` in the same directory succeeded. So the environment
  // the runtime boots with is left alone, apart from the one variable that says which
  // model this process serves.
  assert.deepEqual(client.extraEnv, { FLASH_ROUTE_MODEL: 'deepseek-v4.1-flash:cloud' })
  // The tree still has a scratch directory of its own (created by `prepare`, see the
  // isolation tests), and the worker learns of it in the prompt rather than through the
  // environment.
  assert.match(client.prompts[0].text, /\.flash-tmp/)
  await service.close()
})

test('a timed-out isolated call reports what its tree held, retires the tree, and stops its runtime', async () => {
  const { root, client, service } = makeIsolatedService({ slots: 1, script: 'silent', taskTimeoutMs: 100 })
  const original = service.isolation.slots[0].dir
  const error = await service.flashTask({ task: 'never finishes', cwd: root }).catch((caught) => caught)
  assert.equal(error.code, 'TIMEOUT')
  // The session cannot be stopped, so the caller is told what the tree held when the
  // budget ran out instead of just "timeout": the silent fake had written its one file
  // before going quiet, and that file is stored as a patch the caller can still apply.
  assert.match(error.message, /exceeded its 100ms budget/)
  const stored = /stored as patch (flash-[0-9a-f-]+): 1 file changed, 1 insertion/.exec(error.message)
  assert.ok(stored, `expected a stored patch in: ${error.message}`)
  assert.ok(service.isolation.patches.has(stored[1]), 'the salvaged patch is kept for flash_apply')

  // The orphaned tree keeps its name and stays put: the session (and any build process it
  // spawned) holds that path as an absolute string, so renaming it away only sent its
  // late writes to the empty directory left at the old name. The slot moves instead.
  const slot = service.isolation.slots[0]
  assert.notEqual(slot.dir, original, 'the slot must move to a path it has never used')
  assert.equal(existsSync(original), true, 'the orphaned tree must stay at its original path')
  assert.equal(readFileSync(join(original, 'worker-output.txt'), 'utf8'), 'written by the worker\n')
  assert.deepEqual(readdirSync(slot.dir), [], 'the slot’s new directory starts empty')
  assert.deepEqual(slot.orphans, [original], 'the orphan is remembered so close() can remove it')

  // A runtime is keyed by the tree it was rooted at, so the runtime that ran the timed-out
  // session is the one for the old directory; it is shut down, which is the only
  // cancellation the service has. The new directory then boots a runtime of its own.
  assert.ok(client.shutdownCwds.includes(original), `expected a shutdown of ${original}, got ${JSON.stringify(client.shutdownCwds)}`)
  client.script = defaultScript
  await service.flashTask({ task: 'write one file', cwd: root })
  assert.equal(client.initializes.length, 2, 'the new tree gets a fresh runtime')
  assert.equal(client.initializes[1].cwd, slot.dir)
  await service.close()
})

test('a client-cancelled isolated call salvages its change and retires the tree like a timeout', async () => {
  const { root, client, service } = makeIsolatedService({ slots: 1, script: 'silent', taskTimeoutMs: 10_000 })
  const original = service.isolation.slots[0].dir
  const controller = new AbortController()
  const pending = service.flashTask({ task: 'never finishes', cwd: root }, { signal: controller.signal })
  // Let the call lease, prepare the tree, and start its session; the silent fake has
  // already written its one file before going quiet, so there is a change to salvage.
  await new Promise((resolve) => setTimeout(resolve, 50))
  controller.abort()
  const error = await pending.catch((caught) => caught)

  // A cancellation orphans the session exactly as a timeout does: the SDK cannot stop
  // it, so the work so far is stored and the tree is retired rather than recycled.
  assert.equal(error.code, 'CANCELLED')
  const stored = /stored as patch (flash-[0-9a-f-]+): 1 file changed, 1 insertion/.exec(error.message)
  assert.ok(stored, `expected a stored patch in: ${error.message}`)
  assert.ok(service.isolation.patches.has(stored[1]), 'the salvaged patch is kept for flash_apply')

  const slot = service.isolation.slots[0]
  assert.notEqual(slot.dir, original, 'the slot must move to a path it has never used')
  assert.equal(existsSync(original), true, 'the orphaned tree must stay at its original path')
  assert.equal(readFileSync(join(original, 'worker-output.txt'), 'utf8'), 'written by the worker\n')
  assert.deepEqual(slot.orphans, [original], 'the orphan is remembered so close() can remove it')
  assert.ok(client.shutdownCwds.includes(original), `expected a shutdown of ${original}, got ${JSON.stringify(client.shutdownCwds)}`)
  await service.close()
})

test('a client-cancelled fleet salvages its one tree too', async () => {
  const { root, service } = makeIsolatedService({ slots: 1, script: 'silent' })
  const original = service.isolation.slots[0].dir
  const controller = new AbortController()
  const pending = service.flashBatch({ tasks: ['a'], cwd: root }, { signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, 50))
  controller.abort()
  const error = await pending.catch((caught) => caught)

  assert.equal(error.code, 'CANCELLED')
  assert.ok(service.isolation.patches.size > 0, 'the fleet change must be stored as a patch')
  assert.deepEqual(service.isolation.slots[0].orphans, [original])
  await service.close()
})

test('a call cancelled while it waits for a tree never copies the repository', async () => {
  const { root, client, service } = makeIsolatedService({ slots: 1, script: 'silent', taskTimeoutMs: 400 })
  const holding = service.flashTask({ task: 'hold the only tree', cwd: root }).catch((error) => error)
  await new Promise((resolve) => setTimeout(resolve, 50))

  const controller = new AbortController()
  const queued = service.flashTask({ task: 'queued', cwd: root }, { signal: controller.signal })
  controller.abort()
  const cancelled = await queued.catch((error) => error)
  assert.equal(cancelled.code, 'CANCELLED')
  assert.match(cancelled.message, /cancelled while waiting/)

  // Nothing was prepared for the cancelled call: it never reached the copy, so there
  // is no change to salvage and no tree to retire.
  assert.equal(client.initializes.length, 1)
  assert.equal(service.isolation.patches.size, 0)
  const waitingSlot = service.isolation.slots[0].dir
  await holding
  assert.equal(service.isolation.patches.size > 0, true, 'the holder still salvages its own timeout')
  assert.notEqual(service.isolation.slots[0].dir, waitingSlot)
  await service.close()
})

test('a patch that was applied is refused as already applied', async () => {
  const { root, service } = makeIsolatedService()
  const result = await service.flashTask({ task: 'write one file', cwd: root, apply: 'auto' })
  assert.equal(result.change.applied, true)
  assert.throws(
    () => service.flashApply({ patchId: result.change.patchId }),
    (error) => error.code === 'APPLY_FAILED' && /already applied/.test(error.message),
  )
  // `force` bypasses the bookkeeping, not git: what git then decides is git's business,
  // but it is no longer the recorded-apply refusal.
  let forced
  try {
    forced = service.flashApply({ patchId: result.change.patchId, force: true })
  } catch (error) {
    forced = error
  }
  assert.equal(forced instanceof Error ? /already applied/.test(forced.message) : false, false)
  await service.close()
})

test('a finished call empties its tree once the patch is stored, and keeps one it could not collect', async () => {
  const { root, client, service } = makeIsolatedService({ slots: 1 })
  const result = await service.flashTask({ task: 'write one file', cwd: root })
  const tree = service.isolation.slots[0].dir
  // An idle server used to hold a full copy, build output included, per slot.
  assert.equal(result.change.available, true)
  assert.deepEqual(readdirSync(tree), [])
  service.isolation.apply({ patchId: result.change.patchId })
  assert.equal(readFileSync(join(root, client.writes), 'utf8'), 'written by the worker\n')
  await service.close()

  // Without git there is no patch, and the tree is the only place the work exists.
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'flash-mcp-plain-')))
  writeFileSync(join(plain, 'README.md'), '# not a repository\n')
  const logs = []
  const other = makeIsolatedService({ slots: 1, root: plain, log: (line) => logs.push(line) })
  const kept = await other.service.flashTask({ task: 'write one file', cwd: plain })
  assert.equal(kept.change.available, false)
  assert.equal(existsSync(join(other.service.isolation.slots[0].dir, other.client.writes)), true)
  assert.ok(logs.some((line) => /kept .* could not be collected/.test(line)), 'the kept tree is named in the log')
  await other.service.close()
})
