import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import type { z } from 'zod'
import type { RigVariant } from '../../shared/contracts'
import { generateFromSketch, readSheetMeta } from '../images/reference'
import { keyOut } from '../images/key'
import type { ImageContext } from '../images/provider'
import { poseRender } from '../render/sheet'
import type { SeriesStore } from '../series/service'
import { ask, imageCtx, relTo, requireChosen, seedOf } from './env'
import type { Env } from './env'
import type { reviewAnswer } from './tasks'

/**
 * Pose images (CTS-14), optional per gesture. A gesture is normally a part rotation; the pose image makes it look drawn instead: the player renders the
 * rig at the gesture's peak (`?sheet=<cast>&pose=<gesture>`, flat grey, 1024x1536), Z-Image image-to-image at denoise 0.55 closes the joints and the
 * hands, the grey is keyed away (`images/key.ts`) and the figure is cropped and brought back to the rig's own pixel scale. The frame-critic compares it
 * with the character sheet; `revise` gives ONE retry at a lower denoise, and a second `revise` leaves the gesture a part rotation (nothing is written
 * to the rig). A pass writes `<rig folder>/poses/<gesture>.png`, the rig's `poses.<gesture>` and the gesture's `pose`.
 *
 * The pose image keeps the diffused (painted) face and has no lip-sync, so the timeline never puts it over a line of that actor. `facePlates: true`
 * writes `face: { at, scale: 1 }` instead: the rig's face plates are then drawn over the image's head (the painted face under them is covered only if the
 * head sits where the render put it, so use it only when the pose reads well that way).
 */

/** Denoise per attempt: the plan's 0.45-0.6, then one retry lower. */
export const POSE_DENOISE = [0.55, 0.45] as const

export interface PoseReview {
  verdict: 'pass' | 'revise'
  notes?: string
}

export interface MakePoseOptions {
  ctx: ImageContext
  store: SeriesStore
  series: string
  cast: string
  gesture: string
  /** Rig variant to read and write (default: the chosen rig at `cast/<id>/rig.json`). */
  variant?: RigVariant
  /** The character prompt (the sheet's). */
  prompt: string
  seed: number
  /** The critic: looks at the pose image and the character sheet. Without one the first attempt is accepted. */
  review?: (o: { pose: string; render: string; attempt: number }) => Promise<PoseReview>
  facePlates?: boolean
  denoise?: readonly number[]
  log?: (m: string) => void
  signal?: AbortSignal
  playerDir?: string
}

export interface MakePoseResult {
  /** `made`: the pose is in the rig; `rotation`: every attempt was rejected, the gesture stays a part rotation. */
  status: 'made' | 'rotation'
  /** Path of the pose image relative to the rig folder (`poses/<gesture>.png`), when made. */
  src?: string
  attempts: { denoise: number; seed: number; seconds: number; verdict: 'pass' | 'revise' | 'unreviewed'; notes?: string }[]
}

/** The words that turn a gesture name into what the figure does (the same ones as the sheet poses). */
const GESTURE_WORDS: Record<string, string> = {
  wave: 'one arm raised high, waving hello with an open hand',
  point: 'one arm stretched out straight to the side, pointing with a finger',
  shrug: 'shoulders raised, both hands held up with open palms, shrugging'
}

export function posePrompt(prompt: string, gesture: string): string {
  const words = GESTURE_WORDS[gesture] ?? `doing the gesture "${gesture}"`
  return `${prompt.trim().replace(/[.\s]*$/, '.')} Same character, same colours, same shapes and proportions as the picture. Full figure standing, facing the camera, ${words}, both legs and feet visible. Plain flat solid #808080 grey background, no floor, no shadow, nothing else in the picture. Flat solid colours, thick dark outline, simple shapes, children's paper-cutout cartoon style, no text.`
}

/** The box (px) of the pixels with alpha, or null when the picture is empty. */
async function alphaBox(png: Buffer): Promise<{ left: number; top: number; width: number; height: number } | null> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let l = info.width, t = info.height, r = -1, b = -1
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 4 + 3]! < 16) continue
    if (x < l) l = x
    if (x > r) r = x
    if (y < t) t = y
    if (y > b) b = y
  }
  return r < 0 ? null : { left: l, top: t, width: r - l + 1, height: b - t + 1 }
}

/** The generated picture -> a keyed, cropped PNG at the rig's own pixel scale, with the feet point and the head origin in its pixels. */
export async function finishPose(generated: Buffer, render: { k: number; pivot: [number, number]; head: [number, number] }): Promise<{ png: Buffer; pivot: [number, number]; head: [number, number] }> {
  const keyed = await keyOut(generated)
  const box = await alphaBox(keyed)
  if (!box) throw new Error('the pose picture is empty after keying the grey away')
  const crop = await sharp(keyed).extract(box).png().toBuffer()
  const k = render.k
  const png = k < 0.999 ? await sharp(crop).resize({ width: Math.max(1, Math.round(box.width / k)) }).png().toBuffer() : crop
  const to = (p: [number, number]): [number, number] => [Math.round((p[0] - box.left) / k), Math.round((p[1] - box.top) / k)]
  return { png, pivot: to(render.pivot), head: to(render.head) }
}

export async function makePose(o: MakePoseOptions): Promise<MakePoseResult> {
  const log = o.log ?? (() => undefined)
  const rig = await o.store.readRig(o.series, o.cast, o.variant)
  const g = rig.gestures[o.gesture]
  if (!g) throw new Error(`the rig of ${o.cast} has no gesture "${o.gesture}" (${Object.keys(rig.gestures).join(', ')})`)
  const rigDir = o.store.paths(o.series).rigDir(o.cast, o.variant)
  const work = path.join(rigDir, 'poses', 'work')
  await fs.mkdir(work, { recursive: true })
  const render = await poseRender({ dataDir: o.ctx.svc.dataDir, series: o.series, cast: o.cast, gesture: o.gesture, ...(o.variant ? { variant: o.variant } : {}), out: path.join(work, `${o.gesture}-render.png`), ...(o.playerDir ? { playerDir: o.playerDir } : {}) })
  log(`pose render of ${o.cast}/${o.gesture}: scale ${Math.round(render.k * 100) / 100}, feet at ${render.pivot.map(Math.round).join(',')}`)
  const result: MakePoseResult = { status: 'rotation', attempts: [] }
  for (const [n, denoise] of (o.denoise ?? POSE_DENOISE).entries()) {
    o.signal?.throwIfAborted()
    const seed = o.seed + n
    const gen = await generateFromSketch({ ctx: o.ctx, prompt: posePrompt(o.prompt, o.gesture), sketch: render.file, out: path.join(work, `${o.gesture}-gen${n + 1}`), seed, denoise, log, ...(o.signal ? { signal: o.signal } : {}) })
    const done = await finishPose(await fs.readFile(gen.file), render)
    const file = path.join(work, `${o.gesture}-try${n + 1}.png`)
    await fs.writeFile(file, done.png)
    const review = o.review ? await o.review({ pose: file, render: render.file, attempt: n + 1 }) : null
    result.attempts.push({ denoise, seed, seconds: gen.seconds, verdict: review ? review.verdict : 'unreviewed', ...(review?.notes ? { notes: review.notes } : {}) })
    log(`pose ${o.cast}/${o.gesture}: try ${n + 1} denoise ${denoise}: ${review ? review.verdict : 'not reviewed'}`)
    if (review && review.verdict !== 'pass') continue
    const src = `poses/${o.gesture}.png`
    await fs.copyFile(file, path.join(rigDir, src))
    const poses = { ...(rig.poses ?? {}), [o.gesture]: { src, pivot: done.pivot, ...(o.facePlates ? { face: { at: done.head, scale: 1 } } : {}) } }
    await o.store.writeRig(o.series, o.cast, { ...rig, poses, gestures: { ...rig.gestures, [o.gesture]: { ...g, pose: o.gesture } } }, o.variant)
    result.status = 'made'
    result.src = src
    return result
  }
  return result
}

// ---- the job behind `cts_pose_make` ----

/** One pose image with the frame-critic's review of each attempt (revise = one retry at a lower denoise). Returns a line for the job result. */
export async function poseJob(e: Env, cast: string, gesture: string, facePlates = false): Promise<string> {
  const bible = await requireChosen(e)
  const member = bible.cast.find((c) => c.id === cast)
  if (!member) throw new Error(`no cast member "${cast}" (${bible.cast.map((c) => c.id).join(', ')})`)
  const p = e.store.paths(e.series)
  const sheetMeta = await readSheetMeta(p.castDir(cast))
  const sheetPng = path.join(p.castDir(cast), 'sheet.png')
  const hasSheet = await fs.stat(sheetPng).then((s) => s.isFile(), () => false)
  e.progress(0, `pose ${cast}/${gesture}`)
  const res = await makePose({
    ctx: imageCtx(e, `pose image ${cast}/${gesture}`),
    store: e.store,
    series: e.series,
    cast,
    gesture,
    prompt: sheetMeta?.prompt ?? `${member.name.en}. ${member.look ?? ''}`,
    seed: sheetMeta?.seed ?? seedOf(cast),
    facePlates,
    log: (m) => e.log(m),
    signal: e.ctx.signal,
    review: async ({ pose, render, attempt }) => {
      const r = await ask<z.infer<typeof reviewAnswer>>(
        e,
        {
          id: `pose-review-${cast}-${gesture}-${attempt}`,
          role: 'frame-critic',
          kind: 'pose-review',
          prompt: `Review the pose image of ${cast} for the gesture "${gesture}": the first picture is the pose image (attempt ${attempt}), the second is what it was made from (the rig at the gesture's peak), the third (if there is one) is the character sheet of ${cast}. It must be the same character as the sheet (colours, markings, proportions, face) doing the gesture, with closed joints and clean hands, flat 2D paper-cutout style. Fail it for a different character, extra or missing limbs, broken joints, a 3D or shaded look, or text.`,
          inputs: { paths: [relTo(e, pose), relTo(e, render), ...(hasSheet ? [`cast/${cast}/sheet.png`] : [])], json: { cast, gesture, attempt } },
          output: { schema: 'review', path: `episodes/${e.episode}/reviews/pose-${cast}-${gesture}-${attempt}.json` }
        },
        { check: (v) => ((v as z.infer<typeof reviewAnswer>).verdict === 'revise' && (v as z.infer<typeof reviewAnswer>).problems.length === 0 ? ['a "revise" verdict needs at least one problem with where, what and fix'] : []) }
      )
      return { verdict: r.value.verdict, notes: r.value.notes }
    }
  })
  return res.status === 'made'
    ? `${cast}/${gesture}: pose image made (${res.attempts.length} attempt(s), denoise ${res.attempts[res.attempts.length - 1]!.denoise}), poses/${gesture}.png`
    : `${cast}/${gesture}: the critic rejected ${res.attempts.length} attempt(s); the gesture stays a part rotation`
}
