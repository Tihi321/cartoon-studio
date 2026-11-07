import { useCallback, useEffect, useRef, useState } from 'react'
import type { Bible, BudgetFile, Episode, Lang, Rig, RigVariant, SetFile, SpendEntry, TextCatalog, VoiceManifest } from '../../shared/contracts'
import type { SeriesRunState } from '../../shared/protocol'
import { seriesFileUrl } from '../api'
import { useCts } from '../store/hooks'

/**
 * The thin client layer between the views and the engine. Every read and action is one MCP tool, run through `window.cartoonstudio.call`
 * (the same `callTool` the MCP server uses), so the studio and Claude Code drive the same engine. The shapes below are what the views expect
 * from the tools of the series store, voice, render and budget modules; `normalize*` also accepts a slightly different answer (a bare
 * bible instead of `{bible}`). A tool that does not exist yet (the engine says `unknown tool`) is shown as "waiting for <tool>".
 */

export class ToolError extends Error {
  constructor(
    readonly tool: string,
    message: string
  ) {
    super(message)
  }
  /** The engine has no such tool (yet). */
  get missing(): boolean {
    return /unknown tool/i.test(this.message)
  }
}

/** Runs one tool. Throws a ToolError with the engine's reason. */
export async function callTool<T = Record<string, unknown>>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const api = typeof window !== 'undefined' ? window.cartoonstudio : undefined
  if (!api?.call) throw new ToolError(tool, 'the engine is not connected')
  const r = await api.call(tool, args)
  if (!r.ok) throw new ToolError(tool, r.error ?? `${tool} failed`)
  return (r.result ?? {}) as T
}

export interface ToolState<T> {
  data: T | null
  error: ToolError | null
  loading: boolean
  reload(): void
}

/**
 * Runs a tool when `args` is not null and again when they change, when `reload()` is called and after every engine event that changes data
 * (`dataTick`: a job ended, a clip was made, a pitch was chosen). `map` turns the tool's answer into what the view uses.
 */
export function useTool<T>(tool: string, args: Record<string, unknown> | null, map: (r: Record<string, unknown>) => T = (r) => r as T): ToolState<T> {
  const tick = useCts((s) => s.dataTick)
  const connected = useCts((s) => s.connected)
  const [state, setState] = useState<{ data: T | null; error: ToolError | null; loading: boolean }>({ data: null, error: null, loading: args !== null })
  const [manual, setManual] = useState(0)
  const key = JSON.stringify(args)
  const mapRef = useRef(map)
  mapRef.current = map
  useEffect(() => {
    if (args === null || !connected) {
      setState({ data: null, error: null, loading: false })
      return
    }
    let live = true
    setState((s) => ({ ...s, loading: true }))
    callTool(tool, args).then(
      (r) => live && setState({ data: mapRef.current(r), error: null, loading: false }),
      (e: unknown) => live && setState({ data: null, error: e instanceof ToolError ? e : new ToolError(tool, String(e)), loading: false })
    )
    return () => {
      live = false
    }
  }, [tool, key, tick, manual, connected])
  const reload = useCallback(() => setManual((n) => n + 1), [])
  return { ...state, reload }
}

// ---- what the tools answer ----

export interface SeriesInfo {
  bible: Bible
  state: SeriesRunState | null
  step: string | null
}
/** `cts_series_get { series }` -> `{ bible, state?, step? }` (or the bible itself). */
export function normalizeSeries(r: Record<string, unknown>): SeriesInfo {
  const bible = (r.bible ?? r) as Bible
  return { bible, state: (r.state as SeriesRunState | undefined) ?? null, step: (r.step as string | undefined) ?? null }
}

export interface VariantInfo {
  variant: RigVariant
  state: 'done' | 'running' | 'not-run'
  /** Wall time of the path, seconds. */
  seconds?: number
  costUsd?: number
  credits?: number
  note?: string
  /** A picture of the rig made by that path, relative to the series folder. */
  preview?: string | null
  /** The variant the pilot film uses. */
  chosen?: boolean
}
export interface CastInfo {
  id: string
  rig: Rig | null
  /** The reference image and the pose sheet, relative to the series folder. */
  ref: string | null
  sheet: string | null
  variants: VariantInfo[]
  /** The audition clip per language, relative to the series folder. */
  audition: Partial<Record<Lang, string>>
}
/** `cts_cast_get { series, cast }` -> CastInfo. */
export function normalizeCast(r: Record<string, unknown>): CastInfo {
  const c = r as Partial<CastInfo> & { id?: string }
  return { id: c.id ?? '', rig: c.rig ?? null, ref: c.ref ?? null, sheet: c.sheet ?? null, variants: c.variants ?? [], audition: c.audition ?? {} }
}

/** `cts_set_get { series, set }` -> `{ set }`. */
export function normalizeSet(r: Record<string, unknown>): SetFile {
  return (r.set ?? r) as SetFile
}

export interface RenderInfo {
  lang: Lang
  quality: 'preview' | 'final'
  /** The MP4, relative to the series folder. */
  file: string
  seconds: number
  wallSeconds: number
  encoder: string
}
export interface EpisodeInfo {
  episode: Episode
  text: Partial<Record<Lang, TextCatalog>>
  voice: Partial<Record<Lang, VoiceManifest>>
  renders: RenderInfo[]
  state: SeriesRunState | null
}
/** `cts_episode_get { series, episode }` -> EpisodeInfo. */
export function normalizeEpisode(r: Record<string, unknown>): EpisodeInfo {
  const e = r as Partial<EpisodeInfo>
  return { episode: (e.episode ?? r) as Episode, text: e.text ?? {}, voice: e.voice ?? {}, renders: e.renders ?? [], state: e.state ?? null }
}

export interface BudgetInfo {
  budget: BudgetFile | null
  spentUsd: number
  spentCredits: number
  ledger: SpendEntry[]
}
/** `cts_budget_get { series, episode }` -> BudgetInfo. */
export function normalizeBudget(r: Record<string, unknown>): BudgetInfo {
  const b = r as Partial<BudgetInfo>
  return { budget: b.budget ?? null, spentUsd: b.spentUsd ?? 0, spentCredits: b.spentCredits ?? 0, ledger: b.ledger ?? [] }
}

/** One finding of `cts_lint` / `cts_rig_check` (src/engine/series/lint.ts `LintIssue`). */
export interface IssueView {
  code: string
  severity: 'error' | 'warning'
  message: string
  file?: string
  where?: string
  lang?: Lang
}
/** `cts_rig_check { series, cast, variant? }`. */
export interface RigCheckView {
  cast: string
  variant?: RigVariant
  ok: boolean
  parts: number
  issues: IssueView[]
}
/** `cts_lint { series, episode? }`. */
export interface LintView {
  series: string
  episode?: string
  ok: boolean
  errors: IssueView[]
  warnings: IssueView[]
  rigs: RigCheckView[]
  stats: { lines: { lang: Lang; line: string; speaker: string; frames: number; nonRest: number; share: number }[]; minShare: number | null }
}

/** One row of `cts_client_tasks` (the client queue's waiting and leased tasks). */
export interface ClientTaskRow {
  id: string
  job: string
  role: string
  task: string
  book: string
  agent: string
  unit: string
  client: string
  state: 'waiting' | 'leased'
  ageMs: number
  leaseMsLeft?: number
  /** A short summary of the prompt, when the engine gives one. */
  summary?: string
}

// ---- files and the player ----

/** URL of a file of a series, from its folder-relative path (`cast/mia/ref.png`). */
export const seriesFile = (series: string, rel: string) => seriesFileUrl(`series/${series}/${rel}`)
/** URL of a file of an episode (`voice/hr/l01.wav`, as the manifest writes it). */
export const episodeFile = (series: string, episode: string, rel: string) => seriesFileUrl(`series/${series}/episodes/${episode}/${rel}`)

/** The engine's HTTP origin (from the MCP url, `http://127.0.0.1:7465/mcp`), or null while the MCP server is not listening. */
export function engineOrigin(mcpUrl: string | null | undefined): string | null {
  if (!mcpUrl) return null
  try {
    return new URL(mcpUrl).origin
  } catch {
    return null
  }
}

/**
 * The player page of the engine (`/preview/`). `preview=1` shows its own controls (play, scrub); `series`, `episode` and `lang`
 * choose the timeline, `sheet=<cast id>` the pose sheet of a cast member. T3 documents the parameters in docs/player.md.
 */
export function playerUrl(origin: string, q: { series: string; episode?: string; lang?: Lang; sheet?: string }): string {
  const p = new URLSearchParams({ preview: '1', series: q.series })
  if (q.episode) p.set('episode', q.episode)
  if (q.lang) p.set('lang', q.lang)
  if (q.sheet) p.set('sheet', q.sheet)
  return `${origin}/preview/?${p.toString()}`
}

export const seconds = (n: number) => `${n.toFixed(1)} s`

/** `3 min 12 s` / `48 s`, for render times. */
export function duration(n: number): string {
  if (n < 60) return `${Math.round(n)} s`
  return `${Math.floor(n / 60)} min ${String(Math.round(n % 60)).padStart(2, '0')} s`
}
