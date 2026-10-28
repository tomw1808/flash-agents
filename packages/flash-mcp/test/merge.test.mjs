/**
 * Three-way apply and copy-state tests: a failed merge says exactly what it wrote, a merged
 * file keeps the line endings the caller's file has, a base patch the copy already holds is
 * not applied twice, and a worker's edits inside a nested repository reach the patch.
 *
 * These run against a real `git` and real temporary trees, because what is under test —
 * which bytes git hands back, what its diff can see — is git's, not a stub's. Every tree,
 * state directory and data directory is made here and removed when the file finishes.
 */

import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { WorkspaceIsolation, rootDigest } from '../lib/isolation.js'
import { FlashTaskService } from '../lib/service.js'

const GIT_ID = ['-c', 'user.email=t@t', '-c', 'user.name=t']

/** Every directory this file made, removed once it finishes. */
const madeDirs = []

/** A fresh temporary directory, realpath'd so macOS `/var` vs `/private/var` cannot bite. */
function tempDir(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  madeDirs.push(dir)
  return dir
}

// Default-layout pools store patches in the durable data directory; keep every one in this
// file out of the real one.
process.env.FLASH_DATA_DIR = tempDir('flash-merge-data-')

after(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true })
})

/** Run git in a directory and return its standard output. */
function gitOut(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
}

/** Stage everything and commit it, as another session touching the root would. */
function commit(dir, message) {
  // A nested repository is committed as a gitlink on purpose here; git's hint about it is noise.
  execFileSync('git', ['-c', 'advice.addEmbeddedRepo=false', 'add', '-A'], { cwd: dir })
  execFileSync('git', [...GIT_ID, 'commit', '-q', '-m', message], { cwd: dir })
}

/** Write files (string or Buffer content) under a directory, creating their parents. */
function writeFiles(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
}

/** A throwaway git repository holding `files`, committed once. */
function makeRepo(files) {
  const dir = tempDir('flash-merge-')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  writeFiles(dir, files)
  commit(dir, 'init')
  return dir
}

/** One isolation pool over a repository, with its own state directory. */
function makePool(repo) {
  return new WorkspaceIsolation({ root: repo, slots: 1, stateDir: tempDir('flash-merge-state-') })
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

/** The plain path of every entry `collect` reported: `STATUS<TAB>path` becomes `path`. */
function plainNames(change) {
  return change.filesChanged.map((line) => line.split('\t').at(-1)).sort()
}

/** One patch record as it sits on disk. */
function readRecord(isolation, patchId) {
  return JSON.parse(readFileSync(join(isolation.patchDir, `${patchId}.json`), 'utf8'))
}

/**
 * Run `fn` with git configuration set through the environment, as a system or global
 * config would set it: the merge's scratch repository reads no repository's config, so
 * this is how a Windows install's `core.autocrlf=true` reaches it. Restored afterwards.
 */
function withGitConfig(pairs, fn) {
  const names = ['GIT_CONFIG_COUNT', ...Object.keys(pairs).flatMap((_, at) => [`GIT_CONFIG_KEY_${String(at)}`, `GIT_CONFIG_VALUE_${String(at)}`])]
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  process.env.GIT_CONFIG_COUNT = String(Object.keys(pairs).length)
  Object.entries(pairs).forEach(([key, value], at) => {
    process.env[`GIT_CONFIG_KEY_${String(at)}`] = key
    process.env[`GIT_CONFIG_VALUE_${String(at)}`] = value
  })
  try {
    return fn()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

/** A file long enough that a worker hunk and a caller edit two lines away do not share a line. */
const TWELVE_LINES = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\n'
/** TWELVE_LINES with the worker's line 2. */
const WORKER = TWELVE_LINES.replace('l2\n', 'l2 WORKER\n')
/** TWELVE_LINES with the caller's line 4. */
const CALLER = TWELVE_LINES.replace('l4\n', 'l4 CALLER\n')
/** Both edits: what a clean merge of the two writes. */
const BOTH = WORKER.replace('l4\n', 'l4 CALLER\n')

/** The same text with CRLF line breaks. */
function crlf(text) {
  return text.replace(/\n/g, '\r\n')
}

// ── a failed three-way apply writes nothing, or says what it wrote ───────────

test('a three-way apply writes a merged file larger than 1 MiB', async () => {
  // The reported failure: `git cat-file --filters` of a big merged blob ran out of the
  // default 1 MiB output buffer, and the files before it had already been written.
  const lines = Array.from({ length: 40_000 }, (_, at) => `line ${String(at)} ${'x'.repeat(30)}\n`)
  const repo = makeRepo({ 'a.txt': TWELVE_LINES, 'big.txt': lines.join('') })
  const isolation = makePool(repo)
  const worker = [...lines]
  worker[1] = 'line 1 WORKER\n'
  const change = await finishedChange(isolation, (dir) => {
    writeFileSync(join(dir, 'a.txt'), WORKER)
    writeFileSync(join(dir, 'big.txt'), worker.join(''))
  })
  const caller = [...lines]
  caller[3] = 'line 3 CALLER\n'
  writeFileSync(join(repo, 'big.txt'), caller.join(''))

  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.applied, true)
  assert.deepEqual(applied.conflicts, [])
  const merged = [...worker]
  merged[3] = 'line 3 CALLER\n'
  assert.ok(merged.join('').length > 1024 * 1024)
  assert.equal(readFileSync(join(repo, 'big.txt'), 'utf8'), merged.join(''))
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), WORKER)
  isolation.close()
})

test('a merged file git cannot read is refused before anything is written', async () => {
  const repo = makeRepo({ 'a.txt': TWELVE_LINES, 'f.txt': TWELVE_LINES })
  const isolation = makePool(repo)
  const change = await finishedChange(isolation, (dir) => {
    writeFileSync(join(dir, 'a.txt'), WORKER)
    writeFileSync(join(dir, 'f.txt'), WORKER)
    writeFileSync(join(dir, 'z-new.txt'), 'new from the worker\n')
  })
  // The caller's line 4 makes the plain apply fail, so the merge writes all three files.
  writeFileSync(join(repo, 'f.txt'), CALLER)
  // A filter that must run and cannot, for the last path only: its content cannot be read
  // after the first two paths' content already has been.
  const attributes = join(tempDir('flash-merge-attrs-'), 'attributes')
  writeFileSync(attributes, 'z-new.txt filter=broken\n')

  assert.throws(
    () =>
      withGitConfig({ 'core.attributesFile': attributes, 'filter.broken.smudge': 'false', 'filter.broken.required': 'true' }, () =>
        isolation.apply({ patchId: change.patchId, threeWay: true }),
      ),
    (error) => /could not read the merged content of z-new\.txt/.test(error.message) && /nothing was written to /.test(error.message),
  )
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), TWELVE_LINES, 'an earlier file was not written')
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), CALLER)
  assert.equal(existsSync(join(repo, 'z-new.txt')), false)
  assert.equal(readRecord(isolation, change.patchId).appliedAt, null)
  isolation.close()
})

test(
  'a write that fails part-way names every path already written',
  { skip: process.getuid?.() === 0 ? 'root writes through a read-only directory' : false },
  async () => {
    const repo = makeRepo({ 'a.txt': TWELVE_LINES, 'f.txt': TWELVE_LINES, 'sub/b.txt': TWELVE_LINES })
    const isolation = makePool(repo)
    const change = await finishedChange(isolation, (dir) => {
      writeFileSync(join(dir, 'a.txt'), WORKER)
      writeFileSync(join(dir, 'f.txt'), WORKER)
      writeFileSync(join(dir, 'sub', 'b.txt'), WORKER)
    })
    writeFileSync(join(repo, 'f.txt'), CALLER)
    // The last file sits in a directory the write cannot change.
    chmodSync(join(repo, 'sub'), 0o555)
    try {
      assert.throws(
        () => isolation.apply({ patchId: change.patchId, threeWay: true }),
        (error) =>
          /failed while writing sub\/b\.txt/.test(error.message) &&
          /deleted nothing and written a\.txt, f\.txt/.test(error.message) &&
          /the rest of the merge was not written/.test(error.message),
      )
    } finally {
      chmodSync(join(repo, 'sub'), 0o755)
    }
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), WORKER)
    assert.equal(readFileSync(join(repo, 'sub', 'b.txt'), 'utf8'), TWELVE_LINES)
    isolation.close()
  },
)

// ── a three-way apply keeps each file's line endings ─────────────────────────

test('core.autocrlf=true with an LF checkout gets its merged file back as LF', async () => {
  const repo = makeRepo({ 'a.txt': TWELVE_LINES })
  gitOut(repo, 'config', 'core.autocrlf', 'true')
  const isolation = makePool(repo)
  const change = await finishedChange(isolation, (dir) => writeFileSync(join(dir, 'a.txt'), WORKER))
  writeFileSync(join(repo, 'a.txt'), CALLER)

  const applied = withGitConfig({ 'core.autocrlf': 'true' }, () => isolation.apply({ patchId: change.patchId, threeWay: true }))
  assert.equal(applied.threeWay, true)
  assert.deepEqual(applied.conflicts, [])
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), BOTH, 'LF stays LF')
  isolation.close()
})

test('core.autocrlf=true with a CRLF checkout keeps CRLF, and a new file follows the config', async () => {
  const repo = makeRepo({ 'a.txt': TWELVE_LINES })
  gitOut(repo, 'config', 'core.autocrlf', 'true')
  // The checkout a Windows clone with autocrlf has: CRLF on disk, LF in the repository.
  writeFileSync(join(repo, 'a.txt'), crlf(TWELVE_LINES))
  // Re-staged so the index's stat data matches the CRLF file; its content is unchanged.
  execFileSync('git', ['add', 'a.txt'], { cwd: repo })
  assert.equal(gitOut(repo, 'status', '--porcelain'), '')
  const isolation = makePool(repo)
  const change = await finishedChange(isolation, (dir) => {
    writeFileSync(join(dir, 'a.txt'), crlf(WORKER))
    writeFileSync(join(dir, 'n.txt'), 'new\nfile\n')
  })
  writeFileSync(join(repo, 'a.txt'), crlf(CALLER))

  const applied = withGitConfig({ 'core.autocrlf': 'true' }, () => isolation.apply({ patchId: change.patchId, threeWay: true }))
  assert.equal(applied.threeWay, true)
  assert.deepEqual(applied.conflicts, [])
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), crlf(BOTH), 'CRLF stays CRLF')
  // A new file has no style of its own to keep, so git's conversion decides, as before.
  assert.equal(readFileSync(join(repo, 'n.txt'), 'utf8'), 'new\r\nfile\r\n')
  isolation.close()
})

test('binary content and a -text path are written as the raw blob', async () => {
  const binary = Buffer.from([0x00, 0x01, 0x0d, 0x0a, 0x02, 0x0a])
  const repo = makeRepo({ 'a.txt': TWELVE_LINES, '.gitattributes': 'raw.txt -text\n', 'raw.txt': 'r1\nr2\n', 'data.bin': binary })
  gitOut(repo, 'config', 'core.autocrlf', 'true')
  const isolation = makePool(repo)
  const workerBinary = Buffer.from([0x00, 0x01, 0x0a, 0x03, 0x0d, 0x0a, 0x0a])
  const change = await finishedChange(isolation, (dir) => {
    writeFileSync(join(dir, 'a.txt'), WORKER)
    writeFileSync(join(dir, 'raw.txt'), 'r1 WORKER\nr2\n')
    writeFileSync(join(dir, 'data.bin'), workerBinary)
  })
  writeFileSync(join(repo, 'a.txt'), CALLER)

  const applied = withGitConfig({ 'core.autocrlf': 'true' }, () => isolation.apply({ patchId: change.patchId, threeWay: true }))
  assert.equal(applied.threeWay, true)
  assert.deepEqual(applied.conflicts, [])
  assert.equal(readFileSync(join(repo, 'raw.txt'), 'utf8'), 'r1 WORKER\nr2\n', 'a -text path is never converted')
  assert.deepEqual(readFileSync(join(repo, 'data.bin')), workerBinary, 'binary bytes are written exactly')
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), BOTH)
  isolation.close()
})

// ── a base patch already in the copy's starting tree ─────────────────────────

test('a base patch the caller already applied is not applied again in the copy', async () => {
  const repo = makeRepo({ 'a.txt': TWELVE_LINES })
  const isolation = makePool(repo)
  const first = await finishedChange(isolation, (dir) => {
    writeFileSync(join(dir, 'a.txt'), WORKER)
    writeFileSync(join(dir, 'b.txt'), 'made by A\n')
  })
  // The caller applied it and has not committed it: the copy takes it with the tree.
  isolation.apply({ patchId: first.patchId })

  const slot = await isolation.lease()
  isolation.prepare(slot)
  const base = isolation.applyBasePatch(slot, first.patchId)
  assert.equal(base.applied, false)
  assert.equal(base.alreadyInTree, true)
  assert.deepEqual(base.conflicts, [])
  assert.equal(
    base.warning,
    `basePatch ${first.patchId} was already in the tree the copy was taken from, so it was not applied again; this call's patch does not contain it`,
  )
  assert.equal(readFileSync(join(slot.dir, 'a.txt'), 'utf8'), WORKER, 'the copy holds the change once')
  writeFileSync(join(slot.dir, 'c.txt'), 'made by B\n')
  const change = isolation.collect(slot)
  // The base was the caller's tree, which already had the base patch: only the new work is new.
  assert.deepEqual(plainNames(change), ['c.txt'])
  isolation.discard(slot)
  isolation.release(slot)
  isolation.close()
})

test('a base patch only partly in the tree is still merged into the copy', async () => {
  const repo = makeRepo({ 'a.txt': TWELVE_LINES })
  const isolation = makePool(repo)
  const first = await finishedChange(isolation, (dir) => {
    writeFileSync(join(dir, 'a.txt'), WORKER)
    writeFileSync(join(dir, 'b.txt'), 'made by A\n')
  })
  isolation.apply({ patchId: first.patchId, files: ['b.txt'] })

  const slot = await isolation.lease()
  isolation.prepare(slot)
  const base = isolation.applyBasePatch(slot, first.patchId)
  assert.equal(base.applied, true)
  assert.equal(base.alreadyInTree, undefined)
  assert.equal(base.warning, undefined)
  assert.equal(readFileSync(join(slot.dir, 'a.txt'), 'utf8'), WORKER)
  isolation.discard(slot)
  isolation.release(slot)
  isolation.close()
})

/**
 * A runtime stand-in that replays one successful child per prompt, writing the files a
 * test asked for into whatever tree it was given.
 */
class FakeSdkClient {
  constructor(writes = {}, prompts = []) {
    this.writes = writes
    /** Every prompt text the service sent, shared with the test that made the service. */
    this.prompts = prompts
    this.pid = 4242
    this.running = false
    this.cwd = undefined
    this.diagnostics = ''
    this.notificationHandlers = new Set()
    this.exitHandlers = new Set()
  }

  start() {
    this.running = true
    return this.pid
  }

  async initialize(params) {
    this.cwd = params.cwd
    return { name: 'fake-runtime', version: '0' }
  }

  async prompt({ sessionId, text }) {
    this.prompts.push(text)
    queueMicrotask(() => this.#replay(sessionId))
    return { messageId: 'msg-1' }
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

  #replay(sessionId) {
    if (this.cwd !== undefined) writeFiles(this.cwd, this.writes)
    const childId = `child-${sessionId}`
    this.emit('session.status', { sessionId, status: 'running' })
    this.emit('subagent.started', { parentSessionId: sessionId, childSessionId: childId })
    this.emit('session.event', {
      sessionId: childId,
      event: { type: 'request/header', data: { header: { config: { provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' } } } },
    })
    this.emit('subagent.finished', {
      provider: 'flash',
      agentId: 'agent-0',
      parentSessionId: sessionId,
      childSessionId: childId,
      status: 'ok',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'worker result' }],
    })
    this.emit('session.status', { sessionId, status: 'idle' })
  }
}

/** A service over a root with a fake runtime; its home and DSH_HOME are empty temp dirs. */
function makeService(root, stateDir, writes, prompts = []) {
  return new FlashTaskService({
    root,
    clientFactory: () => new FakeSdkClient(writes, prompts),
    log: () => {},
    env: { DSH_HOME: tempDir('flash-merge-dsh-') },
    home: tempDir('flash-merge-home-'),
    isolate: { slots: 1, stateDir },
  })
}

test('flash_task says a base patch already in the tree was skipped and is not in its patch', async () => {
  const repo = makeRepo({ 'a.txt': 'a1\na2\na3\n' })
  const stateDir = tempDir('flash-merge-svc-')
  const first = makeService(repo, stateDir, { 'a.txt': 'a1 FROM A\na2\na3\n', 'b.txt': 'made by A\n' })
  const done = await first.flashTask({ task: 'first half', cwd: repo })
  first.isolation.apply({ patchId: done.change.patchId })
  await first.close()

  const prompts = []
  const second = makeService(repo, stateDir, { 'c.txt': 'made by B\n' }, prompts)
  const result = await second.flashTask({ task: 'the rest', cwd: repo, basePatch: done.change.patchId })
  // The worker is told where the change came from, not that it was applied for it.
  const prompt = prompts.find((text) => text.includes(done.change.patchId))
  assert.ok(prompt.includes(`(patch ${done.change.patchId}) to a.txt, b.txt: it was already in the tree the copy was taken from, so it was not applied again.`))
  assert.ok(!prompt.includes('applied before you started'))
  assert.equal(result.basePatch.patchId, done.change.patchId)
  assert.equal(result.basePatch.applied, false)
  assert.equal(result.basePatch.alreadyInTree, true)
  assert.match(result.basePatch.note, /holds only the new work/)
  assert.ok(
    (result.warnings ?? []).includes(
      `basePatch ${done.change.patchId} was already in the tree the copy was taken from, so it was not applied again; this call's patch does not contain it`,
    ),
  )
  assert.deepEqual([...result.change.filesChanged], ['c.txt'])
  await second.close()
})

// ── a nested repository's changes reach the patch ────────────────────────────

/** A nested repository at `path` inside `repo`, with `files` committed in it. */
function makeNestedRepo(repo, path, files) {
  const dir = join(repo, path)
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  writeFiles(dir, files)
  commit(dir, 'nested init')
  return dir
}

test('a whole-root patch carries edits inside nested repositories, and apply lands them', async () => {
  const repo = makeRepo({ 'top.txt': 'top\n', '.gitignore': 'ws/\n' })
  // One nested repository the top does not know about, and one whose own directory it ignores:
  // the workspace-of-repositories layout.
  const inner = makeNestedRepo(repo, 'inner', { 'n.txt': TWELVE_LINES, 'keep.txt': 'keep\n' })
  const listed = makeNestedRepo(repo, 'ws', { 'x.txt': 'x1\n' })
  // The caller's own work in progress in the nested repository is not the worker's.
  writeFileSync(join(inner, 'wip.txt'), 'caller wip\n')
  const innerIndex = readFileSync(join(inner, '.git', 'index'))
  const isolation = makePool(repo)

  const change = await finishedChange(isolation, (dir) => {
    writeFileSync(join(dir, 'top.txt'), 'top WORKER\n')
    writeFileSync(join(dir, 'inner', 'n.txt'), WORKER)
    writeFileSync(join(dir, 'inner', 'new.txt'), 'new in inner\n')
    writeFileSync(join(dir, 'ws', 'x.txt'), 'x1 WORKER\n')
  })
  assert.equal(change.available, true)
  assert.deepEqual(plainNames(change), ['inner/n.txt', 'inner/new.txt', 'top.txt', 'ws/x.txt'])

  const applied = isolation.apply({ patchId: change.patchId })
  assert.equal(applied.applied, true)
  assert.equal(readFileSync(join(repo, 'top.txt'), 'utf8'), 'top WORKER\n')
  assert.equal(readFileSync(join(inner, 'n.txt'), 'utf8'), WORKER)
  assert.equal(readFileSync(join(inner, 'new.txt'), 'utf8'), 'new in inner\n')
  assert.equal(readFileSync(join(listed, 'x.txt'), 'utf8'), 'x1 WORKER\n')
  assert.equal(readFileSync(join(inner, 'wip.txt'), 'utf8'), 'caller wip\n')
  // Only the nested working tree moved: its index is byte for byte what the caller had.
  assert.deepEqual(readFileSync(join(inner, '.git', 'index')), innerIndex)
  assert.equal(gitOut(inner, 'diff', '--cached', '--name-only'), '')
  assert.equal(gitOut(inner, 'log', '--format=%s'), 'nested init\n')
  isolation.close()
})

test('a three-way apply merges a nested repository file the worker committed in its copy', async () => {
  const repo = makeRepo({ 'top.txt': 'top\n' })
  const inner = makeNestedRepo(repo, 'inner', { 'n.txt': TWELVE_LINES })
  const isolation = makePool(repo)
  const change = await finishedChange(isolation, (dir) => {
    writeFileSync(join(dir, 'inner', 'n.txt'), WORKER)
    // A commit inside the copy's nested repository moves only the copy's history.
    commit(join(dir, 'inner'), 'worker commit')
  })
  assert.deepEqual(plainNames(change), ['inner/n.txt'])
  writeFileSync(join(inner, 'n.txt'), CALLER)

  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.threeWay, true)
  assert.deepEqual(applied.conflicts, [])
  assert.equal(readFileSync(join(inner, 'n.txt'), 'utf8'), BOTH)
  assert.equal(gitOut(inner, 'log', '--format=%s'), 'nested init\n')
  isolation.close()
})

test('a crashed server’s edits inside a nested repository are salvaged with its tree', async () => {
  // The top ignores the nested repository, so its own status is clean: only the staged
  // nested files can tell the salvage there is work to keep.
  const repo = makeRepo({ 'top.txt': 'top\n', '.gitignore': 'lib/\n' })
  const listed = makeNestedRepo(repo, 'lib', { 'x.txt': 'x1\n' })
  const base = tempDir('flash-merge-base-')
  const anchor = new WorkspaceIsolation({ root: repo, slots: 1, baseDir: base, sweepIntervalMs: 0 })
  const slot = await anchor.lease()
  anchor.prepare(slot)
  writeFileSync(join(slot.dir, 'lib', 'x.txt'), 'x1 FROM THE DEAD WORKER\n')
  anchor.release(slot)
  // The live pid level moved under a dead pid is what a crashed server leaves behind.
  renameSync(dirname(anchor.stateDir), join(base, rootDigest(repo), '4194303'))
  anchor.close()

  const next = new WorkspaceIsolation({ root: repo, slots: 1, baseDir: base, sweepIntervalMs: 0 })
  try {
    const record = next.listPatches().find((entry) => entry.salvagedFrom !== undefined)
    assert.ok(record, 'the dead tree was salvaged')
    assert.deepEqual(record.filesChanged.map((line) => line.split('\t').at(-1)), ['lib/x.txt'])
    next.apply({ patchId: record.patchId })
    assert.equal(readFileSync(join(listed, 'x.txt'), 'utf8'), 'x1 FROM THE DEAD WORKER\n')
  } finally {
    next.close()
  }
})

test('a nested repository under an ignored build or dependency directory is left as before', async () => {
  const repo = makeRepo({ 'top.txt': 'top\n', '.gitignore': 'vendor/\n.build/\nnode_modules/\n' })
  const paths = ['vendor/x', '.build/checkouts/x', 'node_modules/x']
  for (const path of paths) makeNestedRepo(repo, path, { 'x.txt': 'x1\n' })
  const isolation = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot)
  assert.deepEqual(slot.nested, [], 'none of them is staged')
  writeFileSync(join(slot.dir, 'top.txt'), 'top WORKER\n')
  for (const path of paths) {
    if (existsSync(join(slot.dir, path))) writeFileSync(join(slot.dir, path, 'x.txt'), 'x1 WORKER\n')
  }
  const change = isolation.collect(slot)
  assert.deepEqual(plainNames(change), ['top.txt'])
  isolation.discard(slot)
  isolation.release(slot)
  isolation.close()
})

test('a nested repository that cannot be read at collect is named, and the rest of the change is kept', async () => {
  const repo = makeRepo({ 'top.txt': 'top\n' })
  const inner = makeNestedRepo(repo, 'inner', { 'n.txt': TWELVE_LINES })
  makeNestedRepo(repo, 'other', { 'o.txt': 'o1\n' })
  const stateDir = tempDir('flash-merge-svc-')
  // The worker edits both nested repositories and corrupts one's index, so staging it fails.
  const service = makeService(repo, stateDir, {
    'top.txt': 'top WORKER\n',
    'inner/n.txt': WORKER,
    'inner/.git/index': 'not an index\n',
    'other/o.txt': 'o1 WORKER\n',
  })
  const result = await service.flashTask({ task: 'edit', cwd: repo })
  assert.equal(result.change.available, true)
  // The unreadable repository is neither carried nor read as deleted.
  assert.deepEqual([...result.change.filesChanged].sort(), ['other/o.txt', 'top.txt'])
  const warning = (result.warnings ?? []).find((line) => line.startsWith('the changes inside nested repository inner could not be read ('))
  assert.ok(warning, 'the result names the repository')
  assert.match(warning, /and are not in this patch; the copy keeps them at .* until the next call in this slot, or the server's exit, empties it$/)
  // The copy is kept, so the edits are still on disk where the warning says.
  const kept = /keeps them at (.*) until the next call/.exec(warning)[1]
  assert.equal(readFileSync(join(kept, 'n.txt'), 'utf8'), WORKER)
  assert.equal(readFileSync(join(inner, 'n.txt'), 'utf8'), TWELVE_LINES)
  await service.close()
})

test('a nested repository the top tracks as a gitlink keeps its pointer, with no file diff', async () => {
  const repo = makeRepo({ 'top.txt': 'top\n' })
  makeNestedRepo(repo, 'sub', { 'inner.txt': 'inner\n' })
  commit(repo, 'add sub as a gitlink')
  const isolation = makePool(repo)
  const change = await finishedChange(isolation, (dir) => writeFileSync(join(dir, 'top.txt'), 'top WORKER\n'))
  assert.deepEqual(plainNames(change), ['top.txt'])
  isolation.close()
})
