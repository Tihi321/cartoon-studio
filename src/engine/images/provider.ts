import { promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { parseMd } from '../../shared/md'
import { getStoredKey, KEYRING_SERVICE } from '../models/keys'
import type { SeriesStore } from '../series/service'
import type { CtsService } from '../service'

/**
 * The image provider slot. One interface, three providers: `comfy` (local, $0, the default), `gemini` (Nano Banana, paid, a stub until CTS-11)
 * and `fal` (paid, every call behind `charge` in `budget/spend.ts`). No image is made by Google Flow: Flow makes video only. Callers never build a provider's URL or key themselves.
 */

export const IMAGE_PROVIDERS = ['comfy', 'gemini', 'fal'] as const
export type ImageProviderId = (typeof IMAGE_PROVIDERS)[number]

export interface ImageRequest {
  prompt: string
  size: { width: number; height: number }
  /** Reference images (absolute paths). Comfy edits from them (Qwen edit). */
  refs?: string[]
  format: 'png' | 'svg'
  /** Absolute output path WITHOUT extension; the provider adds `.png` or `.svg`. */
  out: string
  /** Overrides the provider's default model (a fal endpoint id, a ComfyUI engine id). */
  model?: string
  seed?: number
  signal?: AbortSignal
}

export interface ImageResult {
  file: string
  /** USD charged (0 for comfy). */
  costUsd: number
  provider: ImageProviderId
  model: string
}

export interface ImageProvider {
  readonly id: ImageProviderId
  generate(req: ImageRequest): Promise<ImageResult>
}

/** What a provider needs besides the request. `series` and `episode` say whose budget a paid call is charged to (a series-level image: the episode that triggers it). */
export interface ImageContext {
  svc: CtsService
  store: SeriesStore
  series: string
  episode: string
  /** Free text for the ledger (`character mia ref`). */
  what: string
  /** Tests pass a fake `fetch`. */
  fetchFn?: typeof fetch
  /** Tests pass a fake key lookup. Default: this tool's own keyring entries only. */
  getKey?: (account: string) => string | undefined
}

/** `auto` is `comfy`: the free local provider. */
export async function pick(provider: ImageProviderId | 'auto', ctx: ImageContext): Promise<ImageProvider> {
  const id = provider === 'auto' ? 'comfy' : provider
  switch (id) {
    case 'comfy':
      return (await import('./comfy')).comfyProvider(ctx)
    case 'gemini':
      return (await import('./gemini')).geminiProvider(ctx)
    case 'fal':
      return (await import('./fal')).falProvider(ctx)
    default:
      throw new Error(`unknown image provider "${String(provider)}" (comfy, gemini, fal, auto)`)
  }
}

// ---- keys: only this tool's own keyring entries (never the environment, never the sibling tools' stores) ----

/** The keyring account of a paid provider. `key-set <provider>` stores the key under it. */
export const PAID_KEY_ACCOUNTS: Record<string, string> = { fal: 'FAL_API_KEY' }

export class KeyMissingError extends Error {
  readonly code = 'KEY_MISSING'
  constructor(readonly provider: string) {
    super(`KEY_MISSING ${provider}: no key in the credential store; run: node out/engine/index.js key-set ${provider}`)
    this.name = 'KeyMissingError'
  }
}

export function requireKey(provider: string, getKey: ImageContext['getKey'] = (a) => getStoredKey(a, KEYRING_SERVICE)): string {
  const account = PAID_KEY_ACCOUNTS[provider]
  const key = account ? getKey(account) : undefined
  if (!key) throw new KeyMissingError(provider)
  return key
}

// ---- prices ----

const priceRow = z.object({ provider: z.string(), model: z.string(), format: z.enum(['png', 'svg']), usd: z.number().nonnegative(), note: z.string().optional() })

/** USD per image from `config/prices.md`. Throws `PRICE_UNKNOWN` for a model that is not listed (the call is not made). */
export async function priceOf(dataDir: string, provider: string, model: string, format: 'png' | 'svg'): Promise<number> {
  let text: string
  try {
    text = await fs.readFile(path.join(dataDir, 'config', 'prices.md'), 'utf8')
  } catch {
    throw new Error(`PRICE_UNKNOWN ${provider}/${model}: config/prices.md is missing`)
  }
  const rows = z.array(priceRow).parse(parseMd(text, 'prices.md').data.images ?? [])
  const row = rows.find((r) => r.provider === provider && r.model === model && r.format === format)
  if (!row) throw new Error(`PRICE_UNKNOWN ${provider}/${model} (${format}): add a row to config/prices.md (check the vendor's price first)`)
  return row.usd
}

/** Writes bytes to `<stem>.<ext>` (creating folders) and returns the path. */
export async function saveBytes(stem: string, ext: string, bytes: Buffer): Promise<string> {
  const file = `${stem}.${ext}`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, bytes)
  return file
}
