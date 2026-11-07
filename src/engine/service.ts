import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { EngineEvent, ServiceCommand, SeriesSummaryView, StudioStatusView } from '../shared/protocol'
import type { SettingsConfig, FactoryConfig } from '../shared/schemas'
import type { AgentStore } from './agents/agents'
import { createComfyClient, lanesOf, loadComfyConfig, queueState } from './comfy/client'
import type { ComfyClient } from './comfy/client'
import type { ModelRegistry } from './models/registry'
import type { ModelRouter } from './models/router'
import type { JobState, JobStore } from './queue/jobs'
import { JOB_STATES } from './queue/jobs'
import type { ChiptuneClient } from './studios/chiptune'
import type { FlowClient } from './studios/flow'
import type { VibeTtsClient } from './studios/vibetts'
import type { ServiceStarter } from './studios/autostart'
import { assertSlug, seriesDir } from './series/paths'
import { chiptuneClientFor, flowClientFor, flowStartHint, loadStudiosConfig, startHint, studioRepo, studioUrl, STUDIO_NAMES, vibettsClientFor, vibettsStartHint } from './studios/config'
import type { StudioId, StudiosConfig } from './studios/config'

/**
 * The service every cartoon feature hangs on: the queries and queue helpers that the MCP tools and the app share, and the generator clients
 * (ComfyUI, Chiptune Studio, flow-music-mcp, VibeTTS). Later tickets add what they own next to it, as modules that take this service:
 * the series store (`series/`), the voice step, the pipeline. A module registers its job handlers with `engine.scheduler.register(task, fn)`
 * (see `Engine.registerModule`) and its MCP tools with `registerToolModule` in `mcp/modules.ts`.
 *
 * Job ids are `<series>--<task>--<unit>--r<run>`; a job's `book` field holds the series slug.
 */

/** What the cartoon modules get from the engine. */
export interface CtsDeps {
  dataDir: string
  log: (message: string) => void
  emit: (e: EngineEvent) => void
  registry: ModelRegistry
  router: ModelRouter
  jobs: JobStore
  getSettings: () => SettingsConfig
  /** `config/factory.md` (pause all, attempts). */
  getFactory: () => FactoryConfig
  /** The agents (a module may ask whether a role has one). */
  agents: Pick<AgentStore, 'list'>
  /** Running jobs follow a changed model list from their next request. */
  changeModel?: () => void
  /** Wakes the scheduler after jobs were enqueued. */
  kick?: () => void
  /** Aborts running jobs of a series in the scheduler and returns how many were aborted. */
  stopBook?: (slug: string, reason?: 'stopped' | 'stop') => number
  /** Generator clients (tests pass fakes). Default: made from `config/*.md`. */
  comfy?: ComfyClient | (() => ComfyClient | Promise<ComfyClient>)
  chiptune?: ChiptuneClient
  flow?: FlowClient
  /** VibeTTS, the local text-to-speech app (tests pass a fake). Default: made from `config/studios.md`. It is never started by Cartoon Studio. */
  vibetts?: VibeTtsClient
  /** The clock and the sleep of the voice step (tests pass a fixed day and an instant sleep: the Gemini quota day and the retry waits). */
  voiceRuntime?: { now?: () => Date; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }
  /** Starts the generator services when a job finds them down (tests pass a fake, or none). */
  starter?: ServiceStarter
}

export interface JobCounts {
  queued: number
  running: number
  done: number
  failed: number
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

// the path helpers live in `series/paths.ts` (the guard that keeps a series inside its folder); re-exported for the callers of this module
export { assertSlug, seriesDir }

const runOf = (id: string): number => {
  const m = /--r(\d+)$/.exec(id)
  return m ? Number(m[1]) : 0
}

export class CtsService {
  private readonly comfyOverride: CtsDeps['comfy']

  constructor(readonly deps: CtsDeps) {
    this.comfyOverride = deps.comfy
  }

  get dataDir(): string {
    return this.deps.dataDir
  }

  log(message: string): void {
    this.deps.log(`cts: ${message}`)
  }

  emit(e: EngineEvent): void {
    this.deps.emit(e)
  }

  /**
   * The model a series sets for a role, or undefined: it goes first in the job's model list. None yet (a series has no per-role models in
   * phase 1); the scheduler asks, so a later ticket can answer from the series' own files.
   */
  seriesModel(_slug: string, _role: string): string | undefined {
    return undefined
  }

  /** Prepares what must be there before the first job runs: the series folder. */
  async warm(): Promise<void> {
    await fs.mkdir(seriesDir(this.dataDir), { recursive: true })
  }

  /** Stops what the service keeps running. */
  dispose(): void {
    // nothing yet
  }

  /** The series in `<data>/series/`: a folder with a `bible.json`. */
  async listSeries(): Promise<SeriesSummaryView[]> {
    const root = seriesDir(this.dataDir)
    const out: SeriesSummaryView[] = []
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      return out
    }
    for (const e of entries) {
      if (!e.isDirectory() || !SLUG_RE.test(e.name)) continue
      const bible = path.join(root, e.name, 'bible.json')
      const st = await fs.stat(bible).catch(() => null)
      if (!st) continue
      let title = e.name
      try {
        const j = JSON.parse(await fs.readFile(bible, 'utf8')) as { title?: { en?: string; hr?: string } | string }
        title = typeof j.title === 'string' ? j.title : (j.title?.en ?? j.title?.hr ?? e.name)
      } catch {
        /* an unreadable bible still lists, by its slug */
      }
      out.push({ slug: e.name, title, updatedAt: st.mtime.toISOString() })
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug))
  }

  async seriesExists(slug: string): Promise<boolean> {
    assertSlug(slug)
    return fs.stat(path.join(seriesDir(this.dataDir), slug)).then((s) => s.isDirectory(), () => false)
  }

  /** Waits until one job is done or failed. Returns early, with `clientTasks`, when it waits for a client to answer one of its model calls. */
  async waitJob(id: string, o: { timeoutMs?: number; pollMs?: number } = {}): Promise<{ state: JobState | 'missing'; timedOut: boolean; clientTasks: number }> {
    const end = o.timeoutMs ? Date.now() + o.timeoutMs : Infinity
    for (;;) {
      const job = await this.deps.jobs.find(id)
      const state = job?.state ?? 'missing'
      if (state === 'done' || state === 'failed' || state === 'missing') return { state, timedOut: false, clientTasks: 0 }
      const clientTasks = state === 'running' ? this.deps.registry.clientQueue.countFor((j) => j === id) : 0
      if (clientTasks > 0) return { state, timedOut: false, clientTasks }
      if (Date.now() > end) return { state, timedOut: true, clientTasks: 0 }
      await new Promise((r) => setTimeout(r, o.pollMs ?? 100))
    }
  }

  async jobCounts(slug: string): Promise<JobCounts> {
    const counts: JobCounts = { queued: 0, running: 0, done: 0, failed: 0 }
    for (const state of JOB_STATES) counts[state] = (await this.deps.jobs.ids(state)).filter((id) => id.startsWith(`${slug}--`)).length
    return counts
  }

  async jobIds(state: JobState, slug: string): Promise<string[]> {
    return (await this.deps.jobs.ids(state)).filter((id) => id.startsWith(`${slug}--`))
  }

  /** Drops the queued jobs of a series (or of every series when `slug` is null). */
  async clearQueue(slug: string | null): Promise<{ dropped: number; series: string[] }> {
    if (slug) assertSlug(slug)
    const ids = (await this.deps.jobs.ids('queued')).filter((id) => !slug || id.startsWith(`${slug}--`))
    for (const id of ids) await fs.rm(this.deps.jobs.file('queued', id), { force: true })
    const series = [...new Set(ids.map((id) => id.split('--')[0] ?? ''))].filter(Boolean)
    return { dropped: ids.length, series }
  }

  /** The jobs of a series: how many per state, what runs, what failed. */
  async status(slug: string): Promise<{ jobs: JobCounts; running: { id: string; task: string; unit: string | null }[]; failed: { id: string; failure: string }[] }> {
    if (!(await this.seriesExists(slug))) throw new Error(`no series "${slug}"`)
    const running = (await this.deps.jobs.list('running')).filter((j) => j.data.book === slug).map((j) => ({ id: j.id, task: j.data.task, unit: j.data.unit }))
    const failed = (await this.deps.jobs.list('failed'))
      .filter((j) => j.data.book === slug)
      .map((j) => ({ id: j.id, failure: String((j.data as Record<string, unknown>).failure ?? '') }))
    return { jobs: await this.jobCounts(slug), running, failed }
  }

  /**
   * Waits until the series (or every series) has nothing left to run: no running job, and every queued job is blocked by a failed one.
   * Returns the failed job ids. A running job whose model call waits in the client task queue (`client/...` model, answered over MCP)
   * is not working: the call returns as soon as nothing else runs, with `clientTasks` (how many tasks wait or are leased for this
   * series) so the caller can take them (`cts_get_task`). Without that it would block until the timeout.
   */
  async waitIdle(
    slug: string | null,
    o: { timeoutMs?: number; pollMs?: number; onTick?: () => void } = {}
  ): Promise<{ failed: string[]; timedOut: boolean; clientTasks: number }> {
    const end = o.timeoutMs ? Date.now() + o.timeoutMs : Infinity
    const mine = (b: string | null) => !slug || b === slug
    let idleSeen = false
    for (;;) {
      // running, queued, running again: a job that starts or ends between the reads is not missed (it is in one of them)
      const running1 = (await this.deps.jobs.list('running')).filter((j) => mine(j.data.book))
      const queued = (await this.deps.jobs.list('queued')).filter((j) => mine(j.data.book))
      const running2 = (await this.deps.jobs.list('running')).filter((j) => mine(j.data.book))
      const running = [...new Map([...running1, ...running2].map((j) => [j.id, j])).values()]
      // jobs parked in the client queue (waiting for Claude): not running work
      const queue = this.deps.registry.clientQueue
      const parked = queue.jobs()
      const working = running.filter((j) => !parked.has(j.id))
      const clientTasks = queue.countFor((job) => running.some((j) => j.id === job))
      const failed = (await this.deps.jobs.list('failed')).filter((j) => mine(j.data.book)).map((j) => j.id)
      const blocked = new Set<string>()
      const failedSet = new Set(failed)
      for (let changed = true; changed; ) {
        changed = false
        for (const j of queued) {
          if (blocked.has(j.id)) continue
          if (j.data.depends_on.some((d) => failedSet.has(d) || blocked.has(d))) {
            blocked.add(j.id)
            changed = true
          }
        }
      }
      const pending = queued.filter((j) => !blocked.has(j.id))
      // only the failures of the latest run count: an older run's failed job is history
      const latest = Math.max(0, ...failed.map(runOf))
      const current = failed.filter((id) => runOf(id) === latest)
      if (working.length === 0 && clientTasks > 0) return { failed: current, timedOut: false, clientTasks }
      if (running.length === 0 && pending.length === 0) {
        // a job that just ended may have queued its next jobs after the read above: look once more before saying idle
        if (idleSeen) return { failed: current, timedOut: false, clientTasks: 0 }
        idleSeen = true
        await new Promise((r) => setTimeout(r, 75))
        continue
      }
      idleSeen = false
      if (Date.now() > end) return { failed: current, timedOut: true, clientTasks }
      o.onTick?.()
      await new Promise((r) => setTimeout(r, o.pollMs ?? 300))
    }
  }

  // ---- generators: ComfyUI, the studios, the voice engines ----

  /**
   * The ComfyUI client. With `autoStart` (job paths only, never a status check) a lane that does not answer at all is started first, when
   * `config/autostart.md` allows it. A client given to the engine (tests) is used as it is.
   */
  async comfy(o: { autoStart?: boolean; log?: (m: string) => void } = {}): Promise<ComfyClient> {
    const override = this.comfyOverride
    if (override) return typeof override === 'function' ? override() : override
    const starter = o.autoStart ? this.deps.starter : undefined
    return createComfyClient({
      config: await loadComfyConfig(path.join(this.dataDir, 'config', 'comfy.md')),
      dataDir: this.dataDir,
      ...(starter
        ? {
            ensureLane: async (lane: string, signal?: AbortSignal) => {
              const id = await starter.idForUrl(lane)
              return id ? starter.ensure(id, lane, { signal, log: o.log }) : 'not a service Cartoon Studio starts'
            }
          }
        : {})
    })
  }

  /** The Chiptune Studio, flow-music-mcp and VibeTTS clients. With `autoStart` a studio that is down is started first (job paths only; VibeTTS is never started). */
  async studios(o: { autoStart?: boolean; log?: (m: string) => void } = {}): Promise<{ chiptune: ChiptuneClient; flow: FlowClient; vibetts: VibeTtsClient; config: StudiosConfig }> {
    const config = await loadStudiosConfig(this.dataDir)
    const starter = o.autoStart ? this.deps.starter : undefined
    const hook = (id: string, url: string) => (starter ? { ensureUp: (signal?: AbortSignal) => starter.ensure(id, url, { signal, log: o.log }) } : {})
    return {
      chiptune: this.deps.chiptune ?? chiptuneClientFor(config, hook('chiptune-studio', config.chiptuneStudioUrl)),
      flow: this.deps.flow ?? flowClientFor(config),
      vibetts: this.deps.vibetts ?? vibettsClientFor(config),
      config
    }
  }

  /** Asks the services for their tools. Never throws: an unreachable service is `ok: false` with the message (and how to start it). */
  async studiosStatus(): Promise<StudioStatusView[]> {
    const { chiptune, flow, vibetts, config } = await this.studios()
    const probeChiptune = async (): Promise<StudioStatusView> => {
      const id: StudioId = 'chiptune'
      const base = { id, name: STUDIO_NAMES[id], url: chiptune.url || studioUrl(config, id), repo: studioRepo(config, id), hint: startHint(config, id) }
      try {
        const tools = await chiptune.listTools()
        return { ...base, ok: true, error: '', tools: tools.length }
      } catch (e) {
        return { ...base, ok: false, error: (e as Error).message, tools: 0 }
      }
    }
    const probeFlow = async (): Promise<StudioStatusView> => {
      const base = { id: 'flow' as const, name: 'flow-music-mcp (Google Flow)', url: flow.url || config.flowUrl, repo: config.flowRepo, hint: flowStartHint(config) }
      try {
        const st = await flow.status()
        if (!st.up) return { ...base, ok: false, error: st.hint ?? base.hint, tools: 0 }
        if (st.signedIn === false) return { ...base, ok: false, error: st.hint ?? 'Google Flow is not signed in', tools: 0 }
        return { ...base, ok: true, error: '', tools: 0 }
      } catch (e) {
        return { ...base, ok: false, error: (e as Error).message, tools: 0 }
      }
    }
    const probeVibe = async (): Promise<StudioStatusView> => {
      const base = { id: 'vibetts' as const, name: 'VibeTTS (local text-to-speech)', url: vibetts.url || config.vibettsUrl, repo: '', hint: vibettsStartHint(config) }
      try {
        const v = await vibetts.listVoices()
        return { ...base, ok: true, error: '', tools: v.voices.length }
      } catch (e) {
        return { ...base, ok: false, error: (e as Error).message, tools: 0 }
      }
    }
    const probeComfy = async (): Promise<StudioStatusView> => {
      let lane = ''
      try {
        const cfg = await loadComfyConfig(path.join(this.dataDir, 'config', 'comfy.md'))
        lane = lanesOf(cfg)[0] ?? ''
        const q = await queueState(lane, 4000)
        return { id: 'comfy', name: 'ComfyUI', ok: true, url: lane, error: '', repo: '', hint: `queue: ${q.running} running, ${q.pending} pending`, tools: 0 }
      } catch (e) {
        return { id: 'comfy', name: 'ComfyUI', ok: false, url: lane, error: (e as Error).message, repo: '', hint: 'Start ComfyUI (hub.ps1 start comfyui)', tools: 0 }
      }
    }
    return Promise.all([probeComfy(), probeChiptune(), probeFlow(), probeVibe()])
  }

  /** The UI commands about series and generators: each answers with its event. */
  async handle(cmd: ServiceCommand): Promise<void> {
    switch (cmd.type) {
      case 'listSeries':
        this.emit({ type: 'series.listed', series: await this.listSeries() })
        return
      case 'studiosStatus':
        this.emit({ type: 'studios.status', studios: await this.studiosStatus() })
        return
    }
  }
}
