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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { WorkspaceIsolation } from '../lib/isolation.js'

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
  assert.throws(() => isolation.apply({ patchId: 'flash-nope' }), /no patch "flash-nope" is held/)
  assert.throws(() => isolation.apply({ patchId: 'flash-nope' }), new RegExp(stateDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
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
