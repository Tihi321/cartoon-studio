import { promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { readMd } from '../store/atomic'
import { fillWorkflow, loadCustomWorkflow, workflowDirs, workflowKind } from './custom-workflow'
import {
  ENGINES,
  INIT_BUILDERS,
  mergeFiles,
  randomSeed,
  sizeOf,
  snap16,
  type BuildOpts,
  type EngineDef,
  type EngineKind,
  type Graph
} from './graphs'
import { engineLanguageList, engineLanguageValue, engineReadsLanguage } from './tts-engines'

/**
 * ComfyUI client, ported from dsh-comfyui `lib/comfy.js`.
 *
 * Design rules:
 *   - a lane that cannot be reached counts as BUSY, never as free;
 *   - a job that finishes with no outputs is a FAILURE, not an empty success;
 *   - every call has a deadline, so a wedged ComfyUI cannot hang a job forever.
 *
 * Unlike DSH, the output bytes and extension are returned; the caller saves them into the project's asset folders.
 */

export const REQUEST_TIMEOUT_MS = 30_000
export const DEFAULT_LANE = 'http://127.0.0.1:8188'

// ---- config (config/comfy.md frontmatter) ----

export const comfyConfigSchema = z.object({
  lanes: z.array(z.string()).default([DEFAULT_LANE]),
  queuePolicy: z.enum(['refuse', 'wait']).default('wait'),
  requestTimeoutMs: z.number().int().positive().default(REQUEST_TIMEOUT_MS),
  jobTimeoutMs: z.number().int().positive().default(1_800_000),
  pollIntervalMs: z.number().int().positive().default(4000),
  /** How long ComfyUI may stay unreachable while a job waits before the job fails. */
  unreachableTimeoutMs: z.number().int().positive().default(300_000),
  freeBeforeDispatch: z.boolean().default(false),
  /** Engines offered by the app; empty means all. */
  enabledEngines: z.array(z.string()).default([]),
  audioFormat: z.enum(['flac', 'mp3', 'opus', 'wav']).default('mp3'),
  /** Background-removal model file (from `models/background_removal`); empty picks the first one ComfyUI lists. */
  backgroundRemovalModel: z.string().default(''),
  /** Model file overrides per group: `{ zImage: { unet: '...' } }`. */
  files: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  /** Per-engine sampler overrides: `{ 'z-image-turbo': { steps: 9 } }`. */
  engineSettings: z.record(z.string(), z.record(z.string(), z.unknown())).default({})
})
export type ComfyConfig = z.output<typeof comfyConfigSchema>

export function parseComfyConfig(data: unknown): ComfyConfig {
  return comfyConfigSchema.parse(data ?? {})
}

/** Reads `config/comfy.md`; a missing file gives the defaults. */
export async function loadComfyConfig(file: string): Promise<ComfyConfig> {
  try {
    return parseComfyConfig((await readMd(file)).data)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return parseComfyConfig({})
    throw e
  }
}

// ---- lanes and HTTP ----

function normaliseLane(lane: unknown): string {
  return String(lane ?? '').trim().replace(/\/+$/, '')
}

/** Every configured lane, trimmed and de-duplicated, in priority order. */
export function lanesOf(config: { lanes?: string[] } | undefined): string[] {
  const raw = Array.isArray(config?.lanes) && config.lanes.length > 0 ? config.lanes : [DEFAULT_LANE]
  const seen = new Set<string>()
  const lanes: string[] = []
  for (const lane of raw) {
    const url = normaliseLane(lane)
    if (url.length === 0 || seen.has(url)) continue
    seen.add(url)
    lanes.push(url)
  }
  return lanes.length > 0 ? lanes : [DEFAULT_LANE]
}

interface FetchOpts extends RequestInit {
  timeoutMs?: number
}

/** `fetch` with a deadline and a message that says which lane failed. */
export async function fetchWithDeadline(url: string, { timeoutMs = REQUEST_TIMEOUT_MS, ...init }: FetchOpts = {}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    const err = error as { name?: string; code?: string; cause?: { code?: string }; message?: string }
    if (err?.name === 'AbortError') throw new Error(`timed out after ${timeoutMs}ms: ${url}`, { cause: error })
    if (err?.cause?.code === 'ECONNREFUSED' || err?.code === 'ECONNREFUSED') {
      throw new Error(`ComfyUI unreachable at ${url} (connection refused)`, { cause: error })
    }
    throw new Error(`${url} failed: ${err?.message ?? String(error)}`, { cause: error })
  } finally {
    clearTimeout(timer)
  }
}

/** JSON request with a useful error body, not just an HTTP code. */
export async function fetchJson<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T> {
  const response = await fetchWithDeadline(url, opts)
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as { error?: unknown; node_errors?: unknown }
      const errors = body?.error ?? body?.node_errors
      if (errors !== undefined) detail = typeof errors === 'string' ? errors : JSON.stringify(errors).slice(0, 2000)
    } catch {
      /* keep the status line */
    }
    throw new Error(`ComfyUI ${opts.method ?? 'GET'} ${url} failed: ${detail}`)
  }
  return (await response.json()) as T
}

/** `{ running, pending }` for one lane. Throws when the lane is unreachable. */
export async function queueState(lane: string, timeoutMs = 8000): Promise<{ running: number; pending: number }> {
  const state = await fetchJson<{ queue_running?: unknown[]; queue_pending?: unknown[] }>(`${lane}/queue`, { timeoutMs })
  return { running: state?.queue_running?.length ?? 0, pending: state?.queue_pending?.length ?? 0 }
}

/** A lane is busy when it is unreachable, running, or holding a queue. */
export async function laneBusy(lane: string, timeoutMs = 8000): Promise<boolean> {
  try {
    const s = await queueState(lane, timeoutMs)
    return s.running + s.pending > 0
  } catch {
    return true
  }
}

/** Chooses a free lane: `{ lane }`, or `{ busy: [reasons] }` when none is free. */
export async function pickLane(config: { lanes?: string[]; requestTimeoutMs?: number }): Promise<{ lane?: string; busy: string[] }> {
  const reasons: string[] = []
  for (const lane of lanesOf(config)) {
    try {
      const state = await queueState(lane, Number(config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS) / 4 || 8000)
      if (state.running + state.pending === 0) return { lane, busy: [] }
      reasons.push(`${lane} is busy (${state.running} running, ${state.pending} queued)`)
    } catch (error) {
      reasons.push(`${lane} is unreachable (${(error as Error).message})`)
    }
  }
  return { busy: reasons }
}

/** The first lane that answers at all, busy or not: for the `wait` policy, where ComfyUI's own queue holds the job. */
export async function firstReachableLane(config: { lanes?: string[] }): Promise<string | null> {
  for (const lane of lanesOf(config)) {
    try {
      await queueState(lane, 8000)
      return lane
    } catch {
      /* try the next lane */
    }
  }
  return null
}

/** Asks ComfyUI to drop cached models and free VRAM (weights stay on disk). */
export async function freeMemory(lane: string, timeoutMs = 30_000): Promise<unknown> {
  return fetchJson(`${lane}/free`, {
    method: 'POST',
    timeoutMs,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ unload_models: true, free_memory: true })
  })
}

/** Model files ComfyUI can see in one folder. */
export async function listModelFiles(lane: string, folder: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<string[]> {
  const files = await fetchJson<unknown>(`${lane}/models/${encodeURIComponent(folder)}`, { timeoutMs })
  return Array.isArray(files) ? (files as string[]) : []
}

export type ObjectInfo = Record<string, { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> }; output?: unknown[] }>

/** The node catalog: tells "not installed" from "wrong filename". */
export async function objectInfo(lane: string, timeoutMs = 60_000): Promise<ObjectInfo> {
  return fetchJson<ObjectInfo>(`${lane}/object_info`, { timeoutMs })
}

export interface UploadedImage {
  filename: string
  name: string
  subfolder: string
  type: string
}

/** Uploads one image (or audio) into ComfyUI's input folder; `source` is a file path or bytes. Returns what LoadImage/LoadAudio expect. */
export async function uploadImage(
  lane: string,
  source: string | Buffer,
  { timeoutMs = 120_000, subfolder = '', name }: { timeoutMs?: number; subfolder?: string; name?: string } = {}
): Promise<UploadedImage> {
  const bytes = typeof source === 'string' ? await fs.readFile(source) : source
  const fileName = name ?? (typeof source === 'string' ? path.basename(source) : `cts_${Date.now().toString(36)}.png`)
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(bytes)]), fileName)
  form.append('overwrite', 'true')
  if (subfolder) form.append('subfolder', subfolder)
  const response = await fetchWithDeadline(`${lane}/upload/image`, { method: 'POST', body: form, timeoutMs })
  if (!response.ok) throw new Error(`upload to ${lane} failed: HTTP ${response.status}`)
  const body = (await response.json()) as { name?: string; subfolder?: string; type?: string }
  if (!body?.name) throw new Error(`upload to ${lane} returned no filename: ${JSON.stringify(body)}`)
  return {
    filename: body.subfolder ? `${body.subfolder}/${body.name}` : body.name,
    name: body.name,
    subfolder: body.subfolder ?? '',
    type: body.type ?? 'input'
  }
}

/** Queues a graph; resolves with the prompt id. */
export async function postPrompt(lane: string, graph: Graph, { clientId = 'cartoon-studio', timeoutMs = REQUEST_TIMEOUT_MS } = {}): Promise<string> {
  const body = await fetchJson<{ prompt_id?: string }>(`${lane}/prompt`, {
    method: 'POST',
    timeoutMs,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: clientId })
  })
  if (!body?.prompt_id) throw new Error(`ComfyUI accepted the prompt but returned no prompt_id: ${JSON.stringify(body)}`)
  return body.prompt_id
}

export type ComfyOutputs = Record<string, { images?: OutputItem[]; audio?: OutputItem[] } | undefined>

export interface WaitOptions {
  timeoutMs: number
  pollMs?: number
  /** Fail when ComfyUI has not answered for this long (default 5 minutes). */
  unreachableMs?: number
  signal?: AbortSignal
  onPoll?: (info: { status: string; elapsedMs: number }) => void
}

/** ComfyUI answers but knows nothing of the prompt: it is neither queued, running nor in the history (e.g. after a crash and restart). */
export class LostPromptError extends Error {
  constructor(readonly promptId: string) {
    super(`ComfyUI lost job ${promptId}: it is not in the queue or the history (ComfyUI probably crashed and restarted)`)
    this.name = 'LostPromptError'
  }
}

/**
 * Polls `/history/<id>` until the job reports outputs. A job that errored, was interrupted, or finished with no
 * outputs throws: a silent empty result is the failure mode this client exists to avoid.
 */
export async function waitForOutputs(lane: string, promptId: string, { timeoutMs, pollMs = 4000, unreachableMs = 300_000, signal, onPoll }: WaitOptions): Promise<ComfyOutputs> {
  const started = Date.now()
  const deadline = started + timeoutMs
  let lastStatus = ''
  let downSince = 0 // when ComfyUI first stopped answering, 0 while it answers
  type History = Record<string, { status?: { status_str?: string; messages?: unknown[] }; outputs?: ComfyOutputs } | undefined>
  const unreachable = () => {
    downSince ||= Date.now()
    if (Date.now() - downSince > unreachableMs) {
      throw new Error(`ComfyUI at ${lane} has not answered for ${Math.round((Date.now() - downSince) / 1000)}s while waiting for job ${promptId}; giving up`)
    }
  }
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error(`ComfyUI job ${promptId} cancelled`)
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    let history: History
    try {
      history = await fetchJson(`${lane}/history/${promptId}`, { timeoutMs: 15000 })
      downSince = 0
    } catch {
      unreachable() // a transient poll failure is not a job failure, a long outage is
      continue
    }
    let entry = history?.[promptId]
    if (!entry) {
      // Not in the history: it is queued or running, or ComfyUI crashed and restarted and forgot it.
      let inQueue: boolean
      try {
        const q = await fetchJson<{ queue_running?: unknown[][]; queue_pending?: unknown[][] }>(`${lane}/queue`, { timeoutMs: 15000 })
        inQueue = [...(q?.queue_running ?? []), ...(q?.queue_pending ?? [])].some((item) => Array.isArray(item) && item[1] === promptId)
      } catch {
        unreachable()
        continue
      }
      if (!inQueue) {
        // It may have finished between the two calls: look at the history once more before calling it lost.
        try {
          entry = ((await fetchJson(`${lane}/history/${promptId}`, { timeoutMs: 15000 })) as History)?.[promptId]
        } catch {
          unreachable()
          continue
        }
        if (!entry) throw new LostPromptError(promptId)
      }
    }
    if (!entry) {
      onPoll?.({ status: 'queued', elapsedMs: Date.now() - started })
      continue
    }
    const status = entry.status?.status_str
    if (status) lastStatus = status
    onPoll?.({ status: status ?? 'running', elapsedMs: Date.now() - started })
    if (status === 'error') {
      const messages = entry.status?.messages ?? []
      const details: string[] = []
      for (const pair of messages) {
        const [kind, payload] = (pair ?? []) as [string, Record<string, string> | undefined]
        if (kind === 'execution_error') {
          details.push(payload?.exception_message ?? payload?.exception_type ?? 'execution error')
          if (payload?.node_type) details.push(`at node ${payload.node_id} (${payload.node_type})`)
        } else if (kind === 'execution_interrupted') {
          details.push(`interrupted at node ${payload?.node_id} (${payload?.node_type}): something stopped it, e.g. the Interrupt button in the ComfyUI window`)
        }
      }
      if (details.length === 0) details.push(`status "error" with no detail; messages: ${JSON.stringify(messages).slice(0, 400)}`)
      throw new Error(`ComfyUI job ${promptId} failed: ${details.join(' ')}`)
    }
    const outputs = entry.outputs
    if (outputs && Object.keys(outputs).length > 0) return outputs
  }
  throw new Error(`ComfyUI job ${promptId} did not finish within ${Math.round(timeoutMs / 1000)}s${lastStatus ? ` (last status: ${lastStatus})` : ''}`)
}

export interface OutputItem {
  filename: string
  subfolder?: string
  type?: string
}

/** Flattens outputs into the media entries they carry, in node order. `preferNode` restricts to one node when it has output. */
export function collectOutputs(outputs: ComfyOutputs | undefined, preferNode?: string): { images: OutputItem[]; audio: OutputItem[] } {
  const pick = (entries: Array<[string, NonNullable<ComfyOutputs[string]>]>) => {
    const images: OutputItem[] = []
    const audio: OutputItem[] = []
    for (const [, out] of entries) {
      for (const item of out.images ?? []) if (item?.filename) images.push(item)
      for (const item of out.audio ?? []) if (item?.filename) audio.push(item)
    }
    return { images, audio }
  }
  const all = Object.entries(outputs ?? {}).filter((e): e is [string, NonNullable<ComfyOutputs[string]>] => !!e[1])
  if (preferNode) {
    const own = pick(all.filter(([id]) => id === preferNode))
    if (own.images.length + own.audio.length > 0) return own
  }
  return pick(all)
}

/** Downloads one output file's bytes through `/view`. */
export async function downloadOutput(lane: string, item: OutputItem, timeoutMs = 120_000): Promise<Buffer> {
  const params = new URLSearchParams({ filename: item.filename, subfolder: item.subfolder ?? '', type: item.type ?? 'output' })
  const response = await fetchWithDeadline(`${lane}/view?${params}`, { timeoutMs })
  if (!response.ok) throw new Error(`ComfyUI /view failed: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

// ---- engine runs ----

export interface ComfyProgress {
  stage: 'lane' | 'upload' | 'queued' | 'running' | 'download'
  message: string
}

export interface ComfyRequest {
  /** A built-in engine id (`z-image-turbo`) or `custom:<workflow name>`. */
  engine: string
  prompt?: string
  negative?: string
  /** Explicit size, snapped to a multiple of 16. */
  width?: number
  height?: number
  seed?: number
  steps?: number
  cfg?: number
  /** Edit engines and custom workflows with a `reference` mapping: file paths or image bytes (uploaded first). */
  references?: Array<string | Buffer>
  /**
   * Image-to-image on a Z-Image engine: the start picture (file path or bytes, uploaded first) and how far the sampler may drift from it (denoise above 0, at most 1).
   * With `mask` (white = redraw, the init picture's size) only the masked region is redrawn (inpaint).
   */
  init?: { image: string | Buffer; denoise: number; mask?: string | Buffer }
  /** Music engines. */
  seconds?: number
  format?: 'flac' | 'mp3' | 'opus' | 'wav'
  lyrics?: string
  /** TTS and SFX: what the voice says (TTS) or the sound effect is (SFX). */
  text?: string
  /** The project's language code (`en`, `hr`). */
  language?: string
  /** The value the engine's language input takes, when the caller already mapped it (`English`, `F5-DE`, ...). */
  languageName?: string
  /** The delivery style: the `instruct` input of OmniVoice/Qwen3, or inline tags for Higgs Audio v3. */
  instruct?: string
  /** The transcript of the voice reference clip. */
  voiceRefText?: string
  /** The voice reference clip of the speaker: a file path or its bytes (uploaded first). */
  voiceRef?: string | Buffer
  /** `UnifiedTTSTextNode.max_chars_per_chunk` (`config/voice.md`). */
  chunkChars?: number
  /** The speed multiplier of the engines that take one (`config/voice.md`). */
  speed?: number
  filenamePrefix?: string
  onProgress?: (p: ComfyProgress) => void
  signal?: AbortSignal
}

export interface ComfyResult {
  bytes: Buffer
  /** Lower-case, without the dot: `png`, `mp3`, `flac`. */
  ext: string
  kind: EngineKind
  seed: number
  engine: string
  lane: string
  promptId: string
}

/** What asset generation needs from ComfyUI. Tests pass a fake. */
export interface ComfyClient {
  generate(req: ComfyRequest): Promise<ComfyResult>
}

export interface ComfyClientOptions {
  config: ComfyConfig
  /** The data folder: custom workflows are read from `<dataDir>/config/workflows` and `<dataDir>/workflows`. */
  dataDir?: string
  /** Overrides the workflow folders. */
  workflowDirs?: string[]
  /**
   * Starts the service of a lane when no lane answers at all (never when a lane answers but is busy): `true` when it answers now, else the
   * reason it does not. Only job paths pass it.
   */
  ensureLane?: (lane: string, signal?: AbortSignal) => Promise<true | string>
}

export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp'])

function extOf(filename: string, kind: EngineKind): string {
  const ext = path.extname(filename).slice(1).toLowerCase()
  return ext || (kind === 'image' ? 'png' : 'bin')
}

/** The ids of the engines the app offers (registry order); `enabledEngines` filters when set. */
export function availableEngines(config: ComfyConfig): string[] {
  const all = Object.keys(ENGINES)
  return config.enabledEngines.length > 0 ? all.filter((id) => config.enabledEngines.includes(id)) : all
}

export function createComfyClient(opts: ComfyClientOptions): ComfyClient {
  const { config } = opts
  const files = mergeFiles(config.files as never)
  const dirs = opts.workflowDirs ?? (opts.dataDir ? workflowDirs(opts.dataDir) : [])
  let infoCache: ObjectInfo | null = null

  /** Asks `ensureLane` to start each lane in turn; true when one answers now. The reasons are collected in `why`. */
  async function startLanes(why: string[], signal?: AbortSignal): Promise<boolean> {
    if (!opts.ensureLane) return false
    for (const lane of lanesOf(config)) {
      const r = await opts.ensureLane(lane, signal)
      if (r === true) return true
      why.push(`auto-start ${lane}: ${r}`)
    }
    return false
  }

  async function chooseLane(signal?: AbortSignal): Promise<string> {
    const lanes = lanesOf(config)
    if (config.freeBeforeDispatch) for (const lane of lanes) await freeMemory(lane).catch(() => undefined)
    let { lane, busy } = await pickLane(config)
    // nothing answers at all (not even a busy lane): the service may be down, and asking it to start is allowed
    if (!lane && busy.length > 0 && busy.every((b) => b.includes('is unreachable')) && (await startLanes(busy, signal))) ({ lane, busy } = await pickLane(config))
    let chosen = lane
    if (!chosen && config.queuePolicy === 'wait') chosen = (await firstReachableLane(config)) ?? undefined
    if (!chosen) {
      throw new Error(
        `every ComfyUI lane is busy or unreachable: ${busy.join('; ')}. Free a lane, set the queue policy to "wait" in config/comfy.md, or add another endpoint.`
      )
    }
    return chosen
  }

  async function runGraph(lane: string, graph: Graph, req: { onProgress?: ComfyRequest['onProgress']; signal?: AbortSignal }, preferNode?: string) {
    // A prompt ComfyUI lost (crash and restart) is submitted once more; a second loss fails the job.
    for (let attempt = 1; ; attempt++) {
      const promptId = await postPrompt(lane, graph)
      req.onProgress?.({ stage: 'queued', message: attempt === 1 ? `queued ${promptId}` : `queued again ${promptId}` })
      try {
        const outputs = await waitForOutputs(lane, promptId, {
          timeoutMs: config.jobTimeoutMs,
          pollMs: config.pollIntervalMs,
          unreachableMs: config.unreachableTimeoutMs,
          signal: req.signal,
          onPoll: (p) => req.onProgress?.({ stage: 'running', message: `${p.status} ${Math.round(p.elapsedMs / 1000)}s` })
        })
        return { promptId, collected: collectOutputs(outputs, preferNode) }
      } catch (error) {
        if (!(error instanceof LostPromptError)) throw error
        if (attempt >= 2) throw new Error(`${error.message}; it was submitted again once and was lost again, so the job failed. Check the ComfyUI window and restart it.`, { cause: error })
        req.onProgress?.({ stage: 'queued', message: `${error.message}; submitting it again` })
      }
    }
  }

  async function finish(lane: string, promptId: string, kind: EngineKind, items: { images: OutputItem[]; audio: OutputItem[] }, req: ComfyRequest, seed: number): Promise<ComfyResult> {
    const wanted = kind === 'image' ? items.images : items.audio
    const fallback = kind === 'image' ? items.audio : items.images
    const chosen = wanted.length > 0 ? wanted : fallback
    const item = chosen[0]
    if (!item) throw new Error(`ComfyUI job ${promptId} finished without ${kind} output`)
    req.onProgress?.({ stage: 'download', message: item.filename })
    const bytes = await downloadOutput(lane, item)
    return { bytes, ext: extOf(item.filename, wanted.length > 0 ? kind : kind === 'image' ? 'audio' : 'image'), kind, seed, engine: req.engine, lane, promptId }
  }

  /**
   * The guard of a built-in TTS/SFX engine: ComfyUI must have the suite's nodes. An unreachable ComfyUI is left to `chooseLane`
   * (its message says which lane did not answer), an installation without the suite gets the install hint.
   */
  async function requireNodes(id: string, engine: EngineDef): Promise<void> {
    if (!engine.requiresNodes?.length) return
    const info = await getInfo()
    if (!info) return
    const missing = engine.requiresNodes.filter((node) => !info[node])
    if (missing.length > 0) throw new Error(`engine "${id}" needs the ComfyUI nodes ${missing.join(', ')} (TTS Audio Suite): install it or pick another voice engine`)
  }

  /** A built-in TTS or SFX engine: the graph comes from `tts-engines.ts`, the clip from the suite's save node. */
  async function generateBuiltinAudio(req: ComfyRequest, engine: EngineDef): Promise<ComfyResult> {
    // the language either goes into the engine's language input or is worked out from the text, but the model must read it
    let languageName = req.languageName
    if (languageName === undefined && req.language !== undefined) {
      if (engine.language) languageName = engineLanguageValue(engine, req.language)
      if (!engineReadsLanguage(engine, req.language) || (engine.language && languageName === undefined)) {
        throw new Error(`engine "${req.engine}" does not read ${req.language} (it reads: ${engineLanguageList(engine)})`)
      }
    }
    await requireNodes(req.engine, engine)
    const lane = await chooseLane(req.signal)
    req.onProgress?.({ stage: 'lane', message: lane })
    let voiceRef: string | undefined
    // an upload only makes sense for the engines that clone (never chatterbox/vibevoice, which ignore it)
    if (req.voiceRef !== undefined && engine.clone !== 'none') {
      const ext = typeof req.voiceRef === 'string' ? path.extname(req.voiceRef) : ''
      const name = `cts_voice_${Date.now().toString(36)}${ext || `.${req.format ?? config.audioFormat}`}`
      req.onProgress?.({ stage: 'upload', message: 'voice reference' })
      voiceRef = (await uploadImage(lane, req.voiceRef, { name })).filename
    }
    const seed = req.seed ?? randomSeed()
    const overrides = config.engineSettings[req.engine] ?? {}
    const opts: BuildOpts = {
      ...engine.defaults,
      ...overrides,
      files: (engine.fileGroup ? files[engine.fileGroup] : {}) ?? {},
      filenamePrefix: req.filenamePrefix ?? (engine.task === 'sfx' ? 'cts_sfx' : 'cts_voice'),
      seed,
      prompt: req.prompt ?? '',
      text: req.text ?? req.prompt ?? '',
      negativePrompt: req.negative ?? '',
      format: req.format ?? config.audioFormat,
      ...(languageName !== undefined ? { languageName } : {}),
      ...(req.instruct !== undefined ? { instruct: req.instruct } : {}),
      ...(req.voiceRefText !== undefined ? { voiceRefText: req.voiceRefText } : {}),
      ...(voiceRef !== undefined ? { voiceRef } : {}),
      ...(req.chunkChars !== undefined ? { chunkChars: req.chunkChars } : {}),
      ...(req.speed !== undefined ? { speed: req.speed } : {}),
      ...(req.seconds !== undefined ? { seconds: req.seconds } : {}),
      ...(req.steps !== undefined ? { steps: req.steps } : {}),
      ...(req.cfg !== undefined ? { cfg: req.cfg } : {})
    }
    const graph = engine.build(opts)
    const { promptId, collected } = await runGraph(lane, graph, req, engine.outputNode)
    return finish(lane, promptId, engine.kind, collected, req, seed)
  }

  async function generate(req: ComfyRequest): Promise<ComfyResult> {
    if (req.engine.startsWith('custom:')) return generateCustom(req)
    const engine = ENGINES[req.engine]
    if (!engine) throw new Error(`unknown engine "${req.engine}"`)
    if (engine.task === 'tts' || engine.task === 'sfx') return generateBuiltinAudio(req, engine)
    const lane = await chooseLane(req.signal)
    req.onProgress?.({ stage: 'lane', message: lane })

    const references: string[] = []
    for (const [i, src] of (req.references ?? []).entries()) {
      req.onProgress?.({ stage: 'upload', message: `reference ${i + 1}` })
      references.push((await uploadImage(lane, src)).filename)
    }
    let initFile: string | undefined
    let maskFile: string | undefined
    if (req.init) {
      if (!INIT_BUILDERS[req.engine]) throw new Error(`engine ${req.engine} has no image-to-image graph (z-image-turbo has)`)
      if (!(req.init.denoise > 0 && req.init.denoise <= 1)) throw new Error(`init.denoise must be above 0 and at most 1, not ${req.init.denoise}`)
      req.onProgress?.({ stage: 'upload', message: 'init image' })
      initFile = (await uploadImage(lane, req.init.image)).filename
      if (req.init.mask !== undefined) {
        req.onProgress?.({ stage: 'upload', message: 'mask' })
        maskFile = (await uploadImage(lane, req.init.mask, { name: `cts_mask_${Date.now().toString(36)}.png` })).filename
      }
    }
    if (engine.acceptsReferences && references.length === 0) throw new Error(`engine ${req.engine} needs at least one reference image`)

    const seed = req.seed ?? randomSeed()
    const overrides = config.engineSettings[req.engine] ?? {}
    const explicitSize = req.width !== undefined && req.height !== undefined
    const prompt = req.prompt ?? ''
    const build = req.init ? INIT_BUILDERS[req.engine]![maskFile ? 'inpaint' : 'img2img'] : engine.build
    const graph = build({
      ...engine.defaults,
      ...overrides,
      ...(initFile ? { initImage: initFile, denoise: req.init!.denoise } : {}),
      ...(maskFile ? { maskImage: maskFile } : {}),
      ...(req.steps !== undefined ? { steps: req.steps } : {}),
      ...(req.cfg !== undefined ? { cfg: req.cfg } : {}),
      files: (engine.fileGroup ? files[engine.fileGroup] : {}) ?? {},
      filenamePrefix: req.filenamePrefix ?? (engine.kind === 'image' ? 'cts_image' : 'cts_audio'),
      seed,
      prompt,
      negativePrompt: req.negative ?? '',
      width: explicitSize ? snap16(req.width!) : references.length > 0 ? undefined : sizeOf('square').width,
      height: explicitSize ? snap16(req.height!) : references.length > 0 ? undefined : sizeOf('square').height,
      references,
      // An edit with no explicit size takes the reference image's own resolution.
      autoLatent: references.length > 0 && !explicitSize,
      tags: prompt,
      style: prompt,
      caption: prompt,
      lyrics: req.lyrics ?? '',
      ...(req.seconds !== undefined ? { seconds: req.seconds } : {}),
      format: req.format ?? config.audioFormat
    } as never)
    const { promptId, collected } = await runGraph(lane, graph, req)
    return finish(lane, promptId, engine.kind, collected, req, seed)
  }

  async function generateCustom(req: ComfyRequest): Promise<ComfyResult> {
    const name = req.engine.slice('custom:'.length)
    const workflow = await loadCustomWorkflow(dirs, name)
    const lane = await chooseLane(req.signal)
    req.onProgress?.({ stage: 'lane', message: lane })
    let reference: string | undefined
    const firstRef = req.references?.[0]
    if (firstRef !== undefined && workflow.mapping.reference) {
      req.onProgress?.({ stage: 'upload', message: 'reference image' })
      reference = (await uploadImage(lane, firstRef)).filename
    }
    let voiceRef: string | undefined
    if (req.voiceRef !== undefined && workflow.mapping.voiceRef) {
      req.onProgress?.({ stage: 'upload', message: 'voice reference' })
      const name = typeof req.voiceRef === 'string' ? undefined : `cts_voice_${Date.now().toString(36)}.mp3`
      voiceRef = (await uploadImage(lane, req.voiceRef, { name })).filename
    }
    const { graph, outputNode, seed } = fillWorkflow(workflow, {
      prompt: req.prompt,
      negative: req.negative,
      width: req.width,
      height: req.height,
      seed: req.seed,
      steps: req.steps,
      reference,
      text: req.text,
      language: req.language,
      voiceRef
    })
    const kind = workflowKind(graph, workflow.mapping)
    const { promptId, collected } = await runGraph(lane, graph, req, outputNode)
    return finish(lane, promptId, kind, collected, req, seed)
  }

  async function getInfo(): Promise<ObjectInfo | null> {
    if (infoCache) return infoCache
    let lane = await firstReachableLane(config)
    if (!lane && (await startLanes([]))) lane = await firstReachableLane(config)
    if (!lane) return null
    try {
      infoCache = await objectInfo(lane)
    } catch {
      return null
    }
    return infoCache
  }

  return { generate }
}
