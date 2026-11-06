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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runClean } from '../lib/index.js'
import { cleanLayout, rootDigest } from '../lib/isolation.js'

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

/**
 * A service root reached through a symlink, as macOS's `/tmp` is: the real directory, and a
 * second spelling of it that `--root` can name.
 *
 * @returns {{real: string, link: string, holder: string}} the directory, a symlink to it, and
 *   the throwaway directory holding that symlink.
 */
function makeSymlinkedRoot() {
  const real = makeRoot()
  const holder = mkdtempSync(join(tmpdir(), 'flash-clean-link-'))
  const link = join(holder, 'root-link')
  symlinkSync(real, link, 'dir')
  return { real, link, holder }
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
    /removed: 1 dead owner\(s\), 1 expired patch\(es\), 0 expired report\(s\), 1 empty digest\(s\), 0 trash director/,
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
    /removed: 0 dead owner\(s\), 0 expired patch\(es\), 0 expired report\(s\), 0 empty digest\(s\), 1 trash directory/,
    'the summary counts the trash it removed',
  )
  assert.equal(existsSync(trash), false, 'the trash of an interrupted removal is removed')
  assert.deepEqual(trashDirsIn(join(base, own)), [], 'and nothing is left to a background removal')
})

test('clean reclaims a report write a crash left behind, and leaves a fresh one alone', async () => {
  // A report goes to `.<key>.<uuid>.tmp` in the same directory and is renamed into place. A
  // crash between the two leaves that file, and no reader ever opens it: without this prune it
  // sat in the report directory forever.
  const base = makeBase()
  const root = makeRoot()
  const own = rootDigest(root)
  const reports = join(base, own, 'reports')
  mkdirSync(reports, { recursive: true })
  const stale = join(reports, `.job-a70m1c000.${randomUUID()}.tmp`)
  const fresh = join(reports, `.job-a70m1c001.${randomUUID()}.tmp`)
  writeFileSync(stale, '{"key": "job-a70m1c000", "report": "half a rep')
  writeFileSync(fresh, '{"key": "job-a70m1c001", "report": "half a rep')
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  utimesSync(stale, twoHoursAgo, twoHoursAgo)
  // A file that is neither a report nor a report write is not this prune's business.
  const other = join(reports, 'notes.txt')
  writeFileSync(other, 'kept\n')
  utimesSync(other, twoHoursAgo, twoHoursAgo)

  const lines = []
  const code = await runClean([], { env: { FLASH_SERVICE_ROOT: root }, write: (text) => lines.push(text), baseDir: base })
  assert.equal(code, 0)
  assert.equal(existsSync(stale), false, 'the half-written report of a crashed write is reclaimed')
  assert.equal(existsSync(fresh), true, 'a temporary file a live write may still rename is left alone')
  assert.equal(existsSync(other), true, 'a file that is not a report write is not removed')
  assert.match(lines.join(''), /1 expired report\(s\)/, 'the summary counts the temp file it reclaimed')
})

test('clean prints each root’s reports and counts the reports it pruned', async () => {
  // `cleanLayout` measured the reports all along, but the report line and the summary said
  // nothing about them, so an operator reading `clean` saw a directory it could not account for.
  const base = makeBase()
  const { real, link, holder } = makeSymlinkedRoot()
  try {
    const own = rootDigest(real)
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-clean-data-reports-')))
    const patchDir = join(dataDir, own, 'patches')
    mkdirSync(patchDir, { recursive: true })
    const expiredPatch = writePatch(patchDir, real, { createdAt: Date.now() - 30 * DAY_MS })
    const reports = join(base, own, 'reports')
    mkdirSync(reports, { recursive: true })
    const kept = join(reports, 'job-keep00001.report.json')
    writeFileSync(kept, `{"key": "job-keep00001", "report": "${'x'.repeat(512 * 1024)}"}\n`)
    const expiredReport = join(reports, 'job-old000001.report.json')
    writeFileSync(expiredReport, '{"key": "job-old000001", "report": "gone"}\n')
    const monthAgo = new Date(Date.now() - 30 * DAY_MS)
    utimesSync(expiredReport, monthAgo, monthAgo)

    const lines = []
    // The root is named through a symlink, as `/tmp/x` is on macOS: the line must be this
    // root's, and the patches it prunes must be the ones the server stored.
    const code = await runClean(['--root', link], { env: { FLASH_DATA_DIR: dataDir }, write: (text) => lines.push(text), baseDir: base })
    assert.equal(code, 0)
    const text = lines.join('')
    const line = text.split('\n').find((entry) => entry.includes(`${own} (this root)`))
    assert.ok(line, `expected this root’s report line in ${JSON.stringify(lines)}`)
    // Counted before the prune, as the patch count is: the line describes what was found.
    assert.match(line, /reports: 2 \(0\.5 MB\)/, 'the line names the reports and their size, as it does patches')
    assert.match(
      text,
      /removed: 0 dead owner\(s\), 1 expired patch\(es\), 1 expired report\(s\)/,
      'the summary counts the reports it pruned',
    )
    assert.equal(existsSync(expiredReport), false, 'an expired report is pruned')
    assert.equal(existsSync(kept), true, 'a fresh report is a record of a call, not disk to reclaim')
    assert.equal(existsSync(join(patchDir, `${expiredPatch}.patch`)), false, 'a symlinked --root still prunes its patches')
  } finally {
    rmSync(holder, { recursive: true, force: true })
  }
})

test('cleanLayout keys the state by the real root, not by a symlinked spelling of it', async () => {
  // The service digests the realpath'd root; `cleanLayout` digested the string it was given, so
  // a symlinked root reported an empty digest and pruned none of that root's patches or reports.
  const base = makeBase()
  const { real, link, holder } = makeSymlinkedRoot()
  try {
    const digest = rootDigest(real)
    assert.notEqual(rootDigest(link), digest, 'the two spellings of one root digest differently')
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-clean-data-link-')))
    const patchDir = join(dataDir, digest, 'patches')
    mkdirSync(patchDir, { recursive: true })
    const expired = writePatch(patchDir, real, { createdAt: Date.now() - 30 * DAY_MS })
    const reports = join(base, digest, 'reports')
    mkdirSync(reports, { recursive: true })
    const expiredReport = join(reports, 'job-0123456789.report.json')
    writeFileSync(expiredReport, '{"key": "job-0123456789", "report": "gone"}\n')
    const monthAgo = new Date(Date.now() - 30 * DAY_MS)
    utimesSync(expiredReport, monthAgo, monthAgo)

    const report = cleanLayout({ baseDir: base, dataDir, root: link })
    assert.equal(report.own, digest, 'the digest is taken from the real root')
    assert.equal(report.stats.find((entry) => entry.digest === digest)?.own, true, 'the real digest is this root’s line')
    assert.equal(report.stats.find((entry) => entry.digest === rootDigest(link)), undefined, 'no digest of the link spelling')
    assert.equal(existsSync(join(patchDir, `${expired}.patch`)), false, 'this root’s expired patch is pruned')
    assert.equal(report.actions.patchesPruned, 1, 'and counted')
    assert.equal(existsSync(expiredReport), false, 'this root’s expired report is pruned too')
    assert.equal(report.actions.reportsPruned, 1, 'and counted')
  } finally {
    rmSync(holder, { recursive: true, force: true })
  }
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
  assert.match(text, /removed: 0 dead owner\(s\), 2 expired patch\(es\), 0 expired report\(s\), 0 empty digest\(s\)/)

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
  const code = await runClean(['--all', '--root', root], { env: {}, write: (text) => lines.push(text), baseDir: base })
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

test('clean refuses a relative state base and expands a leading ~', async () => {
  const refusal = '--state-base must be an absolute path (got "rel")'
  // A throwaway root: `clean` reads that root's local settings, and this test must not
  // depend on whether this repository's own root has one.
  const root = makeRoot()
  await assert.rejects(
    () => runClean(['--root', root, '--state-base', 'rel'], { env: {}, write: () => {} }),
    (error) => error.message === refusal,
  )
  await assert.rejects(
    () => runClean(['--root', root], { env: { FLASH_STATE_BASE: 'rel' }, write: () => {} }),
    (error) => error.message === refusal,
  )

  // A `~` base is expanded against the injected home, not left as a literal `~` directory.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'flash-clean-home-')))
  try {
    const lines = []
    const code = await runClean(['--root', home], {
      env: { FLASH_STATE_BASE: '~/flash-base' },
      home,
      write: (text) => lines.push(text),
    })
    assert.equal(code, 0)
    assert.ok(lines.join('').includes(`${join(home, 'flash-base')}`), lines.join(''))
    assert.ok(lines.join('').includes('flash-mcp state: '))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('FLASH_STATE_BASE and --state-base make clean read that base', async () => {
  const fromEnv = makeBase()
  const fromFlag = makeBase()
  const root = makeRoot()
  /** Plant one dead owner's slot tree under a base. */
  function plant(base) {
    const slot = join(base, rootDigest(root), '4194303', 'dead0001', 'slots', 'slot-0')
    mkdirSync(slot, { recursive: true })
    writeFileSync(join(slot, 'leftover.txt'), 'a crashed worker left this\n')
    return join(base, rootDigest(root), '4194303')
  }
  try {
    const envOwner = plant(fromEnv)
    const flagOwner = plant(fromFlag)

    const envLines = []
    // The environment base is the one the server was started with, so clean defaults to it.
    await runClean(['--root', root], { env: { FLASH_STATE_BASE: fromEnv }, write: (text) => envLines.push(text) })
    assert.ok(envLines.join('').includes(fromEnv), 'the report names the base from FLASH_STATE_BASE')
    assert.equal(existsSync(envOwner), false)
    assert.equal(existsSync(flagOwner), true, 'another base is not touched')

    const flagLines = []
    await runClean(['--root', root, '--state-base', fromFlag], { env: {}, write: (text) => flagLines.push(text) })
    assert.ok(flagLines.join('').includes(fromFlag))
    assert.equal(existsSync(flagOwner), false)
  } finally {
    for (const base of [fromEnv, fromFlag]) rmSync(base, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
