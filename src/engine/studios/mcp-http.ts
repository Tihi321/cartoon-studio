/**
 * A minimal MCP client (Streamable HTTP): `initialize`, then `tools/list` and `tools/call`. The server answers with plain JSON; a
 * `text/event-stream` answer (SSE) is read too. No SDK: this is a few hundred bytes of JSON-RPC over `fetch`.
 *
 * Shared by Pixel Studio and Chiptune Studio (`studios/*.ts`).
 */

import { resolveKey } from '../models/keys'
import type { StoredKeyGetter } from '../models/keys'

export class McpHttpError extends Error {
  constructor(
    message: string,
    /** `unreachable`: nothing answers at the URL. `timeout`, `http`, `tool` (the tool said isError), `protocol`, `aborted`. */
    readonly kind: 'unreachable' | 'timeout' | 'http' | 'tool' | 'protocol' | 'aborted'
  ) {
    super(message)
    this.name = 'McpHttpError'
  }
}

/** The server forgot our session (it restarted): the client starts a new one and repeats the request once. */
class SessionGone extends McpHttpError {
  constructor() {
    super('the MCP session is gone (the server restarted)', 'protocol')
  }
}

export interface McpHttpOptions {
  url: string
  /** The name used in error messages: `Pixel Studio`, `Chiptune Studio`. */
  label: string
  /** The error text when nothing answers (how to start it). */
  notRunningHint: string
  /** Timeout of `initialize` and the short calls. Default 15 s. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** A bearer token: sent as `Authorization: Bearer <token>` on every request. */
  token?: string | null
  /** The variable that holds the token, named in the message when the app answers 401. */
  tokenVar?: string
  /**
   * Called once per call when nothing answers at the URL (kind `unreachable`; never for a timeout, an HTTP error or a tool error). It may start
   * the service: `true` means it answers now and the call is retried once; a string is the reason it does not, appended to the error.
   */
  ensureUp?: (signal?: AbortSignal) => Promise<true | string>
}

/**
 * The token of an app, first match wins: the environment variable `varName`, the credential store (same account name), then `configured`
 * (the optional field in config/studios.md or config/voice.md). Null when there is none.
 */
export function resolveToken(varName: string, configured: string | undefined, env: NodeJS.ProcessEnv = process.env, getKey?: StoredKeyGetter): string | null {
  const found = getKey ? resolveKey(varName, getKey, env) : resolveKey(varName, undefined, env)
  return found || configured?.trim() || null
}

export interface McpCallResult {
  /** The text items joined with newlines. */
  text: string
  /** The text without the trailing JSON object item: what a person reads. */
  human: string
  /** The structured answer: `structuredContent`, else the last text item that parses to a JSON object, else null. */
  json: Record<string, unknown> | null
}

export interface McpCallOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface McpToolInfo {
  name: string
  description?: string
}

export interface McpHttpClient {
  readonly url: string
  /** Calls a tool. Throws `McpHttpError` (kind `tool` when the tool answered `isError`). */
  callTool(name: string, args: object, opts?: McpCallOptions): Promise<McpCallResult>
  listTools(opts?: McpCallOptions): Promise<McpToolInfo[]>
}

export const PROTOCOL_VERSION = '2025-06-18'

interface RpcMessage {
  jsonrpc?: string
  id?: number | string | null
  result?: unknown
  error?: { code: number; message: string }
}

/** The JSON-RPC message with this id from a response body: plain JSON, or SSE `data:` events. */
export function parseRpcBody(body: string, contentType: string, id: number): RpcMessage | null {
  const pick = (v: unknown): RpcMessage | null => {
    const list = Array.isArray(v) ? v : [v]
    for (const m of list) if (m && typeof m === 'object' && (m as RpcMessage).id === id) return m as RpcMessage
    return null
  }
  if (/text\/event-stream/i.test(contentType)) {
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n')
      if (!data.trim()) continue
      try {
        const m = pick(JSON.parse(data))
        if (m) return m
      } catch {
        /* a comment or a partial event */
      }
    }
    return null
  }
  try {
    return pick(JSON.parse(body))
  } catch {
    return null
  }
}

/** The structured answer of a tool result: the last text item that is a JSON object (the studios put theirs last), else null. */
export function parseResultJson(content: { type?: string; text?: string }[] | undefined, structured?: unknown): Record<string, unknown> | null {
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) return structured as Record<string, unknown>
  const items = content ?? []
  for (let i = items.length - 1; i >= 0; i--) {
    const text = items[i]?.text
    if (typeof text !== 'string') continue
    try {
      const v: unknown = JSON.parse(text)
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch {
      /* human-readable text */
    }
  }
  return null
}

function combine(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([t, signal]) : t
}

export function createMcpClient(opts: McpHttpOptions): McpHttpClient {
  const { url, label } = opts
  const timeoutMs = opts.timeoutMs ?? 15_000
  const doFetch = opts.fetchImpl ?? fetch
  let nextId = 1
  let ready: Promise<void> | null = null
  let session: string | null = null
  let version = PROTOCOL_VERSION

  async function post(message: object, ms: number, signal: AbortSignal | undefined): Promise<{ status: number; text: string; type: string; headers: Headers }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`
    if (session) headers['Mcp-Session-Id'] = session
    if ('method' in message && (message as { method: string }).method !== 'initialize') headers['MCP-Protocol-Version'] = version
    try {
      const res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(message), signal: combine(ms, signal) })
      return { status: res.status, text: await res.text(), type: res.headers.get('content-type') ?? '', headers: res.headers }
    } catch (e) {
      if (signal?.aborted) throw new McpHttpError('stopped', 'aborted')
      const name = (e as Error).name
      if (name === 'TimeoutError' || name === 'AbortError') throw new McpHttpError(`${label} did not answer within ${Math.round(ms / 1000)} s`, 'timeout')
      throw new McpHttpError(opts.notRunningHint, 'unreachable')
    }
  }

  async function rpc(method: string, params: object, ms: number, signal?: AbortSignal): Promise<unknown> {
    const id = nextId++
    const r = await post({ jsonrpc: '2.0', id, method, params }, ms, signal)
    if (r.status === 401) throw new McpHttpError(`${label} rejected the token: set ${opts.tokenVar ?? 'its token variable'} to the token shown in its Settings -> MCP`, 'http')
    if (r.status === 404 && session && method !== 'initialize') {
      session = null
      ready = null
      throw new SessionGone()
    }
    if (r.status === 403) throw new McpHttpError(`${label} refused the request (HTTP 403: Host or Origin not allowed)`, 'http')
    if (r.status < 200 || r.status >= 300) throw new McpHttpError(`${label} answered HTTP ${r.status}${r.text ? `: ${r.text.slice(0, 200)}` : ''}`, 'http')
    const msg = parseRpcBody(r.text, r.type, id)
    if (!msg) throw new McpHttpError(`${label} sent an answer that is not MCP: ${r.text.slice(0, 120)}`, 'protocol')
    if (msg.error) throw new McpHttpError(`${label}: ${msg.error.message}`, 'protocol')
    if (method === 'initialize') {
      const sid = r.headers.get('mcp-session-id')
      if (sid) session = sid
      const v = (msg.result as { protocolVersion?: string } | undefined)?.protocolVersion
      if (v) version = v
    }
    return msg.result
  }

  function init(signal?: AbortSignal): Promise<void> {
    ready ??= (async () => {
      await rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'cartoon-studio', version: '1' } }, timeoutMs, signal)
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, timeoutMs, signal)
    })().catch((e) => {
      ready = null // try again next time (the app may have been started since)
      throw e
    })
    return ready
  }

  async function request(method: string, params: object, ms: number, signal?: AbortSignal): Promise<unknown> {
    let asked = false
    let renewed = false
    for (;;) {
      try {
        await init(signal)
        try {
          return await rpc(method, params, ms, signal)
        } catch (e) {
          if (e instanceof McpHttpError && e.kind === 'unreachable') ready = null
          throw e
        }
      } catch (e) {
        if (e instanceof SessionGone && !renewed) {
          renewed = true
          continue
        }
        if (!(e instanceof McpHttpError) || e.kind !== 'unreachable' || !opts.ensureUp || asked) throw e
        asked = true
        const up = await opts.ensureUp(signal)
        if (up !== true) throw new McpHttpError(`${e.message} (auto-start: ${up})`, 'unreachable')
        ready = null
      }
    }
  }

  return {
    url,
    async callTool(name, args, o = {}) {
      const result = (await request('tools/call', { name, arguments: args }, o.timeoutMs ?? timeoutMs, o.signal)) as {
        isError?: boolean
        structuredContent?: unknown
        content?: { type: string; text?: string }[]
      }
      const text = (result?.content ?? []).map((c) => c.text ?? '').join('\n')
      if (result?.isError) throw new McpHttpError(text || `${name} failed`, 'tool')
      const json = parseResultJson(result?.content, result?.structuredContent)
      const items = [...(result?.content ?? [])]
      const last = items[items.length - 1]
      if (json && last?.text !== undefined && result?.structuredContent === undefined) items.pop()
      return { text, human: items.map((c) => c.text ?? '').join('\n'), json }
    },
    async listTools(o = {}) {
      const r = (await request('tools/list', {}, o.timeoutMs ?? timeoutMs, o.signal)) as { tools?: McpToolInfo[] }
      return (r?.tools ?? []).map((t) => ({ name: t.name, description: t.description }))
    }
  }
}
