// stdio <-> Streamable HTTP relay: raw JSON-RPC messages are forwarded both ways. When the engine cannot be reached, requests are
// answered with a JSON-RPC error (and a line on stderr) instead of hanging.
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

export interface RelayOptions {
  /** The MCP endpoint of the running engine. */
  url: string
  token?: string
  /** The client-facing side (`StdioServerTransport`). */
  stdio: Transport
  log?: (msg: string) => void
}

export interface Relay {
  start(): Promise<void>
  close(): Promise<void>
}

function isRequest(m: JSONRPCMessage): m is JSONRPCMessage & { id: string | number; method: string } {
  return 'method' in m && 'id' in m && m.id !== undefined
}

export function createRelay(opts: RelayOptions): Relay {
  const log = opts.log ?? ((m) => process.stderr.write(`cartoon-studio-mcp: ${m}\n`))
  const http = new StreamableHTTPClientTransport(new URL(opts.url), { requestInit: opts.token ? { headers: { Authorization: `Bearer ${opts.token}` } } : undefined })
  const stdio = opts.stdio

  const fail = async (m: JSONRPCMessage, message: string): Promise<void> => {
    log(message)
    if (isRequest(m)) await stdio.send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message } }).catch(() => undefined)
  }

  stdio.onmessage = (m) => {
    http.send(m).catch((e: unknown) => {
      const err = e as Error
      const cause = (err.cause as { code?: string } | undefined)?.code ?? err.message
      if (/401|nauthorized/.test(err.message)) void fail(m, 'Cartoon Studio rejected the token. Set CTS_MCP_TOKEN to the token in config/mcp.md (Settings > MCP).')
      else if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH/.test(`${err.message} ${cause}`)) void fail(m, `Cartoon Studio is not answering at ${opts.url}: it may have just closed. Retry. (${cause})`)
      else void fail(m, `Request to Cartoon Studio failed: ${err.message}`)
    })
  }
  http.onmessage = (m) => {
    void stdio.send(m).catch((e: unknown) => log(`stdout write failed: ${String(e)}`))
  }
  http.onerror = (e) => {
    // closing aborts the event stream: that is not an error
    if (!/AbortError/.test(e.message)) log(`connection error: ${e.message}`)
  }
  stdio.onerror = (e) => log(`stdio error: ${e.message}`)
  stdio.onclose = () => void http.close().catch(() => undefined)

  return {
    async start() {
      await http.start()
      await stdio.start()
    },
    async close() {
      await http.close().catch(() => undefined)
      await stdio.close().catch(() => undefined)
    }
  }
}
