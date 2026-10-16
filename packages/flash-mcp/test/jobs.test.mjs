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
    this.calls.push({ kind, args, signal: ctx.signal, progress: ctx.progress, progressToken: ctx.progressToken, gate })
    ctx.signal?.addEventListener('abort', () => gate.reject(new Error(`${kind} was cancelled by the client`)), {
      once: true,
    })
    return gate.promise
  }
}

/** A dispatcher over a fake service, a registry with an injected clock, and captured logs. */
function harness({ maxEnded } = {}) {
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
  const call = createToolCaller({ service, jobs: registry, log: (message) => logs.push(message) })
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
