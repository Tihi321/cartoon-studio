import { FlowError, elevenCodeOf } from '../../studios/flow'
import type { ElevenCode, FlowClient } from '../../studios/flow'
import type { SpeakOutcome, Speaker } from './types'

/**
 * ElevenLabs' free tier through flow-music-mcp (HUB-31, FMM-17/18): `flow_narrate { engine: "elevenlabs", text, voice: <voiceId>, model,
 * voice_settings, language, timestamps: true }` returns a loudnormed 48 kHz WAV (not trimmed), word times from the alignment of the script text
 * (seconds from the file start) and `credits_estimate`. flow-music-mcp refuses before sending when the estimate is above `remaining - reserve`
 * (`E_ELEVEN_QUOTA`) or the account could bill money (`E_ELEVEN_PAID_TIER`), so this speaker never spends past the free quota. One request per
 * clip, one at a time; flow-music-mcp backs off a 429 itself.
 */

/** What a flow-music-mcp ElevenLabs error means for the run: `quota` and `down` stop the provider, `unreadable` too (the model or language). */
export const ELEVEN_STOP: Record<ElevenCode, 'quota' | 'down' | 'unreadable'> = {
  E_ELEVEN_QUOTA: 'quota',
  E_ELEVEN_PAID_TIER: 'quota',
  E_ELEVEN_KEY: 'down',
  E_ELEVEN_API: 'down',
  E_ELEVEN_BLOCKED: 'down',
  E_ELEVEN_LANG: 'unreadable',
  E_ELEVEN_MODEL: 'unreadable'
}

/** The text a `flow_narrate` call takes (the ElevenLabs endpoint takes more, but a cartoon line is short). */
export const ELEVEN_TEXT_MAX = 4000

export function elevenSpeaker(o: { flow: FlowClient }): Speaker {
  return {
    provider: 'elevenlabs',
    async speak(jobs, io) {
      const failed: SpeakOutcome['failed'] = []
      for (const job of jobs) {
        io.signal?.throwIfAborted()
        const v = job.voice.elevenlabs
        if (!v?.voiceId) {
          failed.push({ job, error: `${job.speaker} has no ElevenLabs voice id for ${job.lang} in the bible` })
          continue
        }
        if (job.text.length > ELEVEN_TEXT_MAX) {
          failed.push({ job, error: `the text is ${job.text.length} characters, over the ${ELEVEN_TEXT_MAX} a line takes` })
          continue
        }
        try {
          const r = await o.flow.narrate({
            text: job.text,
            engine: 'elevenlabs',
            voice: v.voiceId,
            model: v.model,
            ...(v.settings ? { voiceSettings: v.settings } : {}),
            language: job.lang,
            timestamps: true,
            out: io.tmp,
            name: `${job.lang}-${job.id}`,
            format: 'wav',
            signal: io.signal
          })
          await io.onSpoken(job, {
            file: r.file,
            provider: 'elevenlabs',
            engine: r.model ?? v.model,
            voice: v.voiceId,
            ...(r.words && r.words.length ? { words: r.words } : {}),
            ...(r.creditsEstimate !== undefined ? { credits: r.creditsEstimate } : {})
          })
          if (r.remainingAfter !== undefined && r.remainingAfter !== null) io.log(`voice ${job.lang}: ${job.id}: ElevenLabs ${r.creditsEstimate ?? '?'} credit(s), ${r.remainingAfter} left`)
        } catch (e) {
          if (io.signal?.aborted) throw e
          const msg = (e as Error).message
          const code = elevenCodeOf(msg)
          if (code) return { failed, stop: { kind: ELEVEN_STOP[code], message: msg.split('\n')[0]!.slice(0, 240) } }
          if (e instanceof FlowError && (e.kind === 'unreachable' || e.kind === 'lost')) return { failed, stop: { kind: 'down', message: msg } }
          failed.push({ job, error: msg })
        }
      }
      return { failed }
    }
  }
}
