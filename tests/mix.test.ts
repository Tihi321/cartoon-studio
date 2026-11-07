import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_MIX, runCapture } from '../src/engine/render/ffmpeg'
import { muxEpisode } from '../src/engine/render/mix'
import type { MixCheck } from '../src/engine/render/mixcheck'

let dir: string
const f = (name: string): string => path.join(dir, name)
const gen = async (out: string, args: string[]): Promise<void> => {
  const r = await runCapture('ffmpeg', ['-y', '-v', 'error', ...args, out])
  expect(r.code, r.stderr).toBe(0)
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cts-mix-'))
  // a loud square-wave "music" (about -8 LUFS), two quiet "voices" (about -32 LUFS), a black video of the same length
  await gen(f('music.wav'), ['-f', 'lavfi', '-i', 'sine=f=220:d=6,aeval=0.5*sgn(val(0)):c=same,volume=-1dB', '-ar', '44100', '-ac', '2'])
  await gen(f('v1.wav'), ['-f', 'lavfi', '-i', 'sine=f=300:d=3,volume=-30dB', '-ar', '44100', '-ac', '2'])
  await gen(f('v2.wav'), ['-f', 'lavfi', '-i', 'sine=f=400:d=3,volume=-30dB', '-ar', '44100', '-ac', '2'])
  await gen(f('video.mp4'), ['-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=24:d=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'])
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('mix', () => {
  it('puts a loud music bed at least 15 dB under quiet voices while they play, and about 8 dB under in the gaps', async () => {
    const check = f('render/mix-check.json')
    const lines = [
      { id: 'l1', t0: 2, t1: 5 },
      { id: 'l2', t0: 14, t1: 17 }
    ]
    const r = await muxEpisode(
      f('video.mp4'),
      [
        { file: f('v1.wav'), kind: 'voice', t: 2, gain: 1 },
        { file: f('v2.wav'), kind: 'voice', t: 14, gain: 1 },
        { file: f('music.wav'), kind: 'music', t: 0, gain: 1, loop: true, length: 24, until: 24, fadeOut: 1 }
      ],
      { voice: lines.map((l) => [l.t0, l.t1] as [number, number]), lines, mix: DEFAULT_MIX, levelsFile: f('render/levels.json'), checkFile: check, seconds: 24, lufs: -16, truePeak: -1.5, audio: { codec: 'aac', bitrate: '160k' } },
      f('out.mp4')
    )
    expect(r.loudness).not.toBeNull()
    const written = JSON.parse(await readFile(check, 'utf8')) as MixCheck
    expect(written.lines.map((l) => l.id)).toEqual(['l1', 'l2'])
    expect(written.minUnderDb).toBeGreaterThanOrEqual(15)
    expect(Math.abs(written.gapMusicUnderVoiceDb! - 8)).toBeLessThanOrEqual(2)
    expect(Object.keys(JSON.parse(await readFile(f('render/levels.json'), 'utf8')) as object)).toHaveLength(3)
  })
})
