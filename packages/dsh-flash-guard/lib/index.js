/**
 * `flash-guard` — the deterministic wall a flash-service worker runs behind.
 *
 * Why this row exists
 * -------------------
 * The MCP caller's permission system can only see the `flash_task` / `flash_batch`
 * call, so the scope it authorizes is that call. Everything a worker does inside
 * the call is invisible to it. This row is what makes the inside of the call
 * deterministic: it reads the path and the command a tool is about to run, never
 * the prose around it, so no prompt can talk it out of a denial.
 *
 * Model — secrets, state, catastrophic shapes
 * -------------------------------------------
 *   secrets (read AND write denied)  credential files and directories: the `.env`
 *                                    family (minus templates), `.netrc`, `.pgpass`,
 *                                    `.git-credentials`, and `~/.ssh`, `~/.aws`,
 *                                    `~/.gnupg`, `~/.dsh`. Reading is denied too:
 *                                    the file sandbox confines *writes*, so a read
 *                                    of a credential file is exactly the hole this
 *                                    closes, and exfiltration needs no write.
 *   state (write denied, read allowed) `.git` and the tool/shell config files
 *                                    (`.npmrc`, `.mcp.json`, `.gitconfig`, rc files).
 *                                    Reads stay open because `git status` reads
 *                                    `.git`, and a worker that cannot run git is
 *                                    not a worker.
 *   catastrophic command shapes        `rm`/`rmdir` of a filesystem root, a top-level
 *                                    directory, a home directory, the service root or
 *                                    one of its ancestors, and a bare glob at the
 *                                    root; a redirect into a protected target; and a
 *                                    small destructive-git set.
 *
 * The seam, and why not `fs/write-intent`
 * ---------------------------------------
 * This row wraps tool dispatch (`tools/execute`), which every call passes through
 * and which hands it the parsed arguments and the caller's agent. The `fs/*-intent`
 * waterfall is NOT used: the shipped observation policy registers there and returns
 * without calling `next()`, so a later listener on that waterfall can be skipped
 * entirely. A dispatch wrapper cannot be skipped by a peer row — it either calls
 * `next()` or runs no body at all.
 *
 * What this is not
 * ----------------
 * Not a sandbox, and not a shell parser. The file and shell sandboxes stay the
 * enforcement boundary; this is a circuit breaker for the few shapes whose damage
 * is unbounded or unrecoverable. Command analysis is deliberately conservative: a
 * command that merely *mentions* a secret path is denied too, because a wall may
 * over-refuse and must not under-refuse. It makes no claim about the rest of the
 * shell language, which is what the opt-in judge layer is for.
 *
 * @module dsh-flash-guard
 */

import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

/** Cordis plugin name. */
const name = 'flash-guard'

/**
 * The one hard dependency: the tool registry whose dispatch this row wraps.
 * @type {string[]}
 */
const inject = ['tools']

/** Stable error code on every denial, so a caller can route on it without prose. */
const FLASH_GUARD_DENIED = 'FLASH_GUARD_DENIED'

/** Denial reasons. Each names the rule that fired, not the file that was touched. */
const REASON = Object.freeze({
  SECRET: 'PROTECTED_SECRET',
  STATE: 'PROTECTED_STATE',
  CRITICAL_RM: 'CRITICAL_PATH',
  DESTRUCTIVE_GIT: 'DESTRUCTIVE_GIT',
  // Its own reason, not CRITICAL_PATH: `> /tmp/out.log` and `rm -rf /` are both
  // refused, but a caller branching on the code has to be able to tell "you may not
  // leave the workspace" from "you are about to delete everything".
  OUTSIDE_WORKSPACE: 'OUTSIDE_WORKSPACE',
  // The guard itself failed. A throw used to escape `tools/execute` as an opaque
  // transport error; it is caught and denied instead, because a wall that cannot
  // classify a call must not let it run.
  GUARD_ERROR: 'GUARD_ERROR',
})

/** Tools whose command string carries a shell program. */
const SHELL_TOOL = /^(bash|sh|shell|exec|run_command|terminal|pwsh|powershell|cmd)$/i
/** Tools that mutate a path named in their arguments. */
const MUTATING_TOOL = /(write|edit|patch|create|delete|remove|rename|move|mkdir|touch|append|truncate|chmod|chown|copy|link|symlink)/i
/** Tools that only read a path named in their arguments. */
const READ_ONLY_TOOL = /^(read|read_file|read_text|glob|grep|list|list_dir|ls|stat|find|search|head|tail|cat|view|open|job_output|job_list)$/i
/** Argument names that name a filesystem target. */
const PATH_ARGUMENT = /^(file_?path|path|target|target_?path|paths|files?|filename|dest|destination|source|src|dir|directory|from|to)$/i

/** `.env` and its variants, but not `.envrc` (a state file, not a secret). */
const ENV_FILE = /^\.env(\..+)?$/
/**
 * A `~`, `$HOME`, or `${HOME}` prefix a POSIX shell expands. Only a slash (or the
 * end of the word) may follow it: on a POSIX shell `~\f` is the literal name `~\f`
 * in the workspace, not the home folder, because a backslash is not a separator.
 */
const POSIX_HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/
/** A `~`, `$HOME`, or `${HOME}` prefix. A backslash counts: PowerShell spells the rest of a home path that way. */
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=[\\/]|$)/
/** The home spellings PowerShell adds. Its variable names are case-insensitive, unlike bash's. */
const POWERSHELL_HOME_PREFIX = /^(?:\$env:USERPROFILE|\$\{env:USERPROFILE\})(?=[\\/]|$)/i
/** A drive-absolute Windows path: `C:\…` or `C:/…`. PowerShell reads both separators. */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/
/** A UNC path: `\\server\share`. */
const WINDOWS_UNC_PATH = /^\\\\[^\\/]+[\\/][^\\/]+/
/** Shell control operators that end one simple command. */

const DEFAULT_SETTINGS = Object.freeze({
  /**
   * The root this wall protects when an agent reports no cwd of its own. Empty
   * means the process working directory, which the SDK sets to the service root.
   * Set it explicitly only when the plugin runs outside that arrangement.
   */
  root: '',
  /** Path segments no tool may mutate, anywhere. Reading stays allowed. */
  protectedSegments: ['.git'],
  /** File names no tool may mutate, anywhere. Reading stays allowed. */
  protectedFileNames: [
    '.envrc',
    '.npmrc',
    '.mcp.json',
    '.gitconfig',
    '.bashrc',
    '.bash_profile',
    '.profile',
    '.zshrc',
    '.zprofile',
  ],
  /**
   * File names no tool may read or mutate, anywhere. `.npmrc` and `.mcp.json` are
   * here rather than in the state list because they hold registry tokens and
   * server credentials: the file is a secret, not merely repository state.
   */
  secretFileNames: ['.netrc', '.pgpass', '.git-credentials', '.npmrc', '.mcp.json', '.pypirc', '.htpasswd', '.dockercfg'],
  /** Whether the `.env` family counts as secret. */
  protectEnvFiles: true,
  /** `.env` names that are templates rather than secrets. */
  envFileExceptions: ['.env.example', '.env.sample', '.env.template', '.env.dist'],
  /**
   * Home-relative credential paths no tool may read or mutate. The agent-tool
   * directories belong here as much as the cloud ones: they hold OAuth tokens for
   * the very coding agents this service is driven by.
   */
  homeProtectedPaths: [
    '.ssh', '.aws', '.gnupg', '.dsh', '.config/gh', '.config/gcloud', '.docker/config.json',
    '.codex', '.claude', '.claude.json', '.config/claude', '.kube', '.azure', '.terraform.d',
    '.config/op', '.cargo/credentials', '.cargo/credentials.toml', 'Library/Keychains',
    '.bash_history', '.zsh_history', '.python_history', '.node_repl_history',
  ],
  /** Whether destructive git worktree/history commands are refused. */
  blockDestructiveGit: true,
  // A mutation may not leave the workspace. This is the rule the live run needed: the
  // sandbox's writable set is wider than the root, so a worker could delete a file in
  // the caller's tree by naming its absolute path.
  fenceMutations: true,
})

/**
 * Read a string array from config, falling back when it is not one.
 * @param {unknown} value - candidate.
 * @param {string[]} fallback - default list.
 * @returns {string[]} the resolved list.
 */
function stringArrayOr(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const kept = value.filter((entry) => typeof entry === 'string' && entry.length > 0)
  return kept.length === 0 ? [...fallback] : kept
}

/**
 * Read a boolean from config, falling back when it is not one.
 * @param {unknown} value - candidate.
 * @param {boolean} fallback - default.
 * @returns {boolean} the resolved value.
 */
function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Merge row config over the defaults. Config is read defensively: this file is
 * copied into a profile, where no schema validates it before `apply` runs.
 * @param {object} [config] - row config.
 * @returns {object} resolved settings.
 */
function resolveSettings(config = {}) {
  const source = config === null || typeof config !== 'object' ? {} : config
  return {
    root: typeof source.root === 'string' && source.root !== '' ? source.root : DEFAULT_SETTINGS.root,
    protectedSegments: stringArrayOr(source.protectedSegments, DEFAULT_SETTINGS.protectedSegments),
    protectedFileNames: stringArrayOr(source.protectedFileNames, DEFAULT_SETTINGS.protectedFileNames),
    secretFileNames: stringArrayOr(source.secretFileNames, DEFAULT_SETTINGS.secretFileNames),
    protectEnvFiles: booleanOr(source.protectEnvFiles, DEFAULT_SETTINGS.protectEnvFiles),
    envFileExceptions: stringArrayOr(source.envFileExceptions, DEFAULT_SETTINGS.envFileExceptions),
    homeProtectedPaths: stringArrayOr(source.homeProtectedPaths, DEFAULT_SETTINGS.homeProtectedPaths),
    blockDestructiveGit: booleanOr(source.blockDestructiveGit, DEFAULT_SETTINGS.blockDestructiveGit),
    fenceMutations: booleanOr(source.fenceMutations, DEFAULT_SETTINGS.fenceMutations),
  }
}

/**
 * The path segments of a path, in both separator flavours.
 * @param {string} value - a path.
 * @returns {string[]} its segments.
 */
function segmentsOf(value) {
  return value.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== '.')
}

/**
 * The final segment of a path.
 * @param {string} value - a path.
 * @returns {string} its last segment, or the whole value when it has none.
 */
function basenameOf(value) {
  const segments = segmentsOf(value)
  return segments.length === 0 ? value : segments[segments.length - 1]
}

/**
 * Expand a home prefix using the process home directory.
 *
 * The spellings a POSIX shell understands are expanded always. The PowerShell
 * spellings — `$env:USERPROFILE`, and a `~\f` whose backslash really is a separator —
 * are expanded only when the command line is a PowerShell (or `cmd`) one, or when the
 * path itself is Windows-spelled. Expanding them for a POSIX `bash` line made
 * `echo x > $env:USERPROFILE\notes.txt` (which bash writes as a file literally named
 * that, inside the workspace) look like a write into the home folder.
 *
 * @param {string} value - a path that may be home-relative.
 * @param {string} home - the home directory, or an empty string when unknown.
 * @param {boolean} [powershell] - whether the caller reads the path the way PowerShell does.
 * @returns {string} the expanded path.
 */
function expandHome(value, home, powershell = false) {
  if (home.length === 0) return value
  if (powershell) {
    if (HOME_PREFIX.test(value)) return value.replace(HOME_PREFIX, home)
    if (POWERSHELL_HOME_PREFIX.test(value)) return value.replace(POWERSHELL_HOME_PREFIX, home)
    return value
  }
  if (POSIX_HOME_PREFIX.test(value)) return value.replace(POSIX_HOME_PREFIX, home)
  return value
}

/**
 * Whether a path is spelled the way Windows spells one.
 * @param {string} value - a path.
 * @returns {boolean} true for a drive-absolute or UNC path.
 */
function isWindowsPath(value) {
  return typeof value === 'string' && (WINDOWS_DRIVE_PATH.test(value) || WINDOWS_UNC_PATH.test(value))
}

/**
 * Normalise a Windows path: both separators, `.`/`..`, and a root that `..` cannot pass.
 *
 * The guard has to read PowerShell command lines on every host, and `node:path` on a
 * POSIX host neither treats `C:\…` as absolute nor collapses `..` in it. Resolving the
 * path the way PowerShell would keeps a `C:\Users\…` write fenced even when the suite
 * that exercises it runs on Linux, and keeps `src\a.txt` inside a Windows workspace
 * instead of turning it into a path below the test process.
 *
 * Case is preserved here; the comparison folds it, because PowerShell's filesystem is
 * case-insensitive.
 *
 * @param {string} value - a drive-absolute or UNC path, or a path joined with one.
 * @returns {string} the normalised path, with no trailing separator unless it is a root.
 */
function normalizeWindowsPath(value) {
  const unified = value.replace(/\//g, '\\')
  const unc = unified.startsWith('\\\\')
  const parts = []
  // `C:\` and `\\server\share` are roots a `..` cannot climb above.
  const rootDepth = unc ? 2 : 1
  for (const segment of (unc ? unified.replace(/^\\+/, '') : unified).split('\\')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length > rootDepth) parts.pop()
      continue
    }
    parts.push(segment)
  }
  if (parts.length === 0) return unc ? '\\\\' : unified.slice(0, 2) + '\\'
  if (unc) return `\\\\${parts.join('\\')}`
  const [drive, ...rest] = parts
  return rest.length === 0 ? `${drive}\\` : `${drive}\\${rest.join('\\')}`
}

/**
 * Normalise a POSIX-spelled absolute path without the host's `node:path` flavour.
 *
 * A `bash.exe -c` payload run from a Windows cwd names POSIX paths, and `path.normalize`
 * on a Windows host would turn `/dev/null` into `\dev\null` — losing the device
 * allowance on that host and keeping it on this one. The guard must give the same
 * verdict wherever it runs, so the POSIX spelling is collapsed here.
 *
 * @param {string} value - a path that begins with `/`.
 * @returns {string} the normalised path, with a root `/` when nothing is left.
 */
function normalizePosixPath(value) {
  const parts = []
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length > 0) parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.length === 0 ? '/' : `/${parts.join('/')}`
}

/**
 * Strip the trailing separators from a resolved path, keeping a root's own separator.
 *
 * `path.normalize` keeps one trailing separator (`/a/b/` normalises to `/a/b/`), so
 * `rm -rf <workspace>/` resolved to a path that was not equal to the workspace it
 * removes, and the rule against deleting the service root never fired. The two
 * spellings whose trailing separator is part of the path — a bare `/` and a Windows
 * drive root like `C:\` — are left alone; `C:` without it is a drive-relative path.
 *
 * @param {string} value - a resolved path, possibly ending in separators.
 * @returns {string} the same path without trailing separators, unless it is a root.
 */
function stripTrailingSeparators(value) {
  let end = value.length
  while (end > 1 && (value[end - 1] === '/' || value[end - 1] === sep)) end -= 1
  if (/^[A-Za-z]:$/.test(value.slice(0, end))) return value.slice(0, end + 1)
  return value.slice(0, end)
}

/**
 * Resolve a PowerShell path that begins with one separator against the cwd's root.
 *
 * In PowerShell `\Users\someone\f.txt` (and `/Users/someone/f.txt`) is not relative to
 * the working directory: it names the root of the drive the cwd is on, so from
 * `C:\work\repo` it is `C:\Users\someone\f.txt`. A UNC path begins with two
 * separators and a drive-relative `C:foo` names neither, so both are left to the
 * existing rules.
 *
 * A cwd under a UNC share roots the path at the share, not at `\\`: from
 * `\\server\share\repo`, `\Users\x` is `\\server\share\Users\x`, because `\\` alone
 * names no server.
 *
 * Only a PowerShell (or `cmd`) line is read this way. A `bash.exe -c` payload on the
 * same cwd names POSIX paths, where a leading `/` is the shell's own root and
 * `/dev/null` is the device it says it is.
 *
 * @param {string} value - the expanded path token.
 * @param {string} cwd - the directory the command runs in.
 * @returns {string | undefined} the rooted path, or undefined when the spelling is not
 *   a single leading separator below a Windows cwd.
 */
function driveRootedPath(value, cwd) {
  if (!isWindowsPath(cwd) || value.length === 0) return undefined
  if (value[0] !== '\\' && value[0] !== '/') return undefined
  if (value.length > 1 && (value[1] === '\\' || value[1] === '/')) return undefined
  const share = WINDOWS_UNC_PATH.exec(cwd)
  const root = share === null ? cwd.slice(0, 2) : share[0]
  return normalizeWindowsPath(`${root}${value.replace(/^\//, '\\')}`)
}

/**
 * Resolve a candidate path against a working directory when one is known, reading
 * Windows spellings the way PowerShell does.
 * A relative path with no known cwd stays relative; the segment and basename
 * rules below still apply to it, which is why the result is usable either way.
 * @param {string} value - candidate path.
 * @param {string} cwd - the caller's working directory, or an empty string.
 * @param {string} home - the home directory, or an empty string.
 * @param {boolean} [powershell] - whether the path is read the way PowerShell does; a
 *   Windows path, or a cwd on Windows, is enough to decide that on its own.
 * @returns {string} an absolute path when it could be resolved, else the expanded value.
 */
function resolveTarget(value, cwd, home, powershell = false) {
  const windowsFlavour = powershell === true || isWindowsPath(value) || isWindowsPath(cwd)
  const expanded = expandHome(value, home, windowsFlavour)
  if (isWindowsPath(expanded)) return stripTrailingSeparators(normalizeWindowsPath(expanded))
  // A single leading separator is a root spelling only in PowerShell and `cmd`.
  if (powershell === true) {
    const rooted = driveRootedPath(expanded, cwd)
    if (rooted !== undefined) return stripTrailingSeparators(rooted)
  }
  if (isAbsolute(expanded)) {
    // A POSIX-absolute path below a Windows cwd is a `bash.exe -c` payload: collapse it
    // with POSIX rules so the same command is the same path on every host.
    if (powershell !== true && isWindowsPath(cwd) && expanded.startsWith('/')) {
      return stripTrailingSeparators(normalizePosixPath(expanded))
    }
    return stripTrailingSeparators(normalize(expanded))
  }
  if (cwd.length === 0) return stripTrailingSeparators(expanded)
  if (isWindowsPath(cwd)) return stripTrailingSeparators(normalizeWindowsPath(`${cwd}\\${expanded}`))
  return stripTrailingSeparators(normalize(resolve(cwd, expanded)))
}

/**
 * How many missing ancestors `canonicalPath` walks up before it stops.
 *
 * Every step costs one `existsSync`, and a path is only ever created inside a
 * directory that already exists, so a tail of this many missing components cannot be
 * a real workspace path. The cap is what makes the cost of canonicalising a very deep
 * path bounded: without it a `mkdir -p` of tens of thousands of segments spent a
 * filesystem call per level on the far side of a path no file will ever reach.
 */
const CANONICAL_TAIL_LIMIT = 256

/**
 * Canonicalise an absolute path through its nearest existing ancestor.
 *
 * `path.normalize` collapses `.` and `..` but never resolves a symlink, so two
 * spellings of one directory (`/var/...` and `/private/var/...` on macOS, or a
 * disposable tree reached through a symlinked TMPDIR) compared as different paths.
 * The fence therefore refused a worker its own workspace. `realpathSync` is applied
 * to the longest existing prefix and the non-existent tail is re-appended, exactly
 * as the service's `#realPath` does, because a candidate that does not exist yet
 * must still be fenced by the ancestor it will be created under.
 *
 * The tail is collected with `push` and joined after one `reverse`: `unshift` on
 * every level copied the whole array, which made a 30,000-segment path quadratic and
 * a megabyte-long one effectively endless.
 *
 * A relative path is returned unchanged: it has no filesystem identity without the
 * working directory it was resolved against, and every caller here has already
 * resolved it against a known cwd when one existed.
 *
 * @param {string} value - an absolute path that may be spelled through symlinks.
 * @returns {string} its canonical form, or the input when it could not be resolved.
 */
function canonicalPath(value) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) return value
  let current = value
  const tail = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return value
    // Past the cap the walk is not finding an existing ancestor anyway; compare the
    // path as spelled rather than spend a syscall per level of an impossible path.
    if (tail.length >= CANONICAL_TAIL_LIMIT) return value
    tail.push(current.slice(parent.length).replace(/^[/\\]/, ''))
    current = parent
  }
  try {
    const real = realpathSync.native(current)
    return tail.length === 0 ? real : join(real, ...tail.reverse())
  } catch {
    // A path that exists but cannot be realpath'd is compared as spelled; the wall
    // must not turn a permission error into a silent allowance.
    return value
  }
}

/**
 * Whether `child` is `parent` itself or below it.
 * @param {string} child - candidate descendant.
 * @param {string} parent - candidate ancestor.
 * @returns {boolean} true when child is at or under parent.
 */
function isAtOrUnder(child, parent) {
  if (parent.length === 0) return false
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * Whether `child` is `parent` itself or below it, folding case for Windows paths.
 *
 * PowerShell's filesystem is case-insensitive and accepts both separators, so
 * `C:\Work\Repo\src\a.txt` is inside `c:\work\repo` while a plain `startsWith` on a
 * POSIX host calls it outside. The extra branch only applies when both sides are
 * spelled as Windows paths; a POSIX comparison is left exactly as it was.
 *
 * @param {string} child - candidate descendant.
 * @param {string} parent - candidate ancestor.
 * @returns {boolean} true when child is at or under parent.
 */
function isAtOrUnderPath(child, parent) {
  if (isAtOrUnder(child, parent)) return true
  if (!isWindowsPath(child) || !isWindowsPath(parent)) return false
  const fold = (value) => normalizeWindowsPath(value).replace(/\\+$/, '').toLowerCase()
  const beneath = fold(child)
  const above = fold(parent)
  return beneath === above || beneath.startsWith(above.endsWith('\\') ? above : `${above}\\`)
}

/**
 * Whether two resolved paths name the same location, folding case for Windows paths.
 *
 * The sibling rule in `isOutsideRootCritical` compared parent directories with `===`,
 * so `C:\Work\repo-other` was not a sibling of `C:\work\repo` on a POSIX host while it
 * was on Windows. The fold is only applied when both sides are Windows-spelled; a
 * POSIX comparison stays exact.
 *
 * @param {string} left - one resolved path.
 * @param {string} right - another resolved path.
 * @returns {boolean} true when both name the same location.
 */
function samePath(left, right) {
  if (left === right) return true
  if (!isWindowsPath(left) || !isWindowsPath(right)) return false
  const fold = (value) => normalizeWindowsPath(value).replace(/\\+$/, '').toLowerCase()
  return fold(left) === fold(right)
}

/**
 * Whether a resolved path is one of the home-relative credential paths.
 * @param {string} resolved - the resolved path.
 * @param {string} home - the home directory, or an empty string.
 * @param {object} settings - resolved settings.
 * @returns {boolean} true when the path is a protected credential location.
 */
function isHomeProtected(resolved, home, settings) {
  if (home.length === 0) return false
  return settings.homeProtectedPaths.some((relative) => isAtOrUnderPath(resolved, join(home, relative)))
}

/**
 * Classify one path access. Secrets are protected against reading and writing;
 * state files are protected against writing only.
 * @param {object} input - `{path, cwd, home, settings, mutate, fence, powershell}`.
 * @returns {{reason: string, detail: string} | undefined} the verdict, or undefined to allow.
 */
function classifyPathAccess(input) {
  const { path: candidate, cwd = '', home = '', settings, mutate, fence = '', powershell = false } = input
  if (typeof candidate !== 'string' || candidate.length === 0) return undefined
  const resolved = resolveTarget(candidate, cwd, home, powershell === true)
  const base = basenameOf(resolved)
  // The shell expands a glob before the program ever sees it, so `.env*` and `.en?`
  // reach the same file as `.env` while reading as an ordinary pattern to a name
  // check.
  const unglobbed = base.replace(/[*?[\]]/g, '')
  // PowerShell's filesystem folds case for every name, not only for path segments, so
  // `.ENV` is the `.env` file and `.NPMRC` the one that holds the registry token. A
  // POSIX shell keeps exact matching: `.ENV` there is an ordinary file.
  const foldNames = powershell === true || isWindowsPath(resolved)
  /** Whether a configured name list contains this file name, folding case when told to. */
  const namesInclude = (list, name) =>
    foldNames ? list.some((entry) => entry.toLowerCase() === name.toLowerCase()) : list.includes(name)
  /** Whether the `.env` name is one of the templates rather than a secret. */
  const envException = foldNames
    ? settings.envFileExceptions.some((entry) => entry.toLowerCase() === unglobbed.toLowerCase())
    : settings.envFileExceptions.includes(unglobbed)

  if (settings.protectEnvFiles && ENV_FILE.test(foldNames ? unglobbed.toLowerCase() : unglobbed) && !envException) {
    return { reason: REASON.SECRET, detail: `the .env family is secret (${base})` }
  }
  if (namesInclude(settings.secretFileNames, base) || namesInclude(settings.secretFileNames, unglobbed)) {
    return { reason: REASON.SECRET, detail: `credential file (${base})` }
  }
  if (isHomeProtected(resolved, home, settings)) {
    return { reason: REASON.SECRET, detail: 'credential location' }
  }
  if (!mutate) return undefined
  const segments = segmentsOf(resolved)
  // PowerShell's filesystem is case-insensitive, so `.GIT` is the same directory as
  // `.git` and `Remove-Item -Force .GIT` removes the repository state. A POSIX shell
  // keeps exact matching: `.GIT` there is an ordinary directory.
  for (const protectedSegment of settings.protectedSegments) {
    const matched = foldNames
      ? segments.some((segment) => segment.toLowerCase() === protectedSegment.toLowerCase())
      : segments.includes(protectedSegment)
    if (matched) {
      return { reason: REASON.STATE, detail: `${protectedSegment} holds repository state` }
    }
  }
  if (namesInclude(settings.protectedFileNames, base)) {
    return { reason: REASON.STATE, detail: `${base} configures the tooling` }
  }
  // The fence, kept last so the more specific diagnosis wins: a secret, a state file,
  // or a config name is reported as itself even when it also lies outside the fence.
  // Enforced for mutations, it says a worker may change its own workspace and nothing
  // else. The sandbox is supposed to do this, but its writable temp area is
  // wider than the workspace — a live run deleted a file in the caller's tree through
  // an absolute path, because both the disposable copy and the root happened to live
  // under TMPDIR, which the sandbox allows. Reads are not fenced (toolchains, `/usr`,
  // shared caches), and device paths are not writes at all.
  //
  // Both sides are canonicalised first: the secret/state rules above read the spelled
  // path, but the fence compares filesystem identity. A shell whose cwd is reported
  // through a symlink (`/var/folders/...`) was refused its own tree because the fence
  // held the canonical spelling (`/private/var/folders/...`), or the reverse.
  if (settings.fenceMutations !== false && fence !== '' && !DEVICE_PATH.test(resolved)) {
    const fenceCanonical = canonicalPath(fence)
    const resolvedCanonical = canonicalPath(resolved)
    if (!isAtOrUnderPath(resolvedCanonical, fenceCanonical)) {
      return { reason: REASON.OUTSIDE_WORKSPACE, detail: `mutates ${resolved}, which is outside ${fence}` }
    }
  }
  return undefined
}

/**
 * The index just past the `)` that closes a `$(` command substitution.
 *
 * The lexer has to keep `$( cd .. && touch x )` in one token: splitting inside it at
 * `&&` turned `$(` into a program name and lost the `cd`. Parentheses are counted, and
 * a `)` inside quotes is text rather than the closer. `$(( … ))` arithmetic uses the
 * same counting and is later skipped as a command, because it is not one.
 *
 * @param {string} command - the command line being lexed.
 * @param {number} openAt - index of the `(` after the `$`.
 * @returns {number} the index just past the matching `)`, or the end when unclosed.
 */
function substitutionEnd(command, openAt) {
  let depth = 0
  let quote = ''
  for (let at = openAt; at < command.length; at += 1) {
    const char = command[at]
    if (quote !== '') {
      // Inside double quotes a backslash escapes the next character; inside single
      // quotes it is literal, so only the quote itself ends the quote there.
      if (char === '\\' && quote === '"') {
        at += 1
        continue
      }
      if (char === quote) quote = ''
      continue
    }
    if (char === '\\') {
      at += 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return at + 1
    }
  }
  return command.length
}

/**
 * The index just past the backtick that closes a `` `…` `` command substitution.
 *
 * Kept together for the same reason as `$( … )`: `` `cd .. && touch x` `` used to be
 * split at its spaces and `&&`, so the `cd` was lost.
 *
 * @param {string} command - the command line being lexed.
 * @param {number} openAt - index of the opening backtick.
 * @returns {number} the index just past the closing backtick, or the end when unclosed.
 */
function backtickEnd(command, openAt) {
  for (let at = openAt + 1; at < command.length; at += 1) {
    if (command[at] === '\\') {
      at += 1
      continue
    }
    if (command[at] === '`') return at + 1
  }
  return command.length
}

/**
 * Lex a command line the way a shell does, and split it at its control operators.
 *
 * Both jobs belong to one pass. Quotes decide what is a token, what is a separator,
 * and what is *inside* a token: `cat .en""v` is one token spelling `.env`, and a
 * separator inside quotes — `bash -c "cd .. && rm -rf x"` — is not a separator at
 * all. The previous regex tokenizer did neither, so both spellings walked through
 * as ordinary text, and splitting the raw string first cut quoted deletions in half
 * and then classified the second half against the wrong directory.
 *
 * A newline outside quotes ends a command, as it does in a shell: `/\s/` used to
 * catch it first, so `cd ..\necho x > slot-2/f` was one simple command and the
 * redirect was never classified. A here-doc body is stdin, not a command line, so its
 * lines are skipped to their terminator. Redirect operators keep their spelling
 * (`>|`, `<>`, `&>`, `2>&1`) because splitting them at `|`/`&` turned an operator
 * into an accident. `(`, `)` and a standalone `{`/`}` are metacharacters, so a
 * subshell or a group cannot hide the program behind it.
 *
 * A command substitution — `$( … )` or `` `…` `` — stays one token, quotes and all.
 * It is not a separator of *this* line: its content is classified as its own command
 * line later, which is how `$( cd .. && touch ../x )` stops being invisible.
 *
 * Outside quotes `>` and `<` end the word before them and start the redirect token:
 * `echo hi>../f` used to be one word, so the write was never classified. The two
 * exceptions are a word that is only digits (`2>`, `10>&1`) or `&` (`&>`): there the
 * word is the descriptor the operator belongs to.
 *
 * @param {string} command - the command line.
 * @returns {string[][]} one token array per simple command.
 */
function lexShell(command) {
  const commands = []
  let tokens = []
  let current = ''
  let started = false
  let quote = ''
  /** Here-doc terminators whose bodies have not been read yet, in the order they open. */
  const pending = []
  const endToken = () => {
    if (!started) return
    tokens.push(current)
    current = ''
    started = false
  }
  const endCommand = () => {
    endToken()
    if (tokens.length > 0) commands.push(tokens)
    tokens = []
  }
  /** A metacharacter stands alone, so the program behind it cannot hide in its token. */
  const pushStandalone = (value) => {
    endToken()
    tokens.push(value)
  }
  /** Whether `{`/`}` stands on its own rather than being brace expansion or a word. */
  const standaloneBrace = (at) => {
    const before = at === 0 ? '' : command[at - 1]
    const after = at + 1 >= command.length ? '' : command[at + 1]
    const boundary = (side) => side === '' || /[\s;|&()]/.test(side)
    return boundary(before) && boundary(after)
  }
  /**
   * Read the word after `<<`/`<<-`. Quotes are part of its spelling, not of the
   * terminator it is compared against: `<<'EOF'` still ends at `EOF`. A backslash
   * quotes the character after it, so `<<\EOF` ends at `EOF` too — keeping the
   * backslash meant no line ever matched and every later line was skipped as body,
   * which was a fail-open gate in front of the rest of the command.
   */
  const readTerminator = (from) => {
    let cursor = from
    while (cursor < command.length && (command[cursor] === ' ' || command[cursor] === '\t')) cursor += 1
    let word = ''
    let inner = ''
    while (cursor < command.length) {
      const char = command[cursor]
      if (inner === '') {
        if (char === '\\' && cursor + 1 < command.length) {
          word += command[cursor + 1]
          cursor += 2
          continue
        }
        if (char === '"' || char === "'") {
          inner = char
          cursor += 1
          continue
        }
        if (/[\s;|&<>()]/.test(char)) break
        word += char
        cursor += 1
        continue
      }
      if (char === inner) {
        inner = ''
        cursor += 1
        continue
      }
      word += char
      cursor += 1
    }
    return { word, end: cursor }
  }

  for (let at = 0; at < command.length; at += 1) {
    const char = command[at]
    if (quote !== '') {
      // A newline inside quotes is part of the token, not a separator.
      if (char === quote) quote = ''
      else current += char
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      // An empty quoted argument is still an argument, so the token starts here.
      quote = char
      started = true
      continue
    }
    // A substitution belongs to the word it is written in, and its spaces and
    // operators are its own. Kept verbatim so its content can be classified later.
    if (char === '$' && command[at + 1] === '(') {
      const end = substitutionEnd(command, at + 1)
      current += command.slice(at, end)
      started = true
      at = end - 1
      continue
    }
    if (char === '`') {
      const end = backtickEnd(command, at)
      current += command.slice(at, end)
      started = true
      at = end - 1
      continue
    }
    if (char === '(' || char === ')') {
      pushStandalone(char)
      continue
    }
    if (char === '<' && command[at + 1] === '<' && command[at + 2] !== '<') {
      // `<<`/`<<-` opens a here-document. Its body is stdin, so it is skipped when the
      // line ends instead of being read as further commands.
      const stripTabs = command[at + 2] === '-'
      // A descriptor in front of the operator belongs to the operator: `2<<EOF`.
      const digits = started && /^\d+$/.test(current) ? current : ''
      if (digits !== '') {
        current = ''
        started = false
      }
      pushStandalone(digits + (stripTabs ? '<<-' : '<<'))
      const { word, end } = readTerminator(at + (stripTabs ? 3 : 2))
      tokens.push(word)
      // A malformed `<<` with no word has no terminator to find; the lines after it are
      // then classified as commands, which is the over-refusing side of the doubt.
      if (word.length > 0) pending.push({ terminator: word, stripTabs })
      at = end - 1
      continue
    }
    if (char === '>' || char === '<') {
      // Outside quotes the operator ends the word before it and starts its own token.
      // The descriptor (`2>`, `10>&1`) and `&` (`&>`) belong to the operator instead.
      let prefix = ''
      if (started && /^\d+$/.test(current)) prefix = current
      else if (started && current === '&') prefix = '&'
      if (prefix !== '') {
        current = ''
        started = false
      } else {
        endToken()
      }
      current = prefix + char
      started = true
      const next = command[at + 1] ?? ''
      if (char === '>' && (next === '>' || next === '|' || next === '&')) {
        current += next
        at += 1
      } else if (char === '<' && (next === '<' || next === '&' || next === '>')) {
        current += next
        at += 1
        // `<<<` is a here-string and `<<-` a tab-stripping here-document.
        if (next === '<' && command[at + 1] === '<') {
          current += '<'
          at += 1
        } else if (next === '<' && command[at + 1] === '-') {
          current += '-'
          at += 1
        }
      }
      continue
    }
    if (/\s/.test(char)) {
      if (char !== '\n') {
        endToken()
        continue
      }
      // A newline outside quotes ends a simple command, as it does in a shell. When a
      // here-doc terminator is missing, nothing is skipped: the remaining lines are
      // lexed as commands, which fails closed rather than waving them through.
      endCommand()
      const bodyEnd = skipHeredocBodies(command, at + 1, pending)
      at = (bodyEnd < 0 ? at : bodyEnd) - 1
      pending.length = 0
      continue
    }
    if ((char === '{' || char === '}') && !started && standaloneBrace(at)) {
      pushStandalone(char)
      continue
    }
    // `;;`, `;&` and `;;&` separate the arms of a `case`. A marker of its own is
    // emitted so the classifier can tell an arm's end from the next arm's pattern.
    if (char === ';' && command[at + 1] === ';') {
      let marker = ';;'
      let step = 1
      if (command[at + 2] === '&') {
        marker = ';;&'
        step = 2
      }
      endCommand()
      commands.push([marker])
      at += step
      continue
    }
    const pair = command.slice(at, at + 2)
    if (pair === '&&' || pair === '||') {
      endCommand()
      at += 1
      continue
    }
    if (char === '|') {
      // `>|` is one redirect operator (the noclobber override). The lexer normally
      // consumes it above; this keeps a stray spelling from becoming a command.
      if (started && /(?:\d*)>$/.test(current)) {
        current += '|'
        continue
      }
      endCommand()
      continue
    }
    if (char === '&') {
      // `&` is part of a redirect directly after `>`/`<` (`2>&1`, `0<&3`) or directly
      // before `>` (`&>`, `&>>`); anywhere else it is the background separator.
      if (started && /(?:\d*)?[<>]$/.test(current)) {
        current += '&'
        continue
      }
      if (command[at + 1] === '>') {
        current += '&'
        started = true
        continue
      }
      endCommand()
      continue
    }
    if (char === ';') {
      endCommand()
      continue
    }
    current += char
    started = true
  }
  endCommand()
  return commands
}

/**
 * Skip the body lines of the here-documents still open at a newline.
 *
 * `cat <<EOF > notes.md` starts a body on the next line; those lines are the command's
 * stdin, not commands. A body line `rm -rf /` is text — classifying it as a command
 * refused ordinary work whose example happened to look like a deletion. `<<-` strips
 * leading tabs from its terminator line, exactly as a shell does.
 *
 * A terminator that never arrives is not a licence to skip the rest: the caller then
 * leaves the remaining lines to be classified as commands, because a missing
 * terminator may equally be a malformed command that hides a real one.
 *
 * @param {string} command - the command line being lexed.
 * @param {number} from - index of the first character after the newline.
 * @param {{terminator: string, stripTabs: boolean}[]} heredocs - the open bodies, in order.
 * @returns {number} the index just past the last terminator line, or -1 when one is
 *   missing.
 */
function skipHeredocBodies(command, from, heredocs) {
  let at = from
  for (const { terminator, stripTabs } of heredocs) {
    let found = false
    while (at < command.length) {
      const lineEnd = command.indexOf('\n', at)
      const end = lineEnd < 0 ? command.length : lineEnd
      const line = command.slice(at, end)
      at = lineEnd < 0 ? command.length : lineEnd + 1
      if ((stripTabs ? line.replace(/^\t+/, '') : line) === terminator) {
        found = true
        break
      }
      if (lineEnd < 0) break
    }
    if (!found) return -1
  }
  return at
}

/**
 * Split a shell command line into simple commands at its control operators.
 * @param {string} command - the command string.
 * @returns {string[][]} one token array per simple command.
 */
function splitSimpleCommands(command) {
  return lexShell(command)
}

/**
 * Tokenize one simple command, unwrapping single and double quotes.
 * @param {string} simple - one simple command.
 * @returns {string[]} its tokens.
 */
function tokenize(simple) {
  return lexShell(simple).flat()
}

/**
 * The redirect operators a shell recognises, spelled longest first so that `&>>` is
 * not read as `&>` plus a stray `>`. A leading number is the descriptor the operator
 * applies to.
 */
const REDIRECT_OPERATOR = /^(?:(\d+))?(&>>|&>|<<<|<<-|<<|<&|<>|<|>>|>&|>\||>)/

/**
 * Split one token into the redirect operator it starts with and its attached target.
 *
 * The lexer keeps `>|f`, `<>f`, `&>f` and `2>&1` in one token, because splitting them
 * at `|` or `&` turned an operator into an accident: `>|../f` became a redirect
 * followed by a *command* named `../f`, `<>../f` was read as an input redirect whose
 * target was `>../f`, and `2>&1` became a write to a file called `&1`.
 *
 * @param {string} token - one token of a simple command.
 * @returns {{operator: string, attached: string} | undefined} the operator and the
 *   target written against it, or undefined when the token is not a redirect.
 */
function parseRedirection(token) {
  const match = REDIRECT_OPERATOR.exec(token)
  if (match === null) return undefined
  return { operator: match[2], attached: token.slice(match[0].length) }
}

/**
 * Whether a redirect names a descriptor rather than a file.
 *
 * `2>&1`, `>&2`, `3<&0` and `2>&-` duplicate or close a descriptor. Reading their
 * right-hand side as a path made `2>&1` a write to a file called `&1`, which was
 * harmless inside the fence and hid the descriptor outside it.
 *
 * @param {string} operator - the redirect operator.
 * @param {string} target - the token after the operator.
 * @returns {boolean} true when the target is a descriptor, not a path.
 */
function isDescriptorTarget(operator, target) {
  return (operator === '>&' || operator === '<&') && /^(?:\d+|-)$/.test(target)
}

/**
 * The tokens of one simple command without the redirects the shell owns.
 *
 * A program never sees `> log`, and a program rule that reads "the last argument is
 * the destination" must not take `log` for an argument of `cp`. Redirect targets are
 * classified by the shell rules instead, and `cd` must not take one for its directory.
 *
 * @param {string[]} argv - the tokens of one simple command, program first.
 * @returns {string[]} the tokens the program itself receives.
 */
function shellArguments(argv) {
  const kept = []
  for (let at = 0; at < argv.length; at += 1) {
    const redirect = parseRedirection(argv[at])
    if (redirect === undefined) {
      kept.push(argv[at])
      continue
    }
    if (redirect.attached.length === 0) at += 1
  }
  return kept
}

/**
 * A target the shell expands before the program ever sees it. This wall reads the
 * command line, so `$(pwd)`, `` `pwd` `` and `$VAR` are exactly what it cannot see;
 * deletion of an unknowable target is refused rather than guessed at.
 */
const SHELL_SUBSTITUTION = /\$\(|`|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/

/** Shells whose `-c` payload is another command line, so it is parsed as one. */
const SHELL_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'ash', 'pwsh', 'powershell', 'cmd'])

/**
 * Shells whose command line and paths follow PowerShell's rules: Windows separators,
 * a case-insensitive filesystem, a `-Command`/`/c` payload that runs to the end of
 * the line, and the `$env:USERPROFILE` spelling of home. `cmd` shares the Windows
 * path rules and its `/c` payload rule.
 */
const POWERSHELL_SHELLS = new Set(['pwsh', 'powershell', 'cmd'])

/**
 * The shell a program token names, or an empty string when it names none.
 *
 * A worker on Windows starts Git Bash as a program — `& "C:\Program Files\Git\bin\bash.exe"
 * -c "…"` — so the token is a path, may be quoted, may carry `.exe`, and may be spelled
 * in any case. Reading only the bare lower-case name let every one of those spellings
 * hide a whole command line from the rules.
 *
 * @param {string} program - the program token, as the lexer read it.
 * @returns {string} the bare lower-case shell name, or '' when it is not a shell.
 */
function shellProgramName(program) {
  const base = basenameOf(program).toLowerCase()
  const bare = base.endsWith('.exe') ? base.slice(0, -'.exe'.length) : base
  return SHELL_PROGRAMS.has(bare) ? bare : ''
}

/** Inline-code flags per interpreter, whose payload is scanned for deletion calls. */
const INLINE_CODE_FLAGS = {
  node: ['-e', '--eval', '-p', '--print'],
  python: ['-c'],
  python3: ['-c'],
  perl: ['-e'],
  ruby: ['-e'],
  php: ['-r'],
  bun: ['-e'],
  deno: ['eval'],
}

/**
 * Deletion reachable from inline code. A worker can delete a tree without ever
 * running `rm`, and a wall that only reads argv misses it entirely.
 */
const INLINE_DELETE = /\b(?:rmSync|rmdirSync|unlinkSync|unlink|rmdir|rm|removeSync|rmtree|remove|rm_rf)\s*\(|shutil\.rmtree|FileUtils\.rm_rf/

/**
 * Programs whose arguments name a path they create or overwrite.
 *
 * `touch` is here because it creates every name it is given without reading it, and
 * a name it creates outside the fence is as much a write as a redirect would be.
 * `mkdir`, `rmdir`, `chmod`, `chown`, `chgrp`, `truncate`, `tar`, `unzip` and `patch`
 * joined it because each writes a path named directly in its arguments: a wall that
 * only reads redirects let `mkdir -p ../slot-2/x` and `chmod +x ../slot-2/run.sh`
 * through untouched.
 */
const WRITE_DESTINATION_PROGRAMS = new Set([
  'cp', 'mv', 'install', 'ln', 'rsync', 'tee', 'touch', 'sed', 'dd',
  'mkdir', 'rmdir', 'chmod', 'chown', 'chgrp', 'truncate', 'tar', 'unzip', 'patch',
])

/** Programs that read a file named as an argument. */
const FIND_NARROWING = ['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex']

/**
 * PowerShell cmdlets and aliases that write a path named in their arguments,
 * mapped to the cmdlet whose argument rule they share.
 *
 * The `pwsh`/`powershell` tool hands the guard PowerShell, and a write there is not a
 * redirect with a program in front of it: `Set-Content`, `Out-File`, `New-Item`,
 * `Copy-Item`, `Move-Item`, `Rename-Item` and `Remove-Item` name their target as a
 * parameter value or a positional argument. The map is keyed by lower-case name because
 * PowerShell resolves command names case-insensitively.
 */
const POWERSHELL_WRITE_CMDLET = new Map([
  ['set-content', 'set-content'],
  ['sc', 'set-content'],
  ['add-content', 'add-content'],
  ['ac', 'add-content'],
  ['out-file', 'out-file'],
  ['new-item', 'new-item'],
  ['ni', 'new-item'],
  ['copy-item', 'copy-item'],
  ['cp', 'copy-item'],
  ['copy', 'copy-item'],
  ['move-item', 'move-item'],
  ['mv', 'move-item'],
  ['move', 'move-item'],
  ['rename-item', 'rename-item'],
  ['ren', 'rename-item'],
  ['remove-item', 'remove-item'],
  ['rm', 'remove-item'],
  ['del', 'remove-item'],
  ['ri', 'remove-item'],
  // cmd's and PowerShell's own spellings of the same deletion. Missed here, they fell
  // through to the fence and reported `OUTSIDE_WORKSPACE` where bash's `rm` reports
  // `CRITICAL_PATH` for the very same path.
  ['rd', 'remove-item'],
  ['rmdir', 'remove-item'],
  ['erase', 'remove-item'],
])

/**
 * PowerShell cmdlets and aliases that delete, not merely write. They run through the
 * same classification as `rm`, so `Remove-Item -Recurse -Force C:\Users\someone` and
 * `rm -rf C:\Users\someone` report the same reason.
 */
/** cmd's own deletion commands, whose `/f`, `/q`, `/s` are switches rather than paths. */
const CMD_DELETE_BUILTINS = new Set(['del', 'erase', 'rd', 'rmdir'])

const POWERSHELL_DELETE_CMDLET = new Set(['remove-item', 'rm', 'del', 'ri', 'rd', 'rmdir', 'erase'])

/**
 * PowerShell parameters that take a value.
 *
 * A destination rule reads positional arguments, so a value belonging to another
 * parameter has to be skipped first: `New-Item -ItemType Directory build` writes
 * `build`, not a directory named `Directory`. A parameter not in this set is a switch
 * and consumes nothing, which is the fail-closed side for an unknown spelling.
 */
const POWERSHELL_VALUED_PARAMETER = new Set([
  'path', 'literalpath', 'filepath', 'destination', 'value', 'content', 'itemtype', 'name',
  'newname', 'encoding', 'filter', 'include', 'exclude', 'depth', 'width', 'inputobject',
  'credential', 'stream', 'erroraction', 'errorvariable', 'warningaction', 'warningvariable',
  'outvariable', 'outbuffer', 'pipelinevariable', 'totalcount', 'delimiter',
  // Common parameters whose value is not a path but which still swallow the next token.
  // Unknown, they were read as switches, and their value became a positional argument.
  'progressaction', 'informationaction', 'informationvariable',
])

/** Parameters whose value is a path this cmdlet writes. */
const POWERSHELL_PATH_PARAMETER = new Set(['path', 'literalpath', 'filepath', 'destination'])

/**
 * The `.NET` file-writing calls PowerShell can reach without a cmdlet.
 *
 * `[System.IO.File]::WriteAllText("C:\…\f", "x")` writes a literal path with no
 * redirect and no cmdlet, so neither rule above can see it. Only the path argument is
 * read, and only when it is written as a literal: a variable is placed the way an
 * unresolvable bash path is.
 */
const DOTNET_FILE_WRITE = /^\[(?:System\.)?IO\.File\]::(?:WriteAllText|WriteAllLines|WriteAllBytes|AppendAllText|AppendAllLines|AppendAllBytes)$/i

/**
 * The same `.NET` call found anywhere inside a token.
 *
 * `$null=[System.IO.File]::WriteAllText("…", "x")` glues the call to the assignment, and
 * the lexer keeps `$null=[System.IO.File]::WriteAllText` as one token because `=` is
 * not a separator. A scan that only matched a whole token therefore never saw the
 * write. The call is the part after `=`, `(`, `;` or `{`; the path is still the token
 * the call's parenthesis is followed by, so only the recognition changes.
 */
const DOTNET_FILE_WRITE_CALL = /\[(?:System\.)?IO\.File\]::(?:WriteAllText|WriteAllLines|WriteAllBytes|AppendAllText|AppendAllLines|AppendAllBytes)/i

/**
 * Program prefixes that merely wrap the real program. `exec` belongs here because
 * `exec bash -c "…"` runs `bash`, and an `exec` with nothing but a redirect still
 * belongs to the simple command whose redirects count.
 */
const PREFIX_PROGRAMS = new Set([
  'sudo', 'command', 'env', 'time', 'nohup', 'xargs', 'exec',
  // Wrappers that run the real program a few arguments later. Each was a hole of the
  // same shape: `timeout 5 rm -rf /` was read as a command named `5` (or `timeout`),
  // so the deletion behind it was never classified at all.
  'timeout', 'nice', 'ionice', 'stdbuf', 'watch', 'caffeinate', 'chronic', 'unbuffer',
])

/**
 * Options of a prefix program that swallow the next token. Reading the swallowed
 * token as the program made `env -u NAME rm -rf /` a command named `NAME`, and
 * `time -p npm test` a command named `-p`, so the real program was never classified.
 *
 * Held as a `Map`, not a plain object: every key here comes from the command line,
 * and a plain object would answer `constructor` with a function inherited from
 * `Object.prototype` instead of "no options".
 */
const PREFIX_VALUE_OPTION = new Map([
  ['sudo', new Set(['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-U', '-D', '-R', '-T', '-a'])],
  ['env', new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string'])],
  ['time', new Set(['-o', '--output', '-f', '--format'])],
  ['exec', new Set(['-a'])],
  ['xargs', new Set([
    '-I', '--replace', '-n', '--max-args', '-P', '--max-procs', '-d', '--delimiter',
    '-L', '--max-lines', '-E', '--eof', '-s', '--max-chars', '-a', '--arg-file',
  ])],
  // `timeout -s KILL 5 …` and `timeout -k 2 5 …`: the signal and the kill-after
  // duration are values, and the duration before the program is an operand.
  ['timeout', new Set(['-s', '--signal', '-k', '--kill-after'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['ionice', new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid'])],
  ['stdbuf', new Set(['-i', '-o', '-e', '--input', '--output', '--error'])],
  ['watch', new Set(['-n', '--interval'])],
  ['caffeinate', new Set(['-t', '-w', '--timeout', '--wait'])],
])

/** Programs that read a file named as an argument. */
const FILE_READING_PROGRAMS = new Set([
  'cat', 'bat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'sed', 'awk', 'cut', 'sort', 'uniq',
  'strings', 'xxd', 'od', 'base64', 'gzip', 'tar', 'zip', 'cp', 'mv', 'rm', 'install', 'scp',
  'rsync', 'curl', 'wget', 'python', 'python3', 'node', 'perl', 'ruby', 'openssl', 'git', 'docker',
  // `source`/`.` read a file by name; `read` reads it into a variable. All three
  // make `. .env` an access, which the previous list missed.
  'source', '.', 'read',
])
/** Programs that run inline code, where a path can hide inside a string. */
const INTERPRETER_PROGRAMS = new Set(['python', 'python3', 'node', 'deno', 'bun', 'perl', 'ruby', 'php', 'sh', 'bash', 'zsh', 'pwsh'])
/**
 * A secret named inside inline code. The leading context matters: it keeps the
 * ubiquitous `process.env` — where `.env` follows a word character — from reading
 * as a file access, while `open('.env')` and `~/.ssh/id_rsa` still match.
 */
const INLINE_SECRET = /(?:^|[\s'"=@(/])(\.env(?:\.[\w-]+)?|\.netrc|\.pgpass|\.ssh|\.aws|\.gnupg|\.dsh)(?=[\s'"/)]|$)/g

/** Git subcommands that destroy uncommitted work or history. */
const DESTRUCTIVE_GIT = [
  /^reset$/,
  /^clean$/,
  /^checkout$/,
  /^restore$/,
  /^push$/,
  /^filter-branch$/,
  /^branch$/,
  /^stash$/,
  /^reflog$/,
  /^update-ref$/,
  /^gc$/,
]

/**
 * Device and descriptor paths that a redirect may legitimately name. `> /dev/null`
 * is not a write outside the workspace, it is a write nowhere.
 */
const DEVICE_PATH = /^\/(?:dev\/(?:null|stdout|stderr|stdin|tty|zero|fd\/\d+)|proc\/self\/fd\/\d+)$/

/** A search pattern that reads as credential hunting, not as ordinary reading. */
const SECRET_HUNT = /(?:secret|token|password|passwd|api[_-]?key|private[_-]?key|credential|BEGIN [A-Z ]*PRIVATE KEY)/i

/**
 * Tools whose argument is a patch body rather than a path. Deliberately not
 * `content`: a file *written* through a write tool may itself be a patch fixture,
 * and paths inside that text are data, not accesses.
 */
const PATCH_BODY_ARGUMENT = /^(?:patch|input|diff|body)$/i

/**
 * The directory that contains a path, for either path flavour.
 * `path.dirname` reads a backslash as an ordinary character on a POSIX host, so a
 * Windows target's parent came out as `.` and every such target looked like a sibling
 * of the workspace.
 * @param {string} value - a resolved path.
 * @returns {string} its parent directory.
 */
function parentDirectory(value) {
  if (!isWindowsPath(value)) return dirname(value)
  const normalised = normalizeWindowsPath(value)
  const cut = normalised.lastIndexOf('\\')
  return cut <= 2 ? normalised.slice(0, 3) : normalised.slice(0, cut)
}

/**
 * Whether a target is dangerous precisely because it is adjacent to the workspace:
 * inside the home directory, an ancestor of the root, or a sibling of it. This is
 * the rule that stops `rm -rf ~/Projects/thing` and `rm -rf <root>/..` without
 * making every path outside the root fatal.
 * @param {string} resolved - the canonical target.
 * @param {{root: string, home: string}} context - the fence and the home directory.
 * @returns {boolean} whether the target is adjacent to the workspace.
 */
function isOutsideRootCritical(resolved, context) {
  const { root, home } = context
  if (resolved === '' || root === undefined || root === '') return false
  if (resolved === root || isAtOrUnderPath(resolved, root)) return false
  if (home !== '' && isAtOrUnderPath(resolved, home)) return true
  if (isAtOrUnderPath(root, resolved)) return true
  return samePath(parentDirectory(resolved), parentDirectory(root))
}

/**
 * Whether a `git` invocation is one of the destructive shapes this row refuses.
 * @param {string[]} argv - the tokens of one simple command.
 * @returns {string | undefined} the offending subcommand, or undefined.
 */
function destructiveGitReason(argv) {
  const start = argv.findIndex((token) => basenameOf(token) === 'git')
  if (start < 0) return undefined
  // Global options come before the subcommand and some of them take a value, so
  // `git -C . clean -fdx` has to be read as `clean`, not as `-C`.
  const rest = []
  for (let at = start + 1; at < argv.length; at += 1) {
    const token = argv[at]
    if (token === '-C' || token === '-c' || token === '--git-dir' || token === '--work-tree' || token === '--namespace') {
      at += 1
      continue
    }
    if (token.startsWith('-')) continue
    rest.push(token)
  }
  const subcommand = rest[0]
  if (subcommand === undefined || !DESTRUCTIVE_GIT.some((pattern) => pattern.test(subcommand))) return undefined
  const joined = argv.slice(start).join(' ')
  if (subcommand === 'reset' && !/--hard|--merge|--keep/.test(joined)) return undefined
  if (subcommand === 'clean' && !/-[a-z]*[fdx]/.test(joined)) return undefined
  if (subcommand === 'push' && !/(?:--force(?:-with-lease)?|-f\b|\s\+\S)/.test(joined)) return undefined
  if (subcommand === 'checkout' && !/\s(?:\.|--\s+\.|\*)/.test(`${joined} `)) return undefined
  if (subcommand === 'restore' && !/\s(?:\.|--\s+\.)/.test(`${joined} `)) return undefined
  if (subcommand === 'branch' && !/(?:-D\b|--delete\s+--force|-d\s+-f)/.test(joined)) return undefined
  if (subcommand === 'stash' && !/^(?:drop|clear)$/.test(rest[1] ?? '')) return undefined
  if (subcommand === 'reflog' && !/^expire$/.test(rest[1] ?? '')) return undefined
  if (subcommand === 'update-ref' && !/(?:-d\b|--delete)/.test(joined)) return undefined
  if (subcommand === 'gc' && !/--prune=(?:now|all)/.test(joined)) return undefined
  return subcommand
}

/**
 * An assignment word: `NAME=value`. A shell strips these before the program runs, so
 * `FOO=1 rm -rf ../outside` runs `rm`, not a program called `FOO=1`.
 */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Split a program's arguments into its operands and the values of its options.
 *
 * A short cluster (`-rf`) is a flag, while an option that takes a value either carries
 * it (`--date=…`, `-d2020-01-01`) or swallows the next token (`-d 2020-01-01`).
 * Reading a swallowed token as an operand is exactly how `touch -r /etc/hosts a.txt`
 * came to be refused: the reference file was taken for a destination.
 *
 * @param {string[]} argv - the program's tokens, program first.
 * @param {object} [rules] - `{valued: Set<string>, aliases: Map<string, string>}`.
 * @returns {{operands: string[], values: Map<string, string[]>}} the operands, and the
 *   values each option spelling was given under its canonical name.
 */
function operandsOf(argv, rules = {}) {
  const valued = rules.valued ?? new Set()
  const aliases = rules.aliases ?? new Map()
  const operands = []
  const values = new Map()
  const remember = (name, value) => {
    if (typeof value !== 'string') return
    const key = aliases.get(name) ?? name
    const known = values.get(key)
    if (known === undefined) values.set(key, [value])
    else known.push(value)
  }
  for (let at = 0; at < argv.length; at += 1) {
    const token = argv[at]
    if (token === '--') {
      for (let rest = at + 1; rest < argv.length; rest += 1) operands.push(argv[rest])
      break
    }
    if (token.length > 1 && token.startsWith('-')) {
      const equals = token.indexOf('=')
      if (equals > 0) {
        remember(token.slice(0, equals), token.slice(equals + 1))
        continue
      }
      if (valued.has(token)) {
        remember(token, argv[at + 1])
        at += 1
        continue
      }
      // An attached value: `-d2020-01-01`, `-sSIZE`, `-I{}`.
      const short = token.slice(0, 2)
      if (token.length > 2 && token[1] !== '-' && valued.has(short)) {
        remember(short, token.slice(2))
        continue
      }
      continue
    }
    operands.push(token)
  }
  return { operands, values }
}

/**
 * The paths a `tar` invocation writes and reads.
 *
 * `tar` names its destination in the extract directory, not in its ordinary arguments:
 * `tar -xzf a.tgz -C dir` writes under `dir`, while `tar -czf a.tgz src` writes the
 * archive. Taking the last argument as the destination got both of those wrong — it
 * refused nothing and named a source file as the target.
 *
 * `tar` has three spellings for the same options and all three are read here. The
 * modern cluster (`-xzf`) carries its letters together, an attached value names one
 * option directly (`-C../slot-2`, `-farchive.tar`), and old-style tar accepts the
 * first argument as a cluster without the dash (`tar xfC a.tar dir`). In a cluster the
 * letters that take a value consume the following arguments in order, which is why
 * `xfC` is not read as three flags.
 *
 * @param {string[]} args - the tokens after `tar`, redirects already removed.
 * @returns {{destinations: string[], reads: string[]}} the paths it writes and reads.
 */
function tarPathEffects(args) {
  const destinations = []
  const reads = []
  let extract = false
  let create = false
  let archive
  let directory
  let at = 0
  /**
   * Apply one bundle of tar option letters, consuming the values they take.
   * @param {string} letters - the option letters, in order.
   * @returns {void}
   */
  const consumeLetters = (letters) => {
    for (const letter of letters) {
      if (letter === 'x') extract = true
      else if (letter === 'c') create = true
      else if (letter === 'f') {
        archive = args[at + 1]
        at += 1
      } else if (letter === 'C') {
        directory = args[at + 1]
        at += 1
      } else if (letter === 'b' || letter === 'T' || letter === 'X' || letter === 'g') {
        // Other value-taking letters: their value is not a destination, but skipping it
        // keeps a later `-C` from being read as the value of this one.
        at += 1
      }
    }
  }
  while (at < args.length) {
    const token = args[at]
    // Old-style tar: the first argument may be a cluster of letters with no dash.
    if (at === 0 && /^[A-Za-z]+$/.test(token)) {
      consumeLetters(token)
      at += 1
      continue
    }
    if (token === '--') break
    if (token === '--extract' || token === '--get') {
      extract = true
      at += 1
      continue
    }
    if (token === '--create') {
      create = true
      at += 1
      continue
    }
    if (token.startsWith('--file=')) {
      archive = token.slice('--file='.length)
      at += 1
      continue
    }
    if (token === '--file') {
      archive = args[at + 1]
      at += 2
      continue
    }
    if (token.startsWith('--directory=')) {
      directory = token.slice('--directory='.length)
      at += 1
      continue
    }
    if (token === '--directory') {
      directory = args[at + 1]
      at += 2
      continue
    }
    // An attached value: `-C../slot-2` names the directory, `-farchive.tar` the file.
    if (token.length > 2 && token[0] === '-' && token[1] !== '-') {
      if (token[1] === 'C') {
        directory = token.slice(2)
        at += 1
        continue
      }
      if (token[1] === 'f') {
        archive = token.slice(2)
        at += 1
        continue
      }
    }
    if (/^-[A-Za-z]+$/.test(token)) {
      consumeLetters(token.slice(1))
      at += 1
      continue
    }
    at += 1
  }
  if (typeof directory === 'string' && directory.length > 0 && extract) destinations.push(directory)
  if (typeof archive === 'string' && archive.length > 0) {
    if (extract) reads.push(archive)
    else if (create) destinations.push(archive)
  }
  return { destinations, reads }
}

/**
 * The paths one program writes, and the paths its options only read.
 *
 * Each entry states the program's real destination rule instead of "the last
 * argument": `mkdir -m 755 a b` creates two directories, `chmod +x a` changes the one
 * after its mode, `truncate -r REF a` reads REF and writes a, `tar -xzf a.tgz -C dir`
 * writes under dir, and `patch -o FILE` writes FILE while a `patch` with no `-o`
 * writes the files its input names, all of them under the directory it applies in.
 *
 * @param {string} program - the invoked program.
 * @param {string[]} argv - its tokens, program first.
 * @returns {{destinations: string[], reads: string[]}} the paths it writes and reads.
 */
function programPathEffects(program, argv) {
  const destinations = []
  const reads = []
  const keep = (list, value) => {
    if (typeof value === 'string' && value.length > 0) list.push(value)
  }
  if (!WRITE_DESTINATION_PROGRAMS.has(program)) return { destinations, reads }
  const args = shellArguments(argv).slice(1)
  switch (program) {
    case 'dd': {
      for (const token of args) {
        if (token.startsWith('of=')) keep(destinations, token.slice(3))
        else if (token.startsWith('if=')) keep(reads, token.slice(3))
      }
      return { destinations, reads }
    }
    case 'tee': {
      // `tee` writes every file it is given, not only the last one.
      for (const operand of operandsOf(args).operands) keep(destinations, operand)
      return { destinations, reads }
    }
    case 'touch': {
      const { operands, values } = operandsOf(args, {
        valued: new Set(['-r', '--reference', '-d', '--date', '-t']),
        aliases: new Map([['--reference', '-r'], ['--date', '-d']]),
      })
      // `-r REF` reads REF to copy its timestamps; it does not write it.
      for (const reference of values.get('-r') ?? []) keep(reads, reference)
      for (const operand of operands) keep(destinations, operand)
      return { destinations, reads }
    }
    case 'sed': {
      const inPlace = args.some((token) => token === '-i' || /^-i./.test(token))
      if (!inPlace) return { destinations, reads }
      const { operands } = operandsOf(args, {
        valued: new Set(['-e', '--expression', '-f', '--file', '-l', '--line-length']),
      })
      for (const operand of operands) keep(destinations, operand)
      return { destinations, reads }
    }
    case 'mkdir': {
      const { operands } = operandsOf(args, {
        valued: new Set(['-m', '--mode', '-Z', '--context']),
        aliases: new Map([['--mode', '-m'], ['--context', '-Z']]),
      })
      for (const operand of operands) keep(destinations, operand)
      return { destinations, reads }
    }
    case 'rmdir': {
      for (const operand of operandsOf(args).operands) keep(destinations, operand)
      return { destinations, reads }
    }
    case 'chmod':
    case 'chown':
    case 'chgrp': {
      const { operands, values } = operandsOf(args, {
        valued: new Set(['--reference', '--from']),
      })
      const references = values.get('--reference') ?? []
      for (const reference of references) keep(reads, reference)
      // The first operand is the mode (or owner); `--reference` replaces it, so every
      // operand is a target in that spelling.
      const targets = references.length > 0 ? operands : operands.slice(1)
      for (const target of targets) keep(destinations, target)
      return { destinations, reads }
    }
    case 'truncate': {
      const { operands, values } = operandsOf(args, {
        valued: new Set(['-s', '--size', '-r', '--reference']),
        aliases: new Map([['--size', '-s'], ['--reference', '-r']]),
      })
      // `-r REF` sizes the file like REF, so it reads REF rather than writing it.
      for (const reference of values.get('-r') ?? []) keep(reads, reference)
      for (const operand of operands) keep(destinations, operand)
      return { destinations, reads }
    }
    case 'tar':
      return tarPathEffects(args)
    case 'unzip': {
      const { values } = operandsOf(args, { valued: new Set(['-d', '-P', '-x']) })
      for (const directory of values.get('-d') ?? []) keep(destinations, directory)
      return { destinations, reads }
    }
    case 'patch': {
      const { operands, values } = operandsOf(args, {
        valued: new Set(['-o', '--output', '-d', '--directory', '-i', '--input', '-r', '--reject-file']),
        aliases: new Map([['--output', '-o'], ['--directory', '-d'], ['--input', '-i']]),
      })
      for (const input of [...(values.get('-i') ?? []), ...operands]) keep(reads, input)
      const output = (values.get('-o') ?? [])[0]
      const directory = (values.get('-d') ?? [])[0]
      if (output !== undefined) keep(destinations, output)
      else if (directory !== undefined) keep(destinations, directory)
      // Without `-o`, patch writes the files its input names, and every one of them is
      // placed under the directory it applies in. That directory is the only part of
      // the target this row can see, so it is what the fence is asked about.
      else keep(destinations, '.')
      return { destinations, reads }
    }
    default: {
      // cp, mv, install, ln, rsync: the last operand is the destination, unless an
      // explicit target directory says otherwise.
      const { operands, values } = operandsOf(args, {
        valued: new Set(['-t', '--target-directory', '-S', '--suffix', '-m', '--mode']),
        aliases: new Map([['--target-directory', '-t']]),
      })
      const explicit = (values.get('-t') ?? [])[0]
      if (explicit !== undefined) keep(destinations, explicit)
      else if (operands.length > 0) keep(destinations, operands[operands.length - 1])
      return { destinations, reads }
    }
  }
}

/**
 * Split one PowerShell token into the elements of a comma list.
 *
 * PowerShell accepts `-Path a.txt, C:\Users\someone\f.txt` and the joined
 * `-Path:a.txt,C:\Users\someone\f.txt` spelling. The shared lexer has already
 * removed the quotes around a value, so the split is on the token's commas: reading a
 * quoted comma as two candidates can only add a path the fence then checks, never
 * hide one.
 *
 * @param {string} value - one parameter value or positional token.
 * @returns {string[]} its non-empty elements.
 */
function commaListElements(value) {
  return value
    .split(',')
    .map((element) => element.trim())
    .filter((element) => element.length > 0)
}

/**
 * The paths a PowerShell cmdlet writes and reads.
 *
 * Each cmdlet is read by its own parameter rule rather than by "the last argument":
 * `Set-Content`/`Add-Content`/`Out-File` name the file as `-Path`/`-LiteralPath`/
 * `-FilePath` or as their first positional parameter, `New-Item` writes the path it is
 * given (or the `-Name` below it), `Copy-Item`/`Move-Item` write `-Destination` or the
 * last positional and read the rest, and `Remove-Item` deletes every path it names.
 *
 * @param {string} program - the invoked program.
 * @param {string[]} argv - its tokens, program first.
 * @returns {{destinations: string[], reads: string[]}} the paths it writes and reads.
 */
function powershellPathEffects(program, argv) {
  const destinations = []
  const reads = []
  const keep = (list, value) => {
    if (typeof value === 'string' && value.length > 0) list.push(value)
  }
  const cmdlet = POWERSHELL_WRITE_CMDLET.get(program.toLowerCase())
  if (cmdlet === undefined) return { destinations, reads }
  const args = shellArguments(argv).slice(1)
  const values = new Map()
  const positional = []
  /** Record a parameter value, one element per comma-separated path. */
  const remember = (parameter, value) => {
    const elements = commaListElements(value)
    const known = values.get(parameter)
    if (known === undefined) values.set(parameter, elements)
    else known.push(...elements)
  }
  for (let at = 0; at < args.length; at += 1) {
    const token = args[at]
    const match = /^-{1,2}([A-Za-z][A-Za-z0-9]*)(?:[:=](.*))?$/.exec(token)
    if (match === null) {
      // `cmd` spells a deletion's switches `/f`, `/q`, `/s`; they are not paths. Only a
      // deletion is read this way, and only a single-letter spelling is dropped, so a
      // root-relative path like `/Users/...` is still classified.
      // `Remove-Item`, `rm` and `ri` take no such switches, so there `/x` is a path at the
      // drive root and stays a target.
      if (CMD_DELETE_BUILTINS.has(program.toLowerCase()) && /^\/[A-Za-z]$/.test(token)) continue
      // A positional path is a list element too: `Set-Content a.txt, C:\…\f.txt`.
      for (const element of commaListElements(token)) positional.push(element)
      continue
    }
    const parameter = match[1].toLowerCase()
    let value = match[2]
    if (value === undefined && POWERSHELL_VALUED_PARAMETER.has(parameter)) {
      value = args[at + 1]
      at += 1
    }
    if (typeof value !== 'string') continue
    remember(parameter, value)
    // A trailing comma continues a *path* list on the following token, as in
    // `-Path a.txt, C:\Users\someone\f.txt`. Only a path parameter takes a list here:
    // a value like `-Value "x,"` ends the parameter, and the next token is the cmdlet's
    // positional path. Continuing the list for every valued parameter swallowed that
    // path into `-Value` and never classified it.
    if (POWERSHELL_PATH_PARAMETER.has(parameter)) {
      while (value.trimEnd().endsWith(',') && at + 1 < args.length) {
        const next = args[at + 1]
        if (/^-{1,2}[A-Za-z][A-Za-z0-9]*(?:[:=].*)?$/.test(next)) break
        at += 1
        value = next
        remember(parameter, value)
      }
    }
  }
  const pathValues = []
  for (const name of POWERSHELL_PATH_PARAMETER) {
    for (const value of values.get(name) ?? []) pathValues.push(value)
  }
  switch (cmdlet) {
    case 'set-content':
    case 'add-content':
    case 'out-file':
    case 'new-item':
    case 'rename-item': {
      // Every positional argument is a candidate destination. A parameter this rule does
      // not know is read as a switch that consumes nothing (the fail-closed side for an
      // unknown spelling), so an unknown parameter's value lands in `positional`; taking
      // only the first let `Set-Content -ProgressAction SilentlyContinue C:\…\f.txt v`
      // name `SilentlyContinue` as the "target" and never look at the real path. Content
      // words are positionals too, but they resolve inside the workspace and are allowed,
      // so the extra refusal is limited to path-like content.
      for (const target of [...pathValues, ...positional]) keep(destinations, target)
      // `New-Item -Path build -Name ..\..\escape.txt` writes `build\..\..\escape.txt`:
      // the name is always placed below the path, and only then resolved. With no
      // `-Path` it is relative to the working directory.
      if (cmdlet === 'new-item') {
        for (const name of values.get('name') ?? []) {
          if (pathValues.length === 0) {
            keep(destinations, name)
            continue
          }
          for (const base of pathValues) keep(destinations, `${base.replace(/[\\/]+$/, '')}\\${name}`)
        }
      }
      return { destinations, reads }
    }
    case 'copy-item':
    case 'move-item': {
      const explicit = values.get('destination') ?? []
      for (const target of explicit.length > 0 ? explicit : positional.slice(-1)) keep(destinations, target)
      // Every other positional is a source, which is read rather than written.
      for (const source of explicit.length > 0 ? positional : positional.slice(0, Math.max(positional.length - 1, 0))) {
        keep(reads, source)
      }
      return { destinations, reads }
    }
    default: {
      // Remove-Item writes, i.e. deletes, every path it names.
      for (const target of [...pathValues, ...positional]) keep(destinations, target)
      return { destinations, reads }
    }
  }
}

/**
 * Whether one simple command deletes something.
 * @param {string} program - the invoked program.
 * @param {string[]} argv - its tokens.
 * @returns {boolean} true when the command is a deletion.
 */
function isDeletionProgram(program, argv) {
  if (program === 'rm' || program === 'rmdir' || program === 'shred') return true
  if (program === 'find') {
    const execAt = argv.findIndex((token) => token === '-exec' || token === '-execdir')
    return argv.includes('-delete') || (execAt >= 0 && basenameOf(argv[execAt + 1] ?? '') === 'rm')
  }
  return argv.some((token, at) => basenameOf(token) === 'xargs' && basenameOf(argv[at + 1] ?? '') === 'rm')
}

/** Whether a recursive search is hunting for credentials rather than reading code. */
function isSecretHunt(program, argv) {
  if (program !== 'grep' && program !== 'rg' && program !== 'ag') return false
  // Short flags cluster: `-rn` is recursive and numbered, so it is not `-r`.
  const recursive = argv.some((token) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(token) || token === '--recursive')
  if (!recursive) return false
  const pattern = argv.slice(1).find((token) => !token.startsWith('-'))
  return pattern !== undefined && SECRET_HUNT.test(pattern)
}

/**
 * Whether an `rm` target is one whose deletion is unbounded or unrecoverable.
 * @param {string} raw - the target token.
 * @param {string} resolved - its resolved form.
 * @param {object} context - `{cwd, home, settings}`.
 * @returns {{reason: string, detail: string} | undefined} the verdict, or undefined.
 */
function classifyRmTarget(raw, resolved, context) {
  const { cwd, home, settings, fence = '', powershell = false } = context
  // A bare glob removes the directory's whole contents.
  if (/^(?:\.\/)?(?:\*|\.\*|\{\*,\.\*\}|\*\.[A-Za-z0-9]+)$/.test(raw)) {
    return { reason: REASON.CRITICAL_RM, detail: 'removes every entry of a directory' }
  }
  // A trailing backslash is a separator only where the path is read the PowerShell way:
  // a POSIX shell writes the literal file name `~\tester`, which is not the home folder.
  const homePrefix = powershell === true ? HOME_PREFIX : POSIX_HOME_PREFIX
  if (homePrefix.test(raw) && basenameOf(expandHome(raw, home, powershell === true)) === basenameOf(home)) {
    return { reason: REASON.CRITICAL_RM, detail: 'removes the home directory' }
  }
  // A Windows-spelled path is absolute on every host. `path.isAbsolute` on a POSIX host
  // says otherwise for `C:\work\repo`, so `Remove-Item -Recurse -Force .` and the same
  // path spelled out skipped every root and ancestor check and were allowed.
  if (!isAbsolute(resolved) && !isWindowsPath(resolved)) {
    const pathVerdict = classifyPathAccess({ fence, path: resolved, cwd, home, settings, mutate: true, powershell })
    return pathVerdict
  }
  if (resolved === sep || /^[/\\][^/\\]+[/\\]?$/.test(resolved)) {
    return { reason: REASON.CRITICAL_RM, detail: 'removes a filesystem root' }
  }
  // The comparisons fold case for Windows paths: `C:\Work\Repo` is the same workspace
  // as `C:\work\repo`, and which host the guard runs on must not decide the verdict.
  if (home.length > 0 && isAtOrUnderPath(home, resolved)) {
    return { reason: REASON.CRITICAL_RM, detail: 'removes the home directory or an ancestor of it' }
  }
  if (cwd.length > 0 && isAtOrUnderPath(cwd, resolved)) {
    return { reason: REASON.CRITICAL_RM, detail: 'removes the service root or an ancestor of it' }
  }
  return classifyPathAccess({ fence, path: resolved, cwd, home, settings, mutate: true, powershell })
}

/**
 * Classify a path one simple command mutates: a redirect target or a write
 * destination.
 *
 * The path is resolved against the directory that simple command runs in, which is
 * the whole point: `cd server && echo x > ../log` writes into the workspace, one
 * level above `server`, and `cd .. && echo x > slot-2/x` writes into the directory
 * *beside* the workspace and is therefore outside the fence. Reading the starting
 * directory instead got both of those backwards — a false refusal for the first, an
 * open hole for the second.
 *
 * A relative target after a `cd` the guard cannot follow is placed against the last
 * known directory, exactly like a read and exactly as the code at HEAD did. Refusing
 * it was a wall across the most ordinary lines an agent writes — `cd "$(git rev-parse
 * --show-toplevel)" && mkdir -p build`, `cd "$(dirname "$0")/.." && npm test | tee
 * log` — while the runtime's file sandbox already confines the write. Deletions keep
 * their stricter rule (`classifySimpleCommand` refuses an `rm` after an unresolvable
 * move), and `~otheruser/…` stays unplaceable: only the shell can expand another
 * user's home, so any placement would be a guess.
 *
 * @param {string} target - the path the simple command mutates.
 * @param {object} state - `{cwd, home, settings, fence}`.
 * @returns {{reason: string, detail: string} | undefined} the verdict, or undefined to allow.
 */
function classifyMutationTarget(target, state) {
  const { cwd, home, settings, fence = '', powershell = false } = state
  const verdict = classifyPathAccess({ fence, path: target, cwd, home, settings, mutate: true, powershell })
  if (verdict !== undefined && verdict.reason !== REASON.OUTSIDE_WORKSPACE) return verdict
  const unplaceable = foreignHomeReason(target)
  if (unplaceable !== undefined) {
    return {
      reason: REASON.OUTSIDE_WORKSPACE,
      detail: `mutates ${target}, which cannot be placed ${unplaceable}`,
    }
  }
  return verdict
}

/**
 * Why a target is another user's home, which no placement can name.
 *
 * `~tester/f` is expanded by the shell, and the directory it names is not one this
 * row can compute. `~` and `~/…` are expanded by `expandHome`, and a `~` in the
 * middle of a path is never a home at all.
 *
 * @param {string} target - the path token a command names.
 * @returns {string | undefined} the clause a refusal reads out, or undefined.
 */
function foreignHomeReason(target) {
  // A backslash is a separator too: `~\f` is the home folder, while `~tester\f` is
  // another user's home. Excluding only `/` read the first as the second.
  const foreignHome = /^~[^/\\\s]+/.exec(target)
  return foreignHome === null ? undefined : `(${foreignHome[0]} is another user's home)`
}

/**
 * Why a mutation target cannot be placed in the directory a command runs in.
 *
 * Two things make a target unplaceable, and only two. `~tester/f` is another user's
 * home, which the shell expands to a directory this row cannot name. A relative target
 * after an unresolvable `cd` has no directory to be relative to, because the move that
 * would have named it was never followed. A *write* to either of those is placed
 * against the last known directory when it is relative (see `classifyMutationTarget`),
 * because the fence does not confine the sandbox's writable area and refusing ordinary
 * work is worse than placing a guess the sandbox still confines; a write to another
 * user's home is refused, because that path is not relative to anything here. A
 * **deletion** keeps both refusals: removing the wrong tree cannot be undone.
 *
 * A shell substitution (`$LOG`, `` `pwd` ``, `$(…)`) and an xargs replacement (`{}`)
 * are deliberately **not** on this list. The previous round refused them, which refused
 * `echo hi > "$LOG"` and `chmod +x "$f"` — everyday script idioms — while the runtime's
 * file sandbox already confines writes to the workspace. They are placed by their
 * literal spelling, as the code before that rule did; `rm` keeps its own, stricter
 * substitution rule in `classifySimpleCommand`.
 *
 * @param {string} target - the path token a command mutates.
 * @param {object} state - `{home, unknownCd}`.
 * @returns {string | undefined} the clause a refusal reads out, or undefined when the
 *   target can be placed.
 */
function unplaceableReason(target, state) {
  const { home = '', unknownCd = '', powershell = false } = state
  // A device is not a write at all, so `cd "$DIR" && echo x > /dev/null` stays open
  // even when the directory the command runs in is unknown.
  if (DEVICE_PATH.test(expandHome(target, home, powershell === true))) return undefined
  // An absolute path is placeable however lost the directory is: `cd "$DIR" && echo x
  // > /tmp/x` names its own location. Only a relative target needs a directory.
  if (unknownCd !== '' && !isAbsolute(expandHome(target, home, powershell === true))) return `after an unresolvable cd (${unknownCd})`
  return foreignHomeReason(target)
}

/**
 * Shell reserved words that stand where a command could, and are not programs.
 *
 * `if true; then cd ..; fi` used to classify `then` as the program, so the `cd`
 * behind it never moved the directory. `for`, `select`, `case` and `function` need
 * their own handling and are deliberately not in this set; `in` is here because a
 * `for NAME in WORDS` header is skipped as a whole and `in` can also appear alone.
 * `time` is not here either: it is a prefix program with options of its own, and
 * `parsePrefix` already reads through it (`time -p rm -rf /` stays a deletion).
 */
const CONTROL_WORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'in', 'do', 'done', 'while', 'until', 'esac', '!'])

/**
 * The deepest a nested command line is classified.
 *
 * Every form that carries another command line — a `$( … )` or `` `…` `` substitution,
 * a `bash -c` payload, an `eval` payload — counts against the same limit, because
 * each of them recurses into `classifyShell`. Following all of them is what made a
 * thousand nested `$(` overflow the stack with a `RangeError`, and a guard that
 * throws is a guard that fails open: the throw reached the transport instead of
 * becoming a denial. Past this depth the command is denied with a `GUARD_ERROR`
 * instead. No worker command nests real work 32 levels deep.
 */
const MAX_NESTED_COMMANDS = 32

/**
 * The context a nested command line inherits from the line that contains it.
 *
 * A substitution or a payload starts in the directory its command runs in and
 * inherits the doubt about that directory; it is one level deeper than the line that
 * named it, which is what the nesting cap counts.
 *
 * @param {object} context - the enclosing line's `{cwd, home, settings, fence, depth}`.
 * @param {object} state - the enclosing line's shell state.
 * @param {object} [extra] - fields only one kind of payload adds (an `eval`'s state).
 * @returns {object} the context for the nested `classifyShell` call.
 */
function nestedContext(context, state, extra = {}) {
  return {
    ...context,
    cwd: state.cwd,
    cwdUnknown: state.unknown,
    unresolvedCd: state.cd,
    depth: (typeof context.depth === 'number' ? context.depth : 0) + 1,
    ...extra,
  }
}

/**
 * Classify one shell command line.
 *
 * Every path a simple command names is resolved against the directory *that*
 * command runs in. A leading `cd`, `pushd`, `popd` or `chdir` therefore moves the
 * classification for every rule below it — deletion, redirects, write destinations
 * and the secret-mention pass alike — while the fence itself stays the origin root
 * the caller was started in, which is what `decideToolCall` hands in.
 *
 * The directory travels through the line the way a shell carries it: a newline ends a
 * command, `( … )` runs in a subshell whose `cd` is undone at the `)`, `{ …; }` is the
 * same shell and its `cd` is not, and a `CDPATH` or an `env -C` makes a relative move
 * unplaceable rather than guessed at.
 *
 * Control structures are read as the syntax they are, not as programs: the reserved
 * words before a command are transparent, a `for`/`case` header is not a command, a
 * case pattern is skipped and `;;` starts the next arm. A `cd` inside a conditional,
 * a loop, or a function body moves the directory for what follows, because the shell
 * may run it and this row may over-refuse rather than under-refuse.
 *
 * @param {string} command - the command string a worker is about to run.
 * @param {object} context - `{cwd, home, settings, fence, powershell}`, plus the optional
 *   `cwdUnknown` / `unresolvedCd` a nested `bash -c` payload inherits, the `depth` of
 *   the nesting that produced it, and an optional `state` that an `eval` payload
 *   shares with the line that called it.
 * @returns {{reason: string, detail: string} | undefined} the verdict, or undefined to allow.
 */
function classifyShell(command, context) {
  const {
    cwd,
    home,
    settings,
    fence = '',
    cwdUnknown: inheritedUnknown = false,
    unresolvedCd: inheritedCd = '',
    state: sharedState,
    depth = 0,
  } = context
  if (typeof command !== 'string' || command.trim().length === 0) return undefined
  // Nesting is capped before anything is read, so a pathological command is a denial
  // rather than a `RangeError` from the recursion itself. The detail names the cap,
  // because a caller that wrote `$($($(…)))` needs to know what to remove.
  if (depth > MAX_NESTED_COMMANDS) {
    return {
      reason: REASON.GUARD_ERROR,
      detail: `command substitutions nested deeper than ${MAX_NESTED_COMMANDS} levels`,
    }
  }
  /**
   * The directory the line has reached, and the doubt about it. A `cd` earlier in the
   * line moves everything after it, so those commands are classified against where it
   * went; when the destination is a shell expansion the move cannot be followed at
   * all, and a relative write after it is placed against the last known directory
   * (a deletion, which cannot be undone, is still refused). A shared state is how
   * `eval` leaks its `cd` back to the caller.
   */
  const state = sharedState ?? {
    cwd,
    /** The home folder, for the rules that expand `~` and `$HOME`. */
    home,
    /** Whether this line is read the way PowerShell reads one (paths, `-Command`). */
    powershell: context.powershell === true,
    unknown: inheritedUnknown === true,
    /** The `cd` that lost the directory, so a refusal can name the move it died on. */
    cd: typeof inheritedCd === 'string' ? inheritedCd : '',
    /** Directories `pushd` left, for `popd`. */
    stack: [],
    /** The directory before the last move, for `cd -`. */
    previous: null,
    /** A `CDPATH` seen on this line makes a relative `cd` destination unknowable. */
    cdpath: false,
  }
  /** Saved shell states, one per open `( … )`. */
  const subshells = []
  /** Inside a `case … esac`, until its `esac`. */
  let inCase = false
  /** At a point where the next tokens are a case pattern, up to its `)`. */
  let casePattern = false
  /** Inside a `for`/`select` header, until the `do` that opens its body. */
  let awaitingDo = false
  for (const raw of splitSimpleCommands(command)) {
    if (raw.length === 0) continue
    // The arm separators are emitted by the lexer as their own command. `;;` and
    // `;;&` begin the next arm's pattern; `;&` falls through to the next arm's
    // commands, so there is no pattern to skip.
    if (raw.length === 1 && (raw[0] === ';;' || raw[0] === ';&' || raw[0] === ';;&')) {
      if (inCase && raw[0] !== ';&') casePattern = true
      continue
    }
    let tokens = openSubshells(raw, state, subshells)
    // A `for`/`select` header is followed by its `do` on a later command, so that
    // command is consumed here before any other reading of its tokens.
    if (awaitingDo) {
      const doAt = tokens.indexOf('do')
      if (doAt < 0) {
        // A header with no `do` in the next command is malformed. Read the command
        // normally rather than waiting forever: a `for` that never reaches `do` must
        // not become a reason to skip every command after it.
        awaitingDo = false
      } else {
        tokens = tokens.slice(doAt + 1)
        awaitingDo = false
      }
    }
    if (!inCase) {
      // Reserved words at a command position are syntax, not the program.
      while (tokens.length > 0 && CONTROL_WORDS.has(tokens[0])) tokens = tokens.slice(1)
      // `case WORD in` may share its command with the first pattern and body, as in
      // `case x in x) cd .. ;;`; the header ends at its `in`, not at a separator.
      if (tokens[0] === 'case') {
        inCase = true
        casePattern = true
        const inAt = tokens.indexOf('in', 1)
        tokens = inAt >= 0 ? tokens.slice(inAt + 1) : []
      }
    }
    if (inCase) {
      if (tokens[0] === 'esac') {
        inCase = false
        casePattern = false
        tokens = tokens.slice(1)
      } else if (casePattern) {
        // `x)`, `a|b)` and `*)` are patterns, not programs. The `|` in `a|b)` is a
        // pattern separator, so the lexer may have split it into several commands;
        // anything before the `)` is part of the pattern and is skipped.
        if (tokens[0] === 'in') tokens = tokens.slice(1)
        const close = tokens.indexOf(')')
        if (close < 0 && tokens.length > 1) {
          // A pattern is one word (or several joined by `|`, which the lexer may have
          // split into one-word commands). A multi-token command without a `)` is not
          // a pattern fragment; reading it as one would skip a real command.
          casePattern = false
        } else {
          if (close < 0) {
            closeSubshells(raw, state, subshells)
            continue
          }
          tokens = tokens.slice(close + 1)
          casePattern = false
        }
      }
    }
    tokens = trimClosers(tokens)
    if (tokens.length === 0) {
      closeSubshells(raw, state, subshells)
      continue
    }
    // Reserved words can also follow a pattern or an `else`: strip them once more.
    while (tokens.length > 0 && CONTROL_WORDS.has(tokens[0])) tokens = tokens.slice(1)
    if (tokens.length === 0) {
      closeSubshells(raw, state, subshells)
      continue
    }
    // A `for NAME in WORDS`/`select NAME in WORDS` header is not a command; its body
    // starts after the `do`.
    if (tokens[0] === 'for' || tokens[0] === 'select') {
      awaitingDo = true
      closeSubshells(raw, state, subshells)
      continue
    }
    // A `case WORD` whose `in` arrives on a later line: the next commands are still
    // part of the header until that `in`, which the pattern branch strips.
    if (tokens[0] === 'case') {
      inCase = true
      casePattern = true
      closeSubshells(raw, state, subshells)
      continue
    }
    // A function definition is `name ( ) { … }` or `function name { … }`. The body is
    // classified as a command of this shell: it may run later, and moving the
    // directory from the definition on is the over-approximation this row prefers to
    // the alternative, where `f() { cd ..; }; f; touch ../x` is followed only at the
    // call the guard cannot see.
    let body
    if (tokens[0] === 'function') {
      const braceAt = tokens.indexOf('{')
      body = braceAt >= 0 ? tokens.slice(braceAt + 1) : []
    } else if (tokens.length >= 3 && tokens[1] === '(' && tokens[2] === ')') {
      const braceAt = tokens.indexOf('{')
      body = braceAt >= 0 ? tokens.slice(braceAt + 1) : tokens.slice(3)
    }
    if (body !== undefined) {
      while (body.length > 0 && CONTROL_WORDS.has(body[0])) body = body.slice(1)
      if (body.length > 0) {
        const verdict = classifySimpleCommand(trimClosers(body), state, { cwd, home, settings, fence, depth, powershell: context.powershell === true })
        if (verdict !== undefined) return verdict
      }
      closeSubshells(raw, state, subshells)
      continue
    }
    const verdict = classifySimpleCommand(tokens, state, { cwd, home, settings, fence, depth, powershell: context.powershell === true })
    if (verdict !== undefined) return verdict
    // The `)` of a subshell undoes its `cd`: a subshell's directory does not leak out.
    closeSubshells(raw, state, subshells)
  }
  return undefined
}

/**
 * Open the subshells a command begins with.
 *
 * `( cd .. && echo x > f )` used to be read as a program called `(`, so the deletion
 * and the redirect behind it were never classified at all. The `{` of a group is
 * dropped here without saving anything: a group is the same shell, so its `cd` does
 * leak out to the `; }`.
 *
 * @param {string[]} tokens - the tokens of one simple command.
 * @param {object} state - the shell state being moved.
 * @param {object[]} subshells - the stack of saved states.
 * @returns {string[]} the tokens with the leading group openers removed.
 */
function openSubshells(tokens, state, subshells) {
  let at = 0
  while (at < tokens.length && (tokens[at] === '(' || tokens[at] === '{')) {
    if (tokens[at] === '(') {
      subshells.push({
        cwd: state.cwd,
        unknown: state.unknown,
        cd: state.cd,
        stack: [...state.stack],
        previous: state.previous,
        cdpath: state.cdpath,
      })
    }
    at += 1
  }
  return tokens.slice(at)
}

/**
 * The tokens of a command without the group closers it ends with.
 * @param {string[]} tokens - the tokens of one simple command.
 * @returns {string[]} the tokens a program rule may read.
 */
function trimClosers(tokens) {
  let end = tokens.length
  while (end > 0 && (tokens[end - 1] === ')' || tokens[end - 1] === '}')) end -= 1
  return tokens.slice(0, end)
}

/**
 * Close the subshells a command ends with, restoring the directory they were opened in.
 * @param {string[]} tokens - the tokens of one simple command, as written.
 * @param {object} state - the shell state being moved.
 * @param {object[]} subshells - the stack of saved states.
 * @returns {void}
 */
function closeSubshells(tokens, state, subshells) {
  for (let at = tokens.length - 1; at >= 0; at -= 1) {
    if (tokens[at] === '}') continue
    if (tokens[at] !== ')') break
    const saved = subshells.pop()
    if (saved === undefined) continue
    state.cwd = saved.cwd
    state.unknown = saved.unknown
    state.cd = saved.cd
    state.stack = saved.stack
    state.previous = saved.previous
    state.cdpath = saved.cdpath
  }
}

/**
 * The destination of a `cd`/`pushd`, if it has one.
 *
 * A redirect is part of the command, not an argument: `cd 2>/dev/null` takes no
 * destination and therefore goes home, while reading `2>/dev/null` as one moved every
 * write after it into a directory named `2` below the fence. `-P`, `-L`, `-e` and `--`
 * are flags, and a lone `-` is the previous directory rather than a path.
 *
 * @param {string[]} argv - the tokens of the command, program first.
 * @returns {string | undefined} the destination token, or undefined for home.
 */
function cdDestination(argv) {
  for (const token of shellArguments(argv).slice(1)) {
    if (token === '-') return '-'
    if (token.startsWith('-')) continue
    return token
  }
  return undefined
}

/**
 * Move the shell state to the destination of one `cd`-family command.
 *
 * @param {string} program - `cd`, `pushd`, `popd` or `chdir`.
 * @param {string[]} argv - the tokens of the command, program first.
 * @param {string} move - the command as written, for a detail that names it.
 * @param {object} state - the shell state being moved.
 * @param {string} home - the home directory, or an empty string.
 * @returns {void}
 */
function moveDirectory(program, argv, move, state, home) {
  const destination = cdDestination(argv)
  const here = { cwd: state.cwd, unknown: state.unknown, cd: state.cd }
  // `popd` and `cd -` go back, not home. Now that every path follows the directory,
  // reading them as `cd` with no argument sent the writes after them to the home
  // folder and refused them. Going back is followed through this line's own stack; a
  // move back past what this line recorded cannot be placed.
  let back
  if (program === 'popd') back = destination === undefined ? (state.stack.pop() ?? null) : null
  else if (program === 'pushd' && destination === undefined) back = null
  else if (destination === '-') back = state.previous
  if (back !== undefined) {
    if (back === null) {
      state.unknown = true
      state.cd = move
    } else {
      state.cwd = back.cwd
      state.unknown = back.unknown
      state.cd = back.cd
    }
    state.previous = here
    return
  }
  if (program === 'pushd') state.stack.push(here)
  state.previous = here
  const powershell = state.powershell === true
  const absolute = destination === undefined ? '' : expandHome(destination, home, powershell)
  if (destination === undefined) {
    state.cwd = home
    state.unknown = home === ''
    state.cd = state.unknown ? move : ''
  } else if (SHELL_SUBSTITUTION.test(destination)) {
    state.unknown = true
    state.cd = move
  } else if (state.cdpath && !isAbsolute(absolute)) {
    // A `CDPATH` turns a relative `cd` into a search along a list this row cannot see,
    // so the destination is unplaceable rather than relative to the current directory.
    state.unknown = true
    state.cd = move
  } else if (state.unknown && !isAbsolute(absolute)) {
    // Moving on from a directory this row could not name leaves it just as unnamed:
    // `cd "$DIR" && cd ..` is no more placeable than `cd "$DIR"` was. An absolute
    // destination is placeable again, so it clears the doubt.
  } else {
    state.cwd = resolveTarget(destination, state.cwd, home, powershell)
    state.unknown = false
    state.cd = ''
  }
}

/**
 * Read past what stands before the program in a simple command.
 *
 * A shell removes `NAME=value` assignments before it runs anything, and a wrapper
 * program runs the real program somewhere after its own options and assignments.
 * Reading the first token as the program made `FOO=1 rm -rf ../outside`, `env -i rm
 * -rf /`, `exec bash -c "…"` and `xargs -I{} touch {}` look like commands this row had
 * never seen. `CDPATH=…` is reported rather than skipped, because it changes what a
 * later relative `cd` means.
 *
 * @param {string[]} tokens - the tokens of one simple command.
 * @returns {{program: string, argv: string[], cdpath: boolean, directory: boolean}}
 *   the program, its own tokens, whether `CDPATH` was assigned, and whether a prefix
 *   moved the directory somewhere unnameable.
 */
function parsePrefix(tokens) {
  let index = 0
  let cdpath = false
  let directory = false
  while (index < tokens.length) {
    const token = tokens[index]
    if (ASSIGNMENT.test(token)) {
      if (token.startsWith('CDPATH=')) cdpath = true
      index += 1
      continue
    }
    const program = basenameOf(token)
    if (!PREFIX_PROGRAMS.has(program)) break
    const valued = PREFIX_VALUE_OPTION.get(program) ?? new Set()
    index += 1
    while (index < tokens.length) {
      const option = tokens[index]
      if (option === '--') {
        index += 1
        break
      }
      if (program === 'env' && ASSIGNMENT.test(option)) {
        if (option.startsWith('CDPATH=')) cdpath = true
        index += 1
        continue
      }
      if (!option.startsWith('-') || option === '-') break
      if (program === 'env' && (option === '-C' || option === '--chdir' || option.startsWith('--chdir='))) {
        // `env -C DIR` changes the directory before the program runs. DIR itself is
        // not resolved here, so the line's directory is unknown from this command on:
        // a relative write after it is placed against the last known one and a deletion
        // after it is refused.
        directory = true
      }
      // An option either carries its value, swallows the next token, or stands alone.
      const equals = option.indexOf('=')
      if (equals > 0 && valued.has(option.slice(0, equals))) {
        index += 1
        continue
      }
      if (valued.has(option)) {
        index += 2
        continue
      }
      const short = option.slice(0, 2)
      if (option.length > 2 && option[1] !== '-' && valued.has(short)) {
        index += 1
        continue
      }
      index += 1
    }
    // `timeout 5 cmd` names its duration as the operand between its options and the
    // program. Reading `5` as the program left `timeout 5 rm -rf /` unclassified.
    if (program === 'timeout' && index < tokens.length) index += 1
  }
  return { program: basenameOf(tokens[index] ?? ''), argv: tokens.slice(index), cdpath, directory }
}

/**
 * The command lines written inside a token's substitutions.
 *
 * A token is not always one word: `x=$(cd .. && touch ../x)` carries a whole command
 * line, and `echo "$(date)"` carries another. The lexer keeps each substitution
 * together, so this reads them out verbatim. `$(( … ))` is arithmetic, not a command,
 * and is skipped; an unclosed or empty substitution has nothing to classify.
 *
 * @param {string} token - one token of a simple command.
 * @returns {string[]} the command lines inside its `$( … )` and `` `…` `` forms.
 */
function substitutionContents(token) {
  const found = []
  for (let at = 0; at < token.length; at += 1) {
    if (token[at] === '`') {
      const end = backtickEnd(token, at)
      const closed = end <= token.length && token[end - 1] === '`' && end - 1 > at
      const inner = token.slice(at + 1, closed ? end - 1 : end)
      if (inner.trim().length > 0) found.push(inner)
      at = end - 1
      continue
    }
    if (token[at] === '$' && token[at + 1] === '(') {
      const end = substitutionEnd(token, at + 1)
      const closed = end <= token.length && token[end - 1] === ')' && end - 1 >= at + 2
      const inner = token.slice(at + 2, closed ? end - 1 : end)
      // `$((1+2))` and `$(( $(x) ))` are arithmetic: not a command, so not parsed.
      if (inner.trim().length > 0 && !inner.trimStart().startsWith('(')) found.push(inner)
      at = end - 1
      continue
    }
  }
  return found
}

/**
 * The command-line payload of a shell's own command flag.
 *
 * Only a bare `-c` used to be recognised, so `bash -lc "npm test"` and `zsh -ic "…"`
 * hid their payload completely. A short-option cluster containing `c` names the
 * payload as the next non-option token, and `-o NAME` / `-O NAME` consume a value of
 * their own before it: `bash -o pipefail -c "…"` must not take `pipefail` for the
 * payload. The flag is returned as written so a refusal can say where the command
 * line it names was found (`inside bash.exe -c`).
 *
 * PowerShell and `cmd` are different: `-Command` and `/c` take *every* remaining
 * argument as one command line, quoted or not. Reading only the next token let
 * `pwsh -Command Set-Content C:\Users\someone\f.txt x` hide the write behind a
 * "command line" of just `Set-Content`. Only `bash`/`sh` and their relatives take a
 * single argument.
 *
 * @param {string[]} argv - the shell's tokens, program first.
 * @param {string} [shell] - the shell's bare lower-case name, from `shellProgramName`.
 * @returns {{payload: string | undefined, flag: string} | undefined} the payload and
 *   the flag that named it, or undefined when there is none.
 */
function shellPayload(argv, shell = '') {
  const powershell = shell === 'pwsh' || shell === 'powershell'
  /** The rest of the line is the command line, as PowerShell and cmd read it. */
  const rest = (at, token) => {
    const payload = argv.slice(at + 1).join(' ')
    return { payload: payload.length === 0 ? undefined : payload, flag: token }
  }
  for (let at = 1; at < argv.length; at += 1) {
    const token = argv[at]
    if (token === '--') return undefined
    const lower = token.toLowerCase()
    if (powershell) {
      // `-Command`, and its `-c` abbreviation, run everything after them.
      if (lower === '-command' || lower === '--command' || lower === '-c') return rest(at, token)
      continue
    }
    if (shell === 'cmd') {
      if (lower === '/c' || lower === '/k') return rest(at, token)
      continue
    }
    if (token === '-o' || token === '+o' || token === '-O' || token === '+O' || token === '--rcfile' || token === '--init-file') {
      at += 1
      continue
    }
    if (token.startsWith('--')) continue
    // `-c`, `-lc`, `-xc`, `-euc`, `-ic`: the short cluster carries the `c`.
    if (/^[-+][A-Za-z]*c[A-Za-z]*$/.test(token)) {
      for (let next = at + 1; next < argv.length; next += 1) {
        const candidate = argv[next]
        if (candidate.startsWith('-') && candidate !== '-') continue
        return { payload: candidate, flag: token }
      }
      return { payload: undefined, flag: token }
    }
  }
  return undefined
}

/**
 * Classify every path a deletion names, with the rule `rm` uses.
 *
 * `Remove-Item`, `del`, `ri`, `rd`, `rmdir` and `erase` are deletions just as much as
 * `rm` is, so they must report the same reason for the same path: a target under the
 * home folder is `CRITICAL_PATH` whether bash or PowerShell removes it, and an
 * unrelated one outside the fence is `OUTSIDE_WORKSPACE`. Keeping the walk here is
 * what guarantees the two spellings cannot drift apart again.
 *
 * @param {string[]} targets - the paths the command deletes, as written.
 * @param {object} state - the shell state the command runs in.
 * @param {object} context - `{cwd, home, settings, fence, powershell}`.
 * @returns {{reason: string, detail: string} | undefined} the verdict, or undefined.
 */
function classifyDeletionTargets(targets, state, context) {
  const { home, settings, fence = '' } = context
  for (const raw of targets) {
    if (SHELL_SUBSTITUTION.test(raw)) {
      return { reason: REASON.CRITICAL_RM, detail: `deletes ${raw}, which only the shell can resolve` }
    }
    // A deletion of another user's home is the same unplaceable mutation a redirect
    // to it is: `rm -rf ~tester/work` names a path only the shell can expand.
    const unplaceable = unplaceableReason(raw, state)
    if (unplaceable !== undefined) {
      return { reason: REASON.OUTSIDE_WORKSPACE, detail: `deletes ${raw}, which cannot be placed ${unplaceable}` }
    }
    const resolved = resolveTarget(raw, state.cwd, home, state.powershell === true)
    if (
      isOutsideRootCritical(resolved, { root: settings.root, home }) ||
      isOutsideRootCritical(state.cwd, { root: settings.root, home })
    ) {
      return { reason: REASON.CRITICAL_RM, detail: `deletes ${raw} outside the service root` }
    }
    const verdict = classifyRmTarget(raw, resolved, { ...context, fence })
    if (verdict !== undefined) return verdict
  }
  return undefined
}

/**
 * Classify one simple command, given the directory it runs in.
 *
 * @param {string[]} tokens - the tokens of the command, group markers already removed.
 * @param {object} state - the shell state the command runs in.
 * @param {object} context - `{cwd, home, settings, fence, powershell, depth}` for the rules
 *   that ask about the origin rather than the current directory, whether the line is read
 *   the way PowerShell reads one, and the nesting cap that a substitution or a payload
 *   counts against.
 * @returns {{reason: string, detail: string} | undefined} the verdict, or undefined to allow.
 */
function classifySimpleCommand(tokens, state, context) {
  const { home, settings, fence = '', powershell = false } = context
  /** The command as written, so a detail can name the move it died on. */
  const simple = tokens.join(' ')
  const prefix = parsePrefix(tokens)
  // `CDPATH` counts wherever it is set, not only as a leading assignment: `export
  // CDPATH=/tmp` on this line changes the same relative `cd` the next command makes.
  if (prefix.cdpath || tokens.some((token) => token.startsWith('CDPATH='))) state.cdpath = true
  if (prefix.directory) {
    state.unknown = true
    state.cd = simple.trim().slice(0, 80)
  }
  const program = prefix.program
  const argv = prefix.argv

  // A substitution runs before the command it is an argument of, in the directory the
  // command runs in. Its content is a command line of its own — a `cd` inside it does
  // not leak — which is how `$( cd .. && touch ../x )` stops being one opaque token.
  for (const token of tokens) {
    for (const inner of substitutionContents(token)) {
      const nested = classifyShell(inner, nestedContext(context, state))
      if (nested !== undefined) return nested
    }
  }

  if (program === 'cd' || program === 'pushd' || program === 'popd' || program === 'chdir') {
    moveDirectory(program, argv, simple.trim().slice(0, 80), state, home)
    // A redirect on a `cd` line is still a redirect of that command, and `cd` has no
    // destination to confuse it with.
    return classifyRedirections(tokens, state, context)
  }
  // A shell running `-c '<command line>'` is another command line. Parsing it is
  // the only way `bash -c "rm -rf ."` is a deletion at all: tokenization sees
  // one quoted argument and nothing else. It starts where this command runs, so a
  // `cd` in front of the `bash` carries into the payload, as does a directory this
  // row already lost. The `-c` may stand in a short-option cluster (`bash -lc`,
  // `zsh -ic`) and `-o NAME` takes a value before it. The program is matched by its
  // basename without `.exe`, in any case, so a shell started as a program — Git Bash
  // behind PowerShell's `&`, `pwsh -Command`, `cmd /c` — is parsed the same way, and
  // the refusal names the nesting so a caller can see where the command line was.
  const shell = shellProgramName(program)
  if (shell !== '') {
    const invocation = shellPayload(argv, shell)
    if (invocation !== undefined && typeof invocation.payload === 'string' && invocation.payload.trim().length > 0) {
      // The payload is read by the shell that will run it: `bash -c` keeps POSIX
      // rules, while a `pwsh`/`cmd` payload follows PowerShell's (case-insensitive
      // segments, `$env:USERPROFILE`, a `-Command` payload running to the line's end).
      const nested = classifyShell(
        invocation.payload,
        nestedContext(context, state, { powershell: POWERSHELL_SHELLS.has(shell) }),
      )
      if (nested !== undefined) {
        return { reason: nested.reason, detail: `${nested.detail} inside ${basenameOf(program)} ${invocation.flag}` }
      }
    }
  }
  // `[System.IO.File]::WriteAllText("C:\…\f", "x")` is a write with neither a redirect
  // nor a cmdlet. Its first argument is the path; one written as a variable is placed
  // by its literal spelling, exactly as a bash mutation target is. In PowerShell the
  // call can stand anywhere in the line — `if (Test-Path x) { [System.IO.File]::… }` —
  // so every token is a candidate there, not only the program.
  const dotnetAt = []
  if (powershell === true) {
    for (let at = 0; at < tokens.length; at += 1) {
      if (DOTNET_FILE_WRITE_CALL.test(tokens[at])) dotnetAt.push(at)
    }
  } else if (DOTNET_FILE_WRITE.test(program)) {
    const at = tokens.findIndex((token) => basenameOf(token) === program)
    if (at >= 0) dotnetAt.push(at)
  }
  for (const at of dotnetAt) {
    const argument = shellArguments(tokens.slice(at + 1)).find((token) => token !== '(' && token !== ')' && token !== ',')
    if (argument !== undefined) {
      // The lexer glues the argument separator to the quoted literal: `"path","x"`
      // leaves `path,x` as one token, and `"path", "x"` leaves a trailing comma.
      // The path is the first argument, so everything from the separator on is not
      // part of it.
      const verdict = classifyMutationTarget(argument.split(',')[0], {
        cwd: state.cwd,
        fence,
        home,
        settings,
        powershell,
      })
      if (verdict !== undefined) return verdict
    }
  }

  // `eval` runs its arguments as a command line in this same shell, so — unlike a
  // `bash -c` payload — a `cd` inside it does leak out. The shared state is what
  // carries that move back to the rest of the line.
  if (program === 'eval') {
    const payload = argv.slice(1).join(' ')
    if (payload.trim().length > 0) {
      const nested = classifyShell(payload, nestedContext(context, state, { state }))
      if (nested !== undefined) return nested
    }
  }
  // Inline code can delete without ever invoking a delete program. `Object.hasOwn`
  // is not decoration: a command named `constructor` would otherwise read a function
  // off `Object.prototype` and throw on `.includes`, and a guard that throws fails open.
  const inlineFlags = Object.hasOwn(INLINE_CODE_FLAGS, program) ? INLINE_CODE_FLAGS[program] : undefined
  if (inlineFlags !== undefined) {
    const at = argv.findIndex((token) => inlineFlags.includes(token))
    if (at >= 0 && INLINE_DELETE.test(argv.slice(at + 1).join(' '))) {
      return { reason: REASON.CRITICAL_RM, detail: `${program} inline code deletes files` }
    }
  }
  // Deletion does not always say `rm` with a path, so these shapes are read for
  // what they can actually reach. A whole-tree deletion is a critical path
  // whichever program spells it; a deletion narrowed by a name or path pattern
  // is ordinary cleanup and stays allowed.
  if (tokens.some((token, at) => basenameOf(token) === 'xargs' && basenameOf(tokens[at + 1] ?? '') === 'rm')) {
    return { reason: REASON.CRITICAL_RM, detail: 'deletes whatever is piped into xargs' }
  }
  if (program === 'find') {
    const execAt = argv.findIndex((token) => token === '-exec' || token === '-execdir')
    const pipedToRm = execAt >= 0 && basenameOf(argv[execAt + 1] ?? '') === 'rm'
    // `-name '*'` bounds nothing, so a narrowing flag only counts when the value
    // in front of it is something more specific than every name.
    const narrowed = FIND_NARROWING.some((flag) => {
      const flagAt = argv.indexOf(flag)
      if (flagAt < 0) return false
      const value = argv[flagAt + 1] ?? ''
      return !/^['"]?\*['"]?$/.test(value) && value.length > 0
    })
    if ((argv.includes('-delete') || pipedToRm) && !narrowed) {
      return { reason: REASON.CRITICAL_RM, detail: 'deletes everything find matches' }
    }
  }
  // PowerShell's deletions are deletions: `Remove-Item` and its aliases walk through
  // the same classification as `rm`, so the reason codes match for the same target.
  const powershellDelete = state.powershell === true && POWERSHELL_DELETE_CMDLET.has(program.toLowerCase())
  if (program === 'rm' || program === 'rmdir' || program === 'shred' || powershellDelete) {
    if (state.unknown) {
      return { reason: REASON.CRITICAL_RM, detail: `deletes after an unresolvable cd (${simple.trim().slice(0, 80)})` }
    }
    // A PowerShell deletion names its target through its own parameters (`-Path`,
    // `-LiteralPath`, a comma list), so those are read first; a POSIX deletion names
    // it positionally.
    const targets = powershellDelete
      ? powershellPathEffects(program, argv).destinations
      : shellArguments(argv).slice(1).filter((token) => !token.startsWith('-'))
    const deletionVerdict = classifyDeletionTargets(targets, state, { ...context, fence })
    if (deletionVerdict !== undefined) return deletionVerdict
  }
  // `mv` and `rsync --delete` remove things without naming a delete program:
  // `mv . /tmp/gone` empties the directory it moves, and `rsync -a --delete` makes
  // the destination match an empty source.
  if (program === 'mv' && !state.unknown) {
    for (const raw of shellArguments(argv).slice(1).filter((token) => !token.startsWith('-'))) {
      if (SHELL_SUBSTITUTION.test(raw)) {
        return { reason: REASON.CRITICAL_RM, detail: `moves ${raw}, which only the shell can resolve` }
      }
      const unplaceable = unplaceableReason(raw, state)
      if (unplaceable !== undefined) {
        return { reason: REASON.OUTSIDE_WORKSPACE, detail: `moves ${raw}, which cannot be placed ${unplaceable}` }
      }
      const verdict = classifyRmTarget(raw, resolveTarget(raw, state.cwd, home, powershell), { ...context, fence })
      if (verdict !== undefined) return verdict
    }
  }
  if (program === 'rsync' && argv.includes('--delete')) {
    // The destination belongs to the directory the command runs in, and the root it is
    // compared against is the fence — the service root — not the directory the line
    // started in. Reading the start made `cd server && rsync --delete src .` look like
    // the whole workspace, and `cd .. && rsync --delete src/ slot-1` look like an
    // ordinary subdirectory.
    const destination = shellArguments(argv).slice(1).filter((token) => !token.startsWith('-')).pop()
    const resolved = destination === undefined ? '' : resolveTarget(destination, state.cwd, home, powershell)
    const serviceRoot = settings.root !== '' ? settings.root : fence
    if (resolved.length > 0 && serviceRoot.length > 0 && (resolved === serviceRoot || isAtOrUnder(serviceRoot, resolved))) {
      return { reason: REASON.CRITICAL_RM, detail: 'rsync --delete empties the service root' }
    }
    if (resolved.length > 0 && home.length > 0 && (resolved === home || isAtOrUnder(home, resolved))) {
      return { reason: REASON.CRITICAL_RM, detail: 'rsync --delete empties the home directory' }
    }
  }
  // A recursive search for credentials reads secrets that are never named as a
  // path, which no per-token rule can see.
  if (isSecretHunt(program, argv)) {
    return { reason: REASON.SECRET, detail: `recursively searches for credentials (${argv.slice(1).find((token) => !token.startsWith('-'))})` }
  }
  if (INTERPRETER_PROGRAMS.has(program)) {
    // Inline code can name a secret inside a quoted string, where tokenization
    // cannot see it as a path.
    for (const match of simple.matchAll(INLINE_SECRET)) {
      const named = match[1]
      if (settings.envFileExceptions.includes(named)) continue
      return { reason: REASON.SECRET, detail: `inline ${program} code names ${named}` }
    }
  }
  if (settings.blockDestructiveGit && program === 'git') {
    const subcommand = destructiveGitReason(argv)
    if (subcommand !== undefined) {
      return { reason: REASON.DESTRUCTIVE_GIT, detail: `git ${subcommand} discards work that was never committed` }
    }
  }
  const redirectVerdict = classifyRedirections(tokens, state, context)
  if (redirectVerdict !== undefined) return redirectVerdict
  // A secret named anywhere in the command is either read or written. A token with no
  // separator is only a file when a file-opening program names it, so prose and search
  // patterns are not mistaken for accesses. `@file` is curl/wget's own syntax.
  for (const token of argv) {
    const fileToken = token.startsWith('@') ? token.slice(1) : token
    const hasSeparator = /[\\/]/.test(fileToken)
    if (!hasSeparator && !FILE_READING_PROGRAMS.has(program)) continue
    // A read is placed against the directory this command runs in, and against the last
    // known one when a `cd` was not followable — the same placement a write gets, for the
    // same reason: refusing an ordinary `cat README.md` after `cd "$DIR"` would refuse
    // ordinary work while the sandbox still confines what can be written.
    const verdict = classifyPathAccess({ fence, path: fileToken, cwd: state.cwd, home, settings, mutate: false, powershell })
    if (verdict !== undefined && verdict.reason === REASON.SECRET) return verdict
  }
  // A write destination is mutated even though it is only an argument. This runs after
  // the per-token pass so that a command which both reads a secret and writes outside
  // the workspace is reported as the secret read: the more alarming fact, and the one
  // a caller can act on.
  const effects = programPathEffects(program, argv)
  for (const reference of effects.reads) {
    const verdict = classifyPathAccess({ fence, path: reference, cwd: state.cwd, home, settings, mutate: false, powershell })
    if (verdict !== undefined) return verdict
  }
  for (const destination of effects.destinations) {
    const verdict = classifyMutationTarget(destination, {
      cwd: state.cwd,
      fence,
      home,
      settings,
      powershell,
    })
    if (verdict !== undefined) return verdict
  }
  // PowerShell names a write destination as a parameter value rather than as an
  // argument to a Unix program, so the same rule is applied through the cmdlet's own
  // parameter reading. It runs after the Unix rules above so those keep their verdict.
  const powershellEffects = powershellPathEffects(program, argv)
  for (const reference of powershellEffects.reads) {
    const verdict = classifyPathAccess({ fence, path: reference, cwd: state.cwd, home, settings, mutate: false, powershell })
    if (verdict !== undefined) return verdict
  }
  for (const destination of powershellEffects.destinations) {
    const verdict = classifyMutationTarget(destination, {
      cwd: state.cwd,
      fence,
      home,
      settings,
      powershell,
    })
    if (verdict !== undefined) return verdict
  }
  return undefined
}

/**
 * Classify the redirects of one simple command.
 *
 * A redirect target is a write, whatever program produced it, and `< .env` reads a
 * file just as much as `cat .env` does — the input redirect is the one shape that
 * names a read without a program. Every target belongs to the directory this command
 * runs in.
 *
 * @param {string[]} tokens - the tokens of the command, as written.
 * @param {object} state - the shell state the command runs in.
 * @param {object} context - `{home, settings, fence}`.
 * @returns {{reason: string, detail: string} | undefined} the verdict, or undefined to allow.
 */
function classifyRedirections(tokens, state, context) {
  const { home, settings, fence = '', powershell = false } = context
  for (let position = 0; position < tokens.length; position += 1) {
    const redirect = parseRedirection(tokens[position])
    if (redirect === undefined) continue
    const { operator, attached } = redirect
    if (operator === '<<' || operator === '<<-' || operator === '<<<') {
      // A here-document or here-string is stdin: its body is data, and its word is the
      // terminator or the string, not a path.
      if (attached.length === 0) position += 1
      continue
    }
    const target = attached.length > 0 ? attached : tokens[position + 1]
    if (attached.length === 0) position += 1
    if (typeof target !== 'string' || target.length === 0) continue
    // A descriptor is not a file: `2>&1` and `3>&-` name a descriptor, not a path.
    if (isDescriptorTarget(operator, target)) continue
    const verdict =
      operator === '<' || operator === '<&'
        ? classifyPathAccess({ fence, path: target, cwd: state.cwd, home, settings, mutate: false, powershell })
        : classifyMutationTarget(target, {
            cwd: state.cwd,
            fence,
            home,
            settings,
            powershell,
          })
    if (verdict !== undefined) return verdict
  }
  return undefined
}

/**
 * Decide one tool call.
 *
 * Reads are checked against secrets only; mutations are checked against secrets
 * and state. Unknown tools are not path-checked at all: a tool this row cannot
 * classify may legitimately *name* a path it never opens (a memory record listing
 * files, for example), and a wall that guesses would refuse honest work.
 *
 * @param {object} input - `{name, args, cwd, home, settings}`.
 * @returns {{reason: string, detail: string, message: string} | undefined} the verdict.
 */
function decideToolCall(input) {
  const { name: toolName, args, cwd = '', home = '', settings } = input
  if (typeof toolName !== 'string' || settings === undefined) return undefined
  /** @type {{reason: string, detail: string} | undefined} */
  let verdict
  let subject = ''
  // A PowerShell or cmd tool reads its paths and command lines the way Windows does.
  const powershellTool = /^(?:pwsh|powershell|cmd)$/i.test(toolName)

  // The fence a mutation may not leave: the configured root when there is one, else
  // the directory the agent itself was started in. It is deliberately the *origin*
  // cwd rather than one reached by `cd` — a command that walks out of the workspace
  // and then deletes something there is exactly what this rule is for.
  const fence = settings.fenceMutations === false ? '' : settings.rootExplicit === true ? settings.root : cwd

  if (SHELL_TOOL.test(toolName)) {
    const command = args === null || typeof args !== 'object' ? undefined : args.command ?? args.cmd ?? args.script
    if (typeof command !== 'string') return undefined
    // A shell tool can be told which directory to run in, and a relative path means
    // something different there. Ignoring `workdir` classified the command against
    // the wrong directory — the same mistake as ignoring `cd`.
    const declared = args === null || typeof args !== 'object' ? undefined : args.workdir ?? args.cwd
    const shellCwd =
      typeof declared === 'string' && declared.length > 0
        ? isAbsolute(declared)
          ? declared
          : resolveTarget(declared, cwd, home, powershellTool)
        : cwd
    verdict = classifyShell(command, { cwd: shellCwd, fence, home, settings, powershell: powershellTool })
    subject = command
  } else {
    const mutate = MUTATING_TOOL.test(toolName)
    const readable = READ_ONLY_TOOL.test(toolName)
    if (!mutate && !readable) return undefined
    const paths = [...pathArguments(args), ...patchTargets(args)]
    for (const candidate of paths) {
      verdict = classifyPathAccess({ fence, path: candidate, cwd, home, settings, mutate, powershell: powershellTool })
      if (verdict !== undefined) {
        subject = candidate
        break
      }
    }
  }
  if (verdict === undefined) return undefined
  return {
    reason: verdict.reason,
    detail: verdict.detail,
    message: denialMessage(toolName, verdict, subject),
  }
}

/**
 * The prose of one denial, identical whichever rule produced it.
 *
 * Kept in one place so the `tools/execute` catch can build the same shape as a normal
 * refusal: the error code, the reason, and the instruction that a denial is final.
 *
 * @param {string} toolName - the tool that was denied.
 * @param {{reason: string, detail: string}} verdict - the rule that fired.
 * @param {string} [subject] - the command or path, for the caller's report.
 * @returns {string} the denial message.
 */
function denialMessage(toolName, verdict, subject = '') {
  return (
    `flash-guard denied ${toolName} (${verdict.reason}): ${verdict.detail}. ` +
    `This denial is deterministic and final — do not retry it, do not look for another ` +
    `route to the same target, and do not use sandbox_permissions. Report the denial ` +
    `in your final answer${subject.length === 0 ? '' : ` (${subject.slice(0, 200)})`}.`
  )
}

/**
 * Collect the path-shaped string arguments of one call.
 * @param {unknown} args - parsed tool arguments.
 * @returns {string[]} candidate paths.
 */
function pathArguments(args) {
  if (args === null || typeof args !== 'object') return []
  const found = []
  for (const [key, value] of Object.entries(args)) {
    if (!PATH_ARGUMENT.test(key)) continue
    if (typeof value === 'string' && value.length > 0) found.push(value)
    else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string' && entry.length > 0) found.push(entry)
      }
    }
  }
  return found
}

/**
 * Collect the file paths named inside a patch body.
 *
 * `apply_patch` names its targets in the body rather than in a `file_path`
 * argument, so a patch that rewrites `.git/config` or `~/.ssh/authorized_keys`
 * carried no path this wall could see.
 *
 * @param {unknown} args - parsed tool arguments.
 * @returns {string[]} candidate paths.
 */
function patchTargets(args) {
  if (args === null || typeof args !== 'object') return []
  const found = []
  for (const [key, value] of Object.entries(args)) {
    if (!PATCH_BODY_ARGUMENT.test(key) || typeof value !== 'string') continue
    for (const line of value.split('\n')) {
      const match = /^(?:\*\*\* (?:Update|Add|Delete) File: |\+\+\+ b\/|--- a\/)(.+)$/.exec(line.trim())
      if (match === null) continue
      const named = match[1].trim()
      if (named.length > 0 && named !== '/dev/null') found.push(named)
    }
  }
  return found
}

/**
 * The tool result substituted for a denied call. `next()` is never called, so no
 * tool body runs; the structured `error.info.code` lets a caller route on the
 * denial without parsing prose.
 * @param {{reason: string, message: string}} verdict - the denial.
 * @returns {object} an `isError` tool execution result.
 */
function denialResult(verdict) {
  return {
    content: [{ type: 'text', text: `Error: ${verdict.message}` }],
    isError: true,
    error: {
      message: verdict.message,
      info: { name: 'FlashGuardDeniedError', code: FLASH_GUARD_DENIED, reason: verdict.reason },
    },
  }
}

/**
 * The directory this call is acting inside.
 *
 * The agent's own `meta.cwd` is used when it has one. It often does not: agents
 * created by the workflow engine (every fleet member) carry no meta, and a wall
 * that cannot name the root it protects cannot protect it — that is precisely how
 * an `rm -rf <workspace>` once walked through this check. The fallback is the
 * process working directory, which the SDK sets to the service root for the whole
 * process, so an unknown agent still gets a real fence rather than none.
 *
 * @param {object} agent - the caller agent, when the seam provides one.
 * @param {string} fallback - the configured root, or the process cwd.
 * @returns {string} an absolute path, or an empty string.
 */
function cwdOf(agent, fallback) {
  const cwd = agent?.meta?.cwd
  if (typeof cwd === 'string' && isAbsolute(cwd)) return cwd
  return typeof fallback === 'string' && isAbsolute(fallback) ? fallback : ''
}

/**
 * Log one denial without ever failing the call because logging failed.
 * @param {object} ctx - the plugin context.
 * @param {string} message - the line to log.
 */
function logDenial(ctx, message) {
  try {
    ctx.logger?.info?.(`[flash-guard] ${message}`)
  } catch {
    // A logger is a convenience; the denial itself is the enforcement.
  }
}

/**
 * The home directory the guard expands `~` and `$HOME` against.
 *
 * A native Windows process often has no `HOME`: PowerShell and cmd set `USERPROFILE`
 * instead, and reading only `HOME` made every home-relative rule inert there — `~`
 * and `~/.ssh` expanded to nothing. `os.homedir()` is the last fallback, which also
 * keeps a caller that clears both variables behaving as before.
 *
 * @param {object} [env] - the environment, injectable for tests.
 * @returns {string} the home directory, or an empty string when none is known.
 */
function homeDirectory(env = process.env) {
  if (typeof env.HOME === 'string' && env.HOME.length > 0) return env.HOME
  if (typeof env.USERPROFILE === 'string' && env.USERPROFILE.length > 0) return env.USERPROFILE
  try {
    return homedir()
  } catch {
    return ''
  }
}

/**
 * Register the guard. One `tools/execute` wrapper, so every tool call in this
 * process — orchestrator and worker alike — passes the same wall.
 * @param {object} ctx - the Cordis context.
 * @param {object} [config] - row config, see {@link DEFAULT_SETTINGS}.
 */
function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  const home = homeDirectory()
  // The root this wall falls back to when an agent reports no cwd: the configured
  // one, else the process cwd, which the SDK has already set to the service root.
  settings.rootExplicit = typeof settings.root === 'string' && settings.root !== ''
  const root = settings.rootExplicit ? settings.root : process.cwd()
  // Write the effective fence back into the settings the classifier sees. Without
  // this the rules that ask "is this target *outside* the root?" were keyed on an
  // empty string in the default configuration — that is, they were inert in exactly
  // the deployment they exist for.
  settings.root = root
  ctx.on('tools/execute', async (exec, next) => {
    /** @type {{reason: string, detail: string} | undefined} */
    let verdict
    try {
      verdict = decideToolCall({
        name: exec?.name,
        args: exec?.arguments,
        cwd: cwdOf(exec?.agent, root),
        home,
        settings,
      })
    } catch (error) {
      // A throw here used to surface as an opaque transport error. The body still did
      // not run, but the caller could not route on it and nothing said what happened.
      // Denying instead is the fail-closed shape: same result, a reason, and the
      // exception's message so the bug can be reported.
      const detail = `the guard threw while classifying ${String(exec?.name)} (${error instanceof Error ? error.message : String(error)})`
      verdict = {
        reason: REASON.GUARD_ERROR,
        detail,
        message: denialMessage(String(exec?.name), { reason: REASON.GUARD_ERROR, detail }),
      }
    }
    if (verdict === undefined) return next()
    logDenial(ctx, `${verdict.reason} on ${String(exec?.name)}`)
    return denialResult(verdict)
  })
}

export {
  apply,
  inject,
  name,
  DEFAULT_SETTINGS,
  FLASH_GUARD_DENIED,
  REASON,
  classifyPathAccess,
  classifyShell,
  decideToolCall,
  expandHome,
  pathArguments,
  resolveSettings,
  resolveTarget,
  splitSimpleCommands,
  tokenize,
}
