import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allocateVoice, localChain, voiceReads } from '../src/engine/voice/allocate'
import type { AllocationInput, VoiceAvailability } from '../src/engine/voice/allocate'
import { DEFAULT_GEMINI_RESET_TZ, GeminiQuota, dayIn, quotaFile, quotaView } from '../src/engine/voice/quota'

/**
 * The hub's voice allocation rule (copied from Edu Studio EGS-17, CTS-06), pure: quota math per day and time zone, the counter persisting and resetting, Croatian first, a language
 * never split, forced providers, providers that are down.
 */

const up: VoiceAvailability = {
  gemini: { up: true },
  vibetts: { up: true, reads: (l) => ['en', 'hr', 'de'].includes(l) },
  comfy: { up: true, reads: () => true }
}
const down = (what: Partial<VoiceAvailability>): VoiceAvailability => ({ ...up, ...what })

const alloc = (o: Partial<AllocationInput> & { need: Record<string, number> }) => allocateVoice({ provider: 'auto', quota: { limit: 10, used: 0 }, avail: up, ...o })
const providers = (r: ReturnType<typeof alloc>): Record<string, string> => Object.fromEntries(Object.entries(r).map(([l, a]) => [l, a.provider]))

describe('quota math', () => {
  it('quota math: remaining, the configured time zone', () => {
  // remaining is limit - used and never negative; a counter of another day counts as 0
  {
    expect(quotaView({ day: '2026-10-30', used: 4 }, { limit: 10, tz: 'UTC', day: '2026-10-30' })).toEqual({ limit: 10, used: 4, remaining: 6, day: '2026-10-30', tz: 'UTC' })
    expect(quotaView({ day: '2026-10-30', used: 14 }, { limit: 10, tz: 'UTC', day: '2026-10-30' })).toMatchObject({ used: 14, remaining: 0 })
    expect(quotaView({ day: '2026-10-29', used: 9 }, { limit: 10, tz: 'UTC', day: '2026-10-30' })).toMatchObject({ used: 0, remaining: 10 })
    expect(quotaView(null, { limit: 0, tz: 'UTC', day: '2026-10-30' })).toMatchObject({ used: 0, remaining: 0 })
  }

  // the day follows the configured time zone; an unknown zone falls back to the default one
  {
    // summer time (UTC-7 until 2026-11-01): Pacific midnight is 07:00 UTC; winter time (UTC-8): 08:00 UTC
    expect(dayIn('America/Los_Angeles', new Date('2026-12-01T07:59:00Z'))).toBe('2026-11-30') // 23:59 on Nov 30
    expect(dayIn('America/Los_Angeles', new Date('2026-12-01T08:01:00Z'))).toBe('2026-12-01') // just after midnight
    expect(dayIn('America/Los_Angeles', new Date('2026-10-30T06:59:00Z'))).toBe('2026-10-29') // 23:59 on the 29th
    expect(dayIn('America/Los_Angeles', new Date('2026-10-30T07:01:00Z'))).toBe('2026-10-30') // midnight passed
    expect(dayIn('UTC', new Date('2026-10-30T07:01:00Z'))).toBe('2026-10-30')
    expect(dayIn('Pacific/Auckland', new Date('2026-10-30T12:00:00Z'))).toBe('2026-10-31')
    expect(dayIn('Not/AZone', new Date('2026-10-30T06:59:00Z'))).toBe(dayIn(DEFAULT_GEMINI_RESET_TZ, new Date('2026-10-30T06:59:00Z')))
  }
  })
})

describe('the Gemini counter in the data folder', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cts-quota-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('persists across instances, resets on a new day at midnight of the configured zone, and exhaust / reset work', async () => {
    let now = new Date('2026-10-30T06:00:00Z') // 23:00 on the 29th Pacific
    const make = () => new GeminiQuota(dir, { limit: 10, tz: 'America/Los_Angeles', now: () => now })
    const q = make()
    expect(await q.read()).toEqual({ limit: 10, used: 0, remaining: 10, day: '2026-10-29', tz: 'America/Los_Angeles' })
    expect((await q.add()).used).toBe(1)
    expect((await q.add(3)).remaining).toBe(6)
    expect(JSON.parse(await readFile(quotaFile(dir), 'utf8'))).toEqual({ day: '2026-10-29', used: 4 })
    expect((await make().read()).used).toBe(4) // another instance reads the same file

    now = new Date('2026-10-30T07:59:00Z') // after Pacific midnight (07:00 UTC): a new day
    expect(await q.read()).toMatchObject({ day: '2026-10-30', used: 0, remaining: 10 })
    expect((await q.add()).used).toBe(1)
    expect(JSON.parse(await readFile(quotaFile(dir), 'utf8'))).toEqual({ day: '2026-10-30', used: 1 })

    expect(await q.exhaust()).toMatchObject({ used: 10, remaining: 0 }) // a quota error from Google: used = limit for that day
    expect((await make().read()).remaining).toBe(0)
    expect(await q.reset()).toMatchObject({ used: 0, remaining: 10 })
    await q.add(25)
    expect(await q.read()).toMatchObject({ used: 25, remaining: 0 }) // never negative

    now = new Date('2026-10-31T08:01:00Z') // the next day
    expect(await q.read()).toMatchObject({ day: '2026-10-31', used: 0 })
    await q.reset()
    await Promise.all([1, 2, 3, 4, 5].map(() => q.add())) // concurrent adds are not lost
    expect((await q.read()).used).toBe(5)
  })
})

describe('the allocation rule', () => {
  it('Croatian is allocated first and takes the Gemini quota; English falls to VibeTTS when both do not fit; a language is never split', () => {
    const fit = alloc({ need: { hr: 4, en: 3 } })
    expect(providers(fit)).toEqual({ hr: 'gemini', en: 'gemini' })
    expect(fit.hr!.chain).toEqual(['gemini', 'comfy', 'vibetts']) // CTS-06: the local chain of hr is OmniVoice first
    expect(Object.keys(alloc({ need: { de: 1, en: 1, hr: 1 } }))).toEqual(['hr', 'en', 'de'])
    const over = alloc({ need: { hr: 6, en: 5 } })
    expect(providers(over)).toEqual({ hr: 'gemini', en: 'vibetts' })
    expect(over.en!.chain).toEqual(['vibetts', 'comfy'])
    expect(over.en!.reason).toMatch(/do not fit in the 4 Gemini request\(s\) left today/)
    // 3 left: hr 4 does not fit, en 2 does -> hr local, en Gemini (not 3 + 1 split)
    expect(providers(alloc({ need: { hr: 4, en: 2 }, quota: { limit: 10, used: 7 } }))).toEqual({ hr: 'comfy', en: 'gemini' })
    for (const a of Object.values(over)) expect(a.chain[0]).toBe(a.provider)
    expect(alloc({ need: { hr: 0, en: 2 }, quota: { limit: 10, used: 9 } }).hr).toMatchObject({ provider: 'none', chain: [] })
  })

  it('falls back everywhere: nothing fits, forced providers, a provider down', () => {
  // everything is local when nothing fits, the quota is used up, over the limit or the limit is 0
  {
    expect(providers(alloc({ need: { hr: 11, en: 11 } }))).toEqual({ hr: 'comfy', en: 'vibetts' })
    expect(providers(alloc({ need: { hr: 1, en: 1 }, quota: { limit: 10, used: 10 } }))).toEqual({ hr: 'comfy', en: 'vibetts' })
    expect(providers(alloc({ need: { hr: 1 }, quota: { limit: 0, used: 0 } }))).toEqual({ hr: 'comfy' })
    expect(providers(alloc({ need: { hr: 1 }, quota: { limit: 10, used: 25 } }))).toEqual({ hr: 'comfy' })
  }

  // forced vibetts and comfy never use Gemini; forced gemini still respects the quota
  {
    expect(alloc({ need: { hr: 1 }, provider: 'vibetts' }).hr!.chain).toEqual(['vibetts', 'comfy'])
    expect(alloc({ need: { hr: 1 }, provider: 'comfy' }).hr!.chain).toEqual(['comfy', 'vibetts'])
    expect(providers(alloc({ need: { hr: 2, en: 9 }, provider: 'gemini', quota: { limit: 10, used: 5 } }))).toEqual({ hr: 'gemini', en: 'vibetts' })
    expect(providers(alloc({ need: { hr: 6 }, provider: 'gemini', quota: { limit: 10, used: 5 } }))).toEqual({ hr: 'comfy' })
  }

  // falls back when a provider is down, and with all down gives provider none and a reason (placeholders, never a failed run)
  {
    const geminiDown = alloc({ need: { hr: 1, en: 1 }, avail: down({ gemini: { up: false, reason: 'flow-music-mcp is not running' } }) })
    expect(providers(geminiDown)).toEqual({ hr: 'comfy', en: 'vibetts' })
    expect(geminiDown.hr!.reason).toMatch(/Gemini is not available \(flow-music-mcp is not running\)/)
    const noHr = down({ vibetts: { up: true, reads: (l) => l === 'en' } })
    expect(providers(alloc({ need: { hr: 1, en: 1 }, quota: { limit: 10, used: 10 }, avail: noHr }))).toEqual({ hr: 'comfy', en: 'vibetts' })
    expect(localChain('hr', 'auto', down({ comfy: { up: true, reads: () => false } }))).toEqual(['vibetts'])
    const none = down({ gemini: { up: false, reason: 'not running' }, vibetts: { up: false, reads: () => false, reason: 'VibeTTS is not running' }, comfy: { up: true, reads: () => false, reason: 'no engine' } })
    const r = alloc({ need: { hr: 2, en: 1 }, avail: none })
    expect(providers(r)).toEqual({ hr: 'none', en: 'none' })
    expect(r.hr!.reason).toMatch(/nothing can speak hr.*VibeTTS is not available \(VibeTTS is not running\).*ComfyUI TTS does not read hr.*placeholders/)
  }
  })
})

describe('German (EGS-33)', () => {
  it('Kokoro never reads de or hr even if a listing claims it, so with Kokoro only German has no provider; with Supertonic it goes to VibeTTS', () => {
    expect(voiceReads({ engine: 'kokoro', languages: ['de', 'en'] }, 'de')).toBe(false)
    expect(voiceReads({ engine: 'supertonic', languages: ['de'] }, 'de')).toBe(true)
    const kokoroOnly = down({ vibetts: { up: true, reads: (l) => voiceReads({ engine: 'kokoro', languages: ['en', 'de'] }, l) }, comfy: { up: true, reads: () => false } })
    expect(alloc({ need: { de: 4 }, avail: kokoroOnly, provider: 'vibetts' }).de).toMatchObject({ provider: 'none', chain: [] })
    expect(providers(alloc({ need: { hr: 4, de: 40 } }))).toEqual({ hr: 'gemini', de: 'vibetts' })
  })
})

describe('the local chain from config/voice.md localOrder (CTS-06)', () => {
  it('14 hr clips with 10 Gemini requests left go local: hr OmniVoice then Supertonic, en Kokoro then OmniVoice; a configured order wins', () => {
    const r = alloc({ need: { hr: 14, en: 3 }, quota: { limit: 10, used: 0 } })
    // hr does not fit in the 10 left, so it is local; en (3) then fits in the 10 and takes Gemini
    expect(providers(r)).toEqual({ hr: 'comfy', en: 'gemini' })
    expect(r.hr!.chain).toEqual(['comfy', 'vibetts'])
    expect(r.hr!.reason).toMatch(/14 clip\(s\) do not fit in the 10 Gemini request\(s\) left today/)
    // the pilot case: both languages local (12+ lines each, quota used up): the chains differ per language
    const local = alloc({ need: { hr: 14, en: 14 } })
    expect(providers(local)).toEqual({ hr: 'comfy', en: 'vibetts' })
    expect(local.hr!.chain).toEqual(['comfy', 'vibetts'])
    expect(local.en!.chain).toEqual(['vibetts', 'comfy'])
    // OmniVoice down: Supertonic (VibeTTS) takes hr; VibeTTS down: OmniVoice takes en
    expect(alloc({ need: { hr: 14 }, avail: down({ comfy: { up: false, reads: () => false } }) }).hr!.chain).toEqual(['vibetts'])
    expect(alloc({ need: { en: 14 }, avail: down({ vibetts: { up: false, reads: () => false } }) }).en!.chain).toEqual(['comfy'])
    // the order of config/voice.md wins over the default
    expect(alloc({ need: { hr: 14 }, localOrder: { hr: ['vibetts', 'comfy'] } }).hr!.chain).toEqual(['vibetts', 'comfy'])
  })
})
