import { readFile, readdir, rm, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Engine } from '../src/engine/engine'
import { MockProvider } from '../src/engine/models/mock'
import { initDataFolder } from '../src/engine/store/dataFolder'
import { parseMd } from '../src/shared/md'
import { ROLES } from '../src/shared/schemas'
import { seedDir } from './helpers'

/** The seed makes a data folder the engine starts on: the eight roles, no paid model, $0 caps, the voice chain, and the empty series list. */

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  dir = undefined
})

describe('the seed', () => {
  it('starts an engine: eight roles on client/claude-code, strata, lmstudio; no paid alias; $0 budget; hr voice chain; no series', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cts-seed-'))
    await initDataFolder(dir, seedDir)
    const logs: string[] = []
    const engine = new Engine({ dataDir: dir, emit: () => undefined, log: (m) => logs.push(m), registry: { mock: new MockProvider('mock') }, discover: false })
    await engine.start()
    try {
      expect(logs.filter((l) => /invalid|roles.md|names no row/.test(l))).toEqual([])
      const roles = Object.keys(engine.registry.roles.roles).sort()
      expect(roles).toEqual([...ROLES].sort())
      for (const r of ROLES) expect(engine.registry.roles.roles[r]!.models, r).toEqual(['client/claude-code', 'strata', 'lmstudio'])
      expect(engine.agents.list().map((a) => a.data.role).sort()).toEqual([...ROLES].sort())
      expect(engine.cts.seriesModel('any', 'writer')).toBeUndefined()
      expect(await engine.cts.listSeries()).toEqual([])
      expect(engine.budget.caps).toMatchObject({ monthly_cap_usd: 0, daily_cap_usd: 0, voice: { paidMaxUsd: 0 } })
    } finally {
      await engine.stop()
    }

    const cfg = async (name: string) => parseMd(await readFile(path.join(dir!, 'config', name), 'utf8'), name).data
    expect(await cfg('voice.md')).toMatchObject({ localOrder: { hr: ['comfy', 'vibetts'], en: ['vibetts', 'comfy'] }, geminiDailyLimit: 10 })
    expect(await cfg('providers.md')).toMatchObject({ comfy: { imageModel: 'z-image-turbo', alternatives: ['krea2-turbo'] } })
    expect(await cfg('render.md')).toMatchObject({ fps: { anim: 12, out: 24 }, final: { width: 1920, height: 1080 }, frameFormat: 'jpeg', loudness: { lufs: -16, truePeak: -1.5 } })
    expect((await readdir(path.join(seedDir, 'config'))).sort()).toEqual(['autostart.md', 'budget.md', 'providers.md', 'render.md', 'roles.md', 'settings.md', 'studios.md', 'voice.md'])
  })
})
