import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { charge, ChargeError, reconcileEleven, settleElevenAfter } from '../src/engine/budget/spend'
import type { ChargeArgs } from '../src/engine/budget/spend'
import { SeriesStore } from '../src/engine/series/service'

/** The production budget gate: no budget.json = cap 0, refusal before the call, no double spend under parallel calls, a ledger, Flow credits. */

let dir: string
let store: SeriesStore
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cts-budget-'))
  store = new SeriesStore(dir)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

const args = (over: Partial<ChargeArgs> = {}): ChargeArgs => ({ store, series: 'mini', episode: 'ep00', provider: 'fal', model: 'fake', what: 'test', currency: 'usd', estimate: 0.04, ...over })
const approve = (capUsd: number, flowCreditsCap = 0) => store.writeBudget('mini', 'ep00', { schema: 'cts.budget/1', capUsd, flowCreditsCap, approvedBy: 'test', approvedAt: '2026-11-07T10:00:00+01:00', note: '' })
const spendRows = (usd: number, credits = 0) =>
  store.writeSpend('mini', 'ep00', {
    schema: 'cts.spend/1',
    entries: [
      ...(usd ? [{ t: '2026-11-07T10:00:00+01:00', provider: 'fal', model: 'fake', what: 'before', currency: 'usd', amount: usd }] : []),
      ...(credits ? [{ t: '2026-11-07T10:00:00+01:00', provider: 'flow', model: 'veo', what: 'before', currency: 'credits', amount: credits }] : [])
    ]
  })

describe('charge', () => {
  it('refuses with no budget.json (cap 0) before the call runs', async () => {
    let ran = false
    const err = await charge(args(), async () => ((ran = true), 1)).catch((e) => e)
    expect(err).toBeInstanceOf(ChargeError)
    expect(err.code).toBe('BUDGET_EXCEEDED')
    expect(err.message).toMatch(/^BUDGET_EXCEEDED/)
    expect(ran).toBe(false)
    expect((await store.readSpend('mini', 'ep00')).entries).toEqual([])
  })

  it('with a $1 cap and $0.95 spent refuses $0.08 and passes $0.04', async () => {
    await approve(1)
    await spendRows(0.95)
    await expect(charge(args({ estimate: 0.08 }), async () => 1)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
    const ok = await charge(args({ estimate: 0.04 }), async () => 'img')
    expect(ok.value).toBe('img')
  })

  it('lets only one of two parallel $0.04 calls through at $0.94 spent of $1', async () => {
    await approve(1)
    await spendRows(0.94)
    const run = async () => {
      await new Promise((r) => setTimeout(r, 30))
      return 'ok'
    }
    const results = await Promise.allSettled([charge(args(), run), charge(args(), run)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect((await store.readSpend('mini', 'ep00')).entries).toHaveLength(2)
  })

  it('writes the real cost of a fake paid image call to spend.json (the estimate when the API gives none)', async () => {
    await approve(1)
    await charge(args({ model: 'fake-a', estimate: 0.04 }), async () => ({ cost: 0.03 }), { actual: (v) => v.cost })
    await charge(args({ model: 'fake-b', estimate: 0.05 }), async () => ({}))
    const entries = (await store.readSpend('mini', 'ep00')).entries
    expect(entries.map((e) => [e.model, e.currency, e.amount])).toEqual([['fake-a', 'usd', 0.03], ['fake-b', 'usd', 0.05]])
  })

  it('refuses a 12-credit estimate with flowCreditsCap 30 and 24 spent (FLOW_CREDITS_EXCEEDED)', async () => {
    await approve(5, 30)
    await spendRows(0, 24)
    await expect(charge(args({ provider: 'flow', currency: 'credits', estimate: 12 }), async () => 1)).rejects.toMatchObject({ code: 'FLOW_CREDITS_EXCEEDED' })
    await expect(charge(args({ provider: 'flow', currency: 'credits', estimate: 6 }), async () => 1)).resolves.toMatchObject({ amount: 6, currency: 'credits' })
  })
})

describe('the ElevenLabs reconciliation (CTS-43)', () => {
  const OLD = '2026-04-01T08:14:55Z'
  const NEW = '2026-12-10T02:42:32Z'
  const at = '2026-11-09T10:00:00+01:00'

  it('pilot 4: judges the auditions within 10 %, reports the reset of the voice run apart and skips an unread status', () => {
    const r = reconcileEleven([
      { phase: 'auditions', what: 'audition pip hr', at, before: { used: 0, remaining: 10000, resetAt: OLD }, after: { used: 510, remaining: 9490, resetAt: OLD }, estimate: 553 },
      { phase: 'voice', what: 'voice hr,en', at, before: { used: 510, remaining: 9490, resetAt: OLD }, after: { used: 1037, remaining: 8963, resetAt: NEW }, estimate: 1037 },
      { phase: 'voice', what: 'voice en', at, before: { used: 1037, remaining: 8963, resetAt: NEW }, after: null, estimate: 40 }
    ])
    expect(r.phases[0]).toMatchObject({ reset: false, apiDelta: 510, withinTolerance: true })
    expect(r.phases[1]).toMatchObject({ reset: true, apiDelta: 1037, oldPeriodUsedBefore: 510, newPeriodWithinEstimate: true, withinTolerance: null })
    expect(r.phases[2]).toMatchObject({ apiDelta: null, withinTolerance: null })
    expect(r).toMatchObject({ withinTolerance: true, estimate: 553, apiDelta: 510, overspends: 0, resets: 1, unread: 1 })
  })

  it('flags a new period that alone used more than the estimate after a reset', () => {
    const r = reconcileEleven([{ phase: 'voice', what: 'voice hr,en', at, before: { used: 510, remaining: 9490, resetAt: OLD }, after: { used: 1200, remaining: 8800, resetAt: NEW }, estimate: 1037 }])
    expect(r.phases[0]).toMatchObject({ reset: true, newPeriodWithinEstimate: false, withinTolerance: false })
    expect(r).toMatchObject({ withinTolerance: false, overspends: 1 })
  })

  it('tolerates a lagging counter: the after-reading is read again, and the verdict sums the phases', async () => {
    const reads = [{ used: 510, remaining: 9490, resetAt: OLD }, { used: 540, remaining: 9460, resetAt: OLD }]
    const before = { used: 510, remaining: 9490, resetAt: OLD }
    await expect(settleElevenAfter(async () => reads.shift() ?? null, before, 30, { delayMs: 0 })).resolves.toMatchObject({ used: 540 })
    const r = reconcileEleven([
      { phase: 'auditions', what: 'audition pip hr', at, before, after: before, estimate: 30 },
      { phase: 'auditions', what: 'audition bruno hr', at, before, after: { used: 570, remaining: 9430, resetAt: OLD }, estimate: 30 }
    ])
    expect(r.phases.map((p) => p.withinTolerance)).toEqual([false, false])
    expect(r).toMatchObject({ withinTolerance: true, estimate: 60, apiDelta: 60 })
  })
})

describe('the gemini image provider', () => {
  it('is refused with BUDGET_EXCEEDED at cap $0 and the fake fetch is never called', async () => {
    const { geminiProvider } = await import('../src/engine/images/gemini')
    let calls = 0
    const fetchFn = (async () => ((calls += 1), new Response('{}'))) as unknown as typeof fetch
    const svc = { dataDir: dir } as unknown as import('../src/engine/service').CtsService
    await mkdir(path.join(dir, 'config'), { recursive: true })
    await writeFile(path.join(dir, 'config', 'prices.md'), '---\nkind: prices\nimages:\n  - { provider: gemini, model: gemini-2.5-flash-image, format: png, usd: 0.039 }\n---\n')
    const p = geminiProvider({ svc, store, series: 'mini', episode: 'ep00', what: 'test', fetchFn, getKey: () => 'k' })
    const err = await p.generate({ prompt: 'a squirrel', size: { width: 1024, height: 1024 }, format: 'png', out: path.join(dir, 'x') }).catch((e) => e)
    expect(err).toBeInstanceOf(ChargeError)
    expect(err.code).toBe('BUDGET_EXCEEDED')
    expect(calls).toBe(0)
  })
})
