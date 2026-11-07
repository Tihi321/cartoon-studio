import { promises as fs } from 'node:fs'
import path from 'node:path'
import { charge } from '../budget/spend'
import type { ImageContext, ImageProvider, ImageRequest, ImageResult } from './provider'
import { priceOf, requireKey, saveBytes } from './provider'

/**
 * Recraft's own API (`https://external.api.recraft.ai/v1`): `format: "svg"` uses the `vector_illustration` style and returns an SVG file.
 * A style is made once from reference images (`POST /styles`) and its id is stored in the bible (`style.recraftStyleId`), then reused for every
 * later call so the figures stay on style. Every call, including the style creation, is behind `charge` (usd); the key is read from this tool's
 * own keyring entry (`key-set recraft`). The pilot cap is $0, so every call here is refused until the user approves a budget.
 * UNTESTED against the live API (shapes follow Recraft's public documentation and are unverified).
 */

const API = 'https://external.api.recraft.ai/v1'
const MODEL = 'recraftv3'
/** Sizes the API accepts (width x height). */
const SIZES = ['1024x1024', '1365x1024', '1024x1365', '1536x1024', '1024x1536', '1820x1024', '1024x1820', '1024x2048', '2048x1024', '1434x1024', '1024x1434', '1024x1280', '1280x1024', '1024x1707', '1707x1024']

export function nearestSize(size: { width: number; height: number }): string {
  const want = size.width / size.height
  let best = SIZES[0]!
  let diff = Infinity
  for (const s of SIZES) {
    const [w, h] = s.split('x').map(Number) as [number, number]
    const d = Math.abs(Math.log(w / h / want))
    if (d < diff) {
      diff = d
      best = s
    }
  }
  return best
}

export function recraftProvider(ctx: ImageContext): ImageProvider {
  const doFetch = ctx.fetchFn ?? fetch

  async function createStyle(refs: string[], style: string, signal?: AbortSignal): Promise<string> {
    const estimate = await priceOf(ctx.svc.dataDir, 'recraft', `${MODEL}-style`, 'png')
    const r = await charge(
      { store: ctx.store, series: ctx.series, episode: ctx.episode, provider: 'recraft', model: `${MODEL}-style`, what: `${ctx.what} (style from ${refs.length} reference image(s))`, currency: 'usd', estimate },
      async () => {
        const key = requireKey('recraft', ctx.getKey)
        const form = new FormData()
        form.append('style', style)
        for (const [i, f] of refs.slice(0, 5).entries()) form.append(`file${i + 1}`, new Blob([new Uint8Array(await fs.readFile(f))]), path.basename(f))
        const res = await doFetch(`${API}/styles`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal })
        if (!res.ok) throw new Error(`recraft: style creation failed with HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
        const id = ((await res.json()) as { id?: string }).id
        if (!id) throw new Error('recraft: the style answer has no id')
        return id
      }
    )
    const bible = await ctx.store.readBible(ctx.series)
    await ctx.store.writeBible(ctx.series, { ...bible, style: { ...bible.style, recraftStyleId: r.value } })
    return r.value
  }

  return {
    id: 'recraft',
    async generate(req: ImageRequest): Promise<ImageResult> {
      const estimate = await priceOf(ctx.svc.dataDir, 'recraft', MODEL, req.format)
      const base = req.format === 'svg' ? 'vector_illustration' : 'digital_illustration'
      let styleId = req.styleId ?? (await ctx.store.readBible(ctx.series).catch(() => undefined))?.style.recraftStyleId
      if (!styleId && req.refs?.length) styleId = await createStyle(req.refs, base, req.signal)
      const r = await charge(
        { store: ctx.store, series: ctx.series, episode: ctx.episode, provider: 'recraft', model: MODEL, what: ctx.what, currency: 'usd', estimate },
        async () => {
          const key = requireKey('recraft', ctx.getKey)
          const body: Record<string, unknown> = { prompt: req.prompt, model: MODEL, size: nearestSize(req.size), n: 1, response_format: 'url' }
          if (styleId) body.style_id = styleId
          else body.style = base
          const res = await doFetch(`${API}/images/generations`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: req.signal })
          if (!res.ok) throw new Error(`recraft: generation failed with HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
          const url = ((await res.json()) as { data?: Array<{ url?: string }> }).data?.[0]?.url
          if (!url) throw new Error('recraft: the answer has no image url')
          const img = await doFetch(url, { signal: req.signal })
          if (!img.ok) throw new Error(`recraft: download failed with HTTP ${img.status}`)
          return saveBytes(req.out, req.format, Buffer.from(await img.arrayBuffer()))
        }
      )
      return { file: r.value, costUsd: r.amount, provider: 'recraft', model: MODEL, ...(styleId ? { styleId } : {}) }
    }
  }
}
