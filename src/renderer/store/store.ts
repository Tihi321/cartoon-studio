import { createStore } from 'zustand/vanilla'
import { initialEpisode, reduceEpisode, seedVoice, type EpisodeData, type LineVoice } from './episode'
import { initialMcp, reduceMcp, type McpData } from './mcp'
import { initialSeries, reduceSeries, type SeriesData } from './series'
import { applyScheme, readScheme, type Scheme } from '../lib/scheme'
import type { Lang } from '../../shared/contracts'
import type { AgentProblem, AgentState, AgentSummary, CatalogModel, EngineEvent, ModelSummary, ProviderSummary, ServerStatus, SettingsSummary, StudioStatusView } from '../../shared/protocol'

export type Page = 'series' | 'cast' | 'sets' | 'episode' | 'preview' | 'render' | 'tasks' | 'settings' | 'models' | 'agents'

/** The eight views of the studio, in the order of the work, then the engine pages inherited from the scaffold. */
export const PAGES: { id: Page; label: string; group: 'studio' | 'engine' }[] = [
  { id: 'series', label: 'Series and bible', group: 'studio' },
  { id: 'cast', label: 'Cast', group: 'studio' },
  { id: 'sets', label: 'Sets', group: 'studio' },
  { id: 'episode', label: 'Episode', group: 'studio' },
  { id: 'preview', label: 'Timeline preview', group: 'studio' },
  { id: 'render', label: 'Render and jobs', group: 'studio' },
  { id: 'tasks', label: 'Client tasks', group: 'studio' },
  { id: 'settings', label: 'Settings', group: 'studio' },
  { id: 'models', label: 'Models', group: 'engine' },
  { id: 'agents', label: 'Agents', group: 'engine' }
]

/** Which series and episode the views show (the pickers in the rail). */
export interface Selection {
  series: string | null
  episode: string | null
  cast: string | null
  set: string | null
}

export interface AgentView {
  id: string
  name: string
  role: string
  /** The agent's own override (`provider/model`), or null. */
  override: string | null
  /** The model it calls now or will call next. */
  model: string | null
  state: AgentState
  paused: boolean
  task?: string
  /** The series of the job it works on. */
  book?: string
  jobId?: string
  problem?: AgentProblem
}

export interface CtsState extends SeriesData, McpData, EpisodeData {
  selection: Selection
  connected: boolean
  dataDir: string
  paused: boolean
  warnings: string[]
  agents: Record<string, AgentView>
  agentOrder: string[]
  spend: { today: number; month: number; dailyCap: number; monthlyCap: number }
  /** Every model the engine knows, from the snapshot. The pickers offer the `shown` ones. */
  models: ModelSummary[]
  providers: ProviderSummary[]
  /** What each provider listed on the Models page (`detectModels`), or why it couldn't. `loading` until it answers. */
  catalogs: Record<string, { models: CatalogModel[]; error?: string; at?: string; loading?: boolean }>
  roleDefaults: Record<string, string>
  /** The local model servers (Strata, LM Studio): running or not. */
  servers: ServerStatus[]
  /** ComfyUI, flow-music-mcp and VibeTTS: reachable or not (the last `studios.status`). */
  studios: StudioStatusView[]
  settings: SettingsSummary | null
  secretsSet: string[]
  /** Every key variable the Settings key select offers (from the providers). */
  keyNames: string[]
  /** The last answer to `testCustomProvider` in the Add provider form: `pending` until it comes. */
  providerTest: { pending?: boolean; ok?: boolean; count?: number; error?: string } | null
  /** The last answer to `saveCustomProvider` / `removeCustomProvider`: `at` changes with every answer. */
  providerSaved: { ok: boolean; id?: string; removed?: boolean; error?: string; at: number } | null
  page: Page
  scheme: Scheme
}

export interface CtsActions {
  applyEvents(events: EngineEvent[]): void
  setPage(page: Page): void
  /** Chooses the series, episode, cast member or set the views show; choosing another series clears the rest. */
  select(patch: Partial<Selection>): void
  /** Puts the voice status of an episode's lines (read from its manifests) into the state. */
  seedVoice(series: string, episode: string, lang: Lang, lines: Record<string, LineVoice>): void
  setScheme(scheme: Scheme): void
  /** The Models page asked a provider for its models: show it as loading until `models.catalog` comes. */
  markCatalogLoading(provider: string): void
  /** The Add provider form pressed Test: show it as pending until `provider.tested` comes. `null` clears the result. */
  markProviderTesting(pending: boolean): void
}

export type CtsStore = CtsState & CtsActions

function initial(): CtsState {
  return {
    connected: false,
    dataDir: '',
    paused: false,
    warnings: [],
    agents: {},
    agentOrder: [],
    spend: { today: 0, month: 0, dailyCap: 0, monthlyCap: 0 },
    models: [],
    providers: [],
    catalogs: {},
    roleDefaults: {},
    servers: [],
    studios: [],
    settings: null,
    secretsSet: [],
    keyNames: [],
    providerTest: null,
    providerSaved: null,
    page: 'series',
    scheme: readScheme(),
    selection: { series: null, episode: null, cast: null, set: null },
    ...initialEpisode(),
    ...initialSeries(),
    ...initialMcp()
  }
}

function agentFromSummary(a: AgentSummary): AgentView {
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    override: a.model,
    model: a.resolvedModel ?? a.model,
    state: a.paused ? 'paused' : a.state,
    paused: a.paused,
    task: a.task,
    book: a.book,
    jobId: a.jobId,
    problem: a.problem
  }
}

export function reduceEvent(s: CtsState, e: EngineEvent): Partial<CtsState> {
  switch (e.type) {
    case 'engine.ready':
      return { connected: true, dataDir: e.dataDir }
    case 'engine.heartbeat':
      return { connected: true }
    case 'engine.warning':
      return { warnings: [...s.warnings.slice(-19), e.message] }
    case 'snapshot': {
      const agents: Record<string, AgentView> = {}
      for (const a of e.agents) agents[a.id] = agentFromSummary(a)
      return {
        connected: true,
        dataDir: e.dataDir,
        paused: e.paused,
        agents,
        agentOrder: e.agents.map((a) => a.id),
        spend: e.spend,
        models: e.models,
        providers: e.providers ?? [],
        roleDefaults: e.roleDefaults,
        servers: e.servers ?? [],
        settings: e.settings,
        secretsSet: e.secretsSet,
        keyNames: e.keyNames ?? s.keyNames
      }
    }
    case 'agent.hired':
    case 'agent.updated': {
      const had = !!s.agents[e.agent.id]
      return { agents: { ...s.agents, [e.agent.id]: agentFromSummary(e.agent) }, agentOrder: had ? s.agentOrder : [...s.agentOrder, e.agent.id] }
    }
    case 'agent.removed': {
      const { [e.agent]: _gone, ...rest } = s.agents
      return { agents: rest, agentOrder: s.agentOrder.filter((id) => id !== e.agent) }
    }
    case 'agent.state': {
      const prev = s.agents[e.agent]
      if (!prev) return {}
      return { agents: { ...s.agents, [e.agent]: { ...prev, state: e.state, task: e.task, book: e.book, jobId: e.jobId } } }
    }
    case 'agent.problem': {
      const prev = s.agents[e.agent]
      return prev ? { agents: { ...s.agents, [e.agent]: { ...prev, problem: e.problem ?? undefined } } } : {}
    }
    case 'factory.paused':
      return { paused: e.paused }
    case 'servers':
      return { servers: e.servers }
    case 'secrets.updated':
      return { secretsSet: e.secretsSet, keyNames: e.keyNames ?? s.keyNames }
    case 'provider.tested':
      return { providerTest: { ok: e.ok, count: e.count, error: e.error } }
    case 'provider.saved':
      return { providerSaved: { ok: e.ok, id: e.id, removed: e.removed, error: e.error, at: Date.now() } }
    case 'models.catalog':
      return { catalogs: { ...s.catalogs, [e.provider]: { models: e.models, error: e.error, at: e.at } } }
    case 'studios.status':
      return { studios: e.studios }
    case 'mcp.status':
      return reduceMcp(s, e)
    default:
      return { ...reduceSeries(s, e), ...reduceEpisode(s, e) }
  }
}

const ACTION_KEYS = ['applyEvents', 'setPage', 'select', 'seedVoice', 'setScheme', 'markCatalogLoading', 'markProviderTesting'] as const

export const ctsStore = createStore<CtsStore>()((set, get) => ({
  ...initial(),
  applyEvents(events) {
    if (!events.length) return
    let next: CtsState = get()
    for (const e of events) next = { ...next, ...reduceEvent(next, e) }
    const state: Record<string, unknown> = { ...next }
    for (const k of ACTION_KEYS) delete state[k]
    set(state as unknown as CtsState)
  },
  setPage(page) {
    set({ page })
  },
  select(patch) {
    const cur = get().selection
    const next = { ...cur, ...patch }
    if (patch.series !== undefined && patch.series !== cur.series) {
      if (patch.episode === undefined) next.episode = null
      if (patch.cast === undefined) next.cast = null
      if (patch.set === undefined) next.set = null
    }
    set({ selection: next })
  },
  seedVoice(series, episode, lang, lines) {
    set(seedVoice(get(), series, episode, lang, lines))
  },
  setScheme(scheme) {
    applyScheme(scheme)
    set({ scheme })
  },
  markProviderTesting(pending) {
    set({ providerTest: pending ? { pending: true } : null })
  },
  markCatalogLoading(provider) {
    const cur = get().catalogs[provider] ?? { models: [] }
    set({ catalogs: { ...get().catalogs, [provider]: { ...cur, loading: true, error: undefined } } })
  }
}))
