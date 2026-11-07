import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InpaintFn } from '../src/engine/images/face'
import { buildRasterRig } from '../src/engine/pipeline/rig'
import type { RasterAnswer } from '../src/engine/pipeline/rig'
import { SeriesStore } from '../src/engine/series/service'
import { MOUTH_SHAPES, rigSchema } from '../src/shared/contracts'
import { installMini } from './fixtures/mini'

/**
 * CTS-13: a raster rig from a master picture, with NO variant `a` (cast `pip` has no SVG rig at all) and a fake inpaint (no live ComfyUI): the rig
 * passes the rig check, the 8 mouth keys resolve to PNG plates, and the rest patch covers the designer's mouth box.
 */

let dir: string
let store: SeriesStore
const W = 1024
const H = 1536
const MOUTH = [440, 420, 140, 80] as const
const EYES = [400, 300, 220, 70] as const
const BROWS = [400, 240, 220, 50] as const

const answer: RasterAnswer = {
  height: 1300,
  facing: 'right',
  parts: [
    { id: 'body', parent: null, polygon: [[380, 700], [650, 700], [650, 1400], [380, 1400]], pivot: [515, 1400], z: 10 },
    { id: 'head', parent: 'body', polygon: [[340, 180], [690, 180], [690, 700], [340, 700]], pivot: [515, 690], z: 20 },
    { id: 'arm_r', parent: 'body', polygon: [[650, 720], [820, 720], [820, 1000], [650, 1000]], pivot: [670, 740], z: 25 },
    { id: 'arm_l', parent: 'body', polygon: [[210, 720], [380, 720], [380, 1000], [210, 1000]], pivot: [360, 740], z: 5 }
  ],
  face: { mouth: [...MOUTH], eyes: [...EYES], brows: [...BROWS] },
  overlap: 6,
  notes: ''
}

/** A grey master with a coloured figure, a dark painted mouth in the mouth box. */
async function master(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#808080"/>
    <rect x="380" y="700" width="270" height="700" fill="#d9822b"/><rect x="340" y="180" width="350" height="520" fill="#e8a64c"/>
    <rect x="650" y="720" width="170" height="280" fill="#d9822b"/><rect x="210" y="720" width="170" height="280" fill="#d9822b"/>
    <rect x="480" y="445" width="60" height="12" fill="#401010"/></svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

/** Paints the middle of the mask's box blue; it stands in for Z-Image (the border keeps the master's colours). */
const fakeInpaint: InpaintFn = async (o) => {
  const m = await sharp(o.mask).greyscale().raw().toBuffer({ resolveWithObject: true })
  const img = await sharp(o.image).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const w = m.info.width
  let x0 = w, y0 = m.info.height, x1 = 0, y1 = 0
  for (let i = 0; i < m.data.length; i++) {
    if (m.data[i]! <= 128) continue
    const x = i % w, y = Math.floor(i / w)
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }
  const qx = (x1 - x0) / 4, qy = (y1 - y0) / 4
  for (let y = Math.round(y0 + qy); y < y1 - qy; y++) {
    for (let x = Math.round(x0 + qx); x < x1 - qx; x++) {
      const i = y * w + x
      img.data[i * 3] = 20; img.data[i * 3 + 1] = 60; img.data[i * 3 + 2] = 200
    }
  }
  const file = `${o.out}.png`
  await sharp(img.data, { raw: { width: img.info.width, height: img.info.height, channels: 3 } }).png().toFile(file)
  return { file, seconds: 0.1 }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cts-rig-raster-'))
  await installMini(dir)
  store = new SeriesStore(dir)
  await store.writeFile('mini', 'ref.png', await master(), store.paths('mini').castDir('pip'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

describe('raster rig with image face patches', () => {
  it('builds a rig that passes the rig check without variant a; 8 mouth keys are PNG plates; the rest patch covers the mouth box', async () => {
    const res = await buildRasterRig({ store, series: 'mini', cast: 'pip', answer, prompt: 'Pip the squirrel', seed: 7, inpaint: fakeInpaint })
    expect(res.check.issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(res.check.ok).toBe(true)
    expect(res.face.every((r) => r.ok)).toBe(true)
    const p = store.paths('mini')
    await expect(stat(path.join(p.castDir('pip'), 'variants', 'a'))).rejects.toThrow()

    const rig = rigSchema.parse(JSON.parse(await readFile(p.rigFile('pip', 'c'), 'utf8')))
    expect(rig.kind).toBe('raster')
    const rigDir = p.rigDir('pip', 'c')
    for (const shape of MOUTH_SHAPES) {
      const rel = rig.face.mouth.shapes[shape]
      expect(rel, shape).toMatch(/\.png$/)
      const meta = await sharp(path.join(rigDir, rel!)).metadata()
      expect([meta.format, meta.hasAlpha]).toEqual(['png', true])
    }
    expect(rig.face.mouth.shapes.U).toBe(rig.face.mouth.shapes.O)
    expect(rig.face.mouth.shapes.FV).toBe(rig.face.mouth.shapes.E)
    expect(rig.face.mouth.shapes.L).toBe(rig.face.mouth.shapes.E)
    expect(rig.face.mouth.shapes.A).not.toBe(rig.face.mouth.shapes.rest)

    // rest = the master's own mouth box: same size, opaque inside, soft at the edge, the painted mouth in the middle
    const rest = sharp(path.join(rigDir, rig.face.mouth.shapes.rest!))
    expect(await rest.metadata()).toMatchObject({ width: MOUTH[2], height: MOUTH[3] })
    const { data, info } = await rest.raw().toBuffer({ resolveWithObject: true })
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * 4 + 3]!
    expect(alphaAt(70, 40)).toBe(255)
    expect(alphaAt(0, 0)).toBeLessThan(80)
    const px = (x: number, y: number) => [data[(y * info.width + x) * 4], data[(y * info.width + x) * 4 + 1], data[(y * info.width + x) * 4 + 2]]
    expect(px(60, 30)).toEqual([0x40, 0x10, 0x10])
    // the plate is placed at the box centre, in head-part pixels
    const head = rig.parts.find((q) => q.id === 'head')!
    const headOrigin = [answer.parts[1]!.pivot[0] - head.pivot[0], answer.parts[1]!.pivot[1] - head.pivot[1]]
    expect([rig.face.mouth.at[0] + headOrigin[0]!, rig.face.mouth.at[1] + headOrigin[1]!]).toEqual([MOUTH[0] + MOUTH[2] / 2, MOUTH[1] + MOUTH[3] / 2])
    // an open mouth is a different picture of the same box
    const a = await sharp(path.join(rigDir, rig.face.mouth.shapes.A!)).metadata()
    expect([a.width, a.height]).toEqual([MOUTH[2], MOUTH[3]])
  })
})
