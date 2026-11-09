import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** ffmpeg / ffprobe helpers of the voice step: probe the length, normalise a clip, write a silent placeholder. ffmpeg and ffprobe must be on PATH. */

export const SAMPLE_RATE = 44100

const run = (cmd: string, args: string[], timeoutMs = 120_000): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${(stderr || err.message).toString().trim().split('\n').slice(-3).join(' ')}`))
      else resolve(stdout.toString())
    })
  })

/** The duration of an audio file in seconds (ffprobe). */
export async function probeSeconds(file: string): Promise<number> {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
  const n = Number(out.trim().split('\n')[0])
  if (!Number.isFinite(n)) throw new Error(`ffprobe could not read the length of ${path.basename(file)}`)
  return n
}

/** What the silence trim keeps at each end: silence over this long is cut down to it. */
export const SILENCE_KEEP_S = 0.15

/** The level under which the trim (and its measurement) counts the audio as silence, and how long sound must last to end it. */
const SILENCE_DB = -45
const SILENCE_MIN_S = 0.05

/** ffmpeg's stderr (where `silencedetect` prints). */
const runStderr = (args: string[], timeoutMs = 120_000): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg failed: ${(stderr || err.message).toString().trim().split('\n').slice(-3).join(' ')}`))
      else resolve(stderr.toString())
    })
  })

/**
 * The silence at the start of `input` in seconds, measured with ffmpeg `silencedetect` at the threshold the trim uses: the end of a silence that
 * starts at the file start, or 0 when the sound starts at once (or the whole file is silent).
 */
export async function leadSilenceSeconds(input: string): Promise<number> {
  const err = await runStderr(['-hide_banner', '-nostats', '-v', 'info', '-i', input, '-vn', '-af', `silencedetect=noise=${SILENCE_DB}dB:d=${SILENCE_MIN_S}`, '-f', 'null', '-'])
  const start = /silence_start:\s*(-?[\d.]+)/.exec(err)
  if (!start || Number(start[1]) > 0.01) return 0
  const end = /silence_end:\s*([\d.]+)/.exec(err)
  return end ? Number(end[1]) : 0
}

export interface Normalised {
  /** The length of the normalised clip. */
  seconds: number
  /**
   * HUB-31: how much of the input's start the trim cut (its lead silence minus the `SILENCE_KEEP_S` kept), so word times measured on the input
   * map to the clip by `t - leadTrimS`.
   */
  leadTrimS: number
}

/**
 * Converts any audio to a 44.1 kHz mono 16-bit WAV and trims the silence at the start and the end down to `SILENCE_KEEP_S`
 * (a pause inside the line is never touched: the end is trimmed by reversing the audio and trimming its start).
 */
export async function normaliseWav(input: string, output: string): Promise<Normalised> {
  const trim = `silenceremove=start_periods=1:start_duration=${SILENCE_MIN_S}:start_threshold=${SILENCE_DB}dB:start_silence=${SILENCE_KEEP_S}:detection=peak`
  await fs.mkdir(path.dirname(output), { recursive: true })
  const lead = await leadSilenceSeconds(input)
  const tmp = `${output}.tmp-${process.pid}.wav`
  try {
    await run('ffmpeg', ['-y', '-v', 'error', '-i', input, '-vn', '-af', `${trim},areverse,${trim},areverse`, '-ar', String(SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', tmp])
    await fs.rename(tmp, output)
  } finally {
    await fs.rm(tmp, { force: true })
  }
  return { seconds: await probeSeconds(output), leadTrimS: Math.round(Math.max(0, lead - SILENCE_KEEP_S) * 1000) / 1000 }
}

/** HUB-31: ElevenLabs word times (from the start of the untrimmed file) moved onto the trimmed clip: `t - leadTrimS`, clamped to `[0, seconds]`. */
export function shiftWords(words: readonly { w: string; t0: number; t1: number }[], leadTrimS: number, seconds: number): { w: string; t0: number; t1: number }[] {
  const at = (t: number): number => Math.min(seconds, Math.max(0, Math.round((t - leadTrimS) * 1000) / 1000))
  return words.map((x) => ({ w: x.w, t0: at(x.t0), t1: at(x.t1) }))
}

/** A mono 16-bit PCM WAV of silence. */
export function silenceWav(seconds: number): Buffer {
  const samples = Math.max(1, Math.round(seconds * SAMPLE_RATE))
  const data = samples * 2
  const b = Buffer.alloc(44 + data)
  b.write('RIFF', 0, 'latin1')
  b.writeUInt32LE(36 + data, 4)
  b.write('WAVEfmt ', 8, 'latin1')
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20) // PCM
  b.writeUInt16LE(1, 22) // mono
  b.writeUInt32LE(SAMPLE_RATE, 24)
  b.writeUInt32LE(SAMPLE_RATE * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36, 'latin1')
  b.writeUInt32LE(data, 40)
  return b
}

/** Reading speed of a placeholder: 2.5 words a second, at least 0.8 s, so the timing still builds. */
export function placeholderSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  return Math.max(0.8, Math.round((words / 2.5) * 100) / 100)
}
