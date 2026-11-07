import { useState } from 'react'
import { LANGS } from '../../shared/contracts'
import type { Lang } from '../../shared/contracts'
import { callTool, engineOrigin, playerUrl } from '../lib/studio'
import { useCts } from '../store/hooks'
import { Empty } from './common'
import { LANG_NAME, NeedSeries } from './studio'

/**
 * Timeline preview: the engine's player page (/preview/?preview=1, the same player the render uses) in a frame, with its own play, pause and
 * scrub controls. The language switch loads the other timeline; Rebuild makes the timelines again from the script and the voices.
 */
export function PreviewPage() {
  const slug = useCts((s) => s.selection.series)
  const ep = useCts((s) => s.selection.episode)
  const mcp = useCts((s) => s.mcp)
  const [lang, setLang] = useState<Lang>('hr')
  const [rev, setRev] = useState(0)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const origin = mcp?.listening ? engineOrigin(mcp.url) : null

  const rebuild = async () => {
    if (!slug || !ep) return
    setBusy(true)
    setMsg(null)
    try {
      await callTool('cts_timeline_build', { series: slug, episode: ep })
      setMsg({ ok: true, text: 'Timelines rebuilt.' })
      setRev((n) => n + 1)
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page-body wide" data-testid="page-preview">
      <header className="page-head">
        <h1>Timeline preview</h1>
        <div className="head-actions">
          <div className="seg" role="group" aria-label="Language" data-testid="preview-lang">
            {LANGS.map((l) => (
              <button key={l} className={l === lang ? 'seg-item on' : 'seg-item'} aria-pressed={l === lang} onClick={() => setLang(l)} data-testid={`preview-lang-${l}`} title={LANG_NAME[l]}>
                {l}
              </button>
            ))}
          </div>
          <button onClick={() => setRev((n) => n + 1)} disabled={!origin || !slug} data-testid="preview-reload">
            Reload the player
          </button>
          <button onClick={() => void rebuild()} disabled={busy || !slug || !ep} data-testid="preview-rebuild">
            {busy ? 'Rebuilding...' : 'Rebuild the timelines'}
          </button>
        </div>
      </header>
      {msg && (
        <p className={msg.ok ? 'inline-ok' : 'inline-error'} role="status" data-testid="preview-msg">
          {msg.text}
        </p>
      )}
      {!slug && <NeedSeries />}
      {slug && !ep && <p className="dim">This series has no episode yet.</p>}
      {slug && ep && !origin && (
        <Empty title="The player is not reachable" testId="preview-offline">
          <p>The preview page is served by the engine's MCP server. It is not listening; switch it on in Settings, MCP server.</p>
        </Empty>
      )}
      {slug && ep && origin && (
        <div className="player-frame" data-testid="preview-frame">
          <iframe
            key={`${slug}/${ep}/${lang}/${rev}`}
            title={`${ep} in ${LANG_NAME[lang]}`}
            src={playerUrl(origin, { series: slug, episode: ep, lang })}
            allow="autoplay"
            data-testid="preview-player"
          />
        </div>
      )}
      <p className="dim">
        {slug && ep ? `${slug} / ${ep}, ${LANG_NAME[lang]}. ` : ''}The player draws the timeline in the browser the same way the render does, so what you see here is what the MP4 will show.
      </p>
    </div>
  )
}
