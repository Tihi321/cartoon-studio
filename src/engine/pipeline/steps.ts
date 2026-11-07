import type { PipelineState } from '../../shared/contracts'

/**
 * The steps of the pipeline, in order (CTS-07). State lives in `episodes/<ep>/pipeline.json`; `run.ts` advances it, `handlers.ts` does the work.
 * A step is a job `<series>--<task>--<episode>--r<n>` of the role that owns it, a gate (waits for the user), or both (a job that waits for a
 * condition first). `docs/pipeline.md` says what each step reads and writes.
 */

export interface StepDef {
  id: string
  /** The job task name (the handler's name). Default: the id. */
  task?: string
  label: string
  /** The role of the job (its agent and model list). */
  role: string
  /** `gate`: no job, the step is done when its condition is (the user's pick). */
  kind: 'role' | 'code' | 'gate'
  /** The job sends pictures: only models that take images are used. */
  vision?: boolean
  /** The plan's step number, for the docs and the summary. */
  no: string
}

export const STEPS: readonly StepDef[] = [
  { id: 'pitch', no: '1', label: 'Three premises (showrunner)', role: 'showrunner', kind: 'role' },
  { id: 'pitch_choice', no: '1', label: 'The user picks a premise', role: 'showrunner', kind: 'gate' },
  { id: 'bible', no: '1b', label: 'Series bible from the chosen premise (showrunner)', role: 'showrunner', kind: 'role' },
  { id: 'cast_ref', no: '2', label: 'Character references (character-designer, ComfyUI)', role: 'character-designer', kind: 'role', vision: true },
  { id: 'rig', no: '3', label: 'Rigs (character-designer): claude-svg, raster', role: 'character-designer', kind: 'role', vision: true },
  { id: 'set', no: '4', label: 'Sets (background-artist, ComfyUI)', role: 'background-artist', kind: 'role', vision: true },
  { id: 'script', no: '5', label: 'Script and texts (writer)', role: 'writer', kind: 'role' },
  { id: 'safety', no: '6', label: 'Child safety review, must pass (child-safety-reviewer)', role: 'child-safety-reviewer', kind: 'role' },
  { id: 'voice_cast', no: '7', label: 'Voices per character and language (voice-director)', role: 'voice-director', kind: 'role' },
  { id: 'voice', task: 'voice_run', no: '8', label: 'Speak every line in every language', role: 'voice-director', kind: 'code' },
  { id: 'music', task: 'music_run', no: '9', label: 'Theme and sound effects (composer, Chiptune Studio)', role: 'composer', kind: 'role' },
  { id: 'clip_shots', no: '9b', label: 'Flow clip shots and the video-plan input (showrunner)', role: 'showrunner', kind: 'role' },
  { id: 'clips', no: '9b', label: 'Flow clips: keyframe, video, review (frame-critic); waits for the credit cap', role: 'frame-critic', kind: 'role', vision: true },
  { id: 'timeline', no: '10', label: 'Lip-sync, timelines and lint', role: 'showrunner', kind: 'code' },
  { id: 'preview_render', no: '11', label: 'Preview renders, contact sheets, pose sheets', role: 'showrunner', kind: 'code' },
  { id: 'frame_review', no: '12', label: 'Frame review (frame-critic), not must-pass', role: 'frame-critic', kind: 'role', vision: true },
  { id: 'final_render', no: '13', label: 'Final renders and the summary', role: 'showrunner', kind: 'code' }
]

export const STEP_IDS: readonly string[] = STEPS.map((s) => s.id)

export function stepDef(id: string): StepDef {
  const s = STEPS.find((x) => x.id === id)
  if (!s) throw new Error(`unknown pipeline step "${id}" (${STEP_IDS.join(', ')})`)
  return s
}

export const taskOf = (s: StepDef): string => s.task ?? s.id

/** A new, empty state: every step pending. */
export function emptyState(series: string, episode: string, now: string): PipelineState {
  return { schema: 'cts.pipeline/1', series, episode, state: 'idle', steps: Object.fromEntries(STEP_IDS.map((id) => [id, { state: 'pending' as const }])), updatedAt: now, run: 0 }
}

/** Every step from `id` on goes back to pending, marked `redo` so its handler makes its files again instead of keeping them. */
export function resetFrom(state: PipelineState, id: string): void {
  stepDef(id)
  const at = STEP_IDS.indexOf(id)
  for (const [i, sid] of STEP_IDS.entries()) {
    if (i < at) continue
    state.steps[sid] = { state: 'pending', detail: 'redo' }
  }
}

/** The steps that exist in the state, in order, with a pending step for any the file does not know yet (a state written by an older version). */
export function normalise(state: PipelineState): PipelineState {
  for (const id of STEP_IDS) state.steps[id] ??= { state: 'pending' }
  return state
}
