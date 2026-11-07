import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Command, EngineEvent, SettingsSummary, SnapshotEvent } from '../shared/protocol'
import { parseMdWith } from '../shared/md'
import { factorySchema, groupDefaultsOf, ROLES, settingsSchema } from '../shared/schemas'
import type { FactoryConfig, SettingsConfig } from '../shared/schemas'
import { AgentStore } from './agents/agents'
import { Budget } from './budget/spend'
import { LogWriter } from './logs/logs'
import { ClientTaskQueue } from './models/client'
import { deleteStoredKey, resolveKey, setStoredKey } from './models/keys'
import { checkBaseUrl, keyNameOf, removeCustomProviderEntry, upsertCustomProvider } from './models/customProviders'
import { OpenAiCompatClient } from './models/openaiCompat'
import { ModelRegistry, guessFamily, modelDefaultsOf } from './models/registry'
import type { ListedModel } from './models/openaiCompat'
import type { RegistryOptions } from './models/registry'
import { ModelRouter } from './models/router'
import type { RouterOptions } from './models/router'
import { JobStore } from './queue/jobs'
import { Scheduler } from './queue/scheduler'
import { atomicWrite, readMd, writeMd } from './store/atomic'
import { agentSummary, modelSummaries, providerSummaries, roleDefaults, serverStatuses } from './summary'
import { CtsService } from './service'
import type { ComfyClient } from './comfy/client'
import type { ChiptuneClient } from './studios/chiptune'
import type { FlowClient } from './studios/flow'
import type { VibeTtsClient } from './studios/vibetts'
import { ServiceStarter } from './studios/autostart'
import { readSeedNotes } from './store/seedRefresh'
import type { WatchEvent } from './store/watcher'
import type { EngineLock } from './store/lock'
import { McpController } from './mcp/controller'
import { buildTools, callTool } from './mcp/tools'
import type { Tool } from './mcp/tools'
import { ENGINE_MODULES } from './modules'

export interface EngineOptions {
  dataDir: string
  emit: (e: EngineEvent) => void
  log?: (message: string) => void
  registry?: RegistryOptions
  router?: RouterOptions
  pollMs?: number
  /** Ask LM Studio and other `discover: true` providers for their models at start. Default true. */
  discover?: boolean
  /** A ComfyUI client for the image and voice jobs (tests pass a fake). Default: one made from `config/comfy.md`. */
  comfy?: ComfyClient
  /** Chiptune Studio client for the music jobs (tests pass a fake). Default: made from `config/studios.md`. */
  chiptune?: ChiptuneClient
  /** flow-music-mcp client for Google Flow images, voices and clips (tests pass a fake). Default: made from `config/studios.md`. */
  flow?: FlowClient
  /** VibeTTS, the local text-to-speech app (tests pass a fake). Default: made from `config/studios.md`. Never started by Cartoon Studio. */
  vibetts?: VibeTtsClient
  /** The voice step's clock and sleep (tests: a fixed day for the Gemini quota, an instant sleep). */
  voiceRuntime?: { now?: () => Date; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }
  /** Starts Chiptune Studio and ComfyUI when a job needs them (`config/autostart.md`). Default: one made here (tests pass a fake). */
  starter?: ServiceStarter
  /** The data-folder lock this engine holds (`store/lock.ts`): released by `stop()`. Tests leave it out. */
  lock?: EngineLock
}

/** How often `concurrency: auto` providers are asked for their slot count. */
const SLOT_SYNC_MS = 10_000

/** The text below the frontmatter of a config/models.md the engine creates (as in seed/config/models.md). */
const MODELS_MD_BODY = "# Models in the pickers\n\nWhich models the model pickers offer (the agent panel, Role defaults and the default models). The app writes this file from its **Models** panel (the Models button in the top bar): pick a provider, press **Detect models** to list everything it has, and tick the models you want, or add one by its id (with its price for a paid provider). You can also edit it by hand.\n\n- `picked`: models that are not in `providers.md`, ticked from a provider's list or added by id, each with its `provider`, `id`, `context` and the price the provider listed when you picked it (or the one you typed) (`price_in`, `price_out`, `price_cached_in`, USD per 1M tokens). The budget counts them at that price. A paid model is only ticked with a listed price; for one whose price the provider doesn't list (DeepSeek's), add it by id with its price.\n- `hidden`: `provider/model` refs the pickers leave out: models from `providers.md` or found by `discover` that you unticked. A role list in `roles.md` can still name a hidden model.\n- `limits`: per provider, the limits set in the Models panel, over the ones in `providers.md`: `concurrency` (requests at once), `rpm` (per minute) and `rpd` (per day, from midnight UTC). 0 means no limit.\n"

/**
 * The engine core: config, models, budget, agents, jobs and the scheduler, plus the command handler. The cartoon modules (series store, voice,
 * render, pipeline) register their job handlers through `registerModule` (or straight on `scheduler`/`queue`, `queue.register(task, handler)`).
 */
export class Engine {
  readonly registry: ModelRegistry
  readonly budget: Budget
  readonly router: ModelRouter
  readonly jobs: JobStore
  readonly agents: AgentStore
  readonly logs: LogWriter
  readonly scheduler: Scheduler
  /** Series and generators: the queries and queue helpers. The UI commands and the MCP server go through it. */
  readonly cts: CtsService
  private readonly starter: ServiceStarter
  /** The model calls of `client` providers waiting for an MCP client. The engine owns the one queue; the registry and the MCP tools share it. */
  readonly clientQueue: ClientTaskQueue
  /** The MCP HTTP server (`config/mcp.md`), once `startMcp` ran. */
  mcp: McpController | null = null
  factory: FactoryConfig = factorySchema.parse({ kind: 'factory' })
  /** `start()` finished: snapshots from now on are complete. */
  private started = false
  /** The last model list each provider gave the Models page (`detectModels`), for the prices of the models picked from it. */
  private catalogs = new Map<string, ListedModel[]>()
  settings: SettingsConfig = settingsSchema.parse({ kind: 'settings' })
  private knownAgents = new Set<string>()
  private slotTimer: ReturnType<typeof setInterval> | undefined
  private readonly startedAt = Date.now()
  private readonly log: (m: string) => void
  private readonly emit: (e: EngineEvent) => void

  constructor(private readonly opts: EngineOptions) {
    this.emit = (e) => opts.emit(e)
    this.log = opts.log ?? (() => undefined)
    const dir = opts.dataDir
    this.clientQueue = opts.registry?.clientQueue ?? new ClientTaskQueue()
    this.registry = new ModelRegistry(dir, { ...opts.registry, clientQueue: this.clientQueue })
    this.budget = new Budget(dir, {
      onWarn: (message) => {
        this.log(`budget warning: ${message}`)
        this.emit({ type: 'engine.warning', message })
      }
    })
    this.router = new ModelRouter(this.registry, this.budget, opts.router)
    // a request that finds Strata (or LM Studio) not running marks it down for every agent at once, not one agent at a time
    this.router.onProviderDown = (p) => {
      this.log(`models: ${p.id} is down (a request could not reach ${p.baseUrl}), jobs use the next model in their role`)
      this.emit({ type: 'servers', servers: serverStatuses(this.registry) })
      this.scheduler.kick()
    }
    // a provider's daily limit is used up: say so once, and show it in the Models panel
    this.router.onProviderDayFull = (p) => {
      const at = new Date(this.router.limiter.dayResetsAt()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      this.log(`models: ${p.id} used up its requests for today, jobs use the next model in their role until ${at}`)
      this.emit({ type: 'engine.warning', message: `${p.id} used up its requests for today: jobs use their next model until ${at}.` })
      void this.snapshot().then((s) => this.emit(s))
      this.scheduler.kick()
    }
    this.jobs = new JobStore(dir)
    this.agents = new AgentStore(dir)
    this.logs = new LogWriter(dir)
    this.scheduler = new Scheduler({
      jobs: this.jobs,
      agents: this.agents,
      router: this.router,
      budget: this.budget,
      logs: this.logs,
      getFactory: () => this.factory,
      emit: this.emit,
      pollMs: opts.pollMs,
      onAgentsChanged: () => this.syncAgents(),
      projectModel: (book, role) => this.cts.seriesModel(book, role)
    })
    this.starter = opts.starter ?? new ServiceStarter({ dataDir: dir, log: (m) => this.log(m) })
    this.cts = new CtsService({
      dataDir: dir,
      log: this.log,
      emit: this.emit,
      registry: this.registry,
      router: this.router,
      jobs: this.jobs,
      getSettings: () => this.settings,
      getFactory: () => this.factory,
      agents: this.agents,
      changeModel: () => this.scheduler.changeModel(),
      kick: () => this.scheduler.kick(),
      stopBook: (slug, reason) => this.scheduler.stopBook(slug, reason),
      comfy: opts.comfy,
      chiptune: opts.chiptune,
      flow: opts.flow,
      vibetts: opts.vibetts,
      voiceRuntime: opts.voiceRuntime,
      starter: this.starter
    })
    for (const mod of ENGINE_MODULES) mod(this)
  }

  /** The job queue (the scheduler): `queue.register(task, handler)` adds a job handler. */
  get queue(): Scheduler {
    return this.scheduler
  }

  /**
   * Adds a cartoon module: a function that takes the engine and registers what it owns (job handlers on `queue`, subscriptions). Modules
   * added before `start()` are ready when the first job runs.
   */
  registerModule(mod: (engine: Engine) => void): void {
    mod(this)
  }

  get dataDir(): string {
    return this.opts.dataDir
  }

  async start(): Promise<void> {
    await this.loadFactory()
    await this.loadSettings()
    await this.registry.load()
    this.warnAliases()
    for (const p of this.registry.providers.values()) if (p.keyFrom) this.log(`provider ${p.id}: key from ${p.keyFrom}`)
    void this.discoverModels()
    // providers with `concurrency: auto` (Strata) follow the slot count their server reports: asked now and every few seconds,
    // so starting Strata with a "4 at once" or a "one at a time" script needs no change in providers.md
    await this.syncSlots()
    this.slotTimer = setInterval(() => void this.syncSlots(), SLOT_SYNC_MS)
    this.slotTimer.unref?.()
    await this.budget.load()
    // daily request limits count the requests made before this start too
    for (const p of this.registry.providers.values()) this.router.limiter.seedToday(p.id, this.budget.requestsTodayUtc(p.id))
    const rec = await this.jobs.recoverRunning()
    if (rec.requeued.length || rec.dropped.length) {
      this.log(`recovery: ${rec.requeued.length} running job(s) back to queued, ${rec.dropped.length} duplicate(s) dropped`)
    }
    await this.agents.loadAll((file, err) => this.log(`invalid agent file ${file}: ${err.message}`))
    this.knownAgents = new Set(this.agents.list().map((a) => a.id))
    await this.cts.warm()
    this.scheduler.start()
    await this.budget.writeSummary().catch(() => undefined)
    // seeded prompts and config that have a newer version but were edited by you are kept: say so
    const notes = await readSeedNotes(this.opts.dataDir)
    if (notes.updateAvailable.length) {
      this.emit({
        type: 'engine.warning',
        message: `update available for ${notes.updateAvailable.length} seeded file(s) you edited (${notes.updateAvailable.slice(0, 4).join(', ')}${notes.updateAvailable.length > 4 ? ', ...' : ''}): yours are kept; delete one to get the new version from seed/`
      })
    }
    this.started = true
  }

  /** Asks `concurrency: auto` servers for their slot count; a higher count frees waiting requests at once. */
  private async syncSlots(): Promise<void> {
    let changed
    const wasDown = new Map([...this.registry.providers.values()].map((p) => [p.id, p.down]))
    try {
      changed = await this.registry.syncServerSlots()
    } catch (err) {
      this.log(`could not ask the servers for their slots: ${(err as Error).message}`)
      return
    }
    for (const c of changed.slots) {
      this.log(`models: ${c.provider.id} runs ${c.to} request(s) at once (was ${c.from}), as the server reports`)
      if (c.to > c.from) this.router.limiter.wakeAll(c.provider)
    }
    // the model a server runs changed (Strata restarted with another model): its `loaded` rows follow, the pickers show the new name
    for (const c of changed.served) this.log(`models: ${c.provider.id} now serves ${c.to}${c.from ? ` (was ${c.from})` : ''}`)
    // a server that stops answering is skipped (its jobs go to the next model in the role) until it answers again
    let upOrDown = false
    for (const p of this.registry.providers.values()) {
      if (!wasDown.has(p.id) || wasDown.get(p.id) === p.down) continue
      upOrDown = true
      this.log(p.down ? `models: ${p.id} is down (${p.baseUrl} does not answer, or has no model loaded), jobs use the next model in their role` : `models: ${p.id} answers again`)
    }
    if (changed.slots.length || changed.served.length || upOrDown) {
      this.emit({ type: 'servers', servers: serverStatuses(this.registry) })
      if (changed.served.length && this.started) this.emit(await this.snapshot()) // the models list carries `served`
      this.scheduler.kick()
    }
  }

  private uiToolList: Tool[] | null = null
  /** The MCP tools bound to this engine, for the studio's `call` command (built once; the MCP server builds its own copy). */
  private uiTools(): Tool[] {
    this.uiToolList ??= buildTools(this.cts, { control: this.mcpControl(), clientQueue: this.clientQueue })
    return this.uiToolList
  }

  /** The queue switches the MCP tools `cts_pause_all`, `cts_resume_all` and `cts_stop_now` use. */
  mcpControl(): { setPaused(paused: boolean): Promise<void>; stopNow(opts?: { drop?: boolean; slug?: string }): Promise<void>; clearQueue(slug?: string): Promise<{ dropped: number; series: string[] }> } {
    return {
      setPaused: async (paused) => {
        await this.setPaused(paused)
        if (!paused) this.scheduler.kick()
      },
      stopNow: async (opts = {}) => {
        await this.setPaused(true)
        this.scheduler.stopAll('stopNow')
        if (opts.drop) {
          // the stopped jobs go back to the queue first, then the whole queue is dropped
          await this.scheduler.drain()
          await this.cts.clearQueue(opts.slug ?? null)
        }
      },
      clearQueue: (slug) => this.cts.clearQueue(slug ?? null)
    }
  }

  /** Starts the MCP HTTP server when `config/mcp.md` enables it. A bind failure is in the returned status, it does not throw. */
  async startMcp(o: { port?: number; force?: boolean } = {}): Promise<Extract<EngineEvent, { type: 'mcp.status' }>> {
    this.mcp ??= new McpController({
      dataDir: this.dataDir,
      svc: this.cts,
      control: this.mcpControl(),
      clientQueue: this.clientQueue,
      emit: this.emit,
      log: this.log,
      lock: this.opts.lock,
      port: o.port,
      force: o.force
    })
    return this.mcp.start()
  }

  async stop(): Promise<void> {
    await this.mcp?.stop()
    if (this.slotTimer) clearInterval(this.slotTimer)
    this.cts.dispose()
    await this.starter.stopStarted().catch(() => undefined)
    await this.scheduler.stop()
    await this.logs.flush()
    await this.budget.flush().catch(() => undefined)
    await this.opts.lock?.release().catch(() => undefined)
  }

  // ---- config ----

  private factoryFile(): string {
    return path.join(this.dataDir, 'config', 'factory.md')
  }

  async loadFactory(): Promise<void> {
    try {
      const text = await fs.readFile(this.factoryFile(), 'utf8')
      this.factory = parseMdWith(text, factorySchema, this.factoryFile()).data
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`config/factory.md: ${(err as Error).message}`)
    }
  }

  /**
   * Asks the providers with `discover` which models they have (see `ModelRegistry.discover`), then sends the pickers the new list.
   * Runs at start, and again when a key is stored or providers.md changes: a provider that just got its key lists its models then.
   */
  async discoverModels(): Promise<void> {
    if (this.opts.discover === false) return
    try {
      const r = await this.registry.discover()
      for (const d of r) this.log(`models: ${d.provider} ${d.error ? 'discovery failed: ' + d.error : d.served ? `serves ${d.served}` : d.found + ' found'}`)
      if (r.length && this.started) this.emit(await this.snapshot()) // before that, the first snapshot has them
      this.scheduler.kick()
    } catch (err) {
      this.log(`models: discovery failed: ${(err as Error).message}`)
    }
  }

  /** Asks a provider for every model it lists and sends the list to the Models dialog (`models.catalog`). */
  async detectModels(provider: string): Promise<void> {
    const at = new Date().toISOString()
    const local = !!this.registry.providers.get(provider)?.local
    try {
      const listed = await this.registry.catalog(provider)
      this.catalogs.set(provider, listed)
      const models = listed.map((m) => ({
        id: m.id,
        ref: `${provider}/${m.id}`,
        context: m.context,
        priceIn: local ? 0 : m.price?.in,
        priceOut: local ? 0 : m.price?.out,
        pickable: local || !!m.price
      }))
      this.log(`models: ${provider} lists ${models.length} chat model(s)`)
      this.emit({ type: 'models.catalog', provider, models, at })
    } catch (err) {
      this.emit({ type: 'models.catalog', provider, models: [], error: (err as Error).message, at })
    }
  }

  /**
   * Shows models in the pickers or hides them, in config/models.md. Showing a model the engine doesn't know yet adds it to `picked`
   * with the context and price its provider listed; a paid model without a listed price is refused. Hiding a picked model removes it.
   */
  async showModels(refs: string[], shown: boolean): Promise<void> {
    await this.editModelChoices((picked, hidden) => this.applyShowModels(picked, hidden, refs, shown))
  }

  /**
   * Adds a model the provider doesn't list (or that can't be listed: Anthropic, Gemini) to `picked` in config/models.md.
   * A paid provider's model needs both prices, so the budget can count it; a known model is only shown again.
   */
  async addModel(cmd: { provider: string; id: string; priceIn?: number; priceOut?: number; context?: number; vision?: boolean }): Promise<void> {
    const id = cmd.id.trim()
    const p = this.registry.providers.get(cmd.provider)
    if (!id || !p || p.kind === 'search') return this.log(`addModel: no provider "${cmd.provider}" or an empty id`)
    const price = (v?: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
    const priceIn = p.local ? 0 : price(cmd.priceIn)
    const priceOut = p.local ? 0 : price(cmd.priceOut)
    if (priceIn === undefined || priceOut === undefined) return this.log(`addModel: ${cmd.provider}/${id} needs its price in and out (USD per 1M tokens, 0 for a free model)`)
    const ref = `${cmd.provider}/${id}`
    await this.editModelChoices((picked, hidden) => {
      hidden.delete(ref)
      if (this.registry.models.has(ref) || picked.some((m) => `${String(m.provider)}/${String(m.id)}` === ref)) return
      const context = typeof cmd.context === 'number' && cmd.context > 0 ? Math.round(cmd.context) : undefined
      picked.push({ provider: cmd.provider, id, family: guessFamily(id), ...(context ? { context } : {}), ...(cmd.vision === true ? { vision: true } : {}), price_in: priceIn, price_out: priceOut })
      this.log(`models: added ${ref}`)
    })
  }

  // ---- custom providers (Models page: Add provider) ----

  private providersFile(): string {
    return path.join(this.dataDir, 'config', 'providers.md')
  }

  /** Adds a custom provider to config/providers.md (or edits one), stores its key, and tells the UI (`provider.saved`). */
  async saveCustomProvider(cmd: Extract<Command, { type: 'saveCustomProvider' }>): Promise<void> {
    try {
      const url = checkBaseUrl(cmd.baseUrl)
      if ('error' in url) throw new Error(url.error)
      const concurrency = cmd.concurrency === 'auto' ? 'auto' : Math.min(64, Math.max(1, Math.round(Number(cmd.concurrency)) || 1))
      const apiKey = cmd.apiKey?.trim() ?? ''
      const existing = cmd.id ? this.registry.providers.get(cmd.id) : undefined
      const hadKey = !!existing?.apiKeyEnv && !!resolveKey(existing.apiKeyEnv)
      const { text, id } = upsertCustomProvider(await fs.readFile(this.providersFile(), 'utf8'), {
        id: cmd.id,
        name: cmd.name,
        baseUrl: url.url,
        hasKey: !!apiKey || hadKey,
        free: cmd.free,
        jsonSchema: cmd.jsonSchema,
        concurrency,
        enabled: cmd.enabled
      })
      // the key first: the file watcher reloads the registry as soon as the file changes, and it should find the key by then
      if (apiKey) setStoredKey(keyNameOf(id), apiKey)
      await atomicWrite(this.providersFile(), text)
      await this.registry.load()
      this.log(`models: ${cmd.id ? 'changed' : 'added'} custom provider ${id}`)
      this.emit({ type: 'provider.saved', ok: true, id })
      this.emit(await this.snapshot())
      this.scheduler.kick()
      void this.discoverModels()
    } catch (err) {
      this.log(`saveCustomProvider: ${(err as Error).message}`)
      this.emit({ type: 'provider.saved', ok: false, id: cmd.id, error: (err as Error).message })
    }
  }

  /** Removes a custom provider, its stored key, and its refs in config/models.md and config/settings.md. roles.md is left as it is. */
  async removeCustomProvider(id: string): Promise<void> {
    try {
      const { text, keyEnv } = removeCustomProviderEntry(await fs.readFile(this.providersFile(), 'utf8'), id)
      await atomicWrite(this.providersFile(), text)
      if (keyEnv) deleteStoredKey(keyEnv)
      await this.registry.load()
      // models.md: the provider's picked models, hidden refs and limits
      await this.editModelChoices((picked, hidden, limits) => {
        for (let i = picked.length - 1; i >= 0; i--) if (picked[i]!.provider === id) picked.splice(i, 1)
        for (const ref of [...hidden]) if (ref.startsWith(`${id}/`)) hidden.delete(ref)
        delete limits[id]
      })
      // settings.md: fallback rows of that provider
      const sFile = this.settingsFile()
      try {
        const doc = await readMd(sFile)
        const rows = Array.isArray(doc.data.fallbacks) ? doc.data.fallbacks : []
        const left = rows.filter((r) => typeof r === 'string' && !r.startsWith(id + '/'))
        if (left.length !== rows.length || doc.data.group_defaults || doc.data.model_order) {
          const next = { ...doc.data }
          if (left.length > 0) next.fallbacks = left
          delete next.group_defaults
          delete next.model_order
          await writeMd(sFile, next, doc.body)
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log('removeCustomProvider: settings.md: ' + (err as Error).message)
      }
      this.warnAliases()
      this.log(`models: removed custom provider ${id}`)
      this.emit({ type: 'provider.saved', ok: true, id, removed: true })
      this.emit({ type: 'secrets.updated', secretsSet: this.secretsSet(), keyNames: this.allowedSecrets() })
    } catch (err) {
      this.log(`removeCustomProvider: ${(err as Error).message}`)
      this.emit({ type: 'provider.saved', ok: false, id, error: (err as Error).message })
    }
  }

  /** Asks `GET <baseUrl>/models` and says how many models answered, or why not (`provider.tested`). Stores nothing. */
  async testCustomProvider(cmd: { baseUrl: string; apiKey?: string; id?: string }): Promise<void> {
    const at = new Date().toISOString()
    try {
      const url = checkBaseUrl(cmd.baseUrl)
      if ('error' in url) throw new Error(url.error)
      const env = cmd.id ? this.registry.providers.get(cmd.id)?.apiKeyEnv : undefined
      const apiKey = cmd.apiKey?.trim() || (env ? (this.opts.registry?.keys ?? resolveKey)(env) : undefined)
      const client = new OpenAiCompatClient({ id: cmd.id ?? 'test', baseUrl: url.url, apiKey, fetchImpl: this.opts.registry?.fetchImpl })
      const listed = await client.listModelInfo()
      this.emit({ type: 'provider.tested', ok: true, count: listed.length, at })
    } catch (err) {
      this.emit({ type: 'provider.tested', ok: false, error: (err as Error).message, at })
    }
  }

  /**
   * Sets a provider's limits in `limits` of config/models.md, over providers.md: requests at once (not for a `concurrency: auto`
   * server), per minute and per day (0: no limit). A raised limit frees waiting requests at once.
   */
  async setProviderLimits(cmd: { provider: string; concurrency?: number; rpm?: number; rpd?: number }): Promise<void> {
    const p = this.registry.providers.get(cmd.provider)
    if (!p || p.kind === 'search') return this.log(`setProviderLimits: no provider "${cmd.provider}"`)
    const count = (v: number | undefined, min: number) => (typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.round(v) : undefined)
    const set: Record<string, number> = {}
    const concurrency = p.concurrencyAuto ? undefined : count(cmd.concurrency, 1)
    if (concurrency !== undefined) set.concurrency = concurrency
    const rpm = count(cmd.rpm, 0)
    if (rpm !== undefined) set.rpm = rpm
    const rpd = count(cmd.rpd, 0)
    if (rpd !== undefined) set.rpd = rpd
    if (!Object.keys(set).length) return
    await this.editModelChoices((_picked, _hidden, limits) => {
      limits[p.id] = { ...(limits[p.id] ?? {}), ...set }
      this.log(`models: ${p.id} limits ${Object.entries(set).map(([k, v]) => `${k} ${v || 'none'}`).join(', ')}`)
    })
    const now = this.registry.providers.get(p.id)
    if (now) this.router.limiter.wakeAll(now)
  }

  /** Reads `picked` and `hidden` of config/models.md, lets `change` edit them, writes the file and sends the pickers the result. */
  private async editModelChoices(change: (picked: Record<string, unknown>[], hidden: Set<string>, limits: Record<string, Record<string, number>>) => void): Promise<void> {
    const file = this.registry.modelsFile()
    let doc
    try {
      doc = await readMd(file)
    } catch {
      doc = { data: { kind: 'models' } as Record<string, unknown>, body: MODELS_MD_BODY }
    }
    const picked = Array.isArray(doc.data.picked) ? (doc.data.picked as Record<string, unknown>[]) : []
    const hidden = new Set(Array.isArray(doc.data.hidden) ? (doc.data.hidden as string[]) : [])
    const limits = doc.data.limits && typeof doc.data.limits === 'object' ? (doc.data.limits as Record<string, Record<string, number>>) : {}
    change(picked, hidden, limits)
    await writeMd(file, { ...doc.data, kind: 'models', picked, hidden: [...hidden].sort(), limits }, doc.body || MODELS_MD_BODY)
    await this.registry.load()
    this.emit(await this.snapshot()) // the pickers follow
    this.scheduler.kick()
  }

  private applyShowModels(picked: Record<string, unknown>[], hidden: Set<string>, refs: string[], shown: boolean): void {
    const isPicked = (ref: string) => picked.findIndex((m) => `${String(m.provider)}/${String(m.id)}` === ref)
    for (const ref of new Set(refs)) {
      const slash = ref.indexOf('/')
      const provider = ref.slice(0, slash)
      const id = ref.slice(slash + 1)
      const p = this.registry.providers.get(provider)
      if (slash < 1 || !p) {
        this.log(`showModels: unknown model ${ref}`)
        continue
      }
      if (!shown) {
        const i = isPicked(ref)
        if (i >= 0) picked.splice(i, 1)
        else hidden.add(ref)
        continue
      }
      hidden.delete(ref)
      if (this.registry.models.has(ref) || isPicked(ref) >= 0) continue
      const m = this.catalogs.get(provider)?.find((x) => x.id === id)
      if (!m) {
        this.log(`showModels: ${provider} has not listed ${id} (detect its models first)`)
        continue
      }
      if (!p.local && !m.price) {
        this.log(`showModels: ${ref} has no listed price, so the budget could not count it: add it to providers.md with its price`)
        continue
      }
      picked.push({
        provider,
        id,
        family: guessFamily(id),
        ...(m.context ? { context: m.context } : {}),
        ...(m.maxOutput ? { max_output: m.maxOutput } : {}),
        price_in: p.local ? 0 : m.price!.in,
        price_out: p.local ? 0 : m.price!.out,
        ...(!p.local && m.price!.cachedIn !== undefined ? { price_cached_in: m.price!.cachedIn } : {})
      })
    }
  }

  /** Persists pause all in config/factory.md. */
  async setPaused(paused: boolean): Promise<void> {
    const file = this.factoryFile()
    let doc
    try {
      doc = await readMd(file)
    } catch {
      doc = { data: { kind: 'factory' } as Record<string, unknown>, body: '' }
    }
    await writeMd(file, { ...doc.data, paused }, doc.body)
    const changed = this.factory.paused !== paused
    this.factory = { ...this.factory, paused }
    if (changed) this.emit({ type: 'factory.paused', paused })
  }

  /** Changes a role default: puts the model first in the role's list in config/roles.md. */
  async setRoleModel(role: string, model: string): Promise<void> {
    const file = path.join(this.dataDir, 'config', 'roles.md')
    const doc = await readMd(file)
    const roles = { ...((doc.data.roles as Record<string, { models?: string[] }> | undefined) ?? {}) }
    const old = roles[role]?.models ?? []
    roles[role] = { ...roles[role], models: [model, ...old.filter((m) => m !== model)] }
    await writeMd(file, { ...doc.data, roles }, doc.body)
    await this.registry.load()
  }

  // ---- file changes ----

  async handleWatch(e: WatchEvent): Promise<void> {
    try {
      if (e.kind === 'agent') {
        const id = path.basename(e.rel, '.md')
        await this.agents.reloadFile(id)
        this.syncAgents()
        this.emitAgentUpdated(id)
      } else if (e.kind === 'config') {
        const name = path.basename(e.rel, '.md')
        if (name === 'providers' || name === 'roles' || name === 'models') {
          await this.registry.load()
          this.warnAliases()
          if (name !== 'providers') this.scheduler.changeModel() // running jobs follow a changed role list
          this.emit(await this.snapshot()) // the pickers show the models and role defaults
          if (name === 'providers') void this.discoverModels()
        } else if (name === 'mcp') await this.mcp?.reload()
        else if (name === 'budget') await this.budget.loadCaps()
        else if (name === 'factory') {
          const before = this.factory.paused
          await this.loadFactory()
          if (before !== this.factory.paused) this.emit({ type: 'factory.paused', paused: this.factory.paused })
        } else if (name === 'settings') {
          await this.loadSettings()
          await this.registry.load() // the fallback list and the LM Studio context may have changed
          this.warnAliases()
          this.scheduler.changeModel() // running jobs follow changed default models or their order
          this.emit(await this.snapshot())
        }
      }
    } catch (err) {
      this.log(`could not reload ${e.rel}: ${(err as Error).message} (keeping the previous version)`)
    }
    this.scheduler.kick()
  }

  // ---- settings, secrets, agents ----

  private settingsFile(): string {
    return path.join(this.dataDir, 'config', 'settings.md')
  }

  /** Aliases already reported, so a reload that changes nothing stays quiet. */
  private aliasWarned = new Set<string>()

  /** Logs once each alias of roles.md that names no row of the fallback list (its model is skipped like an unknown one). */
  private warnAliases(): void {
    const now = new Set(this.registry.unresolvedAliases())
    for (const a of now) if (!this.aliasWarned.has(a)) this.log('roles.md: "' + a + '" names no row in the fallback list')
    this.aliasWarned = now
  }

  async loadSettings(): Promise<void> {
    try {
      this.settings = parseMdWith(await fs.readFile(this.settingsFile(), 'utf8'), settingsSchema, this.settingsFile()).data
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log('config/settings.md: ' + (err as Error).message)
    }
    this.registry.setDefaults(modelDefaultsOf(this.settings))
    this.warnAliases()
  }

  settingsSummary(): SettingsSummary {
    const s = this.settings
    return {
      fallbacks: s.fallbacks,
      fallbackShared: s.fallback_shared,
      groupDefaults: groupDefaultsOf(s),
      modelOrder: s.model_order,
      lmstudioParallel: s.lmstudio_parallel,
      lmstudioContext: s.lmstudio_context,
      lmstudioTtlMinutes: s.lmstudio_ttl_minutes
    }
  }

  /**
   * Writes the given fields to config/settings.md (the other fields and the notes below the frontmatter stay), loads the file again
   * and tells the UI. The settings command writes through it.
   */
  private async writeSettings(fields: Record<string, unknown>): Promise<void> {
    const file = this.settingsFile()
    let doc
    try {
      doc = await readMd(file)
    } catch {
      doc = { data: { kind: 'settings' } as Record<string, unknown>, body: '' }
    }
    // older settings keys are removed once fallbacks is saved
    const { default_paid_model: _oldPaid, default_strata_model: _oldStrata, default_lmstudio_model: _oldLm, group_defaults: _gd, model_order: _mo, ...rest } = doc.data
    const next: Record<string, unknown> = { ...rest, kind: 'settings', ...fields }
    if ('fallbacks' in fields) {
      delete next.group_defaults
      delete next.model_order
      delete next.default_paid_model
      delete next.default_strata_model
      delete next.default_lmstudio_model
    }
    await writeMd(file, next, doc.body)
    await this.loadSettings()
    await this.registry.load()
    this.scheduler.changeModel() // running jobs follow changed default models or their order
    this.scheduler.kick()
    this.emit(await this.snapshot()) // the role defaults shown in the pickers follow the new aliases
  }

  /** The only secrets the UI may set: the key variables named in providers.md. */
  allowedSecrets(): string[] {
    const names = new Set<string>()
    for (const p of this.registry.providers.values()) if (p.apiKeyEnv) names.add(p.apiKeyEnv)
    return [...names]
  }

  secretsSet(): string[] {
    return this.allowedSecrets().filter((n) => !!resolveKey(n))
  }

  /** Tells the UI that an agent's file changed (model override, paused). */
  emitAgentUpdated(id: string): void {
    const def = this.agents.get(id)
    if (def && this.knownAgents.has(id)) this.emit({ type: 'agent.updated', agent: agentSummary(def, this.scheduler, this.router) })
  }

  /** Emits agent.hired / agent.removed for the differences since the last time. */
  syncAgents(): void {
    const now = new Map(this.agents.list().map((a) => [a.id, a]))
    for (const [id, def] of now) {
      if (!this.knownAgents.has(id)) {
        this.knownAgents.add(id)
        this.emit({ type: 'agent.hired', agent: agentSummary(def, this.scheduler, this.router) })
      }
    }
    for (const id of [...this.knownAgents]) {
      if (!now.has(id)) {
        this.knownAgents.delete(id)
        this.emit({ type: 'agent.removed', agent: id })
      }
    }
  }

  // ---- commands ----

  async handleCommand(cmd: Command): Promise<void> {
    switch (cmd.type) {
      case 'ping':
        this.emit({ type: 'pong', id: cmd.id, at: new Date().toISOString() })
        return
      case 'snapshot':
        this.emit(await this.snapshot())
        return
      case 'checkServers':
        await this.syncSlots()
        this.emit({ type: 'servers', servers: serverStatuses(this.registry) }) // even when nothing changed, so the button stops waiting
        return
      case 'hire': {
        if (!(ROLES as readonly string[]).includes(cmd.role) && !(cmd.role in this.registry.roles.roles)) {
          this.log(`hire: unknown role ${cmd.role}`)
          return
        }
        const def = await this.agents.hire({ role: cmd.role, name: cmd.name, model: cmd.model })
        this.log(`hired ${def.id}`)
        this.syncAgents()
        this.scheduler.kick()
        return
      }
      case 'fire':
        await this.scheduler.fire(cmd.agent, !!cmd.now)
        return
      case 'pause':
        await this.agents.patch(cmd.agent, { paused: true })
        this.emitAgentUpdated(cmd.agent)
        this.scheduler.kick()
        return
      case 'resume':
        await this.agents.patch(cmd.agent, { paused: false })
        this.emitAgentUpdated(cmd.agent)
        this.scheduler.kick()
        return
      case 'stop':
        this.scheduler.stopAgent(cmd.agent)
        return
      case 'pauseAll':
        await this.setPaused(true)
        return
      case 'resumeAll':
        await this.setPaused(false)
        this.scheduler.kick()
        return
      case 'stopNow':
        // Pause first, so aborted jobs don't start again at once.
        await this.setPaused(true)
        this.scheduler.stopAll('stopNow')
        return
      case 'setModel': {
        if (cmd.model !== null && !this.registry.getModel(cmd.model)) {
          this.log(`setModel: unknown model ${cmd.model}`)
          return
        }
        if (cmd.agent) {
          await this.agents.patch(cmd.agent, { model: cmd.model })
          this.emitAgentUpdated(cmd.agent)
          // the job it works on now changes too: a request in flight on another model starts again on the new one
          const moved = this.scheduler.changeModel({ agent: cmd.agent })
          if (moved) this.log(`agent ${cmd.agent}: model changed in ${moved} running job(s)`)
        } else if (cmd.role && cmd.model !== null) {
          await this.setRoleModel(cmd.role, cmd.model)
          this.scheduler.changeModel({ role: cmd.role })
          this.emit(await this.snapshot()) // the new role default for the pickers
        }
        this.scheduler.kick()
        return
      }
      case 'saveSettings': {
        const s = this.settings
        let fallbacks: string[] | undefined
        if (cmd.fallbacks) {
          const rows = [...new Set(cmd.fallbacks.map((r) => r.trim()).filter((r) => r.includes('/')))]
          if (rows.length > 0) fallbacks = rows
        } else if (cmd.groupDefaults) {
          const prev = [...s.fallbacks]
          for (const [g, m] of Object.entries(cmd.groupDefaults)) {
            if (typeof m === 'string' && m.trim().includes('/')) {
              const trimmed = m.trim()
              const idx = prev.findIndex((r) => this.registry.kindOf(r) === g || r.startsWith(g + '/'))
              if (idx >= 0) prev[idx] = trimmed
              else prev.unshift(trimmed)
            }
          }
          fallbacks = [...new Set(prev)]
        }
        const shared = cmd.fallbackShared ?? (cmd.modelOrder ? cmd.modelOrder.length > 0 : s.fallback_shared)
        await this.writeSettings({
          fallbacks: fallbacks ?? s.fallbacks,
          fallback_shared: shared,
          ...(cmd.modelOrder ? { model_order: cmd.modelOrder } : {}),
          lmstudio_parallel: Math.min(16, Math.max(1, Math.round(cmd.lmstudioParallel ?? s.lmstudio_parallel) || 1)),
          lmstudio_context: Math.max(2048, Math.round(cmd.lmstudioContext ?? s.lmstudio_context) || 32768),
          lmstudio_ttl_minutes: Math.max(1, Math.round(cmd.lmstudioTtlMinutes ?? s.lmstudio_ttl_minutes) || 60)
        })
        this.warnAliases()
        return
      }
      case 'detectModels':
        await this.detectModels(cmd.provider)
        return
      case 'showModels':
        await this.showModels(cmd.refs, cmd.shown)
        return
      case 'addModel':
        await this.addModel(cmd)
        return
      case 'setProviderLimits':
        await this.setProviderLimits(cmd)
        return
      case 'saveCustomProvider':
        await this.saveCustomProvider(cmd)
        return
      case 'removeCustomProvider':
        await this.removeCustomProvider(cmd.id)
        return
      case 'testCustomProvider':
        await this.testCustomProvider(cmd)
        return
      case 'setSecret': {
        if (!this.allowedSecrets().includes(cmd.name)) {
          this.log(`setSecret: "${cmd.name}" is not a name the app may store`)
          return
        }
        if (!cmd.value) return
        try {
          setStoredKey(cmd.name, cmd.value)
          this.log(`stored secret ${cmd.name}`) // never the value
        } catch (err) {
          this.log(`could not store ${cmd.name}: ${(err as Error).message}`)
        }
        await this.registry.load() // a provider key may have appeared
        this.emit({ type: 'secrets.updated', secretsSet: this.secretsSet(), keyNames: this.allowedSecrets() })
        this.scheduler.kick()
        void this.discoverModels() // and with it the models that provider lists
        return
      }
      case 'call': {
        // the studio's generic route: any MCP tool, through the same callTool the MCP server uses
        const r = await callTool(this.uiTools(), cmd.tool, cmd.args)
        const text = r.content[0].text
        this.emit(r.isError ? { type: 'tool.result', id: cmd.id, tool: cmd.tool, ok: false, error: text } : { type: 'tool.result', id: cmd.id, tool: cmd.tool, ok: true, result: r.structuredContent ?? {} })
        return
      }
      case 'clearSecret':
        if (!this.allowedSecrets().includes(cmd.name)) return this.log(`clearSecret: "${cmd.name}" is not a name the app may store`)
        try {
          deleteStoredKey(cmd.name)
          this.log(`cleared secret ${cmd.name}`)
        } catch (err) {
          this.log(`could not clear ${cmd.name}: ${(err as Error).message}`)
        }
        await this.registry.load()
        this.emit({ type: 'secrets.updated', secretsSet: this.secretsSet(), keyNames: this.allowedSecrets() })
        return
      case 'mcpStatus':
        this.emit(this.mcp?.status() ?? { type: 'mcp.status', enabled: false, listening: false, url: null, error: '', port: 0, tokenSet: false })
        return
      case 'saveMcpConfig':
        if (!this.mcp) return this.log('saveMcpConfig: the MCP server is not part of this engine')
        await this.mcp.save({ enabled: cmd.enabled, port: cmd.port, token: cmd.token })
        return
      case 'listSeries':
      case 'studiosStatus':
        await this.cts.handle(cmd)
        this.scheduler.kick()
        return
      default:
        this.log(`command "${(cmd as { type: string }).type}" is not implemented yet`)
    }
  }

  async snapshot(): Promise<SnapshotEvent> {
    return {
      type: 'snapshot',
      dataDir: this.dataDir,
      uptimeMs: Date.now() - this.startedAt,
      paused: this.factory.paused,
      agents: this.agents.list().map((a) => agentSummary(a, this.scheduler, this.router)),
      models: modelSummaries(this.registry),
      providers: providerSummaries(this.registry, this.router.limiter),
      roleDefaults: roleDefaults(this.registry),
      servers: serverStatuses(this.registry),
      spend: this.budget.snapshot(),
      running: this.scheduler.runningJobs(),
      settings: this.settingsSummary(),
      secretsSet: this.secretsSet(),
      keyNames: this.allowedSecrets(),
      at: new Date().toISOString()
    }
  }
}
