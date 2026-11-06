/**
 * One side of a slot-claim race, for a test that needs two real processes.
 *
 * Both children wait for the barrier file, construct a real pool over the same root and
 * state base at the moment it appears, write their claimed numbers and directories, and
 * then wait for the stop file before closing. Waiting keeps the winning lock's pid alive
 * while the parent inspects it; `deferStartupSweep` keeps the sweep from removing the tree
 * the race moved aside before the parent has looked at it.
 *
 * Usage: node slot-race.mjs <repo> <baseDir> <barrier> <stop> <out>
 */

import { existsSync, writeFileSync } from 'node:fs'

import { WorkspaceIsolation } from '../lib/isolation.js'

const [root, baseDir, barrier, stop, out] = process.argv.slice(2)
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
while (!existsSync(barrier)) await settle(5)
const pool = new WorkspaceIsolation({
  root,
  baseDir,
  slots: 1,
  deferStartupSweep: true,
  sweepIntervalMs: 0,
  statfs: () => ({ bsize: 4096, blocks: 1_000_000_000, bavail: 500_000_000 }),
})
writeFileSync(out, `${JSON.stringify({ pid: process.pid, slotIds: pool.slotIds, dirs: pool.slots.map((slot) => slot.dir) })}\n`)
while (!existsSync(stop)) await settle(10)
pool.close()
