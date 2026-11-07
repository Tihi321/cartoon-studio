import { useEffect, useState } from 'react'
import type { Bible, Pitch } from '../../shared/contracts'
import type { SeriesRunState } from '../../shared/protocol'
import { sendCommand } from '../api'
import { callTool } from '../lib/studio'
import { useCts } from '../store/hooks'
import { ctsStore } from '../store/store'
import { Empty, ErrorBox, Field, Loading, Pill } from './common'
import { NeedSeries, RunStatePill, ToolGate, useSeries } from './studio'

/**
 * Series and bible: the series of the data folder, the three premises the showrunner pitched (choose one and the pipeline goes on; nothing
 * visual is made before), and the bible's fields.
 */
export function SeriesPage() {
  const connected = useCts((s) => s.connected)
  const series = useCts((s) => s.series)
  const loaded = useCts((s) => s.seriesLoaded)
  const sel = useCts((s) => s.selection.series)
  const info = useSeries()

  useEffect(() => {
    if (connected) sendCommand({ type: 'listSeries' })
  }, [connected])

  return (
    <div className="page-body" data-testid="page-series">
      <header className="page-head">
        <h1>Series and bible</h1>
        <div className="head-actions">
          <button onClick={() => sendCommand({ type: 'listSeries' })} disabled={!connected} data-testid="series-refresh">
            Refresh the list
          </button>
        </div>
      </header>

      {!connected && !loaded && <ErrorBox title="The engine is not connected" message="The studio shows series from the engine. Start the app with yarn dev, or the engine alone with yarn engine, and this page fills in." testId="series-offline" />}
      {connected && !loaded && <Loading label="Reading the series" testId="series-loading" />}
      {loaded && series.length === 0 && (
        <Empty title="No series yet" testId="series-empty">
          <p>A series is a folder in the data folder: its bible, cast, sets, music and episodes. Ask Claude Code to start one with cts_run_pipeline (see docs/mcp-guide.md); the three premises show up here for you to choose from.</p>
        </Empty>
      )}

      {series.length > 0 && (
        <ul className="series-strip" data-testid="series-list">
          {series.map((s) => (
            <li key={s.slug}>
              <button className={s.slug === sel ? 'series-tab on' : 'series-tab'} aria-pressed={s.slug === sel} onClick={() => ctsStore.getState().select({ series: s.slug })} data-testid={`series-${s.slug}`}>
                <span className="series-tab-title">{s.title}</span>
                <span className="dim series-tab-date">{new Date(s.updatedAt).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' })}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {series.length > 0 && !sel && <NeedSeries />}
      {sel && (
        <ToolGate state={info} tool="cts_series_get" testId="series-detail">
          {info.data && <SeriesDetail slug={sel} bible={info.data.bible} read={info.data.state} onChanged={info.reload} />}
        </ToolGate>
      )}
    </div>
  )
}

function SeriesDetail({ slug, bible, read, onChanged }: { slug: string; bible: Bible; read: SeriesRunState | null; onChanged(): void }) {
  const live = useCts((s) => s.runState[slug])
  const chosen = useCts((s) => s.chosenPitch[slug]) ?? bible.chosenPitch
  const state = live ?? read
  const pitches = bible.pitches ?? []
  return (
    <>
      <section className="sheet panel" aria-labelledby="ser-head" data-testid="series-head">
        <div className="row spread">
          <h2 className="panel-title" id="ser-head">
            {bible.title?.en ?? slug} <span className="dim title-alt">{bible.title?.hr}</span>
          </h2>
          <RunStatePill series={slug} read={read} />
        </div>
        {state === 'waiting-on-user' && (
          <p className="inline-warn" data-testid="series-waiting">
            The pipeline is waiting for you. Choose one of the premises below; nothing visual is made before.
          </p>
        )}
      </section>

      <section aria-labelledby="ser-pitches" data-testid="series-pitches">
        <h2 className="panel-title" id="ser-pitches">
          Premises
        </h2>
        {pitches.length === 0 ? (
          <p className="dim" data-testid="series-no-pitches">
            No premises yet. The showrunner writes three at the start of the pipeline.
          </p>
        ) : (
          <ul className="pitches">
            {pitches.map((p, i) => (
              <PitchCard key={p.id} slug={slug} pitch={p} n={i + 1} chosen={chosen === p.id} anyChosen={!!chosen} onChosen={onChanged} />
            ))}
          </ul>
        )}
      </section>

      <BibleForm key={slug} slug={slug} bible={bible} onSaved={onChanged} />

      {(bible.episodes ?? []).length > 0 && (
        <section className="sheet panel" aria-labelledby="ser-eps" data-testid="series-episodes">
          <h2 className="panel-title" id="ser-eps">
            Episodes
          </h2>
          <ul className="plain">
            {bible.episodes.map((e) => (
              <li key={e.id} className="row spread" data-testid={`series-episode-${e.id}`}>
                <span>
                  <b>{e.id}</b> {e.title.en} <span className="dim">/ {e.title.hr}</span>
                </span>
                <Pill tone={e.status === 'done' ? 'good' : e.status === 'in-progress' ? 'accent' : 'dim'}>{e.status}</Pill>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

function PitchCard({ slug, pitch, n, chosen, anyChosen, onChosen }: { slug: string; pitch: Pitch; n: number; chosen: boolean; anyChosen: boolean; onChosen(): void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const choose = async () => {
    setBusy(true)
    setError(null)
    try {
      await callTool('cts_pitch_choose', { series: slug, pitch: pitch.id })
      // the pipeline leaves waiting-on-user at once; the engine says so too (pitch.chosen)
      ctsStore.getState().applyEvents([{ type: 'pitch.chosen', series: slug, pitch: pitch.id }])
      onChosen()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className={chosen ? 'pitch chosen' : 'pitch'} data-testid={`pitch-${pitch.id}`}>
      <div className="pitch-no" aria-hidden="true">
        {n}
      </div>
      <h3 className="pitch-title">{pitch.title.en}</h3>
      <p className="pitch-alt dim">{pitch.title.hr}</p>
      <p className="pitch-line">{pitch.logline.en}</p>
      <p className="pitch-line dim">{pitch.logline.hr}</p>
      <dl className="pitch-facts">
        <dt>Leads</dt>
        <dd>{pitch.leads.map((l) => `${l.name} (${l.what})`).join('; ')}</dd>
        <dt>Sets</dt>
        <dd>{pitch.sets.join(', ') || 'none named'}</dd>
        <dt>Why</dt>
        <dd>{pitch.why}</dd>
      </dl>
      {error && (
        <p className="inline-error" role="alert" data-testid={`pitch-${pitch.id}-error`}>
          {error}
        </p>
      )}
      <div className="pitch-foot">
        {chosen ? (
          <Pill tone="good" testId={`pitch-${pitch.id}-chosen`}>
            chosen
          </Pill>
        ) : (
          <button className="primary" disabled={busy || anyChosen} onClick={() => void choose()} data-testid={`pitch-${pitch.id}-choose`}>
            {busy ? 'Choosing...' : 'Choose'}
          </button>
        )}
      </div>
    </li>
  )
}

/** The bible's text fields. Saved with cts_series_update. */
function BibleForm({ slug, bible, onSaved }: { slug: string; bible: Bible; onSaved(): void }) {
  const fromBible = () => ({
    titleEn: bible.title?.en ?? '',
    titleHr: bible.title?.hr ?? '',
    loglineEn: bible.logline?.en ?? '',
    loglineHr: bible.logline?.hr ?? '',
    tone: (bible.tone ?? []).join(', '),
    rules: (bible.rules ?? []).join('\n')
  })
  const [f, setF] = useState(fromBible)
  // the bible changed in the engine (saved here, or edited by Claude Code): show what it says now
  const sig = JSON.stringify(fromBible())
  useEffect(() => setF(JSON.parse(sig) as ReturnType<typeof fromBible>), [sig])
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setF({ ...f, [k]: e.target.value })
    setMsg(null)
  }
  const save = async () => {
    setBusy(true)
    try {
      await callTool('cts_series_update', {
        series: slug,
        title: { en: f.titleEn, hr: f.titleHr },
        logline: { en: f.loglineEn, hr: f.loglineHr },
        tone: f.tone.split(',').map((t) => t.trim()).filter(Boolean),
        rules: f.rules.split('\n').map((t) => t.trim()).filter(Boolean)
      })
      setMsg({ ok: true, text: 'Saved.' })
      onSaved()
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="sheet panel bible" aria-labelledby="ser-bible" data-testid="bible-form">
      <h2 className="panel-title" id="ser-bible">
        Bible
      </h2>
      <div className="grid-2">
        <Field label="Title (English)">{(id) => <input id={id} value={f.titleEn} onChange={set('titleEn')} data-testid="bible-title-en" />}</Field>
        <Field label="Title (Croatian)">{(id) => <input id={id} value={f.titleHr} onChange={set('titleHr')} data-testid="bible-title-hr" />}</Field>
        <Field label="Logline (English)">{(id) => <textarea id={id} rows={3} value={f.loglineEn} onChange={set('loglineEn')} data-testid="bible-logline-en" />}</Field>
        <Field label="Logline (Croatian)">{(id) => <textarea id={id} rows={3} value={f.loglineHr} onChange={set('loglineHr')} data-testid="bible-logline-hr" />}</Field>
      </div>
      <Field label="Tone" hint="Separated by commas.">
        {(id, d) => <input id={id} aria-describedby={d} value={f.tone} onChange={set('tone')} data-testid="bible-tone" />}
      </Field>
      <Field label="Rules" hint="One rule per line. They bind every writer and artist.">
        {(id, d) => <textarea id={id} aria-describedby={d} rows={5} value={f.rules} onChange={set('rules')} data-testid="bible-rules" />}
      </Field>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void save()} data-testid="bible-save">
          {busy ? 'Saving...' : 'Save the bible'}
        </button>
        {msg && (
          <span className={msg.ok ? 'inline-ok' : 'inline-error'} role="status" data-testid="bible-msg">
            {msg.text}
          </span>
        )}
      </div>
    </section>
  )
}
