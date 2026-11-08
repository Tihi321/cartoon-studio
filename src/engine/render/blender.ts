import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Lang, TimelineClip } from '../../shared/contracts'
import { loadBlenderConfig } from '../blender/config'
import { assembleInputs, assembleScene, renderDirOf, sha1 } from '../blender/jobs'
import { blenderRunnerFor } from '../blender/runner'
import type { BlenderRunner } from '../blender/runner'
import { SeriesStore } from '../series/service'
import { chooseEncoder, encoderArgs, ffmpeg, ffprobe, forgetEncoder, loadRenderConfig } from './ffmpeg'
import type { EncoderSpec } from './ffmpeg'
import { muxEpisode } from './mix'
import type { LoudnessMeasure } from './mix'
import type { MixCheck } from './mixcheck'
import { audioInputs, exists, normaliseClip, planSegments } from './render'
import type { BlenderTimes, Quality, RenderResult } from './render'

/**
 * The Blender render backend (HUB-30 decision 11): an assembled scene (`render/<lang>/scene.blend`, CTS-25) is rendered by headless Blender (EEVEE) to PNG
 * frames in chunks of `chunkFrames`; the engine encodes each finished chunk to a video segment (`h264_amf`, else `libx264`) while Blender renders the
 * next one, then deletes that chunk's frames. The segments (and, in a final render, the real Flow clips, normalised to the frame size) are joined with the
 * concat demuxer, and `muxEpisode` puts the audio over them: the mix, the splice and the mix check are the code of the canvas render, unchanged.
 *
 * Output: `episodes/<ep>/out/<lang>.mp4` (final) or `<lang>.preview.mp4` (preview). `render/<lang>/blender-times.json` (and `blender-times.<quality>.json`)
 * has the frame times, `render.log` the stages and the same numbers.
 */

export interface BlenderRenderRequest {
  dataDir: string
  series: string
  episode: string
  lang: Lang
  quality: Quality
  /** Render only the first seconds (tests, quick looks). The audio is cut to the same length. */
  maxSeconds?: number
  /** Frame size and samples instead of the ones of `config/blender.md` (tests). */
  size?: { width: number; height: number; samples?: number }
  /** Force an encoder by name (skips the probe), e.g. `libx264`. */
  encoder?: string
  runner?: BlenderRunner
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

const ts = (): string => new Date().toISOString()
const pad = (n: number): string => String(n).padStart(6, '0')

/** The scene is rebuilt when it is missing or the timeline changed since (assembly.json records the hash of the timeline file). */
async function ensureAssembled(req: BlenderRenderRequest, runner: BlenderRunner, warnings: string[]): Promise<string> {
  const store = new SeriesStore(req.dataDir)
  const { job, blend, outDir } = await assembleInputs(store, req.series, req.episode, req.lang)
  const timelineHash = sha1(await fs.readFile(String((job as { timeline: string }).timeline)))
  let fresh = false
  try {
    const info = JSON.parse(await fs.readFile(path.join(outDir, 'assembly.json'), 'utf8')) as { timelineHash?: string }
    fresh = info.timelineHash === timelineHash && (await exists(blend))
  } catch {
    /* no assembly yet */
  }
  if (!fresh) {
    const r = await assembleScene({ dataDir: req.dataDir, series: req.series, episode: req.episode, lang: req.lang, runner, signal: req.signal })
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`)
    for (const w of r.warnings) warnings.push(`assemble: ${w}`)
  }
  return blend
}

/** Renders one language of a Blender episode to an MP4. */
export async function renderBlenderEpisode(req: BlenderRenderRequest): Promise<RenderResult> {
  const t0 = Date.now()
  const cfg = await loadRenderConfig(req.dataDir)
  const bcfg = await loadBlenderConfig(req.dataDir)
  const store = new SeriesStore(req.dataDir)
  const paths = store.paths(req.series)
  const runner = req.runner ?? (await blenderRunnerFor(req.dataDir))
  const warnings: string[] = []
  const tl = await store.readTimeline3d(req.series, req.episode, req.lang)
  const frame = { ...bcfg[req.quality], ...(req.size ?? {}) } as { width: number; height: number; samples: number }
  const fps = tl.fps
  const total = Math.min(Math.ceil(tl.duration * fps), req.maxSeconds !== undefined ? Math.ceil(req.maxSeconds * fps) : Infinity)
  if (total < 1) throw new Error('the timeline is empty (0 frames)')
  const seconds = total / fps
  const root = paths.root

  // clips that are spliced in: final quality, in range, not marked fallback; a fallback range is rendered by Blender (the actors just stand there)
  const real: TimelineClip[] = []
  if (req.quality === 'final') {
    for (const c of tl.clips) {
      if (c.fallback || c.t0 >= seconds) continue
      if (!(await exists(paths.resolve(c.file, root)))) throw new Error(`E_CLIP_MISSING: clip "${c.id}" (${c.file}) does not exist and is not marked fallback`)
      real.push(c)
    }
  }
  const blend = await ensureAssembled(req, runner, warnings)

  const renderDir = renderDirOf(req.dataDir, req.series, req.episode, req.lang)
  const work = path.join(renderDir, `work-${req.quality}`)
  const outDir = paths.outDir(req.episode)
  const outFile = path.join(outDir, req.quality === 'final' ? `${req.lang}.mp4` : `${req.lang}.preview.mp4`)
  const timesFile = path.join(renderDir, `blender-times.${req.quality}.json`)
  await fs.rm(work, { recursive: true, force: true })
  await fs.mkdir(work, { recursive: true })
  await fs.mkdir(outDir, { recursive: true })

  const stages: Record<string, number> = {}
  let encoder: EncoderSpec = { name: '?' }
  let loudness: LoudnessMeasure | null = null
  let mixCheck: MixCheck | null = null
  let chunkCount = 0

  const attempt = async (forced?: string): Promise<void> => {
    const choice = await chooseEncoder(req.dataDir, cfg, forced ?? req.encoder)
    encoder = choice.spec
    const segments = planSegments(total, fps, real)
    const ranges = segments.filter((s) => s.kind === 'cutout').map((s) => [s.from, s.to] as [number, number])
    const done: { from: number; to: number; file: string }[] = []
    const frames = path.join(work, 'frames')
    await fs.rm(frames, { recursive: true, force: true })

    // each finished chunk is encoded while Blender renders the next, then its frames are deleted (one encoder session at a time)
    let encodeError: Error | undefined
    let chain: Promise<void> = Promise.resolve()
    let encodeMs = 0
    const stop = new AbortController()
    req.signal?.addEventListener('abort', () => stop.abort(), { once: true })
    const encodeChunk = async (e: { from: number; to: number; dir: string }): Promise<void> => {
      const s = Date.now()
      const file = path.join(work, `seg-${pad(e.from)}.mp4`)
      await ffmpeg(
        ['-y', '-v', 'error', '-framerate', String(fps), '-start_number', String(e.from + 1), '-i', path.join(e.dir, 'f_%05d.png'), '-frames:v', String(e.to - e.from), '-vf', `scale=in_range=auto:out_range=tv,format=${cfg.pixelFormat}`, ...encoderArgs(encoder, cfg.pixelFormat), '-r', String(fps), '-an', '-movflags', '+faststart', file],
        stop.signal
      )
      await fs.rm(e.dir, { recursive: true, force: true })
      done.push({ from: e.from, to: e.to, file })
      encodeMs += Date.now() - s
    }
    const tBlender = Date.now()
    if (ranges.length) {
      try {
        await runner.run(
          'render',
          { blend, outDir: frames, ranges, chunkFrames: bcfg.chunkFrames, width: frame.width, height: frame.height, samples: frame.samples, timesFile },
          {
            signal: stop.signal,
            onProgress: (e) => req.onProgress?.(e.done, Math.max(e.total, 1)),
            onChunk: (e) => {
              chunkCount++
              chain = chain.then(() => encodeChunk(e)).catch((err: Error) => {
                encodeError ??= err
                stop.abort()
              })
            }
          }
        )
      } catch (err) {
        await chain
        throw encodeError ?? err
      }
      await chain
      if (encodeError) throw encodeError
    }
    stages.blender = Date.now() - tBlender
    stages.encode = encodeMs

    // the splice: real clips, normalised to the frame size, next to the Blender segments, in frame order
    const parts: { from: number; to: number; file: string }[] = [...done]
    let tSplice = 0
    for (const [k, seg] of segments.entries()) {
      if (seg.kind !== 'clip') continue
      const s = Date.now()
      const file = path.join(work, `clip-${String(k).padStart(2, '0')}.mp4`)
      await normaliseClip(paths.resolve(seg.clip!.file, root), seg, file, frame.width, frame.height, fps, encoder, cfg, req.signal)
      parts.push({ from: seg.from, to: seg.to, file })
      tSplice += Date.now() - s
    }
    parts.sort((a, b) => a.from - b.from)
    let video = parts[0]!.file
    if (parts.length > 1) {
      const s = Date.now()
      const list = path.join(work, 'list.txt')
      await fs.writeFile(list, parts.map((f) => `file '${path.basename(f.file)}'`).join('\n') + '\n')
      video = path.join(work, 'joined.mp4')
      await ffmpeg(['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', video], req.signal)
      tSplice += Date.now() - s
    }
    stages.splice = tSplice

    const s = Date.now()
    const inputs = await audioInputs(tl, root, seconds, real, store, req.series, warnings)
    const voice = tl.lines.filter((l) => l.t0 < seconds).map((l) => [l.t0, Math.min(l.t1, seconds)] as [number, number])
    const lines = tl.lines.filter((l) => l.t0 < seconds).map((l) => ({ id: l.id, t0: l.t0, t1: Math.min(l.t1, seconds) }))
    const mixed = await muxEpisode(
      video,
      inputs,
      {
        voice,
        lines,
        mix: cfg.mix,
        levelsFile: path.join(renderDir, 'levels.json'),
        ...(req.quality === 'final' ? { checkFile: path.join(renderDir, 'mix-check.json') } : {}),
        seconds,
        lufs: cfg.loudness.lufs,
        truePeak: cfg.loudness.truePeak,
        audio: cfg.audio
      },
      outFile
    )
    loudness = mixed.loudness
    mixCheck = mixed.check
    stages.mux = Date.now() - s
  }

  try {
    try {
      await attempt()
    } catch (err) {
      const e = encoder as EncoderSpec
      if (e.name === 'libx264' || req.encoder || req.signal?.aborted) throw err
      // the hardware encoder failed on the real job: forget it and render again with the CPU one
      warnings.push(`encoder ${e.name} failed (${(err as Error).message.slice(0, 160)}); rendered again with libx264`)
      await forgetEncoder(req.dataDir)
      await attempt('libx264')
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
  }

  // the frame times: the file of this quality, and blender-times.json as the latest of any quality
  const raw = JSON.parse(await fs.readFile(timesFile, 'utf8')) as BlenderTimes & { perFrame: number[] }
  const latest = path.join(renderDir, 'blender-times.json')
  await fs.writeFile(latest, JSON.stringify({ quality: req.quality, ...raw }) + '\n')
  const times: BlenderTimes = { frames: raw.frames, first: raw.first, warmMean: raw.warmMean, p95: raw.p95, total: raw.total, width: raw.width, height: raw.height, samples: raw.samples, file: latest }

  const wallSeconds = (Date.now() - t0) / 1000
  const p = await ffprobe(outFile)
  const outSeconds = Number(p.format.duration ?? seconds)
  const e = encoder as EncoderSpec
  const log = [
    `${ts()} ${req.series}/${req.episode} ${req.lang} ${req.quality} ${frame.width}x${frame.height} (blender, ${frame.samples} samples)`,
    `encoder: ${e.name}`,
    `frames: ${total} (${seconds.toFixed(3)} s at ${fps} fps), ${chunkCount} chunk${chunkCount === 1 ? '' : 's'} of at most ${bcfg.chunkFrames}`,
    `blender frame times: first ${times.first.toFixed(3)} s, warm mean ${times.warmMean.toFixed(3)} s, p95 ${times.p95.toFixed(3)} s, total ${times.total.toFixed(1)} s over ${times.frames} frames`,
    `stage blender: ${((stages.blender ?? 0) / 1000).toFixed(1)} s (render, with the chunk encodes running beside it)`,
    `stage encode: ${((stages.encode ?? 0) / 1000).toFixed(1)} s (summed chunk encodes; they overlap the render)`,
    `stage splice: ${((stages.splice ?? 0) / 1000).toFixed(1)} s (${real.length} clip${real.length === 1 ? '' : 's'}, concat)`,
    `stage mux: ${((stages.mux ?? 0) / 1000).toFixed(1)} s (audio mix, loudnorm, mux)`,
    `loudness before normalising: ${loudness ? (loudness as LoudnessMeasure).input_i + ' LUFS' : 'silent'}`,
    `mix check: ${mixCheck ? `min ${(mixCheck as MixCheck).minUnderDb ?? 'n/a'} dB, median ${(mixCheck as MixCheck).medianUnderDb ?? 'n/a'} dB music under the voice, gaps ${(mixCheck as MixCheck).gapMusicUnderVoiceDb ?? 'n/a'} dB` : 'not made (preview or no voice)'}`,
    `wall: ${wallSeconds.toFixed(1)} s`,
    `file: ${path.relative(root, outFile).split(path.sep).join('/')} (${outSeconds.toFixed(3)} s)`,
    ...warnings.map((w) => `warning: ${w}`)
  ]
  await fs.mkdir(renderDir, { recursive: true })
  await fs.writeFile(path.join(renderDir, 'render.log'), log.join('\n') + '\n')

  return { file: outFile, seconds: outSeconds, wallSeconds, encoder: e.name, frames: total, frameDigest: '', loudness, mixCheck, logFile: path.join(renderDir, 'render.log'), warnings, blenderTimes: times }
}

/** The times of an even spread over a duration: the middle of each of `count` equal slices. */
const evenTimes = (duration: number, count: number): number[] => Array.from({ length: count }, (_, k) => Math.round(((k + 0.5) / count) * duration * 100) / 100)

export interface BlenderContactRequest {
  dataDir: string
  series: string
  episode: string
  lang: Lang
  count?: number
  times?: number[]
  quality?: Quality
  runner?: BlenderRunner
}

/**
 * A contact sheet cut from the frames of the rendered MP4 (the preview, else the final): ffmpeg takes each frame, Blender tiles and labels them.
 * `render/<lang>/sheet-<n>.png`. The film is read as it was rendered, so the sheet shows what the viewer sees (camera, mouth, acting), not a new render.
 */
export async function blenderContactSheet(req: BlenderContactRequest): Promise<string> {
  const store = new SeriesStore(req.dataDir)
  const paths = store.paths(req.series)
  const tl = await store.readTimeline3d(req.series, req.episode, req.lang)
  const candidates = req.quality === 'final' ? ['final'] : req.quality === 'preview' ? ['preview'] : ['preview', 'final']
  let mp4: string | undefined
  for (const q of candidates) {
    const f = path.join(paths.outDir(req.episode), q === 'final' ? `${req.lang}.mp4` : `${req.lang}.preview.mp4`)
    if (await exists(f)) {
      mp4 = f
      break
    }
  }
  if (!mp4) throw new Error(`no rendered film for ${req.lang}: cts_render first (the contact sheet is cut from out/${req.lang}.preview.mp4)`)
  const probe = await ffprobe(mp4)
  const length = Number(probe.format.duration ?? tl.duration)
  const times = (req.times && req.times.length ? req.times : evenTimes(length, Math.max(1, Math.min(req.count ?? 12, 60)))).map((t) => Math.min(Math.max(0, t), Math.max(0, length - 0.05)))
  const dir = path.join(renderDirOf(req.dataDir, req.series, req.episode, req.lang), 'contact-work')
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  const files: string[] = []
  const labels: string[] = []
  for (const [k, t] of times.entries()) {
    const f = path.join(dir, `t${String(k).padStart(2, '0')}.png`)
    await ffmpeg(['-y', '-v', 'error', '-ss', t.toFixed(3), '-i', mp4, '-frames:v', '1', f])
    files.push(f)
    labels.push(`${t.toFixed(2)} S  F ${Math.round(t * tl.fps)}`)
  }
  const out = path.join(renderDirOf(req.dataDir, req.series, req.episode, req.lang), `sheet-${times.length}.png`)
  const runner = req.runner ?? (await blenderRunnerFor(req.dataDir))
  try {
    await runner.run('contact', { files, labels, out })
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
  return out
}
