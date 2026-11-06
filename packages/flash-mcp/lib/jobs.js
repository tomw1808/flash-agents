/**
 * Background jobs for `flash_task` and `flash_batch`.
 *
 * A synchronous flash_task holds the caller's turn for its whole run — minutes in
 * practice — during which the caller cannot run tests, review an earlier patch, or
 * cancel anything. A background call answers at once with a job id, and the work
 * continues under a signal the *job* owns, so finishing or cancelling the starting
 * request cannot reach it. Three tools (`flash_status`, `flash_result`,
 * `flash_cancel`) report on, collect, and stop those jobs.
 *
 * The registry is deliberately in-memory and process-local. A job's result only means
 * anything to the process that ran it, and a finished writing call's change is already
 * stored on disk as a patch, which a later server salvages and `flash_apply` applies.
 * Nothing here writes to disk or starts a timer that keeps the process alive, and time
 * comes from an injected clock, so tests can advance it.
 *
 * @module flash-mcp/jobs
 */

import { randomUUID } from 'node:crypto'

/** How many ended jobs the registry keeps before it evicts the oldest. */
export const MAX_ENDED_JOBS = 50

/** How long an ended job is kept. Old ones are dropped lazily, never by a timer. */
export const ENDED_RETENTION_MS = 6 * 60 * 60 * 1000

/**
 * How much of an ended job's last progress line a status *listing* keeps. A listing shows
 * many jobs, and each ended job's full heartbeat line (a sentence plus its open commands)
 * made the page hard to scan; the first line and this many characters identify the job,
 * and `flash_status` with its jobId still returns the line whole.
 */
export const LISTING_PROGRESS_CHARS = 160

/**
 * The three tools that work on background jobs.
 *
 * Same shape as the service's other tool descriptors. None can start work, so none
 * carries a task: they only observe, collect, and cancel a job that `background: true`
 * already started.
 *
 * @type {Array<object>}
 */
export const JOB_TOOLS = [
  {
    name: 'flash_status',
    description: [
      'Report the state of a background flash_task or flash_batch call started with `background: true`.',
      '',
      'With a jobId, returns that job\'s state ("running", "failed", "cancelled", or the status its result ended with: "ok", "partial", "error"), its label,',
      'when it started and (once ended) when it ended, how long it has run, and its most recent',
      'progress line. Without a jobId, lists jobs: the ones still running (newest first), then the',
      'most recently ended ones, up to `limit` of them (default 10), together with how many are',
      'running, how many have ended, and how many ended ones were left out. Pass `state: "running"`',
      'or `state: "ended"` to see only one group, and a larger `limit` (up to 50) to see more.',
      'In a listing an ended job\'s `lastProgress` keeps only its first line, cut at 160 characters (with … when cut);',
      'a running job keeps the line whole, and asking for one job by id always returns it whole.',
      '',
      'A running job also shows what its workers are doing as of the last heartbeat: `current` lists',
      'each open tool call (tool, command, since, runningMs), and `warnings` names a command that',
      'failed three or more times in the call — a worker repeating a step its sandbox cannot finish —',
      'or a tool call whose process tree has used no CPU for minutes. A `current` entry carries `child`',
      '(command, runningMs, cpuSeconds) when a process under the runtime has run longer than the command,',
      'and `background` (the job id) when it is a background job.',
      '`info` lists failures the brief asked for (checks that fail before the change and pass after it).',
      'A job still waiting for a free tree shows `queue`: its place in line (`position` of `of`; trees go',
      'to the longest waiter first) and the calls holding the trees (`holders`: jobId when it is a job,',
      'label, runningMs, and idleMs when the holder has shown no activity for a minute).',
      '',
      'This reports status only: it never returns a job\'s result — use flash_result for that. A job',
      'id is meaningful only to the server process that created it, and jobs do not survive a restart.',
      'After a restart, a finished writing call\'s work is still salvaged as a patch by the next server,',
      'and flash_apply can apply it by id.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'The job to report on. Omit it to list jobs: running first, then the recently ended ones.',
        },
        state: {
          type: 'string',
          enum: ['running', 'ended', 'all'],
          description: 'Which jobs a listing shows. "all" (the default) is running ones first, then ended ones.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'How many ended jobs a listing shows at most. Defaults to 10; running jobs are never capped.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'flash_result',
    description: [
      'Collect the result of a background flash_task or flash_batch call started with `background: true`.',
      '',
      'Returns the same result a synchronous call would have returned, plus the job id, state, and',
      'elapsed time. With the default `waitSeconds: 0` it answers at once: a finished job returns its',
      'result, and a running job returns its current state. Pass `waitSeconds` (up to 600) to wait for',
      'the job to end — prefer waiting in chunks (e.g. waitSeconds: 300) between other work, so you',
      'stay responsive and can report progress instead of blocking on one long call.',
      '',
      'Pass `jobIds` (2 to 16 ids) instead of `jobId` to wait on several jobs together; the two are',
      'mutually exclusive. The answer is the first of them that ends, with `pending` naming the ids',
      'still running; without `waitSeconds` it returns the first that has already ended, or lists them',
      'all as `pending`.',
      '',
      'If the request carrying this call is cancelled, the wait stops and the job keeps running; some',
      'clients cancel a long tool call on their own timeout, so a wait can end before `waitSeconds`.',
      'The answer\'s `wait.endedBy` says what ended it: "job-ended", "timeout", "request-cancelled", or',
      '"not-waited". A call that failed or was cancelled comes back as an error with the same message',
      'the synchronous call would have produced. A result stays available after it is read, so',
      'reading twice returns the same thing, but it is kept in memory only: an ended job is',
      'dropped six hours after it ended, and once more than 50 have ended, results you have',
      'already collected and failed or cancelled jobs may be evicted sooner. A successful result',
      'you have not collected is never evicted by that count. The result does not survive a restart,',
      'but the worker\'s whole report does: for a job the server no longer holds, flash_result returns',
      'the stored report with its status (and `reportPath`), and the finished work is a patch as well.',
      'That stored report carries the call\'s `timing` when it measured one.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'The job whose result to collect. Pass either jobId or jobIds.',
        },
        jobIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 16,
          description:
            'Two to sixteen jobs to collect from together. With waitSeconds, returns as soon as any one ends; without it, the first that has already ended. Mutually exclusive with jobId.',
        },
        waitSeconds: {
          type: 'integer',
          minimum: 0,
          maximum: 600,
          description:
            'How long to wait for the job (or any of jobIds) to end before answering with its current state. Defaults to 0, which answers at once.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'flash_cancel',
    description: [
      'Stop a running background flash_task or flash_batch call and return its resulting status.',
      '',
      'Aborts the job and waits up to 30 seconds for the call to settle. Cancellation follows the same',
      'path as cancelling a synchronous call: the service abandons the lease, or shuts the runtime down',
      'and retires the tree. A cancelled writing call\'s partial work is stored as a patch first (marked as',
      'from a cancelled job); the answer names its `patchId` and `diffstat`, or says `stored: false` when the',
      'copy held no change. The state reported is "cancelled", or whatever the call had already ended as if',
      'it finished first.',
      '',
      'A job that has already ended is returned unchanged, with a note saying so. Cancelling does not',
      'undo a change that was already applied with `apply: "auto"`.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'The running job to stop.',
        },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
  },
]

/**
 * In-memory registry of background calls.
 *
 * A job owns its `AbortController`, not the request that started it, so `flash_cancel`
 * and a dropped starting request pull different levers. `run` is invoked once, its
 * outcome captured; nothing in the registry ever awaits it, which is what lets the
 * starting request answer immediately.
 */
export class JobRegistry {
  /**
   * @param {object} [options] - registry wiring.
   * @param {(message: string) => void} [options.log] - diagnostic sink.
   * @param {() => number} [options.now] - clock, injectable for tests.
   * @param {number} [options.maxEnded] - ended jobs kept before the oldest are evicted.
   * @param {number} [options.retentionMs] - how long an ended job is kept.
   */
  constructor({ log = () => {}, now = Date.now, maxEnded = MAX_ENDED_JOBS, retentionMs = ENDED_RETENTION_MS } = {}) {
    this.log = log
    this.now = now
    this.maxEnded = maxEnded
    this.retentionMs = retentionMs
    /** @type {Map<string, object>} jobs by id, in start order. */
    this.jobs = new Map()
  }

  /**
   * Start a job and return it at once. `run` is called with the job's own signal, its id
   * (which the dispatcher passes to the service as a progress token), and a recorder for
   * its progress. It must resolve with the call's result or reject with its error; its
   * outcome is captured, never awaited here.
   *
   * @param {object} options - the job to start.
   * @param {'flash_task' | 'flash_batch'} options.kind - the tool the job runs.
   * @param {string} options.label - one-line description shown in status and logs.
   * @param {(call: {signal: AbortSignal, jobId: string, progress: (report: object) => void}) => Promise<object>} options.run - the call.
   * @returns {object} the running job record.
   */
  start({ kind, label, run }) {
    this.#sweep()
    const startedMs = this.now()
    const jobId = this.#newJobId()
    const job = {
      jobId,
      kind,
      label,
      state: 'running',
      startedMs,
      startedAt: new Date(startedMs).toISOString(),
      endedMs: undefined,
      endedAt: undefined,
      lastProgress: undefined,
      result: undefined,
      error: undefined,
      /** Whether flash_result has already handed this job's result to the caller. */
      collected: false,
      controller: new AbortController(),
      settled: undefined,
    }
    // Enter the map and log the start *before* invoking `run`, so even a run that rejects
    // synchronously cannot settle before the job is observable or log "ended" first.
    this.jobs.set(jobId, job)
    this.log(`job ${jobId} ${kind} started: ${label}`)
    job.settled = (async () => {
      try {
        job.result = await run({
          signal: job.controller.signal,
          jobId,
          progress: (report) => this.#recordProgress(job, report),
        })
      } catch (error) {
        job.error = error
      }
      this.#finish(job)
    })()
    return job
  }

  /**
   * The job record for an id, or undefined. This is the internal view: it carries the
   * result payload, so only `flash_result` should read it. `status` is the safe projection.
   *
   * @param {string} jobId - the job to find.
   * @returns {object | undefined} the job.
   */
  get(jobId) {
    this.#sweep()
    return this.jobs.get(jobId)
  }

  /**
   * The status of one job, never its result.
   *
   * @param {string} jobId - the job to report on.
   * @returns {object | undefined} the status, or undefined when the id is not known.
   */
  status(jobId) {
    const job = this.get(jobId)
    return job === undefined ? undefined : this.#project(job)
  }

  /**
   * The status projection of a job the caller already holds.
   *
   * `waitFor` resolves the job it was holding, but `status(jobId)` looks it up again — and
   * the sweep may have evicted it in between, so the second lookup can be undefined and the
   * dispatcher then throws a TypeError out of the request. Projecting the held job is the
   * same answer with no second lookup and no race.
   *
   * @param {object} job - a job record.
   * @returns {object} the status projection.
   */
  statusOf(job) {
    return this.#project(job)
  }

  /**
   * Job statuses for a status listing: running jobs first, then ended ones, each newest first.
   *
   * The registry keeps every job of a long-lived server, so an unfiltered listing grew into
   * a wall of history while a couple of calls were live. Running jobs are what a caller can
   * act on, so they always come first and are never capped; ended jobs are capped by `limit`
   * and reported as omitted when there are more. Ties on start time fall back to start
   * order, so a test clock that does not advance still lists deterministically.
   *
   * @param {object} [options] - what to list.
   * @param {'running' | 'ended' | 'all'} [options.state] - which jobs to include.
   * @param {number} [options.limit] - how many ended jobs to include at most.
   * @returns {Array<object>} the statuses, running first.
   */
  list({ state = 'all', limit = 10 } = {}) {
    this.#sweep()
    const entries = [...this.jobs.values()].map((job, index) => ({ job, index }))
    const newestFirst = (a, b) => b.job.startedMs - a.job.startedMs || b.index - a.index
    const running = state === 'ended' ? [] : entries.filter(({ job }) => job.state === 'running').sort(newestFirst)
    const ended =
      state === 'running'
        ? []
        : entries.filter(({ job }) => job.state !== 'running').sort(newestFirst).slice(0, Math.max(0, limit))
    return [...running, ...ended].map(({ job }) => this.#project(job, { listing: true }))
  }

  /**
   * How many jobs are running and how many have ended, after the lazy sweep.
   *
   * A status listing reports both alongside the page it shows, so the counts must describe
   * the registry and not the page: `omittedEnded` is then the difference, honestly.
   *
   * @returns {{running: number, ended: number}} the counts.
   */
  counts() {
    this.#sweep()
    let running = 0
    for (const job of this.jobs.values()) if (job.state === 'running') running += 1
    return { running, ended: this.jobs.size - running }
  }

  /**
   * Abort a running job's own controller. Nothing else: the service's cancellation path
   * retires the tree and shuts the runtime down when the call reacts to the signal. Returns
   * the job so the caller can wait for it to settle.
   *
   * @param {string} jobId - the job to stop.
   * @returns {object | undefined} the job, running or already ended, or undefined.
   */
  cancel(jobId) {
    const job = this.get(jobId)
    if (job === undefined || job.state !== 'running') return job
    job.controller.abort()
    return job
  }

  /**
   * Wait for a job to end, up to `waitMs`, until `signal` aborts, or until the timer expires.
   *
   * Resolves with `{ job, endedBy }` either way; the caller reads the job's state and, when
   * the wait was not the thing that decided the answer, why it stopped. `endedBy` is
   * `'job-ended'` when the call settled, `'timeout'` when `waitMs` ran out first,
   * `'request-cancelled'` when the waiting request's signal aborted, and `'not-waited'` when
   * the job was already over (or gone) before the wait began. The timer is unref'd and
   * cleared, so a wait is never the thing keeping the process alive, and a cancelled request
   * stops waiting at once.
   *
   * @param {string} jobId - the job to wait on.
   * @param {number} waitMs - the longest to wait.
   * @param {AbortSignal} [signal] - the waiting request's cancellation.
   * @returns {Promise<{job: object | undefined, endedBy: 'job-ended' | 'timeout' | 'request-cancelled' | 'not-waited'}>}
   *   the job (or undefined when it is gone) and what ended the wait.
   */
  waitFor(jobId, waitMs, signal) {
    const job = this.get(jobId)
    if (job === undefined) return Promise.resolve({ job: undefined, endedBy: 'not-waited' })
    if (job.state !== 'running' || waitMs <= 0) return Promise.resolve({ job, endedBy: 'not-waited' })
    if (signal?.aborted === true) return Promise.resolve({ job, endedBy: 'request-cancelled' })
    return new Promise((resolve) => {
      let done = false
      const finish = (endedBy) => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve({ job: this.jobs.get(jobId) ?? job, endedBy })
      }
      const onAbort = () => finish('request-cancelled')
      const timer = setTimeout(() => finish('timeout'), waitMs)
      // A pending wait must never by itself keep the process alive.
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
      job.settled.then(
        () => finish('job-ended'),
        () => finish('job-ended'),
      )
    })
  }

  /**
   * Wait for the first of several jobs to end, up to `waitMs`, until `signal` aborts, or until
   * the timer expires.
   *
   * This is `waitFor` for a group: a caller watching a fleet it split across jobs wants the
   * first answer, not the first id in its list. A job that has already ended wins at once;
   * otherwise the first to settle ends the wait, whichever position it holds in `jobIds`.
   * `endedBy` has the same meaning as in `waitFor`; `job` is undefined when no job had ended
   * when the wait stopped. `missing` names an id the registry no longer holds, which the
   * caller reports as an unknown job rather than as a timeout.
   *
   * @param {string[]} jobIds - the jobs to wait on.
   * @param {number} waitMs - the longest to wait.
   * @param {AbortSignal} [signal] - the waiting request's cancellation.
   * @returns {Promise<{job: object | undefined, endedBy: 'job-ended' | 'timeout' | 'request-cancelled' | 'not-waited', missing?: string}>}
   *   the first job that ended (or undefined) and what ended the wait.
   */
  waitForAny(jobIds, waitMs, signal) {
    const jobs = []
    for (const jobId of jobIds) {
      const job = this.get(jobId)
      if (job === undefined) return Promise.resolve({ job: undefined, missing: jobId, endedBy: 'not-waited' })
      jobs.push(job)
    }
    const alreadyEnded = jobs.find((job) => job.state !== 'running')
    if (alreadyEnded !== undefined) return Promise.resolve({ job: alreadyEnded, endedBy: 'not-waited' })
    if (waitMs <= 0) return Promise.resolve({ job: undefined, endedBy: 'not-waited' })
    if (signal?.aborted === true) return Promise.resolve({ job: undefined, endedBy: 'request-cancelled' })
    return new Promise((resolve) => {
      let done = false
      const finish = (job, endedBy) => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve({ job: job === undefined ? undefined : (this.jobs.get(job.jobId) ?? job), endedBy })
      }
      const onAbort = () => finish(undefined, 'request-cancelled')
      const timer = setTimeout(() => finish(undefined, 'timeout'), waitMs)
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
      for (const job of jobs) {
        job.settled.then(
          () => finish(job, 'job-ended'),
          () => finish(job, 'job-ended'),
        )
      }
    })
  }

  /**
   * Drop ended jobs nobody can collect any more: first those past their retention window,
   * then, under the cap, only the ones whose result is safe to lose. Running jobs are never
   * evicted — their work is still in flight and their result may be the only handle on it.
   * Called from every public operation, so retention needs no timer.
   */
  #sweep() {
    const now = this.now()
    for (const [id, job] of this.jobs) {
      if (job.state !== 'running' && now - job.endedMs >= this.retentionMs) this.jobs.delete(id)
    }
    const ended = [...this.jobs.values()].filter((job) => job.state !== 'running')
    if (ended.length <= this.maxEnded) return
    // An `ok` result nobody collected is the one thing here that cannot be reconstructed:
    // the change is on disk as a patch, but the call's result envelope is in memory only.
    // A collected result was already delivered, and a failure or cancellation can be
    // retried, so those are evicted first, oldest first. An uncollected `ok` job is left to
    // the retention window above and is never removed by the cap.
    const evictable = ended
      .filter((job) => job.collected === true || job.error !== undefined)
      .sort((a, b) => a.endedMs - b.endedMs)
    const excess = ended.length - this.maxEnded
    for (const job of evictable.slice(0, excess)) this.jobs.delete(job.jobId)
  }

  /** A fresh id unique within this registry: `job-` and 8 lowercase hex characters. */
  #newJobId() {
    for (;;) {
      const id = `job-${randomUUID().slice(0, 8)}`
      if (!this.jobs.has(id)) return id
    }
  }

  /**
   * Record the newest progress line for a running job. The service's heartbeat fires at its
   * own interval; only the latest one is kept, which is all `flash_status` shows. A report
   * without a message is not worth showing and is ignored.
   *
   * The report's structured `detail` is kept too, because it is the part a status reader can
   * act on: the commands a running call currently has open, and the ones that keep failing.
   * It is bounded like the message — only the latest report is held — and it is a fresh
   * object per heartbeat, so keeping the reference cannot let a later report mutate it.
   *
   * @param {object} job - the running job.
   * @param {object} report - the service's progress report.
   */
  #recordProgress(job, report) {
    if (job.state !== 'running') return
    if (report === null || typeof report !== 'object') return
    if (typeof report.message !== 'string' || report.message.length === 0) return
    const detail = report.detail
    job.lastProgress = {
      message: report.message,
      ...(typeof report.progress === 'number' ? { progress: report.progress } : {}),
      ...(typeof report.total === 'number' ? { total: report.total } : {}),
      ...(detail === null || typeof detail !== 'object' || Array.isArray(detail) ? {} : { detail }),
      at: new Date(this.now()).toISOString(),
    }
  }

  /**
   * Settle a job exactly once. A call that rejected after its own controller was aborted is a
   * cancellation whatever error the service raised; the service's own CANCELLED code is
   * honoured too, so a cancellation that raced the abort is still named as one.
   *
   * @param {object} job - the job to settle.
   */
  #finish(job) {
    if (job.state !== 'running') return
    const endedMs = this.now()
    job.endedMs = endedMs
    job.endedAt = new Date(endedMs).toISOString()
    // One source of truth: a call that returned a result is as good or as bad as that result
    // says. The state used to be "ok" for any call that did not throw, so a result of status
    // "error" sat beside a job that read "ok".
    if (job.error === undefined) job.state = typeof job.result?.status === 'string' ? job.result.status : 'ok'
    else if (job.controller.signal.aborted || job.error?.code === 'CANCELLED') job.state = 'cancelled'
    else job.state = 'failed'
    this.log(`job ${job.jobId} ${job.kind} ended ${job.state} in ${formatMinutes(endedMs - job.startedMs)} min`)
  }

  /**
   * The status projection: identity, state, timing, latest progress — never the result.
   *
   * A running job also reports what its call is doing right now: the open commands and the
   * repeated-failure warnings the last heartbeat carried, and, while it waits for a tree, its
   * place in the queue and who holds the trees. All are dropped once the job has ended — an
   * ended job's answer is its result, and a stale snapshot of a command that was running an
   * hour ago would read as if it were still running. The one part of a finished call's result
   * that belongs in its status by id is `timing`, the phase breakdown a caller uses to see
   * where a slow call went; a listing still leaves it out, so a page stays scannable.
   *
   * A listing is a page, not one job's report: an ended job's progress line is cut to its
   * first line and `LISTING_PROGRESS_CHARS`, so a page of history stays scannable. Asking
   * for the job by id, or reading a running job, keeps the line whole.
   *
   * @param {object} job - the job to project.
   * @param {object} [options] - how the projection is used.
   * @param {boolean} [options.listing] - whether this is one entry of a status listing.
   */
  #project(job, { listing = false } = {}) {
    const detail = job.state === 'running' ? job.lastProgress?.detail : undefined
    const current = detail?.current
    const warnings = detail?.warnings
    const queue = detail?.queue
    const info = detail?.info
    const message =
      listing && job.state !== 'running' && job.lastProgress !== undefined
        ? listingProgress(job.lastProgress.message)
        : job.lastProgress?.message
    return {
      jobId: job.jobId,
      kind: job.kind,
      label: job.label,
      state: job.state,
      startedAt: job.startedAt,
      ...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
      elapsedMs: Math.max(0, (job.endedMs ?? this.now()) - job.startedMs),
      ...(job.lastProgress === undefined
        ? {}
        : { lastProgress: { message, at: job.lastProgress.at } }),
      ...(Array.isArray(current) && current.length > 0 ? { current } : {}),
      ...(Array.isArray(warnings) && warnings.length > 0 ? { warnings } : {}),
      ...(Array.isArray(info) && info.length > 0 ? { info } : {}),
      ...(queue !== null && typeof queue === 'object' && !Array.isArray(queue) ? { queue } : {}),
      ...(listing || job.result?.timing === undefined ? {} : { timing: job.result.timing }),
      resultReady: job.state !== 'running' && job.error === undefined,
    }
  }
}

/** Render an elapsed span in minutes with one decimal, the way the log reads it. */
function formatMinutes(ms) {
  return (Math.max(0, ms) / 60_000).toFixed(1)
}

/**
 * The start of a progress line, for a status listing: its first non-empty line, at most
 * `LISTING_PROGRESS_CHARS` code points. Leading blank lines are skipped so a message that
 * starts with a newline still shows its text; `\r`, `\n` and `\r\n` all end a line. The cut
 * is by code point, so a surrogate pair (an emoji) is never split, and it is marked with an
 * ellipsis because the line continues. A single-job status keeps the whole line.
 *
 * @param {string} message - the job's latest progress line.
 * @returns {string} the shortened line.
 */
function listingProgress(message) {
  const firstLine = message.split(/\r\n|\r|\n/).find((line) => line.length > 0) ?? ''
  const codePoints = Array.from(firstLine)
  return codePoints.length <= LISTING_PROGRESS_CHARS
    ? firstLine
    : `${codePoints.slice(0, LISTING_PROGRESS_CHARS).join('')}…`
}
