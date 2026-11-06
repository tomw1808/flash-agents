/**
 * The guard that keeps a test's service or pool out of the real durable data directory.
 *
 * A pool without an explicit state directory stores patches in `FLASH_DATA_DIR`; this
 * helper is what the tests point at a throwaway directory and what refuses to build one
 * that forgot. It never reads or writes the real directory: the rejected paths are only
 * compared.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { assertTemporaryDataDir, temporaryDataDir } from '../test-support/data-dir.mjs'

test('the data-dir guard refuses an unset or non-temporary FLASH_DATA_DIR', () => {
  assert.throws(() => assertTemporaryDataDir({}), /FLASH_DATA_DIR is not set/)
  assert.throws(() => assertTemporaryDataDir({ FLASH_DATA_DIR: '' }), /FLASH_DATA_DIR is not set/)
  const outside = join(tmpdir(), '..', 'flash-data-dir-outside')
  assert.throws(
    () => assertTemporaryDataDir({ FLASH_DATA_DIR: outside }),
    /is not under the temp directory/,
    `${outside} must not pass as a test data directory`,
  )
})

test('temporaryDataDir points FLASH_DATA_DIR at a temp directory the guard accepts', () => {
  const previous = process.env.FLASH_DATA_DIR
  try {
    const dir = temporaryDataDir('flash-data-dir-test-')
    assert.equal(process.env.FLASH_DATA_DIR, dir)
    assert.equal(assertTemporaryDataDir(), resolve(dir))
  } finally {
    if (previous === undefined) delete process.env.FLASH_DATA_DIR
    else process.env.FLASH_DATA_DIR = previous
  }
})
