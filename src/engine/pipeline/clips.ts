import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import type { Bible, ClipEntry, Episode, Rig, SetFile, Timeline } from '../../shared/contracts'
import { budgetState, charge, localIso } from '../budget/spend'
import { comfyProvider } from '../images/comfy'
import { stillFrame } from '../render/sheet'
import { SeriesStore } from '../series/service'
import type { CtsService } from '../service'
import { ffprobe } from '../render/ffmpeg'
import type { z } from 'zod'
import { renderKeyframe3d } from './keyframe3d'
import type { clipShotAnswer } from './tasks'

/**
 * Flow clips (HUB-29 decision 12, step 9b; pilot 2 decision 4): the series intro and outro, both at series level (`series/<slug>/clips/<id>.mp4`, reused by
 * every episode). No other clip id can be made. The keyframe is a still drawn by our own player from the clip's `staging` (the set, the leads at their
 * marks, emotion, gesture peak); no image goes to Flow. The showrunner writes the shots; this module writes them in the input shape of the hub's
 * `scripts/video-plan.mjs plan` (`episodes/<ep>/video/screenplay.json`) and makes the clip (a Flow video scene behind `charge(currency: "credits")`), and keeps
 * `clips.json`. The hub session runs `video-plan.mjs plan | next | record` for the estimate and each call's `max_credits`; this module copies none of its price table.
 * A pilot 1 episode may still hold a `hero` clip entry: it keeps resolving at episode level, but no new one can be made.
 */

export const INTRO_ID = 'intro'
export const OUTRO_ID = 'outro'
/** The only clip ids that can be made, both series level. */
export const CLIP_IDS = [INTRO_ID, OUTRO_ID] as const
export const isClipId = (id: string): boolean => (CLIP_IDS as readonly string[]).includes(id)
/** The Flow video model and size of the pilot (the `omni-720p` row of video-plan.mjs: 8 s = 12 credits seen). */
export const VIDEO_MODEL = 'Omni 1.1 Flash'
export const VIDEO_RESOLUTION = '720p'
export const VIDEO_SECONDS = 8
/** How far the Z-Image img2img polish of a keyframe may drift from the player still. */
export const POLISH_DENOISE = 0.35
export const CLIP_STYLE = 'Flat 2D paper cutout cartoon for small children: solid flat colours, thick dark outlines, simple shapes, characters made of cut-out parts that slide and rotate, a plain flat painted background. No 3D, no shading, no gradients, no realistic lighting, no camera shake, no text, no speech.'
/** The same for a `blender` series: the clip must sit next to the Blender render, so it asks for the toon 3D look of the first frame. */
export const CLIP_STYLE_3D = 'Stylised 3D toon cartoon for small children, exactly as in the first frame: simple rounded characters with clean flat cel shading and a thin dark outline, soft flat light, a simple bright set, gentle character motion. No photoreal textures, no realistic lighting, no camera shake, no text, no speech.'

export type ClipShots = z.infer<typeof clipShotAnswer>['clips']

export interface ClipNeed {
  clip: string
  seconds: number
  audio: 'keep' | 'mute'
  level: 'series' | 'episode'
  /** Relative to the series folder. */
  file: string
}

export function clipBeats(script: Episode): { clip: string; seconds: number; audio: 'keep' | 'mute'; beat: string }[] {
  const out: { clip: string; seconds: number; audio: 'keep' | 'mute'; beat: string }[] = []
  for (const scene of script.scenes) for (const b of scene.beats) if (b.type === 'clip' && !out.some((o) => o.clip === b.clip)) out.push({ clip: b.clip, seconds: b.seconds, audio: b.audio, beat: b.id })
  return out
}

/** The intro and the outro live at series level; any other id (a pilot 1 `hero` clip) is looked up at episode level. */
export function clipLocation(episode: string, clip: string): { level: 'series' | 'episode'; file: string } {
  return isClipId(clip) ? { level: 'series', file: `clips/${clip}.mp4` } : { level: 'episode', file: `episodes/${episode}/clips/${clip}.mp4` }
}

/** The clip beats of the script whose file is missing and that are not already dropped (`fallback`). */
export async function missingClips(store: SeriesStore, series: string, episode: string): Promise<ClipNeed[]> {
  let script: Episode
  try {
    script = await store.readScript(series, episode)
  } catch {
    return []
  }
  const epClips = await store.readClips(series, episode).catch(() => ({ clips: [] as ClipEntry[] }))
  const seClips = await store.readClips(series).catch(() => ({ clips: [] as ClipEntry[] }))
  const out: ClipNeed[] = []
  for (const b of clipBeats(script)) {
    const loc = clipLocation(episode, b.clip)
    const entry = (loc.level === 'series' ? seClips : epClips).clips.find((c) => c.id === b.clip)
    if (entry?.fallback) continue
    if (await store.exists(store.resolve(series, loc.file))) continue
    out.push({ clip: b.clip, seconds: b.seconds, audio: b.audio, level: loc.level, file: loc.file })
  }
  return out
}

/** The clip ids of a NEW script that are not allowed (anything but `intro` and `outro`); the writer's check refuses them. */
export function badClipIds(script: Episode): string[] {
  return clipBeats(script).filter((b) => !isClipId(b.clip)).map((b) => b.clip)
}

/**
 * The step `clips` waits (returns a reason) while a clip is missing and neither the Flow credit cap nor the per-clip `max_credits` is there. The user's yes
 * (`cts_budget_set {flowCreditsCap}`) and the hub session's `video-plan.mjs next` give them; `options.skipClips` drops every missing clip (NOT RUN).
 */
export async function clipsGate(store: SeriesStore, series: string, episode: string, options: Record<string, unknown>): Promise<string | null> {
  if (options.skipClips === true) return null
  const need = await missingClips(store, series, episode)
  if (need.length === 0) return null
  const budget = await store.readBudget(series, episode)
  const names = need.map((n) => n.clip).join(', ')
  if (!budget || budget.flowCreditsCap <= 0) {
    return `${need.length} Flow clip(s) are missing (${names}) and no Flow credit cap is recorded. Ask the user for a cap, then cts_budget_set {series, episode, capUsd: 0, flowCreditsCap, approvedBy: "user", note}; run video-plan.mjs plan/next (cts_clip_plan prints the commands) for each clip's max_credits; then cts_run_pipeline {options: {clipCredits: {<clip>: <max_credits>}}} or cts_clip_generate per clip. Or cts_run_pipeline {options: {skipClips: true}} to drop them (the beats fall back to a title card).`
  }
  const credits = (options.clipCredits ?? {}) as Record<string, unknown>
  const open = need.filter((n) => !(typeof credits[n.clip] === 'number' && (credits[n.clip] as number) > 0))
  if (open.length === 0) return null
  return `${open.length} Flow clip(s) wait for their max_credits (${open.map((n) => n.clip).join(', ')}): run video-plan.mjs next for each (cts_clip_plan shows how), then cts_run_pipeline {options: {clipCredits: {${open[0]!.clip}: <max_credits>}}}, or call cts_clip_generate {series, episode, clip, maxCredits} yourself. skipClips: true drops them.`
}

// ---- the shots and the video-plan input ----

export interface ShotsFile {
  clips: ClipShots
}

/** The `screenplay.json` that `video-plan.mjs plan` reads (docs/screenplay.md of Scriptorium): one chapter, one scene, a shot per clip. Returns the clip -> shot id map as well. */
export function buildScreenplay(series: string, episode: string, bible: Bible, shots: ClipShots): { screenplay: Record<string, unknown>; shotIds: Record<string, string> } {
  const cast = new Map(bible.cast.map((c) => [c.id, c]))
  const shotIds: Record<string, string> = {}
  const place = bible.sets[0]
  const looks = (id: string): { name: string; look: string } => {
    const c = cast.get(id)
    return { name: c?.name.en ?? id, look: c?.look ?? c?.personality ?? '' }
  }
  const leads = [...new Set(shots.flatMap((s) => s.who))]
  const screenplay = {
    slug: `${series}-${episode}`,
    title: bible.title.en,
    format: 'kids-cartoon',
    aspect: '16:9',
    style: ((base) => (bible.style.look ? `${base} Series look: ${bible.style.look}.` : base))(bible.renderer === 'blender' ? CLIP_STYLE_3D : CLIP_STYLE),
    runtimeSeconds: shots.reduce((n, s) => n + s.seconds, 0),
    characters: leads.map((id) => ({ ...(({ name, look }) => ({ name, looks: look, voice: '' }))(looks(id)) })),
    places: bible.sets.map((s) => ({ name: s.name.en, looks: s.description })),
    music: [],
    chapters: [
      {
        n: 1,
        title: 'Clips',
        scenes: [
          {
            id: 'ch01.s01',
            place: place?.name.en ?? 'the set',
            time: 'day',
            background: place?.description ?? '',
            shots: shots.map((s, i) => {
              const id = `ch01.s01.sh${String(i + 1).padStart(2, '0')}`
              shotIds[s.id] = id
              return { id, framing: s.framing, move: s.move, seconds: s.seconds, continuous: false, action: s.action, cast: s.who.map((w) => ({ name: looks(w).name, look: looks(w).look })), sfx: [], lines: [] }
            })
          }
        ]
      }
    ]
  }
  return { screenplay, shotIds }
}

export const videoDir = (store: SeriesStore, series: string, episode: string): string => path.join(store.paths(series).episodeDir(episode), 'video')

export async function readShots(store: SeriesStore, series: string): Promise<ShotsFile | null> {
  try {
    return JSON.parse(await fs.readFile(store.resolve(series, 'tasks/clip-shots.json'), 'utf8')) as ShotsFile
  } catch {
    return null
  }
}

const STILL_SIZE = { width: 1280, height: 720 }

/** A one-scene timeline that holds the clip's staging at time 0: the leads at their marks, facing, emotion, and the gesture at its peak. */
export async function buildStillTimeline(store: SeriesStore, series: string, shot: ClipShots[number]): Promise<Timeline> {
  const st = shot.staging
  const set: SetFile = await store.readSet(series, st.set).catch(() => {
    throw new Error(`clip ${shot.id}: staging set "${st.set}" does not exist`)
  })
  const cam = set.shots[st.shot]
  if (!cam) throw new Error(`clip ${shot.id}: set "${st.set}" has no shot "${st.shot}" (${Object.keys(set.shots).join(', ')})`)
  const actors: Timeline['actors'] = {}
  for (const a of st.actors) {
    const mark = set.marks[a.mark]
    if (!mark) throw new Error(`clip ${shot.id}: set "${st.set}" has no mark "${a.mark}" (${Object.keys(set.marks).join(', ')})`)
    const rig: Rig = await store.readRig(series, a.who).catch(() => {
      throw new Error(`clip ${shot.id}: ${a.who} has no rig yet (run the rig step first)`)
    })
    const emotion = rig.emotions[a.emotion] ? a.emotion : 'neutral'
    const rot: Record<string, [number, number, 'step'][]> = {}
    if (a.gesture) {
      const g = rig.gestures[a.gesture]
      if (!g) throw new Error(`clip ${shot.id}: ${a.who} has no gesture "${a.gesture}" (${Object.keys(rig.gestures).join(', ')})`)
      const peak = g.keys.reduce((best, k) => (Math.abs(k[1]) > Math.abs(best[1]) ? k : best), g.keys[0]!)
      rot[g.part] = [[0, peak[1], 'step']]
    }
    actors[a.who] = {
      x: [[0, mark[0], 'step']],
      y: [[0, mark[1], 'step']],
      facing: [[0, a.facing]],
      visible: [[0, true]],
      emotion: [[0, emotion]],
      eyes: [[0, rig.emotions[emotion]?.eyes ?? 'open']],
      mouth: [[0, 'rest']],
      rot,
      bob: [[0, 0, 'step']]
    }
  }
  return {
    schema: 'cts.timeline/1',
    series,
    episode: `still-${shot.id}`,
    lang: 'en',
    scriptHash: 'still',
    size: [STILL_SIZE.width, STILL_SIZE.height],
    fps: { anim: 12, out: 24 },
    duration: 1,
    seed: 29,
    scenes: [{ id: 'still', set: st.set, t0: 0, t1: 1 }],
    camera: [{ t: 0, center: [cam.center[0], cam.center[1]], zoom: cam.zoom, ease: 'cut' }],
    actors,
    audio: [],
    lines: [],
    clips: []
  }
}

/** Draws the keyframe still of a shot: `clips/keyframes/<id>.png` at series level, 1280x720. The player draws it for a canvas series, Blender for a `blender` series (`keyframe3d.ts`). */
export async function renderKeyframe(svc: CtsService, store: SeriesStore, series: string, shot: ClipShots[number], signal?: AbortSignal, log?: (m: string) => void): Promise<string> {
  if ((await store.readBible(series)).renderer === 'blender') return renderKeyframe3d(svc.dataDir, store, series, shot, signal, log)
  const timeline = await buildStillTimeline(store, series, shot)
  return stillFrame({ dataDir: svc.dataDir, series, timeline, out: path.join(store.paths(series).root, 'clips', 'keyframes', `${shot.id}.png`), width: STILL_SIZE.width, height: STILL_SIZE.height })
}

export function videoPrompt(shot: ClipShots[number], renderer: 'canvas' | 'blender' = 'canvas'): string {
  const action = shot.action.replace(/\s+/g, ' ').trim().replace(/[.!?]*$/, '.')
  const camera = `Camera: ${shot.framing}${shot.move && shot.move !== 'static' ? `, ${shot.move}` : ', static'}.`
  if (renderer === 'blender') return `${action} Keep the toon 3D look of the first frame; the characters move gently and stay on model. ${camera} No speech, no text.`
  return `${action} Flat 2D cutout motion only: parts slide, rotate and bob like paper puppets. ${camera} No 3D, no shading, no speech, no text.`
}

// ---- making one clip ----

export interface GenerateClipArgs {
  svc: CtsService
  store: SeriesStore
  series: string
  /** The episode whose budget pays (the intro is charged to the episode that triggers it). */
  episode: string
  clip: string
  maxCredits: number
  seconds?: number
  /** Z-Image img2img clean-up of the still at denoise `POLISH_DENOISE` (local ComfyUI, $0). It becomes the clip's `first_frame`; when ComfyUI cannot do it the plain still is used and the result says so. */
  polish?: boolean
  /** Tests pass a fake renderer. Default: the player (`renderKeyframe`). */
  renderStill?: (shot: ClipShots[number]) => Promise<string>
  log: (m: string) => void
  signal?: AbortSignal
}

export interface GeneratedClip {
  entry: ClipEntry
  /** Absolute. */
  file: string
  credits: number
  keyframe: string
  /** Set when `polish` was asked for: the polished still, or why the plain still was used. */
  polish?: { file: string; denoise: number } | { skipped: string }
}


/** Throws for any clip id but `intro` and `outro`. */
export function assertClipId(clip: string): void {
  if (!isClipId(clip)) throw new Error(`clip "${clip}" is not allowed: the only clips are ${CLIP_IDS.join(' and ')} (series level); there is no hero clip`)
}

/**
 * The keyframe (a player still, free) then the video (credits). Refuses any clip id but `intro` and `outro`, refuses without a recorded `flowCreditsCap`; the credit gate refuses past it; nothing is spent on a refusal.
 * The file lands at the clip's path and `clips.json` gets its entry (review null: `reviewClip` sets it).
 */
export async function generateClip(a: GenerateClipArgs): Promise<GeneratedClip> {
  const { svc, store, series, episode, clip } = a
  assertClipId(clip)
  const state = await budgetState(store, series, episode)
  if (state.flowCreditsCap <= 0) throw new Error(`cts_clip_generate refuses without a recorded flowCreditsCap for episode "${episode}": ask the user for a cap, then cts_budget_set {series, episode, capUsd: 0, flowCreditsCap, approvedBy, note}`)
  if (!(a.maxCredits > 0)) throw new Error('maxCredits must be the max_credits that video-plan.mjs next gave for this clip (a number above 0)')
  const shots = await readShots(store, series)
  const shot = shots?.clips.find((c) => c.id === clip)
  if (!shot) throw new Error(`no shot "${clip}" in tasks/clip-shots.json: the clip_shots step writes it (cts_run_pipeline), or write the shot yourself`)
  const { flow } = await svc.studios({ autoStart: true, log: a.log })
  if (!flow.generateVideo) throw new Error('this Flow client cannot make video')
  const st = await flow.status(a.signal)
  if (!st.up) throw new Error(st.hint ?? 'flow-music-mcp is not running')
  if (st.signedIn === false) throw new Error(st.hint ?? 'Google Flow is not signed in')
  if (!st.uploadRights) throw new Error('flow-music-mcp has no upload rights (FLOW_MUSIC_MCP_UPLOAD_RIGHTS=agree in its .env): Flow asks to confirm rights before it takes our reference pictures. That is the user\'s to give; nothing was spent.')

  const dir = videoDir(store, series, episode)
  const project = `cartoon-studio-${series}`
  if (!shot.staging) throw new Error(`shot "${clip}" in tasks/clip-shots.json has no staging (set, shot, actors): the clip_shots step writes it`)
  const renderer = (await store.readBible(series)).renderer
  a.log(`clip ${clip}: keyframe from ${renderer === 'blender' ? 'a Blender still' : 'the player'} (set ${shot.staging.set}, ${shot.staging.actors.map((x) => x.who).join(', ')})`)
  let keyframe = await (a.renderStill ?? ((sh) => renderKeyframe(svc, store, series, sh, a.signal, a.log)))(shot)
  let polish: GeneratedClip['polish']
  if (a.polish) {
    try {
      const img = await comfyProvider({ svc, store, series, episode, what: `clip ${clip} keyframe polish` }).generate({
        prompt: `${shot.action.replace(/s+/g, ' ').trim()} ${renderer === 'blender' ? CLIP_STYLE_3D : CLIP_STYLE}`,
        size: STILL_SIZE,
        format: 'png',
        out: keyframe.replace(/.png$/i, '') + '-polished',
        init: { image: keyframe, denoise: POLISH_DENOISE },
        signal: a.signal
      })
      polish = { file: img.file, denoise: POLISH_DENOISE }
      keyframe = img.file
      a.log(`clip ${clip}: keyframe polished by ${img.model} img2img at denoise ${POLISH_DENOISE}`)
    } catch (err) {
      if (a.signal?.aborted) throw err
      polish = { skipped: (err as Error).message.slice(0, 160) }
      a.log(`clip ${clip}: polish skipped (${polish.skipped}), the player still is used as it is`)
    }
  }
  a.log(`clip ${clip}: keyframe ${keyframe}; video (max_credits ${a.maxCredits})`)
  const prompt = videoPrompt(shot, renderer)
  const r = await charge(
    { store, series, episode, provider: 'flow', model: `${VIDEO_MODEL} ${VIDEO_RESOLUTION}`, what: `clip ${clip} (${VIDEO_SECONDS} s)`, currency: 'credits', estimate: a.maxCredits },
    () => flow.generateVideo!({ prompt, aspect: '16:9', model: VIDEO_MODEL, duration: VIDEO_SECONDS, resolution: VIDEO_RESOLUTION, firstFrame: keyframe, maxCredits: a.maxCredits, project, out: path.join(dir, 'clips'), name: clip, timeoutMs: 1_800_000, signal: a.signal }),
    { actual: (v) => v.creditsSpent ?? v.creditsQuote }
  )
  const loc = clipLocation(episode, clip)
  const abs = store.resolve(series, loc.file)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.copyFile(r.value.file, abs)
  const seconds = await ffprobe(abs).then((p) => Number(p.format.duration) || VIDEO_SECONDS, () => VIDEO_SECONDS)
  const entry: ClipEntry = { id: clip, file: loc.level === 'series' ? loc.file : `clips/${clip}.mp4`, seconds: Math.round(seconds * 100) / 100, credits: r.amount, flowMediaId: r.value.mediaId || null, prompt, review: null }
  await upsertClip(store, series, episode, loc.level, entry)
  a.log(`clip ${clip}: ${abs} (${entry.seconds} s, ${r.amount} credits)`)
  return { entry, file: abs, credits: r.amount, keyframe, ...(polish ? { polish } : {}) }
}

export async function upsertClip(store: SeriesStore, series: string, episode: string, level: 'series' | 'episode', entry: ClipEntry): Promise<void> {
  const cur = await store.readClips(series, level === 'episode' ? episode : undefined)
  const list = cur.clips.filter((c) => c.id !== entry.id)
  list.push(entry)
  await store.writeClips(series, { schema: 'cts.clips/1', clips: list }, level === 'episode' ? episode : undefined)
}

export async function readClipEntry(store: SeriesStore, series: string, episode: string, clip: string): Promise<{ entry: ClipEntry | undefined; level: 'series' | 'episode' }> {
  const level = clipLocation(episode, clip).level
  const cur = await store.readClips(series, level === 'episode' ? episode : undefined)
  return { entry: cur.clips.find((c) => c.id === clip), level }
}

// ---- the review sheet ----

const run = (cmd: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true, timeout: 120_000 }, (err, _o, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().split('\n').slice(-2).join(' '))) : resolve())))

/** Six frames of a clip, evenly spread, in one 3x2 PNG (480x270 cells) for the frame-critic. Returns the PNG path. */
export async function clipSheet(file: string, outDir: string, clip: string, count = 6): Promise<string> {
  await fs.mkdir(outDir, { recursive: true })
  const info = await ffprobe(file)
  const dur = Number(info.format.duration) || VIDEO_SECONDS
  const cells: { input: Buffer; left: number; top: number }[] = []
  for (let i = 0; i < count; i++) {
    const t = ((i + 0.5) / count) * dur
    const png = path.join(outDir, `${clip}-f${i + 1}.png`)
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', 'scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2:color=0x808080', png])
    cells.push({ input: await fs.readFile(png), left: (i % 3) * 480, top: Math.floor(i / 3) * 270 })
  }
  const out = path.join(outDir, `${clip}-sheet.png`)
  await sharp({ create: { width: 1440, height: 540, channels: 3, background: '#808080' } }).composite(cells).png().toFile(out)
  return out
}

export const nowIso = (): string => localIso(new Date())
