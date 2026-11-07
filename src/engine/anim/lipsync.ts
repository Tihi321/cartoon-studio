import { spawn } from 'node:child_process'
import type { Lang, Lipsync, MouthShape } from '../../shared/contracts'
import type { SeriesStore } from '../series/service'

/**
 * Amplitude lip-sync: one mouth shape per animation frame from the loudness of the line itself. Decode to 16 kHz mono floats with ffmpeg, take the
 * RMS of every 1/fps window and call a window voiced when it is above a small floor. Every voiced window opens the mouth (E); it opens wide (A)
 * around the line's own 70th percentile of the voiced windows, with hysteresis against flicker. A shape holds at least 2 frames. The mouth
 * anticipates the first sound by LEAD frames and releases TAIL frames after the last (half open, E), as cutout animators do; the rest of the
 * leading and trailing silence is `rest`. Short lines padded with silence by the TTS still show the mouth moving for most of their frames (A9).
 */

export const LIPSYNC_FPS = 12
const SAMPLE_RATE = 16000
const MIN_HOLD = 2
/** Opening wide needs the level to reach OPEN x threshold, closing back to E needs it to fall under CLOSE x threshold. */
const OPEN = 0.9
const CLOSE = 0.7
/** A window is voiced above this share of the loudest window, and never below an absolute floor (about -50 dBFS). */
const VOICED_SHARE = 0.05
const VOICED_FLOOR = 0.003
/** Frames the mouth opens before the first voiced window and stays open after the last one. */
const LEAD = 2
const TAIL = 2

/** The ffmpeg to run: `CTS_FFMPEG`, else `ffmpeg` from PATH. */
const ffmpegBin = () => process.env.CTS_FFMPEG || 'ffmpeg'

/** Decodes any audio file to mono 16 kHz float samples. */
export function decodeMono16k(file: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBin(), ['-v', 'error', '-nostdin', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(SAMPLE_RATE), '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const chunks: Buffer[] = []
    let err = ''
    p.stdout.on('data', (c: Buffer) => chunks.push(c))
    p.stderr.on('data', (c: Buffer) => (err += c.toString()))
    p.on('error', (e) => reject(new Error(`ffmpeg could not start: ${e.message}`)))
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg failed on ${file}: ${err.trim().slice(0, 300)}`))
      const buf = Buffer.concat(chunks)
      const n = Math.floor(buf.length / 4)
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4)
      resolve(out)
    })
  })
}

/** RMS of each window of `rate / fps` samples (the last, partial window counts too). */
export function rmsWindows(samples: Float32Array, fps: number, rate = SAMPLE_RATE): number[] {
  const frames = Math.ceil((samples.length / rate) * fps - 1e-9)
  const out: number[] = []
  for (let i = 0; i < frames; i++) {
    const a = Math.floor((i * rate) / fps)
    const b = Math.min(samples.length, Math.floor(((i + 1) * rate) / fps))
    let sum = 0
    for (let j = a; j < b; j++) sum += samples[j]! * samples[j]!
    out.push(b > a ? Math.sqrt(sum / (b - a)) : 0)
  }
  return out
}

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * p
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

/** The shape sequence for a list of window loudness values (pure, so it can be tested without audio). */
export function shapesFromRms(rms: readonly number[]): MouthShape[] {
  const peak = rms.reduce((m, v) => Math.max(m, v), 0)
  const floor = Math.max(VOICED_FLOOR, peak * VOICED_SHARE)
  const voiced = rms.map((v) => v > floor)
  const sorted = rms.filter((_, i) => voiced[i]).sort((a, b) => a - b)
  if (sorted.length === 0) return rms.map((): MouthShape => 'rest')
  const hi = percentile(sorted, 0.7)

  // the mouth anticipates the first sound and releases after the last (E); the rest of the leading and trailing silence stays rest
  let first = 0
  while (first < voiced.length && !voiced[first]) first++
  let last = voiced.length - 1
  while (last >= 0 && !voiced[last]) last--

  let wide = false
  const shapes: MouthShape[] = rms.map((v, i): MouthShape => {
    if (!voiced[i]) {
      wide = false
      return i >= first - LEAD && i <= last + TAIL && (i < first || i > last) ? 'E' : 'rest'
    }
    wide = wide ? v >= hi * CLOSE : v >= hi * OPEN
    return wide ? 'A' : 'E'
  })

  // a shape holds at least MIN_HOLD frames: a shorter run joins an open neighbour (the one before first), else the run before it
  // (the first run joins the one after), so a short sound never vanishes into rest
  let runs: { shape: MouthShape; n: number }[] = []
  const collect = (list: MouthShape[]) => {
    runs = []
    for (const s of list) {
      const prev = runs[runs.length - 1]
      if (prev && prev.shape === s) prev.n++
      else runs.push({ shape: s, n: 1 })
    }
  }
  collect(shapes)
  for (let guard = 0; guard < shapes.length; guard++) {
    // the silence at either end stays rest however short
    const i = runs.findIndex((r, k) => r.n < MIN_HOLD && !(r.shape === 'rest' && (k === 0 || k === runs.length - 1)))
    if (i < 0 || runs.length === 1) break
    const before = runs[i - 1]
    const after = runs[i + 1]
    const into = before && before.shape !== 'rest' ? before : after && after.shape !== 'rest' ? after : (before ?? after)!
    into.n += runs[i]!.n
    runs.splice(i, 1)
    collect(runs.flatMap((r) => Array<MouthShape>(r.n).fill(r.shape)))
  }
  return runs.flatMap((r) => Array<MouthShape>(r.n).fill(r.shape))
}

/** The lip-sync track of a WAV (or any audio file ffmpeg reads). */
export async function amplitudeVisemes(wavPath: string, fps = LIPSYNC_FPS): Promise<Lipsync> {
  const samples = await decodeMono16k(wavPath)
  return { schema: 'cts.lipsync/1', method: 'amplitude', fps, shapes: shapesFromRms(rmsWindows(samples, fps)) }
}

/** A track of `seconds` of `rest` (a silent placeholder line, or a line whose file is missing). */
export function restTrack(seconds: number, fps = LIPSYNC_FPS): Lipsync {
  return { schema: 'cts.lipsync/1', method: 'amplitude', fps, shapes: Array<MouthShape>(Math.max(1, Math.ceil(seconds * fps))).fill('rest') }
}

/** Makes the track for one line and writes `episodes/<ep>/lipsync/<lang>/<line>.json` through the store. A missing or unreadable file becomes all `rest`. */
export async function writeLineLipsync(
  store: SeriesStore,
  series: string,
  episode: string,
  lang: Lang,
  line: string,
  wavPath: string | null,
  seconds: number
): Promise<Lipsync> {
  let track: Lipsync
  try {
    track = wavPath ? await amplitudeVisemes(wavPath) : restTrack(seconds)
  } catch {
    track = restTrack(seconds)
  }
  return store.writeLipsync(series, episode, lang, line, track)
}
