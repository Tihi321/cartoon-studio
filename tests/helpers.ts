import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Engine } from '../src/engine/engine'
import type { EngineOptions } from '../src/engine/engine'
import { MockProvider } from '../src/engine/models/mock'
import { initDataFolder } from '../src/engine/store/dataFolder'
import { writeMd } from '../src/engine/store/atomic'
import type { EngineEvent } from '../src/shared/protocol'

export const seedDir = path.resolve(__dirname, '../seed')

export interface TestProvider {
  id: string
  local?: boolean
  concurrency?: number
  /** USD per 1M tokens. Default 0. */
  price?: number
  family?: string
  models?: string[]
  /** `client`: its model calls wait in the client task queue for an MCP client. Default `mock`. */
  kind?: 'mock' | 'client'
  vision?: boolean
}

export interface EnvOptions {
  providers?: TestProvider[]
  /** role -> `provider/model` refs */
  roles?: Record<string, string[]>
  caps?: { monthly?: number; daily?: number; perBook?: number | null }
  agents?: { role: string; name: string; model?: string | null; maxParallel?: number; paused?: boolean; focus?: string[]; pin?: string | null }[]
  paused?: boolean
}

/** Writes providers, roles, budget, factory and agent files for a mock-only data folder. */
export async function writeTestConfig(dir: string, o: EnvOptions): Promise<void> {
  const providers = o.providers ?? [{ id: 'loc', local: true, concurrency: 4, models: ['m1'] }]
  await writeMd(
    path.join(dir, 'config', 'providers.md'),
    {
      kind: 'providers',
      providers: providers.map((p) => ({
        id: p.id,
        kind: p.kind ?? 'mock',
        local: p.local ?? false,
        concurrency: p.concurrency ?? 4,
        models: (p.models ?? ['m1']).map((m) => ({
          id: m,
          family: p.family ?? p.id,
          price_in: p.price ?? 0,
          price_out: p.price ?? 0,
          ...(p.vision ? { vision: true } : {})
        }))
      }))
    },
    'test providers\n'
  )
  const roles = o.roles ?? {}
  await writeMd(
    path.join(dir, 'config', 'roles.md'),
    { kind: 'roles', roles: Object.fromEntries(Object.entries(roles).map(([r, models]) => [r, { models }])) },
    'test roles\n'
  )
  await writeMd(
    path.join(dir, 'config', 'budget.md'),
    {
      kind: 'budget',
      monthly_cap_usd: o.caps?.monthly ?? 40,
      daily_cap_usd: o.caps?.daily ?? 5,
      per_book_cap_usd: o.caps?.perBook ?? null,
      warn_at: 0.8
    },
    '# Budget\n\nhand written text\n'
  )
  await writeMd(path.join(dir, 'config', 'factory.md'), { kind: 'factory', paused: o.paused ?? false, max_attempts: 3 }, 'factory\n')
  for (const a of o.agents ?? []) {
    const id = `${a.role}-${a.name.toLowerCase().replace(/\W+/g, '-')}`
    await writeMd(
      path.join(dir, 'agents', `${id}.md`),
      { kind: 'agent', role: a.role, name: a.name, model: a.model ?? null, focus: a.focus ?? [], pin: a.pin ?? null, max_parallel: a.maxParallel ?? 1, paused: a.paused ?? false },
      `Persona of ${a.name}.\n`
    )
  }
}

export interface TestEnv {
  dir: string
  engine: Engine
  mock: MockProvider
  events: EngineEvent[]
  logs: string[]
  /** A fresh engine on the same folder with the same options (stop the first one before); `cleanup` stops it as well. */
  reopen(): Promise<Engine>
  cleanup(): Promise<void>
}

/** A temp data folder with mock providers and a started engine. */
export async function makeEnv(o: EnvOptions = {}, engineOpts: Partial<EngineOptions> = {}): Promise<TestEnv> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cts-engine-'))
  await initDataFolder(dir, seedDir)
  await rm(path.join(dir, 'agents'), { recursive: true, force: true }) // tests bring their own staff
  await mkdir(path.join(dir, 'agents'), { recursive: true })
  await writeTestConfig(dir, o)
  const events: EngineEvent[] = []
  const logs: string[] = []
  const mock = new MockProvider('mock', { chunkDelayMs: 5 })
  const options: EngineOptions = {
    dataDir: dir,
    emit: (e) => events.push(e),
    log: (m) => logs.push(m),
    registry: { mock },
    router: { backoffMs: 1, retries: 1 },
    pollMs: 40,
    discover: false,
    ...engineOpts
  }
  const engine = new Engine(options)
  await engine.start()
  const reopened: Engine[] = []
  return {
    async reopen() {
      const next = new Engine(options)
      await next.start()
      reopened.push(next)
      return next
    },
    dir,
    engine,
    mock,
    events,
    logs,
    async cleanup() {
      for (const e of reopened) await e.stop()
      await engine.stop()
      await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
    }
  }
}

export async function waitFor<T>(fn: () => T | Promise<T>, ms = 8000, label = 'condition'): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

