import { promises as fs } from 'node:fs'
import path from 'node:path'
import { atomicWrite } from '../store/atomic'

/**
 * The daily counter of Gemini TTS requests (the hub's voice rule, EGS-17). Google's free Gemini voices allow a handful of requests a day (10), so the
 * voice step counts every `flow_narrate` request that reaches Gemini (a retry too) in `state/gemini-tts.json` (`{day, used}`), and a quota error from
 * Google sets `used` to the limit for that day. The day is the calendar day in a configurable time zone (default `America/Los_Angeles`: the free tier
 * resets at Pacific midnight), so a new day starts the count at 0 again.
 */

export const DEFAULT_GEMINI_DAILY_LIMIT = 10
export const DEFAULT_GEMINI_RESET_TZ = 'America/Los_Angeles'

export interface QuotaState {
  /** `YYYY-MM-DD` in the reset time zone. */
  day: string
  used: number
}

export interface QuotaView {
  limit: number
  used: number
  remaining: number
  day: string
  /** The time zone the day is counted in. */
  tz: string
}

/** The calendar day (`YYYY-MM-DD`) of `now` in `tz`; an unknown zone falls back to the default one. */
export function dayIn(tz: string, now: Date): string {
  const fmt = (zone: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  try {
    return fmt(tz)
  } catch {
    return fmt(DEFAULT_GEMINI_RESET_TZ)
  }
}

/** The view of a stored state on `day`: a counter of another day counts as 0 (the quota reset). Pure. */
export function quotaView(state: QuotaState | null, o: { limit: number; tz: string; day: string }): QuotaView {
  const used = state && state.day === o.day ? Math.max(0, Math.floor(state.used)) : 0
  return { limit: o.limit, used, remaining: Math.max(0, o.limit - used), day: o.day, tz: o.tz }
}

export const quotaFile = (dataDir: string): string => path.join(dataDir, 'state', 'gemini-tts.json')

export interface QuotaOptions {
  limit: number
  tz: string
  now?: () => Date
}

/** The counter in the data folder. One instance per engine; the read-modify-write steps are serialised, so two jobs never lose a count. */
export class GeminiQuota {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dataDir: string,
    private readonly o: QuotaOptions
  ) {}

  private day(): string {
    return dayIn(this.o.tz, (this.o.now ?? (() => new Date()))())
  }

  private async load(): Promise<QuotaState | null> {
    try {
      const v = JSON.parse(await fs.readFile(quotaFile(this.dataDir), 'utf8')) as Partial<QuotaState>
      return typeof v.day === 'string' && typeof v.used === 'number' ? { day: v.day, used: v.used } : null
    } catch {
      return null
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }

  private view(state: QuotaState | null): QuotaView {
    return quotaView(state, { limit: this.o.limit, tz: this.o.tz, day: this.day() })
  }

  /** Today's count. */
  read(): Promise<QuotaView> {
    return this.serial(async () => this.view(await this.load()))
  }

  /** One more request reached Gemini (call it BEFORE the request: a failed request counts too). */
  add(n = 1): Promise<QuotaView> {
    return this.serial(async () => {
      const v = this.view(await this.load())
      await atomicWrite(quotaFile(this.dataDir), JSON.stringify({ day: v.day, used: v.used + n }, null, 2) + '\n')
      return this.view({ day: v.day, used: v.used + n })
    })
  }

  /** Google said the day's quota is used up: `used` becomes the limit for today. */
  exhaust(): Promise<QuotaView> {
    return this.serial(async () => {
      const day = this.day()
      await atomicWrite(quotaFile(this.dataDir), JSON.stringify({ day, used: this.o.limit }, null, 2) + '\n')
      return this.view({ day, used: this.o.limit })
    })
  }

  /** Back to 0 for today (a manual fix, or a test). */
  reset(): Promise<QuotaView> {
    return this.serial(async () => {
      const day = this.day()
      await atomicWrite(quotaFile(this.dataDir), JSON.stringify({ day, used: 0 }, null, 2) + '\n')
      return this.view({ day, used: 0 })
    })
  }
}
