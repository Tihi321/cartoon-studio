import { ffmpeg } from './ffmpeg'

/**
 * The audio mix of an episode: one ffmpeg filter graph over every audio entry of the timeline (and the audio of the spliced clips).
 *
 *   each input -> stereo 44.1 kHz -> atrim -> adelay to its start -> volume (music: ducking while a voice line plays, fade-in, fade-out)
 *   -> amix (normalize=0) -> apad/atrim to the video length -> loudnorm (two passes: measure, then linear) -> AAC -> muxed with the video.
 */

export interface MixInput {
  /** Absolute path. */
  file: string
  kind: 'voice' | 'music' | 'sfx' | 'clip'
  /** Start in the episode, seconds. */
  t: number
  gain: number
  /** Seconds of the file to use at most (clips: their range; music: until - t). */
  length?: number
  /** Music: the file is looped to fill `length`. */
  loop?: boolean
  /** Music: gain while a voice line plays. */
  duckTo?: number
  /** Music: the end of the music in the episode (the fade-out ends here). */
  until?: number
  fadeOut?: number
}

export interface MixOptions {
  /** Voice intervals `[t0, t1]` the music ducks under. */
  voice: [number, number][]
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

/** The volume expression of one input, in global time (the filter runs after `adelay`, so `t` is the episode time). */
export function volumeExpression(i: MixInput, voice: readonly [number, number][]): string {
  if (i.kind !== 'music') return n(i.gain)
  const duck = i.duckTo !== undefined && i.duckTo < i.gain ? `(${n(i.gain)}-${n(i.gain - i.duckTo)}*${duckExpression(mergeIntervals(voice))})` : n(i.gain)
  const fin = `min(1,max(0,(t-${n(i.t)})/${FADE_IN}))`
  const fout = i.until !== undefined && i.fadeOut ? `*min(1,max(0,(${n(i.until)}-t)/${n(i.fadeOut)}))` : ''
  return `${duck}*${fin}${fout}`
}

/** The filter graph (no loudnorm yet): inputs are numbered from `first` (input 0 is the video). Output label `[mixed]`. */
export function buildGraph(inputs: readonly MixInput[], voice: readonly [number, number][], first = 1): string {
  const lines: string[] = []
  inputs.forEach((inp, k) => {
    const idx = first + k
    const chain = ['aresample=44100', 'aformat=sample_fmts=fltp:channel_layouts=stereo']
    if (inp.length !== undefined) chain.push(`atrim=duration=${n(inp.length)}`)
    chain.push('asetpts=PTS-STARTPTS')
    const ms = Math.max(0, Math.round(inp.t * 1000))
    if (ms > 0) chain.push(`adelay=${ms}:all=1`)
    chain.push(`volume='${volumeExpression(inp, voice)}':eval=frame`)
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

/** The text after `[mixed]`: pad/cut to the video length, then (optionally) loudnorm. */
function tail(o: MixOptions, norm: string | null): string {
  return `[mixed]apad=whole_dur=${n(o.seconds)},atrim=duration=${n(o.seconds)},asetpts=PTS-STARTPTS${norm ? ',' + norm : ''},aresample=44100[aout]`
}

/** Pass 1: the loudness of the mix as it is. Null when the mix is silent. */
export async function measureLoudness(video: string, inputs: readonly MixInput[], o: MixOptions): Promise<LoudnessMeasure | null> {
  const graph = `${buildGraph(inputs, o.voice)};\n${tail(o, `loudnorm=I=${o.lufs}:TP=${o.truePeak}:LRA=11:print_format=json`)}`
  const err = await ffmpeg(['-v', 'info', '-i', video, ...inputArgs(inputs), '-filter_complex', graph, '-map', '[aout]', '-f', 'null', '-'])
  const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(err)
  if (!json) return null
  const m = JSON.parse(json[0]) as LoudnessMeasure
  return Number.isFinite(Number(m.input_i)) && Number(m.input_i) > -70 ? m : null
}

/** Mixes the audio over the video and writes the final mp4 (`+faststart`). Returns the measurement of pass 1 (null for a silent mix). */
export async function muxEpisode(video: string, inputs: readonly MixInput[], o: MixOptions, out: string): Promise<LoudnessMeasure | null> {
  const m = inputs.length ? await measureLoudness(video, inputs, o) : null
  const norm = m
    ? `loudnorm=I=${o.lufs}:TP=${o.truePeak}:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`
    : null
  const graph = `${buildGraph(inputs, o.voice)};
${tail(o, norm)}`
  await ffmpeg([
    '-y', '-v', 'error', '-i', video, ...inputArgs(inputs), '-filter_complex', graph,
    '-map', '0:v:0', '-map', '[aout]', '-c:v', 'copy', '-c:a', o.audio.codec, '-b:a', o.audio.bitrate, '-ar', '44100',
    '-t', n(o.seconds), '-movflags', '+faststart', out
  ])
  return m
}
