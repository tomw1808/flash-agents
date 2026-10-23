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

test('install writes the module stamp into the interactive profile only when every plugin is ESM', () => {
  const home = tempHome()
  try {
    const output = install(home)
    const plugins = join(home, 'profiles', 'web', 'plugins')
    const stamp = JSON.parse(readFileSync(join(plugins, 'package.json'), 'utf8'))
    assert.deepEqual(stamp, { private: true, type: 'module', flashAgents: { version: FLASH_VERSION } })
    assert.match(output, new RegExp(`replaced .*profiles/web/plugins/package\\.json`))
    // The provider copied there really is ESM, which is what made the stamp safe.
    assert.match(readFileSync(join(plugins, 'dsh-subagent-flash.js'), 'utf8'), /^\s*export\s/m)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('install leaves the interactive plugins folder without a stamp when a file is CommonJS', () => {
  const home = tempHome()
  try {
    const plugins = join(home, 'profiles', 'web', 'plugins')
    mkdirSync(plugins, { recursive: true })
    writeFileSync(join(plugins, 'own-plugin.js'), 'module.exports = {}\n')
    const output = install(home)
    assert.equal(existsSync(join(plugins, 'package.json')), false, 'a CommonJS file must not be declared a module')
    assert.ok(
      output.includes(`left ${plugins} without a package.json: ${join(plugins, 'own-plugin.js')} is not an ES module`),
      output,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('review: a CommonJS plugin with a commented export line is not declared a module', () => {
  const home = tempHome()
  try {
    const plugins = join(home, 'profiles', 'web', 'plugins')
    mkdirSync(plugins, { recursive: true })
    const plugin = join(plugins, 'own-plugin.js')
    // A CommonJS file may mention an old export in a comment; the installer's line-shaped
    // test cannot tell that from a real `export` statement and declares the folder ESM.
    writeFileSync(plugin, '/* the old name was\nexport const legacy = true\n*/\nmodule.exports = {}\n')
    const output = install(home)
    assert.equal(
      existsSync(join(plugins, 'package.json')),
      false,
      `a CommonJS plugin must not be declared a module (installer said: ${output.split('\n').find((line) => line.includes('without a package.json')) ?? 'nothing'})`,
    )
    // It still has to load as CommonJS after the install.
    execFileSync(process.execPath, [plugin], { encoding: 'utf8' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('review: a rerun withdraws the installer stamp when a CommonJS plugin was added', () => {
  const home = tempHome()
  try {
    install(home)
    const plugins = join(home, 'profiles', 'web', 'plugins')
    const stamp = join(plugins, 'package.json')
    assert.equal(existsSync(stamp), true, 'the first install wrote its own stamp')
    const plugin = join(plugins, 'own-plugin.js')
    writeFileSync(plugin, 'module.exports = {}\n')
    const output = install(home)
    const effective = existsSync(stamp) ? JSON.parse(readFileSync(stamp, 'utf8')) : undefined
    assert.notEqual(
      effective?.type,
      'module',
      `the installer left its own stamp declaring a CommonJS plugin a module; it reported: ${output.split('\n').find((line) => line.includes('without a package.json')) ?? 'nothing'}`,
    )
    assert.equal(existsSync(stamp), false, 'the installer withdrew its own stamp')
    assert.ok(
      output.includes(
        `removed ${stamp}: ${plugin} is not an ES module, so the folder is no longer declared one`,
      ),
      output,
    )
    assert.doesNotMatch(output, /without a package\.json/, 'the report must not claim a package.json is absent while one remains')
    execFileSync(process.execPath, [plugin], { encoding: 'utf8' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('review: ESM detection parses each plugin, so only real module syntax declares the folder a module', () => {
  // `isEsmFile` is private to the installer, so each case is observed through the stamp
  // the installer does or does not write beside the interactive profile's plugins.
  const cases = [
    {
      name: 'commented-export.js',
      source: '/* the old name was\nexport const legacy = true\n*/\nmodule.exports = {}\n',
      esm: false,
    },
    { name: 'esm-default.js', source: 'export default function plugin() {}\n', esm: true },
    { name: 'esm-import.js', source: "import { readFileSync } from 'node:fs'\n", esm: true },
    { name: 'syntax-error.js', source: 'const = ;\n', esm: false },
    // Top-level await does not compile inside the CommonJS wrapper, but the contract also
    // requires an import/export statement; without one the folder stays unmarked.
    { name: 'top-level-await.js', source: 'const answer = await Promise.resolve(42)\n', esm: false },
    { name: 'top-level-await-export.js', source: 'export default await Promise.resolve(42)\n', esm: true },
  ]
  for (const scenario of cases) {
    const home = tempHome()
    try {
      const plugins = join(home, 'profiles', 'web', 'plugins')
      mkdirSync(plugins, { recursive: true })
      writeFileSync(join(plugins, scenario.name), scenario.source)
      install(home)
      assert.equal(
        existsSync(join(plugins, 'package.json')),
        scenario.esm,
        `${scenario.name}: expected the folder ${scenario.esm ? 'to be' : 'not to be'} declared a module`,
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
})

test('review: the parse-based ESM check accepts both shipped plugins', () => {
  const home = tempHome()
  try {
    // `assertPluginsAreEsm` runs before any write; a plugin it rejected would make the
    // installer exit non-zero instead of returning this output.
    const output = install(home)
    assert.match(output, /replaced .*profiles\/web\/plugins\/package\.json/)
    for (const profile of PROFILES) {
      assert.equal(existsSync(join(home, 'profiles', profile, 'plugins', 'package.json')), true, `${profile} stamp`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('install keeps a foreign package.json in the interactive plugins folder', () => {
  const home = tempHome()
  try {
    const plugins = join(home, 'profiles', 'web', 'plugins')
    mkdirSync(plugins, { recursive: true })
    const own = '{"name":"the user\'s own plugins"}\n'
    writeFileSync(join(plugins, 'package.json'), own)
    const output = install(home)
    assert.equal(readFileSync(join(plugins, 'package.json'), 'utf8'), own)
    assert.ok(output.includes(`left ${plugins}'s own package.json alone`), output)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('uninstall removes the interactive stamp only when it carries flashAgents', () => {
  const home = tempHome()
  try {
    install(home)
    const target = join(home, 'profiles', 'web', 'plugins', 'package.json')
    assert.equal(existsSync(target), true)
    runInstaller(home, ['--uninstall'])
    assert.equal(existsSync(target), false, 'our own stamp is removed')

    const own = '{"name":"the user\'s own plugins"}\n'
    writeFileSync(target, own)
    runInstaller(home, ['--uninstall'])
    assert.equal(readFileSync(target, 'utf8'), own, 'a package.json without the stamp is not ours to delete')
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
