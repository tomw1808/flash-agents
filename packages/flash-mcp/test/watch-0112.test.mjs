/**
 * 0.1.12 watch tests: a command is measured from the process that runs it down, so a sandbox
 * runner's CPU never keeps a waiting build quiet; background jobs are watched too; a quiet
 * warning survives into the result; a background command still running at the end is
 * reported; and `bash -c` names its script. The process table is always a fake one. Nothing
 * here reads a real home, a real `DSH_HOME`, the real temp state base or the real data
 * directory.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ProcessWatch,
  SANDBOX_PROCESS,
  descendants,
  findCommandRoot,
} from '../lib/proctree.js'
import {
  activityNotes,
  activityWarnings,
  asksForFailBefore,
  createActivity,
  createObserveState,
  finalActivityWarnings,
  observe,
  openCommands,
} from '../lib/service.js'

const MIN = 60_000

/** A watched activity over a fake table, with one open shell call. */
function makeWorld({ table, command, tool = 'bash', now = Date.now(), runtimePid = 100 }) {
  const world = { now, reads: 0, start: now - 30_000 }
  world.table = () => table(world)
  world.watch = new ProcessWatch({
    now: () => world.now,
    list: async () => {
      world.reads += 1
      return world.table()
    },
  })
  world.activity = createActivity(world.now)
  world.activity.runtimePid = runtimePid
  world.activity.openCalls.set('s:c1', { session: 's', tool, command, since: world.start })
  world.step = async (ms) => {
    world.now += ms
    await world.watch.refresh(world.activity)
  }
  return world
}

/** One observer session with `parent` and `child`, as the service's own event path makes it. */
function makeObserved() {
  const state = createObserveState()
  state.activity = createActivity()
  const completion = { resolve: () => {}, reject: () => {} }
  const send = (method, params) => observe(state, method, params, 'parent', completion, () => {})
  send('subagent.started', { parentSessionId: 'parent', childSessionId: 'child' })
  const event = (type, data) => send('session.event', { sessionId: 'child', event: { type, data } })
  return { state, send, event }
}

/** Start one background job and leave a `job_output` wait open on it. */
function startBackgroundJob({ state, event }, { id = 'call_bg', jobId = 'pwsh-2', command = 'ninja -C build', tool = 'pwsh' } = {}) {
  event('tool/call', { id, name: tool, arguments: JSON.stringify({ command, run_in_background: true }) })
  event('tool/result', { id, name: tool, message: { content: [{ type: 'text', text: `started background job ${jobId}` }] } })
  event('tool/call', {
    id: `${id}_wait`,
    name: 'job_output',
    arguments: JSON.stringify({ job_id: jobId, wait: true }),
  })
}

test('a bwrap chain is measured from the command down, so sandbox CPU cannot keep it quiet', async () => {
  const world = makeWorld({
    command: 'timeout 450 cat fifo',
    table: (w) => [
      { pid: 100, ppid: 1, cpuSeconds: 10, startedMs: w.now - 3_600_000, command: 'dsh runtime' },
      { pid: 200, ppid: 100, cpuSeconds: (w.now - w.start) / 1000, startedMs: w.start, command: 'node /opt/dsh/launcher' },
      { pid: 201, ppid: 200, cpuSeconds: 2 + (w.now - w.start) / 1000, startedMs: w.start, command: "bwrap --unshare-pid --die-with-parent -- bash -c 'timeout 450 cat fifo'" },
      { pid: 202, ppid: 201, cpuSeconds: 0, startedMs: w.start + 100, command: "bash -c 'timeout 450 cat fifo'" },
      { pid: 203, ppid: 202, cpuSeconds: 0, startedMs: w.start + 200, command: 'timeout 450 cat fifo' },
      { pid: 204, ppid: 203, cpuSeconds: 0, startedMs: w.start + 300, command: 'cat fifo' },
    ],
  })
  // The deepest non-sandbox process whose arguments hold the command is `timeout`.
  const root = findCommandRoot(descendants(world.table(), 100), 'timeout 450 cat fifo')
  assert.equal(root?.pid, 203)
  assert.equal(root?.command, 'timeout 450 cat fifo')
  assert.equal(SANDBOX_PROCESS.test('bwrap'), true)

  await world.step(0)
  for (let minute = 1; minute <= 5; minute += 1) {
    await world.step(MIN)
    if (minute < 5) assert.deepEqual(activityWarnings(world.activity, world.now), [], `no warning after ${String(minute)} min`)
  }
  const [warning] = activityWarnings(world.activity, world.now)
  assert.equal(
    warning,
    'timeout 450 cat fifo sat with no CPU for 5 min (process tree of 2 processes, longest-running: cat fifo); ' +
      'it may be waiting forever — check it, or flash_cancel (the change so far is kept as a patch)',
  )
  const [current] = openCommands(world.activity, world.now)
  assert.deepEqual(current.child, { command: 'cat fifo', runningMs: 329_700, cpuSeconds: 0 })
  assert.equal(warning.includes('bwrap'), false)
})

test('a Windows runner using 0.7 s a minute is excluded from a waiting ninja', async () => {
  const world = makeWorld({
    command: 'ninja -C build',
    tool: 'pwsh',
    table: (w) => [
      { pid: 100, ppid: 1, cpuSeconds: 10, startedMs: w.now - 3_600_000, command: 'node dsh runtime' },
      { pid: 200, ppid: 100, cpuSeconds: ((w.now - w.start) / 60_000) * 0.7, startedMs: w.start, command: 'node C:\\sandbox\\runner.js --stdio' },
      { pid: 201, ppid: 200, cpuSeconds: 0.2, startedMs: w.start + 100, command: 'pwsh -Command "ninja -C build"' },
      { pid: 202, ppid: 201, cpuSeconds: 0, startedMs: w.start + 200, command: 'ninja.EXE -C build' },
    ],
  })
  await world.step(0)
  for (let minute = 1; minute <= 5; minute += 1) await world.step(MIN)
  const warnings = activityWarnings(world.activity, world.now)
  assert.equal(warnings.length, 1, warnings.join('\n'))
  assert.match(warnings[0], /^ninja -C build sat with no CPU for 5 min \(process tree of 1 processes, longest-running: ninja\.EXE -C build\)/)
  const [current] = openCommands(world.activity, world.now)
  assert.equal(current.child.command, 'ninja.EXE -C build', 'never the sandbox runner')
  assert.equal(current.child.cpuSeconds, 0)
})

test('a background job is watched, and the warning names its job id', async () => {
  const observed = makeObserved()
  startBackgroundJob(observed)
  const world = makeWorld({
    command: 'ninja -C build',
    table: (w) => [
      { pid: 100, ppid: 1, cpuSeconds: 10, startedMs: w.now - 3_600_000, command: 'node dsh runtime' },
      { pid: 200, ppid: 100, cpuSeconds: ((w.now - w.start) / 60_000) * 0.7, startedMs: w.start, command: 'node C:\\sandbox\\runner.js --stdio' },
      { pid: 201, ppid: 200, cpuSeconds: 0.2, startedMs: w.start + 100, command: 'pwsh -Command "ninja -C build"' },
      { pid: 202, ppid: 201, cpuSeconds: 0, startedMs: w.start + 200, command: 'ninja.EXE -C build' },
    ],
  })
  world.activity = observed.state.activity
  world.activity.runtimePid = 100
  for (const job of world.activity.backgroundJobs.values()) job.since = world.start

  await world.step(0)
  for (let minute = 1; minute <= 5; minute += 1) await world.step(MIN)
  const [shown] = openCommands(world.activity, world.now)
  assert.equal(shown.background, 'pwsh-2')
  assert.equal(shown.child.command, 'ninja.EXE -C build')

  const warnings = activityWarnings(world.activity, world.now)
  assert.equal(warnings.length, 1, warnings.join('\n'))
  assert.match(
    warnings[0],
    /^ninja -C build \(background job pwsh-2\) sat with no CPU for 5 min \(process tree of 1 processes, longest-running: ninja\.EXE -C build\)/,
  )
})

test('a loop of short python processes keeps resetting the window, and child is the pid really seen', async () => {
  let nextPid = 300
  const command = 'for i in $(seq 2000); do python3 -c sum(range(10**7)); done'
  const world = makeWorld({
    command,
    table: (w) => {
      const pid = nextPid
      nextPid += 1
      return [
        { pid: 100, ppid: 1, cpuSeconds: 10, startedMs: w.now - 3_600_000, command: 'dsh runtime' },
        { pid: 200, ppid: 100, cpuSeconds: 1, startedMs: w.start, command: `bwrap --unshare-pid -- bash -c '${command}'` },
        { pid: 201, ppid: 200, cpuSeconds: 0.1, startedMs: w.start, command: `bash -c '${command}'` },
        { pid, ppid: 201, cpuSeconds: 0.2, startedMs: w.now - 200, command: 'python3 -c sum(range(10**7))' },
      ]
    },
  })
  await world.step(0)
  for (let minute = 1; minute <= 8; minute += 1) {
    await world.step(MIN)
    assert.deepEqual(activityWarnings(world.activity, world.now), [], `no warning after ${String(minute)} min`)
  }
  const [current] = openCommands(world.activity, world.now)
  assert.equal(current.child.command, 'python3 -c sum(range(10**7))')
  assert.equal(current.child.cpuSeconds, 0.2, 'CPU belongs to the same pid')
  assert.equal(current.child.runningMs, 200, 'runningMs is that pid’s own start, not the first sighting of the command')
})

test('a quiet warning raised during the call survives into the result after the command ended', async () => {
  const world = makeWorld({
    command: 'cargo check',
    table: (w) => [
      { pid: 100, ppid: 1, cpuSeconds: 9, startedMs: w.now - 3_600_000, command: 'dsh runtime' },
      { pid: 200, ppid: 100, cpuSeconds: 0.1, startedMs: w.start, command: "bash -c 'cargo check'" },
      { pid: 201, ppid: 200, cpuSeconds: 0, startedMs: w.start + 100, command: 'cargo check' },
    ],
  })
  await world.step(0)
  for (let minute = 1; minute <= 6; minute += 1) await world.step(MIN)
  assert.equal(activityWarnings(world.activity, world.now).length, 1)

  // The command ends and `#runSession` drops the process sample; the warning is still a fact.
  world.activity.openCalls.clear()
  delete world.activity.proc
  assert.deepEqual(activityWarnings(world.activity, world.now), [], 'nothing is live any more')
  const warnings = finalActivityWarnings(world.activity, world.now)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /^cargo check sat with no CPU for 6 min \(process tree of 1 processes, longest-running: cargo check\)/)
})

test('a background command still running as its worker ends is named in the result', () => {
  const running = makeObserved()
  startBackgroundJob(running, { jobId: 'bash-1', command: 'npm run build', tool: 'bash' })
  running.send('subagent.finished', {
    parentSessionId: 'parent',
    childSessionId: 'child',
    status: 'ok',
    stopReason: 'done',
    provider: 'flash',
    lastAssistantMessage: [],
  })
  assert.equal(running.state.activity.backgroundJobs.size, 0, 'the wait is dropped with its session')
  const warnings = finalActivityWarnings(running.state.activity)
  assert.deepEqual(warnings, [
    'the worker ended while its background command bash-1 (npm run build) was still running; ' +
      'the sandbox stopped it, so its outcome is unknown',
  ])

  // A job read to a terminal status is a known outcome, not a warning.
  const finished = makeObserved()
  startBackgroundJob(finished, { jobId: 'bash-2', command: 'npm run build', tool: 'bash' })
  finished.event('tool/result', {
    id: 'call_bg_wait',
    name: 'job_output',
    message: { content: [{ type: 'text', text: 'done\n[status: succeeded (exit code: 0)]' }] },
  })
  finished.send('subagent.finished', {
    parentSessionId: 'parent',
    childSessionId: 'child',
    status: 'ok',
    stopReason: 'done',
    provider: 'flash',
    lastAssistantMessage: [],
  })
  assert.deepEqual(finalActivityWarnings(finished.state.activity), [])
})

test('bash -c, sh -c and pwsh -Command name their script, and group by it', () => {
  const { state, event } = makeObserved()
  const run = (n, command) => {
    const id = `call_${String(n)}`
    event('tool/call', { id, name: 'bash', arguments: JSON.stringify({ command }) })
    event('tool/result', {
      id,
      name: 'bash',
      message: { content: [{ type: 'text', text: '[exit code: 1]' }] },
    })
  }
  run(1, "bash -c 'npm run build'")
  run(2, "bash -c 'npm run build'")
  run(3, "bash -lc 'npm run build'")
  run(4, "bash -c 'npm run lint'")
  run(5, "bash -c 'npm run lint'")
  run(6, "bash -c 'npm run lint'")
  run(7, 'pwsh -Command "ninja -C build"')
  run(8, 'pwsh -Command "ninja -C build"')
  run(9, 'pwsh -Command "ninja -C build"')
  const long = `echo ${'a'.repeat(100)}`
  run(10, `bash -c '${long}'`)
  run(11, `bash -c '${long}'`)
  run(12, `bash -c '${long}'`)
  run(13, "sh -c 'make check'")
  run(14, "sh -c 'make check'")
  run(15, "sh -c 'make check'")

  const warnings = activityWarnings(state.activity)
  assert.equal(warnings.length, 5, warnings.join('\n'))
  assert.match(warnings[0], /^"bash -c 'npm run build'" failed 3 times in this call/)
  assert.match(warnings[1], /^"bash -c 'npm run lint'" failed 3 times in this call/)
  assert.match(warnings[2], /^"pwsh -Command 'ninja -C build'" failed 3 times in this call/)
  assert.ok(warnings[3].startsWith(`"bash -c '${long.slice(0, 60)}'" failed 3 times`), warnings[3])
  assert.match(warnings[4], /^"sh -c 'make check'" failed 3 times in this call/)
})

test('only a shell command is a fail-before check; an edit or write that later passed stays a warning', () => {
  /** Feed one failing or passing file-tool call through the observer the service really uses. */
  const fileCall = (observed, n, tool, file, { failed = false } = {}) => {
    const id = `file_${String(n)}`
    observed.event('tool/call', { id, name: tool, arguments: JSON.stringify({ file_path: file }) })
    observed.event('tool/result', {
      id,
      name: tool,
      ...(failed ? { error: { name: 'FsError', message: 'the file has not been read yet' } } : {}),
      message: { content: [{ type: 'text', text: failed ? 'the file has not been read yet' : 'done' }] },
    })
  }

  for (const tool of ['edit', 'write']) {
    const observed = makeObserved()
    observed.state.activity.expectsFailBefore = asksForFailBefore('show it fails before the fix')
    for (let n = 1; n <= 3; n += 1) fileCall(observed, n, tool, 'src/a.txt', { failed: true })
    fileCall(observed, 4, tool, 'src/a.txt')

    assert.deepEqual(activityNotes(observed.state.activity), [], `${tool} is not a fail-before check`)
    const warnings = activityWarnings(observed.state.activity)
    assert.equal(warnings.length, 1, `${tool}: ${warnings.join('\n')}`)
    assert.match(warnings[0], new RegExp(`^"${tool} src/a\\.txt" failed 3 times in this call`))
    assert.match(warnings[0], /a later run succeeded/)
    assert.equal(warnings[0].includes('as the brief asked'), false, tool)
  }

  // A shell command under the same brief is still the case the info line exists for.
  const shell = makeObserved()
  shell.state.activity.expectsFailBefore = asksForFailBefore('show it fails before the fix')
  for (let n = 1; n <= 4; n += 1) {
    const id = `shell_${String(n)}`
    shell.event('tool/call', { id, name: 'bash', arguments: JSON.stringify({ command: 'cargo test' }) })
    shell.event('tool/result', {
      id,
      name: 'bash',
      message: { content: [{ type: 'text', text: `[exit code: ${n === 4 ? '0' : '1'}]` }] },
    })
  }
  assert.deepEqual(activityWarnings(shell.state.activity), [])
  const notes = activityNotes(shell.state.activity)
  assert.equal(notes.length, 1)
  assert.match(notes[0], /^"cargo test" failed 3 times and then passed \d+m?\d?s ago, as the brief asked/)
})

test('the held-open warning and its exports are gone', async () => {
  const proctree = await import('../lib/proctree.js')
  assert.equal('heldOpenWarning' in proctree, false)
  assert.equal('HELD_OPEN_MIN_MS' in proctree, false)
  assert.equal('HELD_OPEN_COMMANDS' in proctree, false)
})
