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

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = dirname(fileURLToPath(import.meta.url))
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
        provider: ollama
        model: deepseek-v4.1-flash:cloud
        maxChildDepth: 0
${MARKER_END}
`
}

/** The marker-delimited block for the headless SDK profile, taken from the repo source. */
function servicePatchBlock() {
  const source = join(REPO_ROOT, 'profiles', SERVICE_PROFILE, 'cordis.patch.yml')
  if (!existsSync(source)) throw new Error(`missing flash-service patch source: ${source}`)
  const text = readFileSync(source, 'utf8')
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
 * Idempotently place a managed block in the profile patch document.
 * @param {string} current - current patch text ('' when absent).
 * @param {object} managed - the block and its markers.
 * @returns {string} the new patch text.
 */
function withManagedBlock(current, { block, startMarker, endMarker }) {
  const start = current.indexOf(startMarker)
  if (start >= 0) {
    const end = current.indexOf(endMarker)
    if (end < 0) throw new Error(`profile patch has "${startMarker}" without its end marker; repair the file manually`)
    return current.slice(0, start) + block + current.slice(end + endMarker.length + 1)
  }
  const body = meaningfulBody(current)
  if (body === '' || body === '[]') {
    return `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
#
# The block between the ${startMarker} markers is generated by
# ${join(REPO_ROOT, 'install.mjs')} and replaced on every run.
${block}`
  }
  if (!body.startsWith('[') && !body.startsWith('-')) {
    throw new Error('profile patch is not a top-level YAML array; refusing to modify it')
  }
  return `${current.replace(/\s*$/, '')}\n\n${block}`
}

/** Remove the managed block, restoring the empty document when nothing else remains. */
function withoutManagedBlock(current, { startMarker, endMarker }) {
  const start = current.indexOf(startMarker)
  if (start < 0) return current
  const end = current.indexOf(endMarker)
  if (end < 0) throw new Error(`profile patch has "${startMarker}" without its end marker; repair the file manually`)
  const stripped = current.slice(0, start) + current.slice(end + endMarker.length + 1)
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

  const source = readFileSync(join(serviceSource, 'cordis.patch.yml'), 'utf8')
  if (!source.includes('mode: workspace-write')) {
    throw new Error(`${SERVICE_PROFILE}/cordis.patch.yml no longer states mode: workspace-write, so the read-only profile cannot be derived from it`)
  }
  const generated = [
    `# GENERATED by install.mjs from profiles/${SERVICE_PROFILE}/cordis.patch.yml.`,
    `# The only difference is sandbox-policy.mode: read-only — edit the source, not this file.`,
    source.replaceAll(SERVICE_PROFILE, READONLY_PROFILE).replace('mode: workspace-write', 'mode: read-only'),
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
      `  2. MCP service — register the stdio server with your MCP client, for example:`,
      `       claude mcp add flash -- node ${join(REPO_ROOT, 'packages', 'flash-mcp', 'lib', 'index.js')} --root <workspace>`,
      `     the server boots ${join(home, 'profiles', SERVICE_PROFILE)} lazily on the first flash_task call,`,
      `     and ${join(home, 'profiles', READONLY_PROFILE)} only when a call asks for mode: "read-only".`,
      `  3. Check the service profile resolves before first use:`,
      `       dsh --profile ${SERVICE_PROFILE} --dump-config > /dev/null`,
      '',
      'Optional — per-call child model selection on the generic spawn provider',
      '(not needed by either piece here, whose routing is pinned): add to $DSH_HOME/settings.yaml',
      '  subagent-model-selection:',
      '    enabled: true',
      '    allowedModels:',
      '      - provider: ollama',
      '        model: deepseek-v4.1-flash:cloud',
    ].join('\n') + '\n',
  )
}

try {
  main()
} catch (error) {
  process.stderr.write(`install: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
