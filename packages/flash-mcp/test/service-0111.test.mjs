/**
 * 0.1.11 service tests: no worker outcome gets lost. A final message that is no report
 * (empty, or the next tool call written out as text) is an error, a job's state is its
 * result's status, every finished call's whole report is on disk, and a cancelled writing
 * call hands back the patch it saved. Everything goes through the tool caller the server
 * really runs; the runtime is faked, so nothing here needs Harness, a real home, a real
 * `DSH_HOME`, the real temp state base or the real data directory.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FlashTaskService, finalMessageProblem } from '../lib/service.js'
import { createToolCaller } from '../lib/index.js'
import { JobRegistry } from '../lib/jobs.js'

/** Pools without an explicit state directory use the durable data directory: a throwaway one. */
process.env.FLASH_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'flash-0111-data-')))

/** The two final messages a user reported, verbatim (the bar is the fullwidth U+FF5C). */
const DSML_INVOKE = 'Now I will edit the file.\n\n<｜DSML｜ invoke name="edit">\n<｜DSML｜ parameter name="path">a.js</｜DSML｜ parameter>'
const DSML_CALLS = '</｜DSML｜ calls> <｜DSML｜ invoke name="edit">'
const BASH_INVOKE = 'Let me run the tests.\ninvoke name="bash"'

/** A report as long as the ones that were cut: 30,000 characters of real-shaped prose. */
const LONG_REPORT = Array.from(
  { length: 700 },
  (_, line) => `Step ${String(line + 1).padStart(3, '0')}: changed the module and ran its checks.`,
)
  .join('\n')
  .slice(0, 30_000)

/** Read the fleet payload back out of the dispatch prompt. */
function promptArgs(text) {
  const start = text.indexOf('<args>\n')
  const end = text.indexOf('\n</args>')
  assert.ok(start >= 0 && end > start, 'the dispatch prompt must carry an args block')
  return JSON.parse(text.slice(start + '<args>\n'.length, end))
}

/**
 * A runtime stand-in: one canned child per prompt, whose final message, status and stop
 * reason the test sets, and which can write a file into its tree or go silent after writing.
 */
class FakeSdkClient {
  constructor() {
    this.pid = 4242
    this.prompts = []
    this.shutdowns = 0
    this.cwd = undefined
    this.writes = undefined
    this.silent = false
    this.finalText = 'worker result'
    this.finalStatus = 'ok'
    this.finalStop = 'completed'
    /** Fleet members' messages by index. */
    this.memberTexts = []
    this.notificationHandlers = new Set()
    this.exitHandlers = new Set()
    this.diagnostics = ''
  }

  start() {
    return this.pid
  }

  async initialize(params) {
    this.cwd = params.cwd
    return { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' }
  }

  async prompt({ sessionId, text }) {
    this.prompts.push({ sessionId, text })
    queueMicrotask(() => this.#replay(sessionId, text))
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
    this.shutdowns += 1
  }

  emit(method, params) {
    for (const handler of this.notificationHandlers) handler(method, params)
  }

  #replay(sessionId, text) {
    if (this.writes !== undefined && this.cwd !== undefined) writeFileSync(join(this.cwd, this.writes), 'written\n')
    this.emit('session.status', { sessionId, status: 'running' })
    if (this.silent) return
    if (text.includes('<args>\n')) {
      this.#replayFleet(sessionId, text)
      return
    }
    const child = `child-${sessionId}`
    this.emit('subagent.started', { parentSessionId: sessionId, childSessionId: child })
    this.emit('session.event', {
      sessionId: child,
      event: { type: 'request/header', data: { header: { config: { provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' } } } },
    })
    this.emit('subagent.finished', {
      provider: 'flash',
      agentId: 'agent-0',
      parentSessionId: sessionId,
      childSessionId: child,
      status: this.finalStatus,
      stopReason: this.finalStop,
      lastAssistantMessage: [{ type: 'text', text: this.finalText }],
    })
    this.emit('session.status', { sessionId, status: 'idle' })
  }

  #replayFleet(sessionId, text) {
    const { items, perItemChars } = promptArgs(text)
    const childId = (index) => `child-${sessionId}-${String(index)}`
    const message = (index) => this.memberTexts[index] ?? `fleet result ${String(index)}`
    for (const [index] of items.entries()) {
      this.emit('subagent.started', { parentSessionId: sessionId, childSessionId: childId(index) })
      this.emit('session.event', {
        sessionId: childId(index),
        event: { type: 'request/header', data: { header: { config: { provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' } } } },
      })
    }
    for (const [index] of items.entries()) {
      this.emit('subagent.finished', {
        provider: 'flash',
        agentId: `agent-${String(index)}`,
        parentSessionId: sessionId,
        childSessionId: childId(index),
        status: 'ok',
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: message(index) }],
      })
      this.emit('session.event', {
        sessionId,
        event: { type: 'tool-workflow/agent-start', data: { runId: 'run-1', seq: index + 1, label: `task-${String(index + 1)}`, childId: childId(index) } },
      })
      this.emit('session.event', { sessionId, event: { type: 'tool-workflow/agent-end', data: { runId: 'run-1', seq: index + 1, outcome: 'completed' } } })
    }
    this.emit('session.event', { sessionId, event: { type: 'tool-workflow/run-start', data: { runId: 'run-1', name: 'flash-batch' } } })
    // The fleet script cuts each member's message at perItemChars before the engine returns it.
    const entries = items.map((_, index) => ({ index, ok: true, result: message(index).slice(0, perItemChars) }))
    this.emit('session.event', {
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
                content: [{ type: 'text', text: `workflow "flash-batch" completed (${String(items.length)} agents).\nReturn value:\n${JSON.stringify(entries)}` }],
              },
            ],
          },
        },
      },
    })
    this.emit('session.status', { sessionId, status: 'idle' })
  }
}

/** A git-backed root with a pool of one disposable tree in a throwaway state directory. */
function makeIsolatedService(overrides = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flash-0111-iso-')))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  writeFileSync(join(root, 'README.md'), '# project\n')
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: root })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-0111-iso-state-')))
  const client = new FakeSdkClient()
  client.writes = 'worker-output.txt'
  const service = new FlashTaskService({
    root,
    clientFactory: () => client,
    log: () => {},
    isolate: { slots: 1, stateDir },
    honoursModelEnv: () => true,
    earlyRetryDelayMs: 0,
    maxResultChars: 24_000,
    env: { DSH_HOME: join(root, 'no-harness-home') },
    ...overrides,
  })
  const cleanup = async () => {
    await service.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  }
  return { root, client, service, cleanup }
}

/** The tool caller over a service, as the server wires it. */
function callerFor(service) {
  const jobs = new JobRegistry()
  return { jobs, call: createToolCaller({ service, jobs }) }
}

/** The structured payload of a tool result. */
function payload(result) {
  assert.notEqual(result.isError, true, result.content?.[0]?.text)
  return result.structuredContent
}

/** Wait (briefly) for a condition a concurrent call will reach. */
async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${label}`)
}

// ── 1. the final-message check ─────────────────────────────────────────────

test('finalMessageProblem names an empty message, tool-call markup, and nothing else', () => {
  assert.equal(finalMessageProblem(''), 'empty')
  assert.equal(finalMessageProblem('  \n\t \n'), 'empty')
  assert.equal(finalMessageProblem(DSML_CALLS), 'tool-call-markup')
  assert.equal(finalMessageProblem(DSML_INVOKE), 'tool-call-markup')
  assert.equal(finalMessageProblem(BASH_INVOKE), 'tool-call-markup')
  assert.equal(finalMessageProblem('<function_calls>\n<invoke name="bash">'), 'tool-call-markup')
  assert.equal(finalMessageProblem('done\n<tool_call>{"name":"bash"}</tool_call>'), 'tool-call-markup')
  assert.equal(finalMessageProblem('<|tool▁call▁begin|>function<|tool▁sep|>bash'), 'tool-call-markup')
  assert.equal(finalMessageProblem('<｜tool▁calls▁begin｜>'), 'tool-call-markup')

  assert.equal(finalMessageProblem('Edited a.js and ran `npm test`: 12 passed.'), null)
  assert.equal(finalMessageProblem(LONG_REPORT), null)
  assert.equal(LONG_REPORT.length, 30_000)
})

test('markup a report only quotes, in a fenced block or in backticks, is not markup', () => {
  const fenced = [
    'The worker once ended with this text instead of a report:',
    '',
    '```',
    DSML_CALLS,
    '```',
    '',
    'Nothing like that happened this time; all three edits are in.',
  ].join('\n')
  assert.equal(finalMessageProblem(fenced), null)
  assert.equal(finalMessageProblem('A line such as `<｜DSML｜ invoke name="edit">` is a parser symptom, not an edit.'), null)
  assert.equal(finalMessageProblem('~~~xml\n<function_calls>\n~~~\nAll done.'), null)
  // An unclosed fence hides the rest of the message, markup or not; the prose before it counts.
  assert.equal(finalMessageProblem('Report.\n```\n<function_calls>'), null)
  assert.equal(finalMessageProblem(`Report.\n${DSML_CALLS}\n\`\`\`\nquoted\n\`\`\``), 'tool-call-markup')
})

for (const [name, text] of [
  ['DSML calls', DSML_CALLS],
  ['DSML invoke', DSML_INVOKE],
  ['a bare invoke', BASH_INVOKE],
]) {
  test(`flash_task: a final message of ${name} is an error that names the stored patch`, async () => {
    const { root, client, service, cleanup } = makeIsolatedService()
    client.finalText = text
    const { call } = callerFor(service)
    const result = payload(await call('flash_task', { task: 'edit a.js', cwd: root }))

    assert.equal(result.status, 'error')
    assert.equal(result.stopReason, 'completed', 'the worker said it completed; the check overrules the status only')
    assert.equal(result.finalMessageProblem, 'tool-call-markup')
    assert.equal(result.result, text, 'the message itself is still returned')
    const patchId = result.change.patchId
    assert.ok(patchId && service.isolation.patches.has(patchId), 'the change so far is stored')
    const warning = result.warnings.find((line) => line.startsWith("the worker's last message was not a report"))
    assert.ok(warning, `expected the warning in ${JSON.stringify(result.warnings)}`)
    assert.match(warning, /its last planned tool call never ran/)
    assert.ok(warning.includes(patchId), warning)
    assert.ok(warning.includes(JSON.stringify(text.trim().replace(/\s+/g, ' ').slice(0, 200))), 'quotes the message')
    assert.match(warning, /verify them, and continue with basePatch/)
    assert.equal(client.prompts.length, 1, 'the job is not re-run automatically')
    await cleanup()
  })
}

test('flash_task: a whitespace-only message with a change is an error, not an ok with a footnote', async () => {
  const { root, client, service, cleanup } = makeIsolatedService()
  client.finalText = '  \n '
  const result = await service.flashTask({ task: 'write a file', cwd: root })
  assert.equal(result.status, 'error')
  assert.equal(result.finalMessageProblem, 'empty')
  assert.ok(result.warnings.some((line) => line.includes(`stored as patch ${result.change.patchId}`)))
  await cleanup()
})

test('flash_task: a report that quotes markup in a code block stays ok', async () => {
  const { root, client, service, cleanup } = makeIsolatedService()
  client.finalText = `Fixed the parser.\n\n\`\`\`\n${DSML_CALLS}\n\`\`\`\n\nThat string no longer reaches the output.`
  const result = await service.flashTask({ task: 'fix', cwd: root })
  assert.equal(result.status, 'ok')
  assert.equal(result.finalMessageProblem, undefined)
  await cleanup()
})

test('flash_batch: a member that ends in markup is an error for that task and makes the fleet partial', async () => {
  const { root, client, service, cleanup } = makeIsolatedService()
  client.memberTexts = ['Edited a.js; tests pass.', DSML_CALLS, '   ']
  const { call } = callerFor(service)
  const result = payload(await call('flash_batch', { tasks: ['a', 'b', 'c'], cwd: root }))

  assert.deepEqual(result.results.map((entry) => entry.status), ['ok', 'error', 'error'])
  assert.deepEqual(result.results.map((entry) => entry.finalMessageProblem), [undefined, 'tool-call-markup', 'empty'])
  assert.equal(result.status, 'partial')
  assert.ok(result.warnings.some((line) => line.startsWith("task 2: the worker's last message was not a report")))
  assert.ok(result.warnings.some((line) => line.startsWith("task 3: the worker's last message was not a report")))
  await cleanup()
})

// ── 2. state matches result ────────────────────────────────────────────────

test('a background job whose worker ended in error reads error in flash_status and flash_result', async () => {
  const { root, client, service, cleanup } = makeIsolatedService()
  client.finalStatus = 'error'
  client.finalStop = 'error'
  client.finalText = ''
  const { call } = callerFor(service)
  const started = payload(await call('flash_task', { task: 'x', cwd: root, background: true }))
  const result = payload(await call('flash_result', { jobId: started.jobId, waitSeconds: 10 }))
  const status = payload(await call('flash_status', { jobId: started.jobId }))

  assert.equal(result.status, 'error')
  assert.equal(result.stopReason, 'error')
  assert.equal(result.job.state, 'error')
  assert.equal(status.state, 'error')
  assert.equal(status.resultReady, true)
  await cleanup()
})

test('a background job that ended in a markup message reads error too, and an ok one still reads ok', async () => {
  const { root, client, service, cleanup } = makeIsolatedService()
  const { call } = callerFor(service)
  client.finalText = DSML_CALLS
  const bad = payload(await call('flash_task', { task: 'x', cwd: root, background: true }))
  await call('flash_result', { jobId: bad.jobId, waitSeconds: 10 })
  assert.equal(payload(await call('flash_status', { jobId: bad.jobId })).state, 'error')

  client.finalText = 'all done'
  const good = payload(await call('flash_task', { task: 'y', cwd: root, background: true }))
  await call('flash_result', { jobId: good.jobId, waitSeconds: 10 })
  assert.equal(payload(await call('flash_status', { jobId: good.jobId })).state, 'ok')
  await cleanup()
})

// ── 3. whole reports on disk, every mode ───────────────────────────────────

test('a writing call stores its whole 30,000-character report; the cut result names the file', async () => {
  const { root, client, service, cleanup } = makeIsolatedService()
  client.finalText = LONG_REPORT
  const result = await service.flashTask({ task: 'write a file', cwd: root })

  assert.equal(result.resultTruncated, true)
  assert.ok(result.reportPath, 'the result names the report file')
  assert.match(result.result, new RegExp(`the whole report is stored at ${result.reportPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]$`))
  assert.equal(JSON.parse(readFileSync(result.reportPath, 'utf8')).report, LONG_REPORT)

  // The patch record keeps its 8,000-character excerpt and points at the whole report;
  // the first page of flash_patch returns the whole.
  const record = JSON.parse(readFileSync(result.change.patchPath.replace(/\.patch$/, '.json'), 'utf8'))
  assert.equal(record.finalMessage.length, 8000)
  assert.equal(record.finalMessageTruncated, true)
  assert.equal(record.reportPath, result.reportPath)
  const page = service.flashPatch({ patchId: result.change.patchId })
  assert.equal(page.finalMessage, LONG_REPORT)
  assert.equal(page.finalMessageTruncated, undefined)
  assert.equal(page.reportPath, result.reportPath)
  await cleanup()
})

test('a read-only call and an apply "discard" call keep their whole reports on disk too', async () => {
  const { root, client, service, cleanup } = makeIsolatedService()
  client.finalText = LONG_REPORT

  const readOnly = await service.flashTask({ task: 'review', cwd: root, mode: 'read-only' })
  assert.equal(readOnly.change, undefined, 'a read-only call has no copy')
  assert.equal(readOnly.resultTruncated, true)
  assert.match(readOnly.result, /the whole report is stored at /)
  assert.equal(JSON.parse(readFileSync(readOnly.reportPath, 'utf8')).report, LONG_REPORT)

  const discarded = await service.flashTask({ task: 'check', cwd: root, apply: 'discard' })
  assert.equal(discarded.change.patchId, undefined)
  assert.equal(JSON.parse(readFileSync(discarded.reportPath, 'utf8')).report, LONG_REPORT)
  await cleanup()
})

test('a fleet stores every member’s whole message', async () => {
  const { root, client, service, cleanup } = makeIsolatedService({ perItemChars: 12_000 })
  client.memberTexts = [LONG_REPORT, 'short one']
  const result = await service.flashBatch({ tasks: ['a', 'b'], cwd: root })
  assert.equal(result.results[0].resultTruncated, false, 'the budget is 24,000 and the script cut at 12,000')
  const stored = JSON.parse(readFileSync(result.reportPath, 'utf8'))
  assert.ok(stored.report.includes(LONG_REPORT), 'the member message is whole, not the script’s cut')
  assert.ok(stored.report.includes('task 2 (ok): short one'))
  await cleanup()
})

test('flash_result answers from disk for a job the server no longer holds', async () => {
  const { root, client, service, cleanup } = makeIsolatedService()
  client.finalText = LONG_REPORT
  const first = callerFor(service)
  const started = payload(await first.call('flash_task', { task: 'review', cwd: root, mode: 'read-only', background: true }))
  await first.call('flash_result', { jobId: started.jobId, waitSeconds: 10 })

  // A restarted server has the same stored files and no jobs.
  const restarted = callerFor(service)
  const again = payload(await restarted.call('flash_result', { jobId: started.jobId }))
  assert.equal(again.status, 'ok')
  assert.equal(again.report, LONG_REPORT)
  assert.equal(again.jobId, started.jobId)
  assert.ok(again.reportPath.endsWith(`${started.jobId}.report.json`))

  const unknown = await restarted.call('flash_result', { jobId: 'job-00000000' })
  assert.equal(unknown.isError, true)
  assert.match(unknown.content[0].text, /unknown job/)
  const traversal = await restarted.call('flash_result', { jobId: '../../etc/passwd' })
  assert.equal(traversal.isError, true)
  await cleanup()
})

// ── 4. cancel keeps the work ───────────────────────────────────────────────

test('flash_cancel on a writing job stores the copy’s change as a patch and returns it', async () => {
  const { root, client, service, cleanup } = makeIsolatedService()
  client.silent = true
  const { call } = callerFor(service)
  const started = payload(await call('flash_task', { task: 'hangs after writing', cwd: root, background: true }))
  await waitFor(() => client.prompts.length > 0, 'the worker to start')

  const cancelled = payload(await call('flash_cancel', { jobId: started.jobId }))
  assert.equal(cancelled.state, 'cancelled')
  assert.match(cancelled.patchId, /^flash-/)
  assert.match(cancelled.diffstat, /1 file changed, 1 insertion/)
  assert.deepEqual(cancelled.filesChanged, ['worker-output.txt'])

  const page = payload(await call('flash_patch', { patchId: cancelled.patchId }))
  assert.match(page.diff, /worker-output\.txt/)
  assert.equal(page.cancelled.jobId, started.jobId, 'the record says it came from a cancelled job')
  // The mark is on disk, not only in memory.
  const record = JSON.parse(readFileSync(service.isolation.patches.get(cancelled.patchId).metaPath, 'utf8'))
  assert.equal(record.cancelled.jobId, started.jobId)
  await cleanup()
})

test('flash_cancel on a writing job whose copy holds no change stores nothing and says so', async () => {
  const { root, client, service, cleanup } = makeIsolatedService()
  client.silent = true
  client.writes = undefined
  const { call } = callerFor(service)
  const started = payload(await call('flash_task', { task: 'hangs before writing', cwd: root, background: true }))
  await waitFor(() => client.prompts.length > 0, 'the worker to start')

  const cancelled = payload(await call('flash_cancel', { jobId: started.jobId }))
  assert.equal(cancelled.state, 'cancelled')
  assert.equal(cancelled.patchId, undefined)
  assert.equal(cancelled.stored, false)
  assert.match(cancelled.storedNote, /held no change/)
  assert.equal(service.isolation.patches.size, 0)
  await cleanup()
})

test('flash_cancel on a read-only job has nothing to store and does not claim to', async () => {
  const { root, client, service, cleanup } = makeIsolatedService()
  client.silent = true
  const { call } = callerFor(service)
  const started = payload(await call('flash_task', { task: 'reviewing', cwd: root, mode: 'read-only', background: true }))
  await waitFor(() => client.prompts.length > 0, 'the worker to start')

  const cancelled = payload(await call('flash_cancel', { jobId: started.jobId }))
  assert.equal(cancelled.state, 'cancelled')
  assert.equal(cancelled.patchId, undefined)
  assert.equal(cancelled.stored, undefined)
  assert.equal(service.isolation.patches.size, 0)
  assert.equal(existsSync(join(service.isolation.patchDir, `${started.jobId}.report.json`)), false, 'a cancelled call has no report')
  await cleanup()
})
