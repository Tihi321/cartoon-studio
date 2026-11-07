import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import type { EngineEvent, AgentProblem, AgentState } from '../../shared/protocol'
import type { FactoryConfig, JobFrontmatter } from '../../shared/schemas'
import type { AgentDef, AgentStore } from '../agents/agents'
import type { Budget } from '../budget/spend'
import { localIso } from '../budget/spend'
import type { LogWriter } from '../logs/logs'
import { isPaidModel } from '../models/registry'
import type { ModelInfo } from '../models/registry'
import type { ModelRouter } from '../models/router'
import { BudgetError, contentText, emptyUsage, isAbortError } from '../models/types'
import type { ChatMessage, Usage } from '../models/types'
import type { JobFile, JobStore, NewJob } from './jobs'

export interface ChatOptions {
  messages: ChatMessage[]
  schema?: Record<string, unknown>
  maxTokens?: number
  temperature?: number
}

export interface ChatResult {
  text: string
  usage: Usage
  model: ModelInfo
  costUsd: number
}

export interface JobContext {
  job: JobFrontmatter
  /** The model the job was leased: its first one (a fallback may answer later). Undefined for a job that needs no model, until a lazy job's first `chat`. */
  readonly model?: ModelInfo
  jobBody: string
  agent: { id: string; role: string; name: string; persona: string }
  signal: AbortSignal
  /** Calls the model through the router: fallback, limits, budget and spend rows are handled. */
  chat(opts: ChatOptions): Promise<ChatResult>
  /** Lists what went into the request, for the terminal and the log. */
  context(items: { name: string; tokens: number }[]): void
  /** Tells the scheduler which prompt template text was used, so `prompt_version` covers the edited file. */
  usedTemplate(templateText: string): string
  /** Adds a line to the job's log block. */
  log(text: string): void
  /** Enqueues a follow-up job (idempotent by id). */
  enqueue(job: NewJob, body?: string): Promise<boolean>
}

export type HandlerResult = { result: string; resultPath?: string } | { suspendOn: string }

export type JobHandler = (ctx: JobContext) => Promise<HandlerResult>

export interface HandlerOptions {
  /** Prompt template text. Hashed with the agent body into `prompt_version`. */
  template?: string
  /** Shows the agent as "reviewing" instead of "working". */
  reviewing?: boolean
  /**
   * The handler does its own work (ComfyUI, files, the build) and never needs a model: the job starts without a model or a provider slot,
   * and `ctx.chat` throws. Used for the pipeline's deterministic jobs.
   */
  noModel?: boolean
  /**
   * A cheap check that says the job will need no model this time (analyse with nothing to settle, stage with every cue by hand, ...). Such a
   * job starts at once, without waiting for a model or a provider slot. If it calls `ctx.chat` after all (the files changed since the check),
   * `chat` takes a slot first, so the job is then a normal one. An error in the check counts as false.
   */
  skipModel?: (job: JobFile) => Promise<boolean>
}

/** `stopped`: the user stopped the job's project; the job is dropped, not put back in the queue. */
export type AbortReason = 'stop' | 'fire' | 'stopNow' | 'shutdown' | 'stopped'

interface RunningJob {
  job: JobFile
  agentId: string
  controller: AbortController
  reason?: AbortReason
  done: Promise<void>
  /** Providers whose slot the job holds from its start: the first model's, until the job falls back to another provider. */
  held: Set<string>
  /** The model the job calls now: the first one, then each fallback. */
  model: string
  /** Aborts only the request in flight, for a model change. The job goes on. */
  request?: AbortController
  /** The first model of the list the request in flight was sent with. */
  first?: string
  /** The agent's or role's model changed: the job's next request builds its model list again. */
  modelChanged?: boolean
  /** The model the job holds a slot for: the first one's, set at launch, or by the first `chat` of a lazy job. */
  leased?: ModelInfo
  /** Launched without a slot because `skipModel` said it needs no model: `ctx.chat` leases one itself. */
  lazy: boolean
}

interface AgentRuntime {
  id: string
  running: Map<string, RunningJob>
  retiring: boolean
  state?: string
  task?: string
  jobId?: string
  book?: string
  errorUntil: number
  /** Its last failed request, until a request of it is answered again. */
  problem?: AgentProblem
}

export interface SchedulerDeps {
  jobs: JobStore
  agents: AgentStore
  router: ModelRouter
  budget: Budget
  logs: LogWriter
  getFactory: () => FactoryConfig
  emit: (e: EngineEvent) => void
  pollMs?: number
  now?: () => number
  /** Called when an agent file was removed (a graceful fire finished). */
  onAgentsChanged?: () => void
  /** True for a book paused on its own (`paused: true` in book.md): its jobs wait, running ones finish. */
  isBookPaused?: (book: string) => boolean
  /** The model a book chose for a role (Cartoon Studio: `models` in project.md), or undefined. It goes first in the job's model list. */
  projectModel?: (book: string, role: string) => string | undefined
}

const sha = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 8)

export class Scheduler {
  private handlers = new Map<string, { fn: JobHandler; opts: HandlerOptions }>()
  private runtimes = new Map<string, AgentRuntime>()
  private running = new Map<string, RunningJob>()
  private locks = new Set<string>()
  private ticking = false
  private again = false
  private timer: NodeJS.Timeout | undefined
  private stopped = false
  private readonly now: () => number

  constructor(private readonly d: SchedulerDeps) {
    this.now = d.now ?? Date.now
  }

  register(task: string, fn: JobHandler, opts: HandlerOptions = {}): void {
    this.handlers.set(task, { fn, opts })
  }

  start(): void {
    this.stopped = false
    this.timer = setInterval(() => void this.tick(), this.d.pollMs ?? 1000)
    this.timer.unref?.()
    void this.tick()
  }

  kick(): void {
    void this.tick()
  }

  async tick(): Promise<void> {
    if (this.stopped) return
    if (this.ticking) {
      this.again = true
      return
    }
    this.ticking = true
    try {
      do {
        this.again = false
        await this.tickOnce()
      } while (this.again && !this.stopped)
    } catch (err) {
      // a file operation that failed for a moment (Windows locks): the next tick starts over, nothing is lost
      console.error('[engine] scheduler tick failed:', (err as Error).message)
    } finally {
      this.ticking = false
    }
  }

  // ---- controls ----

  stopAgent(agentId: string, reason: AbortReason = 'stop'): number {
    let n = 0
    for (const rj of this.running.values()) {
      if (rj.agentId === agentId) {
        this.abort(rj, reason)
        n++
      }
    }
    return n
  }

  stopBook(book: string, reason: AbortReason = 'stopped'): number {
    let n = 0
    for (const rj of this.running.values()) {
      if (rj.job.data.book === book) {
        this.abort(rj, reason)
        n++
      }
    }
    return n
  }

  stopAll(reason: AbortReason = 'stopNow'): number {
    let n = 0
    for (const rj of this.running.values()) {
      this.abort(rj, reason)
      n++
    }
    return n
  }

  /**
   * The model of running jobs changed (an agent's own model, a role default, the default models or their order). Each matching job
   * takes the new model list from its next request; a request in flight on a model that is no longer first starts again on the new one.
   * Earlier requests of the job are kept. Returns how many requests were restarted.
   */
  changeModel(match: { agent?: string; role?: string } = {}): number {
    let n = 0
    for (const rj of this.running.values()) {
      if (match.agent && rj.agentId !== match.agent) continue
      if (match.role && rj.job.data.role !== match.role) continue
      rj.modelChanged = true
      const first = this.modelsFor(rj)[0]
      if (rj.request && first && first.ref !== rj.first) {
        rj.request.abort()
        n++
      }
    }
    return n
  }

  /** The models a running job may use now: the agent's own model (as its file says now), then its role's list. */
  private modelsFor(rj: RunningJob): ModelInfo[] {
    const def = this.d.agents.get(rj.agentId)
    const book = rj.job.data.book
    return this.d.router.candidates(rj.job.data.role, { agentModel: def?.data.model, avoidFamily: rj.job.data.avoid_family, visionOnly: rj.job.data.vision, projectModel: book ? this.d.projectModel?.(book, rj.job.data.role) : undefined })
  }

  /** Fire: graceful lets the current job finish, then removes the file. Now aborts it and removes the file at once. */
  async fire(agentId: string, now: boolean): Promise<void> {
    const rt = this.runtimes.get(agentId)
    if (rt) rt.retiring = true
    if (now) this.stopAgent(agentId, 'fire')
    if (!rt || rt.running.size === 0 || now) await this.d.agents.remove(agentId)
    this.d.onAgentsChanged?.()
    this.kick()
  }

  /** Waits for every running job to settle. */
  async drain(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()].map((r) => r.done))
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.stopAll('shutdown')
    await this.drain()
  }

  runningJobs(): { jobId: string; agent: string }[] {
    return [...this.running.values()].map((r) => ({ jobId: r.job.id, agent: r.agentId }))
  }

  agentStates(): { id: string; state: string }[] {
    return [...this.runtimes.values()].map((r) => ({ id: r.id, state: r.state ?? 'idle' }))
  }

  /** The agent's current state, task, book and the model its job calls now, for snapshots. */
  agentInfo(id: string): { state: AgentState; task?: string; book?: string; jobId?: string; model?: string; problem?: AgentProblem } {
    const r = this.runtimes.get(id)
    const state = (r?.state?.split('|')[0] ?? 'idle') as AgentState
    const model = r?.jobId ? r.running.get(r.jobId)?.model : undefined
    return { state, task: r?.task || undefined, book: r?.book, jobId: r?.jobId, model, problem: r?.problem }
  }

  /** Records an agent's failed request, or clears it (`undefined`) when one is answered again, and tells the office. */
  private setProblem(rt: AgentRuntime, problem: AgentProblem | undefined): void {
    if (!problem && !rt.problem) return
    rt.problem = problem
    this.d.emit({ type: 'agent.problem', agent: rt.id, problem: problem ?? null })
  }

  private abort(rj: RunningJob, reason: AbortReason): void {
    rj.reason = rj.reason ?? reason
    rj.controller.abort()
  }

  // ---- the loop ----

  private runtimeFor(id: string): AgentRuntime {
    let rt = this.runtimes.get(id)
    if (!rt) this.runtimes.set(id, (rt = { id, running: new Map(), retiring: false, errorUntil: 0 }))
    return rt
  }

  private async tickOnce(): Promise<void> {
    const { jobs, agents, router, budget } = this.d
    const defs = new Map(agents.list().map((a) => [a.id, a]))
    for (const id of defs.keys()) this.runtimeFor(id)
    for (const rt of [...this.runtimes.values()]) {
      if (!defs.has(rt.id)) {
        rt.retiring = true
        if (rt.running.size === 0) this.runtimes.delete(rt.id)
      }
    }

    const blocked = new Set<string>()
    const factory = this.d.getFactory()
    if (!factory.paused) {
      const queued = await jobs.list('queued')
      const doneIds = new Set(await jobs.ids('done'))
      // explicit requests (priority 1) go before the pipeline's own jobs (0); then oldest first
      queued.sort((a, b) => (b.data.priority ?? 0) - (a.data.priority ?? 0) || (a.data.created ?? '').localeCompare(b.data.created ?? '') || a.id.localeCompare(b.id))
      const t = this.now()
      for (const job of queued) {
        if (this.stopped) break
        const j = job.data
        if (!this.handlers.has(j.task)) continue
        if (j.not_before && Date.parse(j.not_before) > t) continue
        if (j.book && this.d.isBookPaused?.(j.book)) continue
        if (j.depends_on.some((id) => !doneIds.has(id))) continue
        if (j.waiting_on && !doneIds.has(j.waiting_on)) continue
        if (j.locks.some((l) => this.locks.has(l))) continue

        const agent = this.pickAgent(j, defs)
        if (!agent) continue
        const rt = this.runtimeFor(agent.id)
        const handlerOpts = this.handlers.get(j.task)?.opts
        if (handlerOpts?.noModel) {
          const claimedLocal = await jobs.claim(job.id)
          if (!claimedLocal) continue
          for (const l of j.locks) this.locks.add(l)
          this.launch(claimedLocal, agent, [], undefined)
          continue
        }
        if (handlerOpts?.skipModel && (await handlerOpts.skipModel(job).catch(() => false))) {
          const claimedLazy = await jobs.claim(job.id)
          if (!claimedLazy) continue
          for (const l of j.locks) this.locks.add(l)
          this.launch(claimedLazy, agent, [], undefined, true)
          continue
        }
        const models = router.candidates(j.role, { agentModel: agent.data.model, avoidFamily: j.avoid_family, visionOnly: j.vision, projectModel: j.book ? this.d.projectModel?.(j.book, j.role) : undefined })
        if (models.length === 0) {
          rt.errorUntil = t + 3000
          this.setState(rt, agent, 'error', 'no model available for this role')
          continue
        }
        let chosen: ModelInfo | undefined
        let busy = false
        for (const m of models) {
          if (isPaidModel(m) && !budget.isExhausted(j.book).ok) continue // paid and over a cap: try the next (local) model
          if (!router.limiter.hasCapacity(m.provider)) {
            busy = true
            break // wait for the preferred provider instead of silently using a paid fallback
          }
          router.limiter.tryAcquire(m.provider)
          chosen = m
          break
        }
        if (!chosen) {
          if (busy) blocked.add(agent.id)
          continue
        }
        const claimed = await jobs.claim(job.id)
        if (!claimed) {
          router.limiter.release(chosen.provider)
          continue
        }
        for (const l of j.locks) this.locks.add(l)
        this.launch(claimed, agent, models.slice(models.indexOf(chosen)), chosen)
      }
    }
    for (const rt of this.runtimes.values()) {
      const def = defs.get(rt.id)
      if (!def) continue
      if (rt.running.size === 0) {
        if (def.data.paused) this.setState(rt, def, 'paused')
        else if (rt.errorUntil > this.now()) this.setState(rt, def, 'error', rt.state?.split('|')[1])
        else if (blocked.has(rt.id)) this.setState(rt, def, 'waiting-provider')
        else this.setState(rt, def, 'idle')
      }
    }
  }

  private pickAgent(j: JobFrontmatter, defs: Map<string, AgentDef>): AgentDef | undefined {
    const options: { def: AgentDef; focus: boolean; hint: boolean; load: number }[] = []
    for (const def of defs.values()) {
      const rt = this.runtimes.get(def.id)
      if (!rt || rt.retiring || def.data.paused) continue
      if (def.data.role !== j.role) continue
      const load = j.lane ? this.inLane(rt, j.lane) : this.occupying(rt)
      if (load >= def.data.max_parallel) continue
      if (def.data.pin && def.data.pin !== j.book) continue
      options.push({ def, focus: !!j.book && def.data.focus.includes(j.book), hint: j.agent_hint === def.id, load })
    }
    // the hinted agent (same writer for a book) is busy finishing the job before this one: wait a little for it
    if (j.agent_hint && !options.some((o) => o.hint)) {
      const hinted = defs.get(j.agent_hint)
      const age = this.now() - (j.created ? Date.parse(j.created) : 0)
      if (hinted && !hinted.data.paused && this.runtimes.get(hinted.id)?.retiring === false && age < 20_000) return undefined
    }
    options.sort((a, b) => Number(b.hint) - Number(a.hint) || Number(b.focus) - Number(a.focus) || a.load - b.load || a.def.id.localeCompare(b.def.id))
    return options[0]?.def
  }

  /**
   * The jobs of an agent that keep it busy: every running job except the ones parked on a `client` model, which wait for an MCP client and
   * take nothing from the agent. The client provider's `concurrency` is the cap on those.
   */
  private occupying(rt: AgentRuntime): number {
    let n = 0
    for (const rj of rt.running.values()) if (!rj.job.data.lane && this.d.router.registry.getModel(rj.model)?.provider.kind !== 'client') n++
    return n
  }

  /** The jobs of an agent running in a lane (see `JobFrontmatter.lane`): they count against the lane, not against the agent's other jobs. */
  private inLane(rt: AgentRuntime, lane: string): number {
    let n = 0
    for (const rj of rt.running.values()) if (rj.job.data.lane === lane) n++
    return n
  }

  private setState(rt: AgentRuntime, def: AgentDef, state: AgentState, task?: string, job?: JobFrontmatter): void {
    const key = `${state}|${task ?? ''}|${job?.id ?? ''}`
    if (rt.state === key) return
    rt.state = key
    rt.task = task
    rt.jobId = job?.id
    rt.book = job?.book ?? undefined
    this.d.emit({
      type: 'agent.state',
      agent: def.id,
      role: def.data.role,
      state,
      jobId: job?.id,
      task,
      book: job?.book ?? undefined
    })
  }

  // ---- running a job ----

  private launch(job: JobFile, agent: AgentDef, models: ModelInfo[], leased: ModelInfo | undefined, lazy = false): void {
    const rt = this.runtimeFor(agent.id)
    const controller = new AbortController()
    const rj: RunningJob = { job, agentId: agent.id, controller, done: Promise.resolve(), held: new Set(leased ? [leased.provider.id] : []), model: leased?.ref ?? 'none', leased, lazy }
    this.running.set(job.id, rj)
    rt.running.set(job.id, rj)
    rj.done = this.run(rj, agent, models).catch((err) => { console.error('[engine] job runner failed:', err) }).finally(() => {
      this.running.delete(job.id)
      rt.running.delete(job.id)
      if (rj.leased && rj.held.delete(rj.leased.provider.id)) this.d.router.limiter.release(rj.leased.provider)
      for (const l of job.data.locks) this.locks.delete(l)
      void this.afterJob(rt, agent).finally(() => this.kick())
    })
  }

  private async afterJob(rt: AgentRuntime, agent: AgentDef): Promise<void> {
    if (rt.running.size === 0) {
      if (rt.retiring) {
        await this.d.agents.remove(agent.id)
        this.runtimes.delete(agent.id)
        this.d.onAgentsChanged?.()
        return
      }
      const def = this.d.agents.get(agent.id) ?? agent
      this.setState(rt, def, def.data.paused ? 'paused' : this.now() < rt.errorUntil ? 'error' : 'idle')
    }
  }

  private async run(rj: RunningJob, agent: AgentDef, startModels: ModelInfo[]): Promise<void> {
    let models = startModels
    let leased = rj.leased
    const { jobs, logs, emit } = this.d
    const { job } = rj
    const j = job.data
    const handler = this.handlers.get(j.task)!
    const rt = this.runtimeFor(agent.id)
    const started = Date.now()
    let promptVersion = sha((handler.opts.template ?? '') + agent.body)
    const taskLabel = j.label?.trim() || `${j.task}${j.unit ? ' ' + j.unit : ''}`
    const requests: string[] = []
    const usedModels: string[] = []
    const totals = { calls: 0, tokensIn: 0, tokensCached: 0, tokensOut: 0, costUsd: 0 }
    const logAll = (text: string) => logs.both(agent.id, j.book, text)

    this.setState(rt, agent, handler.opts.reviewing ? 'reviewing' : 'working', taskLabel, j)
    emit({ type: 'job.started', jobId: j.id, agent: agent.id, task: taskLabel, book: j.book ?? undefined, model: leased?.ref })
    if (j.requested_by !== 'engine') {
      emit({ type: 'handover', from: j.requested_by, to: agent.id, label: taskLabel, jobId: j.id })
    }
    logAll(
      `\n## ${localIso(new Date())} job \`${j.id}\`\n\n` +
        `- requested by: ${j.requested_by}\n- task: ${j.task} (role ${j.role})${j.book ? `, book ${j.book}` : ''}${j.unit ? `, unit ${j.unit}` : ''}, round ${j.round}\n` +
        `- agent: ${agent.id}, first model: ${leased?.ref ?? (rj.lazy ? 'none yet (a model only if the job turns out to need one)' : 'none (no model needed)')}, prompt version ${promptVersion}, attempt ${j.attempts + 1}\n`
    )
    // a model the project or the agent asked for that this job did not get: say why, so a dropped setting is not silent
    if (leased) {
      const notUsed = (label: string, ref: string | undefined | null): void => {
        const full = ref ? this.d.router.registry.resolve(ref) : undefined
        if (!full || full === leased?.ref) return
        logAll(`- ${label} model ${full} not used: ${this.d.router.whyUnusable(full, { visionOnly: j.vision }) ?? 'over the budget cap'}\n`)
      }
      notUsed('project', j.book ? this.d.projectModel?.(j.book, j.role) : undefined)
      notUsed('agent', agent.data.model)
    }
    await jobs.update('running', j.id, { paid: leased ? isPaidModel(leased) : false, prompt_version: promptVersion, agent: agent.id, model: leased?.ref ?? null } as Partial<JobFrontmatter>)

    /**
     * A lazy job (`skipModel` said it needs no model) that calls `chat` after all: waits for a slot like a job that was never lazy would have,
     * the first model that has room, and holds it until the job ends.
     */
    const leaseNow = async (): Promise<ModelInfo> => {
      const { router, budget } = this.d
      for (;;) {
        if (rj.controller.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        const list = this.modelsFor(rj)
        if (list.length === 0) throw new Error('no model available for this role')
        let chosen: ModelInfo | undefined
        for (const m of list) {
          if (isPaidModel(m) && !budget.isExhausted(j.book).ok) continue
          if (!router.limiter.hasCapacity(m.provider)) break // wait for the preferred provider
          router.limiter.tryAcquire(m.provider)
          chosen = m
          break
        }
        if (chosen) {
          leased = rj.leased = chosen
          rj.held.add(chosen.provider.id)
          rj.model = chosen.ref
          models = list.slice(list.indexOf(chosen))
          logAll(`_the job needs a model after all: ${chosen.ref}_\n`)
          await jobs.update('running', j.id, { paid: isPaidModel(chosen), model: chosen.ref } as Partial<JobFrontmatter>)
          return chosen
        }
        if (list.every((m) => isPaidModel(m))) throw new BudgetError('every model is paid and the budget cap is reached')
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(t)
            rj.controller.signal.removeEventListener('abort', done)
            resolve()
          }
          const t = setTimeout(done, 500)
          rj.controller.signal.addEventListener('abort', done, { once: true })
        })
      }
    }

    const ctx: JobContext = {
      job: j,
      get model() {
        return rj.leased
      },
      jobBody: job.body,
      agent: { id: agent.id, role: agent.data.role, name: agent.data.name, persona: agent.body },
      signal: rj.controller.signal,
      usedTemplate: (text) => (promptVersion = sha(text + agent.body)),
      context: (items) => {
        logAll('### Context\n' + items.map((i) => `- ${i.name} (${i.tokens} tokens)`).join('\n') + '\n')
      },
      log: (text) => logAll(text.endsWith('\n') ? text : text + '\n'),
      enqueue: (nj, body) => jobs.enqueue({ requested_by: agent.id, ...nj }, body),
      chat: async (o) => {
        if (!leased && !rj.lazy) throw new Error(`the ${j.task} job needs no model, so it cannot call one`)
        const first = leased ?? (await leaseNow())
        requests.push(o.messages.map((m) => `[${m.role}]\n${contentText(m.content)}`).join('\n\n'))
        let text = ''
        let result: ChatResult | undefined
        logAll(`### Output\n`)
        for (;;) {
          if (rj.modelChanged) {
            rj.modelChanged = false
            const next = this.modelsFor(rj)
            if (next.length > 0) models = next
          }
          // a model change aborts only this request; stopping the job aborts it too
          const request = new AbortController()
          const onStop = () => request.abort()
          rj.controller.signal.addEventListener('abort', onStop, { once: true })
          if (rj.controller.signal.aborted) request.abort()
          rj.request = request
          rj.first = models[0]?.ref
          try {
            for await (const ev of this.d.router.chat(
              models,
              {
                messages: o.messages,
                schema: o.schema,
                maxTokens: o.maxTokens,
                temperature: o.temperature,
                signal: request.signal,
                meta: { job: j.id, role: j.role, task: j.task, book: j.book ?? undefined, agent: agent.id, unit: j.unit ?? undefined }
              },
              rj.held
            )) {
              if (ev.type === 'attempt') {
                text = ''
                if (ev.model.ref !== (usedModels[usedModels.length - 1] ?? first.ref)) {
                  emit({ type: 'job.model', jobId: j.id, agent: agent.id, model: ev.model.ref })
                }
                // fell back to another provider: give the first one's slot back, so other agents don't wait for a server this job no longer uses
                if (ev.model.provider.id !== first.provider.id && rj.held.delete(first.provider.id)) {
                  this.d.router.limiter.release(first.provider)
                  this.kick()
                }
                usedModels.push(ev.model.ref)
                rj.model = ev.model.ref
                logAll(`\n_model ${ev.model.ref}${ev.attempt > 1 ? ' (fallback or retry)' : ''}_\n\n`)
              } else if (ev.type === 'problem') {
                this.setProblem(rt, { kind: ev.kind, model: ev.model.ref, message: ev.message.slice(0, 300), at: this.now() })
              } else if (ev.type === 'delta') {
                text += ev.text
                emit({ type: 'job.token', jobId: j.id, agent: agent.id, text: ev.text })
                logAll(ev.text)
              } else {
                this.setProblem(rt, undefined)
                totals.calls++
                totals.tokensIn += ev.usage.inputTokens
                totals.tokensCached += ev.usage.cachedInputTokens
                totals.tokensOut += ev.usage.outputTokens
                totals.costUsd += ev.costUsd
                result = { text, usage: ev.usage, model: ev.model, costUsd: ev.costUsd }
                emit({
                  type: 'spend',
                  provider: ev.model.provider.id,
                  model: ev.model.id,
                  served: ev.model.servedId,
                  tokensIn: ev.usage.inputTokens,
                  tokensOut: ev.usage.outputTokens,
                  costUsd: ev.costUsd,
                  agent: agent.id,
                  book: j.book ?? undefined
                })
              }
            }
            break
          } catch (err) {
            // only a model change aborts the request without stopping the job: ask again, on the new model list
            if (rj.controller.signal.aborted || !request.signal.aborted) throw err
            rj.modelChanged = true
            logAll(`\n_model changed, this request starts again_\n\n`)
          } finally {
            rj.controller.signal.removeEventListener('abort', onStop)
            rj.request = undefined
          }
        }
        logAll('\n')
        return result ?? { text, usage: emptyUsage(), model: first, costUsd: 0 }
      }
    }

    const numbers = () =>
      `${totals.calls} call(s), ${totals.tokensIn} in (${totals.tokensCached} cached) / ${totals.tokensOut} out tokens, ${totals.costUsd.toFixed(6)} USD, ${((Date.now() - started) / 1000).toFixed(1)} s`
    const requestBody = () => (job.body.trim() ? job.body.trimEnd() + '\n\n' : '') + (requests.length ? '## Request\n\n' + requests.map((r, i) => `### Call ${i + 1}\n\n${r}`).join('\n\n') + '\n\n' : '')
    const stats = (): Partial<JobFrontmatter> =>
      ({
        model: usedModels[usedModels.length - 1] ?? leased?.ref,
        prompt_version: promptVersion,
        tokens_in: totals.tokensIn,
        tokens_out: totals.tokensOut,
        cost_usd: Number(totals.costUsd.toFixed(6)),
        ms: Date.now() - started
      }) as Partial<JobFrontmatter>

    try {
      const out = await handler.fn(ctx)
      if (rj.controller.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      if ('suspendOn' in out) {
        await jobs.requeue(j.id, { waiting_on: out.suspendOn })
        logAll(`### Result\nSuspended, waiting on ${out.suspendOn}. ${numbers()}\n`)
        emit({ type: 'job.done', jobId: j.id, agent: agent.id, ok: true, result: `waiting on ${out.suspendOn}` })
      } else {
        await jobs.complete(j.id, { ...stats(), finished: new Date().toISOString() } as Partial<JobFrontmatter>, `${requestBody()}## Result\n\n${out.resultPath ? `Written to ${out.resultPath}\n\n` : ''}${out.result}\n\n${numbers()}\n`)
        logAll(`### Result\n${out.resultPath ? `Written to ${out.resultPath}. ` : ''}${numbers()}\n`)
        emit({ type: 'job.done', jobId: j.id, agent: agent.id, ok: true, result: out.resultPath ?? out.result.slice(0, 200) })
      }
    } catch (err) {
      const aborted = rj.controller.signal.aborted || isAbortError(err)
      if (aborted) {
        if (rj.reason === 'stopped') {
          // its project was stopped: drop the job, so nothing starts it again
          await rm(jobs.file('running', j.id), { force: true })
          logAll(`### Result\nStopped with its project, job dropped. ${numbers()}\n`)
        } else {
          await jobs.requeue(j.id)
          logAll(`### Result\nStopped (${rj.reason ?? 'stop'}), job goes back to the queue. ${numbers()}\n`)
        }
        emit({ type: 'job.done', jobId: j.id, agent: agent.id, ok: false, error: `stopped (${rj.reason ?? 'stop'})` })
      } else if (err instanceof BudgetError) {
        await jobs.requeue(j.id, { not_before: new Date(this.now() + 15_000).toISOString() })
        logAll(`### Result\nBlocked by the budget: ${err.message}. Job goes back to the queue.\n`)
        emit({ type: 'job.done', jobId: j.id, agent: agent.id, ok: false, error: err.message })
      } else {
        const message = err instanceof Error ? err.message : String(err)
        const attempts = j.attempts + 1
        const max = j.max_attempts ?? this.d.getFactory().max_attempts
        rt.errorUntil = this.now() + 3000
        if (rt.problem) this.setProblem(rt, { ...rt.problem, failed: true })
        if (attempts >= max) {
          await jobs.fail(j.id, { ...stats(), attempts, failure: message } as Partial<JobFrontmatter>, `${requestBody()}## Failed\n\n${message}\n`)
          logAll(`### Result\nFailed for good after ${attempts} attempt(s): ${message}\n`)
        } else {
          const wait = Math.min(60_000, 1000 * 2 ** attempts)
          await jobs.requeue(j.id, { attempts, not_before: new Date(this.now() + wait).toISOString() })
          logAll(`### Result\nFailed (attempt ${attempts} of ${max}): ${message}. Retrying in ${wait / 1000} s.\n`)
        }
        this.setState(rt, agent, 'error', message.slice(0, 80), j)
        emit({ type: 'job.done', jobId: j.id, agent: agent.id, ok: false, error: message })
      }
    }
    if (j.requested_by !== 'engine') {
      emit({ type: 'handover', from: j.requested_by, to: agent.id, label: taskLabel, jobId: j.id, done: true })
    }
  }
}
