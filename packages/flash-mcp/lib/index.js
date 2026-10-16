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
import { JobRegistry, JOB_TOOLS } from './jobs.js'
import { loadConfig } from './config.js'
import { formatChecks, runChecks } from './doctor.js'
import { cleanLayout } from './isolation.js'

/** Server identity reported to the MCP client. */
export const SERVER_INFO = Object.freeze({ name: 'flash-mcp', version: '0.1.3' })

/** Usage guidance offered to the client model at handshake. */
const INSTRUCTIONS = [
  'Delegates one bounded task at a time to a cheap DeepSeek Harness worker that runs on',
  'ollama/deepseek-v4.1-flash:cloud inside a workspace-confined sandbox.',
  '',
  'Use flash_task for one coherent, self-contained goal: a feature slice with its tests',
  '(a thousand lines is fine), a fix round of confirmed findings, a read-only map or review,',
  'or a mechanical refactor. Every call is independent — the worker starts with an empty',
  'conversation, so put everything it needs into `task`: the decisions already taken, the',
  'files it owns and must not touch, the tests to write, and the exact verification commands.',
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
  'worker\'s own account of what it did is not evidence that it did it. A long diff is clipped',
  'at a file boundary; `flash_patch` reads the stored patch whole or by file.',
  '',
  'Project facts every worker needs (layout, check commands, style rules) belong in an',
  '`AGENTS.md` or `CLAUDE.md` in the repository: the Harness loads those into every worker',
  'from the repository root down to its working directory, so a task need not repeat them.',
  '',
  'A read-only call cannot build or run tests (both write). For a review that must, run a',
  'writing call with `apply: "discard"`: it works in a throwaway copy and stores nothing.',
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
        'Delegate one coherent task — a feature slice, a fix round, a review — to a cheap DeepSeek Harness worker',
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
            description: 'Optional narrowing of what this call may change. "workspace-write" (the default) confines writes to the service root; "read-only" runs the call in a process whose file sandbox denies every mutation, so it cannot change anything — which also means it cannot build or run tests, since compilers and test runners write (cargo, for one, takes a lock file in target/). For a review that must build or test, use the default mode with apply: "discard" instead. No mode can widen the standing confinement.',
          },
          apply: {
            type: 'string',
            enum: ['none', 'auto', 'discard'],
            description: 'What to do with the change the worker made in its disposable copy. "none" (the default) stores the patch and leaves your tree untouched; "auto" applies it to the service root before returning; "discard" reports the change but stores nothing — for a review that has to build or run tests, which a read-only call cannot. Read change.diff before trusting any of them. A long diff is clipped at a file boundary: change.diffTruncated is then true, change.diffOmitted names the files left out, and flash_patch reads the stored patch whole.',
          },
          source: {
            type: 'string',
            enum: ['working-tree', 'head'],
            description: 'What the disposable copy starts from. "working-tree" (the default) copies your tree as it is, uncommitted edits included, and the result lists them under isolation.uncommittedAtStart. "head" starts from the last commit (ignored files such as dependencies and build output are kept), for a call that must not pick up uncommitted work — for instance another session\'s, in the same tree.',
          },
          background: {
            type: 'boolean',
            description: 'Return at once with a jobId instead of holding your turn while the worker runs (minutes, often). Collect the result with flash_result, watch it with flash_status, stop it with flash_cancel. Meanwhile you can run tests or review an earlier patch.',
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
            description: 'Optional narrowing of what this call may change. "workspace-write" (the default) confines writes to the service root; "read-only" runs the call in a process whose file sandbox denies every mutation, so it cannot change anything — which also means it cannot build or run tests, since compilers and test runners write (cargo, for one, takes a lock file in target/). For a review that must build or test, use the default mode with apply: "discard" instead. No mode can widen the standing confinement.',
          },
          apply: {
            type: 'string',
            enum: ['none', 'auto', 'discard'],
            description: 'What to do with the change the fleet made in its disposable copy. "none" (the default) stores the patch and leaves your tree untouched; "auto" applies it to the service root before returning; "discard" reports the change but stores nothing. Every member shares one copy, so the fleet produces one patch.',
          },
          source: {
            type: 'string',
            enum: ['working-tree', 'head'],
            description: 'What the shared copy starts from: "working-tree" (the default, uncommitted edits included) or "head" (the last commit, ignored files kept).',
          },
          background: {
            type: 'boolean',
            description: 'Return at once with a jobId instead of holding your turn while the fleet runs; collect it with flash_result.',
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
        'If the server that ran a call died before the call finished, the next server on the',
        'same root salvages the unfinished work from the dead server’s tree as a patch. That',
        'salvage is named in the server log (patch id and diffstat) and can be applied here by',
        'id like any other patch.',
        '',
        'Pass `dryRun: true` to check that it still applies without changing anything. A patch that',
        'was already applied is refused; pass `force: true` to apply it again anyway. Patches do not',
        'cross repositories: one computed for another root is refused.',
        '',
        'A patch whose surrounding lines moved meanwhile — another session edited or committed the',
        'same file while the worker ran — fails a plain apply. Pass `threeWay: true` to merge it',
        'instead: the plain apply is still tried first, and the merge uses the base the worker',
        'started from, which the service keeps with the patch. Your index is never touched; a',
        'conflict leaves conflict markers in the named files and is listed in `conflicts`.',
        '`dryRun` with `threeWay` predicts the conflicts without writing anything.',
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
          threeWay: {
            type: 'boolean',
            description: 'When the plain apply fails, merge the patch three ways against the base it was made from.',
          },
        },
        required: ['patchId'],
        additionalProperties: false,
      },
    },
    {
      name: 'flash_patch',
      description: [
        'Read the stored patch a previous flash_task or flash_batch call left behind, whole or one page at a time.',
        '',
        'This reads the same *stored* patch that flash_apply applies — not the possibly-truncated',
        '`change.diff` in the result — so a change too long to read there can still be reviewed before',
        'it is applied. Use it when `change.diffTruncated` is true, or pass `files` to review one file',
        'of a change. It changes nothing.',
        '',
        'Pages end at a file boundary where one fits, so a page never splits a line; pass the returned',
        '`nextOffset` back as `offset` to read the rest, and stop when `nextOffset` is null. `files`',
        'names the files each page covers.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          patchId: {
            type: 'string',
            description: 'The change.patchId from the result of the call whose patch should be read.',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: "Optional: read only these files' sections, named as in change.filesChanged.",
          },
          offset: {
            type: 'integer',
            minimum: 0,
            description: "Character offset into the selected text; use the previous page's nextOffset to continue. Defaults to 0.",
          },
          maxChars: {
            type: 'integer',
            minimum: 1,
            maximum: 200000,
            description: 'Page size in characters. Defaults to the service diff limit, capped at 200000.',
          },
        },
        required: ['patchId'],
        additionalProperties: false,
      },
    },
    ...JOB_TOOLS,
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
    idleTimeoutMs: numberFrom(env.FLASH_IDLE_TIMEOUT_MS, config.limits.idleTimeoutMs),
    maxTasks: numberFrom(env.FLASH_MAX_TASKS, config.limits.maxTasks),
    perItemChars: numberFrom(env.FLASH_PER_ITEM_CHARS, config.limits.perItemChars),
    maxResultChars: numberFrom(env.FLASH_RESULT_MAX_CHARS, config.limits.maxResultChars),
    maxTokens: numberFrom(env.FLASH_MAX_TOKENS, undefined),
    isolate: textFrom(env.FLASH_ISOLATE) ?? 'copy',
    slots: numberFrom(env.FLASH_SLOTS, config.limits.slots),
    stateDir: textFrom(env.FLASH_STATE_DIR),
    copyExclude: listFrom(env.FLASH_COPY_EXCLUDE),
    diffChars: numberFrom(env.FLASH_DIFF_CHARS, config.limits.diffChars),
    patchRetentionDays: numberFrom(env.FLASH_PATCH_RETENTION_DAYS, config.limits.patchRetentionDays),
    maxStateBytes: numberFrom(env.FLASH_MAX_STATE_BYTES, config.limits.maxStateBytes),
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
      case '--copy-exclude':
        options.copyExclude = listFrom(next())
        break
      case '--diff-chars':
        options.diffChars = numberFrom(next(), undefined)
        break
      case '--patch-retention-days':
        options.patchRetentionDays = numberFrom(next(), undefined)
        break
      case '--max-state-bytes':
        options.maxStateBytes = numberFrom(next(), undefined)
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

/**
 * The help text, with every default read from the configuration so it cannot drift from it.
 * A configuration that does not load still gets help; its defaults then point at the file.
 *
 * @returns {string} the usage text.
 */
function usage() {
  let config
  try {
    config = loadConfig()
  } catch {
    config = undefined
  }
  const fallback = 'see flash.config.json'
  const route = config?.route ?? { provider: fallback, model: fallback }
  const limits = config?.limits ?? {}
  const value = (key) => limits[key] ?? fallback
  return `flash-agents — cheap DeepSeek Harness workers over MCP stdio

Usage: flash-agents [serve] [options]           serve the MCP stdio protocol (the default)
       flash-agents doctor [--profile <id>]     check the prerequisites and print the fixes
       flash-agents clean [--all] [--root <path>]
                                                report the state directory per root and
                                                remove dead trees and expired patches

Options:
  --root <path>             sandbox root and runtime working directory (default: cwd)
  --profile <id>            dsh profile to boot (default: flash-service)
  --provider <id>           pinned LLM provider route (default: ${route.provider})
  --model <id>              pinned model on that route (default: ${route.model})
  --timeout-ms <n>          per-task wall-clock budget (default: ${value('taskTimeoutMs')})
  --batch-timeout-ms <n>    per-fleet wall-clock budget (default: ${value('batchTimeoutMs')})
  --max-tasks <n>           tasks accepted in one flash_batch call (default: ${value('maxTasks')})
  --per-item-chars <n>      returned budget for one worker inside a fleet (default: ${value('perItemChars')})
  --max-result-chars <n>    returned child-message budget (default: ${value('maxResultChars')})
  --isolate <mode>          "copy" (default) runs writing calls in a disposable copy of the
                            root; "none" lets workers write to the root directly
  --slots <n>               disposable trees kept in flight, one runtime each (default: ${value('slots')})
  --state-dir <path>        where slot trees and returned patches live (default: a directory
                            private to this root and this process under TMPDIR); a
                            configured directory is shared, so one service per directory
  --copy-exclude <a,b,c>    names left out of a disposable copy: a bare name matches at any
                            depth, one with a slash is a path relative to the root; a match
                            is left out only where git ignores it and tracks nothing under it
                            (default: none; .flash-agents.json may set copyExclude)
  --diff-chars <n>          how much of a patch a result carries (default: ${value('diffChars')})
  --patch-retention-days <n>
                            days an unapplied patch is kept before the startup prune
                            removes it (default: ${value('patchRetentionDays')})
  --max-state-bytes <n>     cap on this root's stored patches and retired trees; over it,
                            retired trees and applied patches are removed, unapplied
                            patches never (default: ${value('maxStateBytes')})
  --log-file <path>         append every diagnostic line, timestamped, to this file as
                            well as stderr
  -h, --help                show this help

Environment: FLASH_SERVICE_ROOT, FLASH_SERVICE_PROFILE, FLASH_SERVICE_PROVIDER,
FLASH_SERVICE_MODEL, FLASH_TASK_TIMEOUT_MS, FLASH_IDLE_TIMEOUT_MS, FLASH_BATCH_TIMEOUT_MS,
FLASH_MAX_TASKS, FLASH_PER_ITEM_CHARS, FLASH_RESULT_MAX_CHARS, FLASH_MAX_TOKENS, FLASH_ISOLATE, FLASH_SLOTS,
FLASH_STATE_DIR, FLASH_COPY_EXCLUDE, FLASH_DIFF_CHARS, FLASH_PATCH_RETENTION_DAYS, FLASH_MAX_STATE_BYTES, FLASH_LOG_FILE,
FLASH_DSH_BIN.

The route and the numeric limits default to flash.config.json, the one file that owns
them. An empty environment value counts as unset, so a generated configuration may
leave a setting blank rather than having to omit it.
`
}

/**
 * Build the MCP tool dispatcher.
 *
 * The synchronous door is unchanged: a call runs on the request's signal and its result is
 * rendered in full. The job door is bolted on in front of it. `background: true` strips the
 * flag and hands the call to a job that owns its own signal and records its progress, then
 * answers with the job id; `background: false` or absent falls through to the synchronous
 * path exactly as before. The three job tools then work on jobs alone.
 *
 * Exported so the dispatch can be driven with a fake service, without a stdio connection.
 *
 * @param {object} options - dispatch wiring.
 * @param {object} options.service - the FlashTaskService, or a stand-in in tests.
 * @param {JobRegistry} options.jobs - the background job registry.
 * @param {(message: string) => void} [options.log] - diagnostic sink.
 * @returns {(name: string, args: object, ctx: {
 *   signal: AbortSignal,
 *   progressToken: string | number | undefined,
 *   sendProgress: (report: object) => void,
 * }) => Promise<object>} the tool caller.
 */
export function createToolCaller({ service, jobs, log = () => {} }) {
  // A thunk, not a call: `flashApply` and `flashPatch` throw synchronously on a bad id, and
  // that throw must land inside the caller's try rather than escape the dispatcher.
  const runFor = (name, args, { signal, progress, progressToken }) =>
    name === 'flash_task'
      ? () => service.flashTask(args, { signal, progress, progressToken })
      : name === 'flash_batch'
        ? () => service.flashBatch(args, { signal, progress, progressToken })
        : name === 'flash_apply'
          ? () => service.flashApply(args)
          : name === 'flash_patch'
            ? () => service.flashPatch(args)
            : undefined

  /**
   * Turn one background call into a running job and answer with its id. The service runs
   * under the job's own signal, so the starting request ending — or being cancelled —
   * cannot reach it, and its progress is recorded on the job instead of notified.
   */
  const startJob = (name, args) => {
    const job = jobs.start({
      kind: name,
      label: jobLabel(name, args),
      run: ({ signal, jobId, progress }) =>
        runFor(name, args, {
          signal,
          progress,
          // The service starts its progress timer only when a request carried a token, and
          // only reads whether one is present. There is no client here, so the job's own id
          // stands in, and every heartbeat reaches the job's recorder.
          progressToken: jobId,
        })(),
    })
    return okResult({
      jobId: job.jobId,
      kind: job.kind,
      state: 'running',
      startedAt: job.startedAt,
      label: job.label,
      note:
        'Running in the background. Use flash_result with this jobId (optionally waitSeconds) to ' +
        'collect its result, flash_status to see its progress, or flash_cancel to stop it.',
    })
  }

  const unknownJob = (tool, jobId) =>
    errorResult(
      `${tool} failed: unknown job ${JSON.stringify(jobId)}. Job ids look like job-xxxxxxxx ` +
        '(8 lowercase hex characters) and live only in the server process that made them: jobs do ' +
        "not survive a restart. After a restart, the call's finished work is still salvaged as a " +
        'patch by the next server, and flash_apply can apply it by id.',
    )

  const statusTool = (args) => {
    const jobId = args?.jobId
    if (jobId === undefined) return okResult({ jobs: jobs.list() })
    if (typeof jobId !== 'string' || jobId.length === 0) {
      return errorResult(`flash_status failed: jobId must be a non-empty string; got ${JSON.stringify(jobId)}`)
    }
    const status = jobs.status(jobId)
    return status === undefined ? unknownJob('flash_status', jobId) : okResult(status)
  }

  const resultTool = async (args, signal) => {
    const jobId = args?.jobId
    if (typeof jobId !== 'string' || jobId.length === 0) {
      return errorResult(`flash_result failed: jobId must be a non-empty string; got ${JSON.stringify(jobId)}`)
    }
    const waitSeconds = args?.waitSeconds ?? 0
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 600) {
      return errorResult(
        `flash_result failed: waitSeconds must be an integer between 0 and 600; got ${JSON.stringify(args?.waitSeconds)}`,
      )
    }
    if (jobs.get(jobId) === undefined) return unknownJob('flash_result', jobId)
    // Waiting is on the *request's* signal: cancelling this call stops the wait, and the job
    // is left untouched, still running.
    const job = waitSeconds > 0 ? await jobs.waitFor(jobId, waitSeconds * 1000, signal) : jobs.get(jobId)
    if (job === undefined) return unknownJob('flash_result', jobId)
    // Project the job already held rather than looking it up again by id: the sweep may have
    // evicted it while this request waited, and a second lookup that comes back undefined
    // used to throw a TypeError straight out of the dispatcher.
    const status = jobs.statusOf(job)
    if (job.state === 'running') {
      return okResult({
        jobId: job.jobId,
        state: 'running',
        elapsedMs: status.elapsedMs,
        ...(status.lastProgress === undefined ? {} : { lastProgress: status.lastProgress }),
      })
    }
    if (job.state === 'ok') {
      // The caller has the result now; the cap may reclaim the job under pressure, so the
      // one result it is allowed to drop is the one already delivered.
      job.collected = true
      // The call's full result, exactly as the synchronous call would have returned it, plus
      // the job's identity so the caller can tie it back to the id it holds.
      return okResult({ ...job.result, job: { jobId: job.jobId, state: 'ok', elapsedMs: status.elapsedMs } })
    }
    // Failed or cancelled: the same message the synchronous dispatch would have produced.
    return errorResult(`${job.kind} failed: ${describeError(job.error)} (job ${job.jobId})`)
  }

  const cancelTool = async (args) => {
    const jobId = args?.jobId
    if (typeof jobId !== 'string' || jobId.length === 0) {
      return errorResult(`flash_cancel failed: jobId must be a non-empty string; got ${JSON.stringify(jobId)}`)
    }
    const job = jobs.get(jobId)
    if (job === undefined) return unknownJob('flash_cancel', jobId)
    if (job.state !== 'running') {
      return okResult({
        ...jobs.statusOf(job),
        note: `the job had already ended as ${job.state}; flash_cancel did nothing`,
      })
    }
    jobs.cancel(jobId)
    // The service's cancellation path retires a writing call's tree and shuts its runtime
    // down; the call normally settles at once, but a runtime shutdown can take longer, so the
    // wait is bounded and the status is returned either way. `waitFor` hands back the job it
    // held, and projecting that (rather than a fresh lookup) is what keeps an evicted job
    // from turning into a TypeError here.
    const settled = (await jobs.waitFor(jobId, 30_000)) ?? job
    const status = jobs.statusOf(settled)
    return okResult({
      ...status,
      note:
        status.state === 'running'
          ? 'the job is still running; its call has not settled yet'
          : 'the job settled after cancellation',
    })
  }

  return async function callTool(name, args = {}, { signal, progressToken, sendProgress } = {}) {
    // Jobs first. A background call must answer at once and must not own the starting
    // request's signal, and the three job tools are about jobs rather than one synchronous call.
    if (name === 'flash_task' || name === 'flash_batch') {
      const background = args.background
      if (background !== undefined) {
        if (typeof background !== 'boolean') {
          return errorResult(`${name} failed: background must be a boolean; got ${JSON.stringify(background)}`)
        }
        args = omit(args, 'background')
        if (background) return startJob(name, args)
      }
    }
    if (name === 'flash_status') return statusTool(args)
    if (name === 'flash_result') return await resultTool(args, signal)
    if (name === 'flash_cancel') return await cancelTool(args)

    const run = runFor(name, args, { signal, progress: sendProgress, progressToken })
    if (run === undefined) return errorResult(`unknown tool "${name}"`)
    try {
      return okResult(await run())
    } catch (error) {
      log(`${name} failed: ${describeError(error)}`)
      return errorResult(`${name} failed: ${describeError(error)}`)
    }
  }
}

/** One MCP tool result, in the shape the synchronous path uses. */
function okResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  }
}

/** One MCP tool error, formatted like the synchronous path's failures. */
function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

/** A shallow copy of `args` without one property; never mutates the caller's object. */
function omit(args, key) {
  if (args === null || typeof args !== 'object') return {}
  const { [key]: _dropped, ...rest } = args
  return rest
}

/**
 * The one-line label a job carries into `flash_status` and the log. It is read from the raw
 * arguments, before the service validates them, because a background call must answer at
 * once; a malformed call ends failed and keeps this label.
 */
function jobLabel(kind, args) {
  if (kind === 'flash_batch') {
    const count = Array.isArray(args?.tasks) ? args.tasks.length : 0
    return `${String(count)} tasks`
  }
  const firstLine = typeof args?.task === 'string' ? args.task.split('\n')[0].trim() : ''
  return clip(firstLine.length === 0 ? '(untitled task)' : firstLine, 80)
}

/** Bound a label to the width a status line is read at. */
function clip(text, maxChars) {
  return text.length <= maxChars ? text : text.slice(0, maxChars)
}

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
      ...(options.copyExclude === undefined ? {} : { copyExclude: options.copyExclude }),
      ...(options.diffChars === undefined ? {} : { diffChars: options.diffChars }),
      ...(options.patchRetentionDays === undefined ? {} : { patchRetentionDays: options.patchRetentionDays }),
      ...(options.maxStateBytes === undefined ? {} : { maxStateBytes: options.maxStateBytes }),
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
    callTool: createToolCaller({ service, jobs: new JobRegistry({ log }), log }),
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
 * Read a comma-separated list setting, where an unset or empty value means "no list at all".
 *
 * Entries are trimmed and empty ones dropped, so `--copy-exclude target, node_modules` and
 * `FLASH_COPY_EXCLUDE=target,node_modules` parse the same; an empty string stays `undefined`
 * rather than becoming `[]`, so a caller can tell "unset" from "explicitly nothing".
 *
 * @param {unknown} value - the raw environment value or flag argument.
 * @returns {string[] | undefined} the entries, or undefined when there are none.
 */
function listFrom(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  return entries.length === 0 ? undefined : entries
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
 * @param {{command: string, prefix: string[]}} [options.launcher] - dsh launcher handed to the checks.
 * @returns {Promise<number>} the exit code: 0 when nothing failed.
 */
export async function runDoctor(argv = [], { env = process.env, write, run, probe, launcher } = {}) {
  const emit = write ?? ((text) => process.stdout.write(text))
  const config = loadConfig({ env })
  const at = argv.indexOf('--profile')
  const result = await runChecks({
    env,
    model: config.route.model,
    dshVersion: config.dsh.version,
    profile: at < 0 ? (textFrom(env.FLASH_SERVICE_PROFILE) ?? 'flash-service') : argv[at + 1],
    ...(run === undefined ? {} : { run }),
    ...(probe === undefined ? {} : { probe }),
    ...(launcher === undefined ? {} : { launcher }),
  })
  emit(`${formatChecks(result)}\n`)
  emit(
    result.ok
      ? `\nall required checks passed${result.warnings === 0 ? '' : ` (${String(result.warnings)} warning(s))`}\n`
      : `\n${String(result.failures)} check(s) failed; run the fixes above and try again\n`,
  )
  return result.ok ? 0 : 1
}

/** Format a byte count as megabytes, the unit the state report is read in. */
function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The canonical spelling of a service root, so it matches its digest directory.
 * The service builds its own root with `realpathSync(resolve(root))`, so the same
 * resolver is used here; otherwise `clean` could name the wrong digest for a root
 * reached through a symlink.
 * @param {string} root - the configured or current root.
 * @returns {string} its real path when it exists, else the resolved path.
 */
function canonicalRoot(root) {
  const absolute = resolve(root)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

const CLEAN_USAGE = `flash-agents clean — report and reclaim the flash-mcp state directory

Usage: flash-agents clean [--all] [--root <path>] [--patch-retention-days <n>]

  --all                      also remove the slot trees of roots with no live server
  --root <path>              service root whose digest is swept (default: cwd)
  --patch-retention-days <n> days an unapplied patch is kept (default: flash.config.json)

The default removes what a server startup removes for --root: dead owners (salvaging
their unfinished trees as patches), expired patches, and other roots' empty digest
directories. Patches are never removed by --all.
`

/**
 * Report and reclaim the state directory, one line per root digest.
 *
 * The layout it reads is the default one the service writes: `$TMPDIR/flash-mcp` with
 * one digest directory per root, one directory per server pid under it, and a
 * `patches/` directory that outlives the process that issued the patches. Sizes are
 * printed in MB because the report answers a disk question, not a file-count one.
 *
 * @param {string[]} [argv] - arguments after `clean`.
 * @param {object} [options] - injected effects, for tests.
 * @param {Record<string, string | undefined>} [options.env] - environment to read.
 * @param {(text: string) => void} [options.write] - output sink.
 * @param {string} [options.baseDir] - the state base directory, for tests.
 * @param {number} [options.now] - the current time, for tests.
 * @returns {Promise<number>} the exit code: 0 unless an argument is unknown.
 */
export async function runClean(argv = [], { env = process.env, write, baseDir, now } = {}) {
  const emit = write ?? ((text) => process.stdout.write(text))
  let all = false
  let root = textFrom(env.FLASH_SERVICE_ROOT) ?? process.cwd()
  /** @type {number | undefined} */
  let retentionDays
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${flag} needs a value`)
      return argv[index]
    }
    if (flag === '--all') all = true
    else if (flag === '--root') root = next()
    else if (flag === '--patch-retention-days') retentionDays = numberFrom(next(), undefined)
    else if (flag === '--help' || flag === '-h') {
      emit(CLEAN_USAGE)
      return 0
    } else throw new Error(`unknown argument "${flag}"`)
  }
  const config = loadConfig({ env })
  const report = cleanLayout({
    ...(baseDir === undefined ? {} : { baseDir }),
    root: canonicalRoot(root),
    all,
    retentionDays: retentionDays ?? config.limits.patchRetentionDays,
    ...(now === undefined ? {} : { now }),
    log: (message) => emit(`[flash-mcp clean] ${message}\n`),
  })
  emit(`flash-mcp state: ${report.baseDir}\n`)
  for (const entry of report.stats) {
    const pids = entry.livePids.length === 0 ? 'none' : entry.livePids.join(', ')
    emit(
      `${entry.digest}${entry.own ? ' (this root)' : ''}  live pids: ${pids} | ` +
        `slot trees: ${String(entry.slotTrees)} (${formatMb(entry.slotBytes)}) | ` +
        `patches: ${String(entry.patches)} (${formatMb(entry.patchBytes)})\n`,
    )
  }
  const { actions } = report
  emit(
    `removed: ${String(actions.deadOwnersRemoved)} dead owner(s), ${String(actions.patchesPruned)} expired patch(es), ` +
      `${String(actions.emptyDigestsRemoved)} empty digest(s)` +
      (all ? `, ${String(actions.foreignTreesRemoved)} foreign tree(s)` : '') +
      '\n',
  )
  return 0
}

/** Entry point: one subcommand, or the server when none is named. */
async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0] === undefined || argv[0].startsWith('-') ? 'serve' : argv.shift()
  if (command === 'doctor') {
    process.exit(await runDoctor(argv))
  }
  if (command === 'clean') {
    try {
      process.exit(await runClean(argv))
    } catch (error) {
      process.stderr.write(`flash-agents: ${describeError(error)}\n\n${CLEAN_USAGE}`)
      process.exit(2)
    }
  }
  if (command !== 'serve') {
    process.stderr.write(`flash-agents: unknown command "${command}"\n\n${usage()}`)
    process.exit(2)
  }
  let options
  try {
    options = parseOptions(argv)
  } catch (error) {
    process.stderr.write(`flash-agents: ${describeError(error)}\n\n${usage()}`)
    process.exit(2)
  }
  if (options.help) {
    process.stdout.write(usage())
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
