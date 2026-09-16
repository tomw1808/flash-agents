#!/usr/bin/env node
/**
 * flash-sessions — list DeepSeek Harness sessions persisted on disk.
 *
 * Layout: <store>/<workspace-key>/<sessionId>/session.v3.jsonl.zstd; the first line
 * of the decompressed file is a JSON header with `id`, `createdAt` (epoch ms), `cwd`
 * and `delegationDepth`, and only that line is parsed. Unreadable or malformed files
 * are skipped, never fatal. Run with --help for the usage text.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const USAGE = `Usage: node packages/flash-mcp/scripts/flash-sessions.mjs [options]

List DeepSeek Harness sessions persisted on disk, newest first.

Options:
  --store <path>  session store (default: $DSH_HOME/sessions or ~/.dsh/sessions)
  --under <path>  only sessions whose header cwd is at or below <path>
  --limit <n>     show at most n sessions (default 20)
  --json          print a JSON array of {id, createdAt, cwd, file}
  --help          print this help
`

/** Parse argv into options. @param {string[]} argv @returns {object} */
function parseArgs(argv) {
  const opts = {
    store: join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions'),
    under: null, limit: 20, json: false, help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--json') opts.json = true
    else if (arg === '--store') opts.store = argv[++i]
    else if (arg === '--under') opts.under = argv[++i]
    else if (arg === '--limit') opts.limit = Number.parseInt(argv[++i], 10)
    else {
      process.stderr.write(`flash-sessions: unknown option: ${arg}\n`)
      process.exit(2)
    }
  }
  if (!Number.isInteger(opts.limit)) opts.limit = 20
  return opts
}

/** Read and validate the first-line header of one session file. @param {string} file */
function readHeader(file) {
  const text = execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: Infinity })
  const header = JSON.parse(text.split('\n', 1)[0])
  if (typeof header.id !== 'string' || typeof header.createdAt !== 'number' || typeof header.cwd !== 'string') {
    throw new Error('malformed session header')
  }
  return header
}

/** Walk the store and return readable sessions. @param {string} store @returns {object[]} */
function collect(store) {
  const sessions = []
  let keys
  try {
    keys = readdirSync(store, { withFileTypes: true })
  } catch {
    return sessions
  }
  for (const key of keys) {
    if (!key.isDirectory()) continue
    let ids
    try {
      ids = readdirSync(join(store, key.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const id of ids) {
      if (!id.isDirectory()) continue
      const file = join(store, key.name, id.name, 'session.v3.jsonl.zstd')
      try {
        const header = readHeader(file)
        sessions.push({ id: header.id, createdAt: header.createdAt, cwd: header.cwd, file })
      } catch {
        // Unreadable, missing or malformed: skip, never fatal.
      }
    }
  }
  return sessions
}

const opts = parseArgs(process.argv.slice(2))
if (opts.help) {
  process.stdout.write(USAGE)
  process.exit(0)
}

try {
  execFileSync('zstd', ['--version'], { stdio: 'ignore' })
} catch (err) {
  if (err && err.code === 'ENOENT') {
    process.stderr.write('flash-sessions: the "zstd" binary was not found on PATH\n')
    process.exit(2)
  }
}

const under = opts.under ? resolve(opts.under) : null
const prefix = under ? (under.endsWith(sep) ? under : under + sep) : null
const sessions = collect(opts.store)
  .filter((s) => !under || resolve(s.cwd) === under || resolve(s.cwd).startsWith(prefix))
  .sort((a, b) => b.createdAt - a.createdAt)

const shown = opts.limit > 0 ? sessions.slice(0, opts.limit) : sessions
if (opts.json) {
  process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`)
} else {
  for (const s of shown) {
    process.stdout.write(`${new Date(s.createdAt).toISOString()}  ${s.id}  ${s.cwd}\n`)
  }
}
