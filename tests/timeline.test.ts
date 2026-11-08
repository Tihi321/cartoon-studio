import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildEpisodeTimelines, buildTimeline } from '../src/engine/anim/timeline'
import { lintSeries } from '../src/engine/series/lint'
import { SeriesStore } from '../src/engine/series/service'
import { loadActingLibrary } from '../src/engine/blender/library'
import { installMini } from './fixtures/mini'
import { installMini3d } from './fixtures/mini3d'

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('timeline builder', () => {
  it('walks the beats with a clock, keeps one beat order for both languages with different times, and the lint finds no silent-mouth error', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cts-timeline-'))
    await installMini(dir)
    const store = new SeriesStore(dir)
    const summary = await buildEpisodeTimelines(store, 'mini', 'ep00-mini')
    expect(summary.languages.map((l) => l.lang)).toEqual(['hr', 'en'])
    const hr = await store.readTimeline('mini', 'ep00-mini', 'hr')
    const en = await store.readTimeline('mini', 'ep00-mini', 'en')

    // the line starts are cumulative durations + pauses (hr 1.2/1.0/1.4 s, en 1.0/0.8/1.2 s; b01 moves 1 s, b03 is a cut, b04 runs with it)
    expect(hr.lines.map((l) => l.t0)).toEqual([1, 2.5, 3.75])
    expect(en.lines.map((l) => l.t0)).toEqual([1, 2.3, 3.35])
    expect(hr.lines.map((l) => l.t1 - l.t0)).toEqual([1.2, 1, 1.4].map((s) => expect.closeTo(s, 5)))
    expect(hr.duration).toBeGreaterThan(en.duration)
    expect(hr.beats!.map((b) => b.id)).toEqual(['b01', 'b02', 'b03', 'b04', 'b05'])
    expect(en.beats!.map((b) => b.id)).toEqual(hr.beats!.map((b) => b.id))
    expect(hr.camera.map((k) => [k.t, k.ease])).toEqual([[0, 'cut'], [2.5, 'cut']])
    expect(hr.scriptHash).toBe(await store.scriptHash('mini', 'ep00-mini'))

    // mouth is rest outside every line of the speaker, so E_MOUTH_SILENT stays quiet; the pair has the same beat order
    const lint = await lintSeries(store, 'mini', { episode: 'ep00-mini', requireAudio: true })
    expect(lint.errors.filter((e) => ['E_MOUTH_SILENT', 'E_LANG_ORDER', 'E_TIMELINE_STALE'].includes(e.code))).toEqual([])
    expect(lint.stats.minShare).toBeGreaterThan(0.6)

    // "with: prev" shares the previous beat's start: a line that runs with a cut placed inside the first line overlaps it
    const script = await store.readScript('mini', 'ep00-mini')
    script.scenes[0]!.beats[2] = { ...script.scenes[0]!.beats[2]!, with: 'prev' } as never
    await store.writeScript('mini', 'ep00-mini', script)
    const over = await buildTimeline(store, 'mini', 'ep00-mini', 'hr')
    expect(over.lines[1]!.t0).toBe(over.lines[0]!.t0)
    expect(over.lines[2]!.t0).toBeCloseTo(over.lines[0]!.t0 + 1.2 + 0.3, 5)
  })

  it('a Blender series gets the same actions in the same order in both languages with different times, gestures within the manifest limits, and the mouth shut outside every line', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cts-timeline3d-'))
    await installMini3d(dir)
    const store = new SeriesStore(dir)
    await buildEpisodeTimelines(store, 'mini3d', 'ep00-mini3d')
    const hr = await store.readTimeline3d('mini3d', 'ep00-mini3d', 'hr')
    const en = await store.readTimeline3d('mini3d', 'ep00-mini3d', 'en')
    const order = (tl: typeof hr) => Object.entries(tl.actors).flatMap(([id, a]) => a.actions.map((x) => `${id}:${x.beat}:${x.action}`))
    expect(order(hr)).toEqual(order(en))
    expect(order(hr)).toEqual(['tilly:b01:wave', 'tilly:b03:point', 'tilly:b05:walk', 'tilly:b06:sit'])
    expect(hr.beats!.map((b) => b.id)).toEqual(en.beats!.map((b) => b.id))
    expect(hr.duration).toBeGreaterThan(en.duration)
    expect(hr.actors.tilly!.actions[0]!.t1 - hr.actors.tilly!.actions[0]!.t0).not.toBe(en.actors.tilly!.actions[0]!.t1 - en.actors.tilly!.actions[0]!.t0)
    const lib = loadActingLibrary()
    for (const tl of [hr, en]) {
      for (const a of Object.values(tl.actors)) {
        for (const x of a.actions) {
          const spec = lib.byName.get(x.action)!
          expect(x.t1 - x.t0, `${x.action} in ${tl.lang}`).toBeGreaterThanOrEqual(spec.seconds.min - 1e-6)
          if (spec.kind !== 'locomotion') expect(x.t1 - x.t0, `${x.action} in ${tl.lang}`).toBeLessThanOrEqual(spec.seconds.max + 1e-6)
        }
      }
      expect(tl.shots.map((k) => k.shot)).toEqual(['wide', 'two', 'cu-tilly'])
    }
    const lint = await lintSeries(store, 'mini3d', { episode: 'ep00-mini3d', requireAudio: true })
    expect(lint.errors).toEqual([])
    // every non-rest mouth key lies inside a line of its own actor
    for (const tl of [hr, en]) {
      for (const [id, a] of Object.entries(tl.actors)) {
        const own = tl.lines.filter((l) => l.speaker === id)
        a.mouth.forEach(([t, v], i) => {
          if (v === 'rest') return
          const t1 = a.mouth[i + 1]?.[0] ?? tl.duration
          expect(own.some((l) => t >= l.t0 - 1e-6 && t1 <= l.t1 + 1 / 24 + 1e-6), `${id} ${v} at ${t} in ${tl.lang}`).toBe(true)
        })
      }
    }
  })
})
