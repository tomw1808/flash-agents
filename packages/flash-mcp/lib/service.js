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
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

import { IsolationError, WorkspaceIsolation, canonicalTmpdir } from './isolation.js'
import { estimateInstructions } from './instructions.js'
import { HarnessSdkClient } from './sdk.js'

/** Route the service pins; callers can never change it. */
export const DEFAULT_PROVIDER = 'ollama'
export const DEFAULT_MODEL = 'deepseek-v4.1-flash:cloud'

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
   * @param {string} [options.model] - pinned model on that route.
   * @param {number} [options.maxTokens] - optional output cap for SDK agents.
   * @param {number} [options.taskTimeoutMs] - per-task wall-clock budget.
   * @param {number} [options.maxResultChars] - returned child-message budget.
   * @param {number} [options.batchTimeoutMs] - per-fleet wall-clock budget.
   * @param {number} [options.maxTasks] - ceiling on tasks in one fleet call.
   * @param {number} [options.perItemChars] - returned per-worker budget inside a fleet.
   * @param {number} [options.progressIntervalMs] - how often a running call reports progress.
   * @param {Record<string, string | undefined>} [options.env] - runtime environment.
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
    maxTokens,
    taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    maxResultChars = DEFAULT_MAX_RESULT_CHARS,
    batchTimeoutMs = DEFAULT_BATCH_TIMEOUT_MS,
    maxTasks = DEFAULT_MAX_TASKS,
    perItemChars = DEFAULT_PER_ITEM_CHARS,
    progressIntervalMs = DEFAULT_PROGRESS_INTERVAL_MS,
    env = process.env,
    log = () => {},
    clientFactory,
    isolate = {},
  }) {
    this.root = realpathSync(resolve(root))
    this.profile = profile
    this.provider = provider
    this.model = model
    this.maxTokens = maxTokens
    this.taskTimeoutMs = taskTimeoutMs
    this.idleTimeoutMs = idleTimeoutMs
    this.maxResultChars = maxResultChars
    this.batchTimeoutMs = batchTimeoutMs
    this.maxTasks = maxTasks
    this.perItemChars = perItemChars
    this.progressIntervalMs = progressIntervalMs
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
            log,
          })
    this.stateDir = this.isolation?.stateDir ?? resolve(isolate.stateDir ?? join(canonicalTmpdir(), 'flash-mcp'))

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

  /** The map key for one runtime: a profile is only meaningful together with a cwd. */
  #runtimeKey(profileName, cwd) {
    return `${profileName}@${cwd}`
  }

  /** Runtime facts for the returned payload, for the runtime that served the call. */
  #runtimeInfo(profileName, cwd) {
    const run = this.runtimes.get(this.#runtimeKey(profileName, cwd))
    return {
      pid: run?.client?.pid ?? null,
      booted: run?.initialized === true,
      uptimeMs: run?.startedAt === undefined ? 0 : Date.now() - run.startedAt,
      sessions: this.sessions,
      profile: profileName,
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
   * @param {WorkspaceIsolation} pool - the pool the call is about to lease from.
   * @param {object} activity - the call's activity record.
   * @returns {number | undefined} when the wait began, or undefined when a tree was free.
   */
  #noteQueue(pool, activity) {
    if (pool.inUse < pool.size) return undefined
    const since = Date.now()
    activity.what = `queued: waiting for a free tree (${String(pool.inUse)} of ${String(pool.size)} in use)`
    activity.queuedSince = since
    activity.queuedInUse = pool.inUse
    activity.queuedSize = pool.size
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
   *   slotPorts: string[]}} where to run, and which of `extraEnv`'s names are port ranges.
   */
  #runLocation(slot, rootCwd, pool) {
    if (slot === undefined || pool === undefined) {
      return { promptCwd: rootCwd, runtimeCwd: rootCwd, extraEnv: undefined, slotPorts: [] }
    }
    // The runtime's environment is deliberately left alone apart from the per-slot paths
    // the repository's settings ask for. Pointing TMPDIR into the tree looked tidy, but the
    // Harness derives the sandbox's writable roots from the runtime's `os.tmpdir()`, which
    // reads that same variable: the per-user temp area (`/private/var/folders/…/T` on
    // macOS) vanished from the grant, and `swift build` failed with EPERM while `touch` in
    // the same directory succeeded. The tree's own scratch directory still exists and the
    // worker is told about it in its prompt.
    const slotEnv = pool.slotEnvFor(slot)
    // A `port:` entry resolves to a bare number, which the worker must not read as a path:
    // the prompt names those variables in their own sentence.
    const slotPorts = Object.entries(pool.slotEnv)
      .filter(([, spec]) => spec.kind === 'port')
      .map(([name]) => name)
    return {
      promptCwd: pool.slotCwd(slot, rootCwd),
      runtimeCwd: slot.dir,
      // Resolved from `slot.dir`, which is stable for the life of the slot, so this is the
      // same set of paths the slot was prepared with. Undefined when nothing is configured,
      // exactly as before: the runtime's environment is then untouched.
      extraEnv: Object.keys(slotEnv).length === 0 ? undefined : slotEnv,
      slotPorts,
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
   * Run one delegated task.
   * @param {object} args - the MCP tool arguments.
   * @param {string} [args.task] - the work to delegate.
   * @param {string} [args.taskFile] - a file holding the work; exactly one of the two.
   * @param {string} args.cwd - working directory for the worker; must be inside the root.
   * @param {string} [args.acceptance] - optional acceptance criteria for the worker.
   * @param {AbortSignal} [options.signal] - client cancellation.
   * @param {(report: object) => void} [options.progress] - MCP progress sender.
   * @param {unknown} [options.progressToken] - the request's progress token, when it had one.
   * @returns {Promise<object>} the compact structured result.
   */
  async flashTask(args, { signal, progress, progressToken } = {}) {
    const task = this.#resolveTask(args)
    const rootCwd = this.#resolveCwd(args?.cwd)
    const acceptance = optionalText(args?.acceptance)
    const apply = this.#resolveApply(args?.apply)
    warnAboutIgnoredArguments(args, 'flash_task', this.log)

    const sessionId = `flash-task-${randomUUID()}`
    const profileName = this.#profileForMode(args?.mode)
    const pool = this.#isolationFor(profileName)
    // `source` selects what the copy starts from. "head" is the escape hatch for running a
    // call while another session has uncommitted work in the same tree: the copy is reset to
    // the last commit instead of carrying that work. A read-only call is not isolated at all,
    // so there is nothing to reset — and it must not be told otherwise.
    const source = args?.source ?? 'working-tree'
    if (source !== 'working-tree' && source !== 'head') {
      throw new FlashTaskError(
        `source ${JSON.stringify(source)} is not available; use "working-tree" (default) or "head"`,
        'SOURCE_UNAVAILABLE',
      )
    }
    if (source === 'head' && pool === undefined) {
      throw new FlashTaskError('source "head" applies only to writing calls; a read-only call is not isolated', 'SOURCE_UNAVAILABLE')
    }
    // `basePatch` continues a call from a patch an earlier one stored: the patch is planted
    // in this call's copy before the worker starts, never in the caller's tree. Like
    // `source: "head"`, it needs a copy to act on, so a read-only call is refused here. The
    // rest of the id — whether it exists, belongs to this root, and names the repository this
    // call's cwd resolves to — is checked once the copy exists, before the worker starts.
    const basePatchId = optionalPatchId(args?.basePatch)
    if (basePatchId !== undefined && pool === undefined) {
      throw new FlashTaskError(
        'basePatch applies only to writing calls; a read-only call is not isolated, so it has no copy to apply the patch to',
        'BASE_PATCH_UNAVAILABLE',
      )
    }
    // Progress spans the whole call, including a wait for a free tree: that wait is
    // itself work the client must not mistake for a dead server. The interval is
    // stopped on every path out of this method.
    const activity = createActivity()
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
      if (pool !== undefined) {
        const queuedSince = this.#noteQueue(pool, activity)
        slot = await this.#lease(pool, 'flash_task', this.taskTimeoutMs, signal)
        queuedMs = this.#noteLeased(activity, queuedSince)
      }
      const { promptCwd, runtimeCwd, extraEnv, slotPorts } = this.#runLocation(slot, rootCwd, pool)
      if (slot !== undefined) {
        try {
          pool.prepare(slot, { cwd: rootCwd, source })
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
              slotSetup: promptSlotSetup(pool, setup),
              discard: apply === 'discard',
              ...(baseApplied === undefined ? {} : { basePatch: promptBasePatch(baseApplied) }),
            }),
      })
      // Measured before the worker runs, in the tree it is about to see: a worker that writes
      // or deletes an instruction file must not change what this call reports it was given.
      const instructions = this.#instructionsFor(promptCwd)
      const { state, started } = await this.#runSession({
        sessionId,
        activity,
        prompt: buildOrchestrationPrompt(childPrompt),
        timeoutMs: this.taskTimeoutMs,
        label: 'flash_task',
        note: `${String(childPrompt.length)} chars of task text`,
        signal,
        profile: profileName,
        cwd: runtimeCwd,
        extraEnv,
      })

      if (state.children.length === 0) {
        throw new FlashTaskError(
          `the orchestrator finished without delegating${describeParent(state)}`,
          'NOT_DELEGATED',
        )
      }
      this.#logToolTrace(state)
      change = slot === undefined ? undefined : pool.collect(slot, { diffChars: this.diffChars, store: apply !== 'discard' })
      const applied = change?.available === true && apply === 'auto' ? this.#applyChange(change) : undefined
      return this.#buildResult({
        state,
        sessionId,
        started,
        profile: profileName,
        cwd: runtimeCwd,
        // Measured where the worker sees them: inside the disposable copy for a writing call.
        instructions,
        slot,
        change,
        applied,
        basePatch: baseApplied,
        setup,
        queuedMs,
      })
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
   * stop a session, but the service owns the process that runs it. The runtime that
   * served this call is keyed by the tree it was rooted at, which is still the slot's
   * directory here; dropping it from the map means the next call on this slot boots a
   * fresh runtime for the slot's new directory, exactly as it would for any new cwd.
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
    // Stop the process before the slot moves: the runtime is keyed by the tree it was
    // rooted at, and `retire` gives the slot a new directory. A session that is still
    // running can no longer be signalled through the SDK, but killing its runtime takes
    // the worker processes it spawned with it.
    const key = this.#runtimeKey(profileName, slot.dir)
    const run = this.runtimes.get(key)
    if (run !== undefined) {
      this.runtimes.delete(key)
      try {
        await run.client?.shutdown()
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
   * @param {AbortSignal} [options.signal] - client cancellation.
   * @param {(report: object) => void} [options.progress] - MCP progress sender.
   * @param {unknown} [options.progressToken] - the request's progress token, when it had one.
   * @returns {Promise<object>} the compact per-task fleet result.
   */
  async flashBatch(args, { signal, progress, progressToken } = {}) {
    const tasks = normalizeTasks(args?.tasks, this.maxTasks, {
      readTaskFile: (value, field) => this.#readTaskFile(value, field),
    })
    const rootCwd = this.#resolveCwd(args?.cwd)
    const acceptance = optionalText(args?.acceptance)
    const apply = this.#resolveApply(args?.apply)
    warnAboutIgnoredArguments(args, 'flash_batch', this.log)

    const sessionId = `flash-batch-${randomUUID()}`
    const profileName = this.#profileForMode(args?.mode)
    // A fleet is one call and therefore one tree: its members share a working
    // directory exactly as they share a runtime, so they see each other's edits.
    const pool = this.#isolationFor(profileName)
    // A fleet's copy starts from the same place a single task's does; see flashTask.
    const source = args?.source ?? 'working-tree'
    if (source !== 'working-tree' && source !== 'head') {
      throw new FlashTaskError(
        `source ${JSON.stringify(source)} is not available; use "working-tree" (default) or "head"`,
        'SOURCE_UNAVAILABLE',
      )
    }
    if (source === 'head' && pool === undefined) {
      throw new FlashTaskError('source "head" applies only to writing calls; a read-only call is not isolated', 'SOURCE_UNAVAILABLE')
    }
    // A fleet continues from a base patch exactly as one task does; see flashTask.
    const basePatchId = optionalPatchId(args?.basePatch)
    if (basePatchId !== undefined && pool === undefined) {
      throw new FlashTaskError(
        'basePatch applies only to writing calls; a read-only call is not isolated, so it has no copy to apply the patch to',
        'BASE_PATCH_UNAVAILABLE',
      )
    }
    // As with flash_task, progress spans the whole call, a wait for a free tree included.
    const activity = createActivity()
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
      if (pool !== undefined) {
        const queuedSince = this.#noteQueue(pool, activity)
        slot = await this.#lease(pool, 'flash_batch', this.batchTimeoutMs, signal)
        queuedMs = this.#noteLeased(activity, queuedSince)
      }
      const { promptCwd, runtimeCwd, extraEnv, slotPorts } = this.#runLocation(slot, rootCwd, pool)
      if (slot !== undefined) {
        try {
          pool.prepare(slot, { cwd: rootCwd, source })
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
      const { state, started } = await this.#runSession({
        sessionId,
        activity,
        prompt: buildBatchPrompt({
          count: items.length,
          script: BATCH_SCRIPT,
          args: { items, perItemChars: this.perItemChars },
        }),
        timeoutMs: this.batchTimeoutMs,
        label: 'flash_batch',
        note: `${String(items.length)} delegated tasks`,
        signal,
        profile: profileName,
        cwd: runtimeCwd,
        extraEnv,
      })

      if (state.subagentStarts === 0) {
        throw new FlashTaskError(
          `the orchestrator finished without starting the fleet${describeParent(state)}`,
          'NOT_DELEGATED',
        )
      }
      this.#logToolTrace(state)
      change = slot === undefined ? undefined : pool.collect(slot, { diffChars: this.diffChars, store: apply !== 'discard' })
      const applied = change?.available === true && apply === 'auto' ? this.#applyChange(change) : undefined
      return this.#buildBatchResult({
        state,
        tasks,
        sessionId,
        started,
        profile: profileName,
        cwd: runtimeCwd,
        instructions,
        slot,
        change,
        applied,
        basePatch: baseApplied,
        setup,
        queuedMs,
      })
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
    try {
      return this.isolation.apply({
        patchId,
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
  async #runSession({ sessionId, prompt, timeoutMs, label, note, signal, profile, cwd = this.root, extraEnv, activity = createActivity() }) {
    const client = await this.#ensureRuntime(profile, cwd, extraEnv)
    const key = this.#runtimeKey(profile, cwd)
    const state = createObserveState()
    state.activity = activity
    activity.at = Date.now()
    const started = Date.now()
    const completion = createDeferred()
    const unsubscribe = client.onNotification((method, params) => {
      observe(state, method, params, sessionId, completion, this.log)
    })
    const offExit = client.onExit(() => {
      completion.reject(new FlashTaskError('the dsh runtime exited during the task', 'RUNTIME_EXITED'))
    })
    try {
      this.sessions += 1
      await client.prompt({ sessionId, text: prompt })
      this.log(`session ${sessionId} prompted${note === undefined ? '' : ` (${note})`}`)
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
   * Start and hand-shake one profile's runtime exactly once, even under
   * concurrent calls. Each profile keeps its own persistent process.
   *
   * @param {string} profileName - the profile to run on.
   * @returns {Promise<object>} the live client.
   */
  async #ensureRuntime(profileName, cwd, extraEnv) {
    const key = this.#runtimeKey(profileName, cwd)
    const existing = this.runtimes.get(key)
    if (existing?.client?.running && existing.initialized) return existing.client
    if (existing?.starting !== undefined) return await existing.starting
    const run = existing ?? { client: undefined, initialized: false, starting: undefined, startedAt: undefined }
    this.runtimes.set(key, run)
    run.starting = (async () => {
      let client
      try {
        client = this.clientFactory(profileName, cwd, extraEnv)
        client.start()
        const info = await client.initialize({
          cwd,
          provider: this.provider,
          model: this.model,
          ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
        })
        run.client = client
        run.initialized = true
        run.startedAt = Date.now()
        this.log(`runtime ready: ${info.name} ${info.version} (pid ${String(client.pid)}) on ${profileName}`)
        return client
      } catch (error) {
        await client?.shutdown().catch(() => {})
        this.runtimes.delete(key)
        throw new FlashTaskError(
          `could not initialize the ${profileName} runtime: ${messageOf(error)}`,
          'RUNTIME_INIT_FAILED',
        )
      }
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
    const text = requireText(requested, field)
    const absolute = isAbsolute(text) ? resolve(text) : resolve(this.root, text)
    let real
    try {
      // realpathSync both proves the file exists and resolves a symlink, so a link that
      // points out of the root is fenced by the same comparison a literal path gets.
      real = realpathSync(absolute)
    } catch (error) {
      throw new FlashTaskError(`${field} "${text}" could not be read: ${messageOf(error)}`, 'INVALID_ARGUMENT')
    }
    const relation = relative(this.root, real)
    if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      throw new FlashTaskError(
        `${field} "${text}" is outside the service root ${this.root}; this service is confined to that root`,
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
    this.log(`task read from ${real} (${String(content.length)} chars)`)
    return content
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
        filesChanged: change.filesChanged.map((line) => line.split('\t').at(-1)),
        // Files the worker created that git ignores, so the patch cannot carry them.
        // Named so that "no change" is never the whole answer when there was work.
        ...((change.ignored ?? []).length === 0 ? {} : { ignored: change.ignored }),
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
  #buildBatchResult({ state, tasks, sessionId, started, profile, cwd, instructions, slot, change, applied, basePatch, setup, queuedMs = 0 }) {
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
    if (slot !== undefined && this.isolation?.slotSetupWarning !== undefined) {
      warnings.push(this.isolation.slotSetupWarning)
    }
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
      runtime: this.#runtimeInfo(profile, cwd),
      ...this.#changeFields({ profileName: profile, slot, change, applied, basePatch }),
      ...(warnings.length === 0 ? {} : { warnings }),
    }
  }

  /** Assemble the compact result the MCP client receives. */
  #buildResult({ state, sessionId, started, profile, cwd, instructions, slot, change, applied, basePatch, setup, queuedMs = 0 }) {
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
    // Over budget, the harness keeps the most specific files and drops the broader
    // ones, so the worker's prompt is quietly missing project-wide rules. Say so.
    if (instructions.overBudget) warnings.push(overBudgetWarning(instructions))
    if (slot !== undefined && this.isolation?.slotSetupWarning !== undefined) {
      warnings.push(this.isolation.slotSetupWarning)
    }

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
      runtime: this.#runtimeInfo(profile, cwd),
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

/** The observation state for one session. */
/**
 * The last sign of life a call has seen: when, which step, and what it was doing.
 * Shared by the observer (which writes it), the progress heartbeat and the idle
 * check (which read it), so all three agree on one clock.
 */
export function createActivity(now = Date.now()) {
  return { at: now, step: undefined, what: 'starting', events: 0 }
}

/** Record one event as activity. */
function touchActivity(activity, event) {
  if (activity === undefined) return
  activity.at = Date.now()
  activity.events += 1
  const step = event?.data?.step
  if (typeof step === 'number') activity.step = step
  const type = String(event?.type ?? '')
  if (type === 'tool/call') activity.what = `tool ${String(event.data?.name ?? '?')}`
  else if (type === 'tool/result') activity.what = 'reading a tool result'
  else if (type.startsWith('assistant/') || type.startsWith('llm/')) activity.what = 'model responding'
}

/** One line describing the last activity, for heartbeats and stop reasons. */
export function describeActivity(activity, now = Date.now()) {
  if (activity === undefined) return 'no activity recorded'
  // A call waiting for a tree has no session event to report, and saying so is the point:
  // "last event 10m0s ago" for a call that never started reads as a hang. The counts come
  // from the pool at render time when it is still at hand.
  if (activity.queuedSince !== undefined) {
    const inUse = activity.pool?.inUse ?? activity.queuedInUse ?? 0
    const size = activity.pool?.size ?? activity.queuedSize ?? 0
    return `queued ${formatElapsed(now - activity.queuedSince)}: waiting for a free tree (${String(inUse)} of ${String(size)} in use)`
  }
  const ago = formatElapsed(now - activity.at)
  const step = activity.step === undefined ? '' : `step ${String(activity.step)} · `
  return `${step}${activity.what} · last event ${ago} ago`
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
function observe(state, method, params, sessionId, completion, log) {
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
    touchActivity(state.activity, { type: 'subagent/started' })
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
  // Any event from this session or one of its workers is a sign of life.
  if (session === sessionId || state.childIds.has(session)) touchActivity(state.activity, event)
  // Usage can ride on any event of the call; the ledger keeps it per session so a
  // fleet can later attribute it to the task whose worker reported it.
  if (sessionInCall(state, session, sessionId)) recordUsage(state, session, event)
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
  // as this one's.
  const mine = sessionInCall(state, session, sessionId)
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
      const elapsedMs = Date.now() - startedAt
      progress({
        progress: Math.round(elapsedMs) / 1000,
        ...(budgetMs === undefined || budgetMs === null ? {} : { total: Math.round(budgetMs / 1000) }),
        message: `${label} running ${formatElapsed(elapsedMs)}; ${describeActivity(activity)} (session ${sessionId})`,
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
 * Validate and normalize the fleet's task list.
 *
 * An entry is a task string, or an object carrying its text either inline (`task`) or in a
 * file (`taskFile`), plus optional acceptance criteria. Reading a task file is the
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

/** Routing is not a caller capability; never forward a selection field. */
function warnAboutIgnoredArguments(args, toolName, log) {
  for (const ignored of ['provider', 'model', 'reasoningEffort', 'agentOptions', 'permissions', 'sandbox']) {
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
 * abandoned halfway must say so before its partial result is mistaken for a whole one.
 */
export const WORKER_INSTRUCTIONS = [
  'Do not commit unless the task explicitly asks: the service reads the change from the working tree, and a commit only confuses the report.',
  'If the work reaches for an escape hatch (unsafe code, a disabled or suppressed check or lint, a skipped or weakened test), name each one in the final report with the reason.',
  'If you build a different interface or structure than the task names (another signature, the logic split across several places instead of one, a different data shape), say so first in your final report, with the reason.',
  "If the task's contract or design looks wrong, report it rather than quietly working around it.",
  'If you stop before the task is done, start your final report with why you stopped (for example: the context is full, a blocker, a test you could not make pass) and what is left.',
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
export function buildChildPrompt({ cwd, task, acceptance, copy, uncommitted, slotEnv, slotPorts, slotSetup, discard, basePatch }) {
  const started = Number(uncommitted?.count) > 0
  const startedFiles = started ? (uncommitted.files ?? []).slice(0, PROMPT_UNCOMMITTED_LIMIT) : []
  const allEnvNames = slotEnv === undefined || slotEnv === null ? [] : Object.keys(slotEnv)
  // A `port:` entry holds a number, not a directory, and the worker would look for a path
  // if it were named in the same sentence. Only the names this call actually set count.
  const portNames = (Array.isArray(slotPorts) ? slotPorts : []).filter((name) => allEnvNames.includes(name))
  const envNames = allEnvNames.filter((name) => !portNames.includes(name))
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
    ...(envNames.length === 0 && portNames.length === 0
      ? []
      : [
          '',
          ...(envNames.length === 0
            ? []
            : [`The environment sets ${envNames.join(', ')} to writable per-slot directories; use them for caches and tool state.`]),
          ...(portNames.length === 0
            ? []
            : [`${portNames.join(', ')} hold a port base reserved for this slot; use ports from there instead of fixed ones.`]),
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
  const tail = typeof diagnostics === 'function' ? String(diagnostics() ?? '').trim() : ''
  return tail.length === 0 ? '' : `\n--- dsh stderr ---\n${tail}`
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
