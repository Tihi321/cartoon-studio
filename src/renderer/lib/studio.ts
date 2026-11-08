import { useCallback, useEffect, useRef, useState } from 'react'
import type { Bible, Episode, Lang, RigVariant, SetFile, SpendEntry, TextCatalog } from '../../shared/contracts'
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

export interface EpisodeRef {
  id: string
  title: { hr: string; en: string }
}
export interface SeriesInfo {
  bible: Bible
  /** The state of the pipeline of the series (the one that waits on the user first), or null when none ran yet. */
  state: SeriesRunState | null
  step: string | null
  hint: string | null
  /** Every episode folder, with the bible title when it has one. */
  episodes: EpisodeRef[]
}
/**
 * `cts_series_get { series }` -> `{ bible, rigs, episodes: string[], pipelines: [{episode, state, step, hint}] }`. A series that has pitches and no
 * chosen one is waiting for the user even before a pipeline file exists.
 */
export function normalizeSeries(r: Record<string, unknown>): SeriesInfo {
  const bible = (r.bible ?? r) as Bible
  const pipes = (r.pipelines as { episode: string; state: SeriesRunState; step: string | null; hint?: string }[] | undefined) ?? []
  const pipe = pipes.find((p) => p.state === 'waiting-on-user') ?? pipes[0]
  const ids = new Set<string>([...((r.episodes as string[] | undefined) ?? []), ...(bible.episodes ?? []).map((e) => e.id)])
  const episodes = [...ids].map((id) => ({ id, title: bible.episodes?.find((e) => e.id === id)?.title ?? { hr: id, en: id } }))
  const waiting = !pipe && (bible.pitches ?? []).length > 0 && !bible.chosenPitch
  return { bible, state: pipe?.state ?? (waiting ? 'waiting-on-user' : null), step: pipe?.step ?? null, hint: pipe?.hint ?? null, episodes }
}

export interface VariantInfo {
  variant: RigVariant
  state: 'done' | 'failed' | 'not-run'
  /** Wall time of the path, seconds. */
  seconds?: number
  costUsd?: number
  credits?: number
  note?: string
  /** The pose sheet of the variant, relative to the series folder. */
  preview?: string | null
  /** The variant the rig of the character was chosen from. */
  chosen?: boolean
  /** `cts_rig_check` of the variant, as `cts_cast_get` includes it. */
  check?: RigCheckView
}
export interface SheetApproval {
  approved: boolean
  approvedAt: string | null
  /** The user's last verdict (`cts_sheet_approve`): ok false = asked to make the sheet again, with the note. */
  review: { ok: boolean; note: string | null; at: string } | null
}
export interface CastInfo {
  id: string
  rig: { height: number; kind: string; parts: string[]; gestures: string[]; emotions: string[] } | null
  /** The master image (`ref.png`), the rough sketch it was drawn from, the character sheet (`sheet.png`: the master and the poses side by side) and the rig pose sheet (`rig-sheet.png`), relative to the series folder; null when the file does not exist. */
  ref: string | null
  sketch: string | null
  charSheet: string | null
  sheet: string | null
  /** The names of the sheet poses (`sheet/<pose>.png`) and where the user's approval stands (CTS-12; `cts_cast_get` reports it since CTS-17). */
  sheetPoses: string[]
  approval: SheetApproval
  variants: VariantInfo[]
  /** `cts_rig_check` of the chosen rig. */
  check: RigCheckView | null
}
/** `cts_cast_get { series, cast }` -> `{ member, sheet: {approved, approvedAt, review, poses}, rig, variants: variants.json, checks: {chosen, a, c}, files: {sketch, ref, sheet, rigSheet} }`. */
export function normalizeCast(r: Record<string, unknown>): CastInfo {
  const member = (r.member ?? {}) as { id?: string }
  const file = (r.variants ?? {}) as { chosen?: RigVariant | null; variants?: Partial<Record<RigVariant, { status: string; wallSeconds: number; spendUsd: number; spendCredits?: number; note: string }>> }
  const checks = (r.checks ?? {}) as Record<string, RigCheckView | undefined>
  const files = (r.files ?? {}) as { sketch?: string | null; ref?: string | null; sheet?: string | null; rigSheet?: string | null }
  const sh = (r.sheet ?? {}) as { approved?: boolean; approvedAt?: string | null; review?: SheetApproval['review']; poses?: string[] }
  const id = member.id ?? ''
  const variants: VariantInfo[] = (['a', 'c'] as const).map((v) => {
    const rec = file.variants?.[v]
    if (!rec) return { variant: v, state: 'not-run' as const }
    return {
      variant: v,
      state: rec.status === 'built' ? ('done' as const) : rec.status === 'failed' ? ('failed' as const) : ('not-run' as const),
      seconds: rec.wallSeconds,
      costUsd: rec.spendUsd,
      credits: rec.spendCredits ?? 0,
      note: rec.note,
      preview: rec.status === 'built' ? `cast/${id}/variants/${v}/rig-sheet.png` : null,
      chosen: file.chosen === v,
      check: checks[v]
    }
  })
  return { id, rig: (r.rig as CastInfo['rig']) ?? null, ref: files.ref ?? null, sketch: files.sketch ?? null, charSheet: files.sheet ?? null, sheet: files.rigSheet ?? null, sheetPoses: sh.poses ?? [], approval: { approved: !!sh.approved, approvedAt: sh.approvedAt ?? null, review: sh.review ?? null }, variants, check: checks.chosen ?? null }
}

/** `cts_set_get { series, set }` -> `{ set, layerFiles }`. */
export function normalizeSet(r: Record<string, unknown>): SetFile {
  return (r.set ?? r) as SetFile
}

/** What `cts_episode_get` keeps of a voice line (the file is `voice/<lang>/<line>.wav` by convention). */
export interface VoiceLineView {
  status: 'ok' | 'placeholder' | 'failed'
  provider: string
  seconds: number
}
export interface EpisodeInfo {
  /** The script; null when the episode has none yet. */
  episode: Episode | null
  text: Partial<Record<Lang, TextCatalog | null>>
  voice: Partial<Record<Lang, Record<string, VoiceLineView>>>
  state: SeriesRunState | null
}
/** `cts_episode_get { series, episode }` -> `{ script, texts, voice: {lang: {allocation, lines}}, timelines, reviews, clips, budget, pipeline }`. */
export function normalizeEpisode(r: Record<string, unknown>): EpisodeInfo {
  const voice: EpisodeInfo['voice'] = {}
  for (const [lang, v] of Object.entries((r.voice ?? {}) as Record<string, { lines?: Record<string, VoiceLineView> } | null>)) if (v?.lines) voice[lang as Lang] = v.lines
  return {
    episode: (r.script as Episode | null) ?? null,
    text: (r.texts ?? {}) as EpisodeInfo['text'],
    voice,
    state: ((r.pipeline as { state?: SeriesRunState } | null)?.state as SeriesRunState | undefined) ?? null
  }
}

export interface BudgetInfo {
  /** The caps, or null when no budget.json exists (both caps are 0). */
  budget: { capUsd: number; flowCreditsCap: number } | null
  spentUsd: number
  spentCredits: number
  ledger: SpendEntry[]
}
/** `cts_budget_get { series, episode }` -> `{ approved, capUsd, flowCreditsCap, spentUsd, spentCredits, leftUsd, leftCredits, ledger }`. */
export function normalizeBudget(r: Record<string, unknown>): BudgetInfo {
  const b = r as { approved?: boolean; capUsd?: number; flowCreditsCap?: number; spentUsd?: number; spentCredits?: number; ledger?: SpendEntry[] }
  return { budget: b.approved ? { capUsd: b.capUsd ?? 0, flowCreditsCap: b.flowCreditsCap ?? 0 } : null, spentUsd: b.spentUsd ?? 0, spentCredits: b.spentCredits ?? 0, ledger: b.ledger ?? [] }
}

export interface MediaConfig {
  image: { model: string; order: { id: string; label: string; cost: string }[] }
  music: { model: string; alternatives: string[]; sfx: string }
  gemini: { capUsd: number; refused: boolean }
}
/** `cts_media_config { series?, episode? }` -> the image model and fallback order, the music engine and the cap that gates Nano Banana. */
export function normalizeMediaConfig(r: Record<string, unknown>): MediaConfig {
  const m = r as Partial<MediaConfig>
  return {
    image: { model: m.image?.model ?? 'z-image-turbo', order: m.image?.order ?? [] },
    music: { model: m.music?.model ?? '', alternatives: m.music?.alternatives ?? [], sfx: m.music?.sfx ?? '' },
    gemini: { capUsd: m.gemini?.capUsd ?? 0, refused: m.gemini?.refused ?? true }
  }
}

/** One render job of `cts_render_status` (they live in the engine process). Ids are `<series>--render--<episode>-<lang>-<quality>--r<n>`. */
export interface RenderJobView {
  id: string
  state: 'running' | 'done' | 'failed'
  progress: { done: number; total: number }
  startedAt: string
  result?: { file: string; seconds: number; wallSeconds: number; encoder: string; frames: number }
  error?: string
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
/** The finished render of a job as a row (the file is made relative to the series folder); null for a job that is not done or whose id does not parse. */
export function renderOfJob(j: RenderJobView): (RenderInfo & { episode: string; series: string }) | null {
  const m = /^([a-z0-9-]+)--render--([a-z0-9-]+)-(hr|en)-(preview|final)--r\d+$/.exec(j.id)
  if (!m || j.state !== 'done' || !j.result) return null
  const norm = j.result.file.replace(/\\/g, '/')
  const at = norm.lastIndexOf(`/series/${m[1]}/`)
  const file = at >= 0 ? norm.slice(at + `/series/${m[1]}/`.length) : norm
  return { series: m[1]!, episode: m[2]!, lang: m[3] as Lang, quality: m[4] as 'preview' | 'final', file, seconds: j.result.seconds, wallSeconds: j.result.wallSeconds, encoder: j.result.encoder }
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
