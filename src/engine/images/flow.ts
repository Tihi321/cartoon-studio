import path from 'node:path'
import type { ImageContext, ImageProvider, ImageRequest, ImageResult } from './provider'

/**
 * Google Flow images (Nano Banana) through flow-music-mcp's `flow_generate`, scene `type: "image"`, `max_credits: 0` (the client in
 * `studios/flow.ts` sends it; flow-music-mcp also forces `s.max_credits ?? 0` for images, so a paid image model is refused, never charged).
 * Images only: this provider never sends a video scene. Free, so it is not behind `charge`.
 * UNTESTED against a live Flow in CTS-08: the pilot exercises it.
 */

function aspectOf(size: { width: number; height: number }): '16:9' | '9:16' | '1:1' {
  const r = size.width / size.height
  return r > 1.3 ? '16:9' : r < 0.77 ? '9:16' : '1:1'
}

export function flowProvider(ctx: ImageContext): ImageProvider {
  return {
    id: 'flow',
    async generate(req: ImageRequest): Promise<ImageResult> {
      if (req.format === 'svg') throw new Error('flow makes raster pictures only; use the recraft provider for format "svg"')
      const { flow } = await ctx.svc.studios({ autoStart: true })
      const img = await flow.generateImage({
        prompt: req.prompt,
        aspect: aspectOf(req.size),
        ...(req.model ? { model: req.model } : {}),
        ...(req.refs?.length ? { references: req.refs.slice(0, 3) } : {}),
        quality: 'original',
        project: `cartoon-studio-${ctx.series}`,
        out: path.dirname(req.out),
        name: path.basename(req.out),
        timeoutMs: 600_000,
        signal: req.signal
      })
      return { file: img.file, costUsd: 0, provider: 'flow', model: req.model ?? 'nano-banana' }
    }
  }
}
