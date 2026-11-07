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

/** What each state looks like, in words for Z-Image, and the mean difference (0-255) from rest that counts as "reads clearly". */
export const STATE_SPEC: Record<FaceKind, Record<string, { words: string; minDiff: number } | null>> = {
  mouth: {
    rest: null,
    A: { words: 'below the nose the mouth is wide open: one big dark rounded open mouth with a pink tongue, jaw dropped, no second nose', minDiff: 14 },
    E: { words: 'below the nose the mouth is a wide happy grin stretched sideways, showing a row of white teeth', minDiff: 12 },
    O: { words: 'below the nose the mouth is a small round open "O" shape, dark inside, lips in a circle', minDiff: 12 },
    MBP: { words: 'below the nose the mouth is closed: one short straight horizontal thin dark line, lips pressed together, no teeth, no tongue', minDiff: 6 }
  },
  eyes: {
    half: { words: 'both eyes are half shut: the upper half of each eye is covered by a flat fur-coloured eyelid, only the lower half of the dark eye shows, sleepy', minDiff: 8 },
    closed: { words: 'both eyes are shut: each eye is drawn as one short curved dark line, like a happy closed eye, no round eyeball, no white highlight', minDiff: 10 },
    open: null
  },
  brows: {
    neutral: null,
    happy: { words: 'two thick dark brown curved eyebrow strokes clearly drawn above the eyes, raised in cheerful arches', minDiff: 6 },
    sad: { words: 'two thick dark brown eyebrow strokes clearly drawn above the eyes, slanted: the inner ends high and the outer ends low, worried and sad', minDiff: 6 },
    surprised: { words: 'two thick dark brown round eyebrow arcs drawn very high above the eyes, surprised', minDiff: 6 }
  }
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
 * Makes every patch. Rest/open/neutral are cut from the master; each other state is the best of up to 3 masked inpaints (the first whose mean
 * difference to rest reaches the state's minimum wins; otherwise the largest difference is kept and `ok` is false in the report).
 */
export async function makeFacePatches(o: FacePatchOptions): Promise<FacePatches> {
  const meta = await sharp(o.master).metadata()
  const W = meta.width ?? 1024
  const H = meta.height ?? 1536
  await fs.mkdir(o.workDir, { recursive: true })
  const out: FacePatches = { mouth: {}, eyes: {}, brows: {}, report: [] }
  const schedule = o.attempts ?? INPAINT_ATTEMPTS
  for (const kind of ['mouth', 'eyes', 'brows'] as const) {
    const box = clampBox(o.boxes[kind], W, H)
    const maskFile = path.join(o.workDir, `mask-${kind}.png`)
    await fs.writeFile(maskFile, await boxMask({ width: W, height: H }, box))
    for (const [state, spec] of Object.entries(STATE_SPEC[kind])) {
      o.signal?.throwIfAborted()
      if (!spec) {
        out[kind][state] = await cropPatch(o.master, box)
        out.report.push({ kind, state, diff: 0, minDiff: 0, ok: true, attempts: [], seconds: 0 })
        continue
      }
      const prompt = `${o.prompt.trim().replace(/[.\s]*$/, '.')} Only the ${kind === 'mouth' ? 'mouth' : kind === 'eyes' ? 'eyes' : 'eyebrows'} change: ${spec.words}. Same character, same flat colours and outline, same head and face.`
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
      out.report.push({ kind, state, diff: best!.diff, minDiff: spec.minDiff, ok: best!.diff >= spec.minDiff, attempts, seconds: Math.round(attempts.reduce((s, x) => s + x.seconds, 0) * 10) / 10 })
    }
  }
  return out
}

export const boxCentre = (b: Box): [number, number] => [b[0] + b[2] / 2, b[1] + b[3] / 2]
