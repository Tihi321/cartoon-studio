import type { VoiceProvider } from '../../shared/media'

/** The providers the allocation chains. `paid` is never in a chain: a character that asks for it is handled by the runner (CTS-06). */
export type VoiceProviderUsed = 'gemini' | 'vibetts' | 'comfy'

/** The allocation of one language: who speaks it, in which order the providers are tried, and why. */
export interface VoiceAllocationEntry {
  lang: string
  /** Clips that need speaking. */
  need: number
  /** The first provider of the chain, or `none` when nothing can speak the language (placeholders). */
  provider: VoiceProviderUsed | 'none'
  chain: VoiceProviderUsed[]
  reason: string
  /** Filled by the runner: clips made per provider, and placeholders. */
  made?: Partial<Record<VoiceProviderUsed, number>>
  placeholders?: number
}

/** The local chain per language, from `config/voice.md` `localOrder` (CTS-06 change against Edu Studio, which always tried VibeTTS first). */
export type LocalOrder = Record<string, readonly ('vibetts' | 'comfy')[]>

/** Croatian goes to OmniVoice (ComfyUI) first with Supertonic (VibeTTS) as the fallback; English to Kokoro (VibeTTS) first; any other language is VibeTTS first. */
export const DEFAULT_LOCAL_ORDER: LocalOrder = { hr: ['comfy', 'vibetts'], en: ['vibetts', 'comfy'] }
const FALLBACK_ORDER: readonly ('vibetts' | 'comfy')[] = ['vibetts', 'comfy']

/**
 * The hub's voice allocation rule (EGS-17), pure so it can be unit-tested without a provider:
 *
 *   - Google's free Gemini TTS allows 10 requests a day. `remaining = limit - used` (the counter is `quota.ts`).
 *   - Languages are allocated WHOLE (a language never mixes providers in one run), Croatian first, then English, then the rest by code:
 *       a language whose clips (the ones that need speaking) fit in what is left goes to Gemini and uses it up; else it goes local.
 *     So hr and en together over the quota: Croatian on Gemini, English local; both fit: both Gemini; neither fits: both local.
 *   - Local means VibeTTS when it reads the language (Kokoro: English and a few others, never Croatian or German; Supertonic or Higgs: Croatian, German; `reads` is a probe of the `list_voices` language codes, not a list in code), else ComfyUI TTS; when the first local provider is
 *     down the other one takes over; when nothing can speak, the clips become placeholders and warnings (never a failed run).
 *   - Gemini down (flow-music-mcp not running, signed out, no key) or a quota error in the middle of a run: the rest of that language falls back to
 *     local (the chain below says in which order; `run.ts` follows it); clips already made stay.
 *   - A course may force a provider (`media.voice.provider`): `vibetts` and `comfy` never use Gemini and try that provider first; `gemini` allocates
 *     like `auto` (the quota still applies, a language that does not fit goes local).
 */

/** Language codes a VibeTTS engine never reads, whatever a listing claims (Kokoro has no German or Croatian voice). */
const NEVER_READS: Record<string, readonly string[]> = { kokoro: ['de', 'hr'] }

/** True when a VibeTTS voice (from `list_voices`) reads `lang`: the one place that decides it. */
export const voiceReads = (v: { engine?: string; languages: readonly string[] }, lang: string): boolean =>
  v.languages.includes(lang) && !(NEVER_READS[(v.engine ?? '').toLowerCase()] ?? []).includes(lang)

/** What can speak what, as the run probed it. */
export interface VoiceAvailability {
  /** flow-music-mcp is up, Google Flow is signed in and the Gemini voices are ready. */
  gemini: { up: boolean; reason?: string }
  /** VibeTTS answers and lists a voice for the language. */
  vibetts: { up: boolean; reads: (lang: string) => boolean; reason?: string }
  /** ComfyUI's TTS engine for the language exists (ComfyUI itself is assumed up: a call that finds it down moves the clips on). */
  comfy: { up: boolean; reads: (lang: string) => boolean; reason?: string }
}

export interface AllocationInput {
  /** The clips that need speaking, per language (the clips the hash index already has are not counted). */
  need: Record<string, number>
  provider: VoiceProvider
  /** The Gemini counter: `limit - used` requests are left today. */
  quota: { limit: number; used: number }
  avail: VoiceAvailability
  /** Languages that never go to Gemini whatever the quota says. */
  localOnly?: readonly string[]
  /** The local chain per language (`config/voice.md` `localOrder`); default `DEFAULT_LOCAL_ORDER`. */
  localOrder?: LocalOrder
}

/** Croatian first (the hub prefers the free Gemini voices for it), then English, then the others by code. */
export function orderLanguages(langs: readonly string[]): string[] {
  const rank = (l: string): number => (l === 'hr' ? 0 : l === 'en' ? 1 : 2)
  return [...new Set(langs)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/**
 * The local providers that can speak `lang`, in the order they are tried: the language's `localOrder` (CTS-06; Edu Studio tried VibeTTS first),
 * a forced `comfy` or `vibetts` provider first. A provider missing from the configured order is appended, so the other one still takes over.
 */
export function localChain(lang: string, provider: VoiceProvider, avail: VoiceAvailability, localOrder: LocalOrder = DEFAULT_LOCAL_ORDER): VoiceProviderUsed[] {
  const base = [...(localOrder[lang] ?? FALLBACK_ORDER)]
  for (const p of FALLBACK_ORDER) if (!base.includes(p)) base.push(p)
  const order = provider === 'comfy' || provider === 'vibetts' ? [provider, ...base.filter((p) => p !== provider)] : base
  return order.filter((p) => avail[p].up && avail[p].reads(lang))
}

const whyNoLocal = (lang: string, avail: VoiceAvailability): string => {
  const one = (name: string, a: { up: boolean; reads: (l: string) => boolean; reason?: string }): string => (!a.up ? `${name} is not available${a.reason ? ` (${a.reason})` : ''}` : !a.reads(lang) ? `${name} does not read ${lang}` : '')
  return [one('VibeTTS', avail.vibetts), one('ComfyUI TTS', avail.comfy)].filter(Boolean).join('; ')
}

/** Allocates every language with clips to speak. The result has one entry per language of `need`, in allocation order. */
export function allocateVoice(input: AllocationInput): Record<string, VoiceAllocationEntry> {
  const out: Record<string, VoiceAllocationEntry> = {}
  let left = Math.max(0, input.quota.limit - input.quota.used)
  const useGemini = input.provider === 'auto' || input.provider === 'gemini'
  for (const lang of orderLanguages(Object.keys(input.need))) {
    const need = input.need[lang] ?? 0
    const local = localChain(lang, input.provider, input.avail, input.localOrder)
    if (need <= 0) {
      out[lang] = { lang, need: 0, provider: 'none', chain: [], reason: 'nothing to speak: every clip is up to date' }
      continue
    }
    let why = ''
    if (useGemini && input.localOnly?.includes(lang)) why = 'this language is spoken by the local voices only'
    else if (useGemini) {
      if (!input.avail.gemini.up) why = `Gemini is not available${input.avail.gemini.reason ? ` (${input.avail.gemini.reason})` : ''}`
      else if (need > left) why = `${need} clip(s) do not fit in the ${left} Gemini request(s) left today`
      else {
        left -= need
        out[lang] = { lang, need, provider: 'gemini', chain: ['gemini', ...local], reason: `${need} clip(s) fit in the Gemini quota (${left} request(s) left after them)` }
        continue
      }
    }
    if (local.length === 0) {
      out[lang] = { lang, need, provider: 'none', chain: [], reason: `nothing can speak ${lang}: ${whyNoLocal(lang, input.avail) || 'no provider'}; the clips become placeholders` }
      continue
    }
    const forced = input.provider === 'vibetts' || input.provider === 'comfy'
    out[lang] = { lang, need, provider: local[0]!, chain: local, reason: `${forced ? `the course asks for ${input.provider}` : why ? `${why}: local voice` : 'local voice'} (${local[0] === 'vibetts' ? 'VibeTTS' : 'ComfyUI TTS'})` }
  }
  return out
}
