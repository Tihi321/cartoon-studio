import type { EyeState } from '../../shared/contracts'
import { sampleStep } from '../../shared/sample'
import { round3, snapToGrid } from './ease'

/** Small seeded PRNG (mulberry32): the same seed gives the same blinks on every machine and run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A stable 32-bit number for a string (so each actor gets its own blink stream from one timeline seed). */
export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

export const BLINK_MIN = 2.5
export const BLINK_MAX = 5
export const BLINK_FRAMES = 2

export interface BlinkOptions {
  seed: number
  actor: string
  duration: number
  fps: number
  /** The eye state the emotion asks for (`[t, state]`); a blink closes the eyes and goes back to it. */
  base: readonly (readonly [number, EyeState])[]
  /** Time ranges where no blink may start or run (the actor's gesture keys). */
  avoid: readonly (readonly [number, number])[]
}

/**
 * The `eyes` track of an actor: the base states plus a blink every 2.5-5 s (2 frames closed at `fps`), seeded. A blink is skipped when it
 * would overlap a gesture, when the base state changes inside it, or when the eyes are already closed.
 */
export function blinkTrack(o: BlinkOptions): [number, EyeState][] {
  const out: [number, EyeState][] = o.base.map((k) => [k[0], k[1]])
  const rand = mulberry32((o.seed ^ hashString(o.actor)) >>> 0)
  const len = BLINK_FRAMES / o.fps
  let t = 0
  for (;;) {
    t += BLINK_MIN + rand() * (BLINK_MAX - BLINK_MIN)
    const start = snapToGrid(t, o.fps)
    if (start + len > o.duration) break
    const end = start + len
    if (o.avoid.some(([a, b]) => start < b && end > a)) continue
    if (o.base.some((k) => k[0] > start - 1e-9 && k[0] < end + 1e-9)) continue
    const state = sampleStep(o.base, start) ?? 'open'
    if (state === 'closed') continue
    out.push([round3(start), 'closed'], [round3(end), state])
  }
  return out.sort((a, b) => a[0] - b[0])
}
