import { extractJson } from '../pipeline/llm'
import { estimateMessagesTokens, estimateTokens } from './types'
import type { ChatEvent, ChatMessage, ChatRequest, ProviderClient, RequestMeta } from './types'

/** Default lease: how long a client has to answer a task it took before the task goes back to waiting. */
export const DEFAULT_LEASE_MS = 30 * 60 * 1000

/** The client that takes a task whose model is not named: Claude Code (the seed model `client/claude-code`). */
export const DEFAULT_CLIENT = 'claude-code'

/** An image of a request (the art-critic's images), as it sat in the messages. */
export interface ClientImage {
  type: 'image'
  mime: string
  /** Base64. */
  data: string
}

/** One model request that waits for a client (Claude Code over MCP) to answer it. Meta fields are '' when the request had none. */
export interface ClientTask {
  /** `<job>#<call>`. */
  id: string
  job: string
  /** Which request of the job this is, from 1 (a repair round is the next one). */
  call: number
  role: string
  task: string
  book: string
  agent: string
  unit: string
  /** The client model the job asked for (`client/<id>`: `claude-code`, `antigravity`, ...). Only a client that names it takes the task. */
  client: string
  messages: ChatMessage[]
  /** JSON schema the answer must match (a structured request). */
  schema?: Record<string, unknown>
  maxTokens?: number
  images?: ClientImage[]
  /** Epoch ms. */
  createdAt: number
  /** Epoch ms: set while a client holds the task. */
  leaseUntil?: number
}

export interface ClientTaskSummary {
  id: string
  job: string
  call: number
  role: string
  task: string
  book: string
  agent: string
  unit: string
  client: string
  state: 'waiting' | 'leased'
  ageMs: number
  leaseMsLeft?: number
}

export interface ClientTaskFilter {
  /** The client asking, as the model id (`antigravity`). Missing: `claude-code`, so Claude Code's prompts keep working and never take another client's tasks. */
  client?: string
  role?: string
  book?: string
  task?: string
}

export type SubmitResult = { accepted: true } | { accepted: false; problems: string[] }

export interface ClientTaskRequest {
  /** The client model id the task is for. Default `claude-code`. */
  client?: string
  messages: ChatMessage[]
  schema?: Record<string, unknown>
  maxTokens?: number
  images?: ClientImage[]
}

interface Entry {
  task: ClientTask
  resolve: (text: string) => void
  reject: (err: Error) => void
}

export const GONE = 'task not found (it was aborted, answered, or the engine restarted)'

function abortError(): Error {
  const e = new Error('The operation was aborted')
  e.name = 'AbortError'
  return e
}

/**
 * The model requests of `client` providers, waiting for an MCP client to answer them. In memory only: a restart loses them,
 * and the jobs that asked are requeued by the scheduler, which makes new tasks. One queue per engine; the MCP server is stateless.
 * States: waiting -> leased (`lease`, with a deadline; an expired lease goes back to waiting) -> answered (`submit`) or dropped (`cancel`).
 */
export class ClientTaskQueue {
  /** In creation order, so the oldest waiting task is the first one found. */
  private entries = new Map<string, Entry>()
  private calls = new Map<string, number>()
  private adhoc = 0
  private readonly now: () => number

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now
  }

  /** Puts a request in the queue. `done` settles with the answer text, or rejects with an AbortError when the task is cancelled. */
  add(req: ClientTaskRequest, meta: RequestMeta = {}): { task: ClientTask; done: Promise<string> } {
    const job = meta.job ?? `adhoc-${++this.adhoc}`
    // the images of the request: given by the caller, or the image parts of the messages
    const images: ClientImage[] = req.images ? [...req.images] : []
    if (!req.images) for (const m of req.messages) if (typeof m.content !== 'string') for (const p of m.content) if (p.type === 'image') images.push({ type: 'image', mime: p.mime, data: p.data })
    const call = (this.calls.get(job) ?? 0) + 1
    this.calls.set(job, call)
    const task: ClientTask = {
      id: `${job}#${call}`,
      job,
      call,
      role: meta.role ?? '',
      task: meta.task ?? '',
      book: meta.book ?? '',
      agent: meta.agent ?? '',
      unit: meta.unit ?? '',
      client: req.client ?? DEFAULT_CLIENT,
      messages: req.messages,
      ...(req.schema ? { schema: req.schema } : {}),
      ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
      ...(images.length ? { images } : {}),
      createdAt: this.now()
    }
    const done = new Promise<string>((resolve, reject) => this.entries.set(task.id, { task, resolve, reject }))
    return { task, done }
  }

  /** Waiting and leased tasks, oldest first. */
  list(): ClientTaskSummary[] {
    this.expire()
    const t = this.now()
    return [...this.entries.values()].map(({ task: k }) => ({
      id: k.id,
      job: k.job,
      call: k.call,
      role: k.role,
      task: k.task,
      book: k.book,
      agent: k.agent,
      unit: k.unit,
      client: k.client,
      state: k.leaseUntil === undefined ? ('waiting' as const) : ('leased' as const),
      ageMs: t - k.createdAt,
      ...(k.leaseUntil === undefined ? {} : { leaseMsLeft: Math.max(0, k.leaseUntil - t) })
    }))
  }

  counts(): { waiting: number; leased: number } {
    this.expire()
    let leased = 0
    for (const { task } of this.entries.values()) if (task.leaseUntil !== undefined) leased++
    return { waiting: this.entries.size - leased, leased }
  }

  /** The ids of the jobs that have a task here (waiting or leased): their model call is parked, they are not working. */
  jobs(): Set<string> {
    return new Set([...this.entries.values()].map((e) => e.task.job))
  }

  /** How many tasks (waiting or leased) belong to jobs that match. */
  countFor(match: (job: string) => boolean): number {
    let n = 0
    for (const { task } of this.entries.values()) if (match(task.job)) n++
    return n
  }

  /** Hands out the oldest waiting task that matches, and holds it for `leaseMs`. Null when none matches. */
  lease(filter: ClientTaskFilter = {}, leaseMs = DEFAULT_LEASE_MS): ClientTask | null {
    this.expire()
    for (const { task } of this.entries.values()) {
      if (task.leaseUntil !== undefined) continue
      if (task.client !== (filter.client || DEFAULT_CLIENT)) continue
      if (filter.role && task.role !== filter.role) continue
      if (filter.book && task.book !== filter.book) continue
      if (filter.task && task.task !== filter.task) continue
      task.leaseUntil = this.now() + leaseMs
      return { ...task }
    }
    return null
  }

  /**
   * Answers a task. With a schema the text must be one JSON object that matches it: a bad one is refused with the problems and the
   * task stays leased (the client fixes it and submits again, so no repair round is spent). An unknown id is refused too.
   */
  submit(id: string, text: string): SubmitResult {
    this.expire()
    const entry = this.entries.get(id)
    if (!entry) return { accepted: false, problems: [GONE] }
    if (!text.trim()) return { accepted: false, problems: ['the text is empty'] }
    if (entry.task.schema) {
      const problems = checkAgainstSchema(text, entry.task.schema)
      if (problems.length > 0) return { accepted: false, problems }
    }
    this.entries.delete(id)
    entry.resolve(text)
    return { accepted: true }
  }

  /** Gives a leased task back: it waits again. False when there is no such task. */
  release(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    delete entry.task.leaseUntil
    return true
  }

  /** Drops a task (its request was aborted). Its `done` rejects with an AbortError. False when it is already gone. */
  cancel(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    this.entries.delete(id)
    entry.reject(abortError())
    return true
  }

  /** Where a task is: waiting for a client, held by one, or gone (answered, cancelled, or never there). The client web search asks it. */
  state(id: string): 'waiting' | 'leased' | 'gone' {
    this.expire()
    const entry = this.entries.get(id)
    return !entry ? 'gone' : entry.task.leaseUntil === undefined ? 'waiting' : 'leased'
  }

  /** A lease that ran out puts the task back to waiting (checked when the queue is read, no timer). */
  private expire(): void {
    const t = this.now()
    for (const { task } of this.entries.values()) {
      if (task.leaseUntil !== undefined && task.leaseUntil <= t) delete task.leaseUntil
    }
  }
}

/** The text of a structured answer against its JSON schema: the same `extractJson` the jobs use, then a light check. Empty when fine. */
export function checkAgainstSchema(text: string, schema: Record<string, unknown>): string[] {
  let value: unknown
  try {
    value = extractJson(text)
  } catch (err) {
    return [`not a JSON object: ${(err as Error).message}`]
  }
  const problems: string[] = []
  validate(value, schema, '(root)', problems)
  return problems.slice(0, 12)
}

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

/**
 * A small JSON-schema check, not a full validator (no ajv dependency): `type`, `enum`, `const`, `required`, `properties`, `items`,
 * `anyOf`/`oneOf`, `minItems`, `maxItems`, `minLength`, `maxLength` and `pattern`. Anything else in the schema is ignored, so it never refuses what the job's own zod schema accepts
 * for a reason it can't see. A field with a `default` is not reported as missing (`z.toJSONSchema` lists it as required).
 */
function validate(v: unknown, schema: Record<string, unknown>, at: string, out: string[]): void {
  const alts = (schema.anyOf ?? schema.oneOf) as Record<string, unknown>[] | undefined
  if (Array.isArray(alts) && alts.length > 0) {
    if (!alts.some((a) => { const o: string[] = []; validate(v, a, at, o); return o.length === 0 })) out.push(`${at}: matches none of the allowed shapes`)
    return
  }
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string]
  if (types.length > 0) {
    const t = typeOf(v)
    const ok = types.some((want) => want === t || (want === 'integer' && t === 'number' && Number.isInteger(v)) || (want === 'number' && t === 'number'))
    if (!ok) {
      out.push(`${at}: expected ${types.join(' or ')}, got ${t}`)
      return
    }
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).some((e) => JSON.stringify(e) === JSON.stringify(v))) {
    out.push(`${at}: must be one of ${(schema.enum as unknown[]).map((e) => JSON.stringify(e)).join(', ')}`)
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(v)) out.push(`${at}: must be ${JSON.stringify(schema.const)}`)
  if (typeof v === 'string' && typeof schema.minLength === 'number' && v.length < schema.minLength) out.push(`${at}: must be at least ${schema.minLength} characters`)
  if (typeof v === 'string' && typeof schema.maxLength === 'number' && v.length > schema.maxLength) out.push(`${at}: must be at most ${schema.maxLength} characters`)
  if (typeof v === 'string' && typeof schema.pattern === 'string') {
    try {
      if (!new RegExp(schema.pattern, 'u').test(v)) out.push(`${at}: does not match the pattern ${schema.pattern}`)
    } catch {
      /* a pattern this check cannot read is not held against the answer */
    }
  }
  if (Array.isArray(v)) {
    if (typeof schema.minItems === 'number' && v.length < schema.minItems) out.push(`${at}: needs at least ${schema.minItems} items`)
    if (typeof schema.maxItems === 'number' && v.length > schema.maxItems) out.push(`${at}: needs at most ${schema.maxItems} items`)
    if (schema.items && typeof schema.items === 'object') v.forEach((item, i) => validate(item, schema.items as Record<string, unknown>, `${at}[${i}]`, out))
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>
    const declared = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
    for (const key of (schema.required as string[] | undefined) ?? []) {
      // zod's JSON schema lists a field with a default as required but gives it a `default`: leaving it out is fine
      if (!(key in obj) && !(declared[key] && 'default' in declared[key]!)) out.push(`${at === '(root)' ? '' : at + '.'}${key}: missing (required)`)
    }
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj && sub && typeof sub === 'object') validate(obj[key], sub, `${at === '(root)' ? '' : at + '.'}${key}`, out)
    }
  }
}

/**
 * The provider of `kind: client`: a request becomes a task in the engine's queue and waits, with no time limit, until a client answers it.
 * The answer comes back as one delta, with usage estimated from the text. Nothing is spent and the provider is never marked down.
 * An abort (stop, a model change) drops the task, and the scheduler requeues the job without counting an attempt.
 */
export class ClientProvider implements ProviderClient {
  constructor(
    readonly id: string,
    private readonly queue: ClientTaskQueue
  ) {}

  async *chat(req: ChatRequest): AsyncGenerator<ChatEvent, void, void> {
    if (req.signal?.aborted) throw abortError()
    const images: ClientImage[] = []
    for (const m of req.messages) if (typeof m.content !== 'string') for (const p of m.content) if (p.type === 'image') images.push({ type: 'image', mime: p.mime, data: p.data })
    const { task, done } = this.queue.add({ client: req.model, messages: req.messages, schema: req.schema, maxTokens: req.maxTokens, images }, req.meta)
    const onAbort = () => void this.queue.cancel(task.id)
    req.signal?.addEventListener('abort', onAbort, { once: true })
    if (req.signal?.aborted) onAbort()
    let text: string
    try {
      text = await done
    } finally {
      req.signal?.removeEventListener('abort', onAbort)
    }
    yield { type: 'delta', text }
    yield {
      type: 'usage',
      usage: { inputTokens: estimateMessagesTokens(req.messages), cachedInputTokens: 0, outputTokens: estimateTokens(text) }
    }
  }
}
