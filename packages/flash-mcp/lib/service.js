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
import { isAbsolute, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

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
   * @param {() => HarnessSdkClient} [options.clientFactory] - runtime factory (tests).
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
    this.clientFactory =
      clientFactory ?? ((profileName) => new HarnessSdkClient({ profile: profileName, cwd: this.root, env, log }))

    /**
     * One persistent runtime per profile, keyed by name. A call that asks for
     * `read-only` boots the read-only profile instead of reusing the writing one,
     * because the sandbox mode is fixed for the life of a process and is the only
     * airtight way to make "this call cannot modify anything" true.
     *
     * @type {Map<string, object>}
     */
    this.runtimes = new Map()
    this.sessions = 0
  }

  /** Runtime facts for the returned payload, for the profile that served the call. */
  #runtimeInfo(profileName) {
    const run = this.runtimes.get(profileName)
    return {
      pid: run?.client?.pid ?? null,
      booted: run?.initialized === true,
      uptimeMs: run?.startedAt === undefined ? 0 : Date.now() - run.startedAt,
      sessions: this.sessions,
      profile: profileName,
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
    const cwd = this.#resolveCwd(args?.cwd)
    const acceptance = optionalText(args?.acceptance)
    warnAboutIgnoredArguments(args, 'flash_task', this.log)

    const sessionId = `flash-task-${randomUUID()}`
    const profileName = this.#profileForMode(args?.mode)
    const childPrompt = buildChildPrompt({ cwd, task, acceptance })
    const { state, started } = await this.#runSession({
      sessionId,
      prompt: buildOrchestrationPrompt(childPrompt),
      timeoutMs: this.taskTimeoutMs,
      label: 'flash_task',
      note: `${String(childPrompt.length)} chars of task text`,
      signal,
      profile: profileName,
    })

    if (state.children.length === 0) {
      throw new FlashTaskError(
        `the orchestrator finished without delegating${describeParent(state)}`,
        'NOT_DELEGATED',
      )
    }
    this.#logToolTrace(state)
    return this.#buildResult({ state, sessionId, started, profile: profileName })
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
    const cwd = this.#resolveCwd(args?.cwd)
    const acceptance = optionalText(args?.acceptance)
    warnAboutIgnoredArguments(args, 'flash_batch', this.log)

    const sessionId = `flash-batch-${randomUUID()}`
    const profileName = this.#profileForMode(args?.mode)
    const items = tasks.map((entry, index) => ({
      label: `task-${String(index + 1)}`,
      prompt: [
        buildChildPrompt({ cwd, task: entry.task, acceptance: entry.acceptance ?? acceptance }),
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
    })

    if (state.subagentStarts === 0) {
      throw new FlashTaskError(
        `the orchestrator finished without starting the fleet${describeParent(state)}`,
        'NOT_DELEGATED',
      )
    }
    this.#logToolTrace(state)
    return this.#buildBatchResult({ state, tasks, sessionId, started, profile: profileName })
  }

  /** Start one session on the persistent runtime and wait for it to go idle. */
  async #runSession({ sessionId, prompt, timeoutMs, label, note, signal, profile }) {
    const client = await this.#ensureRuntime(profile)
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
        diagnostics: () => this.runtimes.get(profile)?.client?.diagnostics ?? '',
      })
      return { state, started }
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

  /** Dispose every runtime this service started. */
  async close() {
    const runs = [...this.runtimes.values()]
    this.runtimes.clear()
    for (const run of runs) await run.client?.shutdown().catch(() => {})
  }

  /**
   * Start and hand-shake one profile's runtime exactly once, even under
   * concurrent calls. Each profile keeps its own persistent process.
   *
   * @param {string} profileName - the profile to run on.
   * @returns {Promise<object>} the live client.
   */
  async #ensureRuntime(profileName) {
    const existing = this.runtimes.get(profileName)
    if (existing?.client?.running && existing.initialized) return existing.client
    if (existing?.starting !== undefined) return await existing.starting
    const run = existing ?? { client: undefined, initialized: false, starting: undefined, startedAt: undefined }
    this.runtimes.set(profileName, run)
    run.starting = (async () => {
      let client
      try {
        client = this.clientFactory(profileName)
        client.start()
        const info = await client.initialize({
          cwd: this.root,
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
        this.runtimes.delete(profileName)
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
    const real = existsSync(absolute) ? realpathSync(absolute) : absolute
    const relation = relative(this.root, real)
    if (relation.startsWith('..') || isAbsolute(relation)) {
      throw new FlashTaskError(
        `cwd "${text}" is outside the service root ${this.root}; this service is confined to that root`,
        'CWD_OUTSIDE_ROOT',
      )
    }
    return real
  }

  /** Assemble the compact per-task fleet result. */
  #buildBatchResult({ state, tasks, sessionId, started, profile }) {
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
      runtime: this.#runtimeInfo(profile),
      ...(warnings.length === 0 ? {} : { warnings }),
    }
  }

  /** Assemble the compact result the MCP client receives. */
  #buildResult({ state, sessionId, started, profile }) {
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
      runtime: this.#runtimeInfo(profile),
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
        log(`worker refusal: ${code ?? 'tool error'}`)
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
    '- meta: the exact JSON between the <meta> markers, copied verbatim',
    '- script: the exact text between the <script> markers, copied verbatim',
    '- args: the exact JSON between the <args> markers, copied verbatim',
    '',
    'Rules:',
    '- Do not attempt any of the work yourself.',
    '- Do not call any other tool, and do not call `workflow` a second time.',
    '- Do not edit, reformat, or shorten the script or the args.',
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
export function buildChildPrompt({ cwd, task, acceptance }) {
  return [
    `Working directory: ${cwd}`,
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
