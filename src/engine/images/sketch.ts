import sharp from 'sharp'
import { z } from 'zod'

/**
 * Rough sketches made by the app (CTS-12). The character-designer answers a BODY PLAN: flat coloured primitives on a 1024x1536 canvas, each tied to a
 * `limb`, and a joint point per limb. `renderSketch` draws it over `#808080` (sharp, through an SVG string) and `poseSketch` rotates the primitives of each
 * limb about its joint first. The sketch is a throwaway guide for Z-Image image-to-image (denoise about 0.8 keeps the silhouette, so the silhouette must
 * be clean); it is never a rig part and no SVG is hand-drawn for the rig.
 *
 * Angles are degrees, positive = clockwise on the screen (y points down). A limb with a `parent` also moves with its parent (an elbow: the forearm
 * has the upper arm as its parent and the elbow as its joint). Primitives are drawn in the order of `shapes`.
 */

export const SKETCH_SIZE = { width: 1024, height: 1536 } as const
export const SKETCH_BACKGROUND = '#808080'
/** The pose sketches every character gets besides the front view (the gesture peaks of the rig). */
export const SHEET_POSES = ['wave', 'point', 'shrug'] as const
export type SheetPose = (typeof SHEET_POSES)[number]

const num = z.number().finite()
const pt = z.tuple([num, num])
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour is #rrggbb')
const limbId = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'a limb id is lower case letters, digits, - or _')

const shapeBase = { limb: limbId, fill: hex }

export const sketchShapeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ellipse'), ...shapeBase, c: pt, rx: num.positive(), ry: num.positive(), rot: num.optional() }),
  z.strictObject({ kind: z.literal('circle'), ...shapeBase, c: pt, r: num.positive() }),
  z.strictObject({ kind: z.literal('capsule'), ...shapeBase, a: pt, b: pt, r: num.positive() }),
  z.strictObject({ kind: z.literal('polygon'), ...shapeBase, points: z.array(pt).min(3) })
])
export type SketchShape = z.infer<typeof sketchShapeSchema>

export const bodyPlanSchema = z.strictObject({
  limbs: z.array(z.strictObject({ id: limbId, joint: pt, parent: limbId.nullable().optional() })).min(1),
  shapes: z.array(sketchShapeSchema).min(4),
  /** Degrees per limb for the pose sketches; `wave`, `point` and `shrug` are required. */
  poses: z.record(z.string(), z.record(limbId, num))
})
export type BodyPlan = z.infer<typeof bodyPlanSchema>
export type Pose = Record<string, number>

/** Everything the schema cannot say: unknown limbs, parent loops, the three poses, colours outside the palette, a figure that does not fit or fill the canvas. */
export function bodyPlanProblems(plan: BodyPlan, palette: string[] = []): string[] {
  const out: string[] = []
  const ids = new Set(plan.limbs.map((l) => l.id))
  if (ids.size !== plan.limbs.length) out.push('limb ids must differ')
  for (const l of plan.limbs) {
    if (l.parent && !ids.has(l.parent)) out.push(`limb ${l.id}: parent "${l.parent}" is not a limb`)
    const seen = new Set<string>()
    for (let p: string | null | undefined = l.id; p; p = plan.limbs.find((x) => x.id === p)?.parent) {
      if (seen.has(p)) {
        out.push(`limb ${l.id}: the parents loop`)
        break
      }
      seen.add(p)
    }
  }
  for (const [i, s] of plan.shapes.entries()) if (!ids.has(s.limb)) out.push(`shapes[${i}].limb "${s.limb}" is not a limb`)
  for (const name of SHEET_POSES) {
    const pose = plan.poses[name]
    if (!pose) out.push(`poses.${name} is missing (degrees per limb for the ${name} sketch)`)
    else for (const k of Object.keys(pose)) if (!ids.has(k)) out.push(`poses.${name}: "${k}" is not a limb`)
  }
  if (palette.length) {
    const allowed = new Set(palette.map((c) => c.toLowerCase()))
    const bad = [...new Set(plan.shapes.map((s) => s.fill.toLowerCase()).filter((c) => !allowed.has(c)))]
    if (bad.length) out.push(`colours ${bad.join(', ')} are not in the series palette (${palette.join(', ')}); use palette colours only`)
  }
  if (plan.shapes.some((s) => s.fill.toLowerCase() === SKETCH_BACKGROUND)) out.push(`no shape may be ${SKETCH_BACKGROUND} (the background grey)`)
  return out
}

function chain(plan: BodyPlan, limb: string, pose: Pose): string {
  // the own rotation applies first, then the parent's: SVG lists transforms outermost first
  const parts: string[] = []
  const seen = new Set<string>()
  for (let id: string | null | undefined = limb; id && !seen.has(id); id = plan.limbs.find((l) => l.id === id)?.parent) {
    seen.add(id)
    const l = plan.limbs.find((x) => x.id === id)
    const a = pose[id] ?? 0
    if (l && a !== 0) parts.push(`rotate(${a} ${l.joint[0]} ${l.joint[1]})`)
  }
  return parts.reverse().join(' ')
}

const f = (n: number): string => String(Math.round(n * 100) / 100)

function shapeSvg(s: SketchShape): string {
  switch (s.kind) {
    case 'ellipse':
      return `<ellipse cx="${f(s.c[0])}" cy="${f(s.c[1])}" rx="${f(s.rx)}" ry="${f(s.ry)}" fill="${s.fill}"${s.rot ? ` transform="rotate(${s.rot} ${f(s.c[0])} ${f(s.c[1])})"` : ''}/>`
    case 'circle':
      return `<circle cx="${f(s.c[0])}" cy="${f(s.c[1])}" r="${f(s.r)}" fill="${s.fill}"/>`
    case 'capsule':
      return `<line x1="${f(s.a[0])}" y1="${f(s.a[1])}" x2="${f(s.b[0])}" y2="${f(s.b[1])}" stroke="${s.fill}" stroke-width="${f(s.r * 2)}" stroke-linecap="round"/>`
    case 'polygon':
      return `<polygon points="${s.points.map((p) => `${f(p[0])},${f(p[1])}`).join(' ')}" fill="${s.fill}"/>`
  }
}

/** The SVG text of the sketch (exported for tests and debugging). */
export function sketchSvg(plan: BodyPlan, pose: Pose = {}): string {
  const body = plan.shapes
    .map((s) => {
      const t = chain(plan, s.limb, pose)
      const el = shapeSvg(s)
      return t ? `<g transform="${t}">${el}</g>` : el
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SKETCH_SIZE.width}" height="${SKETCH_SIZE.height}"><rect width="100%" height="100%" fill="${SKETCH_BACKGROUND}"/>${body}</svg>`
}

/** The front sketch: the body plan at rest (no limb rotated), as a 1024x1536 PNG on flat grey. */
export async function renderSketch(plan: BodyPlan, pose: Pose = {}): Promise<Buffer> {
  return sharp(Buffer.from(sketchSvg(plan, pose))).png().toBuffer()
}

/** The sketch with each limb rotated about its joint by `pose[limb]` degrees (a limb not named stays at rest). */
export function poseSketch(plan: BodyPlan, pose: Pose): Promise<Buffer> {
  return renderSketch(plan, pose)
}

/** The box (px) the figure covers, found from the pixels that are not the background grey; null if nothing is drawn. */
export async function figureBox(png: Buffer): Promise<{ left: number; top: number; right: number; bottom: number } | null> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  let left = info.width
  let top = info.height
  let right = -1
  let bottom = -1
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels
      if (Math.abs(data[i]! - 128) + Math.abs(data[i + 1]! - 128) + Math.abs(data[i + 2]! - 128) > 12) {
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
    }
  }
  return right < 0 ? null : { left, top, right, bottom }
}

/** Checks of the rendered front sketch: the figure fits the canvas with a margin and fills most of its height (Z-Image redraws what is there). */
export async function sketchProblems(png: Buffer): Promise<string[]> {
  const box = await figureBox(png)
  if (!box) return ['the sketch draws nothing']
  const out: string[] = []
  const m = 24
  if (box.left < m || box.top < m || box.right > SKETCH_SIZE.width - m || box.bottom > SKETCH_SIZE.height - m) out.push(`the figure (${box.left},${box.top} to ${box.right},${box.bottom}) must stay at least ${m} px inside the ${SKETCH_SIZE.width}x${SKETCH_SIZE.height} canvas`)
  if (box.bottom - box.top < 1000) out.push(`the figure is ${box.bottom - box.top} px tall; it must fill at least 1000 of the ${SKETCH_SIZE.height} px`)
  return out
}
