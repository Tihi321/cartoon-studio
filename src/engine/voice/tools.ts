import { promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { VOICE_PROVIDERS } from '../../shared/media'
import type { VoiceProvider } from '../../shared/media'
import type { Engine } from '../engine'
import type { Tool, ToolDef } from '../mcp/tools'
import { generateTheme } from '../music/comfy'
import type { CtsService } from '../service'
import { SeriesStore } from '../series/service'
import { comfyKindSwitch } from '../comfy/kind-switch'
import { recordElevenCredits } from '../budget/spend'
import { elevenCodeOf } from '../studios/flow'
import { normaliseWav } from './audio'
import { readManifest } from './manifest'
import { DEFAULT_ELEVEN_MODEL, loadVoiceConfig, planVoice, probeEleven, quotaFor, runVoice } from './run'
import type { VoiceRunDeps } from './run'

/**
 * The voice and music MCP tools (CTS-06) and the job handlers behind them. `cts_voice_generate` and `cts_music_generate` return a job id at once
 * (the queue runs them: `cts_wait`, `cts_status`); plan, status and quota answer directly.
 *
 * Jobs: `<series>--voice--<episode>--r<n>` (role `voice-director`, no model) and `<series>--music--theme--r<n>` (role `composer`, no model); the
 * request is the JSON body of the job file.
 */

const series = z.string().describe('The series slug')
const episode = z.string().describe('The episode id, e.g. ep00-pilot')
const lang = z.string().optional().describe('Only this language (hr, en)')

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

const voiceJobSchema = z.object({
  episode: z.string(),
  lang: z.string().optional(),
  ids: z.array(z.string()).optional(),
  force: z.boolean().optional(),
  provider: z.enum(VOICE_PROVIDERS).optional()
})
const musicJobSchema = z.object({
  tags: z.string(),
  bpm: z.number().min(60).max(180).optional(),
  seed: z.number().int().min(0).optional(),
  seconds: z.number().min(20).max(60).optional()
})

/** The request is the JSON at the top of the job body (the scheduler's log lines may follow it after a restart). */
function requestOf(body: string): unknown {
  const text = body.trim()
  if (!text) return {}
  const end = text.indexOf('\n}')
  return JSON.parse(end >= 0 ? text.slice(0, end + 2) : text)
}

/** The next free job id of `<series>--<task>--<unit>--r<n>`. */
async function enqueueJob(svc: CtsService, o: { series: string; task: 'voice' | 'music'; role: string; unit: string; label: string; body: unknown }): Promise<string> {
  for (let run = 1; ; run++) {
    const id = `${o.series}--${o.task}--${o.unit}--r${run}`
    if (await svc.deps.jobs.enqueue({ id, task: o.task, role: o.role, book: o.series, unit: o.unit, round: run, requested_by: 'you', label: o.label }, JSON.stringify(o.body, null, 2))) {
      svc.deps.kick?.()
      return id
    }
    if (run > 999) throw new Error('too many jobs for this unit')
  }
}

/** Everything the voice step needs from the service: the generator clients (started when a job needs them) and the Gemini counter. */
export async function voiceDeps(svc: CtsService, o: { autoStart: boolean; log?: (m: string) => void }): Promise<{ deps: VoiceRunDeps; config: Awaited<ReturnType<typeof loadVoiceConfig>> }> {
  const config = await loadVoiceConfig(svc.dataDir)
  const studios = await svc.studios(o)
  const rt = svc.deps.voiceRuntime
  return {
    config,
    deps: {
      flow: studios.flow,
      vibetts: studios.vibetts,
      comfy: await svc.comfy(o),
      quota: quotaFor(svc.dataDir, config, rt?.now),
      flowPauseMs: studios.config.flowVoicePauseMs,
      flowRetries: studios.config.flowVoiceRetries,
      sleep: rt?.sleep ?? sleep,
      kindSwitch: (kind) => comfyKindSwitch(kind, { dataDir: svc.dataDir, log: o.log })
    }
  }
}

export function voiceTools(svc: CtsService, def: ToolDef): Tool[] {
  const store = () => new SeriesStore(svc.dataDir)
  return [
    def(
      'cts_voice_plan',
      'What the voice step would do now, without speaking anything: the clips (script lines x languages) with their state (current, new, changed, redo, forced), which language goes to which provider and why (whole languages, Croatian first: ElevenLabs when every speaker has an ElevenLabs voice id and the credit estimate fits in its free credits minus the reserve; else Gemini within the free 10 requests a day; else the local chain from config/voice.md localOrder: hr OmniVoice then Supertonic, en Kokoro then OmniVoice), the ElevenLabs credit estimate per language (credits) and account (elevenlabs: ready, tier, remaining, reserve, left), what is left of the Gemini quota, what is up, and warnings (bad OmniVoice tags, missing texts or voices, W_VOICE_ID_CHANGED when a character\'s ElevenLabs voice id differs from the one its first episode used).',
      z.object({ series, episode, lang, provider: z.enum(VOICE_PROVIDERS).optional().describe('Force a provider for the whole run (default auto = the hub rule)') }),
      async (a) => {
        const { deps, config } = await voiceDeps(svc, { autoStart: false })
        return planVoice({ store: store(), series: a.series, episode: a.episode, config, lang: a.lang, deps, provider: a.provider as VoiceProvider | undefined })
      }
    ),
    def(
      'cts_voice_generate',
      'Speak the lines of an episode: every line in every language of the series (or one lang / some line ids). Returns a job id at once (cts_wait, cts_voice_status). A clip is made again only when its text, language, voice, speed or style changed (force: true makes all again); a clip no provider can speak becomes a silent placeholder and a warning, never a failed run. Writes episodes/<ep>/voice/<lang>/<line>.wav (44.1 kHz mono) and manifest.json; ElevenLabs lines carry their word times (wordsFrom elevenlabs), the others get whisper times on a 3D series. Costs no money: ElevenLabs spends free-tier credits only (recorded in spend.json as eleven-credits; flow-music-mcp refuses past the free quota), Gemini counts against the free daily quota, the rest is local.',
      z.object({ series, episode, lang, ids: z.array(z.string()).optional().describe('Only these line ids'), force: z.boolean().optional(), provider: z.enum(VOICE_PROVIDERS).optional().describe('Force a provider for the whole run (default auto)') }),
      async (a) => {
        if (!(await svc.seriesExists(a.series))) throw new Error(`no series "${a.series}"`)
        const body = { episode: a.episode, ...(a.lang ? { lang: a.lang } : {}), ...(a.ids ? { ids: a.ids } : {}), ...(a.force ? { force: true } : {}), ...(a.provider ? { provider: a.provider } : {}) }
        const job = await enqueueJob(svc, { series: a.series, task: 'voice', role: 'voice-director', unit: a.episode, label: `voices ${a.episode}`, body })
        return { job, hint: 'cts_wait {series} until it is done, then cts_voice_status {series, episode}' }
      }
    ),
    def(
      'cts_voice_status',
      'The voice state of an episode: per language the allocation, every line with its status (ok, placeholder, failed), provider, engine and seconds, the total seconds, and the voice jobs of the series (queued, running, done, failed).',
      z.object({ series, episode }),
      async (a) => {
        const st = store()
        const bible = await st.readBible(a.series)
        const languages: Record<string, unknown> = {}
        for (const l of bible.languages) {
          const m = await readManifest(st, a.series, a.episode, l)
          languages[l] = m
            ? {
                allocation: m.allocation,
                lines: Object.fromEntries(Object.entries(m.lines).map(([id, v]) => [id, { status: v.status, provider: v.provider, engine: v.engine, voice: v.voice, seconds: v.seconds, file: v.file }])),
                seconds: Math.round(Object.values(m.lines).reduce((x, v) => x + v.seconds, 0) * 100) / 100,
                placeholders: Object.values(m.lines).filter((v) => v.status !== 'ok').length,
                costUsd: m.costUsd
              }
            : null
        }
        const isVoice = (id: string) => id.includes('--voice--')
        const jobs = {
          queued: (await svc.jobIds('queued', a.series)).filter(isVoice),
          running: (await svc.jobIds('running', a.series)).filter(isVoice),
          done: (await svc.jobIds('done', a.series)).filter(isVoice),
          failed: (await svc.jobIds('failed', a.series)).filter(isVoice)
        }
        return { series: a.series, episode: a.episode, languages, jobs }
      }
    ),
    def(
      'cts_voice_quota',
      "The free voice quotas. gemini: today's Gemini TTS counter (the free tier allows 10 requests a day; the day ends at midnight Pacific): limit, used, remaining; reset: true sets today's count back to 0 (a manual fix). elevenlabs: the ElevenLabs free tier read live through flow-music-mcp: ready, tier, remaining credits, reserve (never spent), resetAt, and reason when not ready.",
      z.object({ reset: z.boolean().optional() }),
      async (a) => {
        const config = await loadVoiceConfig(svc.dataDir)
        const q = quotaFor(svc.dataDir, config, svc.deps.voiceRuntime?.now)
        const gemini = a.reset ? await q.reset() : await q.read()
        const { flow } = await svc.studios()
        const e = await probeEleven(flow, config)
        const elevenlabs = e
          ? { ready: e.up, tier: e.status.tier ?? null, remaining: e.status.remaining ?? null, reserve: e.reserve, resetAt: e.status.resetAt ?? null, ...(e.reason ? { reason: e.reason } : {}) }
          : { ready: false, tier: null, remaining: null, reserve: config.elevenlabs.reserve, resetAt: null, reason: 'this flow client has no ElevenLabs status' }
        return { gemini, elevenlabs }
      }
    ),
    def(
      'cts_voice_audition',
      "Audition ElevenLabs voices for a character: speaks one line (text, else the character's first catchphrase in lang) with each voiceId (from flow_elevenlabs_voices, premade on the free tier) and writes cast/<id>/voice/audition-<lang>-<voiceId>.wav (with -<model> added when model is not eleven_multilingual_v2, e.g. eleven_flash_v2_5 with language hr, so both can be heard side by side). Spends free-tier credits only: the whole estimate is checked against the remaining credits minus the reserve before anything is sent (E_ELEVEN_QUOTA otherwise). Pass episode so the credits go in that episode's spend.json (currency eleven-credits; the pilot's API delta is checked against it). Returns per voice the file, seconds and credits, the total and the credits left.",
      z.object({
        series,
        cast: z.string().describe('The cast member id'),
        lang: z.string().describe('The language of the line (hr, en)'),
        provider: z.literal('elevenlabs'),
        voiceIds: z.array(z.string().min(1)).min(1).max(8).describe('ElevenLabs voice ids to audition'),
        model: z.string().optional().describe('The model (default: the character\'s bible model, else config/voice.md elevenlabs.model)'),
        text: z.string().min(2).max(400).optional().describe('The audition line'),
        language: z.string().optional().describe('The language code sent to ElevenLabs (default lang); taken by eleven_flash_v2_5'),
        episode: z.string().optional().describe('The episode whose spend.json records the credits')
      }),
      async (a) => {
        const st = store()
        const bible = await st.readBible(a.series)
        const member = bible.cast.find((c) => c.id === a.cast)
        if (!member) throw new Error(`no cast member "${a.cast}" in ${a.series}`)
        const text = (a.text ?? (a.lang === 'hr' || a.lang === 'en' ? member.catchphrases?.[a.lang]?.[0] : undefined) ?? '').trim()
        if (!text) throw new Error(`${a.cast} has no ${a.lang} catchphrase: pass text`)
        const config = await loadVoiceConfig(svc.dataDir)
        const model = a.model ?? (member.voice as Record<string, { elevenlabs?: { model?: string } } | undefined>)[a.lang]?.elevenlabs?.model ?? config.elevenlabs.model
        const { flow } = await svc.studios()
        const e = await probeEleven(flow, config)
        if (!e) throw new Error('E_ELEVEN_API: this flow-music-mcp client has no ElevenLabs status')
        if (!e.up) throw new Error(e.reason?.startsWith('E_ELEVEN_') ? e.reason : `E_ELEVEN_KEY: ElevenLabs is not ready (${e.reason})`)
        const mult = e.status.models.find((m) => m.id === model)?.multiplier ?? 1
        const estimate = a.voiceIds.length * Math.ceil(text.length * mult)
        if (estimate > e.left) throw new Error(`E_ELEVEN_QUOTA: ${a.voiceIds.length} audition(s) need about ${estimate} credit(s); ${e.left} are left above the reserve of ${e.reserve}. Nothing was sent.`)
        const dir = path.join(st.paths(a.series).castDir(a.cast), 'voice')
        const tmp = path.join(svc.dataDir, 'state', 'tmp', `audition-${a.series}-${a.cast}-${process.pid}`)
        await fs.mkdir(tmp, { recursive: true })
        const clips: { voiceId: string; file: string; seconds: number; credits: number }[] = []
        let credits = 0
        let remainingAfter: number | null = null
        let error: string | undefined
        try {
          for (const voiceId of a.voiceIds) {
            const name = `audition-${a.lang}-${voiceId.replace(/[^A-Za-z0-9_-]/g, '_')}${model !== DEFAULT_ELEVEN_MODEL ? `-${model.replace(/[^A-Za-z0-9_-]/g, '_')}` : ''}`
            try {
              const r = await flow.narrate({ text, engine: 'elevenlabs', voice: voiceId, model, language: a.language ?? a.lang, timestamps: false, out: tmp, name, format: 'wav' })
              const spent = r.creditsEstimate ?? Math.ceil(text.length * mult)
              credits += spent
              remainingAfter = r.remainingAfter ?? remainingAfter
              if (a.episode) await recordElevenCredits({ store: st, series: a.series, episode: a.episode, model: r.model ?? model, what: `audition ${a.cast} ${a.lang} ${voiceId}`, amount: spent })
              const out = path.join(dir, `${name}.wav`)
              const norm = await normaliseWav(r.file, out)
              await fs.rm(r.file, { force: true }).catch(() => undefined)
              clips.push({ voiceId, file: path.relative(st.paths(a.series).root, out).split(path.sep).join('/'), seconds: Math.round(norm.seconds * 100) / 100, credits: spent })
            } catch (err) {
              const msg = (err as Error).message
              error = `${voiceId}: ${msg.split('\n')[0]!.slice(0, 240)}`
              if (elevenCodeOf(msg)) break
            }
          }
        } finally {
          await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
        }
        return {
          cast: a.cast,
          lang: a.lang,
          model,
          text,
          clips,
          credits,
          remainingAfter,
          ledger: a.episode ? `episodes/${a.episode}/spend.json` : null,
          ...(a.episode ? {} : { hint: 'no episode given: the credits are not in any spend.json; add them to the run log' }),
          ...(error ? { error } : {})
        }
      }
    ),
    def(
      'cts_music_generate',
      'Make the series theme: a 40 s instrumental background track from ComfyUI (config/providers.md comfy.musicModel, ACE-Step by default) as series/<slug>/music/theme.ogg with a 0.5 s fade-in and a 2 s fade-out. Returns a job id at once; the job result is { file, seconds, engine, wallSeconds }. ComfyUI missing or failing is a warning and no music, never a failed job. Free and local.',
      z.object({
        series,
        tags: z.string().describe('Style tags, e.g. "soft ukulele, glockenspiel, light percussion, playful, warm"'),
        bpm: z.number().min(60).max(180).optional().describe('Tempo, e.g. 100'),
        seed: z.number().int().min(0).optional().describe('Same seed + same arguments = same theme'),
        seconds: z.number().min(20).max(60).optional().describe('Theme length, default 40')
      }),
      async (a) => {
        if (!(await svc.seriesExists(a.series))) throw new Error(`no series "${a.series}"`)
        const { series: slug, ...body } = a
        const job = await enqueueJob(svc, { series: slug, task: 'music', role: 'composer', unit: 'theme', label: 'series theme', body })
        return { job, hint: 'cts_wait {series}; the file is series/<slug>/music/theme.ogg' }
      }
    )
  ]
}

/** The job handlers of the voice and music tasks (`ENGINE_MODULES`). */
export function registerVoice(engine: Engine): void {
  const svc = engine.cts
  engine.queue.register(
    'voice',
    async (ctx) => {
      const slug = ctx.job.book
      if (!slug) throw new Error('a voice job needs a series')
      const req = voiceJobSchema.parse(requestOf(ctx.jobBody))
      const { deps, config } = await voiceDeps(svc, { autoStart: true, log: (m) => ctx.log(m) })
      const report = await runVoice({ store: new SeriesStore(svc.dataDir), series: slug, episode: req.episode, config, lang: req.lang, ids: req.ids, force: req.force, provider: req.provider as VoiceProvider | undefined, deps, dataDir: svc.dataDir, signal: ctx.signal, log: (m) => ctx.log(m) })
      for (const w of report.warnings) ctx.log(`warning: ${w}`)
      const made = report.made.length
      return { result: `voices ${req.episode}: ${made} made, ${report.kept.length} kept, ${report.placeholders.length} placeholder(s); seconds ${JSON.stringify(report.seconds)}${report.warnings.length ? `; ${report.warnings.length} warning(s)` : ''}` }
    },
    { noModel: true }
  )
  engine.queue.register(
    'music',
    async (ctx) => {
      const slug = ctx.job.book
      if (!slug) throw new Error('a music job needs a series')
      const req = musicJobSchema.parse(requestOf(ctx.jobBody))
      const comfy = await svc.comfy({ autoStart: true, log: (m) => ctx.log(m) })
      const r = await generateTheme({ comfy, store: new SeriesStore(svc.dataDir), dataDir: svc.dataDir, request: { series: slug, ...req }, log: (m) => ctx.log(m), signal: ctx.signal })
      for (const w of r.warnings) ctx.log(`warning: ${w}`)
      return { result: r.theme ? JSON.stringify({ file: r.theme.file, seconds: r.theme.seconds, engine: r.theme.engine, wallSeconds: r.theme.wallSeconds }) : `no music: ${r.warnings.join('; ')}` }
    },
    { noModel: true }
  )
}
