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

import { execFileSync } from 'node:child_process'

/** The check ids in the order they run. */
export const CHECK_IDS = Object.freeze([
  'node',
  'dsh',
  'dsh-version',
  'profile',
  'ollama',
  'model',
  'git',
  'zstd',
])

/** Minimum DeepSeek Harness version the service profile is known to work with. */
const DEFAULT_MIN_DSH_VERSION = '0.1.5'

/** Endpoint whose answer proves the local Ollama daemon is up. */
const OLLAMA_TAGS_URL = 'http://127.0.0.1:11434/api/tags'

/**
 * Run one command and report its exit status instead of throwing.
 *
 * @param {string} command - executable to invoke.
 * @param {string[]} args - arguments to pass to it.
 * @param {NodeJS.ProcessEnv} env - environment for the child process.
 * @returns {{status: number, stdout: string, stderr: string}} the captured result.
 */
function defaultRun(command, args, env) {
  try {
    const stdout = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return {
      status: typeof error?.status === 'number' ? error.status : 1,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : '',
    }
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

/** The shell command that installs zstd on this platform. @returns {string} the command. */
function zstdFix() {
  return process.platform === 'darwin' ? 'brew install zstd' : 'install zstd'
}

/**
 * Run every prerequisite check in order.
 *
 * @param {object} [options] - injected effects and overrides.
 * @param {(command: string, args: string[]) => {status: number, stdout: string, stderr: string}} [options.run]
 *        Command runner; defaults to execFileSync, reporting a non-zero status instead of throwing.
 * @param {(url: string) => Promise<boolean>} [options.probe] - HTTP reachability probe; defaults to fetch with a short timeout.
 * @param {NodeJS.ProcessEnv} [options.env] - environment for the default runner (default process.env).
 * @param {string} [options.nodeVersion] - Node version to test (default process.versions.node).
 * @param {string} [options.profile] - service profile to compose (default 'flash-service').
 * @param {string} [options.model] - Ollama model to require (default 'deepseek-v4.1-flash:cloud').
 * @param {string} [options.minDshVersion] - minimum accepted dsh version (default '0.1.5').
 * @returns {Promise<{checks: object[], ok: boolean, failures: number, warnings: number}>} the report.
 */
export async function runChecks(options = {}) {
  const config = options ?? {}
  const env = config.env ?? process.env
  const nodeVersion = config.nodeVersion ?? process.versions.node
  const profile = config.profile ?? 'flash-service'
  const model = config.model ?? 'deepseek-v4.1-flash:cloud'
  const minDshVersion = config.minDshVersion ?? DEFAULT_MIN_DSH_VERSION
  const run = config.run ?? ((command, args) => defaultRun(command, args, env))
  const probe = config.probe ?? defaultProbe

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

  const nodeMajor = Number.parseInt(String(nodeVersion).replace(/^v/, '').split('.')[0], 10)
  if (Number.isInteger(nodeMajor) && nodeMajor >= 20) {
    record('node', 'Node.js version', 'ok', `Node ${nodeVersion} is at least 20`, '')
  } else {
    record('node', 'Node.js version', 'fail', `Node ${nodeVersion} is older than the required Node 20`, 'install Node 20 or newer')
  }

  const dsh = safeRun('dsh', ['--version'])
  const dshOnPath = dsh.status === 0
  if (dshOnPath) {
    record('dsh', 'dsh on PATH', 'ok', 'dsh --version succeeded', '')
  } else {
    record('dsh', 'dsh on PATH', 'fail', 'dsh was not found on PATH', 'npm i -g @deepseek-ai/dsh')
  }

  if (!dshOnPath) {
    record('dsh-version', 'dsh version', 'warn', 'dsh is not on PATH, so its version could not be determined', 'npm i -g @deepseek-ai/dsh@latest')
  } else {
    const installed = parseVersion(dsh.stdout)
    const minimum = parseVersion(minDshVersion)
    if (installed === null) {
      record('dsh-version', 'dsh version', 'warn', 'dsh did not report a parsable version', 'npm i -g @deepseek-ai/dsh@latest')
    } else if (minimum !== null && compareVersions(installed, minimum) < 0) {
      record('dsh-version', 'dsh version', 'warn', `dsh ${installed.join('.')} is older than the required ${minDshVersion}`, 'npm i -g @deepseek-ai/dsh@latest')
    } else {
      record('dsh-version', 'dsh version', 'ok', `dsh ${installed.join('.')} meets the ${minDshVersion} minimum`, '')
    }
  }

  if (!dshOnPath) {
    record('profile', 'service profile', 'warn', `dsh is not on PATH, so the ${profile} profile could not be composed`, 'node install.mjs')
  } else {
    const dump = safeRun('dsh', ['--profile', profile, '--dump-config'])
    if (dump.status === 0) {
      record('profile', 'service profile', 'ok', `the ${profile} profile composes`, '')
    } else {
      record('profile', 'service profile', 'fail', `the ${profile} profile did not compose`, 'node install.mjs')
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
