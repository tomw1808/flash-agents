/**
 * 0.1.11 small-traps tests: fewer traps for the caller and the worker. A call's own `label`, the
 * `readOnly` alias, patches that overlap, the `source: "head"` note, a state base that says why
 * the server will not start, the doctor's profile row, and the worker's standing instructions.
 * Everything goes through the tool caller, the service and the entry point the server really
 * runs; the runtime is faked, and every path is a throwaway under one scratch directory, so
 * nothing here touches a real home, `DSH_HOME`, the real temp state base or the real data
 * directory, and `icacls` is never run.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FlashTaskService,
  WINDOWS_SHELL_INSTRUCTION,
  WINDOWS_TOOLING_INSTRUCTION,
  WORKER_INSTRUCTIONS,
  buildChildPrompt,
} from '../lib/service.js'
import { createToolCaller, listTools, runDoctor, toolArgumentNames, unknownArgumentsMessage } from '../lib/index.js'
import { runChecks } from '../lib/doctor.js'
import { JobRegistry } from '../lib/jobs.js'

/** Everything this file makes lives here, and the platform temp area points here too. */
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'flash-small-0111-')))
mkdirSync(join(SCRATCH, 'tmp'))
process.env.TMPDIR = join(SCRATCH, 'tmp')
process.env.TEMP = join(SCRATCH, 'tmp')
process.env.TMP = join(SCRATCH, 'tmp')
process.env.FLASH_DATA_DIR = join(SCRATCH, 'data')

const ENTRY = fileURLToPath(new URL('../lib/index.js', import.meta.url))

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
  const root = realpathSync(mkdtempSync(join(SCRATCH, 'root-')))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  writeFileSync(join(root, 'README.md'), '# project\n')
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: root })
  const stateDir = realpathSync(mkdtempSync(join(SCRATCH, 'state-')))
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

/** The text of a refused tool result. */
function refusal(result) {
  assert.equal(result.isError, true, 'the call must be refused')
  return result.content[0].text
}

// ── 1. label ───────────────────────────────────────────────────────────────

test('label replaces the brief\'s first line in the patch record, the stored report and flash_status', async () => {
  const { root, service, cleanup } = makeIsolatedService({ models: ['deepseek-v4.1-flash:cloud', 'deepseek-v4.1-flash:1017-cloud'] })
  const { call, jobs } = callerFor(service)
  const brief = '# Shared rules\n\nThe real work: add the parser.'

  const plain = payload(await call('flash_task', { task: brief, cwd: root }))
  assert.equal(service.isolation.patches.get(plain.change.patchId).task.label, 'Shared rules', 'no label: the brief decides')

  const named = payload(await call('flash_task', { task: brief, cwd: root, label: '  parser slice  ' }))
  assert.equal(service.isolation.patches.get(named.change.patchId).task.label, 'parser slice', 'trimmed, and it wins')
  const page = payload(await call('flash_patch', { patchId: named.change.patchId }))
  assert.equal(page.task.label, 'parser slice')

  const started = payload(await call('flash_task', { task: brief, cwd: root, label: 'second slice', model: 'deepseek-v4.1-flash:1017-cloud', background: true }))
  assert.equal(started.label, '[deepseek-v4.1-flash:1017-cloud] second slice')
  const waited = payload(await call('flash_result', { jobId: started.jobId, waitSeconds: 30 }))
  assert.equal(service.isolation.patches.get(waited.change.patchId).task.label, 'second slice')
  assert.equal(service.readReport(started.jobId).label, 'second slice')
  const status = payload(await call('flash_status', { jobId: started.jobId }))
  assert.equal(status.label, '[deepseek-v4.1-flash:1017-cloud] second slice')

  const unnamed = payload(await call('flash_task', { task: brief, cwd: root, background: true }))
  assert.equal(unnamed.label, '# Shared rules', 'without a label the job keeps the first line')
  await jobs.waitFor(unnamed.jobId, 30_000)
  await cleanup()
})

test('label on flash_batch names the fleet\'s patch and job', async () => {
  const { root, service, cleanup } = makeIsolatedService()
  const { call } = callerFor(service)
  const result = payload(await call('flash_batch', { tasks: ['a', 'b'], cwd: root, label: 'two probes' }))
  assert.equal(service.isolation.patches.get(result.change.patchId).task.label, 'two probes')
  const started = payload(await call('flash_batch', { tasks: ['a', 'b'], cwd: root, label: 'two more', background: true }))
  assert.equal(started.label, 'two more')
  await cleanup()
})

test('a label that is empty, blank, too long or not text is refused with a clear error, before any job exists', async () => {
  const { root, service, cleanup } = makeIsolatedService()
  const { call, jobs } = callerFor(service)
  for (const bad of ['', '   \n', 'x'.repeat(121), 7, ['a']]) {
    for (const background of [false, true]) {
      const text = refusal(await call('flash_task', { task: 'do it', cwd: root, label: bad, background }))
      assert.match(text, /^flash_task failed: label must be a string of 1 to 120 characters once trimmed/, text)
    }
  }
  assert.match(refusal(await call('flash_batch', { tasks: ['a'], cwd: root, label: '' })), /^flash_batch failed: label must be/)
  assert.equal(jobs.counts().running + jobs.counts().ended, 0, 'a refused background call never became a job')
  assert.equal(service.client, undefined)
  // The edges are fine: 1 and 120 characters once trimmed.
  assert.equal(payload(await call('flash_task', { task: 'do it', cwd: root, label: ` ${'y'.repeat(120)} ` })).status, 'ok')
  await cleanup()
})

// ── 2. readOnly ────────────────────────────────────────────────────────────

test('readOnly: true runs the call as mode "read-only"; false changes nothing', async () => {
  const { root, client, service, cleanup } = makeIsolatedService()
  client.writes = undefined
  const { call } = callerFor(service)
  const ro = payload(await call('flash_task', { task: 'review it', cwd: root, readOnly: true }))
  assert.equal(ro.mode, 'read-only')
  assert.equal(ro.isolation.mode, 'none', 'a read-only call is not isolated')
  assert.equal(ro.change, undefined)

  const same = payload(await call('flash_task', { task: 'review it', cwd: root, readOnly: true, mode: 'read-only' }))
  assert.equal(same.mode, 'read-only')

  const off = payload(await call('flash_task', { task: 'review it', cwd: root, readOnly: false }))
  assert.equal(off.mode, 'workspace-write')
  const offWithMode = payload(await call('flash_task', { task: 'review it', cwd: root, readOnly: false, mode: 'read-only' }))
  assert.equal(offWithMode.mode, 'read-only', 'false is a no-op, so mode still decides')
  await cleanup()
})

test('readOnly: true beside a writing mode is refused naming the conflict, and so is a non-boolean', async () => {
  const { root, service, cleanup } = makeIsolatedService()
  const { call } = callerFor(service)
  for (const background of [false, true]) {
    const text = refusal(await call('flash_task', { task: 'x', cwd: root, readOnly: true, mode: 'workspace-write', background }))
    assert.match(text, /readOnly: true conflicts with mode "workspace-write"/, text)
  }
  assert.match(refusal(await call('flash_task', { task: 'x', cwd: root, readOnly: 'yes' })), /readOnly must be a boolean/)
  await cleanup()
})

test('the schema declares label and readOnly, and the did-you-mean machinery knows them', () => {
  const tools = listTools()
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  assert.equal(byName.get('flash_task').inputSchema.properties.label.type, 'string')
  assert.equal(byName.get('flash_batch').inputSchema.properties.label.type, 'string')
  assert.equal(byName.get('flash_task').inputSchema.properties.readOnly.type, 'boolean')
  assert.equal(byName.get('flash_batch').inputSchema.properties.readOnly, undefined)
  const names = toolArgumentNames(tools)
  assert.equal(unknownArgumentsMessage('flash_task', { cwd: '/x', readonly: true }, names.get('flash_task')), 'unknown argument "readonly" for flash_task; did you mean "readOnly"?')
  assert.equal(unknownArgumentsMessage('flash_task', { cwd: '/x', read_only: true }, names.get('flash_task')), 'unknown argument "read_only" for flash_task; did you mean "readOnly"?')
  assert.equal(unknownArgumentsMessage('flash_task', { cwd: '/x', lable: 'a' }, names.get('flash_task')), 'unknown argument "lable" for flash_task; did you mean "label"?')
  assert.equal(unknownArgumentsMessage('flash_task', { cwd: '/x', readOnly: true, label: 'a' }, names.get('flash_task')), undefined)
})

test('the tool descriptions say what flash_apply returns per file and what flash_patch lists', () => {
  const byName = new Map(listTools().map((tool) => [tool.name, tool.description]))
  const apply = byName.get('flash_apply')
  for (const word of ['`status`', '`files`', '`applied`', '`merged`', '`conflict`', '`failed`', '`appliable`']) {
    assert.ok(apply.includes(word), `flash_apply should mention ${word}`)
  }
  assert.ok(byName.get('flash_patch').includes('`overlaps`'))
})

// ── 3. overlapping patches ─────────────────────────────────────────────────

test('overlaps: stored, unapplied patches that change the same files are listed on the result and the first page', async () => {
  const { root, client, service, cleanup } = makeIsolatedService()
  const { call } = callerFor(service)
  client.writes = 'db/migrations/0007_next.sql'
  mkdirSync(join(root, 'db/migrations'), { recursive: true })
  const first = payload(await call('flash_task', { task: '# Add users table', cwd: root, label: 'users table' }))
  assert.equal(first.overlaps, undefined, 'nothing else is stored: the field is omitted')
  assert.equal(payload(await call('flash_patch', { patchId: first.change.patchId })).overlaps, undefined)

  const second = payload(await call('flash_task', { task: '# Add orders table', cwd: root }))
  assert.deepEqual(second.overlaps, [
    {
      patchId: first.change.patchId,
      files: ['db/migrations/0007_next.sql'],
      label: 'users table',
      createdAt: service.isolation.patches.get(first.change.patchId).createdAt,
    },
  ])
  const page = payload(await call('flash_patch', { patchId: first.change.patchId }))
  assert.equal(page.overlaps.length, 1)
  assert.equal(page.overlaps[0].patchId, second.change.patchId)
  assert.equal(page.overlaps[0].label, 'Add orders table')
  const later = payload(await call('flash_patch', { patchId: first.change.patchId, offset: 1, maxChars: 50 }))
  assert.equal(later.overlaps, undefined, 'only the first page carries it')

  // A patch that touches other files is no overlap.
  client.writes = 'other.txt'
  const third = payload(await call('flash_task', { task: '# Unrelated', cwd: root }))
  assert.equal(third.overlaps, undefined)
  await cleanup()
})

test('overlaps: an applied patch is not listed, a continuation supersedes its base, and the base is recorded', async () => {
  const { root, client, service, cleanup } = makeIsolatedService()
  const { call } = callerFor(service)
  client.writes = 'schema.sql'
  const a = payload(await call('flash_task', { task: '# A', cwd: root }))
  const b = payload(await call('flash_task', { task: '# B', cwd: root }))
  const c = payload(await call('flash_task', { task: '# C continues A', cwd: root, basePatch: a.change.patchId }))

  // C contains A, so A is no overlap of C; B is.
  assert.deepEqual(c.overlaps.map((entry) => entry.patchId), [b.change.patchId])
  const record = JSON.parse(readFileSync(service.isolation.patches.get(c.change.patchId).metaPath, 'utf8'))
  assert.equal(record.basePatch, a.change.patchId, 'the continuation is persisted with the record')
  // And from A's side: its continuation is not an overlap either.
  assert.deepEqual(payload(await call('flash_patch', { patchId: a.change.patchId })).overlaps.map((entry) => entry.patchId), [b.change.patchId])

  // Once A is in the tree it is gone from B's list, leaving C.
  payload(await call('flash_apply', { patchId: a.change.patchId }))
  assert.deepEqual(payload(await call('flash_patch', { patchId: b.change.patchId })).overlaps.map((entry) => entry.patchId), [c.change.patchId])
  await cleanup()
})

// ── 4. source: "head" ──────────────────────────────────────────────────────

test('source "head" warns how many uncommitted files it left out, naming at most five', async () => {
  const { root, service, cleanup } = makeIsolatedService()
  writeFileSync(join(root, 'README.md'), '# project, edited\n')
  for (const name of ['u1.txt', 'u2.txt', 'u3.txt', 'u4.txt', 'u5.txt', 'u6.txt']) writeFileSync(join(root, name), 'wip\n')
  const result = await service.flashTask({ task: 'work', cwd: root, source: 'head' })
  const warning = result.warnings.find((line) => line.startsWith('source "head" left out'))
  assert.ok(warning, JSON.stringify(result.warnings))
  assert.match(warning, /^source "head" left out 7 uncommitted files of your tree \(([^,]+, ){4}[^,]+, …\); the patch is against the last commit and may not apply on top of them$/)
  assert.equal(result.isolation.uncommittedAtStart, undefined, 'the copy itself started clean')

  const fromTree = await service.flashTask({ task: 'work', cwd: root })
  assert.ok(!(fromTree.warnings ?? []).some((line) => line.includes('source "head"')), 'the default source carries the work, so there is nothing to warn about')
  await cleanup()
})

test('source "head" says nothing when the tree is clean, and names every file when there are few', async () => {
  const { root, service, cleanup } = makeIsolatedService()
  const clean = await service.flashTask({ task: 'work', cwd: root, source: 'head' })
  assert.ok(!(clean.warnings ?? []).some((line) => line.includes('source "head"')))
  writeFileSync(join(root, 'wip.txt'), 'x\n')
  const one = await service.flashTask({ task: 'work', cwd: root, source: 'head' })
  assert.ok(
    one.warnings.includes('source "head" left out 1 uncommitted files of your tree (wip.txt); the patch is against the last commit and may not apply on top of them'),
    JSON.stringify(one.warnings),
  )
  await cleanup()
})

// ── 5. a state base that cannot be used ────────────────────────────────────

/** A value `requireAbsoluteStateBase` refuses on this platform (`C:\fm` on Linux and macOS). */
const BAD_STATE_BASE = process.platform === 'win32' ? 'relative\\fm' : 'C:\\fm'

/** Run the real server entry with a bad state base, in a throwaway environment. */
function runServerWithBadBase(extra = {}) {
  const home = realpathSync(mkdtempSync(join(SCRATCH, 'srv-')))
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: join(home, 'dsh'),
    TMPDIR: join(home, 'tmp'),
    TEMP: join(home, 'tmp'),
    TMP: join(home, 'tmp'),
    FLASH_DATA_DIR: join(home, 'data'),
    FLASH_STATE_BASE: BAD_STATE_BASE,
    ...extra(home),
  }
  const run = spawnSync(process.execPath, [ENTRY, 'serve', '--root', home], { env, encoding: 'utf8', timeout: 30_000 })
  return { home, run }
}

test('a server whose state_base is unusable writes why to flash.log and stderr before it exits 2', () => {
  const { home, run } = runServerWithBadBase((dir) => ({ FLASH_LOG_FILE: join(dir, 'logs', 'flash.log') }))
  // The log directory does not exist yet: the reason must still land.
  assert.equal(run.status, 2)
  const log = readFileSync(join(home, 'logs', 'flash.log'), 'utf8')
  for (const text of [log, run.stderr]) {
    assert.match(text, /plugin setting "state_base" \(FLASH_STATE_BASE\)/)
    assert.ok(text.includes(JSON.stringify(BAD_STATE_BASE)), text)
    assert.ok(text.includes(process.platform), 'names the platform')
    assert.match(text, /cannot start/)
  }
  assert.match(log, /^\d{4}-\d\d-\d\dT[\d:.]+Z \[flash-mcp\] cannot start/)
})

test('without a configured log file the reason goes to flash.log in the data directory, and says so', () => {
  const { home, run } = runServerWithBadBase(() => ({}))
  assert.equal(run.status, 2)
  const fallback = join(home, 'data', 'flash.log')
  assert.ok(existsSync(fallback), 'the fallback flash.log exists')
  assert.match(readFileSync(fallback, 'utf8'), /cannot start: the plugin setting "state_base"/)
  assert.ok(run.stderr.includes(`logged to ${fallback}`), run.stderr)
})

test('an unrelated bad option still exits 2 without touching flash.log', () => {
  const home = realpathSync(mkdtempSync(join(SCRATCH, 'srv-')))
  const log = join(home, 'flash.log')
  const run = spawnSync(process.execPath, [ENTRY, 'serve', '--bogus'], {
    env: { PATH: process.env.PATH, HOME: home, FLASH_LOG_FILE: log, FLASH_DATA_DIR: join(home, 'data') },
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(run.status, 2)
  assert.equal(existsSync(log), false)
})

// ── 6. doctor ──────────────────────────────────────────────────────────────

/** Injected effects for the doctor: no binary is run and no socket is opened. */
function doctorFakes({ dump }) {
  return {
    launcher: { command: 'dsh', prefix: [] },
    run: (command, args) => {
      if (command === 'dsh') return args[0] === '--version' ? { status: 0, stdout: '0.2.0-rc.2\n', stderr: '' } : dump
      return { status: 0, stdout: '', stderr: '' }
    },
    probe: async () => true,
    generate: async () => ({ ok: true, status: 200, ms: 10 }),
  }
}

/** What Node prints for an uncaught error: a source location first, the message later. */
const STACK_STDERR = [
  '/usr/lib/node_modules/@deepseek-ai/dsh/dist/index.js:974',
  '      throw new Error(`profile ${name} not found`)',
  '      ^',
  '',
  'Error: profile "flash-service" not found in /nowhere/profiles',
  '    at resolveProfile (/usr/lib/node_modules/@deepseek-ai/dsh/dist/index.js:974:13)',
].join('\n')

test('doctor: on a fresh machine the profile row says the profile is missing and how to install it', async () => {
  const dshHome = realpathSync(mkdtempSync(join(SCRATCH, 'dsh-')))
  const result = await runChecks({ ...doctorFakes({ dump: { status: 1, stdout: '', stderr: STACK_STDERR } }), dshHome, env: { DSH_HOME: dshHome } })
  const row = result.checks.find((check) => check.id === 'profile')
  assert.equal(row.status, 'fail')
  assert.match(row.detail, /the flash-service profile is not installed/)
  assert.ok(row.detail.includes(join(dshHome, 'profiles', 'flash-service')))
  assert.match(row.detail, /run node install\.mjs in the plugin folder/)
  assert.equal(row.fix, 'node install.mjs')
  assert.ok(!/index\.js:974/.test(row.detail), row.detail)
})

test('doctor: an installed profile that does not compose shows the error message, not a stack location', async () => {
  const dshHome = realpathSync(mkdtempSync(join(SCRATCH, 'dsh-')))
  mkdirSync(join(dshHome, 'profiles', 'flash-service'), { recursive: true })
  const result = await runChecks({ ...doctorFakes({ dump: { status: 1, stdout: '', stderr: STACK_STDERR } }), dshHome, env: { DSH_HOME: dshHome } })
  const row = result.checks.find((check) => check.id === 'profile')
  assert.equal(row.status, 'fail')
  assert.equal(row.detail, 'the flash-service profile did not compose: Error: profile "flash-service" not found in /nowhere/profiles')
})

test('doctor: a state_base the server would refuse is a failed row, and the other checks still run', async () => {
  const dshHome = realpathSync(mkdtempSync(join(SCRATCH, 'dsh-')))
  const lines = []
  const code = await runDoctor([], {
    env: { DSH_HOME: dshHome, FLASH_STATE_BASE: BAD_STATE_BASE, FLASH_SERVICE_ROOT: dshHome },
    write: (text) => lines.push(text),
    ...doctorFakes({ dump: { status: 0, stdout: '', stderr: '' } }),
  })
  const text = lines.join('')
  assert.equal(code, 1)
  const row = text.split('\n').find((line) => /^fail\s+state-base\s/.test(line))
  assert.ok(row, text)
  assert.match(row, /the server would not start: the plugin setting "state_base" \(FLASH_STATE_BASE\)/)
  assert.ok(row.includes(JSON.stringify(BAD_STATE_BASE)))
  assert.match(text, /\n(ok|warn|fail)\s+dsh\s/, 'the rest of the report is still there')
  assert.match(text, /Fix: state-base: clear the plugin option "state_base"/)
})

test('doctor: a bad --state-base flag keeps its invalid-option report', async () => {
  const lines = []
  const code = await runDoctor(['--state-base', 'rel'], { env: { DSH_HOME: join(SCRATCH, 'none') }, write: (text) => lines.push(text) })
  assert.equal(code, 2)
  assert.match(lines.join(''), /--state-base must be an absolute path \(got "rel"\)/)
})

// ── 7. the worker's standing instructions ──────────────────────────────────

test('the standing instructions carry each new rule, once per group', () => {
  const text = WORKER_INSTRUCTIONS.join('\n')
  const groups = {
    devices: ['no camera, microphone, display or GPU', 'never search the whole disk (`find /`)'],
    decisions: ['either done or named in the report as not done', 'Name each changed file you never ran', 'name the callers you did not touch', 'what existing records get for the new field'],
    checks: ['ran after your last edit; give the time beside it', 'agree with the measurement', '"pre-existing" or "the sandbox\'s" without checking'],
    protocol: ['take the shape from the other side\'s code and say where it came from', 'needs the caller\'s word, not only a line in the report'],
    rewrite: ['Do not rewrite lines you do not mean to change', 'keep a file\'s encoding and characters', '`â€¦`'],
  }
  for (const [group, phrases] of Object.entries(groups)) {
    const lines = WORKER_INSTRUCTIONS.filter((line) => phrases.every((phrase) => line.includes(phrase)) || phrases.some((phrase) => line.includes(phrase)))
    assert.equal(lines.length, 1, `${group}: grouped in one line`)
    for (const phrase of phrases) assert.ok(text.includes(phrase), `${group}: ${phrase}`)
  }
  assert.match(WORKER_INSTRUCTIONS.at(-1), /"Rules crossed"/, 'Rules crossed stays the last line')
})

test('the Windows lines reach a win32 worker only, next to the PowerShell line', () => {
  const linux = buildChildPrompt({ cwd: '/w', task: 'do it', platform: 'linux' })
  const win = buildChildPrompt({ cwd: 'C:\\w', task: 'do it', platform: 'win32' })
  const bare = buildChildPrompt({ cwd: '/w', task: 'do it' })
  for (const text of [linux, bare]) {
    assert.ok(!text.includes(WINDOWS_SHELL_INSTRUCTION))
    assert.ok(!text.includes(WINDOWS_TOOLING_INSTRUCTION))
  }
  assert.ok(win.includes(`${WINDOWS_SHELL_INSTRUCTION}\n${WINDOWS_TOOLING_INSTRUCTION}`))
  for (const phrase of ['`$env:X = value` does not carry over to the next command: set it in the same command', 'Ninja and parallel MSBuild', 'use the Visual Studio generator and one build node', 'no network here (TLS fails): use `--offline`']) {
    assert.ok(WINDOWS_TOOLING_INSTRUCTION.includes(phrase), phrase)
  }
  assert.ok(WINDOWS_TOOLING_INSTRUCTION.includes('/m` above 1') && WINDOWS_TOOLING_INSTRUCTION.includes('--parallel N'))
})

test.after(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})
