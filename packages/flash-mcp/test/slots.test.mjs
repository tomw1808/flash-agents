/**
 * Slot lifecycle and per-call settings: a retired tree's warm build cache survives the
 * trim, a cold cache says so in the result, and an edited settings file reaches the next
 * call without a reconnect.
 *
 * Real repositories, real `git` and real pools, as in isolation.test.mjs; the runtime is a
 * small stand-in, as in service.test.mjs, so nothing here needs Harness. Every directory is a
 * fresh temporary one: no test reads or writes the real home, `DSH_HOME`, temp state base or
 * data directory.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { WorkspaceIsolation, settingsInvalidWarning } from '../lib/isolation.js'
import { FlashTaskService } from '../lib/service.js'

/** Stored patches go to the durable data directory by default; keep them out of the real one. */
process.env.FLASH_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'flash-slots-data-')))

/** A fresh temporary directory, realpath'd so macOS `/var` vs `/private/var` cannot bite. */
function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

/**
 * A committed repository with an ignored build folder, and optionally a settings file.
 *
 * `secret-build/` is what a `copyExclude` test leaves out of the copy, and `deps/` is what a
 * setup step keeps; both are ignored, as the exclusion and the keep check require.
 */
function makeRepo({ settings } = {}) {
  const dir = tempDir('flash-slots-repo-')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# project\n')
  writeFileSync(join(dir, '.gitignore'), 'secret-build/\ndeps/\n')
  if (settings !== undefined) writeFileSync(join(dir, '.flash-agents.json'), JSON.stringify(settings))
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: dir })
  mkdirSync(join(dir, 'secret-build'))
  writeFileSync(join(dir, 'secret-build', 'out.o'), 'object\n')
  return dir
}

/** Write a settings file as an editor would, after the pool has read the old one. */
function writeSettings(repo, value) {
  writeFileSync(join(repo, '.flash-agents.json'), typeof value === 'string' ? value : JSON.stringify(value))
}

/** A setup step that installs into `deps/` and keeps it, the shape a `uv sync` step has. */
const KEEP_STEP = {
  run: [process.execPath, '-e', "require('fs').mkdirSync('deps',{recursive:true});require('fs').writeFileSync('deps/lib.txt','installed\\n')"],
  keep: ['deps'],
}

/** A pool over `repo` with a private state directory. */
function makePool(repo, { slots = 1, log, allowSlotSetup = false } = {}) {
  const stateDir = tempDir('flash-slots-state-')
  const isolation = new WorkspaceIsolation({ root: repo, slots, stateDir, allowSlotSetup, log })
  return { isolation, stateDir }
}

/**
 * Run one call in a slot the way the service does up to the worker: lease, prepare, setup.
 * @returns {Promise<{slot: object, setup: object[] | undefined}>}
 */
async function startCall(isolation) {
  const slot = await isolation.lease()
  isolation.prepare(slot)
  const setup = await isolation.runSetup(slot)
  return { slot, setup }
}

/** Every file below a directory, relative to it, sorted. */
function filesUnder(dir, prefix = '') {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...filesUnder(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out.sort()
}

/**
 * A call that timed out on `slot` after its worker filled the build cache: the work is
 * collected and the tree retired. `sessionStopped` is what the service passes once it shut
 * down every runtime rooted at the tree, which it does before every `retire`.
 * @returns {{orphan: string, artefact: string}} the retired tree and the cached file in it.
 */
function timeOutAfterBuilding(isolation, slot, { sessionStopped = true } = {}) {
  const target = isolation.slotEnvFor(slot).CARGO_TARGET_DIR
  mkdirSync(join(target, 'debug'), { recursive: true })
  writeFileSync(join(target, 'debug', 'libapp.rlib'), 'x'.repeat(4096))
  isolation.collect(slot)
  isolation.retire(slot, { sessionStopped })
  return { orphan: slot.orphans.at(-1), artefact: join('target', 'debug', 'libapp.rlib') }
}

/**
 * Prepare a leased slot while its retired tree refuses to give up its cache, the way a
 * Windows tree does while a stray build process still holds a file open. A directory that
 * cannot be written to fails the rename out of it with EACCES on any POSIX system.
 */
function prepareWhileTreeLocked(isolation, slot, orphan) {
  chmodSync(orphan, 0o555)
  try {
    isolation.prepare(slot)
  } finally {
    chmodSync(orphan, 0o755)
  }
}

/** The lock above needs a filesystem that enforces permissions on this user. */
const LOCK_SKIP = process.platform === 'win32' || process.getuid?.() === 0

const CACHE_SETTINGS = { slotEnv: { CARGO_TARGET_DIR: 'cache:target' }, slotSetup: [KEEP_STEP] }

test('the call after a timeout takes the retired tree’s build cache, and starts warm', async () => {
  const repo = makeRepo({ settings: CACHE_SETTINGS })
  const logs = []
  const { isolation } = makePool(repo, { allowSlotSetup: true, log: (line) => logs.push(line) })
  try {
    const { slot } = await startCall(isolation)
    const { orphan, artefact } = timeOutAfterBuilding(isolation, slot)
    isolation.release(slot)
    assert.ok(existsSync(join(orphan, '.flash-cache', 'setup')), 'the retired tree holds a setup stamp')

    // The retry is leased into the replacement slot at once and is prepared there.
    const before = logs.length
    const retry = await startCall(isolation)
    assert.equal(retry.slot, slot)
    const cache = join(slot.dir, '.flash-cache')
    assert.ok(existsSync(join(cache, artefact)), `the warm target moved: ${JSON.stringify(filesUnder(cache))}`)
    assert.equal(retry.slot.buildCacheEmpty, false, 'the call does not report a cold cache')
    assert.equal(logs.slice(before).some((line) => line.includes('empty build cache')), false)
    assert.match(
      logs.find((line) => line.startsWith('moved the build cache')) ?? '',
      new RegExp(`^moved the build cache of retired tree ${orphan} to ${slot.dir}$`),
    )
    // The stamps stayed behind, so the setup runs once in the new directory.
    assert.deepEqual(retry.setup.map((entry) => [entry.ran, entry.reason]), [[true, 'first run in this slot']])
    assert.equal(existsSync(join(orphan, '.flash-cache')), false, 'the cache left the retired tree')
    assert.ok(existsSync(orphan), 'the rest of the retired tree waits for the trim')
    isolation.release(retry.slot)
  } finally {
    isolation.close()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a tree retired while its runtime may still run keeps its build cache', async () => {
  const repo = makeRepo({ settings: CACHE_SETTINGS })
  const logs = []
  const { isolation } = makePool(repo, { log: (line) => logs.push(line) })
  try {
    const { slot } = await startCall(isolation)
    const { orphan, artefact } = timeOutAfterBuilding(isolation, slot, { sessionStopped: false })
    isolation.release(slot)
    const retry = await startCall(isolation)
    assert.equal(retry.slot.buildCacheEmpty, true)
    assert.ok(existsSync(join(orphan, '.flash-cache', artefact)), 'nothing was taken from a tree that may still be written')

    isolation.release(retry.slot)
    isolation.maxStateBytes = 1
    isolation.trim()
    assert.ok(logs.includes(`trim: not moving the build cache of retired tree ${orphan}: its runtimes were not shut down when it was retired`))
    assert.deepEqual(filesUnder(join(slot.dir, '.flash-cache')), [])
  } finally {
    isolation.close()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a cache the call cannot rename stays in the retired tree, and the trim keeps its old behaviour', { skip: LOCK_SKIP }, async () => {
  const repo = makeRepo({ settings: CACHE_SETTINGS })
  const logs = []
  const { isolation } = makePool(repo, { log: (line) => logs.push(line) })
  try {
    const { slot } = await startCall(isolation)
    const { orphan, artefact } = timeOutAfterBuilding(isolation, slot)
    isolation.release(slot)
    const retry = await isolation.lease()
    prepareWhileTreeLocked(isolation, retry, orphan)
    const failed = logs.filter((line) => line.startsWith(`could not move the build cache of retired tree ${orphan} to ${slot.dir} (`))
    assert.equal(failed.length, 1, JSON.stringify(logs))
    assert.ok(failed[0].endsWith('; it stays there until the tree is removed'), failed[0])
    assert.ok(existsSync(join(orphan, '.flash-cache', artefact)), 'the cache stayed where it was')
    assert.equal(retry.buildCacheEmpty, true, 'and this call honestly starts cold')

    // The retry is still running when the trim comes: nothing is moved under it, and the
    // retired tree goes as it always did.
    isolation.maxStateBytes = 1
    isolation.trim()
    assert.equal(existsSync(orphan), false, 'the retired tree is still removed')
    assert.deepEqual(filesUnder(join(retry.dir, '.flash-cache')), [], 'nothing was moved under the running call')
    assert.ok(logs.includes(`trim: not moving the build cache of retired tree ${orphan}: slot 0 is in use by a running call`))
    isolation.release(retry)
  } finally {
    isolation.close()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('trim moves a retired tree’s build cache into its idle slot', async () => {
  const repo = makeRepo({ settings: CACHE_SETTINGS })
  const logs = []
  const { isolation } = makePool(repo, { allowSlotSetup: true, log: (line) => logs.push(line) })
  try {
    const { slot } = await startCall(isolation)
    const { orphan, artefact } = timeOutAfterBuilding(isolation, slot)
    isolation.release(slot)

    // No call came between the retire and the trim.
    isolation.maxStateBytes = 1
    const result = isolation.trim()
    assert.equal(result.removedTrees, 1)
    assert.equal(existsSync(orphan), false, 'the rest of the retired tree is gone')
    const cache = join(slot.dir, '.flash-cache')
    assert.ok(existsSync(join(cache, artefact)), `the warm target moved: ${JSON.stringify(filesUnder(cache))}`)
    assert.equal(existsSync(join(cache, 'setup')), false, 'the stamps did not: what a step keeps may name the old path')
    assert.match(
      logs.find((line) => line.startsWith('trim: moved the build cache')) ?? '',
      new RegExp(`^trim: moved the build cache of retired tree ${orphan} to ${slot.dir}$`),
    )
    const next = await startCall(isolation)
    assert.equal(next.slot.buildCacheEmpty, false)
    assert.deepEqual(next.setup.map((entry) => [entry.ran, entry.reason]), [[true, 'first run in this slot']])
    isolation.release(next.slot)
  } finally {
    isolation.close()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('trim never overwrites a cache the current slot already has', { skip: LOCK_SKIP }, async () => {
  const repo = makeRepo({ settings: CACHE_SETTINGS })
  const logs = []
  const { isolation } = makePool(repo, { log: (line) => logs.push(line) })
  try {
    const { slot } = await startCall(isolation)
    const { orphan } = timeOutAfterBuilding(isolation, slot)
    isolation.release(slot)
    // A later call could not take the cache, built its own in the new directory and finished.
    const later = await isolation.lease()
    prepareWhileTreeLocked(isolation, later, orphan)
    writeFileSync(join(isolation.slotEnvFor(later).CARGO_TARGET_DIR, 'fresh.rlib'), 'new\n')
    isolation.collect(later)
    isolation.discard(later)
    isolation.release(later)

    isolation.maxStateBytes = 1
    isolation.trim()
    assert.equal(existsSync(orphan), false)
    assert.deepEqual(filesUnder(join(slot.dir, '.flash-cache')), ['target/fresh.rlib'])
    assert.ok(logs.includes(`trim: not moving the build cache of retired tree ${orphan}: ${slot.dir} already has a build cache of its own`))
  } finally {
    isolation.close()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a build cache the trim cannot rename is removed with its tree, and the log says so', { skip: LOCK_SKIP }, async () => {
  const repo = makeRepo({ settings: CACHE_SETTINGS })
  const logs = []
  const { isolation } = makePool(repo, { log: (line) => logs.push(line) })
  try {
    const { slot } = await startCall(isolation)
    const { orphan } = timeOutAfterBuilding(isolation, slot)
    isolation.release(slot)
    // A directory the rename cannot write into fails it the way another device would.
    chmodSync(slot.dir, 0o555)
    isolation.maxStateBytes = 1
    try {
      isolation.trim()
    } finally {
      chmodSync(slot.dir, 0o755)
    }
    assert.equal(existsSync(orphan), false)
    assert.equal(existsSync(join(slot.dir, '.flash-cache')), false)
    assert.ok(
      logs.some((line) => line.startsWith(`trim: could not move the build cache of retired tree ${orphan} to ${slot.dir} (`) && line.endsWith('removing it with the tree')),
      JSON.stringify(logs),
    )
  } finally {
    isolation.close()
    rmSync(repo, { recursive: true, force: true })
  }
})

/** A runtime stand-in that runs one worker per prompt and writes into its tree and cache. */
class FakeRuntime {
  constructor() {
    this.pid = 4343
    this.running = false
    this.cwd = undefined
    this.extraEnv = undefined
    this.boots = []
    this.shutdowns = 0
    this.prompts = []
    this.diagnostics = ''
    this.handlers = new Set()
    this.exitHandlers = new Set()
    /** Called with the prompt index before the worker runs; may return a promise to hold it. */
    this.onPrompt = undefined
    /** Whether the worker writes a build artefact into `CARGO_TARGET_DIR`, when it has one. */
    this.buildsIntoCache = true
  }

  start() {
    this.running = true
    return this.pid
  }

  async initialize(params) {
    this.cwd = params.cwd
    this.boots.push({ cwd: params.cwd, env: this.extraEnv })
    return { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' }
  }

  async prompt({ sessionId }) {
    const index = this.prompts.length
    this.prompts.push({ sessionId, cwd: this.cwd, sawSecretBuild: existsSync(join(this.cwd, 'secret-build')) })
    const hold = this.onPrompt?.(index)
    Promise.resolve(hold).then(() => this.#work(sessionId))
    return { messageId: `msg-${String(index)}` }
  }

  #work(sessionId) {
    writeFileSync(join(this.cwd, 'worker-output.txt'), 'written by the worker\n')
    const target = this.extraEnv?.CARGO_TARGET_DIR
    if (this.buildsIntoCache && target !== undefined) {
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'libapp.rlib'), 'built\n')
    }
    const child = `child-${sessionId}`
    this.emit('session.status', { sessionId, status: 'running' })
    this.emit('subagent.started', { parentSessionId: sessionId, childSessionId: child })
    this.emit('subagent.finished', {
      provider: 'flash',
      agentId: 'agent-0',
      parentSessionId: sessionId,
      childSessionId: child,
      status: 'ok',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'done' }],
    })
    this.emit('session.status', { sessionId, status: 'idle' })
  }

  onNotification(handler) {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  onExit(handler) {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
  }

  async shutdown() {
    this.shutdowns += 1
    this.running = false
  }

  emit(method, params) {
    for (const handler of this.handlers) handler(method, params)
  }
}

/** A service over `repo` whose runtimes are one `FakeRuntime`, with every directory private. */
function makeService(repo, { slots = 1, log = () => {}, ...overrides } = {}) {
  const runtime = new FakeRuntime()
  const stateDir = tempDir('flash-slots-svc-state-')
  const home = tempDir('flash-slots-home-')
  const service = new FlashTaskService({
    root: repo,
    home,
    env: { DSH_HOME: join(home, '.dsh') },
    clientFactory: (profileName, cwd, extraEnv) => {
      runtime.extraEnv = extraEnv
      return runtime
    },
    log,
    isolate: { slots, stateDir },
    honoursModelEnv: () => true,
    earlyRetryDelayMs: 0,
    ...overrides,
  })
  return { service, runtime, cleanup: () => [stateDir, home, repo].forEach((dir) => rmSync(dir, { recursive: true, force: true })) }
}

test('a call that starts with an empty build cache says so, and a warm one does not', async () => {
  const repo = makeRepo({ settings: { slotEnv: { CARGO_TARGET_DIR: 'cache:target' } } })
  const logs = []
  const { service, cleanup } = makeService(repo, { log: (line) => logs.push(line) })
  try {
    const cold = await service.flashTask({ task: 'build it', apply: 'discard' })
    assert.equal(cold.status, 'ok')
    assert.equal(cold.isolation.buildCacheEmpty, true)
    assert.equal(logs.filter((line) => /^slot 0 starts with an empty build cache in .*\.flash-cache: this call builds from cold$/.test(line)).length, 1)

    // The first worker built into the slot's cache, so the second call in the slot is warm.
    const warm = await service.flashTask({ task: 'build it again', apply: 'discard' })
    assert.equal(warm.status, 'ok')
    assert.equal(Object.hasOwn(warm.isolation, 'buildCacheEmpty'), false)
  } finally {
    await service.close()
    cleanup()
  }
})

test('a repository whose settings fill no cache never reports one as empty', async () => {
  const repo = makeRepo({ settings: { slotEnv: { CARGO_HOME: 'home:cargo', PORT: 'port:4100' } } })
  const logs = []
  const { service, cleanup } = makeService(repo, { log: (line) => logs.push(line) })
  try {
    const result = await service.flashTask({ task: 'build it', apply: 'discard' })
    assert.equal(result.status, 'ok')
    assert.equal(Object.hasOwn(result.isolation, 'buildCacheEmpty'), false)
    assert.equal(logs.some((line) => line.includes('empty build cache')), false)
  } finally {
    await service.close()
    cleanup()
  }
})

test('a changed copyExclude applies to the next call without a restart', async () => {
  const repo = makeRepo()
  const logs = []
  const { service, runtime, cleanup } = makeService(repo, { log: (line) => logs.push(line) })
  try {
    const before = await service.flashTask({ task: 'look', apply: 'discard' })
    assert.equal(before.status, 'ok')
    assert.equal(runtime.prompts[0].sawSecretBuild, true, 'nothing excludes it yet')

    writeSettings(repo, { copyExclude: ['secret-build'] })
    const after = await service.flashTask({ task: 'look again', apply: 'discard' })
    assert.equal(after.status, 'ok')
    assert.equal(runtime.prompts[1].sawSecretBuild, false, 'the new exclusion applied to this call')
    assert.equal(after.warnings, undefined, `the edit applied, so nothing needs saying: ${JSON.stringify(after.warnings)}`)
    assert.ok(logs.includes('settings reloaded: .flash-agents.json'), JSON.stringify(logs))
    assert.ok(logs.includes('settings: .flash-agents.json'))

    // An unchanged file is not read again: no second reload line.
    await service.flashTask({ task: 'once more', apply: 'discard' })
    assert.equal(logs.filter((line) => line.startsWith('settings reloaded:')).length, 1)
  } finally {
    await service.close()
    cleanup()
  }
})

test('a settings file that turns invalid keeps its last settings, and every call says so until it is fixed', async () => {
  const repo = makeRepo({ settings: { copyExclude: ['secret-build'] } })
  const { service, runtime, cleanup } = makeService(repo)
  try {
    writeSettings(repo, '{ "copyExclude": ["secret-build"], ')
    const broken = await service.flashTask({ task: 'look', apply: 'discard' })
    assert.equal(broken.status, 'ok')
    assert.equal(runtime.prompts[0].sawSecretBuild, false, 'the last good exclusion still applies')
    const warning = broken.warnings.find((line) => line.startsWith('.flash-agents.json could not be used: it is not valid JSON ('))
    assert.ok(warning, JSON.stringify(broken.warnings))
    assert.ok(warning.endsWith('. Calls keep the settings last read from it until it is fixed'), warning)

    // Still broken, so still said.
    const again = await service.flashTask({ task: 'look again', apply: 'discard' })
    assert.ok(again.warnings.includes(warning))

    writeSettings(repo, { copyExclude: [] })
    const fixed = await service.flashTask({ task: 'look once more', apply: 'discard' })
    assert.equal(fixed.warnings, undefined)
    assert.equal(runtime.prompts[2].sawSecretBuild, true, 'the fixed file applies')
  } finally {
    await service.close()
    cleanup()
  }
})

test('a settings file deleted and then written invalid does not claim to keep settings', async () => {
  const repo = makeRepo({ settings: { copyExclude: ['secret-build'] } })
  const { service, cleanup } = makeService(repo)
  try {
    // Deleted: the next call reads it as absent, which leaves nothing to fall back on.
    rmSync(join(repo, '.flash-agents.json'))
    const gone = await service.flashTask({ task: 'look', apply: 'discard' })
    assert.equal(gone.status, 'ok')

    writeSettings(repo, '{ "copyExclude": ["secret-build"], ')
    const broken = await service.flashTask({ task: 'look again', apply: 'discard' })
    const warning = broken.warnings.find((line) => line.startsWith('.flash-agents.json could not be used: '))
    assert.ok(warning, JSON.stringify(broken.warnings))
    assert.ok(warning.endsWith('. None of its settings apply until it is fixed'), warning)
  } finally {
    await service.close()
    cleanup()
  }
})

test('the invalid-settings warning says when a file never had settings to keep', () => {
  assert.equal(
    settingsInvalidWarning('.flash-agents.local.json', 'the settings must be a JSON object', { kept: false }),
    '.flash-agents.local.json could not be used: the settings must be a JSON object. None of its settings apply until it is fixed',
  )
})

test('a call already running keeps the settings it started with while another call reloads them', async () => {
  const repo = makeRepo({ settings: { copyExclude: ['secret-build'] } })
  const { service, runtime, cleanup } = makeService(repo, { slots: 2 })
  let releaseFirst
  const firstHeld = new Promise((resolve) => {
    releaseFirst = resolve
  })
  runtime.onPrompt = (index) => (index === 0 ? firstHeld : undefined)
  try {
    const first = service.flashTask({ task: 'long job', apply: 'discard' })
    for (let wait = 0; wait < 400 && runtime.prompts.length === 0; wait += 1) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(runtime.prompts.length, 1, 'the first call is running')
    const running = service.isolation.slots.find((slot) => slot.busy)
    const startedWith = running.settings

    // Edited while the first call runs: the second call sees the edit, then the file breaks.
    writeSettings(repo, { copyExclude: [] })
    const second = await service.flashTask({ task: 'quick job', apply: 'discard' })
    assert.equal(second.status, 'ok')
    assert.equal(runtime.prompts[1].sawSecretBuild, true, 'the second call copied with the new settings')
    writeSettings(repo, 'not json')
    const third = await service.flashTask({ task: 'another quick job', apply: 'discard' })
    assert.ok(third.warnings.some((line) => line.startsWith('.flash-agents.json could not be used')))

    releaseFirst()
    const result = await first
    assert.equal(result.status, 'ok')
    assert.equal(runtime.prompts[0].sawSecretBuild, false, 'the first copy was made with its own settings')
    assert.equal(running.settings, startedWith, 'its slot still holds the settings it leased with')
    assert.deepEqual(startedWith.copyExclude.includes('secret-build'), true)
    assert.equal(result.warnings, undefined, `the breakage came after it started: ${JSON.stringify(result.warnings)}`)
  } finally {
    releaseFirst()
    await service.close()
    cleanup()
  }
})

test('a changed slotEnv restarts the slot’s idle runtime, so the next call’s commands see it', async () => {
  const repo = makeRepo({ settings: { slotEnv: { BUILD_MODE: 'value:debug' } } })
  const logs = []
  const { service, runtime, cleanup } = makeService(repo, { log: (line) => logs.push(line) })
  try {
    await service.flashTask({ task: 'build it', apply: 'discard' })
    assert.equal(runtime.boots.length, 1)
    assert.equal(runtime.boots[0].env.BUILD_MODE, 'debug')

    // Unchanged settings reuse the runtime.
    await service.flashTask({ task: 'build it again', apply: 'discard' })
    assert.equal(runtime.boots.length, 1)

    writeSettings(repo, { slotEnv: { BUILD_MODE: 'value:release' } })
    const result = await service.flashTask({ task: 'build for release', apply: 'discard' })
    assert.equal(result.status, 'ok')
    assert.equal(runtime.shutdowns, 1, 'the runtime with the old environment was shut down')
    assert.equal(runtime.boots.length, 2)
    assert.equal(runtime.boots[1].env.BUILD_MODE, 'release')
    assert.ok(logs.some((line) => /^restarted the .* runtime on .*: slotEnv changed \(BUILD_MODE\)$/.test(line)), JSON.stringify(logs))
    assert.equal(result.warnings, undefined)
  } finally {
    await service.close()
    cleanup()
  }
})

test('the retry after a timed-out call starts with the warm cache the timed-out worker built', async () => {
  const repo = makeRepo({ settings: { slotEnv: { CARGO_TARGET_DIR: 'cache:target' } } })
  const logs = []
  const { service, runtime, cleanup } = makeService(repo, { log: (line) => logs.push(line), taskTimeoutMs: 300 })
  // The first worker is mid-build when the call's budget runs out: its target is warm and it
  // never reports back. The retry's worker finishes normally.
  runtime.onPrompt = (index) => {
    if (index !== 0) return undefined
    writeFileSync(join(runtime.extraEnv.CARGO_TARGET_DIR, 'libdep.rlib'), 'x'.repeat(4096))
    return new Promise(() => {})
  }
  try {
    await assert.rejects(service.flashTask({ task: 'build it', apply: 'discard' }), (error) => error.code === 'TIMEOUT')
    assert.equal(runtime.shutdowns, 1, 'the orphaned session’s runtime was shut down before the retire')
    const slot = service.isolation.slots[0]
    const [orphan] = slot.orphans
    assert.ok(slot.stoppedOrphans.has(orphan))

    const retry = await service.flashTask({ task: 'build it again', apply: 'discard' })
    assert.equal(retry.status, 'ok')
    assert.equal(Object.hasOwn(retry.isolation, 'buildCacheEmpty'), false, JSON.stringify(retry.isolation))
    assert.ok(existsSync(join(slot.dir, '.flash-cache', 'target', 'libdep.rlib')), 'the warm artefact is in the new directory')
    assert.ok(logs.some((line) => line.startsWith(`moved the build cache of retired tree ${orphan} to ${slot.dir}`)), JSON.stringify(logs))
  } finally {
    await service.close()
    cleanup()
  }
})
