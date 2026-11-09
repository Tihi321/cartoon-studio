import { McpHttpError, createMcpClient } from './mcp-http'
import type { McpHttpClient } from './mcp-http'

/**
 * A client of flow-music-mcp (Google Flow video for the intro and outro clips, narration voices, Flow Music songs), over its MCP server. No image is made
 * through Flow. The free narration engines (`gemini`, `windows`) cost nothing; a video scene and a Flow Music song spend credits. Tests pass a fake `FlowClient`.
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

/** A video scene (HUB-29 decision 12): Omni model, an 8 s clip from a keyframe, behind the Flow credit gate (`charge`) and a per-call `max_credits`. */
export interface FlowVideoArgs {
  prompt: string
  aspect: '16:9' | '9:16'
  /** A model as Flow's menu shows it (`Omni 1.1 Flash`). Missing: Flow's current video model. */
  model?: string
  duration: 4 | 6 | 8 | 10
  resolution: '360p' | '720p'
  /** The keyframe: an absolute image path or `asset:<media id>`. */
  firstFrame: string
  /** Flow refuses the scene before it starts when its live quote is above this. */
  maxCredits: number
  project: string
  out: string
  name: string
  timeoutMs: number
  signal?: AbortSignal
}

export interface FlowVideo {
  file: string
  mediaId: string
  /** The composer's quote and the balance change, when Flow reported them. */
  creditsQuote?: number
  creditsSpent?: number
}

export interface NarrateArgs {
  text: string
  /** `gemini` and `windows` are free; `elevenlabs` spends free-tier credits (flow-music-mcp refuses past the free quota and any paid tier). Never the paid `flow`. */
  engine: 'gemini' | 'windows' | 'elevenlabs'
  /** A Gemini or Windows voice name, or an ElevenLabs voiceId. */
  voice: string
  style?: string
  /** Engine elevenlabs: the model (flow-music-mcp's default `eleven_multilingual_v2`), the voice settings, the line's language, word times (default on). */
  model?: string
  voiceSettings?: { stability?: number; similarity_boost?: number; style?: number; speed?: number; use_speaker_boost?: boolean }
  language?: string
  timestamps?: boolean
  /** Absolute output folder and file stem. */
  out: string
  name: string
  format: 'mp3' | 'wav' | 'ogg' | 'm4a'
  signal?: AbortSignal
}

/** What `flow_narrate` returned. The ElevenLabs fields are set for engine `elevenlabs` only. */
export interface Narration {
  file: string
  durationSec?: number
  /** ElevenLabs: the model that spoke. */
  model?: string
  /** ElevenLabs: word times in seconds from the start of `file` (the file is loudnormed, 48 kHz stereo, not trimmed). */
  words?: { w: string; t0: number; t1: number }[]
  characters?: number
  /** ElevenLabs: the credits the line cost (characters x the model's multiplier). */
  creditsEstimate?: number
  /** ElevenLabs: the credits left after the line, when known. */
  remainingAfter?: number | null
}

/** An ElevenLabs model as `flow_elevenlabs_status` reads it: does text to speech, reads hr / en, credits per character. */
export interface ElevenModelInfo {
  id: string
  tts: boolean
  hr: boolean
  en: boolean
  multiplier: number
}

/**
 * `flow_elevenlabs_status` (FMM-17): the free-tier account. `ready: false` with `hint` (and `code` when the API refused) when there is no key,
 * the key is refused, or flow-music-mcp is not running. The key itself never appears.
 */
export interface ElevenStatus {
  ready: boolean
  /** Where the key was found: `env`, `env:ELEVEN_CREATOR_KEY` or `file` (shown as is; the key value never). */
  source?: string
  tier?: string
  used?: number
  limit?: number
  remaining?: number
  reserve?: number
  resetAt?: string | null
  paidRisk?: boolean
  models: ElevenModelInfo[]
  code?: string
  hint?: string
}

/** A voice of `flow_elevenlabs_voices`; free API users pick `category: "premade"`. */
export interface ElevenVoiceInfo {
  voiceId: string
  name: string
  category: string
  labels: { gender?: string; age?: string; accent?: string; description?: string }
}

/** The ElevenLabs error codes flow-music-mcp puts at the start of a tool error (`E_ELEVEN_QUOTA: ...`). */
export const ELEVEN_CODES = ['E_ELEVEN_KEY', 'E_ELEVEN_QUOTA', 'E_ELEVEN_PAID_TIER', 'E_ELEVEN_LANG', 'E_ELEVEN_BLOCKED', 'E_ELEVEN_MODEL', 'E_ELEVEN_API', 'E_ELEVEN_RATE'] as const
export type ElevenCode = (typeof ELEVEN_CODES)[number]
/** The ElevenLabs code in an error message, or undefined. */
export function elevenCodeOf(message: string): ElevenCode | undefined {
  const m = /\b(E_ELEVEN_(?:KEY|QUOTA|PAID_TIER|LANG|BLOCKED|MODEL|API|RATE))\b/.exec(message)
  return m ? (m[1] as ElevenCode) : undefined
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

/** What whisper.cpp heard in a file (`flow_transcribe`): the text and every word with its times in seconds. */
export interface FlowTranscript {
  text: string
  language: string
  words: { w: string; t0: number; t1: number }[]
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
  /** Optional so older fakes still type-check: a video scene (`flow_generate` `type: "video"`). The callers check it exists. */
  generateVideo?(args: FlowVideoArgs): Promise<FlowVideo>
  voices(signal?: AbortSignal): Promise<FlowVoices>
  narrate(args: NarrateArgs): Promise<Narration>
  /** Optional so older fakes still type-check (HUB-31): the ElevenLabs free-tier account (`flow_elevenlabs_status`). Never throws: down is `ready: false`. */
  elevenStatus?(signal?: AbortSignal): Promise<ElevenStatus>
  /** Optional (HUB-31): the account's ElevenLabs voices (`flow_elevenlabs_voices`). */
  elevenVoices?(signal?: AbortSignal): Promise<ElevenVoiceInfo[]>
  song(args: SongArgs): Promise<FlowSong>
  /** Optional so older fakes still type-check: whisper word times of a local audio file (`flow_transcribe`, local and free). The language is always passed (auto misdetects Croatian). */
  transcribe?(file: string, language: string, signal?: AbortSignal): Promise<FlowTranscript>
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
  credits_quote?: number
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

    async generateVideo(a) {
      const started = await call(
        'flow_generate',
        {
          scenes: [
            {
              prompt: a.prompt,
              type: 'video',
              aspect_ratio: a.aspect,
              ...(a.model ? { model: a.model } : {}),
              duration: a.duration,
              resolution: a.resolution,
              first_frame: a.firstFrame,
              max_credits: a.maxCredits,
              download_quality: 'original',
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
      const clip = job.images?.find((i) => /.(mp4|webm|mov)$/i.test(i.file)) ?? job.images?.[0]
      const file = clip?.file ?? job.files?.find((f) => /.(mp4|webm|mov)$/i.test(f)) ?? job.files?.[0]
      if (!file) throw new FlowError(`Flow made no video${job.failed_scenes?.length ? ' (the scene failed)' : ''}${job.note ? `: ${job.note}` : ''}`, 'tool')
      return { file, mediaId: clip?.media_id ?? '', ...(job.credits_quote !== undefined ? { creditsQuote: job.credits_quote } : {}), ...(job.credits_spent !== undefined ? { creditsSpent: job.credits_spent } : {}) }
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
      const eleven =
        a.engine === 'elevenlabs'
          ? { ...(a.model ? { model: a.model } : {}), ...(a.voiceSettings ? { voice_settings: a.voiceSettings } : {}), ...(a.language ? { language: a.language } : {}), timestamps: a.timestamps ?? true }
          : {}
      const r = await call('flow_narrate', { text: a.text, engine: a.engine, voice: a.voice, ...(a.style && a.engine !== 'elevenlabs' ? { style: a.style } : {}), ...eleven, out: a.out, name: a.name, format: a.format }, 120_000, a.signal)
      const file = String(r.output ?? r.file ?? '')
      if (!file) throw new FlowError('flow_narrate returned no file', 'tool')
      const dur = typeof r.durationSec === 'number' ? r.durationSec : typeof r.duration === 'number' ? r.duration : undefined
      const words = Array.isArray(r.words)
        ? (r.words as { w?: unknown; t0?: unknown; t1?: unknown }[])
            .filter((x) => typeof x.w === 'string' && typeof x.t0 === 'number' && typeof x.t1 === 'number')
            .map((x) => ({ w: x.w as string, t0: x.t0 as number, t1: x.t1 as number }))
        : undefined
      return {
        file,
        ...(dur !== undefined ? { durationSec: dur } : {}),
        ...(typeof r.model === 'string' ? { model: r.model } : {}),
        ...(words ? { words } : {}),
        ...(typeof r.characters === 'number' ? { characters: r.characters } : {}),
        ...(typeof r.credits_estimate === 'number' ? { creditsEstimate: r.credits_estimate } : {}),
        ...(a.engine === 'elevenlabs' ? { remainingAfter: typeof r.remaining_after === 'number' ? r.remaining_after : null } : {})
      }
    },

    async elevenStatus(signal) {
      let r: Record<string, unknown>
      try {
        r = await call('flow_elevenlabs_status', {}, timeoutMs, signal)
      } catch (e) {
        const msg = (e as Error).message
        return { ready: false, models: [], hint: e instanceof FlowError && e.kind === 'unreachable' ? msg : `flow_elevenlabs_status failed: ${msg.split('\n')[0]!.slice(0, 200)}` }
      }
      const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
      const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
      const models = ((r.models as Partial<ElevenModelInfo>[] | undefined) ?? [])
        .filter((m) => typeof m.id === 'string')
        .map((m) => ({ id: m.id!, tts: m.tts !== false, hr: m.hr === true, en: m.en === true, multiplier: num(m.multiplier) ?? 1 }))
      const st: ElevenStatus = { ready: r.ready === true, models }
      if (typeof r.source === 'string') st.source = r.source
      if (str(r.tier) !== undefined) st.tier = str(r.tier)
      if (num(r.used) !== undefined) st.used = num(r.used)
      if (num(r.limit) !== undefined) st.limit = num(r.limit)
      if (num(r.remaining) !== undefined) st.remaining = num(r.remaining)
      if (num(r.reserve) !== undefined) st.reserve = num(r.reserve)
      if (typeof r.resetAt === 'string' || r.resetAt === null) st.resetAt = r.resetAt
      if (typeof r.paidRisk === 'boolean') st.paidRisk = r.paidRisk
      if (str(r.code) !== undefined) st.code = str(r.code)
      if (str(r.hint) !== undefined) st.hint = str(r.hint)
      return st
    },

    async elevenVoices(signal) {
      let res: { text: string; json: Record<string, unknown> | null }
      try {
        res = await mcp.callTool('flow_elevenlabs_voices', {}, { timeoutMs, signal })
      } catch (e) {
        throw flowError(e, eo)
      }
      let list: unknown = res.json?.result
      if (!Array.isArray(list)) {
        try {
          list = JSON.parse(res.text)
        } catch {
          list = []
        }
      }
      return (Array.isArray(list) ? (list as Partial<ElevenVoiceInfo>[]) : [])
        .filter((v) => typeof v.voiceId === 'string')
        .map((v) => ({ voiceId: v.voiceId!, name: String(v.name ?? ''), category: String(v.category ?? ''), labels: { ...(v.labels ?? {}) } }))
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

    async transcribe(file, language, signal) {
      // the first call may install whisper.cpp; a long line on the big model takes a while
      const r = await call('flow_transcribe', { video: file, language, words: true }, 300_000, signal)
      const words = ((r.words as { text?: string; start?: number; end?: number }[] | undefined) ?? [])
        .filter((x) => typeof x.text === 'string' && typeof x.start === 'number' && typeof x.end === 'number')
        .map((x) => ({ w: x.text!.trim(), t0: x.start!, t1: x.end! }))
        .filter((x) => x.w.length > 0)
      return { text: String(r.text ?? ''), language: String(r.language ?? language), words }
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
