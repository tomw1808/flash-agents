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

import { resolve } from 'node:path'

import { serveStdio, describeError } from './mcp.js'
import { FlashTaskService } from './service.js'

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
        },
        required: ['tasks'],
        additionalProperties: false,
      },
    },
  ]
}

/** Parse CLI arguments and environment into service options. */
export function parseOptions(argv = process.argv.slice(2), env = process.env) {
  const options = {
    root: env.FLASH_SERVICE_ROOT ?? process.cwd(),
    profile: env.FLASH_SERVICE_PROFILE ?? 'flash-service',
    provider: env.FLASH_SERVICE_PROVIDER ?? 'ollama',
    model: env.FLASH_SERVICE_MODEL ?? 'deepseek-v4.1-flash:cloud',
    taskTimeoutMs: numberFrom(env.FLASH_TASK_TIMEOUT_MS, undefined),
    batchTimeoutMs: numberFrom(env.FLASH_BATCH_TIMEOUT_MS, undefined),
    maxTasks: numberFrom(env.FLASH_MAX_TASKS, undefined),
    perItemChars: numberFrom(env.FLASH_PER_ITEM_CHARS, undefined),
    maxResultChars: numberFrom(env.FLASH_RESULT_MAX_CHARS, undefined),
    maxTokens: numberFrom(env.FLASH_MAX_TOKENS, undefined),
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
  return options
}

const USAGE = `flash-mcp — DeepSeek Harness Flash delegation over MCP stdio

Usage: flash-mcp [options]

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
  -h, --help                show this help

Environment: FLASH_SERVICE_ROOT, FLASH_SERVICE_PROFILE, FLASH_SERVICE_PROVIDER,
FLASH_SERVICE_MODEL, FLASH_TASK_TIMEOUT_MS, FLASH_BATCH_TIMEOUT_MS, FLASH_MAX_TASKS,
FLASH_PER_ITEM_CHARS, FLASH_RESULT_MAX_CHARS, FLASH_MAX_TOKENS, FLASH_DSH_BIN.
`

/**
 * Start the server on stdio.
 * @param {object} [options] - parsed options.
 * @param {NodeJS.ReadableStream} [input] - protocol input.
 * @param {NodeJS.WritableStream} [output] - protocol output.
 * @returns {{service: FlashTaskService, connection: {close: () => void}, done: Promise<void>}}
 */
export function startServer(options, input = process.stdin, output = process.stdout) {
  const log = (message) => process.stderr.write(`[flash-mcp] ${message}\n`)
  const service = new FlashTaskService({ ...options, log })
  log(`root ${service.root}; profile ${service.profile}; route ${service.provider}/${service.model}`)

  const connection = serveStdio({
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
    listTools,
    log,
    input,
    output,
    async callTool(name, args, { signal }) {
      const run =
        name === 'flash_task'
          ? () => service.flashTask(args, { signal })
          : name === 'flash_batch'
            ? () => service.flashBatch(args, { signal })
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

/** Entry point. */
async function main() {
  let options
  try {
    options = parseOptions()
  } catch (error) {
    process.stderr.write(`flash-mcp: ${describeError(error)}\n\n${USAGE}`)
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

const isEntryPoint = process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`
if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(`flash-mcp: ${describeError(error)}\n`)
    process.exit(1)
  })
}
