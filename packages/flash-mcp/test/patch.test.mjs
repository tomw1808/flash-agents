/**
 * Patch review and application tests: the clipped diff a result carries, `flash_patch`,
 * the index-free three-way fallback, and apply "discard".
 *
 * These run against a real `git` and real temporary trees, because the properties under
 * test — where a diff may be cut, whether a merge resolves without conflicts, whether an
 * index is touched — are git's, not a stub's.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { WorkspaceIsolation, prunePatches } from '../lib/isolation.js'
import { FlashTaskError, FlashTaskService } from '../lib/service.js'

const GIT_ID = ['-c', 'user.email=t@t', '-c', 'user.name=t']

const DAY_MS = 24 * 60 * 60 * 1000

/** Run git in a directory and return its standard output. */
function gitOut(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
}

/** A throwaway git repository, realpath'd so macOS `/var` vs `/private/var` cannot bite. */
function makeRepo(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-patch-')))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  commit(dir, 'init')
  return dir
}

/** Stage everything and commit it, as another session touching the root would. */
function commit(dir, message) {
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', [...GIT_ID, 'commit', '-q', '-m', message], { cwd: dir })
}

/** One isolation pool over a repository, plus a place for its state. */
function makePool(repo) {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-patch-state-')))
  const isolation = new WorkspaceIsolation({ root: repo, slots: 1, stateDir })
  return { isolation, stateDir }
}

/**
 * Write a patch and its record by hand, as a record a sibling service might have stored.
 * Used for the parser and validation cases that do not need a real collection.
 */
function storeRawPatch(isolation, patchId, diff, filesChanged, extra = {}) {
  const patchPath = join(isolation.patchDir, `${patchId}.patch`)
  writeFileSync(patchPath, diff)
  writeFileSync(
    join(isolation.patchDir, `${patchId}.json`),
    `${JSON.stringify({ patchId, root: isolation.root, filesChanged, diffstat: '', createdAt: Date.now(), appliedAt: null, ...extra })}\n`,
  )
  return { patchId, patchPath }
}

/** Lease, prepare, apply `mutate` to the copy, and collect. The slot stays leased for a second collect. */
async function collectInCopy(isolation, mutate, options = {}) {
  const slot = await isolation.lease()
  isolation.prepare(slot)
  mutate(slot.dir)
  return { slot, change: isolation.collect(slot, options) }
}

/** The per-file sections of a patch, each beginning at its `diff --git` line. */
function sectionsOf(diff) {
  const starts = []
  const scanner = /^diff --git /gm
  let match
  while ((match = scanner.exec(diff)) !== null) starts.push(match.index)
  return starts.map((start, index) => diff.slice(start, index + 1 < starts.length ? starts[index + 1] : diff.length))
}

/**
 * A runtime stand-in that replays one successful child per prompt, writing the files a
 * test asked for into whatever tree it was given. Large enough for the paths under test,
 * small enough that these tests need no Harness.
 */
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
    if (this.cwd !== undefined) {
      for (const [name, content] of Object.entries(this.writes)) {
        mkdirSync(dirname(join(this.cwd, name)), { recursive: true })
        writeFileSync(join(this.cwd, name), content)
      }
    }
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

/** A git-backed root, a state directory, and a service over both with a fake runtime. */
function makeIsoService({ root, stateDir, writes = {}, diffChars, slots = 1 } = {}) {
  const client = new FakeSdkClient(writes)
  const service = new FlashTaskService({
    root,
    clientFactory: () => client,
    log: () => {},
    isolate: { slots, stateDir, ...(diffChars === undefined ? {} : { diffChars }) },
  })
  return { service, client }
}

// ── the clipped diff in a result ─────────────────────────────────────────────

test('clipping keeps whole files and names the ones it left out', async () => {
  const repo = makeRepo({
    'a.txt': 'a1\na2\na3\na4\na5\n',
    'b.txt': 'b1\nb2\nb3\nb4\nb5\n',
    'c.txt': 'c1\nc2\nc3\nc4\nc5\n',
  })
  const { isolation } = makePool(repo)
  const { slot, change: full } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, 'a.txt'), 'a1 EDITED\na2\na3\na4\na5\n')
    writeFileSync(join(dir, 'b.txt'), 'b1 EDITED\nb2\nb3\nb4\nb5\n')
    writeFileSync(join(dir, 'c.txt'), 'c1 EDITED\nc2\nc3\nc4\nc5\n')
  }, { diffChars: 1_000_000 })
  const sections = sectionsOf(full.diff)
  assert.equal(sections.length, 3)

  // A budget that fits exactly the first two files: the third is left out whole.
  const budget = sections[0].length + sections[1].length
  const clipped = isolation.collect(slot, { diffChars: budget })
  assert.equal(clipped.diff, sections[0] + sections[1], 'whole file sections, in order')
  assert.equal(clipped.diff.endsWith('\n'), true, 'a clipped diff never ends mid-line')
  assert.ok(clipped.diff.length <= budget)
  assert.deepEqual(clipped.diffOmitted, ['c.txt'])
  assert.equal(clipped.diffChars, full.diff.length, 'diffChars stays the full patch length')
  isolation.release(slot)
  isolation.close()
})

test('a first file larger than the limit is cut at its last whole line and named', async () => {
  const repo = makeRepo({ 'big.txt': Array.from({ length: 40 }, (_, index) => `line ${String(index)}\n`).join('') })
  const { isolation } = makePool(repo)
  const { slot, change: full } = await collectInCopy(
    isolation,
    (dir) => writeFileSync(join(dir, 'big.txt'), Array.from({ length: 40 }, (_, index) => `changed ${String(index)}\n`).join('')),
    { diffChars: 1_000_000 },
  )
  assert.equal(sectionsOf(full.diff).length, 1)

  const limit = 120
  const clipped = isolation.collect(slot, { diffChars: limit })
  const boundary = full.diff.lastIndexOf('\n', limit - 1) + 1
  assert.equal(clipped.diff, full.diff.slice(0, boundary), 'kept up to the last whole line inside the budget')
  assert.ok(clipped.diff.length <= limit)
  assert.equal(clipped.diff.endsWith('\n'), true)
  assert.deepEqual(clipped.diffOmitted, ['big.txt'], 'the partly kept file is named too')
  assert.ok(clipped.diff.length < full.diff.length)
  isolation.release(slot)
  isolation.close()
})

test('quoted, renamed, and deleted paths are named when sections are dropped', async () => {
  const repo = makeRepo({ 'gone.txt': 'delete me\n', 'old.txt': 'rename me\n', 'space name.txt': 'edit me\n' })
  const { isolation } = makePool(repo)
  const { slot, change } = await collectInCopy(isolation, (dir) => {
    rmSync(join(dir, 'gone.txt'))
    rmSync(join(dir, 'old.txt'))
    writeFileSync(join(dir, 'new.txt'), 'rename me\n')
    writeFileSync(join(dir, 'space name.txt'), 'edited\n')
  }, { diffChars: 0 })

  assert.equal(change.diff, '', 'a zero budget keeps nothing')
  // The deletion keeps its own name, the rename takes the new path, and the quoted path
  // is decoded back to the name on disk rather than left as `"a/space name.txt"`.
  assert.deepEqual(change.diffOmitted.sort(), ['gone.txt', 'new.txt', 'space name.txt'])
  assert.equal(change.diffOmitted.includes('old.txt'), false, 'a rename reports its new path')
  isolation.release(slot)
  isolation.close()
})

test('a stored change reports patchPath and the files its clipped diff omitted', async () => {
  const root = makeRepo({ 'README.md': '# project\n' })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-patch-state-')))
  const { service } = makeIsoService({ root, stateDir, writes: { 'worker.txt': 'written by the worker\n' }, diffChars: 90 })
  const result = await service.flashTask({ task: 'write one file', cwd: root })

  assert.equal(result.change.available, true)
  assert.equal(result.change.diffTruncated, true)
  assert.deepEqual(result.change.diffOmitted, ['worker.txt'])
  assert.equal(typeof result.change.patchPath, 'string')
  assert.equal(existsSync(result.change.patchPath), true)
  assert.equal(readFileSync(result.change.patchPath, 'utf8').startsWith('diff --git '), true)
  assert.ok(result.change.diff.endsWith('\n'))
  assert.ok(result.change.diff.length < readFileSync(result.change.patchPath, 'utf8').length)
  await service.close()
})

// ── flash_patch: reading the stored patch ───────────────────────────────────

test('flash_patch reads the whole stored patch and says it is not applied', async () => {
  const root = makeRepo({ 'README.md': '# project\n' })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-patch-state-')))
  const { service } = makeIsoService({ root, stateDir, writes: { 'worker.txt': 'written by the worker\n' } })
  const result = await service.flashTask({ task: 'write one file', cwd: root })
  const stored = readFileSync(result.change.patchPath, 'utf8')

  const page = service.flashPatch({ patchId: result.change.patchId })
  assert.equal(page.patchId, result.change.patchId)
  assert.equal(page.patchPath, result.change.patchPath)
  assert.equal(page.applied, false)
  assert.deepEqual(page.filesChanged, ['worker.txt'])
  assert.equal(page.totalChars, stored.length)
  assert.equal(page.offset, 0)
  assert.equal(page.diff, stored)
  assert.deepEqual(page.files, ['worker.txt'])
  assert.equal(page.nextOffset, null)
  assert.match(page.diffstat, /worker\.txt/)
  // Reading changes nothing on the caller's side.
  assert.equal(existsSync(join(root, 'worker.txt')), false)
  await service.close()
})

test('flash_patch pages reassemble the exact stored patch, ending at lines', async () => {
  const root = makeRepo({ 'README.md': '# project\n' })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-patch-state-')))
  const { service } = makeIsoService({
    root,
    stateDir,
    writes: { 'alpha.txt': 'alpha one\nalpha two\nalpha three\n', 'space name.txt': 'space one\nspace two\n' },
  })
  const result = await service.flashTask({ task: 'write two files', cwd: root })
  const stored = readFileSync(result.change.patchPath, 'utf8')

  const pieces = []
  let offset = 0
  for (let guard = 0; guard < 200; guard += 1) {
    const page = service.flashPatch({ patchId: result.change.patchId, offset, maxChars: 60 })
    assert.ok(page.diff.length <= 60, 'a page never exceeds maxChars')
    assert.ok(page.diff.endsWith('\n'), 'a page ends at a line boundary when no line exceeds the page')
    pieces.push(page.diff)
    if (page.nextOffset === null) break
    assert.ok(page.nextOffset > offset, 'paging always makes progress')
    offset = page.nextOffset
  }
  assert.equal(pieces.join(''), stored, 'the pages cover the stored patch exactly once')
  await service.close()
})

test('flash_patch files selects one section and refuses a name the patch lacks', async () => {
  const root = makeRepo({ 'README.md': '# project\n' })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-patch-state-')))
  const { service } = makeIsoService({
    root,
    stateDir,
    writes: { 'alpha.txt': 'alpha one\nalpha two\n', 'space name.txt': 'space one\nspace two\n' },
  })
  const result = await service.flashTask({ task: 'write two files', cwd: root })

  const page = service.flashPatch({ patchId: result.change.patchId, files: ['space name.txt'] })
  assert.deepEqual(page.files, ['space name.txt'])
  assert.match(page.diff, /space name\.txt/)
  assert.doesNotMatch(page.diff, /alpha\.txt/)
  assert.equal(page.totalChars, page.diff.length)
  assert.equal(page.nextOffset, null)

  assert.throws(
    // A name the patch does not contain is answered with the names it does contain.
    () => service.flashPatch({ patchId: result.change.patchId, files: ['nope.txt'] }),
    (error) =>
      error instanceof FlashTaskError &&
      error.code === 'PATCH_UNAVAILABLE' &&
      /does not contain "nope\.txt"/.test(error.message) &&
      /space name\.txt/.test(error.message),
  )
  await service.close()
})

test('flash_patch refuses a malformed id and a patch from another root', async () => {
  const root = makeRepo({ 'README.md': '# project\n' })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-patch-state-')))
  const { service } = makeIsoService({ root, stateDir, writes: { 'worker.txt': 'written by the worker\n' } })
  const result = await service.flashTask({ task: 'write one file', cwd: root })

  assert.throws(
    () => service.flashPatch({ patchId: 'flash-nope' }),
    (error) => error instanceof FlashTaskError && /is not an id this service issues/.test(error.message),
  )

  // A second root sharing the patch directory must not read the first root's patch.
  const otherRoot = makeRepo({ 'README.md': '# other\n' })
  const other = makeIsoService({ root: otherRoot, stateDir })
  assert.throws(
    () => other.service.flashPatch({ patchId: result.change.patchId }),
    (error) => error instanceof FlashTaskError && /computed for/.test(error.message),
  )
  await service.close()
  await other.service.close()
})

// ── threeWay apply ──────────────────────────────────────────────────────────

test('a threeWay apply merges a patch whose context moved, and leaves the index alone', async () => {
  const repo = makeRepo({ 'f.txt': 'l1\nl2\nl3\nl4\nl5\nl6\n' })
  const { isolation } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, 'f.txt'), 'l1\nl2 WORKER\nl3\nl4\nl5\nl6\n')
  })
  // Another session commits an adjacent change, so the worker's context no longer matches.
  writeFileSync(join(repo, 'f.txt'), 'l1\nl2\nl3\nl4 ROOT\nl5\nl6\n')
  commit(repo, 'root moves')

  assert.throws(
    () => isolation.apply({ patchId: change.patchId }),
    (error) => /retry with threeWay: true/.test(error.message) && error.message.includes(change.patchPath),
  )
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), 'l1\nl2\nl3\nl4 ROOT\nl5\nl6\n', 'a failed plain apply wrote nothing')

  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.applied, true)
  assert.equal(applied.threeWay, true)
  assert.deepEqual(applied.conflicts, [])
  assert.equal(applied.indexTouched, false, 'the merge never touches the caller index')
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), 'l1\nl2 WORKER\nl3\nl4 ROOT\nl5\nl6\n')
  assert.equal(gitOut(repo, 'diff', '--cached', '--name-only'), '', 'nothing is staged in the caller index')
  isolation.close()
})

test('a threeWay apply merges a patch whose base was uncommitted in the caller tree', async () => {
  // The case parallel sessions produce: the copy started from an edit nobody committed,
  // so the blob the patch names as its preimage exists only in the copy, which is gone.
  const repo = makeRepo({ 'f.txt': 'l1\nl2\nl3\nl4\nl5\nl6\n' })
  writeFileSync(join(repo, 'f.txt'), 'l1\nl2\nl3\nl4\nl5\nl6 DIRTY\n')
  const { isolation } = makePool(repo)
  const { slot, change } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, 'f.txt'), 'l1\nl2 WORKER\nl3\nl4\nl5\nl6 DIRTY\n')
  })
  isolation.discard(slot)
  isolation.release(slot)
  writeFileSync(join(repo, 'f.txt'), 'l1\nl2\nl3\nl4 ROOT\nl5\nl6 DIRTY\n')

  assert.throws(() => isolation.apply({ patchId: change.patchId }), /retry with threeWay: true/)
  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.threeWay, true)
  assert.equal(applied.indexTouched, false)
  assert.deepEqual(applied.conflicts, [])
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), 'l1\nl2 WORKER\nl3\nl4 ROOT\nl5\nl6 DIRTY\n')
  assert.equal(gitOut(repo, 'diff', '--cached', '--name-only'), '', 'the uncommitted caller index is left as it was')
  isolation.close()
})

test('a threeWay conflict writes markers, names the path, records the apply, and leaves the index alone', async () => {
  const repo = makeRepo({ 'f.txt': 'l1\nl2\nl3\nl4\n' })
  const { isolation } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => writeFileSync(join(dir, 'f.txt'), 'l1\nl2 WORKER\nl3\nl4\n'))
  writeFileSync(join(repo, 'f.txt'), 'l1\nl2 ROOT\nl3\nl4\n')
  commit(repo, 'root moves onto the same line')

  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.applied, true)
  assert.equal(applied.threeWay, true)
  assert.deepEqual(applied.conflicts, ['f.txt'])
  assert.equal(applied.indexTouched, false)
  assert.match(applied.note, /conflict markers/)
  assert.match(readFileSync(join(repo, 'f.txt'), 'utf8'), /<<<<<<< /)
  assert.equal(gitOut(repo, 'diff', '--cached', '--name-only'), '', 'conflict markers are not staged')
  // The tree changed, so the apply is recorded and a second apply is refused.
  assert.throws(() => isolation.apply({ patchId: change.patchId }), /was already applied/)
  isolation.close()
})

test('a threeWay dry run predicts the conflict and writes nothing', async () => {
  const repo = makeRepo({ 'f.txt': 'l1\nl2\nl3\nl4\n' })
  const { isolation } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => writeFileSync(join(dir, 'f.txt'), 'l1\nl2 WORKER\nl3\nl4\n'))
  writeFileSync(join(repo, 'f.txt'), 'l1\nl2 ROOT\nl3\nl4\n')
  commit(repo, 'root moves onto the same line')

  const checked = isolation.apply({ patchId: change.patchId, dryRun: true, threeWay: true })
  assert.equal(checked.applied, false)
  assert.equal(checked.threeWay, true)
  assert.equal(checked.indexTouched, false)
  assert.deepEqual(checked.conflicts, ['f.txt'], 'the scratch merge predicts the conflict exactly')
  assert.equal(checked.note, undefined, 'nothing was written, so there is nothing to warn about')
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), 'l1\nl2 ROOT\nl3\nl4\n')
  assert.equal(gitOut(repo, 'status', '--porcelain'), '', 'a dry run leaves the tree exactly as it was')

  // Because nothing was recorded, the same patch may still be applied for real.
  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.applied, true)
  assert.deepEqual(applied.conflicts, ['f.txt'])
  isolation.close()
})

test('a threeWay apply adds, deletes, and renames files while another touched line moved', async () => {
  const repo = makeRepo({
    'keep.txt': 'keep me\n',
    'gone.txt': 'delete me\n',
    'edit.txt': 'e1\ne2\ne3\ne4\ne5\ne6\ne7\n',
  })
  const { isolation } = makePool(repo)
  const { slot, change } = await collectInCopy(isolation, (dir) => {
    rmSync(join(dir, 'gone.txt'))
    rmSync(join(dir, 'keep.txt'))
    writeFileSync(join(dir, 'renamed.txt'), 'keep me\n')
    writeFileSync(join(dir, 'added.txt'), 'a new file\n')
    writeFileSync(join(dir, 'edit.txt'), 'e1\ne2\ne3\ne4\ne5 WORKER\ne6\ne7\n')
  })
  isolation.discard(slot)
  isolation.release(slot)
  // The caller moves a line that sits inside the patch's context, so the plain apply fails,
  // while the worker's edit is on a different line the merge can keep.
  writeFileSync(join(repo, 'edit.txt'), 'e1\ne2 ROOT\ne3\ne4\ne5\ne6\ne7\n')
  commit(repo, 'an unrelated line moves')

  assert.throws(() => isolation.apply({ patchId: change.patchId }), /retry with threeWay: true/)
  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.threeWay, true)
  assert.deepEqual(applied.conflicts, [])
  assert.equal(readFileSync(join(repo, 'added.txt'), 'utf8'), 'a new file\n')
  assert.equal(existsSync(join(repo, 'renamed.txt')), true)
  assert.equal(readFileSync(join(repo, 'renamed.txt'), 'utf8'), 'keep me\n')
  assert.equal(existsSync(join(repo, 'keep.txt')), false, 'the rename removes the old name')
  assert.equal(existsSync(join(repo, 'gone.txt')), false, 'the deletion removes the file')
  assert.equal(readFileSync(join(repo, 'edit.txt'), 'utf8'), 'e1\ne2 ROOT\ne3\ne4\ne5 WORKER\ne6\ne7\n')
  assert.equal(gitOut(repo, 'diff', '--cached', '--name-only'), '')
  isolation.close()
})

test('a threeWay apply keeps an executable mode and merges a binary file the caller left alone', async () => {
  const repo = makeRepo({
    'f.txt': 'l1\nl2\nl3\nl4\nl5\nl6\n',
    'run.sh': '#!/bin/sh\necho one\n',
    // Bytes that are not valid UTF-8, so a text read of the merged blob would corrupt them.
    'blob.bin': Buffer.from([0x00, 0x01, 0xfe, 0xff]),
  })
  chmodSync(join(repo, 'run.sh'), 0o755)
  commit(repo, 'executable mode')
  const { isolation } = makePool(repo)
  const { slot, change } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, 'f.txt'), 'l1\nl2 WORKER\nl3\nl4\nl5\nl6\n')
    writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho one\necho two\n')
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0x80, 0x81, 0xfe, 0xff, 0x00]))
  })
  isolation.discard(slot)
  isolation.release(slot)
  writeFileSync(join(repo, 'f.txt'), 'l1\nl2\nl3\nl4 ROOT\nl5\nl6\n')
  commit(repo, 'root moves')

  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.threeWay, true)
  assert.deepEqual(applied.conflicts, [])
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), 'l1\nl2 WORKER\nl3\nl4 ROOT\nl5\nl6\n')
  assert.equal(readFileSync(join(repo, 'run.sh'), 'utf8'), '#!/bin/sh\necho one\necho two\n')
  assert.notEqual(statSync(join(repo, 'run.sh')).mode & 0o111, 0, 'the executable bit survives the merge')
  assert.deepEqual(
    readFileSync(join(repo, 'blob.bin')),
    Buffer.from([0x80, 0x81, 0xfe, 0xff, 0x00]),
    'binary bytes are written back unchanged',
  )
  isolation.close()
})

test('a threeWay apply writes a symlink result back as a symlink', async () => {
  const repo = makeRepo({ 'one.txt': 'one\n', 'two.txt': 'two\n', 'f.txt': 'l1\nl2\nl3\nl4\nl5\nl6\n' })
  symlinkSync('one.txt', join(repo, 'link'))
  commit(repo, 'a symlink')
  const { isolation } = makePool(repo)
  const { slot, change } = await collectInCopy(isolation, (dir) => {
    rmSync(join(dir, 'link'))
    symlinkSync('two.txt', join(dir, 'link'))
    writeFileSync(join(dir, 'f.txt'), 'l1\nl2 WORKER\nl3\nl4\nl5\nl6\n')
  })
  isolation.discard(slot)
  isolation.release(slot)
  writeFileSync(join(repo, 'f.txt'), 'l1\nl2\nl3\nl4 ROOT\nl5\nl6\n')
  commit(repo, 'root moves')

  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.threeWay, true)
  assert.deepEqual(applied.conflicts, [])
  assert.equal(lstatSync(join(repo, 'link')).isSymbolicLink(), true, 'the result is a link, not the file it names')
  assert.equal(readlinkSync(join(repo, 'link')), 'two.txt')
  isolation.close()
})

test('a threeWay apply works when the target is no longer a git work tree', async () => {
  const repo = makeRepo({ 'f.txt': 'l1\nl2\nl3\nl4\nl5\nl6\n' })
  const { isolation } = makePool(repo)
  const { slot, change } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, 'f.txt'), 'l1\nl2 WORKER\nl3\nl4\nl5\nl6\n')
  })
  isolation.discard(slot)
  isolation.release(slot)
  // The caller's tree stops being a repository; the saved base blobs are all the scratch
  // merge needs, and the caller's objects were never a requirement.
  rmSync(join(repo, '.git'), { recursive: true, force: true })
  writeFileSync(join(repo, 'f.txt'), 'l1\nl2\nl3\nl4 ROOT\nl5\nl6\n')

  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.applied, true)
  assert.equal(applied.threeWay, true)
  assert.deepEqual(applied.conflicts, [])
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), 'l1\nl2 WORKER\nl3\nl4 ROOT\nl5\nl6\n')
  isolation.close()
})

test('a threeWay apply finds a committed base in the target repository, not only in the saved blobs', async () => {
  const repo = makeRepo({ 'f.txt': 'l1\nl2\nl3\nl4\nl5\nl6\n' })
  const { isolation } = makePool(repo)
  const { slot, change } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, 'f.txt'), 'l1\nl2 WORKER\nl3\nl4\nl5\nl6\n')
  })
  isolation.discard(slot)
  isolation.release(slot)
  // A patch stored before blob saving, or one whose saving failed: its base is the commit
  // the caller already has, so the scratch repository can borrow the blob from there.
  rmSync(join(isolation.patchDir, `${change.patchId}.blobs`), { recursive: true, force: true })
  writeFileSync(join(repo, 'f.txt'), 'l1\nl2\nl3\nl4 ROOT\nl5\nl6\n')
  commit(repo, 'root moves')

  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.threeWay, true)
  assert.deepEqual(applied.conflicts, [])
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), 'l1\nl2 WORKER\nl3\nl4 ROOT\nl5\nl6\n')
  isolation.close()
})

test('a threeWay apply refuses when the base is in neither the saved blobs nor the target repository', async () => {
  const repo = makeRepo({ 'f.txt': 'l1\nl2\nl3\nl4\n' })
  // The base is an uncommitted edit, so the blob lived only in the copy and now only in the
  // saved blobs. Removing them is exactly "saving failed" for this patch.
  writeFileSync(join(repo, 'f.txt'), 'l1\nl2 DIRTY\nl3\nl4\n')
  const { isolation } = makePool(repo)
  const { slot, change } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, 'f.txt'), 'l1\nl2 WORKER\nl3\nl4\n')
  })
  isolation.discard(slot)
  isolation.release(slot)
  rmSync(join(isolation.patchDir, `${change.patchId}.blobs`), { recursive: true, force: true })
  writeFileSync(join(repo, 'f.txt'), 'l1\nl2 ROOT\nl3\nl4\n')

  assert.throws(
    () => isolation.apply({ patchId: change.patchId, threeWay: true }),
    (error) =>
      // The plain failure is kept in front of the explanation, so a caller still sees why
      // a plain apply was not enough.
      /patch failed|does not apply/.test(error.message) &&
      /The base of patch/.test(error.message) &&
      /not available for a three-way merge/.test(error.message) &&
      /flash-.+\.patch/.test(error.message),
  )
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), 'l1\nl2 ROOT\nl3\nl4\n', 'a refused merge wrote nothing')
  isolation.close()
})

test('flash_apply carries threeWay through, and the plain failure points at it', async () => {
  const root = makeRepo({ 'f.txt': 'l1\nl2\nl3\nl4\nl5\nl6\n' })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-patch-state-')))
  const { service } = makeIsoService({ root, stateDir, writes: { 'f.txt': 'l1\nl2 WORKER\nl3\nl4\nl5\nl6\n' } })
  const result = await service.flashTask({ task: 'edit one file', cwd: root })
  writeFileSync(join(root, 'f.txt'), 'l1\nl2\nl3\nl4 ROOT\nl5\nl6\n')
  commit(root, 'root moves')

  assert.throws(
    () => service.flashApply({ patchId: result.change.patchId }),
    (error) =>
      error.code === 'APPLY_FAILED' &&
      /retry with threeWay: true/.test(error.message) &&
      error.message.includes(result.change.patchPath),
  )
  const applied = service.flashApply({ patchId: result.change.patchId, threeWay: true })
  assert.equal(applied.threeWay, true)
  assert.equal(applied.indexTouched, false)
  assert.match(readFileSync(join(root, 'f.txt'), 'utf8'), /WORKER/)
  assert.equal(gitOut(root, 'diff', '--cached', '--name-only'), '')
  await service.close()
})

// ── the saved preimage blobs ────────────────────────────────────────────────

test('trim removes an applied patch together with its saved blobs', async () => {
  const repo = makeRepo({ 'f.txt': 'l1\nl2\nl3\nl4\n' })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-patch-state-')))
  // A one-byte cap: the first trim after the patch is applied reclaims it.
  const isolation = new WorkspaceIsolation({ root: repo, slots: 1, stateDir, maxStateBytes: 1 })
  const { slot, change } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, 'f.txt'), 'l1\nl2 WORKER\nl3\nl4\n')
  })
  isolation.release(slot)
  const blobs = join(stateDir, 'calls', `${change.patchId}.blobs`)
  assert.equal(existsSync(blobs), true, 'collect saved the preimage blobs beside the patch')

  // collect's own trim ran while the patch was still unapplied, so it was kept.
  const applied = isolation.apply({ patchId: change.patchId })
  assert.equal(applied.applied, true)
  const trimmed = isolation.trim()
  assert.equal(trimmed.removedPatches, 1)
  assert.equal(existsSync(change.patchPath), false)
  assert.equal(existsSync(join(stateDir, 'calls', `${change.patchId}.json`)), false)
  assert.equal(existsSync(blobs), false, 'the saved blobs go with the patch they belong to')
  isolation.close()
})

test('prune removes an expired patch together with its saved blobs', () => {
  const patchDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-patch-dir-')))
  const patchId = `flash-${randomUUID()}`
  writeFileSync(join(patchDir, `${patchId}.patch`), 'a stored patch\n')
  writeFileSync(
    join(patchDir, `${patchId}.json`),
    `${JSON.stringify({ patchId, root: '/some/root', createdAt: Date.now() - 30 * DAY_MS })}\n`,
  )
  mkdirSync(join(patchDir, `${patchId}.blobs`, 'pack'), { recursive: true })
  writeFileSync(join(patchDir, `${patchId}.blobs`, 'pack', 'pack-x.pack'), 'a saved pack\n')

  assert.equal(prunePatches(patchDir, { now: Date.now() }), 1)
  assert.equal(existsSync(join(patchDir, `${patchId}.patch`)), false)
  assert.equal(existsSync(join(patchDir, `${patchId}.json`)), false)
  assert.equal(existsSync(join(patchDir, `${patchId}.blobs`)), false, 'the saved blobs go with the patch they belong to')
})

test('prune removes old orphan patch files and blob directories that no record names', () => {
  const patchDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-patch-dir-')))
  const oldId = `flash-${randomUUID()}`
  const freshId = `flash-${randomUUID()}`
  for (const id of [oldId, freshId]) {
    writeFileSync(join(patchDir, `${id}.patch`), 'a patch with no record\n')
    mkdirSync(join(patchDir, `${id}.blobs`, 'pack'), { recursive: true })
    writeFileSync(join(patchDir, `${id}.blobs`, 'pack', 'pack-x.pack'), 'a saved pack\n')
  }
  // A crash between the patch and its record leaves these unreferenced; only age may
  // reclaim them, because a fresh one can be a collect that is still running.
  const old = new Date(Date.now() - 30 * DAY_MS)
  for (const path of [join(patchDir, `${oldId}.patch`), join(patchDir, `${oldId}.blobs`), join(patchDir, `${oldId}.blobs`, 'pack')]) {
    utimesSync(path, old, old)
  }

  assert.equal(prunePatches(patchDir, { now: Date.now() }), 2)
  assert.equal(existsSync(join(patchDir, `${oldId}.patch`)), false, 'the orphan patch goes')
  assert.equal(existsSync(join(patchDir, `${oldId}.blobs`)), false, 'the orphan blobs go with it')
  assert.equal(existsSync(join(patchDir, `${freshId}.patch`)), true, 'a fresh orphan is a collect mid-flight, so it stays')
  assert.equal(existsSync(join(patchDir, `${freshId}.blobs`)), true)
})

// ── flash_apply reports plain paths ─────────────────────────────────────────

test('flash_apply reports plain paths, taking the new name of a rename', async () => {
  const root = makeRepo({ 'README.md': '# project\n', 'keep.txt': 'keep me\n' })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-patch-state-')))
  const { service } = makeIsoService({ root, stateDir })
  const slot = await service.isolation.lease()
  service.isolation.prepare(slot)
  // Identical content, so git records this as a rename rather than a delete plus an add.
  execFileSync('git', ['mv', 'keep.txt', 'renamed.txt'], { cwd: slot.dir })
  const change = service.isolation.collect(slot)
  service.isolation.release(slot)

  const applied = service.flashApply({ patchId: change.patchId })
  assert.deepEqual(applied.filesChanged, ['renamed.txt'])
  assert.equal(applied.filesChanged.some((name) => name.includes('\t')), false)
  assert.equal(existsSync(join(root, 'renamed.txt')), true)
  assert.equal(existsSync(join(root, 'keep.txt')), false)
  await service.close()
})

// ── apply "discard" ─────────────────────────────────────────────────────────

test('apply "discard" reports the change, stores nothing, and empties the tree', async () => {
  const root = makeRepo({ 'README.md': '# project\n' })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-patch-state-')))
  const { service } = makeIsoService({ root, stateDir, writes: { 'discard.txt': 'written by the worker\n' } })
  const result = await service.flashTask({ task: 'write one file', cwd: root, apply: 'discard' })

  assert.equal(result.change.available, true)
  assert.equal(result.change.stored, false)
  assert.equal(result.change.applied, false)
  assert.equal(result.change.patchId, undefined)
  assert.equal(result.change.patchPath, undefined)
  assert.equal(result.change.diffTruncated, false)
  assert.deepEqual(result.change.filesChanged, ['discard.txt'])
  assert.match(result.change.diff, /written by the worker/)
  assert.equal(existsSync(join(root, 'discard.txt')), false, 'discard still writes only in the copy')
  // Nothing was kept: no patch file, no record, no in-memory patch.
  assert.deepEqual(readdirSync(join(stateDir, 'calls')), [])
  assert.equal(service.isolation.patches.size, 0)
  // The tree is emptied exactly as after a stored change.
  assert.deepEqual(readdirSync(service.isolation.slots[0].dir), [])
  await service.close()
})

test('apply "discard" needs isolation, and an unknown mode is still refused', async () => {
  const root = makeRepo({ 'README.md': '# project\n' })
  const plain = new FlashTaskService({ root, isolate: { mode: 'none' }, log: () => {} })
  await assert.rejects(
    () => plain.flashTask({ task: 'x', cwd: root, apply: 'discard' }),
    (error) => error.code === 'ISOLATION_DISABLED',
  )
  await plain.close()

  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-patch-state-')))
  const { service } = makeIsoService({ root, stateDir })
  await assert.rejects(
    () => service.flashTask({ task: 'x', cwd: root, apply: 'bogus' }),
    (error) => error.code === 'APPLY_UNAVAILABLE' && /"discard"/.test(error.message),
  )
  await service.close()
})

/** Collect one change in a fresh copy and hand the slot back, as a finished call does. */
async function finishedChange(isolation, mutate) {
  const { slot, change } = await collectInCopy(isolation, mutate)
  isolation.discard(slot)
  isolation.release(slot)
  return change
}

test('a threeWay apply refuses to write through a symlinked directory in the caller tree', async () => {
  const repo = makeRepo({ 'keep.txt': 'k\n' })
  const { isolation } = makePool(repo)
  const change = await finishedChange(isolation, (dir) => {
    mkdirSync(join(dir, 'd'))
    writeFileSync(join(dir, 'd', 'new.txt'), 'from the worker\n')
  })
  // The caller's `d` is now a link to a directory outside the tree.
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'flash-outside-')))
  symlinkSync(outside, join(repo, 'd'))

  assert.throws(() => isolation.apply({ patchId: change.patchId, threeWay: true }), /beyond a symbolic link/)
  assert.deepEqual(readdirSync(outside), [], 'nothing was written outside the tree')
  isolation.close()
})

test('a threeWay apply keeps the caller file permissions and only follows the exec bit', async () => {
  const repo = makeRepo({ 'f.txt': 'l1\nl2\nl3\nl4\nl5\nl6\n' })
  const { isolation } = makePool(repo)
  const change = await finishedChange(isolation, (dir) => {
    writeFileSync(join(dir, 'f.txt'), 'l1\nl2 WORKER\nl3\nl4\nl5\nl6\n')
  })
  writeFileSync(join(repo, 'f.txt'), 'l1\nl2\nl3\nl4 ROOT\nl5\nl6\n')
  chmodSync(join(repo, 'f.txt'), 0o600)

  isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), 'l1\nl2 WORKER\nl3\nl4 ROOT\nl5\nl6\n')
  assert.equal(statSync(join(repo, 'f.txt')).mode & 0o777, 0o600)
  isolation.close()
})

test('a threeWay apply writes the line endings the caller checkout uses', async () => {
  const repo = makeRepo({ 'f.txt': 'l1\nl2\nl3\nl4\nl5\nl6\n' })
  const { isolation } = makePool(repo)
  const change = await finishedChange(isolation, (dir) => {
    writeFileSync(join(dir, 'f.txt'), 'l1\nl2 WORKER\nl3\nl4\nl5\nl6\n')
  })
  // A Windows checkout with core.autocrlf: CRLF on disk, LF in the repository.
  writeFileSync(join(repo, 'f.txt'), 'l1\r\nl2\r\nl3\r\nl4 ROOT\r\nl5\r\nl6\r\n')
  const saved = { ...process.env }
  Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'true' })
  try {
    const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
    assert.deepEqual(applied.conflicts, [])
  } finally {
    for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), 'l1\r\nl2 WORKER\r\nl3\r\nl4 ROOT\r\nl5\r\nl6\r\n')
  isolation.close()
})

// ── directory/file collisions in the write-back ──────────────────────────────

test('a threeWay apply replaces a worker’s directory with a file while another line moved', async () => {
  const repo = makeRepo({ 'f.txt': 'l1\nl2\nl3\nl4\nl5\nl6\n' })
  mkdirSync(join(repo, 'd'))
  writeFileSync(join(repo, 'd', 'x.txt'), 'old file\n')
  commit(repo, 'directory')
  const { isolation } = makePool(repo)
  const { slot, change } = await collectInCopy(isolation, (dir) => {
    rmSync(join(dir, 'd', 'x.txt'))
    rmSync(join(dir, 'd'), { recursive: true })
    writeFileSync(join(dir, 'd'), 'now a file\n')
    writeFileSync(join(dir, 'f.txt'), 'l1\nl2 WORKER\nl3\nl4\nl5\nl6\n')
  })
  isolation.discard(slot)
  isolation.release(slot)
  writeFileSync(join(repo, 'f.txt'), 'l1\nl2\nl3\nl4 ROOT\nl5\nl6\n')
  commit(repo, 'root moves')

  assert.throws(() => isolation.apply({ patchId: change.patchId }), /retry with threeWay: true/)
  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.applied, true)
  assert.equal(applied.threeWay, true)
  assert.deepEqual(applied.conflicts, [])
  // The file at `d` replaces the caller's directory only after the directory's one file is
  // deleted; `git diff-tree` lists `d` before `d/x.txt`, so a naive loop wrote into a full
  // directory and threw EISDIR.
  assert.equal(existsSync(join(repo, 'd', 'x.txt')), false)
  assert.equal(readFileSync(join(repo, 'd'), 'utf8'), 'now a file\n')
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), 'l1\nl2 WORKER\nl3\nl4 ROOT\nl5\nl6\n')
  isolation.close()
})

test('a threeWay apply refuses to overwrite a caller directory that replaced a tracked file', async () => {
  const repo = makeRepo({ a: 'base\n' })
  const { isolation } = makePool(repo)
  const change = await finishedChange(isolation, (dir) => {
    writeFileSync(join(dir, 'a'), 'worker\n')
    // Sorts before `a`, so a write loop without a pre-flight would have created it before
    // hitting the directory and throwing.
    writeFileSync(join(dir, '0.txt'), 'written early\n')
  })
  // The caller replaced the tracked file `a` with a directory of its own after the copy
  // was made, so the patch no longer applies plainly and the merge sees delete-vs-modify.
  rmSync(join(repo, 'a'))
  mkdirSync(join(repo, 'a'))
  writeFileSync(join(repo, 'a', 'inner.txt'), 'caller owns this\n')
  commit(repo, 'a becomes a directory')

  assert.throws(
    () => isolation.apply({ patchId: change.patchId, threeWay: true }),
    (error) =>
      /would replace the directory a\b/.test(error.message) &&
      /inner\.txt/.test(error.message) &&
      /refusing to write anything/.test(error.message),
  )
  assert.equal(readFileSync(join(repo, 'a', 'inner.txt'), 'utf8'), 'caller owns this\n', 'the caller’s directory is intact')
  assert.equal(existsSync(join(repo, '0.txt')), false, 'a refused write leaves the earlier path unwritten too')
  isolation.close()
})

// ── applied reports a write, not a merge attempt ─────────────────────────────

test('a threeWay apply that changes nothing reports applied false and records no application', async () => {
  const repo = makeRepo({ 'f.txt': 'l1\nl2\nl3\nl4\n' })
  const { isolation } = makePool(repo)
  const change = await finishedChange(isolation, (dir) => {
    writeFileSync(join(dir, 'f.txt'), 'l1\nl2 WORKER\nl3\nl4\n')
  })
  // The caller independently made exactly the worker's change, so the merged result equals
  // the caller's tree and there is nothing to write.
  writeFileSync(join(repo, 'f.txt'), 'l1\nl2 WORKER\nl3\nl4\n')
  commit(repo, 'the caller made the same change')

  assert.throws(() => isolation.apply({ patchId: change.patchId }), /retry with threeWay: true/)
  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.threeWay, true)
  assert.equal(applied.applied, false, 'nothing was written, so the apply is not reported as applied')
  assert.equal(applied.indexTouched, false)
  assert.match(applied.note, /nothing was written/)
  assert.match(applied.note, /already the caller/)
  // Nothing was recorded: the record still says unapplied and a real apply is not refused.
  assert.equal(isolation.readPatch({ patchId: change.patchId, maxChars: 100000 }).applied, false)
  assert.equal(gitOut(repo, 'diff', '--cached', '--name-only'), '')
  isolation.close()
})

// ── quoted paths in the stored change ────────────────────────────────────────

test('a non-ASCII path is stored and read back by its plain name, not git’s quoted spelling', async () => {
  const root = makeRepo({ 'README.md': '# project\n' })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-patch-state-')))
  const { service } = makeIsoService({ root, stateDir, writes: { 'café.txt': 'written by the worker\n' } })
  const result = await service.flashTask({ task: 'write one file', cwd: root })

  // `--name-status` without `-z` stored `"caf\303\251.txt"`, which no caller can select.
  assert.deepEqual(result.change.filesChanged, ['café.txt'])
  const page = service.flashPatch({ patchId: result.change.patchId, files: ['café.txt'] })
  assert.deepEqual(page.files, ['café.txt'])
  assert.match(page.diff, /caf/)
  await service.close()
})

test('a threeWay apply conflicts when the caller concurrently created the worker’s non-ASCII file', async () => {
  const repo = makeRepo({ 'README.md': '# project\n' })
  const { isolation } = makePool(repo)
  const change = await finishedChange(isolation, (dir) => {
    writeFileSync(join(dir, 'café.txt'), 'worker\n')
  })
  writeFileSync(join(repo, 'café.txt'), 'caller\n')

  assert.throws(() => isolation.apply({ patchId: change.patchId }), /retry with threeWay: true/)
  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  // The quoted spelling put the caller’s file out of `touchedPaths`’ reach, so "ours" lacked
  // it and the merge took the worker’s version as a plain addition.
  assert.deepEqual(applied.conflicts, ['café.txt'])
  const merged = readFileSync(join(repo, 'café.txt'), 'utf8')
  assert.match(merged, /<<<<<<< /)
  assert.match(merged, /worker/)
  assert.match(merged, /caller/)
  isolation.close()
})

// ── mixed quoted diff headers ─────────────────────────────────────────────────

test('flash_patch reads a diff header with exactly one quoted side, either way round', async () => {
  const repo = makeRepo({ 'README.md': '# project\n' })
  const { isolation } = makePool(repo)
  const patchId = `flash-${randomUUID()}`
  // The first header quotes only the destination; the second quotes only the source. Git
  // writes the first when a non-ASCII name follows a plain one, the second in reverse.
  const diff =
    'diff --git a/space name.txt "b/caf\\303\\251.txt"\n' +
    'similarity index 90%\n' +
    'rename from space name.txt\n' +
    'rename to café.txt\n' +
    'diff --git "a/caf\\303\\2512.txt" b/space name2.txt\n' +
    'similarity index 90%\n' +
    'rename from café2.txt\n' +
    'rename to space name2.txt\n'
  storeRawPatch(isolation, patchId, diff, ['R100\tspace name.txt\tcafé.txt', 'R100\tcafé2.txt\tspace name2.txt'])

  const page = isolation.readPatch({ patchId, maxChars: 100000 })
  assert.deepEqual(page.files, ['café.txt', 'space name2.txt'])
  isolation.close()
})

// ── a record’s scope is a path fragment, so it is validated ──────────────────

test('a stored record whose scope escapes the root is refused', async () => {
  const repo = makeRepo({ 'README.md': '# project\n' })
  const { isolation } = makePool(repo)
  const patchId = `flash-${randomUUID()}`
  // `apply` joins this onto the root; without the check the merge would target `../x`.
  storeRawPatch(isolation, patchId, 'diff --git a/x b/x\n', [], { scope: '../x' })

  assert.throws(
    () => isolation.apply({ patchId }),
    (error) =>
      /was stored with scope/.test(error.message) &&
      /"\.\.\/x"/.test(error.message) &&
      /refusing to apply it/.test(error.message),
  )
  isolation.close()
})

test('a threeWay apply that removes a submodule leaves the caller checkout in place', async () => {
  const repo = makeRepo({ 'f.txt': 'l1\nl2\nl3\nl4\nl5\nl6\n' })
  // A nested repository recorded as a gitlink, the way a submodule sits in its parent.
  const sub = join(repo, 'sub')
  mkdirSync(sub)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: sub })
  writeFileSync(join(sub, 'inner.txt'), 'inner\n')
  commit(sub, 'inner')
  commit(repo, 'add sub')
  const { isolation } = makePool(repo)
  const change = await finishedChange(isolation, (dir) => {
    rmSync(join(dir, 'sub'), { recursive: true, force: true })
    writeFileSync(join(dir, 'f.txt'), 'l1\nl2 WORKER\nl3\nl4\nl5\nl6\n')
  })
  writeFileSync(join(repo, 'f.txt'), 'l1\nl2\nl3\nl4 ROOT\nl5\nl6\n')

  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.applied, true)
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), 'l1\nl2 WORKER\nl3\nl4 ROOT\nl5\nl6\n')
  assert.equal(readFileSync(join(sub, 'inner.txt'), 'utf8'), 'inner\n', 'the submodule checkout is untouched')
  isolation.close()
})

test('a threeWay apply over a moved submodule pointer reports no conflict the caller does not have', async () => {
  const repo = makeRepo({ 'f.txt': 'l1\nl2\nl3\nl4\nl5\nl6\n' })
  const sub = join(repo, 'sub')
  mkdirSync(sub)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: sub })
  writeFileSync(join(sub, 'inner.txt'), 'inner\n')
  commit(sub, 'inner')
  commit(repo, 'add sub')
  const { isolation } = makePool(repo)
  const change = await finishedChange(isolation, (dir) => {
    // The worker moves the submodule forward inside its copy, and edits a file of the parent.
    writeFileSync(join(dir, 'sub', 'inner.txt'), 'inner moved\n')
    commit(join(dir, 'sub'), 'move')
    writeFileSync(join(dir, 'f.txt'), 'l1\nl2 WORKER\nl3\nl4\nl5\nl6\n')
  })
  writeFileSync(join(repo, 'f.txt'), 'l1\nl2\nl3\nl4 ROOT\nl5\nl6\n')

  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.deepEqual(applied.conflicts, [])
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), 'l1\nl2 WORKER\nl3\nl4 ROOT\nl5\nl6\n')
  assert.equal(readFileSync(join(sub, 'inner.txt'), 'utf8'), 'inner\n', 'the merge never moves a checkout')
  isolation.close()
})
