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
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { test } from 'node:test'

import {
  SETTINGS_CHANGED_WARNING,
  SWEEP_INTERVAL_MS,
  WorkspaceIsolation,
  canonicalTmpdir,
  defaultStateDir,
  durableBaseDir,
  migrateLegacyPatches,
  rootDigest,
  slotPathWarning,
  slotRootPath,
} from '../lib/isolation.js'

/**
 * Patches default to the durable data directory. Keep every default-layout pool in this
 * file out of the real user data directory, whichever platform the suite runs on.
 */
process.env.FLASH_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'flash-iso-data-')))

/**
 * The state base every default-layout pool in this file is given, so a test never plants a
 * dead owner (or a slot tree) under the real `$TMPDIR/flash-mcp`.
 */
const STATE_BASE = realpathSync(mkdtempSync(join(tmpdir(), 'flash-iso-base-')))

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
 * Lay out a dead owner with one slot tree under `repo`'s default layout, and return the
 * paths so a test can populate the tree.
 *
 * The layout is the real one a server writes: `<base>/<digest>/<pid>/<instance>/slots/<name>`.
 * It is derived through `defaultStateDir`, the same function the constructor uses, so a
 * test cannot plant a dead owner one directory away from where the sweep looks — the
 * mistake that made salvage silently delete a crashed server's work.
 *
 * @param {string} repo - the service root.
 * @param {object} [options] - dead owner pid, slot name and instance nonce.
 * @param {string} [options.baseDir] - the injected state base.
 * @param {number} [options.pid] - the dead owner's pid.
 * @param {string} [options.instance] - the 8-hex per-pool nonce.
 * @param {string} [options.slot] - the slot directory name.
 * @returns {{owner: string, parent: string, instance: string, stateDir: string,
 *   slotDir: string}} the dead owner paths.
 */
function makeDeadOwner(repo, { baseDir = STATE_BASE, pid = 4194303, instance = 'dead0001', slot = 'slot-0' } = {}) {
  const parent = join(baseDir, rootDigest(repo))
  const stateDir = defaultStateDir(repo, { baseDir, pid, instance })
  const slotDir = join(stateDir, 'slots', slot)
  mkdirSync(slotDir, { recursive: true })
  return { owner: join(parent, String(pid)), parent, instance, stateDir, slotDir }
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
  const first = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1 })
  const second = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1 })
  try {
    assert.notEqual(first.stateDir, second.stateDir)
    const slot = await first.lease()
    first.prepare(slot)
    writeFileSync(join(slot.dir, 'in-flight.txt'), 'a worker is writing here\n')
    assert.equal(existsSync(join(slot.dir, 'in-flight.txt')), true)

    // Starting the second service must not clear the first one's in-flight tree.
    const other = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1 })
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
  const pool = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1 })
  try {
    assert.equal(pool.patchDir, join(process.env.FLASH_DATA_DIR, digest, 'patches'))
    const slot = await pool.lease()
    pool.prepare(slot)
    writeFileSync(join(slot.dir, 'durable.txt'), 'survives a reboot\n')
    const change = pool.collect(slot)

    // The patch is in the durable store, and not in the temp layout.
    assert.equal(existsSync(join(pool.patchDir, `${change.patchId}.patch`)), true)
    assert.equal(existsSync(join(pool.patchDir, `${change.patchId}.json`)), true)
    const legacyDir = join(STATE_BASE, digest, 'patches')
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
  const first = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE })
  const slot = await first.lease()
  first.prepare(slot)
  writeFileSync(join(slot.dir, 'from-worker.txt'), 'work worth keeping\n')
  const change = first.collect(slot)
  first.release(slot)
  assert.equal(change.available, true)

  const pidDir = dirname(first.stateDir)
  assert.ok(!first.patchDir.startsWith(pidDir + sep), `${first.patchDir} must not sit under ${pidDir}`)

  // A dead owner's leftovers in the real layout, then the next service starting on the
  // same root. The pid is above every platform maximum, so it can never name a live process.
  const deadState = defaultStateDir(repo, { baseDir: STATE_BASE, pid: 4194303, instance: 'dead0001' })
  const deadOwner = dirname(deadState)
  mkdirSync(join(deadState, 'slots', 'slot-0'), { recursive: true })
  const second = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE })
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
  const next = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, log: (message) => logLines.push(message) })
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

  const next = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1 })
  try {
    assert.equal(existsSync(owner), false, 'the clean dead owner is still removed')
    assert.equal(existsSync(slotDir), false)
    assert.equal(salvagedPatch(next), undefined, 'a clean slot must not produce a patch')
  } finally {
    next.close()
  }
})

test('a salvaged patch carries the task the dead copy was working on', async () => {
  const repo = makeRepo()
  const { slotDir } = makeDeadOwner(repo)
  makeFlashBaseTree(slotDir)
  // A label long enough to be a real task, and short enough that bounding leaves it whole.
  const label = 'Rebuild the vendored Windows installer cache ' + 'and verify every hashed artefact '.repeat(4)
  assert.ok(label.length > 150)
  // `prepare` writes this file; a worker could also have written it, which is why salvage
  // re-validates it.
  writeFileSync(
    join(slotDir, '.git', 'flash-task.json'),
    `${JSON.stringify({ kind: 'flash_batch', label, sessionId: 'sess-salvage', jobId: 'job-7', taskFile: '/tasks/installer.md', extra: 'dropped' })}\n`,
  )
  writeFileSync(join(slotDir, 'keep.txt'), 'the lost fix\n')

  const logLines = []
  const next = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, log: (message) => logLines.push(message) })
  try {
    const record = salvagedPatch(next)
    assert.ok(record, 'the dead tree is still salvaged')
    assert.equal(record.task.kind, 'flash_batch')
    assert.equal(record.task.label, label.trim())
    assert.equal(record.task.sessionId, 'sess-salvage')
    assert.equal(record.task.jobId, 'job-7')
    assert.equal(record.task.taskFile, '/tasks/installer.md')
    assert.equal(record.task.extra, undefined, 'an unknown key never reaches the record')

    // The record travels on disk with it, and reads back through the ordinary path.
    const meta = JSON.parse(readFileSync(join(next.patchDir, `${record.patchId}.json`), 'utf8'))
    assert.deepEqual(meta.task, record.task)
    assert.equal(next.readPatch({ patchId: record.patchId, maxChars: 100000 }).task.label, label.trim())

    // One salvage line, now saying which task the work was for.
    const line = logLines.find((entry) => entry.startsWith('salvaged '))
    assert.ok(line, `expected a salvage log line in ${JSON.stringify(logLines)}`)
    assert.ok(line.includes(`for "${label.trim()}"`), `the salvage line names the task: ${line}`)
    assert.doesNotMatch(line, /\n/)
  } finally {
    next.close()
  }
})

test('a dead tree with a malformed or oversized task file still salvages, without a task', async () => {
  const repo = makeRepo()
  const { owner, slotDir } = makeDeadOwner(repo)
  makeFlashBaseTree(slotDir)
  writeFileSync(join(slotDir, '.git', 'flash-task.json'), 'not json{')
  writeFileSync(join(slotDir, 'keep.txt'), 'malformed task\n')
  // A second slot under the same dead owner, whose task file is over the 16 KB limit.
  const oversizedSlot = join(dirname(slotDir), 'slot-1')
  mkdirSync(oversizedSlot, { recursive: true })
  makeFlashBaseTree(oversizedSlot)
  writeFileSync(join(oversizedSlot, '.git', 'flash-task.json'), 'x'.repeat(17 * 1024))
  writeFileSync(join(oversizedSlot, 'keep.txt'), 'oversized task\n')

  const logLines = []
  const next = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, log: (message) => logLines.push(message) })
  try {
    const records = next.listPatches().filter((record) => record.salvagedFrom !== undefined)
    assert.equal(records.length, 2, 'both trees are salvaged despite their task files')
    for (const record of records) assert.equal(record.task, undefined)
    assert.deepEqual(
      records.map((record) => record.salvagedFrom.slotDir).sort(),
      [slotDir, oversizedSlot].sort(),
    )
    // Each unusable file is named once, so a caller can see why a record has no task.
    assert.equal(logLines.filter((line) => line.includes('flash-task.json')).length, 2)
  } finally {
    next.close()
  }
})

// ── deferred start-up sweep, trash and retried salvage ──────────────────────

test('a deferred start-up sweep leaves a dead owner alone until startupSweep salvages it', async () => {
  // The failure this guards: the constructor migrated, salvaged and `rmSync`ed every dead
  // owner before `serveStdio` answered `initialize`. A slot holding a multi-gigabyte
  // `cargo target` took minutes to delete, the client's 30 s connect timeout expired, and
  // the next start repeated the work. Construction must now touch none of it.
  const repo = makeRepo()
  const { owner, slotDir } = makeDeadOwner(repo, { pid: 4194305 })
  makeFlashBaseTree(slotDir)
  writeFileSync(join(slotDir, 'keep.txt'), 'the deferred fix\n')

  const logLines = []
  const isolation = new WorkspaceIsolation({
    root: repo,
    slots: 1,
    baseDir: STATE_BASE,
    sweepIntervalMs: 0,
    deferStartupSweep: true,
    log: (message) => logLines.push(message),
  })
  try {
    assert.equal(isolation.deferStartupSweep, true)
    assert.equal(existsSync(owner), true, 'construction does not touch the dead owner')
    assert.equal(existsSync(slotDir), true, 'the dead tree is still there')
    assert.deepEqual(isolation.listPatches(), [], 'nothing is loaded before the sweep')

    const sweep = isolation.startupSweep()
    assert.equal(isolation.startupSweep(), sweep, 'a second call returns the same promise')
    await sweep

    assert.equal(isolation.startupSweepDone, true)
    assert.equal(existsSync(owner), false, 'the sweep salvaged the work and removed the owner')
    const record = salvagedPatch(isolation)
    assert.ok(record, 'the salvaged patch was loaded when the sweep finished')
    assert.equal(record.salvagedFrom.slotDir, slotDir)
    const summary = logLines.find((line) => line.startsWith('startup sweep finished'))
    assert.ok(summary, `expected a summary log line in ${JSON.stringify(logLines)}`)
    assert.match(summary, /1 patch\(es\) salvaged/)
    assert.match(summary, /1 dead owner\(s\) salvaged/)
  } finally {
    isolation.close()
  }
})

test('lease waits for the deferred sweep instead of copying while it might still reclaim disk', async () => {
  const repo = makeRepo()
  const { owner, slotDir } = makeDeadOwner(repo, { pid: 4194306 })
  makeFlashBaseTree(slotDir)
  writeFileSync(join(slotDir, 'keep.txt'), 'waited for\n')

  const isolation = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, sweepIntervalMs: 0, deferStartupSweep: true })
  try {
    // Lease first, sweep started but not awaited here: the call may only hold a tree once
    // the sweep is done, so `prepare` cannot copy beside a reclamation.
    const sweep = isolation.startupSweep()
    const slot = await isolation.lease()
    try {
      assert.equal(isolation.startupSweepDone, true, 'the sweep finished before the tree was handed out')
      assert.equal(existsSync(owner), false, 'the dead owner was reclaimed before the lease resolved')
      assert.ok(salvagedPatch(isolation), 'the salvaged patch is loaded before the call prepares')
      assert.equal(typeof slot.id, 'number')
    } finally {
      isolation.release(slot)
    }
    await sweep
  } finally {
    isolation.close()
  }
})

test('a patch salvaged by a deferred sweep is readable by id before another pool has loaded it', async () => {
  const repo = makeRepo()
  const { slotDir } = makeDeadOwner(repo, { pid: 4194307 })
  makeFlashBaseTree(slotDir)
  writeFileSync(join(slotDir, 'new.txt'), 'only in the patch\n')

  const first = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, sweepIntervalMs: 0, deferStartupSweep: true })
  let record
  try {
    await first.startupSweep()
    record = salvagedPatch(first)
    assert.ok(record, 'the dead tree was salvaged')
  } finally {
    first.close()
  }

  // A later pool defers its own sweep, so nothing is in memory: the full id must still
  // resolve from the store on disk, or a patch just announced to the caller would be
  // unreachable until a sweep it never asked for finished.
  const later = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, sweepIntervalMs: 0, deferStartupSweep: true })
  try {
    assert.deepEqual(later.listPatches(), [], 'the deferred pool has loaded nothing')
    const read = later.readPatch({ patchId: record.patchId, maxChars: 100000 })
    assert.equal(read.patchId, record.patchId)
    assert.match(read.diff, /only in the patch/)
    assert.equal(later.apply({ patchId: record.patchId }).applied, true)
    assert.equal(readFileSync(join(repo, 'new.txt'), 'utf8'), 'only in the patch\n')
  } finally {
    later.close()
  }
})

test('a deferred sweep does the legacy migration it deferred', async () => {
  const repo = makeRepo()
  const digest = rootDigest(repo)
  const legacyDir = join(STATE_BASE, digest, 'patches')
  mkdirSync(legacyDir, { recursive: true })
  const patchId = writePatchRecord(legacyDir, repo, { createdAt: Date.now() })

  const isolation = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, sweepIntervalMs: 0, deferStartupSweep: true })
  try {
    assert.equal(existsSync(join(legacyDir, `${patchId}.json`)), true, 'construction leaves the legacy store alone')
    assert.deepEqual(isolation.listPatches(), [])
    await isolation.startupSweep()
    assert.equal(existsSync(join(legacyDir, `${patchId}.json`)), false, 'the sweep moved the legacy record')
    assert.ok(isolation.listPatches().some((record) => record.patchId === patchId), 'the moved patch is loaded')
  } finally {
    isolation.close()
    rmSync(join(STATE_BASE, digest), { recursive: true, force: true })
  }
})

test('a deferred sweep keeps a dead owner whose slot could not be salvaged', async () => {
  const repo = makeRepo()
  const { owner, slotDir } = makeDeadOwner(repo, { pid: 4194311 })
  makeFlashBaseTree(slotDir)
  writeFileSync(join(slotDir, '.git', 'HEAD'), 'not a commit\n')

  const isolation = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, sweepIntervalMs: 0, deferStartupSweep: true })
  try {
    await isolation.startupSweep()
    assert.equal(existsSync(owner), true, 'the owner survives an unreadable slot')
    assert.equal(JSON.parse(readFileSync(join(owner, 'salvage-attempts'), 'utf8')).attempts, 1)
  } finally {
    isolation.close()
  }
})

test('a dead owner is renamed to trash and deleted in the background', async () => {
  const repo = makeRepo()
  const { owner, parent } = makeDeadOwner(repo, { pid: 4194308 })
  const logLines = []
  const isolation = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, sweepIntervalMs: 0, log: (message) => logLines.push(message) })
  try {
    assert.equal(existsSync(owner), false, 'the owner is out of the accounting at once')
    const line = logLines.find((entry) => entry.includes('renamed dead owner'))
    assert.ok(line, `expected a rename log line in ${JSON.stringify(logLines)}`)
    const match = /renamed dead owner \d+ to (.+); removing it in the background/.exec(line)
    assert.ok(match, `expected the trash path in ${line}`)
    const trashDir = match[1]
    assert.match(trashDir, new RegExp(`trash-4194308-\\d+$`), 'the trash name keeps the owner pid and a timestamp')
    assert.ok(trashDir.startsWith(parent + sep), `${trashDir} must sit in ${parent}`)
    // The sweep does not await the deletion; a bounded poll observes it settling.
    await waitFor(() => !existsSync(trashDir))
  } finally {
    isolation.close()
  }
})

test('a sweep adopts the trash an interrupted removal left behind', async () => {
  const repo = makeRepo()
  const { owner, parent } = makeDeadOwner(repo, { pid: 4194309 })
  // The owner directory itself is not part of this test: only the trash from an earlier
  // crash, renamed but never deleted, is planted.
  rmSync(owner, { recursive: true, force: true })
  const leftover = join(parent, 'trash-4194309-1700000000000')
  mkdirSync(join(leftover, 'slots', 'slot-0'), { recursive: true })
  writeFileSync(join(leftover, 'slots', 'slot-0', 'left.txt'), 'left behind\n')

  const logLines = []
  const isolation = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, sweepIntervalMs: 0, log: (message) => logLines.push(message) })
  try {
    assert.ok(logLines.some((line) => line.includes(leftover)), `the leftover trash is named in ${JSON.stringify(logLines)}`)
    await waitFor(() => !existsSync(leftover))
    assert.equal(logLines.some((line) => line.startsWith('salvaged ')), false, 'trash is never offered to salvage')
  } finally {
    isolation.close()
  }
})

test('trim neither measures nor counts trash, so it cannot trim to pay for it', async () => {
  const repo = makeRepo()
  const isolation = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, sweepIntervalMs: 0 })
  // A removal that is still in flight, or one an earlier crash left. It is disk in use, but
  // a background removal is already freeing it, so measuring it here was a synchronous walk
  // of the whole tree whose bytes then made `trim` delete live state to pay for space that
  // was on its way back anyway.
  const digestDir = join(STATE_BASE, rootDigest(repo))
  const trash = join(digestDir, 'trash-4242-1700000000000')
  mkdirSync(trash, { recursive: true })
  writeFileSync(join(trash, 'left.bin'), 'x'.repeat(4096))
  try {
    isolation.maxStateBytes = 1024
    const result = isolation.trim()
    assert.equal(result.bytes, 0, 'trash is not part of what trim measures')
    assert.equal(result.removedTrees, 0)
    assert.equal(result.removedPatches, 0)
    assert.equal(existsSync(trash), true, 'trim leaves the deletion to the background removal')
    assert.equal(isolation.trim().bytes, 0, 'the measured state does not depend on the trash size')
  } finally {
    rmSync(trash, { recursive: true, force: true })
    isolation.close()
  }
})

test('a dead owner whose salvage fails is kept and retried, and its stored sibling is never duplicated', async () => {
  const repo = makeRepo()
  const { owner, slotDir, instance } = makeDeadOwner(repo, { pid: 4194310 })
  makeFlashBaseTree(slotDir)
  writeFileSync(join(slotDir, 'keep.txt'), 'sibling work\n')
  // A second slot whose git state cannot be read: `findFlashBase` runs `git log`, which a
  // corrupt HEAD makes fail, so that one slot's salvage throws.
  const broken = join(dirname(slotDir), 'slot-1')
  mkdirSync(broken, { recursive: true })
  makeFlashBaseTree(broken)
  writeFileSync(join(broken, 'keep.txt'), 'unreadable work\n')
  writeFileSync(join(broken, '.git', 'HEAD'), 'not a commit\n')
  const attemptsFile = join(owner, 'salvage-attempts')
  const readAttempts = () => JSON.parse(readFileSync(attemptsFile, 'utf8'))
  // A retry is only due after the sweep interval; each further attempt here rewrites the
  // clock rather than waiting ten minutes for it.
  const ageAttempt = () => {
    writeFileSync(attemptsFile, `${JSON.stringify({ ...readAttempts(), lastAttemptAt: Date.now() - SWEEP_INTERVAL_MS - 1 })}\n`)
  }
  const siblingPatches = (isolation) => isolation.listPatches().filter((record) => record.salvagedFrom?.slotDir === slotDir)

  const firstLogs = []
  const first = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, sweepIntervalMs: 0, log: (message) => firstLogs.push(message) })
  try {
    assert.equal(existsSync(owner), true, 'one failed slot must not delete the owner')
    assert.ok(firstLogs.some((line) => line.includes(`could not salvage ${broken}`)), 'the failure is named')
    assert.ok(firstLogs.some((line) => line.includes('keeping dead owner')), 'the owner is kept and explained')
    const record = readAttempts()
    assert.equal(record.attempts, 1)
    // The label names the instance, so two instances' `slot-0` cannot be confused.
    assert.deepEqual(record.salvaged, [`${instance}/slots/slot-0`])
    assert.equal(typeof record.lastAttemptAt, 'number', 'the attempt is timestamped, so retries can be spaced')
    assert.equal(siblingPatches(first).length, 1, 'the readable sibling was salvaged on the first attempt')
  } finally {
    first.close()
  }

  ageAttempt()
  const second = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, sweepIntervalMs: 0 })
  try {
    assert.equal(existsSync(owner), true, 'the second failed attempt still keeps the owner')
    assert.equal(readAttempts().attempts, 2)
    assert.equal(siblingPatches(second).length, 1, 'the sibling tree was not stored a second time')
  } finally {
    second.close()
  }

  ageAttempt()

  const thirdLogs = []
  const third = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, sweepIntervalMs: 0, log: (message) => thirdLogs.push(message) })
  try {
    assert.equal(existsSync(owner), false, 'after three failed attempts the owner is removed anyway')
    const lost = thirdLogs.find((line) => line.includes('is lost'))
    assert.ok(lost, `expected a lost-work log line in ${JSON.stringify(thirdLogs)}`)
    assert.ok(lost.includes(broken), 'the line names the slot whose work is lost')
    assert.match(lost, /3 failed salvage attempts/)
    assert.equal(siblingPatches(third).length, 1, 'still exactly one patch for the sibling, across all three sweeps')
  } finally {
    third.close()
  }
})

test('a dead owner laid out by a real pool is salvaged from its instance directory', async () => {
  // The defect this pins: a server's slots live in `<pid>/<instance>/slots/<name>`, and a
  // sweep that looked at `<pid>/slots/<name>` found nothing, judged the dead owner clean
  // and removed the whole directory with the uncommitted work still in it. The directory
  // here is not hand-built: a real pool computes it, `prepare` builds the tree and the
  // task file, and only then is the pid level moved under a dead pid, which is exactly
  // what a crashed server leaves behind.
  const repo = makeRepo()
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'flash-iso-real-')))
  const anchor = new WorkspaceIsolation({ root: repo, slots: 1, baseDir: base, sweepIntervalMs: 0 })
  const instance = anchor.stateDir.split(sep).pop()
  const slot = await anchor.lease()
  anchor.prepare(slot, { task: { kind: 'flash_task', label: 'the crashed pool’s task' } })
  writeFileSync(join(slot.dir, 'keep.txt'), 'work from a real prepared slot\n')
  anchor.release(slot)
  const livePidDir = dirname(anchor.stateDir)
  const deadPidDir = join(base, rootDigest(repo), '4194303')
  // Renamed before `close()`: close only removes this pool's own state directory, which is
  // no longer at its recorded path, so the dead owner's tree survives for the next sweep.
  renameSync(livePidDir, deadPidDir)
  anchor.close()
  const deadSlot = join(deadPidDir, instance, 'slots', 'slot-0')

  const next = new WorkspaceIsolation({ root: repo, slots: 1, baseDir: base, sweepIntervalMs: 0 })
  try {
    assert.equal(existsSync(deadPidDir), false, 'the dead owner is removed after the salvage')
    const record = salvagedPatch(next)
    assert.ok(record, 'the real layout is found and salvaged')
    assert.equal(record.salvagedFrom.slotDir, deadSlot)
    assert.equal(record.task.label, 'the crashed pool’s task', 'the task file inside the copy is carried')
    assert.match(readFileSync(record.patchPath, 'utf8'), /work from a real prepared slot/)
  } finally {
    next.close()
    rmSync(base, { recursive: true, force: true })
  }
})

test('a sweep salvages every instance under one dead pid, and labels them apart', () => {
  const repo = makeRepo()
  const first = makeDeadOwner(repo, { pid: 4194303, instance: 'dead0001', slot: 'slot-0' })
  makeFlashBaseTree(first.slotDir)
  writeFileSync(join(first.slotDir, 'keep.txt'), 'work from instance one\n')
  const second = makeDeadOwner(repo, { pid: 4194303, instance: 'dead0002', slot: 'slot-0' })
  makeFlashBaseTree(second.slotDir)
  writeFileSync(join(second.slotDir, 'keep.txt'), 'work from instance two\n')

  const next = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, sweepIntervalMs: 0 })
  try {
    const records = next.listPatches().filter((record) => record.salvagedFrom !== undefined)
    assert.equal(records.length, 2, 'both instances are salvaged, not only the first one found')
    assert.deepEqual(records.map((record) => record.salvagedFrom.slotDir).sort(), [first.slotDir, second.slotDir].sort())
    assert.equal(existsSync(first.owner), false)
  } finally {
    next.close()
  }
})

test('a dead owner from the older <pid>/slots layout is still salvaged', () => {
  // An older version kept slots one level up. A machine upgrading with a crashed server
  // still on disk has that layout, so the sweep must read it as well as the current one.
  const repo = makeRepo()
  const slotDir = join(STATE_BASE, rootDigest(repo), '4194303', 'slots', 'slot-0')
  mkdirSync(slotDir, { recursive: true })
  makeFlashBaseTree(slotDir)
  writeFileSync(join(slotDir, 'keep.txt'), 'older layout work\n')

  const next = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, sweepIntervalMs: 0 })
  try {
    const record = salvagedPatch(next)
    assert.ok(record, 'the older layout is still swept')
    assert.equal(record.salvagedFrom.slotDir, slotDir)
    assert.match(readFileSync(record.patchPath, 'utf8'), /older layout work/)
  } finally {
    next.close()
  }
})

test('a FIFO where the task file belongs is ignored without blocking the sweep', { skip: process.platform === 'win32' }, () => {
  // A FIFO at `.git/flash-task.json` used to pass the size check and block `readFileSync`
  // forever, which wedged the sweep and with it `lease`. The sweep is synchronous, so no
  // in-process timer can interrupt that block: the pool runs in a child process and the
  // boundary is the child's timeout, which fails this test instead of hanging the suite.
  const repo = makeRepo()
  const { slotDir } = makeDeadOwner(repo, { pid: 4194312 })
  makeFlashBaseTree(slotDir)
  execFileSync('mkfifo', [join(slotDir, '.git', 'flash-task.json')])
  writeFileSync(join(slotDir, 'keep.txt'), 'work beside a fifo\n')

  const moduleUrl = new URL('../lib/isolation.js', import.meta.url).href
  const script = `
    import { WorkspaceIsolation } from ${JSON.stringify(moduleUrl)}
    const isolation = new WorkspaceIsolation({
      root: ${JSON.stringify(repo)},
      baseDir: ${JSON.stringify(STATE_BASE)},
      slots: 1,
      sweepIntervalMs: 0,
      log: (message) => process.stderr.write(message + '\\n'),
    })
    const record = isolation.listPatches().find((entry) => entry.salvagedFrom !== undefined)
    if (record === undefined) {
      process.stderr.write('no salvaged patch\\n')
      process.exit(3)
    }
    process.stdout.write(JSON.stringify({ task: record.task ?? null, slotDir: record.salvagedFrom.slotDir }))
    isolation.close()
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 20_000,
  })
  // A blocked FIFO read never reaches its own assertion; the child is killed by the timeout
  // and that is the failure this test reports.
  assert.equal(child.error, undefined, `the sweep did not finish with a FIFO in the task file's place: ${String(child.error)}\n${child.stderr ?? ''}`)
  assert.equal(child.status, 0, `the sweep child failed: ${child.stderr ?? ''}`)
  assert.ok(child.stderr.includes('not a regular file'), 'the FIFO is named and ignored')
  const result = JSON.parse(child.stdout)
  assert.equal(result.task, null, 'a FIFO is not a task')
  assert.equal(result.slotDir, slotDir, 'the tree is still salvaged')
})

test('a symlinked task file is never followed', { timeout: 10_000 }, (t) => {
  // The path is worker-writable, and a symlink there could point `readFileSync` at any
  // file on disk. Only a regular file is read, so somebody else's JSON never becomes the
  // task of a salvaged patch.
  const repo = makeRepo()
  const { slotDir } = makeDeadOwner(repo, { pid: 4194313 })
  makeFlashBaseTree(slotDir)
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'flash-iso-task-')))
  const outsideTask = join(outside, 'task.json')
  writeFileSync(outsideTask, `${JSON.stringify({ kind: 'flash_task', label: 'somebody else’s task' })}\n`)
  try {
    symlinkSync(outsideTask, join(slotDir, '.git', 'flash-task.json'))
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('this platform does not allow creating a symlink')
      return
    }
    throw error
  }
  writeFileSync(join(slotDir, 'keep.txt'), 'work beside a symlink\n')

  const logs = []
  const next = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, sweepIntervalMs: 0, log: (message) => logs.push(message) })
  try {
    const record = salvagedPatch(next)
    assert.ok(record, 'the tree is salvaged despite the symlink')
    assert.equal(record.task, undefined, 'the link target was never read as a task')
    assert.ok(logs.some((line) => line.includes('not a regular file')), `the link is named in ${JSON.stringify(logs)}`)
  } finally {
    next.close()
    rmSync(outside, { recursive: true, force: true })
  }
})

test('a failed salvage is retried only after the sweep interval, so three calls count one attempt', async () => {
  const repo = makeRepo()
  const { owner, slotDir } = makeDeadOwner(repo, { pid: 4194314 })
  makeFlashBaseTree(slotDir)
  // A corrupt HEAD makes the salvage throw, which keeps the owner and records the attempt.
  writeFileSync(join(slotDir, '.git', 'HEAD'), 'not a commit\n')
  const attemptsFile = join(owner, 'salvage-attempts')

  const isolation = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, sweepIntervalMs: 0 })
  try {
    // The constructor's sweep is the first attempt.
    assert.equal(JSON.parse(readFileSync(attemptsFile, 'utf8')).attempts, 1)
    // `prepare` sweeps before every call; three calls in a row used to spend all three
    // attempts within seconds and delete the work.
    for (let call = 0; call < 3; call += 1) {
      const slot = await isolation.lease()
      try {
        isolation.prepare(slot)
      } finally {
        isolation.release(slot)
      }
    }
    const spaced = JSON.parse(readFileSync(attemptsFile, 'utf8'))
    assert.equal(spaced.attempts, 1, 'a recent failed attempt is skipped entirely, not counted again')
    assert.equal(existsSync(owner), true, 'the work is still there after three calls')
    // After the interval the next attempt is due and counts.
    writeFileSync(attemptsFile, `${JSON.stringify({ ...spaced, lastAttemptAt: Date.now() - SWEEP_INTERVAL_MS - 1 })}\n`)
    const later = await isolation.lease()
    try {
      isolation.prepare(later)
    } finally {
      isolation.release(later)
    }
    assert.equal(JSON.parse(readFileSync(attemptsFile, 'utf8')).attempts, 2)
  } finally {
    isolation.close()
  }
})

test("a kept owner's salvaged sibling is listed at once, without waiting for a removal", async () => {
  const repo = makeRepo()
  const isolation = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, sweepIntervalMs: 0 })
  try {
    const { owner, slotDir } = makeDeadOwner(repo, { pid: 4194315 })
    makeFlashBaseTree(slotDir)
    writeFileSync(join(slotDir, 'keep.txt'), 'readable sibling\n')
    const broken = join(dirname(slotDir), 'slot-1')
    mkdirSync(broken, { recursive: true })
    makeFlashBaseTree(broken)
    writeFileSync(join(broken, '.git', 'HEAD'), 'not a commit\n')

    const slot = await isolation.lease()
    try {
      isolation.prepare(slot)
      assert.equal(existsSync(owner), true, 'the unreadable slot keeps the owner')
      const record = salvagedPatch(isolation)
      assert.ok(record, 'the patch from the readable sibling is loaded by the sweep that kept the owner')
      assert.equal(record.salvagedFrom.slotDir, slotDir)
      assert.equal(isolation.readPatch({ patchId: record.patchId, maxChars: 100000 }).patchId, record.patchId)
    } finally {
      isolation.release(slot)
    }
  } finally {
    isolation.close()
  }
})

test('two sweeps in one process start one removal of the same trash', async () => {
  const repo = makeRepo()
  const logs = []
  const isolation = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, sweepIntervalMs: 0, log: (message) => logs.push(message) })
  try {
    const trash = join(STATE_BASE, rootDigest(repo), 'trash-4242-1700000000000')
    mkdirSync(join(trash, 'slots', 'slot-0'), { recursive: true })
    writeFileSync(join(trash, 'slots', 'slot-0', 'left.txt'), 'left behind\n')
    const slot = await isolation.lease()
    try {
      // Two sweeps in one tick: the first removal cannot have settled before the second
      // sweep runs, so a second `fs.promises.rm` would race the first over the same tree.
      isolation.prepare(slot)
      isolation.prepare(slot)
    } finally {
      isolation.release(slot)
    }
    const starts = logs.filter((line) => line.startsWith('removing ') && line.includes(trash))
    assert.equal(starts.length, 1, `one removal is started, not one per sweep: ${JSON.stringify(starts)}`)
    await waitFor(() => !existsSync(trash))
  } finally {
    isolation.close()
  }
})

test('lease gives up on a pending start-up sweep when its call is cancelled or out of time', async () => {
  const repo = makeRepo()
  // Empty slots cost one event-loop turn each, so the sweep cannot finish before the call
  // is asked to give up; nothing here needs a real git tree.
  const plantSlots = (pid, instance) => {
    for (let index = 0; index < 20; index += 1) {
      makeDeadOwner(repo, { pid, instance, slot: `slot-${String(index)}` })
    }
  }
  const deadOwner = (pid) => join(STATE_BASE, rootDigest(repo), String(pid))

  plantSlots(4194316, 'dead0003')
  const cancelledPool = new WorkspaceIsolation({ root: repo, slots: 1, baseDir: STATE_BASE, sweepIntervalMs: 0, deferStartupSweep: true })
  try {
    assert.equal(cancelledPool.startupSweepPending, true, 'the deferred sweep has not started yet')
    const sweep = cancelledPool.startupSweep()
    const controller = new AbortController()
    const waiting = cancelledPool.lease({ signal: controller.signal })
    controller.abort()
    await assert.rejects(waiting, (error) => error.code === 'CANCELLED' && /start-up sweep/.test(error.message))
    assert.equal(cancelledPool.startupSweepPending, true, 'the call gave up before the sweep finished, not after it')
    await sweep
    assert.equal(cancelledPool.startupSweepPending, false, 'the sweep the call gave up on kept going')
    assert.equal(existsSync(deadOwner(4194316)), false, 'and it still reclaimed the dead owner')
  } finally {
    cancelledPool.close()
  }

  plantSlots(4194317, 'dead0004')
  const timedPool = new WorkspaceIsolation({ root: repo, slots: 1, baseDir: STATE_BASE, sweepIntervalMs: 0, deferStartupSweep: true })
  try {
    const sweep = timedPool.startupSweep()
    await assert.rejects(
      timedPool.lease({ deadline: Date.now() - 1 }),
      (error) => error.code === 'TIMEOUT' && /start-up sweep/.test(error.message),
    )
    assert.equal(timedPool.startupSweepPending, true, 'an expired deadline does not wait for the sweep')
    await sweep
    assert.equal(timedPool.startupSweepPending, false)
    // A call that did not give up gets a tree once the sweep is done.
    const slot = await timedPool.lease()
    timedPool.release(slot)
  } finally {
    timedPool.close()
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
  const legacyDir = join(STATE_BASE, digest, 'patches')
  mkdirSync(legacyDir, { recursive: true })
  for (const suffix of ['.patch', '.json', '.blobs']) {
    const from = join(seed.patchDir, `${change.patchId}${suffix}`)
    if (existsSync(from)) renameSync(from, join(legacyDir, `${change.patchId}${suffix}`))
  }
  assert.equal(existsSync(join(legacyDir, `${change.patchId}.blobs`)), true, 'the collected patch has its preimage blobs')

  const logLines = []
  const next = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, log: (message) => logLines.push(message) })
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
    rmSync(join(STATE_BASE, digest), { recursive: true, force: true })
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
  const legacyDir = join(STATE_BASE, digest, 'patches')
  mkdirSync(legacyDir, { recursive: true })
  for (const suffix of ['.patch', '.json', '.blobs']) {
    const from = join(seedPatchDir, `${change.patchId}${suffix}`)
    if (existsSync(from)) renameSync(from, join(legacyDir, `${change.patchId}${suffix}`))
  }
  // Another live process still owns state for this root: the old server, whose in-memory
  // `patchPath` points into `legacyDir`. `process.ppid` is alive for the whole test.
  const oldOwner = join(STATE_BASE, digest, String(process.ppid))
  mkdirSync(oldOwner, { recursive: true })

  const logLines = []
  const next = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, sweepIntervalMs: 20, log: (message) => logLines.push(message) })
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
    rmSync(join(STATE_BASE, digest), { recursive: true, force: true })
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
  const anchor = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1 })
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

  const next = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1 })
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
    const canonical = realpathSync(tmpdir())
    assert.equal(canonicalTmpdir(), canonical)
    // The default path is computed, not constructed: creating a pool there would write into
    // the real temp state base this suite must leave alone. `defaultStateDir` is the same
    // function the constructor calls, so its shape is the layout a server really writes.
    const computed = defaultStateDir(repo)
    assert.equal(dirname(computed), join(canonical, 'flash-mcp', rootDigest(repo), String(process.pid)))
    assert.match(computed, /[\\/][0-9a-f]{8}$/, 'the per-pool instance is an 8-hex nonce')

    // The same shape under an injected base, which is what every default-layout test uses.
    const pool = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1 })
    try {
      assert.ok(
        pool.stateDir.startsWith(join(STATE_BASE, rootDigest(repo), String(process.pid)) + sep),
        `state dir ${pool.stateDir} is not under the injected base ${STATE_BASE}`,
      )
    } finally {
      pool.close()
    }
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
  const isolation = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, sweepIntervalMs: 0 })
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

  const timed = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, sweepIntervalMs: 20 })
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

  const isolation = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1 })
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

// ── an injected state base and the Windows slot-path advisory ──

test('an injected base keeps the slot layout under it and sweeps a dead owner there', () => {
  const repo = makeRepo()
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'flash-iso-base-option-')))
  try {
    const { owner, slotDir } = makeDeadOwner(repo, { baseDir: base })
    makeFlashBaseTree(slotDir)
    writeFileSync(join(slotDir, 'keep.txt'), 'the lost fix\n')

    const pool = new WorkspaceIsolation({ root: repo, baseDir: base, slots: 1 })
    try {
      // The layout is exactly `defaultStateDir` under the injected base, not under $TMPDIR.
      assert.ok(
        pool.stateDir.startsWith(join(base, rootDigest(repo), String(process.pid)) + sep),
        `the pool's state ${pool.stateDir} must sit under ${base}`,
      )
      assert.equal(pool.slots[0].dir, join(pool.stateDir, 'slots', 'slot-0'))
      assert.equal(existsSync(owner), false, 'the dead owner under the injected base is removed')
      assert.ok(salvagedPatch(pool), 'its unfinished work is salvaged as a patch')
    } finally {
      pool.close()
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
})

test('repoSettingsChanged sees a replacement that keeps the mtime, in either file', () => {
  const repo = makeRepo()
  const { isolation } = makePool(repo, 1)
  try {
    assert.deepEqual(isolation.repoSettingsChanged(), [], 'a repository without either file has not changed')
    const path = join(repo, '.flash-agents.json')
    writeFileSync(path, JSON.stringify({ copyExclude: ['dist'] }))
    assert.deepEqual(isolation.repoSettingsChanged(), ['.flash-agents.json'], 'a file created after start is a change')

    const started = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1 })
    assert.deepEqual(started.repoSettingsChanged(), [])
    const future = new Date(Date.now() + 2_000)
    utimesSync(path, future, future)
    assert.deepEqual(started.repoSettingsChanged(), ['.flash-agents.json'], 'a touched file is a change')

    // A different file renamed over the settings, with the original mtime put back: an
    // implementation comparing only mtimeMs calls this unchanged, and the server would
    // never tell the caller their new settings were ignored. The mtime is a whole second
    // so restoring it is exact, which makes the mtime-only failure deterministic.
    const fixed = new Date(Math.floor(Date.now() / 1000) * 1000)
    utimesSync(path, fixed, fixed)
    const stable = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1 })
    assert.deepEqual(stable.repoSettingsChanged(), [])
    const replacement = join(repo, '.flash-agents.next')
    writeFileSync(replacement, JSON.stringify({ copyExclude: ['build'] }))
    renameSync(replacement, path)
    utimesSync(path, fixed, fixed)
    assert.deepEqual(
      stable.repoSettingsChanged(),
      ['.flash-agents.json'],
      'a replaced file is a change even with its mtime restored',
    )

    // The per-machine file is watched the same way: appearing, changing and disappearing
    // after start are all changes the warning must name. A fresh pool starts from the
    // replacement above so only the local file differs here.
    const local = join(repo, '.flash-agents.local.json')
    const created = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1 })
    writeFileSync(local, JSON.stringify({ copyExclude: ['local-dist'] }))
    assert.deepEqual(created.repoSettingsChanged(), ['.flash-agents.local.json'], 'a local file created after start is a change')

    const edited = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1 })
    writeFileSync(local, JSON.stringify({ copyExclude: ['local-build'] }))
    assert.deepEqual(edited.repoSettingsChanged(), ['.flash-agents.local.json'], 'an edited local file is a change')

    const removed = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1 })
    rmSync(local, { force: true })
    assert.deepEqual(removed.repoSettingsChanged(), ['.flash-agents.local.json'], 'a removed local file is a change')

    // Both at once are named together, shared first.
    const both = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1 })
    writeFileSync(path, JSON.stringify({ copyExclude: ['build'] }))
    writeFileSync(local, JSON.stringify({ copyExclude: ['local-build'] }))
    assert.deepEqual(both.repoSettingsChanged(), ['.flash-agents.json', '.flash-agents.local.json'])

    rmSync(path, { force: true })
    assert.deepEqual(both.repoSettingsChanged(), ['.flash-agents.json', '.flash-agents.local.json'])
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('slotPathWarning names a long path with a trailing separator, only on Windows', () => {
  const long = 'C:\\Users\\a-long-user-name\\AppData\\Local\\Temp\\flash-mcp\\0123456789ab\\1234\\abcdefgh\\slots\\slot-0'
  assert.equal(slotPathWarning(long, { platform: 'linux' }), undefined)
  assert.equal(slotPathWarning('C:\\fm\\0123456789ab\\1234\\abcdefgh\\slots\\slot-0', { platform: 'win32' }), undefined)
  const warning = slotPathWarning(long, { platform: 'win32' })
  // The injected platform is Windows, but the host separator is still this test's `sep`.
  assert.ok(warning.startsWith(`slot copies live at ${long}${sep} (`), warning)
  assert.match(warning, /\(\d+ characters\); Windows tools without long-path support/)
  assert.match(warning, /\(MSVC cl\.exe among them\) fail past 260 characters/)
  assert.match(warning, /A short base leaves more room: set the plugin option "state_base" \(or FLASH_STATE_BASE\) to a folder such as C:\\fm/)
  // slotRootPath always adds the separator the advisory counts.
  assert.equal(slotRootPath('/tmp/fm/digest/1/nonce', 0), join('/tmp/fm/digest/1/nonce', 'slots', 'slot-0') + sep)
})

test('the start line lists exactly the settings layers that applied', () => {
  const repo = makeRepo()
  writeFileSync(
    join(repo, '.flash-agents.json'),
    JSON.stringify({
      copyExclude: ['shared-build'],
      platform: {
        win32: { slotEnv: { WIN_ONLY: 'value:1' } },
        linux: { slotEnv: { LINUX_ONLY: 'value:1' } },
      },
    }),
  )
  writeFileSync(join(repo, '.flash-agents.local.json'), JSON.stringify({ slotEnv: { LOCAL_ONLY: 'value:1' } }))
  try {
    const logs = []
    const isolation = new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, platform: 'win32', log: (line) => logs.push(line) })
    isolation.close()
    const lines = logs.filter((line) => line.startsWith('settings: '))
    assert.deepEqual(lines, [
      'settings: .flash-agents.json, .flash-agents.json platform.win32, .flash-agents.local.json',
    ])
    assert.equal(lines[0].includes('platform.linux'), false, 'only the running platform is a layer')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a local settings file git would commit is reported once, and an ignored one logs nothing', () => {
  const repo = makeRepo()
  const local = join(repo, '.flash-agents.local.json')
  try {
    writeFileSync(local, JSON.stringify({ slotEnv: { CARGO_HOME: 'home:cargo' } }))
    const notIgnored = []
    new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, log: (line) => notIgnored.push(line) }).close()
    assert.ok(
      notIgnored.includes(`${local} is not ignored by git; add .flash-agents.local.json to .gitignore so it is not committed`),
      `expected the not-ignored warning, got ${JSON.stringify(notIgnored)}`,
    )

    // With the file ignored, the same setup says nothing about it.
    writeFileSync(join(repo, '.gitignore'), '.flash-agents.local.json\n')
    const ignored = []
    new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, log: (line) => ignored.push(line) }).close()
    assert.equal(
      ignored.some((line) => line.includes(`${local} is`)),
      false,
      `an ignored local file must log nothing about tracking, got ${JSON.stringify(ignored)}`,
    )

    // A force-added local file is tracked even though .gitignore names it.
    execFileSync('git', ['add', '-f', local], { cwd: repo })
    const tracked = []
    new WorkspaceIsolation({ root: repo, baseDir: STATE_BASE, slots: 1, log: (line) => tracked.push(line) }).close()
    assert.ok(
      tracked.includes(
        `${local} is tracked by git, but it is meant for one machine; remove it from the index and add it to .gitignore`,
      ),
      `expected the tracked warning, got ${JSON.stringify(tracked)}`,
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }

  // A root that is not a git work tree has no index to warn about.
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'flash-iso-plain-settings-')))
  try {
    writeFileSync(join(plain, '.flash-agents.local.json'), JSON.stringify({ copyExclude: ['dist'] }))
    const logs = []
    new WorkspaceIsolation({ root: plain, baseDir: STATE_BASE, slots: 1, log: (line) => logs.push(line) }).close()
    assert.equal(
      logs.some((line) => line.includes('is not ignored by git') || line.includes('is tracked by git')),
      false,
      `a non-git root logs nothing about tracking, got ${JSON.stringify(logs)}`,
    )
  } finally {
    rmSync(plain, { recursive: true, force: true })
  }
})

test('the settings warning sentence is the one the service returns', () => {
  assert.equal(
    SETTINGS_CHANGED_WARNING,
    '.flash-agents.json changed after this server started; its new settings take effect after a reconnect (/mcp reconnect plugin:flash-agents:flash)',
  )
})
