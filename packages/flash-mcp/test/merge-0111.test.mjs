/**
 * 0.1.11 three-way apply tests: `threeWay` applies what git can apply, says what became of
 * every file, and never reports success with conflict markers left in. A base that the saved
 * blobs lack is looked up in the caller's repository, by the id the patch itself names; a
 * file whose base is nowhere stops the write and is named, with the files that can go in.
 *
 * These run against a real `git` and real temporary trees. Every tree, state directory and
 * data directory is made here and removed when the file finishes; nothing touches a real
 * home, `DSH_HOME`, the temp state base or the data directory.
 */

import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { WorkspaceIsolation } from '../lib/isolation.js'
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
process.env.FLASH_DATA_DIR = tempDir('flash-merge0111-data-')

after(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true })
})

/** Run git in a directory and return its standard output. */
function gitOut(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
}

/** Stage everything and commit it, as another session touching the root would. */
function commit(dir, message) {
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', [...GIT_ID, 'commit', '-q', '-m', message], { cwd: dir })
}

/** Write files (string content) under a directory, creating their parents. */
function writeFiles(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
}

/** A throwaway git repository holding `files`, committed once. */
function makeRepo(files) {
  const dir = tempDir('flash-merge0111-')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  writeFiles(dir, files)
  commit(dir, 'init')
  return dir
}

/** One isolation pool over a repository, with its own state directory. */
function makePool(repo) {
  return new WorkspaceIsolation({ root: repo, slots: 1, stateDir: tempDir('flash-merge0111-state-') })
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

/** One patch record as it sits on disk. */
function readRecord(isolation, patchId) {
  return JSON.parse(readFileSync(join(isolation.patchDir, `${patchId}.json`), 'utf8'))
}

/** The twelve lines of a module, numbered so an edit on one line leaves the others' context alone. */
function moduleLines(name) {
  return Array.from({ length: 12 }, (_, at) => `export const ${name.replace(/\W/g, '_')}_${String(at + 1)} = ${String(at + 1)}\n`)
}

/** A module with one line replaced (1-based). */
function edited(name, line, text) {
  const lines = moduleLines(name)
  lines[line - 1] = `${text}\n`
  return lines.join('')
}

/** The same text with CRLF line breaks. */
function crlf(text) {
  return text.replace(/\n/g, '\r\n')
}

/** Ten modules, as a source tree of real size. */
const TEN = Array.from({ length: 10 }, (_, at) => `src/m${String(at)}.js`)

/** The ten modules, CRLF as a Windows-born checkout would hold them. */
function tenFiles(transform = (text) => text) {
  return Object.fromEntries(TEN.map((name) => [name, transform(moduleLines(name).join(''))]))
}

/** The caller moves on by `n` commits, each editing line 5 of every module in `names`. */
function callerMovesOn(repo, names, n, transform = (text) => text) {
  for (let commitNo = 1; commitNo <= n; commitNo += 1) {
    for (const name of names) writeFileSync(join(repo, name), transform(edited(name, 5, `// caller edit ${String(commitNo)}`)))
    commit(repo, `caller ${String(commitNo)}`)
  }
}

/** A statuses map from a result's `files`. */
function statusOf(result) {
  return Object.fromEntries(result.files.map((file) => [file.path, file.status]))
}

// ── 1. a base the copy could not hand over is still a base ───────────────────

test('a patch whose copy lacks one base blob keeps every base entry and merges from the caller’s repository', async () => {
  const repo = makeRepo(tenFiles(crlf))
  const isolation = makePool(repo)
  // The base blob of the file that will move: a pure rename needs only its id, so the copy
  // can diff it without the blob, and a copy that lost the object (a reference clone, a
  // pruned or lazily fetched object) cannot pack it. The caller's repository has it.
  const movedBlob = gitOut(repo, 'rev-parse', 'HEAD:src/m3.js').trim()
  const change = await finishedChange(isolation, (dir) => {
    for (const name of TEN) if (name !== 'src/m3.js') writeFileSync(join(dir, name), crlf(edited(name, 2, '// worker edit')))
    rmSync(join(dir, '.git', 'objects', movedBlob.slice(0, 2), movedBlob.slice(2)))
    renameSync(join(dir, 'src/m3.js'), join(dir, 'src/moved3.js'))
  })
  assert.equal(change.filesChanged.length, 10)
  // The record still names all ten bases: the patch is not "made before blob saving existed".
  assert.equal(readRecord(isolation, change.patchId).preimage.length, 10)
  callerMovesOn(repo, TEN, 3, crlf)

  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.applied, true)
  assert.equal(applied.threeWay, true)
  assert.deepEqual(applied.conflicts, [])
  assert.equal(applied.status, 'success')
  assert.equal(applied.files.length, 10)
  assert.ok(applied.files.every((file) => file.status === 'merged'), 'the caller moved every file, so each one is merged')
  const moved = readFileSync(join(repo, 'src/moved3.js'), 'utf8')
  assert.ok(moved.includes('// caller edit 3\r\n'), 'the caller’s edit follows the file to its new name, in CRLF')
  assert.equal(existsSync(join(repo, 'src/m3.js')), false)
  assert.ok(readFileSync(join(repo, 'src/m0.js'), 'utf8').includes('// worker edit\r\n'))
  isolation.close()
})

// ── 2. git's own answer before refusing ──────────────────────────────────────

test('a record with no saved base is merged from the blob ids the patch names, in the caller’s repository', async () => {
  const repo = makeRepo(tenFiles(crlf))
  const isolation = makePool(repo)
  const change = await finishedChange(isolation, (dir) => {
    for (const name of TEN) writeFileSync(join(dir, name), crlf(edited(name, 2, '// worker edit')))
  })
  // The record of a release that kept no base, or whose saving failed.
  delete isolation.patches.get(change.patchId).preimage
  rmSync(join(isolation.patchDir, `${change.patchId}.blobs`), { recursive: true, force: true })
  callerMovesOn(repo, TEN, 3, crlf)

  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.applied, true)
  assert.equal(applied.threeWay, true)
  assert.equal(applied.status, 'success')
  assert.deepEqual(Object.values(statusOf(applied)), Array(10).fill('merged'))
  const m7 = readFileSync(join(repo, 'src/m7.js'), 'utf8')
  assert.ok(m7.includes('// worker edit\r\n') && m7.includes('// caller edit 3\r\n'), 'both edits are there, in CRLF')
  assert.ok(!m7.replace(/\r\n/g, '').includes('\n'), 'every line break is still CRLF')
  assert.equal(gitOut(repo, 'diff', '--cached', '--name-only'), '', 'the caller’s index was not touched')
  isolation.close()
})

test('a record with no saved base also merges through flash_apply on the service', async () => {
  const repo = makeRepo(tenFiles())
  const service = makeService(repo, tempDir('flash-merge0111-svc-'), { 'src/m1.js': edited('src/m1.js', 2, '// worker edit') })
  const done = await service.flashTask({ task: 'edit one module', cwd: repo })
  delete service.isolation.patches.get(done.change.patchId).preimage
  rmSync(join(service.isolation.patchDir, `${done.change.patchId}.blobs`), { recursive: true, force: true })
  callerMovesOn(repo, ['src/m1.js'], 1)

  const applied = service.flashApply({ patchId: done.change.patchId, threeWay: true })
  assert.equal(applied.status, 'success')
  assert.deepEqual(applied.files, [{ path: 'src/m1.js', status: 'merged' }])
  await service.close()
})

// ── 3. a result per file; one that fails stops the write ─────────────────────

test('a moved file whose base is unknown fails, nothing is written, and the other nine are listed', async () => {
  const repo = makeRepo(tenFiles())
  const isolation = makePool(repo)
  const change = await finishedChange(isolation, (dir) => {
    for (const name of TEN) if (name !== 'src/m3.js') writeFileSync(join(dir, name), edited(name, 2, '// worker edit'))
    renameSync(join(dir, 'src/m3.js'), join(dir, 'src/moved3.js'))
  })
  delete isolation.patches.get(change.patchId).preimage
  callerMovesOn(repo, TEN, 2)
  const nine = TEN.filter((name) => name !== 'src/m3.js')
  const snapshot = Object.fromEntries(TEN.map((name) => [name, readFileSync(join(repo, name), 'utf8')]))

  const refused = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(refused.applied, false)
  assert.equal(refused.status, 'failed')
  const statuses = statusOf(refused)
  assert.equal(statuses['src/moved3.js'], 'failed')
  assert.equal(refused.files.find((file) => file.status === 'failed').reason, 'patch record has no saved base (made before 0.1.x)')
  assert.deepEqual(Object.values(statuses).filter((status) => status !== 'failed'), Array(9).fill('merged'))
  assert.deepEqual([...refused.appliable].sort(), [...nine].sort())
  assert.match(refused.note, /nothing was written: src\/moved3\.js/)
  assert.match(refused.note, /the other files can be applied with files: \[/)
  for (const name of TEN) assert.equal(readFileSync(join(repo, name), 'utf8'), snapshot[name], `${name} was not written`)
  assert.equal(readRecord(isolation, change.patchId).appliedAt, null)

  // The nine go in with `files`, exactly as the answer said.
  const partial = isolation.apply({ patchId: change.patchId, threeWay: true, files: refused.appliable })
  assert.equal(partial.applied, true)
  assert.equal(partial.status, 'success')
  assert.equal(partial.files.length, 9)
  assert.ok(readFileSync(join(repo, 'src/m9.js'), 'utf8').includes('// worker edit'))
  assert.equal(existsSync(join(repo, 'src/m3.js')), true, 'the moved file is still where it was')
  isolation.close()
})

test('a base that is in neither the saved blobs nor the repository names its blob id', async () => {
  const repo = makeRepo({ 'a.txt': moduleLines('a').join(''), 'b.txt': moduleLines('b').join('') })
  // b.txt is an uncommitted edit when the copy is made: its base blob exists only in the
  // copy, then only in the saved blobs, which the next lines remove.
  writeFileSync(join(repo, 'b.txt'), edited('b', 9, '// dirty'))
  const isolation = makePool(repo)
  const change = await finishedChange(isolation, (dir) => {
    writeFileSync(join(dir, 'a.txt'), edited('a', 2, '// worker edit'))
    writeFileSync(join(dir, 'b.txt'), edited('b', 2, '// worker edit').replace('export const b_9 = 9', '// dirty'))
  })
  rmSync(join(isolation.patchDir, `${change.patchId}.blobs`), { recursive: true, force: true })
  writeFileSync(join(repo, 'a.txt'), edited('a', 5, '// caller edit'))
  writeFileSync(join(repo, 'b.txt'), edited('b', 5, '// caller edit'))
  const dirtyBlob = readRecord(isolation, change.patchId).preimage.find((entry) => entry.path === 'b.txt').blob

  const result = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(result.status, 'failed')
  assert.equal(result.applied, false)
  assert.deepEqual(result.files, [
    { path: 'a.txt', status: 'merged' },
    { path: 'b.txt', status: 'failed', reason: `base blob ${dirtyBlob} is not in this repository` },
  ])
  assert.deepEqual(result.appliable, ['a.txt'])
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), edited('a', 5, '// caller edit'), 'nothing was written')
  isolation.close()
})

test('every file gets its status: applied, merged, conflict', async () => {
  const repo = makeRepo({ 'a.txt': moduleLines('a').join(''), 'b.txt': moduleLines('b').join(''), 'c.txt': moduleLines('c').join('') })
  const isolation = makePool(repo)
  const change = await finishedChange(isolation, (dir) => {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(dir, name), edited(name.slice(0, 1), 2, '// worker edit'))
  })
  // b.txt moves near the worker's hunk (the plain apply fails); c.txt on the same line.
  writeFileSync(join(repo, 'b.txt'), edited('b', 5, '// caller edit'))
  writeFileSync(join(repo, 'c.txt'), edited('c', 2, '// caller edit'))

  const result = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.deepEqual(statusOf(result), { 'a.txt': 'applied', 'b.txt': 'merged', 'c.txt': 'conflict' })
  assert.equal(result.status, 'conflict')
  assert.deepEqual(result.conflicts, ['c.txt'])
  assert.ok(readFileSync(join(repo, 'c.txt'), 'utf8').includes('<<<<<<<'), 'a real conflict is written, as git does')
  isolation.close()
})

test('a plain apply under threeWay lists every file as applied', async () => {
  const repo = makeRepo({ 'a.txt': moduleLines('a').join(''), 'b.txt': moduleLines('b').join('') })
  const isolation = makePool(repo)
  const change = await finishedChange(isolation, (dir) => writeFileSync(join(dir, 'a.txt'), edited('a', 2, '// worker edit')))

  const result = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(result.threeWay, false)
  assert.equal(result.status, 'success')
  assert.deepEqual(result.files, [{ path: 'a.txt', status: 'applied' }])
  isolation.close()
})

// ── 4. no silent markers ─────────────────────────────────────────────────────

/** A test module whose import lines hold the block a half-resolved merge leaves behind. */
const MARKED_IMPORTS =
  "<<<<<<< ours\nimport { render } from './render.js'\n=======\nimport { render } from './view/render.js'\n>>>>>>> theirs\n"
const PATCH_MARKERS_WARNING = 'WARNING: the patch itself adds conflict markers to'
const TEST_MODULE = (imports, tail = '') =>
  `${imports}import test from 'node:test'\n\ntest('renders', () => {\n  render()\n})\n${tail}`

test('a merge of a patch that adds markers warns loudly and keeps the status git reported', async () => {
  // The worker's copy held a base patch that conflicted; the markers in its import lines
  // went into its own patch as plain added lines, and git merged them without a conflict.
  const clean = TEST_MODULE("import { render } from './render.js'\n")
  const repo = makeRepo({ 'test/app.test.mjs': clean })
  const service = makeService(repo, tempDir('flash-merge0111-svc-'), { 'test/app.test.mjs': TEST_MODULE(MARKED_IMPORTS) })
  const done = await service.flashTask({ task: 'update the import', cwd: repo })
  // The caller drifted three lines below the worker's hunk, so the plain apply fails.
  writeFileSync(join(repo, 'test/app.test.mjs'), TEST_MODULE("import { render } from './render.js'\n").replace("test('renders'", "test('renders it'"))
  commit(repo, 'rename the test')

  const applied = service.flashApply({ patchId: done.change.patchId, threeWay: true })
  assert.equal(applied.threeWay, true)
  assert.equal(applied.status, 'success')
  assert.deepEqual(applied.files, [{ path: 'test/app.test.mjs', status: 'merged' }])
  assert.deepEqual(applied.conflicts, [])
  assert.ok(applied.warnings.some((warning) => warning.startsWith(PATCH_MARKERS_WARNING)), applied.warnings.join('\n'))
  assert.ok(readFileSync(join(repo, 'test/app.test.mjs'), 'utf8').includes('>>>>>>> theirs'))
  await service.close()
})

test('markers the patch adds are reported under threeWay on the plain path too', async () => {
  const repo = makeRepo({ 'test/app.test.mjs': TEST_MODULE("import { render } from './render.js'\n") })
  const isolation = makePool(repo)
  const change = await finishedChange(isolation, (dir) => writeFileSync(join(dir, 'test/app.test.mjs'), TEST_MODULE(MARKED_IMPORTS)))

  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.threeWay, false)
  assert.equal(applied.status, 'success')
  assert.deepEqual(applied.files, [{ path: 'test/app.test.mjs', status: 'applied' }])
  assert.deepEqual(applied.conflicts, [])
  assert.ok(applied.warnings.at(-1).startsWith(`${PATCH_MARKERS_WARNING} test/app.test.mjs;`), applied.warnings.at(-1))
  isolation.close()
})

test('a Markdown heading underline is not a conflict', async () => {
  const doc = 'Release notes\n=============\n\nfirst paragraph\n\nsecond paragraph\n\nthird paragraph\n\nfourth paragraph\n'
  const repo = makeRepo({ 'NOTES.md': doc })
  const isolation = makePool(repo)
  const change = await finishedChange(isolation, (dir) => writeFileSync(join(dir, 'NOTES.md'), doc.replace('first paragraph', 'first paragraph, revised')))
  writeFileSync(join(repo, 'NOTES.md'), doc.replace('second paragraph', 'second paragraph, by the caller'))

  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.status, 'success')
  assert.deepEqual(statusOf(applied), { 'NOTES.md': 'merged' })
  assert.ok(!(applied.warnings ?? []).some((warning) => warning.startsWith('WARNING')))
  isolation.close()
})

test('markers already in the caller’s version are not new ones', async () => {
  // A test fixture that holds a conflict block as data, in the caller's file before the apply.
  const fixture = `${TEST_MODULE("import { render } from './render.js'\n")}const sample = \`\n${MARKED_IMPORTS}\`\n`
  const repo = makeRepo({ 'test/fixture.test.mjs': fixture })
  const isolation = makePool(repo)
  const change = await finishedChange(isolation, (dir) =>
    writeFileSync(join(dir, 'test/fixture.test.mjs'), fixture.replace("test('renders'", "test('renders twice'")),
  )
  writeFileSync(join(repo, 'test/fixture.test.mjs'), fixture.replace("import { render } from './render.js'\nimport test", "import { render, other } from './render.js'\nimport test"))

  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.status, 'success')
  assert.deepEqual(statusOf(applied), { 'test/fixture.test.mjs': 'merged' })
  assert.ok(!(applied.warnings ?? []).some((warning) => warning.startsWith('WARNING')))
  assert.deepEqual(applied.conflicts, [])
  isolation.close()
})

function makeService(root, stateDir, writes) {
  return new FlashTaskService({
    root,
    clientFactory: () => new FakeSdkClient(writes),
    log: () => {},
    env: { DSH_HOME: tempDir('flash-merge0111-dsh-') },
    home: tempDir('flash-merge0111-home-'),
    isolate: { slots: 1, stateDir },
  })
}

/** A runtime stand-in that replays one successful child, writing the files a test asked for. */
class FakeSdkClient {
  constructor(writes = {}) {
    this.writes = writes
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

  async prompt({ sessionId }) {
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
