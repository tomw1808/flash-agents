/**
 * MCP framing and dispatch tests: a byte-stream connection with a stub tool.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'

import { serveStdio } from '../lib/mcp.js'

/** Drive one connection and collect the frames it writes. */
function connect({ callTool } = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  output.setEncoding('utf8')
  const frames = []
  let buffer = ''
  output.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim() !== '') frames.push(JSON.parse(line))
    }
  })
  const connection = serveStdio({
    serverInfo: { name: 'flash-mcp', version: 'test' },
    instructions: 'test instructions',
    listTools: () => [
      { name: 'flash_task', description: 'd', inputSchema: { type: 'object', properties: {}, required: [] } },
    ],
    callTool: callTool ?? (async () => ({ content: [{ type: 'text', text: 'ok' }] })),
    input,
    output,
    log: () => {},
  })
  return { input, frames, connection, send: (message) => input.write(`${JSON.stringify(message)}\n`) }
}

/** Wait until the predicate sees enough frames. */
async function settle(frames, count) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (frames.length >= count) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`expected ${String(count)} frames, saw ${String(frames.length)}`)
}

test('handshakes, lists tools, and calls one', async () => {
  const { frames, send, connection } = connect()
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
  await settle(frames, 1)
  assert.equal(frames[0].id, 1)
  assert.equal(frames[0].result.protocolVersion, '2025-06-18')
  assert.equal(frames[0].result.serverInfo.name, 'flash-mcp')
  assert.deepEqual(frames[0].result.capabilities, { tools: { listChanged: false } })
  assert.equal(frames[0].result.instructions, 'test instructions')

  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  await settle(frames, 2)
  assert.equal(frames[1].result.tools[0].name, 'flash_task')

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'flash_task', arguments: { task: 'x' } } })
  await settle(frames, 3)
  assert.equal(frames[2].result.content[0].text, 'ok')
  connection.close()
})

test('negotiates an older known revision and falls back for an unknown one', async () => {
  const { frames, send, connection } = connect()
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
  await settle(frames, 1)
  assert.equal(frames[0].result.protocolVersion, '2024-11-05')

  const second = connect()
  second.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
  await settle(second.frames, 1)
  assert.equal(second.frames[0].result.protocolVersion, '2025-06-18')
  connection.close()
  second.connection.close()
})

test('refuses business requests before initialize and unknown methods after', async () => {
  const { frames, send, connection } = connect()
  send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  await settle(frames, 1)
  assert.equal(frames[0].error.code, -32002)

  send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  send({ jsonrpc: '2.0', id: 3, method: 'resources/list' })
  await settle(frames, 3)
  assert.equal(frames[2].error.code, -32601)
  connection.close()
})

test('reports an unknown tool as a tool error, not a protocol error', async () => {
  const { frames, send, connection } = connect()
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope', arguments: {} } })
  await settle(frames, 2)
  assert.equal(frames[1].result.isError, true)
  assert.match(frames[1].result.content[0].text, /unknown tool "nope"/)
  connection.close()
})

test('never answers a notification', async () => {
  const { frames, send, connection } = connect()
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  await settle(frames, 1)
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })
  send({ jsonrpc: '2.0', id: 5, method: 'ping' })
  await settle(frames, 2)
  assert.equal(frames.length, 2)
  assert.equal(frames[1].id, 5)
  connection.close()
})

test('aborts an in-flight tool call when the client cancels it', async () => {
  const seen = []
  const { frames, send, connection } = connect({
    async callTool(name, args, { signal }) {
      seen.push(signal)
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        setTimeout(resolve, 1_000)
      })
      return { content: [{ type: 'text', text: 'late' }] }
    },
  })
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'flash_task', arguments: {} } })
  await settle(frames, 1)
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } })
  await settle(frames, 2)
  assert.equal(seen[0].aborted, true)
  assert.equal(frames[1].error.code, -32800)
  connection.close()
})

test('closes on input end without answering', async () => {
  const { input, frames, connection } = connect()
  input.end()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(frames.length, 0)
  connection.close()
})
