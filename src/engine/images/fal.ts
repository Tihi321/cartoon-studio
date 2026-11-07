import { charge } from '../budget/spend'
import type { ImageContext, ImageProvider, ImageRequest, ImageResult } from './provider'
import { priceOf, requireKey, saveBytes } from './provider'

/**
 * fal.ai through its HTTPS queue API: submit `POST https://queue.fal.run/<model>`, poll the status URL, read the response URL, download the
 * image. Model ids and their USD per image come from `config/prices.md` (`provider: fal`); a model with no row is refused (`PRICE_UNKNOWN`).
 * The key is read from this tool's own keyring entry (`key-set fal`); a missing key is `KEY_MISSING fal`. Every call is behind `charge` (usd),
 * so with no `budget.json` it is refused (`BUDGET_EXCEEDED`) before any request leaves the machine.
 * UNTESTED against the live API (the request/response shapes follow fal's queue documentation and are unverified).
 */

export const FAL_DEFAULT_MODEL = 'fal-ai/flux/schnell'
/** The `#vector` suffix in prices.md marks the vector variant of a model that is one endpoint for both. */
export const FAL_VECTOR_SUFFIX = '#vector'

interface FalQueued {
  request_id: string
  status_url: string
  response_url: string
}
interface FalStatus {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | string
}
interface FalResult {
  images?: Array<{ url: string; content_type?: string }>
  image?: { url: string }
}

export function falProvider(ctx: ImageContext & { pollMs?: number; timeoutMs?: number }): ImageProvider {
  const doFetch = ctx.fetchFn ?? fetch
  return {
    id: 'fal',
    async generate(req: ImageRequest): Promise<ImageResult> {
      const base = req.model ?? FAL_DEFAULT_MODEL
      const priceModel = req.format === 'svg' ? `${base}${FAL_VECTOR_SUFFIX}` : base
      const estimate = await priceOf(ctx.svc.dataDir, 'fal', priceModel, req.format)
      const endpoint = base.replace(FAL_VECTOR_SUFFIX, '')
      const r = await charge(
        { store: ctx.store, series: ctx.series, episode: ctx.episode, provider: 'fal', model: priceModel, what: ctx.what, currency: 'usd', estimate },
        async () => {
          const key = requireKey('fal', ctx.getKey)
          const headers = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' }
          const input: Record<string, unknown> = { prompt: req.prompt, image_size: { width: req.size.width, height: req.size.height }, num_images: 1 }
          if (req.seed !== undefined) input.seed = req.seed
          if (req.format === 'svg') input.style = 'vector_illustration'
          const sub = await doFetch(`https://queue.fal.run/${endpoint}`, { method: 'POST', headers, body: JSON.stringify(input), signal: req.signal })
          if (!sub.ok) throw new Error(`fal ${endpoint}: submit failed with HTTP ${sub.status} ${(await sub.text()).slice(0, 200)}`)
          const queued = (await sub.json()) as FalQueued
          const deadline = Date.now() + (ctx.timeoutMs ?? 600_000)
          for (;;) {
            const st = await doFetch(queued.status_url, { headers, signal: req.signal })
            if (!st.ok) throw new Error(`fal ${endpoint}: status failed with HTTP ${st.status}`)
            if (((await st.json()) as FalStatus).status === 'COMPLETED') break
            if (Date.now() > deadline) throw new Error(`fal ${endpoint}: not finished after ${(ctx.timeoutMs ?? 600_000) / 1000}s (request ${queued.request_id})`)
            await new Promise((res) => setTimeout(res, ctx.pollMs ?? 1500))
          }
          const out = await doFetch(queued.response_url, { headers, signal: req.signal })
          if (!out.ok) throw new Error(`fal ${endpoint}: result failed with HTTP ${out.status}`)
          const result = (await out.json()) as FalResult
          const url = result.images?.[0]?.url ?? result.image?.url
          if (!url) throw new Error(`fal ${endpoint}: the answer has no image url`)
          const img = await doFetch(url, { signal: req.signal })
          if (!img.ok) throw new Error(`fal ${endpoint}: download failed with HTTP ${img.status}`)
          return saveBytes(req.out, req.format, Buffer.from(await img.arrayBuffer()))
        }
      )
      return { file: r.value, costUsd: r.amount, provider: 'fal', model: priceModel }
    }
  }
}
