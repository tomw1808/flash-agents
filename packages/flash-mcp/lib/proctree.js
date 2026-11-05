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
 * How long a shell call must have been open before its exited shell can be reported. A call
 * younger than this may only be between the shell ending and its result arriving.
 */
export const HELD_OPEN_MIN_MS = 30_000

/** How many leftover commands a held-open warning names. */
export const HELD_OPEN_COMMANDS = 3

/**
 * How much of a process's command line is kept. Command lines can be kilobytes (a compiler
 * invocation, an inlined script); the head says what the process is.
 */
export const COMMAND_CHARS = 300

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

/** The program name of a command line: its first word without directory or `.exe`. */
function programOf(command) {
  const first = squash(command).split(' ')[0] ?? ''
  return first.replace(/^"|"$/g, '').split(/[\\/]/).at(-1).replace(/\.exe$/i, '').toLowerCase()
}

/** Whether a process is only a shell started for a command: it holds the command text. */
function wrapsCommand(process, command) {
  const own = squash(process.command)
  const wanted = squash(command)
  if (wanted.length === 0) return false
  if (SHELLS.has(programOf(own)) && own.split(' ').length === 1) return true
  return own.includes(wanted) || (own.length > 0 && wanted.includes(own))
}

/**
 * The longest-running process of a tree that is not the open command itself: the shell
 * wrapper that holds the command text, or the command's own process, would always win and
 * say nothing new.
 *
 * @param {object[]} tree - the runtime's descendants.
 * @param {string} command - the open tool call's command line.
 * @param {number} now - the clock.
 * @returns {{command: string, runningMs: number, cpuSeconds: number} | undefined} the child.
 */
export function longestChild(tree, command, now) {
  let best
  for (const entry of tree) {
    if (entry.startedMs === undefined || wrapsCommand(entry, command)) continue
    if (best === undefined || entry.startedMs < best.startedMs) best = entry
  }
  if (best === undefined) return undefined
  return { command: clipCommand(best.command), runningMs: Math.max(0, now - best.startedMs), cpuSeconds: best.cpuSeconds }
}

/** The oldest process of a tree by start time, whatever it is. */
function oldest(tree) {
  let best
  for (const entry of tree) {
    if (entry.startedMs !== undefined && (best === undefined || entry.startedMs < best.startedMs)) best = entry
  }
  return best ?? tree[0]
}

/**
 * Read one sample of a runtime's tree against what the earlier samples showed.
 *
 * Two findings come out of it. `quiet`: the tree's CPU grew by less than `QUIET_CPU_SECONDS`
 * since the first sample of the oldest open call, and that is at least `QUIET_WINDOW_MS` ago.
 * `held`: an open shell call whose command is in no live process, while processes that
 * started after it are alive — its shell ended and something it started keeps the call open.
 * That one is only reported when the call's command was matched to a live process in an
 * earlier sample (it was seen, and is gone now) and the previous sample saw the same, because
 * a call that is just ending looks the same for a moment. A command never seen, such as one
 * the shell encoded (PowerShell `-EncodedCommand`), proves nothing and is never reported.
 *
 * Growth is counted per process against the sample the window began at, and the CPU of a
 * process that appeared since counts in full. A child that starts and exits between two
 * samples is never in a table, so its CPU cannot be counted; any pid of the tree that the
 * previous sample did not hold is therefore taken as activity itself, and restarts the quiet
 * window.
 *
 * @param {object | undefined} previous - the state the last sample returned for this call.
 * @param {object} sample - this sample.
 * @param {number} sample.pid - the runtime's pid.
 * @param {object[]} sample.table - the process table.
 * @param {number} sample.at - when the table was read.
 * @param {{key: string, tool: string, command: string, since: number, background?: boolean}[]} sample.calls
 *   the open tool calls, longest-running first.
 * @returns {{sampledAt: number, tree: object[], baseline?: object, quiet?: object, held?: object,
 *   heldCandidate?: string, seen: Set<string>}} the state.
 */
export function observeTree(previous, { pid, table, at, calls }) {
  const tree = descendants(table, pid)
  const state = { sampledAt: at, tree, seen: new Set(previous?.seen) }
  const first = calls[0]
  if (first !== undefined && tree.length > 0) {
    const cpu = new Map(tree.map((entry) => [entry.pid, entry.cpuSeconds]))
    const base = previous?.baseline
    if (base === undefined || base.callKey !== first.key) {
      state.baseline = { at, callKey: first.key, cpu }
    } else {
      let grew = 0
      for (const [id, seconds] of cpu) grew += Math.max(0, seconds - (base.cpu.get(id) ?? 0))
      const before = previous.tree === undefined ? undefined : new Set(previous.tree.map((entry) => entry.pid))
      const appeared = before !== undefined && tree.some((entry) => !before.has(entry.pid))
      const active = grew >= QUIET_CPU_SECONDS || appeared
      state.baseline = active ? { at, callKey: first.key, cpu } : base
      if (!active && at - base.at >= QUIET_WINDOW_MS) {
        state.quiet = {
          callKey: first.key,
          command: first.command,
          minutes: Math.floor((at - base.at) / 60_000),
          count: tree.length,
          longest: clipCommand((longestChild(tree, first.command, at) ?? oldest(tree)).command ?? ''),
        }
      }
    }
  }
  for (const call of calls) {
    if (call.tool !== 'bash' && call.tool !== 'pwsh') continue
    if (call.background === true) continue
    const probe = squash(call.command.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '').slice(0, 60)
    if (probe.length === 0) continue
    if (tree.some((entry) => squash(entry.command).includes(probe))) {
      state.seen.add(call.key)
      continue
    }
    if (at - call.since < HELD_OPEN_MIN_MS || !state.seen.has(call.key)) continue
    // A shell with no command line of its own may be reading the call from its input; then
    // the command text proves nothing either way.
    if (tree.some((entry) => SHELLS.has(programOf(entry.command)) && squash(entry.command).split(' ').length === 1)) continue
    const left = tree.filter((entry) => entry.startedMs !== undefined && entry.startedMs > call.since)
    if (left.length === 0) continue
    state.heldCandidate = call.key
    if (previous?.heldCandidate === call.key) {
      state.held = { callKey: call.key, command: call.command, commands: left.slice(0, HELD_OPEN_COMMANDS).map((entry) => clipCommand(entry.command)) }
    }
    break
  }
  state.seen = new Set([...state.seen].filter((key) => calls.some((call) => call.key === key)))
  return state
}

/** The warning for a tree that has used no CPU for the quiet window. */
export function quietWarning(quiet) {
  return (
    `${quiet.command} has used no CPU for ${String(quiet.minutes)} min ` +
    `(process tree of ${String(quiet.count)} processes, longest-running: ${quiet.longest}); ` +
    'it may be waiting forever — check it, or flash_cancel (the change so far is kept as a patch)'
  )
}

/** The warning for a shell call whose own shell is gone but whose children are not. */
export function heldOpenWarning(held) {
  return (
    `${held.command} finished, but processes it started (${held.commands.join(', ')}) ` +
    'are still running and may hold its output open; the call ends when they do'
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
   * @param {object} activity - the call's activity record (`runtimePid`, `openCalls`, `proc`).
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
  }
}

/** The open calls of an activity, longest-running first, as the tree reader wants them. */
function openCallList(activity) {
  const calls = []
  for (const [key, call] of activity?.openCalls ?? []) {
    calls.push({ key, tool: call.tool, command: call.command, since: call.since, background: call.background === true })
  }
  return calls.sort((a, b) => a.since - b.since)
}
