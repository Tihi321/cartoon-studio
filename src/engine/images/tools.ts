import path from 'node:path'
import { z } from 'zod'
import { budgetState, localIso } from '../budget/spend'
import type { Tool, ToolDef } from '../mcp/tools'
import type { CtsService } from '../service'
import { assertId } from '../series/paths'
import { SeriesStore } from '../series/service'
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
      'cts_budget_get',
      'Read an episode budget: the caps (0 when there is no budget.json), what is spent per currency (usd, Flow credits), what is left, and the ledger (spend.json).',
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
          ledger: s.entries
        }
      }
    ),
    def(
      'cts_image_generate',
      'Make one picture with an image provider and save it in the series folder. comfy (default/auto): local ComfyUI, free, model from config/providers.md; with refs it edits them (Qwen edit). gemini (Nano Banana, not written yet) and fal: paid, behind the episode budget (BUDGET_EXCEEDED with no approved cap; KEY_MISSING <provider> when the key is not stored: run node out/engine/index.js key-set <provider>). No image goes through Google Flow. Returns { file, costUsd, provider, model }.',
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
        model: z.string().optional(),
        seed: z.number().int().optional(),
        what: z.string().optional().describe('Text for the ledger')
      }),
      async (a) => {
        const st = store()
        assertId(a.episode, 'episode id')
        const provider = await pick(a.provider, { svc, store: st, series: a.series, episode: a.episode, what: a.what ?? a.prompt.slice(0, 60) })
        const out = place(a.series, a.out ?? `images/${provider.id}-${Date.now().toString(36)}`)
        return provider.generate({ prompt: a.prompt, size: { width: a.width, height: a.height }, format: a.format, out, ...(a.refs ? { refs: a.refs.map((r) => place(a.series, r)) } : {}), ...(a.model ? { model: a.model } : {}), ...(a.seed !== undefined ? { seed: a.seed } : {}) })
      }
    )
  ]
}
