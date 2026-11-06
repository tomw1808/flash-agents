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
 * @property {number} id - slot number, stable for the life of the pool. In the default
 *   layout it is the number the pool's lock file claimed, so a second server on one root
 *   starts at the first number no live server holds.
 * @property {string} dir - the disposable tree the worker runs in.
 * @property {number} dirIndex - how many times the slot has been moved to a fresh path.
 * @property {string[]} orphans - trees left in place by `retire`, removed when the pool closes.
 * @property {Set<string>} stoppedOrphans - the orphans whose runtimes were shut down before
 *   `retire`, so their build cache may be moved into the slot's current directory.
 * @property {string} tmpDir - a temp directory inside `dir`, for the worker's TMPDIR.
 * @property {string | null} base - commit this call started from, or null without git.
 * @property {boolean} busy - whether a call currently holds the slot.
 * @property {object} [settings] - the repository settings the call holding it leased with.
 * @property {string[]} [settingsWarnings] - what that call's result must say about them.
 * @property {boolean} [buildCacheEmpty] - whether the call started with a cold build cache.
 * @property {'store' | 'retired-slot'} [buildCacheFrom] - where this call's prepare took the
 *   slot's build cache from, when it took one: the per-root store or the retired tree.
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
 * @property {boolean} stored - whether the patch was written to disk; false for apply "discard"
 *   and for a call that changed no tracked file, which stores no patch.
 * @property {string} [patchId] - id a later `flash_apply` can refer to.
 * @property {string} [patchPath] - where the patch was stored.
 * @property {string[]} [nestedUnread] - nested repositories (relative to the copied
 *   repository) whose changes could not be read and are not in the patch; the copy holding
 *   them should be kept rather than emptied.
 * @property {string[]} [warnings] - one sentence per such repository, for the result.
 */

import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { rm as removeTree } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'

/**
 * The only shape a patch id may have. It is checked before the id is used to build a
 * path, so an id cannot name a different file: `../` in a patch id used to be a way to
 * read any `.patch` on disk.
 */
const PATCH_ID = /^flash-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * A unique prefix of a patch id: at least eight hex digits, with or without the `flash-`
 * prefix, and with the dashes a full uuid carries allowed after the eighth digit — reports
 * and people quote `1a2b3c4d` or `flash-1a2b3c4d-5e6f`, never the whole id. The pattern is
 * still checked before anything is read, so a prefix cannot name a path either; the id is
 * only used to build one after it has been resolved to a full, validated id.
 */
const PATCH_ID_PREFIX = /^(?:flash-)?([0-9a-f]{8}[0-9a-f-]*)$/

/** How many full ids an ambiguous-prefix error names before it says how many there were. */
const PATCH_PREFIX_NAMES = 5

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
 * naming one, and it costs no copy because it lives outside the copied repository. `retire`
 * leaves them with the retired tree, and `trim` moves them into the slot's new directory
 * when that one has none yet (see `#keepRetiredCache`); the dead-owner sweep and `close`
 * remove them with everything else.
 */
const SLOT_CACHE = '.flash-cache'

/**
 * The folder that holds one root's stable slot directories: `<stateBase>/<rootDigest>/slots`.
 *
 * A slot of the default layout sits at a path that depends only on the root and the slot
 * number, so the build cache `prepare` leaves in it is under the same absolute path the next
 * server after a restart gives the same slot. Build tools write absolute paths into their
 * output — SwiftPM's `.build`, CMake's caches, cargo's fingerprints of path dependencies — so
 * a cache that came back at a different path was rebuilt from cold: a user with ten Swift
 * workers lost 20-30 minutes per copy at load 100+. A configured `stateDir` keeps the older
 * `<stateDir>/slots/slot-<id>` layout, which belongs to the deployment that named it.
 */
const SLOTS_DIRECTORY = 'slots'

/**
 * The suffix of the lock file that claims one stable slot: `slots/<n>.lock`.
 *
 * A server takes a slot number by writing a complete lock in a temp file beside it and
 * linking it into place (`link` fails with `EEXIST` and never replaces), so two servers on
 * one root never claim one directory and no reader sees an empty or half-written lock. The
 * file carries the pid, the owner's command line and the per-pool nonce (see
 * `SLOT_LOCK_FORMAT`). The pid and command line decide liveness by the rule `slotHolder`
 * uses, so a lock whose owner is dead, or whose pid was reused by an unrelated process, is
 * taken over by the next server after a log line. A normal shutdown removes the lock and
 * leaves the directory, `.flash-cache` included, for whoever claims the number next.
 */
const SLOT_LOCK_SUFFIX = '.lock'

/**
 * The shape of a slot lock's JSON, one line: `{format, pid, command, instance}`.
 *
 * `command` is the owner *process's* own command line (`process.argv` joined by spaces and
 * normalised, see `normalizeCommandLine`), not the moment the slot was claimed: two servers'
 * pids differ, but a pid reused by an unrelated process runs a different command and must
 * not inherit the dead server's slot. A command line is the same on every restart and in
 * every time zone, unlike a start time that `ps` printed as local time. A lock is written to
 * a unique temp file and `link`ed into place, so a reader never sees an empty or half-written
 * one; a lock that cannot be read as this shape is treated as held within `SLOT_LOCK_GRACE_MS`
 * of its mtime and as dead after that, which is what an older build's `wx` write or a crash
 * between write and close leaves.
 */
export const SLOT_LOCK_FORMAT = 1

/**
 * How long an empty or unparseable slot lock is treated as a live claim.
 *
 * Such a file comes from a crash between creating and completing the write, or from an
 * older build that wrote the lock in place. Sixty seconds is far longer than any legitimate
 * write of one short line and far shorter than the minutes a dead server's slot may sit
 * before the next one looks, so a crash costs at most one wait and never a stolen tree.
 */
const SLOT_LOCK_GRACE_MS = 60_000

/**
 * How much of an owner's command line a slot lock records.
 *
 * `argv` may carry a whole task text, so the recorded line is capped rather than copied
 * into every lock: 4 KB is far longer than a Node server's own invocation and short enough
 * that a lock stays one small line. The recorded value and every live value are capped the
 * same way, so a long command still compares equal to itself.
 */
const SLOT_COMMAND_LINE_LIMIT = 4 * 1024

/**
 * How long a liveness answer is reused for one `(pid, recorded command line)` pair.
 *
 * Reading another process's command line is one file read on Linux and one `ps` or
 * PowerShell child process elsewhere. A sweep asks about every lock in a folder, and
 * `sweepStableSlots`, `lease` and `close` ask again seconds apart; a minute of reuse saves
 * those spawns without ever letting a dead server look alive past the grace an empty lock
 * already has.
 */
const SLOT_LIVENESS_CACHE_MS = 60_000

/**
 * The errors `link` gives on a filesystem that has no hard links.
 *
 * exFAT and FAT32 are common on Windows removable drives, and some SMB shares refuse links
 * too; EPERM is what Windows reports, ENOTSUP/EOPNOTSUPP the Unix mounts, and EXDEV a link
 * across filesystems. On any of them the lock is created with an exclusive `open` instead
 * (see `createSlotLock`).
 */
const SLOT_LOCK_NO_LINK_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'])

/**
 * The suffix of the temp file a lock is written to before it is linked into place.
 * It sits beside the lock, so `link` stays within one filesystem and is atomic.
 */
const SLOT_LOCK_TEMP_MARKER = '.tmp-'

/**
 * How many slot numbers a pool scans at most while claiming its slots. Every number below
 * the limit that a live server holds is skipped, so it has to cover the servers one root runs
 * at once; reaching it stops the scan rather than loop forever on a directory full of live
 * locks, and the pool then falls back to its private state directory (see the constructor).
 */
const SLOT_CLAIM_SCAN_LIMIT = 1024

/**
 * What a retired tree's directory name carries after its slot number:
 * `slots/<n>.retired-<instance>`, and `-<generation>` for a later retire in one pool. The
 * name keeps the tree out of the stable slot's path, whose warm cache the next server of the
 * root still wants, and the generation keeps two retired trees of one slot apart.
 */
const RETIRED_SLOT_MARKER = '.retired-'

/**
 * What a dead server's slot directory is renamed to when its lock is taken over, or when a
 * claim finds a leftover copy under a free number: `slots/<n>.dead-<pid>-<ms>`. Its copy is
 * left for the sweep, which stores whatever the dead worker left uncommitted and then
 * deletes the tree, so the stable name is free.
 */
const DEAD_SLOT_MARKER = '.dead-'

/**
 * What a taken-over lock file is renamed to: `<lock>.stale-<pid>-<ms>`.
 *
 * The rename is what makes the takeover one atomic step: a second server that renamed the
 * same lock finds nothing, and one that got there first leaves the loser with `EEXIST` when
 * it links its own lock. The stale file is removed only after the winner's own lock exists;
 * if the winner lost, it is left where it is rather than put back over the winner's lock.
 */
const SLOT_LOCK_STALE_MARKER = '.stale-'

/**
 * The per-repository settings file, read when a pool is constructed and again when a
 * writing call leases a slot after the file changed (see `refreshSettings`). It carries the
 * copy's exclusions and the worker's per-slot environment, which belong to the repository
 * rather than to the service invocation and so cannot live in `flash.config.json`.
 */
const SETTINGS_FILE = '.flash-agents.json'

/**
 * The per-machine settings file at the same root, meant to be git-ignored.
 *
 * The shared file is committed, but some settings belong to one computer: a prebuilt
 * OpenSSL lives at a path only that machine has. This file has the shared file's exact
 * shape, is layered over it, and is checked at start so a machine-local file cannot quietly
 * be committed for every checkout.
 */
const LOCAL_SETTINGS_FILE = '.flash-agents.local.json'

/**
 * The platform names a `platform` section may name, the same spellings `process.platform`
 * uses. A section for any other name is a typo and is named in the log rather than kept.
 */
const PLATFORM_NAMES = new Set(['aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32'])

/**
 * The warning earlier releases returned for one settings file that changed after the server
 * read it.
 *
 * Those releases read the files once, at start, so an edit only took effect after a
 * reconnect — and the VS Code extension has no `/mcp reconnect`, so there it never did. The
 * pool now re-reads a changed file when the next writing call leases a slot (see
 * `refreshSettings`), and the service no longer returns this sentence. It stays exported
 * because it is the sentence older results carried, and something matching on it should
 * still find the same words.
 *
 * @param {string} file - the settings file name, as the caller knows it.
 * @returns {string} the warning naming that file.
 */
export function settingsChangedWarning(file) {
  return `${file} changed after this server started; its new settings take effect after a reconnect (/mcp reconnect plugin:flash-agents:flash)`
}

/**
 * The warning a call carries when the shared settings file changed after this server read it.
 * Kept as a constant because that is the sentence earlier releases returned.
 */
export const SETTINGS_CHANGED_WARNING = settingsChangedWarning(SETTINGS_FILE)

/**
 * The warning a call carries while one settings file cannot be used.
 *
 * A half-saved edit or a stray comma would otherwise be reported only in a log nobody reads,
 * and the caller would wonder why the settings they just wrote changed nothing.
 *
 * @param {string} file - the settings file name, as the caller knows it.
 * @param {string} problem - what is wrong with its content.
 * @param {object} options - what the call uses instead.
 * @param {boolean} options.kept - whether the file was valid before, so its last valid
 *   settings still apply.
 * @returns {string} the warning naming that file and the problem.
 */
export function settingsInvalidWarning(file, problem, { kept }) {
  return kept
    ? `${file} could not be used: ${problem}. Calls keep the settings last read from it until it is fixed`
    : `${file} could not be used: ${problem}. None of its settings apply until it is fixed`
}

/**
 * Whether two settings-file stamps describe the same file.
 * @param {{exists: boolean, size?: number, ino?: number, mtimeMs?: number, ctimeMs?: number}} now - the current stamp.
 * @param {{exists: boolean, size?: number, ino?: number, mtimeMs?: number, ctimeMs?: number}} before - the stamp last read.
 * @returns {boolean} true when every field matches.
 */
function sameSettingsStamp(now, before) {
  return (
    now.exists === before.exists &&
    now.size === before.size &&
    now.ino === before.ino &&
    now.mtimeMs === before.mtimeMs &&
    now.ctimeMs === before.ctimeMs
  )
}

/**
 * A key for what one read of a settings file found, so a file that was only touched (a
 * save without an edit, a checkout that rewrote it unchanged) is not re-applied.
 * @param {{present: boolean, hash?: string, problem?: string}} parsed - what `readSettingsFile` returned.
 * @returns {string} `absent`, the content's digest, or the reason it could not be read.
 */
function settingsContentKey(parsed) {
  if (!parsed.present) return 'absent'
  return parsed.hash ?? `unreadable: ${parsed.problem ?? ''}`
}

/**
 * How long a Windows slot root may be before tools without long-path support can fail.
 *
 * MSVC's `cl.exe` and friends still count against 260 characters. A slot root of about 85
 * characters leaves almost no room for a project's own deep build folders, and a user's
 * OpenSSL build hit 264; past this advisory the server and the doctor say so early.
 */
export const WINDOWS_SLOT_PATH_ADVISORY = 64

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

/**
 * Environment names that decide how a program is found or how the runtime loads code, for
 * every kind of `slotEnv` entry. A `value:` entry reaches the dsh runtime itself, which
 * runs outside the worker's sandbox: a `NODE_OPTIONS=--require …` there would run a
 * worker-supplied file inside the runtime, and a `PATH` or `LD_PRELOAD` would replace the
 * programs it starts. Names beginning with `LD_` or `DYLD_` are covered by their prefix
 * (see `mergeSlotEnv`), so only the fixed Windows and Node names are listed here.
 */
const LOADER_SLOT_ENV = new Set(['PATH', 'PATHEXT', 'NODE_OPTIONS', 'NODE_PATH'])

/** A `slotEnv` value pointing at one per-slot directory: `home:<name>` or `cache:<name>`. */
const SLOT_ENV_VALUE = /^(home|cache):(.+)$/

/** The prefix of a `slotEnv` value that is handed to the worker verbatim. */
const SLOT_ENV_TEXT = 'value:'

/**
 * How long one `value:` entry may be. 32,767 characters is the Windows limit for a single
 * environment variable; a longer value would be truncated there, or refused by the system.
 */
const SLOT_ENV_TEXT_MAX = 32767

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
 * The per-root directory, beside the pid directories, that keeps `.flash-cache` folders
 * between servers: `<stateBase>/<rootDigest>/caches/<n>/`. Numeric entries only, so the
 * dead-owner sweep (which visits numeric names under the digest, not this one) never
 * mistakes it for an owner.
 */
const CACHE_STORE_DIR = 'caches'

/**
 * How many times a put into the cache store tries the next free number. Two servers
 * stopping together can both pick the same lowest free `<n>`; the rename of the loser fails
 * because the winner's cache is already there, and it takes the next number. Eight is far
 * more servers than one root runs at once.
 */
const CACHE_STORE_PUT_ATTEMPTS = 8

/**
 * The free-space fraction of the state volume below which a call warns. A build copy of a
 * large workspace is tens of GB, so a tenth of the volume is the point where one more
 * copy can plausibly fill it; the user who prompted this saw a disk 99 % full unannounced.
 */
export const LOW_DISK_FREE_FRACTION = 0.1

/**
 * The absolute free space below which a call warns, whatever the volume's size. A fraction
 * alone stays quiet on a 4 TB disk down to 400 GB, but a native build wants a few GB of
 * headroom regardless; the warning fires on either condition.
 */
export const LOW_DISK_FREE_BYTES = 5 * 1024 ** 3

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
 * The file inside a copy's own git directory that names the task the worker is doing.
 *
 * It exists so a patch salvaged after a crash can say which task made it: the caller had a
 * fifteen-file patch and had to guess its task from its files. Git never reports a file
 * under `.git`, so it never appears in the diff, and it lives exactly as long as the tree.
 */
const TASK_FILE = 'flash-task.json'

/**
 * The file inside a copy's own git directory that names the nested repositories its diff
 * stages file by file (see `stagedRepositories`), so a salvage diffs them the same way.
 */
const NESTED_FILE = 'flash-nested.json'

/** How much of a task's label, file path and ids a record keeps. */
const TASK_LABEL_MAX = 200
const TASK_FILE_PATH_MAX = 1024
const TASK_ID_MAX = 100

/** The largest `flash-task.json` a salvage will read; a bigger one is somebody else's file. */
const TASK_FILE_MAX_BYTES = 16 * 1024

/** How much of a worker's final report a patch record keeps. */
const FINAL_MESSAGE_MAX = 8000

/** The task kinds a call may name. */
const TASK_KINDS = new Set(['flash_task', 'flash_batch'])

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
 * nested repository's changes at all, so its patch came back empty (a whole-root copy now
 * stages them itself, see `stagedRepositories`, but still copies every one). The nearest directory
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
 * Whether a record's optional `scope` may be joined onto a root.
 *
 * A whole-root record has no scope at all (an old record may even carry `undefined`), and
 * a scoped one must be a safe relative path. Used where a record is only being *counted* —
 * prefix resolution — so an unusable one is skipped instead of throwing.
 *
 * @param {unknown} scope - the record's scope.
 * @returns {boolean} true when the record may be applied by this root.
 */
function scopeIsSafeOrEmpty(scope) {
  return scope === undefined || scope === '' || scopeIsSafe(scope)
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
 * Normalize a caller's `task` description into the shape a patch record keeps, or drop it.
 *
 * The value arrives from a tool call, so it is bounded and reduced to the keys the record
 * knows: an unknown key would otherwise ride along into a file a later version has to
 * interpret, and an unbounded label would make a record as large as the worker's report.
 * A task without a non-empty label says nothing, so it is ignored rather than stored empty.
 * The same rules run when a dead tree's `flash-task.json` is read, because a worker could
 * have written that file.
 *
 * @param {unknown} task - the candidate `{kind, label, sessionId?, jobId?, taskFile?}`.
 * @returns {{kind?: string, label: string, sessionId?: string, jobId?: string,
 *   taskFile?: string} | undefined} the bounded value, or undefined when it names no task.
 */
function normalizeTask(task) {
  if (task === null || typeof task !== 'object' || Array.isArray(task)) return undefined
  const label = typeof task.label === 'string' ? task.label.trim().slice(0, TASK_LABEL_MAX) : ''
  if (label === '') return undefined
  const normalized = { label }
  if (TASK_KINDS.has(task.kind)) normalized.kind = task.kind
  for (const [key, max] of [
    ['sessionId', TASK_ID_MAX],
    ['jobId', TASK_ID_MAX],
    ['taskFile', TASK_FILE_PATH_MAX],
  ]) {
    const value = typeof task[key] === 'string' ? task[key].trim().slice(0, max) : ''
    if (value !== '') normalized[key] = value
  }
  return normalized
}

/**
 * Where a prepared copy records its task, inside the copy's own git directory.
 *
 * `.git` is the one directory every git command treats as its own state and never reports,
 * so the file cannot reach a patch, and `prepare` empties the tree between calls, so it
 * cannot outlive the tree it describes. `detachGitLink` has already replaced a linked
 * worktree's `.git` FILE with a directory by the time this is written, which is why a plain
 * join is safe here.
 *
 * @param {string} repoDir - the copy's repository.
 * @returns {string} the task file path for that copy.
 */
function taskFileIn(repoDir) {
  return join(repoDir, '.git', TASK_FILE)
}

/**
 * Read the task one dead tree recorded, tolerating anything a worker may have left there.
 *
 * A missing file is the ordinary case; an oversized one, unreadable one or malformed JSON
 * is ignored with at most one log line, and the value is re-validated because a worker could
 * have written it. Salvage must never fail because of this file: the tree's diff is what the
 * caller needs.
 *
 * The path is worker-writable, so it is not trusted to be a file at all. A FIFO there used
 * to pass the size check and block the sweep forever in `readFileSync`, and a symlink could
 * point `readFileSync` at any file on disk; a sweep is synchronous and also runs inside
 * `lease`, so either one wedged the server. Only a regular file is opened (`lstatSync`, plus
 * `O_NOFOLLOW` where the platform has it, so a symlink swapped in between is refused), and
 * the read is bounded at `TASK_FILE_MAX_BYTES + 1` bytes through a descriptor: a file that
 * grew between the stat and the read still cannot be read unbounded.
 *
 * @param {string} repoDir - the dead tree's repository.
 * @param {(message: string) => void} log - where to name an ignored file.
 * @returns {object | undefined} the bounded task, or undefined when there is none.
 */
function readSalvagedTask(repoDir, log) {
  const file = taskFileIn(repoDir)
  let info
  try {
    // lstat, not stat: a symlink is refused rather than followed to somebody else's file.
    info = lstatSync(file)
  } catch (error) {
    // The common case is a tree prepared before this file existed, or an empty retired tree.
    if (error?.code !== 'ENOENT') log(`ignoring ${file}: it could not be read (${messageOf(error)})`)
    return undefined
  }
  if (!info.isFile()) {
    log(`ignoring ${file}: it is not a regular file, so it is not a task this service wrote`)
    return undefined
  }
  if (info.size > TASK_FILE_MAX_BYTES) {
    log(`ignoring ${file}: it is ${String(info.size)} bytes, over the ${String(TASK_FILE_MAX_BYTES)}-byte limit for a task file`)
    return undefined
  }
  let raw
  let fd
  try {
    // `O_NOFOLLOW` is not defined on Windows; `0` there leaves the lstat above as the guard.
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const buffer = Buffer.alloc(TASK_FILE_MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, length)
      if (read === 0) break
      length += read
    }
    if (length > TASK_FILE_MAX_BYTES) {
      log(`ignoring ${file}: it grew past the ${String(TASK_FILE_MAX_BYTES)}-byte limit while it was read`)
      return undefined
    }
    raw = buffer.toString('utf8', 0, length)
  } catch (error) {
    log(`ignoring ${file}: it could not be read (${messageOf(error)})`)
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  try {
    const task = normalizeTask(JSON.parse(raw))
    if (task === undefined) log(`ignoring ${file}: it does not name a task with a label`)
    return task
  } catch (error) {
    log(`ignoring ${file}: it is not valid JSON (${messageOf(error)})`)
    return undefined
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
 *
 * The same interval spaces the salvage attempts of a kept owner: `prepare` sweeps before
 * every call, so without it three calls in a row would spend all `SALVAGE_MAX_ATTEMPTS`
 * within seconds and delete work a later, successful attempt could have read.
 */
export const SWEEP_INTERVAL_MS = 10 * 60 * 1000

/**
 * The prefix of a dead owner's directory while its tree is being deleted.
 *
 * The sweep used to `rmSync` the directory whole, and on NTFS a slot holding a multi-
 * gigabyte `cargo target` takes minutes to delete: the client's 30 s connect timeout
 * expired, the server was killed mid-sweep, and the next start repeated the work. A
 * rename to `trash-<pid>-<epochMs>` is instant on the same filesystem and takes the tree
 * out of every future sweep's path at once; the deletion itself then runs in the
 * background. The name keeps the dead owner's pid, so a log line still says whose tree
 * it is, and the timestamp keeps a retried removal from colliding with an earlier one.
 */
const TRASH_PREFIX = 'trash-'

/**
 * How often the background removal retries a tree something still holds open. Windows
 * answers EBUSY/EPERM for a file a dying process has not released yet; `fs.promises.rm`
 * retries exactly that class of error with a short backoff.
 */
const TRASH_RETRIES = 3

/**
 * The file a dead owner keeps while one of its slots cannot be salvaged.
 *
 * It holds `{attempts, salvaged}`: how many sweeps have failed, and which slots already
 * produced a patch. The second fact is what keeps a retry from storing the same tree
 * twice — a salvage stages the tree with `git add -A`, so a second pass would see the
 * same staged change and write a second, identical patch.
 */
const SALVAGE_ATTEMPTS_FILE = 'salvage-attempts'

/**
 * How many sweeps try to salvage a dead owner before its trees are removed anyway.
 *
 * A salvage can fail for a transient reason (a dying process still holding a git file,
 * a lock on Windows). One failure must not delete the only copy of the work, but a tree
 * that has resisted three passes is not coming back, and keeping it forever is the disk
 * leak the sweep exists to prevent.
 */
const SALVAGE_MAX_ATTEMPTS = 3

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
 * The state base a `--state-base` value or `FLASH_STATE_BASE` names, with `~` expanded.
 *
 * A relative base used to be passed straight to `resolve()`, which resolved it against the
 * process's working directory — the service root — so `--state-base rel` put every worker
 * copy inside the caller's own repository, where the sweep could later delete parts of it.
 * `~` is the other shape people write; it used to become a literal directory named `~`.
 * Expansion follows `resolveDshHome`, because that is the spelling dsh itself accepts.
 * Whether what is left is absolute is the caller's decision (see `requireAbsoluteStateBase`),
 * so the measurement path can report on an odd base without refusing to run.
 *
 * @param {unknown} value - the raw flag argument or environment value.
 * @param {string} [home] - the user's home directory (default the process's).
 * @returns {string | undefined} the expanded path, or undefined when the value is empty.
 */
export function resolveStateBase(value, home = homedir()) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return undefined
  if (text === '~') return home
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(home, text.slice(2))
  return text
}

/**
 * The state base an option names, refusing one that is still relative after `~` expansion.
 *
 * A relative base is resolved against the process cwd, which is the service root, so it
 * would land the disposable copies inside the caller's repository. Refusing it at option
 * parsing means every door — the server, `clean` and `doctor` — reports the same sentence
 * before anything is created.
 *
 * @param {unknown} value - the raw flag argument or environment value.
 * @param {string} [home] - the user's home directory (default the process's).
 * @returns {string | undefined} the absolute path, or undefined when the value is empty.
 * @throws {Error} when the expanded value is still relative.
 */
export function requireAbsoluteStateBase(value, home = homedir()) {
  const resolved = resolveStateBase(value, home)
  if (resolved === undefined) return undefined
  if (!isAbsolute(resolved)) {
    throw Object.assign(new Error(`--state-base must be an absolute path (got ${JSON.stringify(String(value))})`), {
      code: 'STATE_BASE_INVALID',
    })
  }
  return resolved
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
 * a unit, and the nonce lives below it: `<base>/<digest>/<pid>/<instance>`. A default pool's
 * slot trees are not under it: they are the stable per-root directories
 * `<base>/<digest>/slots/<n>` (see `stableSlotDirectory`), so a slot keeps one path across
 * restarts. This directory holds the pool's scratch files and, with a configured `stateDir`,
 * the older `<stateDir>/slots/<name>` slot layout.
 *
 * `baseDir`, `pid` and `instance` exist so a test can name a place under an injected base
 * without writing into the real temp state base, and so a test can lay out a dead owner
 * exactly the way this function lays out a live one.
 *
 * @param {string} root - the canonical service root.
 * @param {object} [options] - where the layout sits and which owner it names.
 * @param {string} [options.baseDir] - the state base directory, usually `$TMPDIR/flash-mcp`.
 * @param {number} [options.pid] - the owning process id; this process by default.
 * @param {string} [options.instance] - the per-pool nonce; a random 8-hex one by default.
 * @returns {string} the state directory for this process, root, and pool.
 */
export function defaultStateDir(root, { baseDir = stateBaseDir(), pid = process.pid, instance = randomUUID().slice(0, 8) } = {}) {
  return join(baseDir, rootDigest(root), String(pid), instance)
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
 * One command line in the form a slot lock records and compares.
 *
 * A process's own `argv` is joined by spaces, and the answer read back from the operating
 * system is folded the same way: runs of whitespace become one space, the ends are trimmed,
 * and the line is capped at `SLOT_COMMAND_LINE_LIMIT`. Only then can the two be compared,
 * because `/proc/<pid>/cmdline` separates arguments with NUL bytes and `ps` pads its columns.
 *
 * @param {string} value - an `argv` joined by spaces, or a command line read from the system.
 * @returns {string} the normalised, capped line.
 */
function normalizeCommandLine(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > SLOT_COMMAND_LINE_LIMIT ? text.slice(0, SLOT_COMMAND_LINE_LIMIT) : text
}

/**
 * The part of a command line two readings of one process always agree on.
 *
 * The program token is left out: a process's own `process.argv[0]` is Node's absolute path
 * (`/opt/homebrew/…/bin/node`), while `ps`, `/proc/<pid>/cmdline` and Windows report it as
 * it was invoked (`node`, or a quoted `"C:\Program Files\nodejs\node.exe"`). Quotes are
 * removed for the same reason: Windows reports a command line with the quoting that started
 * it and `argv` has none. What is left — the script and its arguments — is what tells one
 * server from an unrelated process that reused its pid.
 *
 * @param {string} value - a recorded or a live command line.
 * @returns {string} the comparable remainder.
 */
function commandIdentity(value) {
  const unquoted = normalizeCommandLine(String(value ?? '').replace(/["']/g, ' '))
  const space = unquoted.indexOf(' ')
  return space === -1 ? '' : unquoted.slice(space + 1)
}

/** This process's command line as the operating system reports it, read once. */
let ownCommandLine

/**
 * The command line of a process, normalised as `normalizeCommandLine` describes.
 *
 * An owner's command line is what a slot lock records instead of a start time: it is the
 * same in every time zone and across a DST change, and a pid the operating system reused
 * belongs to a process started with a different command. Each platform asks its one
 * source: Linux reads `/proc/<pid>/cmdline` (NUL-separated), macOS and the BSDs run
 * `ps -o args=`, Windows one PowerShell `Get-CimInstance` call. Every failure — a gone
 * process, a permission error, an unreadable answer — is null, and callers then fall back
 * to asking only whether the pid is alive. This process's own pid is answered from
 * `process.argv` without starting anything, so recording a lock and checking our own lock
 * never spawn a child.
 *
 * @param {number} pid - the process to ask about.
 * @returns {string | null} its command line, or null when it cannot be read.
 */
export function processCommandLine(pid) {
  if (pid === process.pid) {
    // Read through the same source another server will use to check this lock, once, so the
    // recorded line and a later live reading come from one place; `argv` only when the
    // system will not answer.
    ownCommandLine ??= systemCommandLine(pid) ?? normalizeCommandLine(process.argv.join(' '))
    return ownCommandLine
  }
  return systemCommandLine(pid)
}

/**
 * One process's command line from the operating system, normalised, or null.
 *
 * @param {number} pid - the process to ask about.
 * @returns {string | null} its command line, or null when it cannot be read.
 */
function systemCommandLine(pid) {
  try {
    if (process.platform === 'linux') {
      const raw = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8')
      // `/proc/<pid>/cmdline` ends every argument with NUL, and an empty or zombie process
      // has no argument at all: both give an empty line, which is not a readable identity.
      const line = raw.split('\0').filter((part) => part !== '').join(' ')
      const normalised = normalizeCommandLine(line)
      return normalised === '' ? null : normalised
    }
    if (process.platform === 'win32') {
      const output = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}").CommandLine`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      )
      const normalised = normalizeCommandLine(output)
      return normalised === '' ? null : normalised
    }
    // `-ww`: never cut the line to a terminal width, or a long invocation compares unequal.
    const output = execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const normalised = normalizeCommandLine(output)
    return normalised === '' ? null : normalised
  } catch {
    return null
  }
}

/**
 * Liveness answers already obtained, keyed by `(pid, recorded command line)`.
 *
 * One `ps` or PowerShell call per lock per sweep would add up on a machine with many
 * servers, and the answer cannot meaningfully change inside `SLOT_LIVENESS_CACHE_MS`: a pid
 * alive with one command line for a minute is the same process. The pid's existence is
 * always asked afresh (`processAlive`), so an entry can never outlive its process.
 *
 * @type {Map<string, {live: boolean, at: number}>}
 */
const slotLivenessCache = new Map()

/**
 * The numeric per-pid owner directories of one root digest.
 *
 * Only numeric names count: a `patches/` directory, a lock file or a `trash-*` directory
 * left by an interrupted removal is never mistaken for a process that owns trees.
 *
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
 * Whether a root digest still has a live server, by either sign it leaves.
 *
 * A server of the default layout may already have removed its per-pid directory yet still
 * hold a stable slot's lock, or it may never have had an owner directory in this digest at
 * all. Treating only the pid directories as life removed such a root — and the live slot's
 * tree — out from under it. A lock that cannot be read counts as life until its grace
 * expires, the same rule `slotHolder` uses.
 *
 * @param {string} digestDir - one `$TMPDIR/flash-mcp/<digest>` directory.
 * @param {object} [options] - how liveness is judged.
 * @param {(pid: number) => string | null} [options.commandLineOf] - `processCommandLine`.
 * @param {number} [options.exceptPid] - a pid whose own owner directory and locks are not
 *   evidence of another server, because they are the caller's own.
 * @returns {boolean} true when some live owner or live slot lock exists.
 */
function digestHasLiveOwner(digestDir, { commandLineOf = processCommandLine, exceptPid } = {}) {
  if (livePidsIn(digestDir).some((pid) => pid !== exceptPid)) return true
  return slotTreesIn(digestDir, { commandLineOf }).some((tree) => tree.live && tree.pid !== exceptPid)
}

/**
 * Whether one root digest's `slots` folder holds any slot lock file.
 *
 * A lock is the root's own claim on a number, and a fresh one names a server that may be
 * between creating the lock and its directory. A dead or unreadable one is still that
 * root's to sweep. Either way another root must not remove the digest under it: the
 * question here is only whether a lock file exists, not whether its owner is alive.
 *
 * @param {string} digestDir - one `$TMPDIR/flash-mcp/<digest>` directory.
 * @returns {boolean} true when `slots/` holds a `*.lock` file.
 */
function digestHasSlotLockFiles(digestDir) {
  let entries
  try {
    entries = readdirSync(join(digestDir, SLOTS_DIRECTORY), { withFileTypes: true })
  } catch {
    return false
  }
  return entries.some((entry) => entry.isFile() && entry.name.endsWith(SLOT_LOCK_SUFFIX))
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
export function formatBytes(bytes) {
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
 * The directory that keeps one root's idle build caches between servers.
 * @param {string} baseDir - the state base directory.
 * @param {string} root - the canonical service root.
 * @returns {string} `<baseDir>/<rootDigest>/caches`.
 */
export function cacheStoreDir(baseDir, root) {
  return join(baseDir, rootDigest(root), CACHE_STORE_DIR)
}

/**
 * The stored caches of one store, lowest number first.
 * @param {string} storeDir - one root's cache store.
 * @returns {string[]} the numeric directory names.
 */
function storedCacheNames(storeDir) {
  try {
    return readdirSync(storeDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number(a) - Number(b))
  } catch {
    return []
  }
}

/**
 * Take the lowest stored cache into a slot, by renaming it onto `target`.
 *
 * A rename is atomic, so two servers on one root can never take the same cache: the loser's
 * rename finds the source gone (ENOENT) and moves on to the next number. Any other failure
 * (an open handle on Windows, another device) is logged and the slot starts cold — copying
 * tens of gigabytes would freeze the server, and a half-copied cache would be worse than none.
 * The setup stamps are dropped for the reason `#moveRetiredCache` gives: what a step kept
 * names the absolute path it was built at, so each step must run once at the new one.
 *
 * @param {string} storeDir - the root's cache store.
 * @param {string} target - the slot's `.flash-cache`, which holds no file (the caller checked).
 * @param {object} options - the rename and the log.
 * @param {(from: string, to: string) => void} options.rename - the directory rename.
 * @param {(message: string) => void} options.log - progress log.
 * @returns {string | undefined} the number of the cache taken, or undefined for a cold start.
 */
function claimStoredCache(storeDir, target, { rename, log }) {
  for (const name of storedCacheNames(storeDir)) {
    const source = join(storeDir, name)
    try {
      // Only empty folders can be here, and a rename onto a directory with entries fails.
      rmSync(target, { recursive: true, force: true })
      rename(source, target)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      log(`could not claim stored build cache ${source} for ${target} (${messageOf(error)}); the slot starts cold`)
      return undefined
    }
    rmSync(join(target, SETUP_STAMP_DIR), { recursive: true, force: true })
    log(`claimed stored build cache ${source} for ${target}`)
    return name
  }
  return undefined
}

/**
 * The marker file that says a retired tree's runtimes were not shut down, so a process of it
 * may still be writing into its build cache. It sits beside the `slots` folder, where a dead
 * owner's sweep can read it after the server that wrote it is gone.
 *
 * @param {string} orphan - a retired slot tree.
 * @returns {string} the marker's path.
 */
function liveOrphanMarker(orphan) {
  return join(dirname(dirname(orphan)), `.live-${basename(orphan)}`)
}

/**
 * Record that a tree was retired with its runtimes still running.
 * @param {string} orphan - the retired tree.
 * @param {(message: string) => void} log - progress log.
 * @returns {void}
 */
function markLiveOrphan(orphan, log) {
  try {
    writeFileSync(liveOrphanMarker(orphan), '')
  } catch (error) {
    log(`could not mark ${orphan} as possibly still in use (${messageOf(error)})`)
  }
}

/**
 * Put a `.flash-cache` folder into the store, by renaming it to the lowest free number.
 *
 * A folder that holds no file is not a cache and is not stored. The stored folder's mtime is
 * set to now: renaming a directory leaves its mtime alone, and a build changes files deep in
 * the tree without touching the folder, so the stamp is when the cache went idle, which is
 * what the retention window measures. A failed rename is logged and the cache goes with its
 * tree, exactly as before the store existed.
 *
 * @param {string} source - a `.flash-cache` folder.
 * @param {string} storeDir - the root's cache store.
 * @param {object} options - the rename and the log.
 * @param {(from: string, to: string) => void} options.rename - the directory rename.
 * @param {(message: string) => void} options.log - progress log.
 * @returns {string | undefined} the number it was stored under, or undefined when it was not.
 */
function putCacheInStore(source, storeDir, { rename, log }) {
  if (!holdsAnyFile(source)) return undefined
  try {
    mkdirSync(storeDir, { recursive: true })
  } catch (error) {
    log(`could not create the cache store ${storeDir} (${messageOf(error)}); the build cache of ${source} is not kept`)
    return undefined
  }
  const taken = new Set(readdirSync(storeDir))
  let number = 0
  let lastError
  for (let attempt = 0; attempt < CACHE_STORE_PUT_ATTEMPTS; attempt += 1) {
    while (taken.has(String(number))) number += 1
    const destination = join(storeDir, String(number))
    try {
      rename(source, destination)
    } catch (error) {
      lastError = error
      // A number a concurrent server filled first: try the next. Anything else will not
      // improve with another number.
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY' && !(error?.code === 'EPERM' && existsSync(destination))) break
      taken.add(String(number))
      continue
    }
    try {
      const now = new Date()
      utimesSync(destination, now, now)
    } catch (error) {
      log(`could not stamp the stored build cache ${destination} (${messageOf(error)}); its age is when it was last changed`)
    }
    log(`stored the build cache of ${source} as ${destination}`)
    return String(number)
  }
  log(`could not store the build cache of ${source} in ${storeDir} (${messageOf(lastError)}); it goes with its tree`)
  return undefined
}

/**
 * Remove stored caches by renaming them out of the store first, so they are gone from the
 * accounting at once and the deletion of tens of gigabytes does not block the server.
 *
 * The rename target is a `trash-*` directory beside the store, which every sweep adopts and
 * deletes if this process exits first (see `removeLeftoverTrash`). `removal: 'sync'` is what
 * `clean` asks for, because it exits right after its report.
 *
 * @param {string} storeDir - the root's cache store.
 * @param {string[]} names - the stored caches to remove.
 * @param {object} options - how to delete and report.
 * @param {'sync' | 'background'} options.removal - how the renamed trash is deleted.
 * @param {Map<string, number>} [options.listed] - the mtime each name had when it was listed;
 *   a cache whose mtime is different now was claimed and put back meanwhile, and is skipped.
 * @param {(message: string) => void} options.log - progress log.
 * @returns {number} how many stored caches were taken out of the store.
 */
function discardStoredCaches(storeDir, names, { removal, listed, log }) {
  let removed = 0
  const parent = dirname(storeDir)
  for (const name of names) {
    const source = join(storeDir, name)
    if (listed?.has(name) === true) {
      try {
        if (statSync(source).mtimeMs !== listed.get(name)) {
          log(`kept stored build cache ${source}: it changed since it was listed`)
          continue
        }
      } catch {
        continue
      }
    }
    const trash = join(parent, `${TRASH_PREFIX}cache-${name}-${String(Date.now())}`)
    try {
      renameSync(source, trash)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      log(`could not rename stored build cache ${source} out of the way (${messageOf(error)}); removing it in place`)
      try {
        rmSync(source, { recursive: true, force: true })
        removed += 1
      } catch (rmError) {
        log(`could not remove stored build cache ${source}: ${messageOf(rmError)}`)
      }
      continue
    }
    removed += 1
    if (removal === 'sync') {
      try {
        rmSync(trash, { recursive: true, force: true, maxRetries: TRASH_RETRIES })
      } catch (error) {
        log(`could not remove ${trash}: ${messageOf(error)}`)
      }
    } else {
      startTrashRemoval(trash, log)
    }
    log(`removed stored build cache ${source}`)
  }
  return removed
}

/**
 * Keep a store to the newest `max` caches that are younger than the retention window.
 *
 * "Untouched longer than the window" is the stored folder's mtime (stamped when it went
 * idle, see `putCacheInStore`) against the same window that ages out stored patches.
 *
 * @param {string} storeDir - the root's cache store.
 * @param {object} options - the limits and how to report.
 * @param {number} options.max - how many caches to keep: this root's configured slot count.
 * @param {number} options.retentionDays - the patch retention window.
 * @param {number} [options.now] - the current time, for tests.
 * @param {'sync' | 'background'} [options.removal] - how removed caches are deleted.
 * @param {(message: string) => void} options.log - progress log.
 * @returns {number} how many caches were removed.
 */
function trimCacheStore(storeDir, { max, retentionDays, now = Date.now(), removal = 'background', log }) {
  const windowMs = retentionDays * 24 * 60 * 60 * 1000
  const entries = storedCacheNames(storeDir).map((name) => {
    let mtimeMs = 0
    try {
      mtimeMs = statSync(join(storeDir, name)).mtimeMs
    } catch {
      // A cache that vanished is counted as old and its removal then finds nothing.
    }
    return { name, mtimeMs }
  })
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const doomed = entries.filter((entry, index) => index >= max || now - entry.mtimeMs > windowMs)
  const listed = new Map(doomed.map((entry) => [entry.name, entry.mtimeMs]))
  return discardStoredCaches(storeDir, doomed.map((entry) => entry.name), { removal, listed, log })
}

/**
 * Put every cache of a dead owner's slots into the store, then trim it.
 *
 * Runs before the owner is removed: the cache is not work to salvage, but it is the one
 * thing in the dead tree worth keeping, and the owner's removal would delete it.
 *
 * @param {string} ownerDir - the dead owner's per-pid directory.
 * @param {object} caches - the pool's store policy (see `WorkspaceIsolation#cachePolicy`).
 * @param {(message: string) => void} log - progress log.
 * @returns {number} how many caches were rescued.
 */
function rescueDeadCaches(ownerDir, caches, log) {
  let rescued = 0
  for (const { dir } of deadSlotsIn(ownerDir)) {
    // A tree retired with its runtimes still running is marked (see `markLiveOrphan`); a
    // process of it may outlive the dead server, so its cache is not moved from under it.
    if (existsSync(liveOrphanMarker(dir))) {
      if (holdsAnyFile(join(dir, SLOT_CACHE))) log(`not rescuing the build cache of ${dir}: its runtimes were not shut down when it was retired`)
      continue
    }
    if (putCacheInStore(join(dir, SLOT_CACHE), caches.storeDir, { rename: caches.rename, log }) !== undefined) rescued += 1
  }
  if (rescued > 0) trimCacheStore(caches.storeDir, { max: caches.max, retentionDays: caches.retentionDays, log })
  return rescued
}

/**
 * The apparent size in bytes of the regular files below a directory.
 *
 * Symlinks are neither followed nor counted (`lstat`), so a link into the cache, or out of
 * the tree, cannot count a file twice or walk outside; a hard-linked file counts once. The
 * walk is as slow as the tree is big, so it belongs to `doctor` and `clean`, never to a call.
 *
 * @param {string} dir - the directory to size.
 * @param {object} [options] - what to skip.
 * @param {(name: string) => boolean} [options.skipTop] - top-level entry names to leave out.
 * @param {Set<string>} [options.seen] - hard-linked files already counted.
 * @returns {number} the sum of the file sizes, unreadable entries counted as zero.
 */
function treeBytes(dir, { skipTop = () => false, seen = new Set() } = {}) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    if (skipTop(entry.name)) continue
    const child = join(dir, entry.name)
    try {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        total += treeBytes(child, { seen })
      } else if (entry.isFile()) {
        const info = lstatSync(child)
        if (info.nlink > 1) {
          const key = `${String(info.dev)}:${String(info.ino)}`
          if (seen.has(key)) continue
          seen.add(key)
        }
        total += info.size
      }
    } catch {
      // A file that vanished mid-walk contributes nothing.
    }
  }
  return total
}

/**
 * Free and total space of the volume holding a path.
 * @param {string} path - any path on the volume; its nearest existing parent is asked.
 * @param {(path: string) => {bsize: number, blocks: number, bavail: number}} statfs - `fs.statfsSync`.
 * @returns {{path: string, freeBytes: number, totalBytes: number}} the space, for unprivileged users.
 */
function volumeSpace(path, statfs) {
  let at = resolve(path)
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at)
  const stats = statfs(at)
  return { path: at, freeBytes: Number(stats.bavail) * Number(stats.bsize), totalBytes: Number(stats.blocks) * Number(stats.bsize) }
}

/**
 * What the copies and caches of one root take on disk, and what is left of the volume.
 *
 * Every server's slot trees of the root are listed, live or dead, each with its copy size
 * (the tree without its `.flash-cache`) and its cache size, then the cache store. The
 * walks are slow on big trees, which is why only `doctor` and `clean` call this.
 *
 * @param {string} root - the canonical service root.
 * @param {object} [options] - where the layout lives.
 * @param {string} [options.baseDir] - the state base directory.
 * @param {string} [options.stateDir] - a configured state directory, which replaces the
 *   default layout (and has no cache store).
 * @param {(path: string) => object} [options.statfs] - `fs.statfsSync`; injectable for tests.
 * @returns {{root: string, baseDir: string, slots: {owner: string, live: boolean, label: string, dir: string,
 *   copyBytes: number, cacheBytes: number}[], store: {dir: string, caches: {name: string, bytes: number}[],
 *   bytes: number} | null, volume: {path: string, freeBytes: number, totalBytes: number} | null,
 *   volumeError?: string}} the measurement.
 */
export function measureDisk(root, { baseDir = stateBaseDir(), stateDir, statfs = statfsSync } = {}) {
  const slots = []
  const measure = (owner, live, slot) => {
    slots.push({
      owner,
      live,
      label: slot.label,
      dir: slot.dir,
      copyBytes: treeBytes(slot.dir, { skipTop: (name) => name === SLOT_CACHE }),
      cacheBytes: treeBytes(join(slot.dir, SLOT_CACHE)),
    })
  }
  let store = null
  let anchor
  if (stateDir === undefined) {
    const digestDir = join(baseDir, rootDigest(root))
    for (const pid of ownerDirs(digestDir)) {
      const live = processAlive(Number(pid))
      for (const slot of deadSlotsIn(join(digestDir, pid))) measure(pid, live, slot)
    }
    // The stable layout's slots sit directly under the digest and name no pid directory, so
    // they are listed separately: a live server's are measured like a dead one's, and the
    // lock's pid is what the report calls their owner.
    for (const tree of stableSlotTreesIn(digestDir)) measure(tree.pid === undefined ? 'stable' : String(tree.pid), tree.live, tree)
    const dir = cacheStoreDir(baseDir, root)
    const caches = storedCacheNames(dir).map((name) => ({ name, bytes: treeBytes(join(dir, name)) }))
    store = { dir, caches, bytes: caches.reduce((sum, cache) => sum + cache.bytes, 0) }
    anchor = digestDir
  } else {
    for (const slot of deadSlotsIn(stateDir)) measure('configured', true, slot)
    anchor = stateDir
  }
  const result = { root, baseDir, slots, store, volume: null }
  try {
    result.volume = volumeSpace(anchor, statfs)
  } catch (error) {
    result.volumeError = messageOf(error)
  }
  return result
}

/**
 * The trash directories sitting in one digest directory.
 *
 * A `trash-*` name is what a removal leaves behind between its `renameSync` and the end
 * of the background `rm` — or forever, when the process died in between. Only the default
 * layout has them: a configured state directory has no dead-owner sweep.
 *
 * @param {string} digestDir - one `$TMPDIR/flash-mcp/<digest>` directory.
 * @returns {string[]} the `trash-*` names, in readdir order.
 */
function trashDirsIn(digestDir) {
  try {
    return readdirSync(digestDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(TRASH_PREFIX))
      .map((entry) => entry.name)
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
 * @returns {{slotTrees: number, slotBytes: number, trashDirs: number, trashBytes: number,
 *   patches: number, patchBytes: number, reports: number, reportBytes: number,
 *   caches: number, cacheBytes: number}} the facts, `caches` being the build caches waiting
 *   in the root's store, and `reports` the whole-call reports this root still has.
 */
function digestStats(digestDir, extraPatchDirs = []) {
  let slotTrees = 0
  let slotBytes = 0
  // `deadSlotsIn` knows both per-pid layouts: `<pid>/<instance>/slots/<name>` from a current
  // server and `<pid>/slots/<name>` from an older one. Counting only the older one made
  // `clean` report zero slot trees for every root a current server had written.
  for (const pid of ownerDirs(digestDir)) {
    for (const slot of deadSlotsIn(join(digestDir, pid))) {
      slotTrees += 1
      slotBytes += directorySize(slot.dir)
    }
  }
  // The stable layout keeps its slots directly under the digest, not under a pid, so the
  // owner loop above never sees them. Without this `clean` would report a dead stable slot's
  // copy as free disk while its bytes are still there.
  for (const tree of stableSlotTreesIn(digestDir)) {
    slotTrees += 1
    slotBytes += directorySize(tree.dir)
  }
  // A trash directory is a dead tree whose deletion has not finished. It is disk in use,
  // so it is counted with the slot trees' bytes — but it is not a slot (no slot-tree
  // count) and it is not an owner, so nothing here offers it to salvage.
  let trashDirs = 0
  let trashBytes = 0
  for (const name of trashDirsIn(digestDir)) {
    trashDirs += 1
    trashBytes += directorySize(join(digestDir, name))
  }
  let patches = 0
  let patchBytes = 0
  let reports = 0
  let reportBytes = 0
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
        } else if (entry.isFile() && entry.name.endsWith(REPORT_SUFFIX)) {
          // A whole report is call state beside the patch records; it is pruned on the same
          // window and counted here so `clean` can show it rather than leave it invisible.
          reports += 1
          try {
            reportBytes += statSync(join(patchesDir, entry.name)).size
          } catch {
            // A report that vanished mid-walk contributes nothing.
          }
        }
      }
    } catch {
      // No `patches/` directory: nothing stored for this root.
    }
  }
  // A server started with isolation off keeps this root's reports under the state base
  // instead of beside a patch store, because it has no patch store.
  try {
    for (const entry of readdirSync(join(digestDir, 'reports'), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(REPORT_SUFFIX)) continue
      reports += 1
      try {
        reportBytes += statSync(join(digestDir, 'reports', entry.name)).size
      } catch {
        // A report that vanished mid-walk contributes nothing.
      }
    }
  } catch {
    // No `reports/` directory: this root was only used with a copy pool.
  }
  // The caches idle between servers are disk too; the walk is as slow as the caches are big,
  // which `clean` accepts (it is an operator command) and a call never pays.
  const storeDir = join(digestDir, CACHE_STORE_DIR)
  const stored = storedCacheNames(storeDir)
  const cacheBytes = stored.reduce((sum, name) => sum + treeBytes(join(storeDir, name)), 0)
  return {
    slotTrees,
    slotBytes: slotBytes + trashBytes,
    trashDirs,
    trashBytes,
    patches,
    patchBytes,
    reports,
    reportBytes,
    caches: stored.length,
    cacheBytes,
  }
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
 * Remove the whole-call reports in one directory that are past the retention window, and the
 * temporary files a crashed write left behind.
 *
 * A report is keyed by a job or session id and is never read again once its job is gone, so
 * it ages out by its own file time: a read-only or discarded call has no patch record to
 * age it by. The same window as patches applies, because both are call state an operator
 * expects `clean` to reclaim together.
 *
 * A report write goes through `.<key>.<uuid>.tmp` in the same directory and is renamed into
 * place. A crash between the write and the rename leaves that file forever, and nothing else
 * would ever remove it; it goes once it is old enough that no live writer can still own it.
 *
 * @param {string} dir - a reports directory: beside the patch records, or
 *   `<stateBase>/<rootDigest>/reports` for a server with isolation off.
 * @param {object} [options] - the window and the clock.
 * @param {number} [options.retentionDays] - how long a report survives.
 * @param {number} [options.now] - the current time, for tests.
 * @returns {number} how many report files and leftover temporary files were removed.
 */
export function pruneReports(dir, { retentionDays = PATCH_RETENTION_DAYS, now = Date.now() } = {}) {
  const cutoff = now - retentionDays * DAY_MS
  const tempCutoff = now - REPORT_TEMP_MAX_AGE_MS
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    const report = name.endsWith(REPORT_SUFFIX)
    if (!report && !REPORT_TEMP_NAME.test(name)) continue
    try {
      if (statSync(join(dir, name)).mtimeMs >= (report ? cutoff : tempCutoff)) continue
      rmSync(join(dir, name), { force: true })
      removed += 1
    } catch {
      // A report that will not go away is retried by the next startup.
    }
  }
  return removed
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
  // A report outlives its patch's record by nothing: it ages out on its own file time,
  // because a read-only or discarded call has no patch record to age it by.
  removed += pruneReports(patchDir, { retentionDays, now })
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
 * digest does not carry, so the trees go and the patches beside them stay. A foreign
 * digest's `trash-*` directories are not touched here: `clean` removes those for this
 * root only, and `ownerDirs` never mistakes one for an owner.
 *
 * The stable layout's slot trees are removed too, and only the ones no lock holds: a
 * foreign digest can still have a live server if its pid directory was already cleaned, and
 * its slot must not go under it.
 *
 * @param {string} digestDir - one `$TMPDIR/flash-mcp/<digest>` directory.
 * @param {object} [options] - how to report and which lock identity to use.
 * @param {(message: string) => void} [options.log] - progress log.
 * @param {{pid: number, instance: string, command: string}} options.owner - this
 *   `clean`'s lock identity.
 * @param {(pid: number) => string | null} [options.commandLineOf] - `processCommandLine`.
 * @returns {number} how many owners and stable slot trees were removed.
 */
function removeDeadOwnerDirs(digestDir, { log = () => {}, owner, commandLineOf = processCommandLine, linkLock = linkSync } = {}) {
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
  for (const tree of slotTreesIn(digestDir, { commandLineOf })) {
    if (tree.live) continue
    // A tree is removed only while `clean` holds its lock: another server may claim the
    // same number between the plan and this loop, and its tree must not go under it.
    const acquired = acquireSlotTreeLock(tree.dir, { owner, log, commandLineOf, linkLock })
    if (!acquired.ok || !holdsSlotLock(tree.dir, owner)) {
      releaseSlotTreeLock(tree.dir, owner, acquired.lock, log, linkLock)
      continue
    }
    if (removeTreeViaTrash(tree.dir, { parent: digestDir, name: basename(tree.dir), what: `dead slot tree ${tree.dir}`, log, removal: 'sync' })) {
      releaseOwnSlotLock(tree.dir, owner, log)
      removed += 1
    } else {
      releaseSlotTreeLock(tree.dir, owner, acquired.lock, log, linkLock)
    }
  }
  return removed
}

/**
 * Start removing one tree without blocking the caller.
 *
 * `fs.promises.rm` walks the tree on the libuv thread pool, so a multi-gigabyte
 * `cargo target` no longer freezes the event loop: protocol requests are answered while
 * the deletion runs. Its outcome is logged, never thrown — the next sweep retries a tree
 * that would not go away.
 *
 * @param {string} dir - the tree to remove.
 * @param {(message: string) => void} log - where to report the outcome.
 * @returns {Promise<void>} resolves when the removal settled, whatever its outcome.
 */
function removeInBackground(dir, log) {
  return removeTree(dir, { recursive: true, force: true, maxRetries: TRASH_RETRIES })
    .then(() => log(`removed ${dir}`))
    .catch((error) => log(`could not remove ${dir}: ${messageOf(error)}; the next sweep retries it`))
}

/**
 * The trash directories this process already has a removal in flight for.
 *
 * A sweep runs before every `prepare` and on the housekeeping timer, and each one adopts
 * every `trash-*` directory it sees. Without this set, a tree that takes a while to delete
 * was renamed, then handed to a second `fs.promises.rm` on every pass — two or more
 * deletions racing over the same tree, and the same work restarted every ten minutes.
 * The entry is removed when the removal settles, whatever its outcome.
 *
 * @type {Set<string>}
 */
const trashInFlight = new Set()

/**
 * Start the background removal of one `trash-*` tree, at most once per directory.
 *
 * `removeInBackground` never rejects, so the entry is cleared in `finally` whether the
 * tree went away or will be retried by a later sweep.
 *
 * @param {string} dir - the trash directory.
 * @param {(message: string) => void} log - where to report the outcome.
 * @returns {boolean} whether this call started a removal.
 */
function startTrashRemoval(dir, log) {
  const key = resolve(dir)
  if (trashInFlight.has(key)) return false
  trashInFlight.add(key)
  void removeInBackground(dir, log).finally(() => trashInFlight.delete(key))
  return true
}

/**
 * Start the background removal of trash an earlier, interrupted removal left behind.
 *
 * A process killed between the rename and the end of the `rm` leaves a `trash-*` directory
 * that no future sweep would ever look at again: it is not an owner (not numeric) and not
 * salvaged (it was already accounted for). Every sweep therefore adopts them, which is
 * what makes the rename-then-delete protocol recover from its own interruption. A tree
 * this process is already deleting is skipped (see `trashInFlight`).
 *
 * @param {string} digestDir - this root's digest directory.
 * @param {(message: string) => void} [log] - progress log.
 * @returns {void}
 */
function removeLeftoverTrash(digestDir, log = () => {}) {
  for (const name of trashDirsIn(digestDir)) {
    const dir = join(digestDir, name)
    if (!startTrashRemoval(dir, log)) continue
    log(`removing ${dir}, left behind by an earlier removal that did not finish`)
  }
}

/**
 * Remove trash synchronously, for the `clean` command.
 *
 * `clean` is an explicit operator command with no protocol connection to keep answering,
 * and it promises the disk back before the process exits: a background removal would be
 * abandoned by `process.exit`. A server's sweep never does this.
 *
 * @param {string} digestDir - this root's digest directory.
 * @param {(message: string) => void} [log] - progress log.
 * @returns {number} how many trash directories were removed.
 */
function removeTrashSync(digestDir, log = () => {}) {
  let removed = 0
  for (const name of trashDirsIn(digestDir)) {
    const dir = join(digestDir, name)
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: TRASH_RETRIES })
      removed += 1
      log(`removed ${dir}, left behind by an earlier removal that did not finish`)
    } catch (error) {
      log(`could not remove ${dir}: ${messageOf(error)}`)
    }
  }
  return removed
}

/**
 * Take one dead owner out of the accounting, deleting its tree in the background or now.
 *
 * The rename is the fast, atomic step: after it, the owner is gone from `ownerDirs`, so no
 * later sweep salvages or counts it again. The deletion follows in the background — unless
 * `removal` is `'sync'`, which `clean` asks for because it exits the process right after
 * the report and a background removal would be abandoned half done. When the rename itself
 * fails — a file still locked on Windows, a directory held open — the tree is removed in
 * place as before, with a log line saying why that path is slower.
 *
 * @param {string} ownerDir - the dead owner's per-pid directory.
 * @param {object} options - where its trash belongs and how to report.
 * @param {string} options.parent - the digest directory that holds the owner.
 * @param {number} options.pid - the dead owner's pid, kept in the trash name.
 * @param {(message: string) => void} options.log - progress log.
 * @param {'sync' | 'background'} [options.removal] - how the renamed trash is deleted.
 * @returns {boolean} whether the owner was taken out of the accounting.
 */
function removeDeadOwnerDir(ownerDir, { parent, pid, log, removal = 'background' }) {
  return removeTreeViaTrash(ownerDir, { parent, name: String(pid), what: `dead owner ${String(pid)}`, log, removal })
}

/**
 * Rename one dead tree to a fresh `trash-*` name and delete it there, now or in the
 * background; `removeDeadOwnerDir` and the stable-slot sweep share this.
 *
 * @param {string} dir - the tree to take out of the accounting.
 * @param {object} options - where its trash belongs and how to report.
 * @param {string} options.parent - the digest directory that holds the tree.
 * @param {string} options.name - what the trash name carries after the prefix.
 * @param {string} options.what - the tree as a log line names it.
 * @param {(message: string) => void} options.log - progress log.
 * @param {'sync' | 'background'} [options.removal] - how the renamed trash is deleted.
 * @returns {boolean} whether the tree was taken out of the accounting.
 */
function removeTreeViaTrash(dir, { parent, name, what, log, removal = 'background' }) {
  const trashDir = join(parent, `${TRASH_PREFIX}${name}-${String(Date.now())}`)
  try {
    renameSync(dir, trashDir)
  } catch (error) {
    log(
      `could not rename ${what} out of the way (${messageOf(error)}); ` +
        'removing it in place, which can block the server while it runs',
    )
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch (rmError) {
      // A tree that will not go away is retried by the next sweep; refusing to start over
      // it would be the wedge this function exists to prevent.
      log(`could not remove ${what}: ${messageOf(rmError)}`)
      return false
    }
  }
  if (removal === 'sync') {
    log(`renamed ${what} to ${trashDir}; removing it now`)
    try {
      rmSync(trashDir, { recursive: true, force: true, maxRetries: TRASH_RETRIES })
    } catch (error) {
      log(`could not remove ${trashDir}: ${messageOf(error)}`)
      return false
    }
    return true
  }
  log(`renamed ${what} to ${trashDir}; removing it in the background`)
  startTrashRemoval(trashDir, log)
  return true
}

/**
 * Whether a recorded slot label names one slot of one owner unambiguously.
 *
 * The attempts file is written by this service but sits in a directory a crash can leave
 * half-written, so a label is only trusted when it has the shape `deadSlotsIn` produces:
 * `slots/<name>` or `<instance>/slots/<name>`, with no empty, `.` or `..` segment and no
 * path separator the label does not define.
 *
 * @param {unknown} label - the recorded value.
 * @returns {boolean} true when the label names one slot.
 */
function slotLabelIsSafe(label) {
  if (typeof label !== 'string' || label === '' || label.includes('\0') || label.includes('\\')) return false
  const parts = label.split('/')
  if (parts.length !== 2 && parts.length !== 3) return false
  if (parts[parts.length - 2] !== 'slots') return false
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

/**
 * Whether a kept owner's next salvage attempt is due.
 *
 * `prepare` runs a sweep before every call, so three calls in a row used to spend all
 * `SALVAGE_MAX_ATTEMPTS` within seconds and delete work a later, successful attempt could
 * have read. A failed attempt now spaces the next one by `SWEEP_INTERVAL_MS`: before that
 * the owner is skipped entirely — no git work, no attempt counted.
 *
 * @param {{attempts: number, lastAttemptAt: number}} prior - the owner's record.
 * @param {number} now - the current epoch milliseconds.
 * @returns {boolean} true when this sweep may try the owner.
 */
function salvageAttemptDue(prior, now) {
  if (prior.attempts <= 0) return true
  if (!Number.isFinite(prior.lastAttemptAt) || prior.lastAttemptAt <= 0) return true
  return now - prior.lastAttemptAt >= SWEEP_INTERVAL_MS
}

/**
 * Read the record of failed salvage attempts for one dead owner.
 *
 * A missing file is the ordinary case (the first attempt); a malformed one is treated the
 * same way, because a file a crash left half-written must not stop the sweep. An `attempts`
 * count or `lastAttemptAt` that is not a positive number is ignored, and a `salvaged` entry
 * that does not name one slot (`slotLabelIsSafe`) is dropped rather than trusted as a path.
 *
 * @param {string} ownerDir - the dead owner's per-pid directory.
 * @returns {{attempts: number, salvaged: string[], lastAttemptAt: number}} what earlier
 *   sweeps recorded; `lastAttemptAt` is 0 when no failed attempt was ever recorded.
 */
function readSalvageAttempts(ownerDir) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(join(ownerDir, SALVAGE_ATTEMPTS_FILE), 'utf8'))
  } catch {
    return { attempts: 0, salvaged: [], lastAttemptAt: 0 }
  }
  const attempts = Number.isSafeInteger(parsed?.attempts) && parsed.attempts > 0 ? parsed.attempts : 0
  const lastAttemptAt = Number.isFinite(parsed?.lastAttemptAt) && parsed.lastAttemptAt > 0 ? parsed.lastAttemptAt : 0
  const salvaged = Array.isArray(parsed?.salvaged) ? parsed.salvaged.filter(slotLabelIsSafe) : []
  return { attempts, salvaged, lastAttemptAt }
}

/**
 * Record a dead owner's failed attempt, when it was last tried, and the slots it already
 * gave up its work for.
 *
 * A failure to write the file must not fail the sweep: the owner is then simply retried
 * with the count it had before, which is no worse than keeping it forever.
 *
 * @param {string} ownerDir - the dead owner's per-pid directory.
 * @param {{attempts: number, salvaged: string[], lastAttemptAt: number}} record - what to persist.
 * @param {(message: string) => void} log - where to report a write that failed.
 * @returns {void}
 */
function writeSalvageAttempts(ownerDir, record, log) {
  try {
    writeFileSync(join(ownerDir, SALVAGE_ATTEMPTS_FILE), `${JSON.stringify(record)}\n`)
  } catch (error) {
    log(`could not record the salvage attempt for ${ownerDir}: ${messageOf(error)}`)
  }
}

/**
 * Every slot tree of a dead owner, with a label that names it across its instance.
 *
 * A server's default state directory is `<base>/<digest>/<pid>/<instance>/`, so its slots
 * are `<pid>/<instance>/slots/<name>`. The sweep used to look at `<pid>/slots/<name>` — one
 * directory too high — so it never found a current server's slots, judged the dead owner
 * clean, and removed the whole directory with the uncommitted work still inside it.
 *
 * Both layouts are enumerated: `<pid>/slots/<name>` from a version that kept the slots one
 * level up and may still be on disk, and `<instance>/slots/<name>` for every instance
 * directory under the pid. Names are not assumed: a slot that was retired once lives at
 * `slot-<id>-1`, and a future naming change must not silently drop work.
 *
 * The label is unique within the owner — `<instance>/slots/<name>` or `slots/<name>` —
 * because the attempts file records which slots were already stored and two instances
 * may each have a `slot-0`.
 *
 * A default pool's slots are not here at all: they are the stable per-root directories
 * `<digest>/slots/<n>`, which `stableSlotTreesIn` enumerates with their locks.
 *
 * @param {string} ownerDir - the dead owner's per-pid directory.
 * @returns {{label: string, dir: string}[]} the slot trees, in a stable order.
 */
function deadSlotsIn(ownerDir) {
  const slots = []
  const collect = (label, slotsDir) => {
    let names
    try {
      names = readdirSync(slotsDir)
    } catch {
      // No `slots/` here (or an unreadable one) is the common, fast case: nothing to keep.
      return
    }
    for (const name of names) slots.push({ label: `${label}/${name}`, dir: join(slotsDir, name) })
  }
  // The older layout first: one cheap listing, and it may still be the only one present.
  collect('slots', join(ownerDir, 'slots'))
  let instances
  try {
    instances = readdirSync(ownerDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'slots')
      .map((entry) => entry.name)
      // Sorted, so a salvage stores the same slots in the same order on every sweep.
      .sort()
  } catch {
    return slots
  }
  for (const instance of instances) collect(`${instance}/slots`, join(ownerDir, instance, 'slots'))
  return slots
}

/**
 * Salvage one slot of a dead owner, turning a thrown error into a recorded failure.
 *
 * The sweep used to let a failed salvage fall through to the removal: a transient error
 * deleted the only copy of the work. A failure is now data — the slot is named, the owner
 * is kept, and a later sweep tries again — while the slot's own log line still explains
 * what went wrong.
 *
 * @param {string} label - the slot's owner-unique label, as `deadSlotsIn` produces it.
 * @param {string} slotDir - the slot tree.
 * @param {object} options - root, patch directory, dead pid, sweep time, log and the
 *   slots a previous attempt already stored.
 * @param {string} options.root - the canonical service root.
 * @param {string} options.patchDir - the root's patch directory.
 * @param {number} options.pid - the dead owner's pid.
 * @param {number} options.sweptAt - when this sweep started, for the record.
 * @param {(message: string) => void} options.log - progress log.
 * @param {Set<string>} options.alreadySalvaged - slot labels a previous attempt stored.
 * @returns {{patchId?: string, name?: string, failed?: {name: string, slotDir: string,
 *   message: string}, skipped?: true}} the outcome for this slot.
 */
function salvageSlotStep(label, slotDir, { root, patchDir, pid, sweptAt, log, alreadySalvaged }) {
  if (alreadySalvaged.has(label)) {
    // Staging the tree again would store a second patch for the same change: the first
    // attempt left the work staged with `git add -A`, so `git status` is not empty.
    log(`dead owner ${String(pid)} slot ${slotDir} was already salvaged by an earlier sweep`)
    return { skipped: true }
  }
  try {
    const salvaged = salvageSlot(slotDir, { root, patchDir, pid, sweptAt, log })
    if (salvaged === null) return {}
    log(
      `salvaged ${salvaged.patchId} from dead owner ${String(pid)} slot ${slotDir}: ` +
        salvaged.diffstat.replace(/\s*\n\s*/g, '; ') +
        (salvaged.task === undefined ? '' : ` for "${salvaged.task.label}"`),
    )
    return { patchId: salvaged.patchId, name: label }
  } catch (error) {
    log(`could not salvage ${slotDir} from dead owner ${String(pid)}: ${messageOf(error)}`)
    return { failed: { name: label, slotDir, message: messageOf(error) } }
  }
}

/**
 * Store every salvageable tree under one dead owner, across all of its instances.
 *
 * This is the synchronous pass the constructor, `prepare`, the housekeeping timer and
 * `clean` use. It reports what failed instead of swallowing it, so the caller can keep an
 * owner whose work it could not read.
 *
 * @param {string} ownerDir - the dead owner's per-pid directory.
 * @param {object} options - root, patch directory, log, owner pid and stored slots.
 * @param {string} options.root - the canonical service root.
 * @param {string} options.patchDir - the root's patch directory.
 * @param {(message: string) => void} options.log - progress log.
 * @param {number} options.pid - the dead owner's pid.
 * @param {string[]} [options.salvaged] - slot labels an earlier attempt already stored.
 * @returns {{patches: number, failed: {name: string, slotDir: string, message: string}[],
 *   stored: string[]}} what was stored and what could not be read.
 */
function salvageOwner(ownerDir, { root, patchDir, log, pid, salvaged = [] }) {
  const alreadySalvaged = new Set(salvaged)
  const sweptAt = Date.now()
  const failed = []
  const stored = []
  let patches = 0
  for (const { label, dir } of deadSlotsIn(ownerDir)) {
    const outcome = salvageSlotStep(label, dir, { root, patchDir, pid, sweptAt, log, alreadySalvaged })
    if (outcome.patchId !== undefined) {
      patches += 1
      stored.push(label)
    }
    if (outcome.failed !== undefined) failed.push(outcome.failed)
  }
  return { patches, failed, stored }
}

/**
 * The asynchronous form of `salvageOwner`, used by the deferred start-up sweep.
 *
 * It yields to the event loop before each slot, so the server keeps answering requests
 * while a salvage runs `git add -A` and `git diff` over a large tree. A stop request (the
 * pool closed) aborts between slots; what was already stored is recorded before returning,
 * so the next sweep cannot store it a second time.
 *
 * @param {string} ownerDir - the dead owner's per-pid directory.
 * @param {object} options - as `salvageOwner`, plus the previous attempt and the stop check.
 * @param {string} options.root - the canonical service root.
 * @param {string} options.patchDir - the root's patch directory.
 * @param {(message: string) => void} options.log - progress log.
 * @param {number} options.pid - the dead owner's pid.
 * @param {{attempts: number, salvaged: string[], lastAttemptAt: number}} options.prior -
 *   the previous attempt.
 * @param {() => boolean} [options.stopped] - whether the pool has closed.
 * @returns {Promise<{patches: number, failed: object[], stored: string[], stopped: boolean}>}
 *   what was stored, what could not be read, and whether the pass was cut short.
 */
async function salvageOwnerLater(ownerDir, { root, patchDir, log, pid, prior, stopped = () => false }) {
  const alreadySalvaged = new Set(prior.salvaged)
  const sweptAt = Date.now()
  const failed = []
  const stored = []
  let patches = 0
  for (const { label, dir } of deadSlotsIn(ownerDir)) {
    // Yield first, then check: a `close()` that happened during the yield must stop the
    // pass before another slot's git work starts, not after it.
    await new Promise((resolveTick) => setImmediate(resolveTick))
    if (stopped()) {
      if (patches > 0) {
        writeSalvageAttempts(
          ownerDir,
          { attempts: prior.attempts, salvaged: [...new Set([...prior.salvaged, ...stored])], lastAttemptAt: prior.lastAttemptAt },
          log,
        )
      }
      return { patches, failed, stored, stopped: true }
    }
    const outcome = salvageSlotStep(label, dir, { root, patchDir, pid, sweptAt, log, alreadySalvaged })
    if (outcome.patchId !== undefined) {
      patches += 1
      stored.push(label)
    }
    if (outcome.failed !== undefined) failed.push(outcome.failed)
  }
  return { patches, failed, stored, stopped: false }
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
 * @param {number} [options.retentionDays] - when given, the stored build caches of a root with
 *   no live server are aged out by this window first (nobody trims an abandoned store), so a
 *   digest they leave empty can go too.
 * @param {number} [options.now] - the current time, for tests.
 * @param {(message: string) => void} [options.log] - progress log.
 * @returns {number} how many digest directories were removed.
 */
function removeEmptyForeignDigests(root, { baseDir = stateBaseDir(), retentionDays, now = Date.now(), log = () => {}, commandLineOf = processCommandLine } = {}) {
  const own = rootDigest(root)
  let removed = 0
  for (const digest of digestDirs(baseDir)) {
    if (digest === own) continue
    const dir = join(baseDir, digest)
    if (digestHasLiveOwner(dir, { commandLineOf })) continue
    // A lock in the root's `slots` folder is that root's own protocol, live, dead or
    // unreadable: only its servers sweep it, and this root never removes a number another
    // root may be about to claim. The folder holding one keeps its digest even when it
    // holds nothing else.
    if (digestHasSlotLockFiles(dir)) continue
    if (retentionDays !== undefined) {
      trimCacheStore(join(dir, CACHE_STORE_DIR), { max: Infinity, retentionDays, now, removal: 'sync', log })
    }
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
 * What one pass over this root's slot trees has to do, or undefined when the next attempt is
 * not due yet.
 *
 * A tree is dead when its directory has no lock, an unreadable lock past the grace, or a
 * lock whose owner is gone or whose pid was reused — the rule `slotHolder` uses. A live
 * server's trees are never candidates, and neither are its retired trees, which carry a lock
 * of their own while that pool runs (see `retire`).
 *
 * The sweep of a running server leaves the stable `slots/<n>` directories alone even when
 * their owner is dead: each holds the warm `.flash-cache` the next server of the root wants.
 * It salvages and removes only the trees no stable number names — `slots/<n>.dead-*` and
 * `slots/<n>.retired-*`. `clean` asks for `includeStable` because it is the operator
 * reclaiming the disk, and then follows the same lock protocol for the stable directories.
 *
 * The attempt record for the salvage failures lives in the `slots` folder itself, because a
 * stable slot has no per-pid owner directory to keep it in; its labels have the shape
 * `slots/<name>`, which `slotLabelIsSafe` accepts.
 *
 * @param {string} root - the canonical service root.
 * @param {string} baseDir - the state base directory.
 * @param {(message: string) => void} log - progress log.
 * @param {object} [options] - what to consider and how to test liveness.
 * @param {boolean} [options.includeStable] - also take dead stable slot directories.
 * @param {(pid: number) => string | null} [options.commandLineOf] - `processCommandLine`.
 * @returns {{slotsDir: string, dead: object[], prior: {attempts: number, salvaged: string[],
 *   lastAttemptAt: number}, sweptAt: number} | undefined} the dead trees to work through.
 */
function stableSlotSweepPlan(root, baseDir, log, { includeStable = false, commandLineOf = processCommandLine } = {}) {
  const digestDir = join(baseDir, rootDigest(root))
  const slotsDir = join(digestDir, SLOTS_DIRECTORY)
  const dead = slotTreesIn(digestDir, { commandLineOf })
    .filter((tree) => includeStable || tree.kind !== 'stable')
    .filter((tree) => !tree.live)
  if (dead.length === 0) return undefined
  const prior = readSalvageAttempts(slotsDir)
  const now = Date.now()
  if (!salvageAttemptDue(prior, now)) {
    // No git work and no attempt counted: the failure is recent, and burning the remaining
    // attempts seconds apart would delete the work far too soon.
    const ageSeconds = Math.round((now - prior.lastAttemptAt) / 1000)
    log(
      `skipping ${String(dead.length)} dead slot tree(s) in ${slotsDir}: the last salvage attempt failed ${String(ageSeconds)}s ago, ` +
        `and the next is due after ${String(Math.round(SWEEP_INTERVAL_MS / 1000))}s`,
    )
    return undefined
  }
  return { slotsDir, dead, prior, sweptAt: now }
}

/**
 * Acquire the lock of a tree the sweep is about to touch, by creating it or taking over a
 * dead owner's.
 *
 * The dead lock is moved aside and read back, and this pool's lock is created complete; when
 * another server created one in between, the number or tree is theirs and this pass leaves
 * it alone. The stale file is removed only once our own lock exists.
 *
 * @param {string} dir - the tree to lock.
 * @param {object} options - who takes it, and how to report and test liveness.
 * @param {{pid: number, instance: string, command: string}} options.owner - this pool.
 * @param {(message: string) => void} options.log - progress log.
 * @param {(pid: number) => string | null} [options.commandLineOf] - `processCommandLine`.
 * @param {(from: string, to: string) => void} [options.linkLock] - `linkSync`, injectable.
 * @returns {{ok: boolean, lock?: object}} whether this pass now holds the tree.
 */
function acquireSlotTreeLock(dir, { owner, log, commandLineOf = processCommandLine, linkLock = linkSync }) {
  const created = createSlotLock(slotLockPath(dir), owner, { link: linkLock, log })
  if (created.kind === 'created') return { ok: true }
  if (created.kind !== 'exists') {
    log(`not sweeping ${dir}: its lock could not be created (${messageOf(created.error)})`)
    return { ok: false }
  }
  const holder = slotHolder(dir, { commandLineOf })
  if (holder.live) return { ok: false }
  const taken = takeOverDeadLock(dir, owner, { log, commandLineOf, linkLock })
  if (!taken.ok) return { ok: false }
  if (taken.stale !== undefined) rmSync(taken.stale, { force: true })
  return { ok: true, lock: taken.lock }
}

/**
 * Give up a sweep's lock on one tree, putting a dead owner's lock back when there was one.
 *
 * The dead lock is recreated complete with `createSlotLock`, so it never overwrites a lock
 * another server created first.
 *
 * @param {string} dir - the tree.
 * @param {{pid: number, instance: string}} owner - this pool.
 * @param {object} [prior] - the dead owner's lock, when the sweep took one over.
 * @param {(message: string) => void} log - progress log.
 * @param {(from: string, to: string) => void} [linkLock] - `linkSync`, injectable.
 * @returns {void}
 */
function releaseSlotTreeLock(dir, owner, prior, log, linkLock = linkSync) {
  releaseOwnSlotLock(dir, owner, log)
  if (prior !== undefined) createSlotLock(slotLockPath(dir), prior, { link: linkLock, log })
}

/**
 * Salvage one dead slot tree and take it out of the way, or say why it stays.
 *
 * The tree is touched only while this pass holds its lock: acquired first, and re-checked
 * immediately before the removal, so a number another server claimed in between is left
 * untouched. The cache is rescued into the store first, as for a dead owner, because the tree
 * that holds it is about to be removed; a tree retired with its runtimes still running is
 * marked (see `markLiveOrphan`), and a process of it may outlive the dead server, so its
 * cache is not moved from under it.
 *
 * @param {{label: string, dir: string, pid?: number}} tree - one dead slot tree.
 * @param {object} options - where to store and how to report.
 * @param {string} options.root - the canonical service root.
 * @param {string} options.patchDir - the root's patch directory.
 * @param {{sweptAt: number}} options.plan - this pass's plan.
 * @param {Set<string>} options.alreadySalvaged - labels an earlier attempt already stored.
 * @param {{storeDir: string, max: number, retentionDays: number, rename: Function}} [options.caches] -
 *   the cache store policy, when caches are to be kept.
 * @param {string} options.parent - the digest directory the trash belongs in.
 * @param {(message: string) => void} options.log - progress log.
 * @param {'sync' | 'background'} options.removal - how the removed tree is deleted.
 * @param {{pid: number, instance: string, command: string}} options.owner - this pool.
 * @param {(pid: number) => string | null} [options.commandLineOf] - `processCommandLine`.
 * @param {(tree: object) => void} [options.beforeSweep] - called after the plan and before
 *   the lock is taken; injectable so a test can claim the tree in that window.
 * @returns {{patchId?: string, failed?: object, removed?: boolean, rescued?: boolean,
 *   skipped?: boolean}} the outcome.
 */
function sweepStableTree(
  tree,
  { root, patchDir, plan, alreadySalvaged, caches, parent, log, removal, owner, commandLineOf = processCommandLine, linkLock = linkSync, beforeSweep },
) {
  beforeSweep?.(tree)
  const acquired = acquireSlotTreeLock(tree.dir, { owner, log, commandLineOf, linkLock })
  if (!acquired.ok) return { skipped: true }
  const deadPid = tree.pid ?? acquired.lock?.pid ?? 0
  const outcome = salvageSlotStep(tree.label, tree.dir, {
    root,
    patchDir,
    pid: deadPid,
    sweptAt: plan.sweptAt,
    log,
    alreadySalvaged,
  })
  if (outcome.failed !== undefined) {
    releaseSlotTreeLock(tree.dir, owner, acquired.lock, log, linkLock)
    return { failed: outcome.failed }
  }
  let rescued = false
  if (caches !== undefined) {
    if (existsSync(liveOrphanMarker(tree.dir))) {
      // Same rule, and the same sentence, as `rescueDeadCaches` for the older layout.
      if (holdsAnyFile(join(tree.dir, SLOT_CACHE))) log(`not rescuing the build cache of ${tree.dir}: its runtimes were not shut down when it was retired`)
    } else {
      rescued = putCacheInStore(join(tree.dir, SLOT_CACHE), caches.storeDir, { rename: caches.rename, log }) !== undefined
    }
  }
  if (!holdsSlotLock(tree.dir, owner)) {
    log(`not removing ${tree.dir}: another server claimed it while the sweep was salvaging it`)
    return { patchId: outcome.patchId, rescued, skipped: true }
  }
  const removed = removeTreeViaTrash(tree.dir, { parent, name: basename(tree.dir), what: `dead slot tree ${tree.dir}`, log, removal })
  if (removed) {
    releaseOwnSlotLock(tree.dir, owner, log)
    // The "a runtime may still write here" mark describes this tree and nothing else, and it
    // lives beside the tree rather than in it: leaving it behind would mark a later tree that
    // happens to get the same name, and keep that one's cache out of the store.
    rmSync(liveOrphanMarker(tree.dir), { force: true })
  } else {
    releaseSlotTreeLock(tree.dir, owner, acquired.lock, log, linkLock)
  }
  return { patchId: outcome.patchId, removed, rescued }
}

/**
 * Record a stable-slot sweep's outcome and keep the trees whose work could not be read.
 *
 * The record is written only while something is left to retry; once every dead tree is
 * stored and removed it is deleted, so a later failure starts with its full
 * `SALVAGE_MAX_ATTEMPTS` rather than inheriting this pass's count.
 *
 * @param {{slotsDir: string, prior: {attempts: number, salvaged: string[], lastAttemptAt: number}}} plan -
 *   this pass's plan.
 * @param {object} outcome - what the pass found.
 * @param {string[]} outcome.stored - labels whose patch was stored.
 * @param {{name: string, slotDir: string, message: string}[]} outcome.failed - trees that could not be read.
 * @param {object[]} outcome.stuck - the dead trees that could not be removed.
 * @param {object} options - where the trash belongs and how to report and delete.
 * @param {string} options.parent - the digest directory.
 * @param {(message: string) => void} options.log - progress log.
 * @param {'sync' | 'background'} options.removal - how a removed tree is deleted.
 * @param {{pid: number, instance: string, command: string}} options.owner - this pass.
 * @param {(pid: number) => string | null} [options.commandLineOf] - `processCommandLine`.
 * @returns {void}
 */
function finishStableSlotSweep(plan, { stored, failed, stuck }, { parent, log, removal, owner, commandLineOf = processCommandLine, linkLock = linkSync }) {
  const { slotsDir, prior } = plan
  let attempts = prior.attempts
  const salvaged = [...new Set([...prior.salvaged, ...stored])]
  if (failed.length > 0) {
    attempts = prior.attempts + 1
    if (attempts < SALVAGE_MAX_ATTEMPTS) {
      writeSalvageAttempts(slotsDir, { attempts, salvaged, lastAttemptAt: Date.now() }, log)
      log(
        `keeping ${String(failed.length)} dead slot tree(s) in ${slotsDir}: salvage attempt ${String(attempts)} of ` +
          `${String(SALVAGE_MAX_ATTEMPTS)} could not read ${failed.map((entry) => entry.slotDir).join(', ')}; ` +
          `the next attempt is due in ${String(Math.round(SWEEP_INTERVAL_MS / 60000))} minutes`,
      )
      return
    }
    log(
      `removing ${String(failed.length)} dead slot tree(s) in ${slotsDir} after ${String(attempts)} failed salvage attempts: ` +
        `the work in ${failed.map((entry) => entry.slotDir).join(', ')} could not be salvaged and is lost`,
    )
    for (const entry of failed) {
      // Even an unreadable tree is removed only while this pass holds its lock.
      const acquired = acquireSlotTreeLock(entry.slotDir, { owner, log, commandLineOf, linkLock })
      if (!acquired.ok || !holdsSlotLock(entry.slotDir, owner)) {
        releaseSlotTreeLock(entry.slotDir, owner, acquired.lock, log, linkLock)
        stuck.push({ dir: entry.slotDir })
        continue
      }
      const removed = removeTreeViaTrash(entry.slotDir, { parent, name: basename(entry.slotDir), what: `dead slot tree ${entry.slotDir}`, log, removal })
      if (removed) releaseOwnSlotLock(entry.slotDir, owner, log)
      else {
        releaseSlotTreeLock(entry.slotDir, owner, acquired.lock, log, linkLock)
        stuck.push({ dir: entry.slotDir })
      }
    }
    failed.length = 0
  }
  if (stuck.length > 0) {
    // The trees were salvaged (or skipped as already salvaged); only their deletion is
    // still in flight or failed. Keeping the record stops a second patch for the same work,
    // and leaving `lastAttemptAt` alone lets the next pass retry the removal at once.
    writeSalvageAttempts(slotsDir, { attempts, salvaged, lastAttemptAt: prior.lastAttemptAt }, log)
    return
  }
  rmSync(join(slotsDir, SALVAGE_ATTEMPTS_FILE), { force: true })
}

/**
 * Salvage and remove the dead slot trees of one root, synchronously.
 *
 * A running server's pass takes only the trees no stable number names — `slots/<n>.dead-*`
 * and `slots/<n>.retired-*` — because `slots/<n>` itself holds the warm cache the next server
 * of the root wants. `clean` sets `includeStable` and takes the dead stable directories too,
 * each under its own lock.
 *
 * The older layout — `<pid>/<instance>/slots/<name>`, and `<pid>/slots/<name>` before that —
 * is swept by `sweepDeadOwners`' owner pass exactly as before, so a machine that upgrades
 * with a crashed 0.1.11 server still keeps that server's work.
 *
 * @param {string} root - the canonical service root.
 * @param {object} options - where to store and how to report.
 * @param {string} options.patchDir - the root's patch directory.
 * @param {string} [options.baseDir] - the state base directory.
 * @param {(message: string) => void} [options.log] - progress log.
 * @param {'sync' | 'background'} [options.removal] - how a removed tree is deleted.
 * @param {object} [options.caches] - the cache store policy, as `sweepDeadOwners` takes it.
 * @param {{pid: number, instance: string, command: string}} options.owner - this pass.
 * @param {boolean} [options.includeStable] - also take dead stable slot directories (`clean`).
 * @param {(pid: number) => string | null} [options.commandLineOf] - `processCommandLine`.
 * @param {(tree: object) => void} [options.beforeSweep] - a test hook between plan and lock.
 * @returns {{removed: number, kept: number, patches: number, rescued: number}} what the pass did.
 */
function sweepStableSlots(
  root,
  { patchDir, baseDir = stateBaseDir(), log = () => {}, removal = 'background', caches, owner, includeStable = false, commandLineOf = processCommandLine, linkLock = linkSync, beforeSweep },
) {
  removeLeakedSlotLocks(join(baseDir, rootDigest(root), SLOTS_DIRECTORY), { commandLineOf, log })
  const stats = { removed: 0, kept: 0, patches: 0, rescued: 0 }
  const plan = stableSlotSweepPlan(root, baseDir, log, { includeStable, commandLineOf })
  if (plan === undefined) return stats
  const parent = join(baseDir, rootDigest(root))
  const alreadySalvaged = new Set(plan.prior.salvaged)
  const stored = []
  const failed = []
  const stuck = []
  for (const tree of plan.dead) {
    const outcome = sweepStableTree(tree, {
      root,
      patchDir,
      plan,
      alreadySalvaged,
      caches,
      parent,
      log,
      removal,
      owner,
      commandLineOf,
      linkLock,
      beforeSweep,
    })
    if (outcome.patchId !== undefined) {
      stored.push(tree.label)
      stats.patches += 1
    }
    if (outcome.rescued === true) stats.rescued += 1
    if (outcome.failed !== undefined) {
      failed.push(outcome.failed)
      continue
    }
    if (outcome.removed === true) stats.removed += 1
    else stuck.push(tree)
  }
  finishStableSlotSweep(plan, { stored, failed, stuck }, { parent, log, removal, owner, commandLineOf, linkLock })
  stats.kept = plan.dead.length - stats.removed
  if (stats.rescued > 0 && caches !== undefined) {
    trimCacheStore(caches.storeDir, { max: caches.max, retentionDays: caches.retentionDays, log })
  }
  return stats
}

/**
 * The deferred sweep's form of `sweepStableSlots`: the same decisions, yielding between trees.
 *
 * A server that answered `initialize` before its sweep must keep answering while a salvage
 * runs `git add -A` over a dead worker's tree; the yield is what keeps the event loop free.
 * A stop request (the pool closed) ends the pass at the next tree, and what was already
 * stored is recorded before returning.
 *
 * @param {string} root - the canonical service root.
 * @param {object} options - where to store and how to report.
 * @param {string} options.patchDir - the root's patch directory.
 * @param {string} [options.baseDir] - the state base directory.
 * @param {(message: string) => void} [options.log] - progress log.
 * @param {object} [options.caches] - the cache store policy.
 * @param {object} options.owner - this pass's lock identity.
 * @param {boolean} [options.includeStable] - also take dead stable slot directories.
 * @param {(pid: number) => string | null} [options.commandLineOf] - `processCommandLine`.
 * @param {(tree: object) => void} [options.beforeSweep] - a test hook between plan and lock.
 * @param {() => boolean} [options.stopped] - whether the pool has closed.
 * @returns {Promise<{removed: number, kept: number, patches: number, rescued: number,
 *   stopped: boolean}>} what the pass did.
 */
async function sweepStableSlotsLater(
  root,
  { patchDir, baseDir = stateBaseDir(), log = () => {}, caches, owner, includeStable = false, commandLineOf = processCommandLine, linkLock = linkSync, beforeSweep, stopped = () => false },
) {
  removeLeakedSlotLocks(join(baseDir, rootDigest(root), SLOTS_DIRECTORY), { commandLineOf, log })
  const stats = { removed: 0, kept: 0, patches: 0, rescued: 0, stopped: false }
  const plan = stableSlotSweepPlan(root, baseDir, log, { includeStable, commandLineOf })
  if (plan === undefined) return stats
  const parent = join(baseDir, rootDigest(root))
  const alreadySalvaged = new Set(plan.prior.salvaged)
  const stored = []
  const failed = []
  const stuck = []
  for (const tree of plan.dead) {
    // Yield first, then check: a `close()` during the yield must stop the pass before
    // another tree's git work starts, not after it.
    await new Promise((resolveTick) => setImmediate(resolveTick))
    if (stopped()) {
      stats.stopped = true
      break
    }
    const outcome = sweepStableTree(tree, {
      root,
      patchDir,
      plan,
      alreadySalvaged,
      caches,
      parent,
      log,
      removal: 'background',
      owner,
      commandLineOf,
      linkLock,
      beforeSweep,
    })
    if (outcome.patchId !== undefined) {
      stored.push(tree.label)
      stats.patches += 1
    }
    if (outcome.rescued === true) stats.rescued += 1
    if (outcome.failed !== undefined) {
      failed.push(outcome.failed)
      continue
    }
    if (outcome.removed === true) stats.removed += 1
    else stuck.push(tree)
  }
  finishStableSlotSweep(plan, { stored, failed, stuck }, { parent, log, removal: 'background', owner, commandLineOf, linkLock })
  stats.kept = plan.dead.length - stats.removed
  if (stats.rescued > 0 && caches !== undefined) {
    trimCacheStore(caches.storeDir, { max: caches.max, retentionDays: caches.retentionDays, log })
  }
  return stats
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
 * whole used to lose it with the restart. Every slot of every instance under the pid —
 * under whatever name, including the retired `<id>-<n>` generations — is therefore
 * examined before the owner is removed, and a dirty tree is stored as a patch beside the
 * surviving ones (see `deadSlotsIn`; the old `<pid>/slots` layout is read too). A slot
 * whose salvage throws keeps its owner: one transient failure must not delete the only
 * copy of the work, so the owner is retried by a later sweep up to
 * `SALVAGE_MAX_ATTEMPTS` times, spaced by `SWEEP_INTERVAL_MS`.
 *
 * Removal does not block a server: the owner is renamed to `trash-<pid>-<ms>` and deleted
 * in the background (see `removeDeadOwnerDir`). Leftover trash from an interrupted
 * removal is adopted and deleted too, at the start of every pass. A caller that exits
 * right after the sweep — `clean` — asks for `removal: 'sync'` instead, so the deletion
 * is not abandoned with the process.
 *
 * Both layouts are swept: the per-pid one above, and the stable `<digest>/slots/<n>`
 * directories of the default layout, whose dead trees are found by their locks (see
 * `sweepStableSlots`).
 *
 * @param {string} root - the canonical service root.
 * @param {object} options - where to put salvaged patches and how to report.
 * @param {string} options.patchDir - the root's patch directory.
 * @param {string} [options.baseDir] - the state base directory.
 * @param {(message: string) => void} [options.log] - progress log.
 * @param {'sync' | 'background'} [options.removal] - how a dead owner's trash is deleted.
 * @param {{storeDir: string, max: number, retentionDays: number, rename: Function}} [options.caches] -
 *   the cache store policy; when given, each dead slot's `.flash-cache` is rescued into the
 *   store before the owner is removed. `clean` omits it: it is removing caches, not keeping them.
 * @param {{pid: number, instance: string, command: string}} options.owner - this
 *   pass's lock identity for the stable layout.
 * @param {boolean} [options.includeStable] - also take dead stable slot directories.
 * @param {(pid: number) => string | null} [options.commandLineOf] - `processCommandLine`.
 * @param {(tree: object) => void} [options.beforeSweep] - a test hook between plan and lock.
 * @returns {{removed: number, kept: number, salvaged: number, patches: number,
 *   trashRemoved: number}} what the pass did.
 */
function sweepDeadOwners(
  root,
  { patchDir, baseDir = stateBaseDir(), log = () => {}, removal = 'background', caches, owner, includeStable = false, commandLineOf = processCommandLine, linkLock = linkSync, beforeSweep } = {},
) {
  const stats = { removed: 0, kept: 0, salvaged: 0, patches: 0, trashRemoved: 0 }
  const parent = join(baseDir, rootDigest(root))
  if (!existsSync(parent)) return stats
  if (removal === 'sync') stats.trashRemoved = removeTrashSync(parent, log)
  else removeLeftoverTrash(parent, log)
  const now = Date.now()
  for (const entry of ownerDirs(parent)) {
    const pid = Number(entry)
    if (pid === process.pid) continue
    if (processAlive(pid)) continue
    const ownerDir = join(parent, entry)
    const prior = readSalvageAttempts(ownerDir)
    if (!salvageAttemptDue(prior, now)) {
      // No git work and no attempt counted: the failure is recent, and burning the
      // remaining attempts seconds apart would delete the work far too soon.
      const ageSeconds = Math.round((now - prior.lastAttemptAt) / 1000)
      stats.kept += 1
      log(
        `skipping dead owner ${String(pid)} at ${ownerDir}: its last salvage attempt failed ${String(ageSeconds)}s ago, ` +
          `and the next is due after ${String(Math.round(SWEEP_INTERVAL_MS / 1000))}s`,
      )
      continue
    }
    const salvage = salvageOwner(ownerDir, { root, patchDir, log, pid, salvaged: prior.salvaged })
    if (salvage.patches > 0) stats.salvaged += 1
    stats.patches += salvage.patches
    if (caches !== undefined) rescueDeadCaches(ownerDir, caches, log)
    const result = finishDeadOwner(ownerDir, { parent, pid, log, prior, salvage, removal })
    if (result.status === 'removed') stats.removed += 1
    else stats.kept += 1
  }
  // The stable layout: a default-layout server's slots, and the trees it retired, are not
  // under a pid directory at all, so the dead ones are found by their locks instead. A live
  // server's slots and retired trees hold a lock of their own and are skipped there.
  const stable = sweepStableSlots(root, { patchDir, baseDir, log, removal, caches, owner, includeStable, commandLineOf, linkLock, beforeSweep })
  stats.removed += stable.removed
  stats.kept += stable.kept
  stats.patches += stable.patches
  if (stable.patches > 0) stats.salvaged += 1
  return stats
}

/**
 * The deferred sweep's form of `sweepDeadOwners`: the same order and the same decisions,
 * but it yields to the event loop between dead owners and between slots.
 *
 * A server that starts with `deferStartupSweep` answers `initialize` before this runs, and
 * the client's 30 s connect timeout must not run out while a salvage walks a large tree.
 * Yielding is what keeps the event loop free for protocol messages; it is not a speed-up.
 * The pass stops as soon as the pool is closed.
 *
 * @param {string} root - the canonical service root.
 * @param {object} options - where to put salvaged patches and how to report.
 * @param {string} options.patchDir - the root's patch directory.
 * @param {string} [options.baseDir] - the state base directory.
 * @param {(message: string) => void} [options.log] - progress log.
 * @param {() => boolean} [options.stopped] - whether the pool has closed.
 * @param {object} [options.caches] - the cache store policy, as `sweepDeadOwners` takes it.
 * @param {{pid: number, instance: string, command: string}} options.owner - this
 *   pass's lock identity for the stable layout.
 * @param {boolean} [options.includeStable] - also take dead stable slot directories.
 * @param {(pid: number) => string | null} [options.commandLineOf] - `processCommandLine`.
 * @param {(tree: object) => void} [options.beforeSweep] - a test hook between plan and lock.
 * @returns {Promise<{salvaged: number, kept: number, removed: number, patches: number,
 *   stopped: boolean}>} what the pass did, for the one-line summary.
 */
async function sweepDeadOwnersLater(
  root,
  { patchDir, baseDir = stateBaseDir(), log = () => {}, stopped = () => false, caches, owner, includeStable = false, commandLineOf = processCommandLine, linkLock = linkSync, beforeSweep } = {},
) {
  const stats = { salvaged: 0, kept: 0, removed: 0, patches: 0, stopped: false }
  const parent = join(baseDir, rootDigest(root))
  if (!existsSync(parent)) return stats
  removeLeftoverTrash(parent, log)
  const now = Date.now()
  for (const entry of ownerDirs(parent)) {
    if (stopped()) {
      stats.stopped = true
      return stats
    }
    const pid = Number(entry)
    if (pid === process.pid || processAlive(pid)) continue
    const ownerDir = join(parent, entry)
    const prior = readSalvageAttempts(ownerDir)
    if (!salvageAttemptDue(prior, now)) {
      const ageSeconds = Math.round((now - prior.lastAttemptAt) / 1000)
      stats.kept += 1
      log(
        `skipping dead owner ${String(pid)} at ${ownerDir}: its last salvage attempt failed ${String(ageSeconds)}s ago, ` +
          `and the next is due after ${String(Math.round(SWEEP_INTERVAL_MS / 1000))}s`,
      )
      continue
    }
    const salvage = await salvageOwnerLater(ownerDir, { root, patchDir, log, pid, prior, stopped })
    if (salvage.patches > 0) stats.salvaged += 1
    stats.patches += salvage.patches
    if (salvage.stopped) {
      stats.stopped = true
      return stats
    }
    if (caches !== undefined) rescueDeadCaches(ownerDir, caches, log)
    const result = finishDeadOwner(ownerDir, { parent, pid, log, prior, salvage })
    if (result.status === 'removed') stats.removed += 1
    else stats.kept += 1
    // Between dead owners too: one owner with many slots must not monopolise the loop.
    await new Promise((resolveTick) => setImmediate(resolveTick))
  }
  const stable = await sweepStableSlotsLater(root, { patchDir, baseDir, log, caches, stopped, owner, includeStable, commandLineOf, linkLock, beforeSweep })
  stats.removed += stable.removed
  stats.kept += stable.kept
  stats.patches += stable.patches
  if (stable.patches > 0) stats.salvaged += 1
  if (stable.stopped) stats.stopped = true
  return stats
}

/**
 * Decide what happens to one dead owner now that its slots were offered to salvage.
 *
 * A clean pass removes the owner. A pass in which any slot threw keeps it, records the
 * failure, when it happened and the slots already stored, and lets a later sweep try
 * again — a transient error must not be the end of the work, and `salvageAttemptDue` keeps
 * the retries minutes apart. After `SALVAGE_MAX_ATTEMPTS` failures the trees go anyway,
 * because an owner that cannot be read forever is a disk leak; the log then names every
 * slot whose work is lost, so the caller is not left guessing.
 *
 * @param {string} ownerDir - the dead owner's per-pid directory.
 * @param {object} options - where the trash belongs and what this pass found.
 * @param {string} options.parent - the digest directory that holds the owner.
 * @param {number} options.pid - the dead owner's pid.
 * @param {(message: string) => void} options.log - progress log.
 * @param {{attempts: number, salvaged: string[], lastAttemptAt: number}} options.prior -
 *   the previous record.
 * @param {{patches: number, failed: {name: string, slotDir: string, message: string}[],
 *   stored: string[]}} options.salvage - this pass's outcome.
 * @param {'sync' | 'background'} [options.removal] - how the trash is deleted.
 * @returns {{status: 'removed' | 'kept', patches: number}} what happened to the owner.
 */
function finishDeadOwner(ownerDir, { parent, pid, log, prior, salvage, removal = 'background' }) {
  const { patches, failed, stored } = salvage
  if (failed.length === 0) {
    const removed = removeDeadOwnerDir(ownerDir, { parent, pid, log, removal })
    return { status: removed ? 'removed' : 'kept', patches }
  }
  const attempts = prior.attempts + 1
  const unsalvaged = failed.map((entry) => entry.slotDir).join(', ')
  if (attempts < SALVAGE_MAX_ATTEMPTS) {
    writeSalvageAttempts(ownerDir, { attempts, salvaged: [...new Set([...prior.salvaged, ...stored])], lastAttemptAt: Date.now() }, log)
    log(
      `keeping dead owner ${String(pid)} at ${ownerDir}: salvage attempt ${String(attempts)} of ` +
        `${String(SALVAGE_MAX_ATTEMPTS)} could not read ${unsalvaged}; ` +
        `the next attempt is due in ${String(Math.round(SWEEP_INTERVAL_MS / 60000))} minutes`,
    )
    return { status: 'kept', patches }
  }
  log(
    `removing dead owner ${String(pid)} at ${ownerDir} after ${String(attempts)} failed salvage attempts: ` +
      `the work in ${unsalvaged} could not be salvaged and is lost`,
  )
  const removed = removeDeadOwnerDir(ownerDir, { parent, pid, log, removal })
  return { status: removed ? 'removed' : 'kept', patches }
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
 * @returns {{patchId: string, diffstat: string, task?: object} | null} the stored patch, or null.
 */
function salvageSlot(slotDir, { root, patchDir, pid, sweptAt, log = () => {} }) {
  const scope = readScopeMarker(slotDir)
  const repoDir = scope === '' ? slotDir : join(slotDir, scope)
  if (!isGitWorkTree(repoDir)) return null
  const base = findFlashBase(repoDir)
  if (base === null) return null
  // Read before the tree is diffed, from the copy's own git directory: it names the task
  // the dead worker was doing, which is the one fact its files cannot tell the caller.
  const task = readSalvagedTask(repoDir, log)
  // The nested repositories the base staged as files are staged the same way here, or the
  // dead worker's edits inside them would be lost with the tree.
  const nested = readNestedFile(repoDir)
  git(['add', '-A', ...excludingPaths(repoDir, nested)], repoDir)
  if (nested.length === 0 && git(['status', '--porcelain'], repoDir).trim() === '') return null
  return withNestedIndex(repoDir, nested, base, (env, unread) => {
    // The dead tree is removed once it is salvaged, so a nested repository that cannot be
    // read now is lost with it; the rest of the work is still stored, and the loss is named.
    for (const { path, reason } of unread) {
      log(
        `the changes inside nested repository ${path} of the dead tree ${slotDir} could not be read (${reason}) ` +
          'and are not in its salvaged patch; they are lost when the dead tree is removed',
      )
    }
    // The top's status cannot see inside a nested repository, so with one the diff decides.
    if (nested.length > 0 && gitAllowFailure(['diff', '--cached', '--quiet', base], repoDir, env).status === 0) return null
    return storeSalvagedPatch(repoDir, { slotDir, root, patchDir, pid, sweptAt, log, scope, base, task, env })
  })
}

/**
 * Store a dead slot's staged change as a patch and its record; `salvageSlot`'s second half.
 *
 * @param {string} repoDir - the dead copy's repository, already staged.
 * @param {object} options - the record's facts, and the environment naming the staged index.
 * @returns {{patchId: string, diffstat: string, task?: object}} the stored patch.
 * @throws {Error} when git cannot produce the diff.
 */
function storeSalvagedPatch(repoDir, { slotDir, root, patchDir, pid, sweptAt, log, scope, base, task, env }) {
  const patchId = `flash-${randomUUID()}`
  const patchPath = join(patchDir, `${patchId}.patch`)
  const metaPath = join(patchDir, `${patchId}.json`)
  const diff = git(['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', base], repoDir, env)
  const diffstat = git(['diff', '--cached', '--stat', '--no-color', base], repoDir, env).trim()
  const filesChanged = nameStatusRecords(repoDir, base, env)
  mkdirSync(patchDir, { recursive: true })
  // Same commit protocol as `collect`: patch, then the blobs a later merge needs, then the
  // record. The dead slot is about to be removed with its owner, so the blobs get exactly
  // the same one chance to be saved.
  writeFileSync(patchPath, diff)
  const preimage = savePreimageBlobs(repoDir, base, patchDir, patchId, log, env)
  const record = {
    patchId,
    patchPath,
    metaPath,
    storeDir: patchDir,
    root,
    scope,
    base,
    // The dead copy still has the base commit, so the caller's HEAD it started from can be
    // recorded here too; after the tree is removed it is no longer readable anywhere.
    baseParent: resolveBaseParent(base, repoDir) ?? null,
    filesChanged,
    diffstat,
    createdAt: Date.now(),
    appliedAt: null,
    // Where this patch came from, so a log line or a listing has an answer to "whose
    // tree was this, and when did we find it?".
    salvagedFrom: { pid, slotDir, sweptAt },
  }
  if (preimage !== undefined) record.preimage = preimage
  if (task !== undefined) record.task = task
  writePatchMeta(record)
  return { patchId, diffstat, ...(task === undefined ? {} : { task }) }
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
 * How much standard output one git command may hand back.
 *
 * `execFileSync` stops at 1 MiB by default and kills the child with ENOBUFS. A three-way
 * apply reads every merged file whole through `cat-file`, so a file past 1 MiB (a lock
 * file, a generated schema) failed the apply partway through with nothing but
 * "git cat-file … failed": the spawn error carries no stderr. The cap stays finite so a
 * runaway command still ends.
 */
const GIT_MAX_BUFFER = 1024 * 1024 * 1024

/**
 * The message git's failure carries, whichever form the spawn error holds it in.
 *
 * Without `encoding` the error's stderr is a Buffer, and reading only strings dropped
 * every byte-mode failure's reason. A spawn that ran out of output buffer has no stderr
 * at all, so its code is named instead. Nor has one whose output git wrote in full but
 * V8 could not decode: a string stops at about 512 MiB (0x1fffffe8 characters) whatever
 * `maxBuffer` allows, and the decoding error carries only a code.
 *
 * @param {unknown} error - what `execFileSync` threw.
 * @returns {string} the reason, or `''` when there is none.
 */
function gitFailureReason(error) {
  const raw = error?.stderr
  const stderr = typeof raw === 'string' ? raw.trim() : Buffer.isBuffer(raw) ? raw.toString('utf8').trim() : ''
  if (stderr.length > 0) return stderr
  if (error?.code === 'ENOBUFS') return `its output was larger than ${String(GIT_MAX_BUFFER)} bytes`
  if (error?.code === 'ERR_STRING_TOO_LONG') return 'its output was larger than a string can hold'
  return ''
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
      maxBuffer: GIT_MAX_BUFFER,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(input === undefined ? {} : { input }),
    })
  } catch (error) {
    const stderr = gitFailureReason(error)
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
    return execFileSync('git', args, { cwd, env, maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const stderr = gitFailureReason(error)
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
    const stdout = execFileSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return {
      status: typeof error?.status === 'number' ? error.status : 1,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      // A spawn error (no output buffer left, output too long for a string) has no stderr,
      // and its reason is all a caller reporting the failure has to go on.
      stderr: gitFailureReason(error),
    }
  }
}

/**
 * Write a patch's record next to it, keeping only the fields a restart must trust.
 *
 * `patchPath` and `metaPath` are derivable from the patch directory and the id, so they
 * are not persisted; `salvagedFrom`, `task` and `finalMessage` are persisted only when they
 * exist, so an ordinary patch's record keeps its previous shape and a record written before
 * these fields existed stays readable.
 *
 * `baseParent` is the one fact that exists only in the disposable copy: the base commit's
 * parent is the caller's HEAD at copy time, and the copy is emptied after the call. A
 * record that did not persist it reported `commitsBehind: null` after a restart, so it is
 * written whenever it names a commit. `appliedFiles` is written once a partial apply has
 * recorded its files; a record without one keeps its old shape.
 *
 * @param {object} record - the record to store.
 * @returns {void}
 */
function writePatchMeta(record) {
  const {
    patchId,
    root,
    base,
    baseParent,
    filesChanged,
    diffstat,
    createdAt,
    appliedAt,
    appliedFiles,
    salvagedFrom,
    preimage,
    task,
    finalMessage,
    finalMessageTruncated,
    reportPath,
    cancelled,
    basePatch,
  } = record
  const meta = { patchId, root, base, filesChanged, diffstat, createdAt, appliedAt }
  // The parent commit is the caller's HEAD at copy time. It is persisted exactly when it
  // is known, because a record read after a restart has no copy left to resolve it from.
  if (typeof baseParent === 'string' && baseParent.length > 0) meta.baseParent = baseParent
  if (Array.isArray(appliedFiles) && appliedFiles.length > 0) meta.appliedFiles = [...new Set(appliedFiles)].sort()
  if (salvagedFrom !== undefined) meta.salvagedFrom = salvagedFrom
  // Persisted only for a nested repository, so a whole-root record keeps its old shape and
  // a restarted service still applies a scoped patch inside the repository it came from.
  if (record.scope) meta.scope = record.scope
  // The base entries a three-way merge rebuilds its index from. Persisted only when they
  // were saved: a record whose saving failed (or that predates saving) must stay readable
  // and must let the merge report that the base is unavailable rather than merge wrongly.
  if (Array.isArray(preimage)) meta.preimage = preimage
  // Who the work was for, and what the worker said when it finished. A record that has
  // neither says exactly what a record always said.
  if (task !== undefined) meta.task = task
  if (typeof finalMessage === 'string') meta.finalMessage = finalMessage
  if (finalMessageTruncated === true) meta.finalMessageTruncated = true
  // Where the whole report lives, and which cancelled job the patch was salvaged from.
  if (typeof reportPath === 'string') meta.reportPath = reportPath
  if (cancelled !== undefined) meta.cancelled = cancelled
  // The patch this one continued from, so a later reader can tell the earlier patch is contained in it.
  if (typeof basePatch === 'string') meta.basePatch = basePatch
  writeFileSync(record.metaPath, `${JSON.stringify(meta, null, 2)}\n`)
}

/** The suffix of a call's whole-report file, next to the patch records. */
const REPORT_SUFFIX = '.report.json'

/** The keys a report is stored under: a job id or a call's session id, never a path. */
const REPORT_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/**
 * The temporary name a report write uses before its rename: `.<key>.<uuid>.tmp`.
 *
 * Nothing else in a report directory matches it, so a prune can tell a half-written report
 * from a stored one and from any other file a reader may have put there.
 */
const REPORT_TEMP_NAME = /^\.[A-Za-z0-9][A-Za-z0-9_-]*\.[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/

/**
 * How long a report write's temporary file may sit before a prune removes it.
 *
 * A report is written to `.<key>.<uuid>.tmp` in the same directory and renamed into place;
 * a crash between the two leaves the temporary file behind forever, because no reader opens
 * it and nothing else knows its name. An hour is far longer than any write takes, so a prune
 * only ever removes a temporary file whose writer died, never one a live server is about to
 * rename into place.
 */
const REPORT_TEMP_MAX_AGE_MS = 60 * 60 * 1000

/**
 * Where one call's whole report lives.
 *
 * @param {string} patchDir - the directory the patch records are stored in.
 * @param {string} key - the job id, or the session id of a call that had no job.
 * @returns {string} the report's path.
 * @throws {Error} when the key could be a path.
 */
export function reportFilePath(patchDir, key) {
  if (typeof key !== 'string' || !REPORT_KEY.test(key)) throw new Error(`${JSON.stringify(key)} is not a report key`)
  return join(patchDir, `${key}${REPORT_SUFFIX}`)
}

/**
 * Read one report file, or undefined when it is missing or not a report.
 *
 * @param {string} path - the report file.
 * @returns {object | undefined} the parsed record.
 */
function readReportFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && typeof parsed.report === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
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
 * Which copy-on-write clone a platform's filesystem offers, as Node names it.
 *
 * Linux's Btrfs and XFS clone a file with a reflink; Node's `COPYFILE_FICLONE_FORCE` asks
 * for exactly that and nothing else. Windows has neither, and a forced clone there fails
 * once per file before the plain copy runs — so it starts as a plain copy and never asks.
 * macOS also starts as a plain copy: APFS's `clonefile` exists, but Node answers
 * `COPYFILE_FICLONE_FORCE` with `ENOSYS` even there, so asking would only log a fallback
 * on every single copy. Linux is the only platform where the flag can succeed.
 *
 * There is no `cp` in this path at all: the copy is Node's own, so a platform without the
 * flag cannot print an option error and no child's stderr can reach the caller. A failed
 * clone is reported through `onCloneFallback`, once per server by the pool.
 *
 * @param {string} platform - `process.platform`, or an injected one in tests.
 * @returns {'clone' | 'copy'} the mechanism the first file attempt uses.
 */
function copyMechanism(platform) {
  return platform === 'linux' ? 'clone' : 'copy'
}

/**
 * Copy the contents of one directory into another.
 *
 * The clone is attempted first: on a filesystem with reflink support (Btrfs, XFS) a
 * cloned file shares every block with the source until one side writes, so a large
 * repository copies instantly and costs nothing. The first file that cannot be cloned
 * switches the rest of the tree to a plain copy, which is correct and slower; the switch
 * is reported once through `options.onCloneFallback`, naming `COPYFILE_FICLONE_FORCE`
 * and the error code, never on standard error. On macOS Node answers the forced clone
 * with ENOSYS even on APFS, so there it is a plain copy from the first file.
 * Windows starts as a plain copy (see `copyMechanism`).
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
 *   the junction fallback, and another platform to choose the clone mechanism.
 * @param {(platform: string, code: string) => void} [options.onCloneFallback] - called once,
 *   when the first clone attempt fails and the rest of the tree is copied plainly, with the
 *   platform and the error code (`ENOSYS`, `EXDEV`, …). The pool turns it into one log line
 *   per server.
 * @param {string[]} [options.exclude] - normalized exclude entries (see `normalizeExclude`).
 * @param {(relPath: string) => {omit: boolean, reason?: string}} [options.consider] - asked once
 *   per matched path whether it may be left out; the git-safety decision lives with the caller.
 * @returns {{mechanism: 'clone' | 'copy', skipped: string[], vanished: number,
 *   excluded: string[], kept: {path: string, reason?: string}[], linksRepointed: number,
 *   repointed: string[], linksSkipped: {path: string, target: string, reason: string}[],
 *   repositories: string[]}} which mechanism was used,
 *   the directories left out, how many entries vanished mid-walk, which entries were excluded,
 *   how many absolute links were re-pointed into the copy, which links could not be
 *   recreated for the copy, and the nested directories with their own `.git` directory that
 *   were copied (relative to `from`, with `/` separators, parents before children).
 */
export function copyTree(from, to, { fs = {}, exclude = [], consider, platform = process.platform, onCloneFallback } = {}) {
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
  let mechanism = copyMechanism(platform)
  // The first file that cannot be cloned is the one fact worth reporting; the hundreds
  // after it are the same fallback, and the pool logs it once per server.
  let fallbackReported = false
  const skipped = []
  const excluded = []
  const kept = []
  const linksSkipped = []
  const repointed = []
  const repositories = []
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
        if (!fallbackReported) {
          fallbackReported = true
          onCloneFallback?.(platform, error?.code ?? 'unknown')
        }
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
          // Named for `prepare`: the top repository's diff cannot see inside a nested
          // repository, so the copy has to stage its files itself (see `stageNestedRepositories`).
          // Nothing inside a git directory is a work tree of its own.
          const parts = relPath.split(sep)
          if (!parts.includes('.git') && hasGitDirectory(sourcePath)) repositories.push(parts.join('/'))
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
  return { mechanism, skipped, vanished, excluded, kept, linksRepointed: repointed.length, repointed, linksSkipped, repositories }
}

/**
 * Whether a directory is the top of a repository with its own `.git` directory.
 *
 * A `.git` file (a submodule or a linked worktree) or a symlink is not counted: its git
 * state lives elsewhere, and `gitLinkTravels` already decides what happens to it.
 *
 * @param {string} dir - a directory.
 * @returns {boolean} true when `dir/.git` is a real directory.
 */
function hasGitDirectory(dir) {
  try {
    return lstatSync(join(dir, '.git')).isDirectory()
  } catch {
    return false
  }
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
 * Read one settings object, one bad key at a time.
 *
 * A settings file is convenience configuration, not a contract: an unknown key, a value of
 * the wrong type or a file that is not JSON at all is named in one log line and ignored, so
 * a typo cannot keep the service from starting. The label names both the file and, for a
 * section, the platform, so a line like `.flash-agents.local.json platform.win32: …` says
 * exactly where the typo is.
 *
 * @param {object} parsed - a plain settings object.
 * @param {string} label - the file and section these keys came from.
 * @param {(message: string) => void} log - where to name a problem.
 * @returns {{copyExclude?: string[], copyExcludeDefaults?: boolean, slotEnv?: object,
 *   slotSetup?: object[]}} the settings that did pass.
 */
function readSettingsObject(parsed, label, log) {
  const settings = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'copyExclude') {
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
        log(`${label}: copyExclude must be an array of strings; ignoring it`)
        continue
      }
      settings.copyExclude = value
    } else if (key === 'copyExcludeDefaults') {
      if (typeof value !== 'boolean') {
        log(`${label}: copyExcludeDefaults must be true or false; ignoring it`)
        continue
      }
      settings.copyExcludeDefaults = value
    } else if (key === 'stateBase') {
      // Read at start-up by index.js to choose the state base; it is a valid key of the
      // local file but is not a copy setting, so the pool neither applies nor warns about it.
      continue
    } else if (key === 'slotEnv') {
      // `null` is accepted here because a later layer uses it to remove an earlier entry;
      // the merge drops it. A pool option, which has no earlier layers, does not accept it.
      if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !Object.values(value).every((entry) => typeof entry === 'string' || entry === null)
      ) {
        log(`${label}: slotEnv must be an object of string values; ignoring it`)
        continue
      }
      settings.slotEnv = value
    } else if (key === 'slotSetup') {
      if (!Array.isArray(value)) {
        log(`${label}: slotSetup must be an array of setup steps; ignoring it`)
        continue
      }
      const steps = []
      for (const [index, entry] of value.entries()) {
        const step = readSetupStep(entry, `${label}: slotSetup[${String(index)}]`, log)
        if (step !== undefined) steps.push(step)
      }
      // A setting whose every entry was refused is not a setting at all: keeping an empty
      // array would make the server announce a setup that can never run.
      if (steps.length > 0) settings.slotSetup = steps
    } else {
      log(`${label}: ${key} is not a known setting; ignoring it`)
    }
  }
  return settings
}

/**
 * Read the `platform` sections of one settings file.
 *
 * Every known section is validated, because a typo in the section for another machine is
 * still worth naming when the file is read; only the section for the running platform is
 * kept, and the caller applies it. Unknown names, sections that are not objects and a
 * `platform` key nested inside a section are all named and dropped.
 *
 * @param {unknown} value - the raw value of the top-level `platform` key.
 * @param {string} label - the file name, for the log line.
 * @param {(message: string) => void} log - where to name a problem.
 * @returns {Map<string, object>} accepted sections, by platform name.
 */
function readPlatformSections(value, label, log) {
  const sections = new Map()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    log(`${label}: platform must be an object keyed by process.platform name; ignoring it`)
    return sections
  }
  for (const [name, section] of Object.entries(value)) {
    if (!PLATFORM_NAMES.has(name)) {
      log(`${label}: platform.${name} is not a known platform; ignoring it`)
      continue
    }
    if (section === null || typeof section !== 'object' || Array.isArray(section)) {
      log(`${label} platform.${name}: the platform section must be an object; ignoring it`)
      continue
    }
    sections.set(name, readSettingsObject(section, `${label} platform.${name}`, log))
  }
  return sections
}

/**
 * Read one settings file and parse its top-level keys and platform sections.
 *
 * A file that does not exist is simply the common case and is not a problem. A file that
 * exists but cannot be read or parsed is named and contributes nothing, while `present`
 * still records that it exists so the caller can tell it from no file at all. `problem`
 * says why such a file was unusable, so a pool that re-reads it can keep the settings it
 * last had and tell the caller, instead of silently dropping them. `hash` is the content's
 * digest, so a file that was only touched is not re-applied.
 *
 * @param {string} path - absolute path to the file.
 * @param {string} label - the file name the log lines should use.
 * @param {(message: string) => void} log - where to name a problem.
 * @returns {{present: boolean, hash?: string, problem?: string, settings: object,
 *   sections: Map<string, object>}} the file's accepted top-level settings and platform sections.
 */
function readSettingsFile(path, label, log) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false, settings: {}, sections: new Map() }
    log(`ignoring ${path}: ${messageOf(error)}`)
    return { present: true, problem: `it could not be read (${messageOf(error)})`, settings: {}, sections: new Map() }
  }
  const hash = createHash('sha256').update(raw).digest('hex')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    log(`ignoring ${path}: it is not valid JSON (${messageOf(error)})`)
    return { present: true, hash, problem: `it is not valid JSON (${messageOf(error)})`, settings: {}, sections: new Map() }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log(`ignoring ${path}: the settings must be a JSON object`)
    return { present: true, hash, problem: 'the settings must be a JSON object', settings: {}, sections: new Map() }
  }
  let settings = {}
  let sections = new Map()
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'platform') {
      sections = readPlatformSections(value, label, log)
    } else {
      // Keep the top-level keys separate from `platform`; the same reader validates both.
      settings = { ...settings, ...readSettingsObject({ [key]: value }, label, log) }
    }
  }
  return { present: true, hash, settings, sections }
}

/**
 * Layer the shared and per-machine settings files for this platform.
 *
 * Layers, lowest first: `.flash-agents.json`, its `platform.<current>` section,
 * `.flash-agents.local.json`, its `platform.<current>` section. The pool options are
 * applied later by `mergeSlotEnv` and `#buildSettings`. Lists append in that order and the
 * last `copyExcludeDefaults` wins; `slotEnv` is merged there too, by variable name.
 *
 * The files are read by the pool, not here: it keeps what each file last parsed to, so a
 * file that has turned invalid since can still contribute the settings it had before.
 *
 * @param {{file: string, parsed: {present: boolean, settings: object,
 *   sections: Map<string, object>}}[]} files - each file's parsed content, shared first.
 * @param {string} platform - `process.platform`; chooses the sections to apply.
 * @returns {{present: boolean, layers: string[], copyExclude: string[],
 *   copyExcludeDefaults?: boolean, slotEnvLayers: {label: string, values: object}[],
 *   slotSetup: object[]}} the accepted layers, in order.
 */
function layerRepoSettings(files, platform) {
  const result = {
    present: false,
    layers: [],
    copyExclude: [],
    copyExcludeDefaults: undefined,
    slotEnvLayers: [],
    slotSetup: [],
  }
  /** Whether some accepted key actually applies, so an empty layer is not announced. */
  const isLayerPresent = (settings) =>
    (settings.copyExclude?.length ?? 0) > 0 ||
    settings.copyExcludeDefaults !== undefined ||
    Object.keys(settings.slotEnv ?? {}).length > 0 ||
    (settings.slotSetup?.length ?? 0) > 0
  const addLayer = (label, settings) => {
    if (!isLayerPresent(settings)) return
    result.layers.push(label)
    if (settings.copyExclude !== undefined) result.copyExclude.push(...settings.copyExclude)
    // The last layer that sets it wins, including a platform section over its own file.
    if (settings.copyExcludeDefaults !== undefined) result.copyExcludeDefaults = settings.copyExcludeDefaults
    if (settings.slotEnv !== undefined) result.slotEnvLayers.push({ label, values: settings.slotEnv })
    if (settings.slotSetup !== undefined) result.slotSetup.push(...settings.slotSetup)
  }
  for (const { file, parsed } of files) {
    if (parsed.present) result.present = true
    addLayer(file, parsed.settings)
    const section = parsed.sections.get(platform)
    if (section !== undefined) addLayer(`${file} platform.${platform}`, section)
  }
  return result
}

/**
 * Whether a directory holds at least one file anywhere below it.
 *
 * Empty folders do not count: `prepare` creates the folders a `cache:` entry names before
 * anything has written to them, and such a cache is as cold as none at all. The walk stops
 * at the first file, so a warm cache of tens of gigabytes costs a few directory reads.
 *
 * @param {string} dir - the directory to look into.
 * @returns {boolean} true when anything that is not a directory exists below it.
 */
function holdsAnyFile(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) return true
    if (holdsAnyFile(join(dir, entry.name))) return true
  }
  return false
}

/**
 * Say once, at start, when the per-machine settings file git would commit anyway.
 *
 * The local file is meant for one computer, so a tracked one is a mistake that would leak
 * a machine-specific path into every checkout, and an untracked, unignored one is one
 * `git add -A` away from the same. The check only makes sense inside a git work tree; a
 * plain directory has no index and no .gitignore and logs nothing. `git check-ignore`
 * positive means ignored; the tracked check comes first because a force-added file is also
 * ignored.
 *
 * @param {string} root - the service root.
 * @param {string} path - absolute path to `.flash-agents.local.json`.
 * @param {(message: string) => void} log - where to say it.
 * @returns {void}
 */
function warnLocalSettingsTracking(root, path, log) {
  if (!existsSync(path) || !isGitWorkTree(root)) return
  if (gitTracksUnder(root, LOCAL_SETTINGS_FILE)) {
    log(`${path} is tracked by git, but it is meant for one machine; remove it from the index and add it to .gitignore`)
  } else if (!gitCheckIgnore(root, LOCAL_SETTINGS_FILE)) {
    log(`${path} is not ignored by git; add .flash-agents.local.json to .gitignore so it is not committed`)
  }
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
 * Merge the per-slot environment over every settings layer and the pool options,
 * validating each entry.
 *
 * Layers are applied lowest first, so a later file, a platform section or a pool option
 * wins per variable. Windows environment names are case-insensitive and Linux's are not,
 * so the merge folds case only on `win32`: there `Path` replaces `PATH`, elsewhere both
 * stay. A `null` value in a later file layer removes the entry from the earlier layers (in
 * the first layer it is a no-op); an option may not use `null`.
 *
 * A name that may not be redirected (see FORBIDDEN_SLOT_ENV and LOADER_SLOT_ENV), a value
 * that is not `home:<name>`, `cache:<name>`, `port:<base>[/<stride>]` or `value:<text>`, a
 * `<name>` that is not one path segment, a `value:` over the Windows limit or holding a
 * NUL, or a port range whose highest slot would not fit below 65536 is named with its file
 * and section and dropped; the entry never makes it into the environment the worker boots
 * with.
 *
 * @param {{label: string, values: object}[]} fromLayers - each settings layer's `slotEnv`,
 *   lowest first.
 * @param {unknown} fromOptions - the `slotEnv` pool option, if any.
 * @param {(message: string) => void} log - where to name a rejected entry.
 * @param {number} slotCount - one past the highest slot number the pool holds (its slot
 *   count, unless another server on the root already holds the lower numbers), for the
 *   highest-port check.
 * @param {object} [options] - platform details, injected by tests.
 * @param {string} [options.platform] - `process.platform`; decides the name case rule.
 * @returns {Record<string, {kind: 'home' | 'cache', segment: string} |
 *   {kind: 'port', base: number, stride: number} | {kind: 'value', value: string}>} the
 *   accepted entries.
 */
function mergeSlotEnv(fromLayers, fromOptions, log, slotCount, { platform = process.platform } = {}) {
  const merged = {}
  // On Windows a worker sees `Path` and `PATH` as one variable, so a later layer has to
  // find and replace the earlier spelling instead of creating a second entry.
  const folded = (name) => (platform === 'win32' ? name.toLowerCase() : name)
  const existingKey = (name) => {
    if (platform !== 'win32') return Object.hasOwn(merged, name) ? name : undefined
    const key = folded(name)
    return Object.keys(merged).find((candidate) => folded(candidate) === key)
  }
  const apply = (source, label, { allowNull }) => {
    if (source === undefined || source === null) return
    if (typeof source !== 'object' || Array.isArray(source)) {
      log(
        `ignoring ${label}: slotEnv must be an object of "home:<name>", "cache:<name>", "port:<base>[/<stride>]" or "value:<text>" values`,
      )
      return
    }
    for (const [name, value] of Object.entries(source)) {
      const existing = existingKey(name)
      if (value === null) {
        if (allowNull) {
          if (existing !== undefined) delete merged[existing]
          continue
        }
        // An option has no earlier layer to remove from, so `null` is not a value there.
        log(`ignoring ${label}.${name}: expected "home:<name>", "cache:<name>", "port:<base>[/<stride>]" or "value:<text>", got null`)
        continue
      }
      // Windows environment names are case-insensitive, and a worker on that platform sees
      // `Home` and `HOME` as the same variable; the check has to fold case the same way.
      const upper = name.toUpperCase()
      if (FORBIDDEN_SLOT_ENV.has(upper)) {
        log(`ignoring ${label}.${name}: not redirecting ${name} for the worker: the runtime's sandbox and toolchains depend on it`)
        continue
      }
      // A plain value would reach the runtime process itself, which runs outside the
      // worker's sandbox, so a name that decides which program runs or how code is loaded
      // is refused for every kind — `home:` and `cache:` included, as before.
      if (LOADER_SLOT_ENV.has(upper) || upper.startsWith('LD_') || upper.startsWith('DYLD_')) {
        log(`ignoring ${label}.${name}: not redirecting ${name} for the worker: it changes how the runtime loads programs`)
        continue
      }
      let accepted
      if (typeof value === 'string' && value.startsWith(SLOT_ENV_TEXT)) {
        // Everything after the first `value:` is the variable's text, verbatim: a Windows
        // path, another `:`-bearing value and an empty value are all legitimate.
        const text = value.slice(SLOT_ENV_TEXT.length)
        if (text.includes('\0')) {
          log(`ignoring ${label}.${name}: a value: entry may not contain a NUL character`)
          continue
        }
        if (text.length > SLOT_ENV_TEXT_MAX) {
          log(
            `ignoring ${label}.${name}: a value: entry is ${String(text.length)} characters, ` +
              `over the ${String(SLOT_ENV_TEXT_MAX)}-character limit for one variable`,
          )
          continue
        }
        accepted = { kind: 'value', value: text }
      } else {
        const match = typeof value === 'string' ? SLOT_ENV_VALUE.exec(value) : null
        if (match !== null) {
          if (!isPathSegment(match[2])) {
            log(`ignoring ${label}.${name}: expected "home:<name>" or "cache:<name>" with one path segment, got ${JSON.stringify(value)}`)
            continue
          }
          accepted = { kind: match[1], segment: match[2] }
        } else {
          const port = typeof value === 'string' ? PORT_ENV_VALUE.exec(value) : null
          if (port === null) {
            log(
              `ignoring ${label}.${name}: expected "home:<name>", "cache:<name>", "port:<base>[/<stride>]" or "value:<text>", ` +
                `got ${JSON.stringify(value)}`,
            )
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
          accepted = { kind: 'port', base, stride }
        }
      }
      // Only replace the earlier spelling once the later entry is accepted, so an invalid
      // override cannot silently drop a working earlier variable.
      if (existing !== undefined && existing !== name) delete merged[existing]
      merged[name] = accepted
    }
  }
  for (const layer of fromLayers) apply(layer.values, layer.label, { allowNull: true })
  apply(fromOptions, 'slotEnv', { allowNull: false })
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
 * The nested repositories of a copy that its own diff has to stage file by file.
 *
 * The top repository's `git add -A` records a nested repository with its own `.git`
 * directory as one gitlink at that repository's HEAD, and nothing below it. A worker that
 * edited seven files inside one therefore produced a patch without them, and the copy was
 * emptied after the call: the work was lost and nothing said so. Every such repository is
 * staged here as the plain files of its working tree instead, so its changes are part of
 * the one stored patch and `flash_apply` writes them into the caller's nested repository
 * (its working tree only, as for every other file).
 *
 * Only the "workspace of independent repositories" layout is staged: the repository that
 * contains it (the top, or a staged nested one) tracks nothing at or under its path, and
 * either does not ignore it or ignores exactly that directory (`.gitignore` lists
 * `inner/`). Everything else is left as before:
 *
 * - a path the parent tracks — a gitlink the caller committed on purpose keeps its
 *   pointer semantics;
 * - a repository under a directory the parent ignores, such as `node_modules/x`,
 *   `.build/checkouts/x` or `vendor/x` with `vendor/` ignored: that is build output or a
 *   dependency checkout, which can be large and is not the caller's work;
 * - a directory whose `.git` git cannot read.
 *
 * What is inside a repository left out is left out with it.
 *
 * @param {string} repoDir - the copied repository.
 * @param {string[]} candidates - nested repositories `copyTree` found, parents first.
 * @returns {string[]} the repositories to stage, relative to `repoDir`, parents first.
 */
function stagedRepositories(repoDir, candidates) {
  const accepted = []
  const leftOut = []
  for (const path of candidates) {
    if (!scopeIsSafe(path)) continue
    const parent = [...accepted, ...leftOut]
      .filter((other) => path.startsWith(`${other}/`))
      .sort((left, right) => right.length - left.length)[0]
    if (parent !== undefined && leftOut.includes(parent)) {
      leftOut.push(path)
      continue
    }
    const owner = parent === undefined ? repoDir : join(repoDir, parent)
    const rel = parent === undefined ? path : path.slice(parent.length + 1)
    if (gitOrEmpty(['ls-files', '--', `:(literal)${rel}`], owner) !== '' || ignoredBelowItsParent(owner, rel) || !isGitWorkTree(join(repoDir, path))) {
      leftOut.push(path)
      continue
    }
    accepted.push(path)
  }
  return accepted
}

/**
 * Whether a nested repository lies inside a directory its parent repository ignores.
 *
 * The repository's own directory being ignored is the workspace layout and does not count;
 * any directory between the parent's top and it being ignored does. Git cannot re-include
 * a path under an ignored directory, so a path that is not ignored itself has no ignored
 * ancestor either, and costs one question.
 *
 * @param {string} owner - the parent repository.
 * @param {string} rel - the nested repository, relative to `owner`, with `/` separators.
 * @returns {boolean} true when an ancestor directory of `rel` is ignored.
 */
function ignoredBelowItsParent(owner, rel) {
  if (!gitCheckIgnore(owner, rel)) return false
  const parts = rel.split('/')
  for (let depth = 1; depth < parts.length; depth += 1) {
    if (gitCheckIgnore(owner, parts.slice(0, depth).join('/'))) return true
  }
  return false
}

/**
 * Pathspec arguments for `git add -A` in `dir` that leave the given paths alone.
 *
 * A path `dir` ignores is left alone by `add -A` already, and naming it in a pathspec,
 * even as an exclusion, makes `add` fail with "paths are ignored". So only the paths it
 * would otherwise stage — as a gitlink, or as a failure for a repository with no commit —
 * are excluded.
 *
 * @param {string} dir - where `git add` runs.
 * @param {string[]} paths - nested repositories, relative to `dir`.
 * @returns {string[]} nothing when no path needs it, or `--`, `.` and one literal exclusion each.
 */
function excludingPaths(dir, paths) {
  const staged = paths.filter((path) => !gitCheckIgnore(dir, path))
  return staged.length === 0 ? [] : ['--', '.', ...staged.map((path) => `:(exclude,literal)${path}`)]
}

/**
 * The tree of one nested repository's working tree, as `git add -A` there would stage it.
 *
 * Staged through a private index, like the top repository's base, so the copy's own index
 * of the nested repository stays what the caller's was. Its own ignore rules decide what
 * is in it. The nested repositories inside it that are staged separately are left out.
 *
 * @param {string} dir - the nested repository in the copy.
 * @param {string[]} inner - nested repositories inside it that are staged on their own,
 *   relative to `dir`.
 * @returns {string} the tree id, in the nested repository's object store.
 */
function nestedWorkTree(dir, inner) {
  const indexFile = join(dir, '.git', `flash-index-${randomUUID()}`)
  try {
    const realIndex = join(dir, '.git', 'index')
    if (existsSync(realIndex)) copyFileSync(realIndex, indexFile)
    const env = { ...process.env, GIT_INDEX_FILE: indexFile }
    git(['add', '-A', ...excludingPaths(dir, inner)], dir, env)
    return git(['write-tree'], dir, env).trim()
  } finally {
    rmSync(indexFile, { force: true })
  }
}

/**
 * The working-tree trees of a copy's staged nested repositories.
 *
 * Children are read before their parents. When the base is recorded, a parent leaves out
 * only the children that staged, and a repository git cannot stage is dropped (with
 * everything inside it) for the top repository to treat as it always did: one broken
 * nested repository cannot cost the call its base. At collect time the list is the base's,
 * so `allChildren` makes every parent leave out every listed child, exactly as the base
 * did, and a failure is returned for the caller to cover with the base's own content.
 *
 * @param {string} repoDir - the copied repository.
 * @param {string[]} nested - repositories to stage, parents first.
 * @param {{allChildren?: boolean}} [options] - whether a parent leaves out children that failed.
 * @returns {{trees: Map<string, string>, failed: {path: string, reason: string}[]}} path to
 *   tree id for the ones that staged, and the outermost ones that did not (a failed
 *   repository's children are neither), both parents first.
 */
function nestedTrees(repoDir, nested, { allChildren = false } = {}) {
  const read = new Map()
  const reasons = new Map()
  for (const path of [...nested].reverse()) {
    const inner = nested
      .filter((other) => other.startsWith(`${path}/`) && (allChildren || read.has(other)))
      .map((other) => other.slice(path.length + 1))
    try {
      read.set(path, nestedWorkTree(join(repoDir, path), inner))
    } catch (error) {
      reasons.set(path, messageOf(error))
    }
  }
  const insideFailed = (path) => [...reasons.keys()].some((other) => path.startsWith(`${other}/`))
  return {
    trees: new Map(nested.filter((path) => read.has(path) && !insideFailed(path)).map((path) => [path, read.get(path)])),
    failed: nested.filter((path) => reasons.has(path) && !insideFailed(path)).map((path) => ({ path, reason: reasons.get(path) })),
  }
}

/**
 * Make a copy's nested repositories' objects readable from its top repository.
 *
 * Their trees are read into the top repository's index and diffed there, and the blobs of
 * their files live in their own object stores. The entries are relative to the top's
 * object directory, so they keep working wherever the tree is when it is salvaged.
 *
 * @param {string} repoDir - the copied repository.
 * @param {string[]} nested - its staged nested repositories.
 * @returns {void}
 */
function linkNestedObjects(repoDir, nested) {
  const objects = resolve(repoDir, git(['rev-parse', '--git-path', 'objects'], repoDir).trim())
  const file = join(objects, 'info', 'alternates')
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line !== '') : []
  for (const path of nested) {
    const entry = relative(objects, join(repoDir, path, '.git', 'objects')).split(sep).join('/')
    if (!lines.includes(entry)) lines.push(entry)
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${lines.join('\n')}\n`)
}

/**
 * Copy the objects of the base's nested trees into the top repository's own object store.
 *
 * The alternates of `linkNestedObjects` reach into the nested repositories themselves, and
 * a worker may delete one, or only its `.git`. The base's tree for that path then named
 * objects nobody could read, `read-tree --prefix` of it failed, and the whole change was
 * unavailable for one deleted directory. Packed into the top's store, the base's nested
 * files stay readable for as long as the copy does, so a removed repository reads as its
 * files deleted. Delta search is skipped: the pack lives only as long as the copy, and
 * speed at prepare matters more than its size.
 *
 * Best effort: a failure is logged, and a deleted repository then costs what it did before.
 *
 * @param {string} repoDir - the copied repository, with the nested stores already linked.
 * @param {string[]} trees - the base's tree ids of its staged nested repositories.
 * @param {(message: string) => void} log - where a failure is named.
 * @returns {void}
 */
function packNestedObjects(repoDir, trees, log) {
  if (trees.length === 0) return
  try {
    const objects = resolve(repoDir, git(['rev-parse', '--git-path', 'objects'], repoDir).trim())
    const listed = git(['rev-list', '--objects', ...trees], repoDir)
    git(['pack-objects', '-q', '--window=0', join(objects, 'pack', 'pack')], repoDir, process.env, listed)
  } catch (error) {
    log(`could not copy the nested repositories' base objects into the copy's own store: ${messageOf(error)}`)
  }
}

/**
 * The tree of a former nested repository's files, staged as plain files of the top.
 *
 * A worker that removed only a nested repository's `.git` left its files as ordinary
 * files of the top's tree, and they are diffed as such. They are staged through the top's
 * git directory with the directory as the work tree, so the ignore files inside it still
 * decide what is in it, as the nested repository's own staging did. The listed nested
 * repositories inside it are cleared afterwards for their own staging to fill.
 *
 * @param {string} repoDir - the copied repository.
 * @param {string} path - the former nested repository, relative to `repoDir`.
 * @param {string[]} inner - nested repositories inside it, relative to it.
 * @returns {string} the tree id, in the top repository's object store.
 * @throws {Error} when git cannot stage the directory.
 */
function plainFilesTree(repoDir, path, inner) {
  const gitDir = resolve(repoDir, git(['rev-parse', '--git-dir'], repoDir).trim())
  const indexFile = join(gitDir, `flash-index-${randomUUID()}`)
  try {
    const env = { ...process.env, GIT_INDEX_FILE: indexFile }
    const args = [`--git-dir=${gitDir}`, `--work-tree=${join(repoDir, path)}`]
    git([...args, 'add', '-A'], repoDir, env)
    for (const rel of inner) git([...args, 'rm', '--cached', '-r', '-q', '-f', '--ignore-unmatch', '--', `:(literal)${rel}`], repoDir, env)
    return git([...args, 'write-tree'], repoDir, env).trim()
  } finally {
    rmSync(indexFile, { force: true })
  }
}

/**
 * What the index holds for each of a copy's staged nested repositories at collect time.
 *
 * A repository that reads is staged as its working tree. One whose directory is gone is
 * cleared, so its files read as deleted (their base blobs are in the top's store, see
 * `packNestedObjects`); one whose `.git` alone is gone is staged as the top's plain files,
 * and the listed repositories inside it are resolved the same way in turn. Any other
 * failure is filled with what the base held there and reported as unread.
 *
 * @param {string} repoDir - the copied repository.
 * @param {string[]} nested - the repositories to resolve, parents first.
 * @param {string} base - the base commit.
 * @returns {{entries: Map<string, string>, unread: {path: string, reason: string}[]}} path to
 *   tree id (`''` clears the path), parents first, and the repositories left as they were.
 */
function nestedIndexEntries(repoDir, nested, base) {
  const { trees, failed } = nestedTrees(repoDir, nested, { allChildren: true })
  const entries = new Map(trees)
  const unread = []
  for (const failure of failed) {
    const { path } = failure
    const dir = join(repoDir, path)
    const children = nested.filter((other) => other.startsWith(`${path}/`))
    if (!existsSync(dir)) {
      entries.set(path, '')
      continue
    }
    let reason = failure.reason
    if (!isGitWorkTree(dir)) {
      try {
        entries.set(path, plainFilesTree(repoDir, path, children.map((other) => other.slice(path.length + 1))))
        const inside = nestedIndexEntries(repoDir, children, base)
        for (const [child, tree] of inside.entries) entries.set(child, tree)
        unread.push(...inside.unread)
        continue
      } catch (error) {
        reason = `${reason}; its files could not be staged as the top's either: ${messageOf(error)}`
      }
    }
    // The base's content keeps the patch from carrying its edits or reading as deleting it.
    unread.push({ path, reason })
    entries.set(path, gitOrEmpty(['rev-parse', '--verify', '-q', `${base}:${path}`], repoDir))
  }
  // Parents first, so a child's entries land after its parent's tree.
  return { entries: new Map(nested.filter((path) => entries.has(path)).map((path) => [path, entries.get(path)])), unread }
}

/**
 * Put each nested repository's files into the top repository's index under its path.
 *
 * Whatever the index held there — a gitlink, or entries left by an earlier staging — is
 * removed first, because `read-tree --prefix` refuses a path the index already has.
 *
 * A tree id of `''` stages nothing there: the path is only cleared.
 *
 * @param {string} repoDir - the copied repository.
 * @param {Map<string, string>} trees - path to tree id, parents first.
 * @param {NodeJS.ProcessEnv} env - the environment naming the index to stage into.
 * @returns {void}
 */
function stageNestedRepositories(repoDir, trees, env) {
  for (const [path, tree] of trees) {
    git(['rm', '--cached', '-r', '-q', '-f', '--ignore-unmatch', '--', `:(literal)${path}`], repoDir, env)
    if (tree !== '') git(['read-tree', `--prefix=${path}/`, tree], repoDir, env)
  }
}

/**
 * Run `diff --cached` work against an index that holds the nested repositories' files.
 *
 * `collect` and `salvageSlot` stage the top repository in its real index, as they always
 * did; the nested repositories are added to a private copy of it, so the copy's real index
 * and the ignored-path listing read from it are exactly what they were. Without nested
 * repositories the real index is used and nothing changes.
 *
 * A nested repository that cannot be staged now must not cost the call the rest of its
 * change. A removed one reads as its files deleted, one whose `.git` alone was removed as
 * the top's plain files (see `nestedIndexEntries`). Any other's place in the index is
 * filled with what the base held there, so the patch neither carries its edits nor reads
 * as deleting it, and it is handed to `run` to report.
 *
 * @template T
 * @param {string} repoDir - the copied repository, already staged with `git add -A`.
 * @param {string[]} nested - its staged nested repositories.
 * @param {string} base - the base commit the change is diffed against.
 * @param {(env: NodeJS.ProcessEnv, unread: {path: string, reason: string}[]) => T} run - the
 *   work, given the environment to run git in and the repositories left as they were.
 * @returns {T} what `run` returned.
 */
function withNestedIndex(repoDir, nested, base, run) {
  if (nested.length === 0) return run(process.env, [])
  const indexFile = join(repoDir, '.git', `flash-index-${randomUUID()}`)
  try {
    const realIndex = resolve(repoDir, git(['rev-parse', '--git-path', 'index'], repoDir).trim())
    if (existsSync(realIndex)) copyFileSync(realIndex, indexFile)
    const env = { ...process.env, GIT_INDEX_FILE: indexFile }
    const { entries, unread } = nestedIndexEntries(repoDir, nested, base)
    stageNestedRepositories(repoDir, entries, env)
    return run(env, unread)
  } finally {
    rmSync(indexFile, { force: true })
  }
}

/**
 * Record a copy's staged nested repositories in its own git directory.
 *
 * A dead server's tree is salvaged from the tree alone, and its diff has to stage the same
 * repositories its base did, or every file of one would read as added or deleted. Git
 * never reports a file under `.git`, and it lives exactly as long as the tree.
 *
 * @param {string} repoDir - the copied repository.
 * @param {string[]} nested - its staged nested repositories.
 * @returns {void}
 */
function writeNestedFile(repoDir, nested) {
  const file = join(repoDir, '.git', NESTED_FILE)
  if (nested.length === 0) rmSync(file, { force: true })
  else writeFileSync(file, `${JSON.stringify(nested)}\n`)
}

/**
 * The staged nested repositories a copy recorded; none when the file is missing or unusable.
 * @param {string} repoDir - the copied repository.
 * @returns {string[]} the repositories, relative to `repoDir`.
 */
function readNestedFile(repoDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(repoDir, '.git', NESTED_FILE), 'utf8'))
    // A path is joined onto the tree, so only a plain relative one is trusted.
    return Array.isArray(parsed) && parsed.every((path) => scopeIsSafe(path) && !path.includes('\\')) ? parsed : []
  } catch {
    return []
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
 * The one path slot `<id>` of a root always has: `<stateBase>/<rootDigest>/slots/<id>`.
 *
 * The path depends on the root and the slot number alone, so the copy of the last server on
 * this root is exactly where the next one's copy will be, which is what keeps a build
 * cache's absolute paths valid across a restart. It is also shorter than the older
 * `<pid>/<instance>/slots/slot-<id>`, which matters for Windows' 260-character limit.
 *
 * `baseDir` and `id` exist so a test can name a slot's directory without constructing the
 * pool, the way `defaultStateDir` lets it lay out a dead owner.
 *
 * @param {string} root - the canonical service root.
 * @param {object} [options] - where the layout sits and which slot.
 * @param {string} [options.baseDir] - the state base directory, usually `$TMPDIR/flash-mcp`.
 * @param {number} [options.id] - the slot number (default 0, the first slot).
 * @returns {string} the stable directory of that slot.
 */
export function stableSlotDirectory(root, { baseDir = stateBaseDir(), id = 0 } = {}) {
  return join(baseDir, rootDigest(root), SLOTS_DIRECTORY, String(id))
}

/**
 * The lock file that claims one stable slot: `<slot dir>.lock`.
 * @param {string} slotDir - a stable slot directory, or a retired tree's directory.
 * @returns {string} the lock's path.
 */
export function slotLockPath(slotDir) {
  return `${slotDir}${SLOT_LOCK_SUFFIX}`
}

/**
 * The one line a slot lock file holds.
 * @param {{pid: number, instance: string, command: string}} owner - who holds the slot.
 * @returns {string} the file's content, ready to write.
 */
function slotLockJson({ pid, instance, command }) {
  return `${JSON.stringify({ format: SLOT_LOCK_FORMAT, pid, command: normalizeCommandLine(command), instance })}\n`
}

/**
 * Read and validate the JSON of one slot lock file.
 *
 * A missing file, unreadable JSON, or a pid that is not a positive integer all give
 * `undefined`; `slotHolder` then decides whether an unreadable file is young enough to be a
 * live server's write in progress or old enough to be a dead one's. A lock that has no
 * `command` is one an older build wrote with a start time instead: its owner is judged by
 * the pid alone, exactly as when the platform cannot answer.
 *
 * @param {string} lockPath - the lock file, as `slotLockPath` names it.
 * @returns {{format: number, pid: number, command: string, instance: string} | undefined}
 *   the lock, or undefined when it cannot be read as one.
 */
function readSlotLock(lockPath) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    return undefined
  }
  const pid = Number(parsed?.pid)
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  const command = typeof parsed?.command === 'string' ? normalizeCommandLine(parsed.command) : ''
  const instance = typeof parsed?.instance === 'string' ? parsed.instance : ''
  return { format: Number(parsed?.format), pid, command, instance }
}

/**
 * Whether a lock's owner is still running the process that wrote it.
 *
 * Signal 0 says a pid exists; the recorded command line says it is the *same* process. A
 * pid the operating system reused belongs to a process started with a different command,
 * so the lock is a dead server's even though its pid is alive. The comparison is on the
 * normalised line (`normalizeCommandLine`), so no clock, time zone or DST change can make a
 * live lock look dead. When the recorded command is missing (an older lock) or the live
 * command cannot be read (a platform or a permission that will not answer) the check falls
 * back to the pid alone, as `livePidsIn` does.
 *
 * An answer is cached for `SLOT_LIVENESS_CACHE_MS` per `(pid, recorded command)`, so a
 * sweep that asks about the same lock twice does not spawn a second `ps` or PowerShell.
 * This process's own pid is never looked up through the cache or a child process: its
 * command line is `process.argv` itself.
 *
 * @param {{pid: number, command: string}} lock - the parsed lock.
 * @param {(pid: number) => string | null} commandLineOf - `processCommandLine`, injectable.
 * @returns {boolean} true when the owner is alive and is the process that wrote the lock.
 */
function lockOwnerIsLive(lock, commandLineOf = processCommandLine) {
  if (!processAlive(lock.pid)) return false
  if (lock.command === '') return true
  if (lock.pid === process.pid) return commandIdentity(processCommandLine(process.pid)) === commandIdentity(lock.command)
  const key = `${String(lock.pid)}\u0000${lock.command}`
  const now = Date.now()
  const cached = slotLivenessCache.get(key)
  if (cached !== undefined && now - cached.at <= SLOT_LIVENESS_CACHE_MS) return cached.live
  const liveCommand = commandLineOf(lock.pid)
  const live = typeof liveCommand !== 'string' || liveCommand === '' || commandIdentity(liveCommand) === commandIdentity(lock.command)
  slotLivenessCache.set(key, { live, at: now })
  return live
}

/**
 * Whether a slot is held, and by what.
 *
 * The liveness rule is `lockOwnerIsLive`: alive, and the process that recorded that same
 * command line. A lock file that exists but cannot be read counts as held until its mtime
 * is older than `SLOT_LOCK_GRACE_MS`: a crash between creating the file and writing the
 * line, or an older build that wrote it in place, must not let two workers into one
 * directory, but it must not keep the number forever either.
 *
 * @param {string} slotDir - a stable slot directory, or a retired tree's directory.
 * @param {object} [options] - the command-line source, injectable for tests.
 * @param {(pid: number) => string | null} [options.commandLineOf] - `processCommandLine`.
 * @returns {{live: boolean, lock?: {pid: number, command: string, instance: string},
 *   unreadable?: boolean}} the holder.
 */
function slotHolder(slotDir, { commandLineOf = processCommandLine } = {}) {
  const lockPath = slotLockPath(slotDir)
  let info
  try {
    info = statSync(lockPath)
  } catch {
    return { live: false }
  }
  const lock = readSlotLock(lockPath)
  if (lock === undefined) return { live: Date.now() - info.mtimeMs <= SLOT_LOCK_GRACE_MS, unreadable: true }
  return { live: lockOwnerIsLive(lock, commandLineOf), lock }
}

/**
 * What a directory in one `slots` folder is: a stable slot, a moved-aside dead tree, or a
 * retired tree. `<n>.lock`, salvage records and temp files are not directories and are not
 * classified.
 *
 * @param {string} name - a directory name inside `slots`.
 * @returns {'stable' | 'dead' | 'retired' | undefined} the kind, or undefined for a name
 *   this layout does not use.
 */
function slotTreeKind(name) {
  const match = /^(\d+)(.*)$/.exec(name)
  if (match === null) return undefined
  if (match[2] === '') return 'stable'
  if (match[2].startsWith(DEAD_SLOT_MARKER)) return 'dead'
  if (match[2].startsWith(RETIRED_SLOT_MARKER)) return 'retired'
  return undefined
}

/**
 * Every slot tree of one root digest, live or dead, with the lock that holds it.
 *
 * Only directories count: the `<n>.lock` files sit beside them, and a stale lock left by an
 * interrupted takeover is a file too. Retired and moved-aside dead trees live in the same
 * folder and are included, because a sweep has to salvage them; `kind` says which one a
 * directory is, so a caller can leave the stable slots (and their warm caches) alone.
 *
 * @param {string} digestDir - one `$TMPDIR/flash-mcp/<digest>` directory.
 * @param {object} [options] - the command-line source, injectable for tests.
 * @param {(pid: number) => string | null} [options.commandLineOf] - `processCommandLine`.
 * @returns {{label: string, dir: string, kind: 'stable' | 'dead' | 'retired', pid?: number,
 *   live: boolean, lock?: object}[]} the slot trees, in readdir order.
 */
function slotTreesIn(digestDir, { commandLineOf = processCommandLine } = {}) {
  let entries
  try {
    entries = readdirSync(join(digestDir, SLOTS_DIRECTORY), { withFileTypes: true })
  } catch {
    // No stable slots for this root (or an unreadable folder): nothing to report or sweep.
    return []
  }
  const trees = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const kind = slotTreeKind(entry.name)
    if (kind === undefined) continue
    const dir = join(digestDir, SLOTS_DIRECTORY, entry.name)
    const holder = slotHolder(dir, { commandLineOf })
    trees.push({ label: `${SLOTS_DIRECTORY}/${entry.name}`, dir, kind, pid: holder.lock?.pid, live: holder.live, lock: holder.lock })
  }
  return trees
}

/**
 * Remove the lock files a crash left in one `slots` folder.
 *
 * Three kinds of lock outlive the thing they described and used to accumulate forever: a
 * moved-aside tree's lock (`<n>.dead-*.lock`) after the tree was salvaged, the file a
 * takeover renamed out of the way (`<n>.lock.stale-*`), and a temp file whose writer died
 * before linking it into place (`<n>.lock.tmp-*`). They are swept here, in one pass before
 * a claim or a sweep reads the folder.
 *
 * Only regular files are ever removed, never a directory; a stale or temp file younger than
 * `SLOT_LOCK_GRACE_MS` may belong to another server's write in progress and is left. A
 * `<n>.dead-*`/`<n>.retired-*` lock goes only once its tree is gone, because while the tree
 * exists the lock is what names its dead owner in the salvage record. A plain `<n>.lock` is
 * removed only when its tree is gone too and its owner is not live: a live server's number is
 * never freed by the sweep, and an unreadable young lock keeps its grace.
 *
 * @param {string} slotsDir - `<stateBase>/<rootDigest>/slots`.
 * @param {object} [options] - the clock, the command-line source and the log.
 * @param {number} [options.now] - the current time, for tests.
 * @param {(pid: number) => string | null} [options.commandLineOf] - `processCommandLine`.
 * @param {(message: string) => void} [options.log] - progress log.
 * @returns {number} how many leaked lock files were removed.
 */
function removeLeakedSlotLocks(slotsDir, { now = Date.now(), commandLineOf = processCommandLine, log = () => {} } = {}) {
  let entries
  try {
    entries = readdirSync(slotsDir, { withFileTypes: true })
  } catch {
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const lockPath = join(slotsDir, entry.name)
    const isTemp = entry.name.includes(`${SLOT_LOCK_SUFFIX}${SLOT_LOCK_TEMP_MARKER}`)
    const isStale = entry.name.includes(`${SLOT_LOCK_SUFFIX}${SLOT_LOCK_STALE_MARKER}`)
    if (isTemp || isStale) {
      let age
      try {
        age = now - statSync(lockPath).mtimeMs
      } catch {
        continue
      }
      if (age <= SLOT_LOCK_GRACE_MS) continue
    } else {
      if (!entry.name.endsWith(SLOT_LOCK_SUFFIX)) continue
      const base = entry.name.slice(0, -SLOT_LOCK_SUFFIX.length)
      const kind = slotTreeKind(base)
      if (kind === undefined) continue
      const tree = join(slotsDir, base)
      if (existsSync(tree)) continue
      // No tree and a live owner: the server may be between the claim and its tree, or
      // merely died holding a number whose copy is already gone. Only a dead one frees it.
      if (kind === 'stable' && slotHolder(tree, { commandLineOf }).live) continue
    }
    try {
      rmSync(lockPath, { force: true })
      removed += 1
      log(`removed leaked slot lock ${lockPath}`)
    } catch (error) {
      log(`could not remove leaked slot lock ${lockPath}: ${messageOf(error)}`)
    }
  }
  return removed
}

/**
 * Every slot tree of one root digest, the form the doctor and `clean`'s report use.
 * @param {string} digestDir - one `$TMPDIR/flash-mcp/<digest>` directory.
 * @param {object} [options] - the command-line source, injectable for tests.
 * @returns {object[]} the trees, as `slotTreesIn` describes them.
 */
function stableSlotTreesIn(digestDir, options = {}) {
  return slotTreesIn(digestDir, options)
}

/**
 * The directory a slot's retired tree gets: `slots/<n>.retired-<instance>`.
 *
 * The name cannot collide with the stable slot `slots/<n>` of the same number, so a later
 * server of the root claims the stable path and its warm cache while the retired tree waits
 * to be adopted or removed. The second retire in one pool adds the generation, so its tree
 * gets a name of its own too.
 *
 * @param {string} slotsDir - `<stateBase>/<rootDigest>/slots`.
 * @param {number} id - the slot number that was retired.
 * @param {string} instance - the per-pool nonce.
 * @param {number} index - the slot's directory generation (at least 1).
 * @returns {string} the retired tree's directory.
 */
function retiredSlotDirectory(slotsDir, id, instance, index) {
  const generation = index > 1 ? `-${String(index)}` : ''
  return join(slotsDir, `${String(id)}${RETIRED_SLOT_MARKER}${instance}${generation}`)
}

/**
 * Remove the lock of one slot this pool owns, so the next server may claim the number.
 *
 * A lock that will not go away is only logged: it names this pid, so the next server treats
 * it as a dead server's once this process is gone and takes the slot over.
 *
 * @param {string} slotDir - the slot's directory (or a retired tree's).
 * @param {(message: string) => void} log - progress log.
 * @returns {void}
 */
function removeSlotLock(slotDir, log) {
  try {
    rmSync(slotLockPath(slotDir), { force: true })
  } catch (error) {
    log(`could not remove the slot lock ${slotLockPath(slotDir)} (${messageOf(error)}); the next server takes the slot over as a dead one`)
  }
}

/**
 * Which method created this pool's locks, so the choice is named once rather than per lock.
 *
 * A filesystem without hard links is a property of the machine, not of a call, so one line
 * is enough; the pool's own `log` function is the key, which keeps two pools in one process
 * from logging for each other. A second method for the same pool (a configured state
 * directory on another volume) is named once too.
 *
 * @type {WeakMap<Function, string>}
 */
const slotLockMethodsLogged = new WeakMap()

/**
 * Say once per pool which way its locks are created.
 * @param {((message: string) => void) | undefined} log - the pool's progress log.
 * @param {'link' | 'exclusive'} method - the way a lock was just created.
 * @returns {void}
 */
function noteSlotLockMethod(log, method) {
  if (typeof log !== 'function') return
  if (slotLockMethodsLogged.get(log) === method) return
  slotLockMethodsLogged.set(log, method)
  if (method === 'link') {
    log('slot locks are created with hard links')
  } else {
    log('slot locks are created with an exclusive create: this filesystem does not support hard links')
  }
}

/**
 * Create one lock with an exclusive `open`, for a filesystem that has no hard links.
 *
 * `open(…, 'wx')` is the same one-step claim `link` gives: it fails with `EEXIST` when the
 * lock exists and never replaces it. The whole line is written and `fsync`ed before the
 * handle is closed, so a crash between the create and the write leaves the empty file that
 * `SLOT_LOCK_GRACE_MS` already covers. A failure after the file was created removes this
 * process's partial lock; an `EEXIST` names another server's and is left alone.
 *
 * @param {string} lockPath - the lock to create.
 * @param {string} line - the complete content, newline included.
 * @param {((message: string) => void) | undefined} log - the pool's progress log.
 * @returns {{kind: 'created' | 'exists' | 'failed', error?: Error}} the outcome.
 */
function createSlotLockExclusively(lockPath, line, log) {
  let fd
  try {
    fd = openSync(lockPath, 'wx')
    writeFileSync(fd, line)
    fsyncSync(fd)
    closeSync(fd)
    noteSlotLockMethod(log, 'exclusive')
    return { kind: 'created' }
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Already closed by the failing write.
      }
      rmSync(lockPath, { force: true })
    }
    return { kind: fd === undefined && error?.code === 'EEXIST' ? 'exists' : 'failed', error }
  }
}

/**
 * Create a slot lock complete, in one atomic step.
 *
 * The JSON goes to a unique temp file beside the lock and is then `link`ed into place: `link`
 * fails with `EEXIST` when the lock already exists and never replaces it, and the lock path
 * itself never holds a half-written or empty file. The temp file is removed in every case.
 *
 * A filesystem without hard links — exFAT and FAT32, some SMB shares — refuses `link` with
 * one of `SLOT_LOCK_NO_LINK_CODES`; there the lock is created with the exclusive `open` of
 * `createSlotLockExclusively` instead, which is still one atomic claim. Every other `link`
 * failure is reported as before.
 *
 * @param {string} lockPath - the lock to create, as `slotLockPath` names it.
 * @param {{pid: number, instance: string, command: string}} lock - what it says.
 * @param {object} [options] - how to create it and where to report.
 * @param {(from: string, to: string) => void} [options.link] - `linkSync`, injectable so a
 *   test can run on a filesystem that refuses hard links.
 * @param {(message: string) => void} [options.log] - progress log; the method is named once.
 * @returns {{kind: 'created' | 'exists' | 'failed', error?: Error}} the outcome.
 */
function createSlotLock(lockPath, lock, { link = linkSync, log } = {}) {
  const temp = `${lockPath}${SLOT_LOCK_TEMP_MARKER}${String(process.pid)}-${randomUUID().slice(0, 8)}`
  const line = slotLockJson(lock)
  try {
    mkdirSync(dirname(lockPath), { recursive: true })
  } catch (error) {
    return { kind: 'failed', error }
  }
  try {
    writeFileSync(temp, line, { flag: 'wx' })
    try {
      link(temp, lockPath)
      noteSlotLockMethod(log, 'link')
      return { kind: 'created' }
    } catch (error) {
      if (!SLOT_LOCK_NO_LINK_CODES.has(error?.code)) {
        return { kind: error?.code === 'EEXIST' ? 'exists' : 'failed', error }
      }
    }
    return createSlotLockExclusively(lockPath, line, log)
  } catch (error) {
    return { kind: error?.code === 'EEXIST' ? 'exists' : 'failed', error }
  } finally {
    rmSync(temp, { force: true })
  }
}

/**
 * Put a moved-away lock back into its place, exclusively.
 *
 * `link` is the one-step way; on a filesystem without hard links the stale file's bytes are
 * written through the exclusive `open` instead, so a restore is never silently lost there.
 *
 * @param {string} from - the stale lock file.
 * @param {string} to - the lock path it belongs at.
 * @param {object} [options] - how to create it and where to report.
 * @param {(from: string, to: string) => void} [options.link] - `linkSync`, injectable.
 * @param {(message: string) => void} [options.log] - progress log.
 * @returns {'linked' | 'exists' | 'failed'} the outcome; `exists` means another server holds it.
 */
function linkSlotLock(from, to, { link = linkSync, log } = {}) {
  try {
    link(from, to)
    noteSlotLockMethod(log, 'link')
    return 'linked'
  } catch (error) {
    if (error?.code === 'EEXIST') return 'exists'
    if (!SLOT_LOCK_NO_LINK_CODES.has(error?.code)) return 'failed'
  }
  try {
    const created = createSlotLockExclusively(to, readFileSync(from, 'utf8'), log)
    if (created.kind === 'created') return 'linked'
    return created.kind === 'exists' ? 'exists' : 'failed'
  } catch {
    return 'failed'
  }
}

/**
 * Whether a slot's lock is the one this owner just created.
 * @param {string} slotDir - the slot (or retired tree).
 * @param {{pid: number, instance: string}} owner - this pool's identity.
 * @returns {boolean} true when the lock names this owner.
 */
function holdsSlotLock(slotDir, owner) {
  const lock = readSlotLock(slotLockPath(slotDir))
  return lock !== undefined && lock.pid === owner.pid && lock.instance === owner.instance
}

/**
 * Release this owner's lock, and only if it is still this owner's.
 * @param {string} slotDir - the slot (or retired tree).
 * @param {{pid: number, instance: string}} owner - this pool's identity.
 * @param {(message: string) => void} log - progress log.
 * @returns {void}
 */
function releaseOwnSlotLock(slotDir, owner, log) {
  if (holdsSlotLock(slotDir, owner)) removeSlotLock(slotDir, log)
}

/**
 * Put a dead server's lock back after a failed takeover, without ever overwriting a lock
 * another server created in the meantime.
 *
 * The link is exclusive; when it finds a lock, that server claimed the number first and
 * nothing is put back — the stale file is left where it is rather than touched.
 *
 * @param {string} slotDir - the slot the lock belongs to.
 * @param {string} stale - the moved-away lock file.
 * @param {(message: string) => void} log - progress log.
 * @param {(from: string, to: string) => void} [linkLock] - `linkSync`, injectable.
 * @returns {void}
 */
function restoreStaleLock(slotDir, stale, log, linkLock = linkSync) {
  const result = linkSlotLock(stale, slotLockPath(slotDir), { link: linkLock, log })
  if (result === 'linked') {
    rmSync(stale, { force: true })
    return
  }
  if (result === 'exists') {
    log(`not taking slot ${slotDir}: another server claimed it first`)
    return
  }
  log(`could not put the dead lock of ${slotDir} back from ${stale}; the next server creates a fresh one`)
}

/**
 * Keep a dead server's lock beside the tree it described, so the sweep that salvages the
 * work names the pid that wrote it in the patch record.
 *
 * @param {string} aside - the moved-aside tree.
 * @param {object} prior - the dead lock's parsed content.
 * @param {string} stale - the moved-away lock file.
 * @param {(message: string) => void} log - progress log.
 * @param {(from: string, to: string) => void} [linkLock] - `linkSync`, injectable.
 * @returns {void}
 */
function keepLockBesideAside(aside, prior, stale, log, linkLock = linkSync) {
  try {
    renameSync(stale, slotLockPath(aside))
    return
  } catch {
    // The stale file vanished or the aside already has a lock: recreate one from the content.
  }
  const created = createSlotLock(slotLockPath(aside), prior, { link: linkLock, log })
  if (created.kind === 'failed') log(`could not keep the lock of dead server ${String(prior.pid)} beside ${aside} (${messageOf(created.error)})`)
  rmSync(stale, { force: true })
}

/**
 * Lock a directory of the stable layout with its pool's own lock, so no other sweep takes it
 * for a dead one.
 *
 * A retired tree sits in the same `slots` folder as the stable slots but no longer under a
 * slot number, so nothing claims it by name; a slot that has just retired has a fresh
 * directory that does not exist yet. While the pool that owns it runs, the tree may still
 * have a session writing into it; when the pool exits or crashes, the lock names a dead pid
 * and the next sweep salvages and removes the tree as usual.
 *
 * A lock this pool already holds — the stable slot's claim lock, which `retire` leaves in
 * place — is not a collision: the tree simply keeps the lock it had, and no false "could not
 * lock" is logged.
 *
 * @param {string} dir - the retired tree's directory.
 * @param {object} options - who owns it and where to report.
 * @param {number} options.pid - this process's pid.
 * @param {string} options.instance - this pool's nonce.
 * @param {string} options.command - this process's normalised command line.
 * @param {(message: string) => void} options.log - progress log.
 * @param {(from: string, to: string) => void} [options.linkLock] - `linkSync`, injectable.
 * @returns {void}
 */
function writeRetiredSlotLock(dir, { pid, instance, command, log, linkLock = linkSync }) {
  const created = createSlotLock(slotLockPath(dir), { pid, instance, command }, { link: linkLock, log })
  if (created.kind === 'created') return
  if (created.kind === 'failed') {
    log(`could not lock ${dir} (${messageOf(created.error)}); another server's sweep may salvage or remove it`)
    return
  }
  const holder = readSlotLock(slotLockPath(dir))
  if (holder !== undefined && holder.pid === pid && holder.instance === instance) return
  log(`could not lock ${dir}: another server holds it, and its sweep may salvage or remove the tree`)
}

/**
 * Claim one number of the stable layout, taking over a dead server's lock.
 *
 * The lock is taken first, either by creating it complete (step 1's `link`) or by the
 * takeover below; only then is the tree looked at. A leftover copy is moved aside, never
 * emptied, and when it cannot be moved the fresh lock is released and the number skipped:
 * moving a tree without holding its lock is what loses a dead worker's work.
 *
 * @param {string} slotDir - the directory of the number being claimed.
 * @param {object} options - who claims and where to report.
 * @param {number} options.pid - this process's pid.
 * @param {string} options.instance - this pool's nonce.
 * @param {string} options.command - this process's normalised command line, for the lock.
 * @param {(message: string) => void} options.log - progress log.
 * @param {(pid: number) => string | null} [options.commandLineOf] - `processCommandLine`, injectable.
 * @param {(from: string, to: string) => void} [options.renameDirectory] - the tree move,
 *   injectable so a test can make it fail the way an open handle does on Windows.
 * @param {(from: string, to: string) => void} [options.linkLock] - `linkSync`, injectable.
 * @returns {'claimed' | 'busy' | 'failed'} the outcome for this number.
 */
function claimSlotLock(
  slotDir,
  { pid, instance, command, log, commandLineOf = processCommandLine, renameDirectory = renameSync, linkLock = linkSync },
) {
  const owner = { pid, instance, command }
  const lockPath = slotLockPath(slotDir)
  const created = createSlotLock(lockPath, owner, { link: linkLock, log })
  let prior
  let stale
  if (created.kind === 'failed') {
    log(`could not claim the slot lock ${lockPath} (${messageOf(created.error)}); this pool runs with fewer slots`)
    return 'failed'
  }
  if (created.kind === 'exists') {
    const holder = slotHolder(slotDir, { commandLineOf })
    if (holder.live) return 'busy'
    const taken = takeOverDeadLock(slotDir, owner, { log, commandLineOf, linkLock })
    if (!taken.ok) return 'busy'
    prior = taken.lock
    stale = taken.stale
  }
  const moved = moveDeadSlotAside(slotDir, { pid: prior?.pid ?? pid, log, renameDirectory })
  if (!moved.ok) {
    // The lock is ours, the tree is not: give the number back, with the dead owner's lock
    // where it was, and leave the tree exactly as it is for a later pass.
    releaseOwnSlotLock(slotDir, owner, log)
    if (stale !== undefined) restoreStaleLock(slotDir, stale, log, linkLock)
    return 'busy'
  }
  if (stale !== undefined) {
    if (moved.aside !== undefined && prior !== undefined) keepLockBesideAside(moved.aside, prior, stale, log, linkLock)
    else rmSync(stale, { force: true })
  }
  return 'claimed'
}

/**
 * Take a dead server's slot over: move its lock away, and then create this pool's lock.
 *
 * The rename is what makes the takeover one step: a second server that renamed the same lock
 * finds nothing, and one that got there first leaves the loser with `EEXIST` on `link`. In
 * that case nothing is put back — the number now belongs to the winner — and the stale file
 * is left untouched, because removing it is only safe once our own lock exists.
 *
 * What was renamed is read back before our lock is created: between the liveness read and
 * the rename another server may have replaced the dead lock with its own live one, and that
 * one is put back rather than stolen. The dead lock travels back to the caller, which keeps
 * it beside a tree moved aside so the salvage names the pid that wrote the work.
 *
 * @param {string} slotDir - the dead server's slot directory.
 * @param {{pid: number, instance: string, command: string}} owner - this pool.
 * @param {object} options - where to report and how to test liveness.
 * @param {(message: string) => void} options.log - progress log.
 * @param {(pid: number) => string | null} [options.commandLineOf] - `processCommandLine`, injectable.
 * @param {(from: string, to: string) => void} [options.linkLock] - `linkSync`, injectable.
 * @returns {{ok: boolean, lock?: object, stale?: string}} whether this pool now holds the
 *   number, the dead lock's content, and where its lock file was moved.
 */
function takeOverDeadLock(slotDir, { pid, instance, command }, { log, commandLineOf = processCommandLine, linkLock = linkSync }) {
  const lockPath = slotLockPath(slotDir)
  const stale = `${lockPath}${SLOT_LOCK_STALE_MARKER}${String(pid)}-${String(Date.now())}-${randomUUID().slice(0, 8)}`
  try {
    renameSync(lockPath, stale)
  } catch (error) {
    // ENOENT: another server took the lock over between the read and the rename.
    if (error?.code !== 'ENOENT') log(`not taking slot ${slotDir}: its dead lock could not be moved aside (${messageOf(error)})`)
    return { ok: false }
  }
  const moved = readSlotLock(stale)
  let dead
  if (moved === undefined) {
    try {
      dead = Date.now() - statSync(stale).mtimeMs > SLOT_LOCK_GRACE_MS
    } catch {
      dead = true
    }
  } else {
    dead = !lockOwnerIsLive(moved, commandLineOf)
  }
  if (!dead) {
    // What the rename moved is someone else's live lock after all: put it back, or leave it
    // untouched when a third server claimed the number while it was out of the way.
    restoreStaleLock(slotDir, stale, log, linkLock)
    return { ok: false }
  }
  const created = createSlotLock(lockPath, { pid, instance, command }, { link: linkLock, log })
  if (created.kind !== 'created') {
    // Another server created its lock while the stale one was out of the way, or this one
    // could not be written. Either way the number is not ours: put nothing back, touch
    // nothing, and leave the stale file for the holder to ignore.
    if (created.kind === 'failed') log(`not taking slot ${slotDir}: could not create a lock (${messageOf(created.error)})`)
    else log(`not taking slot ${slotDir}: another server claimed it first`)
    return { ok: false }
  }
  // Our lock exists now, so the stale file is safe to remove; the caller keeps the content.
  if (moved === undefined) log(`took over slot ${slotDir} from a dead server whose lock was unreadable`)
  else log(`took over slot ${slotDir} from dead server ${String(moved.pid)}${moved.instance === '' ? '' : ` (instance ${moved.instance})`}`)
  return { ok: true, lock: moved, stale }
}

/**
 * Move a dead server's copy out of a stable slot's path, keeping its build cache there.
 *
 * The tree keeps its old contents under `slots/<n>.dead-<pid>-<ms>` for the sweep, which
 * stores the dead worker's uncommitted work and then deletes it; the stable path is recreated
 * and the `.flash-cache` moved back into it, so the next build is still warm. `prepare` never
 * empties a tree it did not create: a copy that cannot be moved (an open handle on Windows
 * gives EPERM/EBUSY) leaves the number to a later pass.
 *
 * Only `.flash-cache` in the directory is the normal shutdown's leftover; anything else is a
 * worker's tree and is moved aside, never erased.
 *
 * @param {string} slotDir - the dead server's slot directory.
 * @param {object} options - which dead server, where to report, and the injected rename.
 * @param {number} options.pid - the dead server's pid, kept in the aside name.
 * @param {(message: string) => void} options.log - progress log.
 * @param {(from: string, to: string) => void} [options.renameDirectory] - the tree move.
 * @returns {{ok: boolean, aside?: string}} whether the stable path is free, and where the copy
 *   went when it held anything.
 */
function moveDeadSlotAside(slotDir, { pid, log, renameDirectory = renameSync }) {
  let entries
  try {
    entries = readdirSync(slotDir)
  } catch {
    // No directory: the dead server held the lock but had not created its tree yet.
    return { ok: true }
  }
  if (entries.every((name) => name === SLOT_CACHE)) return { ok: true }
  const aside = join(dirname(slotDir), `${basename(slotDir)}${DEAD_SLOT_MARKER}${String(pid)}-${String(Date.now())}`)
  try {
    renameDirectory(slotDir, aside)
    // A retired tree's "a runtime may still write here" mark (see `markLiveOrphan`) is a
    // sibling of the tree, so it has to travel with it: a sweep of the moved tree must still
    // keep its cache out of the store while a process of the dead server may be running.
    try {
      renameDirectory(liveOrphanMarker(slotDir), liveOrphanMarker(aside))
    } catch {
      // No mark: the tree was not retired with its runtimes still running.
    }
  } catch (error) {
    log(`not taking slot ${slotDir}: its dead tree could not be moved aside (${messageOf(error)}); the tree is left exactly as it is`)
    return { ok: false }
  }
  const cache = join(aside, SLOT_CACHE)
  try {
    mkdirSync(slotDir, { recursive: true })
    if (existsSync(cache)) {
      renameDirectory(cache, join(slotDir, SLOT_CACHE))
      log(`kept the build cache of the dead server in ${join(slotDir, SLOT_CACHE)}`)
    }
  } catch (error) {
    log(`could not keep the build cache of dead server ${String(pid)} in ${slotDir} (${messageOf(error)}); the tree stays at ${aside}`)
    // Put the tree back when the cache could not leave it, so a failed claim touches nothing.
    try {
      rmSync(slotDir, { recursive: true, force: true })
      renameDirectory(aside, slotDir)
    } catch {
      // The tree is still at `aside`: the sweep salvages it there rather than erasing it.
    }
    return { ok: false, aside }
  }
  return { ok: true, aside }
}

/**
 * Take `count` slot numbers of one root by creating their lock files.
 *
 * Numbers are taken from 0 up, skipping every number a live server holds, so two servers on
 * one root get disjoint numbers: the second starts at the first free one. The scan is bounded
 * by `SLOT_CLAIM_SCAN_LIMIT`; a pool that cannot take a single slot keeps the older
 * per-instance layout instead (see the constructor), which needs no lock.
 *
 * @param {string} slotsDir - `<stateBase>/<rootDigest>/slots`.
 * @param {object} options - who claims, how many, and where to report.
 * @param {number} options.count - how many slots the pool runs with.
 * @param {number} options.pid - this process's pid.
 * @param {string} options.instance - this pool's nonce.
 * @param {string} options.command - this process's normalised command line, for the lock.
 * @param {(message: string) => void} options.log - progress log.
 * @param {(pid: number) => string | null} [options.commandLineOf] - `processCommandLine`, injectable.
 * @param {(from: string, to: string) => void} [options.renameDirectory] - the tree move.
 * @param {(from: string, to: string) => void} [options.linkLock] - `linkSync`, injectable.
 * @returns {number[]} the numbers it claimed, ascending.
 */
function claimSlots(
  slotsDir,
  { count, pid, instance, command, log, commandLineOf = processCommandLine, renameDirectory = renameSync, linkLock = linkSync },
) {
  try {
    mkdirSync(slotsDir, { recursive: true })
  } catch (error) {
    log(`could not create the slot directory ${slotsDir} (${messageOf(error)}); this pool keeps its slots in its own state directory`)
    return []
  }
  const claimed = []
  for (let number = 0; claimed.length < count && number < SLOT_CLAIM_SCAN_LIMIT; number += 1) {
    const outcome = claimSlotLock(join(slotsDir, String(number)), {
      pid,
      instance,
      command,
      log,
      commandLineOf,
      renameDirectory,
      linkLock,
    })
    if (outcome === 'claimed') claimed.push(number)
    if (outcome === 'failed') break
  }
  if (claimed.length < count) {
    log(`took only ${String(claimed.length)} of ${String(count)} free slot(s) below ${join(slotsDir, String(SLOT_CLAIM_SCAN_LIMIT))}: every other number found is held`)
  }
  return claimed
}

/**
 * The root path of one slot's disposable tree, as a warning and the doctor name it.
 *
 * The trailing separator is part of a directory's own path for a Windows tool counting
 * characters: `C:\…\slot-0\` is one longer than the path without it, and that one
 * character is what a build near the limit runs out of first.
 *
 * @param {string} stateDir - the pool's state directory.
 * @param {number} [id] - slot number (default 0, the first slot).
 * @returns {string} the slot root, with a trailing separator.
 */
export function slotRootPath(stateDir, id = 0) {
  const root = slotDirectory(stateDir, id, 0)
  return /[\\/]$/.test(root) ? root : `${root}${sep}`
}

/**
 * The warning to emit when slot trees are copied under a path Windows tools may outgrow.
 *
 * Deliberately advisory, not a refusal: the default layout is shared by the sweep, `clean`
 * and salvage, so changing it silently would strand existing trees. The operator can move
 * the base with `--state-base` / `FLASH_STATE_BASE` and keep every other behaviour.
 *
 * @param {string} slotRoot - the first slot's root path (a trailing separator is added).
 * @param {object} [options] - platform and the advisory length, injected by tests.
 * @param {string} [options.platform] - platform the warning applies to (default process.platform).
 * @param {number} [options.limit] - the advisory length in characters (default 64).
 * @returns {string | undefined} the warning, or undefined when it does not apply.
 */
export function slotPathWarning(slotRoot, { platform = process.platform, limit = WINDOWS_SLOT_PATH_ADVISORY } = {}) {
  if (platform !== 'win32') return undefined
  const path = /[\\/]$/.test(slotRoot) ? slotRoot : `${slotRoot}${sep}`
  if (path.length <= limit) return undefined
  return (
    `slot copies live at ${path} (${String(path.length)} characters); Windows tools without ` +
    'long-path support (MSVC cl.exe among them) fail past 260 characters, so deep build folders ' +
    'inside the copy can break. A short base leaves more room: set the plugin option "state_base" ' +
    '(or FLASH_STATE_BASE) to a folder such as C:\\fm'
  )
}

/**
 * Remove every cache stored for one root digest.
 * @param {string} digestDir - one `$TMPDIR/flash-mcp/<digest>` directory.
 * @param {object} options - how to delete and report.
 * @param {'sync' | 'background'} options.removal - how the deletion runs.
 * @param {(message: string) => void} options.log - progress log.
 * @returns {number} how many stored caches were removed.
 */
function removeStoredCaches(digestDir, { removal, log }) {
  const storeDir = join(digestDir, CACHE_STORE_DIR)
  return discardStoredCaches(storeDir, storedCacheNames(storeDir), { removal, log })
}

/**
 * Remove the build caches of one root digest that no live server can be using: the stored
 * ones, the `.flash-cache` of every slot of a dead owner, and of every dead stable slot. A
 * live server's slots are never touched.
 *
 * @param {string} digestDir - one `$TMPDIR/flash-mcp/<digest>` directory.
 * @param {object} options - how to delete and report.
 * @param {'sync' | 'background'} options.removal - how the deletion runs.
 * @param {(message: string) => void} options.log - progress log.
 * @param {{pid: number, instance: string, command: string}} options.owner - this
 *   `clean`'s lock identity.
 * @param {(pid: number) => string | null} [options.commandLineOf] - `processCommandLine`.
 * @returns {number} how many caches were removed.
 */
function removeCachesOf(digestDir, { removal, log, owner, commandLineOf = processCommandLine, linkLock = linkSync }) {
  let removed = removeStoredCaches(digestDir, { removal, log })
  for (const pid of ownerDirs(digestDir)) {
    if (Number(pid) === process.pid || processAlive(Number(pid))) continue
    for (const { dir } of deadSlotsIn(join(digestDir, pid))) {
      const cache = join(dir, SLOT_CACHE)
      if (!existsSync(cache)) continue
      try {
        rmSync(cache, { recursive: true, force: true, maxRetries: TRASH_RETRIES })
        removed += 1
        log(`removed build cache ${cache} of dead owner ${pid}`)
      } catch (error) {
        log(`could not remove build cache ${cache}: ${messageOf(error)}`)
      }
    }
  }
  // A dead stable slot keeps its tree until the sweep removes it, but its cache is exactly
  // what `--caches` is for. A slot a live server holds keeps its warm cache, and one another
  // server claims between the check and the removal is skipped: the lock says whose it is.
  for (const tree of slotTreesIn(digestDir, { commandLineOf })) {
    if (tree.live) continue
    const cache = join(tree.dir, SLOT_CACHE)
    if (!existsSync(cache)) continue
    const acquired = acquireSlotTreeLock(tree.dir, { owner, log, commandLineOf, linkLock })
    if (!acquired.ok) continue
    try {
      rmSync(cache, { recursive: true, force: true, maxRetries: TRASH_RETRIES })
      removed += 1
      log(`removed build cache ${cache} of dead slot ${tree.label}`)
    } catch (error) {
      log(`could not remove build cache ${cache}: ${messageOf(error)}`)
    } finally {
      releaseSlotTreeLock(tree.dir, owner, acquired.lock, log, linkLock)
    }
  }
  return removed
}

/**
 * The root as this machine's file system spells it.
 *
 * The service keys every layout by the digest of the *real* root: a server started on
 * `/tmp/x` on macOS, where `/tmp` is a symlink to `/private/tmp`, writes under the digest of
 * `/private/tmp/x`. A digest taken from the raw `--root` string would name a different
 * directory, so `clean` would report that root's state as empty and prune none of its
 * patches or reports. A root that no longer exists has no real path; its resolved spelling is
 * then what the server that created it used.
 *
 * @param {string} root - the root as the caller named it.
 * @returns {string} its real path when it exists, else the resolved path.
 */
function canonicalRootPath(root) {
  const absolute = resolve(root)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
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
 * This root's `trash-*` directories — a removal a crash left unfinished — are removed
 * too, and counted in `actions.trashRemoved`; each one is also named in the log.
 *
 * Unlike a server's sweep, every removal here is synchronous (`removal: 'sync'` by
 * default): `clean` prints its report and exits the process, so a deletion left running in
 * the background was abandoned with the process while the summary claimed it happened.
 *
 * @param {object} options - what to report and reclaim.
 * @param {string} [options.baseDir] - the state base directory, usually `$TMPDIR/flash-mcp`.
 * @param {string} [options.dataDir] - the durable data directory; defaults to `durableBaseDir()`.
 * @param {string} options.root - the service root of this invocation, as the caller named it;
 *    it is resolved to its real path before its digest is taken, as the service does.
 * @param {boolean} [options.all] - also remove the trees of roots with no live server.
 * @param {boolean} [options.cachesOnly] - remove only build caches: this root's stored ones and
 *   the `.flash-cache` of its dead owners' slots (with `all`, every root's without a live server).
 *   Trees, patches and owners are left alone.
 * @param {number} [options.retentionDays] - the patch retention window.
 * @param {number} [options.now] - the current time, for tests.
 * @param {'sync' | 'background'} [options.removal] - how dead owners' trash is deleted.
 * @param {(message: string) => void} [options.log] - progress log.
 * @param {(pid: number) => string | null} [options.processCommandLine] - `processCommandLine`,
 *   injectable for tests.
 * @param {(from: string, to: string) => void} [options.linkLock] - `linkSync`, injectable for
 *   a test that runs on a filesystem without hard links.
 * @param {(tree: object) => void} [options.beforeSweep] - called after a dead tree is planned
 *   and before its lock is taken; injectable so a test can claim it in that window.
 * @returns {{baseDir: string, own: string, patchDir: string, legacyPatchDir?: string, stats: object[], actions: object}} the report.
 */
export function cleanLayout({
  baseDir = stateBaseDir(),
  dataDir,
  root,
  all = false,
  cachesOnly = false,
  retentionDays = PATCH_RETENTION_DAYS,
  now = Date.now(),
  removal = 'sync',
  log = () => {},
  processCommandLine: commandLineOf = processCommandLine,
  linkLock = linkSync,
  beforeSweep,
} = {}) {
  // This root's own spelling, fixed once: the digest, the durable patch store and the salvage
  // of its dead owners all have to name the same root the service itself would have used.
  const rootPath = canonicalRootPath(root)
  const own = rootDigest(rootPath)
  const ownDir = join(baseDir, own)
  const patchDir = dataDir === undefined ? defaultPatchDir(rootPath) : join(dataDir, own, 'patches')
  const legacyPatchDir = join(ownDir, 'patches')
  // `clean` is one process with no pool, so it takes a lock identity of its own: a tree it
  // removes is touched while that lock is held, never merely because its plan said "dead".
  const owner = { pid: process.pid, instance: `clean-${randomUUID().slice(0, 8)}`, command: commandLineOf(process.pid) }
  // Facts are read before anything is removed, so the report describes what was found.
  // This root's durable store is part of its footprint even though it does not live under
  // the temp base, so it is counted on this root's line alongside any legacy copy.
  const stats = digestDirs(baseDir).map((digest) => ({
    digest,
    own: digest === own,
    livePids: livePidsIn(join(baseDir, digest)),
    ...digestStats(join(baseDir, digest), digest === own ? [patchDir] : []),
  }))
  const actions = {
    deadOwnersRemoved: 0,
    trashRemoved: 0,
    patchesPruned: 0,
    reportsPruned: 0,
    emptyDigestsRemoved: 0,
    foreignTreesRemoved: 0,
    cachesRemoved: 0,
  }
  if (cachesOnly) {
    // Same safety as the state: a root with a live server keeps what it may be claiming or
    // writing, so only this root (whose live servers are this one's own concern, as for the
    // owners below) and, with `all`, roots nobody is serving are touched.
    for (const digest of digestDirs(baseDir)) {
      if (digest !== own && !all) continue
      const dir = join(baseDir, digest)
      if (digest !== own && digestHasLiveOwner(dir, { commandLineOf })) continue
      actions.cachesRemoved += removeCachesOf(dir, { removal, log, owner, commandLineOf, linkLock })
    }
    return { baseDir, own, patchDir, stats, actions, ...(existsSync(legacyPatchDir) ? { legacyPatchDir } : {}) }
  }
  if (existsSync(ownDir)) {
    // Leftover trash is removed first, the owners' trees are salvaged and removed, and all
    // of it synchronously: `clean` is an operator command that promises the disk back before
    // it exits, and it has no protocol connection whose event loop a background deletion
    // would protect. Salvage goes to the durable store too, exactly as a startup sweep
    // would, and the counts come back from the same pass (see `sweepDeadOwners`). Unlike a
    // server's sweep, `clean` takes dead stable slots as well: it is the operator asking for
    // the disk back, and it takes each one's lock before touching it.
    const swept = sweepDeadOwners(rootPath, {
      patchDir,
      baseDir,
      removal,
      log,
      owner,
      includeStable: true,
      commandLineOf,
      linkLock,
      beforeSweep,
    })
    actions.deadOwnersRemoved = swept.removed
    actions.trashRemoved = swept.trashRemoved
  }
  // The dead owners' own caches went with their trees above (`clean` passes no store policy),
  // and what the store holds goes now: `clean` is the operator asking for the disk back.
  actions.cachesRemoved += removeStoredCaches(ownDir, { removal, log })
  actions.patchesPruned = prunePatches(patchDir, { retentionDays, now })
  // A server with isolation off stores its reports under the state base, not beside a patch
  // store; they age out on the same window and are reclaimed by the same command.
  actions.reportsPruned = pruneReports(join(ownDir, 'reports'), { retentionDays, now })
  if (resolve(legacyPatchDir) !== resolve(patchDir)) {
    // An upgrade can leave patches behind in the temp tree. Do not move them from `clean`
    // (a pool migrates on construction); just age out the ones that are already due.
    actions.patchesPruned += prunePatches(legacyPatchDir, { retentionDays, now })
  }
  actions.emptyDigestsRemoved = removeEmptyForeignDigests(rootPath, { baseDir, log, commandLineOf })
  if (all) {
    for (const digest of digestDirs(baseDir)) {
      if (digest === own) continue
      const dir = join(baseDir, digest)
      if (digestHasLiveOwner(dir, { commandLineOf })) continue
      actions.foreignTreesRemoved += removeDeadOwnerDirs(dir, { log, owner, commandLineOf, linkLock })
      actions.reportsPruned += pruneReports(join(dir, 'reports'), { retentionDays, now })
      actions.cachesRemoved += removeStoredCaches(dir, { removal, log })
    }
    actions.emptyDigestsRemoved += removeEmptyForeignDigests(rootPath, { baseDir, log, commandLineOf })
  }
  const report = { baseDir, own, patchDir, stats, actions }
  if (existsSync(legacyPatchDir)) report.legacyPatchDir = legacyPatchDir
  return report
}

/**
 * One path of a stored `--name-status` record, spelled so the record can be split again.
 *
 * A record is `STATUS<TAB>path`, with a rename's old path before its new one, so a tab
 * inside a name ends the field early: `M<TAB>a<TAB>b.txt` reads as the file `a` in one
 * reader and as `b.txt` in another, and the two disagree about what the patch changed.
 * `-z` hands back the real bytes, so the record is written in git's own C-quoted spelling
 * exactly when the name holds a tab, a newline, another control character, or begins with
 * a quote — the spelling git itself writes without `-z`, which `diffPathToken` decodes. A
 * name with a space, a backslash of its own or a non-ASCII character is written plainly:
 * the tab is the only separator, so every other byte is safe, and every ordinary record
 * keeps the shape it has had since this service first stored one.
 *
 * The quoted form is built from UTF-8 bytes, so it is plain ASCII (`é` is `\303\251`),
 * exactly as git spells it, and the byte-wise decoder gives the name back.
 *
 * @param {string} path - the name as it exists on disk.
 * @returns {string} the field to write.
 */
function recordPathField(path) {
  const text = String(path)
  if (!/^"|[\u0000-\u001f\u007f]/.test(text)) return text
  let quoted = '"'
  for (const byte of Buffer.from(text, 'utf8')) {
    if (byte === 0x5c) quoted += '\\\\'
    else if (byte === 0x22) quoted += '\\"'
    else if (byte === 0x07) quoted += '\\a'
    else if (byte === 0x08) quoted += '\\b'
    else if (byte === 0x09) quoted += '\\t'
    else if (byte === 0x0a) quoted += '\\n'
    else if (byte === 0x0b) quoted += '\\v'
    else if (byte === 0x0c) quoted += '\\f'
    else if (byte === 0x0d) quoted += '\\r'
    else if (byte < 0x20 || byte >= 0x7f) quoted += `\\${byte.toString(8).padStart(3, '0')}`
    else quoted += String.fromCharCode(byte)
  }
  return `${quoted}"`
}

/**
 * The `STATUS<TAB>path` records of the staged change, decoded.
 *
 * Read with `-z`, so git neither quotes a path with a non-ASCII byte, quote or backslash
 * nor escapes it: the fields arrive as the real NUL-separated names. The records are then
 * rebuilt in the same `STATUS<TAB>path` shape this service has always stored — a name only
 * a tab, a newline, another control byte or a leading quote would break is written in git's
 * C-quoted form there (see `recordPathField`), and every other name is written plainly.
 * The quoted spelling git writes without `-z` used to leak into `filesChanged`: a caller
 * filtering with the plain name could not select the file, and `touchedPaths` staged the
 * quoted string, so the caller's own file at the real path was invisible to the merge and
 * silently overwritten.
 *
 * @param {string} repoDir - the copy the change was computed in.
 * @param {string} base - the base commit the change is diffed against.
 * @param {NodeJS.ProcessEnv} [env] - environment for git; names the staged index when it is
 *   not the copy's own (see `withNestedIndex`).
 * @returns {string[]} the decoded records, in git's order.
 * @throws {Error} when git cannot produce the list.
 */
function nameStatusRecords(repoDir, base, env = process.env) {
  return decodeNameStatus(git(['diff', '--cached', '--name-status', '-z', base], repoDir, env))
}

/**
 * Turn one `--name-status -z` stream into this service's `STATUS<TAB>path` records.
 *
 * @param {string} raw - git's NUL-separated output.
 * @returns {string[]} the decoded records, in git's order.
 */
function decodeNameStatus(raw) {
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
      lines.push(`${status}\t${recordPathField(first)}\t${recordPathField(second ?? '')}`)
    } else {
      lines.push(`${status}\t${recordPathField(first)}`)
    }
  }
  return lines
}

/**
 * Decode one path field of a stored `--name-status` record.
 *
 * New records carry the plain name, except for the names `recordPathField` had to
 * C-quote; a record stored before `-z` was used can carry git's quoted spelling in any
 * field. Both are decoded by `diffPathToken`, the decoder a diff header's token goes
 * through, so a record and a section spell a name the same way.
 *
 * @param {string} field - one tab-separated field of a record.
 * @returns {string} the name as it exists on disk.
 */
function nameStatusPath(field) {
  return diffPathToken(String(field))
}

/**
 * One stored record split into its status and its decoded path fields.
 *
 * `git diff --name-status` writes `STATUS<TAB>path`, and a rename or copy adds the old
 * path first: `STATUS<TAB>old<TAB>new`. Splitting on the tabs git wrote is exact, because
 * a name that holds a tab is stored C-quoted and a quoted field carries no raw tab. Each
 * field is decoded here and nowhere else: every reader of `filesChanged` goes through this
 * function or through the two below it, so no two of them can disagree about what a record
 * names.
 *
 * A non-rename record has one path field. An old record that was written before a tab was
 * quoted still holds the raw tab, and the whole remainder of the line is exactly the name
 * it was built from (`status + '\t' + path`), so that is what is returned for it.
 *
 * @param {string} line - one stored `--name-status` record.
 * @returns {{status: string, paths: string[]}} the status and the decoded paths, old first.
 */
function recordEntry(line) {
  const text = String(line)
  const tab = text.indexOf('\t')
  if (tab < 0) return { status: text, paths: [] }
  const status = text.slice(0, tab)
  const rest = text.slice(tab + 1)
  if (status.startsWith('R') || status.startsWith('C')) {
    return { status, paths: rest.split('\t').map((field) => nameStatusPath(field)) }
  }
  return { status, paths: [nameStatusPath(rest)] }
}

/**
 * The plain repository paths a stored `--name-status` record names.
 *
 * A rename appears in a record as `old<TAB>new`; the name that exists after the change is
 * the new one, which is the spelling a caller recognizes and the one `appliedFiles`
 * stores. A deletion and an ordinary change have one path each. Defined in terms of
 * `nameStatusEntry`, so this list and the per-record view cannot drift apart — which is
 * what made a tab in a name move a phantom file into `appliedFiles`.
 *
 * @param {string[] | undefined} lines - raw `--name-status` records.
 * @returns {string[]} the plain paths, in the same order.
 */
export function recordPaths(lines) {
  return (lines ?? []).map((line) => nameStatusEntry(line).path)
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
 * The path of one `---` or `+++` line of a diff section, decoded.
 *
 * Git ends the line with a tab when the name holds a space: that tab is the "no
 * timestamp" marker of the traditional diff header, not part of the name. A name that
 * holds a tab of its own is C-quoted, so it carries no raw tab and the first tab of the
 * payload still ends the name.
 *
 * @param {string} line - a `--- …` or `+++ …` line.
 * @returns {string | null} the plain path, or null for `/dev/null`.
 */
function filePairPath(line) {
  const payload = line.slice(4)
  const tab = payload.indexOf('\t')
  return patchPathOf(tab < 0 ? payload : payload.slice(0, tab))
}

/**
 * The two names one diff section states in its own header lines, decoded.
 *
 * `diff --git a/X b/Y` cannot be split back on its own: git does not quote a space, so a
 * name that itself holds ` b/` moves the separator into the name — a file `x b/y.txt` has
 * the header `diff --git a/x b/y.txt b/x b/y.txt`. The lines git writes below it are
 * unambiguous. `rename from`/`rename to` and `copy from`/`copy to` each carry one bare
 * name, and `--- a/…`/`+++ b/…` carry both sides, with `/dev/null` for a side that does not
 * exist. A name that needs quoting is quoted there too, so `diffPathToken` gives it back.
 *
 * Read only above the first `@@`: a removed line that itself starts with `--` is written
 * `--- …` inside a hunk, and an added line that starts with `++` is written `+++ …`, so
 * below that line the prefixes no longer mean a header. The rename lines come first, so a
 * rename that carries content keeps its own names rather than the pair that repeats them.
 *
 * @param {string} section - one `diff --git` section, newline-terminated.
 * @returns {{from: string | null, to: string | null} | null} the old and the new name, with
 *   null for a side that does not exist; null when the section states none of these lines.
 */
function sectionDeclaredPaths(section) {
  /** @type {Map<string, string | null>} */
  const declared = new Map()
  let at = 0
  while (at < section.length) {
    const end = section.indexOf('\n', at)
    const line = end < 0 ? section.slice(at) : section.slice(at, end)
    at = end < 0 ? section.length : end + 1
    if (line.startsWith('@@')) break
    const named = /^(?:rename|copy) (from|to) (.*)$/.exec(line)
    if (named !== null) declared.set(named[1], diffPathToken(named[2]))
    else if (line.startsWith('--- ')) {
      if (!declared.has('from')) declared.set('from', filePairPath(line))
    } else if (line.startsWith('+++ ')) {
      if (!declared.has('to')) declared.set('to', filePairPath(line))
    }
  }
  if (declared.size === 0) return null
  return { from: declared.get('from') ?? null, to: declared.get('to') ?? null }
}

/**
 * The one name a `diff --git` header spells twice, split where both halves are equal.
 *
 * A mode-only change (`chmod +x`) and a binary change state no name of their own, and
 * their header names the same path on both sides. Counting spaces cannot find the
 * separator — `a/x b/y.txt b/x b/y.txt` has two — but equality can: the separator is the
 * space after which the rest of the line spells the same path as the part before it, both
 * halves decoded, so a quoted pair (`"a/…" "b/…"`) splits at its own opening quote. Such a
 * split is unique: the left half is a prefix of the name and the right half is a suffix of
 * it followed by the whole name again, so their lengths can never match.
 *
 * @param {string} header - the `diff --git` line, without its newline.
 * @returns {string | null} the plain path, or null when no split makes both halves agree.
 */
function sameHeaderPath(header) {
  const rest = header.slice('diff --git '.length)
  for (let at = 1; at < rest.length; at += 1) {
    if (rest[at - 1] !== ' ') continue
    // The second half starts here with `b/` when bare, or with `"b/` when git quoted it.
    if (!rest.startsWith('b/', at) && !rest.startsWith('"b/', at)) continue
    const from = patchPathOf(rest.slice(0, at - 1))
    if (from === null) continue
    if (from !== patchPathOf(rest.slice(at))) continue
    return from
  }
  return null
}

/**
 * The old and the new plain name of one diff section.
 *
 * The names git states in the section's own lines come first (see `sectionDeclaredPaths`).
 * Only a section that states none of them — a mode-only change, a binary change — falls
 * back to its header, where both sides are the same path and the split can be found by
 * equality; the old last-` b/` rule is the last resort, right whenever the name that ends
 * the header holds no ` b/` of its own. A section that states both sides as `/dev/null`
 * names nothing and is answered the same way.
 *
 * @param {string} section - one `diff --git` section, newline-terminated.
 * @returns {{from: string | null, to: string | null}} the old and the new plain name.
 */
function diffSectionPaths(section) {
  const declared = sectionDeclaredPaths(section)
  if (declared !== null && (declared.from !== null || declared.to !== null)) return declared
  const newline = section.indexOf('\n')
  const header = newline < 0 ? section : section.slice(0, newline)
  const same = sameHeaderPath(header)
  if (same !== null) return { from: same, to: same }
  const [aPath, bPath] = diffHeaderPaths(header)
  return { from: patchPathOf(aPath), to: patchPathOf(bPath) }
}

/**
 * The plain path one diff section changes: the new path, or the old one for a deletion.
 *
 * A rename names both paths, and the name that exists afterwards is the one the caller
 * sees in `filesChanged`; a deletion has no new path, so the old name is the only one that
 * still means anything.
 *
 * @param {string} section - one `diff --git` section, newline-terminated.
 * @returns {string | null} the path, or null when the section names none.
 */
function diffSectionPath(section) {
  const { from, to } = diffSectionPaths(section)
  return to ?? from
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
 * Every path one diff section may be selected by.
 *
 * A section names its old and its new path; a rename names different ones. The caller
 * reviews the record's `filesChanged`, where a rename appears as `old<TAB>new`, so either
 * spelling must select the section. The names come from the lines git writes for the
 * section itself, not from the `diff --git` header, which a name holding ` b/` cannot be
 * split out of (see `diffSectionPaths`). A deletion names one path and an addition's old
 * side is `/dev/null`, which `patchPathOf` drops.
 *
 * @param {{text: string, path: string | null}} section - one `diff --git` section.
 * @returns {string[]} the distinct plain paths that name this section.
 */
function diffSectionNames(section) {
  if (!section.text.startsWith('diff --git ')) return section.path === null ? [] : [section.path]
  const { from, to } = diffSectionPaths(section.text)
  const names = []
  for (const name of [from, to]) {
    if (name !== null && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * The diff sections a `files` selection names, refusing a name the patch does not contain.
 *
 * Both `flash_patch` and a partial `apply` select sections this way, so a name that is
 * misspelled is answered with the names the patch does contain — and with the same
 * sentence in both tools. A rename is selectable by its old path and by its new one,
 * which is what the record's own `STATUS<TAB>old<TAB>new` spelling offers.
 *
 * @param {string} patchId - the patch's full id, for the refusal.
 * @param {Array<{text: string, path: string | null}>} sections - every section of the patch.
 * @param {string[]} files - the caller's selection.
 * @returns {Array<{text: string, path: string | null}>} the selected sections, in patch order.
 * @throws {Error} when a name is not a file of the patch.
 */
function selectedPatchSections(patchId, sections, files) {
  const known = []
  for (const section of sections) {
    for (const name of diffSectionNames(section)) {
      if (!known.includes(name)) known.push(name)
    }
  }
  const unknown = files.filter((name) => !known.includes(name))
  if (unknown.length > 0) {
    throw new Error(
      `patch ${patchId} does not contain ${unknown.map((name) => JSON.stringify(name)).join(', ')}; ` +
        (known.length === 0 ? 'it changes no files' : `it changes: ${known.join(', ')}`),
    )
  }
  const wanted = new Set(files)
  return sections.filter((section) => diffSectionNames(section).some((name) => wanted.has(name)))
}

/**
 * A record whose patch is one temporary subset of a stored patch.
 *
 * The apply pipeline reads three fields from the record: the patch file it applies, the
 * `filesChanged` its result reports, and the `preimage` a three-way merge rebuilds its
 * base from. Narrowing all three is what makes a partial apply go through exactly the
 * same drift, destructive-edit, merge and dry-run code as a whole one. Everything else —
 * the id, root, scope, base and the blobs directory — stays the record's own.
 *
 * @param {object} record - the stored record.
 * @param {object} selected - the selection.
 * @param {string} selected.patchPath - the temporary patch holding only these sections.
 * @param {string[]} selected.filesChanged - the record's `STATUS<TAB>path` lines for them.
 * @param {Array<{text: string, path: string | null}>} selected.sections - the sections.
 * @param {string} selected.diffstat - the diffstat of the temporary patch.
 * @returns {object} the derived record.
 */
function partialPatchRecord(record, { patchPath, filesChanged, sections, diffstat }) {
  const names = new Set()
  for (const section of sections) {
    for (const name of diffSectionNames(section)) names.add(name)
  }
  const derived = {
    ...record,
    patchPath,
    // Kept for the error messages: the temporary file is removed when the apply ends, so
    // a caller told "the patch is at" must be pointed at the stored patch instead.
    storedPatchPath: record.patchPath,
    filesChanged,
    diffstat,
  }
  if (Array.isArray(record.preimage)) {
    // A rename's preimage entry is keyed by the old path, which is why both header names
    // are kept rather than only the paths the record reports as changed. The entry's path
    // is the plain name the `-z` read produced, not a record field, so it is compared as it
    // stands: decoding it would drop the leading quote of a name that begins with one.
    derived.preimage = record.preimage.filter(
      (entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string' && names.has(entry.path),
    )
  }
  return derived
}

/**
 * The path a failure message should name for a patch record.
 *
 * A partial apply's record points at a temporary file that is deleted in the same call;
 * naming it would send the caller to a path that no longer exists.
 *
 * @param {object} record - the record being applied.
 * @returns {string} the stored patch's path, or the record's own when it is not derived.
 */
function patchMessagePath(record) {
  return typeof record.storedPatchPath === 'string' ? record.storedPatchPath : record.patchPath
}

/**
 * The files of one patch that are already in the caller's tree.
 *
 * A record written before per-file state existed says only that the whole patch was
 * applied, which means every one of its files is here; a record written since names them.
 * Keeping the old answer here is what lets `files` refuse an already-applied file on a
 * patch applied by an earlier release instead of running git into a failure.
 *
 * @param {object} record - the patch record.
 * @returns {string[]} the applied files in record spelling, or an empty list.
 */
function appliedFileNames(record) {
  if (Array.isArray(record.appliedFiles)) return record.appliedFiles
  if (record.appliedAt !== null && record.appliedAt !== undefined) return recordPaths(record.filesChanged)
  return []
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
 * @param {NodeJS.ProcessEnv} [env] - environment for git, naming the staged index.
 * @returns {{preimage: Array<{path: string, mode: string, blob: string}>, blobs: string[]}} the
 *   base entries and the distinct source blob ids.
 * @throws {Error} when the raw diff cannot be read.
 */
function preimageEntries(repoDir, base, env = process.env) {
  const raw = git(['diff', '--cached', '--raw', '--no-abbrev', '-z', base], repoDir, env)
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
 * Best effort by design. A patch that cannot carry its blobs is still a patch, and failing
 * the call over it would lose work that plain apply can still deliver. The base entries are
 * kept whatever happens to the blobs: they are read from the staged diff, and each names the
 * blob id the patch's own `index` line names. A blob the copy cannot hand over — one the
 * caller's repository holds and the copy does not — is left out of the pack and logged, and
 * the merge looks it up in the caller's repository, file by file. Dropping every entry
 * because one blob would not pack made a patch whose bases were all in the caller's
 * repository read as "made before blob saving existed".
 *
 * @param {string} repoDir - the copy the patch was computed in.
 * @param {string} base - the base commit the patch was diffed against.
 * @param {string} patchDir - where stored patches live.
 * @param {string} patchId - the id the patch is stored under.
 * @param {(message: string) => void} log - where a failure is named.
 * @param {NodeJS.ProcessEnv} [env] - environment for git, naming the staged index.
 * @returns {Array<{path: string, mode: string, blob: string}> | undefined} the base entries,
 *   or undefined when they could not be read.
 */
function savePreimageBlobs(repoDir, base, patchDir, patchId, log, env = process.env) {
  let entries
  try {
    entries = preimageEntries(repoDir, base, env)
  } catch (error) {
    log(`could not read the preimage of ${patchId} (${messageOf(error)}); a three-way merge of this patch will not be possible`)
    return undefined
  }
  let blobs = entries.blobs
  if (blobs.length > 0) {
    try {
      const checked = git(['cat-file', '--batch-check'], repoDir, process.env, `${blobs.join('\n')}\n`)
      const missing = new Set(
        checked
          .split('\n')
          .filter((line) => line.endsWith(' missing'))
          .map((line) => line.slice(0, line.indexOf(' '))),
      )
      if (missing.size > 0) {
        blobs = blobs.filter((blob) => !missing.has(blob))
        log(
          `the copy does not hold the base blob(s) ${[...missing].join(', ')} of ${patchId}; ` +
            'a three-way merge looks for them in your repository instead',
        )
      }
    } catch {
      // The pack below fails the same way, and says why.
    }
  }
  if (blobs.length > 0) {
    try {
      const dir = blobsDirectory(patchDir, patchId)
      mkdirSync(join(dir, 'pack'), { recursive: true })
      git(['pack-objects', '-q', join(dir, 'pack', 'pack')], repoDir, process.env, `${blobs.join('\n')}\n`)
    } catch (error) {
      // A half-written pack is worse than none: the merge would read a truncated object
      // store. The entries stay, so the merge asks the caller's repository for each blob
      // and refuses, file by file, only those it cannot find.
      rmSync(blobsDirectory(patchDir, patchId), { recursive: true, force: true })
      log(`could not save the base blobs of ${patchId} (${messageOf(error)}); a three-way merge of this patch looks for them in your repository`)
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
    for (const path of recordEntry(line).paths) paths.add(path)
  }
  // The name-status list already carries a rename's old path, but every base entry has to
  // be read from the caller's tree all the same; adding them here means a record whose list
  // is somehow short still stages "ours" completely. A preimage path is a plain name, not a
  // record field, so it is taken as it stands.
  for (const entry of record.preimage ?? []) paths.add(entry.path)
  return [...paths]
}

/**
 * The base entries a patch states about itself, for a record that saved none.
 *
 * Every section that changes or removes an existing file carries `index <old>..<new>`, and
 * the old id is the blob the patch was computed against. The ids are abbreviated, and a
 * section without an `index` line (a pure rename, a mode-only change) states no id at all:
 * its `blob` is null, which is how a caller tells "this patch cannot name its base" from
 * "its base is not here".
 *
 * @param {string} diff - the whole stored patch.
 * @returns {Array<{path: string, mode: string, blob: string | null}>} the base entries.
 */
function patchBaseEntries(diff) {
  const entries = []
  for (const section of diffSections(diff)) {
    if (!section.text.startsWith('diff --git ')) continue
    const { from } = diffSectionPaths(section.text)
    if (from === null) continue
    // Only the header lines: below the first hunk a line is content, not a header.
    const header = section.text.split('\n')
    const hunk = header.findIndex((line) => line.startsWith('@@') || line.startsWith('GIT binary patch') || line.startsWith('Binary files '))
    const head = (hunk < 0 ? header : header.slice(0, hunk)).join('\n')
    if (/^new file mode /m.test(head)) continue
    const index = /^index ([0-9a-f]+)\.\.[0-9a-f]+(?: (\d+))?$/m.exec(head)
    const mode = index?.[2] ?? /^(?:old|deleted file) mode (\d+)$/m.exec(head)?.[1] ?? '100644'
    entries.push({ path: from, mode, blob: index === null ? null : index[1] })
  }
  return entries
}

/**
 * The `STATUS<TAB>path` records between two trees in a scratch repository.
 *
 * `excludeBase` compares the state a base patch produced with the state the cumulative
 * patch produced; both are trees, so the records come from a plain tree diff rather than a
 * staged index.
 *
 * @param {string} dir - the scratch repository.
 * @param {string} from - the earlier tree.
 * @param {string} to - the later tree.
 * @param {NodeJS.ProcessEnv} env - environment for git.
 * @returns {string[]} the decoded records, in git's order.
 */
function nameStatusBetween(dir, from, to, env) {
  return decodeNameStatus(git(['diff', '--name-status', '-z', from, to], dir, env))
}

/**
 * The base entries of a diff between two trees, keyed by each path's state in the first.
 *
 * This is what a three-way merge of the `excludeBase` diff rebuilds its base from: every
 * path the own change touches, with the mode and blob the base patch's result had. A path
 * a rename leaves behind is included too, because that is the base side of the rename.
 *
 * @param {string} dir - the scratch repository.
 * @param {string} from - the earlier tree.
 * @param {string} to - the later tree.
 * @param {NodeJS.ProcessEnv} env - environment for git.
 * @returns {Array<{path: string, mode: string, blob: string}>} the entries.
 */
function preimageBetween(dir, from, to, env) {
  const paths = new Set()
  for (const line of nameStatusBetween(dir, from, to, env)) {
    for (const path of recordEntry(line).paths) paths.add(path)
  }
  const entries = []
  for (const item of git(['ls-tree', '-r', '-z', from], dir, env).split('\0')) {
    if (item === '') continue
    const tab = item.indexOf('\t')
    if (tab < 0) continue
    const [mode, , blob] = item.slice(0, tab).split(' ')
    const path = item.slice(tab + 1)
    if (!paths.has(path)) continue
    entries.push({ path, mode, blob })
  }
  return entries
}

/**
 * The note a cumulative patch with no own work is read or applied with.
 *
 * Such a patch equals its base patch; there is no diff to page and nothing to apply. The
 * note names the base patch so a caller can tell "the worker changed nothing" from "the
 * patch could not be separated".
 *
 * @param {object} record - a patch record whose `basePatch` is recorded.
 * @returns {string} the note.
 */
function noOwnWorkNote(record) {
  return `this patch holds no work beyond its base patch ${record.basePatch}; nothing to apply`
}

/**
 * Rebuild the base tree a stored patch was diffed against, in a scratch repository.
 *
 * The base commit lived only in the disposable copy, so the merge and `excludeBase` both
 * rebuild the tree from the record's saved preimage entries; a record that saved none states
 * its base in its own `index` lines (see `patchBaseEntries`). Blobs are resolved through the
 * scratch repository's alternates, which borrow the patch store's saved blobs and the
 * caller's objects read-only.
 *
 * @param {object} record - the patch record whose base is wanted.
 * @param {string} dir - the scratch repository.
 * @param {NodeJS.ProcessEnv} env - environment for git.
 * @param {string} unavailable - the sentence a missing base is refused with.
 * @returns {string} the base tree id.
 * @throws {Error} when an entry's blob cannot be found.
 */
function baseTreeOf(record, dir, env, unavailable) {
  const saved = Array.isArray(record.preimage)
  const entries = saved
    ? record.preimage.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string')
    : patchBaseEntries(readFileSync(record.patchPath, 'utf8'))
  const missing = []
  for (const entry of entries) {
    if (entry.mode === GITLINK_MODE) {
      git(['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.blob},${entry.path}`], dir, env)
      continue
    }
    if (typeof entry.blob !== 'string') {
      missing.push(`${entry.path}: the record has no base blob`)
      continue
    }
    const looked = gitAllowFailure(['rev-parse', '--verify', `${entry.blob}^{blob}`], dir, env)
    if (looked.status !== 0) {
      missing.push(`${entry.path}: base blob ${entry.blob} is not in this repository`)
      continue
    }
    git(['update-index', '--add', '--cacheinfo', `${entry.mode},${looked.stdout.trim()},${entry.path}`], dir, env)
  }
  if (missing.length > 0) {
    throw new Error(`${unavailable} ${missing.join('; ')}.`)
  }
  return git(['write-tree'], dir, env).trim()
}

/**
 * How many complete conflict-marker blocks a text holds.
 *
 * A block is a `<<<<<<< ` line, a later `=======` line and a later `>>>>>>> ` line, in
 * that order. A lone `=======` is a Markdown heading underline or a table rule, not a
 * conflict, so only the whole triple counts. Binary content holds none.
 *
 * @param {Buffer | string} content - the file's bytes.
 * @returns {number} the number of blocks.
 */
function conflictMarkerCount(content) {
  if (typeof content !== 'string') {
    if (content.includes(0)) return 0
    content = content.toString('utf8')
  }
  let count = 0
  let seen = 0
  for (const line of content.split(/\r?\n/)) {
    if (seen === 0 && line.startsWith('<<<<<<< ')) seen = 1
    else if (seen === 1 && line === '=======') seen = 2
    else if (seen === 2 && line.startsWith('>>>>>>> ')) {
      count += 1
      seen = 0
    }
  }
  return count
}

/**
 * The files whose added lines hold a complete conflict-marker block.
 *
 * Only the patch is read: a `+` line of a hunk is text the worker wrote, so a block there
 * was either meant (a test fixture) or left over from a merge in the worker's copy. Git's own
 * conflicts are reported by the merge and are not looked for here.
 *
 * @param {string} patch - a patch's text.
 * @returns {string[]} the files, by the name a caller selects them with.
 */
function patchMarkerFiles(patch) {
  const files = []
  for (const section of diffSections(patch)) {
    const added = []
    let inHunk = false
    for (const line of section.text.split('\n')) {
      if (line.startsWith('@@')) inHunk = true
      else if (inHunk && line.startsWith('+')) added.push(line.slice(1))
    }
    if (conflictMarkerCount(added.join('\n')) === 0) continue
    const names = diffSectionNames(section)
    if (names.length > 0) files.push(names[names.length - 1])
  }
  return files
}

/**
 * The warning for a patch that adds conflict markers to files.
 *
 * @param {string[]} names - the files.
 * @returns {string} the warning.
 */
function patchMarkerWarning(names) {
  return (
    `WARNING: the patch itself adds conflict markers to ${names.join(', ')}; if they are not intended (a test fixture), ` +
    'they are left over from a merge in the worker\'s copy'
  )
}

/**
 * Whether a tree already holds a patch's whole change.
 *
 * `git apply --reverse --check` succeeds when every hunk's result is in the tree. That alone
 * can also be true of a tree that never had the change: a hunk in repeated lines can find a
 * second place to match. So the forward check has to fail as well, which is what a tree that
 * already holds the change does; when both succeed the answer is unclear, and the caller
 * goes on as it would have without asking. An empty patch has nothing to find.
 *
 * @param {object} record - the patch record; `patchPath` is read.
 * @param {string} target - the tree to look in.
 * @returns {boolean} true when the reverse applies and the patch itself does not.
 */
function basePatchInTree(record, target) {
  // The same discovery rule `#applyTo` uses: outside a repository the target must not find
  // one enclosing it, or the paths would be read from that repository's top.
  const env = isGitWorkTree(target) ? process.env : { ...process.env, GIT_CEILING_DIRECTORIES: dirname(target) }
  const check = ['apply', '--check', '--whitespace=nowarn']
  if (gitAllowFailure([...check, '--reverse', record.patchPath], target, env).status !== 0) return false
  return gitAllowFailure([...check, record.patchPath], target, env).status !== 0
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

/** How far into a buffer git looks for a NUL before it calls the content binary. */
const BINARY_SNIFF_BYTES = 8000

/**
 * Whether content is binary the way git decides it: a NUL byte near the start.
 * @param {Buffer} content - the bytes.
 * @returns {boolean} true when git would not treat it as text.
 */
function looksBinary(content) {
  return content.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

/**
 * The line-ending style a file already uses: CRLF when most of its line breaks are CRLF.
 *
 * A majority rather than "every line" so a CRLF file with one stray LF line still reads as
 * the CRLF file it is. A file with no line break at all says nothing, and gets LF. Only the
 * fallback of `mergedContent` asks, for a file that matches neither form of "ours".
 *
 * @param {Buffer} content - the caller's file.
 * @returns {'crlf' | 'lf'} the style.
 */
function lineEndingOf(content) {
  let crlf = 0
  let lf = 0
  for (let at = content.indexOf(0x0a); at !== -1; at = content.indexOf(0x0a, at + 1)) {
    if (at > 0 && content[at - 1] === 0x0d) crlf += 1
    else lf += 1
  }
  return crlf > lf ? 'crlf' : 'lf'
}

/**
 * Text content with every line break in one style.
 *
 * Worked on bytes, not on a decoded string, so a file that is not valid UTF-8 keeps every
 * byte that is not part of a line break. The line breaks are found with `indexOf` and the
 * lines between them copied whole into one buffer sized up front: building the result one
 * byte at a time in a JS array failed every file past 2^27 bytes ("Invalid array length")
 * and needed some twenty bytes of heap per byte before that.
 *
 * @param {Buffer} content - the merged text.
 * @param {'crlf' | 'lf'} style - the style to write.
 * @returns {Buffer} the converted content.
 */
function withLineEndings(content, style) {
  let breaks = 0
  let crlf = 0
  for (let at = content.indexOf(0x0a); at !== -1; at = content.indexOf(0x0a, at + 1)) {
    breaks += 1
    if (at > 0 && content[at - 1] === 0x0d) crlf += 1
  }
  const out = Buffer.allocUnsafe(style === 'crlf' ? content.length + breaks - crlf : content.length - crlf)
  let from = 0
  let to = 0
  for (let at = content.indexOf(0x0a); at !== -1; at = content.indexOf(0x0a, at + 1)) {
    // A CR that ends a line is dropped with the line and put back when the style wants it.
    // It belongs to this line only when it is past the previous break.
    const end = at > from && content[at - 1] === 0x0d ? at - 1 : at
    to += content.copy(out, to, from, end)
    if (style === 'crlf') {
      out[to] = 0x0d
      to += 1
    }
    out[to] = 0x0a
    to += 1
    from = at + 1
  }
  content.copy(out, to, from)
  return out
}

/**
 * The paths among `paths` that the caller's own attributes say are not text.
 *
 * A `-text` or `binary` attribute is the caller telling git never to convert a file's line
 * endings, so the merged content of such a path is written exactly as the blob holds it.
 * The scratch repository carries no attribute files, so the question is asked in the
 * caller's tree, once for every path. A tree that is not a repository has no attributes.
 *
 * @param {string} target - the caller's tree.
 * @param {string[]} paths - the paths about to be written.
 * @returns {Set<string>} the paths whose `text` attribute is unset.
 */
function notTextPaths(target, paths) {
  const found = new Set()
  if (paths.length === 0 || !isGitWorkTree(target)) return found
  let output
  try {
    output = git(['check-attr', '-z', '--stdin', 'text'], target, process.env, `${paths.join('\0')}\0`)
  } catch {
    // No answer means no attribute is known to forbid conversion; the content checks still apply.
    return found
  }
  const fields = output.split('\0')
  for (let at = 0; at + 2 < fields.length; at += 3) {
    if (fields[at + 2] === 'unset') found.add(fields[at])
  }
  return found
}

/**
 * What one merged path will be written as, read without touching the caller's tree.
 *
 * The blob is read as bytes: a text read would replace every invalid UTF-8 sequence and
 * corrupt a binary file. How its line endings are written follows how the caller's file
 * relates to "ours", the blob `hash-object --path` made of that very file:
 *
 * - binary content (a NUL near the start, in the blob or in the caller's file, or a path
 *   the caller's attributes mark `-text`) is the raw blob, never converted;
 * - a file that is exactly what `cat-file --filters` makes of "ours" is checked out the way
 *   git converts, so the merged blob goes through `--filters` too: git's own behaviour;
 * - a file that is exactly the raw "ours" blob is an unconverted checkout — a Windows
 *   caller with `core.autocrlf=true` and an LF checkout, whose every merged file came back
 *   CRLF while a plain apply kept LF — so the raw merged blob is written;
 * - a file that is neither (a clean filter that does more than line endings, say) keeps the
 *   style most of its line breaks use;
 * - a new file goes through `cat-file --filters`, because there is no checkout to follow.
 *
 * The blob already carries every line ending the worker chose, and the lines neither side
 * touched exactly as "ours" had them, so the first two cases keep a worker's own
 * CRLF-to-LF conversion and a mixed file's odd lines; the majority rule, once applied to
 * every existing file, undid both.
 *
 * @param {string} scratch - the scratch repository the blob lives in.
 * @param {string} target - the caller's tree.
 * @param {{path: string, entry: {mode: string, sha: string}}} write - the merged path and its blob.
 * @param {Set<string>} notText - paths the caller's attributes mark as not text.
 * @param {string} ours - the merge's "ours" commit, holding the caller's file as hashed.
 * @param {NodeJS.ProcessEnv} env - environment for git.
 * @returns {{link: string} | {content: Buffer}} the link text, or the file's bytes.
 */
function mergedContent(scratch, target, { path, entry }, notText, ours, env) {
  const blob = gitBuffer(['cat-file', 'blob', entry.sha], scratch, env)
  if (entry.mode === '120000') return { link: blob.toString('utf8') }
  const filtered = (sha) => gitBuffer(['cat-file', '--filters', `--path=${path}`, sha], scratch, env)
  let existing
  try {
    const full = join(target, path)
    if (lstatSync(full).isFile()) existing = readFileSync(full)
  } catch {
    // Not there, or not readable as a file: it is written as a new file.
  }
  if (notText.has(path) || looksBinary(blob) || (existing !== undefined && looksBinary(existing))) return { content: blob }
  if (existing === undefined) return { content: filtered(entry.sha) }
  const mine = treeEntry(scratch, ours, path, env)
  if (mine !== undefined && mine.type === 'blob') {
    if (existing.equals(filtered(mine.sha))) return { content: filtered(entry.sha) }
    if (existing.equals(gitBuffer(['cat-file', 'blob', mine.sha], scratch, env))) return { content: blob }
  }
  return { content: withLineEndings(blob, lineEndingOf(existing)) }
}

/**
 * Write one merged path into the caller's tree, from content already read.
 *
 * An existing symlink is removed rather than written through, or the content would land
 * on whatever it points at.
 *
 * @param {string} target - the caller's tree.
 * @param {string} path - the path, relative to the target.
 * @param {string} mode - the result's git mode.
 * @param {{link: string} | {content: Buffer}} merged - what `mergedContent` read.
 * @returns {void}
 */
function writeResultFile(target, path, mode, merged) {
  const full = join(target, path)
  if ('link' in merged) {
    mkdirSync(dirname(full), { recursive: true })
    rmSync(full, { force: true })
    symlinkSync(merged.link, full)
    return
  }
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
  writeFileSync(full, merged.content)
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

/**
 * One path from a patch record, named relative to the service root.
 *
 * A record computed inside a nested repository stores paths as that repository's git names
 * them (`n.txt`), while the caller's tree is the service root and the same file is
 * `sub/n.txt` there. Every path the caller is shown is named the way the caller names it,
 * so a refusal or a drift warning can be acted on without translating it first.
 *
 * @param {object} record - the patch record; `scope` is the nested repository, when there is one.
 * @param {string} path - a path relative to the record's repository.
 * @returns {string} the path relative to the service root, with `/` separators.
 */
function serviceRootPath(record, path) {
  return record.scope ? join(record.scope, path).split(sep).join('/') : path
}

/**
 * How far the caller's tree has moved since a patch's base, and whether it touched the
 * patch's own files.
 *
 * A patch computed against a copy that has since fallen behind is exactly the case that
 * needed a three-way apply with no warning beforehand. The count is about commits between
 * the caller's HEAD then and now; the file list narrows that to the patch's files, because
 * an unrelated commit elsewhere in a large tree says nothing about this patch.
 *
 * `flash_patch` asks this of the first page of every patch, so the whole patch is hashed
 * once rather than once per file: see `workingTreeBlobs`.
 *
 * @param {object} record - a patch record, with `base` and `preimage` when it has them.
 * @param {string} root - the service root the record was computed for.
 * @param {Map<string, string | null | undefined>} [blobs] - a batch the caller already
 *   made for this record and tree; when omitted, one is made here.
 * @returns {{commitsBehind: number | null, filesChangedSince: string[]} | null} the drift,
 *   or null for a patch salvaged without a recorded base, or for one already applied.
 */
function patchDrift(record, root, blobs) {
  // An applied patch is no longer ahead of the tree: its own writes are what the tree now
  // holds, so every patch file would be reported as a caller edit. The question the drift
  // answers — "will this apply over what changed since its base?" — has already been
  // answered by the apply, so there is nothing to report.
  if (record?.appliedAt !== null && record?.appliedAt !== undefined) return null
  const base = record?.base
  if (typeof base !== 'string' || base.length === 0) return null
  const target = record.scope ? join(root, record.scope) : root
  const batch = blobs ?? workingTreeBlobs(target, patchBlobPaths(record))
  return {
    commitsBehind: commitsBehindBase(record, base, target),
    // The record's paths are inside its scope; a caller reading `filesChangedSince` works
    // from the service root, exactly as `filesChanged` in the same result does.
    filesChangedSince: filesChangedSinceBase(record, target, batch).map((path) => serviceRootPath(record, path)),
  }
}

/**
 * The commit id the base was committed on top of: the caller's HEAD at copy time.
 *
 * New records carry it directly. A record written before the field existed can still name
 * it when the base commit happens to be in this repository's object store, which is why
 * the fallback is attempted rather than giving up at once.
 *
 * @param {string} base - the patch's base commit id.
 * @param {string} target - the repository to ask.
 * @returns {string | undefined} the parent id, or undefined when it cannot be resolved.
 */
function resolveBaseParent(base, target) {
  try {
    const parent = git(['rev-parse', '--verify', '-q', `${base}^`], target).trim()
    return parent === '' ? undefined : parent
  } catch {
    return undefined
  }
}

/**
 * How many commits the caller's HEAD has that the patch's base did not start from.
 *
 * `null` is the honest answer when the question cannot be answered: no HEAD, a base whose
 * parent is gone from this object store, or a tree that is no longer a repository. A wrong
 * zero would read as "nothing moved" and is worse than saying so.
 *
 * @param {object} record - the patch record.
 * @param {string} base - the patch's base commit id.
 * @param {string} target - the repository whose HEAD is counted.
 * @returns {number | null} the commit count, or null.
 */
function commitsBehindBase(record, base, target) {
  const recorded = record.baseParent
  const parent = typeof recorded === 'string' && recorded.length > 0 ? recorded : resolveBaseParent(base, target)
  if (parent === undefined) return null
  try {
    if (git(['rev-parse', '--verify', '-q', 'HEAD'], target).trim() === '') return null
    const count = Number(git(['rev-list', '--count', `${parent}..HEAD`], target).trim())
    return Number.isInteger(count) ? count : null
  } catch {
    return null
  }
}

/**
 * One decoded `STATUS<TAB>path` record, with a rename's or copy's old path named too.
 *
 * `git diff --name-status` writes `STATUS<TAB>path`, and a rename or copy adds the old
 * path first: `STATUS<TAB>old<TAB>new`. The old path is the path the apply removes, so it
 * has to be read as its own entry rather than dropped with the other leading fields.
 * `recordEntry` does the splitting and the decoding, so this view and `recordPaths` name
 * the same file for the same line.
 *
 * @param {string} line - one stored `--name-status` record.
 * @returns {{status: string, path: string, oldPath?: string}} the decoded record.
 */
function nameStatusEntry(line) {
  const { status, paths } = recordEntry(line)
  if (status.startsWith('R') || status.startsWith('C')) {
    return { status, oldPath: paths[0] ?? '', path: paths[1] ?? '' }
  }
  return { status, path: paths[0] ?? '' }
}

/**
 * The base blob of every path a patch's preimage records, keyed by path.
 *
 * A preimage entry's `path` is stored plainly, straight from the `-z` read that produced
 * it, so it is used as it is: decoding it would read a name that begins with `"` as git's
 * quoted spelling and lose the leading quote.
 *
 * @param {object} record - the patch record, with `preimage` when it has one.
 * @returns {Map<string, string>} path to base blob id.
 */
function preimageBlobs(record) {
  const blobs = new Map()
  for (const entry of record.preimage ?? []) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.path !== 'string' || typeof entry.blob !== 'string') continue
    blobs.set(entry.path, entry.blob)
  }
  return blobs
}

/**
 * The blob of one path, read from a caller's batch when one was made.
 *
 * A working-tree hash is one `git hash-object` process per file when it is done path by
 * path, which is what made drift on a 300-file patch take seconds. A caller that has a
 * batch of the whole patch passes it here; one that does not (a single path, a test)
 * still gets the per-path read, so both answer the same.
 *
 * @param {string} target - the work tree.
 * @param {string} path - the path, relative to the target.
 * @param {Map<string, string | null | undefined> | undefined} blobs - the batch, when one
 *   exists. It must cover every path asked about.
 * @returns {string | null | undefined} the blob id, null when absent, undefined when the
 *   path exists but cannot be hashed as a file.
 */
function batchedBlob(target, path, blobs) {
  return blobs === undefined ? workingTreeBlob(target, path) : blobs.get(path)
}

/**
 * Whether one path in the tree now holds different content than its base blob.
 *
 * A path that cannot be hashed (a directory where a file was, a git failure) is not
 * evidence of drift and answers false; a missing path answers true against a known base
 * and false when the patch itself adds the path (there is no base entry).
 *
 * @param {string} target - the tree the patch applies to.
 * @param {string} path - the path, relative to the target.
 * @param {string | undefined} base - the path's base blob id, when one is recorded.
 * @param {Map<string, string | null | undefined>} [blobs] - the patch's blob batch, when
 *   the caller made one.
 * @returns {boolean} true when the content differs from the base.
 */
function blobDiffersFromBase(target, path, base, blobs) {
  const current = batchedBlob(target, path, blobs)
  if (current === undefined) return false
  return base === undefined ? current !== null : current !== base
}

/**
 * Every path of a patch whose working-tree blob the drift checks can ask about.
 *
 * `filesChangedSinceBase` compares a change's new path and — for a rename — its old
 * one; `destructiveEdits` compares only the paths the patch removes. One batch over the
 * union serves both, which is what keeps an apply at one git spawn for the whole patch.
 *
 * @param {object} record - the patch record.
 * @returns {string[]} the record-relative paths, without duplicates.
 */
function patchBlobPaths(record) {
  // A record from before blob saving has no base content, so no blob is ever compared
  // and hashing anything would be work nobody reads.
  if (!Array.isArray(record.preimage)) return []
  const paths = new Set()
  for (const line of record.filesChanged ?? []) {
    const { path, oldPath } = nameStatusEntry(line)
    if (path.length > 0) paths.add(path)
    if (oldPath !== undefined) paths.add(oldPath)
  }
  return [...paths]
}

/**
 * One path as `git hash-object --stdin-paths` wants it on its own line.
 *
 * The command reads one path per line, so a name holding a line break cannot be sent
 * plainly, and a line that starts with `"` is read as a C-quoted name. Both are quoted
 * the way git spells them itself; every other name goes through literally.
 *
 * @param {string} path - a path relative to the work tree.
 * @returns {string} the line to write for it.
 */
function stdinPathLine(path) {
  if (!/^"|[\n\r]/.test(path)) return path
  const escaped = path.replace(/[\\"]/g, (char) => `\\${char}`).replace(/\r/g, '\\r').replace(/\n/g, '\\n')
  return `"${escaped}"`
}

/**
 * The blob ids of many paths in one working tree, hashed in one git call.
 *
 * `git hash-object --stdin-paths` reads file names from standard input and hashes each
 * file from disk, applying the same path-based filters (`--path`) the per-file call asked
 * for. That is what keeps the batch's answers identical to the per-file ones: a
 * `.gitattributes` `text eol=lf` file with a CRLF working copy hashes to its LF blob
 * either way.
 *
 * Symlinks keep their own per-path read: `--stdin-paths` follows the link and would hash
 * the content it points at, while a symlink's blob is its link text.
 *
 * @param {string} target - the work tree.
 * @param {string[]} paths - the paths to hash, relative to the target. Duplicates are
 *   allowed; the map keeps one answer per path.
 * @returns {Map<string, string | null | undefined>} path to blob id: null when the path
 *   is absent, undefined when it is present but cannot be hashed as a file.
 */
function workingTreeBlobs(target, paths) {
  const blobs = new Map()
  const regular = []
  for (const path of paths) {
    const full = join(target, path)
    let info
    try {
      info = lstatSync(full)
    } catch {
      blobs.set(path, null)
      continue
    }
    if (info.isSymbolicLink()) {
      // The same read `#stageCallerPath` does: a link's blob is its target text.
      try {
        blobs.set(path, git(['hash-object', '--stdin'], target, process.env, readlinkSync(full)).trim())
      } catch {
        blobs.set(path, undefined)
      }
      continue
    }
    if (!info.isFile()) {
      blobs.set(path, undefined)
      continue
    }
    regular.push(path)
  }
  // Nothing regular to hash: no process is spawned at all, which is the common case for
  // a patch that only adds files.
  if (regular.length === 0) return blobs
  let output
  try {
    output = git(['hash-object', '--stdin-paths'], target, process.env, `${regular.map(stdinPathLine).join('\n')}\n`)
  } catch {
    // One unreadable file fails the whole batch. Falling back to the per-path read gives
    // exactly the answer this gave before the batch existed: an unhashable path is
    // `undefined`, not an error, and a path that vanished is `null`.
    for (const path of regular) blobs.set(path, workingTreeBlob(target, path))
    return blobs
  }
  const ids = output.split('\n')
  for (let at = 0; at < regular.length; at += 1) {
    const id = ids[at]
    blobs.set(regular[at], typeof id === 'string' && id.length > 0 ? id.trim() : undefined)
  }
  return blobs
}

/**
 * The patch's own files whose content in the caller's working tree now differs from the
 * base it was computed against.
 *
 * Only the patch's files are checked, and their base blobs come from the record's preimage:
 * the base commit itself lived in a copy that is gone, so `git hash-object` of what is on
 * disk is compared with the saved id. Every path the record names is checked, not only the
 * last field of a rename: a pure rename hunk carries no content for `git apply` to check,
 * and the old path — the one the apply deletes — is exactly where the caller's edit can be
 * lost. A rename's new path did not exist in the base, so it is reported only when
 * something now occupies it with content other than the old path's base blob. A path the
 * patch adds has no base entry, so it counts as changed only when occupied.
 *
 * @param {object} record - the patch record, with `preimage` for the base blobs.
 * @param {string} target - the tree the patch applies to.
 * @param {Map<string, string | null | undefined>} [blobs] - the patch's blob batch, when
 *   the caller made one (`patchBlobPaths` names every path it must hold).
 * @returns {string[]} the changed paths, capped only by the patch's own file count.
 */
function filesChangedSinceBase(record, target, blobs) {
  // A record from before blob saving kept no base content, so no blob comparison is
  // possible; saying "nothing changed" would be a guess, but an empty list is the only
  // answer a caller can act on and a warning about every file would be worse.
  if (!Array.isArray(record.preimage)) return []
  const baseBlobs = preimageBlobs(record)
  const changed = []
  for (const line of record.filesChanged ?? []) {
    const { status, path, oldPath } = nameStatusEntry(line)
    // A rename removes its old path, and a deletion removes its only path; both are the
    // path whose content the apply takes away, so both are compared against their own
    // preimage entry.
    const removed = oldPath ?? (status.startsWith('D') ? path : undefined)
    if (removed !== undefined) {
      if (blobDiffersFromBase(target, removed, baseBlobs.get(removed), blobs)) changed.push(removed)
      if (oldPath !== undefined) {
        const current = batchedBlob(target, path, blobs)
        if (current !== undefined && current !== null && current !== baseBlobs.get(oldPath)) changed.push(path)
      }
      continue
    }
    if (blobDiffersFromBase(target, path, baseBlobs.get(path), blobs)) changed.push(path)
  }
  return changed
}

/**
 * The paths a patch deletes or renames away that the caller changed since the base.
 *
 * These are the writes a plain or three-way apply cannot verify in the usual way: `git
 * apply` has no content of its own to compare for a pure rename, so it happily removes the
 * old path whatever it now holds. The caller's index is never touched, so their edit is
 * simply gone. Naming the paths before anything is written is what lets the apply refuse
 * instead of losing the work.
 *
 * @param {object} record - the patch record, with `preimage` for the base blobs.
 * @param {string} target - the tree the patch applies to.
 * @param {Map<string, string | null | undefined>} [blobs] - the patch's blob batch, when
 *   the caller made one (`patchBlobPaths` names every path it must hold).
 * @returns {string[]} the changed paths the patch would remove.
 */
function destructiveEdits(record, target, blobs) {
  if (!Array.isArray(record.preimage)) return []
  const baseBlobs = preimageBlobs(record)
  const changed = []
  for (const line of record.filesChanged ?? []) {
    const { status, path, oldPath } = nameStatusEntry(line)
    // A copy leaves its old path in place, so only a rename or a deletion removes one.
    const removed = status.startsWith('R') ? oldPath : status.startsWith('D') ? path : undefined
    if (removed === undefined) continue
    const current = batchedBlob(target, removed, blobs)
    // A path already gone is fine: there is no edit to lose.
    if (current === undefined || current === null) continue
    if (current !== baseBlobs.get(removed)) changed.push(removed)
  }
  return changed
}

/**
 * The paths a patch deletes or renames away that the caller may still have.
 *
 * A record from before blob saving carries no `preimage`, so `destructiveEdits` has no base
 * content to compare and returns nothing. The plain apply still removes these paths, so
 * naming the ones that are present is the only warning left to give.
 *
 * @param {object} record - the patch record.
 * @param {string} target - the tree the patch applies to.
 * @returns {string[]} the scope-relative paths a plain apply would remove.
 */
function unverifiableRemovals(record, target) {
  const removed = []
  for (const line of record.filesChanged ?? []) {
    const { status, path, oldPath } = nameStatusEntry(line)
    // A copy leaves its old path in place, so only a rename or a deletion removes one.
    const candidate = status.startsWith('R') ? oldPath : status.startsWith('D') ? path : undefined
    if (candidate === undefined) continue
    try {
      // The same "already gone means nothing to lose" rule `destructiveEdits` uses. A
      // dangling symlink still exists as an entry and would be removed, so `lstat` is the
      // test rather than `existsSync`.
      lstatSync(join(target, candidate))
    } catch {
      continue
    }
    removed.push(candidate)
  }
  return removed
}

/**
 * The warning an apply of an old record produces for paths it cannot check.
 *
 * @param {string[]} paths - the paths the plain apply removes, relative to the service root.
 * @returns {string} the warning sentence.
 */
function unverifiedRemovalWarning(paths) {
  return (
    `this patch was stored by an older release, so whether you changed ${paths.join(', ')} since cannot be checked; ` +
    'a plain apply removes them'
  )
}

/**
 * The refusal an apply of a destructive patch produces for edited paths.
 *
 * The refusal names both ways out: the three-way merge, which keeps the caller's edit and
 * marks a conflict in the file, and `force`, which says the edit may be discarded. Naming
 * only `force` used to make the safe option look unavailable.
 *
 * @param {string} patchId - the patch's full id.
 * @param {string[]} paths - the caller-changed paths the patch would remove, relative to the
 *   service root.
 * @returns {string} the refusal sentence.
 */
function destructiveApplyMessage(patchId, paths) {
  return (
    `refusing to apply ${patchId}: it deletes or renames ${paths.join(', ')}, which you changed since the worker's ` +
    'copy was made; your edit would be lost. Pass threeWay: true to merge it (conflicts are marked in the file), ' +
    'or save it first and pass force: true'
  )
}

/**
 * The blob id of one path in a working tree, as `git add` would compute it.
 *
 * @param {string} target - the work tree.
 * @param {string} path - the path, relative to the target.
 * @returns {string | null | undefined} the blob id, null when the path is absent, or
 *   undefined when it exists but cannot be hashed as a file.
 */
function workingTreeBlob(target, path) {
  const full = join(target, path)
  let info
  try {
    info = lstatSync(full)
  } catch {
    return null
  }
  try {
    // The same two shapes `#stageCallerPath` reads: a symlink's blob is its target text, and
    // `--path` lets a regular file get the checkout's end-of-line normalisation.
    if (info.isSymbolicLink()) return git(['hash-object', '--stdin'], target, process.env, readlinkSync(full)).trim()
    if (info.isFile()) return git(['hash-object', `--path=${path}`, '--stdin'], target, process.env, readFileSync(full)).trim()
  } catch {
    return undefined
  }
  return undefined
}

/**
 * The ids of every patch in `record`'s line of work: the patches it continued from, however far
 * back, and the patches that continued from it.
 *
 * @param {object} record - the patch record.
 * @param {object[]} all - every stored record of the root.
 * @returns {Set<string>} the related ids, `record` itself excluded.
 */
function patchLineage(record, all) {
  const byId = new Map(all.map((entry) => [entry.patchId, entry]))
  const related = new Set()
  for (let id = record.basePatch; typeof id === 'string' && !related.has(id); id = byId.get(id)?.basePatch) related.add(id)
  for (let grew = true; grew; ) {
    grew = false
    for (const entry of all) {
      if (related.has(entry.patchId) || entry.patchId === record.patchId) continue
      if (entry.basePatch === record.patchId || related.has(entry.basePatch)) {
        related.add(entry.patchId)
        grew = true
      }
    }
  }
  related.delete(record.patchId)
  return related
}

/** The `overlaps` field of a patch page or a result: present only when there is an overlap. */
export function overlapField(overlaps) {
  return overlaps.length === 0 ? {} : { overlaps }
}

/**
 * The warning that a patch's files moved in the caller's tree while the worker ran.
 *
 * @param {string[]} files - the patch's files that changed since its base.
 * @returns {string} the warning, naming at most five files.
 */
function driftWarning(files) {
  const named = files.slice(0, 5).join(', ')
  const more = files.length > 5 ? `, and ${String(files.length - 5)} more` : ''
  return (
    `${String(files.length)} of this patch's files changed in your tree since the worker's copy was made ` +
    `(${named}${more}); review the result, or use threeWay: true if the plain apply fails`
  )
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
   * @param {string} [options.baseDir] - the state base directory the default layout lives
   *   under, `$TMPDIR/flash-mcp` unless given. The sweep, the legacy-store migration and
   *   `trim` all work inside it, so a test that injects one never touches the real temp
   *   base, and the per-pid layout stays exactly what `defaultStateDir` computes.
   * @param {number} [options.patchRetentionDays] - how many days an unapplied patch is
   *   kept before the startup prune removes it.
   * @param {number} [options.maxStateBytes] - how much this root's patches and retired
   *   trees may take before `trim` removes the reclaimable ones; 0 or omitted: no cap.
   * @param {number} [options.sweepIntervalMs] - how often a running pool sweeps dead
   *   owners and trims; 0 turns the timer off.
   * @param {string[]} [options.copyExclude] - names or relative paths left out of the copy
   *   where it is safe; merged over `.flash-agents.json`, options last.
   * @param {Record<string, string>} [options.slotEnv] - `ENV_NAME: "home:<name>" | "cache:<name>" |
   *   "port:<base>[/<stride>]" | "value:<text>"` entries pointing the worker's runtime at
   *   writable per-slot directories, reserving a per-slot port range, or setting a plain
   *   value in every slot; options win per variable over the settings file.
   * @param {boolean} [options.allowSlotSetup] - whether the `slotSetup` steps in
   *   `.flash-agents.json` may run on the host. Off by default: a setup step is host code
   *   outside the worker's sandbox, so it needs an explicit opt-in.
   * @param {boolean} [options.deferStartupSweep] - whether to leave the store migration,
   *   the dead-owner sweep, the disk hygiene and the patch load to `startupSweep()`. Off
   *   by default, so a pool built by the doctor, by `clean` or by a test sees the swept
   *   state the moment its constructor returns. A server sets it so it can answer the
   *   MCP `initialize` handshake before the sweep — which on a machine that died with
   *   multi-gigabyte slot trees used to take minutes — starts.
   * @param {string} [options.platform] - platform whose `platform` section applies, and
   *   whose environment-name case rule is used (default `process.platform`; injectable
   *   so a Windows section can be tested anywhere).
   * @param {(from: string, to: string) => void} [options.renameDirectory] - the rename that
   *   moves a build cache in and out of the per-root store, a dead slot's tree aside, and a
   *   timed-out slot's tree to a retired name; `fs.renameSync` unless given, so a test can
   *   make it fail the way an open handle does on Windows.
   * @param {(pid: number) => string | null} [options.processCommandLine] - `processCommandLine`,
   *   which slot locks use to tell a live owner from a reused pid; injectable for tests.
   * @param {(from: string, to: string) => void} [options.linkLock] - `fs.linkSync`, the atomic
   *   step that creates a slot lock; a filesystem that refuses hard links falls back to an
   *   exclusive create. Injectable so a test can run as such a filesystem.
   * @param {(path: string) => object} [options.statfs] - `fs.statfsSync`, asked once per
   *   leased slot for the free space of the state volume; injectable for tests.
   * @param {(message: string) => void} [options.log] - progress log.
   */
  constructor({
    root,
    slots = 2,
    stateDir,
    baseDir,
    copyExclude,
    slotEnv,
    allowSlotSetup = false,
    patchRetentionDays = PATCH_RETENTION_DAYS,
    maxStateBytes = 0,
    sweepIntervalMs = SWEEP_INTERVAL_MS,
    deferStartupSweep = false,
    platform = process.platform,
    renameDirectory = renameSync,
    processCommandLine: commandLineOf = processCommandLine,
    linkLock = linkSync,
    statfs = statfsSync,
    log = () => {},
  }) {
    this.root = resolve(root)
    /** Whether this instance owns a private state directory it may clear. */
    this.ownsStateDir = stateDir === undefined || stateDir === null || stateDir === ''
    /** The base every default-layout directory of this root sits under. */
    this.baseDir = baseDir === undefined || baseDir === null || baseDir === '' ? stateBaseDir() : resolve(baseDir)
    /**
     * The nonce that names this pool: its instance directory, its slot locks and its
     * retired trees. Read here rather than inside `defaultStateDir` so a slot lock and the
     * state directory of the same pool carry the same value.
     */
    this.instance = randomUUID().slice(0, 8)
    this.stateDir = this.ownsStateDir ? defaultStateDir(this.root, { baseDir: this.baseDir, instance: this.instance }) : resolve(stateDir)
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
    this.renameDirectory = renameDirectory
    this.linkLock = linkLock
    this.statfs = statfs
    /** How this pool reads a process's command line, so a slot lock can name its owner. */
    this.commandLineOf = commandLineOf
    /**
     * This process's own command line, recorded in every slot lock the pool writes. It is
     * what tells a later server that a live pid is this pool and not an unrelated process
     * that happened to receive the same number.
     * @type {string}
     */
    this.commandLine = processCommandLine(process.pid)
    /**
     * Where idle build caches wait between servers. Only the default layout has one: a
     * configured state directory is the deployment's to manage, and a store beside it would
     * be state the operator did not ask for.
     */
    this.cacheStore = this.ownsStateDir ? cacheStoreDir(this.baseDir, this.root) : undefined
    this.log = log
    /**
     * Where this root's stable slot directories live, or undefined when a configured state
     * directory keeps the older `<stateDir>/slots/slot-<id>` layout. A stable slot's path
     * depends only on the root and the slot number, which is what lets the build cache of
     * one server be the build cache of the next server after a restart.
     * @type {string | undefined}
     */
    this.slotsBaseDir = this.ownsStateDir ? join(this.baseDir, rootDigest(this.root), SLOTS_DIRECTORY) : undefined
    /**
     * How many trees the pool wanted, and the numbers it actually holds. The numbers are
     * taken from the locks (`claimSlots`): two servers on one root get disjoint ones, the
     * second starting at the first number no live server holds. A default pool that cannot
     * take a single number — an unwritable state base — falls back to its private state
     * directory, which is the older layout and needs no lock; that is logged, never silent.
     */
    this.slotCount = Math.max(1, slots)
    /** The slot numbers this pool holds, ascending. @type {number[]} */
    this.slotIds = Array.from({ length: this.slotCount }, (_, id) => id)
    /** Whether `slot.dir` is the stable per-root path or the older per-instance one. */
    this.stableSlots = false
    if (this.slotsBaseDir !== undefined) {
      const claimed = claimSlots(this.slotsBaseDir, {
        count: this.slotCount,
        pid: process.pid,
        instance: this.instance,
        command: this.commandLine,
        log: this.log,
        commandLineOf: this.commandLineOf,
        renameDirectory: this.renameDirectory,
        linkLock: this.linkLock,
      })
      if (claimed.length === 0) {
        this.log(`no stable slot could be claimed under ${this.slotsBaseDir}; this pool keeps its slots in ${this.stateDir}, which costs the next server the build cache`)
      } else {
        this.stableSlots = true
        this.slotIds = claimed
      }
    }
    /**
     * One past the highest slot number this pool holds, for a `port:` range's upper check:
     * the second server on a root starts at a higher number than its own slot count.
     */
    this.slotHighest = this.slotIds.reduce((max, id) => Math.max(max, id), 0) + 1
    /**
     * Whether the heavy start-up work was deferred to `startupSweep()`.
     * @type {boolean}
     */
    this.deferStartupSweep = deferStartupSweep === true
    /**
     * Whether the deferred sweep has finished. Without deferral the constructor has
     * already done that work, so this starts true.
     * @type {boolean}
     */
    this.startupSweepDone = false
    /** The one promise `startupSweep` hands out, so a second call cannot start a pass. */
    this.startupSweepPromise = undefined
    /** Whether `close()` has run; a sweep in flight stops at its next step. */
    this.closed = false
    // Read now, and again whenever a writing call leases a slot after a file changed (see
    // `refreshSettings`): the VS Code extension has no `/mcp reconnect`, so a server that
    // read them only once could never be given new settings there. A broken file only logs;
    // the service still starts.
    this.platform = platform
    this.settingsPaths = new Map([
      [SETTINGS_FILE, join(this.root, SETTINGS_FILE)],
      [LOCAL_SETTINGS_FILE, join(this.root, LOCAL_SETTINGS_FILE)],
    ])
    /**
     * What each settings file held when it was last read: its stamp, a key for its content,
     * the last content that parsed (which is what the layers are built from), and the
     * problem with its current content, if it has one.
     *
     * @type {Map<string, {stamp: object, contentKey: string, parsed: object, problem?: string, hadGood: boolean}>}
     */
    this.settingsFiles = new Map()
    for (const [file, path] of this.settingsPaths) {
      // The stamp is taken before the read, so an edit landing between the two is seen as a
      // change next time and re-read rather than missed.
      const stamp = this.#settingsStamp(path)
      const parsed = readSettingsFile(path, file, this.log)
      this.settingsFiles.set(file, {
        stamp,
        contentKey: settingsContentKey(parsed),
        parsed: parsed.problem === undefined ? parsed : { present: true, settings: {}, sections: new Map() },
        problem: parsed.problem,
        // A missing file parses cleanly but holds nothing to keep; only a file that was
        // there and valid gives a later broken edit something to fall back on.
        hadGood: parsed.present === true && parsed.problem === undefined,
      })
    }
    const layered = this.#layerSettingsFiles()
    // One line, only when a settings file exists, so the start log says which layers the
    // pool really applied. A layer with no accepted keys is not a layer: announcing it
    // would claim settings that a typo kept from taking effect.
    if (layered.present && layered.layers.length > 0) this.log(`settings: ${layered.layers.join(', ')}`)
    warnLocalSettingsTracking(this.root, this.settingsPaths.get(LOCAL_SETTINGS_FILE), this.log)
    if (copyExclude !== undefined && !Array.isArray(copyExclude)) {
      this.log('ignoring the copyExclude option: it must be an array of strings')
    }
    /** The pool options that are layered over the files on every (re)read. */
    this.optionCopyExclude = Array.isArray(copyExclude) ? copyExclude : []
    this.optionSlotEnv = slotEnv
    /** Whether the settings files' `slotSetup` steps may run on the host. */
    this.slotSetupAllowed = allowSlotSetup === true
    /**
     * The settings a call leased now would use. A leased slot keeps its own reference
     * (`slot.settings`), so a reload while a call runs never changes that call.
     */
    this.settings = this.#buildSettings(layered)
    if (this.settings.slotSetupWarning !== undefined) this.log(SETUP_NOT_ALLOWED_WARNING)
    this.clones = 0
    /** Whether the one-off "no copy-on-write clone here" line was already logged. */
    this.copyFallbackLogged = false
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
    this.slots = this.slotIds.map((id) => ({
      id,
      dirIndex: 0,
      dir: this.#slotDirectory(id, 0),
      base: null,
      cacheFromRetired: false,
      busy: false,
      orphans: [],
      stoppedOrphans: new Set(),
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
    //
    // With `deferStartupSweep` all of that moves to `startupSweep()`, which the server
    // starts only after it answered `initialize`: on the machine that prompted this, a
    // dead owner's slot trees held multi-gigabyte `cargo` targets, and deleting them in
    // the constructor made the client's 30 s connect timeout expire.
    mkdirSync(this.stateDir, { recursive: true })
    // A configured `calls` directory is part of the configured state and is made eagerly
    // as before. The durable default store is made on demand: constructing a pool that
    // never stores a patch must not leave an empty directory in the user's data
    // directory, which is also what keeps a read-only test run out of the real home.
    if (!this.ownsStateDir) mkdirSync(this.patchDir, { recursive: true })
    if (!this.deferStartupSweep) this.#startupWorkSync()
    rmSync(join(this.stateDir, 'slots'), { recursive: true, force: true })
    if (this.deferStartupSweep) {
      // Nothing is loaded yet: `listPatches` documents that it answers with what is loaded
      // so far, while a full id still resolves from disk through `readPatch`/`apply`.
    } else {
      // Patches already on disk are made available to `apply` and `listPatches` up front,
      // so one this sweep just salvaged behaves exactly like one this process collected.
      this.#loadPatches()
      this.startupSweepDone = true
      this.startupSweepPromise = Promise.resolve()
    }
    for (const slot of this.slots) {
      mkdirSync(slot.dir, { recursive: true })
      slot.tmpDir = join(slot.dir, SLOT_TMP)
    }
    // Unref'd: housekeeping must never be the reason a finished process stays alive.
    this.sweepTimer =
      sweepIntervalMs > 0 ? setInterval(() => this.#housekeeping(), sweepIntervalMs).unref() : undefined
  }

  /**
   * The identity of one settings file as it was last read.
   *
   * `mtimeMs` alone misses a replacement that restores the old timestamp: a `mv` of a
   * prepared file over the settings, with `utimes` putting the original time back, leaves
   * a different inode and a new `ctime` while the mtime reads unchanged. `size` catches the
   * common edit, `ino` the rename, and `ctimeMs` any metadata change at all; together they
   * answer "is this the same file with the same content" closely enough for one `stat`.
   *
   * @param {string} path - the settings file to stat.
   * @returns {{exists: boolean, size?: number, ino?: number, mtimeMs?: number, ctimeMs?: number}} the file's stamp.
   */
  #settingsStamp(path) {
    try {
      const info = statSync(path)
      return { exists: true, size: info.size, ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
    } catch {
      return { exists: false }
    }
  }

  /**
   * Which settings files changed since this pool last read them.
   *
   * One `stat` per file, never a re-read, so it is cheap enough for every call;
   * `refreshSettings` uses the same comparison to decide which files to read again. A local
   * file that appeared, disappeared or was touched counts as well as the shared one. Any
   * difference in a stamp is a change; only comparing `mtimeMs` called a replaced file
   * unchanged when its timestamp was restored.
   *
   * @returns {string[]} the settings files that appeared, disappeared or were replaced/touched,
   *   in layer order; empty when nothing changed.
   */
  repoSettingsChanged() {
    const changed = []
    for (const [file, path] of this.settingsPaths) {
      if (!sameSettingsStamp(this.#settingsStamp(path), this.settingsFiles.get(file).stamp)) changed.push(file)
    }
    return changed
  }

  /**
   * Re-read the settings files that changed since they were last read, and give a leased
   * slot the settings its call will use.
   *
   * Called by `lease` for every writing call, before anything is copied. A file whose stamp
   * is unchanged is not read at all; one that was only touched is read but not re-applied,
   * because its content key is the same. A file whose new content cannot be used keeps the
   * settings it last parsed to — dropping them would quietly change every later copy because
   * of a half-saved edit — and every call carries a warning until it is fixed.
   *
   * The slot keeps a reference to the settings object, not to the pool: a later reload
   * replaces `this.settings` and leaves a call that is already running exactly as it began.
   *
   * @param {Slot} [slot] - the slot a call has just leased; omitted, only the pool is updated.
   * @returns {{reloaded: string[], warnings: string[]}} the files whose new settings now
   *   apply, and the warnings this call must carry.
   */
  refreshSettings(slot) {
    const reloaded = []
    for (const [file, path] of this.settingsPaths) {
      const entry = this.settingsFiles.get(file)
      const stamp = this.#settingsStamp(path)
      if (sameSettingsStamp(stamp, entry.stamp)) continue
      entry.stamp = stamp
      const parsed = readSettingsFile(path, file, this.log)
      const contentKey = settingsContentKey(parsed)
      if (contentKey === entry.contentKey) continue
      entry.contentKey = contentKey
      if (parsed.problem !== undefined) {
        entry.problem = parsed.problem
        this.log(
          `${file}: ${parsed.problem}; ${entry.hadGood ? 'keeping the settings last read from it' : 'none of its settings apply'} until it is fixed`,
        )
        continue
      }
      entry.problem = undefined
      entry.parsed = parsed
      // A file deleted since the last read has nothing to keep for a later broken edit.
      entry.hadGood = parsed.present === true
      reloaded.push(file)
    }
    if (reloaded.length > 0) {
      const layered = this.#layerSettingsFiles()
      this.log(`settings reloaded: ${reloaded.join(', ')}`)
      this.log(`settings: ${layered.layers.length > 0 ? layered.layers.join(', ') : 'none'}`)
      if (reloaded.includes(LOCAL_SETTINGS_FILE)) {
        warnLocalSettingsTracking(this.root, this.settingsPaths.get(LOCAL_SETTINGS_FILE), this.log)
      }
      const before = this.settings
      this.settings = this.#buildSettings(layered)
      if (this.settings.slotSetupWarning !== undefined && before.slotSetupWarning === undefined) this.log(SETUP_NOT_ALLOWED_WARNING)
    }
    const warnings = []
    for (const [file, entry] of this.settingsFiles) {
      if (entry.problem !== undefined) warnings.push(settingsInvalidWarning(file, entry.problem, { kept: entry.hadGood }))
    }
    if (slot !== undefined) {
      slot.settings = this.settings
      slot.settingsWarnings = warnings
    }
    return { reloaded, warnings }
  }

  /**
   * Layer what each settings file last parsed to, for this pool's platform.
   * @returns {ReturnType<typeof layerRepoSettings>} the accepted layers, in order.
   */
  #layerSettingsFiles() {
    return layerRepoSettings(
      [...this.settingsFiles].map(([file, entry]) => ({ file, parsed: entry.parsed })),
      this.platform,
    )
  }

  /**
   * Turn the layered files and the pool options into the settings one call uses.
   *
   * The pool options are applied last on every build, exactly as at start, so a reload can
   * never lose a `--copy-exclude` or a `slotEnv` option. The kept-path check asks the
   * caller's git again, because a reload may name a path the last one did not.
   *
   * @param {ReturnType<typeof layerRepoSettings>} layered - the files' layers.
   * @returns {{layers: string[], slotEnv: object, slotSetup: object[], slotSetupWarning?: string,
   *   copyExclude: string[], namedExclude: string[]}} the settings, never mutated afterwards.
   */
  #buildSettings(layered) {
    /**
     * Accepted `slotEnv` entries, resolved per slot by `slotEnvFor`. A `port` entry creates
     * no directory and a `value` entry is plain text, so neither makes the copy name
     * `.flash-home` or `.flash-cache`.
     */
    const slotEnv = mergeSlotEnv(layered.slotEnvLayers, this.optionSlotEnv, this.log, this.slotHighest, { platform: this.platform })
    // The setup steps that passed validation, in configuration order. A kept path that the
    // caller's own git does not ignore — or that it tracks — is refused here, so the step
    // still runs but cannot move tracked source out of the copy.
    const slotSetup = (layered.slotSetup ?? []).map((step) => ({
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
    // A kept path is left out of the copy as well: there is no point copying the caller's
    // `node_modules` only to replace it with the slot's own.
    const keptPaths = slotSetup.flatMap((step) => step.keep)
    return Object.freeze({
      layers: layered.layers,
      slotEnv,
      slotSetup,
      // The warning every flash_task and flash_batch result carries when steps are
      // configured but not allowed.
      slotSetupWarning: slotSetup.length > 0 && !this.slotSetupAllowed ? SETUP_NOT_ALLOWED_WARNING : undefined,
      copyExclude: normalizeExclude([
        ...(layered.copyExcludeDefaults === false ? [] : DEFAULT_COPY_EXCLUDE),
        ...(layered.copyExclude ?? []),
        ...this.optionCopyExclude,
        ...keptPaths,
      ]),
      // A default that git keeps (a tracked `.env.example`) is the expected case, not news
      // worth a log line on every call; only the entries someone asked for are reported.
      namedExclude: normalizeExclude([...(layered.copyExclude ?? []), ...this.optionCopyExclude, ...keptPaths]),
    })
  }

  /**
   * The settings one slot's call uses: the ones it leased with, or the pool's current ones
   * for a slot that was never leased through `lease`.
   * @param {Slot} slot - the slot.
   * @returns {object} the settings object (see `#buildSettings`).
   */
  #settingsOf(slot) {
    return slot?.settings ?? this.settings
  }

  /**
   * Accepted `slotEnv` entries of the settings a call leased now would use.
   * @type {Record<string, {kind: string, segment?: string, base?: number, stride?: number, value?: string}>}
   */
  get slotEnv() {
    return this.settings.slotEnv
  }

  /**
   * The validated setup steps of the current settings, in configuration order.
   * @type {{run: string[], inputs: string[], keep: string[], timeoutSeconds: number}[]}
   */
  get slotSetup() {
    return this.settings.slotSetup
  }

  /** The warning a result carries when setup steps are configured but not allowed. @type {string | undefined} */
  get slotSetupWarning() {
    return this.settings.slotSetupWarning
  }

  /** What the copy leaves out under the current settings. @type {string[]} */
  get copyExclude() {
    return this.settings.copyExclude
  }

  /** The exclusions someone asked for, the ones a "not leaving out" line may name. @type {string[]} */
  get namedExclude() {
    return this.settings.namedExclude
  }

  /**
   * The cache store policy the sweeps and the store trim use, or undefined without a store.
   *
   * The store keeps at most as many caches as this root has slot numbers: a cache beyond that
   * can never be claimed by a server of this root at the same time as the others, so it is
   * disk with no reader. Slot numbers are shared by the servers of one root, so the bound is
   * one past the highest number this pool holds, not its own slot count alone. The age limit
   * is the patch retention window, which is the existing answer to "how long is idle state
   * worth keeping".
   *
   * @returns {{storeDir: string, max: number, retentionDays: number, rename: Function} | undefined} the policy.
   */
  #cachePolicy() {
    if (this.cacheStore === undefined) return undefined
    return { storeDir: this.cacheStore, max: this.slotHighest, retentionDays: this.patchRetentionDays, rename: this.renameDirectory }
  }

  /**
   * Trim the cache store to the slot count and the retention window.
   * @returns {void}
   */
  #trimCacheStore() {
    const policy = this.#cachePolicy()
    if (policy === undefined) return
    trimCacheStore(policy.storeDir, { max: policy.max, retentionDays: policy.retentionDays, log: this.log })
  }

  /**
   * Hand a retired tree's `.flash-cache` to the store, when `trim` is about to remove the tree
   * and no slot could take it. Only a tree whose runtimes were shut down is touched, for the
   * reason `#keepRetiredCache` gives.
   *
   * @param {Slot} slot - the slot the retired tree belonged to.
   * @param {string} retired - the retired tree about to be removed.
   * @returns {void}
   */
  #storeRetiredCache(slot, retired) {
    const policy = this.#cachePolicy()
    if (policy === undefined || !slot.stoppedOrphans.has(retired)) return
    putCacheInStore(join(retired, SLOT_CACHE), policy.storeDir, { rename: policy.rename, log: this.log })
    this.#trimCacheStore()
  }

  /**
   * Take a stored cache into a slot that has none, before the copy is made.
   *
   * @param {Slot} slot - the slot being prepared.
   * @returns {boolean} whether a stored cache was claimed.
   */
  #claimStoredCache(slot) {
    if (this.cacheStore === undefined || holdsAnyFile(join(slot.dir, SLOT_CACHE))) return false
    return claimStoredCache(this.cacheStore, join(slot.dir, SLOT_CACHE), { rename: this.renameDirectory, log: this.log }) !== undefined
  }

  /**
   * The warning a call carries when the state volume is nearly full, or undefined.
   *
   * One `statfs`, which is cheap, so it runs at every lease; it never blocks the call. A
   * failing `statfs` is logged and the call proceeds without a warning.
   *
   * @returns {string | undefined} the warning.
   */
  #lowDiskWarning() {
    let space
    try {
      space = volumeSpace(this.stateDir, this.statfs)
    } catch (error) {
      this.log(`could not read the free space of the state volume: ${messageOf(error)}`)
      return undefined
    }
    if (!(space.totalBytes > 0)) return undefined
    if (space.freeBytes >= space.totalBytes * LOW_DISK_FREE_FRACTION && space.freeBytes >= LOW_DISK_FREE_BYTES) return undefined
    const where = this.ownsStateDir ? this.baseDir : this.stateDir
    return (
      `only ${formatBytes(space.freeBytes)} of ${formatBytes(space.totalBytes)} is free on the volume holding the state ` +
      `directory ${where}, where the worker copies and stored build caches live; a build can fill the rest. ` +
      'Run `flash-agents clean` to remove dead servers\' copies and stored caches, and `flash-agents doctor` ' +
      '(the state-disk row) to see what each slot and the cache store take'
    )
  }

  /**
   * The heavy part of construction, unchanged: migrate the legacy store, salvage and
   * remove dead owners, drop empty foreign digests, prune expired patches.
   *
   * Kept synchronous and separate from `startupSweep` so the default construction still
   * returns with the swept state in hand — `doctor`, `clean` and every test that plants a
   * dead owner depend on that — while the deferred path can run the same steps in the
   * same order with yields between them.
   *
   * @returns {void}
   */
  #startupWorkSync() {
    if (this.ownsStateDir) {
      this.#migrateLegacyStore()
      sweepDeadOwners(this.root, {
        patchDir: this.patchDir,
        baseDir: this.baseDir,
        log: this.log,
        caches: this.#cachePolicy(),
        owner: { pid: process.pid, instance: this.instance, command: this.commandLine },
        commandLineOf: this.commandLineOf,
        linkLock: this.linkLock,
      })
      this.#trimCacheStore()
      removeEmptyForeignDigests(this.root, {
        baseDir: this.baseDir,
        retentionDays: this.patchRetentionDays,
        log: this.log,
        commandLineOf: this.commandLineOf,
      })
    }
    prunePatches(this.patchDir, { retentionDays: this.patchRetentionDays })
    // A server of this root started with isolation off keeps its reports under the state
    // base; they are call state too and age out on the patch window.
    pruneReports(join(this.baseDir, rootDigest(this.root), 'reports'), { retentionDays: this.patchRetentionDays })
  }

  /**
   * Move the legacy temp patch store into the durable one, or watch it in place.
   *
   * A patch written by an older version lives in the temp tree. Normally it is moved
   * before the sweep and the load, so the upgrade keeps exactly the work the caller was
   * told it could still apply. But an old server may be running on this root right now,
   * with its in-memory paths already pointing into that directory: moving the files out
   * from under it would make its `flash_apply` fail. Deferring is safe because this pool
   * lists and applies those records in place until the migration can run (see
   * `#sweepDeadOwners`), and an incomplete id is never moved (see `migrateLegacyPatches`).
   *
   * @returns {void}
   */
  #migrateLegacyStore() {
    const digestDir = join(this.baseDir, rootDigest(this.root))
    const legacyDir = join(digestDir, 'patches')
    // A live slot lock is a running server of this root just as a live pid directory is:
    // this process's own lock does not count against itself.
    const otherPids = livePidsIn(digestDir).filter((pid) => pid !== process.pid)
    const lockedSlot = slotTreesIn(digestDir, { commandLineOf: this.commandLineOf }).some(
      (tree) => tree.live && tree.pid !== process.pid,
    )
    if (otherPids.length > 0) {
      this.legacyPatchDir = legacyDir
      this.log(
        `deferred moving stored patches from ${legacyDir} to ${this.patchDir}: ` +
          `process(es) ${otherPids.join(', ')} still use the old store`,
      )
    } else if (lockedSlot) {
      this.legacyPatchDir = legacyDir
      this.log(
        `deferred moving stored patches from ${legacyDir} to ${this.patchDir}: a live server still holds a slot lock under this root`,
      )
    } else {
      migrateLegacyPatches(legacyDir, this.patchDir, { log: this.log })
    }
  }

  /**
   * Run the start-up work the constructor skipped, once, without ever blocking on it.
   *
   * The client is already connected when this runs: the sweep yields to the event loop
   * between dead owners and between slots, so requests are answered while it salvages.
   * It never rejects — a sweep that fails must not take the server with it, and the
   * housekeeping timer and `prepare` retry later. A second call returns the same promise,
   * so the `notifications/initialized` trigger and the 5 s fallback cannot race.
   *
   * Until it has finished, `lease` waits for it, `#housekeeping` and `prepare`'s sweep do
   * nothing, and `listPatches` only holds what was loaded so far.
   *
   * @returns {Promise<void>} resolves when the pass finished, was stopped by `close()`, or
   *   was already done.
   */
  startupSweep() {
    if (this.startupSweepPromise === undefined) this.startupSweepPromise = this.#runStartupSweep()
    return this.startupSweepPromise
  }

  /**
   * Whether the deferred start-up sweep has not finished yet.
   *
   * Read-only, so a service can tell a waiting call what it is waiting for ("the start-up
   * sweep is still reclaiming disk") instead of guessing from a silent `lease`. It is false
   * for a pool whose constructor already did the work, and becomes false the moment the
   * pass finishes, however it finished.
   *
   * @returns {boolean} true while the deferred sweep is still running or not yet started.
   */
  get startupSweepPending() {
    return !this.startupSweepDone
  }

  /**
   * The body of `startupSweep`: the skipped constructor work with yield points.
   *
   * @returns {Promise<void>} resolves when the pass ended, whatever happened in it.
   */
  async #runStartupSweep() {
    if (this.closed) {
      this.startupSweepDone = true
      this.log('startup sweep skipped: the pool was closed before it started')
      return
    }
    const started = Date.now()
    const stats = { salvaged: 0, kept: 0, removed: 0, patches: 0 }
    try {
      if (this.ownsStateDir) {
        this.#migrateLegacyStore()
        const swept = await sweepDeadOwnersLater(this.root, {
          patchDir: this.patchDir,
          baseDir: this.baseDir,
          log: this.log,
          stopped: () => this.closed,
          caches: this.#cachePolicy(),
          owner: { pid: process.pid, instance: this.instance, command: this.commandLine },
          commandLineOf: this.commandLineOf,
          linkLock: this.linkLock,
        })
        Object.assign(stats, { salvaged: swept.salvaged, kept: swept.kept, removed: swept.removed, patches: swept.patches })
        if (swept.stopped) return
        this.#trimCacheStore()
        removeEmptyForeignDigests(this.root, {
          baseDir: this.baseDir,
          retentionDays: this.patchRetentionDays,
          log: this.log,
          commandLineOf: this.commandLineOf,
        })
      }
      // Between every remaining step: a `close()` that ran during the sweep must not leave
      // pruning or a reload happening after it returned.
      if (this.closed) return
      prunePatches(this.patchDir, { retentionDays: this.patchRetentionDays })
      if (this.closed) return
      pruneReports(join(this.baseDir, rootDigest(this.root), 'reports'), { retentionDays: this.patchRetentionDays })
      this.#loadPatches()
    } catch (error) {
      // Never reject: the pool is already serving, and the timer or the next `prepare`
      // retries whatever this pass could not finish.
      this.log(`startup sweep failed: ${messageOf(error)}`)
    } finally {
      this.startupSweepDone = true
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      this.log(
        `startup sweep finished in ${seconds}s: ${String(stats.salvaged)} dead owner(s) salvaged, ` +
          `${String(stats.kept)} kept, ${String(stats.removed)} removed, ` +
          `${String(stats.patches)} patch(es) salvaged`,
      )
    }
  }

  /**
   * The timer's pass: sweep dead owners, then trim, never throwing into the event loop.
   *
   * Silent until the deferred start-up sweep has finished: the pass it would run is
   * already about to run, and a trim would measure a layout the sweep is still changing.
   */
  #housekeeping() {
    if (!this.startupSweepDone) return
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
   * Silent while a deferred start-up sweep is still running: that pass is the same work,
   * and running it again here would sweep the layout a second time concurrently.
   *
   * @returns {void}
   */
  #sweepDeadOwners() {
    if (!this.ownsStateDir) return
    if (!this.startupSweepDone) return
    const migrated = this.#retryLegacyMigration()
    const swept = sweepDeadOwners(this.root, {
      patchDir: this.patchDir,
      baseDir: this.baseDir,
      log: this.log,
      caches: this.#cachePolicy(),
      owner: { pid: process.pid, instance: this.instance, command: this.commandLine },
      commandLineOf: this.commandLineOf,
      linkLock: this.linkLock,
    })
    // While a live old server keeps writing into the legacy store, the in-memory view is
    // refreshed from it too: the old server may have committed a patch since construction,
    // and the caller of this server must be able to list it. The reload is two small
    // directory listings, and only while the old store is being watched.
    const watchingLegacy = this.legacyPatchDir !== undefined
    // Reload when a patch was salvaged, not only when an owner was removed: an owner kept
    // because one of its slots could not be read can still have had another slot salvaged,
    // and that patch would otherwise be missing from `listPatches` until a restart.
    if (migrated || swept.patches > 0 || watchingLegacy) this.#loadPatches()
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
    const others = livePidsIn(join(this.baseDir, rootDigest(this.root))).filter((pid) => pid !== process.pid)
    if (
      others.length > 0 ||
      slotTreesIn(join(this.baseDir, rootDigest(this.root)), { commandLineOf: this.commandLineOf }).some(
        (tree) => tree.live && tree.pid !== process.pid,
      )
    ) {
      return false
    }
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
   * `trash-*` directories are neither measured nor counted. A trash tree is disk a
   * background removal is already freeing, and measuring it here was a synchronous
   * recursive walk — the event-loop freeze this change exists to remove — whose bytes then
   * made `trim` delete applied patches and retired trees to pay for space that was already
   * on its way back. `clean`'s report may still count them (see `digestStats`), because it
   * is a synchronous command with no server to keep answering.
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
      // The warm build cache is the one part of a retired tree worth more than its bytes: a
      // user lost 35.6 GB of cargo target and seeded cargo home here, and the next call
      // compiled from cold for 65 minutes. It still leaves the measured state, because the
      // slot's own directory is not part of what the cap counts.
      if (!this.#keepRetiredCache(tree.slot, tree.dir)) this.#storeRetiredCache(tree.slot, tree.dir)
      rmSync(tree.dir, { recursive: true, force: true })
      // The retired tree carried a lock and possibly a live-runtime mark of this pool's own
      // (see `retire`); neither may outlive the tree and describe a later one.
      if (this.stableSlots) {
        removeSlotLock(tree.dir, this.log)
        rmSync(liveOrphanMarker(tree.dir), { force: true })
      }
      tree.slot.orphans.splice(tree.slot.orphans.indexOf(tree.dir), 1)
      tree.slot.stoppedOrphans.delete(tree.dir)
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
          'what is left is unapplied patches and retired trees whose work is already collected, which are kept',
      )
    }
    result.bytes = total
    return result
  }

  /**
   * Move a retired tree's build cache into its slot's current directory, if that one has
   * none, before the retired tree is removed.
   *
   * `prepare` normally got there first (see `#adoptRetiredCache`); this is the second chance
   * for a cache it could not take, such as one whose rename failed while a stray process
   * still held it open. The same rule applies: only a tree whose runtimes were shut down
   * before `retire` (`stoppedOrphans`) gives up its cache, because only then can no session
   * still be writing into it. The slot that replaced the tree is the other question: while a
   * call holds it, its worker may be filling a cache of its own, and a rename under a running
   * build would swap its files out from under it. A busy slot, or one whose cache already
   * holds something, is therefore left alone and the retired cache goes with the tree, as
   * before. A rename that fails here removes the cache with the tree, which is what `trim` is
   * for.
   *
   * @param {Slot} slot - the slot the retired tree belonged to.
   * @param {string} retired - the retired tree about to be removed.
   * @returns {boolean} whether the cache was moved.
   */
  #keepRetiredCache(slot, retired) {
    const source = join(retired, SLOT_CACHE)
    if (!holdsAnyFile(source)) return false
    if (!slot.stoppedOrphans.has(retired)) {
      this.log(`trim: not moving the build cache of retired tree ${retired}: its runtimes were not shut down when it was retired`)
      return false
    }
    if (slot.busy) {
      this.log(`trim: not moving the build cache of retired tree ${retired}: slot ${String(slot.id)} is in use by a running call`)
      return false
    }
    if (holdsAnyFile(join(slot.dir, SLOT_CACHE))) {
      this.log(`trim: not moving the build cache of retired tree ${retired}: ${slot.dir} already has a build cache of its own`)
      return false
    }
    return this.#moveRetiredCache(slot, retired, { prefix: 'trim: ', fallback: 'removing it with the tree' })
  }

  /**
   * Take the newest retired tree's build cache into a slot that is being prepared cold.
   *
   * The call after a timeout is usually the retry, leased into the replacement slot within
   * seconds: a user's retry ran there for 65 minutes compiling from cold while the retired
   * tree beside it held 35.6 GB of warm cargo target. Waiting for `trim` cannot help that
   * call, because its own slot is busy the whole time. `prepare` runs before the copy and
   * before the worker, so nothing in the new directory is using the cache yet.
   *
   * Only a tree in `stoppedOrphans` is taken from: the service puts it there when every
   * runtime rooted at the tree was shut down before `retire` (see `#salvageOrphaned` in
   * service.js), which is what stops the session that wrote the cache. A tree retired
   * without that may still have a build writing into it and is left alone. One attempt per
   * call: a rename that fails (Windows refuses one while a stray build process still has a
   * file open) logs and leaves the cache where it is, for `trim` to deal with as before.
   *
   * @param {Slot} slot - the slot being prepared.
   * @returns {boolean} whether a cache was moved.
   */
  #adoptRetiredCache(slot) {
    if (slot.orphans.length === 0 || holdsAnyFile(join(slot.dir, SLOT_CACHE))) return false
    const retired = [...slot.orphans]
      .reverse()
      .find((dir) => slot.stoppedOrphans.has(dir) && holdsAnyFile(join(dir, SLOT_CACHE)))
    if (retired === undefined) return false
    return this.#moveRetiredCache(slot, retired, { prefix: '', fallback: 'it stays there until the tree is removed' })
  }

  /**
   * Rename one retired tree's `.flash-cache` into the slot's current directory.
   *
   * The caller has checked that the move is safe and wanted. A rename is the only way that
   * is cheap: copying gigabytes would freeze the server, so a rename that fails (EXDEV
   * across devices, EPERM or EBUSY with an open handle on Windows) is logged and the caller's
   * fallback stands.
   *
   * The setup stamps are not moved with the rest. A stamp only fingerprints the step's argv,
   * platform, scope and inputs, so it would still match in the new directory — but what a
   * step keeps routinely holds the absolute path it was built at (a virtualenv's `bin/`
   * scripts and `pyvenv.cfg`, a `node_modules/.bin` shim, a `.pth` file), which names the
   * retired tree that is about to vanish. Dropping the stamps makes each step run once in
   * the new directory, on top of the kept files, which is what repairs those paths. The
   * `cache:` folders need no such repair, because `slotEnvFor` resolves them from the slot's
   * current directory on every call.
   *
   * @param {Slot} slot - the slot the retired tree belonged to.
   * @param {string} retired - the retired tree.
   * @param {{prefix: string, fallback: string}} wording - the log prefix, and what happens
   *   to the cache when the rename fails.
   * @returns {boolean} whether the cache was moved.
   */
  #moveRetiredCache(slot, retired, { prefix, fallback }) {
    const source = join(retired, SLOT_CACHE)
    const target = join(slot.dir, SLOT_CACHE)
    // No size in the log line: measuring walks every file, and a warm cache of tens of
    // gigabytes would hold the server up for seconds inside `prepare`.
    try {
      mkdirSync(slot.dir, { recursive: true })
      // Only empty folders can be here (the caller checked), and a rename onto a directory
      // that has entries fails with ENOTEMPTY.
      rmSync(target, { recursive: true, force: true })
      renameSync(source, target)
    } catch (error) {
      this.log(`${prefix}could not move the build cache of retired tree ${retired} to ${slot.dir} (${messageOf(error)}); ${fallback}`)
      return false
    }
    rmSync(join(target, SETUP_STAMP_DIR), { recursive: true, force: true })
    this.log(`${prefix}moved the build cache of retired tree ${retired} to ${slot.dir}`)
    return true
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
   * is written next to that record and never split across the two stores. Every field the
   * file carries is kept — `task` and `finalMessage` included — so a reloaded record
   * answers the same questions a freshly collected one does.
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
   * A pool constructed with `deferStartupSweep` has loaded nothing until `startupSweep()`
   * has finished, so this returns only what has been loaded so far — before the sweep,
   * an empty list even when patches exist on disk. Addressing one by its full id still
   * works throughout: `readPatch` and `apply` fall back to the store on disk (see
   * `#lookupFullPatch`), which is what lets a salvaged patch be applied before the sweep's
   * own load reached it.
   *
   * @returns {object[]} the loaded patch records, most recently created first.
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
   * A deferred start-up sweep is awaited first: no call may copy into a tree while the
   * sweep may still be reclaiming disk, and the first call's `prepare` must not start a
   * second sweep beside the one already running. That wait is itself bounded by the same
   * signal and deadline as the wait for a tree (see `#awaitStartupSweep`): the very first
   * call after a crash must not be wedged behind a sweep nobody can cancel, and giving up
   * on the wait does not stop the sweep.
   *
   * @param {object} [options] - how long the caller may wait.
   * @param {AbortSignal} [options.signal] - client cancellation.
   * @param {number} [options.deadline] - epoch milliseconds this call must be done by.
   * @returns {Promise<Slot>} the slot this call owns until it is released.
   * @throws {IsolationError} with code `CANCELLED` or `TIMEOUT`.
   */
  async lease({ signal, deadline } = {}) {
    if (signal?.aborted === true) throw new IsolationError('the call was cancelled before a tree could be leased', 'CANCELLED')
    await this.#awaitStartupSweep({ signal, deadline })
    const budget = deadline === undefined ? undefined : Math.max(0, deadline - Date.now())
    if (signal?.aborted === true) throw new IsolationError('the call was cancelled before a tree could be leased', 'CANCELLED')
    if (budget === 0) throw new IsolationError('the call had no time left before a tree could be leased', 'TIMEOUT')
    const free = this.slots.find((slot) => !slot.busy)
    if (free !== undefined) {
      free.busy = true
      this.#leaseSettings(free)
      return free
    }
    const handed = await new Promise((resolveLease, rejectLease) => {
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
    // A slot handed over by `release` is leased here as much as a free one is: the waiting
    // call reads the settings as they are now, not as they were when it started to wait.
    this.#leaseSettings(handed)
    return handed
  }

  /**
   * Give a freshly leased slot the settings its call will use, re-reading changed files.
   *
   * Every writing call leases exactly once, before anything is copied, so this is where an
   * edited settings file reaches the next call without a reconnect. A failure here must not
   * strand a slot that is already marked busy, so it is logged and the call keeps the
   * settings that were already in force.
   *
   * @param {Slot} slot - the slot just leased.
   * @returns {void}
   */
  #leaseSettings(slot) {
    try {
      this.refreshSettings(slot)
    } catch (error) {
      this.log(`could not re-read the settings files: ${messageOf(error)}; this call uses the settings already in force`)
      slot.settings = this.settings
      slot.settingsWarnings = []
    }
    const lowDisk = this.#lowDiskWarning()
    if (lowDisk !== undefined) slot.settingsWarnings = [...(slot.settingsWarnings ?? []), lowDisk]
  }

  /**
   * Wait for the deferred start-up sweep while the call still has time and its client
   * still wants the answer.
   *
   * `lease` used to await `startupSweep()` before its own deadline and abort handling
   * existed, so the first call after a crash waited for the whole sweep — unbounded by the
   * call's budget, and impossible to cancel: neither `TIMEOUT` nor `CANCELLED` could end
   * the wait. The sweep is not stopped when a caller gives up; it is reclaiming disk for
   * every later call, and other calls await the same promise.
   *
   * @param {object} options - the caller's budget.
   * @param {AbortSignal} [options.signal] - client cancellation.
   * @param {number} [options.deadline] - epoch milliseconds this call must be done by.
   * @returns {Promise<void>} resolves when the sweep finished, or at once when it already had.
   * @throws {IsolationError} with code `CANCELLED` or `TIMEOUT`.
   */
  async #awaitStartupSweep({ signal, deadline } = {}) {
    const sweep = this.startupSweep()
    if (!this.startupSweepPending) return
    const budget = deadline === undefined ? undefined : Math.max(0, deadline - Date.now())
    if (signal?.aborted === true) {
      throw new IsolationError('the call was cancelled while waiting for the start-up sweep', 'CANCELLED')
    }
    if (budget === 0) {
      throw new IsolationError('the call had no time left while the start-up sweep was still running', 'TIMEOUT')
    }
    await new Promise((resolveWait, rejectWait) => {
      let settled = false
      const finish = (settle, value) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        settle(value)
      }
      const onAbort = () => {
        finish(rejectWait, new IsolationError('the call was cancelled while waiting for the start-up sweep', 'CANCELLED'))
      }
      const timer =
        budget === undefined
          ? undefined
          : setTimeout(() => {
              finish(
                rejectWait,
                new IsolationError(`the start-up sweep was still running after the call's ${String(budget)}ms budget`, 'TIMEOUT'),
              )
            }, budget)
      if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
      // The sweep itself never rejects; both outcomes mean the wait is over.
      sweep.then(
        () => finish(resolveWait),
        () => finish(resolveWait),
      )
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
   * @param {object} [options.task] - the task this copy is working on, kept on the stored
   *   patch: `{kind: 'flash_task' | 'flash_batch', label: string, sessionId?: string,
   *   jobId?: string, taskFile?: string}`. Bounded here and written into the copy's git
   *   directory, so a patch salvaged after a crash can still name it.
   * @returns {{base: string | null, mechanism: 'clone' | 'copy', scope: string,
   *   excluded: string[], uncommitted: {count: number, files: string[]}, reason?: string}} the base.
   */
  prepare(slot, { cwd, source = 'working-tree', fs, task } = {}) {
    // The task belongs to the call, not to the slot: the next call in this tree must not
    // inherit the last one's identity.
    slot.task = normalizeTask(task)
    // The settings this call leased with; a reload by a later call does not reach them.
    const settings = this.#settingsOf(slot)
    // A server that died while this one ran leaves its trees behind; the next call is the
    // cheapest moment to notice, since it is about to need disk anyway.
    this.#sweepDeadOwners()
    // A kept path still sits inside the previous copy. It belongs to the slot cache, not to
    // this call's starting state, so it is moved back before the copy is emptied — that is
    // what makes the next call find it, and what keeps the worker's changes to it across
    // calls.
    this.#stashKeepPaths(slot)
    // Measured after the stash (a kept path counts as cache) and before `#createSlotEnv`
    // makes the empty `cache:` folders: a fresh or replaced slot can make a build that took
    // minutes take an hour, and a slow job should say why.
    // A slot replaced after a timeout takes the retired tree's warm cache first, so the
    // retry that usually follows does not build from cold. `retire` may already have carried
    // it into the stable path on POSIX (see the class's `retire`), which is the same
    // hand-over one step earlier: the call still says where the cache came from.
    slot.buildCacheFrom = undefined
    if (this.#adoptRetiredCache(slot)) slot.buildCacheFrom = 'retired-slot'
    else if (slot.cacheFromRetired === true && holdsAnyFile(join(slot.dir, SLOT_CACHE))) slot.buildCacheFrom = 'retired-slot'
    // A slot that is still cold after that claims a cache an earlier server left in the store.
    else if (this.#claimStoredCache(slot)) slot.buildCacheFrom = 'store'
    slot.cacheFromRetired = false
    slot.buildCacheEmpty = this.#buildCacheEmpty(slot, settings)
    if (slot.buildCacheEmpty) {
      this.log(
        `slot ${String(slot.id)} starts with an empty build cache in ${join(slot.dir, SLOT_CACHE)}: ` +
          'this call builds from cold',
      )
    }
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
        platform: this.platform,
        exclude: settings.copyExclude,
        // The safety of leaving a matched path out needs git, so the decision stays here
        // rather than in the walk. It runs once per matched path, not once per file.
        consider: (relPath) => this.#excludeDecision(original, relPath),
        // One line per server, not one per file and never on stderr: a filesystem without
        // reflink support is a property of the machine, not of this call.
        onCloneFallback: (platform, code) => {
          if (this.copyFallbackLogged) return
          this.copyFallbackLogged = true
          this.log(
            'the copy-on-write clone flag COPYFILE_FICLONE_FORCE is not supported on this filesystem ' +
              `(${code} on ${platform}); the copy of ${original} is a plain copy`,
          )
        },
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
    const { mechanism, skipped, vanished, excluded, kept, linksRepointed, repointed, linksSkipped, repositories } = copied
    // What the copy itself left out, and the rules it was left out by. The ignored-path
    // notice asks both when `collect` runs: build output the copy never carried is not a
    // path the worker created, even when a build then makes it inside the copy.
    slot.copyExcluded = excluded.map((path) => path.split(sep).join('/'))
    // The full exclude list, defaults included: the ignored-path notice filters by it, and a
    // default such as `.env` is a rule the copy applied even when the path did not exist yet
    // and so never appears in `excluded`.
    slot.copyExcludeNames = settings.copyExclude
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
      if (!matchesExclude(entry.path.split(sep).join('/'), name, settings.namedExclude)) continue
      this.log(`not leaving out ${entry.path}: ${entry.reason ?? 'it is not ignored'}`)
    }
    if (excluded.length > 0) {
      this.log(`left ${String(excluded.length)} excluded path(s) out of the copy: ${excluded.join(', ')}`)
    }
    this.clones += 1
    slot.scope = scope
    slot.repoDir = repoDir
    // Which of them the diff stages file by file is decided when the base is recorded.
    slot.repositories = repositories ?? []
    slot.nested = []
    slot.base = null
    slot.baseParent = null
    slot.baseReason = undefined
    slot.uncommitted = { count: 0, files: [] }
    slot.headLeftOut = undefined
    slot.basePatchId = undefined
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
      this.#writeTaskFile(repoDir, slot.task)
      // Exclusions go in *after* the link is detached: a linked worktree gets a fresh .git
      // here, and an exclusion written before that would not be in it. `.flash-tmp` always
      // exists; `.flash-home` is named only when a `slotEnv` entry creates it, and
      // `.flash-cache` when one does or when a setup step keeps something in the slot, so
      // an ordinary copy's ignore list stays exactly what it was.
      const hasDirEnv = Object.values(settings.slotEnv).some((spec) => spec.kind === 'home' || spec.kind === 'cache')
      const slotNames = [SLOT_TMP]
      if (hasDirEnv) slotNames.push(SLOT_HOME)
      if (hasDirEnv || settings.slotSetup.length > 0) slotNames.push(SLOT_CACHE)
      for (const name of slotNames) {
        excludeFromDiff(slot.dir, name)
        // A worker told to keep scratch next to its cwd writes inside the copied repository
        // when the copy is scoped to one; exclude it there too, so it never reaches a patch.
        if (repoDir !== slot.dir) excludeFromDiff(repoDir, name)
      }
      this.#createSlotEnv(slot)
      if (source === 'head') {
        // What the reset is about to leave out, read first: a patch against the last commit
        // may not apply on top of work the caller has not committed.
        const headChanged = changedInCaller(original, repointed)
        const leftOut = uncommittedIn(repoDir, new Set(repointed.filter((path) => !headChanged.has(path))))
        if (leftOut.count > 0) slot.headLeftOut = leftOut
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
    // Nested repositories are staged as their files, so a worker's edit inside one is part
    // of the diff; the list is recorded with the copy so `collect` and a salvage stage the
    // same ones.
    const { trees, failed } = nestedTrees(repoDir, stagedRepositories(repoDir, slot.repositories ?? []))
    for (const { path, reason } of failed) {
      this.log(`left the nested repository ${path} to the top repository's diff, its files could not be staged: ${reason}`)
    }
    slot.nested = [...trees.keys()]
    if (slot.nested.length > 0) linkNestedObjects(repoDir, slot.nested)
    packNestedObjects(repoDir, [...trees.values()], this.log)
    writeNestedFile(repoDir, slot.nested)
    let tree
    try {
      if (existsSync(realIndex)) copyFileSync(realIndex, indexFile)
      const env = { ...process.env, GIT_INDEX_FILE: indexFile }
      git(['add', '-A', ...excludingPaths(repoDir, slot.nested)], repoDir, env)
      stageNestedRepositories(repoDir, trees, env)
      tree = git(['write-tree'], repoDir, env).trim()
    } finally {
      // The temp index is a copy of the caller's and holds nothing worth keeping; a
      // failure to remove it must not turn a prepared slot into a failed call.
      rmSync(indexFile, { force: true })
    }
    let parent
    try {
      parent = git(['rev-parse', '--verify', '-q', 'HEAD'], repoDir).trim() || undefined
    } catch {
      // A repository without a first commit has no parent to name.
    }
    slot.base = git([...COMMIT_CONFIG, 'commit-tree', tree, ...(parent === undefined ? [] : ['-p', parent]), '-m', 'flash base'], repoDir).trim()
    // The base's parent is the caller's HEAD when the copy was made, and is the commit a
    // later `drift` counts from. The base commit itself lives only in the copy, which is
    // emptied after the call, so the parent has to be recorded while it can still be read.
    slot.baseParent = parent ?? null
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
   * The git-ignored paths the worker created that are worth telling the caller about.
   *
   * Build output is meant to stay behind, so it is not a path the worker created just
   * because a build made it inside the copy. A path is left out of the notice when the copy
   * itself excluded it — by `copyExclude`, by the defaults, or because git ignores the
   * directory and the copy walked around it — or when the same path exists in the caller's
   * tree, where the copy did not carry it from. What remains is a genuinely new ignored path
   * elsewhere, such as a worker writing its result into an ignored `out/`.
   *
   * The base comparison first removes anything the copy started with; this rule then
   * removes what the copy never had for a reason other than the worker's own work. Without
   * it, every Rust job said "created 1 path git ignores: target" for a build directory the
   * caller already had and the copy had deliberately not brought along.
   *
   * @param {object} slot - the slot being collected, carrying what its copy excluded.
   * @param {string} repoDir - the copy's git work tree.
   * @param {string} scope - the nested repository the call was scoped to, or `''`.
   * @returns {string[]} the new ignored paths worth reporting, sorted.
   */
  #createdIgnored(slot, repoDir, scope) {
    const original = scope === '' ? this.root : join(this.root, scope)
    const excluded = new Set(slot.copyExcluded ?? [])
    const rules = slot.copyExcludeNames ?? []
    return ignoredPaths(repoDir).filter((entry) => {
      if ((slot.ignoredBase ?? []).includes(entry)) return false
      if (excluded.has(entry)) return false
      const name = entry.split('/').pop() ?? entry
      if (matchesExclude(entry, name, rules)) return false
      // The caller still has the path: the copy either left it out or never carried the
      // build output's files, so the worker did not create it in the caller's world.
      return !existsSync(join(original, ...entry.split('/')))
    })
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
   * Record the call's task inside the copy, so the patch it produces can be traced to it.
   *
   * The file goes in the copy's own git directory: git never reports anything there, so it
   * cannot become part of the worker's diff, and it is emptied with the tree. A copy that
   * is not a repository has no such directory to write into — creating a bare `.git` would
   * make every later git call treat the tree as a broken repository — so it is skipped. A
   * failed write is logged and the call continues: losing the annotation is not losing work.
   *
   * @param {string} repoDir - the copy's repository.
   * @param {object | undefined} task - the bounded task, when the call named one.
   * @returns {void}
   */
  #writeTaskFile(repoDir, task) {
    if (task === undefined) return
    let info
    try {
      info = statSync(join(repoDir, '.git'))
    } catch {
      // No git directory: nothing to record into.
      return
    }
    if (!info.isDirectory()) return
    const file = taskFileIn(repoDir)
    try {
      writeFileSync(file, `${JSON.stringify(task)}\n`)
    } catch (error) {
      this.log(`could not record the task for this copy in ${file}: ${messageOf(error)}`)
    }
  }

  /**
   * Whether a call starts with nothing in the build cache its settings fill.
   *
   * Only the folders the settings actually put build output in are asked about: each
   * `cache:` entry's folder, and the kept paths of a setup step that is allowed to run. A
   * repository that names none of those has no build cache to be cold, so the answer is
   * false for it rather than a warning about something it never asked for. Stamps under
   * `.flash-cache/setup` are not build output, so a slot holding only those is still cold.
   *
   * @param {Slot} slot - the slot being prepared, after its kept paths were stashed.
   * @param {object} settings - the settings the call leased with.
   * @returns {boolean} true when the settings fill a cache and every folder of it is empty.
   */
  #buildCacheEmpty(slot, settings) {
    const folders = Object.values(settings.slotEnv)
      .filter((spec) => spec.kind === 'cache')
      .map((spec) => join(slot.dir, SLOT_CACHE, spec.segment))
    if (this.slotSetupAllowed && settings.slotSetup.some((step) => step.keep.length > 0)) {
      folders.push(join(slot.dir, SLOT_CACHE, SETUP_KEEP_DIR))
    }
    return folders.length > 0 && !folders.some((folder) => holdsAnyFile(folder))
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
    if (Object.keys(this.#settingsOf(slot).slotEnv).length === 0) return
    for (const spec of Object.values(this.#settingsOf(slot).slotEnv)) {
      // A port entry reserves a number and a value entry is plain text: neither names a
      // directory, so neither may create one.
      if (spec.kind !== 'home' && spec.kind !== 'cache') continue
      mkdirSync(join(slot.dir, spec.kind === 'home' ? SLOT_HOME : SLOT_CACHE, spec.segment), { recursive: true })
    }
  }

  /**
   * The environment one slot's worker boots with, resolved fresh from `slot.dir`.
   *
   * The runtime is rooted at `slot.dir`, so directory paths are stable for the life of the
   * slot; `retire` gives the slot a new directory and the next boot resolves new paths. A
   * `port:` entry resolves from `slot.id` alone, so it is stable across `retire` too, and a
   * `value:` entry is the text the caller gave, unchanged. A fresh object is returned every
   * call, so a runtime cannot mutate the pool's settings.
   *
   * @param {Slot} slot - the slot the worker will run in.
   * @returns {Record<string, string>} ENV_NAME to absolute path, decimal port or plain value;
   *   empty when none is configured.
   */
  slotEnvFor(slot) {
    const env = {}
    for (const [name, spec] of Object.entries(this.#settingsOf(slot).slotEnv)) {
      if (spec.kind === 'value') {
        env[name] = spec.value
        continue
      }
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
    if (this.#settingsOf(slot).slotSetup.length === 0 || slot.repoDir === undefined) return
    for (const [index, step] of this.#settingsOf(slot).slotSetup.entries()) {
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
    if (this.#settingsOf(slot).slotSetup.length === 0 || !this.slotSetupAllowed) return undefined
    if (slot.repoDir === undefined) return undefined
    const results = []
    let ranAny = false
    let restoredAny = false
    for (const [index, step] of this.#settingsOf(slot).slotSetup.entries()) {
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
   * The directory one slot uses at a given generation.
   *
   * Generation 0 is the slot's own directory: the stable per-root `slots/<id>` of the default
   * layout, or `<stateDir>/slots/slot-<id>` with a configured state directory. Every later
   * generation is a retired tree, which must not take the stable path: the next server of
   * this root claims that one and its warm cache. A configured state directory keeps the
   * older `<id>-<generation>` names beside it, exactly as before.
   *
   * @param {number} id - the slot number.
   * @param {number} index - the slot's directory generation.
   * @returns {string} the slot directory for that generation.
   */
  #slotDirectory(id, index) {
    if (!this.stableSlots) return slotDirectory(this.stateDir, id, index)
    if (index === 0) return join(this.slotsBaseDir, String(id))
    return retiredSlotDirectory(this.slotsBaseDir, id, this.instance, index)
  }

  /**
   * Whether a slot's directory is the path the next server of this root claims.
   *
   * Only that path keeps its build cache through `close`: the next server's build looks for
   * the cache exactly there, so leaving it is what makes the first build warm. A slot that
   * retired its directory away sits under a name of its own (`slots/<id>.retired-<instance>`),
   * which nobody will claim; its cache goes into the store instead, and the tree is removed.
   *
   * @param {Slot} slot - the slot to ask about.
   * @returns {boolean} true when the slot's own directory is the stable one.
   */
  #cacheStaysInPlace(slot) {
    return this.stableSlots && slot.dirIndex === 0
  }

  /**
   * Take a tree out of service after its call lost track of the worker. The session that
   * ran there cannot be stopped, so it may still write; recycling the directory would
   * hand its late edits to the next call as that call's own work.
   *
   * A stable slot keeps its stable path. The tree is renamed aside to
   * `slots/<n>.retired-<instance>[-<gen>]` first, which on POSIX moves the inode a process
   * still has open along with it, and the live slot is then given a fresh, empty
   * `slots/<n>`. Its `.flash-cache` is handed over to that fresh directory in the same step
   * when `sessionStopped` says nothing can be writing into it, which is what the next
   * `prepare`'s `#adoptRetiredCache` would otherwise do (see `#adoptRetiredCache` and
   * `#keepRetiredCache`); a cache that cannot move stays with the retired tree for `trim`.
   * The retired tree gets its own lock, created before the tree appears under the name.
   *
   * When the rename fails — Windows refuses one while a handle is open — the older layout
   * is kept: the orphan stays at `slots/<n>` and the slot moves to
   * `slots/<n>.retired-<instance>[-<gen>]`. That step is logged, and the slot stays there
   * for the rest of its life because its stable path is now occupied by the orphan.
   *
   * @param {Slot} slot - the slot whose call timed out.
   * @param {object} [options] - what the caller did before retiring the tree.
   * @param {boolean} [options.sessionStopped] - whether every runtime rooted at the tree was
   *   shut down, so no session can write into its build cache any more.
   */
  retire(slot, { sessionStopped = false } = {}) {
    const orphan = slot.dir
    const owner = { pid: process.pid, instance: this.instance, command: this.commandLine }
    if (this.stableSlots && slot.dirIndex === 0) {
      const generation = slot.orphans.length + 1
      const retired = retiredSlotDirectory(this.slotsBaseDir, slot.id, this.instance, generation)
      if (existsSync(orphan)) {
        // The retired tree is locked *before* it exists under that name. A concurrent
        // `clean` that saw an unlocked directory there would take it for a dead server's and
        // delete it while this pool's runtimes still write into it.
        writeRetiredSlotLock(retired, { ...owner, log: this.log, linkLock: this.linkLock })
        try {
          this.renameDirectory(orphan, retired)
        } catch (error) {
          // POSIX lets a process keep writing into a renamed tree, and every session of this
          // pool follows the inode; Windows refuses the rename while a handle is open. Then
          // the tree keeps the stable path and the slot moves to a retired name of its own,
          // which is the older layout. The failure is named, never silent.
          releaseOwnSlotLock(retired, owner, this.log)
          this.log(`could not move the tree of slot ${String(slot.id)} aside (${messageOf(error)}); keeping the older layout`)
          this.#retireToRetiredName(slot, orphan, retired, sessionStopped)
          return
        }
        try {
          // The slot's own lock at `slots/<n>.lock` is already ours, so the fresh directory
          // exists only after its lock does.
          mkdirSync(slot.dir, { recursive: true })
        } catch (error) {
          this.log(`could not recreate the stable directory ${slot.dir} (${messageOf(error)}); the next call makes it`)
        }
        slot.orphans.push(retired)
        if (sessionStopped === true) {
          slot.stoppedOrphans.add(retired)
          // The 0.1.10 hand-over, one step earlier than `prepare` would do it: the cache is
          // warm only at the stable path, and nothing can be writing into it any more.
          const cache = join(retired, SLOT_CACHE)
          if (holdsAnyFile(cache) && !holdsAnyFile(join(slot.dir, SLOT_CACHE))) {
            try {
              this.renameDirectory(cache, join(slot.dir, SLOT_CACHE))
              slot.cacheFromRetired = true
              this.log(`handed the build cache of ${retired} over to ${slot.dir}`)
            } catch (error) {
              this.log(`could not hand the build cache of ${retired} over to ${slot.dir} (${messageOf(error)}); the next call tries again`)
            }
          }
        } else {
          markLiveOrphan(retired, this.log)
        }
        this.#resetSlotAfterRetire(slot)
        this.log(`retired ${orphan} to ${retired}; the slot keeps its stable path ${slot.dir}`)
        return
      }
      // Nothing sat at the stable path, so there is no orphan to move; the slot keeps it.
      try {
        mkdirSync(slot.dir, { recursive: true })
      } catch (error) {
        this.log(`could not make the stable directory ${slot.dir} (${messageOf(error)}); the next call makes it`)
      }
      this.#resetSlotAfterRetire(slot)
      this.log(`slot ${String(slot.id)} had no tree to retire; it keeps its stable path ${slot.dir}`)
      return
    }
    const nextIndex = slot.dirIndex + 1
    this.#retireToRetiredName(slot, orphan, this.#slotDirectory(slot.id, nextIndex), sessionStopped)
  }

  /**
   * Move a slot to a retired name of its own: the older layout `retire` keeps as a fallback.
   *
   * Used by a configured state directory, whose slots have no locks, and by a stable slot
   * whose tree could not be renamed aside. The fresh directory's lock is created before the
   * directory exists, so a concurrent `clean` cannot take it between the two steps; the
   * orphan keeps its own lock, which the sweep that later salvages it needs to name the dead
   * pid. `slot.dirIndex` records that the slot no longer sits at the stable path.
   *
   * @param {Slot} slot - the slot whose call timed out.
   * @param {string} orphan - the tree left at the slot's old path.
   * @param {string} nextDir - the retired name the live slot moves to.
   * @param {boolean} sessionStopped - whether its runtimes were shut down.
   * @returns {void}
   */
  #retireToRetiredName(slot, orphan, nextDir, sessionStopped) {
    const owner = { pid: process.pid, instance: this.instance, command: this.commandLine }
    if (this.stableSlots) writeRetiredSlotLock(nextDir, { ...owner, log: this.log, linkLock: this.linkLock })
    try {
      mkdirSync(nextDir, { recursive: true })
    } catch (error) {
      // The lock of a directory that was never made would keep the number from a later
      // retire of this slot, so it goes again.
      if (this.stableSlots) releaseOwnSlotLock(nextDir, owner, this.log)
      this.log(`could not move slot ${String(slot.id)} to a fresh directory: ${messageOf(error)}`)
      return
    }
    slot.dirIndex = this.stableSlots ? slot.orphans.length + 1 : slot.dirIndex + 1
    slot.dir = nextDir
    slot.orphans.push(orphan)
    if (sessionStopped === true) slot.stoppedOrphans.add(orphan)
    else markLiveOrphan(orphan, this.log)
    if (this.stableSlots) {
      // The orphan is not the stable slot any more, so nothing claims it by name; its own
      // lock says this pool still owns it, and the sweep must leave it while the pool runs.
      writeRetiredSlotLock(orphan, { ...owner, log: this.log, linkLock: this.linkLock })
    }
    this.#resetSlotAfterRetire(slot)
    this.log(`retired ${orphan} in place: its session may still be writing there; the slot moved to ${nextDir}`)
  }

  /**
   * Forget the per-call state of a slot whose tree was just retired.
   * @param {Slot} slot - the slot that moved on.
   * @returns {void}
   */
  #resetSlotAfterRetire(slot) {
    slot.base = null
    slot.baseReason = undefined
    slot.tmpDir = undefined
    slot.ignoredBase = undefined
    slot.ignoredFiles = undefined
    slot.copyExcluded = undefined
    slot.copyExcludeNames = undefined
    slot.scope = undefined
    slot.repoDir = undefined
    slot.task = undefined
  }

  /**
   * Read what the worker changed, and store it as a patch a later apply can use.
   *
   * @param {Slot} slot - the slot the worker ran in.
   * @param {object} [options] - patch options.
   * @param {number} [options.diffChars] - clip the returned diff to whole file sections within this many characters.
   * @param {boolean} [options.store] - write the patch and its record; false for apply "discard",
   *   which reports the change without keeping it.
   * @param {boolean} [options.retiring] - the tree is retired right after (a salvaged call),
   *   so no later call in the slot empties it, and a warning must not say one will.
   * @returns {Change} the change, ready to be projected into a tool result.
   */
  collect(slot, { diffChars = 20000, store = true, retiring = false } = {}) {
    const change = this.#collect(slot, { diffChars, store, retiring })
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

  /** `collect` without the trim. @param {Slot} slot @param {{diffChars: number, store: boolean, retiring?: boolean}} options @returns {Change} */
  #collect(slot, { diffChars, store = true, retiring = false }) {
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
    const nested = slot.nested ?? []
    try {
      git(['add', '-A', ...excludingPaths(repoDir, nested)], repoDir)
      return withNestedIndex(repoDir, nested, slot.base, (env, unread) => {
        const change = this.#collectStaged(slot, { repoDir, scope, diffChars, store, env })
        if (unread.length === 0) return change
        // The rest of the change is kept; what is missing is named, and the service keeps
        // this copy (see `nestedUnread`) so those edits are still on disk to recover. A
        // retired tree is never reused by a later call: it goes when the state cap trims it
        // or the server exits, and the warning has to name that instead.
        const warnings = unread.map(({ path, reason }) => {
          const named = scope === '' ? path : `${scope}/${path}`
          const where = join(repoDir, path)
          const kept = retiring
            ? `the retired copy keeps them at ${where} until the state cap trims it or the server exits`
            : `the copy keeps them at ${where} until the next call in this slot, or the server's exit, empties it`
          const message = `the changes inside nested repository ${named} could not be read (${reason}) and are not in this patch; ${kept}`
          this.log(message)
          return message
        })
        return { ...change, nestedUnread: unread.map(({ path }) => path), warnings }
      })
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
   * The staged half of `collect`: the diff against the base, and the stored patch.
   *
   * @param {Slot} slot - the slot being collected.
   * @param {object} options - where, how much, whether to store, and the index to read.
   * @param {string} options.repoDir - the copy's repository.
   * @param {string} options.scope - the nested repository the call was scoped to, or `''`.
   * @param {number} options.diffChars - the clipped diff's budget.
   * @param {boolean} options.store - whether to keep the patch.
   * @param {NodeJS.ProcessEnv} options.env - the environment naming the staged index.
   * @returns {Change} the change.
   * @throws {Error} when git cannot produce the diff.
   */
  #collectStaged(slot, { repoDir, scope, diffChars, store, env }) {
    const full = git(['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', slot.base], repoDir, env)
    const diffstat = git(['diff', '--cached', '--stat', '--no-color', slot.base], repoDir, env)
    const filesChanged = nameStatusRecords(repoDir, slot.base, env)
    // Work that git ignores is work the patch cannot carry. It is reported rather
    // than silently dropped: a caller told "no change" while the worker wrote a
    // whole build directory has been misled, not informed. A path that already
    // existed at the base is not new, so it is compared against the recorded facts
    // instead: a rewritten or deleted ignored file is just as invisible to the patch.
    const ignored = this.#createdIgnored(slot, repoDir, scope)
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
    // No tracked change means no patch: an empty file with an id is not something a later
    // `flash_apply` can carry, and every writing job that did nothing used to leave one
    // behind. `available` stays true — the diff was computed, it is simply empty — and the
    // result must not name a patch nothing can apply. Ignored-only work still reports its
    // warnings above; the patch cannot carry it either way.
    if (filesChanged.length === 0) return { ...change, stored: false }
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
    const preimage = savePreimageBlobs(repoDir, slot.base, this.patchDir, patchId, this.log, env)
    const record = {
      patchId,
      patchPath,
      metaPath,
      storeDir: this.patchDir,
      root: this.root,
      scope,
      base: slot.base,
      // Kept beside the base because `drift` has to count from the caller's HEAD at copy
      // time, and the base commit that names it exists only in the copy.
      baseParent: slot.baseParent ?? null,
      filesChanged,
      diffstat: diffstat.trim(),
      createdAt: Date.now(),
      appliedAt: null,
    }
    if (slot.basePatchId !== undefined) record.basePatch = slot.basePatchId
    if (preimage !== undefined) record.preimage = preimage
    // The task the copy was prepared for travels with the patch: after a crash or a
    // restart, the record itself says whose work this was.
    if (slot.task !== undefined) record.task = slot.task
    // The record is the commit point: until it lands, the patch and its blobs are
    // unreferenced and a prune may reclaim them.
    this.#writeMeta(record)
    this.patches.set(patchId, record)
    return { ...change, patchId, patchPath, scope }
  }

  /**
   * The job's own change: a cumulative patch's diff relative to the base patch it continued from.
   *
   * A call started with `basePatch` stores a patch that holds the base patch's change and
   * the new work together (`prepare` records its base before the base patch is applied).
   * When the caller has since committed the base, they want only the second half. Both
   * halves are rebuilt as trees in a scratch repository: the cumulative patch's own base
   * (from its saved preimage), the base patch applied to it, and this patch applied to it.
   * The diff between the last two is the work this call added.
   *
   * The caller's index and repository are never used as an index: the scratch repository
   * borrows the patch stores' saved blobs and the caller's objects read-only through
   * `objects/info/alternates`, exactly as the three-way merge does.
   *
   * @param {object} record - a patch record whose `basePatch` names a stored patch.
   * @returns {{patchPath: string, filesChanged: string[], diffstat: string,
   *   preimage: Array<{path: string, mode: string, blob: string}>, dir: string,
   *   objects: string, basePatchId: string}} the own change, in a
   *   temporary directory beside the patch store (`dir`, to be removed by the caller).
   * @throws {Error} when the record has no base patch, that base patch is no longer stored,
   *   or git cannot rebuild the two states.
   */
  #changeWithoutBase(record) {
    const basePatchId = record.basePatch
    if (typeof basePatchId !== 'string' || basePatchId.length === 0) {
      throw new Error(`patch ${record.patchId} was not started from another patch, so there is no base patch to exclude`)
    }
    let baseRecord
    try {
      baseRecord = this.#lookupPatch(basePatchId)
    } catch (error) {
      throw new Error(
        `patch ${record.patchId} was started from base patch ${basePatchId}, which is no longer stored (${messageOf(error)}); ` +
          "the job's own change cannot be separated from it",
      )
    }
    if (!existsSync(baseRecord.patchPath)) {
      throw new Error(
        `patch ${record.patchId} was started from base patch ${basePatchId}, whose patch file is no longer stored ` +
          `(${baseRecord.patchPath}); the job's own change cannot be separated from it`,
      )
    }
    const unavailable =
      `The base of patch ${record.patchId} is not available (it was made before blob saving existed, or saving failed).`
    const dir = mkdtempSync(join(this.stateDir, 'exclude-base-'))
    const env = { ...process.env }
    // The scratch repository is selected by its working directory, not by the caller's
    // environment: an inherited GIT_DIR or object directory would point it elsewhere.
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
      delete env[name]
    }
    try {
      git(['init', '-q'], dir, env)
      const alternates = [
        blobsDirectory(record.storeDir ?? this.patchDir, record.patchId),
        blobsDirectory(baseRecord.storeDir ?? this.patchDir, baseRecord.patchId),
      ].filter((path) => existsSync(path))
      const scope = record.scope ?? ''
      const repo = scope === '' ? this.root : join(this.root, scope)
      if (isGitWorkTree(repo)) {
        const commonDir = resolve(repo, git(['rev-parse', '--git-common-dir'], repo).trim())
        alternates.push(join(commonDir, 'objects'))
      }
      if (alternates.length > 0) {
        writeFileSync(join(dir, '.git', 'objects', 'info', 'alternates'), `${alternates.join('\n')}\n`)
      }
      const baseTree = baseTreeOf(record, dir, env, unavailable)
      // The cumulative patch applied to its own base: the state the worker finished in.
      git(['read-tree', baseTree], dir, env)
      git(['apply', '--cached', '--whitespace=nowarn', record.patchPath], dir, env)
      const finishedTree = git(['write-tree'], dir, env).trim()
      // The base patch applied to the same base: the state the worker started from.
      git(['read-tree', baseTree], dir, env)
      try {
        git(['apply', '--cached', '--whitespace=nowarn', baseRecord.patchPath], dir, env)
      } catch {
        // The caller's tree may have moved on since the base patch was collected, which is
        // why planting it in a copy goes through a merge. `--3way` uses the same saved base
        // blobs; a conflict leaves unmerged entries, which `write-tree` then refuses.
        try {
          git(['apply', '--cached', '--3way', '--whitespace=nowarn', baseRecord.patchPath], dir, env)
        } catch (error) {
          throw new Error(
            `${unavailable} The recorded base patch ${basePatchId} does not apply to that base ` +
              `(${messageOf(error)}), so the job's own change cannot be separated from it.`,
          )
        }
      }
      const startedTree = git(['write-tree'], dir, env).trim()
      const patchPath = join(dir, 'own.patch')
      const diff = git(['diff', '--binary', '--no-color', '--no-ext-diff', startedTree, finishedTree], dir, env)
      writeFileSync(patchPath, diff)
      return {
        patchPath,
        filesChanged: nameStatusBetween(dir, startedTree, finishedTree, env),
        diffstat: git(['diff', '--stat', '--no-color', startedTree, finishedTree], dir, env).trim(),
        preimage: preimageBetween(dir, startedTree, finishedTree, env),
        dir,
        objects: join(dir, '.git', 'objects'),
        basePatchId,
      }
    } catch (error) {
      rmSync(dir, { recursive: true, force: true })
      throw error
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
   * @param {string} options.patchId - a patch id from an earlier call, or a unique prefix of
   *   one (at least eight hex digits, with or without the `flash-` prefix).
   * @param {string[]} [options.files] - apply only these files' sections, named as in
   *   `change.filesChanged`; a rename may be named by its old or its new path.
   * @param {boolean} [options.dryRun] - check that it applies without changing anything.
   * @param {boolean} [options.force] - apply again even though the record says it was applied,
   *   and apply a deletion or rename over a path the caller changed since the base.
   * @param {boolean} [options.threeWay] - merge it in a scratch repository, rather than
   *   plain-applying it, when the plain apply fails or would remove a path the caller
   *   changed. The merge keeps that edit and marks a conflict in the file.
   * @param {boolean} [options.excludeBase] - apply only the change this patch made on top
   *   of the base patch it continued from, not the base patch's work as well. Computed in a
   *   scratch repository, never in the caller's index.
   * @returns {{patchId: string, applied: boolean, dryRun: boolean, root: string, filesChanged: string[], diffstat: string, threeWay: boolean, conflicts: string[], indexTouched: boolean, drift: {commitsBehind: number | null, filesChangedSince: string[]} | null, warnings?: string[], note?: string, task?: object}} the outcome, with the full id, how far the tree moved since the patch's base, the task that made the patch when the record has one, and a warning when the tree touched the patch's files. `drift` and the refusal name paths from the service root. A partial apply reports only the selected files.
   * @throws {Error} when the patch is unknown, belongs to another repository, was already
   *   applied, `files` names no file or one the patch lacks, would delete or rename a path
   *   the caller changed since the base without `threeWay` or `force`, does not apply, its
   *   base is not available for a three-way merge, or `excludeBase` names a patch with no
   *   recorded base patch or a base patch that is no longer stored.
   */
  apply({ patchId, files, dryRun = false, force = false, threeWay = false, excludeBase = false }) {
    if (files !== undefined && (!Array.isArray(files) || files.length === 0)) {
      throw new Error('files must name at least one file of the patch')
    }
    const record = this.#lookupPatch(patchId)
    if (!existsSync(record.patchPath)) throw new Error(`the patch file for ${record.patchId} is gone (${record.patchPath})`)
    // A patch that was applied once is not idempotent: `git apply` may well find a
    // second place to put the change when the surrounding lines repeat. Recording the
    // apply is what makes "already applied" a rule instead of a coincidence. A partial
    // apply has its own, per-file version of this refusal below.
    if (files === undefined && !dryRun && !force && record.appliedAt !== null && record.appliedAt !== undefined) {
      throw new Error(
        `patch ${record.patchId} was already applied to ${this.root} at ${new Date(record.appliedAt).toISOString()}; pass force: true to apply it again`,
      )
    }
    /** Temporary directories made for this apply, removed in the `finally` below. @type {string[]} */
    const tempDirs = []
    // The record the pipeline runs on: the stored one for a whole apply, the job's own
    // change for `excludeBase`, and a narrowed copy with a temporary patch for a partial
    // one. `record` stays the record to mark, so the bookkeeping lands next to the stored
    // patch.
    let view = record
    /** The scratch repository a three-way merge of the own change looks into. */
    let extraAlternates
    // The record spelling of the selected files: what `appliedFiles` stores. A whole
    // apply passes undefined, which `#markApplied` reads as "every file".
    /** @type {string[] | undefined} */
    let selectedFiles
    try {
      if (excludeBase) {
        const own = this.#changeWithoutBase(record)
        tempDirs.push(own.dir)
        // The cumulative patch holds exactly its base patch's change: there is no own diff
        // to apply, and `git apply` of an empty patch fails with "No valid patches in input"
        // in both the plain and the three-way path. Say what this is instead of applying it.
        if (own.filesChanged.length === 0) {
          return {
            patchId: record.patchId,
            dryRun,
            root: record.scope ? join(this.root, record.scope) : this.root,
            filesChanged: [],
            diffstat: '',
            drift: null,
            threeWay: false,
            conflicts: [],
            indexTouched: false,
            applied: false,
            note: noOwnWorkNote(record),
            ...(record.task === undefined ? {} : { task: record.task }),
          }
        }
        view = {
          ...record,
          patchPath: own.patchPath,
          storedPatchPath: record.patchPath,
          filesChanged: own.filesChanged,
          diffstat: own.diffstat,
          preimage: own.preimage,
        }
        extraAlternates = [own.objects]
      }
      let patchRecord = view
      if (files !== undefined) {
        const sections = diffSections(readFileSync(view.patchPath, 'utf8'))
        const chosen = selectedPatchSections(view.patchId, sections, files)
        const names = new Set()
        for (const section of chosen) {
          for (const name of diffSectionNames(section)) names.add(name)
        }
        // The record's own lines, so `filesChanged` keeps the spelling every other result
        // uses; a rename's line carries both paths, either of which may have selected it.
        const lines = (view.filesChanged ?? []).filter((line) => {
          const { path, oldPath } = nameStatusEntry(line)
          return names.has(path) || (oldPath !== undefined && names.has(oldPath))
        })
        selectedFiles = recordPaths(lines)
        const alreadyApplied = appliedFileNames(record)
        const repeated = selectedFiles.filter((name) => alreadyApplied.includes(name))
        if (!dryRun && !force && repeated.length > 0) {
          throw new Error(
            `patch ${record.patchId}: ${repeated.join(', ')} already applied to ${this.root}; pass force: true to apply them again`,
          )
        }
        const tempDir = mkdtempSync(join(this.stateDir, 'partial-'))
        tempDirs.push(tempDir)
        const patchPath = join(tempDir, 'patch')
        writeFileSync(patchPath, chosen.map((section) => section.text).join(''))
        // The diffstat is git's own spelling of the selected change, so a partial result
        // describes what it applied rather than quoting the whole patch's summary.
        const diffstat = git(['apply', '--stat', patchPath], this.stateDir).trim()
        patchRecord = partialPatchRecord(view, { patchPath, filesChanged: lines, sections: chosen, diffstat })
        // `excludeBase` narrows the record to the own change, whose temporary patch is
        // removed with the apply; a failure message must still name the stored one.
        if (excludeBase) patchRecord.storedPatchPath = record.patchPath
      } else {
        const patchFiles = recordPaths(view.filesChanged)
        const alreadyApplied = new Set(appliedFileNames(record))
        const repeated = patchFiles.filter((name) => alreadyApplied.has(name))
        // Some of the patch reached this tree, but not all of it. Applying the whole patch
        // again would meet the files already here; naming the rest is what lets the caller
        // finish the apply without forcing a repeat.
        if (!dryRun && !force && repeated.length > 0 && repeated.length < patchFiles.length) {
          throw new Error(
            `patch ${record.patchId}: ${String(repeated.length)} of ${String(patchFiles.length)} files were already applied ` +
              `(${repeated.join(', ')}); pass files with the rest, or force: true to apply the whole patch again`,
          )
        }
      }
      // A patch computed inside one nested repository applies inside that repository.
      const target = patchRecord.scope ? join(this.root, patchRecord.scope) : this.root
      // `filesChanged` keeps the record's own spelling, the one `change.filesChanged` and
      // `flash_patch`'s `files` use; the refusal and the drift name paths from the service root.
      const filesChanged = recordPaths(patchRecord.filesChanged)
      const diffstat = (patchRecord.diffstat ?? '').trim()
      // Read before the write: `filesChangedSince` asks what the tree looked like when the
      // patch was handed over, not after the patch itself changed those files.
      //
      // The drift and the destructive-edit check ask about the same patch files, and a
      // working-tree hash is one git process per file when it is done path by path. One
      // batch over every path the patch names serves both, so an apply of a 300-file patch
      // spawns one `git hash-object` rather than three hundred.
      const blobs = workingTreeBlobs(target, patchBlobPaths(patchRecord))
      const drift = patchDrift(patchRecord, this.root, blobs)
      const destroyed = destructiveEdits(patchRecord, target, blobs).map((path) => serviceRootPath(patchRecord, path))
      // An old record kept no base blobs, so it cannot say whether the caller edited a path
      // the patch removes. That is a warning, not a refusal: the apply is still the same
      // apply, and refusing it would strand a patch the caller was told could be used.
      const unverified = Array.isArray(patchRecord.preimage)
        ? []
        : unverifiableRemovals(patchRecord, target).map((path) => serviceRootPath(patchRecord, path))
      /** @type {string[]} */
      const warnings = []
      const destructiveMessage = destroyed.length === 0 ? undefined : destructiveApplyMessage(record.patchId, destroyed)
      if (destructiveMessage !== undefined) {
        // A dry run reports the condition without writing anything. Without `threeWay` its
        // real apply would be refused, so it must not ask git about the rest of the patch;
        // with `threeWay` the merge below predicts the conflicts the real apply would leave.
        if (dryRun) warnings.push(destructiveMessage)
        else if (!threeWay && !force) throw new Error(destructiveMessage)
      }
      if (unverified.length > 0) warnings.push(unverifiedRemovalWarning(unverified))
      // A plain apply of a rename removes the old path without comparing its content, so a
      // caller edit there would be lost with no warning at all. A three-way merge is the mode
      // that keeps it, so it skips the plain attempt entirely: a pure rename succeeds plainly
      // and would never reach the merge.
      const outcome =
        dryRun && destroyed.length > 0 && !threeWay
          ? { threeWay: false, conflicts: [], indexTouched: false, applied: false }
          : this.#applyTo(patchRecord, {
              target,
              dryRun,
              threeWay,
              mark: !dryRun,
              markRecord: record,
              // A whole `excludeBase` apply records only the own files it put in: the base
              // patch's work is not in the caller's tree just because this half was.
              markFiles: selectedFiles ?? (excludeBase ? recordPaths(view.filesChanged) : undefined),
              // "Every file" means every own file for `excludeBase`: the stored record's
              // `filesChanged` also holds the base patch's files, which this apply never puts
              // in, so it would otherwise never count as applied.
              markOwnFiles: excludeBase ? recordPaths(view.filesChanged) : undefined,
              extraAlternates,
              ...(destructiveMessage !== undefined && threeWay
                ? { skipPlain: true, plainError: new Error(destructiveMessage) }
                : {}),
            })
      if (drift !== null && drift.filesChangedSince.length > 0) warnings.push(driftWarning(drift.filesChangedSince))
      // The outcome's own warnings (markers nobody reported) come after the ones above and
      // must not replace them.
      const { warnings: outcomeWarnings = [], ...settled } = outcome
      warnings.push(...outcomeWarnings)
      return {
        patchId: record.patchId,
        dryRun,
        root: target,
        filesChanged,
        diffstat,
        drift,
        ...(warnings.length === 0 ? {} : { warnings }),
        ...(record.task === undefined ? {} : { task: record.task }),
        ...settled,
      }
    } finally {
      // Also on a refusal or a failed apply: the subset and the own change are views of the
      // stored patch, and the stored patch itself is never rewritten.
      for (const path of tempDirs) rmSync(path, { recursive: true, force: true })
    }
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
   * A base patch the caller had already applied (uncommitted) arrives with the copy itself,
   * because the copy is taken from the caller's working tree. Applying it again merged the
   * change over itself, and one caller got conflicts in five files. When the reverse of the
   * patch applies to the copy and the patch itself does not, its whole change is already
   * there: it is skipped, and `warning` says so. The copy's base was recorded from that same
   * tree, so the patch this call stores then holds the new work only, not the base patch's
   * change. A patch that is only partly present goes through the merge as before.
   *
   * @param {Slot} slot - a slot `prepare` has already filled.
   * @param {string} patchId - the stored patch to continue from, or a unique prefix of its id.
   * @returns {{patchId: string, applied: boolean, alreadyInTree?: true, threeWay: boolean,
   *   conflicts: string[], filesChanged: string[], warning?: string}} what landed in the copy;
   *   `applied: false` with `alreadyInTree` and `warning` when the copy already held it.
   * @throws {Error} when the patch is unknown, belongs to another root or scope, its file is
   *   gone, or its base is unavailable for the merge the copy needs.
   */
  applyBasePatch(slot, patchId) {
    const record = this.#lookupPatch(patchId)
    if (!existsSync(record.patchPath)) throw new Error(`the patch file for ${record.patchId} is gone (${record.patchPath})`)
    // The copy was made from the scope the call's cwd resolves to, and a patch only means
    // the same edit inside the repository it was computed in.
    const scope = slot.scope ?? ''
    const patchScope = record.scope ?? ''
    if (patchScope !== scope) {
      const where = (value) => (value === '' ? 'the service root' : `the repository ${value}`)
      throw new Error(
        `patch ${record.patchId} was computed for ${where(patchScope)}, but this call's cwd resolves to ${where(scope)}; ` +
          'a base patch must come from the same repository as the call',
      )
    }
    const target = slot.repoDir ?? slot.dir
    if (basePatchInTree(record, target)) {
      this.log(
        `not applying base patch ${record.patchId} in slot ${String(slot.id)}: the copy already holds its whole change, ` +
          'taken from the caller’s tree',
      )
      return {
        patchId: record.patchId,
        applied: false,
        alreadyInTree: true,
        threeWay: false,
        conflicts: [],
        filesChanged: recordPaths(record.filesChanged),
        warning:
          `basePatch ${record.patchId} was already in the tree the copy was taken from, so it was not applied again; ` +
          "this call's patch does not contain it",
      }
    }
    let outcome
    try {
      // Always through the merge fallback: the caller's tree may have moved on since the base
      // patch was collected, and a plain apply is only refused when its context no longer fits.
      outcome = this.#applyTo(record, { target, threeWay: true, mark: false })
    } catch (error) {
      throw new Error(
        `${messageOf(error)} Continuing from this patch is not possible in the copy. ` +
          `Pass source: "head" to start from the last commit instead, or apply patch ${record.patchId} to your tree with flash_apply first.`,
      )
    }
    if (outcome.status === 'failed') {
      throw new Error(
        `${outcome.note}. Continuing from this patch is not possible in the copy. ` +
          `Pass source: "head" to start from the last commit instead, or apply patch ${record.patchId} to your tree with flash_apply first.`,
      )
    }
    // The copy's state now includes the base patch's change, so what it started with changed
    // too: an ignored path the patch created is part of that state, not the worker's work.
    this.#recordIgnored(slot, target)
    // This call's patch will contain the base patch's change, so the base is superseded by it.
    slot.basePatchId = record.patchId
    // The copy holds the change whether the patch applied outright, the merge wrote something,
    // or the merge found the copy already equal to its result. Conflict markers are reported
    // as conflicts, and the worker is told to resolve them.
    return {
      patchId: record.patchId,
      applied: true,
      threeWay: outcome.threeWay === true,
      conflicts: outcome.conflicts ?? [],
      filesChanged: recordPaths(record.filesChanged),
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
   * @param {object} [options.markRecord] - the stored record to mark when it differs from
   *   the narrowed record being applied. A partial apply marks the stored record, so its
   *   `appliedFiles` describes the whole patch rather than the temporary subset.
   * @param {string[]} [options.markFiles] - the selected files' record spelling. Omitted
   *   for a whole apply, which marks every file of `markRecord`.
   * @param {string[]} [options.markOwnFiles] - the files this apply may put in when they are
   *   fewer than `markRecord`'s: an `excludeBase` apply marks the stored cumulative record,
   *   but only its own files (not the base patch's) are applied.
   * @param {boolean} [options.skipPlain] - go straight to the three-way merge, without
   *   trying the plain apply. An apply of a destructive patch uses this because a pure
   *   rename would succeed plainly and discard the caller's edit on the old path.
   * @param {Error} [options.plainError] - the reason the plain apply was skipped, folded
   *   into a merge failure the same way a real plain failure is.
   * @param {string[]} [options.extraAlternates] - object directories a merge may borrow
   *   read-only, such as the scratch repository an `excludeBase` diff was built in.
   * @returns {{applied: boolean, threeWay: boolean, conflicts: string[], indexTouched: false, note?: string}} the outcome.
   * @throws {Error} when the patch does not apply, or its base is unavailable for a merge.
   */
  #applyTo(record, { target, dryRun = false, threeWay = false, mark = false, markRecord = record, markFiles, markOwnFiles, skipPlain = false, plainError, extraAlternates }) {
    if (skipPlain) {
      return this.#threeWayMerge(record, target, {
        dryRun,
        plainError: plainError ?? new Error('the plain apply was skipped so a caller edit is not lost'),
        mark,
        markRecord,
        markFiles,
        markOwnFiles,
        extraAlternates,
      })
    }
    // Without `--index` the caller's index is left alone; only the working tree moves.
    // Outside a repository the target must not discover one enclosing it: paths in the
    // patch would then be read relative to that repository's top instead of to the target.
    const workTree = isGitWorkTree(target)
    const env = workTree ? undefined : { ...process.env, GIT_CEILING_DIRECTORIES: dirname(target) }
    const applyArgs = ['apply', '--whitespace=nowarn']
    const check = dryRun ? ['--check'] : []
    // A three-way caller is told about every file, and about markers the patch itself adds.
    const names = threeWay ? recordPaths(record.filesChanged) : []
    try {
      git([...applyArgs, ...check, record.patchPath], target, env)
    } catch (plainError) {
      if (!threeWay) {
        throw new Error(
          `${messageOf(plainError)}. The patch is at ${patchMessagePath(record)}; retry with threeWay: true to merge it.`,
        )
      }
      return this.#threeWayMerge(record, target, { dryRun, plainError, mark, markRecord, markFiles, markOwnFiles, extraAlternates })
    }
    if (!dryRun && mark) this.#markApplied(markRecord, markFiles, markOwnFiles)
    if (!threeWay) return { applied: !dryRun, threeWay: false, conflicts: [], indexTouched: false }
    const marked = patchMarkerFiles(readFileSync(record.patchPath, 'utf8'))
    return {
      applied: !dryRun,
      threeWay: false,
      conflicts: [],
      indexTouched: false,
      status: 'success',
      files: names.map((path) => ({ path, status: 'applied' })),
      ...(marked.length > 0 ? { warnings: [patchMarkerWarning(marked)] } : {}),
    }
  }

  /**
   * Record that a patch, or one file of it, reached the caller's tree, so a second apply
   * is refused.
   *
   * `files` is the partial apply's selection in record spelling. A whole apply passes
   * none and records every file too: a later partial apply then knows exactly which files
   * are already here, and a record keeps one shape after either kind of apply. The
   * whole-patch timestamp is set once every file this apply may put in is recorded, which
   * is also what a whole apply does today. `ownFiles` narrows that set for an
   * `excludeBase` apply, whose stored record also names the base patch's files.
   *
   * @param {object} record - the stored patch record to mark and store.
   * @param {string[]} [files] - the applied files' record spelling; omitted for a whole apply.
   * @param {string[]} [ownFiles] - the files this apply may put in; every file of the record
   *   unless an `excludeBase` apply names the own half.
   * @returns {void}
   */
  #markApplied(record, files, ownFiles = recordPaths(record.filesChanged)) {
    const already = new Set(appliedFileNames(record))
    if (files === undefined) for (const name of recordPaths(record.filesChanged)) already.add(name)
    else for (const name of files) already.add(name)
    record.appliedFiles = [...already].sort()
    if (files === undefined || ownFiles.every((name) => already.has(name))) record.appliedAt = Date.now()
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
   * @param {object} [options.markRecord] - the stored record to mark, when the record being
   *   applied is a narrowed partial one.
   * @param {string[]} [options.markFiles] - the selected files' record spelling; omitted
   *   for a whole apply.
   * @param {string[]} [options.markOwnFiles] - the own files of an `excludeBase` apply, the
   *   set that decides whether every file this apply may put in is now in the tree.
   * @param {string[]} [options.extraAlternates] - object directories to borrow read-only
   *   besides the patch's saved blobs and the caller's repository.
   * @returns {{threeWay: true, applied: boolean, conflicts: string[], indexTouched: false, status: 'success' | 'conflict' | 'failed',
   *   files: Array<{path: string, status: 'applied' | 'merged' | 'conflict' | 'failed', reason?: string}>,
   *   appliable?: string[], note?: string, warnings?: string[]}} the outcome. When some files have no
   *   base, nothing is written and `status` is `failed`, with the files that can still go in
   *   `appliable`. A file whose merged content holds conflict markers its caller version
   *   lacked is a `conflict`, and `warnings` says so.
   * @throws {Error} when no file has a base, git is too old, or the merge errors.
   */
  #threeWayMerge(record, target, { dryRun, plainError, mark = false, markRecord = record, markFiles, markOwnFiles, extraAlternates = [] }) {
    const patchId = record.patchId
    const unavailable =
      `The base of patch ${patchId} is not available for a three-way merge ` +
      '(it was made before blob saving existed, or saving failed).'
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
      // "Ours" is hashed here with `--path`, and a new file is written back through
      // `--filters`; both convert line endings by `core.autocrlf`/`core.eol`. A fresh
      // repository only sees the global value, so a caller who set it in the repository
      // itself had every CRLF line of "ours" read as changed against an LF base.
      if (isGitWorkTree(target)) {
        for (const key of ['core.autocrlf', 'core.eol']) {
          const value = gitOrEmpty(['config', '--get', key], target)
          if (value !== '') git(['config', key, value], scratch, env)
        }
      }
      // Blobs from either side have to resolve: the patch's saved base, and the caller's
      // repository objects when the base was committed there. The scratch repository
      // borrows both read-only, so a merge never writes into either.
      const alternates = []
      const blobs = blobsDirectory(record.storeDir ?? this.patchDir, patchId)
      if (existsSync(blobs)) alternates.push(blobs)
      for (const path of extraAlternates) {
        if (existsSync(path)) alternates.push(path)
      }
      if (isGitWorkTree(target)) {
        const commonDir = resolve(target, git(['rev-parse', '--git-common-dir'], target).trim())
        alternates.push(join(commonDir, 'objects'))
      }
      if (alternates.length > 0) {
        writeFileSync(join(scratch, '.git', 'objects', 'info', 'alternates'), `${alternates.join('\n')}\n`)
      }
      // Base B: the preimage entries of the patch, and only those. An addition contributes
      // nothing, which is why an add-only patch merges against the empty tree. A record
      // without a preimage (made before blob saving, or whose saving failed) falls back to
      // what the patch itself states: its `index <old>..<new>` lines name the base blobs,
      // and the caller's repository is asked for them.
      const saved = Array.isArray(record.preimage)
      const entries = saved
        ? record.preimage.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string')
        : patchBaseEntries(readFileSync(record.patchPath, 'utf8'))
      const noBase = 'patch record has no saved base (made before 0.1.x)'
      /** @type {Map<string, string>} the reason per base path that cannot be found */
      const missing = new Map()
      const found = []
      for (const entry of entries) {
        // A gitlink is recorded by id alone; its commit lives in the submodule's repository.
        if (entry.mode === GITLINK_MODE) {
          found.push(entry)
          continue
        }
        if (typeof entry.blob !== 'string') {
          missing.set(entry.path, noBase)
          continue
        }
        // The patch's own ids are abbreviated; the scratch repository resolves them through
        // the same two object stores the lookup of a saved id uses.
        const looked = saved
          ? gitAllowFailure(['cat-file', '-e', entry.blob], scratch, env).status === 0 && { blob: entry.blob }
          : this.#fullBlobId(entry.blob, scratch, env)
        if (looked === false || looked === undefined) {
          const absent = `base blob ${entry.blob} is not in this repository`
          missing.set(entry.path, saved ? absent : `${noBase}, and ${absent}`)
          continue
        }
        found.push({ ...entry, blob: looked.blob })
      }
      // Each patch file with its names: a rename is found by its old path (the base entry)
      // and reported by its new one, the spelling `files` takes.
      const patchFiles = (record.filesChanged ?? []).map((line) => ({ name: nameStatusEntry(line).path, paths: recordEntry(line).paths }))
      const failed = new Map()
      for (const [path, reason] of missing) {
        const owner = patchFiles.find((file) => file.paths.includes(path))
        const name = owner?.name ?? path
        failed.set(name, failed.has(name) ? `${failed.get(name)}; ${reason}` : reason)
      }
      const failedPaths = new Set(patchFiles.filter((file) => failed.has(file.name)).flatMap((file) => file.paths))
      const appliable = patchFiles.filter((file) => !failed.has(file.name))
      if (failed.size > 0 && appliable.length === 0) {
        const reasons = [...failed].map(([name, reason]) => `${name}: ${reason}`).join('; ')
        throw new Error(`${messageOf(plainError)}. ${unavailable} ${reasons}. The patch is at ${patchMessagePath(record)}.`)
      }
      // A file that failed stops the whole write (all or nothing), but the others are still
      // merged here, without writing, so each is reported with the status it would get.
      const wholePatch = failed.size === 0
      const writing = wholePatch && !dryRun
      let patchFile = record.patchPath
      if (!wholePatch) {
        const keep = new Set(appliable.flatMap((file) => file.paths))
        const sections = diffSections(readFileSync(record.patchPath, 'utf8')).filter((section) =>
          diffSectionNames(section).some((name) => keep.has(name)),
        )
        patchFile = join(scratch, 'appliable.patch')
        writeFileSync(patchFile, sections.map((section) => section.text).join(''))
      }
      let baseTree
      try {
        for (const entry of found) {
          if (failedPaths.has(entry.path)) continue
          git(['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.blob},${entry.path}`], scratch, env)
        }
        baseTree = git(['write-tree'], scratch, env).trim()
      } catch (error) {
        throw new Error(`${messageOf(plainError)}. ${unavailable} ${messageOf(error)}. The patch is at ${patchMessagePath(record)}.`)
      }
      const base = git([...COMMIT_CONFIG, 'commit-tree', baseTree, '-m', 'flash base'], scratch, env).trim()
      // Theirs W: the patch was computed against exactly this base, so it applies cleanly.
      git(['read-tree', baseTree], scratch, env)
      git(['apply', '--cached', '--whitespace=nowarn', patchFile], scratch, env)
      const theirsTree = git(['write-tree'], scratch, env).trim()
      const theirs = git([...COMMIT_CONFIG, 'commit-tree', theirsTree, '-p', base, '-m', 'flash worker'], scratch, env).trim()
      // Ours O: the caller's own files, at every path the patch touches, over the same base.
      git(['read-tree', baseTree], scratch, env)
      const touched = wholePatch ? touchedPaths(record) : appliable.flatMap((file) => file.paths)
      for (const path of touched) this.#stageCallerPath(scratch, target, path, env)
      const oursTree = git(['write-tree'], scratch, env).trim()
      const ours = git([...COMMIT_CONFIG, 'commit-tree', oursTree, '-p', base, '-m', 'flash caller'], scratch, env).trim()
      const merged = gitAllowFailure(['merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs], scratch, env)
      if (merged.status !== 0 && merged.status !== 1) {
        throw new Error(
          `${messageOf(plainError)}. The three-way merge of ${patchMessagePath(record)} failed in a scratch repository: ${merged.stderr.length > 0 ? merged.stderr : merged.stdout}`.trim(),
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
      // A status per file, from what git's merge reported. Markers the patch itself adds are
      // not a conflict; they are a warning (see `patchMarkerFiles`).
      const callerMoved = new Set(
        git(['diff-tree', '-r', '--name-only', '-z', '--no-renames', baseTree, oursTree], scratch, env).split('\0').filter((name) => name !== ''),
      )
      const statuses = []
      for (const file of appliable) {
        const status = file.paths.some((path) => conflicts.includes(path)) ? 'conflict' : file.paths.some((path) => callerMoved.has(path)) ? 'merged' : 'applied'
        statuses.push({ path: file.name, status })
      }
      for (const [name, reason] of failed) statuses.push({ path: name, status: 'failed', reason })
      const order = new Map(patchFiles.map((file, at) => [file.name, at]))
      statuses.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0))
      const marked = patchMarkerFiles(readFileSync(patchFile, 'utf8'))
      const warnings = marked.length === 0 ? [] : [patchMarkerWarning(marked)]
      if (!wholePatch) {
        const names = [...failed.keys()]
        return {
          threeWay: true,
          conflicts,
          indexTouched: false,
          applied: false,
          status: 'failed',
          files: statuses,
          appliable: appliable.map((file) => file.name),
          note:
            `nothing was written: ${names.join(', ')} could not be merged (${[...failed.values()].join('; ')}); ` +
            `the other files can be applied with files: ${JSON.stringify(appliable.map((file) => file.name))}`,
          ...(warnings.length === 0 ? {} : { warnings }),
        }
      }
      const outcome = writing ? this.#writeMergedTree(scratch, target, ours, resultTree, env) : { written: false, submodules: [] }
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
          this.#markApplied(markRecord, markFiles, markOwnFiles)
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
        status: conflicts.length > 0 ? 'conflict' : 'success',
        files: statuses,
        ...(note === undefined ? {} : { note }),
        ...(warnings.length === 0 ? {} : { warnings }),
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  /**
   * Resolve a patch's abbreviated base blob id to the full id, in the scratch repository.
   *
   * @param {string} abbreviated - the id from a patch's `index` line.
   * @param {string} scratch - the scratch repository, with the caller's objects borrowed.
   * @param {NodeJS.ProcessEnv} env - environment for git.
   * @returns {{blob: string} | undefined} the full id, or undefined when no such blob is there
   *   (or the abbreviation is ambiguous).
   */
  #fullBlobId(abbreviated, scratch, env) {
    const resolved = gitAllowFailure(['rev-parse', '--verify', '-q', `${abbreviated}^{blob}`], scratch, env)
    const blob = resolved.stdout.trim()
    return resolved.status === 0 && /^[0-9a-f]{40,64}$/.test(blob) ? { blob } : undefined
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
   * The content of every write is read before the first mutation too, so a blob git cannot
   * hand back is a refusal that writes nothing. Only a filesystem error during the writes
   * themselves can leave the tree part-merged, and its error names every path already
   * deleted or written.
   *
   * @param {string} scratch - the scratch repository the result tree lives in.
   * @param {string} target - the caller's tree.
   * @param {string} ours - the commit "ours" was committed as.
   * @param {string} resultTree - the merged tree id.
   * @param {NodeJS.ProcessEnv} env - environment for git.
   * @returns {{written: boolean, submodules: string[]}} whether anything was written, and
   *   the submodule pointers the change named (which are never written).
   * @throws {Error} when a path collides with the caller's tree or its content cannot be read
   *   (nothing written), or when a write fails (the paths already changed are named).
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
    // Every merged file and link text is read before the first deletion. A 27-file apply
    // whose 22nd read failed had already written 21 files while its error read as though
    // nothing had been applied; a read that fails here leaves the tree exactly as it was.
    const notText = notTextPaths(target, writes.filter(({ entry }) => entry.mode !== '120000').map(({ path }) => path))
    const contents = new Map()
    for (const write of writes) {
      try {
        contents.set(write.path, mergedContent(scratch, target, write, notText, ours, env))
      } catch (error) {
        throw new Error(
          `the three-way merge could not read the merged content of ${write.path} (${messageOf(error)}); ` +
            `nothing was written to ${target}`,
        )
      }
    }
    // From here on the tree changes. A filesystem error part-way through cannot be undone,
    // so it is reported with everything already changed, for the caller to inspect.
    const deleted = []
    const wrote = []
    let current
    try {
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
        current = path
        rmSync(join(target, path), { force: true })
        deleted.push(path)
      }
      // A directory whose files were all deleted now makes way for the file at its own path.
      for (const { path } of writes) {
        let info
        try {
          info = lstatSync(join(target, path))
        } catch {
          info = undefined
        }
        if (!info?.isDirectory()) continue
        current = path
        rmSync(join(target, path), { recursive: true, force: true })
        deleted.push(`${path}/`)
      }
      for (const { path, entry } of writes) {
        current = path
        writeResultFile(target, path, entry.mode, contents.get(path))
        wrote.push(path)
      }
    } catch (error) {
      const named = (paths) => (paths.length === 0 ? 'nothing' : paths.join(', '))
      throw new Error(
        `the three-way merge failed while writing ${current} in ${target} (${messageOf(error)}); ` +
          `before that it had deleted ${named(deleted)} and written ${named(wrote)}, ` +
          'which are now in the tree; the rest of the merge was not written',
      )
    }
    return { written: deleted.length > 0 || wrote.length > 0, submodules }
  }

  /**
   * Read a stored patch, whole or as one page, so a caller can review a large change
   * before applying it. Like `apply`, it works on the patch the service stored, not on
   * the possibly-clipped `change.diff` in a result.
   *
   * @param {object} options - which patch, and which slice of it.
   * @param {string} options.patchId - a patch id from an earlier call, or a unique prefix of
   *   one (at least eight hex digits, with or without the `flash-` prefix).
   * @param {string[]} [options.files] - read only these files' sections; a rename may be
   *   named by its old or its new path.
   * @param {number} [options.offset] - character offset into the selected text.
   * @param {number} options.maxChars - the page budget.
   * @param {boolean} [options.excludeBase] - page the change this patch made on top of the
   *   base patch it continued from, not the base patch's work as well.
   * @returns {{patchId: string, patchPath: string, applied: boolean, appliedFiles?: string[], filesChanged: string[], diffstat: string, drift?: {commitsBehind: number | null, filesChangedSince: string[]} | null, totalChars: number, offset: number, diff: string, files: string[], nextOffset: number | null, note?: string, task?: object, finalMessage?: string, finalMessageTruncated?: true}} the page; `task` rides on every page, while the worker's final message, the applied files and the drift are only on the page that starts at offset 0. An `excludeBase` page with no own change is empty and carries `note`. `drift.filesChangedSince` is named relative to the service root; `filesChanged` keeps the record's own spelling, as `files` expects it.
   * @throws {Error} when the patch is unknown, belongs to another repository, is gone,
   *   `files` names a file the patch does not contain, or `excludeBase` names a patch with
   *   no recorded base patch or a base patch that is no longer stored.
   */
  readPatch({ patchId, files, offset = 0, maxChars, excludeBase = false }) {
    const record = this.#lookupPatch(patchId)
    if (!existsSync(record.patchPath)) throw new Error(`the patch file for ${record.patchId} is gone (${record.patchPath})`)
    let own
    try {
      let view = record
      if (excludeBase) {
        own = this.#changeWithoutBase(record)
        // The cumulative patch is exactly its base patch: the own page is empty, and saying
        // so is more useful than a page whose diff is the empty string for no stated reason.
        if (own.filesChanged.length === 0) {
          return {
            patchId: record.patchId,
            patchPath: record.patchPath,
            applied: false,
            filesChanged: [],
            diffstat: '',
            drift: null,
            totalChars: 0,
            offset: 0,
            diff: '',
            files: [],
            nextOffset: null,
            note: noOwnWorkNote(record),
            ...(record.task === undefined ? {} : { task: record.task }),
            ...(record.cancelled === undefined ? {} : { cancelled: record.cancelled }),
          }
        }
        view = {
          ...record,
          patchPath: own.patchPath,
          filesChanged: own.filesChanged,
          diffstat: own.diffstat,
          preimage: own.preimage,
        }
      }
      const diff = readFileSync(view.patchPath, 'utf8')
      const sections = diffSections(diff)
      const selected = files === undefined ? sections : selectedPatchSections(record.patchId, sections, files)
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
      const appliedFiles = Array.isArray(record.appliedFiles) ? record.appliedFiles : []
      const ownFiles = recordPaths(view.filesChanged)
      // For `excludeBase`, "applied" asks about the own files only: applying the own half
      // does not put the base patch's change into the caller's tree.
      const applied = excludeBase
        ? ownFiles.length > 0 && ownFiles.every((name) => appliedFileNames(record).includes(name))
        : record.appliedAt !== null && record.appliedAt !== undefined
      return {
        patchId: record.patchId,
        // The stored cumulative patch: the own diff is a view removed with this call.
        patchPath: record.patchPath,
        applied,
        // A whole apply records every file too, so this is the record of what is already in
        // the caller's tree. It is on the first page only, beside the drift and the report.
        ...(page.offset === 0 && appliedFiles.length > 0 ? { appliedFiles: [...appliedFiles].sort() } : {}),
        filesChanged: ownFiles,
        diffstat: (view.diffstat ?? '').trim(),
        // Drift costs one `git hash-object` spawn per patch file. Computing it on every page
        // made a 300-file patch paged ten times cost tens of seconds, so it rides with the
        // worker's final message on the page that starts at offset 0 only.
        ...(page.offset === 0 ? { drift: patchDrift(view, this.root) } : {}),
        ...(page.offset === 0 ? overlapField(this.overlapsOf(record.patchId)) : {}),
        totalChars: text.length,
        offset: page.offset,
        diff: page.diff,
        files: page.files,
        nextOffset: page.nextOffset,
        ...(record.task === undefined ? {} : { task: record.task }),
        // The worker's report is a preamble to the patch, not part of it: repeating ten
        // thousand characters on every page would be most of what a paging caller reads.
        ...(page.offset === 0 ? this.#reportFields(record) : {}),
        ...(record.cancelled === undefined ? {} : { cancelled: record.cancelled }),
      }
    } finally {
      if (own !== undefined) rmSync(own.dir, { recursive: true, force: true })
    }
  }

  /**
   * The other stored patches of this root that change a file this patch changes and are
   * neither applied nor in this patch's lineage.
   *
   * Two jobs started from one tree can take the same next database schema number, and the clash
   * showed only when the second patch was applied. A patch that continued from another
   * (`basePatch`) contains it, so the two are one line of work and never overlap; a patch
   * applied whole is in the tree already, and a partly applied one only counts for the files
   * it has not applied.
   *
   * @param {string} patchId - a patch id of this root.
   * @returns {Array<{patchId: string, files: string[], label: string, createdAt: number}>} newest first.
   */
  overlapsOf(patchId) {
    const record = this.#lookupPatch(patchId)
    const mine = new Set(recordPaths(record.filesChanged))
    const related = patchLineage(record, [...this.patches.values()])
    const found = []
    for (const other of this.patches.values()) {
      if (other.patchId === record.patchId || related.has(other.patchId)) continue
      if (other.appliedAt !== null && other.appliedAt !== undefined) continue
      if ((other.scope ?? '') !== (record.scope ?? '')) continue
      const applied = new Set(Array.isArray(other.appliedFiles) ? other.appliedFiles : [])
      const files = recordPaths(other.filesChanged).filter((name) => mine.has(name) && !applied.has(name))
      if (files.length === 0) continue
      found.push({
        patchId: other.patchId,
        files,
        label: typeof other.task?.label === 'string' ? other.task.label : '',
        createdAt: other.createdAt,
      })
    }
    return found.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
  }

  /**
   * The report fields of a patch's first page: the whole report when its file is still
   * there, otherwise the record's 8,000-character excerpt.
   *
   * @param {object} record - the patch record.
   * @returns {object} `finalMessage` (and `finalMessageTruncated` for an excerpt), `reportPath`.
   */
  #reportFields(record) {
    const whole = typeof record.reportPath === 'string' ? readReportFile(record.reportPath) : undefined
    if (typeof whole?.report === 'string') return { finalMessage: whole.report, reportPath: record.reportPath }
    if (typeof record.finalMessage !== 'string') return {}
    return {
      finalMessage: record.finalMessage,
      ...(record.finalMessageTruncated === true ? { finalMessageTruncated: true } : {}),
      ...(typeof record.reportPath === 'string' ? { reportPath: record.reportPath } : {}),
    }
  }

  /**
   * Drop a patch that holds no change: the record `collect` writes for an empty copy.
   *
   * @param {string} patchId - the full id of a patch this service stored.
   * @returns {void}
   */
  forgetPatch(patchId) {
    const record = this.#lookupPatch(patchId)
    if ((record.filesChanged ?? []).length > 0) throw new Error(`patch ${record.patchId} holds a change and is not dropped`)
    removeStoredPatch(record.storeDir ?? this.patchDir, record.patchId)
    this.patches.delete(record.patchId)
  }

  /**
   * Store the whole report of one finished call next to the patch records.
   *
   * The write is atomic: a temporary file in the same directory is renamed into place, so a
   * reader on another server never sees half a report.
   *
   * @param {string} key - the job id, or the call's session id when it had no job.
   * @param {object} record - what the report says: `report` (the whole text) and its context.
   * @returns {string} the path written.
   * @throws {Error} when the key is not a report key or the file cannot be written.
   */
  storeReport(key, record) {
    const path = reportFilePath(this.patchDir, key)
    mkdirSync(this.patchDir, { recursive: true })
    // A report can be read by another server while this one writes it, so the file appears
    // atomically: the whole record goes to a temporary file in the same directory, then the
    // rename makes it visible. The temporary name does not end in `.report.json`, so a prune
    // or a reader never mistakes a half-written file for a report.
    const temp = join(this.patchDir, `.${key}.${randomUUID()}.tmp`)
    writeFileSync(temp, `${JSON.stringify({ key, ...record }, null, 2)}\n`)
    try {
      renameSync(temp, path)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
    return path
  }

  /**
   * Read a stored report by its key.
   *
   * @param {string} key - the job id or session id it was stored under.
   * @returns {object | undefined} the stored record, or undefined when there is none.
   */
  readReport(key) {
    if (typeof key !== 'string' || !REPORT_KEY.test(key)) return undefined
    return readReportFile(reportFilePath(this.patchDir, key))
  }

  /**
   * Attach the worker's final report to a stored patch.
   *
   * A call's patch is collected before its runtime's last message is known, so the report is
   * written afterwards — and the record has to survive a crash between the two, which is why
   * this rewrites the record on disk through the same shape `collect` uses. The message is
   * bounded: a record is read by every later `flash_patch`, and a worker's report can be
   * longer than the change it describes.
   *
   * @param {string} patchId - the patch to annotate, or a unique prefix of its id.
   * @param {object} [options] - what the worker said.
   * @param {string} [options.finalMessage] - the worker's final report; the first 8,000
   *   characters are kept, and `finalMessageTruncated` says when it was cut.
   * @param {string} [options.reportPath] - where the whole report is stored.
   * @param {{jobId?: string, at: string}} [options.cancelled] - the cancelled job the patch
   *   was salvaged from.
   * @returns {void}
   * @throws {Error} when the id is malformed, unknown, or belongs to another root, exactly
   *   as `apply` refuses one.
   */
  annotatePatch(patchId, { finalMessage, reportPath, cancelled } = {}) {
    const record = this.#lookupPatch(patchId)
    if (typeof reportPath === 'string') record.reportPath = reportPath
    if (cancelled !== undefined) record.cancelled = cancelled
    if (typeof finalMessage === 'string') {
      record.finalMessage = finalMessage.slice(0, FINAL_MESSAGE_MAX)
      if (finalMessage.length > FINAL_MESSAGE_MAX) record.finalMessageTruncated = true
      else delete record.finalMessageTruncated
    }
    this.#writeMeta(record)
    this.patches.set(record.patchId, record)
  }

  /**
   * Find one patch, resolving a short id first, and refuse to hand back one this service
   * may not apply.
   *
   * Three refusals matter here. The id must have the shape this service issues — a full
   * `flash-<uuid>` or a unique prefix of one — because the id is used to build a path,
   * and `../` used to reach any `.patch` on disk. A prefix must name exactly one patch:
   * two reports quoting the same eight digits is an answer nobody can act on, so it is
   * refused with the full ids instead of silently picking one. And the record must name
   * *this* repository: a patch computed for another root is not a merge, it is a different
   * edit to different files, and applying it produced a tree holding another caller's work
   * under this caller's name.
   *
   * @param {string} patchId - the id, or a unique prefix, to look for.
   * @returns {object} the held or re-read record, carrying the full `patchId`.
   * @throws {Error} when the id is malformed, unknown, ambiguous, or belongs to another root.
   */
  #lookupPatch(patchId) {
    // A full id is the case that must behave exactly as it always has; only a shorter one
    // is resolved against the store, and it is resolved *before* any path is built from it.
    if (typeof patchId === 'string' && PATCH_ID.test(patchId)) return this.#lookupFullPatch(patchId)
    const prefix = typeof patchId === 'string' ? PATCH_ID_PREFIX.exec(patchId) : null
    if (prefix === null) {
      throw new Error(
        `patchId ${JSON.stringify(patchId)} is not an id this service issues; ids look like "flash-<uuid>", ` +
          'or give a unique prefix of at least 8 hex digits',
      )
    }
    const matches = this.#matchingPatchIds(prefix[1])
    if (matches.length === 0) {
      throw new Error(`no patch ${patchId} is held by this service; patches are kept in ${this.patchDir}`)
    }
    if (matches.length > 1) {
      const named = matches.slice(0, PATCH_PREFIX_NAMES).join(', ')
      const more = matches.length > PATCH_PREFIX_NAMES ? ', …' : ''
      throw new Error(
        `patchId ${JSON.stringify(patchId)} matches ${String(matches.length)} stored patches: ${named}${more}; give more of the id`,
      )
    }
    return this.#lookupFullPatch(matches[0])
  }

  /**
   * The full ids one hex prefix could mean, restricted to records this pool may apply.
   *
   * Both the held records and the ids present in the store directories count, because a
   * sibling service may have stored one since this pool loaded. A foreign root's record is
   * not a candidate at all: counting it would make a caller's own prefix look ambiguous,
   * and returning it would hand over another repository's patch. Its scope is checked the
   * same way, since an unsafe scope is a record `apply` refuses.
   *
   * @param {string} hexPrefix - at least eight hex digits, dashes already allowed.
   * @returns {string[]} the matching full ids.
   */
  #matchingPatchIds(hexPrefix) {
    const wanted = hexPrefix.replaceAll('-', '')
    const matches = new Set()
    const candidate = (id) => id.startsWith('flash-') && id.slice('flash-'.length).replaceAll('-', '').startsWith(wanted)
    for (const [id, record] of this.patches) {
      if (!candidate(id)) continue
      if (record?.root !== this.root) continue
      if (!scopeIsSafeOrEmpty(record?.scope)) continue
      matches.add(id)
    }
    const stores = [this.patchDir, ...(this.legacyPatchDir === undefined ? [] : [this.legacyPatchDir])]
    for (const store of stores) {
      let names
      try {
        names = readdirSync(store)
      } catch {
        // A store that does not exist yet holds nothing, which is not an error here.
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const id = name.slice(0, -'.json'.length)
        if (!PATCH_ID.test(id) || !candidate(id) || matches.has(id)) continue
        if (this.#storedPatchApplies(store, id)) matches.add(id)
      }
    }
    return [...matches]
  }

  /**
   * Whether one record on disk is a patch this pool may apply.
   *
   * Only the two facts `#lookupFullPatch` checks before it returns a record are read here:
   * the root it was computed for, and a scope that stays inside it. An unreadable record is
   * not a patch anybody can apply, so it is not a candidate for a prefix either.
   *
   * @param {string} store - the directory the record lives in.
   * @param {string} patchId - the record's id.
   * @returns {boolean} true when this pool could apply that record.
   */
  #storedPatchApplies(store, patchId) {
    try {
      const record = JSON.parse(readFileSync(join(store, `${patchId}.json`), 'utf8'))
      return record?.patchId === patchId && record?.root === this.root && scopeIsSafeOrEmpty(record?.scope)
    } catch {
      return false
    }
  }

  /**
   * Find one patch by its full id, re-reading the record when this pool does not hold it.
   *
   * @param {string} patchId - a validated full patch id.
   * @returns {object} the held or re-read record.
   * @throws {Error} when the record is unknown, unreadable, or belongs to another root.
   */
  #lookupFullPatch(patchId) {
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
   * depend on which process won a race. `appliedFiles` is refreshed for the same reason:
   * a sibling's partial apply must be visible before this instance decides the rest can
   * go in. A record this process just wrote is left alone.
   *
   * @param {object} record - the held record to refresh in place.
   * @returns {void}
   */
  #refreshAppliedAt(record) {
    const needsAppliedAt = record.appliedAt === null || record.appliedAt === undefined
    const needsAppliedFiles = !Array.isArray(record.appliedFiles) || record.appliedFiles.length === 0
    if (!needsAppliedAt && !needsAppliedFiles) return
    if (typeof record.metaPath !== 'string') return
    try {
      const onDisk = JSON.parse(readFileSync(record.metaPath, 'utf8'))
      if (needsAppliedAt && onDisk?.appliedAt !== null && onDisk?.appliedAt !== undefined) record.appliedAt = onDisk.appliedAt
      if (Array.isArray(onDisk?.appliedFiles) && onDisk.appliedFiles.length > 0) {
        // The on-disk record is authoritative: a sibling may have applied a file this
        // instance has not seen. The union keeps anything this instance recorded first.
        record.appliedFiles = [...new Set([...(record.appliedFiles ?? []), ...onDisk.appliedFiles])].sort()
      }
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
    slot.baseParent = null
    slot.scope = undefined
    slot.repoDir = undefined
    slot.task = undefined
  }

  /**
   * Remove the slot trees and every orphan they left in place. Stored patches stay: an
   * apply may still be coming.
   *
   * A stable slot is not removed: its directory is the path the next server of this root
   * claims, and the `.flash-cache` in it is what makes that server's first build warm. Only
   * the copy is emptied, and the lock is removed last, so the server after this one finds a
   * free slot with a cache in place. A tree that cannot stay where it is — a retired tree,
   * and a slot that retired its directory away — is removed whole, and its cache is moved into
   * the store first when it may still be read.
   *
   * A deferred start-up sweep still in flight stops at its next yield point: the event
   * loop is single-threaded, so setting the flag here is enough to keep it from starting
   * another slot or owner after this method returns. A background removal of a tree that
   * was already renamed to `trash-*` is left to finish on its own; it only deletes, and
   * the next sweep adopts it if this process exits first.
   */
  close() {
    // A second close has nothing left to give back, and the locks of a slot already emptied
    // are gone: without this, the ownership check below would report a takeover of our own
    // finished work.
    if (this.closed) return
    this.closed = true
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer)
    const policy = this.#cachePolicy()
    const owner = { pid: process.pid, instance: this.instance, command: this.commandLine }
    // A slot this pool no longer holds is not ours to empty, not ours to take the cache out
    // of, and not ours to unlock: another server has claimed the number and may be writing
    // into the tree right now. The stable layout writes locks; a configured state directory
    // has none and its slots are this pool's alone.
    const stillOurs = (dir) => !this.stableSlots || holdsSlotLock(dir, owner)
    for (const slot of this.slots) {
      const ownsDir = stillOurs(slot.dir)
      if (!ownsDir) this.log(`close: not touching ${slot.dir}: another server took the slot over`)
      // A cache is no longer lost with its tree: the next server on this root claims it from
      // the store. A rename that fails is logged and the cache goes with the tree as before.
      if (policy !== undefined && ownsDir) {
        // The rule of `#storeRetiredCache`: a cache is moved only when nothing of the slot can
        // still be writing into it. A retired tree whose runtimes were not shut down means a
        // process of this slot may be alive, and a running call holds the slot's own tree.
        const alive = slot.orphans.filter((orphan) => !slot.stoppedOrphans.has(orphan))
        // A slot that still sits at the path the next server claims (`slots/<n>`) keeps its
        // cache there: moving it out and back would be a rename for nothing, and a cached
        // build is only warm when it is at the path it was compiled for. A slot that retired
        // its directory away, like the older layout's slot, is removed whole, so its cache
        // goes into the store first.
        if (this.#cacheStaysInPlace(slot)) {
          // Nothing to move. The cache is the point of the stable path.
        } else if (alive.length > 0 || slot.busy) {
          const why = slot.busy ? `a call still holds slot ${String(slot.id)}` : `its runtimes were not shut down when ${alive.join(', ')} was retired`
          this.log(`close: not storing the build cache of ${slot.dir}: ${why}`)
        } else {
          putCacheInStore(join(slot.dir, SLOT_CACHE), policy.storeDir, { rename: policy.rename, log: this.log })
        }
      }
      if (ownsDir) {
        if (this.#cacheStaysInPlace(slot)) {
          // The copy goes, the cache stays, and the directory itself stays with it. The
          // directory is emptied only while this pool still holds the lock checked above.
          try {
            emptyDirectory(slot.dir)
          } catch (error) {
            this.log(`close: could not empty ${slot.dir} (${messageOf(error)}); the next call in this slot empties it`)
          }
          releaseOwnSlotLock(slot.dir, owner, this.log)
        } else {
          rmSync(slot.dir, { recursive: true, force: true })
          if (this.stableSlots) {
            releaseOwnSlotLock(slot.dir, owner, this.log)
            rmSync(liveOrphanMarker(slot.dir), { force: true })
          }
        }
      }
      for (const orphan of slot.orphans) {
        if (!stillOurs(orphan)) {
          this.log(`close: not touching ${orphan}: another server took the retired tree over`)
          continue
        }
        if (policy !== undefined) {
          if (slot.stoppedOrphans.has(orphan)) putCacheInStore(join(orphan, SLOT_CACHE), policy.storeDir, { rename: policy.rename, log: this.log })
          else this.log(`close: not storing the build cache of retired tree ${orphan}: its runtimes were not shut down when it was retired`)
        }
        rmSync(orphan, { recursive: true, force: true })
        rmSync(liveOrphanMarker(orphan), { force: true })
        if (this.stableSlots) releaseOwnSlotLock(orphan, owner, this.log)
      }
    }
    // Belt and braces: everything above lives under `slots`, so this also catches any
    // orphan a slot no longer names. The stable layout's own slots are not under this
    // directory, and are deliberately left in place.
    rmSync(join(this.stateDir, 'slots'), { recursive: true, force: true })
    this.#trimCacheStore()
  }
}
