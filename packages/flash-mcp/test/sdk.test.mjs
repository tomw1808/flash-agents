/**
 * SDK client tests: the handshake's own timeout is independent of the per-request
 * timeout, and a per-call timeout overrides both. The runtime is a silent child
 * process that consumes stdin and never answers, so no Harness is needed.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_INITIALIZE_TIMEOUT_MS, HarnessSdkClient } from '../lib/sdk.js'

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
