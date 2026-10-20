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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { test } from 'node:test'

import { WorkspaceIsolation, canonicalTmpdir, durableBaseDir, migrateLegacyPatches, rootDigest } from '../lib/isolation.js'

/**
 * Patches default to the durable data directory. Keep every default-layout pool in this
 * file out of the real user data directory, whichever platform the suite runs on.
 */
process.env.FLASH_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'flash-iso-data-')))

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

test('the durable patch base honours FLASH_DATA_DIR and each platform’s data location', () => {
  // An explicit override is used exactly as given, and an empty value counts as unset.
  assert.equal(durableBaseDir({ FLASH_DATA_DIR: '/var/lib/flash' }, { platform: 'linux', home: '/home/u' }), '/var/lib/flash')
  assert.equal(durableBaseDir({ FLASH_DATA_DIR: '' }, { platform: 'linux', home: '/home/u' }), join('/home/u', '.local', 'state', 'flash-agents'))
  // Linux/other: XDG_STATE_HOME, then the conventional fallback under the home directory.
  assert.equal(durableBaseDir({ XDG_STATE_HOME: '/state' }, { platform: 'linux', home: '/home/u' }), join('/state', 'flash-agents'))
  assert.equal(durableBaseDir({}, { platform: 'freebsd', home: '/home/u' }), join('/home/u', '.local', 'state', 'flash-agents'))
  // macOS: Application Support.
  assert.equal(
    durableBaseDir({}, { platform: 'darwin', home: '/Users/u' }),
    join('/Users/u', 'Library', 'Application Support', 'flash-agents'),
  )
  // Windows: LOCALAPPDATA, then the AppData\Local fallback under the home directory.
  assert.equal(
    durableBaseDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, { platform: 'win32', home: 'C:\\Users\\u' }),
    join('C:\\Users\\u\\AppData\\Local', 'flash-agents'),
  )
  assert.equal(
    durableBaseDir({}, { platform: 'win32', home: 'C:\\Users\\u' }),
    join('C:\\Users\\u', 'AppData', 'Local', 'flash-agents'),
  )
})

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

test('a symlink is copied as it is, so it cannot lead back into the caller’s tree', async (t) => {
  const repo = makeRepo()
  try {
    symlinkSync('keep.txt', join(repo, 'link.txt'))
  } catch {
    t.skip('this platform cannot create a symlink here')
    return
  }
  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot)
  // Relative and unchanged: resolved inside the copy, it names the copy's own file.
  assert.equal(readlinkSync(join(slot.dir, 'link.txt')), 'keep.txt')
  writeFileSync(join(slot.dir, 'link.txt'), 'written through the link\n')
  assert.equal(readFileSync(join(slot.dir, 'keep.txt'), 'utf8'), 'written through the link\n')
  assert.equal(readFileSync(join(repo, 'keep.txt'), 'utf8'), 'keep me\n')
  isolation.close()
})

test('a patch applies to a root whose .git is gone, even inside another repository', async () => {
  // The root sits inside an unrelated repository. Once its own `.git` is gone, a git
  // that went looking upwards would read the patch's paths against the outer
  // repository and, from a subdirectory, silently skip every one of them.
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'flash-iso-outer-')))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: outer })
  const repo = join(outer, 'inner')
  mkdirSync(repo)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  writeFileSync(join(repo, 'keep.txt'), 'keep me\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: repo })

  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot)
  writeFileSync(join(slot.dir, 'worker.txt'), 'made by the worker\n')
  writeFileSync(join(slot.dir, 'keep.txt'), 'the worker rewrote this\n')
  const change = isolation.collect(slot)
  rmSync(join(repo, '.git'), { recursive: true, force: true })

  assert.equal(isolation.apply({ patchId: change.patchId, dryRun: true }).applied, false)
  assert.equal(isolation.apply({ patchId: change.patchId }).applied, true)
  assert.equal(readFileSync(join(repo, 'worker.txt'), 'utf8'), 'made by the worker\n')
  assert.equal(readFileSync(join(repo, 'keep.txt'), 'utf8'), 'the worker rewrote this\n')
  assert.equal(existsSync(join(outer, 'worker.txt')), false)
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

test('a default pool stores patches in the durable data directory, while a configured state directory keeps calls', async () => {
  const repo = makeRepo()
  const digest = rootDigest(repo)
  const pool = new WorkspaceIsolation({ root: repo, slots: 1 })
  try {
    assert.equal(pool.patchDir, join(process.env.FLASH_DATA_DIR, digest, 'patches'))
    const slot = await pool.lease()
    pool.prepare(slot)
    writeFileSync(join(slot.dir, 'durable.txt'), 'survives a reboot\n')
    const change = pool.collect(slot)

    // The patch is in the durable store, and not in the temp layout.
    assert.equal(existsSync(join(pool.patchDir, `${change.patchId}.patch`)), true)
    assert.equal(existsSync(join(pool.patchDir, `${change.patchId}.json`)), true)
    const legacyDir = join(canonicalTmpdir(), 'flash-mcp', digest, 'patches')
    assert.equal(existsSync(join(legacyDir, `${change.patchId}.patch`)), false, 'a new patch is not written to the temp tree')

    // Applying it still works, and then the caller's tree has the worker's change.
    pool.apply({ patchId: change.patchId })
    assert.equal(readFileSync(join(repo, 'durable.txt'), 'utf8'), 'survives a reboot\n')
  } finally {
    pool.close()
  }

  // An explicitly configured state directory is used as given, `calls` store included.
  const configuredDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-iso-configured-')))
  const configured = new WorkspaceIsolation({ root: repo, slots: 1, stateDir: configuredDir })
  try {
    assert.equal(configured.patchDir, join(configuredDir, 'calls'))
    const slot = await configured.lease()
    configured.prepare(slot)
    writeFileSync(join(slot.dir, 'configured.txt'), 'kept beside its state\n')
    const change = configured.collect(slot)
    assert.equal(existsSync(join(configuredDir, 'calls', `${change.patchId}.patch`)), true)
    assert.equal(existsSync(join(process.env.FLASH_DATA_DIR, digest, 'patches', `${change.patchId}.patch`)), false)
  } finally {
    configured.close()
  }
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

/**
 * A repository whose committed `.gitignore` names a generated file, a log file and a build
 * directory, with the generated file and the build directory present and ignored before any
 * copy is made — the shape the caller reported from Linux: a worker regenerates a
 * `worker-configuration.d.ts` that already existed, and the change cannot be in the patch.
 */
function makeIgnoredRepo() {
  const repo = makeRepo()
  writeFileSync(join(repo, '.gitignore'), 'generated.d.ts\n*.log\ndist/\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'ignore'], { cwd: repo })
  // Untracked and ignored, so they travel in the copy and the patch can never carry them.
  writeFileSync(join(repo, 'generated.d.ts'), 'declare const version: "old"\n')
  mkdirSync(join(repo, 'dist'), { recursive: true })
  writeFileSync(join(repo, 'dist', 'stale.js'), 'was here before\n')
  return repo
}

test('an ignored file the worker rewrote is reported, though the patch cannot carry it', async () => {
  const repo = makeIgnoredRepo()
  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot)

  // Both the size and the mtime differ, and the mtime is set explicitly so a rewrite within
  // one filesystem timestamp tick cannot hide the change.
  writeFileSync(join(slot.dir, 'generated.d.ts'), 'declare const version: "new"; export {}\n')
  const older = new Date(Date.now() - 60_000)
  utimesSync(join(slot.dir, 'generated.d.ts'), older, older)

  const change = isolation.collect(slot)
  assert.deepEqual(change.ignoredChanged, [{ path: 'generated.d.ts', change: 'modified' }])
  // The rewrite is the worker's only work: it is neither a tracked change nor a new path.
  assert.deepEqual(change.filesChanged, [])
  assert.deepEqual(change.ignored, [])
  assert.doesNotMatch(change.diff, /generated\.d\.ts/)
  isolation.close()
})

test('an ignored file the worker deleted is reported as deleted', async () => {
  const repo = makeIgnoredRepo()
  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot)

  rmSync(join(slot.dir, 'generated.d.ts'))

  const change = isolation.collect(slot)
  assert.deepEqual(change.ignoredChanged, [{ path: 'generated.d.ts', change: 'deleted' }])
  assert.deepEqual(change.filesChanged, [])
  // A deletion leaves no new ignored path behind, so only the comparison can see it.
  assert.deepEqual(change.ignored, [])
  isolation.close()
})

test('an ignored file left alone, and a change inside an ignored directory, are not reported', async () => {
  const repo = makeIgnoredRepo()
  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot)

  // `dist/` is ignored as a directory: git lists the directory entry, not the files under it,
  // so a change deep inside it is the documented limit of this comparison and must not be
  // guessed at. `generated.d.ts` is left exactly as the copy started with it.
  writeFileSync(join(slot.dir, 'dist', 'stale.js'), 'rewritten by the worker\n')
  writeFileSync(join(slot.dir, 'dist', 'added.js'), 'added by the worker\n')

  const change = isolation.collect(slot)
  assert.equal(readFileSync(join(slot.dir, 'generated.d.ts'), 'utf8'), 'declare const version: "old"\n')
  assert.deepEqual(change.ignoredChanged, [])
  assert.deepEqual(change.ignored, [])
  assert.deepEqual(change.filesChanged, [])
  isolation.close()
})

test('an ignored file the worker created is reported as new, not as changed', async () => {
  const repo = makeIgnoredRepo()
  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot)

  writeFileSync(join(slot.dir, 'build.log'), 'written by the worker\n')

  const change = isolation.collect(slot)
  assert.deepEqual(change.ignored, ['build.log'])
  assert.deepEqual(change.ignoredChanged, [])
  assert.deepEqual(change.filesChanged, [])
  isolation.close()
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
    assert.ok(
      next.patchDir.startsWith(join(process.env.FLASH_DATA_DIR, rootDigest(repo)) + sep),
      `the salvage store ${next.patchDir} must be the durable data store`,
    )
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

/**
 * A private legacy patch store.
 *
 * Migration tests used to fabricate `$TMPDIR/flash-mcp/<random-digest>/patches` and leave
 * it behind, which made the suite itself deposit state in the shared temp base. A legacy
 * directory is just a directory: `migrateLegacyPatches` takes it as an argument, so a
 * throwaway one tests the same behaviour without touching the shared layout.
 *
 * @returns {string} an empty `<temp>/patches` directory.
 */
function makeLegacyStore() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-iso-legacy-')))
  const patches = join(dir, 'patches')
  mkdirSync(patches, { recursive: true })
  return patches
}

/** Wait until `predicate` holds, so a test can observe the pool's periodic sweep. */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`)
}

test('an old temp patch store is migrated into the durable one, blobs included, before it is loaded', async () => {
  const repo = makeRepo()
  const digest = rootDigest(repo)
  const seedDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-iso-migrate-seed-')))
  const seed = new WorkspaceIsolation({ root: repo, slots: 1, stateDir: seedDir })
  const slot = await seed.lease()
  seed.prepare(slot)
  writeFileSync(join(slot.dir, 'keep.txt'), 'the migrated fix\n')
  const change = seed.collect(slot)
  seed.close()

  // Lay this real patch out exactly where an older version left it: under the temp base.
  const legacyDir = join(canonicalTmpdir(), 'flash-mcp', digest, 'patches')
  mkdirSync(legacyDir, { recursive: true })
  for (const suffix of ['.patch', '.json', '.blobs']) {
    const from = join(seed.patchDir, `${change.patchId}${suffix}`)
    if (existsSync(from)) renameSync(from, join(legacyDir, `${change.patchId}${suffix}`))
  }
  assert.equal(existsSync(join(legacyDir, `${change.patchId}.blobs`)), true, 'the collected patch has its preimage blobs')

  const logLines = []
  const next = new WorkspaceIsolation({ root: repo, slots: 1, log: (message) => logLines.push(message) })
  try {
    assert.equal(next.patchDir, join(process.env.FLASH_DATA_DIR, digest, 'patches'))
    for (const suffix of ['.patch', '.json', '.blobs']) {
      assert.equal(existsSync(join(next.patchDir, `${change.patchId}${suffix}`)), true, `${suffix} moved`)
      assert.equal(existsSync(join(legacyDir, `${change.patchId}${suffix}`)), false, `${suffix} left the temp tree`)
    }
    assert.equal(existsSync(legacyDir), false, 'the empty legacy patches directory is removed')
    assert.ok(next.listPatches().some((record) => record.patchId === change.patchId), 'the moved patch is loaded')
    assert.equal(next.apply({ patchId: change.patchId }).applied, true)
    assert.equal(readFileSync(join(repo, 'keep.txt'), 'utf8'), 'the migrated fix\n')

    const line = logLines.find((message) => message.startsWith('moved 1 stored patch(es) from '))
    assert.ok(line, `expected the migration log line in ${JSON.stringify(logLines)}`)
    assert.ok(line.includes(legacyDir), line)
    assert.ok(line.includes(next.patchDir), line)
    assert.match(line, /where a reboot or the temp cleaner cannot remove them$/)
  } finally {
    next.close()
    // The pool's default state directory sits under this throwaway repo's digest in the
    // shared temp base. Remove it whole: the digest belongs to a repository no later test
    // can use, and leaving it would be the very temp-tree residue the suite checks for.
    rmSync(join(canonicalTmpdir(), 'flash-mcp', digest), { recursive: true, force: true })
  }
})

test('a legacy patch already present in the durable store is not overwritten', () => {
  const legacyDir = makeLegacyStore()
  const patchDir = join(process.env.FLASH_DATA_DIR, `migrate-${randomUUID()}`, 'patches')
  mkdirSync(patchDir, { recursive: true })
  const patchId = `flash-${randomUUID()}`
  const legacyMeta = `${JSON.stringify({ patchId, createdAt: 123 })}\n`
  const durableMeta = `${JSON.stringify({ patchId, createdAt: 456 })}\n`
  writeFileSync(join(legacyDir, `${patchId}.patch`), 'legacy copy\n')
  writeFileSync(join(legacyDir, `${patchId}.json`), legacyMeta)
  writeFileSync(join(patchDir, `${patchId}.patch`), 'durable copy\n')
  writeFileSync(join(patchDir, `${patchId}.json`), durableMeta)

  const moved = migrateLegacyPatches(legacyDir, patchDir, { log: () => {} })
  assert.equal(moved, 0)
  assert.equal(readFileSync(join(patchDir, `${patchId}.patch`), 'utf8'), 'durable copy\n', 'the durable patch wins')
  assert.equal(readFileSync(join(patchDir, `${patchId}.json`), 'utf8'), durableMeta, 'the durable record wins')
  assert.equal(existsSync(join(legacyDir, `${patchId}.patch`)), true, 'the untouched legacy copy stays for clean')
  assert.equal(existsSync(join(legacyDir, `${patchId}.json`)), true)
})

test('an incomplete legacy patch is left alone until its record lands', () => {
  const legacyDir = makeLegacyStore()
  const patchDir = join(process.env.FLASH_DATA_DIR, `migrate-${randomUUID()}`, 'patches')
  const patchId = `flash-${randomUUID()}`
  writeFileSync(join(legacyDir, `${patchId}.patch`), 'half-written patch\n')

  // The old server has written the `.patch` but not yet the `.json` that commits it.
  assert.equal(migrateLegacyPatches(legacyDir, patchDir, { log: () => {} }), 0)
  assert.equal(existsSync(join(legacyDir, `${patchId}.patch`)), true, 'the incomplete id stays where it is written')
  assert.equal(existsSync(join(patchDir, `${patchId}.patch`)), false, 'no patch is split across the stores')
  assert.equal(existsSync(legacyDir), true, 'the legacy store is not removed while an id is in flight')

  // A record that names another id is not this patch's commit point either.
  writeFileSync(join(legacyDir, `${patchId}.json`), `${JSON.stringify({ patchId: `flash-${randomUUID()}` })}\n`)
  assert.equal(migrateLegacyPatches(legacyDir, patchDir, { log: () => {} }), 0)
  assert.equal(existsSync(join(patchDir, `${patchId}.patch`)), false)

  // The matching record is the commit point: now the whole id moves.
  writeFileSync(join(legacyDir, `${patchId}.json`), `${JSON.stringify({ patchId, createdAt: 123 })}\n`)
  assert.equal(migrateLegacyPatches(legacyDir, patchDir, { log: () => {} }), 1)
  assert.equal(existsSync(join(patchDir, `${patchId}.patch`)), true)
  assert.equal(existsSync(join(patchDir, `${patchId}.json`)), true)
  assert.equal(existsSync(legacyDir), false, 'the now-empty legacy store is removed')
})

test('a cross-device legacy move falls back to copy-then-remove', () => {
  const legacyDir = makeLegacyStore()
  const patchDir = join(process.env.FLASH_DATA_DIR, `migrate-${randomUUID()}`, 'patches')
  const patchId = `flash-${randomUUID()}`
  const meta = `${JSON.stringify({ patchId, createdAt: 123 })}\n`
  mkdirSync(join(legacyDir, `${patchId}.blobs`, 'pack'), { recursive: true })
  writeFileSync(join(legacyDir, `${patchId}.patch`), 'cross-device patch\n')
  writeFileSync(join(legacyDir, `${patchId}.json`), meta)
  writeFileSync(join(legacyDir, `${patchId}.blobs`, 'pack', 'pack-test.pack'), 'blob payload\n')

  const exdev = (from, to) => {
    const error = new Error(`EXDEV: cross-device link, rename '${from}' -> '${to}'`)
    error.code = 'EXDEV'
    throw error
  }
  const moved = migrateLegacyPatches(legacyDir, patchDir, { fs: { renameSync: exdev } })
  assert.equal(moved, 1)
  assert.equal(readFileSync(join(patchDir, `${patchId}.patch`), 'utf8'), 'cross-device patch\n')
  assert.equal(readFileSync(join(patchDir, `${patchId}.json`), 'utf8'), meta)
  assert.equal(readFileSync(join(patchDir, `${patchId}.blobs`, 'pack', 'pack-test.pack'), 'utf8'), 'blob payload\n')
  assert.equal(existsSync(legacyDir), false, 'the copied artefacts were removed from the temp tree')
})

test('a patch that cannot be migrated is logged and left whole in the legacy store', () => {
  const legacyDir = makeLegacyStore()
  const patchDir = join(process.env.FLASH_DATA_DIR, `migrate-${randomUUID()}`, 'patches')
  const patchId = `flash-${randomUUID()}`
  mkdirSync(join(legacyDir, `${patchId}.blobs`, 'pack'), { recursive: true })
  writeFileSync(join(legacyDir, `${patchId}.patch`), 'stuck patch\n')
  writeFileSync(join(legacyDir, `${patchId}.json`), `${JSON.stringify({ patchId, createdAt: 123 })}\n`)
  writeFileSync(join(legacyDir, `${patchId}.blobs`, 'pack', 'pack-test.pack'), 'blob payload\n')

  const refuseJson = (from, to) => {
    if (from.endsWith('.json')) {
      const error = new Error(`EACCES: permission denied, rename '${from}' -> '${to}'`)
      error.code = 'EACCES'
      throw error
    }
    renameSync(from, to)
  }
  const logs = []
  const moved = migrateLegacyPatches(legacyDir, patchDir, { fs: { renameSync: refuseJson }, log: (line) => logs.push(line) })
  assert.equal(moved, 0)
  assert.equal(existsSync(join(legacyDir, `${patchId}.patch`)), true, 'the patch moved before the failure is put back')
  assert.equal(existsSync(join(legacyDir, `${patchId}.json`)), true)
  assert.equal(existsSync(join(legacyDir, `${patchId}.blobs`, 'pack', 'pack-test.pack')), true)
  assert.equal(existsSync(join(patchDir, `${patchId}.patch`)), false)
  assert.equal(existsSync(join(patchDir, `${patchId}.json`)), false, 'the fragment left by the failed move is removed')
  assert.ok(logs.some((line) => line.startsWith(`could not move stored patch ${patchId} from `)), JSON.stringify(logs))
})

test('a partial cross-device copy leaves no destination fragment and can be retried', () => {
  // The measured failure: the temp and data directories are on different filesystems, the
  // `.patch` copy succeeds, the `.json` copy runs out of space after writing part of the
  // file, and the old rollback restored only fully moved suffixes. The durable store kept
  // a `.patch` plus a half-written `.json`, and every later migration skipped the id.
  const legacyDir = makeLegacyStore()
  const patchDir = join(process.env.FLASH_DATA_DIR, `migrate-${randomUUID()}`, 'patches')
  const patchId = `flash-${randomUUID()}`
  const meta = `${JSON.stringify({ patchId, createdAt: 123 })}\n`
  mkdirSync(join(legacyDir, `${patchId}.blobs`, 'pack'), { recursive: true })
  writeFileSync(join(legacyDir, `${patchId}.patch`), 'complete legacy patch\n')
  writeFileSync(join(legacyDir, `${patchId}.json`), meta)
  writeFileSync(join(legacyDir, `${patchId}.blobs`, 'pack', 'pack-test.pack'), 'blob payload\n')

  const exdev = () => {
    const error = new Error('EXDEV: cross-device link')
    error.code = 'EXDEV'
    throw error
  }
  const failing = {
    renameSync: exdev,
    copyFileSync(from, to) {
      if (from.endsWith('.json')) {
        // A copy that hit ENOSPC part-way: the destination now holds a fragment.
        writeFileSync(to, '{"patchId":')
        const error = new Error('ENOSPC: no space left on device')
        error.code = 'ENOSPC'
        throw error
      }
      writeFileSync(to, readFileSync(from))
    },
  }
  const logs = []
  assert.equal(migrateLegacyPatches(legacyDir, patchDir, { fs: failing, log: (line) => logs.push(line) }), 0)
  assert.equal(existsSync(join(legacyDir, `${patchId}.patch`)), true, 'the complete legacy patch is put back')
  assert.equal(existsSync(join(legacyDir, `${patchId}.json`)), true)
  assert.equal(existsSync(join(legacyDir, `${patchId}.blobs`, 'pack', 'pack-test.pack')), true)
  for (const suffix of ['.patch', '.json', '.blobs']) {
    assert.equal(existsSync(join(patchDir, `${patchId}${suffix}`)), false, `no ${suffix} fragment is left behind`)
  }
  assert.ok(logs.some((line) => line.startsWith(`could not move stored patch ${patchId} from `)), JSON.stringify(logs))

  // With the space problem gone, the id is still migratable: nothing about the failed
  // attempt makes the durable store look like it already holds this patch.
  assert.equal(migrateLegacyPatches(legacyDir, patchDir, { log: () => {} }), 1)
  assert.equal(readFileSync(join(patchDir, `${patchId}.patch`), 'utf8'), 'complete legacy patch\n')
  assert.equal(readFileSync(join(patchDir, `${patchId}.json`), 'utf8'), meta)
  assert.equal(existsSync(legacyDir), false)
})

test('an incomplete durable fragment does not block a complete legacy patch', () => {
  const legacyDir = makeLegacyStore()
  const patchDir = join(process.env.FLASH_DATA_DIR, `migrate-${randomUUID()}`, 'patches')
  mkdirSync(patchDir, { recursive: true })
  const patchId = `flash-${randomUUID()}`
  const meta = `${JSON.stringify({ patchId, createdAt: 123 })}\n`
  writeFileSync(join(legacyDir, `${patchId}.patch`), 'complete legacy patch\n')
  writeFileSync(join(legacyDir, `${patchId}.json`), meta)
  // An interrupted earlier migration left only the patch half in the durable store.
  writeFileSync(join(patchDir, `${patchId}.patch`), 'partial destination copy\n')

  assert.equal(migrateLegacyPatches(legacyDir, patchDir, { log: () => {} }), 1)
  assert.equal(readFileSync(join(patchDir, `${patchId}.patch`), 'utf8'), 'complete legacy patch\n')
  assert.equal(readFileSync(join(patchDir, `${patchId}.json`), 'utf8'), meta)
  assert.equal(existsSync(legacyDir), false)
})

test('a migration deferred for a live old server lists and applies legacy patches in place, then retries on the sweep', async () => {
  const repo = makeRepo()
  const digest = rootDigest(repo)
  // A real patch, collected by a pool that wrote it to the durable store as this release does.
  const seedDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-iso-defer-seed-')))
  const seed = new WorkspaceIsolation({ root: repo, slots: 1, stateDir: seedDir })
  const slot = await seed.lease()
  seed.prepare(slot)
  writeFileSync(join(slot.dir, 'keep.txt'), 'the deferred fix\n')
  const change = seed.collect(slot)
  const seedPatchDir = seed.patchDir
  seed.close()

  // Lay it out where an OLD server keeps it: under this root's digest in the temp base.
  const legacyDir = join(canonicalTmpdir(), 'flash-mcp', digest, 'patches')
  mkdirSync(legacyDir, { recursive: true })
  for (const suffix of ['.patch', '.json', '.blobs']) {
    const from = join(seedPatchDir, `${change.patchId}${suffix}`)
    if (existsSync(from)) renameSync(from, join(legacyDir, `${change.patchId}${suffix}`))
  }
  // Another live process still owns state for this root: the old server, whose in-memory
  // `patchPath` points into `legacyDir`. `process.ppid` is alive for the whole test.
  const oldOwner = join(canonicalTmpdir(), 'flash-mcp', digest, String(process.ppid))
  mkdirSync(oldOwner, { recursive: true })

  const logLines = []
  const next = new WorkspaceIsolation({ root: repo, slots: 1, sweepIntervalMs: 20, log: (message) => logLines.push(message) })
  try {
    const deferred = logLines.find((message) => message.includes('deferred moving stored patches'))
    assert.ok(deferred, `expected a deferral log line in ${JSON.stringify(logLines)}`)
    assert.match(deferred, new RegExp(`process\\(es\\) ${String(process.ppid)}`))
    assert.ok(deferred.includes(legacyDir), deferred)
    assert.equal(existsSync(join(next.patchDir, `${change.patchId}.json`)), false, 'nothing moved under a live old server')

    // The new pool lists the legacy patch and applies it without moving a byte.
    assert.ok(next.listPatches().some((record) => record.patchId === change.patchId), 'the legacy patch is listed in place')
    assert.equal(next.apply({ patchId: change.patchId }).applied, true)
    assert.equal(readFileSync(join(repo, 'keep.txt'), 'utf8'), 'the deferred fix\n')
    // Marking it applied wrote next to the record it came from, never into the durable store.
    const legacyMeta = JSON.parse(readFileSync(join(legacyDir, `${change.patchId}.json`), 'utf8'))
    assert.notEqual(legacyMeta.appliedAt, null, 'the applied marker lives in the legacy record')
    assert.equal(existsSync(join(next.patchDir, `${change.patchId}.json`)), false, 'the record was not split across stores')

    // The old server exits; the pool's periodic sweep now moves the patch and reloads it.
    rmSync(oldOwner, { recursive: true, force: true })
    await waitFor(() => existsSync(join(next.patchDir, `${change.patchId}.json`)))
    assert.equal(existsSync(join(legacyDir, `${change.patchId}.json`)), false, 'the record left the legacy store')
    const migrated = next.listPatches().find((record) => record.patchId === change.patchId)
    assert.ok(migrated, 'the migrated patch is still listed after the reload')
    assert.equal(migrated.patchPath, join(next.patchDir, `${change.patchId}.patch`), 'the reloaded record names the durable store')
    assert.notEqual(migrated.appliedAt, null, 'the applied marker travelled with the record')
  } finally {
    next.close()
    rmSync(oldOwner, { recursive: true, force: true })
    rmSync(join(canonicalTmpdir(), 'flash-mcp', digest), { recursive: true, force: true })
  }
})

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

test('a call in a linked worktree is scoped to it, and the copy is its own repository', async () => {
  const root = makeWorkspace()
  const alpha = join(root, 'Repos', 'alpha')
  const side = join(root, 'Repos', 'alpha-side')
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'side', side], { cwd: alpha })
  const { isolation } = makePool(root)

  const slot = await isolation.lease()
  const prepared = isolation.prepare(slot, { cwd: side })
  assert.equal(prepared.scope, join('Repos', 'alpha-side'))
  assert.notEqual(prepared.base, null)
  const copy = join(slot.dir, 'Repos', 'alpha-side')
  // A repository of its own, on the same commit and branch, reading the original's objects.
  assert.equal(statSync(join(copy, '.git')).isDirectory(), true)
  const head = (dir) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  assert.equal(head(copy), head(side))
  assert.equal(execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: copy, encoding: 'utf8' }).trim(), 'side')

  writeFileSync(join(copy, 'app.txt'), 'changed in the worktree copy\n')
  const change = isolation.collect(slot)
  assert.deepEqual(change.filesChanged.map((line) => line.split('\t').at(-1)), ['app.txt'])
  // Nothing reached the caller's worktree, its index, or its repository's refs.
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: side, encoding: 'utf8' }), '')
  assert.throws(() => execFileSync('git', ['rev-parse', '--verify', '-q', 'refs/flash/base'], { cwd: alpha, stdio: 'ignore' }))
  isolation.apply({ patchId: change.patchId })
  assert.equal(readFileSync(join(side, 'app.txt'), 'utf8'), 'changed in the worktree copy\n')
  isolation.release(slot)

  // A call at the root keeps the whole-root copy, and the worktree stays out of it: its
  // absolute pointer would lead a worker's git back to the caller's repository.
  const again = await isolation.lease()
  assert.equal(isolation.prepare(again, { cwd: root }).scope, '')
  assert.equal(existsSync(join(again.dir, 'keep.txt')), true)
  assert.equal(existsSync(join(again.dir, 'Repos', 'alpha', 'app.txt')), true)
  assert.equal(existsSync(join(again.dir, 'Repos', 'alpha-side')), false)
  isolation.close()
})

test('a root that is itself a linked worktree never writes to the caller’s repository', async () => {
  // A Claude Code worktree session: the service root is `.claude/worktrees/<name>`.
  const main = makeRepo()
  const root = join(main, '.claude', 'worktrees', 'agent-1')
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'agent-1', root], { cwd: main })
  const { isolation } = makePool(root)
  const slot = await isolation.lease()
  assert.notEqual(isolation.prepare(slot).base, null)
  writeFileSync(join(slot.dir, 'worker.txt'), 'made by the worker\n')
  // A worker committing in its copy commits to the copy.
  execFileSync('git', ['add', 'worker.txt'], { cwd: slot.dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'worker'], { cwd: slot.dir })
  const change = isolation.collect(slot)
  assert.deepEqual(change.filesChanged.map((line) => line.split('\t').at(-1)), ['worker.txt'])

  // The caller's index was staging the worker's files before this was fixed.
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '')
  assert.equal(execFileSync('git', ['log', '--format=%s', '-1', 'agent-1'], { cwd: main, encoding: 'utf8' }).trim(), 'init')
  assert.throws(() => execFileSync('git', ['rev-parse', '--verify', '-q', 'refs/flash/base'], { cwd: main, stdio: 'ignore' }))
  isolation.apply({ patchId: change.patchId })
  assert.equal(readFileSync(join(root, 'worker.txt'), 'utf8'), 'made by the worker\n')
  isolation.close()
})

test('a removed nested worktree cannot fail a whole-root call', async () => {
  // The handoff's case: agent worktrees under `.claude/worktrees` were copied into every
  // slot, and once the caller removed them their dangling `.git` files failed `git add -A`.
  const root = makeRepo()
  writeFileSync(join(root, '.gitignore'), '.claude/\n')
  const nested = join(root, '.claude', 'worktrees', 'agent-x')
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'agent-x', nested], { cwd: root })
  rmSync(join(root, '.git', 'worktrees'), { recursive: true, force: true })
  const { isolation } = makePool(root)
  const slot = await isolation.lease()
  assert.notEqual(isolation.prepare(slot).base, null)
  assert.equal(existsSync(join(slot.dir, '.claude', 'worktrees', 'agent-x')), false)
  writeFileSync(join(slot.dir, 'worker.txt'), 'x\n')
  const change = isolation.collect(slot)
  assert.equal(change.available, true)
  assert.deepEqual(change.filesChanged.map((line) => line.split('\t').at(-1)), ['worker.txt'])
  isolation.close()
})

test('a submodule travels with the copy', async () => {
  const upstream = makeRepo()
  const root = makeRepo()
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'sub'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'sub'], { cwd: root })
  const { isolation } = makePool(root)
  const slot = await isolation.lease()
  assert.notEqual(isolation.prepare(slot).base, null)
  // Its `.git` file is relative and resolves inside the copy, so it means the same there.
  assert.equal(readFileSync(join(slot.dir, 'sub', 'keep.txt'), 'utf8'), 'keep me\n')
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: join(slot.dir, 'sub'), encoding: 'utf8' }), '')
  isolation.close()
})

test('a dead owner is swept while the pool runs, before the next call and on the timer', async () => {
  const repo = makeRepo()
  // Default layout, so the pool owns its state and sweeps its root's dead owners.
  const isolation = new WorkspaceIsolation({ root: repo, slots: 1, sweepIntervalMs: 0 })
  const first = makeDeadOwner(repo, { pid: 4194299 })
  makeFlashBaseTree(first.slotDir)
  writeFileSync(join(first.slotDir, 'keep.txt'), 'unfinished work\n')
  const slot = await isolation.lease()
  isolation.prepare(slot)
  assert.equal(existsSync(first.owner), false)
  // What the sweep salvaged is applicable from this server at once.
  assert.ok(salvagedPatch(isolation), 'the dead owner’s work was salvaged and loaded')
  isolation.release(slot)
  isolation.close()

  const timed = new WorkspaceIsolation({ root: repo, slots: 1, sweepIntervalMs: 20 })
  const second = makeDeadOwner(repo, { pid: 4194298 })
  const deadline = Date.now() + 2_000
  while (existsSync(second.owner) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
  assert.equal(existsSync(second.owner), false)
  timed.close()
})

test('the cap removes retired trees, then applied patches, and never an unapplied one', async () => {
  const repo = makeRepo()
  const { isolation } = makePool(repo, 1)
  const make = async (name, content) => {
    const slot = await isolation.lease()
    isolation.prepare(slot)
    writeFileSync(join(slot.dir, name), content)
    const change = isolation.collect(slot)
    isolation.release(slot)
    return change
  }
  const big = 'x'.repeat(20_000)
  const applied = await make('applied.txt', big)
  isolation.apply({ patchId: applied.patchId })
  const kept = await make('kept.txt', big)
  // A retired tree, as a timed-out call leaves one.
  const slot = await isolation.lease()
  isolation.prepare(slot)
  writeFileSync(join(slot.dir, 'weight.bin'), big)
  isolation.retire(slot)
  const orphan = slot.orphans[0]
  isolation.release(slot)

  isolation.maxStateBytes = 1
  const logs = []
  isolation.log = (line) => logs.push(line)
  const result = isolation.trim()
  assert.equal(result.removedTrees, 1)
  assert.equal(result.removedPatches, 1)
  assert.equal(existsSync(orphan), false)
  assert.deepEqual(isolation.listPatches().map((record) => record.patchId), [kept.patchId])
  assert.equal(existsSync(kept.patchPath), true)
  assert.ok(logs.some((line) => /over the .* cap/.test(line)), 'the remaining excess is reported')

  // Under the cap nothing goes.
  isolation.maxStateBytes = 10 * 1024 ** 3
  assert.deepEqual(isolation.trim(), { bytes: result.bytes, removedTrees: 0, removedPatches: 0 })
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

test('scratch inside a scoped repository never reaches the patch', async () => {
  const root = makeWorkspace()
  const { isolation } = makePool(root)
  const slot = await isolation.lease()
  isolation.prepare(slot, { cwd: join(root, 'Repos', 'alpha') })
  const copy = join(slot.dir, 'Repos', 'alpha')
  mkdirSync(join(copy, '.flash-tmp'), { recursive: true })
  writeFileSync(join(copy, '.flash-tmp', 'notes.patch'), 'scratch\n')
  writeFileSync(join(copy, 'app.txt'), 'real change\n')
  const change = isolation.collect(slot)
  assert.deepEqual(change.filesChanged.map((line) => line.split('\t').at(-1)), ['app.txt'])
  isolation.close()
})
