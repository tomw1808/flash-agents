/**
 * 0.1.12b watch tests: the nine defects the review of the process watcher confirmed by
 * tracing, and the five a second review found after them. A root belongs to one call, a
 * command matches only as a whole token, scaffolding is recognised by program rather than by
 * an argument that merely names it, a quoted program path is one word, a command in no process
 * still gets a child, a background job nobody waits on is still listed, a call without a
 * progress token is still sampled, `bash -c` strips its script's plumbing, and the quiet and
 * end-with-background warnings reach the result of a real `flash_task` and `flash_batch`. The
 * second review's fixes: a command longer than the display cut is still matched whole, a quote
 * is a token boundary, a fallback child may have no start time, and a reset baseline does not
 * carry an old quiet finding.
 *
 * The process table is always a fake one and the runtime is the stand-in client below, so
 * nothing here reads a real home, a real `DSH_HOME`, the real temp state base or the real data
 * directory.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CALL_START_SLACK_MS,
  COMMAND_CHARS,
  DSH_INSTALL_MARKER,
  ProcessWatch,
  SANDBOX_NODE_SCRIPTS,
  SANDBOX_PROGRAMS,
  childOfCall,
  findCommandRoot,
  isSandboxProcess,
  observeTree,
} from '../lib/proctree.js'
import {
  FlashTaskService,
  activityWarnings,
  createActivity,
  createObserveState,
  finalActivityWarnings,
  observe,
  openCommands,
} from '../lib/service.js'
import { instructionsFor } from '../lib/index.js'
import { JOB_TOOLS } from '../lib/jobs.js'

const MIN = 60_000

/** One runtime clock for the whole file, so a fake `startedMs` is a real epoch millisecond. */
const AT = 1_700_000_000_000

/** A fake process table: the runtime (pid 100) and whatever `extra` returns below it. */
function tableWith(extra, now = AT) {
  return [{ pid: 100, ppid: 1, cpuSeconds: 30, startedMs: now - 3_600_000, command: 'node dsh runtime' }, ...extra]
}

/**
 * One observer session with `parent` and `child`, as the service's own event path makes it.
 * `event` feeds a worker event; `call` opens and closes one shell call.
 */
function makeObserved() {
  const state = createObserveState()
  state.activity = createActivity(AT)
  const completion = { resolve: () => {}, reject: () => {} }
  const send = (method, params) => observe(state, method, params, 'parent', completion, () => {})
  send('subagent.started', { parentSessionId: 'parent', childSessionId: 'child' })
  const event = (type, data) => send('session.event', { sessionId: 'child', event: { type, data } })
  return { state, send, event }
}

test('two calls running one command get one root each, the newer call the younger process', () => {
  const table = tableWith([
    { pid: 200, ppid: 100, cpuSeconds: 1, startedMs: AT - 240_000, command: "bash -c 'npm test'" },
    { pid: 201, ppid: 200, cpuSeconds: 0.1, startedMs: AT - 239_000, command: 'npm test' },
    { pid: 400, ppid: 100, cpuSeconds: 1, startedMs: AT - 60_000, command: "bash -c 'npm test'" },
    { pid: 401, ppid: 400, cpuSeconds: 0.1, startedMs: AT - 59_000, command: 'npm test' },
  ])
  const calls = [
    { key: 's:old', tool: 'bash', command: 'npm test', since: AT - 250_000 },
    { key: 's:new', tool: 'bash', command: 'npm test', since: AT - 70_000 },
  ]
  const state = observeTree(undefined, { pid: 100, table, at: AT, calls })
  const roots = [...state.calls.values()].map((record) => record.rootPid)
  assert.deepEqual(roots.sort((a, b) => a - b), [201, 401], 'each call measures its own worker, not the older one twice')
  assert.equal(state.calls.get('s:new').rootPid, 401, 'the newer call owns the younger process')
  assert.equal(state.calls.get('s:old').rootPid, 201)
})

test('a candidate that began before the call is no root, and one without a start is allowed', () => {
  const old = { pid: 200, ppid: 100, cpuSeconds: 1, startedMs: AT - 600_000, command: "bash -c 'npm test'" }
  const unknown = { pid: 300, ppid: 100, cpuSeconds: 1, command: "bash -c 'npm test'" }
  assert.equal(findCommandRoot(tableWith([old]), 'npm test', { since: AT - 1_000 }), undefined)
  assert.equal(findCommandRoot(tableWith([old, unknown]), 'npm test', { since: AT - 1_000 })?.pid, 300)
  // Within the named slack the older worker is still a candidate: `ps` rounds elapsed time.
  assert.equal(findCommandRoot(tableWith([old]), 'npm test', { since: AT - 599_000 })?.pid, 200)
  assert.ok(CALL_START_SLACK_MS > 0)
  // Two matches at one depth: the younger process is the one the newer call started.
  const siblings = tableWith([
    { pid: 200, ppid: 100, cpuSeconds: 1, startedMs: AT - 4_000, command: 'npm test' },
    { pid: 300, ppid: 100, cpuSeconds: 0, startedMs: AT - 3_000, command: 'npm test' },
  ])
  assert.equal(findCommandRoot(siblings, 'npm test', { since: AT - 10_000 })?.pid, 300, 'youngest wins a tie')
})

test('a command matches at token boundaries, so make is not cmake', () => {
  const table = tableWith([
    { pid: 200, ppid: 100, cpuSeconds: 1, startedMs: AT - 5_000, command: 'cmake --build build' },
    { pid: 201, ppid: 200, cpuSeconds: 1, startedMs: AT - 4_000, command: 'cc -o app main.c' },
  ])
  assert.equal(findCommandRoot(table, 'make'), undefined, 'cmake must not answer for make')
  const withMake = tableWith([
    ...table.slice(1),
    { pid: 300, ppid: 100, cpuSeconds: 0.1, startedMs: AT - 3_000, command: '/usr/bin/make -j4' },
  ])
  assert.equal(findCommandRoot(withMake, 'make')?.pid, 300, 'a path boundary is a boundary')
})

test('scaffolding is recognised by program, not by an argument that merely names it', () => {
  const bash = { pid: 200, ppid: 100, cpuSeconds: 0, startedMs: AT - 5_000, command: "bash -c 'node tools/runner.js --build'" }
  const node = { pid: 201, ppid: 200, cpuSeconds: 0.1, startedMs: AT - 4_000, command: 'node tools/runner.js --build' }
  assert.deepEqual([...SANDBOX_PROGRAMS].sort(), ['bubblewrap', 'bwrap', 'dsh'])
  assert.equal(isSandboxProcess(bash), false, 'a shell that mentions runner.js is the command')
  assert.ok(SANDBOX_NODE_SCRIPTS.has('runner.js'))
  assert.equal(isSandboxProcess(node), false, 'a worker’s own tools/runner.js is the command')
  assert.equal(findCommandRoot(tableWith([bash, node]), 'node tools/runner.js --build')?.pid, 201)
  // The sandbox's own launcher is scaffolding, and its path is what says so.
  assert.equal(
    isSandboxProcess({ command: 'node C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\runner.js --stdio' }),
    true,
  )
  assert.equal(isSandboxProcess({ command: 'node /opt/dsh-sandbox/runner.js --stdio' }), true)
  assert.equal(isSandboxProcess({ command: 'node /opt/@deepseek-ai/dsh/lib/bin.js --serve' }), true, 'the dsh entry')
  assert.equal(isSandboxProcess({ command: 'node lib/bin.js --project' }), false, 'the same name outside the install')
  assert.ok(DSH_INSTALL_MARKER.test('@deepseek-ai/dsh'))
})

test('a quoted program path is one word, so pwsh is the command’s own shell', () => {
  const pwsh = { pid: 200, ppid: 100, cpuSeconds: 0.2, startedMs: AT - 1_000, command: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "ninja -C build"' }
  assert.equal(isSandboxProcess(pwsh), false)
  assert.equal(isSandboxProcess({ command: '"C:\\Program Files\\DeepSeek\\dsh.exe" --serve' }), true)
  const state = observeTree(undefined, {
    pid: 100,
    at: AT,
    table: tableWith([pwsh]),
    calls: [{ key: 's:c', tool: 'pwsh', command: 'ninja -C build', since: AT - 2_000 }],
  })
  const record = state.calls.get('s:c')
  assert.equal(record?.rootPid, 200)
  assert.equal(childOfCall(record, AT), undefined, 'the command’s own shell is not its child')
})

test('a command in no process still gets a child, from the runtime’s longest-running fresh work', () => {
  const since = AT - 5_000
  const table = tableWith([
    // Fresh, but the sandbox itself: never the child.
    { pid: 150, ppid: 100, cpuSeconds: 7, startedMs: AT - 4_000, command: 'bwrap --unshare-pid -- cmd' },
    // Older than the call: not its work.
    { pid: 200, ppid: 100, cpuSeconds: 2, startedMs: AT - 600_000, command: 'node old-worker.js' },
    { pid: 201, ppid: 100, cpuSeconds: 0.3, startedMs: AT - 3_000, command: 'pwsh -NoProfile -EncodedCommand ZgBvAG8A' },
    { pid: 202, ppid: 201, cpuSeconds: 0.1, startedMs: AT - 1_000, command: 'some-child.exe' },
  ])
  const call = { key: 's:c', tool: 'pwsh', command: 'pwsh -EncodedCommand ZgBvAG8A', since }
  let state = observeTree(undefined, { pid: 100, table, at: AT, calls: [call] })
  const record = state.calls.get('s:c')
  assert.equal(record?.rootPid, undefined, 'the command text is in no process')
  assert.deepEqual(childOfCall(record, AT), {
    command: 'pwsh -NoProfile -EncodedCommand ZgBvAG8A',
    runningMs: 3_000,
    cpuSeconds: 0.3,
  })
  // The fallback is for `child` only: a quiet window never starts from a process that may not
  // be running the command.
  for (let minute = 1; minute <= 6; minute += 1) {
    state = observeTree(state, { pid: 100, table, at: AT + minute * MIN, calls: [call] })
  }
  assert.equal(state.calls.get('s:c').quiet, undefined)
  assert.deepEqual(state.quiets, [])
})

test('a background job nobody waits on is listed, with its command and child', () => {
  const { state, event } = makeObserved()
  event('tool/call', { id: 'call_bg', name: 'bash', arguments: JSON.stringify({ command: 'npm run build', run_in_background: true }) })
  event('tool/result', {
    id: 'call_bg',
    name: 'bash',
    message: { content: [{ type: 'tool-result', toolCallId: 'call_bg', content: [{ type: 'text', text: 'started background job bash-7' }] }] },
  })
  const activity = state.activity
  activity.runtimePid = 100
  const [jobKey, job] = [...activity.backgroundJobs.entries()][0]
  activity.proc = observeTree(undefined, {
    pid: 100,
    at: AT,
    table: tableWith([
      { pid: 500, ppid: 100, cpuSeconds: 0.2, startedMs: job.since - 100, command: "bash -c 'npm run build'" },
      { pid: 501, ppid: 500, cpuSeconds: 0.1, startedMs: job.since, command: 'npm run build' },
    ]),
    calls: [{ key: jobKey, tool: job.tool, command: job.command, since: job.since, jobId: job.jobId, background: true }],
  })

  const [shown] = openCommands(activity, AT)
  assert.equal(shown.background, 'bash-7')
  assert.equal(shown.command, 'npm run build')
  assert.equal(shown.since, new Date(job.since).toISOString())
  assert.equal(shown.child.command, 'npm run build')

  // A wait on the same job is still one entry, not a second copy.
  event('tool/call', { id: 'call_wait', name: 'job_output', arguments: JSON.stringify({ job_id: 'bash-7', wait: true }) })
  assert.equal(openCommands(activity, AT).length, 1)
})

test('a scaffolding process below the command’s shell contributes no CPU to its quiet window', async () => {
  const command = 'ninja -C build'
  const world = { now: AT, reads: 0 }
  const since = AT - 30_000
  const table = () => [
    { pid: 100, ppid: 1, cpuSeconds: 10, startedMs: AT - 3_600_000, command: 'node dsh runtime' },
    { pid: 200, ppid: 100, cpuSeconds: 0.5, startedMs: since, command: `bash -c '${command}'` },
    { pid: 201, ppid: 200, cpuSeconds: 0, startedMs: since + 100, command },
    // Inside the command's own subtree, and busy the whole time: the sandbox's CPU.
    { pid: 202, ppid: 201, cpuSeconds: ((world.now - since) / 60_000) * 1.2, startedMs: since + 200, command: `bwrap --unshare-pid -- ${command}` },
  ]
  const watch = new ProcessWatch({
    now: () => world.now,
    list: async () => {
      world.reads += 1
      return table()
    },
  })
  const activity = createActivity(world.now)
  activity.runtimePid = 100
  activity.openCalls.set('s:c1', { session: 's', tool: 'bash', command, since })
  const step = async (ms) => {
    world.now += ms
    await watch.refresh(activity)
  }
  await step(0)
  for (let minute = 1; minute < 5; minute += 1) {
    await step(MIN)
    assert.deepEqual(activityWarnings(activity, world.now), [], `no warning after ${String(minute)} min`)
  }
  await step(MIN)
  const [warning] = activityWarnings(activity, world.now)
  assert.equal(
    warning,
    'ninja -C build sat with no CPU for 5 min (process tree of 1 processes, longest-running: ninja -C build); ' +
      'it may be waiting forever — check it, or flash_cancel (the change so far is kept as a patch)',
  )
  assert.equal(warning.includes('bwrap'), false)
})

test('bash -c scripts shed their output plumbing, so one step and its later success group', () => {
  const { state, event } = makeObserved()
  const run = (n, command, exit) => {
    const id = `call_${String(n)}`
    event('tool/call', { id, name: 'bash', arguments: JSON.stringify({ command }) })
    event('tool/result', {
      id,
      name: 'bash',
      message: { content: [{ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text: `[exit code: ${String(exit)}]` }] }] },
    })
  }
  run(1, "bash -c 'cargo test 2>&1 | tail -50'", 1)
  run(2, "bash -c 'cargo test'", 1)
  run(3, "bash -c 'cargo test 2>&1 | tail -50'", 1)
  const [warning] = activityWarnings(state.activity)
  assert.match(warning, /^"bash -c 'cargo test'" failed 3 times in this call/)

  // The later plain run of the same script is that step going through.
  run(4, "bash -c 'cargo test'", 0)
  assert.match(activityWarnings(state.activity)[0], /a later run succeeded \d+m?\d?s ago$/)
})

/** A stand-in Harness runtime: one canned script per prompt, no child process. */
class StandInClient {
  constructor(script) {
    this.script = script
    this.pid = 5150
    this.running = false
    this.prompts = []
    this.notificationHandlers = new Set()
    this.exitHandlers = new Set()
    this.diagnostics = ''
  }

  start() {
    this.running = true
    return this.pid
  }

  async initialize() {
    return { name: 'stand-in', version: '0.0.0' }
  }

  async prompt({ sessionId, text }) {
    this.prompts.push({ sessionId, text })
    queueMicrotask(() => {
      this.script({ emit: (method, params) => this.emit(method, params), sessionId }).catch(() => {})
    })
    return { messageId: `msg-${String(this.prompts.length)}` }
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  onExit(handler) {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
  }

  async shutdown() {
    this.running = false
  }

  emit(method, params) {
    for (const handler of this.notificationHandlers) handler(method, params)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The two tool events a watched call leaves behind: a quiet build, then a background command. */
async function replayChildWork(emit, child) {
  emit('session.event', {
    sessionId: child,
    event: { type: 'request/header', data: { header: { config: { provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' } } } },
  })
  emit('session.event', {
    sessionId: child,
    event: { type: 'tool/call', data: { id: 'call-build', name: 'bash', arguments: JSON.stringify({ command: 'cargo check' }) } },
  })
  // Long enough for several heartbeats, each a minute on the watcher's fake clock.
  await sleep(150)
  emit('session.event', {
    sessionId: child,
    event: {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        id: 'call-build',
        message: { content: [{ type: 'tool-result', toolCallId: 'call-build', content: [{ type: 'text', text: '[exit code: 0]' }] }] },
      },
    },
  })
  // A background command the worker never waits on: it is still running as the call ends.
  emit('session.event', {
    sessionId: child,
    event: { type: 'tool/call', data: { id: 'call-bg', name: 'bash', arguments: JSON.stringify({ command: 'npm run build' }) } },
  })
  emit('session.event', {
    sessionId: child,
    event: {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        id: 'call-bg',
        message: {
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-bg',
              content: [{ type: 'text', text: '[still running after 60000ms; moved to background job bash-3]' }],
            },
          ],
        },
      },
    },
  })
}

async function taskScript({ emit, sessionId }) {
  const child = `child-${sessionId}`
  emit('session.status', { sessionId, status: 'running' })
  emit('subagent.started', { parentSessionId: sessionId, childSessionId: child })
  await replayChildWork(emit, child)
  emit('subagent.finished', {
    parentSessionId: sessionId,
    childSessionId: child,
    status: 'ok',
    stopReason: 'completed',
    provider: 'flash',
    lastAssistantMessage: [{ type: 'text', text: 'the build was checked' }],
  })
  emit('session.status', { sessionId, status: 'idle' })
}

async function batchScript({ emit, sessionId }) {
  const child = `child-${sessionId}-0`
  emit('session.status', { sessionId, status: 'running' })
  emit('subagent.started', { parentSessionId: sessionId, childSessionId: child })
  await replayChildWork(emit, child)
  emit('subagent.finished', {
    parentSessionId: sessionId,
    childSessionId: child,
    status: 'ok',
    stopReason: 'completed',
    provider: 'flash',
    lastAssistantMessage: [{ type: 'text', text: 'worker one' }],
  })
  emit('session.event', {
    sessionId,
    event: { type: 'tool-workflow/agent-start', data: { runId: 'run-1', seq: 1, label: 'task-1', childId: child } },
  })
  emit('session.event', {
    sessionId,
    event: { type: 'tool-workflow/agent-end', data: { runId: 'run-1', seq: 1, outcome: 'completed' } },
  })
  emit('session.event', { sessionId, event: { type: 'tool-workflow/run-start', data: { runId: 'run-1', name: 'flash-batch' } } })
  emit('session.event', { sessionId, event: { type: 'tool-workflow/run-end', data: { runId: 'run-1', stopReason: 'completed' } } })
  const entries = [{ index: 0, ok: true, result: 'worker one' }]
  emit('session.event', {
    sessionId,
    event: {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'call-1' },
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              content: [{ type: 'text', text: `workflow "flash-batch" completed (1 agents).\nReturn value:\n${JSON.stringify(entries)}` }],
            },
          ],
        },
      },
    },
  })
  emit('session.status', { sessionId, status: 'idle' })
}

/**
 * A service over a fresh temporary tree and the stand-in runtime, whose process watcher runs
 * on a fake clock: every table read is one minute later, so a quiet window is reachable in
 * milliseconds. `reads` counts the table reads the service itself asked for.
 */
function makeWatchedService(script) {
  const root = mkdtempSync(join(tmpdir(), 'flash-watch-0112b-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'flash-watch-0112b-state-'))
  const client = new StandInClient(script)
  const reads = { count: 0 }
  const start = Date.now()
  let now = start
  const table = [
    { pid: 5150, ppid: 1, cpuSeconds: 40, startedMs: start - 3_600_000, command: 'node dsh runtime' },
    { pid: 5200, ppid: 5150, cpuSeconds: 1, startedMs: start, command: "bash -c 'cargo check'" },
    { pid: 5201, ppid: 5200, cpuSeconds: 0, startedMs: start + 100, command: 'cargo check' },
  ]
  const service = new FlashTaskService({
    root,
    clientFactory: () => client,
    log: () => {},
    isolate: { mode: 'none', stateDir },
    honoursModelEnv: () => true,
    earlyRetryDelayMs: 0,
    progressIntervalMs: 5,
  })
  // The service samples on its own interval; only the table it reads and the clock it reads
  // it against are the test's. `intervalMs: 0` lets every beat read, one minute apart.
  service.procWatch = new ProcessWatch({
    now: () => now,
    intervalMs: 0,
    list: async () => {
      reads.count += 1
      now += MIN
      return table
    },
  })
  return { root, client, service, reads }
}

/** The two warnings a result must carry, whatever else the call warns about. */
function assertWatcherWarnings(result) {
  const warnings = Array.isArray(result.warnings) ? result.warnings : []
  const quiet = warnings.filter((warning) => /^cargo check sat with no CPU for \d+ min /.test(warning))
  assert.equal(quiet.length, 1, warnings.join('\n'))
  const minutes = Number(/sat with no CPU for (\d+) min /.exec(quiet[0])?.[1])
  assert.ok(minutes >= 5, quiet[0])
  assert.equal(
    warnings.includes(
      'the worker ended while its background command bash-3 (npm run build) was still running; ' +
        'the sandbox stopped it, so its outcome is unknown',
    ),
    true,
    warnings.join('\n'),
  )
}

test('a flash_task without a progress token is sampled, and its result carries both warnings', async () => {
  const { root, service, reads } = makeWatchedService(taskScript)
  try {
    // No progressToken and no sender: the sample cannot depend on the notification stream.
    const result = await service.flashTask({ task: 'check the build', cwd: root })
    assert.equal(result.status, 'ok')
    assert.ok(reads.count > 0, 'the service sampled the process table without a progress token')
    assertWatcherWarnings(result)
    // A live-only warning (`activityWarnings`) would have dropped the quiet one: its call is
    // closed by the time the result is built.
    assert.equal(result.warnings.some((warning) => warning.includes('sat with no CPU')), true)
  } finally {
    await service.close()
  }
})

test('a flash_batch without a progress token is sampled, and its result carries both warnings', async () => {
  const { root, service, reads } = makeWatchedService(batchScript)
  try {
    const result = await service.flashBatch({ tasks: [{ task: 'check the build' }], cwd: root })
    assert.equal(result.status, 'ok')
    assert.ok(reads.count > 0, 'the fleet was sampled without a progress token')
    assertWatcherWarnings(result)
  } finally {
    await service.close()
  }
})

test('the fake watcher keeps the final-warning helpers honest', () => {
  // `finalActivityWarnings` reads the kept history; `activityWarnings` only live calls, which
  // is what makes the two result tests above fail if a result builder reads the wrong one.
  const activity = createActivity(AT)
  activity.quietWarnings.push({ callKey: 's:gone', command: 'cargo check', minutes: 6, count: 1, longest: 'cargo check' })
  assert.deepEqual(activityWarnings(activity, AT), [])
  assert.equal(finalActivityWarnings(activity, AT).length, 1)
})

test('a command longer than the display cut is still matched whole and watched', async () => {
  const { state, event } = makeObserved()
  // A vendored-test invocation whose excludes run far past the 300-character display cut.
  const base = 'cargo test --workspace --exclude a'
  const command = `${base}${' --exclude a'.repeat(50)}`
  assert.ok(command.length > 600, 'the command must run past the display cut')
  event('tool/call', { id: 'call_long', name: 'bash', arguments: JSON.stringify({ command }) })
  const activity = state.activity
  activity.runtimePid = 100
  const since = AT - 30_000
  for (const call of activity.openCalls.values()) call.since = since
  let now = AT
  const table = [
    { pid: 100, ppid: 1, cpuSeconds: 10, startedMs: AT - 3_600_000, command: 'node dsh runtime' },
    // Another worker's fresh build, which the fallback would show instead of this command.
    { pid: 400, ppid: 100, cpuSeconds: 0.5, startedMs: since - 1_000, command: 'cargo build --release' },
    { pid: 200, ppid: 100, cpuSeconds: 1, startedMs: since, command: `bash -c '${command}'` },
    { pid: 201, ppid: 200, cpuSeconds: 0, startedMs: since + 100, command },
  ]
  const watch = new ProcessWatch({ now: () => now, list: async () => table })
  const step = async (ms) => {
    now += ms
    await watch.refresh(activity)
  }
  await step(0)
  const record = [...activity.proc.calls.values()][0]
  assert.equal(record?.rootPid, 201, 'the process holding the command past the cut is its root')
  assert.equal(record?.fallback, undefined, 'no unrelated process answers for the command')
  for (let minute = 1; minute < 5; minute += 1) {
    await step(MIN)
    assert.deepEqual(activityWarnings(activity, now), [], `no warning after ${String(minute)} min`)
  }
  await step(MIN)
  const [warning] = activityWarnings(activity, now)
  // The quiet warning names the command at the same width the status display uses.
  assert.ok(
    warning.startsWith(`${command.slice(0, COMMAND_CHARS - 1)}… sat with no CPU for 5 min`),
    warning,
  )
  const [shown] = openCommands(activity, now)
  assert.equal(shown.command, command.slice(0, COMMAND_CHARS), 'the displayed command keeps its 300-char cut')
  assert.equal(shown.child.command, `${command.slice(0, COMMAND_CHARS - 1)}…`)
  assert.notEqual(shown.child.command, 'cargo build --release')
})

test('a quote is a token boundary, and case matters only for Windows-spelled processes', () => {
  // `bash -c'…'` has no space after the flag: the quote itself separates `-c` from the script.
  const quotedScript = { pid: 200, ppid: 100, cpuSeconds: 0, startedMs: AT - 1_000, command: "bash -c'echo a b'" }
  assert.equal(findCommandRoot(tableWith([quotedScript]), 'echo a b')?.pid, 200, 'the quote is a boundary')
  const loose = { pid: 201, ppid: 100, cpuSeconds: 0, startedMs: AT - 1_000, command: 'echo a b' }
  assert.equal(
    findCommandRoot(tableWith([loose]), 'echo "a b"')?.pid,
    201,
    'a quoted command still matches its shell words',
  )
  const pwsh = {
    pid: 202,
    ppid: 100,
    cpuSeconds: 0,
    startedMs: AT - 1_000,
    command: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "ninja -C build"',
  }
  assert.equal(findCommandRoot(tableWith([pwsh]), 'ninja -C build')?.pid, 202)
  const windows = { pid: 203, ppid: 100, cpuSeconds: 0, startedMs: AT - 1_000, command: 'NINJA.EXE -C build' }
  assert.equal(
    findCommandRoot(tableWith([windows]), 'ninja -C build')?.pid,
    203,
    'a Windows-spelled program compares without case',
  )
  const posix = { pid: 204, ppid: 100, cpuSeconds: 0, startedMs: AT - 1_000, command: 'Ninja -C build' }
  assert.equal(findCommandRoot(tableWith([posix]), 'ninja -C build'), undefined, 'a POSIX name keeps its case')
})

test('a fallback child without a start time is allowed, and loses only a tie', () => {
  const since = AT - 5_000
  const unknown = { pid: 201, ppid: 100, cpuSeconds: 0.3, command: 'pwsh -NoProfile -Command something' }
  const call = { key: 's:c', tool: 'pwsh', command: 'pwsh -EncodedCommand ZgBvAG8A', since }
  let state = observeTree(undefined, { pid: 100, table: tableWith([unknown]), at: AT, calls: [call] })
  const record = state.calls.get('s:c')
  assert.equal(record?.rootPid, undefined, 'the command text is in no process')
  assert.deepEqual(childOfCall(record, AT), {
    command: 'pwsh -NoProfile -Command something',
    runningMs: 0,
    cpuSeconds: 0.3,
  })
  // A known start beats an unknown one, whichever order the table lists them in.
  const started = {
    pid: 202,
    ppid: 100,
    cpuSeconds: 0.1,
    startedMs: since + 1_000,
    command: 'pwsh -NoProfile -Command other',
  }
  for (const table of [tableWith([unknown, started]), tableWith([started, unknown])]) {
    state = observeTree(undefined, { pid: 100, table, at: AT, calls: [call] })
    assert.equal(childOfCall(state.calls.get('s:c'), AT)?.command, 'pwsh -NoProfile -Command other')
  }
})

test('a quiet finding does not outlive the baseline it was measured over', () => {
  const call = { key: 's:c', tool: 'bash', command: 'make', since: AT - 600_000 }
  const table = tableWith([
    { pid: 200, ppid: 100, cpuSeconds: 2, startedMs: AT - 600_000, command: "bash -c 'make'" },
    { pid: 201, ppid: 200, cpuSeconds: 0.1, startedMs: AT - 599_000, command: 'make' },
  ])
  const raised = { callKey: 's:c', command: 'make', minutes: 5, count: 1, longest: 'make' }
  // A hand-built prior sample whose baseline was reset a minute ago: the old quiet finding
  // belongs to the window before the reset, and the new window has not run its five minutes.
  const previous = {
    sampledAt: AT - MIN,
    tree: table,
    quiets: [raised],
    calls: new Map([
      [
        's:c',
        {
          key: 's:c',
          tool: 'bash',
          command: 'make',
          rootPid: 201,
          baselineAt: AT - MIN,
          baselineCpu: new Map([
            [200, 2],
            [201, 0.1],
          ]),
          prevPids: new Set([200, 201]),
          quiet: raised,
        },
      ],
    ]),
  }
  const state = observeTree(previous, { pid: 100, table, at: AT, calls: [call] })
  assert.equal(state.calls.get('s:c').quiet, undefined, 'a reset baseline is not a measured quiet window')
})

test('both flash_status descriptions document the background job id', () => {
  const description = JOB_TOOLS.find((tool) => tool.name === 'flash_status')?.description ?? ''
  assert.match(description, /`background` \(the job id\)/)
  assert.match(instructionsFor(), /`background` \(the job id\)/)
})
