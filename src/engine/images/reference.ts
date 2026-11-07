import path from 'node:path'
import type { Bible } from '../../shared/contracts'
import { comfyKindSwitch } from '../comfy/kind-switch'
import { pick } from './provider'
import type { ImageContext } from './provider'

/**
 * Character references (CTS-07, step 2): ComfyUI makes up to three candidates per character on a flat #808080 grey, the figure standing with the arms held
 * away from the body so the arms and the torso can be told apart. The reference only guides the redraw of path (a); path (c) keys it (`images/key.ts`
 * removes the Z-Image halo). Local and free: only the `comfy` provider is used here, never a paid one.
 */

export const REF_SIZE = { width: 1024, height: 1536 } as const

/** What every reference prompt ends with, whatever the character-designer wrote. */
export const REF_SUFFIX =
  'Full figure standing, facing the camera in a slight three-quarter view, both arms held out away from the body so that each arm is clearly separate from the torso, legs slightly apart, feet visible. Plain flat solid #808080 grey background, no floor, no shadow, nothing else in the picture. Flat solid colours, thick dark outline, simple shapes, children\'s paper-cutout cartoon style, no text.'

export function refPrompt(designerPrompt: string, style: Pick<Bible['style'], 'look'>): string {
  return `${designerPrompt.trim().replace(/[.\s]*$/, '.')} Style: ${style.look}. ${REF_SUFFIX}`
}

export interface ReferenceResult {
  files: string[]
  seconds: number[]
  model: string
}

/** Makes `count` candidates `cast/<id>/ref/c1.png ...` with seeds `seed + i`. A candidate that fails is skipped; none made is an error. */
export async function generateReferences(o: { ctx: ImageContext; castDir: string; prompt: string; count?: number; seed: number; log: (m: string) => void; signal?: AbortSignal }): Promise<ReferenceResult> {
  await comfyKindSwitch('image', { dataDir: o.ctx.svc.dataDir, log: o.log })
  const provider = await pick('comfy', o.ctx)
  const files: string[] = []
  const seconds: number[] = []
  let model = ''
  const errors: string[] = []
  for (let i = 0; i < (o.count ?? 3); i++) {
    o.signal?.throwIfAborted()
    const t0 = Date.now()
    try {
      const r = await provider.generate({ prompt: o.prompt, size: REF_SIZE, format: 'png', out: path.join(o.castDir, 'ref', `c${i + 1}`), seed: o.seed + i, signal: o.signal })
      files.push(r.file)
      seconds.push(Math.round((Date.now() - t0) / 100) / 10)
      model = r.model
      o.log(`reference ${i + 1}: ${r.file} (${seconds[seconds.length - 1]} s, ${r.model})`)
    } catch (e) {
      errors.push((e as Error).message.split('\n')[0]!)
      o.log(`reference ${i + 1} failed: ${errors[errors.length - 1]}`)
    }
  }
  if (files.length === 0) throw new Error(`ComfyUI made no reference: ${errors.join('; ')}`)
  return { files, seconds, model }
}
