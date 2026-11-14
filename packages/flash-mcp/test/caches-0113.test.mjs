/**
 * 0.1.13 build-cache cap (issue #5): with stable slots a root's build caches only grow — 78 GB
 * on one machine, 39.8 GB of it in one slot. `maxCacheBytes` bounds them, least recently used
 * first: the stored caches, then this server's idle slots, never a slot with a call in flight.
 *
 * Every pool runs in the default layout under a throwaway base, with the durable data
 * directory pointed at a throwaway directory and a stubbed `statfs`, so nothing here touches
 * the real temp state base, the real data directory or the real volume.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseOptions } from '../lib/index.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { cacheStoreDir, WorkspaceIsolation } from '../lib/isolation.js'

process.env.FLASH_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'flash-caches0113-data-')))

const ROOMY = () => ({ bsize: 4096, blocks: 1_000_000_000, bavail: 500_000_000 })
const MB = 1024 * 1024

function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

function makeRepo() {
  const dir = tempDir('flash-caches0113-repo-')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# project\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: dir })
  return dir
}

/** Put `megabytes` of build output into a cache directory. */
function fill(cacheDir, megabytes) {
  mkdirSync(join(cacheDir, 'target', 'debug'), { recursive: true })
  writeFileSync(join(cacheDir, 'target', 'debug', 'libcore.rlib'), Buffer.alloc(megabytes * MB))
}

test('the cache trim removes the stored caches, then the least recently used idle slot, never a busy one', async () => {
  const repo = makeRepo()
  const base = tempDir('flash-caches0113-base-')
  const logs = []
  const pool = new WorkspaceIsolation({
    root: repo,
    slots: 3,
    baseDir: base,
    statfs: ROOMY,
    sweepIntervalMs: 0,
    maxCacheBytes: 7 * MB,
    log: (line) => logs.push(line),
  })
  try {
    const [busy, recent, old] = pool.slots
    // A stored cache from a server that has gone, and three slot caches of this pool.
    const store = cacheStoreDir(base, repo)
    fill(join(store, '0'), 2)
    fill(join(busy.dir, '.flash-cache'), 3)
    fill(join(recent.dir, '.flash-cache'), 3)
    fill(join(old.dir, '.flash-cache'), 3)
    busy.busy = true
    recent.releasedAt = Date.now()
    old.releasedAt = Date.now() - 60 * 60_000

    // 11 MB against a 7 MB cap: the stored 2 MB and then the oldest idle slot's 3 MB go.
    const result = await pool.trimCaches()
    assert.equal(result.removed, 2)
    assert.equal(result.bytes, 6 * MB)
    assert.equal(existsSync(join(store, '0')), false, 'the stored cache, used by no server, went first')
    assert.equal(existsSync(join(old.dir, '.flash-cache', 'target')), false, 'then the slot idle longest')
    assert.equal(existsSync(join(recent.dir, '.flash-cache', 'target')), true, 'the recently used slot keeps its cache')
    assert.equal(existsSync(join(busy.dir, '.flash-cache', 'target')), true, 'a busy slot is never trimmed')
    assert.ok(logs.some((line) => /cache trim: removed the build cache of slot \d+ .*\(3\.0 MB\), least recently used, to stay under the 7\.0 MB cap/.test(line)), logs.join('\n'))

    // Over the cap with only the busy slot left: reported, not trimmed.
    fill(join(recent.dir, '.flash-cache'), 6)
    recent.busy = true
    const second = await pool.trimCaches()
    assert.equal(second.removed, 0)
    assert.ok(logs.some((line) => line.includes('over the 7.0 MB cap; what is left belongs to slots with a call in flight')), logs.join('\n'))
  } finally {
    pool.close()
  }
})

test('no cap is the default, and FLASH_MAX_CACHE_BYTES or --max-cache-bytes set one', async () => {
  assert.equal(DEFAULT_CONFIG.limits.maxCacheBytes, 0, 'a cache is what makes a build warm; capping it is the operator’s call')
  assert.equal(parseOptions(['--root', tmpdir()], {}).maxCacheBytes, 0)
  assert.equal(parseOptions(['--root', tmpdir()], { FLASH_MAX_CACHE_BYTES: '1000' }).maxCacheBytes, 1000)
  assert.equal(parseOptions(['--root', tmpdir(), '--max-cache-bytes', '2000'], { FLASH_MAX_CACHE_BYTES: '1000' }).maxCacheBytes, 2000)

  const repo = makeRepo()
  const pool = new WorkspaceIsolation({ root: repo, slots: 1, baseDir: tempDir('flash-caches0113-off-'), statfs: ROOMY, sweepIntervalMs: 0 })
  try {
    fill(join(pool.slots[0].dir, '.flash-cache'), 1)
    assert.deepEqual(await pool.trimCaches(), { bytes: 0, removed: 0 })
    assert.equal(existsSync(join(pool.slots[0].dir, '.flash-cache', 'target')), true)
  } finally {
    pool.close()
  }
})
