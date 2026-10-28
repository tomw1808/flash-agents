/**
 * Review of 0.1.10: each test here pins a defect found in the change, and fails until it is
 * fixed. Real `git` and real temporary trees for the apply side; the runtime is a stand-in
 * for the service side. Every directory is a fresh temporary one, and the data directory is
 * pointed at one of them: nothing here reads or writes the real home, `DSH_HOME`, temp state
 * base or data directory.
 */

import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { WorkspaceIsolation } from '../lib/isolation.js'
import { FlashTaskService } from '../lib/service.js'
import { createToolCaller } from '../lib/index.js'
import { JobRegistry } from '../lib/jobs.js'

const GIT_ID = ['-c', 'user.email=t@t', '-c', 'user.name=t']

/** Every directory this file made, removed once it finishes. */
const madeDirs = []

/** A fresh temporary directory, realpath'd so macOS `/var` vs `/private/var` cannot bite. */
function tempDir(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  madeDirs.push(dir)
  return dir
}

// Default-layout pools store patches in the durable data directory; keep them out of the real one.
process.env.FLASH_DATA_DIR = tempDir('flash-review-data-')

after(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true })
})

/** Write files under a directory, creating their parents. */
function writeFiles(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
}

/**
 * A throwaway repository holding `files` byte for byte: `core.autocrlf` is pinned off in the
 * repository itself, so neither a global setting nor the merge's scratch repository (which
 * copies this value) converts anything.
 */
function makeRepo(files) {
  const dir = tempDir('flash-review-')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir })
  writeFiles(dir, files)
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', [...GIT_ID, 'commit', '-q', '-m', 'init'], { cwd: dir })
  return dir
}

/** One isolation pool over a repository, with its own state directory. */
function makePool(repo) {
  return new WorkspaceIsolation({ root: repo, slots: 1, stateDir: tempDir('flash-review-state-') })
}

/** Collect one change in a fresh copy and hand the slot back, as a finished call does. */
async function finishedChange(isolation, mutate) {
  const slot = await isolation.lease()
  isolation.prepare(slot)
  mutate(slot.dir)
  const change = isolation.collect(slot)
  isolation.discard(slot)
  isolation.release(slot)
  return change
}

const TWELVE_LINES = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\n'
const WORKER = TWELVE_LINES.replace('l2\n', 'l2 WORKER\n')
const CALLER = TWELVE_LINES.replace('l4\n', 'l4 CALLER\n')
const BOTH = WORKER.replace('l4\n', 'l4 CALLER\n')
const crlf = (text) => text.replace(/\n/g, '\r\n')

// ── A: three-way apply and line endings ──────────────────────────────────────

test('review: a three-way apply keeps the worker’s own CRLF-to-LF conversion of a file', async () => {
  // `conv.txt` is CRLF in the repository; the worker's whole change to it is converting it
  // to LF. The caller's edit to `a.txt` makes the plain apply fail, so both go through the
  // merge, and the merge result for `conv.txt` is the worker's LF file (the caller never
  // touched it). `mergedContent` then re-imposes the caller's CRLF on it: the change is
  // reported applied, with no conflict, and is not in the tree.
  const repo = makeRepo({ 'a.txt': TWELVE_LINES, 'conv.txt': crlf(TWELVE_LINES) })
  const isolation = makePool(repo)
  const change = await finishedChange(isolation, (dir) => {
    writeFileSync(join(dir, 'a.txt'), WORKER)
    writeFileSync(join(dir, 'conv.txt'), TWELVE_LINES)
  })
  assert.deepEqual(change.filesChanged.map((line) => line.split('\t').at(-1)).sort(), ['a.txt', 'conv.txt'])
  writeFileSync(join(repo, 'a.txt'), CALLER)

  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.threeWay, true)
  assert.equal(applied.applied, true)
  assert.deepEqual(applied.conflicts, [])
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), BOTH)
  assert.equal(readFileSync(join(repo, 'conv.txt'), 'utf8'), TWELVE_LINES, 'the worker’s LF conversion reached the tree')
  isolation.close()
})

test('review: a three-way apply leaves the line endings of lines it did not change alone in a mixed file', async () => {
  // A CRLF file with one LF line (a heredoc in a .bat, a pasted block): the worker edits
  // line 2, the caller line 4. The merged blob still has line 8's LF, exactly as the caller's
  // file does; normalising every break to the majority style rewrites line 8, which neither
  // side touched. Before 0.1.10, `cat-file --filters` with no conversion configured wrote
  // the merged bytes unchanged.
  const mixed = (text) => crlf(text).replace('l8\r\n', 'l8\n')
  const repo = makeRepo({ 'm.txt': mixed(TWELVE_LINES) })
  const isolation = makePool(repo)
  const change = await finishedChange(isolation, (dir) => writeFileSync(join(dir, 'm.txt'), mixed(WORKER)))
  writeFileSync(join(repo, 'm.txt'), mixed(CALLER))

  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.threeWay, true)
  assert.deepEqual(applied.conflicts, [])
  assert.equal(
    JSON.stringify(readFileSync(join(repo, 'm.txt'), 'utf8')),
    JSON.stringify(mixed(BOTH)),
    'only the two edited lines differ from the caller’s file',
  )
  isolation.close()
})

test(
  'review: a three-way apply writes back a merged text file larger than 128 MiB',
  { timeout: 300_000 },
  async () => {
    // The git helpers now allow 1 GiB of output, but `withLineEndings` builds the converted
    // file in a plain JS array, one element per byte: V8 refuses an array past 2^27
    // elements, so any existing text file over ~134 MB fails the read with "Invalid array
    // length" (and needs ~20 bytes of heap per byte of file before that).
    const line = `${'x'.repeat(99)}\n`
    const big = line.repeat(1_400_000) // 140 MB
    const repo = makeRepo({ 'a.txt': TWELVE_LINES, 'big.txt': big })
    const isolation = makePool(repo)
    const workerBig = `WORKER\n${big}`
    const change = await finishedChange(isolation, (dir) => {
      writeFileSync(join(dir, 'a.txt'), WORKER)
      writeFileSync(join(dir, 'big.txt'), workerBig)
    })
    writeFileSync(join(repo, 'a.txt'), CALLER)

    const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
    assert.equal(applied.applied, true)
    assert.equal(readFileSync(join(repo, 'big.txt')).length, Buffer.byteLength(workerBig))
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), BOTH)
    isolation.close()
  },
)

// ── A: nested repositories ───────────────────────────────────────────────────

/** A nested repository with one commit, which the top repository does not track. */
function makeNestedRepo(repo, path, files) {
  const dir = join(repo, path)
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  writeFiles(dir, files)
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', [...GIT_ID, 'commit', '-q', '-m', 'nested init'], { cwd: dir })
  return dir
}

for (const [what, remove] of [
  ['removes a nested repository', (dir) => rmSync(join(dir, 'vendored'), { recursive: true, force: true })],
  ['removes a nested repository’s .git', (dir) => rmSync(join(dir, 'vendored', '.git'), { recursive: true, force: true })],
]) {
  test(`review: a worker that ${what} still gets the rest of its change collected`, async () => {
    // The base staged `vendored/` as files whose blobs live in its own object store. At
    // collect that store is gone, so `nestedWorkTree` fails, `withNestedIndex` falls back to
    // the base's tree for the path, and `read-tree --prefix` of that tree fails too (its
    // objects were in the deleted store): the whole collect returns `available: false`, and
    // the worker's edit of top.txt is in no patch. 0.1.9 collected it.
    const repo = makeRepo({ 'top.txt': 'top\n' })
    makeNestedRepo(repo, 'vendored', { 'v.txt': 'v1\n' })
    const isolation = makePool(repo)
    const slot = await isolation.lease()
    isolation.prepare(slot)
    assert.deepEqual(slot.nested, ['vendored'])
    writeFileSync(join(slot.dir, 'top.txt'), 'top WORKER\n')
    remove(slot.dir)
    const change = isolation.collect(slot)
    try {
      assert.equal(change.available, true, change.reason)
      assert.ok(change.filesChanged.includes('M\ttop.txt'), JSON.stringify(change.filesChanged))
    } finally {
      isolation.release(slot)
      isolation.close()
    }
  })
}

// ── C: the repeated-failure warning ──────────────────────────────────────────

/** A runtime stand-in that replays one child run with the given shell results. */
class FakeSdkClient {
  constructor(toolEvents, { delayMs = 0 } = {}) {
    this.pid = 4243
    this.running = false
    this.toolEvents = toolEvents
    this.delayMs = delayMs
    this.handlers = new Set()
  }

  start() {
    this.running = true
    return this.pid
  }

  async initialize() {
    return { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' }
  }

  async prompt({ sessionId }) {
    if (this.delayMs > 0) setTimeout(() => this.#replay(sessionId), this.delayMs)
    else queueMicrotask(() => this.#replay(sessionId))
    return { messageId: 'msg-1' }
  }

  onNotification(handler) {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  onExit() {
    return () => {}
  }

  async shutdown() {
    this.running = false
  }

  #emit(method, params) {
    for (const handler of this.handlers) handler(method, params)
  }

  #replay(sessionId) {
    const child = `child-${sessionId}`
    this.#emit('session.status', { sessionId, status: 'running' })
    this.#emit('subagent.started', { parentSessionId: sessionId, childSessionId: child })
    for (const [index, entry] of this.toolEvents.entries()) {
      const id = `call-${String(index)}`
      const data = { turn: 1, step: 1, id }
      this.#emit('session.event', {
        sessionId: child,
        event: { type: 'tool/call', data: { ...data, name: 'bash', arguments: JSON.stringify({ command: entry.command }) } },
      })
      this.#emit('session.event', {
        sessionId: child,
        event: {
          type: 'tool/result',
          data: { ...data, message: { content: [{ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text: entry.text }] }] } },
        },
      })
    }
    this.#emit('subagent.finished', {
      provider: 'flash',
      agentId: 'agent-0',
      parentSessionId: sessionId,
      childSessionId: child,
      status: 'ok',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'worker result' }],
    })
    this.#emit('session.status', { sessionId, status: 'idle' })
  }
}

/** A service running in place on a fresh root, whose one child replays `toolEvents`. */
function makeReplayService(toolEvents) {
  const root = tempDir('flash-review-svc-')
  const client = new FakeSdkClient(toolEvents)
  const service = new FlashTaskService({
    root,
    clientFactory: () => client,
    log: () => {},
    isolate: { mode: 'none' },
    honoursModelEnv: () => true,
    earlyRetryDelayMs: 0,
    env: { DSH_HOME: join(root, 'no-harness-home') },
  })
  return { root, service, call: createToolCaller({ service, jobs: new JobRegistry() }) }
}

test('review: a different command that shares the failing one’s two-word key does not read as its later success', async () => {
  // `npm run build` fails three times and is never fixed; `npm run lint` then passes. Both
  // fold to the key "npm run" (as do `uv run …`, `python -m …`, `node --test …`), so
  // `countSuccess` marks the stuck build as having "succeeded" and the warning drops its
  // advice to check the report or cancel.
  const { root, service, call } = makeReplayService([
    { command: 'npm run build', text: 'error TS2304\n[exit code: 2]' },
    { command: 'npm run build', text: 'error TS2304\n[exit code: 2]' },
    { command: 'npm run build', text: 'error TS2304\n[exit code: 2]' },
    { command: 'npm run lint', text: 'clean\n[exit code: 0]' },
  ])
  try {
    const result = (await call('flash_task', { task: 'build it', cwd: root })).structuredContent
    const warning = (result.warnings ?? []).find((line) => line.startsWith('"npm run" failed 3 times'))
    assert.ok(warning, JSON.stringify(result.warnings))
    assert.doesNotMatch(warning, /a later run succeeded/, 'the build never succeeded')
    assert.match(warning, /check its report or cancel the call$/)
  } finally {
    await service.close()
  }
})

test('review: a search with an alternation in its pattern that finds nothing is not a failure', async () => {
  // `exitOneIsAnAnswer` splits the command on every `|` to find the last pipeline stage, so
  // the `|` inside the quoted pattern makes the "program" `barName"` and the three empty
  // searches are warned about as a step the sandbox cannot finish.
  const { root, service, call } = makeReplayService(
    Array.from({ length: 3 }, () => ({ command: 'rg -n "fooName|barName" src', text: '[exit code: 1]' })),
  )
  try {
    const result = (await call('flash_task', { task: 'look for two names', cwd: root })).structuredContent
    assert.equal(result.warnings, undefined, JSON.stringify(result.warnings))
  } finally {
    await service.close()
  }
})

// ── C: where a queued call stands ────────────────────────────────────────────

test('review: flash_status does not report a queue for a job that already holds its tree', async () => {
  // `#project` reads `queue` from the last heartbeat's detail, which is only refreshed every
  // `progressIntervalMs` (20 s by default). A job that leased its tree since then is still
  // shown "1st in line" with the previous holder, for up to one interval.
  const root = tempDir('flash-review-queue-')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  writeFileSync(join(root, 'README.md'), '# project\n')
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', [...GIT_ID, 'commit', '-q', '-m', 'init'], { cwd: root })
  const client = new FakeSdkClient([], { delayMs: 2500 })
  const service = new FlashTaskService({
    root,
    clientFactory: () => client,
    log: () => {},
    isolate: { slots: 1, stateDir: tempDir('flash-review-queue-state-') },
    honoursModelEnv: () => true,
    earlyRetryDelayMs: 0,
    progressIntervalMs: 1000,
    env: { DSH_HOME: join(root, 'no-harness-home') },
  })
  const call = createToolCaller({ service, jobs: new JobRegistry() })
  const waitFor = async (predicate, label) => {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.fail(`timed out waiting for ${label}`)
  }
  try {
    const holder = (await call('flash_task', { task: 'hold the tree', cwd: root, background: true })).structuredContent
    await waitFor(() => service.isolation.inUse === 1, 'the holder to lease')
    const second = (await call('flash_task', { task: 'wait for it', cwd: root, background: true })).structuredContent
    await waitFor(async () => (await call('flash_status', { jobId: second.jobId })).structuredContent.queue !== undefined, 'a queued heartbeat')
    await call('flash_result', { jobId: holder.jobId, waitSeconds: 20 })
    await waitFor(() => [...service.treeHolders.values()].some((entry) => entry.jobId === second.jobId), 'the second job to hold the tree')

    const status = (await call('flash_status', { jobId: second.jobId })).structuredContent
    assert.equal(status.state, 'running')
    assert.equal(status.queue, undefined, `a job holding the tree is not in line: ${JSON.stringify(status.queue)}`)
    await call('flash_result', { jobId: second.jobId, waitSeconds: 20 })
  } finally {
    await service.close()
  }
})
