import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import type { OverlayOptions } from 'sharp'
import { z } from 'zod'
import { rigSchema, rigVariantSchema } from '../../shared/contracts'
import type { Rig, RigVariant } from '../../shared/contracts'
import { BROWS_MADE, EYES_MADE, MOUTH_ALIAS, MOUTH_MADE, boxCentre, makeFacePatches } from '../images/face'
import type { Box, FacePatchOptions, InpaintFn, PatchReport } from '../images/face'
import { keyOut } from '../images/key'
import { checkRig } from '../series/lint'
import type { RigCheck } from '../series/lint'
import { SeriesStore, zodIssues } from '../series/service'
import { poseSheet, rigSheetName, RIG_SHEET } from '../render/sheet'
import type { z as zt } from 'zod'
import type { rigRasterAnswer } from './tasks'

/**
 * Rig building (CTS-07, step 3). Two paths make one rig format: `claude-svg` (variant `a`: the character-designer draws the part SVGs; optional) and `raster` (variant `c`: the master is keyed and cut into PNG parts by the designer's polygons, the face is PNG patches made by inpaint; needs no other variant).
 * Each variant lives under `cast/<id>/variants/<v>/`; `chooseVariant` copies the chosen one up to `cast/<id>/`. `variants.json` keeps each path's
 * wall time and spend for the studio and the run log.
 */

export const RIG_PATHS = ['claude-svg', 'raster'] as const
export type RigPath = (typeof RIG_PATHS)[number]
export const VARIANT_OF: Record<RigPath, RigVariant> = { 'claude-svg': 'a', raster: 'c' }
/** The pilot's time box per path (HUB-29 decision 1). */
export const TIME_BOX_MIN = 45

const variantRecord = z.strictObject({
  path: z.enum(RIG_PATHS),
  status: z.enum(['built', 'failed', 'not-run']),
  startedAt: z.string(),
  endedAt: z.string(),
  wallSeconds: z.number().nonnegative(),
  spendUsd: z.number().nonnegative(),
  spendCredits: z.number().nonnegative().default(0),
  note: z.string()
})
export const variantsFileSchema = z.strictObject({ schema: z.literal('cts.variants/1'), chosen: rigVariantSchema.nullable(), variants: z.partialRecord(rigVariantSchema, variantRecord) })
export type VariantsFile = z.infer<typeof variantsFileSchema>
export type VariantRecord = z.infer<typeof variantRecord>

export const variantsFile = (store: SeriesStore, series: string, cast: string): string => path.join(store.paths(series).castDir(cast), 'variants', 'variants.json')

export async function readVariants(store: SeriesStore, series: string, cast: string): Promise<VariantsFile> {
  const f = variantsFile(store, series, cast)
  if (!(await store.exists(f))) return { schema: 'cts.variants/1', chosen: null, variants: {} }
  return store.readJson(f, variantsFileSchema)
}

export async function recordVariant(store: SeriesStore, series: string, cast: string, variant: RigVariant, rec: VariantRecord): Promise<VariantsFile> {
  const cur = await readVariants(store, series, cast)
  cur.variants[variant] = rec
  return store.writeJson(variantsFile(store, series, cast), variantsFileSchema, cur)
}

// ---- cts_rig_set ----

const partKey = (rel: string): string[] => [rel, path.posix.basename(rel), path.posix.basename(rel).replace(/\.[a-z]+$/i, '')]

/** Every file a rig names: the parts and the face states, relative to the rig folder. */
export function rigFiles(rig: Rig): string[] {
  const out = rig.parts.map((p) => p.src)
  for (const plate of [rig.face.eyes.states, rig.face.brows.states, rig.face.mouth.shapes]) for (const f of Object.values(plate)) if (f) out.push(f)
  return [...new Set(out)]
}

export interface RigSetResult {
  written: string[]
  check: RigCheck
}

/**
 * Validates a rig and writes it with its part SVGs under `cast/<id>/` (or `variants/<v>/`). `parts` maps a file (its path in the rig, its file name or
 * its name without extension) to the SVG text; a file the rig names that is not in `parts` must already be on disk. Nothing is written when the rig
 * does not parse or a file is missing. The result carries the `cts_rig_check` report.
 */
export async function writeRigSet(store: SeriesStore, series: string, cast: string, variant: RigVariant | undefined, rigInput: unknown, parts: Record<string, string> = {}): Promise<RigSetResult> {
  const p = store.paths(series)
  const parsed = rigSchema.safeParse(rigInput)
  if (!parsed.success) throw new Error(`rig.json does not match its schema: ${zodIssues(parsed.error).slice(0, 8).join('; ')}`)
  const rig = parsed.data
  if (rig.id !== cast) throw new Error(`rig.id "${rig.id}" is not the cast id "${cast}"`)
  const dir = p.rigDir(cast, variant)
  const text = new Map<string, string>()
  const missing: string[] = []
  for (const rel of rigFiles(rig)) {
    const key = partKey(rel).find((k) => parts[k] !== undefined)
    if (key !== undefined) {
      if (!/\.svg$/i.test(rel)) throw new Error(`${rel}: only SVG text can be given in parts (a PNG part is written by the raster path)`)
      text.set(rel, parts[key]!)
    } else if (!(await store.exists(p.resolve(rel, dir)))) missing.push(rel)
  }
  if (missing.length) throw new Error(`the rig names ${missing.length} file(s) that were not given and are not on disk: ${missing.slice(0, 12).join(', ')}`)
  const written: string[] = []
  for (const [rel, svg] of text) {
    await store.writeFile(series, rel, svg, dir)
    written.push(rel)
  }
  await store.writeRig(series, cast, rig, variant)
  return { written, check: await checkRig(store, series, cast, variant) }
}

// ---- motion defaults (a raster rig without a variant `a` to copy from) ----

export function defaultMotion(partIds: string[]): Pick<Rig, 'emotions' | 'gestures' | 'move'> {
  const arm = (side: string): string | undefined => partIds.find((i) => i === `arm_${side}`)
  const gestures: Rig['gestures'] = {}
  const r = arm('r')
  const l = arm('l')
  if (r) {
    gestures.wave = { part: r, seconds: 1, keys: [[0, -10], [0.25, -150], [0.5, -120], [0.75, -150], [1, -10]] }
    gestures.point = { part: r, seconds: 0.8, keys: [[0, -10], [0.3, -85], [1, -85]] }
  }
  if (l) gestures.shrug = { part: l, seconds: 0.8, keys: [[0, -10], [0.4, -40], [1, -10]] }
  return {
    emotions: { neutral: { brows: 'neutral', eyes: 'open' }, happy: { brows: 'happy', eyes: 'open' }, sad: { brows: 'sad', eyes: 'half' }, surprised: { brows: 'surprised', eyes: 'open' } },
    gestures,
    move: { bobPx: 8, stepSeconds: 0.33 }
  }
}

// ---- raster assembly ----

export type RasterAnswer = zt.infer<typeof rigRasterAnswer>

interface PartGeometry {
  id: string
  /** Where the part image's top-left sits in the source picture. */
  origin: [number, number]
  /** The part image size. */
  size: [number, number]
}

const mouthFile = (s: string): string => `parts/face-mouth-${s}.png`
const eyesFile = (s: string): string => `parts/face-eyes-${s}.png`
const browsFile = (s: string): string => `parts/face-brows-${s}.png`

/** Builds rig.json for polygon-cut parts. Pivots and `at` come from the source picture's coordinates and each part's origin; the face plates are PNG patches. */
function assembleRig(cast: string, answer: RasterAnswer, geo: Map<string, PartGeometry>, motionFrom: Rig | null): Rig {
  const byId = new Map(answer.parts.map((p) => [p.id, p]))
  const head = answer.parts.find((p) => p.id === (motionFrom?.face.parent ?? 'head')) ?? answer.parts.find((p) => p.id === 'head')
  if (!head) throw new Error('the answer has no "head" part for the face')
  const parts = answer.parts.map((p) => {
    const g = geo.get(p.id)!
    const parent = p.parent ? byId.get(p.parent) : null
    if (p.parent && !parent) throw new Error(`part ${p.id}: unknown parent "${p.parent}"`)
    const pg = parent ? geo.get(parent.id)! : null
    return {
      id: p.id,
      src: `parts/${p.id}.png`,
      parent: p.parent,
      pivot: [Math.round(p.pivot[0] - g.origin[0]), Math.round(p.pivot[1] - g.origin[1])] as [number, number],
      at: pg ? ([Math.round(p.pivot[0] - pg.origin[0]), Math.round(p.pivot[1] - pg.origin[1])] as [number, number]) : ([0, 0] as [number, number]),
      z: p.z,
      ...(p.rot ? { rot: p.rot } : {})
    }
  })
  const hg = geo.get(head.id)!
  /** The centre of a box in head-part pixels. */
  const at = (box: Box): [number, number] => {
    const c = boxCentre(box)
    return [c[0] - hg.origin[0], c[1] - hg.origin[1]]
  }
  const fz = head.z
  const motion = motionFrom ?? ({ ...defaultMotion(parts.map((p) => p.id)), drawnFacing: answer.facing } as Pick<Rig, 'emotions' | 'gestures' | 'move'>)
  const ids = new Set(parts.map((p) => p.id))
  const gestures = Object.fromEntries(Object.entries(motion.gestures).filter(([, g]) => ids.has(g.part)))
  const mouthShapes: Record<string, string> = Object.fromEntries(MOUTH_MADE.map((s) => [s, mouthFile(s)]))
  for (const [alias, target] of Object.entries(MOUTH_ALIAS)) mouthShapes[alias] = mouthFile(target)
  return {
    schema: 'cts.rig/1',
    id: cast,
    kind: 'raster',
    drawnFacing: answer.facing,
    height: answer.height,
    parts,
    face: {
      parent: head.id,
      eyes: { at: at(answer.face.eyes), z: fz + 10, states: Object.fromEntries(EYES_MADE.map((s) => [s, eyesFile(s)])) },
      brows: { at: at(answer.face.brows), z: fz + 11, states: Object.fromEntries(BROWS_MADE.map((s) => [s, browsFile(s)])) },
      mouth: { at: at(answer.face.mouth), z: fz + 12, shapes: mouthShapes }
    },
    emotions: motion.emotions,
    gestures,
    move: motion.move
  } as Rig
}

/** A rig whose motion (emotions, gestures, move) a raster rig may reuse: variant `a`, else the chosen top-level rig; null when there is none (defaults then). */
export async function motionSource(store: SeriesStore, series: string, cast: string): Promise<Rig | null> {
  for (const v of ['a', undefined] as const) {
    try {
      return await store.readRig(series, cast, v)
    } catch {
      /* try the next */
    }
  }
  return null
}

export interface RasterRigOptions {
  store: SeriesStore
  series: string
  cast: string
  answer: RasterAnswer
  /** The character prompt the master was made with (the face inpaints repeat it). */
  prompt: string
  seed: number
  /** The masked inpaint (Z-Image through ComfyUI in the pipeline, a fake in tests). */
  inpaint: InpaintFn
  /** Keep the inpaint results under `variants/c/face-src/` (default: delete them, the report stays). */
  keepWork?: boolean
  attempts?: FacePatchOptions['attempts']
  log?: (m: string) => void
  signal?: AbortSignal
}

/**
 * Path `raster` (variant `c`): key the master `cast/<id>/ref.png` (the Z-Image halo goes with the grey), cut the parts with the designer's polygons plus an
 * overlap at the joints, and build the face from PNG patches (`images/face.ts`). No other variant is needed; the motion of variant `a` or of an existing
 * rig is reused when there is one, else the defaults.
 */
export async function buildRasterRig(o: RasterRigOptions): Promise<RigSetResult & { face: PatchReport[] }> {
  const { store, series, cast, answer } = o
  const p = store.paths(series)
  const dir = p.rigDir(cast, 'c')
  const motion = await motionSource(store, series, cast)
  const master = path.join(p.castDir(cast), 'ref.png')
  const ref = await fs.readFile(master)
  const keyed = await keyOut(ref)
  await store.writeFile(series, 'keyed.png', keyed, dir)
  const meta = await sharp(keyed).metadata()
  const W = meta.width ?? 1024
  const H = meta.height ?? 1536
  const geo = new Map<string, PartGeometry>()
  for (const part of answer.parts) {
    const xs = part.polygon.map((q) => q[0])
    const ys = part.polygon.map((q) => q[1])
    const pad = Math.ceil(answer.overlap)
    const x0 = Math.max(0, Math.floor(Math.min(...xs)) - pad)
    const y0 = Math.max(0, Math.floor(Math.min(...ys)) - pad)
    const x1 = Math.min(W, Math.ceil(Math.max(...xs)) + pad)
    const y1 = Math.min(H, Math.ceil(Math.max(...ys)) + pad)
    const w = x1 - x0
    const h = y1 - y0
    if (w < 2 || h < 2) throw new Error(`part ${part.id}: its polygon is outside the picture (${W}x${H})`)
    const pts = part.polygon.map((q) => `${q[0] - x0},${q[1] - y0}`).join(' ')
    const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><polygon points="${pts}" fill="#fff" stroke="#fff" stroke-width="${Math.max(1, answer.overlap * 2)}" stroke-linejoin="round"/></svg>`)
    const png = await sharp(keyed).extract({ left: x0, top: y0, width: w, height: h }).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer()
    await store.writeFile(series, `parts/${part.id}.png`, png, dir)
    geo.set(part.id, { id: part.id, origin: [x0, y0], size: [w, h] })
  }
  const rig = assembleRig(cast, answer, geo, motion)
  // the face: patches of the master's own face, redrawn by masked inpaint per state
  const workDir = path.join(dir, 'face-src')
  const patches = await makeFacePatches({ master, boxes: answer.face, prompt: o.prompt, seed: o.seed, inpaint: o.inpaint, workDir, ...(o.log ? { log: o.log } : {}), ...(o.signal ? { signal: o.signal } : {}), ...(o.attempts ? { attempts: o.attempts } : {}) })
  for (const [s, png] of Object.entries(patches.mouth)) await store.writeFile(series, mouthFile(s), png, dir)
  for (const [s, png] of Object.entries(patches.eyes)) await store.writeFile(series, eyesFile(s), png, dir)
  for (const [s, png] of Object.entries(patches.brows)) await store.writeFile(series, browsFile(s), png, dir)
  await store.writeFile(series, 'face-report.json', `${JSON.stringify({ prompt: o.prompt, seed: o.seed, boxes: answer.face, patches: patches.report }, null, 2)}\n`, dir)
  if (!o.keepWork) await fs.rm(workDir, { recursive: true, force: true })
  await store.writeRig(series, cast, rig, 'c')
  return { written: answer.parts.map((q) => `parts/${q.id}.png`), check: await checkRig(store, series, cast, 'c'), face: patches.report }
}

// ---- choose and compare ----

/** Copies the chosen variant up to `cast/<id>/`: rig.json, parts/ and rig-sheet.png. The top-level rig must pass `cts_rig_check`. */
export async function chooseVariant(store: SeriesStore, series: string, cast: string, variant: RigVariant): Promise<RigCheck> {
  const p = store.paths(series)
  const from = p.rigDir(cast, variant)
  const to = p.castDir(cast)
  if (!(await store.exists(p.rigFile(cast, variant)))) throw new Error(`variant ${variant} of ${cast} has no rig.json (cast/${cast}/variants/${variant}/)`)
  await fs.rm(path.join(to, 'parts'), { recursive: true, force: true })
  await fs.cp(path.join(from, 'parts'), path.join(to, 'parts'), { recursive: true })
  await fs.copyFile(path.join(from, 'rig.json'), path.join(to, 'rig.json'))
  // never `sheet.png`: that is the character sheet the user approved. Variants made before pilot 2 kept their pose sheet under that name.
  const rs = await rigSheetName(from, to)
  if (rs) await fs.copyFile(path.join(from, rs), path.join(to, RIG_SHEET))
  const cur = await readVariants(store, series, cast)
  await store.writeJson(variantsFile(store, series, cast), variantsFileSchema, { ...cur, chosen: variant })
  return checkRig(store, series, cast)
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

/**
 * One sheet with the pose sheets of the built variants side by side (neutral, every emotion, the gesture peaks, the 8 mouths and 3 eye states),
 * each under a label with its path, time and spend. Written to `cast/<id>/variants/compare.png`.
 */
export async function compareVariants(o: { dataDir: string; store: SeriesStore; series: string; cast: string; playerDir?: string }): Promise<{ file: string; variants: string[]; missing: string[] }> {
  const { store, series, cast } = o
  const rec = await readVariants(store, series, cast)
  const cols: { label: string; sub: string; img: Buffer }[] = []
  const missing: string[] = []
  for (const v of ['a', 'c'] as const) {
    const r = rec.variants[v]
    if (!r || r.status !== 'built') {
      missing.push(`${v}: ${r ? `${r.status}${r.note ? ` (${r.note})` : ''}` : 'not built'}`)
      continue
    }
    const sheet = await poseSheet({ dataDir: o.dataDir, series, cast, variant: v, ...(o.playerDir ? { playerDir: o.playerDir } : {}) })
    cols.push({ label: `(${v}) ${r.path}`, sub: `${Math.round(r.wallSeconds / 60 * 10) / 10} min, $${r.spendUsd}`, img: await sharp(sheet).flatten({ background: '#ffffff' }).resize({ height: 1000 }).png().toBuffer() })
  }
  if (cols.length === 0) throw new Error(`no built variant of ${cast} to compare (${missing.join('; ')})`)
  const sizes = await Promise.all(cols.map((c) => sharp(c.img).metadata()))
  const widths = sizes.map((s) => s.width ?? 600)
  const head = 70
  const total = widths.reduce((a, b) => a + b, 0) + 12 * (cols.length - 1)
  let x = 0
  const layers: OverlayOptions[] = []
  for (const [i, c] of cols.entries()) {
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${widths[i]}" height="${head}"><rect width="100%" height="100%" fill="#222"/><text x="14" y="30" font-family="sans-serif" font-size="26" fill="#fff">${esc(c.label)}</text><text x="14" y="58" font-family="sans-serif" font-size="20" fill="#bbb">${esc(c.sub)}</text></svg>`)
    layers.push({ input: label, left: x, top: 0 }, { input: c.img, left: x, top: head })
    x += (widths[i] ?? 600) + 12
  }
  const file = path.join(store.paths(series).castDir(cast), 'variants', 'compare.png')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await sharp({ create: { width: total, height: head + 1000, channels: 3, background: '#444' } }).composite(layers).png().toFile(file)
  return { file, variants: cols.map((c) => c.label), missing }
}
