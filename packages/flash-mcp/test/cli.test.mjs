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
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createService, parseOptions, runDoctor } from '../lib/index.js'
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
  // The handshake budget has no configuration entry; it has its own shipped default.
  assert.equal(options.initTimeoutMs, 120_000)
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
    FLASH_INIT_TIMEOUT_MS: '',
  }
  const options = parseOptions([], env, config)
  assert.equal(options.isolate, 'copy')
  assert.equal(options.stateDir, undefined)
  assert.equal(options.logFile, undefined)
  assert.equal(options.profile, 'flash-service')
  assert.equal(options.slots, 7)
  assert.equal(options.diffChars, 99)
  assert.equal(options.initTimeoutMs, 120_000)
})

test('a set environment value and a flag both override the configuration', () => {
  const fromEnv = parseOptions(
    [],
    { FLASH_SLOTS: '4', FLASH_LOG_FILE: '/tmp/flash.log', FLASH_INIT_TIMEOUT_MS: '45000' },
    config,
  )
  assert.equal(fromEnv.slots, 4)
  assert.equal(fromEnv.logFile, '/tmp/flash.log')
  assert.equal(fromEnv.initTimeoutMs, 45_000)

  const fromFlags = parseOptions(
    ['--slots', '5', '--isolate', 'none', '--model', 'other:latest', '--init-timeout-ms', '90000'],
    {},
    config,
  )
  assert.equal(fromFlags.slots, 5)
  assert.equal(fromFlags.isolate, 'none')
  assert.equal(fromFlags.model, 'other:latest')
  assert.equal(fromFlags.initTimeoutMs, 90_000)

  const retention = parseOptions(['--patch-retention-days', '3'], {}, config)
  assert.equal(retention.patchRetentionDays, 3)
})

test('--allow-slot-setup and FLASH_ALLOW_SLOT_SETUP=1 are the opt-in for setup steps', () => {
  assert.equal(parseOptions([], {}, config).allowSlotSetup, false)
  assert.equal(parseOptions(['--allow-slot-setup'], {}, config).allowSlotSetup, true)
  assert.equal(parseOptions([], { FLASH_ALLOW_SLOT_SETUP: '1' }, config).allowSlotSetup, true)
  assert.equal(parseOptions([], { FLASH_ALLOW_SLOT_SETUP: '0' }, config).allowSlotSetup, false)
  // The plugin setting's two values.
  assert.equal(parseOptions([], { FLASH_ALLOW_SLOT_SETUP: 'on' }, config).allowSlotSetup, true)
  assert.equal(parseOptions([], { FLASH_ALLOW_SLOT_SETUP: 'off' }, config).allowSlotSetup, false)
  assert.equal(parseOptions([], { FLASH_ALLOW_SLOT_SETUP: '' }, config).allowSlotSetup, false)
})

test('an unusable option is refused', () => {
  assert.throws(() => parseOptions(['--isolate', 'yolo'], {}, config), /is not available/)
  assert.throws(() => parseOptions(['--nope'], {}, config), /unknown argument/)
  assert.throws(() => parseOptions(['--slots'], {}, config), /needs a value/)
  // The handshake timeout is a positive integer, from either door.
  assert.throws(() => parseOptions(['--init-timeout-ms'], {}, config), /needs a value/)
  assert.throws(() => parseOptions(['--init-timeout-ms', 'soon'], {}, config), /must be a positive integer/)
  assert.throws(() => parseOptions(['--init-timeout-ms', '0'], {}, config), /must be a positive integer/)
  assert.throws(() => parseOptions([], { FLASH_INIT_TIMEOUT_MS: '-1' }, config), /must be a positive integer/)
})

test('the parsed handshake timeout reaches the service', async () => {
  const options = parseOptions(['--init-timeout-ms', '4321'], {}, config)
  options.root = mkdtempSync(join(tmpdir(), 'flash-mcp-cli-'))
  options.isolate = 'none'
  const service = createService(options)
  try {
    assert.equal(service.initTimeoutMs, 4_321)
  } finally {
    await service.close()
  }
})

/** Injected effects for the doctor: no binary is run and no socket is opened. */
function fakes({ dsh = { status: 0, stdout: `${config.dsh.version}\n`, stderr: '' }, daemon = true, show = { status: 0, stdout: '', stderr: '' } } = {}) {
  return {
    launcher: { command: 'dsh', prefix: [] },
    run: (command, args) => {
      if (command === 'dsh') return args[0] === '--version' ? dsh : { status: 0, stdout: '', stderr: '' }
      if (command === 'ollama') return show
      return { status: 0, stdout: '', stderr: '' }
    },
    probe: async () => daemon,
    generate: async () => ({ ok: true, status: 200, ms: 10 }),
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
  assert.match(text, /Fix: dsh: npm i -g @deepseek-ai\/dsh@/)
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

/** A throwaway git repository with one committed file and one large untracked one. */
function tempRepository() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'flash-cli-copy-')))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), '# project\n')
  writeFileSync(join(repo, 'big.txt'), 'x'.repeat(50_000))
  return repo
}

test('doctor --copy reports what a copy of a real repository costs', async () => {
  const repo = tempRepository()
  const lines = []
  const code = await runDoctor(['--copy', '--root', repo], { env: {}, write: (text) => lines.push(text) })
  assert.equal(code, 0)
  const text = lines.join('')
  assert.match(text, /ok\s+copy\s+copied /)
  // Bytes, file count and the mechanism the pool actually used.
  assert.match(text, /\d+(\.\d+)? (B|KB|MB|GB) in \d+ file\(s\), mechanism: (copy|clone)/)
  // The five largest top-level entries, biggest first, are the copyExclude hint.
  assert.match(text, /top\s+copy\s+.*big\.txt/)
  // A bare --copy is its own question: it must not run the prerequisite checks.
  assert.doesNotMatch(text, /all required checks passed/)
})

test('doctor --copy exits 1 with the error the copy would have hit', async () => {
  const missing = join(tmpdir(), `flash-cli-missing-${String(process.pid)}`)
  assert.equal(existsSync(missing), false)
  const lines = []
  const code = await runDoctor(['--copy', '--root', missing], { env: {}, write: (text) => lines.push(text) })
  assert.equal(code, 1)
  const text = lines.join('')
  assert.match(text, /fail\s+copy\s+the copy of .* failed/)
  assert.match(text, /ENOENT/)
})

test('doctor --copy takes its root from CLAUDE_PROJECT_DIR, as the plugin starts the server', async () => {
  const repo = tempRepository()
  const lines = []
  const code = await runDoctor(['--copy'], {
    env: { CLAUDE_PROJECT_DIR: repo },
    write: (text) => lines.push(text),
  })
  assert.equal(code, 0)
  assert.match(lines.join(''), new RegExp(`ok\\s+copy\\s+copied ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
})

test('doctor --e2e skips the run when a check failed', async () => {
  const lines = []
  let built = false
  const code = await runDoctor(['--e2e'], {
    env: {},
    write: (text) => lines.push(text),
    ...fakes({ dsh: { status: 1, stdout: '', stderr: 'not found' }, daemon: false }),
    createService: () => {
      built = true
      return { flashTask: async () => ({}), close: async () => {} }
    },
  })
  assert.equal(code, 1)
  assert.equal(built, false, 'a failed check must skip the end-to-end run entirely')
  const text = lines.join('')
  assert.match(text, /skip\s+e2e\s+the checks failed, so the end-to-end run was skipped/)
  assert.doesNotMatch(text, /ok\s+e2e/)
})

/** A service stand-in for `--e2e`: records what it was built with, and what it ran. */
function fakeE2eService({ result, onCall, closeError } = {}) {
  const built = []
  const calls = []
  let closed = false
  return {
    built,
    calls,
    get closed() {
      return closed
    },
    createService: (options, log) => {
      built.push(options)
      return {
        flashTask: async (args) => {
          calls.push(args)
          if (onCall !== undefined) await onCall(options, args)
          return typeof result === 'function' ? result(options, args) : result
        },
        close: async () => {
          closed = true
          if (closeError !== undefined) throw closeError
        },
      }
    },
  }
}

/** The result a real stack returns when the worker did exactly what it was asked. */
function e2eResult() {
  return {
    status: 'ok',
    stopReason: 'completed',
    provider: 'flash',
    route: { provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' },
    change: {
      filesChanged: ['flash-hello.txt'],
      diff: 'diff --git a/flash-hello.txt b/flash-hello.txt\nnew file mode 100644\n--- /dev/null\n+++ b/flash-hello.txt\n@@ -0,0 +1 @@\n+it works\n',
    },
    usage: { inputTokens: 1000, outputTokens: 234, totalTokens: 1234 },
  }
}

test('doctor --e2e exits non-zero when the service will not close, even after a passing run', async () => {
  const lines = []
  const fake = fakeE2eService({ result: e2eResult(), closeError: new Error('the pool would not close') })
  const code = await runDoctor(['--e2e'], { env: {}, write: (text) => lines.push(text), ...fakes(), createService: fake.createService })
  const text = lines.join('')
  assert.match(text, /fail\s+e2e\s+could not close the service: the pool would not close/)
  // A runtime or a tree may have been left behind; the exit code must say so too.
  assert.equal(code, 1, text)
})

test('doctor --e2e proves a writing call in a throwaway repository', async () => {
  const lines = []
  const fake = fakeE2eService({ result: e2eResult() })
  const code = await runDoctor(['--e2e'], {
    env: {},
    write: (text) => lines.push(text),
    ...fakes(),
    createService: fake.createService,
  })
  const text = lines.join('')
  assert.equal(code, 0, text)
  assert.match(text, /ok\s+e2e\s+worker status ok on ollama\/deepseek-v4\.1-flash:cloud/)
  assert.match(text, /ok\s+e2e\s+change: flash-hello\.txt \(\+1\)/)
  assert.match(text, /ok\s+e2e\s+the temp repository was not touched/)
  assert.match(text, /ok\s+e2e\s+\d+\.\d+s, 1234 tokens/)

  // The service was built the way the server builds it, but in a throwaway tree with a
  // private state directory and one slot.
  assert.equal(fake.built.length, 1)
  const [options] = fake.built
  assert.equal(options.isolate, 'copy')
  assert.equal(options.slots, 1)
  assert.equal(options.taskTimeoutMs, 600_000)
  assert.notEqual(options.root, process.cwd())
  assert.equal(options.profile, 'flash-service')
  assert.equal(options.provider, 'ollama')
  // A private state directory in its own temp tree: never the user's.
  assert.match(options.stateDir, /flash-doctor-state-.+[\\/]state$/)

  // The call was the prescribed one, in the throwaway repository, stored rather than applied.
  const [args] = fake.calls
  assert.equal(args.cwd, options.root)
  assert.equal(args.apply, 'none')
  assert.match(args.task, /flash-hello\.txt/)
  assert.match(args.task, /it works/)

  // Everything it created is gone, service first.
  assert.equal(fake.closed, true)
  assert.equal(existsSync(options.root), false)
  assert.equal(existsSync(options.stateDir), false)
})

test('doctor --e2e fails when the worker leaves the temp repository touched', async () => {
  const lines = []
  // A service that writes into the root it was given: exactly what isolation exists to
  // prevent, and what the "not touched" fact must catch.
  const fake = fakeE2eService({
    result: e2eResult(),
    onCall: async (options) => writeFileSync(join(options.root, 'flash-hello.txt'), 'it works\n'),
  })
  const code = await runDoctor(['--e2e'], {
    env: {},
    write: (text) => lines.push(text),
    ...fakes(),
    createService: fake.createService,
  })
  assert.equal(code, 1)
  const text = lines.join('')
  assert.match(text, /fail\s+e2e\s+the temp repository was touched: flash-hello\.txt/)
  assert.equal(existsSync(fake.built[0].root), false, 'the throwaway repository is removed anyway')
})

test('doctor --e2e reports the exact error, with the note a NOT_DELEGATED run needs', async () => {
  const lines = []
  const failure = new Error('the orchestrator finished without delegating')
  failure.code = 'NOT_DELEGATED'
  const code = await runDoctor(['--e2e'], {
    env: {},
    write: (text) => lines.push(text),
    ...fakes(),
    createService: () => ({
      flashTask: async () => {
        throw failure
      },
      close: async () => {},
    }),
  })
  assert.equal(code, 1)
  const text = lines.join('')
  assert.match(text, /fail\s+e2e\s+the orchestrator finished without delegating/)
  assert.match(text, /note\s+e2e\s+the cheap dispatcher sometimes does the work itself; a rerun usually passes/)
})

