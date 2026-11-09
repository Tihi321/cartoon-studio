import { promises as fs } from 'node:fs'
import path from 'node:path'
import { elevenCounterOf, recordElevenCredits, recordElevenReading } from '../budget/spend'
import type { ElevenReading } from '../../shared/contracts'
import type { CtsService } from '../service'
import { SeriesStore } from '../series/service'
import { elevenCodeOf } from '../studios/flow'
import { normaliseWav } from './audio'
import { DEFAULT_ELEVEN_MODEL, loadVoiceConfig, probeEleven } from './run'

/**
 * ElevenLabs auditions (HUB-31; CTS-37 shares it with the pipeline): one line spoken with each voice id, written as
 * `cast/<id>/voice/audition-<lang>-<voiceId>[-<model>].wav`. `cts_voice_audition` and the `voice_cast` step both call this, so the same quota check,
 * file names and credit records apply to both.
 */

export interface ElevenAuditionArgs {
  series: string
  cast: string
  lang: string
  voiceIds: string[]
  /** Default: the character's bible model for `lang`, else `config/voice.md` `elevenlabs.model`. */
  model?: string
  /** Default: the character's first catchphrase in `lang`. */
  text?: string
  /** The language code sent to ElevenLabs (default `lang`). */
  language?: string
  /** The episode whose `spend.json` records the credits. */
  episode?: string
  signal?: AbortSignal
}

export interface ElevenAuditionResult {
  cast: string
  lang: string
  model: string
  text: string
  clips: { voiceId: string; file: string; seconds: number; credits: number }[]
  credits: number
  remainingAfter: number | null
  ledger: string | null
  /** CTS-43: the account counter before and after these auditions, as recorded in spend.json (`elevenReadings`); absent without an episode. */
  reading?: ElevenReading
  hint?: string
  error?: string
}

/** Throws `E_ELEVEN_*` when ElevenLabs is not ready or the estimate does not fit above the reserve (nothing is sent then). */
export async function elevenAudition(svc: CtsService, a: ElevenAuditionArgs): Promise<ElevenAuditionResult> {
  const st = new SeriesStore(svc.dataDir)
  const bible = await st.readBible(a.series)
  const member = bible.cast.find((c) => c.id === a.cast)
  if (!member) throw new Error(`no cast member "${a.cast}" in ${a.series}`)
  const text = (a.text ?? (a.lang === 'hr' || a.lang === 'en' ? member.catchphrases?.[a.lang]?.[0] : undefined) ?? '').trim()
  if (!text) throw new Error(`${a.cast} has no ${a.lang} catchphrase: pass text`)
  const config = await loadVoiceConfig(svc.dataDir)
  const model = a.model ?? (member.voice as Record<string, { elevenlabs?: { model?: string } } | undefined>)[a.lang]?.elevenlabs?.model ?? config.elevenlabs.model
  const { flow } = await svc.studios()
  const e = await probeEleven(flow, config, a.signal)
  if (!e) throw new Error('E_ELEVEN_API: this flow-music-mcp client has no ElevenLabs status')
  if (!e.up) throw new Error(e.reason?.startsWith('E_ELEVEN_') ? e.reason : `E_ELEVEN_KEY: ElevenLabs is not ready (${e.reason})`)
  const mult = e.status.models.find((m) => m.id === model)?.multiplier ?? 1
  const estimate = a.voiceIds.length * Math.ceil(text.length * mult)
  if (estimate > e.left) throw new Error(`E_ELEVEN_QUOTA: ${a.voiceIds.length} audition(s) need about ${estimate} credit(s); ${e.left} are left above the reserve of ${e.reserve}. Nothing was sent.`)
  const dir = path.join(st.paths(a.series).castDir(a.cast), 'voice')
  const tmp = path.join(svc.dataDir, 'state', 'tmp', `audition-${a.series}-${a.cast}-${process.pid}`)
  await fs.mkdir(tmp, { recursive: true })
  const clips: ElevenAuditionResult['clips'] = []
  let credits = 0
  let remainingAfter: number | null = null
  let error: string | undefined
  let ledgered = 0
  const before = elevenCounterOf(e.status)
  try {
    for (const voiceId of a.voiceIds) {
      const name = `audition-${a.lang}-${voiceId.replace(/[^A-Za-z0-9_-]/g, '_')}${model !== DEFAULT_ELEVEN_MODEL ? `-${model.replace(/[^A-Za-z0-9_-]/g, '_')}` : ''}`
      try {
        const r = await flow.narrate({ text, engine: 'elevenlabs', voice: voiceId, model, language: a.language ?? a.lang, timestamps: false, out: tmp, name, format: 'wav', ...(a.signal ? { signal: a.signal } : {}) })
        const spent = r.creditsEstimate ?? Math.ceil(text.length * mult)
        credits += spent
        remainingAfter = r.remainingAfter ?? remainingAfter
        if (a.episode) await recordElevenCredits({ store: st, series: a.series, episode: a.episode, model: r.model ?? model, what: `audition ${a.cast} ${a.lang} ${voiceId}`, amount: spent }).then(() => (ledgered += spent))
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
  // CTS-43: the counter after the phase, next to the one read before it, so the API delta can be checked against the entries
  let reading: ElevenReading | undefined
  if (a.episode) {
    const after = flow.elevenStatus ? elevenCounterOf(await flow.elevenStatus(a.signal).catch(() => null)) : null
    reading = await recordElevenReading({ store: st, series: a.series, episode: a.episode, reading: { phase: 'auditions', what: `audition ${a.cast} ${a.lang}`, before, after, estimate: ledgered } }).catch(() => undefined)
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
    ...(reading ? { reading } : {}),
    ...(a.episode ? {} : { hint: 'no episode given: the credits are not in any spend.json; add them to the run log' }),
    ...(error ? { error } : {})
  }
}
