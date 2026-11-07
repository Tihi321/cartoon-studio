import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildStillTimeline, generateClip } from '../src/engine/pipeline/clips'
import type { ClipShots } from '../src/engine/pipeline/clips'
import { SeriesStore } from '../src/engine/series/service'
import type { CtsService } from '../src/engine/service'
import { timelineSchema } from '../src/shared/contracts'
import { installMini } from './fixtures/mini'

/**
 * Flow makes video only (pilot 2 decision 4): the keyframe of a clip is a still drawn by our own player. A fake Flow client has no working
 * `generateImage`; the fake renderer stands in for the headless browser.
 */

let dir: string
let store: SeriesStore
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cts-clips-'))
  await installMini(dir)
  store = new SeriesStore(dir)
  await store.writeBudget('mini', 'ep00-mini', { schema: 'cts.budget/1', capUsd: 0, flowCreditsCap: 50, approvedBy: 'test', approvedAt: '2026-11-07T10:00:00+01:00', note: 'test' })
  const shots: { clips: ClipShots } = {
    clips: [
      {
        id: 'intro',
        who: ['mia', 'bobo'],
        action: 'Mia and Bobo wave at the camera in the park, flat 2D cutout motion.',
        framing: 'wide shot',
        move: 'static',
        keyframe: 'Mia and Bobo stand in the park.',
        seconds: 8,
        staging: { set: 'park', shot: 'two', actors: [{ who: 'mia', mark: 'left', facing: 'right', emotion: 'happy', gesture: 'wave' }, { who: 'bobo', mark: 'right', facing: 'left', emotion: 'neutral' }] }
      }
    ]
  }
  await store.writeFile('mini', 'tasks/clip-shots.json', JSON.stringify(shots))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

function fakes() {
  const calls = { image: 0, video: [] as { firstFrame: string; maxCredits: number }[], stills: [] as string[] }
  const flow = {
    url: 'fake',
    status: async () => ({ up: true, signedIn: true, uploadRights: true }),
    generateImage: async () => {
      calls.image++
      throw new Error('Flow must not make images')
    },
    generateVideo: async (a: { firstFrame: string; maxCredits: number; out: string; name: string }) => {
      calls.video.push({ firstFrame: a.firstFrame, maxCredits: a.maxCredits })
      const file = path.join(dir, `${a.name}-fake.mp4`)
      await writeFile(file, 'not a real video')
      return { file, mediaId: 'm1', creditsSpent: 12 }
    }
  }
  const svc = { dataDir: dir, studios: async () => ({ flow }) } as unknown as CtsService
  const renderStill = async (shot: ClipShots[number]): Promise<string> => {
    const file = path.join(store.paths('mini').root, 'clips', 'keyframes', `${shot.id}.png`)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, 'png')
    calls.stills.push(file)
    return file
  }
  return { calls, svc, renderStill }
}

describe('Flow clips', () => {
  it('the intro keyframe is a player still and exactly one video call goes to Flow; the staging builds a valid one-frame timeline', async () => {
    const { calls, svc, renderStill } = fakes()
    const r = await generateClip({ svc, store, series: 'mini', episode: 'ep00-mini', clip: 'intro', maxCredits: 12, renderStill, log: () => undefined })
    expect(calls.image).toBe(0)
    expect(calls.stills).toHaveLength(1)
    expect(calls.video).toEqual([{ firstFrame: calls.stills[0], maxCredits: 12 }])
    expect(r.keyframe).toBe(calls.stills[0])
    expect(r.credits).toBe(12)
    expect(await stat(path.join(store.paths('mini').root, 'clips', 'intro.mp4')).then((s) => s.isFile())).toBe(true)
    const clips = JSON.parse(await readFile(path.join(store.paths('mini').root, 'clips', 'clips.json'), 'utf8')) as { clips: { id: string }[] }
    expect(clips.clips.map((c) => c.id)).toEqual(['intro'])

    const shot = (JSON.parse(await readFile(store.resolve('mini', 'tasks/clip-shots.json'), 'utf8')) as { clips: ClipShots }).clips[0]!
    const tl = timelineSchema.parse(await buildStillTimeline(store, 'mini', shot))
    expect(Object.keys(tl.actors)).toEqual(['mia', 'bobo'])
    expect(Object.keys(tl.actors.mia!.rot)).toEqual(['arm_r'])
  })

  it('refuses any clip id but intro and outro (no hero), before anything is rendered or sent', async () => {
    const { calls, svc, renderStill } = fakes()
    await expect(generateClip({ svc, store, series: 'mini', episode: 'ep00-mini', clip: 'hero', maxCredits: 12, renderStill, log: () => undefined })).rejects.toThrow(/not allowed.*intro and outro/)
    expect(calls.stills).toHaveLength(0)
    expect(calls.video).toHaveLength(0)
  })
})
