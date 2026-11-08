import { promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { readMd } from '../store/atomic'
import { alignWords } from '../anim/visemes'
import type { Lang, VoiceLine, VoiceManifest } from '../../shared/contracts'
import type { VoiceProvider } from '../../shared/media'
import type { ComfyClient } from '../comfy/client'
import { SeriesFileError } from '../series/service'
import type { SeriesStore } from '../series/service'
import type { FlowClient } from '../studios/flow'
import type { VibeTtsClient, VibeVoices } from '../studios/vibetts'
import { allocateVoice, DEFAULT_LOCAL_ORDER, localChain, voiceReads } from './allocate'
import type { LocalOrder, VoiceAllocationEntry, VoiceAvailability, VoiceProviderUsed } from './allocate'
import { normaliseWav, placeholderSeconds, silenceWav } from './audio'
import { clipFile, clipHash, emptyManifest, isCurrent, readManifest, voiceKey, writeManifest } from './manifest'
import { comfySpeaker, checkOmniInstruct, resolveVoiceEngine } from './providers/comfy'
import { geminiSpeaker, DEFAULT_GEMINI_VOICE } from './providers/gemini'
import { paidSpeaker } from './providers/paid'
import type { PaidVoiceProvider } from './providers/paid'
import type { ClipJob, ClipVoice, SpeakIO, Speaker, Spoken, VoiceProviderName } from './providers/types'
import { vibettsSpeaker } from './providers/vibetts'
import { GeminiQuota, DEFAULT_GEMINI_DAILY_LIMIT, DEFAULT_GEMINI_RESET_TZ } from './quota'

/**
 * Speaks the lines of an episode (CTS-06). Clips = the script's lines x the series' languages. A clip is made again only when its hash changes
 * (text + language + the speaker's voice + speed + style), whatever provider made it; a clip that only got a placeholder is tried again on the next
 * run. Languages are allocated whole by the hub's rule (`allocate.ts`: Gemini within the free 10 a day, Croatian first, else the local chain of
 * `config/voice.md` `localOrder`); a clip that fails everywhere becomes a silent placeholder (2.5 words a second) and a warning, never a failed run.
 * Every clip is normalised to a 44.1 kHz mono WAV with the silence at both ends trimmed, and the manifest is saved after each one (resumable).
 */

// ---- config/voice.md ----

export const voiceConfigSchema = z.object({
  format: z.enum(['mp3', 'wav']).default('wav'),
  speed: z.number().min(0.5).max(2).default(1),
  chunkChars: z.number().int().min(100).max(1000).default(400),
  geminiDailyLimit: z.number().int().min(0).default(DEFAULT_GEMINI_DAILY_LIMIT),
  geminiResetTz: z.string().default(DEFAULT_GEMINI_RESET_TZ),
  localOrder: z.record(z.string(), z.array(z.enum(['comfy', 'vibetts']))).default({}),
  engine: z.string().default('omnivoice')
})
export type VoiceConfig = Omit<z.infer<typeof voiceConfigSchema>, 'localOrder'> & { localOrder: LocalOrder }

/** `config/voice.md`; a missing or broken file gives the defaults (`localOrder` is merged over `hr: [comfy, vibetts]`, `en: [vibetts, comfy]`). */
export async function loadVoiceConfig(dataDir: string): Promise<VoiceConfig> {
  let data: Record<string, unknown> = {}
  try {
    data = (await readMd(path.join(dataDir, 'config', 'voice.md'))).data
  } catch {
    /* defaults */
  }
  const parsed = voiceConfigSchema.safeParse(data)
  const c = parsed.success ? parsed.data : voiceConfigSchema.parse({})
  return { ...c, localOrder: { ...DEFAULT_LOCAL_ORDER, ...c.localOrder } }
}

const quotas = new Map<string, GeminiQuota>()
/** The Gemini counter of a data folder: one instance per folder, so the read-modify-write steps are serialised. */
export function quotaFor(dataDir: string, config: VoiceConfig, now?: () => Date): GeminiQuota {
  const key = `${dataDir}|${config.geminiDailyLimit}|${config.geminiResetTz}`
  let q = quotas.get(key)
  if (!q || now) {
    q = new GeminiQuota(dataDir, { limit: config.geminiDailyLimit, tz: config.geminiResetTz, ...(now ? { now } : {}) })
    if (!now) quotas.set(key, q)
  }
  return q
}

// ---- the clips ----

export type ClipState = 'current' | 'new' | 'changed' | 'redo' | 'forced'

export interface PlannedClip extends ClipJob {
  /** `current`: nothing to do; `new` / `changed`: no clip or another hash; `redo`: the last try ended as a placeholder or the file is gone; `forced`. */
  state: ClipState
}

export interface ClipsQuery {
  store: SeriesStore
  series: string
  episode: string
  config: VoiceConfig
  /** Only this language / these line ids. */
  lang?: string
  ids?: string[]
  force?: boolean
}

/** A stable seed for a character without one in the bible. */
const seedOf = (s: string): number => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7) % 2_147_483_647

/** The clips of an episode (lines x languages) with what each one needs. Never throws for a missing text or voice: the notes go to `warnings`. */
export async function planClips(q: ClipsQuery): Promise<{ clips: PlannedClip[]; warnings: string[]; langs: Lang[] }> {
  const { store, series, episode, config } = q
  const warnings: string[] = []
  const bible = await store.readBible(series)
  const script = await store.readScript(series, episode)
  const paths = store.paths(series)
  const lines: { id: string; speaker: string }[] = []
  for (const scene of script.scenes) for (const beat of scene.beats) if (beat.type === 'line' && !lines.some((l) => l.id === beat.line)) lines.push({ id: beat.line, speaker: beat.speaker })
  const langs = bible.languages.filter((l) => !q.lang || l === q.lang)
  const clips: PlannedClip[] = []
  for (const lang of langs) {
    let text
    try {
      text = await store.readText(series, episode, lang)
    } catch (e) {
      warnings.push(`${lang}: no text catalog (${e instanceof SeriesFileError ? e.message.split('\n')[0] : (e as Error).message}): its lines are not spoken`)
      continue
    }
    const manifest = await readManifest(store, series, episode, lang)
    for (const line of lines) {
      if (q.ids && !q.ids.includes(line.id)) continue
      const entry = text.lines[line.id]
      const said = entry?.text.trim() ?? ''
      if (!said) {
        warnings.push(`${lang} ${line.id}: the text is empty or missing: nothing to speak`)
        continue
      }
      const member = bible.cast.find((c) => c.id === line.speaker)
      const spec = member?.voice[lang]
      if (!member) warnings.push(`${lang} ${line.id}: the speaker "${line.speaker}" is not in the bible cast: the default voice speaks`)
      else if (!spec) warnings.push(`${lang} ${line.id}: ${line.speaker} has no ${lang} voice in the bible: the default voice speaks`)
      let ref: string | null = null
      if (spec?.comfy?.ref) {
        try {
          ref = paths.resolve(spec.comfy.ref)
        } catch (e) {
          warnings.push(`${lang} ${line.speaker}: ${(e as Error).message}: the tags speak`)
        }
      }
      const voice: ClipVoice = {
        gemini: spec?.gemini ?? DEFAULT_GEMINI_VOICE,
        vibetts: spec?.vibetts ?? '',
        comfy: { engine: spec?.comfy?.engine ?? config.engine, instruct: spec?.comfy?.instruct ?? '', ref, refText: spec?.comfy?.refText ?? null, seed: spec?.comfy?.seed ?? seedOf(`${line.speaker}:${lang}`) }
      }
      const speed = Math.round((spec?.speed ?? 1) * config.speed * 1000) / 1000
      const style = (entry?.delivery ?? spec?.style ?? '').trim()
      const hash = clipHash({ text: said, lang, voice: voiceKey({ ...voice, comfy: { ...voice.comfy, ref: spec?.comfy?.ref ?? null } }), speed, style })
      const have = manifest?.lines[line.id]
      const fileOk = have ? await fs.stat(path.join(paths.episodeDir(episode), have.file)).then((s) => s.isFile(), () => false) : false
      const state: ClipState = q.force ? 'forced' : !have ? 'new' : have.hash !== hash ? 'changed' : isCurrent(have, hash) && fileOk ? 'current' : 'redo'
      const pinned = spec && spec.provider !== 'auto' && spec.provider !== 'gemini' ? (spec.provider as VoiceProviderName) : undefined
      clips.push({ id: line.id, lang, speaker: line.speaker, text: said, style, speed, voice, hash, state, ...(pinned ? { pinned } : {}) })
    }
  }
  return { clips, warnings, langs }
}

/** Problems with the OmniVoice tags of every speaker of the series (`instruct` must be attribute tags), for the plan. */
export async function checkVoices(store: SeriesStore, series: string): Promise<string[]> {
  const bible = await store.readBible(series)
  const out: string[] = []
  for (const m of bible.cast)
    for (const [lang, spec] of Object.entries(m.voice))
      if (spec?.comfy) for (const p of checkOmniInstruct(spec.comfy.instruct).problems) out.push(`${m.id} (${lang}): ${p}`)
  return out
}

// ---- what can speak ----

export interface VoiceRunDeps {
  flow: FlowClient
  vibetts: VibeTtsClient
  comfy: ComfyClient
  quota: GeminiQuota
  /** Pause between two Gemini requests and retries of a rate limit (`config/studios.md`). */
  flowPauseMs: number
  flowRetries: number
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  /** The paid slot (phase 1: none, so the gate and `NOT_IMPLEMENTED` answer). */
  paid?: PaidVoiceProvider
  /** Tests: replaces the ComfyUI memory switch. */
  kindSwitch?: (kind: 'voice') => Promise<unknown>
}

interface Probe {
  avail: VoiceAvailability
  vibe: VibeVoices | null
  notes: string[]
}

async function probe(deps: VoiceRunDeps, config: VoiceConfig, provider: VoiceProvider, langs: string[], signal?: AbortSignal): Promise<Probe> {
  const notes: string[] = []
  let gemini: VoiceAvailability['gemini'] = { up: false, reason: 'this run does not use Gemini' }
  if (provider === 'auto' || provider === 'gemini') {
    try {
      const st = await deps.flow.status(signal)
      if (!st.up) gemini = { up: false, reason: st.hint ?? 'flow-music-mcp is not running' }
      else if (st.signedIn === false) gemini = { up: false, reason: st.hint ?? 'Google Flow is not signed in' }
      else gemini = (await deps.flow.voices(signal)).geminiReady ? { up: true } : { up: false, reason: 'no Google AI Studio key is set up in flow-music-mcp (the Gemini voices cannot speak)' }
    } catch (e) {
      gemini = { up: false, reason: (e as Error).message.split('\n')[0]!.slice(0, 160) }
    }
    if (!gemini.up) notes.push(`Gemini: ${gemini.reason}`)
  }
  let vibe: VibeVoices | null = null
  let vibeWhy = ''
  try {
    vibe = await deps.vibetts.listVoices(signal)
  } catch (e) {
    vibeWhy = (e as Error).message.split('\n')[0]!.slice(0, 160)
    notes.push(`VibeTTS: ${vibeWhy}`)
  }
  const comfyWhy: string[] = []
  const comfyReads = new Set<string>()
  for (const lang of langs) {
    const r = resolveVoiceEngine(config.engine, lang)
    if ('def' in r) comfyReads.add(lang)
    else comfyWhy.push(r.reason)
  }
  const avail: VoiceAvailability = {
    gemini,
    vibetts: { up: !!vibe, reads: (l) => !!vibe && vibe.voices.some((v) => voiceReads(v, l)), ...(vibe ? {} : { reason: vibeWhy }) },
    comfy: { up: true, reads: (l) => comfyReads.has(l), ...(comfyWhy.length ? { reason: comfyWhy[0] } : {}) }
  }
  return { avail, vibe, notes }
}

/** How many clips of each language want a provider chosen by the rule (clips the character pins to one provider do not count against Gemini). */
const needOf = (clips: readonly PlannedClip[]): Record<string, number> => {
  const need: Record<string, number> = {}
  for (const c of clips) if (!c.pinned) need[c.lang] = (need[c.lang] ?? 0) + 1
  return need
}

export interface VoicePlanReport {
  clips: { lang: string; id: string; speaker: string; state: ClipState; pinned?: VoiceProviderName; text: string }[]
  need: Record<string, number>
  allocation: Record<string, VoiceAllocationEntry>
  quota: { limit: number; used: number; remaining: number; day: string; tz: string }
  availability: { gemini: { up: boolean; reason?: string }; vibetts: { up: boolean; reason?: string }; comfy: { up: boolean; reason?: string } }
  warnings: string[]
}

export interface PlanInput extends ClipsQuery {
  deps: VoiceRunDeps
  provider?: VoiceProvider
  signal?: AbortSignal
}

/** What a run would do now: the clips, which ones need speaking, who would speak each language and what is left of the Gemini quota. Speaks nothing. */
export async function planVoice(inp: PlanInput): Promise<VoicePlanReport> {
  const { clips, warnings, langs } = await planClips(inp)
  warnings.push(...(await checkVoices(inp.store, inp.series)))
  const todo = clips.filter((c) => c.state !== 'current')
  const need = needOf(todo)
  const provider = inp.provider ?? 'auto'
  const p = await probe(inp.deps, inp.config, provider, langs, inp.signal)
  const q = await inp.deps.quota.read()
  const allocation = allocateVoice({ need, provider, quota: { limit: q.limit, used: q.used }, avail: p.avail, localOrder: inp.config.localOrder })
  return {
    clips: clips.map((c) => ({ lang: c.lang, id: c.id, speaker: c.speaker, state: c.state, ...(c.pinned ? { pinned: c.pinned } : {}), text: c.text })),
    need,
    allocation,
    quota: q,
    availability: { gemini: p.avail.gemini, vibetts: { up: p.avail.vibetts.up, ...(p.avail.vibetts.reason ? { reason: p.avail.vibetts.reason } : {}) }, comfy: { up: p.avail.comfy.up, ...(p.avail.comfy.reason ? { reason: p.avail.comfy.reason } : {}) } },
    warnings: [...warnings, ...p.notes]
  }
}

// ---- the run ----

export interface VoiceRunInput extends PlanInput {
  dataDir: string
  log: (message: string) => void
}

export interface VoiceRunReport {
  allocation: Record<string, VoiceAllocationEntry>
  made: { lang: string; id: string; provider: string; seconds: number }[]
  /** Clips whose hash did not change: nothing was spoken. */
  kept: { lang: string; id: string }[]
  /** Clips that got a silent placeholder (nothing could speak them). */
  placeholders: { lang: string; id: string; reason: string }[]
  warnings: string[]
  /** Seconds spoken per language (the manifest's lines, all of them). */
  seconds: Record<string, number>
}

const key = (lang: string, id: string): string => `${lang}/${id}`

export async function runVoice(inp: VoiceRunInput): Promise<VoiceRunReport> {
  const { store, series, episode, config, deps, log } = inp
  const provider = inp.provider ?? 'auto'
  const paths = store.paths(series)
  const epDir = paths.episodeDir(episode)
  const report: VoiceRunReport = { allocation: {}, made: [], kept: [], placeholders: [], warnings: [], seconds: {} }
  const { clips, warnings, langs } = await planClips(inp)
  report.warnings.push(...warnings, ...(await checkVoices(store, series)))
  report.kept.push(...clips.filter((c) => c.state === 'current').map((c) => ({ lang: c.lang, id: c.id })))
  const jobs = clips.filter((c) => c.state !== 'current')

  // the manifests: the existing ones, pruned to the lines the script has now
  const manifests = new Map<string, VoiceManifest>()
  for (const lang of langs) {
    const m = (await readManifest(store, series, episode, lang)) ?? emptyManifest(episode, lang)
    const ids = new Set(clips.filter((c) => c.lang === lang).map((c) => c.id))
    if (!inp.ids) for (const id of Object.keys(m.lines)) if (!ids.has(id) && clips.some((c) => c.lang === lang)) delete m.lines[id]
    manifests.set(lang, m)
  }
  const save = (lang: string) => writeManifest(store, series, episode, manifests.get(lang)!)
  const secondsOf = (): void => {
    for (const [lang, m] of manifests) report.seconds[lang] = Math.round(Object.values(m.lines).reduce((a, l) => a + l.seconds, 0) * 100) / 100
  }
  /** Blender series: whisper word times of every spoken line without them, aligned to the script words (`words`, `wordsCoverage`). Never fails the run. */
  const fillWords = async (): Promise<void> => {
    const bible = await store.readBible(series)
    if (bible.renderer !== 'blender' || !deps.flow.transcribe) return
    for (const lang of langs) {
      const m = manifests.get(lang)
      if (!m) continue
      const text = await store.readText(series, episode, lang).catch(() => null)
      for (const [id, line] of Object.entries(m.lines)) {
        const said = text?.lines[id]?.text
        if (line.status !== 'ok' || line.words || !said) continue
        try {
          const heard = await deps.flow.transcribe(path.join(epDir, line.file), lang, inp.signal)
          const al = alignWords(said, heard.words)
          line.words = al.words
          line.wordsCoverage = Math.round(al.coverage * 1000) / 1000
          log(`voice ${lang} ${id}: whisper heard ${heard.words.length} word(s), ${al.words.length}/${al.total} aligned (${Math.round(al.coverage * 100)} %)`)
          await save(lang)
        } catch (e) {
          inp.signal?.throwIfAborted()
          report.warnings.push(`whisper words for ${lang} ${id}: ${(e as Error).message.split('\n')[0]!.slice(0, 160)}: the lip-sync uses the text method`)
        }
      }
    }
  }

  if (jobs.length === 0) {
    await fillWords()
    secondsOf()
    return report
  }

  const tmp = path.join(store.dataDir, 'state', 'tmp', `voice-${series}-${episode}-${process.pid}`)
  await fs.mkdir(tmp, { recursive: true })
  try {
    const p = await probe(deps, config, provider, [...new Set(jobs.map((j) => j.lang))], inp.signal)
    const q = await deps.quota.read()
    const allocation = allocateVoice({ need: needOf(jobs), provider, quota: { limit: q.limit, used: q.used }, avail: p.avail, localOrder: config.localOrder })
    report.allocation = allocation
    for (const a of Object.values(allocation)) log(`voice ${a.lang}: ${a.need} clip(s) -> ${a.provider} (${a.reason})`)

    // the chain of every clip: the allocation's, or the character's pinned provider first
    const chainOf = (j: ClipJob): VoiceProviderName[] => {
      const local = localChain(j.lang, j.pinned === 'comfy' || j.pinned === 'vibetts' ? j.pinned : provider, p.avail, config.localOrder)
      if (j.pinned === 'paid') return ['paid', ...local]
      if (j.pinned === 'comfy' || j.pinned === 'vibetts') return local
      return allocation[j.lang]?.chain ?? local
    }
    const chains = new Map(jobs.map((j) => [key(j.lang, j.id), chainOf(j)]))

    const speakers: Record<VoiceProviderName, Speaker> = {
      gemini: geminiSpeaker({ flow: deps.flow, quota: deps.quota, pauseMs: deps.flowPauseMs, retries: deps.flowRetries, sleep: deps.sleep }),
      vibetts: vibettsSpeaker({ client: deps.vibetts, voices: p.vibe ?? { voices: [], languages: [], languageVoices: {}, readLanguage: 'auto', supertonicInstalled: false, higgsInstalled: false } }),
      comfy: comfySpeaker({ comfy: deps.comfy, defaultEngine: config.engine, dataDir: inp.dataDir, series, chunkChars: config.chunkChars, kindSwitch: deps.kindSwitch, warn: (m) => report.warnings.push(m) }),
      paid: paidSpeaker({ store, series, episode, provider: deps.paid })
    }

    const spoken = new Set<string>()
    const lastError = new Map<string, string>()
    const madeBy = new Map<string, Partial<Record<VoiceProviderUsed, number>>>()
    const io: SpeakIO = {
      tmp,
      signal: inp.signal,
      log,
      onSpoken: async (job: ClipJob, s: Spoken) => {
        const k = key(job.lang, job.id)
        try {
          const rel = clipFile(job.lang, job.id)
          const seconds = await normaliseWav(s.file, path.join(epDir, rel))
          if (seconds < 0.2) throw new Error(`the audio is ${seconds.toFixed(2)} s long (silent or empty)`)
          const m = manifests.get(job.lang)!
          const line: VoiceLine = {
            file: rel,
            seconds: Math.round(seconds * 1000) / 1000,
            provider: s.provider,
            ...(s.engine ? { engine: s.engine } : {}),
            ...(s.voice ? { voice: s.voice } : {}),
            speed: job.speed,
            hash: job.hash,
            words: null,
            status: 'ok'
          }
          m.lines[job.id] = line
          await save(job.lang)
          spoken.add(k)
          report.made.push({ lang: job.lang, id: job.id, provider: s.provider, seconds: line.seconds })
          if (s.provider !== 'paid') {
            const by = madeBy.get(job.lang) ?? {}
            by[s.provider] = (by[s.provider] ?? 0) + 1
            madeBy.set(job.lang, by)
          }
          log(`voice ${job.lang}: ${report.made.length}/${jobs.length} clips (${s.provider}, ${line.seconds} s)`)
        } catch (e) {
          lastError.set(k, `${s.provider}: ${(e as Error).message}`)
        } finally {
          await fs.rm(s.file, { force: true }).catch(() => undefined)
        }
      }
    }

    // rounds: every pending clip goes to the next provider of its chain that is not down; a provider's clips go in one call (the lines back to back)
    const tried = new Map<string, Set<string>>()
    const stopped = new Map<string, string>()
    for (;;) {
      inp.signal?.throwIfAborted()
      const pending = jobs.filter((j) => !spoken.has(key(j.lang, j.id)))
      const nextOf = (j: ClipJob): VoiceProviderName | undefined => (chains.get(key(j.lang, j.id)) ?? []).find((c) => !tried.get(key(j.lang, j.id))?.has(c) && !stopped.has(c))
      const first = pending.map(nextOf).find((n) => n)
      if (!first) break
      const group = pending.filter((j) => nextOf(j) === first)
      for (const j of group) tried.set(key(j.lang, j.id), (tried.get(key(j.lang, j.id)) ?? new Set()).add(first))
      const out = await speakers[first].speak(group, io)
      for (const f of out.failed) lastError.set(key(f.job.lang, f.job.id), `${first}: ${f.error}`)
      if (out.stop) {
        stopped.set(first, out.stop.message)
        const left = group.filter((j) => !spoken.has(key(j.lang, j.id))).length
        if (left > 0) {
          const w = `${first} stopped (${out.stop.message}): ${left} clip(s) go on to the next provider`
          report.warnings.push(w)
          log(`voice: ${w}`)
        }
      }
    }

    // what nothing could speak: a silent placeholder, never a failed run
    for (const j of jobs) {
      const k = key(j.lang, j.id)
      if (spoken.has(k)) continue
      const chain = chains.get(k) ?? []
      const why = lastError.get(k) ?? (chain.length === 0 ? (allocation[j.lang]?.reason ?? 'no provider can speak this language') : [...stopped.values()].join('; ') || p.notes.join('; ') || 'no provider could speak it')
      const seconds = placeholderSeconds(j.text)
      const rel = clipFile(j.lang, j.id)
      await fs.mkdir(path.dirname(path.join(epDir, rel)), { recursive: true })
      await fs.writeFile(path.join(epDir, rel), silenceWav(seconds))
      manifests.get(j.lang)!.lines[j.id] = { file: rel, seconds, provider: 'none', engine: 'silence', speed: j.speed, hash: j.hash, words: null, status: 'placeholder' }
      await save(j.lang)
      report.placeholders.push({ lang: j.lang, id: j.id, reason: why })
      report.warnings.push(`W_PLACEHOLDER ${j.lang} ${j.id}: ${why}`)
    }

    for (const lang of new Set(jobs.map((j) => j.lang))) {
      const a = allocation[lang]
      const m = manifests.get(lang)!
      const made = madeBy.get(lang) ?? {}
      if (a) {
        a.made = made
        a.placeholders = report.placeholders.filter((x) => x.lang === lang).length
        const parts = Object.entries(made).map(([k2, n]) => `${n} by ${k2}`)
        m.allocation = { provider: a.provider, reason: `${a.reason}${parts.length ? `; made: ${parts.join(', ')}` : ''}${a.placeholders ? `; ${a.placeholders} placeholder(s)` : ''}` }
      } else {
        m.allocation = { provider: 'pinned', reason: 'the clips were asked for a provider by their characters' }
      }
      await save(lang)
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
  await fillWords()
  secondsOf()
  return report
}
