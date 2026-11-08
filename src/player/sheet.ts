// Pose sheet: one rig in neutral, every emotion, every gesture at its peak, all 8 mouths and the 3 eye states, in a labelled grid.
// Pure drawing of a loaded rig; deterministic. Opened with `?sheet=<castId>&series=<slug>[&variant=a|c]`.
import { EYE_STATES, MOUTH_SHAPES } from '../shared/contracts'
import type { RigAssets } from './assets'
import { drawActor, drawList, emotionFace, partCenter, partMatrices, type Pose } from './puppet'

const COLS = 6
const CELL_W = 260
const CELL_H = 340
const HEAD = 56
const LABEL = 36

interface Cell {
  label: string
  pose: Pose
  /** Close-up on the head (face states are small at full-body scale). */
  face: boolean
}

function basePose(a: RigAssets): Pose {
  const f = emotionFace(a, 'neutral')
  return { x: 0, y: 0, facing: a.rig.drawnFacing, bobPx: 0, rot: {}, brows: f.brows, eyes: f.eyes, mouth: 'rest' }
}

/** The key of a gesture furthest from its first key's angle: `[fraction, degrees]`. */
export function gesturePeak(g: { keys: readonly (readonly [number, number])[] }): readonly [number, number] {
  const rest = g.keys[0]?.[1] ?? 0
  let peak = g.keys[0]
  for (const k of g.keys) if (Math.abs(k[1] - rest) > Math.abs((peak?.[1] ?? 0) - rest)) peak = k
  return peak ?? [0, 0]
}

export function sheetCells(a: RigAssets): Cell[] {
  const cells: Cell[] = []
  const base = basePose(a)
  cells.push({ label: 'neutral', pose: base, face: false })
  for (const name of Object.keys(a.rig.emotions)) {
    const f = emotionFace(a, name)
    cells.push({ label: `emotion: ${name}`, pose: { ...base, brows: f.brows, eyes: f.eyes }, face: false })
  }
  for (const [name, g] of Object.entries(a.rig.gestures)) {
    const peak = gesturePeak(g)
    cells.push({
      label: `gesture: ${name} @${peak[0]}`,
      pose: { ...base, rot: { [g.part]: peak[1] } },
      face: false
    })
  }
  for (const name of Object.keys(a.rig.poses ?? {})) cells.push({ label: `pose image: ${name}`, pose: { ...base, poseImage: name }, face: false })
  for (const m of MOUTH_SHAPES) cells.push({ label: `mouth: ${m}`, pose: { ...base, mouth: m }, face: true })
  for (const e of EYE_STATES) cells.push({ label: `eyes: ${e}`, pose: { ...base, eyes: e }, face: true })
  return cells
}

/** The canvas size the sheet needs. */
export function sheetSize(a: RigAssets): { width: number; height: number } {
  const rows = Math.ceil(sheetCells(a).length / COLS)
  return { width: COLS * CELL_W, height: HEAD + rows * CELL_H }
}

export function drawSheet(ctx: CanvasRenderingContext2D, a: RigAssets, title: string): void {
  const { width, height } = sheetSize(a)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = '#eceae4'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#222222'
  ctx.font = '600 28px sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillText(title, 16, HEAD / 2)

  const cells = sheetCells(a)
  cells.forEach((cell, n) => {
    const cx = (n % COLS) * CELL_W
    const cy = HEAD + Math.floor(n / COLS) * CELL_H
    ctx.save()
    ctx.beginPath()
    ctx.rect(cx, cy, CELL_W, CELL_H)
    ctx.clip()
    ctx.fillStyle = '#fbfaf7'
    ctx.fillRect(cx + 2, cy + 2, CELL_W - 4, CELL_H - 4)
    ctx.strokeStyle = '#b8b4a8'
    ctx.strokeRect(cx + 1, cy + 1, CELL_W - 2, CELL_H - 2)

    const avail = CELL_H - LABEL - 24
    let pose: Pose
    let k: number
    if (cell.face) {
      const head = a.parts.get(a.rig.face.parent)
      k = head ? Math.min((CELL_W - 30) / head.w, avail / head.h) : 1
      const c = partCenter(a, { ...cell.pose, x: 0, y: 0 }, k, a.rig.face.parent) ?? { x: 0, y: 0 }
      pose = { ...cell.pose, x: cx + CELL_W / 2 - c.x, y: cy + 12 + avail / 2 - c.y }
    } else {
      k = avail / a.rig.height
      pose = { ...cell.pose, x: cx + CELL_W / 2, y: cy + 12 + avail }
    }
    drawActor(ctx, a, pose, k)
    ctx.fillStyle = '#222222'
    ctx.font = '600 20px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(cell.label, cx + CELL_W / 2, cy + CELL_H - LABEL / 2)
    ctx.textAlign = 'start'
    ctx.restore()
  })
  ctx.textBaseline = 'alphabetic'
}

/** The picture a pose image is made from (CTS-14): the rig at a gesture's peak on flat grey, fitted into this canvas. */
export const POSE_CANVAS = { width: 1024, height: 1536 } as const
const POSE_GREY = '#808080'

export interface PoseInfo {
  gesture: string
  /** Canvas pixels per rig pixel (1, or less when the pose does not fit). */
  k: number
  /** The feet point in the canvas. */
  pivot: [number, number]
  /** The head part's image top-left in the canvas. */
  head: [number, number]
}

/** Draws the rig at the peak of `gesture`, neutral face, centred on the canvas; returns where the feet and the head are. */
export function drawPoseRender(ctx: CanvasRenderingContext2D, a: RigAssets, gesture: string): PoseInfo {
  const g = a.rig.gestures[gesture]
  if (!g) throw new Error(`the rig of ${a.rig.id} has no gesture "${gesture}" (${Object.keys(a.rig.gestures).join(', ')})`)
  const pose: Pose = { ...basePose(a), rot: { [g.part]: gesturePeak(g)[1] }, poseImage: null }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const it of drawList(a, pose, 1)) {
    for (const [px, py] of [[0, 0], [it.sprite.w, 0], [0, it.sprite.h], [it.sprite.w, it.sprite.h]] as const) {
      const p = it.matrix.transformPoint(new DOMPoint(px, py))
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y)
    }
  }
  const { width: W, height: H } = POSE_CANVAS
  const k = Math.min(1, (W - 80) / (x1 - x0), (H - 80) / (y1 - y0))
  const at = { x: W / 2 - ((x0 + x1) / 2) * k, y: H / 2 - ((y0 + y1) / 2) * k }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = POSE_GREY
  ctx.fillRect(0, 0, W, H)
  const placed: Pose = { ...pose, ...at }
  drawActor(ctx, a, placed, k)
  const head = partMatrices(a, placed, k).get(a.rig.face.parent)?.transformPoint(new DOMPoint(0, 0))
  return { gesture, k, pivot: [at.x, at.y], head: head ? [head.x, head.y] : [at.x, at.y] }
}
