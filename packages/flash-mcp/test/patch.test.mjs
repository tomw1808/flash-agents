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

import { WorkspaceIsolation, prunePatches, rootDigest } from '../lib/isolation.js'
import { FlashTaskError, FlashTaskService } from '../lib/service.js'
import { listTools } from '../lib/index.js'

const GIT_ID = ['-c', 'user.email=t@t', '-c', 'user.name=t']

/**
 * Default-layout pools store patches in the durable data directory; keep every one in this
 * file out of the real user data directory.
 */
process.env.FLASH_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'flash-patch-data-')))

const DAY_MS = 24 * 60 * 60 * 1000

/** Run git in a directory and return its standard output. */
function gitOut(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
}

/** A throwaway git repository, realpath'd so macOS `/var` vs `/private/var` cannot bite. */
function makeRepo(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-patch-')))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  for (const [name, content] of Object.entries(files)) {
    // A nested path is part of the real-shaped data these tests use; the file's directory
    // does not exist yet when the repository is made.
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
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

/** A second pool over the same repository and patch store, as a restarted server builds. */
function reopenPool(repo, stateDir) {
  return new WorkspaceIsolation({ root: repo, slots: 1, stateDir })
}

/** The scratch directories a partial apply leaves behind, if any. */
function partialTempDirs(stateDir) {
  return readdirSync(stateDir).filter((name) => name.startsWith('partial-'))
}

/**
 * A pool over a repository with three files, and one stored patch that edits all of them.
 * Two paths live in a subdirectory and one holds a space, so the selection has to keep the
 * record's spelling rather than flatten or quote it.
 */
async function threeFilePatch() {
  const base = {
    'sub/one.txt': TWELVE_LINES,
    'sub/two.txt': TWELVE_LINES,
    'space name.txt': TWELVE_LINES,
  }
  const repo = makeRepo(base)
  const { isolation, stateDir } = makePool(repo)
  const { slot, change } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, 'sub/one.txt'), TWELVE_LINES.replace('l2\n', 'l2 ONE\n'))
    writeFileSync(join(dir, 'sub/two.txt'), TWELVE_LINES.replace('l3\n', 'l3 TWO\n'))
    writeFileSync(join(dir, 'space name.txt'), TWELVE_LINES.replace('l4\n', 'l4 SPACE\n'))
  })
  isolation.discard(slot)
  isolation.release(slot)
  return { repo, isolation, stateDir, change, base }
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
    /** Every dispatched prompt, so a test can read what the worker was told. */
    this.prompts = []
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
    this.prompts.push({ sessionId, text })
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

// ── drift from the patch's base ─────────────────────────────────────────────

/** A file long enough that a worker hunk and a caller edit elsewhere do not share context. */
const TWELVE_LINES = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\n'

test('apply and readPatch report a tree that moved by an unrelated commit', async () => {
  const repo = makeRepo({ 'f.txt': TWELVE_LINES })
  const { isolation } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, 'f.txt'), TWELVE_LINES.replace('l2\n', 'l2 WORKER\n'))
  })
  // Another session commits something else: HEAD moves, the patch's file does not.
  writeFileSync(join(repo, 'unrelated.txt'), 'other work\n')
  commit(repo, 'unrelated work')

  const page = isolation.readPatch({ patchId: change.patchId, maxChars: 1_000_000 })
  const dry = isolation.apply({ patchId: change.patchId, dryRun: true })
  assert.deepEqual(dry.drift, { commitsBehind: 1, filesChangedSince: [] })
  assert.deepEqual(page.drift, dry.drift, 'readPatch carries the same drift')
  assert.equal(dry.warnings, undefined, 'an unrelated commit is not a warning')
  assert.equal(page.applied, false)
  isolation.close()
})

test('apply warns when a commit touched one of the patch’s own files', async () => {
  const repo = makeRepo({ 'f.txt': TWELVE_LINES })
  const { isolation } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, 'f.txt'), TWELVE_LINES.replace('l2\n', 'l2 WORKER\n'))
  })
  // Far enough from the worker's hunk that the plain apply still fits, which is the case
  // the field report hit: nothing failed, and nothing said the file had moved.
  writeFileSync(join(repo, 'f.txt'), TWELVE_LINES.replace('l11\n', 'l11 ROOT\n'))
  commit(repo, 'root touches the patch file')

  const dry = isolation.apply({ patchId: change.patchId, dryRun: true })
  assert.equal(dry.drift.commitsBehind, 1)
  assert.deepEqual(dry.drift.filesChangedSince, ['f.txt'])
  assert.deepEqual(dry.warnings, [
    "1 of this patch's files changed in your tree since the worker's copy was made (f.txt); review the result, or use threeWay: true if the plain apply fails",
  ])
  isolation.close()
})

test('apply lists a patch file edited but not committed since the copy was made', async () => {
  const repo = makeRepo({ 'f.txt': TWELVE_LINES })
  const { isolation } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, 'f.txt'), TWELVE_LINES.replace('l2\n', 'l2 WORKER\n'))
  })
  writeFileSync(join(repo, 'f.txt'), TWELVE_LINES.replace('l11\n', 'l11 UNCOMMITTED\n'))

  const dry = isolation.apply({ patchId: change.patchId, dryRun: true })
  assert.equal(dry.drift.commitsBehind, 0, 'an uncommitted edit moves no commit')
  assert.deepEqual(dry.drift.filesChangedSince, ['f.txt'])
  isolation.close()
})

test('drift lists a patch file the tree deleted since the copy was made', async () => {
  const repo = makeRepo({ 'f.txt': TWELVE_LINES })
  const { isolation } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, 'f.txt'), TWELVE_LINES.replace('l2\n', 'l2 WORKER\n'))
  })
  rmSync(join(repo, 'f.txt'))

  const page = isolation.readPatch({ patchId: change.patchId, maxChars: 1_000_000 })
  assert.deepEqual(page.drift.filesChangedSince, ['f.txt'], 'a deletion is a change from the base')
  // A dry-run merge still reports the drift and the warning without writing the deletion away.
  const predicted = isolation.apply({ patchId: change.patchId, dryRun: true, threeWay: true })
  assert.deepEqual(predicted.drift.filesChangedSince, ['f.txt'])
  assert.match(predicted.warnings[0], /^1 of this patch's files changed .*\(f\.txt\);/)
  assert.equal(existsSync(join(repo, 'f.txt')), false, 'a dry run writes nothing')
  isolation.close()
})

test('a base whose parent is unknown reports commitsBehind null', async () => {
  const repo = makeRepo({ 'f.txt': 'one\n' })
  const { isolation } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, 'f.txt'), 'two\n')
  })
  // A record from an object store that does not hold this base: its parent cannot be read.
  const record = isolation.patches.get(change.patchId)
  record.base = 'f'.repeat(40)
  delete record.baseParent

  const dry = isolation.apply({ patchId: change.patchId, dryRun: true })
  assert.equal(dry.drift.commitsBehind, null)
  assert.deepEqual(dry.drift.filesChangedSince, [])
  isolation.close()
})

test('a record reloaded from disk keeps baseParent, so drift can still count commits', async () => {
  const repo = makeRepo({ 'f.txt': TWELVE_LINES })
  const { isolation, stateDir } = makePool(repo)
  const { slot, change } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, 'f.txt'), TWELVE_LINES.replace('l2\n', 'l2 WORKER\n'))
  })
  // The caller's HEAD at copy time is the base's parent. It exists only in the copy, so
  // closing the pool removes the one tree `resolveBaseParent` could have asked.
  isolation.discard(slot)
  isolation.release(slot)
  isolation.close()
  writeFileSync(join(repo, 'unrelated.txt'), 'other work\n')
  commit(repo, 'the caller moves on')
  const baseParent = gitOut(repo, 'rev-parse', 'HEAD~1').trim()
  assert.equal(baseParent.length, 40, 'a real commit id from git')

  const reopened = reopenPool(repo, stateDir)
  const record = readRecord(reopened, change.patchId)
  assert.equal(record.baseParent, baseParent, 'the parent is persisted beside the base')
  const dry = reopened.apply({ patchId: change.patchId, dryRun: true })
  assert.deepEqual(dry.drift, { commitsBehind: 1, filesChangedSince: [] })
  const page = reopened.readPatch({ patchId: change.patchId, maxChars: 1_000_000 })
  assert.deepEqual(page.drift, dry.drift, 'readPatch page 0 counts the same commits')
  reopened.close()
})

test('a patch with no recorded base gets drift null', async () => {
  const repo = makeRepo({ 'f.txt': 'one\n' })
  const { isolation } = makePool(repo)
  const patchId = `flash-${randomUUID()}`
  storeRawPatch(
    isolation,
    patchId,
    'diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..ce01363\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n',
    ['new.txt'],
  )
  const dry = isolation.apply({ patchId, dryRun: true })
  assert.equal(dry.drift, null)
  assert.equal(dry.warnings, undefined)
  isolation.close()
})

test('drift is computed on the first page only, not on every page', async () => {
  const repo = makeRepo({ 'f.txt': 'one\n' })
  const { isolation } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, 'f.txt'), `${'line\n'.repeat(300)}worker\n`)
  })

  const first = isolation.readPatch({ patchId: change.patchId, maxChars: 400 })
  assert.notEqual(first.nextOffset, null, 'the patch must need a second page')
  assert.equal(first.offset, 0)
  assert.deepEqual(first.drift, { commitsBehind: 0, filesChangedSince: [] })
  const second = isolation.readPatch({ patchId: change.patchId, offset: first.nextOffset, maxChars: 400 })
  assert.ok(second.offset > 0)
  assert.equal('drift' in second, false, 'a later page costs no git spawn for drift')
  isolation.close()
})

test('readPatch reports drift before an apply and null after it', async () => {
  const repo = makeRepo({ 'f.txt': TWELVE_LINES })
  const { isolation } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, 'f.txt'), TWELVE_LINES.replace('l2\n', 'l2 WORKER\n'))
  })

  const before = isolation.readPatch({ patchId: change.patchId, maxChars: 1_000_000 })
  assert.equal(before.applied, false)
  assert.deepEqual(before.drift, { commitsBehind: 0, filesChangedSince: [] })

  isolation.apply({ patchId: change.patchId })
  const after = isolation.readPatch({ patchId: change.patchId, maxChars: 1_000_000 })
  assert.equal(after.applied, true)
  assert.equal(after.drift, null, 'an applied patch no longer has a tree to compare against its base')
  isolation.close()
})

test('a 300-file patch is hashed in one batch, so its dry-run apply stays fast', async () => {
  // Drift used to spawn `git hash-object` once per patch file, so a 300-file patch cost
  // 3.7 s per apply and 3.6 s for the first `flash_patch` page. The whole patch is now
  // hashed in a single `git hash-object --stdin-paths` call, and this pins the result:
  // an apply of a 300-file patch must not fall back to a process per file again.
  const files = {}
  for (let index = 0; index < 300; index += 1) files[`f${String(index).padStart(3, '0')}.txt`] = TWELVE_LINES
  const repo = makeRepo(files)
  const { isolation } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => {
    for (const name of Object.keys(files)) writeFileSync(join(dir, name), TWELVE_LINES.replace('l2\n', 'l2 WORKER\n'))
  })
  assert.equal(change.filesChanged.length, 300)

  const startedAt = process.hrtime.bigint()
  const dry = isolation.apply({ patchId: change.patchId, dryRun: true })
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
  assert.deepEqual(dry.drift, { commitsBehind: 0, filesChangedSince: [] })
  assert.equal(dry.applied, false)
  assert.ok(elapsedMs < 1000, `a 300-file dry run took ${elapsedMs.toFixed(1)} ms, expected under 1000 ms`)
  isolation.close()
})

test('a batched drift still names edited, unedited, deleted and renamed files', async () => {
  // The same four answers the per-file hashing gave, now read out of one batch: a file
  // the caller edited is drift, an untouched one is not, a file the caller deleted is
  // drift, and a rename's old path is drift (and is the destructive edit the apply warns
  // about).
  const repo = makeRepo({
    'clean.txt': TWELVE_LINES,
    'edited.txt': TWELVE_LINES,
    'gone.txt': TWELVE_LINES,
    'old.txt': TWELVE_LINES,
  })
  const { isolation } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, 'clean.txt'), TWELVE_LINES.replace('l2\n', 'l2 WORKER\n'))
    writeFileSync(join(dir, 'edited.txt'), TWELVE_LINES.replace('l2\n', 'l2 WORKER\n'))
    rmSync(join(dir, 'gone.txt'))
    execFileSync('git', ['mv', 'old.txt', 'new.txt'], { cwd: dir })
  })
  writeFileSync(join(repo, 'edited.txt'), TWELVE_LINES.replace('l9\n', 'l9 CALLER\n'))
  rmSync(join(repo, 'gone.txt'))
  writeFileSync(join(repo, 'old.txt'), TWELVE_LINES.replace('l6\n', 'l6 CALLER\n'))

  const dry = isolation.apply({ patchId: change.patchId, dryRun: true })
  assert.equal(dry.drift.commitsBehind, 0)
  assert.deepEqual([...dry.drift.filesChangedSince].sort(), ['edited.txt', 'gone.txt', 'old.txt'])
  // `clean.txt` and the rename's new path are not caller edits.
  assert.equal(dry.drift.filesChangedSince.includes('clean.txt'), false)
  assert.equal(dry.drift.filesChangedSince.includes('new.txt'), false)
  assert.ok(
    dry.warnings.some((line) => line.includes('it deletes or renames old.txt, which you changed')),
    `the destructive edit is still reported, saw ${JSON.stringify(dry.warnings)}`,
  )
  isolation.close()
})

test('the batched hash applies the checkout filters exactly as the per-file hash did', async () => {
  // `--stdin-paths` applies the same path-based filters as `--path`: with `text eol=lf`
  // committed and a CRLF working copy, the blob is the committed one, so a line-ending
  // difference alone is not drift. Hashing the bytes without the path filter would have
  // reported every such file, which is why this stays pinned.
  const lf = TWELVE_LINES
  const crlf = TWELVE_LINES.replace(/\n/g, '\r\n')
  const repo = makeRepo({ '.gitattributes': '*.txt text eol=lf\n', 'f.txt': lf, 'g.txt': lf })
  const { isolation } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, 'f.txt'), lf.replace('l2\n', 'l2 WORKER\n'))
    writeFileSync(join(dir, 'g.txt'), lf.replace('l2\n', 'l2 WORKER\n'))
  })
  // Both files are rewritten CRLF on disk; only `g.txt` also holds a caller edit.
  writeFileSync(join(repo, 'f.txt'), crlf)
  writeFileSync(join(repo, 'g.txt'), crlf.replace('l9\r\n', 'l9 CALLER\r\n'))

  const dry = isolation.apply({ patchId: change.patchId, dryRun: true })
  assert.deepEqual(dry.drift.filesChangedSince, ['g.txt'])
  isolation.close()
})

// ── a rename or deletion must not take the caller's edit with it ────────────

test('a rename over a caller-edited old path is refused, and the edit stays', async () => {
  const repo = makeRepo({ 'old.txt': TWELVE_LINES })
  const { isolation } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => {
    // Identical content, so git records a pure rename: the hunk carries no content for
    // `git apply` to compare, which is what used to delete the caller's edit silently.
    execFileSync('git', ['mv', 'old.txt', 'new.txt'], { cwd: dir })
  })
  const edited = TWELVE_LINES.replace('l6\n', 'l6 CALLER EDIT\n')
  writeFileSync(join(repo, 'old.txt'), edited)

  const page = isolation.readPatch({ patchId: change.patchId, maxChars: 1_000_000 })
  assert.deepEqual(page.drift.filesChangedSince, ['old.txt'], 'the old path is the one the apply removes')

  const dry = isolation.apply({ patchId: change.patchId, dryRun: true })
  assert.deepEqual(dry.drift.filesChangedSince, ['old.txt'])
  assert.ok(
    dry.warnings.some((line) => line.includes('it deletes or renames old.txt, which you changed')),
    `a dry run reports the condition as a warning, saw ${JSON.stringify(dry.warnings)}`,
  )
  assert.equal(readFileSync(join(repo, 'old.txt'), 'utf8'), edited, 'a dry run writes nothing')
  assert.equal(existsSync(join(repo, 'new.txt')), false)

  const refusal =
    `refusing to apply ${change.patchId}: it deletes or renames old.txt, which you changed since the worker's ` +
    'copy was made; your edit would be lost. Pass threeWay: true to merge it (conflicts are marked in the file), ' +
    'or save it first and pass force: true'
  assert.throws(() => isolation.apply({ patchId: change.patchId }), (error) => error.message === refusal)
  assert.equal(readFileSync(join(repo, 'old.txt'), 'utf8'), edited, 'the refusal happens before anything is written')
  assert.equal(existsSync(join(repo, 'new.txt')), false)

  // force: true is the caller saying the edit may go; the rename then lands as before.
  const forced = isolation.apply({ patchId: change.patchId, force: true })
  assert.equal(forced.applied, true)
  assert.equal(existsSync(join(repo, 'new.txt')), true)
  assert.equal(existsSync(join(repo, 'old.txt')), false)
  isolation.close()
})

test('a threeWay rename over a caller-edited old path merges the edit instead of refusing it', async () => {
  const repo = makeRepo({ 'old.txt': TWELVE_LINES })
  const { isolation } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => {
    // A rename that also edits the same line the caller edits, so the merge has a real
    // conflict to mark. The old path is still removed by a plain apply without comparing
    // its content, which is what makes it destructive.
    execFileSync('git', ['mv', 'old.txt', 'new.txt'], { cwd: dir })
    writeFileSync(join(dir, 'new.txt'), TWELVE_LINES.replace('l6\n', 'l6 WORKER\n'))
  })
  const edited = TWELVE_LINES.replace('l6\n', 'l6 CALLER EDIT\n')
  writeFileSync(join(repo, 'old.txt'), edited)

  // A dry run with threeWay predicts the merge instead of reporting the refusal and
  // skipping git: it is the mode that keeps the edit.
  const predicted = isolation.apply({ patchId: change.patchId, dryRun: true, threeWay: true })
  assert.equal(predicted.threeWay, true)
  assert.ok(predicted.conflicts.length > 0, `expected a predicted conflict, saw ${JSON.stringify(predicted.conflicts)}`)
  assert.equal(predicted.applied, false)
  assert.equal(readFileSync(join(repo, 'old.txt'), 'utf8'), edited, 'a dry run writes nothing')
  assert.equal(existsSync(join(repo, 'new.txt')), false)

  // The plain attempt is skipped: it would succeed for a pure rename and discard the edit
  // before the merge ever ran. The merge leaves markers and the caller's text in the tree.
  const applied = isolation.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.threeWay, true)
  assert.ok(applied.conflicts.length > 0)
  assert.equal(applied.indexTouched, false)
  const merged = ['old.txt', 'new.txt']
    .filter((name) => existsSync(join(repo, name)))
    .map((name) => readFileSync(join(repo, name), 'utf8'))
    .join('\n')
  assert.match(merged, /<<<<<<< /, 'the conflict is marked in the file')
  assert.match(merged, /CALLER EDIT/, 'the caller’s edit is still in the tree')
  isolation.close()
})

test('a rename whose old path is untouched applies as before', async () => {
  const repo = makeRepo({ 'old.txt': TWELVE_LINES })
  const { isolation } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => {
    execFileSync('git', ['mv', 'old.txt', 'new.txt'], { cwd: dir })
  })

  const dry = isolation.apply({ patchId: change.patchId, dryRun: true })
  assert.deepEqual(dry.drift.filesChangedSince, [])
  assert.equal(dry.warnings, undefined)
  const applied = isolation.apply({ patchId: change.patchId })
  assert.equal(applied.applied, true)
  assert.equal(existsSync(join(repo, 'new.txt')), true)
  assert.equal(existsSync(join(repo, 'old.txt')), false)
  isolation.close()
})

test('a deletion of a file the caller edited is refused, and the edit stays', async () => {
  const repo = makeRepo({ 'f.txt': TWELVE_LINES })
  const { isolation } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => {
    rmSync(join(dir, 'f.txt'))
  })
  const edited = TWELVE_LINES.replace('l8\n', 'l8 CALLER EDIT\n')
  writeFileSync(join(repo, 'f.txt'), edited)

  const page = isolation.readPatch({ patchId: change.patchId, maxChars: 1_000_000 })
  assert.deepEqual(page.drift.filesChangedSince, ['f.txt'])
  // A dry run reports the condition instead of failing on the content check git would do.
  const dry = isolation.apply({ patchId: change.patchId, dryRun: true })
  assert.equal(dry.applied, false)
  assert.match(dry.warnings[0], /it deletes or renames f\.txt, which you changed/)
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), edited, 'a dry run writes nothing')
  // A real (non-dry) apply is the one that would remove the file; it must refuse first.
  assert.throws(
    () => isolation.apply({ patchId: change.patchId }),
    /refusing to apply .*: it deletes or renames f\.txt, which you changed since the worker's copy was made/,
  )
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), edited, 'the file and its edit are intact')
  isolation.close()
})

test('a record without a preimage warns before removing a path it cannot check', async () => {
  const repo = makeRepo({ 'old.txt': TWELVE_LINES })
  const { isolation } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => {
    execFileSync('git', ['mv', 'old.txt', 'new.txt'], { cwd: dir })
  })
  writeFileSync(join(repo, 'old.txt'), TWELVE_LINES.replace('l6\n', 'l6 CALLER EDIT\n'))
  // A record from before blob saving: no base content, so nothing can be compared.
  delete isolation.patches.get(change.patchId).preimage
  const warning =
    'this patch was stored by an older release, so whether you changed old.txt since cannot be checked; ' +
    'a plain apply removes them'

  const dry = isolation.apply({ patchId: change.patchId, dryRun: true })
  assert.deepEqual(dry.warnings, [warning], 'the apply is not refused, but says what it cannot check')
  assert.equal(dry.applied, false)
  assert.equal(readFileSync(join(repo, 'old.txt'), 'utf8'), TWELVE_LINES.replace('l6\n', 'l6 CALLER EDIT\n'))

  const applied = isolation.apply({ patchId: change.patchId })
  assert.equal(applied.applied, true)
  assert.equal(applied.threeWay, false)
  assert.deepEqual(applied.warnings, [warning])
  assert.equal(existsSync(join(repo, 'new.txt')), true)
  assert.equal(existsSync(join(repo, 'old.txt')), false)
  isolation.close()
})

test('a patch from a nested repository names its paths from the service root', async () => {
  const repo = makeRepo({ 'README.md': '# project\n' })
  const sub = join(repo, 'sub')
  mkdirSync(sub)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: sub })
  writeFileSync(join(sub, 'n.txt'), TWELVE_LINES)
  commit(sub, 'inner')
  commit(repo, 'add sub')
  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot, { cwd: sub })
  // The record's paths are relative to `sub`; every path the caller sees is not.
  execFileSync('git', ['mv', 'n.txt', 'm.txt'], { cwd: join(slot.dir, 'sub') })
  const change = isolation.collect(slot)
  isolation.release(slot)
  assert.equal(change.scope, 'sub')

  writeFileSync(join(sub, 'n.txt'), TWELVE_LINES.replace('l6\n', 'l6 CALLER EDIT\n'))
  const page = isolation.readPatch({ patchId: change.patchId, maxChars: 1_000_000 })
  // `filesChanged` keeps the record's spelling, the one `flash_patch`'s `files` accepts.
  assert.deepEqual(page.filesChanged, ['m.txt'], 'filesChanged keeps the record spelling')
  assert.deepEqual(page.drift.filesChangedSince, ['sub/n.txt'], 'drift names the file the caller has')

  const dry = isolation.apply({ patchId: change.patchId, dryRun: true })
  assert.ok(
    dry.warnings.some((line) => line.includes('it deletes or renames sub/n.txt, which you changed')),
    `a dry run names the service-root path, saw ${JSON.stringify(dry.warnings)}`,
  )
  assert.throws(
    () => isolation.apply({ patchId: change.patchId }),
    /it deletes or renames sub\/n\.txt, which you changed since the worker's copy was made/,
  )
  isolation.close()
})

// ── flash_patch: reading the stored patch ───────────────────────────────────

test('flash_patch says drift is on the first page and null once the patch was applied', () => {
  const tool = listTools().find((entry) => entry.name === 'flash_patch')
  assert.ok(tool !== undefined)
  assert.match(
    tool.description,
    /It is on the page that starts at offset 0, and is `null` once the patch was applied\./,
    'the description must say where drift is, and that it is null after the apply',
  )
})

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

// ── a partial apply: only some of a stored patch ────────────────────────────

test('a partial apply changes one file, records it, and a reloaded pool sees the same', async () => {
  const { repo, isolation, stateDir, change, base } = await threeFilePatch()
  const applied = isolation.apply({ patchId: change.patchId, files: ['sub/one.txt'] })

  assert.equal(applied.applied, true)
  assert.deepEqual(applied.filesChanged, ['sub/one.txt'])
  assert.match(applied.diffstat, /sub\/one\.txt/)
  assert.doesNotMatch(applied.diffstat, /space name\.txt|sub\/two\.txt/)
  assert.equal(readFileSync(join(repo, 'sub/one.txt'), 'utf8'), TWELVE_LINES.replace('l2\n', 'l2 ONE\n'))
  assert.equal(readFileSync(join(repo, 'sub/two.txt'), 'utf8'), base['sub/two.txt'], 'the other files are untouched')
  assert.equal(readFileSync(join(repo, 'space name.txt'), 'utf8'), base['space name.txt'])

  const record = readRecord(isolation, change.patchId)
  assert.deepEqual(record.appliedFiles, ['sub/one.txt'])
  assert.equal(record.appliedAt, null, 'one file of three is not a whole apply')
  const page = isolation.readPatch({ patchId: change.patchId, maxChars: 1_000_000 })
  assert.equal(page.applied, false)
  assert.deepEqual(page.appliedFiles, ['sub/one.txt'])
  assert.equal(page.filesChanged.length, 3, 'the stored record still describes the whole patch')
  isolation.close()

  const reopened = reopenPool(repo, stateDir)
  const reloaded = reopened.readPatch({ patchId: change.patchId, maxChars: 1_000_000 })
  assert.equal(reloaded.applied, false)
  assert.deepEqual(reloaded.appliedFiles, ['sub/one.txt'])

  const rest = reopened.apply({ patchId: change.patchId, files: ['sub/two.txt', 'space name.txt'] })
  assert.equal(rest.applied, true)
  assert.deepEqual([...rest.filesChanged].sort(), ['space name.txt', 'sub/two.txt'])
  assert.equal(readFileSync(join(repo, 'sub/two.txt'), 'utf8'), TWELVE_LINES.replace('l3\n', 'l3 TWO\n'))
  assert.equal(readFileSync(join(repo, 'space name.txt'), 'utf8'), TWELVE_LINES.replace('l4\n', 'l4 SPACE\n'))

  const done = readRecord(reopened, change.patchId)
  assert.deepEqual(done.appliedFiles, ['space name.txt', 'sub/one.txt', 'sub/two.txt'])
  assert.equal(typeof done.appliedAt, 'number', 'every file is in, so the whole apply is recorded')
  const after = reopened.readPatch({ patchId: change.patchId, maxChars: 1_000_000 })
  assert.equal(after.applied, true)
  assert.deepEqual(after.appliedFiles, done.appliedFiles)
  assert.throws(() => reopened.apply({ patchId: change.patchId }), /was already applied/)
  reopened.close()
})

test('a partial apply selects a renamed file by its old path or by its new one', async () => {
  for (const spelling of ['sub/old name.txt', 'sub/new name.txt']) {
    const repo = makeRepo({ 'sub/old name.txt': TWELVE_LINES, 'sub/keep.txt': 'keep me\n' })
    const { isolation } = makePool(repo)
    const { slot, change } = await collectInCopy(isolation, (dir) => {
      execFileSync('git', ['mv', 'old name.txt', 'new name.txt'], { cwd: join(dir, 'sub') })
    })
    isolation.discard(slot)
    isolation.release(slot)

    const applied = isolation.apply({ patchId: change.patchId, files: [spelling] })
    assert.equal(applied.applied, true, `selected by ${spelling}`)
    assert.deepEqual(applied.filesChanged, ['sub/new name.txt'], 'the result reports the name that exists afterwards')
    assert.equal(existsSync(join(repo, 'sub/new name.txt')), true)
    assert.equal(existsSync(join(repo, 'sub/old name.txt')), false)
    assert.equal(readFileSync(join(repo, 'sub/keep.txt'), 'utf8'), 'keep me\n')
    assert.deepEqual(readRecord(isolation, change.patchId).appliedFiles, ['sub/new name.txt'])
    isolation.close()
  }
})

test('a partial apply checks only the selected rename for a destructive edit', async () => {
  const repo = makeRepo({ 'sub/old name.txt': TWELVE_LINES, 'sub/other.txt': TWELVE_LINES })
  const { isolation } = makePool(repo)
  const { slot, change } = await collectInCopy(isolation, (dir) => {
    execFileSync('git', ['mv', 'old name.txt', 'new name.txt'], { cwd: join(dir, 'sub') })
    // The rename also edits a line, so the merge against the caller's edit has a real
    // conflict to mark; the old path is still what a plain apply would remove.
    writeFileSync(join(dir, 'sub/new name.txt'), TWELVE_LINES.replace('l6\n', 'l6 WORKER\n'))
    writeFileSync(join(dir, 'sub/other.txt'), TWELVE_LINES.replace('l3\n', 'l3 OTHER\n'))
  })
  isolation.discard(slot)
  isolation.release(slot)
  const edited = TWELVE_LINES.replace('l6\n', 'l6 CALLER EDIT\n')
  writeFileSync(join(repo, 'sub/old name.txt'), edited)

  // The edited rename is not selected, so it is neither applied nor a reason to refuse.
  const other = isolation.apply({ patchId: change.patchId, files: ['sub/other.txt'] })
  assert.equal(other.applied, true)
  assert.equal(other.warnings, undefined)
  assert.deepEqual(other.drift.filesChangedSince, [])
  assert.equal(readFileSync(join(repo, 'sub/old name.txt'), 'utf8'), edited)
  assert.equal(existsSync(join(repo, 'sub/new name.txt')), false)

  const refusal =
    `refusing to apply ${change.patchId}: it deletes or renames sub/old name.txt, which you changed since the worker's ` +
    'copy was made; your edit would be lost. Pass threeWay: true to merge it (conflicts are marked in the file), ' +
    'or save it first and pass force: true'
  assert.throws(
    () => isolation.apply({ patchId: change.patchId, files: ['sub/old name.txt'] }),
    (error) => error.message === refusal,
  )
  assert.equal(readFileSync(join(repo, 'sub/old name.txt'), 'utf8'), edited, 'the refusal writes nothing')

  // A dry run with threeWay predicts the conflict on the selected rename without writing.
  const predicted = isolation.apply({ patchId: change.patchId, files: ['sub/old name.txt'], dryRun: true, threeWay: true })
  assert.equal(predicted.applied, false)
  assert.equal(predicted.threeWay, true)
  assert.ok(predicted.conflicts.length > 0, `expected a predicted conflict, saw ${JSON.stringify(predicted.conflicts)}`)
  assert.equal(existsSync(join(repo, 'sub/new name.txt')), false)

  const merged = isolation.apply({ patchId: change.patchId, files: ['sub/new name.txt'], threeWay: true })
  assert.equal(merged.applied, true)
  assert.equal(merged.threeWay, true)
  assert.ok(merged.conflicts.length > 0)
  assert.equal(merged.indexTouched, false)
  const mergedText = ['sub/old name.txt', 'sub/new name.txt']
    .map((name) => join(repo, name))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')
  assert.match(mergedText, /CALLER EDIT/, 'the caller’s edit is still in the tree')
  assert.match(mergedText, /<<<<<<< /, 'the merge marks the conflict')

  const done = readRecord(isolation, change.patchId)
  assert.deepEqual(done.appliedFiles, ['sub/new name.txt', 'sub/other.txt'])
  assert.equal(typeof done.appliedAt, 'number', 'both files are now in')
  isolation.close()
})

test('a dry run with files writes nothing and marks nothing', async () => {
  const { repo, isolation, stateDir, change, base } = await threeFilePatch()
  const checked = isolation.apply({ patchId: change.patchId, files: ['sub/one.txt'], dryRun: true })
  assert.equal(checked.applied, false)
  assert.deepEqual(checked.filesChanged, ['sub/one.txt'])
  for (const [name, content] of Object.entries(base)) {
    assert.equal(readFileSync(join(repo, name), 'utf8'), content, `${name} was not written`)
  }
  const record = readRecord(isolation, change.patchId)
  assert.equal(record.appliedAt, null)
  assert.equal(record.appliedFiles, undefined)
  const page = isolation.readPatch({ patchId: change.patchId, maxChars: 1_000_000 })
  assert.equal(page.applied, false)
  assert.equal('appliedFiles' in page, false)
  assert.deepEqual(partialTempDirs(stateDir), [], 'the temporary patch is removed')
  isolation.close()
})

test('a partial apply refuses an unknown file and an empty selection', async () => {
  const { repo, isolation, stateDir, change, base } = await threeFilePatch()
  const unknown =
    `patch ${change.patchId} does not contain "nope.txt"; it changes: space name.txt, sub/one.txt, sub/two.txt`
  assert.throws(
    () => isolation.apply({ patchId: change.patchId, files: ['nope.txt'] }),
    (error) => error.message === unknown,
  )
  assert.throws(
    () => isolation.apply({ patchId: change.patchId, files: [] }),
    (error) => error.message === 'files must name at least one file of the patch',
  )
  for (const [name, content] of Object.entries(base)) {
    assert.equal(readFileSync(join(repo, name), 'utf8'), content)
  }
  assert.deepEqual(partialTempDirs(stateDir), [])
  isolation.close()
})

test('a partial apply refuses a file already applied, and force applies it again', async () => {
  const { repo, isolation, change } = await threeFilePatch()
  isolation.apply({ patchId: change.patchId, files: ['sub/one.txt'] })
  const refusal = `patch ${change.patchId}: sub/one.txt already applied to ${repo}; pass force: true to apply them again`
  assert.throws(
    () => isolation.apply({ patchId: change.patchId, files: ['sub/one.txt'] }),
    (error) => error.message === refusal,
  )

  // Put the file back where the patch expects it, so force reaches git and git agrees.
  writeFileSync(join(repo, 'sub/one.txt'), TWELVE_LINES)
  const forced = isolation.apply({ patchId: change.patchId, files: ['sub/one.txt'], force: true })
  assert.equal(forced.applied, true)
  assert.equal(readFileSync(join(repo, 'sub/one.txt'), 'utf8'), TWELVE_LINES.replace('l2\n', 'l2 ONE\n'))
  const record = readRecord(isolation, change.patchId)
  assert.deepEqual(record.appliedFiles, ['sub/one.txt'])
  assert.equal(record.appliedAt, null, 'still one file of three')
  isolation.close()
})

test('a whole apply refuses after a partial one, and force applies the whole patch', async () => {
  const { repo, isolation, change, base } = await threeFilePatch()
  isolation.apply({ patchId: change.patchId, files: ['sub/one.txt'] })
  const refusal =
    `patch ${change.patchId}: 1 of 3 files were already applied (sub/one.txt); ` +
    'pass files with the rest, or force: true to apply the whole patch again'
  assert.throws(
    () => isolation.apply({ patchId: change.patchId }),
    (error) => error.message === refusal,
  )

  // Restore the one already-applied file so the forced whole apply has a clean surface.
  writeFileSync(join(repo, 'sub/one.txt'), base['sub/one.txt'])
  const forced = isolation.apply({ patchId: change.patchId, force: true })
  assert.equal(forced.applied, true)
  assert.deepEqual([...forced.filesChanged].sort(), ['space name.txt', 'sub/one.txt', 'sub/two.txt'])
  for (const [name, content] of Object.entries(base)) {
    assert.notEqual(readFileSync(join(repo, name), 'utf8'), content, `${name} landed`)
  }
  const record = readRecord(isolation, change.patchId)
  assert.deepEqual(record.appliedFiles, ['space name.txt', 'sub/one.txt', 'sub/two.txt'])
  assert.equal(typeof record.appliedAt, 'number')
  isolation.close()
})

test('the temporary partial patch is removed after a successful and a failing apply', async () => {
  const { repo, isolation, stateDir, change } = await threeFilePatch()
  const storedPath = join(isolation.patchDir, `${change.patchId}.patch`)
  const stored = readFileSync(storedPath, 'utf8')
  isolation.apply({ patchId: change.patchId, files: ['sub/one.txt'] })
  assert.deepEqual(partialTempDirs(stateDir), [], 'nothing is left after a successful partial apply')
  assert.equal(readFileSync(storedPath, 'utf8'), stored, 'the stored patch is never rewritten')
  isolation.close()

  // The destructive-edit refusal happens after the temporary patch has been written.
  const otherRepo = makeRepo({ 'sub/old name.txt': TWELVE_LINES })
  const other = makePool(otherRepo)
  const { slot, change: renameChange } = await collectInCopy(other.isolation, (dir) => {
    execFileSync('git', ['mv', 'old name.txt', 'new name.txt'], { cwd: join(dir, 'sub') })
  })
  other.isolation.discard(slot)
  other.isolation.release(slot)
  writeFileSync(join(otherRepo, 'sub/old name.txt'), TWELVE_LINES.replace('l6\n', 'l6 CALLER EDIT\n'))
  const renamePath = join(other.isolation.patchDir, `${renameChange.patchId}.patch`)
  const renameStored = readFileSync(renamePath, 'utf8')
  assert.throws(
    () => other.isolation.apply({ patchId: renameChange.patchId, files: ['sub/old name.txt'] }),
    /refusing to apply/,
  )
  assert.deepEqual(partialTempDirs(other.stateDir), [], 'nothing is left after a failing partial apply')
  assert.equal(readFileSync(renamePath, 'utf8'), renameStored, 'the stored patch is never rewritten')
  other.isolation.close()
})

test('review: a partial apply records a path the record cannot spell', async () => {
  // A record line is `STATUS<TAB>path`, so a path holding a tab cannot be split back into
  // its fields. The selection still names the section (the header quotes the tab, which
  // `diffSectionNames` decodes), so the apply runs while the per-file bookkeeping matches
  // no line: the result claims nothing was applied and the record forgets the file.
  const tabbed = 'a\tb.txt'
  const repo = makeRepo({ [tabbed]: TWELVE_LINES })
  const { isolation } = makePool(repo)
  const { slot, change } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, tabbed), TWELVE_LINES.replace('l2\n', 'l2 TAB\n'))
  })
  isolation.discard(slot)
  isolation.release(slot)

  const applied = isolation.apply({ patchId: change.patchId, files: [tabbed] })
  assert.equal(applied.applied, true)
  assert.equal(readFileSync(join(repo, tabbed), 'utf8'), TWELVE_LINES.replace('l2\n', 'l2 TAB\n'))
  assert.deepEqual(applied.filesChanged, [tabbed], 'the result names the file it applied')
  const page = isolation.readPatch({ patchId: change.patchId, maxChars: 1_000_000 })
  assert.deepEqual(page.appliedFiles, [tabbed], 'the record remembers the file')
  assert.equal(page.applied, true, 'the only file of the patch is in, so the patch is applied')
  assert.throws(
    () => isolation.apply({ patchId: change.patchId }),
    /was already applied/,
    'a whole apply after it must be refused as applied, not left to git',
  )
  isolation.close()
})

test('review: a path with a tab makes a whole patch look applied when it is not', async () => {
  // `nameStatusEntry` reads a non-rename line as `STATUS<TAB>path` (field 2) while
  // `plainPaths` reads the last field, so `M<TAB>a<TAB>b.txt` decodes as `a` in one place
  // and `b.txt` in the other. Selecting the real file `a` therefore also matches the tab
  // file's line, and the record claims both files are in: a phantom `b.txt` is stored and
  // the tabbed file, still untouched, is reported and refused as already applied.
  const tabbed = 'a\tb.txt'
  const repo = makeRepo({ a: TWELVE_LINES, [tabbed]: TWELVE_LINES })
  const { isolation } = makePool(repo)
  const { slot, change } = await collectInCopy(isolation, (dir) => {
    writeFileSync(join(dir, 'a'), TWELVE_LINES.replace('l2\n', 'l2 A\n'))
    writeFileSync(join(dir, tabbed), TWELVE_LINES.replace('l3\n', 'l3 TAB\n'))
  })
  isolation.discard(slot)
  isolation.release(slot)

  isolation.apply({ patchId: change.patchId, files: ['a'] })
  assert.equal(readFileSync(join(repo, tabbed), 'utf8'), TWELVE_LINES, 'the tabbed file was not part of the selection')
  const record = readRecord(isolation, change.patchId)
  assert.deepEqual(record.appliedFiles, ['a'], 'only the selected file is recorded')
  assert.equal(record.appliedAt, null, 'the patch is not fully applied')
  const page = isolation.readPatch({ patchId: change.patchId, maxChars: 1_000_000 })
  assert.equal(page.applied, false)
  assert.deepEqual(page.filesChanged, ['a', tabbed], 'no phantom name appears in the record')
  isolation.close()
})

test('review: files selects a path whose name contains " b/"', async () => {
  // A `diff --git` header has no quoting for a space, so `diffHeaderPaths` finds the
  // separator with the last `" b/"` in the line. A path that itself holds `" b/"` — here
  // the directory `x b` — moves that match into the name and both real spellings are
  // reported as absent, even though the record names the file correctly.
  const repo = makeRepo({ 'keep.txt': TWELVE_LINES })
  const { isolation } = makePool(repo)
  const { slot, change } = await collectInCopy(isolation, (dir) => {
    mkdirSync(join(dir, 'x b'), { recursive: true })
    writeFileSync(join(dir, 'x b/y.txt'), 'added by the worker\n')
  })
  isolation.discard(slot)
  isolation.release(slot)

  const page = isolation.readPatch({ patchId: change.patchId, maxChars: 1_000_000 })
  assert.deepEqual(page.filesChanged, ['x b/y.txt'], 'the record spells the new file')
  const applied = isolation.apply({ patchId: change.patchId, files: ['x b/y.txt'] })
  assert.equal(applied.applied, true)
  assert.deepEqual(applied.filesChanged, ['x b/y.txt'])
  assert.equal(readFileSync(join(repo, 'x b/y.txt'), 'utf8'), 'added by the worker\n')
  const read = isolation.readPatch({ patchId: change.patchId, files: ['x b/y.txt'], maxChars: 1_000_000 })
  assert.deepEqual(read.files, ['x b/y.txt'])
  isolation.close()
})

// ── names a record or a diff header cannot spell ─────────────────────────────

test('a record round-trips every name that a plain field would break', async () => {
  // A record is `STATUS<TAB>path`, so a name holding a tab, a newline or a control byte can
  // only be stored C-quoted, the way git itself spells such a path, and so can a name that
  // starts with a quote. Every ordinary name — a space, a backslash of its own, an accent —
  // must keep the plain spelling earlier records have, so both halves of the rule are
  // asserted here.
  const names = ['tab\there.txt', 'line\nbreak.txt', '"quoted.txt', 'back\\slash.txt', 'space name.txt', 'café.txt']
  const repo = makeRepo(Object.fromEntries(names.map((name) => [name, TWELVE_LINES])))
  const { isolation } = makePool(repo)
  const worker = TWELVE_LINES.replace('l2\n', 'l2 WORKER\n')
  const { slot, change } = await collectInCopy(isolation, (dir) => {
    for (const name of names) writeFileSync(join(dir, name), worker)
  })
  isolation.discard(slot)
  isolation.release(slot)

  const record = readRecord(isolation, change.patchId)
  assert.deepEqual(
    [...record.filesChanged].sort(),
    [
      'M\t"line\\nbreak.txt"',
      'M\t"tab\\there.txt"',
      'M\t"\\"quoted.txt"',
      'M\tback\\slash.txt',
      'M\tcafé.txt',
      'M\tspace name.txt',
    ].sort(),
  )

  // One reader for the record: the list, `files` and a section's own name agree, and every
  // name selects its own section by the plain spelling a caller sees on disk.
  const page = isolation.readPatch({ patchId: change.patchId, files: names, maxChars: 1_000_000 })
  assert.deepEqual([...page.filesChanged].sort(), [...names].sort())
  assert.deepEqual([...page.files].sort(), [...names].sort())

  const applied = isolation.apply({ patchId: change.patchId })
  assert.equal(applied.applied, true)
  assert.deepEqual([...applied.filesChanged].sort(), [...names].sort(), 'the result names the files it applied')
  assert.deepEqual(readRecord(isolation, change.patchId).appliedFiles, [...names].sort(), 'the record keeps the decoded spelling')
  for (const name of names) assert.equal(readFileSync(join(repo, name), 'utf8'), worker, `${JSON.stringify(name)} landed`)
  isolation.close()
})

test('a rename whose two names hold a space and " b/" is selectable by either name', async () => {
  // The `diff --git` header cannot be split here: git does not quote a space, so a name in a
  // directory ` b` moves the separator into the name itself. The rename lines it writes can.
  const repo = makeRepo({ 'x b/one old.txt': TWELVE_LINES, 'x b/two old.txt': TWELVE_LINES })
  const { isolation } = makePool(repo)
  const { slot, change } = await collectInCopy(isolation, (dir) => {
    mkdirSync(join(dir, 'y b'), { recursive: true })
    execFileSync('git', ['mv', 'x b/one old.txt', 'y b/one new.txt'], { cwd: dir })
    execFileSync('git', ['mv', 'x b/two old.txt', 'y b/two new.txt'], { cwd: dir })
  })
  isolation.discard(slot)
  isolation.release(slot)

  const byOld = isolation.readPatch({ patchId: change.patchId, files: ['x b/one old.txt'], maxChars: 1_000_000 })
  assert.deepEqual(byOld.files, ['y b/one new.txt'], 'the file a reader sees afterwards')
  assert.match(byOld.diff, /rename from x b\/one old\.txt/)
  const byNew = isolation.readPatch({ patchId: change.patchId, files: ['y b/two new.txt'], maxChars: 1_000_000 })
  assert.deepEqual(byNew.files, ['y b/two new.txt'])
  assert.match(byNew.diff, /rename from x b\/two old\.txt/)

  // One apply selects one file by its old name and the other by its new one.
  const applied = isolation.apply({ patchId: change.patchId, files: ['x b/one old.txt', 'y b/two new.txt'] })
  assert.equal(applied.applied, true)
  assert.deepEqual([...applied.filesChanged].sort(), ['y b/one new.txt', 'y b/two new.txt'])
  assert.equal(readFileSync(join(repo, 'y b/one new.txt'), 'utf8'), TWELVE_LINES)
  assert.equal(readFileSync(join(repo, 'y b/two new.txt'), 'utf8'), TWELVE_LINES)
  assert.equal(existsSync(join(repo, 'x b/one old.txt')), false)
  assert.deepEqual(readRecord(isolation, change.patchId).appliedFiles, ['y b/one new.txt', 'y b/two new.txt'])
  isolation.close()
})

test('a mode-only change on a path with a space is selectable', async () => {
  // `chmod +x` writes no `---`/`+++` and no rename lines, so the names can only come from
  // the header — where both halves spell the same path and equality finds the separator.
  // The path itself holds a ` b/`, which is what the last-` b/` rule trips over.
  const repo = makeRepo({ 'x b/run me.sh': '#!/bin/sh\necho one\n' })
  const { isolation } = makePool(repo)
  const { slot, change } = await collectInCopy(isolation, (dir) => chmodSync(join(dir, 'x b/run me.sh'), 0o755))
  isolation.discard(slot)
  isolation.release(slot)

  const page = isolation.readPatch({ patchId: change.patchId, maxChars: 1_000_000 })
  assert.deepEqual(page.filesChanged, ['x b/run me.sh'])
  assert.deepEqual(page.files, ['x b/run me.sh'])
  const read = isolation.readPatch({ patchId: change.patchId, files: ['x b/run me.sh'], maxChars: 1_000_000 })
  assert.deepEqual(read.files, ['x b/run me.sh'])

  const applied = isolation.apply({ patchId: change.patchId, files: ['x b/run me.sh'] })
  assert.equal(applied.applied, true)
  assert.deepEqual(applied.filesChanged, ['x b/run me.sh'])
  assert.notEqual(statSync(join(repo, 'x b/run me.sh')).mode & 0o111, 0, 'the executable bit landed')
  isolation.close()
})

test('a record written by 0.1.8 with a git-quoted field still applies under its plain name', async () => {
  const repo = makeRepo({ 'café.txt': TWELVE_LINES })
  const { isolation, stateDir } = makePool(repo)
  const worker = TWELVE_LINES.replace('l2\n', 'l2 WORKER\n')
  const { slot, change } = await collectInCopy(isolation, (dir) => writeFileSync(join(dir, 'café.txt'), worker))
  isolation.discard(slot)
  isolation.release(slot)

  // Before `-z`, a record carried git's quoted spelling — here `"caf\303\251.txt"`. Rewrite
  // the record that way, as a sibling 0.1.8 store left it, and restart the pool over it.
  const metaPath = join(isolation.patchDir, `${change.patchId}.json`)
  const record = readRecord(isolation, change.patchId)
  record.filesChanged = ['M\t"caf\\303\\251.txt"']
  writeFileSync(metaPath, `${JSON.stringify(record)}\n`)
  isolation.close()
  const reopened = reopenPool(repo, stateDir)
  try {
    const page = reopened.readPatch({ patchId: change.patchId, maxChars: 1_000_000 })
    assert.deepEqual(page.filesChanged, ['café.txt'], 'the quoted field decodes to the name on disk')
    assert.deepEqual(page.files, ['café.txt'])
    const applied = reopened.apply({ patchId: change.patchId, files: ['café.txt'] })
    assert.equal(applied.applied, true)
    assert.deepEqual(applied.filesChanged, ['café.txt'])
    assert.equal(readFileSync(join(repo, 'café.txt'), 'utf8'), worker)
    assert.deepEqual(readRecord(reopened, change.patchId).appliedFiles, ['café.txt'])
  } finally {
    reopened.close()
  }
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

test('trim ignores trash, so a large interrupted removal cannot cost an applied patch', async () => {
  // The defect this guards: `trim` walked every `trash-*` tree synchronously — the
  // event-loop freeze the sweep change exists to remove — and added its bytes to the total,
  // so it deleted applied patches to pay for disk a background removal was already freeing.
  const repo = makeRepo({ 'f.txt': 'l1\nl2\nl3\n' })
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'flash-patch-base-')))
  const isolation = new WorkspaceIsolation({ root: repo, slots: 1, baseDir: base, sweepIntervalMs: 0 })
  try {
    const { slot, change } = await collectInCopy(isolation, (dir) => {
      writeFileSync(join(dir, 'f.txt'), 'l1\nl2 WORKER\nl3\n')
    })
    isolation.release(slot)
    assert.equal(isolation.apply({ patchId: change.patchId }).applied, true)

    // A `trash-*` tree from a removal that is in flight (or one a crash left), far larger
    // than the cap below.
    const trash = join(base, rootDigest(repo), 'trash-4242-1700000000000', 'slots', 'slot-0')
    mkdirSync(trash, { recursive: true })
    writeFileSync(join(trash, 'target.bin'), 'x'.repeat(512 * 1024))

    // The cap is above the patch's own few hundred bytes and far below the trash's half
    // megabyte: with the trash counted, the applied patch was the only thing left to delete.
    isolation.maxStateBytes = 64 * 1024
    const trimmed = isolation.trim()
    assert.equal(trimmed.removedPatches, 0, 'the applied patch is kept')
    assert.equal(existsSync(change.patchPath), true)
    assert.ok(trimmed.bytes < isolation.maxStateBytes, `only the real state counts (${String(trimmed.bytes)} bytes)`)
    assert.equal(existsSync(trash), true, 'trim never deletes trash; the background removal owns it')
  } finally {
    isolation.close()
    rmSync(base, { recursive: true, force: true })
  }
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

// ── continuing from a stored patch (basePatch) ───────────────────────────────
//
// A worker that stopped partway leaves a patch. The next call can start from it: the patch
// is planted in that call's copy before the worker runs, and the change the call leaves
// behind is cumulative — it replaces the base patch for the caller's tree.

/** The plain path of every entry `collect` reported: `STATUS<TAB>path` becomes `path`. */
function plainNames(change) {
  return change.filesChanged.map((line) => line.split('\t').at(-1))
}

/** One patch record as it sits on disk. */
function readRecord(isolation, patchId) {
  return JSON.parse(readFileSync(join(isolation.patchDir, `${patchId}.json`), 'utf8'))
}

test('a base patch lands in the copy, and the collected patch holds both changes', async () => {
  const repo = makeRepo({ 'a.txt': 'a1\na2\na3\n' })
  const { isolation } = makePool(repo)
  const first = await finishedChange(isolation, (dir) => {
    writeFileSync(join(dir, 'a.txt'), 'a1 CHANGED BY A\na2\na3\n')
    writeFileSync(join(dir, 'b.txt'), 'made by A\n')
  })
  assert.deepEqual(plainNames(first).sort(), ['a.txt', 'b.txt'])

  const slot = await isolation.lease()
  const prepared = isolation.prepare(slot)
  // The base is what the *caller's* tree held, read before the base patch is planted.
  assert.deepEqual(prepared.uncommitted, { count: 0, files: [] })
  const base = isolation.applyBasePatch(slot, first.patchId)
  assert.equal(base.applied, true)
  assert.equal(base.threeWay, false)
  assert.deepEqual(base.conflicts, [])
  assert.deepEqual(base.filesChanged.sort(), ['a.txt', 'b.txt'])
  // The copy holds A's change before the worker starts...
  assert.equal(readFileSync(join(slot.dir, 'a.txt'), 'utf8'), 'a1 CHANGED BY A\na2\na3\n')
  assert.equal(readFileSync(join(slot.dir, 'b.txt'), 'utf8'), 'made by A\n')
  // ...and the caller's tree does not.
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'a1\na2\na3\n')
  assert.equal(existsSync(join(repo, 'b.txt')), false)
  assert.equal(gitOut(repo, 'status', '--porcelain'), '')

  writeFileSync(join(slot.dir, 'a.txt'), 'a1 CHANGED BY A\na2 CHANGED BY B\na3\n')
  writeFileSync(join(slot.dir, 'c.txt'), 'made by B\n')
  const change = isolation.collect(slot)
  assert.equal(change.available, true)
  assert.deepEqual(plainNames(change).sort(), ['a.txt', 'b.txt', 'c.txt'])
  const stored = isolation.readPatch({ patchId: change.patchId, maxChars: 1_000_000 })
  assert.match(stored.diff, /a1 CHANGED BY A/)
  assert.match(stored.diff, /made by A/)
  assert.match(stored.diff, /made by B/)

  // The base patch reached a throwaway tree, so its record is not marked applied: it is
  // still the caller's to apply, or to supersede by applying this cumulative one.
  assert.equal(readRecord(isolation, first.patchId).appliedAt, null)
  isolation.discard(slot)
  isolation.release(slot)
  isolation.close()
})

test('a base patch three-way merges into the copy when the caller tree moved on nearby', async () => {
  const repo = makeRepo({ 'f.txt': 'l1\nl2\nl3\nl4\nl5\nl6\n' })
  const { isolation } = makePool(repo)
  const first = await finishedChange(isolation, (dir) => {
    writeFileSync(join(dir, 'f.txt'), 'l1\nl2 WORKER\nl3\nl4\nl5\nl6\n')
  })
  // Another session commits a neighbouring line of the same file, so the patch's context no
  // longer matches and only a merge can land it.
  writeFileSync(join(repo, 'f.txt'), 'l1\nl2\nl3\nl4 ROOT\nl5\nl6\n')
  commit(repo, 'the caller moves on')

  const slot = await isolation.lease()
  isolation.prepare(slot)
  const base = isolation.applyBasePatch(slot, first.patchId)
  assert.equal(base.threeWay, true)
  assert.deepEqual(base.conflicts, [])
  assert.equal(readFileSync(join(slot.dir, 'f.txt'), 'utf8'), 'l1\nl2 WORKER\nl3\nl4 ROOT\nl5\nl6\n')
  assert.equal(readRecord(isolation, first.patchId).appliedAt, null, 'the merge into the copy records nothing')
  isolation.discard(slot)
  isolation.release(slot)
  isolation.close()
})

test('a conflicting base patch leaves markers in the copy and is never recorded as applied', async () => {
  const repo = makeRepo({ 'f.txt': 'l1\nl2\nl3\nl4\n' })
  const { isolation } = makePool(repo)
  const first = await finishedChange(isolation, (dir) => writeFileSync(join(dir, 'f.txt'), 'l1\nl2 WORKER\nl3\nl4\n'))
  writeFileSync(join(repo, 'f.txt'), 'l1\nl2 ROOT\nl3\nl4\n')
  commit(repo, 'the caller takes the same line')

  const slot = await isolation.lease()
  isolation.prepare(slot)
  const base = isolation.applyBasePatch(slot, first.patchId)
  assert.equal(base.threeWay, true)
  assert.deepEqual(base.conflicts, ['f.txt'])
  const copy = readFileSync(join(slot.dir, 'f.txt'), 'utf8')
  assert.match(copy, /<<<<<<< /)
  assert.match(copy, /WORKER/)
  assert.match(copy, /ROOT/)
  // A conflict in the copy is not an error and not an apply into the caller's tree.
  assert.equal(readRecord(isolation, first.patchId).appliedAt, null)
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), 'l1\nl2 ROOT\nl3\nl4\n')
  assert.equal(gitOut(repo, 'status', '--porcelain'), '')
  isolation.discard(slot)
  isolation.release(slot)
  isolation.close()
})

test('a base patch that is unknown, foreign, or from another scope is refused', async () => {
  const repo = makeRepo({ 'README.md': '# project\n' })
  const sub = join(repo, 'sub')
  mkdirSync(sub)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: sub })
  writeFileSync(join(sub, 'inner.txt'), 'inner\n')
  commit(sub, 'inner')
  commit(repo, 'add sub')
  const { isolation } = makePool(repo)
  const scoped = await finishedChange(isolation, (dir) => writeFileSync(join(dir, 'other.txt'), 'root work\n'))
  const nestedSlot = await isolation.lease()
  isolation.prepare(nestedSlot, { cwd: sub })
  writeFileSync(join(nestedSlot.dir, 'sub', 'inner.txt'), 'inner changed\n')
  const nestedChange = isolation.collect(nestedSlot)
  isolation.discard(nestedSlot)
  isolation.release(nestedSlot)
  // A record naming another repository, as a shared patch directory can hold.
  const foreignId = `flash-${randomUUID()}`
  storeRawPatch(isolation, foreignId, 'diff --git a/x b/x\n', [], { root: join(tmpdir(), 'flash-elsewhere') })

  const slot = await isolation.lease()
  isolation.prepare(slot)
  assert.throws(
    () => isolation.applyBasePatch(slot, `flash-${randomUUID()}`),
    (error) => /no patch .* is held by this service/.test(error.message),
  )
  assert.throws(
    () => isolation.applyBasePatch(slot, foreignId),
    (error) => /was computed for .*not for/.test(error.message),
  )
  assert.throws(
    () => isolation.applyBasePatch(slot, nestedChange.patchId),
    (error) =>
      /was computed for the repository sub/.test(error.message) &&
      /this call's cwd resolves to the service root/.test(error.message) &&
      /same repository as the call/.test(error.message),
  )
  // A refusal leaves the copy exactly as `prepare` left it: no patch was planted.
  assert.equal(readFileSync(join(slot.dir, 'README.md'), 'utf8'), '# project\n')
  assert.equal(existsSync(join(slot.dir, 'other.txt')), false, 'the refused patches were not applied')
  isolation.discard(slot)
  isolation.release(slot)
  isolation.close()
})

test('source "head" resets first, then the base patch lands on top', async () => {
  const repo = makeRepo({ 'f.txt': 'l1\nl2\nl3\nl4\n' })
  const { isolation } = makePool(repo)
  const first = await finishedChange(isolation, (dir) => writeFileSync(join(dir, 'f.txt'), 'l1\nl2 FROM A\nl3\nl4\n'))
  // The caller's tree is dirty with work the call must not pick up; HEAD still holds the
  // state the base patch was computed from.
  writeFileSync(join(repo, 'f.txt'), 'l1\nl2 CALLER DIRTY\nl3\nl4\n')
  writeFileSync(join(repo, 'untracked.txt'), 'caller only\n')

  const slot = await isolation.lease()
  const prepared = isolation.prepare(slot, { source: 'head' })
  // The reset happens first, so the base patch is the only uncommitted change in the copy.
  assert.deepEqual(prepared.uncommitted, { count: 0, files: [] })
  const base = isolation.applyBasePatch(slot, first.patchId)
  assert.equal(base.applied, true)
  assert.equal(readFileSync(join(slot.dir, 'f.txt'), 'utf8'), 'l1\nl2 FROM A\nl3\nl4\n')
  assert.equal(existsSync(join(slot.dir, 'untracked.txt')), false, 'the reset still leaves the caller’s work out')

  const change = isolation.collect(slot)
  assert.deepEqual(plainNames(change), ['f.txt'], 'measured from HEAD, so it is the base patch alone')
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), 'l1\nl2 CALLER DIRTY\nl3\nl4\n', 'the caller’s tree is untouched')
  assert.equal(readFileSync(join(repo, 'untracked.txt'), 'utf8'), 'caller only\n')
  isolation.discard(slot)
  isolation.release(slot)
  isolation.close()
})

test('ignored files a base patch creates are part of the copy’s state, not the worker’s', async () => {
  const repo = makeRepo({ '.gitignore': 'dist/\n', 'README.md': '# project\n' })
  const { isolation } = makePool(repo)
  // `collect` cannot store an ignored file, so this patch is written the way a record from a
  // repository whose ignore rules differ could hold one.
  const source = realpathSync(mkdtempSync(join(tmpdir(), 'flash-base-ignored-')))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: source })
  mkdirSync(join(source, 'dist'))
  writeFileSync(join(source, 'dist', 'out.js'), 'built\n')
  execFileSync('git', ['add', '-A'], { cwd: source })
  const patchId = `flash-${randomUUID()}`
  storeRawPatch(isolation, patchId, gitOut(source, 'diff', '--cached', '--binary'), ['A\tdist/out.js'])

  const slot = await isolation.lease()
  isolation.prepare(slot)
  isolation.applyBasePatch(slot, patchId)
  assert.equal(readFileSync(join(slot.dir, 'dist', 'out.js'), 'utf8'), 'built\n')
  const change = isolation.collect(slot)
  // Without a refreshed baseline this reads as "the worker created a path git ignores".
  assert.deepEqual(change.ignored, [])
  isolation.discard(slot)
  isolation.release(slot)
  isolation.close()
})

test('flash_task continues from a base patch and stores one cumulative change', async () => {
  const repo = makeRepo({ 'a.txt': 'a1\na2\na3\n' })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-base-svc-')))
  const first = makeIsoService({ root: repo, stateDir, writes: { 'a.txt': 'a1 FROM A\na2\na3\n', 'b.txt': 'made by A\n' } })
  const done = await first.service.flashTask({ task: 'first half', cwd: repo })
  assert.equal(done.change.available, true)
  assert.deepEqual([...done.change.filesChanged].sort(), ['a.txt', 'b.txt'])
  await first.service.close()

  const second = makeIsoService({ root: repo, stateDir, writes: { 'c.txt': 'made by B\n' } })
  const result = await second.service.flashTask({ task: 'the rest', cwd: repo, basePatch: done.change.patchId })

  assert.equal(result.basePatch.patchId, done.change.patchId)
  assert.equal(result.basePatch.applied, true)
  assert.equal(result.basePatch.threeWay, false)
  assert.deepEqual(result.basePatch.conflicts, [])
  assert.match(result.basePatch.note, /cumulative/)
  // The call's own patch holds A's change and B's, and replaces the base patch.
  assert.deepEqual([...result.change.filesChanged].sort(), ['a.txt', 'b.txt', 'c.txt'])
  const stored = second.service.flashPatch({ patchId: result.change.patchId, maxChars: 1_000_000 })
  assert.match(stored.diff, /a1 FROM A/)
  assert.match(stored.diff, /made by A/)
  assert.match(stored.diff, /made by B/)
  assert.notEqual(result.change.patchId, done.change.patchId)
  // The caller's tree was never touched, and the base patch's files are not its work in progress.
  assert.equal(result.isolation.uncommittedAtStart, undefined)
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'a1\na2\na3\n')
  assert.equal(existsSync(join(repo, 'b.txt')), false)
  assert.equal(existsSync(join(repo, 'c.txt')), false)
  assert.equal(gitOut(repo, 'status', '--porcelain'), '')
  // The base patch is still the caller's to apply.
  assert.equal(readRecord(second.service.isolation, done.change.patchId).appliedAt, null)

  // The worker is told what the copy already holds, and to continue rather than redo it.
  const prompt = second.client.prompts[0].text
  assert.match(prompt, new RegExp(`The copy already contains the change from an earlier call \\(patch ${done.change.patchId}\\), applied before you started: a\\.txt, b\\.txt\\. Continue from it; do not redo it\\.`))
  assert.doesNotMatch(prompt, /It did not apply cleanly/)
  await second.service.close()
})

test('a conflicting base patch names the file in the result and tells the worker to resolve it', async () => {
  const repo = makeRepo({ 'f.txt': 'l1\nl2\nl3\nl4\n' })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-base-conflict-')))
  const first = makeIsoService({ root: repo, stateDir, writes: { 'f.txt': 'l1\nl2 FROM A\nl3\nl4\n' } })
  const done = await first.service.flashTask({ task: 'first half', cwd: repo })
  await first.service.close()
  writeFileSync(join(repo, 'f.txt'), 'l1\nl2 FROM CALLER\nl3\nl4\n')
  commit(repo, 'caller takes the line')

  const second = makeIsoService({ root: repo, stateDir, writes: { 'g.txt': 'new work\n' } })
  const result = await second.service.flashTask({ task: 'the rest', cwd: repo, basePatch: done.change.patchId })

  assert.equal(result.basePatch.threeWay, true)
  assert.deepEqual(result.basePatch.conflicts, ['f.txt'])
  assert.match(second.client.prompts[0].text, /It did not apply cleanly: f\.txt hold conflict markers\. Resolve them first\./)
  // The conflict is inside the copy and reaches the caller only through the cumulative patch.
  const stored = second.service.flashPatch({ patchId: result.change.patchId, maxChars: 1_000_000 })
  assert.match(stored.diff, /<<<<<<< /)
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), 'l1\nl2 FROM CALLER\nl3\nl4\n')
  await second.service.close()
})

test('flash_batch continues every member from the same base patch', async () => {
  const repo = makeRepo({ 'a.txt': 'a1\n' })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-base-batch-')))
  const first = makeIsoService({ root: repo, stateDir, writes: { 'a.txt': 'a1 FROM A\n' } })
  const done = await first.service.flashTask({ task: 'first half', cwd: repo })
  await first.service.close()

  const second = makeIsoService({ root: repo, stateDir, writes: { 'b.txt': 'made by the fleet\n' } })
  const result = await second.service.flashBatch({ tasks: ['one', 'two'], cwd: repo, basePatch: done.change.patchId })

  assert.equal(result.basePatch.patchId, done.change.patchId)
  assert.equal(result.basePatch.applied, true)
  // One copy, one collect: the fleet's change is cumulative too.
  assert.deepEqual([...result.change.filesChanged].sort(), ['a.txt', 'b.txt'])
  // Every member's prompt carries the paragraph, since they share the copy.
  assert.equal(second.client.prompts[0].text.match(/The copy already contains the change from an earlier call/g)?.length, 2)
  assert.equal(readRecord(second.service.isolation, done.change.patchId).appliedAt, null)
  await second.service.close()
})

test('a read-only call cannot continue from a base patch', async () => {
  const repo = makeRepo({ 'a.txt': 'a1\n' })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-base-readonly-')))
  const { service } = makeIsoService({ root: repo, stateDir })
  const patchId = `flash-${randomUUID()}`
  await assert.rejects(
    service.flashTask({ task: 'x', cwd: repo, mode: 'read-only', basePatch: patchId }),
    (error) => error instanceof FlashTaskError && error.code === 'BASE_PATCH_UNAVAILABLE' && /read-only/.test(error.message),
  )
  await assert.rejects(
    service.flashBatch({ tasks: ['x'], cwd: repo, mode: 'read-only', basePatch: patchId }),
    (error) => error instanceof FlashTaskError && error.code === 'BASE_PATCH_UNAVAILABLE' && /read-only/.test(error.message),
  )
  await service.close()
})

test('the uncommitted-at-start list describes the caller’s tree, not the base patch', async () => {
  const repo = makeRepo({ 'a.txt': 'a1\n', 'mine.txt': 'committed\n' })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-base-dirty-')))
  const first = makeIsoService({ root: repo, stateDir, writes: { 'b.txt': 'made by A\n' } })
  const done = await first.service.flashTask({ task: 'first half', cwd: repo })
  await first.service.close()
  // The caller is mid-edit on a different file when the next call continues from A's patch.
  writeFileSync(join(repo, 'mine.txt'), 'caller edit\n')

  const second = makeIsoService({ root: repo, stateDir, writes: { 'c.txt': 'made by B\n' } })
  const result = await second.service.flashTask({ task: 'the rest', cwd: repo, basePatch: done.change.patchId })

  // The base patch's b.txt is the copy's state, not the caller's work in progress.
  assert.deepEqual(result.isolation.uncommittedAtStart, { count: 1, files: ['mine.txt'] })
  assert.deepEqual([...result.change.filesChanged].sort(), ['b.txt', 'c.txt'])
  assert.match(second.client.prompts[0].text, /started with 1 uncommitted change\(s\)/)
  assert.doesNotMatch(second.client.prompts[0].text, /- b\.txt/)
  await second.service.close()
})

test('a base patch that cannot be applied is refused before the worker, and the slot is freed', async () => {
  const repo = makeRepo({ 'a.txt': 'a1\n' })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-base-early-')))
  const { service, client } = makeIsoService({ root: repo, stateDir })

  await assert.rejects(
    service.flashTask({ task: 'x', cwd: repo, basePatch: `flash-${randomUUID()}` }),
    (error) => error instanceof FlashTaskError && error.code === 'BASE_PATCH_UNAVAILABLE' && /no patch/.test(error.message),
  )
  assert.equal(client.prompts.length, 0, 'the worker was never started')
  assert.equal(service.isolation.inUse, 0, 'the tree went back to the pool as on any other early failure')
  await service.close()
})

test('a base patch with no saved blobs fails the call, naming it and offering a way forward', async () => {
  const repo = makeRepo({ 'f.txt': 'l1\nl2\nl3\nl4\n' })
  const { isolation } = makePool(repo)
  const patchId = `flash-${randomUUID()}`
  // A record from before blobs were saved, and a patch whose context no longer matches, so
  // only the three-way merge could land it — and it has no base to merge against.
  const diff = 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n l1\n-l2 OLD\n+l2 NEW\n'
  storeRawPatch(isolation, patchId, diff, ['M\tf.txt'])

  const slot = await isolation.lease()
  isolation.prepare(slot)
  assert.throws(
    () => isolation.applyBasePatch(slot, patchId),
    (error) =>
      error.message.includes(patchId) &&
      /not available for a three-way merge/.test(error.message) &&
      /source: "head"/.test(error.message) &&
      /flash_apply/.test(error.message),
  )
  isolation.discard(slot)
  isolation.release(slot)
  isolation.close()
})

// ── short patch ids ─────────────────────────────────────────────────────────

test('an eight-hex prefix, with or without flash-, names the patch it starts', async () => {
  const repo = makeRepo({ 'f.txt': 'one\n' })
  const { isolation } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => writeFileSync(join(dir, 'worker.txt'), 'work\n'))
  const uuid = change.patchId.slice('flash-'.length)
  const short = uuid.slice(0, 8)
  // A report quotes the first eight digits; a person may paste the uuid's first group too.
  for (const patchId of [short, `flash-${short}`, `flash-${uuid.slice(0, 13)}`]) {
    const page = isolation.readPatch({ patchId, maxChars: 1_000_000 })
    assert.equal(page.patchId, change.patchId, `${patchId} must resolve to the full id`)
    assert.match(page.diff, /work/)
  }

  const applied = isolation.apply({ patchId: short })
  assert.equal(applied.applied, true)
  assert.equal(applied.patchId, change.patchId, 'the result names the full id, not the prefix')
  assert.equal(readFileSync(join(repo, 'worker.txt'), 'utf8'), 'work\n')
  isolation.close()
})

test('a prefix two stored patches share is refused, naming both full ids', () => {
  const repo = makeRepo({ 'README.md': '# project\n' })
  const { isolation } = makePool(repo)
  // The first eight hex digits are the whole prefix, so these two are indistinguishable
  // until more of the id is given.
  const shared = 'abcdef12'
  const firstId = `flash-${shared}-1111-4111-8111-111111111111`
  const secondId = `flash-${shared}-2222-4222-8222-222222222222`
  storeRawPatch(isolation, firstId, 'diff --git a/x b/x\n', ['A\tx'], { base: 'base' })
  storeRawPatch(isolation, secondId, 'diff --git a/x b/x\n', ['A\tx'], { base: 'base' })

  assert.throws(
    () => isolation.apply({ patchId: shared }),
    (error) =>
      /patchId "abcdef12" matches 2 stored patches/.test(error.message) &&
      error.message.includes(firstId) &&
      error.message.includes(secondId) &&
      /give more of the id/.test(error.message),
  )
  assert.throws(() => isolation.readPatch({ patchId: `flash-${shared}`, maxChars: 1000 }), /matches 2 stored patches/)
  isolation.close()
})

test('a short id is checked before any path is built, and a malformed one is refused', () => {
  const repo = makeRepo({ 'README.md': '# project\n' })
  const { isolation } = makePool(repo)
  // Seven hex digits are too few, a non-hex character is not an id, and a path fragment
  // must never reach a `join()`.
  for (const patchId of ['abcdef1', 'flash-abcdef1', 'abcdefg1', '../x', 'flash-../x', 'flash-abcd-ef12']) {
    assert.throws(
      () => isolation.readPatch({ patchId, maxChars: 1000 }),
      (error) =>
        /is not an id this service issues/.test(error.message) &&
        /unique prefix of at least 8 hex digits/.test(error.message),
      `${patchId} must be refused as malformed`,
    )
    assert.throws(() => isolation.apply({ patchId }), /is not an id this service issues/)
  }
  isolation.close()
})

test('a matching record from another root neither resolves a prefix nor makes one ambiguous', async () => {
  const repo = makeRepo({ 'f.txt': 'one\n' })
  const { isolation } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => writeFileSync(join(dir, 'worker.txt'), 'work\n'))
  const short = change.patchId.slice('flash-'.length, 'flash-'.length + 8)
  // A sibling service stored a record with the same prefix for a different repository.
  const foreignId = `flash-${short}-9999-4999-8999-999999999999`
  storeRawPatch(isolation, foreignId, 'diff --git a/x b/x\n', [], { root: join(tmpdir(), 'flash-elsewhere') })
  assert.equal(
    isolation.readPatch({ patchId: short, maxChars: 1_000_000 }).patchId,
    change.patchId,
    'the foreign record must not count toward ambiguity',
  )

  // A prefix only a foreign record matches is "no patch", never another root's patch.
  const foreignOnly = `flash-deadbeef-9999-4999-8999-999999999999`
  storeRawPatch(isolation, foreignOnly, 'diff --git a/x b/x\n', [], { root: join(tmpdir(), 'flash-elsewhere') })
  assert.throws(() => isolation.readPatch({ patchId: 'deadbeef', maxChars: 1000 }), /no patch deadbeef is held/)
  assert.throws(() => isolation.apply({ patchId: 'deadbeef' }), /no patch deadbeef is held/)
  isolation.close()
})

// ── the task that made a patch, and the worker's final report ───────────────

test('a collected patch’s record holds the task that made it', async () => {
  const repo = makeRepo({ 'f.txt': 'one\n' })
  const { isolation } = makePool(repo)
  const label =
    'Repair the Windows installer cache so every worker sees the vendored OpenSSL and the pinned MSVC toolchain ' +
    'without repeating the two variables in every brief'
  assert.ok(label.length > 150, 'a real task label, not a placeholder')
  const sessionId = `sess-${'a'.repeat(140)}`
  const taskFile = `/tasks/${'installer-cache/'.repeat(80)}task.md`
  const slot = await isolation.lease()
  isolation.prepare(slot, {
    task: { kind: 'flash_task', label: `  ${label}  `, sessionId, jobId: 'job-7', taskFile, unsupported: 'dropped' },
  })
  // The copy carries the task in its own git directory, and git does not see the file there.
  const inCopy = JSON.parse(readFileSync(join(slot.dir, '.git', 'flash-task.json'), 'utf8'))
  assert.equal(inCopy.label, label, 'the label is trimmed')
  assert.equal(inCopy.kind, 'flash_task')
  assert.equal(inCopy.sessionId.length, 100, 'ids are cut to 100 characters')
  assert.equal(inCopy.taskFile.length, 1024, 'taskFile is cut to 1,024 characters')
  assert.equal(inCopy.unsupported, undefined)
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: slot.dir, encoding: 'utf8' }), '', 'the task file is not the worker’s change')

  writeFileSync(join(slot.dir, 'worker.txt'), 'work\n')
  const change = isolation.collect(slot)
  assert.equal(change.available, true)
  const meta = readRecord(isolation, change.patchId)
  assert.deepEqual(meta.task, inCopy)
  // Every path that reads the patch back says whose work it was.
  assert.deepEqual(isolation.listPatches().find((record) => record.patchId === change.patchId).task, meta.task)
  assert.deepEqual(isolation.readPatch({ patchId: change.patchId, maxChars: 1_000_000 }).task, meta.task)
  assert.deepEqual(isolation.apply({ patchId: change.patchId }).task, meta.task)
  isolation.close()
})

test('a task without a label is ignored, so the record keeps its ordinary shape', async () => {
  const repo = makeRepo({ 'f.txt': 'one\n' })
  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot, { task: { kind: 'flash_task', label: '   ', sessionId: 'sess-1' } })
  assert.equal(existsSync(join(slot.dir, '.git', 'flash-task.json')), false)
  writeFileSync(join(slot.dir, 'a.txt'), 'a\n')
  const change = isolation.collect(slot)
  assert.equal(readRecord(isolation, change.patchId).task, undefined)
  isolation.close()
})

test('a record without a task, as 0.1.6 wrote it, is still read and applied', async () => {
  const repo = makeRepo({ 'f.txt': 'one\n' })
  const { isolation, stateDir } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot, { task: { kind: 'flash_task', label: 'made before the field existed' } })
  writeFileSync(join(slot.dir, 'old.txt'), 'old work\n')
  const change = isolation.collect(slot)
  // Rewrite the record to the shape a version before `task` persisted.
  const metaPath = join(isolation.patchDir, `${change.patchId}.json`)
  const oldShape = JSON.parse(readFileSync(metaPath, 'utf8'))
  delete oldShape.task
  writeFileSync(metaPath, `${JSON.stringify(oldShape, null, 2)}\n`)
  isolation.close()

  const next = new WorkspaceIsolation({ root: repo, slots: 1, stateDir })
  try {
    const page = next.readPatch({ patchId: change.patchId, maxChars: 1_000_000 })
    assert.equal(page.task, undefined)
    assert.equal(page.finalMessage, undefined)
    const applied = next.apply({ patchId: change.patchId })
    assert.equal(applied.applied, true)
    assert.equal(applied.task, undefined)
    assert.equal(readFileSync(join(repo, 'old.txt'), 'utf8'), 'old work\n')
  } finally {
    next.close()
  }
})

test('annotatePatch stores the final report, truncates it, and survives a restart', async () => {
  const repo = makeRepo({ 'README.md': '# project\n' })
  const { isolation, stateDir } = makePool(repo)
  const { change } = await collectInCopy(isolation, (dir) => writeFileSync(join(dir, 'worker.txt'), 'work\n'))
  const message = 'The worker replaced the vendored OpenSSL build and reran the installer suite. '.repeat(120)
  assert.ok(message.length > 8000, 'a report longer than one record keeps')
  isolation.annotatePatch(change.patchId, { finalMessage: message })

  const truncated = message.slice(0, 8000)
  const held = isolation.listPatches().find((record) => record.patchId === change.patchId)
  assert.equal(held.finalMessage, truncated)
  assert.equal(held.finalMessageTruncated, true)
  const meta = readRecord(isolation, change.patchId)
  assert.equal(meta.finalMessage, truncated)
  assert.equal(meta.finalMessageTruncated, true)

  // Page 0 carries the report; a later page does not, so paging a patch stays cheap.
  const page0 = isolation.readPatch({ patchId: change.patchId, maxChars: 80 })
  assert.equal(page0.finalMessage, truncated)
  assert.equal(page0.finalMessageTruncated, true)
  assert.ok(page0.nextOffset > 0)
  const later = isolation.readPatch({ patchId: change.patchId, offset: page0.nextOffset, maxChars: 80 })
  assert.equal(later.finalMessage, undefined)
  assert.equal(later.finalMessageTruncated, undefined)

  // A fresh pool loading the store sees what the first one wrote.
  isolation.close()
  const next = new WorkspaceIsolation({ root: repo, slots: 1, stateDir })
  try {
    const reloaded = next.listPatches().find((record) => record.patchId === change.patchId)
    assert.equal(reloaded.finalMessage, truncated)
    assert.equal(reloaded.finalMessageTruncated, true)
    assert.equal(next.readPatch({ patchId: change.patchId, maxChars: 1_000_000 }).finalMessage, truncated)
  } finally {
    next.close()
  }
})

test('annotatePatch refuses an unknown or foreign id, and does not rewrite that record', () => {
  const repo = makeRepo({ 'README.md': '# project\n' })
  const { isolation } = makePool(repo)
  assert.throws(() => isolation.annotatePatch(`flash-${randomUUID()}`, { finalMessage: 'x' }), /no patch .* is held by this service/)
  const foreignId = `flash-${randomUUID()}`
  storeRawPatch(isolation, foreignId, 'diff --git a/x b/x\n', [], { root: join(tmpdir(), 'flash-elsewhere') })
  assert.throws(() => isolation.annotatePatch(foreignId, { finalMessage: 'x' }), /computed for/)
  const foreign = JSON.parse(readFileSync(join(isolation.patchDir, `${foreignId}.json`), 'utf8'))
  assert.equal(foreign.finalMessage, undefined)
  isolation.close()
})
