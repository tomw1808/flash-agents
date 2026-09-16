#!/usr/bin/env node
/**
 * flash-drive — drive this repository's own MCP server from a shell.
 *
 * A minimal MCP stdio client: it spawns `lib/index.js`, performs the handshake,
 * calls one tool, and prints the payload. It exists so the service can be used to
 * develop itself without a coding agent in the loop — a self-test loop that is
 * repeatable, scriptable, and cheap to run in CI-like conditions.
 *
 * One server per invocation means one patch store per invocation, so `--save-patch`
 * copies the returned patch out before the process exits. For work that will be
 * applied through `flash_apply`, keep one server up instead.
 *
 * Usage:
 *   node packages/flash-mcp/scripts/flash-drive.mjs --root <dir> --task-file <path>
 *   node packages/flash-mcp/scripts/flash-drive.mjs --root <dir> --tool flash_task --args '<json>'
 *
 * Options:
 *   --root <dir>          the workspace the server serves (required)
 *   --tool <name>         flash_task (default), flash_batch, or flash_apply
 *   --args <json>         tool arguments as JSON; overrides --task-file
 *   --task-file <path>    a file whose contents become `task`
 *   --acceptance <text>   acceptance criteria for --task-file
 *   --cwd <dir>           worker working directory (default: --root)
 *   --timeout-ms <n>      per-call budget passed to the server (default: 300000)
 *   --save-patch <path>   write the returned change.diff to this file
 *   --server-args "<s>"   extra arguments forwarded to the server
 *   --quiet               print only the summary lines
 */

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SERVER = resolve(import.meta.dirname, '..', 'lib', 'index.js')

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = argv.indexOf(name)
  return at < 0 ? fallback : argv[at + 1]
}
const has = (name) => argv.includes(name)

if (has('--help') || has('-h')) {
  process.stdout.write(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*\*/, '') + '\n')
  process.exit(0)
}

const root = flag('--root')
if (root === undefined) {
  process.stderr.write('flash-drive: --root is required\n')
  process.exit(2)
}
const tool = flag('--tool', 'flash_task')
const timeoutMs = Number(flag('--timeout-ms', '300000'))
const quiet = has('--quiet')
const taskFile = flag('--task-file')
const explicit = flag('--args')
const toolArgs = explicit !== undefined
  ? JSON.parse(explicit)
  : {
      task: readFileSync(resolve(taskFile ?? ''), 'utf8'),
      cwd: resolve(flag('--cwd', root)),
      ...(flag('--acceptance') === undefined ? {} : { acceptance: flag('--acceptance') }),
      apply: 'none',
    }

const child = spawn(process.execPath, [SERVER, '--root', resolve(root), '--timeout-ms', String(timeoutMs), ...(flag('--server-args', '') || '').split(' ').filter(Boolean)], {
  stdio: ['pipe', 'pipe', 'pipe'],
})
const stderrLines = []
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  for (const line of chunk.split('\n')) if (line.trim() !== '') stderrLines.push(line.trimEnd())
})

const pending = new Map()
let buffer = ''
let nextId = 0
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const at = buffer.indexOf('\n')
    if (at < 0) break
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (line.trim() === '') continue
    const message = JSON.parse(line)
    const settle = pending.get(message.id)
    if (settle !== undefined) {
      pending.delete(message.id)
      settle(message)
    }
  }
})

const request = (method, params) =>
  new Promise((settle) => {
    const id = ++nextId
    pending.set(id, settle)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

const started = Date.now()
await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'flash-drive', version: '1' } })
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

const frame = await Promise.race([
  request('tools/call', { name: tool, arguments: toolArgs }),
  new Promise((settle) => setTimeout(() => settle({ result: { isError: true, content: [{ type: 'text', text: 'flash-drive: the call outlived its own budget' }] } }), timeoutMs + 30_000)),
])

const text = frame.result?.content?.[0]?.text ?? JSON.stringify(frame.error)
let payload
try {
  payload = JSON.parse(text)
} catch {
  payload = undefined
}
const failed = frame.result?.isError === true

process.stdout.write(`${tool} in ${((Date.now() - started) / 1000).toFixed(1)}s — ${failed ? 'ERROR' : String(payload?.status ?? 'ok')}\n`)
if (payload?.change !== undefined) {
  process.stdout.write(`files: ${JSON.stringify(payload.change.filesChanged ?? [])}\n`)
  const diff = typeof payload.change.diff === 'string' ? payload.change.diff : ''
  process.stdout.write(`patch: ${String(payload.change.patchId)} (${String(diff.length)} chars${payload.change.diffTruncated === true ? ', truncated' : ''})\n`)
}
if (!quiet) process.stdout.write(`${text}\n`)
if (failed || payload?.status !== 'ok') process.stdout.write(`--- server stderr (tail)\n${stderrLines.slice(-15).join('\n')}\n`)

const savePatch = flag('--save-patch')
if (savePatch !== undefined && typeof payload?.change?.diff === 'string') {
  writeFileSync(resolve(savePatch), payload.change.diff)
  process.stdout.write(`saved patch to ${resolve(savePatch)}\n`)
}

child.stdin.end()
setTimeout(() => process.exit(failed ? 1 : 0), 1_500)
