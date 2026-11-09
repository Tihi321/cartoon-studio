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
import { installMiniVehicles } from './fixtures/mini-vehicles'

/**
 * CTS-26, test 5 (HUB-31 CTS-35: on the vehicle fixture): real Blender. Builds mini-vehicles (a car and a train on a road-and-rail set), assembles it
 * (the car on the asphalt, the train on its rails), renders 2 s of the hr preview at 320x180 and checks the film and the frame times.
 */

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cts-blender-e2e-'))
  await installMiniVehicles(dir)
  const store = new SeriesStore(dir)
  await buildEpisodeTimelines(store, 'mini-vehicles', 'ep00-wheels')
  for (const id of ['pip', 'bruno']) expect(await buildCharacter({ dataDir: dir, series: 'mini-vehicles', id, sheet: false })).toMatchObject({ ok: true })
  expect(await buildSet({ dataDir: dir, series: 'mini-vehicles', id: 'crossing', sheet: false })).toMatchObject({ ok: true })
})
afterAll(async () => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }))

describe('Blender backend', () => {
  it('assembles mini-vehicles and renders a 2 s preview: h264 + aac at 24 fps, 48 frame times; a wrong path is E_BLENDER_MISSING', async () => {
    const a = await assembleScene({ dataDir: dir, series: 'mini-vehicles', episode: 'ep00-wheels', lang: 'hr' })
    expect(a).toMatchObject({ ok: true })
    const r = await renderBlenderEpisode({ dataDir: dir, series: 'mini-vehicles', episode: 'ep00-wheels', lang: 'hr', quality: 'preview', maxSeconds: 2, size: { width: 320, height: 180 } })
    const probe = await ffprobe(r.file)
    const v = probe.streams.find((s) => s.codec_type === 'video')!
    expect(v.codec_name).toBe('h264')
    expect(v.r_frame_rate).toBe('24/1')
    expect(`${v.width}x${v.height}`).toBe('320x180')
    expect(probe.streams.find((s) => s.codec_type === 'audio')?.codec_name).toBe('aac')
    expect(Math.abs(Number(probe.format.duration) - 2)).toBeLessThan(0.1)

    const times = JSON.parse(await readFile(path.join(renderDirOf(dir, 'mini-vehicles', 'ep00-wheels', 'hr'), 'blender-times.json'), 'utf8')) as { perFrame: number[]; frames: number; warmMean: number; first: number; p95: number }
    expect(times.perFrame).toHaveLength(48)
    expect(times.frames).toBe(48)
    expect(r.blenderTimes).toMatchObject({ frames: 48 })
    expect(times.warmMean).toBeGreaterThan(0)

    const wrong = createBlenderRunner({ dataDir: dir, config: { ...(await loadBlenderConfig(dir)), path: path.join(dir, 'no-blender', 'blender.exe') } })
    await expect(wrong.run('probe', {})).rejects.toMatchObject({ code: 'E_BLENDER_MISSING' })
  })
})
