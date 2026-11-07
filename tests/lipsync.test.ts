import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { amplitudeVisemes, shapesFromRms } from '../src/engine/anim/lipsync'

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

const RATE = 16000

/** 16-bit mono WAV: each part is `[seconds, amplitude]` of a 220 Hz sine (amplitude 0 = silence). */
function wav(parts: [number, number][]): Buffer {
  const chunks: number[] = []
  for (const [seconds, amp] of parts) {
    const n = Math.round(seconds * RATE)
    for (let i = 0; i < n; i++) chunks.push(Math.round(Math.sin((2 * Math.PI * 220 * i) / RATE) * amp * 32767))
  }
  const data = Buffer.alloc(chunks.length * 2)
  chunks.forEach((v, i) => data.writeInt16LE(v, i * 2))
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

describe('amplitude lip-sync', () => {
  it('0.5 s silence, 0.5 s soft tone, 0.5 s loud tone, 0.5 s silence give rest, E, A, rest at 12 fps, with a 2-frame lead and release', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cts-lipsync-'))
    const file = path.join(dir, 'line.wav')
    await writeFile(file, wav([[0.5, 0], [0.5, 0.1], [0.5, 0.4], [0.5, 0]]))
    const track = await amplitudeVisemes(file)
    expect(track).toMatchObject({ schema: 'cts.lipsync/1', method: 'amplitude', fps: 12 })
    expect(track.shapes).toEqual([...Array(4).fill('rest'), ...Array(8).fill('E'), ...Array(6).fill('A'), 'E', 'E', ...Array(4).fill('rest')])
  })

  it('a one-word line padded with silence (relative RMS per frame of the pilot line "Vau?") has the mouth open in at least 60 % of its frames', () => {
    const rms = [0.008, 0.02, 0.027, 0.034, 0.378, 0.949, 1, 0.801, 0.568, 0.091, 0.019, 0.016, 0.011]
    const shapes = shapesFromRms(rms)
    expect(shapes.filter((m) => m !== 'rest').length / shapes.length).toBeGreaterThanOrEqual(0.6)
    expect(shapes.slice(0, 2)).toEqual(['rest', 'rest'])
    expect(shapes.at(-1)).toBe('rest')
  })
})
