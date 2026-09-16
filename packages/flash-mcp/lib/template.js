/**
 * The tiny template renderer the installer uses to generate profile compositions.
 *
 * Why a renderer at all: the route, the engine caps and the guard's lists used to be
 * spelled in the profile YAML *and* in `install.mjs` *and* in the service defaults, and
 * the read-only profile was derived by string-replacing `mode: workspace-write` in the
 * rendered text — the kind of edit that silently generates a different policy the day a
 * comment happens to contain the same words. Placeholders make the substitution explicit
 * and make an unrendered one an error rather than a surprise.
 *
 * Two forms, deliberately different:
 *
 *   `${route.model}`   a VALUE: rendered as JSON, so a string carrying a colon
 *                      (`deepseek-v4.1-flash:cloud`) and a list (`[".git"]`) are both
 *                      unambiguous YAML rather than something the parser has to guess at.
 *   `@{profile.name}`  RAW text: for comments and marker lines, where a quoted string
 *                      would corrupt the marker the installer later searches for.
 *
 * A consequence worth knowing before writing a template: it cannot *mention* either
 * sigil, even inside a comment. Prose such as "every dollar-brace is a value" is itself
 * a placeholder, and the renderer will try to resolve it and then refuse the leftover.
 * That is deliberate — a template quietly shipping an unrendered placeholder would boot a
 * profile with no usable route — and it cost this file's own header comment one rewrite.
 *
 * @module flash-mcp/template
 */

/** A placeholder rendered as a JSON value. */
const VALUE_PLACEHOLDER = /\$\{([A-Za-z0-9_.]+)\}/g

/** A placeholder rendered as raw text. */
const RAW_PLACEHOLDER = /@\{([A-Za-z0-9_.]+)\}/g

/** Anything left that still looks like a placeholder after rendering. */
const LEFTOVER = /\$\{|@\{/

/**
 * Read a dotted path out of a nested object.
 *
 * @param {object} values - the value tree.
 * @param {string} path - a dotted path such as `limits.slots`.
 * @returns {unknown} the value, or undefined when any step is missing.
 */
export function lookupPath(values, path) {
  let current = values
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined
    current = current[key]
  }
  return current
}

/**
 * Render a template against a value tree.
 *
 * Every placeholder must resolve. An unknown path, or a placeholder left behind by a
 * partial substitution, throws with the source named — a generated composition that
 * quietly contains `${route.model}` would boot a profile with no usable route, which is
 * far worse than failing the install.
 *
 * @param {string} text - the template.
 * @param {object} values - the value tree placeholders are resolved against.
 * @param {object} [options] - reporting options.
 * @param {string} [options.source] - the file the template came from, used in errors.
 * @returns {string} the rendered text.
 * @throws {Error} when a placeholder cannot be resolved, or one survives rendering.
 */
export function renderTemplate(text, values, { source = 'template' } = {}) {
  if (typeof text !== 'string') throw new Error(`${source} is not text`)
  const missing = []
  const resolve = (path, render) => {
    const value = lookupPath(values, path)
    if (value === undefined) {
      missing.push(path)
      return ''
    }
    return render(value)
  }
  const rendered = text
    .replace(RAW_PLACEHOLDER, (_, path) => resolve(path, (value) => String(value)))
    .replace(VALUE_PLACEHOLDER, (_, path) => resolve(path, (value) => JSON.stringify(value)))
  if (missing.length > 0) {
    throw new Error(`${source} names settings that do not exist: ${[...new Set(missing)].join(', ')}`)
  }
  if (LEFTOVER.test(rendered)) {
    throw new Error(`${source} still holds an unrendered placeholder after substitution`)
  }
  return rendered
}
