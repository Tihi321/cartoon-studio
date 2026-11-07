import { z } from 'zod'
import { CHIPS, VOICE_PROVIDERS } from '../../shared/media'
import type { VoiceProvider } from '../../shared/media'
import type { Engine } from '../engine'
import type { Tool, ToolDef } from '../mcp/tools'
import { generateMusic } from '../music/chiptune'
import type { CtsService } from '../service'
import { SeriesStore } from '../series/service'
import { comfyKindSwitch } from '../comfy/kind-switch'
import { readManifest } from './manifest'
import { loadVoiceConfig, planVoice, quotaFor, runVoice } from './run'
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
  mood: z.string(),
  chip: z.enum(CHIPS),
  seed: z.number().int().min(0),
  seconds: z.number().min(20).max(60).optional(),
  sfx: z.array(z.object({ kind: z.enum(['sfx', 'stinger', 'ambience']), sound: z.string(), name: z.string().optional(), chip: z.enum(CHIPS).optional(), seed: z.number().int().min(0).optional(), seconds: z.number().optional() })).max(2).optional()
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
      'What the voice step would do now, without speaking anything: the clips (script lines x languages) with their state (current, new, changed, redo, forced), which language goes to which provider (Gemini only within the free 10 requests a day, Croatian first; else the local chain from config/voice.md localOrder: hr OmniVoice then Supertonic, en Kokoro then OmniVoice), what is left of the Gemini quota, what is up, and warnings (bad OmniVoice tags, missing texts or voices).',
      z.object({ series, episode, lang, provider: z.enum(VOICE_PROVIDERS).optional().describe('Force a provider for the whole run (default auto = the hub rule)') }),
      async (a) => {
        const { deps, config } = await voiceDeps(svc, { autoStart: false })
        return planVoice({ store: store(), series: a.series, episode: a.episode, config, lang: a.lang, deps, provider: a.provider as VoiceProvider | undefined })
      }
    ),
    def(
      'cts_voice_generate',
      'Speak the lines of an episode: every line in every language of the series (or one lang / some line ids). Returns a job id at once (cts_wait, cts_voice_status). A clip is made again only when its text, language, voice, speed or style changed (force: true makes all again); a clip no provider can speak becomes a silent placeholder and a warning, never a failed run. Writes episodes/<ep>/voice/<lang>/<line>.wav (44.1 kHz mono) and manifest.json. Costs nothing: Gemini counts against the free daily quota, the rest is local.',
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
      "Today's Gemini TTS counter (the free tier allows 10 requests a day; the day ends at midnight Pacific): limit, used, remaining. reset: true sets today's count back to 0 (a manual fix).",
      z.object({ reset: z.boolean().optional() }),
      async (a) => {
        const config = await loadVoiceConfig(svc.dataDir)
        const q = quotaFor(svc.dataDir, config, svc.deps.voiceRuntime?.now)
        return a.reset ? q.reset() : q.read()
      }
    ),
    def(
      'cts_music_generate',
      'Make the series theme (a 30-40 s loop, Chiptune Studio compose_track + render_audio) and up to 2 sound effects (compose_sfx) as .ogg files under series/<slug>/music/. Returns a job id at once. Chiptune Studio missing or failing is a warning and no music, never a failed job. Free and local.',
      z.object({
        series,
        mood: z.string().describe('A Chiptune Studio mood id: lullaby, peaceful, chill, heroic, ...'),
        chip: z.enum(CHIPS).describe('nes, gb, genesis, snes, pce, ps1, dreamcast'),
        seed: z.number().int().min(0).describe('Same seed + same arguments = same theme'),
        seconds: z.number().min(20).max(60).optional().describe('Theme length, default 35 (rounded to whole bars)'),
        sfx: z.array(z.object({ kind: z.enum(['sfx', 'stinger', 'ambience']), sound: z.string().describe('coin, jump, chime, ... / success, reveal, discovery, ... / wind, rain, night, ...'), name: z.string().optional(), chip: z.enum(CHIPS).optional(), seed: z.number().int().min(0).optional(), seconds: z.number().optional() })).max(2).optional()
      }),
      async (a) => {
        if (!(await svc.seriesExists(a.series))) throw new Error(`no series "${a.series}"`)
        const { series: slug, ...body } = a
        const job = await enqueueJob(svc, { series: slug, task: 'music', role: 'composer', unit: 'theme', label: 'series theme', body })
        return { job, hint: 'cts_wait {series}; the files are series/<slug>/music/theme.ogg and the effects beside it' }
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
      const { chiptune } = await svc.studios({ autoStart: true, log: (m) => ctx.log(m) })
      const r = await generateMusic({ chiptune, store: new SeriesStore(svc.dataDir), request: { series: slug, ...req }, log: (m) => ctx.log(m), signal: ctx.signal })
      for (const w of r.warnings) ctx.log(`warning: ${w}`)
      return { result: r.theme ? `theme ${r.theme.file} (${r.theme.seconds.toFixed(1)} s), ${r.sfx.length} effect(s): ${r.sfx.map((s) => s.file).join(', ')}${r.warnings.length ? `; ${r.warnings.length} warning(s)` : ''}` : `no music: ${r.warnings.join('; ')}` }
    },
    { noModel: true }
  )
}
