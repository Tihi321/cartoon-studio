import path from 'node:path'
import type { Bible, PipelineState } from '../../shared/contracts'
import type { ImageContext } from '../images/provider'
import type { JobContext } from '../queue/scheduler'
import { SeriesStore } from '../series/service'
import type { CtsService } from '../service'
import type { Pipeline } from './run'
import { optionsOf, briefOf } from './run'
import { runRoleTask, loadStyleGuide } from './tasks'
import type { RoleTask, RoleTaskResult, RunTaskOptions } from './tasks'

/** What a step handler gets (CTS-07): the service, the store, the job, and the run's brief and options. */
export interface Env {
  svc: CtsService
  store: SeriesStore
  pipe: Pipeline
  ctx: JobContext
  series: string
  episode: string
  stepId: string
  /** The step is made again even if its files exist (`from`, or a revise round). */
  redo: boolean
  /** The step's detail when it started (`redo`, `retry`, `revise 1: ...`). */
  detail: string
  brief: Record<string, unknown>
  options: Record<string, unknown>
  state: PipelineState
  log(message: string): void
  /** A `job.progress` event for the studio (0..1, or null). */
  progress(fraction: number | null, message: string): void
}

export function makeEnv(o: { svc: CtsService; pipe: Pipeline; ctx: JobContext; series: string; episode: string; stepId: string; state: PipelineState }): Env {
  const detail = o.state.steps[o.stepId]?.detail ?? ''
  return {
    svc: o.svc,
    store: new SeriesStore(o.svc.dataDir),
    pipe: o.pipe,
    ctx: o.ctx,
    series: o.series,
    episode: o.episode,
    stepId: o.stepId,
    redo: detail === 'redo' || detail.startsWith('revise'),
    detail,
    brief: briefOf(o.state),
    options: optionsOf(o.state),
    state: o.state,
    log: (m) => o.ctx.log(m),
    progress: (fraction, message) => o.svc.emit({ type: 'job.progress', jobId: o.ctx.job.id, series: o.series, task: o.ctx.job.task, unit: o.episode, episode: o.episode, fraction, message })
  }
}

/** A path relative to the series folder, with forward slashes. */
export const relTo = (e: Env, abs: string): string => path.relative(e.store.paths(e.series).root, abs).split(path.sep).join('/')

export const imageCtx = (e: Env, what: string): ImageContext => ({ svc: e.svc, store: e.store, series: e.series, episode: e.episode, what })

/** The pipeline refuses visual work before the user's pick: every step after the gate calls this first. */
export async function requireChosen(e: Env): Promise<Bible> {
  const bible = await e.store.readBible(e.series)
  if (!bible.chosenPitch || !bible.pitches.some((p) => p.id === bible.chosenPitch)) throw new Error('no premise chosen yet: the user picks one with cts_pitch_choose before anything is made')
  return bible
}

export function ask<T = unknown>(e: Env, task: RoleTask, o: RunTaskOptions = {}): Promise<RoleTaskResult<T>> {
  return runRoleTask<T>(e.ctx, e.store, e.series, task, o)
}

export { loadStyleGuide }

/** A short stable number from a string (seeds). */
export function seedOf(s: string): number {
  return [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7) % 1_000_000
}

/** The cast member as the roles see it. */
export function castView(c: Bible['cast'][number]): Record<string, unknown> {
  return { id: c.id, name: c.name, role: c.role, personality: c.personality, look: c.look ?? '', catchphrases: c.catchphrases }
}
