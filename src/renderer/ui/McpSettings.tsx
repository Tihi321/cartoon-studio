import { useEffect, useState } from 'react'
import { sendCommand } from '../api'
import { mcpSnippets } from '../lib/mcp'
import { useCts } from '../store/hooks'
import { Pill } from './common'

/** The MCP server of the engine (config/mcp.md): status, on/off, port and token, and how to connect. */
export function McpSettings() {
  const mcp = useCts((s) => s.mcp)
  const connected = useCts((s) => s.connected)
  const [port, setPort] = useState<string | null>(null)
  const [token, setToken] = useState('')
  useEffect(() => {
    if (connected) sendCommand({ type: 'mcpStatus' })
  }, [connected])
  // filled once from the engine; a later status does not undo what you type
  useEffect(() => {
    if (mcp && port === null) setPort(String(mcp.port))
  }, [mcp, port])

  const portNum = Number(port)
  const portOk = port !== null && /^\d+$/.test(port.trim()) && portNum >= 0 && portNum <= 65535
  const save = (patch: { enabled?: boolean; token?: string } = {}) => {
    if (!mcp || !portOk) return
    sendCommand({ type: 'saveMcpConfig', enabled: patch.enabled ?? mcp.enabled, port: portNum, ...(patch.token !== undefined ? { token: patch.token } : {}) })
  }
  const snippets = mcpSnippets(mcp?.url ?? `http://127.0.0.1:${portOk ? portNum : (mcp?.port ?? 7463)}/mcp`, !!mcp?.tokenSet)

  return (
    <div className="stack" data-testid="mcp-settings">
      <div className="row">
        {!mcp && <span className="dim">Waiting for the engine...</span>}
        {mcp?.listening && <Pill tone="good" testId="mcp-listening">listening on {mcp.url}</Pill>}
        {mcp && !mcp.listening && !mcp.error && <Pill tone="warn" testId="mcp-off">{mcp.enabled ? 'not listening' : 'off'}</Pill>}
        {mcp?.error && (
          <span className="warn" data-testid="mcp-error">
            {mcp.error}
          </span>
        )}
      </div>
      <label className="row">
        <input type="checkbox" checked={mcp?.enabled === true} disabled={!mcp} data-testid="mcp-enabled" onChange={(e) => save({ enabled: e.target.checked })} />
        Let other programs drive Cartoon Studio through MCP (this computer only)
      </label>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input style={{ width: 100 }} aria-label="MCP port" value={port ?? ''} placeholder="7463" onChange={(e) => setPort(e.target.value)} onBlur={() => save()} onKeyDown={(e) => e.key === 'Enter' && save()} data-testid="mcp-port" />
        <input
          type="password"
          autoComplete="off"
          aria-label="MCP token"
          style={{ flex: 1, minWidth: 0 }}
          value={token}
          placeholder={mcp?.tokenSet ? 'A token is set. Type to replace' : 'Optional token (clients send it as a bearer token)'}
          onChange={(e) => setToken(e.target.value)}
          data-testid="mcp-token"
        />
        <button
          disabled={!token}
          onClick={() => {
            save({ token })
            setToken('')
          }}
          data-testid="mcp-token-save"
        >
          Set token
        </button>
        <button disabled={!mcp?.tokenSet} onClick={() => save({ token: '' })} data-testid="mcp-token-clear">
          Clear
        </button>
      </div>
      <p className="dim">Connect Claude Code (the commands are plain text: select and copy)</p>
      <input readOnly aria-label="Command that connects Claude Code over HTTP" value={snippets.http} onFocus={(e) => e.target.select()} data-testid="mcp-snippet-http" />
      <input readOnly aria-label="Command that connects Claude Code over stdio" value={snippets.stdio} onFocus={(e) => e.target.select()} data-testid="mcp-snippet-stdio" />
      <input readOnly aria-label="Command that starts the engine without a window" value={snippets.headless} onFocus={(e) => e.target.select()} data-testid="mcp-snippet-headless" />
      <p className="dim">With the window closed, run the headless command: the same server runs without the app. Only one Cartoon Studio engine can use a data folder.</p>
    </div>
  )
}
