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
 * @property {string} tmpDir - a temp directory inside `dir`, for the worker's TMPDIR.
 * @property {string | null} base - commit this call started from, or null without git.
 * @property {boolean} busy - whether a call currently holds the slot.
 *
 * @typedef {object} Change
 * @property {boolean} available - whether a diff could be computed at all.
 * @property {string} [reason] - why not, when it could not.
 * @property {string[]} filesChanged - `STATUS<TAB>path` entries, in git's order.
 * @property {string[]} ignored - paths the worker created that git ignores, so the patch
 *   cannot carry them; reported rather than silently dropped.
 * @property {string} diffstat - `git diff --stat` output.
 * @property {string} diff - the patch itself, possibly truncated by the service.
 * @property {number} diffChars - the patch length before truncation.
 * @property {string} [patchId] - id a later `flash_apply` can refer to.
 * @property {string} [patchPath] - where the patch was stored.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

/**
 * The only shape a patch id may have. It is checked before the id is used to build a
 * path, so an id cannot name a different file: `../` in a patch id used to be a way to
 * read any `.patch` on disk.
 */
const PATCH_ID = /^flash-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The temp directory a worker is pointed at, relative to its disposable tree. */
const SLOT_TMP = '.flash-tmp'

/** An error a caller can branch on, carrying the same `code` shape the service uses. */
export class IsolationError extends Error {
  /**
   * @param {string} message - what went wrong.
   * @param {string} code - a stable code, e.g. `CANCELLED`, `TIMEOUT`.
   */
  constructor(message, code) {
    super(message)
    this.name = 'IsolationError'
    this.code = code
  }
}

/**
 * Where one process's disposable trees live when no state directory is configured.
 *
 * Keyed by root so two services over different repositories cannot collide, by pid so
 * two services over the *same* repository cannot either, and by a per-instance nonce so
 * two pools inside one process cannot. The previous shared default was a data-loss bug:
 * a second instance deleted the first instance's in-flight tree and then handed the same
 * path to a different worker, whose patch could carry their work.
 *
 * The pid level is kept as its own directory so a dead process's copies can be swept as
 * a unit, and the nonce lives below it.
 *
 * @param {string} root - the canonical service root.
 * @returns {string} the state directory for this process, root, and pool.
 */
function defaultStateDir(root) {
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 12)
  const instance = randomUUID().slice(0, 8)
  return join(tmpdir(), 'flash-mcp', digest, String(process.pid), instance)
}

/**
 * Whether a process is still running. Used to decide whose old trees are safe to remove.
 * @param {number} pid - the process id to ask about.
 * @returns {boolean} true when the process exists.
 */
function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists and belongs to someone else; ESRCH means it is gone.
    return error?.code === 'EPERM'
  }
}

/**
 * Remove the state directories of processes that no longer exist.
 *
 * Only siblings for *this root* are considered, and only directories named after a
 * numeric pid: a live service's trees are never touched, which is the property the
 * constructor's blanket `rm -rf slots` did not have.
 *
 * @param {string} root - the canonical service root.
 * @returns {void}
 */
function sweepDeadOwners(root) {
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 12)
  const parent = join(tmpdir(), 'flash-mcp', digest)
  if (!existsSync(parent)) return
  for (const entry of readdirSync(parent)) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue
    if (processAlive(Number(entry))) continue
    rmSync(join(parent, entry), { recursive: true, force: true })
  }
}

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
/** One error message from an unknown throwable. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

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
  const copy = (args) => execFileSync('cp', [...args, source, to], { stdio: ['ignore', 'ignore', 'pipe'] })
  // `-c` is macOS's "clone the blocks" flag; on GNU coreutils it means nothing and
  // would either error or take a different meaning, while `--reflink=always` is the
  // Linux spelling and refuses rather than silently copying when unsupported. The
  // `always` form is what makes the returned mechanism honest: a silent fallback
  // inside `cp --reflink=auto` would be reported as a clone that never happened.
  try {
    if (process.platform === 'darwin') {
      copy(['-cR'])
    } else {
      copy(['--reflink=always', '-R'])
    }
    return 'clone'
  } catch {
    copy(['-R'])
    return 'copy'
  }
}

/**
 * Make one name inside a copied tree invisible to git, so the worker's temp files are
 * not part of the change it reports.
 *
 * The copy's own `.git/info/exclude` is used rather than the caller's `.gitignore`: the
 * exclusion belongs to this disposable tree, not to the repository it was copied from.
 *
 * @param {string} dir - a copied tree.
 * @param {string} name - the entry to exclude, relative to the tree.
 * @returns {void}
 */
function excludeFromDiff(dir, name) {
  const infoDir = join(dir, '.git', 'info')
  if (!existsSync(infoDir)) return
  const excludePath = join(infoDir, 'exclude')
  try {
    const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
    if (current.split('\n').includes(`${name}/`)) return
    const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n'
    writeFileSync(excludePath, `${current}${separator}# flash-mcp: the worker's temp directory, inside the disposable copy\n${name}/\n`)
  } catch {
    // A tree whose .git cannot be written is still usable; the diff will simply name
    // the temp directory as ignored work.
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
   * @param {string} [options.stateDir] - where slot trees and stored patches live. When
   *   it is omitted the layout is per root *and* per process, so two services cannot
   *   share a tree or a patch directory by accident. A configured directory is used as
   *   given: one service per directory is then the deployment's responsibility.
   * @param {(message: string) => void} [options.log] - progress log.
   */
  constructor({ root, slots = 2, stateDir, log = () => {} }) {
    this.root = resolve(root)
    /** Whether this instance owns a private state directory it may clear. */
    this.ownsStateDir = stateDir === undefined || stateDir === null || stateDir === ''
    this.stateDir = this.ownsStateDir ? defaultStateDir(this.root) : resolve(stateDir)
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
    // Only trees this process owns are cleared. A default state directory is private
    // by construction, so clearing it cannot touch a live service; the dead owners of
    // previous runs are removed too, since their copies are dead weight whose reuse
    // would hand a worker another call's leftovers.
    if (this.ownsStateDir) sweepDeadOwners(this.root)
    rmSync(join(this.stateDir, 'slots'), { recursive: true, force: true })
    mkdirSync(join(this.stateDir, 'calls'), { recursive: true })
    for (const slot of this.slots) {
      mkdirSync(slot.dir, { recursive: true })
      slot.tmpDir = join(slot.dir, SLOT_TMP)
    }
  }

  /** How many trees may be in flight at once. */
  get size() {
    return this.slots.length
  }

  /**
   * Take a slot, waiting for one when every tree is in use.
   *
   * Waiting is bounded by the caller's own budget and cancellable: a call that is
   * cancelled or out of time must not go on to lease a tree, copy a repository, and
   * only then discover that nobody is waiting for the answer.
   *
   * @param {object} [options] - how long the caller may wait.
   * @param {AbortSignal} [options.signal] - client cancellation.
   * @param {number} [options.deadline] - epoch milliseconds this call must be done by.
   * @returns {Promise<Slot>} the slot this call owns until it is released.
   * @throws {IsolationError} with code `CANCELLED` or `TIMEOUT`.
   */
  async lease({ signal, deadline } = {}) {
    const budget = deadline === undefined ? undefined : Math.max(0, deadline - Date.now())
    if (signal?.aborted === true) throw new IsolationError('the call was cancelled before a tree could be leased', 'CANCELLED')
    if (budget === 0) throw new IsolationError('the call had no time left before a tree could be leased', 'TIMEOUT')
    const free = this.slots.find((slot) => !slot.busy)
    if (free !== undefined) {
      free.busy = true
      return free
    }
    return await new Promise((resolveLease, rejectLease) => {
      const waiter = { resolveLease, rejectLease, signal, timer: undefined, onAbort: undefined }
      waiter.settle = (settle, value) => {
        this.#dropWaiter(waiter)
        settle(value)
      }
      if (budget !== undefined) {
        waiter.timer = setTimeout(() => {
          waiter.settle(rejectLease, new IsolationError(`no tree was free within the call's ${String(budget)}ms budget`, 'TIMEOUT'))
        }, budget)
      }
      if (signal !== undefined) {
        waiter.onAbort = () => {
          waiter.settle(rejectLease, new IsolationError('the call was cancelled while waiting for a tree', 'CANCELLED'))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiting.push(waiter)
    })
  }

  /**
   * Take a waiter out of the queue and off its timers.
   * @param {object} waiter - the waiter to forget.
   * @returns {void}
   */
  #dropWaiter(waiter) {
    const at = this.waiting.indexOf(waiter)
    if (at >= 0) this.waiting.splice(at, 1)
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    if (waiter.onAbort !== undefined) waiter.signal?.removeEventListener?.('abort', waiter.onAbort)
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
      next.settle(next.resolveLease, slot)
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
    // The worker has nowhere legitimate to write outside its copy — the wall refuses
    // it, and the sandbox is wider than the workspace — so it is given a temp
    // directory *inside* the copy and pointed at it through TMPDIR. Excluded before
    // the base commit, so tools that write there produce no diff and no surprise.
    slot.tmpDir = join(slot.dir, SLOT_TMP)
    mkdirSync(slot.tmpDir, { recursive: true })
    excludeFromDiff(slot.dir, SLOT_TMP)
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
      const metaPath = join(this.stateDir, 'calls', `${patchId}.json`)
      const diff = git(['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', slot.base], slot.dir)
      const diffstat = git(['diff', '--cached', '--stat', '--no-color', slot.base], slot.dir)
      const names = git(['diff', '--cached', '--name-status', slot.base], slot.dir)
      const filesChanged = names.split('\n').filter((line) => line.trim().length > 0)
      // Work that git ignores is work the patch cannot carry. It is reported rather
      // than silently dropped: a caller told "no change" while the worker wrote a
      // whole build directory has been misled, not informed.
      const ignored = ignoredPaths(slot.dir).filter((entry) => !(slot.ignoredBase ?? []).includes(entry))
      // The record travels with the patch, so a restarted service can still tell which
      // repository the patch was computed for and whether it has already been applied.
      const record = {
        patchId,
        patchPath,
        metaPath,
        root: this.root,
        base: slot.base,
        filesChanged,
        diffstat: diffstat.trim(),
        createdAt: Date.now(),
        appliedAt: null,
      }
      writeFileSync(patchPath, diff)
      this.#writeMeta(record)
      this.patches.set(patchId, record)
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
   * @param {boolean} [options.force] - apply again even though the record says it was applied.
   * @returns {{patchId: string, applied: boolean, dryRun: boolean, root: string, filesChanged: string[], diffstat: string}} the outcome.
   * @throws {Error} when the patch is unknown, belongs to another repository, was already
   *   applied, or does not apply.
   */
  apply({ patchId, dryRun = false, force = false }) {
    const record = this.#lookupPatch(patchId)
    if (!existsSync(record.patchPath)) throw new Error(`the patch file for ${patchId} is gone (${record.patchPath})`)
    // A patch that was applied once is not idempotent: `git apply` may well find a
    // second place to put the change when the surrounding lines repeat. Recording the
    // apply is what makes "already applied" a rule instead of a coincidence.
    if (!dryRun && !force && record.appliedAt !== null && record.appliedAt !== undefined) {
      throw new Error(
        `patch ${patchId} was already applied to ${this.root} at ${new Date(record.appliedAt).toISOString()}; pass force: true to apply it again`,
      )
    }
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
    if (!dryRun) {
      record.appliedAt = Date.now()
      this.#writeMeta(record)
      this.patches.set(patchId, record)
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
   * Find one patch, and refuse to hand back one this service may not apply.
   *
   * Two refusals matter here. The id must have the shape this service issues, because
   * the id is used to build a path — `../` used to reach any `.patch` on disk. And the
   * record must name *this* repository: a patch computed for another root is not a
   * merge, it is a different edit to different files, and applying it produced a tree
   * holding another caller's work under this caller's name.
   *
   * @param {string} patchId - the id to look for.
   * @returns {object} the held or re-read record.
   * @throws {Error} when the id is malformed, unknown, or belongs to another root.
   */
  #lookupPatch(patchId) {
    if (typeof patchId !== 'string' || !PATCH_ID.test(patchId)) {
      throw new Error(
        `patchId ${JSON.stringify(patchId)} is not an id this service issues; ids look like "flash-<uuid>"`,
      )
    }
    const held = this.patches.get(patchId)
    if (held !== undefined) return held
    const metaPath = join(this.stateDir, 'calls', `${patchId}.json`)
    if (!existsSync(metaPath)) {
      throw new Error(
        `no patch ${patchId} is held by this service; patches are kept in ${join(this.stateDir, 'calls')}`,
      )
    }
    let record
    try {
      record = JSON.parse(readFileSync(metaPath, 'utf8'))
    } catch (error) {
      throw new Error(`the record for patch ${patchId} is unreadable: ${messageOf(error)}`)
    }
    record.metaPath = metaPath
    record.patchPath = join(this.stateDir, 'calls', `${patchId}.patch`)
    if (record.root !== this.root) {
      throw new Error(
        `patch ${patchId} was computed for ${String(record.root)}, not for ${this.root}; patches do not cross repositories`,
      )
    }
    this.patches.set(patchId, record)
    return record
  }

  /**
   * Write a patch's record next to it.
   * @param {object} record - the record to store.
   * @returns {void}
   */
  #writeMeta(record) {
    const { patchId, root, base, filesChanged, diffstat, createdAt, appliedAt } = record
    writeFileSync(
      record.metaPath,
      `${JSON.stringify({ patchId, root, base, filesChanged, diffstat, createdAt, appliedAt }, null, 2)}\n`,
    )
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
