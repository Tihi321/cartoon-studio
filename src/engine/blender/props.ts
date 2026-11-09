import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PATH_MARK_TOLERANCE, PATH_WIDTH_DEFAULT } from '../../shared/contracts'
import type { PathKind, Set3d, Set3dPath } from '../../shared/contracts'
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

// ---- paths (HUB-31): the roads and tracks of a set ----

type XY = readonly [number, number]

/** Distance in metres from a ground point to a path's centre line (a polyline). */
export function distanceToPath(p: XY, path: Pick<Set3dPath, 'points'>): number {
  let best = Infinity
  const pts = path.points
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i]!
    const [bx, by] = pts[i + 1]!
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const u = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2)) : 0
    best = Math.min(best, Math.hypot(p[0] - (ax + u * dx), p[1] - (ay + u * dy)))
  }
  return best
}

export const pathWidth = (path: Set3dPath): number => path.width ?? PATH_WIDTH_DEFAULT[path.kind]

/** The ids of the set's paths of this kind that pass within `PATH_MARK_TOLERANCE` of the point (nearest first). */
export function pathsAt(set: Set3d, p: XY, kind: PathKind): string[] {
  return Object.entries(set.paths ?? {})
    .filter(([, x]) => x.kind === kind)
    .map(([id, x]) => [id, distanceToPath(p, x)] as const)
    .filter(([, d]) => d <= PATH_MARK_TOLERANCE)
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id)
}

/** E_PATH_BLOCKED: every (path, prop) pair where the path's strip (half its width) runs through the prop's footprint. Props with no footprint (road, track, crossing, flowers, cloud) never block. */
export function blockedPaths(set: Set3d, scriptsDir?: string): { path: string; prop: string; kind: string; distance: number; clear: number }[] {
  const out: { path: string; prop: string; kind: string; distance: number; clear: number }[] = []
  for (const [id, path] of Object.entries(set.paths ?? {})) {
    for (const prop of set.props) {
      let r: number
      try {
        r = propFootprint(prop.kind, prop.scale ?? 1, scriptsDir)
      } catch {
        continue
      }
      if (r <= 0) continue
      const clear = r + pathWidth(path) / 2
      const d = distanceToPath(prop.at, path)
      if (d < clear) out.push({ path: id, prop: prop.id, kind: prop.kind, distance: d, clear })
    }
  }
  return out
}
