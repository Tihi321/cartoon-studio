import type { Lang } from '../../../shared/contracts'
import type { VoiceProviderUsed } from '../allocate'

/**
 * The shapes the voice providers share (CTS-06). A provider is a function over a list of clips: it never touches the manifest. Each clip it makes
 * goes to `io.onSpoken` at once (the runner normalises the audio and saves the manifest), and what it could not make is returned. A provider that is
 * down or whose quota is used up STOPS: the runner hands the clips that are left to the next provider of the clip's chain.
 */

export type VoiceProviderName = VoiceProviderUsed | 'paid'

/** How one character speaks one language: everything of the bible's `VoiceSpec` that changes the sound, resolved. */
export interface ClipVoice {
  /** The Gemini voice name (`Kore`). */
  gemini: string
  /** The VibeTTS voice id the bible names, or '' (VibeTTS's own for the language). */
  vibetts: string
  /** OmniVoice (or another ComfyUI engine): the attribute tags, the reference clip as an ABSOLUTE path (or null), its transcript and the seed. */
  comfy: { engine: string; instruct: string; ref: string | null; refText: string | null; seed: number }
}

/** A clip to speak (one script line in one language), as the runner prepared it. */
export interface ClipJob {
  /** The line id (`l01`). */
  id: string
  lang: Lang
  /** The speaking cast member. */
  speaker: string
  text: string
  /** The delivery style (empty: none): the Gemini `style` note; OmniVoice takes only attribute tags, see `voice.comfy.instruct`. */
  style: string
  speed: number
  voice: ClipVoice
  /** The `clipHash` of what makes the sound. */
  hash: string
  /** The character asked for this provider (`paid`, or `comfy` / `vibetts` pinned): the chain starts there. */
  pinned?: VoiceProviderName
}

export interface Spoken {
  /** The raw audio the provider wrote, in the run's temp folder (any format ffmpeg reads). */
  file: string
  provider: VoiceProviderName
  /** The engine that spoke it: `omnivoice`, `kokoro`, `supertonic`, `gemini`. */
  engine?: string
  /** The voice or the tags it spoke with. */
  voice?: string
  seed?: number
}

export interface SpeakIO {
  /** A folder the providers write into; it exists. */
  tmp: string
  signal?: AbortSignal
  log: (message: string) => void
  /** A clip was made: the runner stores it. Awaited, so the manifest follows every clip. */
  onSpoken: (job: ClipJob, spoken: Spoken) => Promise<void>
}

export interface SpeakOutcome {
  /** Clips that failed on their own (the others went on). */
  failed: { job: ClipJob; error: string }[]
  /** The provider cannot go on: the clips not made are left for the next provider. */
  stop?: { kind: 'down' | 'quota' | 'unreadable'; message: string }
}

export interface Speaker {
  provider: VoiceProviderName
  speak(jobs: ClipJob[], io: SpeakIO): Promise<SpeakOutcome>
}
