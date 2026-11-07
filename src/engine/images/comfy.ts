import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseMd } from '../../shared/md'
import { comfyKindSwitch } from '../comfy/kind-switch'
import type { ImageContext, ImageProvider, ImageRequest, ImageResult } from './provider'
import { saveBytes } from './provider'

/**
 * Local ComfyUI: $0. The model comes from `config/providers.md` `comfy.imageModel` (z-image-turbo by default); a reference image switches to the
 * Qwen-Image 2.1 edit graph. `removeBackground` is BiRefNet (alpha PNG). Both go through the Edu `ComfyClient` (`comfy/client.ts`, `comfy/graphs.ts`).
 * UNTESTED against a live ComfyUI in CTS-08: the pilot exercises it.
 */

export const DEFAULT_IMAGE_MODEL = 'z-image-turbo'
export const EDIT_MODEL = 'qwen-image-2.1-edit'

export async function configuredImageModel(dataDir: string): Promise<string> {
  try {
    const data = parseMd(await readFile(path.join(dataDir, 'config', 'providers.md'), 'utf8'), 'providers.md').data
    const m = (data.comfy as { imageModel?: unknown } | undefined)?.imageModel
    return typeof m === 'string' && m ? m : DEFAULT_IMAGE_MODEL
  } catch {
    return DEFAULT_IMAGE_MODEL
  }
}

export function comfyProvider(ctx: ImageContext): ImageProvider {
  return {
    id: 'comfy',
    async generate(req: ImageRequest): Promise<ImageResult> {
      if (req.format === 'svg') throw new Error('comfy makes PNG pictures only; use the recraft provider (or write the SVG yourself) for format "svg"')
      const edit = (req.refs?.length ?? 0) > 0
      const engine = req.model ?? (edit ? EDIT_MODEL : await configuredImageModel(ctx.svc.dataDir))
      await comfyKindSwitch('image', { dataDir: ctx.svc.dataDir })
      const comfy = await ctx.svc.comfy({ autoStart: true })
      const r = await comfy.generate({
        engine,
        prompt: req.prompt,
        width: req.size.width,
        height: req.size.height,
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
        ...(edit ? { references: req.refs } : {}),
        signal: req.signal
      })
      return { file: await saveBytes(req.out, r.ext || 'png', r.bytes), costUsd: 0, provider: 'comfy', model: engine }
    }
  }
}

/** BiRefNet through ComfyUI: a PNG with the background cut out. Null when ComfyUI has no removal model. */
export async function removeBackground(ctx: Pick<ImageContext, 'svc'>, input: Buffer, signal?: AbortSignal): Promise<Buffer | null> {
  await comfyKindSwitch('image', { dataDir: ctx.svc.dataDir })
  const comfy = await ctx.svc.comfy({ autoStart: true })
  return comfy.removeBackground(input, { signal })
}
