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

import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { serveStdio, describeError } from './mcp.js'
import { DEFAULT_MODEL, FlashTaskService } from './service.js'
import { DEFAULT_INITIALIZE_TIMEOUT_MS } from './sdk.js'
import { JobRegistry, JOB_TOOLS } from './jobs.js'
import { allowedModels, loadConfig } from './config.js'
import { formatChecks, resolveDshHome, runChecks } from './doctor.js'
import { WorkspaceIsolation, cleanLayout } from './isolation.js'

/** Server identity reported to the MCP client. */
export const SERVER_INFO = Object.freeze({ name: 'flash-mcp', version: '0.1.6' })

/**
 * How often a `flash_result` call that is waiting tells the MCP client it is alive. The
 * client aborts a tool call that shows no sign of life for its own idle timeout, and the
 * wait can be minutes; the notification resets that clock and says what is being waited on.
 */
export const WAIT_PROGRESS_INTERVAL_MS = 30_000

/**
 * Usage guidance offered to the client model at handshake.
 *
 * The model names come from the allowlist the server was started with, never from a
 * literal here: the configured default is named as the default, and the other allowed
 * models are named as choices a call may make.
 *
 * @param {string[]} [models] - the allowed models, the default first.
 * @returns {string} the instructions text.
 */
export function instructionsFor(models = [DEFAULT_MODEL]) {
  const [primary, ...others] = modelChoices(undefined, models)
  const choices =
    others.length === 0
      ? `${primary} is the default and suits a quick hand-off.`
      : `${primary} is the default and suits a quick hand-off; ${others.join(', ')} can be chosen per call.`
  return [
    'Delegates one bounded task at a time to a cheap DeepSeek Harness worker inside a',
    'workspace-confined sandbox.',
    '',
    'Each call may choose its worker model from the allowed list:',
    choices,
    "The result's route reports the model that actually ran.",
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
    'Every result reports what they cost under `instructions` (files, bytes, approximate tokens);',
    'past the harness\'s 64 KB budget a warning says the worker was only given part of them.',
    '',
    'A read-only call cannot build or run tests (both write). For a review that must, run a',
    'writing call with `apply: "discard"`: it works in a throwaway copy and stores nothing.',
  ].join('\n')
}

/**
 * The tools exposed by this service.
 *
 * The delegation tools are one-door contracts apart from `model`: the provider and the
 * effort are not caller capabilities, but a call may choose one of the models the user
 * allowed. The schema's `enum` is that allowlist, so a client cannot even offer another.
 *
 * @param {string[]} [models] - the allowed models, the default first.
 * @returns {Array<object>} MCP tool descriptors.
 */
export function listTools(models = [DEFAULT_MODEL]) {
  const choices = modelChoices(undefined, models)
  const [primary, ...others] = choices
  const allowed = others.length === 0 ? '' : `; ${others.join(', ')} may be chosen per call`
  return [
    {
      name: 'flash_task',
      description: [
        'Delegate one coherent task — a feature slice, a fix round, a review — to a cheap DeepSeek Harness worker',
        'and return its compact result. Each call may name one of the allowed worker models; omitted, the',
        `default ${primary} runs.`,
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
            description:
              'The complete, self-contained task for the worker, including any context it needs. Pass exactly one of task and taskFile.',
          },
          taskFile: {
            type: 'string',
            description:
              'Path to a UTF-8 file holding the task text, sent exactly as written — for a long brief that would otherwise have to be pasted. A relative path resolves against the service root, and the file must resolve inside it; it must be a regular file of at most 256 KB. Pass exactly one of task and taskFile.',
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
          basePatch: {
            type: 'string',
            description: "A patchId from an earlier writing call. Its change is applied to this call's copy before the worker starts (three-way merged if the tree moved on), and the result's patch then contains both that change and the new work; the stored base patch itself is not applied to your tree.",
          },
          model: {
            type: 'string',
            enum: choices,
            description: `Model for this call. Default: ${primary}, which suits a quick hand-off${allowed}. The result's route reports the model that actually ran.`,
          },
          background: {
            type: 'boolean',
            description: 'Return at once with a jobId instead of holding your turn while the worker runs (minutes, often). Collect the result with flash_result, watch it with flash_status, stop it with flash_cancel. Meanwhile you can run tests or review an earlier patch.',
          },
        },
        required: ['cwd'],
        additionalProperties: false,
      },
    },
    {
      name: 'flash_batch',
      description: [
        'Delegate several independent tasks at once to cheap DeepSeek Harness workers, and return one',
        'compact result per task. One model serves the whole fleet — its dispatcher and every worker run in',
        `one dsh process; omitted, the default ${primary} runs.`,
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
              'The tasks to delegate, each either a self-contained task string or an object with its own task text (inline or in a taskFile) and acceptance criteria.',
            items: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    task: {
                      type: 'string',
                      description: 'The complete, self-contained task. Use either task or taskFile.',
                    },
                    taskFile: {
                      type: 'string',
                      description:
                        "Path to a UTF-8 file holding this task's text, sent exactly as written. A relative path resolves against the service root and must stay inside it. Use either task or taskFile.",
                    },
                    acceptance: { type: 'string', description: 'Optional acceptance criteria for this task.' },
                  },
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
          basePatch: {
            type: 'string',
            description: "A patchId from an earlier writing call. Its change is applied to this call's copy before the workers start (three-way merged if the tree moved on), and the result's patch then contains both that change and the new work; the stored base patch itself is not applied to your tree.",
          },
          model: {
            type: 'string',
            enum: choices,
            description: `Model for the whole fleet: its dispatcher and every worker run in one dsh process. Default: ${primary}, which suits a quick hand-off${allowed}. The result's routes report the model that actually ran; a per-task model is refused.`,
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
    // The models a call may choose, the default first. `--model` may name one that is not
    // on this list; `createService` then folds it in, so the model the operator asked for
    // is never refused by the service built for it.
    models: allowedModels(config),
    taskTimeoutMs: numberFrom(env.FLASH_TASK_TIMEOUT_MS, config.limits.taskTimeoutMs),
    // The handshake is the one request that runs while a cold runtime is still reading
    // its profile and warming up, so it gets a longer, separately configurable budget.
    initTimeoutMs: positiveIntegerFrom(
      env.FLASH_INIT_TIMEOUT_MS,
      DEFAULT_INITIALIZE_TIMEOUT_MS,
      'FLASH_INIT_TIMEOUT_MS',
    ),
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
    // Running a repository's `slotSetup` steps is host code outside the worker's sandbox,
    // so it is off unless the operator explicitly says yes.
    // `on` is the plugin setting's spelling, `1` the shell's.
    allowSlotSetup: env.FLASH_ALLOW_SLOT_SETUP === '1' || env.FLASH_ALLOW_SLOT_SETUP === 'on',
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
      case '--init-timeout-ms':
        options.initTimeoutMs = positiveIntegerFrom(next(), undefined, '--init-timeout-ms')
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
      case '--allow-slot-setup':
        options.allowSlotSetup = true
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
       flash-agents doctor [--profile <id>] [--e2e] [--copy [--root <path>]]
                                                check the prerequisites and print the fixes
       flash-agents clean [--all] [--root <path>]
                                                report the state directory per root and
                                                remove dead trees and expired patches

Doctor modes, on top of the checks:
  --e2e                     after the checks pass, run one writing call in a throwaway
                            repository — the proof that the whole stack works — and leave
                            no trace of it behind
  --copy                    dry-run the disposable copy of --root and report what it costs
                            (time, bytes, files, what was excluded and why) without running
                            a worker; the failure a writing call would hit surfaces here

Options:
  --root <path>             sandbox root and runtime working directory (default: cwd)
  --profile <id>            dsh profile to boot (default: flash-service)
  --provider <id>           pinned LLM provider route (default: ${route.provider})
  --model <id>              default worker model; each call may choose another from the
                            allowlist (default: ${route.model})
  --timeout-ms <n>          per-task wall-clock budget (default: ${value('taskTimeoutMs')})
  --init-timeout-ms <n>     how long dsh may take to answer initialize (default: ${String(DEFAULT_INITIALIZE_TIMEOUT_MS)})
  --batch-timeout-ms <n>    per-fleet wall-clock budget (default: ${value('batchTimeoutMs')})
  --max-tasks <n>           tasks accepted in one flash_batch call (default: ${value('maxTasks')})
  --per-item-chars <n>      returned budget for one worker inside a fleet (default: ${value('perItemChars')})
  --max-result-chars <n>    returned child-message budget (default: ${value('maxResultChars')})
  --isolate <mode>          "copy" (default) runs writing calls in a disposable copy of the
                            root; "none" lets workers write to the root directly
  --slots <n>               disposable trees kept in flight, one runtime each (default: ${value('slots')})
  --state-dir <path>        where slot trees and returned patches live (default: trees in a
                            directory private to this root and this process under TMPDIR,
                            patches in FLASH_DATA_DIR or the platform data directory); a
                            configured directory is shared, so one service per directory
  --copy-exclude <a,b,c>    names left out of a disposable copy: a bare name matches at any
                            depth, one with a slash is a path relative to the root; a match
                            is left out only where git ignores it and tracks nothing under it
                            (default: none; .flash-agents.json may set copyExclude)
  --allow-slot-setup        run the .flash-agents.json slotSetup steps in the copy before the
                            worker starts; they run on the host, with your privileges and
                            outside the worker's sandbox (default: off)
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
FLASH_SERVICE_MODEL, FLASH_MODELS, FLASH_TASK_TIMEOUT_MS, FLASH_INIT_TIMEOUT_MS, FLASH_IDLE_TIMEOUT_MS, FLASH_BATCH_TIMEOUT_MS,
FLASH_MAX_TASKS, FLASH_PER_ITEM_CHARS, FLASH_RESULT_MAX_CHARS, FLASH_MAX_TOKENS, FLASH_ISOLATE, FLASH_SLOTS,
FLASH_STATE_DIR, FLASH_COPY_EXCLUDE, FLASH_ALLOW_SLOT_SETUP, FLASH_DIFF_CHARS, FLASH_PATCH_RETENTION_DAYS, FLASH_MAX_STATE_BYTES, FLASH_LOG_FILE,
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
 * @param {number} [options.waitProgressIntervalMs] - how often a waiting flash_result reports
 *   progress to the client (default 30 s; injectable so a test need not wait half a minute).
 * @returns {(name: string, args: object, ctx: {
 *   signal: AbortSignal,
 *   progressToken: string | number | undefined,
 *   sendProgress: (report: object) => void,
 * }) => Promise<object>} the tool caller.
 */
export function createToolCaller({ service, jobs, log = () => {}, waitProgressIntervalMs = WAIT_PROGRESS_INTERVAL_MS }) {
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
   * The call's model is validated before the job exists; a refusal is answered exactly as
   * the synchronous path answers it, so a bad model never becomes a failed job.
   */
  const startJob = (name, args) => {
    // A background call answers before the service runs, so the model refusals a
    // synchronous call raises from its own path have to be raised here: otherwise an
    // unlisted model, or a non-default one on an old profile, would start a job and only
    // fail in `flash_result` minutes later. A stand-in service without the check is
    // accepted, exactly as the dispatcher accepts one without a real runtime.
    try {
      service.checkModel?.(args, name)
    } catch (error) {
      log(`${name} failed: ${describeError(error)}`)
      return errorResult(`${name} failed: ${describeError(error)}`)
    }
    const job = jobs.start({
      kind: name,
      label: jobLabel(name, args, service?.model),
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
    if (jobId !== undefined) {
      if (typeof jobId !== 'string' || jobId.length === 0) {
        return errorResult(`flash_status failed: jobId must be a non-empty string; got ${JSON.stringify(jobId)}`)
      }
      const status = jobs.status(jobId)
      return status === undefined ? unknownJob('flash_status', jobId) : okResult(status)
    }
    // A listing is a page, not the whole history: a server up for a day accumulated dozens of
    // jobs, and the caller had to read all of them to find the two still running.
    const state = args?.state ?? 'all'
    if (state !== 'running' && state !== 'ended' && state !== 'all') {
      return errorResult(
        `flash_status failed: state must be "running", "ended", or "all"; got ${JSON.stringify(args?.state)}`,
      )
    }
    const limit = args?.limit ?? 10
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return errorResult(`flash_status failed: limit must be an integer between 1 and 50; got ${JSON.stringify(args?.limit)}`)
    }
    const { running, ended } = jobs.counts()
    const shown = jobs.list({ state, limit })
    const shownEnded = state === 'running' ? 0 : Math.min(ended, limit)
    return okResult({ jobs: shown, running, ended, omittedEnded: ended - shownEnded })
  }

  /**
   * The heartbeat a waiting `flash_result` sends: elapsed seconds, the wait the caller asked
   * for, and the job's latest progress line. A client without a progress token gets nothing,
   * because such a notification would be invalid; a sender that throws is ignored, because a
   * client that has gone away must not turn a wait into a failure.
   */
  const startWaitProgress = ({ jobId, waitSeconds, progressToken, sendProgress }) => {
    if (progressToken === undefined || progressToken === null || typeof sendProgress !== 'function') return () => {}
    const startedAt = Date.now()
    const timer = setInterval(() => {
      try {
        const latest = jobs.get(jobId)?.lastProgress?.message
        sendProgress({
          progress: Math.round((Date.now() - startedAt) / 1000),
          total: waitSeconds,
          message: `waiting for ${jobId}: ${latest ?? 'no progress yet'}`,
        })
      } catch (error) {
        log(`could not send a progress notification: ${describeError(error)}`)
      }
    }, waitProgressIntervalMs)
    // The heartbeat must never be the only thing keeping the process alive.
    timer.unref?.()
    return () => clearInterval(timer)
  }

  const resultTool = async (args, signal, { progressToken, sendProgress } = {}) => {
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
    // is left untouched, still running. The answer says which of the three ended the wait,
    // because "the job is still running" alone cannot tell a timeout from a cancelled request.
    let job
    let wait
    if (waitSeconds > 0) {
      const requestedMs = waitSeconds * 1000
      const startedWaiting = Date.now()
      const stopProgress = startWaitProgress({ jobId, waitSeconds, progressToken, sendProgress })
      try {
        const outcome = await jobs.waitFor(jobId, requestedMs, signal)
        job = outcome.job
        wait = { requestedMs, waitedMs: Date.now() - startedWaiting, endedBy: outcome.endedBy }
      } finally {
        stopProgress()
      }
    } else {
      job = jobs.get(jobId)
    }
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
        ...(wait === undefined ? {} : { wait }),
      })
    }
    if (job.state === 'ok') {
      // The caller has the result now; the cap may reclaim the job under pressure, so the
      // one result it is allowed to drop is the one already delivered.
      job.collected = true
      // The call's full result, exactly as the synchronous call would have returned it, plus
      // the job's identity so the caller can tie it back to the id it holds.
      return okResult({
        ...job.result,
        job: { jobId: job.jobId, state: 'ok', elapsedMs: status.elapsedMs },
        ...(wait === undefined ? {} : { wait }),
      })
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
    const { job: settledJob } = await jobs.waitFor(jobId, 30_000)
    const status = jobs.statusOf(settledJob ?? job)
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
    if (name === 'flash_result') return await resultTool(args, signal, { progressToken, sendProgress })
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
 *
 * A call that chose a model other than the default says so in front of the label, so a
 * status listing shows which model a running job is spending on.
 *
 * @param {string} kind - the tool name.
 * @param {object} args - the raw tool arguments.
 * @param {string} [defaultModel] - the service's default model.
 * @returns {string} the label.
 */
export function jobLabel(kind, args, defaultModel) {
  const chosen = typeof args?.model === 'string' && args.model.length > 0 && args.model !== defaultModel
  const prefix = chosen ? `[${args.model}] ` : ''
  if (kind === 'flash_batch') {
    const count = Array.isArray(args?.tasks) ? args.tasks.length : 0
    return `${prefix}${String(count)} tasks`
  }
  const firstLine = typeof args?.task === 'string' ? args.task.split('\n')[0].trim() : ''
  return `${prefix}${clip(firstLine.length === 0 ? '(untitled task)' : firstLine, 80)}`
}

/** Bound a label to the width a status line is read at. */
function clip(text, maxChars) {
  return text.length <= maxChars ? text : text.slice(0, maxChars)
}

/**
 * The models a server exposes, its default first.
 *
 * The default is always present, even when the allowlist omits it: the one model a
 * profile from before model choice can run must never become unreachable. The shipped
 * default stands in when nothing at all was configured.
 *
 * @param {string} [model] - the default model, when the caller knows it.
 * @param {string[]} [models] - the configured allowlist.
 * @returns {string[]} the choices, default first.
 */
function modelChoices(model, models) {
  const choices = []
  for (const name of [model, ...(Array.isArray(models) ? models : [])]) {
    if (typeof name === 'string' && name.length > 0 && !choices.includes(name)) choices.push(name)
  }
  return choices.length === 0 ? [DEFAULT_MODEL] : choices
}

/**
 * Build the service, from parsed options, exactly as the server builds it.
 *
 * `serve` and `doctor --e2e` share this one construction: the doctor's whole purpose
 * is to prove the stack the server really starts, so the wiring between the parsed
 * options and the service's own `isolate` block must not exist twice and drift.
 *
 * @param {object} options - parsed options (see `parseOptions`).
 * @param {(message: string) => void} [log] - diagnostic sink.
 * @returns {FlashTaskService} the service.
 */
export function createService(options, log = () => {}) {
  return new FlashTaskService({
    ...options,
    // The service's allowlist always holds its own default first, whichever door named it
    // (`route.models`, FLASH_MODELS, or --model).
    models: modelChoices(options?.model, options?.models),
    isolate: {
      mode: options.isolate,
      ...(options.slots === undefined ? {} : { slots: options.slots }),
      ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
      ...(options.copyExclude === undefined ? {} : { copyExclude: options.copyExclude }),
      ...(options.allowSlotSetup === true ? { allowSlotSetup: true } : {}),
      ...(options.diffChars === undefined ? {} : { diffChars: options.diffChars }),
      ...(options.patchRetentionDays === undefined ? {} : { patchRetentionDays: options.patchRetentionDays }),
      ...(options.maxStateBytes === undefined ? {} : { maxStateBytes: options.maxStateBytes }),
    },
    log,
  })
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
  const service = createService(options, log)
  log(`root ${service.root}; profile ${service.profile}; route ${service.provider}/${service.model}`)
  if (service.isolation === undefined) {
    log(
      'WARNING: isolation is off (--isolate none). Workers will write to the root directly; ' +
        'a destructive command can only be caught by the flash-guard wall, which is a denylist.',
    )
  } else {
    log(`isolation: ${String(service.isolation.size)} disposable tree(s) under ${service.stateDir}`)
  }

  const models = modelChoices(service.model, service.models)
  const connection = serveStdio({
    serverInfo: SERVER_INFO,
    instructions: instructionsFor(models),
    listTools: () => listTools(models),
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
 * Read a setting that must be a positive integer, refusing an explicit value that is
 * not one. Empty still means unset, as it does for every other setting.
 *
 * @param {unknown} value - the raw environment value or flag argument.
 * @param {number | undefined} fallback - the value when none was given.
 * @param {string} name - the setting's name, for the error.
 * @returns {number | undefined} the parsed value or the fallback.
 */
function positiveIntegerFrom(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = numberFrom(value, undefined)
  if (parsed === undefined) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(String(value))}`)
  }
  return parsed
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
 * The task `doctor --e2e` hands to a worker in a throwaway repository. It asks for
 * exactly one file with exactly one known line, so every part of the round trip can
 * be checked against a fact rather than against the worker's own account of itself.
 */
const E2E_TASK = 'Create a file flash-hello.txt containing the line `it works`, then read it back.'

/** The one file `doctor --e2e` expects the worker to have created in its copy. */
const E2E_FILE = 'flash-hello.txt'

/** The line the worker's patch must carry. */
const E2E_LINE = 'it works'

/** How long `doctor --e2e` lets the worker work. A real call takes minutes, not seconds. */
const E2E_TIMEOUT_MS = 600_000

/** The git identity the throwaway repository commits under, so no user identity is needed. */
const E2E_GIT_CONFIG = [
  '-c',
  'user.email=doctor@flash-agents',
  '-c',
  'user.name=flash-agents',
]

/**
 * Run the prerequisite checks and print them, fixes included.
 *
 * The model and the minimum harness version come from the same configuration the
 * server runs on, so the doctor cannot approve a setup the service would reject.
 *
 * Two modes go beyond the checks, and both exist because a setup that passes them can
 * still fail the first real call:
 *
 * - `--e2e` proves the whole stack with one writing call in a throwaway repository,
 *   rather than asking the user to run a patch against their own tree;
 * - `--copy` dry-runs the disposable copy of the root, which is where a Windows
 *   junction, a huge `node_modules` or a mis-tuned `copyExclude` actually hurts.
 *
 * @param {string[]} [argv] - arguments after the command name.
 * @param {object} [options] - injected effects, for tests.
 * @param {Record<string, string | undefined>} [options.env] - environment to read.
 * @param {(text: string) => void} [options.write] - output sink.
 * @param {Function} [options.run] - command runner handed to the checks.
 * @param {Function} [options.probe] - HTTP probe handed to the checks.
 * @param {Function} [options.generate] - one-token model request handed to the checks.
 * @param {{command: string, prefix: string[]}} [options.launcher] - dsh launcher handed to the checks.
 * @param {Function} [options.createService] - service factory for `--e2e` (default:
 *   `createService`, the one the server uses), injectable so a test need not start a worker.
 * @returns {Promise<number>} the exit code: 0 only when everything that ran passed.
 */
export async function runDoctor(
  argv = [],
  { env = process.env, write, run, probe, generate, launcher, createService: makeServiceOption } = {},
) {
  const emit = write ?? ((text) => process.stdout.write(text))
  const config = loadConfig({ env })
  const flags = doctorFlags(argv)
  let options
  try {
    options = parseOptions(flags.optionsArgv, flags.copy ? envWithProjectRoot(env) : env, config)
  } catch (error) {
    emit(`flash-agents: ${describeError(error)}\n\n${usage()}`)
    return 2
  }
  if (options.help) {
    emit(usage())
    return 0
  }
  const makeService = makeServiceOption ?? createService
  let checksOk = true
  // A plain doctor run, and `--e2e`, check the prerequisites first; a bare `--copy` is
  // its own question ("what would copying this tree cost?") and must not wait on the
  // model round trip the checks make.
  if (!flags.copy || flags.e2e) {
    const result = await runChecks({
      env,
      model: options.model,
      models: allowedModels(config),
      dshVersion: config.dsh.version,
      profile: options.profile,
      dshHome: resolveDshHome(textFrom(env.DSH_HOME)),
      ...(run === undefined ? {} : { run }),
      ...(probe === undefined ? {} : { probe }),
      ...(generate === undefined ? {} : { generate }),
      ...(launcher === undefined ? {} : { launcher }),
    })
    emit(`${formatChecks(result)}\n`)
    emit(
      result.ok
        ? `\nall required checks passed${result.warnings === 0 ? '' : ` (${String(result.warnings)} warning(s))`}\n`
        : `\n${String(result.failures)} check(s) failed; run the fixes above and try again\n`,
    )
    checksOk = result.ok
  }
  const copyOk = flags.copy ? await runCopyProbe({ options, emit }) : true
  let e2eOk = true
  if (flags.e2e) {
    if (!checksOk) {
      emit(`${'skip'.padEnd(4)}  e2e  the checks failed, so the end-to-end run was skipped\n`)
    } else {
      e2eOk = await runE2e({ options, emit, makeService, env, model: options.model })
    }
  }
  return checksOk && copyOk && e2eOk ? 0 : 1
}

/**
 * Split the doctor's own flags from the options it shares with the server.
 *
 * `--e2e` and `--copy` are doctor modes; everything else (`--root`, `--profile`,
 * `--copy-exclude`, …) is a service option and is parsed by `parseOptions`, so the
 * doctor resolves its root, route and copy exclusions exactly as the server does.
 *
 * @param {string[]} argv - arguments after `doctor`.
 * @returns {{e2e: boolean, copy: boolean, optionsArgv: string[]}} the doctor modes and
 *   the arguments left for `parseOptions`.
 */
function doctorFlags(argv) {
  const optionsArgv = []
  let e2e = false
  let copy = false
  for (const flag of argv) {
    if (flag === '--e2e') e2e = true
    else if (flag === '--copy') copy = true
    else optionsArgv.push(flag)
  }
  return { e2e, copy, optionsArgv }
}

/**
 * The environment the server resolves its root from, given what a project session has.
 *
 * The plugin starts the server with `--root "$CLAUDE_PROJECT_DIR"`, so a `doctor --copy`
 * run from inside a session should probe that same tree even when the shell's cwd is
 * somewhere else. An explicit `FLASH_SERVICE_ROOT`, and then `--root`, still win.
 *
 * @param {Record<string, string | undefined>} env - the doctor's environment.
 * @returns {Record<string, string | undefined>} the environment to parse options from.
 */
function envWithProjectRoot(env) {
  if (textFrom(env.FLASH_SERVICE_ROOT) !== undefined) return env
  const project = textFrom(env.CLAUDE_PROJECT_DIR)
  return project === undefined ? env : { ...env, FLASH_SERVICE_ROOT: project }
}

/**
 * Prove the whole stack end to end in a throwaway repository.
 *
 * The setup skill used to ask the user's session for a writing call "in a repository
 * you do not mind a patch against". From a project session that can only be the open
 * project — the server is confined to its root — and that project may hold another
 * session's uncommitted work, which is exactly what a user stopped a first run over.
 * So the doctor does the proof itself: a fresh git repository in a temp directory, a
 * private state directory in another, one slot, and one writing call.
 *
 * Passing means the worker said `ok`, made exactly the file it was asked for with the
 * line it was asked for, and did so in its copy: the temp repository is untouched.
 *
 * @param {object} options - the parsed service options.
 * @param {object} options.options - parsed CLI options (profile, route, copy excludes).
 * @param {(text: string) => void} options.emit - output sink.
 * @param {Function} options.makeService - service factory, injected by tests.
 * @param {Record<string, string | undefined>} options.env - the doctor's environment.
 * @param {string} options.model - the model the run must use.
 * @returns {Promise<boolean>} whether the run passed.
 */
async function runE2e({ options, emit, makeService, env, model }) {
  // A service that would not close may have left a runtime and a tree behind: the run
  // printed `fail` for it, and the exit code has to agree. The flag is set in `finally`,
  // which has run by the time the steps' promise settles.
  const cleanup = { failed: false }
  const ok = await runE2eSteps({ options, emit, makeService, env, model, cleanup })
  return ok && !cleanup.failed
}

/** The steps of `runE2e`; `cleanup.failed` records a close that did not succeed. */
async function runE2eSteps({ options, emit, makeService, env, model, cleanup }) {
  const line = (status, text) => emit(`${status.padEnd(4)}  e2e  ${text}\n`)
  let repo
  let stateRoot
  let service
  try {
    // realpath'd because the service realpaths its root: on macOS a temp path is
    // /var/... on the way in and /private/var/... inside, and two spellings of one
    // directory would make the checks below look at the wrong tree.
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'flash-doctor-')))
    stateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'flash-doctor-state-')))
  } catch (error) {
    line('fail', `could not create the throwaway directories: ${describeError(error)}`)
    return false
  }
  const serviceLog = []
  try {
    const prepared = prepareE2eRepository(repo)
    if (prepared !== undefined) {
      line('fail', prepared)
      return false
    }
    service = makeService(
      {
        ...options,
        root: repo,
        // Forced on: the proof is that a writing call lands in a copy, and with
        // isolation off the worker would write into this repository directly.
        isolate: 'copy',
        slots: 1,
        // A private state directory: the user's own trees, patches and log are never
        // touched, swept or trimmed by this run.
        stateDir: join(stateRoot, 'state'),
        taskTimeoutMs: E2E_TIMEOUT_MS,
        // The doctor's environment, so the run reads (and writes) no real harness home.
        env,
      },
      (message) => serviceLog.push(message),
    )
    const started = Date.now()
    let result
    try {
      // The model is a per-call choice now: the service puts it in the runtime's
      // environment itself, so the proof exercises the same path a server call does.
      result = await service.flashTask({ task: E2E_TASK, cwd: repo, apply: 'none', model })
    } catch (error) {
      line('fail', describeError(error))
      if (error?.code === 'NOT_DELEGATED') {
        line('note', 'the cheap dispatcher sometimes does the work itself; a rerun usually passes')
      }
      for (const message of serviceLog) emit(`log   e2e  ${message}\n`)
      return false
    }
    const elapsedMs = Date.now() - started
    let ok = true
    // 1. the worker's own verdict, and the route it actually ran on
    const route = result?.route
    const routeName =
      route?.provider === undefined || route?.model === undefined
        ? String(result?.provider ?? 'unknown')
        : `${String(route.provider)}/${String(route.model)}`
    if (result?.status === 'ok') {
      // The proof includes the route: a run that reports another model did not exercise
      // the one that was asked for, so it is a failure even though the worker succeeded.
      if (route?.model === model) {
        line('ok', `worker status ok on ${routeName}`)
      } else {
        ok = false
        line('fail', `worker status ok on ${routeName}, but the model asked for was ${String(model)}`)
      }
    } else {
      ok = false
      line('fail', `worker status ${JSON.stringify(result?.status)} (stop reason ${JSON.stringify(result?.stopReason)})`)
    }
    // 2. exactly the file the task asked for, with exactly the line it asked for
    const files = result?.change?.filesChanged ?? []
    const diff = typeof result?.change?.diff === 'string' ? result.change.diff : ''
    const additions = diff.split('\n').filter((text) => text.startsWith('+') && !text.startsWith('+++')).length
    if (files.length === 1 && files[0] === E2E_FILE) {
      line('ok', `change: ${E2E_FILE} (+${String(additions)})`)
    } else {
      ok = false
      line('fail', `change: expected exactly ${JSON.stringify([E2E_FILE])}, got ${JSON.stringify(files)}`)
    }
    if (diff.includes(`+${E2E_LINE}`)) {
      line('ok', `the diff carries "${E2E_LINE}"`)
    } else {
      ok = false
      line('fail', `the diff does not carry the line "${E2E_LINE}"`)
    }
    // 3. the throwaway repository itself is untouched: the work happened in the copy
    const touched = touchedPaths(repo)
    if (touched.length === 0) {
      line('ok', 'the temp repository was not touched')
    } else {
      ok = false
      line('fail', `the temp repository was touched: ${touched.slice(0, 5).join(', ')}`)
    }
    // 4. what the call cost
    const tokens = result?.usage?.totalTokens
    line(ok ? 'ok' : 'fail', `${formatSeconds(elapsedMs)}, ${tokens === undefined ? 'no usage reported' : `${String(tokens)} tokens`}`)
    if (!ok) for (const message of serviceLog) emit(`log   e2e  ${message}\n`)
    return ok
  } finally {
    // Always, on every path: the service first (it owns the trees and the runtimes),
    // then both temp directories, which hold no work worth keeping.
    try {
      await service?.close()
    } catch (error) {
      cleanup.failed = true
      line('fail', `could not close the service: ${describeError(error)}`)
    }
    for (const dir of [repo, stateRoot]) {
      if (dir === undefined) continue
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // A temp directory that will not go away is not a failed proof.
      }
    }
  }
}

/**
 * Create the throwaway repository `--e2e` proves the stack in: one commit, so a
 * writing call has a base to diff against.
 *
 * @param {string} repo - the empty temp directory to turn into a repository.
 * @returns {string | undefined} a failure message, or undefined when it was prepared.
 */
function prepareE2eRepository(repo) {
  const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  try {
    writeFileSync(join(repo, 'README.md'), '# flash-agents doctor\n\nA throwaway repository, deleted when the run ends.\n')
  } catch (error) {
    return `could not write the throwaway repository: ${describeError(error)}`
  }
  const steps = [['init', '-q', '-b', 'main'], ['add', '-A'], [...E2E_GIT_CONFIG, 'commit', '-q', '-m', 'init']]
  for (const args of steps) {
    const result = git(args)
    if (result.error !== undefined) return `git ${args.join(' ')} failed: ${describeError(result.error)}`
    if (result.status !== 0) {
      return `git ${args.join(' ')} failed: ${String(result.stderr ?? '').trim().split('\n')[0]}`
    }
  }
  return undefined
}

/**
 * The paths in `dir` that git reports as modified, which is every way a writing call
 * could have reached the throwaway repository it was pointed at.
 *
 * @param {string} dir - the throwaway repository.
 * @returns {string[]} the changed paths; empty when the repository is untouched.
 */
function touchedPaths(dir) {
  // The call's own file is named even if git cannot answer, so the failure that matters
  // is reported even in a repository git refuses to read.
  const found = []
  if (existsSync(join(dir, E2E_FILE))) found.push(E2E_FILE)
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })
  if (status.status === 0 && typeof status.stdout === 'string') {
    for (const text of status.stdout.split('\n')) {
      const path = text.slice(3).trim()
      if (path !== '' && !found.includes(path)) found.push(path)
    }
  }
  return found
}

/**
 * Dry-run the disposable copy of a root: what it costs, whether it can be made, and
 * what the pool decided to leave out along the way.
 *
 * This is the failure a Windows user hit 25 minutes into a call: a directory junction in
 * the tree made every copy abort, and the only sign was in `flash_status`. Measuring the
 * copy is also how `copyExclude` is tuned — the five largest top-level entries are the
 * first candidates.
 *
 * @param {object} options - what to probe.
 * @param {object} options.options - parsed CLI options (root, copy excludes).
 * @param {(text: string) => void} options.emit - output sink.
 * @returns {Promise<boolean>} whether the copy could be made.
 */
async function runCopyProbe({ options, emit }) {
  // As in `runE2e`: a tree that could not be removed is a failure the exit code reports.
  const cleanup = { failed: false }
  const ok = await runCopyProbeSteps({ options, emit, cleanup })
  return ok && !cleanup.failed
}

/** The steps of `runCopyProbe`; `cleanup.failed` records a pool that would not close. */
async function runCopyProbeSteps({ options, emit, cleanup }) {
  const line = (status, text) => emit(`${status.padEnd(4)}  copy  ${text}\n`)
  const root = canonicalRoot(options.root)
  const logs = []
  const started = Date.now()
  let tempDir
  let pool
  let slot
  try {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-doctor-copy-')))
    pool = new WorkspaceIsolation({
      root,
      slots: 1,
      // A private state directory: the user's own trees, patches and sweep are untouched.
      stateDir: join(tempDir, 'state'),
      ...(options.copyExclude === undefined ? {} : { copyExclude: options.copyExclude }),
      // One copy, then gone: a housekeeping timer has nothing to sweep and must not
      // keep the process alive.
      sweepIntervalMs: 0,
      log: (message) => logs.push(message),
    })
    slot = await pool.lease()
    let prepared
    try {
      prepared = pool.prepare(slot, { cwd: root })
    } catch (error) {
      // Exactly the failure a writing call would have hit, which is the point: print it
      // as it is, root and cause included.
      line('fail', describeError(error))
      for (const message of logs) line('log', message)
      return false
    }
    const elapsedMs = Date.now() - started
    const copy = directoryStats(slot.dir)
    line('ok', `copied ${root} in ${formatSeconds(elapsedMs)}`)
    line('ok', `${formatBytes(copy.bytes)} in ${String(copy.files)} file(s), mechanism: ${String(prepared?.mechanism ?? 'unknown')}`)
    if (prepared?.reason !== undefined) line('note', String(prepared.reason))
    for (const message of logs) line('log', message)
    const largest = largestTopLevel(slot.dir)
    if (largest.length > 0) {
      line('top', 'the largest top-level entries of the copy (candidates for copyExclude in .flash-agents.json):')
      for (const entry of largest) {
        line('top', `${formatBytes(entry.bytes).padStart(10)}  ${entry.path}`)
      }
    }
    return true
  } catch (error) {
    line('fail', `the copy probe failed: ${describeError(error)}`)
    for (const message of logs) line('log', message)
    return false
  } finally {
    if (slot !== undefined && pool !== undefined) {
      try {
        pool.release(slot)
      } catch {
        // Releasing a slot that is about to be removed cannot fail the probe.
      }
    }
    try {
      pool?.close()
    } catch (error) {
      cleanup.failed = true
      line('fail', `could not remove the disposable tree: ${describeError(error)}`)
    }
    if (tempDir !== undefined) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // A temp directory that will not go away is not a failed probe.
      }
    }
  }
}

/**
 * The total size and file count below a directory.
 *
 * `directorySize` in the isolation module is the same walk, but it is deliberately not
 * exported: this is the doctor's own measurement, and it counts files as well.
 *
 * @param {string} dir - the directory to size.
 * @returns {{bytes: number, files: number}} the sum of the file sizes and how many there are.
 */
function directoryStats(dir) {
  let bytes = 0
  let files = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { bytes, files }
  }
  for (const entry of entries) {
    const child = join(dir, entry.name)
    try {
      if (entry.isDirectory()) {
        const nested = directoryStats(child)
        bytes += nested.bytes
        files += nested.files
      } else {
        bytes += statSync(child).size
        files += 1
      }
    } catch {
      // A file that vanished mid-walk contributes nothing, exactly as it would to a copy.
    }
  }
  return { bytes, files }
}

/**
 * The five largest entries directly under a directory, by size.
 *
 * @param {string} dir - the copy's root.
 * @returns {Array<{path: string, bytes: number}>} the largest entries, biggest first.
 */
function largestTopLevel(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    // The pool's own scratch directories (`.flash-tmp`, and `.flash-home`/`.flash-cache`
    // when the repository configures them) are not the caller's content and are never a
    // copyExclude candidate.
    .filter((entry) => !(entry.isDirectory() && entry.name.startsWith('.flash-')))
    .map((entry) => ({
      path: `${entry.isDirectory() ? `${entry.name}/` : entry.name}`,
      bytes: entry.isDirectory() ? directoryStats(join(dir, entry.name)).bytes : safeSize(join(dir, entry.name)),
    }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5)
}

/** One path's size, or 0 when it cannot be read. @param {string} path @returns {number} */
function safeSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** A byte count in the unit a person reads it in. @param {number} bytes @returns {string} */
function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${String(bytes)} B`
}

/** A duration in seconds, at the precision a person reads. @param {number} ms @returns {string} */
function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`
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
 * one digest directory per root, one directory per server pid under it, and a durable
 * per-root patch store under the platform data directory (or `FLASH_DATA_DIR`). A legacy
 * `patches/` directory under the temp tree is pruned too, so an upgrade leaves nothing
 * behind to age out twice. Sizes are printed in MB because the report answers a disk
 * question, not a file-count one.
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
  const dataDir = textFrom(env.FLASH_DATA_DIR)
  const report = cleanLayout({
    ...(baseDir === undefined ? {} : { baseDir }),
    ...(dataDir === undefined ? {} : { dataDir }),
    root: canonicalRoot(root),
    all,
    retentionDays: retentionDays ?? config.limits.patchRetentionDays,
    ...(now === undefined ? {} : { now }),
    log: (message) => emit(`[flash-mcp clean] ${message}\n`),
  })
  emit(`flash-mcp state: ${report.baseDir}\n`)
  emit(`flash-mcp patches: ${report.patchDir}\n`)
  if (report.legacyPatchDir !== undefined) emit(`flash-mcp legacy patches: ${report.legacyPatchDir}\n`)
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
