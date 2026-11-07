import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseMdWith } from '../../shared/md'
import { budgetSchema } from '../../shared/schemas'
import type { BudgetConfig } from '../../shared/schemas'
import { atomicWrite } from '../store/atomic'
import type { SeriesStore } from '../series/service'
import type { SpendEntry as LedgerEntry } from '../../shared/contracts'
import { estimateMessagesTokens } from '../models/types'
import type { ChatMessage } from '../models/types'
import type { ModelInfo } from '../models/registry'

/** Local time helpers: day and month boundaries follow the machine's clock. */
const p2 = (n: number) => String(n).padStart(2, '0')
export const dayKey = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
export const monthKey = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}`

/** ISO time with the local offset, for example 2026-10-08T11:49:51+02:00. */
export function localIso(d: Date): string {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${dayKey(d)}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`
}

export interface SpendEntry {
  time: Date
  agent: string
  book: string
  role: string
  provider: string
  model: string
  tokensIn: number
  tokensCached: number
  tokensOut: number
  costUsd: number
  ms: number
}

export interface Reservation {
  id: number
  amount: number
  book: string
}

export type Refusal = { ok: false; reason: string; cap: 'daily' | 'monthly' | 'book' }

const SUMMARY_MARKER = '<!-- engine-summary: everything below this line is rewritten by the engine -->'
export { SUMMARY_MARKER }

const COLUMNS = ['time', 'agent', 'book', 'role', 'provider', 'model', 'tokens_in', 'tokens_cached', 'tokens_out', 'cost_usd', 'ms']

const clean = (s: string) => s.replace(/[|\r\n]+/g, '/').trim()

function formatRow(e: SpendEntry): string {
  return `| ${[
    localIso(e.time),
    clean(e.agent),
    clean(e.book),
    clean(e.role),
    clean(e.provider),
    clean(e.model),
    e.tokensIn,
    e.tokensCached,
    e.tokensOut,
    e.costUsd.toFixed(6),
    Math.round(e.ms)
  ].join(' | ')} |`
}

function parseRow(line: string): SpendEntry | null {
  if (!line.startsWith('|')) return null
  const cells = line
    .slice(1, line.lastIndexOf('|'))
    .split('|')
    .map((c) => c.trim())
  if (cells.length < COLUMNS.length) return null
  const time = new Date(cells[0]!)
  if (Number.isNaN(time.getTime())) return null // header, separator
  return {
    time,
    agent: cells[1]!,
    book: cells[2]!,
    role: cells[3]!,
    provider: cells[4]!,
    model: cells[5]!,
    tokensIn: Number(cells[6]),
    tokensCached: Number(cells[7]),
    tokensOut: Number(cells[8]),
    costUsd: Number(cells[9]),
    ms: Number(cells[10])
  }
}

interface Totals {
  costUsd: number
  tokensIn: number
  tokensOut: number
  ms: number
  requests: number
}
const zero = (): Totals => ({ costUsd: 0, tokensIn: 0, tokensOut: 0, ms: 0, requests: 0 })
function add(t: Totals, e: SpendEntry): void {
  t.costUsd += e.costUsd
  t.tokensIn += e.tokensIn
  t.tokensOut += e.tokensOut
  t.ms += e.ms
  t.requests++
}

export interface BudgetEvents {
  onWarn?: (message: string) => void
  onSpend?: (e: SpendEntry) => void
}

/** Rough cost of a request before it runs: input at the normal price, output at the request's maximum. */
export function estimateCost(model: Pick<ModelInfo, 'priceIn' | 'priceOut' | 'maxOutput'>, messages: ChatMessage[], maxTokens?: number): number {
  const inTok = estimateMessagesTokens(messages)
  const outTok = maxTokens ?? model.maxOutput ?? 4096
  return (inTok * model.priceIn + outTok * model.priceOut) / 1_000_000
}

export class Budget {
  caps: BudgetConfig = { kind: 'budget', monthly_cap_usd: 40, daily_cap_usd: 5, per_book_cap_usd: null, warn_at: 0.8, voice: { paidMaxUsd: 0 } }
  private byDay = new Map<string, Totals>()
  private byMonth = new Map<string, Totals>()
  private monthByModel = new Map<string, Totals>()
  private monthByRole = new Map<string, Totals>()
  private byBook = new Map<string, Totals>()
  /** Requests per `<UTC day>|<provider>`, for daily request limits after a restart. */
  private utcDayRequests = new Map<string, number>()
  private reserved = new Map<number, Reservation>()
  private nextRes = 1
  private warned = new Set<string>()
  private writeChain: Promise<unknown> = Promise.resolve()
  private summaryTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly dataDir: string,
    private readonly events: BudgetEvents = {},
    private readonly now: () => Date = () => new Date()
  ) {}

  private get configFile(): string {
    return path.join(this.dataDir, 'config', 'budget.md')
  }
  private spendDir(): string {
    return path.join(this.dataDir, 'logs', 'spend')
  }

  /** Reads the caps from config/budget.md and rebuilds all totals from the spend files. */
  async load(): Promise<void> {
    await this.loadCaps()
    this.byDay.clear()
    this.byMonth.clear()
    this.monthByModel.clear()
    this.monthByRole.clear()
    this.byBook.clear()
    this.utcDayRequests.clear()
    let files: string[] = []
    try {
      files = (await fs.readdir(this.spendDir())).filter((f) => /^\d{4}-\d{2}\.md$/.test(f)).sort()
    } catch {
      /* no spend yet */
    }
    for (const f of files) {
      const text = await fs.readFile(path.join(this.spendDir(), f), 'utf8')
      for (const line of text.split(/\r?\n/)) {
        const e = parseRow(line)
        if (e) this.tally(e)
      }
    }
  }

  /** Re-reads only the caps (after the file was edited). Keeps the old caps if the file is invalid. */
  async loadCaps(): Promise<void> {
    try {
      const text = await fs.readFile(this.configFile, 'utf8')
      this.caps = parseMdWith(text, budgetSchema, this.configFile).data
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  private tally(e: SpendEntry): void {
    const get = (m: Map<string, Totals>, k: string) => {
      let t = m.get(k)
      if (!t) m.set(k, (t = zero()))
      return t
    }
    add(get(this.byDay, dayKey(e.time)), e)
    add(get(this.byMonth, monthKey(e.time)), e)
    if (monthKey(e.time) === monthKey(this.now())) {
      add(get(this.monthByModel, `${e.provider}/${e.model}`), e)
      add(get(this.monthByRole, e.role), e)
    }
    if (e.book) add(get(this.byBook, e.book), e)
    const k = `${e.time.toISOString().slice(0, 10)}|${e.provider}`
    this.utcDayRequests.set(k, (this.utcDayRequests.get(k) ?? 0) + 1)
  }

  /** Requests recorded for a provider since midnight UTC (daily request limits start again then). */
  requestsTodayUtc(provider: string): number {
    return this.utcDayRequests.get(`${this.now().toISOString().slice(0, 10)}|${provider}`) ?? 0
  }

  spentToday(): number {
    return this.byDay.get(dayKey(this.now()))?.costUsd ?? 0
  }
  spentMonth(): number {
    return this.byMonth.get(monthKey(this.now()))?.costUsd ?? 0
  }
  spentBook(book: string): number {
    return this.byBook.get(book)?.costUsd ?? 0
  }
  reservedTotal(book?: string): number {
    let sum = 0
    for (const r of this.reserved.values()) if (!book || r.book === book) sum += r.amount
    return sum
  }

  /** True when a cap has already been reached, so no new paid job should start. */
  isExhausted(book?: string | null): Refusal | { ok: true } {
    return this.check(0, book ?? '')
  }

  private check(est: number, book: string): Refusal | { ok: true } {
    const c = this.caps
    const day = this.spentToday() + this.reservedTotal()
    const month = this.spentMonth() + this.reservedTotal()
    const eps = 1e-9
    if (est === 0 ? day >= c.daily_cap_usd - eps : day + est > c.daily_cap_usd + eps) {
      return { ok: false, cap: 'daily', reason: `daily cap ${c.daily_cap_usd} USD reached (spent ${this.spentToday().toFixed(4)}, reserved ${this.reservedTotal().toFixed(4)}, request ~${est.toFixed(4)})` }
    }
    if (est === 0 ? month >= c.monthly_cap_usd - eps : month + est > c.monthly_cap_usd + eps) {
      return { ok: false, cap: 'monthly', reason: `monthly cap ${c.monthly_cap_usd} USD reached (spent ${this.spentMonth().toFixed(4)}, request ~${est.toFixed(4)})` }
    }
    if (book && c.per_book_cap_usd !== null) {
      const b = this.spentBook(book) + this.reservedTotal(book)
      if (est === 0 ? b >= c.per_book_cap_usd - eps : b + est > c.per_book_cap_usd + eps) {
        return { ok: false, cap: 'book', reason: `book cap ${c.per_book_cap_usd} USD reached for ${book}` }
      }
    }
    return { ok: true }
  }

  /** Reserves an estimated maximum cost. Refuses when it would cross a cap. */
  reserve(estimate: number, book = ''): { ok: true; reservation: Reservation } | Refusal {
    const verdict = this.check(estimate, book)
    if (!verdict.ok) return verdict
    const reservation = { id: this.nextRes++, amount: estimate, book }
    this.reserved.set(reservation.id, reservation)
    return { ok: true, reservation }
  }

  release(r: Reservation): void {
    this.reserved.delete(r.id)
  }

  /** Appends a spend row and updates the totals. Local models are recorded with cost 0. */
  async record(entry: SpendEntry): Promise<void> {
    this.tally(entry)
    const file = path.join(this.spendDir(), `${monthKey(entry.time)}.md`)
    const row = formatRow(entry)
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(this.spendDir(), { recursive: true })
      let exists = true
      try {
        await fs.access(file)
      } catch {
        exists = false
      }
      const header = exists
        ? ''
        : `---\nkind: spend\nmonth: ${monthKey(entry.time)}\n---\n# Spend ${monthKey(entry.time)}\n\nOne row per request, appended by the engine. Local models are recorded with cost 0.\n\n| ${COLUMNS.join(' | ')} |\n|${COLUMNS.map(() => '---').join('|')}|\n`
      await fs.appendFile(file, header + row + '\n', 'utf8')
    })
    await this.writeChain
    this.checkWarnings(entry.book)
    this.events.onSpend?.(entry)
    this.scheduleSummary()
  }

  private checkWarnings(book: string): void {
    if (!this.events.onWarn) return
    const c = this.caps
    const tests: [string, number, number][] = [
      [`daily-${dayKey(this.now())}`, this.spentToday(), c.daily_cap_usd],
      [`monthly-${monthKey(this.now())}`, this.spentMonth(), c.monthly_cap_usd]
    ]
    if (book && c.per_book_cap_usd !== null) tests.push([`book-${book}`, this.spentBook(book), c.per_book_cap_usd])
    for (const [key, spent, cap] of tests) {
      if (cap > 0 && spent >= cap * c.warn_at && !this.warned.has(key)) {
        this.warned.add(key)
        this.events.onWarn(`${key.split('-')[0]} spend ${spent.toFixed(2)} USD is at ${Math.round((spent / cap) * 100)}% of the ${cap} USD cap`)
      }
    }
  }

  /** The markdown the engine keeps below the marker in config/budget.md. */
  summaryText(): string {
    const fmt = (t?: Totals) => (t ? `${t.costUsd.toFixed(4)} USD, ${t.tokensIn} in / ${t.tokensOut} out tokens, ${t.requests} requests, ${(t.ms / 1000).toFixed(1)} s` : 'nothing yet')
    const rows = (m: Map<string, Totals>, limit = 15) =>
      [...m.entries()]
        .sort((a, b) => b[1].costUsd - a[1].costUsd || b[1].requests - a[1].requests)
        .slice(0, limit)
        .map(([k, t]) => `- ${k}: ${fmt(t)}`)
        .join('\n') || '- nothing yet'
    const c = this.caps
    return [
      '## Spend summary (kept by the engine, do not edit)',
      '',
      `Updated ${localIso(this.now())}.`,
      '',
      `- Today (${dayKey(this.now())}): ${this.spentToday().toFixed(4)} of ${c.daily_cap_usd} USD`,
      `- This month (${monthKey(this.now())}): ${this.spentMonth().toFixed(4)} of ${c.monthly_cap_usd} USD`,
      '',
      '### This month by provider and model',
      rows(this.monthByModel),
      '',
      '### This month by role',
      rows(this.monthByRole),
      '',
      '### By book (all time)',
      rows(this.byBook),
      ''
    ].join('\n')
  }

  scheduleSummary(delayMs = 2000): void {
    if (this.summaryTimer) return
    this.summaryTimer = setTimeout(() => {
      this.summaryTimer = undefined
      this.writeSummary().catch(() => undefined)
    }, delayMs)
    this.summaryTimer.unref?.()
  }

  /**
   * Rewrites the summary below the marker. The file is re-read first and everything above the marker
   * (the frontmatter and your text) is kept byte for byte.
   */
  async writeSummary(): Promise<void> {
    if (this.summaryTimer) {
      clearTimeout(this.summaryTimer)
      this.summaryTimer = undefined
    }
    let text: string
    try {
      text = await fs.readFile(this.configFile, 'utf8')
    } catch {
      return
    }
    const at = text.indexOf(SUMMARY_MARKER)
    const head = at === -1 ? text.replace(/\s*$/, '\n\n') : text.slice(0, at)
    const next = `${head}${SUMMARY_MARKER}\n\n${this.summaryText()}`
    if (next !== text) await atomicWrite(this.configFile, next)
  }

  snapshot() {
    return {
      today: this.spentToday(),
      month: this.spentMonth(),
      dailyCap: this.caps.daily_cap_usd,
      monthlyCap: this.caps.monthly_cap_usd
    }
  }

  async flush(): Promise<void> {
    await this.writeChain
    await this.writeSummary()
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The production budget gate (CTS-08). Everything above is the LLM spend log inherited from Edu Studio; everything below guards the
// paid image/voice/video calls of one episode. `episodes/<ep>/budget.json` holds the caps, `episodes/<ep>/spend.json` the ledger.
// ---------------------------------------------------------------------------------------------------------------------------------

export type ChargeCurrency = 'usd' | 'credits'
export type ChargeCode = 'BUDGET_EXCEEDED' | 'FLOW_CREDITS_EXCEEDED'

/** A refused paid call. `message` starts with the code; nothing was spent. */
export class ChargeError extends Error {
  readonly code: ChargeCode
  constructor(
    code: ChargeCode,
    message: string,
    readonly detail: { series: string; episode: string; currency: ChargeCurrency; cap: number; spent: number; reserved: number; estimate: number; provider: string; model: string; what: string }
  ) {
    super(`${code}: ${message}`)
    this.name = 'ChargeError'
    this.code = code
  }
}

export interface ChargeArgs {
  /** The series store (budget.json and spend.json are read and written through it). */
  store: SeriesStore
  series: string
  /**
   * The episode whose budget pays. A series-level spend (the series intro or outro clip) is charged to the episode that
   * triggers it: the pilot charges the intro to the pilot episode. There is no series-level budget file.
   */
  episode: string
  provider: string
  model: string
  what: string
  currency: ChargeCurrency
  /** What the call is expected to cost, in `currency`. Checked before the call; the real cost replaces it afterwards when `actual` gives one. */
  estimate: number
}

export interface ChargeOptions<T> {
  /** The real cost read from the answer; undefined = the estimate is recorded. */
  actual?: (value: T) => number | undefined
}

export interface ChargeResult<T> {
  value: T
  /** What was written to spend.json. */
  amount: number
  currency: ChargeCurrency
  entry: LedgerEntry
}

const EPS = 1e-9
const tails = new Map<string, Promise<unknown>>()
const reservations = new Map<string, { usd: number; credits: number }>()

/** One promise chain per key: the callers run one after another, a failure does not block the next. */
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (tails.get(key) ?? Promise.resolve()).then(fn, fn)
  tails.set(key, next.catch(() => undefined))
  return next
}

const round = (n: number) => Math.round(n * 1e9) / 1e9

/** The caps, the spent amount and the open reservations of an episode. */
export async function budgetState(store: SeriesStore, series: string, episode: string): Promise<{ capUsd: number; flowCreditsCap: number; spentUsd: number; spentCredits: number; entries: LedgerEntry[]; approved: boolean }> {
  const budget = await store.readBudget(series, episode)
  const spend = await store.readSpend(series, episode)
  const sum = (c: ChargeCurrency) => round(spend.entries.filter((e) => e.currency === c).reduce((a, e) => a + e.amount, 0))
  return { capUsd: budget?.capUsd ?? 0, flowCreditsCap: budget?.flowCreditsCap ?? 0, spentUsd: sum('usd'), spentCredits: sum('credits'), entries: spend.entries, approved: budget !== null }
}

/**
 * Runs `run` only when `spent + reserved + estimate <= cap` for the currency (no budget.json = cap 0). The estimate is reserved under the
 * episode's lock, so two parallel calls cannot both pass. After `run` the real cost (or the estimate) is appended to spend.json; when `run`
 * throws, the reservation is dropped and nothing is recorded. Refusal throws `ChargeError` (`BUDGET_EXCEEDED` for usd, `FLOW_CREDITS_EXCEEDED` for credits).
 */
export async function charge<T>(args: ChargeArgs, run: () => Promise<T>, opts: ChargeOptions<T> = {}): Promise<ChargeResult<T>> {
  const { store, series, episode, currency } = args
  if (!(args.estimate >= 0)) throw new Error(`charge: estimate must be a number >= 0 (got ${args.estimate})`)
  const key = `${store.dataDir}|${series}|${episode}`
  const field = currency === 'usd' ? 'usd' : 'credits'
  await withLock(key, async () => {
    const st = await budgetState(store, series, episode)
    const cap = currency === 'usd' ? st.capUsd : st.flowCreditsCap
    const spent = currency === 'usd' ? st.spentUsd : st.spentCredits
    const open = reservations.get(key)?.[field] ?? 0
    if (spent + open + args.estimate > cap + EPS) {
      const unit = currency === 'usd' ? 'USD' : 'Flow credits'
      const what = `${args.provider}/${args.model} (${args.what}) needs ${args.estimate} ${unit}; ${spent} spent${open ? ` and ${open} reserved` : ''} of a ${cap} cap${st.approved ? '' : ' (no budget.json: the cap is 0 until the user approves one with cts_budget_set)'}`
      throw new ChargeError(currency === 'usd' ? 'BUDGET_EXCEEDED' : 'FLOW_CREDITS_EXCEEDED', what, { series, episode, currency, cap, spent, reserved: open, estimate: args.estimate, provider: args.provider, model: args.model, what: args.what })
    }
    const r = reservations.get(key) ?? { usd: 0, credits: 0 }
    r[field] += args.estimate
    reservations.set(key, r)
  })
  const release = () => {
    const r = reservations.get(key)
    if (r) r[field] = Math.max(0, round(r[field] - args.estimate))
  }
  let value: T
  try {
    value = await run()
  } catch (e) {
    await withLock(key, async () => release())
    throw e
  }
  const real = opts.actual?.(value)
  const amount = round(real !== undefined && Number.isFinite(real) && real >= 0 ? real : args.estimate)
  const entry: LedgerEntry = { t: localIso(new Date()), provider: args.provider, model: args.model, what: args.what, currency, amount }
  await withLock(key, async () => {
    release()
    const spend = await store.readSpend(series, episode)
    await store.writeSpend(series, episode, { schema: 'cts.spend/1', entries: [...spend.entries, entry] })
  })
  return { value, amount, currency, entry }
}
