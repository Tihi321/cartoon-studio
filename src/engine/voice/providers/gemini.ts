import { FlowError } from '../../studios/flow'
import type { FlowClient } from '../../studios/flow'
import type { GeminiQuota } from '../quota'
import type { SpeakOutcome, Speaker } from './types'

/**
 * Google's free Gemini voices through flow-music-mcp's `flow_narrate` (checked in `flow-music-mcp/src/flow/local-tools.ts`, 2026-11-07: args
 * `{ out?, name?, engine: gemini|windows|flow, text (max 4000), voice, style?, format: mp3|wav|ogg|m4a, max_credits? }`; the engine is always
 * `gemini` here, never the paid `flow`). One request per clip, each counted in `state/gemini-tts.json` BEFORE it is sent (a retry counts too), the
 * retry and quota handling ported from Edu Studio's `speak.ts`.
 */

/** The wait Google asks for in a 429 text: `Please retry in 21h21m47.5s`, `retry in 45s`, or a `retryDelay` of `"76907s"`. Undefined when the text has none. */
export function parseRetryDelayMs(message: string): number | undefined {
  const unit = { h: 3_600_000, m: 60_000, s: 1000 } as const
  const sum = (text: string): number => [...text.matchAll(/(\d+(?:\.\d+)?)\s*([hms])/gi)].reduce((t, m) => t + Number(m[1]) * unit[m[2]!.toLowerCase() as keyof typeof unit], 0)
  const retryIn = /retry in\s+((?:\d+(?:\.\d+)?\s*[hms]\s*)+)/i.exec(message)
  if (retryIn) return Math.round(sum(retryIn[1]!))
  const delay = /retryDelay\W+(\d+(?:\.\d+)?)\s*s/i.exec(message)
  return delay ? Math.round(Number(delay[1]) * 1000) : undefined
}

/** A retry time longer than this (and than the whole retry schedule) is a daily quota, not a burst: waiting it out in the job makes no sense. */
export const QUOTA_MIN_MS = 300_000
/** The text a `flow_narrate` call takes for the engines gemini and windows. */
export const FLOW_TEXT_MAX = 4000
/** The Gemini voice a character gets when the bible names none. */
export const DEFAULT_GEMINI_VOICE = 'Kore'

/** `gemini:Kore` and `Kore` both give `Kore`. */
export const geminiVoiceName = (v: string): string => (v.startsWith('gemini:') ? v.slice('gemini:'.length) : v).trim() || DEFAULT_GEMINI_VOICE

export interface GeminiSpeakerOptions {
  flow: FlowClient
  quota: GeminiQuota
  /** Pause between two requests (ms), so the free tier is not hit at once. */
  pauseMs: number
  /** How often a clip is retried on a rate limit (each retry counts against the quota). */
  retries: number
  backoffMs?: number[]
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
}

export function geminiSpeaker(o: GeminiSpeakerOptions): Speaker {
  const backoff = o.backoffMs ?? [10_000, 30_000, 90_000]
  return {
    provider: 'gemini',
    async speak(jobs, io) {
      const failed: SpeakOutcome['failed'] = []
      const schedule = Array.from({ length: o.retries }, (_, k) => backoff[Math.min(k, backoff.length - 1)] ?? 90_000).reduce((a, b) => a + b, 0)
      let first = true
      for (const job of jobs) {
        io.signal?.throwIfAborted()
        if (!first && o.pauseMs > 0) await o.sleep(o.pauseMs, io.signal)
        first = false
        if (job.text.length > FLOW_TEXT_MAX) {
          failed.push({ job, error: `the text is ${job.text.length} characters, over the ${FLOW_TEXT_MAX} that the narration takes` })
          continue
        }
        const voice = geminiVoiceName(job.voice.gemini)
        for (let attempt = 0; ; attempt++) {
          const left = (await o.quota.read()).remaining
          if (left <= 0) return { failed, stop: { kind: 'quota', message: "today's Gemini TTS quota is used up" } }
          await o.quota.add() // every request that reaches Gemini counts, a retry too
          try {
            // the engine is always `gemini`: the paid Flow engine is never sent
            const r = await o.flow.narrate({ text: job.text, engine: 'gemini', voice, ...(job.style ? { style: job.style } : {}), out: io.tmp, name: `${job.lang}-${job.id}`, format: 'wav', signal: io.signal })
            await io.onSpoken(job, { file: r.file, provider: 'gemini', engine: 'gemini', voice })
            break
          } catch (e) {
            if (io.signal?.aborted) throw e
            if (e instanceof FlowError && (e.kind === 'unreachable' || e.kind === 'signedOut')) return { failed, stop: { kind: 'down', message: e.message } }
            if (e instanceof FlowError && e.kind === 'rateLimit') {
              const retryMs = parseRetryDelayMs(e.message)
              if (retryMs !== undefined && retryMs > Math.max(schedule, QUOTA_MIN_MS)) {
                await o.quota.exhaust()
                return { failed, stop: { kind: 'quota', message: `Gemini's daily voice quota is used up (Google asks to retry in ${Math.round(retryMs / 60_000)} min)` } }
              }
              if (attempt < o.retries) {
                const wait = backoff[Math.min(attempt, backoff.length - 1)] ?? 90_000
                io.log(`voice ${job.lang}: ${job.id}: rate limited, waiting ${Math.round(wait / 1000)} s (retry ${attempt + 1} of ${o.retries})`)
                await o.sleep(wait, io.signal)
                continue
              }
            }
            failed.push({ job, error: (e as Error).message })
            break
          }
        }
      }
      return { failed }
    }
  }
}
