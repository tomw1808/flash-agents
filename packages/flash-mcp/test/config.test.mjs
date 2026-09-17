/**
 * Contract tests for the single configuration source of truth.
 *
 * The shipped `flash.config.json`, the frozen `DEFAULT_CONFIG`, and the merge and
 * load paths must agree: a value present in the file replaces its default while its
 * siblings survive, arrays replace rather than concatenate, an unknown or mistyped
 * setting is refused with its path, and the shared default object can never be
 * edited. These are the properties that make one file the source rather than a
 * second copy.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_CONFIG, loadConfig, mergeConfig, validateConfig } from '../lib/config.js'

/** The shipped configuration, read from the repository root. */
function shippedRaw() {
  return JSON.parse(readFileSync(new URL('../../../flash.config.json', import.meta.url), 'utf8'))
}

/** A path that does not exist, inside a fresh temp directory. */
function absentPath() {
  return join(mkdtempSync(join(tmpdir(), 'flash-config-missing-')), 'flash.config.json')
}

test('the shipped flash.config.json loads and validates', () => {
  const raw = shippedRaw()
  const { ok, errors } = validateConfig(raw)
  assert.equal(ok, true)
  assert.deepEqual(errors, [])
  assert.deepEqual(loadConfig({ env: {} }), DEFAULT_CONFIG)
})

test('defaults are returned when the config file is absent', () => {
  const config = loadConfig({ path: absentPath(), env: {} })
  assert.deepEqual(config, DEFAULT_CONFIG)
  assert.notEqual(config, DEFAULT_CONFIG)
})

test('a provided value replaces the default while its siblings survive', () => {
  const merged = mergeConfig({ limits: { slots: 9 } })
  assert.equal(merged.limits.slots, 9)
  assert.equal(merged.limits.maxTasks, DEFAULT_CONFIG.limits.maxTasks)
  assert.equal(merged.route.provider, DEFAULT_CONFIG.route.provider)
  assert.equal(merged.guard.protectEnvFiles, DEFAULT_CONFIG.guard.protectEnvFiles)
})

test('arrays replace rather than concatenate', () => {
  const merged = mergeConfig({ guard: { protectedSegments: ['node_modules'] } })
  assert.deepEqual(merged.guard.protectedSegments, ['node_modules'])
  assert.deepEqual(DEFAULT_CONFIG.guard.protectedSegments, ['.git'])

  const loaded = loadConfig({ path: absentPath(), env: {} })
  assert.deepEqual(loaded.guard.homeProtectedPaths, DEFAULT_CONFIG.guard.homeProtectedPaths)
})

test('an unknown setting is rejected at every section with its path', () => {
  const cases = [
    { raw: { nope: 1 }, path: 'nope' },
    { raw: { route: { nope: 1 } }, path: 'route.nope' },
    { raw: { limits: { nope: 1 } }, path: 'limits.nope' },
    { raw: { guard: { nope: 1 } }, path: 'guard.nope' },
    { raw: { dsh: { nope: 1 } }, path: 'dsh.nope' },
  ]
  for (const { raw, path } of cases) {
    const { ok, errors } = validateConfig(raw)
    assert.equal(ok, false)
    assert.equal(errors.some((message) => message.includes(`${path} is not a known setting`)), true)
  }
})

test('a value of the wrong type is rejected with its path and both types', () => {
  const { ok, errors } = validateConfig({ limits: { slots: 'two' } })
  assert.equal(ok, false)
  const message = errors.find((entry) => entry.includes('limits.slots'))
  assert.notEqual(message, undefined)
  assert.match(message, /string/)
  assert.match(message, /number/)

  const wrongSection = validateConfig({ route: 'ollama' })
  assert.equal(wrongSection.ok, false)
  assert.match(wrongSection.errors.join('\n'), /route has type string; expected object/)
})

test('a zero, negative or fractional limit is rejected', () => {
  for (const value of [0, -1, 1.5]) {
    const { ok, errors } = validateConfig({ limits: { slots: value } })
    assert.equal(ok, false)
    assert.equal(
      errors.some((entry) => entry.includes('limits.slots') && entry.includes('positive safe integer')),
      true,
    )
  }
  const positive = validateConfig({ limits: { slots: 3 } })
  assert.equal(positive.ok, true)
})

test('the patch retention window is a positive integer limit, defaulting to 14', () => {
  assert.equal(DEFAULT_CONFIG.limits.patchRetentionDays, 14)
  assert.equal(validateConfig({ limits: { patchRetentionDays: 30 } }).ok, true)
  const bad = validateConfig({ limits: { patchRetentionDays: 0 } })
  assert.equal(bad.ok, false)
  assert.match(bad.errors.join('\n'), /limits\.patchRetentionDays must be a positive safe integer/)
})

test('a guard list must be an array of non-empty strings', () => {
  const notAnArray = validateConfig({ guard: { protectedSegments: '.git' } })
  assert.equal(notAnArray.ok, false)
  const emptyEntry = validateConfig({ guard: { homeProtectedPaths: ['.ssh', ''] } })
  assert.equal(emptyEntry.ok, false)
  assert.match(emptyEntry.errors.join('\n'), /guard\.homeProtectedPaths must be an array of non-empty strings/)
})

test('the environment overrides the route when set and non-empty', () => {
  const config = loadConfig({
    path: absentPath(),
    env: { FLASH_SERVICE_PROVIDER: 'anthropic', FLASH_SERVICE_MODEL: 'claude-4' },
  })
  assert.equal(config.route.provider, 'anthropic')
  assert.equal(config.route.model, 'claude-4')
  assert.equal(config.limits.slots, DEFAULT_CONFIG.limits.slots)
})

test('an empty environment value does not override the default', () => {
  const config = loadConfig({ path: absentPath(), env: { FLASH_SERVICE_PROVIDER: '', FLASH_SERVICE_MODEL: '' } })
  assert.equal(config.route.provider, DEFAULT_CONFIG.route.provider)
  assert.equal(config.route.model, DEFAULT_CONFIG.route.model)
})

test('an invalid file is refused with the file name and the errors', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'flash-config-invalid-')), 'flash.config.json')
  writeFileSync(path, JSON.stringify({ limits: { nope: 1 } }))
  assert.throws(
    () => loadConfig({ path, env: {} }),
    (error) => {
      assert.match(error.message, /flash\.config\.json/)
      assert.match(error.message, /limits\.nope is not a known setting/)
      return true
    },
  )
})

test('DEFAULT_CONFIG is deeply frozen and mergeConfig leaves it alone', () => {
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true)
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.limits), true)
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.guard.protectedSegments), true)
  assert.throws(() => {
    DEFAULT_CONFIG.limits.slots = 99
  }, TypeError)

  const raw = { limits: { slots: 5 }, guard: { protectedSegments: ['x'] } }
  const merged = mergeConfig(raw)
  merged.limits.slots = 7
  merged.guard.protectedSegments.push('y')

  assert.equal(DEFAULT_CONFIG.limits.slots, 2)
  assert.deepEqual(DEFAULT_CONFIG.guard.protectedSegments, ['.git'])
  assert.deepEqual(raw, { limits: { slots: 5 }, guard: { protectedSegments: ['x'] } })
})
