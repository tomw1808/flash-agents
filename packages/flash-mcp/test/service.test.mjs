/**
 * Service tests: one fresh session per call, a compact result, and a hard fence
 * around the workspace. The runtime is faked, so nothing here needs Harness.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BATCH_SCRIPT,
  FlashTaskService,
  FlashTaskError,
  WORKER_RULES,
  buildBatchPrompt,
  buildChildPrompt,
  buildOrchestrationPrompt,
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
    this.prompts = []
    this.notificationHandlers = new Set()
    this.exitHandlers = new Set()
    this.diagnostics = ''
  }

  start() {
    this.starts += 1
    this.running = true
    return this.pid
  }

  async initialize(params) {
    this.initializes.push(params)
    return { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' }
  }

  async prompt({ sessionId, text }) {
    this.prompts.push({ sessionId, text })
    queueMicrotask(() => this.#replay(sessionId, text))
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

  #replay(sessionId, text) {
    const script = this.script
    const childSessionId = `child-${sessionId}`
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
            data: { header: { config: { provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' } } },
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
        result: `fleet result ${String(index)} from ${String(item.label)}`,
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
          data: { header: { config: { provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' } } },
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
        lastAssistantMessage: [{ type: 'text', text: `worker result ${String(index)}\n${text.slice(0, 10)}` }],
      })
    }
    this.emit('session.status', { sessionId, status: 'idle' })
  }
}

function defaultScript() {
  return 'ok'
}

/** A service rooted at a fresh temporary directory. */
function makeService({ script, ...overrides } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flash-mcp-test-'))
  const client = new FakeSdkClient({ script })
  const service = new FlashTaskService({
    root,
    clientFactory: () => client,
    log: () => {},
    ...overrides,
  })
  return { root, client, service }
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
    'mode',
    'provider',
    'result',
    'resultTruncated',
    'route',
    'runtime',
    'sessionId',
    'status',
    'stopReason',
  ])
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

test('pins the route regardless of caller-supplied selection', async () => {
  const { root, client, service } = makeService()
  const result = await service.flashTask({
    task: 'x',
    cwd: root,
    provider: 'deepseek-official',
    model: 'gpt-5',
    sandbox: 'danger-full-access',
  })
  assert.deepEqual(result.route, { provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' })
  assert.deepEqual(client.initializes[0].provider, 'ollama')
  assert.deepEqual(client.initializes[0].model, 'deepseek-v4.1-flash:cloud')
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
  assert.equal(child, 'Working directory: /w\nTask:\ndo it\n\nAcceptance criteria:\ndone')
  const prompt = buildOrchestrationPrompt(child)
  assert.match(prompt, /<<<TASK\nWorking directory: \/w/)
  assert.match(prompt, /TASK$/)
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
})
