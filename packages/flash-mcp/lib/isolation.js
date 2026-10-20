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
 * @property {{path: string, change: 'modified' | 'deleted'}[]} ignoredChanged - git-ignored
 *   FILES that existed when the copy was made and the worker has since rewritten or deleted.
 *   The patch cannot carry those either. Files inside an ignored directory are not tracked.
 * @property {string} diffstat - `git diff --stat` output.
 * @property {string} diff - the patch itself, clipped to whole file sections by the service.
 * @property {number} diffChars - the patch length before clipping.
 * @property {string[]} diffOmitted - paths whose section is absent from `diff`, or cut part-way.
 * @property {boolean} stored - whether the patch was written to disk; false for apply "discard".
 * @property {string} [patchId] - id a later `flash_apply` can refer to.
 * @property {string} [patchPath] - where the patch was stored.
 */

import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'

/**
 * The only shape a patch id may have. It is checked before the id is used to build a
 * path, so an id cannot name a different file: `../` in a patch id used to be a way to
 * read any `.patch` on disk.
 */
const PATCH_ID = /^flash-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The git mode of a submodule pointer (a gitlink): it names a commit, not a blob. */
const GITLINK_MODE = '160000'

/** The temp directory a worker is pointed at, relative to its disposable tree. */
const SLOT_TMP = '.flash-tmp'

/**
 * The worker's per-call writable home, relative to its disposable tree. `prepare` empties
 * it with the rest of the slot, so a tool that writes into `$HOME` (wrangler needs
 * `~/.config/.wrangler`, pip and npm their caches) has somewhere that starts clean and
 * cannot reach the caller's real home directory.
 */
const SLOT_HOME = '.flash-home'

/**
 * The worker's per-slot writable caches, relative to its disposable tree.
 *
 * Unlike `.flash-home`, these deliberately survive a later `prepare` in the same slot:
 * a Rust target directory or a package cache kept warm across calls is the whole point of
 * naming one, and it costs no copy because it lives outside the copied repository. They
 * are still removed by `retire`, by the dead-owner sweep and by `close`.
 */
const SLOT_CACHE = '.flash-cache'

/**
 * The per-repository settings file, read once when a pool is constructed. It carries the
 * copy's exclusions and the worker's per-slot environment, which belong to the repository
 * rather than to the service invocation and so cannot live in `flash.config.json`.
 */
const SETTINGS_FILE = '.flash-agents.json'

/**
 * Names left out of every copy unless a repository opts out with
 * `"copyExcludeDefaults": false`. They are the usual homes of secrets: a worker has no use
 * for an access token, and every copy of one is another file holding it on disk. The
 * git-safety rule still applies, so only an ignored, untracked match is left out; a tracked
 * `.env.example` is copied as before.
 */
export const DEFAULT_COPY_EXCLUDE = Object.freeze(['.env', '.env.*', '.mcp.json'])

/**
 * Environment names a `slotEnv` entry may never name. The runtime's sandbox derives its
 * writable roots from the runtime's own `TMPDIR`, and every toolchain reads its own `HOME`;
 * pointing either at the copy withdrew grants the worker depends on (see `#runLocation` in
 * service.js). `DSH_HOME` is the harness's own home: a `cache:` entry survives between
 * calls, so a worker could plant a profile there that governs the next runtime start on
 * that slot. `FLASH_ROUTE_MODEL` is the server's choice alone; a slot that pinned it would
 * make the model in the runtime key a lie. All are refused rather than silently ignored.
 */
const FORBIDDEN_SLOT_ENV = new Set(['TMPDIR', 'TMP', 'TEMP', 'HOME', 'DSH_HOME', 'FLASH_ROUTE_MODEL'])

/** A `slotEnv` value pointing at one per-slot directory: `home:<name>` or `cache:<name>`. */
const SLOT_ENV_VALUE = /^(home|cache):(.+)$/

/**
 * A `slotEnv` value reserving a range of TCP ports for the slot: `port:<base>` or
 * `port:<base>/<stride>`. A slot is a separate directory, not a separate machine, so two
 * workers in parallel otherwise race for the same fixed port; the slot's id selects one
 * number out of the range and the value is therefore stable for the life of the slot.
 */
const PORT_ENV_VALUE = /^port:(\d+)(?:\/(\d+))?$/

/** Smallest port a `port:` entry may hand out; below this is the privileged range. */
const PORT_BASE_MIN = 1024

/** Largest port that exists. */
const PORT_BASE_MAX = 65535

/** Smallest and largest gap between consecutive slots' ports. */
const PORT_STRIDE_MIN = 1
const PORT_STRIDE_MAX = 10000

/** The gap between slots when `port:<base>` names none. */
const PORT_STRIDE_DEFAULT = 10

/** How long a `slotSetup` step may run when it does not say. */
const SETUP_DEFAULT_TIMEOUT_SECONDS = 900

/** The longest a `slotSetup` step may run, whatever it asks for. */
const SETUP_MAX_TIMEOUT_SECONDS = 3600

/** How much of a setup step's output the failure message keeps, from the end. */
const SETUP_OUTPUT_TAIL_BYTES = 4096
/**
 * How long a step's output pipes get to close after the step itself exited, so a failure's
 * tail can be read. A background child the step deliberately left running keeps those pipes
 * open; the step's exit code decides regardless after this.
 */
const SETUP_CLOSE_WAIT_MS = 2000

/** Where kept paths wait while the slot is idle, under `.flash-cache`. */
const SETUP_KEEP_DIR = 'keep'

/** Where setup stamps live, under `.flash-cache`. */
const SETUP_STAMP_DIR = 'setup'

/**
 * The one line a server started without `--allow-slot-setup` reports: in its startup log,
 * and in the warnings of every writing call whose repository configures a setup step.
 */
export const SETUP_NOT_ALLOWED_WARNING =
  '.flash-agents.json configures slotSetup, but this server was not started with --allow-slot-setup (or FLASH_ALLOW_SLOT_SETUP=1), so it did not run'


/** Bound on the paths a result names when the copy started dirty. The count is not capped. */
const UNCOMMITTED_FILES = 100

/**
 * Marker file at the top of a slot that holds only one nested repository of the root. It
 * records that repository's path relative to the root, so a sweep that finds the tree after
 * its owner died still knows where the git state lives. It sits outside the copied
 * repository, so it never appears in a diff.
 */
const SCOPE_MARKER = '.flash-scope'

/**
 * Private ref that holds a slot's base commit. The base is written with `git commit-tree`, so no branch
 * moves: a worker that commits and pushes from the copy (the only durable route out of a nested
 * repository) must not carry a "flash base" commit into the caller's history.
 */
const BASE_REF = 'refs/flash/base'

/**
 * The nested git repository a call works in, as a path relative to the root, or `''` when
 * the whole root has to be copied.
 *
 * A workspace root often holds many independent repositories. Copying all of them for a
 * call that works in one of them costs minutes, and the root's own `git diff` cannot see a
 * nested repository's changes at all, so its patch came back empty. The nearest directory
 * between `cwd` and the root that carries its own `.git` DIRECTORY is copied instead, at
 * the same relative path inside the slot, and it is where the base, the diff and the apply
 * happen.
 *
 * A `.git` FILE — a linked worktree or a submodule — scopes the copy the same way. Its git
 * state lives outside the directory and cannot travel, so `prepare` gives the copy its own
 * repository (see `detachGitLink`); a whole-root copy leaves such a directory out
 * entirely. A `cwd` at the root, or with no nested repository above it, keeps the
 * whole-root copy.
 *
 * @param {string} root - the service root.
 * @param {string | undefined} cwd - the call's working directory inside the root.
 * @returns {string} the repository path relative to the root, or `''`.
 */
export function repositoryScope(root, cwd) {
  if (cwd === undefined) return ''
  const top = resolve(root)
  let dir = resolve(cwd)
  while (dir !== top && dir.startsWith(`${top}${sep}`)) {
    const marker = join(dir, '.git')
    if (existsSync(marker)) return relative(top, dir)
    dir = dirname(dir)
  }
  return ''
}

/**
 * Whether a scope string is a plain relative path safely inside the tree it applies to.
 *
 * A scope is joined onto a caller tree to build a path, so it must not be absolute, must
 * not be empty, and must have no `..`, `.`, empty or NUL-bearing segment. `readScopeMarker`
 * uses this to ignore a marker it should not trust; `#lookupPatch` uses it to refuse a
 * stored record whose scope has been tampered with.
 *
 * @param {unknown} scope - the candidate.
 * @returns {boolean} true when the scope is a safe relative path.
 */
function scopeIsSafe(scope) {
  if (typeof scope !== 'string' || scope === '' || scope.includes('\0')) return false
  if (isAbsolute(scope)) return false
  const parts = scope.split(/[\\/]/)
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

/**
 * The scope a slot was prepared with, read back from its marker; `''` when there is none.
 * @param {string} slotDir - a slot tree.
 * @returns {string} the recorded scope.
 */
function readScopeMarker(slotDir) {
  try {
    // Only a plain relative path inside the tree is trusted; anything else is ignored.
    const scope = readFileSync(join(slotDir, SCOPE_MARKER), 'utf8').trim()
    return scopeIsSafe(scope) ? scope : ''
  } catch {
    return ''
  }
}

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

/**
 * How often a running pool looks for dead owners and trims its state. Startup alone was
 * not enough: with two servers on one root, the survivor never swept the one that died,
 * and its 35 GB of trees waited for some later server to start.
 */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000

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
  return join(canonicalTmpdir(), 'flash-mcp')
}

/**
 * The durable directory a root's patches live in.
 *
 * The temp directory is the right home for disposable worker trees, but the wrong one
 * for a patch: Linux clears `/tmp` on reboot, and macOS removes files in its per-user
 * temp folder that were untouched for about three days — both long before the default
 * retention window. The platform's own state/application-data location survives that,
 * and `FLASH_DATA_DIR` overrides it for callers who already manage one.
 *
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @param {object} [options] - platform details, injected by tests.
 * @param {string} [options.platform] - `process.platform`.
 * @param {string} [options.home] - the user's home directory.
 * @returns {string} the durable base directory, without the root digest.
 */
export function durableBaseDir(env = process.env, { platform = process.platform, home = homedir() } = {}) {
  const configured = env.FLASH_DATA_DIR
  if (typeof configured === 'string' && configured.length > 0) return configured
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA
    return join(typeof localAppData === 'string' && localAppData.length > 0 ? localAppData : join(home, 'AppData', 'Local'), 'flash-agents')
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'flash-agents')
  const stateHome = env.XDG_STATE_HOME
  return join(
    typeof stateHome === 'string' && stateHome.length > 0 ? stateHome : join(home, '.local', 'state'),
    'flash-agents',
  )
}

/**
 * The platform temp directory with its symlinks resolved.
 *
 * On macOS `os.tmpdir()` is `/var/folders/...`, a symlink to `/private/var/...`. A slot
 * tree created under the symlinked spelling becomes the worker's working directory in
 * that spelling, while the guard's fence and the sandbox compare canonical paths — so a
 * worker's `rm -rf .build` in its own tree was refused once as outside the fence, and
 * only succeeded after it `cd`ed to the `/private/var` form of the same directory.
 * Resolving once here means every path the worker ever sees is already canonical.
 *
 * @returns {string} the canonical temp directory, or the raw one when it cannot be
 *   resolved.
 */
export function canonicalTmpdir() {
  const raw = tmpdir()
  try {
    return realpathSync(raw)
  } catch {
    return raw
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
 * Also deliberately not under `stateBaseDir`: an unapplied patch is durable work, so it
 * lives in the platform's durable data location instead of the temp directory that a
 * reboot or a temp cleaner can empty. `mkdirSync` at the point of use creates it on
 * demand; merely reporting the layout must not leave an empty directory behind.
 *
 * @param {string} root - the canonical service root.
 * @returns {string} the patch directory for this root.
 */
function defaultPatchDir(root) {
  return join(durableBaseDir(), rootDigest(root), 'patches')
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

/** A byte count in the unit a person reads it in. @param {number} bytes @returns {string} */
function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${String(Math.round(bytes / 1024))} KB`
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
 *
 * The legacy temp store is read from `<digestDir>/patches`. A default pool keeps its
 * patches in the durable data directory instead, so the caller may name that directory
 * too: without it, `clean` reported `patches: 0` for a root whose patches had already
 * moved, which is exactly the case an operator runs it to inspect. Duplicate directories
 * are counted once, so a configured `dataDir` that happens to be the temp base cannot
 * double a patch.
 *
 * @param {string} digestDir - one `$TMPDIR/flash-mcp/<digest>` directory.
 * @param {string[]} [extraPatchDirs] - further patch directories that belong to this
 *   digest, such as the durable store.
 * @returns {{slotTrees: number, slotBytes: number, patches: number, patchBytes: number}} the facts.
 */
function digestStats(digestDir, extraPatchDirs = []) {
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
  const seen = new Set()
  for (const patchesDir of [join(digestDir, 'patches'), ...extraPatchDirs]) {
    const key = resolve(patchesDir)
    if (seen.has(key)) continue
    seen.add(key)
    try {
      for (const entry of readdirSync(patchesDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.patch')) {
          patches += 1
          try {
            patchBytes += statSync(join(patchesDir, entry.name)).size
          } catch {
            // A patch that vanished mid-walk contributes nothing.
          }
        } else if (entry.isDirectory() && entry.name.endsWith('.blobs')) {
          // The preimage blobs stored beside a patch are part of what that patch costs.
          patchBytes += directorySize(join(patchesDir, entry.name))
        }
      }
    } catch {
      // No `patches/` directory: nothing stored for this root.
    }
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
 *
 * A record that exists but is not yet due is not touched. Artefacts with no record at all —
 * a `<id>.patch` or `<id>.blobs` a crash or a failed write left behind — are removed too,
 * because nothing else can ever reclaim them: their name is only derived from a record that
 * does not exist. They are removed only once their own mtime is past the cutoff, because in
 * a patch directory shared by sibling services a fresh artefact may be a collect that is
 * still running and will write its record a moment later.
 *
 * @param {string} patchDir - the root's patch directory.
 * @param {object} [options] - the window and the clock.
 * @param {number} [options.retentionDays] - how long an unapplied patch survives.
 * @param {number} [options.now] - the current time, for tests.
 * @returns {number} how many patches and orphan artefacts were removed.
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
      removeStoredPatch(patchDir, patchId)
      removed += 1
    } catch {
      // A patch that will not go away is retried by the next startup.
    }
  }
  // The ids that do have a record, read before the loop removed any: an artefact whose id is
  // in this set is somebody's patch, not an orphan.
  const recorded = new Set(names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)))
  for (const name of names) {
    const dot = name.lastIndexOf('.')
    const suffix = dot < 0 ? '' : name.slice(dot)
    if (suffix !== '.patch' && suffix !== '.blobs') continue
    const patchId = name.slice(0, dot)
    if (!PATCH_ID.test(patchId) || recorded.has(patchId)) continue
    let info
    try {
      info = statSync(join(patchDir, name))
    } catch {
      continue
    }
    if (info.mtimeMs >= cutoff) continue
    try {
      rmSync(join(patchDir, name), { recursive: suffix === '.blobs', force: true })
      removed += 1
    } catch {
      // A leftover that will not go away is retried by the next startup.
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
      const salvaged = salvageSlot(slotDir, { root, patchDir, pid, sweptAt, log })
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
 * @param {object} options - the root, patch directory, dead pid, sweep time, and log.
 * @returns {{patchId: string, diffstat: string} | null} the stored patch, or null.
 */
function salvageSlot(slotDir, { root, patchDir, pid, sweptAt, log = () => {} }) {
  const scope = readScopeMarker(slotDir)
  const repoDir = scope === '' ? slotDir : join(slotDir, scope)
  if (!isGitWorkTree(repoDir)) return null
  const base = findFlashBase(repoDir)
  if (base === null) return null
  git(['add', '-A'], repoDir)
  if (git(['status', '--porcelain'], repoDir).trim() === '') return null
  const patchId = `flash-${randomUUID()}`
  const patchPath = join(patchDir, `${patchId}.patch`)
  const metaPath = join(patchDir, `${patchId}.json`)
  const diff = git(['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', base], repoDir)
  const diffstat = git(['diff', '--cached', '--stat', '--no-color', base], repoDir).trim()
  const filesChanged = nameStatusRecords(repoDir, base)
  mkdirSync(patchDir, { recursive: true })
  // Same commit protocol as `collect`: patch, then the blobs a later merge needs, then the
  // record. The dead slot is about to be removed with its owner, so the blobs get exactly
  // the same one chance to be saved.
  writeFileSync(patchPath, diff)
  const preimage = savePreimageBlobs(repoDir, base, patchDir, patchId, log)
  const record = {
    patchId,
    patchPath,
    metaPath,
    storeDir: patchDir,
    root,
    scope,
    base,
    filesChanged,
    diffstat,
    createdAt: Date.now(),
    appliedAt: null,
    // Where this patch came from, so a log line or a listing has an answer to "whose
    // tree was this, and when did we find it?".
    salvagedFrom: { pid, slotDir, sweptAt },
  }
  if (preimage !== undefined) record.preimage = preimage
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
  try {
    const recorded = git(['rev-parse', '--verify', '-q', BASE_REF], dir).trim()
    if (recorded !== '') return recorded
  } catch {
    // Trees prepared before the base moved to a private ref carry it as a branch commit instead.
  }
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

/** One error message from an unknown throwable. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run one git command and return its standard output.
 *
 * @param {string[]} args - arguments after `git`.
 * @param {string} cwd - directory to run in.
 * @param {NodeJS.ProcessEnv} [env] - environment for git (default process.env).
 * @param {string | Buffer} [input] - written to git's standard input. It needs stdin to be
 *   a pipe: `execFileSync` silently drops `input` when `stdio[0]` is `'ignore'`, and
 *   `pack-objects` then reads an empty object list and writes an empty pack with a zero
 *   exit status — the kind of failure nothing downstream would notice.
 * @returns {string} standard output.
 * @throws {Error} with git's own message when the command fails.
 */
function git(args, cwd, env = process.env, input) {
  try {
    return execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(input === undefined ? {} : { input }),
    })
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    throw new Error(`git ${args.join(' ')} failed in ${cwd}${stderr.length === 0 ? '' : `: ${stderr}`}`)
  }
}

/**
 * Run one git command and return its raw standard output.
 *
 * A blob is arbitrary bytes, so the `utf8` decoding every other call uses would corrupt a
 * binary file on its way back into the caller's tree.
 *
 * @param {string[]} args - arguments after `git`.
 * @param {string} cwd - directory to run in.
 * @param {NodeJS.ProcessEnv} [env] - environment for git (default process.env).
 * @returns {Buffer} standard output.
 * @throws {Error} with git's own message when the command fails.
 */
function gitBuffer(args, cwd, env = process.env) {
  try {
    return execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    throw new Error(`git ${args.join(' ')} failed in ${cwd}${stderr.length === 0 ? '' : `: ${stderr}`}`)
  }
}

/**
 * Run one git command whose failure is data rather than an error.
 *
 * `merge-tree` reports conflicts through its exit code while still writing the merged tree
 * to standard output, so its one non-zero status cannot go through `git()`.
 *
 * @param {string[]} args - arguments after `git`.
 * @param {string} cwd - directory to run in.
 * @param {NodeJS.ProcessEnv} [env] - environment for git (default process.env).
 * @returns {{status: number, stdout: string, stderr: string}} the exit status and output.
 */
function gitAllowFailure(args, cwd, env = process.env) {
  try {
    const stdout = execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return {
      status: typeof error?.status === 'number' ? error.status : 1,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr.trim() : '',
    }
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
  const { patchId, root, base, filesChanged, diffstat, createdAt, appliedAt, salvagedFrom, preimage } = record
  const meta = { patchId, root, base, filesChanged, diffstat, createdAt, appliedAt }
  if (salvagedFrom !== undefined) meta.salvagedFrom = salvagedFrom
  // Persisted only for a nested repository, so a whole-root record keeps its old shape and
  // a restarted service still applies a scoped patch inside the repository it came from.
  if (record.scope) meta.scope = record.scope
  // The base entries a three-way merge rebuilds its index from. Persisted only when they
  // were saved: a record whose saving failed (or that predates saving) must stay readable
  // and must let the merge report that the base is unavailable rather than merge wrongly.
  if (Array.isArray(preimage)) meta.preimage = preimage
  writeFileSync(record.metaPath, `${JSON.stringify(meta, null, 2)}\n`)
}

/**
 * Where one patch's saved preimage blobs live.
 *
 * The directory is an ordinary git object directory — `pack/` holds the pack
 * `savePreimageBlobs` wrote — so a scratch repository can borrow it read-only through
 * `objects/info/alternates`.
 *
 * @param {string} patchDir - the directory the patch is stored in.
 * @param {string} patchId - the patch id.
 * @returns {string} the blobs directory for that patch.
 */
function blobsDirectory(patchDir, patchId) {
  return join(patchDir, `${patchId}.blobs`)
}

/**
 * Remove one stored patch: its file, its record, and its saved blobs.
 *
 * The three are one unit. A blobs directory left behind after its patch is gone is dead
 * weight nothing will ever read again, because its name is only ever derived from a patch
 * id that no longer has a record.
 *
 * @param {string} patchDir - the directory the patch is stored in.
 * @param {string} patchId - the patch id.
 * @param {object} [options] - injected effects, so the migration can observe failures.
 * @param {object} [options.fs] - an `fs`-like override supplying `rmSync`.
 * @returns {void}
 */
function removeStoredPatch(patchDir, patchId, { fs = {} } = {}) {
  const remove = fs.rmSync ?? rmSync
  remove(join(patchDir, `${patchId}.patch`), { force: true })
  remove(join(patchDir, `${patchId}.json`), { force: true })
  remove(blobsDirectory(patchDir, patchId), { recursive: true, force: true })
}

/**
 * Remove one artefact of a stored patch, so a failed move can clear exactly the fragment
 * it left without touching the artefacts it already moved and must roll back.
 *
 * @param {string} patchDir - the directory the patch is stored in.
 * @param {string} patchId - the patch id.
 * @param {string} suffix - `.patch`, `.json`, or `.blobs`.
 * @param {object} [fs] - an `fs`-like override supplying `rmSync`.
 * @returns {void}
 */
function removeStoredPatchArtifact(patchDir, patchId, suffix, fs = {}) {
  const remove = fs.rmSync ?? rmSync
  remove(join(patchDir, `${patchId}${suffix}`), { recursive: suffix === '.blobs', force: true })
}

/**
 * Whether a directory holds a complete stored patch for one id.
 *
 * A patch is three artefacts written in a fixed order: `.patch`, then the optional
 * `.blobs`, then the `.json` record that is the commit point. A `.patch` with no record,
 * or with a record that cannot be parsed or names another id, is a fragment left by an
 * interrupted write or an interrupted migration — not a patch anybody can list or apply.
 * Both stores use this test: a legacy snapshot is only old enough to move when it has the
 * record, and the durable store only shadows a legacy patch when it has one too.
 *
 * @param {string} patchDir - the directory to inspect.
 * @param {string} patchId - the patch id.
 * @returns {boolean} true when the patch and a matching parseable record are both there.
 */
function storedPatchComplete(patchDir, patchId) {
  if (!existsSync(join(patchDir, `${patchId}.patch`))) return false
  try {
    return JSON.parse(readFileSync(join(patchDir, `${patchId}.json`), 'utf8'))?.patchId === patchId
  } catch {
    return false
  }
}

/**
 * Copy one file, symlink or directory tree to a path that does not exist yet.
 *
 * Only the migration fallback uses this, for the case where the temp and durable
 * directories are on different filesystems and `renameSync` cannot cross. The tree is a
 * stored patch's three artefacts, so there is nothing exotic to preserve beyond a
 * symlink, which is recreated rather than followed.
 *
 * @param {string} from - source path.
 * @param {string} to - destination path.
 * @param {object} [fs] - an `fs`-like override, so tests can observe the copy.
 * @returns {void}
 */
function copyPath(from, to, fs = {}) {
  const readdir = fs.readdirSync ?? readdirSync
  const write = fs.copyFileSync ?? copyFileSync
  const readlink = fs.readlinkSync ?? readlinkSync
  const link = fs.symlinkSync ?? symlinkSync
  const mkdir = fs.mkdirSync ?? mkdirSync
  const lstat = fs.lstatSync ?? lstatSync
  const info = lstat(from)
  if (info.isSymbolicLink()) {
    link(readlink(from), to)
    return
  }
  if (info.isDirectory()) {
    mkdir(to, { recursive: true })
    for (const entry of readdir(from)) copyPath(join(from, entry), join(to, entry), fs)
    return
  }
  mkdir(dirname(to), { recursive: true })
  write(from, to)
}

/**
 * Move one stored artefact, falling back to a copy when the rename crosses filesystems.
 *
 * `renameSync` is atomic and free on one filesystem, but a temp directory and the
 * durable data directory often are not the same filesystem; `EXDEV` is the kernel's
 * answer to that, and copy-then-remove is the only correct alternative.
 *
 * @param {string} from - source path.
 * @param {string} to - destination path.
 * @param {object} [fs] - an `fs`-like override, so tests can force `EXDEV`.
 * @returns {void}
 */
function moveStoredPath(from, to, fs = {}) {
  const rename = fs.renameSync ?? renameSync
  const remove = fs.rmSync ?? rmSync
  try {
    rename(from, to)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    copyPath(from, to, fs)
    remove(from, { recursive: true, force: true })
  }
}

/**
 * Move a legacy temp-directory patch store into the durable one.
 *
 * Before patches moved to `durableBaseDir`, an unapplied patch lived under
 * `$TMPDIR/flash-mcp/<digest>/patches`. A pool that owns its default state calls this at
 * construction, so an upgrade does not strand the work a caller was told it could still
 * apply.
 *
 * Only an id whose WHOLE snapshot is there is moved: the `.patch` and a `.json` record
 * that parses and names the same id. An old server writes `.patch`, then `.blobs`, then
 * `.json`, so an id without its record may still be in flight; moving it would split the
 * patch across the two stores and leave a durable `.patch` that no record ever lists.
 * All three artefacts of a complete id travel together. An id already complete in the new
 * store is left alone rather than overwritten; an incomplete durable fragment beside a
 * complete legacy patch is removed first, and a move that fails part-way removes its own
 * destination fragment before rolling back, so a retry is always possible. A patch that
 * cannot be moved is logged and stays where it was, for `clean` to prune later.
 *
 * @param {string} legacyDir - the old `<tempBase>/<digest>/patches` directory.
 * @param {string} patchDir - the durable patch directory.
 * @param {object} [options] - logging and injected effects.
 * @param {(message: string) => void} [options.log] - progress log.
 * @param {object} [options.fs] - an `fs`-like override, so tests can force `EXDEV`.
 * @returns {number} how many patches were moved.
 */
export function migrateLegacyPatches(legacyDir, patchDir, { log = () => {}, fs = {} } = {}) {
  if (resolve(legacyDir) === resolve(patchDir)) return 0
  let names
  try {
    names = readdirSync(legacyDir)
  } catch {
    return 0
  }
  const ids = new Set()
  for (const name of names) {
    const dot = name.lastIndexOf('.')
    const suffix = dot < 0 ? '' : name.slice(dot)
    if (suffix !== '.patch' && suffix !== '.json' && suffix !== '.blobs') continue
    const patchId = name.slice(0, dot)
    if (PATCH_ID.test(patchId)) ids.add(patchId)
  }
  let moved = 0
  for (const patchId of ids) {
    // An old server writes `.patch`, then `.blobs`, then `.json`. Moving an id whose
    // record has not landed yet would split it across the two stores: the old server
    // would still write its `.json` into a recreated legacy directory, and the durable
    // store would keep a patch with no record that no later migration lists or applies.
    // An incomplete id is left entirely alone, because it may still be being written.
    if (!storedPatchComplete(legacyDir, patchId)) continue
    // A DURABLE fragment beside a COMPLETE legacy patch is the other half of that race,
    // left by an earlier migration attempt. It must not make the id look present: remove
    // it, then move the complete legacy copy over it.
    if (storedPatchComplete(patchDir, patchId)) continue
    mkdirSync(patchDir, { recursive: true })
    try {
      removeStoredPatch(patchDir, patchId, { fs })
    } catch (error) {
      // A fragment that cannot be removed leaves this id for a later run rather than
      // failing the migration of every other patch.
      log(`could not clear the incomplete stored patch ${patchId} in ${patchDir}: ${messageOf(error)}`)
      continue
    }
    const suffixes = ['.patch', '.json', '.blobs']
    const movedSuffixes = []
    try {
      for (const suffix of suffixes) {
        const from = join(legacyDir, `${patchId}${suffix}`)
        if (!existsSync(from)) continue
        moveStoredPath(from, join(patchDir, `${patchId}${suffix}`), fs)
        movedSuffixes.push(suffix)
      }
      moved += 1
    } catch (error) {
      // A copy across filesystems that fails part-way (ENOSPC, EACCES) leaves a partial
      // destination file the old rollback never removed. Drop every destination artefact
      // this attempt did not complete — including that partial one — before putting the
      // moved ones back, so no fragment can make a later run skip the id forever.
      for (const suffix of suffixes) {
        if (movedSuffixes.includes(suffix)) continue
        try {
          removeStoredPatchArtifact(patchDir, patchId, suffix, fs)
        } catch {
          // Best effort: a fragment that will not go away is retried by the next run.
        }
      }
      // Put a half-moved patch back as one unit: the legacy store is where `clean` still
      // knows to look, and half an id in each store is worse than one left behind.
      for (const suffix of [...movedSuffixes].reverse()) {
        try {
          moveStoredPath(join(patchDir, `${patchId}${suffix}`), join(legacyDir, `${patchId}${suffix}`), fs)
        } catch {
          // Best effort: the log line below names the patch that needs a human.
        }
      }
      log(`could not move stored patch ${patchId} from ${legacyDir}: ${messageOf(error)}`)
    }
  }
  try {
    if (readdirSync(legacyDir).length === 0) rmSync(legacyDir, { recursive: true, force: true })
  } catch {
    // A directory that vanished or cannot be read is not a failed migration.
  }
  if (moved > 0) {
    log(
      `moved ${moved} stored patch(es) from ${legacyDir} to ${patchDir}, ` +
        'where a reboot or the temp cleaner cannot remove them',
    )
  }
  return moved
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
 * The stat facts this service keeps about the git-ignored FILES a copy started with.
 *
 * A change to a path that already existed is invisible to a plain list comparison, and
 * git cannot carry it in a patch either: a worker that regenerated an ignored
 * `worker-configuration.d.ts` produced a patch the caller's type check then failed on.
 * The size and modification time are enough to notice a rewrite or a deletion without
 * reading the file, and they cost no walk of the ignored directories.
 *
 * Entries that are not regular files — directories such as `node_modules/` and
 * `target/`, and symlinks, which `lstat` does not follow — are skipped: walking them
 * would stat a whole dependency tree on every call.
 *
 * The limit that follows from this: a change DEEP INSIDE an ignored directory is not
 * tracked. `git status --ignored=matching` names `node_modules/` as one entry, so a file
 * rewritten under it is neither in `ignored` (the path is not new) nor in
 * `ignoredChanged`, and the patch will not carry it. Such paths are usually rebuilt by
 * the caller's own install or generate step; a file a worker changes there on purpose
 * must be copied outside the ignored directory or the caller must be told separately.
 *
 * @param {string} dir - the repository the ignored paths were listed in.
 * @param {string[]} paths - repository-relative ignored paths, as `ignoredPaths` returns them.
 * @returns {Record<string, {size: number, mtimeMs: number}>} facts keyed by path.
 */
function ignoredFileStats(dir, paths) {
  const files = {}
  for (const path of paths) {
    try {
      const info = lstatSync(join(dir, path))
      // A directory is reported by git as one ignored entry and is not walked; a symlink
      // is not a file whose content a patch could carry.
      if (!info.isFile()) continue
      files[path] = { size: info.size, mtimeMs: info.mtimeMs }
    } catch {
      // A path that vanished between the listing and the stat is not a file this copy
      // started with.
    }
  }
  return files
}

/**
 * Which of the recorded git-ignored files the worker changed, sorted by path.
 *
 * A recorded file that is now missing was deleted; one whose size or modification time
 * differs was rewritten. Paths the worker created are not considered here — they are
 * new to the copy and are reported by `collect` as `ignored`. The documented limit of
 * `ignoredFileStats` applies: files inside an ignored directory were never recorded.
 *
 * @param {string} dir - the repository to look in now.
 * @param {Record<string, {size: number, mtimeMs: number}> | undefined} recorded - the facts
 *   taken when the copy was made (or when its base patch was applied).
 * @returns {{path: string, change: 'modified' | 'deleted'}[]} the changes, sorted by path.
 */
function ignoredChangedFiles(dir, recorded) {
  const changed = []
  for (const [path, before] of Object.entries(recorded ?? {})) {
    let now
    try {
      now = lstatSync(join(dir, path))
    } catch {
      changed.push({ path, change: 'deleted' })
      continue
    }
    if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) changed.push({ path, change: 'modified' })
  }
  return changed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
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
 * The clone is attempted first: on a filesystem with reflink support (Btrfs, XFS) a
 * cloned file shares every block with the source until one side writes, so a large
 * repository copies instantly and costs nothing. The first file that cannot be cloned
 * switches the rest of the tree to a plain copy, which is correct and slower. On macOS
 * Node answers the forced clone with ENOSYS even on APFS, so there it is always a copy.
 *
 * This is Node's own copy rather than `cp`, which Windows does not have. It is not
 * `fs.cpSync` either: that rewrites a relative symlink into an absolute one pointing
 * back into the source, so a worker writing through it would reach the caller's tree,
 * and it throws on a socket or a FIFO left in a working tree.
 *
 * Symlinks are recreated one at a time. A relative link keeps its text, because the whole
 * tree moved together and the text still resolves inside the copy. An absolute link that
 * names a path inside the source is re-pointed at the same path inside the copy: left
 * verbatim, it would still name the caller's live tree, so a worker reading through it
 * would read the caller's files and writing through it would reach the caller's tree. An
 * absolute link that names something outside the source is kept verbatim, since the copy
 * holds nothing that could take its place.
 *
 * On Windows a symlink needs Developer Mode or the symlink privilege, so a directory link
 * whose plain creation is refused (EPERM/EACCES) becomes a junction instead, which needs
 * neither; the junction is given an absolute path inside the copy. Any other refused link —
 * a file link, or a directory outside the copy, where a junction would hand the worker a
 * write path out of its copy — is left out of the copy and reported rather than failing the
 * whole call. A junction reads back as `\\?\C:\...`, and that prefix is stripped before the
 * text is treated as a path. Anything that is not a file, a directory, or a symlink is
 * skipped.
 *
 * A nested directory whose `.git` is a file pointing outside the source — a linked
 * worktree such as `.claude/worktrees/agent-x`, whose pointer is absolute — is left
 * out. In the copy that pointer would still name the caller's repository, so a worker's
 * `git commit` there would land on the caller's branch, and once the caller removed the
 * worktree, `git add -A` in the copy failed on the dangling pointer and lost the call's
 * whole change. A submodule's pointer is relative and resolves inside the source, so it
 * travels with the copy and the submodule stays.
 *
 * An entry that disappears between `readdir` and the copy is skipped rather than fatal. A
 * build running in the caller's tree rewrites its output directory while the copy walks
 * it, and a raw `ENOENT: scandir '.../target/debug/deps/rmetaZy0Wnf'` was the whole call
 * failing over a file that had already been deleted by its own build. Only the top
 * directory missing is an error: that is a caller mistake, not a race.
 *
 * @param {string} from - source directory.
 * @param {string} to - existing destination directory.
 * @param {object} [options] - copy settings.
 * @param {object} [options.fs] - an `fs`-like override (readdirSync, copyFileSync, readlinkSync,
 *   symlinkSync, mkdirSync, statSync, realpathSync). Used by tests to make an entry vanish
 *   deterministically, and to observe the link calls.
 * @param {string} [options.platform] - `process.platform`; tests pass `'win32'` to exercise
 *   the junction fallback.
 * @param {string[]} [options.exclude] - normalized exclude entries (see `normalizeExclude`).
 * @param {(relPath: string) => {omit: boolean, reason?: string}} [options.consider] - asked once
 *   per matched path whether it may be left out; the git-safety decision lives with the caller.
 * @returns {{mechanism: 'clone' | 'copy', skipped: string[], vanished: number,
 *   excluded: string[], kept: {path: string, reason?: string}[], linksRepointed: number,
 *   repointed: string[], linksSkipped: {path: string, target: string, reason: string}[]}} which mechanism was used,
 *   the directories left out, how many entries vanished mid-walk, which entries were excluded,
 *   how many absolute links were re-pointed into the copy, and which links could not be
 *   recreated for the copy.
 */
export function copyTree(from, to, { fs = {}, exclude = [], consider, platform = process.platform } = {}) {
  // FICLONE_FORCE refuses rather than silently copying when the filesystem cannot
  // clone, which is what makes the returned mechanism honest.
  const readdir = fs.readdirSync ?? readdirSync
  const write = fs.copyFileSync ?? copyFileSync
  const readlink = fs.readlinkSync ?? readlinkSync
  const link = fs.symlinkSync ?? symlinkSync
  const mkdir = fs.mkdirSync ?? mkdirSync
  const stat = fs.statSync ?? statSync
  // The native realpath: Node's JavaScript one keeps whatever case it was given, so on a
  // case-insensitive volume two spellings of one directory would still compare unequal.
  const realpath = fs.realpathSync ?? realpathSync.native
  let mechanism = 'clone'
  const skipped = []
  const excluded = []
  const kept = []
  const linksSkipped = []
  const repointed = []
  let vanished = 0
  const copyFile = (source, target) => {
    if (mechanism === 'clone') {
      try {
        write(source, target, constants.COPYFILE_FICLONE_FORCE)
        return
      } catch (error) {
        // A vanished source must not be mistaken for a filesystem that cannot clone:
        // retrying it without reflink would only throw ENOENT again, at the wrong layer.
        if (isGone(error)) throw error
        mechanism = 'copy'
      }
    }
    write(source, target)
  }
  // macOS reaches a temp directory through /var, a symlink to /private/var, so the same tree
  // has two spellings and an absolute link may carry either. Both are computed once here.
  let realFrom = from
  try {
    realFrom = realpath(from)
  } catch {
    // A missing source is the walk's error to report, naming the path the caller passed.
  }
  /** Whether a resolved link target names a directory, where a junction is possible at all. */
  const isDirectoryTarget = (target) => {
    try {
      return stat(target).isDirectory()
    } catch {
      // A dangling link is not a directory: it is skipped rather than becoming a junction
      // to nothing.
      return false
    }
  }
  /**
   * Recreate one symlink in the copy, re-pointing an absolute in-tree target and falling
   * back to a junction for a Windows directory link.
   */
  const copyLink = (sourcePath, targetPath, relPath) => {
    const raw = readlink(sourcePath)
    // A Windows junction reads back as `\\?\C:\...`; the prefix spells the same path and is
    // not part of it.
    const text = platform === 'win32' && raw.startsWith('\\\\?\\') ? raw.slice(4) : raw
    // A relative link is resolved against the link's own directory. The copy's own link
    // resolves against its directory, which mirrors it, so the text can stay as it is.
    const sourceTarget = isAbsolute(text) ? text : resolve(dirname(sourcePath), text)
    // "Inside the tree" is decided on the target's real path, not on its text. A
    // case-insensitive volume spells the same directory with any case, and a symlinked
    // ancestor spells it through another name; both would have failed a string comparison
    // and been copied verbatim, so a write through the copy's link reached the caller's
    // tree. A dangling target has no real path; it keeps the string comparison.
    let realTarget
    try {
      realTarget = realpath(sourceTarget)
    } catch {
      realTarget = undefined
    }
    const withinTree =
      realTarget === undefined ? isWithin(from, sourceTarget) || isWithin(realFrom, sourceTarget) : isWithin(realFrom, realTarget)
    // An absolute link into the caller's tree would still name that tree from inside the
    // copy; the equivalent path inside the copy is what it must point at.
    const isRepointed = isAbsolute(text) && withinTree
    // The in-tree path is taken from the real paths too, so a case variant or an alias
    // spelling lands at the same place inside the copy.
    const inTreeRel =
      realTarget === undefined
        ? isWithin(from, sourceTarget)
          ? relative(from, sourceTarget)
          : relative(realFrom, sourceTarget)
        : relative(realFrom, realTarget)
    const newTarget = isRepointed ? join(to, inTreeRel) : text
    try {
      link(newTarget, targetPath)
    } catch (error) {
      const refused = error?.code === 'EPERM' || error?.code === 'EACCES'
      if (platform !== 'win32' || !refused) throw error
      // Windows refuses a symlink without Developer Mode or the symlink privilege; a
      // junction needs neither. Only a directory target inside the copy may become one: a
      // junction anywhere else would hand the worker a write path out of its copy.
      const directory = isDirectoryTarget(sourceTarget)
      if (!directory || !withinTree) {
        linksSkipped.push({
          path: relPath,
          target: sourceTarget,
          reason: directory ? 'it names a path outside the copy' : 'a file link needs Developer Mode or the symlink privilege',
        })
        return
      }
      // Node resolves a junction's relative target against the process cwd, not the link's
      // directory, so the target handed to the junction is always absolute. The guard above
      // asked about the source-side target; the junction is created at a different place,
      // so its own absolute target is checked here as well. A relative link such as
      // `../repo/pkg` can leave the copy's state directory and re-enter it by name: the
      // junction would then be a write path outside the copy.
      const copyTarget = isRepointed ? resolve(newTarget) : resolve(dirname(targetPath), text)
      if (!isWithin(resolve(to), copyTarget)) {
        linksSkipped.push({
          path: relPath,
          target: copyTarget,
          reason: 'its target is outside the copy',
        })
        return
      }
      link(copyTarget, targetPath, 'junction')
    }
    if (isRepointed) repointed.push(relPath.split(sep).join('/'))
  }
  const walk = (source, target, top) => {
    let entries
    try {
      entries = readdir(source, { withFileTypes: true })
    } catch (error) {
      // The top directory missing is a caller mistake, not a build racing the copy.
      if (top || !isGone(error)) throw error
      vanished += 1
      return
    }
    for (const entry of entries) {
      const sourcePath = join(source, entry.name)
      const targetPath = join(target, entry.name)
      const relPath = relative(from, sourcePath)
      // Exclude entries are written with `/`; on Windows `relative` answers with `\`.
      if (matchesExclude(relPath.split(sep).join('/'), entry.name, exclude)) {
        const decision = consider === undefined ? { omit: true } : consider(relPath)
        if (decision.omit) {
          excluded.push(relPath)
          continue
        }
        kept.push({ path: relPath, reason: decision.reason })
      }
      try {
        if (entry.isDirectory()) {
          if (!gitLinkTravels(sourcePath, from)) {
            skipped.push(relPath)
            continue
          }
          mkdir(targetPath, { recursive: true })
          walk(sourcePath, targetPath, false)
        } else if (entry.isFile()) {
          copyFile(sourcePath, targetPath)
        } else if (entry.isSymbolicLink()) {
          copyLink(sourcePath, targetPath, relPath)
        }
      } catch (error) {
        if (!isGone(error)) throw error
        vanished += 1
      }
    }
  }
  walk(from, to, true)
  return { mechanism, skipped, vanished, excluded, kept, linksRepointed: repointed.length, repointed, linksSkipped }
}

/**
 * Whether one path is a base directory itself or lies inside it.
 *
 * `path.relative` is used instead of a string prefix so `/tmp/a` does not contain `/tmp/ab`,
 * and so a base reached through a symlinked prefix compares correctly.
 * @param {string} base - the directory.
 * @param {string} candidate - the path to test.
 * @returns {boolean} true when `candidate` is `base` or a path under it.
 */
function isWithin(base, candidate) {
  const rel = relative(base, candidate)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/** Whether a throwable is the "the entry is gone" class the copy tolerates. @param {unknown} error */
function isGone(error) {
  return error?.code === 'ENOENT'
}

/**
 * Normalize exclude entries once, so matching during the walk stays a string comparison.
 *
 * A leading `./` or `/` is stripped, so `target`, `target/`, `/target` and `./target` are
 * one entry; the trailing slash is the directory spelling and is dropped as well. An entry
 * that is empty after that, or not a string, is ignored.
 *
 * @param {unknown} entries - the raw entries from the settings file, options, or environment.
 * @returns {string[]} the normalized entries, in order, without duplicates.
 */
function normalizeExclude(entries) {
  const seen = new Set()
  const out = []
  if (!Array.isArray(entries)) return out
  for (const raw of entries) {
    if (typeof raw !== 'string') continue
    const entry = raw.trim().replace(/^(?:\.?\/)+/, '').replace(/\/+$/, '')
    if (entry.length === 0 || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out
}

/**
 * Whether one entry of a copied tree is named by an exclude entry.
 *
 * A bare name matches a file or directory of that exact name at any depth (`target`,
 * `node_modules`), and a bare name ending in `*` matches every name that starts with the
 * rest (`.env.*`); a name containing `/` matches one path relative to the copied top. The
 * check runs once per directory entry and compares strings — never a git call per file —
 * because the whole point is that a copy stays cheap.
 *
 * @param {string} relPath - the entry's path relative to the copied top.
 * @param {string} name - the entry's own name.
 * @param {string[]} exclude - the normalized entries.
 * @returns {boolean} true when the entry is named by one of them.
 */
function matchesExclude(relPath, name, exclude) {
  for (const entry of exclude) {
    if (entry.includes('/')) {
      if (entry === relPath) return true
    } else if (entry.endsWith('*')) {
      if (name.startsWith(entry.slice(0, -1))) return true
    } else if (entry === name) {
      return true
    }
  }
  return false
}

/**
 * Read the per-repository settings file, one bad key at a time.
 *
 * A settings file is convenience configuration, not a contract: an unknown key, a value of
 * the wrong type or a file that is not JSON at all is named in one log line and ignored, so
 * a typo cannot keep the service from starting. A file that does not exist is simply the
 * common case.
 *
 * @param {string} root - the service root.
 * @param {(message: string) => void} log - where to name a problem.
 * @returns {{copyExclude?: string[], copyExcludeDefaults?: boolean, slotEnv?: object,
 *   slotSetup?: object[]}} the settings that did pass.
 */
function readRepoSettings(root, log) {
  const path = join(root, SETTINGS_FILE)
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') log(`ignoring ${path}: ${messageOf(error)}`)
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    log(`ignoring ${path}: it is not valid JSON (${messageOf(error)})`)
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log(`ignoring ${path}: the settings must be a JSON object`)
    return {}
  }
  const settings = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'copyExclude') {
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
        log(`${path}: copyExclude must be an array of strings; ignoring it`)
        continue
      }
      settings.copyExclude = value
    } else if (key === 'copyExcludeDefaults') {
      if (typeof value !== 'boolean') {
        log(`${path}: copyExcludeDefaults must be true or false; ignoring it`)
        continue
      }
      settings.copyExcludeDefaults = value
    } else if (key === 'slotEnv') {
      if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.values(value).every((entry) => typeof entry === 'string')) {
        log(`${path}: slotEnv must be an object of string values; ignoring it`)
        continue
      }
      settings.slotEnv = value
    } else if (key === 'slotSetup') {
      if (!Array.isArray(value)) {
        log(`${path}: slotSetup must be an array of setup steps; ignoring it`)
        continue
      }
      const steps = []
      for (const [index, entry] of value.entries()) {
        const step = readSetupStep(entry, `${path}: slotSetup[${String(index)}]`, log)
        if (step !== undefined) steps.push(step)
      }
      // A setting whose every entry was refused is not a setting at all: keeping an empty
      // array would make the server announce a setup that can never run.
      if (steps.length > 0) settings.slotSetup = steps
    } else {
      log(`${path}: ${key} is not a known setting; ignoring it`)
    }
  }
  return settings
}

/**
 * Read one `slotSetup` entry, or drop it with the reason.
 *
 * A setup step is host code run with the user's privileges, so its shape is checked
 * strictly: the argv must be a non-empty array of non-empty strings (there is no shell to
 * split a command line), every input and kept path must be a plain relative path inside the
 * repository, and the timeout is a positive number of seconds capped at the maximum. One
 * bad entry is named and dropped; the other entries still apply.
 *
 * @param {unknown} entry - the raw step.
 * @param {string} label - where the step came from, for the log line.
 * @param {(message: string) => void} log - where to name a problem.
 * @returns {{run: string[], inputs: string[], keep: string[], timeoutSeconds: number} | undefined}
 *   the step, or undefined when it cannot be used.
 */
function readSetupStep(entry, label, log) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    log(`${label} must be an object; ignoring it`)
    return undefined
  }
  for (const key of Object.keys(entry)) {
    if (key !== 'run' && key !== 'inputs' && key !== 'keep' && key !== 'timeoutSeconds') {
      log(`${label}.${key} is not a known setting; ignoring it`)
    }
  }
  if (!Array.isArray(entry.run) || entry.run.length === 0 || !entry.run.every((part) => typeof part === 'string' && part.length > 0)) {
    log(`${label}.run must be a non-empty array of strings (an argv, not a shell command); ignoring the entry`)
    return undefined
  }
  const paths = (value, field, fallback) => {
    if (value === undefined) return fallback
    if (!Array.isArray(value)) {
      log(`${label}.${field} must be an array of paths relative to the repository; ignoring the entry`)
      return undefined
    }
    const out = []
    for (const raw of value) {
      const path = typeof raw === 'string' ? normalizeRepoPath(raw) : undefined
      if (path === undefined) {
        log(`${label}.${field} names ${JSON.stringify(raw)}, which is not a relative path inside the repository; ignoring the entry`)
        return undefined
      }
      out.push(path)
    }
    return out
  }
  const inputs = paths(entry.inputs, 'inputs', [])
  if (inputs === undefined) return undefined
  const keep = paths(entry.keep, 'keep', [])
  if (keep === undefined) return undefined
  let timeoutSeconds = SETUP_DEFAULT_TIMEOUT_SECONDS
  if (entry.timeoutSeconds !== undefined) {
    if (typeof entry.timeoutSeconds !== 'number' || !Number.isFinite(entry.timeoutSeconds) || entry.timeoutSeconds <= 0) {
      log(`${label}.timeoutSeconds must be a positive number of seconds; ignoring the entry`)
      return undefined
    }
    timeoutSeconds = Math.min(entry.timeoutSeconds, SETUP_MAX_TIMEOUT_SECONDS)
    if (entry.timeoutSeconds > SETUP_MAX_TIMEOUT_SECONDS) {
      log(`${label}.timeoutSeconds ${String(entry.timeoutSeconds)} is above the ${String(SETUP_MAX_TIMEOUT_SECONDS)} s maximum; using ${String(SETUP_MAX_TIMEOUT_SECONDS)}`)
    }
  }
  return { run: [...entry.run], inputs, keep, timeoutSeconds }
}

/**
 * Normalize one repository-relative path from a setup step, or refuse it.
 *
 * The same spelling rules as an exclude entry are used — a leading `./` or `/` and a
 * trailing `/` are not part of the path — and the result must stay inside the repository.
 *
 * @param {string} raw - the raw path.
 * @returns {string | undefined} the normalized path, or undefined when it is not usable.
 */
function normalizeRepoPath(raw) {
  const text = raw.trim()
  // Unlike an exclude entry, a setup path is never absolute: `/etc/passwd` is not a
  // convenient spelling of `etc/passwd` when the program will run on the host.
  if (text.length === 0 || isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\')) return undefined
  const path = text.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
  return scopeIsSafe(path) ? path : undefined
}

/**
 * Merge the per-slot environment from the file and the pool options, validating each entry.
 *
 * Options are applied last, so a pool option wins per variable. A name that may not be
 * redirected (see FORBIDDEN_SLOT_ENV), a value that is not `home:<name>`, `cache:<name>` or
 * `port:<base>[/<stride>]`, a `<name>` that is not one path segment, or a port range whose
 * highest slot would not fit below 65536 is named and dropped; the entry never makes it into
 * the environment the worker boots with.
 *
 * @param {object} fromFile - the `slotEnv` object from the settings file, if any.
 * @param {unknown} fromOptions - the `slotEnv` pool option, if any.
 * @param {(message: string) => void} log - where to name a rejected entry.
 * @param {number} slotCount - how many slots the pool has, for the highest-port check.
 * @returns {Record<string, {kind: 'home' | 'cache', segment: string} |
 *   {kind: 'port', base: number, stride: number}>} the accepted entries.
 */
function mergeSlotEnv(fromFile, fromOptions, log, slotCount) {
  const merged = {}
  const apply = (source, label) => {
    if (source === undefined || source === null) return
    if (typeof source !== 'object' || Array.isArray(source)) {
      log(`ignoring ${label}: slotEnv must be an object of "home:<name>", "cache:<name>" or "port:<base>[/<stride>]" values`)
      return
    }
    for (const [name, value] of Object.entries(source)) {
      // Windows environment names are case-insensitive, and a worker on that platform sees
      // `Home` and `HOME` as the same variable; the check has to fold case the same way.
      if (FORBIDDEN_SLOT_ENV.has(name.toUpperCase())) {
        log(`not redirecting ${name} for the worker: the runtime's sandbox and toolchains depend on it`)
        continue
      }
      const match = typeof value === 'string' ? SLOT_ENV_VALUE.exec(value) : null
      if (match !== null) {
        if (!isPathSegment(match[2])) {
          log(`ignoring ${label}.${name}: expected "home:<name>" or "cache:<name>" with one path segment, got ${JSON.stringify(value)}`)
          continue
        }
        merged[name] = { kind: match[1], segment: match[2] }
        continue
      }
      const port = typeof value === 'string' ? PORT_ENV_VALUE.exec(value) : null
      if (port === null) {
        log(`ignoring ${label}.${name}: expected "home:<name>", "cache:<name>" or "port:<base>[/<stride>]", got ${JSON.stringify(value)}`)
        continue
      }
      const base = Number(port[1])
      const stride = port[2] === undefined ? PORT_STRIDE_DEFAULT : Number(port[2])
      if (!Number.isInteger(base) || base < PORT_BASE_MIN || base > PORT_BASE_MAX) {
        log(`ignoring ${label}.${name}: the port base must be a whole number in ${String(PORT_BASE_MIN)}..${String(PORT_BASE_MAX)}, got ${String(base)}`)
        continue
      }
      if (!Number.isInteger(stride) || stride < PORT_STRIDE_MIN || stride > PORT_STRIDE_MAX) {
        log(`ignoring ${label}.${name}: the port stride must be a whole number in ${String(PORT_STRIDE_MIN)}..${String(PORT_STRIDE_MAX)}, got ${String(stride)}`)
        continue
      }
      const highest = base + (slotCount - 1) * stride
      if (highest > PORT_BASE_MAX) {
        log(
          `ignoring ${label}.${name}: port:${String(base)}/${String(stride)} reaches ${String(highest)} at slot ${String(slotCount - 1)}, ` +
            `past ${String(PORT_BASE_MAX)}`,
        )
        continue
      }
      merged[name] = { kind: 'port', base, stride }
    }
  }
  apply(fromFile, SETTINGS_FILE)
  apply(fromOptions, 'slotEnv')
  return merged
}

/**
 * Whether a value is one path segment a `slotEnv` entry may name.
 * @param {string} value - the candidate segment.
 * @returns {boolean} true when it is not empty, not a dot entry, and has no separator.
 */
function isPathSegment(value) {
  return value !== '' && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\') && !value.includes('\0')
}

/**
 * Whether git ignores one path inside a work tree, for the purpose of leaving it out of a copy.
 *
 * `check-ignore` exits non-zero both for a path it does not ignore and for any error, so
 * only exit code 0 means "ignored". The safe direction for an exclusion is to copy: a
 * tracked file left out would read to the worker as its own deletion.
 *
 * @param {string} dir - a git work tree.
 * @param {string} relPath - a path relative to its top.
 * @returns {boolean} true only when git positively reports the path ignored.
 */
function gitCheckIgnore(dir, relPath) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relPath], { cwd: dir, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Whether any tracked file lives at or below one path.
 * @param {string} dir - a git work tree.
 * @param {string} relPath - a path relative to its top.
 * @returns {boolean} true when `git ls-files` names at least one file, or cannot answer.
 */
function gitTracksUnder(dir, relPath) {
  try {
    return git(['ls-files', '--', relPath], dir).trim() !== ''
  } catch {
    // Dropping tracked source is worse than copying a directory that could have been left
    // out, so an unanswerable git means "treat it as tracked".
    return true
  }
}

/**
 * The repository that actually owns one path, walking up from its parent to the copied top.
 *
 * A workspace root often holds nested repositories. The top repository's index and ignore
 * rules say nothing about a path inside one of them: `git check-ignore` there can match an
 * outer rule and `git ls-files` there reports nothing, so a tracked file of the nested
 * repository would be left out of the copy. Both checks therefore have to run in the
 * innermost repository containing the path.
 *
 * @param {string} top - the repository being copied.
 * @param {string} relPath - the matched path, relative to the copied top.
 * @returns {string} the innermost enclosing repository, or the top itself.
 */
function enclosingRepository(top, relPath) {
  let dir = dirname(join(top, relPath))
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    if (dir === top) return top
    const parent = dirname(dir)
    // Never walk past the copied top: a repository above it is not part of what is copied.
    if (parent === dir || !parent.startsWith(`${top}${sep}`)) return top
    dir = parent
  }
}

/**
 * The paths uncommitted in a work tree, as git reports them.
 *
 * Read with `--untracked-files=all` so a wholly new directory is counted file by file
 * rather than as one opaque entry, and with `-z` so a path containing a newline cannot be
 * split in two. The list is capped; the count is not, because the caller needs to know how
 * much was there even when naming all of it would flood the result.
 *
 * @param {string} dir - a git work tree.
 * @param {Set<string>} [repointed] - re-pointed links the caller's own tree reports clean,
 *   as git-style paths; their copy-only change is not the caller's work in progress.
 * @returns {{count: number, files: string[]}} the true count and the first UNCOMMITTED_FILES paths.
 */
function uncommittedIn(dir, repointed = new Set()) {
  let raw
  try {
    raw = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], dir)
  } catch {
    return { count: 0, files: [] }
  }
  const files = []
  let count = 0
  const entries = raw.split('\0')
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    // `XY path`: a rename/copy is followed by its source path as a bare, status-less entry.
    if (entry.length < 4 || entry[2] !== ' ') continue
    // A link `copyTree` re-pointed into the copy differs from HEAD only because of that, in
    // the work tree alone; it is not the caller's work in progress. Only the paths the
    // caller's own tree reports clean are passed here (see `changedInCaller`).
    if (entry[0] === ' ' && repointed.has(entry.slice(3))) continue
    count += 1
    if (files.length < UNCOMMITTED_FILES) files.push(entry.slice(3))
    if (entry.startsWith('R') || entry.startsWith('C')) index += 1
  }
  return { count, files }
}

/**
 * Which re-pointed links the caller had already changed in its own tree.
 *
 * `copyTree` re-points absolute links so the copy cannot write back into the caller's tree;
 * `git status` in the copy therefore lists such a link as modified although the caller did
 * nothing. Skipping every re-pointed path hid a link the caller had retargeted themselves
 * before the call, which is real uncommitted work and belongs in the report and the prompt.
 * One `git status -- <paths>` over just the re-pointed paths tells the two cases apart.
 *
 * @param {string} dir - the caller's tree that was copied.
 * @param {string[]} paths - git-style paths relative to `dir`.
 * @returns {Set<string>} the paths git lists as changed in the caller's tree.
 */
function changedInCaller(dir, paths) {
  if (paths.length === 0) return new Set()
  let raw
  try {
    raw = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths], dir)
  } catch {
    // A git that cannot answer must not hide the caller's edit: report every re-pointed
    // link rather than none.
    return new Set(paths)
  }
  const changed = new Set()
  for (const entry of raw.split('\0')) {
    if (entry.length < 4 || entry[2] !== ' ') continue
    changed.add(entry.slice(3))
  }
  return changed
}

/**
 * Whether a directory's git link, if it has one, still means the same thing in a copy.
 *
 * A `.git` FILE and a `.git` SYMLINK are both links. The file travels when its `gitdir:`
 * is relative and resolves inside the tree being copied; the symlink travels when its
 * target resolves inside it. An absolute one keeps naming the original location. A real
 * `.git` directory is not a link and copies as it is.
 *
 * The lstat matters: `readFileSync` on a symlink to a directory throws EISDIR, which used
 * to be read as "no link at all" and copied the symlink verbatim. In the copy that symlink
 * still named the caller's git directory, so a worker's `git add` staged into the caller's
 * index and its commits landed on the caller's branch.
 *
 * @param {string} dir - a directory inside the tree being copied.
 * @param {string} top - the top of that tree.
 * @returns {boolean} false when the directory must be left out of the copy.
 */
function gitLinkTravels(dir, top) {
  const link = join(dir, '.git')
  let info
  try {
    info = lstatSync(link)
  } catch {
    // No `.git` at all: an ordinary directory, which copies as it is.
    return true
  }
  if (info.isDirectory()) return true
  if (info.isSymbolicLink()) {
    let target
    try {
      target = readlinkSync(link)
    } catch {
      return false
    }
    return !isAbsolute(target) && resolve(dir, target).startsWith(`${top}${sep}`)
  }
  let text
  try {
    text = readFileSync(link, 'utf8')
  } catch {
    return false
  }
  const target = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1]
  if (target === undefined || isAbsolute(target)) return false
  return resolve(dir, target).startsWith(`${top}${sep}`)
}

/**
 * Give a copied repository its own git state when its `.git` is a link to the caller's.
 *
 * A repository whose `.git` is a file — the root of a Claude Code worktree session, or a
 * linked worktree or submodule a call was scoped to — links to git state outside the
 * copy. A repository whose `.git` is a symlink to a directory does the same, and `statSync`
 * followed that symlink, so a whole-root copy of such a repository returned early and the
 * copy's `.git` WAS the caller's directory. Kept as it was, the copy's index, refs and
 * `refs/flash/base` were the caller's: preparing a call staged the worker's files in the
 * caller's real index, and `source: head` reset the caller's working tree. The link is
 * therefore found with `lstat` and replaced with a fresh repository that borrows the
 * original's objects read-only through `objects/info/alternates` and sits on the same
 * commit and branch, so history reads as before while every write stays inside the copy.
 *
 * @param {string} original - the repository in the caller's tree.
 * @param {string} copy - its copy.
 * @returns {void}
 */
function detachGitLink(original, copy) {
  const link = join(copy, '.git')
  let info
  try {
    info = lstatSync(link)
  } catch {
    return
  }
  // A real `.git` directory is this copy's own state; only a file or a symlink points
  // somewhere else and has to be replaced.
  if (info.isDirectory()) return
  const commonDir = resolve(original, git(['rev-parse', '--git-common-dir'], original).trim())
  const head = gitOrEmpty(['rev-parse', '--verify', '-q', 'HEAD'], original)
  const branch = gitOrEmpty(['symbolic-ref', '-q', 'HEAD'], original)
  // The worktree's own index has to travel with it. An empty index makes `git status`
  // report every tracked file as an unstaged deletion, and it loses the caller's staged
  // edits — the copy would then not mirror the tree it came from. Read here, before the
  // link is replaced.
  const index = resolve(original, gitOrEmpty(['rev-parse', '--git-path', 'index'], original))
  rmSync(link, { force: true })
  git(['init', '-q'], copy)
  writeFileSync(join(copy, '.git', 'objects', 'info', 'alternates'), `${join(commonDir, 'objects')}\n`)
  // The original's private ignore list decides what `git add -A` sees; without it the
  // base would absorb files the caller never tracked.
  const exclude = join(commonDir, 'info', 'exclude')
  if (existsSync(exclude)) writeFileSync(join(copy, '.git', 'info', 'exclude'), readFileSync(exclude))
  let seeded = false
  try {
    copyFileSync(index, join(copy, '.git', 'index'))
    seeded = true
  } catch {
    // No readable index file: fall back to HEAD below, which at least mirrors the commit.
  }
  if (head === '') return
  if (branch === '') {
    git(['update-ref', '--no-deref', 'HEAD', head], copy)
  } else {
    git(['update-ref', branch, head], copy)
    git(['symbolic-ref', 'HEAD', branch], copy)
  }
  if (!seeded) git(['read-tree', 'HEAD'], copy)
}

/**
 * Run one git command whose failure only means "nothing there".
 * @param {string[]} args - arguments after `git`.
 * @param {string} cwd - directory to run in.
 * @returns {string} trimmed standard output, or `''` when the command failed.
 */
function gitOrEmpty(args, cwd) {
  try {
    return git(args, cwd).trim()
  } catch {
    return ''
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
    // `.flash-cache` is the worker's warm cache and is deliberately kept across calls in
    // the same slot; every other entry, `.flash-home` included, is per-call state. The
    // whole slot is still removed by `retire`/`sweepDeadOwners`/`close`.
    if (entry === SLOT_CACHE) continue
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
 * @param {string} [options.dataDir] - the durable data directory; defaults to `durableBaseDir()`.
 * @param {string} options.root - the canonical service root of this invocation.
 * @param {boolean} [options.all] - also remove the trees of roots with no live server.
 * @param {number} [options.retentionDays] - the patch retention window.
 * @param {number} [options.now] - the current time, for tests.
 * @param {(message: string) => void} [options.log] - progress log.
 * @returns {{baseDir: string, own: string, patchDir: string, legacyPatchDir?: string, stats: object[], actions: object}} the report.
 */
export function cleanLayout({ baseDir = stateBaseDir(), dataDir, root, all = false, retentionDays = PATCH_RETENTION_DAYS, now = Date.now(), log = () => {} } = {}) {
  const own = rootDigest(root)
  const ownDir = join(baseDir, own)
  const patchDir = dataDir === undefined ? defaultPatchDir(root) : join(dataDir, own, 'patches')
  const legacyPatchDir = join(ownDir, 'patches')
  // Facts are read before anything is removed, so the report describes what was found.
  // This root's durable store is part of its footprint even though it does not live under
  // the temp base, so it is counted on this root's line alongside any legacy copy.
  const stats = digestDirs(baseDir).map((digest) => ({
    digest,
    own: digest === own,
    livePids: livePidsIn(join(baseDir, digest)),
    ...digestStats(join(baseDir, digest), digest === own ? [patchDir] : []),
  }))
  const actions = { deadOwnersRemoved: 0, patchesPruned: 0, emptyDigestsRemoved: 0, foreignTreesRemoved: 0 }
  if (existsSync(ownDir)) {
    // Salvage goes to the durable store too, exactly as a startup sweep would.
    actions.deadOwnersRemoved = sweepDeadOwners(root, { patchDir, baseDir, log })
  }
  actions.patchesPruned = prunePatches(patchDir, { retentionDays, now })
  if (resolve(legacyPatchDir) !== resolve(patchDir)) {
    // An upgrade can leave patches behind in the temp tree. Do not move them from `clean`
    // (a pool migrates on construction); just age out the ones that are already due.
    actions.patchesPruned += prunePatches(legacyPatchDir, { retentionDays, now })
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
  const report = { baseDir, own, patchDir, stats, actions }
  if (existsSync(legacyPatchDir)) report.legacyPatchDir = legacyPatchDir
  return report
}

/**
 * The `STATUS<TAB>path` records of the staged change, decoded.
 *
 * Read with `-z`, so git neither quotes a path with a non-ASCII byte, quote or backslash
 * nor escapes it: the fields arrive as the real NUL-separated names. The records are then
 * rebuilt in the same `STATUS<TAB>path` shape this service has always stored, which keeps
 * the persisted form and every reader unchanged. The quoted spelling git writes without
 * `-z` used to leak into `filesChanged`: a caller filtering with the plain name could not
 * select the file, and `touchedPaths` staged the quoted string, so the caller's own file at
 * the real path was invisible to the merge and silently overwritten.
 *
 * @param {string} repoDir - the copy the change was computed in.
 * @param {string} base - the base commit the change is diffed against.
 * @returns {string[]} the decoded records, in git's order.
 * @throws {Error} when git cannot produce the list.
 */
function nameStatusRecords(repoDir, base) {
  const raw = git(['diff', '--cached', '--name-status', '-z', base], repoDir)
  const fields = raw.split('\0')
  const lines = []
  let at = 0
  while (at < fields.length) {
    const status = fields[at]
    at += 1
    if (status === '') continue
    const first = fields[at]
    at += 1
    if (first === undefined) break
    // A rename or copy carries its old path first, then its new one, giving the historical
    // `STATUS<TAB>old<TAB>new` line.
    if (status.startsWith('R') || status.startsWith('C')) {
      const second = fields[at]
      at += 1
      lines.push(`${status}\t${first}\t${second ?? ''}`)
    } else {
      lines.push(`${status}\t${first}`)
    }
  }
  return lines
}

/**
 * Decode one path field of a stored `--name-status` record.
 *
 * New records carry the plain name; a record stored before `-z` was used can still carry
 * git's quoted spelling, which `diffPathToken` decodes.
 *
 * @param {string} field - one tab-separated field of a record.
 * @returns {string} the name as it exists on disk.
 */
function nameStatusPath(field) {
  return diffPathToken(String(field))
}

/**
 * The plain repository paths a `--name-status` record names.
 *
 * `git diff --name-status` writes `STATUS<TAB>path`, and a rename or copy adds the old
 * path: `STATUS<TAB>old<TAB>new`. The last field is the name that exists after the
 * change, which is the one a caller recognizes; a deletion has only its one path.
 *
 * @param {string[] | undefined} lines - raw `--name-status` records.
 * @returns {string[]} the plain paths, in the same order.
 */
function plainPaths(lines) {
  return (lines ?? []).map((line) => nameStatusPath(line.split('\t').at(-1) ?? ''))
}

/**
 * Decode one path token of a `diff --git` header.
 *
 * Git quotes a path that holds a quote, a backslash, or a byte outside ASCII, and writes
 * every other unprintable byte as an octal escape (`"\303\251"` for `é`). Decoding the
 * token back to the bytes git wrote and reading them as UTF-8 is what lets a caller's
 * `files` filter name the path it actually sees on disk.
 *
 * @param {string} token - a raw header token, quoted or not.
 * @returns {string} the decoded path.
 */
function diffPathToken(token) {
  if (!token.startsWith('"')) return token
  const bytes = []
  for (let index = 1; index < token.length; index += 1) {
    const char = token[index]
    if (char === '"') break
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'))
      continue
    }
    index += 1
    const escape = token[index]
    if (escape === undefined) break
    const octal = token.slice(index, index + 3)
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8))
      index += 2
      continue
    }
    const control = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 }
    bytes.push(control[escape] ?? Buffer.from(escape, 'utf8')[0])
  }
  return Buffer.from(bytes).toString('utf8')
}

/**
 * Read one quoted path token, skipping the space before it.
 * @param {string} text - the text after `diff --git `.
 * @param {number} start - where to look.
 * @returns {{token: string, next: number} | null} the decoded token and where it ends.
 */
function quotedToken(text, start) {
  let at = start
  while (at < text.length && text[at] === ' ') at += 1
  if (text[at] !== '"') return null
  let end = at + 1
  while (end < text.length && text[end] !== '"') {
    if (text[end] === '\\') end += 1
    end += 1
  }
  return { token: diffPathToken(text.slice(at, end + 1)), next: end + 1 }
}

/**
 * The two path tokens of one `diff --git` header line.
 *
 * Git writes `a/<name> b/<name>` and quotes a name only when it holds a quote, a
 * backslash, or a byte outside ASCII: a name with a space is left unquoted, so splitting
 * on whitespace cuts `space name.txt` into `space` and `name.txt`. The separator is
 * instead the last ` b/` git could have written between the two prefixes, and a quoted
 * side is decoded through `diffPathToken` before the prefixes are stripped.
 *
 * @param {string} header - the header line without its newline.
 * @returns {string[]} the `a/...` then `b/...` token, as far as they are present.
 */
function diffHeaderPaths(header) {
  const rest = header.slice('diff --git '.length)
  // A quoted source: decode it, then the destination is either the next quoted token or the
  // bare text after the separating space, as in `"a/caf\303\251.txt" b/space name.txt`.
  if (rest.startsWith('"')) {
    const first = quotedToken(rest, 0)
    if (first !== null) {
      const second = quotedToken(rest, first.next)
      if (second !== null) return [first.token, second.token]
      const bare = rest.slice(first.next).replace(/^ +/, '')
      if (bare.length > 0) return [first.token, bare]
    }
  }
  // A bare source: the destination starts at the last ` b/` (bare) or ` "b/` (quoted). The
  // quoted form can follow a bare `b/` inside the source name, so the later one wins.
  if (rest.startsWith('a/')) {
    const bareAt = rest.lastIndexOf(' b/')
    const quotedAt = rest.lastIndexOf(' "b/')
    if (bareAt > 0 || quotedAt > 0) {
      const separator = Math.max(bareAt, quotedAt)
      return [rest.slice(0, separator), quotedAt >= bareAt ? diffPathToken(rest.slice(separator + 1)) : rest.slice(separator + 1)]
    }
  }
  return rest.split(' ').slice(0, 2)
}

/**
 * The repository-relative name of one side of a `diff --git` header, or null for `/dev/null`.
 * @param {string | undefined} token - an `a/...` or `b/...` token.
 * @returns {string | null} the plain path.
 */
function patchPathOf(token) {
  if (token === undefined) return null
  const plain = diffPathToken(token)
  if (plain === '/dev/null') return null
  return plain.startsWith('a/') || plain.startsWith('b/') ? plain.slice(2) : plain
}

/**
 * The plain path one diff section changes: the new path, or the old one for a deletion.
 *
 * A rename's header names both paths, and the name that exists afterwards is the one the
 * caller sees in `filesChanged`; a deletion has no new path, so the old name is the only
 * one that still means anything.
 *
 * @param {string} section - one `diff --git` section, newline-terminated.
 * @returns {string | null} the path, or null when the header cannot be parsed.
 */
function diffSectionPath(section) {
  const newline = section.indexOf('\n')
  const header = newline < 0 ? section : section.slice(0, newline)
  const [aPath, bPath] = diffHeaderPaths(header)
  if (/^deleted file mode /m.test(section)) return patchPathOf(aPath) ?? patchPathOf(bPath)
  return patchPathOf(bPath) ?? patchPathOf(aPath)
}

/**
 * Split a patch into its per-file sections.
 *
 * A section begins at a line that starts with `diff --git `; git writes one per changed
 * file, and no line *inside* a hunk can start that way because git prefixes hunk content
 * with a space, `+`, or `-`. The offsets are into the whole patch, so a page can be cut
 * at a boundary without re-parsing the text.
 *
 * @param {string} diff - a full patch.
 * @returns {Array<{start: number, end: number, text: string, path: string | null}>} the sections.
 */
function diffSections(diff) {
  const starts = []
  const scanner = /^diff --git /gm
  let match
  while ((match = scanner.exec(diff)) !== null) starts.push(match.index)
  if (starts.length === 0) {
    return diff.length === 0 ? [] : [{ start: 0, end: diff.length, text: diff, path: null }]
  }
  const sections = []
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]
    const end = index + 1 < starts.length ? starts[index + 1] : diff.length
    const text = diff.slice(start, end)
    sections.push({ start, end, text, path: diffSectionPath(text) })
  }
  return sections
}

/**
 * The largest prefix of `text` that ends at a line boundary and is at most `limit` chars.
 * @param {string} text - the text to cut.
 * @param {number} limit - the character budget.
 * @returns {string} the prefix, ending in a newline, or `''` when no line ends within it.
 */
function cutAtLineBoundary(text, limit) {
  if (limit <= 0) return ''
  const newline = text.lastIndexOf('\n', limit - 1)
  return newline < 0 ? '' : text.slice(0, newline + 1)
}

/**
 * Clip a patch to whole file sections within a character budget.
 *
 * A patch cut at an arbitrary character is a patch nobody can read: the `diff` in a result
 * is for review, and a half-written hunk reads as a change that did not happen. Whole
 * sections are therefore kept while they fit. When even the first section is over budget
 * it is kept only up to its last whole line, so the reader still sees that the file
 * changed, and the section is named in `diffOmitted` in either case.
 *
 * @param {string} diff - the full patch.
 * @param {number} diffChars - the budget.
 * @returns {{diff: string, diffOmitted: string[]}} the clipped text and the paths left out or cut.
 */
function clipPatch(diff, diffChars) {
  if (diff.length <= diffChars) return { diff, diffOmitted: [] }
  const sections = diffSections(diff)
  const kept = []
  const omitted = []
  let total = 0
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]
    if (total + section.text.length <= diffChars) {
      kept.push(section.text)
      total += section.text.length
      continue
    }
    if (kept.length === 0) {
      const partial = cutAtLineBoundary(section.text, diffChars)
      if (partial.length > 0) kept.push(partial)
    }
    for (let rest = index; rest < sections.length; rest += 1) {
      if (sections[rest].path !== null) omitted.push(sections[rest].path)
    }
    break
  }
  return { diff: kept.join(''), diffOmitted: omitted }
}

/**
 * One page of selected patch text, cut at a file or line boundary.
 *
 * A page that ends mid-line is a page a reviewer has to reconstruct; the last file boundary
 * inside the window is therefore preferred, and the last line boundary is the fallback. Only
 * a single line longer than the whole window is ever cut mid-line, and then `nextOffset`
 * simply continues there. `files` names the sections that start or continue in the page.
 *
 * @param {Array<{start: number, end: number, path: string | null}>} sections - the selected
 *   sections, re-based to offsets in `selected`.
 * @param {string} selected - the selected patch text.
 * @param {number} offset - where the page starts.
 * @param {number} maxChars - the page budget.
 * @returns {{diff: string, offset: number, files: string[], nextOffset: number | null}} the page.
 */
function pageSections(sections, selected, offset, maxChars) {
  const total = selected.length
  const start = Math.min(Math.max(0, offset), total)
  const windowEnd = Math.min(start + maxChars, total)
  let end = windowEnd
  if (windowEnd < total) {
    let boundary = -1
    for (let index = 1; index < sections.length; index += 1) {
      const at = sections[index].start
      if (at > start && at < windowEnd) boundary = at
    }
    if (boundary >= 0) {
      end = boundary
    } else {
      const newline = selected.lastIndexOf('\n', windowEnd - 1)
      if (newline >= start) end = newline + 1
    }
  }
  const files = []
  for (const section of sections) {
    if (section.start < end && section.end > start && section.path !== null) files.push(section.path)
  }
  return { diff: selected.slice(start, end), offset: start, files, nextOffset: end >= total ? null : end }
}

/**
 * The preimage side of a staged change: the base entries and the blobs behind them.
 *
 * `--raw` with `-z` writes one record per path, `:<srcmode> <dstmode> <srcsha> <dstsha>
 * <status>` followed by the path, or by the old then the new path for a rename or copy.
 * The `src` half is the base: every non-zero source id is a blob a three-way merge needs,
 * and every non-added record names a base entry a merge has to rebuild. An addition has no
 * source, which is why it is the one status that contributes neither.
 *
 * @param {string} repoDir - the copy the patch was computed in.
 * @param {string} base - the base commit the patch was diffed against.
 * @returns {{preimage: Array<{path: string, mode: string, blob: string}>, blobs: string[]}} the
 *   base entries and the distinct source blob ids.
 * @throws {Error} when the raw diff cannot be read.
 */
function preimageEntries(repoDir, base) {
  const raw = git(['diff', '--cached', '--raw', '--no-abbrev', '-z', base], repoDir)
  const fields = raw.split('\0')
  const preimage = []
  const blobs = new Set()
  let at = 0
  while (at < fields.length) {
    const header = fields[at]
    at += 1
    const match = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) (\S+)$/.exec(header)
    if (match === null) continue
    const status = match[5]
    const sourcePath = fields[at]
    at += 1
    // A rename or copy carries its old path first, then its new one.
    if (status.startsWith('R') || status.startsWith('C')) at += 1
    // `--no-abbrev` keeps every id its full length, so the all-zero source of an addition is
    // a run of zeroes rather than anything a short id could be confused with.
    if (/^0+$/.test(match[3])) continue
    // A gitlink's id names a commit in the submodule's own repository, not an object this
    // copy holds: packing it fails the whole save. The merge needs only the id itself, which
    // the preimage entry records.
    if (match[1] !== GITLINK_MODE) blobs.add(match[3])
    if (!status.startsWith('A')) preimage.push({ path: sourcePath, mode: match[1], blob: match[3] })
  }
  return { preimage, blobs: [...blobs] }
}

/**
 * Save the preimage blobs of a stored patch, so a later three-way merge has a base.
 *
 * The patch's base is the copy's staged tree, and for a caller with uncommitted work that
 * tree exists only in the copy, which is emptied after the call. The blobs a merge needs
 * are exactly the `src` side of the staged change, so `--raw` is asked for them once and
 * every non-zero source id is packed into `<patchId>.blobs/pack/` — an ordinary object
 * directory the merge's scratch repository borrows read-only through
 * `objects/info/alternates`.
 *
 * Best effort by design. A patch that cannot carry its blobs is still a patch, and a
 * three-way merge of it reports that the base is unavailable; failing the call over it
 * would lose work that plain apply can still deliver.
 *
 * @param {string} repoDir - the copy the patch was computed in.
 * @param {string} base - the base commit the patch was diffed against.
 * @param {string} patchDir - where stored patches live.
 * @param {string} patchId - the id the patch is stored under.
 * @param {(message: string) => void} log - where a failure is named.
 * @returns {Array<{path: string, mode: string, blob: string}> | undefined} the base entries,
 *   or undefined when they could not be read or saved.
 */
function savePreimageBlobs(repoDir, base, patchDir, patchId, log) {
  let entries
  try {
    entries = preimageEntries(repoDir, base)
  } catch (error) {
    log(`could not read the preimage of ${patchId} (${messageOf(error)}); a three-way merge of this patch will not be possible`)
    return undefined
  }
  if (entries.blobs.length > 0) {
    try {
      const dir = blobsDirectory(patchDir, patchId)
      mkdirSync(join(dir, 'pack'), { recursive: true })
      git(['pack-objects', '-q', join(dir, 'pack', 'pack')], repoDir, process.env, `${entries.blobs.join('\n')}\n`)
    } catch (error) {
      // A half-written pack is worse than none: the merge would read a truncated object
      // store and could merge against a tree that is not the patch's base.
      rmSync(blobsDirectory(patchDir, patchId), { recursive: true, force: true })
      log(`could not save the base blobs of ${patchId} (${messageOf(error)}); a three-way merge of this patch will not be possible`)
      return undefined
    }
  }
  return entries.preimage
}

/**
 * Every path a patch touches, old and new.
 *
 * The stored `--name-status` records are `STATUS<TAB>path`, with a rename or copy adding
 * its old path before the new one. Both sides matter: the caller's tree has to be read at
 * each of them to rebuild "ours" over the patch's base, and the recorded preimage paths are
 * added as well so a list that is somehow short still stages every base entry.
 *
 * @param {object} record - a patch record.
 * @returns {string[]} the paths, without duplicates.
 */
function touchedPaths(record) {
  const paths = new Set()
  for (const line of record.filesChanged ?? []) {
    const fields = String(line).split('\t')
    for (let at = 1; at < fields.length; at += 1) paths.add(nameStatusPath(fields[at]))
  }
  // The name-status list already carries a rename's old path, but every base entry has to
  // be read from the caller's tree all the same; adding them here means a record whose list
  // is somehow short still stages "ours" completely.
  for (const entry of record.preimage ?? []) paths.add(nameStatusPath(entry.path))
  return [...paths]
}

/**
 * Refuse a three-way merge the installed git cannot do.
 *
 * `merge-tree --write-tree` is what merges two trees and writes the result without an
 * index, and it arrived in 2.38. Older gits have no other spelling, so the requirement is
 * named rather than left as a parse failure.
 *
 * @param {string} cwd - any directory to ask git its version in.
 * @returns {void}
 * @throws {Error} when git is older than 2.38.
 */
function requireMergeTree(cwd) {
  const version = git(['--version'], cwd).trim()
  const match = /^git version (\d+)\.(\d+)/.exec(version)
  const major = Number(match?.[1] ?? 0)
  const minor = Number(match?.[2] ?? 0)
  if (major > 2 || (major === 2 && minor >= 38)) return
  throw new Error(`a three-way merge needs git >= 2.38 for "merge-tree --write-tree", but this git is ${version}`)
}

/**
 * The mode and blob of one path in a tree.
 * @param {string} scratch - the scratch repository.
 * @param {string} tree - a tree id.
 * @param {string} path - a path in it.
 * @param {NodeJS.ProcessEnv} env - environment for git.
 * @returns {{mode: string, type: string, sha: string} | undefined} the entry, or undefined.
 */
function treeEntry(scratch, tree, path, env) {
  const line = git(['ls-tree', '-z', tree, '--', path], scratch, env)
  const nul = line.indexOf('\0')
  const record = nul < 0 ? line : line.slice(0, nul)
  const match = /^(\d+) (\S+) ([0-9a-f]+)\t/.exec(record)
  if (match === null) return undefined
  return { mode: match[1], type: match[2], sha: match[3] }
}

/**
 * Write one merged blob into the caller's tree.
 *
 * The blob is read as bytes: a text read would replace every invalid UTF-8 sequence and
 * corrupt a binary file. An existing symlink is removed rather than written through, or
 * the blob would land on whatever it points at.
 *
 * @param {string} scratch - the scratch repository the blob lives in.
 * @param {string} target - the caller's tree.
 * @param {string} path - the path, relative to the target.
 * @param {string} mode - the result's git mode.
 * @param {string} sha - the blob id.
 * @param {NodeJS.ProcessEnv} env - environment for git.
 * @returns {void}
 */
function writeResultFile(scratch, target, path, mode, sha, env) {
  const full = join(target, path)
  if (mode === '120000') {
    const link = gitBuffer(['cat-file', 'blob', sha], scratch, env).toString('utf8')
    mkdirSync(dirname(full), { recursive: true })
    rmSync(full, { force: true })
    symlinkSync(link, full)
    return
  }
  // `--filters` is the inverse of the `hash-object --path` that read "ours": the same
  // end-of-line conversion the caller's git config asks for (core.autocrlf on Windows) is
  // applied on the way out, so a merged file keeps the line endings the caller's checkout
  // uses instead of every line of it reading as changed.
  const content = gitBuffer(['cat-file', '--filters', `--path=${path}`, sha], scratch, env)
  // The caller's own permission bits survive a rewrite; only the executable bits follow the
  // merged mode. A file a umask or a deliberate chmod made private stays private.
  let previous
  try {
    const info = lstatSync(full)
    if (info.isFile()) previous = info.mode & 0o777
  } catch {
    // A new file: the default below applies.
  }
  mkdirSync(dirname(full), { recursive: true })
  rmSync(full, { force: true })
  writeFileSync(full, content)
  const base = previous ?? 0o644
  chmodSync(full, mode === '100755' ? base | ((base & 0o444) >> 2) : base & ~0o111)
}

/**
 * Refuse a path whose parent directories include a symbolic link.
 *
 * A merged path is joined onto the caller's tree, and a directory component that is a
 * symlink would carry the write (or the deletion) to wherever it points — outside the tree,
 * possibly. Plain `git apply` refuses the same thing ("beyond a symbolic link"); the
 * three-way path must not be the door around it. The leaf itself may be a symlink: it is
 * removed and replaced, never written through.
 *
 * @param {string} target - the caller's tree.
 * @param {string} path - a path relative to it, as git names it.
 * @returns {void}
 * @throws {Error} when a parent component is a symbolic link.
 */
function refuseSymlinkParents(target, path) {
  const parts = path.split('/')
  let current = target
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    let info
    try {
      info = lstatSync(current)
    } catch {
      // Missing from here down: mkdir creates real directories, so nothing further can be a link.
      return
    }
    if (info.isSymbolicLink()) {
      throw new Error(`${path} is beyond a symbolic link (${relative(target, current)}); the three-way merge will not write through it`)
    }
  }
}

/**
 * Every leaf path under one directory, relative to the tree that contains it.
 *
 * Used before a merged file replaces a caller directory: every file the directory holds has
 * to be one of the merge's deletions, or replacing it would destroy the caller's work. A
 * symlink counts as a leaf, because it is not a file the merge can account for either.
 *
 * @param {string} dir - the existing directory.
 * @param {string} top - the tree the returned paths are relative to.
 * @returns {string[]} the leaf paths, with `/` separators.
 */
function filePathsUnder(dir, top) {
  const files = []
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      // Unreadable from here down: treat it as holding something the merge cannot name, so
      // the caller refuses rather than deleting it blind.
      files.push(relative(top, current).split(sep).join('/'))
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.push(relative(top, full).split(sep).join('/'))
    }
  }
  walk(dir)
  return files
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
   * @param {number} [options.maxStateBytes] - how much this root's patches and retired
   *   trees may take before `trim` removes the reclaimable ones; 0 or omitted: no cap.
   * @param {number} [options.sweepIntervalMs] - how often a running pool sweeps dead
   *   owners and trims; 0 turns the timer off.
   * @param {string[]} [options.copyExclude] - names or relative paths left out of the copy
   *   where it is safe; merged over `.flash-agents.json`, options last.
   * @param {Record<string, string>} [options.slotEnv] - `ENV_NAME: "home:<name>" | "cache:<name>" |
   *   "port:<base>[/<stride>]"` entries pointing the worker's runtime at writable per-slot
   *   directories, or reserving a per-slot port range; options win per variable over the
   *   settings file.
   * @param {boolean} [options.allowSlotSetup] - whether the `slotSetup` steps in
   *   `.flash-agents.json` may run on the host. Off by default: a setup step is host code
   *   outside the worker's sandbox, so it needs an explicit opt-in.
   * @param {(message: string) => void} [options.log] - progress log.
   */
  constructor({
    root,
    slots = 2,
    stateDir,
    copyExclude,
    slotEnv,
    allowSlotSetup = false,
    patchRetentionDays = PATCH_RETENTION_DAYS,
    maxStateBytes = 0,
    sweepIntervalMs = SWEEP_INTERVAL_MS,
    log = () => {},
  }) {
    this.root = resolve(root)
    /** Whether this instance owns a private state directory it may clear. */
    this.ownsStateDir = stateDir === undefined || stateDir === null || stateDir === ''
    this.stateDir = this.ownsStateDir ? defaultStateDir(this.root) : resolve(stateDir)
    /**
     * Where patches are stored. With a private state directory they live in the durable
     * per-root store (`FLASH_DATA_DIR` or the platform data directory), not beside this
     * process's own trees, so the sweep that reclaims a dead service's copies cannot take
     * a patch the caller was told it could still apply. A configured state directory
     * keeps its own `calls` store.
     */
    this.patchDir = this.ownsStateDir ? defaultPatchDir(this.root) : join(this.stateDir, 'calls')
    this.patchRetentionDays = patchRetentionDays
    this.maxStateBytes = maxStateBytes
    this.log = log
    // Read once, at construction: the settings describe the repository, not the call, and
    // every call prepares faster when the file is not re-read. A broken file only logs; the
    // service still starts.
    const settings = readRepoSettings(this.root, this.log)
    if (copyExclude !== undefined && !Array.isArray(copyExclude)) {
      this.log('ignoring the copyExclude option: it must be an array of strings')
    }
    const slotCount = Math.max(1, slots)
    /**
     * Accepted `slotEnv` entries, resolved per slot by `slotEnvFor`. A `port` entry creates
     * no directory; its value is derived from `slot.id` alone.
     *
     * @type {Record<string, {kind: string, segment?: string, base?: number, stride?: number}>}
     */
    this.slotEnv = mergeSlotEnv(settings.slotEnv, slotEnv, this.log, slotCount)
    /** Whether `.flash-agents.json`'s `slotSetup` steps may run on the host. */
    this.slotSetupAllowed = allowSlotSetup === true
    /**
     * The setup steps that passed validation, in configuration order. A kept path that the
     * caller's own git does not ignore — or that it tracks — is refused here, so the step
     * still runs but cannot move tracked source out of the copy.
     *
     * @type {{run: string[], inputs: string[], keep: string[], timeoutSeconds: number}[]}
     */
    this.slotSetup = (settings.slotSetup ?? []).map((step) => ({
      ...step,
      keep: step.keep.filter((relPath) => {
        const decision = this.#excludeDecision(this.root, relPath)
        if (decision.omit) return true
        this.log(
          `not keeping ${relPath} for slotSetup (${step.run.join(' ')}): ${decision.reason ?? 'it is not ignored'}; ` +
            'the step still runs, without it',
        )
        return false
      }),
    }))
    /** The warning every result carries when steps are configured but not allowed. */
    this.slotSetupWarning = undefined
    if (this.slotSetup.length > 0 && !this.slotSetupAllowed) {
      this.slotSetupWarning = SETUP_NOT_ALLOWED_WARNING
      this.log(SETUP_NOT_ALLOWED_WARNING)
    }
    // A kept path is left out of the copy as well: there is no point copying the caller's
    // `node_modules` only to replace it with the slot's own.
    const keptPaths = this.slotSetup.flatMap((step) => step.keep)
    this.copyExclude = normalizeExclude([
      ...(settings.copyExcludeDefaults === false ? [] : DEFAULT_COPY_EXCLUDE),
      ...(settings.copyExclude ?? []),
      ...(Array.isArray(copyExclude) ? copyExclude : []),
      ...keptPaths,
    ])
    // A default that git keeps (a tracked `.env.example`) is the expected case, not news
    // worth a log line on every call; only the entries someone asked for are reported.
    this.namedExclude = normalizeExclude([...(settings.copyExclude ?? []), ...(Array.isArray(copyExclude) ? copyExclude : []), ...keptPaths])
    this.clones = 0
    /** Patches kept for a later `flash_apply`. @type {Map<string, object>} */
    this.patches = new Map()
    /**
     * The legacy temp patch store this pool still reads, when its migration had to be
     * deferred because another live server of this old version still uses it. While it is
     * set, records are loaded from both stores (durable wins on a shared id) and updates go
     * to the record's own directory. `#sweepDeadOwners` retries the migration once no other
     * live pid remains.
     */
    this.legacyPatchDir = undefined
    /** Callers waiting for a slot, oldest first. @type {Function[]} */
    this.waiting = []
    this.slots = Array.from({ length: slotCount }, (_, id) => ({
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
    // A configured `calls` directory is part of the configured state and is made eagerly
    // as before. The durable default store is made on demand: constructing a pool that
    // never stores a patch must not leave an empty directory in the user's data
    // directory, which is also what keeps a read-only test run out of the real home.
    if (!this.ownsStateDir) mkdirSync(this.patchDir, { recursive: true })
    if (this.ownsStateDir) {
      // A patch written by an older version lives in the temp tree. Normally it is moved
      // before the sweep and the load, so the upgrade keeps exactly the work the caller was
      // told it could still apply. But an old server may be running on this root right now,
      // with its in-memory paths already pointing into that directory: moving the files out
      // from under it would make its `flash_apply` fail. Deferring is safe because this pool
      // lists and applies those records in place until the migration can run (see
      // `#sweepDeadOwners`), and an incomplete id is never moved (see `migrateLegacyPatches`).
      const legacyDir = join(stateBaseDir(), rootDigest(this.root), 'patches')
      const otherPids = livePidsIn(join(stateBaseDir(), rootDigest(this.root))).filter((pid) => pid !== process.pid)
      if (otherPids.length > 0) {
        this.legacyPatchDir = legacyDir
        this.log(
          `deferred moving stored patches from ${legacyDir} to ${this.patchDir}: ` +
            `process(es) ${otherPids.join(', ')} still use the old store`,
        )
      } else {
        migrateLegacyPatches(legacyDir, this.patchDir, { log: this.log })
      }
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
    // Unref'd: housekeeping must never be the reason a finished process stays alive.
    this.sweepTimer =
      sweepIntervalMs > 0 ? setInterval(() => this.#housekeeping(), sweepIntervalMs).unref() : undefined
  }

  /** The timer's pass: sweep dead owners, then trim, never throwing into the event loop. */
  #housekeeping() {
    try {
      this.#sweepDeadOwners()
      this.trim()
    } catch (error) {
      this.log(`housekeeping failed: ${messageOf(error)}`)
    }
  }

  /**
   * Salvage and remove dead owners of this root while the pool runs.
   *
   * Cheap when there is nothing to do — one directory listing and a signal-0 probe per
   * owner — so it can run before every `prepare`. Whatever it salvages is loaded at
   * once, so the patch is applicable from this server without a restart.
   *
   * The pass also retries a deferred legacy-store migration. That is what closes the
   * upgrade window: this pool read the old store in place while another live server used
   * it, and once that process is gone the same periodic pass moves the patches to the
   * durable store and reloads them from there.
   *
   * @returns {void}
   */
  #sweepDeadOwners() {
    if (!this.ownsStateDir) return
    const migrated = this.#retryLegacyMigration()
    const swept = sweepDeadOwners(this.root, { patchDir: this.patchDir, log: this.log }) > 0
    // While a live old server keeps writing into the legacy store, the in-memory view is
    // refreshed from it too: the old server may have committed a patch since construction,
    // and the caller of this server must be able to list it. The reload is two small
    // directory listings, and only while the old store is being watched.
    const watchingLegacy = this.legacyPatchDir !== undefined
    if (migrated || swept || watchingLegacy) this.#loadPatches()
  }

  /**
   * Move the legacy store into the durable one once no other live process uses it.
   *
   * A deferred migration is retried on every sweep, but only while another live owner of
   * this root's state exists is it held back; the check excludes this process, whose own
   * pid directory is not a reason to keep the old store. An incomplete legacy id stays
   * where it is, because its writer may still be finishing it.
   *
   * @returns {boolean} whether anything moved and the in-memory records need reloading.
   */
  #retryLegacyMigration() {
    const legacyDir = this.legacyPatchDir
    if (legacyDir === undefined) return false
    const others = livePidsIn(join(stateBaseDir(), rootDigest(this.root))).filter((pid) => pid !== process.pid)
    if (others.length > 0) return false
    const moved = migrateLegacyPatches(legacyDir, this.patchDir, { log: this.log })
    // A fully migrated store is gone. Forgetting the flag then keeps later sweeps from
    // probing a directory that no longer exists; anything still in it was incomplete and
    // is retried only while the old store is still being watched.
    if (!existsSync(legacyDir)) this.legacyPatchDir = undefined
    return moved > 0
  }

  /**
   * Keep this root's stored state under `maxStateBytes`.
   *
   * What counts is what the pool keeps after a call: stored patches and the trees
   * `retire` left in place. Retired trees go first: their work was already
   * collected into a patch when they were retired, so they are pure weight. Applied
   * patches go next, oldest application first: their change is in the caller's tree.
   * Unapplied patches are never removed here — one may be the only copy of finished
   * work, and the retention window already ages them out — so a root still over the
   * cap after that is reported in the log rather than trimmed further.
   *
   * @returns {{bytes: number, removedTrees: number, removedPatches: number}} what is
   *   left, and what was removed.
   */
  trim() {
    const result = { bytes: 0, removedTrees: 0, removedPatches: 0 }
    if (!(this.maxStateBytes > 0)) return result
    const fileSize = (path) => {
      try {
        return statSync(path).size
      } catch {
        return 0
      }
    }
    const trees = this.slots.flatMap((slot) => slot.orphans.map((dir) => ({ slot, dir, bytes: directorySize(dir) })))
    const patches = [...this.patches.values()].map((record) => ({
      record,
      bytes:
        fileSize(record.patchPath) +
        fileSize(record.metaPath) +
        // The saved preimage blobs are kept for the merge that may still come, so they are
        // part of what the patch costs until the patch itself goes.
        directorySize(blobsDirectory(record.storeDir ?? this.patchDir, record.patchId)),
    }))
    let total = [...trees, ...patches].reduce((sum, entry) => sum + entry.bytes, 0)
    for (const tree of trees) {
      if (total <= this.maxStateBytes) break
      rmSync(tree.dir, { recursive: true, force: true })
      tree.slot.orphans.splice(tree.slot.orphans.indexOf(tree.dir), 1)
      total -= tree.bytes
      result.removedTrees += 1
      this.log(`trim: removed retired tree ${tree.dir} (${formatBytes(tree.bytes)})`)
    }
    const applied = patches
      .filter((entry) => entry.record.appliedAt !== null && entry.record.appliedAt !== undefined)
      .sort((a, b) => Number(a.record.appliedAt) - Number(b.record.appliedAt))
    for (const { record, bytes } of applied) {
      if (total <= this.maxStateBytes) break
      rmSync(record.patchPath, { force: true })
      rmSync(record.metaPath, { force: true })
      rmSync(blobsDirectory(record.storeDir ?? this.patchDir, record.patchId), { recursive: true, force: true })
      this.patches.delete(record.patchId)
      total -= bytes
      result.removedPatches += 1
      this.log(`trim: removed applied patch ${record.patchId} (${formatBytes(bytes)})`)
    }
    if (total > this.maxStateBytes) {
      this.log(
        `trim: this root's state holds ${formatBytes(total)}, over the ${formatBytes(this.maxStateBytes)} cap; ` +
          'what is left is unapplied patches, which are kept until they expire',
      )
    }
    result.bytes = total
    return result
  }

  /** How many trees may be in flight at once. */
  get size() {
    return this.slots.length
  }

  /** How many trees a call holds right now: the slots whose `busy` is true. */
  get inUse() {
    return this.slots.filter((slot) => slot.busy).length
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
    // Rebuilt rather than merged: a deferred migration can move a record from the legacy
    // store to the durable one, and a held record whose paths still name the old directory
    // would then apply a file that is gone. Each load reflects the stores as they are now.
    this.patches.clear()
    this.#loadPatchesFrom(this.patchDir)
    if (this.legacyPatchDir !== undefined) this.#loadPatchesFrom(this.legacyPatchDir)
  }

  /**
   * Read the patch records of one store into memory.
   *
   * A durable record wins over a legacy one with the same id because the durable store is
   * read first and an id already held is skipped. The record keeps the directory it came
   * from (`storeDir`) and its paths point there, so an update — marking it applied, say —
   * is written next to that record and never split across the two stores.
   *
   * @param {string} patchDir - the store to read.
   * @returns {void}
   */
  #loadPatchesFrom(patchDir) {
    let names
    try {
      names = readdirSync(patchDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const patchId = name.slice(0, -'.json'.length)
      if (!PATCH_ID.test(patchId) || this.patches.has(patchId)) continue
      const metaPath = join(patchDir, name)
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
      record.patchPath = join(patchDir, `${patchId}.patch`)
      record.storeDir = patchDir
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
   * working tree, not of `HEAD`, unless `source: 'head'` asks for the last commit instead.
   * The base is then recorded inside the copy so the diff afterwards is each worker's
   * contribution alone, whether or not the caller's tree was dirty to begin with.
   *
   * @param {Slot} slot - a leased slot.
   * @param {object} [options] - what to copy and from where.
   * @param {string} [options.cwd] - the call's working directory, which selects the scope.
   * @param {'working-tree' | 'head'} [options.source] - what the copy starts from.
   * @param {object} [options.fs] - an `fs`-like override passed to `copyTree`; tests only.
   * @returns {{base: string | null, mechanism: 'clone' | 'copy', scope: string,
   *   excluded: string[], uncommitted: {count: number, files: string[]}, reason?: string}} the base.
   */
  prepare(slot, { cwd, source = 'working-tree', fs } = {}) {
    // A server that died while this one ran leaves its trees behind; the next call is the
    // cheapest moment to notice, since it is about to need disk anyway.
    this.#sweepDeadOwners()
    // A kept path still sits inside the previous copy. It belongs to the slot cache, not to
    // this call's starting state, so it is moved back before the copy is emptied — that is
    // what makes the next call find it, and what keeps the worker's changes to it across
    // calls.
    this.#stashKeepPaths(slot)
    emptyDirectory(slot.dir)
    const scope = repositoryScope(this.root, cwd)
    const repoDir = scope === '' ? slot.dir : join(slot.dir, scope)
    const original = scope === '' ? this.root : join(this.root, scope)
    // "head" resets the copy to the last commit, so it needs a repository to reset to.
    // Checked before the copy: there is no point copying a tree that cannot be prepared.
    if (source === 'head' && !isGitWorkTree(original)) {
      throw new IsolationError(`source "head" needs a git repository, and ${original} is not one`, 'SOURCE_UNAVAILABLE')
    }
    if (scope !== '') {
      mkdirSync(repoDir, { recursive: true })
      writeFileSync(join(slot.dir, SCOPE_MARKER), `${scope}\n`)
    }
    let copied
    try {
      copied = copyTree(original, repoDir, {
        fs,
        exclude: this.copyExclude,
        // The safety of leaving a matched path out needs git, so the decision stays here
        // rather than in the walk. It runs once per matched path, not once per file.
        consider: (relPath) => this.#excludeDecision(original, relPath),
      })
    } catch (error) {
      // A raw ENOENT names a hashed build artefact and teaches the caller nothing. Say
      // what was being copied and the usual cause, because a build rewriting its output
      // while the copy walks it is a race the caller can simply retry.
      throw new Error(
        `the copy of ${original} failed: ${messageOf(error)}. ` +
          'If the tree was changing while it was copied (a build running), a retry usually works.',
      )
    }
    const { mechanism, skipped, vanished, excluded, kept, linksRepointed, repointed, linksSkipped } = copied
    if (vanished > 0) {
      this.log(`skipped ${String(vanished)} file(s) that vanished while the copy was made (a build was writing in ${original})`)
    }
    if (skipped.length > 0) {
      this.log(`left ${String(skipped.length)} linked worktree(s) out of the copy, their git state is not this tree's: ${skipped.join(', ')}`)
    }
    if (linksRepointed > 0) {
      this.log(`re-pointed ${String(linksRepointed)} absolute symlink(s) at the same path inside the copy, they named ${original}`)
    }
    if (linksSkipped.length > 0) {
      // A worker that cannot see a link it was not told about reads as a missing dependency;
      // an out-of-tree junction would be worse, a write path back into the caller's tree.
      this.log(
        `left ${String(linksSkipped.length)} symlink(s) out of the copy, Windows refused to recreate them ` +
          '(that needs Developer Mode or the symlink privilege): ' +
          linksSkipped.map((entry) => `${entry.path} -> ${entry.target} (${entry.reason})`).join(', '),
      )
    }
    for (const entry of kept) {
      const name = entry.path.split(sep).pop()
      if (!matchesExclude(entry.path.split(sep).join('/'), name, this.namedExclude)) continue
      this.log(`not leaving out ${entry.path}: ${entry.reason ?? 'it is not ignored'}`)
    }
    if (excluded.length > 0) {
      this.log(`left ${String(excluded.length)} excluded path(s) out of the copy: ${excluded.join(', ')}`)
    }
    this.clones += 1
    slot.scope = scope
    slot.repoDir = repoDir
    slot.base = null
    slot.baseReason = undefined
    slot.uncommitted = { count: 0, files: [] }
    // The worker has nowhere legitimate to name outside its copy — the wall refuses
    // it — so it is given a scratch directory *inside* the copy and told about it in
    // its prompt. It is not handed over through TMPDIR: the runtime's sandbox derives
    // its writable roots from the runtime's own TMPDIR, and overriding that withdrew
    // the platform temp area every toolchain assumes. Excluded before the base
    // commit, so tools that write there produce no diff and no surprise.
    slot.tmpDir = join(slot.dir, SLOT_TMP)
    mkdirSync(slot.tmpDir, { recursive: true })
    if (!isGitWorkTree(repoDir)) {
      // Without a repository nothing can be excluded from a diff, but the worker's
      // writable home and caches must still exist for a tool that expects them.
      this.#createSlotEnv(slot)
      slot.baseReason = 'the service root is not a git repository, so no diff could be computed'
      return { base: null, mechanism, scope, excluded, uncommitted: slot.uncommitted, reason: slot.baseReason }
    }
    try {
      detachGitLink(original, repoDir)
      // Exclusions go in *after* the link is detached: a linked worktree gets a fresh .git
      // here, and an exclusion written before that would not be in it. `.flash-tmp` always
      // exists; `.flash-home` is named only when a `slotEnv` entry creates it, and
      // `.flash-cache` when one does or when a setup step keeps something in the slot, so
      // an ordinary copy's ignore list stays exactly what it was.
      const hasDirEnv = Object.values(this.slotEnv).some((spec) => spec.kind !== 'port')
      const slotNames = [SLOT_TMP]
      if (hasDirEnv) slotNames.push(SLOT_HOME)
      if (hasDirEnv || this.slotSetup.length > 0) slotNames.push(SLOT_CACHE)
      for (const name of slotNames) {
        excludeFromDiff(slot.dir, name)
        // A worker told to keep scratch next to its cwd writes inside the copied repository
        // when the copy is scoped to one; exclude it there too, so it never reaches a patch.
        if (repoDir !== slot.dir) excludeFromDiff(repoDir, name)
      }
      this.#createSlotEnv(slot)
      if (source === 'head') {
        // The copy starts from the last commit: tracked files return to HEAD and untracked,
        // non-ignored files are removed. `-x` is deliberately absent — ignored build output
        // and dependencies such as node_modules stay, which is the point of running this in
        // a tree that already has them.
        git(['reset', '--hard', '-q', 'HEAD'], repoDir)
        git(['clean', '-fdq'], repoDir)
      }
      // What the caller's tree held when the copy was made, read before the base is
      // recorded so the worker's own later work cannot be mixed into it. With `head` the
      // reset above removed it, so the copy starts with nothing uncommitted.
      //
      // A re-pointed link is skipped only when the CALLER's tree reports it clean: the copy
      // moved it, so the copy's status lists it, but one the caller retargeted themselves is
      // their uncommitted work and must stay in the report.
      const callerChanged = changedInCaller(original, repointed)
      const copyOnly = new Set(repointed.filter((path) => !callerChanged.has(path)))
      slot.uncommitted = uncommittedIn(repoDir, copyOnly)
      slot.base = this.#recordBase(slot)
      return { base: slot.base, mechanism, scope, excluded, uncommitted: slot.uncommitted }
    } catch (error) {
      slot.baseReason = `the base state could not be recorded: ${error.message}`
      return { base: null, mechanism, scope, excluded, uncommitted: slot.uncommitted, reason: slot.baseReason }
    }
  }

  /**
   * Record where the copy currently is, without disturbing the copy's index.
   *
   * `git add -A` on the real index left every uncommitted edit of the caller looking staged
   * in the copy, so workers reported "pre-existing staged modifications" that were never the
   * caller's index state. A private index seeded from the real one produces the same tree and
   * leaves the real index exactly as the caller had it; `#collect` stages the real index
   * later and diffs against this base, which is unchanged behaviour.
   *
   * The ignored set is recorded here as well: ignored files are invisible to `git add -A`,
   * so a worker that writes only ignored files would otherwise produce an empty patch and
   * read as "no change". `runSetup` calls this again after a setup step ran (or after a kept
   * path was restored), so whatever the setup wrote is the copy's starting state and never
   * the worker's change.
   *
   * The ignored FILES — their size and mtime — are recorded beside the path list, because a
   * file that existed at the start and was rewritten leaves the list unchanged (see
   * `ignoredFileStats`).
   *
   * @param {Slot} slot - a prepared slot whose `repoDir` and `tmpDir` exist.
   * @returns {string} the base commit id.
   */
  #recordBase(slot) {
    const repoDir = slot.repoDir
    const indexFile = join(slot.tmpDir, `base-index-${randomUUID()}`)
    const realIndex = resolve(repoDir, git(['rev-parse', '--git-path', 'index'], repoDir).trim())
    let tree
    try {
      if (existsSync(realIndex)) copyFileSync(realIndex, indexFile)
      const env = { ...process.env, GIT_INDEX_FILE: indexFile }
      git(['add', '-A'], repoDir, env)
      tree = git(['write-tree'], repoDir, env).trim()
    } finally {
      // The temp index is a copy of the caller's and holds nothing worth keeping; a
      // failure to remove it must not turn a prepared slot into a failed call.
      rmSync(indexFile, { force: true })
    }
    let parent = []
    try {
      parent = ['-p', git(['rev-parse', '--verify', '-q', 'HEAD'], repoDir).trim()]
    } catch {
      // A repository without a first commit has no parent to name.
    }
    slot.base = git([...COMMIT_CONFIG, 'commit-tree', tree, ...parent, '-m', 'flash base'], repoDir).trim()
    git(['update-ref', BASE_REF, slot.base], repoDir)
    this.#recordIgnored(slot, repoDir)
    return slot.base
  }

  /**
   * Record the copy's git-ignored state: the path list, and the facts of the ignored FILES.
   *
   * Called wherever the copy's starting state is (re)recorded — `#recordBase` after the
   * copy is made or the slot setup ran, and `applyBasePatch` once a base patch is in the
   * copy — so that a later `collect` can tell a path the worker created from one it
   * rewrote. Files inside an ignored directory are deliberately not tracked; see
   * `ignoredFileStats`.
   *
   * @param {Slot} slot - the slot whose state is being recorded.
   * @param {string} repoDir - the git work tree that holds the copy's state.
   * @returns {void}
   */
  #recordIgnored(slot, repoDir) {
    const paths = ignoredPaths(repoDir)
    slot.ignoredBase = paths
    slot.ignoredFiles = ignoredFileStats(repoDir, paths)
  }

  /**
   * Whether one exclude match may actually be left out of the copy.
   *
   * A name such as `target` or `node_modules` is exactly what a build rewrites and exactly
   * what must not be dropped when it holds tracked source: a tracked file left out would
   * make `git status` in the copy report a deletion the worker never made. Inside a git
   * repository the entry is therefore honoured only when git reports the path ignored *and*
   * no tracked file lives under it. Outside one there is no tracked source to lose, so the
   * entry applies as written.
   *
   * @param {string} original - the repository being copied.
   * @param {string} relPath - the matched path, relative to the copied top.
   * @returns {{omit: boolean, reason?: string}} whether to leave it out, and why not when not.
   */
  #excludeDecision(original, relPath) {
    if (!isGitWorkTree(original)) return { omit: true }
    // A nested repository owns its own index and ignore rules, so both questions are asked
    // where the path really lives, not in the top repository that merely contains it.
    const repo = enclosingRepository(original, relPath)
    const rel = relative(repo, join(original, relPath)).split(sep).join('/')
    // A directory rule such as `node_modules/` does not match a path that does not exist yet
    // when it is spelled without the slash, and a `slotSetup` keep path is usually exactly
    // that: configured before the first build created it. The slash variant is only tried as
    // a fallback where it can mean a directory: a missing path (which a later build may
    // create as one) or an existing directory. A file of the same name is not a directory
    // and a `dir/` rule does not ignore it, so the slash variant must not be tried for it —
    // `git check-ignore cache/` answers "ignored" for a plain FILE named `cache`. A symlink
    // is not a directory here either: `lstat` does not follow it.
    let directoryOnly = true
    try {
      directoryOnly = lstatSync(join(original, relPath)).isDirectory()
    } catch {
      // Missing: the path may well become a directory, so the slash variant applies.
    }
    if (!gitCheckIgnore(repo, rel) && !(directoryOnly && gitCheckIgnore(repo, `${rel}/`))) {
      return { omit: false, reason: 'it is not ignored' }
    }
    if (gitTracksUnder(repo, rel)) return { omit: false, reason: 'git tracks files there' }
    return { omit: true }
  }

  /**
   * Create the per-slot directories the configured `slotEnv` entries point at.
   *
   * Called from `prepare` after the slot has been emptied (which preserves `.flash-cache`)
   * and before anything is recorded, so the directories exist for the runtime and their
   * contents are ignored by git rather than reported as the worker's work. With no `slotEnv`
   * configured nothing is created, so an ordinary slot stays exactly as empty as before.
   *
   * @param {Slot} slot - the slot being prepared.
   * @returns {void}
   */
  #createSlotEnv(slot) {
    if (Object.keys(this.slotEnv).length === 0) return
    for (const spec of Object.values(this.slotEnv)) {
      // A port entry reserves a number, not a directory: there is nothing to create.
      if (spec.kind === 'port') continue
      mkdirSync(join(slot.dir, spec.kind === 'home' ? SLOT_HOME : SLOT_CACHE, spec.segment), { recursive: true })
    }
  }

  /**
   * The environment one slot's worker boots with, resolved fresh from `slot.dir`.
   *
   * The runtime is rooted at `slot.dir`, so directory paths are stable for the life of the
   * slot; `retire` gives the slot a new directory and the next boot resolves new paths. A
   * `port:` entry resolves from `slot.id` alone, so it is stable across `retire` too. A
   * fresh object is returned every call, so a runtime cannot mutate the pool's settings.
   *
   * @param {Slot} slot - the slot the worker will run in.
   * @returns {Record<string, string>} ENV_NAME to absolute path or decimal port; empty when
   *   none is configured.
   */
  slotEnvFor(slot) {
    const env = {}
    for (const [name, spec] of Object.entries(this.slotEnv)) {
      if (spec.kind === 'port') {
        env[name] = String(spec.base + slot.id * spec.stride)
        continue
      }
      env[name] = join(slot.dir, spec.kind === 'home' ? SLOT_HOME : SLOT_CACHE, spec.segment)
    }
    return env
  }

  /**
   * The short digest that keys one scope's setup cache.
   *
   * A call scoped to a nested repository is a different tree with its own build output, so
   * its kept paths and stamps must not be confused with the root's: the outer repository's
   * `node_modules` in the slot would otherwise be handed to the nested copy, and the root's
   * stamp would skip the nested setup as already run. The whole-root scope keeps the
   * historical layout with no digest segment.
   *
   * @param {string | undefined} scope - a repository path relative to the service root.
   * @returns {string} a 12-hex-character digest, or `''` for the root.
   */
  #scopeDigest(scope) {
    if (scope === undefined || scope === '') return ''
    return createHash('sha256').update(scope).digest('hex').slice(0, 12)
  }

  /**
   * The directory a step's kept paths wait in while the slot is idle.
   *
   * @param {Slot} slot - the slot.
   * @param {number} index - the step's index.
   * @param {string} [scope] - the scope the kept copy belongs to; defaults to the slot's
   *   current one. `#stashKeepPaths` runs before `prepare` changes it, so the default is
   *   the scope the copy being emptied was made with.
   * @returns {string} the keep directory for that step and scope.
   */
  #keepRoot(slot, index, scope = slot.scope) {
    const digest = this.#scopeDigest(scope)
    const base = digest === '' ? [SLOT_CACHE, SETUP_KEEP_DIR] : [SLOT_CACHE, SETUP_KEEP_DIR, digest]
    return join(slot.dir, ...base, String(index))
  }

  /**
   * The stamp file that records the inputs a step last ran with, for one scope.
   *
   * @param {Slot} slot - the slot.
   * @param {number} index - the step's index.
   * @param {string} [scope] - the scope the stamp belongs to; defaults to the slot's current one.
   * @returns {string} the stamp path for that step and scope.
   */
  #stampPath(slot, index, scope = slot.scope) {
    const digest = this.#scopeDigest(scope)
    const base = digest === '' ? [SLOT_CACHE, SETUP_STAMP_DIR] : [SLOT_CACHE, SETUP_STAMP_DIR, digest]
    return join(slot.dir, ...base, `${String(index)}.stamp`)
  }

  /**
   * Whether one kept path may be moved for this particular copy.
   *
   * The startup check asks the service root, which is all a pool knows before a call names
   * its scope. A call in a nested repository has its own ignore rules, so the question is
   * asked again where the path really lives: moving a tracked directory out of the copy
   * would make the worker see its deletion, and moving the cache over it would replace the
   * caller's source in the copy with a stale build.
   *
   * @param {Slot} slot - the prepared slot.
   * @param {string} relPath - the path relative to the copy's repository.
   * @returns {boolean} true when git ignores the path there and tracks nothing under it.
   */
  #keepAllowed(slot, relPath) {
    const decision = this.#excludeDecision(slot.repoDir, relPath)
    if (decision.omit) return true
    this.log(`not moving the kept path ${relPath} for this copy: ${decision.reason ?? 'it is not ignored'}`)
    return false
  }

  /**
   * Whether a kept path is physically inside the copy, so the host may move it.
   *
   * `#keepAllowed` asks git (or, outside a work tree, answers without git at all) whether
   * the path may be left out. That says nothing about where the path really is: with
   * `node_modules` a symlink to a directory outside the copy, `node_modules/sub` is
   * "ignored" and a host `rename` would move files out of the caller's tree — or, on a
   * restore, `rm` them there. A symlink anywhere above the path redirects the move, so the
   * parent's real path must lie inside the copy's real path, and the kept path itself must
   * not be a symlink (`lstat`, which does not follow the final component).
   *
   * @param {string} repoDir - the copy's repository.
   * @param {string} relPath - the kept path, relative to `repoDir`.
   * @returns {boolean} true when moving it can only touch the copy.
   */
  #keepPathInCopy(repoDir, relPath) {
    const full = join(repoDir, relPath)
    let info
    try {
      info = lstatSync(full)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.log(`not moving the kept path ${relPath}: it could not be inspected (${messageOf(error)})`)
        return false
      }
      // A missing path is fine for a restore target: it is created inside the copy.
    }
    if (info?.isSymbolicLink()) {
      this.log(`not moving the kept path ${relPath}: it is a symlink, so moving it would move whatever it names`)
      return false
    }
    let real
    try {
      real = realpathSync(repoDir)
    } catch (error) {
      this.log(`not moving the kept path ${relPath}: the copy could not be resolved (${messageOf(error)})`)
      return false
    }
    // A restore target's parent may not exist yet; the deepest existing ancestor is what a
    // recursive `mkdir` would follow, and that has to be inside the copy.
    let parent = dirname(full)
    for (;;) {
      try {
        const realParent = realpathSync(parent)
        if (isWithin(real, realParent)) return true
        this.log(`not moving the kept path ${relPath}: its parent resolves to ${realParent}, outside the copy`)
        return false
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          this.log(`not moving the kept path ${relPath}: its parent could not be resolved (${messageOf(error)})`)
          return false
        }
        const up = dirname(parent)
        if (up === parent) {
          this.log(`not moving the kept path ${relPath}: its parent is not inside the copy`)
          return false
        }
        parent = up
      }
    }
  }

  /**
   * Move a step's kept paths out of the copy and back into the slot cache.
   *
   * Called before anything empties the slot (`prepare`'s own `emptyDirectory` and
   * `discard`), because `.flash-cache` is deliberately preserved across calls and the copy
   * is not. A path the worker deleted is simply absent; the next setup notices that and
   * rebuilds it.
   *
   * @param {Slot} slot - the slot whose copy is about to be emptied.
   * @returns {void}
   */
  #stashKeepPaths(slot) {
    if (this.slotSetup.length === 0 || slot.repoDir === undefined) return
    for (const [index, step] of this.slotSetup.entries()) {
      for (const relPath of step.keep) {
        const source = join(slot.repoDir, relPath)
        if (!existsSync(source) || !this.#keepPathInCopy(slot.repoDir, relPath) || !this.#keepAllowed(slot, relPath)) continue
        const target = join(this.#keepRoot(slot, index), relPath)
        try {
          mkdirSync(dirname(target), { recursive: true })
          // A stale copy in the cache would make `rename` fail with ENOTEMPTY; the copy in
          // the slot is the newer one, so it wins.
          rmSync(target, { recursive: true, force: true })
          renameSync(source, target)
        } catch (error) {
          this.log(`could not move the kept path ${relPath} back into the slot cache: ${messageOf(error)}`)
        }
      }
    }
  }

  /**
   * Move a step's kept paths from the slot cache into the copy.
   *
   * @param {Slot} slot - the prepared slot.
   * @param {number} index - the step's index.
   * @param {object} step - the step.
   * @returns {number} how many paths were moved.
   */
  #restoreKeepPaths(slot, index, step) {
    let moved = 0
    for (const relPath of step.keep) {
      const source = join(this.#keepRoot(slot, index), relPath)
      if (!existsSync(source) || !this.#keepAllowed(slot, relPath)) continue
      // The target is in the copy, where a symlinked parent would turn the restore's `rm`
      // and `rename` into writes outside it; the same physical check as the stash applies.
      if (!this.#keepPathInCopy(slot.repoDir, relPath)) continue
      const target = join(slot.repoDir, relPath)
      try {
        mkdirSync(dirname(target), { recursive: true })
        // The copy excluded this path, so anything here is a leftover of a copy that did
        // not honour the exclusion; the slot's own kept copy is the one that counts.
        rmSync(target, { recursive: true, force: true })
        renameSync(source, target)
        moved += 1
      } catch (error) {
        this.log(`could not restore the kept path ${relPath} into the copy: ${messageOf(error)}`)
      }
    }
    return moved
  }

  /**
   * The fingerprint a setup step runs against.
   *
   * The argv, the platform, the call's scope and the content of every declared input (a
   * fixed marker when the file is missing) are hashed together. Nothing else is: a step
   * whose output changed on disk but whose inputs did not has nothing to redo, which is
   * the point.
   *
   * @param {Slot} slot - the prepared slot.
   * @param {object} step - the step.
   * @returns {string} the hex digest.
   */
  #setupStamp(slot, step) {
    const hash = createHash('sha256')
    hash.update(`flash-slot-setup\0${process.platform}\0${slot.scope ?? ''}\0${JSON.stringify(step.run)}\0`)
    for (const input of step.inputs) {
      hash.update(`input\0${input}\0`)
      let content
      try {
        content = readFileSync(join(slot.repoDir, input))
      } catch (error) {
        // "Missing" is a state worth re-running for when the file appears, so it gets a
        // marker of its own rather than being skipped.
        content = Buffer.from(error?.code === 'ENOENT' ? '\0missing\0' : `\0unreadable:${String(error?.code ?? '')}\0`)
      }
      hash.update(content)
    }
    return hash.digest('hex')
  }

  /**
   * Run one setup step, asynchronously, with its output's tail kept for a failure.
   *
   * `spawn`, never `spawnSync`: the MCP server must keep answering status calls and sending
   * progress heartbeats while `uv sync` runs. No shell is involved, so the argv is the argv;
   * on Windows a `.cmd` program therefore needs `["cmd", "/c", ...]` explicitly.
   *
   * @param {object} step - the step to run.
   * @param {string} repoDir - the copy's repository, the working directory.
   * @param {Record<string, string>} slotEnv - the slot's environment, on top of `process.env`.
   * @param {AbortSignal} [signal] - the call's cancellation.
   * @returns {Promise<void>} resolves when the step exits zero.
   * @throws {IsolationError} with code `SETUP_FAILED` on a non-zero exit, a spawn failure, a
   *   timeout or a cancellation.
   */
  #runSetupStep(step, repoDir, slotEnv, signal) {
    const label = `slot setup ${JSON.stringify(step.run)}`
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new IsolationError(`${label} was cancelled before it started`, 'SETUP_FAILED'))
        return
      }
      let child
      try {
        child = spawn(step.run[0], step.run.slice(1), {
          cwd: repoDir,
          env: { ...process.env, ...slotEnv },
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          // Its own process group, so a timeout or a cancel can stop everything the step
          // started: `uv sync` and `bun install` run children of their own, and killing only
          // the direct process left them writing into the copy and holding its pipes open.
          detached: process.platform !== 'win32',
        })
      } catch (error) {
        reject(new IsolationError(`${label} could not start: ${messageOf(error)}`, 'SETUP_FAILED'))
        return
      }
      let output = ''
      const append = (chunk) => {
        output = (output + chunk.toString()).slice(-SETUP_OUTPUT_TAIL_BYTES)
      }
      child.stdout?.on('data', append)
      child.stderr?.on('data', append)
      let settled = false
      let timedOut = false
      let aborted = false
      let closeTimer
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(closeTimer)
        signal?.removeEventListener?.('abort', onAbort)
        if (error === undefined) resolve()
        else reject(error)
      }
      const tail = () => {
        const text = output.trim()
        return text.length === 0 ? '' : `\n--- last output ---\n${text}`
      }
      const killTree = () => {
        if (process.platform === 'win32') {
          try {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
          } catch {
            // Fall through to the direct kill below.
          }
          child.kill('SIGKILL')
          return
        }
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
      const timer = setTimeout(() => {
        timedOut = true
        killTree()
      }, step.timeoutSeconds * 1000)
      const onAbort = () => {
        aborted = true
        killTree()
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })
      // `addEventListener` cannot cover an abort that landed between the check above and
      // this line, and a signal already aborted must still kill the child.
      if (signal?.aborted === true) onAbort()
      // A kill issued before the OS process exists does nothing; repeat it once it does.
      child.on('spawn', () => {
        if (timedOut || aborted) killTree()
      })
      child.on('error', (error) => {
        finish(new IsolationError(`${label} could not start: ${messageOf(error)}${tail()}`, 'SETUP_FAILED'))
      })
      const settle = (code, killedBy) => {
        if (timedOut) {
          finish(new IsolationError(`${label} timed out after ${String(step.timeoutSeconds)} s${tail()}`, 'SETUP_FAILED'))
          return
        }
        if (aborted) {
          finish(new IsolationError(`${label} was cancelled${tail()}`, 'SETUP_FAILED'))
          return
        }
        if (code !== 0) {
          const how = code === null ? `was killed by ${String(killedBy)}` : `failed with exit code ${String(code)}`
          finish(new IsolationError(`${label} ${how}${tail()}`, 'SETUP_FAILED'))
          return
        }
        finish()
      }
      child.on('close', (code, killedBy) => {
        clearTimeout(closeTimer)
        settle(code, killedBy)
      })
      // The step's own exit code is the outcome that matters. A step that deliberately
      // leaves a background child running hands that child its stdout/stderr pipes, so
      // `close` can be minutes away; waiting for it used to report a successful step as a
      // timeout. `exit` settles the step, and the pipes get a short grace period only to
      // collect the output tail. Nothing is killed here: the step meant to leave that child.
      child.on('exit', (code, killedBy) => {
        closeTimer = setTimeout(() => settle(code, killedBy), SETUP_CLOSE_WAIT_MS)
      })
    })
  }

  /**
   * Run the repository's setup steps in a prepared slot, and make what they wrote the base.
   *
   * The steps belong after `prepare`'s copy and `source: "head"` reset and before the base
   * is recorded, so an editable install's `.pth` files name the copy and a generated file is
   * part of what the copy started with rather than the worker's change. `prepare` stays
   * synchronous and records a base first — many callers and tests rely on that — and this
   * method re-records it after a step ran; the extra `commit-tree` is cheap next to a copy.
   *
   * A step is skipped when its stamp matches and its kept paths are present. Kept paths are
   * restored from the slot cache before the check, and stay in the copy for the worker;
   * `discard` and the next `prepare` move them back. A step whose `keep` list is empty runs
   * on every call (`'nothing is kept between calls'`): nothing it wrote survives the copy
   * being emptied, so its stamp cannot stand for output that is no longer there. A step
   * whose output instead lives in a `cache:` `slotEnv` folder can keep nothing and accept
   * the re-run, which is then fast.
   *
   * @param {Slot} slot - a slot `prepare` just filled.
   * @param {object} [options] - run settings.
   * @param {AbortSignal} [options.signal] - the call's cancellation.
   * @param {(run: string[]) => void} [options.onStep] - called before each step that runs, so
   *   the caller can say what the slot is doing.
   * @returns {Promise<{run: string[], ran: boolean, ms: number, reason: string}[] | undefined>}
   *   one entry per configured step, or undefined when there are none or they are not allowed.
   * @throws {IsolationError} with code `SETUP_FAILED` when a step fails, times out or is cancelled.
   */
  async runSetup(slot, { signal, onStep } = {}) {
    if (this.slotSetup.length === 0 || !this.slotSetupAllowed) return undefined
    if (slot.repoDir === undefined) return undefined
    const results = []
    let ranAny = false
    let restoredAny = false
    for (const [index, step] of this.slotSetup.entries()) {
      const moved = this.#restoreKeepPaths(slot, index, step)
      if (moved > 0) restoredAny = true
      const stampPath = this.#stampPath(slot, index)
      let previous
      try {
        previous = readFileSync(stampPath, 'utf8').trim()
      } catch {
        // No stamp means this step has never run in this slot.
      }
      const stamp = this.#setupStamp(slot, step)
      const keptMissing = step.keep.some((relPath) => !existsSync(join(slot.repoDir, relPath)))
      let reason
      // A step that keeps nothing leaves nothing to restore: the next copy is made without
      // whatever it wrote, so a matching stamp would skip work whose output is not there.
      // Such a step runs every call. A step whose output lives in a `cache:` slotEnv folder
      // can list nothing in keep and accept the re-run, which is then fast.
      if (step.keep.length === 0) reason = 'nothing is kept between calls'
      else if (previous === undefined) reason = 'first run in this slot'
      else if (previous !== stamp) reason = 'inputs changed'
      else if (keptMissing) reason = 'kept path missing'
      if (reason === undefined) {
        results.push({ run: [...step.run], ran: false, ms: 0, reason: 'stamp matched' })
        continue
      }
      if (signal?.aborted === true) {
        throw new IsolationError(`slot setup ${JSON.stringify(step.run)} was cancelled before it started`, 'SETUP_FAILED')
      }
      onStep?.(step.run)
      const started = Date.now()
      try {
        await this.#runSetupStep(step, slot.repoDir, this.slotEnvFor(slot), signal)
      } catch (error) {
        // A stamp is a promise that the step's output is current; a failure must not leave
        // one behind, or the next call would skip a step that never finished.
        rmSync(stampPath, { force: true })
        throw error
      }
      const ms = Date.now() - started
      mkdirSync(dirname(stampPath), { recursive: true })
      writeFileSync(stampPath, `${stamp}\n`)
      ranAny = true
      results.push({ run: [...step.run], ran: true, ms, reason })
    }
    if (ranAny || restoredAny) {
      // Whatever the setup wrote — tracked or ignored — is where this call starts. Recording
      // it again keeps it out of the worker's patch and out of the ignored-paths report.
      if (isGitWorkTree(slot.repoDir)) {
        try {
          this.#recordBase(slot)
        } catch (error) {
          slot.base = null
          slot.baseReason = `the base state could not be recorded after the slot setup: ${messageOf(error)}`
          this.log(slot.baseReason)
        }
      }
    }
    return results
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
    slot.ignoredFiles = undefined
    slot.scope = undefined
    slot.repoDir = undefined
    this.log(`retired ${orphan} in place: its session may still be writing there; the slot moved to ${nextDir}`)
  }

  /**
   * Read what the worker changed, and store it as a patch a later apply can use.
   *
   * @param {Slot} slot - the slot the worker ran in.
   * @param {object} [options] - patch options.
   * @param {number} [options.diffChars] - clip the returned diff to whole file sections within this many characters.
   * @param {boolean} [options.store] - write the patch and its record; false for apply "discard",
   *   which reports the change without keeping it.
   * @returns {Change} the change, ready to be projected into a tool result.
   */
  collect(slot, { diffChars = 20000, store = true } = {}) {
    const change = this.#collect(slot, { diffChars, store })
    // Every call that stored something is the moment to check the cap. A discard stored
    // nothing, so there is nothing to trim for.
    if (store) {
      try {
        this.trim()
      } catch (error) {
        this.log(`trim failed: ${messageOf(error)}`)
      }
    }
    return change
  }

  /** `collect` without the trim. @param {Slot} slot @param {{diffChars: number, store: boolean}} options @returns {Change} */
  #collect(slot, { diffChars, store = true }) {
    // A slot prepared for one nested repository keeps its git state there, not at the top.
    const repoDir = slot.repoDir ?? slot.dir
    const scope = slot.scope ?? ''
    if (slot.base === null) {
      return {
        available: false,
        reason: slot.baseReason ?? 'no base state was recorded for this call, so no diff could be computed',
        filesChanged: [],
        ignored: [],
        ignoredChanged: [],
        diffstat: '',
        diff: '',
        diffChars: 0,
        diffOmitted: [],
      }
    }
    try {
      git(['add', '-A'], repoDir)
      const full = git(['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', slot.base], repoDir)
      const diffstat = git(['diff', '--cached', '--stat', '--no-color', slot.base], repoDir)
      const filesChanged = nameStatusRecords(repoDir, slot.base)
      // Work that git ignores is work the patch cannot carry. It is reported rather
      // than silently dropped: a caller told "no change" while the worker wrote a
      // whole build directory has been misled, not informed. A path that already
      // existed at the base is not new, so it is compared against the recorded facts
      // instead: a rewritten or deleted ignored file is just as invisible to the patch.
      const ignored = ignoredPaths(repoDir).filter((entry) => !(slot.ignoredBase ?? []).includes(entry))
      const ignoredChanged = ignoredChangedFiles(repoDir, slot.ignoredFiles)
      // The diff is clipped at a file boundary: a caller can read every line it holds,
      // and `diffOmitted` names what is not there. The whole patch is what `apply` uses.
      const clipped = clipPatch(full, diffChars)
      const change = {
        available: true,
        filesChanged,
        ignored,
        ignoredChanged,
        diffstat: diffstat.trim(),
        diff: clipped.diff,
        diffChars: full.length,
        diffOmitted: clipped.diffOmitted,
        stored: store,
      }
      // apply "discard" reports the change but keeps nothing: the tree it ran in is
      // emptied afterwards, so writing a patch (or a record) here would be the only
      // remaining copy of work nobody asked to keep.
      if (!store) return change
      // The record travels with the patch, so a restarted service can still tell which
      // repository the patch was computed for and whether it has already been applied.
      const patchId = `flash-${randomUUID()}`
      const patchPath = join(this.patchDir, `${patchId}.patch`)
      const metaPath = join(this.patchDir, `${patchId}.json`)
      // The patch directory is shared with sibling services and the startup prune, so
      // it is recreated defensively: writing a finished call's patch must not fail
      // because a concurrent sweep decided this digest looked empty.
      mkdirSync(this.patchDir, { recursive: true })
      // Write order is a commit protocol: patch, then the blobs a merge needs, then the
      // record. A crash before the record leaves artefacts with no `.json` to reference
      // them, and `prunePatches` reclaims exactly those once they are old enough; writing
      // the record first would instead leave a record whose patch does not exist.
      writeFileSync(patchPath, full)
      // The copy is emptied after this call, so the base blobs have to be saved now; a
      // failure is logged and the patch is stored without them.
      const preimage = savePreimageBlobs(repoDir, slot.base, this.patchDir, patchId, this.log)
      const record = {
        patchId,
        patchPath,
        metaPath,
        storeDir: this.patchDir,
        root: this.root,
        scope,
        base: slot.base,
        filesChanged,
        diffstat: diffstat.trim(),
        createdAt: Date.now(),
        appliedAt: null,
      }
      if (preimage !== undefined) record.preimage = preimage
      // The record is the commit point: until it lands, the patch and its blobs are
      // unreferenced and a prune may reclaim them.
      this.#writeMeta(record)
      this.patches.set(patchId, record)
      return { ...change, patchId, patchPath, scope }
    } catch (error) {
      return {
        available: false,
        reason: `the change could not be read: ${error.message}`,
        filesChanged: [],
        ignored: [],
        ignoredChanged: [],
        diffstat: '',
        diff: '',
        diffChars: 0,
        diffOmitted: [],
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
   * The plain apply is tried first and always leaves the index alone. A patch whose
   * context moved — another session edited or committed to the same lines while the worker
   * ran — no longer applies that way, so `threeWay` merges it in a scratch repository and
   * writes the result back. Both paths leave the caller's index and HEAD untouched: plain
   * apply runs without `--index`, and the merge happens in a throwaway repository that
   * borrows objects read-only through `objects/info/alternates`.
   *
   * `git apply --3way` was rejected for two measured reasons. It implies `--index`, so a
   * clean merge stages its result in the caller's index and refuses any target file with
   * unstaged changes (`error: f.txt: does not match index`) — and parallel sessions with
   * uncommitted work in one tree are exactly when threeWay is needed. And the preimage blobs
   * it would merge through are the copy's base, recorded from the caller's working tree:
   * when the caller's file was uncommitted those blobs exist only in the disposable copy,
   * which is emptied after the call, so no 3-way merge can find its base. `collect` and
   * `salvageSlot` therefore save the preimage blobs beside the patch (see
   * `savePreimageBlobs`), and the merge rebuilds the base from them.
   *
   * `threeWay` works outside a git work tree: the scratch repository needs no caller
   * repository, only the saved blobs.
   *
   * @param {object} options - the patch to apply.
   * @param {string} options.patchId - a patch id from an earlier call.
   * @param {boolean} [options.dryRun] - check that it applies without changing anything.
   * @param {boolean} [options.force] - apply again even though the record says it was applied.
   * @param {boolean} [options.threeWay] - merge it when the plain apply fails.
   * @returns {{patchId: string, applied: boolean, dryRun: boolean, root: string, filesChanged: string[], diffstat: string, threeWay: boolean, conflicts: string[], indexTouched: boolean, note?: string}} the outcome.
   * @throws {Error} when the patch is unknown, belongs to another repository, was already
   *   applied, does not apply, or its base is not available for a three-way merge.
   */
  apply({ patchId, dryRun = false, force = false, threeWay = false }) {
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
    // A patch computed inside one nested repository applies inside that repository.
    const target = record.scope ? join(this.root, record.scope) : this.root
    const filesChanged = plainPaths(record.filesChanged)
    const diffstat = (record.diffstat ?? '').trim()
    const outcome = this.#applyTo(record, { target, dryRun, threeWay, mark: !dryRun })
    return { patchId, dryRun, root: target, filesChanged, diffstat, ...outcome }
  }

  /**
   * Leave a stored patch in a call's disposable copy, so this call continues from it.
   *
   * A worker that stopped partway leaves a patch; starting the next call from that patch is
   * cheaper than describing the state again. The record's base was recorded by `prepare`
   * *before* this runs, so the change this call later collects contains the base patch's
   * change plus the new work — it replaces the old patch instead of adding to it.
   *
   * The patch lands in the copy, never in the caller's tree: the plain apply is tried in the
   * copy first, then the same index-free three-way merge `apply` uses, with the copy as its
   * target. Conflicts are therefore not an error here — the copy holds conflict markers in
   * `conflicts` and the worker is told to resolve them — and the record is deliberately NOT
   * marked applied: it reached a throwaway tree, not the caller's.
   *
   * @param {Slot} slot - a slot `prepare` has already filled.
   * @param {string} patchId - the stored patch to continue from.
   * @returns {{patchId: string, applied: true, threeWay: boolean, conflicts: string[],
   *   filesChanged: string[]}} what landed in the copy.
   * @throws {Error} when the patch is unknown, belongs to another root or scope, its file is
   *   gone, or its base is unavailable for the merge the copy needs.
   */
  applyBasePatch(slot, patchId) {
    const record = this.#lookupPatch(patchId)
    if (!existsSync(record.patchPath)) throw new Error(`the patch file for ${patchId} is gone (${record.patchPath})`)
    // The copy was made from the scope the call's cwd resolves to, and a patch only means
    // the same edit inside the repository it was computed in.
    const scope = slot.scope ?? ''
    const patchScope = record.scope ?? ''
    if (patchScope !== scope) {
      const where = (value) => (value === '' ? 'the service root' : `the repository ${value}`)
      throw new Error(
        `patch ${patchId} was computed for ${where(patchScope)}, but this call's cwd resolves to ${where(scope)}; ` +
          'a base patch must come from the same repository as the call',
      )
    }
    const target = slot.repoDir ?? slot.dir
    let outcome
    try {
      // Always through the merge fallback: the caller's tree may have moved on since the base
      // patch was collected, and a plain apply is only refused when its context no longer fits.
      outcome = this.#applyTo(record, { target, threeWay: true, mark: false })
    } catch (error) {
      throw new Error(
        `${messageOf(error)} Continuing from this patch is not possible in the copy. ` +
          `Pass source: "head" to start from the last commit instead, or apply patch ${patchId} to your tree with flash_apply first.`,
      )
    }
    // The copy's state now includes the base patch's change, so what it started with changed
    // too: an ignored path the patch created is part of that state, not the worker's work.
    this.#recordIgnored(slot, target)
    // The copy holds the change whether the patch applied outright, the merge wrote something,
    // or the merge found the copy already equal to its result. Conflict markers are reported
    // as conflicts, and the worker is told to resolve them.
    return {
      patchId: record.patchId,
      applied: true,
      threeWay: outcome.threeWay === true,
      conflicts: outcome.conflicts ?? [],
      filesChanged: plainPaths(record.filesChanged),
    }
  }

  /**
   * Apply one patch to one directory: the plain apply first, the three-way merge on request.
   *
   * The target is a parameter because two different trees take this path: the caller's tree
   * (`apply`) and a call's disposable copy (`applyBasePatch`). Only `mark` tells them apart —
   * it records the apply on the patch record, which belongs to the caller's tree alone.
   *
   * @param {object} record - the patch record to apply.
   * @param {object} options - where, how, and whether to record it.
   * @param {string} options.target - the directory the patch applies into.
   * @param {boolean} [options.dryRun] - check that it applies without changing anything.
   * @param {boolean} [options.threeWay] - merge it when the plain apply fails.
   * @param {boolean} [options.mark] - record the apply on the patch record.
   * @returns {{applied: boolean, threeWay: boolean, conflicts: string[], indexTouched: false, note?: string}} the outcome.
   * @throws {Error} when the patch does not apply, or its base is unavailable for a merge.
   */
  #applyTo(record, { target, dryRun = false, threeWay = false, mark = false }) {
    // Without `--index` the caller's index is left alone; only the working tree moves.
    // Outside a repository the target must not discover one enclosing it: paths in the
    // patch would then be read relative to that repository's top instead of to the target.
    const workTree = isGitWorkTree(target)
    const env = workTree ? undefined : { ...process.env, GIT_CEILING_DIRECTORIES: dirname(target) }
    const applyArgs = ['apply', '--whitespace=nowarn']
    const check = dryRun ? ['--check'] : []
    try {
      git([...applyArgs, ...check, record.patchPath], target, env)
    } catch (plainError) {
      if (!threeWay) {
        throw new Error(
          `${messageOf(plainError)}. The patch is at ${record.patchPath}; retry with threeWay: true to merge it.`,
        )
      }
      return this.#threeWayMerge(record, target, { dryRun, plainError, mark })
    }
    if (!dryRun && mark) this.#markApplied(record)
    return { applied: !dryRun, threeWay: false, conflicts: [], indexTouched: false }
  }

  /**
   * Record that a patch reached the caller's tree, so a second apply is refused.
   * @param {object} record - the patch record to mark and store.
   * @returns {void}
   */
  #markApplied(record) {
    record.appliedAt = Date.now()
    this.#writeMeta(record)
    this.patches.set(record.patchId, record)
  }

  /**
   * Merge a patch into the caller's tree without an index, in a scratch repository.
   *
   * The merge is between two synthetic children of the patch's base: "theirs" is the patch
   * applied to that base, and "ours" is the caller's tree over the same base. `merge-tree`
   * then merges the two and, with `--write-tree`, hands back a tree that already carries
   * conflict markers, so there is nothing to resolve and nothing to stage. The caller's
   * repository is only ever read (its objects are borrowed through the scratch
   * repository's alternates) and only ever written by the final write-back.
   *
   * @param {object} record - the patch record being applied.
   * @param {string} target - the tree the patch is applied to: the caller's tree, or a call's
   *   disposable copy when a base patch is being planted there.
   * @param {object} options - the run, the failure to report alongside, and whether to record it.
   * @param {boolean} options.dryRun - run the merge but skip the write-back.
   * @param {Error} options.plainError - the plain apply's failure, folded into ours.
   * @param {boolean} [options.mark] - record the apply on the patch record, which only an
   *   apply into the caller's tree may do.
   * @returns {{threeWay: true, applied: boolean, conflicts: string[], indexTouched: false, note?: string}} the outcome.
   * @throws {Error} when the base is unavailable, git is too old, or the merge errors.
   */
  #threeWayMerge(record, target, { dryRun, plainError, mark = false }) {
    const patchId = record.patchId
    const unavailable =
      `The base of patch ${patchId} is not available for a three-way merge ` +
      '(it was made before blob saving existed, or saving failed).'
    if (!Array.isArray(record.preimage)) {
      throw new Error(`${messageOf(plainError)}. ${unavailable} The patch is at ${record.patchPath}.`)
    }
    requireMergeTree(target)
    const scratch = mkdtempSync(join(this.stateDir, 'merge-'))
    const env = { ...process.env }
    // The scratch repository is selected by its working directory, not by the caller's
    // environment: a `GIT_DIR` or object-directory override inherited from the service would
    // point every command here at the caller's repository instead.
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
      delete env[name]
    }
    try {
      git(['init', '-q'], scratch, env)
      // Blobs from either side have to resolve: the patch's saved base, and the caller's
      // repository objects when the base was committed there. The scratch repository
      // borrows both read-only, so a merge never writes into either.
      const alternates = []
      const blobs = blobsDirectory(record.storeDir ?? this.patchDir, patchId)
      if (existsSync(blobs)) alternates.push(blobs)
      if (isGitWorkTree(target)) {
        const commonDir = resolve(target, git(['rev-parse', '--git-common-dir'], target).trim())
        alternates.push(join(commonDir, 'objects'))
      }
      if (alternates.length > 0) {
        writeFileSync(join(scratch, '.git', 'objects', 'info', 'alternates'), `${alternates.join('\n')}\n`)
      }
      // Base B: the preimage entries of the patch, and only those. An addition contributes
      // nothing, which is why an add-only patch merges against the empty tree.
      let baseTree
      try {
        for (const entry of record.preimage) {
          // A gitlink is recorded by id alone; its commit lives in the submodule's repository.
          if (entry.mode !== GITLINK_MODE && gitAllowFailure(['cat-file', '-e', entry.blob], scratch, env).status !== 0) {
            throw new Error(`blob ${entry.blob} for ${entry.path} is in neither the saved blobs nor ${target}`)
          }
          git(['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.blob},${entry.path}`], scratch, env)
        }
        baseTree = git(['write-tree'], scratch, env).trim()
      } catch (error) {
        throw new Error(`${messageOf(plainError)}. ${unavailable} ${messageOf(error)}. The patch is at ${record.patchPath}.`)
      }
      const base = git([...COMMIT_CONFIG, 'commit-tree', baseTree, '-m', 'flash base'], scratch, env).trim()
      // Theirs W: the patch was computed against exactly this base, so it applies cleanly.
      git(['read-tree', baseTree], scratch, env)
      git(['apply', '--cached', '--whitespace=nowarn', record.patchPath], scratch, env)
      const theirsTree = git(['write-tree'], scratch, env).trim()
      const theirs = git([...COMMIT_CONFIG, 'commit-tree', theirsTree, '-p', base, '-m', 'flash worker'], scratch, env).trim()
      // Ours O: the caller's own files, at every path the patch touches, over the same base.
      git(['read-tree', baseTree], scratch, env)
      for (const path of touchedPaths(record)) this.#stageCallerPath(scratch, target, path, env)
      const oursTree = git(['write-tree'], scratch, env).trim()
      const ours = git([...COMMIT_CONFIG, 'commit-tree', oursTree, '-p', base, '-m', 'flash caller'], scratch, env).trim()
      const merged = gitAllowFailure(['merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs], scratch, env)
      if (merged.status !== 0 && merged.status !== 1) {
        throw new Error(
          `${messageOf(plainError)}. The three-way merge of ${record.patchPath} failed in a scratch repository: ${merged.stderr.length > 0 ? merged.stderr : merged.stdout}`.trim(),
        )
      }
      // Exit 0 writes the result tree alone; exit 1 writes it, then the conflicted paths
      // up to a blank line, then (suppressed here) the merge messages.
      const [resultTree, ...rest] = merged.stdout.split('\n')
      const conflicts = []
      for (const line of rest) {
        if (line === '') break
        // `--name-only` quotes a non-ASCII path the same way a patch header does; the
        // conflict is reported with the name a caller can match against its own tree.
        conflicts.push(diffPathToken(line))
      }
      const outcome = dryRun ? { written: false, submodules: [] } : this.#writeMergedTree(scratch, target, ours, resultTree, env)
      let note
      // The change is recorded as applied only when something was written. A merge whose
      // result already equals the caller's tree — because the caller already made the same
      // change, say — changed nothing, and marking it applied would refuse a later, real
      // apply. The same goes for a difference that is only submodule pointers, which git's
      // three-way merge does not apply at all. A dry run records nothing by definition.
      if (!dryRun && outcome.written) {
        // Only the caller's tree is recorded: a base patch planted in a copy reached a
        // throwaway tree, and marking it applied would refuse the apply it still deserves.
        if (mark) {
          this.#markApplied(record)
          if (conflicts.length > 0) {
            note =
              'the three-way merge left conflict markers in the working tree; the change is recorded as applied so a second apply is refused'
          }
        }
      } else if (!dryRun) {
        note =
          outcome.submodules.length > 0
            ? `nothing was written: the merge only moves the submodule pointer(s) ${outcome.submodules.join(', ')}, which a three-way merge does not apply`
            : 'nothing was written: the merged result is already the caller’s tree'
      }
      return {
        threeWay: true,
        conflicts,
        indexTouched: false,
        applied: !dryRun && outcome.written,
        ...(note === undefined ? {} : { note }),
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  /**
   * Put the caller's own state for one path into the merge's "ours" tree.
   *
   * The base entry is replaced by whatever the caller has now: a file hashed from disk, a
   * symlink recorded as its link text, or nothing at all when the caller deleted it or
   * replaced it with something that is not a file. A path the caller never had stays absent,
   * which is what makes the worker's addition and rename apply as the only change.
   *
   * The file is hashed from standard input as raw bytes, and `--path` lets git apply the
   * end-of-line normalisation `git add` would, so a blob read out of the caller's tree is
   * comparable to the one the patch records. The scratch repository carries no attribute
   * files, so an attribute-driven filter (a smudge/clean pair such as LFS) is not run here;
   * that only matters for a repository that uses one.
   *
   * @param {string} scratch - the scratch repository.
   * @param {string} target - the caller's tree.
   * @param {string} path - the path, relative to the target.
   * @param {NodeJS.ProcessEnv} env - environment for git.
   * @returns {void}
   */
  #stageCallerPath(scratch, target, path, env) {
    const full = join(target, path)
    let info
    try {
      info = lstatSync(full)
    } catch {
      // The caller no longer has the file; dropping the base entry is what the merge reads
      // as a deletion. It is a no-op when the base never held the path.
      gitAllowFailure(['update-index', '--force-remove', '--', path], scratch, env)
      return
    }
    if (info.isSymbolicLink()) {
      const blob = git(['hash-object', '-w', '--stdin'], scratch, env, readlinkSync(full)).trim()
      git(['update-index', '--add', '--cacheinfo', `120000,${blob},${path}`], scratch, env)
      return
    }
    if (info.isDirectory() && existsSync(join(full, '.git'))) {
      // A submodule checkout: `git add` would record it as a gitlink at the checkout's HEAD,
      // and so does "ours". Dropping it instead would make a worker's pointer move read as a
      // modify/delete conflict, and a worker's removal as a conflict nobody had.
      const head = gitOrEmpty(['rev-parse', '--verify', '-q', 'HEAD'], full)
      if (head !== '') {
        git(['update-index', '--add', '--cacheinfo', `${GITLINK_MODE},${head},${path}`], scratch, env)
        return
      }
    }
    if (!info.isFile()) {
      // The caller's path exists but is neither a regular file nor a symlink — a directory,
      // say, where the base held a file. The caller no longer has that file, so "ours" must
      // drop the base entry. Keeping it (the old `return`) hid a delete-vs-modify from the
      // merge and let the worker's version silently overwrite the caller's directory.
      gitAllowFailure(['update-index', '--force-remove', '--', path], scratch, env)
      return
    }
    const mode = (info.mode & 0o111) !== 0 ? '100755' : '100644'
    const blob = git(['hash-object', '-w', `--path=${path}`, '--stdin'], scratch, env, readFileSync(full)).trim()
    git(['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`], scratch, env)
  }

  /**
   * Write a merged result tree into the caller's working tree.
   *
   * Only the difference between "ours" and the merged tree is written, so an untouched
   * caller file is not rewritten and its timestamp and permissions survive. A deletion is
   * the one status that removes a file; additions and modifications write the result blob.
   * The caller's index and HEAD are not consulted or changed.
   *
   * A merged path can collide with the shape the caller's tree has now: the worker replaced
   * a directory with a file, or the caller replaced a file with a directory. Writing through
   * either is how a raw EISDIR escapes mid-loop with earlier paths already changed. Every
   * write target is therefore checked before the first mutation: a target that is an
   * existing directory may only be replaced when every file under it is one of the merge's
   * own deletions, and every existing parent component that is not a directory must itself
   * be deleted by the merge. A refusal writes nothing.
   *
   * @param {string} scratch - the scratch repository the result tree lives in.
   * @param {string} target - the caller's tree.
   * @param {string} ours - the commit "ours" was committed as.
   * @param {string} resultTree - the merged tree id.
   * @param {NodeJS.ProcessEnv} env - environment for git.
   * @returns {{written: boolean, submodules: string[]}} whether anything was written, and
   *   the submodule pointers the change named (which are never written).
   */
  #writeMergedTree(scratch, target, ours, resultTree, env) {
    const raw = git(['diff-tree', '-r', '--no-renames', '--name-status', '-z', ours, resultTree], scratch, env)
    const fields = raw.split('\0')
    const changes = []
    for (let at = 0; at + 1 < fields.length; at += 2) {
      const status = fields[at]
      const path = fields[at + 1]
      if (status === '' || path === undefined || path === '') continue
      changes.push({ status, path })
    }
    const deletions = new Set(changes.filter((change) => change.status === 'D').map((change) => change.path))
    // Gitlinks are set aside before anything else: a submodule's pointer names a commit, there
    // is no file to write for it, and its path is the submodule's checkout — a directory that
    // the collision checks below must not mistake for one a file replaces, and that the
    // emptied-directory cleanup must never remove.
    const submodules = []
    const writes = []
    for (const change of changes) {
      if (change.status === 'D') continue
      const entry = treeEntry(scratch, resultTree, change.path, env)
      if (entry?.mode === GITLINK_MODE) submodules.push(change.path)
      else if (entry !== undefined) writes.push({ ...change, entry })
    }
    // Every path is checked before the first write, so a refused one cannot leave the
    // caller's tree half-merged.
    for (const { path } of changes) refuseSymlinkParents(target, path)
    for (const { path } of writes) {
      const full = join(target, path)
      let info
      try {
        info = lstatSync(full)
      } catch {
        // Nothing there: the write creates it.
        info = undefined
      }
      if (info?.isDirectory()) {
        const survivors = filePathsUnder(full, target).filter((file) => !deletions.has(file))
        if (survivors.length > 0) {
          throw new Error(
            `the three-way merge would replace the directory ${path} in ${target}, but it holds ${survivors.join(', ')}, ` +
              'which the merge does not delete; refusing to write anything',
          )
        }
      }
      // A parent that exists and is not a directory cannot be written through: the merge
      // must delete it as part of the same change, or there is no safe order.
      let current = target
      const parts = path.split('/')
      for (const part of parts.slice(0, -1)) {
        current = join(current, part)
        let parentInfo
        try {
          parentInfo = lstatSync(current)
        } catch {
          // Missing from here down: mkdir creates real directories.
          break
        }
        if (parentInfo.isDirectory()) continue
        const rel = relative(target, current).split(sep).join('/')
        if (!deletions.has(rel)) {
          throw new Error(
            `the three-way merge would write ${path} through ${rel} in ${target}, which is not a directory it removes; ` +
              'refusing to write anything',
          )
        }
        break
      }
    }
    let written = false
    // Deletions first, so the paths a write replaces are gone before anything is created.
    for (const { status, path } of changes) {
      if (status !== 'D') continue
      // A deleted path that is a directory on disk is a submodule checkout whose gitlink the
      // change removes. Like a moved pointer, it is named rather than acted on: removing a
      // checkout would delete a repository the merge knows nothing about.
      let info
      try {
        info = lstatSync(join(target, path))
      } catch {
        continue
      }
      if (info.isDirectory()) {
        submodules.push(path)
        continue
      }
      rmSync(join(target, path), { force: true })
      written = true
    }
    // A directory whose files were all deleted now makes way for the file at its own path.
    for (const { path } of writes) {
      let info
      try {
        info = lstatSync(join(target, path))
      } catch {
        info = undefined
      }
      if (info?.isDirectory()) rmSync(join(target, path), { recursive: true, force: true })
    }
    for (const { path, entry } of writes) {
      writeResultFile(scratch, target, path, entry.mode, entry.sha, env)
      written = true
    }
    return { written, submodules }
  }

  /**
   * Read a stored patch, whole or as one page, so a caller can review a large change
   * before applying it. Like `apply`, it works on the patch the service stored, not on
   * the possibly-clipped `change.diff` in a result.
   *
   * @param {object} options - which patch, and which slice of it.
   * @param {string} options.patchId - a patch id from an earlier call.
   * @param {string[]} [options.files] - read only these files' sections.
   * @param {number} [options.offset] - character offset into the selected text.
   * @param {number} options.maxChars - the page budget.
   * @returns {{patchId: string, patchPath: string, applied: boolean, filesChanged: string[], diffstat: string, totalChars: number, offset: number, diff: string, files: string[], nextOffset: number | null}} the page.
   * @throws {Error} when the patch is unknown, belongs to another repository, is gone, or
   *   `files` names a file the patch does not contain.
   */
  readPatch({ patchId, files, offset = 0, maxChars }) {
    const record = this.#lookupPatch(patchId)
    if (!existsSync(record.patchPath)) throw new Error(`the patch file for ${patchId} is gone (${record.patchPath})`)
    const diff = readFileSync(record.patchPath, 'utf8')
    const sections = diffSections(diff)
    const known = sections.map((section) => section.path).filter((path) => path !== null)
    let selected = sections
    if (files !== undefined) {
      const wanted = new Set(files)
      const unknown = files.filter((name) => !known.includes(name))
      if (unknown.length > 0) {
        throw new Error(
          `patch ${patchId} does not contain ${unknown.map((name) => JSON.stringify(name)).join(', ')}; ` +
            (known.length === 0 ? 'it changes no files' : `it changes: ${known.join(', ')}`),
        )
      }
      selected = sections.filter((section) => wanted.has(section.path))
    }
    // Offsets are computed on the selected text, so a page and its `nextOffset` mean the
    // same thing whether one file or the whole patch was asked for.
    let at = 0
    const rebased = selected.map((section) => {
      const start = at
      at += section.text.length
      return { start, end: at, path: section.path, text: section.text }
    })
    const text = rebased.map((section) => section.text).join('')
    const page = pageSections(rebased, text, offset, maxChars)
    return {
      patchId,
      patchPath: record.patchPath,
      applied: record.appliedAt !== null && record.appliedAt !== undefined,
      filesChanged: plainPaths(record.filesChanged),
      diffstat: (record.diffstat ?? '').trim(),
      totalChars: text.length,
      offset: page.offset,
      diff: page.diff,
      files: page.files,
      nextOffset: page.nextOffset,
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
      this.#assertScopeSafe(held)
      this.#refreshAppliedAt(held)
      return held
    }
    // A patch written by an old server after this pool loaded its records is not in
    // memory yet. Look in both stores, durable first, so the deferred window does not hide
    // work the caller was told it could still apply.
    const stores = [this.patchDir, ...(this.legacyPatchDir === undefined ? [] : [this.legacyPatchDir])]
    let record
    let metaPath
    for (const store of stores) {
      const candidate = join(store, `${patchId}.json`)
      if (!existsSync(candidate)) continue
      try {
        record = JSON.parse(readFileSync(candidate, 'utf8'))
        metaPath = candidate
        break
      } catch (error) {
        throw new Error(`the record for patch ${patchId} is unreadable: ${messageOf(error)}`)
      }
    }
    if (record === undefined || metaPath === undefined) {
      throw new Error(`no patch ${patchId} is held by this service; patches are kept in ${this.patchDir}`)
    }
    record.metaPath = metaPath
    record.patchPath = join(dirname(metaPath), `${patchId}.patch`)
    record.storeDir = dirname(metaPath)
    if (record.root !== this.root) {
      throw new Error(
        `patch ${patchId} was computed for ${String(record.root)}, not for ${this.root}; patches do not cross repositories`,
      )
    }
    this.#assertScopeSafe(record)
    this.patches.set(patchId, record)
    return record
  }

  /**
   * Refuse a record whose stored `scope` could name a path outside this root.
   *
   * `apply` joins `record.scope` onto `this.root` to find the repository a patch belongs
   * to, so a scope of `../..` would point the write-back anywhere on disk. A record is
   * re-read from the shared patch directory, so it is validated at the moment it is used,
   * with the same rules `readScopeMarker` applies, and refused with a clear error rather
   * than trusted as a path fragment.
   *
   * @param {object} record - the record about to be used.
   * @returns {void}
   * @throws {Error} when the scope escapes the root.
   */
  #assertScopeSafe(record) {
    const scope = record.scope
    if (scope === undefined || scope === '') return
    if (!scopeIsSafe(scope)) {
      throw new Error(
        `patch ${String(record.patchId)} was stored with scope ${JSON.stringify(scope)}, which is not a path inside ${this.root}; refusing to apply it`,
      )
    }
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
   *
   * The directory comes from the record itself, not from `this.patchDir`: while a legacy
   * migration is deferred, the record lives in the old temp store and its update must stay
   * in that same store. Splitting the record from its patch is how a patch becomes
   * unlistable.
   *
   * @param {object} record - the record to store.
   * @returns {void}
   */
  #writeMeta(record) {
    const dir = record.storeDir ?? (typeof record.metaPath === 'string' ? dirname(record.metaPath) : this.patchDir)
    mkdirSync(dir, { recursive: true })
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
    // A kept path belongs to the slot cache, not to the copy that is about to be thrown
    // away; moving it back before emptying is what makes the next call in this slot see it.
    this.#stashKeepPaths(slot)
    emptyDirectory(slot.dir)
    slot.base = null
    slot.scope = undefined
    slot.repoDir = undefined
  }

  /**
   * Remove the slot trees and every orphan they left in place. Stored patches stay: an
   * apply may still be coming.
   */
  close() {
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer)
    for (const slot of this.slots) {
      rmSync(slot.dir, { recursive: true, force: true })
      for (const orphan of slot.orphans) rmSync(orphan, { recursive: true, force: true })
    }
    // Belt and braces: everything above lives under `slots`, so this also catches any
    // orphan a slot no longer names.
    rmSync(join(this.stateDir, 'slots'), { recursive: true, force: true })
  }
}
