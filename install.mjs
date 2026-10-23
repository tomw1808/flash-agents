#!/usr/bin/env node
/**
 * install.mjs — idempotent installer for the flash-agent pieces.
 *
 * This repository is the single source of truth. The installer only materializes
 * generated copies where DeepSeek Harness must read them:
 *
 *   1. `$DSH_HOME/.agent-presets/flash-orchestrator/`       — the interactive preset the roster scans
 *   2. `$DSH_HOME/profiles/<profile>/plugins/`              — the compiled-in `flash` provider row
 *   3. `$DSH_HOME/profiles/<profile>/cordis.patch.yml`      — one managed marker block registering it
 *   4. `$DSH_HOME/profiles/flash-service/`                  — the headless SDK profile behind `flash-mcp`
 *   5. `$DSH_HOME/profiles/flash-service-readonly/`         — the same profile with a read-only sandbox
 *
 * Every step replaces what it wrote before, so rerunning the script updates the
 * registration instead of appending duplicates. The flash-service profile is
 * created here and its patch block is managed the same way; skeleton files are
 * written only when absent so local edits to that profile survive an update.
 *
 * Usage:
 *   node install.mjs                 # install or update
 *   node install.mjs --dry-run       # print the plan, write nothing
 *   node install.mjs --uninstall     # remove the preset, the provider copy, and both managed blocks
 *   node install.mjs --profile p     # target interactive profile (default: $DSH_PROFILE or "web")
 *   node install.mjs --home /path    # target harness home (default: $DSH_HOME or ~/.dsh)
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { loadConfig } from './packages/flash-mcp/lib/config.js'
import { renderTemplate } from './packages/flash-mcp/lib/template.js'

const REPO_ROOT = dirname(fileURLToPath(import.meta.url))
/** The one source of truth for the route, the limits and the guard's lists. */
const CONFIG = loadConfig()
const PRESET_ID = 'flash-orchestrator'
const SERVICE_PROFILE = 'flash-service'
/** The narrow variant: same worker, a sandbox that denies every write. */
const READONLY_PROFILE = 'flash-service-readonly'
const PROVIDER_FILE = 'dsh-subagent-flash.js'
const GUARD_FILE = 'dsh-flash-guard.js'
const ROW_ID = 'subagent-flash-in-process'
const MARKER_START = `# >>> ${PRESET_ID} (managed by install.mjs — do not edit between the markers)`
const MARKER_END = `# <<< ${PRESET_ID}`
const SERVICE_MARKER_START = `# >>> ${SERVICE_PROFILE} (managed by install.mjs — do not edit between the markers)`
const SERVICE_MARKER_END = `# <<< ${SERVICE_PROFILE}`
/** The release this installer came from, stamped beside the plugins it copies. */
const FLASH_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'flash-mcp', 'package.json'), 'utf8')).version

/** Parse `--flag value` pairs from argv. */
function parseArgs(argv) {
  const options = { dryRun: false, uninstall: false, profile: process.env.DSH_PROFILE || 'web', home: process.env.DSH_HOME || join(homedir(), '.dsh') }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--profile') options.profile = argv[++index]
    else if (arg === '--home') options.home = argv[++index]
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (options.profile === undefined || options.profile === '') throw new Error('--profile requires a value')
  if (options.home === undefined || options.home === '') throw new Error('--home requires a value')
  return options
}

/** The managed patch block: one `insert` adding this project's provider row. */
function patchBlock() {
  return `${MARKER_START}
# The provider itself carries the strict route and the depth guard. It ships no
# tool deny list on purpose: tools.restrict() throws on a name the composition
# does not define, so a host-wide list would break delegation in every preset
# that does not happen to register all of those names.
- insert:
    - id: ${ROW_ID}
      name: ./plugins/${PROVIDER_FILE}
      config:
        providerName: flash
        baseProvider: spawn
        provider: ${JSON.stringify(CONFIG.route.provider)}
        model: ${JSON.stringify(CONFIG.route.model)}
        maxChildDepth: 0
${MARKER_END}
`
}

/**
 * Render the service composition template for one profile.
 *
 * The same template serves both profiles: the writing one and the read-only one differ
 * by the two values passed here, which is why the read-only variant is no longer
 * produced by replacing words in already-generated text.
 *
 * @param {string} profileName - the profile the rendered composition belongs to.
 * @param {string} sandboxMode - `workspace-write` or `read-only`.
 * @returns {string} the rendered composition.
 */
function renderServiceComposition(profileName, sandboxMode) {
  const source = join(REPO_ROOT, 'profiles', SERVICE_PROFILE, 'cordis.patch.yml')
  if (!existsSync(source)) throw new Error(`missing flash-service composition template: ${source}`)
  return renderTemplate(readFileSync(source, 'utf8'), { ...CONFIG, profile: { name: profileName }, sandbox: { mode: sandboxMode } }, { source })
}

/** The marker-delimited block for the headless SDK profile, rendered from the template. */
function servicePatchBlock() {
  const source = join(REPO_ROOT, 'profiles', SERVICE_PROFILE, 'cordis.patch.yml')
  const text = renderServiceComposition(SERVICE_PROFILE, 'workspace-write')
  const start = text.indexOf(SERVICE_MARKER_START)
  const end = text.indexOf(SERVICE_MARKER_END)
  if (start < 0 || end < 0) {
    throw new Error(`${source} must contain both ${SERVICE_PROFILE} markers`)
  }
  return `${text.slice(start, end + SERVICE_MARKER_END.length)}\n`
}

/** Strip YAML comments and whitespace to judge whether a document carries entries. */
function meaningfulBody(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .join('\n')
}

/**
 * The offset of a marker that stands on its own line, and the offset just past it.
 *
 * A substring search is wrong here, and not hypothetically: the generated header used to
 * mention the start marker in prose, so `indexOf` found that sentence instead of the
 * block, and every rerun sliced the document from inside a comment. The installed patch
 * ended up without the marker line it is keyed by, and with the sentence cut in half. A
 * marker therefore counts only as a whole line.
 *
 * @param {string} text - the document to search.
 * @param {string} marker - the marker line to find.
 * @returns {{start: number, after: number} | undefined} the line's bounds, or undefined.
 */
function findMarkerLine(text, marker) {
  let offset = 0
  for (const line of text.split('\n')) {
    if (line.trim() === marker) return { start: offset, after: offset + line.length + 1 }
    offset += line.length + 1
  }
  return undefined
}

/**
 * Idempotently place a managed block in the profile patch document.
 * @param {string} current - current patch text ('' when absent).
 * @param {object} managed - the block and its markers.
 * @returns {string} the new patch text.
 */
function withManagedBlock(current, { block, startMarker, endMarker }) {
  const opening = findMarkerLine(current, startMarker)
  if (opening !== undefined) {
    const closing = findMarkerLine(current, endMarker)
    if (closing === undefined) throw new Error(`profile patch has "${startMarker}" without its end marker; repair the file manually`)
    return current.slice(0, opening.start) + block + current.slice(closing.after)
  }
  const body = meaningfulBody(current)
  if (body === '' || body === '[]') {
    return `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
#
# The generated block below is managed by
# ${join(REPO_ROOT, 'install.mjs')} and replaced on every run. Do not edit between its
# own opening and closing marker lines; anything outside them is yours and is preserved.
${block}`
  }
  if (!body.startsWith('[') && !body.startsWith('-')) {
    throw new Error('profile patch is not a top-level YAML array; refusing to modify it')
  }
  return `${current.replace(/\s*$/, '')}\n\n${block}`
}

/** Remove the managed block, restoring the empty document when nothing else remains. */
function withoutManagedBlock(current, { startMarker, endMarker }) {
  const opening = findMarkerLine(current, startMarker)
  if (opening === undefined) return current
  const closing = findMarkerLine(current, endMarker)
  if (closing === undefined) throw new Error(`profile patch has "${startMarker}" without its end marker; repair the file manually`)
  const stripped = current.slice(0, opening.start) + current.slice(closing.after)
  return meaningfulBody(stripped) === '' ? '[]\n' : stripped
}

/** Copy a directory, replacing any previous generated copy. */
function replaceDir(source, target, dryRun) {
  if (!existsSync(source)) throw new Error(`missing source directory: ${source}`)
  if (!dryRun) {
    rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target, { recursive: true })
  }
  return `replaced ${target}`
}

/** Copy one file, replacing any previous generated copy. */
function replaceFile(source, target, dryRun) {
  if (!existsSync(source)) throw new Error(`missing source file: ${source}`)
  if (!dryRun) {
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target)
  }
  return `replaced ${target}`
}

/**
 * Write the generated `package.json` beside a profile's copied plugins.
 *
 * Both plugin files are ES modules (they end in `export { … }`), and a profile's own
 * seeded `package.json` is left alone because the user may have edited it. Without a
 * `package.json` in the plugins folder Node treats each `.js` file as CommonJS and prints
 * `MODULE_TYPELESS_PACKAGE_JSON` five times at every runtime start, so this generated
 * file both silences that and records the release that wrote the plugins. It always
 * replaces what was there, exactly like `replaceFile`.
 *
 * @param {string} profileDir - the installed profile directory.
 * @param {boolean} dryRun - report without writing.
 * @returns {string} the report line.
 */
function writePluginPackage(profileDir, dryRun) {
  const target = join(profileDir, 'plugins', 'package.json')
  const next = `${JSON.stringify({ private: true, type: 'module', flashAgents: { version: FLASH_VERSION } }, null, 2)}\n`
  if (!dryRun) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, next)
  }
  return `replaced ${target}`
}

/**
 * Whether a plugins `package.json` is the one this installer writes.
 *
 * The stamp carries `flashAgents.version`; that marker is also what uninstall uses to
 * decide whether the file belongs to this installer or to the profile's owner.
 *
 * @param {string} file - the `package.json` to inspect.
 * @returns {boolean} true when it carries this installer's stamp.
 */
function isOwnPluginPackage(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed?.flashAgents?.version === 'string' && parsed.flashAgents.version.length > 0
  } catch {
    return false
  }
}

/**
 * Whether one plugin file is an ES module, judged by asking the parser.
 *
 * A line test alone cannot tell a real `export` from one quoted in a comment, and a
 * CommonJS file may mention an old export that way. The file is therefore compiled the
 * way Node compiles a CommonJS module — wrapped in the function that supplies `exports`,
 * `require`, `module`, `__filename` and `__dirname` — and only a file that fails that
 * parse is a candidate for ESM. A file that parses as CommonJS is CommonJS, whatever its
 * comments say. The second condition keeps a genuinely broken file from being declared a
 * module: ESM syntax is exactly an `import`/`export` statement at the start of a line.
 *
 * @param {string} file - the file to read.
 * @returns {boolean} true when it is ESM by both the parse and the statement test.
 */
function isEsmFile(file) {
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    return false
  }
  try {
    // Compiling, not running: the wrapper only supplies the CommonJS bindings the source
    // may mention, and a script that compiles here is what Node would load as CommonJS.
    new vm.Script(`(function (exports, require, module, __filename, __dirname) {${source}\n})`, { filename: file })
  } catch (error) {
    if (!(error instanceof SyntaxError)) return false
    // Either ESM syntax or a real syntax error; the statement test below separates them.
    return /^\s*(import|export)\s/m.test(source)
  }
  return false
}

/**
 * Report a plugins folder that cannot be declared a module, withdrawing this installer's
 * own stamp first.
 *
 * The stamp may already be there from an earlier run. Leaving it would declare a CommonJS
 * file a module and change how the user's own plugins load — the one thing the interactive
 * stamp must never do — so it is removed, and the report says it was ours and why. A folder
 * with no stamp of ours keeps the older "without a package.json" wording, which is true
 * there.
 *
 * @param {object} options - what to inspect.
 * @param {string} options.target - the plugins `package.json`.
 * @param {string} options.folder - the plugins folder, named when it has no stamp.
 * @param {string} options.file - the file that is not an ES module.
 * @param {boolean} options.dryRun - report without removing.
 * @returns {string} the report line.
 */
function reportNotEsmPlugin({ target, folder, file, dryRun }) {
  if (!existsSync(target)) return `left ${folder} without a package.json: ${file} is not an ES module`
  if (!dryRun) rmSync(target, { force: true })
  return `removed ${target}: ${file} is not an ES module, so the folder is no longer declared one`
}

/**
 * Write the module stamp into the interactive profile's plugins folder, when it is safe.
 *
 * The interactive profile is the user's own: it may already hold their CommonJS plugins,
 * which `"type": "module"` would break. The file is therefore written only when every
 * `.js` file in the folder is ESM (by the same test `assertPluginsAreEsm` uses) and there
 * is either no `package.json` or one this installer wrote. A foreign `package.json` is left
 * alone. When a rerun finds the folder no longer qualifies, this installer's own stamp is
 * withdrawn — leaving it would make the folder load its CommonJS files as modules — and the
 * report names the file that stopped it.
 *
 * @param {object} options - what to inspect.
 * @param {string} options.profileDir - the interactive profile directory.
 * @param {string} options.providerSource - this repository's provider file, about to be copied.
 * @param {boolean} options.dryRun - report without writing.
 * @returns {string} the report line.
 */
function writeInteractivePluginPackage({ profileDir, providerSource, dryRun }) {
  const folder = join(profileDir, 'plugins')
  const target = join(folder, 'package.json')
  if (existsSync(target) && !isOwnPluginPackage(target)) {
    return `left ${folder}'s own package.json alone`
  }
  const files = existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith('.js')) : []
  for (const name of files) {
    // The provider copy is replaced from this repository's ESM source just before this
    // runs; checking the old file in the folder would judge a file that is about to go.
    if (name === PROVIDER_FILE) continue
    const file = join(folder, name)
    if (!isEsmFile(file)) return reportNotEsmPlugin({ target, folder, file, dryRun })
  }
  if (!isEsmFile(providerSource)) {
    return reportNotEsmPlugin({ target, folder, file: join(folder, PROVIDER_FILE), dryRun })
  }
  return writePluginPackage(profileDir, dryRun)
}

/**
 * Remove a plugins `package.json` only when it carries this installer's stamp.
 *
 * A file without `flashAgents` is the profile owner's, even when it sits where this
 * installer writes its stamp; uninstall must not delete it.
 *
 * @param {string} profileDir - the installed profile directory.
 * @param {boolean} dryRun - report without removing.
 * @returns {string | undefined} a report line when the file was this installer's.
 */
function removeOwnPluginPackage(profileDir, dryRun) {
  const target = join(profileDir, 'plugins', 'package.json')
  if (!existsSync(target) || !isOwnPluginPackage(target)) return undefined
  if (!dryRun) rmSync(target, { force: true })
  return `removed ${target}`
}

/**
 * Refuse to declare the plugins folder a module unless every copied file is one.
 *
 * `"type": "module"` governs every `.js` file in the folder, so a CommonJS plugin copied
 * beside an ESM one would stop loading. The files are this repository's own and are ESM
 * today; the check is here so a future plugin cannot silently make the stamp wrong.
 *
 * @param {string[]} sources - the plugin source files this install copies.
 * @returns {void}
 */
function assertPluginsAreEsm(sources) {
  for (const source of sources) {
    if (!isEsmFile(source)) {
      throw new Error(
        `refusing to mark the plugins folder as an ES module: ${source} does not parse as CommonJS and carries no import/export statement, so it is not ESM`,
      )
    }
  }
}

/**
 * Write one profile skeleton file, leaving a pre-existing one alone so local
 * edits to the service profile survive an update.
 */
function seedFile(source, target, dryRun) {
  if (!existsSync(source)) throw new Error(`missing source file: ${source}`)
  const next = readFileSync(source, 'utf8')
  if (existsSync(target)) {
    return readFileSync(target, 'utf8') === next ? `left ${target} unchanged` : `kept existing ${target} (differs from the repo source)`
  }
  if (!dryRun) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, next)
  }
  return `created ${target}`
}

/** Apply the flash-service profile: skeleton, provider copy, and managed patch block. */
function installServiceProfile({ home, providerSource, guardSource, dryRun, report }) {
  const serviceDir = join(home, 'profiles', SERVICE_PROFILE)
  const serviceSource = join(REPO_ROOT, 'profiles', SERVICE_PROFILE)
  const servicePatchPath = join(serviceDir, 'cordis.patch.yml')

  if (!dryRun) mkdirSync(serviceDir, { recursive: true })
  for (const name of ['package.json', 'cordis.yml', 'pnpm-workspace.yaml']) {
    report.push(seedFile(join(serviceSource, name), join(serviceDir, name), dryRun))
  }
  report.push(replaceFile(providerSource, join(serviceDir, 'plugins', PROVIDER_FILE), dryRun))
  report.push(replaceFile(guardSource, join(serviceDir, 'plugins', GUARD_FILE), dryRun))
  report.push(writePluginPackage(serviceDir, dryRun))

  const block = servicePatchBlock()
  const current = existsSync(servicePatchPath) ? readFileSync(servicePatchPath, 'utf8') : ''
  const next = withManagedBlock(current, { block, startMarker: SERVICE_MARKER_START, endMarker: SERVICE_MARKER_END })
  if (next !== current) {
    if (!dryRun) writeFileSync(servicePatchPath, next)
    report.push(`${current === '' ? 'created' : 'updated'} the ${SERVICE_PROFILE} marker block in ${servicePatchPath}`)
  } else {
    report.push(`left the ${SERVICE_PROFILE} marker block in ${servicePatchPath} unchanged`)
  }
}

/**
 * Materialize the read-only variant of the service profile.
 *
 * It is generated, never edited: the composition is this repository's
 * flash-service patch with exactly one policy change — `sandbox-policy.mode`
 * becomes `read-only`, so the file sandbox denies every mutation in that process
 * rather than confining them to the workspace. A caller selects it per call with
 * `mode: "read-only"`, which is the only narrowing this service offers: no mode
 * widens what the standing profile allows.
 */
function installReadOnlyProfile({ home, providerSource, guardSource, dryRun, report }) {
  const serviceSource = join(REPO_ROOT, 'profiles', SERVICE_PROFILE)
  const readOnlyDir = join(home, 'profiles', READONLY_PROFILE)
  if (!dryRun) mkdirSync(readOnlyDir, { recursive: true })
  for (const name of ['package.json', 'cordis.yml', 'pnpm-workspace.yaml']) {
    report.push(seedFile(join(serviceSource, name), join(readOnlyDir, name), dryRun))
  }
  report.push(replaceFile(providerSource, join(readOnlyDir, 'plugins', PROVIDER_FILE), dryRun))
  report.push(replaceFile(guardSource, join(readOnlyDir, 'plugins', GUARD_FILE), dryRun))
  report.push(writePluginPackage(readOnlyDir, dryRun))

  const generated = [
    `# GENERATED by install.mjs from profiles/${SERVICE_PROFILE}/cordis.patch.yml.`,
    `# The only difference is sandbox-policy.mode: read-only — edit the template, not this file.`,
    renderServiceComposition(READONLY_PROFILE, 'read-only'),
  ].join('\n')
  const target = join(readOnlyDir, 'cordis.patch.yml')
  const current = existsSync(target) ? readFileSync(target, 'utf8') : ''
  if (current !== generated) {
    if (!dryRun) writeFileSync(target, generated)
    report.push(`${current === '' ? 'created' : 'regenerated'} the generated ${READONLY_PROFILE} composition in ${target}`)
  } else {
    report.push(`left the generated ${READONLY_PROFILE} composition in ${target} unchanged`)
  }
}

/** Remove the flash-service profile, or just its managed parts when it holds user edits. */
function uninstallServiceProfile({ home, dryRun, report }) {
  const readOnlyDir = join(home, 'profiles', READONLY_PROFILE)
  if (existsSync(readOnlyDir)) {
    if (!dryRun) rmSync(readOnlyDir, { recursive: true, force: true })
    report.push(`removed the generated ${READONLY_PROFILE} profile ${readOnlyDir}`)
  }
  const serviceDir = join(home, 'profiles', SERVICE_PROFILE)
  const servicePatchPath = join(serviceDir, 'cordis.patch.yml')
  if (!existsSync(serviceDir)) return
  if (!existsSync(servicePatchPath)) {
    if (!dryRun) rmSync(serviceDir, { recursive: true, force: true })
    report.push(`removed ${serviceDir}`)
    return
  }
  const current = readFileSync(servicePatchPath, 'utf8')
  const next = withoutManagedBlock(current, { startMarker: SERVICE_MARKER_START, endMarker: SERVICE_MARKER_END })
  if (meaningfulBody(next) === '[]') {
    if (!dryRun) rmSync(serviceDir, { recursive: true, force: true })
    report.push(`removed ${serviceDir}`)
    return
  }
  if (!dryRun) {
    writeFileSync(servicePatchPath, next)
    rmSync(join(serviceDir, 'plugins', PROVIDER_FILE), { force: true })
    rmSync(join(serviceDir, 'plugins', GUARD_FILE), { force: true })
  }
  // The generated stamp belongs to the plugins this installer copied; a package.json
  // without the stamp is the user's and stays put.
  const removedPackage = removeOwnPluginPackage(serviceDir, dryRun)
  if (removedPackage !== undefined) report.push(removedPackage)
  report.push(`removed the ${SERVICE_PROFILE} marker block from ${servicePatchPath} (other profile entries were kept)`)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '') + '\n')
    return
  }

  const home = resolve(options.home)
  const profileDir = join(home, 'profiles', options.profile)
  const presetTarget = join(home, '.agent-presets', PRESET_ID)
  const providerTarget = join(profileDir, 'plugins', PROVIDER_FILE)
  const patchPath = join(profileDir, 'cordis.patch.yml')

  const presetSource = join(REPO_ROOT, 'presets', PRESET_ID)
  const providerSource = join(REPO_ROOT, 'packages', 'dsh-subagent-flash', 'lib', 'index.js')
  const guardSource = join(REPO_ROOT, 'packages', 'dsh-flash-guard', 'lib', 'index.js')

  if (!existsSync(presetSource)) throw new Error(`missing preset source: ${presetSource}`)
  if (!existsSync(providerSource)) throw new Error(`missing provider source: ${providerSource}`)
  if (!existsSync(guardSource)) throw new Error(`missing guard source: ${guardSource}`)
  // The generated plugins/package.json declares the folder a module, so every file the
  // profile copies there must really be ESM.
  assertPluginsAreEsm([providerSource, guardSource])

  const report = []
  if (options.uninstall) {
    if (existsSync(presetTarget)) {
      if (!options.dryRun) rmSync(presetTarget, { recursive: true, force: true })
      report.push(`removed ${presetTarget}`)
    }
    if (existsSync(providerTarget)) {
      if (!options.dryRun) rmSync(providerTarget, { force: true })
      report.push(`removed ${providerTarget}`)
    }
    const removedPackage = removeOwnPluginPackage(profileDir, options.dryRun)
    if (removedPackage !== undefined) report.push(removedPackage)
    if (existsSync(patchPath)) {
      const current = readFileSync(patchPath, 'utf8')
      const next = withoutManagedBlock(current, { startMarker: MARKER_START, endMarker: MARKER_END })
      if (next !== current && !options.dryRun) writeFileSync(patchPath, next)
      report.push(`removed the ${PRESET_ID} marker block from ${patchPath}`)
    }
    uninstallServiceProfile({ home, dryRun: options.dryRun, report })
    process.stdout.write(`${report.join('\n')}\n`)
    return
  }

  report.push(replaceDir(presetSource, presetTarget, options.dryRun))
  report.push(replaceFile(providerSource, providerTarget, options.dryRun))
  // The interactive profile keeps the user's own plugins; the stamp is written only when
  // doing so cannot change how their files are loaded.
  report.push(
    writeInteractivePluginPackage({ profileDir, providerSource, dryRun: options.dryRun }),
  )

  const currentPatch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const nextPatch = withManagedBlock(currentPatch, { block: patchBlock(), startMarker: MARKER_START, endMarker: MARKER_END })
  if (nextPatch !== currentPatch) {
    if (!options.dryRun) writeFileSync(patchPath, nextPatch)
    report.push(`${currentPatch === '' ? 'created' : 'updated'} the ${PRESET_ID} marker block in ${patchPath}`)
  } else {
    report.push(`left the ${PRESET_ID} marker block in ${patchPath} unchanged`)
  }

  installServiceProfile({ home, providerSource, guardSource, dryRun: options.dryRun, report })
  installReadOnlyProfile({ home, providerSource, guardSource, dryRun: options.dryRun, report })

  const mode = options.dryRun ? 'dry run — nothing written' : 'installed'
  process.stdout.write(
    [
      `flash-agent: ${mode}`,
      ...report.map((line) => `  - ${line}`),
      '',
      'Next steps:',
      `  1. Interactive preset — restart the profile so its host composition mounts the new provider row:`,
      `       dsh --profile ${options.profile} web`,
      `     then confirm the tool list of a "Flash Orchestrator" session shows flash, workflow, and ralph.`,
      `  2. MCP service — install the plugin, which registers the server and the skills:`,
      `       /plugin marketplace add ${REPO_ROOT}`,
      `       /plugin install flash-agents@flash-agents`,
      `     or register the server by hand in one project:`,
      `       claude mcp add flash -- node ${join(REPO_ROOT, 'packages', 'flash-mcp', 'lib', 'index.js')} serve --root "$PWD"`,
      `     the server boots ${join(home, 'profiles', SERVICE_PROFILE)} lazily on the first flash_task call,`,
      `     and ${join(home, 'profiles', READONLY_PROFILE)} only when a call asks for mode: "read-only".`,
      `  3. Check the service profile resolves before first use:`,
      `       dsh --profile ${SERVICE_PROFILE} --dump-config > /dev/null`,
      '',
      'Model choice — the models a caller may ask for per call come from the allowlist:',
      'route.models in flash.config.json, or the comma-separated FLASH_MODELS environment',
      'variable. The default route.model is always allowed. The installed profiles honour',
      'FLASH_ROUTE_MODEL, so no settings.yaml subagent-model-selection entry is needed.',
      '',
      `The generated plugin stamp is ${join(home, 'profiles', SERVICE_PROFILE, 'plugins', 'package.json')}`,
      `(and the same package.json under ${READONLY_PROFILE}); it records release ${FLASH_VERSION},`,
      'so a server started after an update can name a profile a previous release installed.',
      `The interactive ${options.profile} profile gets that stamp only when every .js file in its`,
      'plugins folder is an ES module; otherwise the folder is left alone and the report above says why.',
    ].join('\n') + '\n',
  )
}

try {
  main()
} catch (error) {
  process.stderr.write(`install: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
