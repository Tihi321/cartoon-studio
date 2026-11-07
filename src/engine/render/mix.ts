import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DEFAULT_MIX, ffmpeg } from './ffmpeg'
import type { MixConfig } from './ffmpeg'
import { checkStems, ebur128 } from './mixcheck'
import type { MixCheck } from './mixcheck'

/**
 * The audio mix of an episode: one ffmpeg filter graph over every audio entry of the timeline (and the audio of the spliced clips).
 *
 *   each input -> stereo 44.1 kHz -> atrim -> adelay to its start -> volume (its level; music: ducking while a voice line plays, fade-in, fade-out)
 *   -> amix (normalize=0) -> apad/atrim to the video length -> loudnorm (two passes: measure, then linear) -> AAC -> muxed with the video.
 *
 * Levels (CTS-16): every input's integrated loudness is measured once (ebur128, cached by file hash in `levels.json`) and its volume brings it to
 * its level relative to the voice (`MixConfig`, render.md `mix`): voices to `voiceLufs`; music `musicGapUnderVoiceDb` under it in the gaps and
 * `musicUnderVoiceDb` under it while a voice plays (the duck is a trapezoid in dB); sfx and clip audio `sfxUnderVoiceDb` / `clipUnderVoiceDb` under.
 * `MixInput.gain` is only a trim, never a boost. The loudnorm at the end is one gain on the sum, so the distances stay.
 */

export interface MixInput {
  /** Absolute path. */
  file: string
  kind: 'voice' | 'music' | 'sfx' | 'clip'
  /** Start in the episode, seconds. */
  t: number
  /** A trim on top of the level: at most 1 (0 dB) for everything but voices, never a boost. */
  gain: number
  /** Integrated loudness of the file in LUFS (`measureLevels`); null or missing: the file is not normalised, only trimmed. */
  lufs?: number | null
  /** Seconds of the file to use at most (clips: their range; music: until - t). */
  length?: number
  /** Music: the file is looped to fill `length`. */
  loop?: boolean
  /** Ignored since CTS-16 (the duck depth is `mix.musicUnderVoiceDb - mix.musicGapUnderVoiceDb`); kept so old timelines load. */
  duckTo?: number
  /** Music: the end of the music in the episode (the fade-out ends here). */
  until?: number
  fadeOut?: number
}

export interface MixOptions {
  /** Voice intervals `[t0, t1]` the music ducks under. */
  voice: [number, number][]
  /** The levels (render.md `mix`); the seed's when missing. */
  mix?: MixConfig
  /** The lines (id and interval) for the mix check. */
  lines?: { id: string; t0: number; t1: number }[]
  /** Where the measured levels are cached (`render/<lang>/levels.json`); none: measured every time. */
  levelsFile?: string
  /** Where the mix check is written (`render/<lang>/mix-check.json`); none: no check. */
  checkFile?: string
  /** The video length in seconds; the audio is padded or cut to it. */
  seconds: number
  lufs: number
  truePeak: number
  audio: { codec: string; bitrate: string }
}

const DUCK_ATTACK = 0.15
const DUCK_RELEASE = 0.35
const FADE_IN = 0.25

const n = (v: number): string => (Math.round(v * 1000) / 1000).toString()
const n6 = (v: number): string => Number(v.toPrecision(6)).toString()

/** Merges intervals that touch or overlap (after widening by the ramps), so the ducking expression stays short. */
export function mergeIntervals(list: readonly [number, number][], gap = DUCK_ATTACK + DUCK_RELEASE): [number, number][] {
  const sorted = [...list].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const out: [number, number][] = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a - last[1] <= gap) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/** ffmpeg expression for the ducking share (0..1) at global time `t`: a trapezoid per interval, the largest wins (ffmpeg min/max take two arguments, so they are nested). */
export function duckExpression(intervals: readonly [number, number][]): string {
  const terms = intervals.map(([a, b]) => `max(0,min(1,min((t-${n(a - DUCK_ATTACK)})/${DUCK_ATTACK},(${n(b + DUCK_RELEASE)}-t)/${DUCK_RELEASE})))`)
  if (terms.length === 0) return '0'
  return terms.reduce((acc, term) => `max(${acc},${term})`)
}

/** The trim in dB: voices as given, everything else at most 0 dB. */
const trimDb = (i: MixInput): number => 20 * Math.log10(i.kind === 'voice' ? Math.max(i.gain, 1e-6) : Math.min(Math.max(i.gain, 1e-6), 1))

/** The dB to add to a file so that it sits `under` dB under the voice level; 0 when the file could not be measured. */
function offsetDb(i: MixInput, mix: MixConfig, under: number): number {
  return i.lufs === undefined || i.lufs === null ? 0 : mix.voiceLufs - under - i.lufs
}

/** The volume expression of one input, in global time (the filter runs after `adelay`, so `t` is the episode time). */
export function volumeExpression(i: MixInput, voice: readonly [number, number][], mix: MixConfig = DEFAULT_MIX): string {
  if (i.gain <= 0) return '0'
  const trim = trimDb(i)
  if (i.kind !== 'music') {
    const under = i.kind === 'voice' ? 0 : i.kind === 'sfx' ? mix.sfxUnderVoiceDb : mix.clipUnderVoiceDb
    return n6(Math.pow(10, (offsetDb(i, mix, under) + trim) / 20))
  }
  const gapDb = offsetDb(i, mix, mix.musicGapUnderVoiceDb) + trim
  const depth = Math.max(0, mix.musicUnderVoiceDb - mix.musicGapUnderVoiceDb)
  const level = depth > 0 && voice.length ? `pow(10,(${n(gapDb)}-${n(depth)}*${duckExpression(mergeIntervals(voice))})/20)` : n6(Math.pow(10, gapDb / 20))
  const fin = `min(1,max(0,(t-${n(i.t)})/${FADE_IN}))`
  const fout = i.until !== undefined && i.fadeOut ? `*min(1,max(0,(${n(i.until)}-t)/${n(i.fadeOut)}))` : ''
  return `${level}*${fin}${fout}`
}

/** The filter graph (no loudnorm yet): inputs are numbered from `first` (input 0 is the video). Output label `[mixed]`. */
export function buildGraph(inputs: readonly MixInput[], voice: readonly [number, number][], first = 1, mix: MixConfig = DEFAULT_MIX): string {
  const lines: string[] = []
  inputs.forEach((inp, k) => {
    const idx = first + k
    const chain = ['aresample=44100', 'aformat=sample_fmts=fltp:channel_layouts=stereo']
    if (inp.length !== undefined) chain.push(`atrim=duration=${n(inp.length)}`)
    chain.push('asetpts=PTS-STARTPTS')
    const ms = Math.max(0, Math.round(inp.t * 1000))
    if (ms > 0) chain.push(`adelay=${ms}:all=1`)
    chain.push(`volume='${volumeExpression(inp, voice, mix)}':eval=frame`)
    lines.push(`[${idx}:a]${chain.join(',')}[a${k}]`)
  })
  if (inputs.length === 0) lines.push('anullsrc=r=44100:cl=stereo[mixed]')
  else lines.push(`${inputs.map((_, k) => `[a${k}]`).join('')}amix=inputs=${inputs.length}:normalize=0:duration=longest:dropout_transition=0[mixed]`)
  return lines.join(';\n')
}

export interface LoudnessMeasure {
  input_i: string
  input_tp: string
  input_lra: string
  input_thresh: string
  target_offset: string
}

function inputArgs(inputs: readonly MixInput[]): string[] {
  const args: string[] = []
  for (const i of inputs) {
    if (i.loop) args.push('-stream_loop', '-1')
    args.push('-i', i.file)
  }
  return args
}

// ---------------------------------------------------------------- levels

/** Integrated loudness (LUFS) of each file, measured once: the cache `levelsFile` is keyed by the SHA-256 of the file. Null for a silent file. */
export async function measureLevels(files: readonly string[], levelsFile?: string): Promise<Map<string, number | null>> {
  let cache: Record<string, number | null> = {}
  if (levelsFile) {
    try {
      cache = JSON.parse(await fs.readFile(levelsFile, 'utf8')) as Record<string, number | null>
    } catch {
      /* no cache yet */
    }
  }
  const out = new Map<string, number | null>()
  let dirty = false
  for (const file of new Set(files)) {
    const hash = createHash('sha256').update(await fs.readFile(file)).digest('hex')
    if (!(hash in cache)) {
      cache[hash] = (await ebur128(file, false)).integrated
      dirty = true
    }
    out.set(file, cache[hash] ?? null)
  }
  if (levelsFile && dirty) {
    await fs.mkdir(path.dirname(levelsFile), { recursive: true })
    await fs.writeFile(levelsFile, JSON.stringify(cache, null, 2) + '\n')
  }
  return out
}

// ---------------------------------------------------------------- the mix

/** The text after `[mixed]`: pad/cut to the video length, then (optionally) loudnorm. */
function tail(o: MixOptions, norm: string | null): string {
  return `[mixed]apad=whole_dur=${n(o.seconds)},atrim=duration=${n(o.seconds)},asetpts=PTS-STARTPTS${norm ? ',' + norm : ''},aresample=44100[aout]`
}

/** Pass 1: the loudness of the mix as it is. Null when the mix is silent. */
export async function measureLoudness(video: string, inputs: readonly MixInput[], o: MixOptions): Promise<LoudnessMeasure | null> {
  const graph = `${buildGraph(inputs, o.voice, 1, o.mix)};\n${tail(o, `loudnorm=I=${o.lufs}:TP=${o.truePeak}:LRA=11:print_format=json`)}`
  const err = await ffmpeg(['-v', 'info', '-i', video, ...inputArgs(inputs), '-filter_complex', graph, '-map', '[aout]', '-f', 'null', '-'])
  const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(err)
  if (!json) return null
  const m = JSON.parse(json[0]) as LoudnessMeasure
  return Number.isFinite(Number(m.input_i)) && Number(m.input_i) > -70 ? m : null
}

/** One stem (only the inputs of the given kinds, the same graph as the mix, no loudnorm) as a float WAV the length of the video. */
async function renderStem(inputs: readonly MixInput[], o: MixOptions, out: string): Promise<void> {
  const graph = `${buildGraph(inputs, o.voice, 0, o.mix)};\n${tail(o, null)}`
  await ffmpeg(['-y', '-v', 'error', ...inputArgs(inputs), '-filter_complex', graph, '-map', '[aout]', '-c:a', 'pcm_f32le', '-t', n(o.seconds), out])
}

export interface MuxResult {
  /** Pass-1 measure of the mix (null for a silent mix). */
  loudness: LoudnessMeasure | null
  /** The mix check (null when `checkFile` is not set or there is no voice). */
  check: MixCheck | null
}

/** Mixes the audio over the video and writes the final mp4 (`+faststart`); when `checkFile` is set it also writes the mix check. */
export async function muxEpisode(video: string, inputs: readonly MixInput[], o: MixOptions, out: string): Promise<MuxResult> {
  const mix = o.mix ?? DEFAULT_MIX
  const levels = await measureLevels(
    inputs.map((i) => i.file),
    o.levelsFile
  )
  const leveled = inputs.map((i) => ({ ...i, lufs: levels.get(i.file) ?? null }))
  const opts: MixOptions = { ...o, mix }
  const m = leveled.length ? await measureLoudness(video, leveled, opts) : null
  const norm = m
    ? `loudnorm=I=${o.lufs}:TP=${o.truePeak}:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`
    : null
  const graph = `${buildGraph(leveled, o.voice, 1, mix)};
${tail(opts, norm)}`
  await ffmpeg([
    '-y', '-v', 'error', '-i', video, ...inputArgs(leveled), '-filter_complex', graph,
    '-map', '0:v:0', '-map', '[aout]', '-c:v', 'copy', '-c:a', o.audio.codec, '-b:a', o.audio.bitrate, '-ar', '44100',
    '-t', n(o.seconds), '-movflags', '+faststart', out
  ])

  let check: MixCheck | null = null
  const voices = leveled.filter((i) => i.kind === 'voice')
  if (o.checkFile && voices.length) {
    const music = leveled.filter((i) => i.kind === 'music')
    const stems = path.join(path.dirname(o.checkFile), 'stems')
    await fs.mkdir(stems, { recursive: true })
    try {
      const voiceWav = path.join(stems, 'voice.wav')
      const musicWav = path.join(stems, 'music.wav')
      await renderStem(voices, opts, voiceWav)
      if (music.length) await renderStem(music, opts, musicWav)
      check = await checkStems({ voice: voiceWav, music: music.length ? musicWav : null, lines: o.lines ?? [], seconds: o.seconds, file: o.checkFile })
    } finally {
      await fs.rm(stems, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  return { loudness: m, check }
}
