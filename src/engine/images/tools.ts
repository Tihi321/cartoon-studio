import path from 'node:path'
import { z } from 'zod'
import { budgetState, localIso, reconcileEleven } from '../budget/spend'
import type { Tool, ToolDef } from '../mcp/tools'
import type { CtsService } from '../service'
import { assertId } from '../series/paths'
import { SeriesStore } from '../series/service'
import { MUSIC_MODELS, SFX_ENGINE, configuredMusicModel } from '../music/comfy'
import { configuredImageModel } from './comfy'
import { IMAGE_PROVIDERS, pick } from './provider'

/** MCP tools of CTS-08: the production budget (`cts_budget_set`, `cts_budget_get`), and image generation. */
export function imageTools(svc: CtsService, def: ToolDef): Tool[] {
  const store = () => new SeriesStore(svc.dataDir)
  const series = z.string().describe('The series slug')
  const episode = z.string().describe('The episode id whose budget pays (a series-level spend, like the intro clip, is charged to the episode that triggers it)')
  /** A path relative to the series folder (guarded) or an absolute one. */
  const place = (slug: string, p: string) => (path.isAbsolute(p) ? p : store().resolve(slug, p))

  return [
    def(
      'cts_budget_set',
      'Approve a production budget for one episode: writes episodes/<ep>/budget.json. capUsd caps paid image/voice calls (BUDGET_EXCEEDED past it), flowCreditsCap caps Flow credits (FLOW_CREDITS_EXCEEDED). Without this file both caps are 0 and every paid call is refused. Only call it after the user said yes to this amount (approvedBy = who said it). Spend already in spend.json still counts.',
      z.object({ series, episode, capUsd: z.number().min(0), flowCreditsCap: z.number().min(0).default(0), approvedBy: z.string().min(1), note: z.string().default('') }),
      async (a) => {
        assertId(a.episode, 'episode id')
        const saved = await store().writeBudget(a.series, a.episode, { schema: 'cts.budget/1', capUsd: a.capUsd, flowCreditsCap: a.flowCreditsCap, approvedBy: a.approvedBy, approvedAt: localIso(new Date()), note: a.note })
        return { budget: saved }
      }
    ),
    def(
      'cts_media_config',
      'Read-only: the image model and the order of fallbacks, the music engine (config/providers.md comfy.imageModel / comfy.musicModel) and the USD cap that gates the paid Nano Banana (gemini) provider (of the episode when series and episode are given, else 0). The Settings view shows it.',
      z.object({ series: series.optional(), episode: episode.optional() }),
      async (a) => {
        const capUsd = a.series && a.episode ? (await budgetState(store(), a.series, a.episode)).capUsd : 0
        const music = await configuredMusicModel(svc.dataDir)
        return {
          image: {
            model: await configuredImageModel(svc.dataDir),
            order: [
              { id: 'z-image-lower-denoise', label: 'Z-Image at a lower denoise from a render (a Blender still, or a canvas frame in an old series)', cost: 'free' },
              { id: 'qwen-image-2.1-edit', label: 'Qwen-Image 2.1 edit with the character sheet as reference', cost: 'free' },
              { id: 'gemini', label: 'Nano Banana (gemini image model)', cost: 'paid, only after the user says yes and a USD cap is set' }
            ]
          },
          music: { model: music, alternatives: MUSIC_MODELS.filter((m) => m !== music), sfx: SFX_ENGINE },
          gemini: { capUsd, refused: capUsd <= 0 }
        }
      }
    ),
    def(
      'cts_budget_get',
      'Read an episode budget: the caps (0 when there is no budget.json), what is spent per currency (usd, Flow credits, ElevenLabs free-tier credits), what is left, the ledger (spend.json), and eleven: the ElevenLabs reconciliation (CTS-43) of each voice phase, our estimate against the account counter read before and after it (apiDelta, withinTolerance ±10 %; a billing-period reset between the readings is reset: true and not judged; a status that could not be read is unread).',
      z.object({ series, episode }),
      async (a) => {
        const s = await budgetState(store(), a.series, a.episode)
        return {
          approved: s.approved,
          capUsd: s.capUsd,
          flowCreditsCap: s.flowCreditsCap,
          spentUsd: s.spentUsd,
          spentCredits: s.spentCredits,
          leftUsd: Math.max(0, Math.round((s.capUsd - s.spentUsd) * 1e9) / 1e9),
          leftCredits: Math.max(0, Math.round((s.flowCreditsCap - s.spentCredits) * 1e9) / 1e9),
          spentElevenCredits: Math.round(s.entries.filter((e) => e.currency === 'eleven-credits').reduce((x, e) => x + e.amount, 0) * 1e9) / 1e9,
          ledger: s.entries,
          eleven: reconcileEleven(s.elevenReadings)
        }
      }
    ),
    def(
      'cts_image_generate',
      'Make one picture with an image provider and save it in the series folder. comfy (default/auto): local ComfyUI, free, model from config/providers.md; with refs it edits them (Qwen edit); with init (+ denoise, optional mask) it runs Z-Image image-to-image, or a masked inpaint that redraws only the white part of mask. gemini (Nano Banana) and fal: paid, behind the episode budget (BUDGET_EXCEEDED with no approved cap; KEY_MISSING <provider> when the key is not stored: run node out/engine/index.js key-set <provider>). No image goes through Google Flow. Returns { file, costUsd, provider, model }.',
      z.object({
        series,
        episode,
        provider: z.enum([...IMAGE_PROVIDERS, 'auto']).default('auto'),
        prompt: z.string().min(1),
        width: z.number().int().min(64).max(4096).default(1024),
        height: z.number().int().min(64).max(4096).default(1024),
        format: z.enum(['png', 'svg']).default('png'),
        out: z.string().optional().describe('Output path without extension, relative to the series folder (default images/<provider>-<time>)'),
        refs: z.array(z.string()).max(5).optional().describe('Reference images: absolute, or relative to the series folder'),
        init: z.string().optional().describe('Image to image (comfy, Z-Image): the start picture, absolute or relative to the series folder. Size = the size of the start picture'),
        denoise: z.number().gt(0).max(1).optional().describe('With init: how far from the start picture, 0.75-0.85 for a rough sketch, 0.35-0.6 to clean up a render (default 0.8)'),
        mask: z.string().optional().describe('With init: a PNG of the size of the start picture, white = redraw (inpaint)'),
        model: z.string().optional(),
        seed: z.number().int().optional(),
        what: z.string().optional().describe('Text for the ledger')
      }),
      async (a) => {
        const st = store()
        assertId(a.episode, 'episode id')
        if ((a.denoise !== undefined || a.mask) && !a.init) throw new Error('denoise and mask need init (the start picture)')
        const provider = await pick(a.provider, { svc, store: st, series: a.series, episode: a.episode, what: a.what ?? a.prompt.slice(0, 60) })
        const out = place(a.series, a.out ?? `images/${provider.id}-${Date.now().toString(36)}`)
        return provider.generate({ prompt: a.prompt, size: { width: a.width, height: a.height }, format: a.format, out, ...(a.init ? { init: { image: place(a.series, a.init), denoise: a.denoise ?? 0.8, ...(a.mask ? { mask: place(a.series, a.mask) } : {}) } } : {}), ...(a.refs ? { refs: a.refs.map((r) => place(a.series, r)) } : {}), ...(a.model ? { model: a.model } : {}), ...(a.seed !== undefined ? { seed: a.seed } : {}) })
      }
    )
  ]
}
