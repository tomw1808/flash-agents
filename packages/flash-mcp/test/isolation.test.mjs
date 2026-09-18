/**
 * Contract tests for workspace isolation.
 *
 * These run against real temporary directories and a real `git`, because the
 * properties being checked are properties of the filesystem and of the patch that
 * git computes — not of a stub. The claims under test are the ones the service's
 * safety story rests on:
 *
 *   * a worker's writes land in a copy, never in the caller's tree;
 *   * the copy starts from the caller's *working tree*, uncommitted edits included;
 *   * what comes back is a patch, and the caller's tree changes only when it is
 *     applied;
 *   * a wrecked tree is not a wrecked repository, and the next call starts clean.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { test } from 'node:test'

import { WorkspaceIsolation, canonicalTmpdir } from '../lib/isolation.js'

/** A throwaway repository, realpath'd so macOS `/var` vs `/private/var` cannot bite. */
function makeRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-iso-')))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# project\n')
  writeFileSync(join(dir, 'keep.txt'), 'keep me\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: dir })
  return dir
}

/** One isolation pool over a repository, plus a place for its state. */
function makePool(repo, slots = 2) {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-iso-state-')))
  const isolation = new WorkspaceIsolation({ root: repo, slots, stateDir })
  return { isolation, stateDir }
}

/**
 * Lay out a dead owner's per-pid directory with one slot tree under `repo`'s default
 * layout, and return the paths so a test can populate the tree.
 *
 * A throwaway default-layout pool is constructed only to learn where the layout keeps
 * per-pid directories for this root; it is closed before the dead owner is created.
 *
 * @param {string} repo - the service root.
 * @param {object} [options] - dead owner pid and slot name.
 * @returns {{owner: string, parent: string, slotDir: string}} the dead owner paths.
 */
function makeDeadOwner(repo, { pid = 4194303, slot = 'slot-0' } = {}) {
  const anchor = new WorkspaceIsolation({ root: repo, slots: 1 })
  const parent = dirname(dirname(anchor.stateDir))
  anchor.close()
  const owner = join(parent, String(pid))
  const slotDir = join(owner, 'slots', slot)
  mkdirSync(slotDir, { recursive: true })
  return { owner, parent, slotDir }
}

/** Make `dir` a git tree sitting on a `flash base` commit, exactly as `prepare` leaves one. */
function makeFlashBaseTree(dir) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# project\n')
  writeFileSync(join(dir, 'keep.txt'), 'keep me\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'flash base'], { cwd: dir })
}

/** A patch record this instance holds that came from a sweep rather than from `collect`. */
function salvagedPatch(isolation) {
  return isolation.listPatches().find((record) => record.salvagedFrom !== undefined)
}

test('a worker writes into a copy, and the caller’s tree is untouched', async () => {
  const repo = makeRepo()
  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot)

  writeFileSync(join(slot.dir, 'worker.txt'), 'made by the worker\n')
  writeFileSync(join(slot.dir, 'keep.txt'), 'the worker rewrote this\n')
  rmSync(join(slot.dir, 'README.md'))

  const change = isolation.collect(slot)
  assert.equal(change.available, true)
  assert.deepEqual(
    change.filesChanged.map((line) => line.split('\t').at(-1)).sort(),
    ['README.md', 'keep.txt', 'worker.txt'],
  )
  assert.match(change.diff, /made by the worker/)

  // The caller's tree saw none of it.
  assert.equal(existsSync(join(repo, 'worker.txt')), false)
  assert.equal(readFileSync(join(repo, 'keep.txt'), 'utf8'), 'keep me\n')
  assert.equal(existsSync(join(repo, 'README.md')), true)

  // …until the patch is applied, which is the only path back.
  const applied = isolation.apply({ patchId: change.patchId })
  assert.equal(applied.applied, true)
  assert.equal(readFileSync(join(repo, 'worker.txt'), 'utf8'), 'made by the worker\n')
  assert.equal(readFileSync(join(repo, 'keep.txt'), 'utf8'), 'the worker rewrote this\n')
  assert.equal(existsSync(join(repo, 'README.md')), false)
  isolation.close()
})

test('the copy starts from the working tree, uncommitted edits included', async () => {
  const repo = makeRepo()
  writeFileSync(join(repo, 'keep.txt'), 'edited but not committed\n')
  writeFileSync(join(repo, 'untracked.txt'), 'never added\n')
  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot)

  // What the worker sees is what the caller has, not what the caller committed.
  assert.equal(readFileSync(join(slot.dir, 'keep.txt'), 'utf8'), 'edited but not committed\n')
  assert.equal(readFileSync(join(slot.dir, 'untracked.txt'), 'utf8'), 'never added\n')

  // And the diff is the worker's contribution alone: the caller's dirt is the base.
  writeFileSync(join(slot.dir, 'worker.txt'), 'x\n')
  const change = isolation.collect(slot)
  assert.deepEqual(change.filesChanged.map((line) => line.split('\t').at(-1)), ['worker.txt'])
  isolation.close()
})

test('a wrecked tree leaves the repository intact, and the next call starts clean', async () => {
  const repo = makeRepo()
  const { isolation } = makePool(repo, 1)
  const first = await isolation.lease()
  isolation.prepare(first)
  writeFileSync(join(first.dir, 'junk.txt'), 'junk\n')
  rmSync(join(first.dir, 'README.md'))
  isolation.release(first)

  // The same slot, reused: it must look exactly like the caller's tree again, so a
  // second worker cannot see the first one's leftovers.
  const second = await isolation.lease()
  assert.equal(second.id, first.id)
  isolation.prepare(second)
  assert.equal(existsSync(join(second.dir, 'junk.txt')), false)
  assert.equal(existsSync(join(second.dir, 'README.md')), true)
  assert.equal(existsSync(join(repo, 'junk.txt')), false)
  assert.equal(existsSync(join(repo, 'README.md')), true)
  isolation.close()
})

test('retiring a tree keeps it in place and moves the slot to a fresh directory', async () => {
  const repo = makeRepo()
  const { isolation } = makePool(repo, 1)
  const slot = await isolation.lease()
  isolation.prepare(slot)

  // The session that ran here holds the tree's path as an absolute string and may still
  // be writing, so the orphan must keep its name and its contents.
  writeFileSync(join(slot.dir, 'worker.txt'), 'still being written\n')
  const first = slot.dir
  isolation.retire(slot)

  assert.equal(existsSync(first), true, 'the orphaned tree stays at its original path')
  assert.equal(readFileSync(join(first, 'worker.txt'), 'utf8'), 'still being written\n')
  assert.deepEqual(slot.orphans, [first], 'the orphan is remembered so close() removes it')
  // The slot itself points at a fresh directory it has never used, and it is empty.
  assert.notEqual(slot.dir, first)
  assert.deepEqual(readdirSync(slot.dir), [])

  // A second retire yields a third distinct path, and keeps the second orphan too.
  isolation.prepare(slot)
  writeFileSync(join(slot.dir, 'second.txt'), 'second\n')
  const second = slot.dir
  isolation.retire(slot)
  assert.notEqual(second, first)
  assert.notEqual(slot.dir, second)
  assert.deepEqual(slot.orphans, [first, second])
  assert.equal(existsSync(second), true)

  // close() removes the current tree and every orphan it left behind.
  isolation.close()
  assert.equal(existsSync(first), false)
  assert.equal(existsSync(second), false)
  assert.equal(existsSync(slot.dir), false)
})

test('one slot is held by one call at a time, and waiters are served in order', async () => {
  const repo = makeRepo()
  const { isolation } = makePool(repo, 1)
  const first = await isolation.lease()

  let secondResolved = false
  const second = isolation.lease().then((slot) => {
    secondResolved = true
    return slot
  })
  // Nothing else can have the tree while the first call holds it.
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(secondResolved, false)

  isolation.release(first)
  const leased = await second
  assert.equal(secondResolved, true)
  assert.equal(leased.id, first.id)
  assert.equal(leased.busy, true)
  isolation.close()
})

test('a caller working directory maps into the slot', async () => {
  const repo = makeRepo()
  mkdirSync(join(repo, 'packages', 'inner'), { recursive: true })
  writeFileSync(join(repo, 'packages', 'inner', 'file.txt'), 'x\n')
  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot)
  assert.equal(isolation.slotCwd(slot, repo), slot.dir)
  assert.equal(isolation.slotCwd(slot, join(repo, 'packages', 'inner')), join(slot.dir, 'packages', 'inner'))
  assert.equal(existsSync(join(isolation.slotCwd(slot, join(repo, 'packages', 'inner')), 'file.txt')), true)
  isolation.close()
})

test('a root without git is still isolated, and says why there is no diff', async () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'flash-iso-plain-')))
  writeFileSync(join(plain, 'data.txt'), 'original\n')
  const { isolation } = makePool(plain)
  const slot = await isolation.lease()
  const prepared = isolation.prepare(slot)
  assert.equal(prepared.base, null)
  assert.match(prepared.reason, /not a git repository/)

  writeFileSync(join(slot.dir, 'data.txt'), 'changed in the copy\n')
  const change = isolation.collect(slot)
  assert.equal(change.available, false)
  assert.match(change.reason, /not a git repository/)
  assert.equal(readFileSync(join(plain, 'data.txt'), 'utf8'), 'original\n')
  isolation.close()
})

test('a dry run checks a patch without changing anything', async () => {
  const repo = makeRepo()
  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot)
  writeFileSync(join(slot.dir, 'new.txt'), 'new\n')
  const change = isolation.collect(slot)

  const checked = isolation.apply({ patchId: change.patchId, dryRun: true })
  assert.equal(checked.applied, false)
  assert.equal(checked.dryRun, true)
  assert.equal(existsSync(join(repo, 'new.txt')), false)

  isolation.apply({ patchId: change.patchId })
  assert.equal(existsSync(join(repo, 'new.txt')), true)
  isolation.close()
})

test('an unknown patch id is refused with a usable message', async () => {
  const repo = makeRepo()
  const { isolation, stateDir } = makePool(repo)
  const missing = `flash-${randomUUID()}`
  assert.throws(() => isolation.apply({ patchId: missing }), new RegExp(`no patch ${missing} is held`))
  assert.throws(
    () => isolation.apply({ patchId: missing }),
    new RegExp(stateDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  )
  isolation.close()
})

test('a patch id cannot name a file of its own choosing', async () => {
  const repo = makeRepo()
  const { isolation } = makePool(repo)
  // Ids are used to build paths, so anything that is not the issued shape is refused
  // before the path exists — `../` used to walk out of the calls directory.
  for (const bad of ['flash-nope', '../secrets', `flash-${randomUUID()}.patch`, '', 'flash-../../../../etc/passwd']) {
    assert.throws(() => isolation.apply({ patchId: bad }), /is not an id this service issues/, String(bad))
  }
  assert.throws(() => isolation.apply({ patchId: undefined }), /is not an id this service issues/)
  isolation.close()
})

test('a patch computed for another repository is refused', async () => {
  const first = makeRepo()
  const second = makeRepo()
  const a = makePool(first)
  const slot = await a.isolation.lease()
  a.isolation.prepare(slot)
  const change = (writeFileSync(join(slot.dir, 'made-by-a.txt'), 'from A\n'), a.isolation.collect(slot))
  assert.equal(change.available, true)

  // The same patch, with the same state directory, looked up through a service over a
  // different root. It used to be accepted, putting one caller's work into another
  // caller's tree under their name.
  const b = { isolation: new WorkspaceIsolation({ root: second, slots: 1, stateDir: a.stateDir }) }
  assert.throws(
    () => b.isolation.apply({ patchId: change.patchId }),
    /was computed for .*not for .*patches do not cross repositories/,
  )
  assert.equal(existsSync(join(second, 'made-by-a.txt')), false)
  a.isolation.close()
  b.isolation.close()
})

test('applying the same patch twice is refused by the record, not by luck', async () => {
  const repo = makeRepo()
  // A block that repeats, and a change inside it: the shape where `git apply` can find
  // a second place to put the same change instead of failing. Whether git would is not
  // the question here — the service must not ask it twice at all.
  const file = join(repo, 'repeat.txt')
  writeFileSync(file, 'alpha\nbeta\ngamma\nalpha\nbeta\ngamma\nalpha\nbeta\ngamma\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'repeat'], { cwd: repo })

  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot)
  writeFileSync(join(slot.dir, 'repeat.txt'), 'alpha\nbeta\ngamma\nADDED\nalpha\nbeta\ngamma\nalpha\nbeta\ngamma\n')
  const change = isolation.collect(slot)

  assert.equal(isolation.apply({ patchId: change.patchId }).applied, true)
  // The refusal comes from the recorded apply, before git is consulted at all.
  assert.throws(() => isolation.apply({ patchId: change.patchId }), /was already applied/)
  assert.equal(readFileSync(file, 'utf8').split('ADDED').length - 1, 1)

  // `force` is the explicit way past the bookkeeping. What git then decides is git's
  // business; what matters is that the refusal above did not come from git.
  let forced
  try {
    forced = isolation.apply({ patchId: change.patchId, force: true })
  } catch (error) {
    forced = error
  }
  assert.equal(forced instanceof Error ? /already applied/.test(forced.message) : false, false)
  isolation.close()
})

test('a stored patch remembers that it was applied, across a restart', async () => {
  const repo = makeRepo()
  const first = makePool(repo)
  const slot = await first.isolation.lease()
  first.isolation.prepare(slot)
  writeFileSync(join(slot.dir, 'survivor.txt'), 'kept\n')
  const change = first.isolation.collect(slot)
  // A dry run checks without marking anything.
  assert.equal(first.isolation.apply({ patchId: change.patchId, dryRun: true }).dryRun, true)
  first.isolation.apply({ patchId: change.patchId })
  first.isolation.close()

  // The record travelled on disk, so a fresh service over the same root still refuses.
  const second = new WorkspaceIsolation({ root: repo, slots: 1, stateDir: first.stateDir })
  assert.throws(() => second.apply({ patchId: change.patchId }), /was already applied/)
  assert.equal(existsSync(join(repo, 'survivor.txt')), true)
  second.close()
})

test('two services over one repository do not share a state directory', async () => {
  const repo = makeRepo()
  // No state directory configured: this is the default layout, which used to be
  // $TMPDIR/flash-mcp for every instance of every root.
  const first = new WorkspaceIsolation({ root: repo, slots: 1 })
  const second = new WorkspaceIsolation({ root: repo, slots: 1 })
  try {
    assert.notEqual(first.stateDir, second.stateDir)
    const slot = await first.lease()
    first.prepare(slot)
    writeFileSync(join(slot.dir, 'in-flight.txt'), 'a worker is writing here\n')
    assert.equal(existsSync(join(slot.dir, 'in-flight.txt')), true)

    // Starting the second service must not clear the first one's in-flight tree.
    const other = new WorkspaceIsolation({ root: repo, slots: 1 })
    try {
      assert.equal(existsSync(join(slot.dir, 'in-flight.txt')), true)
      assert.notEqual(other.stateDir, first.stateDir)
    } finally {
      other.close()
    }
  } finally {
    first.close()
    second.close()
  }
})

test('waiting for a tree is bounded by the call, not by the pool', async () => {
  const repo = makeRepo()
  const { isolation } = makePool(repo, 1)
  const held = await isolation.lease()

  // A queued call with a deadline is refused rather than served late.
  await assert.rejects(
    () => isolation.lease({ deadline: Date.now() + 30 }),
    (error) => error.code === 'TIMEOUT' && /no tree was free/.test(error.message),
  )
  // A cancelled call stops waiting immediately, and never copies a repository.
  const controller = new AbortController()
  const waiting = isolation.lease({ signal: controller.signal })
  controller.abort()
  await assert.rejects(() => waiting, (error) => error.code === 'CANCELLED')

  // The queue is genuinely empty afterwards: releasing hands the tree to nobody.
  isolation.release(held)
  assert.equal(isolation.waiting.length, 0)
  assert.equal(isolation.slots[0].busy, false)
  isolation.close()
})

test('a worker is pointed at a temp directory inside its own copy', async () => {
  const repo = makeRepo()
  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot)

  assert.equal(slot.tmpDir, join(slot.dir, '.flash-tmp'))
  assert.equal(existsSync(slot.tmpDir), true)
  // What a tool that honours TMPDIR writes there is not part of the reported change.
  writeFileSync(join(slot.tmpDir, 'scratch.bin'), 'temp\n')
  writeFileSync(join(slot.dir, 'real.txt'), 'work\n')
  const change = isolation.collect(slot)
  assert.deepEqual(change.filesChanged.map((line) => line.split('\t').at(-1)), ['real.txt'])
  assert.deepEqual(change.ignored, [])
  assert.doesNotMatch(change.diff, /scratch\.bin/)
  isolation.close()
})

test('a patch written by an earlier process can still be applied', async () => {
  const repo = makeRepo()
  const first = makePool(repo)
  const slot = await first.isolation.lease()
  first.isolation.prepare(slot)
  writeFileSync(join(slot.dir, 'later.txt'), 'from an earlier service\n')
  const change = first.isolation.collect(slot)
  first.isolation.close()

  // A new pool over the same state directory: only the patch file on disk is left.
  const second = new WorkspaceIsolation({ root: repo, slots: 1, stateDir: first.stateDir })
  const applied = second.apply({ patchId: change.patchId })
  assert.equal(applied.applied, true)
  assert.equal(readFileSync(join(repo, 'later.txt'), 'utf8'), 'from an earlier service\n')
  second.close()
})

test('the slot count is honoured and at least one slot always exists', () => {
  const repo = makeRepo()
  const { isolation } = makePool(repo, 0)
  assert.equal(isolation.size, 1)
  isolation.close()
})

test('work that git ignores is named instead of silently vanishing', async () => {
  const repo = makeRepo()
  writeFileSync(join(repo, '.gitignore'), 'dist/\n*.log\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'ignore'], { cwd: repo })
  // Ignored before the call: not the worker's doing, so not reported as its change.
  mkdirSync(join(repo, 'dist'), { recursive: true })
  writeFileSync(join(repo, 'dist', 'stale.js'), 'was here before\n')

  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot)

  writeFileSync(join(slot.dir, 'worker.txt'), 'seen by git\n')
  writeFileSync(join(slot.dir, 'build.log'), 'written by the worker\n')
  writeFileSync(join(slot.dir, 'dist', 'app.js'), 'written by the worker\n')

  const change = isolation.collect(slot)
  assert.deepEqual(change.filesChanged.map((line) => line.split('\t').at(-1)), ['worker.txt'])
  // `dist/` was already ignored at the base, so only the new shapes are reported...
  assert.deepEqual(change.ignored, ['build.log'])
  // ...and the patch, which is what an apply would carry, holds only the tracked file.
  assert.doesNotMatch(change.diff, /build\.log/)
  assert.match(change.diff, /worker\.txt/)
  await isolation.close()
})

test('a call whose patch is empty is not confused with a call that ignored its work', async () => {
  const repo = makeRepo()
  writeFileSync(join(repo, '.gitignore'), '*.tmp\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'ignore'], { cwd: repo })

  const { isolation } = makePool(repo)
  const quiet = await isolation.lease()
  isolation.prepare(quiet)
  const empty = isolation.collect(quiet)
  assert.equal(empty.available, true)
  assert.deepEqual(empty.filesChanged, [])
  assert.deepEqual(empty.ignored, [])
  await isolation.close()
})

test('a sweep reclaims a dead owner’s trees without taking its patches', async () => {
  // Found by a self-test: two servers ran one task each, and the second one's startup
  // sweep deleted the first one's whole per-process directory — including the patch the
  // caller had just been told to apply. Patches therefore live beside those directories.
  const repo = makeRepo()
  const first = new WorkspaceIsolation({ root: repo })
  const slot = await first.lease()
  first.prepare(slot)
  writeFileSync(join(slot.dir, 'from-worker.txt'), 'work worth keeping\n')
  const change = first.collect(slot)
  first.release(slot)
  assert.equal(change.available, true)

  const pidDir = dirname(first.stateDir)
  assert.ok(!first.patchDir.startsWith(pidDir + sep), `${first.patchDir} must not sit under ${pidDir}`)

  // A dead owner's leftovers, then the next service starting on the same root. The pid is
  // above every platform maximum, so it can never name a live process.
  const deadOwner = join(dirname(pidDir), '4194303')
  mkdirSync(join(deadOwner, 'slots', 'slot-0'), { recursive: true })
  const second = new WorkspaceIsolation({ root: repo })
  assert.equal(existsSync(deadOwner), false, 'a dead owner’s trees are still reclaimed')

  // The work survived the first service, and the second one can still apply it.
  const applied = second.apply({ patchId: change.patchId })
  assert.equal(applied.applied, true)
  assert.equal(readFileSync(join(repo, 'from-worker.txt'), 'utf8'), 'work worth keeping\n')
  await first.close()
  await second.close()
})

test('a sweep salvages a dead owner’s unfinished work as an applicable patch', async () => {
  // The failure this guards: the host restarts the server, the next server's sweep deletes
  // every per-pid directory whole, and a worker's forty-minute fix — sitting uncommitted in
  // a disposable tree — goes with it. The tree is a git work tree with a `flash base`
  // commit and a modified file: exactly a prepared slot whose call was cut off.
  const repo = makeRepo()
  // A retired slot keeps a `<id>-<n>` name, so use one to prove every `slots/` entry is
  // examined rather than just the generation-zero names.
  const { owner, slotDir } = makeDeadOwner(repo, { slot: 'slot-0-1' })
  makeFlashBaseTree(slotDir)
  writeFileSync(join(slotDir, 'keep.txt'), 'the lost fix\n')
  writeFileSync(join(slotDir, 'new.txt'), 'also lost\n')

  const logLines = []
  const next = new WorkspaceIsolation({ root: repo, slots: 1, log: (message) => logLines.push(message) })
  try {
    // The directory is still reclaimed, but only after the work was taken out of it.
    assert.equal(existsSync(owner), false, 'the dead owner directory is removed')
    assert.equal(existsSync(slotDir), false, 'the slot tree is removed with it')

    const salvaged = salvagedPatch(next)
    assert.ok(salvaged, 'the salvage leaves a patch record a later apply can use')
    assert.equal(salvaged.appliedAt, null)
    assert.equal(salvaged.root, repo)
    assert.equal(salvaged.salvagedFrom.pid, 4194303)
    assert.equal(salvaged.salvagedFrom.slotDir, slotDir)
    assert.equal(typeof salvaged.salvagedFrom.sweptAt, 'number')
    // The sweep says what it saved, in one line, naming the patch and the diffstat.
    const salvageLine = logLines.find((line) => line.startsWith('salvaged '))
    assert.ok(salvageLine, `expected a salvage log line in ${JSON.stringify(logLines)}`)
    assert.match(salvageLine, new RegExp(salvaged.patchId))
    assert.doesNotMatch(salvageLine, /\n/)
    assert.match(salvageLine, /2 files changed/)
    // The record travels on disk with its provenance, not just in memory.
    const meta = JSON.parse(readFileSync(join(next.patchDir, `${salvaged.patchId}.json`), 'utf8'))
    assert.deepEqual(meta.salvagedFrom, salvaged.salvagedFrom)

    // The stored diff is the dead worker's change, tracked files included.
    assert.match(readFileSync(join(next.patchDir, `${salvaged.patchId}.patch`), 'utf8'), /the lost fix/)
    assert.match(readFileSync(join(next.patchDir, `${salvaged.patchId}.patch`), 'utf8'), /also lost/)
    assert.deepEqual(
      salvaged.filesChanged.map((line) => line.split('\t').at(-1)).sort(),
      ['keep.txt', 'new.txt'],
    )

    // The caller's tree never saw the dead owner's edits, which is why the patch matters...
    assert.equal(readFileSync(join(repo, 'keep.txt'), 'utf8'), 'keep me\n')
    assert.equal(existsSync(join(repo, 'new.txt')), false)

    // ...and applying it by id to the caller's fresh checkout reproduces the change.
    const applied = next.apply({ patchId: salvaged.patchId })
    assert.equal(applied.applied, true)
    assert.equal(readFileSync(join(repo, 'keep.txt'), 'utf8'), 'the lost fix\n')
    assert.equal(readFileSync(join(repo, 'new.txt'), 'utf8'), 'also lost\n')
  } finally {
    next.close()
  }
})

test('a sweep of a dead owner with a clean slot leaves no patch', async () => {
  const repo = makeRepo()
  const { owner, slotDir } = makeDeadOwner(repo)
  // A prepared tree at its base with nothing staged or modified: there is no work to keep.
  makeFlashBaseTree(slotDir)

  const next = new WorkspaceIsolation({ root: repo, slots: 1 })
  try {
    assert.equal(existsSync(owner), false, 'the clean dead owner is still removed')
    assert.equal(existsSync(slotDir), false)
    assert.equal(salvagedPatch(next), undefined, 'a clean slot must not produce a patch')
  } finally {
    next.close()
  }
})

// ── disk hygiene ─────────────────────────────────────────────────────────────

/** A patch record and its file, laid out exactly as `collect` writes one. */
function writePatchRecord(patchDir, root, { createdAt, ...extra }) {
  const patchId = `flash-${randomUUID()}`
  writeFileSync(join(patchDir, `${patchId}.patch`), 'a stored patch\n')
  writeFileSync(
    join(patchDir, `${patchId}.json`),
    `${JSON.stringify({ patchId, root, base: 'base', filesChanged: [], diffstat: '', createdAt, appliedAt: null, ...extra }, null, 2)}\n`,
  )
  return patchId
}

test('construction prunes patches past the retention window, keeping fresh and recently salvaged work', async () => {
  const repo = makeRepo()
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-iso-prune-')))
  const patchDir = join(stateDir, 'calls')
  mkdirSync(patchDir, { recursive: true })
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const ids = {
    expired: writePatchRecord(patchDir, repo, { createdAt: now - 30 * day }),
    fresh: writePatchRecord(patchDir, repo, { createdAt: now - day }),
    salvaged: writePatchRecord(patchDir, repo, {
      createdAt: now - 30 * day,
      salvagedFrom: { pid: 4194303, slotDir: '/gone', sweptAt: now - day },
    }),
    oldSalvage: writePatchRecord(patchDir, repo, {
      createdAt: now - 30 * day,
      salvagedFrom: { pid: 4194303, slotDir: '/gone', sweptAt: now - 30 * day },
    }),
  }

  const isolation = new WorkspaceIsolation({ root: repo, slots: 1, stateDir })
  try {
    const gone = (name) => !existsSync(join(patchDir, `${ids[name]}.patch`))
    assert.equal(gone('expired'), true, 'a patch older than the window is pruned')
    assert.equal(gone('fresh'), false, 'a patch inside the window is kept')
    assert.equal(gone('salvaged'), false, 'a patch salvaged inside the window is kept, whatever its createdAt')
    assert.equal(gone('oldSalvage'), true, 'a patch whose salvage is also old is pruned')
    // A pruned patch is neither on disk nor offered for apply.
    const listed = isolation.listPatches().map((record) => record.patchId)
    assert.equal(listed.includes(ids.expired), false)
    assert.equal(listed.includes(ids.fresh), true)
  } finally {
    isolation.close()
  }
})

test('the patch retention window is configurable', async () => {
  const repo = makeRepo()
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-iso-retain-')))
  const patchDir = join(stateDir, 'calls')
  mkdirSync(patchDir, { recursive: true })
  const id = writePatchRecord(patchDir, repo, { createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000 })

  const wide = new WorkspaceIsolation({ root: repo, slots: 1, stateDir, patchRetentionDays: 14 })
  try {
    assert.equal(existsSync(join(patchDir, `${id}.patch`)), true, 'a two-day-old patch survives a 14-day window')
  } finally {
    wide.close()
  }
  const narrow = new WorkspaceIsolation({ root: repo, slots: 1, stateDir, patchRetentionDays: 1 })
  try {
    assert.equal(existsSync(join(patchDir, `${id}.patch`)), false, 'the same patch is pruned by a one-day window')
  } finally {
    narrow.close()
  }
})

test('startup drops other roots’ empty digest directories and keeps ones with content', async () => {
  const repo = makeRepo()
  const anchor = new WorkspaceIsolation({ root: repo, slots: 1 })
  const base = dirname(dirname(dirname(anchor.stateDir)))
  anchor.close()

  // A digest left by a throwaway root: only empty directories, no live owner.
  const emptyDigest = join(base, '00ff00ff00ff')
  mkdirSync(join(emptyDigest, 'patches'), { recursive: true })
  // A digest with an owner's tree: not empty, so it is left alone.
  const usedDigest = join(base, '0f1e2d3c4b5a')
  const usedSlot = join(usedDigest, '4194303', 'slots', 'slot-0')
  mkdirSync(usedSlot, { recursive: true })
  writeFileSync(join(usedSlot, 'left.txt'), 'work\n')

  const next = new WorkspaceIsolation({ root: repo, slots: 1 })
  try {
    assert.equal(existsSync(emptyDigest), false, 'an empty digest of another root is removed')
    assert.equal(existsSync(usedSlot), true, 'a digest holding a tree is kept')
    assert.equal(existsSync(dirname(dirname(dirname(next.stateDir)))), true, 'this root’s own digest is never a candidate')
  } finally {
    next.close()
  }
})


test('a pool with no configured state directory lives under the canonical temp directory', () => {
  const repo = makeRepo()
  try {
    const pool = new WorkspaceIsolation({ root: repo })
    const canonical = realpathSync(tmpdir())
    assert.equal(canonicalTmpdir(), canonical)
    assert.ok(pool.stateDir.startsWith(canonical + sep) || pool.stateDir === canonical,
      `state dir ${pool.stateDir} is not under the canonical temp directory ${canonical}`)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/** A workspace root that is itself a git repository and holds two independent nested repositories. */
function makeWorkspace() {
  const root = makeRepo()
  for (const name of ['alpha', 'beta']) {
    const dir = join(root, 'Repos', name)
    mkdirSync(dir, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
    writeFileSync(join(dir, 'app.txt'), `${name} app\n`)
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: dir })
  }
  return root
}

test('a call inside a nested repository copies, diffs and applies only that repository', async () => {
  const root = makeWorkspace()
  const { isolation } = makePool(root)
  const slot = await isolation.lease()
  const cwd = join(root, 'Repos', 'alpha')
  const prepared = isolation.prepare(slot, { cwd })

  assert.equal(prepared.scope, join('Repos', 'alpha'))
  assert.notEqual(prepared.base, null)
  // Only the working repository was copied: its sibling and the root's own files are absent.
  assert.equal(existsSync(join(slot.dir, 'Repos', 'alpha', 'app.txt')), true)
  assert.equal(existsSync(join(slot.dir, 'Repos', 'beta')), false)
  assert.equal(existsSync(join(slot.dir, 'keep.txt')), false)
  // The working directory still maps to the same relative path inside the slot.
  assert.equal(isolation.slotCwd(slot, cwd), join(slot.dir, 'Repos', 'alpha'))

  writeFileSync(join(slot.dir, 'Repos', 'alpha', 'app.txt'), 'changed by the worker\n')
  const change = isolation.collect(slot)
  assert.equal(change.available, true)
  assert.equal(change.scope, join('Repos', 'alpha'))
  assert.deepEqual(change.filesChanged.map((line) => line.split('\t').at(-1)), ['app.txt'])

  const applied = isolation.apply({ patchId: change.patchId })
  assert.equal(applied.root, join(root, 'Repos', 'alpha'))
  assert.equal(readFileSync(join(root, 'Repos', 'alpha', 'app.txt'), 'utf8'), 'changed by the worker\n')
  assert.equal(readFileSync(join(root, 'Repos', 'beta', 'app.txt'), 'utf8'), 'beta app\n')
  isolation.close()
})

test('a linked worktree or a call at the root keeps the whole-root copy', async () => {
  const root = makeWorkspace()
  const alpha = join(root, 'Repos', 'alpha')
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'side', join(root, 'Repos', 'alpha-side')], { cwd: alpha })
  const { isolation } = makePool(root)

  const slot = await isolation.lease()
  assert.equal(isolation.prepare(slot, { cwd: join(root, 'Repos', 'alpha-side') }).scope, '')
  assert.equal(existsSync(join(slot.dir, 'keep.txt')), true)
  isolation.release(slot)

  const again = await isolation.lease()
  assert.equal(isolation.prepare(again, { cwd: root }).scope, '')
  assert.equal(isolation.prepare(again).scope, '')
  isolation.close()
})

test('a sweep salvages a dead owner’s scoped tree from the recorded repository', async () => {
  const repo = makeRepo()
  const { owner, slotDir } = makeDeadOwner(repo, { pid: 4194301 })
  const inner = join(slotDir, 'Repos', 'alpha')
  mkdirSync(inner, { recursive: true })
  makeFlashBaseTree(inner)
  writeFileSync(join(slotDir, '.flash-scope'), `${join('Repos', 'alpha')}\n`)
  writeFileSync(join(inner, 'keep.txt'), 'unfinished work\n')

  const isolation = new WorkspaceIsolation({ root: repo, slots: 1 })
  const record = salvagedPatch(isolation)
  assert.ok(record, 'the scoped tree was salvaged')
  assert.equal(record.scope, join('Repos', 'alpha'))
  assert.equal(existsSync(owner), false)
  isolation.close()
})

test('the base is recorded without a commit on the branch, so a push cannot carry it', async () => {
  const root = makeWorkspace()
  const alpha = join(root, 'Repos', 'alpha')
  const { isolation } = makePool(root)
  const slot = await isolation.lease()
  const prepared = isolation.prepare(slot, { cwd: alpha })
  const copy = join(slot.dir, 'Repos', 'alpha')

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: copy, encoding: 'utf8' }).trim()
  const original = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: alpha, encoding: 'utf8' }).trim()
  assert.equal(head, original, 'the branch did not move')
  const subjects = execFileSync('git', ['log', '--format=%s'], { cwd: copy, encoding: 'utf8' })
  assert.equal(subjects.includes('flash base'), false)
  const ref = execFileSync('git', ['rev-parse', 'refs/flash/base'], { cwd: copy, encoding: 'utf8' }).trim()
  assert.equal(ref, prepared.base)

  // A worker that commits its own work still produces the full change against the base.
  writeFileSync(join(copy, 'app.txt'), 'committed by the worker\n')
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-am', 'worker'], { cwd: copy })
  const change = isolation.collect(slot)
  assert.deepEqual(change.filesChanged.map((line) => line.split('\t').at(-1)), ['app.txt'])
  isolation.close()
})
