/**
 * A test's durable data directory, and the guard that keeps a test from reaching the real one.
 *
 * A pool without an explicit state directory stores its patches in `FLASH_DATA_DIR`, or in
 * the platform's durable data directory (`~/Library/Application Support/flash-agents` on
 * macOS). A sandbox refuses that path, and a test must never write there anyway; every
 * test file that builds such a service or pool points the variable at a throwaway
 * directory first. `assertTemporaryDataDir` makes a helper that forgot fail loudly, before
 * the service is built.
 */

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

/**
 * Every spelling of the platform temp directory, canonical and raw.
 *
 * On macOS `os.tmpdir()` is `/var/folders/…`, a symlink to `/private/var/…`; a directory
 * created through one spelling and checked through the other is still the same directory.
 *
 * @returns {string[]} the temp roots to compare against.
 */
function tempRoots() {
  const roots = new Set()
  for (const root of [tmpdir()]) {
    roots.add(resolve(root))
    try {
      roots.add(resolve(realpathSync(root)))
    } catch {
      // An unreadable temp root contributes the raw spelling above and nothing else.
    }
  }
  return [...roots]
}

/**
 * Whether `target` is `root` or sits below it.
 *
 * @param {string} root - the parent directory.
 * @param {string} target - the path to place.
 * @returns {boolean} true when target is inside root.
 */
function isUnder(root, target) {
  const path = relative(root, target)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/**
 * Create a throwaway durable data directory and point `FLASH_DATA_DIR` at it.
 *
 * @param {string} [prefix] - the temp-directory prefix, so a leaked one names its test.
 * @returns {string} the canonical directory.
 */
export function temporaryDataDir(prefix = 'flash-data-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  process.env.FLASH_DATA_DIR = dir
  return dir
}

/**
 * Refuse to build a service or pool that would use the real durable data directory.
 *
 * @param {Record<string, string | undefined>} [env] - the environment to check; the process
 *   environment by default, which is what a pool's default patch directory reads.
 * @returns {string} the configured directory.
 * @throws {Error} when `FLASH_DATA_DIR` is unset or names a directory outside the temp
 *   directory, which is the real data directory or something a test cannot clean up.
 */
export function assertTemporaryDataDir(env = process.env) {
  const configured = env.FLASH_DATA_DIR
  if (typeof configured !== 'string' || configured.length === 0) {
    throw new Error(
      'FLASH_DATA_DIR is not set: a service or pool built without an explicit state/patch directory ' +
        'would use the real durable data directory; call temporaryDataDir() first',
    )
  }
  const resolved = resolve(configured)
  if (!tempRoots().some((root) => isUnder(root, resolved))) {
    throw new Error(
      `FLASH_DATA_DIR ${JSON.stringify(configured)} is not under the temp directory ${JSON.stringify(tmpdir())}; ` +
        'a test may not read or write the real durable data directory',
    )
  }
  return resolved
}
