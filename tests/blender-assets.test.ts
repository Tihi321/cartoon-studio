import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { def } from '../src/engine/mcp/tools'
import { blenderTools } from '../src/engine/blender/tools'
import { buildCharacter } from '../src/engine/blender/jobs'
import { BlenderError } from '../src/engine/blender/runner'
import type { BlenderRunner } from '../src/engine/blender/runner'
import type { CtsService } from '../src/engine/service'
import { SeriesStore } from '../src/engine/series/service'
import { character3dSchema, style3dSchema } from '../src/shared/contracts'
import { installMini3d } from './fixtures/mini3d'

/** CTS-20/21: the asset tools and jobs against a fake Blender runner: spec in, job result out, spec mistakes come back as the result. */

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cts-assets-'))
  await installMini3d(dir)
})
afterEach(async () => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }))

function fakeRunner(answer: () => Record<string, unknown> | Error) {
  const calls: { command: string; job: Record<string, unknown> }[] = []
  const runner = {
    config: {},
    status: async () => ({ ok: true }),
    run: async (command: string, job: Record<string, unknown>, o?: { onProgress?: (e: { done: number; total: number; stage?: string }) => void }) => {
      calls.push({ command, job })
      o?.onProgress?.({ done: 1, total: 2, stage: 'build' })
      const a = answer()
      if (a instanceof Error) throw a
      return a
    }
  } as unknown as BlenderRunner
  return { runner, calls }
}

describe('character tools and job', () => {
  it('the default look file is a valid cts.style3d/1', async () => {
    const seed = JSON.parse(await readFile(path.resolve(__dirname, '../seed/style/style3d.json'), 'utf8')) as unknown
    expect(style3dSchema.parse(seed).toon.shade).toBe(0.74)
  })

  it('the examples in seed/style/toon-3d.md (Pip and Bruno) are valid character specs', async () => {
    const md = await readFile(path.resolve(__dirname, '../seed/style/toon-3d.md'), 'utf8')
    const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]!) as unknown)
    expect(blocks.map((b) => character3dSchema.parse(b).id)).toEqual(['pip', 'bruno'])
  })

  it('cts_character_set checks the spec and the id; the build passes spec, outDir and the series look to Blender', async () => {
    const svc = { dataDir: dir, seriesExists: async () => true } as unknown as CtsService
    const tool = blenderTools(svc, def).find((t) => t.name === 'cts_character_set')!
    const store = new SeriesStore(dir)
    const spec = (await store.readCharacter3d('mini3d', 'tilly')) as unknown as Record<string, unknown>
    const run = (a: unknown) => tool.run(z.object({ series: z.string(), cast: z.string(), spec: z.record(z.string(), z.unknown()) }).parse(a) as never)
    await expect(run({ series: 'mini3d', cast: 'blobby', spec })).rejects.toThrow(/must be the cast id/)
    await expect(run({ series: 'mini3d', cast: 'tilly', spec: { ...spec, parts: [] } })).rejects.toThrow()
    await expect(run({ series: 'mini3d', cast: 'tilly', spec })).resolves.toMatchObject({ specHash: expect.stringMatching(/^[0-9a-f]{40}$/) })

    const progress: number[] = []
    const { runner, calls } = fakeRunner(() => ({ blend: 'b', sheet: 's', build: 'j', specHash: 'h', warnings: ['w'], buildSeconds: 2, hash: {} }))
    const r = await buildCharacter({ dataDir: dir, series: 'mini3d', id: 'tilly', runner, onProgress: (f) => progress.push(f) })
    expect(r).toMatchObject({ ok: true, blend: 'b', warnings: ['w'] })
    expect(progress).toEqual([0.5])
    expect(calls[0]!.command).toBe('build-character')
    expect(calls[0]!.job).toMatchObject({ sheet: true, spec: expect.stringContaining('character.json'), outDir: expect.stringContaining('tilly'), style: expect.stringContaining('style3d.json') })
  })

  it('E_FACE_HIDDEN comes back as the result, Blender failures throw', async () => {
    const hidden = fakeRunner(() => new BlenderError('E_FACE_HIDDEN', 'the mouth is buried'))
    await expect(buildCharacter({ dataDir: dir, series: 'mini3d', id: 'tilly', runner: hidden.runner })).resolves.toEqual({ ok: false, kind: 'character', id: 'tilly', code: 'E_FACE_HIDDEN', message: 'the mouth is buried' })
    const broken = fakeRunner(() => new BlenderError('E_BLENDER_FAILED', 'crash'))
    await expect(buildCharacter({ dataDir: dir, series: 'mini3d', id: 'tilly', runner: broken.runner })).rejects.toThrow(/E_BLENDER_FAILED/)
  })
})
