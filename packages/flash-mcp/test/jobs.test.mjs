/**
 * Background job tests: a `background: true` call answers at once under a signal the job
 * owns, and flash_status / flash_result / flash_cancel report on, collect, and stop it.
 *
 * The service is faked and the clock is injected, so nothing here starts a runtime, sends
 * a notification, or waits on wall time. `createToolCaller` is index.js's dispatch,
 * exported so it can be driven without an MCP connection.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createToolCaller } from '../lib/index.js'
import { ENDED_RETENTION_MS, JOB_TOOLS, JobRegistry } from '../lib/jobs.js'

/** A promise the test resolves or rejects itself. */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

/** Let every queued microtask and one macrotask run. */
const tick = () => new Promise((resolve) => setImmediate(resolve))

/**
 * A service stand-in: each call parks on a gate the test controls, and the job's own
 * signal rejecting the call is what a real cancellation looks like from here.
 */
class FakeService {
  constructor() {
    this.calls = []
    this.models = ['deepseek-v4.1-flash:cloud', 'minimax-m3.1-flash:cloud']
  }

  /** The same refusals the real service makes before a call starts, for the model only. */
  checkModel(args, toolName) {
    if (args?.model !== undefined && !this.models.includes(args.model)) {
      throw new Error(`model ${JSON.stringify(args.model)} is not allowed; the allowed models are ${this.models.join(', ')}`)
    }
    if (toolName === 'flash_batch' && Array.isArray(args?.tasks)) {
      for (const [index, entry] of args.tasks.entries()) {
        if (entry !== null && typeof entry === 'object' && entry.model !== undefined) {
          throw new Error(`tasks[${String(index)}] carries "model"; the model is chosen per fleet`)
        }
      }
    }
  }

  flashTask(args, ctx) {
    return this.#park('flash_task', args, ctx)
  }

  flashBatch(args, ctx) {
    return this.#park('flash_batch', args, ctx)
  }

  flashApply(args) {
    return { applied: args.patchId }
  }

  #park(kind, args, ctx) {
    const gate = deferred()
    this.calls.push({
      kind,
      args,
      signal: ctx.signal,
      progress: ctx.progress,
      progressToken: ctx.progressToken,
      // The rest of the options object, so a test can pin what the job door passes on.
      background: ctx.background,
      jobId: ctx.jobId,
      gate,
    })
    ctx.signal?.addEventListener('abort', () => gate.reject(new Error(`${kind} was cancelled by the client`)), {
      once: true,
    })
    return gate.promise
  }
}

/** A dispatcher over a fake service, a registry with an injected clock, and captured logs. */
function harness({ maxEnded, waitProgressIntervalMs } = {}) {
  const service = new FakeService()
  const logs = []
  let now = 1_000_000
  const clock = {
    advance: (ms) => {
      now += ms
    },
    get now() {
      return now
    },
  }
  const registry = new JobRegistry({
    log: (message) => logs.push(message),
    now: () => now,
    ...(maxEnded === undefined ? {} : { maxEnded }),
  })
  const call = createToolCaller({
    service,
    jobs: registry,
    log: (message) => logs.push(message),
    ...(waitProgressIntervalMs === undefined ? {} : { waitProgressIntervalMs }),
  })
  return { service, registry, logs, clock, call }
}

const payloadOf = (result) => result.structuredContent
const textOf = (result) => result.content[0].text

/** Start a background call and return the job id it answers with. */
async function start(call, name, args) {
  const result = await call(name, { ...args, background: true }, {})
  assert.equal(result.isError, undefined, textOf(result))
  return payloadOf(result).jobId
}

test('background returns a job id at once and the job ends ok with the exact result', async () => {
  const { service, registry, call } = harness()
  // The call must answer while the fake call is still parked: await on the dispatcher
  // would hang here if background were not immediate.
  const started = await call('flash_task', { task: 'write the thing', cwd: '/tmp', background: true }, {})
  const job = payloadOf(started)
  assert.match(job.jobId, /^job-[0-9a-f]{8}$/)
  assert.equal(job.kind, 'flash_task')
  assert.equal(job.state, 'running')
  assert.equal(job.label, 'write the thing')
  assert.equal(Number.isNaN(Date.parse(job.startedAt)), false)
  assert.match(job.note, /flash_result/)
  assert.match(job.note, /flash_status/)
  assert.match(job.note, /flash_cancel/)

  // The flag never reaches the service, the rest of the arguments do, and the service hears
  // the job's own progress token so its heartbeat runs for the job.
  assert.equal(service.calls.length, 1)
  assert.deepEqual(service.calls[0].args, { task: 'write the thing', cwd: '/tmp' })
  assert.equal(service.calls[0].progressToken, job.jobId)
  // The call knows it is a background job, and which job it is: the first is what keeps a
  // queued wait from being reported as holding the caller's turn, the second is what a
  // stored patch records.
  assert.equal(service.calls[0].background, true)
  assert.equal(service.calls[0].jobId, job.jobId)
  assert.equal(registry.status(job.jobId).state, 'running')

  service.calls[0].gate.resolve({ status: 'ok', message: 'done', change: { filesChanged: ['a.js'] } })
  await registry.get(job.jobId).settled

  const collected = await call('flash_result', { jobId: job.jobId }, {})
  assert.equal(collected.isError, undefined)
  const full = payloadOf(collected)
  assert.equal(full.status, 'ok')
  assert.equal(full.message, 'done')
  assert.deepEqual(full.change, { filesChanged: ['a.js'] })
  assert.deepEqual(full.job, { jobId: job.jobId, state: 'ok', elapsedMs: 0 })
  // Reading twice returns the same result.
  assert.deepEqual(payloadOf(await call('flash_result', { jobId: job.jobId }, {})), full)
})

test('a background call refuses a bad model at once, before any job exists', async () => {
  const { service, registry, call } = harness()
  const refused = await call('flash_task', { task: 'x', model: 'not-allowed:cloud', background: true }, {})
  assert.equal(refused.isError, true)
  assert.match(textOf(refused), /^flash_task failed: model "not-allowed:cloud" is not allowed/)
  assert.equal(service.calls.length, 0, 'the service was never asked to run anything')

  // The fleet's per-item refusal is raised by the same door, not left for flash_result.
  const itemRefused = await call(
    'flash_batch',
    { tasks: [{ task: 'a', model: 'minimax-m3.1-flash:cloud' }], background: true },
    {},
  )
  assert.equal(itemRefused.isError, true)
  assert.match(textOf(itemRefused), /^flash_batch failed: tasks\[0\] carries "model"; the model is chosen per fleet/)

  const status = payloadOf(await call('flash_status', {}, {}))
  assert.deepEqual(status.jobs, [], 'a refused call leaves no job to list')
  assert.equal(registry.counts().running, 0)
  assert.equal(registry.counts().ended, 0)
})

test('a background call with an allowed model still starts a job', async () => {
  const { service, registry, call } = harness()
  const started = await call(
    'flash_task',
    { task: 'x', model: 'minimax-m3.1-flash:cloud', background: true },
    {},
  )
  assert.equal(started.isError, undefined, textOf(started))
  const jobId = payloadOf(started).jobId
  assert.equal(registry.status(jobId).state, 'running')
  assert.equal(service.calls.length, 1)
  service.calls[0].gate.resolve({ status: 'ok' })
  await registry.get(jobId).settled
  assert.equal(registry.status(jobId).state, 'ok')
})

test('flash_result reports running at once and waitSeconds returns the result when it settles', async () => {
  const { service, registry, call } = harness()
  const jobId = await start(call, 'flash_task', { task: 'x' })

  const now = await call('flash_result', { jobId, waitSeconds: 0 }, {})
  assert.equal(now.isError, undefined)
  assert.deepEqual(payloadOf(now), { jobId, state: 'running', elapsedMs: 0 })

  const waiting = call('flash_result', { jobId, waitSeconds: 600 }, {})
  await tick()
  service.calls[0].gate.resolve({ status: 'ok', message: 'late' })
  const settled = await waiting
  await registry.get(jobId).settled
  assert.equal(settled.isError, undefined)
  assert.equal(payloadOf(settled).message, 'late')
  assert.equal(payloadOf(settled).job.state, 'ok')
})

test('cancelling the request carrying flash_result stops the wait and leaves the job running', async () => {
  const { registry, call } = harness()
  const jobId = await start(call, 'flash_task', { task: 'x' })
  const controller = new AbortController()

  const waiting = call('flash_result', { jobId, waitSeconds: 600 }, { signal: controller.signal })
  await tick()
  controller.abort()
  const stopped = await waiting
  assert.equal(stopped.isError, undefined)
  assert.equal(payloadOf(stopped).state, 'running')
  assert.equal(registry.status(jobId).state, 'running')
})

test('flash_result says why its wait ended: job-ended, timeout, request-cancelled, or not-waited', async () => {
  const { service, registry, call } = harness()

  // 1. The job ended while the request waited.
  const ending = await start(call, 'flash_task', { task: 'ends while waited on' })
  const waiting = call('flash_result', { jobId: ending, waitSeconds: 600 }, {})
  await tick()
  service.calls.at(-1).gate.resolve({ status: 'ok', message: 'done' })
  const settled = payloadOf(await waiting)
  assert.equal(settled.message, 'done')
  assert.equal(settled.wait.endedBy, 'job-ended')
  assert.equal(settled.wait.requestedMs, 600_000)
  assert.ok(settled.wait.waitedMs >= 0 && settled.wait.waitedMs < 600_000)

  // 2. The timer ran out with the job still running. waitSeconds is an integer, so the
  // shortest real wait is one second; the job's own clock is not what bounds it.
  const stuck = await start(call, 'flash_task', { task: 'never ends' })
  const timedOut = payloadOf(await call('flash_result', { jobId: stuck, waitSeconds: 1 }, {}))
  assert.equal(timedOut.state, 'running')
  assert.equal(timedOut.wait.endedBy, 'timeout')
  assert.equal(timedOut.wait.requestedMs, 1_000)
  assert.ok(timedOut.wait.waitedMs >= 900, `expected about a second, got ${String(timedOut.wait.waitedMs)}`)
  assert.equal(registry.status(stuck).state, 'running')

  // 3. The request carrying the call was cancelled by its client.
  const controller = new AbortController()
  const cancelled = call('flash_result', { jobId: stuck, waitSeconds: 600 }, { signal: controller.signal })
  await tick()
  controller.abort()
  const stopped = payloadOf(await cancelled)
  assert.equal(stopped.state, 'running')
  assert.equal(stopped.wait.endedBy, 'request-cancelled')
  assert.ok(stopped.wait.waitedMs < 600_000)

  // 4. Nothing was waited for: the job had already ended when the call arrived.
  const after = payloadOf(await call('flash_result', { jobId: ending, waitSeconds: 5 }, {}))
  assert.equal(after.wait.endedBy, 'not-waited')
  assert.equal(after.wait.requestedMs, 5_000)
  assert.ok(after.wait.waitedMs < 50, `a job that had already ended is not waited for, got ${String(after.wait.waitedMs)}`)
})

test('a waiting flash_result sends progress heartbeats with the job’s latest line, and stops', async () => {
  const { service, registry, call } = harness({ waitProgressIntervalMs: 10 })
  const jobId = await start(call, 'flash_task', { task: 'waits a while' })

  // Before the job has reported anything, the heartbeat says so.
  const early = []
  const earlyWait = call(
    'flash_result',
    { jobId, waitSeconds: 600 },
    { progressToken: 'tok-wait', sendProgress: (report) => early.push(report) },
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(early.length >= 1, `expected a heartbeat, saw ${String(early.length)}`)
  assert.equal(early[0].total, 600)
  assert.equal(typeof early[0].progress, 'number')
  assert.match(early[0].message, /^waiting for job-[0-9a-f]{8}: no progress yet$/)

  service.calls[0].progress({ message: 'halfway' })
  const reports = []
  const waiting = call(
    'flash_result',
    { jobId, waitSeconds: 600 },
    { progressToken: 'tok-wait', sendProgress: (report) => reports.push(report) },
  )
  await new Promise((resolve) => setTimeout(resolve, 35))
  assert.ok(reports.length >= 2, `expected progress while waiting, saw ${String(reports.length)}`)
  assert.equal(reports[0].total, 600)
  assert.match(reports.at(-1).message, /^waiting for job-[0-9a-f]{8}: halfway$/)

  // Ending the wait clears the interval: no heartbeat may arrive after the answer.
  service.calls[0].gate.resolve({ status: 'ok', message: 'done' })
  const result = payloadOf(await waiting)
  assert.equal(result.wait.endedBy, 'job-ended')
  const after = reports.length
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(reports.length, after, 'no progress after the wait ended')

  service.calls[0].gate.resolve({ status: 'ok' })
  await earlyWait
  await registry.get(jobId).settled
})

test('a heartbeat is sent only when the request carried a progress token, and a throwing sender is ignored', async () => {
  const { service, registry, call } = harness({ waitProgressIntervalMs: 5 })
  const jobId = await start(call, 'flash_task', { task: 'waits' })

  // No token: sendProgress is never called, because such a notification would be invalid.
  const withoutToken = []
  const silent = call('flash_result', { jobId, waitSeconds: 600 }, { sendProgress: (report) => withoutToken.push(report) })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(withoutToken, [])

  // A sender that throws must not turn the wait into a failure.
  let attempts = 0
  const throwing = call(
    'flash_result',
    { jobId, waitSeconds: 600 },
    {
      progressToken: 'tok-throws',
      sendProgress: () => {
        attempts += 1
        throw new Error('the client went away')
      },
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(attempts >= 1, 'the heartbeat must have fired')
  service.calls[0].gate.resolve({ status: 'ok', message: 'done' })
  assert.equal(payloadOf(await throwing).message, 'done')
  assert.equal(payloadOf(await silent).message, 'done')
  await registry.get(jobId).settled
})

test('a failed job comes back as an error with the synchronous call message', async () => {
  const { service, registry, call } = harness()
  const jobId = await start(call, 'flash_task', { task: 'x' })
  service.calls[0].gate.reject(new Error('the worker exploded'))
  await registry.get(jobId).settled

  const failed = await call('flash_result', { jobId }, {})
  assert.equal(failed.isError, true)
  assert.match(textOf(failed), /^flash_task failed: the worker exploded \(job job-[0-9a-f]{8}\)$/)

  // The same failure through the synchronous path produces the same leading message.
  const sync = call('flash_task', { task: 'x' }, {})
  service.calls[1].gate.reject(new Error('the worker exploded'))
  const syncFailed = await sync
  assert.equal(textOf(syncFailed), 'flash_task failed: the worker exploded')
  assert.ok(textOf(failed).startsWith(textOf(syncFailed)))
})

test('flash_cancel aborts the signal the service was given and the job ends cancelled', async () => {
  const { service, registry, call } = harness()
  const jobId = await start(call, 'flash_task', { task: 'x' })
  const signal = service.calls[0].signal
  assert.equal(signal.aborted, false)

  const cancelled = await call('flash_cancel', { jobId }, {})
  assert.equal(cancelled.isError, undefined)
  assert.equal(signal.aborted, true)
  assert.equal(payloadOf(cancelled).jobId, jobId)
  assert.equal(payloadOf(cancelled).state, 'cancelled')
  assert.match(payloadOf(cancelled).note, /settled after cancellation/)
  assert.equal((await call('flash_result', { jobId }, {})).isError, true)
})

test('flash_cancel on an ended job returns its status unchanged with a note', async () => {
  const { service, registry, call } = harness()
  const jobId = await start(call, 'flash_task', { task: 'x' })
  service.calls[0].gate.resolve({ status: 'ok' })
  await registry.get(jobId).settled

  const result = await call('flash_cancel', { jobId }, {})
  assert.equal(result.isError, undefined)
  assert.equal(payloadOf(result).state, 'ok')
  assert.match(payloadOf(result).note, /already ended as ok/)
})

test('cancelling the starting request does not cancel the job', async () => {
  const { service, registry, call } = harness()
  const controller = new AbortController()
  const started = await call('flash_task', { task: 'x', background: true }, { signal: controller.signal })
  const jobId = payloadOf(started).jobId

  controller.abort()
  assert.equal(service.calls[0].signal.aborted, false)
  assert.equal(registry.status(jobId).state, 'running')

  // The job still runs to a normal end.
  service.calls[0].gate.resolve({ status: 'ok' })
  await registry.get(jobId).settled
  assert.equal(registry.status(jobId).state, 'ok')
})

test('flash_status lists jobs newest first and reports the fields, never a result', async () => {
  const { service, registry, clock, call } = harness()
  const first = await start(call, 'flash_task', { task: 'first line\nsecond line' })
  clock.advance(2_500)
  const second = await start(call, 'flash_batch', { tasks: ['a', 'b', 'c'] })

  const listed = await call('flash_status', {}, {})
  assert.deepEqual(payloadOf(listed).jobs.map((job) => job.jobId), [second, first])
  const status = payloadOf(listed).jobs[1]
  assert.equal(status.kind, 'flash_task')
  assert.equal(status.label, 'first line')
  assert.equal(status.state, 'running')
  assert.equal(status.resultReady, false)
  assert.equal(status.elapsedMs, 2_500)
  assert.equal(payloadOf(listed).jobs[0].elapsedMs, 0)
  assert.equal(status.endedAt, undefined)
  assert.equal('result' in status, false)
  assert.equal('error' in status, false)
  assert.equal(payloadOf(await call('flash_status', { jobId: second }, {})).label, '3 tasks')

  // Only the latest progress line is kept, in exactly the shape status promises.
  service.calls[0].progress({ message: 'halfway', progress: 5, total: 10 })
  const withProgress = payloadOf(await call('flash_status', { jobId: first }, {}))
  assert.deepEqual(Object.keys(withProgress.lastProgress).sort(), ['at', 'message'])
  assert.equal(withProgress.lastProgress.message, 'halfway')

  service.calls[0].gate.resolve({ status: 'ok' })
  await registry.get(first).settled
  const ended = payloadOf(await call('flash_status', { jobId: first }, {}))
  assert.equal(ended.state, 'ok')
  assert.equal(ended.resultReady, true)
  assert.equal(typeof ended.endedAt, 'string')
})

test('flash_status lists running jobs first, then the newest ended ones, with counts and a cap', async () => {
  const { service, registry, clock, call } = harness()
  const ended = []
  for (const name of ['one', 'two', 'three']) {
    const jobId = await start(call, 'flash_task', { task: name })
    clock.advance(1_000)
    service.calls.at(-1).gate.resolve({ status: 'ok', message: name })
    await registry.get(jobId).settled
    // Collecting keeps the cap from evicting them while the assertion runs.
    await call('flash_result', { jobId }, {})
    ended.push(jobId)
  }
  const running = await start(call, 'flash_task', { task: 'still running' })

  // Running first (what a caller can act on), then history newest first — not start order.
  const listed = payloadOf(await call('flash_status', {}, {}))
  assert.deepEqual(listed.jobs.map((job) => job.jobId), [running, ended[2], ended[1], ended[0]])
  assert.equal(listed.running, 1)
  assert.equal(listed.ended, 3)
  assert.equal(listed.omittedEnded, 0)

  // Only ended jobs may be capped; `omittedEnded` says how many were left out.
  const capped = payloadOf(await call('flash_status', { limit: 2 }, {}))
  assert.deepEqual(capped.jobs.map((job) => job.jobId), [running, ended[2], ended[1]])
  assert.equal(capped.running, 1)
  assert.equal(capped.ended, 3)
  assert.equal(capped.omittedEnded, 1)

  const endedOnly = payloadOf(await call('flash_status', { state: 'ended', limit: 1 }, {}))
  assert.deepEqual(endedOnly.jobs.map((job) => job.jobId), [ended[2]])
  assert.equal(endedOnly.running, 1)
  assert.equal(endedOnly.ended, 3)
  assert.equal(endedOnly.omittedEnded, 2)

  const runningOnly = payloadOf(await call('flash_status', { state: 'running' }, {}))
  assert.deepEqual(runningOnly.jobs.map((job) => job.jobId), [running])
  assert.equal(runningOnly.running, 1)
  assert.equal(runningOnly.ended, 3)
  assert.equal(runningOnly.omittedEnded, 3)

  // A listing never carries a result, and reading one by id still does.
  assert.equal('result' in listed.jobs[0], false)
  assert.equal(payloadOf(await call('flash_result', { jobId: ended[0] }, {})).message, 'one')
})

test('flash_status validates state and limit like any other argument', async () => {
  const { call } = harness()
  for (const [args, pattern] of [
    [{ state: 'done' }, /state must be "running", "ended", or "all"; got "done"/],
    [{ state: 1 }, /state must be "running", "ended", or "all"; got 1/],
    [{ limit: 0 }, /limit must be an integer between 1 and 50; got 0/],
    [{ limit: 51 }, /limit must be an integer between 1 and 50; got 51/],
    [{ limit: 2.5 }, /limit must be an integer between 1 and 50; got 2.5/],
    [{ limit: '10' }, /limit must be an integer between 1 and 50; got "10"/],
  ]) {
    const result = await call('flash_status', args, {})
    assert.equal(result.isError, true)
    assert.match(textOf(result), pattern)
  }
  // A jobId still wins, and bad arguments do not start or disturb anything.
  const status = await call('flash_status', { jobId: 'job-deadbeef', state: 'nonsense' }, {})
  assert.match(textOf(status), /unknown job/)
})

test('a long task label is clipped to 80 characters', async () => {
  const { registry, call } = harness()
  const jobId = await start(call, 'flash_task', { task: 'x'.repeat(200) })
  const status = registry.status(jobId)
  assert.equal(status.label.length, 80)
  assert.equal(status.label, 'x'.repeat(80))
})

test('an unknown job id is an error that says what ids look like and that a restart loses jobs', async () => {
  const { call } = harness()
  for (const name of ['flash_status', 'flash_result', 'flash_cancel']) {
    const result = await call(name, { jobId: 'job-deadbeef' }, {})
    assert.equal(result.isError, true)
    assert.match(textOf(result), /job-xxxxxxxx/)
    assert.match(textOf(result), /do not survive a restart/i)
    assert.match(textOf(result), /salvaged as a patch/i)
  }
})

test('retention evicts the oldest ended job past the cap but never a running one', async () => {
  const { service, registry, clock, call } = harness({ maxEnded: 3 })
  const running = await start(call, 'flash_task', { task: 'the running one' })
  const ended = []
  for (let index = 0; index < 5; index += 1) {
    const jobId = await start(call, 'flash_task', { task: `ended ${String(index)}` })
    clock.advance(1_000)
    service.calls.at(-1).gate.resolve({ status: 'ok', index })
    await registry.get(jobId).settled
    // Collecting the result is what makes the job safe for the cap to reclaim; a success
    // nobody collected is kept until the retention window passes.
    await call('flash_result', { jobId }, {})
    ended.push(jobId)
  }

  const ids = payloadOf(await call('flash_status', {}, {})).jobs.map((job) => job.jobId)
  assert.equal(ids.length, 4) // the running job plus the newest three ended
  assert.equal(ids.includes(running), true)
  assert.deepEqual(ids.filter((id) => id !== running), [ended[4], ended[3], ended[2]])
})

test('the cap drops collected and failed results before a success nobody collected', async () => {
  const { service, registry, clock, call } = harness({ maxEnded: 1 })
  const uncollected = await start(call, 'flash_task', { task: 'success nobody collected' })
  service.calls.at(-1).gate.resolve({ status: 'ok' })
  await registry.get(uncollected).settled
  clock.advance(1_000)

  const collected = await start(call, 'flash_task', { task: 'success already collected' })
  service.calls.at(-1).gate.resolve({ status: 'ok' })
  await registry.get(collected).settled
  await call('flash_result', { jobId: collected }, {})
  clock.advance(1_000)

  const failed = await start(call, 'flash_task', { task: 'failure' })
  service.calls.at(-1).gate.reject(new Error('boom'))
  await registry.get(failed).settled
  clock.advance(1_000)

  // A sweep with three ended jobs and a cap of one drops the collected result and the
  // failure, and leaves the one result a caller could still be waiting for.
  const ids = payloadOf(await call('flash_status', {}, {})).jobs.map((job) => job.jobId)
  assert.deepEqual(ids, [uncollected])
  assert.equal(registry.get(collected), undefined)
  assert.equal(registry.get(failed), undefined)
})

test('flash_result still answers when the sweep evicts the job while it waits', async () => {
  const { service, registry, call } = harness()
  const jobId = await start(call, 'flash_task', { task: 'settles then is evicted' })
  service.calls[0].gate.resolve({ status: 'ok', message: 'done' })
  await registry.get(jobId).settled

  // The job is already ended, so the wait resolves immediately — but the sweep runs between
  // that lookup and the status projection. Deleting it here reproduces that race exactly.
  const pending = call('flash_result', { jobId, waitSeconds: 600 }, {})
  registry.jobs.delete(jobId)
  const result = await pending

  assert.equal(result.isError, undefined)
  const payload = payloadOf(result)
  assert.equal(payload.job.jobId, jobId)
  assert.equal(payload.job.state, 'ok')
  assert.equal(payload.message, 'done')
})

test('flash_cancel still answers when the sweep evicts the job while it waits', async () => {
  const { service, registry, call } = harness()
  const jobId = await start(call, 'flash_task', { task: 'cancelled' })

  const pending = call('flash_cancel', { jobId }, {})
  // The abort listener settles the fake call on a microtask; evicting now is the race the
  // second lookup used to lose, turning the answer into a TypeError.
  registry.jobs.delete(jobId)
  const result = await pending

  assert.equal(result.isError, undefined)
  const payload = payloadOf(result)
  assert.equal(payload.jobId, jobId)
  assert.equal(payload.state, 'cancelled')
})

test('an ended job is dropped once it is older than the retention window', async () => {
  const { service, registry, clock, call } = harness()
  const jobId = await start(call, 'flash_task', { task: 'old' })
  service.calls[0].gate.resolve({ status: 'ok' })
  await registry.get(jobId).settled
  clock.advance(ENDED_RETENTION_MS)

  const result = await call('flash_status', { jobId }, {})
  assert.equal(result.isError, true)
})

test('a non-boolean background is rejected like any other argument error', async () => {
  const { service, call } = harness()
  const result = await call('flash_task', { task: 'x', background: 'yes' }, {})
  assert.equal(result.isError, true)
  assert.match(textOf(result), /^flash_task failed: background must be a boolean; got "yes"$/)
  assert.equal(service.calls.length, 0)
})

test('background absent or false leaves the synchronous path unchanged', async () => {
  const { service, registry, call } = harness()
  const signal = new AbortController().signal
  const pending = call('flash_task', { task: 'x', cwd: '/tmp' }, { signal, progressToken: 'tok' })
  assert.equal(service.calls.length, 1)
  assert.deepEqual(service.calls[0].args, { task: 'x', cwd: '/tmp' })
  assert.equal(service.calls[0].signal, signal)
  assert.equal(service.calls[0].progressToken, 'tok')
  assert.equal(registry.list().length, 0)

  const expected = { status: 'ok', message: 'sync' }
  service.calls[0].gate.resolve(expected)
  const result = await pending
  assert.equal(result.isError, undefined)
  assert.deepEqual(payloadOf(result), expected)
  assert.equal(textOf(result), JSON.stringify(expected, null, 2))

  // `background: false` is stripped and behaves exactly like the absent flag.
  const off = call('flash_task', { task: 'y', background: false }, {})
  assert.deepEqual(service.calls[1].args, { task: 'y' })
  service.calls[1].gate.resolve({ status: 'ok' })
  assert.equal(payloadOf(await off).status, 'ok')
})

test('a job start and its end are each logged once', async () => {
  const { service, registry, logs, call } = harness()
  const jobId = await start(call, 'flash_batch', { tasks: ['a'] })
  assert.equal(logs.filter((line) => line.includes('started')).length, 1)
  assert.match(logs[0], /^job job-[0-9a-f]{8} flash_batch started: 1 tasks$/)

  service.calls[0].gate.resolve({ status: 'ok' })
  await registry.get(jobId).settled
  assert.equal(logs.filter((line) => line.includes('ended')).length, 1)
  assert.match(logs[1], /^job job-[0-9a-f]{8} flash_batch ended ok in 0\.0 min$/)
})

test('flash_result validates waitSeconds and jobId', async () => {
  const { registry, call } = harness()
  const jobId = await start(call, 'flash_task', { task: 'x' })

  const bad = await call('flash_result', { jobId, waitSeconds: 601 }, {})
  assert.equal(bad.isError, true)
  assert.match(textOf(bad), /waitSeconds must be an integer between 0 and 600/)

  const noId = await call('flash_result', {}, {})
  assert.equal(noId.isError, true)
  assert.match(textOf(noId), /jobId must be a non-empty string/)
  assert.equal(registry.status(jobId).state, 'running')
})

test('the three job tools are descriptors in the service style', () => {
  assert.deepEqual(JOB_TOOLS.map((tool) => tool.name), ['flash_status', 'flash_result', 'flash_cancel'])
  for (const tool of JOB_TOOLS) {
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.equal(typeof tool.description, 'string')
    assert.equal(JSON.stringify(tool.inputSchema).match(/provider|model|reasoning/i), null)
  }
  assert.deepEqual(JOB_TOOLS[1].inputSchema.required, ['jobId'])
  assert.deepEqual(JOB_TOOLS[2].inputSchema.required, ['jobId'])
  assert.match(JOB_TOOLS[1].description, /waiting in chunks.*waitSeconds: 300/)
  // A listing is a page with filters, not the server's whole history.
  assert.deepEqual(JOB_TOOLS[0].inputSchema.properties.state.enum, ['running', 'ended', 'all'])
  assert.equal(JOB_TOOLS[0].inputSchema.properties.limit.minimum, 1)
  assert.equal(JOB_TOOLS[0].inputSchema.properties.limit.maximum, 50)
  assert.match(JOB_TOOLS[0].description, /running jobs|still running/)
  assert.match(JOB_TOOLS[0].description, /up to `limit` of them \(default 10\)/)
  assert.match(JOB_TOOLS[0].description, /how many ended ones were left out/)
  // A wait can end early because the client gave up, and the answer says so.
  assert.match(JOB_TOOLS[1].description, /some\nclients cancel a long tool call on their own timeout/)
  assert.match(JOB_TOOLS[1].description, /`wait\.endedBy` says what ended it/)
  assert.match(JOB_TOOLS[1].description, /request-cancelled/)
  // The retention is stated honestly: results are in memory, dropped after six hours, and
  // the cap may reclaim collected and failed ones sooner.
  assert.match(JOB_TOOLS[1].description, /dropped six hours after it ended/)
  assert.match(JOB_TOOLS[1].description, /never evicted by that count/)
})

test('a tool that throws synchronously still answers with an error result', async () => {
  // flashApply and flashPatch refuse a bad id by throwing before any await; the dispatcher
  // must catch that like any other failure instead of letting it escape the request.
  const service = {
    flashApply() {
      throw new Error('patchId "nope" is not an id this service issues')
    },
    flashPatch() {
      throw new Error('patch flash-x is gone')
    },
  }
  const callTool = createToolCaller({ service, jobs: new JobRegistry() })
  for (const name of ['flash_apply', 'flash_patch']) {
    const answer = await callTool(name, { patchId: 'nope' }, {})
    assert.equal(answer.isError, true)
    assert.match(answer.content[0].text, new RegExp(`^${name} failed: `))
  }
})

test('a running job’s status shows what its call is running and what keeps failing', async () => {
  const { service, registry, call } = harness()
  const jobId = await start(call, 'flash_task', { task: 'build the vendored openssl' })

  const since = '2026-01-02T03:04:05.000Z'
  service.calls[0].progress({
    progress: 61,
    total: 300,
    message: 'flash_task running 1m1s; tool bash · last event 2s ago; running "make -j8" for 1m1s',
    detail: {
      current: [{ tool: 'bash', command: 'make -j8 build_libs', since, runningMs: 61_000 }],
      warnings: ['"cargo build" failed 3 times in this call (last: exit code 101, 40s ago); …'],
    },
  })

  const status = payloadOf(await call('flash_status', { jobId }, {}))
  assert.equal(status.state, 'running')
  assert.deepEqual(status.current, [{ tool: 'bash', command: 'make -j8 build_libs', since, runningMs: 61_000 }])
  assert.deepEqual(status.warnings, ['"cargo build" failed 3 times in this call (last: exit code 101, 40s ago); …'])
  // The message itself is unchanged, and the structured detail stays out of `lastProgress`.
  assert.match(status.lastProgress.message, /running "make -j8" for 1m1s/)
  assert.equal(status.lastProgress.detail, undefined)

  // An ended job shows neither: what it was running an hour ago is not its status.
  service.calls[0].gate.resolve({ status: 'ok', message: 'done' })
  const job = registry.get(jobId)
  await job.settled
  const ended = payloadOf(await call('flash_status', { jobId }, {}))
  assert.equal(ended.state, 'ok')
  assert.equal('current' in ended, false)
  assert.equal('warnings' in ended, false)
})

test('an empty detail leaves the status exactly as it was', async () => {
  const { service, call } = harness()
  const jobId = await start(call, 'flash_task', { task: 'quiet' })
  service.calls[0].progress({ message: 'quiet', detail: { current: [], warnings: [] } })
  const status = payloadOf(await call('flash_status', { jobId }, {}))
  assert.equal('current' in status, false)
  assert.equal('warnings' in status, false)
  assert.deepEqual(Object.keys(status.lastProgress).sort(), ['at', 'message'])
})

test('a job label reads the brief its taskFile names', async () => {
  // A realpath root: a temp path on macOS is a symlink, and the service's own fence
  // resolves the root once and compares real paths.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flash-job-label-')))
  writeFileSync(join(root, 'brief.txt'), '\n#  Port the parser  \n\nbody\n')
  const service = new FakeService()
  // A real service names the root every taskFile resolves against; the label reads it the
  // same way, so the job says which brief it is running instead of "(untitled task)".
  service.root = root
  const call = createToolCaller({ service, jobs: new JobRegistry({ log: () => {} }), log: () => {} })
  const started = payloadOf(await call('flash_task', { taskFile: 'brief.txt', cwd: root, background: true }, {}))
  // The job and the patch a background call stores name the brief identically: the heading's
  // `#` markers are stripped by the helper both read.
  assert.equal(started.label, 'Port the parser')
})
