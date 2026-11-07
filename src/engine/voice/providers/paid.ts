import { charge } from '../../budget/spend'
import type { SeriesStore } from '../../series/service'
import type { SpeakOutcome, Speaker } from './types'

/**
 * The paid voice slot (decision 9 and 7). The interface exists so a later phase can plug a vendor in; **no paid voice client is written in phase 1**.
 * Every call goes through the budget gate first (`charge` of `budget/spend.ts`): with no `budget.json`, or a cap too small for the estimate, it
 * is refused with `BUDGET_EXCEEDED` and nothing happens; once the gate passes, the slot throws `NOT_IMPLEMENTED`
 * (the gate releases its reservation and records nothing, because the call did not run).
 */

export interface PaidVoiceResult {
  file: string
  seconds: number
  words?: { w: string; t0: number; t1: number }[]
}

/** `voiceRef` is the vendor's voice id (or the reference clip) of the character; `style` the delivery note. */
export interface PaidVoiceProvider {
  readonly id: string
  synthesize(text: string, lang: string, voiceRef: string, style: string): Promise<PaidVoiceResult>
}

/** The error of a slot with no client behind it. */
export class NotImplementedError extends Error {
  readonly code = 'NOT_IMPLEMENTED'
  constructor(what: string) {
    super(`NOT_IMPLEMENTED: ${what}`)
    this.name = 'NotImplementedError'
  }
}

/** The slot of phase 1: it has no vendor. */
export const noPaidVoice: PaidVoiceProvider = {
  id: 'none',
  async synthesize() {
    throw new NotImplementedError('no paid voice provider is written in phase 1 (the budget gate passed, nothing was called)')
  }
}

/** A rough estimate for the gate, USD per 1000 characters (a typical vendor price; `seed/config/prices.md` will hold the checked one). */
export const PAID_VOICE_USD_PER_1K_CHARS = 0.03

export interface PaidSpeakerOptions {
  store: SeriesStore
  series: string
  episode: string
  provider?: PaidVoiceProvider
}

export function paidSpeaker(o: PaidSpeakerOptions): Speaker {
  const provider = o.provider ?? noPaidVoice
  return {
    provider: 'paid',
    async speak(jobs, io) {
      const failed: SpeakOutcome['failed'] = []
      for (const job of jobs) {
        io.signal?.throwIfAborted()
        try {
          const r = await charge(
            { store: o.store, series: o.series, episode: o.episode, provider: `paid-voice:${provider.id}`, model: 'tts', what: `voice ${job.lang} ${job.id}`, currency: 'usd', estimate: Math.round((job.text.length / 1000) * PAID_VOICE_USD_PER_1K_CHARS * 1e6) / 1e6 },
            () => provider.synthesize(job.text, job.lang, job.voice.gemini, job.style)
          )
          await io.onSpoken(job, { file: r.value.file, provider: 'paid', engine: provider.id })
        } catch (e) {
          if (io.signal?.aborted) throw e
          failed.push({ job, error: (e as Error).message })
        }
      }
      return { failed }
    }
  }
}
