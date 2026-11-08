/**
 * Where the Blender work of each series stands right now (CTS-27): the latest `progress` line of a character build, set build, scene assembly or render,
 * kept in memory so `cts_status` and the studio can say "assembling 14/48" while the job runs. Nothing is written to disk.
 */

export interface BlenderStage {
  /** The job task or pipeline step (`character_build`, `assemble`, `preview_render` ...). */
  task: string
  /** What it works on: a cast id, a set id, `<episode>-<lang>`. */
  unit: string
  /** The stage name Blender's last progress line gave. */
  stage: string
  /** 0 to 1, or null when unknown. */
  fraction: number | null
  at: string
}

const stages = new Map<string, BlenderStage>()

/** Records the latest stage of a series. */
export function noteBlenderStage(series: string, s: Omit<BlenderStage, 'at'>): void {
  stages.set(series, { ...s, at: new Date().toISOString() })
}

/** The work is over: forgets the stage if it is still this task and unit (another job may have taken over). */
export function endBlenderStage(series: string, task: string, unit: string): void {
  const cur = stages.get(series)
  if (cur && cur.task === task && cur.unit === unit) stages.delete(series)
}

/** The Blender stage a series is in, or null when no Blender work runs for it. */
export function blenderStageOf(series: string): BlenderStage | null {
  return stages.get(series) ?? null
}

/** Runs `fn` with a progress callback that records the stage, and forgets the stage when it ends. */
export async function withBlenderStage<T>(series: string, task: string, unit: string, fn: (progress: (fraction: number | null, stage?: string) => void) => Promise<T>): Promise<T> {
  noteBlenderStage(series, { task, unit, stage: 'starting', fraction: null })
  try {
    return await fn((fraction, stage) => noteBlenderStage(series, { task, unit, stage: stage ?? 'working', fraction }))
  } finally {
    endBlenderStage(series, task, unit)
  }
}
