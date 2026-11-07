import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { charge, ChargeError } from '../src/engine/budget/spend'
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
