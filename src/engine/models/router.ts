import { estimateCost } from '../budget/spend'
import type { Budget } from '../budget/spend'
import { ProviderLimiter } from './limiter'
import { computeCost, isPaidModel } from './registry'
import type { ModelInfo, ModelRegistry, ProviderInfo } from './registry'
import { BudgetError, emptyUsage, isAbortError, ProviderError } from './types'
import type { ChatMessage, RequestMeta, Usage } from './types'
import type { ProblemKind } from '../../shared/protocol'

export interface CandidateOptions {
  /** The agent's own `provider/model` override. Goes first. */
  agentModel?: string | null
  /** Reviewers prefer another family than the book's writer. Models of this family go last. */
  avoidFamily?: string | null
  /** Only models that accept images (`vision: true`), for the art-critic. */
  visionOnly?: boolean
  /** The model the job's project chose for this role (`models` in project.md). It goes before the agent's model and the role's list, which stay as the fallback. */
  projectModel?: string | null
}

export interface RoutedRequest {
  messages: ChatMessage[]
  schema?: Record<string, unknown>
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  meta: RequestMeta & { role: string }
}

export type RoutedEvent =
  | { type: 'attempt'; model: ModelInfo; attempt: number }
  | { type: 'delta'; text: string }
  | { type: 'done'; model: ModelInfo; usage: Usage; costUsd: number; ms: number }
  /** A request failed: the router retries, falls back to the next model, or gives up after this. */
  | { type: 'problem'; model: ModelInfo; kind: ProblemKind; message: string }

export interface RouterOptions {
  /** Retries on the same model for retryable errors before falling back. Default 2. */
  retries?: number
  /** First backoff in ms. Doubled each retry. Default 1000. */
  backoffMs?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      },
      { once: true }
    )
  })

/**
 * Picks models for a role and calls them with fallback: retries with backoff on 429, 5xx and timeouts,
 * then the next model in the list. Records spend, reserves cost before paid requests, and respects provider limits.
 */
export class ModelRouter {
  readonly limiter: ProviderLimiter
  /** Called when a request finds a server not running and marks it down for every job. */
  onProviderDown?: (p: ProviderInfo) => void
  /** Called when a provider's daily limit is used up (its `rpd`, or the provider said so): its jobs use their next model until midnight UTC. */
  onProviderDayFull?: (p: ProviderInfo) => void
  private readonly opts: Required<Omit<RouterOptions, 'now'>>

  constructor(
    readonly registry: ModelRegistry,
    readonly budget: Budget | undefined,
    opts: RouterOptions = {},
    limiter?: ProviderLimiter
  ) {
    this.limiter = limiter ?? new ProviderLimiter(opts.now)
    this.opts = { retries: opts.retries ?? 2, backoffMs: opts.backoffMs ?? 1000, sleep: opts.sleep ?? defaultSleep }
  }

  /** The provider can take requests now: its server is up and its daily limit isn't used up. */
  private usable(p: ProviderInfo): boolean {
    return !p.down && !this.limiter.dayFull(p)
  }

  /**
   * Why a model would be skipped when a job is routed, or null when it can be used now. Unknown model, provider disabled or not available (no key),
   * server down, daily limit used up, not a vision model (`visionOnly`), embedding model.
   */
  whyUnusable(ref: string, o: { visionOnly?: boolean } = {}): string | null {
    const m = this.registry.getModel(this.registry.resolve(ref))
    if (!m) return `unknown model ${ref}`
    const p = m.provider
    if (!p.enabled) return `provider ${p.id} is disabled in config/providers.md`
    if (!p.available || !p.client) return `provider ${p.id} is not available (${p.unavailableReason ?? 'no client'})`
    if (p.down) return `server of provider ${p.id} is down`
    if (this.limiter.dayFull(p)) return `daily limit of provider ${p.id} is used up`
    if (m.embedding) return `${m.ref} is an embedding model`
    if (o.visionOnly && !m.vision) return `${m.ref} is not a vision model`
    return null
  }

  /**
   * Ordered models for a job: the agent's override, then the role's list. Unavailable providers are dropped,
   * and so are servers that are down (Strata not started) and providers whose daily limit is used up, unless nothing else is left.
   */
  candidates(role: string, o: CandidateOptions = {}): ModelInfo[] {
    const own = o.agentModel ? this.registry.resolve(o.agentModel) : undefined
    const project = o.projectModel ? this.registry.resolve(o.projectModel) : undefined
    const refs = [...(project ? [project] : []), ...(own ? [own] : []), ...this.registry.roleModelRefs(role)]
    const seen = new Set<string>()
    let list: ModelInfo[] = []
    for (const ref of refs) {
      if (seen.has(ref)) continue
      seen.add(ref)
      const m = this.registry.getModel(ref)
      if (m && m.provider.available && m.provider.client && !m.embedding && (!o.visionOnly || m.vision)) list.push(m)
    }
    const up = list.filter((m) => this.usable(m.provider))
    if (up.length > 0) list = up
    if (o.avoidFamily) {
      // the agent's own model was picked on purpose: it stays first even in the writer's family
      let n = 0
      while (n < list.length && (list[n]!.ref === own || list[n]!.ref === project)) n++
      const first = list.slice(0, n)
      const rest = list.slice(n)
      const keep = rest.filter((m) => m.family !== o.avoidFamily)
      const avoid = rest.filter((m) => m.family === o.avoidFamily)
      return [...first, ...keep, ...avoid]
    }
    return list
  }

  /**
   * Streams a reply, falling back through `models`. `held` are providers whose slot the caller already holds.
   * After a failed attempt the consumer sees a new `attempt` event and should drop the text so far.
   */
  async *chat(models: ModelInfo[], req: RoutedRequest, held: ReadonlySet<string> = new Set()): AsyncGenerator<RoutedEvent, void, void> {
    if (models.length === 0) throw new ProviderError(`no available model for role ${req.meta.role}`)
    let lastError: unknown
    let budgetRefusal: string | undefined
    let attempts = 0
    const failures: string[] = []
    for (const [i, model] of models.entries()) {
      // a server that went down, or a daily limit used up, after the job started: skip it while a later model can answer
      if (!this.usable(model.provider) && models.slice(i + 1).some((m) => this.usable(m.provider))) continue
      for (let retry = 0; retry <= this.opts.retries; retry++) {
        if (req.signal?.aborted) throw abort()
        const paid = isPaidModel(model)
        let reservation
        if (paid && this.budget) {
          const est = estimateCost(model, req.messages, req.maxTokens)
          const r = this.budget.reserve(est, req.meta.book ?? '')
          if (!r.ok) {
            yield { type: 'problem', model, kind: 'budget', message: r.reason }
            budgetRefusal = r.reason
            break // next model
          }
          reservation = r.reservation
        }
        const provider = model.provider
        const holdsSlot = held.has(provider.id)
        let acquired = false
        const started = Date.now()
        try {
          if (!holdsSlot) {
            await this.limiter.acquire(provider, req.signal)
            acquired = true
          }
          const wait = this.limiter.rpmWaitMs(provider)
          if (wait > 0) await this.opts.sleep(wait, req.signal)
          this.limiter.noteRequest(provider)
          attempts++
          yield { type: 'attempt', model, attempt: attempts }
          let usage = emptyUsage()
          for await (const ev of provider.client!.chat({
            model: model.id,
            messages: req.messages,
            schema: req.schema,
            maxTokens: req.maxTokens,
            temperature: req.temperature,
            signal: req.signal,
            extraBody: model.extraBody,
            jsonSchema: model.jsonSchema,
            meta: req.meta
          })) {
            if (ev.type === 'delta') yield { type: 'delta', text: ev.text }
            else usage = ev.usage
          }
          const costUsd = paid ? computeCost(model, usage) : 0
          const ms = Date.now() - started
          if (this.budget) {
            await this.budget.record({
              time: new Date(),
              agent: req.meta.agent ?? '',
              book: req.meta.book ?? '',
              role: req.meta.role,
              provider: provider.id,
              model: model.id,
              tokensIn: usage.inputTokens,
              tokensCached: usage.cachedInputTokens,
              tokensOut: usage.outputTokens,
              costUsd,
              ms
            })
          }
          yield { type: 'done', model, usage, costUsd, ms }
          return
        } catch (err) {
          if (isAbortError(err) || req.signal?.aborted) throw err
          lastError = err
          yield { type: 'problem', model, kind: problemKind(err), message: err instanceof Error ? err.message : String(err) }
          // nothing listens there (Strata not started): mark it down for every job and go to the next model without retries
          if (err instanceof ProviderError && err.unreachable && provider.concurrencyAuto) {
            if (this.registry.markDown(provider)) this.onProviderDown?.(provider)
            failures.push(`${model.ref}: ${err.message}`)
            break
          }
          // the provider's daily limit is used up (OpenRouter's free-models-per-day): retrying is no use until midnight UTC
          if (isDailyLimitError(err)) {
            if (this.limiter.markDayFull(provider)) this.onProviderDayFull?.(provider)
            failures.push(`${model.ref}: ${err instanceof Error ? err.message : String(err)}`)
            break
          }
          // a request too big for this model fails the same way every time: go straight to the next model
          const retryable = err instanceof ProviderError && err.retryable && !isContextError(err)
          if (!retryable || retry === this.opts.retries) {
            failures.push(`${model.ref}: ${err instanceof Error ? err.message : String(err)}`)
            break
          }
          const delay = (err as ProviderError).retryAfterMs ?? this.opts.backoffMs * 2 ** retry
          await this.opts.sleep(delay, req.signal)
        } finally {
          if (reservation) this.budget!.release(reservation)
          if (acquired) this.limiter.release(provider)
        }
      }
    }
    if (!lastError && budgetRefusal) throw new BudgetError(budgetRefusal)
    if (budgetRefusal) failures.push(`paid models skipped: ${budgetRefusal}`)
    // with more than one model, say why each one failed: the last error alone hides the real cause
    if (failures.length > 1) throw new ProviderError(`all models failed. ${failures.map((f) => f.slice(0, 400)).join(' | ')}`)
    throw lastError instanceof Error ? lastError : new ProviderError('all models failed')
  }
}

/** What kind of failure an error is, so the office can say why an agent isn't getting answers. */
export function problemKind(err: unknown): ProblemKind {
  if (isDailyLimitError(err)) return 'day-limit'
  if (err instanceof ProviderError && err.unreachable) return 'down'
  if (isContextError(err)) return 'too-big'
  const status = err instanceof ProviderError ? err.status : undefined
  if (status === 429) return 'rate-limit'
  if (status === 401 || status === 403) return 'no-access'
  if (status === 402) return 'no-credit'
  if (status === 404) return 'not-found'
  if (status !== undefined && status >= 400 && status < 500) return 'bad-request'
  if (status !== undefined && status >= 500) return 'server'
  return 'other'
}

/** A 429 that says a daily request limit is used up (OpenRouter: `free-models-per-day`), not a per-minute one. */
export function isDailyLimitError(err: unknown): boolean {
  if (!(err instanceof ProviderError) || err.status !== 429) return false
  return /per[-_ ]day|daily/i.test(err.message)
}

/** The request is larger than the model's context window, or the model ran out of tokens before answering. */
export function isContextError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /exceed_context_size|exceeds the available context|context (size|length|window)|maximum context|n_ctx|token limit without an answer/i.test(msg)
}

function abort(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
}
