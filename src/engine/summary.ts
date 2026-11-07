import type { AgentSummary, ModelSummary, ProviderSummary, ServerStatus } from '../shared/protocol'
import type { AgentDef } from './agents/agents'
import type { ProviderLimiter } from './models/limiter'
import type { ModelRegistry } from './models/registry'
import type { ModelRouter } from './models/router'
import type { Scheduler } from './queue/scheduler'

export function agentSummary(def: AgentDef, sched: Scheduler, router: ModelRouter): AgentSummary {
  const info = sched.agentInfo(def.id)
  // a working agent shows the model its job calls now, not the role default it would start the next job with
  const resolved = info.model ?? router.candidates(def.data.role, { agentModel: def.data.model })[0]?.ref ?? def.data.model ?? router.registry.roleModelRefs(def.data.role)[0] ?? null
  return {
    id: def.id,
    name: def.data.name,
    role: def.data.role,
    model: def.data.model,
    resolvedModel: resolved,
    pin: def.data.pin,
    paused: def.data.paused,
    state: def.data.paused && info.state === 'idle' ? 'paused' : info.state,
    task: info.task,
    book: info.book,
    jobId: info.jobId,
    problem: info.problem
  }
}

export function modelSummaries(registry: ModelRegistry): ModelSummary[] {
  return [...registry.models.values()]
    .filter((m) => !m.embedding)
    .map((m) => ({
      ref: m.ref,
      provider: m.provider.id,
      model: m.id,
      family: m.family,
      local: m.provider.local,
      kind: registry.kindOf(m.ref),
      group: registry.groupOf(m.ref),
      enabled: m.provider.available,
      shown: registry.isShown(m.ref),
      source: m.picked ? ('picked' as const) : m.discovered ? ('discovered' as const) : ('config' as const),
      context: m.context,
      served: m.servedId,
      thinking: m.loaded && typeof m.extraBody?.reasoning_effort === 'string' ? m.extraBody.reasoning_effort : undefined,
      vision: m.vision,
      priceIn: m.priceIn,
      priceOut: m.priceOut
    }))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.ref.localeCompare(b.ref))
}

/** The model providers, for the Models dialog. */
export function providerSummaries(registry: ModelRegistry, limiter: ProviderLimiter): ProviderSummary[] {
  return [...registry.providers.values()]
    .filter((p) => p.kind !== 'search' && p.kind !== 'mock')
    .map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      local: p.local,
      custom: p.custom,
      enabled: p.enabled,
      baseUrl: p.baseUrl,
      jsonSchema: p.jsonSchema,
      keyName: p.apiKeyEnv,
      keySet: registry.hasKey(p),
      available: p.available,
      reason: p.available ? undefined : p.unavailableReason,
      keyFrom: p.keyFrom,
      canList: p.kind === 'openai-compat',
      followsServer: p.hasLoaded,
      served: p.served,
      concurrency: p.concurrency,
      concurrencyAuto: p.concurrencyAuto,
      rpm: p.rpm,
      rpd: p.rpd,
      requestsToday: limiter.requestsToday(p.id),
      dayFull: limiter.dayFull(p),
      dayResetsAt: limiter.dayResetsAt()
    }))
}

/** The local servers the engine checks (`concurrency: auto`): Strata and LM Studio. */
export function serverStatuses(registry: ModelRegistry): ServerStatus[] {
  return [...registry.providers.values()].filter((p) => p.concurrencyAuto && p.available).map((p) => ({ id: p.id, down: p.down, slots: p.concurrency, served: p.served }))
}

export function roleDefaults(registry: ModelRegistry): Record<string, string> {
  const out: Record<string, string> = {}
  for (const role of Object.keys(registry.roles.roles)) {
    const first = registry.roleEntries(role)[0]
    if (first) out[role] = first
  }
  return out
}
