/**
 * Token accounting: a call's result carries what its own turn and its workers spent,
 * so the orchestrating agent can weigh delegating against doing the work itself.
 *
 * The runtime is faked, and every fixture here invents the usage object the Harness
 * documents (`{inputTokens, outputTokens, totalTokens?, cacheReadTokens?, …}`). What
 * the repository does not fix is which event carries it, so these tests pin the
 * assumption the service documents: one usage object is one model response, a response
 * is de-duplicated by its id, and an id-less response counts only from the event that
 * marks a completed assistant message.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FlashTaskService } from '../lib/service.js'

/** One session event carrying a usage object, shaped the way `observe` reads them. */
function usageEvent(sessionId, type, usage, data = {}) {
  return { sessionId, event: { type, data: { ...data, usage } } }
}

/** A completed assistant message, which is where a response's usage is expected. */
function responseEvent(sessionId, usage, id) {
  return usageEvent(sessionId, 'assistant/message', usage, id === undefined ? { message: { content: [] } } : { message: { id, content: [] } })
}

/** A runtime stand-in that replays one caller-supplied script per prompt. */
class UsageClient {
  constructor(replay) {
    this.replay = replay
    this.pid = 7
    this.running = false
    this.starts = 0
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

  async initialize() {
    return { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' }
  }

  async prompt({ sessionId, text }) {
    this.prompts.push({ sessionId, text })
    queueMicrotask(() => this.replay({ sessionId, text, emit: (method, params) => this.emit(method, params) }))
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

/** A service rooted at a fresh temporary directory, running one faked script. */
function makeService(replay, { log = () => {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flash-usage-'))
  const client = new UsageClient(replay)
  const service = new FlashTaskService({
    root,
    clientFactory: () => client,
    log,
    // Accounting is independent of the tree, so these tests run in place.
    isolate: { mode: 'none' },
  })
  return { root, client, service }
}

/** A single delegating worker, with the supplied events before it finishes. */
function singleTaskReplay(events) {
  return ({ sessionId, emit }) => {
    emit('session.status', { sessionId, status: 'running' })
    const childSessionId = `child-${sessionId}`
    emit('subagent.started', { parentSessionId: sessionId, childSessionId })
    for (const [session, event] of events(sessionId, childSessionId)) emit('session.event', { sessionId: session, event })
    emit('subagent.finished', {
      parentSessionId: sessionId,
      childSessionId,
      status: 'ok',
      stopReason: 'completed',
      provider: 'flash',
      lastAssistantMessage: [{ type: 'text', text: 'done' }],
    })
    emit('session.status', { sessionId, status: 'idle' })
  }
}

test('sums input and output over several responses and counts each model call', async () => {
  const replay = singleTaskReplay((sessionId, childSessionId) => [
    [sessionId, responseEvent(sessionId, { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 5 }, 'r1').event],
    [childSessionId, responseEvent(childSessionId, { inputTokens: 50, outputTokens: 10, reasoningTokens: 7 }, 'r2').event],
  ])
  const { root, service } = makeService(replay)
  const result = await service.flashTask({ task: 'work', cwd: root })

  // A response with no totalTokens makes the whole call fall back to input + output:
  // summing the one reported total would understate it.
  assert.deepEqual(result.usage, {
    inputTokens: 150,
    outputTokens: 30,
    totalTokens: 180,
    modelCalls: 2,
    cacheReadTokens: 5,
    reasoningTokens: 7,
  })
  assert.equal('cacheWriteTokens' in result.usage, false)
})

test('uses the reported totals only when every response reported one', async () => {
  const replay = singleTaskReplay((sessionId) => [
    [sessionId, responseEvent(sessionId, { inputTokens: 100, outputTokens: 20, totalTokens: 111 }, 'r1').event],
    [sessionId, responseEvent(sessionId, { inputTokens: 50, outputTokens: 10, totalTokens: 99 }, 'r2').event],
  ])
  const { root, service } = makeService(replay)
  const result = await service.flashTask({ task: 'work', cwd: root })

  assert.deepEqual(result.usage, {
    inputTokens: 150,
    outputTokens: 30,
    totalTokens: 210,
    modelCalls: 2,
  })
})

test('does not double count one response reported by a streaming update and a final message', async () => {
  const replay = singleTaskReplay((sessionId) => [
    [sessionId, usageEvent(sessionId, 'llm/chunk', { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, { messageId: 'r1' }).event],
    [sessionId, responseEvent(sessionId, { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, 'r1').event],
  ])
  const { root, service } = makeService(replay)
  const result = await service.flashTask({ task: 'work', cwd: root })

  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20, totalTokens: 120, modelCalls: 1 })
})

test('ignores an id-less event that is not a completed assistant message', async () => {
  const replay = singleTaskReplay((sessionId) => [
    [sessionId, usageEvent(sessionId, 'llm/chunk', { inputTokens: 999, outputTokens: 999 }).event],
    [sessionId, responseEvent(sessionId, { inputTokens: 10, outputTokens: 2 }).event],
  ])
  const { root, service } = makeService(replay)
  const result = await service.flashTask({ task: 'work', cwd: root })

  // The chunk could be an update of the very response the message marks, so only the
  // completed message is counted.
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 2, totalTokens: 12, modelCalls: 1 })
})

test('omits usage entirely when no event reported any', async () => {
  const { root, service } = makeService(singleTaskReplay(() => []))
  const result = await service.flashTask({ task: 'work', cwd: root })

  assert.equal(result.usage, undefined)
  assert.equal('usage' in result, false)
})

test('appends the token totals to the line a finished call logs', async () => {
  const logs = []
  const replay = singleTaskReplay((sessionId) => [
    [sessionId, responseEvent(sessionId, { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, 'r1').event],
  ])
  const { root, service } = makeService(replay, { log: (line) => logs.push(line) })
  await service.flashTask({ task: 'work', cwd: root })

  assert.ok(
    logs.some((line) => /session idle \(100 in \/ 20 out tokens, 1 model call\(s\)\)/.test(line)),
    `the finish line names the spend; saw: ${JSON.stringify(logs)}`,
  )
})

test('a fleet reports a top-level total and attributes each member to its task', async () => {
  const replay = ({ sessionId, emit }) => {
    emit('session.status', { sessionId, status: 'running' })
    const childId = (index) => `child-${sessionId}-${String(index)}`
    for (let index = 0; index < 3; index += 1) {
      emit('subagent.started', { parentSessionId: sessionId, childSessionId: childId(index) })
    }
    // The dispatcher's own turn, then one response per worker.
    emit('session.event', { sessionId, event: responseEvent(sessionId, { inputTokens: 10, outputTokens: 1, totalTokens: 11 }, 'p1').event })
    for (let index = 0; index < 3; index += 1) {
      const input = 100 * (index + 1)
      emit('session.event', { sessionId: childId(index), event: responseEvent(childId(index), { inputTokens: input, outputTokens: 5, totalTokens: input + 5 }, `w${String(index)}`).event })
    }
    for (let index = 0; index < 3; index += 1) {
      emit('subagent.finished', {
        parentSessionId: sessionId,
        childSessionId: childId(index),
        status: 'ok',
        stopReason: 'completed',
        provider: 'flash',
        lastAssistantMessage: [{ type: 'text', text: `worker ${String(index)}` }],
      })
    }
    for (let index = 0; index < 3; index += 1) {
      emit('session.event', {
        sessionId,
        event: { type: 'tool-workflow/agent-start', data: { runId: 'run-1', seq: index + 1, label: `task-${String(index + 1)}`, childId: childId(index) } },
      })
    }
    const entries = [0, 1, 2].map((index) => ({ index, ok: true, result: `fleet ${String(index)}` }))
    emit('session.event', { sessionId, event: { type: 'tool-workflow/run-start', data: { runId: 'run-1', name: 'flash-batch' } } })
    emit('session.event', {
      sessionId,
      event: {
        type: 'tool/result',
        data: {
          message: {
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call-1',
                content: [{ type: 'text', text: `workflow "flash-batch" completed (3 agents).\nReturn value:\n${JSON.stringify(entries)}` }],
              },
            ],
          },
        },
      },
    })
    emit('session.event', { sessionId, event: { type: 'tool-workflow/run-end', data: { runId: 'run-1', stopReason: 'completed' } } })
    emit('session.status', { sessionId, status: 'idle' })
  }
  const { root, service } = makeService(replay)
  const result = await service.flashBatch({ tasks: ['one', 'two', 'three'], cwd: root })

  // 11 (dispatcher) + 105 + 205 + 305, every response reporting its own total.
  assert.deepEqual(result.usage, { inputTokens: 610, outputTokens: 16, totalTokens: 626, modelCalls: 4 })
  assert.deepEqual(result.results.map((entry) => entry.usage), [
    { inputTokens: 100, outputTokens: 5, totalTokens: 105, modelCalls: 1 },
    { inputTokens: 200, outputTokens: 5, totalTokens: 205, modelCalls: 1 },
    { inputTokens: 300, outputTokens: 5, totalTokens: 305, modelCalls: 1 },
  ])
})

test('a fleet with no label mapping reports only the total, never a per-task guess', async () => {
  const replay = ({ sessionId, emit }) => {
    emit('session.status', { sessionId, status: 'running' })
    const childId = (index) => `child-${sessionId}-${String(index)}`
    for (let index = 0; index < 2; index += 1) {
      emit('subagent.started', { parentSessionId: sessionId, childSessionId: childId(index) })
      emit('session.event', { sessionId: childId(index), event: responseEvent(childId(index), { inputTokens: 40, outputTokens: 2, totalTokens: 42 }, `w${String(index)}`).event })
      emit('subagent.finished', {
        parentSessionId: sessionId,
        childSessionId: childId(index),
        status: 'ok',
        stopReason: 'completed',
        provider: 'flash',
        lastAssistantMessage: [{ type: 'text', text: `worker ${String(index)}` }],
      })
    }
    const entries = [0, 1].map((index) => ({ index, ok: true, result: `fleet ${String(index)}` }))
    emit('session.event', {
      sessionId,
      event: { type: 'tool/result', data: { message: { content: [{ type: 'text', text: `workflow "flash-batch" completed (2 agents).\nReturn value:\n${JSON.stringify(entries)}` }] } } },
    })
    emit('session.status', { sessionId, status: 'idle' })
  }
  const { root, service } = makeService(replay)
  const result = await service.flashBatch({ tasks: ['one', 'two'], cwd: root })

  // Without an agent-start label the member-to-task pairing is unknowable, so the
  // fleet keeps the total and gives no task a share it cannot prove.
  assert.deepEqual(result.usage, { inputTokens: 80, outputTokens: 4, totalTokens: 84, modelCalls: 2 })
  assert.deepEqual(result.results.map((entry) => entry.usage), [undefined, undefined])
})

test('a usage object with no recognised token field is not counted as a model call', async () => {
  const replay = singleTaskReplay((sessionId) => [
    [sessionId, responseEvent(sessionId, {}, 'r1').event],
    [sessionId, responseEvent(sessionId, { promptTokens: 5 }, 'r2').event],
    [sessionId, responseEvent(sessionId, { inputTokens: 4, outputTokens: 1 }, 'r3').event],
  ])
  const { root, service } = makeService(replay)
  const result = await service.flashTask({ task: 'work', cwd: root })

  // An empty object and a provider spelling this service does not read say nothing about a
  // response, so they must not become `{inputTokens: 0, outputTokens: 0, modelCalls: 1}`.
  // Only the third response is a model call.
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 1, totalTokens: 5, modelCalls: 1 })
})

test('two concurrent calls sharing a runtime count only their own workers’ tokens', async () => {
  const replay = ({ sessionId, emit }) => {
    emit('session.status', { sessionId, status: 'running' })
    const child = `child-${sessionId}`
    // Every call's workflow engine labels its first member `task-1`, and the notification is
    // broadcast to every observer on the shared runtime, so without a session gate each call
    // would adopt the other's child.
    emit('session.event', {
      sessionId,
      event: { type: 'tool-workflow/agent-start', data: { label: 'task-1', childId: child, seq: 1, runId: 'run' } },
    })
    emit('session.event', {
      sessionId: child,
      event: responseEvent(child, { inputTokens: 10, outputTokens: 1, totalTokens: 11 }, `w-${child}`).event,
    })
    emit('subagent.finished', {
      parentSessionId: sessionId,
      childSessionId: child,
      status: 'ok',
      stopReason: 'completed',
      provider: 'flash',
      lastAssistantMessage: [{ type: 'text', text: 'done' }],
    })
    emit('session.status', { sessionId, status: 'idle' })
  }
  const { root, service } = makeService(replay)
  const [a, b] = await Promise.all([
    service.flashTask({ task: 'a', cwd: root }),
    service.flashTask({ task: 'b', cwd: root }),
  ])

  // Each call counts exactly its own 11 tokens, not both workers' 22.
  assert.deepEqual(a.usage, { inputTokens: 10, outputTokens: 1, totalTokens: 11, modelCalls: 1 })
  assert.deepEqual(b.usage, { inputTokens: 10, outputTokens: 1, totalTokens: 11, modelCalls: 1 })
})
