/**
 * What the project instruction files cost every worker of a call.
 *
 * The harness injects `AGENTS.md` / `CLAUDE.md` (and their `.local.md` overlays) from
 * the repository root down to the worker's working directory into every worker's
 * prompt, plus the user-global `$DSH_HOME/AGENTS.md`. A 16,000-word `CLAUDE.md` is
 * therefore a per-call token cost the caller never sees in the result, and a file
 * that outgrew the harness's 64 KB budget is silently truncated.
 *
 * The rules here replicate the harness's own (`@deepseek-ai/dsh-agent-instructions`)
 * rather than importing them: the shipped server must not depend on the layout of an
 * installed package. They are, in order:
 *
 * - the project root is the nearest directory at or above the worker's cwd holding a
 *   `.git` (a file or a directory); with no repository, the cwd itself;
 * - every directory from that root down to the cwd, broadest first, contributes its
 *   `AGENTS.md`, `CLAUDE.md`, `AGENTS.local.md`, `CLAUDE.local.md` when they are
 *   regular files, and a candidate whose trimmed text repeats an earlier sibling's in
 *   the same directory is dropped;
 * - the user-global `$DSH_HOME/AGENTS.md` comes first;
 * - the rendered set is capped at `agent-instructions.maxBytes` (65,536 bytes in the
 *   shipped profile). Over the cap the harness keeps the most specific files and
 *   omits the broader ones, which the caller is warned about.
 *
 * `files` and `bytes` report what the files hold on disk — the number that explains
 * the warning — so `approxTokens` is an upper bound when the set is over budget.
 *
 * Measuring is a handful of stats and reads, once per call: the result is cheap
 * enough to carry in every `flash_task` and `flash_batch` result.
 *
 * @module flash-mcp/instructions
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The harness's byte budget for the rendered instruction set, in the shipped profile. */
export const DEFAULT_INSTRUCTIONS_BUDGET = 65_536

/**
 * One directory's candidates, in the order the harness loads them: the two agent
 * files first, then the local overlays that are meant to override them.
 */
const CANDIDATES = Object.freeze(['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'])

/**
 * Measure the instruction files a worker in `cwd` would receive.
 *
 * Never throws: a directory that has gone away, a file a permission bit hides, or a
 * path that is not text all simply contribute nothing. A caller must be able to put
 * this in a result whatever the repository looks like.
 *
 * @param {object} [options] - what to measure.
 * @param {string} [options.cwd] - the worker's working directory (default: the process's).
 * @param {string} [options.dshHome] - the harness's home directory, holding the global
 *   `AGENTS.md` (default: `$DSH_HOME`, else `~/.dsh`).
 * @param {string} [options.home] - the user's home directory, used only to spell the
 *   global file `~/…` (default: the process's).
 * @param {number} [options.budgetBytes] - the rendered set's byte budget
 *   (default: the shipped profile's 65,536).
 * @returns {{files: Array<{path: string, bytes: number}>, bytes: number, budgetBytes: number,
 *   overBudget: boolean, approxTokens: number}} the estimate, broadest file first.
 */
export function estimateInstructions({ cwd, dshHome, home, budgetBytes = DEFAULT_INSTRUCTIONS_BUDGET } = {}) {
  const budget =
    Number.isSafeInteger(budgetBytes) && budgetBytes > 0 ? budgetBytes : DEFAULT_INSTRUCTIONS_BUDGET
  const files = []
  try {
    collect(resolve(typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()), dshHome, home, files)
  } catch {
    // A result must never fail because a repository could not be measured; files found
    // before the failure are still reported.
  }
  const bytes = files.reduce((total, file) => total + file.bytes, 0)
  return { files, bytes, budgetBytes: budget, overBudget: bytes > budget, approxTokens: Math.ceil(bytes / 4) }
}

/**
 * Append every instruction file the harness would load for `start`, in its order.
 *
 * @param {string} start - the worker's cwd, already absolute.
 * @param {string | undefined} dshHome - the harness home, when the caller knows it.
 * @param {string | undefined} home - the user's home, for the global file's label.
 * @param {Array<{path: string, bytes: number}>} files - the list to fill.
 * @returns {void}
 */
function collect(start, dshHome, home, files) {
  const userHome = textOrUndefined(home) ?? homeDirectory()
  const globalPath = join(globalDirectory(dshHome, userHome), 'AGENTS.md')
  const global = readInstructionFile(globalPath)
  if (global !== undefined) files.push({ path: displayPath(globalPath, userHome), bytes: global.bytes })

  const root = projectRoot(start)
  for (const dir of ancestorChain(root, start)) {
    // Deduplication is per directory: a project that keeps `CLAUDE.md` as a copy of
    // `AGENTS.md` for a second tool must not pay for both in every prompt.
    const seen = new Set()
    for (const name of CANDIDATES) {
      const read = readInstructionFile(join(dir, name))
      if (read === undefined) continue
      if (seen.has(read.trimmed)) continue
      seen.add(read.trimmed)
      files.push({ path: relativePath(root, join(dir, name)), bytes: read.bytes })
    }
  }
}

/**
 * The nearest directory at or above `start` that holds a `.git`, or `start` itself.
 *
 * `.git` is a directory in an ordinary checkout and a file in a linked worktree or a
 * submodule; either one marks the project root.
 *
 * @param {string} start - the worker's cwd, already absolute.
 * @returns {string} the project root.
 */
function projectRoot(start) {
  let dir = start
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    // The filesystem root is its own parent.
    if (parent === dir) return start
    dir = parent
  }
}

/**
 * Every directory from `root` down to `start`, broadest first, inclusive.
 *
 * @param {string} root - the project root, an ancestor of `start`.
 * @param {string} start - the worker's cwd.
 * @returns {string[]} the chain; just the root when the two are the same.
 */
function ancestorChain(root, start) {
  const rel = relative(root, start)
  const parts = rel === '' ? [] : rel.split(sep)
  if (parts.some((part) => part === '..') || isAbsolute(rel)) return [root]
  const chain = [root]
  let dir = root
  for (const part of parts) {
    if (part === '') continue
    dir = join(dir, part)
    chain.push(dir)
  }
  return chain
}

/**
 * Read one candidate instruction file.
 *
 * @param {string} path - the candidate path.
 * @returns {{bytes: number, trimmed: string} | undefined} its byte count and trimmed
 *   text, or undefined when it is missing, not a regular file, or unreadable.
 */
function readInstructionFile(path) {
  try {
    if (!statSync(path).isFile()) return undefined
    const buffer = readFileSync(path)
    return { bytes: buffer.length, trimmed: buffer.toString('utf8').trim() }
  } catch {
    return undefined
  }
}

/**
 * The harness home holding the global `AGENTS.md`.
 *
 * @param {string | undefined} dshHome - the caller's value, which wins.
 * @param {string} home - the user's home directory.
 * @returns {string} the harness home.
 */
function globalDirectory(dshHome, home) {
  const fromOption = textOrUndefined(dshHome)
  if (fromOption !== undefined) return resolve(fromOption)
  const fromEnv = textOrUndefined(process.env.DSH_HOME)
  return fromEnv === undefined ? join(home, '.dsh') : resolve(fromEnv)
}

/** The user's home directory, or the filesystem root when it cannot be determined. */
function homeDirectory() {
  try {
    return homedir()
  } catch {
    return sep
  }
}

/**
 * How a file is named in a result: relative to the project root, and `~/…` for the
 * global file, which is not inside the project at all.
 *
 * @param {string} path - the absolute path.
 * @param {string} home - the user's home directory.
 * @returns {string} the display path, always with forward slashes.
 */
function displayPath(path, home) {
  const rel = relative(home, path)
  const inside = rel !== '' && !isAbsolute(rel) && !rel.split(sep).includes('..')
  return posix(inside ? `~${sep}${rel}` : path)
}

/**
 * A path relative to the project root, so two calls in the same repository report
 * the same names.
 *
 * @param {string} root - the project root.
 * @param {string} path - the absolute path of the file.
 * @returns {string} the relative path, always with forward slashes.
 */
function relativePath(root, path) {
  const rel = relative(root, path)
  return posix(rel === '' ? path : rel)
}

/** Render a platform path with forward slashes, as results elsewhere do. */
function posix(path) {
  return path.split(sep).join('/')
}

/** A non-empty string, or nothing: an unset plugin setting expands to `""`. */
function textOrUndefined(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
