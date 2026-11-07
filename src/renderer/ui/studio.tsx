import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Lang } from '../../shared/contracts'
import type { SeriesRunState, VoiceLineStatus } from '../../shared/protocol'
import { normalizeSeries, ToolError, useTool } from '../lib/studio'
import type { SeriesInfo, ToolState } from '../lib/studio'
import { useCts } from '../store/hooks'
import { ctsStore } from '../store/store'
import { Empty, ErrorBox, Loading, Pill } from './common'
import type { Tone } from './common'

/** The pieces the eight views share. */

export type SeriesView = ToolState<SeriesInfo> & { slug: string | null }

/** Reads the chosen series (bible, run state). The shell calls it once and hands it to the views through `SeriesProvider`. */
export function useSeriesInfo(): SeriesView {
  const slug = useCts((s) => s.selection.series)
  const t = useTool('cts_series_get', slug ? { series: slug } : null, normalizeSeries)
  return { ...t, slug }
}

const SeriesContext = createContext<SeriesView>({ data: null, error: null, loading: false, reload: () => undefined, slug: null })
export const SeriesProvider = SeriesContext.Provider
/** The chosen series as the shell read it. */
export const useSeries = () => useContext(SeriesContext)

/** The series is not chosen yet, or there is none. */
export function NeedSeries({ testId = 'need-series' }: { testId?: string }) {
  const loaded = useCts((s) => s.seriesLoaded)
  const count = useCts((s) => s.series.length)
  return (
    <Empty title={loaded && count === 0 ? 'No series yet' : 'Choose a series'} testId={testId}>
      <p>{loaded && count === 0 ? 'Ask Claude Code to start one (cts_run_pipeline), then it shows up here.' : 'Pick a series in the left column.'}</p>
    </Empty>
  )
}

/**
 * What a view shows while its tool has not answered: nothing when it did, a bar while it runs, and when the engine has no such tool yet (the
 * module that adds it is not built into this engine) a plain note saying which tool it waits for.
 */
export function ToolGate({ state, tool, children, testId }: { state: ToolState<unknown>; tool: string; children: ReactNode; testId: string }) {
  if (state.error) {
    const e: ToolError = state.error
    if (e.missing)
      return (
        <div className="state coming" data-testid={`${testId}-waiting`}>
          <div className="state-body">
            <p>
              This view reads <code>{tool}</code>, which this engine does not have yet.
            </p>
          </div>
        </div>
      )
    return <ErrorBox title={`${tool} failed`} message={e.message} onRetry={state.reload} testId={`${testId}-error`} />
  }
  if (state.loading && !state.data) return <Loading label={`Reading ${tool}`} testId={`${testId}-loading`} />
  if (!state.data) return null
  return <>{children}</>
}

const RUN_TONE: Record<SeriesRunState, Tone> = { idle: 'dim', running: 'accent', 'waiting-on-user': 'warn', 'waiting-on-client': 'warn', failed: 'bad', done: 'good' }
const RUN_LABEL: Record<SeriesRunState, string> = {
  idle: 'idle',
  running: 'running',
  'waiting-on-user': 'waiting for you',
  'waiting-on-client': 'waiting for Claude Code',
  failed: 'failed',
  done: 'done'
}

/** The run state of a series' pipeline; the live value from the events wins over the one the tool read. */
export function RunStatePill({ series, read }: { series: string; read?: SeriesRunState | null }) {
  const live = useCts((s) => s.runState[series])
  const state = live ?? read ?? null
  if (!state) return null
  return (
    <Pill tone={RUN_TONE[state]} testId="run-state">
      {RUN_LABEL[state]}
    </Pill>
  )
}

const VOICE_TONE: Record<VoiceLineStatus, Tone> = { pending: 'dim', running: 'accent', ok: 'good', placeholder: 'warn', failed: 'bad' }
const VOICE_LABEL: Record<VoiceLineStatus, string> = { pending: 'not made', running: 'making', ok: 'ok', placeholder: 'placeholder', failed: 'failed' }

export function VoicePill({ status, testId, title }: { status: VoiceLineStatus; testId?: string; title?: string }) {
  return (
    <Pill tone={VOICE_TONE[status]} testId={testId} title={title}>
      {VOICE_LABEL[status]}
    </Pill>
  )
}

export const LANG_NAME: Record<Lang, string> = { hr: 'Croatian', en: 'English' }

/** A picture with a quiet frame; a missing file shows the caption instead of a broken icon. */
export function Picture({ src, alt, testId, className }: { src: string | null | undefined; alt: string; testId?: string; className?: string }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [src])
  if (!src || broken)
    return (
      <div className={`picture none ${className ?? ''}`} data-testid={testId ? `${testId}-none` : undefined}>
        <span className="dim">{src ? 'file missing' : 'not made yet'}</span>
      </div>
    )
  return <img className={`picture ${className ?? ''}`} src={src} alt={alt} onError={() => setBroken(true)} data-testid={testId} />
}

/** Plays one audio file; the button is its own play/stop toggle. */
export function PlayButton({ src, label, testId, disabled, onFail }: { src: string | null; label: string; testId: string; disabled?: boolean; onFail?: () => void }) {
  const [audio] = useState(() => (typeof Audio === 'undefined' ? null : new Audio()))
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!audio) return
    const end = () => setPlaying(false)
    audio.addEventListener('ended', end)
    audio.addEventListener('pause', end)
    const fail = () => {
      setPlaying(false)
      onFail?.()
    }
    audio.addEventListener('error', fail)
    return () => {
      audio.removeEventListener('error', fail)
      audio.removeEventListener('ended', end)
      audio.removeEventListener('pause', end)
      audio.pause()
    }
  }, [audio, onFail])
  const toggle = () => {
    if (!audio || !src) return
    if (playing) {
      audio.pause()
      return
    }
    audio.src = src
    void audio.play().then(() => setPlaying(true), () => undefined)
  }
  return (
    <button className="play" onClick={toggle} disabled={disabled || !src} aria-pressed={playing} aria-label={`${playing ? 'Stop' : 'Play'} ${label}`} data-testid={testId}>
      <span aria-hidden="true">{playing ? '■' : '▶'}</span>
    </button>
  )
}

/** Picks the first series or episode when none is chosen. Mounted once in the shell. */
export function useAutoSelect(info: SeriesInfo | null): void {
  const series = useCts((s) => s.series)
  const loaded = useCts((s) => s.seriesLoaded)
  const sel = useCts((s) => s.selection)
  useEffect(() => {
    if (!loaded) return
    const st = ctsStore.getState()
    if (sel.series && !series.some((x) => x.slug === sel.series)) st.select({ series: null })
    else if (!sel.series && series[0]) st.select({ series: series[0].slug })
  }, [loaded, series, sel.series])
  useEffect(() => {
    if (!info || !sel.series) return
    const st = ctsStore.getState()
    const eps = info.episodes
    if (!sel.episode || !eps.some((e) => e.id === sel.episode)) st.select({ episode: eps[0]?.id ?? null })
    if (!sel.cast || !(info.bible.cast ?? []).some((c) => c.id === sel.cast)) st.select({ cast: info.bible.cast?.[0]?.id ?? null })
    if (!sel.set || !(info.bible.sets ?? []).some((x) => x.id === sel.set)) st.select({ set: info.bible.sets?.[0]?.id ?? null })
  }, [info, sel.series, sel.episode, sel.cast, sel.set])
}
