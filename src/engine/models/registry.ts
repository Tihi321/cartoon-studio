import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseMdWith } from '../../shared/md'
import { modelsConfigSchema, providersSchema, rolesSchema, settingsSchema } from '../../shared/schemas'
import type { ModelsConfig, ProviderEntry, RolesConfig, SettingsConfig } from '../../shared/schemas'
import { promises as fs } from 'node:fs'
import { AnthropicClient } from './anthropic'
import { ClientProvider, ClientTaskQueue } from './client'
import { GeminiClient } from './gemini'
import { lookupKey, resolveKey } from './keys'
import type { KeyResolver } from './keys'
import { MockProvider } from './mock'
import { OpenAiCompatClient } from './openaiCompat'
import type { ListedModel } from './openaiCompat'
import type { ProviderClient } from './types'

export interface ProviderInfo {
  id: string
  kind: ProviderEntry['kind']
  enabled: boolean
  local: boolean
  /** The name shown in the UI (`name` in providers.md), else the id. */
  name: string
  /** Added in the Add provider form (`custom: true`): the UI may edit and remove it. Always its own group. */
  custom: boolean
  baseUrl?: string
  apiKeyEnv?: string
  concurrency: number
  /** `concurrency: auto`: `concurrency` follows the server's own slot count (see `syncServerSlots`). */
  concurrencyAuto: boolean
  /** `concurrency: auto`: the server did not answer the last check, or says its model is unloaded and won't load on request. Jobs skip it while another model is left. */
  down: boolean
  rpm?: number
  /** Requests per day, counted from midnight UTC (see `ProviderLimiter.dayFull`). */
  rpd?: number
  /** `free`: only the models the provider lists at price 0. */
  discover: boolean | 'free'
  /** Words that keep a model out of discovery (`discover_skip`). */
  discoverSkip: string[]
  /** Send the JSON schema as `response_format` (`openai-compat`). */
  jsonSchema: boolean
  /** LM Studio: the engine loads a model that isn't loaded yet, with `lmLoad` (see `setDefaults`). */
  loadModels: boolean
  /** Has `loaded` rows: the model the server runs is asked for (`served`), and the rows follow it. */
  hasLoaded: boolean
  /** `profiles` of providers.md: settings per model the server may run, matched by id prefix. */
  profiles: ProviderEntry['profiles']
  /** The model the server reported last (`/status`, `/models`); kept while it does not answer. Only for a provider with `loaded` rows. */
  served?: string
  /** `kind: search`: the service (tavily, wikipedia ...) and the price of one request. */
  searchEngine?: string
  pricePerRequest: number
  /** `engine: client` search: minutes a web search task waits for an MCP client (`wait_minutes`). */
  waitMinutes?: number
  /** Enabled and (local, mock or has a key). */
  available: boolean
  unavailableReason?: string
  /** The key was found in another tool's credential store (`the scriptorium credential store`). Not set for the environment or `cartoon-studio`. */
  keyFrom?: string
  client?: ProviderClient
}

export interface ModelInfo {
  /** `provider/model`. */
  ref: string
  provider: ProviderInfo
  id: string
  family: string
  context?: number
  maxOutput?: number
  /** USD per 1M tokens. */
  priceIn: number
  priceOut: number
  priceCachedIn: number
  embedding: boolean
  /** Accepts images in a message (`vision: true` in providers.md / models.md). */
  vision: boolean
  extraBody: Record<string, unknown> | null
  discovered: boolean
  /** Added from `picked` in config/models.md (the Models dialog), not from providers.md. */
  picked?: boolean
  /** LM Studio: this model's own load settings (`load_context`, `load_parallel`), over the settings' ones. */
  loadContext?: number
  loadParallel?: number
  /** Send the JSON schema as `response_format` for this model, over the provider's setting. Undefined: the provider's. */
  jsonSchema?: boolean
  /** A `loaded` row: it stands for the model the provider serves. */
  loaded?: boolean
  /** A `loaded` row: the model the provider serves now (undefined until it has answered once). `family`, `context`, `extraBody` follow it. */
  servedId?: string
  /** A `loaded` row: what providers.md says, before the served model's profile is applied. */
  loadedBase?: { family: string; context?: number; maxOutput?: number; extraBody: Record<string, unknown> | null; jsonSchema?: boolean }
}

/** A profile for a served model id: the one with the same id (any case), else the longest id it starts with. */
export function profileFor(profiles: ProviderEntry['profiles'], served: string): ProviderEntry['profiles'][number] | undefined {
  const s = served.toLowerCase()
  const exact = profiles.find((x) => x.id.toLowerCase() === s)
  if (exact) return exact
  let best: ProviderEntry['profiles'][number] | undefined
  for (const x of profiles) if (s.startsWith(x.id.toLowerCase()) && (!best || x.id.length > best.id.length)) best = x
  return best
}

export interface RegistryOptions {
  keys?: KeyResolver
  fetchImpl?: typeof fetch
  /** Reuse a mock provider so tests can script it. */
  mock?: MockProvider
  /** LM Studio's `lms` command line, used to load models. Default: `~/.lmstudio/bin/lms(.exe)` when it exists. `null`: use the REST API. */
  lmsPath?: string | null
  /** The engine's one client task queue, for `kind: client` providers. Default: a queue of the registry's own. */
  clientQueue?: ClientTaskQueue
}

function defaultLmsPath(): string | undefined {
  const p = path.join(os.homedir(), '.lmstudio', 'bin', process.platform === 'win32' ? 'lms.exe' : 'lms')
  return existsSync(p) ? p : undefined
}

/** A model that costs money: not local and with a price. */
export function isPaidModel(m: ModelInfo): boolean {
  return !m.provider.local && (m.priceIn > 0 || m.priceOut > 0 || m.priceCachedIn > 0)
}

/** Cost in USD for a usage on a model. Cached input is billed at its own price. */
export function computeCost(m: Pick<ModelInfo, 'priceIn' | 'priceOut' | 'priceCachedIn'>, u: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): number {
  const uncached = Math.max(0, u.inputTokens - u.cachedInputTokens)
  return (uncached * m.priceIn + u.cachedInputTokens * m.priceCachedIn + u.outputTokens * m.priceOut) / 1_000_000
}

/** The fallback list of config/settings.md, and how LM Studio models are loaded. */
export interface ModelDefaults {
  /** `provider/model` refs, first row first. A kind name (`paid`, `strata`, `lmstudio`, `client` ...) stands for the first row of that kind, `<kind>-<n>` for the n-th. */
  fallbacks: string[]
  /** One fallback order for every role (`fallback_shared`). False: each role's list keeps its own order. */
  shared: boolean
  lmLoad: { parallel: number; context: number; ttlMinutes: number }
}

/** The fallback list and LM Studio load settings of a settings.md. */
export function modelDefaultsOf(s: SettingsConfig): ModelDefaults {
  return {
    fallbacks: s.fallbacks,
    shared: s.fallback_shared,
    lmLoad: { parallel: s.lmstudio_parallel, context: s.lmstudio_context, ttlMinutes: s.lmstudio_ttl_minutes }
  }
}

export class ModelRegistry {
  providers = new Map<string, ProviderInfo>()
  models = new Map<string, ModelInfo>()
  roles: RolesConfig = { kind: 'roles', roles: {} }
  /** `search_order` of providers.md: the ids of the search providers, in the order the researcher tries them. */
  searchOrder: string[] = []
  /** config/models.md: the models picked in the Models dialog and the refs the pickers leave out. */
  modelChoices: ModelsConfig = { kind: 'models', picked: [], hidden: [], limits: {} }
  readonly mock: MockProvider
  /** The model calls of `kind: client` providers wait here for an MCP client (see `ClientProvider`). */
  readonly clientQueue: ClientTaskQueue
  /** The slot counts servers reported for `concurrency: auto` providers, kept across config reloads. */
  private serverSlots = new Map<string, number>()
  /** Which of them did not answer the last check, kept across config reloads. */
  private serverDown = new Map<string, boolean>()
  /** The model each provider with `loaded` rows serves, and its context window when `/models` said, kept across config reloads. */
  private servedIds = new Map<string, string>()
  private servedCtx = new Map<string, number>()
  /** `provider/<alias>` of a `loaded` row -> its ref. */
  private aliasRefs = new Map<string, string>()
  /** Until settings.md is read: the defaults it has when it says nothing. */
  private defaults: ModelDefaults = modelDefaultsOf(settingsSchema.parse({ kind: 'settings' }))

  constructor(
    private readonly dataDir: string,
    private readonly opts: RegistryOptions = {}
  ) {
    this.mock = opts.mock ?? new MockProvider('mock')
    this.clientQueue = opts.clientQueue ?? new ClientTaskQueue()
  }

  /** (Re)reads config/providers.md and config/roles.md. Keeps the previous state if a file is invalid. */
  async load(): Promise<void> {
    const provFile = path.join(this.dataDir, 'config', 'providers.md')
    const rolesFile = path.join(this.dataDir, 'config', 'roles.md')
    const prov = parseMdWith(await fs.readFile(provFile, 'utf8'), providersSchema, provFile)
    const roles = parseMdWith(await fs.readFile(rolesFile, 'utf8'), rolesSchema, rolesFile)
    const choices = await this.readModelChoices()
    const keys = this.opts.keys ?? resolveKey
    const discoveredBefore = [...this.models.values()].filter((m) => m.discovered)

    const providers = new Map<string, ProviderInfo>()
    const models = new Map<string, ModelInfo>()
    const aliasRefs = new Map<string, string>()
    for (const p of prov.data.providers) {
      // limits set in the Models panel (config/models.md) win over providers.md; 0 there means no limit
      const set = choices.limits[p.id] ?? {}
      const limit = (v: number | undefined, fallback: number | undefined) => (v === undefined ? fallback : v > 0 ? v : undefined)
      const info: ProviderInfo = {
        id: p.id,
        kind: p.kind,
        enabled: p.enabled,
        name: p.name?.trim() || p.id,
        custom: p.custom,
        local: p.kind === 'client' ? true : p.local, // a client provider has no server and no price: always local and free
        baseUrl: p.base_url,
        apiKeyEnv: p.api_key_env,
        concurrency: p.concurrency === 'auto' ? (this.serverSlots.get(p.id) ?? 1) : (set.concurrency ?? p.concurrency),
        concurrencyAuto: p.concurrency === 'auto',
        down: p.concurrency === 'auto' ? (this.serverDown.get(p.id) ?? false) : false,
        rpm: limit(set.rpm, p.rpm),
        rpd: limit(set.rpd, p.rpd),
        discover: p.discover,
        discoverSkip: p.discover_skip,
        jsonSchema: p.json_schema,
        loadModels: p.load_models,
        hasLoaded: p.kind === 'openai-compat' && p.models.some((m) => m.loaded),
        profiles: p.profiles,
        served: this.servedIds.get(p.id),
        searchEngine: p.engine ?? p.id,
        pricePerRequest: p.price_per_request,
        waitMinutes: p.wait_minutes,
        available: false
      }
      this.setupClient(info, keys)
      providers.set(p.id, info)
      for (const m of p.models) {
        const ref = `${p.id}/${m.id}`
        models.set(ref, {
          ref,
          provider: info,
          id: m.id,
          family: m.family,
          // a model the engine loads itself gets the context window it loads it with
          context: p.load_models ? Math.min(m.context ?? Infinity, m.load_context ?? this.defaults.lmLoad.context) : m.context,
          loadContext: m.load_context,
          loadParallel: m.load_parallel,
          maxOutput: m.max_output,
          priceIn: m.price_in,
          priceOut: m.price_out,
          priceCachedIn: m.price_cached_in ?? m.price_in,
          embedding: m.embedding,
          vision: m.vision,
          extraBody: m.extra_body ?? null,
          jsonSchema: m.json_schema,
          discovered: false
        })
        const row = models.get(ref)!
        if (m.loaded && info.hasLoaded) {
          row.loaded = true
          row.loadedBase = { family: m.family, context: row.context, maxOutput: m.max_output, extraBody: m.extra_body ?? null, jsonSchema: m.json_schema }
          this.applyServed(row)
          for (const a of m.aliases) aliasRefs.set(`${p.id}/${a}`, ref)
        }
      }
    }
    for (const a of [...aliasRefs.keys()]) if (models.has(a)) aliasRefs.delete(a) // a real row with that id wins
    this.aliasRefs = aliasRefs
    this.providers = providers
    this.models = models
    this.roles = roles.data
    this.searchOrder = prov.data.search_order
    this.modelChoices = choices
    // models picked in the Models dialog, with the price the provider listed then; providers.md wins for a model in both
    for (const m of choices.picked) {
      const p = providers.get(m.provider)
      const ref = `${m.provider}/${m.id}`
      if (!p || models.has(ref) || p.kind === 'search' || p.hasLoaded) continue // a provider with `loaded` rows adds no models
      models.set(ref, {
        ref,
        provider: p,
        id: m.id,
        family: m.family === 'unknown' ? guessFamily(m.id) : m.family,
        context: m.context,
        maxOutput: m.max_output,
        priceIn: m.price_in,
        priceOut: m.price_out,
        priceCachedIn: m.price_cached_in ?? m.price_in,
        embedding: m.embedding,
        vision: m.vision,
        extraBody: m.extra_body ?? null,
        jsonSchema: m.json_schema,
        discovered: false,
        picked: true
      })
    }
    // Keep what discovery found earlier, so a config reload does not forget it.
    for (const d of discoveredBefore) {
      const prov = this.providers.get(d.provider.id)
      if (prov && !this.models.has(d.ref) && !skipsDiscovered(prov, d.id)) this.models.set(d.ref, { ...d, provider: prov })
    }
  }

  /** A key is found for the provider's `api_key_env` (environment, credential store). */
  hasKey(p: ProviderInfo): boolean {
    return !!p.apiKeyEnv && !!(this.opts.keys ?? resolveKey)(p.apiKeyEnv)
  }

  modelsFile(): string {
    return path.join(this.dataDir, 'config', 'models.md')
  }

  /** config/models.md, or nothing picked or hidden when it is missing. An invalid file throws, so `load` keeps the previous state. */
  private async readModelChoices(): Promise<ModelsConfig> {
    let text: string
    try {
      text = await fs.readFile(this.modelsFile(), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'models', picked: [], hidden: [], limits: {} }
      throw err
    }
    return parseMdWith(text, modelsConfigSchema, this.modelsFile()).data
  }

  /** The pickers offer this model (it is not in `hidden` of config/models.md). */
  isShown(ref: string): boolean {
    return !this.modelChoices.hidden.includes(ref)
  }

  /**
   * Every chat model a provider lists (`GET /models`), whether it is in the pickers or not, for the Models dialog.
   * `pickable` is false for a paid provider's model without a listed price: the budget could not count it.
   */
  async catalog(providerId: string, signal?: AbortSignal): Promise<ListedModel[]> {
    const p = this.providers.get(providerId)
    if (!p) throw new Error(`no provider "${providerId}"`)
    if (!p.available) throw new Error(p.unavailableReason ?? 'not available')
    if (!(p.client instanceof OpenAiCompatClient)) throw new Error(`a ${p.kind} provider can't list its models here: add them to providers.md`)
    if (p.hasLoaded) {
      // its `loaded` rows stand for whatever it runs: asking only tells which model that is
      await this.noteServed(p, await p.client.listModelInfo(signal))
      return []
    }
    return (await p.client.listModelInfo(signal)).filter((m) => m.textOnly && !/embed/i.test(m.id) && !skipsDiscovered(p, m.id))
  }

  private setupClient(info: ProviderInfo, keys: KeyResolver): void {
    if (!info.enabled) {
      info.unavailableReason = 'disabled in config/providers.md'
      return
    }
    if (info.kind === 'mock') {
      info.client = this.mock
      info.available = true
      return
    }
    if (info.kind === 'search') {
      // used by the researcher, never for chat: there is no client, and the provider has no models
      if (info.apiKeyEnv && !keys(info.apiKeyEnv)) {
        info.unavailableReason = `no key (set ${info.apiKeyEnv} or run: npm run key:set ${info.apiKeyEnv})`
        return
      }
      info.available = true
      return
    }
    if (info.kind === 'client') {
      // no model, no key, no network: the request waits for an MCP client (cts_get_task / cts_submit_task)
      info.client = new ClientProvider(info.id, this.clientQueue)
      info.available = true
      return
    }
    let apiKey: string | undefined
    if (info.apiKeyEnv) {
      apiKey = keys(info.apiKeyEnv)
      if (apiKey && !this.opts.keys) {
        const from = lookupKey(info.apiKeyEnv)?.from
        if (from && from !== 'the environment' && !from.startsWith('the cartoon-studio')) info.keyFrom = from
      }
      if (!apiKey && !info.local) {
        info.unavailableReason = `no key (set ${info.apiKeyEnv} or run: npm run key:set ${info.apiKeyEnv})`
        return
      }
    }
    const fetchImpl = this.opts.fetchImpl
    if (info.kind === 'openai-compat') {
      if (!info.baseUrl) {
        info.unavailableReason = 'no base_url'
        return
      }
      info.client = new OpenAiCompatClient({
        id: info.id,
        baseUrl: info.baseUrl,
        apiKey,
        fetchImpl,
        jsonSchema: info.jsonSchema,
        loadConfig: info.loadModels ? (model) => this.loadConfigFor(info.id, model) : undefined,
        lmsPath: info.loadModels ? (this.opts.lmsPath === null ? undefined : (this.opts.lmsPath ?? defaultLmsPath())) : undefined,
        embedPrefixes: info.local ? { document: 'search_document: ', query: 'search_query: ' } : undefined
      })
    } else if (info.kind === 'anthropic') {
      info.client = new AnthropicClient({ id: info.id, baseUrl: info.baseUrl, apiKey: apiKey ?? '', fetchImpl })
    } else if (info.kind === 'gemini') {
      info.client = new GeminiClient({ id: info.id, baseUrl: info.baseUrl, apiKey: apiKey ?? '', fetchImpl })
    }
    info.available = true
  }

  /**
   * `GET /models` on every provider with `discover` set. Adds unknown models, family guessed from the id.
   * A paid provider's model is only added with the price the provider lists (`discover: free`: only at price 0), so the budget sees its cost.
   */
  async discover(signal?: AbortSignal): Promise<{ provider: string; found: number; served?: string; error?: string }[]> {
    const out: { provider: string; found: number; served?: string; error?: string }[] = []
    for (const p of this.providers.values()) {
      if (!p.discover || !p.available || !(p.client instanceof OpenAiCompatClient)) continue
      try {
        const listed = await p.client.listModelInfo(signal)
        if (p.hasLoaded) {
          // the `loaded` rows stand for the served model: discovery only finds out which one it is
          await this.noteServed(p, listed)
          out.push({ provider: p.id, found: 0, served: p.served })
          continue
        }
        const ctxLen = p.local ? await p.client.contextLengths(signal) : new Map<string, number>() // LM Studio's loaded windows
        let found = 0
        for (const m of listed) {
          const ref = `${p.id}/${m.id}`
          if (skipsDiscovered(p, m.id) || !m.textOnly) continue
          const free = !!m.price && m.price.in === 0 && m.price.out === 0
          if (p.discover === 'free' ? !free : !p.local && !m.price) continue
          found++
          if (this.models.has(ref)) continue
          this.models.set(ref, {
            ref,
            provider: p,
            id: m.id,
            family: guessFamily(m.id),
            context: m.context,
            maxOutput: m.maxOutput,
            priceIn: p.local ? 0 : (m.price?.in ?? 0),
            priceOut: p.local ? 0 : (m.price?.out ?? 0),
            priceCachedIn: p.local ? 0 : (m.price?.cachedIn ?? m.price?.in ?? 0),
            embedding: /embed/i.test(m.id),
            vision: false,
            extraBody: null,
            discovered: true
          })
        }
        // the context the model is loaded with, unless providers.md says otherwise (a model already loaded counts as it is)
        for (const [id, len] of ctxLen) {
          const m = this.models.get(`${p.id}/${id}`)
          if (m && (m.context === undefined || p.loadModels)) m.context = len
        }
        out.push({ provider: p.id, found })
      } catch (err) {
        out.push({ provider: p.id, found: 0, error: (err as Error).message })
      }
    }
    return out
  }

  /**
   * Asks every `concurrency: auto` provider how many requests it serves at once and sets its `concurrency`:
   * Strata reports it as `concurrency.serving` of `GET <base_url>/status`; for LM Studio it is the sum of `parallel`
   * over the loaded chat models (`GET /api/v1/models`, set with `lms load --parallel <n>`).
   * A server that can't be asked counts as 1 and is marked `down`, as is a Strata whose model is unloaded without `auto_load`.
   * A provider with `loaded` rows also reports its model there (`model`); the rows follow it.
   * Returns the providers whose concurrency changed (`slots`) and the ones whose served model changed (`served`).
   */
  async syncServerSlots(signal?: AbortSignal): Promise<{ slots: { provider: ProviderInfo; from: number; to: number }[]; served: { provider: ProviderInfo; from?: string; to: string }[] }> {
    const changed: { provider: ProviderInfo; from: number; to: number }[] = []
    const served: { provider: ProviderInfo; from?: string; to: string }[] = []
    for (const p of this.providers.values()) {
      if (!p.concurrencyAuto || !p.available || !p.baseUrl) continue
      const base = p.baseUrl.replace(/\/+$/, '')
      let answered = false
      let unloaded = false
      const get = async (url: string) => {
        const res = await (this.opts.fetchImpl ?? fetch)(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000) })
        answered = true
        return res.ok ? ((await res.json()) as Record<string, unknown>) : null
      }
      let slots = 1
      try {
        const status = await get(`${base}/status`).catch(() => null)
        unloaded = status?.loaded === false && status?.auto_load !== true
        if (p.hasLoaded && typeof status?.model === 'string' && status.model) {
          const c = this.setServed(p, status.model)
          if (c) served.push(c)
        }
        const n = Number((status?.concurrency as { serving?: unknown } | undefined)?.serving)
        if (Number.isInteger(n) && n >= 1) slots = Math.min(n, 16)
        else {
          // LM Studio: its native API sits next to the OpenAI-compatible /v1
          const lm = await get(`${base.replace(/\/v1$/, '')}/api/v1/models`)
          const models = (lm?.models ?? []) as { type?: string; loaded_instances?: { config?: { parallel?: unknown } }[] }[]
          let sum = 0
          for (const m of models) {
            if (m.type !== 'llm') continue
            for (const i of m.loaded_instances ?? []) {
              const par = Number(i.config?.parallel)
              sum += Number.isInteger(par) && par >= 1 ? par : 1
            }
          }
          if (sum >= 1) slots = Math.min(sum, 16)
        }
      } catch {
        /* the server is down or restarting: one at a time until it answers */
      }
      this.serverSlots.set(p.id, slots)
      p.down = !answered || unloaded
      this.serverDown.set(p.id, p.down)
      if (p.concurrency !== slots) {
        changed.push({ provider: p, from: p.concurrency, to: slots })
        p.concurrency = slots
      }
    }
    return { slots: changed, served }
  }

  /** The model a provider with `loaded` rows serves: the first entry of `GET /models` that is no alias (`alias_of`), and its `meta.n_ctx`. No such entry (nothing loaded): nothing changes. */
  private async noteServed(p: ProviderInfo, listed: ListedModel[]): Promise<void> {
    const first = listed.find((m) => !m.aliasOf)
    if (!first) return
    this.setServed(p, first.id, first.nCtx)
  }

  /** Records the served model of `p` and re-applies its profile to the `loaded` rows in place. Returns the change, or null when it is the same model. */
  private setServed(p: ProviderInfo, id: string, nCtx?: number): { provider: ProviderInfo; from?: string; to: string } | null {
    const from = this.servedIds.get(p.id)
    if (from !== id) this.servedCtx.delete(p.id)
    if (nCtx) this.servedCtx.set(p.id, nCtx)
    this.servedIds.set(p.id, id)
    p.served = id
    for (const m of this.models.values()) if (m.provider.id === p.id && m.loadedBase) this.applyServed(m)
    return from === id ? null : { provider: p, from, to: id }
  }

  /** Sets a `loaded` row's family, context, `extra_body` and JSON schema flag from the served model's profile (HUB-26 plan, C1.2 rule 3). */
  private applyServed(m: ModelInfo): void {
    const b = m.loadedBase
    if (!b) return
    const served = this.servedIds.get(m.provider.id)
    const k = served ? profileFor(m.provider.profiles, served) : undefined
    m.servedId = served
    m.family = served ? (k?.family ?? guessFamily(served)) : b.family
    m.context = served ? (k?.context ?? this.servedCtx.get(m.provider.id) ?? b.context) : b.context
    m.maxOutput = served ? (k?.max_output ?? b.maxOutput) : b.maxOutput
    const body = { ...(served ? k?.extra_body : undefined), ...b.extraBody }
    m.extraBody = Object.keys(body).length ? body : null
    m.jsonSchema = b.jsonSchema ?? (served ? k?.json_schema : undefined) ?? m.provider.jsonSchema
  }

  /** Marks a `concurrency: auto` server down at once (a request could not reach it), for every job. True when that is news. */
  markDown(p: ProviderInfo): boolean {
    if (!p.concurrencyAuto || p.down) return false
    p.down = true
    this.serverDown.set(p.id, true)
    return true
  }

  /** A model by its ref; an older ref of a `loaded` row (`strata/qwen3.8-flash-next`) finds the row. */
  getModel(ref: string): ModelInfo | undefined {
    return this.models.get(ref) ?? this.models.get(this.aliasRefs.get(ref) ?? '')
  }

  /** How a `load_models` provider loads `model`: the settings, with the model's own `load_context` / `load_parallel` over them. */
  loadConfigFor(provider: string, model: string): ModelDefaults['lmLoad'] {
    const m = this.models.get(`${provider}/${model}`)
    const d = this.defaults.lmLoad
    return { parallel: m?.loadParallel ?? d.parallel, context: m?.loadContext ?? d.context, ttlMinutes: d.ttlMinutes }
  }

  /** Sets the role aliases and the LM Studio load settings. Call `load()` after it so model context windows follow. */
  setDefaults(d: ModelDefaults): void {
    this.defaults = d
  }

  /** The fallback list, first row first. */
  fallbackRefs(): string[] {
    return this.defaults.fallbacks
  }

  /** The kind of a row or model, by its provider: the provider's id for a local or custom one (a client too), `paid` for an API provider or one that providers.md does not have. */
  private kindOfRef(ref: string): string {
    const p = this.providers.get(ref.split('/')[0]!)
    return p?.local || p?.custom ? p.id : 'paid'
  }

  /** The kind of an alias or a `provider/model`: `paid` for every API model, otherwise the provider's id. */
  kindOf(ref: string): string {
    return this.kindOfRef(this.resolve(ref))
  }

  /** What each alias stands for: a kind name is its first row, `<kind>-<n>` its n-th. */
  aliasMap(): Map<string, string> {
    const map = new Map<string, string>()
    const count = new Map<string, number>()
    for (const ref of this.defaults.fallbacks) {
      const kind = this.kindOfRef(ref)
      const n = (count.get(kind) ?? 0) + 1
      count.set(kind, n)
      if (n === 1) map.set(kind, ref)
      map.set(`${kind}-${n}`, ref)
    }
    return map
  }

  /**
   * A `provider/model`, or an alias (`paid`, `paid-2`, `strata`, `lmstudio` ...) resolved to its row. An alias with no row stays as it is.
   * An older ref of a `loaded` row (`strata/qwen3.8-flash-next`, also as a fallback row) becomes the row's ref (`strata/default`).
   */
  resolve(ref: string): string {
    const r = ref.includes('/') ? ref : (this.aliasMap().get(ref) ?? ref)
    return r.includes('/') && !this.models.has(r) ? (this.aliasRefs.get(r) ?? r) : r
  }

  /** The aliases roles.md uses that name no row of the fallback list. */
  unresolvedAliases(): string[] {
    const map = this.aliasMap()
    const out = new Set<string>()
    for (const r of Object.values(this.roles.roles)) for (const e of r.models) if (!e.includes('/') && !map.has(e)) out.add(e)
    return [...out]
  }

  /** Model refs in the roles file for a role, in order, with aliases resolved. */
  roleModelRefs(role: string): string[] {
    return this.roleEntries(role).map((r) => this.resolve(r))
  }

  /**
   * A role's list. Without `fallback_shared` it is roles.md's, aliases kept. With it, every row of the fallback list in its order, except that
   * a concrete model the role names takes the place of the first row of its kind not taken yet (a model that is itself a row keeps it; an alias
   * of the row it replaced is dropped); a model with no row of its kind, and the other aliases, follow in the role's own order, duplicates dropped. A client model the role names goes first.
   */
  roleEntries(role: string): string[] {
    const list = this.roles.roles[role]?.models ?? []
    if (!this.defaults.shared) return list
    const rows = [...this.defaults.fallbacks]
    const taken = new Set<number>()
    const isClient = (ref: string) => this.providers.get(this.resolve(ref).split('/')[0]!)?.kind === 'client'
    const placed = new Set<string>()
    const replaced = new Set<string>() // rows a role's own model took the place of
    for (const c of list) {
      if (!c.includes('/') || isClient(c)) continue
      const same = rows.findIndex((r, i) => r === c && !taken.has(i))
      const kind = this.kindOfRef(c)
      const at = same >= 0 ? same : rows.findIndex((r, i) => !taken.has(i) && this.kindOfRef(r) === kind)
      if (at < 0) continue
      if (rows[at] !== c) replaced.add(rows[at]!)
      rows[at] = c
      taken.add(at)
      placed.add(c)
    }
    const out: string[] = []
    const seen = new Set<string>()
    const add = (ref: string) => {
      const r = this.resolve(ref)
      if (seen.has(r)) return
      seen.add(r)
      out.push(r)
    }
    for (const c of list) if (isClient(c)) add(c)
    for (const r of rows) add(r)
    for (const c of list) if (!placed.has(c) && !replaced.has(this.resolve(c))) add(c)
    return out
  }

  /** The group of an alias or a `provider/model`: `paid` for a non-local seed API provider, the provider's own id for every other one (`strata`, `lmstudio`, a custom provider, `acp`), undefined for the client provider (it stays where the role put it) or an unknown one. */
  groupOf(ref: string): string | undefined {
    const provider = this.resolve(ref).split('/')[0]!
    const p = this.providers.get(provider)
    if (!p || p.kind === 'client') return undefined
    return p.custom || p.local ? p.id : 'paid'
  }

  embeddingModel(): ModelInfo | undefined {
    return this.roles.embeddings ? this.models.get(this.roles.embeddings) : undefined
  }

  /** Embeds texts with the configured embedding model. Adds the nomic prefixes for local models. */
  async embed(texts: string[], kind: 'document' | 'query', signal?: AbortSignal): Promise<number[][]> {
    const m = this.embeddingModel()
    if (!m) throw new Error('no embedding model in config/roles.md')
    const client = m.provider.client
    if (!client) throw new Error(`provider ${m.provider.id} is not available: ${m.provider.unavailableReason}`)
    if (client instanceof OpenAiCompatClient && /nomic/i.test(m.id)) return client.embedWithPrefix(m.id, texts, kind, signal)
    if (!client.embed) throw new Error(`provider ${m.provider.id} cannot embed`)
    return client.embed(m.id, texts, signal)
  }
}

/** A model the server lists but `discover_skip` keeps out (a word of it is in the id, any case). */
function skipsDiscovered(p: ProviderInfo, id: string): boolean {
  const s = id.toLowerCase()
  return p.discoverSkip.some((w) => w && s.includes(w.toLowerCase()))
}

export function guessFamily(id: string): string {
  const s = id.toLowerCase()
  for (const f of ['qwen', 'nemotron', 'poolside', 'laguna', 'deepseek', 'llama', 'mistral', 'gemma', 'gemini', 'claude', 'gpt', 'grok', 'nomic', 'glm', 'kimi']) {
    if (s.includes(f)) return f === 'laguna' ? 'poolside' : f
  }
  // OpenRouter ids start with the maker (`thinkingmachines/inkling:free`): the closest thing to a family
  return s.includes('/') ? s.slice(0, s.indexOf('/')) : 'unknown'
}
