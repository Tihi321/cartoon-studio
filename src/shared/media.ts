import { z } from 'zod'
import { BUILTIN_LANGUAGES } from './languages'

/**
 * The few media names the generators share: language codes, the voice provider ids, the chips of Chiptune Studio and what a ComfyUI engine
 * makes. The series contracts (bible, rig, set, episode, timeline) are in `contracts.ts`.
 */

export const LANGS: readonly string[] = BUILTIN_LANGUAGES.map((l) => l.code)
/** The format of a language code only: whether it is known is checked where a language enters a series (`assertKnownLang`). */
export const langSchema = z.string().regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/, 'a language code such as en, hr, de or pt-br')
export type Lang = z.infer<typeof langSchema>

/** The voice providers of a character (`auto` is the hub's allocation rule: Gemini within the free quota, else local). */
export const VOICE_PROVIDERS = ['auto', 'gemini', 'vibetts', 'comfy'] as const
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number]

/** The chips of Chiptune Studio. */
export const CHIPS = ['nes', 'gb', 'genesis', 'snes', 'pce', 'ps1', 'dreamcast'] as const
export type Chip = (typeof CHIPS)[number]

/** The default local TTS engine: OmniVoice reads every language, Croatian included. */
export const DEFAULT_VOICE_ENGINE = 'omnivoice'
/** What a ComfyUI engine makes: music (the default), speech (TTS) or a sound effect. */
export type EngineTask = 'music' | 'tts' | 'sfx'
