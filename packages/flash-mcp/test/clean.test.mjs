/**
 * Contract tests for the `clean` CLI command.
 *
 * The default state base is global (`$TMPDIR/flash-mcp`), so the tests fabricate a
 * layout under a temp base and inject it: a digest per root, a directory per server
 * pid, a `slots/` tree under each, and a `patches/` directory that outlives the
 * process. The properties under test are the ones an operator relies on: the report
 * names each root's live pids and its disk cost in MB, the default reclaims exactly
 * what a startup would for `--root`, and `--all` additionally removes the trees of
 * roots with no live server without ever touching their patches.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runClean } from '../lib/index.js'
import { rootDigest } from '../lib/isolation.js'

/**
 * `clean` reads the durable patch store from `FLASH_DATA_DIR`, so every test here points
 * it at a throwaway directory rather than the real user data directory.
 */
process.env.FLASH_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'flash-clean-data-')))

/** A throwaway state base directory. */
function makeBase() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'flash-clean-')))
}

/** A throwaway service root. */
function makeRoot() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'flash-clean-root-')))
}

/** A patch record and its file, as `collect` writes one. */
function writePatch(patchDir, root, { createdAt, ...extra }) {
  const patchId = `flash-${randomUUID()}`
  writeFileSync(join(patchDir, `${patchId}.patch`), 'a stored patch\n')
  writeFileSync(
    join(patchDir, `${patchId}.json`),
    `${JSON.stringify({ patchId, root, createdAt, appliedAt: null, ...extra }, null, 2)}\n`,
  )
  return patchId
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The `trash-*` entries of a digest directory: a removal that was renamed but whose
 * deletion did not finish. `clean` must leave none behind when it returns.
 *
 * @param {string} dir - a root's digest directory under the injected base.
 * @returns {string[]} the trash directory names.
 */
function trashDirsIn(dir) {
  try {
    return readdirSync(dir).filter((name) => name.startsWith('trash-'))
  } catch {
    return []
  }
}

test('clean reports each root digest and reclaims this root’s dead trees and expired patches', async () => {
  const base = makeBase()
  const root = makeRoot()
  const own = rootDigest(root)
  const ownParent = join(base, own)
  const deadPid = '4194303'

  // This root: a dead owner in the real layout — `<pid>/<instance>/slots/<name>` — with a
  // 1.5 MB slot tree, one expired and one fresh patch. The older `<pid>/slots` layout is
  // exercised by the foreign live root below, and must be counted too.
  const ownSlot = join(ownParent, deadPid, 'ca5ca5ca', 'slots', 'slot-0')
  mkdirSync(ownSlot, { recursive: true })
  writeFileSync(join(ownSlot, 'work.txt'), 'x'.repeat(Math.floor(1.5 * 1024 * 1024)))
  const patches = join(ownParent, 'patches')
  mkdirSync(patches, { recursive: true })
  const expired = writePatch(patches, root, { createdAt: Date.now() - 30 * DAY_MS })
  const fresh = writePatch(patches, root, { createdAt: Date.now() - DAY_MS })

  // Another root with a live server: its tree must survive the default run.
  const foreignLiveDigest = '0f1e2d3c4b5a'
  const livePid = String(process.pid)
  const foreignLiveSlot = join(base, foreignLiveDigest, livePid, 'slots', 'slot-0')
  mkdirSync(foreignLiveSlot, { recursive: true })
  writeFileSync(join(foreignLiveSlot, 'live.txt'), 'y'.repeat(2 * 1024 * 1024))
  // An empty leftover of a throwaway root.
  const emptyDigest = '00ff00ff00ff'
  mkdirSync(join(base, emptyDigest, 'patches'), { recursive: true })

  const lines = []
  const code = await runClean([], {
    env: { FLASH_SERVICE_ROOT: root },
    write: (text) => lines.push(text),
    baseDir: base,
  })
  assert.equal(code, 0)
  const text = lines.join('')
  assert.match(text, new RegExp(`flash-mcp state: ${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(text, new RegExp(`${own} \\(this root\\)`))
  assert.match(text, new RegExp(`live pids: ${livePid}`))
  assert.match(text, /slot trees: 1 \(1\.5 MB\)/)
  assert.match(text, /slot trees: 1 \(2\.0 MB\)/)
  assert.match(text, /patches: 2 \(0\.0 MB\)/)
  assert.match(
    text,
    /removed: 1 dead owner\(s\), 1 expired patch\(es\), 1 empty digest\(s\), 0 trash director/,
    'the summary names the trash count even when there was none',
  )

  // Startup-equivalent cleanup, for this root only.
  assert.equal(existsSync(join(ownParent, deadPid)), false, 'this root’s dead owner is removed')
  // Removal is synchronous: the process exits as soon as the summary is printed, so a
  // renamed `trash-*` tree would otherwise be abandoned with it while the summary claimed
  // the space was reclaimed.
  assert.deepEqual(trashDirsIn(ownParent), [], 'no trash is left when clean returns')
  assert.equal(existsSync(join(patches, `${expired}.patch`)), false, 'the expired patch is pruned')
  assert.equal(existsSync(join(patches, `${fresh}.patch`)), true, 'the fresh patch is kept')
  assert.equal(existsSync(join(base, emptyDigest)), false, 'the empty foreign digest is removed')
  assert.equal(existsSync(foreignLiveSlot), true, 'a foreign root with a live server is untouched')
})

test('clean removes and reports the trash an interrupted removal left behind', async () => {
  // A removal is a rename to `trash-<pid>-<ms>` plus a background delete. A process killed
  // in between leaves the trash; only `clean` (and the next server's sweep) can reclaim it,
  // and the operator must see that it happened rather than wonder where the space went.
  const base = makeBase()
  const root = makeRoot()
  const own = rootDigest(root)
  const trash = join(base, own, 'trash-4242-1700000000000')
  mkdirSync(join(trash, 'slots', 'slot-0'), { recursive: true })
  writeFileSync(join(trash, 'slots', 'slot-0', 'left.txt'), 'x'.repeat(1024))

  const lines = []
  const code = await runClean([], { env: { FLASH_SERVICE_ROOT: root }, write: (text) => lines.push(text), baseDir: base })
  assert.equal(code, 0)
  const text = lines.join('')
  assert.match(text, /trash-4242-1700000000000/, 'the removed trash is named')
  assert.match(
    text,
    /removed: 0 dead owner\(s\), 0 expired patch\(es\), 0 empty digest\(s\), 1 trash directory/,
    'the summary counts the trash it removed',
  )
  assert.equal(existsSync(trash), false, 'the trash of an interrupted removal is removed')
  assert.deepEqual(trashDirsIn(join(base, own)), [], 'and nothing is left to a background removal')
})

test('clean prunes the durable store and a legacy temp store, and reports both locations', async () => {
  const base = makeBase()
  const root = makeRoot()
  const own = rootDigest(root)
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-clean-data-case-')))
  const patchDir = join(dataDir, own, 'patches')
  const legacyPatchDir = join(base, own, 'patches')
  mkdirSync(patchDir, { recursive: true })
  mkdirSync(legacyPatchDir, { recursive: true })
  const now = Date.now()
  const expiredNew = writePatch(patchDir, root, { createdAt: now - 30 * DAY_MS })
  const freshNew = writePatch(patchDir, root, { createdAt: now - DAY_MS })
  const expiredLegacy = writePatch(legacyPatchDir, root, { createdAt: now - 30 * DAY_MS })
  const freshLegacy = writePatch(legacyPatchDir, root, { createdAt: now - DAY_MS })

  const lines = []
  const code = await runClean([], {
    env: { FLASH_SERVICE_ROOT: root, FLASH_DATA_DIR: dataDir },
    write: (text) => lines.push(text),
    baseDir: base,
  })
  assert.equal(code, 0)
  const text = lines.join('')
  assert.match(text, new RegExp(`flash-mcp patches: ${patchDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(text, new RegExp(`flash-mcp legacy patches: ${legacyPatchDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(text, /patches: 4 \(0\.0 MB\)/, 'this root’s line counts the durable store and the legacy one')
  assert.match(text, /removed: 0 dead owner\(s\), 2 expired patch\(es\), 0 empty digest\(s\)/)

  assert.equal(existsSync(join(patchDir, `${expiredNew}.patch`)), false, 'an expired durable patch is pruned')
  assert.equal(existsSync(join(patchDir, `${freshNew}.patch`)), true, 'a fresh durable patch is kept')
  assert.equal(existsSync(join(legacyPatchDir, `${expiredLegacy}.patch`)), false, 'an expired legacy patch is pruned')
  assert.equal(existsSync(join(legacyPatchDir, `${freshLegacy}.patch`)), true, 'fresh work in the temp tree is not deleted')
})

test('clean reports the durable patch count on this root’s line', async () => {
  // The defect this guards: `clean` read only `<tempBase>/<digest>/patches`, so after the
  // upgrade it printed `patches: 0` for a root whose patches were all in the durable store.
  const base = makeBase()
  const root = makeRoot()
  const own = rootDigest(root)
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-clean-data-count-')))
  const patchDir = join(dataDir, own, 'patches')
  const legacyDir = join(base, own, 'patches')
  mkdirSync(patchDir, { recursive: true })
  mkdirSync(legacyDir, { recursive: true })
  const now = Date.now()
  const durableIds = [
    writePatch(patchDir, root, { createdAt: now }),
    writePatch(patchDir, root, { createdAt: now }),
  ]
  const legacyId = writePatch(legacyDir, root, { createdAt: now })

  const lines = []
  const code = await runClean([], {
    env: { FLASH_SERVICE_ROOT: root, FLASH_DATA_DIR: dataDir },
    write: (text) => lines.push(text),
    baseDir: base,
  })
  assert.equal(code, 0)
  const line = lines.join('').split('\n').find((entry) => entry.includes(`${own} (this root)`))
  assert.ok(line, `expected this root’s report line in ${JSON.stringify(lines)}`)
  assert.match(line, /patches: 3 \(0\.0 MB\)/)
  // The count is a report, not a cleanup: every fresh patch is still there.
  for (const patchId of [...durableIds, legacyId]) {
    assert.equal(existsSync(join(patchId === legacyId ? legacyDir : patchDir, `${patchId}.patch`)), true)
  }
})

test('clean --all removes the trees of roots with no live server, never their patches', async () => {
  const base = makeBase()
  const root = makeRoot()

  // A foreign root whose server is gone, with a tree and a patch.
  const deadDigest = 'aabbccddeeff'
  const deadPid = '4194303'
  const deadSlot = join(base, deadDigest, deadPid, 'slots', 'slot-0')
  mkdirSync(deadSlot, { recursive: true })
  writeFileSync(join(deadSlot, 'work.txt'), 'z')
  const patches = join(base, deadDigest, 'patches')
  mkdirSync(patches, { recursive: true })
  const kept = writePatch(patches, '/some/other/root', { createdAt: Date.now() })

  // A foreign root whose server is live stays put even with --all.
  const liveDigest = '123456abcdef'
  const liveSlot = join(base, liveDigest, String(process.pid), 'slots', 'slot-0')
  mkdirSync(liveSlot, { recursive: true })
  writeFileSync(join(liveSlot, 'live.txt'), 'live')

  const lines = []
  const code = await runClean(['--all'], { env: {}, write: (text) => lines.push(text), baseDir: base })
  assert.equal(code, 0)
  assert.match(lines.join(''), /foreign tree\(s\)/)

  assert.equal(existsSync(join(base, deadDigest, deadPid)), false, 'a dead foreign tree is removed with --all')
  assert.equal(existsSync(join(patches, `${kept}.patch`)), true, 'a patch is never removed by --all')
  assert.equal(existsSync(liveSlot), true, 'a live foreign root is untouched')
})

test('clean refuses an unknown argument and answers --help', async () => {
  const base = makeBase()
  await assert.rejects(
    () => runClean(['--nope'], { env: {}, write: () => {}, baseDir: base }),
    /unknown argument/,
  )
  const lines = []
  const code = await runClean(['--help'], { env: {}, write: (text) => lines.push(text), baseDir: base })
  assert.equal(code, 0)
  assert.match(lines.join(''), /flash-agents clean/)
})
