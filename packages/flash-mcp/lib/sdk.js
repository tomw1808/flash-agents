/**
 * Client for the DeepSeek Harness SDK runtime (`@deepseek-ai/dsh-sdk-protocol`).
 *
 * The boundary is a persistent child process launched as
 * `dsh --profile <profile>`, speaking newline-delimited JSON-RPC 2.0 on stdio.
 * Requests: `initialize`, `session/prompt`, `shutdown`.
 * Notifications: `session.event`, `session.status`, `subagent.started`,
 * `subagent.finished`.
 *
 * Nothing here parses human-readable output: stdout carries protocol frames
 * only, and stderr is retained solely as a bounded diagnostic tail.
 *
 * @module flash-mcp/sdk
 */

import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** Identity the SDK runtime reports at handshake. */
export const SDK_SERVER_NAME = 'deepseek-harness-sdk-runtime'

/** Default per-request protocol timeout. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Default retained stderr bytes. */
const DEFAULT_STDERR_TAIL_BYTES = 4_096

/**
 * Resolve the `dsh` launcher.
 *
 * Order: `FLASH_DSH_BIN` (a launcher path, or a JavaScript entry run with the
 * current Node binary), then the first executable `dsh` on `PATH`.
 *
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @returns {{command: string, prefix: string[]}} spawn command and leading args.
 */
export function resolveDshCommand(env = process.env) {
  const override = env.FLASH_DSH_BIN
  if (typeof override === 'string' && override.trim().length > 0) {
    return commandFor(override.trim())
  }
  const found = findOnPath('dsh', env.PATH ?? '')
  if (found !== undefined) return { command: found, prefix: [] }
  throw new Error(
    'cannot find the dsh launcher: set FLASH_DSH_BIN to the dsh executable (or to lib/bin.js inside the harness install), or put dsh on PATH',
  )
}

/** Turn a launcher path into a spawn command, running JavaScript entries with Node. */
function commandFor(path) {
  return /\.(c|m)?js$/.test(path)
    ? { command: process.execPath, prefix: [path] }
    : { command: path, prefix: [] }
}

/** Find the first executable candidate on a PATH-style string. */
function findOnPath(name, pathValue) {
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) continue
    for (const suffix of suffixes) {
      const candidate = join(directory, name + suffix)
      if (!existsSync(candidate)) continue
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Present but not executable: keep looking.
      }
    }
  }
  return undefined
}

/**
 * One persistent DSH SDK runtime process.
 *
 * Owns framing, request correlation, notification fan-out, and process
 * lifecycle. The protocol has no cancel method, so a session's work always runs
 * to its own end; this client only stops waiting.
 */
export class HarnessSdkClient {
  /**
   * @param {object} options - client wiring.
   * @param {string} options.profile - dsh profile id to boot.
   * @param {string} options.cwd - working directory for the runtime process.
   * @param {Record<string, string | undefined>} [options.env] - child environment.
   * @param {(message: string) => void} [options.log] - diagnostic sink (stderr).
   * @param {number} [options.requestTimeoutMs] - per-request protocol timeout.
   * @param {number} [options.stderrTailBytes] - retained stderr bytes.
   * @param {{command: string, prefix: string[]}} [options.command] - launcher override (tests).
   */
  constructor({
    profile,
    cwd,
    env = process.env,
    log = () => {},
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    stderrTailBytes = DEFAULT_STDERR_TAIL_BYTES,
    command,
  }) {
    this.profile = profile
    this.cwd = cwd
    this.env = env
    this.log = log
    this.requestTimeoutMs = requestTimeoutMs
    this.stderrTailBytes = stderrTailBytes
    this.launcher = command ?? resolveDshCommand(env)

    /** @type {import('node:child_process').ChildProcess | undefined} */
    this.child = undefined
    this.pid = undefined
    this.serverInfo = undefined
    this.generation = 0
    this.exited = false

    this.nextId = 1
    this.pending = new Map()
    this.notificationHandlers = new Set()
    this.exitHandlers = new Set()
    this.stderrTail = ''
    this.stdoutBuffer = ''
  }

  /** Whether a live runtime process is attached. */
  get running() {
    return this.child !== undefined && !this.exited
  }

  /**
   * Spawn the runtime process (idempotent).
   * @returns {number} the process id.
   */
  start() {
    if (this.running) return this.pid
    const args = [...this.launcher.prefix, '--profile', this.profile]
    const child = spawn(this.launcher.command, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.pid = child.pid
    this.exited = false
    this.generation += 1
    this.stdoutBuffer = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-this.stderrTailBytes)
      this.log(`dsh[${String(child.pid)}] ${chunk.trimEnd()}`)
    })
    child.on('error', (error) => {
      this.log(`runtime process error: ${error.message}`)
      this.#failAll(new Error(`dsh runtime process failed: ${error.message}`))
    })
    child.on('exit', (code, signal) => {
      this.exited = true
      const detail = `dsh runtime exited (code ${String(code)}, signal ${String(signal)})${this.#stderrHint()}`
      this.#failAll(new Error(detail))
      for (const handler of this.exitHandlers) handler({ code, signal })
    })
    this.log(`started dsh runtime: pid ${String(this.pid)} profile ${this.profile}`)
    return this.pid
  }

  /**
   * Run the SDK handshake, which also fixes the route for every agent this
   * runtime creates.
   * @param {object} params - `initialize` parameters.
   * @param {string} params.cwd - session working directory.
   * @param {string} params.provider - LLM provider route.
   * @param {string} params.model - model id on that route.
   * @param {number} [params.maxTokens] - optional output cap.
   * @returns {Promise<{name: string, version: string}>} server identity.
   */
  async initialize({ cwd, provider, model, maxTokens }) {
    const result = await this.request('initialize', {
      cwd,
      provider,
      model,
      ...(maxTokens === undefined ? {} : { maxTokens }),
    })
    this.serverInfo = result?.serverInfo
    if (this.serverInfo?.name !== SDK_SERVER_NAME) {
      throw new Error(`unexpected SDK runtime identity: ${JSON.stringify(this.serverInfo)}`)
    }
    return this.serverInfo
  }

  /**
   * Queue one user turn on a session, creating the session when the id is new.
   * @param {object} params - prompt parameters.
   * @param {string} params.sessionId - SDK-side session id.
   * @param {string} params.text - prompt text.
   * @returns {Promise<{messageId: string}>} the enqueue receipt.
   */
  async prompt({ sessionId, text }) {
    return await this.request('session/prompt', {
      sessionId,
      contentBlocks: [{ type: 'text', text }],
    })
  }

  /**
   * Send one JSON-RPC request and await its result.
   * @param {string} method - protocol method.
   * @param {object} [params] - request parameters.
   * @returns {Promise<any>} the result payload.
   */
  request(method, params) {
    if (!this.running) return Promise.reject(new Error('dsh runtime is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`dsh protocol request "${method}" timed out after ${String(this.requestTimeoutMs)}ms`))
      }, this.requestTimeoutMs)
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.#write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /**
   * Register a server-to-client notification listener.
   * @param {(method: string, params: any) => void} handler - notification sink.
   * @returns {() => void} unsubscribe.
   */
  onNotification(handler) {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  /**
   * Register a process-exit listener.
   * @param {(info: {code: number | null, signal: string | null}) => void} handler - exit sink.
   * @returns {() => void} unsubscribe.
   */
  onExit(handler) {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
  }

  /** The bounded stderr tail, for diagnostics. */
  get diagnostics() {
    return this.stderrTail.trim()
  }

  /**
   * Ask the runtime to dispose its sessions and exit, escalating to signals.
   * @param {number} [timeoutMs] - grace period before signalling.
   */
  async shutdown(timeoutMs = 3_000) {
    const child = this.child
    if (child === undefined) return
    if (!this.exited) {
      try {
        await Promise.race([
          this.request('shutdown', undefined),
          new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ])
      } catch (error) {
        this.log(`shutdown request failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      await this.#waitForExit(child, timeoutMs)
    }
    if (!this.exited) {
      child.kill('SIGTERM')
      await this.#waitForExit(child, timeoutMs)
    }
    if (!this.exited) child.kill('SIGKILL')
    this.child = undefined
    this.pid = undefined
  }

  /** Attach a timeout to one exit event. */
  #waitForExit(child, timeoutMs) {
    if (this.exited) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.off('exit', onExit)
        resolve()
      }, timeoutMs)
      function onExit() {
        clearTimeout(timer)
        resolve()
      }
      child.once('exit', onExit)
    })
  }

  #write(message) {
    const child = this.child
    if (child === undefined || child.stdin.destroyed) return
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #onStdout(chunk) {
    this.stdoutBuffer += chunk
    for (;;) {
      const index = this.stdoutBuffer.indexOf('\n')
      if (index < 0) break
      const line = this.stdoutBuffer.slice(0, index).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1)
      if (line.length === 0) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.log(`ignoring unparsable runtime frame: ${line.slice(0, 200)}`)
        continue
      }
      this.#dispatch(message)
    }
  }

  #dispatch(message) {
    const { id, method, result, error } = message ?? {}
    if (typeof method === 'string') {
      for (const handler of this.notificationHandlers) {
        try {
          handler(method, message.params)
        } catch (handlerError) {
          this.log(`notification handler failed: ${String(handlerError)}`)
        }
      }
      return
    }
    const entry = this.pending.get(id)
    if (entry === undefined) {
      this.log(`ignoring response for unknown request id ${String(id)}`)
      return
    }
    this.pending.delete(id)
    if (error !== undefined) {
      const detail = typeof error?.message === 'string' ? error.message : JSON.stringify(error)
      entry.reject(new Error(`dsh ${entry.method} failed: ${detail}${this.#stderrHint()}`))
      return
    }
    entry.resolve(result)
  }

  #stderrHint() {
    const tail = this.diagnostics
    return tail.length === 0 ? '' : `\n--- dsh stderr ---\n${tail}`
  }

  #failAll(error) {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      entry.reject(error)
    }
  }
}
