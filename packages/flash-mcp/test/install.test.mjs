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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/** The installer, as a user invokes it from the repository root. */
const INSTALL = fileURLToPath(new URL('../../../install.mjs', import.meta.url))

/** The shipped route default, which the template renders as the fallback. */
const DEFAULT_MODEL = JSON.parse(readFileSync(new URL('../../../flash.config.json', import.meta.url), 'utf8')).route.model

/** The two profiles the installer generates from the one template. */
const PROFILES = ['flash-service', 'flash-service-readonly']

/** A throwaway harness home. */
function tempHome() {
  return mkdtempSync(join(tmpdir(), 'flash-install-home-'))
}

/**
 * Run the installer against a throwaway home.
 *
 * The ambient DSH/FLASH settings are removed so the run renders the repository's
 * defaults: the harness that runs these tests may itself set DSH_PROFILE or
 * FLASH_SERVICE_MODEL.
 *
 * @param {string} home - the throwaway harness home.
 * @returns {string} the installer's output.
 */
function install(home) {
  const env = { ...process.env }
  for (const key of ['DSH_HOME', 'DSH_PROFILE', 'FLASH_MODELS', 'FLASH_SERVICE_MODEL', 'FLASH_SERVICE_PROVIDER']) {
    delete env[key]
  }
  return execFileSync(process.execPath, [INSTALL, '--home', home], { encoding: 'utf8', env })
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
