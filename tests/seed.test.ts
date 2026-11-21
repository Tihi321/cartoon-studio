import { mkdir, readFile, readdir, rm, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Engine } from '../src/engine/engine'
import { MockProvider } from '../src/engine/models/mock'
import { initDataFolder } from '../src/engine/store/dataFolder'
import { applySeedMigrations } from '../src/engine/store/seedMigrations'
import { emptySeedState, refreshStarterAgents, seedHash } from '../src/engine/store/seedRefresh'
import { parseMd } from '../src/shared/md'
import { LOCAL_MODEL, ROLES } from '../src/shared/schemas'
import { SeriesStore } from '../src/engine/series/service'
import { seedDir } from './helpers'

/** The seed makes a data folder the engine starts on: the eight roles, no paid model, $0 caps, the voice chain, and the empty series list. */

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  dir = undefined
})

describe('the seed', () => {
  it('CTS-47: the 3D wording leads: no cutout or paper in the personas or in the prompts before their old-canvas section, and a new series starts with the toon 3D style', async () => {
    const files = ['agents/background-artist-mira-castellan.md', 'agents/character-designer-priya-nakamura.md', 'agents/writer-jonas-reyes.md', 'agents/showrunner-mara-quill.md', 'prompts/showrunner/bible.md', 'prompts/showrunner/pitches.md', 'prompts/showrunner/clip-shots.md', 'prompts/frame-critic/clip-review.md', 'prompts/writer/script.md']
    for (const f of files) {
      const text = await readFile(path.join(seedDir, f), 'utf8')
      const head = f.startsWith('agents/') ? text.split(/In an old canvas series|Only an old canvas series|In a canvas series/)[0]! : text.split(/## An old canvas series/)[0]!
      expect(head, f).not.toMatch(/cut-?out|paper|puppet/i)
    }
    const voice = await readFile(path.join(seedDir, 'agents/voice-director-elodie-brandt.md'), 'utf8')
    expect(voice.indexOf('ElevenLabs')).toBeGreaterThan(-1)
    expect(voice.indexOf('ElevenLabs')).toBeLessThan(voice.indexOf('Gemini TTS'))
    expect(await readFile(path.join(seedDir, 'config/roles.md'), 'utf8')).toMatch(/`character-designer`: writes each character as a 3D toon spec/)
    dir = await mkdtemp(path.join(os.tmpdir(), 'cts-seed-'))
    const store = new SeriesStore(dir)
    expect((await store.createSeries('new3d', { title: 'New' })).style).toMatchObject({ outlinePx: 2, look: expect.stringContaining('toon 3D') })
    expect((await store.createSeries('old', { title: 'Old', renderer: 'canvas' })).style.look).toContain('paper cutout')
  })


  it('CTS-48: a starter agent still as an earlier seed gets the new text; an edited one stays and a fired one does not come back', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cts-agents-'))
    await mkdir(path.join(dir, 'agents'))
    const old = ['old writer, cutout-puppet', ''].join(String.fromCharCode(13, 10))
    await writeFile(path.join(dir, 'agents', 'writer-jonas-reyes.md'), old)
    await writeFile(path.join(dir, 'agents', 'showrunner-mara-quill.md'), 'my own showrunner')
    const updated = await refreshStarterAgents(seedDir, dir, { 'agents/writer-jonas-reyes.md': [seedHash(old)], 'agents/showrunner-mara-quill.md': [seedHash('old showrunner')] })
    expect(updated).toEqual(['agents/writer-jonas-reyes.md'])
    expect(await readFile(path.join(dir, 'agents', 'writer-jonas-reyes.md'), 'utf8')).toBe(await readFile(path.join(seedDir, 'agents', 'writer-jonas-reyes.md'), 'utf8'))
    expect(await readFile(path.join(dir, 'agents', 'showrunner-mara-quill.md'), 'utf8')).toBe('my own showrunner')
    expect((await readdir(path.join(dir, 'agents'))).sort()).toEqual(['showrunner-mara-quill.md', 'writer-jonas-reyes.md'])
  })

  it('CTS-54: migration acp-port-8787-v1 moves only the exact 7461 base_url of acp, once, and does not switch acp on', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cts-mig-'))
    await mkdir(path.join(dir, 'config'))
    const file = path.join(dir, 'config', 'providers.md')
    const mk = (url: string) => ['---', 'kind: providers', 'providers:', '  - id: acp', '    enabled: false', `    base_url: ${url}`, '---', 'body', ''].join('\n')
    for (const [from, to] of [['http://127.0.0.1:7461/v1', 'http://127.0.0.1:8787/v1'], ['http://10.0.0.5:7461/v1', 'http://10.0.0.5:7461/v1']] as const) {
      await writeFile(file, mk(from))
      const state = emptySeedState()
      await applySeedMigrations(dir, seedDir, state)
      expect(state.migrations).toContain('acp-port-8787-v1')
      expect(await readFile(file, 'utf8')).toBe(mk(to))
    }
    const state = emptySeedState()
    state.migrations.push('acp-port-8787-v1')
    await writeFile(file, mk('http://127.0.0.1:7461/v1'))
    await applySeedMigrations(dir, seedDir, state)
    expect(await readFile(file, 'utf8')).toBe(mk('http://127.0.0.1:7461/v1'))
  })

  it('starts an engine: eight roles on client/claude-code then the local acp model (frame-critic: lmstudio); acp on at 8787, strata off; no paid alias; $0 budget; hr voice chain; no series', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cts-seed-'))
    await initDataFolder(dir, seedDir)
    const logs: string[] = []
    const engine = new Engine({ dataDir: dir, emit: () => undefined, log: (m) => logs.push(m), registry: { mock: new MockProvider('mock') }, discover: false })
    await engine.start()
    try {
      expect(logs.filter((l) => /invalid|roles.md|names no row/.test(l))).toEqual([])
      const roles = Object.keys(engine.registry.roles.roles).sort()
      expect(roles).toEqual([...ROLES].sort())
      for (const r of ROLES) expect(engine.registry.roles.roles[r]!.models, r).toEqual(['client/claude-code', r === 'frame-critic' ? 'lmstudio' : 'acp'])
      expect(engine.registry.resolve('acp')).toBe(LOCAL_MODEL)
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
    const provs = ((await cfg('providers.md')).providers as { id: string; enabled?: boolean; base_url?: string; models: { id: string }[] }[])
    const acp = provs.find((p) => p.id === 'acp')!
    expect(acp).toMatchObject({ enabled: true, base_url: 'http://127.0.0.1:8787/v1' })
    expect(acp.models.map((m) => m.id)).toEqual(['strata/qwen3.8-flash-next-unsloth-ud-iq4_xs', 'gufo/Qwen3.8-27B', 'gufo/deepseek4', 'gufo/flash-next-q4', 'llama/inkling-2-mini', 'llama/inkling-2-mini-dspark'])
    expect(provs.find((p) => p.id === 'strata')!.enabled).toBe(false)
    expect(await cfg('render.md')).toMatchObject({ fps: { anim: 12, out: 24 }, final: { width: 1920, height: 1080 }, frameFormat: 'jpeg', loudness: { lufs: -16, truePeak: -1.5 } })
    expect((await readdir(path.join(seedDir, 'config'))).sort()).toEqual(['autostart.md', 'blender.md', 'budget.md', 'prices.md', 'providers.md', 'render.md', 'roles.md', 'settings.md', 'studios.md', 'voice.md'])
  })
})
