import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildEpisodeTimelines } from '../src/engine/anim/timeline'
import { loadBlenderConfig } from '../src/engine/blender/config'
import { assembleScene, buildCharacter, buildSet, renderDirOf } from '../src/engine/blender/jobs'
import { createBlenderRunner } from '../src/engine/blender/runner'
import { ffprobe } from '../src/engine/render/ffmpeg'
import { renderBlenderEpisode } from '../src/engine/render/blender'
import { SeriesStore } from '../src/engine/series/service'
import { installMini3d } from './fixtures/mini3d'

/** CTS-26, test 5: real Blender. Builds mini3d, assembles it, renders 2 s of the hr preview at 320x180 and checks the film and the frame times. */

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cts-blender-e2e-'))
  await installMini3d(dir)
  const store = new SeriesStore(dir)
  await buildEpisodeTimelines(store, 'mini3d', 'ep00-mini3d')
  for (const id of ['tilly', 'blobby']) expect(await buildCharacter({ dataDir: dir, series: 'mini3d', id, sheet: false })).toMatchObject({ ok: true })
  expect(await buildSet({ dataDir: dir, series: 'mini3d', id: 'park', sheet: false })).toMatchObject({ ok: true })
})
afterAll(async () => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }))

describe('Blender backend', () => {
  it('assembles mini3d and renders a 2 s preview: h264 + aac at 24 fps, 48 frame times; a wrong path is E_BLENDER_MISSING', async () => {
    const a = await assembleScene({ dataDir: dir, series: 'mini3d', episode: 'ep00-mini3d', lang: 'hr' })
    expect(a).toMatchObject({ ok: true })
    const r = await renderBlenderEpisode({ dataDir: dir, series: 'mini3d', episode: 'ep00-mini3d', lang: 'hr', quality: 'preview', maxSeconds: 2, size: { width: 320, height: 180 } })
    const probe = await ffprobe(r.file)
    const v = probe.streams.find((s) => s.codec_type === 'video')!
    expect(v.codec_name).toBe('h264')
    expect(v.r_frame_rate).toBe('24/1')
    expect(`${v.width}x${v.height}`).toBe('320x180')
    expect(probe.streams.find((s) => s.codec_type === 'audio')?.codec_name).toBe('aac')
    expect(Math.abs(Number(probe.format.duration) - 2)).toBeLessThan(0.1)

    const times = JSON.parse(await readFile(path.join(renderDirOf(dir, 'mini3d', 'ep00-mini3d', 'hr'), 'blender-times.json'), 'utf8')) as { perFrame: number[]; frames: number; warmMean: number; first: number; p95: number }
    expect(times.perFrame).toHaveLength(48)
    expect(times.frames).toBe(48)
    expect(r.blenderTimes).toMatchObject({ frames: 48 })
    expect(times.warmMean).toBeGreaterThan(0)

    const wrong = createBlenderRunner({ dataDir: dir, config: { ...(await loadBlenderConfig(dir)), path: path.join(dir, 'no-blender', 'blender.exe') } })
    await expect(wrong.run('probe', {})).rejects.toMatchObject({ code: 'E_BLENDER_MISSING' })
  })
})
