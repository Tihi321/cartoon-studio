import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ffmpeg } from './ffmpeg'

/**
 * The mix check (CTS-16): how far under the voice the music really is, measured on the rendered stems. `mix.ts` renders two WAV stems with the
 * same filter graph as the final mix (voices only, music only); this file runs ebur128 over them and compares them per line.
 *
 * Per line longer than `MIN_LINE` the energy mean of the momentary loudness (400 ms windows every 0.1 s; the windows that start before the line are left out) of both stems over the line's interval.
 * Momentary, not the 3 s short-term window: a 3 s window is longer than most lines and smears the louder gap music into the line (see docs).
 * In the gaps (away from the duck ramps) the music is compared with the integrated loudness of the voice stem.
 */

export const MIN_LINE = 0.8
/** The music is fully ducked this long after a line ends (release) and this long before the next one starts (attack) plus the window; gap samples keep away from both. */
const GAP_AFTER = 0.35 + 0.4
const GAP_BEFORE = 0.15
const FLOOR_DB = -120
/** A momentary window ending inside the first 0.4 s of a line still holds the audio before it (the gap level), so those frames are skipped. */
const WINDOW = 0.4

export interface MixCheckLine {
  id: string
  /** Mean loudness of the voice stem over the line, LUFS (energy mean). */
  voice: number
  /** Mean loudness of the music stem over the line, LUFS; null without music. */
  music: number | null
  /** voice - music in dB; null without music. */
  underDb: number | null
}

export interface MixCheck {
  lines: MixCheckLine[]
  /** The smallest `underDb` over the lines; null when there is no music or no line long enough. */
  minUnderDb: number | null
  medianUnderDb: number | null
  /** Integrated loudness of the voice stem minus the energy mean of the music in the gaps; null when there is no music or no gap long enough. */
  gapMusicUnderVoiceDb: number | null
}

export interface Frame {
  /** End time of the window, seconds. */
  t: number
  /** Momentary loudness (400 ms), LUFS; -Infinity when silent. */
  m: number
}

const num = (s: string): number => (/inf/i.test(s) ? -Infinity : Number(s))

/** ebur128 over one audio file: the integrated loudness (null when silent) and the momentary loudness every 0.1 s. */
export async function ebur128(file: string, frames = true): Promise<{ integrated: number | null; frames: Frame[] }> {
  const err = await ffmpeg(['-nostats', '-v', 'info', '-i', file, '-vn', '-af', `ebur128=framelog=${frames ? 'info' : 'quiet'}`, '-f', 'null', '-'])
  const out: Frame[] = []
  if (frames) {
    for (const m of err.matchAll(/\bt:\s*([\d.]+)\s.*?\bM:\s*(-?[\d.]+|-?inf)\s/gi)) out.push({ t: Number(m[1]), m: num(m[2]!) })
  }
  const summary = err.slice(err.lastIndexOf('Integrated loudness'))
  const i = /\bI:\s*(-?[\d.]+|-?inf)\s*LUFS/i.exec(summary)
  const integrated = i ? num(i[1]!) : null
  return { integrated: integrated !== null && Number.isFinite(integrated) ? integrated : null, frames: out }
}

const energy = (db: number): number => (Number.isFinite(db) ? Math.pow(10, db / 10) : 0)
const toDb = (e: number): number => (e > 0 ? 10 * Math.log10(e) : FLOOR_DB)
const r1 = (v: number): number => Math.round(v * 10) / 10

/** The energy mean (dB) of the frames that end inside `(a, b]`; null when none does. */
function meanOver(frames: readonly Frame[], a: number, b: number): number | null {
  const sel = frames.filter((f) => f.t > a && f.t <= b)
  if (!sel.length) return null
  return toDb(sel.reduce((s, f) => s + energy(f.m), 0) / sel.length)
}

export interface CheckLine {
  id: string
  t0: number
  t1: number
}

/** Pure part: the numbers of `mix-check.json` from the frames of the two stems. `voiceIntegrated` is the integrated loudness of the voice stem. */
export function analyse(lines: readonly CheckLine[], voice: readonly Frame[], music: readonly Frame[] | null, voiceIntegrated: number | null, seconds: number): MixCheck {
  const rows: MixCheckLine[] = []
  for (const l of lines) {
    if (l.t1 - l.t0 <= MIN_LINE) continue
    const v = meanOver(voice, l.t0 + WINDOW, l.t1)
    if (v === null || v <= -60) continue
    const m = music ? meanOver(music, l.t0 + WINDOW, l.t1) : null
    rows.push({ id: l.id, voice: r1(v), music: m === null ? null : r1(m), underDb: m === null ? null : r1(v - m) })
  }
  const unders = rows.map((r) => r.underDb).filter((u): u is number => u !== null).sort((a, b) => a - b)
  const median = unders.length ? (unders.length % 2 ? unders[(unders.length - 1) / 2]! : (unders[unders.length / 2 - 1]! + unders[unders.length / 2]!) / 2) : null

  let gap: number | null = null
  if (music && voiceIntegrated !== null) {
    // the stretches between the lines (and before the first / after the last), shrunk by the ramps
    const sorted = [...lines].filter((l) => l.t1 > l.t0).sort((a, b) => a.t0 - b.t0)
    const stretches: [number, number][] = []
    let cursor = 0
    for (const l of sorted) {
      if (l.t0 > cursor) stretches.push([cursor === 0 ? 0.25 + 0.4 : cursor + GAP_AFTER, l.t0 - GAP_BEFORE])
      cursor = Math.max(cursor, l.t1)
    }
    if (seconds > cursor) stretches.push([cursor === 0 ? 0.25 + 0.4 : cursor + GAP_AFTER, seconds])
    const sel = music.filter((f) => stretches.some(([a, b]) => b - a >= 0.1 && f.t > a && f.t <= b))
    if (sel.length) gap = voiceIntegrated - toDb(sel.reduce((s, f) => s + energy(f.m), 0) / sel.length)
  }
  return {
    lines: rows,
    minUnderDb: unders.length ? r1(unders[0]!) : null,
    medianUnderDb: median === null ? null : r1(median),
    gapMusicUnderVoiceDb: gap === null ? null : r1(gap)
  }
}

/** Measures the two stems (WAV files; `music` null when the mix has none), and writes `file` (mix-check.json). */
export async function checkStems(opts: { voice: string; music: string | null; lines: readonly CheckLine[]; seconds: number; file: string }): Promise<MixCheck> {
  const v = await ebur128(opts.voice)
  const m = opts.music ? await ebur128(opts.music) : null
  const check = analyse(opts.lines, v.frames, m ? m.frames : null, v.integrated, opts.seconds)
  await fs.mkdir(path.dirname(opts.file), { recursive: true })
  await fs.writeFile(opts.file, JSON.stringify(check, null, 2) + '\n')
  return check
}

export async function readMixCheck(file: string): Promise<MixCheck | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as MixCheck
  } catch {
    return null
  }
}
