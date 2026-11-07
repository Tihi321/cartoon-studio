import { readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type { Bible } from '../../shared/contracts'
import { comfyKindSwitch } from '../comfy/kind-switch'
import { pick } from './provider'
import type { ImageContext } from './provider'

/**
 * The character sheet's pictures (CTS-12, step `cast_sheet`): Z-Image image-to-image over a sketch the app drew (`images/sketch.ts`). Denoise 0.8 keeps
 * the sketch's silhouette and palette and turns it into a cartoon figure on a flat #808080 grey (the CTS-11 probe). Local and free: only the `comfy`
 * provider is used here, never a paid one. Path (c) later keys the master (`images/key.ts` removes the Z-Image halo).
 */

export const REF_SIZE = { width: 1024, height: 1536 } as const
/** How far the sampler may drift from the sketch. Lower stays closer to the stick figure, higher loses the pose. */
export const SHEET_DENOISE = 0.8
/** Candidates for the front view: seeds `seed .. seed + 2`. */
export const SHEET_CANDIDATES = 3

const LOOK_SUFFIX = 'Plain flat solid #808080 grey background, no floor, no shadow, nothing else in the picture. Flat solid colours, thick dark outline, simple shapes, children\'s paper-cutout cartoon style, no text.'

/** What every sheet prompt ends with, whatever the character-designer wrote. */
export const REF_SUFFIX = `Full figure standing, facing the camera, arms held out away from the body so that each arm is clearly separate from the torso, both legs and feet visible. ${LOOK_SUFFIX}`

/** What the pose sketches add: what the figure does, in words, so Z-Image keeps the drawn pose. */
export const POSE_WORDS: Record<string, string> = {
  wave: 'one arm raised high, waving hello with an open hand',
  point: 'one arm stretched out straight to the side, pointing with a finger',
  shrug: 'shoulders raised, both hands held up with open palms, shrugging'
}

/** `note` is the user's redo note; `pose` (a key of `POSE_WORDS`) turns the front-view ending into the pose's. */
export function refPrompt(designerPrompt: string, style: Pick<Bible['style'], 'look'>, note?: string, pose?: string): string {
  const extra = note?.trim() ? ` ${note.trim().replace(/[.\s]*$/, '.')}` : ''
  const ending = pose ? `Full figure standing, facing the camera, ${POSE_WORDS[pose] ?? pose}, both legs and feet visible. ${LOOK_SUFFIX}` : REF_SUFFIX
  return `${designerPrompt.trim().replace(/[.\s]*$/, '.')}${extra} Style: ${style.look}. ${ending}`
}

export interface SheetImage {
  file: string
  seconds: number
  model: string
}

/** One Z-Image image-to-image from a sketch PNG (absolute path) to `<out>.png`, timed. Throws when ComfyUI fails: the step reports it. */
export async function generateFromSketch(o: { ctx: ImageContext; prompt: string; sketch: string; out: string; seed: number; denoise?: number; log?: (m: string) => void; signal?: AbortSignal }): Promise<SheetImage> {
  await comfyKindSwitch('image', { dataDir: o.ctx.svc.dataDir, ...(o.log ? { log: o.log } : {}) })
  const provider = await pick('comfy', o.ctx)
  o.signal?.throwIfAborted()
  const t0 = Date.now()
  const r = await provider.generate({ prompt: o.prompt, size: REF_SIZE, format: 'png', out: o.out, seed: o.seed, init: { image: o.sketch, denoise: o.denoise ?? SHEET_DENOISE }, signal: o.signal })
  const seconds = Math.round((Date.now() - t0) / 100) / 10
  o.log?.(`${path.basename(r.file)}: ${seconds} s, ${r.model}, seed ${o.seed}, denoise ${o.denoise ?? SHEET_DENOISE}`)
  return { file: r.file, seconds, model: r.model }
}

/** `cast/<id>/sheet/meta.json`: how the master and the poses were made (the step writes it, `cts_sheet_approve` copies seed, denoise and model into the bible). */
export interface SheetMeta {
  prompt: string
  /** The seed of the picked master; the poses use it too. */
  seed: number
  denoise: number
  model: string
  /** 0 for the first sheet; a redo adds 1 and moves the seeds by 10 per attempt. */
  attempt: number
  note: string | null
  picked: number
  notes: string
  /** Seconds per image: `c1..c3` for the candidates, then the poses. */
  seconds: Record<string, number>
}

export async function readSheetMeta(castDir: string): Promise<SheetMeta | null> {
  try {
    return JSON.parse(await readFile(path.join(castDir, 'sheet', 'meta.json'), 'utf8')) as SheetMeta
  } catch {
    return null
  }
}

/** `cast/<id>/sheet.png`: the master and the pose pictures side by side (each 512x768 on grey), for the user's look. */
export async function composeSheet(files: string[], out: string): Promise<string> {
  const w = 512
  const h = 768
  const tiles = await Promise.all(files.map(async (f, i) => ({ input: await sharp(f).resize(w, h, { fit: 'contain', background: '#808080' }).flatten({ background: '#808080' }).png().toBuffer(), left: i * w, top: 0 })))
  await sharp({ create: { width: w * files.length, height: h, channels: 3, background: '#808080' } }).composite(tiles).png().toFile(out)
  return out
}
