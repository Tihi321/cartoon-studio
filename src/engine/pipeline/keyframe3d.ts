import { promises as fs } from 'node:fs'
import path from 'node:path'
import { timeline3dSchema } from '../../shared/contracts'
import type { Timeline3d } from '../../shared/contracts'
import { loadBlenderConfig } from '../blender/config'
import { styleFileOf } from '../blender/jobs'
import { loadActingLibrary } from '../blender/library'
import { blenderRunnerFor } from '../blender/runner'
import type { SeriesStore } from '../series/service'
import type { ClipShots } from './clips'

/**
 * The keyframe of a Flow clip for a `blender` series (CTS-27): a Blender still of the clip's staging. The staging (set, shot, the actors at their marks with
 * facing, emotion and a gesture) becomes a one-scene `cts.timeline3d/1` that is assembled like an episode (`assemble` command) in a scratch folder, and one
 * frame of it is rendered (`still` command, the same one `cts_still` runs). No image model is involved, and nothing is spent.
 */

export const KEYFRAME_SIZE = { width: 1280, height: 720 }
const LEAD = 0.25

/** The timeline of a clip's staging: the actors stand on their marks; the gesture, when it needs no target, runs from `LEAD` and the frame is its middle. */
export function keyframeTimeline(series: string, shot: ClipShots[number], lib = loadActingLibrary()): { timeline: Timeline3d; frame: number; warnings: string[] } {
  const st = shot.staging
  const warnings: string[] = []
  const actors: Timeline3d['actors'] = {}
  let peak = 0.5
  for (const a of st.actors) {
    const actions: Timeline3d['actors'][string]['actions'] = []
    if (a.gesture) {
      const action = lib.byName.get(a.gesture)
      if (!action || !lib.scriptable.has(a.gesture)) warnings.push(`${a.who}: gesture "${a.gesture}" is not a gesture of the acting library; left out`)
      else if (action.needsTarget) warnings.push(`${a.who}: gesture "${a.gesture}" needs a target; left out of the keyframe`)
      else {
        actions.push({ beat: `k-${a.who}`, action: a.gesture, t0: LEAD, t1: LEAD + action.seconds.default, params: {} })
        peak = Math.max(peak, LEAD + action.seconds.default / 2)
      }
    }
    actors[a.who] = { start: { mark: a.mark, facing: a.facing }, actions, look: [], emotion: [[0, a.emotion]], mouth: [], blinks: [], speaking: [], accents: [] }
  }
  const duration = Math.round((peak + 0.6) * 100) / 100
  const timeline = timeline3dSchema.parse({
    schema: 'cts.timeline3d/1',
    series,
    episode: `still-${shot.id}`,
    lang: 'en',
    scriptHash: 'still',
    fps: 24,
    size: [1920, 1080],
    duration,
    seed: 29,
    scenes: [{ id: 'still', set: st.set, t0: 0, t1: duration }],
    actors,
    shots: [{ t: 0, shot: st.shot, transition: 'cut' }],
    audio: [],
    lines: [],
    clips: []
  })
  return { timeline, frame: Math.round(peak * 24), warnings }
}

/** Draws the keyframe still of a shot with Blender: `clips/keyframes/<id>.png` at series level, 1280x720. Needs the set and the characters built. */
export async function renderKeyframe3d(dataDir: string, store: SeriesStore, series: string, shot: ClipShots[number], signal?: AbortSignal, log: (m: string) => void = () => undefined): Promise<string> {
  const p = store.paths(series)
  const dir = path.join(p.root, 'clips', 'keyframes')
  const work = path.join(dir, `work-${shot.id}`)
  const out = path.join(dir, `${shot.id}.png`)
  const { timeline, frame, warnings } = keyframeTimeline(series, shot)
  for (const w of warnings) log(`keyframe ${shot.id}: ${w}`)
  const needed = async (file: string, what: string): Promise<string> => {
    if (!(await store.exists(file))) throw new Error(`clip ${shot.id}: ${what} is not built (${path.relative(p.root, file).split(path.sep).join('/')} is missing)`)
    return file
  }
  await fs.rm(work, { recursive: true, force: true })
  await fs.mkdir(work, { recursive: true })
  const timelineFile = path.join(work, 'timeline.json')
  await fs.writeFile(timelineFile, `${JSON.stringify(timeline, null, 2)}\n`)
  const characters: Record<string, unknown> = {}
  for (const id of Object.keys(timeline.actors)) {
    characters[id] = { spec: await needed(p.characterFile(id), `character "${id}" has no spec; it`), blend: await needed(path.join(p.castDir(id), 'character.blend'), `character "${id}"`), build: path.join(p.castDir(id), 'build.json') }
  }
  const setId = timeline.scenes[0]!.set
  const style = await styleFileOf(store, series)
  const runner = await blenderRunnerFor(dataDir)
  await runner.run(
    'assemble',
    {
      timeline: timelineFile,
      outDir: work,
      ...(style ? { style } : {}),
      set: { id: setId, spec: await needed(p.set3dFile(setId), `set "${setId}" has no spec; it`), blend: await needed(path.join(p.setDir(setId), 'set.blend'), `set "${setId}"`), build: path.join(p.setDir(setId), 'build.json') },
      characters
    },
    { signal }
  )
  await fs.mkdir(dir, { recursive: true })
  const cfg = await loadBlenderConfig(dataDir)
  await runner.run('still', { blend: path.join(work, 'scene.blend'), frame, out, width: KEYFRAME_SIZE.width, height: KEYFRAME_SIZE.height, samples: cfg.preview.samples }, { signal })
  await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
  return out
}
