import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RIG_PATHS } from '../src/engine/pipeline/rig'
import { lintSeries } from '../src/engine/series/lint'
import { rigVariantSchema } from '../src/shared/contracts'
import { SeriesStore } from '../src/engine/series/service'
import { installMini } from './fixtures/mini'
import { installMini3d } from './fixtures/mini3d'

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('contracts and lint', () => {
  it('the fixture mini parses clean; a rig without a mouth shape gives E_RIG_PART and a script with an unknown cast id gives E_CAST_UNKNOWN', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cts-contracts-'))
    const root = await installMini(dir)
    const store = new SeriesStore(dir)

    const clean = await lintSeries(store, 'mini', { episode: 'ep00-mini', requireAudio: true })
    expect(clean.errors).toEqual([])
    expect(clean.rigs.map((r) => r.cast)).toEqual(['mia', 'bobo'])

    const rigFile = path.join(root, 'cast', 'mia', 'rig.json')
    const rig = JSON.parse(await readFile(rigFile, 'utf8'))
    delete rig.face.mouth.shapes.O
    await writeFile(rigFile, JSON.stringify(rig))
    const scriptFile = path.join(root, 'episodes', 'ep00-mini', 'script.json')
    const script = JSON.parse(await readFile(scriptFile, 'utf8'))
    script.scenes[0].beats[1].speaker = 'zed'
    await writeFile(scriptFile, JSON.stringify(script))

    const broken = await lintSeries(store, 'mini', { episode: 'ep00-mini' })
    expect(broken.ok).toBe(false)
    expect(broken.errors.map((e) => e.code)).toEqual(expect.arrayContaining(['E_RIG_PART', 'E_CAST_UNKNOWN']))
    expect(broken.errors.find((e) => e.code === 'E_RIG_PART')?.message).toMatch(/"O"/)
  })

  it('the fixture mini3d (renderer blender) lints clean; a script with an unknown gesture gives E_ACTION_UNKNOWN', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cts-contracts-'))
    const root = await installMini3d(dir)
    const store = new SeriesStore(dir)

    expect((await store.readBible('mini3d')).renderer).toBe('blender')
    const clean = await lintSeries(store, 'mini3d', { episode: 'ep00-mini3d', requireAudio: true })
    expect(clean.errors).toEqual([])
    expect(clean.warnings).toEqual([])

    const scriptFile = path.join(root, 'episodes', 'ep00-mini3d', 'script.json')
    const script = JSON.parse(await readFile(scriptFile, 'utf8'))
    script.scenes[0].beats[2].gesture = 'moonwalk'
    await writeFile(scriptFile, JSON.stringify(script))
    const broken = await lintSeries(store, 'mini3d', { episode: 'ep00-mini3d' })
    expect(broken.errors.map((e) => e.code)).toEqual(['E_ACTION_UNKNOWN'])
  })

  it('rig variant b and the recraft-svg path are gone; only a (claude-svg) and c (raster) remain', () => {
    expect(rigVariantSchema.safeParse('b').success).toBe(false)
    expect(rigVariantSchema.safeParse('a').success && rigVariantSchema.safeParse('c').success).toBe(true)
    expect([...RIG_PATHS]).toEqual(['claude-svg', 'raster'])
  })
})
