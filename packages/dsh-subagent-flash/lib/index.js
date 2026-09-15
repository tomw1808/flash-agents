/**
 * `subagent-flash-in-process` — a STRICT routing-contract subagent backend.
 *
 * A Cordis plugin row registering one named subagent provider on `ctx.subagents`.
 * Every child started through this provider runs on the deployment-pinned route
 * (default `ollama` / `deepseek-v4.1-flash:cloud`) no matter what the caller put
 * in `request.agentOptions`, so delegation, workflow fan-out, and Ralph rounds
 * cannot inherit or select an expensive parent model.
 *
 * Design notes:
 * - Zero imports. The row is loaded from the profile composition, whose module
 *   resolution anchor is the harness install rather than this repository, so the
 *   file deliberately depends on nothing outside the live Cordis context. It
 *   delegates the actual child run to an already-registered base provider
 *   (`spawn` by default) through `ctx.subagents.getProvider(name)`.
 * - The base provider is resolved per call, not at apply time, so row order and
 *   provider reloads cannot strand this provider with a stale reference.
 * - `prepareContinuable` is intentionally absent. The continuation manager
 *   resolves a continuable child's route itself, outside this provider, so a
 *   continuable child could not be pinned to the contract route. Refusing the
 *   mode is the strict behavior; use the base `spawn` provider for continuable
 *   children that must follow the caller's route.
 * - Every flash child is a LEAF: `start` refuses to run when the delegating
 *   parent is itself already a delegated child (`maxChildDepth`, default 0).
 *   Because every flash child — delegation tool, workflow `agent()`, or Ralph
 *   round — is created through this provider, a raised chain is rejected at the
 *   one place all of them pass. This is structural and independent of tool names.
 * - No default `toolFilter`. `tools.restrict()` rejects a filter naming a tool
 *   the composition does not define, and it throws on the whole child start, so
 *   a composition-agnostic deny list would break delegation in any preset that
 *   does not happen to define every name. A row may still pass its own
 *   `toolFilter`, whose names belong to that row's own composition.
 *
 * @module dsh-subagent-flash
 */

/** Cordis plugin name. */
const name = 'subagent-flash-in-process'

/**
 * The provider registry is the hard dependency: the row registers into it.
 * @type {string[]}
 */
const inject = ['subagents']

/** Defaults; every one of them is overridable from the composition row config. */
const DEFAULTS = Object.freeze({
  providerName: 'flash',
  baseProvider: 'spawn',
  provider: 'ollama',
  model: 'deepseek-v4.1-flash:cloud',
  /** Deepest delegating parent allowed to start a flash child; 0 = top-level only. */
  maxChildDepth: 0,
})

/**
 * Read an agent's delegation depth. Mirrors the seam's accounting: the persisted
 * session header is authoritative and monotone, and runtime `AgentOptions.subagentDepth`
 * may deepen it but never lower it.
 * @param {object} agent - the delegating parent.
 * @returns {number} its non-negative safe-integer depth.
 */
function delegationDepthOf(agent) {
  const runtime = agent?.options?.subagentDepth
  if (runtime !== undefined && (!Number.isSafeInteger(runtime) || runtime < 0 || Object.is(runtime, -0))) {
    throw new TypeError('agent subagentDepth must be a non-negative safe integer')
  }
  const header = agent?.session?.header?.delegationDepth
  const headerDepth = Number.isSafeInteger(header) && header >= 0 ? header : 0
  return Math.max(headerDepth, runtime ?? 0)
}

/**
 * Read a non-empty string, or fall back.
 * @param {unknown} value - candidate.
 * @param {string} fallback - value used when the candidate is unusable.
 * @returns {string} the resolved string.
 */
function stringOr(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

/**
 * Normalize a `ToolRestriction`-shaped config value into the seam's vocabulary.
 * @param {unknown} filter - candidate `{ allow?, deny? }`.
 * @returns {{ allow?: string[], deny?: string[] } | undefined} the normalized filter.
 */
function normalizeToolFilter(filter) {
  if (filter === null || typeof filter !== 'object') return undefined
  const out = {}
  if (Array.isArray(filter.allow) && filter.allow.length > 0) out.allow = filter.allow.map((entry) => String(entry))
  if (Array.isArray(filter.deny) && filter.deny.length > 0) out.deny = filter.deny.map((entry) => String(entry))
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Combine a provider-owned restriction with a per-request one: deny lists union,
 * allow lists intersect. A provider-owned policy can therefore only tighten what
 * a caller asked for, never widen it. Two disjoint allow lists keep the empty
 * intersection (`allow: []`), which masks every global tool — dropping the key
 * there would hand the child the unrestricted surface the provider meant to bound.
 * @param {{ allow?: string[], deny?: string[] } | undefined} base - provider policy.
 * @param {{ allow?: string[], deny?: string[] } | undefined} extra - request policy.
 * @returns {{ allow?: string[], deny?: string[] } | undefined} the merged filter.
 */
function mergeToolFilters(base, extra) {
  if (base === undefined) return extra
  if (extra === undefined) return base
  let allow
  if (base.allow === undefined) allow = extra.allow
  else if (extra.allow === undefined) allow = base.allow
  else allow = base.allow.filter((entry) => extra.allow.includes(entry))
  const deny = [...new Set([...(base.deny ?? []), ...(extra.deny ?? [])])]
  const merged = {
    ...(allow === undefined ? {} : { allow }),
    ...(deny.length === 0 ? {} : { deny }),
  }
  return Object.keys(merged).length === 0 ? undefined : merged
}

/**
 * Register the strict-contract `flash` provider.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the row's context.
 * @param {object} [config] - composition row config.
 * @param {string} [config.providerName] - provider name registered on `ctx.subagents`.
 * @param {string} [config.baseProvider] - registered provider that performs the run.
 * @param {string} [config.provider] - pinned LLM provider route.
 * @param {string} [config.model] - pinned LLM model id.
 * @param {string} [config.persona] - child persona; a request-supplied persona wins.
 * @param {number} [config.maxChildDepth] - deepest delegating parent allowed; 0 = top-level only.
 * @param {{ allow?: string[], deny?: string[] }} [config.toolFilter] - child tool restriction.
 */
function apply(ctx, config = {}) {
  const providerName = stringOr(config.providerName, DEFAULTS.providerName)
  const baseProviderName = stringOr(config.baseProvider, DEFAULTS.baseProvider)
  const route = Object.freeze({
    provider: stringOr(config.provider, DEFAULTS.provider),
    model: stringOr(config.model, DEFAULTS.model),
  })
  const persona = stringOr(config.persona, undefined)
  const configuredFilter = normalizeToolFilter(config.toolFilter)
  const maxChildDepth = Number.isSafeInteger(config.maxChildDepth) && config.maxChildDepth >= 0
    ? config.maxChildDepth
    : DEFAULTS.maxChildDepth

  /** Resolve the base provider at call time so reloads cannot strand this row. */
  const baseProvider = () => {
    const base = ctx.subagents.getProvider(baseProviderName)
    if (base === undefined) {
      throw new Error(
        `subagent provider "${providerName}" cannot start a child: base provider "${baseProviderName}" is not registered`,
      )
    }
    return base
  }

  ctx.subagents.registerProvider({
    name: providerName,
    // The base provider owns the run mechanics; this row enforces a route, a
    // child tool restriction, and (optionally) a persona, so it advertises the
    // capabilities it actually honors.
    capabilities: {
      agentOptions: true,
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    },
    inheritsParentContext: false,
    // Consumed by dsh-tool-subagent as the baseline for route preflight and for
    // the wording it shows the model. Enforcement happens in `start` below.
    agentRouteDefaults: { provider: route.provider, model: route.model },
    start(request) {
      const requested = request.agentOptions ?? {}
      // STRICT CONTRACT: the route is fixed. Caller-supplied provider/model are
      // dropped so this backend can never silently run on another model; every
      // other requested option (reasoningEffort, maxTokens) still passes through.
      const { provider: _droppedProvider, model: _droppedModel, ...passthrough } = requested
      const mergedFilter = mergeToolFilters(configuredFilter, request.toolFilter)
      // LEAF GUARD: refuse to deepen a chain that is already delegated. Every
      // flash child — delegation tool, workflow `agent()`, or Ralph round — is
      // created through this provider, so this is the single choke point that
      // keeps a cheap child from recursively spawning more cheap children. It is
      // independent of tool names, unlike a `toolFilter` deny list.
      const parentDepth = delegationDepthOf(request.parent)
      if (parentDepth > maxChildDepth) {
        throw new Error(
          `subagent provider "${providerName}" refuses to deepen a delegation chain: the delegating parent is at depth ${parentDepth}, above maxChildDepth ${maxChildDepth}`,
        )
      }
      return baseProvider().start({
        ...request,
        agentOptions: { ...passthrough, provider: route.provider, model: route.model },
        ...(mergedFilter === undefined ? {} : { toolFilter: mergedFilter }),
        ...(request.persona === undefined && persona !== undefined ? { persona } : {}),
      })
    },
  })
}

export { apply, inject, name }
