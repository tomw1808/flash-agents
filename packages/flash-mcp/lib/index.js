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
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { serveStdio, describeError } from './mcp.js'
import { DEFAULT_MODEL, FlashTaskService, readTaskFile, taskLabel } from './service.js'
import { DEFAULT_INITIALIZE_TIMEOUT_MS, resolveDshCommand } from './sdk.js'
import { JobRegistry, JOB_TOOLS } from './jobs.js'
import { allowedModels, loadConfig } from './config.js'
import { FLASH_MCP_VERSION, formatChecks, profileVersionWarning, resolveDshHome, runChecks } from './doctor.js'
import { WorkspaceIsolation, cleanLayout, durableBaseDir, requireAbsoluteStateBase } from './isolation.js'

/** The repository root this server runs from, named in the profile-stamp warning. */
const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))

/** Server identity reported to the MCP client. */
export const SERVER_INFO = Object.freeze({ name: 'flash-mcp', version: FLASH_MCP_VERSION })

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
    'A stored patch outlives the call that made it. Its record names the task that made it —',
    'the brief\'s first line, the job id, the session and any taskFile path — and, once the call',
    'finished, the worker\'s final report (the first 8,000 characters). `flash_patch` returns the',
    'task on every page and the report on the first one, and `flash_apply` returns the task, so a',
    'patch applied days later still says what it was asked to do. `flash_apply`, `flash_patch`',
    'and `basePatch` accept a unique prefix of a patch id — at least eight hex digits, with or',
    'without the `flash-` prefix — so an id can be quoted the way a log line spells it; a prefix that',
    'matches more than one stored patch is refused with the matches named.',
    '',
    'A first attempt that ends early with nothing — under three minutes and at most twelve model',
    'calls, nothing delegated or only empty reports, and no change in the copy — is retried once',
    'after ten seconds in the same copy, and the result says so under `retried`.',
    '',
    '`flash_status` on a running job reports what its workers are doing: `current` lists each open',
    'tool call (`tool`, `command`, `since`, `runningMs`) as of the last heartbeat, and `warnings`',
    'names a command that failed three or more times in the call, or one whose process tree has',
    'used no CPU for minutes; a `current` entry carries `child` when a process under the runtime',
    'has run longer than the command, and `background` (the job id) when it is a background job.',
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
              'Path to a UTF-8 file holding the task text, sent exactly as written — for a long brief that would otherwise have to be pasted. A relative path resolves against the service root, and the file must resolve inside it; it must be a regular file of at most 256 KB. Pass exactly one of task and taskFile. `taskFile` is the whole task: do not pass `task` with it.',
          },
          cwd: {
            type: 'string',
            description: 'Absolute working directory for the worker. Must be inside the service root.',
          },
          acceptance: {
            type: 'string',
            description: 'Optional acceptance criteria describing what a correct result looks like.',
          },
          label: {
            type: 'string',
            description: 'Optional name for this call, 1 to 120 characters, shown in flash_status, the queue and the stored patch. Without it the label is the first line of the brief, which is the same for every brief that starts with shared rules.',
          },
          mode: {
            type: 'string',
            enum: ['workspace-write', 'read-only'],
            description: 'Optional narrowing of what this call may change. "workspace-write" (the default) confines writes to the service root; "read-only" runs the call in a process whose file sandbox denies every mutation, so it cannot change anything — which also means it cannot build or run tests, since compilers and test runners write (cargo, for one, takes a lock file in target/). For a review that must build or test, use the default mode with apply: "discard" instead. No mode can widen the standing confinement.',
          },
          readOnly: {
            type: 'boolean',
            description: 'Shorthand for mode: "read-only" when true; false changes nothing. Combined with mode "workspace-write" it is refused.',
          },
          apply: {
            type: 'string',
            enum: ['none', 'auto', 'discard'],
            description: 'What to do with the change the worker made in its disposable copy. "none" (the default) stores the patch and leaves your tree untouched; "auto" applies it to the service root before returning; "discard" reports the change but stores nothing — for a review that has to build or run tests, which a read-only call cannot. Read change.diff before trusting any of them. A long diff is clipped at a file boundary: change.diffTruncated is then true, change.diffOmitted names the files left out, and flash_patch reads the stored patch whole.',
          },
          source: {
            type: 'string',
            enum: ['working-tree', 'head'],
            description: 'What the disposable copy starts from. "working-tree" (the default) copies your tree as it is, uncommitted edits included, and the result lists them under isolation.uncommittedAtStart. "head" starts from the last commit (ignored files such as dependencies and build output are kept), for a call that must not pick up uncommitted work — for instance another session\'s, in the same tree. "head" applies to writing calls only: a read-only call runs in your tree, not in a copy, so it is refused there.',
          },
          basePatch: {
            type: 'string',
            description: "A patchId from an earlier writing call, or a unique prefix of one (at least 8 hex digits, with or without the `flash-` prefix). Its change is applied to this call's copy before the worker starts (three-way merged if the tree moved on), and the result's patch then contains both that change and the new work; the stored base patch itself is not applied to your tree.",
          },
          model: {
            type: 'string',
            enum: choices,
            description: `Model for this call. Default: ${primary}, which suits a quick hand-off${allowed}. The result's route reports the model that actually ran.`,
          },
          background: {
            type: 'boolean',
            description: 'Return at once with a jobId instead of holding your turn while the worker runs (minutes, often). Collect the result with flash_result, watch it with flash_status, stop it with flash_cancel. Meanwhile you can run tests or review an earlier patch. A writing call sent without this that has to wait for a busy copy says so while it waits and in its result\'s warnings, holding your whole turn; prefer `background: true` when copies may be busy.',
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
                        "Path to a UTF-8 file holding this task's text, sent exactly as written. A relative path resolves against the service root and must stay inside it. Use either task or taskFile. `taskFile` is the whole task: do not pass `task` with it.",
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
          label: {
            type: 'string',
            description: 'Optional name for this fleet, 1 to 120 characters, shown in flash_status, the queue and the stored patch. Without it the label is the number of tasks.',
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
            description: 'What the shared copy starts from: "working-tree" (the default, uncommitted edits included) or "head" (the last commit, ignored files kept). "head" applies to writing calls only: a read-only call runs in your tree, not in a copy, so it is refused there.',
          },
          basePatch: {
            type: 'string',
            description: "A patchId from an earlier writing call, or a unique prefix of one (at least 8 hex digits, with or without the `flash-` prefix). Its change is applied to this call's copy before the workers start (three-way merged if the tree moved on), and the result's patch then contains both that change and the new work; the stored base patch itself is not applied to your tree.",
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
        'in the result, so a long change still applies whole. The result names the task that made',
        'the patch (`task`), so a change applied later still says which work it belongs to.',
        '',
        'If the server that ran a call died before the call finished, the next server on the',
        'same root salvages the unfinished work from the dead server’s tree as a patch. That',
        'salvage is named in the server log (patch id and diffstat) and can be applied here by',
        'id like any other patch; it carries the task too.',
        '',
        'Pass `dryRun: true` to check that it still applies without changing anything. A patch that',
        'was already applied is refused; pass `force: true` to apply it again anyway. Patches do not',
        'cross repositories: one computed for another root is refused.',
        '',
        'A review run with `apply: "none"` can hand its proof tests over with `files`.',
        '',
        'A patch whose surrounding lines moved meanwhile — another session edited or committed the',
        'same file while the worker ran — fails a plain apply. Pass `threeWay: true` to merge it',
        'instead: the plain apply is still tried first, and the merge uses the base the worker',
        'started from, which the service keeps with the patch. Your index is never touched; a',
        'conflict leaves conflict markers in the named files and is listed in `conflicts`.',
        '`dryRun` with `threeWay` predicts the conflicts without writing anything.',
        '',
        'Pass `excludeBase: true` to apply only the work this patch added on top of the base patch',
        'it continued from, not the base patch\'s change as well.',
        '',
        'The result has a `status` ("success", "conflict" or "failed") and a `files` entry per file:',
        '`applied`, `merged` (your tree had moved and the change was merged in), `conflict` (markers',
        'left in the file) or `failed` (with a `reason`). If one file cannot be merged, nothing is written',
        'and `status` is "failed"; `appliable` then names the files that can still go in with `files`.',
        '',
        'The result\'s `drift` says how far your tree moved since the patch\'s base (`commitsBehind`)',
        'and which of the patch\'s own files you changed in the meantime (`filesChangedSince`); a',
        'non-empty file list also comes back as a warning before you apply.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          patchId: {
            type: 'string',
            description: 'The change.patchId from the result of the call whose work should be applied, or a unique prefix of it (at least 8 hex digits, with or without the `flash-` prefix).',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: "Optional: apply only these files' sections, named as in change.filesChanged (a rename by either its old or its new path). The stored patch is unchanged; a partial apply is recorded per file, so the rest can follow later.",
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
          excludeBase: {
            type: 'boolean',
            description: 'Apply only the change this patch made on top of the base patch it continued from: the job\'s own change, not the base patch\'s work it already contains. Refused when the patch recorded no base patch, or that base patch is no longer stored.',
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
        '',
        'The patch\'s record names the task that made it: `task` (the brief\'s first line, the job',
        'id, the session and any taskFile path) is on every page, and the worker\'s final report',
        '(`finalMessage`, the first 8,000 characters; `finalMessageTruncated` says when it was cut)',
        'is on the page that starts at offset 0.',
        '',
        'The result\'s `drift` says how far your tree has moved since the patch\'s base: `commitsBehind`',
        'and the patch\'s own files you changed since the worker\'s copy was made (`filesChangedSince`).',
        'It is on the page that starts at offset 0, and is `null` once the patch was applied.',
        '',
        'The first page also lists `overlaps`: other stored patches of this root that are not applied',
        'and change some of the same files (`patchId`, `files`, `label`, `createdAt`). A patch that',
        'continues from another (`basePatch`) is not an overlap. It is left out when there are none.',
        '',
        'Pass `excludeBase: true` to read only the work this patch added on top of the base patch',
        'it continued from.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          patchId: {
            type: 'string',
            description: 'The change.patchId from the result of the call whose patch should be read, or a unique prefix of it (at least 8 hex digits, with or without the `flash-` prefix).',
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
          excludeBase: {
            type: 'boolean',
            description: 'Read only the change this patch made on top of the base patch it continued from: the job\'s own change, not the base patch\'s work it already contains. Refused when the patch recorded no base patch, or that base patch is no longer stored.',
          },
        },
        required: ['patchId'],
        additionalProperties: false,
      },
    },
    ...JOB_TOOLS,
  ]
}

/** The repository's per-machine settings file, which may name this machine's state base. */
const LOCAL_SETTINGS_FILE = '.flash-agents.local.json'

/**
 * Parse CLI arguments and environment into service options.
 *
 * Defaults come from `flash.config.json` rather than from literals here, so the
 * route and the numeric limits have one home. Environment values are read through
 * `textFrom`, which treats an empty string as unset: a plugin manifest expands an
 * unset setting to `""`, and `--isolate ""` would otherwise be a startup error.
 *
 * The state base can also come from `.flash-agents.local.json` in the server's root.
 * Claude Code syncs plugin settings between machines, so a `state_base` that is right on
 * Windows (`C:\fm`) is wrong on Linux; the git-ignored local file belongs to one machine
 * and therefore wins over the environment the plugin passes. An explicit `--state-base`
 * still wins, as every command-line option does over the settings files. The local file's
 * `platform.<process.platform>` section wins over its top level, exactly as the copy
 * settings layer in the README's "Per-repository settings".
 *
 * @param {string[]} [argv] - arguments after the command name.
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @param {object} [config] - resolved configuration; loaded from disk by default.
 * @param {object} [options] - effects a test can inject.
 * @param {string} [options.home] - the home directory a `~` in `--state-base` expands
 *   against (default the process's; injectable so a test needs no real home).
 * @param {string} [options.platform] - platform whose local settings section applies
 *   (default `process.platform`; injectable so a test needs no real platform).
 * @param {boolean} [options.ignoreLocalSettings] - skip `.flash-agents.local.json`; the
 *   doctor uses this to check the rest of a machine whose local state base is unusable.
 * @param {string} [options.root] - the server root a caller already resolved; the local
 *   settings file is read from it. `--root` and `FLASH_SERVICE_ROOT` still decide the
 *   root when it is not given, and the cwd is the last resort.
 * @returns {object} the service options, plus `localSettingsProblem` (`{path, message}`)
 *   when the local settings file could not be read or parsed and was therefore ignored.
 */
export function parseOptions(
  argv = process.argv.slice(2),
  env = process.env,
  config = loadConfig({ env }),
  { home = homedir(), platform = process.platform, ignoreLocalSettings = false, root } = {},
) {
  const envStateBase = textFrom(env.FLASH_STATE_BASE)
  const options = {
    root: root ?? textFrom(env.FLASH_SERVICE_ROOT) ?? process.cwd(),
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
    // The base of the default per-root/per-process layout. `--state-dir` replaces that
    // layout entirely and wins over this; a base only moves where the default lives.
    stateBase: envStateBase,
    // Where that base came from, for the doctor's report: the plugin setting by default,
    // and the local settings file or the flag when they decided it below.
    ...(envStateBase === undefined ? {} : { stateBaseSource: 'FLASH_STATE_BASE' }),
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
  let stateBaseFromFlag = false
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
      case '--state-base':
        options.stateBase = next()
        options.stateBaseSource = '--state-base'
        stateBaseFromFlag = true
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
  // Help is not a start: usage must print even when this machine's settings would keep a
  // server from starting, so neither the local file nor the state base is read or validated.
  if (options.help) return options
  if (options.isolate !== 'copy' && options.isolate !== 'none') {
    throw new Error(`--isolate ${JSON.stringify(options.isolate)} is not available; use "copy" (default) or "none"`)
  }
  // The local file wins over the plugin setting (the environment), but not over an
  // explicit `--state-base`: a flag is this run's decision, and the settings files are
  // the layers beneath it.
  if (!stateBaseFromFlag && !ignoreLocalSettings) {
    const local = localStateBase(options.root, platform)
    // A file that cannot be read or parsed contributes nothing, but it is not silent: the
    // caller reports it at start-up and the doctor shows it as a warning, so a synced plugin
    // setting that wins unnoticed is visible.
    if (local?.problem !== undefined) {
      options.localSettingsProblem = { path: local.path, message: local.problem }
    }
    if (local?.value !== undefined) {
      options.stateBase = local.value
      options.stateBaseSource = local.source
      options.stateBaseLocalFile = local.path
    }
  }
  // A relative base is resolved against the service root, which puts the copies inside the
  // caller's repository; `~` is expanded first, exactly as `DSH_HOME` is. Refusing here
  // means `serve`, `clean` and `doctor` report the same sentence before anything exists.
  try {
    options.stateBase = requireAbsoluteStateBase(options.stateBase, home)
  } catch (error) {
    // Carry the origin so the startup report can say it was the local file, not the
    // plugin setting, that named an unusable path. A value the local file itself put on
    // the error is kept as it is — `null` included, which `??=` would replace.
    if (error !== null && typeof error === 'object') {
      if (!('stateBaseSource' in error)) error.stateBaseSource = options.stateBaseSource
      if (!('stateBaseValue' in error)) error.stateBaseValue = options.stateBase
    }
    throw error
  }
  return options
}

/**
 * The `stateBase` `.flash-agents.local.json` sets for this machine, if any.
 *
 * The platform section is resolved before the top level, exactly as the other settings
 * layer: when `platform.<current>` carries a `stateBase`, the top-level one is not read
 * at all, so an unusable shared value does not shadow a good one for this machine. Only
 * the value that wins is validated.
 *
 * The file is convenience configuration like the copy settings beside it: a missing file
 * contributes nothing here. One that cannot be read, or is not JSON (a leading UTF-8 BOM,
 * which Notepad writes, is stripped first), also contributes nothing, but its problem is
 * returned so the server can say why the file was ignored and the doctor can warn about it.
 * A `stateBase` that is present but not a string naming a path (a non-string, `""`, or only
 * blanks) is different: it is a value the server would otherwise silently ignore, so it is
 * refused with the same `STATE_BASE_INVALID` code as a relative path, and the startup report
 * names the local file as its source.
 *
 * @param {string} root - the server's root.
 * @param {string} platform - `process.platform`, whose section applies.
 * @returns {{value: string, source: string, path: string} | {problem: string, path: string} | undefined}
 *   the winning value and the layer it came from, why the file was ignored, or undefined
 *   when there is no file or it names no stateBase.
 * @throws {Error} when a present stateBase is not a non-empty string.
 */
function localStateBase(root, platform) {
  const path = join(resolve(root), LOCAL_SETTINGS_FILE)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    // A missing file is the normal case: the local settings are optional.
    if (error?.code === 'ENOENT') return undefined
    return { path, problem: `it could not be read (${describeError(error)})` }
  }
  // Notepad writes a UTF-8 BOM; JSON.parse refuses it, so a valid file would read as broken.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { path, problem: `it is not valid JSON (${describeError(error)})` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const platformSection = parsed.platform?.[platform]
  const platformNames =
    platformSection !== null &&
    typeof platformSection === 'object' &&
    !Array.isArray(platformSection) &&
    Object.hasOwn(platformSection, 'stateBase')
  const section = platformNames ? platformSection : parsed
  if (!Object.hasOwn(section, 'stateBase')) return undefined
  const label = platformNames ? `${LOCAL_SETTINGS_FILE} platform.${platform}` : LOCAL_SETTINGS_FILE
  const raw = section.stateBase
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw Object.assign(
      new Error(`${label} sets "stateBase" to ${JSON.stringify(raw)}, which is not a path`),
      { code: 'STATE_BASE_INVALID', stateBaseSource: label, stateBaseValue: raw },
    )
  }
  return { value: raw, source: label, path }
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
       flash-agents clean [--all] [--caches] [--root <path>] [--state-base <path>]
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
                            configured directory is shared, so one service per directory;
                            wins over --state-base
  --state-base <path>       base directory under which the default
                            <base>/<digest>/<pid>/<instance>/ layout is created (default:
                            $TMPDIR/flash-mcp); it must be absolute, and a leading ~ is
                            expanded; on Windows a short base such as C:\\fm leaves room
                            for tools that ignore long-path support
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
FLASH_STATE_DIR, FLASH_STATE_BASE, FLASH_COPY_EXCLUDE, FLASH_ALLOW_SLOT_SETUP, FLASH_DIFF_CHARS, FLASH_PATCH_RETENTION_DAYS, FLASH_MAX_STATE_BYTES, FLASH_LOG_FILE,
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
  // `background` and `jobId` travel with a job's call: the first is what makes a queued
  // writing call say it is holding the caller's turn, the second is what a stored patch
  // records as the job the change belongs to.
  const runFor = (name, args, { signal, progress, progressToken, background = false, jobId = undefined, label = undefined }) => {
    const context = {
      signal,
      progress,
      progressToken,
      background,
      ...(jobId === undefined ? {} : { jobId }),
      ...(label === undefined ? {} : { label }),
    }
    return name === 'flash_task'
      ? () => service.flashTask(args, context)
      : name === 'flash_batch'
        ? () => service.flashBatch(args, context)
        : name === 'flash_apply'
          ? () => service.flashApply(args)
          : name === 'flash_patch'
            ? () => service.flashPatch(args)
            : undefined
  }

  /**
   * Turn one background call into a running job and answer with its id. The service runs
   * under the job's own signal, so the starting request ending — or being cancelled —
   * cannot reach it, and its progress is recorded on the job instead of notified.
   * The call's model is validated before the job exists; a refusal is answered exactly as
   * the synchronous path answers it, so a bad model never becomes a failed job.
   */
  const startJob = (name, args) => {
    // A background call answers before the service runs, so every refusal a synchronous
    // call raises from argument validation has to be raised here: otherwise a bad model,
    // both `task` and `taskFile`, an unreadable file or a refused `source` would start a
    // job and only fail in `flash_result` seconds later. Only validation moves — anything
    // that needs a slot or a runtime still runs inside the job. A stand-in service without
    // the full check is accepted, exactly as the dispatcher accepts one without a runtime.
    try {
      if (typeof service.checkArguments === 'function') service.checkArguments(args, name)
      else service.checkModel?.(args, name)
    } catch (error) {
      log(`${name} failed: ${describeError(error)}`)
      return errorResult(`${name} failed: ${describeError(error)}`)
    }
    // Computed before the job exists: `jobs.start` runs `run` at once, and the service names
    // this call by the same label to any call that queues behind it for a tree.
    const label = jobLabel(name, args, service?.model, service?.root)
    const job = jobs.start({
      kind: name,
      label,
      run: ({ signal, jobId, progress }) =>
        runFor(name, args, {
          signal,
          progress,
          // The service starts its progress timer only when a request carried a token, and
          // only reads whether one is present. There is no client here, so the job's own id
          // stands in, and every heartbeat reaches the job's recorder.
          progressToken: jobId,
          background: true,
          jobId,
          label,
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

  /** The explanation every unknown-job refusal ends with. */
  const UNKNOWN_JOB_HINT =
    'Job ids look like job-xxxxxxxx (8 lowercase hex characters) and live only in the server ' +
    'process that made them: jobs do not survive a restart. After a restart, the call\'s ' +
    'finished work is still salvaged as a patch by the next server, and flash_apply can apply it by id.'

  const unknownJob = (tool, jobId) =>
    errorResult(`${tool} failed: unknown job ${JSON.stringify(jobId)}. ${UNKNOWN_JOB_HINT}`)

  /** Refuse a group of ids that the registry does not hold and no stored report answers. */
  const unknownJobs = (tool, jobIds) =>
    errorResult(
      `${tool} failed: unknown jobs ${jobIds.map((id) => JSON.stringify(id)).join(', ')}. ${UNKNOWN_JOB_HINT}`,
    )

  /**
   * A job the server no longer holds: its stored report, when the call finished and stored one,
   * otherwise the unknown-job refusal. The report file outlives the process and the in-memory
   * registry, so a restart or a lost context does not lose the review.
   *
   * `extra` carries the fields a group call adds around the same report (`pending`,
   * `unknown`). The single-id path passes none: its answer is the stored report itself, which
   * also carries `timing` when the record measured one.
   */
  const storedReport = (tool, jobId, extra = {}) => {
    const stored = service?.readReport?.(jobId)
    if (stored === undefined) return unknownJob(tool, jobId)
    return okResult({
      jobId,
      kind: stored.kind,
      status: stored.status,
      ...(stored.stopReason === undefined ? {} : { stopReason: stored.stopReason }),
      ...(stored.finalMessageProblem === undefined ? {} : { finalMessageProblem: stored.finalMessageProblem }),
      ...(stored.patchId === undefined ? {} : { patchId: stored.patchId }),
      label: stored.label,
      createdAt: stored.createdAt,
      reportPath: stored.reportPath,
      report: stored.report,
      ...(stored.timing === undefined ? {} : { timing: stored.timing }),
      ...extra,
      note: 'the job is no longer held in memory (the server restarted, or the job was evicted); this is the worker\'s whole report as stored on disk',
    })
  }

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
   * for, and the latest progress line of the job (or jobs) waited on. A client without a
   * progress token gets nothing, because such a notification would be invalid; a sender that
   * throws is ignored, because a client that has gone away must not turn a wait into a failure.
   */
  const startWaitProgress = ({ jobId, jobIds, waitSeconds, progressToken, sendProgress }) => {
    if (progressToken === undefined || progressToken === null || typeof sendProgress !== 'function') return () => {}
    const ids = Array.isArray(jobIds) ? jobIds : [jobId]
    const waitedOn = ids.length === 1 ? ids[0] : `${String(ids.length)} jobs`
    const startedAt = Date.now()
    const timer = setInterval(() => {
      try {
        const latest = ids
          .map((id) => jobs.get(id)?.lastProgress?.message)
          .find((message) => message !== undefined)
        sendProgress({
          progress: Math.round((Date.now() - startedAt) / 1000),
          total: waitSeconds,
          message: `waiting for ${waitedOn}: ${latest ?? 'no progress yet'}`,
        })
      } catch (error) {
        log(`could not send a progress notification: ${describeError(error)}`)
      }
    }, waitProgressIntervalMs)
    // The heartbeat must never be the only thing keeping the process alive.
    timer.unref?.()
    return () => clearInterval(timer)
  }

  /**
   * The answer for one ended (or still running) job, in the shape `flash_result` has always
   * used. `pending` is added when the call named several jobs: the ids still running, so a
   * group wait says what is left. `unknown` names the group ids neither the registry nor a
   * stored report answered.
   */
  const answerJob = (job, { wait, pending, unknown } = {}) => {
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
        ...(pending === undefined ? {} : { pending }),
        ...(unknown === undefined || unknown.length === 0 ? {} : { unknown }),
      })
    }
    if (job.error === undefined) {
      // The caller has the result now; the cap may reclaim the job under pressure, so the
      // one result it is allowed to drop is the one already delivered.
      job.collected = true
      // The call's full result, exactly as the synchronous call would have returned it, plus
      // the job's identity so the caller can tie it back to the id it holds.
      return okResult({
        ...job.result,
        job: { jobId: job.jobId, state: job.state, elapsedMs: status.elapsedMs },
        ...(wait === undefined ? {} : { wait }),
        ...(pending === undefined ? {} : { pending }),
        ...(unknown === undefined || unknown.length === 0 ? {} : { unknown }),
      })
    }
    // Failed or cancelled: the same message the synchronous dispatch would have produced.
    // A group wait still names what is pending and unknown, since an error envelope carries
    // no fields; the failure's own timing and salvage ride in the structured part, exactly as
    // they do for a foreground call.
    const message = `${job.kind} failed: ${describeError(job.error)} (job ${job.jobId})`
    const parts = []
    if (pending !== undefined && pending.length > 0) parts.push(`still running: ${pending.join(', ')}`)
    if (unknown !== undefined && unknown.length > 0) parts.push(`unknown: ${unknown.join(', ')}`)
    return errorResult(
      parts.length === 0 ? message : `${message}; ${parts.join('; ')}`,
      failureFields(job.error),
    )
  }

  /** The ids of `jobIds` that are still running and not already named as unknown, excluding the one whose answer is returned. */
  const pendingJobs = (jobIds, answered, unknown = []) =>
    jobIds.filter((id) => id !== answered && !unknown.includes(id) && jobs.get(id)?.state === 'running')

  /**
   * `flash_result` over several jobs: the first that ends answers, and `pending` names the
   * rest. Without a wait, the first id in the caller's order that has already ended wins, so
   * the answer is deterministic; with a wait, whichever job settles first wins.
   *
   * An id the registry no longer holds is not a refusal by itself: its stored report answers
   * exactly as the single-id path does, because a report outlives the process and the job's
   * eviction. Only an id with neither a held job nor a stored report is listed under
   * `unknown`, and the rest of the group still answers; the call refuses only when every id
   * is unknown.
   */
  const resultToolForJobs = async (jobIds, waitSeconds, signal, { progressToken, sendProgress } = {}) => {
    if (!Array.isArray(jobIds) || jobIds.length < 2 || jobIds.length > 16) {
      return errorResult(
        `flash_result failed: jobIds must be an array of 2 to 16 job ids; got ${JSON.stringify(jobIds)}`,
      )
    }
    const bad = jobIds.find((id) => typeof id !== 'string' || id.length === 0)
    if (bad !== undefined) {
      return errorResult(`flash_result failed: jobIds must contain only non-empty strings; got ${JSON.stringify(bad)}`)
    }
    const live = new Map()
    const stored = new Set()
    const unknown = []
    for (const id of jobIds) {
      const job = jobs.get(id)
      if (job !== undefined) live.set(id, job)
      else if (service?.readReport?.(id) !== undefined) stored.add(id)
      else unknown.push(id)
    }
    if (live.size === 0 && stored.size === 0) return unknownJobs('flash_result', unknown)
    // The unknown list is read at answer time: the wait may name one more id it no longer
    // found in the registry (an eviction between collecting the group and waiting on it).
    const unknownExtra = () => (unknown.length === 0 ? {} : { unknown: [...unknown] })
    // A stored report is an ended job by definition, so the first id in the caller's order
    // that is stored or held-and-ended is the deterministic answer with or without a wait.
    const readyId = jobIds.find(
      (id) => stored.has(id) || (live.get(id) !== undefined && live.get(id).state !== 'running'),
    )
    let job
    let answeredStored
    let wait
    if (readyId !== undefined) {
      if (stored.has(readyId)) answeredStored = readyId
      else job = live.get(readyId)
      if (waitSeconds > 0) {
        wait = { requestedMs: waitSeconds * 1000, waitedMs: 0, endedBy: 'not-waited' }
      }
    } else if (waitSeconds > 0) {
      const requestedMs = waitSeconds * 1000
      const startedWaiting = Date.now()
      const stopProgress = startWaitProgress({ jobIds, waitSeconds, progressToken, sendProgress })
      try {
        // Only held ids are waited on: a stored report is ready already, and an unknown id
        // is named in the answer rather than ending the wait.
        const outcome = await jobs.waitForAny([...live.keys()], requestedMs, signal)
        job = outcome.job
        // An id the registry dropped while the wait ran is named with the unknown ones, so
        // the answer never leaves it out of both `pending` and `unknown`.
        if (outcome.missing !== undefined && !unknown.includes(outcome.missing)) unknown.push(outcome.missing)
        wait = { requestedMs, waitedMs: Date.now() - startedWaiting, endedBy: outcome.endedBy }
      } finally {
        stopProgress()
      }
    }
    if (job === undefined && answeredStored === undefined) {
      // Nothing was ready (or nothing ended within the wait): the list is the answer.
      return okResult({
        pending: jobIds.filter((id) => !unknown.includes(id) && jobs.get(id)?.state === 'running'),
        ...(wait === undefined ? {} : { wait }),
        ...unknownExtra(),
      })
    }
    const answered = answeredStored ?? job.jobId
    if (answeredStored !== undefined) {
      return storedReport('flash_result', answeredStored, {
        pending: pendingJobs(jobIds, answered, unknown),
        ...unknownExtra(),
      })
    }
    return answerJob(job, {
      ...(wait === undefined ? {} : { wait }),
      pending: pendingJobs(jobIds, answered, unknown),
      ...unknownExtra(),
    })
  }

  const resultTool = async (args, signal, { progressToken, sendProgress } = {}) => {
    const jobId = args?.jobId
    const jobIds = args?.jobIds
    if (jobId !== undefined && jobIds !== undefined) {
      return errorResult('flash_result failed: pass either jobId or jobIds, not both')
    }
    const waitSeconds = args?.waitSeconds ?? 0
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 600) {
      return errorResult(
        `flash_result failed: waitSeconds must be an integer between 0 and 600; got ${JSON.stringify(args?.waitSeconds)}`,
      )
    }
    if (jobIds !== undefined) {
      return resultToolForJobs(jobIds, waitSeconds, signal, { progressToken, sendProgress })
    }
    if (typeof jobId !== 'string' || jobId.length === 0) {
      return errorResult(`flash_result failed: jobId must be a non-empty string; got ${JSON.stringify(jobId)}`)
    }
    if (jobs.get(jobId) === undefined) return storedReport('flash_result', jobId)
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
    if (job === undefined) return storedReport('flash_result', jobId)
    return answerJob(job, wait === undefined ? {} : { wait })
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
    // The salvage the call's own cancellation path ran: the copy's change stored as a patch
    // before the copy was retired, or the plain statement that there was nothing to store.
    const salvage = (settledJob ?? job).error?.salvage
    return okResult({
      ...status,
      ...(salvage?.patchId === undefined ? {} : { patchId: salvage.patchId, diffstat: salvage.diffstat, filesChanged: salvage.filesChanged }),
      ...(salvage?.patchId !== undefined || salvage?.note === undefined ? {} : { stored: false, storedNote: salvage.note }),
      note:
        status.state === 'running'
          ? 'the job is still running; its call has not settled yet'
          : 'the job settled after cancellation',
    })
  }

  // Read once from the schemas themselves, so a property added to a tool is accepted the
  // moment it is described, and the refusal below can never disagree with `tools/list`.
  const argumentNames = toolArgumentNames(listTools(service?.models))

  return async function callTool(name, args = {}, { signal, progressToken, sendProgress } = {}) {
    // Before anything else, the background door included: a misspelt argument is otherwise
    // ignored, and `flash_patch` with `file` instead of `files` answered three times with the
    // first page of the whole patch rather than once with the mistake.
    // The refusal reads like every other INVALID_ARGUMENT one: the tool, then the reason.
    const unknown = unknownArgumentsMessage(name, args, argumentNames.get(name))
    if (unknown !== undefined) {
      log(`${name} failed: ${unknown}`)
      return errorResult(`${name} failed: ${unknown}`)
    }
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
      // A failed call's timing and salvage are data, not prose: they ride in the structured
      // part a finished call's result uses, so a client reads them without parsing the line.
      return errorResult(`${name} failed: ${describeError(error)}`, failureFields(error))
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
function errorResult(text, structured) {
  return {
    content: [{ type: 'text', text }],
    ...(structured === undefined ? {} : { structuredContent: structured }),
    isError: true,
  }
}

/**
 * The structured facts a failed call carries, in the fields `flash_cancel` already reports.
 *
 * The text says what went wrong; the breakdown a timeout measured and the patch a
 * cancellation salvaged are the data beside it, and a caller that wants them should not have
 * to parse a sentence. Nothing is invented: a failure that carries neither adds no part.
 *
 * @param {unknown} error - the failure the dispatcher or a job holds.
 * @returns {object | undefined} the structured part, or undefined when the failure has none.
 */
function failureFields(error) {
  if (error === null || typeof error !== 'object') return undefined
  const fields = {}
  if (error.timing !== undefined) fields.timing = error.timing
  const salvage = error.salvage
  if (salvage?.patchId !== undefined) {
    fields.patchId = salvage.patchId
    fields.diffstat = salvage.diffstat
    fields.filesChanged = salvage.filesChanged
  } else if (salvage?.note !== undefined) {
    fields.stored = false
    fields.storedNote = salvage.note
  }
  return Object.keys(fields).length === 0 ? undefined : fields
}

/** A shallow copy of `args` without one property; never mutates the caller's object. */
function omit(args, key) {
  if (args === null || typeof args !== 'object') return {}
  const { [key]: _dropped, ...rest } = args
  return rest
}

/**
 * Argument names MCP itself may put on any object. `_meta` is reserved by the protocol for
 * client metadata; a client that sends it inside `arguments` has not misspelt anything.
 */
const MCP_RESERVED_ARGUMENTS = new Set(['_meta'])

/**
 * The argument names each tool's schema declares, top level and, for `flash_batch`, inside
 * an object task entry.
 *
 * Every schema says `additionalProperties: false`, but nothing enforced it. Reading the names
 * out of the descriptors `tools/list` returns, rather than listing them again, is what keeps
 * the check and the schema one fact.
 *
 * @param {Array<object>} tools - the MCP tool descriptors (see `listTools`).
 * @returns {Map<string, {top: string[], item?: string[]}>} the names, by tool.
 */
export function toolArgumentNames(tools) {
  const names = new Map()
  for (const tool of tools) {
    const properties = tool?.inputSchema?.properties ?? {}
    const entry = properties.tasks?.items?.oneOf?.find((choice) => choice?.type === 'object')
    names.set(tool.name, {
      top: Object.keys(properties),
      ...(entry?.properties === undefined ? {} : { item: Object.keys(entry.properties) }),
    })
  }
  return names
}

/**
 * The refusal for arguments a tool does not declare, or undefined when every name is known.
 *
 * Unknown names in a `flash_batch` task entry are refused the same way, with the entry's
 * index. A `model` inside an entry is left alone here: the service refuses it with the
 * sentence that says where the fleet's model goes, which is more use than "unknown".
 *
 * @param {string} tool - the tool name.
 * @param {unknown} args - the call's arguments.
 * @param {{top: string[], item?: string[]} | undefined} names - what the tool's schema declares.
 * @returns {string | undefined} the refusal message.
 */
export function unknownArgumentsMessage(tool, args, names) {
  if (names === undefined || args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const top = unknownNames(args, names.top)
  if (top.length > 0) return describeUnknown(top, names.top, `for ${tool}`)
  if (names.item === undefined || !Array.isArray(args.tasks)) return undefined
  for (const [index, entry] of args.tasks.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const inEntry = unknownNames(entry, names.item).filter((key) => key !== 'model')
    if (inEntry.length > 0) return describeUnknown(inEntry, names.item, `in tasks[${String(index)}] of ${tool}`)
  }
  return undefined
}

/** The keys of `object` that are neither declared nor reserved by MCP, in their own order. */
function unknownNames(object, known) {
  return Object.keys(object).filter((key) => !known.includes(key) && !MCP_RESERVED_ARGUMENTS.has(key))
}

/**
 * One sentence naming the unknown keys, with the closest declared name for each that has one.
 * The declared names are listed whenever a key has no close match, because then the caller
 * needs the list rather than a guess.
 */
function describeUnknown(unknown, known, where) {
  const guesses = unknown.map((key) => closestName(key, known))
  if (unknown.length === 1 && guesses[0] !== undefined) {
    return `unknown argument "${unknown[0]}" ${where}; did you mean "${guesses[0]}"?`
  }
  const named = unknown.map((key, index) =>
    guesses[index] === undefined ? `"${key}"` : `"${key}" (did you mean "${guesses[index]}"?)`,
  )
  const noun = unknown.length === 1 ? 'argument' : 'arguments'
  return `unknown ${noun} ${named.join(', ')} ${where}; its arguments are ${known.join(', ')}`
}

/**
 * The declared name a misspelt key most plausibly meant, or undefined when none is close.
 *
 * Case is ignored (`taskfile` meant `taskFile`), a short key that starts a single declared
 * name counts (`wait` meant `waitSeconds`), and otherwise the edit distance must stay small:
 * one edit for a name of three letters or fewer, two for a longer one, so `foo` is never read
 * as `cwd`.
 *
 * @param {string} key - the unknown key.
 * @param {string[]} known - the declared names.
 * @returns {string | undefined} the closest declared name.
 */
function closestName(key, known) {
  const lower = key.toLowerCase()
  const same = known.find((name) => name.toLowerCase() === lower)
  if (same !== undefined) return same
  let best
  let bestDistance = Infinity
  for (const name of known) {
    const distance = editDistance(lower, name.toLowerCase())
    if (distance < bestDistance) {
      best = name
      bestDistance = distance
    }
  }
  const allowed = Math.min(lower.length, best?.length ?? 0) <= 3 ? 1 : 2
  if (best !== undefined && bestDistance <= allowed) return best
  const prefixed = known.filter((name) => lower.length >= 3 && name.toLowerCase().startsWith(lower))
  return prefixed.length === 1 ? prefixed[0] : undefined
}

/** Levenshtein distance; the names compared are a dozen characters, so the table is tiny. */
function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i]
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = row
  }
  return previous[b.length]
}

/**
 * The one-line label a job carries into `flash_status` and the log. It is read from the raw
 * arguments, before the service validates them, because a background call must answer at
 * once; a malformed call ends failed and keeps this label.
 *
 * A call that chose a model other than the default says so in front of the label, so a
 * status listing shows which model a running job is spending on.
 *
 * A `taskFile` call is labelled with the brief's own first line: a job that reports
 * "(untitled task)" for hours tells the caller nothing about which of its calls is running.
 * The file is read through `readTaskFile`, the service's own fence and limits, with its log
 * silenced — the service reads the same file again when the call runs, and one "task read
 * from" line is enough. A file that cannot be read leaves `taskFile <path>` as the label,
 * which is at least the one fact a status reader can act on.
 *
 * A `label` argument replaces the brief's first line altogether.
 *
 * @param {string} kind - the tool name.
 * @param {object} args - the raw tool arguments.
 * @param {string} [defaultModel] - the service's default model.
 * @param {string} [root] - the service root a relative `taskFile` resolves against.
 * @returns {string} the label.
 */
export function jobLabel(kind, args, defaultModel, root) {
  const chosen = typeof args?.model === 'string' && args.model.length > 0 && args.model !== defaultModel
  const prefix = chosen ? `[${args.model}] ` : ''
  // The caller's own label wins over anything read from the brief. A bad one is left to the
  // service to refuse, so it is ignored here rather than throwing before the refusal.
  const named = typeof args?.label === 'string' ? args.label.trim() : ''
  if (named.length > 0 && named.length <= 120) return `${prefix}${named}`
  if (kind === 'flash_batch') {
    const count = Array.isArray(args?.tasks) ? args.tasks.length : 0
    return `${prefix}${String(count)} tasks`
  }
  // An inline task keeps its historical label: its very first line, blank or not.
  const firstLine = typeof args?.task === 'string' ? (args.task.split('\n')[0] ?? '').trim() : ''
  if (firstLine.length === 0 && typeof args?.taskFile === 'string' && args.taskFile.length > 0) {
    const fromFile = taskFileLabel(root, args.taskFile)
    // The unreadable case keeps the whole path: it is the only fact there is to act on, and
    // truncating it would name a file that does not exist.
    return fromFile === undefined ? `${prefix}taskFile ${args.taskFile}` : `${prefix}${fromFile}`
  }
  return `${prefix}${clip(firstLine.length === 0 ? '(untitled task)' : firstLine, 80)}`
}

/**
 * The first line of a brief, or undefined when the file cannot be read.
 *
 * The label comes from `taskLabel`, the same helper a stored patch's task record uses: a
 * Markdown heading's `#` is noise on a status line, and the job the caller watches and the
 * patch that outlives it must name one brief identically.
 *
 * @param {string | undefined} root - the service root; without one nothing can be read.
 * @param {string} taskFile - the `taskFile` argument, as given.
 * @returns {string | undefined} the brief's label, or undefined when it has none.
 */
function taskFileLabel(root, taskFile) {
  if (typeof root !== 'string' || root.length === 0) return undefined
  try {
    const text = readTaskFile(root, taskFile, { log: () => {} })
    const line = taskLabel(text, 80)
    return line.length === 0 ? undefined : line
  } catch {
    // A label is not worth failing a background call over; the path is still the answer.
    return undefined
  }
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
 * @param {object} [wiring] - how this service will be run, which the options do not say.
 * @param {boolean} [wiring.deferStartupSweep] - leave the store migration, dead-owner
 *   sweep, disk hygiene and patch load to `startupSweep()`. Only the stdio server does:
 *   it answers `initialize` first and starts the sweep once the client has finished the
 *   handshake (see `startServer`). The doctor's `--e2e` run and every other caller keep
 *   the constructor's behaviour, because they read the swept state immediately.
 * @returns {FlashTaskService} the service.
 */
export function createService(options, log = () => {}, { deferStartupSweep = false } = {}) {
  // The profile stamps are read only when the caller asks for it. This is the server's
  // start, where naming a stale profile is worth one log line and a warning on every
  // flash_task and flash_batch result. `doctor --e2e` builds the same service but must
  // read no real harness home, so it does not set the flag: handing in an environment is
  // not the same request as asking to inspect the profiles installed in it.
  //
  // The verdicts are kept per profile, not as one flat list, because a runtime that boots
  // later re-reads its own profile's stamp (see `#ensureRuntime`) and a result carries the
  // verdict of the runtime that served it. The start lines stay exactly as they were.
  const startupWarnings = []
  const profileStampWarnings = new Map()
  const readProfileStampWarning =
    options?.profileStampReader ??
    ((name) =>
      profileVersionWarning({
        dshHome: resolveDshHome(options?.env?.DSH_HOME, options?.home ?? homedir()),
        profile: name,
        pluginFolder: REPO_ROOT,
      }))
  // Without an environment there is no `DSH_HOME` to resolve, and falling back to the
  // process's own home would read the real `~/.dsh` on a caller that never named one.
  const checkProfileStamp = options?.checkProfileStamp === true && options.env !== undefined
  if (checkProfileStamp) {
    const profile = options?.profile ?? 'flash-service'
    const names = profile.endsWith('-readonly') ? [profile] : [profile, `${profile}-readonly`]
    for (const name of names) {
      let warning
      try {
        warning = readProfileStampWarning(name)
      } catch (error) {
        // A reader that throws has not established a stale profile; it has established
        // nothing. The start still succeeds, the verdict is unknown (no warning), and the
        // one log line says why — the same choice `#refreshProfileStamp` makes later.
        warning = undefined
        log(`could not read the ${name} profile stamp: ${error instanceof Error ? error.message : String(error)}`)
      }
      profileStampWarnings.set(name, warning)
      // One line per stale profile at start: the operator sees the drift before the first
      // call, and the same sentence comes back from the runtime that profile boots.
      if (warning !== undefined) log(warning)
    }
  }
  return new FlashTaskService({
    ...options,
    startupWarnings,
    checkProfileStamp,
    profileStampWarnings,
    ...(checkProfileStamp ? { profileStampReader: readProfileStampWarning } : {}),
    // The service's allowlist always holds its own default first, whichever door named it
    // (`route.models`, FLASH_MODELS, or --model).
    models: modelChoices(options?.model, options?.models),
    isolate: {
      mode: options.isolate,
      ...(options.slots === undefined ? {} : { slots: options.slots }),
      ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
      // `--state-dir` replaces the default layout outright, so its base is irrelevant then;
      // `WorkspaceIsolation` already prefers `stateDir` when both are present.
      ...(options.stateBase === undefined ? {} : { baseDir: options.stateBase }),
      ...(options.copyExclude === undefined ? {} : { copyExclude: options.copyExclude }),
      ...(options.allowSlotSetup === true ? { allowSlotSetup: true } : {}),
      ...(options.diffChars === undefined ? {} : { diffChars: options.diffChars }),
      ...(options.patchRetentionDays === undefined ? {} : { patchRetentionDays: options.patchRetentionDays }),
      ...(options.maxStateBytes === undefined ? {} : { maxStateBytes: options.maxStateBytes }),
      ...(deferStartupSweep ? { deferStartupSweep: true } : {}),
    },
    log,
  })
}

/**
 * How long `serve` waits for the client's `notifications/initialized` before starting the
 * deferred start-up sweep anyway.
 *
 * The notification is what tells the server the handshake is done, and every client
 * sends it, but the sweep must not depend on it: a client that never sends it would
 * otherwise leave every dead owner's trees on disk forever.
 */
const STARTUP_SWEEP_FALLBACK_MS = 5_000

/**
 * Start the server on stdio.
 *
 * The service is built with the start-up sweep deferred, so the `initialize` answer is
 * written before any migration, salvage or deletion runs: on a machine whose dead slots
 * held multi-gigabyte build trees, deleting them inside the constructor outlasted the
 * client's 30 s connect timeout and the client killed the server mid-sweep. The sweep
 * starts when the client reports the handshake finished, or after the fallback delay.
 *
 * @param {object} [options] - parsed options.
 * @param {NodeJS.ReadableStream} [input] - protocol input.
 * @param {NodeJS.WritableStream} [output] - protocol output.
 * @param {object} [timing] - timings and effects a test can shorten or inject.
 * @param {number} [timing.startupSweepDelayMs] - fallback delay before the start-up sweep.
 * @param {Record<string, string | undefined>} [timing.env] - environment for the service and
 *   the start probes (default `options.env`, then process.env).
 * @param {string} [timing.platform] - platform the start probes resolve for (default process.platform).
 * @param {string} [timing.execPath] - the running Node binary the launcher probe searches
 *   version-manager siblings of (default process.execPath).
 * @param {(directory: string) => string[]} [timing.listDir] - directory listing for that
 *   sibling lookup; injectable so a start-log test needs no real nvm layout.
 * @param {(message: string) => void} [timing.log] - extra diagnostic sink, so a test can
 *   read the start log without capturing the process's stderr.
 * @param {() => number} [timing.uptimeMs] - how long the process has been running, measured
 *   from process start rather than from module load (default `process.uptime()`); injectable
 *   so the initialize timing can be pinned without waiting.
 * @returns {{service: FlashTaskService, connection: {close: () => void}, done: Promise<void>}}
 */
export function startServer(
  options,
  input = process.stdin,
  output = process.stdout,
  {
    startupSweepDelayMs = STARTUP_SWEEP_FALLBACK_MS,
    env,
    platform = process.platform,
    execPath = process.execPath,
    listDir,
    log: extraLog,
    uptimeMs = () => process.uptime() * 1000,
  } = {},
) {
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
    extraLog?.(message)
    if (logFd === undefined) return
    try {
      appendFileSync(logFd, `${new Date().toISOString()} ${line}\n`)
    } catch (error) {
      logFd = undefined
      reportLogFileFailure(error)
    }
  }
  const environment = env ?? options.env ?? process.env
  // First line once the sink exists, before `createService` can spend seconds sweeping or
  // throw: a client that never connects must still be distinguishable from a server that
  // never started. The root is named as the caller gave it, because that is what the log
  // reader can compare with their own command line; a server started without one uses cwd.
  const rootAsGiven =
    typeof options?.root === 'string' && options.root.length > 0 ? options.root : process.cwd()
  log(
    `start pid ${String(process.pid)}; flash-agents ${FLASH_MCP_VERSION}; node ${process.versions.node}; ` +
      `${platform}; root ${rootAsGiven}`,
  )
  // Only the server checks the installed profile stamps: it is the long-lived process whose
  // results carry the warning, and the operator starts it against their real harness home.
  const service = createService({ ...options, env: environment, platform, checkProfileStamp: true }, log, {
    deferStartupSweep: true,
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

  // One trigger wins, and `startupSweep` is idempotent anyway: the notification normally
  // comes first, the timer is the fallback for a client that never sends it.
  let sweepStarted = false
  const startSweep = (trigger) => {
    if (sweepStarted) return
    sweepStarted = true
    log(`startup sweep started (${trigger})`)
    void service.isolation?.startupSweep()
  }

  // The launcher is resolved once, after the handshake, so a missing `dsh` is one log
  // line at start instead of every call failing seconds later. Resolution is only a few
  // file lookups, but it is queued so it can never sit between `initialize` and its answer.
  let probeStarted = false
  const startLauncherProbe = () => {
    if (probeStarted) return
    probeStarted = true
    setImmediate(() => {
      try {
        resolveDshCommand(environment, platform, {
          execPath,
          ...(listDir === undefined ? {} : { listDir }),
        })
      } catch (error) {
        // The per-call path resolves the same launcher and throws the same sentence, so
        // the start log and a failed call cannot disagree about what is wrong.
        log(describeError(error))
      }
    })
  }

  const startStartupWork = (trigger) => {
    startSweep(trigger)
    startLauncherProbe()
  }

  const models = modelChoices(service.model, service.models)
  // Answered, not merely connected: this is the fact a user could not see when a client
  // spent four hours deciding not to connect. The measurement starts at process start,
  // not module load, so a slow module graph is part of what the number reports.
  let initializeLogged = false
  const logInitializeAnswered = () => {
    if (initializeLogged) return
    initializeLogged = true
    const elapsed = Math.max(0, Math.round(Number(uptimeMs()) || 0))
    log(`answered initialize ${String(elapsed)} ms after the process started`)
  }
  const connection = serveStdio({
    serverInfo: SERVER_INFO,
    instructions: instructionsFor(models),
    listTools: () => listTools(models),
    log,
    input,
    output,
    callTool: createToolCaller({ service, jobs: new JobRegistry({ log }), log }),
    onInitializeAnswered: logInitializeAnswered,
    onInitialized: () => startStartupWork('after initialize'),
  })
  // Unref'd: the fallback must never be the reason a finished process stays alive.
  const sweepTimer = setTimeout(() => startStartupWork('after 5s without initialized'), startupSweepDelayMs)
  sweepTimer.unref?.()

  const done = new Promise((resolveDone) => {
    const finish = async () => {
      clearTimeout(sweepTimer)
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
  let stateBaseProblem
  let stateBaseProblemFromLocal = false
  const parseEnv = flags.copy ? envWithProjectRoot(env) : env
  try {
    options = parseOptions(flags.optionsArgv, parseEnv, config)
  } catch (error) {
    // A bad `--state-base` flag is a mistyped option, reported like every other; a bad setting
    // (FLASH_STATE_BASE) is what the plugin hands the server, so it becomes a failed row.
    if (error?.code !== 'STATE_BASE_INVALID' || flags.optionsArgv.includes('--state-base')) {
      emit(`flash-agents: ${describeError(error)}\n\n${usage()}`)
      return 2
    }
    // The server would exit on this value; the report should show that as a failed row, and
    // still check everything else, so it is parsed again without the unusable base.
    const fromLocalFile =
      typeof error?.stateBaseSource === 'string' && error.stateBaseSource.startsWith(LOCAL_SETTINGS_FILE)
    stateBaseProblemFromLocal = fromLocalFile
    stateBaseProblem = fromLocalFile
      ? `${error.stateBaseSource} sets "stateBase" to ${JSON.stringify(error.stateBaseValue === undefined ? '' : error.stateBaseValue)}, which cannot be used on ${process.platform} (${describeError(error)})`
      : `the plugin setting "state_base" (FLASH_STATE_BASE) is ${JSON.stringify(configuredStateBase(flags.optionsArgv, parseEnv) ?? '')}, which cannot be used on ${process.platform} (${describeError(error)})`
    try {
      // Drop both sources at once: an unusable base in either the environment or the local
      // file must not keep the rest of the report from running.
      options = parseOptions(flags.optionsArgv, { ...parseEnv, FLASH_STATE_BASE: '' }, config, {
        ignoreLocalSettings: true,
      })
    } catch (second) {
      emit(`flash-agents: ${describeError(second)}\n\n${usage()}`)
      return 2
    }
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
      root: options.root,
      ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
      ...(options.stateBase === undefined ? {} : { stateBase: options.stateBase }),
      ...(options.stateBaseSource === undefined ? {} : { stateBaseSource: options.stateBaseSource }),
      ...(options.stateBaseLocalFile === undefined ? {} : { stateBaseLocalFile: options.stateBaseLocalFile }),
      ...(options.localSettingsProblem === undefined ? {} : { localSettingsProblem: options.localSettingsProblem }),
      ...(stateBaseProblem === undefined ? {} : { stateBaseProblem }),
      ...(stateBaseProblemFromLocal ? { stateBaseProblemFromLocal: true } : {}),
      disk: true,
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
        // No `checkProfileStamp`: this run must not inspect the profiles installed in that
        // environment, only prove the runtime the server would start.
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

Usage: flash-agents clean [--all] [--caches] [--root <path>] [--state-base <path>] [--patch-retention-days <n>]

  --all                      also remove the slot trees of roots with no live server
  --caches                   remove only build caches: the stored ones, and the cache of every dead
                             server's slots; trees, patches and owners are left alone
  --root <path>              service root whose digest is swept (default: cwd), and whose
                             .flash-agents.local.json may name the state base
  --state-base <path>        base directory of the default layout (default: the local
                             settings file of --root, else $TMPDIR/flash-mcp or
                             FLASH_STATE_BASE); it must be absolute and a leading ~ is
                             expanded; pass the same base the server runs with
  --patch-retention-days <n> days an unapplied patch is kept (default: flash.config.json)

The default removes what a server startup removes for --root: dead owners (salvaging
their unfinished trees as patches), expired patches, and other roots' empty digest
directories. Patches are never removed by --all. Build caches kept between servers are
removed too (with --all, those of every root that has no live server); --caches removes
nothing else.
`

/**
 * Report and reclaim the state directory, one line per root digest.
 *
 * The layout it reads is the default one the service writes: `$TMPDIR/flash-mcp` with
 * one digest directory per root, one directory per server pid under it, and a durable
 * per-root patch store under the platform data directory (or `FLASH_DATA_DIR`). A legacy
 * `patches/` directory under the temp tree is pruned too, so an upgrade leaves nothing
 * behind to age out twice. Sizes are printed in MB because the report answers a disk
 * question, not a file-count one. Every removal the run reports is finished before the
 * report is printed, `trash-*` directories included: `clean` exits the process right after
 * the summary, so a background deletion would be abandoned half done.
 *
 * @param {string[]} [argv] - arguments after `clean`.
 * @param {object} [options] - injected effects, for tests.
 * @param {Record<string, string | undefined>} [options.env] - environment to read.
 * @param {(text: string) => void} [options.write] - output sink.
 * @param {string} [options.baseDir] - the state base directory, for tests.
 * @param {string} [options.home] - the home directory a `~` base expands against (default
 *   the process's; injectable so a test needs no real home).
 * @param {string} [options.platform] - platform whose local settings section applies
 *   (default `process.platform`; injectable so a test needs no real platform).
 * @param {number} [options.now] - the current time, for tests.
 * @returns {Promise<number>} the exit code: 0 unless an argument is unknown.
 */
export async function runClean(
  argv = [],
  { env = process.env, write, baseDir, home = homedir(), platform = process.platform, now } = {},
) {
  const emit = write ?? ((text) => process.stdout.write(text))
  let all = false
  let cachesOnly = false
  let root = textFrom(env.FLASH_SERVICE_ROOT) ?? process.cwd()
  // The base the server's default layout sits under, in the server's own order: the flag
  // wins, then this machine's local settings file (which the plugin setting cannot
  // override), then the environment/plugin setting. An injected base (tests) stands in for
  // the environment layer. Without any, `cleanLayout` uses the platform temp base.
  let base = baseDir ?? textFrom(env.FLASH_STATE_BASE)
  let baseFromFlag = false
  /** @type {{value: string, source: string, path: string} | {problem: string, path: string} | undefined} */
  let localState
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
    else if (flag === '--caches') cachesOnly = true
    else if (flag === '--root') root = next()
    else if (flag === '--state-base') {
      base = next()
      baseFromFlag = true
    } else if (flag === '--patch-retention-days') retentionDays = numberFrom(next(), undefined)
    else if (flag === '--help' || flag === '-h') {
      emit(CLEAN_USAGE)
      return 0
    } else throw new Error(`unknown argument "${flag}"`)
  }
  if (!baseFromFlag) localState = localStateBase(root, platform)
  if (localState?.value !== undefined) base = localState.value
  const config = loadConfig({ env })
  // The base `clean` sweeps is the base the server would create: `~` expanded, and a
  // relative path refused, because a relative base resolves against the service root and
  // would make `clean` work inside the caller's repository instead of under the state base.
  try {
    base = requireAbsoluteStateBase(base, home)
  } catch (error) {
    // Carry the origin, so a bad local value is reported as that file's, like the server.
    if (localState?.value !== undefined && error !== null && typeof error === 'object') {
      if (!('stateBaseSource' in error)) error.stateBaseSource = localState.source
      if (!('stateBaseValue' in error)) error.stateBaseValue = localState.value
    }
    throw error
  }
  const dataDir = textFrom(env.FLASH_DATA_DIR)
  const report = cleanLayout({
    ...(base === undefined ? {} : { baseDir: base }),
    ...(dataDir === undefined ? {} : { dataDir }),
    root: canonicalRoot(root),
    all,
    cachesOnly,
    retentionDays: retentionDays ?? config.limits.patchRetentionDays,
    // The process exits right after this report, so every removal must be finished before
    // `cleanLayout` returns: a background deletion would be abandoned with the process
    // while the summary claimed the disk had been reclaimed.
    removal: 'sync',
    ...(now === undefined ? {} : { now }),
    log: (message) => emit(`[flash-mcp clean] ${message}\n`),
  })
  // A base `clean` takes from the local settings file is named with its path, so a user
  // editing FLASH_STATE_BASE knows which file to change instead.
  const localBase = localState?.value === undefined ? undefined : localState
  const localFile = localBase === undefined ? undefined : localBase.path
  emit(
    `flash-mcp state: ${report.baseDir}` +
      (localBase === undefined ? '' : ` (from ${localBase.source} at ${localFile})`) +
      '\n',
  )
  emit(`flash-mcp patches: ${report.patchDir}\n`)
  if (report.legacyPatchDir !== undefined) emit(`flash-mcp legacy patches: ${report.legacyPatchDir}\n`)
  for (const entry of report.stats) {
    const pids = entry.livePids.length === 0 ? 'none' : entry.livePids.join(', ')
    emit(
      `${entry.digest}${entry.own ? ' (this root)' : ''}  live pids: ${pids} | ` +
        `slot trees: ${String(entry.slotTrees)} (${formatMb(entry.slotBytes)}) | ` +
        `patches: ${String(entry.patches)} (${formatMb(entry.patchBytes)}) | ` +
        `reports: ${String(entry.reports)} (${formatMb(entry.reportBytes)}) | ` +
        `stored caches: ${String(entry.caches)} (${formatMb(entry.cacheBytes)})\n`,
    )
  }
  const { actions } = report
  if (cachesOnly) {
    emit(`removed: ${String(actions.cachesRemoved)} build cache(s) (stored, and of dead servers' slots); nothing else was touched\n`)
    return 0
  }
  emit(
    `removed: ${String(actions.deadOwnersRemoved)} dead owner(s), ${String(actions.patchesPruned)} expired patch(es), ` +
      // Reports age out on the same window and by the same command; a summary that left them
      // out named a smaller removal than actually happened, as it once did for caches.
      `${String(actions.reportsPruned)} expired report(s), ` +
      `${String(actions.emptyDigestsRemoved)} empty digest(s)` +
      (all ? `, ${String(actions.foreignTreesRemoved)} foreign tree(s)` : '') +
      // The trash a crash left between the rename and the delete is disk `clean` reclaimed
      // too; a summary that left it out named a smaller removal than actually happened.
      `, ${String(actions.trashRemoved)} trash director${actions.trashRemoved === 1 ? 'y' : 'ies'}` +
      `, ${String(actions.cachesRemoved)} stored cache(s)` +
      '\n',
  )
  return 0
}

/**
 * The state base a command line and environment name, as the server's option parsing reads it:
 * `--state-base` wins over `FLASH_STATE_BASE`.
 *
 * @param {string[]} argv - arguments after the command name.
 * @param {Record<string, string | undefined>} env - environment to read.
 * @returns {string | undefined} the raw value.
 */
function configuredStateBase(argv, env) {
  const at = argv.lastIndexOf('--state-base')
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : textFrom(env.FLASH_STATE_BASE)
}

/**
 * Where a server that cannot start writes why: the configured log file, else `flash.log` in the
 * durable data directory.
 *
 * @param {string[]} argv - arguments after the command name.
 * @param {Record<string, string | undefined>} env - environment to read.
 * @returns {string} the log path.
 */
function startupLogPath(argv, env) {
  const at = argv.lastIndexOf('--log-file')
  const given = at >= 0 && at + 1 < argv.length ? argv[at + 1] : textFrom(env.FLASH_LOG_FILE)
  return given ?? join(durableBaseDir(env), 'flash.log')
}

/**
 * Append one `[flash-mcp]` line to the configured log file, falling back to `flash.log` in the
 * data directory when the configured one cannot be written.
 *
 * @param {string} message - the line, without the timestamp or prefix.
 * @param {object} options - what the process was started with.
 * @param {string[]} options.argv - arguments after the command name.
 * @param {Record<string, string | undefined>} [options.env] - environment to read.
 * @returns {string} the log file written, or '' when none could be.
 */
function writeStartupLog(message, { argv, env = process.env }) {
  const configured = startupLogPath(argv, env)
  const fallback = join(durableBaseDir(env), 'flash.log')
  for (const path of configured === fallback ? [configured] : [configured, fallback]) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      const where = path === configured ? '' : ` (written to ${path} because the configured log file could not be written)`
      appendFileSync(path, `${new Date().toISOString()} [flash-mcp] ${message}${where}\n`)
      return path
    } catch {
      // The next candidate, then stderr alone.
    }
  }
  return ''
}

/**
 * Say why the server is exiting because the configured state base is unusable: to stderr and to
 * flash.log, naming the setting, its value and the platform.
 *
 * The log file's location is the plugin's own (`FLASH_LOG_FILE`) and does not depend on the state
 * base. When none is configured, or it cannot be written, the line goes to `flash.log` in the data
 * directory, and the message says where.
 *
 * @param {Error} error - the refusal `parseOptions` raised.
 * @param {object} options - what the process was started with.
 * @param {string[]} options.argv - arguments after the command name.
 * @param {Record<string, string | undefined>} [options.env] - environment to read.
 * @param {string} [options.platform] - the platform to name.
 * @returns {string} the log file the reason was written to, or '' when none could be written.
 */
export function reportStateBaseRefusal(error, { argv, env = process.env, platform = process.platform }) {
  // A value from the local settings file names that file, because clearing the plugin
  // setting would not fix it. Everything else keeps the wording the plugin setting had.
  const fromLocalFile =
    typeof error?.stateBaseSource === 'string' && error.stateBaseSource.startsWith(LOCAL_SETTINGS_FILE)
  const value = fromLocalFile ? error.stateBaseValue : configuredStateBase(argv, env)
  const shown = JSON.stringify(value === undefined ? '' : value)
  const message = fromLocalFile
    ? `cannot start: ${error.stateBaseSource} sets "stateBase" to ${shown}, which cannot be used on ${platform} ` +
      `(${describeError(error)}); clear it or give an absolute path for this platform`
    : `cannot start: the plugin setting "state_base" (FLASH_STATE_BASE) is ${shown}, which cannot be used on ${platform} ` +
      `(${describeError(error)}); clear the setting or give an absolute path for this platform`
  const written = writeStartupLog(message, { argv, env })
  process.stderr.write(`[flash-mcp] ${message}${written === '' ? '' : `; logged to ${written}`}\n`)
  return written
}

/**
 * Say that `.flash-agents.local.json` was ignored, because a file the operator edited and a
 * synced plugin setting otherwise decided the state base without a word: one line to stderr and
 * to flash.log. The value is still ignored; this only makes the reason visible.
 *
 * @param {{path: string, message: string}} problem - the file and why it was not used.
 * @param {object} options - what the process was started with.
 * @param {string[]} options.argv - arguments after the command name.
 * @param {Record<string, string | undefined>} [options.env] - environment to read.
 * @returns {string} the log file the reason was written to, or '' when none could be written.
 */
function reportLocalSettingsProblem(problem, { argv, env = process.env }) {
  const message =
    `the local settings file ${problem.path} was ignored (${problem.message}); ` +
    'its "stateBase" setting does not apply'
  const written = writeStartupLog(message, { argv, env })
  process.stderr.write(`[flash-mcp] ${message}${written === '' ? '' : `; logged to ${written}`}\n`)
  return written
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
    // Claude Code shows only "Connection closed" for a server that exits at once, so a state
    // base the settings made unusable is written where the user can read it before exiting.
    if (error?.code === 'STATE_BASE_INVALID') reportStateBaseRefusal(error, { argv })
    process.stderr.write(`flash-agents: ${describeError(error)}\n\n${usage()}`)
    process.exit(2)
  }
  if (options.help) {
    process.stdout.write(usage())
    return
  }
  // A local settings file the operator edited but the server could not use is named once,
  // before the service starts; the plugin setting it loses to is otherwise invisible.
  if (options.localSettingsProblem !== undefined) {
    reportLocalSettingsProblem(options.localSettingsProblem, { argv })
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
