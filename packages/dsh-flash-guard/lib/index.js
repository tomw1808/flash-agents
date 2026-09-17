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
/** A `~`, `$HOME`, or `${HOME}` prefix. */
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/
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
 * Expand a `~` / `$HOME` prefix using the process home directory.
 * @param {string} value - a path that may be home-relative.
 * @param {string} home - the home directory, or an empty string when unknown.
 * @returns {string} the expanded path.
 */
function expandHome(value, home) {
  if (home.length === 0 || !HOME_PREFIX.test(value)) return value
  return value.replace(HOME_PREFIX, home)
}

/**
 * Resolve a candidate path against a working directory when one is known.
 * A relative path with no known cwd stays relative; the segment and basename
 * rules below still apply to it, which is why the result is usable either way.
 * @param {string} value - candidate path.
 * @param {string} cwd - the caller's working directory, or an empty string.
 * @param {string} home - the home directory, or an empty string.
 * @returns {string} an absolute path when it could be resolved, else the expanded value.
 */
function resolveTarget(value, cwd, home) {
  const expanded = expandHome(value, home)
  if (isAbsolute(expanded)) return normalize(expanded)
  if (cwd.length === 0) return expanded
  return normalize(resolve(cwd, expanded))
}

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
    tail.unshift(current.slice(parent.length).replace(/^[/\\]/, ''))
    current = parent
  }
  try {
    const real = realpathSync.native(current)
    return tail.length === 0 ? real : join(real, ...tail)
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
 * Whether a resolved path is one of the home-relative credential paths.
 * @param {string} resolved - the resolved path.
 * @param {string} home - the home directory, or an empty string.
 * @param {object} settings - resolved settings.
 * @returns {boolean} true when the path is a protected credential location.
 */
function isHomeProtected(resolved, home, settings) {
  if (home.length === 0) return false
  return settings.homeProtectedPaths.some((relative) => isAtOrUnder(resolved, join(home, relative)))
}

/**
 * Classify one path access. Secrets are protected against reading and writing;
 * state files are protected against writing only.
 * @param {object} input - `{path, cwd, home, settings, mutate}`.
 * @returns {{reason: string, detail: string} | undefined} the verdict, or undefined to allow.
 */
function classifyPathAccess(input) {
  const { path: candidate, cwd = '', home = '', settings, mutate, fence = '' } = input
  if (typeof candidate !== 'string' || candidate.length === 0) return undefined
  const resolved = resolveTarget(candidate, cwd, home)
  const base = basenameOf(resolved)
  // The shell expands a glob before the program ever sees it, so `.env*` and `.en?`
  // reach the same file as `.env` while reading as an ordinary pattern to a name
  // check.
  const unglobbed = base.replace(/[*?[\]]/g, '')

  if (settings.protectEnvFiles && ENV_FILE.test(unglobbed) && !settings.envFileExceptions.includes(unglobbed)) {
    return { reason: REASON.SECRET, detail: `the .env family is secret (${base})` }
  }
  if (settings.secretFileNames.includes(base) || settings.secretFileNames.includes(unglobbed)) {
    return { reason: REASON.SECRET, detail: `credential file (${base})` }
  }
  if (isHomeProtected(resolved, home, settings)) {
    return { reason: REASON.SECRET, detail: 'credential location' }
  }
  if (!mutate) return undefined
  const segments = segmentsOf(resolved)
  for (const protectedSegment of settings.protectedSegments) {
    if (segments.includes(protectedSegment)) {
      return { reason: REASON.STATE, detail: `${protectedSegment} holds repository state` }
    }
  }
  if (settings.protectedFileNames.includes(base)) {
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
    if (!isAtOrUnder(resolvedCanonical, fenceCanonical)) {
      return { reason: REASON.OUTSIDE_WORKSPACE, detail: `mutates ${resolved}, which is outside ${fence}` }
    }
  }
  return undefined
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
 * @param {string} command - the command line.
 * @returns {string[][]} one token array per simple command.
 */
function lexShell(command) {
  const commands = []
  let tokens = []
  let current = ''
  let started = false
  let quote = ''
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
  for (let at = 0; at < command.length; at += 1) {
    const char = command[at]
    if (quote !== '') {
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
    if (/\s/.test(char)) {
      endToken()
      continue
    }
    const pair = command.slice(at, at + 2)
    if (pair === '&&' || pair === '||') {
      endCommand()
      at += 1
      continue
    }
    if (char === ';' || char === '|' || char === '&' || char === '\n') {
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
 * A target the shell expands before the program ever sees it. This wall reads the
 * command line, so `$(pwd)`, `` `pwd` `` and `$VAR` are exactly what it cannot see;
 * deletion of an unknowable target is refused rather than guessed at.
 */
const SHELL_SUBSTITUTION = /\$\(|`|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/

/** Shells whose `-c` payload is another command line, so it is parsed as one. */
const SHELL_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'ash', 'pwsh', 'powershell'])

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

/** Programs whose path argument is a destination (a write), not a source. */
const WRITE_DESTINATION_PROGRAMS = new Set(['cp', 'mv', 'install', 'ln', 'rsync', 'tee', 'sed', 'dd'])

/** Programs that read a file named as an argument. */
const FIND_NARROWING = ['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex']

/** Program prefixes that merely wrap the real program. */
const PREFIX_PROGRAMS = new Set(['sudo', 'command', 'env', 'time', 'nohup', 'xargs'])
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
  if (resolved === root || isAtOrUnder(resolved, root)) return false
  if (home !== '' && isAtOrUnder(resolved, home)) return true
  if (isAtOrUnder(root, resolved)) return true
  return dirname(resolved) === dirname(root)
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
 * The path arguments that a write-shaped program creates or overwrites.
 *
 * `cp x .git/config`, `sed -i s/a/b/ .npmrc` and `tee ~/.ssh/authorized_keys` all
 * mutate a protected path while naming it as an argument, which a read-only
 * classification lets through.
 *
 * @param {string} program - the invoked program.
 * @param {string[]} argv - its tokens.
 * @returns {string[]} candidate destination paths.
 */
function writeDestinations(program, argv) {
  if (!WRITE_DESTINATION_PROGRAMS.has(program)) return []
  const values = argv.slice(1).filter((token) => !token.startsWith('-'))
  if (program === 'dd') return argv.filter((token) => token.startsWith('of=')).map((token) => token.slice(3))
  if (program === 'tee') return values
  if (program === 'sed') {
    const inPlace = argv.some((token) => token === '-i' || /^-i./.test(token))
    return inPlace ? values : []
  }
  const targetAt = argv.findIndex((token) => token === '-t' || token === '--target-directory')
  if (targetAt >= 0 && typeof argv[targetAt + 1] === 'string') return [argv[targetAt + 1]]
  return values.length === 0 ? [] : [values[values.length - 1]]
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
  const { cwd, home, settings, fence = '' } = context
  // A bare glob removes the directory's whole contents.
  if (/^(?:\.\/)?(?:\*|\.\*|\{\*,\.\*\}|\*\.[A-Za-z0-9]+)$/.test(raw)) {
    return { reason: REASON.CRITICAL_RM, detail: 'removes every entry of a directory' }
  }
  if (HOME_PREFIX.test(raw) && basenameOf(expandHome(raw, home)) === basenameOf(home)) {
    return { reason: REASON.CRITICAL_RM, detail: 'removes the home directory' }
  }
  if (!isAbsolute(resolved)) {
    const pathVerdict = classifyPathAccess({ fence, path: resolved, cwd, home, settings, mutate: true })
    return pathVerdict
  }
  if (resolved === sep || /^[/\\][^/\\]+[/\\]?$/.test(resolved)) {
    return { reason: REASON.CRITICAL_RM, detail: 'removes a filesystem root' }
  }
  if (home.length > 0 && (resolved === home || isAtOrUnder(home, resolved))) {
    return { reason: REASON.CRITICAL_RM, detail: 'removes the home directory or an ancestor of it' }
  }
  if (cwd.length > 0 && (resolved === cwd || isAtOrUnder(cwd, resolved))) {
    return { reason: REASON.CRITICAL_RM, detail: 'removes the service root or an ancestor of it' }
  }
  return classifyPathAccess({ fence, path: resolved, cwd, home, settings, mutate: true })
}

/**
 * Classify one shell command line.
 * @param {string} command - the command string a worker is about to run.
 * @param {object} context - `{cwd, home, settings}`.
 * @returns {{reason: string, detail: string} | undefined} the verdict, or undefined to allow.
 */
function classifyShell(command, context) {
  const { cwd, home, settings, fence = '' } = context
  if (typeof command !== 'string' || command.trim().length === 0) return undefined
  // A `cd` earlier in the same command line moves everything after it, so the
  // commands that follow are classified against the directory it moved to. When the
  // destination is a shell expansion the move cannot be followed at all, and a
  // deletion after it is refused rather than resolved against the wrong directory.
  let effectiveCwd = cwd
  let cwdUnknown = false
  for (const tokens of splitSimpleCommands(command)) {
    if (tokens.length === 0) continue
    const simple = tokens.join(' ')
    let index = 0
    while (index < tokens.length && PREFIX_PROGRAMS.has(basenameOf(tokens[index]))) index += 1
    const program = basenameOf(tokens[index] ?? '')
    const argv = tokens.slice(index)

    if (program === 'cd' || program === 'pushd' || program === 'popd' || program === 'chdir') {
      const destination = argv.slice(1).find((token) => !token.startsWith('-'))
      if (destination === undefined) {
        effectiveCwd = home
        cwdUnknown = home === ''
      } else if (SHELL_SUBSTITUTION.test(destination)) {
        cwdUnknown = true
      } else {
        effectiveCwd = resolveTarget(destination, effectiveCwd, home)
        cwdUnknown = false
      }
      continue
    }
    // A shell running `-c '<command line>'` is another command line. Parsing it is
    // the only way `bash -c "rm -rf ."` is a deletion at all: tokenization sees
    // one quoted argument and nothing else.
    if (SHELL_PROGRAMS.has(program)) {
      const at = argv.findIndex((token) => token === '-c' || token === '-Command' || token === '/c')
      const payload = at >= 0 ? argv[at + 1] : undefined
      if (typeof payload === 'string' && payload.trim().length > 0) {
        const nested = classifyShell(payload, context)
        if (nested !== undefined) return nested
      }
    }
    // Inline code can delete without ever invoking a delete program.
    const inlineFlags = INLINE_CODE_FLAGS[program]
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
      const narrowed = FIND_NARROWING.some((flag, at) => {
        const flagAt = argv.indexOf(flag)
        if (flagAt < 0) return false
        const value = argv[flagAt + 1] ?? ''
        return !/^['"]?\*['"]?$/.test(value) && value.length > 0
      })
      if ((argv.includes('-delete') || pipedToRm) && !narrowed) {
        return { reason: REASON.CRITICAL_RM, detail: 'deletes everything find matches' }
      }
    }
    if ((program === 'rm' || program === 'rmdir' || program === 'shred') && cwdUnknown) {
      return { reason: REASON.CRITICAL_RM, detail: `deletes after an unresolvable cd (${simple.trim().slice(0, 80)})` }
    }
    if (program === 'rm' || program === 'rmdir' || program === 'shred') {
      const targets = argv.slice(1).filter((token) => !token.startsWith('-'))
      for (const raw of targets) {
        if (SHELL_SUBSTITUTION.test(raw)) {
          return { reason: REASON.CRITICAL_RM, detail: `deletes ${raw}, which only the shell can resolve` }
        }
        const resolved = resolveTarget(raw, effectiveCwd, home)
        if (
          isOutsideRootCritical(resolved, { root: settings.root, home }) ||
          isOutsideRootCritical(effectiveCwd, { root: settings.root, home })
        ) {
          return { reason: REASON.CRITICAL_RM, detail: `deletes ${raw} outside the service root` }
        }
        const verdict = classifyRmTarget(raw, resolved, context)
        if (verdict !== undefined) return verdict
      }
    }
    // `mv` and `rsync --delete` remove things without naming a delete program:
    // `mv . /tmp/gone` empties the directory it moves, and `rsync -a --delete` makes
    // the destination match an empty source.
    if (program === 'mv' && !cwdUnknown) {
      for (const raw of argv.slice(1).filter((token) => !token.startsWith('-'))) {
        if (SHELL_SUBSTITUTION.test(raw)) {
          return { reason: REASON.CRITICAL_RM, detail: `moves ${raw}, which only the shell can resolve` }
        }
        const verdict = classifyRmTarget(raw, resolveTarget(raw, effectiveCwd, home), context)
        if (verdict !== undefined) return verdict
      }
    }
    if (program === 'rsync' && argv.includes('--delete')) {
      const destination = argv.slice(1).filter((token) => !token.startsWith('-')).pop()
      const resolved = destination === undefined ? '' : resolveTarget(destination, cwd, home)
      if (resolved.length > 0 && cwd.length > 0 && (resolved === cwd || isAtOrUnder(cwd, resolved))) {
        return { reason: REASON.CRITICAL_RM, detail: 'rsync --delete empties the service root' }
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
    for (let position = 0; position < argv.length; position += 1) {
      const token = argv[position]
      // A redirect target is a write, whatever program produced it. The target
      // may be attached (`>.env`) or a separate token (`> .env`).
      // `< .env` reads a file just as much as `cat .env` does, and the input
      // redirect is the one shape that names a read without a program.
      const input = /^(?:\d*)<(?!<)(.*)$/.exec(token)
      if (input !== null) {
        const target = input[1].length > 0 ? input[1] : argv[position + 1]
        if (typeof target === 'string' && target.length > 0) {
          const verdict = classifyPathAccess({ fence, path: target, cwd, home, settings, mutate: false })
          if (verdict !== undefined) return verdict
        }
        continue
      }
      const redirect = /^(?:\d*|&)>>?(.*)$/.exec(token)
      if (redirect !== null) {
        const attached = redirect[1]
        const target = attached.length > 0 ? attached : argv[position + 1]
        if (typeof target === 'string' && target.length > 0) {
          const verdict = classifyPathAccess({ fence, path: target, cwd, home, settings, mutate: true })
          if (verdict !== undefined) return verdict
        }
        continue
      }
      // A secret named anywhere in the command is either read or written. A
      // token with no separator is only a file when a file-opening program
      // names it, so prose and search patterns are not mistaken for accesses.
      // `@file` is curl/wget's own "read this file" syntax and is unwrapped.
      const fileToken = token.startsWith('@') ? token.slice(1) : token
      const hasSeparator = /[\\/]/.test(fileToken)
      const mentionsSecret =
        hasSeparator || FILE_READING_PROGRAMS.has(program)
          ? basenameOf(expandHome(fileToken, home))
          : undefined
      if (mentionsSecret === undefined) continue
      const verdict = classifyPathAccess({ fence, path: fileToken, cwd, home, settings, mutate: false })
      if (verdict !== undefined && verdict.reason === REASON.SECRET) return verdict
    }
    // A write destination is mutated even though it is only an argument. This runs
    // after the per-token pass so that a command which both reads a secret and writes
    // outside the workspace is reported as the secret read: the more alarming fact,
    // and the one a caller can act on.
    for (const destination of writeDestinations(program, argv)) {
      if (SHELL_SUBSTITUTION.test(destination)) continue
      const verdict = classifyPathAccess({ fence, path: destination, cwd, home, settings, mutate: true })
      if (verdict !== undefined) return verdict
    }
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
          : resolveTarget(declared, cwd, home)
        : cwd
    verdict = classifyShell(command, { cwd: shellCwd, fence, home, settings })
    subject = command
  } else {
    const mutate = MUTATING_TOOL.test(toolName)
    const readable = READ_ONLY_TOOL.test(toolName)
    if (!mutate && !readable) return undefined
    const paths = [...pathArguments(args), ...patchTargets(args)]
    for (const candidate of paths) {
      verdict = classifyPathAccess({ fence, path: candidate, cwd, home, settings, mutate })
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
    message:
      `flash-guard denied ${toolName} (${verdict.reason}): ${verdict.detail}. ` +
      `This denial is deterministic and final — do not retry it, do not look for another ` +
      `route to the same target, and do not use sandbox_permissions. Report the denial ` +
      `in your final answer${subject.length === 0 ? '' : ` (${subject.slice(0, 200)})`}.`,
  }
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
 * Register the guard. One `tools/execute` wrapper, so every tool call in this
 * process — orchestrator and worker alike — passes the same wall.
 * @param {object} ctx - the Cordis context.
 * @param {object} [config] - row config, see {@link DEFAULT_SETTINGS}.
 */
function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  const home = typeof process.env.HOME === 'string' ? process.env.HOME : ''
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
    const verdict = decideToolCall({
      name: exec?.name,
      args: exec?.arguments,
      cwd: cwdOf(exec?.agent, root),
      home,
      settings,
    })
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
