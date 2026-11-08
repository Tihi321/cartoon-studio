import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Lang } from '../../shared/contracts'
import type { Engine } from '../engine'
import type { CtsService } from '../service'
import { SeriesStore } from '../series/service'
import { endBlenderStage, noteBlenderStage } from './stage'
import { BlenderError, blenderRunnerFor } from './runner'
import type { BlenderRunner } from './runner'

/**
 * The jobs of the Blender backend: building a character (`character.blend`, `sheet.png`, `build.json`), a set (`set.blend`, `sheet.png`,
 * `build.json`) and assembling an episode (`render/<lang>/scene.blend`, `assembly.json`). They are queue jobs (`<series>--character_build--<cast>--r<n>`,
 * `<series>--set_build--<set>--r<n>`, `<series>--scene_assemble--<episode>-<lang>--r<n>`; no model) that report `job.progress` from the Blender progress lines.
 *
 * A mistake in the spec that Blender finds (E_FACE_HIDDEN, E_SPEC_INVALID, E_STYLE_INVALID) is the job's result, `{ ok: false, code, message }`, so the
 * designer reads it and fixes the spec; anything else (Blender missing, a crash) fails the job.
 */

/** Errors that say "the spec is wrong", not "Blender is broken". */
const SPEC_CODES = new Set(['E_FACE_HIDDEN', 'E_SPEC_INVALID', 'E_STYLE_INVALID', 'E_SET_INVALID'])
/** Errors of the assembler that say "the timeline or an asset does not fit" (the job result, not a crash). */
const ASSEMBLE_CODES = new Set(['E_ASSEMBLE_FAILED', 'E_ACTION_UNKNOWN', 'E_MARK_UNKNOWN', 'E_SHOT_UNKNOWN', 'E_SCHEMA', ...SPEC_CODES])

export type BuildResult =
  | { ok: true; kind: 'character' | 'set'; id: string; blend: string; sheet: string | null; build: string; specHash: string; warnings: string[]; buildSeconds: number; hash: Record<string, string> }
  | { ok: false; kind: 'character' | 'set'; id: string; code: string; message: string }

export const sha1 = (data: string | Buffer): string => createHash('sha1').update(data).digest('hex')

/** The look file of a series: what the bible names, else `style3d.json`; undefined when there is none (Blender then uses the defaults). */
export async function styleFileOf(store: SeriesStore, series: string): Promise<string | undefined> {
  let rel: string | undefined
  try {
    rel = (await store.readBible(series)).style3d
  } catch {
    /* no readable bible: the default name */
  }
  const file = store.paths(series).style3dFile(rel)
  return (await store.exists(file)) ? file : undefined
}

interface BuildOptions {
  dataDir: string
  series: string
  id: string
  sheet?: boolean
  runner?: BlenderRunner
  signal?: AbortSignal
  onProgress?: (fraction: number, message?: string) => void
  onLog?: (line: string) => void
}

async function runBuild(kind: 'character' | 'set', o: BuildOptions): Promise<BuildResult> {
  const store = new SeriesStore(o.dataDir)
  const p = store.paths(o.series)
  const specFile = kind === 'character' ? p.characterFile(o.id) : p.set3dFile(o.id)
  const outDir = kind === 'character' ? p.castDir(o.id) : p.setDir(o.id)
  if (!(await store.exists(specFile))) throw new Error(`no ${kind} spec at ${path.relative(p.root, specFile)} (cts_${kind === 'character' ? 'character' : 'set3d'}_set first)`)
  const runner = o.runner ?? (await blenderRunnerFor(o.dataDir))
  const style = await styleFileOf(store, o.series)
  const task = kind === 'character' ? 'character_build' : 'set_build'
  noteBlenderStage(o.series, { task, unit: o.id, stage: 'starting', fraction: null })
  try {
    const r = await runner.run(
      kind === 'character' ? 'build-character' : 'build-set',
      { spec: specFile, outDir, sheet: o.sheet !== false, ...(style ? { style } : {}) },
      {
        signal: o.signal,
        onLog: o.onLog,
        onProgress: (e) => {
          noteBlenderStage(o.series, { task, unit: o.id, stage: e.stage ?? 'working', fraction: e.total ? e.done / e.total : null })
          o.onProgress?.(e.total ? e.done / e.total : 0, e.stage)
        }
      }
    )
    return {
      ok: true,
      kind,
      id: o.id,
      blend: String(r.blend),
      sheet: typeof r.sheet === 'string' ? r.sheet : null,
      build: String(r.build),
      specHash: String(r.specHash),
      warnings: (r.warnings as string[] | undefined) ?? [],
      buildSeconds: Number(r.buildSeconds ?? 0),
      hash: (r.hash as Record<string, string> | undefined) ?? {}
    }
  } catch (e) {
    if (e instanceof BlenderError && SPEC_CODES.has(e.code)) return { ok: false, kind, id: o.id, code: e.code, message: e.detail }
    throw e
  } finally {
    endBlenderStage(o.series, task, o.id)
  }
}

export type AssembleResult =
  | { ok: true; blend: string; assembly: string; frames: number; actions: string[]; shots: number; warnings: string[]; assembleSeconds: number }
  | { ok: false; code: string; message: string }

/** `episodes/<ep>/render/<lang>`: the assembled scene, the render log and the Blender frame times. */
export const renderDirOf = (dataDir: string, series: string, episode: string, lang: Lang): string => path.join(new SeriesStore(dataDir).paths(series).episodeDir(episode), 'render', lang)

/** The inputs of the assembler for an episode: the timeline, the look, the set and the characters of the timeline, all built. */
export async function assembleInputs(store: SeriesStore, series: string, episode: string, lang: Lang): Promise<{ job: Record<string, unknown>; blend: string; outDir: string }> {
  const p = store.paths(series)
  const tl = await store.readTimeline3d(series, episode, lang).catch((e: Error) => {
    throw new Error(`no 3D timeline for ${lang} (${e.message}): cts_timeline_build first`)
  })
  if (tl.scriptHash !== (await store.scriptHash(series, episode))) throw new Error('E_TIMELINE_STALE: timeline.' + lang + '.json was built from another script.json (cts_timeline_build)')
  const setId = tl.scenes[0]?.set
  if (!setId) throw new Error('the timeline has no scene')
  const needed = async (file: string, what: string) => {
    if (!(await store.exists(file))) throw new Error(`${what} is not built (${path.relative(p.root, file).split(path.sep).join('/')} is missing)`)
    return file
  }
  const characters: Record<string, unknown> = {}
  for (const id of Object.keys(tl.actors)) {
    characters[id] = {
      spec: await needed(p.characterFile(id), `character "${id}" has no spec; it`),
      blend: await needed(path.join(p.castDir(id), 'character.blend'), `character "${id}"`),
      build: path.join(p.castDir(id), 'build.json')
    }
  }
  const style = await styleFileOf(store, series)
  const outDir = path.join(p.episodeDir(episode), 'render', lang)
  return {
    job: {
      timeline: p.timelineFile(episode, lang),
      outDir,
      ...(style ? { style } : {}),
      set: { id: setId, spec: await needed(p.set3dFile(setId), `set "${setId}" has no spec; it`), blend: await needed(path.join(p.setDir(setId), 'set.blend'), `set "${setId}"`), build: path.join(p.setDir(setId), 'build.json') },
      characters
    },
    blend: path.join(outDir, 'scene.blend'),
    outDir
  }
}

/** Assembles one language of an episode into `render/<lang>/scene.blend` and `assembly.json`. A timeline or asset that does not fit comes back as the result. */
export async function assembleScene(o: { dataDir: string; series: string; episode: string; lang: Lang; runner?: BlenderRunner; signal?: AbortSignal; onProgress?: (fraction: number, message?: string) => void; onLog?: (line: string) => void }): Promise<AssembleResult> {
  const store = new SeriesStore(o.dataDir)
  const { job } = await assembleInputs(store, o.series, o.episode, o.lang)
  const runner = o.runner ?? (await blenderRunnerFor(o.dataDir))
  const unit = `${o.episode}-${o.lang}`
  noteBlenderStage(o.series, { task: 'scene_assemble', unit, stage: 'starting', fraction: null })
  try {
    const r = await runner.run('assemble', job, {
      signal: o.signal,
      onLog: o.onLog,
      onProgress: (e) => {
        noteBlenderStage(o.series, { task: 'scene_assemble', unit, stage: e.stage ?? 'working', fraction: e.total ? e.done / e.total : null })
        o.onProgress?.(e.total ? e.done / e.total : 0, e.stage)
      }
    })
    return { ok: true, blend: String(r.blend), assembly: String(r.assembly), frames: Number(r.frames), actions: (r.actions as string[] | undefined) ?? [], shots: Number(r.shots ?? 0), warnings: (r.warnings as string[] | undefined) ?? [], assembleSeconds: Number(r.assembleSeconds ?? 0) }
  } catch (e) {
    if (e instanceof BlenderError && ASSEMBLE_CODES.has(e.code)) return { ok: false, code: e.code, message: e.detail }
    throw e
  } finally {
    endBlenderStage(o.series, 'scene_assemble', unit)
  }
}

/** One frame of the assembled scene as a PNG (default 960x540, 4 samples: a quick look). `t` is seconds into the film. */
export async function stillFrame(o: { dataDir: string; series: string; episode: string; lang: Lang; t: number; width?: number; height?: number; samples?: number; out?: string; runner?: BlenderRunner; signal?: AbortSignal }): Promise<{ file: string; frame: number }> {
  const dir = renderDirOf(o.dataDir, o.series, o.episode, o.lang)
  const blend = path.join(dir, 'scene.blend')
  if (!(await new SeriesStore(o.dataDir).exists(blend))) throw new Error('no assembled scene: cts_scene_assemble first')
  const frame = Math.max(0, Math.round(o.t * 24))
  const out = o.out ?? path.join(dir, `still-${String(frame).padStart(5, '0')}.png`)
  const runner = o.runner ?? (await blenderRunnerFor(o.dataDir))
  await runner.run('still', { blend, frame, out, width: o.width ?? 960, height: o.height ?? 540, samples: o.samples ?? 4 }, { signal: o.signal })
  return { file: out, frame }
}

export const buildCharacter = (o: BuildOptions): Promise<BuildResult> => runBuild('character', o)
export const buildSet = (o: BuildOptions): Promise<BuildResult> => runBuild('set', o)

/** The request is the JSON at the top of the job body (the scheduler's log lines may follow it after a restart). */
function requestOf(body: string): Record<string, unknown> {
  const text = body.trim()
  if (!text) return {}
  const end = text.indexOf('\n}')
  return JSON.parse(end >= 0 ? text.slice(0, end + 2) : text) as Record<string, unknown>
}

/** The next free job id of `<series>--<task>--<unit>--r<n>`. */
export async function enqueueBlenderJob(svc: CtsService, o: { series: string; task: 'character_build' | 'set_build' | 'scene_assemble'; role: string; unit: string; label: string; body: unknown }): Promise<string> {
  for (let run = 1; run <= 999; run++) {
    const id = `${o.series}--${o.task}--${o.unit}--r${run}`
    if (await svc.deps.jobs.enqueue({ id, task: o.task, role: o.role, book: o.series, unit: o.unit, round: run, requested_by: 'you', label: o.label }, JSON.stringify(o.body, null, 2))) {
      svc.deps.kick?.()
      return id
    }
  }
  throw new Error('too many jobs for this unit')
}

/** The job handlers (`ENGINE_MODULES`). */
export function registerBlender(engine: Engine): void {
  const svc = engine.cts
  for (const [task, kind] of [['character_build', 'character'], ['set_build', 'set']] as const) {
    engine.queue.register(
      task,
      async (ctx) => {
        const series = ctx.job.book
        if (!series) throw new Error(`a ${task} job needs a series`)
        const req = requestOf(ctx.jobBody)
        const id = String(req.id)
        const r = await runBuild(kind, {
          dataDir: svc.dataDir,
          series,
          id,
          sheet: req.sheet !== false,
          signal: ctx.signal,
          onLog: (l) => ctx.log(l),
          onProgress: (fraction, message) => svc.emit({ type: 'job.progress', jobId: ctx.job.id, series, task, unit: id, fraction, ...(message ? { message } : {}) })
        })
        if (r.ok) for (const w of r.warnings) ctx.log(`warning: ${w}`)
        return { result: JSON.stringify(r) }
      },
      { noModel: true }
    )
  }
  engine.queue.register(
    'scene_assemble',
    async (ctx) => {
      const series = ctx.job.book
      if (!series) throw new Error('a scene_assemble job needs a series')
      const req = requestOf(ctx.jobBody)
      const episode = String(req.episode)
      const lang = String(req.lang) as Lang
      const r = await assembleScene({
        dataDir: svc.dataDir,
        series,
        episode,
        lang,
        signal: ctx.signal,
        onLog: (l) => ctx.log(l),
        onProgress: (fraction, message) => svc.emit({ type: 'job.progress', jobId: ctx.job.id, series, task: 'scene_assemble', unit: `${episode}-${lang}`, fraction, ...(message ? { message } : {}) })
      })
      if (r.ok) for (const w of r.warnings) ctx.log(`warning: ${w}`)
      return { result: JSON.stringify(r) }
    },
    { noModel: true }
  )
}

export async function readBuildInfo(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}
