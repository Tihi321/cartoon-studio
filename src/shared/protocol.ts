import type { Lang } from './contracts'

/**
 * Engine <-> UI protocol. The engine sends events and accepts commands.
 * A Transport carries them. Today that is the Electron utilityProcess port. Later it could be a WebSocket.
 */



export type AgentState = 'working' | 'reviewing' | 'waiting-provider' | 'waiting-research' | 'idle' | 'error' | 'paused'

/**
 * Why a model didn't answer an agent: `day-limit` (the provider's requests for today are used up), `rate-limit` (too many
 * requests now, HTTP 429), `down` (the server isn't running), `too-big` (the request doesn't fit the model's context or answer
 * budget), `no-access` (401/403: key missing or wrong), `no-credit` (402), `not-found` (404: no such model), `bad-request`
 * (another 4xx), `server` (5xx), `budget` (a paid model over a spending cap), `other`.
 */
export type ProblemKind = 'day-limit' | 'rate-limit' | 'down' | 'too-big' | 'no-access' | 'no-credit' | 'not-found' | 'bad-request' | 'server' | 'budget' | 'other'

/** The last failed request of an agent, kept until one of its requests is answered again. */
export interface AgentProblem {
  kind: ProblemKind
  /** `provider/model` that failed. */
  model: string
  /** The error, shortened. */
  message: string
  /** When it happened (ms since epoch). */
  at: number
  /** The job failed for good on it (every model of the role failed), rather than retrying or falling back. */
  failed?: boolean
}

export interface ModelSummary {
  /** `provider/model`, the id used in `setModel` and in config files. */
  ref: string
  provider: string
  model: string
  family: string
  local: boolean
  /** The kind a fallback row with this model has: `paid` for an API model, otherwise its provider's id (`strata`, `lmstudio`, `client` ...). */
  kind: string
  /** The fallback group it belongs to (`paid`, `strata`, `lmstudio`, or a provider id), see `ModelGroup`. Missing for the client provider. */
  group?: string
  /** True when the provider is switched on and usable (has a key, or is local). */
  enabled: boolean
  /** The pickers offer it: not hidden in the Models dialog (config/models.md). */
  shown: boolean
  /** Where it comes from: providers.md, the provider's own list (`discover`), or picked in the Models dialog. */
  source: 'config' | 'discovered' | 'picked'
  context?: number
  /** A `loaded` row (`strata/default`): the model the provider serves now, once it has answered. Pickers show it instead of the ref's id. */
  served?: string
  /** A `loaded` row: its thinking level (`reasoning_effort` of its `extra_body`), shown as "thinking low" unless `none`. */
  thinking?: string
  /** Accepts images (a vision model). */
  vision: boolean
  /** USD per 1M tokens. */
  priceIn: number
  priceOut: number
}

/** A model provider for the Models dialog (search services are left out). */
export interface ProviderSummary {
  id: string
  /** The name shown on screen (`name` in providers.md), else the id. */
  name: string
  kind: string
  local: boolean
  /** Added in the Add provider form: it can be edited and removed there. */
  custom: boolean
  /** Switched on in providers.md (it may still be unavailable: no key). */
  enabled: boolean
  baseUrl?: string
  /** Sends the JSON schema as `response_format`. */
  jsonSchema: boolean
  /** The key variable (`api_key_env`), and whether a key was found for it. */
  keyName?: string
  keySet: boolean
  /** Switched on and usable (has a key, or is local). */
  available: boolean
  /** Why it isn't available: switched off, or no key. */
  reason?: string
  /** The key comes from another tool's credential store (for example the credential store of a sibling tool). */
  keyFrom?: string
  /** It can list its models (`GET /models`, OpenAI-style providers). */
  canList: boolean
  /** Has `loaded` rows (Strata): they stand for the model it runs, `served`. */
  followsServer: boolean
  /** The model it ran when last asked (kept while it is down). */
  served?: string
  /** Requests at once. With `concurrencyAuto` the server sets it (Strata, LM Studio), so it can't be changed here. */
  concurrency: number
  concurrencyAuto: boolean
  /** Requests per minute and per day; missing means no limit. */
  rpm?: number
  rpd?: number
  /** Requests sent since midnight UTC, when daily limits start again. */
  requestsToday: number
  /** The daily limit is used up: its jobs use their next model until `dayResetsAt` (epoch ms). */
  dayFull: boolean
  dayResetsAt: number
}

/** A model a provider lists, from `detectModels`. */
export interface CatalogModel {
  id: string
  /** `provider/model`. */
  ref: string
  context?: number
  /** USD per 1M tokens, when the provider lists prices. */
  priceIn?: number
  priceOut?: number
  /** It can be shown in the pickers: local, or with a listed price (a paid model the budget can't price never is). */
  pickable: boolean
}

/** A local model server the engine checks (Strata, LM Studio): running or not, and how many requests it serves at once. */
export interface ServerStatus {
  /** Provider id: `strata`, `lmstudio`. */
  id: string
  down: boolean
  slots: number
  /** The model the server runs (last seen, also while it is down). Only for a provider with `loaded` rows. */
  served?: string
}

export interface AgentSummary {
  id: string
  name: string
  role: string
  /** The agent's own override (`provider/model`), or null. */
  model: string | null
  /** The model its running job calls now, else what it will use for its next job: the override, else the role default (first usable model). */
  resolvedModel: string | null
  /** The project the agent is assigned to (`pin` in its file): it only takes that project's jobs. Null when it takes any job. */
  pin: string | null
  paused: boolean
  state: AgentState
  /** What it is doing now, when it has a job. */
  task?: string
  /** The project of the job it works on. */
  book?: string
  jobId?: string
  /** Its last request failed and none has been answered since. */
  problem?: AgentProblem
}

export interface SettingsSummary {
  /** `fallbacks` in settings.md: `provider/model` refs, first row first. A kind name (`paid`, `strata` ...) stands for the first row of that kind, `<kind>-<n>` for the n-th. */
  fallbacks: string[]
  /** `fallback_shared`: every role tries the rows top to bottom. False: each role keeps its own list from roles.md. */
  fallbackShared: boolean
  /** `provider/model` behind each role alias, per group: kept for compatibility */
  groupDefaults?: Record<string, string>
  /** `model_order` in settings.md: kept for compatibility */
  modelOrder?: ModelGroup[]
  /** How the engine loads LM Studio models: requests at once, context window, idle minutes before unloading. */
  lmstudioParallel: number
  lmstudioContext: number
  lmstudioTtlMinutes: number
}

/** A fallback group: `paid` (every non-local seed API provider), or a provider id (`strata`, `lmstudio`, `acp`, a custom provider). */
export type ModelGroup = string

export interface SnapshotEvent {
  type: 'snapshot'
  dataDir: string
  uptimeMs: number
  /** Pause all. */
  paused: boolean
  agents: AgentSummary[]
  /** Every chat model the engine knows, including the LM Studio models found on this machine. The pickers offer the `shown` ones. */
  models: ModelSummary[]
  providers: ProviderSummary[]
  /** Role -> `provider/model` of the role default (first in the role's list). */
  roleDefaults: Record<string, string>
  servers: ServerStatus[]
  spend: { today: number; month: number; dailyCap: number; monthlyCap: number }
  running: { jobId: string; agent: string }[]
  settings: SettingsSummary
  /** Names of secrets that are set (never their values): the provider key variables. */
  secretsSet: string[]
  /** Every key variable the app may store (`api_key_env` of the providers), for the Settings key select. */
  keyNames: string[]
  at: string
}

export type EngineEvent =
  | { type: 'engine.ready'; pid: number; dataDir: string; at: string }
  | { type: 'engine.heartbeat'; n: number; at: string; uptimeMs: number }
  | { type: 'pong'; id?: string; at: string }
  | SnapshotEvent
  | { type: 'engine.warning'; message: string }
  | { type: 'agent.state'; agent: string; role: string; state: AgentState; jobId?: string; task?: string; book?: string }
  | { type: 'agent.hired'; agent: AgentSummary }
  | { type: 'agent.removed'; agent: string }
  /** An agent's file changed (its model, paused, ...). */
  | { type: 'agent.updated'; agent: AgentSummary }
  | { type: 'factory.paused'; paused: boolean }
  | { type: 'job.started'; jobId: string; agent: string; task: string; book?: string; model?: string }
  /** A request of the agent failed (`problem`), or one was answered again after that (`null`). */
  | { type: 'agent.problem'; agent: string; problem: AgentProblem | null }
  /** The job moved to another model (a fallback after a failure), so the office shows the one answering now. */
  | { type: 'job.model'; jobId: string; agent: string; model: string }
  | { type: 'job.token'; jobId: string; agent: string; text: string }
  /** A local model server went down, came back or changed its slot count. */
  | { type: 'servers'; servers: ServerStatus[] }
  | { type: 'job.done'; jobId: string; agent: string; ok: boolean; result?: string; error?: string }
  /** A job asked by another agent (or you) starts or ends: who handed it to whom. */
  | { type: 'handover'; from: string; to: string; label: string; jobId?: string; done?: boolean }
  | {
      type: 'spend'
      provider: string
      model: string
      /** A `loaded` row (`strata/default`): the model that answered. */
      served?: string
      tokensIn: number
      tokensOut: number
      costUsd: number
      agent?: string
      book?: string
    }
  | { type: 'secrets.updated'; secretsSet: string[]; keyNames?: string[] }
  /** The answer to `testCustomProvider`: `GET /models` worked (`count` models) or failed (`error`). */
  | { type: 'provider.tested'; ok: boolean; count?: number; error?: string; at: string }
  /** The answer to `saveCustomProvider` and `removeCustomProvider`: done, or why it was refused. */
  | { type: 'provider.saved'; ok: boolean; id?: string; removed?: boolean; error?: string }
  /** The answer to `detectModels`: every chat model the provider lists, or why it couldn't be asked. */
  | { type: 'models.catalog'; provider: string; models: CatalogModel[]; error?: string; at: string }
  // ---- series ----
  /** A command failed (bad slug, missing file ...). `slug` is set when the command was about a series. */
  | { type: 'command.error'; command: string; message: string; slug?: string }
  /** The answer to `listSeries`. */
  | { type: 'series.listed'; series: SeriesSummaryView[] }
  /** ComfyUI, flow-music-mcp and VibeTTS: reachable or not. The answer to `studiosStatus`. */
  | { type: 'studios.status'; studios: StudioStatusView[] }
  /** The MCP HTTP server (config/mcp.md): listening or not. Sent when it changes and as the answer to `mcpStatus` and `saveMcpConfig`. `error` is empty when there is none; `token` is never sent, only whether one is set. */
  | { type: 'mcp.status'; enabled: boolean; listening: boolean; url: string | null; error: string; port: number; tokenSet: boolean }
  // ---- studio UI (CTS-09) ----
  | ToolResultEvent
  | VoiceClipEvent
  | JobProgressEvent
  /** The pipeline of a series changed state (for example `waiting-on-user` after the pitches, `running` once the user chose one). */
  | { type: 'series.state'; series: string; episode?: string; state: SeriesRunState; step?: string }
  /** A pitch was chosen (`cts_pitch_choose` or the Series view): the pipeline leaves `waiting-on-user`. */
  | { type: 'pitch.chosen'; series: string; pitch: string }

/** How a voice line stands, as the studio shows it. `ok`/`placeholder`/`failed` are the manifest's statuses (VOICE_STATUSES); `pending` (not asked yet) and `running` (being made) only live in the UI. */
export type VoiceLineStatus = 'pending' | 'running' | 'ok' | 'placeholder' | 'failed'

/** The run state of a series' pipeline (PIPELINE_RUN_STATES in contracts.ts). */
export type SeriesRunState = 'idle' | 'running' | 'waiting-on-user' | 'waiting-on-client' | 'failed' | 'done'

/**
 * Events the UI reduces beyond the core ones. The engine modules that own them emit them (voice step: `voice.clip`; queue and render: `job.progress`;
 * pipeline: `series.state`, `pitch.chosen`). Defined here by CTS-09 so the UI and its tests agree on the shapes.
 */
export interface VoiceClipEvent {
  type: 'voice.clip'
  series: string
  episode: string
  lang: Lang
  /** The script line id (`l01`). */
  line: string
  status: VoiceLineStatus
  /** `comfy`, `vibetts`, `gemini`, `placeholder` ... */
  provider?: string
  seconds?: number
  /** Relative to the episode folder, like the manifest's `file`. */
  file?: string
  error?: string
}

export interface JobProgressEvent {
  type: 'job.progress'
  jobId: string
  series: string
  /** `voice`, `render`, `image` ... */
  task: string
  unit?: string
  /** 0..1, or null when the job cannot tell. */
  fraction: number | null
  message?: string
  episode?: string
  /** Set by the voice step for the clip it is making now: the line shows as `running` until its `voice.clip` comes. */
  lang?: Lang
  line?: string
}

/** The answer to a `call` command: the result of the MCP tool. */
export interface ToolResultEvent {
  type: 'tool.result'
  id: string
  tool: string
  ok: boolean
  /** The tool's structured result (an object; a non-object result is wrapped as `{result}`). */
  result?: Record<string, unknown>
  error?: string
}

/** One service (ComfyUI, flow-music-mcp, VibeTTS) as `studiosStatus` saw it. For VibeTTS `tools` is the number of voices it lists. */
export interface StudioStatusView {
  id: 'comfy' | 'flow' | 'vibetts'
  name: string
  ok: boolean
  url: string
  /** Why it is not reachable (includes how to start it). */
  error: string
  /** The app folder from config/studios.md. */
  repo: string
  /** How to start it headless. */
  hint: string
  /** The number of tools it offers, when reachable. */
  tools: number
}

/** One line of the series list. */
export interface SeriesSummaryView {
  slug: string
  title: string
  updatedAt: string
}

export type EngineEventType = EngineEvent['type']

export type Command =
  | { type: 'hire'; role: string; name?: string; model?: string }
  | { type: 'fire'; agent: string; now?: boolean }
  | { type: 'pause'; agent: string }
  | { type: 'resume'; agent: string }
  | { type: 'stop'; agent: string }
  | { type: 'pauseAll' }
  | { type: 'resumeAll' }
  | { type: 'stopNow' }
  /** `model: null` with an `agent` clears that agent's override. */
  | { type: 'setModel'; model: string | null; agent?: string; role?: string }
  /** Asks a provider for every model it has (`GET /models`). Answers with `models.catalog`. */
  | { type: 'detectModels'; provider: string }
  /** Shows models in the pickers, or hides them (config/models.md). A listed model that isn't known yet is added with its listed price. */
  | { type: 'showModels'; refs: string[]; shown: boolean }
  /** Adds a model by its id to `picked` in config/models.md, for one the provider doesn't list. A paid provider needs both prices (USD per 1M tokens, 0 for free). */
  | { type: 'addModel'; provider: string; id: string; priceIn?: number; priceOut?: number; context?: number; vision?: boolean }
  /**
   * Adds a provider to config/providers.md (`custom: true`), or edits the custom provider `id`. The key goes to the credential store (an empty
   * `apiKey` on an edit keeps the stored one). `free`: a local, keyless provider with no budget. Answers with `provider.saved`.
   */
  | { type: 'saveCustomProvider'; id?: string; name: string; baseUrl: string; apiKey?: string; free: boolean; jsonSchema: boolean; concurrency: number | 'auto'; enabled: boolean }
  /** Removes a custom provider, its stored key, and what config/models.md and config/settings.md say about it. Answers with `provider.saved`. */
  | { type: 'removeCustomProvider'; id: string }
  /** Calls `GET <baseUrl>/models` to see whether the server answers. `id`: an edited provider, whose stored key is used when `apiKey` is empty. Answers with `provider.tested`. */
  | { type: 'testCustomProvider'; baseUrl: string; apiKey?: string; id?: string }
  /**
   * Sets a provider's limits in config/models.md, over providers.md: requests at once (not for a server that reports its own),
   * per minute and per day. 0 for `rpm` or `rpd` means no limit; a field left out keeps its value.
   */
  | { type: 'setProviderLimits'; provider: string; concurrency?: number; rpm?: number; rpd?: number }
  /** Any of the settings may be left out: they keep their value. */
  | ({ type: 'saveSettings' } & Partial<SettingsSummary>)
  /** Stores a secret in the Windows credential store. Only the provider key variables are allowed. */
  | { type: 'setSecret'; name: string; value: string }
  | { type: 'snapshot' }
  | { type: 'ping'; id?: string }
  /** Check the local model servers now (Strata was just started), instead of at the next 10-second check. */
  | { type: 'checkServers' }
  // ---- series ----
  /** The series in the data folder. Answers with `series.listed`. */
  | { type: 'listSeries' }
  /** Checks ComfyUI, flow-music-mcp and VibeTTS. Answers with `studios.status`. */
  | { type: 'studiosStatus' }
  /** Asks for the state of the MCP server. Answers with `mcp.status`. */
  | { type: 'mcpStatus' }
  /** Writes config/mcp.md and restarts the server when enabled, port or token changed. `token` left out keeps the old one, `''` clears it. Answers with `mcp.status`. */
  | { type: 'saveMcpConfig'; enabled: boolean; port: number; token?: string }
  /** Runs any MCP tool (`cts_*`) like the MCP server does and answers with `tool.result` carrying the same `id`. The studio's one generic route to the engine. */
  | { type: 'call'; id: string; tool: string; args?: Record<string, unknown> }
  /** Removes a stored provider key from the Windows credential store (never reads it back). */
  | { type: 'clearSecret'; name: string }
/** The commands about series and generators (handled by `CtsService`). */
export type ServiceCommand = Extract<Command, { type: 'listSeries' | 'studiosStatus' }>

export type CommandType = Command['type']

/** Every command type, as an object so the compiler fails when a new command is not listed (main drops unlisted ones). */
const COMMAND_TYPE_SET: Record<CommandType, true> = {
  hire: true,
  fire: true,
  pause: true,
  resume: true,
  stop: true,
  pauseAll: true,
  resumeAll: true,
  stopNow: true,
  setModel: true,
  checkServers: true,
  listSeries: true,
  studiosStatus: true,
  mcpStatus: true,
  saveMcpConfig: true,
  call: true,
  clearSecret: true,
  saveSettings: true,
  setSecret: true,
  detectModels: true,
  showModels: true,
  addModel: true,
  saveCustomProvider: true,
  removeCustomProvider: true,
  testCustomProvider: true,
  setProviderLimits: true,
  snapshot: true,
  ping: true
}

export const COMMAND_TYPES: readonly CommandType[] = Object.keys(COMMAND_TYPE_SET) as CommandType[]

export function isCommand(value: unknown): value is Command {
  if (typeof value !== 'object' || value === null) return false
  const type = (value as { type?: unknown }).type
  return typeof type === 'string' && (COMMAND_TYPES as readonly string[]).includes(type)
}

/** One end of a link: sends `Out` messages and receives `In` messages. */
export interface Transport<Out, In> {
  send(message: Out): void
  /** Returns an unsubscribe function. */
  onMessage(handler: (message: In) => void): () => void
  close(): void
}

/** The engine's end of the link. The UI's end is the mirror: Transport<Command, EngineEvent>. */
export type EngineTransport = Transport<EngineEvent, Command>

/** What the preload script exposes to the renderer as `window.cartoonstudio`. */
export interface CartoonStudioApi {
  on(handler: (event: EngineEvent) => void): () => void
  send(command: Command): void
  /** Runs an MCP tool in the engine (the same `callTool` the MCP server uses). Resolves with the tool's result, or `ok: false` with the reason. */
  call(tool: string, args?: Record<string, unknown>): Promise<ToolCallResult>
}

/** What `window.cartoonstudio.call` resolves with. */
export interface ToolCallResult {
  ok: boolean
  result?: Record<string, unknown>
  error?: string
}
