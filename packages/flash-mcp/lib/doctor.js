/**
 * Prerequisite checks for the flash-agent stack.
 *
 * Each check only observes: it runs a command or probes an HTTP endpoint, and
 * reports the exact shell command that would repair the problem. Every effect is
 * injected through `run` and `probe`, so the checks can be exercised without a
 * real binary or the network. A failed prerequisite never removes a dependent
 * check from the report: the dependent degrades to a warning that names why it
 * could not run.
 *
 * @module flash-mcp/doctor
 */

import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { resolveDshCommand } from './sdk.js'

/** The check ids in the order they run. */
export const CHECK_IDS = Object.freeze([
  'node',
  'dsh',
  'dsh-version',
  'dsh-native',
  'profile',
  'ollama',
  'model',
  'git',
  'zstd',
])

/** The DeepSeek Harness version the profiles are written for and tested against. */
const DEFAULT_DSH_VERSION = '0.2.0-rc.2'

/**
 * The oldest Node each release line runs dsh on. dsh starts its CLI behind
 * `import.meta.main`, which Node 22.18 and 24.2 introduced, and on an older Node it
 * exits 0 without doing anything; its dependencies also ask for 22.19. A line absent
 * here and older than the newest one (Node 23, say) does not qualify at all.
 */
const NODE_MINIMUMS = Object.freeze({ 22: [22, 19, 0], 24: [24, 2, 0] })

/** The Node requirement as people read it. */
const NODE_REQUIREMENT = 'Node 22.19 or newer (24.2 or newer on the 24 line)'

/** Endpoint whose answer proves the local Ollama daemon is up. */
const OLLAMA_TAGS_URL = 'http://127.0.0.1:11434/api/tags'

/**
 * The filesystem primitives the native-module check reads.
 *
 * These are lookups only: nothing here spawns a process or loads a native
 * module, and the whole set is injectable through `options.fs`, so the check can
 * be exercised without a real harness install.
 */
const REAL_FS = Object.freeze({
  realpath: (path) => realpathSync(path),
  exists: (path) => existsSync(path),
  executable: (path) => {
    try {
      accessSync(path, constants.X_OK)
      return true
    } catch {
      return false
    }
  },
  readText: (path) => readFileSync(path, 'utf8'),
  resolvePackage: (request, fromFile) => createRequire(fromFile).resolve(request),
})

/**
 * Run one command and report its exit status instead of throwing.
 *
 * Standard error is kept on success too: `dsh --dump-config` reports a patch that
 * did not apply on standard error and still exits 0.
 *
 * @param {string} command - executable to invoke.
 * @param {string[]} args - arguments to pass to it.
 * @param {NodeJS.ProcessEnv} env - environment for the child process.
 * @returns {{status: number, stdout: string, stderr: string}} the captured result.
 */
function defaultRun(command, args, env) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env })
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error instanceof Error ? result.error.message : ''),
  }
}

/**
 * Probe an HTTP endpoint for reachability within a short timeout.
 *
 * @param {string} url - endpoint to request.
 * @returns {Promise<boolean>} true when the endpoint answers with a success status.
 */
async function defaultProbe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Extract a numeric major/minor/patch triple, ignoring any pre-release suffix.
 *
 * @param {string} text - version text such as `0.1.5-rc.1` or `dsh 0.2.0`.
 * @returns {number[] | null} the three numbers, or null when no version is present.
 */
function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '')
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Compare two major/minor/patch triples.
 *
 * @param {number[]} left - candidate version.
 * @param {number[]} right - reference version.
 * @returns {number} negative when left is older, zero when equal, positive when newer.
 */
function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

/**
 * Whether a Node version can run dsh.
 *
 * @param {string} version - a Node version such as `22.19.0` or `v24.1.0`.
 * @returns {boolean} true when the version meets its release line's minimum.
 */
function nodeQualifies(version) {
  const parsed = parseVersion(version)
  if (parsed === null) return false
  const minimum = NODE_MINIMUMS[parsed[0]]
  if (minimum !== undefined) return compareVersions(parsed, minimum) >= 0
  return parsed[0] > Math.max(...Object.keys(NODE_MINIMUMS).map(Number))
}

/** The shell command that installs zstd on this platform. @returns {string} the command. */
function zstdFix() {
  if (process.platform === 'darwin') return 'brew install zstd'
  if (process.platform === 'win32') return 'winget install Meta.Zstandard'
  return 'install zstd'
}

/** The first non-empty line of some output, for a one-line detail. */
function firstLine(text) {
  return (text ?? '').split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? ''
}

/** The message of a thrown value, for a warning that has to name its reason. */
function reasonOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Find the harness package that owns a resolved dsh entry.
 *
 * Homebrew and `npm link` make the launcher a symlink, so the entry is realpath'd
 * before walking up from `lib/` to the manifest whose name is `@deepseek-ai/dsh`.
 * There is deliberately no fallback to a guessed global prefix: guessing would
 * inspect some other install and hide the real problem.
 *
 * @param {string} entry - the launcher path, or the JavaScript entry behind a Windows shim.
 * @param {object} fs - filesystem probe.
 * @returns {string | undefined} the package directory, or undefined when no manifest names it.
 */
function findDshPackage(entry, fs) {
  let real
  try {
    real = fs.realpath(entry)
  } catch {
    return undefined
  }
  let dir = dirname(real)
  for (;;) {
    const manifest = join(dir, 'package.json')
    if (fs.exists(manifest)) {
      try {
        if (JSON.parse(fs.readText(manifest))?.name === '@deepseek-ai/dsh') return dir
      } catch {
        // A manifest we cannot read is not ours; keep walking rather than guess.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Check that the node-pty native pieces beside a dsh install are usable.
 *
 * dsh runs every worker shell command through node-pty. npm 11 blocks dependency
 * install scripts by default, and those scripts are what build `pty.node` or
 * restore the execute bit on macOS's `spawn-helper`, so a script that silently
 * did not run turns into every worker command failing. This only looks at paths;
 * it never loads the module or starts a process.
 *
 * @param {string} entry - the resolved dsh entry point.
 * @param {string} platform - platform whose prebuild directory to inspect.
 * @param {string} arch - architecture whose prebuild directory to inspect.
 * @param {object} fs - filesystem probe.
 * @param {string} install - the command that reinstalls dsh.
 * @returns {{status: string, detail: string, fix: string}} the check to record.
 */
function checkNativeModules(entry, platform, arch, fs, install) {
  const dshDir = findDshPackage(entry, fs)
  if (dshDir === undefined) {
    return {
      status: 'warn',
      detail: `could not locate the @deepseek-ai/dsh install behind ${entry}, so its native modules could not be inspected`,
      fix: install,
    }
  }

  const manifest = join(dshDir, 'package.json')
  let nodePtyDir
  let why = ''
  try {
    nodePtyDir = dirname(fs.resolvePackage('node-pty/package.json', manifest))
  } catch {
    try {
      // node-pty is a dependency of the subprocess package; resolving from that
      // manifest finds a copy hoisted anywhere above it.
      const subprocess = fs.resolvePackage('@deepseek-ai/dsh-subprocess-local/package.json', manifest)
      nodePtyDir = dirname(fs.resolvePackage('node-pty/package.json', subprocess))
    } catch (error) {
      why = reasonOf(error)
    }
  }
  if (nodePtyDir === undefined) {
    return {
      status: 'warn',
      detail: `node-pty could not be resolved from ${dshDir}${why === '' ? '' : `: ${why}`}`,
      fix: install,
    }
  }

  // node-pty loads build/Release before prebuilds, so the same order decides
  // which spawn-helper pairs with the binary that actually runs.
  const buildDir = join(nodePtyDir, 'build', 'Release')
  const prebuildDir = join(nodePtyDir, 'prebuilds', `${platform}-${arch}`)
  const loadedDir = [buildDir, prebuildDir].find((dir) => fs.exists(join(dir, 'pty.node')))
  if (loadedDir === undefined) {
    return {
      status: 'fail',
      detail: `node-pty has no pty.node in ${prebuildDir} or ${buildDir}, so dsh cannot run a worker command`,
      fix: `reinstall @deepseek-ai/dsh with install scripts allowed (npm 11 blocks them by default); or build node-pty in place: cd ${nodePtyDir} && npx --yes node-gyp rebuild`,
    }
  }

  const ptyNode = join(loadedDir, 'pty.node')
  if (platform === 'darwin') {
    const helper = join(loadedDir, 'spawn-helper')
    if (!fs.exists(helper)) {
      return {
        status: 'fail',
        detail: `node-pty's ${ptyNode} has no spawn-helper beside it, which macOS needs to start a shell`,
        fix: `cd ${nodePtyDir} && npx --yes node-gyp rebuild`,
      }
    }
    let helperRuns = false
    try {
      helperRuns = fs.executable(helper) === true
    } catch {
      helperRuns = false
    }
    if (!helperRuns) {
      return {
        status: 'fail',
        detail: `node-pty's spawn-helper at ${helper} is not executable, so dsh cannot run a worker command`,
        fix: `chmod +x ${helper}`,
      }
    }
  }
  return { status: 'ok', detail: `node-pty can load ${ptyNode}`, fix: '' }
}

/**
 * Run every prerequisite check in order.
 *
 * @param {object} [options] - injected effects and overrides.
 * @param {(command: string, args: string[]) => {status: number, stdout: string, stderr: string}} [options.run]
 *        Command runner; defaults to spawnSync, reporting a non-zero status instead of throwing.
 * @param {(url: string) => Promise<boolean>} [options.probe] - HTTP reachability probe; defaults to fetch with a short timeout.
 * @param {NodeJS.ProcessEnv} [options.env] - environment for the default runner (default process.env).
 * @param {string} [options.nodeVersion] - Node version to test (default process.versions.node).
 * @param {string} [options.profile] - service profile to compose (default 'flash-service').
 * @param {string} [options.model] - Ollama model to require (default 'deepseek-v4.1-flash:cloud').
 * @param {string} [options.dshVersion] - the dsh version the profiles are written for (default '0.2.0-rc.2').
 * @param {string} [options.platform] - platform whose node-pty prebuild to inspect (default process.platform).
 * @param {string} [options.arch] - architecture whose node-pty prebuild to inspect (default process.arch).
 * @param {object} [options.fs] - filesystem probe with realpath/exists/executable/readText/resolvePackage;
 *        defaults to the node:fs calls, and is injectable so the check needs no real harness install.
 * @param {{command: string, prefix: string[]}} [options.launcher] - how to start dsh; defaults to the
 *        launcher the server itself resolves, so the doctor checks exactly the dsh the server would run.
 * @returns {Promise<{checks: object[], ok: boolean, failures: number, warnings: number}>} the report.
 */
export async function runChecks(options = {}) {
  const config = options ?? {}
  const env = config.env ?? process.env
  const nodeVersion = config.nodeVersion ?? process.versions.node
  const profile = config.profile ?? 'flash-service'
  const model = config.model ?? 'deepseek-v4.1-flash:cloud'
  const dshVersion = config.dshVersion ?? DEFAULT_DSH_VERSION
  const dshInstall = `npm i -g @deepseek-ai/dsh@${dshVersion}`
  const run = config.run ?? ((command, args) => defaultRun(command, args, env))
  const probe = config.probe ?? defaultProbe
  const platform = config.platform ?? process.platform
  const arch = config.arch ?? process.arch
  const fs = config.fs ?? REAL_FS

  /** Never let a broken injected runner escape as a rejection. */
  const safeRun = (command, args) => {
    try {
      const result = run(command, args)
      return result ?? { status: 1, stdout: '', stderr: '' }
    } catch (error) {
      return { status: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Never let a broken injected probe escape as a rejection. */
  const safeProbe = async (url) => {
    try {
      return (await probe(url)) === true
    } catch {
      return false
    }
  }

  const checks = []
  const record = (id, title, status, detail, fix) => checks.push({ id, title, status, detail, fix })

  if (nodeQualifies(nodeVersion)) {
    record('node', 'Node.js version', 'ok', `Node ${nodeVersion} can run dsh`, '')
  } else {
    record('node', 'Node.js version', 'fail', `Node ${nodeVersion} cannot run dsh, which needs ${NODE_REQUIREMENT}`, `install ${NODE_REQUIREMENT}`)
  }

  let launcher = config.launcher
  let notFound = ''
  if (launcher === undefined) {
    try {
      launcher = resolveDshCommand(env)
    } catch (error) {
      notFound = error instanceof Error ? error.message : String(error)
    }
  }
  const runDsh = (args) => safeRun(launcher.command, [...launcher.prefix, ...args])

  const dsh = launcher === undefined ? undefined : runDsh(['--version'])
  const dshRuns = dsh !== undefined && dsh.status === 0
  if (dshRuns) {
    record('dsh', 'dsh launcher', 'ok', 'dsh --version succeeded', '')
  } else if (dsh === undefined) {
    record('dsh', 'dsh launcher', 'fail', notFound || 'dsh was not found on PATH', dshInstall)
  } else {
    const why = firstLine(dsh.stderr)
    record('dsh', 'dsh launcher', 'fail', `dsh was found but did not start${why === '' ? '' : `: ${why}`}`, dshInstall)
  }

  if (!dshRuns) {
    record('dsh-version', 'dsh version', 'warn', 'dsh did not start, so its version could not be determined', dshInstall)
  } else {
    const installed = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(dsh.stdout)?.[0]
    const pinned = parseVersion(dshVersion)
    if (installed === undefined) {
      // dsh's CLI runs behind `import.meta.main`; on a Node without it, dsh prints nothing and exits 0.
      record('dsh-version', 'dsh version', 'fail', `dsh printed no version; dsh does nothing at all on a Node older than ${NODE_REQUIREMENT}`, `install ${NODE_REQUIREMENT}`)
    } else if (installed === dshVersion) {
      record('dsh-version', 'dsh version', 'ok', `dsh ${installed} is the version the profiles are written for`, '')
    } else if (pinned !== null && parseVersion(installed).slice(0, 2).join('.') === pinned.slice(0, 2).join('.')) {
      record('dsh-version', 'dsh version', 'warn', `dsh ${installed} is not the tested ${dshVersion}; it is on the same release line and will probably work`, dshInstall)
    } else {
      // Before 1.0 a minor release may rename the rows the profiles patch, and a patch
      // whose row is gone leaves that row at the harness default.
      record('dsh-version', 'dsh version', 'fail', `dsh ${installed} is not the ${dshVersion} the profiles are written for`, dshInstall)
    }
  }

  if (dshRuns) {
    // The Windows shim is resolved to a JavaScript entry, which is where the
    // harness install actually lives; elsewhere the launcher is the binary itself.
    const entry = launcher.prefix.length > 0 ? launcher.prefix[0] : launcher.command
    let native
    try {
      native = checkNativeModules(entry, platform, arch, fs, dshInstall)
    } catch (error) {
      native = { status: 'warn', detail: `the dsh native-module check could not run: ${reasonOf(error)}`, fix: dshInstall }
    }
    record('dsh-native', 'dsh native modules', native.status, native.detail, native.fix)
  }

  if (!dshRuns) {
    record('profile', 'service profile', 'warn', `dsh did not start, so the ${profile} profile could not be composed`, 'node install.mjs')
  } else {
    const dump = runDsh(['--profile', profile, '--dump-config'])
    // dsh reports a patch entry it could not apply on stderr and still exits 0, so the
    // stderr line is what tells a broken composition from a working one.
    const complaint = (dump.stderr ?? '').split(/\r?\n/).find((line) => line.startsWith('dsh:'))?.trim() ?? ''
    if (dump.status === 0 && complaint === '') {
      record('profile', 'service profile', 'ok', `the ${profile} profile composes`, '')
    } else {
      const why = complaint || firstLine(dump.stderr)
      record('profile', 'service profile', 'fail', `the ${profile} profile did not compose${why === '' ? '' : `: ${why}`}`, 'node install.mjs')
    }
  }

  const daemonUp = await safeProbe(OLLAMA_TAGS_URL)
  if (daemonUp) {
    record('ollama', 'Ollama daemon', 'ok', 'the Ollama daemon answers at 127.0.0.1:11434', '')
  } else {
    record('ollama', 'Ollama daemon', 'fail', 'the Ollama daemon is not reachable at 127.0.0.1:11434', 'ollama serve')
  }

  const cloud = model.endsWith(':cloud')
  const cloudNote = cloud ? '; a cloud model also needs `ollama signin`' : ''
  if (!daemonUp) {
    record('model', 'Ollama model', 'warn', `the Ollama daemon is not reachable, so ${model} could not be checked${cloudNote}`, `ollama pull ${model}`)
  } else {
    const show = safeRun('ollama', ['show', model])
    if (show.status === 0) {
      record('model', 'Ollama model', 'ok', `${model} is available${cloudNote}`, '')
    } else {
      record('model', 'Ollama model', 'fail', `${model} is not available${cloudNote}`, `ollama pull ${model}`)
    }
  }

  const git = safeRun('git', ['--version'])
  if (git.status === 0) {
    record('git', 'git', 'ok', 'git is on PATH', '')
  } else {
    record('git', 'git', 'fail', 'git was not found on PATH', 'install git')
  }

  const zstd = safeRun('zstd', ['--version'])
  if (zstd.status === 0) {
    record('zstd', 'zstd', 'ok', 'zstd is on PATH', '')
  } else {
    record('zstd', 'zstd', 'warn', 'zstd is not on PATH; reading persisted worker sessions needs it', zstdFix())
  }

  const failures = checks.filter((check) => check.status === 'fail').length
  const warnings = checks.filter((check) => check.status === 'warn').length
  return { checks, ok: failures === 0, failures, warnings }
}

/**
 * Render a check report as printable text.
 *
 * @param {{checks: object[]}} result - the value returned by runChecks.
 * @returns {string} one `STATUS  id  detail` line per check, then a `Fix:` line per broken check.
 */
export function formatChecks(result) {
  const checks = result?.checks ?? []
  const lines = checks.map((check) => `${check.status.padEnd(4)}  ${check.id}  ${check.detail}`)
  const broken = checks.filter((check) => check.status !== 'ok')
  if (broken.length > 0) {
    lines.push('')
    for (const check of broken) lines.push(`Fix: ${check.id}: ${check.fix}`)
  }
  return lines.join('\n')
}
