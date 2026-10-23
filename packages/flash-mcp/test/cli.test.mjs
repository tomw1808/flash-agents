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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import {
  createService,
  createToolCaller,
  instructionsFor,
  jobLabel,
  listTools,
  parseOptions,
  runDoctor,
  startServer,
} from '../lib/index.js'
import { JobRegistry } from '../lib/jobs.js'
import { DEFAULT_CONFIG, mergeConfig } from '../lib/config.js'
import { rootDigest } from '../lib/isolation.js'
import { resolveDshCommand } from '../lib/sdk.js'

/**
 * A service built with `--state-base` keeps the default patch store, which lives in the
 * durable data directory. Point it at a throwaway directory so no test reads or prunes
 * the real one.
 */
process.env.FLASH_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'flash-cli-data-')))

/** The route the tests configure; recognisable so a value can be traced to it. */
const TEST_MODEL = 'test-model:cloud'

/** A configuration with recognisable limits, so a default can be traced to it. */
const config = mergeConfig({
  route: { provider: 'ollama', model: TEST_MODEL },
  limits: { slots: 7, maxTasks: 3, taskTimeoutMs: 1_234, diffChars: 99 },
})

/** A harness home that does not exist: these tests never read or write the real ~/.dsh. */
const ABSENT_DSH_HOME = join(tmpdir(), 'flash-cli-absent-dsh-home')

/** The environment a doctor test runs with, pointed away from the real harness home. */
function doctorEnv(extra = {}) {
  return { DSH_HOME: ABSENT_DSH_HOME, ...extra }
}

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

test('the tools expose the allowlist, and name the default in its description', () => {
  const models = ['test-model:cloud', 'other-model:cloud']
  const tools = listTools(models)
  const single = tools.find((tool) => tool.name === 'flash_task')
  const fleet = tools.find((tool) => tool.name === 'flash_batch')
  for (const tool of [single, fleet]) {
    assert.deepEqual(tool.inputSchema.properties.model.enum, models)
    assert.match(tool.inputSchema.properties.model.description, /Default: test-model:cloud/)
    assert.match(tool.inputSchema.properties.model.description, /routes? reports? the model that actually ran/)
    assert.match(tool.inputSchema.properties.model.description, /other-model:cloud may be chosen per call/)
  }
  assert.match(fleet.inputSchema.properties.model.description, /whole fleet/)
  // A fleet's task items cannot carry a model of their own.
  assert.equal(fleet.inputSchema.properties.tasks.items.oneOf[1].properties.model, undefined)
  // Without an argument the shipped default is named: no description hard-codes a route
  // string that the configuration could contradict.
  const fallback = listTools().find((tool) => tool.name === 'flash_task')
  assert.deepEqual(fallback.inputSchema.properties.model.enum, [DEFAULT_CONFIG.route.model])
})

test('the handshake instructions name the default and the other allowed models', () => {
  const text = instructionsFor(['test-model:cloud', 'other-model:cloud'])
  assert.match(text, /test-model:cloud is the default and suits a quick hand-off/)
  assert.match(text, /other-model:cloud can be chosen per call/)
  assert.match(text, /routes? reports? the model that actually ran/)
  assert.doesNotMatch(text, /ollama\/deepseek-v4\.1-flash:cloud/)
})

test('a background job label says which model it chose, unless it is the default', () => {
  assert.equal(jobLabel('flash_task', { task: 'write the thing' }, TEST_MODEL), 'write the thing')
  assert.equal(jobLabel('flash_task', { task: 'write the thing', model: TEST_MODEL }, TEST_MODEL), 'write the thing')
  assert.equal(jobLabel('flash_task', { task: 'write the thing', model: 'other:cloud' }, TEST_MODEL), '[other:cloud] write the thing')
  assert.equal(jobLabel('flash_batch', { tasks: ['a', 'b'], model: 'other:cloud' }, TEST_MODEL), '[other:cloud] 2 tasks')
})

test('a taskFile job is labelled with the brief it names, and names the path when it cannot read it', () => {
  // A brief written the way callers write them: a heading, then prose.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flash-cli-label-')))
  writeFileSync(
    join(root, 'brief.txt'),
    ['#  Port the parser  ', '', ...Array.from({ length: 20 }, (_, index) => `line ${String(index)}`)].join('\n'),
  )
  assert.equal(jobLabel('flash_task', { taskFile: 'brief.txt' }, TEST_MODEL, root), 'Port the parser')
  // An absolute path resolves the same way, and the model prefix still leads.
  assert.equal(
    jobLabel('flash_task', { taskFile: join(root, 'brief.txt'), model: 'other:cloud' }, TEST_MODEL, root),
    '[other:cloud] Port the parser',
  )
  // Unreadable: the path is the one fact a status reader can act on.
  assert.equal(jobLabel('flash_task', { taskFile: 'missing.txt' }, TEST_MODEL, root), 'taskFile missing.txt')
  // A brief outside the root is refused by the same fence the service applies, so it is
  // labelled by path here too rather than read.
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'flash-cli-outside-')))
  writeFileSync(join(outside, 'brief.txt'), '# not yours\n')
  assert.equal(
    jobLabel('flash_task', { taskFile: join(outside, 'brief.txt') }, TEST_MODEL, root),
    `taskFile ${join(outside, 'brief.txt')}`,
  )
  // A call that named a task keeps today's label; the brief is not read at all.
  assert.equal(jobLabel('flash_task', { task: 'inline task', taskFile: 'brief.txt' }, TEST_MODEL, root), 'inline task')
})

test('the service allowlist holds its default first, whichever door named it', async () => {
  const options = parseOptions(['--model', 'other:latest'], {}, config)
  options.root = mkdtempSync(join(tmpdir(), 'flash-mcp-cli-model-'))
  options.isolate = 'none'
  const service = createService(options)
  try {
    assert.equal(service.model, 'other:latest')
    // `--model` is folded in, so the model the operator asked for is never refused by
    // the allowlist the same configuration supplied.
    assert.equal(service.models[0], 'other:latest')
    assert.ok(service.models.includes(TEST_MODEL))
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
  const code = await runDoctor([], { env: doctorEnv(), write: (text) => lines.push(text), ...fakes() })
  assert.equal(code, 0)
  const text = lines.join('')
  assert.match(text, /all required checks passed/)
  assert.match(text, /ollama/)
})

test('doctor exits non-zero and prints a fix for each broken prerequisite', async () => {
  const lines = []
  const code = await runDoctor([], {
    env: doctorEnv(),
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
    env: doctorEnv({ FLASH_SERVICE_MODEL: 'someone-elses-model:latest' }),
    write: (text) => lines.push(text),
    ...fakes({ show: { status: 1, stdout: '', stderr: 'not found' } }),
  })
  assert.match(lines.join(''), /someone-elses-model:latest/)
})

test('doctor checks the model named by --model, not the configured default', async () => {
  const lines = []
  const code = await runDoctor(['--model', 'minimax-m3.1-flash:cloud'], {
    env: doctorEnv(),
    write: (text) => lines.push(text),
    ...fakes({ show: { status: 1, stdout: '', stderr: 'not found' } }),
  })
  const text = lines.join('')
  assert.equal(code, 1)
  assert.match(text, /fail\s+model\s+minimax-m3\.1-flash:cloud is not available/)
  // The configured default is still on the computed allowlist, but only as a
  // non-default row: its absence warns instead of failing the run twice.
  assert.match(text, /warn\s+model:deepseek-v4\.1-flash:cloud/)
  assert.doesNotMatch(text, /fail\s+model\s+deepseek-v4\.1-flash:cloud/)
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
  const code = await runDoctor(['--copy', '--root', repo], { env: doctorEnv(), write: (text) => lines.push(text) })
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
  const code = await runDoctor(['--copy', '--root', missing], { env: doctorEnv(), write: (text) => lines.push(text) })
  assert.equal(code, 1)
  const text = lines.join('')
  assert.match(text, /fail\s+copy\s+the copy of .* failed/)
  assert.match(text, /ENOENT/)
})

test('doctor --copy takes its root from CLAUDE_PROJECT_DIR, as the plugin starts the server', async () => {
  const repo = tempRepository()
  const lines = []
  const code = await runDoctor(['--copy'], {
    env: doctorEnv({ CLAUDE_PROJECT_DIR: repo }),
    write: (text) => lines.push(text),
  })
  assert.equal(code, 0)
  assert.match(lines.join(''), new RegExp(`ok\\s+copy\\s+copied ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
})

test('doctor refuses a relative state base instead of measuring the repository', async () => {
  const lines = []
  const code = await runDoctor(['--state-base', 'rel'], {
    env: doctorEnv(),
    write: (text) => lines.push(text),
  })
  assert.equal(code, 2)
  assert.match(
    lines.join(''),
    /flash-agents: --state-base must be an absolute path \(got "rel"\)/,
    'the same invalid-option report as the other bad options',
  )
  assert.match(lines.join(''), /Usage:/)
})

test('doctor --e2e skips the run when a check failed', async () => {
  const lines = []
  let built = false
  const code = await runDoctor(['--e2e'], {
    env: doctorEnv(),
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
  const code = await runDoctor(['--e2e'], { env: doctorEnv(), write: (text) => lines.push(text), ...fakes(), createService: fake.createService })
  const text = lines.join('')
  assert.match(text, /fail\s+e2e\s+could not close the service: the pool would not close/)
  // A runtime or a tree may have been left behind; the exit code must say so too.
  assert.equal(code, 1, text)
})

test('doctor --e2e proves a writing call in a throwaway repository', async () => {
  const lines = []
  const fake = fakeE2eService({ result: e2eResult() })
  const code = await runDoctor(['--e2e'], {
    env: doctorEnv(),
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
  assert.equal(options.model, 'deepseek-v4.1-flash:cloud')
  // The doctor's environment reaches the service (so the run reads no real harness
  // home), and the model is a per-call argument now: the service puts it into the
  // runtime's own environment rather than the doctor pre-setting the variable.
  assert.equal(options.env.FLASH_ROUTE_MODEL, undefined)
  assert.equal(options.env.DSH_HOME, ABSENT_DSH_HOME)
  assert.equal(fake.calls[0].model, options.model)
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

test('doctor --e2e runs on the model it was asked for', async () => {
  const lines = []
  const fake = fakeE2eService({
    result: { ...e2eResult(), route: { provider: 'ollama', model: 'minimax-m3.1-flash:cloud' } },
  })
  const code = await runDoctor(['--e2e', '--model', 'minimax-m3.1-flash:cloud'], {
    env: doctorEnv(),
    write: (text) => lines.push(text),
    ...fakes(),
    createService: fake.createService,
  })
  const text = lines.join('')
  assert.equal(code, 0, text)
  assert.match(text, /ok\s+e2e\s+worker status ok on ollama\/minimax-m3\.1-flash:cloud/)
  assert.equal(fake.built[0].model, 'minimax-m3.1-flash:cloud')
  assert.equal(fake.calls[0].model, 'minimax-m3.1-flash:cloud')
})

test('doctor --e2e fails when the observed model differs from the one asked for', async () => {
  const lines = []
  const fake = fakeE2eService({
    result: { ...e2eResult(), route: { provider: 'ollama', model: 'deepseek-v4.1-flash:1017-cloud' } },
  })
  const code = await runDoctor(['--e2e', '--model', 'minimax-m3.1-flash:cloud'], {
    env: doctorEnv(),
    write: (text) => lines.push(text),
    ...fakes(),
    createService: fake.createService,
  })
  assert.equal(code, 1)
  assert.match(
    lines.join(''),
    /fail\s+e2e\s+worker status ok on ollama\/deepseek-v4\.1-flash:1017-cloud, but the model asked for was minimax-m3\.1-flash:cloud/,
  )
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
    env: doctorEnv(),
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
    env: doctorEnv(),
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


// ── the stdio server's deferred start-up sweep ──────────────────────────────

/** Wait, with a bound, until `predicate` holds. */
async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`)
}

/**
 * Start a real server over an in-memory byte stream, recording the frames it writes.
 *
 * The service is real — that is the wiring under test — while the sweep itself is replaced
 * by a spy in the tests, so nothing here scans a temp directory on a timer.
 *
 * @param {object} options - parsed service options.
 * @param {object} [timing] - passed through to `startServer`.
 * @returns {{server: object, input: PassThrough, frames: object[],
 *   send: (message: object) => void, waitForFrame: (count: number) => Promise<void>}}
 */
function startTestServer(options, timing) {
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
  const server = startServer(options, input, output, timing)
  return {
    server,
    input,
    frames,
    send: (message) => input.write(`${JSON.stringify(message)}\n`),
    waitForFrame: (count) => waitUntil(() => frames.length >= count),
  }
}

/** The service options the two startServer tests run with: throwaway root and state. */
function serveOptions() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'flash-cli-serve-root-')))
  return {
    root: repo,
    profile: 'flash-service',
    provider: 'ollama',
    model: TEST_MODEL,
    isolate: 'copy',
    slots: 1,
    // Never the real durable store: a configured state directory keeps its own `calls`.
    stateDir: realpathSync(mkdtempSync(join(tmpdir(), 'flash-cli-serve-state-'))),
    env: doctorEnv(),
  }
}

test('startServer defers the sweep until the client has initialized', async () => {
  const options = serveOptions()
  const { server, input, frames, send, waitForFrame } = startTestServer(options, { startupSweepDelayMs: 60_000 })
  const sweeps = []
  server.service.isolation.startupSweep = () => {
    sweeps.push('sweep')
    return Promise.resolve()
  }
  try {
    // The pool really is deferred: the flag reached it through createService and service.js.
    assert.equal(server.service.isolation.deferStartupSweep, true)
    // And it can say what a waiting call is waiting for, so the service does not have to
    // guess why `lease` has not answered yet.
    assert.equal(server.service.isolation.startupSweepPending, true, 'the deferred sweep has not run')
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    await waitForFrame(1)
    assert.deepEqual(sweeps, [], 'the handshake alone does not start the sweep')

    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    await waitUntil(() => sweeps.length === 1)
    // A second notification cannot start a second pass.
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(sweeps, ['sweep'])
    assert.equal(frames[0].id, 1)
  } finally {
    input.end()
    await server.done
  }
})

test('startServer starts the sweep on the fallback timer when initialized never arrives', async () => {
  const options = serveOptions()
  // A handshake is answered quickly; the delay is long enough that the frame below cannot
  // race the timer, and short enough to keep the test fast.
  const { server, input, frames, send, waitForFrame } = startTestServer(options, { startupSweepDelayMs: 100 })
  const sweeps = []
  server.service.isolation.startupSweep = () => {
    sweeps.push('sweep')
    return Promise.resolve()
  }
  try {
    // A client that handshakes but never sends `notifications/initialized` must still get
    // its dead owners cleaned up; the fallback is unref'd, so it never holds a process open.
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    await waitForFrame(1)
    assert.equal(sweeps.length, 0, 'the timer has not fired yet')
    await waitUntil(() => sweeps.length === 1)
    assert.deepEqual(sweeps, ['sweep'])
    assert.equal(frames[0].id, 1)
  } finally {
    input.end()
    await server.done
  }
})

test('createService only defers the sweep when the serve wiring asks for it', async () => {
  // `doctor --e2e` builds its service through this same factory and reads the swept state
  // immediately, so the deferral must be the server's wiring, not a factory-wide default.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flash-cli-create-root-')))
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-cli-create-state-')))
  const options = { ...parseOptions([], {}, config), root, isolate: 'copy', slots: 1, stateDir, env: doctorEnv() }
  const immediate = createService(options)
  try {
    assert.equal(immediate.isolation.deferStartupSweep, false)
    assert.equal(immediate.isolation.startupSweepDone, true, 'the constructor already did the work')
    assert.equal(immediate.isolation.startupSweepPending, false, 'nothing is left to wait for')
  } finally {
    await immediate.close()
  }
  const deferred = createService(options, () => {}, { deferStartupSweep: true })
  try {
    assert.equal(deferred.isolation.deferStartupSweep, true)
    assert.equal(deferred.isolation.startupSweepDone, false)
    assert.equal(deferred.isolation.startupSweepPending, true)
  } finally {
    await deferred.close()
  }
})

test('startServer logs the start line first, even when createService throws', () => {
  const missing = join(tmpdir(), `flash-cli-missing-root-${String(Date.now())}`)
  const absentHome = join(tmpdir(), 'flash-cli-start-absent-home')
  const logs = []
  assert.throws(() =>
    startServer(
      {
        root: missing,
        profile: 'flash-service',
        provider: 'ollama',
        model: TEST_MODEL,
        isolate: 'none',
        env: { DSH_HOME: absentHome },
      },
      new PassThrough(),
      new PassThrough(),
      { env: { DSH_HOME: absentHome }, platform: 'win32', log: (line) => logs.push(line) },
    ),
  )
  assert.ok(logs.length > 0, 'the start line is written before the service is built')
  assert.ok(logs[0].startsWith(`start pid ${String(process.pid)}; flash-agents `), logs[0])
  assert.match(logs[0], /; node \d+\.\d+\.\d+; win32; root /)
  assert.ok(logs[0].endsWith(`root ${missing}`), logs[0])
})

test('startServer logs when initialize was answered, timed from process start', async () => {
  const options = serveOptions()
  const logs = []
  const { server, input, frames, send, waitForFrame } = startTestServer(options, {
    startupSweepDelayMs: 60_000,
    log: (line) => logs.push(line),
    uptimeMs: () => 4_321,
  })
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    await waitForFrame(1)
    await waitUntil(() => logs.some((line) => line.startsWith('answered initialize ')))
    assert.equal(frames[0].id, 1)
    assert.ok(logs[0].startsWith('start pid '), logs[0])
    assert.ok(logs.includes('answered initialize 4321 ms after the process started'), JSON.stringify(logs))
  } finally {
    input.end()
    await server.done
  }
})

test('a background call with invalid arguments answers the error and starts no job', async () => {
  const options = serveOptions()
  const service = createService(options)
  const jobs = new JobRegistry()
  const call = createToolCaller({ service, jobs })
  try {
    const refused = await call(
      'flash_task',
      { task: 'inline brief', taskFile: 'brief.txt', cwd: options.root, background: true },
      {},
    )
    assert.equal(refused.isError, true)
    assert.match(refused.content[0].text, /^flash_task failed: task and taskFile cannot both be given/)
    // The job door refused before it created anything, so the listing is empty.
    const status = await call('flash_status', {}, {})
    const payload = JSON.parse(status.content[0].text)
    assert.equal(payload.jobs.length, 0)
    assert.equal(payload.running, 0)
    assert.equal(jobs.list({ state: 'all', limit: 50 }).length, 0)
  } finally {
    await service.close()
  }
})

test('review: a background call with two bad arguments names the one a foreground call names', async () => {
  const options = serveOptions()
  const service = createService(options)
  const jobs = new JobRegistry()
  const call = createToolCaller({ service, jobs })
  try {
    const args = {
      tasks: [{ task: 'x', model: 'not-allowed:cloud' }],
      model: 'also-not-allowed:cloud',
      cwd: options.root,
    }
    const foreground = await call('flash_batch', args, {})
    const background = await call('flash_batch', { ...args, background: true }, {})
    assert.equal(foreground.isError, true)
    assert.equal(background.isError, true)
    // Both calls refuse, but they have to refuse the same argument in the same order:
    // `checkArguments` checks the top-level model before the fleet entries, while the
    // foreground handler checks every entry first.
    assert.equal(background.content[0].text, foreground.content[0].text)
    assert.equal(jobs.list({ state: 'all', limit: 50 }).length, 0, 'no job was created')
  } finally {
    await service.close()
  }
})

test('review: background refusals name the same argument as foreground for two other bad pairs', async () => {
  const options = serveOptions()
  const service = createService(options)
  const jobs = new JobRegistry()
  const call = createToolCaller({ service, jobs })
  const pairs = [
    // A task pair refused before the model, exactly as the foreground handler orders them.
    ['flash_task', { task: 'inline brief', taskFile: 'brief.txt', model: 'not-allowed:cloud', cwd: options.root }],
    // A refused source behind an unreadable task brief: the brief is what the foreground
    // call looks at first, so the background one must not name the source instead.
    ['flash_task', { taskFile: 'missing-brief.txt', source: 'nowhere', cwd: options.root }],
  ]
  try {
    for (const [name, args] of pairs) {
      const foreground = await call(name, args, {})
      const background = await call(name, { ...args, background: true }, {})
      assert.equal(foreground.isError, true, JSON.stringify(args))
      assert.equal(background.isError, true, JSON.stringify(args))
      assert.equal(background.content[0].text, foreground.content[0].text, JSON.stringify(args))
    }
    assert.equal(jobs.list({ state: 'all', limit: 50 }).length, 0, 'no job was created')
  } finally {
    await service.close()
  }
})

// ── --state-base / FLASH_STATE_BASE and the start-up launcher probe ──

test('FLASH_STATE_BASE and --state-base select the default layout’s base', () => {
  assert.equal(parseOptions([], { FLASH_STATE_BASE: '/tmp/flash-base' }, config).stateBase, '/tmp/flash-base')
  assert.equal(
    parseOptions(['--state-base', '/tmp/flag-base'], { FLASH_STATE_BASE: '/tmp/env-base' }, config).stateBase,
    '/tmp/flag-base',
    'the flag wins over the environment',
  )
  assert.equal(parseOptions([], { FLASH_STATE_BASE: '' }, config).stateBase, undefined, 'empty means unset')
  // `--state-dir` keeps its own meaning; the two are separate settings.
  const both = parseOptions(['--state-base', '/tmp/base', '--state-dir', '/tmp/dir'], {}, config)
  assert.equal(both.stateBase, '/tmp/base')
  assert.equal(both.stateDir, '/tmp/dir')
  // A leading ~ expands the way DSH_HOME does; the injected home keeps the test off the
  // real one.
  assert.equal(
    parseOptions([], { FLASH_STATE_BASE: ' ~/flash-base ' }, config, { home: '/home/u' }).stateBase,
    join('/home/u', 'flash-base'),
  )
  assert.equal(parseOptions(['--state-base', '~'], {}, config, { home: '/home/u' }).stateBase, '/home/u')
})

test('a relative state base is refused rather than landing inside the repository', () => {
  const refusal = '--state-base must be an absolute path (got "rel")'
  assert.throws(() => parseOptions(['--state-base', 'rel'], {}, config), (error) => error.message === refusal)
  assert.throws(() => parseOptions([], { FLASH_STATE_BASE: 'rel' }, config), (error) => error.message === refusal)
  // `~user` is not a home-relative path this expands, so it stays relative and is refused.
  assert.throws(
    () => parseOptions(['--state-base', '~someone/x'], {}, config),
    /--state-base must be an absolute path \(got "~someone\/x"\)/,
  )
})

test('the plugin exposes a state_base option and passes it as FLASH_STATE_BASE', () => {
  const plugin = JSON.parse(readFileSync(new URL('../../../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
  const flash = plugin.mcpServers.flash
  // The same wiring as state_dir, so an unset option expands to "" and parseOptions reads
  // that as "not set" (`textFrom`); a configured one reaches the server's option parsing.
  assert.equal(flash.env.FLASH_STATE_BASE, '${user_config.state_base}')
  assert.equal(flash.env.FLASH_STATE_DIR, '${user_config.state_dir}')
  const config = plugin.userConfig.state_base
  assert.equal(config.type, 'directory')
  assert.equal(config.title, 'Base folder for worker copies')
  assert.equal(config.default, plugin.userConfig.state_dir.default)
  assert.equal(config.required, false)
  assert.match(config.description, /base folder for the default per-repository copy layout/i)
  assert.match(config.description, /must be an absolute path/)
})

test('FLASH_STATE_BASE places the slots under <base>/<digest>/<pid>/<instance>', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'flash-cli-base-')))
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flash-cli-base-root-')))
  const service = createService({
    ...parseOptions([], { FLASH_STATE_BASE: base }, config),
    root,
    isolate: 'copy',
    slots: 1,
    env: doctorEnv(),
  })
  try {
    assert.ok(
      service.isolation.stateDir.startsWith(join(base, rootDigest(root), String(process.pid))),
      `the state directory ${service.isolation.stateDir} must sit under ${base}`,
    )
    assert.equal(service.isolation.slots[0].dir, join(service.isolation.stateDir, 'slots', 'slot-0'))
  } finally {
    await service.close()
    rmSync(base, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('--state-dir wins over FLASH_STATE_BASE', async () => {
  const base = '/tmp/flash-cli-base-never-created'
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flash-cli-dir-root-')))
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-cli-dir-state-')))
  const service = createService({
    ...parseOptions([], { FLASH_STATE_BASE: base }, config),
    root,
    isolate: 'copy',
    slots: 1,
    stateDir,
    env: doctorEnv(),
  })
  try {
    assert.equal(service.isolation.stateDir, stateDir)
    assert.equal(existsSync(base), false, 'the losing base is never created')
  } finally {
    await service.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('startServer logs a missing dsh and names a sibling Node launcher at start', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'flash-cli-nvm-')))
  const current = join(base, 'versions', 'node', 'v22.19.0', 'bin', 'node')
  const sibling = join(base, 'versions', 'node', 'v20.19.0', 'bin', 'dsh')
  mkdirSync(join(base, 'versions', 'node', 'v20.19.0', 'bin'), { recursive: true })
  writeFileSync(sibling, '#!/bin/sh\nexit 0\n')
  chmodSync(sibling, 0o755)
  const logs = []
  const options = serveOptions()
  const { server, input, send, waitForFrame } = startTestServer(options, {
    startupSweepDelayMs: 60_000,
    env: { PATH: '', DSH_HOME: ABSENT_DSH_HOME },
    platform: 'linux',
    execPath: current,
    listDir: (directory) => {
      assert.equal(directory, join(base, 'versions', 'node'))
      return ['v22.19.0', 'v20.19.0']
    },
    log: (line) => logs.push(line),
  })
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    await waitForFrame(1)
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    await waitUntil(() => logs.some((line) => line.startsWith('cannot find the dsh launcher')))
    const line = logs.find((candidate) => candidate.startsWith('cannot find the dsh launcher'))
    assert.match(line, /cannot find the dsh launcher for this Node \(v\d+\.\d+\.\d+\)/)
    assert.ok(line.includes(`found one under Node 20.19.0 at ${sibling}`), line)
  } finally {
    input.end()
    await server.done
    rmSync(base, { recursive: true, force: true })
    rmSync(options.root, { recursive: true, force: true })
    rmSync(options.stateDir, { recursive: true, force: true })
  }
})

test('a call without dsh carries the same sibling launcher sentence as the start log', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'flash-cli-nvm-call-')))
  const current = join(base, 'versions', 'node', 'v22.19.0', 'bin', 'node')
  const sibling = join(base, 'versions', 'node', 'v20.19.0', 'bin', 'dsh')
  mkdirSync(join(base, 'versions', 'node', 'v20.19.0', 'bin'), { recursive: true })
  writeFileSync(sibling, '#!/bin/sh\nexit 0\n')
  chmodSync(sibling, 0o755)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flash-cli-nvm-root-')))
  const service = createService(
    {
      ...parseOptions([], {}, config),
      root,
      isolate: 'none',
      env: { PATH: '', DSH_HOME: ABSENT_DSH_HOME },
      resolveDshCommand: (env) =>
        resolveDshCommand(env, 'linux', {
          execPath: current,
          listDir: () => ['v22.19.0', 'v20.19.0'],
          nodeVersion: 'v22.19.0',
        }),
    },
    () => {},
  )
  try {
    await assert.rejects(service.flashTask({ task: 'say hello', cwd: root }), (error) => {
      assert.match(error.message, /cannot find the dsh launcher for this Node \(v22\.19\.0\)/)
      assert.ok(error.message.includes(`found one under Node 20.19.0 at ${sibling}`), error.message)
      assert.match(error.message, /FLASH_DSH_BIN/)
      return true
    })
  } finally {
    await service.close()
    rmSync(base, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
