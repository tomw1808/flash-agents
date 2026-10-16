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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { WorkspaceIsolation, copyTree } from '../lib/isolation.js'
import { FlashTaskService, FlashTaskError } from '../lib/service.js'
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

test('a malformed or unknown settings file logs and is ignored', async () => {
  const repo = makeExcludeRepo()
  writeFileSync(join(repo, '.flash-agents.json'), '{ not json')
  const logs = []
  const broken = makePool(repo, { log: (line) => logs.push(line) })
  assert.ok(logs.some((line) => /not valid JSON/.test(line)), `expected a JSON note, got ${JSON.stringify(logs)}`)
  // The service still starts and prepares with no exclusions.
  const slot = await broken.isolation.lease()
  assert.equal(broken.isolation.copyExclude.length, 0)
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

test('a slotEnv option wins per variable over the settings file', () => {
  const repo = makeRepo()
  writeFileSync(join(repo, '.flash-agents.json'), JSON.stringify({ slotEnv: { CARGO_HOME: 'home:from-file', OTHER: 'home:other' } }))
  const { isolation } = makePool(repo, { slotEnv: { CARGO_HOME: 'home:from-option' } })
  assert.deepEqual(isolation.slotEnv.CARGO_HOME, { kind: 'home', segment: 'from-option' })
  assert.deepEqual(isolation.slotEnv.OTHER, { kind: 'home', segment: 'other' })
  isolation.close()
})

// ── the copy's git index mirrors the caller's ─────────────────────────────────

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
  // With no slotEnv the runtime's environment is untouched, exactly as before.
  const bare = makeService({ root: repo })
  await bare.service.flashTask({ task: 'x', cwd: repo })
  assert.equal(bare.client.extraEnv, undefined)
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
  })
  // The prompt names the variables that were set, so the worker knows where to cache.
  assert.match(client.prompts[0].text, /CARGO_HOME, CARGO_TARGET_DIR/)
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
