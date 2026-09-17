#!/usr/bin/env node
/**
 * `flash-mcp` — a local stdio MCP server exposing DeepSeek Harness Flash
 * delegation to a coding agent.
 *
 *   Claude Code ──MCP stdio──► flash-mcp ──SDK JSON-RPC stdio──► dsh --profile flash-service
 *
 * The Harness runtime is a separate, persistent child process (never embedded),
 * reached only through the shipped SDK protocol. Nothing is scraped from its
 * output: stdout carries protocol frames, and stderr is kept as a diagnostic
 * tail. Routing, subagent lifecycle, tool permissions, and limits stay inside
 * Harness; this process only names the contract and forwards one prompt.
 *
 * stdout is reserved for MCP frames — all diagnostics go to stderr.
 *
 * @module flash-mcp
 */

import { appendFileSync, openSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { serveStdio, describeError } from './mcp.js'
import { FlashTaskService } from './service.js'
import { loadConfig } from './config.js'
import { formatChecks, runChecks } from './doctor.js'

/** Server identity reported to the MCP client. */
export const SERVER_INFO = Object.freeze({ name: 'flash-mcp', version: '0.1.0' })

/** Usage guidance offered to the client model at handshake. */
const INSTRUCTIONS = [
  'Delegates one bounded task at a time to a cheap DeepSeek Harness worker that runs on',
  'ollama/deepseek-v4.1-flash:cloud inside a workspace-confined sandbox.',
  '',
  'Use flash_task for narrow, self-contained work: reading, searching, summarizing, and',
  'small repository-local edits. Every call is independent — the worker starts with an',
  'empty conversation, so put everything it needs into `task`.',
  '',
  'Use flash_batch to hand off a fleet of independent tasks in one call: the Harness workflow',
  'engine fans them out under its own concurrency and total-agent caps, and each task returns',
  'its own compact result in task order.',
  '',
  'The service is confined to its configured root. A `cwd` outside that root is rejected,',
  'and worker operations outside it are denied by the Harness sandbox rather than executed.',
  '',
  'A writing call does not run in your repository: it runs in a disposable copy of it, and its',
  'result carries the change it made (`change.filesChanged`, `change.diffstat`, `change.diff`).',
  'Nothing reaches your tree until you apply it — pass `apply: "auto"` to apply a call\'s change',
  'immediately, or call `flash_apply` with the `change.patchId` afterwards. Review the diff; the',
  'worker\'s own account of what it did is not evidence that it did it.',
].join('\n')

/**
 * The tools exposed by this service.
 *
 * Both are one-door contracts: neither carries a model, provider, or effort
 * argument, because routing is not a caller capability.
 *
 * @returns {Array<object>} MCP tool descriptors.
 */
export function listTools() {
  return [
    {
      name: 'flash_task',
      description: [
        'Delegate one narrow task to a cheap DeepSeek Harness worker',
        '(ollama/deepseek-v4.1-flash:cloud) and return its compact result.',
        '',
        'The worker runs in a fresh conversation inside a sandbox confined to the service',
        'root: repository-local reads, edits, and commands work without approval, while',
        'anything outside that root is denied. The task must be self-contained.',
        '',
        'Returns the worker\'s terminal status, stop reason, observed model route, and final',
        'message — not its transcript.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'The complete, self-contained task for the worker, including any context it needs.',
          },
          cwd: {
            type: 'string',
            description: 'Absolute working directory for the worker. Must be inside the service root.',
          },
          acceptance: {
            type: 'string',
            description: 'Optional acceptance criteria describing what a correct result looks like.',
          },
          mode: {
            type: 'string',
            enum: ['workspace-write', 'read-only'],
            description: 'Optional narrowing of what this call may change. "workspace-write" (the default) confines writes to the service root; "read-only" runs the call in a process whose file sandbox denies every mutation, so it cannot change anything. No mode can widen the standing confinement.',
          },
          apply: {
            type: 'string',
            enum: ['none', 'auto'],
            description: 'What to do with the change the worker made in its disposable copy. "none" (the default) returns the diff and leaves your tree untouched; "auto" applies it to the service root before returning. Read change.diff before trusting either — and note that a diff is clipped when change.diffTruncated is true, while flash_apply always uses the stored full patch.',
          },
        },
        required: ['task', 'cwd'],
        additionalProperties: false,
      },
    },
    {
      name: 'flash_batch',
      description: [
        'Delegate several independent tasks at once to cheap DeepSeek Harness workers',
        '(ollama/deepseek-v4.1-flash:cloud), and return one compact result per task.',
        '',
        'Split the work yourself and send explicit tasks: each becomes one worker in a fresh',
        'conversation, and the fleet runs in parallel under the Harness workflow engine\'s own',
        'concurrency and total-agent caps. Results come back in task order, so index i is',
        'always the result of tasks[i].',
        '',
        'The whole fleet shares one sandbox root, and any `cwd` outside it is rejected.',
        '',
        'Both tools accept `mode: "read-only"` for work that must not change anything: the call',
        'then runs in a process whose sandbox denies every mutation, and the result reports the',
        'mode it ran under.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            minItems: 1,
            description:
              'The tasks to delegate, each either a self-contained task string or an object with its own acceptance criteria.',
            items: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    task: { type: 'string', description: 'The complete, self-contained task.' },
                    acceptance: { type: 'string', description: 'Optional acceptance criteria for this task.' },
                  },
                  required: ['task'],
                  additionalProperties: false,
                },
              ],
            },
          },
          cwd: {
            type: 'string',
            description: 'Absolute working directory shared by every worker. Must be inside the service root.',
          },
          acceptance: {
            type: 'string',
            description: 'Optional acceptance criteria applied to every task that does not carry its own.',
          },
          mode: {
            type: 'string',
            enum: ['workspace-write', 'read-only'],
            description: 'Optional narrowing of what this call may change. "workspace-write" (the default) confines writes to the service root; "read-only" runs the call in a process whose file sandbox denies every mutation, so it cannot change anything. No mode can widen the standing confinement.',
          },
          apply: {
            type: 'string',
            enum: ['none', 'auto'],
            description: 'What to do with the change the fleet made in its disposable copy. "none" (the default) returns the diff and leaves your tree untouched; "auto" applies it to the service root before returning. Every member shares one copy, so the fleet produces one patch.',
          },
        },
        required: ['tasks'],
        additionalProperties: false,
      },
    },
    {
      name: 'flash_apply',
      description: [
        'Apply the change a previous flash_task or flash_batch call left in its disposable copy.',
        '',
        'Workers never write to your repository: each writing call runs in a copy of it and returns',
        'a patch. This applies that patch to the service root. The patch is computed by the service',
        'from the copy, so it contains exactly what the worker changed — including deletions and new',
        'files — and nothing else.',
        '',
        'The patch applied here is the *stored* one, not the possibly-truncated `change.diff`',
        'in the result, so a long change still applies whole.',
        '',
        'Pass `dryRun: true` to check that it still applies without changing anything. A patch that',
        'was already applied is refused; pass `force: true` to apply it again anyway. Patches do not',
        'cross repositories: one computed for another root is refused.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          patchId: {
            type: 'string',
            description: 'The change.patchId from the result of the call whose work should be applied.',
          },
          dryRun: {
            type: 'boolean',
            description: 'Check that the patch applies without writing anything.',
          },
          force: {
            type: 'boolean',
            description: 'Apply the patch even though the record says it was already applied to this root.',
          },
        },
        required: ['patchId'],
        additionalProperties: false,
      },
    },
  ]
}

/**
 * Parse CLI arguments and environment into service options.
 *
 * Defaults come from `flash.config.json` rather than from literals here, so the
 * route and the numeric limits have one home. Environment values are read through
 * `textFrom`, which treats an empty string as unset: a plugin manifest expands an
 * unset setting to `""`, and `--isolate ""` would otherwise be a startup error.
 *
 * @param {string[]} [argv] - arguments after the command name.
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @param {object} [config] - resolved configuration; loaded from disk by default.
 * @returns {object} the service options.
 */
export function parseOptions(argv = process.argv.slice(2), env = process.env, config = loadConfig({ env })) {
  const options = {
    root: textFrom(env.FLASH_SERVICE_ROOT) ?? process.cwd(),
    profile: textFrom(env.FLASH_SERVICE_PROFILE) ?? 'flash-service',
    provider: config.route.provider,
    model: config.route.model,
    taskTimeoutMs: numberFrom(env.FLASH_TASK_TIMEOUT_MS, config.limits.taskTimeoutMs),
    batchTimeoutMs: numberFrom(env.FLASH_BATCH_TIMEOUT_MS, config.limits.batchTimeoutMs),
    maxTasks: numberFrom(env.FLASH_MAX_TASKS, config.limits.maxTasks),
    perItemChars: numberFrom(env.FLASH_PER_ITEM_CHARS, config.limits.perItemChars),
    maxResultChars: numberFrom(env.FLASH_RESULT_MAX_CHARS, config.limits.maxResultChars),
    maxTokens: numberFrom(env.FLASH_MAX_TOKENS, undefined),
    isolate: textFrom(env.FLASH_ISOLATE) ?? 'copy',
    slots: numberFrom(env.FLASH_SLOTS, config.limits.slots),
    stateDir: textFrom(env.FLASH_STATE_DIR),
    diffChars: numberFrom(env.FLASH_DIFF_CHARS, config.limits.diffChars),
    logFile: textFrom(env.FLASH_LOG_FILE),
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${flag} needs a value`)
      return argv[index]
    }
    switch (flag) {
      case '--root':
        options.root = next()
        break
      case '--profile':
        options.profile = next()
        break
      case '--provider':
        options.provider = next()
        break
      case '--model':
        options.model = next()
        break
      case '--timeout-ms':
        options.taskTimeoutMs = numberFrom(next(), undefined)
        break
      case '--max-result-chars':
        options.maxResultChars = numberFrom(next(), undefined)
        break
      case '--isolate':
        options.isolate = next()
        break
      case '--slots':
        options.slots = numberFrom(next(), undefined)
        break
      case '--state-dir':
        options.stateDir = next()
        break
      case '--diff-chars':
        options.diffChars = numberFrom(next(), undefined)
        break
      case '--log-file':
        options.logFile = next()
        break
      case '--batch-timeout-ms':
        options.batchTimeoutMs = numberFrom(next(), undefined)
        break
      case '--max-tasks':
        options.maxTasks = numberFrom(next(), undefined)
        break
      case '--per-item-chars':
        options.perItemChars = numberFrom(next(), undefined)
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`unknown argument "${flag}"`)
    }
  }
  if (options.isolate !== 'copy' && options.isolate !== 'none') {
    throw new Error(`--isolate ${JSON.stringify(options.isolate)} is not available; use "copy" (default) or "none"`)
  }
  return options
}

const USAGE = `flash-agents — cheap DeepSeek Harness workers over MCP stdio

Usage: flash-agents [serve] [options]           serve the MCP stdio protocol (the default)
       flash-agents doctor [--profile <id>]     check the prerequisites and print the fixes

Options:
  --root <path>             sandbox root and runtime working directory (default: cwd)
  --profile <id>            dsh profile to boot (default: flash-service)
  --provider <id>           pinned LLM provider route (default: ollama)
  --model <id>              pinned model on that route (default: deepseek-v4.1-flash:cloud)
  --timeout-ms <n>          per-task wall-clock budget (default: 300000)
  --batch-timeout-ms <n>    per-fleet wall-clock budget (default: 900000)
  --max-tasks <n>           tasks accepted in one flash_batch call (default: 16)
  --per-item-chars <n>      returned budget for one worker inside a fleet (default: 4000)
  --max-result-chars <n>    returned child-message budget (default: 8000)
  --isolate <mode>          "copy" (default) runs writing calls in a disposable copy of the
                            root; "none" lets workers write to the root directly
  --slots <n>               disposable trees kept in flight, one runtime each (default: 2)
  --state-dir <path>        where slot trees and returned patches live (default: a directory
                            private to this root and this process under TMPDIR); a
                            configured directory is shared, so one service per directory
  --diff-chars <n>          how much of a patch a result carries (default: 20000)
  --log-file <path>         append every diagnostic line, timestamped, to this file as
                            well as stderr
  -h, --help                show this help

Environment: FLASH_SERVICE_ROOT, FLASH_SERVICE_PROFILE, FLASH_SERVICE_PROVIDER,
FLASH_SERVICE_MODEL, FLASH_TASK_TIMEOUT_MS, FLASH_BATCH_TIMEOUT_MS, FLASH_MAX_TASKS,
FLASH_PER_ITEM_CHARS, FLASH_RESULT_MAX_CHARS, FLASH_MAX_TOKENS, FLASH_ISOLATE, FLASH_SLOTS,
FLASH_STATE_DIR, FLASH_DIFF_CHARS, FLASH_LOG_FILE, FLASH_DSH_BIN.

The route and the numeric limits default to flash.config.json, the one file that owns
them. An empty environment value counts as unset, so a generated configuration may
leave a setting blank rather than having to omit it.
`

/**
 * Start the server on stdio.
 * @param {object} [options] - parsed options.
 * @param {NodeJS.ReadableStream} [input] - protocol input.
 * @param {NodeJS.WritableStream} [output] - protocol output.
 * @returns {{service: FlashTaskService, connection: {close: () => void}, done: Promise<void>}}
 */
export function startServer(options, input = process.stdin, output = process.stdout) {
  const logFile =
    typeof options.logFile === 'string' && options.logFile.length > 0 ? options.logFile : undefined
  /** Open the append target once; any failure degrades to stderr-only logging. */
  let logFd
  const reportLogFileFailure = (error) => {
    process.stderr.write(
      `[flash-mcp] log file ${JSON.stringify(logFile)} unavailable (${describeError(error)}); ` +
        'continuing with stderr-only logging\n',
    )
  }
  if (logFile !== undefined) {
    try {
      logFd = openSync(logFile, 'a')
    } catch (error) {
      reportLogFileFailure(error)
      logFd = undefined
    }
  }
  const log = (message) => {
    const line = `[flash-mcp] ${message}`
    process.stderr.write(`${line}\n`)
    if (logFd === undefined) return
    try {
      appendFileSync(logFd, `${new Date().toISOString()} ${line}\n`)
    } catch (error) {
      logFd = undefined
      reportLogFileFailure(error)
    }
  }
  const service = new FlashTaskService({
    ...options,
    isolate: {
      mode: options.isolate,
      ...(options.slots === undefined ? {} : { slots: options.slots }),
      ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
      ...(options.diffChars === undefined ? {} : { diffChars: options.diffChars }),
    },
    log,
  })
  log(`root ${service.root}; profile ${service.profile}; route ${service.provider}/${service.model}`)
  if (service.isolation === undefined) {
    log(
      'WARNING: isolation is off (--isolate none). Workers will write to the root directly; ' +
        'a destructive command can only be caught by the flash-guard wall, which is a denylist.',
    )
  } else {
    log(`isolation: ${String(service.isolation.size)} disposable tree(s) under ${service.stateDir}`)
  }

  const connection = serveStdio({
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
    listTools,
    log,
    input,
    output,
    async callTool(name, args, { signal, progressToken, sendProgress }) {
      const run =
        name === 'flash_task'
          ? () => service.flashTask(args, { signal, progress: sendProgress, progressToken })
          : name === 'flash_batch'
            ? () => service.flashBatch(args, { signal, progress: sendProgress, progressToken })
            : name === 'flash_apply'
              ? () => service.flashApply(args)
              : undefined
      if (run === undefined) {
        return { content: [{ type: 'text', text: `unknown tool "${name}"` }], isError: true }
      }
      try {
        const result = await run()
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        }
      } catch (error) {
        log(`${name} failed: ${describeError(error)}`)
        return {
          content: [{ type: 'text', text: `${name} failed: ${describeError(error)}` }],
          isError: true,
        }
      }
    },
  })

  const done = new Promise((resolveDone) => {
    const finish = async () => {
      connection.close()
      output.off?.('close', finish)
      await service.close().catch((error) => log(`runtime shutdown failed: ${describeError(error)}`))
      resolveDone()
    }
    input.on('end', () => void finish())
    input.on('close', () => void finish())
    output.on?.('close', () => void finish())
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => void finish().then(() => process.exit(0)))
    }
  })

  return { service, connection, done }
}

function numberFrom(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Read a setting that must be a non-empty string, or nothing at all.
 *
 * An unset plugin setting expands to an empty string rather than disappearing, so
 * `""` has to mean "unset" everywhere a value is optional.
 *
 * @param {unknown} value - the raw environment value.
 * @returns {string | undefined} the value, or undefined when it is absent or empty.
 */
function textFrom(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Run the prerequisite checks and print them, fixes included.
 *
 * The model and the minimum harness version come from the same configuration the
 * server runs on, so the doctor cannot approve a setup the service would reject.
 *
 * @param {string[]} [argv] - arguments after the command name.
 * @param {object} [options] - injected effects, for tests.
 * @param {Record<string, string | undefined>} [options.env] - environment to read.
 * @param {(text: string) => void} [options.write] - output sink.
 * @param {Function} [options.run] - command runner handed to the checks.
 * @param {Function} [options.probe] - HTTP probe handed to the checks.
 * @returns {Promise<number>} the exit code: 0 when nothing failed.
 */
export async function runDoctor(argv = [], { env = process.env, write, run, probe } = {}) {
  const emit = write ?? ((text) => process.stdout.write(text))
  const config = loadConfig({ env })
  const at = argv.indexOf('--profile')
  const result = await runChecks({
    env,
    model: config.route.model,
    minDshVersion: config.dsh.minVersion,
    profile: at < 0 ? (textFrom(env.FLASH_SERVICE_PROFILE) ?? 'flash-service') : argv[at + 1],
    ...(run === undefined ? {} : { run }),
    ...(probe === undefined ? {} : { probe }),
  })
  emit(`${formatChecks(result)}\n`)
  emit(
    result.ok
      ? `\nall required checks passed${result.warnings === 0 ? '' : ` (${String(result.warnings)} warning(s))`}\n`
      : `\n${String(result.failures)} check(s) failed; run the fixes above and try again\n`,
  )
  return result.ok ? 0 : 1
}

/** Entry point: one subcommand, or the server when none is named. */
async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0] === undefined || argv[0].startsWith('-') ? 'serve' : argv.shift()
  if (command === 'doctor') {
    process.exit(await runDoctor(argv))
  }
  if (command !== 'serve') {
    process.stderr.write(`flash-agents: unknown command "${command}"\n\n${USAGE}`)
    process.exit(2)
  }
  let options
  try {
    options = parseOptions(argv)
  } catch (error) {
    process.stderr.write(`flash-agents: ${describeError(error)}\n\n${USAGE}`)
    process.exit(2)
  }
  if (options.help) {
    process.stdout.write(USAGE)
    return
  }
  options.root = resolve(options.root)
  const { done } = startServer(options)
  await done
}

/**
 * Whether this module is the program the user actually ran.
 *
 * `import.meta.url` is a percent-encoded real path, while `process.argv[1]` is
 * whatever the shell was given: a symlink (`node_modules/.bin/flash-mcp`, `npm
 * link`, `npx`) and a path with spaces or non-ASCII characters all differ from it.
 * Comparing the two literally made the server exit silently in those cases — the
 * client only saw the connection close. Resolve both sides to a canonical file URL.
 *
 * @returns {boolean} true when this file is the entry point.
 */
function isEntryPoint() {
  const invoked = process.argv[1]
  if (invoked === undefined || invoked === '') return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href
  } catch {
    // A path that cannot be resolved is not this module.
    return false
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    process.stderr.write(`flash-mcp: ${describeError(error)}\n`)
    process.exit(1)
  })
}
