import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ComfyClient } from '../../comfy/client'
import { ENGINES, randomSeed } from '../../comfy/graphs'
import type { EngineDef } from '../../comfy/graphs'
import { comfyKindSwitch } from '../../comfy/kind-switch'
import { engineLanguageValue, engineReadsLanguage } from '../../comfy/tts-engines'
import type { SpeakOutcome, Speaker } from './types'

/**
 * ComfyUI TTS Audio Suite, the local Croatian voice: **OmniVoice** (`OmniVoiceEngineNode` -> `UnifiedTTSTextNode` -> `SaveAudio`). The graph is built
 * by `comfy/tts-engines.ts` and posted to ComfyUI `:8188/prompt` by `comfy/client.ts` (which then polls `/history/<id>` and downloads the output),
 * exactly as the working reference `creative-hub/.claude/temp/voice-test/gen.py` does. One request per clip; the lines of a batch are sent back to
 * back so the model stays warm, and ComfyUI's memory is freed first when the last work it did was images (`comfyKindSwitch`).
 *
 * OmniVoice reads its `instruct` as ATTRIBUTE TAGS, not free style words; a character's voice is its tags plus an optional reference clip with its
 * transcript (a reference takes priority in the node).
 */

// The accepted tags, from the installed model: `omnivoice/utils/voice_design.py` (`_INSTRUCT_CATEGORIES`, checked 2026-11-07). One tag per category.
const INSTRUCT_CATEGORIES: readonly (readonly string[])[] = [
  ['male', 'female'],
  ['child', 'teenager', 'young adult', 'middle-aged', 'elderly'],
  ['very low pitch', 'low pitch', 'moderate pitch', 'high pitch', 'very high pitch'],
  ['whisper'],
  ['american accent', 'british accent', 'australian accent', 'chinese accent', 'canadian accent', 'indian accent', 'korean accent', 'portuguese accent', 'russian accent', 'japanese accent']
]
export const OMNIVOICE_TAGS: readonly string[] = INSTRUCT_CATEGORIES.flat()

export interface InstructCheck {
  /** The tags to send: the valid ones, one per category, in the order given. */
  tags: string[]
  /** What was dropped and why (empty: the instruct is fine). */
  problems: string[]
  /** `tags` joined with ", ". */
  instruct: string
}

/** Validates a bible `comfy.instruct` against the accepted OmniVoice tags: comma separated, English, one per category. */
export function checkOmniInstruct(instruct: string): InstructCheck {
  const tags: string[] = []
  const problems: string[] = []
  const used = new Map<number, string>()
  for (const raw of instruct.split(',')) {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, ' ')
    if (!tag) continue
    const cat = INSTRUCT_CATEGORIES.findIndex((c) => c.includes(tag))
    if (cat < 0) problems.push(`"${tag}" is not an OmniVoice tag (accepted: ${OMNIVOICE_TAGS.join(', ')})`)
    else if (used.has(cat)) problems.push(`"${tag}" dropped: "${used.get(cat)}" is already given for that attribute`)
    else {
      used.set(cat, tag)
      tags.push(tag)
    }
  }
  return { tags, problems, instruct: tags.join(', ') }
}

/** A failure message that says ComfyUI is not there (the provider stops instead of failing every clip). */
export const comfyIsDown = (message: string): boolean => /unreachable|ECONNREFUSED|fetch failed|did not answer|lane is busy/i.test(message)

/** The voice engine definition for an id, or the reason it cannot speak `lang`. */
export function resolveVoiceEngine(id: string, lang: string): { def: EngineDef } | { reason: string } {
  const def = ENGINES[id]
  if (!def || def.task !== 'tts') return { reason: `"${id}" is not a ComfyUI voice engine` }
  if (!engineReadsLanguage(def, lang)) return { reason: `the engine "${id}" does not read ${lang}` }
  return { def }
}

export interface ComfySpeakerOptions {
  comfy: ComfyClient
  /** The engine used when the bible names none (`config/voice.md` `engine`). */
  defaultEngine: string
  dataDir: string
  series: string
  chunkChars: number
  /** Tests: replaces the memory switch. */
  kindSwitch?: (kind: 'voice') => Promise<unknown>
  /** Reports a dropped tag. */
  warn?: (message: string) => void
}

export function comfySpeaker(o: ComfySpeakerOptions): Speaker {
  const warned = new Set<string>()
  return {
    provider: 'comfy',
    async speak(jobs, io) {
      const failed: SpeakOutcome['failed'] = []
      await (o.kindSwitch ? o.kindSwitch('voice') : comfyKindSwitch('voice', { dataDir: o.dataDir, log: io.log })).catch(() => undefined)
      for (const job of jobs) {
        io.signal?.throwIfAborted()
        const v = job.voice.comfy
        const engineId = v.engine || o.defaultEngine
        const r = resolveVoiceEngine(engineId, job.lang)
        if ('reason' in r) {
          failed.push({ job, error: r.reason })
          continue
        }
        const { def } = r
        let instruct = ''
        if (def.instruct) {
          const check = checkOmniInstruct(v.instruct)
          instruct = check.instruct
          for (const p of check.problems) {
            if (warned.has(`${job.speaker}:${p}`)) continue
            warned.add(`${job.speaker}:${p}`)
            o.warn?.(`${job.speaker} (${job.lang}): ${p}`)
          }
        }
        // a reference clip needs its transcript to clone (OmniVoice): without one the tags speak
        let ref = v.ref
        if (ref && !v.refText?.trim() && def.refFreeWithoutTranscript) ref = null
        if (ref && !(await fs.stat(ref).then((s) => s.isFile(), () => false))) {
          o.warn?.(`${job.speaker} (${job.lang}): the reference clip ${path.basename(ref)} is missing: the tags speak`)
          ref = null
        }
        try {
          const res = await o.comfy.generate({
            engine: engineId,
            text: job.text,
            language: job.lang,
            ...(def.language ? { languageName: engineLanguageValue(def, job.lang) } : {}),
            ...(instruct ? { instruct } : {}),
            seed: Number.isInteger(v.seed) ? v.seed : randomSeed(),
            format: 'wav',
            chunkChars: o.chunkChars,
            speed: job.speed,
            ...(ref ? { voiceRef: ref, voiceRefText: v.refText ?? '' } : {}),
            filenamePrefix: `cts_voice_${o.series}`,
            signal: io.signal
          })
          const file = path.join(io.tmp, `comfy-${job.lang}-${job.id}.${res.ext || 'wav'}`)
          await fs.writeFile(file, res.bytes)
          await io.onSpoken(job, { file, provider: 'comfy', engine: engineId, voice: instruct || (ref ? 'reference clip' : 'default'), seed: res.seed })
        } catch (e) {
          if (io.signal?.aborted) throw e
          const m = (e as Error).message
          if (comfyIsDown(m)) return { failed, stop: { kind: 'down', message: m } }
          failed.push({ job, error: m })
        }
      }
      return { failed }
    }
  }
}
