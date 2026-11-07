import type { Lang } from '../../shared/contracts'
import type { EngineEvent, SeriesRunState, VoiceLineStatus } from '../../shared/protocol'

/**
 * The episode part of the UI state, as pure reducers (tests/ui-episode.test.ts feeds them engine events):
 *   - each script line's voice status per language (`voice.clip`, `job.progress` of the voice step, or a manifest read with `lineVoiceFromManifest`)
 *   - the run state of each series' pipeline (`series.state`, `pitch.chosen`)
 *   - the jobs the engine reports (`job.started`, `job.progress`, `job.done`)
 *   - `dataTick`, which counts the events that make the views read the engine again
 */

export interface LineVoice {
  status: VoiceLineStatus
  provider?: string
  seconds?: number
  /** Relative to the episode folder. */
  file?: string
  error?: string
}

export interface JobView {
  id: string
  series: string
  task: string
  unit?: string
  state: 'running' | 'done' | 'failed'
  /** 0..1, or null when it cannot tell. */
  fraction: number | null
  message?: string
  agent?: string
  /** ms since epoch. */
  startedAt: number
  endedAt?: number
  error?: string
  result?: string
}

export interface EpisodeData {
  /** `<series>/<episode>` -> lang -> line id -> state. */
  voiceLines: Record<string, Partial<Record<Lang, Record<string, LineVoice>>>>
  /** Series slug -> the run state of its pipeline. */
  runState: Record<string, SeriesRunState>
  /** Series slug -> the pitch the user chose in this session (the bible holds it for good). */
  chosenPitch: Record<string, string>
  jobs: Record<string, JobView>
  /** Grows with every event after which the views should read the engine again (a job ended, a clip was made, a pitch was chosen ...). */
  dataTick: number
}

export const initialEpisode = (): EpisodeData => ({ voiceLines: {}, runState: {}, chosenPitch: {}, jobs: {}, dataTick: 0 })

export const episodeKey = (series: string, episode: string) => `${series}/${episode}`

const PENDING: LineVoice = { status: 'pending' }

/** How a line stands in a language; `pending` when nothing has been heard about it. */
export function lineVoice(s: Pick<EpisodeData, 'voiceLines'>, series: string, episode: string, lang: Lang, line: string): LineVoice {
  return s.voiceLines[episodeKey(series, episode)]?.[lang]?.[line] ?? PENDING
}

/** The voice state of every line of a language as `cts_episode_get` reports it (`ok`/`placeholder`/`failed`); the clip is `voice/<lang>/<line>.wav` of the episode folder. */
export function lineVoiceFromLines(lang: Lang, lines: Record<string, { status: 'ok' | 'placeholder' | 'failed'; provider: string; seconds: number }>): Record<string, LineVoice> {
  const out: Record<string, LineVoice> = {}
  for (const [id, l] of Object.entries(lines)) out[id] = { status: l.status, provider: l.provider, seconds: l.seconds, file: `voice/${lang}/${id}.wav` }
  return out
}

/** Puts the lines of a manifest into the state without touching a line that is being made now. */
export function seedVoice(s: EpisodeData, series: string, episode: string, lang: Lang, lines: Record<string, LineVoice>): Partial<EpisodeData> {
  const key = episodeKey(series, episode)
  const cur = s.voiceLines[key]?.[lang] ?? {}
  const merged: Record<string, LineVoice> = { ...lines }
  for (const [id, l] of Object.entries(cur)) if (l.status === 'running') merged[id] = l
  return { voiceLines: { ...s.voiceLines, [key]: { ...s.voiceLines[key], [lang]: merged } } }
}

function setLine(s: EpisodeData, series: string, episode: string, lang: Lang, line: string, v: LineVoice): Partial<EpisodeData> {
  const key = episodeKey(series, episode)
  const byLang = s.voiceLines[key] ?? {}
  return { voiceLines: { ...s.voiceLines, [key]: { ...byLang, [lang]: { ...byLang[lang], [line]: v } } } }
}

/** Pure reducer for the episode events. Returns only what changed. */
export function reduceEpisode(s: EpisodeData, e: EngineEvent, now = Date.now()): Partial<EpisodeData> {
  switch (e.type) {
    case 'voice.clip':
      return {
        ...setLine(s, e.series, e.episode, e.lang, e.line, { status: e.status, provider: e.provider, seconds: e.seconds, file: e.file, error: e.error }),
        dataTick: s.dataTick + 1
      }
    case 'job.started': {
      const series = e.book ?? e.jobId.split('--')[0] ?? ''
      const prev = s.jobs[e.jobId]
      const job: JobView = { ...prev, id: e.jobId, series, task: e.task, unit: prev?.unit, state: 'running', fraction: prev?.fraction ?? null, agent: e.agent, startedAt: prev?.startedAt ?? now }
      return { jobs: { ...s.jobs, [e.jobId]: job } }
    }
    case 'job.progress': {
      const prev = s.jobs[e.jobId]
      const job: JobView = { ...prev, id: e.jobId, series: e.series, task: e.task, unit: e.unit ?? prev?.unit, state: 'running', fraction: e.fraction, message: e.message ?? prev?.message, startedAt: prev?.startedAt ?? now }
      const out: Partial<EpisodeData> = { jobs: { ...s.jobs, [e.jobId]: job } }
      // the voice step says which clip it is making (also one it makes again): that line shows as running until its voice.clip comes
      if (e.task === 'voice' && e.episode && e.lang && e.line) Object.assign(out, setLine(s, e.series, e.episode, e.lang, e.line, { ...lineVoice(s, e.series, e.episode, e.lang, e.line), status: 'running' }))
      return out
    }
    case 'job.done': {
      const prev = s.jobs[e.jobId]
      const job: JobView = {
        id: e.jobId,
        series: prev?.series ?? e.jobId.split('--')[0] ?? '',
        task: prev?.task ?? e.jobId.split('--')[1] ?? '',
        unit: prev?.unit,
        state: e.ok ? 'done' : 'failed',
        fraction: e.ok ? 1 : (prev?.fraction ?? null),
        message: prev?.message,
        agent: prev?.agent ?? e.agent,
        startedAt: prev?.startedAt ?? now,
        endedAt: now,
        error: e.error,
        result: e.result
      }
      return { jobs: { ...s.jobs, [e.jobId]: job }, dataTick: s.dataTick + 1 }
    }
    case 'series.state':
      return { runState: { ...s.runState, [e.series]: e.state }, dataTick: s.dataTick + 1 }
    case 'pitch.chosen': {
      // the pipeline leaves waiting-on-user as soon as a pitch is chosen
      const was = s.runState[e.series]
      return { chosenPitch: { ...s.chosenPitch, [e.series]: e.pitch }, runState: { ...s.runState, [e.series]: was === undefined || was === 'waiting-on-user' || was === 'idle' ? 'running' : was }, dataTick: s.dataTick + 1 }
    }
    default:
      return {}
  }
}
