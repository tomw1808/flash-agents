/**
 * `flash_task` / `flash_batch`: cheap, sandboxed delegation per call, executed by
 * Harness — one worker for a single task, or a bounded fleet for many.
 *
 * Every call creates a fresh SDK session on the persistent runtime, sends one
 * tightly constrained dispatch prompt, waits for the session to go idle, and
 * returns a compact structured result built from the runtime's own
 * `subagent.finished` notification plus the child's logged request header.
 *
 * Ownership stays with Harness: the prompt asks an agent to call the composed
 * `flash` tool, and that provider — not this module — decides the route, the
 * child's lifecycle, and the child's limits. Nothing here reimplements
 * delegation, and no child transcript is returned.
 *
 * @module flash-mcp/service
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  IsolationError,
  WorkspaceIsolation,
  canonicalTmpdir,
  recordPaths,
  settingsChangedWarning,
  slotPathWarning,
  slotRootPath,
} from './isolation.js'
import { estimateInstructions } from './instructions.js'
import { HarnessSdkClient, DEFAULT_INITIALIZE_TIMEOUT_MS, resolveDshCommand } from './sdk.js'
import { FLASH_MCP_VERSION, profileHonoursModelEnv, resolveDshHome } from './doctor.js'

/** Route the service pins; callers can never change the provider. */
export const DEFAULT_PROVIDER = 'ollama'
export const DEFAULT_MODEL = 'deepseek-v4.1-flash:cloud'

/** The environment variable a dsh profile reads to pick the model for its process. */
export const ROUTE_MODEL_VAR = 'FLASH_ROUTE_MODEL'

/** Default wall-clock budget for one delegated task. */
const DEFAULT_TASK_TIMEOUT_MS = 300_000

/** Default returned size of the child's final message. */
const DEFAULT_MAX_RESULT_CHARS = 8_000

/**
 * The largest `taskFile` this service reads. A brief is 4-8 KB in practice; a quarter of a
 * megabyte leaves room for a generous one while keeping a mistaken path (a log, a binary, a
 * whole checkout) from being pasted into a prompt.
 */
const MAX_TASK_FILE_BYTES = 256 * 1024

/**
 * How long a call may go without a single event from its session or its workers
 * before it is treated as stuck. A working worker emits events constantly (model
 * chunks, tool calls, tool results); a hung model stream or a wedged tool emits
 * none. This, not the wall-clock budget, is what separates "slow" from "stuck".
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 600_000

/** How often the idle check looks at the last activity. */
const IDLE_CHECK_INTERVAL_MS = 15_000

/** Default wall-clock budget for one fleet of delegated tasks. */
const DEFAULT_BATCH_TIMEOUT_MS = 900_000

/** Default ceiling on tasks per fleet call. The engine enforces its own cap too. */
const DEFAULT_MAX_TASKS = 16

/** Default size of one worker's returned message inside a fleet result. */
const DEFAULT_PER_ITEM_CHARS = 4_000
/**
 * How much of a patch a tool result carries. Large enough to review a normal
 * change without re-reading the files, small enough that a runaway diff cannot
 * eat the caller's context: the whole patch stays on disk either way.
 */
const DEFAULT_DIFF_CHARS = 20_000

/**
 * The most characters one `flash_patch` page may return. A page exists so a caller can
 * page through a patch it could not read whole; a page that eats the caller's context
 * defeats that, so the requested `maxChars` is capped rather than trusted.
 */
const MAX_PATCH_PAGE_CHARS = 200_000
/**
 * How many disposable trees may be in flight at once. Each one costs a runtime
 * process, so this is a memory budget as much as a concurrency limit.
 */
const DEFAULT_SLOTS = 2

/**
 * How often a running call tells the MCP client it is alive. The client aborts a
 * tool call that shows no sign of life for its own idle timeout, and a worker can
 * legitimately spend much longer than that; progress notifications are the only
 * thing that resets that clock. A request without a `_meta.progressToken` gets no
 * timer at all, because a progress notification would then be invalid.
 */
const DEFAULT_PROGRESS_INTERVAL_MS = 20_000

/**
 * How much of an open tool call an activity record keeps. A shell command line is kept
 * nearly whole, because "which build is this worker stuck in" is read from it; any other
 * tool's call is a name and a JSON blob, and a short prefix is enough to recognise it.
 */
const ACTIVITY_COMMAND_CHARS = 300
const ACTIVITY_TOOL_CHARS = 120

/**
 * How many times one command must fail before the call warns about it. Twice is a flaky
 * step or a typo the worker already fixed; three times of the same command is the pattern
 * a worker repeating a step its sandbox cannot finish leaves behind.
 */
const REPEATED_FAILURE_THRESHOLD = 3

/** How much of a task a stored patch's task record keeps for each kind of call. */
const TASK_LABEL_CHARS = 160
const BATCH_TASK_LABEL_CHARS = 200

/**
 * The window in which an empty, unproductive first attempt is read as a start-up hiccup
 * rather than a real attempt: minutes after a machine restart, a handful of model calls
 * ended `status: "error"` with nothing to show, and the same brief ran normally later.
 */
const EARLY_RETRY_MAX_MS = 180_000
const EARLY_RETRY_MAX_MODEL_CALLS = 12

/** How long the service waits before retrying such an attempt; injectable for tests. */
const DEFAULT_EARLY_RETRY_DELAY_MS = 10_000

/** Marker the workflow tool renders immediately before the script's JSON value. */
const WORKFLOW_VALUE_MARKER = 'Return value:'

/** Bound on the workflow result text retained for per-task projection. */
const WORKFLOW_TEXT_LIMIT = 400_000

/**
 * The fleet script. It is a constant, not a model's composition: the dispatcher
 * only relays it verbatim, so the fan-out shape cannot drift between calls.
 * `args.items` carries the work, `args.perItemChars` bounds each worker message.
 */
export const BATCH_SCRIPT = [
  'const clip = (text) => {',
  '  if (text === null || text === undefined) return null',
  '  const full = String(text)',
  '  return full.length <= args.perItemChars ? full : full.slice(0, args.perItemChars)',
  '}',
  'const settled = await parallel(args.items.map((item, index) => async () => {',
  '  const text = await agent(item.prompt, { label: item.label })',
  '  return { index, ok: text !== null && text !== undefined, result: clip(text) }',
  '}))',
  'return settled.map((entry, index) => entry ?? { index, ok: false, result: null })',
].join('\n')

/**
 * Operating rules for one fleet member. The `flash` tool applies its own persona
 * row, but the workflow engine starts its children directly, so the equivalent
 * guidance travels inside the item prompt instead.
 */
export const WORKER_RULES = [
  'Rules for this job:',
  '- Work only under the working directory above. The sandbox denies effects outside it,',
  '  that denial is final, and approval prompts are disabled here — never retry with',
  '  sandbox_permissions and never look for a way around it.',
  '- Do exactly this one task and nothing else. Do not start other work.',
  '- Keep the final answer short and concrete, and name every file you changed.',
].join('\n')

/** Bounded excerpt of the orchestrator's own words, used only to explain a failure. */
const PARENT_EXCERPT_CHARS = 400

/** Bound on the orchestrator event trace kept in the diagnostics log. */
const TRACE_EVENTS = 40

/** Raised for every condition the caller can act on; surfaces as an MCP tool error. */
export class FlashTaskError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'FlashTaskError'
    this.code = code
  }
}

/** Raised when the MCP client cancelled the call. */
export class FlashTaskCancelled extends Error {
  constructor(message = 'flash_task was cancelled by the client') {
    super(message)
    this.name = 'FlashTaskCancelled'
    // The same `code` shape the other failures carry, so a caller (and the MCP layer)
    // can tell a cancellation from a failure without reading the message.
    this.code = 'CANCELLED'
  }
}

/**
 * The MCP-facing service.
 */
export class FlashTaskService {
  /**
   * @param {object} options - service wiring.
   * @param {string} options.root - sandbox root; also the runtime's working directory.
   * @param {string} [options.profile] - dsh profile to boot.
   * @param {string} [options.provider] - pinned orchestrator/worker provider route.
   * @param {string} [options.model] - the default model on that route, for a call that
   *   names none.
   * @param {string[]} [options.models] - every model a call may choose; the default is
   *   always included (default `[model]`).
   * @param {(profile: string) => boolean} [options.honoursModelEnv] - whether an installed
   *   profile reads FLASH_ROUTE_MODEL, so it can boot a non-default model (default: the
   *   doctor helper on `DSH_HOME`, resolved as dsh reads it against `home`). Injected by
   *   tests; see `#resolveModel`.
   * @param {string} [options.home] - home directory `DSH_HOME` expands a leading `~`
   *   against (default the process's; injectable so no test reads the real home).
   * @param {number} [options.maxTokens] - optional output cap for SDK agents.
   * @param {number} [options.taskTimeoutMs] - per-task wall-clock budget.
   * @param {number} [options.maxResultChars] - returned child-message budget.
   * @param {number} [options.batchTimeoutMs] - per-fleet wall-clock budget.
   * @param {number} [options.maxTasks] - ceiling on tasks in one fleet call.
   * @param {number} [options.perItemChars] - returned per-worker budget inside a fleet.
   * @param {number} [options.progressIntervalMs] - how often a running call reports progress.
   * @param {number} [options.earlyRetryDelayMs] - how long to wait before retrying an early,
   *   empty first attempt (default 10 s; injectable so a test need not wait).
   * @param {number} [options.initTimeoutMs] - cold-start handshake budget for one runtime.
   * @param {Record<string, string | undefined>} [options.env] - runtime environment.
   * @param {string} [options.platform] - platform the slot-path advisory is decided for
   *   (default process.platform; injectable so a Windows warning can be tested anywhere).
   * @param {(env: Record<string, string | undefined>) => {command: string, prefix: string[]}} [options.resolveDshCommand]
   *   how a runtime finds its launcher (default `resolveDshCommand` on `platform`); injectable
   *   so a test can model a version-manager sibling without a real nvm layout.
   * @param {string[]} [options.startupWarnings] - warnings the server established at start
   *   that are not tied to one profile (the Windows slot-path advisory is added here too),
   *   carried by every `flash_task` and `flash_batch` result while they hold.
   * @param {boolean} [options.checkProfileStamp] - whether a newly booted runtime re-reads
   *   its profile's release stamp; only the server turns this on.
   * @param {(profile: string) => string | undefined} [options.profileStampReader] - the
   *   stamp read used for that re-read (injectable, so a test needs no real `~/.dsh`).
   * @param {Map<string, string | undefined> | Record<string, string | undefined>} [options.profileStampWarnings]
   *   the start-time verdict per profile, used until that profile's runtime boots.
   * @param {(message: string) => void} [options.log] - diagnostic sink (stderr).
   * @param {(profile: string, cwd: string, extraEnv?: object) => HarnessSdkClient} [options.clientFactory]
   *   runtime factory (tests).
   * @param {object} [options.isolate] - isolation settings. `allowSlotSetup` opts in to the
   *   repository's `slotSetup` steps, which run on the host outside the worker's sandbox.
   */
  constructor({
    root,
    profile = 'flash-service',
    provider = DEFAULT_PROVIDER,
    model = DEFAULT_MODEL,
    models = [model],
    honoursModelEnv,
    home = homedir(),
    maxTokens,
    taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    maxResultChars = DEFAULT_MAX_RESULT_CHARS,
    batchTimeoutMs = DEFAULT_BATCH_TIMEOUT_MS,
    maxTasks = DEFAULT_MAX_TASKS,
    perItemChars = DEFAULT_PER_ITEM_CHARS,
    progressIntervalMs = DEFAULT_PROGRESS_INTERVAL_MS,
    earlyRetryDelayMs = DEFAULT_EARLY_RETRY_DELAY_MS,
    initTimeoutMs = DEFAULT_INITIALIZE_TIMEOUT_MS,
    env = process.env,
    platform = process.platform,
    resolveDshCommand: resolveLauncher = (environment) => resolveDshCommand(environment, platform),
    startupWarnings = [],
    checkProfileStamp = false,
    profileStampReader,
    profileStampWarnings = new Map(),
    log = () => {},
    clientFactory,
    isolate = {},
  }) {
    this.root = realpathSync(resolve(root))
    this.profile = profile
    this.provider = provider
    this.model = model
    /**
     * Every model a call may choose, the default first. The default is always present:
     * otherwise editing the allowlist could strand the one model a profile installed
     * before model choice can run at all.
     *
     * @type {string[]}
     */
    this.models = []
    for (const name of [model, ...(Array.isArray(models) ? models : [])]) {
      if (typeof name === 'string' && name.length > 0 && !this.models.includes(name)) this.models.push(name)
    }
    // The installed profile's support for FLASH_ROUTE_MODEL is a lazy fact: it is only
    // read when a call asks for a model other than the default. A positive answer is cached
    // for the life of the server; a negative one is not, because rerunning the installer
    // must take effect without a restart (see `#honoursModelEnv`).
    this.home = home
    this.honoursModelEnv =
      honoursModelEnv ??
      ((profileName) => profileHonoursModelEnv(resolveDshHome(this.env?.DSH_HOME, this.home), profileName))
    /** @type {Map<string, boolean>} installed-profile answers already established. */
    this.modelEnvHonoured = new Map()
    /**
     * Calls that are about to use, or are using, the runtime for one key. A call holds
     * its key from before the runtime is booted until its session ends, so the process
     * limit in `#retireOtherModels` cannot shut down a runtime another call is reaching for.
     *
     * @type {Map<string, number>}
     */
    this.inFlight = new Map()
    this.maxTokens = maxTokens
    this.taskTimeoutMs = taskTimeoutMs
    this.idleTimeoutMs = idleTimeoutMs
    this.maxResultChars = maxResultChars
    this.batchTimeoutMs = batchTimeoutMs
    this.maxTasks = maxTasks
    this.perItemChars = perItemChars
    this.progressIntervalMs = progressIntervalMs
    this.earlyRetryDelayMs = earlyRetryDelayMs
    this.initTimeoutMs = initTimeoutMs
    this.env = env
    this.log = log
    // The environment a runtime boots with may be extended per call. It is no longer
    // used to move TMPDIR into the disposable tree: the runtime's sandbox grants the
    // platform temp area from its *own* TMPDIR, so narrowing it silently withdrew that
    // grant, and every toolchain that reaches the platform temp area directly (the
    // Swift toolchain does, through confstr) then failed with EPERM inside its own
    // scratch files. See `#runLocation`.
    this.clientFactory =
      clientFactory ??
      ((profileName, cwd, extraEnv) =>
        new HarnessSdkClient({
          profile: profileName,
          cwd,
          env: extraEnv === undefined ? env : { ...env, ...extraEnv },
          log,
          initializeTimeoutMs: initTimeoutMs,
          resolveCommand: resolveLauncher,
        }))
    this.diffChars = isolate.diffChars ?? DEFAULT_DIFF_CHARS
    /**
     * Disposable trees for writing calls. `mode: "none"` is the opt-out, and it is
     * the only configuration in which a worker touches the caller's repository
     * directly — which is why the CLI says so out loud when it is used.
     *
     * @type {WorkspaceIsolation | undefined}
     */
    this.isolation =
      isolate.mode === 'none'
        ? undefined
        : new WorkspaceIsolation({
            root: this.root,
            slots: isolate.slots ?? DEFAULT_SLOTS,
            // Left undefined, the pool picks a directory that is private to this root
            // and this process. A shared default was a data-loss bug: one instance
            // cleared another's in-flight tree and reused its path.
            ...(isolate.stateDir === undefined ? {} : { stateDir: isolate.stateDir }),
            // The base of the default layout (`--state-base` / FLASH_STATE_BASE); ignored
            // by the pool when a state directory was configured, as the flag's docs say.
            ...(isolate.baseDir === undefined ? {} : { baseDir: isolate.baseDir }),
            ...(isolate.patchRetentionDays === undefined ? {} : { patchRetentionDays: isolate.patchRetentionDays }),
            ...(isolate.maxStateBytes === undefined ? {} : { maxStateBytes: isolate.maxStateBytes }),
            // The copy's exclusions and the worker's per-slot environment belong to the
            // repository, so a pool takes them from `.flash-agents.json` and from these
            // options; the options win per entry.
            ...(isolate.copyExclude === undefined ? {} : { copyExclude: isolate.copyExclude }),
            ...(isolate.slotEnv === undefined ? {} : { slotEnv: isolate.slotEnv }),
            // A setup step is repository code run on the host, outside the sandbox the worker
            // is confined to, so the pool only runs it after an explicit opt-in.
            ...(isolate.allowSlotSetup === undefined ? {} : { allowSlotSetup: isolate.allowSlotSetup }),
            // The stdio server defers the dead-owner sweep until the client has finished the
            // handshake; every other caller leaves this out and gets the constructor's sweep.
            ...(isolate.deferStartupSweep === undefined ? {} : { deferStartupSweep: isolate.deferStartupSweep }),
            log,
          })
    this.stateDir = this.isolation?.stateDir ?? resolve(isolate.stateDir ?? join(canonicalTmpdir(), 'flash-mcp'))
    /**
     * Warnings established at start that every `flash_task` and `flash_batch` result
     * carries while they hold. The profile release stamps arrive from `createService`; the
     * Windows slot-path advisory is measured here, from the path the pool really leased.
     *
     * @type {string[]}
     */
    this.startupWarnings = Array.isArray(startupWarnings) ? [...startupWarnings] : []
    /**
     * The profile release verdict the server established at start, per profile. A runtime
     * that boots afterwards replaces its own entry (see `#refreshProfileStamp`); one that
     * was already booted keeps the verdict it booted with.
     *
     * @type {Map<string, string | undefined>}
     */
    this.profileStampWarnings = new Map()
    const startVerdicts =
      profileStampWarnings instanceof Map ? profileStampWarnings : new Map(Object.entries(profileStampWarnings ?? {}))
    for (const [name, warning] of startVerdicts) {
      if (typeof warning === 'string') this.profileStampWarnings.set(name, warning)
      else this.profileStampWarnings.set(name, undefined)
    }
    // Only a service created with the flag and a reader may touch a profile's stamp on a
    // runtime boot. Without both, no read happens at start or later.
    this.checkProfileStamp = checkProfileStamp === true && typeof profileStampReader === 'function'
    this.profileStampReader = this.checkProfileStamp ? profileStampReader : undefined
    const lengthWarning =
      this.isolation === undefined
        ? undefined
        : slotPathWarning(slotRootPath(this.isolation.stateDir, 0), { platform })
    if (lengthWarning !== undefined) {
      this.startupWarnings.push(lengthWarning)
      this.log(lengthWarning)
    }

    /**
     * One persistent runtime per profile *and working directory*, keyed by both. A
     * call that asks for `read-only` boots the read-only profile instead of reusing
     * the writing one, because the sandbox mode is fixed for the life of a process
     * and is the only airtight way to make "this call cannot modify anything" true.
     * The directory is part of the key because the sandbox root is fixed when a
     * process starts: isolation is therefore one runtime per disposable tree, and
     * the pool keeps them alive rather than booting one per call.
     *
     * @type {Map<string, object>}
     */
    this.runtimes = new Map()
    this.sessions = 0
  }

  /**
   * The map key for one runtime: a profile and a model are only meaningful together
   * with a cwd.
   *
   * One dsh process runs exactly one model, chosen by the environment it starts with
   * (`FLASH_ROUTE_MODEL`), so the model belongs in the key: two models on one tree are
   * two processes.
   */
  #runtimeKey(profileName, cwd, model) {
    return `${profileName}@${cwd}@${model}`
  }

  /** Runtime facts for the returned payload, for the runtime that served the call. */
  #runtimeInfo(profileName, cwd, model) {
    const run = this.runtimes.get(this.#runtimeKey(profileName, cwd, model))
    return {
      pid: run?.client?.pid ?? null,
      booted: run?.initialized === true,
      uptimeMs: run?.startedAt === undefined ? 0 : Date.now() - run.startedAt,
      sessions: this.sessions,
      profile: profileName,
    }
  }

  /**
   * Re-read one profile's release stamp for a runtime that is booting now.
   *
   * The server reads the stamps once at start, but `node install.mjs` can run while it is
   * alive. A runtime booted after that install already loads the new guard, so repeating
   * the start-time warning until the next reconnect told the caller a problem that no longer
   * existed. The verdict travels on the runtime record, because a result must report what
   * the runtime that served it actually loaded, not what a later install changed.
   *
   * @param {object} run - the runtime record that just hand-shook.
   * @param {string} profileName - the profile whose stamp to re-read.
   * @returns {void}
   */
  #refreshProfileStamp(run, profileName) {
    if (!this.checkProfileStamp || this.profileStampReader === undefined) return
    let next
    try {
      next = this.profileStampReader(profileName)
    } catch (error) {
      // A stamp that cannot be read is not a new verdict: keep the one the result already
      // carries rather than replacing a warning with a read failure nobody asked about.
      this.log(`could not re-read the ${profileName} profile stamp: ${messageOf(error)}`)
      run.profileStampWarning = this.profileStampWarnings.get(profileName)
      return
    }
    const previous = this.profileStampWarnings.get(profileName)
    if (next !== previous) {
      if (next === undefined) {
        this.log(
          `the ${profileName} profile now matches flash-agents ${FLASH_MCP_VERSION}; its warning is cleared`,
        )
      } else {
        this.log(next)
      }
    }
    this.profileStampWarnings.set(profileName, next)
    run.profileStampWarning = next
  }

  /**
   * The model one call runs on, or the refusal that stops it before anything starts.
   *
   * A call may choose any model on the user's allowlist. A model that is not there is a
   * refusal naming the list; a non-default one additionally needs an installed profile
   * that reads FLASH_ROUTE_MODEL, because a profile from before model choice pins one
   * literal model and would silently run the default instead.
   *
   * @param {unknown} requested - the call's `model` argument.
   * @param {string} profileName - the profile that will serve the call.
   * @returns {string} the model the call runs on.
   * @throws {FlashTaskError} `MODEL_NOT_ALLOWED` or `PROFILE_OUTDATED`, before any work.
   */
  #resolveModel(requested, profileName) {
    const model = requested === undefined || requested === null ? this.model : requireText(requested, 'model')
    if (!this.models.includes(model)) {
      throw new FlashTaskError(
        `model ${JSON.stringify(model)} is not allowed; the allowed models are ${this.models.join(', ')}`,
        'MODEL_NOT_ALLOWED',
      )
    }
    if (model === this.model) return model
    if (!this.#honoursModelEnv(profileName)) {
      throw new FlashTaskError(
        `the installed ${profileName} profile predates model choice, so ${model} would run as ` +
          `${this.model} instead; run \`node install.mjs\` (or the plugin's setup skill)`,
        'PROFILE_OUTDATED',
      )
    }
    return model
  }

  /**
   * Whether an installed profile honours FLASH_ROUTE_MODEL.
   *
   * Only a positive answer is remembered: the installed patch cannot lose the variable while
   * this server lives, but it can gain it when the user reruns the installer, and a negative
   * answer must not keep refusing models until a restart. A negative is therefore re-read on
   * the next non-default call (one small file read), which also means a transient read error
   * is not remembered as a verdict.
   */
  #honoursModelEnv(profileName) {
    if (this.modelEnvHonoured.get(profileName) === true) return true
    const honoured = this.honoursModelEnv(profileName) === true
    if (honoured) this.modelEnvHonoured.set(profileName, true)
    else this.modelEnvHonoured.delete(profileName)
    return honoured
  }

  /** Note that a call is reaching for one runtime key. */
  #holdRuntime(key) {
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1)
  }

  /** Release a hold; the runtime is free to be retired when the last one ends. */
  #releaseRuntime(key) {
    const held = (this.inFlight.get(key) ?? 0) - 1
    if (held > 0) this.inFlight.set(key, held)
    else this.inFlight.delete(key)
  }

  /**
   * Shut down the other models' idle runtimes on one tree.
   *
   * Without this, a slot that served three models would keep three dsh processes for as
   * long as the server lives: a model in the key bounds what a call can run on, not how
   * many processes one tree accumulates. A runtime with a session in flight is left
   * alone — including one another call is only about to use — and one line is logged per
   * process shut down.
   *
   * @param {string} profileName - the profile the new runtime serves.
   * @param {string} cwd - the tree the new runtime is rooted at.
   * @param {string} model - the model the new runtime runs.
   * @param {object} keep - the runtime that was just started, never a candidate.
   */
  async #retireOtherModels(profileName, cwd, model, keep) {
    for (const [key, run] of [...this.runtimes]) {
      // The walk is a snapshot and every shutdown is awaited (up to seconds). Another call
      // can therefore retire the same key and boot a fresh runtime under it before this
      // iteration resumes: deleting by key then would evict the fresh, running process,
      // which no later `close()` could stop. The map is the authority on what is current.
      if (this.runtimes.get(key) !== run) continue
      if (run === keep) continue
      if (run.profile !== profileName || run.cwd !== cwd || run.model === model) continue
      if (run.initialized !== true || (run.sessions ?? 0) > 0) continue
      if ((this.inFlight.get(key) ?? 0) > 0) continue
      this.runtimes.delete(key)
      try {
        await run.client?.shutdown()
        this.log(`shut down the ${run.model} runtime on ${profileName} in ${cwd}: ${model} now serves that tree`)
      } catch (error) {
        this.log(`could not shut down the ${run.model} runtime on ${profileName}: ${messageOf(error)}`)
      }
    }
  }

  /**
   * The isolation pool a call should use, or undefined when it must run in place.
   *
   * A read-only call is deliberately *not* isolated: it cannot change anything, and
   * running it in the caller's own tree means it reads the caller's current state
   * rather than a copy's.
   *
   * @param {string} profileName - the profile that will serve the call.
   * @returns {WorkspaceIsolation | undefined} the pool, when the call may write.
   */
  #isolationFor(profileName) {
    if (this.isolation === undefined) return undefined
    return profileName === this.profile ? this.isolation : undefined
  }

  /**
   * Lease a tree for one call, bounded by that call's budget and cancellable.
   *
   * The wait is where a queued call used to outlive its own deadline: it queued, took a
   * tree, copied a repository, and only then noticed nobody was waiting. The signal and
   * the deadline are passed in so the queue can refuse instead.
   *
   * @param {WorkspaceIsolation} pool - the pool to lease from.
   * @param {string} label - the tool name, for the error message.
   * @param {number} budgetMs - the wall-clock budget of the call being served.
   * @param {AbortSignal} [signal] - client cancellation.
   * @returns {Promise<object>} the leased slot.
   * @throws {FlashTaskCancelled | FlashTaskError} when the call is cancelled or out of time.
   */
  async #lease(pool, label, budgetMs, signal) {
    try {
      return await pool.lease({ signal, deadline: Date.now() + budgetMs })
    } catch (error) {
      if (error instanceof IsolationError && error.code === 'CANCELLED') {
        throw new FlashTaskCancelled(`${label} was cancelled while waiting for a free tree`, error.code)
      }
      throw new FlashTaskError(messageOf(error), error?.code ?? 'ISOLATION_FAILED')
    }
  }

  /**
   * Mark the activity queued when every tree is in use, so the wait does not read as silence.
   *
   * The activity object exists before the lease, so a call waiting for a tree used to
   * report `starting` and a "last event" that only grew: to the caller — and to the idle
   * check — a queued call looked hung. The counts are stored too, so a render can fall
   * back to them if the pool is no longer at hand.
   *
   * A foreground wait is the one case where the caller's whole turn is held by the queue,
   * so the wait says so in the progress line and in the log: a caller that sent a writing
   * call without `background: true` cannot see what it is waiting for otherwise.
   *
   * @param {WorkspaceIsolation} pool - the pool the call is about to lease from.
   * @param {object} activity - the call's activity record.
   * @param {boolean} [foreground] - whether this call holds the caller's turn while it waits.
   * @returns {number | undefined} when the wait began, or undefined when a tree was free.
   */
  #noteQueue(pool, activity, foreground = false) {
    // A deferred start-up sweep (the stdio server's) may still be reclaiming the previous
    // server's trees when the first call arrives. That wait has no session event behind it,
    // so without this the heartbeat reads "starting" and the call looks hung; `undefined`
    // on a pool that never deferred the sweep is simply false.
    if (pool.startupSweepPending === true) {
      activity.what = 'waiting for the start-up sweep to finish'
      activity.at = Date.now()
    }
    if (pool.inUse < pool.size) return undefined
    const since = Date.now()
    activity.what = `queued: waiting for a free tree (${String(pool.inUse)} of ${String(pool.size)} in use)`
    activity.queuedSince = since
    activity.queuedInUse = pool.inUse
    activity.queuedSize = pool.size
    if (foreground) {
      activity.queuedForeground = true
      this.log(
        `queued in the foreground: waiting for a free tree (${String(pool.inUse)} of ${String(pool.size)} in use); ` +
          'send writing calls with background: true when trees may be busy',
      )
    }
    // Read through at render time: another waiting call may take the freeing tree first.
    activity.pool = pool
    return since
  }

  /**
   * Record the end of a wait for a tree: how long it took, and that copying comes next.
   *
   * @param {object} activity - the call's activity record.
   * @param {number | undefined} queuedSince - when the wait began, if it waited at all.
   * @returns {number} how long the call waited for a tree; 0 when one was free at once.
   */
  #noteLeased(activity, queuedSince) {
    const queuedMs = queuedSince === undefined ? 0 : Math.max(0, Date.now() - queuedSince)
    delete activity.queuedSince
    activity.what = 'copying the repository'
    activity.at = Date.now()
    return queuedMs
  }

  /**
   * The runtime a call runs on, and the environment it needs.
   *
   * The runtime is rooted at the *tree*, never at a subdirectory of it: the sandbox root
   * is fixed when a process starts, so a runtime per requested subdirectory meant one
   * process per distinct `cwd`, none of which ever exits. The subdirectory still reaches
   * the worker, in the prompt, where it belongs.
   *
   * @param {object | undefined} slot - the leased tree, when the call is isolated.
   * @param {string} rootCwd - the resolved directory inside the caller's root.
   * @returns {{promptCwd: string, runtimeCwd: string, extraEnv: object | undefined,
   *   slotPorts: string[], slotValues: string[]}} where to run, and which of `extraEnv`'s
   *   names are port ranges and which are plain values the project's settings set.
   */
  #runLocation(slot, rootCwd, pool) {
    if (slot === undefined || pool === undefined) {
      return { promptCwd: rootCwd, runtimeCwd: rootCwd, extraEnv: undefined, slotPorts: [], slotValues: [] }
    }
    // The runtime's environment is deliberately left alone apart from the per-slot paths
    // the repository's settings ask for. Pointing TMPDIR into the tree looked tidy, but the
    // Harness derives the sandbox's writable roots from the runtime's `os.tmpdir()`, which
    // reads that same variable: the per-user temp area (`/private/var/folders/…/T` on
    // macOS) vanished from the grant, and `swift build` failed with EPERM while `touch` in
    // the same directory succeeded. The tree's own scratch directory still exists and the
    // worker is told about it in its prompt.
    const slotEnv = pool.slotEnvFor(slot)
    // A `port:` entry resolves to a bare number and a `value:` entry to plain text, which the
    // worker must not read as a path: the prompt names each kind in its own sentence.
    const slotPorts = Object.entries(pool.slotEnv)
      .filter(([, spec]) => spec.kind === 'port')
      .map(([name]) => name)
    const slotValues = Object.entries(pool.slotEnv)
      .filter(([, spec]) => spec.kind === 'value')
      .map(([name]) => name)
    return {
      promptCwd: pool.slotCwd(slot, rootCwd),
      runtimeCwd: slot.dir,
      // Resolved from `slot.dir`, which is stable for the life of the slot, so this is the
      // same set of paths the slot was prepared with. Undefined when nothing is configured,
      // exactly as before: the runtime's environment is then untouched.
      extraEnv: Object.keys(slotEnv).length === 0 ? undefined : slotEnv,
      slotPorts,
      slotValues,
    }
  }

  /**
   * The profile that enforces one requested mode. Only narrowing is selectable:
   * `read-only` boots a profile whose sandbox denies every write, while the
   * default `workspace-write` is the service's own standing mode. No caller can
   * ask for a mode this service does not ship.
   *
   * @param {unknown} mode - the requested mode.
   * @returns {string} the profile name to run on.
   */
  #profileForMode(mode) {
    if (mode === undefined || mode === null || mode === 'workspace-write') return this.profile
    if (mode === 'read-only') return `${this.profile}-readonly`
    throw new FlashTaskError(
      `mode ${JSON.stringify(mode)} is not available; use "workspace-write" (default) or "read-only"`,
      'MODE_UNAVAILABLE',
    )
  }

  /**
   * Validate the model a call names, without starting or leasing anything.
   *
   * The background door answers with a job id before `flashTask`/`flashBatch` runs, so the
   * refusals those methods raise before any work have to be available here: a model off the
   * allowlist, a non-default model on a profile that predates model choice, or a per-item
   * `model` in a fleet. A background call then refuses at once instead of failing later in
   * `flash_result`. Nothing is read except the installed profile's one marker file.
   *
   * @param {object} args - the MCP tool arguments, as the call received them.
   * @param {string} toolName - `flash_task` or `flash_batch`.
   * @returns {void}
   * @throws {FlashTaskError} `MODE_UNAVAILABLE`, `MODEL_NOT_ALLOWED`, `PROFILE_OUTDATED`, or
   *   the fleet's `INVALID_ARGUMENT` for a per-item model.
   */
  checkModel(args, toolName) {
    const profileName = this.#profileForMode(args?.mode)
    this.#resolveModel(args?.model, profileName)
    if (toolName === 'flash_batch' && Array.isArray(args?.tasks)) {
      for (const [index, entry] of args.tasks.entries()) refuseItemModel(entry, index)
    }
  }

  /**
   * Validate every argument a call can refuse before a slot or a runtime is touched.
   *
   * The background door answers with a job id before `flashTask`/`flashBatch` runs. A bad
   * `task`/`taskFile` pair, an unreadable file, an unavailable `apply`, or a `source`/
   * `basePatch` a read-only call cannot honour used to become a job that failed seconds
   * later. Raising the same errors here makes the tool call itself answer exactly as a
   * foreground call does. The checks therefore run in the same order as those methods and
   * in the same shape — the fleet's per-entry refusals first for `flash_batch`, one task
   * first for `flash_task`, then cwd, acceptance, apply, mode, model, the pool, source and
   * basePatch — so a call with several bad arguments names the one the foreground call
   * names. Anything needing a slot or a runtime — leasing, copying, the worker —
   * deliberately stays in the job.
   *
   * @param {object} args - the MCP tool arguments, as the call received them.
   * @param {string} toolName - `flash_task` or `flash_batch`.
   * @returns {void}
   * @throws {FlashTaskError} the same refusal the synchronous path would raise.
   */
  checkArguments(args, toolName) {
    if (toolName === 'flash_batch') {
      normalizeTasks(args?.tasks, this.maxTasks, { readTaskFile: (value, field) => this.#readTaskFile(value, field) })
    } else {
      this.#resolveTask(args)
    }
    this.#resolveCwd(args?.cwd)
    optionalText(args?.acceptance)
    this.#resolveApply(args?.apply)
    const profileName = this.#profileForMode(args?.mode)
    this.#resolveModel(args?.model, profileName)
    const pool = this.#isolationFor(profileName)
    this.#resolveSource(args?.source, pool)
    this.#resolveBasePatch(args?.basePatch, pool)
  }

  /**
   * The `source` argument, refused when a call has no copy to reset.
   *
   * @param {unknown} value - the requested source.
   * @param {WorkspaceIsolation | undefined} pool - the call's copy pool, when it has one.
   * @returns {'working-tree' | 'head'} the source the call runs with.
   * @throws {FlashTaskError} `SOURCE_UNAVAILABLE` for an unknown value or a read-only call.
   */
  #resolveSource(value, pool) {
    const source = value ?? 'working-tree'
    if (source !== 'working-tree' && source !== 'head') {
      throw new FlashTaskError(
        `source ${JSON.stringify(source)} is not available; use "working-tree" (default) or "head"`,
        'SOURCE_UNAVAILABLE',
      )
    }
    if (source === 'head' && pool === undefined) {
      throw new FlashTaskError('source "head" applies only to writing calls; a read-only call is not isolated', 'SOURCE_UNAVAILABLE')
    }
    return source
  }

  /**
   * The `basePatch` argument, refused when a call has no copy to apply it to.
   *
   * @param {unknown} value - the requested patch id or prefix.
   * @param {WorkspaceIsolation | undefined} pool - the call's copy pool, when it has one.
   * @returns {string | undefined} the parsed id, or undefined when none was given.
   * @throws {FlashTaskError} `BASE_PATCH_UNAVAILABLE` for a read-only call.
   */
  #resolveBasePatch(value, pool) {
    const basePatchId = optionalPatchId(value)
    if (basePatchId !== undefined && pool === undefined) {
      throw new FlashTaskError(
        'basePatch applies only to writing calls; a read-only call is not isolated, so it has no copy to apply the patch to',
        'BASE_PATCH_UNAVAILABLE',
      )
    }
    return basePatchId
  }

  /**
   * Run one delegated task.
   * @param {object} args - the MCP tool arguments.
   * @param {string} [args.task] - the work to delegate.
   * @param {string} [args.taskFile] - a file holding the work; exactly one of the two.
   * @param {string} args.cwd - working directory for the worker; must be inside the root.
   * @param {string} [args.acceptance] - optional acceptance criteria for the worker.
   * @param {string} [args.model] - a model from the service allowlist; omitted, the
   *   default one runs.
   * @param {AbortSignal} [options.signal] - client cancellation.
   * @param {(report: object) => void} [options.progress] - MCP progress sender.
   * @param {unknown} [options.progressToken] - the request's progress token, when it had one.
   * @param {boolean} [options.background] - whether the call runs as a background job. A
   *   foreground call that has to wait for a tree holds the caller's whole turn, so it says
   *   so while it waits and in its result; a background one has no turn to hold.
   * @param {string} [options.jobId] - the background job serving the call, recorded on the
   *   patch's task so a stored change can be traced back to it.
   * @returns {Promise<object>} the compact structured result.
   */
  async flashTask(args, { signal, progress, progressToken, background = false, jobId } = {}) {
    const task = this.#resolveTask(args)
    // The path the caller gave, not the resolved one: a stored patch names the brief the
    // call named, so it can be found again from the record alone.
    const taskFile = typeof args?.taskFile === 'string' ? args.taskFile : undefined
    const rootCwd = this.#resolveCwd(args?.cwd)
    const acceptance = optionalText(args?.acceptance)
    const apply = this.#resolveApply(args?.apply)
    warnAboutIgnoredArguments(args, 'flash_task', this.log)

    const sessionId = `flash-task-${randomUUID()}`
    const profileName = this.#profileForMode(args?.mode)
    // Before anything is leased or copied: a model the user did not allow, or one an
    // installed profile cannot run, is a refusal that starts nothing.
    const model = this.#resolveModel(args?.model, profileName)
    const pool = this.#isolationFor(profileName)
    // `source` selects what the copy starts from. "head" is the escape hatch for running a
    // call while another session has uncommitted work in the same tree: the copy is reset to
    // the last commit instead of carrying that work. A read-only call is not isolated at all,
    // so there is nothing to reset — and it must not be told otherwise.
    const source = this.#resolveSource(args?.source, pool)
    // `basePatch` continues a call from a patch an earlier one stored: the patch is planted
    // in this call's copy before the worker starts, never in the caller's tree. Like
    // `source: "head"`, it needs a copy to act on, so a read-only call is refused here. The
    // rest of the id — whether it exists, belongs to this root, and names the repository this
    // call's cwd resolves to — is checked once the copy exists, before the worker starts.
    const basePatchId = this.#resolveBasePatch(args?.basePatch, pool)
    // Progress spans the whole call, including a wait for a free tree: that wait is
    // itself work the client must not mistake for a dead server. The interval is
    // stopped on every path out of this method.
    const activity = createActivity()
    // The heartbeat names the session the call is waiting on. A retry replaces that session,
    // so the id lives on the activity record instead of in this closure.
    activity.sessionId = sessionId
    const stopProgress = startProgress({
      activity,
      progress,
      token: progressToken,
      label: 'flash_task',
      sessionId,
      budgetMs: this.taskTimeoutMs,
      intervalMs: this.progressIntervalMs,
      log: this.log,
    })
    let slot
    let change
    let baseApplied
    let setup
    let queuedMs = 0
    try {
      /** The wait for a tree, when there was one: its length, the pool's counts, nothing else. */
      let queued
      if (pool !== undefined) {
        const queuedSince = this.#noteQueue(pool, activity, background !== true)
        slot = await this.#lease(pool, 'flash_task', this.taskTimeoutMs, signal)
        queuedMs = this.#noteLeased(activity, queuedSince)
        if (queuedSince !== undefined) {
          // Snapshotted now: the counts a result reports are the ones the caller waited
          // behind, not whatever the pool looks like once the call is over.
          queued = { ms: queuedMs, inUse: activity.queuedInUse, size: activity.queuedSize }
        }
      }
      const { promptCwd, runtimeCwd, extraEnv, slotPorts, slotValues } = this.#runLocation(slot, rootCwd, pool)
      if (slot !== undefined) {
        try {
          pool.prepare(slot, {
            cwd: rootCwd,
            source,
            // The task travels with the copy, so the patch this call stores can name the
            // work it belongs to even after a crash or a restart.
            task: {
              kind: 'flash_task',
              label: taskLabel(task, TASK_LABEL_CHARS),
              sessionId,
              ...(jobId === undefined ? {} : { jobId }),
              ...(taskFile === undefined ? {} : { taskFile }),
            },
          })
        } catch (error) {
          // `prepare` reports "head needs a git repository" as an IsolationError so the pool
          // can raise it where the scope is known; a caller of the tool must read a
          // FlashTaskError like every other refusal.
          if (error instanceof IsolationError) throw new FlashTaskError(error.message, error.code)
          throw error
        }
        // Setup runs on the fresh copy, before the base patch is planted and before the base
        // is re-recorded: what it writes belongs to the copy's starting state, not to the
        // worker's change nor to the patch this call continues from.
        setup = await this.#runSlotSetup(pool, slot, activity, signal)
        // After `prepare` and the setup, so the base this call's own patch is measured from is
        // the state the copy was made at, and before the worker, so it starts on top of the
        // patch. A base patch that cannot be planted is an early refusal: the slot is released
        // like any other.
        if (basePatchId !== undefined) {
          try {
            baseApplied = pool.applyBasePatch(slot, basePatchId)
          } catch (error) {
            throw new FlashTaskError(messageOf(error), 'BASE_PATCH_UNAVAILABLE')
          }
        }
        activity.what = 'starting'
      }
      const childPrompt = buildChildPrompt({
        cwd: promptCwd,
        task,
        acceptance,
        ...(slot === undefined
          ? {}
          : {
              copy: true,
              uncommitted: slot.uncommitted,
              slotEnv: extraEnv,
              slotPorts,
              slotValues,
              slotSetup: promptSlotSetup(pool, setup),
              discard: apply === 'discard',
              ...(baseApplied === undefined ? {} : { basePatch: promptBasePatch(baseApplied) }),
            }),
      })
      // Measured before the worker runs, in the tree it is about to see: a worker that writes
      // or deletes an instruction file must not change what this call reports it was given.
      const instructions = this.#instructionsFor(promptCwd)
      const prompt = buildOrchestrationPrompt(childPrompt)
      const runAttempt = (attemptSessionId) =>
        this.#runSession({
          sessionId: attemptSessionId,
          activity,
          prompt,
          timeoutMs: this.taskTimeoutMs,
          label: 'flash_task',
          note: `${String(childPrompt.length)} chars of task text`,
          signal,
          profile: profileName,
          cwd: runtimeCwd,
          extraEnv,
          model,
        })
      let attempt = await runAttempt(sessionId)
      let attemptSessionId = sessionId
      let retried
      const early = this.#earlyFailureReason({
        state: attempt.state,
        started: attempt.started,
        slot,
        pool,
        signal,
        // Today's NOT_DELEGATED: the orchestrator finished without one child.
        delegated: attempt.state.children.length > 0,
      })
      if (early !== undefined) {
        const firstUsage = usageTotal(attempt.state)
        retried = {
          reason: early,
          firstSessionId: sessionId,
          firstDurationMs: Date.now() - attempt.started,
          ...(firstUsage === undefined ? {} : { firstUsage }),
        }
        this.log(
          `the first attempt ${sessionId} ended early with no result (${early}); retrying once in the same working ` +
            `directory after ${String(this.earlyRetryDelayMs)}ms`,
        )
        await this.#waitBeforeRetry(signal, 'flash_task')
        attemptSessionId = `flash-task-${randomUUID()}`
        activity.sessionId = attemptSessionId
        attempt = await runAttempt(attemptSessionId)
        // There is never a third attempt, and `retried` stays whatever the second attempt
        // did: the caller paid for two, so the first attempt's session and usage belong in
        // the answer even when the same failure ended both. The failure itself is reported
        // unchanged below — a result, or the NOT_DELEGATED message, which names the retry.
      }
      const { state, started } = attempt

      if (state.children.length === 0) {
        throw new FlashTaskError(
          `the orchestrator finished without delegating${describeParent(state)}${retryNote(retried)}`,
          'NOT_DELEGATED',
        )
      }
      this.#logToolTrace(state)
      change = slot === undefined ? undefined : pool.collect(slot, { diffChars: this.diffChars, store: apply !== 'discard' })
      const applied = change?.available === true && apply === 'auto' ? this.#applyChange(change) : undefined
      const result = this.#buildResult({
        state,
        sessionId: attemptSessionId,
        started,
        profile: profileName,
        cwd: runtimeCwd,
        model,
        // Measured where the worker sees them: inside the disposable copy for a writing call.
        instructions,
        slot,
        change,
        applied,
        basePatch: baseApplied,
        setup,
        queuedMs,
        queued,
        background,
        retried,
        activity,
      })
      // After the result is built, because the report it carries is the primary child's full
      // text (before the result's own clipping), and before the copy is emptied: the patch is
      // the record from here on.
      if (change?.patchId !== undefined && apply !== 'discard') {
        this.#annotatePatch(pool, change.patchId, state.children.at(-1)?.result ?? '')
      }
      return result
    } catch (error) {
      if (slot !== undefined && (error?.code === 'TIMEOUT' || error?.code === 'IDLE' || error?.code === 'CANCELLED')) {
        await this.#salvageOrphaned(pool, slot, error, profileName)
      }
      throw error
    } finally {
      stopProgress()
      if (slot !== undefined) this.#settleSlot(pool, slot, change)
    }
  }

  /**
   * Hand a slot back, emptied when its work is safely stored.
   *
   * A finished tree used to stay until the next call in its slot emptied it, so an idle
   * server held a full copy of the repository plus whatever the worker built, per slot,
   * indefinitely — 34 GB on one machine. Once the change is collected the patch is the
   * record and the tree is weight. A tree whose change could not be collected is the
   * opposite: it may be the only copy of the work, so it stays (and is named in the log)
   * until the next call needs the slot.
   *
   * @param {WorkspaceIsolation} pool - the pool the slot belongs to.
   * @param {object} slot - the leased tree.
   * @param {object | undefined} change - what `collect` returned, if it ran.
   */
  #settleSlot(pool, slot, change) {
    if (change?.available === true) {
      try {
        pool.discard(slot)
      } catch (error) {
        this.log(`could not empty ${slot.dir} after its patch was stored: ${messageOf(error)}`)
      }
    } else if (change !== undefined) {
      this.log(`kept ${slot.dir} until the next call in this slot: its change could not be collected (${change.reason})`)
    }
    pool.release(slot)
  }

  /**
   * What an isolated call that lost track of its worker leaves behind. The session
   * cannot be stopped — the SDK has no cancel — so after either a timeout or a client
   * cancellation its worker may still be writing into the tree; the session is
   * orphaned identically in both cases, and the same salvage applies. Two things
   * follow. The work so far is collected and stored as a patch, and the tree is retired
   * instead of recycled, so a later call is never handed a copy another session is
   * still editing. Both facts, and any tool refusals seen, go into the error the caller
   * reads: a call that fails with only "timeout" or "cancelled" is the one outcome that
   * teaches nothing.
   *
   * Shutting the runtime down is the only cancellation this service has: the SDK cannot
   * stop a session, but the service owns the process that runs it. The runtimes are keyed
   * by the tree they were rooted at, which is still the slot's directory here; dropping
   * them from the map means the next call on this slot boots a fresh runtime for the
   * slot's new directory, exactly as it would for any new cwd. Every model's runtime on
   * that tree is dropped, not only the requested one: a session for any of them may be
   * the one still writing.
   *
   * @param {WorkspaceIsolation} pool - the pool the slot belongs to.
   * @param {object} slot - the leased tree.
   * @param {Error} error - the failure error, whose message is extended in place.
   * @param {string} profileName - the profile the orphaned call ran on.
   */
  async #salvageOrphaned(pool, slot, error, profileName) {
    let note
    try {
      const change = pool.collect(slot, { diffChars: this.diffChars })
      if (!change.available) {
        note = `no change could be collected from the tree (${change.reason})`
      } else if (change.filesChanged.length === 0) {
        note = 'the tree held no change when the call ended early'
      } else {
        const summary = change.diffstat.split('\n').pop()?.trim() ?? ''
        note = `the change so far (${String(change.filesChanged.length)} file(s)) is stored as patch ${change.patchId}: ${summary}`
      }
    } catch (collectError) {
      note = `no change could be collected from the tree (${collectError instanceof Error ? collectError.message : String(collectError)})`
    }
    const denials = Array.isArray(error.denials) ? error.denials : []
    let refusals = ''
    if (denials.length > 0) {
      const first = denials[0]
      const reason = first.reason === undefined ? '' : ` (${first.reason})`
      refusals = `; ${String(denials.length)} tool refusal(s), first: ${first.code}${reason} ${first.message.slice(0, 160).replace(/\s+/g, ' ')}`
    }
    // Stop the processes before the slot moves: a runtime is keyed by the tree it was
    // rooted at, and `retire` gives the slot a new directory. A session that is still
    // running can no longer be signalled through the SDK, but killing its runtime takes
    // the worker processes it spawned with it. Every model's runtime on that tree goes:
    // one slot can have held more than one, and the one that served this call is not
    // necessarily the only one still alive.
    for (const [key, run] of [...this.runtimes]) {
      if (run.profile !== profileName || run.cwd !== slot.dir) continue
      this.runtimes.delete(key)
      try {
        await run.client?.shutdown()
        this.log(`shut down the ${run.model} runtime of the orphaned session on ${slot.dir}`)
      } catch (shutdownError) {
        this.log(`could not shut down the runtime of the orphaned session: ${messageOf(shutdownError)}`)
      }
    }
    pool.retire(slot)
    this.log(`salvage: ${note}${refusals}`)
    error.message = `${error.message}. ${note.charAt(0).toUpperCase()}${note.slice(1)}${refusals}`
  }

  /**
   * Run a fleet of independent tasks.
   *
   * One MCP call becomes one orchestration session that starts exactly one
   * workflow run: the shipped engine owns fan-out, concurrency, and the
   * total-child cap, and the profile pins every member to the `flash` provider.
   * This module owns the contract only — how many tasks a call may carry and how
   * the fleet's outcome is projected back.
   *
   * @param {object} args - the MCP tool arguments.
   * @param {Array<string | {task: string, acceptance?: string}>} args.tasks - the work.
   * @param {string} [args.cwd] - working directory shared by every worker.
   * @param {string} [args.acceptance] - default acceptance criteria for every task.
   * @param {string} [args.model] - a model from the service allowlist for the whole
   *   fleet: one dsh process, so one model for the dispatcher and every member.
   * @param {AbortSignal} [options.signal] - client cancellation.
   * @param {(report: object) => void} [options.progress] - MCP progress sender.
   * @param {unknown} [options.progressToken] - the request's progress token, when it had one.
   * @param {boolean} [options.background] - whether the call runs as a background job; see
   *   `flashTask`.
   * @param {string} [options.jobId] - the background job serving the call, recorded on the
   *   fleet's patch task.
   * @returns {Promise<object>} the compact per-task fleet result.
   */
  async flashBatch(args, { signal, progress, progressToken, background = false, jobId } = {}) {
    const tasks = normalizeTasks(args?.tasks, this.maxTasks, {
      readTaskFile: (value, field) => this.#readTaskFile(value, field),
    })
    const rootCwd = this.#resolveCwd(args?.cwd)
    const acceptance = optionalText(args?.acceptance)
    const apply = this.#resolveApply(args?.apply)
    warnAboutIgnoredArguments(args, 'flash_batch', this.log)

    const sessionId = `flash-batch-${randomUUID()}`
    const profileName = this.#profileForMode(args?.mode)
    // One fleet is one dsh process, so one model for the dispatcher and every member.
    const model = this.#resolveModel(args?.model, profileName)
    // A fleet is one call and therefore one tree: its members share a working
    // directory exactly as they share a runtime, so they see each other's edits.
    const pool = this.#isolationFor(profileName)
    // A fleet's copy starts from the same place a single task's does; see flashTask.
    const source = this.#resolveSource(args?.source, pool)
    // A fleet continues from a base patch exactly as one task does; see flashTask.
    const basePatchId = this.#resolveBasePatch(args?.basePatch, pool)
    // As with flash_task, progress spans the whole call, a wait for a free tree included.
    const activity = createActivity()
    // As in flashTask: the heartbeat reads the session id from the activity record, so a
    // retry's new session is named without restarting the timer.
    activity.sessionId = sessionId
    const stopProgress = startProgress({
      activity,
      progress,
      token: progressToken,
      label: 'flash_batch',
      sessionId,
      budgetMs: this.batchTimeoutMs,
      intervalMs: this.progressIntervalMs,
      log: this.log,
    })
    let slot
    let change
    let baseApplied
    let setup
    let queuedMs = 0
    try {
      /** The wait for a tree, when there was one; see flashTask. */
      let queued
      if (pool !== undefined) {
        const queuedSince = this.#noteQueue(pool, activity, background !== true)
        slot = await this.#lease(pool, 'flash_batch', this.batchTimeoutMs, signal)
        queuedMs = this.#noteLeased(activity, queuedSince)
        if (queuedSince !== undefined) {
          queued = { ms: queuedMs, inUse: activity.queuedInUse, size: activity.queuedSize }
        }
      }
      const { promptCwd, runtimeCwd, extraEnv, slotPorts, slotValues } = this.#runLocation(slot, rootCwd, pool)
      if (slot !== undefined) {
        try {
          pool.prepare(slot, {
            cwd: rootCwd,
            source,
            // The fleet is one call, so one task identity: the member's first lines, in
            // order, so the patch says what the fleet was asked to do.
            task: {
              kind: 'flash_batch',
              label: batchTaskLabel(tasks),
              sessionId,
              ...(jobId === undefined ? {} : { jobId }),
            },
          })
        } catch (error) {
          if (error instanceof IsolationError) throw new FlashTaskError(error.message, error.code)
          throw error
        }
        // The fleet's one copy gets the same setup as a single task's; see flashTask.
        setup = await this.#runSlotSetup(pool, slot, activity, signal)
        // The fleet's one copy starts on top of the base patch, exactly as a single task's does.
        if (basePatchId !== undefined) {
          try {
            baseApplied = pool.applyBasePatch(slot, basePatchId)
          } catch (error) {
            throw new FlashTaskError(messageOf(error), 'BASE_PATCH_UNAVAILABLE')
          }
        }
        activity.what = 'starting'
      }
      const copy =
        slot === undefined
          ? {}
          : {
              copy: true,
              uncommitted: slot.uncommitted,
              slotEnv: extraEnv,
              slotPorts,
              slotValues,
              slotSetup: promptSlotSetup(pool, setup),
              discard: apply === 'discard',
              ...(baseApplied === undefined ? {} : { basePatch: promptBasePatch(baseApplied) }),
            }
      const items = tasks.map((entry, index) => ({
        label: `task-${String(index + 1)}`,
        prompt: [
          buildChildPrompt({ cwd: promptCwd, task: entry.task, acceptance: entry.acceptance ?? acceptance, ...copy }),
          '',
          WORKER_RULES,
        ].join('\n'),
      }))
      // As in flashTask: measured before the fleet runs, in the copy its members see.
      const instructions = this.#instructionsFor(promptCwd)
      const prompt = buildBatchPrompt({
        count: items.length,
        script: BATCH_SCRIPT,
        args: { items, perItemChars: this.perItemChars },
      })
      const runAttempt = (attemptSessionId) =>
        this.#runSession({
          sessionId: attemptSessionId,
          activity,
          prompt,
          timeoutMs: this.batchTimeoutMs,
          label: 'flash_batch',
          note: `${String(items.length)} delegated tasks`,
          signal,
          profile: profileName,
          cwd: runtimeCwd,
          extraEnv,
          model,
        })
      let attempt = await runAttempt(sessionId)
      let attemptSessionId = sessionId
      let retried
      const early = this.#earlyFailureReason({
        state: attempt.state,
        started: attempt.started,
        slot,
        pool,
        signal,
        // Today's NOT_DELEGATED for a fleet: the orchestrator never started one worker.
        delegated: attempt.state.subagentStarts > 0,
      })
      if (early !== undefined) {
        const firstUsage = usageTotal(attempt.state)
        retried = {
          reason: early,
          firstSessionId: sessionId,
          firstDurationMs: Date.now() - attempt.started,
          ...(firstUsage === undefined ? {} : { firstUsage }),
        }
        this.log(
          `the first attempt ${sessionId} ended early with no result (${early}); retrying once in the same working ` +
            `directory after ${String(this.earlyRetryDelayMs)}ms`,
        )
        await this.#waitBeforeRetry(signal, 'flash_batch')
        attemptSessionId = `flash-batch-${randomUUID()}`
        activity.sessionId = attemptSessionId
        attempt = await runAttempt(attemptSessionId)
        // As in flashTask: never a third attempt, and the retry stays in the record even when
        // the second attempt failed the same way.
      }
      const { state, started } = attempt

      if (state.subagentStarts === 0) {
        throw new FlashTaskError(
          `the orchestrator finished without starting the fleet${describeParent(state)}${retryNote(retried)}`,
          'NOT_DELEGATED',
        )
      }
      this.#logToolTrace(state)
      change = slot === undefined ? undefined : pool.collect(slot, { diffChars: this.diffChars, store: apply !== 'discard' })
      const applied = change?.available === true && apply === 'auto' ? this.#applyChange(change) : undefined
      const result = this.#buildBatchResult({
        state,
        tasks,
        sessionId: attemptSessionId,
        started,
        profile: profileName,
        cwd: runtimeCwd,
        model,
        instructions,
        slot,
        change,
        applied,
        basePatch: baseApplied,
        setup,
        queuedMs,
        queued,
        background,
        retried,
        activity,
      })
      // The fleet's record carries one paragraph per member: the patch outlives the call,
      // and the workers' own accounts are the only explanation of it.
      if (change?.patchId !== undefined && apply !== 'discard') {
        this.#annotatePatch(pool, change.patchId, batchFinalMessage(result))
      }
      return result
    } catch (error) {
      if (slot !== undefined && (error?.code === 'TIMEOUT' || error?.code === 'IDLE' || error?.code === 'CANCELLED')) {
        await this.#salvageOrphaned(pool, slot, error, profileName)
      }
      throw error
    } finally {
      stopProgress()
      if (slot !== undefined) this.#settleSlot(pool, slot, change)
    }
  }

  /**
   * Why an attempt is an early, empty failure worth one retry — or undefined when it is not.
   *
   * Right after a machine restart, some of the first calls ended within a minute or two with
   * `status: "error"` and an empty message, and the same briefs ran normally minutes later.
   * The shape of such an attempt is specific: nothing delegated (or every worker said
   * nothing), a handful of model calls, a short session, and — the part that matters most —
   * no change in the copy. A copy holding a change is real work whatever the worker said, so
   * it is never retried; the check is `collect(..., { store: false })`, which stages the
   * copy's index exactly as the real collect does, so a later collect still sees the same
   * change (a test pins that). "No change" means every part of what `collect` reports is
   * empty — tracked files, newly ignored paths, and rewritten ignored ones — and that the
   * diff could be computed at all: ignored build output alone is work a retry would claim.
   *
   * @param {object} input - the finished attempt.
   * @param {object} input.state - the observation state `#runSession` accumulated.
   * @param {number} input.started - when the attempt began, in ms.
   * @param {object} [input.slot] - the call's tree, when it had one.
   * @param {WorkspaceIsolation} [input.pool] - the call's pool.
   * @param {AbortSignal} [input.signal] - the call's cancellation.
   * @param {boolean} input.delegated - whether the attempt delegated anything at all.
   * @returns {'NOT_DELEGATED' | 'EMPTY_RESULT' | undefined} the reason, or undefined.
   */
  #earlyFailureReason({ state, started, slot, pool, signal, delegated }) {
    if (signal?.aborted === true) return undefined
    if (Date.now() - started >= EARLY_RETRY_MAX_MS) return undefined
    // Unknown usage counts as qualifying: nothing reported it, so nothing says the attempt
    // was a real one.
    const usage = usageTotal(state)
    if (usage !== undefined && usage.modelCalls > EARLY_RETRY_MAX_MODEL_CALLS) return undefined
    let reason
    if (!delegated) reason = 'NOT_DELEGATED'
    else if (state.children.length > 0 && state.children.every((child) => child.result.trim().length === 0)) {
      reason = 'EMPTY_RESULT'
    } else return undefined
    if (slot !== undefined && pool !== undefined) {
      // A call without a slot has no copy to check, and a read-only call cannot have changed
      // anything in the first place.
      const change = pool.collect(slot, { store: false, diffChars: this.diffChars })
      // Only a copy that can be compared and holds nothing at all is "unchanged". An
      // unreadable diff (`available: false`) says nothing either way, and git-ignored output
      // is real work the patch cannot carry: retrying in the same tree would then let the
      // second attempt report the first one's ignored files as its own.
      if (change?.available !== true) return undefined
      if ((change.filesChanged ?? []).length > 0) return undefined
      if ((change.ignored ?? []).length > 0) return undefined
      if ((change.ignoredChanged ?? []).length > 0) return undefined
    }
    return reason
  }

  /**
   * Wait before retrying an early, empty attempt, or refuse when the call is cancelled.
   *
   * The wait is the point: a runtime that has just come up is still cold, and the report
   * that motivated this said the same brief sent minutes later ran normally. It is
   * abortable, because a caller that has already given up must not be held for it, and the
   * timer is unref'd so it never keeps the process alive on its own.
   *
   * @param {AbortSignal} [signal] - the call's cancellation.
   * @param {string} label - `flash_task` or `flash_batch`, for the error message.
   * @returns {Promise<void>} resolves after the delay.
   * @throws {FlashTaskCancelled} when the call is cancelled first.
   */
  #waitBeforeRetry(signal, label) {
    if (signal?.aborted === true) {
      return Promise.reject(new FlashTaskCancelled(`${label} was cancelled before its first attempt was retried`))
    }
    const delayMs = this.earlyRetryDelayMs
    if (delayMs <= 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer)
        reject(new FlashTaskCancelled(`${label} was cancelled before its first attempt was retried`))
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, delayMs)
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Attach a worker's report to a stored patch, and never let that fail the call.
   *
   * The annotation is traceability, not the result: the patch is already on disk and the
   * caller already holds the answer. A record that cannot be rewritten is worth one log line.
   *
   * @param {WorkspaceIsolation | undefined} pool - the pool that stored the patch.
   * @param {string} patchId - the patch to annotate.
   * @param {string} finalMessage - the worker's own account; an empty one is not written.
   * @returns {void}
   */
  #annotatePatch(pool, patchId, finalMessage) {
    if (pool === undefined || typeof finalMessage !== 'string' || finalMessage.length === 0) return
    try {
      pool.annotatePatch(patchId, { finalMessage })
    } catch (error) {
      this.log(`could not attach the worker's report to patch ${patchId}: ${messageOf(error)}`)
    }
  }

  /**
   * Run the repository's setup steps in one prepared slot, as the service sees them.
   *
   * The pool owns the steps; the service owns the error shape and the activity line, so a
   * status call or a heartbeat never reads as silence while `uv sync` runs. A failed or
   * cancelled step is a FlashTaskError like every other refusal, and the slot is released by
   * the caller's `finally` exactly as it would be after a worker that ran.
   *
   * @param {WorkspaceIsolation} pool - the call's pool.
   * @param {object} slot - the prepared slot.
   * @param {object} activity - the call's activity record.
   * @param {AbortSignal} [signal] - the call's cancellation.
   * @returns {Promise<object[] | undefined>} what `runSetup` reported, if anything.
   */
  async #runSlotSetup(pool, slot, activity, signal) {
    try {
      return await pool.runSetup(slot, {
        signal,
        onStep: (run) => {
          activity.what = `running slot setup: ${run.join(' ')}`
          activity.at = Date.now()
        },
      })
    } catch (error) {
      if (error instanceof IsolationError) throw new FlashTaskError(error.message, error.code)
      throw error
    }
  }

  /**
   * Apply a stored patch to the caller's repository, and report it as a tool error
   * if it will not apply — the patch stays on disk either way, so a conflict is a
   * message with a path in it rather than lost work.
   *
   * @param {object} change - the change a finished call produced.
   * @returns {object} the apply outcome.
   */
  #applyChange(change) {
    try {
      return this.isolation.apply({ patchId: change.patchId })
    } catch (error) {
      throw new FlashTaskError(
        `the worker changed files, but the patch did not apply to ${this.root}: ${messageOf(error)}. ` +
          `The patch is kept at ${String(change.patchPath)}; call flash_apply with threeWay: true to merge it.`,
        'APPLY_FAILED',
      )
    }
  }

  /**
   * Apply a patch a previous call left behind.
   *
   * @param {object} args - the MCP tool arguments.
   * @param {string} args.patchId - the id from an earlier result.
   * @param {string[]} [args.files] - apply only these files' sections, named as in
   *   `change.filesChanged`; a rename may be named by its old or its new path.
   * @param {boolean} [args.dryRun] - check that it applies without changing anything.
   * @param {boolean} [args.force] - apply again even though the record says it was applied.
   * @param {boolean} [args.threeWay] - merge three ways, without touching the index, when the plain apply fails.
   * @returns {object} the apply outcome.
   */
  flashApply(args) {
    const patchId = requireText(args?.patchId, 'patchId')
    if (this.isolation === undefined) {
      throw new FlashTaskError(
        'this service runs without isolation (--isolate none), so its calls have no patch to apply',
        'ISOLATION_DISABLED',
      )
    }
    const files = args?.files
    // The shape belongs here; whether the selection names a file of the patch, or no file
    // at all, is the patch's answer and is refused by the pool with the patch's own names.
    if (files !== undefined && (!Array.isArray(files) || files.some((name) => typeof name !== 'string' || name.length === 0))) {
      throw new FlashTaskError('files must be an array of non-empty file paths when present', 'INVALID_ARGUMENT')
    }
    try {
      return this.isolation.apply({
        patchId,
        ...(files === undefined ? {} : { files }),
        dryRun: args?.dryRun === true,
        force: args?.force === true,
        threeWay: args?.threeWay === true,
      })
    } catch (error) {
      throw new FlashTaskError(messageOf(error), 'APPLY_FAILED')
    }
  }

  /**
   * Read a stored patch, whole or as one page, for review before applying it.
   *
   * @param {object} args - the MCP tool arguments.
   * @param {string} args.patchId - the change.patchId from an earlier result.
   * @param {string[]} [args.files] - read only these files' sections.
   * @param {number} [args.offset] - character offset into the selected text, default 0.
   * @param {number} [args.maxChars] - page size, default the service's diff limit.
   * @returns {object} the patch page.
   */
  flashPatch(args) {
    const patchId = requireText(args?.patchId, 'patchId')
    if (this.isolation === undefined) {
      throw new FlashTaskError(
        'this service runs without isolation (--isolate none), so its calls have no patch to read',
        'ISOLATION_DISABLED',
      )
    }
    const files = args?.files
    if (files !== undefined && (!Array.isArray(files) || files.some((name) => typeof name !== 'string'))) {
      throw new FlashTaskError('files must be an array of file paths when present', 'INVALID_ARGUMENT')
    }
    const offset = args?.offset
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
      throw new FlashTaskError('offset must be an integer greater than or equal to 0', 'INVALID_ARGUMENT')
    }
    const maxChars = args?.maxChars
    if (maxChars !== undefined && (!Number.isInteger(maxChars) || maxChars <= 0)) {
      throw new FlashTaskError('maxChars must be a positive integer when present', 'INVALID_ARGUMENT')
    }
    const pageChars = Math.min(maxChars ?? this.diffChars, MAX_PATCH_PAGE_CHARS)
    try {
      return this.isolation.readPatch({ patchId, files, offset: offset ?? 0, maxChars: pageChars })
    } catch (error) {
      throw new FlashTaskError(messageOf(error), 'PATCH_UNAVAILABLE')
    }
  }

  /**
   * Read the `apply` argument. Only an explicit `auto` applies anything, and only an
   * explicit `discard` throws the patch away: the default leaves the caller's tree
   * alone and keeps what the worker produced.
   *
   * @param {unknown} value - the requested mode.
   * @returns {'none' | 'auto' | 'discard'} what to do with the patch.
   */
  #resolveApply(value) {
    if (value === undefined || value === null || value === 'none') return 'none'
    if (value === 'auto' || value === 'discard') {
      if (this.isolation === undefined) {
        throw new FlashTaskError(
          `apply "${value}" needs isolation, but this service runs with --isolate none`,
          'ISOLATION_DISABLED',
        )
      }
      return value
    }
    throw new FlashTaskError(
      `apply ${JSON.stringify(value)} is not available; use "none" (default), "auto", or "discard"`,
      'APPLY_UNAVAILABLE',
    )
  }

  /** Start one session on the persistent runtime and wait for it to go idle. */
  async #runSession({ sessionId, prompt, timeoutMs, label, note, signal, profile, cwd = this.root, extraEnv, model, activity = createActivity() }) {
    const key = this.#runtimeKey(profile, cwd, model)
    // Held before the runtime is booted, not only while the session runs: a concurrent
    // call for another model must not retire this process between "ready" and "prompted".
    this.#holdRuntime(key)
    const state = createObserveState()
    state.activity = activity
    activity.at = Date.now()
    const started = Date.now()
    const completion = createDeferred()
    let run
    let unsubscribe = () => {}
    let offExit = () => {}
    try {
      run = await this.#ensureRuntime(profile, cwd, extraEnv, model)
      const client = run.client
      run.sessions += 1
      unsubscribe = client.onNotification((method, params) => {
        observe(state, method, params, sessionId, completion, this.log)
      })
      offExit = client.onExit(() => {
        completion.reject(new FlashTaskError('the dsh runtime exited during the task', 'RUNTIME_EXITED'))
      })
      this.sessions += 1
      await client.prompt({ sessionId, text: prompt })
      this.log(
        `session ${sessionId} prompted on ${model}${note === undefined ? '' : ` (${note})`}`,
      )
      await raceWithBudget(completion.promise, {
        timeoutMs,
        idleTimeoutMs: this.idleTimeoutMs,
        activity,
        label,
        signal,
        sessionId,
        diagnostics: () => this.runtimes.get(key)?.client?.diagnostics ?? '',
      })
      return { state, started }
    } catch (error) {
      // A call that times out or is cancelled never builds a result, so the refusals
      // seen so far travel on the error instead; the salvage step reports them from there.
      if (error?.code === 'TIMEOUT' || error?.code === 'IDLE' || error?.code === 'CANCELLED') error.denials = state.denials
      throw error
    } finally {
      // The runtime's own count is what `#retireOtherModels` reads; it falls with the
      // session, on every path out of this method.
      if (run !== undefined) run.sessions = Math.max(0, run.sessions - 1)
      this.#releaseRuntime(key)
      unsubscribe()
      offExit()
    }
  }

  #logToolTrace(state) {
    for (const [index, call] of state.toolCalls.entries()) {
      this.log(`tool call ${String(index + 1)}: ${call}`)
    }
    for (const [index, result] of state.toolResults.entries()) {
      this.log(`tool result ${String(index + 1)}: ${result}`)
    }
  }

  /** Dispose every runtime this service started, and the disposable trees. */
  async close() {
    const runs = [...this.runtimes.values()]
    this.runtimes.clear()
    for (const run of runs) await run.client?.shutdown().catch(() => {})
    this.isolation?.close()
  }

  /**
   * Start and hand-shake one profile-and-model's runtime exactly once, even under
   * concurrent calls. Each profile keeps one persistent process per model: the model is
   * fixed for the life of the process, so a call that chooses another needs its own.
   *
   * @param {string} profileName - the profile to run on.
   * @param {string} cwd - the tree the runtime is rooted at.
   * @param {object | undefined} extraEnv - the slot's per-tree environment.
   * @param {string} model - the model this process runs.
   * @returns {Promise<object>} the runtime record; its `client` is the live client.
   */
  async #ensureRuntime(profileName, cwd, extraEnv, model) {
    const key = this.#runtimeKey(profileName, cwd, model)
    const existing = this.runtimes.get(key)
    if (existing?.client?.running && existing.initialized) return existing
    if (existing?.starting !== undefined) return await existing.starting
    const run = existing ?? {
      client: undefined,
      initialized: false,
      starting: undefined,
      startedAt: undefined,
      profile: profileName,
      cwd,
      model,
      sessions: 0,
    }
    this.runtimes.set(key, run)
    run.starting = (async () => {
      let client
      // A cold runtime on a busy disk can miss the handshake deadline without anything
      // being wrong with it. That failure is the one worth retrying: a fresh process gets
      // a fresh budget. Every other failure is a verdict, and repeating it only delays it.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        let diagnostics = ''
        try {
          // The profile reads this variable to pick the model its one process serves, and
          // the handshake names the same model, so both ends agree on what will run.
          client = this.clientFactory(profileName, cwd, { ...(extraEnv ?? {}), [ROUTE_MODEL_VAR]: model })
          client.start()
          const info = await client.initialize({
            cwd,
            provider: this.provider,
            model,
            ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
          })
          run.client = client
          run.initialized = true
          run.startedAt = Date.now()
          this.log(`runtime ready: ${info.name} ${info.version} (pid ${String(client.pid)}) on ${profileName}/${model}`)
          // The runtime is up but has not served the call yet: this is the first moment the
          // stamp beside the profile it just loaded can be judged.
          this.#refreshProfileStamp(run, profileName)
          await this.#retireOtherModels(profileName, cwd, model, run)
          return run
        } catch (error) {
          // Capture the tail before shutdown: closing the process is exactly when the
          // part that explains the failure would otherwise be discarded.
          diagnostics = client?.diagnostics
          await client?.shutdown().catch(() => {})
          client = undefined
          if (isTimeoutError(error) && attempt === 1) {
            this.log(
              `the runtime did not answer initialize within ${String(this.initTimeoutMs / 1000)} s; starting it once more`,
            )
            continue
          }
          this.runtimes.delete(key)
          const hint = stderrHint(diagnostics)
          const alreadyHinted = hint.length > 0 && messageOf(error).endsWith(hint)
          const attempts = attempt === 1 ? '' : 'tried twice, the first attempt timed out: '
          throw new FlashTaskError(
            `could not initialize the ${profileName} runtime: ${attempts}${messageOf(error)}${alreadyHinted ? '' : hint}`,
            'RUNTIME_INIT_FAILED',
          )
        }
      }
      // The loop always returns or throws; this keeps the method's contract explicit.
      throw new FlashTaskError(`could not initialize the ${profileName} runtime`, 'RUNTIME_INIT_FAILED')
    })()
    try {
      return await run.starting
    } finally {
      run.starting = undefined
    }
  }

  /**
   * The task text of a `flash_task` call: either `task` or `taskFile`, exactly one.
   *
   * @param {object} args - the MCP tool arguments.
   * @returns {string} the task text, exactly as written.
   * @throws {FlashTaskError} when both or neither field is present.
   */
  #resolveTask(args) {
    const hasTask = args?.task !== undefined && args?.task !== null
    const hasFile = args?.taskFile !== undefined && args?.taskFile !== null
    if (hasTask && hasFile) {
      throw new FlashTaskError(
        'task and taskFile cannot both be given: pass exactly one of "task" (the task text) or ' +
          '"taskFile" (a path to a file holding it)',
        'INVALID_ARGUMENT',
      )
    }
    if (!hasTask && !hasFile) {
      throw new FlashTaskError(
        'a task is required: pass exactly one of "task" (the task text) or "taskFile" (a path to a ' +
          'file holding it)',
        'INVALID_ARGUMENT',
      )
    }
    if (hasFile) return this.#readTaskFile(args.taskFile)
    return requireText(args.task, 'task')
  }

  /**
   * Read a task brief from a file, fenced to the service root exactly like `cwd`.
   *
   * Callers write 4-8 KB briefs to a file and used to paste `$(cat brief)` into the task
   * text, which the worker then started on literally. A path — relative to the root — is
   * sent as written, once. Reading is confined for the same reason every other path is:
   * the file is about to be put into a prompt, so a path outside the root (or a symlink
   * pointing out of it) is refused rather than read.
   *
   * @param {unknown} requested - the `taskFile` argument.
   * @param {string} [field] - the argument's name, for errors (`tasks[1].taskFile` in a fleet).
   * @returns {string} the file's text, exactly as written.
   * @throws {FlashTaskError} when the path is unreadable, outside the root, or not a usable file.
   */
  #readTaskFile(requested, field = 'taskFile') {
    return readTaskFile(this.root, requested, { field, log: this.log })
  }

  /** Resolve and fence the worker working directory. */
  #resolveCwd(requested) {
    if (requested === undefined || requested === null || requested === '') return this.root
    const text = requireText(requested, 'cwd')
    const absolute = isAbsolute(text) ? resolve(text) : resolve(this.root, text)
    const real = this.#realPath(absolute)
    const relation = relative(this.root, real)
    // Segment-aware: `relative` yields `..foo` for a *sibling* named `..foo`, and a
    // plain `startsWith('..')` refused that honest directory as if it were outside.
    if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      throw new FlashTaskError(
        `cwd "${text}" is outside the service root ${this.root}; this service is confined to that root`,
        'CWD_OUTSIDE_ROOT',
      )
    }
    return real
  }

  /**
   * The real path of a directory, resolved through its nearest existing ancestor.
   *
   * A cwd the caller is about to create does not exist yet, and realpath'ing only
   * the paths that exist made a `/tmp` → `/private/tmp` root compare as if the same
   * directory were outside itself. Resolving the ancestor that does exist and
   * re-appending the rest gives one canonical form for both cases.
   *
   * @param {string} candidate - an absolute path.
   * @returns {string} its canonical form.
   */
  #realPath(candidate) {
    let current = candidate
    const tail = []
    while (!existsSync(current)) {
      const parent = resolve(current, '..')
      if (parent === current) return candidate
      tail.unshift(current.slice(parent.length).replace(/^[/\\]/, ''))
      current = parent
    }
    return join(realpathSync(current), ...tail)
  }

  /**
   * The isolation facts a result carries: which tree served the call, and what the
   * worker changed in it.
   *
   * @param {object} input - the call's isolation state.
   * @param {string} input.profileName - the profile that served the call.
   * @param {object} [input.slot] - the disposable tree, when the call had one.
   * @param {object} [input.change] - the change the call produced.
   * @param {boolean} [input.applied] - whether the change was applied to the root.
   * @param {object} [input.basePatch] - the base patch the copy was started from.
   * @returns {object} fields to spread into the result.
   */
  #changeFields({ profileName, slot, change, applied, basePatch }) {
    const isolated = this.isolation !== undefined && profileName === this.profile
    const fields = {
      isolation: {
        mode: isolated ? 'copy' : 'none',
        slot: slot?.id ?? null,
        ...(slot?.uncommitted?.count > 0 ? { uncommittedAtStart: slot.uncommitted } : {}),
      },
      ...basePatchFields(basePatch),
    }
    if (change === undefined) return fields
    const omitted = change.diffOmitted ?? []
    return {
      ...fields,
      change: {
        available: change.available,
        ...(change.available ? {} : { reason: change.reason }),
        // Decoded by the record's own reader, so a name holding a tab, a newline or a
        // leading quote keeps the spelling `flash_apply`'s `files` takes.
        filesChanged: recordPaths(change.filesChanged),
        // Files the worker created that git ignores, so the patch cannot carry them.
        // Named so that "no change" is never the whole answer when there was work.
        ...((change.ignored ?? []).length === 0 ? {} : { ignored: change.ignored }),
        // Ignored files that already existed and the worker rewrote or deleted: also
        // outside the patch, and invisible to the list comparison above.
        ...((change.ignoredChanged ?? []).length === 0 ? {} : { ignoredChanged: change.ignoredChanged }),
        diffstat: change.diffstat,
        diff: change.diff,
        // Truncation is measured by what the clipping left out, not by the returned text's
        // length: a diff that ends at a file boundary can be far shorter than the limit and
        // still be incomplete.
        diffTruncated: omitted.length > 0,
        ...(omitted.length === 0 ? {} : { diffOmitted: omitted }),
        applied: applied !== undefined,
        ...(change.patchId === undefined ? {} : { patchId: change.patchId }),
        ...(change.patchPath === undefined ? {} : { patchPath: change.patchPath }),
        ...(change.stored === false ? { stored: false } : {}),
      },
    }
  }

  /** Assemble the compact per-task fleet result. */
  #buildBatchResult({
    state,
    tasks,
    sessionId,
    started,
    profile,
    cwd,
    model,
    instructions,
    slot,
    change,
    applied,
    basePatch,
    setup,
    queuedMs = 0,
    queued,
    background = false,
    retried,
    activity,
  }) {
    const envelope = extractWorkflowValue(state.workflowText)
    const payload = envelope.value
    const warnings = []
    // What every member of the fleet was given in its prompt before it read the task.
    if (instructions.overBudget) warnings.push(overBudgetWarning(instructions))
    // Operational breadcrumb: enough to tell an unreadable value from a
    // mis-shaped one without ever returning the workflow's raw text.
    const header = parseWorkflowHeader(state.workflowText)
    const entryList = Array.isArray(payload) ? payload : undefined
    this.log(
      `workflow result: ${String(state.workflowText.length)} chars; runId=${String(state.workflowRunId)}; entries=${
        entryList === undefined ? `unreadable (${String(envelope.error)})` : String(entryList.length)
      }`,
    )
    // label -> member, keyed by the label this service generated for the task.
    const members = new Map()
    for (const [label, agent] of state.workflowAgents) {
      const match = /^task-(\d+)$/.exec(label)
      if (match !== null) members.set(Number(match[1]) - 1, agent)
    }
    const childById = new Map(state.children.map((child) => [child.childSessionId, child]))
    // A member's refusals, attributed through the engine's own label mapping. The
    // engine reports the child under the label this service generated, so the
    // attribution is read, never guessed.
    const refusals = (index) => {
      const childId = members.get(index)?.childId
      if (childId === undefined) return {}
      const mine = state.denials
        .filter((denial) => denial.childSessionId === String(childId))
        .map((denial) => ({ index, ...denial }))
      return mine.length === 0 ? {} : { denials: mine }
    }
    // A member's tokens are attributed the same way its refusals are, through the
    // engine's own label-to-child mapping, never by completion order. A worker no
    // event can tie to a label still reaches the fleet total below; it just cannot be
    // charged to a task here, and saying so is better than splitting it at random.
    const usageFields = (index) => {
      const childId = members.get(index)?.childId
      if (childId === undefined) return {}
      const root = String(childId)
      const buckets = [...state.usage.bySession]
        .filter(([session]) => descendsFrom(state, session, root))
        .map(([, bucket]) => bucket)
      const usage = usageOf(mergeUsageBuckets(buckets))
      return usage === undefined ? {} : { usage }
    }

    // The script returns its entries in task order, so the pairing is the
    // script's own arithmetic rather than an inference from completion order.
    let results = null
    if (entryList !== undefined) {
      const entries = new Map()
      for (const entry of entryList) {
        if (entry !== null && typeof entry === 'object' && Number.isInteger(entry?.index)) {
          entries.set(entry.index, entry)
        }
      }
      results = tasks.map((entry, index) => {
        const found = entries.get(index)
        const member = members.get(index)
        if (found === undefined) {
          warnings.push(`task ${String(index + 1)} has no worker entry in the workflow return value`)
          return { index, status: 'unknown', result: '', resultTruncated: false, ...memberFields(member, childById), ...refusals(index), ...usageFields(index) }
        }
        const clipped = truncate(typeof found.result === 'string' ? found.result : '', this.maxResultChars)
        return {
          index,
          status: found.ok === true ? 'ok' : 'error',
          result: clipped.text,
          resultTruncated: clipped.truncated,
          ...memberFields(member, childById),
          ...refusals(index),
          ...usageFields(index),
        }
      })
    } else if (members.size === tasks.length) {
      // The engine itself reports which labelled member ended how. That is a
      // real pairing, not an inference, so per-task status and the member's own
      // final message survive an unreadable return value.
      warnings.push(`the workflow return value could not be read (${String(envelope.error)}); per-task results come from the engine's member records`)
      results = tasks.map((entry, index) => {
        const member = members.get(index)
        const child = member?.childId === undefined ? undefined : childById.get(String(member.childId))
        const clipped = truncate(child?.result ?? '', this.maxResultChars)
        return {
          index,
          status: member?.outcome === 'completed' ? 'ok' : 'error',
          result: clipped.text,
          resultTruncated: clipped.truncated,
          ...memberFields(member, childById),
          ...refusals(index),
          ...usageFields(index),
        }
      })
    } else {
      // With neither the script's ordered return value nor a complete label
      // mapping, the child-to-task pairing is unknowable: report the absence
      // rather than invent one.
      warnings.push(`the per-task results could not be read (${String(envelope.error)})`)
    }

    const maxParallel = state.maxParallel
    // A member that ended "ok" with an empty message did not report its work: the entry's
    // text *is* the account, so an empty one cannot count as done. The fleet status below
    // is computed from the corrected entries, so a silent member makes the fleet partial
    // or failed rather than quietly ok.
    if (results !== null) {
      results = results.map((entry) =>
        entry.status === 'ok' && entry.result.trim().length === 0
          ? { ...entry, status: 'error', emptyResult: true }
          : entry,
      )
    }
    const ok = results === null ? 0 : results.filter((entry) => entry.status === 'ok').length
    const failed = results === null ? 0 : results.length - ok
    const status = results === null ? 'unknown' : failed === 0 ? 'ok' : ok === 0 ? 'error' : 'partial'
    if (tasks.length > 1 && maxParallel < 2) {
      warnings.push(`the fleet never ran two workers at once (peak concurrency ${String(maxParallel)})`)
    }
    if (state.children.some((child) => child.status !== 'ok')) {
      warnings.push('at least one worker ended with a non-ok status')
    }
    // What the engine reported each member running on is the observed truth; when it is
    // not the model this call asked for, the caller must not read the result as proof of it.
    for (const entry of results ?? []) {
      if (entry.childSessionId === undefined) continue
      const observed = state.childRoutes.get(entry.childSessionId)?.model
      if (observed !== undefined && observed !== model) {
        warnings.push(`task ${String(entry.index + 1)}: the worker ran on ${observed}, not the requested ${model}`)
      }
    }
    // With no paired results there is no per-task line to carry the observation, but the
    // engine still reported what each worker ran on. A fleet that ran another model must
    // not read as proof of the requested one just because its return value was unreadable.
    if (results === null) {
      const observedModels = []
      for (const route of state.childRoutes.values()) {
        if (typeof route.model === 'string' && route.model.length > 0 && !observedModels.includes(route.model)) {
          observedModels.push(route.model)
        }
      }
      if (observedModels.some((name) => name !== model)) {
        warnings.push(`the fleet ran on ${observedModels.join(', ')}, not the requested ${model}`)
      }
    }
    if ((change?.ignoredChanged ?? []).length > 0) {
      warnings.push(ignoredChangedWarning(change))
    }
    if (slot !== undefined && this.isolation?.slotSetupWarning !== undefined) {
      warnings.push(this.isolation.slotSetupWarning)
    }
    // The fleet's shared activity record: one warning per command that keeps failing,
    // whichever member of the fleet was running it.
    warnings.push(...activityWarnings(activity))
    if (queued !== undefined && background !== true) warnings.push(foregroundQueueWarning(queued))
    if (retried !== undefined) warnings.push(earlyRetryWarning(retried.reason))
    // Installation drift: a profile from another release, a Settings edit after start, or a
    // Windows slot root too long for tools without long-path support.
    warnings.push(...this.#installationWarnings(profile, cwd, model))
    const routes = []
    for (const route of state.childRoutes.values()) {
      if (!routes.some((known) => known.provider === route.provider && known.model === route.model)) routes.push(route)
    }
    // The fleet total is always reported when anything reported usage: it is the honest
    // number even when a member could not be tied to its task, and it is what a caller
    // weighing a fleet against doing the work itself needs to compare.
    const usage = usageTotal(state)

    return {
      status,
      requested: tasks.length,
      agentsStarted: typeof header.agentsStarted === 'number' ? header.agentsStarted : state.subagentStarts,
      runId: state.workflowRunId ?? null,
      results,
      routes,
      workers: state.children.map((child) => ({
        status: child.status,
        stopReason: child.stopReason,
        provider: child.provider,
        route: state.childRoutes.get(child.childSessionId) ?? null,
        childSessionId: child.childSessionId,
        resultChars: child.result.length,
      })),
      maxParallel,
      ...(header.name === undefined ? {} : { runName: header.name }),
      ...(state.workflowStopReason === undefined ? {} : { runStopReason: state.workflowStopReason }),
      sessionId,
      mode: profile.endsWith('-readonly') ? 'read-only' : 'workspace-write',
      // The session's own run time: a wait for a free tree is reported separately, as queuedMs.
      durationMs: Date.now() - started,
      queuedMs,
      ...(usage === undefined ? {} : { usage }),
      instructions,
      ...(setup === undefined || setup.length === 0 ? {} : { setup }),
      ...(retried === undefined ? {} : { retried }),
      runtime: this.#runtimeInfo(profile, cwd, model),
      ...this.#changeFields({ profileName: profile, slot, change, applied, basePatch }),
      ...(warnings.length === 0 ? {} : { warnings }),
    }
  }

  /**
   * The installation warnings this call's result must carry.
   *
   * The stamp warning belongs to the runtime that served the call, because one booted
   * after an install loads the new profile while one booted before it keeps the old
   * verdict. A call that never reached a runtime falls back to the latest verdict known
   * for its profile — the start-time one until a runtime boots. The settings check is one
   * `stat` per file per call, because a file edited after the pool read it is silently
   * ignored until a reconnect and the caller has to be told (see
   * `WorkspaceIsolation.repoSettingsChanged`).
   *
   * @param {string} profileName - the profile that served, or would have served, the call.
   * @param {string} cwd - the tree the call ran on.
   * @param {string} model - the model the call ran.
   * @returns {string[]} the warnings, each at most once.
   */
  #installationWarnings(profileName, cwd, model) {
    const warnings = [...this.startupWarnings]
    const run = this.runtimes.get(this.#runtimeKey(profileName, cwd, model))
    // A runtime whose stamp matched holds `undefined` as its verdict, which is an answer,
    // not a missing one: only a runtime that never judged its stamp falls back.
    const stampWarning =
      run !== undefined && Object.hasOwn(run, 'profileStampWarning')
        ? run.profileStampWarning
        : this.profileStampWarnings.get(profileName)
    if (stampWarning !== undefined) warnings.push(stampWarning)
    // One warning per settings file that changed, so a per-machine edit is not mistaken
    // for a change to the committed file (see `WorkspaceIsolation.repoSettingsChanged`).
    for (const file of this.isolation?.repoSettingsChanged() ?? []) warnings.push(settingsChangedWarning(file))
    return warnings
  }

  /** Assemble the compact result the MCP client receives. */
  #buildResult({
    state,
    sessionId,
    started,
    profile,
    cwd,
    model,
    instructions,
    slot,
    change,
    applied,
    basePatch,
    setup,
    queuedMs = 0,
    queued,
    background = false,
    retried,
    activity,
  }) {
    const children = state.children.map((child) => {
      const clipped = truncate(child.result, this.maxResultChars)
      return {
        status: child.status,
        stopReason: child.stopReason,
        provider: child.provider,
        childSessionId: child.childSessionId,
        route: state.childRoutes.get(child.childSessionId) ?? null,
        result: clipped.text,
        resultTruncated: clipped.truncated,
      }
    })
    const primary = children[children.length - 1]
    const usage = usageTotal(state)
    // `instructions` is what the worker was given in its prompt before it read the task: the
    // harness injects the project's instruction files into every worker, so this is a
    // per-call token cost the caller would otherwise only discover from its bill.
    // "ok" with no words and no work is not a finished task: nothing says the worker did
    // what it was asked, and a caller that reads the status alone would accept it. Only an
    // empty message is reclassified — a short one is the worker's business, not ours.
    const changed = change?.available === true && (change.filesChanged ?? []).length > 0
    const emptyResult = primary.result.trim().length === 0
    const warnings = []
    if (children.length > 1) warnings.push(`the orchestrator delegated ${String(children.length)} times; the last child is reported as the result`)
    if (primary.status !== 'ok') warnings.push(`the worker ended with status "${String(primary.status)}"`)
    if (emptyResult && !changed) {
      primary.status = 'error'
      warnings.push('the worker ended with an empty final message and changed nothing; treat the call as failed and send the task again')
    } else if (emptyResult) {
      warnings.push('the worker ended with an empty final message, so its account of the change is missing; review the diff before applying it')
    }
    if ((change?.ignored ?? []).length > 0) {
      warnings.push(
        `the worker created ${String(change.ignored.length)} path(s) that git ignores, so the patch cannot carry them: ${change.ignored.slice(0, 5).join(', ')}`,
      )
    }
    if ((change?.ignoredChanged ?? []).length > 0) {
      warnings.push(ignoredChangedWarning(change))
    }
    // Over budget, the harness keeps the most specific files and drops the broader
    // ones, so the worker's prompt is quietly missing project-wide rules. Say so.
    if (instructions.overBudget) warnings.push(overBudgetWarning(instructions))
    if (slot !== undefined && this.isolation?.slotSetupWarning !== undefined) {
      warnings.push(this.isolation.slotSetupWarning)
    }
    // The route the result carries is what the child was observed running on. When that
    // is not the model this call asked for, the result must say so rather than let the
    // caller take the requested model on trust.
    if (primary.route?.model !== undefined && primary.route.model !== model) {
      warnings.push(`the worker ran on ${primary.route.model}, not the requested ${model}`)
    }
    // A worker that keeps repeating a step its sandbox cannot finish holds its tree for
    // hours while its progress keeps changing; the result says so even to a caller that
    // never watched a heartbeat.
    warnings.push(...activityWarnings(activity))
    if (queued !== undefined && background !== true) warnings.push(foregroundQueueWarning(queued))
    if (retried !== undefined) warnings.push(earlyRetryWarning(retried.reason))
    // Same installation drift the fleet's members were started under.
    warnings.push(...this.#installationWarnings(profile, cwd, model))

    return {
      status: primary.status,
      stopReason: primary.stopReason,
      provider: primary.provider,
      route: primary.route,
      result: primary.result,
      resultTruncated: primary.resultTruncated,
      ...(emptyResult ? { emptyResult: true } : {}),
      childSessionId: primary.childSessionId,
      sessionId,
      mode: profile.endsWith('-readonly') ? 'read-only' : 'workspace-write',
      // The session's own run time: a wait for a free tree is reported separately, as queuedMs.
      durationMs: Date.now() - started,
      queuedMs,
      ...(usage === undefined ? {} : { usage }),
      instructions,
      ...(setup === undefined || setup.length === 0 ? {} : { setup }),
      ...(retried === undefined ? {} : { retried }),
      runtime: this.#runtimeInfo(profile, cwd, model),
      ...this.#changeFields({ profileName: profile, slot, change, applied, basePatch }),
      ...(warnings.length === 0 ? {} : { warnings }),
      ...(children.length === 1 ? {} : { children }),
    }
  }

  /**
   * The instruction files the harness injects into every worker of a call, measured
   * for the directory the worker actually sees.
   *
   * Runs once per call and never throws; see `estimateInstructions`.
   *
   * @param {string} workerCwd - the working directory named in the worker's prompt.
   * @returns {{files: object[], bytes: number, budgetBytes: number, overBudget: boolean, approxTokens: number}}
   */
  #instructionsFor(workerCwd) {
    return estimateInstructions({ cwd: workerCwd, dshHome: this.env?.DSH_HOME })
  }
}

/**
 * The warning a result carries when the project's instruction files outgrew the
 * harness's budget: over it, the worker's prompt silently misses the broader files.
 *
 * @param {{bytes: number, budgetBytes: number}} instructions - the measured estimate.
 * @returns {string} one sentence naming the size and the consequence.
 */
function overBudgetWarning(instructions) {
  const kb = Math.ceil(instructions.bytes / 1024)
  const budgetKb = Math.round(instructions.budgetBytes / 1024)
  return (
    `the project instruction files are ${String(kb)} KB, over the harness's ${String(budgetKb)} KB budget; ` +
    'workers see only part of them (the most specific files first)'
  )
}

/**
 * The warning a result carries when the worker changed a git-ignored file that existed
 * when the copy was made.
 *
 * Such a file leaves the ignored path list unchanged, so it is not `ignored`; the patch
 * cannot carry it either, so the caller has to regenerate or copy it after applying —
 * exactly what a stale ignored `worker-configuration.d.ts` cost a Linux caller whose
 * type check failed after the patch was applied.
 *
 * @param {{ignoredChanged?: {path: string, change: 'modified' | 'deleted'}[]}} change - the change.
 * @returns {string} one sentence naming the count and the first few paths.
 */
function ignoredChangedWarning(change) {
  const changed = change.ignoredChanged ?? []
  const paths = changed.slice(0, 5).map((entry) => entry.path).join(', ')
  return (
    `the worker changed ${String(changed.length)} git-ignored file(s) that the patch cannot carry: ${paths}; ` +
    'regenerate or copy them after applying'
  )
}

/**
 * The warning a foreground call carries when it had to wait for a free tree.
 *
 * A writing call without `background: true` holds the caller's whole turn while it queues,
 * and the caller cannot see why: the wait itself is the answer, with the counts it waited
 * behind and the one thing that would have avoided it.
 *
 * @param {{ms: number, inUse: number, size: number}} queued - the wait and its pool counts.
 * @returns {string} one sentence naming the wait and the remedy.
 */
function foregroundQueueWarning(queued) {
  return (
    `this call waited ${formatElapsed(queued.ms)} in the foreground for a free tree ` +
    `(${String(queued.inUse)} of ${String(queued.size)} in use), holding your turn; ` +
    'send writing calls with background: true when trees may be busy'
  )
}

/**
 * The warning a retried call carries about the attempt that produced nothing.
 *
 * @param {'NOT_DELEGATED' | 'EMPTY_RESULT'} reason - why the first attempt ended early.
 * @returns {string} one sentence naming the reason and that one retry happened.
 */
function earlyRetryWarning(reason) {
  return `the first attempt ended early with no result (${reason}) and was retried once`
}

/**
 * The retry the NOT_DELEGATED error names, when the call had already made one.
 *
 * A flash_task that never delegated has no result object to carry `retried`, so the error is
 * the only place the first attempt can survive. Without this the caller reads the same
 * message it would have read had no retry happened, while having paid for two attempts.
 *
 * @param {object | undefined} retried - the retry record, when there was one.
 * @returns {string} one parenthetical, or `''` when no retry happened.
 */
function retryNote(retried) {
  if (retried === undefined) return ''
  return ` (after one automatic retry; the first attempt ${retried.firstSessionId} ended the same way)`
}

/**
 * The first non-empty line of a task text, trimmed, or `''` when it has none.
 *
 * Exported because a background job's label and a stored patch's task label must read the
 * same line: the job is what the caller watches, and the patch is what outlives it.
 *
 * @param {unknown} text - the task text.
 * @returns {string} its first non-empty line, trimmed.
 */
export function firstTaskLine(text) {
  if (typeof text !== 'string') return ''
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed
  }
  return ''
}

/**
 * The label a stored patch's task record keeps for one task text.
 *
 * A brief is usually a Markdown heading followed by prose; the heading is the label, and
 * its `#` markers are noise on a one-line status, so they are stripped. Exported because a
 * background job's label and a stored patch's task label must be the same words: the job is
 * what the caller watches, and the patch is what outlives it.
 *
 * @param {string} text - the task text actually sent.
 * @param {number} maxChars - how much of the line the record keeps.
 * @returns {string} the label, possibly empty.
 */
export function taskLabel(text, maxChars) {
  return clipText(firstTaskLine(text).replace(/^#+/, '').trim(), maxChars)
}

/**
 * The label a fleet's patch record keeps: its size, then every member's first line.
 *
 * @param {{task: string}[]} tasks - the normalized fleet.
 * @returns {string} the label, at most `BATCH_TASK_LABEL_CHARS` characters.
 */
function batchTaskLabel(tasks) {
  const lines = tasks.map((entry) => taskLabel(entry.task, BATCH_TASK_LABEL_CHARS))
  return clipText(`${String(tasks.length)} tasks: ${lines.join(' | ')}`, BATCH_TASK_LABEL_CHARS)
}

/**
 * The report a fleet's patch keeps: one paragraph per member, in task order.
 *
 * @param {object} result - the fleet result that was just built.
 * @returns {string} the paragraphs, or `''` when no member's entry could be paired.
 */
function batchFinalMessage(result) {
  const entries = Array.isArray(result?.results) ? result.results : []
  return entries
    .map((entry) => `task ${String(entry.index + 1)} (${String(entry.status)}): ${String(entry.result ?? '')}`)
    .join('\n\n')
}

/** Bound a line to a width, without leaving a cut marker behind (unlike `truncateText`). */
function clipText(text, maxChars) {
  return text.length <= maxChars ? text : text.slice(0, maxChars)
}

/** The observation state for one session. */
/**
 * The last sign of life a call has seen: when, which step, and what it was doing.
 * Shared by the observer (which writes it), the progress heartbeat and the idle
 * check (which read it), so all three agree on one clock.
 *
 * Two maps live here as well, because "what is it doing right now" is a question about the
 * call as a whole and not about one event: `openCalls` holds the worker's open tool calls —
 * one per call id, because one session can have two running at once — so a worker stuck in a
 * two-hour build is visible while it is stuck, and `failures` counts failed commands by what
 * was being run, so a command repeated without success is named.
 */
export function createActivity(now = Date.now()) {
  return {
    at: now,
    step: undefined,
    what: 'starting',
    events: 0,
    /**
     * Every open tool call of every worker, keyed by session and call id (see
     * `openCallKey`). A value keeps the session too, so a result without an id can still
     * be matched to the oldest call of its own worker.
     *
     * @type {Map<string, {session: string, id?: string, tool: string, command: string, jobId?: string, background?: boolean, since: number}>}
     */
    openCalls: new Map(),
    /**
     * The background jobs a worker started and has not finished waiting on, keyed by its
     * session and the job id (see `backgroundJobKey`). A job outlives the shell call that
     * started it, so it cannot live in `openCalls`; this is what lets a later `job_output`
     * wait name the command instead of the wait itself.
     *
     * @type {Map<string, {session: string, jobId: string, tool: string, command: string, since: number}>}
     */
    backgroundJobs: new Map(),
    /** How many calls this record has seen, so an id-less call still gets a unique key. */
    callSeq: 0,
    /** @type {Map<string, {count: number, lastAt: number, lastExitCode?: number, lastName?: string}>} */
    failures: new Map(),
  }
}

/**
 * Record one event as activity.
 *
 * @param {object} activity - the call's activity record.
 * @param {object} event - the session event.
 * @param {string} [workerSession] - the worker session the event came from, so open calls
 *   can be tracked per worker. Omitted for the call's own (dispatcher) session: its one
 *   `flash`/`workflow` call stays open for the whole delegation and must never be reported
 *   as the command the worker is running, nor count as a failure.
 * @param {(message: string) => void} [log] - diagnostic sink, for the repeated-failure line.
 * @returns {void}
 */
function touchActivity(activity, event, workerSession, log = () => {}) {
  if (activity === undefined) return
  activity.at = Date.now()
  activity.events += 1
  const step = event?.data?.step
  if (typeof step === 'number') activity.step = step
  const type = String(event?.type ?? '')
  if (type === 'tool/call') {
    const tool = String(event.data?.name ?? '?')
    activity.what = `tool ${tool}`
    noteToolCall(activity, workerSession, tool, event.data?.arguments, toolCallIdOf(event))
  } else if (type === 'tool/result') {
    activity.what = 'reading a tool result'
    noteToolResult(activity, workerSession, event, log)
  } else if (type.startsWith('assistant/') || type.startsWith('llm/')) activity.what = 'model responding'
}

/**
 * The key one open tool call is held under: its worker session and its own call id.
 *
 * A session can have two calls open at once (two `bash` invocations, or `bash` and `read`),
 * so a per-session key let the second overwrite the first and then made the first result
 * delete the second's entry. The session is part of the key rather than the map's value
 * alone so an exact lookup needs no scan.
 *
 * @param {string} session - the worker session.
 * @param {string} id - the tool call id, or the synthetic id a call without one got.
 * @returns {string} the map key.
 */
function openCallKey(session, id) {
  // A NUL cannot appear in either part, so no two pairs can collide.
  return `${session}\u0000${id}`
}

/**
 * The key one background job is held under: its worker session and its job id.
 *
 * The `job` segment keeps a job id from colliding with a tool call id in `openCallKey`'s
 * namespace; a job belongs to the worker that started it, so two workers may both have
 * `bash-2` and must not share an entry.
 *
 * @param {string} session - the worker session.
 * @param {string} jobId - the harness job id, such as `bash-2`.
 * @returns {string} the map key.
 */
function backgroundJobKey(session, jobId) {
  return `${session}\u0000job\u0000${jobId}`
}

/**
 * The job id a `job_output` call names in its arguments.
 *
 * @param {unknown} args - the tool call's arguments, a JSON string in practice.
 * @returns {string | undefined} the job id, or undefined when the call names none.
 */
function jobIdOf(args) {
  const raw = typeof args === 'string' ? args : args === undefined || args === null ? '' : JSON.stringify(args)
  if (raw.length === 0) return undefined
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  return typeof parsed?.job_id === 'string' && parsed.job_id.length > 0 ? parsed.job_id : undefined
}

/**
 * Whether a shell call's arguments asked for it to run in the background.
 *
 * Only a call made with `run_in_background: true` can legitimately answer
 * `started background job <id>`. Reading that sentence from any shell result made a
 * foreground `cat` of a log containing the phrase relabel a worker's job with the `cat`
 * command and restart its clock, so the flag has to come from the call itself.
 *
 * The harness has sent the flag as `"true"` (and `1`) as well as the boolean, so a strict
 * `=== true` check would drop a real background start. The spellings are folded here,
 * before the result is read; `"false"` and `0` are still the foreground case.
 *
 * @param {unknown} args - the tool call's arguments, a JSON string in practice.
 * @returns {boolean} true when the call asked to run in the background.
 */
function shellRunsInBackground(args) {
  const raw = typeof args === 'string' ? args : args === undefined || args === null ? '' : JSON.stringify(args)
  if (raw.length === 0) return false
  let flag
  try {
    flag = JSON.parse(raw)?.run_in_background
  } catch {
    return false
  }
  if (flag === true || flag === 1) return true
  return typeof flag === 'string' && flag.trim().toLowerCase() === 'true'
}

/**
 * The id a tool event carries for the call it opens or closes.
 *
 * Harness names a call in one of a few fields depending on the event: `data.id`,
 * `data.callId` or `data.toolCallId` on `tool/call`, the same on `tool/result` or in the
 * `source`/`tool-result` content blocks (a call id there looks like `call_y7k0qyl9`). Any of
 * them is a stable match; none means the result falls back to the per-session FIFO.
 *
 * @param {object} event - a `tool/call` or `tool/result` event.
 * @returns {string | undefined} the id, when the event carries one.
 */
function toolCallIdOf(event) {
  const data = event?.data
  for (const candidate of [data?.id, data?.callId, data?.toolCallId, data?.call?.id, data?.message?.source?.callId]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return toolCallIdInBlocks(data?.message?.content)
}

/** The call id a tool-result (or tool-call) content block names, walking nested blocks. */
function toolCallIdInBlocks(blocks) {
  if (!Array.isArray(blocks)) return undefined
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    for (const candidate of [block.toolCallId, block.callId]) {
      if (typeof candidate === 'string' && candidate.length > 0) return candidate
    }
    const nested = toolCallIdInBlocks(block.content)
    if (nested !== undefined) return nested
  }
  return undefined
}

/**
 * Remember one open tool call of one worker, from its `tool/call` event.
 *
 * A shell call's command line is what a stalled worker is stuck in, so it is kept nearly
 * whole; any other tool is named with the head of its arguments. The call stays open until
 * the result that answers *that call id* arrives, which is what makes "since when"
 * answerable even while the same worker runs a second call beside it.
 *
 * @param {object} activity - the call's activity record.
 * @param {string} [session] - the worker session the call came from.
 * @param {string} tool - the tool name.
 * @param {unknown} args - the tool call's arguments, a JSON string in practice.
 * @param {string} [id] - the call's own id, when the event carried one.
 * @returns {void}
 */
function noteToolCall(activity, session, tool, args, id) {
  if (typeof session !== 'string' || activity?.openCalls === undefined) return
  // A call without an id still needs its own entry: the second anonymous call of a worker
  // must not overwrite the first, and its result must close exactly one of them.
  const callId = id ?? `#${String((activity.callSeq ?? 0) + 1)}`
  activity.callSeq = (activity.callSeq ?? 0) + 1
  // The wait's own arguments are kept on the call so its result can be tied to the job it
  // names — a `job_output` result may not repeat the id anywhere the result reader sees.
  const jobId = tool === 'job_output' ? jobIdOf(args) : undefined
  // A shell result can only announce a background job when its own call asked for one; the
  // flag is kept here so the result reader never has to trust the result text alone.
  const background = (tool === 'bash' || tool === 'pwsh') && shellRunsInBackground(args)
  activity.openCalls.set(openCallKey(session, callId), {
    session,
    ...(id === undefined ? {} : { id }),
    tool,
    command: describeToolCall(tool, args),
    ...(jobId === undefined ? {} : { jobId }),
    ...(background ? { background: true } : {}),
    since: Date.now(),
  })
}

/**
 * Forget every open tool call of a worker that has ended.
 *
 * A worker cut off mid-call (cancelled, out of budget, its runtime gone) never sends the
 * result that would close its call, and the entry would otherwise stay in `current` for the
 * rest of the job as a command that is still running. Its background jobs are dropped for
 * the same reason: nobody will read their `job_output` status, so a later call must not
 * inherit them as waits in progress.
 *
 * @param {object} activity - the call's activity record.
 * @param {unknown} session - the worker session that ended.
 * @returns {void}
 */
function closeSessionCalls(activity, session) {
  if (typeof session !== 'string' || activity?.openCalls === undefined) return
  for (const [key, call] of activity.openCalls) {
    if (call.session === session) activity.openCalls.delete(key)
  }
  for (const [key, job] of activity.backgroundJobs ?? []) {
    if (job.session === session) activity.backgroundJobs.delete(key)
  }
}

/**
 * Close the open tool call one result answers, and count a failure.
 *
 * The result is matched by its call id when it carries one; without an id (or with an id
 * this record never saw start) the oldest open call of that worker answers it, by tool name
 * when the result names one. Either way exactly one entry is closed: a second open call of
 * the same worker is left alone for its own result, so its failure is counted rather than
 * silently dropped.
 *
 * A shell result is marked with `[exit code: N]`; a non-zero one, or any result carrying
 * `data.error`, is a failed run of that command. Failures are counted per command key (see
 * `failureKey`), and the warning is logged when one key reaches the threshold and at every
 * threshold further failure after that — the log is where a night of unattended work is
 * read afterwards.
 *
 * A shell result may instead say that the command is still going in the background; that
 * job is remembered so a later `job_output` wait can name the command it belongs to. The
 * sentence is only trusted in the two shapes the harness really emits — the whole trimmed
 * first line of a call made with `run_in_background: true`, or a whole
 * `[still running after …ms; moved to background job …]` line — because a foreground
 * `cat` of a log that quotes the phrase must not rewrite the job being read. The wait's
 * own result is then read for a terminal status and for the exit code of the background
 * command, which counts as a failure exactly like a foreground one.
 *
 * @param {object} activity - the call's activity record.
 * @param {string} [session] - the worker session the result came from.
 * @param {object} event - the `tool/result` event.
 * @param {(message: string) => void} log - diagnostic sink.
 * @returns {void}
 */
function noteToolResult(activity, session, event, log) {
  if (typeof session !== 'string' || activity?.openCalls === undefined) return
  const call = closeOpenCall(activity, session, toolCallIdOf(event), event.data?.name ?? event.data?.tool)
  // A result nobody saw start says nothing about which command failed.
  if (call === undefined) return
  const text = toolResultText(event.data?.message)
  // Only a shell result announces a background job; a job's own output could quote the
  // phrase back at us, and must not overwrite the entry it is being read through.
  if (call.tool === 'bash' || call.tool === 'pwsh') noteBackgroundStart(activity, call, text)
  if (call.jobId !== undefined) {
    noteJobOutputResult(activity, call, event, text, log)
    return
  }
  const exitCode = exitCodeOf(text)
  const failure = event.data?.error
  const failed = (failure !== undefined && failure !== null) || (exitCode !== undefined && exitCode !== 0)
  if (!failed) return
  countFailure(activity, call.command, {
    exitCode,
    name: typeof failure?.name === 'string' ? failure.name : undefined,
    log,
  })
}

/**
 * Remember the background job a shell result just announced.
 *
 * The harness says either `started background job <id>` for a call made in the background
 * or `[still running after <ms>ms; moved to background job <id>]` for a foreground call
 * that outlived its timeout. Only those two exact shapes are trusted: the first must be the
 * whole trimmed first line *and* the call must have asked for `run_in_background: true`,
 * the second must be a whole line. A foreground `cat` of a log that happens to contain the
 * phrase therefore cannot relabel the job with the `cat` command. In both cases the command
 * is the one the shell call opened with, and the time it started is that call's own `since`
 * — the job's clock does not restart when a later wait begins.
 *
 * @param {object} activity - the call's activity record.
 * @param {object} call - the shell call the result just closed.
 * @param {string} text - the result's text.
 * @returns {void}
 */
function noteBackgroundStart(activity, call, text) {
  if (typeof text !== 'string' || text.length === 0) return
  if (activity?.backgroundJobs === undefined) return
  const lines = text.split(/\r?\n/)
  let jobId
  if (call.background === true) {
    const match = /^started background job (\S+)$/.exec((lines[0] ?? '').trim())
    if (match !== null) jobId = match[1]
  }
  if (jobId === undefined) {
    for (const line of lines) {
      const match = /^\[still running after \d+ms; moved to background job ([^\]]+)\]$/.exec(line.trim())
      if (match !== null) {
        jobId = match[1].trim()
        break
      }
    }
  }
  if (jobId === undefined || jobId.length === 0) return
  activity.backgroundJobs.set(backgroundJobKey(call.session, jobId), {
    session: call.session,
    jobId,
    tool: call.tool,
    command: call.command,
    since: call.since,
  })
}

/**
 * Read one `job_output` result: forget a finished job, and count a failed exit.
 *
 * The read's text ends with `[status: <status>]`; anything but `running` means the job is
 * over and will never be waited on again, so its entry is dropped. A status naming a
 * non-zero exit code is a failed run of the command that job started, counted under the
 * same folded key a foreground failure uses — a worker that backgrounds a failing build and
 * then polls it is retrying the same step. The job's own output is not searched for an exit
 * code: a successful command may quote one, and only the harness's status line says how
 * the job itself ended. A result with no status at all that is an error, or that says the
 * job is unknown (a job id from another server, say), also forgets the job: it will never
 * produce a status this record can read.
 *
 * @param {object} activity - the call's activity record.
 * @param {object} call - the `job_output` call the result just closed.
 * @param {object} event - the `tool/result` event.
 * @param {string} text - the result's text.
 * @param {(message: string) => void} log - diagnostic sink.
 * @returns {void}
 */
function noteJobOutputResult(activity, call, event, text, log) {
  if (activity?.backgroundJobs === undefined) return
  const key = backgroundJobKey(call.session, call.jobId)
  const status = lastStatusOf(text)
  if (status === undefined) {
    const failure = event.data?.error
    if ((failure !== undefined && failure !== null) || jobLooksUnknown(text)) activity.backgroundJobs.delete(key)
    return
  }
  if (status.trim() === 'running') return
  const job = activity.backgroundJobs.get(key)
  activity.backgroundJobs.delete(key)
  if (job === undefined) return
  // Only the status line speaks for the job. Its output may quote any `exit code: N` —
  // a passing test run that prints the exit code of a deliberately failing child, say —
  // and counting that as the job's own failure warned about a command that succeeded.
  const exitCode = exitCodeInStatus(status)
  if (exitCode === undefined || exitCode === 0) return
  countFailure(activity, job.command, { exitCode, log })
}

/**
 * Whether a `job_output` result without a status says the job does not exist.
 *
 * The server's own unknown-job error says `unknown job "<id>"`; the other shapes are the
 * ways a harness can phrase the same fact. Only read when there is no status, so a real
 * status sentence is never overridden by a word in a job's output.
 *
 * @param {string} text - the result's text.
 * @returns {boolean} true when the text names an unknown job.
 */
function jobLooksUnknown(text) {
  return typeof text === 'string' && /unknown job|no such job|job .* (?:not found|does not exist)/i.test(text)
}

/**
 * The last `[status: …]` a job read carries, which is its current status.
 *
 * @param {string} text - the result's text.
 * @returns {string | undefined} the status, or undefined when the text names none.
 */
function lastStatusOf(text) {
  if (typeof text !== 'string') return undefined
  let status
  for (const match of text.matchAll(/\[status:\s*([^\]]*)\]/g)) status = match[1]
  return status
}

/**
 * The exit code a status line names, when it names one.
 *
 * @param {string} text - the text inside `[status: …]`, never the whole job read.
 * @returns {number | undefined} the code, or undefined when the text carries none.
 */
function exitCodeInStatus(text) {
  const match = /exit code:\s*(-?\d+)/.exec(text)
  return match === null ? undefined : Number(match[1])
}

/**
 * Count one failure of one command, and log the warning at each threshold.
 *
 * Both a foreground result and a background job's terminal read come through here, so a
 * command is warned about the same way whichever way it failed.
 *
 * @param {object} activity - the call's activity record.
 * @param {string} command - the command line that failed.
 * @param {object} options - what the failure was.
 * @param {number | undefined} options.exitCode - the exit code, when there was one.
 * @param {string | undefined} [options.name] - the tool error's name, when there was one.
 * @param {(message: string) => void} options.log - diagnostic sink.
 * @returns {void}
 */
function countFailure(activity, command, { exitCode, name, log }) {
  const key = failureKey(command)
  if (key.length === 0) return
  const record = activity.failures.get(key) ?? { count: 0 }
  record.count += 1
  record.lastAt = Date.now()
  record.lastExitCode = exitCode
  record.lastName = name
  activity.failures.set(key, record)
  if (record.count < REPEATED_FAILURE_THRESHOLD) return
  if (record.count % REPEATED_FAILURE_THRESHOLD !== 0) return
  log(repeatedFailureWarning(key, record, record.lastAt))
}

/**
 * Remove and return the one open call a result answers.
 *
 * @param {object} activity - the call's activity record.
 * @param {string} session - the worker session the result came from.
 * @param {string | undefined} id - the call id the result carries, if any.
 * @param {string | undefined} tool - the tool name the result names, if any.
 * @returns {object | undefined} the closed call, or undefined when none was open.
 */
function closeOpenCall(activity, session, id, tool) {
  if (id !== undefined) {
    const key = openCallKey(session, id)
    const exact = activity.openCalls.get(key)
    if (exact !== undefined) {
      activity.openCalls.delete(key)
      return exact
    }
  }
  // FIFO, restricted to this worker: the oldest call still open is the one that has been
  // running longest, which is the one a result arriving without an id most plausibly answers.
  const first = takeOpenCall(activity, session, tool)
  if (first !== undefined) return first
  // A result that names a tool no open call of this worker has (a rename between the call
  // and its result, say) still closes exactly one call rather than being dropped: the
  // oldest one left is the only candidate.
  return typeof tool === 'string' && tool.length > 0 ? takeOpenCall(activity, session, undefined) : undefined
}

/**
 * Remove and return the oldest open call of one worker, optionally only of one tool.
 *
 * @param {object} activity - the call's activity record.
 * @param {string} session - the worker session.
 * @param {string | undefined} tool - the tool name to match, when one is known.
 * @returns {object | undefined} the closed call, or undefined when none matched.
 */
function takeOpenCall(activity, session, tool) {
  for (const [key, call] of activity.openCalls) {
    if (call.session !== session) continue
    if (typeof tool === 'string' && tool.length > 0 && call.tool !== tool) continue
    activity.openCalls.delete(key)
    return call
  }
  return undefined
}

/**
 * The command line of a shell tool call, read out of its JSON arguments.
 *
 * @param {string} raw - the event's `arguments` field.
 * @returns {string | undefined} the command, or undefined when the arguments are not a
 *   JSON object with a string `command`.
 */
function shellCommandOf(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  return typeof parsed?.command === 'string' ? parsed.command : undefined
}

/**
 * The one-line description of a tool call an activity record keeps.
 *
 * @param {string} tool - the tool name.
 * @param {unknown} args - the event's `arguments` field.
 * @returns {string} a command line for a shell tool, or the tool name plus its arguments.
 */
function describeToolCall(tool, args) {
  const raw = typeof args === 'string' ? args : args === undefined || args === null ? '' : JSON.stringify(args)
  if (tool === 'bash' || tool === 'pwsh') {
    const command = shellCommandOf(raw)
    if (command !== undefined && command.length > 0) return clipText(command, ACTIVITY_COMMAND_CHARS)
  }
  return clipText(raw.length === 0 ? tool : `${tool} ${raw}`, ACTIVITY_TOOL_CHARS)
}

/**
 * The command key failures are counted under.
 *
 * `cd repo && cargo build --release` and `CARGO_X=1 cargo build -p app` are the same step
 * being retried: a leading `cd` only sets the directory and a leading assignment only sets
 * an environment variable, so both are removed, whitespace is collapsed, and the first two
 * words are what is left (`cargo build`, `npm run`).
 *
 * @param {string} command - the command line.
 * @returns {string} the key, or `''` when nothing but setup segments was there.
 */
function failureKey(command) {
  let text = String(command ?? '')
  for (;;) {
    const match = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s&;]+)\s*(?:&&|;)\s*/.exec(text)
    if (match === null) break
    text = text.slice(match[0].length)
  }
  for (;;) {
    const match = /^\s*[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/.exec(text)
    if (match === null) break
    text = text.slice(match[0].length)
  }
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 0)
    .slice(0, 2)
    .join(' ')
}

/** The exit code a shell result is marked with, or undefined when it carries none. */
function exitCodeOf(text) {
  if (typeof text !== 'string') return undefined
  let code
  for (const match of text.matchAll(/\[exit code:\s*(-?\d+)\]/g)) code = Number(match[1])
  return code
}

/**
 * How one failing command is described inside a warning.
 *
 * @param {{lastExitCode?: number, lastName?: string}} record - the failure record.
 * @param {number} now - the clock the "ago" is measured against.
 * @returns {string} `exit code 101, 40s ago`, or the tool error's name.
 */
function failureSummary(record, now) {
  const reason =
    record.lastExitCode !== undefined
      ? `exit code ${String(record.lastExitCode)}`
      : `tool error${record.lastName === undefined ? '' : ` ${record.lastName}`}`
  return `${reason}, ${formatElapsed(now - record.lastAt)} ago`
}

/**
 * The warning that one command keeps failing in this call.
 *
 * The count, the last failure and how long ago it was are all read at render time, so the
 * same record produces a current line in every heartbeat and in the result — the count in
 * the warning never speaks about an earlier moment than the call itself.
 *
 * @param {string} key - the command key.
 * @param {object} record - its failure record.
 * @param {number} now - the clock to measure against.
 * @returns {string} the warning.
 */
function repeatedFailureWarning(key, record, now) {
  return (
    `"${key}" failed ${String(record.count)} times in this call (last: ${failureSummary(record, now)}); ` +
    'a worker repeating a step its sandbox cannot finish keeps its tree busy — check its report or cancel the call'
  )
}

/**
 * Every repeated-failure warning of a call, current as of `now`.
 *
 * @param {object} [activity] - the call's activity record.
 * @param {number} [now] - the clock to measure against.
 * @returns {string[]} the warnings, in the order the commands first failed.
 */
function activityWarnings(activity, now = Date.now()) {
  const warnings = []
  for (const [key, record] of activity?.failures ?? []) {
    if (record.count < REPEATED_FAILURE_THRESHOLD) continue
    warnings.push(repeatedFailureWarning(key, record, now))
  }
  return warnings
}

/**
 * The open tool calls of a call, longest-running first.
 *
 * `since` is an ISO timestamp for a status reader; `runningMs` is what a render needs, and
 * keeping both means no reader has to trust this process's clock twice.
 *
 * A `job_output` call waiting on a job this call started is shown as the command that job
 * is running, from that command's start, with `background` naming the job. Without it the
 * status would say `job_output {…}` for the whole wait and restart its clock at every poll.
 * An unknown job id has no command to show and keeps the ordinary rendering.
 *
 * @param {object} [activity] - the call's activity record.
 * @param {number} [now] - the clock to measure against.
 * @returns {{tool: string, command: string, since: string, runningMs: number, background?: string}[]} the calls.
 */
export function openCommands(activity, now = Date.now()) {
  const current = []
  for (const call of activity?.openCalls?.values() ?? []) {
    const job =
      call.jobId === undefined ? undefined : activity?.backgroundJobs?.get(backgroundJobKey(call.session, call.jobId))
    if (job !== undefined) {
      current.push({
        tool: job.tool,
        command: job.command,
        since: new Date(job.since).toISOString(),
        runningMs: Math.max(0, now - job.since),
        background: job.jobId,
      })
      continue
    }
    current.push({
      tool: call.tool,
      command: call.command,
      since: new Date(call.since).toISOString(),
      runningMs: Math.max(0, now - call.since),
    })
  }
  return current.sort((a, b) => b.runningMs - a.runningMs)
}

/**
 * One line describing the last activity, for heartbeats and stop reasons.
 *
 * The longest-running open command is appended when there is one: a worker that has been
 * inside the same build for four minutes is doing something, and a caller reading "tool
 * bash · last event 2s ago" cannot tell that from a worker making progress.
 */
export function describeActivity(activity, now = Date.now()) {
  if (activity === undefined) return 'no activity recorded'
  // A call waiting for a tree has no session event to report, and saying so is the point:
  // "last event 10m0s ago" for a call that never started reads as a hang. The counts come
  // from the pool at render time when it is still at hand.
  if (activity.queuedSince !== undefined) {
    const inUse = activity.pool?.inUse ?? activity.queuedInUse ?? 0
    const size = activity.pool?.size ?? activity.queuedSize ?? 0
    const counts = `waiting for a free tree (${String(inUse)} of ${String(size)} in use)`
    // A foreground call is holding the caller's whole turn while it waits, and the line is
    // read by that caller: say so, and say how long, instead of leaving it as an ordinary
    // queue line whose only clock is the last-event age.
    if (activity.queuedForeground === true) {
      return `queued in the foreground ${formatElapsed(now - activity.queuedSince)}: ${counts}`
    }
    return `queued ${formatElapsed(now - activity.queuedSince)}: ${counts}`
  }
  const ago = formatElapsed(now - activity.at)
  const step = activity.step === undefined ? '' : `step ${String(activity.step)} · `
  const running = openCommands(activity, now)[0]
  const suffix =
    running === undefined ? '' : `; running "${running.command}" for ${formatElapsed(running.runningMs)}`
  return `${step}${activity.what} · last event ${ago} ago${suffix}`
}

export function createObserveState() {
  return {
    sawRunning: false,
    idle: false,
    status: 'unknown',
    children: [],
    childIds: new Set(),
    // Worker sessions the workflow engine started under a task label, and every
    // worker's parent. Both exist only so a member's tokens can be tied to its task
    // even when its events arrive under its own or a nested session id.
    workflowChildIds: new Set(),
    sessionParents: new Map(),
    childRoutes: new Map(),
    childTimeline: [],
    subagentStarts: 0,
    workflowAgents: new Map(),
    workflowRunId: undefined,
    workflowStopReason: undefined,
    denials: [],
    activeChildren: 0,
    maxParallel: 0,
    workflowText: '',
    parentText: '',
    toolsOffered: [],
    toolCalls: [],
    toolResults: [],
    eventCount: 0,
    usage: createUsageState(),
    activity: undefined,
  }
}

/**
 * One call's token ledger, split by the session that reported it.
 *
 * The Harness can put a `TokenUsage` object on a session event's `data`, and
 * `summarizeEvent` below already notices it — but nothing in this repository fixes
 * which event type carries it, or whether one object is one response or a running
 * total: no fixture emits usage, and the SDK protocol notes here stop at the event
 * names. The assumption, written down so a live run can correct it, is that **one
 * usage object describes one model response**, and that the same response can surface
 * on more than one event (a streaming update and the final message). Usage is
 * therefore counted from `assistant/message` — the only event in this repository that
 * carries a completed model response, which `observe` already reads — and, when an
 * event offers a stable message or response id, from any event type, de-duplicated by
 * that id so a response reported twice is summed once. Counting a *cumulative* usage
 * object this way would overcount, which is exactly the risk this note makes visible.
 *
 * @returns {{seen: Set<string>, bySession: Map<string, object>}} the empty ledger.
 */
function createUsageState() {
  return { seen: new Set(), bySession: new Map() }
}

/** One session's slice of the ledger; `everyTotal` tracks the reported-total contract. */
function createUsageBucket() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokensReported: 0,
    modelCalls: 0,
    sawCacheRead: false,
    sawCacheWrite: false,
    sawReasoning: false,
    everyTotal: true,
  }
}

/** A token field, only when the event really carried a count. */
function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Fold one response's usage object into a bucket. */
function addUsage(bucket, usage) {
  const input = tokenCount(usage.inputTokens)
  const output = tokenCount(usage.outputTokens)
  // "no recognised field" is not "zero tokens": a usage object with neither inputTokens nor
  // outputTokens (an empty `{}`, or a provider spelling this service does not know such as
  // `promptTokens`) says nothing about a response, so counting it as one model call would
  // report "unknown" as a confident zero.
  if (input === undefined && output === undefined) return
  const total = tokenCount(usage.totalTokens)
  const cacheRead = tokenCount(usage.cacheReadTokens)
  const cacheWrite = tokenCount(usage.cacheWriteTokens)
  const reasoning = tokenCount(usage.reasoningTokens)
  if (input !== undefined) bucket.inputTokens += input
  if (output !== undefined) bucket.outputTokens += output
  if (cacheRead !== undefined) {
    bucket.cacheReadTokens += cacheRead
    bucket.sawCacheRead = true
  }
  if (cacheWrite !== undefined) {
    bucket.cacheWriteTokens += cacheWrite
    bucket.sawCacheWrite = true
  }
  if (reasoning !== undefined) {
    bucket.reasoningTokens += reasoning
    bucket.sawReasoning = true
  }
  // The provider's own total is reported only when *every* counted response carried
  // one; a mix of totals and partials would otherwise quietly understate the call.
  if (total === undefined) bucket.everyTotal = false
  else bucket.totalTokensReported += total
  bucket.modelCalls += 1
}

/** Sum several sessions' buckets into one, preserving the reported-total contract. */
function mergeUsageBuckets(buckets) {
  const merged = createUsageBucket()
  for (const bucket of buckets) {
    merged.inputTokens += bucket.inputTokens
    merged.outputTokens += bucket.outputTokens
    merged.cacheReadTokens += bucket.cacheReadTokens
    merged.cacheWriteTokens += bucket.cacheWriteTokens
    merged.reasoningTokens += bucket.reasoningTokens
    merged.totalTokensReported += bucket.totalTokensReported
    merged.modelCalls += bucket.modelCalls
    merged.sawCacheRead = merged.sawCacheRead || bucket.sawCacheRead
    merged.sawCacheWrite = merged.sawCacheWrite || bucket.sawCacheWrite
    merged.sawReasoning = merged.sawReasoning || bucket.sawReasoning
    merged.everyTotal = merged.everyTotal && bucket.everyTotal
  }
  return merged
}

/**
 * The public shape of a ledger slice, or undefined when nothing was reported. A call
 * with no usage must not claim zero tokens: "unknown" and "free" are not the same
 * answer, and a caller weighing delegation needs to tell them apart.
 */
function usageOf(bucket) {
  if (bucket.modelCalls === 0) return undefined
  return {
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    totalTokens: bucket.everyTotal ? bucket.totalTokensReported : bucket.inputTokens + bucket.outputTokens,
    modelCalls: bucket.modelCalls,
    ...(bucket.sawCacheRead ? { cacheReadTokens: bucket.cacheReadTokens } : {}),
    ...(bucket.sawCacheWrite ? { cacheWriteTokens: bucket.cacheWriteTokens } : {}),
    ...(bucket.sawReasoning ? { reasoningTokens: bucket.reasoningTokens } : {}),
  }
}

/** The call's whole ledger, orchestrator and every worker it started. */
function usageTotal(state) {
  return usageOf(mergeUsageBuckets([...state.usage.bySession.values()]))
}

/** The token totals appended to the line a finished call logs, or nothing when none arrived. */
function usageLogSuffix(usage) {
  if (usage === undefined) return ''
  return ` (${String(usage.inputTokens)} in / ${String(usage.outputTokens)} out tokens, ${String(usage.modelCalls)} model call(s))`
}

/**
 * The stable id a usage-bearing event offers, if any. Only fields that name a
 * *response* qualify: `step` and `seq` advance per event, so using them would make
 * every update of one response look like a new model call.
 */
function usageResponseId(event) {
  const data = event?.data
  for (const candidate of [
    data?.message?.id,
    data?.message?.messageId,
    data?.messageId,
    data?.responseId,
    data?.usage?.id,
    data?.usage?.messageId,
    data?.usage?.responseId,
  ]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/** Count one event's usage, unless the same response was already counted. */
function recordUsage(state, session, event) {
  const usage = event?.data?.usage
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return
  const id = usageResponseId(event)
  if (id !== undefined) {
    if (state.usage.seen.has(id)) return
    state.usage.seen.add(id)
  } else if (event?.type !== 'assistant/message') {
    // No stable id and not the completed-assistant-message marker: assume this is an
    // update of a response a later event will report too, and do not count it.
    return
  }
  let bucket = state.usage.bySession.get(session)
  if (bucket === undefined) {
    bucket = createUsageBucket()
    state.usage.bySession.set(session, bucket)
  }
  addUsage(bucket, usage)
}

/** Whether a session belongs to this call: its own, a worker's, or a worker's child. */
function sessionInCall(state, session, sessionId) {
  if (typeof session !== 'string') return false
  let current = session
  for (let hop = 0; hop <= state.sessionParents.size; hop += 1) {
    if (current === sessionId || state.childIds.has(current) || state.workflowChildIds.has(current)) return true
    const parent = state.sessionParents.get(current)
    if (parent === undefined) return false
    current = parent
  }
  return false
}

/** Whether `session` is `root` itself or one of its descendants. */
function descendsFrom(state, session, root) {
  let current = session
  for (let hop = 0; hop <= state.sessionParents.size; hop += 1) {
    if (current === root) return true
    const parent = state.sessionParents.get(current)
    if (parent === undefined) return false
    current = parent
  }
  return false
}

/** Collect one session's progress from runtime notifications. */
export function observe(state, method, params, sessionId, completion, log) {
  if (method === 'session.status') {
    if (params?.sessionId !== sessionId) return
    state.status = String(params.status)
    if (state.status === 'running') state.sawRunning = true
    if (state.status === 'idle' && state.sawRunning) {
      // The call is over, so this is the one line it logs: the caller reading the
      // service log learns what it spent alongside what it got. The fleet's ledger is
      // complete here because every worker has finished before its run does.
      log(`session ${state.status}${usageLogSuffix(usageTotal(state))}`)
      completion.resolve()
      return
    }
    log(`session ${state.status}`)
    return
  }
  if (method === 'subagent.started') {
    // Recorded for every start, even one this call did not initiate: a worker can
    // itself be the parent of a nested worker, and its tokens still belong to the task.
    if (typeof params?.childSessionId === 'string' && typeof params?.parentSessionId === 'string') {
      state.sessionParents.set(params.childSessionId, params.parentSessionId)
    }
    if (params?.parentSessionId !== sessionId) return
    touchActivity(state.activity, { type: 'subagent/started' }, String(params.childSessionId ?? ''), log)
    state.subagentStarts += 1
    // Overlap is counted in notification order, not from timestamps: the runtime
    // can report several starts inside one millisecond, and concurrent workers
    // must still be visible as concurrent.
    state.activeChildren += 1
    if (state.activeChildren > state.maxParallel) state.maxParallel = state.activeChildren
    const startedAt = Date.now()
    if (typeof params.childSessionId === 'string') {
      state.childIds.add(params.childSessionId)
      state.childTimeline.push({ childSessionId: params.childSessionId, startedAt, finishedAt: undefined })
    }
    log(`child started: ${String(params.childSessionId)}`)
    return
  }
  if (method === 'subagent.finished') {
    if (params?.parentSessionId !== sessionId) return
    state.activeChildren = Math.max(0, state.activeChildren - 1)
    const finishedAt = Date.now()
    const open = state.childTimeline.find(
      (entry) => entry.childSessionId === params.childSessionId && entry.finishedAt === undefined,
    )
    if (open !== undefined) open.finishedAt = finishedAt
    closeSessionCalls(state.activity, params.childSessionId)
    if (typeof params.childSessionId === 'string') state.childIds.add(params.childSessionId)
    state.children.push({
      status: String(params.status),
      stopReason: String(params.stopReason),
      provider: String(params.provider),
      childSessionId: String(params.childSessionId),
      result: textOfContentBlocks(params.lastAssistantMessage),
      resultTruncated: false,
    })
    log(`child finished: ${String(params.status)}/${String(params.stopReason)} on ${String(params.provider)}`)
    return
  }
  if (method !== 'session.event') return
  const session = params?.sessionId
  const event = params?.event
  // Any event from this session or one of its workers is a sign of life, and a worker's
  // tool calls are tracked per session so the call can say what each one is running.
  //
  // The call's own session is the dispatcher: it calls `flash` (or `workflow` for a fleet)
  // exactly once, and that call stays open for the whole delegation. Counting it would make
  // the dispatch itself the longest-running "command" of every call, so its events still
  // move `at`/`step`/`what` but never own an open call or a failure. Workers are found with
  // `sessionInCall`, not `childIds`: a fleet member may be known only through its
  // `tool-workflow/agent-start`, and that member's commands belong to the call too.
  const inCall = sessionInCall(state, session, sessionId)
  if (inCall) touchActivity(state.activity, event, session === sessionId ? undefined : session, log)
  // Usage can ride on any event of the call; the ledger keeps it per session so a
  // fleet can later attribute it to the task whose worker reported it.
  if (inCall) recordUsage(state, session, event)
  if (event?.type === 'request/header' && state.childIds.has(session)) {
    // Harness logs the exact call configuration of every request; this is the
    // child's real route, observed rather than assumed.
    const config = event.data?.header?.config
    if (config !== undefined && config !== null) {
      state.childRoutes.set(session, { provider: String(config.provider), model: String(config.model) })
      log(`child route: ${String(config.provider)}/${String(config.model)}`)
    }
    return
  }
  if (state.childIds.has(session)) {
    // A worker's refused tool call is evidence about the wall, and the wall's own
    // error code survives into its tool result. Collected here so the caller
    // learns *why* a member could not do something, not just that it failed.
    if (event?.type === 'tool/result') {
      // A session event's failure identity is `{name, code}`; the model-facing
      // text carries the detail. The guard's reason survives there, in the
      // parenthesized token its own message format fixes.
      const failure = event.data?.error
      const code = typeof failure?.code === 'string' ? failure.code : undefined
      const message = toolResultText(event.data?.message)
      const refusal = code !== undefined || /denied under|not permitted|flash-guard denied/i.test(message)
      if (refusal) {
        const reason = code === 'FLASH_GUARD_DENIED' ? /\(([A-Z_]+)\)/.exec(message)?.[1] : undefined
        state.denials.push({
          childSessionId: String(session),
          code: code ?? (typeof failure?.name === 'string' ? failure.name : 'TOOL_ERROR'),
          ...(reason === undefined ? {} : { reason }),
          message: message.slice(0, 400),
        })
        // The reason and the start of the message go into the log as well: the result
        // carries them too, but a call that times out never produces a result, and the
        // log is then the only record of what the worker was refused.
        const excerpt = message.slice(0, 200).replace(/\s+/g, ' ')
        log(`worker refusal: ${code ?? 'tool error'}${reason === undefined ? '' : ` (${reason})`}${excerpt === '' ? '' : `: ${excerpt}`}`)
      }
    }
    return
  }
  // One bounded trace of the orchestrator's own turn: enough to explain a
  // dispatch that never happened, without ever returning a transcript.
  state.eventCount += 1
  if (state.eventCount <= TRACE_EVENTS) {
    log(`event#${String(state.eventCount)} ${String(event?.type)} ${summarizeEvent(event)}`)
  } else if (state.eventCount === TRACE_EVENTS + 1) {
    log(`event trace truncated after ${String(TRACE_EVENTS)} entries`)
  }
  if (event?.type === 'request/header') {
    const tools = event.data?.header?.tools
    state.toolsOffered = Array.isArray(tools) ? tools.map((tool) => String(tool?.name)) : []
  }
  // Notifications are broadcast to every observer sharing a runtime, so a concurrent call's
  // members arrive here too. Only a session this call owns — its own, a worker's, or a
  // worker's child — may contribute: accepting another call's agent-start would put its child
  // in this call's `workflowChildIds`, and `sessionInCall` would then count that call's tokens
  // as this one's. `inCall` is the same answer computed above; nothing since then changed
  // which sessions belong to the call.
  const mine = inCall
  if (mine && event?.type === 'tool-workflow/agent-start') {
    // The engine reports the label this service generated for each member, which
    // is what makes a per-task pairing possible without guessing; the child session
    // it names is also how that member's tokens are reached.
    const label = event.data?.label
    if (typeof label === 'string') {
      state.workflowAgents.set(label, { childId: event.data?.childId, outcome: undefined, seq: event.data?.seq })
    }
    if (typeof event.data?.childId === 'string') state.workflowChildIds.add(event.data.childId)
  }
  if (mine && event?.type === 'tool-workflow/agent-end') {
    const seq = event.data?.seq
    const agent = [...state.workflowAgents.values()].find((entry) => entry.seq === seq)
    if (agent !== undefined) agent.outcome = event.data?.outcome
    else state.workflowAgents.set(`seq-${String(seq)}`, { childId: undefined, outcome: event.data?.outcome, seq })
    // A fleet member that ended mid-call leaves no result behind to close it.
    closeSessionCalls(state.activity, agent?.childId)
  }
  if (event?.type === 'tool-workflow/run-start' || event?.type === 'tool-workflow/run-end') {
    if (typeof event.data?.runId === 'string') state.workflowRunId = event.data.runId
  }
  if (event?.type === 'tool-workflow/run-end') {
    state.workflowStopReason = String(event.data?.stopReason)
  }
  if (event?.type === 'tool/call') {
    state.toolCalls.push(`${String(event.data?.name)}(${truncateText(String(event.data?.arguments ?? ''), 160)})`)
  }
  if (event?.type === 'tool/result') {
    const error = event.data?.error
    const text = toolResultText(event.data?.message)
    // The one structured payload the fleet depends on: the workflow tool renders
    // its validated output envelope as text, and that text is authoritative for
    // the per-task pairing. Bounded, and never returned to the caller verbatim.
    if (looksLikeWorkflowResult(text)) state.workflowText = text.slice(0, WORKFLOW_TEXT_LIMIT)
    state.toolResults.push(`${error === undefined ? 'ok' : `${String(error.name)}/${String(error.code)}`}: ${truncateText(text, 160)}`)
  }
  if (event?.type === 'assistant/message') {
    const text = textOfContentBlocks(event.data?.message?.content)
    if (text.length > 0) state.parentText = text
  }
}

/** A compact, value-bearing rendering of one session event. */
function summarizeEvent(event) {
  const data = event?.data ?? {}
  const parts = []
  if (typeof event?.data?.reason === 'string') parts.push(`reason=${event.data.reason}`)
  if (data.message !== undefined) {
    const text = textOfContentBlocks(data.message?.content)
    if (text.length > 0) parts.push(`text=${JSON.stringify(truncateText(text, 200))}`)
    const calls = Array.isArray(data.message?.content)
      ? data.message.content.filter((block) => block?.type === 'tool-call' || block?.type === 'tool_use')
      : []
    for (const call of calls) parts.push(`call=${JSON.stringify(call)}`)
  }
  if (data.error !== undefined) parts.push(`error=${JSON.stringify(data.error).slice(0, 200)}`)
  if (data.stopReason !== undefined) parts.push(`stopReason=${String(data.stopReason)}`)
  if (data.usage !== undefined) parts.push('usage')
  if (parts.length === 0) parts.push(JSON.stringify(data).slice(0, 200))
  return parts.join(' ')
}

function truncateText(text, maxChars) {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`
}

/**
 * Report a running call to the MCP client until the returned stop function is called.
 *
 * MCP makes a progress notification valid only when the request carried a
 * `_meta.progressToken`, so a call without one gets no timer and sends nothing;
 * a notification without the token would be a protocol error, not a heartbeat.
 * The token belongs to the client and is carried back by the MCP layer's sender
 * (`sendProgress`); this helper only supplies the elapsed seconds, the budget in
 * seconds when one is known, and a short human message.
 *
 * @param {object} options - progress wiring.
 * @param {(report: object) => void} [options.progress] - MCP notification sender.
 * @param {unknown} options.token - the request's progress token, when it had one.
 * @param {string} options.label - the tool name, for the message.
 * @param {string} options.sessionId - the worker session the call is waiting on.
 * @param {number} [options.budgetMs] - the call's wall-clock budget, when known.
 * @param {number} options.intervalMs - how often to report.
 * @param {(message: string) => void} [options.log] - diagnostic sink.
 * @returns {() => void} stops the reporting.
 */
function startProgress({ progress, token, label, sessionId, budgetMs, intervalMs, activity, log = () => {} }) {
  if (token === undefined || token === null || typeof progress !== 'function') return () => {}
  const startedAt = Date.now()
  const timer = setInterval(() => {
    try {
      const now = Date.now()
      const elapsedMs = now - startedAt
      // The session id comes from the activity record, not this closure: a retried first
      // attempt runs under a new session, and the heartbeat must name the live one.
      const current = activity?.sessionId ?? sessionId
      progress({
        progress: Math.round(elapsedMs) / 1000,
        ...(budgetMs === undefined || budgetMs === null ? {} : { total: Math.round(budgetMs / 1000) }),
        message: `${label} running ${formatElapsed(elapsedMs)}; ${describeActivity(activity, now)} (session ${current})`,
        // Structured, for a status reader rather than a client: which commands are open and
        // which keep failing. `mcp.js` forwards only progress/total/message, so this never
        // reaches the MCP wire (a test pins that).
        detail: { current: openCommands(activity, now), warnings: activityWarnings(activity, now) },
      })
    } catch (error) {
      // A client that has gone away must not turn a heartbeat into a task failure.
      log(`could not send a progress notification: ${messageOf(error)}`)
    }
  }, intervalMs)
  // The heartbeat must never be the only thing keeping the process alive.
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Render elapsed milliseconds as a compact span, e.g. `4m20s`. */
function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes === 0 ? `${String(seconds)}s` : `${String(minutes)}m${String(seconds % 60)}s`
}

/** Wait for completion, bounded by the task budget and the client's signal. */
export function raceWithBudget(promise, { timeoutMs, idleTimeoutMs, activity, label, signal, sessionId, diagnostics }) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(idleTimer)
      signal?.removeEventListener('abort', onAbort)
      fn(value)
    }
    const timer = setTimeout(() => {
      // The SDK protocol has no cancel method: the session keeps running inside
      // Harness and its later notifications are ignored.
      finish(
        reject,
        new FlashTaskError(
          `${String(label)} exceeded its ${String(timeoutMs)}ms budget on session ${sessionId} (${describeActivity(activity)}); the session continues inside Harness but is no longer reported${stderrHint(diagnostics)}`,
          'TIMEOUT',
        ),
      )
    }, timeoutMs)
    // Stuck, not slow: no event from the session or any worker for the idle window.
    const idleTimer = idleTimeoutMs > 0 && activity !== undefined
      ? setInterval(() => {
          if (Date.now() - activity.at < idleTimeoutMs) return
          finish(
            reject,
            new FlashTaskError(
              `${String(label)} stopped: no activity for ${formatElapsed(idleTimeoutMs)} on session ${sessionId} (${describeActivity(activity)}); the session continues inside Harness but is no longer reported${stderrHint(diagnostics)}`,
              'IDLE',
            ),
          )
        }, Math.min(IDLE_CHECK_INTERVAL_MS, Math.max(1, idleTimeoutMs)))
      : undefined
    idleTimer?.unref?.()
    const onAbort = () => finish(reject, new FlashTaskCancelled(`${String(label)} was cancelled by the client`))
    if (signal?.aborted === true) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(() => finish(resolve), (error) => finish(reject, error))
  })
}

/** The dispatch prompt: one delegation, no freedom to improvise. */
export function buildOrchestrationPrompt(childPrompt) {
  return [
    'You are a dispatcher. Do exactly one thing and nothing else.',
    '',
    'Call the `flash` tool exactly once:',
    '- description: a 3-5 word description of the work',
    '- prompt: the task text between the markers below, copied verbatim',
    '',
    'Rules:',
    '- Do not attempt the task yourself.',
    '- Do not call any other tool.',
    '- Do not call `flash` a second time, even if the result looks incomplete.',
    '- When `flash` returns, reply with exactly: DELEGATED',
    '',
    'Task text to pass as `prompt`:',
    '<<<TASK',
    childPrompt,
    'TASK',
  ].join('\n')
}

/**
 * The fleet dispatch prompt. The dispatcher relays a constant script and a plain
 * data payload, so the fan-out shape is ours and only the copying is the model's.
 */
export function buildBatchPrompt({ count, script, args }) {
  return [
    'You are a dispatcher. Do exactly one thing and nothing else.',
    '',
    'Call the `workflow` tool exactly once, with these three arguments:',
    '- meta: the JSON between the <meta> markers, passed as a JSON OBJECT',
    '- script: the text between the <script> markers, passed as a STRING, character for character',
    '- args: the JSON between the <args> markers, passed as a JSON OBJECT',
    '',
    'Rules:',
    '- `meta` and `args` are objects, not text: pass them as JSON values, never wrapped in',
    '  quotes or escaped, and `args.items` must arrive as an array. A stringified `args` is',
    '  rejected by the tool and the fleet then never starts.',
    '- Do not attempt any of the work yourself.',
    '- Do not call any other tool, and do not call `workflow` a second time.',
    '- Do not edit, reformat, shorten, or re-encode the script or the args.',
    '- When `workflow` returns, reply with exactly: DELEGATED',
    '',
    'The script starts one worker per entry in args.items.',
    '',
    '<meta>',
    JSON.stringify({ name: 'flash-batch', description: `${String(count)} delegated worker tasks` }),
    '</meta>',
    '',
    '<script>',
    script,
    '</script>',
    '',
    '<args>',
    JSON.stringify(args),
    '</args>',
  ].join('\n')
}

/**
 * Refuse a per-item `model` in a fleet, before anything reads the item's task text.
 *
 * One fleet is one dsh process, which runs one model for its dispatcher and every worker: a
 * per-item model could not be honoured, so it is refused rather than ignored. Shared with
 * `FlashTaskService.checkModel`, so the background door refuses exactly what `flashBatch`
 * would, and neither message can drift from the other.
 *
 * @param {unknown} entry - one `tasks` entry.
 * @param {number} index - its position, for the error.
 * @returns {void}
 * @throws {FlashTaskError} `INVALID_ARGUMENT` when the entry names a model.
 */
function refuseItemModel(entry, index) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return
  if (entry.model === undefined) return
  throw new FlashTaskError(
    `tasks[${String(index)}] carries "model"; the model is chosen per fleet: pass "model" at ` +
      'the top level of flash_batch, not inside a task',
    'INVALID_ARGUMENT',
  )
}

/**
 * Validate and normalize the fleet's task list.
 *
 * An entry is a task string, or an object carrying its text either inline (`task`) or in a
 * file (`taskFile`), plus optional acceptance criteria. A `model` inside an entry is
 * refused: the fleet is one dsh process, so one model serves the dispatcher and every
 * member, and only the call's top level may choose it. Reading a task file is the
 * caller's job — the service owns the fence around its root — so the reader is passed in;
 * the errors for the string and inline `task` forms are unchanged.
 *
 * @param {unknown} tasks - the raw `tasks` argument.
 * @param {number} maxTasks - ceiling on tasks in one call.
 * @param {object} [options] - task-file wiring.
 * @param {(value: unknown, field: string) => string} [options.readTaskFile] - reads one brief.
 * @returns {Array<{task: string, acceptance: string | undefined}>} the normalized tasks.
 */
export function normalizeTasks(tasks, maxTasks, { readTaskFile } = {}) {
  if (!Array.isArray(tasks)) {
    throw new FlashTaskError('tasks must be an array', 'INVALID_ARGUMENT')
  }
  if (tasks.length === 0) {
    throw new FlashTaskError('tasks must contain at least one task', 'INVALID_ARGUMENT')
  }
  if (tasks.length > maxTasks) {
    throw new FlashTaskError(
      `tasks carries ${String(tasks.length)} items; this service accepts at most ${String(maxTasks)} per call`,
      'INVALID_ARGUMENT',
    )
  }
  const read = readTaskFile ?? (() => {
    throw new FlashTaskError('taskFile is not readable in this context', 'INVALID_ARGUMENT')
  })
  return tasks.map((entry, index) => {
    if (typeof entry === 'string') return { task: requireText(entry, `tasks[${String(index)}]`), acceptance: undefined }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new FlashTaskError(
        `tasks[${String(index)}] must be a string or an object with a "task" field`,
        'INVALID_ARGUMENT',
      )
    }
    refuseItemModel(entry, index)
    const hasTask = entry.task !== undefined && entry.task !== null
    const hasFile = entry.taskFile !== undefined && entry.taskFile !== null
    if (hasTask && hasFile) {
      throw new FlashTaskError(
        `tasks[${String(index)}] carries both "task" and "taskFile"; pass exactly one of them`,
        'INVALID_ARGUMENT',
      )
    }
    if (hasFile) {
      return {
        task: read(entry.taskFile, `tasks[${String(index)}].taskFile`),
        acceptance: optionalText(entry.acceptance),
      }
    }
    return {
      task: requireText(entry.task, `tasks[${String(index)}].task`),
      acceptance: optionalText(entry.acceptance),
    }
  })
}

/** Per-task fields the engine's own member records can supply. */
function memberFields(member, childById) {
  if (member === undefined) return {}
  const childSessionId = member.childId === undefined ? undefined : String(member.childId)
  const child = childSessionId === undefined ? undefined : childById.get(childSessionId)
  return {
    ...(member.outcome === undefined ? {} : { outcome: member.outcome }),
    ...(childSessionId === undefined ? {} : { childSessionId }),
    ...(child === undefined ? {} : { stopReason: child.stopReason, provider: child.provider }),
  }
}

/** Recognise the workflow tool's rendered result envelope. */
export function looksLikeWorkflowResult(text) {
  return typeof text === 'string' && text.startsWith('workflow "') && text.includes(WORKFLOW_VALUE_MARKER)
}

/**
 * Read the workflow tool's return value out of its rendered result.
 *
 * The renderer prints the script's own final value after the marker — for a
 * fleet that is the ordered entry array — while the run identity and the child
 * count live in the header line and in the run's session events.
 *
 * @returns {{value?: unknown, error?: string}} the value, or why it is unreadable.
 */
export function extractWorkflowValue(text) {
  if (typeof text !== 'string' || text.length === 0) return { error: 'the workflow tool returned no result text' }
  const marker = text.lastIndexOf(WORKFLOW_VALUE_MARKER)
  if (marker < 0) return { error: 'the workflow result carried no return value' }
  const json = text.slice(marker + WORKFLOW_VALUE_MARKER.length).trim()
  if (json.length === 0) return { error: 'the workflow return value was empty' }
  try {
    return { value: JSON.parse(json) }
  } catch (error) {
    return { error: `the workflow return value was not readable JSON (${messageOf(error)})` }
  }
}

/** Read the rendered header line: the workflow's name and its child count. */
export function parseWorkflowHeader(text) {
  if (typeof text !== 'string') return {}
  const match = /^workflow "([^"]*)" completed \((\d+) agents?\)/.exec(text)
  if (match === null) return {}
  return { name: match[1], agentsStarted: Number(match[2]) }
}

/**
 * Routing is not a caller capability; never forward a selection field.
 *
 * `model` is deliberately absent: a call may choose one from the user's allowlist. The
 * provider is still fixed, so a `provider` argument is only logged.
 */
function warnAboutIgnoredArguments(args, toolName, log) {
  for (const ignored of ['provider', 'reasoningEffort', 'agentOptions', 'permissions', 'sandbox']) {
    if (args?.[ignored] !== undefined) log(`ignoring unsupported ${toolName} argument "${ignored}"`)
  }
}

/**
 * The instructions every worker carries, isolated or not.
 *
 * A commit hides the work from the service: the patch is read from the working tree, so a
 * committed change reads as unrelated or as nothing at all. An escape hatch — unsafe code, a
 * lint silenced instead of fixed, a test weakened so it passes — is exactly the kind of thing
 * a later reader cannot see from the diff, so naming it in the final report is the only place
 * it survives. Three more exist because the caller reads the report, not the transcript: a
 * deviation from the named interface is invisible unless it is said first, a contract that
 * looks wrong is the caller's decision rather than something to route around, and a task
 * abandoned halfway must say so before its partial result is mistaken for a whole one. The
 * last three cover what a diff cannot show either: a command whose exit code was hidden, a
 * feature removed without a word, and a file changed outside the task's list.
 */
export const WORKER_INSTRUCTIONS = [
  'Do not commit unless the task explicitly asks: the service reads the change from the working tree, and a commit only confuses the report.',
  'If the work reaches for an escape hatch (unsafe code, a disabled or suppressed check or lint, a skipped or weakened test), name each one in the final report with the reason.',
  'If you build a different interface or structure than the task names (another signature, the logic split across several places instead of one, a different data shape), say so first in your final report, with the reason.',
  "If the task's contract or design looks wrong, report it rather than quietly working around it.",
  'If you stop before the task is done, start your final report with why you stopped (for example: the context is full, a blocker, a test you could not make pass) and what is left.',
  'If a check the task asks for cannot run here (an end-to-end run, a service, a step the sandbox blocks), still write the code and the tests the task asks for, and name each check you could not run and why, so the caller can run it.',
  'If the same build or command fails the same way twice, do not keep retrying it: report the error and what it would need.',
  'Before adding a name with global reach (a global CSS class, a global variable, a route, an environment variable, a config key), search the code for it; if it already means something else, choose another and say so.',
  'Run a command bare so its exit code shows; do not hide it behind `; echo` or `|| true`, which makes a failing command look like a success.',
  'In the report, list anything you removed or left out that existed before (a menu item, an option, a test, a check), each with why.',
  'In the report, name every file you changed outside the files the task named, and why.',
]

/** How many of the copy's uncommitted paths are worth naming in the prompt. */
const PROMPT_UNCOMMITTED_LIMIT = 20

/** How many files the base-patch paragraph names on its one line. */
const PROMPT_BASE_PATCH_LIMIT = 20

/**
 * What a `discard` call tells its worker about scratch space. The usual ending says the
 * scratch directory is left out of the reported change; under `discard` there is no report
 * and no patch, so a worker that "saves" a finding there loses it when the copy is deleted
 * — which is what happened to a review that named a `.flash-tmp` patch file that never
 * survived the call.
 */
const DISCARD_SCRATCH =
  'This call keeps nothing: the copy, ./.flash-tmp/ included, is deleted when you finish, and no patch is stored. ' +
  'Anything that matters — a test that proves a finding, a proposed fix — must be written out in full in your final message (a fix as a unified diff).'

/**
 * The base-patch facts the worker prompt names: which patch, what it changed, and whether it
 * landed cleanly. Deliberately smaller than the result's field — a worker has no use for the
 * merge mode, and the sentence it reads is built from these three.
 *
 * @param {object} basePatch - what `applyBasePatch` planted in the copy.
 * @returns {{patchId: string, filesChanged: string[], conflicts: string[]}} the prompt facts.
 */
function promptBasePatch(basePatch) {
  return { patchId: basePatch.patchId, filesChanged: basePatch.filesChanged ?? [], conflicts: basePatch.conflicts ?? [] }
}

/** The worker-facing task text. */
export function buildChildPrompt({ cwd, task, acceptance, copy, uncommitted, slotEnv, slotPorts, slotValues, slotSetup, discard, basePatch }) {
  const started = Number(uncommitted?.count) > 0
  const startedFiles = started ? (uncommitted.files ?? []).slice(0, PROMPT_UNCOMMITTED_LIMIT) : []
  const allEnvNames = slotEnv === undefined || slotEnv === null ? [] : Object.keys(slotEnv)
  // A `port:` entry holds a number and a `value:` entry holds plain text, not a directory:
  // the worker would look for a path if either were named in the directories' sentence.
  // Only the names this call actually set count.
  const portNames = (Array.isArray(slotPorts) ? slotPorts : []).filter((name) => allEnvNames.includes(name))
  const valueNames = (Array.isArray(slotValues) ? slotValues : []).filter((name) => allEnvNames.includes(name))
  const envNames = allEnvNames.filter((name) => !portNames.includes(name) && !valueNames.includes(name))
  const setupSteps = Array.isArray(slotSetup) ? slotSetup : []
  // A call that continues from an earlier patch starts on top of that change: the worker must
  // not redo it, and must resolve it first when the copy holds conflict markers instead.
  const baseFiles = basePatch === undefined || basePatch === null ? [] : (basePatch.filesChanged ?? []).slice(0, PROMPT_BASE_PATCH_LIMIT)
  const baseConflicts = basePatch === undefined || basePatch === null ? [] : (basePatch.conflicts ?? [])
  return [
    `Working directory: ${cwd}`,
    '',
    ...WORKER_INSTRUCTIONS,
    ...(copy === true
      ? [
          '',
          "This working directory is a disposable copy of the caller's repository, so its files are here at the same relative paths.",
          'Use relative paths: a path naming the original repository refers to a different directory that you cannot write, and',
          'anything outside this copy is discarded — only the change you leave here is reported back.',
          'Scratch files of your own (downloads, throwaway output, notes to yourself) go under ./.flash-tmp/ in this copy;',
          ...(discard === true
            ? ['it already exists.', DISCARD_SCRATCH]
            : ['it already exists and is left out of the reported change.']),
        ]
      : []),
    ...(started
      ? [
          '',
          `The copy started with ${String(uncommitted.count)} uncommitted change(s) from the caller's working tree` +
            `${startedFiles.length < uncommitted.count ? ` (first ${String(startedFiles.length)}):` : ':'}`,
          ...startedFiles.map((file) => `- ${file}`),
          "They are the caller's work in progress, not yours: git status shows them exactly as the caller left them (staged only where the caller staged them). Leave them alone unless the task is about them.",
        ]
      : []),
    ...(basePatch === undefined || basePatch === null
      ? []
      : [
          '',
          `The copy already contains the change from an earlier call (patch ${basePatch.patchId}), applied before you started: ${baseFiles.join(', ')}. Continue from it; do not redo it.`,
          ...(baseConflicts.length === 0 ? [] : [`It did not apply cleanly: ${baseConflicts.join(', ')} hold conflict markers. Resolve them first.`]),
        ]),
    ...(envNames.length === 0 && portNames.length === 0 && valueNames.length === 0
      ? []
      : [
          '',
          ...(envNames.length === 0
            ? []
            : [`The environment sets ${envNames.join(', ')} to writable per-slot directories; use them for caches and tool state.`]),
          ...(portNames.length === 0
            ? []
            : [`${portNames.join(', ')} hold a port base reserved for this slot; use ports from there instead of fixed ones.`]),
          ...(valueNames.length === 0
            ? []
            : [`The project's settings set ${valueNames.join(', ')} for every worker; leave them as they are.`]),
        ]),
    ...(setupSteps.length === 0
      ? []
      : ['', ...setupSteps.map((step) => slotSetupPromptLine(step))]),
    '',
    'Task:',
    task,
    ...(acceptance === undefined ? [] : ['', 'Acceptance criteria:', acceptance]),
  ].join('\n')
}

/**
 * The sentence a worker reads about one setup step that already ran.
 *
 * @param {{run: string[], inputs?: string[]}} step - the step's argv and declared inputs.
 * @returns {string} the prompt line.
 */
function slotSetupPromptLine(step) {
  const run = Array.isArray(step.run) ? step.run.join(' ') : String(step.run)
  const inputs = Array.isArray(step.inputs) ? step.inputs : []
  if (inputs.length === 0) {
    return `The slot setup (${run}) has already run in this copy; do not run it again unless you change the files it reads.`
  }
  return `The slot setup (${run}; inputs: ${inputs.join(', ')}) has already run in this copy; do not run it again unless you change ${inputs.join(', ')}.`
}

/**
 * The setup facts the worker prompt may name, or nothing when no step ran.
 *
 * @param {WorkspaceIsolation | undefined} pool - the call's pool.
 * @param {object[] | undefined} setup - what `runSetup` reported.
 * @returns {{run: string[], inputs: string[]}[] | undefined} the prompt facts.
 */
function promptSlotSetup(pool, setup) {
  if (pool === undefined || setup === undefined || setup.length === 0) return undefined
  return pool.slotSetup.map((step) => ({ run: step.run, inputs: step.inputs }))
}

/**
 * The base patch a call continued from, as its result reports it.
 *
 * The note is part of the answer, not decoration: `prepare` records the copy's base before
 * the base patch is applied, so the patch this call stores holds the base patch's change plus
 * the new work. A caller that applies both would fail or duplicate the change, so the result
 * says which one replaces which.
 *
 * @param {object} [basePatch] - what `applyBasePatch` planted in the copy.
 * @returns {object} the field to spread into the result, or nothing when no base was used.
 */
function basePatchFields(basePatch) {
  if (basePatch === undefined) return {}
  return {
    basePatch: {
      patchId: basePatch.patchId,
      applied: true,
      threeWay: basePatch.threeWay === true,
      conflicts: basePatch.conflicts ?? [],
      note: "this call's change.patchId is cumulative: it holds the base patch's change and the new work together, so apply it instead of the base patch",
    },
  }
}

/**
 * Render the text of a tool-result message. Unlike an assistant message, a tool
 * result wraps its payload in `tool-result` blocks one level deeper, so both
 * shapes are walked without trusting either.
 */
export function toolResultText(message) {
  const parts = []
  const walk = (blocks) => {
    if (!Array.isArray(blocks)) return
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      else if (Array.isArray(block.content)) walk(block.content)
    }
  }
  walk(message?.content)
  return parts.join('\n').trim()
}

/** Render text blocks of a content-block array without trusting their shape. */
export function textOfContentBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** Clip a child message to the returned-result budget. */
function truncate(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false }
  return {
    text: `${text.slice(0, maxChars)}\n… [truncated ${String(text.length - maxChars)} of ${String(text.length)} characters]`,
    truncated: true,
  }
}

/** Explain a non-delegating orchestrator in the error message. */
function describeParent(state) {
  const notes = []
  const excerpt = state.parentText.slice(0, PARENT_EXCERPT_CHARS)
  if (excerpt.length > 0) notes.push(`it replied ${JSON.stringify(excerpt)}`)
  notes.push(`it called ${state.toolCalls.length === 0 ? 'no tool' : `${String(state.toolCalls.length)} tool(s): ${state.toolCalls.join('; ')}`}`)
  notes.push(`tools offered were ${state.toolsOffered.length === 0 ? 'unknown' : state.toolsOffered.join(', ')}`)
  return ` (${notes.join('; ')})`
}

function stderrHint(diagnostics) {
  const tail = typeof diagnostics === 'function' ? String(diagnostics() ?? '').trim() : String(diagnostics ?? '').trim()
  return tail.length === 0 ? '' : `\n--- dsh stderr ---\n${tail}`
}

/** Whether a handshake failure was the client's own request deadline. */
function isTimeoutError(error) {
  if (error?.code === 'TIMEOUT') return true
  return error instanceof Error && /timed out after \d+ms/.test(error.message)
}

/**
 * Read a task brief from a file, fenced to the service root exactly like `cwd`.
 *
 * Callers write 4-8 KB briefs to a file and used to paste `$(cat brief)` into the task
 * text, which the worker then started on literally. A path — relative to the root — is
 * sent as written, once. Reading is confined for the same reason every other path is:
 * the file is about to be put into a prompt, so a path outside the root (or a symlink
 * pointing out of it) is refused rather than read.
 *
 * Exported so a background job's label reads a brief through exactly this fence and these
 * limits: a label derived by a second, weaker reader would name a file the call refuses.
 *
 * @param {string} root - the service root every path is fenced to.
 * @param {unknown} requested - the `taskFile` argument.
 * @param {object} [options] - how to read it.
 * @param {string} [options.field] - the argument's name, for errors
 *   (`tasks[1].taskFile` in a fleet).
 * @param {(message: string) => void} [options.log] - diagnostic sink.
 * @returns {string} the file's text, exactly as written.
 * @throws {FlashTaskError} when the path is unreadable, outside the root, or not a usable file.
 */
export function readTaskFile(root, requested, { field = 'taskFile', log = () => {} } = {}) {
  const text = requireText(requested, field)
  const absolute = isAbsolute(text) ? resolve(text) : resolve(root, text)
  let real
  try {
    // realpathSync both proves the file exists and resolves a symlink, so a link that
    // points out of the root is fenced by the same comparison a literal path gets.
    real = realpathSync(absolute)
  } catch (error) {
    throw new FlashTaskError(`${field} "${text}" could not be read: ${messageOf(error)}`, 'INVALID_ARGUMENT')
  }
  const relation = relative(root, real)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new FlashTaskError(
      `${field} "${text}" is outside the service root ${root}; this service is confined to that root`,
      'TASK_FILE_OUTSIDE_ROOT',
    )
  }
  const stats = statSync(real)
  if (!stats.isFile()) {
    throw new FlashTaskError(`${field} "${text}" is not a regular file`, 'INVALID_ARGUMENT')
  }
  if (stats.size > MAX_TASK_FILE_BYTES) {
    throw new FlashTaskError(
      `${field} "${text}" is ${String(stats.size)} bytes; the most this service reads is ` +
        `${String(MAX_TASK_FILE_BYTES)} (256 KB)`,
      'INVALID_ARGUMENT',
    )
  }
  const content = readFileSync(real, 'utf8')
  if (content.trim().length === 0) {
    throw new FlashTaskError(`${field} "${text}" is empty`, 'INVALID_ARGUMENT')
  }
  log(`task read from ${real} (${String(content.length)} chars)`)
  return content
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FlashTaskError(`${field} must be a non-empty string`, 'INVALID_ARGUMENT')
  }
  return value
}

function optionalText(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new FlashTaskError('acceptance must be a string when present', 'INVALID_ARGUMENT')
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * The `basePatch` argument, when a call carried one.
 *
 * Only the shape is checked here. The id itself is looked up where the copy exists, so an
 * unknown id is refused with the message that names the patch directory it searched rather
 * than a second, weaker one here.
 *
 * @param {unknown} value - the raw argument.
 * @returns {string | undefined} the patch id, or undefined when none was given.
 * @throws {FlashTaskError} with code `INVALID_ARGUMENT` when it is present but not a string.
 */
function optionalPatchId(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FlashTaskError('basePatch must be a non-empty patchId string when present', 'INVALID_ARGUMENT')
  }
  return value.trim()
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** A promise plus its settlement handles. */
function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
