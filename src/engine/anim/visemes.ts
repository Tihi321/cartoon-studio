import type { Lang, Lipsync, MouthShape, VoiceLine } from '../../shared/contracts'
import type { SeriesStore } from '../series/service'
import { decodeMono16k } from './lipsync'

/**
 * Six-viseme lip-sync of a Blender series (HUB-30 decision 7), 24 fps, from the line's text and audio:
 *   1. `words-<lang>`: the words whisper heard (flow-music-mcp `flow_transcribe`) are aligned to the script words by a normalised edit distance;
 *      the letters of each matched word get visemes inside that word's own `[t0, t1]` (an unmatched word between two matched ones shares the gap).
 *   2. `text-<lang>`: when whisper is down or fewer than ALIGN_FLOOR of the words align, the voiced segments of the RMS envelope are matched to the
 *      text's phrases and the letters are spread over the voiced time (vowels weigh more than consonants).
 * Letter rules: hr is phonetic (`lj` `nj` `dž` are one letter); en has a small grapheme table. Then: a shape holds at least 2 frames and a lip
 * closure (`MBP`) is always shown for 2 frames. The canvas series keep the amplitude lip-sync of `lipsync.ts`.
 */

export const VISEME_FPS = 24
/** Fewer matched script words than this share and the words method is not trusted. */
export const ALIGN_FLOOR = 0.7
/** Two words match when 1 - edit distance / longer length reaches this. */
const MATCH_MIN = 0.6
const MIN_HOLD = 2
const CLOSURE_FRAMES = 2
const SAMPLE_RATE = 16000
/** Weight of a vowel and of a consonant when the letters share a stretch of time. */
const W_VOWEL = 1
const W_CONS = 0.55
/** Seconds a letter weight unit is worth for words that have no neighbour to share a gap with. */
const UNIT_S = 0.12

/** The shapes of the six-viseme methods. */
export const SIX_VISEMES: readonly MouthShape[] = ['rest', 'A', 'E', 'O', 'U', 'MBP']
type Viseme = 'rest' | 'A' | 'E' | 'O' | 'U' | 'MBP'

export interface HeardWord {
  w: string
  t0: number
  t1: number
}

// ---- letters -> visemes ----

interface Tok {
  /** The viseme, or `next`: the viseme of the next vowel letter of the word (k g h), else E. */
  v: Viseme | 'next'
  vowel: boolean
}

const VOWELS: Record<string, Viseme> = { a: 'A', e: 'E', i: 'E', o: 'O', u: 'U' }
const LABIALS = new Set(['m', 'b', 'p', 'f', 'v'])

const cons = (ch: string): Tok => ({ v: LABIALS.has(ch) ? 'MBP' : 'kgh'.includes(ch) ? 'next' : 'E', vowel: false })

function hrTokens(word: string): Tok[] {
  const t = word.toLowerCase().replace(/dž/g, 'ʒ').replace(/lj/g, 'λ').replace(/nj/g, 'ɲ')
  const out: Tok[] = []
  for (const ch of t) {
    if (!/\p{L}/u.test(ch)) continue
    const v = VOWELS[ch]
    out.push(v ? { v, vowel: true } : cons(ch))
  }
  return out
}

/** English graphemes: digraphs first. The spelling is rough, so the word times (words method) carry the timing and this only picks the shape. */
const EN_DIGRAPHS: Record<string, Tok> = {
  th: { v: 'E', vowel: false },
  sh: { v: 'E', vowel: false },
  ch: { v: 'E', vowel: false },
  ph: { v: 'MBP', vowel: false },
  qu: { v: 'U', vowel: false },
  ee: { v: 'E', vowel: true },
  oo: { v: 'U', vowel: true },
  ou: { v: 'O', vowel: true },
  ow: { v: 'O', vowel: true },
  ai: { v: 'E', vowel: true },
  ay: { v: 'E', vowel: true }
}

function enTokens(word: string): Tok[] {
  let t = word.toLowerCase().replace(/[^a-z]/g, '')
  // a silent final e after a consonant ("like", "make"), not in short words ("the", "he")
  if (t.length >= 4 && t.endsWith('e') && !(t[t.length - 2]! in VOWELS)) t = t.slice(0, -1)
  const out: Tok[] = []
  for (let i = 0; i < t.length; i++) {
    const two = EN_DIGRAPHS[t.slice(i, i + 2)]
    if (two) {
      out.push(two)
      i++
      continue
    }
    const ch = t[i]!
    if (ch === 'w') out.push({ v: 'U', vowel: false })
    else if (ch === 'y') out.push({ v: 'E', vowel: false })
    else if (VOWELS[ch]) out.push({ v: VOWELS[ch]!, vowel: true })
    else out.push(cons(ch))
  }
  return out
}

const tokensOf = (word: string, lang: Lang): Tok[] => resolve(lang === 'hr' ? hrTokens(word) : enTokens(word))

/** Resolves `next` to the viseme of the next token when that is a vowel, else E. */
function resolve(toks: Tok[]): Tok[] {
  return toks.map((t, i) => {
    if (t.v !== 'next') return t
    const n = toks[i + 1]
    return { v: n && n.vowel && n.v !== 'next' ? n.v : 'E', vowel: false }
  })
}

const weight = (t: Tok): number => (t.vowel ? W_VOWEL : W_CONS)

/** The words of a text, with the spelling kept (punctuation off the ends). */
export function scriptWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((w) => /[\p{L}\p{N}]/u.test(w))
}

/** Whether the text has a letter that closes the lips, so its mouth must show `MBP` at least once. */
export function textHasLabial(text: string, lang: Lang): boolean {
  return scriptWords(text).some((w) => tokensOf(w, lang).some((t) => t.v === 'MBP'))
}

// ---- alignment of the heard words to the script words ----

const norm = (w: string): string =>
  w
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '')

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)))
    prev = cur
  }
  return prev[b.length]!
}

/** 1 for equal words, 0 for nothing in common. */
export function wordSimilarity(a: string, b: string): number {
  const x = norm(a)
  const y = norm(b)
  const longest = Math.max(x.length, y.length)
  return longest === 0 ? 0 : 1 - editDistance(x, y) / longest
}

export interface Alignment {
  /** The script words that found a heard word, in the script's spelling, with that word's times. */
  words: HeardWord[]
  /** Index of each aligned word in `scriptWords(text)`. */
  index: number[]
  total: number
  /** Aligned script words / script words. */
  coverage: number
}

/** Aligns the heard words to the script words (best total similarity, order kept, a pair needs MATCH_MIN). */
export function alignWords(text: string, heard: readonly HeardWord[]): Alignment {
  const script = scriptWords(text)
  const n = script.length
  const m = heard.length
  const sim = script.map((s) => heard.map((h) => wordSimilarity(s, h.w)))
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const s = sim[i - 1]![j - 1]!
      dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!, s >= MATCH_MIN ? dp[i - 1]![j - 1]! + s : -1)
    }
  const pairs: [number, number][] = []
  for (let i = n, j = m; i > 0 && j > 0; ) {
    const s = sim[i - 1]![j - 1]!
    if (s >= MATCH_MIN && Math.abs(dp[i]![j]! - (dp[i - 1]![j - 1]! + s)) < 1e-9) {
      pairs.push([i - 1, j - 1])
      i--
      j--
    } else if (dp[i]![j]! === dp[i - 1]![j]!) i--
    else j--
  }
  pairs.reverse()
  return {
    words: pairs.map(([i, j]) => ({ w: script[i]!, t0: heard[j]!.t0, t1: heard[j]!.t1 })),
    index: pairs.map(([i]) => i),
    total: n,
    coverage: n === 0 ? 0 : pairs.length / n
  }
}

// ---- timed visemes ----

interface Timed {
  t0: number
  t1: number
  v: Viseme
}

/** Spreads tokens over `[a, b]` by their weights. */
function spread(toks: Tok[], a: number, b: number, out: Timed[]): void {
  const total = toks.reduce((s, t) => s + weight(t), 0)
  if (total === 0 || b <= a) return
  let t = a
  for (const tok of toks) {
    const d = ((b - a) * weight(tok)) / total
    out.push({ t0: t, t1: t + d, v: tok.v as Viseme })
    t += d
  }
}

/** Words method: every script word gets a window, its heard times or its share of the gap between the heard words around it. */
function wordsTimed(text: string, lang: Lang, al: Alignment, seconds: number): Timed[] {
  const script = scriptWords(text)
  const toks = script.map((w) => tokensOf(w, lang))
  const wt = (i: number): number => toks[i]!.reduce((s, t) => s + weight(t), 0)
  const win: ([number, number] | null)[] = script.map(() => null)
  al.index.forEach((si, k) => (win[si] = [al.words[k]!.t0, al.words[k]!.t1]))
  const out: Timed[] = []
  let i = 0
  while (i < script.length) {
    if (win[i]) {
      spread(toks[i]!, win[i]![0], win[i]![1], out)
      i++
      continue
    }
    let j = i
    while (j < script.length && !win[j]) j++
    // the run [i, j) has no heard word: it shares the gap between its neighbours (or UNIT_S per weight unit at the line's ends)
    const w = Array.from({ length: j - i }, (_, k) => wt(i + k))
    const sum = w.reduce((s, x) => s + x, 0)
    const before = i > 0 ? win[i - 1]![1] : null
    const after = j < script.length ? win[j]![0] : null
    let a = before ?? Math.max(0, (after ?? 0) - sum * UNIT_S)
    let b = after ?? Math.min(seconds, a + sum * UNIT_S)
    if (before === null && after === null) {
      a = 0
      b = seconds
    }
    let t = a
    for (let k = i; k < j; k++) {
      const d = sum === 0 ? 0 : ((b - a) * w[k - i]!) / sum
      spread(toks[k]!, t, t + d, out)
      t += d
    }
    i = j
  }
  return out
}

/** The voiced segments `[t0, t1]` of a signal: RMS over 10 ms hops above 8 % of the peak, gaps under 90 ms closed, blips under 50 ms dropped. */
export function voicedSegments(samples: Float32Array, rate = SAMPLE_RATE): [number, number][] {
  const hop = Math.floor(rate / 100)
  const rms: number[] = []
  for (let a = 0; a + hop <= samples.length; a += hop) {
    let s = 0
    for (let k = a; k < a + hop; k++) s += samples[k]! * samples[k]!
    rms.push(Math.sqrt(s / hop))
  }
  const peak = rms.reduce((m, v) => Math.max(m, v), 0)
  if (peak < 0.003) return []
  const on = rms.map((v) => v > peak * 0.08)
  const segs: [number, number][] = []
  for (let i = 0; i < on.length; ) {
    if (!on[i]) {
      i++
      continue
    }
    let j = i
    while (j < on.length && on[j]) j++
    const last = segs[segs.length - 1]
    if (last && i - last[1] < 9) last[1] = j
    else segs.push([i, j])
    i = j
  }
  return segs.filter(([a, b]) => b - a >= 5).map(([a, b]) => [a / 100, b / 100])
}

/** Text method: phrases (cut at punctuation) are paired with the voiced segments when the counts agree, else all letters share the voiced time. */
function textTimed(text: string, lang: Lang, segs: [number, number][]): Timed[] {
  if (segs.length === 0) return []
  const phrases = text
    .split(/[,.!?;:…\n]+/)
    .map((p) => scriptWords(p).flatMap((w) => tokensOf(w, lang)))
    .filter((p) => p.length > 0)
  const out: Timed[] = []
  if (phrases.length === segs.length) {
    phrases.forEach((p, i) => spread(p, segs[i]![0], segs[i]![1], out))
    return out
  }
  // one clock over the voiced time only: a letter's share of the total weight is its share of the voiced seconds
  const flat = phrases.flat()
  const total = flat.reduce((s, t) => s + weight(t), 0)
  const voiced = segs.reduce((s, [a, b]) => s + (b - a), 0)
  let acc = 0
  for (const t of flat) {
    const u0 = (acc / total) * voiced
    acc += weight(t)
    const u1 = (acc / total) * voiced
    // a letter across a segment boundary is cut in two
    let cum = 0
    for (const [a, b] of segs) {
      const lo = Math.max(u0, cum)
      const hi = Math.min(u1, cum + (b - a))
      if (hi > lo + 1e-9) out.push({ t0: a + (lo - cum), t1: a + (hi - cum), v: t.v as Viseme })
      cum += b - a
    }
  }
  return out
}

/** One shape per frame (sampled at the frame centre), the closures forced to CLOSURE_FRAMES, every other run held for MIN_HOLD. */
function toFrames(timed: Timed[], seconds: number, fps: number): Viseme[] {
  const n = Math.max(1, Math.ceil(seconds * fps - 1e-9))
  const sorted = [...timed].sort((a, b) => a.t0 - b.t0)
  const frames: Viseme[] = []
  let k = 0
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / fps
    while (k < sorted.length && sorted[k]!.t1 <= t) k++
    frames.push(sorted[k] && sorted[k]!.t0 <= t ? sorted[k]!.v : 'rest')
  }
  for (const s of sorted) {
    if (s.v !== 'MBP') continue
    const f = Math.floor(s.t0 * fps + 1e-9)
    for (let c = 0; c < CLOSURE_FRAMES && f + c < n; c++) frames[f + c] = 'MBP'
  }
  let runs: { v: Viseme; n: number }[] = []
  const collect = (list: Viseme[]): void => {
    runs = []
    for (const v of list) {
      const last = runs[runs.length - 1]
      if (last && last.v === v) last.n++
      else runs.push({ v, n: 1 })
    }
  }
  collect(frames)
  for (let guard = 0; guard < n; guard++) {
    // the silence at either end stays rest however short; a short closure was already stretched
    const i = runs.findIndex((r, idx) => r.n < MIN_HOLD && r.v !== 'MBP' && !(r.v === 'rest' && (idx === 0 || idx === runs.length - 1)))
    if (i < 0 || runs.length === 1) break
    const into = runs[i - 1] ?? runs[i + 1]!
    into.n += runs[i]!.n
    runs.splice(i, 1)
    collect(runs.flatMap((r) => Array<Viseme>(r.n).fill(r.v)))
  }
  return runs.flatMap((r) => Array<Viseme>(r.n).fill(r.v))
}

export interface VisemeInput {
  text: string
  lang: Lang
  /** The words whisper heard (the manifest's `words`), when it was asked. */
  words?: readonly HeardWord[] | null
  /** The line's mono 16 kHz samples; needed by the text method. */
  samples?: Float32Array
  /** The line's length when there are no samples. */
  seconds?: number
  fps?: number
}

/** The lip-sync of one line: the words method when enough words align, else the text method. */
export function visemeTrack(i: VisemeInput): Lipsync {
  const fps = i.fps ?? VISEME_FPS
  const seconds = i.samples ? i.samples.length / SAMPLE_RATE : (i.seconds ?? 0)
  const al = i.words?.length ? alignWords(i.text, i.words) : null
  if (al && al.coverage >= ALIGN_FLOOR) {
    const end = Math.max(seconds, ...al.words.map((w) => w.t1))
    return { schema: 'cts.lipsync/1', method: `words-${i.lang}`, fps, shapes: toFrames(wordsTimed(i.text, i.lang, al, end), end, fps) }
  }
  const timed = i.samples ? textTimed(i.text, i.lang, voicedSegments(i.samples)) : []
  return { schema: 'cts.lipsync/1', method: `text-${i.lang}`, fps, shapes: toFrames(timed, seconds, fps) }
}

/** Makes the lip-sync of one line and writes `episodes/<ep>/lipsync/<lang>/<line>.json`. A missing or unreadable file gives the words method if the words allow it, else all `rest`. */
export async function writeLineVisemes(
  store: SeriesStore,
  series: string,
  episode: string,
  lang: Lang,
  line: string,
  o: { wavPath: string | null; text: string; seconds: number; words?: VoiceLine['words'] }
): Promise<Lipsync> {
  let samples: Float32Array | undefined
  try {
    if (o.wavPath) samples = await decodeMono16k(o.wavPath)
  } catch {
    /* no samples: the words method or rest */
  }
  const track = visemeTrack({ text: o.text, lang, words: o.words ?? null, ...(samples ? { samples } : {}), seconds: o.seconds })
  return store.writeLipsync(series, episode, lang, line, track)
}
