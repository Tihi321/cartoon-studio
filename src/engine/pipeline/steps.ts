import type { PipelineState, Renderer } from '../../shared/contracts'

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
  { id: 'cast_sheet', no: '2', label: 'Character sheets: sketch, Z-Image master, pose sheet (character-designer, ComfyUI)', role: 'character-designer', kind: 'role', vision: true },
  { id: 'sheet_review', no: '2', label: 'The user approves every character sheet', role: 'character-designer', kind: 'gate' },
  { id: 'rig', no: '3', label: 'Rigs (character-designer): claude-svg, raster', role: 'character-designer', kind: 'role', vision: true },
  { id: 'poses', no: '3b', label: 'Pose images for gesture peaks, optional: at most 2 gestures per character (ComfyUI, frame-critic)', role: 'frame-critic', kind: 'role', vision: true },
  { id: 'set', no: '4', label: 'Sets (background-artist, ComfyUI)', role: 'background-artist', kind: 'role', vision: true },
  { id: 'script', no: '5', label: 'Script and texts (writer)', role: 'writer', kind: 'role' },
  { id: 'safety', no: '6', label: 'Child safety review, must pass (child-safety-reviewer)', role: 'child-safety-reviewer', kind: 'role' },
  { id: 'voice_cast', no: '7', label: 'Voices per character and language (voice-director)', role: 'voice-director', kind: 'role' },
  { id: 'voice', task: 'voice_run', no: '8', label: 'Speak every line in every language', role: 'voice-director', kind: 'code' },
  { id: 'music', task: 'music_run', no: '9', label: 'Theme and sound effects (composer, ComfyUI)', role: 'composer', kind: 'role' },
  { id: 'clip_shots', no: '9b', label: 'Flow clip shots and the video-plan input (showrunner)', role: 'showrunner', kind: 'role' },
  { id: 'clips', no: '9b', label: 'Flow clips: keyframe, video, review (frame-critic); waits for the credit cap', role: 'frame-critic', kind: 'role', vision: true },
  { id: 'timeline', no: '10', label: 'Lip-sync, timelines and lint', role: 'showrunner', kind: 'code' },
  { id: 'preview_render', no: '11', label: 'Preview renders, contact sheets, pose sheets', role: 'showrunner', kind: 'code' },
  { id: 'frame_review', no: '12', label: 'Frame review (frame-critic), not must-pass', role: 'frame-critic', kind: 'role', vision: true },
  { id: 'final_render', no: '13', label: 'Final renders and the summary', role: 'showrunner', kind: 'code' }
]

/** The canvas step list (pilots 1 and 2, the `mini` fixture; frozen since HUB-30). */
export const CANVAS_STEPS: readonly StepDef[] = STEPS

const byId = (id: string): StepDef => STEPS.find((s) => s.id === id)!

/**
 * The step list of a `blender` series (HUB-30, CTS-27): characters and sets are specs that Blender builds, the pause is on the character sheets,
 * the timeline is the 3D one, and `assemble` makes the scenes the render reads. The steps the two renderers share are the same objects as above.
 */
export const BLENDER_STEPS: readonly StepDef[] = [
  byId('pitch'),
  byId('pitch_choice'),
  byId('bible'),
  { id: 'character', no: '2', label: 'Characters: designer spec, Blender build, sheet.png self-review (character-designer, Blender)', role: 'character-designer', kind: 'role', vision: true },
  { ...byId('sheet_review'), label: 'The user approves every character sheet (turnaround and expressions)' },
  { id: 'set3d', no: '4', label: 'Sets: designer spec, Blender build, sheet self-review (background-artist, Blender)', role: 'background-artist', kind: 'role', vision: true },
  byId('script'),
  byId('safety'),
  byId('voice_cast'),
  byId('voice'),
  byId('music'),
  byId('clip_shots'),
  byId('clips'),
  { ...byId('timeline'), label: 'Six-viseme lip-sync, 3D timelines and lint' },
  { id: 'assemble', no: '10b', label: 'Assemble the Blender scene of every language', role: 'showrunner', kind: 'code' },
  { ...byId('preview_render'), label: 'Preview renders in Blender and contact sheets' },
  byId('frame_review'),
  byId('final_render')
]

/** Every step of either list, once by id (the job handlers are registered for these). */
export const ALL_STEPS: readonly StepDef[] = [...new Map([...CANVAS_STEPS, ...BLENDER_STEPS].map((s) => [s.id, s])).values()]

export const stepsFor = (renderer: Renderer): readonly StepDef[] => (renderer === 'blender' ? BLENDER_STEPS : CANVAS_STEPS)

/** Which list a state follows: a state that has the step `character` or `assemble` is a Blender run; any other one is a canvas run and is never changed. */
export const rendererOfState = (state: Pick<PipelineState, 'steps'>): Renderer => ('character' in state.steps || 'assemble' in state.steps ? 'blender' : 'canvas')

/** The steps of this state's run, in order. */
export const stepsOf = (state: Pick<PipelineState, 'steps'>): readonly StepDef[] => stepsFor(rendererOfState(state))

export const STEP_IDS: readonly string[] = STEPS.map((s) => s.id)

export function stepDef(id: string): StepDef {
  const s = ALL_STEPS.find((x) => x.id === id)
  if (!s) throw new Error(`unknown pipeline step "${id}" (${ALL_STEPS.map((x) => x.id).join(', ')})`)
  return s
}

export const taskOf = (s: StepDef): string => s.task ?? s.id

/** A new, empty state: every step of the renderer's list pending. */
export function emptyState(series: string, episode: string, now: string, renderer: Renderer = 'canvas'): PipelineState {
  return { schema: 'cts.pipeline/1', series, episode, state: 'idle', steps: Object.fromEntries(stepsFor(renderer).map((s) => [s.id, { state: 'pending' as const }])), updatedAt: now, run: 0 }
}

/** Every step from `id` on goes back to pending, marked `redo` so its handler makes its files again instead of keeping them. */
export function resetFrom(state: PipelineState, id: string): void {
  const ids = stepsOf(state).map((s) => s.id)
  const at = ids.indexOf(id)
  if (at < 0) throw new Error(`unknown pipeline step "${id}" for this run (${ids.join(', ')})`)
  for (const [i, sid] of ids.entries()) {
    if (i < at) continue
    state.steps[sid] = { state: 'pending', detail: 'redo' }
  }
}

/** The steps that exist in the state, in order, with a pending step for any the file does not know yet (a state written by an older version). */
export function normalise(state: PipelineState): PipelineState {
  // a Blender run only gets the steps of its own list; the canvas migrations below never touch it
  if (rendererOfState(state) === 'blender') {
    for (const step of BLENDER_STEPS) state.steps[step.id] ??= { state: 'pending' }
    return state
  }
  // CTS-12: `cast_ref` (pilot 1) became `cast_sheet` + the gate `sheet_review`. A finished `cast_ref` finishes both (that run made its
  // references before the sheet step existed and its characters were never reviewed as sheets); anything else starts again at `cast_sheet`.
  const old = state.steps.cast_ref
  if (old) {
    if (!state.steps.cast_sheet) {
      const finished = old.state === 'done' || old.state === 'skipped'
      state.steps.cast_sheet = finished ? { ...old, detail: `from cast_ref${old.detail ? `: ${old.detail}` : ''}` } : { state: 'pending', detail: `was cast_ref (${old.state})` }
      state.steps.sheet_review = finished ? { state: 'done', ...(old.endedAt ? { endedAt: old.endedAt } : {}), detail: 'made before the sheet step: no review' } : { state: 'pending' }
    }
    delete state.steps.cast_ref
  }
  // CTS-17: `poses` is new. A state from before it (pilot 1) has its rig finished or not: finished means the poses step is skipped.
  if (!state.steps.poses) state.steps.poses = state.steps.rig?.state === 'done' ? { state: 'skipped', detail: 'made before the poses step' } : { state: 'pending' }
  for (const id of STEP_IDS) state.steps[id] ??= { state: 'pending' }
  return state
}
