import { createHash } from 'node:crypto'
import { voiceManifestSchema } from '../../shared/contracts'
import type { Lang, VoiceLine, VoiceManifest } from '../../shared/contracts'
import { SeriesFileError } from '../series/service'
import type { SeriesStore } from '../series/service'
import type { ClipVoice } from './providers/types'

/**
 * The voice manifest of one language (`episodes/<ep>/voice/<lang>/manifest.json`, schema `cts.voice/1`) and the hash that decides whether a clip
 * is made again. Phase 1 spends nothing on voices: `costUsd` is always 0.
 */

/** What makes the sound of a clip, as one string: the voices of every provider (a clip is kept whatever provider made it, so all of them count). */
export function voiceKey(v: ClipVoice): string {
  return JSON.stringify([v.gemini, v.vibetts, v.comfy.engine, v.comfy.instruct, v.comfy.ref ?? '', v.comfy.refText ?? '', v.comfy.seed])
}

/** `sha1` of text + language + voice + speed + style, as Edu's `clipHash` (the voice here is the speaker's whole `voiceKey`). */
export const clipHash = (parts: { text: string; lang: string; voice: string; speed: number; style: string }): string =>
  createHash('sha1').update([parts.text, parts.lang, parts.voice, String(parts.speed), parts.style].join('\u0000')).digest('hex')

/** The file of a line, relative to the episode folder (the manifest's `file`). */
export const clipFile = (lang: string, line: string): string => `voice/${lang}/${line}.wav`

export function emptyManifest(episode: string, lang: Lang): VoiceManifest {
  return { schema: 'cts.voice/1', episode, lang, allocation: { provider: 'none', reason: 'nothing spoken yet' }, lines: {}, costUsd: 0 }
}

/** The manifest of a language, or null when there is none yet or it does not parse (the run makes a fresh one). */
export async function readManifest(store: SeriesStore, series: string, episode: string, lang: Lang): Promise<VoiceManifest | null> {
  try {
    return await store.readJson(store.paths(series).voiceManifest(episode, lang), voiceManifestSchema)
  } catch (e) {
    if (e instanceof SeriesFileError) return null
    throw e
  }
}

export async function writeManifest(store: SeriesStore, series: string, episode: string, manifest: VoiceManifest): Promise<void> {
  await store.writeJson(store.paths(series).voiceManifest(episode, manifest.lang), voiceManifestSchema, { ...manifest, costUsd: 0 })
}

/** True when the manifest line is a finished clip of exactly this hash (`placeholder` and `failed` lines are made again on the next run). */
export const isCurrent = (line: VoiceLine | undefined, hash: string): boolean => !!line && line.status === 'ok' && line.hash === hash
