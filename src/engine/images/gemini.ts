import { promises as fs } from 'node:fs'
import path from 'node:path'
import { charge } from '../budget/spend'
import type { ImageContext, ImageProvider, ImageRequest, ImageResult } from './provider'
import { priceOf, requireKey, saveBytes } from './provider'

/**
 * Nano Banana (the Gemini API image model) through `generateContent` with image output: the paid fallback when Z-Image cannot hold a character or a
 * pose. The model id defaults to `GEMINI_DEFAULT_MODEL`; its USD per image comes from `config/prices.md` (`provider: gemini`, "check before use"),
 * and a model with no row is refused (`PRICE_UNKNOWN`). The key is this tool's own keyring entry `GEMINI_API_KEY` (`key-set gemini`); a missing key is
 * `KEY_MISSING gemini`. Every call is behind `charge` (usd): with no approved cap (the pilot cap is $0) it is refused with `BUDGET_EXCEEDED` before
 * any request leaves the machine. Reference images go as inline images (base64). The API takes an aspect ratio, not a pixel size, so the result's size
 * is the model's, near the ratio of the requested size. `init` (Z-Image image-to-image) is not supported here: pass the picture as a reference.
 * UNTESTED against the live API (never called); the request and response shapes follow Google's generateContent documentation as remembered.
 */

export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash-image'
const GEMINI_RATIOS: Array<[string, number]> = [['1:1', 1], ['2:3', 2 / 3], ['3:2', 3 / 2], ['3:4', 3 / 4], ['4:3', 4 / 3], ['4:5', 4 / 5], ['5:4', 5 / 4], ['9:16', 9 / 16], ['16:9', 16 / 9], ['21:9', 21 / 9]]

/** The supported aspect ratio nearest (in log terms) to width / height. */
export function nearestRatio(width: number, height: number): string {
  const r = width / height
  return GEMINI_RATIOS.reduce((best, cur) => (Math.abs(Math.log(cur[1] / r)) < Math.abs(Math.log(best[1] / r)) ? cur : best))[0]
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

interface GeminiPart {
  text?: string
  inlineData?: { mimeType?: string; data?: string }
  inline_data?: { mime_type?: string; data?: string }
}
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>
  promptFeedback?: { blockReason?: string }
}

export function geminiProvider(ctx: ImageContext): ImageProvider {
  const doFetch = ctx.fetchFn ?? fetch
  return {
    id: 'gemini',
    async generate(req: ImageRequest): Promise<ImageResult> {
      if (req.format === 'svg') throw new Error('gemini makes PNG pictures only; write the SVG yourself for format "svg"')
      if (req.init) throw new Error('gemini has no image-to-image with denoise or mask: pass the start picture in refs')
      const model = req.model ?? GEMINI_DEFAULT_MODEL
      const estimate = await priceOf(ctx.svc.dataDir, 'gemini', model, 'png')
      const r = await charge(
        { store: ctx.store, series: ctx.series, episode: ctx.episode, provider: 'gemini', model, what: ctx.what, currency: 'usd', estimate },
        async () => {
          const key = requireKey('gemini', ctx.getKey)
          const parts: Array<Record<string, unknown>> = [{ text: req.prompt }]
          for (const ref of req.refs ?? []) {
            const mime = MIME[path.extname(ref).toLowerCase()] ?? 'image/png'
            parts.push({ inline_data: { mime_type: mime, data: (await fs.readFile(ref)).toString('base64') } })
          }
          const body = {
            contents: [{ role: 'user', parts }],
            generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: nearestRatio(req.size.width, req.size.height) } }
          }
          const res = await doFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
            method: 'POST',
            headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: req.signal
          })
          if (!res.ok) throw new Error(`gemini ${model}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
          const json = (await res.json()) as GeminiResponse
          const out = json.candidates?.flatMap((c) => c.content?.parts ?? []).map((p) => p.inlineData?.data ?? p.inline_data?.data).find((d) => !!d)
          if (!out) throw new Error(`gemini ${model}: the answer has no image${json.promptFeedback?.blockReason ? ` (blocked: ${json.promptFeedback.blockReason})` : json.candidates?.[0]?.finishReason ? ` (finish reason ${json.candidates[0].finishReason})` : ''}`)
          return saveBytes(req.out, 'png', Buffer.from(out, 'base64'))
        }
      )
      return { file: r.value, costUsd: r.amount, provider: 'gemini', model }
    }
  }
}
