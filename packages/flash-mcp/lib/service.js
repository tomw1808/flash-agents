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

import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

import { IsolationError, WorkspaceIsolation } from './isolation.js'
import { HarnessSdkClient } from './sdk.js'

/** Route the service pins; callers can never change it. */
export const DEFAULT_PROVIDER = 'ollama'
export const DEFAULT_MODEL = 'deepseek-v4.1-flash:cloud'

/** Default wall-clock budget for one delegated task. */
const DEFAULT_TASK_TIMEOUT_MS = 300_000

/** Default returned size of the child's final message. */
const DEFAULT_MAX_RESULT_CHARS = 8_000

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
 * How many disposable trees may be in flight at once. Each one costs a runtime
 * process, so this is a memory budget as much as a concurrency limit.
 */
const DEFAULT_SLOTS = 2

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
   * @param {Record<string, string | undefined>} [options.env] - runtime environment.
   * @param {(message: string) => void} [options.log] - diagnostic sink (stderr).
   * @param {(profile: string, cwd: string, extraEnv?: object) => HarnessSdkClient} [options.clientFactory]
   *   runtime factory (tests).
   */
  constructor({
    root,
    profile = 'flash-service',
    provider = DEFAULT_PROVIDER,
    model = DEFAULT_MODEL,
    maxTokens,
    taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS,
    maxResultChars = DEFAULT_MAX_RESULT_CHARS,
    batchTimeoutMs = DEFAULT_BATCH_TIMEOUT_MS,
    maxTasks = DEFAULT_MAX_TASKS,
    perItemChars = DEFAULT_PER_ITEM_CHARS,
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
    this.maxResultChars = maxResultChars
    this.batchTimeoutMs = batchTimeoutMs
    this.maxTasks = maxTasks
    this.perItemChars = perItemChars
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
            log,
          })
    this.stateDir = this.isolation?.stateDir ?? resolve(isolate.stateDir ?? join(tmpdir(), 'flash-mcp'))

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
   * The runtime a call runs on, and the environment it needs.
   *
   * The runtime is rooted at the *tree*, never at a subdirectory of it: the sandbox root
   * is fixed when a process starts, so a runtime per requested subdirectory meant one
   * process per distinct `cwd`, none of which ever exits. The subdirectory still reaches
   * the worker, in the prompt, where it belongs.
   *
   * @param {object | undefined} slot - the leased tree, when the call is isolated.
   * @param {string} rootCwd - the resolved directory inside the caller's root.
   * @returns {{promptCwd: string, runtimeCwd: string, extraEnv: object | undefined}} where to run.
   */
  #runLocation(slot, rootCwd, pool) {
    if (slot === undefined || pool === undefined) {
      return { promptCwd: rootCwd, runtimeCwd: rootCwd, extraEnv: undefined }
    }
    // The runtime's environment is deliberately left alone. Pointing TMPDIR into the
    // tree looked tidy, but the Harness derives the sandbox's writable roots from the
    // runtime's `os.tmpdir()`, which reads that same variable: the per-user temp area
    // (`/private/var/folders/…/T` on macOS) vanished from the grant, and `swift build`
    // failed with EPERM while `touch` in the same directory succeeded. The tree's own
    // scratch directory still exists and the worker is told about it in its prompt.
    return {
      promptCwd: pool.slotCwd(slot, rootCwd),
      runtimeCwd: slot.dir,
      extraEnv: undefined,
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
   * @param {string} args.task - the work to delegate.
   * @param {string} args.cwd - working directory for the worker; must be inside the root.
   * @param {string} [args.acceptance] - optional acceptance criteria for the worker.
   * @param {AbortSignal} [options.signal] - client cancellation.
   * @returns {Promise<object>} the compact structured result.
   */
  async flashTask(args, { signal } = {}) {
    const task = requireText(args?.task, 'task')
    const rootCwd = this.#resolveCwd(args?.cwd)
    const acceptance = optionalText(args?.acceptance)
    const apply = this.#resolveApply(args?.apply)
    warnAboutIgnoredArguments(args, 'flash_task', this.log)

    const sessionId = `flash-task-${randomUUID()}`
    const profileName = this.#profileForMode(args?.mode)
    const pool = this.#isolationFor(profileName)
    const slot = pool === undefined ? undefined : await this.#lease(pool, 'flash_task', this.taskTimeoutMs, signal)
    try {
      const { promptCwd, runtimeCwd, extraEnv } = this.#runLocation(slot, rootCwd, pool)
      if (slot !== undefined) pool.prepare(slot)
      const childPrompt = buildChildPrompt({
        cwd: promptCwd,
        task,
        acceptance,
        ...(slot === undefined ? {} : { copy: true }),
      })
      const { state, started } = await this.#runSession({
        sessionId,
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
      const change = slot === undefined ? undefined : pool.collect(slot, { diffChars: this.diffChars })
      const applied = change?.available === true && apply === 'auto' ? this.#applyChange(change) : undefined
      return this.#buildResult({
        state,
        sessionId,
        started,
        profile: profileName,
        cwd: runtimeCwd,
        slot,
        change,
        applied,
      })
    } catch (error) {
      if (slot !== undefined && error?.code === 'TIMEOUT') this.#salvageTimedOut(pool, slot, error)
      throw error
    } finally {
      if (slot !== undefined) pool.release(slot)
    }
  }

  /**
   * What a timed-out isolated call leaves behind. The session cannot be stopped — the
   * SDK has no cancel — so its worker may still be writing into the tree. Two things
   * follow. The work so far is collected and stored as a patch, and the tree is retired
   * instead of recycled, so a later call is never handed a copy another session is
   * still editing. Both facts, and any tool refusals seen, go into the error the caller
   * reads: a timeout that says only "timeout" is the one outcome that teaches nothing.
   *
   * @param {WorkspaceIsolation} pool - the pool the slot belongs to.
   * @param {object} slot - the leased tree.
   * @param {Error} error - the timeout error, whose message is extended in place.
   */
  #salvageTimedOut(pool, slot, error) {
    let note
    try {
      const change = pool.collect(slot, { diffChars: this.diffChars })
      if (!change.available) {
        note = `no change could be collected from the tree (${change.reason})`
      } else if (change.filesChanged.length === 0) {
        note = 'the tree held no change when the budget ran out'
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
    pool.retire(slot)
    this.log(`timeout: ${note}${refusals}`)
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
   * @returns {Promise<object>} the compact per-task fleet result.
   */
  async flashBatch(args, { signal } = {}) {
    const tasks = normalizeTasks(args?.tasks, this.maxTasks)
    const rootCwd = this.#resolveCwd(args?.cwd)
    const acceptance = optionalText(args?.acceptance)
    const apply = this.#resolveApply(args?.apply)
    warnAboutIgnoredArguments(args, 'flash_batch', this.log)

    const sessionId = `flash-batch-${randomUUID()}`
    const profileName = this.#profileForMode(args?.mode)
    // A fleet is one call and therefore one tree: its members share a working
    // directory exactly as they share a runtime, so they see each other's edits.
    const pool = this.#isolationFor(profileName)
    const slot = pool === undefined ? undefined : await this.#lease(pool, 'flash_batch', this.batchTimeoutMs, signal)
    try {
      const { promptCwd, runtimeCwd, extraEnv } = this.#runLocation(slot, rootCwd, pool)
      if (slot !== undefined) pool.prepare(slot)
      const copy = slot === undefined ? {} : { copy: true }
      const items = tasks.map((entry, index) => ({
        label: `task-${String(index + 1)}`,
        prompt: [
          buildChildPrompt({ cwd: promptCwd, task: entry.task, acceptance: entry.acceptance ?? acceptance, ...copy }),
          '',
          WORKER_RULES,
        ].join('\n'),
      }))
      const { state, started } = await this.#runSession({
        sessionId,
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
      const change = slot === undefined ? undefined : pool.collect(slot, { diffChars: this.diffChars })
      const applied = change?.available === true && apply === 'auto' ? this.#applyChange(change) : undefined
      return this.#buildBatchResult({
        state,
        tasks,
        sessionId,
        started,
        profile: profileName,
        cwd: runtimeCwd,
        slot,
        change,
        applied,
      })
    } catch (error) {
      if (slot !== undefined && error?.code === 'TIMEOUT') this.#salvageTimedOut(pool, slot, error)
      throw error
    } finally {
      if (slot !== undefined) pool.release(slot)
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
          `The patch is kept at ${String(change.patchPath)}.`,
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
      return this.isolation.apply({ patchId, dryRun: args?.dryRun === true, force: args?.force === true })
    } catch (error) {
      throw new FlashTaskError(messageOf(error), 'APPLY_FAILED')
    }
  }

  /**
   * Read the `apply` argument. Only an explicit `auto` applies anything: the
   * default leaves the caller's tree alone until it asks.
   *
   * @param {unknown} value - the requested mode.
   * @returns {'none' | 'auto'} what to do with the patch.
   */
  #resolveApply(value) {
    if (value === undefined || value === null || value === 'none') return 'none'
    if (value === 'auto') {
      if (this.isolation === undefined) {
        throw new FlashTaskError('apply "auto" needs isolation, but this service runs with --isolate none', 'ISOLATION_DISABLED')
      }
      return 'auto'
    }
    throw new FlashTaskError(`apply ${JSON.stringify(value)} is not available; use "none" (default) or "auto"`, 'APPLY_UNAVAILABLE')
  }

  /** Start one session on the persistent runtime and wait for it to go idle. */
  async #runSession({ sessionId, prompt, timeoutMs, label, note, signal, profile, cwd = this.root, extraEnv }) {
    const client = await this.#ensureRuntime(profile, cwd, extraEnv)
    const key = this.#runtimeKey(profile, cwd)
    const state = createObserveState()
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
        label,
        signal,
        sessionId,
        diagnostics: () => this.runtimes.get(key)?.client?.diagnostics ?? '',
      })
      return { state, started }
    } catch (error) {
      // A call that runs out of budget never builds a result, so the refusals seen so
      // far travel on the error instead; the salvage step reports them from there.
      if (error?.code === 'TIMEOUT') error.denials = state.denials
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
   * @returns {object} fields to spread into the result.
   */
  #changeFields({ profileName, slot, change, applied }) {
    const isolated = this.isolation !== undefined && profileName === this.profile
    const fields = { isolation: { mode: isolated ? 'copy' : 'none', slot: slot?.id ?? null } }
    if (change === undefined) return fields
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
        diffTruncated: change.diff.length < change.diffChars,
        applied: applied !== undefined,
        ...(change.patchId === undefined ? {} : { patchId: change.patchId }),
      },
    }
  }

  /** Assemble the compact per-task fleet result. */
  #buildBatchResult({ state, tasks, sessionId, started, profile, cwd, slot, change, applied }) {
    const envelope = extractWorkflowValue(state.workflowText)
    const payload = envelope.value
    const warnings = []
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
          return { index, status: 'unknown', result: '', resultTruncated: false, ...memberFields(member, childById), ...refusals(index) }
        }
        const clipped = truncate(typeof found.result === 'string' ? found.result : '', this.maxResultChars)
        return {
          index,
          status: found.ok === true ? 'ok' : 'error',
          result: clipped.text,
          resultTruncated: clipped.truncated,
          ...memberFields(member, childById),
          ...refusals(index),
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
        }
      })
    } else {
      // With neither the script's ordered return value nor a complete label
      // mapping, the child-to-task pairing is unknowable: report the absence
      // rather than invent one.
      warnings.push(`the per-task results could not be read (${String(envelope.error)})`)
    }

    const maxParallel = state.maxParallel
    const ok = results === null ? 0 : results.filter((entry) => entry.status === 'ok').length
    const failed = results === null ? 0 : results.length - ok
    const status = results === null ? 'unknown' : failed === 0 ? 'ok' : ok === 0 ? 'error' : 'partial'
    if (tasks.length > 1 && maxParallel < 2) {
      warnings.push(`the fleet never ran two workers at once (peak concurrency ${String(maxParallel)})`)
    }
    if (state.children.some((child) => child.status !== 'ok')) {
      warnings.push('at least one worker ended with a non-ok status')
    }
    const routes = []
    for (const route of state.childRoutes.values()) {
      if (!routes.some((known) => known.provider === route.provider && known.model === route.model)) routes.push(route)
    }

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
      durationMs: Date.now() - started,
      runtime: this.#runtimeInfo(profile, cwd),
      ...this.#changeFields({ profileName: profile, slot, change, applied }),
      ...(warnings.length === 0 ? {} : { warnings }),
    }
  }

  /** Assemble the compact result the MCP client receives. */
  #buildResult({ state, sessionId, started, profile, cwd, slot, change, applied }) {
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
    const warnings = []
    if (children.length > 1) warnings.push(`the orchestrator delegated ${String(children.length)} times; the last child is reported as the result`)
    if (primary.status !== 'ok') warnings.push(`the worker ended with status "${String(primary.status)}"`)
    if ((change?.ignored ?? []).length > 0) {
      warnings.push(
        `the worker created ${String(change.ignored.length)} path(s) that git ignores, so the patch cannot carry them: ${change.ignored.slice(0, 5).join(', ')}`,
      )
    }

    return {
      status: primary.status,
      stopReason: primary.stopReason,
      provider: primary.provider,
      route: primary.route,
      result: primary.result,
      resultTruncated: primary.resultTruncated,
      childSessionId: primary.childSessionId,
      sessionId,
      mode: profile.endsWith('-readonly') ? 'read-only' : 'workspace-write',
      durationMs: Date.now() - started,
      runtime: this.#runtimeInfo(profile, cwd),
      ...this.#changeFields({ profileName: profile, slot, change, applied }),
      ...(warnings.length === 0 ? {} : { warnings }),
      ...(children.length === 1 ? {} : { children }),
    }
  }
}

/** The observation state for one session. */
export function createObserveState() {
  return {
    sawRunning: false,
    idle: false,
    status: 'unknown',
    children: [],
    childIds: new Set(),
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
  }
}

/** Collect one session's progress from runtime notifications. */
function observe(state, method, params, sessionId, completion, log) {
  if (method === 'session.status') {
    if (params?.sessionId !== sessionId) return
    state.status = String(params.status)
    if (state.status === 'running') state.sawRunning = true
    log(`session ${state.status}`)
    if (state.status === 'idle' && state.sawRunning) completion.resolve()
    return
  }
  if (method === 'subagent.started') {
    if (params?.parentSessionId !== sessionId) return
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
  if (event?.type === 'tool-workflow/agent-start') {
    // The engine reports the label this service generated for each member, which
    // is what makes a per-task pairing possible without guessing.
    const label = event.data?.label
    if (typeof label === 'string') {
      state.workflowAgents.set(label, { childId: event.data?.childId, outcome: undefined, seq: event.data?.seq })
    }
  }
  if (event?.type === 'tool-workflow/agent-end') {
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

/** Wait for completion, bounded by the task budget and the client's signal. */
function raceWithBudget(promise, { timeoutMs, label, signal, sessionId, diagnostics }) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn(value)
    }
    const timer = setTimeout(() => {
      // The SDK protocol has no cancel method: the session keeps running inside
      // Harness and its later notifications are ignored.
      finish(
        reject,
        new FlashTaskError(
          `${String(label)} exceeded its ${String(timeoutMs)}ms budget on session ${sessionId}; the session continues inside Harness but is no longer reported${stderrHint(diagnostics)}`,
          'TIMEOUT',
        ),
      )
    }, timeoutMs)
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

/** Validate and normalize the fleet's task list. */
export function normalizeTasks(tasks, maxTasks) {
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
  return tasks.map((entry, index) => {
    if (typeof entry === 'string') return { task: requireText(entry, `tasks[${String(index)}]`), acceptance: undefined }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new FlashTaskError(
        `tasks[${String(index)}] must be a string or an object with a "task" field`,
        'INVALID_ARGUMENT',
      )
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

/** The worker-facing task text. */
export function buildChildPrompt({ cwd, task, acceptance, copy }) {
  return [
    `Working directory: ${cwd}`,
    ...(copy === true
      ? [
          '',
          "This working directory is a disposable copy of the caller's repository, so its files are here at the same relative paths.",
          'Use relative paths: a path naming the original repository refers to a different directory that you cannot write, and',
          'anything outside this copy is discarded — only the change you leave here is reported back.',
          'Scratch files of your own (downloads, throwaway output, notes to yourself) go under ./.flash-tmp/ in this copy;',
          'it already exists and is left out of the reported change.',
        ]
      : []),
    'Task:',
    task,
    ...(acceptance === undefined ? [] : ['', 'Acceptance criteria:', acceptance]),
  ].join('\n')
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
  const tail = diagnostics().trim()
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
