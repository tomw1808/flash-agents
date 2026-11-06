/**
 * The process tree under a runtime, read from the operating system's process table.
 *
 * A worker stuck inside a tool call looks the same from the event stream whether it is
 * building or waiting forever: "reading a tool result" and a progress line that grows old.
 * The answer is in the process list — a `ninja` at 0 % CPU for twenty minutes, a headless
 * Chrome still holding a shell call's output open — so this module reads the table, finds
 * the runtime's descendants, and says what they are doing.
 *
 * Everything that touches the machine goes through an injectable `list` function, so a test
 * hands in a fake table and never depends on the real processes. A failed read is logged and
 * yields no data; it is never an error of the call being watched.
 */

import { execFile } from 'node:child_process'

/**
 * The shortest time between two reads of the process table for one runtime. Reading it costs
 * a process spawn (a second or two of PowerShell on Windows), and a stuck command is a
 * minutes-scale fact, so a read a minute is plenty and never loads a busy machine.
 */
export const SAMPLE_INTERVAL_MS = 60_000

/**
 * How long a tool call's process tree must stay quiet before it is called stuck. A cold
 * link step or a download can be silent for a minute or two; five minutes of no CPU at all
 * is a process waiting on something that is not coming.
 */
export const QUIET_WINDOW_MS = 300_000

/**
 * How much CPU time the whole tree may use over that window and still count as quiet.
 * A waiting process still wakes now and then; a second of CPU in five minutes is noise, and
 * anything more is work.
 */
export const QUIET_CPU_SECONDS = 1

/**
 * How much of a process's command line is kept. Command lines can be kilobytes (a compiler
 * invocation, an inlined script); the head says what the process is.
 */
export const COMMAND_CHARS = 300

/**
 * How far before a call's own start a process may have begun and still be that call's
 * command. `ps` reports elapsed time in whole seconds and the call's clock is this process's,
 * so a shell can look a second or two older than the tool call that started it.
 */
export const CALL_START_SLACK_MS = 2_000

/**
 * The programs that are the sandbox's own scaffolding, never the command (see
 * `isSandboxProcess`). Matched by program name only, so `bash -c 'node tools/runner.js'` is
 * still the command's own shell: its arguments merely mention a program.
 */
export const SANDBOX_PROGRAMS = new Set(['bwrap', 'bubblewrap', 'dsh'])

/** The bare-program half of `SANDBOX_PROGRAMS`, for callers that have only a name. */
export const SANDBOX_PROCESS = /^(?:bwrap|bubblewrap|dsh)$/i

/**
 * The `node` scripts that launch the sandbox: `runner.js`, and the dsh entry (`lib/bin.js`,
 * or a launcher named `dsh`). A `node` process is scaffolding only when its first script
 * argument is one of these *and* that path lies inside the dsh installation (see
 * `DSH_INSTALL_MARKER`), so a worker's own `node tools/runner.js` is the command it runs.
 */
export const SANDBOX_NODE_SCRIPTS = new Set(['runner.js', 'bin.js', 'dsh', 'dsh.js', 'dsh.mjs'])

/** Where the dsh installation lives: a node script's path holding this is the sandbox's own. */
export const DSH_INSTALL_MARKER = /@deepseek-ai[\\/]dsh|dsh-sandbox/i

/** The program a node launch starts from: only its script argument may name the sandbox. */
const NODE_PROGRAM = 'node'

/** How long one read of the process table may take before it is abandoned. */
const LIST_TIMEOUT_MS = 20_000

/** The table of a large machine is a few megabytes at most; this bounds a runaway output. */
const LIST_MAX_BUFFER = 64 * 1024 * 1024

/** The PowerShell line that lists processes on Windows; times are in 100 ns units. */
export const WINDOWS_LIST_SCRIPT =
  'Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,KernelModeTime,UserModeTime,CreationDate,CommandLine | ConvertTo-Json'

/** The `ps` columns read on macOS and Linux. */
export const PS_ARGS = ['-A', '-o', 'pid=,ppid=,time=,etime=,args=']

/** Shell names that run a command line; one with no arguments is a persistent shell. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'pwsh', 'powershell', 'cmd'])

/**
 * Parse a `ps` time column: `[[dd-]hh:]mm:ss` (etime), `hh:mm:ss`, or the macOS
 * `mm:ss.cc` / `hh:mm:ss.cc` of `time`.
 *
 * @param {string} text - the column.
 * @returns {number | undefined} seconds, or undefined when the text is not a time.
 */
export function parsePsTime(text) {
  const match = /^(?:(\d+)-)?(\d+(?::\d+){0,2}(?:\.\d+)?)$/.exec(String(text).trim())
  if (match === null) return undefined
  const days = match[1] === undefined ? 0 : Number(match[1])
  const parts = match[2].split(':').map(Number)
  let seconds = 0
  for (const part of parts) seconds = seconds * 60 + part
  return days * 86_400 + seconds
}

/**
 * Parse the output of `ps -A -o pid=,ppid=,time=,etime=,args=`.
 *
 * A command line holding a newline continues on the next line of output, so a line that does
 * not start with the four numeric columns is appended to the process before it.
 *
 * @param {string} text - the output.
 * @param {number} now - the clock `etime` is measured back from.
 * @returns {{pid: number, ppid: number, cpuSeconds: number, startedMs: number, command: string}[]} the table.
 */
export function parsePs(text, now = Date.now()) {
  const table = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line)
    const cpu = match === null ? undefined : parsePsTime(match[3])
    const elapsed = match === null ? undefined : parsePsTime(match[4])
    if (match === null || cpu === undefined || elapsed === undefined) {
      const last = table.at(-1)
      if (last !== undefined && line.trim().length > 0) last.command = `${last.command} ${line.trim()}`
      continue
    }
    table.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuSeconds: cpu,
      startedMs: now - Math.round(elapsed * 1000),
      command: (match[5] ?? '').trim(),
    })
  }
  return table
}

/**
 * A Windows `CreationDate` as epoch milliseconds: PowerShell 5.1 writes `/Date(ms)/`,
 * PowerShell 7 an ISO string, and either may come wrapped in an object with a `value`.
 *
 * @param {unknown} value - the JSON value.
 * @returns {number | undefined} the time, or undefined when it cannot be read.
 */
function windowsStart(value) {
  const raw = value !== null && typeof value === 'object' ? value.value : value
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw !== 'string') return undefined
  const legacy = /\/Date\((-?\d+)\)\//.exec(raw)
  if (legacy !== null) return Number(legacy[1])
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * Parse the JSON `Get-CimInstance Win32_Process | ConvertTo-Json` writes. One process comes
 * as a bare object, many as an array; CPU times are 100 ns units, kernel and user summed.
 *
 * @param {string} text - the output.
 * @returns {{pid: number, ppid: number, cpuSeconds: number, startedMs?: number, command: string}[]} the table.
 */
export function parseWindows(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed.length === 0) return []
  const parsed = JSON.parse(trimmed)
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const table = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const pid = Number(row.ProcessId)
    if (!Number.isInteger(pid)) continue
    const ticks = (Number(row.KernelModeTime) || 0) + (Number(row.UserModeTime) || 0)
    const startedMs = windowsStart(row.CreationDate)
    table.push({
      pid,
      ppid: Number(row.ParentProcessId) || 0,
      cpuSeconds: ticks / 10_000_000,
      ...(startedMs === undefined ? {} : { startedMs }),
      command: typeof row.CommandLine === 'string' ? row.CommandLine.trim() : '',
    })
  }
  return table
}

/** Run one command and resolve with its stdout. */
function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      args,
      { timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER, windowsHide: true },
      (error, stdout) => (error === null ? resolvePromise(String(stdout)) : reject(error)),
    )
  })
}

/**
 * Read the machine's process table.
 *
 * @param {object} [options] - injectable parts.
 * @param {string} [options.platform] - the platform to read for.
 * @param {(command: string, args: string[]) => Promise<string>} [options.exec] - runs a command.
 * @param {() => number} [options.now] - the clock.
 * @param {(message: string) => void} [options.log] - diagnostic sink.
 * @returns {Promise<{pid: number, ppid: number, cpuSeconds: number, startedMs?: number, command: string}[]>}
 *   the table; empty when it could not be read (the reason is logged).
 */
export async function listProcesses({ platform = process.platform, exec = run, now = Date.now, log = () => {} } = {}) {
  try {
    if (platform === 'win32') {
      const output = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_LIST_SCRIPT])
      return parseWindows(output)
    }
    const at = now()
    return parsePs(await exec('ps', PS_ARGS), at)
  } catch (error) {
    log(`could not read the process table: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

/**
 * Every process below `pid`, however deep, in table order. The process itself is not in it.
 *
 * @param {{pid: number, ppid: number}[]} table - the process table.
 * @param {number} pid - the root.
 * @returns {object[]} the descendants.
 */
export function descendants(table, pid) {
  const children = new Map()
  for (const entry of table) {
    const siblings = children.get(entry.ppid)
    if (siblings === undefined) children.set(entry.ppid, [entry])
    else siblings.push(entry)
  }
  const found = new Set()
  const queue = [pid]
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (child.pid === pid || found.has(child.pid)) continue
      found.add(child.pid)
      queue.push(child.pid)
    }
  }
  return table.filter((entry) => found.has(entry.pid))
}

/** A command line on one line, whitespace collapsed. */
function squash(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** A command line cut to `COMMAND_CHARS`. */
export function clipCommand(text) {
  const line = squash(text)
  return line.length <= COMMAND_CHARS ? line : `${line.slice(0, COMMAND_CHARS - 1)}…`
}

/**
 * The words of a command line, with whitespace collapsed. A token that starts with a quote is
 * kept whole (without the quotes), so a Windows install path such as
 * `"C:\Program Files\PowerShell\7\pwsh.exe"` is one word rather than `"C:\Program`.
 *
 * @param {string} command - a command line.
 * @returns {string[]} its words.
 */
function commandWords(command) {
  const line = squash(command)
  const words = []
  let index = 0
  while (index < line.length) {
    while (index < line.length && line[index] === ' ') index += 1
    if (index >= line.length) break
    if (line[index] === '"' || line[index] === "'") {
      const quote = line[index]
      const close = line.indexOf(quote, index + 1)
      if (close === -1) {
        words.push(line.slice(index + 1))
        break
      }
      words.push(line.slice(index + 1, close))
      index = close + 1
      continue
    }
    const start = index
    while (index < line.length && line[index] !== ' ') index += 1
    words.push(line.slice(start, index))
  }
  return words
}

/** The program name of a command line: its first word without directory or `.exe`. */
function programOf(command) {
  const first = commandWords(command)[0] ?? ''
  return first.split(/[\\/]/).at(-1).replace(/\.exe$/i, '').toLowerCase()
}

/**
 * The first script argument of a `node` command: the first word after the program that is
 * not an option. It is read to recognise the sandbox's launcher (see `SANDBOX_NODE_SCRIPTS`).
 *
 * @param {string} command - the command line of a node process.
 * @returns {string | undefined} the script path, or undefined when the line names none.
 */
function firstScriptOf(command) {
  const words = commandWords(command)
  for (let index = 1; index < words.length; index += 1) {
    if (!words[index].startsWith('-')) return words[index]
  }
  return undefined
}

/**
 * Whether a process is the sandbox's own scaffolding rather than the command.
 *
 * The program decides, never the whole command line: a command's own `bash -c 'node
 * tools/runner.js'` and the node process it starts are the command, not the sandbox, so the
 * call is watched. Only a sandbox program (see `SANDBOX_PROGRAMS`), or a `node` process whose
 * first script argument is the dsh entry or a `runner.js` inside the dsh installation (see
 * `SANDBOX_NODE_SCRIPTS` and `DSH_INSTALL_MARKER`), is skipped.
 *
 * @param {object} [entry] - a process-table entry.
 * @returns {boolean} true when the process belongs to the sandbox itself.
 */
export function isSandboxProcess(entry) {
  if (entry === undefined || entry === null) return false
  const command = entry.command
  const program = programOf(command)
  if (SANDBOX_PROGRAMS.has(program)) return true
  if (program !== NODE_PROGRAM) return false
  const script = firstScriptOf(command)
  if (script === undefined) return false
  const name = script.split(/[\\/]/).at(-1).replace(/\.exe$/i, '').toLowerCase()
  return SANDBOX_NODE_SCRIPTS.has(name) && DSH_INSTALL_MARKER.test(script)
}

/**
 * Whether a process's program is spelled the way Windows spells one: a path with a drive
 * letter, or a name ending in `.exe`. Only such a process is matched without case, because
 * only Windows reports `ninja.EXE` for a command written `ninja`; on POSIX a name's case is
 * its own (`Makefile` and `makefile` are different files, and so are programs).
 *
 * @param {string} command - a process's command line.
 * @returns {boolean} true when the program is Windows-spelled.
 */
function windowsSpelled(command) {
  const first = commandWords(command)[0] ?? ''
  return /^[A-Za-z]:[\\/]/.test(first) || /\.exe$/i.test(first)
}

/**
 * A command line reduced for matching: each quote becomes a space (so a quoted program or
 * script is its own words), whitespace collapsed, `.exe` dropped, and case folded only for a
 * Windows-spelled process (see `windowsSpelled`). Windows reports `ninja.EXE` for a command
 * written `ninja`, and a shell quotes its `-c` script: `bash -c'cargo test'` is as much a
 * boundary before `cargo` as `bash -c 'cargo test'`.
 *
 * @param {string} text - a command line.
 * @param {boolean} [foldCase] - compare without case (Windows-spelled processes only).
 * @returns {string} the comparable form.
 */
function comparable(text, foldCase = false) {
  const line = squash(String(text ?? '').replace(/["']/g, ' ')).replace(/\.exe\b/gi, '')
  return foldCase ? line.toLowerCase() : line
}

/**
 * The characters a command's text may follow (a token boundary) and may be followed by. A
 * command has to be a word of a process's command line, never a piece of one: `make` must not
 * match `cmake --build`. A quote is a boundary because `comparable` turns it into a space.
 */
const TOKEN_BEFORE = /[\s/\\;&|(]/
const TOKEN_AFTER = /[\s;&|)]/

/**
 * Whether a process's arguments hold the command text as its own tokens (see `comparable`).
 *
 * @param {object} entry - a process-table entry.
 * @param {string} command - the open tool call's command line.
 * @returns {boolean} true when the comparable command stands at token boundaries.
 */
function mentionsCommand(entry, command) {
  const foldCase = windowsSpelled(entry?.command)
  const own = comparable(entry?.command, foldCase)
  const wanted = comparable(command, foldCase)
  if (wanted.length === 0) return false
  for (let at = own.indexOf(wanted); at !== -1; at = own.indexOf(wanted, at + 1)) {
    const before = at === 0 ? '' : own[at - 1]
    const after = own[at + wanted.length] ?? ''
    if ((before === '' || TOKEN_BEFORE.test(before)) && (after === '' || TOKEN_AFTER.test(after))) return true
  }
  return false
}

/** Depth of a process below the top of `tree`, counted by walking parent links inside it. */
function depthInTree(tree, entry) {
  const byPid = new Map(tree.map((process) => [process.pid, process]))
  const seen = new Set()
  let depth = 0
  let current = byPid.get(entry.ppid)
  while (current !== undefined && !seen.has(current.pid)) {
    seen.add(current.pid)
    depth += 1
    current = byPid.get(current.ppid)
  }
  return depth
}

/**
 * The process that runs one command: the deepest process below the runtime whose arguments
 * hold the command text, with the sandbox's own processes skipped (see `isSandboxProcess`).
 *
 * `bwrap --unshare-pid … -- bash -c 'timeout 450 cat fifo'` and the `node …/runner.js`
 * launcher both hold a command's text, so a shallower match is not the command; the deepest
 * match is the `timeout` (or `ninja.EXE`) that actually runs it. Nothing above that process
 * is measured, which is what keeps a Windows sandbox runner's 0.7 s a minute out of the
 * quiet window.
 *
 * A root belongs to one call. `since` keeps a candidate started well before the call out —
 * with `CALL_START_SLACK_MS` for clock granularity, and a candidate with no start time
 * always allowed — so a newer call running the same command does not take an older worker's
 * process. `claimed` skips the pids other calls already own. At equal depth the youngest
 * candidate wins, because the call being placed started last.
 *
 * @param {object[]} tree - the runtime's descendants.
 * @param {string} command - the open tool call's command line.
 * @param {object} [options] - how to place the call's root.
 * @param {number} [options.since] - when the call started, in epoch milliseconds.
 * @param {Set<number>} [options.claimed] - pids that are already another call's root.
 * @returns {object | undefined} the command's own process, or undefined when none is found.
 */
export function findCommandRoot(tree, command, { since, claimed } = {}) {
  let best
  for (const entry of tree) {
    if (claimed?.has(entry.pid) === true) continue
    if (isSandboxProcess(entry) || !mentionsCommand(entry, command)) continue
    if (typeof since === 'number' && entry.startedMs !== undefined && entry.startedMs < since - CALL_START_SLACK_MS) {
      continue
    }
    const depth = depthInTree(tree, entry)
    // An unknown start cannot be shown to be the younger one, so it loses a tie.
    const started = entry.startedMs ?? -Infinity
    const bestStarted = best?.entry.startedMs ?? -Infinity
    if (best === undefined || depth > best.depth || (depth === best.depth && started > bestStarted)) {
      best = { entry, depth }
    }
  }
  return best?.entry
}

/**
 * The processes a command owns: its own process and every descendant of it.
 *
 * @param {object[]} table - the process table.
 * @param {object} root - the command's own process (see `findCommandRoot`).
 * @returns {object[]} the command's subtree.
 */
export function commandSubtree(table, root) {
  return [root, ...descendants(table, root.pid)]
}

/** Depth of every process in a command's subtree, its own process at 0. */
function depthsOf(subtree, rootPid) {
  const children = new Map()
  for (const entry of subtree) {
    const siblings = children.get(entry.ppid)
    if (siblings === undefined) children.set(entry.ppid, [entry])
    else siblings.push(entry)
  }
  const depths = new Map([[rootPid, 0]])
  const queue = [rootPid]
  while (queue.length > 0) {
    const parent = queue.shift()
    for (const child of children.get(parent) ?? []) {
      if (depths.has(child.pid)) continue
      depths.set(child.pid, (depths.get(parent) ?? 0) + 1)
      queue.push(child.pid)
    }
  }
  for (const entry of subtree) if (!depths.has(entry.pid)) depths.set(entry.pid, 0)
  return depths
}

/** Whether a process is the shell that holds a command: a bare shell, or one holding its text. */
function isCommandShell(entry, command) {
  if (!SHELLS.has(programOf(entry.command))) return false
  return squash(entry.command).split(' ').length === 1 || mentionsCommand(entry, command)
}

/** A process's command line for a child report: never a sandbox wrapper's arguments. */
function displayCommand(entry) {
  if (entry === undefined) return ''
  return isSandboxProcess(entry) ? programOf(entry.command) : clipCommand(entry.command)
}

/** A child report: the entry's own start and CPU, never one process's clock with another's CPU. */
function childReport(entry, now) {
  const startedMs = entry.startedMs === undefined ? now : entry.startedMs
  return { command: displayCommand(entry), runningMs: Math.max(0, now - startedMs), cpuSeconds: entry.cpuSeconds }
}

/**
 * The deepest idle process of a command's subtree: a leaf first, then the deepest, then the
 * one that has used least CPU. A waiting `cat` under a `timeout` is what is left.
 */
function deepestIdle(subtree, depths) {
  const parents = new Set(subtree.map((entry) => entry.ppid))
  let best
  for (const entry of subtree) {
    if (isSandboxProcess(entry)) continue
    const depth = depths.get(entry.pid) ?? 0
    const leaf = parents.has(entry.pid) ? 0 : 1
    const cpu = entry.cpuSeconds ?? 0
    if (
      best === undefined ||
      depth > best.depth ||
      (depth === best.depth && leaf > best.leaf) ||
      (depth === best.depth && leaf === best.leaf && cpu < best.cpu)
    ) {
      best = { entry, depth, leaf, cpu }
    }
  }
  return best?.entry
}

/**
 * The longest-running process of a command's subtree that is not the command's own shell or
 * a sandbox wrapper. The command's own program counts when it is not a shell, and its
 * `runningMs` and `cpuSeconds` come from that same pid.
 */
function longestRunning(subtree, command) {
  let best
  for (const entry of subtree) {
    if (isSandboxProcess(entry) || isCommandShell(entry, command)) continue
    if (entry.startedMs === undefined) continue
    if (best === undefined || entry.startedMs < best.startedMs) best = entry
  }
  return best
}

/**
 * The process whose pid a call's `child` names when the command's own text is in no process:
 * a PowerShell `-EncodedCommand` is never written out in the table, so there is nothing to
 * match. The answer is the longest-running non-scaffolding descendant of the runtime that
 * began at or after the call — or whose start could not be read, which is allowed but never
 * wins a tie — and its own pid's clock and CPU are what a report shows.
 *
 * This is a reading of the tree for the caller's benefit only. It is not evidence that the
 * command runs there, so it never starts a quiet window (see `observeTree`).
 *
 * @param {object[]} tree - the runtime's descendants.
 * @param {number | undefined} since - when the call started, in epoch milliseconds.
 * @returns {object | undefined} the process, or undefined when nothing began after the call.
 */
function fallbackChild(tree, since) {
  let best
  for (const entry of tree) {
    if (isSandboxProcess(entry)) continue
    // A start time that cannot be read is no evidence the process predates the call, so it is
    // allowed; it loses a tie to any process whose start is known (see the comparison below).
    if (typeof since === 'number' && entry.startedMs !== undefined && entry.startedMs < since) continue
    // The longest-running process is the one that started first; an unknown start cannot win.
    if (best === undefined || (entry.startedMs ?? Infinity) < (best.startedMs ?? Infinity)) best = entry
  }
  return best
}

/**
 * The `child` a status reader sees for one watched call: the deepest idle process while the
 * command is quiet, else the longest-running process of its own subtree. A call whose command
 * text is in no process falls back to the runtime's longest-running fresh descendant (see
 * `fallbackChild`), for `child` only.
 *
 * @param {object | undefined} record - the per-call tree state `observeTree` kept.
 * @param {number} now - the clock.
 * @returns {{command: string, runningMs: number, cpuSeconds: number} | undefined} the child.
 */
export function childOfCall(record, now) {
  const subtree = record?.subtree
  if (!Array.isArray(subtree) || subtree.length === 0) {
    return record?.fallback === undefined ? undefined : childReport(record.fallback, now)
  }
  const depths = record.depths ?? depthsOf(subtree, record.rootPid)
  const entry =
    record.quiet === undefined
      ? longestRunning(subtree, record.command)
      : (deepestIdle(subtree, depths) ?? longestRunning(subtree, record.command))
  return entry === undefined ? undefined : childReport(entry, now)
}

/**
 * Read one sample of a runtime's tree against what the earlier samples showed.
 *
 * Each watched call is measured from the process that runs its command down (see
 * `findCommandRoot`): sandbox wrappers and runtime processes above that process are not in
 * the count, so a runner's own CPU cannot keep a waiting build above the threshold. A pid is
 * the root of one call only: calls are placed newest-first, each over the deepest unclaimed
 * match that started at or after the call, so two workers running one command keep their own
 * processes. `quiet` is raised when that subtree's CPU grew by less than `QUIET_CPU_SECONDS`
 * and no new pid appeared since the window began, for at least `QUIET_WINDOW_MS`. A quiet
 * warning is also kept in `quiets`, which outlives the call so a result can report it after
 * the command ended.
 *
 * A command whose text is in no process at all still gets a record, holding only a fallback
 * `child` (see `fallbackChild`). It is never quiet: the fallback is not the command's process,
 * so no CPU or pid of it may speak for that command.
 *
 * Growth is counted per process against the sample the window began at, and the CPU of a
 * process that appeared since counts in full. The sandbox's own scaffolding is outside the
 * measured set even when it sits below the command's shell, so a wrapper's CPU never counts
 * for the command. A child that starts and exits between two samples is never in a table, so
 * its CPU cannot be counted; any measured pid that the previous sample did not hold is
 * therefore taken as activity itself, and restarts the quiet window.
 *
 * The held-open warning was removed: on Linux every shell call runs under its own
 * `bwrap --unshare-pid --die-with-parent`, and on Windows the shell does not wait for
 * inherited handles, so the sandbox ends a script's background children with the call and
 * the warning cannot arise.
 *
 * @param {object | undefined} previous - the state the last sample returned for this call.
 * @param {object} sample - this sample.
 * @param {number} sample.pid - the runtime's pid.
 * @param {object[]} sample.table - the process table.
 * @param {number} sample.at - when the table was read.
 * @param {{key: string, tool: string, command: string, since: number, jobId?: string, background?: boolean}[]} sample.calls
 *   the open shell calls and running background jobs, longest-running first.
 * @returns {{sampledAt: number, tree: object[], calls: Map<string, object>, quiets: object[]}} the state.
 */
export function observeTree(previous, { pid, table, at, calls }) {
  const tree = descendants(table, pid)
  const previousCalls = previous?.calls instanceof Map ? previous.calls : new Map()
  const state = { sampledAt: at, tree, calls: new Map(), quiets: [...(previous?.quiets ?? [])] }
  const claimed = new Set()
  // Newest call first: when two calls ran the same command, the one that started last owns the
  // younger process, and the older call then takes what is left rather than nothing.
  const ordered = [...calls].sort((a, b) => (b.since ?? 0) - (a.since ?? 0))
  for (const call of ordered) {
    if (typeof call.command !== 'string' || call.command.length === 0) continue
    const root = findCommandRoot(tree, call.command, { since: call.since, claimed })
    if (root === undefined) {
      const fallback = fallbackChild(tree, call.since)
      if (fallback !== undefined) {
        state.calls.set(call.key, {
          key: call.key,
          tool: call.tool,
          command: call.command,
          ...(call.jobId === undefined ? {} : { jobId: call.jobId }),
          fallback,
        })
      }
      continue
    }
    claimed.add(root.pid)
    const subtree = commandSubtree(table, root)
    const depths = depthsOf(subtree, root.pid)
    // A sandbox wrapper can sit below the command's own shell (a `bwrap` under a script, say).
    // Its CPU is the sandbox's, not the command's, so it is outside the measured set: a
    // wrapper's 1 s a minute must never keep a waiting command above the quiet threshold.
    const measured = subtree.filter((entry) => !isSandboxProcess(entry))
    const cpu = new Map(measured.map((entry) => [entry.pid, entry.cpuSeconds]))
    const pids = new Set(measured.map((entry) => entry.pid))
    const prior = previousCalls.get(call.key)
    const record = {
      key: call.key,
      tool: call.tool,
      command: call.command,
      ...(call.jobId === undefined ? {} : { jobId: call.jobId }),
      rootPid: root.pid,
      subtree,
      depths,
      baselineAt: at,
      baselineCpu: cpu,
      prevPids: pids,
    }
    if (prior !== undefined && prior.rootPid === root.pid && prior.baselineAt !== undefined) {
      record.baselineAt = prior.baselineAt
      record.baselineCpu = prior.baselineCpu
      let grew = 0
      for (const [id, seconds] of cpu) grew += Math.max(0, seconds - (prior.baselineCpu.get(id) ?? 0))
      const appeared = [...pids].some((id) => !prior.prevPids.has(id))
      const active = grew >= QUIET_CPU_SECONDS || appeared
      if (active) {
        record.baselineAt = at
        record.baselineCpu = cpu
      } else if (at - record.baselineAt >= QUIET_WINDOW_MS) {
        const longest = deepestIdle(subtree, depths) ?? longestRunning(subtree, call.command) ?? subtree[0]
        record.quiet = {
          callKey: call.key,
          command: call.command,
          ...(call.jobId === undefined ? {} : { jobId: call.jobId }),
          minutes: Math.floor((at - record.baselineAt) / 60_000),
          count: measured.length,
          longest: displayCommand(longest),
        }
        rememberQuiet(state.quiets, record.quiet)
      }
    }
    state.calls.set(call.key, record)
  }
  return state
}

/** Keep the longest-reported quiet warning for one call in a history list. */
function rememberQuiet(quiets, quiet) {
  const index = quiets.findIndex((entry) => entry.callKey === quiet.callKey)
  if (index === -1) quiets.push(quiet)
  else if (quiet.minutes >= quiets[index].minutes) quiets[index] = quiet
}

/** The warning for a command that has used no CPU for the quiet window. */
export function quietWarning(quiet) {
  // The record carries the command whole for matching (see `openCallList`); a reader gets the
  // same 300-character head every other command display shows.
  const named = clipCommand(quiet.command)
  return (
    `${quiet.jobId === undefined ? named : `${named} (background job ${quiet.jobId})`} sat with no CPU for ` +
    `${String(quiet.minutes)} min ` +
    `(process tree of ${String(quiet.count)} processes, longest-running: ${quiet.longest}); ` +
    'it may be waiting forever — check it, or flash_cancel (the change so far is kept as a patch)'
  )
}

/**
 * Samples runtimes' process tables, at most once per `SAMPLE_INTERVAL_MS` per runtime, off
 * the call path: `refresh` returns a promise nobody has to await.
 */
export class ProcessWatch {
  /**
   * @param {object} [options] - injectable parts.
   * @param {() => Promise<object[]>} [options.list] - reads the table (default the machine's).
   * @param {() => number} [options.now] - the clock.
   * @param {number} [options.intervalMs] - the shortest time between two reads of one runtime.
   * @param {(message: string) => void} [options.log] - diagnostic sink.
   */
  constructor({ list, now = Date.now, intervalMs = SAMPLE_INTERVAL_MS, log = () => {} } = {}) {
    this.list = list ?? (() => listProcesses({ log, now }))
    this.now = now
    this.intervalMs = intervalMs
    this.log = log
    /** @type {Map<number, {at: number, table: object[] | undefined, inFlight?: Promise<void>}>} */
    this.tables = new Map()
  }

  /**
   * Drop what is stored for a runtime whose session ended, so the table of a finished runtime
   * is not kept for the life of the server.
   *
   * @param {unknown} pid - the runtime's pid.
   * @returns {void}
   */
  forget(pid) {
    if (typeof pid === 'number') this.tables.delete(pid)
  }

  /**
   * Read the table for a runtime when the last read is old enough, and fold the result into
   * the activity's tree state. Never rejects.
   *
   * A quiet warning also lands in `activity.quietWarnings`, which is not dropped with
   * `activity.proc`: the result of the call can then report a warning raised while the
   * command was running, even though the command has since ended.
   *
   * @param {object} activity - the call's activity record (`runtimePid`, `openCalls`,
   *   `backgroundJobs`, `proc`, `quietWarnings`).
   * @returns {Promise<void>} settles when the read, if there was one, is folded in.
   */
  async refresh(activity) {
    const pid = activity?.runtimePid
    const calls = openCallList(activity)
    if (calls.length === 0 || typeof pid !== 'number') {
      delete activity?.proc
      return
    }
    let entry = this.tables.get(pid)
    if (entry === undefined || (this.now() - entry.at >= this.intervalMs && entry.inFlight === undefined)) {
      entry = { at: this.now(), table: entry?.table, inFlight: undefined }
      this.tables.set(pid, entry)
      const held = entry
      entry.inFlight = (async () => {
        try {
          const table = await this.list()
          // An unreadable table is no data: the last good one stays, and nothing is concluded.
          held.table = Array.isArray(table) && table.length > 0 ? table : held.table
          held.read = Array.isArray(table) && table.length > 0 ? this.now() : held.read
        } catch (error) {
          this.log(`could not sample the process tree: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          held.inFlight = undefined
        }
      })()
    }
    if (entry.inFlight !== undefined) await entry.inFlight
    // A read that lands after the session ended must not bring the tree state back.
    if (activity.runtimePid !== pid) return
    if (entry.table === undefined || entry.read === undefined) return
    if (activity.proc !== undefined && activity.proc.sampledAt >= entry.read) return
    activity.proc = observeTree(activity.proc, { pid, table: entry.table, at: entry.read, calls })
    for (const quiet of activity.proc.quiets ?? []) rememberActivityQuiet(activity, quiet)
  }
}

/**
 * Keep the longest-reported quiet warning per call on the activity, for the result that
 * outlives the process sample.
 *
 * @param {object} activity - the call's activity record.
 * @param {object} quiet - one raised quiet finding.
 * @returns {void}
 */
function rememberActivityQuiet(activity, quiet) {
  activity.quietWarnings = Array.isArray(activity.quietWarnings) ? activity.quietWarnings : []
  const index = activity.quietWarnings.findIndex((entry) => entry.callKey === quiet.callKey)
  if (index === -1) activity.quietWarnings.push({ ...quiet })
  else if (quiet.minutes >= activity.quietWarnings[index].minutes) activity.quietWarnings[index] = { ...quiet }
}

/**
 * The calls the tree reader watches, longest-running first: every open shell call, and every
 * background job whose shell call has already returned. A background job is watched from the
 * job entry a heartbeat's `current` is built from (`backgroundJobs`), so a command that was
 * moved to the background after its timeout keeps being measured while it runs.
 *
 * A command is matched whole (`matchCommand`, bounded only far above any shell's own limit)
 * and displayed clipped (the activity's `command`), so a command longer than the display width
 * is still found in the table by its tail rather than silently watched nowhere.
 */
function openCallList(activity) {
  const calls = new Map()
  for (const [key, call] of activity?.openCalls ?? []) {
    if (call.tool !== 'bash' && call.tool !== 'pwsh') continue
    calls.set(key, {
      key,
      tool: call.tool,
      command: call.matchCommand ?? call.command,
      since: call.since,
      background: call.background === true,
    })
  }
  for (const [key, job] of activity?.backgroundJobs ?? []) {
    calls.set(key, {
      key,
      tool: job.tool,
      command: job.matchCommand ?? job.command,
      since: job.since,
      jobId: job.jobId,
      background: true,
    })
  }
  return [...calls.values()].sort((a, b) => a.since - b.since)
}
