/**
 * Minimal Model Context Protocol server over the stdio transport.
 *
 * Scope: exactly what a tool-only MCP server needs, with no dependencies.
 *   - newline-delimited JSON-RPC 2.0 framing on stdin/stdout
 *     (the MCP stdio transport: one JSON message per line, `\n`-terminated)
 *   - the `initialize` handshake and `notifications/initialized`
 *   - `tools/list` and `tools/call`
 *   - `ping`, request cancellation, and progress notifications
 *
 * Deliberately not implemented: prompts, resources, sampling, elicitation,
 * logging, and completions. A Claude Code session only needs tools.
 *
 * @module flash-mcp/mcp
 */

/** Newest revision this server implements; also the fallback for a newer client. */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

/** Revisions this server can echo back verbatim. */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
])

const JSONRPC_VERSION = '2.0'
const PARSE_ERROR = -32700
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603
const REQUEST_CANCELLED = -32800
const SERVER_NOT_INITIALIZED = -32002

/**
 * Serve one MCP connection over a byte stream pair.
 *
 * @param {object} options - server wiring.
 * @param {{name: string, version: string}} options.serverInfo - identity reported at handshake.
 * @param {string} [options.instructions] - optional usage guidance for the client model.
 * @param {() => Array<object>} options.listTools - MCP tool descriptors.
 * @param {(name: string, args: object, ctx: {
 *   signal: AbortSignal,
 *   log: (message: string) => void,
 *   progressToken: string | number | undefined,
 *   sendProgress: (report: {progress: number, total?: number, message?: string}) => void,
 * }) => Promise<object>} options.callTool
 *        Runs one tool; resolves to an MCP tool result (`{content, structuredContent?, isError?}`).
 *        When the request carried `params._meta.progressToken`, the context exposes it and a
 *        `sendProgress` sender that emits a valid `notifications/progress` for it; without a
 *        token `sendProgress` sends nothing, because such a notification would be invalid.
 * @param {NodeJS.ReadableStream} [options.input] - protocol input (default stdin).
 * @param {NodeJS.WritableStream} [options.output] - protocol output (default stdout).
 * @param {(message: string) => void} [options.log] - diagnostic sink; MUST NOT be stdout.
 * @returns {{close: () => void, handled: () => number}} a handle for shutdown and tests.
 */
export function serveStdio({
  serverInfo,
  instructions,
  listTools,
  callTool,
  input = process.stdin,
  output = process.stdout,
  log = () => {},
}) {
  let buffer = ''
  let initialized = false
  let closed = false
  let handled = 0
  /** In-flight tool calls by JSON-RPC id, so `notifications/cancelled` can abort them. */
  const inFlight = new Map()

  const send = (message) => {
    if (closed) return
    output.write(`${JSON.stringify(message)}\n`)
  }

  const sendResult = (id, result) => send({ jsonrpc: JSONRPC_VERSION, id, result })

  const sendError = (id, code, message, data) => {
    send({
      jsonrpc: JSONRPC_VERSION,
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    })
  }

  /** Negotiate the revision: echo the client's when known, else our newest. */
  const negotiateVersion = (requested) =>
    SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION

  const handleInitialize = (id, params) => {
    const requested = params?.protocolVersion
    if (typeof requested !== 'string' || requested.length === 0) {
      sendError(id, INVALID_PARAMS, 'initialize requires a protocolVersion string')
      return
    }
    initialized = true
    sendResult(id, {
      protocolVersion: negotiateVersion(requested),
      capabilities: { tools: { listChanged: false } },
      serverInfo,
      ...(instructions === undefined ? {} : { instructions }),
    })
  }

  const handleToolsCall = async (id, params) => {
    if (typeof params?.name !== 'string' || params.name.length === 0) {
      sendError(id, INVALID_PARAMS, 'tools/call requires a tool name')
      return
    }
    const args = params.arguments ?? {}
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      sendError(id, INVALID_PARAMS, 'tools/call arguments must be an object')
      return
    }
    const known = listTools().some((tool) => tool.name === params.name)
    if (!known) {
      // A tool result, not a protocol error: the model can read and recover.
      sendResult(id, {
        content: [{ type: 'text', text: `unknown tool "${params.name}"` }],
        isError: true,
      })
      return
    }
    const controller = new AbortController()
    inFlight.set(id, controller)
    // MCP: a progress notification is only valid for a request whose `params._meta`
    // carried a `progressToken`. The second argument of the official SDK's request
    // handler is exactly this meta (`_meta`) together with its `sendNotification`;
    // this server is its own protocol layer, so it exposes the same two facts here.
    const progressToken = params._meta?.progressToken
    const sendProgress = (report) => {
      // Never emit a notification the spec would reject: the token must be a string or
      // number, and every progress notification needs a numeric `progress`.
      if (typeof progressToken !== 'string' && typeof progressToken !== 'number') return
      if (report === null || typeof report !== 'object') return
      if (typeof report.progress !== 'number' || !Number.isFinite(report.progress)) return
      send({
        jsonrpc: JSONRPC_VERSION,
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: report.progress,
          ...(report.total === undefined ? {} : { total: report.total }),
          ...(report.message === undefined ? {} : { message: report.message }),
        },
      })
    }
    try {
      const result = await callTool(params.name, args, { signal: controller.signal, log, progressToken, sendProgress })
      sendResult(id, result)
    } catch (error) {
      if (controller.signal.aborted) sendError(id, REQUEST_CANCELLED, 'request cancelled')
      else {
        log(`tool ${params.name} failed: ${describeError(error)}`)
        sendError(id, INTERNAL_ERROR, describeError(error), { tool: params.name })
      }
    } finally {
      inFlight.delete(id)
    }
  }

  const handleRequest = (id, method, params) => {
    if (method === 'initialize') {
      handleInitialize(id, params)
      return
    }
    if (method === 'ping') {
      sendResult(id, {})
      return
    }
    if (!initialized) {
      sendError(id, SERVER_NOT_INITIALIZED, 'server received a request before initialize')
      return
    }
    switch (method) {
      case 'tools/list':
        sendResult(id, { tools: listTools() })
        return
      case 'tools/call':
        void handleToolsCall(id, params)
        return
      default:
        sendError(id, METHOD_NOT_FOUND, `unknown method "${method}"`)
    }
  }

  const handleNotification = (method, params) => {
    if (method === 'notifications/initialized') {
      log('client initialized')
      return
    }
    if (method === 'notifications/cancelled') {
      const controller = inFlight.get(params?.requestId)
      if (controller !== undefined) {
        log(`cancelling request ${String(params.requestId)}`)
        controller.abort()
      }
      return
    }
    // Unknown notifications are ignorable by contract.
  }

  const dispatch = (message) => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      log('ignoring non-object message')
      return
    }
    const { id, method, params } = message
    if (typeof method !== 'string') {
      log('ignoring message without a method')
      return
    }
    handled += 1
    // A message without an id is a notification and MUST NOT be answered.
    if (id === undefined || id === null) handleNotification(method, params)
    else handleRequest(id, method, params)
  }

  const onData = (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length === 0) continue
      try {
        dispatch(JSON.parse(line))
      } catch (error) {
        log(`ignoring unparsable protocol line: ${describeError(error)}`)
        sendError(null, PARSE_ERROR, 'invalid JSON in protocol message')
      }
    }
  }

  const close = () => {
    if (closed) return
    closed = true
    input.off('data', onData)
    input.off('end', onEnd)
    input.off('close', onEnd)
    for (const controller of inFlight.values()) controller.abort()
    inFlight.clear()
  }

  function onEnd() {
    close()
  }

  input.setEncoding?.('utf8')
  input.on('data', onData)
  input.on('end', onEnd)
  input.on('close', onEnd)

  return { close, handled: () => handled }
}

/** Render an error without trusting it to be an Error. */
export function describeError(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
