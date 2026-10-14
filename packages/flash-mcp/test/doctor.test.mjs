/**
 * Prerequisite-check tests: every effect is injected, so no real binary is run
 * and no network endpoint is touched. Each scenario is one fake command table.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { CHECK_IDS, formatChecks, runChecks } from '../lib/doctor.js'

/** Look up one check in a report by id. @param {object} result @param {string} id */
function find(result, id) {
  return result.checks.find((check) => check.id === id)
}

/**
 * Build fully injected run/probe fakes for one scenario.
 *
 * @param {object} [behaviors] - per-command results and the daemon probe answer.
 * @param {object} [options] - extra options to merge into the injected set.
 * @returns {{options: object, calls: Array<{command: string, args: string[]}>}} the fakes plus a call log.
 */
function fakeOptions(behaviors = {}, options = {}) {
  const dsh = behaviors.dsh ?? { status: 0, stdout: '0.2.0-rc.2\n', stderr: '' }
  const profileDump = behaviors.profileDump ?? { status: 0, stdout: '', stderr: '' }
  const ollamaShow = behaviors.ollamaShow ?? { status: 0, stdout: '', stderr: '' }
  const git = behaviors.git ?? { status: 0, stdout: 'git version 2.0.0\n', stderr: '' }
  const zstd = behaviors.zstd ?? { status: 0, stdout: 'zstd 1.5.5\n', stderr: '' }
  const daemon = behaviors.daemon ?? true
  const calls = []
  const run = (command, args) => {
    calls.push({ command, args })
    if (command === 'dsh') return args[0] === '--version' ? dsh : profileDump
    if (command === 'ollama') return ollamaShow
    if (command === 'git') return git
    if (command === 'zstd') return zstd
    return { status: 1, stdout: '', stderr: 'not found' }
  }
  const launcher = { command: 'dsh', prefix: [] }
  return { options: { run, probe: async () => daemon, launcher, nodeVersion: '22.19.0', ...options }, calls }
}

test('reports eight ok checks for a fully working environment', async () => {
  const { options } = fakeOptions()
  const result = await runChecks(options)
  assert.equal(result.checks.length, 8)
  assert.deepEqual(result.checks.map((check) => check.id), [...CHECK_IDS])
  assert.ok(result.checks.every((check) => check.status === 'ok'))
  assert.equal(result.ok, true)
  assert.equal(result.failures, 0)
  assert.equal(result.warnings, 0)
  assert.match(find(result, 'model').detail, /signin/)
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
  assert.deepEqual(seen[0], ['/usr/bin/node', '/opt/dsh/lib/bin.js', '--version'])
  assert.deepEqual(seen[1], ['/usr/bin/node', '/opt/dsh/lib/bin.js', '--profile', 'flash-service', '--dump-config'])
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
  assert.equal(checkLines.length, 8)
  for (const id of CHECK_IDS) assert.ok(text.includes(id), `missing ${id}`)
  const fixLines = lines.filter((line) => line.startsWith('Fix:'))
  const broken = result.checks.filter((check) => check.status !== 'ok')
  assert.equal(fixLines.length, broken.length)
  assert.ok(fixLines.some((line) => line.includes('@deepseek-ai/dsh')))
})
