/**
 * Whole-pipeline tests: MCP client frames in, SDK frames out to a stand-in
 * Harness process, compact result back. No Harness and no LLM are involved, so
 * the wiring — lazy boot, one persistent process, a fresh session per call,
 * route observation, result projection — is covered on every run.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'

import { startServer } from '../lib/index.js'
import { HarnessSdkClient, resolveDshCommand } from '../lib/sdk.js'

const FAKE_DSH = resolve(import.meta.dirname, '..', 'test-support', 'fake-dsh.mjs')

/** A running server plus a frame-level MCP client over it. */
async function connect({ env = {}, root } = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  output.setEncoding('utf8')
  const logs = []
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
  const cwd = root ?? mkdtempSync(join(tmpdir(), 'flash-mcp-integration-'))
  const server = startServer(
    {
      root: cwd,
      profile: 'flash-service',
      provider: 'ollama',
      model: 'deepseek-v4.1-flash:cloud',
      taskTimeoutMs: 10_000,
      env: { ...process.env, FLASH_DSH_BIN: FAKE_DSH, ...env },
    },
    input,
    output,
  )
  const send = (message) => input.write(`${JSON.stringify(message)}\n`)
  const settle = async (count) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (frames.length >= count) return frames[count - 1]
      await new Promise((resolveTick) => setTimeout(resolveTick, 5))
    }
    throw new Error(`expected ${String(count)} frames, saw ${String(frames.length)}`)
  }
  let nextId = 0
  const request = async (method, params) => {
    const id = ++nextId
    send({ jsonrpc: '2.0', id, method, params })
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const frame = frames.find((candidate) => candidate.id === id)
      if (frame !== undefined) return frame
      await new Promise((resolveTick) => setTimeout(resolveTick, 5))
    }
    throw new Error(`no response for request ${String(id)} (${method}); frames seen: ${JSON.stringify(frames)}`)
  }
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const call = async (name, args) => {
    const frame = await request('tools/call', { name, arguments: args })
    const text = frame.result.content[0].text
    return { frame, payload: frame.result.isError === true ? { error: text } : JSON.parse(text) }
  }
  return { server, call, frames, logs, send, request, cwd }
}

test('runs a task through the whole pipeline and reuses one runtime process', async () => {
  const { server, call, cwd } = await connect()
  try {
    const first = await call('flash_task', { task: 'read the README', cwd, acceptance: 'a summary' })
    assert.equal(first.frame.result.isError, undefined)
    assert.equal(first.payload.status, 'ok')
    assert.equal(first.payload.provider, 'flash')
    assert.deepEqual(first.payload.route, { provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' })
    assert.equal(first.payload.stopReason, 'completed')
    assert.match(first.payload.result, /fake worker handled \d+ chars in a fresh session/)
    assert.equal(first.payload.childSessionId, `child-${first.payload.sessionId}`)
    assert.equal(first.payload.resultTruncated, false)
    assert.equal(first.payload.runtime.sessions, 1)
    assert.equal(typeof first.payload.runtime.pid, 'number')

    const second = await call('flash_task', { task: 'read the README again', cwd })
    assert.equal(second.payload.runtime.pid, first.payload.runtime.pid)
    assert.equal(second.payload.runtime.sessions, 2)
    assert.notEqual(second.payload.sessionId, first.payload.sessionId)
    assert.match(second.payload.result, /in a fresh session/)
  } finally {
    await server.service.close()
  }
})

test('reports a non-delegating orchestrator with what it did instead', async () => {
  const { server, call, cwd } = await connect()
  try {
    const { frame, payload } = await call('flash_task', { task: 'NO-DELEGATE please', cwd })
    assert.equal(frame.result.isError, true)
    assert.match(payload.error, /finished without delegating/)
    assert.match(payload.error, /it replied "I will not delegate\."/)
    assert.match(payload.error, /it called no tool/)
    assert.match(payload.error, /tools offered were unknown/)
  } finally {
    await server.service.close()
  }
})

test('refuses a working directory outside the service root', async () => {
  const { server, call, cwd } = await connect()
  try {
    const { frame, payload } = await call('flash_task', { task: 'x', cwd: join(cwd, '..', '..') })
    assert.equal(frame.result.isError, true)
    assert.match(payload.error, /outside the service root/)
  } finally {
    await server.service.close()
  }
})

test('surfaces a missing dsh launcher as a tool error, not a crash', async () => {
  const { server, call, cwd } = await connect({ env: { FLASH_DSH_BIN: '' , PATH: '/nonexistent' } })
  try {
    const { frame, payload } = await call('flash_task', { task: 'x', cwd })
    assert.equal(frame.result.isError, true)
    assert.match(payload.error, /cannot find the dsh launcher/)
  } finally {
    await server.service.close()
  }
})

test('resolveDshCommand prefers the override and runs JavaScript entries with node', () => {
  assert.deepEqual(resolveDshCommand({ FLASH_DSH_BIN: '/opt/bin/dsh' }), { command: '/opt/bin/dsh', prefix: [] })
  assert.deepEqual(resolveDshCommand({ FLASH_DSH_BIN: '/opt/lib/bin.js' }), { command: process.execPath, prefix: ['/opt/lib/bin.js'] })
  assert.throws(() => resolveDshCommand({ FLASH_DSH_BIN: '', PATH: '/nonexistent' }), /cannot find the dsh launcher/)
})

test('resolveDshCommand finds dsh on PATH and refuses when it cannot', () => {
  const found = resolveDshCommand({ PATH: process.env.PATH ?? '' })
  assert.match(found.command, /dsh$/)
  assert.throws(() => resolveDshCommand({ PATH: '/nonexistent' }), /cannot find the dsh launcher/)
})

test('on Windows an npm .cmd shim is run as its JavaScript entry, never spawned itself', () => {
  // Node refuses to spawn a .cmd without a shell (CVE-2024-27980), so the launcher must
  // be the entry the shim starts, run with this Node. The shim text is npm's own.
  const bin = mkdtempSync(join(tmpdir(), 'flash-shim-'))
  const entry = join(bin, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  mkdirSync(join(entry, '..'), { recursive: true })
  writeFileSync(entry, '')
  writeFileSync(
    join(bin, 'dsh.cmd'),
    '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\n' +
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n',
  )
  const expected = { command: process.execPath, prefix: [entry] }
  assert.deepEqual(resolveDshCommand({ Path: bin }, 'win32'), expected)
  assert.deepEqual(resolveDshCommand({ FLASH_DSH_BIN: join(bin, 'dsh.cmd') }, 'win32'), expected)

  writeFileSync(join(bin, 'dsh.cmd'), '@ECHO off\r\nsomething-else.exe %*\r\n')
  assert.throws(() => resolveDshCommand({ Path: bin }, 'win32'), /cannot spawn a \.cmd.*FLASH_DSH_BIN/)
})

test('the SDK client surfaces a runtime protocol error and shuts down', async () => {
  const client = new HarnessSdkClient({
    profile: 'flash-service',
    cwd: mkdtempSync(join(tmpdir(), 'flash-mcp-sdk-')),
    command: { command: process.execPath, prefix: [FAKE_DSH] },
    requestTimeoutMs: 5_000,
  })
  client.start()
  assert.equal(typeof client.pid, 'number')
  await assert.rejects(
    client.request('nonsense/method'),
    /unknown method nonsense\/method/,
    'a protocol error must reject with the runtime message',
  )
  await client.shutdown()
  assert.equal(client.running, false)
})

test('exposes the tools, none able to select a route', async () => {
  const { server, request } = await connect()
  try {
    const { result } = await request('tools/list')
    // `flash_apply` and `flash_patch` are doors onto the *same* work a call already
    // produced, not ways to start work: both carry a patch id, never a task. The job
    // tools observe, collect, and cancel a background call; none of them starts work either.
    assert.deepEqual(result.tools.map((tool) => tool.name), [
      'flash_task',
      'flash_batch',
      'flash_apply',
      'flash_patch',
      'flash_status',
      'flash_result',
      'flash_cancel',
    ])
    assert.deepEqual(result.tools[1].inputSchema.required, ['tasks'])
    assert.deepEqual(result.tools[2].inputSchema.required, ['patchId'])
    assert.deepEqual(result.tools[3].inputSchema.required, ['patchId'])
    // `task` and `taskFile` are alternatives the service enforces, so neither is required by
    // the schema; the file alternative is offered everywhere a task is.
    assert.deepEqual(result.tools[0].inputSchema.required, ['cwd'])
    assert.equal(result.tools[0].inputSchema.properties.taskFile.type, 'string')
    assert.match(result.tools[0].inputSchema.properties.taskFile.description, /resolves against the service root/)
    const batchItem = result.tools[1].inputSchema.properties.tasks.items.oneOf[1]
    assert.equal(batchItem.properties.taskFile.type, 'string')
    assert.equal(batchItem.required, undefined)
    // A writing call's change is opt-in, and the default is to change nothing.
    assert.deepEqual(result.tools[0].inputSchema.properties.apply.enum, ['none', 'auto', 'discard'])
    assert.deepEqual(result.tools[1].inputSchema.properties.apply.enum, ['none', 'auto', 'discard'])
    // A call may continue from an earlier call's stored patch, and the schema says what that
    // means: the patch lands in the copy, and the patch this call returns is cumulative.
    for (const tool of [result.tools[0], result.tools[1]]) {
      assert.equal(tool.inputSchema.properties.basePatch.type, 'string')
      assert.match(tool.inputSchema.properties.basePatch.description, /applied to this call's copy before/)
      assert.match(tool.inputSchema.properties.basePatch.description, /contains both that change and the new work/)
      assert.match(tool.inputSchema.properties.basePatch.description, /not applied to your tree/)
    }
    for (const tool of result.tools) {
      assert.equal(tool.inputSchema.additionalProperties, false)
      assert.equal(JSON.stringify(tool.inputSchema).match(/provider|model|reasoning/i), null)
    }
  } finally {
    await server.service.close()
  }
})

test('runs a fleet through the whole pipeline and pairs every task with its result', async () => {
  const { server, call, cwd } = await connect()
  try {
    const { frame, payload } = await call('flash_batch', {
      tasks: ['one', { task: 'two', acceptance: 'be quick' }, 'three'],
      cwd,
      acceptance: 'done',
    })
    assert.equal(frame.result.isError, undefined)
    assert.equal(payload.status, 'ok')
    assert.equal(payload.requested, 3)
    assert.equal(payload.agentsStarted, 3)
    assert.equal(payload.runId, 'run-fake')
    assert.equal(payload.maxParallel, 3)
    assert.deepEqual(payload.results.map((entry) => entry.status), ['ok', 'ok', 'ok'])
    assert.match(payload.results[2].result, /fleet 2 \(task-3\)/)
    assert.deepEqual(payload.routes, [{ provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' }])
    assert.match(payload.sessionId, /^flash-batch-/)
    assert.equal(payload.workers.length, 3)
    assert.equal(payload.warnings, undefined)
    assert.equal(payload.runtime.sessions, 1)
  } finally {
    await server.service.close()
  }
})

test('a fleet whose workflow value is unreadable still pairs tasks by member records', async () => {
  const { server, call, cwd } = await connect()
  try {
    const { payload } = await call('flash_batch', { tasks: ['one', 'NO-WORKFLOW-VALUE'], cwd })
    assert.equal(payload.status, 'ok')
    assert.equal(payload.results.length, 2)
    assert.deepEqual(payload.results.map((entry) => entry.status), ['ok', 'ok'])
    assert.deepEqual(payload.results.map((entry) => entry.childSessionId !== undefined), [true, true])
    assert.equal(payload.workers.length, 2)
    assert.match(payload.warnings.join('\n'), /come from the engine's member records/)
  } finally {
    await server.service.close()
  }
})

test('a task brief can be sent from a file, and both task forms at once are refused', async () => {
  const { server, call, cwd } = await connect()
  try {
    writeFileSync(join(cwd, 'brief.md'), '# Brief\n\nDo the thing, once, as written.\n')
    const single = await call('flash_task', { taskFile: 'brief.md', cwd })
    assert.equal(single.frame.result.isError, undefined)
    assert.equal(single.payload.status, 'ok')

    const fleet = await call('flash_batch', { tasks: [{ taskFile: 'brief.md', acceptance: 'done' }], cwd })
    assert.equal(fleet.frame.result.isError, undefined)
    assert.equal(fleet.payload.status, 'ok')
    assert.equal(fleet.payload.requested, 1)

    const both = await call('flash_task', { task: 'inline text', taskFile: 'brief.md', cwd })
    assert.equal(both.frame.result.isError, true)
    assert.match(both.payload.error, /task and taskFile cannot both be given/)
  } finally {
    await server.service.close()
  }
})

test('flash_batch enforces its own contract before touching the runtime', async () => {
  const { server, call, cwd } = await connect()
  try {
    const empty = await call('flash_batch', { tasks: [], cwd })
    assert.equal(empty.frame.result.isError, true)
    assert.match(empty.payload.error, /at least one task/)

    const outside = await call('flash_batch', { tasks: ['a'], cwd: '/etc' })
    assert.equal(outside.frame.result.isError, true)
    assert.match(outside.payload.error, /outside the service root/)
  } finally {
    await server.service.close()
  }
})
