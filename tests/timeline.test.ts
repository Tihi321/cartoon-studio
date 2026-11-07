import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildEpisodeTimelines, buildTimeline } from '../src/engine/anim/timeline'
import { lintSeries } from '../src/engine/series/lint'
import { SeriesStore } from '../src/engine/series/service'
import { installMini } from './fixtures/mini'

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
})
