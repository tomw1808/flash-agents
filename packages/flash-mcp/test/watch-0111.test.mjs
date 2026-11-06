/**
 * 0.1.11 watch tests: a stuck worker is visible from the process tree, and failure warnings
 * name the real command. The process table is always a fake one; one optional smoke test
 * spawns its own `sleep` child and finds it, and skips with the probe's reason when the real
 * `ps` cannot be run (a sandbox denies it). Nothing here reads a real home, a real
 * `DSH_HOME`, the real temp state base or the real data directory.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'

import {
  COMMAND_CHARS,
  ProcessWatch,
  QUIET_WINDOW_MS,
  SAMPLE_INTERVAL_MS,
  descendants,
  listProcesses,
  observeTree,
  parsePs,
  parsePsTime,
  parseWindows,
} from '../lib/proctree.js'
import {
  activityNotes,
  activityWarnings,
  asksForFailBefore,
  createActivity,
  createObserveState,
  observe,
  openCommands,
} from '../lib/service.js'

const MIN = 60_000

test('ps times parse in every shape the columns take', () => {
  assert.equal(parsePsTime('00:05'), 5)
  assert.equal(parsePsTime('1:02:03'), 3723)
  assert.equal(parsePsTime('2-03:04:05'), 2 * 86_400 + 3 * 3600 + 4 * 60 + 5)
  assert.equal(parsePsTime('0:00.25'), 0.25)
  assert.equal(parsePsTime('12:34.50'), 754.5)
  assert.equal(parsePsTime('nonsense'), undefined)
})

test('ps output parses, with days in etime and a command line over two lines', () => {
  const now = 1_700_000_000_000
  const table = parsePs(
    [
      '    1     0   0:03.10 12-04:05:06 /sbin/launchd',
      '  500     1  00:00:12  1-00:00:10 node /srv/mcp/bin/server.js --stdio',
      '  777   500  0:00.01       05:00 bash -c cd app && cargo check',
      '  778   777  1:02.50       04:59 cmake --build build -- ninja',
      '  900   500  0:00.00       00:01 sh -c echo one',
      'two',
    ].join('\n'),
    now,
  )
  assert.equal(table.length, 5)
  assert.deepEqual(table[1], { pid: 500, ppid: 1, cpuSeconds: 12, startedMs: now - 86_410_000, command: 'node /srv/mcp/bin/server.js --stdio' })
  assert.equal(table[0].startedMs, now - (12 * 86_400 + 4 * 3600 + 5 * 60 + 6) * 1000)
  assert.equal(table[3].cpuSeconds, 62.5)
  assert.equal(table[4].command, 'sh -c echo one two', 'a continuation line belongs to the process before it')
})

test('PowerShell JSON parses for many processes and for one', () => {
  const many = JSON.stringify([
    { ProcessId: 4, ParentProcessId: 0, KernelModeTime: 20_000_000, UserModeTime: 10_000_000, CreationDate: '/Date(1700000000000)/', CommandLine: null },
    { ProcessId: 812, ParentProcessId: 4, KernelModeTime: 5_000_000, UserModeTime: 5_000_000, CreationDate: '2023-11-14T22:13:20.0000000Z', CommandLine: 'ninja -C build' },
    { ProcessId: 900, ParentProcessId: 812, KernelModeTime: 0, UserModeTime: 0, CreationDate: { value: '/Date(1700000001000)/', DisplayHint: 2 }, CommandLine: 'cmake.exe --build .' },
  ])
  const table = parseWindows(many)
  assert.equal(table.length, 3)
  assert.deepEqual(table[0], { pid: 4, ppid: 0, cpuSeconds: 3, startedMs: 1_700_000_000_000, command: '' })
  assert.equal(table[1].cpuSeconds, 1)
  assert.equal(table[1].startedMs, 1_700_000_000_000)
  assert.equal(table[2].startedMs, 1_700_000_001_000)
  const one = parseWindows(JSON.stringify({ ProcessId: 7, ParentProcessId: 1, KernelModeTime: 10_000_000, UserModeTime: 0, CreationDate: null, CommandLine: 'x' }))
  assert.deepEqual(one, [{ pid: 7, ppid: 1, cpuSeconds: 1, command: 'x' }])
  assert.deepEqual(parseWindows(''), [])
})

test('listProcesses picks the command per platform and never throws', async () => {
  const calls = []
  const exec = async (command, args) => {
    calls.push([command, args])
    return command === 'ps' ? '10 1 0:01.00 00:10 node x\n' : JSON.stringify({ ProcessId: 1, ParentProcessId: 0, KernelModeTime: 0, UserModeTime: 0, CommandLine: 'a' })
  }
  assert.equal((await listProcesses({ platform: 'linux', exec, now: () => 100_000 }))[0].pid, 10)
  assert.equal((await listProcesses({ platform: 'win32', exec }))[0].command, 'a')
  assert.equal(calls[0][0], 'ps')
  assert.deepEqual(calls[0][1], ['-A', '-o', 'pid=,ppid=,time=,etime=,args='])
  assert.equal(calls[1][0], 'powershell.exe')
  assert.match(calls[1][1].at(-1), /^Get-CimInstance Win32_Process \| Select ProcessId,ParentProcessId,KernelModeTime,UserModeTime,CreationDate,CommandLine \| ConvertTo-Json$/)
  const logs = []
  const none = await listProcesses({ platform: 'linux', exec: async () => { throw new Error('ps is gone') }, log: (line) => logs.push(line) })
  assert.deepEqual(none, [])
  assert.match(logs[0], /ps is gone/)
  assert.deepEqual(await listProcesses({ platform: 'win32', exec: async () => 'not json', log: () => {} }), [])
})

test('descendants walk the whole tree and leave the root and strangers out', () => {
  const table = [
    { pid: 1, ppid: 0 }, { pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 },
    { pid: 20, ppid: 1 }, { pid: 30, ppid: 30 },
  ]
  assert.deepEqual(descendants(table, 10).map((p) => p.pid), [11, 12])
  assert.deepEqual(descendants(table, 99), [])
  assert.deepEqual(descendants(table, 30), [])
})

/** A fake world: a clock, a table of a runtime (pid 100) running `cargo check`, and a watch over it. */
function makeWorld({ cpu = () => 0.5, extra = () => [] } = {}) {
  const world = { now: 10_000_000, reads: 0 }
  world.table = () => [
    { pid: 100, ppid: 1, cpuSeconds: 9, startedMs: world.now - 3_600_000, command: 'dsh runtime' },
    { pid: 200, ppid: 100, cpuSeconds: 0.1, startedMs: world.start, command: 'bash -c cd app && cargo check' },
    { pid: 201, ppid: 200, cpuSeconds: 0.2, startedMs: world.start + 100, command: 'cargo check' },
    { pid: 202, ppid: 201, cpuSeconds: cpu(world.now), startedMs: world.start + 200, command: 'cmake --build build -- ninja' },
    ...extra(world),
  ]
  world.start = world.now - 30_000
  world.watch = new ProcessWatch({
    now: () => world.now,
    list: async () => {
      world.reads += 1
      return world.table()
    },
  })
  world.activity = createActivity(world.now)
  world.activity.runtimePid = 100
  world.activity.openCalls.set('s:c1', { session: 's', tool: 'bash', command: 'cd app && cargo check', since: world.start })
  /** Advance the clock and take one heartbeat's look. */
  world.step = async (ms) => {
    world.now += ms
    await world.watch.refresh(world.activity)
  }
  return world
}

test('a tree that uses no CPU for the window is reported as stuck, once the window has passed', async () => {
  const world = makeWorld({ cpu: () => 0.5 })
  await world.step(0)
  for (let minute = 1; minute < 5; minute += 1) {
    await world.step(MIN)
    assert.deepEqual(activityWarnings(world.activity, world.now), [], `no warning after ${String(minute)} min`)
  }
  await world.step(MIN)
  const [warning] = activityWarnings(world.activity, world.now)
  assert.equal(
    warning,
    'cd app && cargo check sat with no CPU for 5 min (process tree of 3 processes, longest-running: cmake --build build -- ninja); ' +
      'it may be waiting forever — check it, or flash_cancel (the change so far is kept as a patch)',
  )
  assert.equal(world.reads, 6, 'one read a minute, no more')
})

test('the stuck warning is not raised while the tree uses CPU, and goes when CPU resumes or the call closes', async () => {
  const busy = makeWorld({ cpu: (now) => (now - 10_000_000) / 1000 })
  for (let minute = 0; minute < 8; minute += 1) {
    await busy.step(minute === 0 ? 0 : MIN)
    assert.deepEqual(activityWarnings(busy.activity, busy.now), [])
  }

  let resumed = false
  const world = makeWorld({ cpu: (now) => (resumed ? 100 : 0.5) })
  await world.step(0)
  for (let minute = 0; minute < 5; minute += 1) await world.step(MIN)
  assert.equal(activityWarnings(world.activity, world.now).length, 1)
  resumed = true
  await world.step(MIN)
  assert.deepEqual(activityWarnings(world.activity, world.now), [], 'CPU resumed')

  const closing = makeWorld()
  await closing.step(0)
  for (let minute = 0; minute < 5; minute += 1) await closing.step(MIN)
  assert.equal(activityWarnings(closing.activity, closing.now).length, 1)
  closing.activity.openCalls.clear()
  assert.deepEqual(activityWarnings(closing.activity, closing.now), [], 'the call closed')
  await closing.step(MIN)
  assert.equal(closing.activity.proc, undefined, 'nothing open, nothing sampled')
})

test('sampling is limited to one read per interval per runtime, shared by activities', async () => {
  const world = makeWorld()
  const other = createActivity(world.now)
  other.runtimePid = 100
  other.openCalls.set('s:c9', { session: 's', tool: 'bash', command: 'ls', since: world.now })
  await world.watch.refresh(world.activity)
  await world.watch.refresh(other)
  await world.watch.refresh(world.activity)
  assert.equal(world.reads, 1)
  world.now += SAMPLE_INTERVAL_MS - 1
  await world.watch.refresh(world.activity)
  assert.equal(world.reads, 1)
  world.now += 1
  await world.watch.refresh(world.activity)
  assert.equal(world.reads, 2)
  assert.ok(QUIET_WINDOW_MS >= 5 * MIN)
})

test('an unreadable table yields no data and no warning', async () => {
  const logs = []
  const watch = new ProcessWatch({ now: () => 1_000_000, list: async () => { throw new Error('boom') }, log: (line) => logs.push(line) })
  const activity = createActivity()
  activity.runtimePid = 100
  activity.openCalls.set('s:c', { session: 's', tool: 'bash', command: 'make', since: 0 })
  await watch.refresh(activity)
  assert.equal(activity.proc, undefined)
  assert.match(logs[0], /boom/)
})

test('current entries carry the longest-running child of the command’s own subtree', async () => {
  const world = makeWorld()
  await world.step(0)
  const [call] = openCommands(world.activity, world.now)
  // The shell that holds `cd app && cargo check` is the command's own shell; `cargo check`
  // is the longest-running process it owns.
  assert.deepEqual(call.child, { command: 'cargo check', runningMs: 29_900, cpuSeconds: 0.2 })
  assert.notEqual(call.child.command, call.command)

  // The same holds when the open command is `cargo check` alone.
  world.activity.openCalls.set('s:c1', { session: 's', tool: 'bash', command: 'cargo check', since: world.start })
  const [again] = openCommands(world.activity, world.now)
  assert.equal(again.child.command, 'cargo check')
  assert.equal(again.child.cpuSeconds, 0.2)

  const long = 'x'.repeat(2000)
  const record = observeTree(undefined, {
    pid: 100,
    at: world.now,
    calls: [{ key: 's:c1', tool: 'bash', command: 'run', since: world.start }],
    table: [
      { pid: 100, ppid: 1, cpuSeconds: 0, startedMs: world.start, command: 'rt' },
      { pid: 101, ppid: 100, cpuSeconds: 0, startedMs: world.start, command: 'bash -c run' },
      { pid: 102, ppid: 101, cpuSeconds: 0, startedMs: world.start + 5, command: long },
    ],
  })
  world.activity.proc = record
  const [clipped] = openCommands(world.activity, world.now)
  assert.equal(clipped.child.command.length, COMMAND_CHARS)
})

/** Feed one failing or passing shell call through the observer the service really uses. */
function shellRun(state, send, child, n, command, { exit = 1, text = '' } = {}) {
  const id = `call_${String(n)}`
  send('session.event', { sessionId: child, event: { type: 'tool/call', data: { id, name: 'bash', arguments: JSON.stringify({ command }) } } })
  send('session.event', {
    sessionId: child,
    event: { type: 'tool/result', data: { id, name: 'bash', message: { content: [{ type: 'text', text: `${text}\n[exit code: ${String(exit)}]` }] } } },
  })
}

function makeObserved() {
  const state = createObserveState()
  state.activity = createActivity()
  const completion = { resolve: () => {}, reject: () => {} }
  const send = (method, params) => observe(state, method, params, 'parent', completion, () => {})
  send('subagent.started', { parentSessionId: 'parent', childSessionId: 'child' })
  return { state, send, run: (n, command, options) => shellRun(state, send, 'child', n, command, options) }
}

test('spellings of one test command group together and name the command, not its wrapper', () => {
  const { state, run } = makeObserved()
  run(1, 'nice -n 19 cargo test', { text: 'test a ... FAILED' })
  run(2, 'cargo test 2>&1 | tail -50', { text: 'test b ... FAILED' })
  run(3, 'cd app && /usr/bin/time -v timeout -k 5 600 env RUST_LOG=1 cargo test; echo "exit: $?"', { text: 'error: test failed, to rerun pass `-p app`' })
  const warnings = activityWarnings(state.activity)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /^"cargo test" failed 3 times in this call \(last: exit code 1, \d+m?\d?s ago: error: test failed, to rerun pass `-p app`\); /)
  assert.equal(warnings[0].includes('"nice -n"'), false)
})

test('a later success of any spelling is mentioned', () => {
  const { state, run } = makeObserved()
  for (let n = 1; n <= 3; n += 1) run(n, 'npm run test -- --watch=false', { text: 'FAIL' })
  run(4, 'ionice -c3 nice npm run test -- --watch=false 2>&1 | tail -n 20', { exit: 0 })
  const [warning] = activityWarnings(state.activity)
  assert.match(warning, /^"npm run" failed 3 times in this call \(last: exit code 1, [^)]*\); a later run succeeded \d+m?\d?s ago$/)
})

test('exit codes of signals are explained', () => {
  const cases = [
    [137, 'exit 137 = killed by signal 9 (SIGKILL — often the out-of-memory killer or a timeout)'],
    [143, 'exit 143 = killed by signal 15 (SIGTERM'],
    [130, 'exit 130 = killed by signal 2 (SIGINT'],
    [139, 'exit 139 = killed by signal 11 (SIGSEGV'],
  ]
  for (const [code, expected] of cases) {
    const { state, run } = makeObserved()
    for (let n = 1; n <= 3; n += 1) run(n, 'mkdir -p out/x', { exit: code, text: '' })
    const [warning] = activityWarnings(state.activity)
    assert.ok(warning.includes(`(last: ${expected}`), warning)
    assert.ok(warning.startsWith('"mkdir -p" failed 3 times'), warning)
  }
  const { state, run } = makeObserved()
  for (let n = 1; n <= 3; n += 1) run(n, 'make', { exit: 2 })
  assert.match(activityWarnings(state.activity)[0], /\(last: exit code 2, /)
})

test('the last output line is the last non-empty one, clipped to 200 characters', () => {
  const { state, run } = makeObserved()
  for (let n = 1; n <= 3; n += 1) run(n, 'make', { exit: 2, text: `first\n${'z'.repeat(500)}\n\n` })
  const [warning] = activityWarnings(state.activity)
  const line = /ago: (z+…)\)/.exec(warning)?.[1]
  assert.equal(line?.length, 200)
})

test('a brief that asks for fail-before/pass-after turns a failure then success into an info line', () => {
  assert.equal(asksForFailBefore('Show each test fails before the fix'), true)
  assert.equal(asksForFailBefore('the test fail before and pass after'), true)
  assert.equal(asksForFailBefore('make sure it fails without the change'), true)
  assert.equal(asksForFailBefore('fix the parser', undefined), false)

  const { state, run } = makeObserved()
  state.activity.expectsFailBefore = true
  for (let n = 1; n <= 3; n += 1) run(n, 'cargo test', { text: 'FAILED' })
  assert.equal(activityWarnings(state.activity).length, 1, 'still failing is still a warning')
  assert.deepEqual(activityNotes(state.activity), [])
  run(4, 'cargo test 2>&1 | tail -5', { exit: 0 })
  assert.deepEqual(activityWarnings(state.activity), [])
  const notes = activityNotes(state.activity)
  assert.equal(notes.length, 1)
  assert.match(notes[0], /^"cargo test" failed 3 times and then passed \d+m?\d?s ago, as the brief asked/)

  // Without the ask, the same history stays a warning with the later run mentioned.
  const plain = makeObserved()
  for (let n = 1; n <= 3; n += 1) plain.run(n, 'cargo test', { text: 'FAILED' })
  plain.run(4, 'cargo test', { exit: 0 })
  assert.equal(activityWarnings(plain.state.activity).length, 1)
  assert.deepEqual(activityNotes(plain.state.activity), [])
})

test('grep exit 1 under a wrapper still does not count', () => {
  const { state, run } = makeObserved()
  for (let n = 1; n <= 4; n += 1) run(n, 'nice -n 5 rg foo src', { exit: 1 })
  assert.deepEqual(activityWarnings(state.activity), [])
})

test('smoke: the real process table finds a child this test spawned', { skip: process.platform === 'win32' }, async (t) => {
  // A sandbox can refuse the real `ps` (`Operation not permitted`), and `listProcesses`
  // answers [] by design. Probe once, before spawning anything, and skip with the reason
  // the probe logged. On a machine where `ps` works the probe is not empty, so the test
  // below runs and may never skip silently.
  const probeLogs = []
  const probe = await listProcesses({ log: (line) => probeLogs.push(line) })
  if (probe.length === 0) {
    t.skip(`the real process table cannot be read here: ${probeLogs[0] ?? 'ps returned no processes'}`)
    return
  }
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  try {
    const table = await listProcesses()
    const mine = descendants(table, process.pid).find((entry) => entry.pid === child.pid)
    assert.ok(mine, 'the spawned sleep is a descendant of this process')
    assert.match(mine.command, /sleep 30/)
  } finally {
    child.kill()
  }
})
