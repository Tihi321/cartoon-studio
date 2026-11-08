import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { setBlenderRunnerOverride } from '../src/engine/blender/runner'
import type { BlenderRunner } from '../src/engine/blender/runner'
import type { ChatRequest } from '../src/engine/models/types'
import { BLENDER_STEPS } from '../src/engine/pipeline/steps'
import { Pipeline, specHashOf } from '../src/engine/pipeline/run'
import { SeriesStore } from '../src/engine/series/service'
import { loadVoiceConfig, planClips } from '../src/engine/voice/run'
import { sha1 } from '../src/engine/blender/jobs'
import { makeEnv, waitFor } from './helpers'
import type { TestEnv } from './helpers'
import { MINI3D_DIR, installMini3d } from './fixtures/mini3d'

/**
 * The 3D pipeline (CTS-27): `cts_run_pipeline` on the fixture `mini3d` with the mock provider and a fake Blender runner goes from the given pitch to `done`:
 * character spec + build + self-review (one revision here), the pause for the user's approval of the sheets (nothing is built for a set before), sets,
 * the kept script, safety, voices, 3D timelines, assemble, preview, frame review and final renders in both languages. No Blender, no service, no spend.
 */

let env: TestEnv | undefined
afterEach(async () => {
  setBlenderRunnerOverride(undefined)
  await env?.cleanup()
  env = undefined
})

const ROLES = ['showrunner', 'character-designer', 'background-artist', 'writer', 'child-safety-reviewer', 'voice-director', 'composer', 'frame-critic']

/** The fields of the job JSON that the fake reads. */
interface FakeJob {
  spec: string
  outDir: string
  timeline: string
  ranges: [number, number][]
  chunkFrames: number
  timesFile: string
  width: number
  height: number
  samples: number
  out: string
}

/** A Blender that writes what the real commands write (files, hashes) and renders 64x36 grey frames. */
function fakeBlender(dir: string): { runner: BlenderRunner; calls: { command: string; id?: string }[] } {
  const calls: { command: string; id?: string }[] = []
  let png: Buffer
  const grey = async (): Promise<Buffer> => (png ??= await sharp({ create: { width: 64, height: 36, channels: 3, background: '#8a8a8a' } }).png().toBuffer())
  const runner = {
    config: {},
    status: async () => ({ ok: true }),
    async run(command: string, job: FakeJob, o?: { onProgress?: (e: unknown) => void; onChunk?: (e: unknown) => void }) {
      o?.onProgress?.({ type: 'progress', done: 1, total: 2, stage: command })
      if (command === 'build-character' || command === 'build-set') {
        const spec = await readFile(job.spec)
        const id = JSON.parse(spec.toString('utf8')).id as string
        calls.push({ command, id })
        const kind = command === 'build-character' ? 'character' : 'set'
        await mkdir(job.outDir, { recursive: true })
        await writeFile(path.join(job.outDir, `${kind}.blend`), 'blend')
        await writeFile(path.join(job.outDir, 'sheet.png'), await grey())
        await writeFile(path.join(job.outDir, 'build.json'), JSON.stringify({ specHash: sha1(spec), buildSeconds: 1.5, warnings: [] }))
        return { blend: path.join(job.outDir, `${kind}.blend`), sheet: path.join(job.outDir, 'sheet.png'), build: path.join(job.outDir, 'build.json'), specHash: sha1(spec), warnings: [], buildSeconds: 1.5, hash: {} }
      }
      calls.push({ command })
      if (command === 'assemble') {
        const timeline = JSON.parse(await readFile(job.timeline, 'utf8')) as { duration: number }
        await mkdir(job.outDir, { recursive: true })
        await writeFile(path.join(job.outDir, 'scene.blend'), 'scene')
        await writeFile(path.join(job.outDir, 'assembly.json'), JSON.stringify({ timelineHash: sha1(await readFile(job.timeline)) }))
        return { blend: path.join(job.outDir, 'scene.blend'), assembly: path.join(job.outDir, 'assembly.json'), frames: Math.ceil(timeline.duration * 24), actions: ['wave', 'point', 'walk', 'sit'], shots: 3, warnings: [], assembleSeconds: 0.2 }
      }
      if (command === 'render') {
        const frames = job.ranges.flatMap(([a, b]) => Array.from({ length: b - a }, (_, i) => a + i))
        let index = 0
        for (const [from, to] of job.ranges) {
          for (let start = from; start < to; start += job.chunkFrames) {
            const end = Math.min(to, start + job.chunkFrames)
            const dir = path.join(job.outDir, `chunk-${index}`)
            await mkdir(dir, { recursive: true })
            for (let f = start; f < end; f++) await writeFile(path.join(dir, `f_${String(f + 1).padStart(5, '0')}.png`), await grey())
            o?.onChunk?.({ type: 'chunk', index: index++, from: start, to: end, dir })
          }
        }
        const perFrame = frames.map(() => 0.01)
        await writeFile(job.timesFile, JSON.stringify({ frames: frames.length, first: 0.05, warmMean: 0.01, p95: 0.02, total: 0.1, width: job.width, height: job.height, samples: job.samples, perFrame }))
        return { frames: frames.length }
      }
      if (command === 'contact' || command === 'still') {
        await copyFile(path.join(dir, 'grey.png'), job.out)
        return { file: job.out }
      }
      return {}
    }
  } as unknown as BlenderRunner
  return { runner, calls }
}

describe('the 3D pipeline', () => {
  it('runs mini3d from the given pitch to done: designer revision, the pause for the sheets, no set before the approval, both languages rendered', async () => {
    env = await makeEnv({
      providers: [{ id: 'loc', local: true, concurrency: 4, models: ['m1'], vision: true }],
      roles: Object.fromEntries(ROLES.map((r) => [r, ['loc/m1']])),
      agents: ROLES.map((role) => ({ role, name: role }))
    })
    const dir = env.dir
    const series = await installMini3d(dir)
    const store = new SeriesStore(dir)
    await mkdir(path.join(series, 'music'), { recursive: true })
    await writeFile(path.join(series, 'music', 'theme.ogg'), 'kept')
    await sharp({ create: { width: 64, height: 36, channels: 3, background: '#8a8a8a' } }).png().toFile(path.join(dir, 'grey.png'))
    // the fixture's voice clips stand for spoken ones: their hash is the one the voice step would compute (so nothing is spoken) and their words are given
    const config = await loadVoiceConfig(dir)
    for (const lang of ['hr', 'en'] as const) {
      const m = await store.readVoiceManifest('mini3d', 'ep00-mini3d', lang)
      const plan = await planClips({ store, series: 'mini3d', episode: 'ep00-mini3d', config })
      for (const c of plan.clips.filter((x) => x.lang === lang)) m.lines[c.id] = { ...m.lines[c.id]!, hash: c.hash, words: [{ w: 'x', t0: 0.1, t1: 0.5 }], wordsCoverage: 1 }
      await writeFile(store.paths('mini3d').voiceManifest('ep00-mini3d', lang), JSON.stringify(m, null, 2))
    }

    const fake = fakeBlender(dir)
    setBlenderRunnerOverride(fake.runner)

    // the mock roles: answers by the kind of the task (the guide named in the system message)
    const fixture = JSON.parse(await readFile(path.join(MINI3D_DIR, 'bible.json'), 'utf8')) as { cast: { id: string; name: unknown; role: string; personality: string; look: string; voice: Record<string, unknown> }[]; style: unknown; title: unknown; logline: unknown; tone: string[]; rules: string[]; sets: { id: string; name: unknown; description: string }[] }
    const seen: string[] = []
    const reviews = new Map<string, number>()
    const text = (m: ChatRequest['messages'][number]): string => (typeof m.content === 'string' ? m.content : m.content.map((p) => ('text' in p ? p.text : '')).join('\n'))
    env.mock.onAny(async (req) => {
      const kind = /Your guide for this task \(([^)]+)\)/.exec(text(req.messages[0]!))?.[1] ?? '?'
      const user = text(req.messages[req.messages.length - 1]!)
      const id = /"id": "([a-z0-9-]+)"/.exec(user)?.[1] ?? ''
      seen.push(`${kind}:${id}`)
      const pass = { verdict: 'pass', scores: { quality: 5 }, notes: 'fine', problems: [] }
      switch (kind) {
        case 'showrunner/bible':
          return JSON.stringify({ title: fixture.title, logline: fixture.logline, tone: fixture.tone, rules: fixture.rules, style: fixture.style, cast: fixture.cast.map((c) => ({ id: c.id, name: c.name, role: c.role, personality: c.personality, look: c.look })), sets: fixture.sets.map((x) => ({ id: x.id, name: x.name, description: x.description })) })
        case 'character-designer/character-spec':
          return JSON.stringify({ spec: JSON.parse(await readFile(path.join(MINI3D_DIR, 'cast', id, 'character.json'), 'utf8')), notes: 'again' })
        case 'character-designer/character-review': {
          const n = (reviews.get(id) ?? 0) + 1
          reviews.set(id, n)
          // the first look at tilly asks for a change, every other one passes
          return JSON.stringify(id === 'tilly' && n === 1 ? { verdict: 'revise', scores: { quality: 3 }, notes: 'ears', problems: [{ where: 'front', what: 'ears too short', fix: 'ear_L1 longer' }] } : pass)
        }
        case 'background-artist/set-review':
        case 'child-safety-reviewer/safety':
        case 'frame-critic/frames-3d':
          return JSON.stringify(pass)
        case 'voice-director/voice-cast':
          return JSON.stringify({ voices: Object.fromEntries(fixture.cast.map((c) => [c.id, c.voice])), audition: Object.fromEntries(fixture.cast.map((c) => [c.id, { hr: 'Bok!', en: 'Hi!' }])), notes: '' })
        default:
          throw new Error(`the mock has no answer for ${kind}`)
      }
    })

    const pipe = new Pipeline(env.engine.cts)
    const brief = { pitch: { title: { hr: 'Mala 3D proba', en: 'Mini 3D Test' }, logline: { hr: 'Dvoje prijatelja u parku.', en: 'Two friends in a park.' }, leads: [{ name: 'Tilly', what: 'quick' }, { name: 'Blobby', what: 'slow' }], sets: ['park'], why: 'the smallest series' }, seconds: 20, lineRange: [2, 2] }
    await pipe.run({ series: 'mini3d', episode: 'ep00-mini3d', brief, options: { renderer: 'blender', skipAuditions: true } })

    // the pause: both characters are built and self-reviewed, nothing else
    const paused = await waitFor(async () => {
      const r = await pipe.status('mini3d', 'ep00-mini3d')
      if (r?.state === 'failed') throw new Error(`failed: ${JSON.stringify(r.steps.filter((s) => s.state === 'failed'))}`)
      return r?.state === 'waiting-on-user' ? r : null
    }, 60_000, 'the pause at sheet_review')
    expect(paused.step).toBe('sheet_review')
    expect(paused.steps.map((s) => s.id)).toEqual(BLENDER_STEPS.map((s) => s.id))
    expect(paused.steps.filter((s) => s.state === 'done').map((s) => s.id)).toEqual(['pitch', 'pitch_choice', 'bible', 'character'])
    expect(fake.calls.filter((c) => c.command === 'build-set')).toHaveLength(0)
    // tilly: built, the designer asked for a change once, built again and passed; blobby: built once
    expect(fake.calls.filter((c) => c.id === 'tilly')).toHaveLength(2)
    expect(fake.calls.filter((c) => c.id === 'blobby')).toHaveLength(1)
    expect(seen.filter((k) => k.startsWith('character-designer/character-spec'))).toEqual(['character-designer/character-spec:tilly'])

    // approving writes the hash of the spec; the last approval resumes the run
    const callsBefore = fake.calls.length
    const first = await pipe.approveSheet('mini3d', 'tilly', true)
    expect(first.stillOpen).toEqual(['blobby'])
    expect(first.resumed[0]?.state).toBe('waiting-on-user')
    const last = await pipe.approveSheet('mini3d', 'blobby', true)
    expect(last.stillOpen).toEqual([])
    const bible = await store.readBible('mini3d')
    expect(bible.cast.map((c) => c.sheet?.specHash)).toEqual(await Promise.all(bible.cast.map((c) => specHashOf(store, 'mini3d', c.id))))

    const done = await waitFor(async () => {
      const r = await pipe.status('mini3d', 'ep00-mini3d')
      if (r?.state === 'failed') throw new Error(`failed: ${JSON.stringify(r.steps.filter((s) => s.state === 'failed'))}`)
      return r?.state === 'done' ? r : null
    }, 90_000, 'the run to finish')
    expect(done.steps.every((s) => s.state === 'done')).toBe(true)
    expect(fake.calls[callsBefore]!.command).toBe('build-set')
    expect(fake.calls.filter((c) => c.command === 'assemble')).toHaveLength(2)
    for (const lang of ['hr', 'en']) {
      for (const f of [`${lang}.preview.mp4`, `${lang}.mp4`]) expect((await stat(path.join(series, 'episodes', 'ep00-mini3d', 'out', f))).size).toBeGreaterThan(1000)
    }
    expect(Object.keys((done.summary as { languages: Record<string, unknown> }).languages)).toEqual(['hr', 'en'])
  }, 180_000)
})
