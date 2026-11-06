/**
 * A slot's path is the same across server restarts, so a warm build cache stays valid.
 *
 * A default-layout slot lives at `<stateBase>/<rootDigest>/slots/<n>`, a path that depends on
 * the root and the slot number alone, and each server claims its numbers by linking a
 * complete `slots/<n>.lock` into place. The tests below drive real pools, real `git`, the
 * real `clean` entry point and, for the claim race, two real child processes over a
 * temporary state base: no test reads or writes the real home, `DSH_HOME`, temp state base or
 * data directory. `statfs` and the renames are injected, so nothing depends on the free space
 * of the machine the suite runs on.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runClean } from '../lib/index.js'
import {
  SLOT_LOCK_FORMAT,
  WorkspaceIsolation,
  cleanLayout,
  processCommandLine,
  rootDigest,
  slotLockPath,
  stableSlotDirectory,
} from '../lib/isolation.js'

/** Stored patches go to the durable data directory by default; keep them out of the real one. */
process.env.FLASH_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'flash-slots0112-data-')))

/** A pid no process has (the Linux and macOS maximum plus one is never allocated). */
const DEAD_PID = 4194303

/** A fresh temporary directory, realpath'd so macOS `/var` vs `/private/var` cannot bite. */
function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

/** A committed repository whose settings put a cargo-style target in the slot cache. */
function makeRepo() {
  const dir = tempDir('flash-slots0112-repo-')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# project\n')
  writeFileSync(join(dir, '.gitignore'), '.flash-cache/\n')
  writeFileSync(join(dir, '.flash-agents.json'), JSON.stringify({ slotEnv: { CARGO_TARGET_DIR: 'cache:target' } }))
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: dir })
  return dir
}

/** A statfs that reports a roomy volume, so only the tests about space see a warning. */
const ROOMY = () => ({ bsize: 4096, blocks: 1_000_000_000, bavail: 500_000_000 })

/** A pool over `repo` in the default layout under `baseDir`. */
function makePool(repo, baseDir, { slots = 1, log = () => {}, ...options } = {}) {
  return new WorkspaceIsolation({ root: repo, slots, baseDir, statfs: ROOMY, log, ...options })
}

/** Lease and prepare one call, as the service does up to the worker. */
async function startCall(pool) {
  const slot = await pool.lease()
  pool.prepare(slot)
  return slot
}

/** A cache the worker built: nested folders and a symlink inside, as cargo's target has. */
function writeBuild(pool, slot, tag) {
  const target = pool.slotEnvFor(slot).CARGO_TARGET_DIR
  mkdirSync(join(target, 'debug', 'deps'), { recursive: true })
  writeFileSync(join(target, 'debug', 'deps', 'libapp.rlib'), `built ${tag}\n`)
  writeFileSync(join(target, 'debug', 'app'), `binary ${tag}\n`)
  mkdirSync(join(target, 'debug', 'deps', '..'), { recursive: true })
  return target
}

/** The command line a lock records for a server that is no longer running. */
const DEAD_COMMAND = 'node /opt/flash-mcp/bin/server.js --dead'

/** The lock a server that died leaves behind, exactly as `claimSlots` writes a live one. */
function plantDeadLock(slotDir, { pid = DEAD_PID, instance = 'dead0001' } = {}) {
  writeFileSync(
    slotLockPath(slotDir),
    `${JSON.stringify({ format: SLOT_LOCK_FORMAT, pid, command: DEAD_COMMAND, instance })}\n`,
  )
}

/** The `slots` folder of one root: the stable slot directories and their locks. */
function slotsOf(baseDir, repo) {
  return join(baseDir, rootDigest(repo), 'slots')
}

/** Make `dir` a git tree sitting on a `flash base` commit, exactly as `prepare` leaves one. */
function makeFlashBaseTree(dir) {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# project\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'flash base'], { cwd: dir })
}

test('two pools one after the other on one root give slot 0 the same path', async () => {
  // The defect this pins: a slot used to live at `<stateBase>/<rootDigest>/<pid>/<instance>/
  // slots/slot-N`, so every server restart handed the same slot a different absolute path.
  // SwiftPM, CMake and cargo write that path into their build output, so the warm cache the
  // previous server left was useless: a user with ten Swift workers saw ten cold builds.
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  const first = makePool(repo, base)
  try {
    const slot = await startCall(first)
    first.release(slot)
    first.close()

    const second = makePool(repo, base)
    try {
      assert.deepEqual(second.slotIds, [0], 'the number the first server released is free again')
      const next = await startCall(second)
      assert.equal(next.dir, slot.dir, 'slot 0 of this root has the same path across a restart')
      assert.equal(next.dir, stableSlotDirectory(repo, { baseDir: base, id: 0 }))
      assert.equal(dirname(next.dir), slotsOf(base, repo), 'the slot sits in the root’s own slots folder')
      second.release(next)
    } finally {
      second.close()
    }
  } finally {
    first.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('two pools at the same time on one root get disjoint slot numbers', () => {
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  const first = makePool(repo, base, { slots: 2 })
  const second = makePool(repo, base, { slots: 2 })
  try {
    assert.deepEqual(first.slotIds, [0, 1], 'the first server takes the numbers from zero')
    assert.deepEqual(second.slotIds, [2, 3], 'the second server takes the next free ones')
    const dirs = [...first.slots, ...second.slots].map((slot) => slot.dir)
    assert.equal(new Set(dirs).size, 4, `two servers never share a slot directory: ${dirs.join(', ')}`)
    for (const slot of second.slots) {
      assert.equal(existsSync(slotLockPath(slot.dir)), true, `slot ${String(slot.id)} is held by a lock`)
      assert.equal(JSON.parse(readFileSync(slotLockPath(slot.dir), 'utf8')).pid, process.pid)
    }
  } finally {
    first.close()
    second.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('a live pool in another process holds its slot, and its tree, against a second server', async (t) => {
  // Nothing is injected here: the child records its own command line while it builds, and
  // the parent reads it back from the operating system. That is the identity a real second
  // server compares, and it is what keeps a live lock from being taken for a dead one and a
  // live tree from being moved aside.
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  const child = spawn(process.execPath, [POOL_HOLDER, repo, base], {
    env: { ...process.env, FLASH_DATA_DIR: process.env.FLASH_DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const exited = new Promise((resolve) => child.on('exit', resolve))
  let second
  let third
  try {
    const line = await waitForReady(child, () => stderr)
    assert.match(line, /^ready /, line)
    const ready = JSON.parse(line.slice('ready '.length))
    if (processCommandLine(ready.pid) === null) {
      // The lock then falls back to the pid alone, so this cannot show a command-line
      // identity across processes. Say why rather than pass for the wrong reason.
      console.log(`processCommandLine(${String(ready.pid)}) is null on ${process.platform}: skipping the two-process slot test`)
      t.skip(`the command-line reader cannot read the child’s command line on ${process.platform}`)
      return
    }
    assert.deepEqual(ready.slotIds, [0], 'the child claimed the first number')
    const slotDir = stableSlotDirectory(repo, { baseDir: base, id: 0 })
    assert.equal(ready.dir, slotDir, 'its tree is the stable path of slot 0')
    assert.equal(JSON.parse(readFileSync(slotLockPath(slotDir), 'utf8')).pid, ready.pid, 'the child holds slot 0’s lock')

    second = makePool(repo, base, { deferStartupSweep: true, sweepIntervalMs: 0 })
    assert.deepEqual(second.slotIds, [1], 'the second server skips the child’s live number')
    assert.equal(second.slots[0].dir, stableSlotDirectory(repo, { baseDir: base, id: 1 }), 'and takes the next one')
    assert.equal(JSON.parse(readFileSync(slotLockPath(slotDir), 'utf8')).pid, ready.pid, 'slot 0’s lock still names the child')
    assert.equal(readFileSync(join(slotDir, ready.workFile), 'utf8'), ready.work, 'the child’s tree is untouched')
    assert.deepEqual(childrenStartingWith(slotsOf(base, repo), '0.dead-'), [], 'and it was not moved aside')
    assert.deepEqual(childrenStartingWith(slotsOf(base, repo), '0.retired-'), [], 'and it was not retired')

    child.kill('SIGKILL')
    await exited
    // The pid exists no more, so the number it held is free again: the next server may take
    // slot 0 over, and the dead worker's tree is moved aside rather than erased.
    third = makePool(repo, base, { deferStartupSweep: true, sweepIntervalMs: 0 })
    assert.deepEqual(third.slotIds, [0], 'the dead child’s number is free again')
    assert.equal(JSON.parse(readFileSync(slotLockPath(slotDir), 'utf8')).pid, process.pid, 'and its lock now names this process')
    const asides = childrenStartingWith(slotsOf(base, repo), '0.dead-')
    assert.equal(asides.length, 1, 'the dead child’s tree was moved aside, not erased')
    assert.equal(readFileSync(join(slotsOf(base, repo), asides[0], ready.workFile), 'utf8'), ready.work, 'with the work it held')
  } finally {
    child.kill('SIGKILL')
    await exited
    if (third !== undefined) third.close()
    if (second !== undefined) second.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('a dead server’s lock is taken over, and the slot keeps its path', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  const crashed = makePool(repo, base)
  const slot = await startCall(crashed)
  const slotDir = slot.dir
  crashed.release(slot)
  // A server that died without a shutdown: its tree is there, its slot's lock names its pid.
  plantDeadLock(slotDir)
  const logs = []
  const next = makePool(repo, base, { log: (line) => logs.push(line) })
  try {
    assert.deepEqual(next.slotIds, [0], 'the dead lock does not push the next server to a higher number')
    assert.equal(next.slots[0].dir, slotDir, 'the number is taken over, not skipped')
    assert.ok(
      logs.some((line) => line.includes('took over slot') && line.includes(String(DEAD_PID))),
      `the takeover is logged with the dead pid: ${JSON.stringify(logs)}`,
    )
    const lock = JSON.parse(readFileSync(slotLockPath(slotDir), 'utf8'))
    assert.equal(lock.format, SLOT_LOCK_FORMAT)
    assert.equal(lock.pid, process.pid, 'the lock now names this server')
    assert.equal(lock.instance, next.instance)
  } finally {
    next.close()
    crashed.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('a cache written in a stable slot is in place, unmoved, for the next server', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  const first = makePool(repo, base)
  const logs = []
  try {
    const slot = await startCall(first)
    assert.equal(slot.buildCacheEmpty, true, 'a fresh root starts cold')
    const target = writeBuild(first, slot, 'one')
    const built = join(target, 'debug', 'deps', 'libapp.rlib')
    first.release(slot)
    first.close()

    const store = join(base, rootDigest(repo), 'caches')
    assert.deepEqual(existsSync(store) ? readdirSync(store) : [], [], 'a cache in place is not moved into the store')
    assert.equal(readFileSync(built, 'utf8'), 'built one\n', 'and it is still in the slot after the shutdown')

    const second = makePool(repo, base, { log: (line) => logs.push(line) })
    try {
      const next = await startCall(second)
      assert.equal(next.dir, slot.dir, 'the next server claims the same path')
      assert.equal(next.buildCacheEmpty, false, 'it starts warm')
      assert.equal(next.buildCacheFrom, undefined, 'the cache was in place, not claimed from the store')
      const warm = join(second.slotEnvFor(next).CARGO_TARGET_DIR, 'debug', 'deps', 'libapp.rlib')
      assert.equal(readFileSync(warm, 'utf8'), 'built one\n', 'the worker’s build is where it left it')
      assert.equal(readFileSync(join(dirname(dirname(warm)), 'app'), 'utf8'), 'binary one\n', 'and so is the rest of the cache')
      assert.equal(logs.some((line) => /claimed stored build cache/.test(line)), false)
    } finally {
      second.close()
    }
  } finally {
    first.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('retire moves the tree aside and keeps the live slot at its stable path, cache included', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  const pool = makePool(repo, base)
  try {
    const slot = await startCall(pool)
    const target = writeBuild(pool, slot, 'retired')
    const stable = slot.dir
    const artefact = join('debug', 'deps', 'libapp.rlib')
    pool.collect(slot)
    pool.retire(slot, { sessionStopped: true })

    const orphan = slot.orphans.at(-1)
    assert.equal(orphan, join(dirname(stable), `${basename(stable)}.retired-${pool.instance}`), 'the orphan is renamed aside')
    assert.equal(slot.dir, stable, 'the live slot keeps the stable path, so its warm cache paths stay valid')
    assert.equal(existsSync(stable), true, 'the live slot has a fresh directory at the stable path')
    assert.equal(existsSync(orphan), true, 'the retired tree is still there for the trim or the close')
    assert.equal(existsSync(slotLockPath(stable)), true, 'the live slot keeps its claim lock')
    assert.equal(JSON.parse(readFileSync(slotLockPath(stable), 'utf8')).instance, pool.instance)
    assert.equal(existsSync(slotLockPath(orphan)), true, 'and the retired tree carries a lock of its own')
    // The cache moved to the stable path in the same step: a build there is only warm at the
    // absolute path it was compiled for.
    assert.equal(
      readFileSync(join(stable, '.flash-cache', 'target', artefact), 'utf8'),
      'built retired\n',
      'the cache is handed over to the fresh stable directory',
    )
    assert.equal(existsSync(join(orphan, '.flash-cache', 'target', artefact)), false, 'and left the retired tree')

    pool.release(slot)
    const retry = await startCall(pool)
    assert.equal(retry.dir, stable, 'the next call runs at the stable path')
    assert.equal(retry.buildCacheFrom, 'retired-slot', 'the call still says where the cache came from')
    assert.equal(retry.buildCacheEmpty, false, 'the retry starts warm')
    assert.equal(readFileSync(join(pool.slotEnvFor(retry).CARGO_TARGET_DIR, artefact), 'utf8'), 'built retired\n')
    pool.release(retry)
  } finally {
    pool.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('a retire whose tree rename fails keeps the older layout and logs why', async () => {
  // Windows refuses a rename while a session holds a file open; the tree then has to stay at
  // the stable path and the slot moves to a retired name, as it did before this round.
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  const logs = []
  const pool = makePool(repo, base, {
    log: (line) => logs.push(line),
    renameDirectory: () => {
      const error = new Error('EPERM: operation not permitted')
      error.code = 'EPERM'
      throw error
    },
  })
  try {
    const slot = await startCall(pool)
    const stable = slot.dir
    pool.collect(slot)
    pool.retire(slot, { sessionStopped: true })
    assert.equal(slot.dir, join(dirname(stable), `${basename(stable)}.retired-${pool.instance}`), 'the slot moved to a retired name')
    assert.equal(existsSync(stable), true, 'the orphan keeps the stable path')
    assert.equal(existsSync(slotLockPath(stable)), true, 'the orphan keeps the lock it held')
    assert.equal(existsSync(slotLockPath(slot.dir)), true, 'and the moved slot has its own lock')
    assert.ok(
      logs.some((line) => line.includes('could not move the tree of slot 0 aside') && line.includes('EPERM')),
      `the failed rename and the layout it falls back to are logged: ${JSON.stringify(logs)}`,
    )
  } finally {
    pool.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('clean removes the new layout for a dead owner only', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  // A server that runs while clean is called: its slot and its cache are not clean's business.
  const live = makePool(repo, base)
  try {
    const liveSlot = await startCall(live)
    const liveCache = writeBuild(live, liveSlot, 'live')
    live.release(liveSlot)


    // A dead server's slot: a lock naming a pid no process has, a dirty tree, and a cache.
    const deadDir = join(slotsOf(base, repo), '1')
    makeFlashBaseTree(deadDir)
    writeFileSync(join(deadDir, 'README.md'), '# dead worker’s edit\n')
    mkdirSync(join(deadDir, '.flash-cache', 'target'), { recursive: true })
    writeFileSync(join(deadDir, '.flash-cache', 'target', 'stale'), 'cold\n')
    plantDeadLock(deadDir)

    const lines = []
    await runClean(['--root', repo, '--state-base', base], {
      env: { FLASH_DATA_DIR: process.env.FLASH_DATA_DIR },
      write: (text) => lines.push(text),
    })

    assert.equal(existsSync(join(liveCache, 'debug', 'app')), true, 'a live server keeps its cache')
    assert.equal(existsSync(liveSlot.dir), true, 'a live server’s slot directory is left alone')
    assert.equal(existsSync(slotLockPath(liveSlot.dir)), true, 'and so is its lock')
    assert.equal(existsSync(deadDir), false, 'a dead server’s slot tree is removed')
    assert.equal(existsSync(slotLockPath(deadDir)), false, 'and its dead lock goes with it')
    // The dead worker's uncommitted edit is stored in the durable patch store, as it was for
    // the older layout: clean reclaims the disk, it does not throw the work away.
    const patches = join(process.env.FLASH_DATA_DIR, rootDigest(repo), 'patches')
    assert.equal(readdirSync(patches).filter((name) => name.endsWith('.patch')).length, 1)
    assert.ok(lines.join('').includes('slot trees: 2'), `the report counted both slot trees: ${lines.join('')}`)
  } finally {
    live.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('an old-layout directory of a dead pid is still swept beside the new layout', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  // A 0.1.11 server that crashed: `<digest>/<pid>/<instance>/slots/slot-0` with work in it.
  const deadPidDir = join(base, rootDigest(repo), String(DEAD_PID))
  const oldSlot = join(deadPidDir, 'dead0001', 'slots', 'slot-0')
  makeFlashBaseTree(oldSlot)
  writeFileSync(join(oldSlot, 'README.md'), '# the 0.1.11 worker’s edit\n')
  // And a live server of the new layout, whose slot must survive the same sweep.
  const live = makePool(repo, base)
  try {
    const liveSlot = await startCall(live)
    live.release(liveSlot)
    const slotDir = liveSlot.dir

    const next = makePool(repo, base)
    try {
      assert.equal(existsSync(deadPidDir), false, 'the old per-pid owner is removed as before')
      const record = next.listPatches().find((entry) => entry.salvagedFrom !== undefined)
      assert.ok(record, 'its uncommitted work is salvaged')
      assert.equal(record.salvagedFrom.slotDir, oldSlot)
      assert.equal(record.salvagedFrom.pid, DEAD_PID)
      assert.equal(existsSync(slotDir), true, 'the live server’s stable slot stays')
      assert.equal(existsSync(slotLockPath(slotDir)), true)
    } finally {
      next.close()
    }
  } finally {
    live.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

// ── the slot protocol: a complete lock, a live pid that is the same process, and a tree ──
// ── moved only while its mover holds the lock ──

/** A lock naming whatever owner a test wants, written where a real one would sit. */
function plantLock(slotDir, { pid = DEAD_PID, command = DEAD_COMMAND, instance = 'dead0001' } = {}) {
  mkdirSync(dirname(slotLockPath(slotDir)), { recursive: true })
  writeFileSync(
    slotLockPath(slotDir),
    `${JSON.stringify({ format: SLOT_LOCK_FORMAT, pid, command, instance })}\n`,
  )
}

/** The helper that constructs one side of a two-process race. */
const RACE_HELPER = fileURLToPath(new URL('../test-support/slot-race.mjs', import.meta.url))

/** The helper that holds a real pool, its lock and its tree in another process. */
const POOL_HOLDER = fileURLToPath(new URL('../test-support/pool-holder.mjs', import.meta.url))

/** Poll until `file` exists, or fail after `ms`. */
async function waitForFile(file, ms = 15_000) {
  const deadline = Date.now() + ms
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** The holder's one `ready` line, or an error with its stderr when it exits or stays silent. */
function waitForReady(child, stderr, ms = 15_000) {
  return new Promise((resolve, reject) => {
    let buffered = ''
    const timer = setTimeout(() => reject(new Error(`the holder never printed ready: ${stderr()}`)), ms)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      const end = buffered.indexOf('\n')
      if (end === -1) return
      clearTimeout(timer)
      resolve(buffered.slice(0, end))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the holder exited ${String(code)} before it was ready: ${stderr()}`))
    })
  })
}

/** Read one race result, retrying a file caught between its open and its last byte. */
function readRaceResult(file) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      // Not complete yet.
    }
  }
  throw new Error(`could not read the race result ${file}`)
}

/** The `slots` folder directories of `dir` whose name starts with `prefix`. */
function childrenStartingWith(dir, prefix) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
}

test('a takeover whose tree move fails leaves the dead tree, and a later pool moves it aside rather than erasing it', async () => {
  // The defect this pins: a failed takeover used to delete the dead lock and leave the tree
  // unlocked, so the next pool claimed the number as if free and `prepare` emptied the dead
  // worker's uncommitted edit. The lock is now put back, and a later claim moves any
  // leftover copy aside for salvage before its own `prepare` can touch the path.
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  const slotDir = stableSlotDirectory(repo, { baseDir: base, id: 0 })
  makeFlashBaseTree(slotDir)
  const saved = 'the dead worker’s uncommitted fix\n'
  writeFileSync(join(slotDir, 'keep.txt'), saved)
  plantDeadLock(slotDir)
  const logs = []
  const blocked = makePool(repo, base, {
    log: (line) => logs.push(line),
    renameDirectory: () => {
      const error = new Error('EBUSY: resource busy or locked')
      error.code = 'EBUSY'
      throw error
    },
  })
  try {
    assert.deepEqual(blocked.slotIds, [1], 'the number whose dead tree cannot move is skipped')
    assert.equal(readFileSync(join(slotDir, 'keep.txt'), 'utf8'), saved, 'the dead tree is exactly as it was')
    const lock = JSON.parse(readFileSync(slotLockPath(slotDir), 'utf8'))
    assert.equal(lock.pid, DEAD_PID, 'the dead owner’s lock is put back in place')
    assert.equal(lock.instance, 'dead0001')
    assert.ok(
      logs.some((line) => line.includes('could not be moved aside') && line.includes('EBUSY')),
      `the failed move is logged: ${JSON.stringify(logs)}`,
    )
  } finally {
    blocked.close()
  }

  // A second pool claims the number with a working rename. It moves the copy aside for the
  // sweep, then `prepare` fills the fresh path; the dead worker's file is not erased.
  const second = makePool(repo, base, { deferStartupSweep: true })
  try {
    assert.deepEqual(second.slotIds, [0])
    const asides = childrenStartingWith(slotsOf(base, repo), '0.dead-')
    assert.equal(asides.length, 1, `the leftover copy was moved aside: ${JSON.stringify(readdirSync(slotsOf(base, repo)))}`)
    assert.equal(readFileSync(join(slotsOf(base, repo), asides[0], 'keep.txt'), 'utf8'), saved, 'the work is still there')
    // The first call runs the deferred sweep, which stores the moved-aside tree and removes
    // it; `prepare` then fills the fresh path without ever touching the dead copy.
    const slot = await second.lease()
    second.prepare(slot)
    const record = second.listPatches().find((entry) => entry.salvagedFrom !== undefined)
    assert.ok(record, 'the moved copy was salvaged rather than erased')
    assert.match(readFileSync(record.patchPath, 'utf8'), /uncommitted fix/)
    assert.equal(existsSync(join(slotDir, 'keep.txt')), false, 'the fresh slot holds the new copy, not the dead one')
    second.release(slot)
  } finally {
    second.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('two pools racing over one dead lock get one number each, and neither live tree moves', async () => {
  // The defect this pins: both servers read the dead lock, both renamed it aside, and both
  // created a lock for number 0, so two live trees shared one path. The rename is one step
  // and the create that follows is exclusive: the loser gets another number.
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  const slotDir = stableSlotDirectory(repo, { baseDir: base, id: 0 })
  makeFlashBaseTree(slotDir)
  const saved = 'work the dead server never committed\n'
  writeFileSync(join(slotDir, 'keep.txt'), saved)
  plantDeadLock(slotDir)
  const barrier = join(base, 'barrier')
  const jobs = [1, 2].map((index) => {
    const stop = join(base, `stop-${String(index)}`)
    const out = join(base, `result-${String(index)}.json`)
    const child = spawn(process.execPath, [RACE_HELPER, repo, base, barrier, stop, out], {
      env: { ...process.env, FLASH_DATA_DIR: process.env.FLASH_DATA_DIR },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    return { child, stop, out, stderr: () => stderr }
  })
  try {
    writeFileSync(barrier, 'go\n')
    await Promise.all(jobs.map((job) => waitForFile(job.out)))
    const results = jobs.map((job) => readRaceResult(job.out))
    assert.deepEqual(
      results.map((result) => result.slotIds[0]).sort((a, b) => a - b),
      [0, 1],
      `exactly one server took number 0: ${JSON.stringify(results)}`,
    )
    assert.equal(new Set(results.flatMap((result) => result.dirs)).size, 2, 'the two live trees are at different paths')
    for (const result of results) {
      const dir = result.dirs[0]
      assert.equal(existsSync(dir), true, `the claimed tree of pid ${String(result.pid)} exists`)
      const lock = JSON.parse(readFileSync(slotLockPath(dir), 'utf8'))
      assert.equal(lock.pid, result.pid, 'each lock names its own process')
    }
    const asides = childrenStartingWith(slotsOf(base, repo), '0.dead-')
    assert.equal(asides.length, 1, 'the dead server’s tree was moved aside, not overwritten')
    assert.equal(readFileSync(join(slotsOf(base, repo), asides[0], 'keep.txt'), 'utf8'), saved)
  } finally {
    for (const job of jobs) writeFileSync(job.stop, 'stop\n')
    await Promise.all(
      jobs.map(
        (job) =>
          new Promise((resolve, reject) => {
            job.child.on('exit', (code) => {
              if (code === 0) resolve()
              else reject(new Error(`race child exited ${String(code)}: ${job.stderr()}`))
            })
          }),
      ),
    )
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('a slot clean planned but another pool claimed before the removal is left untouched', () => {
  // The defect this pins: `clean` decided a slot was dead, then removed its directory and
  // lock without holding the lock, deleting a tree another server had just claimed. The
  // hook stands in for the scheduler between the plan and the removal.
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  const slotDir = stableSlotDirectory(repo, { baseDir: base, id: 0 })
  makeFlashBaseTree(slotDir)
  const saved = 'the dead worker’s edit\n'
  writeFileSync(join(slotDir, 'keep.txt'), saved)
  plantDeadLock(slotDir)
  let claimed
  try {
    const report = cleanLayout({
      baseDir: base,
      dataDir: process.env.FLASH_DATA_DIR,
      root: repo,
      removal: 'sync',
      log: () => {},
      beforeSweep: (tree) => {
        if (tree.dir !== slotDir || claimed !== undefined) return
        // Another server claims the number in the window the plan left open.
        claimed = makePool(repo, base, { deferStartupSweep: true })
      },
    })
    assert.ok(claimed, 'the hook ran for the planned slot')
    assert.deepEqual(claimed.slotIds, [0], 'the other server took the number clean had planned')
    assert.equal(existsSync(slotDir), true, 'the claimed slot directory is not removed')
    const lock = JSON.parse(readFileSync(slotLockPath(slotDir), 'utf8'))
    assert.equal(lock.pid, process.pid)
    assert.equal(lock.instance, claimed.instance, 'the claimed slot keeps the lock of the server that claimed it')
    assert.equal(report.actions.deadOwnersRemoved, 0, 'clean removed no slot tree it did not hold')
  } finally {
    claimed?.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('a live pid with another command line is dead; a matching one is live whatever its start time says', () => {
  // The defect this pins: liveness used a process start time, which `ps -o lstart=` prints in
  // local time without a zone. After a DST or time-zone change a live owner's lock looked an
  // hour off and the next server moved the live tree away. Identity is the command line now.
  const repo = makeRepo()
  const reused = tempDir('flash-slots0112-base-')
  const reusedSlot = stableSlotDirectory(repo, { baseDir: reused, id: 0 })
  plantLock(reusedSlot, { pid: process.pid, command: 'node another-program.js --reused', instance: 'reused01' })
  const first = makePool(repo, reused)
  try {
    assert.deepEqual(first.slotIds, [0], 'the pid runs another program, so the old lock is a dead one')
    assert.equal(JSON.parse(readFileSync(slotLockPath(reusedSlot), 'utf8')).instance, first.instance)
  } finally {
    first.close()
  }
  const same = tempDir('flash-slots0112-base-')
  const liveSlot = stableSlotDirectory(repo, { baseDir: same, id: 0 })
  const owned = processCommandLine(process.pid)
  // A start time from before a time-zone shift would once have made this dead; it is ignored.
  plantLock(liveSlot, { pid: process.pid, command: owned, instance: 'live0001' })
  const lock = JSON.parse(readFileSync(slotLockPath(liveSlot), 'utf8'))
  lock.startedAt = Date.now() - 60 * 60 * 1000
  writeFileSync(slotLockPath(liveSlot), `${JSON.stringify(lock)}\n`)
  const second = makePool(repo, same)
  try {
    assert.deepEqual(second.slotIds, [1], 'the same command line means the same process, so the slot is busy')
    assert.equal(JSON.parse(readFileSync(slotLockPath(liveSlot), 'utf8')).instance, 'live0001', 'the live lock is not replaced')
  } finally {
    second.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(reused, { recursive: true, force: true })
    rmSync(same, { recursive: true, force: true })
  }
})

test('a liveness answer is reused for 60 s, so a sweep does not spawn twice for one lock', async () => {
  // Two locks name one live child process. The first read spawns the injected reader; the
  // second lock, same pid and same recorded command, must come from the cache.
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
  try {
    await new Promise((resolve) => {
      child.once('spawn', resolve)
    })
    // The reader is injected: the sandbox this suite may run in can refuse to start `ps`,
    // and the cache is about how often the answer is asked for, not where it came from.
    const command = 'node /opt/flash-mcp/bin/server.js --live'
    const slots = slotsOf(base, repo)
    plantLock(join(slots, '0'), { pid: child.pid, command, instance: 'live0001' })
    plantLock(join(slots, '1'), { pid: child.pid, command, instance: 'live0001' })
    let reads = 0
    const pool = makePool(repo, base, {
      slots: 2,
      processCommandLine: (pid) => {
        assert.equal(pid, child.pid, 'the reader is asked about the lock’s owner')
        reads += 1
        return command
      },
    })
    try {
      assert.deepEqual(pool.slotIds, [2, 3], 'both live locks are busy, so the pool takes the next numbers')
      assert.equal(reads, 1, `the second liveness answer came from the 60 s cache: ${String(reads)} reader calls`)
    } finally {
      pool.close()
    }
  } finally {
    child.kill()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('an empty lock is busy inside the grace and dead after it', () => {
  // The defect this pins: an empty lock — an older build's in-place write, or a crash between
  // create and write — was treated as held forever, so the number was lost. It is held only
  // while its mtime is inside the grace.
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  const slotDir = stableSlotDirectory(repo, { baseDir: base, id: 0 })
  mkdirSync(dirname(slotLockPath(slotDir)), { recursive: true })
  writeFileSync(slotLockPath(slotDir), '')
  const young = new Date(Date.now() - 10_000)
  utimesSync(slotLockPath(slotDir), young, young)
  const inside = makePool(repo, base)
  try {
    assert.deepEqual(inside.slotIds, [1], 'an empty lock younger than the grace is busy')
  } finally {
    inside.close()
  }
  const old = new Date(Date.now() - 120_000)
  utimesSync(slotLockPath(slotDir), old, old)
  const after = makePool(repo, base)
  try {
    assert.deepEqual(after.slotIds, [0], 'an empty lock older than the grace is taken over')
    assert.equal(JSON.parse(readFileSync(slotLockPath(slotDir), 'utf8')).instance, after.instance)
  } finally {
    after.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('a leftover copy on a free number is moved aside for salvage and its cache stays in the slot', async () => {
  // The defect this pins: a fresh claim wrote its lock and left the directory alone, so the
  // next `prepare` emptied a dead worker's uncommitted copy. Whoever acquires the number now
  // moves anything besides `.flash-cache` aside first, and the sweep stores it as a patch.
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  const slotDir = stableSlotDirectory(repo, { baseDir: base, id: 0 })
  makeFlashBaseTree(slotDir)
  const saved = 'the last worker’s uncommitted fix\n'
  writeFileSync(join(slotDir, 'keep.txt'), saved)
  mkdirSync(join(slotDir, '.flash-cache', 'target'), { recursive: true })
  writeFileSync(join(slotDir, '.flash-cache', 'target', 'id'), 'warm\n')
  // No lock: a server that died between removing its lock and the next start leaves this.
  const pool = makePool(repo, base)
  try {
    assert.deepEqual(pool.slotIds, [0], 'the number is free')
    assert.equal(readFileSync(join(slotDir, '.flash-cache', 'target', 'id'), 'utf8'), 'warm\n', 'the cache moved back to the stable path')
    const record = pool.listPatches().find((entry) => entry.salvagedFrom !== undefined)
    assert.ok(record, `the work moved aside was salvaged: ${JSON.stringify(pool.listPatches())}`)
    assert.match(readFileSync(record.patchPath, 'utf8'), /uncommitted fix/)
    assert.equal(
      childrenStartingWith(slotsOf(base, repo), '0.dead-').length,
      0,
      'the salvaged tree is gone after the sweep',
    )
  } finally {
    pool.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('clean --all keeps a root whose only sign of life is a live slot lock', async () => {
  // The defect this pins: root liveness was the per-pid directories alone, so `--all`
  // reclaimed a foreign root's store while a live server still held one of its slots.
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  const foreignRoot = tempDir('flash-slots0112-foreign-')
  const foreign = join(base, rootDigest(foreignRoot))
  const slotDir = join(foreign, 'slots', '0')
  mkdirSync(slotDir, { recursive: true })
  const command = processCommandLine(process.pid)
  plantLock(slotDir, { pid: process.pid, command, instance: 'live0001' })
  mkdirSync(join(foreign, 'caches', '0', 'target'), { recursive: true })
  writeFileSync(join(foreign, 'caches', '0', 'target', 'id'), 'warm\n')
  try {
    await runClean(['--root', repo, '--state-base', base, '--all'], {
      env: { FLASH_DATA_DIR: process.env.FLASH_DATA_DIR },
      write: () => {},
    })
    assert.equal(existsSync(foreign), true, 'the live root’s digest stays')
    assert.equal(existsSync(slotDir), true, 'its slot directory stays')
    assert.equal(existsSync(slotLockPath(slotDir)), true, 'the live lock stays')
    assert.equal(
      readFileSync(join(foreign, 'caches', '0', 'target', 'id'), 'utf8'),
      'warm\n',
      'and the cache a live server may still claim stays',
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
    rmSync(foreignRoot, { recursive: true, force: true })
  }
})

test('retire logs no “could not lock” line for the lock the slot already holds', async () => {
  // The defect this pins: `retire` wrote the stable slot's own claim lock with `wx`, hit
  // EEXIST and logged a false "another server's sweep may salvage it" on every retire.
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  const logs = []
  const pool = makePool(repo, base, { log: (line) => logs.push(line) })
  try {
    const slot = await startCall(pool)
    pool.collect(slot)
    pool.retire(slot, { sessionStopped: true })
    assert.equal(
      logs.some((line) => line.includes('could not lock')),
      false,
      `no false lock failure on a normal retire: ${JSON.stringify(logs)}`,
    )
    assert.ok(logs.some((line) => line.startsWith('retired ')), 'the retire itself is still logged')
    assert.equal(existsSync(slotLockPath(slot.dir)), true, 'the fresh retired tree has its own lock')
  } finally {
    pool.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('close leaves a slot alone once another server has taken its lock over', async () => {
  // The defect this pins: `close` emptied and unlocked a slot by name alone. If another
  // server had taken the number over in the meantime, that server's live tree was emptied
  // under its running call.
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  const logs = []
  const pool = makePool(repo, base, { log: (line) => logs.push(line) })
  const slot = await startCall(pool)
  writeFileSync(join(slot.dir, 'keep.txt'), 'another server is writing here\n')
  // What a second pool's takeover leaves: this live pid, another pool's instance.
  const takeover = JSON.parse(readFileSync(slotLockPath(slot.dir), 'utf8'))
  takeover.instance = 'other001'
  writeFileSync(slotLockPath(slot.dir), `${JSON.stringify(takeover)}\n`)
  try {
    pool.close()
    assert.equal(existsSync(join(slot.dir, 'keep.txt')), true, 'the taken-over tree is not emptied')
    const lock = JSON.parse(readFileSync(slotLockPath(slot.dir), 'utf8'))
    assert.equal(lock.instance, 'other001', 'and its lock is not removed')
    assert.ok(
      logs.some((line) => line.includes('another server took the slot over')),
      `the takeover is logged: ${JSON.stringify(logs)}`,
    )
  } finally {
    pool.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('slots stay stable without hard links, and the sweep still salvages a dead tree', async () => {
  // The defect this pins: `linkSync` fails with ENOTSUP/EPERM on exFAT, FAT32 and some SMB
  // shares, which switched stable slots off and made every sweep refuse every tree. The lock
  // is created with an exclusive `open` there instead.
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  const deadDir = join(slotsOf(base, repo), '0.dead-4194303-1')
  makeFlashBaseTree(deadDir)
  writeFileSync(join(deadDir, 'keep.txt'), 'the dead worker’s uncommitted fix\n')
  plantDeadLock(deadDir)
  const logs = []
  const noHardLinks = () => {
    const error = new Error('ENOTSUP: operation not supported')
    error.code = 'ENOTSUP'
    throw error
  }
  const pool = makePool(repo, base, { log: (line) => logs.push(line), linkLock: noHardLinks })
  try {
    assert.deepEqual(pool.slotIds, [0], 'a number is still claimed without hard links')
    assert.equal(pool.slots[0].dir, stableSlotDirectory(repo, { baseDir: base, id: 0 }), 'so the slot keeps its stable path')
    const lock = JSON.parse(readFileSync(slotLockPath(pool.slots[0].dir), 'utf8'))
    assert.equal(lock.pid, process.pid, 'and its lock was created')
    const record = pool.listPatches().find((entry) => entry.salvagedFrom !== undefined)
    assert.ok(record, `the dead tree was still salvaged: ${JSON.stringify(logs)}`)
    assert.match(readFileSync(record.patchPath, 'utf8'), /uncommitted fix/)
    assert.equal(existsSync(deadDir), false, 'and removed after storing its work')
    assert.ok(
      logs.some((line) => line.includes('exclusive create') && line.includes('hard links')),
      `the lock method is named once: ${JSON.stringify(logs)}`,
    )
  } finally {
    pool.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('a foreign digest with only a fresh slot lock survives clean --all', async () => {
  // The defect this pins: removeEmptyForeignDigests removed a digest it judged empty without
  // looking at the root's own `slots` folder, so another root's server could lose the
  // directory its lock and tree live in. A lock there is that root's business.
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  const foreignRoot = tempDir('flash-slots0112-foreign-')
  const foreign = join(base, rootDigest(foreignRoot))
  const foreignSlots = join(foreign, 'slots')
  mkdirSync(foreignSlots, { recursive: true })
  // Dead on purpose: no live pid hides the digest behind `digestHasLiveOwner`.
  plantDeadLock(join(foreignSlots, '0'))
  try {
    await runClean(['--root', repo, '--state-base', base, '--all'], {
      env: { FLASH_DATA_DIR: process.env.FLASH_DATA_DIR },
      write: () => {},
    })
    assert.equal(existsSync(foreign), true, 'the foreign root’s digest stays while a fresh lock is in it')
    assert.equal(existsSync(join(foreignSlots, '0.lock')), true, 'and so does the lock')
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
    rmSync(foreignRoot, { recursive: true, force: true })
  }
})

test('the sweep removes leaked lock files but keeps a live slot lock', () => {
  // The defect this pins: `<n>.dead-*.lock`, `<n>.lock.stale-*` and `<n>.lock.tmp-*` whose
  // tree was gone, or that a crash left behind, were never removed.
  const repo = makeRepo()
  const base = tempDir('flash-slots0112-base-')
  const slots = slotsOf(base, repo)
  mkdirSync(slots, { recursive: true })
  const liveLock = slotLockPath(join(slots, '0'))
  plantLock(join(slots, '0'), { pid: process.pid, command: processCommandLine(process.pid), instance: 'live0001' })
  const tempLock = join(slots, '1.lock.tmp-4194303-deadbeef')
  writeFileSync(tempLock, '{"format":1,"pid":4194303')
  const old = new Date(Date.now() - 2 * 60_000)
  utimesSync(tempLock, old, old)
  const deadLock = join(slots, '2.dead-4194303-123.lock')
  writeFileSync(deadLock, `${JSON.stringify({ format: SLOT_LOCK_FORMAT, pid: DEAD_PID, command: DEAD_COMMAND, instance: 'dead0001' })}\n`)
  const pool = makePool(repo, base)
  try {
    assert.equal(existsSync(tempLock), false, 'a stale temp lock with no tree is removed')
    assert.equal(existsSync(deadLock), false, 'a dead tree’s lock whose tree is gone is removed')
    assert.equal(existsSync(liveLock), true, 'a live slot’s lock is never removed')
    assert.equal(JSON.parse(readFileSync(liveLock, 'utf8')).instance, 'live0001', 'and it is still the live owner’s')
  } finally {
    pool.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})
