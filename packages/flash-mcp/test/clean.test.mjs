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
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runClean } from '../lib/index.js'
import { rootDigest } from '../lib/isolation.js'

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

test('clean reports each root digest and reclaims this root’s dead trees and expired patches', async () => {
  const base = makeBase()
  const root = makeRoot()
  const own = rootDigest(root)
  const ownParent = join(base, own)
  const deadPid = '4194303'

  // This root: a dead owner with a 1.5 MB slot tree, one expired and one fresh patch.
  const ownSlot = join(ownParent, deadPid, 'slots', 'slot-0')
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
  assert.match(text, /removed: 1 dead owner\(s\), 1 expired patch\(es\), 1 empty digest\(s\)/)

  // Startup-equivalent cleanup, for this root only.
  assert.equal(existsSync(join(ownParent, deadPid)), false, 'this root’s dead owner is removed')
  assert.equal(existsSync(join(patches, `${expired}.patch`)), false, 'the expired patch is pruned')
  assert.equal(existsSync(join(patches, `${fresh}.patch`)), true, 'the fresh patch is kept')
  assert.equal(existsSync(join(base, emptyDigest)), false, 'the empty foreign digest is removed')
  assert.equal(existsSync(foreignLiveSlot), true, 'a foreign root with a live server is untouched')
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
