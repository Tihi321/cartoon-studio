import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CameraKey, EyeState, Facing, Lang, Lipsync, MouthShape, NumKey, Rig, SetFile, TextCatalog, Timeline, TimelineClip, VoiceLine, VoiceManifest } from '../../shared/contracts'
import { sampleNumber, sampleStep } from '../../shared/sample'
import type { SeriesStore } from '../series/service'
import { blinkTrack } from './blink'
import { round3 } from './ease'
import { LIPSYNC_FPS, restTrack, writeLineLipsync } from './lipsync'

/**
 * The timeline builder: walks the beats of `script.json` with a clock and writes `timeline.<lang>.json` (the only input of the player and the
 * render besides asset files). Same script, different voice lengths: every language gets its own times but the same beats in the same order.
 */

export const ANIM_FPS = LIPSYNC_FPS
export const OUT_FPS = 24
export const DEFAULT_SIZE: [number, number] = [1920, 1080]
export const DEFAULT_SEED = 29
export const DEFAULT_PAUSE_AFTER = 0.25
export const WORDS_PER_SECOND = 2.5
const DEFAULT_PAN_SECONDS = 1
/** The music `gain` is only a trim (1 = 0 dB, never above); the level under the voice comes from render.md `mix` (CTS-16). */
const DEFAULT_MUSIC_GAIN = 1
/** `duckTo` is this share of the music gain while a voice plays. The mix ignores it (it ducks by `mix.musicUnderVoiceDb`); 0.126 is the same 18 - 8 = 10 dB, kept so the timeline schema is unchanged. */
const DUCK_SHARE = 0.126

export interface TimelineOptions {
  /** Blink seed. Default: `CTS_SEED`, else 29. */
  seed?: number
  size?: [number, number]
  /** Called with a note for every cue or gesture that could not be resolved (the lint reports the cause). */
  onWarn?: (message: string) => void
}

export const resolveSeed = (seed?: number): number => {
  if (seed !== undefined) return Math.trunc(seed)
  const env = Number(process.env.CTS_SEED)
  return Number.isFinite(env) && process.env.CTS_SEED ? Math.trunc(env) : DEFAULT_SEED
}

const posix = (...parts: string[]) => path.posix.join(...parts.map((p) => p.replace(/\\/g, '/')))
const exists = (file: string) => fs.stat(file).then((s) => s.isFile(), () => false)

/** Inserts a key keeping time order; a key at the same time is replaced. */
function put<T extends readonly [number, ...unknown[]]>(track: T[], key: T): void {
  const t = round3(key[0])
  const k = [t, ...key.slice(1)] as unknown as T
  let i = track.length
  while (i > 0 && track[i - 1]![0] > t + 1e-9) i--
  if (i > 0 && Math.abs(track[i - 1]![0] - t) <= 1e-9) track[i - 1] = k
  else track.splice(i, 0, k)
}
/** Removes a discrete key that repeats the value before it (the track means the same without it). */
function dedupe<T>(track: [number, T][]): [number, T][] {
  return track.filter((k, i) => i === 0 || k[1] !== track[i - 1]![1])
}
/** Drops the keys after `t` (a new move or gesture cuts the earlier one off). */
function truncateAfter(track: readonly (readonly [number, ...unknown[]])[], t: number): void {
  const list = track as unknown as (readonly [number, ...unknown[]])[]
  while (list.length > 0 && list[list.length - 1]![0] > t + 1e-9) list.pop()
}

interface ActorState {
  id: string
  rig: Rig | null
  x: NumKey[]
  y: NumKey[]
  facing: [number, Facing][]
  visible: [number, boolean][]
  emotion: [number, string][]
  eyesBase: [number, EyeState][]
  mouth: [number, MouthShape][]
  rot: Record<string, NumKey[]>
  bob: NumKey[]
  gestureSpans: [number, number][]
  /** The stretches where a gesture's pose image replaces the parts (the middle 60 % of the gesture); `face`: the pose draws the face plates, so a line may run over it. */
  poseSpans: { t0: number; t1: number; name: string; face: boolean }[]
  /** True after an explicit turn or look: the actor stops turning to face each speaker until it moves or speaks. */
  locked: boolean
}

/** The share of a gesture (its `seconds`) in which its pose image is shown: the middle 60 %. */
const POSE_FROM = 0.2
const POSE_TO = 0.8

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length

function voiceSeconds(entry: VoiceLine | undefined, text: TextCatalog | null, lineId: string): number {
  if (entry && entry.seconds > 0) return entry.seconds
  const words = wordCount(text?.lines[lineId]?.text ?? '')
  return Math.max(0.5, words / WORDS_PER_SECOND)
}

/** Builds, validates and writes `timeline.<lang>.json` for one language. */
export async function buildTimeline(store: SeriesStore, series: string, episode: string, lang: Lang, opts: TimelineOptions = {}): Promise<Timeline> {
  const warn = opts.onWarn ?? (() => undefined)
  const script = await store.readScript(series, episode)
  const text = await store.readText(series, episode, lang).catch(() => null)
  const manifest: VoiceManifest | null = await store.readVoiceManifest(series, episode, lang).catch(() => null)
  const seed = resolveSeed(opts.seed)
  const size = opts.size ?? DEFAULT_SIZE

  const rigs = new Map<string, Rig | null>()
  for (const id of script.cast) rigs.set(id, await store.readRig(series, id).catch(() => null))

  const eyesOf = (actor: ActorState, emotion: string): EyeState => actor.rig?.emotions[emotion]?.eyes ?? actor.rig?.emotions.neutral?.eyes ?? 'open'

  const actors = new Map<string, ActorState>()
  for (const id of script.cast) {
    actors.set(id, { id, rig: rigs.get(id) ?? null, x: [], y: [], facing: [], visible: [], emotion: [], eyesBase: [], mouth: [[0, 'rest']], rot: {}, bob: [[0, 0, 'step']], gestureSpans: [], poseSpans: [], locked: false })
  }
  const actor = (id: string): ActorState | undefined => actors.get(id)

  const camera: CameraKey[] = []
  const putCamera = (k: CameraKey) => {
    const last = camera[camera.length - 1]
    if (last && Math.abs(last.t - k.t) < 1e-9) camera[camera.length - 1] = k
    else camera.push(k)
  }

  const audio: Timeline['audio'] = []
  const lines: Timeline['lines'] = []
  const clips: TimelineClip[] = []
  const titles: NonNullable<Timeline['titles']> = []
  const beatLog: NonNullable<Timeline['beats']> = []
  const scenes: Timeline['scenes'] = []
  const openMusic = new Map<string, number>()
  let maxEnd = 0

  const episodeClips = await store.readClips(series, episode).catch(() => ({ clips: [] as { id: string; file: string; fallback?: boolean }[] }))
  const seriesClips = await store.readClips(series).catch(() => ({ clips: [] as { id: string; file: string; fallback?: boolean }[] }))

  let cursor = 0
  for (const scene of script.scenes) {
    const set: SetFile = await store.readSet(series, scene.set)
    const markPoint = (name: string): [number, number] => {
      const m = set.marks[name]
      if (!m) throw new Error(`mark "${name}" is not in set "${scene.set}" (run cts_lint)`)
      return [m[0], m[1]]
    }
    const shotKey = (name: string) => {
      const s = set.shots[name]
      if (!s) throw new Error(`shot "${name}" is not in set "${scene.set}" (run cts_lint)`)
      return s
    }
    const sceneT0 = cursor

    // scene start: positions, facing, visibility, emotion, and a cut to the scene's shot
    for (const a of actors.values()) {
      const s = scene.start[a.id]
      const emotion = s?.emotion ?? sampleStep(a.emotion, sceneT0) ?? 'neutral'
      if (s) {
        const [mx, my] = markPoint(s.mark)
        put(a.x, [sceneT0, mx, 'step'])
        put(a.y, [sceneT0, my, 'step'])
        put(a.facing, [sceneT0, s.facing ?? sampleStep(a.facing, sceneT0) ?? 'right'])
      } else {
        if (a.x.length === 0) {
          put(a.x, [sceneT0, set.size[0] / 2, 'step'])
          put(a.y, [sceneT0, set.groundY, 'step'])
          put(a.facing, [sceneT0, 'right'])
        }
      }
      put(a.visible, [sceneT0, !!s])
      put(a.emotion, [sceneT0, emotion])
      put(a.eyesBase, [sceneT0, eyesOf(a, emotion)])
      a.locked = false
    }
    const shot0 = shotKey(scene.shot)
    putCamera({ t: sceneT0, center: [shot0.center[0], shot0.center[1]], zoom: shot0.zoom, ease: 'cut' })

    const faceToward = (a: ActorState, targetId: string, t: number) => {
      const target = actor(targetId)
      if (!target || target === a) return
      const ax = sampleNumber(a.x, t)
      const tx = sampleNumber(target.x, t)
      if (Math.abs(tx - ax) < 1e-6) return
      put(a.facing, [t, tx > ax ? 'right' : 'left'])
    }
    const onStage = (a: ActorState, t: number) => {
      if (sampleStep(a.visible, t) === false) return false
      const x = sampleNumber(a.x, t)
      return x >= 0 && x <= set.size[0]
    }
    const playGesture = (a: ActorState, name: string, t: number): number => {
      const g = a.rig?.gestures[name]
      if (!g) {
        warn(`gesture "${name}" is not in the rig of "${a.id}"`)
        return 0
      }
      const track = (a.rot[g.part] ??= [[0, 0, 'step']])
      truncateAfter(track, t - 1e-9)
      for (const [frac, deg] of g.keys) put(track, [t + frac * g.seconds, deg, 'inOut'])
      const lastKey = track[track.length - 1]!
      track[track.length - 1] = [lastKey[0], lastKey[1], 'step']
      a.gestureSpans.push([t, t + g.seconds])
      const poseDef = g.pose ? a.rig?.poses?.[g.pose] : undefined
      if (g.pose && poseDef) {
        // a later gesture cuts the earlier pose image off
        for (const sp of a.poseSpans) if (sp.t1 > t) sp.t1 = Math.max(sp.t0, t)
        a.poseSpans.push({ t0: t + POSE_FROM * g.seconds, t1: t + POSE_TO * g.seconds, name: g.pose, face: !!poseDef.face })
      } else if (g.pose) warn(`gesture "${name}" of "${a.id}" names pose "${g.pose}" which the rig does not have`)
      return g.seconds
    }

    let prevStart = cursor
    for (const beat of scene.beats) {
      const start = beat.with === 'prev' ? prevStart : cursor
      let dur = 0
      switch (beat.type) {
        case 'line': {
          const a = actor(beat.speaker)
          const entry = manifest?.lines[beat.line]
          const seconds = voiceSeconds(entry, text, beat.line)
          if (a) {
            if (beat.emotion) {
              put(a.emotion, [start, beat.emotion])
              put(a.eyesBase, [start, eyesOf(a, beat.emotion)])
            }
            if (beat.look) faceToward(a, beat.look, start)
            a.locked = false
            if (beat.gesture) playGesture(a, beat.gesture, start)
            for (const other of actors.values()) {
              if (other === a || other.locked || !onStage(other, start) || !onStage(a, start)) continue
              faceToward(other, a.id, start)
            }
            // mouth: the line's lip-sync track from its start, rest after its last frame and outside every line
            const ls = await lipsyncOf(store, series, episode, lang, beat.line, entry, seconds)
            const end = start + seconds
            let prev: MouthShape | undefined
            ls.shapes.forEach((shape, i) => {
              const t = start + i / ls.fps
              if (t >= end - 1e-6) return
              if (shape !== prev) put(a.mouth, [t, shape])
              prev = shape
            })
            if (!a.mouth.some((k) => Math.abs(k[0] - round3(end)) < 1e-6)) put(a.mouth, [end, 'rest'])
          } else warn(`line "${beat.line}": speaker "${beat.speaker}" is not in the cast`)
          dur = seconds + (beat.pauseAfter ?? DEFAULT_PAUSE_AFTER)
          lines.push({ id: beat.line, speaker: beat.speaker, t0: round3(start), t1: round3(start + seconds) })
          if (entry && entry.status === 'ok') audio.push({ kind: 'voice', line: beat.line, file: posix('episodes', episode, entry.file), t: round3(start), gain: 1 })
          break
        }
        case 'move': {
          const a = actor(beat.who)
          if (a) {
            const [tx, ty] = markPoint(beat.to)
            const fx = sampleNumber(a.x, start)
            const fy = sampleNumber(a.y, start)
            for (const track of [a.x, a.y, a.bob]) truncateAfter(track, start)
            put(a.x, [start, fx, 'linear'])
            put(a.x, [start + beat.seconds, tx, 'step'])
            put(a.y, [start, fy, 'linear'])
            put(a.y, [start + beat.seconds, ty, 'step'])
            // bob is an amplitude 0..1 of the rig's move.bobPx (the player scales it): 1 while moving, 0 otherwise
            put(a.bob, [start, 1, 'step'])
            put(a.bob, [start + beat.seconds, 0, 'step'])
            put(a.visible, [start, true])
            if (Math.abs(tx - fx) > 1e-6) put(a.facing, [start, tx > fx ? 'right' : 'left'])
            a.locked = false
          }
          dur = beat.seconds
          break
        }
        case 'turn': {
          const a = actor(beat.who)
          if (a) {
            put(a.facing, [start, beat.facing])
            a.locked = true
          }
          break
        }
        case 'emote': {
          const a = actor(beat.who)
          if (a) {
            put(a.emotion, [start, beat.emotion])
            put(a.eyesBase, [start, eyesOf(a, beat.emotion)])
          }
          break
        }
        case 'gesture': {
          const a = actor(beat.who)
          if (a) dur = playGesture(a, beat.gesture, start)
          break
        }
        case 'look': {
          const a = actor(beat.who)
          if (a) {
            faceToward(a, beat.target, start)
            a.locked = true
          }
          break
        }
        case 'camera': {
          const shot = shotKey(beat.shot)
          const target = { center: [shot.center[0], shot.center[1]] as [number, number], zoom: shot.zoom }
          if (beat.transition === 'pan') {
            const seconds = beat.seconds ?? DEFAULT_PAN_SECONDS
            const last = camera[camera.length - 1]!
            if (Math.abs(last.t - start) < 1e-9) camera[camera.length - 1] = { ...last, ease: 'inOut' }
            else camera.push({ t: round3(start), center: [...last.center], zoom: last.zoom, ease: 'inOut' })
            putCamera({ t: round3(start + seconds), ...target, ease: 'cut' })
            dur = seconds
          } else putCamera({ t: round3(start), ...target, ease: 'cut' })
          break
        }
        case 'pause':
          dur = beat.seconds
          break
        case 'sfx': {
          const file = script.sfx[beat.cue]
          if (file) audio.push({ kind: 'sfx', file, t: round3(start), gain: 0.8 })
          else warn(`sfx cue "${beat.cue}" is not in the script`)
          break
        }
        case 'music': {
          if (beat.action === 'start') {
            if (!script.music[beat.cue]) warn(`music cue "${beat.cue}" is not in the script`)
            else {
              const gain = Math.min(1, beat.gain ?? DEFAULT_MUSIC_GAIN)
              audio.push({ kind: 'music', file: script.music[beat.cue]!, t: round3(start), until: -1, gain, duckTo: round3(gain * DUCK_SHARE) })
              openMusic.set(beat.cue, audio.length - 1)
            }
          } else {
            const i = openMusic.get(beat.cue)
            const entry = i === undefined ? undefined : audio[i]
            if (entry && entry.kind === 'music') {
              const fade = beat.fade ?? 0
              entry.until = round3(start + fade)
              if (fade > 0) entry.fadeOut = fade
              openMusic.delete(beat.cue)
            }
          }
          break
        }
        case 'title': {
          dur = beat.seconds
          titles.push({ id: beat.id, text: text?.strings[beat.key] ?? beat.key, t0: round3(start), t1: round3(start + dur) })
          break
        }
        case 'clip': {
          dur = beat.seconds
          clips.push(await resolveClip(store, series, episode, beat.clip, beat.audio, start, dur, episodeClips.clips, seriesClips.clips))
          break
        }
      }
      const end = start + dur
      beatLog.push({ id: beat.id, t0: round3(start), t1: round3(end) })
      prevStart = start
      cursor = Math.max(cursor, end)
      maxEnd = Math.max(maxEnd, end)
    }
    scenes.push({ id: scene.id, set: scene.set, t0: round3(sceneT0), t1: round3(cursor) })
  }

  for (const e of audio) if (e.kind === 'music' && e.until >= 0) maxEnd = Math.max(maxEnd, e.until)
  const duration = round3(Math.max(maxEnd, cursor))
  for (const e of audio) if (e.kind === 'music' && e.until < 0) e.until = duration
  audio.sort((a, b) => a.t - b.t)

  const timelineActors: Timeline['actors'] = {}
  for (const a of actors.values()) {
    const eyes = blinkTrack({ seed, actor: a.id, duration, fps: ANIM_FPS, base: a.eyesBase, avoid: a.gestureSpans })
    // a pose image without face plates has no lip-sync: it never covers a line of its actor (the gesture stays a part rotation there)
    const spans = a.poseSpans.filter((sp) => sp.t1 > sp.t0 && (sp.face || !lines.some((l) => l.speaker === a.id && l.t0 < sp.t1 - 1e-9 && l.t1 > sp.t0 + 1e-9))).sort((p, q) => p.t0 - q.t0)
    const pose: [number, string | null][] = spans.flatMap((sp): [number, string | null][] => [[round3(sp.t0), sp.name], [round3(sp.t1), null]])
    timelineActors[a.id] = { x: a.x, y: a.y, facing: dedupe(a.facing), visible: dedupe(a.visible), emotion: dedupe(a.emotion), eyes: dedupe(eyes), mouth: dedupe(a.mouth), rot: a.rot, bob: a.bob, ...(pose.length ? { pose } : {}) }
  }

  const timeline: Timeline = {
    schema: 'cts.timeline/1',
    series,
    episode,
    lang,
    scriptHash: await store.scriptHash(series, episode),
    size,
    fps: { anim: ANIM_FPS, out: OUT_FPS },
    duration,
    seed,
    scenes,
    camera,
    actors: timelineActors,
    audio,
    lines,
    clips,
    beats: beatLog,
    ...(titles.length ? { titles } : {})
  }
  return store.writeTimeline(series, episode, lang, timeline)
}

/** The lip-sync track of a line: the file when there is one, else made from the WAV when it exists, else all `rest`. */
async function lipsyncOf(store: SeriesStore, series: string, episode: string, lang: Lang, line: string, entry: VoiceLine | undefined, seconds: number): Promise<Lipsync> {
  const existing = await store.readLipsync(series, episode, lang, line).catch(() => null)
  if (existing) return existing
  if (!entry || entry.status !== 'ok') return restTrack(seconds)
  const wav = store.paths(series).resolve(entry.file, store.paths(series).episodeDir(episode))
  return writeLineLipsync(store, series, episode, lang, line, (await exists(wav)) ? wav : null, seconds)
}

/** A clip beat -> the timeline entry: the episode's `clips/` first, then the series' `clips/`; a missing file (or a dropped clip) is a fallback. */
async function resolveClip(
  store: SeriesStore,
  series: string,
  episode: string,
  id: string,
  audioMode: 'keep' | 'mute',
  t0: number,
  seconds: number,
  episodeList: readonly { id: string; file: string; fallback?: boolean }[],
  seriesList: readonly { id: string; file: string; fallback?: boolean }[]
): Promise<TimelineClip> {
  const p = store.paths(series)
  const candidates = [
    { entry: episodeList.find((c) => c.id === id), base: p.episodeDir(episode), rel: (f: string) => posix('episodes', episode, f), dir: p.episodeClipsDir(episode), relDir: posix('episodes', episode, 'clips') },
    { entry: seriesList.find((c) => c.id === id), base: p.root, rel: (f: string) => posix(f), dir: p.clipsDir, relDir: 'clips' }
  ]
  for (const c of candidates) {
    const abs = c.entry ? p.resolve(c.entry.file, c.base) : path.join(c.dir, `${id}.mp4`)
    if (await exists(abs)) {
      return { id, file: c.entry ? c.rel(c.entry.file) : posix(c.relDir, `${id}.mp4`), t0: round3(t0), t1: round3(t0 + seconds), audio: audioMode, fallback: c.entry?.fallback === true }
    }
  }
  const listed = candidates.find((c) => c.entry)
  return {
    id,
    file: listed ? listed.rel(listed.entry!.file) : posix(candidates[0]!.relDir, `${id}.mp4`),
    t0: round3(t0),
    t1: round3(t0 + seconds),
    audio: audioMode,
    fallback: true
  }
}

export interface EpisodeBuildSummary {
  series: string
  episode: string
  scriptHash: string
  languages: {
    lang: Lang
    duration: number
    lines: number
    beats: number
    clips: number
    /** Lip-sync tracks written from audio / written as all `rest` (placeholder, failed or missing audio). */
    lipsync: { audio: number; rest: number }
    timeline: string
    warnings: string[]
  }[]
}

/**
 * The whole step behind `cts_timeline_build`: lip-sync for every line of every language of the bible, then every timeline. The timelines share
 * one script so their beat order is the same; the voice lengths make the times differ.
 */
export async function buildEpisodeTimelines(store: SeriesStore, series: string, episode: string, opts: TimelineOptions = {}): Promise<EpisodeBuildSummary> {
  const bible = await store.readBible(series)
  const script = await store.readScript(series, episode)
  const p = store.paths(series)
  const lineIds = [...new Set(script.scenes.flatMap((s) => s.beats.flatMap((b) => (b.type === 'line' ? [b.line] : []))))]
  const languages: EpisodeBuildSummary['languages'] = []
  for (const lang of bible.languages) {
    const manifest = await store.readVoiceManifest(series, episode, lang).catch(() => null)
    const text = await store.readText(series, episode, lang).catch(() => null)
    const stats = { audio: 0, rest: 0 }
    for (const id of lineIds) {
      const entry = manifest?.lines[id]
      const seconds = voiceSeconds(entry, text, id)
      let wav: string | null = null
      if (entry && entry.status === 'ok') {
        const abs = p.resolve(entry.file, p.episodeDir(episode))
        if (await exists(abs)) wav = abs
      }
      await writeLineLipsync(store, series, episode, lang, id, wav, seconds)
      if (wav) stats.audio++
      else stats.rest++
    }
    const warnings: string[] = []
    const tl = await buildTimeline(store, series, episode, lang, { ...opts, onWarn: (m) => (warnings.push(m), opts.onWarn?.(m)) })
    languages.push({
      lang,
      duration: tl.duration,
      lines: tl.lines.length,
      beats: tl.beats?.length ?? 0,
      clips: tl.clips.length,
      lipsync: stats,
      timeline: posix('episodes', episode, `timeline.${lang}.json`),
      warnings
    })
  }
  return { series, episode, scriptHash: await store.scriptHash(series, episode), languages }
}
