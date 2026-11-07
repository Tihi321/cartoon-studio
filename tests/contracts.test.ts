import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { lintSeries } from '../src/engine/series/lint'
import { SeriesStore } from '../src/engine/series/service'
import { installMini } from './fixtures/mini'

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
})
