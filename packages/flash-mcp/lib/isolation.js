/**
 * Workspace isolation: a writing call runs in a disposable copy of the root.
 *
 * The wall in `dsh-flash-guard` is a denylist over an open language, and a denylist
 * over an open language is never finished — `rm -rf "$(pwd)"`, `bash -c`, inline
 * code and a dozen other spellings all had to be added after the fact. Isolation
 * removes the premise instead: the worker is given a tree it is *allowed* to wreck,
 * and the only thing that reaches the caller's repository is a diff this module
 * computed afterwards.
 *
 * Three consequences the rest of the service depends on:
 *
 *   * `rm -rf` of anything the worker can reach destroys a throwaway copy;
 *   * the caller's working tree is not touched by a worker at all, only by `apply`;
 *   * "what changed" is machine-generated (`filesChanged`, `diffstat`, `diff`)
 *     instead of a worker's claim about itself.
 *
 * The copy is a copy-on-write clone where the filesystem supports one, so an
 * ordinary repository costs a few milliseconds and no space. The copy includes
 * `.git` and any uncommitted work, because a worker that sees the last commit
 * instead of the working tree is useless to whoever is mid-edit.
 *
 * @typedef {object} Slot
 * @property {number} id - slot number, stable for the life of the pool.
 * @property {string} dir - the disposable tree the worker runs in.
 * @property {string | null} base - commit this call started from, or null without git.
 * @property {boolean} busy - whether a call currently holds the slot.
 *
 * @typedef {object} Change
 * @property {boolean} available - whether a diff could be computed at all.
 * @property {string} [reason] - why not, when it could not.
 * @property {string[]} filesChanged - `STATUS<TAB>path` entries, in git's order.
 * @property {string} diffstat - `git diff --stat` output.
 * @property {string} diff - the patch itself, possibly truncated by the service.
 * @property {number} diffChars - the patch length before truncation.
 * @property {string} [patchId] - id a later `flash_apply` can refer to.
 * @property {string} [patchPath] - where the patch was stored.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Arguments that keep a commit in a throwaway copy from running the caller's hooks. */
const COMMIT_CONFIG = [
  '-c', 'user.email=flash@localhost',
  '-c', 'user.name=flash',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.hooksPath=/dev/null',
]

/**
 * Run one git command and return its standard output.
 *
 * @param {string[]} args - arguments after `git`.
 * @param {string} cwd - directory to run in.
 * @returns {string} standard output.
 * @throws {Error} with git's own message when the command fails.
 */
function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    throw new Error(`git ${args.join(' ')} failed in ${cwd}${stderr.length === 0 ? '' : `: ${stderr}`}`)
  }
}

/**
 * The ignored paths git sees in a directory, as repository-relative names.
 *
 * A trailing slash on a directory entry is stripped so the two lists compare equal
 * across invocations, and the result is sorted so comparing them is a set operation.
 * @param {string} dir - a directory inside a git work tree.
 * @returns {string[]} repository-relative ignored paths.
 */
function ignoredPaths(dir) {
  try {
    return git(['status', '--porcelain', '--ignored=matching', '-z'], dir)
      .split('\0')
      .filter((entry) => entry.startsWith('!! '))
      .map((entry) => entry.slice(3).replace(/\/$/, ''))
      .sort()
  } catch {
    return []
  }
}

/**
 * Whether a directory looks like the top of a git work tree.
 * @param {string} dir - a directory.
 * @returns {boolean} true when git can be asked about it.
 */
function isGitWorkTree(dir) {
  return existsSync(join(dir, '.git'))
}

/**
 * Copy the contents of one directory into another.
 *
 * The clone is attempted first: on APFS (and on filesystems with reflink support)
 * `cp -c` shares every block with the source until one side writes, so a large
 * repository copies instantly and costs nothing. Everywhere else the plain copy is
 * used, which is correct and slower.
 *
 * @param {string} from - source directory.
 * @param {string} to - existing destination directory.
 * @returns {'clone' | 'copy'} which mechanism was used.
 */
function copyTree(from, to) {
  // `${from}/.` and not `join(from, '.')`: `join` normalizes the trailing `/.` away,
  // and `cp -R <dir> <dest>` then copies the directory *into* the destination
  // instead of copying its contents.
  const source = from.endsWith(sep) ? `${from}.` : `${from}${sep}.`
  try {
    execFileSync('cp', ['-cR', source, to], { stdio: ['ignore', 'ignore', 'pipe'] })
    return 'clone'
  } catch {
    execFileSync('cp', ['-R', source, to], { stdio: ['ignore', 'ignore', 'pipe'] })
    return 'copy'
  }
}

/**
 * Empty a directory without removing it.
 *
 * The directory itself has to survive: a running runtime holds it as its working
 * directory, and its sandbox root is fixed at the path it was started with.
 *
 * @param {string} dir - the directory to empty.
 * @returns {void}
 */
function emptyDirectory(dir) {
  for (const entry of readdirSync(dir)) {
    rmSync(join(dir, entry), { recursive: true, force: true })
  }
}

export class WorkspaceIsolation {
  /**
   * @param {object} options - isolation settings.
   * @param {string} options.root - the caller's repository, which is never written.
   * @param {number} [options.slots] - how many trees may be in flight at once.
   * @param {string} options.stateDir - where slot trees and stored patches live.
   * @param {(message: string) => void} [options.log] - progress log.
   */
  constructor({ root, slots = 2, stateDir, log = () => {} }) {
    this.root = resolve(root)
    this.stateDir = resolve(stateDir)
    this.log = log
    this.clones = 0
    /** Patches kept for a later `flash_apply`. @type {Map<string, object>} */
    this.patches = new Map()
    /** Callers waiting for a slot, oldest first. @type {Function[]} */
    this.waiting = []
    this.slots = Array.from({ length: Math.max(1, slots) }, (_, id) => ({
      id,
      dir: join(this.stateDir, 'slots', `slot-${String(id)}`),
      base: null,
      busy: false,
    }))
    // Slot trees belong to this process: a previous process's copies are dead
    // weight, and reusing one would hand a worker another call's leftovers.
    rmSync(join(this.stateDir, 'slots'), { recursive: true, force: true })
    mkdirSync(join(this.stateDir, 'calls'), { recursive: true })
    for (const slot of this.slots) mkdirSync(slot.dir, { recursive: true })
  }

  /** How many trees may be in flight at once. */
  get size() {
    return this.slots.length
  }

  /**
   * Take a slot, waiting for one when every tree is in use.
   * @returns {Promise<Slot>} the slot this call owns until it is released.
   */
  async lease() {
    const free = this.slots.find((slot) => !slot.busy)
    if (free !== undefined) {
      free.busy = true
      return free
    }
    return await new Promise((resolveLease) => {
      this.waiting.push(resolveLease)
    })
  }

  /**
   * Give a slot back. The next waiter, if any, receives it rather than this slot.
   * @param {Slot} slot - the slot to release.
   * @returns {void}
   */
  release(slot) {
    const next = this.waiting.shift()
    if (next !== undefined) {
      // Hand the slot straight to the waiter: it stays busy, so two calls can never
      // be handed the same tree.
      next(slot)
      return
    }
    slot.busy = false
  }

  /**
   * Reset one slot to the caller's current state and record where that was.
   *
   * "Current" includes uncommitted edits and untracked files: the copy is of the
   * working tree, not of `HEAD`. The base is then committed inside the copy so the
   * diff afterwards is exactly the worker's contribution, whether or not the
   * caller's tree was dirty to begin with.
   *
   * @param {Slot} slot - a leased slot.
   * @returns {{base: string | null, mechanism: 'clone' | 'copy', reason?: string}} the base.
   */
  prepare(slot) {
    emptyDirectory(slot.dir)
    const mechanism = copyTree(this.root, slot.dir)
    this.clones += 1
    slot.base = null
    slot.baseReason = undefined
    if (!isGitWorkTree(slot.dir)) {
      slot.baseReason = 'the service root is not a git repository, so no diff could be computed'
      return { base: null, mechanism, reason: slot.baseReason }
    }
    try {
      git(['add', '-A'], slot.dir)
      git([...COMMIT_CONFIG, 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'flash base'], slot.dir)
      slot.base = git(['rev-parse', 'HEAD'], slot.dir).trim()
      // Ignored files are invisible to `git add -A`, so a worker that writes only
      // ignored files would otherwise produce an empty patch and read as "no change".
      // Recording the ignored set at the base makes the additions detectable later.
      slot.ignoredBase = ignoredPaths(slot.dir)
      return { base: slot.base, mechanism }
    } catch (error) {
      slot.baseReason = `the base state could not be recorded: ${error.message}`
      return { base: null, mechanism, reason: slot.baseReason }
    }
  }

  /**
   * Read what the worker changed, and store it as a patch a later apply can use.
   *
   * @param {Slot} slot - the slot the worker ran in.
   * @param {object} [options] - patch options.
   * @param {number} [options.diffChars] - keep the patch within this many characters.
   * @returns {Change} the change, ready to be projected into a tool result.
   */
  collect(slot, { diffChars = 20000 } = {}) {
    if (slot.base === null) {
      return {
        available: false,
        reason: slot.baseReason ?? 'no base state was recorded for this call, so no diff could be computed',
        filesChanged: [],
        ignored: [],
        diffstat: '',
        diff: '',
        diffChars: 0,
      }
    }
    try {
      git(['add', '-A'], slot.dir)
      const patchId = `flash-${randomUUID()}`
      const patchPath = join(this.stateDir, 'calls', `${patchId}.patch`)
      const diff = git(['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', slot.base], slot.dir)
      const diffstat = git(['diff', '--cached', '--stat', '--no-color', slot.base], slot.dir)
      const names = git(['diff', '--cached', '--name-status', slot.base], slot.dir)
      const filesChanged = names.split('\n').filter((line) => line.trim().length > 0)
      // Work that git ignores is work the patch cannot carry. It is reported rather
      // than silently dropped: a caller told "no change" while the worker wrote a
      // whole build directory has been misled, not informed.
      const ignored = ignoredPaths(slot.dir).filter((entry) => !(slot.ignoredBase ?? []).includes(entry))
      writeFileSync(patchPath, diff)
      this.patches.set(patchId, { patchId, patchPath, filesChanged, diffstat, createdAt: Date.now() })
      return {
        available: true,
        filesChanged,
        ignored,
        diffstat: diffstat.trim(),
        diff: diff.length <= diffChars ? diff : diff.slice(0, diffChars),
        diffChars: diff.length,
        patchId,
        patchPath,
      }
    } catch (error) {
      return {
        available: false,
        reason: `the change could not be read: ${error.message}`,
        filesChanged: [],
        ignored: [],
        diffstat: '',
        diff: '',
        diffChars: 0,
      }
    }
  }

  /**
   * Apply a stored patch to the caller's repository.
   *
   * This is the only path by which a worker's work reaches the caller's tree, which
   * is the point: what arrives is a patch that was computed from a finished call,
   * not a live process writing wherever it liked.
   *
   * @param {object} options - the patch to apply.
   * @param {string} options.patchId - a patch id from an earlier call.
   * @param {boolean} [options.dryRun] - check that it applies without changing anything.
   * @returns {{patchId: string, applied: boolean, dryRun: boolean, root: string, filesChanged: string[], diffstat: string}} the outcome.
   * @throws {Error} when the patch is unknown or does not apply.
   */
  apply({ patchId, dryRun = false }) {
    const record = this.patches.get(patchId) ?? this.#readStoredPatch(patchId)
    if (record === undefined) {
      throw new Error(
        `no patch ${JSON.stringify(patchId)} is held by this service; patches are kept in ${join(this.stateDir, 'calls')}`,
      )
    }
    if (!existsSync(record.patchPath)) throw new Error(`the patch file for ${patchId} is gone (${record.patchPath})`)
    const check = dryRun ? ['--check'] : []
    if (isGitWorkTree(this.root)) {
      // Without `--index` the caller's index is left alone; only the working tree moves.
      git(['apply', '--whitespace=nowarn', ...check, record.patchPath], this.root)
    } else {
      execFileSync('patch', ['-p1', '--batch', '--forward', ...(dryRun ? ['--dry-run'] : []), '-i', record.patchPath], {
        cwd: this.root,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    }
    return {
      patchId,
      applied: !dryRun,
      dryRun,
      root: this.root,
      filesChanged: record.filesChanged ?? [],
      diffstat: (record.diffstat ?? '').trim(),
    }
  }

  /**
   * Re-read a patch this process wrote earlier, so an id survives a service restart.
   * @param {string} patchId - the id to look for.
   * @returns {object | undefined} the stored record, or undefined.
   */
  #readStoredPatch(patchId) {
    const patchPath = join(this.stateDir, 'calls', `${patchId}.patch`)
    if (!existsSync(patchPath)) return undefined
    return { patchId, patchPath, filesChanged: [], diffstat: '' }
  }

  /**
   * The path of a caller-relative working directory inside one slot.
   * @param {Slot} slot - the slot the worker will run in.
   * @param {string} rootCwd - a directory inside the service root.
   * @returns {string} the same directory inside the slot.
   */
  slotCwd(slot, rootCwd) {
    const inside = relative(this.root, rootCwd)
    return inside === '' ? slot.dir : join(slot.dir, inside)
  }

  /**
   * Forget one slot's tree. Used when a call must not be allowed to leave state.
   * @param {Slot} slot - the slot to clean.
   * @returns {void}
   */
  discard(slot) {
    emptyDirectory(slot.dir)
    slot.base = null
  }

  /** Remove the slot trees. Stored patches stay: an apply may still be coming. */
  close() {
    for (const slot of this.slots) rmSync(slot.dir, { recursive: true, force: true })
    rmSync(join(this.stateDir, 'slots'), { recursive: true, force: true })
  }
}
