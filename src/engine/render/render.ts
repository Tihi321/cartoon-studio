/// <reference lib="dom" />
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Page } from 'playwright-core'
import type { Lang, NumKey, Timeline, TimelineClip } from '../../shared/contracts'
import { sampleCamera, sampleNumber, sampleStep, snapToGrid } from '../../shared/sample'
import { SeriesStore } from '../series/service'
import { withPlayer } from './browser'
import type { PlayerSession } from './browser'
import { chooseEncoder, FramePipe, ffmpeg, ffprobe, encoderArgs, forgetEncoder, loadRenderConfig } from './ffmpeg'
import type { EncoderSpec, RenderConfig } from './ffmpeg'
import { muxEpisode } from './mix'
import type { LoudnessMeasure, MixInput } from './mix'
import type { MixCheck } from './mixcheck'

/**
 * Renders one episode in one language to an MP4.
 *
 *   timeline.<lang>.json -> the Canvas player in headless Chromium (`renderFrame(i)` -> JPEG) -> ffmpeg image2pipe -> video-only mp4
 *   (final quality with real Flow clips: the cutout stretches between the clips are separate video-only files, every clip is normalised to the
 *   frame size, and all are joined with the concat demuxer) -> `mix.ts` puts the audio over the whole video.
 *
 * Output: `episodes/<ep>/out/<lang>.mp4` (final, 1920x1080) or `out/<lang>.preview.mp4` (960x540; clip ranges keep the player's placeholder
 * card). The sizes, fps, encoder order, frame format and loudness come from `config/render.md`. `render/<lang>/render.log` records the frame
 * count, the wall time of each stage and the encoder.
 */

export type Quality = 'preview' | 'final'

export interface RenderRequest {
  /** The data folder (the series live under `<dataDir>/series`). */
  dataDir: string
  series: string
  episode: string
  lang: Lang
  quality: Quality
  /** Render only the first seconds (tests, quick looks). The audio is cut to the same length. */
  maxSeconds?: number
  /** Use this timeline instead of reading `timeline.<lang>.json` (tests; it is not written). */
  timeline?: Timeline
  /** Frame size instead of the one of `config/render.md` (tests). */
  size?: { width: number; height: number }
  /** Force an encoder by name (skips the probe), e.g. `libx264`. */
  encoder?: string
  /** The built player folder (default `out/player`). */
  playerDir?: string
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

export interface RenderResult {
  /** The mp4, absolute. */
  file: string
  /** The length of the video in seconds. */
  seconds: number
  wallSeconds: number
  encoder: string
  frames: number
  /** SHA-256 over every frame image sent to ffmpeg (identical for two renders of the same input). */
  frameDigest: string
  /** Pass-1 loudness measure of the mix (input_i = LUFS before normalising); null for a silent mix. */
  loudness: LoudnessMeasure | null
  /** The mix check (also in `render/<lang>/mix-check.json`); only a final render makes one. */
  mixCheck: MixCheck | null
  logFile: string
  warnings: string[]
}

// ---------------------------------------------------------------- what a frame looks like

const r = (v: number): string => (Math.round(v * 1e6) / 1e6).toString()

/**
 * A string that is the same for two frames exactly when the player draws the same pixels: the scene, any clip or title card, the camera and,
 * per actor, the pose sampled on the animation grid (the same sampling the player does in `Stage.draw`). Title cards are never reused (they
 * may animate); a clip card is the same for the whole range.
 */
export function stateKey(tl: Timeline, i: number): string {
  const t = i / tl.fps.out
  const clip = tl.clips.find((c) => t >= c.t0 && t < c.t1)
  if (clip) return `clip:${clip.id}`
  if ((tl.titles ?? []).some((c) => t >= c.t0 && t < c.t1)) return `title:${i}`
  let scene = tl.scenes[0]?.id ?? ''
  for (const sc of tl.scenes) if (sc.t0 <= t + 1e-9) scene = sc.id
  const cam = sampleCamera(tl.camera, t)
  const tg = snapToGrid(t, tl.fps.anim)
  const parts: string[] = [scene, r(cam.center[0]), r(cam.center[1]), r(cam.zoom)]
  for (const [id, a] of Object.entries(tl.actors)) {
    if (sampleStep(a.visible, tg) === false) {
      parts.push(`${id}:-`)
      continue
    }
    const rot = Object.keys(a.rot)
      .sort()
      .map((p) => `${p}=${r(sampleNumber(a.rot[p] as NumKey[], t, tl.fps.anim))}`)
      .join(',')
    parts.push(
      [
        id,
        r(sampleNumber(a.x, t, tl.fps.anim)),
        r(sampleNumber(a.y, t, tl.fps.anim)),
        sampleStep(a.facing, tg) ?? '',
        sampleStep(a.emotion, tg) ?? '',
        sampleStep(a.eyes, tg) ?? '',
        sampleStep(a.mouth, tg) ?? '',
        a.bob.length ? r(sampleNumber(a.bob, t, tl.fps.anim)) : '0',
        r(tg),
        rot
      ].join('|')
    )
  }
  return parts.join(';')
}

// ---------------------------------------------------------------- plan

export interface Segment {
  kind: 'cutout' | 'clip'
  /** Frame range [from, to). */
  from: number
  to: number
  clip?: TimelineClip
}

/**
 * The cutout stretches and the real clips in frame order. `real` are the clips spliced in (final quality, a file that exists and not a
 * fallback); everything else is drawn by the player.
 */
export function planSegments(frames: number, fpsOut: number, real: readonly TimelineClip[]): Segment[] {
  const out: Segment[] = []
  let at = 0
  for (const clip of [...real].sort((a, b) => a.t0 - b.t0)) {
    const from = Math.min(frames, Math.max(at, Math.round(clip.t0 * fpsOut)))
    const to = Math.min(frames, Math.max(from, Math.round(clip.t1 * fpsOut)))
    if (to <= from) continue
    if (from > at) out.push({ kind: 'cutout', from: at, to: from })
    out.push({ kind: 'clip', from, to, clip })
    at = to
  }
  if (at < frames) out.push({ kind: 'cutout', from: at, to: frames })
  return out
}

/** The timeline the player gets in a final render: a `fallback` clip range shows the cutout scene with its actors bouncing instead of the card. */
export function withFallbackBounce(tl: Timeline): Timeline {
  const fallbacks = tl.clips.filter((c) => c.fallback)
  if (fallbacks.length === 0) return tl
  const actors = structuredClone(tl.actors)
  for (const a of Object.values(actors)) {
    let keys: NumKey[] = [...a.bob]
    for (const c of fallbacks) {
      const after = sampleNumber(keys, c.t1)
      const added: NumKey[] = [[c.t0, 0.8, 'step'], [c.t1, after, 'step']]
      keys = [...keys.filter((k) => k[0] < c.t0 || k[0] > c.t1), ...added].sort((x, y) => x[0] - y[0])
    }
    a.bob = keys
  }
  return { ...tl, actors, clips: tl.clips.filter((c) => !c.fallback) }
}

// ---------------------------------------------------------------- the frame loop

interface PageApi {
  cts: {
    load(tl: unknown, base: string, o: { width: number; height: number }): Promise<void>
    frameCount(): number
    renderFrame(i: number): Promise<void>
    canvas: { toDataURL(type: string, q?: number): string }
  }
}

async function loadTimeline(page: Page, tl: Timeline, base: string, width: number, height: number): Promise<void> {
  await page.evaluate(
    async ([timeline, url, w, h]) => {
      await (window as unknown as PageApi).cts.load(timeline, url as string, { width: w as number, height: h as number })
    },
    [tl, base, width, height] as const
  )
}

interface LoopState {
  digest: ReturnType<typeof createHash>
  done: number
  total: number
  /** ms ffmpeg needed to finish after the last frame was sent */
  drainMs: number
}

async function renderRange(page: Page, tl: Timeline, from: number, to: number, pipe: FramePipe, cfg: RenderConfig, st: LoopState, req: RenderRequest): Promise<void> {
  const mime = cfg.frameFormat === 'png' ? 'image/png' : 'image/jpeg'
  const quality = cfg.frameFormat === 'png' ? undefined : 0.95
  let prevKey: string | null = null
  let prev: Buffer | null = null
  for (let i = from; i < to; i++) {
    if (req.signal?.aborted) throw new Error('render stopped')
    const key = stateKey(tl, i)
    if (key !== prevKey || !prev) {
      const url = await page.evaluate(
        async ([idx, type, q]) => {
          const cts = (window as unknown as PageApi).cts
          await cts.renderFrame(idx as number)
          return cts.canvas.toDataURL(type as string, q as number | undefined)
        },
        [i, mime, quality] as const
      )
      prev = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
      prevKey = key
    }
    st.digest.update(prev)
    await pipe.write(prev)
    st.done++
    if (st.done % 12 === 0) req.onProgress?.(st.done, st.total)
  }
}

async function encodeRange(session: PlayerSession, tl: Timeline, seg: Segment, out: string, enc: EncoderSpec, cfg: RenderConfig, st: LoopState, req: RenderRequest): Promise<void> {
  const pipe = new FramePipe({ out, fps: tl.fps.out, frameFormat: cfg.frameFormat, encoder: enc, pixelFormat: cfg.pixelFormat })
  try {
    await renderRange(session.page, tl, seg.from, seg.to, pipe, cfg, st, req)
    const d = Date.now()
    await pipe.finish()
    st.drainMs += Date.now() - d
  } catch (err) {
    pipe.abort()
    throw err
  }
}

/** A real clip -> a video-only mp4 of exactly the segment's frames: scaled and padded to the frame size, fps, yuv420p, square pixels. */
async function normaliseClip(file: string, seg: Segment, out: string, w: number, h: number, fps: number, enc: EncoderSpec, cfg: RenderConfig, signal?: AbortSignal): Promise<void> {
  const frames = seg.to - seg.from
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,fps=${fps},setsar=1,format=${cfg.pixelFormat},tpad=stop_mode=clone:stop_duration=${Math.ceil(frames / fps) + 1}`
  await ffmpeg(['-y', '-v', 'error', '-i', file, '-an', '-vf', vf, '-frames:v', String(frames), ...encoderArgs(enc, cfg.pixelFormat), '-r', String(fps), '-movflags', '+faststart', out], signal)
}

// ---------------------------------------------------------------- audio inputs

async function exists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
}

const hasAudio = async (file: string): Promise<boolean> => (await ffprobe(file)).streams.some((s) => s.codec_type === 'audio')

async function audioInputs(tl: Timeline, root: string, seconds: number, real: readonly TimelineClip[], store: SeriesStore, series: string, warnings: string[]): Promise<MixInput[]> {
  const paths = store.paths(series)
  const inputs: MixInput[] = []
  for (const a of tl.audio) {
    if (a.t >= seconds) continue
    const file = paths.resolve(a.file, root)
    if (!(await exists(file))) {
      warnings.push(`audio file missing, skipped: ${a.file}`)
      continue
    }
    if (a.kind === 'music') {
      const until = a.until < 0 || a.until > seconds ? seconds : a.until
      inputs.push({ file, kind: 'music', t: a.t, gain: a.gain, loop: true, length: Math.max(0.1, until - a.t), until, ...(a.duckTo !== undefined ? { duckTo: a.duckTo } : {}), ...(a.fadeOut ? { fadeOut: a.fadeOut } : {}) })
    } else inputs.push({ file, kind: a.kind, t: a.t, gain: a.gain })
  }
  for (const c of real) {
    if (c.audio !== 'keep' || c.t0 >= seconds) continue
    const file = paths.resolve(c.file, root)
    if (await hasAudio(file)) inputs.push({ file, kind: 'clip', t: c.t0, gain: 1, length: Math.min(c.t1, seconds) - c.t0 })
  }
  return inputs
}

// ---------------------------------------------------------------- the render

const ts = (): string => new Date().toISOString()

export async function renderEpisode(req: RenderRequest): Promise<RenderResult> {
  const t0 = Date.now()
  const cfg = await loadRenderConfig(req.dataDir)
  const store = new SeriesStore(req.dataDir)
  const paths = store.paths(req.series)
  const tl = req.timeline ?? (await store.readTimeline(req.series, req.episode, req.lang))
  const size = req.size ?? cfg[req.quality]
  const fps = tl.fps.out
  const total = Math.min(Math.ceil(tl.duration * fps), req.maxSeconds !== undefined ? Math.ceil(req.maxSeconds * fps) : Infinity)
  if (total < 1) throw new Error('the timeline is empty (0 frames)')
  const seconds = total / fps

  const warnings: string[] = []
  const root = paths.root
  // clips that are spliced in: final quality, in range, not marked fallback; a missing file of a non-fallback clip is an error (E_CLIP_MISSING)
  const real: TimelineClip[] = []
  if (req.quality === 'final') {
    for (const c of tl.clips) {
      if (c.fallback || c.t0 >= seconds) continue
      if (!(await exists(paths.resolve(c.file, root)))) throw new Error(`E_CLIP_MISSING: clip "${c.id}" (${c.file}) does not exist and is not marked fallback`)
      real.push(c)
    }
  }
  const playerTl = req.quality === 'final' ? withFallbackBounce(tl) : tl

  const renderDir = path.join(paths.episodeDir(req.episode), 'render', req.lang)
  const work = path.join(renderDir, `work-${req.quality}`)
  const outDir = paths.outDir(req.episode)
  const outFile = path.join(outDir, req.quality === 'final' ? `${req.lang}.mp4` : `${req.lang}.preview.mp4`)
  await fs.rm(work, { recursive: true, force: true })
  await fs.mkdir(work, { recursive: true })
  await fs.mkdir(outDir, { recursive: true })

  const stages: Record<string, number> = {}
  const log: string[] = []
  let encoder: EncoderSpec = { name: '?' }
  let digest = ''
  let loudness: LoudnessMeasure | null = null
  let mixCheck: MixCheck | null = null

  const attempt = async (forced?: string): Promise<void> => {
    const choice = await chooseEncoder(req.dataDir, cfg, forced ?? req.encoder)
    encoder = choice.spec
    const segments = planSegments(total, fps, real)
    const st: LoopState = { digest: createHash('sha256'), done: 0, total, drainMs: 0 }
    const files: string[] = []
    const tFrames = Date.now()
    let tSplice = 0
    await withPlayer({ dataDir: req.dataDir, ...(req.playerDir ? { playerDir: req.playerDir } : {}) }, async (session) => {
      await loadTimeline(session.page, playerTl, `${session.origin}/files/${req.series}/`, size.width, size.height)
      for (const [k, seg] of segments.entries()) {
        const file = path.join(work, `seg-${String(k).padStart(2, '0')}.mp4`)
        if (seg.kind === 'cutout') await encodeRange(session, playerTl, seg, file, encoder, cfg, st, req)
        else {
          const s = Date.now()
          await normaliseClip(paths.resolve(seg.clip!.file, root), seg, file, size.width, size.height, fps, encoder, cfg, req.signal)
          tSplice += Date.now() - s
          st.done += seg.to - seg.from
        }
        files.push(file)
      }
    })
    stages.encode = st.drainMs
    stages.frames = Date.now() - tFrames - tSplice - st.drainMs
    stages.splice = tSplice
    digest = st.digest.digest('hex')

    let video = files[0]!
    if (files.length > 1) {
      const s = Date.now()
      const list = path.join(work, 'list.txt')
      await fs.writeFile(list, files.map((f) => `file '${path.basename(f)}'`).join('\n') + '\n')
      video = path.join(work, 'joined.mp4')
      await ffmpeg(['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', video], req.signal)
      stages.splice += Date.now() - s
    }

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
      if (e.name === 'libx264' || req.encoder) throw err
      // the hardware encoder failed on the real job: forget it and render again with the CPU one
      warnings.push(`encoder ${e.name} failed (${(err as Error).message.slice(0, 160)}); rendered again with libx264`)
      await forgetEncoder(req.dataDir)
      await attempt('libx264')
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
  }

  const wallSeconds = (Date.now() - t0) / 1000
  const p = await ffprobe(outFile)
  const outSeconds = Number(p.format.duration ?? seconds)
  log.push(
    `${ts()} ${req.series}/${req.episode} ${req.lang} ${req.quality} ${size.width}x${size.height}`,
    `encoder: ${(encoder as EncoderSpec).name}`,
    `frames: ${total} (${seconds.toFixed(3)} s at ${fps} fps)`,
    `stage frames: ${(stages.frames! / 1000).toFixed(1)} s (draw + JPEG + pipe)`,
    `stage encode: ${(stages.encode! / 1000).toFixed(1)} s (ffmpeg finishing after the last frame; the rest of the encode overlaps "frames")`,
    `stage splice: ${((stages.splice ?? 0) / 1000).toFixed(1)} s (${real.length} clip${real.length === 1 ? '' : 's'})`,
    `stage mux: ${((stages.mux ?? 0) / 1000).toFixed(1)} s (audio mix, loudnorm, mux; ffmpeg encode runs inside "frames")`,
    `loudness before normalising: ${loudness ? (loudness as LoudnessMeasure).input_i + ' LUFS' : 'silent'}`,
    `mix check: ${mixCheck ? `min ${(mixCheck as MixCheck).minUnderDb ?? 'n/a'} dB, median ${(mixCheck as MixCheck).medianUnderDb ?? 'n/a'} dB music under the voice, gaps ${(mixCheck as MixCheck).gapMusicUnderVoiceDb ?? 'n/a'} dB` : 'not made (preview or no voice)'}`,
    `wall: ${wallSeconds.toFixed(1)} s`,
    `file: ${path.relative(root, outFile).split(path.sep).join('/')} (${outSeconds.toFixed(3)} s)`,
    `frame digest: ${digest}`,
    ...warnings.map((w) => `warning: ${w}`)
  )
  await fs.mkdir(renderDir, { recursive: true })
  await fs.writeFile(path.join(renderDir, 'render.log'), log.join('\n') + '\n')

  return { file: outFile, seconds: outSeconds, wallSeconds, encoder: (encoder as EncoderSpec).name, frames: total, frameDigest: digest, loudness, mixCheck, logFile: path.join(renderDir, 'render.log'), warnings }
}
