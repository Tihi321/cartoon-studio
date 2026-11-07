import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseMd } from '../../shared/md'
import type { ComfyClient } from '../comfy/client'
import { comfyKindSwitch } from '../comfy/kind-switch'
import { ffmpeg, ffprobe } from '../render/ffmpeg'
import type { SeriesStore } from '../series/service'

/**
 * The series theme and its few sound effects, made by ComfyUI (free, local). The theme engine is `comfy.musicModel` of `config/providers.md`
 * (`ace-step-v1-instrumental` by default, `minimax-music-3` as the alternative; Stable Audio 3 is an option that is not wired): a 40 s instrumental
 * (empty lyrics), converted with ffmpeg to `series/<slug>/music/theme.ogg` with a 0.5 s fade-in and a 2 s fade-out. Up to 2 sound effects come from
 * `moss-soundeffect-v2` as `music/sfx-<cue>.ogg`. A missing or failing ComfyUI is a warning and no music, never a failed run.
 */

export const THEME_SECONDS = 40
export const MAX_SFX = 2
export const DEFAULT_MUSIC_MODEL = 'ace-step-v1-instrumental'
export const MUSIC_MODELS = ['ace-step-v1-instrumental', 'minimax-music-3'] as const
export const SFX_ENGINE = 'moss-soundeffect-v2'
const FADE_IN_S = 0.5
const FADE_OUT_S = 2

export interface SfxRequest {
  /** The file stem under `music/` (the engine writes `<name>.ogg`). */
  name: string
  /** What the sound is, in words ("a soft wooden knock"). */
  prompt: string
  seconds?: number
  seed?: number
}

export interface MusicRequest {
  series: string
  /** The style tags: genre, instruments, mood. */
  tags: string
  bpm?: number
  key?: string
  seed?: number
  /** Theme length; default 40 s. */
  seconds?: number
  sfx?: SfxRequest[]
}

export interface MusicFile {
  /** Relative to the series folder: `music/theme.ogg`. */
  file: string
  seconds: number
  seed: number
  engine: string
  wallSeconds: number
}

export interface MusicResult {
  theme: MusicFile | null
  sfx: MusicFile[]
  warnings: string[]
}

const stem = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'sound'

/** `config/providers.md` `comfy.musicModel`; a missing or unknown value gives the default. */
export async function configuredMusicModel(dataDir: string): Promise<string> {
  try {
    const data = parseMd(await fs.readFile(path.join(dataDir, 'config', 'providers.md'), 'utf8'), 'providers.md').data
    const m = (data.comfy as { musicModel?: unknown } | undefined)?.musicModel
    return typeof m === 'string' && (MUSIC_MODELS as readonly string[]).includes(m) ? m : DEFAULT_MUSIC_MODEL
  } catch {
    return DEFAULT_MUSIC_MODEL
  }
}

/** Writes the engine's clip to `target` (.ogg), with the fades when asked. The source clip is a temporary file next to it. */
async function toOgg(bytes: Buffer, ext: string, target: string, fades: boolean, signal?: AbortSignal): Promise<number> {
  const raw = `${target}.raw.${ext || 'flac'}`
  await fs.writeFile(raw, bytes)
  try {
    const seconds = Number((await ffprobe(raw)).format.duration) || 0
    const filters = fades && seconds > FADE_IN_S + FADE_OUT_S ? ['-af', `afade=t=in:st=0:d=${FADE_IN_S},afade=t=out:st=${(seconds - FADE_OUT_S).toFixed(3)}:d=${FADE_OUT_S}`] : []
    await ffmpeg(['-y', '-v', 'error', '-i', raw, ...filters, '-ar', '44100', '-c:a', 'libvorbis', '-q:a', '5', target], signal)
    return Number((await ffprobe(target)).format.duration) || seconds
  } finally {
    await fs.rm(raw, { force: true })
  }
}

const round1 = (ms: number): number => Math.round(ms / 100) / 10

export async function generateTheme(o: {
  comfy: ComfyClient
  store: SeriesStore
  dataDir: string
  request: MusicRequest
  log?: (m: string) => void
  signal?: AbortSignal
  /** Tests: replaces the ComfyUI memory switch. */
  kindSwitch?: (kind: 'music') => Promise<unknown>
}): Promise<MusicResult> {
  const { comfy, store, request: req } = o
  const root = store.paths(req.series).root
  const dir = path.join(root, 'music')
  const rel = (abs: string): string => path.relative(root, abs).split(path.sep).join('/')
  const result: MusicResult = { theme: null, sfx: [], warnings: [] }
  await fs.mkdir(dir, { recursive: true })
  const engine = await configuredMusicModel(o.dataDir)
  await (o.kindSwitch ? o.kindSwitch('music') : comfyKindSwitch('music', { dataDir: o.dataDir, log: o.log })).catch(() => undefined)

  try {
    const target = path.join(dir, 'theme.ogg')
    const started = Date.now()
    const tags = [req.tags.trim(), req.bpm ? `${Math.round(req.bpm)} bpm` : '', req.key ? `key of ${req.key}` : '', 'instrumental, no vocals'].filter(Boolean).join(', ')
    const r = await comfy.generate({ engine, prompt: tags, lyrics: '', seconds: req.seconds ?? THEME_SECONDS, ...(req.seed !== undefined ? { seed: req.seed } : {}), filenamePrefix: 'cts_music', signal: o.signal })
    const seconds = await toOgg(r.bytes, r.ext, target, true, o.signal)
    const wallSeconds = round1(Date.now() - started)
    result.theme = { file: rel(target), seconds, seed: r.seed, engine, wallSeconds }
    o.log?.(`music: theme ${rel(target)} (${seconds.toFixed(1)} s, ${engine}, ${wallSeconds} s wall, seed ${r.seed})`)
  } catch (e) {
    result.warnings.push(`no theme: ComfyUI could not make it (${(e as Error).message.split('\n')[0]})`)
    return result // no ComfyUI, no effects either
  }

  if ((req.sfx?.length ?? 0) > MAX_SFX) result.warnings.push(`only the first ${MAX_SFX} sound effects are made`)
  for (const s of (req.sfx ?? []).slice(0, MAX_SFX)) {
    try {
      const target = path.join(dir, `${stem(s.name)}.ogg`)
      const started = Date.now()
      const r = await comfy.generate({ engine: SFX_ENGINE, text: s.prompt, prompt: s.prompt, seconds: s.seconds ?? 3, ...(s.seed !== undefined ? { seed: s.seed } : {}), filenamePrefix: 'cts_sfx', signal: o.signal })
      const seconds = await toOgg(r.bytes, r.ext, target, false, o.signal)
      result.sfx.push({ file: rel(target), seconds, seed: r.seed, engine: SFX_ENGINE, wallSeconds: round1(Date.now() - started) })
    } catch (e) {
      result.warnings.push(`no sound effect "${s.name}": ${(e as Error).message.split('\n')[0]}`)
    }
  }
  return result
}
