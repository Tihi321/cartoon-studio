import type { GraphNode } from './graphs'

/**
 * The audio save node of a graph. `wav` uses the plain `SaveAudio` node; the compressed formats go through `SaveAudioAdvanced`,
 * which takes a per-format quality. Music, TTS and SFX graphs share it (kept out of `graphs.ts` so the TTS/SFX builders can
 * import it without a cycle).
 */
export function saveAudioNode(format: string | undefined, quality: string | undefined, sourceId: number, filenamePrefix: string): GraphNode {
  const audio: [string, number] = [String(sourceId), 0]
  const choice = String(format ?? 'flac').toLowerCase()
  if (choice === 'wav') return { class_type: 'SaveAudio', inputs: { audio, filename_prefix: filenamePrefix } }
  const inputs: Record<string, unknown> = { audio, filename_prefix: filenamePrefix, format: choice }
  // the format is a dynamic combo: its sub-input is named `format.quality` in the API graph (a plain `quality` is "missing")
  if (choice === 'mp3') inputs['format.quality'] = quality ?? 'V0'
  if (choice === 'opus') inputs['format.quality'] = quality ?? '128k'
  return { class_type: 'SaveAudioAdvanced', inputs }
}
