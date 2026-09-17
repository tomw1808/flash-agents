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
 * @property {number} dirIndex - how many times the slot has been moved to a fresh path.
 * @property {string[]} orphans - trees left in place by `retire`, removed when the pool closes.
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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

/**
 * How hard `emptyDirectory` tries when a dying process is still writing inside the tree
 * it is emptying, and how long it waits between attempts.
 */
const EMPTY_RETRIES = 3
const EMPTY_RETRY_DELAY_MS = 50

/**
 * How long a stored patch survives without being applied. The window is a startup
 * default; a service overrides it from `limits.patchRetentionDays`.
 */
export const PATCH_RETENTION_DAYS = 14

/** One day in milliseconds, the unit of the retention window. */
const DAY_MS = 24 * 60 * 60 * 1000

/** The shape of a per-root directory name: a truncated sha256 digest. */
const DIGEST_NAME = /^[0-9a-f]{12}$/

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
 * The one directory every default layout sits under: `$TMPDIR/flash-mcp`.
 *
 * It is the unit disk hygiene works on: per-root digests below it, each holding one
 * directory per server pid and a `patches/` directory that outlives the process.
 *
 * @returns {string} the base state directory.
 */
function stateBaseDir() {
  return join(tmpdir(), 'flash-mcp')
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
  const instance = randomUUID().slice(0, 8)
  return join(stateBaseDir(), rootDigest(root), String(process.pid), instance)
}

/**
 * The per-root directory name every layout below is keyed by.
 * @param {string} root - the canonical service root.
 * @returns {string} a short stable digest of that path.
 */
export function rootDigest(root) {
  return createHash('sha256').update(root).digest('hex').slice(0, 12)
}

/**
 * Where patches live for one root.
 *
 * Deliberately NOT under the pid level. `sweepDeadOwners` reclaims a dead owner's
 * directory whole, and a patch is the one thing inside it the caller may still need:
 * a self-test lost a finished worker's patch exactly this way when the next service
 * started on the same root. Patches therefore sit beside the pid directories — which
 * the sweep only visits for numeric names — and outlive the process that issued them.
 *
 * @param {string} root - the canonical service root.
 * @returns {string} the patch directory for this root.
 */
function defaultPatchDir(root) {
  return join(stateBaseDir(), rootDigest(root), 'patches')
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
 * The numeric per-pid owner directories of one root digest.
 * @param {string} digestDir - one `$TMPDIR/flash-mcp/<digest>` directory.
 * @returns {string[]} the owner directory names, in readdir order.
 */
function ownerDirs(digestDir) {
  try {
    return readdirSync(digestDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * The owners of one digest that are still running.
 * @param {string} digestDir - one `$TMPDIR/flash-mcp/<digest>` directory.
 * @returns {number[]} the live pids.
 */
function livePidsIn(digestDir) {
  return ownerDirs(digestDir).map(Number).filter(processAlive)
}

/**
 * Whether a directory tree holds any file at all.
 *
 * A digest left behind by a finished test run contains only empty directories —
 * the pid shell and an empty `patches/` — so "holds no file" is what makes it
 * removable without guessing at names.
 *
 * @param {string} dir - the directory to walk.
 * @returns {boolean} true when at least one file exists below it.
 */
function treeHasFiles(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.isFile()) return true
    if (entry.isDirectory() && treeHasFiles(join(dir, entry.name))) return true
  }
  return false
}

/**
 * The total size in bytes of the files below a directory.
 * @param {string} dir - the directory to size.
 * @returns {number} the sum of the file sizes, unreadable entries counted as zero.
 */
function directorySize(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const child = join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += directorySize(child)
      else if (entry.isFile()) total += statSync(child).size
    } catch {
      // A file that vanished mid-walk contributes nothing.
    }
  }
  return total
}

/**
 * The per-root digest directories under a state base directory.
 * @param {string} baseDir - usually `$TMPDIR/flash-mcp`.
 * @returns {string[]} the digest names, sorted.
 */
function digestDirs(baseDir) {
  try {
    return readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && DIGEST_NAME.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Count and size the slot trees and patches of one root digest.
 * @param {string} digestDir - one `$TMPDIR/flash-mcp/<digest>` directory.
 * @returns {{slotTrees: number, slotBytes: number, patches: number, patchBytes: number}} the facts.
 */
function digestStats(digestDir) {
  let slotTrees = 0
  let slotBytes = 0
  for (const pid of ownerDirs(digestDir)) {
    const slotsDir = join(digestDir, pid, 'slots')
    let slots
    try {
      slots = readdirSync(slotsDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const slot of slots) {
      if (!slot.isDirectory()) continue
      slotTrees += 1
      slotBytes += directorySize(join(slotsDir, slot.name))
    }
  }
  let patches = 0
  let patchBytes = 0
  const patchesDir = join(digestDir, 'patches')
  try {
    for (const entry of readdirSync(patchesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.patch')) continue
      patches += 1
      try {
        patchBytes += statSync(join(patchesDir, entry.name)).size
      } catch {
        // A patch that vanished mid-walk contributes nothing.
      }
    }
  } catch {
    // No `patches/` directory: nothing stored for this root.
  }
  return { slotTrees, slotBytes, patches, patchBytes }
}

/**
 * Whether a patch record is past the retention window.
 *
 * Age is measured from `createdAt`, but a patch salvaged recently is kept even when
 * its own timestamp is old: the salvage is the only copy of a dead worker's work,
 * and the sweep just recovered it. A record without a usable `createdAt` is never
 * pruned — deleting work on a parse failure is worse than keeping a stale file.
 *
 * @param {object} record - a parsed patch record.
 * @param {number} cutoff - epoch milliseconds before which a patch is old.
 * @returns {boolean} true when the patch and its files may be removed.
 */
function patchExpired(record, cutoff) {
  const createdAt = Number(record?.createdAt)
  if (!Number.isFinite(createdAt) || createdAt >= cutoff) return false
  const salvagedAt = Number(record?.salvagedFrom?.sweptAt)
  if (Number.isFinite(salvagedAt) && salvagedAt >= cutoff) return false
  return true
}

/**
 * Remove this root's patches that are older than the retention window.
 * @param {string} patchDir - the root's patch directory.
 * @param {object} [options] - the window and the clock.
 * @param {number} [options.retentionDays] - how long an unapplied patch survives.
 * @param {number} [options.now] - the current time, for tests.
 * @returns {number} how many patches were removed.
 */
export function prunePatches(patchDir, { retentionDays = PATCH_RETENTION_DAYS, now = Date.now() } = {}) {
  const cutoff = now - retentionDays * DAY_MS
  let names
  try {
    names = readdirSync(patchDir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const patchId = name.slice(0, -'.json'.length)
    if (!PATCH_ID.test(patchId)) continue
    const metaPath = join(patchDir, name)
    let record
    try {
      record = JSON.parse(readFileSync(metaPath, 'utf8'))
    } catch {
      // A record that cannot be parsed cannot be aged; leave it for a human.
      continue
    }
    if (record?.patchId !== patchId || !patchExpired(record, cutoff)) continue
    try {
      rmSync(metaPath, { force: true })
      rmSync(join(patchDir, `${patchId}.patch`), { force: true })
      removed += 1
    } catch {
      // A patch that will not go away is retried by the next startup.
    }
  }
  return removed
}

/**
 * Remove the dead owners' directories of one digest, without salvage.
 *
 * Used by `clean --all` for a foreign root: salvage needs the root string, which the
 * digest does not carry, so the trees go and the patches beside them stay.
 *
 * @param {string} digestDir - one `$TMPDIR/flash-mcp/<digest>` directory.
 * @param {(message: string) => void} [log] - progress log.
 * @returns {number} how many owners were removed.
 */
function removeDeadOwnerDirs(digestDir, log = () => {}) {
  let removed = 0
  for (const pid of ownerDirs(digestDir)) {
    if (processAlive(Number(pid))) continue
    try {
      rmSync(join(digestDir, pid), { recursive: true, force: true })
      removed += 1
    } catch (error) {
      log(`could not remove dead owner ${pid} in ${digestDir}: ${messageOf(error)}`)
    }
  }
  return removed
}

/**
 * Remove digest directories of *other* roots that hold no files and no live owner.
 *
 * This is where the test suite's empty leftovers go: every throwaway root used to
 * leave its own digest behind, so `$TMPDIR/flash-mcp` filled with directories that
 * held nothing at all. A digest with any file, or with a live owner, is left alone —
 * this root's digest is never a candidate.
 *
 * @param {string} root - the canonical service root.
 * @param {object} [options] - where the layout lives and how to report.
 * @param {string} [options.baseDir] - the state base directory.
 * @param {(message: string) => void} [options.log] - progress log.
 * @returns {number} how many digest directories were removed.
 */
function removeEmptyForeignDigests(root, { baseDir = stateBaseDir(), log = () => {} } = {}) {
  const own = rootDigest(root)
  let removed = 0
  for (const digest of digestDirs(baseDir)) {
    if (digest === own) continue
    const dir = join(baseDir, digest)
    if (livePidsIn(dir).length > 0) continue
    if (treeHasFiles(dir)) continue
    try {
      rmSync(dir, { recursive: true, force: true })
      removed += 1
    } catch (error) {
      log(`could not remove empty state directory ${dir}: ${messageOf(error)}`)
    }
  }
  return removed
}

/**
 * Remove the state directories of processes that no longer exist, salvaging unfinished
 * work first.
 *
 * Only siblings for *this root* are considered, and only directories named after a
 * numeric pid: a live service's trees are never touched, which is the property the
 * constructor's blanket `rm -rf slots` did not have.
 *
 * A dead owner's tree may hold a worker's mid-task edit, and removing the directory
 * whole used to lose it with the restart. Every slot under `slots/` — under whatever
 * name, including the retired `<id>-<n>` generations — is therefore examined before the
 * owner is removed, and a dirty tree is stored as a patch beside the surviving ones. A
 * tree that cannot be read is logged and skipped: the sweep's job is to start the next
 * server, never to wedge on a corpse.
 *
 * @param {string} root - the canonical service root.
 * @param {object} options - where to put salvaged patches and how to report.
 * @param {string} options.patchDir - the root's patch directory.
 * @param {string} [options.baseDir] - the state base directory.
 * @param {(message: string) => void} [options.log] - progress log.
 * @returns {number} how many dead owners were removed.
 */
function sweepDeadOwners(root, { patchDir, baseDir = stateBaseDir(), log = () => {} } = {}) {
  const parent = join(baseDir, rootDigest(root))
  if (!existsSync(parent)) return 0
  let removed = 0
  for (const entry of ownerDirs(parent)) {
    if (Number(entry) === process.pid) continue
    if (processAlive(Number(entry))) continue
    const ownerDir = join(parent, entry)
    try {
      salvageOwner(ownerDir, { root, patchDir, log, pid: Number(entry) })
    } catch (error) {
      // Salvage is best-effort: whatever went wrong, the dead directory is still dead
      // weight and the new server must come up.
      log(`could not salvage work from dead owner ${entry}: ${messageOf(error)}`)
    }
    try {
      rmSync(ownerDir, { recursive: true, force: true })
      removed += 1
    } catch (error) {
      // A directory that will not go away is retried by the next sweep; refusing to start
      // over it would be the wedge this function exists to prevent.
      log(`could not remove dead owner ${entry}: ${messageOf(error)}`)
    }
  }
  return removed
}

/**
 * Store every salvageable tree under one dead owner's `slots/` directory.
 *
 * Names are not assumed: a slot that was retired once lives at `slot-<id>-1`, and a
 * future naming change must not silently drop work. The directory is read as a plain
 * list and every entry is offered to `salvageSlot`.
 *
 * @param {string} ownerDir - the dead owner's per-pid directory.
 * @param {object} options - root, patch directory, log, and the owner's pid.
 * @returns {void}
 */
function salvageOwner(ownerDir, { root, patchDir, log, pid }) {
  let names
  try {
    names = readdirSync(join(ownerDir, 'slots'))
  } catch {
    // No `slots/` at all (or an unreadable one) is the common, fast case: nothing to keep.
    return
  }
  const sweptAt = Date.now()
  for (const name of names) {
    const slotDir = join(ownerDir, 'slots', name)
    try {
      const salvaged = salvageSlot(slotDir, { root, patchDir, pid, sweptAt })
      if (salvaged !== null) {
        log(
          `salvaged ${salvaged.patchId} from dead owner ${String(pid)} slot ${slotDir}: ` +
            salvaged.diffstat.replace(/\s*\n\s*/g, '; '),
        )
      }
    } catch (error) {
      // A tree that cannot be read or whose diff fails is named and removed anyway. The
      // alternative — wedging the next server on a corpse until a human intervenes — is
      // exactly the failure this sweep exists to avoid.
      log(`could not salvage ${slotDir} from dead owner ${String(pid)}: ${messageOf(error)}`)
    }
  }
}

/**
 * Turn one dead slot's uncommitted work into a stored patch.
 *
 * The tree is diffed exactly as `collect` diffs a live one: everything is staged with
 * `git add -A`, and an empty `git status` after that means there is nothing to keep. A
 * tree without a `flash base` commit was not prepared by this service — an empty or
 * freshly retired directory, say — so it is left for the removal that follows. That
 * check keeps the common clean-or-empty case to one cheap `git log`.
 *
 * @param {string} slotDir - the tree to salvage.
 * @param {object} options - the root, patch directory, dead pid, and sweep time.
 * @returns {{patchId: string, diffstat: string} | null} the stored patch, or null.
 */
function salvageSlot(slotDir, { root, patchDir, pid, sweptAt }) {
  if (!isGitWorkTree(slotDir)) return null
  const base = findFlashBase(slotDir)
  if (base === null) return null
  git(['add', '-A'], slotDir)
  if (git(['status', '--porcelain'], slotDir).trim() === '') return null
  const patchId = `flash-${randomUUID()}`
  const patchPath = join(patchDir, `${patchId}.patch`)
  const metaPath = join(patchDir, `${patchId}.json`)
  const diff = git(['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', base], slotDir)
  const diffstat = git(['diff', '--cached', '--stat', '--no-color', base], slotDir).trim()
  const names = git(['diff', '--cached', '--name-status', base], slotDir)
  const filesChanged = names.split('\n').filter((line) => line.trim().length > 0)
  const record = {
    patchId,
    patchPath,
    metaPath,
    root,
    base,
    filesChanged,
    diffstat,
    createdAt: Date.now(),
    appliedAt: null,
    // Where this patch came from, so a log line or a listing has an answer to "whose
    // tree was this, and when did we find it?".
    salvagedFrom: { pid, slotDir, sweptAt },
  }
  mkdirSync(patchDir, { recursive: true })
  writeFileSync(patchPath, diff)
  writePatchMeta(record)
  return { patchId, diffstat }
}

/**
 * The base commit `prepare` recorded in a tree, or null when there is none.
 *
 * The base is committed with the fixed subject `flash base`, so it can be recognized
 * from the tree alone — which is all a dead owner leaves behind. The most recent such
 * commit is used, so a worker that committed on top of the base is still diffed from
 * the state the call started at.
 *
 * @param {string} dir - a git work tree.
 * @returns {string | null} the base commit id, or null.
 */
function findFlashBase(dir) {
  const log = git(['log', '--format=%H%x09%s'], dir)
  for (const line of log.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    if (line.slice(tab + 1).trim() === 'flash base') return line.slice(0, tab)
  }
  return null
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
 * Write a patch's record next to it, keeping only the fields a restart must trust.
 *
 * `patchPath` and `metaPath` are derivable from the patch directory and the id, so they
 * are not persisted; `salvagedFrom` is persisted only when it exists, so an ordinary
 * patch's record keeps its previous shape.
 *
 * @param {object} record - the record to store.
 * @returns {void}
 */
function writePatchMeta(record) {
  const { patchId, root, base, filesChanged, diffstat, createdAt, appliedAt, salvagedFrom } = record
  const meta = { patchId, root, base, filesChanged, diffstat, createdAt, appliedAt }
  if (salvagedFrom !== undefined) meta.salvagedFrom = salvagedFrom
  writeFileSync(record.metaPath, `${JSON.stringify(meta, null, 2)}\n`)
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
 * Remove a slot's tree without removing the directory that contains it.
 *
 * The directory itself has to survive: a running runtime holds it as its working
 * directory, and its sandbox root is fixed at the path it was started with.
 *
 * @param {string} dir - the directory to empty.
 * @returns {void}
 */
function emptyDirectory(dir) {
  for (const entry of readdirSync(dir)) {
    rmSync(join(dir, entry), {
      recursive: true,
      force: true,
      // A process that is still dying (a Harness session, or the `swift build` it
      // spawned) can create an entry between the readdir above and the removal, and the
      // removal then fails with ENOTEMPTY. `rmSync` retries exactly that class of error
      // (ENOTEMPTY/EBUSY/EPERM) with a short backoff, so a straggler cannot wedge the
      // slot; when the path never empties its own error is kept and propagates.
      maxRetries: EMPTY_RETRIES,
      retryDelay: EMPTY_RETRY_DELAY_MS,
    })
  }
}

/**
 * The directory one slot uses at a given generation.
 *
 * Generation 0 is `slot-<id>`, the path every state directory has used; each `retire`
 * moves the slot on to `<id>-1`, `<id>-2`, … so the orphaned tree can keep its own name.
 *
 * @param {string} stateDir - the pool's state directory.
 * @param {number} id - slot number.
 * @param {number} index - the slot's directory generation.
 * @returns {string} the slot directory for that generation.
 */
function slotDirectory(stateDir, id, index) {
  const name = index === 0 ? `slot-${String(id)}` : `slot-${String(id)}-${String(index)}`
  return join(stateDir, 'slots', name)
}

/**
 * Report and reclaim the default state base: one line of facts per root digest.
 *
 * This is what the `clean` CLI command runs. The default reclaims exactly what a
 * startup does for this root — salvage and remove its dead owners, prune its expired
 * patches, and drop other roots' empty digest leftovers — while `--all` goes
 * further and removes the trees of every root that has no live server, because an
 * operator asking for `--all` has decided nobody is coming back for them. Patches are
 * never removed by `--all`: they are the only copy of a finished worker's work, and a
 * root without a live server is precisely where a caller might still want one.
 *
 * @param {object} options - what to report and reclaim.
 * @param {string} [options.baseDir] - the state base directory, usually `$TMPDIR/flash-mcp`.
 * @param {string} options.root - the canonical service root of this invocation.
 * @param {boolean} [options.all] - also remove the trees of roots with no live server.
 * @param {number} [options.retentionDays] - the patch retention window.
 * @param {number} [options.now] - the current time, for tests.
 * @param {(message: string) => void} [options.log] - progress log.
 * @returns {{baseDir: string, own: string, stats: object[], actions: object}} the report.
 */
export function cleanLayout({ baseDir = stateBaseDir(), root, all = false, retentionDays = PATCH_RETENTION_DAYS, now = Date.now(), log = () => {} } = {}) {
  const own = rootDigest(root)
  // Facts are read before anything is removed, so the report describes what was found.
  const stats = digestDirs(baseDir).map((digest) => ({
    digest,
    own: digest === own,
    livePids: livePidsIn(join(baseDir, digest)),
    ...digestStats(join(baseDir, digest)),
  }))
  const actions = { deadOwnersRemoved: 0, patchesPruned: 0, emptyDigestsRemoved: 0, foreignTreesRemoved: 0 }
  const ownDir = join(baseDir, own)
  if (existsSync(ownDir)) {
    actions.deadOwnersRemoved = sweepDeadOwners(root, { patchDir: join(ownDir, 'patches'), baseDir, log })
    actions.patchesPruned = prunePatches(join(ownDir, 'patches'), { retentionDays, now })
  }
  actions.emptyDigestsRemoved = removeEmptyForeignDigests(root, { baseDir, log })
  if (all) {
    for (const digest of digestDirs(baseDir)) {
      if (digest === own) continue
      const dir = join(baseDir, digest)
      if (livePidsIn(dir).length > 0) continue
      actions.foreignTreesRemoved += removeDeadOwnerDirs(dir, log)
    }
    actions.emptyDigestsRemoved += removeEmptyForeignDigests(root, { baseDir, log })
  }
  return { baseDir, own, stats, actions }
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
   * @param {number} [options.patchRetentionDays] - how many days an unapplied patch is
   *   kept before the startup prune removes it.
   * @param {(message: string) => void} [options.log] - progress log.
   */
  constructor({ root, slots = 2, stateDir, patchRetentionDays = PATCH_RETENTION_DAYS, log = () => {} }) {
    this.root = resolve(root)
    /** Whether this instance owns a private state directory it may clear. */
    this.ownsStateDir = stateDir === undefined || stateDir === null || stateDir === ''
    this.stateDir = this.ownsStateDir ? defaultStateDir(this.root) : resolve(stateDir)
    /**
     * Where patches are stored. With a private state directory they sit one level
     * above this process's own, so the sweep that reclaims a dead service's copies
     * cannot take a patch the caller was told it could still apply.
     */
    this.patchDir = this.ownsStateDir ? defaultPatchDir(this.root) : join(this.stateDir, 'calls')
    this.patchRetentionDays = patchRetentionDays
    this.log = log
    this.clones = 0
    /** Patches kept for a later `flash_apply`. @type {Map<string, object>} */
    this.patches = new Map()
    /** Callers waiting for a slot, oldest first. @type {Function[]} */
    this.waiting = []
    this.slots = Array.from({ length: Math.max(1, slots) }, (_, id) => ({
      id,
      dirIndex: 0,
      dir: slotDirectory(this.stateDir, id, 0),
      base: null,
      busy: false,
      orphans: [],
    }))
    // Only trees this process owns are cleared. A default state directory is private
    // by construction, so clearing it cannot touch a live service; the dead owners of
    // previous runs are removed too, since their copies are dead weight whose reuse
    // would hand a worker another call's leftovers. Their unfinished work is stored as a
    // patch on the way out (see `sweepDeadOwners`), because a restart must not be the end
    // of a round that was minutes from finishing.
    //
    // After the sweep, disk hygiene runs in the same pass: other roots' empty digest
    // directories are dropped, and this root's patches past the retention window are
    // pruned. Both happen before `#loadPatches`, so the in-memory view only ever holds
    // patches that still exist on disk. The prune runs for a configured state directory
    // too, because an unapplied patch ages out wherever it is stored.
    mkdirSync(this.stateDir, { recursive: true })
    mkdirSync(this.patchDir, { recursive: true })
    if (this.ownsStateDir) {
      sweepDeadOwners(this.root, { patchDir: this.patchDir, log: this.log })
      removeEmptyForeignDigests(this.root, { log: this.log })
    }
    prunePatches(this.patchDir, { retentionDays: this.patchRetentionDays })
    rmSync(join(this.stateDir, 'slots'), { recursive: true, force: true })
    // Patches already on disk are made available to `apply` and `listPatches` up front,
    // so one this sweep just salvaged behaves exactly like one this process collected.
    this.#loadPatches()
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
   * Read the patch records already on disk into memory.
   *
   * A patch must survive the process that issued it, so the records are the source of
   * truth and `apply` would re-read one anyway. Loading them on construction makes the
   * in-memory view match disk: `listPatches` can then answer without touching the
   * filesystem, and a record salvaged by the sweep is visible immediately.
   *
   * Records for another root are skipped: a patch is only applicable to the repository
   * it was computed for, and keeping a foreign record in `patches` would defeat the
   * refusal in `#lookupPatch`.
   *
   * @returns {void}
   */
  #loadPatches() {
    let names
    try {
      names = readdirSync(this.patchDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const patchId = name.slice(0, -'.json'.length)
      if (!PATCH_ID.test(patchId) || this.patches.has(patchId)) continue
      const metaPath = join(this.patchDir, name)
      let record
      try {
        record = JSON.parse(readFileSync(metaPath, 'utf8'))
      } catch {
        // A record that cannot be parsed is not a patch anybody can apply; it must not
        // stop the service from starting.
        continue
      }
      if (record?.patchId !== patchId || record?.root !== this.root) continue
      record.metaPath = metaPath
      record.patchPath = join(this.patchDir, `${patchId}.patch`)
      this.patches.set(patchId, record)
    }
  }

  /**
   * The patches this service can still apply, newest first.
   *
   * Newest first is the order a caller reads in: the patch it was just told about, then
   * the ones from earlier calls — including any a previous server salvaged from a tree
   * that was mid-task when it died.
   *
   * @returns {object[]} the patch records, most recently created first.
   */
  listPatches() {
    return [...this.patches.values()].sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
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
    // The worker has nowhere legitimate to name outside its copy — the wall refuses
    // it — so it is given a scratch directory *inside* the copy and told about it in
    // its prompt. It is not handed over through TMPDIR: the runtime's sandbox derives
    // its writable roots from the runtime's own TMPDIR, and overriding that withdrew
    // the platform temp area every toolchain assumes. Excluded before the base
    // commit, so tools that write there produce no diff and no surprise.
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
   * Take a tree out of service after its call lost track of the worker. The session that
   * ran there cannot be stopped, so it may still write; recycling the directory would
   * hand its late edits to the next call as that call's own work.
   *
   * The tree therefore keeps its name and stays exactly where it is. The Harness session
   * and the build processes it spawned hold that path as an absolute string, so renaming
   * the tree away only redirects their writes into the fresh empty directory left at the
   * old name — observed as `ENOTEMPTY` when the next call tried to empty it. The slot is
   * moved instead: it is given a path it has never used, created empty, and the orphaned
   * tree is remembered so `close()` still removes it.
   *
   * @param {Slot} slot - the slot whose call timed out.
   */
  retire(slot) {
    const orphan = slot.dir
    const nextIndex = slot.dirIndex + 1
    const nextDir = slotDirectory(this.stateDir, slot.id, nextIndex)
    try {
      mkdirSync(nextDir, { recursive: true })
    } catch (error) {
      this.log(`could not move slot ${String(slot.id)} to a fresh directory: ${messageOf(error)}`)
      return
    }
    slot.dirIndex = nextIndex
    slot.dir = nextDir
    slot.orphans.push(orphan)
    slot.base = null
    slot.baseReason = undefined
    slot.tmpDir = undefined
    slot.ignoredBase = undefined
    this.log(`retired ${orphan} in place: its session may still be writing there; the slot moved to ${nextDir}`)
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
      const patchPath = join(this.patchDir, `${patchId}.patch`)
      const metaPath = join(this.patchDir, `${patchId}.json`)
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
      // The patch directory is shared with sibling services and the startup prune, so
      // it is recreated defensively: writing a finished call's patch must not fail
      // because a concurrent sweep decided this digest looked empty.
      mkdirSync(this.patchDir, { recursive: true })
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
    if (held !== undefined) {
      this.#refreshAppliedAt(held)
      return held
    }
    const metaPath = join(this.patchDir, `${patchId}.json`)
    if (!existsSync(metaPath)) {
      throw new Error(`no patch ${patchId} is held by this service; patches are kept in ${this.patchDir}`)
    }
    let record
    try {
      record = JSON.parse(readFileSync(metaPath, 'utf8'))
    } catch (error) {
      throw new Error(`the record for patch ${patchId} is unreadable: ${messageOf(error)}`)
    }
    record.metaPath = metaPath
    record.patchPath = join(this.patchDir, `${patchId}.patch`)
    if (record.root !== this.root) {
      throw new Error(
        `patch ${patchId} was computed for ${String(record.root)}, not for ${this.root}; patches do not cross repositories`,
      )
    }
    this.patches.set(patchId, record)
    return record
  }

  /**
   * Take the recorded apply from disk when a held record does not have one.
   *
   * The patch directory is shared by every service over one root, so a record loaded here
   * at construction can be applied by a sibling instance afterwards. Without this, the
   * held copy would still say `appliedAt: null` and the "already applied" refusal would
   * depend on which process won a race. A record this process just wrote is left alone.
   *
   * @param {object} record - the held record to refresh in place.
   * @returns {void}
   */
  #refreshAppliedAt(record) {
    if (record.appliedAt !== null && record.appliedAt !== undefined) return
    if (typeof record.metaPath !== 'string') return
    try {
      const onDisk = JSON.parse(readFileSync(record.metaPath, 'utf8'))
      if (onDisk?.appliedAt !== null && onDisk?.appliedAt !== undefined) record.appliedAt = onDisk.appliedAt
    } catch {
      // An unreadable record keeps its in-memory value; `apply` still checks the patch file.
    }
  }

  /**
   * Write a patch's record next to it.
   * @param {object} record - the record to store.
   * @returns {void}
   */
  #writeMeta(record) {
    mkdirSync(this.patchDir, { recursive: true })
    writePatchMeta(record)
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

  /**
   * Remove the slot trees and every orphan they left in place. Stored patches stay: an
   * apply may still be coming.
   */
  close() {
    for (const slot of this.slots) {
      rmSync(slot.dir, { recursive: true, force: true })
      for (const orphan of slot.orphans) rmSync(orphan, { recursive: true, force: true })
    }
    // Belt and braces: everything above lives under `slots`, so this also catches any
    // orphan a slot no longer names.
    rmSync(join(this.stateDir, 'slots'), { recursive: true, force: true })
  }
}
