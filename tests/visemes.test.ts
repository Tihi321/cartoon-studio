import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeMono16k } from '../src/engine/anim/lipsync'
import { alignWords, visemeTrack } from '../src/engine/anim/visemes'
import { normaliseWav, shiftWords } from '../src/engine/voice/audio'

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

const RATE = 16000

/** 16-bit mono WAV: each part is `[seconds, amplitude]` of a 220 Hz sine (amplitude 0 = silence). */
function wav(parts: [number, number][]): Buffer {
  const samples: number[] = []
  for (const [seconds, amp] of parts) for (let i = 0, n = Math.round(seconds * RATE); i < n; i++) samples.push(Math.round(Math.sin((2 * Math.PI * 220 * i) / RATE) * amp * 32767))
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((v, i) => data.writeInt16LE(v, i * 2))
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(RATE, 24)
  head.writeUInt32LE(RATE * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

/** Run-length form of a shape list: `rest*6 MBP*2 ...`, so a golden reads. */
const runs = (shapes: string[]): string[] => {
  const out: string[] = []
  for (const s of shapes) {
    const last = out[out.length - 1]
    const m = last?.match(/^(\S+)\*(\d+)$/)
    if (m && m[1] === s) out[out.length - 1] = `${s}*${Number(m[2]) + 1}`
    else out.push(`${s}*1`)
  }
  return out
}

/** A constant tone as samples (no file): `[seconds, amplitude]` parts. */
const tone = (parts: [number, number][]): Float32Array => {
  const out: number[] = []
  for (const [seconds, amp] of parts) for (let i = 0, n = Math.round(seconds * RATE); i < n; i++) out.push(Math.sin((2 * Math.PI * 220 * i) / RATE) * amp)
  return Float32Array.from(out)
}

describe('six-viseme lip-sync', () => {
  it('hr text method: "Mama, dobro jutro!" over two voiced segments at 24 fps, closures held 2 frames, rest outside the voiced time', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cts-visemes-'))
    const file = path.join(dir, 'line.wav')
    await writeFile(file, wav([[0.25, 0], [0.8, 0.4], [0.3, 0], [0.9, 0.4], [0.25, 0]]))
    const track = visemeTrack({ text: 'Mama, dobro jutro!', lang: 'hr', samples: await decodeMono16k(file) })
    expect(track).toMatchObject({ schema: 'cts.lipsync/1', method: 'text-hr', fps: 24 })
    // voiced 0.25-1.05 s ("Mama": m a m a) and 1.35-2.25 s ("dobro jutro"); 60 frames; every MBP run is at least 2 frames
    expect(runs(track.shapes)).toEqual([
      'rest*6', 'MBP*3', 'A*6', 'MBP*4', 'A*6', 'rest*7',
      'E*2', 'O*2', 'MBP*4', 'O*3', 'E*2', 'U*3', 'E*3', 'O*3', 'rest*6'
    ])
  })

  it('whisper words: the letters of a matched word stay inside its times, a misheard word shares the gap, and under 70 % aligned it falls back to the text method', () => {
    const text = 'Mama dobro jutro dragi Bruno'
    const heard = [
      { w: 'Mama', t0: 0.2, t1: 0.6 },
      { w: 'dobro', t0: 0.7, t1: 1.2 },
      { w: 'jutro', t0: 1.3, t1: 1.8 },
      { w: 'kuća', t0: 1.9, t1: 2.2 }, // "dragi" misheard
      { w: 'Bruno', t0: 2.4, t1: 2.9 }
    ]
    expect(alignWords(text, heard)).toMatchObject({ total: 5, coverage: 0.8, index: [0, 1, 2, 4] })
    const track = visemeTrack({ text, lang: 'hr', words: heard, seconds: 3 })
    expect(track.method).toBe('words-hr')
    const at = (t0: number, t1: number) => track.shapes.slice(Math.ceil(t0 * 24), Math.floor(t1 * 24))
    expect(new Set(at(0.2, 0.6))).toEqual(new Set(['MBP', 'A']))
    expect(new Set(at(0.7, 1.2))).toEqual(new Set(['E', 'O', 'MBP']))
    expect(new Set(at(2.4, 2.9))).toEqual(new Set(['MBP', 'E', 'U', 'O']))
    expect(track.shapes.slice(15, 17)).toEqual(['rest', 'rest']) // the gap between two heard words
    expect(track.shapes.slice(0, 4).every((s) => s === 'rest')).toBe(true)

    const poor = [heard[0]!, { w: 'ništa', t0: 0.7, t1: 1.2 }, { w: 'tamo', t0: 1.3, t1: 1.8 }, heard[3]!, { w: 'x', t0: 2.4, t1: 2.9 }]
    expect(alignWords(text, poor).coverage).toBe(0.2)
    expect(visemeTrack({ text, lang: 'hr', words: poor, samples: tone([[0.2, 0], [2.7, 0.4], [0.1, 0]]) }).method).toBe('text-hr')
  })

  it('en: "Bruno, look up!" shows MBP for the b and U for "oo" and "u"', () => {
    const track = visemeTrack({ text: 'Bruno, look up!', lang: 'en', samples: tone([[0.2, 0], [0.5, 0.4], [0.2, 0], [0.6, 0.4], [0.2, 0]]) })
    expect(track.method).toBe('text-en')
    expect(track.shapes.find((s) => s !== 'rest')).toBe('MBP')
    expect(new Set(track.shapes)).toEqual(new Set(['rest', 'MBP', 'E', 'U', 'O']))
    expect(runs(track.shapes).filter((r) => r.startsWith('MBP')).every((r) => Number(r.split('*')[1]) >= 2)).toBe(true)
  })

  it('CTS-40: ElevenLabs word times of pilot 4 en l12 keep the mouth moving between words (not flat), the sentence pause stays rest, "I" keeps a frame', () => {
    const text = 'Left is clear. Right is clear. Now I go!'
    const words = [['Left', 0, 0.267], ['is', 0.313, 0.383], ['clear', 0.441, 0.743], ['Right', 1.242, 1.474], ['is', 1.509, 1.579], ['clear', 1.637, 1.916], ['Now', 2.113, 2.264], ['I', 2.334, 2.357], ['go', 2.45, 2.624]].map(([w, t0, t1]) => ({ w: w as string, t0: t0 as number, t1: t1 as number }))
    const track = visemeTrack({ text, lang: 'en', words, seconds: 2.761 })
    expect(track.method).toBe('words-en')
    expect(track.shapes.filter((s) => s !== 'rest').length / track.shapes.length).toBeGreaterThan(0.6)
    expect(track.shapes.slice(20, 28).every((s) => s === 'rest')).toBe(true) // 0.74-1.24 s: the pause after "Left is clear."
    expect(track.shapes[56]).not.toBe('rest') // 2.33-2.36 s: "I"
  })

  it('ElevenLabs words follow the trimmed lead silence: 0.4 s of silence, words from 0.42 s, stored from about 0.17 s (0.15 s kept)', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cts-eleven-words-'))
    const raw = path.join(dir, 'raw.wav')
    await writeFile(raw, wav([[0.4, 0], [1.0, 0.5], [0.3, 0]]))
    const norm = await normaliseWav(raw, path.join(dir, 'clip.wav'), { measureLead: true })
    expect(norm.leadTrimS).toBeCloseTo(0.25, 1)
    const words = shiftWords([{ w: 'Bruno', t0: 0.42, t1: 0.8 }, { w: 'čekaj', t0: 0.85, t1: 1.38 }, { w: 'malo', t0: 1.38, t1: 9 }], norm.leadTrimS, norm.seconds)
    expect(words[0]!.t0).toBeGreaterThan(0.12)
    expect(words[0]!.t0).toBeLessThan(0.22)
    expect(words.every((x) => x.t0 >= 0 && x.t1 <= norm.seconds && x.t0 <= x.t1)).toBe(true)
  })
})
