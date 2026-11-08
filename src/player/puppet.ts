// One actor: the transform stack and the draw order. Pure functions of (assets, pose): no clock, no randomness.
//
// Transform of a part's image (origin = image top-left): root = T(stage x, y - bob) * S(flip * k, k) * T(-pivot);
// child = parentImage * T(at) * R(deg) * T(-pivot), where `at` is where the child's pivot sits in the parent's image coordinates.
// All parts (and the three face plates) are then drawn in global `z` order, not in tree order.
import type { BrowState, EyeState, MouthShape } from '../shared/contracts'
import type { RigAssets, Sprite } from './assets'

export interface Pose {
  /** The root pivot (feet point) in the current coordinate system. */
  x: number
  y: number
  facing: 'left' | 'right'
  /** Upward offset in rig px (already computed from the bob track), before the actor scale. */
  bobPx: number
  /** Degrees per part id. */
  rot: Record<string, number>
  brows: BrowState
  eyes: EyeState
  mouth: MouthShape
  /** A pose image (a key of the rig's `poses`) drawn instead of the parts; absent or null for the parts. */
  poseImage?: string | null
}

export interface DrawItem {
  z: number
  order: number
  sprite: Sprite
  matrix: DOMMatrix
}

/** Resolves an emotion name to its brows/eyes; an emotion the rig does not have falls back to `neutral`. */
export function emotionFace(a: RigAssets, emotion: string): { brows: BrowState; eyes: EyeState } {
  const e = a.rig.emotions[emotion] ?? a.rig.emotions.neutral
  return e ? { brows: e.brows, eyes: e.eyes } : { brows: 'neutral', eyes: 'open' }
}

/** The matrices of every part's image (actor-local to the current coordinate system, scale `k` included). */
export function partMatrices(a: RigAssets, pose: Pose, k: number): Map<string, DOMMatrix> {
  const byId = new Map(a.rig.parts.map((p) => [p.id, p]))
  const out = new Map<string, DOMMatrix>()
  const resolve = (id: string, depth = 0): DOMMatrix | null => {
    const known = out.get(id)
    if (known) return known
    const part = byId.get(id)
    if (!part || depth > 64) return null
    let m: DOMMatrix
    if (part.parent === null) {
      m = rootMatrix(a, pose, k)
    } else {
      const parent = resolve(part.parent, depth + 1)
      if (!parent) return null
      m = parent.translate(part.at[0], part.at[1]).rotate(pose.rot[id] ?? 0)
    }
    m = m.translate(-part.pivot[0], -part.pivot[1])
    out.set(id, m)
    return m
  }
  for (const p of a.rig.parts) resolve(p.id)
  return out
}

/** The root matrix of an actor: the feet point at the stage position, bobbed, flipped when facing the other way, scaled by `k`. */
function rootMatrix(a: RigAssets, pose: Pose, k: number): DOMMatrix {
  const flip = pose.facing === a.rig.drawnFacing ? 1 : -1
  return new DOMMatrix().translate(pose.x, pose.y - pose.bobPx * k).scale(flip * k, k)
}

/** A pose image replaces the parts: the image with its pivot on the feet point, then (if the pose has `face`) the face plates on the head origin `face.at`. */
function poseDrawList(a: RigAssets, pose: Pose, k: number, name: string): DrawItem[] | null {
  const def = a.rig.poses?.[name]
  const sprite = a.poses.get(name)
  if (!def || !sprite) return null
  const root = rootMatrix(a, pose, k)
  const items: DrawItem[] = [{ z: -1e9, order: 0, sprite, matrix: root.translate(-def.pivot[0], -def.pivot[1]) }]
  if (def.face) {
    const head = root.translate(-def.pivot[0] + def.face.at[0], -def.pivot[1] + def.face.at[1]).scale(def.face.scale, def.face.scale)
    const f = a.rig.face
    const plate = (at: readonly [number, number], z: number, s: Sprite | undefined) => {
      if (s) items.push({ z, order: items.length, sprite: s, matrix: head.translate(at[0] - s.w / 2, at[1] - s.h / 2) })
    }
    plate(f.eyes.at, f.eyes.z, a.eyes.get(pose.eyes) ?? a.eyes.get('open'))
    plate(f.brows.at, f.brows.z, a.brows.get(pose.brows) ?? a.brows.get('neutral'))
    plate(f.mouth.at, f.mouth.z, a.mouths.get(pose.mouth) ?? a.mouths.get('rest'))
    items.sort((p, q) => p.z - q.z || p.order - q.order)
  }
  return items
}

export function drawList(a: RigAssets, pose: Pose, k: number): DrawItem[] {
  if (pose.poseImage) {
    const posed = poseDrawList(a, pose, k, pose.poseImage)
    if (posed) return posed
  }
  const mats = partMatrices(a, pose, k)
  const items: DrawItem[] = []
  let order = 0
  for (const p of a.rig.parts) {
    const sprite = a.parts.get(p.id)
    const matrix = mats.get(p.id)
    if (sprite && matrix) items.push({ z: p.z, order: order++, sprite, matrix })
  }
  const head = mats.get(a.rig.face.parent)
  if (head) {
    const f = a.rig.face
    const plate = (at: readonly [number, number], z: number, sprite: Sprite | undefined) => {
      if (!sprite) return
      const matrix = head.translate(at[0] - sprite.w / 2, at[1] - sprite.h / 2)
      items.push({ z, order: order++, sprite, matrix })
    }
    plate(f.eyes.at, f.eyes.z, a.eyes.get(pose.eyes) ?? a.eyes.get('open'))
    plate(f.brows.at, f.brows.z, a.brows.get(pose.brows) ?? a.brows.get('neutral'))
    plate(f.mouth.at, f.mouth.z, a.mouths.get(pose.mouth) ?? a.mouths.get('rest'))
  }
  items.sort((p, q) => p.z - q.z || p.order - q.order)
  return items
}

/** Draws the actor; `ctx`'s current transform (the camera) is the base and is restored afterwards. */
export function drawActor(ctx: CanvasRenderingContext2D, a: RigAssets, pose: Pose, k: number): void {
  const base = ctx.getTransform()
  for (const it of drawList(a, pose, k)) {
    ctx.setTransform(base.multiply(it.matrix))
    ctx.drawImage(it.sprite.bitmap, 0, 0, it.sprite.w, it.sprite.h)
  }
  ctx.setTransform(base)
}

/** The centre of a part's image in the same coordinates as the matrices (used by the pose sheet for face close-ups). */
export function partCenter(a: RigAssets, pose: Pose, k: number, partId: string): { x: number; y: number } | null {
  const m = partMatrices(a, pose, k).get(partId)
  const s = a.parts.get(partId)
  if (!m || !s) return null
  const p = m.transformPoint(new DOMPoint(s.w / 2, s.h / 2))
  return { x: p.x, y: p.y }
}
