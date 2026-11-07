import { createMcpClient } from './mcp-http'
import type { McpHttpClient, McpToolInfo } from './mcp-http'
import { StudioError, asStudioError } from './chiptune'

/**
 * A client of VibeTTS, the user's local text-to-speech tray app (Kokoro, Supertonic, Higgs), over its MCP server (`http://127.0.0.1:7723/mcp`).
 * Cartoon Studio uses `list_voices` (which languages and voices there are), `synthesize_batch` (many short clips in one call: preferred) and
 * `synthesize_to_file`. VibeTTS is a tray app: **Cartoon Studio never starts it** (it is not in the auto-start list); when it is down the voice step
 * goes on with another provider. Tests pass a fake `VibeTtsClient`.
 */

export const DEFAULT_VIBETTS_URL = 'http://127.0.0.1:7723/mcp'

export interface VibeVoice {
  /** `am_michael`, `af_heart` (Kokoro), `supertonic:F1`, `higgs:F1`. */
  id: string
  label: string
  engine: string
  /** The language codes it reads. */
  languages: string[]
}

/** What `list_voices` answers, in the shape Cartoon Studio uses. */
export interface VibeVoices {
  voices: VibeVoice[]
  languages: { code: string; name: string }[]
  /** The voice each language is configured to use in VibeTTS (an empty string: none). */
  languageVoices: Record<string, string>
  readLanguage: string
  supertonicInstalled: boolean
  higgsInstalled: boolean
}

export interface VibeItem {
  text: string
  /** Absolute path; its folder must exist. The extension says the format (`.wav` or `.mp3`). */
  output: string
  lang?: string
  voice?: string
  speed?: number
}

export interface VibeResult {
  output: string
  durationS?: number
  ok: boolean
  error?: string
}

export interface VibeTtsClient {
  readonly url: string
  listVoices(signal?: AbortSignal): Promise<VibeVoices>
  /** One call for many clips: one result per item, in order. A clip that failed has `ok: false`; the call itself throws only when VibeTTS is down. */
  synthesizeBatch(items: VibeItem[], o?: { overwrite?: boolean; signal?: AbortSignal }): Promise<VibeResult[]>
  synthesizeToFile(item: VibeItem & { format?: 'wav' | 'mp3'; overwrite?: boolean }, signal?: AbortSignal): Promise<VibeResult>
  listTools(signal?: AbortSignal): Promise<McpToolInfo[]>
}

export interface VibeTtsClientOptions {
  url: string
  notRunningHint: string
  timeoutMs?: number
  /** One batch may take a while (a long list of clips on a CPU engine). Default 600 s. */
  batchTimeoutMs?: number
  fetchImpl?: typeof fetch
  mcp?: McpHttpClient
  token?: string | null
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** The `list_voices` answer as `VibeVoices` (missing fields get safe defaults, so an older VibeTTS still works). */
export function parseVibeVoices(json: Record<string, unknown> | null): VibeVoices {
  if (!json || !Array.isArray(json.voices)) throw new StudioError('VibeTTS: list_voices did not return "voices"', 'contract')
  return {
    voices: json.voices.map((v) => {
      const o = obj(v)
      return { id: str(o.id), label: str(o.label) || str(o.id), engine: str(o.engine), languages: Array.isArray(o.languages) ? o.languages.filter((l): l is string => typeof l === 'string') : [] }
    }).filter((v) => v.id),
    languages: Array.isArray(json.languages) ? json.languages.map((l) => ({ code: str(obj(l).code), name: str(obj(l).name) })).filter((l) => l.code) : [],
    languageVoices: Object.fromEntries(Object.entries(obj(json.language_voices)).map(([k, v]) => [k, str(v)])),
    readLanguage: str(json.read_language) || 'auto',
    supertonicInstalled: json.supertonic_installed === true,
    higgsInstalled: json.higgs_installed === true
  }
}

const parseResult = (r: unknown, fallbackOutput: string): VibeResult => {
  const o = obj(r)
  const ok = o.ok === true
  return { output: str(o.output) || fallbackOutput, ...(typeof o.duration_s === 'number' ? { durationS: o.duration_s } : {}), ok, ...(ok ? {} : { error: str(o.error) || 'VibeTTS gave no reason' }) }
}

/** The per-clip results of `synthesize_batch`: an object with `results` (or `items`), or the whole answer as a JSON array in the text. */
function batchResults(json: Record<string, unknown> | null, text: string): unknown[] | null {
  if (json) {
    if (Array.isArray(json.results)) return json.results
    if (Array.isArray(json.items)) return json.items
  }
  for (const part of text.split('\n').reverse()) {
    try {
      const v: unknown = JSON.parse(part)
      if (Array.isArray(v)) return v
    } catch {
      /* not JSON */
    }
  }
  try {
    const v: unknown = JSON.parse(text)
    return Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

export function createVibeTtsClient(opts: VibeTtsClientOptions): VibeTtsClient {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const batchMs = opts.batchTimeoutMs ?? 600_000
  const mcp = opts.mcp ?? createMcpClient({ url: opts.url, label: 'VibeTTS', notRunningHint: opts.notRunningHint, timeoutMs, fetchImpl: opts.fetchImpl, token: opts.token, tokenVar: 'VIBETTS_MCP_TOKEN' })
  const call = (tool: string, args: object, ms: number, signal?: AbortSignal) => asStudioError(() => mcp.callTool(tool, args, { timeoutMs: ms, signal }))
  return {
    url: mcp.url,
    listVoices: async (signal) => parseVibeVoices((await call('list_voices', {}, timeoutMs, signal)).json),
    async synthesizeBatch(items, o = {}) {
      if (items.length === 0) return []
      const r = await call('synthesize_batch', { items, ...(o.overwrite !== undefined ? { overwrite: o.overwrite } : {}) }, batchMs, o.signal)
      const results = batchResults(r.json, r.text)
      if (!results || results.length < items.length) throw new StudioError('VibeTTS: synthesize_batch did not return a result for each clip', 'contract')
      return items.map((it, i) => parseResult(results[i], it.output))
    },
    async synthesizeToFile(item, signal) {
      const json = (await call('synthesize_to_file', { ...item }, batchMs, signal)).json
      return parseResult({ ok: true, ...(json ?? {}) }, item.output)
    },
    listTools: (signal) => asStudioError(() => mcp.listTools({ timeoutMs, signal }))
  }
}
