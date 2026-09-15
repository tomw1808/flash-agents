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

import { isAbsolute, join, normalize, resolve, sep } from 'node:path'

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
const COMMAND_SEPARATOR = /\s*(?:&&|\|\||;|\||\n)\s*/
/** A single-quoted or double-quoted or bare shell token. */
const SHELL_TOKEN = /"([^"]*)"|'([^']*)'|(\S+)/g

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
  /** File names no tool may read or mutate, anywhere. */
  secretFileNames: ['.netrc', '.pgpass', '.git-credentials'],
  /** Whether the `.env` family counts as secret. */
  protectEnvFiles: true,
  /** `.env` names that are templates rather than secrets. */
  envFileExceptions: ['.env.example', '.env.sample', '.env.template', '.env.dist'],
  /** Home-relative credential paths no tool may read or mutate. */
  homeProtectedPaths: ['.ssh', '.aws', '.gnupg', '.dsh', '.config/gh', '.config/gcloud', '.docker/config.json'],
  /** Whether destructive git worktree/history commands are refused. */
  blockDestructiveGit: true,
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
  const { path: candidate, cwd = '', home = '', settings, mutate } = input
  if (typeof candidate !== 'string' || candidate.length === 0) return undefined
  const resolved = resolveTarget(candidate, cwd, home)
  const base = basenameOf(resolved)

  if (settings.protectEnvFiles && ENV_FILE.test(base) && !settings.envFileExceptions.includes(base)) {
    return { reason: REASON.SECRET, detail: `the .env family is secret (${base})` }
  }
  if (settings.secretFileNames.includes(base)) {
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
  return undefined
}

/**
 * Split a shell command line into simple commands at its control operators.
 * Quoted separators are not honoured; over-splitting only ever yields *more*
 * scrutiny, which is the safe direction for a wall.
 * @param {string} command - the command string.
 * @returns {string[]} the simple commands.
 */
function splitSimpleCommands(command) {
  return command.split(COMMAND_SEPARATOR).filter((part) => part.trim().length > 0)
}

/**
 * Tokenize one simple command, unwrapping single and double quotes.
 * @param {string} simple - one simple command.
 * @returns {string[]} its tokens.
 */
function tokenize(simple) {
  const tokens = []
  SHELL_TOKEN.lastIndex = 0
  let match = SHELL_TOKEN.exec(simple)
  while (match !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
    match = SHELL_TOKEN.exec(simple)
  }
  return tokens
}

/** `find` flags that bound a deletion to a name or path pattern. */
const FIND_NARROWING = ['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex']

/** Program prefixes that merely wrap the real program. */
const PREFIX_PROGRAMS = new Set(['sudo', 'command', 'env', 'time', 'nohup', 'xargs'])
/** Programs that read a file named as an argument. */
const FILE_READING_PROGRAMS = new Set([
  'cat', 'bat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'sed', 'awk', 'cut', 'sort', 'uniq',
  'strings', 'xxd', 'od', 'base64', 'gzip', 'tar', 'zip', 'cp', 'mv', 'rm', 'install', 'scp',
  'rsync', 'curl', 'wget', 'python', 'python3', 'node', 'perl', 'ruby', 'openssl', 'git', 'docker',
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
]

/**
 * Whether a `git` invocation is one of the destructive shapes this row refuses.
 * @param {string[]} argv - the tokens of one simple command.
 * @returns {string | undefined} the offending subcommand, or undefined.
 */
function destructiveGitReason(argv) {
  const start = argv.findIndex((token) => basenameOf(token) === 'git')
  if (start < 0) return undefined
  const rest = argv.slice(start + 1).filter((token) => !token.startsWith('-'))
  const subcommand = rest[0]
  if (subcommand === undefined || !DESTRUCTIVE_GIT.some((pattern) => pattern.test(subcommand))) return undefined
  const joined = argv.slice(start).join(' ')
  if (subcommand === 'reset' && !/--hard|--merge|--keep/.test(joined)) return undefined
  if (subcommand === 'clean' && !/-[a-z]*[fdx]/.test(joined)) return undefined
  if (subcommand === 'push' && !/--force|-f\b/.test(joined)) return undefined
  if (subcommand === 'checkout' && !/\s(?:\.|--\s+\.|\*)/.test(`${joined} `)) return undefined
  if (subcommand === 'restore' && !/\s(?:\.|--\s+\.)/.test(`${joined} `)) return undefined
  return subcommand
}

/**
 * Whether an `rm` target is one whose deletion is unbounded or unrecoverable.
 * @param {string} raw - the target token.
 * @param {string} resolved - its resolved form.
 * @param {object} context - `{cwd, home, settings}`.
 * @returns {{reason: string, detail: string} | undefined} the verdict, or undefined.
 */
function classifyRmTarget(raw, resolved, context) {
  const { cwd, home, settings } = context
  // A bare glob removes the directory's whole contents.
  if (/^(?:\.\/)?(?:\*|\.\*|\{\*,\.\*\}|\*\.[A-Za-z0-9]+)$/.test(raw)) {
    return { reason: REASON.CRITICAL_RM, detail: 'removes every entry of a directory' }
  }
  if (HOME_PREFIX.test(raw) && basenameOf(expandHome(raw, home)) === basenameOf(home)) {
    return { reason: REASON.CRITICAL_RM, detail: 'removes the home directory' }
  }
  if (!isAbsolute(resolved)) {
    const pathVerdict = classifyPathAccess({ path: resolved, cwd, home, settings, mutate: true })
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
  return classifyPathAccess({ path: resolved, cwd, home, settings, mutate: true })
}

/**
 * Classify one shell command line.
 * @param {string} command - the command string a worker is about to run.
 * @param {object} context - `{cwd, home, settings}`.
 * @returns {{reason: string, detail: string} | undefined} the verdict, or undefined to allow.
 */
function classifyShell(command, context) {
  const { cwd, home, settings } = context
  if (typeof command !== 'string' || command.trim().length === 0) return undefined
  for (const simple of splitSimpleCommands(command)) {
    const tokens = tokenize(simple)
    if (tokens.length === 0) continue
    let index = 0
    while (index < tokens.length && PREFIX_PROGRAMS.has(basenameOf(tokens[index]))) index += 1
    const program = basenameOf(tokens[index] ?? '')
    const argv = tokens.slice(index)

    // Deletion does not always say `rm` with a path, so these two shapes are read
    // for what they can actually reach. A whole-tree deletion is a critical path
    // whichever program spells it; a deletion narrowed by a name or path pattern
    // is ordinary cleanup and stays allowed.
    if (tokens.some((token, at) => basenameOf(token) === 'xargs' && basenameOf(tokens[at + 1] ?? '') === 'rm')) {
      return { reason: REASON.CRITICAL_RM, detail: 'deletes whatever is piped into xargs' }
    }
    if (program === 'find') {
      const execAt = argv.findIndex((token) => token === '-exec' || token === '-execdir')
      const pipedToRm = execAt >= 0 && basenameOf(argv[execAt + 1] ?? '') === 'rm'
      const narrowed = FIND_NARROWING.some((flag) => argv.includes(flag))
      if ((argv.includes('-delete') || pipedToRm) && !narrowed) {
        return { reason: REASON.CRITICAL_RM, detail: 'deletes everything find matches' }
      }
    }
    if (program === 'rm' || program === 'rmdir' || program === 'shred') {
      const targets = argv.slice(1).filter((token) => !token.startsWith('-'))
      for (const raw of targets) {
        const resolved = resolveTarget(raw, cwd, home)
        const verdict = classifyRmTarget(raw, resolved, context)
        if (verdict !== undefined) return verdict
      }
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
      const redirect = /^(?:\d*|&)>>?(.*)$/.exec(token)
      if (redirect !== null) {
        const attached = redirect[1]
        const target = attached.length > 0 ? attached : argv[position + 1]
        if (typeof target === 'string' && target.length > 0) {
          const verdict = classifyPathAccess({ path: target, cwd, home, settings, mutate: true })
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
      const verdict = classifyPathAccess({ path: fileToken, cwd, home, settings, mutate: false })
      if (verdict !== undefined && verdict.reason === REASON.SECRET) return verdict
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
  const context = { cwd, home, settings }
  /** @type {{reason: string, detail: string} | undefined} */
  let verdict
  let subject = ''

  if (SHELL_TOOL.test(toolName)) {
    const command = args === null || typeof args !== 'object' ? undefined : args.command ?? args.cmd ?? args.script
    if (typeof command !== 'string') return undefined
    verdict = classifyShell(command, context)
    subject = command
  } else {
    const mutate = MUTATING_TOOL.test(toolName)
    const readable = READ_ONLY_TOOL.test(toolName)
    if (!mutate && !readable) return undefined
    const paths = pathArguments(args)
    for (const candidate of paths) {
      verdict = classifyPathAccess({ path: candidate, cwd, home, settings, mutate })
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
  const root = typeof settings.root === 'string' && settings.root !== '' ? settings.root : process.cwd()
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
