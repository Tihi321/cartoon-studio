import { z } from 'zod'
import type { ZodType } from 'zod'

/**
 * Frontmatter schemas, one per file kind. 
 * Config files carry a `kind` field, so a file says what it is.
 * Unknown fields are kept (loose), so you can add your own notes to a file.
 */

/** Any markdown file with a frontmatter mapping. */
export const genericSchema = z.looseObject({})

const configBase = <K extends string>(kind: K) => z.looseObject({ kind: z.literal(kind) })

export const budgetSchema = configBase('budget').extend({
  monthly_cap_usd: z.number().nonnegative(),
  daily_cap_usd: z.number().nonnegative(),
  per_book_cap_usd: z.number().nonnegative().nullable().default(null),
  /** Fraction of a cap at which a warning is shown. */
  warn_at: z.number().min(0).max(1).default(0.8),
  /** Paid voice providers: the most one production may spend on them (USD). 0: no paid voice call is made. */
  voice: z.looseObject({ paidMaxUsd: z.number().nonnegative().default(0) }).default({ paidMaxUsd: 0 })
})

// ---- providers ----

export const providerModelSchema = z.looseObject({
  id: z.string().min(1),
  family: z.string().default('unknown'),
  context: z.number().int().positive().optional(),
  max_output: z.number().int().positive().optional(),
  /** USD per 1M tokens. */
  price_in: z.number().nonnegative().default(0),
  price_out: z.number().nonnegative().default(0),
  /** USD per 1M cached input tokens. Falls back to price_in when missing. */
  price_cached_in: z.number().nonnegative().optional(),
  embedding: z.boolean().default(false),
  /** The model accepts images in a message (a vision model). The art-critic is only offered these. */
  vision: z.boolean().default(false),
  /** Extra JSON fields merged into the request body for this model (for example to switch thinking off). */
  extra_body: z.record(z.string(), z.unknown()).nullable().optional(),
  /** `load_models` providers (LM Studio): load this model with this context window and parallel count instead of the settings' ones. */
  load_context: z.number().int().min(2048).optional(),
  load_parallel: z.number().int().min(1).max(16).optional(),
  /**
   * A ref that stands for whatever model the server has loaded (Strata: `default`, `default-low`). Its family, context and extra_body
   * follow the model the server reports (see `profiles` of the provider). Only works on a provider with `discover: true`.
   */
  loaded: z.boolean().default(false),
  /** Older ids of this row: `provider/<alias>` resolves to it. Not listed as models. */
  aliases: z.array(z.string()).default([]),
  /** Overrides the provider's `json_schema` for this model. */
  json_schema: z.boolean().optional()
})

/** Settings for a model a provider with `loaded` rows may run, matched by id (the whole id, else the longest prefix). Not a ref, not in the pickers. */
export const providerProfileSchema = z.looseObject({
  id: z.string().min(1),
  family: z.string().optional(),
  context: z.number().int().positive().optional(),
  max_output: z.number().int().positive().optional(),
  json_schema: z.boolean().optional(),
  extra_body: z.record(z.string(), z.unknown()).nullable().optional(),
  tools: z.boolean().optional(),
  vision: z.boolean().optional()
})

export const providerEntrySchema = z.looseObject({
  id: z.string().min(1),
  kind: z.enum(['openai-compat', 'anthropic', 'gemini', 'mock', 'search', 'client']),
  /** The name shown in the UI (the id when missing). */
  name: z.string().optional(),
  /** Added in the Models page's Add provider form: the form may edit and remove it. A custom provider is its own group in the fallback order. */
  custom: z.boolean().default(false),
  enabled: z.boolean().default(true),
  local: z.boolean().default(false),
  base_url: z.string().optional(),
  api_key_env: z.string().optional(),
  /**
   * How many requests may run at once. `auto`: as many as the server says it serves (`concurrency.serving` of
   * `GET <base_url>/status`, the Strata status), checked every few seconds; 1 while the server can't be asked.
   */
  concurrency: z.union([z.number().int().positive(), z.literal('auto')]).default(4),
  /** `kind: search` only: which search service this entry talks to (tavily, wikipedia, brave, serpapi, serphouse, duckduckgo). Defaults to the id. */
  engine: z.string().optional(),
  /** `kind: search` only: USD per request, logged to the spend files. */
  price_per_request: z.number().nonnegative().default(0),
  /** `engine: client` only: minutes a web search task may wait for an MCP client to take it, before the next search provider is tried. Default 10. */
  wait_minutes: z.number().positive().optional(),
  rpm: z.number().int().positive().optional(),
  tpm: z.number().int().positive().optional(),
  /**
   * Requests per day, counted from midnight UTC (OpenRouter's free models: 50, or 1000 after buying 10 credits). A provider that
   * reached it is skipped until the next midnight UTC: its jobs go to the next model in their role.
   */
  rpd: z.number().int().positive().optional(),
  /**
   * Ask the provider which models it has (GET /v1/models) and add the unknown ones. `free`: only the ones it lists at price 0
   * (OpenRouter's `:free` models). A paid provider's model that comes without a price is never added, so the budget always sees its cost.
   */
  discover: z.union([z.boolean(), z.literal('free')]).default(false),
  /** Discovery leaves out models whose id contains one of these words (any case), for example `dflash`. */
  discover_skip: z.array(z.string()).default([]),
  /** Send the JSON schema as `response_format`. Set false for servers that reject a bad JSON answer (502) instead of constraining it: the prompt and the repair step handle the JSON then. */
  json_schema: z.boolean().default(true),
  /** LM Studio: the engine loads a model that isn't loaded yet itself, with the parallel, context and idle time from config/settings.md. */
  load_models: z.boolean().default(false),
  models: z.array(providerModelSchema).default([]),
  /** Settings per model the server may run, for the `loaded` rows of `models` (see `providerProfileSchema`). */
  profiles: z.array(providerProfileSchema).default([])
})

/**
 * config/models.md: which models the pickers offer, set in the app's Models dialog. `picked`: models a provider lists that are
 * not in providers.md, with the price it listed when you picked them. `hidden`: `provider/model` refs the pickers leave out.
 */
export const modelsConfigSchema = configBase('models').extend({
  picked: z.array(providerModelSchema.extend({ provider: z.string().min(1) })).default([]),
  hidden: z.array(z.string()).default([]),
  /**
   * Per provider id: limits set in the Models panel, over the ones in providers.md. `concurrency`: requests at once (not for a
   * `concurrency: auto` server). `rpm`, `rpd`: requests per minute and per day; 0 means no limit.
   */
  limits: z
    .record(
      z.string(),
      z.object({
        concurrency: z.number().int().positive().optional(),
        rpm: z.number().int().nonnegative().optional(),
        rpd: z.number().int().nonnegative().optional()
      })
    )
    .default({})
})

export const providersSchema = configBase('providers').extend({
  providers: z.array(providerEntrySchema).default([]),
  /** The researcher tries the `kind: search` providers in this order (ids). Providers not listed come after, in file order. */
  search_order: z.array(z.string()).default([])
})

// ---- roles ----

export const rolesSchema = configBase('roles').extend({
  /** Per role: ordered model list, `provider/model` or an alias (`paid`, `strata`, `lmstudio`: the defaults in config/settings.md). The first one is the default, the rest are fallbacks. */
  roles: z.record(z.string(), z.looseObject({ models: z.array(z.string()).default([]) })).default({}),
  /** `provider/model` used for embeddings (not used by Cartoon Studio, kept for the model layer). */
  embeddings: z.string().optional()
})

// ---- factory ----

export const factorySchema = configBase('factory').extend({
  /** Persisted "pause all": no new jobs start while true. */
  paused: z.boolean().default(false),
  /** Attempts before a job moves to failed/. */
  max_attempts: z.number().int().positive().default(3)
})

// ---- settings ----

export const BUILTIN_FALLBACKS = [
  'client/claude-code',
  'strata/default',
  'lmstudio/gemma-4-e4b-it'
]

/** The built-in defaults behind the `paid`, `strata` and `lmstudio` aliases. */
export const BUILTIN_GROUP_DEFAULTS: Record<string, string> = {
  paid: 'deepseek/deepseek-flash',
  strata: 'strata/default',
  lmstudio: 'lmstudio/gemma-4-e4b-it'
}

const baseSettingsSchema = configBase('settings').extend({
  /**
   * The fallback list: `provider/model` refs, first row first, at least one. A row's kind comes from its provider (`paid` for an API
   * provider, otherwise the provider's id). A kind name in roles.md (`paid`, `strata`, `lmstudio`, `client` ...) stands for the first row of
   * that kind, `<kind>-<n>` for the n-th.
   */
  fallbacks: z.array(z.string().min(1)).min(1).default(BUILTIN_FALLBACKS),
  /** One fallback order for every role: the rows top to bottom. False: each role keeps the order of its list in roles.md. */
  fallback_shared: z.boolean().default(false),
  /**
   * What the role aliases in roles.md stand for, per group: `paid`, `strata`, `lmstudio` and the id of every other provider group
   * (a custom provider, `acp`), each a `provider/model`. Kept for backwards compatibility.
   */
  group_defaults: z.record(z.string(), z.string()).optional(),
  /** The settings of before `group_defaults`: still read (`group_defaults` wins), never written again. */
  default_paid_model: z.string().optional(),
  default_strata_model: z.string().optional(),
  default_lmstudio_model: z.string().optional(),
  /** One fallback order for every role: the groups (`paid` = any API model, `strata`, `lmstudio`, a provider id), first one first. */
  model_order: z.array(z.string()).optional(),
  /** How the engine loads LM Studio models that aren't loaded yet: requests at once, context window, idle minutes before LM Studio unloads it. */
  lmstudio_parallel: z.number().int().min(1).max(16).default(4),
  lmstudio_context: z.number().int().min(2048).default(131072),
  lmstudio_ttl_minutes: z.number().int().min(1).default(60)
})

export const settingsSchema = z.preprocess((val) => {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const raw = val as Record<string, unknown>
    if (raw.fallbacks === undefined && (raw.group_defaults || raw.default_paid_model || raw.default_strata_model || raw.default_lmstudio_model || raw.model_order)) {
      const gd = (raw.group_defaults && typeof raw.group_defaults === 'object' ? raw.group_defaults : {}) as Record<string, string>
      const paid = typeof raw.default_paid_model === 'string' && raw.default_paid_model.trim() ? raw.default_paid_model.trim() : (gd.paid ?? BUILTIN_GROUP_DEFAULTS.paid!)
      const strata = typeof raw.default_strata_model === 'string' && raw.default_strata_model.trim() ? raw.default_strata_model.trim() : (gd.strata ?? BUILTIN_GROUP_DEFAULTS.strata!)
      const lmstudio = typeof raw.default_lmstudio_model === 'string' && raw.default_lmstudio_model.trim() ? raw.default_lmstudio_model.trim() : (gd.lmstudio ?? BUILTIN_GROUP_DEFAULTS.lmstudio!)
      const defs: Record<string, string> = { paid, strata, lmstudio, ...gd }
      const order = Array.isArray(raw.model_order) ? (raw.model_order as unknown[]).filter((g): g is string => typeof g === 'string' && g.trim() !== '') : []
      const groups = [...new Set([...order, 'paid', 'strata', 'lmstudio'])]
      const derivedFallbacks: string[] = []
      for (const g of groups) {
        const m = defs[g]
        if (m && !derivedFallbacks.includes(m)) derivedFallbacks.push(m)
      }
      return {
        ...raw,
        fallbacks: derivedFallbacks.length > 0 ? derivedFallbacks : BUILTIN_FALLBACKS,
        fallback_shared: raw.fallback_shared ?? (order.length > 0)
      }
    }
  }
  return val
}, baseSettingsSchema);

/** The default model of every group: legacy helper for backwards compatibility. */
export function groupDefaultsOf(s: z.infer<typeof settingsSchema>): Record<string, string> {
  const out = { ...BUILTIN_GROUP_DEFAULTS };
  if (s.default_paid_model) out.paid = s.default_paid_model;
  if (s.default_strata_model) out.strata = s.default_strata_model;
  if (s.default_lmstudio_model) out.lmstudio = s.default_lmstudio_model;
  if (s.group_defaults) Object.assign(out, s.group_defaults);
  return out;
}

// ---- agents ----

export const agentSchema = z.looseObject({
  kind: z.literal('agent'),
  role: z.string().min(1),
  name: z.string().min(1),
  /** `provider/model` override. Empty means "use the role default". */
  model: z.string().nullable().default(null),
  /** Prefer jobs for these books or topics. */
  focus: z.array(z.string()).default([]),
  /** Only take jobs for this book. */
  pin: z.string().nullable().default(null),
  max_parallel: z.number().int().positive().default(1),
  paused: z.boolean().default(false)
})

// ---- jobs ----

export const jobSchema = z.looseObject({
  kind: z.literal('job').default('job'),
  /** Deterministic: book--task--unit--round. */
  id: z.string().min(1),
  book: z.string().nullable().default(null),
  task: z.string().min(1),
  role: z.string().min(1),
  unit: z.string().nullable().default(null),
  round: z.number().int().nonnegative().default(0),
  /** An agent id, `you` or `engine`. */
  requested_by: z.string().default('engine'),
  depends_on: z.array(z.string()).default([]),
  /** Job id (usually research) this job is suspended on. */
  waiting_on: z.string().nullable().default(null),
  /** Short text for the office (the handover line and the agent's bubble) instead of `task unit`. Research jobs use the question. */
  label: z.string().optional(),
  /** Locks that must be free to run, for example `bible:silver-inn`. */
  locks: z.array(z.string()).default([]),
  /**
   * A lane of its own: the job takes no slot of its agent (`max_parallel` stays the cap of the agent's model calls and ordinary jobs) and
   * waits only for other jobs of the same lane, as many at a time as the agent's `max_parallel`. For work on a machine that is not the
   * model's, like Google Flow images, so a Flow book does not wait behind a ComfyUI book.
   */
  lane: z.string().nullable().default(null),
  /** Reviewers prefer a model family different from this one. */
  avoid_family: z.string().nullable().default(null),
  /** Prefer this agent (same writer for a book's chapters). Not strict. */
  agent_hint: z.string().nullable().default(null),
  /** The job sends images: only models with `vision: true` are used (the art-critic). */
  vision: z.boolean().default(false),
  paid: z.boolean().nullable().default(null),
  attempts: z.number().int().nonnegative().default(0),
  max_attempts: z.number().int().positive().nullable().default(null),
  /** Do not start before this time (ISO). Used for retry backoff. */
  not_before: z.string().nullable().default(null),
  /** Higher goes first (then oldest first). 1 for a request someone made explicitly (MCP, the app), 0 for the pipeline's own jobs. Dependencies still gate. */
  priority: z.number().int().default(0),
  created: z.string().optional()
})

export const schemasByKind = {
  budget: budgetSchema,
  providers: providersSchema,
  roles: rolesSchema,
  factory: factorySchema,
  settings: settingsSchema,
  agent: agentSchema,
  job: jobSchema,
  generic: genericSchema
} as const satisfies Record<string, ZodType>

export type FileKind = keyof typeof schemasByKind
export type BudgetConfig = z.output<typeof budgetSchema>
export type ProvidersConfig = z.output<typeof providersSchema>
export type ProviderEntry = z.output<typeof providerEntrySchema>
export type ProviderModelEntry = z.output<typeof providerModelSchema>
export type RolesConfig = z.output<typeof rolesSchema>
export type SettingsConfig = z.output<typeof settingsSchema>
export type ModelsConfig = z.output<typeof modelsConfigSchema>
export type FactoryConfig = z.output<typeof factorySchema>
export type AgentFrontmatter = z.output<typeof agentSchema>
export type JobFrontmatter = z.output<typeof jobSchema>

/** Config files in `config/`, by file name (without `.md`). */
export const CONFIG_FILES = ['providers', 'roles', 'models', 'budget', 'factory', 'settings'] as const

/** The agent roles of Cartoon Studio (the cartoon team; `seed/config/roles.md`). `src/renderer/ui/roles.ts` mirrors this list for the pickers. */
export const ROLES = [
  'showrunner',
  'writer',
  'character-designer',
  'background-artist',
  'voice-director',
  'composer',
  'child-safety-reviewer',
  'frame-critic'
] as const

export type Role = (typeof ROLES)[number]
