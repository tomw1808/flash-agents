/**
 * Installer contract tests: both generated service profiles must carry the model
 * selection expression, and a rerun must replace the managed blocks without changing
 * the files it already wrote.
 *
 * The installer is spawned as the user runs it (`node install.mjs --home <tmp>`), so
 * these tests cover the real path from the checked-in template to the installed
 * composition. Every run targets a throwaway home; neither the real `~/.dsh` nor the
 * real harness home is read or written.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/** The installer, as a user invokes it from the repository root. */
const INSTALL = fileURLToPath(new URL('../../../install.mjs', import.meta.url))

/** The release the installer stamps into every profile it writes. */
const FLASH_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

/** The shipped route default, which the template renders as the fallback. */
const DEFAULT_MODEL = JSON.parse(readFileSync(new URL('../../../flash.config.json', import.meta.url), 'utf8')).route.model

/** The two profiles the installer generates from the one template. */
const PROFILES = ['flash-service', 'flash-service-readonly']

/** A throwaway harness home. */
function tempHome() {
  return mkdtempSync(join(tmpdir(), 'flash-install-home-'))
}

/**
 * Run the installer against a throwaway home with an explicit argument list.
 *
 * The ambient DSH/FLASH settings are removed so the run renders the repository's
 * defaults: the harness that runs these tests may itself set DSH_PROFILE or
 * FLASH_SERVICE_MODEL.
 *
 * @param {string} home - the throwaway harness home.
 * @param {string[]} [args] - extra arguments, such as `--uninstall` or `--dry-run`.
 * @returns {string} the installer's output.
 */
function runInstaller(home, args = []) {
  const env = { ...process.env }
  for (const key of ['DSH_HOME', 'DSH_PROFILE', 'FLASH_MODELS', 'FLASH_SERVICE_MODEL', 'FLASH_SERVICE_PROVIDER']) {
    delete env[key]
  }
  return execFileSync(process.execPath, [INSTALL, '--home', home, ...args], { encoding: 'utf8', env })
}

/**
 * Run the installer against a throwaway home.
 *
 * @param {string} home - the throwaway harness home.
 * @returns {string} the installer's output.
 */
function install(home) {
  return runInstaller(home)
}

/** Read one installed composition. */
function installedPatch(home, profile) {
  return readFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8')
}

test('install renders FLASH_ROUTE_MODEL into all four model values of both profiles', () => {
  const home = tempHome()
  try {
    const output = install(home)
    // The closing text points at the allowlist instead of settings.yaml selection.
    assert.match(output, /route\.models/)
    assert.match(output, /FLASH_MODELS/)
    const expression = `process.env.FLASH_ROUTE_MODEL || ${JSON.stringify(DEFAULT_MODEL)}`
    for (const profile of PROFILES) {
      const text = installedPatch(home, profile)
      assert.equal(text.split(expression).length - 1, 4, `${profile} should carry the expression four times`)
      assert.doesNotMatch(text, /\$\{|@\{/, `${profile} still holds an unrendered placeholder`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a second install is idempotent for both generated profiles', () => {
  const home = tempHome()
  try {
    install(home)
    const before = Object.fromEntries(PROFILES.map((profile) => [profile, installedPatch(home, profile)]))

    const output = install(home)
    for (const profile of PROFILES) {
      assert.equal(installedPatch(home, profile), before[profile], `${profile} changed on the second run`)
    }
    assert.match(output, /left the flash-service marker block .* unchanged/)
    assert.match(output, /left the generated flash-service-readonly composition .* unchanged/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('install writes an ES-module release stamp beside both profiles’ plugins', () => {
  const home = tempHome()
  const seeded = join(home, 'profiles', 'flash-service', 'package.json')
  try {
    // A stale stamp must be replaced, and the profile's own seeded manifest is the user's.
    mkdirSync(dirname(join(home, 'profiles', 'flash-service', 'plugins', 'package.json')), { recursive: true })
    writeFileSync(join(home, 'profiles', 'flash-service', 'plugins', 'package.json'), '{"type":"commonjs"}\n')
    mkdirSync(dirname(seeded), { recursive: true })
    writeFileSync(seeded, '{"name":"edited by the user"}\n')

    install(home)

    for (const profile of PROFILES) {
      const plugins = join(home, 'profiles', profile, 'plugins')
      const stamp = JSON.parse(readFileSync(join(plugins, 'package.json'), 'utf8'))
      assert.deepEqual(stamp, { private: true, type: 'module', flashAgents: { version: FLASH_VERSION } })
      // Every `.js` file in the folder is governed by that `type`, so both must be ESM.
      for (const file of ['dsh-subagent-flash.js', 'dsh-flash-guard.js']) {
        assert.match(readFileSync(join(plugins, file), 'utf8'), /^\s*export\s/m, `${profile}/${file} is not ESM`)
      }
    }
    assert.equal(readFileSync(seeded, 'utf8'), '{"name":"edited by the user"}\n', 'the seeded profile package.json was replaced')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('install --dry-run reports the plugin stamp without writing it', () => {
  const home = tempHome()
  try {
    const output = runInstaller(home, ['--dry-run'])
    for (const profile of PROFILES) {
      assert.match(output, new RegExp(`replaced .*${profile}.*plugins/package\\.json`))
      assert.equal(existsSync(join(home, 'profiles', profile, 'plugins', 'package.json')), false)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('install --uninstall removes the plugin stamp', () => {
  const home = tempHome()
  try {
    install(home)
    for (const profile of PROFILES) {
      assert.equal(existsSync(join(home, 'profiles', profile, 'plugins', 'package.json')), true)
    }
    runInstaller(home, ['--uninstall'])
    for (const profile of PROFILES) {
      assert.equal(existsSync(join(home, 'profiles', profile, 'plugins', 'package.json')), false, `${profile} kept its stamp`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
