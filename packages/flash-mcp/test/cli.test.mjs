/**
 * CLI contract tests: where defaults come from, what an empty setting means, and
 * what the `doctor` subcommand reports.
 *
 * Two properties matter beyond the obvious parsing. Defaults must come from the
 * configuration file rather than from literals in the CLI, or the "one source of
 * truth" claim is only half true. And an empty environment value must count as
 * unset: a generated plugin configuration expands an unset setting to `""`, and
 * `--isolate ""` would otherwise refuse to start.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { parseOptions, runDoctor } from '../lib/index.js'
import { DEFAULT_CONFIG, mergeConfig } from '../lib/config.js'

/** A configuration with recognisable limits, so a default can be traced to it. */
const config = mergeConfig({
  route: { provider: 'ollama', model: 'test-model:cloud' },
  limits: { slots: 7, maxTasks: 3, taskTimeoutMs: 1_234, diffChars: 99 },
})

test('defaults are taken from the configuration, not from literals', () => {
  const options = parseOptions([], {}, config)
  assert.equal(options.provider, 'ollama')
  assert.equal(options.model, 'test-model:cloud')
  assert.equal(options.slots, 7)
  assert.equal(options.maxTasks, 3)
  assert.equal(options.taskTimeoutMs, 1_234)
  assert.equal(options.diffChars, 99)
  // Untouched limits still come from the shipped defaults.
  assert.equal(options.perItemChars, DEFAULT_CONFIG.limits.perItemChars)
  assert.equal(options.patchRetentionDays, DEFAULT_CONFIG.limits.patchRetentionDays)
  assert.equal(options.isolate, 'copy')
})

test('an empty environment value counts as unset', () => {
  const env = {
    FLASH_ISOLATE: '',
    FLASH_STATE_DIR: '',
    FLASH_LOG_FILE: '',
    FLASH_SERVICE_PROFILE: '',
    FLASH_SLOTS: '',
    FLASH_DIFF_CHARS: '',
  }
  const options = parseOptions([], env, config)
  assert.equal(options.isolate, 'copy')
  assert.equal(options.stateDir, undefined)
  assert.equal(options.logFile, undefined)
  assert.equal(options.profile, 'flash-service')
  assert.equal(options.slots, 7)
  assert.equal(options.diffChars, 99)
})

test('a set environment value and a flag both override the configuration', () => {
  const fromEnv = parseOptions([], { FLASH_SLOTS: '4', FLASH_LOG_FILE: '/tmp/flash.log' }, config)
  assert.equal(fromEnv.slots, 4)
  assert.equal(fromEnv.logFile, '/tmp/flash.log')

  const fromFlags = parseOptions(['--slots', '5', '--isolate', 'none', '--model', 'other:latest'], {}, config)
  assert.equal(fromFlags.slots, 5)
  assert.equal(fromFlags.isolate, 'none')
  assert.equal(fromFlags.model, 'other:latest')

  const retention = parseOptions(['--patch-retention-days', '3'], {}, config)
  assert.equal(retention.patchRetentionDays, 3)
})

test('an unusable option is refused', () => {
  assert.throws(() => parseOptions(['--isolate', 'yolo'], {}, config), /is not available/)
  assert.throws(() => parseOptions(['--nope'], {}, config), /unknown argument/)
  assert.throws(() => parseOptions(['--slots'], {}, config), /needs a value/)
})

/** Injected effects for the doctor: no binary is run and no socket is opened. */
function fakes({ dsh = { status: 0, stdout: '9.9.9\n', stderr: '' }, daemon = true, show = { status: 0, stdout: '', stderr: '' } } = {}) {
  return {
    run: (command, args) => {
      if (command === 'dsh') return args[0] === '--version' ? dsh : { status: 0, stdout: '', stderr: '' }
      if (command === 'ollama') return show
      return { status: 0, stdout: '', stderr: '' }
    },
    probe: async () => daemon,
  }
}

test('doctor exits zero when the prerequisites are met', async () => {
  const lines = []
  const code = await runDoctor([], { env: {}, write: (text) => lines.push(text), ...fakes() })
  assert.equal(code, 0)
  const text = lines.join('')
  assert.match(text, /all required checks passed/)
  assert.match(text, /ollama/)
})

test('doctor exits non-zero and prints a fix for each broken prerequisite', async () => {
  const lines = []
  const code = await runDoctor([], {
    env: {},
    write: (text) => lines.push(text),
    ...fakes({ dsh: { status: 1, stdout: '', stderr: 'not found' }, daemon: false }),
  })
  assert.equal(code, 1)
  const text = lines.join('')
  assert.match(text, /check\(s\) failed/)
  assert.match(text, /Fix: dsh: npm i -g @deepseek-ai\/dsh/)
  assert.match(text, /Fix: ollama: ollama serve/)
})

test('doctor asks about the model the service would actually run', async () => {
  const lines = []
  await runDoctor([], {
    env: { FLASH_SERVICE_MODEL: 'someone-elses-model:latest' },
    write: (text) => lines.push(text),
    ...fakes({ show: { status: 1, stdout: '', stderr: 'not found' } }),
  })
  assert.match(lines.join(''), /someone-elses-model:latest/)
})
