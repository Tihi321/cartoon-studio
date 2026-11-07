import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildEpisodeTimelines } from '../src/engine/anim/timeline'
import { ffprobe, runCapture } from '../src/engine/render/ffmpeg'
import { renderEpisode } from '../src/engine/render/render'
import type { Timeline } from '../src/shared/contracts'
import { SeriesStore } from '../src/engine/series/service'
import { installMini } from './fixtures/mini'

const SIZE = { width: 320, height: 180 }
let dir: string
let store: SeriesStore
let tl: Timeline

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cts-render-'))
  const series = await installMini(dir)
  store = new SeriesStore(dir)
  await buildEpisodeTimelines(store, 'mini', 'ep00-mini')
  tl = await store.readTimeline('mini', 'ep00-mini', 'hr')
  await mkdir(path.join(series, 'clips'), { recursive: true })
  const made = await runCapture('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(series, 'clips', 'intro.mp4')])
  expect(made.code, made.stderr).toBe(0)
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const base = { series: 'mini', episode: 'ep00-mini', lang: 'hr' as const, size: SIZE }
const framesMd5 = async (file: string): Promise<string> => (await runCapture('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'framemd5', '-'])).stdout.split('\n').filter((l) => !l.startsWith('#')).join('\n')
const frameAt = async (file: string, t: number): Promise<string> => (await runCapture('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'md5', '-'])).stdout.trim()

describe('render', () => {
  it('renders 2 s of mini twice to h264 + aac at 24 fps with identical frames; a clip beat splices the real clip in the final only', async () => {
    const a = await renderEpisode({ ...base, dataDir: dir, quality: 'preview', maxSeconds: 2 })
    const hashA = await framesMd5(a.file)
    const probe = await ffprobe(a.file)
    const v = probe.streams.find((s) => s.codec_type === 'video')!
    expect(v.codec_name).toBe('h264')
    expect(v.r_frame_rate).toBe('24/1')
    expect(probe.streams.find((s) => s.codec_type === 'audio')?.codec_name).toBe('aac')
    expect(Math.abs(Number(probe.format.duration) - 2)).toBeLessThan(0.1)

    const b = await renderEpisode({ ...base, dataDir: dir, quality: 'preview', maxSeconds: 2 })
    expect(b.frameDigest).toBe(a.frameDigest) // what the browser drew and sent
    expect(await framesMd5(b.file)).toBe(hashA) // what came out of the encoder

    // splice: a 1 s clip at 1-2 s of a 3 s episode
    const withClip: Timeline = { ...tl, duration: 3, clips: [{ id: 'intro', file: 'clips/intro.mp4', t0: 1, t1: 2, audio: 'mute', fallback: false }] }
    const fin = await renderEpisode({ ...base, dataDir: dir, quality: 'final', timeline: withClip, maxSeconds: 3 })
    const finProbe = await ffprobe(fin.file)
    expect(finProbe.streams.find((s) => s.codec_type === 'video')?.r_frame_rate).toBe('24/1')
    expect(Math.abs(Number(finProbe.format.duration) - 3)).toBeLessThan(0.1)
    const placeholder = await renderEpisode({ ...base, dataDir: dir, quality: 'preview', timeline: withClip, maxSeconds: 3 })
    expect(await frameAt(fin.file, 1.5)).not.toBe(await frameAt(placeholder.file, 1.5))
  })
})
