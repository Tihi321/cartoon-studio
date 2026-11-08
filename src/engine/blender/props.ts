import { readFileSync } from 'node:fs'
import path from 'node:path'
import { findBlenderScripts } from './runner'

/**
 * The prop kit of the set builder (`blender/cts_blender/props.json`): per kind the footprint radius in metres at scale 1 (the ground a prop
 * takes, so a mark or a walk stays outside it) and the colour keys a set may override. The lint "marks clear of prop footprints" reads
 * `propFootprint`; the builder warns with the same numbers.
 */

export interface PropKind {
  footprint: number
  colours: string[]
}

let cached: { file: string; kinds: Record<string, PropKind> } | undefined

export function loadPropKit(scriptsDir = findBlenderScripts()): Record<string, PropKind> {
  if (!scriptsDir) throw new Error('the blender folder (blender/cts_blender/props.json) was not found; set CTS_BLENDER_SCRIPTS')
  const file = path.join(scriptsDir, 'cts_blender', 'props.json')
  if (cached?.file === file) return cached.kinds
  const kinds = (JSON.parse(readFileSync(file, 'utf8')) as { kinds: Record<string, PropKind> }).kinds
  cached = { file, kinds }
  return kinds
}

/** Radius in metres of the ground a prop of this kind and scale takes (0 for a cloud or a flower patch: walkable). */
export function propFootprint(kind: string, scale = 1, scriptsDir?: string): number {
  const k = loadPropKit(scriptsDir)[kind]
  if (!k) throw new Error(`unknown prop kind "${kind}"`)
  return k.footprint * scale
}
