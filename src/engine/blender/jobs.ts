import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Engine } from '../engine'
import type { CtsService } from '../service'
import { SeriesStore } from '../series/service'
import { BlenderError, blenderRunnerFor } from './runner'
import type { BlenderRunner } from './runner'

/**
 * The asset jobs of the Blender backend: building a character (`character.blend`, `sheet.png`, `build.json`) and a set (`set.blend`, `sheet.png`,
 * `build.json`). They are queue jobs (`<series>--character_build--<cast>--r<n>`, `<series>--set_build--<set>--r<n>`; no model) that report
 * `job.progress` from the Blender progress lines.
 *
 * A mistake in the spec that Blender finds (E_FACE_HIDDEN, E_SPEC_INVALID, E_STYLE_INVALID) is the job's result, `{ ok: false, code, message }`, so the
 * designer reads it and fixes the spec; anything else (Blender missing, a crash) fails the job.
 */

/** Errors that say "the spec is wrong", not "Blender is broken". */
const SPEC_CODES = new Set(['E_FACE_HIDDEN', 'E_SPEC_INVALID', 'E_STYLE_INVALID', 'E_SET_INVALID'])

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
  try {
    const r = await runner.run(
      kind === 'character' ? 'build-character' : 'build-set',
      { spec: specFile, outDir, sheet: o.sheet !== false, ...(style ? { style } : {}) },
      { signal: o.signal, onLog: o.onLog, onProgress: (e) => o.onProgress?.(e.total ? e.done / e.total : 0, e.stage) }
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
  }
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
export async function enqueueBlenderJob(svc: CtsService, o: { series: string; task: 'character_build' | 'set_build'; role: string; unit: string; label: string; body: unknown }): Promise<string> {
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
}

export async function readBuildInfo(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}
