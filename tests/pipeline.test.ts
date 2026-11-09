import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { setBlenderRunnerOverride } from '../src/engine/blender/runner'
import type { BlenderRunner } from '../src/engine/blender/runner'
import type { ChatRequest } from '../src/engine/models/types'
import { BLENDER_STEPS } from '../src/engine/pipeline/steps'
import { Pipeline, specHashOf } from '../src/engine/pipeline/run'
import { lintSeries } from '../src/engine/series/lint'
import { SeriesStore } from '../src/engine/series/service'
import type { FlowClient, NarrateArgs } from '../src/engine/studios/flow'
import { sha1 } from '../src/engine/blender/jobs'
import { makeEnv, waitFor } from './helpers'
import type { TestEnv } from './helpers'
import { MINI_VEHICLES_DIR, installMiniVehicles } from './fixtures/mini-vehicles'

/**
 * The 3D pipeline (CTS-27, HUB-31 CTS-35): `cts_run_pipeline` on the vehicle fixture `mini-vehicles` (a car and a train) with the mock provider, a fake
 * Blender runner and a fake ElevenLabs flow client goes from the given pitch to `done`: character spec + build + self-review (one revision here), the
 * pause for the user's approval of the sheets (nothing is built for a set before), sets, the kept script, safety, the voice cast (offered the premade
 * ElevenLabs voices only), voices from ElevenLabs in both languages (word times from the alignment), 3D timelines (the car's drive follows the road),
 * assemble, preview, frame review and final renders. No Blender, no service, no spend.
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
  set: { spec: string; blend: string }
  characters: Record<string, { spec: string; blend: string }>
  ranges: [number, number][]
  chunkFrames: number
  timesFile: string
  width: number
  height: number
  samples: number
  out: string
}

/** A WAV of a tone between silences (16 kHz mono): what the fake ElevenLabs speaks. */
function toneWav(parts: [number, number][]): Buffer {
  const rate = 16000
  const samples: number[] = []
  for (const [sec, amp] of parts) for (let i = 0, n = Math.round(sec * rate); i < n; i++) samples.push(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * amp * 32767))
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((v, i) => data.writeInt16LE(v, i * 2))
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

/** flow-music-mcp with a ready ElevenLabs free tier: two premade voices and a cloned one, and a narrate that answers with alignment word times. */
function fakeEleven(): { flow: FlowClient; spoken: NarrateArgs[] } {
  const spoken: NarrateArgs[] = []
  let remaining = 9000
  const flow = {
    url: 'fake',
    status: async () => ({ up: true, signedIn: true, uploadRights: false }),
    voices: async () => ({ gemini: [], geminiModel: '', geminiReady: true, windows: [] }),
    song: async () => Promise.reject(new Error('no music here')),
    loop: async () => Promise.reject(new Error('no music here')),
    elevenStatus: async () => ({ ready: true, source: 'env', tier: 'free', used: 1000, limit: 10000, remaining, reserve: 200, resetAt: '2026-12-01T00:00:00Z', paidRisk: false, models: [{ id: 'eleven_multilingual_v2', tts: true, hr: true, en: true, multiplier: 1 }] }),
    elevenVoices: async () => [
      { voiceId: 'premade-bright', name: 'Bright', category: 'premade', labels: { gender: 'male', age: 'young' } },
      { voiceId: 'premade-deep', name: 'Deep', category: 'premade', labels: { gender: 'male', age: 'old' } },
      { voiceId: 'cloned-one', name: 'Mine', category: 'cloned', labels: {} }
    ],
    async narrate(a: NarrateArgs) {
      spoken.push(a)
      await mkdir(a.out, { recursive: true })
      const file = path.join(a.out, `${a.name}.wav`)
      await writeFile(file, toneWav([[0.4, 0], [1.0, 0.5], [0.3, 0]]))
      remaining -= a.text.length
      return { file, model: 'eleven_multilingual_v2', words: [{ w: 'a', t0: 0.42, t1: 0.8 }, { w: 'b', t0: 0.85, t1: 1.3 }], creditsEstimate: a.text.length, remainingAfter: remaining }
    },
    transcribe: async () => Promise.reject(new Error('an ElevenLabs line needs no whisper'))
  }
  return { flow: flow as unknown as FlowClient, spoken }
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
        const hashes = async (x: { spec: string; blend: string }) => ({ specHash: sha1(await readFile(x.spec)), assetHash: sha1(await readFile(x.blend)) })
        const actors: Record<string, unknown> = {}
        for (const [id, c] of Object.entries(job.characters)) actors[id] = await hashes(c)
        await writeFile(path.join(job.outDir, 'assembly.json'), JSON.stringify({ timelineHash: sha1(await readFile(job.timeline)), set: await hashes(job.set), actors }))
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

/**
 * The vehicle fixture with the mock roles, a fake Blender and a fake ElevenLabs, started with the given pitch; the auditions of the voice casting go
 * through the fake ElevenLabs (CTS-37).
 */
async function startMiniVehicles() {
  const eleven = fakeEleven()
  const vibetts = { url: 'fake', listVoices: async () => Promise.reject(new Error('VibeTTS is off')) }
  env = await makeEnv(
    {
      providers: [{ id: 'loc', local: true, concurrency: 4, models: ['m1'], vision: true }],
      roles: Object.fromEntries(ROLES.map((r) => [r, ['loc/m1']])),
      agents: ROLES.map((role) => ({ role, name: role }))
    },
    { flow: eleven.flow, vibetts: vibetts as never, voiceRuntime: { sleep: async () => undefined } }
  )
  const dir = env.dir
  const series = await installMiniVehicles(dir)
  const store = new SeriesStore(dir)
  // the theme is kept; the horn the script cues is never made, so it is a warning and silence (decision 14)
  await mkdir(path.join(series, 'music'), { recursive: true })
  await writeFile(path.join(series, 'music', 'theme.ogg'), 'kept')
  await sharp({ create: { width: 64, height: 36, channels: 3, background: '#8a8a8a' } }).png().toFile(path.join(dir, 'grey.png'))

  const fake = fakeBlender(dir)
  setBlenderRunnerOverride(fake.runner)

  // the mock roles: answers by the kind of the task (the guide named in the system message)
  const fixture = JSON.parse(await readFile(path.join(MINI_VEHICLES_DIR, 'bible.json'), 'utf8')) as { cast: { id: string; name: unknown; role: string; personality: string; look: string; voice: Record<string, unknown> }[]; style: unknown; title: unknown; logline: unknown; tone: string[]; rules: string[]; sets: { id: string; name: unknown; description: string }[] }
  const seen: string[] = []
  const inputs = new Map<string, string>()
  const reviews = new Map<string, number>()
  const text = (m: ChatRequest['messages'][number]): string => (typeof m.content === 'string' ? m.content : m.content.map((p) => ('text' in p ? p.text : '')).join('\n'))
  env.mock.onAny(async (req) => {
    const kind = /Your guide for this task \(([^)]+)\)/.exec(text(req.messages[0]!))?.[1] ?? '?'
    const user = text(req.messages[req.messages.length - 1]!)
    const id = /"id": "([a-z0-9-]+)"/.exec(user)?.[1] ?? ''
    seen.push(`${kind}:${id}`)
    inputs.set(kind, user)
    const pass = { verdict: 'pass', scores: { quality: 5 }, notes: 'fine', problems: [] }
    switch (kind) {
      case 'showrunner/bible':
        return JSON.stringify({ title: fixture.title, logline: fixture.logline, tone: fixture.tone, rules: fixture.rules, style: fixture.style, cast: fixture.cast.map((c) => ({ id: c.id, name: c.name, role: c.role, personality: c.personality, look: c.look })), sets: fixture.sets.map((x) => ({ id: x.id, name: x.name, description: x.description })) })
      case 'character-designer/character-spec':
        return JSON.stringify({ spec: JSON.parse(await readFile(path.join(MINI_VEHICLES_DIR, 'cast', id, 'character.json'), 'utf8')), notes: 'again' })
      case 'character-designer/character-review': {
        const n = (reviews.get(id) ?? 0) + 1
        reviews.set(id, n)
        // the first look at pip asks for a change, every other one passes
        return JSON.stringify(id === 'pip' && n === 1 ? { verdict: 'revise', scores: { quality: 3 }, notes: 'lamps', problems: [{ where: 'front', what: 'lamps too far apart', fix: 'lid_L and lid_R closer' }] } : pass)
      }
      case 'background-artist/set-review':
      case 'child-safety-reviewer/safety':
      case 'frame-critic/frames-3d':
        return JSON.stringify(pass)
      case 'voice-director/voice-cast': {
        // OmniVoice tags for the local fallback, a Kokoro voice each, and the premade ElevenLabs voice for both languages
        const voice = (c: { id: string; voice: Record<string, unknown> }, i: number) => {
          const eleven = { voiceId: i === 0 ? 'premade-bright' : 'premade-deep', name: i === 0 ? 'Bright' : 'Deep' }
          const comfy = { engine: 'omnivoice', instruct: i === 0 ? 'male, child, high pitch' : 'male, elderly, low pitch', ref: null, refText: null, seed: 7 + i }
          return [c.id, { hr: { ...(c.voice.hr as object), comfy, elevenlabs: eleven }, en: { ...(c.voice.en as object), elevenlabs: eleven } }]
        }
        return JSON.stringify({ voices: Object.fromEntries(fixture.cast.map(voice)), audition: Object.fromEntries(fixture.cast.map((c) => [c.id, { hr: 'Bok!', en: 'Hi!' }])), notes: '' })
      }
      default:
        throw new Error(`the mock has no answer for ${kind}`)
    }
  })

  const pipe = new Pipeline(env.engine.cts)
  const brief = { pitch: { title: { hr: 'Mala proba s kotačima', en: 'Mini Wheels Test' }, logline: { hr: 'Auto i vlak na prijelazu.', en: 'A car and a train at the crossing.' }, leads: [{ name: 'Pip', what: 'quick little car' }, { name: 'Bruno', what: 'slow kind engine' }], sets: ['crossing'], why: 'the smallest vehicle series' }, seconds: 20, lineRange: [2, 2] }
  await pipe.run({ series: 'mini-vehicles', episode: 'ep00-wheels', brief, options: { renderer: 'blender', skipClips: true } })
  return { eleven, fake, store, series, seen, inputs, pipe }
}

/** Waits until the run waits for the user (fails on a failed step). */
const pauseOf = (pipe: Pipeline, label: string) =>
  waitFor(async () => {
    const r = await pipe.status('mini-vehicles', 'ep00-wheels')
    if (r?.state === 'failed') throw new Error(`failed: ${JSON.stringify(r.steps.filter((s) => s.state === 'failed'))}`)
    return r?.state === 'waiting-on-user' ? r : null
  }, 60_000, label)

describe('the 3D pipeline', () => {
  it('runs mini-vehicles from the given pitch to done: designer revision, the pause for the sheets, ElevenLabs voices, the drive on its road, both languages rendered', async () => {
    const { eleven, fake, store, series, seen, inputs, pipe } = await startMiniVehicles()

    // the pause: both characters are built and self-reviewed, nothing else
    const paused = await pauseOf(pipe, 'the pause at sheet_review')
    expect(paused.step).toBe('sheet_review')
    expect(paused.steps.map((s) => s.id)).toEqual(BLENDER_STEPS.map((s) => s.id))
    expect(paused.steps.filter((s) => s.state === 'done').map((s) => s.id)).toEqual(['pitch', 'pitch_choice', 'bible', 'character'])
    expect(fake.calls.filter((c) => c.command === 'build-set')).toHaveLength(0)
    // pip: built, the designer asked for a change once, built again and passed; bruno: built once
    expect(fake.calls.filter((c) => c.id === 'pip')).toHaveLength(2)
    expect(fake.calls.filter((c) => c.id === 'bruno')).toHaveLength(1)
    expect(seen.filter((k) => k.startsWith('character-designer/character-spec'))).toEqual(['character-designer/character-spec:pip'])

    // approving writes the hash of the spec; the last approval resumes the run
    const callsBefore = fake.calls.length
    const first = await pipe.approveSheet('mini-vehicles', 'pip', true)
    expect(first.stillOpen).toEqual(['bruno'])
    expect(first.resumed[0]?.state).toBe('waiting-on-user')
    const last = await pipe.approveSheet('mini-vehicles', 'bruno', true)
    expect(last.stillOpen).toEqual([])
    const bible = await store.readBible('mini-vehicles')
    expect(bible.cast.map((c) => c.sheet?.specHash)).toEqual(await Promise.all(bible.cast.map((c) => specHashOf(store, 'mini-vehicles', c.id))))

    // CTS-37: the voice review holds the run after the casting: the auditions were spoken by the cast's ElevenLabs voices (credits in spend.json), no line yet
    const voicePause = await pauseOf(pipe, 'the pause at voice_review')
    expect(voicePause.step).toBe('voice_review')
    expect(eleven.spoken.map((a) => `${a.voice}:${a.timestamps}`).sort()).toEqual(['premade-bright:false', 'premade-bright:false', 'premade-deep:false', 'premade-deep:false'])
    expect(await stat(path.join(series, 'cast', 'pip', 'voice', 'audition-en-premade-bright.wav'))).toBeTruthy()
    expect((await store.readSpend('mini-vehicles', 'ep00-wheels')).entries.filter((x) => x.what.startsWith('audition '))).toHaveLength(4)
    expect(voicePause.steps.find((s) => s.id === 'voice')?.state).toBe('pending')
    await pipe.approveVoices('mini-vehicles', true)

    const done = await waitFor(async () => {
      const r = await pipe.status('mini-vehicles', 'ep00-wheels')
      if (r?.state === 'failed') throw new Error(`failed: ${JSON.stringify(r.steps.filter((s) => s.state === 'failed'))}`)
      return r?.state === 'done' ? r : null
    }, 90_000, 'the run to finish')
    expect(done.steps.every((s) => s.state === 'done')).toBe(true)
    expect(fake.calls[callsBefore]!.command).toBe('build-set')
    expect(fake.calls.filter((c) => c.command === 'assemble')).toHaveLength(2)
    for (const lang of ['hr', 'en']) {
      for (const f of [`${lang}.preview.mp4`, `${lang}.mp4`]) expect((await stat(path.join(series, 'episodes', 'ep00-wheels', 'out', f))).size).toBeGreaterThan(1000)
    }
    expect(Object.keys((done.summary as { languages: Record<string, unknown> }).languages)).toEqual(['hr', 'en'])

    // the voice director was offered the premade ElevenLabs voices only, and both languages were spoken by ElevenLabs with alignment word times
    expect(inputs.get('voice-director/voice-cast')).toContain('premade-deep')
    expect(inputs.get('voice-director/voice-cast')).not.toContain('cloned-one')
    expect(eleven.spoken.filter((a) => a.timestamps).map((a) => `${a.engine}:${a.voice}`).sort()).toEqual(['elevenlabs:premade-bright', 'elevenlabs:premade-bright', 'elevenlabs:premade-deep', 'elevenlabs:premade-deep'])
    for (const lang of ['hr', 'en'] as const) {
      const m = await store.readVoiceManifest('mini-vehicles', 'ep00-wheels', lang)
      for (const line of Object.values(m.lines)) expect(line).toMatchObject({ provider: 'elevenlabs', wordsFrom: 'elevenlabs', wordsCoverage: 1 })
    }
    // the car drives along the road between its two marks, the train is on its track; the missing horn is a warning, never an error
    const tl = await store.readTimeline3d('mini-vehicles', 'ep00-wheels', 'en')
    expect(tl.actors.pip!.actions.find((x) => x.action === 'drive')?.params).toMatchObject({ pathId: 'road', path: [[-8, -1], [-1, -1]] })
    expect(tl.actors.bruno!.actions.find((x) => x.action === 'chug')?.params).toMatchObject({ pathId: 'rail', path: [[2, -6], [2, 4.5]] })
    expect(tl.actors.pip!.start.facing).toBe(90)
    const lint = await lintSeries(store, 'mini-vehicles', { episode: 'ep00-wheels' })
    expect(lint.errors).toEqual([])
    expect(lint.warnings.map((i) => i.code)).toContain('W_SFX_MISSING')
  }, 180_000)
})
