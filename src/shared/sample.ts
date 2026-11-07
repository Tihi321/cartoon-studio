import type { CameraKey, Ease, NumKey } from './contracts'

/**
 * Sampling of timeline tracks. One implementation for the player, the lint and the tests, so they all agree on what a track means.
 *
 * Numeric track: keys `[t, value, ease?]` in time order. Before the first key the first value holds, after the last key the last value.
 * Between keys `a` and `b` the ease of `a` decides: `step` holds a's value until b's time and then jumps, `linear` interpolates,
 * `inOut` is a smoothstep (3u^2 - 2u^3). A key without an ease is `linear`.
 * Discrete track: keys `[t, value]`; the value of the last key at or before `t` holds (the first value before the first key).
 */

const EPS = 1e-9

/** Snaps `t` down to the animation grid (puppet poses step at 12 fps "on twos"). */
export function snapToGrid(t: number, gridFps: number): number {
  return Math.floor(t * gridFps + EPS) / gridFps
}

export function applyEase(u: number, ease: Ease | 'cut'): number {
  if (ease === 'step' || ease === 'cut') return 0
  if (ease === 'inOut') return u * u * (3 - 2 * u)
  return u
}

/** The value of a numeric track at time `t`; with `gridFps` the time is first snapped down to that grid. An empty track is 0. */
export function sampleNumber(track: readonly NumKey[], t: number, gridFps?: number): number {
  const first = track[0]
  if (!first) return 0
  const time = gridFps ? snapToGrid(t, gridFps) : t
  if (time <= first[0]) return first[1]
  const last = track[track.length - 1] as NumKey
  if (time >= last[0]) return last[1]
  let i = 0
  while (i + 1 < track.length && (track[i + 1] as NumKey)[0] <= time) i++
  const a = track[i] as NumKey
  const b = track[i + 1] as NumKey
  const span = b[0] - a[0]
  if (span <= 0) return b[1]
  const u = applyEase((time - a[0]) / span, a[2] ?? 'linear')
  return a[1] + (b[1] - a[1]) * u
}

/** The value of a discrete track at time `t`, or undefined for an empty track. */
export function sampleStep<T>(track: readonly (readonly [number, T])[], t: number): T | undefined {
  const first = track[0]
  if (!first) return undefined
  let v = first[1]
  for (const k of track) {
    if (k[0] <= t + EPS) v = k[1]
    else break
  }
  return v
}

/** The camera at time `t` (the camera keys use `cut` | `linear` | `inOut`; the player samples it at the output fps). */
export function sampleCamera(camera: readonly CameraKey[], t: number): { center: [number, number]; zoom: number } {
  const first = camera[0]
  if (!first) return { center: [0, 0], zoom: 1 }
  const cx: NumKey[] = camera.map((k) => [k.t, k.center[0], k.ease === 'cut' ? 'step' : k.ease])
  const cy: NumKey[] = camera.map((k) => [k.t, k.center[1], k.ease === 'cut' ? 'step' : k.ease])
  const z: NumKey[] = camera.map((k) => [k.t, k.zoom, k.ease === 'cut' ? 'step' : k.ease])
  return { center: [sampleNumber(cx, t), sampleNumber(cy, t)], zoom: sampleNumber(z, t) }
}
