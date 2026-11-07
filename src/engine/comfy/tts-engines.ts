import { languageInfo } from '../../shared/languages'
import { saveAudioNode } from './audio-save'
import type { BuildOpts, EngineDef, Graph } from './graphs'

/**
 * The local ComfyUI audio engines: the TTS Audio Suite voice models (OmniVoice, Higgs Audio v3, Chatterbox 23L, VibeVoice,
 * Qwen3-TTS, IndexTTS-2, F5-TTS) and MOSS-SoundEffect v2 for sound effects. Each spec is the capability metadata the Voice tab,
 * the job planner and the client share: the node class, the language coverage, whether a reference clip and its transcript are
 * needed, the required widget values (taken from the live `/object_info` and frozen as presets) and the graph builder.
 *
 * Graph shape of a voice clip:
 *   1  <engine node>  preset + language/style/speed + seed-free settings
 *   2  LoadAudio      { audio: <uploaded clip> }                                    (only with a reference)
 *   3  CharacterVoicesNode { voice_name:'none', reference_text, trim_start:0, trim_end:0, customized:false, opt_audio_input:['2',0] }
 *   4  UnifiedTTSTextNode { TTS_engine:['1',0], text, narrator_voice:'none', seed, enable_chunking:true,
 *       max_chars_per_chunk:<config>, chunk_combination_method:'crossfade', silence_between_chunks_ms:100,
 *       enable_audio_cache:true, batch_size:0, ...(ref ? { opt_narrator:['3',0] } : {}) }
 *   5  SaveAudio / SaveAudioAdvanced { audio:['4',0], filename_prefix }
 * A sound effect is engine node -> UnifiedSoundEffectsNode -> save node (ids 1, 2, 3).
 */

/** `required` skips the clip when it is missing, `optional` uses it when present, `none` never sends it. */
export type ClipPolicy = 'required' | 'optional' | 'none'

interface TtsSpec {
  id: string
  label: string
  /** The ComfyUI engine node class. */
  node: string
  task: 'tts' | 'sfx'
  /** The language codes it reads, or `'*'` for any. Empty for a sound-effect engine. */
  languages: string[] | '*'
  clone: ClipPolicy
  refText: ClipPolicy
  /** Every required widget input, as `/object_info` lists it. */
  preset: Record<string, unknown>
  /** Extra defaults of the graph builder (the SFX length). */
  defaults?: Record<string, unknown>
  /** The input that takes a language label, and the project code -> label table when it is a fixed enum. */
  language?: { input: string; map?: Record<string, string> }
  /** The input that takes the delivery style (`instruct`). */
  instruct?: string
  /** The style is only used when it is inline tags (`<|...|>`) prepended to the text (Higgs Audio v3). */
  inlineStyle?: boolean
  /** Without a transcript, use the clip in x-vector-only mode (Qwen3-TTS). */
  xVectorOnlyWithoutRefText?: boolean
  /** With a clip but no transcript, generate ref-free from the style instead of using the clip (OmniVoice). */
  refFreeWithoutTranscript?: boolean
  /** The node whose output is the clip. */
  outputNode: string
  /** The ComfyUI nodes every job of this engine needs (the suite). */
  requiresNodes: string[]
}

// the default save path: `SaveAudioAdvanced` for mp3/opus/flac, `SaveAudio` only for wav (both must be installed, a project may
// switch format at any time)
const SPEECH_NODES = ['UnifiedTTSTextNode', 'CharacterVoicesNode', 'LoadAudio', 'SaveAudio', 'SaveAudioAdvanced']

const CHATTERBOX_LANGUAGES: Record<string, string> = {
  ar: 'Arabic', da: 'Danish', de: 'German', el: 'Greek', en: 'English', es: 'Spanish', fi: 'Finnish', fr: 'French', he: 'Hebrew',
  hi: 'Hindi', it: 'Italian', ja: 'Japanese', ko: 'Korean', nl: 'Dutch', no: 'Norwegian', pl: 'Polish', pt: 'Portuguese',
  ru: 'Russian', sv: 'Swedish', tr: 'Turkish', zh: 'Chinese'
}

const QWEN3_LANGUAGES: Record<string, string> = {
  zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean', de: 'German', fr: 'French', ru: 'Russian', pt: 'Portuguese', es: 'Spanish', it: 'Italian'
}

const INDEX_LANGUAGES: Record<string, string> = { en: 'English', zh: 'Chinese', ja: 'Japanese', es: 'Spanish', ar: 'Arabic' }

// the language input of F5-TTS chooses the model variant, not a spoken language
const F5_MODELS: Record<string, string> = {
  en: 'F5TTS_v1_Base', de: 'F5-DE', es: 'F5-ES', fr: 'F5-FR', ja: 'F5-JP', it: 'F5-IT', pt: 'F5-PT-BR', pl: 'F5-Polish', hi: 'F5-Hindi-Small'
}

const SPECS: TtsSpec[] = [
  {
    id: 'omnivoice',
    label: 'OmniVoice (600+ languages)',
    node: 'OmniVoiceEngineNode',
    task: 'tts',
    languages: '*',
    clone: 'optional',
    refText: 'optional',
    refFreeWithoutTranscript: true,
    language: { input: 'language' },
    instruct: 'instruct',
    preset: { model_variant: 'OmniVoice', device: 'auto', num_step: 32, guidance_scale: 2, t_shift: 0.1, speed: 1, duration: 0 },
    outputNode: '5',
    requiresNodes: ['OmniVoiceEngineNode', ...SPEECH_NODES]
  },
  {
    id: 'higgs-audio-v3',
    label: 'Higgs Audio v3 (100+ languages)',
    node: 'HiggsAudioV3EngineNode',
    task: 'tts',
    languages: '*',
    clone: 'optional',
    refText: 'optional',
    inlineStyle: true,
    preset: { model: 'higgs-audio-v3-tts-4b', device: 'auto', dtype: 'auto', attention: 'auto', temperature: 1, top_p: 0.95, top_k: 50, max_new_tokens: 2048 },
    outputNode: '5',
    requiresNodes: ['HiggsAudioV3EngineNode', ...SPEECH_NODES]
  },
  {
    id: 'chatterbox-23lang',
    label: 'Chatterbox 23 languages',
    node: 'ChatterBoxOfficial23LangEngineNode',
    task: 'tts',
    languages: Object.keys(CHATTERBOX_LANGUAGES),
    clone: 'optional',
    refText: 'none',
    language: { input: 'language', map: CHATTERBOX_LANGUAGES },
    preset: { model_version: 'v3', device: 'auto', exaggeration: 0.5, temperature: 0.8, cfg_weight: 0.5, repetition_penalty: 1.2, min_p: 0.05, top_p: 1 },
    outputNode: '5',
    requiresNodes: ['ChatterBoxOfficial23LangEngineNode', ...SPEECH_NODES]
  },
  {
    id: 'vibevoice',
    label: 'VibeVoice 7B (English, Chinese)',
    node: 'VibeVoiceEngineNode',
    task: 'tts',
    languages: ['en', 'zh'],
    clone: 'optional',
    refText: 'none',
    preset: {
      model: 'vibevoice-7B', device: 'auto', quantize_llm_4bit: false, attention_mode: 'auto', multi_speaker_mode: 'Custom Character Switching',
      cfg_scale: 3, inference_steps: 3, use_sampling: false, temperature: 0.95, top_p: 0.95, chunk_minutes: 0, max_new_tokens: 0
    },
    outputNode: '5',
    requiresNodes: ['VibeVoiceEngineNode', ...SPEECH_NODES]
  },
  {
    id: 'qwen3-tts',
    label: 'Qwen3-TTS 1.7B (10 languages, cloning)',
    node: 'Qwen3TTSEngineNode',
    task: 'tts',
    languages: Object.keys(QWEN3_LANGUAGES),
    clone: 'optional',
    refText: 'optional',
    xVectorOnlyWithoutRefText: true,
    language: { input: 'language', map: QWEN3_LANGUAGES },
    instruct: 'instruct',
    preset: { model_variant: 'local:Qwen3-TTS-12Hz-1.7B-Base', device: 'auto', voice_preset: 'None (Zero-shot / Custom)', top_k: 50, top_p: 1, temperature: 0.9, repetition_penalty: 1.05, max_new_tokens: 2048 },
    outputNode: '5',
    requiresNodes: ['Qwen3TTSEngineNode', ...SPEECH_NODES]
  },
  {
    id: 'index-tts-2',
    label: 'IndexTTS-2 (5 languages, cloning)',
    node: 'IndexTTSEngineNode',
    task: 'tts',
    languages: Object.keys(INDEX_LANGUAGES),
    clone: 'required',
    refText: 'none',
    language: { input: 'language', map: INDEX_LANGUAGES },
    preset: {
      model_path: 'local:IndexTTS-2', device: 'auto', emotion_alpha: 1, use_random: false, max_text_tokens_per_segment: 120, interval_silence: 200,
      temperature: 0.8, top_p: 0.8, top_k: 30, do_sample: true, length_penalty: 0, num_beams: 3, repetition_penalty: 10, max_mel_tokens: 1500,
      use_fp16: true, use_deepspeed: false
    },
    outputNode: '5',
    requiresNodes: ['IndexTTSEngineNode', ...SPEECH_NODES]
  },
  {
    id: 'f5-tts',
    label: 'F5-TTS (10 languages, cloning)',
    node: 'F5TTSEngineNode',
    task: 'tts',
    languages: Object.keys(F5_MODELS),
    clone: 'required',
    refText: 'required',
    // the language input is the model variant: F5-DE, F5-JP, ...
    language: { input: 'language', map: F5_MODELS },
    preset: { device: 'auto', temperature: 0.8, speed: 1, target_rms: 0.1, cross_fade_duration: 0.15, nfe_step: 32, cfg_strength: 2 },
    outputNode: '5',
    requiresNodes: ['F5TTSEngineNode', ...SPEECH_NODES]
  },
  {
    id: 'moss-soundeffect-v2',
    label: 'MOSS-SoundEffect v2 (sound effects)',
    node: 'MossSoundEffectV2EngineNode',
    task: 'sfx',
    languages: [],
    clone: 'none',
    refText: 'none',
    preset: { model: 'MOSS-SoundEffect-v2.0', device: 'auto', dtype: 'auto', inference_steps: 100, cfg_scale: 4, sigma_shift: 5 },
    defaults: { seconds: 5 },
    outputNode: '3',
    requiresNodes: ['MossSoundEffectV2EngineNode', 'UnifiedSoundEffectsNode', 'SaveAudio', 'SaveAudioAdvanced']
  }
]

const link = (id: number | string, slot = 0): [string, number] => [String(id), slot]

/** The engine node's own inputs: the frozen preset, then the language label, the style and (for SFX) the negative prompt. */
function engineInputs(spec: TtsSpec, o: BuildOpts): Record<string, unknown> {
  const inputs: Record<string, unknown> = { ...spec.preset }
  if (spec.language && o.languageName !== undefined) inputs[spec.language.input] = o.languageName
  if (spec.instruct && o.instruct?.trim()) inputs[spec.instruct] = o.instruct.trim()
  if (spec.task === 'sfx') inputs.negative_prompt = o.negativePrompt ?? ''
  // only the engines whose preset has it (OmniVoice, F5) take the speed
  if ('speed' in spec.preset && o.speed !== undefined) inputs.speed = o.speed
  if (spec.xVectorOnlyWithoutRefText) inputs.x_vector_only_mode = !o.voiceRefText?.trim()
  return inputs
}

/** The text spoken: an inline-tag style (Higgs Audio v3) goes before the line, any other style never reaches the text. */
function spokenText(spec: TtsSpec, o: BuildOpts): string {
  const text = o.text ?? ''
  if (!spec.inlineStyle) return text
  const style = o.instruct?.trim() ?? ''
  return /<\|[^|>]+\|>/.test(style) ? `${style} ${text}` : text
}

function buildTtsGraph(spec: TtsSpec, o: BuildOpts): Graph {
  const graph: Graph = { 1: { class_type: spec.node, inputs: engineInputs(spec, o) } }
  const withRef = !!o.voiceRef
  if (withRef) {
    graph[2] = { class_type: 'LoadAudio', inputs: { audio: o.voiceRef } }
    graph[3] = {
      class_type: 'CharacterVoicesNode',
      inputs: { voice_name: 'none', reference_text: o.voiceRefText ?? '', trim_start: 0, trim_end: 0, customized: false, opt_audio_input: link(2) }
    }
  }
  graph[4] = {
    class_type: 'UnifiedTTSTextNode',
    inputs: {
      TTS_engine: link(1),
      text: spokenText(spec, o),
      narrator_voice: 'none',
      seed: o.seed ?? 0,
      enable_chunking: true,
      max_chars_per_chunk: o.chunkChars ?? 400,
      chunk_combination_method: 'crossfade',
      silence_between_chunks_ms: 100,
      enable_audio_cache: true,
      batch_size: 0,
      ...(withRef ? { opt_narrator: link(3) } : {})
    }
  }
  graph[5] = saveAudioNode(o.format, o.quality, 4, o.filenamePrefix)
  return graph
}

function buildSfxGraph(spec: TtsSpec, o: BuildOpts): Graph {
  const graph: Graph = { 1: { class_type: spec.node, inputs: engineInputs(spec, o) } }
  const description = (o.text ?? '').trim() || (o.prompt ?? '').trim()
  graph[2] = {
    class_type: 'UnifiedSoundEffectsNode',
    inputs: {
      TTS_engine: link(1),
      description,
      duration_seconds: o.seconds ?? 5,
      seed: o.seed ?? 0,
      crossfade_seconds: 1,
      enable_audio_cache: true
    }
  }
  graph[3] = saveAudioNode(o.format, o.quality, 2, o.filenamePrefix)
  return graph
}

function defOf(spec: TtsSpec): EngineDef {
  return {
    kind: 'audio',
    label: spec.label,
    task: spec.task,
    node: spec.node,
    preset: spec.preset,
    outputNode: spec.outputNode,
    requiresNodes: spec.requiresNodes,
    languages: spec.languages,
    clone: spec.clone,
    refText: spec.refText,
    ...(spec.language ? { language: spec.language } : {}),
    ...(spec.instruct ? { instruct: spec.instruct } : {}),
    ...(spec.inlineStyle ? { inlineStyle: true } : {}),
    ...(spec.xVectorOnlyWithoutRefText ? { xVectorOnlyWithoutRefText: true } : {}),
    ...(spec.refFreeWithoutTranscript ? { refFreeWithoutTranscript: true } : {}),
    defaults: spec.defaults ?? {},
    build: (o) => (spec.task === 'sfx' ? buildSfxGraph(spec, o) : buildTtsGraph(spec, o))
  }
}

/** The built-in TTS and SFX engines, in priority order (the default voice engine first, MOSS last). */
export const TTS_ENGINES: Record<string, EngineDef> = Object.fromEntries(SPECS.map((spec) => [spec.id, defOf(spec)]))

/** The engine ids a project may use as `voice.engine` / `voice.engines[lang]`, without `custom:`. */
export const TTS_ENGINE_IDS: readonly string[] = SPECS.map((spec) => spec.id)
/** The ids of the voice engines (task `tts`), in registry order. */
export const VOICE_ENGINE_IDS: readonly string[] = SPECS.filter((spec) => spec.task === 'tts').map((spec) => spec.id)

/** True when an engine reads the language (`'*'` reads every one). */
export function engineReadsLanguage(engine: Pick<EngineDef, 'languages'>, lang: string): boolean {
  const langs = engine.languages ?? '*'
  return langs === '*' || langs.includes(lang)
}

/** The language codes of an engine, for a message: `en, zh` or `any language`. */
export function engineLanguageList(engine: Pick<EngineDef, 'languages'>): string {
  const langs = engine.languages ?? '*'
  return langs === '*' ? 'any language' : langs.join(', ')
}

/**
 * The value the engine's language input takes for a project language: the node's label from the spec's map (the language enum
 * of Chatterbox/Qwen3/Index, or the F5 model variant), or the English language name when the node takes a free name
 * (OmniVoice). Undefined when the engine has no language input or does not read the language.
 */
export function engineLanguageValue(engine: Pick<EngineDef, 'languages' | 'language'>, lang: string): string | undefined {
  if (!engineReadsLanguage(engine, lang)) return undefined
  if (!engine.language) return undefined
  const mapped = engine.language.map?.[lang]
  if (mapped) return mapped
  if (engine.language.map) return undefined
  return languageInfo(lang)?.name ?? lang
}
