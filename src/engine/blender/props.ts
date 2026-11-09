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

/** Where a ground point falls on a path: the arc length from the path's first point and the foot point on the centre line. */
export function projectOnPath(p: XY, path: Pick<Set3dPath, 'points'>): { s: number; at: [number, number]; distance: number } {
  const pts = path.points
  let best = { s: 0, at: [pts[0]![0], pts[0]![1]] as [number, number], distance: Infinity }
  let run = 0
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i]!
    const [bx, by] = pts[i + 1]!
    const dx = bx - ax
    const dy = by - ay
    const len = Math.hypot(dx, dy)
    const u = len > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (len * len))) : 0
    const at: [number, number] = [ax + u * dx, ay + u * dy]
    const d = Math.hypot(p[0] - at[0], p[1] - at[1])
    if (d < best.distance - 1e-12) best = { s: run + u * len, at, distance: d }
    run += len
  }
  return best
}

/**
 * The stretch of a path between two ground points, each put on the centre line: the polyline from `a` to `b` along the path (either way) with
 * its length. A vehicle move between two marks of one path follows it (CTS-35).
 */
export function pathBetween(path: Pick<Set3dPath, 'points'>, a: XY, b: XY): { points: [number, number][]; length: number } {
  const pa = projectOnPath(a, path)
  const pb = projectOnPath(b, path)
  const pts = path.points
  const cum = [0]
  for (let i = 0; i + 1 < pts.length; i++) cum.push(cum[i]! + Math.hypot(pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1]))
  const lo = Math.min(pa.s, pb.s)
  const hi = Math.max(pa.s, pb.s)
  const inner = pts.filter((_, i) => cum[i]! > lo + 1e-6 && cum[i]! < hi - 1e-6).map((q) => [q[0], q[1]] as [number, number])
  const forward: [number, number][] = [pa.s <= pb.s ? pa.at : pb.at, ...inner, pa.s <= pb.s ? pb.at : pa.at]
  const points = pa.s <= pb.s ? forward : forward.reverse()
  const r3 = (x: number) => Math.round(x * 1000) / 1000
  return { points: points.map(([x, y]) => [r3(x), r3(y)]), length: hi - lo }
}

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
