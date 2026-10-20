/**
 * Prerequisite-check tests: nearly every effect is injected, so no real binary is
 * run and no network endpoint is touched. Each scenario is one fake command table.
 * The exceptions are the two pty-probe tests near the end: one really starts a
 * shell through the globally installed node-pty, one uses a stand-in so the probe
 * script's success path also runs where the host forbids allocating a pty.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { CHECK_IDS, formatChecks, profileHonoursModelEnv, resolveDshHome, runChecks } from '../lib/doctor.js'

/** Look up one check in a report by id. @param {object} result @param {string} id */
function find(result, id) {
  return result.checks.find((check) => check.id === id)
}

/** The fake install paths the native-module scenarios are built from. */
const DSH_DIR = '/fake/global/lib/node_modules/@deepseek-ai/dsh'
const DSH_ENTRY = `${DSH_DIR}/lib/bin.js`
const DSH_MANIFEST = `${DSH_DIR}/package.json`
const NODE_PTY_DIR = `${DSH_DIR}/node_modules/node-pty`
const NODE_PTY_MANIFEST = `${NODE_PTY_DIR}/package.json`

/** A fake harness home whose installed service profile honours FLASH_ROUTE_MODEL. */
const FAKE_DSH_HOME = '/fake/home/.dsh'
const FAKE_PROFILE_PATCH = `${FAKE_DSH_HOME}/profiles/flash-service/cordis.patch.yml`
const HONOURING_PATCH = 'agent-default-model:\n  config:\n    model: !!js process.env.FLASH_ROUTE_MODEL || "deepseek-v4.1-flash:cloud"\n'

/**
 * A filesystem probe over an in-memory tree, so the native-module check can run
 * without a real harness install.
 *
 * `files` maps an absolute path to its contents (or null for a binary),
 * `executables` lists the paths that also carry the execute bit, `realpaths`
 * maps a launcher path to the entry it resolves to, and `resolve` maps one
 * `request from fromFile` key to the manifest that resolves it.
 *
 * @param {object} [tree] - the in-memory tree.
 * @returns {{probe: object, resolved: Array<{request: string, fromFile: string}>}} the probe and its call log.
 */
function fakeFs({ files = {}, executables = [], realpaths = {}, resolve = {} } = {}) {
  const resolved = []
  return {
    probe: {
      realpath: (path) => {
        if (path in realpaths) return realpaths[path]
        throw new Error(`ENOENT: no such file or directory, realpath '${path}'`)
      },
      exists: (path) => path in files,
      executable: (path) => executables.includes(path),
      readText: (path) => {
        if (!(path in files)) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
        return files[path]
      },
      resolvePackage: (request, fromFile) => {
        resolved.push({ request, fromFile })
        const key = `${request} from ${fromFile}`
        if (key in resolve) return resolve[key]
        throw new Error(`Cannot find module '${request}' from '${fromFile}'`)
      },
    },
    resolved,
  }
}

/**
 * One fake harness install for the native-module check.
 *
 * @param {object} [spec] - which native pieces exist.
 * @param {'prebuild'|'build'|'none'} [spec.pty] - where the pty binary lives (default 'prebuild').
 * @param {string} [spec.binary] - the addon file to place (default `pty.node`, or `conpty.node` on win32).
 * @param {'executable'|'present'|'missing'} [spec.helper] - state of darwin's spawn-helper (default 'executable').
 * @param {boolean} [spec.locateDsh] - false to model an install that cannot be found (default true).
 * @param {boolean} [spec.resolveNodePty] - false to model node-pty that cannot be resolved (default true).
 * @param {string} [spec.platform] - platform for the prebuild directory (default 'darwin').
 * @param {string} [spec.arch] - architecture for the prebuild directory (default 'arm64').
 * @param {{command: string, prefix: string[]}} [spec.launcher] - launcher to hand the check (default dsh on PATH).
 * @param {string} [spec.entry] - the launcher path that resolves to the install (default the launcher command).
 * @returns {object} `fs`, `platform`, `arch` and `launcher` to merge into the check options.
 */
function nativeInstall(spec = {}) {
  const platform = spec.platform ?? 'darwin'
  const arch = spec.arch ?? 'arm64'
  const launcher = spec.launcher ?? { command: 'dsh', prefix: [] }
  const entry = spec.entry ?? launcher.command
  const locateDsh = spec.locateDsh ?? true
  const resolveNodePty = spec.resolveNodePty ?? true
  const pty = spec.pty ?? 'prebuild'
  const binary = spec.binary ?? (platform === 'win32' ? 'conpty.node' : 'pty.node')
  const helper = spec.helper ?? 'executable'
  const prebuildDir = `${NODE_PTY_DIR}/prebuilds/${platform}-${arch}`
  const buildDir = `${NODE_PTY_DIR}/build/Release`
  const loadedDir = pty === 'build' ? buildDir : prebuildDir
  const files = { [FAKE_PROFILE_PATCH]: HONOURING_PATCH }
  const executables = []
  if (locateDsh) files[DSH_MANIFEST] = JSON.stringify({ name: '@deepseek-ai/dsh' })
  if (pty === 'prebuild') files[`${prebuildDir}/${binary}`] = null
  if (pty === 'build') files[`${buildDir}/${binary}`] = null
  if (pty !== 'none' && platform === 'darwin' && helper !== 'missing') {
    files[`${loadedDir}/spawn-helper`] = null
    if (helper === 'executable') executables.push(`${loadedDir}/spawn-helper`)
  }
  const resolve = {}
  if (locateDsh && resolveNodePty) resolve[`node-pty/package.json from ${DSH_MANIFEST}`] = NODE_PTY_MANIFEST
  const { probe } = fakeFs({
    files,
    executables,
    realpaths: locateDsh ? { [entry]: DSH_ENTRY } : {},
    resolve,
  })
  return { fs: probe, platform, arch, launcher }
}

/**
 * Build fully injected run/probe/generate fakes for one scenario.
 *
 * The node probe (the command named by `nodePath`) succeeds by default, so a
 * working environment reports nine ok checks; a scenario makes it fail by naming
 * a `ptyProbe` result. `npm` answers "not found" by default, which is the state
 * in which no npm-11 hint can be justified.
 *
 * @param {object} [behaviors] - per-command results and the daemon probe answer.
 * @param {object} [options] - extra options to merge into the injected set.
 * @returns {{options: object, calls: Array<{command: string, args: string[]}>}} the fakes plus a call log.
 */
function fakeOptions(behaviors = {}, options = {}) {
  const dsh = behaviors.dsh ?? { status: 0, stdout: '0.2.0-rc.2\n', stderr: '' }
  const profileDump = behaviors.profileDump ?? { status: 0, stdout: '', stderr: '' }
  const ollamaShow = behaviors.ollamaShow ?? { status: 0, stdout: '', stderr: '' }
  const npm = behaviors.npm ?? { status: 1, stdout: '', stderr: 'npm: not found' }
  const ptyProbe = behaviors.ptyProbe ?? { status: 0, stdout: 'flash-pty-ok\r\n', stderr: '' }
  const generate = behaviors.generate ?? (async () => ({ ok: true, status: 200, ms: 42 }))
  const git = behaviors.git ?? { status: 0, stdout: 'git version 2.0.0\n', stderr: '' }
  const zstd = behaviors.zstd ?? { status: 0, stdout: 'zstd 1.5.5\n', stderr: '' }
  const daemon = behaviors.daemon ?? true
  const nodePath = options.nodePath ?? '/fake/node'
  const calls = []
  const run = (command, args) => {
    calls.push({ command, args })
    if (command === nodePath) return ptyProbe
    if (command === 'dsh') return args[0] === '--version' ? dsh : profileDump
    if (command === 'ollama') return behaviors.ollamaShowFor?.(args[1]) ?? ollamaShow
    if (command === 'npm' || (command === 'cmd.exe' && args.at(-1) === 'npm --version')) return npm
    if (command === 'git') return git
    if (command === 'zstd') return zstd
    return { status: 1, stdout: '', stderr: 'not found' }
  }
  const native = nativeInstall()
  return { options: { run, probe: async () => daemon, generate, nodePath, nodeVersion: '22.19.0', dshHome: FAKE_DSH_HOME, ...native, ...options }, calls }
}

test('reports ten ok checks for a fully working environment', async () => {
  const { options } = fakeOptions()
  const result = await runChecks(options)
  assert.equal(result.checks.length, 10)
  assert.deepEqual(result.checks.map((check) => check.id), [...CHECK_IDS])
  assert.ok(result.checks.every((check) => check.status === 'ok'))
  assert.equal(result.ok, true)
  assert.equal(result.failures, 0)
  assert.equal(result.warnings, 0)
  assert.match(find(result, 'model').detail, /answered a one-token request/)
})

test('fails when dsh is missing and downgrades the version check', async () => {
  const { options } = fakeOptions({ dsh: { status: 1, stdout: '', stderr: 'not found' } })
  const result = await runChecks(options)
  const dsh = find(result, 'dsh')
  const version = find(result, 'dsh-version')
  assert.equal(dsh.status, 'fail')
  assert.match(dsh.fix, /@deepseek-ai\/dsh/)
  assert.equal(version.status, 'warn')
  assert.match(version.detail, /could not be determined/)
  assert.equal(result.ok, false)
  assert.equal(result.failures, 1)
  assert.equal(result.warnings, 2)
})

test('reports why the launcher could not be found, using the server resolver', async () => {
  const { options, calls } = fakeOptions({}, { launcher: undefined, env: { PATH: '/nonexistent' } })
  const result = await runChecks(options)
  const dsh = find(result, 'dsh')
  assert.equal(dsh.status, 'fail')
  assert.match(dsh.detail, /cannot find the dsh launcher/)
  assert.equal(calls.filter((entry) => entry.command === 'dsh').length, 0)
})

test('runs dsh through the launcher, prefix included', async () => {
  const seen = []
  const { options } = fakeOptions({}, {
    launcher: { command: '/usr/bin/node', prefix: ['/opt/dsh/lib/bin.js'] },
    run: (command, args) => {
      seen.push([command, ...args])
      return { status: 0, stdout: args.includes('--version') ? '0.2.0-rc.2\n' : '', stderr: '' }
    },
  })
  const result = await runChecks(options)
  assert.equal(find(result, 'dsh-version').status, 'ok')
  // The pty probe runs between the two dsh calls, so only the launcher calls are compared.
  const dshCalls = seen.filter((args) => args.includes('/opt/dsh/lib/bin.js'))
  assert.deepEqual(dshCalls[0], ['/usr/bin/node', '/opt/dsh/lib/bin.js', '--version'])
  assert.deepEqual(dshCalls[1], ['/usr/bin/node', '/opt/dsh/lib/bin.js', '--profile', 'flash-service', '--dump-config'])
})

test('pins dsh: exact is ok, the same release line warns, another line fails', async () => {
  const status = async (stdout) => find(await runChecks(fakeOptions({ dsh: { status: 0, stdout, stderr: '' } }).options), 'dsh-version')
  assert.equal((await status('0.2.0-rc.2\n')).status, 'ok')
  const sameLine = await status('0.2.1-alpha.3\n')
  assert.equal(sameLine.status, 'warn')
  assert.equal(sameLine.fix, 'npm i -g @deepseek-ai/dsh@0.2.0-rc.2')
  for (const other of ['0.1.5-rc.3\n', '0.3.0\n']) {
    const version = await status(other)
    assert.equal(version.status, 'fail', other)
    assert.equal(version.fix, 'npm i -g @deepseek-ai/dsh@0.2.0-rc.2')
  }
})

test('takes the pinned version from the options', async () => {
  const { options } = fakeOptions({ dsh: { status: 0, stdout: '0.1.5-rc.3\n', stderr: '' } }, { dshVersion: '0.1.5-rc.3' })
  const result = await runChecks(options)
  assert.equal(find(result, 'dsh-version').status, 'ok')
})

test('a dsh that prints no version points at Node, not at reinstalling dsh', async () => {
  const { options } = fakeOptions({ dsh: { status: 0, stdout: '', stderr: '' } })
  const result = await runChecks(options)
  const version = find(result, 'dsh-version')
  assert.equal(version.status, 'fail')
  assert.match(version.detail, /Node/)
  assert.match(version.fix, /^install Node 22\.19/)
})

test('dsh native modules: a prebuilt pty.node is ok', async () => {
  const result = await runChecks(fakeOptions({}, nativeInstall()).options)
  const native = find(result, 'dsh-native')
  assert.equal(native.status, 'ok')
  assert.match(native.detail, /prebuilds\/darwin-arm64\/pty\.node/)
})

test('dsh native modules: a compiled build/Release pty.node is ok too', async () => {
  const result = await runChecks(fakeOptions({}, nativeInstall({ pty: 'build' })).options)
  const native = find(result, 'dsh-native')
  assert.equal(native.status, 'ok')
  assert.match(native.detail, /build\/Release\/pty\.node/)
})

test('dsh native modules: a missing pty.node fails and points at node-gyp', async () => {
  const result = await runChecks(fakeOptions({}, nativeInstall({ pty: 'none' })).options)
  const native = find(result, 'dsh-native')
  assert.equal(native.status, 'fail')
  assert.ok(native.detail.includes(NODE_PTY_DIR), native.detail)
  assert.match(native.fix, /install scripts allowed/)
  assert.match(native.fix, /node-gyp rebuild/)
  assert.ok(native.fix.includes(NODE_PTY_DIR), native.fix)
  assert.equal(result.ok, false)
})

test('dsh native modules: a non-executable spawn-helper fails with a chmod fix', async () => {
  const result = await runChecks(fakeOptions({}, nativeInstall({ pty: 'prebuild', helper: 'present' })).options)
  const native = find(result, 'dsh-native')
  assert.equal(native.status, 'fail')
  assert.match(native.detail, /not executable/)
  assert.equal(native.fix, `chmod +x ${NODE_PTY_DIR}/prebuilds/darwin-arm64/spawn-helper`)
  assert.equal(result.ok, false)
})

test('dsh native modules: an unlocatable install only warns', async () => {
  const result = await runChecks(fakeOptions({}, nativeInstall({ locateDsh: false })).options)
  const native = find(result, 'dsh-native')
  assert.equal(native.status, 'warn')
  assert.match(native.detail, /could not locate/)
  assert.equal(find(result, 'dsh').status, 'ok')
})

test('dsh native modules: unresolvable node-pty only warns, naming the reason', async () => {
  const result = await runChecks(fakeOptions({}, nativeInstall({ resolveNodePty: false })).options)
  const native = find(result, 'dsh-native')
  assert.equal(native.status, 'warn')
  assert.match(native.detail, /node-pty could not be resolved/)
  assert.match(native.detail, /Cannot find module/)
  assert.equal(find(result, 'dsh').status, 'ok')
})

test('dsh native modules: a Windows shim resolves the JS entry behind it', async () => {
  const entry = 'C:/Users/dev/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js'
  const spec = nativeInstall({
    platform: 'win32',
    arch: 'x64',
    launcher: { command: '/nonexistent/node', prefix: [entry] },
    entry,
  })
  // The launcher command is not `dsh` here, so every command answers the same way.
  const run = (command, args) => ({ status: 0, stdout: args.includes('--version') ? '0.2.0-rc.2\n' : '', stderr: '' })
  const result = await runChecks(fakeOptions({}, { ...spec, run }).options)
  const native = find(result, 'dsh-native')
  assert.equal(native.status, 'ok')
  assert.match(native.detail, /win32-x64\/conpty\.node/)
})

test('dsh native modules: a Windows prebuild ships conpty.node, not pty.node', async () => {
  const { options } = fakeOptions({}, nativeInstall({ platform: 'win32', arch: 'x64' }))
  const result = await runChecks(options)
  const native = find(result, 'dsh-native')
  assert.equal(native.status, 'ok')
  assert.match(native.detail, /prebuilds\/win32-x64\/conpty\.node/)
})

test('dsh native modules: a win32 build/Release conpty.node is ok too', async () => {
  const { options } = fakeOptions({}, nativeInstall({ platform: 'win32', arch: 'x64', pty: 'build' }))
  const result = await runChecks(options)
  const native = find(result, 'dsh-native')
  assert.equal(native.status, 'ok')
  assert.match(native.detail, /build\/Release\/conpty\.node/)
})

test('dsh native modules: a win32 layout without conpty.node fails and never suggests node-gyp', async () => {
  for (const spec of [
    { platform: 'win32', arch: 'x64', binary: 'pty.node' },
    { platform: 'win32', arch: 'x64', pty: 'none' },
  ]) {
    const { options } = fakeOptions({}, nativeInstall(spec))
    const result = await runChecks(options)
    const native = find(result, 'dsh-native')
    assert.equal(native.status, 'fail')
    assert.match(native.detail, /no conpty\.node/)
    assert.ok(native.detail.includes(`${NODE_PTY_DIR}/prebuilds/win32-x64`), native.detail)
    assert.ok(native.detail.includes(`${NODE_PTY_DIR}/build/Release`), native.detail)
    assert.match(native.fix, /install scripts allowed/)
    assert.doesNotMatch(native.fix, /node-gyp/)
    assert.equal(result.ok, false)
  }
})

test('dsh native modules: the npm-11 clause follows the npm that is actually installed', async () => {
  const failingFix = async (npm) =>
    find(await runChecks(fakeOptions({ npm }, nativeInstall({ pty: 'none' })).options), 'dsh-native').fix
  const eleven = await failingFix({ status: 0, stdout: '11.19.1\n', stderr: '' })
  assert.match(eleven, /npm 11 blocks dependency install scripts by default/)
  assert.match(eleven, /node-gyp rebuild/)
  const ten = await failingFix({ status: 0, stdout: '10.9.8\n', stderr: '' })
  assert.doesNotMatch(ten, /npm \d+ blocks/)
  assert.match(ten, /install scripts allowed/)
  const missing = await failingFix({ status: 1, stdout: '', stderr: 'npm: not found' })
  assert.doesNotMatch(missing, /npm \d+ blocks/)
  assert.match(missing, /install scripts allowed/)
})

test('dsh native modules: Windows asks npm for its version through cmd.exe', async () => {
  const { options, calls } = fakeOptions(
    { npm: { status: 0, stdout: '11.19.1\n', stderr: '' } },
    nativeInstall({ platform: 'win32', arch: 'x64', pty: 'none' }),
  )
  const result = await runChecks(options)
  const native = find(result, 'dsh-native')
  assert.match(native.fix, /npm 11 blocks dependency install scripts by default/)
  assert.ok(calls.some((entry) => entry.command === 'cmd.exe' && entry.args.at(-1) === 'npm --version'), JSON.stringify(calls))
  assert.ok(!calls.some((entry) => entry.command === 'npm'), JSON.stringify(calls))
  assert.doesNotMatch(native.fix, /node-gyp/)
})

test('dsh native modules: the pty probe runs the child script through nodePath', async () => {
  const { options, calls } = fakeOptions({}, nativeInstall())
  const result = await runChecks(options)
  const probe = calls.find((entry) => entry.command === '/fake/node')
  assert.ok(probe, JSON.stringify(calls))
  assert.equal(probe.args[0], '-e')
  assert.match(probe.args[1], /createRequire/)
  assert.match(probe.args[1], /flash-pty-ok/)
  assert.match(probe.args[1], /10_000/)
  assert.equal(probe.args[2], NODE_PTY_DIR)
  assert.equal(probe.args[3], 'darwin')
  assert.match(find(result, 'dsh-native').detail, /started a shell through/)
})

test('dsh native modules: a probe that cannot start a shell fails with the stderr line', async () => {
  const stderr = 'Error: posix_spawn failed\nat load (node:internal)\n'
  const { options } = fakeOptions({ ptyProbe: { status: 2, stdout: '', stderr } })
  const result = await runChecks(options)
  const native = find(result, 'dsh-native')
  assert.equal(native.status, 'fail')
  assert.equal(native.detail, 'node-pty is installed but could not start a shell: Error: posix_spawn failed')
  assert.match(native.fix, /reinstall @deepseek-ai\/dsh/)
  assert.equal(result.ok, false)
})

test('dsh native modules: a silent probe failure names "no output"', async () => {
  const { options } = fakeOptions({ ptyProbe: { status: 1, stdout: '', stderr: '' } })
  const native = find(await runChecks(options), 'dsh-native')
  assert.equal(native.status, 'fail')
  assert.match(native.detail, /could not start a shell: no output/)
})

test('dsh native modules: the probe is not run when the binary is missing', async () => {
  const { options, calls } = fakeOptions({}, nativeInstall({ pty: 'none' }))
  await runChecks(options)
  assert.equal(calls.filter((entry) => entry.command === '/fake/node').length, 0)
})

test('dsh native modules: the probe is not run when the spawn-helper is unusable', async () => {
  const { options, calls } = fakeOptions({}, nativeInstall({ pty: 'prebuild', helper: 'present' }))
  const native = find(await runChecks(options), 'dsh-native')
  assert.equal(native.status, 'fail')
  assert.equal(calls.filter((entry) => entry.command === '/fake/node').length, 0)
})

/** The globally installed dsh and the node-pty it uses, or undefined when either is absent. */
function globalDsh() {
  const npm = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' })
  if (npm.status !== 0) return undefined
  const root = (npm.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .pop()
  if (root === undefined) return undefined
  const dshDir = join(root, '@deepseek-ai', 'dsh')
  if (!existsSync(join(dshDir, 'package.json'))) return undefined
  try {
    const manifest = createRequire(join(dshDir, 'package.json')).resolve('node-pty/package.json')
    return { dshDir, nodePtyDir: dirname(manifest) }
  } catch {
    return undefined
  }
}

test('the pty probe script really starts a shell through the installed node-pty', async (t) => {
  const found = globalDsh()
  if (found === undefined) {
    t.skip('the globally installed @deepseek-ai/dsh and its node-pty could not be located')
    return
  }
  const realFs = {
    realpath: (path) => realpathSync(path),
    exists: (path) => existsSync(path),
    executable: (path) => {
      try {
        accessSync(path, constants.X_OK)
        return true
      } catch {
        return false
      }
    },
    readText: (path) => readFileSync(path, 'utf8'),
    resolvePackage: (request, fromFile) => createRequire(fromFile).resolve(request),
  }
  const realProbe = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 })
    return {
      status: typeof result.status === 'number' ? result.status : 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? (result.error instanceof Error ? result.error.message : ''),
    }
  }
  const entry = join(found.dshDir, 'lib', 'bin.js')
  const { options: base } = fakeOptions({}, {
    fs: realFs,
    platform: process.platform,
    arch: process.arch,
    nodePath: process.execPath,
    launcher: { command: entry, prefix: [] },
  })
  const options = {
    ...base,
    run: (command, args) => (command === process.execPath ? realProbe(command, args) : base.run(command === entry ? 'dsh' : command, args)),
  }
  const result = await runChecks(options)
  const native = find(result, 'dsh-native')
  if (native.status === 'fail' && /posix_openpt|Operation not permitted|EPERM/.test(native.detail)) {
    // A sandbox that denies /dev/ptmx cannot run this probe at all; the assertion
    // below still holds wherever the host lets a process allocate a pty.
    t.skip(`this host forbids allocating a pty: ${native.detail}`)
    return
  }
  assert.equal(native.status, 'ok', native.detail)
  assert.match(native.detail, /^node-pty started a shell through /)
  assert.ok(native.detail.includes(found.nodePtyDir), native.detail)
})

test('the pty probe script exits 0 when the shell prints the marker', async () => {
  // A stand-in node-pty, so the success path of the probe script can be exercised
  // even where the host forbids allocating a real pty.
  const root = mkdtempSync(join(tmpdir(), 'flash-pty-probe-'))
  try {
    const nodePtyDir = join(root, 'node-pty')
    const dshDir = join(root, 'dsh')
    mkdirSync(nodePtyDir)
    mkdirSync(join(dshDir, 'lib'), { recursive: true })
    const nodePtyManifest = join(nodePtyDir, 'package.json')
    writeFileSync(nodePtyManifest, JSON.stringify({ name: 'node-pty', version: '0.0.0', main: 'index.js' }))
    writeFileSync(
      join(nodePtyDir, 'index.js'),
      [
        "const { spawn } = require('node:child_process')",
        'exports.spawn = (command, args, options) => {',
        '  const child = spawn(command, args, { cwd: options.cwd })',
        '  const dataHandlers = []',
        '  const exitHandlers = []',
        "  let output = ''",
        "  child.stdout.on('data', (chunk) => {",
        '    output += chunk',
        '    for (const handler of dataHandlers) handler(String(chunk))',
        '  })',
        "  child.on('exit', (code) => {",
        '    for (const handler of exitHandlers) handler({ exitCode: code ?? 1 })',
        '  })',
        '  return {',
        "    onData: (handler) => { dataHandlers.push(handler); if (output !== '') handler(output) },",
        '    onExit: (handler) => { exitHandlers.push(handler) },',
        '  }',
        '}',
      ].join('\n'),
    )
    const dshManifest = join(dshDir, 'package.json')
    const entry = join(dshDir, 'lib', 'bin.js')
    const prebuildDir = join(nodePtyDir, 'prebuilds', `${process.platform}-${process.arch}`)
    const files = {
      [dshManifest]: JSON.stringify({ name: '@deepseek-ai/dsh' }),
      [entry]: '',
      [nodePtyManifest]: JSON.stringify({ name: 'node-pty' }),
      [join(prebuildDir, process.platform === 'win32' ? 'conpty.node' : 'pty.node')]: null,
    }
    const executables = []
    if (process.platform === 'darwin') {
      files[join(prebuildDir, 'spawn-helper')] = null
      executables.push(join(prebuildDir, 'spawn-helper'))
    }
    const { probe } = fakeFs({
      files,
      executables,
      realpaths: { [entry]: entry },
      resolve: { [`node-pty/package.json from ${dshManifest}`]: nodePtyManifest },
    })
    const { options: base } = fakeOptions({}, {
      fs: probe,
      platform: process.platform,
      arch: process.arch,
      nodePath: process.execPath,
      launcher: { command: entry, prefix: [] },
    })
    const options = {
      ...base,
      run: (command, args) => {
        if (command !== process.execPath) return base.run(command === entry ? 'dsh' : command, args)
        const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 })
        return {
          status: typeof result.status === 'number' ? result.status : 1,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? (result.error instanceof Error ? result.error.message : ''),
        }
      },
    }
    const native = find(await runChecks(options), 'dsh-native')
    assert.equal(native.status, 'ok', native.detail)
    assert.match(native.detail, /started a shell through .*pty\.node$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when the service profile does not compose', async () => {
  const { options, calls } = fakeOptions({ profileDump: { status: 1, stdout: '', stderr: 'no profile' } })
  const result = await runChecks(options)
  const profile = find(result, 'profile')
  assert.equal(profile.status, 'fail')
  assert.equal(profile.fix, 'node install.mjs')
  assert.equal(result.ok, false)
  const dump = calls.find((entry) => entry.command === 'dsh' && entry.args[0] === '--profile')
  assert.deepEqual(dump.args, ['--profile', 'flash-service', '--dump-config'])
})

test('fails when a patch entry is missing even though dsh exits 0', async () => {
  const stderr = 'dsh: [/home/u/.dsh/profiles/flash-service/cordis.patch.yml] patch: entry "workflow-worker-thread" not found\n'
  const { options } = fakeOptions({ profileDump: { status: 0, stdout: '# == @deepseek-ai/dsh-base\n', stderr } })
  const result = await runChecks(options)
  const profile = find(result, 'profile')
  assert.equal(profile.status, 'fail')
  assert.match(profile.detail, /entry "workflow-worker-thread" not found/)
  assert.equal(result.ok, false)
})

test('fails when the Ollama daemon is unreachable', async () => {
  const { options } = fakeOptions({ daemon: false })
  const result = await runChecks(options)
  const ollama = find(result, 'ollama')
  assert.equal(ollama.status, 'fail')
  assert.equal(ollama.fix, 'ollama serve')
  assert.equal(find(result, 'model').status, 'warn')
  assert.equal(result.ok, false)
})

test('fails when the model is missing and names it in the fix', async () => {
  const { options } = fakeOptions({ ollamaShow: { status: 1, stdout: '', stderr: 'not found' } })
  const result = await runChecks(options)
  const model = find(result, 'model')
  assert.equal(model.status, 'fail')
  assert.match(model.fix, /ollama pull deepseek-v4\.1-flash:cloud/)
  assert.equal(result.ok, false)
})

test('mentions signin for a :cloud model', async () => {
  const { options } = fakeOptions({ ollamaShow: { status: 1, stdout: '', stderr: '' } })
  const result = await runChecks(options)
  assert.match(find(result, 'model').detail, /ollama signin/)
})

test('model: a cloud model that answers reports the seconds it took', async () => {
  const asked = []
  const generate = async (model) => {
    asked.push(model)
    return { ok: true, status: 200, ms: 1234 }
  }
  const result = await runChecks(fakeOptions({}, { generate }).options)
  const model = find(result, 'model')
  assert.equal(model.status, 'ok')
  assert.equal(model.detail, 'deepseek-v4.1-flash:cloud is available and answered a one-token request in 1.2 s')
  assert.deepEqual(asked, ['deepseek-v4.1-flash:cloud'])
  assert.equal(result.ok, true)
})

test('model: a cloud that refuses the request fails with ollama signin', async () => {
  const generate = async () => ({ ok: false, status: 401, error: 'unauthorized' })
  const result = await runChecks(fakeOptions({}, { generate }).options)
  const model = find(result, 'model')
  assert.equal(model.status, 'fail')
  assert.match(model.detail, /installed but the cloud refused a request: unauthorized/)
  assert.equal(model.fix, 'ollama signin')
  assert.equal(result.ok, false)
})

test('model: an "unauthorized" error text fails even behind a 500 status', async () => {
  const generate = async () => ({ ok: false, status: 500, error: 'Unauthorized: please sign in to your account' })
  const result = await runChecks(fakeOptions({}, { generate }).options)
  const model = find(result, 'model')
  assert.equal(model.status, 'fail')
  assert.match(model.detail, /cloud refused a request/)
  assert.equal(model.fix, 'ollama signin')
})

test('model: a timed-out one-token request only warns and still suggests signin', async () => {
  const generate = async () => ({ ok: false, status: 0, error: 'The operation was aborted due to timeout' })
  const result = await runChecks(fakeOptions({}, { generate }).options)
  const model = find(result, 'model')
  assert.equal(model.status, 'warn')
  assert.match(model.detail, /installed, but a one-token request failed: The operation was aborted due to timeout/)
  assert.match(model.fix, /ollama signin/)
  assert.match(model.fix, /time out/)
  assert.equal(result.ok, true)
  assert.equal(result.warnings, 1)
})

test('model: a non-cloud model never sends a request', async () => {
  let asked = false
  const generate = async () => {
    asked = true
    return { ok: true, status: 200 }
  }
  const result = await runChecks(fakeOptions({}, { generate, model: 'llama3.2' }).options)
  const model = find(result, 'model')
  assert.equal(model.status, 'ok')
  assert.equal(model.detail, 'llama3.2 is available')
  assert.equal(asked, false)
})

/** The allowlist the release ships, used by the per-model rows. */
const MODELS = ['deepseek-v4.1-flash:cloud', 'deepseek-v4.1-flash:1017-cloud', 'minimax-m3.1-flash:cloud']

test('checks every allowed model: only the non-default unavailable one warns', async () => {
  const asked = []
  const generate = async (model) => {
    asked.push(model)
    return { ok: true, status: 200, ms: 5 }
  }
  const { options, calls } = fakeOptions(
    {
      ollamaShowFor: (model) =>
        model === 'minimax-m3.1-flash:cloud'
          ? { status: 1, stdout: '', stderr: 'not found' }
          : { status: 0, stdout: '', stderr: '' },
    },
    { models: MODELS, generate },
  )
  const result = await runChecks(options)
  assert.equal(find(result, 'model').status, 'ok')
  assert.equal(find(result, `model:${MODELS[1]}`).status, 'ok')
  const unavailable = find(result, `model:${MODELS[2]}`)
  assert.equal(unavailable.status, 'warn')
  assert.match(unavailable.detail, /minimax-m3\.1-flash:cloud is on the allowlist but is not available/)
  assert.equal(unavailable.fix, 'ollama pull minimax-m3.1-flash:cloud')
  assert.equal(result.ok, true)
  assert.equal(result.warnings, 1)
  // Only models that answered `ollama show` get a one-token request.
  assert.deepEqual(asked, [MODELS[0], MODELS[1]])
  assert.ok(calls.some((entry) => entry.command === 'ollama' && entry.args[1] === MODELS[2]))
})

test('the default model failing is still a failure while another model failing only warns', async () => {
  const { options } = fakeOptions(
    {
      ollamaShowFor: (model) =>
        model === 'deepseek-v4.1-flash:cloud'
          ? { status: 1, stdout: '', stderr: 'not found' }
          : { status: 0, stdout: '', stderr: '' },
    },
    { models: MODELS },
  )
  const result = await runChecks(options)
  assert.equal(find(result, 'model').status, 'fail')
  assert.equal(find(result, `model:${MODELS[1]}`).status, 'ok')
  assert.equal(result.ok, false)
  assert.equal(result.failures, 1)
  assert.equal(result.warnings, 0)
})

test('a non-default model the cloud refuses warns and suggests ollama signin', async () => {
  const generate = async (model) =>
    model === MODELS[2] ? { ok: false, status: 401, error: 'unauthorized' } : { ok: true, status: 200, ms: 5 }
  const { options } = fakeOptions({}, { models: MODELS, generate })
  const result = await runChecks(options)
  const refused = find(result, `model:${MODELS[2]}`)
  assert.equal(refused.status, 'warn')
  assert.match(refused.detail, /minimax-m3\.1-flash:cloud is installed but the cloud refused a request: unauthorized/)
  assert.equal(refused.fix, 'ollama signin')
  assert.equal(result.ok, true)
})

test('profile-models warns when the installed profile does not read FLASH_ROUTE_MODEL', async () => {
  const { probe: fs } = fakeFs({ files: { [FAKE_PROFILE_PATCH]: 'model: "deepseek-v4.1-flash:cloud"\n' } })
  const result = await runChecks(fakeOptions({}, { fs }).options)
  const check = find(result, 'profile-models')
  assert.equal(check.status, 'warn')
  assert.match(check.detail, /does not read FLASH_ROUTE_MODEL/)
  assert.match(check.detail, /only the default model can run/)
  assert.equal(check.fix, 'node install.mjs')
  assert.equal(result.ok, true)
})

test('profile-models is ok when the installed profile reads FLASH_ROUTE_MODEL', async () => {
  const { probe: fs } = fakeFs({ files: { [FAKE_PROFILE_PATCH]: HONOURING_PATCH } })
  const result = await runChecks(fakeOptions({}, { fs }).options)
  const check = find(result, 'profile-models')
  assert.equal(check.status, 'ok')
  assert.match(check.detail, /every allowed model can run/)
})

test('profileHonoursModelEnv reads the installed patch and fails closed', () => {
  const home = mkdtempSync(join(tmpdir(), 'flash-profile-home-'))
  try {
    assert.equal(profileHonoursModelEnv(home, 'flash-service'), false)
    assert.equal(profileHonoursModelEnv('', 'flash-service'), false)
    const dir = join(home, 'profiles', 'flash-service')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cordis.patch.yml'), HONOURING_PATCH)
    assert.equal(profileHonoursModelEnv(home, 'flash-service'), true)
    assert.equal(profileHonoursModelEnv(home, 'flash-service-readonly'), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('resolveDshHome trims, expands a leading ~, and defaults to <home>/.dsh', () => {
  const home = '/home/u'
  assert.equal(resolveDshHome(undefined, home), join(home, '.dsh'))
  assert.equal(resolveDshHome('', home), join(home, '.dsh'))
  assert.equal(resolveDshHome('   ', home), join(home, '.dsh'))
  assert.equal(resolveDshHome('~', home), home)
  assert.equal(resolveDshHome('~/x', home), join(home, 'x'))
  assert.equal(resolveDshHome('  ~/x  ', home), join(home, 'x'))
  assert.equal(resolveDshHome('~\\x', home), join(home, 'x'))
  // Anything else is the path dsh itself would use, only trimmed.
  assert.equal(resolveDshHome(' /srv/dsh ', home), '/srv/dsh')
  // `~user` is not a home-relative path dsh expands, so it is left as written.
  assert.equal(resolveDshHome('~someone/dsh', home), '~someone/dsh')
})

test('runChecks resolves a ~-style dshHome against the injected home', async () => {
  const home = mkdtempSync(join(tmpdir(), 'flash-doctor-home-'))
  try {
    const patch = join(home, 'harness', 'profiles', 'flash-service', 'cordis.patch.yml')
    const { probe: fs } = fakeFs({ files: { [patch]: HONOURING_PATCH } })
    const result = await runChecks(fakeOptions({}, { fs, dshHome: ' ~/harness ', home }).options)
    const check = find(result, 'profile-models')
    assert.equal(check.status, 'ok')
    assert.match(check.detail, /every allowed model can run/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('warns when zstd is missing while staying ok', async () => {
  const { options } = fakeOptions({ zstd: { status: 1, stdout: '', stderr: 'not found' } })
  const result = await runChecks(options)
  const zstd = find(result, 'zstd')
  assert.equal(zstd.status, 'warn')
  assert.match(zstd.detail, /sessions/)
  assert.ok(['brew install zstd', 'winget install Meta.Zstandard', 'install zstd'].includes(zstd.fix))
  assert.equal(result.ok, true)
  assert.equal(result.failures, 0)
  assert.equal(result.warnings, 1)
})

test('fails on a Node that cannot run dsh', async () => {
  for (const nodeVersion of ['18.20.4', '20.19.0', '22.16.0', '22.18.0', '23.11.0', '24.1.0']) {
    const result = await runChecks(fakeOptions({}, { nodeVersion }).options)
    const node = find(result, 'node')
    assert.equal(node.status, 'fail', nodeVersion)
    assert.equal(node.fix, 'install Node 22.19 or newer (24.2 or newer on the 24 line)')
    assert.equal(result.ok, false)
  }
})

test('accepts a Node that can run dsh', async () => {
  for (const nodeVersion of ['22.19.0', 'v22.23.2', '24.2.0', '26.8.2']) {
    const result = await runChecks(fakeOptions({}, { nodeVersion }).options)
    assert.equal(find(result, 'node').status, 'ok', nodeVersion)
  }
})

test('formats one line per check and a Fix line per broken one', async () => {
  const { options } = fakeOptions({
    dsh: { status: 1, stdout: '', stderr: '' },
    zstd: { status: 1, stdout: '', stderr: '' },
  })
  const result = await runChecks(options)
  const text = formatChecks(result)
  const lines = text.split('\n')
  const checkLines = lines.filter((line) => /^(ok|warn|fail)\s/.test(line))
  assert.equal(checkLines.length, 9)
  // dsh did not start here, so its native-module check is not run at all.
  for (const id of CHECK_IDS.filter((id) => id !== 'dsh-native')) assert.ok(text.includes(id), `missing ${id}`)
  const fixLines = lines.filter((line) => line.startsWith('Fix:'))
  const broken = result.checks.filter((check) => check.status !== 'ok')
  assert.equal(fixLines.length, broken.length)
  assert.ok(fixLines.some((line) => line.includes('@deepseek-ai/dsh')))
})
