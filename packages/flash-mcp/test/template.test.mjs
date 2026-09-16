/**
 * Renderer contract tests, plus one test that matters more than the rest: the shipped
 * profile template must render to a composition that actually carries the configured
 * route, with nothing left unsubstituted. That is the property which makes
 * `flash.config.json` the source of truth rather than a second copy of it.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { loadConfig } from '../lib/config.js'
import { lookupPath, renderTemplate } from '../lib/template.js'

/** The authored service composition, as the installer reads it. */
function profileTemplate() {
  return readFileSync(new URL('../../../profiles/flash-service/cordis.patch.yml', import.meta.url), 'utf8')
}

/** The value tree the installer renders that template against. */
function values({ name = 'flash-service', mode = 'workspace-write' } = {}) {
  return { ...loadConfig({ env: {} }), profile: { name }, sandbox: { mode } }
}

test('a value placeholder renders as JSON and raw renders as text', () => {
  const rendered = renderTemplate('model: ${route.model}\n# >>> @{profile.name}', values())
  assert.equal(rendered, 'model: "deepseek-v4.1-flash:cloud"\n# >>> flash-service')
})

test('lists render as flow sequences a YAML parser cannot misread', () => {
  const rendered = renderTemplate('segments: ${guard.protectedSegments}', values())
  assert.equal(rendered, 'segments: [".git"]')
  assert.equal(renderTemplate('n: ${limits.slots}', values()), 'n: 2')
  assert.equal(renderTemplate('b: ${guard.fenceMutations}', values()), 'b: true')
})

test('an unknown setting is refused, naming the path and the source', () => {
  assert.throws(
    () => renderTemplate('x: ${limits.nope}\ny: ${route.alsoNope}', values(), { source: 'profile.yml' }),
    (error) => {
      assert.match(error.message, /profile\.yml names settings that do not exist/)
      assert.match(error.message, /limits\.nope/)
      assert.match(error.message, /route\.alsoNope/)
      return true
    },
  )
})

test('a placeholder that survives rendering is an error, not output', () => {
  // `@{...}` is rendered first, so a raw substitution that produces a value placeholder
  // must not be left in the output as text.
  assert.throws(() => renderTemplate('x: ${route.model', values()), /unrendered placeholder/)
})

test('lookupPath walks a dotted path and stops at a gap', () => {
  assert.equal(lookupPath({ a: { b: 1 } }, 'a.b'), 1)
  assert.equal(lookupPath({ a: { b: 1 } }, 'a.c'), undefined)
  assert.equal(lookupPath({ a: 1 }, 'a.b.c'), undefined)
  assert.equal(lookupPath(null, 'a'), undefined)
})

test('the shipped profile template renders with the configured route and no leftovers', () => {
  const config = loadConfig({ env: {} })
  const rendered = renderTemplate(profileTemplate(), values(), { source: 'flash-service' })
  assert.doesNotMatch(rendered, /\$\{|@\{/)
  assert.ok(rendered.includes(`model: ${JSON.stringify(config.route.model)}`))
  assert.ok(rendered.includes(`maxConcurrentAgents: ${String(config.limits.maxConcurrentAgents)}`))
  assert.ok(rendered.includes(`homeProtectedPaths: ${JSON.stringify(config.guard.homeProtectedPaths)}`))
  // The markers the installer searches for survive rendering verbatim.
  assert.ok(rendered.includes('# >>> flash-service (managed by install.mjs'))
  assert.ok(rendered.includes('# <<< flash-service'))
  assert.ok(rendered.includes('mode: "workspace-write"'))
})

test('the read-only profile is the same template with one different value', () => {
  const writing = renderTemplate(profileTemplate(), values(), { source: 'w' })
  const reading = renderTemplate(profileTemplate(), values({ name: 'flash-service-readonly', mode: 'read-only' }), { source: 'r' })
  assert.ok(reading.includes('mode: "read-only"'))
  assert.equal(reading.includes('mode: "workspace-write"'), false)
  assert.ok(reading.includes('# >>> flash-service-readonly (managed by install.mjs'))
  // Nothing else differs: the two differ only where the values do.
  const normalise = (text) => text.replaceAll('flash-service-readonly', 'flash-service').replaceAll('"read-only"', '"workspace-write"')
  assert.equal(normalise(reading), normalise(writing))
})
