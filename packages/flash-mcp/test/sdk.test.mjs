/**
 * SDK client tests: the handshake's own timeout is independent of the per-request
 * timeout, and a per-call timeout overrides both. The runtime is a silent child
 * process that consumes stdin and never answers, so no Harness is needed.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_INITIALIZE_TIMEOUT_MS, HarnessSdkClient, resolveDshCommand } from '../lib/sdk.js'

/** A child that stays alive and never writes a protocol frame. */
const SILENT_RUNTIME = ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)', '--']

function makeClient(options = {}) {
  const client = new HarnessSdkClient({
    profile: 'flash-service',
    cwd: mkdtempSync(join(tmpdir(), 'flash-mcp-sdk-')),
    command: { command: process.execPath, prefix: SILENT_RUNTIME },
    log: () => {},
    ...options,
  })
  client.start()
  return client
}

test('initialize uses its own timeout while a normal request keeps the request timeout', async () => {
  const initializing = makeClient({ requestTimeoutMs: 20_000, initializeTimeoutMs: 25 })
  try {
    await assert.rejects(
      initializing.initialize({ cwd: initializing.cwd, provider: 'ollama', model: 'test' }),
      /timed out after 25ms/,
      'initialize must use initializeTimeoutMs, not requestTimeoutMs',
    )
  } finally {
    await initializing.shutdown(50)
  }

  const requesting = makeClient({ requestTimeoutMs: 25, initializeTimeoutMs: 20_000 })
  try {
    await assert.rejects(
      requesting.request('session/prompt', {}),
      /timed out after 25ms/,
      'another request must keep requestTimeoutMs',
    )
    await assert.rejects(
      requesting.request('session/prompt', {}, { timeoutMs: 10 }),
      /timed out after 10ms/,
      'a per-call timeout must replace the request timeout for that call',
    )
  } finally {
    await requesting.shutdown(50)
  }
})

test('the handshake budget defaults to two minutes', async () => {
  const client = makeClient()
  try {
    assert.equal(client.initializeTimeoutMs, DEFAULT_INITIALIZE_TIMEOUT_MS)
    assert.equal(DEFAULT_INITIALIZE_TIMEOUT_MS, 120_000)
  } finally {
    await client.shutdown(50)
  }
})

test('a missing dsh names a launcher under another nvm Node, and never uses it', () => {
  const base = mkdtempSync(join(tmpdir(), 'flash-sdk-nvm-'))
  try {
    const current = join(base, 'versions', 'node', 'v22.19.0', 'bin', 'node')
    const sibling = join(base, 'versions', 'node', 'v20.19.0', 'bin', 'dsh')
    mkdirSync(join(base, 'versions', 'node', 'v20.19.0', 'bin'), { recursive: true })
    writeFileSync(sibling, '#!/bin/sh\nexit 0\n')
    chmodSync(sibling, 0o755)
    const listed = []
    const listDir = (directory) => {
      listed.push(directory)
      return ['v22.19.0', 'v20.19.0']
    }
    assert.throws(
      () => resolveDshCommand({ PATH: '' }, 'linux', { execPath: current, listDir, nodeVersion: 'v22.19.0' }),
      (error) => {
        assert.match(error.message, /cannot find the dsh launcher for this Node \(v22\.19\.0\)/)
        assert.ok(error.message.includes(`found one under Node 20.19.0 at ${sibling}`), error.message)
        assert.match(error.message, /reinstall dsh under this Node \(npm install -g @deepseek-ai\/dsh/)
        assert.match(error.message, /set FLASH_DSH_BIN to that path/)
        return true
      },
    )
    // The lookup reads the version directory's parent once, and the error never starts it.
    assert.deepEqual(listed, [join(base, 'versions', 'node')])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a missing dsh under nvm-windows names a sibling dsh.cmd', () => {
  const base = mkdtempSync(join(tmpdir(), 'flash-sdk-nvmw-'))
  try {
    const current = join(base, 'v22.19.0', 'node.exe')
    const sibling = join(base, 'v20.19.0', 'dsh.cmd')
    mkdirSync(join(base, 'v20.19.0'), { recursive: true })
    writeFileSync(sibling, '@echo off\n')
    assert.throws(
      () => resolveDshCommand({ PATH: '' }, 'win32', { execPath: current, listDir: () => ['v22.19.0', 'v20.19.0'], nodeVersion: 'v22.19.0' }),
      (error) => {
        assert.match(error.message, /cannot find the dsh launcher for this Node \(v22\.19\.0\)/)
        assert.ok(error.message.includes(`found one under Node 20.19.0 at ${sibling}`), error.message)
        return true
      },
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('without a version-manager sibling the existing message is kept', () => {
  const base = mkdtempSync(join(tmpdir(), 'flash-sdk-plain-'))
  try {
    assert.throws(
      () =>
        resolveDshCommand(
          { PATH: '' },
          'linux',
          // A system install (`/usr/bin/node`) has no version directory, so nothing is listed.
          { execPath: join(base, 'bin', 'node'), listDir: () => assert.fail('no version directory, so no listing') },
        ),
      /cannot find the dsh launcher: set FLASH_DSH_BIN to the dsh executable \(or to lib\/bin\.js inside the harness install\), or put dsh on PATH$/,
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a launcher on PATH is used without any sibling lookup', () => {
  const bin = mkdtempSync(join(tmpdir(), 'flash-sdk-path-'))
  try {
    const dsh = join(bin, 'dsh')
    writeFileSync(dsh, '#!/bin/sh\nexit 0\n')
    chmodSync(dsh, 0o755)
    const found = resolveDshCommand(
      { PATH: bin },
      'linux',
      { execPath: join(bin, 'v22.19.0', 'bin', 'node'), listDir: () => assert.fail('PATH must win without a lookup') },
    )
    assert.deepEqual(found, { command: dsh, prefix: [] })
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
})
