/**
 * Contract tests for the `flash` provider row.
 *
 * The provider is a plain Cordis plugin module, so it can be exercised without a
 * harness process: a stub context records what the row registers, and the tests
 * assert the strict routing contract, the leaf delegation ceiling, and the child
 * policy the row enforces.
 *
 * Run with: node --test packages/dsh-subagent-flash/test/
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../lib/index.js'

/**
 * Minimal `ctx.subagents` stub plus a base provider that records its start request.
 * @param {object} [config] - composition row config.
 * @param {string[]} [bases] - registered base provider names.
 */
function harness(config = {}, bases = ['spawn']) {
  const started = []
  const providers = new Map()
  for (const base of bases) {
    providers.set(base, {
      name: base,
      capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start(request) {
        started.push(request)
        return Promise.resolve({ id: 'child', localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: () => Promise.resolve() })
      },
    })
  }
  const registered = []
  const ctx = {
    subagents: {
      getProvider: (providerName) => providers.get(providerName),
      registerProvider: (provider) => {
        registered.push(provider)
        providers.set(provider.name, provider)
        return () => providers.delete(provider.name)
      },
    },
  }
  apply(ctx, config)
  return { registered, started, providers, provider: registered[0] }
}

/**
 * A start request as the subagent seam would hand it to a provider.
 * @param {object | undefined} agentOptions - requested child options.
 * @param {object} [extra] - extra request fields.
 */
function startRequest(agentOptions, extra = {}) {
  return {
    label: 'task',
    prompt: [{ type: 'text', text: 'do it' }],
    parent: { id: 'parent' },
    signal: new AbortController().signal,
    descriptor: { mode: 'one-shot', label: 'task' },
    ...(agentOptions === undefined ? {} : { agentOptions }),
    ...extra,
  }
}

/** A parent agent at an explicit delegation depth. */
function parentAt(depth, runtimeDepth) {
  return {
    id: 'parent',
    options: runtimeDepth === undefined ? {} : { subagentDepth: runtimeDepth },
    session: { header: { delegationDepth: depth } },
  }
}

test('the module exposes the Cordis plugin row shape', () => {
  assert.equal(name, 'subagent-flash-in-process')
  assert.deepEqual(inject, ['subagents'])
})

test('registers one provider named flash that delegates to the base provider', () => {
  const { registered, provider } = harness()
  assert.equal(registered.length, 1)
  assert.equal(provider.name, 'flash')
  assert.equal(provider.inheritsParentContext, false)
  assert.deepEqual(provider.capabilities, { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true })
})

test('advertises the pinned route as agentRouteDefaults', () => {
  const { provider } = harness()
  assert.deepEqual(provider.agentRouteDefaults, { provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' })
})

test('refuses continuable children instead of letting their route escape the contract', () => {
  const { provider } = harness()
  assert.equal(provider.prepareContinuable, undefined)
})

test('forces the pinned route over a conflicting caller route', async () => {
  const { provider, started } = harness()
  await provider.start(startRequest({ provider: 'deepseek-official', model: 'deepseek-flash' }))
  assert.equal(started.length, 1)
  assert.equal(started[0].agentOptions.provider, 'ollama')
  assert.equal(started[0].agentOptions.model, 'deepseek-v4.1-flash:cloud')
})

test('forces the pinned route when the caller supplies no options at all', async () => {
  const { provider, started } = harness()
  await provider.start(startRequest(undefined))
  assert.equal(started[0].agentOptions.provider, 'ollama')
  assert.equal(started[0].agentOptions.model, 'deepseek-v4.1-flash:cloud')
})

test('keeps caller-supplied tuning while dropping caller-supplied routing', async () => {
  const { provider, started } = harness()
  await provider.start(startRequest({ provider: 'ollama', model: 'glm-5.3:cloud', reasoningEffort: 'high', maxTokens: 2048 }))
  assert.deepEqual(started[0].agentOptions, {
    provider: 'ollama',
    model: 'deepseek-v4.1-flash:cloud',
    reasoningEffort: 'high',
    maxTokens: 2048,
  })
})

test('honors a configured route override in the row config', async () => {
  const { provider, started } = harness({ provider: 'ollama', model: 'deepseek-v4-flash:cloud' })
  assert.deepEqual(provider.agentRouteDefaults, { provider: 'ollama', model: 'deepseek-v4-flash:cloud' })
  await provider.start(startRequest({ model: 'gemma4:31b-cloud' }))
  assert.equal(started[0].agentOptions.model, 'deepseek-v4-flash:cloud')
})

test('refuses to deepen a chain that is already delegated', () => {
  const { provider } = harness()
  assert.throws(
    () => provider.start(startRequest(undefined, { parent: parentAt(1) })),
    /refuses to deepen a delegation chain/,
  )
})

test('starts a child for a top-level parent and passes its maxDepth through', async () => {
  const { provider, started } = harness()
  await provider.start(startRequest(undefined, { maxDepth: 1 }))
  assert.equal(started[0].maxDepth, 1)
  await provider.start(startRequest(undefined))
  assert.equal('maxDepth' in started[1], false)
})

test('honors a raised maxChildDepth for deliberate nesting', async () => {
  const { provider, started } = harness({ maxChildDepth: 2 })
  await provider.start(startRequest(undefined, { parent: parentAt(2) }))
  assert.equal(started.length, 1)
  assert.throws(
    () => provider.start(startRequest(undefined, { parent: parentAt(3) })),
    /refuses to deepen a delegation chain/,
  )
})

test('reads the deeper of the persisted header and the runtime option', () => {
  const { provider } = harness()
  assert.throws(() => provider.start(startRequest(undefined, { parent: parentAt(2, 5) })), /depth 5/)
  assert.throws(() => provider.start(startRequest(undefined, { parent: parentAt(5, 2) })), /depth 5/)
})

test('rejects a corrupt runtime depth instead of silently flattening it', () => {
  const { provider } = harness()
  assert.throws(() => provider.start(startRequest(undefined, { parent: parentAt(0, -1) })), /non-negative safe integer/)
})

test('carries no composition-agnostic tool filter of its own', async () => {
  // tools.restrict() throws on any name the composition does not define, which
  // would fail the whole child start, so the row must not ship a universal list.
  const { provider, started } = harness()
  await provider.start(startRequest(undefined))
  assert.equal('toolFilter' in started[0], false)
})

test('passes a row-owned tool filter through unchanged', async () => {
  const { provider, started } = harness({ toolFilter: { deny: ['bash', 'write'] } })
  await provider.start(startRequest(undefined))
  assert.deepEqual(started[0].toolFilter, { deny: ['bash', 'write'] })
})

test('unions deny lists so a provider policy can only tighten a request policy', async () => {
  const { provider, started } = harness({ toolFilter: { deny: ['workflow'] } })
  await provider.start(startRequest(undefined, { toolFilter: { deny: ['bash', 'workflow'] } }))
  assert.deepEqual(started[0].toolFilter.deny.sort(), ['bash', 'workflow'])
})

test('intersects allow lists and keeps both sides of the policy', async () => {
  const { provider, started } = harness({ toolFilter: { allow: ['read', 'grep', 'bash'] } })
  await provider.start(startRequest(undefined, { toolFilter: { allow: ['read', 'bash', 'write'], deny: ['bash'] } }))
  assert.deepEqual(started[0].toolFilter.allow.sort(), ['bash', 'read'])
  assert.deepEqual(started[0].toolFilter.deny, ['bash'])
})

test('masks every global tool when the allow lists are disjoint', async () => {
  const { provider, started } = harness({ toolFilter: { allow: ['read'] } })
  await provider.start(startRequest(undefined, { toolFilter: { allow: ['bash'] } }))
  assert.deepEqual(started[0].toolFilter, { allow: [] })
})

test('applies the configured persona only when the caller supplied none', async () => {
  const { provider, started } = harness({ persona: 'row persona' })
  await provider.start(startRequest(undefined))
  assert.equal(started[0].persona, 'row persona')
  await provider.start(startRequest(undefined, { persona: 'tool persona' }))
  assert.equal(started[1].persona, 'tool persona')
})

test('fails loudly when the base provider is not registered', () => {
  const { provider } = harness({}, ['fork'])
  assert.throws(() => provider.start(startRequest(undefined)), /base provider "spawn" is not registered/)
})

test('resolves the base provider per call so a provider reload cannot strand the row', async () => {
  const { provider, providers, started } = harness()
  providers.delete('spawn')
  assert.throws(() => provider.start(startRequest(undefined)), /not registered/)
  providers.set('spawn', {
    name: 'spawn',
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    start(request) {
      started.push(request)
      return Promise.resolve({})
    },
  })
  await provider.start(startRequest(undefined))
  assert.equal(started.length, 1)
})

test('accepts a custom providerName and baseProvider', () => {
  const { provider, registered } = harness({ providerName: 'flash-cheap', baseProvider: 'fork' }, ['fork'])
  assert.equal(provider.name, 'flash-cheap')
  assert.equal(registered.length, 1)
})
