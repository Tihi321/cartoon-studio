import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pitchSchema } from '../../shared/contracts'
import type { Bible, PipelineState } from '../../shared/contracts'
import type { SeriesRunState } from '../../shared/protocol'
import { localIso } from '../budget/spend'
import { readSheetMeta } from '../images/reference'
import type { JobState } from '../queue/jobs'
import { assertId, assertSlug } from '../series/paths'
import { SeriesStore } from '../series/service'
import type { CtsService } from '../service'
import { sha1 } from '../blender/jobs'
import { clipsGate } from './clips'
import { emptyState, normalise, rendererOfState, resetFrom, stepDef, stepsOf, taskOf } from './steps'
import type { StepDef } from './steps'

/**
 * The pipeline runner (CTS-07). `cts_run_pipeline { series, episode, brief?, retry?, from? }` calls `run`; calling it again with the same ids resumes
 * (Edu's `edu_run_pipeline` pattern): the state is read from `episodes/<ep>/pipeline.json` and the job store, never from memory, so `advance` can run
 * after every step, from a tool call, and after a restart.
 *
 * The pause after the pitches is a gate: step `pitch_choice` is done only when `bible.chosenPitch` names one of `bible.pitches`, which only
 * `pitchChoose` (`cts_pitch_choose`) writes. Nothing past it is enqueued before, whatever `from` or `retry` say, and every visual handler checks it again.
 */

export interface RunOptions {
  series: string
  episode: string
  brief?: Record<string, unknown>
  /** Choices of the run (rigPaths, rigChoice, skipClips, clipCredits ...); merged into the stored ones. */
  options?: Record<string, unknown>
  retry?: boolean
  from?: string
}

export interface StepView {
  id: string
  no: string
  label: string
  role: string
  kind: string
  state: string
  detail?: string
  error?: string
  job?: string
  startedAt?: string
  endedAt?: string
}

export interface PipelineReport {
  series: string
  episode: string
  state: PipelineState['state']
  /** The step that runs, waits or failed (null: all done). */
  step: string | null
  waitingOn?: string
  hint: string
  steps: StepView[]
  chosenPitch: string | null
  chosenAt?: string
  pitches?: { id: string; title: { hr: string; en: string }; logline: { hr: string; en: string }; leads: { name: string; what: string }[]; sets: string[]; why: string }[]
  brief?: Record<string, unknown>
  options?: Record<string, unknown>
  summary?: Record<string, unknown>
}

/** sha1 of the bytes of `cast/<id>/character.json` (what a 3D sheet approval is of), or null without a spec. */
export async function specHashOf(store: SeriesStore, series: string, castId: string): Promise<string | null> {
  try {
    return sha1(await fs.readFile(store.paths(series).characterFile(castId)))
  } catch {
    return null
  }
}

/** CTS-37: the user's verdict on the voice cast of a series (`cts_voice_approve`), and the notes for the next casting round. */
export const VOICE_REVIEW_FILE = 'voice-review.json'
export const VOICE_REDO_FILE = 'voice-redo.json'

/** sha1 of every cast member's voice record: an approval is of these voices; a changed voice (a recast, `cts_series_update`) needs the user's ear again. */
export const voicesHashOf = (bible: Pick<Bible, 'cast'>): string => sha1(JSON.stringify(bible.cast.map((c) => [c.id, c.voice])))

async function readJsonFile(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

const locks = new Map<string, Promise<unknown>>()
/** One promise chain per episode: a handler ending and a tool call cannot advance the same pipeline at once. */
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(fn, fn)
  locks.set(key, next.catch(() => undefined))
  return next
}

const OPTION_KEY = 'options'

/** The pipeline `options` are stored in the state's `brief` under one key, so the state file keeps its shape. */
export function optionsOf(state: PipelineState): Record<string, unknown> {
  const o = state.brief?.[OPTION_KEY]
  return o && typeof o === 'object' ? (o as Record<string, unknown>) : {}
}
export function briefOf(state: PipelineState): Record<string, unknown> {
  const { [OPTION_KEY]: _o, ...rest } = state.brief ?? {}
  return rest
}

export class Pipeline {
  constructor(readonly svc: CtsService) {}

  get store(): SeriesStore {
    return new SeriesStore(this.svc.dataDir)
  }

  private now(): string {
    return localIso(new Date())
  }

  async read(series: string, episode: string): Promise<PipelineState | null> {
    const s = await this.store.readPipeline(series, episode)
    return s ? normalise(s) : null
  }

  private async save(state: PipelineState, step: string | null): Promise<PipelineState> {
    const before = await this.store.readPipeline(state.series, state.episode).catch(() => null)
    state.updatedAt = this.now()
    const saved = await this.store.writePipeline(state.series, state.episode, state)
    if (!before || before.state !== saved.state || before.waitingOn !== saved.waitingOn) {
      this.svc.emit({ type: 'series.state', series: saved.series, episode: saved.episode, state: saved.state as SeriesRunState, ...(step ? { step } : {}) })
    }
    return saved
  }

  /** Creates the series when it does not exist, stores the brief and options, applies `from` / `retry`, then advances. */
  async run(o: RunOptions): Promise<PipelineReport> {
    assertSlug(o.series)
    assertId(o.episode, 'episode id')
    return withLock(`${o.series}/${o.episode}`, async () => {
      const store = this.store
      if (!(await store.seriesExists(o.series))) {
        const b = o.brief ?? {}
        const pitchTitle = (b.pitch as { title?: { en?: unknown } } | undefined)?.title?.en
        const title = typeof b.title === 'string' && b.title ? b.title : typeof pitchTitle === 'string' && pitchTitle ? pitchTitle : o.series
        await store.createSeries(o.series, { title, ...(typeof b.idea === 'string' ? { logline: b.idea } : {}), ...(typeof b.ageMin === 'number' ? { ageMin: b.ageMin } : {}), ...(typeof b.ageMax === 'number' ? { ageMax: b.ageMax } : {}), renderer: o.options?.renderer === 'canvas' ? 'canvas' : 'blender' })
      }
      // HUB-30: the renderer decides the step list. A new run takes `options.renderer`, else the bible's (an existing series keeps its own); a new series is `blender`.
      const wanted = o.options?.renderer
      if (wanted !== undefined && wanted !== 'canvas' && wanted !== 'blender') throw new Error(`options.renderer must be "canvas" or "blender", not ${JSON.stringify(wanted)}`)
      const existing = await this.read(o.series, o.episode)
      if (existing && wanted && wanted !== rendererOfState(existing)) throw new Error(`this episode already runs with the ${rendererOfState(existing)} renderer; the renderer of a run cannot change (use a new episode id)`)
      const renderer = existing ? rendererOfState(existing) : ((wanted as 'canvas' | 'blender' | undefined) ?? (await store.readBible(o.series)).renderer)
      if (renderer === 'blender') {
        const bible = await store.readBible(o.series)
        if (bible.renderer !== 'blender' && (bible.cast.length > 0 || bible.episodes.length > 0)) throw new Error(`series "${o.series}" is a canvas series with a cast or episodes; the 3D route is a new series (cts_run_pipeline with options.renderer "blender" and another slug)`)
        if (bible.renderer !== 'blender') await store.writeBible(o.series, { ...bible, renderer: 'blender', style3d: bible.style3d ?? 'style3d.json' })
      }
      const state = existing ?? emptyState(o.series, o.episode, this.now(), renderer)
      if (o.brief || o.options) {
        state.brief = { ...briefOf(state), ...(o.brief ?? {}), [OPTION_KEY]: { ...optionsOf(state), ...(o.options ?? {}) } }
      }
      if (!state.brief || Object.keys(briefOf(state)).length === 0) {
        if (!state.steps.pitch || state.steps.pitch.state !== 'done') throw new Error('the first call needs a brief: {idea, ageMin?, ageMax?, notes?} (what the series is about)')
      }
      // CTS-45: the earliest step this call puts back; the queued or stopped jobs of it and of every later step are dropped below
      let redoAt: string | null = o.from ?? null
      if (o.from) {
        resetFrom(state, o.from)
        if (o.from === 'pitch') {
          const bible = await store.readBible(o.series)
          await store.writeBible(o.series, { ...bible, pitches: [], chosenPitch: null, chosenAt: undefined })
        }
      }
      if (o.retry) {
        redoAt ??= stepsOf(state).find((s) => state.steps[s.id]?.state === 'failed')?.id ?? null
        for (const [id, st] of Object.entries(state.steps)) if (st.state === 'failed') Object.assign(st, { state: 'pending', error: undefined, detail: 'retry', ...(id === 'safety' ? { attempts: 0 } : {}) })
        if (state.state === 'failed') state.state = 'idle'
      }
      // CTS-17: a given pitch (brief.pitch, the user's pick made earlier) is the chosen premise: no pitch step, no pause
      const given = state.brief?.pitch
      if (given !== undefined && o.from !== 'pitch') {
        const pitch = pitchSchema.parse({ id: 'p1', ...(given as object) })
        const bible = await store.readBible(o.series)
        if (bible.chosenPitch !== pitch.id || !bible.pitches.some((p) => p.id === pitch.id)) {
          await store.writeBible(o.series, { ...bible, pitches: [pitch], chosenPitch: pitch.id, chosenAt: this.now() })
        }
        for (const id of ['pitch', 'pitch_choice']) {
          if (state.steps[id]?.state !== 'done') state.steps[id] = { state: 'done', endedAt: this.now(), detail: `given pitch ${pitch.id}` }
        }
      }
      if (redoAt) await this.dropQueuedFrom(state, redoAt)
      state.run = (state.run ?? 0) + 1
      await this.save(state, null)
      return this.advanceLocked(o.series, o.episode)
    })
  }

  /**
   * CTS-45: a step put back (`from`, `retry`) makes a fresh job. A job of that step or of a later one that still sits in the queue (queued, or stopped
   * by `cts_stop_now`, which puts it back there) would run on resume with the old inputs, and its handler would mark the step done with a stale result.
   * It is removed. A job that is running right now is not touched (stop it first).
   */
  private async dropQueuedFrom(state: PipelineState, stepId: string): Promise<string[]> {
    const steps = stepsOf(state)
    const tasks = new Set(steps.slice(steps.findIndex((s) => s.id === stepId)).map(taskOf))
    const jobs = this.svc.deps.jobs
    const dropped: string[] = []
    for (const j of await jobs.list('queued')) {
      if (j.data.book !== state.series || j.data.unit !== state.episode || !tasks.has(j.data.task)) continue
      await fs.rm(jobs.file('queued', j.id), { force: true })
      dropped.push(j.id)
    }
    if (dropped.length) this.svc.log(`pipeline ${state.series}/${state.episode}: dropped the queued job(s) of the steps from ${stepId} on: ${dropped.join(', ')}`)
    return dropped
  }

  /** Looks at the state and the job store and moves one step on. Safe to call at any time. */
  advance(series: string, episode: string): Promise<PipelineReport> {
    return withLock(`${series}/${episode}`, () => this.advanceLocked(series, episode))
  }

  /** `advance` that never throws: a handler's own work is done, a later call can advance again. */
  async advanceQuietly(series: string, episode: string): Promise<void> {
    try {
      await this.advance(series, episode)
    } catch (e) {
      this.svc.log(`pipeline ${series}/${episode}: could not advance: ${(e as Error).message}`)
    }
  }

  private async advanceLocked(series: string, episode: string): Promise<PipelineReport> {
    const state = await this.read(series, episode)
    if (!state) throw new Error(`the episode "${episode}" of "${series}" has no pipeline run (cts_run_pipeline starts one)`)
    const jobs = this.svc.deps.jobs
    const queue = this.svc.deps.registry.clientQueue
    outer: for (let guard = 0; guard < stepsOf(state).length * 3; guard++) {
      for (const step of stepsOf(state)) {
        const st = state.steps[step.id]!
        if (st.state === 'done' || st.state === 'skipped') continue
        if (st.state === 'failed') {
          state.state = 'failed'
          delete state.waitingOn
          return this.report(await this.save(state, step.id), step.id)
        }
        if (st.state === 'running' && st.job) {
          const j = await jobs.find(st.job)
          const js: JobState | 'missing' = j?.state ?? 'missing'
          if (js === 'queued' || js === 'running') {
            state.state = queue.countFor((id) => id === st.job) > 0 ? 'waiting-on-client' : 'running'
            delete state.waitingOn
            return this.report(await this.save(state, step.id), step.id)
          }
          if (js === 'failed') {
            st.state = 'failed'
            st.error = String((j?.data as Record<string, unknown> | undefined)?.failure ?? 'the job failed')
            st.endedAt = this.now()
            continue outer
          }
          if (js === 'done') {
            // the handler ends by marking its own step; a done job that did not means a crash between the two: the step ran
            st.state = 'done'
            st.endedAt = this.now()
            continue outer
          }
          st.state = 'pending' // the job is gone (a crash): ask again
        }
        // pending
        const reason = await this.gate(state, step)
        if (reason === 'redo-pitch') {
          st.state = 'pending'
          state.steps.pitch = { state: 'pending', detail: 'redo' }
          continue outer
        }
        // CTS-37/39: a note waits for the step before the gate (the user asked for a redo): that step runs again, once, with every note
        if (reason === 'redo-character' || reason === 'redo-voice_cast') {
          const target = reason.slice('redo-'.length)
          state.steps[target] = { state: 'pending', detail: `revise (the user's note)`, ...(state.steps[target]?.attempts ? { attempts: state.steps[target]!.attempts } : {}) }
          continue outer
        }
        if (reason) {
          state.state = 'waiting-on-user'
          state.waitingOn = reason
          return this.report(await this.save(state, step.id), step.id)
        }
        if (step.kind === 'gate') {
          st.state = 'done'
          st.endedAt = this.now()
          st.detail = step.id === 'pitch_choice' ? 'chosen' : 'approved'
          continue outer
        }
        const id = await this.enqueue(state, step)
        Object.assign(st, { state: 'running', job: id, startedAt: this.now(), endedAt: undefined, error: undefined, attempts: (st.attempts ?? 0) + 1 })
        state.state = 'running'
        delete state.waitingOn
        return this.report(await this.save(state, step.id), step.id)
      }
      state.state = 'done'
      delete state.waitingOn
      return this.report(await this.save(state, null), null)
    }
    throw new Error('the pipeline did not settle (a bug): see pipeline.json')
  }

  /** Why a step cannot start yet (the user must act), or null. */
  private async gate(state: PipelineState, step: StepDef): Promise<string | null> {
    const store = this.store
    if (step.id === 'pitch_choice') {
      const bible = await store.readBible(state.series)
      if (bible.pitches.length === 0) return 'redo-pitch'
      if (bible.chosenPitch && bible.pitches.some((p) => p.id === bible.chosenPitch)) return null
      return `waiting for the user to choose one of the ${bible.pitches.length} premises: show them (cts_series_get {series}), then cts_pitch_choose {series, pitch}. Nothing visual is made before that.`
    }
    if (step.id === 'sheet_review') {
      const bible = await store.readBible(state.series)
      if (rendererOfState(state) === 'blender') {
        // CTS-39: a redo note that no character job took yet (it came in while the last one ended) makes the character step run again
        for (const c of bible.cast) if (await store.exists(path.join(store.paths(state.series).castDir(c.id), 'sheet-redo.json'))) return 'redo-character'
        // a 3D sheet is approved for one spec: a spec that changed since (specHash) needs the user's look again
        const open: string[] = []
        for (const c of bible.cast) {
          const hash = await specHashOf(store, state.series, c.id)
          if (!c.sheet?.approvedAt || !hash || c.sheet.specHash !== hash) open.push(c.id)
        }
        if (open.length === 0) return null
        return `waiting for the user to look at the character sheet of ${open.join(', ')} (cast/<id>/sheet.png: turnaround, expressions, mouths) and approve it: cts_sheet_approve {series, cast, ok: true}, or ok: false with a note to build it again. The sets, the script and everything after are not made before every character is approved.`
      }
      const open = bible.cast.filter((c) => !c.sheet?.approvedAt).map((c) => c.id)
      if (open.length === 0) return null
      return `waiting for the user to look at the character sheet of ${open.join(', ')} (cast/<id>/sheet.png) and approve it: cts_sheet_approve {series, cast, ok: true}, or ok: false with a note to make it again. Nothing is rigged before every character is approved.`
    }
    if (step.id === 'voice_review') {
      const root = store.paths(state.series).root
      if (await store.exists(path.join(root, VOICE_REDO_FILE))) return 'redo-voice_cast'
      const bible = await store.readBible(state.series)
      const review = await readJsonFile(path.join(root, VOICE_REVIEW_FILE))
      if (review?.ok === true && review.voicesHash === voicesHashOf(bible)) return null
      return `waiting for the user to listen to the voice cast of ${bible.cast.map((c) => c.id).join(', ')} (the auditions in cast/<id>/voice/: audition-<lang>-<voiceId>.wav from ElevenLabs, else <lang>.wav; the voices are in the bible) and approve it: cts_voice_approve {series, ok: true}, or ok: false with a note to cast again. To try other ElevenLabs voices first: cts_voice_audition, cts_series_update with the chosen voice ids, then cts_voice_approve. No line is spoken before the approval.`
    }
    if (step.id === 'clips') return clipsGate(store, state.series, state.episode, optionsOf(state))
    return null
  }

  private async enqueue(state: PipelineState, step: StepDef): Promise<string> {
    // belt and braces: nothing visual before the user's pick, whatever called us
    const idx = stepsOf(state).findIndex((s) => s.id === step.id)
    if (idx > stepsOf(state).findIndex((s) => s.id === 'pitch_choice')) {
      const bible = await this.store.readBible(state.series)
      if (!bible.chosenPitch || !bible.pitches.some((p) => p.id === bible.chosenPitch)) throw new Error('refusing to start a step before the user has chosen a premise (cts_pitch_choose)')
    }
    const task = taskOf(step)
    for (let run = 1; run <= 999; run++) {
      const id = `${state.series}--${task}--${state.episode}--r${run}`
      const body = JSON.stringify({ episode: state.episode, step: step.id }, null, 2)
      if (await this.svc.deps.jobs.enqueue({ id, task, role: step.role, book: state.series, unit: state.episode, round: run, requested_by: 'engine', label: step.label, ...(step.vision ? { vision: true } : {}) }, body)) {
        this.svc.deps.kick?.()
        return id
      }
    }
    throw new Error(`too many jobs for step ${step.id}`)
  }

  // ---- what handlers report ----

  /**
   * CTS-50: with `job` (a handler reporting its own result) the report counts only while the step still belongs to that job; a `from` / `retry`
   * run that reset the step (and maybe made a new job) while the old job was running makes the old result stale, and it is dropped with a log line.
   */
  private async staleReport(state: PipelineState, step: string, job: string | undefined, what: string): Promise<boolean> {
    if (job === undefined || state.steps[step]?.job === job) return false
    this.svc.log(`pipeline ${state.series}/${state.episode}: dropped the ${what} of job ${job} for ${step}: the step was reset since (now ${state.steps[step]?.state ?? 'unknown'}${state.steps[step]?.job ? `, job ${state.steps[step]!.job}` : ''})`)
    return true
  }

  async markDone(series: string, episode: string, step: string, detail: string, job?: string): Promise<void> {
    await withLock(`${series}/${episode}`, async () => {
      const state = await this.read(series, episode)
      if (!state) return
      if (await this.staleReport(state, step, job, 'result')) return
      state.steps[step] = { ...state.steps[step], state: 'done', endedAt: this.now(), detail: detail.slice(0, 400), error: undefined }
      await this.save(state, step)
    })
  }

  /** A step goes back to pending (a revise round): `detail` says why; the next `advance` makes a new job. */
  async reopen(series: string, episode: string, steps: string[], detail: string): Promise<void> {
    await withLock(`${series}/${episode}`, async () => {
      const state = await this.read(series, episode)
      if (!state) return
      for (const id of steps) state.steps[id] = { state: 'pending', detail, attempts: state.steps[id]?.attempts }
      await this.save(state, steps[0] ?? null)
    })
  }

  async noteFailure(series: string, episode: string, step: string, error: string, job?: string): Promise<void> {
    await withLock(`${series}/${episode}`, async () => {
      const state = await this.read(series, episode)
      if (!state) return
      if (await this.staleReport(state, step, job, 'failure')) return
      state.steps[step] = { ...state.steps[step]!, error: error.slice(0, 600) }
      await this.save(state, step)
    })
  }

  async setSummary(series: string, episode: string, summary: Record<string, unknown>): Promise<void> {
    await withLock(`${series}/${episode}`, async () => {
      const state = await this.read(series, episode)
      if (!state) return
      state.summary = summary
      await this.save(state, null)
    })
  }

  // ---- the user's pick ----

  async choosePitch(series: string, pitch: string): Promise<{ chosenPitch: string; chosenAt: string; resumed: PipelineReport[] }> {
    assertSlug(series)
    const store = this.store
    const bible = await store.readBible(series)
    if (!bible.pitches.some((p) => p.id === pitch)) throw new Error(`no pitch "${pitch}" in "${series}" (${bible.pitches.map((p) => p.id).join(', ') || 'none yet: run the pipeline first'})`)
    const chosenAt = this.now()
    await store.writeBible(series, { ...bible, chosenPitch: pitch, chosenAt })
    this.svc.emit({ type: 'pitch.chosen', series, pitch })
    const resumed: PipelineReport[] = []
    for (const ep of await this.episodesWithPipeline(series)) {
      const st = await this.read(series, ep)
      if (st && st.state === 'waiting-on-user' && st.steps.pitch_choice?.state !== 'done') resumed.push(await this.advance(series, ep))
    }
    return { chosenPitch: pitch, chosenAt, resumed }
  }

  /**
   * The user's verdict on one character sheet. `ok`: the bible's cast entry gets `sheet { approvedAt, seed, denoise, model }` (from the sheet's own record) and
   * every pipeline that waits at `sheet_review` goes on once the last character is approved. Not `ok`: the sheet is made again with the note added to the
   * prompt (`cast_sheet` and `sheet_review` are reopened; a new seed range is used), and the approval of that character is withdrawn.
   */
  async approveSheet(series: string, castId: string, ok: boolean, note?: string): Promise<{ cast: string; ok: boolean; approvedAt?: string; sheet?: NonNullable<Bible['cast'][number]['sheet']>; stillOpen: string[]; resumed: PipelineReport[]; joined?: string[]; warning?: string }> {
    assertSlug(series)
    const store = this.store
    const bible = await store.readBible(series)
    const member = bible.cast.find((c) => c.id === castId)
    if (!member) throw new Error(`no cast member "${castId}" in "${series}" (${bible.cast.map((c) => c.id).join(', ') || 'none yet'})`)
    const castDir = store.paths(series).castDir(castId)
    if (bible.renderer === 'blender') return this.approveSheet3d(series, bible, castId, ok, note)
    const meta = await readSheetMeta(castDir)
    if (!meta || !(await store.exists(path.join(castDir, 'sheet.png')))) throw new Error(`"${castId}" has no character sheet yet (cast/${castId}/sheet.png): the cast_sheet step makes it`)
    if (!ok && !note?.trim()) throw new Error('a redo needs a note: say what to change (the note is added to the image prompt)')
    const at = this.now()
    await store.writeFile(series, 'sheet/review.json', `${JSON.stringify({ ok, note: note ?? null, at, seed: meta.seed, attempt: meta.attempt }, null, 2)}\n`, castDir)
    const resumed: PipelineReport[] = []
    if (!ok) {
      await store.writeFile(series, 'sheet-redo.json', `${JSON.stringify({ note: note!.trim(), at, attempt: meta.attempt + 1 }, null, 2)}\n`, castDir)
      await store.writeBible(series, { ...bible, cast: bible.cast.map((c) => (c.id === castId ? { ...c, sheet: undefined } : c)) })
      let past = false
      for (const ep of await this.episodesWithPipeline(series)) {
        const st = await this.read(series, ep)
        if (!st) continue
        if (st.steps.rig?.state !== 'pending') past = true
        await this.reopen(series, ep, ['cast_sheet', 'sheet_review'], `revise sheet ${castId}`)
        resumed.push(await this.advance(series, ep))
      }
      return { cast: castId, ok, stillOpen: bible.cast.map((c) => c.id), resumed, ...(past ? { warning: 'the rig step had already started: run cts_run_pipeline {from: "rig"} after the new sheet is approved' } : {}) }
    }
    const sheet = { approvedAt: at, seed: meta.seed, denoise: meta.denoise, model: meta.model }
    await store.writeBible(series, { ...bible, cast: bible.cast.map((c) => (c.id === castId ? { ...c, sheet } : c)) })
    const fresh = await store.readBible(series)
    const stillOpen = fresh.cast.filter((c) => !c.sheet?.approvedAt).map((c) => c.id)
    for (const ep of await this.episodesWithPipeline(series)) {
      const st = await this.read(series, ep)
      if (st && st.state === 'waiting-on-user' && st.steps.sheet_review?.state !== 'done') resumed.push(await this.advance(series, ep))
    }
    return { cast: castId, ok, approvedAt: at, sheet, stillOpen, resumed }
  }

  /**
   * The user's verdict on a 3D character sheet (CTS-27). `ok`: the sheet must be of the current spec (the build is not stale); the cast entry gets
   * `sheet { approvedAt, specHash }` and the pipelines that wait at `sheet_review` go on once the last character is approved. Not `ok`: `sheet-redo.json`
   * keeps the note for the designer, the approval is withdrawn and `character` + `sheet_review` are reopened (only this character is designed again).
   */
  private async approveSheet3d(series: string, bible: Bible, castId: string, ok: boolean, note?: string): ReturnType<Pipeline['approveSheet']> {
    const store = this.store
    const castDir = store.paths(series).castDir(castId)
    const specHash = await specHashOf(store, series, castId)
    if (!specHash) throw new Error(`"${castId}" has no character spec yet (cast/${castId}/character.json): the character step makes it`)
    const build = await readJsonFile(path.join(castDir, 'build.json'))
    if (!(await store.exists(path.join(castDir, 'sheet.png'))) || !build) throw new Error(`"${castId}" has no built sheet yet (cast/${castId}/sheet.png): the character step builds it`)
    if (ok && build.specHash !== specHash) throw new Error(`the sheet of "${castId}" is of an older spec (the spec changed after the last build): cts_character_build {series, cast} first, then look at the new sheet`)
    if (!ok && !note?.trim()) throw new Error('a redo needs a note: say what to change (the designer gets the note)')
    const at = this.now()
    await store.writeFile(series, 'sheet/review.json', `${JSON.stringify({ ok, note: note ?? null, at, specHash }, null, 2)}\n`, castDir)
    const resumed: PipelineReport[] = []
    if (!ok) {
      await store.writeFile(series, 'sheet-redo.json', `${JSON.stringify({ note: note!.trim(), at, specHash }, null, 2)}\n`, castDir)
      await store.writeBible(series, { ...bible, cast: bible.cast.map((c) => (c.id === castId ? { ...c, sheet: undefined } : c)) })
      let past = false
      const joined: string[] = []
      for (const ep of await this.episodesWithPipeline(series)) {
        const st = await this.read(series, ep)
        if (!st) continue
        const steps = stepsOf(st).map((s) => s.id)
        if (steps.slice(steps.indexOf('sheet_review') + 1).some((id) => st.steps[id]?.state !== 'pending')) past = true
        // CTS-39: one character job per pipeline. While one is queued or running it takes this note too (it looks for redo notes until none is left)
        if (await this.liveJob(st, 'character')) joined.push(ep)
        else await this.reopen(series, ep, ['character', 'sheet_review'], `revise sheet ${castId}`)
        resumed.push(await this.advance(series, ep))
      }
      return { cast: castId, ok, stillOpen: bible.cast.map((c) => c.id), resumed, ...(joined.length ? { joined } : {}), ...(past ? { warning: 'steps after the sheets had already started: run cts_run_pipeline {from: "set3d"} (or "assemble" when only the look changed) after the new sheet is approved' } : {}) }
    }
    const sheet = { approvedAt: at, specHash }
    await store.writeBible(series, { ...bible, cast: bible.cast.map((c) => (c.id === castId ? { ...c, sheet } : c)) })
    const fresh = await store.readBible(series)
    const stillOpen: string[] = []
    for (const c of fresh.cast) if (!c.sheet?.approvedAt || c.sheet.specHash !== (await specHashOf(store, series, c.id))) stillOpen.push(c.id)
    for (const ep of await this.episodesWithPipeline(series)) {
      const st = await this.read(series, ep)
      if (st && st.state === 'waiting-on-user' && st.steps.sheet_review?.state !== 'done') resumed.push(await this.advance(series, ep))
    }
    return { cast: castId, ok, approvedAt: at, sheet, stillOpen, resumed }
  }

  /**
   * CTS-37: the user's verdict on the voice cast of a Blender series (every character's voice in every language, heard through the auditions). `ok`:
   * `voice-review.json` records the hash of the voices and every pipeline that waits at `voice_review` goes on (a voice changed later needs a new
   * approval). Not `ok`: the note is added to `voice-redo.json` and the waiting pipelines cast again (`voice_cast` runs with the notes, then waits here).
   */
  async approveVoices(series: string, ok: boolean, note?: string): Promise<{ ok: boolean; at: string; voicesHash: string; voices: Record<string, unknown>; resumed: PipelineReport[]; warning?: string }> {
    assertSlug(series)
    const store = this.store
    const bible = await store.readBible(series)
    if (bible.renderer !== 'blender') throw new Error(`"${series}" is a canvas series: the voice review is a step of the 3D route`)
    if (bible.cast.length === 0) throw new Error(`"${series}" has no cast yet`)
    if (!ok && !note?.trim()) throw new Error('a redo needs a note: say what to change in which voice (the voice director gets the note)')
    const at = this.now()
    const voicesHash = voicesHashOf(bible)
    await store.writeFile(series, VOICE_REVIEW_FILE, `${JSON.stringify({ ok, note: note?.trim() || null, at, voicesHash }, null, 2)}\n`)
    if (!ok) {
      // notes add up until a casting round takes them
      const prev = await readJsonFile(path.join(store.paths(series).root, VOICE_REDO_FILE))
      const notes = [...(Array.isArray(prev?.notes) ? (prev.notes as unknown[]).filter((x): x is string => typeof x === 'string') : []), note!.trim()]
      await store.writeFile(series, VOICE_REDO_FILE, `${JSON.stringify({ notes, at }, null, 2)}\n`)
    }
    const resumed: PipelineReport[] = []
    const passed: string[] = []
    for (const ep of await this.episodesWithPipeline(series)) {
      const st = await this.read(series, ep)
      if (!st || rendererOfState(st) !== 'blender') continue
      if (st.steps.voice_review?.state === 'done') passed.push(ep)
      else if (st.state === 'waiting-on-user' || !ok) resumed.push(await this.advance(series, ep))
    }
    const voices = Object.fromEntries(bible.cast.map((c) => [c.id, Object.fromEntries(Object.entries(c.voice).map(([lang, v]) => [lang, (v as { elevenlabs?: unknown; vibetts?: string } | undefined)?.elevenlabs ?? (v as { vibetts?: string } | undefined)?.vibetts ?? null]))]))
    return { ok, at, voicesHash, voices, resumed, ...(!ok && passed.length ? { warning: `${passed.join(', ')} passed the voice review earlier and keep their voices: cts_run_pipeline {series, episode, from: "voice_cast"} casts one again` } : {}) }
  }

  /** The step runs a job that is still queued or running. */
  private async liveJob(state: PipelineState, stepId: string): Promise<boolean> {
    const st = state.steps[stepId]
    if (st?.state !== 'running' || !st.job) return false
    const j = await this.svc.deps.jobs.find(st.job)
    return j?.state === 'queued' || j?.state === 'running'
  }

  async episodesWithPipeline(series: string): Promise<string[]> {
    const dir = this.store.paths(series).episodesDir
    const names = await fs.readdir(dir).catch(() => [] as string[])
    const out: string[] = []
    for (const n of names) if (await this.store.exists(path.join(dir, n, 'pipeline.json'))) out.push(n)
    return out.sort()
  }

  // ---- reading ----

  /** The report of an episode: steps, the state, the premises while they wait, and a hint on what to do next. */
  async status(series: string, episode: string): Promise<PipelineReport | null> {
    const state = await this.read(series, episode)
    if (!state) return null
    // a run that is going looks at its jobs again (a job that failed for good, a step that finished): advance is safe to call at any time
    if (state.state === 'running' || state.state === 'waiting-on-client') return this.advance(series, episode)
    const cur = stepsOf(state).find((s) => !['done', 'skipped'].includes(state.steps[s.id]!.state))
    return this.report(state, cur?.id ?? null)
  }

  private async report(state: PipelineState, step: string | null): Promise<PipelineReport> {
    const bible = await this.store.readBible(state.series).catch(() => null)
    const views: StepView[] = stepsOf(state).map((s) => {
      const st = state.steps[s.id]!
      return { id: s.id, no: s.no, label: s.label, role: s.role, kind: s.kind, state: st.state, ...(st.detail ? { detail: st.detail } : {}), ...(st.error ? { error: st.error } : {}), ...(st.job ? { job: st.job } : {}), ...(st.startedAt ? { startedAt: st.startedAt } : {}), ...(st.endedAt ? { endedAt: st.endedAt } : {}) }
    })
    const waiting = state.state === 'waiting-on-user'
    const showPitches = bible && bible.pitches.length > 0 && (waiting || !bible.chosenPitch)
    const hint = hintFor(state, step)
    return {
      series: state.series,
      episode: state.episode,
      state: state.state,
      step,
      ...(state.waitingOn ? { waitingOn: state.waitingOn } : {}),
      hint,
      steps: views,
      chosenPitch: bible?.chosenPitch ?? null,
      ...(bible?.chosenAt ? { chosenAt: bible.chosenAt } : {}),
      ...(showPitches && bible ? { pitches: bible.pitches } : {}),
      ...(state.brief ? { brief: briefOf(state), options: optionsOf(state) } : {}),
      ...(state.summary ? { summary: state.summary } : {})
    }
  }
}

function hintFor(state: PipelineState, step: string | null): string {
  const s = state.series
  switch (state.state) {
    case 'waiting-on-user':
      return step === 'pitch_choice'
        ? `STOP: the user must choose a premise. Show them the pitches (title, logline, leads, sets, why), wait for their answer, then cts_pitch_choose {series: "${s}", pitch: "<id>"}. Calling cts_run_pipeline again does not skip this.`
        : step === 'sheet_review'
          ? rendererOfState(state) === 'blender'
            ? `STOP: the user must look at the character sheets (cast/<id>/sheet.png: turnaround, expressions, mouths; cts_character_get {series: "${s}", cast: "<id>"} shows one, the Cast view of the studio too). Show every sheet, wait for the answer per character, then cts_sheet_approve {series: "${s}", cast: "<id>", ok: true} or ok: false with a note to build that character again. The sets and everything after are not made before every character is approved.`
            : `STOP: the user must look at the character sheets (cast/<id>/sheet.png: the master and three poses; cts_cast_get shows them). Show every sheet, wait for the answer per character, then cts_sheet_approve {series: "${s}", cast: "<id>", ok: true} or ok: false with a note to make that sheet again. Nothing is rigged before every character is approved.`
          : step === 'voice_review'
            ? `STOP: the user must hear the voice cast: play the auditions (cast/<id>/voice/audition-<lang>-<voiceId>.wav, else <lang>.wav) and say which voice is which character. Other ElevenLabs voices can be tried with cts_voice_audition {series: "${s}", cast, lang, provider: "elevenlabs", voiceIds, episode} and set with cts_series_update. Then cts_voice_approve {series: "${s}", ok: true}, or ok: false with a note to cast again. No line is spoken before.`
            : `Waiting for you or the user: ${state.waitingOn ?? ''}`
    case 'waiting-on-client':
      return `Model calls wait for you: cts_get_task -> answer -> cts_submit_task until none, then cts_wait {series: "${s}"}.`
    case 'running':
      return `Running step ${step}: cts_wait {series: "${s}"} (it returns when a model call waits for you or nothing is left), then cts_run_pipeline {series, episode} to see the state.`
    case 'failed':
      return `Step ${step} failed (see its error). Fix the cause, then cts_run_pipeline {series, episode, retry: true}, or from: "<step>" to redo from a step.`
    case 'done':
      return 'All steps are done: see summary for the files, durations and open problems.'
    default:
      return 'Call cts_run_pipeline to start.'
  }
}

export { resetFrom, stepDef }
