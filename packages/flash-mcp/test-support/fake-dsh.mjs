#!/usr/bin/env node
/**
 * A stand-in for `dsh --profile <id>` that speaks the SDK stdio JSON-RPC
 * protocol, so the MCP server and its SDK client can be tested end to end
 * without booting Harness.
 *
 * It answers `initialize` and `session/prompt`, replays one delegated child per
 * prompt (status, child route, start, finish), and exits on `shutdown`.
 * Prompts whose text contains `NO-DELEGATE` finish without a child; prompts
 * carrying an `<args>` block are treated as a fleet dispatch and replay one
 * workflow run over the items they name, with `NO-WORKFLOW-VALUE` suppressing
 * the readable return value.
 *
 * Usage: node fake-dsh.mjs --profile <id> [more args...]
 */

const args = process.argv.slice(2)
const profileIndex = args.indexOf('--profile')
const profile = profileIndex < 0 ? undefined : args[profileIndex + 1]
process.stderr.write(`fake-dsh: booted with profile ${String(profile)}\n`)

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

/** Sessions this process has created, keyed by id. */
const sessions = new Map()
let counter = 0

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

function handlePrompt(id, params) {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string') {
    fail(id, -32602, 'session/prompt requires a sessionId')
    return
  }
  const text = (params.contentBlocks ?? []).map((block) => block?.text ?? '').join('\n')
  const fresh = !sessions.has(sessionId)
  sessions.set(sessionId, text)
  reply(id, { messageId: `message-${String(++counter)}` })

  queueMicrotask(() => {
    const batch = extractFleetArgs(text)
    if (batch !== null) {
      notify('session.status', { sessionId, status: 'running' })
      const items = Array.isArray(batch.items) ? batch.items : []
      // Every member starts before any finishes: a real fan-out.
      for (const [index] of items.entries()) {
        notify('subagent.started', { parentSessionId: sessionId, childSessionId: `child-${sessionId}-${String(index)}` })
      }
      for (const [index] of items.entries()) {
        notify('session.event', {
          sessionId: `child-${sessionId}-${String(index)}`,
          event: {
            type: 'request/header',
            seq: 1,
            time: Date.now(),
            data: { header: { config: { provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' } } },
          },
        })
      }
      for (const [index] of items.entries()) {
        notify('subagent.finished', {
          provider: 'flash',
          agentId: `agent-${String(index)}`,
          parentSessionId: sessionId,
          childSessionId: `child-${sessionId}-${String(index)}`,
          status: 'ok',
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: `fake worker ${String(index)}` }],
        })
      }
      for (const [index] of items.entries()) {
        notify('session.event', {
          sessionId,
          event: { type: 'tool-workflow/agent-start', seq: 2, time: Date.now(), data: { runId: 'run-fake', seq: index + 1, label: `task-${String(index + 1)}`, childId: `child-${sessionId}-${String(index)}` } },
        })
        notify('session.event', {
          sessionId,
          event: { type: 'tool-workflow/agent-end', seq: 2, time: Date.now(), data: { runId: 'run-fake', seq: index + 1, outcome: 'completed' } },
        })
      }
      const entries = items.map((item, index) => ({ index, ok: true, result: `fleet ${String(index)} (${String(item.label)})` }))
      const envelope = text.includes('NO-WORKFLOW-VALUE')
        ? 'workflow "flash-batch" completed (n agents).\nthe value never made it into the render'
        : `workflow "flash-batch" completed (${String(items.length)} agents).\nReturn value:\n${JSON.stringify(entries)}`
      notify('session.event', {
        sessionId,
        event: { type: 'tool-workflow/run-start', seq: 2, time: Date.now(), data: { runId: 'run-fake', name: 'flash-batch' } },
      })
      notify('session.event', {
        sessionId,
        event: {
          type: 'tool/result',
          seq: 3,
          time: Date.now(),
          data: {
            turn: 1,
            step: 1,
            message: {
              source: { kind: 'tool', callId: 'call-fake' },
              content: [{ type: 'tool-result', toolCallId: 'call-fake', content: [{ type: 'text', text: envelope }] }],
            },
          },
        },
      })
      notify('session.status', { sessionId, status: 'idle' })
      return
    }
    notify('session.status', { sessionId, status: 'running' })
    if (text.includes('NO-DELEGATE')) {
      notify('session.event', {
        sessionId,
        event: { type: 'assistant/message', seq: 2, time: Date.now(), data: { message: { content: [{ type: 'text', text: 'I will not delegate.' }] } } },
      })
      notify('session.status', { sessionId, status: 'idle' })
      return
    }
    const childSessionId = `child-${sessionId}`
    notify('subagent.started', { parentSessionId: sessionId, childSessionId })
    notify('session.event', {
      sessionId: childSessionId,
      event: {
        type: 'request/header',
        seq: 1,
        time: Date.now(),
        data: { header: { config: { provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' } } },
      },
    })
    notify('subagent.finished', {
      provider: 'flash',
      agentId: `agent-${sessionId}`,
      parentSessionId: sessionId,
      childSessionId,
      status: 'ok',
      stopReason: 'completed',
      lastAssistantMessage: [
        { type: 'text', text: `fake worker handled ${String(text.length)} chars${fresh ? ' in a fresh session' : ''}` },
      ],
    })
    notify('session.status', { sessionId, status: 'idle' })
  })
}

/** Read the fleet payload out of a dispatch prompt, or null for a single task. */
function extractFleetArgs(text) {
  const start = text.indexOf('<args>\n')
  const end = text.indexOf('\n</args>')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start + '<args>\n'.length, end))
  } catch {
    return null
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\n')
    if (index < 0) break
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line === '') continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      reply(message.id, { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } })
    } else if (message.method === 'session/prompt') {
      handlePrompt(message.id, message.params)
    } else if (message.method === 'shutdown') {
      reply(message.id, {})
      process.exit(0)
    } else {
      fail(message.id, -32601, `fake-dsh: unknown method ${String(message.method)}`)
    }
  }
})
process.stdin.on('end', () => process.exit(0))
