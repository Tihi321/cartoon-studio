import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Chip } from '../../shared/media'
import type { SeriesStore } from '../series/service'
import type { ChiptuneClient } from '../studios/chiptune'

/**
 * The series theme and its few sound effects, made by Chiptune Studio (free, local): `compose_track { mood, chip, seed, seconds }` then
 * `render_audio` for a 30-40 s loop, and up to 2 effects with `compose_sfx { kind, sound, path }`. Files are `.ogg` under `series/<slug>/music/`.
 * A missing or failing Chiptune Studio is a warning and no music, never a failed run.
 */

export const THEME_SECONDS = 35
export const MAX_SFX = 2

export interface SfxRequest {
  kind: 'sfx' | 'stinger' | 'ambience'
  /** A sound valid for the kind in Chiptune Studio (`coin`, `jump`, `chime`, ... / `success`, `reveal`, ... / `wind`, `rain`, ...). */
  sound: string
  /** The file stem under `music/` (default: the sound). */
  name?: string
  chip?: Chip
  seed?: number
  /** Ambience length, 4..120 s. */
  seconds?: number
}

export interface MusicRequest {
  series: string
  mood: string
  chip: Chip
  seed: number
  /** Theme length; default 35 s (the studio rounds to whole bars). */
  seconds?: number
  sfx?: SfxRequest[]
}

export interface MusicFile {
  /** Relative to the series folder: `music/theme.ogg`. */
  file: string
  seconds: number
  loopStartSec: number | null
  loopEndSec: number | null
  chip: string
  seed: number
}

export interface MusicResult {
  theme: (MusicFile & { bpm: number; key: string; mood: string }) | null
  sfx: (MusicFile & { kind: string; sound: string })[]
  warnings: string[]
}

const stem = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'sound'

const ffmpeg = (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => execFile('ffmpeg', args, { windowsHide: true, timeout: 120_000 }, (err, _o, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().split('\n').slice(-2).join(' '))) : resolve())))

/** The studio writes a `.wav` next to the requested path when it has no ffmpeg: make the `.ogg` here when we can, else keep the wav and say so. */
async function ensureOgg(written: string, wanted: string, warnings: string[]): Promise<string> {
  if (written.toLowerCase().endsWith('.ogg')) return written
  try {
    await ffmpeg(['-y', '-v', 'error', '-i', written, '-c:a', 'libvorbis', '-q:a', '5', wanted])
    await fs.rm(written, { force: true })
    return wanted
  } catch (e) {
    warnings.push(`the studio wrote ${path.basename(written)} and the .ogg conversion failed (${(e as Error).message}): the wav stays`)
    return written
  }
}

export async function generateMusic(o: { chiptune: ChiptuneClient; store: SeriesStore; request: MusicRequest; log?: (m: string) => void; signal?: AbortSignal }): Promise<MusicResult> {
  const { chiptune, store, request: req } = o
  const root = store.paths(req.series).root
  const dir = path.join(root, 'music')
  const rel = (abs: string): string => path.relative(root, abs).split(path.sep).join('/')
  const result: MusicResult = { theme: null, sfx: [], warnings: [] }
  await fs.mkdir(dir, { recursive: true })

  try {
    const target = path.join(dir, 'theme.ogg')
    const composed = await chiptune.composeTrack({ mood: req.mood, chip: req.chip, seed: req.seed, seconds: req.seconds ?? THEME_SECONDS, loop: true, name: `${req.series}-theme` }, o.signal)
    const rendered = await chiptune.renderAudio({ song: composed.songId, path: target, format: 'ogg', sampleRate: 44100 }, o.signal)
    if (rendered.warning) result.warnings.push(`theme: ${rendered.warning}`)
    const file = await ensureOgg(rendered.path, target, result.warnings)
    if (rendered.durationSec < 30 || rendered.durationSec > 40) result.warnings.push(`theme is ${rendered.durationSec.toFixed(1)} s (the plan wants a 30-40 s loop): the studio rounds to whole bars, try another seed or tempo`)
    result.theme = { file: rel(file), seconds: rendered.durationSec, loopStartSec: rendered.loopStartSec, loopEndSec: rendered.loopEndSec, chip: composed.chip, seed: composed.seed, bpm: composed.bpm, key: composed.key, mood: composed.mood }
    o.log?.(`music: theme ${rel(file)} (${rendered.durationSec.toFixed(1)} s, ${composed.chip}, ${composed.bpm} bpm)`)
  } catch (e) {
    result.warnings.push(`no theme: Chiptune Studio could not make it (${(e as Error).message.split('\n')[0]})`)
    return result // no studio, no effects either
  }

  const wanted = (req.sfx ?? []).slice(0, MAX_SFX)
  if ((req.sfx?.length ?? 0) > MAX_SFX) result.warnings.push(`only the first ${MAX_SFX} sound effects are made`)
  for (const s of wanted) {
    try {
      const target = path.join(dir, `${stem(s.name ?? s.sound)}.ogg`)
      const r = await chiptune.composeSfx({ kind: s.kind, sound: s.sound, ...(s.chip ? { chip: s.chip } : {}), ...(s.seed !== undefined ? { seed: s.seed } : {}), ...(s.seconds ? { seconds: s.seconds } : {}), path: target, format: 'ogg' }, o.signal)
      if (r.warning) result.warnings.push(`${s.sound}: ${r.warning}`)
      const file = await ensureOgg(r.path, target, result.warnings)
      result.sfx.push({ file: rel(file), seconds: r.durationSec, loopStartSec: r.loopStartSec ?? null, loopEndSec: r.loopEndSec ?? null, chip: r.chip, seed: r.seed, kind: s.kind, sound: s.sound })
    } catch (e) {
      result.warnings.push(`no ${s.kind} "${s.sound}": ${(e as Error).message.split('\n')[0]}`)
    }
  }
  return result
}
