import path from 'node:path'
import { z } from 'zod'
import { readMd } from '../store/atomic'
import type { StoredKeyGetter } from '../models/keys'
import { createFlowClient } from './flow'
import type { FlowClient } from './flow'
import { createChiptuneClient } from './chiptune'
import type { ChiptuneClient } from './chiptune'
import { resolveToken } from './mcp-http'
import { DEFAULT_VIBETTS_URL, createVibeTtsClient } from './vibetts'
import type { VibeTtsClient } from './vibetts'

export type StudioId = 'chiptune'

export const DEFAULT_CHIPTUNE_STUDIO_URL = 'http://127.0.0.1:7458/mcp'
export const DEFAULT_FLOW_URL = 'http://127.0.0.1:7462/mcp'
export { DEFAULT_VIBETTS_URL } from './vibetts'

/** `config/studios.md`: where Chiptune Studio, flow-music-mcp and VibeTTS are, and where their code is (for the start hints). */
export const studiosConfigSchema = z.object({
  chiptuneStudioUrl: z.string().default(DEFAULT_CHIPTUNE_STUDIO_URL),
  chiptuneStudioRepo: z.string().default('../midi-generator'),
  /** A packaged app to launch instead of `yarn electron .` from the repo. Empty: use the repo. */
  chiptuneStudioExe: z.string().default(''),
  /** Bearer token of Chiptune Studio's MCP server. `CHIPTUNE_STUDIO_MCP_TOKEN` (environment or credential store) wins over this. */
  chiptuneStudioToken: z.string().default(''),
  /** flow-music-mcp (Google Flow images and voices, Flow Music songs). `CTS_FLOW_URL` overrides the URL. */
  flowUrl: z.string().default(DEFAULT_FLOW_URL),
  flowRepo: z.string().default('../flow-music-mcp'),
  /** The bearer token of flow-music-mcp. `FLOW_MUSIC_MCP_TOKEN` (environment or credential store) wins over this. */
  flowToken: z.string().default(''),
  /** VibeTTS (local text-to-speech: Kokoro, Supertonic, Higgs). `CTS_VIBETTS_URL` overrides the URL. Cartoon Studio never starts it (a tray app). */
  vibettsUrl: z.string().default(DEFAULT_VIBETTS_URL),
  /** The bearer token of its MCP server, only when it has one. `VIBETTS_MCP_TOKEN` (environment or credential store) wins over this. */
  vibettsToken: z.string().default(''),
  /** Seconds per `flow_wait` / `music_wait` call (the server allows at most 50). */
  flowPollS: z.number().min(1).max(50).default(40),
  /** Give up on one Flow image job / one Flow Music song after this many seconds. */
  flowJobTimeoutS: z.number().positive().default(900),
  flowMusicTimeoutS: z.number().positive().default(600),
  /** Download size per image kind: `upscaled` is the 2K image, `original` 1K (1376x768 at 16:9, below 1920x1080). */
  flowImageQuality: z
    .object({
      background: z.enum(['original', 'upscaled']).default('upscaled'),
      cover: z.enum(['original', 'upscaled']).default('upscaled'),
      cg: z.enum(['original', 'upscaled']).default('upscaled'),
      sheet: z.enum(['original', 'upscaled']).default('original'),
      sprite: z.enum(['original', 'upscaled']).default('original'),
      insert: z.enum(['original', 'upscaled']).default('original')
    })
    .default({ background: 'upscaled', cover: 'upscaled', cg: 'upscaled', sheet: 'original', sprite: 'original', insert: 'original' }),
  /** Pause between two `flow_narrate` calls (ms), and how often a clip is retried on a rate limit (backoff 10 s, 30 s, 90 s). */
  flowVoicePauseMs: z.number().int().min(0).default(1500),
  flowVoiceRetries: z.number().int().min(0).max(6).default(3),
  /** The most songs one project may make through Flow Music (counted from its asset versions): Flow Music spends credits. */
  flowMusicMaxSongs: z.number().int().min(0).default(4),
  /** Timeouts in seconds: short calls, an image import and export, a track render. */
  timeoutS: z.number().positive().default(15),
  importTimeoutS: z.number().positive().default(120),
  renderTimeoutS: z.number().positive().default(300),
})
export type StudiosConfig = z.infer<typeof studiosConfigSchema>

/** `config/studios.md`; a missing or broken file gives the defaults. `CTS_CHIPTUNE_STUDIO_URL`, `CTS_FLOW_URL` and `CTS_VIBETTS_URL` override the URLs. */
export async function loadStudiosConfig(dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<StudiosConfig> {
  let data: Record<string, unknown> = {}
  try {
    data = (await readMd(path.join(dataDir, 'config', 'studios.md'))).data
  } catch {
    /* defaults */
  }
  const parsed = studiosConfigSchema.safeParse(data)
  const c = parsed.success ? parsed.data : studiosConfigSchema.parse({})
  return {
    ...c,
    ...(env.CTS_CHIPTUNE_STUDIO_URL ? { chiptuneStudioUrl: env.CTS_CHIPTUNE_STUDIO_URL } : {}),
    ...(env.CTS_FLOW_URL ? { flowUrl: env.CTS_FLOW_URL } : {}),
    ...(env.CTS_VIBETTS_URL ? { vibettsUrl: env.CTS_VIBETTS_URL } : {})
  }
}

export const STUDIO_NAMES: Record<StudioId, string> = { chiptune: 'Chiptune Studio' }

export const studioUrl = (c: StudiosConfig, _id: StudioId): string => c.chiptuneStudioUrl
export const studioRepo = (c: StudiosConfig, _id: StudioId): string => c.chiptuneStudioRepo
export const studioExe = (c: StudiosConfig, _id: StudioId): string => c.chiptuneStudioExe

/** How to start the studio headless (the text of the "not running" error). */
export function startHint(c: StudiosConfig, id: StudioId): string {
  const exe = studioExe(c, id)
  const how = exe ? `${exe} --mcp-only` : `cd ${studioRepo(c, id)} && yarn build && yarn mcp`
  return `${STUDIO_NAMES[id]} is not running at ${studioUrl(c, id)}. Start it headless: ${how}`
}

/** The bearer token of a studio: its environment variable, the credential store, then the field in config/studios.md. Null when none is set. */
export function studioToken(c: StudiosConfig, _id: StudioId, env: NodeJS.ProcessEnv = process.env, getKey?: StoredKeyGetter): string | null {
  return resolveToken('CHIPTUNE_STUDIO_MCP_TOKEN', c.chiptuneStudioToken, env, getKey)
}

export interface ClientHooks {
  /** Starts the studio when a call finds nothing at its URL (`ServiceStarter.ensure`). Only job paths pass it. */
  ensureUp?: (signal?: AbortSignal) => Promise<true | string>
}

export function chiptuneClientFor(c: StudiosConfig, o: ClientHooks = {}): ChiptuneClient {
  return createChiptuneClient({ url: c.chiptuneStudioUrl, token: studioToken(c, 'chiptune'), notRunningHint: startHint(c, 'chiptune'), ensureUp: o.ensureUp, timeoutMs: c.timeoutS * 1000, renderTimeoutMs: c.renderTimeoutS * 1000 })
}

/** How to start flow-music-mcp (the text of the "not running" and "not signed in" errors). */
export function flowStartHint(c: StudiosConfig): string {
  return `flow-music-mcp is not running at ${c.flowUrl}. Start it: hub.ps1 start flow-music-mcp (or cd ${c.flowRepo} && yarn build && yarn mcp). Google Flow must be signed in: yarn login in ${c.flowRepo}.`
}

export const flowToken = (c: StudiosConfig, env: NodeJS.ProcessEnv = process.env, getKey?: StoredKeyGetter): string | null => resolveToken('FLOW_MUSIC_MCP_TOKEN', c.flowToken, env, getKey)

/** How to start VibeTTS (the text of its "not running" error): it is a tray app, started by hand. */
export function vibettsStartHint(c: StudiosConfig): string {
  return `VibeTTS is not running at ${c.vibettsUrl}. Start the VibeTTS app (it sits in the tray) and turn its MCP server on; Cartoon Studio never starts it.`
}

/** The VibeTTS client. No `ensureUp`: Cartoon Studio never starts VibeTTS. */
export function vibettsClientFor(c: StudiosConfig): VibeTtsClient {
  return createVibeTtsClient({ url: c.vibettsUrl, token: resolveToken('VIBETTS_MCP_TOKEN', c.vibettsToken), notRunningHint: vibettsStartHint(c), timeoutMs: c.timeoutS * 1000 })
}

export function flowClientFor(c: StudiosConfig, o: ClientHooks = {}): FlowClient {
  return createFlowClient({
    url: c.flowUrl,
    token: flowToken(c),
    notRunningHint: flowStartHint(c),
    ensureUp: o.ensureUp,
    timeoutMs: c.timeoutS * 1000,
    pollS: c.flowPollS,
    repo: c.flowRepo
  })
}
