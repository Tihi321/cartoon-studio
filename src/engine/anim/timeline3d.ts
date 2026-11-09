import type { Beat, Character3d, Lang, Lipsync, Set3d, TextCatalog, Timeline3d, TimelineClip, Viseme, VoiceLine, VoiceManifest } from '../../shared/contracts'
import { isVehicle } from '../../shared/contracts'
import { loadActingLibrary, moveAction } from '../blender/library'
import type { ActingAction, ActingLibrary } from '../blender/library'
import type { SeriesStore } from '../series/service'
import { hashString, mulberry32 } from './blink'
import { round3, snapToGrid } from './ease'
import { SIX_VISEMES, writeLineVisemes } from './visemes'
import { beatDuration, beatStart, DEFAULT_SIZE, exists, posix, resolveClip, resolveSeed, voiceSeconds } from './timeline'
import type { EpisodeBuildSummary, TimelineOptions } from './timeline'

/**
 * The 3D timeline builder (HUB-30 decision 5): the same beat clock as the canvas timeline (`beatStart` / `beatDuration` of `timeline.ts`), but the
 * beats become semantic actions with times (`cts.timeline3d/1`) that the Python assembler (`blender/cts_blender/assemble.py`) turns into a Blender
 * scene. Node owns the timing, Python owns the motion.
 *
 * The two languages get the same actions in the same order; only the times differ, because a line is as long as its voice. A gesture has the
 * minimum and maximum seconds of the acting library manifest: a gesture on a line takes the line's length clamped to them, and inside a longer
 * line the speaker fills the time with accents on the word onsets (small head beats, made by the library), so a gesture is never stretched past
 * its maximum. Blinks are seeded, mouths come from the six-viseme lip-sync (`rest` outside every line of the actor).
 */

/** A walk is never planned faster than this many times the character's nominal pace (the beat's `seconds` grows to fit). */
const MAX_PACE = 1.4
const WALK_KIND: Record<string, number> = { walk: 1, waddle: 1, hop: 1, run: 2.2, tiptoe: 0.6 }
/** Idle seconds before the first beat of an acted opening (a line, a move or a gesture): the actors stand and breathe before the first word. An opening clip or title card starts at 0. */
export const LEAD_IN = 0.5
const BLINK_MIN = 2.5
const BLINK_MAX = 5
/** Base actions: they set a state that holds (position, posture); two of them must not overlap. */
const BASE_ACTIONS = new Set(['walk', 'hop', 'run', 'turn', 'sit', 'stand_up'])

interface Act {
  beat: string
  action: string
  t0: number
  t1: number
  params: Record<string, unknown>
}

interface Actor3 {
  id: string
  spec: Character3d | null
  start: { mark: string; facing: 'left' | 'right' | number }
  pos: [number, number]
  actions: Act[]
  look: [number, string | null][]
  emotion: [number, string][]
  mouth: [number, Viseme][]
  speaking: [number, number][]
  accents: number[]
}

/** Metres a second at the character's usual pace for a style: the same as `nominal_walk_speed` of the acting library. */
export function nominalWalkSpeed(spec: Character3d | null, style?: string): number {
  if (!spec) return 0.8
  // a vehicle: its top speed until CTS-35 plans path moves
  if (!('walk' in spec.motion)) return spec.motion.drive.topSpeed
  const w = spec.motion.walk
  return w.stride * w.cadence * spec.motion.tempo * (WALK_KIND[style ?? w.style] ?? 1)
}

const clampTo = (a: ActingAction, seconds: number): number => round3(Math.min(a.seconds.max, Math.max(a.seconds.min, seconds)))
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length

/** The lip-sync of a line: the six-viseme file when there is one, else made now (from the WAV, the heard words and the text). */
async function visemesOf(store: SeriesStore, series: string, episode: string, lang: Lang, line: string, entry: VoiceLine | undefined, text: TextCatalog | null, seconds: number): Promise<Lipsync> {
  const existing = await store.readLipsync(series, episode, lang, line).catch(() => null)
  if (existing && existing.method !== 'amplitude') return existing
  const p = store.paths(series)
  const wav = entry && entry.status === 'ok' ? p.resolve(entry.file, p.episodeDir(episode)) : null
  return writeLineVisemes(store, series, episode, lang, line, { wavPath: wav && (await exists(wav)) ? wav : null, text: text?.lines[line]?.text ?? '', seconds, words: entry?.words ?? null })
}

/** Word onsets of a line, seconds from the line start: the heard words' starts, else the words spread over the line. */
function onsetsOf(entry: VoiceLine | undefined, text: string, seconds: number): number[] {
  if (entry?.words?.length) return entry.words.map((w) => w.t0).filter((t) => t >= 0 && t < seconds)
  const n = wordCount(text)
  return Array.from({ length: n }, (_, i) => seconds * (0.06 + (0.86 * i) / Math.max(n, 1)))
}

/** Builds, validates and writes `timeline.<lang>.json` for one language of a Blender series. */
export async function buildTimeline3d(store: SeriesStore, series: string, episode: string, lang: Lang, opts: TimelineOptions = {}): Promise<Timeline3d> {
  const warn = opts.onWarn ?? (() => undefined)
  const library: ActingLibrary = loadActingLibrary()
  const script = await store.readScript(series, episode)
  const text = await store.readText(series, episode, lang).catch(() => null)
  const manifest: VoiceManifest | null = await store.readVoiceManifest(series, episode, lang).catch(() => null)
  const seed = resolveSeed(opts.seed)
  const size = opts.size ?? DEFAULT_SIZE
  if (script.scenes.length !== 1) throw new Error(`E_SCHEMA: a Blender episode has one scene in this version (script has ${script.scenes.length}); scene changes come with phase 2`)
  const scene = script.scenes[0]!
  const set: Set3d = await store.readSet3d(series, scene.set)
  const markPoint = (name: string): [number, number] => {
    const m = set.marks[name]
    if (!m) throw new Error(`mark "${name}" is not in set "${scene.set}" (run cts_lint)`)
    return [m[0], m[1]]
  }

  const actors = new Map<string, Actor3>()
  for (const id of script.cast) {
    const s = scene.start[id]
    if (!s) warn(`"${id}" has no start mark in scene "${scene.id}"; placed on the first mark`)
    const mark = s?.mark ?? Object.keys(set.marks)[0]!
    actors.set(id, {
      id,
      spec: await store.readCharacter3d(series, id).catch(() => null),
      start: { mark, facing: s?.facing ?? 0 },
      pos: markPoint(mark),
      actions: [],
      look: [],
      emotion: s?.emotion ? [[0, s.emotion]] : [],
      mouth: [[0, 'rest']],
      speaking: [],
      accents: []
    })
  }

  const shots: Timeline3d['shots'] = [{ t: 0, shot: scene.shot, transition: 'cut' }]
  const audio: Timeline3d['audio'] = []
  const lines: Timeline3d['lines'] = []
  const clips: TimelineClip[] = []
  const titles: NonNullable<Timeline3d['titles']> = []
  const beatLog: NonNullable<Timeline3d['beats']> = []
  const openMusic = new Map<string, number>()
  const episodeClips = await store.readClips(series, episode).catch(() => ({ clips: [] as { id: string; file: string; fallback?: boolean }[] }))
  const seriesClips = await store.readClips(series).catch(() => ({ clips: [] as { id: string; file: string; fallback?: boolean }[] }))

  const act = (a: Actor3, beat: Beat, action: string, t0: number, t1: number, params: Record<string, unknown> = {}): void => {
    if (!library.byName.has(action)) {
      warn(`action "${action}" (beat ${beat.id}) is not in the acting library`)
      return
    }
    a.actions.push({ beat: beat.id, action, t0: round3(t0), t1: round3(t1), params })
  }

  const first = scene.beats.find((b) => b.type !== 'sfx' && b.type !== 'music' && b.type !== 'emote' && b.type !== 'turn' && b.type !== 'look' && !(b.type === 'camera' && b.transition === 'cut'))
  let cursor = first && (first.type === 'line' || first.type === 'move' || first.type === 'gesture') ? LEAD_IN : 0
  let maxEnd = cursor
  let prevStart = 0
  let prevLen = 0
  for (const beat of scene.beats) {
    const start = beatStart(beat, cursor, prevStart)
    let dur = 0
    let len = 0
    switch (beat.type) {
      case 'line': {
        const a = actors.get(beat.speaker)
        const entry = manifest?.lines[beat.line]
        const seconds = voiceSeconds(entry, text, beat.line)
        len = seconds
        if (a) {
          if (beat.emotion) a.emotion.push([round3(start), beat.emotion])
          if (beat.look) a.look.push([round3(start), beat.look])
          if (beat.gesture) {
            const g = library.byName.get(beat.gesture)
            if (!g) warn(`gesture "${beat.gesture}" (beat ${beat.id}) is not in the acting library`)
            else act(a, beat, beat.gesture, start, start + clampTo(g, seconds), { ...(g.needsTarget && beat.look ? { target: beat.look } : {}) })
          }
          const ls = await visemesOf(store, series, episode, lang, beat.line, entry, text, seconds)
          const end = start + seconds
          let prev: string | undefined
          ls.shapes.forEach((shape, i) => {
            const t = start + i / ls.fps
            if (t >= end - 1e-6) return
            if (shape !== prev && (SIX_VISEMES as readonly string[]).includes(shape)) a.mouth.push([round3(t), shape as Viseme])
            prev = shape
          })
          a.mouth.push([round3(end), 'rest'])
          a.speaking.push([round3(start), round3(end)])
          for (const o of onsetsOf(entry, text?.lines[beat.line]?.text ?? '', seconds)) a.accents.push(round3(start + o))
        } else warn(`line "${beat.line}": speaker "${beat.speaker}" is not in the cast`)
        dur = beatDuration(beat, { lineSeconds: seconds })
        lines.push({ id: beat.line, speaker: beat.speaker, t0: round3(start), t1: round3(start + seconds) })
        if (entry && entry.status === 'ok') audio.push({ kind: 'voice', line: beat.line, file: posix('episodes', episode, entry.file), t: round3(start), gain: 1 })
        break
      }
      case 'move': {
        const a = actors.get(beat.who)
        if (a) {
          const to = markPoint(beat.to)
          const dist = Math.hypot(to[0] - a.pos[0], to[1] - a.pos[1])
          const style = beat.style ?? (a.spec && 'walk' in a.spec.motion ? a.spec.motion.walk.style : undefined) ?? 'walk'
          // a vehicle drives or chugs (CTS-31: the action name only; CTS-35 makes the move follow its path)
          const action = a.spec && isVehicle(a.spec) ? moveAction(beat.style, a.spec) : style === 'hop' || style === 'run' ? style : 'walk'
          const need = dist / (MAX_PACE * Math.max(nominalWalkSpeed(a.spec, style), 0.05))
          const seconds = Math.max(beat.seconds, need)
          if (seconds > beat.seconds + 1e-9) warn(`move ${beat.id}: ${beat.who} needs ${seconds.toFixed(1)} s for ${dist.toFixed(1)} m, the beat said ${beat.seconds} s; lengthened`)
          act(a, beat, action, start, start + seconds, { target: beat.to, ...(beat.style && action === 'walk' ? { style: beat.style } : {}) })
          a.pos = to
          dur = seconds
          len = seconds
        } else dur = beat.seconds
        break
      }
      case 'turn': {
        const a = actors.get(beat.who)
        if (a) act(a, beat, 'turn', start, start + (library.byName.get('turn')?.seconds.default ?? 0.5), { facing: beat.facing })
        break
      }
      case 'emote': {
        const a = actors.get(beat.who)
        if (a) a.emotion.push([round3(start), beat.emotion])
        break
      }
      case 'gesture': {
        const a = actors.get(beat.who)
        const g = library.byName.get(beat.gesture)
        if (!g) warn(`gesture "${beat.gesture}" (beat ${beat.id}) is not in the acting library`)
        const seconds = g ? clampTo(g, beat.with === 'prev' ? prevLen || g.seconds.default : g.seconds.default) : 0
        if (a && g) act(a, beat, beat.gesture, start, start + seconds, { ...(beat.target ? { target: beat.target } : {}) })
        dur = beatDuration(beat, { gestureSeconds: seconds })
        len = dur
        break
      }
      case 'look': {
        const a = actors.get(beat.who)
        if (a) a.look.push([round3(start), beat.target])
        break
      }
      case 'camera': {
        dur = beatDuration(beat)
        shots.push({ t: round3(start), shot: beat.shot, transition: beat.transition, ...(beat.transition !== 'cut' ? { seconds: dur } : {}) })
        break
      }
      case 'pause':
        dur = beatDuration(beat)
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
            const gain = Math.min(1, beat.gain ?? 1)
            audio.push({ kind: 'music', file: script.music[beat.cue]!, t: round3(start), until: -1, gain, duckTo: round3(gain * 0.126) })
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
        dur = beatDuration(beat)
        titles.push({ id: beat.id, text: text?.strings[beat.key] ?? beat.key, t0: round3(start), t1: round3(start + dur) })
        break
      }
      case 'clip': {
        dur = beatDuration(beat)
        clips.push(await resolveClip(store, series, episode, beat.clip, beat.audio, start, dur, episodeClips.clips, seriesClips.clips))
        break
      }
    }
    const end = start + dur
    beatLog.push({ id: beat.id, t0: round3(start), t1: round3(end) })
    prevStart = start
    prevLen = len
    cursor = Math.max(cursor, end)
    maxEnd = Math.max(maxEnd, end)
  }

  for (const e of audio) if (e.kind === 'music' && e.until >= 0) maxEnd = Math.max(maxEnd, e.until)
  const duration = round3(Math.max(maxEnd, cursor))
  for (const e of audio) if (e.kind === 'music' && e.until < 0) e.until = duration
  audio.sort((a, b) => a.t - b.t)

  const timelineActors: Timeline3d['actors'] = {}
  for (const a of actors.values()) {
    a.actions.sort((p, q) => p.t0 - q.t0 || p.t1 - q.t1)
    const base = a.actions.filter((x) => BASE_ACTIONS.has(x.action))
    for (let i = 1; i < base.length; i++) if (base[i]!.t0 < base[i - 1]!.t1 - 1e-9) warn(`"${a.id}": ${base[i]!.action} (${base[i]!.beat}) starts before ${base[i - 1]!.action} (${base[i - 1]!.beat}) ends`)
    a.look.sort((p, q) => p[0] - q[0])
    a.mouth.sort((p, q) => p[0] - q[0])
    const mouth = a.mouth.filter((k, i) => i === 0 || k[1] !== a.mouth[i - 1]![1] || k[0] === a.mouth[i - 1]![0])
    timelineActors[a.id] = {
      start: a.start,
      actions: a.actions,
      look: a.look,
      emotion: a.emotion.sort((p, q) => p[0] - q[0]).filter((k, i, all) => i === 0 || k[1] !== all[i - 1]![1]),
      mouth: collapseMouth(mouth),
      blinks: blinkTimes(seed, a.id, duration),
      speaking: a.speaking,
      accents: [...new Set(a.accents)].sort((p, q) => p - q)
    }
  }

  const timeline: Timeline3d = {
    schema: 'cts.timeline3d/1',
    series,
    episode,
    lang,
    scriptHash: await store.scriptHash(series, episode),
    fps: 24,
    size,
    duration,
    seed,
    scenes: [{ id: scene.id, set: scene.set, t0: 0, t1: round3(cursor) }],
    actors: timelineActors,
    shots: shots.sort((a, b) => a.t - b.t),
    audio,
    lines,
    clips,
    beats: beatLog,
    ...(titles.length ? { titles } : {})
  }
  return store.writeTimeline3d(series, episode, lang, timeline)
}

/** At one time only the last key counts; a key that repeats the shape before it is dropped. */
function collapseMouth(keys: [number, Viseme][]): [number, Viseme][] {
  const out: [number, Viseme][] = []
  for (const k of keys) {
    const last = out[out.length - 1]
    if (last && Math.abs(last[0] - k[0]) < 1e-9) out[out.length - 1] = k
    else out.push(k)
  }
  return out.filter((k, i) => i === 0 || k[1] !== out[i - 1]![1])
}

/** Seeded blinks every 2.5 to 5 s on the animation grid (each actor has its own stream of the timeline seed). */
export function blinkTimes(seed: number, actor: string, duration: number): number[] {
  const rand = mulberry32((seed ^ hashString(actor)) >>> 0)
  const out: number[] = []
  let t = 0
  for (;;) {
    t += BLINK_MIN + rand() * (BLINK_MAX - BLINK_MIN)
    if (t > duration - 0.3) break
    out.push(round3(snapToGrid(t, 24)))
  }
  return out
}

/** The whole step behind `cts_timeline_build` for a Blender series: six-viseme lip-sync for every line of every language, then every 3D timeline. */
export async function buildEpisodeTimelines3d(store: SeriesStore, series: string, episode: string, opts: TimelineOptions = {}): Promise<EpisodeBuildSummary> {
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
      await writeLineVisemes(store, series, episode, lang, id, { wavPath: wav, text: text?.lines[id]?.text ?? '', seconds, words: entry?.words ?? null })
      if (wav) stats.audio++
      else stats.rest++
    }
    const warnings: string[] = []
    const tl = await buildTimeline3d(store, series, episode, lang, { ...opts, onWarn: (m) => (warnings.push(m), opts.onWarn?.(m)) })
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
