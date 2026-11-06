/**
 * Build caches outlive the server process, and the disk the copies take is visible.
 *
 * Real repositories, real `git`, real pools, `clean` and `doctor` entry points; the worker
 * runtime is the small stand-in slots.test.mjs uses. Every directory is a fresh temporary
 * one and every pool is given a temp `baseDir`: no test reads or writes the real home,
 * `DSH_HOME`, the temp state base or the data directory. `statfs` and the cache rename are
 * injected, so no test depends on the free space of the machine it runs on.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { DISK_CHECK_ID, runChecks } from '../lib/doctor.js'
import { runClean } from '../lib/index.js'
import { defaultStateDir, measureDisk, rootDigest, stableSlotDirectory, WorkspaceIsolation } from '../lib/isolation.js'
import { FlashTaskService } from '../lib/service.js'

/** Stored patches go to the durable data directory by default; keep them out of the real one. */
process.env.FLASH_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'flash-slots0111-data-')))

/** A pid no process has (the Linux and macOS maximum plus one is never allocated). */
const DEAD_PID = 4194303

/** A fresh temporary directory, realpath'd so macOS `/var` vs `/private/var` cannot bite. */
function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

/** A committed repository whose settings put a cargo-style target in the slot cache. */
function makeRepo() {
  const dir = tempDir('flash-slots0111-repo-')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# project\n')
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
  symlinkSync(join('deps', 'libapp.rlib'), join(target, 'debug', 'latest'))
  return target
}

/** Plant a stored cache directly, as an earlier server would have left it. */
function plantStored(baseDir, repo, number, files, { ageDays = 0 } = {}) {
  const dir = join(baseDir, rootDigest(repo), 'caches', String(number))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  const when = new Date(Date.now() - ageDays * 86_400_000)
  utimesSync(dir, when, when)
  return dir
}

/** The numbers in a root's cache store. */
function storedNumbers(baseDir, repo) {
  const dir = join(baseDir, rootDigest(repo), 'caches')
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

/** A dead server's slot tree with a cache holding `files`, laid out as a real server writes it. */
function plantDeadSlot(baseDir, repo, { pid = DEAD_PID, instance = 'dead0001', slot = 'slot-0', files }) {
  const slotDir = join(defaultStateDir(repo, { baseDir, pid, instance }), 'slots', slot)
  mkdirSync(slotDir, { recursive: true })
  writeFileSync(join(slotDir, 'README.md'), '# copy\n')
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(slotDir, '.flash-cache', name, '..'), { recursive: true })
    writeFileSync(join(slotDir, '.flash-cache', name), text)
  }
  return slotDir
}

test('a build cache stays in its stable slot, so the next server on the root finds it there', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-slots0111-base-')
  const first = makePool(repo, base)
  const logs = []
  try {
    const slot = await startCall(first)
    assert.equal(slot.buildCacheEmpty, true, 'the first server on a fresh root starts cold')
    assert.equal(slot.buildCacheFrom, undefined)
    const target = writeBuild(first, slot, 'one')
    const slotDir = slot.dir
    first.release(slot)
    first.close()
    // The slot's directory is the path the next server of this root claims, so its cache is
    // already where that server looks and is not moved out (see `stableSlotDirectory`).
    assert.equal(slotDir, stableSlotDirectory(repo, { baseDir: base, id: 0 }))
    assert.deepEqual(storedNumbers(base, repo), [], 'a cache in place in a stable slot is not moved into the store')
    assert.equal(readFileSync(join(target, 'debug', 'deps', 'libapp.rlib'), 'utf8'), 'built one\n', 'the cache stayed in the slot')

    const second = makePool(repo, base, { log: (line) => logs.push(line) })
    try {
      const next = await startCall(second)
      assert.equal(next.dir, slotDir, 'the next server claims the same slot path')
      assert.equal(next.buildCacheEmpty, false, 'the next server starts warm')
      assert.equal(next.buildCacheFrom, undefined, 'its cache was in place, not taken from the store')
      const built = join(second.slotEnvFor(next).CARGO_TARGET_DIR, 'debug', 'deps', 'libapp.rlib')
      assert.equal(readFileSync(built, 'utf8'), 'built one\n')
      assert.equal(lstatSync(join(second.slotEnvFor(next).CARGO_TARGET_DIR, 'debug', 'latest')).isSymbolicLink(), true, 'a link inside the cache arrives as a link')
      assert.deepEqual(storedNumbers(base, repo), [], 'the store was not needed')
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

test('the result of a service call says where its warm cache came from', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-slots0111-base-')
  const home = tempDir('flash-slots0111-home-')
  plantStored(base, repo, 0, { 'target/debug/app': 'binary from an earlier server\n' })
  const runtime = new FakeRuntime()
  const service = new FlashTaskService({
    root: repo,
    home,
    env: { DSH_HOME: join(home, '.dsh') },
    clientFactory: (profileName, cwd, extraEnv) => {
      runtime.extraEnv = extraEnv
      return runtime
    },
    log: () => {},
    isolate: { slots: 1, baseDir: base, statfs: ROOMY },
    honoursModelEnv: () => true,
    earlyRetryDelayMs: 0,
  })
  try {
    const result = await service.flashTask({ task: 'build it', apply: 'discard' })
    assert.equal(result.status, 'ok')
    assert.equal(result.isolation.buildCacheFrom, 'store')
    assert.equal(Object.hasOwn(result.isolation, 'buildCacheEmpty'), false)
  } finally {
    await service.close()
    for (const dir of [repo, base, home]) rmSync(dir, { recursive: true, force: true })
  }
})

test('a cache left by a dead server is rescued at the next start instead of deleted', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-slots0111-base-')
  const slotDir = plantDeadSlot(base, repo, { files: { 'target/debug/deps/a.rlib': 'aaaa', 'target/debug/b': 'bb' } })
  const pool = makePool(repo, base)
  try {
    assert.equal(existsSync(slotDir), false, 'the dead owner was removed')
    assert.equal(existsSync(join(base, rootDigest(repo), String(DEAD_PID))), false)
    assert.deepEqual(storedNumbers(base, repo), ['0'])
    const slot = await startCall(pool)
    assert.equal(slot.buildCacheFrom, 'store')
    assert.equal(readFileSync(join(pool.slotEnvFor(slot).CARGO_TARGET_DIR, 'debug', 'deps', 'a.rlib'), 'utf8'), 'aaaa')
  } finally {
    pool.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('the deferred start-up sweep rescues a dead server’s cache too', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-slots0111-base-')
  plantDeadSlot(base, repo, { files: { 'target/x': 'x' } })
  const pool = makePool(repo, base, { deferStartupSweep: true })
  try {
    assert.deepEqual(storedNumbers(base, repo), [], 'nothing is swept before the handshake')
    await pool.startupSweep()
    assert.deepEqual(storedNumbers(base, repo), ['0'])
  } finally {
    pool.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('two servers on one root never claim the same cache', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-slots0111-base-')
  plantStored(base, repo, 0, { 'target/id': 'zero' })
  plantStored(base, repo, 1, { 'target/id': 'one' })
  const a = makePool(repo, base, { slots: 2 })
  const b = makePool(repo, base, { slots: 2 })
  try {
    const first = await startCall(a)
    const second = await startCall(b)
    const idOf = (pool, slot) => readFileSync(join(pool.slotEnvFor(slot).CARGO_TARGET_DIR, 'id'), 'utf8')
    assert.deepEqual([idOf(a, first), idOf(b, second)].sort(), ['one', 'zero'])
    const third = await startCall(a)
    assert.equal(third.buildCacheFrom, undefined, 'a third slot finds the store empty and starts cold')
    assert.equal(third.buildCacheEmpty, true)
  } finally {
    a.close()
    b.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('the store keeps the newest caches up to the slot count and drops the expired', () => {
  const repo = makeRepo()
  const base = tempDir('flash-slots0111-base-')
  plantStored(base, repo, 0, { 'a/f': 'old' }, { ageDays: 5 })
  plantStored(base, repo, 1, { 'a/f': 'newest' }, { ageDays: 1 })
  plantStored(base, repo, 2, { 'a/f': 'middle' }, { ageDays: 3 })
  plantStored(base, repo, 3, { 'a/f': 'expired' }, { ageDays: 40 })
  const pool = makePool(repo, base, { slots: 2 })
  try {
    // Two slots keep two caches: the newest two of those inside the 14-day window.
    assert.deepEqual(storedNumbers(base, repo), ['1', '2'])
  } finally {
    pool.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('a rename that fails starts the slot cold, logs it, and leaves the stored cache alone', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-slots0111-base-')
  const stored = plantStored(base, repo, 0, { 'target/debug/app': 'warm' })
  const logs = []
  const pool = makePool(repo, base, {
    log: (line) => logs.push(line),
    renameDirectory: () => {
      const error = new Error('EBUSY: resource busy or locked')
      error.code = 'EBUSY'
      throw error
    },
  })
  try {
    const slot = await startCall(pool)
    assert.equal(slot.buildCacheEmpty, true)
    assert.equal(slot.buildCacheFrom, undefined)
    assert.equal(logs.filter((line) => /could not claim stored build cache .*EBUSY.*starts cold/.test(line)).length, 1, logs.join('\n'))
    assert.equal(readFileSync(join(stored, 'target', 'debug', 'app'), 'utf8'), 'warm', 'nothing was copied or lost')
  } finally {
    pool.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('the 0.1.10 hand-over of a retired slot’s cache still wins over the store', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-slots0111-base-')
  plantStored(base, repo, 0, { 'target/id': 'stored' })
  const pool = makePool(repo, base)
  try {
    const slot = await startCall(pool)
    assert.equal(slot.buildCacheFrom, 'store')
    writeFileSync(join(pool.slotEnvFor(slot).CARGO_TARGET_DIR, 'id'), 'retired')
    pool.retire(slot, { sessionStopped: true })
    pool.release(slot)
    const retry = await startCall(pool)
    assert.equal(retry.buildCacheFrom, 'retired-slot')
    assert.equal(readFileSync(join(pool.slotEnvFor(retry).CARGO_TARGET_DIR, 'id'), 'utf8'), 'retired')
  } finally {
    pool.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('a nearly full state volume puts a warning on the call; a roomy one does not', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-slots0111-base-')
  const warningsOf = async (statfs) => {
    const pool = makePool(repo, base, { statfs })
    try {
      const slot = await pool.lease()
      return slot.settingsWarnings ?? []
    } finally {
      pool.close()
    }
  }
  try {
    // 5 % of a 4 GB volume free: below both thresholds.
    const low = await warningsOf(() => ({ bsize: 4096, blocks: 1_000_000, bavail: 50_000 }))
    assert.equal(low.length, 1)
    assert.match(low[0], /only 195\.3 MB of 3\.8 GB is free/)
    assert.ok(low[0].includes(base), 'names the state base')
    assert.match(low[0], /flash-agents clean/)
    assert.match(low[0], /flash-agents doctor/)

    // 6 GiB free of a 100 GiB volume: over 5 GiB, under 10 %.
    const gib = 1024 ** 3
    const fraction = await warningsOf(() => ({ bsize: 1, blocks: 100 * gib, bavail: 6 * gib }))
    assert.equal(fraction.length, 1, 'a tenth of the volume is the other threshold')

    // 20 GiB free of 100 GiB, and 4 GiB free of 20 GiB (20 %, but under 5 GiB).
    assert.deepEqual(await warningsOf(() => ({ bsize: 1, blocks: 100 * gib, bavail: 20 * gib })), [])
    assert.equal((await warningsOf(() => ({ bsize: 1, blocks: 20 * gib, bavail: 4 * gib }))).length, 1)
    assert.deepEqual(await warningsOf(ROOMY), [])
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('the low-disk warning reaches the service result and does not block the call', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-slots0111-base-')
  const home = tempDir('flash-slots0111-home-')
  const runtime = new FakeRuntime()
  const service = new FlashTaskService({
    root: repo,
    home,
    env: { DSH_HOME: join(home, '.dsh') },
    clientFactory: (profileName, cwd, extraEnv) => {
      runtime.extraEnv = extraEnv
      return runtime
    },
    log: () => {},
    isolate: { slots: 1, baseDir: base, statfs: () => ({ bsize: 4096, blocks: 1_000_000, bavail: 50_000 }) },
    honoursModelEnv: () => true,
    earlyRetryDelayMs: 0,
  })
  try {
    const result = await service.flashTask({ task: 'build it', apply: 'discard' })
    assert.equal(result.status, 'ok')
    assert.equal((result.warnings ?? []).filter((warning) => /is free on the volume/.test(warning)).length, 1, JSON.stringify(result.warnings))
  } finally {
    await service.close()
    for (const dir of [repo, base, home]) rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * A real-shaped layout with known byte counts: a dead server with two slots, a cache holding
 * nested folders and two symlinks (one to a file in the cache, one to a folder), and a
 * stored cache. Returns the expected sizes.
 */
function plantSizedLayout(base, repo) {
  const slot0 = plantDeadSlot(base, repo, { slot: 'slot-0', files: { 'target/debug/deps/a.rlib': 'a'.repeat(1000), 'target/debug/b.bin': 'b'.repeat(2000) } })
  // Copy: README.md (`# copy\n`, 7 bytes) plus nested source of 300 + 50 bytes.
  mkdirSync(join(slot0, 'src', 'deep'), { recursive: true })
  writeFileSync(join(slot0, 'src', 'main.rs'), 'm'.repeat(300))
  writeFileSync(join(slot0, 'src', 'deep', 'lib.rs'), 'l'.repeat(50))
  symlinkSync(join(slot0, '.flash-cache', 'target', 'debug', 'deps', 'a.rlib'), join(slot0, '.flash-cache', 'target', 'link-to-file'))
  symlinkSync(join(slot0, '.flash-cache', 'target'), join(slot0, '.flash-cache', 'target', 'loop'))
  symlinkSync(join(slot0, '.flash-cache', 'target', 'debug', 'deps', 'a.rlib'), join(slot0, 'src', 'link-into-cache'))
  const slot1 = plantDeadSlot(base, repo, { slot: 'slot-1', files: { 'target/c': 'c'.repeat(10) } })
  writeFileSync(join(slot1, 'big.txt'), 'z'.repeat(40))
  plantStored(base, repo, 0, { 'target/x': 'x'.repeat(500), 'target/sub/y': 'y'.repeat(25) })
  return { slot0Copy: 7 + 300 + 50, slot0Cache: 3000, slot1Copy: 7 + 40, slot1Cache: 10, store: 525 }
}

test('measureDisk sizes copies, caches and the store from the files, following no symlink', () => {
  const repo = makeRepo()
  const base = tempDir('flash-slots0111-base-')
  const expected = plantSizedLayout(base, repo)
  try {
    const report = measureDisk(repo, { baseDir: base, statfs: () => ({ bsize: 1024, blocks: 1000, bavail: 250 }) })
    const byLabel = Object.fromEntries(report.slots.map((slot) => [slot.label.split('/').pop(), slot]))
    assert.equal(byLabel['slot-0'].copyBytes, expected.slot0Copy)
    assert.equal(byLabel['slot-0'].cacheBytes, expected.slot0Cache)
    assert.equal(byLabel['slot-1'].copyBytes, expected.slot1Copy)
    assert.equal(byLabel['slot-1'].cacheBytes, expected.slot1Cache)
    assert.equal(byLabel['slot-0'].live, false)
    assert.equal(report.store.bytes, expected.store)
    assert.deepEqual(report.store.caches.map((cache) => cache.bytes), [expected.store])
    assert.deepEqual({ free: report.volume.freeBytes, total: report.volume.totalBytes }, { free: 250 * 1024, total: 1000 * 1024 })
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('doctor has a state-disk row with the sizes and the volume, and warns on a low one', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-slots0111-base-')
  const dsh = tempDir('flash-slots0111-dsh-')
  plantSizedLayout(base, repo)
  const rowFor = async (statfs, disk = true) => {
    const result = await runChecks({
      env: {},
      home: dsh,
      dshHome: dsh,
      root: repo,
      stateBase: base,
      platform: 'linux',
      nodePath: '/fake/node',
      launcher: { command: 'dsh', prefix: [] },
      run: () => ({ status: 1, stdout: '', stderr: 'not found' }),
      probe: async () => false,
      generate: async () => ({ ok: false, status: 0 }),
      disk,
      statfs,
    })
    return result.checks.find((check) => check.id === DISK_CHECK_ID)
  }
  try {
    const ok = await rowFor(ROOMY)
    assert.equal(ok.status, 'ok')
    assert.match(ok.detail, /2 slot copy\(ies\) take 404 B plus 3 KB of build cache/)
    assert.match(ok.detail, /slot-0 \(dead server\): copy 357 B, cache 3 KB/)
    assert.match(ok.detail, /the cache store .*caches holds 1 cache\(s\), 525 B/)
    assert.match(ok.detail, /GB of .* is free on the volume/)
    const low = await rowFor(() => ({ bsize: 4096, blocks: 1_000_000, bavail: 50_000 }))
    assert.equal(low.status, 'warn')
    assert.match(low.fix, /flash-agents clean/)
    assert.equal(await rowFor(ROOMY, false), undefined, 'the walk is only done when asked for')
  } finally {
    for (const dir of [repo, base, dsh]) rmSync(dir, { recursive: true, force: true })
  }
})

test('clean lists stored caches with their size and removes them, never a live server’s', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-slots0111-base-')
  const digest = join(base, rootDigest(repo))
  const mib = 1024 * 1024
  plantStored(base, repo, 0, { 'target/big': 'x'.repeat(mib) })
  plantStored(base, repo, 1, { 'target/big': 'y'.repeat(mib) })
  // A live server (this process) with a cache of its own in its slot: untouched by clean.
  const live = plantDeadSlot(base, repo, { pid: process.pid, instance: 'live0001', files: { 'target/mine': 'mine' } })
  const lines = []
  try {
    const code = await runClean([], { env: { FLASH_SERVICE_ROOT: repo }, write: (text) => lines.push(text), baseDir: base })
    assert.equal(code, 0)
    const text = lines.join('')
    assert.match(text, /stored caches: 2 \(2\.0 MB\)/)
    assert.match(text, /2 stored cache\(s\)/)
    assert.deepEqual(storedNumbers(base, repo), [])
    assert.equal(existsSync(join(live, '.flash-cache', 'target', 'mine')), true, 'a live server’s cache is never removed')
    assert.deepEqual(readdirSync(digest).filter((name) => name.startsWith('trash-')), [], 'no trash is left behind')
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('clean --caches removes stored caches and a dead server’s slot caches, and nothing else', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-slots0111-base-')
  plantStored(base, repo, 0, { 'target/x': 'x' })
  const dead = plantDeadSlot(base, repo, { files: { 'target/y': 'y' } })
  const live = plantDeadSlot(base, repo, { pid: process.pid, instance: 'live0001', files: { 'target/mine': 'mine' } })
  const lines = []
  try {
    const code = await runClean(['--caches'], { env: { FLASH_SERVICE_ROOT: repo }, write: (text) => lines.push(text), baseDir: base })
    assert.equal(code, 0)
    assert.match(lines.join(''), /removed: 2 build cache\(s\).*nothing else was touched/)
    assert.deepEqual(storedNumbers(base, repo), [])
    assert.equal(existsSync(join(dead, '.flash-cache')), false, 'the dead slot’s cache is gone')
    assert.equal(existsSync(join(dead, 'README.md')), true, 'its tree and owner are left for the normal sweep')
    assert.equal(existsSync(join(live, '.flash-cache', 'target', 'mine')), true)
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

/** A runtime stand-in that runs one worker per prompt and builds into the slot cache. */
class FakeRuntime {
  constructor() {
    this.pid = 4343
    this.cwd = undefined
    this.extraEnv = undefined
    this.handlers = new Set()
    this.exitHandlers = new Set()
    this.prompts = 0
  }

  start() {
    return this.pid
  }

  async initialize(params) {
    this.cwd = params.cwd
    return { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' }
  }

  async prompt({ sessionId }) {
    this.prompts += 1
    queueMicrotask(() => this.#work(sessionId))
    return { messageId: `msg-${String(this.prompts)}` }
  }

  #work(sessionId) {
    const child = `child-${sessionId}`
    this.emit('session.status', { sessionId, status: 'running' })
    this.emit('subagent.started', { parentSessionId: sessionId, childSessionId: child })
    this.emit('subagent.finished', {
      provider: 'flash',
      agentId: 'agent-0',
      parentSessionId: sessionId,
      childSessionId: child,
      status: 'ok',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'done' }],
    })
    this.emit('session.status', { sessionId, status: 'idle' })
  }

  onNotification(handler) {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  onExit(handler) {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
  }

  async shutdown() {}

  emit(method, params) {
    for (const handler of this.handlers) handler(method, params)
  }
}
