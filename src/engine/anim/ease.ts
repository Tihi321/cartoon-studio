// Easing and grid helpers used by the timeline builder. The definitions live in src/shared/sample.ts so the player, the lint and the builder agree.
export { applyEase, snapToGrid } from '../../shared/sample'

/** Rounds a time to the millisecond so timeline files stay short and stable. */
export const round3 = (t: number): number => Math.round(t * 1000) / 1000
