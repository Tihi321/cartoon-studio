import path from 'node:path'
import { StudioError } from '../../studios/chiptune'
import type { VibeTtsClient, VibeVoices } from '../../studios/vibetts'
import { voiceReads } from '../allocate'
import type { SpeakOutcome, Speaker } from './types'

/**
 * VibeTTS (the local tray app) through `synthesize_batch`: many clips in one call. Kokoro reads English, Supertonic is the Croatian fallback
 * (`voiceReads` in `allocate.ts` decides what reads a language; Kokoro never reads hr or de). Cartoon Studio never starts VibeTTS.
 */

/** The VibeTTS voice for a language: the configured one when it reads the language, else VibeTTS's own for it, else the first voice that reads it. */
export function vibeVoiceFor(v: VibeVoices, lang: string, configured: string): string | undefined {
  const reads = v.voices.filter((x) => voiceReads(x, lang))
  if (reads.length === 0) return undefined
  if (configured && reads.some((x) => x.id === configured)) return configured
  const own = v.languageVoices[lang]
  if (own && reads.some((x) => x.id === own)) return own
  return reads[0]!.id
}

export interface VibeSpeakerOptions {
  client: VibeTtsClient
  /** What `list_voices` said (probed once per run). */
  voices: VibeVoices
  /** Clips per `synthesize_batch` call (the runner saves after each call). */
  batch?: number
}

export function vibettsSpeaker(o: VibeSpeakerOptions): Speaker {
  const size = o.batch ?? 12
  const engineOf = (voice: string | undefined): string | undefined => o.voices.voices.find((v) => v.id === voice)?.engine || undefined
  return {
    provider: 'vibetts',
    async speak(jobs, io) {
      const failed: SpeakOutcome['failed'] = []
      for (let at = 0; at < jobs.length; at += size) {
        io.signal?.throwIfAborted()
        const part = jobs.slice(at, at + size)
        const voices = part.map((j) => vibeVoiceFor(o.voices, j.lang, j.voice.vibetts))
        let results
        try {
          results = await o.client.synthesizeBatch(
            part.map((j, i) => ({ text: j.text, output: path.join(io.tmp, `vibetts-${j.lang}-${j.id}.wav`), lang: j.lang, ...(voices[i] ? { voice: voices[i] } : {}), speed: j.speed })),
            { overwrite: true, signal: io.signal }
          )
        } catch (e) {
          if (io.signal?.aborted) throw e
          if (e instanceof StudioError && (e.kind === 'unreachable' || e.kind === 'timeout' || e.kind === 'protocol' || e.kind === 'http')) return { failed, stop: { kind: 'down', message: e.message } }
          for (const j of part) failed.push({ job: j, error: (e as Error).message })
          continue
        }
        for (const [i, j] of part.entries()) {
          const r = results[i]!
          if (!r.ok) {
            failed.push({ job: j, error: r.error ?? 'VibeTTS gave no reason' })
            continue
          }
          const engine = engineOf(voices[i])
          await io.onSpoken(j, { file: r.output, provider: 'vibetts', ...(engine ? { engine } : {}), ...(voices[i] ? { voice: voices[i] } : {}) })
        }
      }
      return { failed }
    }
  }
}
