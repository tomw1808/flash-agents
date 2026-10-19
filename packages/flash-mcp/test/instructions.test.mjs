/**
 * The instruction-file estimate: what every worker is given before it reads the task.
 *
 * The rules replicate the harness's own (`@deepseek-ai/dsh-agent-instructions`): the
 * project root is the nearest `.git` at or above the worker's cwd, every directory from
 * there down contributes `AGENTS.md`, `CLAUDE.md`, then the `.local.md` overlays, a
 * sibling repeating an earlier sibling's text is dropped, the user-global
 * `$DSH_HOME/AGENTS.md` comes first, and the whole set is capped at 64 KB.
 *
 * Every test passes its own `dshHome`, so the machine's real `~/.dsh/AGENTS.md` can
 * never change what these assert.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_INSTRUCTIONS_BUDGET, estimateInstructions } from '../lib/instructions.js'

/** A fresh temporary directory. */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'flash-instructions-'))
}

/** Write one file and return the byte count the estimate should report for it. */
function write(dir, name, text) {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, text)
  return { path, bytes: Buffer.byteLength(text) }
}

/** An empty harness home, so no global instruction file is found. */
function emptyHome() {
  return tempDir()
}

/** Only the paths of an estimate, in order, which is what most tests pin. */
function paths(estimate) {
  return estimate.files.map((file) => file.path)
}

test('the project root is the nearest directory holding a .git, not a further one', () => {
  const outer = tempDir()
  mkdirSync(join(outer, '.git'))
  write(outer, 'AGENTS.md', 'outer rules\n')
  const project = join(outer, 'project')
  mkdirSync(join(project, '.git'), { recursive: true })
  write(project, 'AGENTS.md', 'project rules\n')
  const nested = join(project, 'packages', 'app')
  write(nested, 'CLAUDE.md', 'nested rules\n')

  const estimate = estimateInstructions({ cwd: nested, dshHome: emptyHome() })
  assert.deepEqual(paths(estimate), ['AGENTS.md', 'packages/app/CLAUDE.md'])
  // The file above the nearest `.git` belongs to another repository and is not loaded.
  assert.equal(paths(estimate).includes('../AGENTS.md'), false)
})

test('a .git file marks the root too, as in a linked worktree', () => {
  const outer = tempDir()
  mkdirSync(join(outer, '.git'))
  write(outer, 'AGENTS.md', 'outer rules\n')
  const worktree = join(outer, 'worktree')
  mkdirSync(worktree)
  writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/worktree\n')
  write(worktree, 'AGENTS.md', 'worktree rules\n')
  const sub = join(worktree, 'src')
  write(sub, 'AGENTS.md', 'src rules\n')

  const estimate = estimateInstructions({ cwd: sub, dshHome: emptyHome() })
  assert.deepEqual(paths(estimate), ['AGENTS.md', 'src/AGENTS.md'])
})

test('with no repository the working directory is the project root', () => {
  const parent = tempDir()
  write(parent, 'AGENTS.md', 'parent rules\n')
  const project = join(parent, 'plain')
  write(project, 'AGENTS.md', 'plain rules\n')

  const estimate = estimateInstructions({ cwd: project, dshHome: emptyHome() })
  assert.deepEqual(paths(estimate), ['AGENTS.md'])
  assert.equal(estimate.files[0].bytes, Buffer.byteLength('plain rules\n'))
})

test('every directory from the root down is loaded, broadest first', () => {
  const root = tempDir()
  mkdirSync(join(root, '.git'))
  write(root, 'AGENTS.md', 'root\n')
  const middle = join(root, 'packages')
  write(middle, 'CLAUDE.md', 'middle\n')
  const leaf = join(middle, 'flash-mcp')
  write(leaf, 'AGENTS.local.md', 'leaf\n')

  const estimate = estimateInstructions({ cwd: leaf, dshHome: emptyHome() })
  assert.deepEqual(paths(estimate), ['AGENTS.md', 'packages/CLAUDE.md', 'packages/flash-mcp/AGENTS.local.md'])
  assert.deepEqual(
    estimate.files.map((file) => file.bytes),
    [Buffer.byteLength('root\n'), Buffer.byteLength('middle\n'), Buffer.byteLength('leaf\n')],
  )
})

test('both agent files and both local overlays are loaded, in harness order', () => {
  const root = tempDir()
  mkdirSync(join(root, '.git'))
  write(root, 'AGENTS.local.md', 'agents local\n')
  write(root, 'CLAUDE.local.md', 'claude local\n')
  write(root, 'AGENTS.md', 'agents\n')
  write(root, 'CLAUDE.md', 'claude\n')

  const estimate = estimateInstructions({ cwd: root, dshHome: emptyHome() })
  assert.deepEqual(paths(estimate), ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'])
})

test('a sibling repeating an earlier sibling’s text is dropped', () => {
  const root = tempDir()
  mkdirSync(join(root, '.git'))
  write(root, 'AGENTS.md', 'the same rules\n')
  // Same text but for whitespace: the harness compares trimmed content.
  write(root, 'CLAUDE.md', '\n  the same rules\n\n')
  write(root, 'AGENTS.local.md', 'something else\n')

  const estimate = estimateInstructions({ cwd: root, dshHome: emptyHome() })
  assert.deepEqual(paths(estimate), ['AGENTS.md', 'AGENTS.local.md'])
})

test('the same text in two directories is not a duplicate', () => {
  const root = tempDir()
  mkdirSync(join(root, '.git'))
  write(root, 'AGENTS.md', 'shared\n')
  const sub = join(root, 'sub')
  write(sub, 'AGENTS.md', 'shared\n')

  const estimate = estimateInstructions({ cwd: sub, dshHome: emptyHome() })
  assert.deepEqual(paths(estimate), ['AGENTS.md', 'sub/AGENTS.md'])
})

test('the user-global file comes first, named from the harness home', () => {
  // A fabricated home, so the label the default `~/.dsh` spelling produces can be pinned
  // without reading or writing the machine's real one.
  const home = tempDir()
  const dshHome = join(home, '.dsh')
  write(dshHome, 'AGENTS.md', 'global rules\n')
  const root = tempDir()
  mkdirSync(join(root, '.git'))
  write(root, 'AGENTS.md', 'project rules\n')

  const estimate = estimateInstructions({ cwd: root, dshHome, home })
  assert.equal(estimate.files[0].path, '~/.dsh/AGENTS.md')
  assert.equal(estimate.files[0].bytes, Buffer.byteLength('global rules\n'))
  assert.deepEqual(paths(estimate).slice(1), ['AGENTS.md'])
  // The total is what the worker is actually given: global plus project.
  assert.equal(estimate.bytes, Buffer.byteLength('global rules\n') + Buffer.byteLength('project rules\n'))
})

test('a harness home outside the user’s home keeps its real path', () => {
  const dshHome = join(tempDir(), '.dsh')
  write(dshHome, 'AGENTS.md', 'global rules\n')
  const root = tempDir()

  const estimate = estimateInstructions({ cwd: root, dshHome, home: tempDir() })
  // Not `~/…`: claiming a directory that does not exist in the user's home would mislead.
  assert.equal(estimate.files[0].path, dshHome.split('\\').join('/') + '/AGENTS.md')
})

test('a set over the byte budget is flagged, and the estimate stays exact', () => {
  const root = tempDir()
  mkdirSync(join(root, '.git'))
  const text = 'x'.repeat(200)
  write(root, 'AGENTS.md', text)

  const under = estimateInstructions({ cwd: root, dshHome: emptyHome(), budgetBytes: 1024 })
  assert.equal(under.overBudget, false)
  assert.equal(under.budgetBytes, 1024)
  assert.equal(under.bytes, 200)
  assert.equal(under.approxTokens, 50)

  const over = estimateInstructions({ cwd: root, dshHome: emptyHome(), budgetBytes: 100 })
  assert.equal(over.overBudget, true)
  assert.equal(over.budgetBytes, 100)
  assert.equal(over.bytes, 200)

  // The shipped profile's budget is the harness's own.
  assert.equal(DEFAULT_INSTRUCTIONS_BUDGET, 65_536)
  assert.equal(estimateInstructions({ cwd: root, dshHome: emptyHome() }).budgetBytes, 65_536)
})

test('an unreadable file is skipped, not thrown', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const root = tempDir()
  mkdirSync(join(root, '.git'))
  write(root, 'AGENTS.md', 'readable\n')
  const hidden = write(root, 'CLAUDE.md', 'unreadable\n')
  write(root, 'AGENTS.local.md', 'readable too\n')
  chmodSync(hidden.path, 0o000)
  try {
    const estimate = estimateInstructions({ cwd: root, dshHome: emptyHome() })
    assert.deepEqual(paths(estimate), ['AGENTS.md', 'AGENTS.local.md'])
  } finally {
    chmodSync(hidden.path, 0o644)
  }
})

test('a cwd that does not exist yields an empty estimate instead of throwing', () => {
  const missing = join(tempDir(), 'gone', 'deeper')
  const estimate = estimateInstructions({ cwd: missing, dshHome: emptyHome() })
  assert.deepEqual(estimate, {
    files: [],
    bytes: 0,
    budgetBytes: DEFAULT_INSTRUCTIONS_BUDGET,
    overBudget: false,
    approxTokens: 0,
  })
})

test('a directory is not a candidate, and neither is a file named like a directory', () => {
  const root = tempDir()
  mkdirSync(join(root, '.git'))
  // A directory called AGENTS.md is not a regular file and must be ignored.
  mkdirSync(join(root, 'AGENTS.md'))
  write(root, 'CLAUDE.md', 'the real rules\n')

  const estimate = estimateInstructions({ cwd: root, dshHome: emptyHome() })
  assert.deepEqual(paths(estimate), ['CLAUDE.md'])
})
