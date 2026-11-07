import { McpHttpError, createMcpClient } from './mcp-http'
import type { McpHttpClient } from './mcp-http'

/**
 * A client of flow-music-mcp (Google Flow images, narration voices, Flow Music songs), over its MCP server. Images and the free narration
 * engines (`gemini`, `windows`) cost nothing; a Flow Music song spends credits. Cartoon Studio never sends the paid engine `flow`, video or edits.
 * Tests pass a fake `FlowClient`.
 */

/** Why a Flow call failed: `unreachable` (not running), `signedOut`, `busy`, `rateLimit` (Gemini 429), `credits` (a cap refused it), `lost` (the server restarted), `aborted`, `timeout`, `tool`. */
export type FlowErrorKind = 'unreachable' | 'signedOut' | 'busy' | 'rateLimit' | 'credits' | 'lost' | 'aborted' | 'timeout' | 'tool'

export class FlowError extends Error {
  constructor(
    message: string,
    readonly kind: FlowErrorKind
  ) {
    super(message)
    this.name = 'FlowError'
  }
}

export interface FlowStatus {
  /** flow-music-mcp answers. */
  up: boolean
  /** Signed in to Google Flow. Null when the page could not be read (a job is running, so it is presumably signed in). */
  signedIn: boolean | null
  /** Local files may be uploaded as references (`FLOW_MUSIC_MCP_UPLOAD_RIGHTS=agree`). */
  uploadRights: boolean
  hint?: string
}

export interface GeminiVoiceInfo {
  name: string
  description: string
  gender?: 'female' | 'male'
}

export interface WindowsVoiceInfo {
  name: string
  culture: string
  gender?: 'female' | 'male'
}

export interface FlowVoices {
  gemini: GeminiVoiceInfo[]
  geminiModel: string
  geminiReady: boolean
  windows: WindowsVoiceInfo[]
}

export interface FlowImageArgs {
  prompt: string
  aspect: '16:9' | '9:16' | '1:1'
  /** A model as Flow's menu shows it (`Nano Banana Pro`). Missing: Flow's newest Nano Banana. */
  model?: string
  /** `asset:<media id>` or an absolute file path, at most 3. */
  references?: string[]
  quality: 'original' | 'upscaled'
  /** The Flow project (created when missing). */
  project: string
  /** Absolute output folder and file stem. */
  out: string
  name: string
  timeoutMs: number
  signal?: AbortSignal
}

export interface FlowImage {
  /** The downloaded file. */
  file: string
  mediaId: string
  project?: string
}

export interface NarrateArgs {
  text: string
  engine: 'gemini' | 'windows'
  voice: string
  style?: string
  /** Absolute output folder and file stem. */
  out: string
  name: string
  format: 'mp3' | 'wav' | 'ogg' | 'm4a'
  signal?: AbortSignal
}

export interface SongArgs {
  sound: string
  title: string
  out: string
  name: string
  format?: 'mp3' | 'wav' | 'm4a'
  loopFriendly?: boolean
  timeoutMs: number
  signal?: AbortSignal
}

export interface FlowSong {
  id: string
  file: string
  creditsSpent?: number
}

export interface FlowLoop {
  /** The loop file: it starts at the loop point and its end is crossfaded into its start, so it repeats from its start. */
  file: string
  loopSeconds: number
  /** 1: identical around the seam, 0: 12 dB apart. */
  score: number
  seamClean: boolean
}

/** What Cartoon Studio needs from flow-music-mcp. Tests pass a fake. */
export interface FlowClient {
  readonly url: string
  status(signal?: AbortSignal): Promise<FlowStatus>
  generateImage(args: FlowImageArgs): Promise<FlowImage>
  voices(signal?: AbortSignal): Promise<FlowVoices>
  narrate(args: NarrateArgs): Promise<{ file: string; durationSec?: number }>
  song(args: SongArgs): Promise<FlowSong>
  loop(args: { input: string; out: string; name: string; minSeconds?: number; signal?: AbortSignal }): Promise<FlowLoop>
}

export interface FlowClientOptions {
  url: string
  notRunningHint: string
  /** Timeout of the short calls. Default 15 s. */
  timeoutMs?: number
  /** Seconds per `flow_wait` / `music_wait` call (at most 50). Default 40. */
  pollS?: number
  token?: string | null
  repo?: string
  fetchImpl?: typeof fetch
  mcp?: McpHttpClient
  ensureUp?: (signal?: AbortSignal) => Promise<true | string>
}

interface JobView {
  job_id?: string
  status?: string
  error?: string
  note?: string
  images?: { scene: number; file: string; media_id: string; title?: string; variant?: number }[]
  files?: string[]
  songs?: { id: string; title?: string; url?: string; file?: string }[]
  project?: { id: string; name: string }
  credits_spent?: number
  failed_scenes?: number[]
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

/** Turns a tool failure into a `FlowError` with a kind the caller can act on (and the start hint where it helps). */
export function flowError(e: unknown, o: { hint?: string; repo?: string } = {}): FlowError {
  if (e instanceof FlowError) return e
  if (e instanceof McpHttpError) {
    if (e.kind === 'unreachable') return new FlowError(e.message, 'unreachable')
    if (e.kind === 'aborted') return new FlowError('stopped', 'aborted')
    if (e.kind === 'timeout') return new FlowError(e.message, 'timeout')
    const m = e.message
    if (/not signed in|sign in to google|yarn login/i.test(m)) return new FlowError(`Google Flow is not signed in: run yarn login in ${o.repo ?? 'flow-music-mcp'}. (${m})`, 'signedOut')
    if (/rate limit|429/i.test(m)) return new FlowError(m, 'rateLimit')
    if (/max_credits|credits/i.test(m) && /refus|exceed|above|cap|quote/i.test(m)) return new FlowError(`refused by the credit cap, nothing was spent: ${m}`, 'credits')
    if (/A Flow job is running/i.test(m)) return new FlowError(m, 'busy')
    return new FlowError(m, 'tool')
  }
  return new FlowError((e as Error).message, 'tool')
}

export function createFlowClient(opts: FlowClientOptions): FlowClient {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const pollS = Math.min(50, Math.max(1, opts.pollS ?? 40))
  const mcp =
    opts.mcp ??
    createMcpClient({ url: opts.url, label: 'flow-music-mcp', notRunningHint: opts.notRunningHint, timeoutMs, fetchImpl: opts.fetchImpl, token: opts.token, tokenVar: 'FLOW_MUSIC_MCP_TOKEN', ensureUp: opts.ensureUp })
  const eo = { hint: opts.notRunningHint, repo: opts.repo }

  async function call(tool: string, args: object, ms: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      return (await mcp.callTool(tool, args, { timeoutMs: ms, signal })).json ?? {}
    } catch (e) {
      throw flowError(e, eo)
    }
  }

  /** Polls `<site>_wait` until the job leaves queued/running; on abort the job is cancelled (a running Flow Music take cannot be stopped). */
  async function waitJob(site: 'flow' | 'music', id: string, o: { timeoutMs: number; signal?: AbortSignal }): Promise<JobView> {
    const deadline = Date.now() + o.timeoutMs
    for (;;) {
      if (o.signal?.aborted) {
        await call(`${site}_cancel`, { job_id: id }, timeoutMs).catch(() => undefined)
        throw new FlowError('stopped', 'aborted')
      }
      let r: Record<string, unknown>
      try {
        r = await call(`${site}_wait`, { job_ids: [id], timeout_seconds: pollS }, (pollS + 20) * 1000, o.signal)
      } catch (e) {
        if (e instanceof FlowError && e.kind === 'aborted') {
          await call(`${site}_cancel`, { job_id: id }, timeoutMs).catch(() => undefined)
        }
        throw e
      }
      const job = ((r.jobs as JobView[] | undefined) ?? [])[0]
      if (!job) throw new FlowError(`${site}_wait did not return job ${id}`, 'tool')
      if (job.status === 'unknown') throw new FlowError('flow-music-mcp restarted and lost the job: generate again', 'lost')
      if (job.status === 'done') return job
      if (job.status === 'failed' || job.status === 'cancelled') throw flowError(new McpHttpError(`${id} ${job.status}: ${job.error ?? job.note ?? ''}`, 'tool'), eo)
      if (Date.now() >= deadline) {
        await call(`${site}_cancel`, { job_id: id }, timeoutMs).catch(() => undefined)
        throw new FlowError(`${id} did not finish within ${Math.round(o.timeoutMs / 1000)} s (still ${job.status}); it was cancelled if it had not started`, 'timeout')
      }
      await sleep(250, o.signal)
    }
  }

  return {
    url: mcp.url,

    async status(signal) {
      let r: Record<string, unknown>
      try {
        r = await call('flow_status', { detailed: false }, timeoutMs, signal)
      } catch (e) {
        if (e instanceof FlowError && e.kind === 'unreachable') return { up: false, signedIn: null, uploadRights: false, hint: e.message }
        throw e
      }
      const flow = r.flow as { signed_in?: boolean; hint?: string } | undefined
      // Chrome not running is unknown, not signed out: flow-music-mcp opens Chrome itself on the first real call (only flow_status does not).
      const signedIn = r.chrome_running === false ? null : flow ? flow.signed_in === true : null
      const hint = signedIn === false ? (flow?.hint ?? `Google Flow is not signed in: run yarn login in ${opts.repo ?? 'flow-music-mcp'}`) : undefined
      return { up: true, signedIn, uploadRights: typeof r.upload_rights === 'string' && r.upload_rights.startsWith('agree'), ...(hint ? { hint } : {}) }
    },

    async generateImage(a) {
      const started = await call(
        'flow_generate',
        {
          scenes: [
            {
              prompt: a.prompt,
              type: 'image',
              aspect_ratio: a.aspect,
              ...(a.model ? { model: a.model } : {}),
              ...(a.references?.length ? { reference_images: a.references.slice(0, 3) } : {}),
              download_quality: a.quality,
              max_credits: 0,
              retries: 1
            }
          ],
          project: a.project,
          create_project: true,
          out: a.out,
          name: a.name,
          start_number: 1,
          wait: 0
        },
        timeoutMs,
        a.signal
      )
      const first = ((started.jobs as JobView[] | undefined) ?? [])[0]
      if (!first?.job_id) throw new FlowError('flow_generate returned no job', 'tool')
      const job = first.status === 'done' ? first : await waitJob('flow', first.job_id, { timeoutMs: a.timeoutMs, signal: a.signal })
      const image = job.images?.[0]
      const file = image?.file ?? job.files?.[0]
      if (!file) throw new FlowError(`Flow made no image${job.failed_scenes?.length ? ' (the scene failed)' : ''}${job.note ? `: ${job.note}` : ''}`, 'tool')
      return { file, mediaId: image?.media_id ?? '', project: job.project?.name ?? a.project }
    },

    async voices(signal) {
      const r = await call('flow_voices', {}, timeoutMs, signal)
      return {
        gemini: ((r.gemini as GeminiVoiceInfo[] | undefined) ?? []).map((v) => ({ name: v.name, description: v.description ?? '', ...(v.gender ? { gender: v.gender } : {}) })),
        geminiModel: String(r.gemini_model ?? ''),
        geminiReady: r.gemini_ready === true,
        windows: ((r.windows as WindowsVoiceInfo[] | undefined) ?? []).map((v) => ({ name: v.name, culture: v.culture ?? '', ...(v.gender ? { gender: v.gender } : {}) }))
      }
    },

    async narrate(a) {
      // never the paid engine `flow`
      const r = await call('flow_narrate', { text: a.text, engine: a.engine, voice: a.voice, ...(a.style ? { style: a.style } : {}), out: a.out, name: a.name, format: a.format }, 120_000, a.signal)
      const file = String(r.output ?? r.file ?? '')
      if (!file) throw new FlowError('flow_narrate returned no file', 'tool')
      return { file, ...(typeof r.duration === 'number' ? { durationSec: r.duration } : {}) }
    },

    async song(a) {
      const started = await call(
        'music_generate',
        { sound: a.sound, instrumental: true, title: a.title, loop_friendly: a.loopFriendly ?? true, format: a.format ?? 'mp3', out: a.out, name: a.name, wait: 0 },
        timeoutMs,
        a.signal
      )
      const id = String(started.job_id ?? '')
      if (!id) throw new FlowError('music_generate returned no job', 'tool')
      const job = started.status === 'done' ? (started as JobView) : await waitJob('music', id, { timeoutMs: a.timeoutMs, signal: a.signal })
      const song = job.songs?.[0]
      const file = song?.file ?? job.files?.[0]
      if (!song?.id || !file) throw new FlowError('Flow Music made no song file', 'tool')
      return { id: song.id, file, ...(typeof job.credits_spent === 'number' ? { creditsSpent: job.credits_spent } : {}) }
    },

    async loop(a) {
      const r = await call('music_loop', { input: a.input, out: a.out, name: a.name, ...(a.minSeconds ? { min_seconds: a.minSeconds } : {}) }, 120_000, a.signal)
      const file = String(r.file ?? '')
      if (!file) throw new FlowError('music_loop returned no file', 'tool')
      const seam = r.seam as { clean?: boolean } | undefined
      return { file, loopSeconds: Number(r.loop_seconds ?? 0), score: Number(r.score ?? 0), seamClean: seam?.clean === true }
    }
  }
}
