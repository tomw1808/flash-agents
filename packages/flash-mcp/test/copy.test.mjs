/**
 * Contract tests for the copy a writing call gets: what it leaves out, what it starts
 * from, and how it survives a tree that is changing underneath it.
 *
 * These run against real temporary directories and a real `git`, because the properties
 * under test are properties of the filesystem, of the caller's index, and of what the walk
 * does when a build deletes a file mid-copy — none of which a stub can stand in for.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { DEFAULT_COPY_EXCLUDE, SETUP_NOT_ALLOWED_WARNING, WorkspaceIsolation, copyTree } from '../lib/isolation.js'
import { FlashTaskService, FlashTaskError, buildChildPrompt } from '../lib/service.js'
import { parseOptions } from '../lib/index.js'
import { mergeConfig } from '../lib/config.js'

/** A throwaway repository, realpath'd so macOS `/var` vs `/private/var` cannot bite. */
function makeRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-')))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# project\n')
  writeFileSync(join(dir, 'keep.txt'), 'keep me\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: dir })
  return dir
}

/** One line of git output, trimmed. */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** One ref's id, or '' when it does not exist (where `git` itself would throw). */
function revParse(dir, ref) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '-q', ref], { cwd: dir, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

/**
 * Point a repository's `.git` at a directory elsewhere, as a worktree-session checkout or a
 * repository whose state lives on another volume does. Returns the external git directory.
 */
function moveGitDirAside(repo) {
  const store = realpathSync(mkdtempSync(join(tmpdir(), 'flash-gitlink-')))
  const gitDir = join(store, 'git')
  renameSync(join(repo, '.git'), gitDir)
  symlinkSync(gitDir, join(repo, '.git'), 'dir')
  return gitDir
}

/** A pool over a repository with a private state directory, plus extra pool options. */
function makePool(repo, options = {}) {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-state-')))
  return { isolation: new WorkspaceIsolation({ root: repo, slots: 1, stateDir, ...options }), stateDir }
}

/** An Error shaped like the ENOENT `fs` throws, for the test seam. */
function enoent(path) {
  const error = new Error(`ENOENT: no such file or directory, '${path}'`)
  error.code = 'ENOENT'
  return error
}

/** A symlink's text, or undefined when nothing was created there (a recorded junction). */
function readlinkSafe(path) {
  try {
    return readlinkSync(path)
  } catch {
    return undefined
  }
}

// ── entries that vanish mid-copy ────────────────────────────────────────────

test('copyTree skips and counts a file that vanished between readdir and the copy', () => {
  const from = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-from-')))
  const to = mkdtempSync(join(tmpdir(), 'flash-copy-to-'))
  writeFileSync(join(from, 'kept.txt'), 'kept\n')
  writeFileSync(join(from, 'vanishing.txt'), 'gone\n')
  // The seam: only the file a build would have rewritten throws. Everything else copies.
  const fs = {
    copyFileSync: (source, target, ...rest) => {
      if (source.endsWith('vanishing.txt')) throw enoent(source)
      return copyFileSync(source, target, ...rest)
    },
  }
  const result = copyTree(from, to, { fs })
  assert.equal(result.vanished, 1)
  assert.equal(existsSync(join(to, 'kept.txt')), true)
  assert.equal(existsSync(join(to, 'vanishing.txt')), false)
})

test('copyTree survives a directory that vanished before it could be listed', () => {
  const from = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-from-')))
  const to = mkdtempSync(join(tmpdir(), 'flash-copy-to-'))
  mkdirSync(join(from, 'build'), { recursive: true })
  writeFileSync(join(from, 'build', 'out.bin'), 'x\n')
  writeFileSync(join(from, 'kept.txt'), 'kept\n')
  const fs = {
    readdirSync: (source, ...rest) => {
      if (source.endsWith('build')) throw enoent(source)
      return readdirSync(source, ...rest)
    },
  }
  const result = copyTree(from, to, { fs })
  assert.equal(result.vanished, 1)
  assert.equal(existsSync(join(to, 'kept.txt')), true)
  assert.equal(existsSync(join(to, 'build', 'out.bin')), false)
})

test('copyTree still fails when the top directory itself is missing', () => {
  const to = mkdtempSync(join(tmpdir(), 'flash-copy-to-'))
  assert.throws(
    () => copyTree(join(to, 'does-not-exist'), join(to, 'out')),
    (error) => error.code === 'ENOENT',
  )
})

test('copyTree leaves out a nested repository whose .git is a symlink outside the tree', () => {
  const from = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-from-')))
  const to = mkdtempSync(join(tmpdir(), 'flash-copy-to-'))
  // A nested checkout whose git state lives outside the tree being copied, like a linked
  // worktree. `readFileSync` on the symlink throws EISDIR, which used to read as "ordinary
  // directory" and copied the link verbatim — into the copy it still named the outside tree.
  const store = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-store-')))
  execFileSync('git', ['init', '-q'], { cwd: store })
  mkdirSync(join(from, 'nested'))
  writeFileSync(join(from, 'nested', 'file.txt'), 'x\n')
  symlinkSync(store, join(from, 'nested', '.git'), 'dir')
  writeFileSync(join(from, 'kept.txt'), 'kept\n')

  const result = copyTree(from, to)
  assert.deepEqual(result.skipped, ['nested'])
  assert.equal(existsSync(join(to, 'nested')), false)
  assert.equal(existsSync(join(to, 'kept.txt')), true)
})

// ── symlinks in the copy ────────────────────────────────────────────────────

test('an absolute link to a path inside the tree is re-pointed into the copy', () => {
  const from = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-from-')))
  const to = mkdtempSync(join(tmpdir(), 'flash-copy-to-'))
  mkdirSync(join(from, 'pkg'), { recursive: true })
  writeFileSync(join(from, 'pkg', 'index.js'), 'dep\n')
  // A hand-made workspace link, named by absolute path, as a repository that keeps its
  // dependency elsewhere in the tree does.
  symlinkSync(join(from, 'pkg'), join(from, 'link'), 'dir')

  const result = copyTree(from, to)
  // Verbatim, the link would still name the caller's tree, so a worker reading through it
  // would read the caller's live files and writing through it would reach them.
  assert.equal(readlinkSync(join(to, 'link')), join(to, 'pkg'))
  writeFileSync(join(to, 'link', 'written.js'), 'worker\n')
  assert.equal(readFileSync(join(to, 'pkg', 'written.js'), 'utf8'), 'worker\n', 'a write through the copy’s link lands in the copy')
  assert.equal(existsSync(join(from, 'pkg', 'written.js')), false, 'the caller’s tree is not reachable through the copy')
  assert.equal(result.linksRepointed, 1)
})

test('a relative link keeps its text exactly', () => {
  const from = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-from-')))
  const to = mkdtempSync(join(tmpdir(), 'flash-copy-to-'))
  mkdirSync(join(from, 'pkg'))
  writeFileSync(join(from, 'pkg', 'index.js'), 'dep\n')
  mkdirSync(join(from, 'app'))
  // Relative text resolves inside the copy on its own, because the whole tree moved.
  symlinkSync('../pkg', join(from, 'app', 'dep'), 'dir')

  const result = copyTree(from, to)
  assert.equal(readlinkSync(join(to, 'app', 'dep')), '../pkg')
  assert.equal(readFileSync(join(to, 'app', 'dep', 'index.js'), 'utf8'), 'dep\n')
  assert.equal(result.linksRepointed, 0)
})

test('an absolute link to a path outside the tree keeps its text exactly', () => {
  const from = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-from-')))
  const to = mkdtempSync(join(tmpdir(), 'flash-copy-to-'))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-outside-')))
  mkdirSync(join(outside, 'shared'))
  writeFileSync(join(outside, 'shared', 'x.txt'), 'shared\n')
  symlinkSync(join(outside, 'shared'), join(from, 'shared'), 'dir')

  const result = copyTree(from, to)
  assert.equal(readlinkSync(join(to, 'shared')), join(outside, 'shared'), 'there is nothing in the copy to point at instead')
  assert.equal(result.linksRepointed, 0)
})

test('an absolute link spelled through a symlinked ancestor is re-pointed into the copy', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-alias-')))
  const from = join(base, 'repo')
  const to = join(base, 'copy')
  mkdirSync(join(from, 'pkg'), { recursive: true })
  mkdirSync(to)
  writeFileSync(join(from, 'pkg', 'index.js'), 'dep\n')
  // The same directory spelled through a symlinked ancestor: a plain string comparison
  // against `from` does not see it as inside the tree, so the link used to be copied
  // verbatim — and a write through the copy reached the source.
  symlinkSync(base, join(base, 'alias'), 'dir')
  symlinkSync(join(base, 'alias', 'repo', 'pkg'), join(from, 'link'), 'dir')

  const result = copyTree(from, to)
  assert.equal(result.linksRepointed, 1)
  assert.equal(readlinkSync(join(to, 'link')), join(to, 'pkg'))
  writeFileSync(join(to, 'link', 'written.js'), 'worker\n')
  assert.equal(readFileSync(join(to, 'pkg', 'written.js'), 'utf8'), 'worker\n')
  assert.equal(existsSync(join(from, 'pkg', 'written.js')), false, 'the alias spelling must not reach the caller’s tree')
})

test('on darwin a link spelled in a different case is re-pointed into the copy', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('a case-insensitive volume is a macOS behaviour')
    return
  }
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-case-')))
  const from = join(base, 'repo')
  const to = join(base, 'copy')
  mkdirSync(from)
  mkdirSync(to)
  writeFileSync(join(from, 'file.txt'), 'source\n')
  const shout = from.toUpperCase()
  if (shout === from) {
    t.skip('the temporary path has no letters to change case')
    return
  }
  // The very same directory as `from`, spelled in upper case. On a case-insensitive volume
  // the link resolves there, but the string was not `from`, so it used to be copied as-is.
  symlinkSync(shout, join(from, 'link'), 'dir')

  const result = copyTree(from, to)
  assert.equal(result.linksRepointed, 1)
  assert.equal(readlinkSync(join(to, 'link')), to, 'the copy’s link names the copy root')
  writeFileSync(join(to, 'link', 'written.txt'), 'worker\n')
  assert.equal(readFileSync(join(to, 'written.txt'), 'utf8'), 'worker\n', 'the write lands in the copy')
  assert.equal(existsSync(join(from, 'written.txt')), false, 'the caller’s tree is not reachable through the copy')
})

test('on win32 a refused in-tree directory link becomes a junction, and the rest are left out', () => {
  const from = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-from-')))
  const to = mkdtempSync(join(tmpdir(), 'flash-copy-to-'))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-outside-')))
  mkdirSync(join(from, 'pkg'))
  writeFileSync(join(from, 'pkg', 'index.js'), 'dep\n')
  writeFileSync(join(from, 'target.txt'), 'file\n')
  symlinkSync(join(from, 'pkg'), join(from, 'in-tree'), 'dir')
  symlinkSync(outside, join(from, 'out-of-tree'), 'dir')
  symlinkSync(join(from, 'target.txt'), join(from, 'file-link'), 'file')

  const calls = []
  // Windows without Developer Mode or the symlink privilege: every plain symlink is
  // refused, a junction is allowed. The junction is recorded rather than created.
  const fs = {
    symlinkSync: (target, path, type) => {
      calls.push({ target, path, type })
      if (type !== 'junction') {
        const error = new Error(`EPERM: operation not permitted, symlink '${target}' -> '${path}'`)
        error.code = 'EPERM'
        throw error
      }
    },
  }
  const result = copyTree(from, to, { fs, platform: 'win32' })

  assert.equal(result.linksRepointed, 1, 'the junction fallback is a re-pointed link')
  const junctions = calls.filter((call) => call.type === 'junction')
  assert.equal(junctions.length, 1, `expected one junction, got ${JSON.stringify(calls)}`)
  assert.equal(junctions[0].target, join(to, 'pkg'), 'a junction gets an absolute path inside the copy')
  assert.ok(isAbsolute(junctions[0].target))
  assert.equal(readlinkSafe(join(to, 'in-tree')), undefined, 'the junction was recorded, not created')

  const skipped = Object.fromEntries(result.linksSkipped.map((entry) => [entry.path, entry]))
  assert.deepEqual(Object.keys(skipped).sort(), ['file-link', 'out-of-tree'])
  assert.match(skipped['out-of-tree'].reason, /outside the copy/, 'an out-of-tree junction would be a write path out')
  assert.match(skipped['file-link'].reason, /(Developer Mode|symlink privilege)/)
  assert.equal(existsSync(join(to, 'out-of-tree')), false)
  assert.equal(existsSync(join(to, 'file-link')), false)
})

test('on win32 a junction whose relative target lands outside the copy is left out', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-junction-')))
  const from = join(base, 'repo')
  const to = join(base, 'state', 'copy')
  mkdirSync(join(from, 'pkg'), { recursive: true })
  mkdirSync(to, { recursive: true })
  writeFileSync(join(from, 'pkg', 'index.js'), 'dep\n')
  // Relative text that leaves the copy's directory and re-enters the caller's tree by name.
  // The source-side guard sees a directory inside the tree; the junction's own absolute
  // target, resolved against the link's directory, is outside the copy.
  symlinkSync('../repo/pkg', join(from, 'link'), 'dir')

  const calls = []
  const fs = {
    symlinkSync: (target, path, type) => {
      calls.push({ target, path, type })
      if (type !== 'junction') {
        const error = new Error(`EPERM: operation not permitted, symlink '${target}' -> '${path}'`)
        error.code = 'EPERM'
        throw error
      }
    },
  }
  const result = copyTree(from, to, { fs, platform: 'win32' })

  assert.deepEqual(calls.filter((call) => call.type === 'junction'), [], 'no junction may point outside the copy')
  assert.equal(result.linksSkipped.length, 1)
  assert.equal(result.linksSkipped[0].path, 'link')
  assert.match(result.linksSkipped[0].reason, /its target is outside the copy/)
  assert.equal(result.linksRepointed, 0)
  assert.equal(existsSync(join(to, 'link')), false)
})

test('a non-EPERM symlink error still fails the copy', () => {
  const from = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-from-')))
  const to = mkdtempSync(join(tmpdir(), 'flash-copy-to-'))
  mkdirSync(join(from, 'pkg'))
  symlinkSync(join(from, 'pkg'), join(from, 'link'), 'dir')
  const fs = {
    symlinkSync: () => {
      const error = new Error('EIO: i/o error, symlink')
      error.code = 'EIO'
      throw error
    },
  }
  assert.throws(
    () => copyTree(from, to, { fs, platform: 'win32' }),
    (error) => error.code === 'EIO',
  )
})

test('a committed absolute in-tree link is re-pointed without appearing in the patch', async () => {
  const repo = makeRepo()
  mkdirSync(join(repo, 'pkg'))
  writeFileSync(join(repo, 'pkg', 'index.js'), 'dep\n')
  symlinkSync(join(repo, 'pkg'), join(repo, 'link'), 'dir')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'link'], { cwd: repo })

  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot)
  assert.equal(readlinkSync(join(slot.dir, 'link')), join(slot.dir, 'pkg'), 'the copy’s link names the copy')
  // Nor does it read as the caller's uncommitted work: only the copy moved it.
  assert.deepEqual(slot.uncommitted, { count: 0, files: [] })

  // The base is recorded after the copy was made, so the re-pointed link is part of the
  // copy's starting state and must not read as the worker's work.
  const change = isolation.collect(slot)
  assert.equal(change.available, true)
  assert.deepEqual(change.filesChanged, [])
  assert.equal(readlinkSync(join(repo, 'link')), join(repo, 'pkg'), 'the caller’s link is untouched')
  isolation.close()
})

test('a caller’s own retarget of a committed absolute link is reported as uncommitted', async () => {
  const repo = makeRepo()
  mkdirSync(join(repo, 'pkg'))
  writeFileSync(join(repo, 'pkg', 'index.js'), 'dep\n')
  mkdirSync(join(repo, 'other'))
  writeFileSync(join(repo, 'other', 'index.js'), 'other\n')
  symlinkSync(join(repo, 'pkg'), join(repo, 'link'), 'dir')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'link'], { cwd: repo })
  // The caller retargets the committed link itself before the call. That is real
  // uncommitted work, not the copy-only re-pointing, and must not be hidden from the report.
  rmSync(join(repo, 'link'))
  symlinkSync(join(repo, 'other'), join(repo, 'link'), 'dir')

  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  const prepared = isolation.prepare(slot)
  assert.equal(prepared.uncommitted.count, 1)
  assert.deepEqual(prepared.uncommitted.files, ['link'])
  isolation.close()
})

test('prepare names the copy that failed and says a retry helps', async () => {
  const repo = makeRepo()
  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  const fs = {
    copyFileSync: (source, target, ...rest) => {
      if (source.endsWith('keep.txt')) {
        const error = new Error('EACCES: permission denied')
        error.code = 'EACCES'
        throw error
      }
      return copyFileSync(source, target, ...rest)
    },
  }
  assert.throws(
    () => isolation.prepare(slot, { fs }),
    (error) => /the copy of .* failed: .*EACCES/.test(error.message) && /retry usually works/.test(error.message),
  )
  isolation.close()
})

test('prepare tolerates an entry that vanishes while it copies, and logs it', async () => {
  const repo = makeRepo()
  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  const logs = []
  isolation.log = (line) => logs.push(line)
  const fs = {
    copyFileSync: (source, target, ...rest) => {
      if (source.endsWith('keep.txt')) throw enoent(source)
      return copyFileSync(source, target, ...rest)
    },
  }
  const prepared = isolation.prepare(slot, { fs })
  assert.notEqual(prepared.base, null)
  assert.ok(
    logs.some((line) => /vanished/.test(line)),
    `expected a vanished note, got ${JSON.stringify(logs)}`,
  )
  isolation.close()
})

// ── copyExclude: paths that stay out of the copy ─────────────────────────────

/** A repository with ignored build output, a force-tracked ignored directory, and nested names. */
function makeExcludeRepo() {
  const repo = makeRepo()
  // `vendor/` is ignored but force-tracked, so it must never be left out; `target/` is
  // build output at the root, under `a/` and under `b/`; `node_modules/` sits at depth.
  writeFileSync(join(repo, '.gitignore'), 'target/\nvendor/\nnode_modules/\n')
  mkdirSync(join(repo, 'vendor'), { recursive: true })
  writeFileSync(join(repo, 'vendor', 'tracked.txt'), 'keep me\n')
  execFileSync('git', ['add', '-f', 'vendor/tracked.txt', '.gitignore'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'ignore'], { cwd: repo })
  for (const dir of [['target', 'debug'], ['a', 'target'], ['b', 'target']]) {
    mkdirSync(join(repo, ...dir), { recursive: true })
    writeFileSync(join(repo, ...dir, 'out.txt'), 'build output\n')
  }
  mkdirSync(join(repo, 'deep', 'nested', 'node_modules'), { recursive: true })
  writeFileSync(join(repo, 'deep', 'nested', 'node_modules', 'pkg.js'), 'dep\n')
  return repo
}

test('an ignored name is left out at any depth, and reported', async () => {
  const repo = makeExcludeRepo()
  const { isolation } = makePool(repo, { copyExclude: ['target'] })
  const slot = await isolation.lease()
  const logs = []
  isolation.log = (line) => logs.push(line)
  const prepared = isolation.prepare(slot)

  assert.equal(existsSync(join(slot.dir, 'target')), false)
  assert.equal(existsSync(join(slot.dir, 'a', 'target')), false)
  assert.equal(existsSync(join(slot.dir, 'b', 'target')), false)
  assert.ok(prepared.excluded.includes('target'))
  assert.ok(prepared.excluded.includes(join('a', 'target')))
  assert.ok(logs.some((line) => /excluded path\(s\) out of the copy/.test(line)), 'the omissions are stated')
  isolation.close()
})

test('a matching entry that git tracks is copied anyway, and named', async () => {
  const repo = makeExcludeRepo()
  const { isolation } = makePool(repo, { copyExclude: ['vendor'] })
  const slot = await isolation.lease()
  const logs = []
  isolation.log = (line) => logs.push(line)
  const prepared = isolation.prepare(slot)

  assert.equal(existsSync(join(slot.dir, 'vendor', 'tracked.txt')), true, 'tracked source is never dropped')
  assert.equal(prepared.excluded.includes('vendor'), false)
  // git will not call a directory holding tracked files ignored, so the reason here is
  // usually "it is not ignored"; either check firing means "copy it and say why".
  assert.ok(
    logs.some((line) => /not leaving out vendor: (git tracks files there|it is not ignored)/.test(line)),
    `expected a reason for keeping vendor, got ${JSON.stringify(logs)}`,
  )
  isolation.close()
})

test('a directory-only ignore rule does not drop an untracked file of that name', async () => {
  const repo = makeRepo()
  writeFileSync(join(repo, '.gitignore'), 'cache/\ndir/\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'ignore'], { cwd: repo })
  // `cache/` is a directory-only rule; a plain file named `cache` is not ignored by it,
  // although `git check-ignore cache/` answers "ignored" for the file too.
  writeFileSync(join(repo, 'cache'), 'not ignored\n')

  const logs = []
  const { isolation } = makePool(repo, { copyExclude: ['cache'], log: (line) => logs.push(line) })
  const slot = await isolation.lease()
  const prepared = isolation.prepare(slot)
  assert.equal(readFileSync(join(slot.dir, 'cache'), 'utf8'), 'not ignored\n', 'the untracked file is copied')
  assert.equal(prepared.excluded.includes('cache'), false)
  assert.ok(
    logs.some((line) => /not leaving out cache: it is not ignored/.test(line)),
    `expected the file to be named as kept, got ${JSON.stringify(logs)}`,
  )
  isolation.close()

  // A path that does not exist yet may still become the directory a `dir/` rule names, so
  // the slash variant has to keep accepting a not-yet-created keep path.
  writeFileSync(
    join(repo, '.flash-agents.json'),
    JSON.stringify({ slotSetup: [{ run: [process.execPath, '-e', '0'], keep: ['dir'] }] }),
  )
  const kept = makePool(repo, { allowSlotSetup: true })
  assert.deepEqual(kept.isolation.slotSetup[0].keep, ['dir'])
  kept.isolation.close()
})

test('a bare name matches at any depth, a path entry matches only that path', async () => {
  const repo = makeExcludeRepo()
  const named = makePool(repo, { copyExclude: ['node_modules'] })
  const slot = await named.isolation.lease()
  named.isolation.prepare(slot)
  assert.equal(existsSync(join(slot.dir, 'deep', 'nested', 'node_modules')), false)
  named.isolation.close()

  // `./a/target` loses its leading marker and names one path; `b/target` is untouched.
  const pathed = makePool(repo, { copyExclude: ['./a/target'] })
  const other = await pathed.isolation.lease()
  const prepared = pathed.isolation.prepare(other)
  assert.equal(existsSync(join(other.dir, 'a', 'target')), false)
  assert.equal(existsSync(join(other.dir, 'b', 'target')), true, 'a path entry must not match a sibling')
  assert.deepEqual(prepared.excluded, [join('a', 'target')])
  pathed.isolation.close()
})

test('an exclusion is judged in the nested repository that owns the path', async () => {
  const repo = makeRepo()
  writeFileSync(join(repo, '.gitignore'), 'vendor/\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'ignore'], { cwd: repo })
  // A nested repository of its own that tracks a `vendor/` directory the outer ignore rule
  // happens to match. The top repository neither ignores it as its own nor tracks it.
  const sub = join(repo, 'sub')
  mkdirSync(join(sub, 'vendor'), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: sub })
  writeFileSync(join(sub, 'vendor', 'x.txt'), 'nested tracked\n')
  execFileSync('git', ['add', '-A'], { cwd: sub })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'nested'], { cwd: sub })
  // An outer ignored, untracked `vendor/` that is still safe to leave out.
  mkdirSync(join(repo, 'vendor'), { recursive: true })
  writeFileSync(join(repo, 'vendor', 'out.js'), 'build output\n')

  const { isolation } = makePool(repo, { copyExclude: ['vendor'] })
  const slot = await isolation.lease()
  const prepared = isolation.prepare(slot)
  assert.equal(
    existsSync(join(slot.dir, 'sub', 'vendor', 'x.txt')),
    true,
    'the nested repository’s tracked file must not be lost to an outer ignore rule',
  )
  assert.equal(prepared.excluded.includes(join('sub', 'vendor')), false)
  assert.equal(existsSync(join(slot.dir, 'vendor')), false, 'the outer ignored, untracked directory is still left out')
  assert.ok(prepared.excluded.includes('vendor'))
  isolation.close()
})

test('the settings file and the pool option both contribute exclusions', async () => {
  const repo = makeExcludeRepo()
  writeFileSync(join(repo, '.flash-agents.json'), JSON.stringify({ copyExclude: ['node_modules'] }))
  const { isolation } = makePool(repo, { copyExclude: ['target'] })
  const slot = await isolation.lease()
  const prepared = isolation.prepare(slot)
  assert.equal(existsSync(join(slot.dir, 'deep', 'nested', 'node_modules')), false, 'the file entry applies')
  assert.equal(existsSync(join(slot.dir, 'target')), false, 'the option entry applies too')
  assert.deepEqual([...prepared.excluded].sort(), ['target', join('a', 'target'), join('b', 'target'), join('deep', 'nested', 'node_modules')].sort())
  isolation.close()
})

test('ignored secrets are left out by default, and a tracked example is still copied', async () => {
  const repo = makeRepo()
  writeFileSync(join(repo, '.gitignore'), '.env\n.env.local\n.mcp.json\n')
  writeFileSync(join(repo, '.env.example'), 'TOKEN=\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'ignore'], { cwd: repo })
  writeFileSync(join(repo, '.env'), 'TOKEN=secret\n')
  writeFileSync(join(repo, '.env.local'), 'TOKEN=secret\n')
  writeFileSync(join(repo, '.mcp.json'), '{"token":"secret"}\n')
  const logs = []
  const { isolation } = makePool(repo, { log: (line) => logs.push(line) })
  const slot = await isolation.lease()
  const prepared = isolation.prepare(slot)
  for (const name of ['.env', '.env.local', '.mcp.json']) assert.equal(existsSync(join(slot.dir, name)), false, `${name} is left out`)
  assert.equal(readFileSync(join(slot.dir, '.env.example'), 'utf8'), 'TOKEN=\n', 'a tracked example is copied')
  assert.deepEqual([...prepared.excluded].sort(), ['.env', '.env.local', '.mcp.json'])
  // The tracked example is kept by the default rule, which is expected and not logged.
  assert.equal(logs.some((line) => line.includes('not leaving out')), false, logs.join('\n'))
  isolation.close()
})

test('copyExcludeDefaults: false copies the secrets again, and a trailing * matches a prefix', async () => {
  const repo = makeRepo()
  writeFileSync(join(repo, '.gitignore'), '.env\nbuild-*\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'ignore'], { cwd: repo })
  writeFileSync(join(repo, '.env'), 'TOKEN=dev\n')
  mkdirSync(join(repo, 'build-debug'))
  writeFileSync(join(repo, 'build-debug', 'out.o'), 'x')
  writeFileSync(join(repo, '.flash-agents.json'), JSON.stringify({ copyExcludeDefaults: false, copyExclude: ['build-*'] }))
  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot)
  assert.equal(readFileSync(join(slot.dir, '.env'), 'utf8'), 'TOKEN=dev\n')
  assert.equal(existsSync(join(slot.dir, 'build-debug')), false)
  isolation.close()
})

test('a malformed or unknown settings file logs and is ignored', async () => {
  const repo = makeExcludeRepo()
  writeFileSync(join(repo, '.flash-agents.json'), '{ not json')
  const logs = []
  const broken = makePool(repo, { log: (line) => logs.push(line) })
  assert.ok(logs.some((line) => /not valid JSON/.test(line)), `expected a JSON note, got ${JSON.stringify(logs)}`)
  // The service still starts and prepares with only the default exclusions.
  const slot = await broken.isolation.lease()
  assert.deepEqual(broken.isolation.copyExclude, [...DEFAULT_COPY_EXCLUDE])
  assert.notEqual(broken.isolation.prepare(slot).base, null)
  broken.isolation.close()

  writeFileSync(join(repo, '.flash-agents.json'), JSON.stringify({ copyExclude: 'target', nope: 1 }))
  const typed = []
  const pool = makePool(repo, { log: (line) => typed.push(line) })
  assert.ok(typed.some((line) => /copyExclude must be an array of strings/.test(line)))
  assert.ok(typed.some((line) => /nope is not a known setting/.test(line)))
  pool.isolation.close()
})

test('outside a git repository an exclusion applies as written', async () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-plain-')))
  mkdirSync(join(plain, 'vendor'), { recursive: true })
  writeFileSync(join(plain, 'vendor', 'lib.js'), 'dep\n')
  writeFileSync(join(plain, 'app.js'), 'app\n')
  const { isolation } = makePool(plain, { copyExclude: ['vendor'] })
  const slot = await isolation.lease()
  const prepared = isolation.prepare(slot)
  assert.equal(existsSync(join(slot.dir, 'vendor')), false)
  assert.equal(existsSync(join(slot.dir, 'app.js')), true)
  assert.deepEqual(prepared.excluded, ['vendor'])
  isolation.close()
})

// ── slotEnv: writable per-slot directories ───────────────────────────────────

test('home: directories are emptied between calls, cache: directories survive in the slot', async () => {
  const repo = makeRepo()
  const { isolation } = makePool(repo, {
    slotEnv: { CARGO_HOME: 'home:cargo', CARGO_TARGET_DIR: 'cache:cargo-target' },
  })
  const slot = await isolation.lease()
  isolation.prepare(slot)
  const home = join(slot.dir, '.flash-home', 'cargo')
  const cache = join(slot.dir, '.flash-cache', 'cargo-target')
  assert.equal(existsSync(home), true)
  assert.equal(existsSync(cache), true)
  assert.deepEqual(isolation.slotEnvFor(slot), { CARGO_HOME: home, CARGO_TARGET_DIR: cache })

  writeFileSync(join(home, 'marker'), 'per-call\n')
  writeFileSync(join(cache, 'marker'), 'warm\n')
  isolation.prepare(slot)
  assert.equal(existsSync(join(home, 'marker')), false, 'the per-call home starts clean')
  assert.equal(existsSync(join(cache, 'marker')), true, 'the cache stays warm across calls')
  isolation.close()
})

test('the per-slot home and cache never reach the patch', async () => {
  const repo = makeRepo()
  const { isolation } = makePool(repo, {
    slotEnv: { CARGO_HOME: 'home:cargo', CARGO_TARGET_DIR: 'cache:cargo-target' },
  })
  const slot = await isolation.lease()
  isolation.prepare(slot)
  writeFileSync(join(slot.dir, 'real.txt'), 'work\n')
  writeFileSync(join(slot.dir, '.flash-home', 'cargo', 'config.toml'), 'home\n')
  writeFileSync(join(slot.dir, '.flash-cache', 'cargo-target', 'out.bin'), 'cache\n')
  const change = isolation.collect(slot)
  assert.deepEqual(change.filesChanged.map((line) => line.split('\t').at(-1)), ['real.txt'])
  isolation.close()
})

test('TMPDIR, TMP, TEMP and HOME are refused as slotEnv names, with a reason', () => {
  const repo = makeRepo()
  const logs = []
  const { isolation } = makePool(repo, {
    slotEnv: {
      TMPDIR: 'home:tmp',
      TMP: 'home:tmp',
      TEMP: 'home:tmp',
      HOME: 'home:home',
      CARGO_HOME: 'home:cargo',
      BAD_VALUE: 'elsewhere:x',
      BAD_SEGMENT: 'home:a/b',
    },
    log: (line) => logs.push(line),
  })
  assert.deepEqual(Object.keys(isolation.slotEnv), ['CARGO_HOME'])
  for (const name of ['TMPDIR', 'TMP', 'TEMP', 'HOME']) {
    assert.ok(logs.some((line) => line.includes(`not redirecting ${name}`)), `${name} must be named`)
  }
  assert.ok(logs.some((line) => /BAD_VALUE: expected "home:<name>"/.test(line)))
  assert.ok(logs.some((line) => /BAD_SEGMENT.*one path segment/.test(line)))
  isolation.close()
})

test('forbidden slotEnv names are refused case-insensitively, as Windows treats them', () => {
  const repo = makeRepo()
  const logs = []
  const { isolation } = makePool(repo, {
    // Windows environment names are not case-sensitive, so `home` is `HOME` and `Tmp` is
    // `TMP`; redirecting either withdraws the runtime's sandbox or a toolchain's cache.
    slotEnv: { home: 'cache:x', Tmp: 'home:t', CARGO_HOME: 'home:cargo' },
    log: (line) => logs.push(line),
  })
  assert.deepEqual(Object.keys(isolation.slotEnv), ['CARGO_HOME'])
  for (const name of ['home', 'Tmp']) {
    assert.ok(logs.some((line) => line.includes(`not redirecting ${name}`)), `${name} must be named`)
  }
  isolation.close()
})

test('DSH_HOME and FLASH_ROUTE_MODEL are refused as slotEnv names', () => {
  const repo = makeRepo()
  const logs = []
  const { isolation } = makePool(repo, {
    // A cached DSH_HOME would let a worker plant a profile governing the next runtime
    // start on that slot; FLASH_ROUTE_MODEL is the server's choice alone.
    slotEnv: { DSH_HOME: 'cache:dsh', FLASH_ROUTE_MODEL: 'home:route', CARGO_HOME: 'home:cargo' },
    log: (line) => logs.push(line),
  })
  assert.deepEqual(Object.keys(isolation.slotEnv), ['CARGO_HOME'])
  for (const name of ['DSH_HOME', 'FLASH_ROUTE_MODEL']) {
    assert.ok(logs.some((line) => line.includes(`not redirecting ${name}`)), `${name} must be named`)
  }
  isolation.close()
})

test('a slotEnv option wins per variable over the settings file', () => {
  const repo = makeRepo()
  writeFileSync(join(repo, '.flash-agents.json'), JSON.stringify({ slotEnv: { CARGO_HOME: 'home:from-file', OTHER: 'home:other' } }))
  const { isolation } = makePool(repo, { slotEnv: { CARGO_HOME: 'home:from-option' } })
  assert.deepEqual(isolation.slotEnv.CARGO_HOME, { kind: 'home', segment: 'from-option' })
  assert.deepEqual(isolation.slotEnv.OTHER, { kind: 'home', segment: 'other' })
  isolation.close()
})

// ── port: slotEnv entries ────────────────────────────────────────────────────

test('port: values resolve from the slot id, with the default and a custom stride', async () => {
  const repo = makeRepo()
  const { isolation } = makePool(repo, {
    slots: 2,
    slotEnv: { E2E_PORT: 'port:41000', E2E_WIDE: 'port:42000/100' },
  })
  const first = await isolation.lease()
  const second = await isolation.lease()
  assert.deepEqual(isolation.slotEnvFor(first), { E2E_PORT: '41000', E2E_WIDE: '42000' })
  assert.deepEqual(isolation.slotEnvFor(second), { E2E_PORT: '41010', E2E_WIDE: '42100' })

  // A port is a number, not a folder: preparing the slot creates no directory for it.
  isolation.prepare(first)
  assert.equal(existsSync(join(first.dir, '.flash-home')), false)
  assert.equal(existsSync(join(first.dir, '.flash-cache')), false)

  // The value depends on the slot id alone, so retiring the directory does not move it.
  isolation.retire(first)
  assert.equal(isolation.slotEnvFor(first).E2E_PORT, '41000')
  isolation.close()
})

test('an out-of-range port base, stride or highest slot is refused with a log line', () => {
  const repo = makeRepo()
  const logs = []
  const { isolation } = makePool(repo, {
    slots: 2,
    slotEnv: {
      LOW: 'port:80',
      HIGH: 'port:70000',
      ZERO_STRIDE: 'port:41000/0',
      WIDE_STRIDE: 'port:41000/10001',
      OVER_TOP: 'port:65535/10',
      NOT_A_PORT: 'port:41000/x',
    },
    log: (line) => logs.push(line),
  })
  assert.deepEqual(isolation.slotEnv, {})
  const text = logs.join('\n')
  assert.match(text, /LOW: the port base must be a whole number in 1024\.\.65535/)
  assert.match(text, /HIGH: the port base must be a whole number in 1024\.\.65535/)
  assert.match(text, /ZERO_STRIDE: the port stride must be a whole number in 1\.\.10000/)
  assert.match(text, /WIDE_STRIDE: the port stride must be a whole number in 1\.\.10000/)
  assert.match(text, /OVER_TOP: port:65535\/10 reaches 65545 at slot 1, past 65535/)
  assert.match(text, /NOT_A_PORT: expected "home:<name>", "cache:<name>", "port:<base>\[\/<stride>\]" or "value:<text>"/)
  isolation.close()
})

test('the prompt names port variables apart from the writable directories', () => {
  const prompt = buildChildPrompt({
    cwd: '/w',
    task: 'run the end-to-end suite',
    copy: true,
    uncommitted: { count: 0, files: [] },
    slotEnv: { E2E_PORT: '41000', CARGO_HOME: '/slot/.flash-home/cargo' },
    slotPorts: ['E2E_PORT'],
  })
  assert.match(prompt, /The environment sets CARGO_HOME to writable per-slot directories; use them for caches and tool state\./)
  assert.match(prompt, /E2E_PORT hold a port base reserved for this slot; use ports from there instead of fixed ones\./)
  assert.doesNotMatch(prompt, /The environment sets .*E2E_PORT/)
  assert.doesNotMatch(prompt, /E2E_PORT.*writable per-slot directories/)
})

// ── value: slotEnv entries ───────────────────────────────────────────────────

test('value: entries are handed over verbatim, and create no directory', async () => {
  const repo = makeRepo()
  const { isolation } = makePool(repo, {
    slotEnv: {
      OPENSSL_NO_VENDOR: 'value:1',
      OPENSSL_DIR: 'value:C:\\openssl',
      RUSTC_WRAPPER: 'value:sccache',
      EMPTY: 'value:',
      TRICKY: 'value:a:b = c:/x\\y value:z',
    },
  })
  // The spec the pool holds is the text alone, not the `value:` spelling.
  assert.deepEqual(isolation.slotEnv.OPENSSL_DIR, { kind: 'value', value: 'C:\\openssl' })
  const slot = await isolation.lease()
  isolation.prepare(slot)
  assert.deepEqual(isolation.slotEnvFor(slot), {
    OPENSSL_NO_VENDOR: '1',
    OPENSSL_DIR: 'C:\\openssl',
    RUSTC_WRAPPER: 'sccache',
    EMPTY: '',
    // Everything after the FIRST `value:` belongs to the value, `value:` included.
    TRICKY: 'a:b = c:/x\\y value:z',
  })
  // A plain value is not a folder: no per-slot home or cache was invented for it.
  assert.equal(existsSync(join(slot.dir, '.flash-home')), false)
  assert.equal(existsSync(join(slot.dir, '.flash-cache')), false)
  const exclude = readFileSync(join(slot.dir, '.git', 'info', 'exclude'), 'utf8')
  assert.doesNotMatch(exclude, /\.flash-home/)
  assert.doesNotMatch(exclude, /\.flash-cache/)
  isolation.close()
})

test('a value: entry in .flash-agents.json is accepted like a pool option', () => {
  const repo = makeRepo()
  writeFileSync(
    join(repo, '.flash-agents.json'),
    JSON.stringify({ slotEnv: { OPENSSL_DIR: 'value:C:\\Program Files\\OpenSSL' } }),
  )
  const { isolation } = makePool(repo)
  assert.deepEqual(isolation.slotEnv.OPENSSL_DIR, { kind: 'value', value: 'C:\\Program Files\\OpenSSL' })
  isolation.close()
})

test('value: entries mix with home:, cache: and port: entries', async () => {
  const repo = makeRepo()
  const { isolation } = makePool(repo, {
    slots: 2,
    slotEnv: {
      CARGO_HOME: 'home:cargo',
      CARGO_TARGET_DIR: 'cache:cargo-target',
      E2E_PORT: 'port:41000',
      RUSTC_WRAPPER: 'value:sccache',
    },
  })
  const first = await isolation.lease()
  isolation.prepare(first)
  assert.deepEqual(isolation.slotEnvFor(first), {
    CARGO_HOME: join(first.dir, '.flash-home', 'cargo'),
    CARGO_TARGET_DIR: join(first.dir, '.flash-cache', 'cargo-target'),
    E2E_PORT: '41000',
    RUSTC_WRAPPER: 'sccache',
  })
  // Only the directory entries created a directory.
  assert.equal(existsSync(join(first.dir, '.flash-home', 'cargo')), true)
  assert.equal(existsSync(join(first.dir, '.flash-cache', 'cargo-target')), true)
  assert.equal(existsSync(join(first.dir, '.flash-home', 'sccache')), false)
  assert.equal(existsSync(join(first.dir, '.flash-cache', 'sccache')), false)
  isolation.close()
})

test('a value: entry with a NUL or over the Windows limit is refused with a log line', () => {
  const repo = makeRepo()
  const logs = []
  const longest = 'x'.repeat(32767)
  const { isolation } = makePool(repo, {
    slotEnv: {
      NUL: 'value:before\0after',
      TOO_LONG: `value:${'y'.repeat(32768)}`,
      AT_LIMIT: `value:${longest}`,
      KEPT: 'value:1',
    },
    log: (line) => logs.push(line),
  })
  assert.deepEqual(Object.keys(isolation.slotEnv), ['AT_LIMIT', 'KEPT'])
  assert.deepEqual(isolation.slotEnv.AT_LIMIT, { kind: 'value', value: longest })
  const text = logs.join('\n')
  assert.match(text, /NUL: .*may not contain a NUL character/)
  assert.match(text, /TOO_LONG: a value: entry is 32768 characters, over the 32767-character limit/)
  assert.doesNotMatch(text, /AT_LIMIT/)
  isolation.close()
})

test('PATH, NODE_OPTIONS and loader names are refused for every kind of entry', () => {
  const repo = makeRepo()
  const logs = []
  const { isolation } = makePool(repo, {
    // A plain value reaches the dsh runtime process, which runs outside the worker's
    // sandbox: a name that decides which program runs, or how code is loaded, would let a
    // project's configuration run code in the runtime itself.
    slotEnv: {
      PATH: 'value:/tmp/bin',
      Path: 'home:bin',
      PATHEXT: 'cache:pathext',
      NODE_OPTIONS: 'value:--require /tmp/x.js',
      NODE_PATH: 'cache:node',
      LD_PRELOAD: 'value:/tmp/x.so',
      LD_LIBRARY_PATH: 'home:lib',
      DYLD_INSERT_LIBRARIES: 'value:/tmp/x.dylib',
      dyld_library_path: 'cache:dyld',
      CARGO_HOME: 'home:cargo',
    },
    log: (line) => logs.push(line),
  })
  assert.deepEqual(Object.keys(isolation.slotEnv), ['CARGO_HOME'])
  const refused = ['PATH', 'Path', 'PATHEXT', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'dyld_library_path']
  for (const name of refused) {
    assert.ok(
      logs.some((line) => line.includes(`not redirecting ${name}`) && line.includes('it changes how the runtime loads programs')),
      `${name} must be refused with the loader reason`,
    )
  }
  isolation.close()
})

// ── platform sections and the per-machine settings file ─────────────────────

test('a platform section applies only on the platform the pool runs on', async () => {
  const repo = makeRepo()
  writeFileSync(
    join(repo, '.flash-agents.json'),
    JSON.stringify({ platform: { win32: { slotEnv: { OPENSSL_DIR: 'value:C:\\openssl' } } } }),
  )
  const win = makePool(repo, { platform: 'win32' })
  const slot = await win.isolation.lease()
  win.isolation.prepare(slot)
  assert.equal(win.isolation.slotEnvFor(slot).OPENSSL_DIR, 'C:\\openssl')
  win.isolation.release(slot)
  win.isolation.close()

  const linux = makePool(repo, { platform: 'linux' })
  assert.equal(linux.isolation.slotEnv.OPENSSL_DIR, undefined, 'the win32 section does not apply on linux')
  linux.isolation.close()
})

test('the local file and its platform section layer over the shared file, and an option wins', () => {
  const repo = makeRepo()
  const shared = join(repo, '.flash-agents.json')
  const local = join(repo, '.flash-agents.local.json')
  const entry = (options = {}) => {
    const { isolation } = makePool(repo, { platform: 'win32', ...options })
    const value = isolation.slotEnv.CARGO_HOME
    isolation.close()
    return value
  }

  writeFileSync(shared, JSON.stringify({ slotEnv: { CARGO_HOME: 'home:shared' } }))
  assert.deepEqual(entry(), { kind: 'home', segment: 'shared' })

  writeFileSync(
    shared,
    JSON.stringify({
      slotEnv: { CARGO_HOME: 'home:shared' },
      platform: { win32: { slotEnv: { CARGO_HOME: 'home:shared-win' } } },
    }),
  )
  assert.deepEqual(entry(), { kind: 'home', segment: 'shared-win' })

  writeFileSync(local, JSON.stringify({ slotEnv: { CARGO_HOME: 'home:local' } }))
  assert.deepEqual(entry(), { kind: 'home', segment: 'local' })

  writeFileSync(
    local,
    JSON.stringify({
      slotEnv: { CARGO_HOME: 'home:local' },
      platform: { win32: { slotEnv: { CARGO_HOME: 'home:local-win' } } },
    }),
  )
  assert.deepEqual(entry(), { kind: 'home', segment: 'local-win' })
  assert.deepEqual(entry({ slotEnv: { CARGO_HOME: 'home:option' } }), { kind: 'home', segment: 'option' })
})

test('null in a later slotEnv layer removes an earlier entry, and a no-op in the first', () => {
  const repo = makeRepo()
  // The first layer has no earlier entry to remove, so a null there changes nothing.
  writeFileSync(join(repo, '.flash-agents.json'), JSON.stringify({ slotEnv: { OPENSSL_DIR: null, KEEP: 'value:1' } }))
  const first = makePool(repo, { platform: 'win32' })
  assert.deepEqual(Object.keys(first.isolation.slotEnv), ['KEEP'])
  first.isolation.close()

  writeFileSync(
    join(repo, '.flash-agents.json'),
    JSON.stringify({ slotEnv: { OPENSSL_DIR: 'value:C:\\shared', KEEP: 'value:1' } }),
  )
  writeFileSync(
    join(repo, '.flash-agents.local.json'),
    JSON.stringify({ slotEnv: { OPENSSL_DIR: null } }),
  )
  const removed = makePool(repo, { platform: 'linux' })
  assert.deepEqual(Object.keys(removed.isolation.slotEnv), ['KEEP'])
  removed.isolation.close()
})

test('win32 folds slotEnv name case, while linux keeps both spellings', () => {
  const repo = makeRepo()
  writeFileSync(join(repo, '.flash-agents.json'), JSON.stringify({ slotEnv: { OPENSSL_DIR: 'value:C:\\shared' } }))
  // `PATH`/`Path` are refused as loader variables, so the rule is shown with a variable a
  // slot may really set; the spelling pair is what matters, not the name.
  writeFileSync(join(repo, '.flash-agents.local.json'), JSON.stringify({ slotEnv: { openssl_dir: 'value:C:\\local' } }))

  const win = makePool(repo, { platform: 'win32' })
  assert.deepEqual(Object.keys(win.isolation.slotEnv), ['openssl_dir'])
  assert.deepEqual(win.isolation.slotEnv.openssl_dir, { kind: 'value', value: 'C:\\local' })
  win.isolation.close()

  const linux = makePool(repo, { platform: 'linux' })
  assert.deepEqual(Object.keys(linux.isolation.slotEnv), ['OPENSSL_DIR', 'openssl_dir'])
  linux.isolation.close()
})

test('copyExclude from the shared and local files and both platform sections is applied', async () => {
  const repo = makeRepo()
  const names = ['shared-build', 'shared-win-build', 'local-build', 'local-win-build']
  writeFileSync(join(repo, '.gitignore'), `${names.map((name) => `${name}/`).join('\n')}\n`)
  execFileSync('git', ['add', '.gitignore'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'ignored builds'], { cwd: repo })
  for (const name of names) {
    mkdirSync(join(repo, name))
    writeFileSync(join(repo, name, 'out.txt'), 'build output\n')
  }
  writeFileSync(
    join(repo, '.flash-agents.json'),
    JSON.stringify({
      copyExclude: ['shared-build'],
      platform: { win32: { copyExclude: ['shared-win-build'] } },
    }),
  )
  writeFileSync(
    join(repo, '.flash-agents.local.json'),
    JSON.stringify({
      copyExclude: ['local-build'],
      platform: { win32: { copyExclude: ['local-win-build'] } },
    }),
  )

  const { isolation } = makePool(repo, { platform: 'win32' })
  const slot = await isolation.lease()
  isolation.prepare(slot)
  for (const name of names) assert.equal(existsSync(join(slot.dir, name)), false, `${name} is left out`)
  assert.equal(readFileSync(join(slot.dir, 'README.md'), 'utf8'), '# project\n', 'the rest is copied')
  isolation.release(slot)
  isolation.close()
})

test('copyExcludeDefaults is last layer wins, so the local false copies the secrets again', async () => {
  const repo = makeRepo()
  writeFileSync(join(repo, '.gitignore'), '.env\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'ignore env'], { cwd: repo })
  writeFileSync(join(repo, '.env'), 'TOKEN=dev\n')
  writeFileSync(join(repo, '.flash-agents.json'), JSON.stringify({ copyExcludeDefaults: true }))
  writeFileSync(join(repo, '.flash-agents.local.json'), JSON.stringify({ copyExcludeDefaults: false }))

  const { isolation } = makePool(repo, { platform: 'win32' })
  const slot = await isolation.lease()
  isolation.prepare(slot)
  assert.equal(readFileSync(join(slot.dir, '.env'), 'utf8'), 'TOKEN=dev\n')
  isolation.release(slot)
  isolation.close()
})

test('bad platform sections are named with file and section, and the rest of the file applies', () => {
  const repo = makeRepo()
  const shared = join(repo, '.flash-agents.json')
  writeFileSync(
    shared,
    JSON.stringify({
      copyExclude: ['shared-build'],
      platform: {
        win32: {
          slotEnv: { WIN_ONLY: 'value:1' },
          platform: { win32: { slotEnv: { NESTED: 'value:1' } } },
        },
        plan9: { slotEnv: { PLAN9: 'value:1' } },
        linux: [],
      },
    }),
  )
  const logs = []
  const { isolation } = makePool(repo, { platform: 'win32', log: (line) => logs.push(line) })
  assert.deepEqual(isolation.slotEnv, { WIN_ONLY: { kind: 'value', value: '1' } })
  assert.ok(isolation.copyExclude.includes('shared-build'), 'the top-level setting still applies')
  assert.ok(logs.includes('.flash-agents.json: platform.plan9 is not a known platform; ignoring it'), logs.join('\n'))
  assert.ok(
    logs.includes('.flash-agents.json platform.linux: the platform section must be an object; ignoring it'),
    logs.join('\n'),
  )
  assert.ok(
    logs.includes('.flash-agents.json platform.win32: platform is not a known setting; ignoring it'),
    logs.join('\n'),
  )
  isolation.close()

  // `platform: []` is the whole section of the wrong shape, not one platform's section.
  writeFileSync(shared, JSON.stringify({ platform: [], copyExclude: ['top-build'] }))
  const typed = []
  const second = makePool(repo, { platform: 'win32', log: (line) => typed.push(line) })
  assert.ok(
    typed.includes('.flash-agents.json: platform must be an object keyed by process.platform name; ignoring it'),
    typed.join('\n'),
  )
  assert.ok(second.isolation.copyExclude.includes('top-build'), 'the rest of the file still applies')
  second.isolation.close()
})

// ── slotSetup: commands run in the copy before the worker ────────────────────

/**
 * The setup program used by the tests: it records one run in a counter outside the
 * repository (through an environment variable) and builds the kept `node_modules`
 * directory inside the copy. `process.execPath -e <script>` needs no uv or bun.
 */
const SETUP_SCRIPT = `
const fs = require('node:fs')
if (process.env.FLASH_SETUP_COUNTER) fs.appendFileSync(process.env.FLASH_SETUP_COUNTER, 'run\\n')
fs.mkdirSync('node_modules', { recursive: true })
fs.writeFileSync('node_modules/marker.txt', 'built\\n')
// Setup output that git does not ignore must also be part of the starting state.
fs.writeFileSync('generated.txt', 'from setup\\n')
`

/** A repository with an ignored kept directory, a lock input, and one setup step. */
function makeSetupRepo({ script = SETUP_SCRIPT, run, keep = ['node_modules'], inputs = ['bun.lock'], timeoutSeconds = 10 } = {}) {
  const repo = makeRepo()
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.venv/\nvendor/\n')
  writeFileSync(join(repo, 'bun.lock'), 'lock-v1\n')
  writeFileSync(
    join(repo, '.flash-agents.json'),
    JSON.stringify({ slotSetup: [{ run: run ?? [process.execPath, '-e', script], inputs, keep, timeoutSeconds }] }),
  )
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'setup'], { cwd: repo })
  return repo
}

/** How many times the setup program appended to its counter. */
function setupRuns(counter) {
  try {
    return readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

/** Run one test with a fresh counter path in the environment the setup step inherits. */
async function withSetupCounter(fn) {
  const counter = join(realpathSync(mkdtempSync(join(tmpdir(), 'flash-setup-counter-'))), 'runs.log')
  const previous = process.env.FLASH_SETUP_COUNTER
  process.env.FLASH_SETUP_COUNTER = counter
  try {
    return await fn(counter)
  } finally {
    if (previous === undefined) delete process.env.FLASH_SETUP_COUNTER
    else process.env.FLASH_SETUP_COUNTER = previous
  }
}

/** Lease, prepare and run the setup of one slot through one call's lifecycle. */
async function prepareAndSetup(isolation) {
  const slot = await isolation.lease()
  isolation.prepare(slot)
  const setup = await isolation.runSetup(slot)
  return { slot, setup }
}

test('the first call runs the setup step, and the next call in the slot skips it while inputs are unchanged', async () => {
  await withSetupCounter(async (counter) => {
    const repo = makeSetupRepo()
    const { isolation } = makePool(repo, { allowSlotSetup: true })
    const { slot, setup } = await prepareAndSetup(isolation)
    assert.equal(setup.length, 1)
    assert.equal(setup[0].ran, true)
    assert.equal(setup[0].reason, 'first run in this slot')
    assert.equal(setup[0].run[0], process.execPath)
    assert.equal(typeof setup[0].ms, 'number')
    assert.equal(setupRuns(counter), 1)
    assert.equal(readFileSync(join(slot.dir, 'node_modules', 'marker.txt'), 'utf8'), 'built\n')

    // Nothing the setup wrote is the worker's change or an ignored path of its own.
    const change = isolation.collect(slot)
    assert.deepEqual(change.filesChanged, [])
    assert.deepEqual(change.ignored, [])

    // The worker's run leaves the copy; the kept directory goes back to the slot cache.
    isolation.discard(slot)
    assert.equal(existsSync(join(slot.dir, 'node_modules')), false)
    assert.equal(existsSync(join(slot.dir, '.flash-cache', 'keep', '0', 'node_modules', 'marker.txt')), true)
    isolation.release(slot)

    const again = await isolation.lease()
    isolation.prepare(again)
    const second = await isolation.runSetup(again)
    assert.equal(second[0].ran, false)
    assert.equal(second[0].reason, 'stamp matched')
    assert.equal(setupRuns(counter), 1, 'an unchanged input does not rebuild')
    assert.equal(readFileSync(join(again.dir, 'node_modules', 'marker.txt'), 'utf8'), 'built\n', 'the kept directory was restored')
    isolation.release(again)
    isolation.close()
  })
})

test('changing a declared input in the caller’s tree re-runs the step', async () => {
  await withSetupCounter(async (counter) => {
    const repo = makeSetupRepo()
    const { isolation } = makePool(repo, { allowSlotSetup: true })
    const first = await prepareAndSetup(isolation)
    assert.equal(first.setup[0].ran, true)
    isolation.discard(first.slot)
    isolation.release(first.slot)

    // The copy is made from the caller's tree, so an edit there is what the stamp sees.
    writeFileSync(join(repo, 'bun.lock'), 'lock-v2\n')
    const second = await prepareAndSetup(isolation)
    assert.equal(second.setup[0].ran, true)
    assert.equal(second.setup[0].reason, 'inputs changed')
    assert.equal(setupRuns(counter), 2)
    isolation.release(second.slot)
    isolation.close()
  })
})

test('removing the kept directory from the slot cache re-runs the step', async () => {
  await withSetupCounter(async (counter) => {
    const repo = makeSetupRepo()
    const { isolation } = makePool(repo, { allowSlotSetup: true })
    const first = await prepareAndSetup(isolation)
    isolation.discard(first.slot)
    assert.equal(setupRuns(counter), 1)
    rmSync(join(first.slot.dir, '.flash-cache', 'keep', '0', 'node_modules'), { recursive: true, force: true })
    isolation.release(first.slot)

    const second = await prepareAndSetup(isolation)
    assert.equal(second.setup[0].ran, true)
    assert.equal(second.setup[0].reason, 'kept path missing')
    assert.equal(setupRuns(counter), 2)
    isolation.release(second.slot)
    isolation.close()
  })
})

test('a kept path behind a symlink in the copy is not moved out of the copy', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'flash-keep-link-')))
  const repo = join(base, 'repo')
  const outside = join(base, 'outside')
  mkdirSync(join(outside, 'sub'), { recursive: true })
  mkdirSync(repo)
  writeFileSync(join(outside, 'sub', 'marker.txt'), 'outside\n')
  writeFileSync(
    join(repo, '.flash-agents.json'),
    JSON.stringify({ slotSetup: [{ run: [process.execPath, '-e', '0'], keep: ['node_modules/sub'] }] }),
  )
  // Not a git work tree: `#excludeDecision` answers "omit" without git, so the keep path is
  // accepted as written. `node_modules` is a symlink to a directory outside the copy, and
  // the host's `rename` would move files out of the caller's tree (a restore is an `rm`).
  symlinkSync(outside, join(repo, 'node_modules'), 'dir')

  const { isolation } = makePool(repo, { allowSlotSetup: true })
  const slot = await isolation.lease()
  isolation.prepare(slot)
  isolation.discard(slot)
  isolation.prepare(slot)
  assert.equal(readFileSync(join(outside, 'sub', 'marker.txt'), 'utf8'), 'outside\n', 'the outside file survives prepare and discard')
  assert.equal(
    existsSync(join(slot.dir, '.flash-cache', 'keep', '0', 'node_modules', 'sub', 'marker.txt')),
    false,
    'the slot cache does not hold a file from outside the copy',
  )
  isolation.close()
})

test('a step that keeps nothing runs on every call with the reason stated', async () => {
  await withSetupCounter(async (counter) => {
    const repo = makeSetupRepo({ keep: [] })
    const { isolation } = makePool(repo, { allowSlotSetup: true })
    const first = await prepareAndSetup(isolation)
    assert.equal(first.setup[0].ran, true)
    isolation.discard(first.slot)
    isolation.release(first.slot)

    // The copy was emptied and nothing was kept, so the stamp cannot stand for output that
    // is no longer there: a "stamp matched" here would skip work whose result is missing.
    const second = await prepareAndSetup(isolation)
    assert.equal(second.setup[0].ran, true)
    assert.equal(second.setup[0].reason, 'nothing is kept between calls')
    assert.equal(setupRuns(counter), 2)
    assert.equal(readFileSync(join(second.slot.dir, 'node_modules', 'marker.txt'), 'utf8'), 'built\n')
    isolation.release(second.slot)
    isolation.close()
  })
})

/** A setup program that records the directory it ran in, so a scope mix-up is visible. */
const CWD_SETUP_SCRIPT = `
const fs = require('node:fs')
fs.mkdirSync('node_modules', { recursive: true })
fs.writeFileSync('node_modules/marker.txt', process.cwd() + '\\n')
`

test('kept paths and stamps are per scope, so a nested repository gets its own setup', async () => {
  const repo = makeSetupRepo({ script: CWD_SETUP_SCRIPT, inputs: [] })
  // A nested repository of its own below the root, which is where a scoped call copies.
  const app = join(repo, 'app')
  mkdirSync(app)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: app })
  writeFileSync(join(app, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(app, 'main.js'), 'app\n')
  execFileSync('git', ['add', '-A'], { cwd: app })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'app'], { cwd: app })

  const { isolation } = makePool(repo, { allowSlotSetup: true })
  const slot = await isolation.lease()

  isolation.prepare(slot)
  const outer = await isolation.runSetup(slot)
  assert.equal(outer[0].ran, true)
  assert.equal(outer[0].reason, 'first run in this slot')
  const outerMarker = readFileSync(join(slot.dir, 'node_modules', 'marker.txt'), 'utf8')
  assert.equal(outerMarker, `${slot.dir}\n`)

  // A call scoped to the nested repository must not inherit the root's kept node_modules or
  // its stamp: that directory was built for a different tree.
  assert.equal(isolation.prepare(slot, { cwd: app }).scope, 'app')
  const inner = await isolation.runSetup(slot)
  assert.equal(inner[0].ran, true)
  assert.equal(inner[0].reason, 'first run in this slot')
  const innerMarker = readFileSync(join(slot.dir, 'app', 'node_modules', 'marker.txt'), 'utf8')
  assert.equal(innerMarker, `${join(slot.dir, 'app')}\n`, 'the nested setup ran in the nested copy')
  assert.notEqual(innerMarker, outerMarker)

  // Back at the root, the root's own kept directory and stamp are waiting again.
  assert.equal(isolation.prepare(slot).scope, '')
  const back = await isolation.runSetup(slot)
  assert.equal(back[0].ran, false)
  assert.equal(back[0].reason, 'stamp matched')
  assert.equal(readFileSync(join(slot.dir, 'node_modules', 'marker.txt'), 'utf8'), outerMarker, 'the root kept directory came back')
  isolation.close()
})

test('a keep path that is tracked or not ignored is refused at startup, and the step runs without it', async () => {
  const repo = makeRepo()
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\nvendor/\n')
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', 'app.js'), 'app\n')
  // A force-added file inside an ignored directory: git ignores the path but tracks content.
  mkdirSync(join(repo, 'vendor'))
  writeFileSync(join(repo, 'vendor', 'tracked.txt'), 'tracked\n')
  execFileSync('git', ['add', '-A', '-f', 'vendor/tracked.txt'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'keep'], { cwd: repo })
  writeFileSync(
    join(repo, '.flash-agents.json'),
    JSON.stringify({ slotSetup: [{ run: [process.execPath, '-e', '0'], keep: ['src', 'vendor', 'absent'] }] }),
  )

  const logs = []
  const { isolation } = makePool(repo, { allowSlotSetup: true, log: (line) => logs.push(line) })
  assert.deepEqual(isolation.slotSetup[0].keep, [], 'no unignored or tracked path is ever moved')
  const text = logs.join('\n')
  assert.match(text, /not keeping src for slotSetup .*: it is not ignored; the step still runs, without it/)
  assert.match(text, /not keeping vendor for slotSetup .*: (git tracks files there|it is not ignored); the step still runs, without it/)
  assert.match(text, /not keeping absent for slotSetup .*: it is not ignored; the step still runs, without it/)

  // The step itself is still configured, and still runs.
  const { slot, setup } = await prepareAndSetup(isolation)
  assert.equal(setup[0].ran, true)
  // With every keep path refused it keeps nothing, so it runs on every call.
  assert.equal(setup[0].reason, 'nothing is kept between calls')
  isolation.release(slot)
  isolation.close()
})

test('an unusable slotSetup entry is named and dropped, and an over-long timeout is capped', () => {
  const repo = makeRepo()
  writeFileSync(
    join(repo, '.flash-agents.json'),
    JSON.stringify({
      slotSetup: [
        { run: 'npm test' },
        { run: [] },
        { run: ['x'], inputs: ['/etc/passwd'] },
        { run: ['x'], keep: ['../outside'] },
        { run: ['x'], timeoutSeconds: 0 },
        { run: [process.execPath, '-e', '0'], timeoutSeconds: 7200 },
        { run: [process.execPath, '-e', '0'] },
      ],
    }),
  )
  const logs = []
  const { isolation } = makePool(repo, { allowSlotSetup: true, log: (line) => logs.push(line) })
  assert.equal(isolation.slotSetup.length, 2)
  assert.equal(isolation.slotSetup[0].timeoutSeconds, 3600)
  assert.equal(isolation.slotSetup[1].timeoutSeconds, 900)
  const text = logs.join('\n')
  assert.match(text, /slotSetup\[0\]\.run must be a non-empty array of strings/)
  assert.match(text, /slotSetup\[1\]\.run must be a non-empty array of strings/)
  assert.match(text, /slotSetup\[2\]\.inputs names "\/etc\/passwd", which is not a relative path/)
  assert.match(text, /slotSetup\[3\]\.keep names "\.\.\/outside", which is not a relative path/)
  assert.match(text, /slotSetup\[4\]\.timeoutSeconds must be a positive number/)
  assert.match(text, /slotSetup\[5\]\.timeoutSeconds 7200 is above the 3600 s maximum; using 3600/)
  isolation.close()
})

test('slotSetup configured without the opt-in does not run, logs how to allow it, and carries the warning', async () => {
  await withSetupCounter(async (counter) => {
    const repo = makeSetupRepo()
    const logs = []
    const { isolation } = makePool(repo, { log: (line) => logs.push(line) })
    assert.match(logs.join('\n'), /--allow-slot-setup/)
    assert.equal(isolation.slotSetupWarning, SETUP_NOT_ALLOWED_WARNING)

    const slot = await isolation.lease()
    isolation.prepare(slot)
    assert.equal(await isolation.runSetup(slot), undefined)
    assert.equal(setupRuns(counter), 0)
    assert.equal(existsSync(join(slot.dir, 'node_modules')), false)
    isolation.release(slot)
    isolation.close()
  })
})

test('local slotSetup steps layer after the shared ones and stay behind the same opt-in', async () => {
  await withSetupCounter(async (counter) => {
    const repo = makeRepo()
    const append = (label) =>
      `require('node:fs').appendFileSync(process.env.FLASH_SETUP_COUNTER, '${label}\\n')`
    const sharedScript = append('shared')
    const localScript = append('local')
    writeFileSync(
      join(repo, '.flash-agents.json'),
      JSON.stringify({ slotSetup: [{ run: [process.execPath, '-e', sharedScript], inputs: [] }] }),
    )
    writeFileSync(
      join(repo, '.flash-agents.local.json'),
      JSON.stringify({ slotSetup: [{ run: [process.execPath, '-e', localScript], inputs: [] }] }),
    )

    // Without the opt-in neither file's step may run, and both are still reported.
    const denied = makePool(repo, { platform: 'win32' })
    assert.deepEqual(denied.isolation.slotSetup.map((step) => step.run[2]), [sharedScript, localScript])
    assert.equal(denied.isolation.slotSetupWarning, SETUP_NOT_ALLOWED_WARNING)
    const first = await denied.isolation.lease()
    denied.isolation.prepare(first)
    assert.equal(await denied.isolation.runSetup(first), undefined)
    assert.equal(setupRuns(counter), 0, 'the local file is host code behind the same gate')
    denied.isolation.release(first)
    denied.isolation.close()

    const allowed = makePool(repo, { platform: 'win32', allowSlotSetup: true })
    const { setup } = await prepareAndSetup(allowed.isolation)
    assert.deepEqual(setup.map((step) => step.run[2]), [sharedScript, localScript], 'shared first, local second')
    assert.deepEqual(setup.map((step) => step.ran), [true, true])
    assert.equal(setupRuns(counter), 2)
    allowed.isolation.close()
  })
})

test('a failing setup step fails with SETUP_FAILED, names the argv and exit code, and keeps the output tail', async () => {
  const repo = makeSetupRepo({ script: "console.error('setup-broke-here'); process.exit(7)" })
  const { isolation } = makePool(repo, { allowSlotSetup: true })
  const slot = await isolation.lease()
  isolation.prepare(slot)
  await assert.rejects(
    isolation.runSetup(slot),
    (error) =>
      error.code === 'SETUP_FAILED' &&
      /exit code 7/.test(error.message) &&
      /setup-broke-here/.test(error.message) &&
      error.message.includes(process.execPath),
  )
  // A failed step must not leave a stamp that would skip it next time.
  assert.equal(existsSync(join(slot.dir, '.flash-cache', 'setup', '0.stamp')), false)
  isolation.release(slot)
  isolation.close()
})

test('a setup step that runs past its timeout is killed, and the stamp is removed', async () => {
  const late = join(realpathSync(mkdtempSync(join(tmpdir(), 'flash-setup-late-'))), 'late.txt')
  const script = `
const fs = require('node:fs')
setTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, 'late\\n'), 300)
setTimeout(() => {}, 5000)
`
  const repo = makeSetupRepo({ script, timeoutSeconds: 0.1 })
  const { isolation } = makePool(repo, { allowSlotSetup: true })
  const slot = await isolation.lease()
  isolation.prepare(slot)
  const started = Date.now()
  await assert.rejects(isolation.runSetup(slot), (error) => error.code === 'SETUP_FAILED' && /timed out after 0\.1 s/.test(error.message))
  assert.ok(Date.now() - started < 3000, 'the timeout is enforced, not waited out')
  assert.equal(existsSync(join(slot.dir, '.flash-cache', 'setup', '0.stamp')), false)
  await delay(500)
  assert.equal(existsSync(late), false, 'the killed step wrote nothing afterwards')
  isolation.release(slot)
  isolation.close()
})

test('a timed-out setup step takes the processes it started with it', { skip: process.platform === 'win32' }, async () => {
  const late = join(realpathSync(mkdtempSync(join(tmpdir(), 'flash-setup-grandchild-'))), 'late.txt')
  // The step starts a child of its own, as `uv sync` and `bun install` do, and that child is
  // the one that would write after the timeout.
  const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(late)}, 'late\\n'), 400)`
  const script = `
require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' })
setTimeout(() => {}, 5000)
`
  const repo = makeSetupRepo({ script, timeoutSeconds: 0.15 })
  const { isolation } = makePool(repo, { allowSlotSetup: true })
  const slot = await isolation.lease()
  isolation.prepare(slot)
  await assert.rejects(isolation.runSetup(slot), (error) => error.code === 'SETUP_FAILED' && /timed out/.test(error.message))
  await delay(700)
  assert.equal(existsSync(late), false, 'the step’s own child was killed too')
  isolation.release(slot)
  isolation.close()
})

test('an aborted call kills the setup step', async () => {
  const late = join(realpathSync(mkdtempSync(join(tmpdir(), 'flash-setup-abort-'))), 'late.txt')
  const script = `
const fs = require('node:fs')
setTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, 'late\\n'), 300)
setTimeout(() => {}, 5000)
`
  const repo = makeSetupRepo({ script })
  const { isolation } = makePool(repo, { allowSlotSetup: true })
  const slot = await isolation.lease()
  isolation.prepare(slot)
  const controller = new AbortController()
  const promise = isolation.runSetup(slot, { signal: controller.signal })
  setTimeout(() => controller.abort(), 80)
  await assert.rejects(promise, (error) => error.code === 'SETUP_FAILED' && /was cancelled/.test(error.message))
  assert.equal(existsSync(join(slot.dir, '.flash-cache', 'setup', '0.stamp')), false)
  await delay(500)
  assert.equal(existsSync(late), false, 'the killed step wrote nothing afterwards')
  isolation.release(slot)
  isolation.close()
})

test('the setup step runs asynchronously, so the event loop keeps turning', async () => {
  const repo = makeSetupRepo({ script: 'setTimeout(() => {}, 300)' })
  const { isolation } = makePool(repo, { allowSlotSetup: true })
  const slot = await isolation.lease()
  isolation.prepare(slot)
  const ticks = []
  const timer = setInterval(() => ticks.push(Date.now()), 20)
  try {
    const [entry] = await isolation.runSetup(slot)
    assert.equal(entry.ran, true)
  } finally {
    clearInterval(timer)
  }
  assert.ok(ticks.length >= 3, `a timer must fire during a 300 ms step, got ${String(ticks.length)} tick(s)`)
  isolation.release(slot)
  isolation.close()
})



test('a step that exits zero but leaves a background child holding its stdout is not a timeout', { skip: process.platform === 'win32' }, async () => {
  const pidFile = join(realpathSync(mkdtempSync(join(tmpdir(), 'flash-setup-bg-'))), 'pid')
  const script = `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
// The child inherits the step's stdout pipe and outlives the step, as a daemon started with
// \`cmd &\` does: detached and unref'd, so the step itself exits at once while the child keeps
// the pipe open, and the stdio close event waits for the child, not the step.
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit', detached: true })
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
child.unref()
console.log('setup finished')
`
  const repo = makeSetupRepo({ script, timeoutSeconds: 5 })
  const { isolation } = makePool(repo, { allowSlotSetup: true })
  const slot = await isolation.lease()
  isolation.prepare(slot)
  const started = Date.now()
  try {
    const [entry] = await isolation.runSetup(slot)
    const elapsed = Date.now() - started
    assert.equal(entry.ran, true)
    assert.ok(elapsed < 5000, `a step that exited must not wait out its 5 s timeout, took ${String(elapsed)} ms`)
  } finally {
    // Stop the deliberately left-running child so the test does not leak it. It was spawned
    // detached, so its pid is also its own process group's id.
    try {
      process.kill(-Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
    } catch {
      // The child may already be gone; nothing to clean up then.
    }
    isolation.release(slot)
    isolation.close()
  }
})

test('git status in the copy equals the caller’s for staged, unstaged and untracked work', async () => {
  const repo = makeRepo()
  writeFileSync(join(repo, 'README.md'), '# staged edit\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  writeFileSync(join(repo, 'keep.txt'), 'unstaged edit\n')
  writeFileSync(join(repo, 'untracked.txt'), 'never added\n')

  const original = git(['status', '--porcelain'], repo)
  assert.match(original, /^M  README\.md/m, 'the caller really has a staged edit')
  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot)

  // `git add -A` used to be run on the copy's real index to record the base, so every
  // uncommitted edit of the caller read as staged in the copy and in every report.
  assert.equal(git(['status', '--porcelain'], slot.dir), original)

  // …and `collect` still yields exactly the worker's change against the recorded base.
  writeFileSync(join(slot.dir, 'worker.txt'), 'written by the worker\n')
  const change = isolation.collect(slot)
  assert.deepEqual(change.filesChanged.map((line) => line.split('\t').at(-1)), ['worker.txt'])
  isolation.close()
})

test('a linked worktree’s staged and unstaged state travels into its copied repository', async () => {
  const repo = makeRepo()
  const side = join(repo, 'side-wt')
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'side', side], { cwd: repo })
  writeFileSync(join(side, 'README.md'), '# staged in the worktree\n')
  execFileSync('git', ['add', 'README.md'], { cwd: side })
  writeFileSync(join(side, 'keep.txt'), 'unstaged in the worktree\n')
  writeFileSync(join(side, 'untracked.txt'), 'new\n')

  const original = git(['status', '--porcelain'], side)
  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  const prepared = isolation.prepare(slot, { cwd: side })
  assert.equal(prepared.scope, 'side-wt')
  const copy = join(slot.dir, 'side-wt')
  // An empty index in the detached copy made every tracked file read as an unstaged
  // deletion, and lost the caller's staged edit entirely.
  assert.equal(git(['status', '--porcelain'], copy), original)
  isolation.close()
})

test('a symlinked .git is detached, so a call never shares the caller’s git dir', async () => {
  const repo = makeRepo()
  // `statSync` followed the symlink, so `detachGitLink` saw a directory and returned early:
  // the copy's `.git` WAS the caller's git directory.
  moveGitDirAside(repo)
  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  const prepared = isolation.prepare(slot)
  assert.notEqual(prepared.base, null, 'a repository reached through a symlinked .git still prepares')

  writeFileSync(join(slot.dir, 'worker.txt'), 'written by the worker\n')
  const change = isolation.collect(slot)

  // The worker's file is still collected...
  assert.deepEqual(change.filesChanged.map((line) => line.split('\t').at(-1)), ['worker.txt'])
  // ...but none of the call's git state reaches the caller. `refs/flash/base` and a staged
  // `worker.txt` in the caller's index were the reproduction.
  assert.equal(revParse(repo, 'refs/flash/base'), '')
  assert.equal(git(['status', '--porcelain'], repo), '', 'the caller’s work tree and index are untouched')
  isolation.close()
})

test('source "head" through a symlinked .git leaves the caller’s HEAD, index and untracked files alone', async () => {
  const repo = makeRepo()
  moveGitDirAside(repo)
  // The caller is mid-edit while another session asks for a copy of HEAD.
  writeFileSync(join(repo, 'README.md'), '# caller edit\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  writeFileSync(join(repo, 'mine.txt'), 'caller work\n')
  const statusBefore = git(['status', '--porcelain'], repo)
  const headBefore = git(['rev-parse', 'HEAD'], repo)
  const indexBefore = readFileSync(join(repo, '.git', 'index'))

  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot, { source: 'head' })

  assert.equal(git(['rev-parse', 'HEAD'], repo), headBefore, 'the caller’s HEAD did not move')
  assert.equal(git(['status', '--porcelain'], repo), statusBefore, 'the staged edit is still staged')
  assert.deepEqual(readFileSync(join(repo, '.git', 'index')), indexBefore, 'the caller’s index bytes are unchanged')
  assert.equal(readFileSync(join(repo, 'mine.txt'), 'utf8'), 'caller work\n', 'the caller’s untracked file survives')
  isolation.close()
})

// ── the copy reports what it started with ────────────────────────────────────

test('prepare reports the caller’s uncommitted paths and the count is the true total', async () => {
  const repo = makeRepo()
  writeFileSync(join(repo, 'README.md'), '# edited\n')
  writeFileSync(join(repo, 'one.txt'), '1\n')
  writeFileSync(join(repo, 'two.txt'), '2\n')
  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  const prepared = isolation.prepare(slot)
  assert.equal(prepared.uncommitted.count, 3)
  assert.deepEqual([...prepared.uncommitted.files].sort(), ['README.md', 'one.txt', 'two.txt'])

  // A clean tree reports nothing.
  const cleanRepo = makeRepo()
  const clean = makePool(cleanRepo)
  const cleanSlot = await clean.isolation.lease()
  assert.deepEqual(clean.isolation.prepare(cleanSlot).uncommitted, { count: 0, files: [] })
  isolation.close()
  clean.isolation.close()
})

// ── source: "head" ────────────────────────────────────────────────────────────

test('source "head" resets tracked files, removes untracked ones and keeps ignored ones', async () => {
  const repo = makeRepo()
  writeFileSync(join(repo, '.gitignore'), 'ignored/\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'ignore'], { cwd: repo })
  mkdirSync(join(repo, 'ignored'), { recursive: true })
  writeFileSync(join(repo, 'ignored', 'build.bin'), 'cache\n')
  writeFileSync(join(repo, 'README.md'), 'edited in the working tree\n')
  writeFileSync(join(repo, 'untracked.txt'), 'never committed\n')

  const { isolation } = makePool(repo)
  const slot = await isolation.lease()
  const prepared = isolation.prepare(slot, { source: 'head' })
  assert.equal(readFileSync(join(slot.dir, 'README.md'), 'utf8'), '# project\n')
  assert.equal(existsSync(join(slot.dir, 'untracked.txt')), false)
  assert.equal(existsSync(join(slot.dir, 'ignored', 'build.bin')), true, 'ignored files are not cleaned away')
  assert.deepEqual(prepared.uncommitted, { count: 0, files: [] })
  isolation.close()
})

test('source "head" needs a git repository', async () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-nogit-')))
  writeFileSync(join(plain, 'app.js'), 'app\n')
  const { isolation } = makePool(plain)
  const slot = await isolation.lease()
  assert.throws(
    () => isolation.prepare(slot, { source: 'head' }),
    (error) => error.code === 'SOURCE_UNAVAILABLE' && /needs a git repository/.test(error.message),
  )
  isolation.close()
})

// ── service-level wiring ──────────────────────────────────────────────────────

/** A runtime stand-in that replays one completed child per prompt, like service.test.mjs. */
class FakeClient {
  constructor({ writes } = {}) {
    this.pid = 4242
    this.writes = writes
    this.cwd = undefined
    this.prompts = []
    this.notificationHandlers = new Set()
    this.exitHandlers = new Set()
  }

  start() {
    return this.pid
  }

  async initialize(params) {
    this.cwd = params.cwd
    return { name: 'fake-runtime', version: '0' }
  }

  async prompt({ sessionId, text }) {
    this.prompts.push({ sessionId, text })
    queueMicrotask(() => this.#replay(sessionId, text))
    return { messageId: 'm' }
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  onExit(handler) {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
  }

  async shutdown() {}

  emit(method, params) {
    for (const handler of this.notificationHandlers) handler(method, params)
  }

  #replay(sessionId, text) {
    if (this.writes !== undefined && this.cwd !== undefined) writeFileSync(join(this.cwd, this.writes), 'written\n')
    const childId = `child-${sessionId}`
    this.emit('session.status', { sessionId, status: 'running' })
    this.emit('subagent.started', { parentSessionId: sessionId, childSessionId: childId })
    this.emit('session.event', {
      sessionId: childId,
      event: { type: 'request/header', data: { header: { config: { provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' } } } },
    })
    this.emit('subagent.finished', {
      provider: 'flash',
      agentId: 'agent-0',
      parentSessionId: sessionId,
      childSessionId: childId,
      status: 'ok',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: `worker result for ${text.slice(0, 10)}` }],
    })
    this.emit('session.status', { sessionId, status: 'idle' })
  }
}

/** A service over a real git repository, with a fake runtime and a private state directory. */
function makeService({ root, writes, ...overrides } = {}) {
  const client = new FakeClient({ writes })
  const service = new FlashTaskService({
    root,
    clientFactory: (profileName, cwd, extraEnv) => {
      client.extraEnv = extraEnv
      return client
    },
    log: () => {},
    isolate: { slots: 1, stateDir: realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-svc-state-'))) },
    ...overrides,
  })
  return { client, service }
}

test('a dirty caller tree is reported as uncommittedAtStart and named in the prompt', async () => {
  const repo = makeRepo()
  writeFileSync(join(repo, 'README.md'), '# edited\n')
  writeFileSync(join(repo, 'untracked.txt'), 'new\n')
  const { client, service } = makeService({ root: repo })

  const result = await service.flashTask({ task: 'do a thing', cwd: repo })
  assert.equal(result.isolation.uncommittedAtStart.count, 2)
  assert.deepEqual([...result.isolation.uncommittedAtStart.files].sort(), ['README.md', 'untracked.txt'])
  assert.match(client.prompts[0].text, /started with 2 uncommitted change\(s\)/)
  assert.match(client.prompts[0].text, /README\.md/)
  assert.match(client.prompts[0].text, /the caller's work in progress, not yours/)
  await service.close()
})

test('a clean caller tree carries no uncommittedAtStart and no paragraph', async () => {
  const repo = makeRepo()
  const { client, service } = makeService({ root: repo })
  const result = await service.flashTask({ task: 'do a thing', cwd: repo })
  assert.equal(result.isolation.uncommittedAtStart, undefined)
  assert.doesNotMatch(client.prompts[0].text, /uncommitted change\(s\)/)
  await service.close()
})

test('source "head" leaves the other sessions’ uncommitted work out of the copy', async () => {
  const repo = makeRepo()
  writeFileSync(join(repo, 'README.md'), 'someone else is mid-edit\n')
  writeFileSync(join(repo, 'untracked.txt'), 'someone else made this\n')
  const { service } = makeService({ root: repo, writes: 'worker.txt' })

  const result = await service.flashTask({ task: 'do a thing', cwd: repo, source: 'head' })
  assert.equal(result.isolation.uncommittedAtStart, undefined)
  assert.deepEqual(result.change.filesChanged, ['worker.txt'], 'only the worker’s own file changed')
  await service.close()
})

test('an unusable source is a FlashTaskError, and read-only cannot ask for "head"', async () => {
  const repo = makeRepo()
  const { service } = makeService({ root: repo })
  await assert.rejects(
    service.flashTask({ task: 'x', cwd: repo, source: 'fork' }),
    (error) => error instanceof FlashTaskError && error.code === 'SOURCE_UNAVAILABLE' && /not available/.test(error.message),
  )
  await assert.rejects(
    service.flashTask({ task: 'x', cwd: repo, mode: 'read-only', source: 'head' }),
    (error) => error instanceof FlashTaskError && error.code === 'SOURCE_UNAVAILABLE' && /read-only/.test(error.message),
  )
  await service.close()
})

test('source "head" on a root that is not a repository is refused', async () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-nogit-svc-')))
  writeFileSync(join(plain, 'app.js'), 'app\n')
  const { service } = makeService({ root: plain })
  await assert.rejects(
    service.flashTask({ task: 'x', cwd: plain, source: 'head' }),
    (error) => error instanceof FlashTaskError && error.code === 'SOURCE_UNAVAILABLE' && /needs a git repository/.test(error.message),
  )
  await service.close()
})

test('the resolved slotEnv is handed to the runtime factory, and only when configured', async () => {
  const repo = makeRepo()
  // With no slotEnv the only variable set is the one naming the model the process runs.
  const bare = makeService({ root: repo })
  await bare.service.flashTask({ task: 'x', cwd: repo })
  assert.deepEqual(bare.client.extraEnv, { FLASH_ROUTE_MODEL: 'deepseek-v4.1-flash:cloud' })
  await bare.service.close()

  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-svc-env-')))
  const client = new FakeClient()
  const service = new FlashTaskService({
    root: repo,
    clientFactory: (profileName, cwd, extraEnv) => {
      client.extraEnv = extraEnv
      return client
    },
    log: () => {},
    isolate: { slots: 1, stateDir, slotEnv: { CARGO_HOME: 'home:cargo', CARGO_TARGET_DIR: 'cache:cargo-target' } },
  })
  await service.flashTask({ task: 'x', cwd: repo })
  const slotDir = service.isolation.slots[0].dir
  assert.deepEqual(client.extraEnv, {
    CARGO_HOME: join(slotDir, '.flash-home', 'cargo'),
    CARGO_TARGET_DIR: join(slotDir, '.flash-cache', 'cargo-target'),
    FLASH_ROUTE_MODEL: 'deepseek-v4.1-flash:cloud',
  })
  // The prompt names the variables that were set, so the worker knows where to cache.
  assert.match(client.prompts[0].text, /CARGO_HOME, CARGO_TARGET_DIR/)
  await service.close()
})

test('a writing call without the opt-in carries the setup warning and does not run the step', async () => {
  await withSetupCounter(async (counter) => {
    const repo = makeSetupRepo()
    const { service } = makeService({ root: repo })
    const result = await service.flashTask({ task: 'do a thing', cwd: repo })
    assert.equal(setupRuns(counter), 0)
    assert.equal(result.setup, undefined)
    assert.ok(result.warnings.includes(SETUP_NOT_ALLOWED_WARNING), `expected the setup warning, got ${JSON.stringify(result.warnings)}`)
    await service.close()
  })
})

test('a fleet without the opt-in carries the setup warning too', async () => {
  await withSetupCounter(async (counter) => {
    const repo = makeSetupRepo()
    const { service } = makeService({ root: repo })
    const result = await service.flashBatch({ tasks: ['do a thing'], cwd: repo })
    assert.equal(setupRuns(counter), 0)
    assert.equal(result.setup, undefined)
    assert.ok(result.warnings.includes(SETUP_NOT_ALLOWED_WARNING), `expected the setup warning, got ${JSON.stringify(result.warnings)}`)
    await service.close()
  })
})

test('an allowed setup runs before the worker, is reported in the result, and is named in the prompt', async () => {
  await withSetupCounter(async (counter) => {
    const repo = makeSetupRepo()
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-setup-svc-')))
    const { client, service } = makeService({
      root: repo,
      writes: 'worker.txt',
      isolate: { slots: 1, stateDir, allowSlotSetup: true },
    })
    const result = await service.flashTask({ task: 'do a thing', cwd: repo })
    assert.equal(setupRuns(counter), 1)
    assert.equal(result.setup.length, 1)
    assert.equal(result.setup[0].ran, true)
    assert.equal(result.setup[0].reason, 'first run in this slot')
    assert.deepEqual(result.setup[0].run.slice(0, 2), [process.execPath, '-e'])
    assert.equal(result.warnings, undefined)
    // The setup's own output is never the worker's change.
    assert.deepEqual(result.change.filesChanged, ['worker.txt'])
    assert.equal(result.change.ignored, undefined)
    assert.ok(
      client.prompts[0].text.includes(
        `The slot setup (${process.execPath} -e `,
      ) &&
        client.prompts[0].text.includes(
          '; inputs: bun.lock) has already run in this copy; do not run it again unless you change bun.lock.',
        ),
      client.prompts[0].text,
    )
    await service.close()
  })
})

test('a failing setup step fails the call with SETUP_FAILED and releases the slot', async () => {
  const repo = makeSetupRepo({ script: "console.error('boom-tail'); process.exit(9)" })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-copy-setup-fail-')))
  const { service } = makeService({ root: repo, isolate: { slots: 1, stateDir, allowSlotSetup: true } })
  await assert.rejects(
    service.flashTask({ task: 'do a thing', cwd: repo }),
    (error) =>
      error instanceof FlashTaskError &&
      error.code === 'SETUP_FAILED' &&
      /exit code 9/.test(error.message) &&
      /boom-tail/.test(error.message),
  )
  assert.equal(service.isolation.inUse, 0, 'the slot is handed back like any other early refusal')
  await service.close()
})

// ── option parsing ────────────────────────────────────────────────────────────

test('--copy-exclude and FLASH_COPY_EXCLUDE parse into copyExclude', () => {
  const config = mergeConfig({})
  assert.deepEqual(parseOptions(['--copy-exclude', 'target, node_modules'], {}, config).copyExclude, ['target', 'node_modules'])
  assert.deepEqual(parseOptions([], { FLASH_COPY_EXCLUDE: 'target,a/b' }, config).copyExclude, ['target', 'a/b'])
  assert.equal(parseOptions([], {}, config).copyExclude, undefined)
  assert.equal(parseOptions([], { FLASH_COPY_EXCLUDE: '' }, config).copyExclude, undefined)
  assert.throws(() => parseOptions(['--copy-exclude'], {}, config), /needs a value/)
})
