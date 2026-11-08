import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { comfyKindSwitch } from '../comfy/kind-switch'
import { pick } from './provider'
import type { ImageContext } from './provider'

/**
 * Face patches for a raster rig (CTS-13). The raster rig has no vector face: the painted face of the master stays on the head part, and every
 * state (a mouth shape, eyes, brows) is a PNG PATCH laid over it. The designer gives one box per feature in the pixels of `ref.png`; for each
 * state the app runs a masked inpaint of the master (only the box, plus a margin, is redrawn; everything else stays identical), crops the box
 * from the result and feathers the edge so the patch blends into the head. The REST/OPEN/NEUTRAL patch is cut from the master itself. The box must
 * enclose the painted feature at its widest (an open mouth, raised brows), so the patch covers the painted one.
 *
 * Only the MOUTHS A, E and O are inpainted (CTS-13 live probe: they read). A closed mouth, half/closed eyes and brows are DRAWN in code (`method:
 * 'drawn'`): an inpaint left the mouth an open smile, turned closed eyes into a wink and painted no brows at all. A drawn state is an SVG overlay on
 * the master's crop (or on a transparent plate for the brows), in colours sampled from the master: the muzzle (the commonest colour in the mouth box),
 * the outline (the darkest pixels of the painted mouth) and the lid (the fur around each eye). The two eyes are found in the eyes box by dark-blob
 * detection (no schema change: the designer still gives one box per feature). Drawn states skip ComfyUI.
 *
 * An inpaint may change little (Z-Image at denoise 0.8 left a closed mouth almost closed: the CTS-11 probe). So each patch is MEASURED: the mean
 * absolute RGB difference to the rest crop over the box. Under the state's minimum the inpaint is retried at a higher denoise and a new seed; the
 * best attempt is kept and the report says if it stayed under.
 */

/** `[x, y, width, height]` in pixels of the master. */
export type Box = readonly [number, number, number, number]

export interface FaceBoxes {
  mouth: Box
  eyes: Box
  brows: Box
}

/** The states that are drawn. `U`, `FV` and `L` reuse `O`, `E` and `E`. */
export const MOUTH_MADE = ['rest', 'A', 'E', 'O', 'MBP'] as const
export const MOUTH_ALIAS = { U: 'O', FV: 'E', L: 'E' } as const
export const EYES_MADE = ['open', 'half', 'closed'] as const
export const BROWS_MADE = ['neutral', 'happy', 'sad', 'surprised'] as const

export type FaceKind = 'mouth' | 'eyes' | 'brows'

export type StateMethod = 'inpaint' | 'drawn' | 'master'
export type StateSpec = { method: 'inpaint'; words: string; minDiff: number } | { method: 'drawn' } | { method: 'master' }
const I = (words: string, minDiff: number): StateSpec => ({ method: 'inpaint', words, minDiff })
const DRAWN: StateSpec = { method: 'drawn' }
const MASTER: StateSpec = { method: 'master' }

/** How each state is made. An inpaint state has words for Z-Image and the mean difference (0-255) from rest that counts as "reads clearly". */
export const STATE_SPEC: Record<FaceKind, Record<string, StateSpec>> = {
  mouth: {
    rest: MASTER,
    A: I('below the nose the mouth is wide open: one big dark rounded open mouth with a pink tongue, jaw dropped, no second nose', 14),
    E: I('below the nose the mouth is a wide happy grin stretched sideways, showing a row of white teeth', 12),
    O: I('below the nose the mouth is a small round open "O" shape, dark inside, lips in a circle', 12),
    MBP: DRAWN
  },
  eyes: { open: MASTER, half: DRAWN, closed: DRAWN },
  brows: { neutral: MASTER, happy: DRAWN, sad: DRAWN, surprised: DRAWN }
}

/** Denoise and seed offset per attempt: the first already redraws strongly, the later ones are near a full redraw of the box. */
export const INPAINT_ATTEMPTS = [
  { denoise: 0.9, seedOffset: 0 },
  { denoise: 1, seedOffset: 1 },
  { denoise: 1, seedOffset: 2 }
] as const

/** One inpaint: the master, a mask of the master's size (white = redraw), a prompt and seed; returns the file of the result (same size). */
export type InpaintFn = (o: { prompt: string; image: string; mask: string; denoise: number; seed: number; out: string }) => Promise<{ file: string; seconds?: number }>

/** The inpaint through the image provider `comfy` (Z-Image masked inpaint). */
export function comfyInpaint(ctx: ImageContext, size: { width: number; height: number }, o: { log?: (m: string) => void; signal?: AbortSignal } = {}): InpaintFn {
  return async (r) => {
    await comfyKindSwitch('image', { dataDir: ctx.svc.dataDir, ...(o.log ? { log: o.log } : {}) })
    const provider = await pick('comfy', ctx)
    o.signal?.throwIfAborted()
    const t0 = Date.now()
    const res = await provider.generate({ prompt: r.prompt, size, format: 'png', out: r.out, seed: r.seed, init: { image: r.image, denoise: r.denoise, mask: r.mask }, ...(o.signal ? { signal: o.signal } : {}) })
    return { file: res.file, seconds: Math.round((Date.now() - t0) / 100) / 10 }
  }
}

export interface PatchReport {
  kind: FaceKind
  state: string
  /** `master`: cut from the master; `inpaint`: masked Z-Image inpaint; `drawn`: SVG overlay made in code. */
  method: StateMethod
  /** How much the box changed against the master (see `boxDiff`); 0 for the states cut from the master itself. */
  diff: number
  minDiff: number
  ok: boolean
  attempts: { denoise: number; seed: number; diff: number; seconds: number }[]
  /** Seconds of the inpaints of this state. */
  seconds: number
}

export interface FacePatches {
  /** PNG bytes per made state. */
  mouth: Record<string, Buffer>
  eyes: Record<string, Buffer>
  brows: Record<string, Buffer>
  report: PatchReport[]
}

const clampBox = (b: Box, w: number, h: number): Box => {
  const x = Math.max(0, Math.round(b[0]))
  const y = Math.max(0, Math.round(b[1]))
  const bw = Math.min(w - x, Math.round(b[2]))
  const bh = Math.min(h - y, Math.round(b[3]))
  if (bw < 8 || bh < 8) throw new Error(`face box [${b.join(', ')}] is outside the picture (${w}x${h}) or smaller than 8 px`)
  return [x, y, bw, bh]
}

/** The width in px of the soft edge of a patch. */
export const featherOf = (box: Box): number => Math.max(2, Math.min(10, Math.floor(Math.min(box[2], box[3]) / 6)))

/** The mask for an inpaint: the box plus a margin, white on black, with a soft edge. Same size as the master. */
export async function boxMask(size: { width: number; height: number }, box: Box): Promise<Buffer> {
  const m = Math.max(6, Math.round(Math.min(box[2], box[3]) * 0.1))
  const x0 = Math.max(0, box[0] - m)
  const y0 = Math.max(0, box[1] - m)
  const x1 = Math.min(size.width, box[0] + box[2] + m)
  const y1 = Math.min(size.height, box[1] + box[3] + m)
  const rect = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}"><rect width="100%" height="100%" fill="#000"/><rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="#fff"/></svg>`)
  return sharp(rect).blur(Math.max(1, m / 3)).removeAlpha().png().toBuffer()
}

/**
 * The box cropped from `src`, with an alpha that is 1 inside and falls to 0 over the feather width at the edges. With `match` (the master) the patch is
 * shifted so that its border ring has the master's mean colour: the VAE round trip tints a redrawn area, and the plate must not show as a box.
 */
export async function cropPatch(src: Buffer | string, box: Box, match?: Buffer | string): Promise<Buffer> {
  const [x, y, w, h] = box
  const { data } = await sharp(src).extract({ left: x, top: y, width: w, height: h }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const f = featherOf(box)
  if (match) {
    const ref = await sharp(match).extract({ left: x, top: y, width: w, height: h }).removeAlpha().raw().toBuffer()
    const ring = f + 1
    const sum = [0, 0, 0]
    let n = 0
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (Math.min(i, j, w - 1 - i, h - 1 - j) >= ring) continue
        for (let c = 0; c < 3; c++) sum[c]! += ref[(j * w + i) * 3 + c]! - data[(j * w + i) * 4 + c]!
        n++
      }
    }
    for (let k = 0; k < w * h; k++) for (let c = 0; c < 3; c++) data[k * 4 + c] = Math.max(0, Math.min(255, Math.round(data[k * 4 + c]! + sum[c]! / Math.max(1, n))))
  }
  for (let j = 0; j < h; j++) {
    const ey = Math.min(1, (Math.min(j, h - 1 - j) + 0.5) / f)
    for (let i = 0; i < w; i++) {
      const ex = Math.min(1, (Math.min(i, w - 1 - i) + 0.5) / f)
      data[(j * w + i) * 4 + 3] = Math.round(255 * Math.min(ex, ey))
    }
  }
  const raw = { raw: { width: w, height: h, channels: 4 as const } }
  const png = await sharp(data, raw).png({ compressionLevel: 9 }).toBuffer()
  // a flat cartoon quantises well; lint wants a plate under 512 KB
  return png.length > 400 * 1024 ? sharp(data, raw).png({ palette: true, quality: 92, compressionLevel: 9 }).toBuffer() : png
}

/**
 * How much the box changed between two pictures of one size, 0-255: the mean absolute RGB difference over the inside of the box after taking out the between two pictures of one size, 0-255: the mean absolute RGB difference over the inside of the box after taking out the
 * average tint of its border ring (the VAE round trip tints a redrawn area; a tint alone is not a new mouth).
 */
export async function boxDiff(a: Buffer | string, b: Buffer | string, box: Box): Promise<number> {
  const [, , w, h] = box
  const get = async (s: Buffer | string) => sharp(s).extract({ left: box[0], top: box[1], width: w, height: h }).removeAlpha().raw().toBuffer()
  const [pa, pb] = await Promise.all([get(a), get(b)])
  const ring = featherOf(box) + 1
  const off = [0, 0, 0]
  let n = 0
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (Math.min(i, j, w - 1 - i, h - 1 - j) >= ring) continue
    for (let c = 0; c < 3; c++) off[c]! += pa[(j * w + i) * 3 + c]! - pb[(j * w + i) * 3 + c]!
    n++
  }
  let sum = 0
  let m = 0
  for (let j = ring; j < h - ring; j++) for (let i = ring; i < w - ring; i++) {
    for (let c = 0; c < 3; c++) sum += Math.abs(pa[(j * w + i) * 3 + c]! - pb[(j * w + i) * 3 + c]! - off[c]! / Math.max(1, n))
    m += 3
  }
  return m ? Math.round((sum / m) * 100) / 100 : 0
}

// ---- drawn states (closed mouth, half/closed eyes, brows) ----

type RGB = [number, number, number]
const hex = (c: RGB): string => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`
const luma = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b

interface Eye {
  cx: number
  cy: number
  rx: number
  ry: number
  /** The fur around the eye, used for the lids. */
  lid: RGB
}

/** What the drawn states take from the master, in master pixels. */
export interface FaceLook {
  /** The commonest colour of the mouth box: the muzzle. */
  muzzle: RGB
  /** The outline: the mean of the darkest painted pixels of the mouth. */
  ink: RGB
  /** The painted mouth's bounding box `[x0, y0, x1, y1]` (the middle of the box when nothing dark was found). */
  inkBox: [number, number, number, number]
  /** Left eye first. */
  eyes: [Eye, Eye]
}

async function rawRgb(src: Buffer | string, box: Box): Promise<Buffer> {
  return sharp(src).extract({ left: box[0], top: box[1], width: box[2], height: box[3] }).removeAlpha().raw().toBuffer()
}

/** The commonest colour of RGB pixels, found on a 5 bit grid, as the mean of the pixels in the winning cell. */
function commonColour(px: number[][]): RGB {
  const cells = new Map<number, { n: number; s: RGB }>()
  for (const p of px) {
    const k = ((p[0]! >> 3) << 10) | ((p[1]! >> 3) << 5) | (p[2]! >> 3)
    const c = cells.get(k) ?? { n: 0, s: [0, 0, 0] as RGB }
    c.n++
    for (let i = 0; i < 3; i++) c.s[i]! += p[i]!
    cells.set(k, c)
  }
  let best: { n: number; s: RGB } | null = null
  for (const c of cells.values()) if (!best || c.n > best.n) best = c
  return best ? (best.s.map((v) => v / best!.n) as RGB) : [200, 170, 130]
}

const inEllipse = (i: number, j: number, w: number, h: number, k: number): boolean => ((i + 0.5 - w / 2) / (w / 2)) ** 2 + ((j + 0.5 - h / 2) / (h / 2)) ** 2 <= k * k

/** Reads the muzzle, the outline colour and the two eyes from the master (see the head of this file). */
export async function sampleLook(master: Buffer | string, boxes: FaceBoxes): Promise<FaceLook> {
  // the muzzle (the commonest colour of the mouth box) and the outline (the darkest painted pixels in it)
  const [mx, my, mw, mh] = boxes.mouth
  const mdata = await rawRgb(master, boxes.mouth)
  const mpx: number[][] = []
  for (let k = 0; k < mw * mh; k++) mpx.push([mdata[k * 3]!, mdata[k * 3 + 1]!, mdata[k * 3 + 2]!])
  const muzzle = commonColour(mpx)
  const dark = luma(...muzzle)
  const inkPx: { l: number; c: RGB }[] = []
  let x0 = mw, y0 = mh, x1 = -1, y1 = -1
  for (let j = 0; j < mh; j++) for (let i = 0; i < mw; i++) {
    const r = mdata[(j * mw + i) * 3]!, g = mdata[(j * mw + i) * 3 + 1]!, b = mdata[(j * mw + i) * 3 + 2]!
    const l = luma(r, g, b)
    if (l >= dark - 45 || !inEllipse(i, j, mw, mh, 0.92)) continue
    inkPx.push({ l, c: [r, g, b] })
    x0 = Math.min(x0, i); x1 = Math.max(x1, i); y0 = Math.min(y0, j); y1 = Math.max(y1, j)
  }
  let ink: RGB = [70, 45, 35]
  let inkBox: FaceLook['inkBox'] = [mx + mw * 0.3, my + mh * 0.2, mx + mw * 0.7, my + mh * 0.5]
  if (inkPx.length >= 12) {
    inkPx.sort((a, b) => a.l - b.l)
    const dk = inkPx.slice(0, Math.max(4, Math.floor(inkPx.length * 0.2)))
    ink = [0, 1, 2].map((c) => dk.reduce((s, p) => s + p.c[c]!, 0) / dk.length) as RGB
    inkBox = [mx + x0, my + y0, mx + x1 + 1, my + y1 + 1]
  }
  // the two eyes: the dark blobs of the eyes box, one per half
  const [ex, ey, ew, eh] = boxes.eyes
  const edata = await rawRgb(master, boxes.eyes)
  const ls: number[] = []
  for (let k = 0; k < ew * eh; k++) ls.push(luma(edata[k * 3]!, edata[k * 3 + 1]!, edata[k * 3 + 2]!))
  const sorted = [...ls].sort((a, b) => a - b)
  const p5 = sorted[Math.floor(sorted.length * 0.05)]!
  const med = sorted[Math.floor(sorted.length / 2)]!
  const thr = (p5 + med) / 2
  const found = med - p5 >= 25
  // connected dark blobs; the two biggest are the eyes (the nose or a whisker is smaller)
  const label = new Int32Array(ew * eh)
  const blobs: { n: number; x0: number; x1: number; y0: number; y1: number }[] = []
  if (found) {
    for (let k0 = 0; k0 < ew * eh; k0++) {
      if (label[k0] || ls[k0]! >= thr) continue
      const blob = { n: 0, x0: ew, x1: -1, y0: eh, y1: -1 }
      const stack = [k0]
      label[k0] = blobs.length + 1
      while (stack.length) {
        const k = stack.pop()!
        const x = k % ew, y = Math.floor(k / ew)
        blob.n++
        blob.x0 = Math.min(blob.x0, x); blob.x1 = Math.max(blob.x1, x); blob.y0 = Math.min(blob.y0, y); blob.y1 = Math.max(blob.y1, y)
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx, ny = y + dy
          const nk = ny * ew + nx
          if (nx >= 0 && ny >= 0 && nx < ew && ny < eh && !label[nk] && ls[nk]! < thr) { label[nk] = blobs.length + 1; stack.push(nk) }
        }
      }
      blobs.push(blob)
    }
  }
  const big = blobs.filter((q) => q.n >= 30).sort((p, q) => q.n - p.n).slice(0, 2).sort((p, q) => p.x0 - q.x0)
  const eyes = [0, 1].map((side): Eye => {
    const bl = big.length === 2 ? big[side] : undefined
    const e: Omit<Eye, 'lid'> = bl
      ? { cx: ex + (bl.x0 + bl.x1 + 1) / 2, cy: ey + (bl.y0 + bl.y1 + 1) / 2, rx: (bl.x1 - bl.x0 + 1) / 2, ry: (bl.y1 - bl.y0 + 1) / 2 }
      : { cx: ex + ew * (side ? 0.75 : 0.25), cy: ey + eh / 2, rx: eh * 0.28, ry: eh * 0.3 }
    // the lid colour: the commonest light colour in a ring around the eye
    const ring: number[][] = []
    for (let j = 0; j < eh; j++) for (let i = 0; i < ew; i++) {
      const d = Math.hypot((ex + i + 0.5 - e.cx) / e.rx, (ey + j + 0.5 - e.cy) / e.ry)
      if (d > 1.2 && d < 1.6 && (!found || ls[j * ew + i]! >= thr)) ring.push([edata[(j * ew + i) * 3]!, edata[(j * ew + i) * 3 + 1]!, edata[(j * ew + i) * 3 + 2]!])
    }
    return { ...e, lid: ring.length ? commonColour(ring) : commonColour(Array.from({ length: ew * eh }, (_, k) => [edata[k * 3]!, edata[k * 3 + 1]!, edata[k * 3 + 2]!])) }
  }) as [Eye, Eye]
  if (eyes[0].cx > eyes[1].cx) eyes.reverse()
  return { muzzle, ink, inkBox, eyes }
}

const svgOf = (box: Box, body: string): Buffer => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${box[2]}" height="${box[3]}" viewBox="${box[0]} ${box[1]} ${box[2]} ${box[3]}">${body}</svg>`)
const n1 = (v: number): string => (Math.round(v * 10) / 10).toString()

/** The SVG body of one drawn eyes state (master pixel coordinates): lids in the fur colour over the eyes, then a dark line. */
function eyesBody(look: FaceLook, state: string): string {
  return look.eyes
    .map((e, idx) => {
      const lid = hex(e.lid)
      const ink = hex(look.ink)
      const sw = Math.max(3, Math.round(e.ry * 0.16))
      if (state === 'closed') {
        // the lid covers the eye fully; a dark downward curve is the shut eye
        return `<ellipse cx="${n1(e.cx)}" cy="${n1(e.cy)}" rx="${n1(e.rx + 4)}" ry="${n1(e.ry + 4)}" fill="${lid}"/>` +
          `<path d="M${n1(e.cx - e.rx * 0.95)},${n1(e.cy - e.ry * 0.2)} Q${n1(e.cx)},${n1(e.cy + e.ry * 0.9)} ${n1(e.cx + e.rx * 0.95)},${n1(e.cy - e.ry * 0.2)}" fill="none" stroke="${ink}" stroke-width="${sw}" stroke-linecap="round"/>`
      }
      // half: a lid over the upper half of the eye, and the lid's edge
      const id = `lid${idx}`
      return `<clipPath id="${id}"><ellipse cx="${n1(e.cx)}" cy="${n1(e.cy)}" rx="${n1(e.rx + 4)}" ry="${n1(e.ry + 4)}"/></clipPath>` +
        `<rect x="${n1(e.cx - e.rx - 6)}" y="${n1(e.cy - e.ry - 6)}" width="${n1(e.rx * 2 + 12)}" height="${n1(e.ry + 6)}" fill="${lid}" clip-path="url(#${id})"/>` +
        `<path d="M${n1(e.cx - e.rx - 1)},${n1(e.cy)} Q${n1(e.cx)},${n1(e.cy + e.ry * 0.14)} ${n1(e.cx + e.rx + 1)},${n1(e.cy)}" fill="none" stroke="${ink}" stroke-width="${Math.max(2, Math.round(sw * 0.8))}" stroke-linecap="round"/>`
    })
    .join('')
}

/** The SVG body of one drawn brows state, in master pixel coordinates: a dark rounded stroke above each eye, inside the brows box. */
function browsBody(look: FaceLook, state: string, box: Box): string {
  const [bx, by, bw, bh] = box
  const mid = (look.eyes[0].cx + look.eyes[1].cx) / 2
  const out: string[] = []
  for (const e of look.eyes) {
    const t = Math.max(3, Math.min(10, Math.round(e.rx * 2 * 0.17)))
    const half = Math.max(e.rx * 1.05, 8)
    const inner = e.cx < mid ? 1 : -1
    const X = (v: number): number => Math.max(bx + t, Math.min(bx + bw - t, v))
    const Y = (f: number): number => Math.max(by + t / 2 + 1, Math.min(by + bh - t / 2 - 1, by + bh * f))
    const o = X(e.cx - inner * half)
    const i = X(e.cx + inner * half)
    let oy: number, iy: number, cy: number
    if (state === 'happy') { oy = iy = Y(0.82); cy = oy - 2 * bh * 0.16 }
    else if (state === 'sad') { oy = Y(0.9); iy = Y(0.56); cy = (oy + iy) / 2 - bh * 0.05 }
    else if (state === 'surprised') { oy = iy = Y(0.5); cy = oy - 2 * bh * 0.17 }
    else { oy = iy = Y(0.82); cy = oy }
    cy = Math.max(by + t / 2 + 1, cy)
    out.push(`<path d="M${n1(o)},${n1(oy)} Q${n1((o + i) / 2)},${n1(cy)} ${n1(i)},${n1(iy)}" fill="none" stroke="${hex(look.ink)}" stroke-width="${t}" stroke-linecap="round"/>`)
  }
  return out.join('')
}

/** The closed mouth: the painted mouth covered with the muzzle colour (its dark pixels, grown by 3 px), then a short slightly curved dark line. */
async function closedMouth(master: Buffer | string, box: Box, look: FaceLook): Promise<Buffer> {
  const [bx, by, w, h] = box
  const data = await sharp(master).extract({ left: bx, top: by, width: w, height: h }).removeAlpha().raw().toBuffer()
  const dark = luma(...look.muzzle) - 25
  const cover = new Uint8Array(w * h)
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (bx + i < look.inkBox[0] - 6 || bx + i > look.inkBox[2] + 6 || by + j < look.inkBox[1] - 6 || by + j > look.inkBox[3] + 6) continue
    if (luma(data[(j * w + i) * 3]!, data[(j * w + i) * 3 + 1]!, data[(j * w + i) * 3 + 2]!) < dark) cover[j * w + i] = 1
  }
  const R = 3
  const grown = new Uint8Array(w * h)
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!cover[j * w + i]) continue
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
      const x = i + di, y = j + dj
      if (x >= 0 && y >= 0 && x < w && y < h && di * di + dj * dj <= R * R + 1) grown[y * w + x] = 1
    }
  }
  for (let k = 0; k < w * h; k++) if (grown[k]) for (let c = 0; c < 3; c++) data[k * 3 + c] = Math.round(look.muzzle[c]!)
  const [ix0, iy0, ix1, iy1] = look.inkBox
  const lw = Math.max(32, (ix1 - ix0) * 0.5)
  const cx = (ix0 + ix1) / 2
  const y = iy0 + (iy1 - iy0) * 0.32
  const sag = Math.max(2, lw * 0.1)
  const sw = Math.max(4, Math.round(w / 32))
  const line = svgOf(box, `<path d="M${n1(cx - lw / 2)},${n1(y)} Q${n1(cx)},${n1(y + sag * 2)} ${n1(cx + lw / 2)},${n1(y)}" fill="none" stroke="${hex(look.ink)}" stroke-width="${sw}" stroke-linecap="round"/>`)
  const base = await sharp(data, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer()
  return sharp(base).composite([{ input: line }]).png().toBuffer()
}

/** One drawn state: `composite` is the whole master with the state on it (for the measure and the crop), `plate` is the box alone (transparent for brows). */
export async function drawState(master: Buffer | string, kind: FaceKind, state: string, boxes: FaceBoxes, look: FaceLook): Promise<{ composite: Buffer; plate: Buffer }> {
  const box = boxes[kind]
  let overlay: Buffer
  if (kind === 'mouth') overlay = await closedMouth(master, box, look)
  else overlay = await sharp(svgOf(box, kind === 'eyes' ? eyesBody(look, state) : browsBody(look, state, box))).png().toBuffer()
  const composite = await sharp(master).removeAlpha().composite([{ input: overlay, left: box[0], top: box[1] }]).png().toBuffer()
  return { composite, plate: overlay }
}

export interface FacePatchOptions {
  /** Absolute path of the master (`ref.png`). */
  master: string
  boxes: FaceBoxes
  /** The character prompt (the one the master was made with). */
  prompt: string
  seed: number
  inpaint: InpaintFn
  /** Scratch folder for masks and inpaint results; the best result per state stays (`<kind>-<state>.png`). */
  workDir: string
  log?: (m: string) => void
  signal?: AbortSignal
  /** Overrides the denoise/seed schedule (tests). */
  attempts?: readonly { denoise: number; seedOffset: number }[]
}

/**
 * Makes every patch. Rest/open/neutral are cut from the master; the drawn states (closed mouth, half/closed eyes, brows) are made in code; each inpaint state is the best of up to 3 masked inpaints (the first whose mean
 * difference to rest reaches the state's minimum wins; otherwise the largest difference is kept and `ok` is false in the report).
 */
export async function makeFacePatches(o: FacePatchOptions): Promise<FacePatches> {
  const meta = await sharp(o.master).metadata()
  const W = meta.width ?? 1024
  const H = meta.height ?? 1536
  await fs.mkdir(o.workDir, { recursive: true })
  const out: FacePatches = { mouth: {}, eyes: {}, brows: {}, report: [] }
  const schedule = o.attempts ?? INPAINT_ATTEMPTS
  const boxes: FaceBoxes = { mouth: clampBox(o.boxes.mouth, W, H), eyes: clampBox(o.boxes.eyes, W, H), brows: clampBox(o.boxes.brows, W, H) }
  const look0 = await sampleLook(o.master, boxes)
  for (const kind of ['mouth', 'eyes', 'brows'] as const) {
    const box = boxes[kind]
    const maskFile = path.join(o.workDir, `mask-${kind}.png`)
    await fs.writeFile(maskFile, await boxMask({ width: W, height: H }, box))
    for (const [state, spec] of Object.entries(STATE_SPEC[kind])) {
      o.signal?.throwIfAborted()
      if (spec.method === 'master') {
        out[kind][state] = await cropPatch(o.master, box)
        out.report.push({ kind, state, method: 'master', diff: 0, minDiff: 0, ok: true, attempts: [], seconds: 0 })
        continue
      }
      if (spec.method === 'drawn') {
        const t0 = Date.now()
        const full = await drawState(o.master, kind, state, boxes, look0)
        const diff = await boxDiff(full.composite, o.master, box)
        out[kind][state] = kind === 'brows' ? full.plate : await cropPatch(full.composite, box)
        out.report.push({ kind, state, method: 'drawn', diff, minDiff: 0, ok: true, attempts: [], seconds: Math.round((Date.now() - t0) / 100) / 10 })
        o.log?.(`face ${kind}/${state}: drawn, difference ${diff}`)
        continue
      }
      const prompt = `${o.prompt.trim().replace(/[.s]*$/, '.')} Only the ${kind === 'mouth' ? 'mouth' : kind === 'eyes' ? 'eyes' : 'eyebrows'} change: ${spec.words}. Same character, same flat colours and outline, same head and face.`
      const attempts: PatchReport['attempts'] = []
      let best: { file: string; diff: number } | null = null
      for (const [n, a] of schedule.entries()) {
        const seed = o.seed + a.seedOffset
        const file = path.join(o.workDir, `${kind}-${state}-try${n + 1}`)
        const r = await o.inpaint({ prompt, image: o.master, mask: maskFile, denoise: a.denoise, seed, out: file })
        const diff = await boxDiff(r.file, o.master, box)
        attempts.push({ denoise: a.denoise, seed, diff, seconds: r.seconds ?? 0 })
        o.log?.(`face ${kind}/${state}: try ${n + 1} denoise ${a.denoise} seed ${seed}: difference ${diff} (need ${spec.minDiff}), ${r.seconds ?? '?'} s`)
        if (!best || diff > best.diff) {
          if (best) await fs.rm(best.file, { force: true })
          best = { file: r.file, diff }
        } else await fs.rm(r.file, { force: true })
        if (diff >= spec.minDiff) break
      }
      const keep = path.join(o.workDir, `${kind}-${state}.png`)
      await fs.copyFile(best!.file, keep)
      await fs.rm(best!.file, { force: true })
      out[kind][state] = await cropPatch(keep, box, o.master)
      out.report.push({ kind, state, method: 'inpaint', diff: best!.diff, minDiff: spec.minDiff, ok: best!.diff >= spec.minDiff, attempts, seconds: Math.round(attempts.reduce((s, x) => s + x.seconds, 0) * 10) / 10 })
    }
  }
  return out
}

export const boxCentre = (b: Box): [number, number] => [b[0] + b[2] / 2, b[1] + b[3] / 2]
