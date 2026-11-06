/**
 * A live pool in a process of its own, for the test that a live server's slot is not taken.
 *
 * Constructs a real pool over `<repo>` and `<baseDir>` with the real command-line reader —
 * the test injects nothing — claims slot 0, prepares its tree and leaves one uncommitted
 * file in it, then prints a single `ready` line with the pid, the numbers it holds, its tree
 * and that file's content, and waits to be killed. The parent inspects slot 0's lock and
 * tree while this process runs, then kills it to leave a dead server's lock behind.
 *
 * Usage: node pool-holder.mjs <repo> <baseDir>
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { WorkspaceIsolation } from '../lib/isolation.js'

const [root, baseDir] = process.argv.slice(2)

/** The file this worker leaves uncommitted, so the parent can tell its tree was not touched. */
const WORK_FILE = 'child-work.txt'
const WORK = 'the running worker’s uncommitted edit\n'

const pool = new WorkspaceIsolation({
  root,
  baseDir,
  slots: 1,
  deferStartupSweep: true,
  sweepIntervalMs: 0,
  statfs: () => ({ bsize: 4096, blocks: 1_000_000_000, bavail: 500_000_000 }),
})
if (pool.slotIds[0] !== 0) throw new Error(`claimed ${JSON.stringify(pool.slotIds)} instead of slot 0`)

const slot = await pool.lease()
pool.prepare(slot)
writeFileSync(join(slot.dir, WORK_FILE), WORK)
process.stdout.write(`ready ${JSON.stringify({ pid: process.pid, slotIds: pool.slotIds, dir: slot.dir, workFile: WORK_FILE, work: WORK })}\n`)

// The parent kills this process; until then the lock has to stay held and the tree untouched.
setInterval(() => {}, 60_000)
