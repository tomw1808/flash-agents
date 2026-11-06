/**
 * 0.1.11 review-round tests: a cache is moved only when nothing can still write into it, the
 * cache store ages out and trims safely, the patch (not the merge) is checked for conflict
 * markers, the final-message check only reads line-start markup, and the process watch
 * counts new processes as activity.
 *
 * Real repositories, real `git` and real pools in temporary directories; the process table
 * is a fake one. Every directory is made here and removed when the file finishes: nothing
 * touches a real home, `DSH_HOME`, the temp state base or the data directory.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test, { after } from 'node:test'

import { ProcessWatch } from '../lib/proctree.js'
import { SLOT_LOCK_FORMAT, WorkspaceIsolation, rootDigest, slotLockPath } from '../lib/isolation.js'
import { activityWarnings, createActivity, finalMessageProblem } from '../lib/service.js'

const GIT_ID = ['-c', 'user.email=t@t', '-c', 'user.name=t']

/** A pid no process has. */
const DEAD_PID = 4194303

const madeDirs = []

/** A fresh temporary directory, realpath'd so macOS `/var` vs `/private/var` cannot bite. */
function tempDir(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  madeDirs.push(dir)
  return dir
}

process.env.FLASH_DATA_DIR = tempDir('flash-review0111-data-')

after(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true })
})

/** A committed repository holding `files`; the settings put a cargo-style target in the slot cache. */
function makeRepo(files = { 'README.md': '# project\n' }) {
  const dir = tempDir('flash-review0111-repo-')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  writeFileSync(join(dir, '.flash-agents.json'), JSON.stringify({ slotEnv: { CARGO_TARGET_DIR: 'cache:target' } }))
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', [...GIT_ID, 'commit', '-q', '-m', 'init'], { cwd: dir })
  return dir
}

const ROOMY = () => ({ bsize: 4096, blocks: 1_000_000_000, bavail: 500_000_000 })

/** A pool over `repo` in the default layout under `baseDir`. */
function makePool(repo, baseDir, { slots = 1, log = () => {}, ...options } = {}) {
  return new WorkspaceIsolation({ root: repo, slots, baseDir, statfs: ROOMY, log, ...options })
}

/** Lease and prepare one call. */
async function startCall(pool) {
  const slot = await pool.lease()
  pool.prepare(slot)
  return slot
}

/** A cache the worker built in a slot's tree. */
function writeBuild(pool, slot, tag) {
  const target = pool.slotEnvFor(slot).CARGO_TARGET_DIR
  mkdirSync(join(target, 'debug'), { recursive: true })
  writeFileSync(join(target, 'debug', 'app'), `binary ${tag}\n`)
  return target
}

/** Plant a stored cache directly, `ageDays` old. */
function plantStored(baseDir, repo, number, ageDays = 0) {
  const dir = join(baseDir, rootDigest(repo), 'caches', String(number))
  mkdirSync(join(dir, 'target'), { recursive: true })
  writeFileSync(join(dir, 'target', 'f'), `cache ${String(number)}\n`)
  const when = new Date(Date.now() - ageDays * 86_400_000)
  utimesSync(dir, when, when)
  return dir
}

/** The numbers in a root's cache store. */
function storedNumbers(baseDir, repo) {
  const dir = join(baseDir, rootDigest(repo), 'caches')
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

// ── 1. a cache is moved only when nothing can still write into it ───────────

test('close moves no cache out of a tree whose runtimes were not shut down', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-review0111-base-')
  const logs = []
  const pool = makePool(repo, base, { log: (line) => logs.push(line) })
  const slot = await startCall(pool)
  const stable = slot.dir
  writeBuild(pool, slot, 'old')
  pool.retire(slot, { sessionStopped: false })
  pool.release(slot)
  // The tree that may still be written into is renamed aside, and the live slot keeps the
  // stable path the next server of this root claims.
  assert.equal(slot.dir, stable, 'the live slot keeps its stable path')
  const orphan = slot.orphans.at(-1)
  assert.equal(orphan, join(dirname(stable), `${basename(stable)}.retired-${pool.instance}`), 'the tree is renamed aside')
  // Its cache went with the tree: its runtimes were not stopped, so it is not handed over.
  const orphanCache = join(orphan, '.flash-cache', 'target', 'debug', 'app')
  assert.equal(existsSync(orphanCache), true, 'the retired tree keeps the cache a live runtime may still write')
  pool.close()
  assert.deepEqual(storedNumbers(base, repo), [], 'nothing is moved from under a process that may still write')
  // Nobody claims a retired name, so the tree is removed with its cache rather than stored.
  assert.equal(existsSync(orphan), false)
  assert.ok(logs.some((line) => /close: not storing the build cache of .*not shut down/.test(line)), logs.join('\n'))
})

test('close leaves a stable slot’s cache in place, and stores the cache of a directory that cannot stay', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-review0111-base-')
  const pool = makePool(repo, base)
  const slot = await startCall(pool)
  const target = writeBuild(pool, slot, 'held')
  const slotDir = slot.dir
  pool.close()
  // The slot's directory is the path the next server claims, so its cache is not moved at
  // all — not even while a call still holds it: the next build in that slot is the point.
  assert.deepEqual(storedNumbers(base, repo), [], 'a stable slot’s cache goes nowhere')
  assert.equal(existsSync(join(target, 'debug', 'app')), true, 'it is still in the slot')
  assert.equal(existsSync(slotDir), true, 'and so is the slot directory')

  const second = makePool(repo, base, {
    // A directory that cannot stay: the tree rename is refused, as Windows refuses it while a
    // session holds a file open, so the slot moves to a retired name and the stopped tree
    // keeps the stable path. Its cache is then the store's, not the tree's.
    renameDirectory: (from, to) => {
      if (basename(from) === '.flash-cache') {
        renameSync(from, to)
        return
      }
      const error = new Error('EPERM: operation not permitted, rename')
      error.code = 'EPERM'
      throw error
    },
  })
  const first = await startCall(second)
  writeBuild(second, first, 'stopped')
  second.retire(first, { sessionStopped: true })
  second.close()
  assert.deepEqual(storedNumbers(base, repo), ['0'], 'a stopped tree in a directory that cannot stay still gives up its cache')
})

test('a dead server’s cache is rescued only when no retired tree of it may still run', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-review0111-base-')
  const digestDir = join(base, rootDigest(repo))
  const logs = []

  // A server retires a tree with its runtime still running — that marks the tree, because a
  // process of it may outlive the server — and the next call in the slot builds the cache
  // there. A second retirement moves the slot off that directory, so nothing claims it again.
  const dying = makePool(repo, base)
  const slot = await startCall(dying)
  dying.retire(slot, { sessionStopped: false })
  writeBuild(dying, slot, 'running')
  dying.retire(slot, { sessionStopped: false })
  const marked = slot.orphans[1]
  assert.match(basename(marked), /^0\.retired-/)
  assert.equal(existsSync(join(digestDir, `.live-${basename(marked)}`)), true, 'the tree is marked')
  // Then it dies: the retired tree's lock names a pid nothing has.
  writeFileSync(
    slotLockPath(marked),
    `${JSON.stringify({ format: SLOT_LOCK_FORMAT, pid: DEAD_PID, startedAt: Date.now(), instance: 'dead0001' })}\n`,
  )

  const next = makePool(repo, base, { log: (line) => logs.push(line) })
  assert.deepEqual(storedNumbers(base, repo), [], 'the cache of a tree that may still run is not rescued')
  assert.ok(logs.some((line) => /not rescuing the build cache of .*not shut down/.test(line)), logs.join('\n'))
  next.close()
  dying.close()
})

// ── 2. Windows reports EPERM for a rename onto an existing directory ────────

test('a put that meets a number filled meanwhile tries the next one, whether the error is EEXIST or EPERM', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-review0111-base-')
  const logs = []
  let raced = false
  const pool = makePool(repo, base, {
    slots: 2,
    log: (line) => logs.push(line),
    renameDirectory: (from, to) => {
      // The tree rename of `retire` is refused, as Windows refuses it while a session holds a
      // file open. The stopped tree then keeps the stable path and the slot moves to a retired
      // name — the one layout in which `close` still puts a tree's cache into the store, which
      // is where the race below happens.
      if (basename(from) !== '.flash-cache') {
        const refused = new Error('EPERM: operation not permitted, rename')
        refused.code = 'EPERM'
        throw refused
      }
      if (!raced) {
        raced = true
        // A concurrent server fills the number first; Windows answers EPERM.
        mkdirSync(to, { recursive: true })
        writeFileSync(join(to, 'taken'), 'x')
        const error = new Error('EPERM: operation not permitted, rename')
        error.code = 'EPERM'
        throw error
      }
      renameSync(from, to)
    },
  })
  const slot = await startCall(pool)
  writeBuild(pool, slot, 'one')
  pool.retire(slot, { sessionStopped: true })
  pool.release(slot)
  pool.close()
  assert.ok(logs.some((line) => line.includes('keeping the older layout')), logs.join('\n'))
  assert.deepEqual(storedNumbers(base, repo), ['0', '1'])
  assert.equal(existsSync(join(base, rootDigest(repo), 'caches', '1', 'target', 'debug', 'app')), true)
})

// ── 3. the trim skips a cache that changed since the listing ────────────────

test('the trim does not discard a stored cache that was claimed and put back after it was listed', () => {
  const repo = makeRepo()
  const base = tempDir('flash-review0111-base-')
  plantStored(base, repo, 0, 40)
  const second = plantStored(base, repo, 1, 41)
  const pool = makePool(repo, base, {
    slots: 2,
    log: (line) => {
      // The first discard has just finished; another server puts its cache back as number 1.
      if (/removed stored build cache .*[/\\]0$/.test(line)) utimesSync(second, new Date(), new Date())
    },
  })
  try {
    assert.deepEqual(storedNumbers(base, repo), ['1'])
  } finally {
    pool.close()
  }
})

// ── 4. an abandoned store ages out ──────────────────────────────────────────

test('the sweep ages out the cache store of a root with no live server and removes the emptied digest', () => {
  const repo = makeRepo()
  const abandoned = makeRepo({ 'other.md': 'x\n' })
  const recent = makeRepo({ 'third.md': 'x\n' })
  const base = tempDir('flash-review0111-base-')
  plantStored(base, abandoned, 0, 40)
  plantStored(base, recent, 0, 1)
  const pool = makePool(repo, base)
  try {
    assert.equal(existsSync(join(base, rootDigest(abandoned))), false, 'the expired store went, and its empty digest with it')
    assert.deepEqual(storedNumbers(base, recent), ['0'], 'a store inside the window stays')
  } finally {
    pool.close()
  }
})

// ── 5. markers the patch itself adds ────────────────────────────────────────

const MARKED = 'a\n<<<<<<< ours\nb\n=======\nc\n>>>>>>> theirs\nd\n'
const WARNING = /^WARNING: the patch itself adds conflict markers to notes\.txt; if they are not intended \(a test fixture\), they are left over from a merge in the worker's copy$/

/** A pool over a one-file repository and a finished change that writes `text` to it. */
async function markedChange(text) {
  const repo = makeRepo({ 'notes.txt': Array.from({ length: 12 }, (_, at) => `line ${String(at + 1)}\n`).join('') })
  const pool = new WorkspaceIsolation({ root: repo, slots: 1, stateDir: tempDir('flash-review0111-state-') })
  const slot = await pool.lease()
  pool.prepare(slot)
  const original = readFile(join(slot.dir, 'notes.txt'))
  writeFileSync(join(slot.dir, 'notes.txt'), original.replace('line 2\n', text))
  const change = pool.collect(slot)
  pool.discard(slot)
  pool.release(slot)
  return { repo, pool, change }
}

function readFile(path) {
  return execFileSync('cat', [path], { encoding: 'utf8' })
}

for (const dryRun of [false, true]) {
  test(`a patch that adds a marker block is a warning, not a conflict (plain path, dryRun ${String(dryRun)})`, async () => {
    const { pool, change } = await markedChange(MARKED)
    const applied = pool.apply({ patchId: change.patchId, threeWay: true, dryRun })
    assert.equal(applied.status, 'success')
    assert.deepEqual(applied.conflicts, [])
    assert.deepEqual(applied.files, [{ path: 'notes.txt', status: 'applied' }])
    assert.match(applied.warnings.at(-1), WARNING)
    pool.close()
  })

  test(`the same on the three-way path (dryRun ${String(dryRun)})`, async () => {
    const { repo, pool, change } = await markedChange(MARKED)
    // The caller drifted at line 10, so the plain apply of a hunk with 3 lines of context fails.
    const drifted = readFile(join(repo, 'notes.txt')).replace('line 5\n', 'line 5, by the caller\n')
    writeFileSync(join(repo, 'notes.txt'), drifted)
    execFileSync('git', [...GIT_ID, 'commit', '-q', '-am', 'drift'], { cwd: repo })
    const applied = pool.apply({ patchId: change.patchId, threeWay: true, dryRun })
    assert.equal(applied.threeWay, true)
    assert.equal(applied.status, 'success')
    assert.deepEqual(applied.conflicts, [])
    assert.match(applied.warnings.at(-1), WARNING)
    pool.close()
  })
}

test('a lone ======= line added by a patch is no warning', async () => {
  const { pool, change } = await markedChange('Title\n=====\n')
  const applied = pool.apply({ patchId: change.patchId, threeWay: true })
  assert.equal(applied.status, 'success')
  assert.equal((applied.warnings ?? []).some((line) => line.startsWith('WARNING')), false)
  pool.close()
})

// ── 6. the final-message check reads line-start markup only ─────────────────

test('finalMessageProblem: markup mid-sentence is a report, markup on its own line is not, indented code is quoted', () => {
  assert.equal(finalMessageProblem('</｜DSML｜ calls> <｜DSML｜ invoke name="edit">'), 'tool-call-markup')
  assert.equal(finalMessageProblem('Let me run the tests.\n<invoke name="bash">'), 'tool-call-markup')
  assert.equal(finalMessageProblem('  <tool_call>{"name":"bash"}'), 'tool-call-markup')
  assert.equal(finalMessageProblem('the parser treats <tool_call> and <function_calls> as markup'), null)
  assert.equal(finalMessageProblem('Saw <invoke name="x"> in the log and a <｜DSML｜ token; fixed.'), null)
  assert.equal(finalMessageProblem('The worker ended with:\n\n    <function_calls>\n    <invoke name="bash">\n\nthat is all.'), null)
  assert.equal(finalMessageProblem('The worker ended with:\n\n\t<function_calls>\n\nthat is all.'), null)
  assert.equal(finalMessageProblem('Not code:\n    <function_calls>'), 'tool-call-markup')
})

// ── 7-9. the process watch ──────────────────────────────────────────────────

const MIN = 60_000

/** A runtime (pid 100) running `cargo check`; `extra` adds processes to the table of each read. */
function makeWorld({ extra = () => [], command = 'cd app && cargo check', shell = 'bash -c cd app && cargo check' } = {}) {
  const world = { now: 10_000_000, reads: 0 }
  world.start = world.now - 30_000
  world.table = () => [
    { pid: 100, ppid: 1, cpuSeconds: 9, startedMs: world.now - 3_600_000, command: 'dsh runtime' },
    { pid: 200, ppid: 100, cpuSeconds: 0.1, startedMs: world.start, command: shell },
    { pid: 202, ppid: 200, cpuSeconds: 0.5, startedMs: world.start + 200, command: 'cmake --build build -- ninja' },
    ...extra(world),
  ]
  world.watch = new ProcessWatch({
    now: () => world.now,
    list: async () => {
      world.reads += 1
      return world.table()
    },
  })
  world.activity = createActivity(world.now)
  world.activity.runtimePid = 100
  world.activity.openCalls.set('s:c1', { session: 's', tool: 'bash', command, since: world.start })
  world.step = async (ms) => {
    world.now += ms
    await world.watch.refresh(world.activity)
  }
  return world
}

test('a short-lived child between samples counts as activity and restarts the quiet window', async () => {
  let spawned = 0
  const world = makeWorld({
    // A new pid shows up at the fourth sample and is gone at the next: no CPU of it is visible.
    extra: (w) => (w.reads === 4 ? [{ pid: 900 + spawned++, ppid: 200, cpuSeconds: 0, startedMs: w.now - 1000, command: 'sleep 1' }] : []),
  })
  await world.step(0)
  for (let minute = 1; minute <= 5; minute += 1) await world.step(MIN)
  assert.deepEqual(activityWarnings(world.activity, world.now), [], 'the window restarted when a new process appeared')
  for (let minute = 0; minute < 4; minute += 1) await world.step(MIN)
  assert.equal(activityWarnings(world.activity, world.now).length, 1, 'quiet again for a whole window')

  const still = makeWorld()
  await still.step(0)
  for (let minute = 1; minute <= 5; minute += 1) await still.step(MIN)
  assert.equal(activityWarnings(still.activity, still.now).length, 1, 'the same tree with no new process is quiet')
})

test('a runtime’s table is dropped when its session ends, and a late read does not bring the tree state back', async () => {
  const world = makeWorld()
  await world.step(0)
  assert.equal(world.watch.tables.has(100), true)
  assert.notEqual(world.activity.proc, undefined)
  world.watch.forget(100)
  assert.equal(world.watch.tables.has(100), false)

  // A read that is still in flight when the session ends.
  const late = makeWorld()
  let release
  late.watch.list = () => new Promise((resolve) => { release = () => resolve(late.table()) })
  late.now += MIN
  const pending = late.watch.refresh(late.activity)
  delete late.activity.runtimePid
  delete late.activity.proc
  release()
  await pending
  assert.equal(late.activity.proc, undefined)
})
