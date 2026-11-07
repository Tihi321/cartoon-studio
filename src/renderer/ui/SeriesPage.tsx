import { useEffect } from 'react'
import { sendCommand } from '../api'
import { mcpSnippets } from '../lib/mcp'
import { useCts } from '../store/hooks'
import { CopyLine, Empty, ErrorBox, Loading } from './common'

/** The Series view: every series of the data folder. CTS-09 fills it in (pitches, cast, sets, episodes); for now it lists the folders. */
export function SeriesPage() {
  const connected = useCts((s) => s.connected)
  const dataDir = useCts((s) => s.dataDir)
  const series = useCts((s) => s.series)
  const loaded = useCts((s) => s.seriesLoaded)
  const paused = useCts((s) => s.paused)
  const mcp = useCts((s) => s.mcp)

  useEffect(() => {
    if (connected) sendCommand({ type: 'listSeries' })
  }, [connected])

  return (
    <div className="page-body" data-testid="page-series">
      <header className="page-head">
        <h1>Series</h1>
        <div className="head-actions">
          <button onClick={() => sendCommand({ type: 'listSeries' })} disabled={!connected} data-testid="series-refresh">
            Refresh the list
          </button>
        </div>
      </header>
      <p className="lede dim" data-testid="series-status">
        {connected ? `The engine is running${paused ? ' (queue paused)' : ''}. Series live in ${dataDir || 'the data folder'}.` : 'The engine is not connected yet.'}
      </p>
      <p className="dim" data-testid="series-mcp">
        {mcp?.listening ? `MCP server listening at ${mcp.url}` : 'The MCP server is not listening (Settings, MCP server).'}
      </p>

      {!connected && !loaded && <ErrorBox title="The engine is not connected" message="The studio shows series from the engine. Start the app with yarn dev, or the engine alone with yarn engine, and this page fills in." testId="series-offline" />}
      {connected && !loaded && <Loading label="Reading the series" testId="series-loading" />}
      {loaded && series.length === 0 && <SeriesEmpty url={mcp?.url ?? null} tokenSet={!!mcp?.tokenSet} />}

      {series.length > 0 && (
        <ul className="course-grid" data-testid="series-list">
          {series.map((s) => (
            <li key={s.slug} className="course-card" data-testid={`series-${s.slug}`}>
              <div className="card-body">
                <h2 className="cover-title">{s.title}</h2>
                <span className="card-line dim card-date">Changed {new Date(s.updatedAt).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' })}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** No series yet: how to start one. */
function SeriesEmpty({ url, tokenSet }: { url: string | null; tokenSet: boolean }) {
  const snip = mcpSnippets(url ?? 'http://127.0.0.1:7465/mcp', tokenSet)
  return (
    <Empty title="No series yet" testId="series-empty">
      <p>A series is a folder in the data folder: its cast, sets, music and episodes. The series tools arrive with the next tickets (see ROADMAP.md).</p>
      <h3>Ask Claude Code to do the model work</h3>
      <p>Connect Claude Code to the studio once. It answers the model calls of the agents (the showrunner, the writer and the others).</p>
      <CopyLine text={snip.http} label="connect Claude Code to the MCP server" testId="empty-mcp" />
    </Empty>
  )
}
