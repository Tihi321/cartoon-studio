import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { amplitudeVisemes } from '../src/engine/anim/lipsync'

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
  it('0.5 s silence, 0.5 s soft tone, 0.5 s loud tone, 0.5 s silence give rest, E, A, rest at 12 fps', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cts-lipsync-'))
    const file = path.join(dir, 'line.wav')
    await writeFile(file, wav([[0.5, 0], [0.5, 0.1], [0.5, 0.4], [0.5, 0]]))
    const track = await amplitudeVisemes(file)
    expect(track).toMatchObject({ schema: 'cts.lipsync/1', method: 'amplitude', fps: 12 })
    expect(track.shapes).toEqual([...Array(6).fill('rest'), ...Array(6).fill('E'), ...Array(6).fill('A'), ...Array(6).fill('rest')])
  })
})
