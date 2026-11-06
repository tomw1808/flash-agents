/**
 * Regression tests for the four isolation rough edges a user found on 0.1.11: the copy's
 * clone fallback, patches stored for calls that changed nothing, ignored build output in
 * the ignored-path notice, and `excludeBase` for a patch that continued from another.
 *
 * These run against real temporary repositories and a real `git`, through the pool and
 * apply entry points, because every property here is a property of the copy, of git's
 * index, or of a patch record — none of which a stub can stand in for.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { DEFAULT_COPY_EXCLUDE, WorkspaceIsolation, cleanLayout, copyTree, rootDigest } from '../lib/isolation.js'
import { listTools } from '../lib/index.js'
import { FlashTaskService } from '../lib/service.js'

/** The service's report store lives beside the patch store unless a test names one. */
process.env.FLASH_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'flash-0112-data-')))

/** Run git in a directory and return its standard output. */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** A throwaway git repository, realpath'd so macOS `/var` vs `/private/var` cannot bite. */
function makeRepo(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-0112-')))
  git(dir, 'init', '-q', '-b', 'main')
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
  }
  git(dir, 'add', '-A')
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
  return dir
}

/**
 * A runtime stand-in that replays one successful child per prompt, writing the files a
 * test asked for into whatever tree it was given. Enough for a real service call without
 * booting Harness, in the style of the `patch` tests.
 */
class FakeSdkClient {
  constructor(writes = {}) {
    this.writes = writes
    this.pid = 4242
    this.running = false
    this.cwd = undefined
    this.notificationHandlers = new Set()
    this.exitHandlers = new Set()
  }

  start() {
    this.running = true
    return this.pid
  }

  async initialize(params) {
    this.cwd = params.cwd
    return { name: 'fake-runtime', version: '0' }
  }

  async prompt({ sessionId }) {
    queueMicrotask(() => this.#replay(sessionId))
    return { messageId: 'msg-1' }
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  onExit(handler) {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
  }

  async shutdown() {
    this.running = false
  }

  emit(method, params) {
    for (const handler of this.notificationHandlers) handler(method, params)
  }

  #replay(sessionId) {
    if (this.cwd !== undefined) {
      for (const [name, content] of Object.entries(this.writes)) {
        mkdirSync(dirname(join(this.cwd, name)), { recursive: true })
        writeFileSync(join(this.cwd, name), content)
      }
    }
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
      lastAssistantMessage: [{ type: 'text', text: 'worker result' }],
    })
    this.emit('session.status', { sessionId, status: 'idle' })
  }
}

/** A pool over a repository with its own state directory and a log sink. */
function makePool(repo, options = {}) {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-0112-state-')))
  const logs = []
  const isolation = new WorkspaceIsolation({ root: repo, slots: 1, stateDir, log: (line) => logs.push(line), ...options })
  return { isolation, stateDir, logs }
}

/** A service over a repository with a fake runtime that writes `writes` into the copy. */
function makeService(root, { writes = {}, stateDir, copyExclude } = {}) {
  const client = new FakeSdkClient(writes)
  const logs = []
  const service = new FlashTaskService({
    root,
    clientFactory: () => client,
    log: (line) => logs.push(line),
    isolate: { slots: 1, ...(stateDir === undefined ? {} : { stateDir }), ...(copyExclude === undefined ? {} : { copyExclude }) },
  })
  return { service, client, logs }
}

/** Lease, prepare, apply `mutate` to the copy, and collect. */
async function collectInCopy(isolation, mutate) {
  const slot = await isolation.lease()
  isolation.prepare(slot)
  mutate(slot.dir)
  return { slot, change: isolation.collect(slot) }
}

/** One patch record as it sits on disk. */
function readRecord(isolation, patchId) {
  return JSON.parse(readFileSync(join(isolation.patchDir, `${patchId}.json`), 'utf8'))
}

/** The plain path of every entry `collect` reported. */
function plainNames(change) {
  return change.filesChanged.map((line) => line.split('\t').at(-1))
}

// ── the copy's clone mechanism ───────────────────────────────────────────────

test('the copy asks for the Linux clone flag, and macOS and Windows never ask', () => {
  const from = realpathSync(mkdtempSync(join(tmpdir(), 'flash-0112-clone-from-')))
  const to = mkdtempSync(join(tmpdir(), 'flash-0112-clone-to-'))
  writeFileSync(join(from, 'a.txt'), 'a\n')
  writeFileSync(join(from, 'b.txt'), 'b\n')

  const attempts = []
  const failing = {
    copyFileSync: (source, target, mode) => {
      attempts.push(mode)
      if (mode === constants.COPYFILE_FICLONE_FORCE) {
        const error = new Error('ENOSYS: function not implemented')
        error.code = 'ENOSYS'
        throw error
      }
      return copyFileSync(source, target)
    },
  }
  const fallbacks = []
  const linux = copyTree(from, mkdtempSync(join(tmpdir(), 'flash-0112-clone-linux-')), {
    fs: failing,
    platform: 'linux',
    onCloneFallback: (platform, code) => fallbacks.push([platform, code]),
  })
  assert.equal(linux.mechanism, 'copy', 'the plain copy is the fallback the mechanism reports')
  // One attempt, one fallback line: the second file must not ask the filesystem again.
  assert.equal(attempts.filter((mode) => mode === constants.COPYFILE_FICLONE_FORCE).length, 1)
  assert.equal(attempts.filter((mode) => mode === undefined).length, 2)
  assert.deepEqual(fallbacks, [['linux', 'ENOSYS']])

  // macOS APFS has clonefile, but Node answers COPYFILE_FICLONE_FORCE with ENOSYS even
  // there, so a forced attempt would only log a fallback on every copy.
  const darwinModes = []
  const darwin = copyTree(from, mkdtempSync(join(tmpdir(), 'flash-0112-clone-darwin-')), {
    fs: {
      copyFileSync: (source, target, mode) => {
        darwinModes.push(mode)
        return copyFileSync(source, target)
      },
    },
    platform: 'darwin',
    onCloneFallback: () => assert.fail('macOS copies plainly and has no clone attempt to fall back from'),
  })
  assert.equal(darwin.mechanism, 'copy')
  assert.deepEqual(darwinModes, [undefined, undefined], 'macOS copies plainly from the first file')

  const windowsModes = []
  const windows = copyTree(from, mkdtempSync(join(tmpdir(), 'flash-0112-clone-win-')), {
    fs: {
      copyFileSync: (source, target, mode) => {
        windowsModes.push(mode)
        return copyFileSync(source, target)
      },
    },
    platform: 'win32',
    onCloneFallback: () => assert.fail('Windows has no clone flag to fall back from'),
  })
  assert.equal(windows.mechanism, 'copy')
  assert.deepEqual(windowsModes, [undefined, undefined], 'Windows copies plainly from the first file')
})

test('a filesystem without clone support logs one line per server and writes nothing to stderr', async () => {
  const repo = makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' })
  const { isolation, logs } = makePool(repo, { platform: 'linux' })
  const failing = {
    copyFileSync: (source, target, mode) => {
      if (mode === constants.COPYFILE_FICLONE_FORCE) {
        const error = new Error('ENOSYS: function not implemented')
        error.code = 'ENOSYS'
        throw error
      }
      return copyFileSync(source, target)
    },
  }
  const stderr = []
  const originalWrite = process.stderr.write
  process.stderr.write = (chunk, ...rest) => {
    stderr.push(String(chunk))
    return originalWrite.call(process.stderr, chunk, ...rest)
  }
  try {
    for (let at = 0; at < 2; at += 1) {
      const slot = await isolation.lease()
      isolation.prepare(slot, { fs: failing })
      isolation.discard(slot)
      isolation.release(slot)
    }
  } finally {
    process.stderr.write = originalWrite
  }
  assert.deepEqual(stderr, [], 'a fallback report is a log line, never child output')
  const fallbackLines = logs.filter((line) => line.includes('copy-on-write clone'))
  assert.equal(fallbackLines.length, 1, JSON.stringify(logs))
  // The one line names the flag that was tried, the error code, and that a plain copy is used.
  assert.match(fallbackLines[0], /COPYFILE_FICLONE_FORCE/)
  assert.match(fallbackLines[0], /ENOSYS/)
  assert.match(fallbackLines[0], /plain copy/)
  isolation.close()
})

// ── a call that changed nothing ─────────────────────────────────────────────

test('a call with no change stores no patch and claims none', async () => {
  const repo = makeRepo({ 'README.md': '# project\n' })
  const { isolation } = makePool(repo)
  const { slot, change } = await collectInCopy(isolation, () => {})

  assert.equal(change.available, true)
  assert.deepEqual(change.filesChanged, [])
  assert.deepEqual(change.ignored, [])
  assert.equal(change.patchId, undefined)
  assert.equal(change.patchPath, undefined)
  assert.equal(change.stored, false)
  assert.deepEqual(isolation.listPatches(), [])
  assert.deepEqual(readdirSync(isolation.patchDir).filter((name) => name.endsWith('.patch')), [])
  isolation.release(slot)
  isolation.close()
})

test('a call with no change has no patch to apply, rather than an empty one', async () => {
  const repo = makeRepo({ 'README.md': '# project\n' })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-0112-auto-state-')))
  const { service } = makeService(repo, { stateDir })
  const result = await service.flashTask({ task: 'change nothing', cwd: repo })

  assert.equal(result.change.available, true)
  assert.deepEqual(result.change.filesChanged, [])
  assert.equal(result.change.patchId, undefined)
  assert.equal(result.change.patchPath, undefined)
  assert.equal(result.change.stored, false)
  // The auto path in service.js reads change.patchId; with no id there is nothing this
  // layer may apply, and treating "nothing" as a patch is refused rather than silently
  // applied. The service guard that turns this into change.applied: false is outside the
  // files this test may change (see the report).
  assert.throws(
    () => service.isolation.apply({ patchId: result.change.patchId }),
    /is not an id this service issues/,
  )
  await service.close()
})

test('apply: "auto" with a no-change worker reports applied: false and says why nothing was stored', async () => {
  const repo = makeRepo({ 'README.md': '# project\n' })
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-0112-auto-note-state-')))
  const { service } = makeService(repo, { stateDir })
  const result = await service.flashTask({ task: 'change nothing', cwd: repo, apply: 'auto' })

  assert.equal(result.change.available, true)
  assert.deepEqual(result.change.filesChanged, [])
  assert.equal(result.change.patchId, undefined)
  assert.equal(result.change.applied, false)
  assert.equal(result.change.note, 'the worker changed nothing, so no patch was stored')
  assert.equal(git(repo, 'status', '--porcelain'), '')
  await service.close()
})

test('flash_apply and flash_patch declare excludeBase and what it refuses', () => {
  const tools = listTools()
  for (const name of ['flash_apply', 'flash_patch']) {
    const tool = tools.find((entry) => entry.name === name)
    assert.equal(tool.inputSchema.properties.excludeBase.type, 'boolean')
    assert.match(tool.inputSchema.properties.excludeBase.description, /no base patch/)
    assert.match(tool.inputSchema.properties.excludeBase.description, /no longer stored/)
    assert.match(tool.description, /excludeBase: true/)
  }
})

// ── the ignored-path notice ──────────────────────────────────────────────────

test('the ignored-path notice skips build output the copy left out or the caller has, and keeps a new ignored out/', async () => {
  const repo = makeRepo({
    '.gitignore': 'target/\nout/\n.env\n',
    'README.md': '# project\n',
  })
  mkdirSync(join(repo, 'target'))
  writeFileSync(join(repo, 'target', 'old.bin'), 'built\n')
  writeFileSync(join(repo, '.env'), 'SECRET=old\n')
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-0112-ignored-state-')))
  const { service } = makeService(repo, {
    stateDir,
    copyExclude: ['target'],
    writes: {
      'target/debug/artifact': 'rebuilt\n',
      'out/result.txt': 'the worker result\n',
      '.env': 'SECRET=new\n',
    },
  })
  const result = await service.flashTask({ task: 'build and write a result', cwd: repo, apply: 'discard' })

  // `target` was left out of the copy and exists in the caller's tree; `.env` was left out
  // by the defaults and also exists there. Neither is a path the worker created in the
  // caller's world. `out/` is new and ignored, so the notice must still name it.
  assert.deepEqual(result.change.ignored, ['out'])
  const notice = (result.warnings ?? []).find((line) => line.includes('path(s) that git ignores'))
  assert.match(notice, /out/)
  assert.doesNotMatch(notice, /target|\.env/)
  // The caller's own build output and secret are untouched.
  assert.equal(readFileSync(join(repo, 'target', 'old.bin'), 'utf8'), 'built\n')
  assert.equal(readFileSync(join(repo, '.env'), 'utf8'), 'SECRET=old\n')
  assert.equal(existsSync(join(repo, 'out')), false)
  assert.equal(git(repo, 'status', '--porcelain'), '')
  await service.close()
})

// ── settings, report cleanup and atomic report writes ───────────────────────

test('the ignored-path notice filters by the default excludes, not only the named ones', async () => {
  const repo = makeRepo({
    '.gitignore': '.env\n.mcp.json\nout/\n',
    'README.md': '# project\n',
  })
  // Neither excluded path exists in the caller's tree, so only the default rule can explain
  // why the worker-created copies must not be reported.
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-0112-default-exclude-state-')))
  const { service } = makeService(repo, {
    stateDir,
    writes: {
      '.env': 'SECRET=new\n',
      '.mcp.json': '{"servers":{}}\n',
      'out/result.txt': 'the worker result\n',
    },
  })
  const result = await service.flashTask({ task: 'write secrets and a result', cwd: repo, apply: 'discard' })

  assert.deepEqual(result.change.ignored, ['out'])
  const notice = (result.warnings ?? []).find((line) => line.includes('path(s) that git ignores'))
  assert.match(notice, /out/)
  assert.doesNotMatch(notice, /\.env|\.mcp\.json/)
  assert.equal(existsSync(join(repo, '.env')), false)
  assert.equal(existsSync(join(repo, '.mcp.json')), false)
  await service.close()
})

test('the local settings file’s stateBase is a known key and the pool does not warn about it', async () => {
  const repo = makeRepo({ 'README.md': '# project\n' })
  writeFileSync(join(repo, '.flash-agents.local.json'), JSON.stringify({ stateBase: join(tmpdir(), 'a-base-this-pool-does-not-use') }))
  const { isolation, logs } = makePool(repo)
  const slot = await isolation.lease()
  isolation.prepare(slot)
  isolation.release(slot)

  assert.equal(
    logs.some((line) => /stateBase is not a known setting/.test(line)),
    false,
    `a valid stateBase must not warn: ${logs.join('\n')}`,
  )
  assert.deepEqual(isolation.copyExclude, [...DEFAULT_COPY_EXCLUDE], 'the file still contributes no copy exclusion')
  isolation.close()
})

test('whole reports age out with the patch window in the pool sweep and in clean, and clean counts them', () => {
  const repo = makeRepo({ 'README.md': '# project\n' })
  const baseDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-0112-reports-base-')))
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'flash-0112-reports-data-')))
  const reportsDir = join(baseDir, rootDigest(repo), 'reports')
  mkdirSync(reportsDir, { recursive: true })
  const oldReport = join(reportsDir, 'old-job.report.json')
  const freshReport = join(reportsDir, 'fresh-job.report.json')
  writeFileSync(oldReport, '{"report":"old"}\n')
  writeFileSync(freshReport, '{"report":"fresh"}\n')
  const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
  utimesSync(oldReport, oldTime, oldTime)

  // The pool's start-up sweep prunes with the same window as patches.
  const { isolation } = makePool(repo, { baseDir })
  assert.equal(existsSync(oldReport), false, 'an old report is removed by the sweep')
  assert.equal(existsSync(freshReport), true, 'a fresh report is kept by the sweep')

  // `clean` prunes the reports under the state base too, and its listing counts them: stats
  // is read before anything is removed, so it names both the fresh one and the old one.
  const secondOld = join(reportsDir, 'old2-job.report.json')
  writeFileSync(secondOld, '{"report":"old2"}\n')
  utimesSync(secondOld, oldTime, oldTime)
  const report = cleanLayout({ baseDir, dataDir, root: repo })
  const own = report.stats.find((entry) => entry.digest === rootDigest(repo))
  assert.equal(own.reports, 2)
  assert.ok(own.reportBytes > 0)
  assert.equal(report.actions.reportsPruned, 1)
  assert.equal(existsSync(secondOld), false, 'clean removes an expired report')
  assert.equal(existsSync(freshReport), true, 'clean keeps a fresh report')
  isolation.close()
})

test('the pool stores a report atomically, so a reader never sees a half-written file', () => {
  const repo = makeRepo({ 'README.md': '# project\n' })
  const { isolation } = makePool(repo)
  const path = isolation.storeReport('job-1', { kind: 'flash_task', report: 'the first report\n' })

  // A reader that already has the old file open keeps reading the old bytes: the new record
  // arrived by rename, not by rewriting the file in place.
  const reader = openSync(path, 'r')
  try {
    assert.equal(isolation.storeReport('job-1', { kind: 'flash_task', report: 'the second report\n' }), path)
    assert.match(readFileSync(reader, 'utf8'), /the first report/)
  } finally {
    closeSync(reader)
  }
  assert.match(readFileSync(path, 'utf8'), /the second report/)
  assert.deepEqual(
    readdirSync(isolation.patchDir).filter((name) => name.endsWith('.tmp')),
    [],
    'the temporary file is renamed, never left behind',
  )
  isolation.close()
})

// ── excludeBase ──────────────────────────────────────────────────────────────

/**
 * A repository, a stored base patch that edits `base.txt`, and a second cumulative patch
 * that adds two own files on top of it. Returns the pool and both records.
 */
async function baseAndOwnPatch() {
  const lines = Array.from({ length: 12 }, (_, at) => `l${String(at + 1)}`).join('\n') + '\n'
  const repo = makeRepo({ 'base.txt': lines })
  const { isolation } = makePool(repo)
  const first = await (async () => {
    const { slot, change } = await collectInCopy(isolation, (dir) => {
      writeFileSync(join(dir, 'base.txt'), lines.replace('l2\n', 'l2 BASE\n'))
    })
    isolation.discard(slot)
    isolation.release(slot)
    return change
  })()
  const slot = await isolation.lease()
  isolation.prepare(slot)
  const planted = isolation.applyBasePatch(slot, first.patchId)
  assert.equal(planted.applied, true)
  writeFileSync(join(slot.dir, 'own-a.txt'), 'a\n')
  writeFileSync(join(slot.dir, 'own-b.txt'), 'b\n')
  const second = isolation.collect(slot)
  isolation.discard(slot)
  isolation.release(slot)
  assert.deepEqual(plainNames(second).sort(), ['base.txt', 'own-a.txt', 'own-b.txt'])
  return { repo, isolation, first, second }
}

test('excludeBase reads and applies only the two own files of a cumulative patch', async () => {
  const { repo, isolation, first, second } = await baseAndOwnPatch()
  assert.equal(readRecord(isolation, second.patchId).basePatch, first.patchId, 'the base patch is recorded')

  // Without the option the patch is still cumulative.
  const cumulative = isolation.readPatch({ patchId: second.patchId, maxChars: 1_000_000 })
  assert.deepEqual(cumulative.filesChanged.map((line) => line.split('\t').at(-1)).sort(), ['base.txt', 'own-a.txt', 'own-b.txt'])

  const own = isolation.readPatch({ patchId: second.patchId, excludeBase: true, maxChars: 1_000_000 })
  assert.deepEqual(plainNames(own).sort(), ['own-a.txt', 'own-b.txt'])
  assert.match(own.diff, /own-a\.txt/)
  assert.match(own.diff, /own-b\.txt/)
  assert.doesNotMatch(own.diff, /base\.txt/)
  assert.equal(own.patchPath, second.patchPath, 'the stored cumulative patch is still the one on disk')
  assert.equal(readFileSync(second.patchPath, 'utf8'), cumulative.diff, 'the stored patch is never rewritten')

  // The caller's tree holds neither half yet; applying only the own half puts the two new
  // files in and leaves the base patch's work out.
  const applied = isolation.apply({ patchId: second.patchId, excludeBase: true })
  assert.equal(applied.applied, true)
  assert.deepEqual(applied.filesChanged.sort(), ['own-a.txt', 'own-b.txt'])
  assert.equal(readFileSync(join(repo, 'own-a.txt'), 'utf8'), 'a\n')
  assert.equal(readFileSync(join(repo, 'own-b.txt'), 'utf8'), 'b\n')
  assert.doesNotMatch(readFileSync(join(repo, 'base.txt'), 'utf8'), /l2 BASE/)
  assert.equal(git(repo, 'status', '--porcelain'), '?? own-a.txt\n?? own-b.txt\n')
  // Only the own files are recorded as applied; the base patch's file is not.
  assert.deepEqual(readRecord(isolation, second.patchId).appliedFiles.sort(), ['own-a.txt', 'own-b.txt'])
  assert.equal(readRecord(isolation, first.patchId).appliedAt, null)
  isolation.close()
})

test('excludeBase is refused without a recorded base patch and when that base patch is gone', async () => {
  const { isolation, first, second } = await baseAndOwnPatch()
  // The first patch continued from nothing.
  assert.throws(
    () => isolation.readPatch({ patchId: first.patchId, excludeBase: true, maxChars: 1_000_000 }),
    /was not started from another patch, so there is no base patch to exclude/,
  )
  assert.throws(
    () => isolation.apply({ patchId: first.patchId, excludeBase: true }),
    /was not started from another patch, so there is no base patch to exclude/,
  )

  // The second patch's base patch file is removed after it was stored.
  rmSync(first.patchPath, { force: true })
  assert.throws(
    () => isolation.readPatch({ patchId: second.patchId, excludeBase: true, maxChars: 1_000_000 }),
    /base patch .* is no longer stored/,
  )
  assert.throws(
    () => isolation.apply({ patchId: second.patchId, excludeBase: true }),
    /base patch .* is no longer stored/,
  )
  isolation.close()
})

/**
 * A repository, a stored base patch made by `mutate`, and a second cumulative patch that
 * adds `own.txt` unless `own` is false. Returns the pool and both records.
 */
async function basePatchThenOwn(mutate, { own = true } = {}) {
  const repo = makeRepo({ 'base.txt': 'base\n', 'gone.txt': 'gone\n', 'old.txt': 'rename me\n' })
  const { isolation } = makePool(repo)
  const { slot: firstSlot, change: first } = await collectInCopy(isolation, mutate)
  isolation.discard(firstSlot)
  isolation.release(firstSlot)

  const slot = await isolation.lease()
  isolation.prepare(slot)
  const planted = isolation.applyBasePatch(slot, first.patchId)
  assert.equal(planted.applied, true)
  if (own) writeFileSync(join(slot.dir, 'own.txt'), 'own work\n')
  const second = isolation.collect(slot)
  isolation.discard(slot)
  isolation.release(slot)
  return { repo, isolation, first, second }
}

test('excludeBase returns and lands only the own work over a base patch that adds, deletes or renames', async () => {
  const cases = [
    {
      what: 'adds',
      mutate: (dir) => writeFileSync(join(dir, 'added.txt'), 'added by the base patch\n'),
      check: (repo) => assert.equal(existsSync(join(repo, 'added.txt')), false, 'the base patch’s new file stays out'),
    },
    {
      what: 'deletes',
      mutate: (dir) => rmSync(join(dir, 'gone.txt')),
      check: (repo) => assert.equal(readFileSync(join(repo, 'gone.txt'), 'utf8'), 'gone\n', 'the base patch’s deletion stays out'),
    },
    {
      what: 'renames',
      mutate: (dir) => renameSync(join(dir, 'old.txt'), join(dir, 'new.txt')),
      check: (repo) => {
        assert.equal(readFileSync(join(repo, 'old.txt'), 'utf8'), 'rename me\n', 'the base patch’s rename stays out')
        assert.equal(existsSync(join(repo, 'new.txt')), false, 'the rename target stays out')
      },
    },
  ]
  for (const entry of cases) {
    const { repo, isolation, second } = await basePatchThenOwn(entry.mutate)
    try {
      const own = isolation.readPatch({ patchId: second.patchId, excludeBase: true, maxChars: 1_000_000 })
      assert.deepEqual(plainNames(own), ['own.txt'], `excludeBase reading after the base patch ${entry.what}`)
      assert.match(own.diff, /own\.txt/)

      const applied = isolation.apply({ patchId: second.patchId, excludeBase: true })
      assert.equal(applied.applied, true, `excludeBase applying after the base patch ${entry.what}`)
      assert.deepEqual(applied.filesChanged, ['own.txt'])
      assert.equal(readFileSync(join(repo, 'own.txt'), 'utf8'), 'own work\n')
      entry.check(repo)
      assert.equal(git(repo, 'status', '--porcelain'), '?? own.txt\n', `only the own file reached the tree after a base ${entry.what}`)
    } finally {
      isolation.close()
    }
  }
})

test('a plain apply of a cumulative patch still carries the base patch’s work', async () => {
  const { repo, isolation, first, second } = await baseAndOwnPatch()
  try {
    const applied = isolation.apply({ patchId: second.patchId })
    assert.equal(applied.applied, true)
    assert.deepEqual([...applied.filesChanged].sort(), ['base.txt', 'own-a.txt', 'own-b.txt'])
    assert.match(readFileSync(join(repo, 'base.txt'), 'utf8'), /l2 BASE/)
    assert.equal(readFileSync(join(repo, 'own-a.txt'), 'utf8'), 'a\n')
    assert.equal(readFileSync(join(repo, 'own-b.txt'), 'utf8'), 'b\n')
    assert.equal(typeof readRecord(isolation, second.patchId).appliedAt, 'number')
    assert.equal(readRecord(isolation, first.patchId).appliedAt, null)
  } finally {
    isolation.close()
  }
})

test('excludeBase of a patch that holds only its base patch is empty and says so', async () => {
  const { repo, isolation, first, second } = await basePatchThenOwn(
    (dir) => writeFileSync(join(dir, 'base.txt'), 'changed by the base patch\n'),
    { own: false },
  )
  try {
    const note = `this patch holds no work beyond its base patch ${first.patchId}; nothing to apply`

    const page = isolation.readPatch({ patchId: second.patchId, excludeBase: true, maxChars: 1_000_000 })
    assert.deepEqual(page.filesChanged, [])
    assert.equal(page.diff, '')
    assert.equal(page.totalChars, 0)
    assert.equal(page.note, note)

    const applied = isolation.apply({ patchId: second.patchId, excludeBase: true })
    assert.equal(applied.applied, false)
    assert.equal(applied.note, note)
    assert.deepEqual(applied.filesChanged, [])
    // The three-way path never sees the empty diff either.
    const merged = isolation.apply({ patchId: second.patchId, excludeBase: true, threeWay: true })
    assert.equal(merged.applied, false)
    assert.equal(merged.note, note)
    assert.equal(git(repo, 'status', '--porcelain'), '')
  } finally {
    isolation.close()
  }
})

test('a repeated excludeBase apply is refused like a second whole apply, and force lifts it', async () => {
  const { repo, isolation, second } = await baseAndOwnPatch()
  try {
    const applied = isolation.apply({ patchId: second.patchId, excludeBase: true })
    assert.equal(applied.applied, true)
    assert.equal(typeof readRecord(isolation, second.patchId).appliedAt, 'number', 'the own half counts as applied')

    // Remove the own half from the caller's tree, so a force apply can land it again.
    rmSync(join(repo, 'own-a.txt'), { force: true })
    rmSync(join(repo, 'own-b.txt'), { force: true })
    assert.equal(git(repo, 'status', '--porcelain'), '')

    assert.throws(
      () => isolation.apply({ patchId: second.patchId, excludeBase: true }),
      new RegExp(`patch ${second.patchId} was already applied to .*; pass force: true to apply it again`),
    )
    const forced = isolation.apply({ patchId: second.patchId, excludeBase: true, force: true })
    assert.equal(forced.applied, true, 'force: true applies the own half again')
    assert.equal(readFileSync(join(repo, 'own-a.txt'), 'utf8'), 'a\n')
    assert.equal(readFileSync(join(repo, 'own-b.txt'), 'utf8'), 'b\n')
  } finally {
    isolation.close()
  }
})
