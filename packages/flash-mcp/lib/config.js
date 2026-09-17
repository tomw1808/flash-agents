/**
 * The one source of truth for the service's route, limits and guard lists.
 *
 * Route, numeric limits and the guard's protected paths used to be repeated as
 * literals across the service, the CLI defaults, the presets and the wall. A change
 * to any of them had to be found everywhere it was spelled, and a missed copy was a
 * silent divergence. This module centralises the defaults and gives a single
 * validation and merge path for a checked-in `flash.config.json`, so there is one
 * shape to reason about and one place to change.
 *
 * @module flash-mcp/config
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Where the shipped configuration lives: `flash.config.json` at the repository root. */
const DEFAULT_PATH = fileURLToPath(new URL('../../../flash.config.json', import.meta.url))

/** Top-level sections whose keys are known by construction from the defaults. */
const SECTIONS = ['route', 'limits', 'guard', 'dsh']

/** The sections holding numeric limits that must be positive safe integers. */
const LIMIT_SECTIONS = new Set(['limits'])

/** The guard entries that must be arrays of non-empty strings. */
const STRING_ARRAY_PATHS = new Set(['guard.protectedSegments', 'guard.homeProtectedPaths'])

/**
 * The shipped defaults, frozen all the way down.
 *
 * Frozen so a caller that merges or loads cannot edit the shared object by
 * accident: every returned config is a fresh copy, and this one is only ever read.
 *
 * @type {Readonly<object>}
 */
export const DEFAULT_CONFIG = deepFreeze({
  route: { provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' },
  limits: {
    slots: 2,
    maxTasks: 16,
    // An hour and three: the worker is capable of a coherent feature slice, not
    // only a five-minute edit, and a slice that builds and tests a compiled project
    // between steps spends real minutes per cycle. A budget that ends before the
    // work does reports "timeout" for work that was going fine and retires a tree
    // the worker was still using; a generous budget costs nothing when the task is
    // small, because the call returns when the worker finishes.
    taskTimeoutMs: 3_600_000,
    batchTimeoutMs: 10_800_000,
    perItemChars: 12_000,
    maxResultChars: 24_000,
    diffChars: 20_000,
    maxConcurrentAgents: 4,
    maxTotalAgents: 32,
    maxItemsPerCall: 64,
    workflowMaxResultChars: 250_000,
  },
  guard: {
    protectedSegments: ['.git'],
    protectEnvFiles: true,
    blockDestructiveGit: true,
    fenceMutations: true,
    homeProtectedPaths: [
      '.ssh',
      '.aws',
      '.gnupg',
      '.dsh',
      '.config/gh',
      '.config/gcloud',
      '.docker/config.json',
    ],
  },
  dsh: { package: '@deepseek-ai/dsh', minVersion: '0.1.5' },
})

/**
 * Validate a raw configuration object against the defaults.
 *
 * Missing keys are fine — they take their default later. Unknown keys, values whose
 * type differs from the default's, non-positive or non-integral limits, and guard
 * lists that are not arrays of non-empty strings are collected as errors. Every error
 * names the full path it concerns, so a caller can point at the offending line.
 *
 * @param {unknown} raw - the parsed configuration, usually the contents of `flash.config.json`.
 * @returns {{ ok: boolean, errors: string[] }} whether it is valid, and why not when it is not.
 */
export function validateConfig(raw) {
  const errors = []
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['configuration must be a plain object'] }
  }
  for (const key of Object.keys(raw)) {
    if (!SECTIONS.includes(key)) errors.push(`${key} is not a known setting`)
  }
  for (const section of SECTIONS) {
    if (!Object.hasOwn(raw, section)) continue
    const provided = raw[section]
    const defaults = DEFAULT_CONFIG[section]
    if (!isPlainObject(provided)) {
      errors.push(`${section} has type ${typeName(provided)}; expected ${typeName(defaults)}`)
      continue
    }
    for (const key of Object.keys(provided)) {
      if (!Object.hasOwn(defaults, key)) errors.push(`${section}.${key} is not a known setting`)
    }
    for (const [key, fallback] of Object.entries(defaults)) {
      if (!Object.hasOwn(provided, key)) continue
      const value = provided[key]
      const path = `${section}.${key}`
      const expected = typeName(fallback)
      if (typeName(value) !== expected) {
        errors.push(`${path} has type ${typeName(value)}; expected ${expected}`)
        continue
      }
      if (LIMIT_SECTIONS.has(section) && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) {
        errors.push(`${path} must be a positive safe integer, got ${String(value)}`)
      }
      if (STRING_ARRAY_PATHS.has(path) && !isNonEmptyStringArray(value)) {
        errors.push(`${path} must be an array of non-empty strings`)
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * Merge a raw configuration over the defaults into a fresh object.
 *
 * The merge is per key, so providing one limit leaves its siblings at their default,
 * and arrays replace rather than concatenate. Neither `DEFAULT_CONFIG` nor `raw` is
 * touched: the result owns its own copies.
 *
 * @param {object} [raw] - the parsed configuration to layer over the defaults.
 * @returns {object} a new, complete, mutable configuration.
 */
export function mergeConfig(raw = {}) {
  const source = isPlainObject(raw) ? raw : {}
  const config = {}
  for (const section of SECTIONS) {
    const defaults = DEFAULT_CONFIG[section]
    if (!Object.hasOwn(source, section)) {
      config[section] = cloneValue(defaults)
      continue
    }
    const provided = source[section]
    config[section] = isPlainObject(provided)
      ? { ...cloneValue(defaults), ...cloneValue(provided) }
      : cloneValue(provided)
  }
  return config
}

/**
 * Load, validate and merge the service configuration.
 *
 * A missing file is not an error: the defaults are returned. A file that exists but
 * does not validate throws, naming the file and every error in it, so a
 * misconfiguration fails loudly at startup rather than silently at the first call.
 * After the merge the two route environment variables override the file when they
 * are set to a non-empty value.
 *
 * @param {object} [options] - where to read from and what environment to consult.
 * @param {string} [options.path] - configuration file to read; defaults to the repository's `flash.config.json`.
 * @param {Record<string, string | undefined>} [options.env] - environment to read overrides from; defaults to `process.env`.
 * @returns {object} the merged configuration.
 * @throws {Error} when the file exists but cannot be parsed or does not validate.
 */
export function loadConfig({ path, env = process.env } = {}) {
  const filePath = path === undefined || path === null || path === '' ? DEFAULT_PATH : path
  let raw = {}
  if (existsSync(filePath)) {
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch (error) {
      throw new Error(`${filePath} could not be read as JSON: ${messageOf(error)}`)
    }
  }
  const { ok, errors } = validateConfig(raw)
  if (!ok) {
    throw new Error(`${filePath} is not a valid configuration:\n  ${errors.join('\n  ')}`)
  }
  const config = mergeConfig(raw)
  if (isNonEmptyString(env.FLASH_SERVICE_PROVIDER)) config.route.provider = env.FLASH_SERVICE_PROVIDER
  if (isNonEmptyString(env.FLASH_SERVICE_MODEL)) config.route.model = env.FLASH_SERVICE_MODEL
  return config
}

/**
 * Freeze an object and every object and array beneath it.
 * @param {unknown} value - the value to freeze.
 * @returns {unknown} the same value, frozen.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/**
 * Copy a configuration value, all the way down, so no two configs share an array.
 * @param {unknown} value - the value to copy.
 * @returns {unknown} a detached copy.
 */
function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (isPlainObject(value)) {
    const copy = {}
    for (const [key, entry] of Object.entries(value)) copy[key] = cloneValue(entry)
    return copy
  }
  return value
}

/**
 * Whether a value is a plain object — not an array, null, or a class instance.
 * @param {unknown} value - the value to test.
 * @returns {boolean} true when it is a plain object.
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * A value's type as a person would name it.
 * @param {unknown} value - the value to describe.
 * @returns {string} `array`, `null`, or `typeof`.
 */
function typeName(value) {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

/**
 * Whether a value is an array whose every entry is a non-empty string.
 * @param {unknown} value - the value to test.
 * @returns {boolean} true when it is a non-empty array of non-empty strings.
 */
function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0)
}

/**
 * Whether a value is a non-empty string, as an environment override must be.
 * @param {unknown} value - the value to test.
 * @returns {boolean} true when it is a non-empty string.
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * One error message from an unknown throwable.
 * @param {unknown} error - the throwable to describe.
 * @returns {string} its message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
