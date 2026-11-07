import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { parseMd } from '../../shared/md'

/** ffmpeg and ffprobe helpers of the render, and the encoder choice (`config/render.md`). ffmpeg and ffprobe must be on PATH (`CTS_FFMPEG` / `CTS_FFPROBE` override). */

const FFMPEG = (): string => process.env.CTS_FFMPEG || 'ffmpeg'
const FFPROBE = (): string => process.env.CTS_FFPROBE || 'ffprobe'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Runs a command to the end and returns its output; never throws for a non-zero exit. */
export function runCapture(cmd: string, args: string[], signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, signal })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', (e) => reject(new Error(`could not run ${cmd}: ${e.message} (is it on PATH?)`)))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/** Runs ffmpeg and throws with the tail of its stderr when it fails. Returns stderr. */
export async function ffmpeg(args: string[], signal?: AbortSignal): Promise<string> {
  const r = await runCapture(FFMPEG(), ['-hide_banner', '-nostdin', ...args], signal)
  if (r.code !== 0) throw new Error(`ffmpeg failed (${r.code}): ${r.stderr.trim().split('\n').slice(-6).join(' | ')}`)
  return r.stderr
}

export interface ProbeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  pix_fmt?: string
  r_frame_rate?: string
  avg_frame_rate?: string
  duration?: string
  nb_frames?: string
}
export interface ProbeResult {
  streams: ProbeStream[]
  format: { duration?: string }
}

export async function ffprobe(file: string): Promise<ProbeResult> {
  const r = await runCapture(FFPROBE(), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file])
  if (r.code !== 0) throw new Error(`ffprobe failed for ${file}: ${r.stderr.trim()}`)
  return JSON.parse(r.stdout) as ProbeResult
}

// ---------------------------------------------------------------- config/render.md

const encoderSchema = z.looseObject({ name: z.string(), preset: z.string().optional(), crf: z.number().optional() })
const renderConfigSchema = z.looseObject({
  preview: z.object({ width: z.number().int(), height: z.number().int() }).default({ width: 960, height: 540 }),
  final: z.object({ width: z.number().int(), height: z.number().int() }).default({ width: 1920, height: 1080 }),
  fps: z.object({ anim: z.number(), out: z.number() }).default({ anim: 12, out: 24 }),
  encoders: z.array(encoderSchema).default([{ name: 'h264_amf' }, { name: 'libx264', preset: 'veryfast', crf: 20 }]),
  pixelFormat: z.string().default('yuv420p'),
  frameFormat: z.enum(['jpeg', 'png']).default('jpeg'),
  audio: z.object({ codec: z.string(), bitrate: z.string() }).default({ codec: 'aac', bitrate: '160k' }),
  loudness: z.object({ lufs: z.number(), truePeak: z.number() }).default({ lufs: -16, truePeak: -1.5 })
})
export type RenderConfig = z.output<typeof renderConfigSchema>
export type EncoderSpec = z.output<typeof encoderSchema>

/** `config/render.md` of the data folder; the defaults of the seed when the file is missing. */
export async function loadRenderConfig(dataDir: string): Promise<RenderConfig> {
  let data: Record<string, unknown> = {}
  try {
    data = parseMd(await fs.readFile(path.join(dataDir, 'config', 'render.md'), 'utf8'), 'render.md').data
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return renderConfigSchema.parse(data)
}

// ---------------------------------------------------------------- encoders

/** The video encoding arguments of one encoder. */
export function encoderArgs(spec: EncoderSpec, pixelFormat = 'yuv420p'): string[] {
  const pix = ['-pix_fmt', pixelFormat]
  if (spec.name === 'libx264') return ['-c:v', 'libx264', '-preset', spec.preset ?? 'veryfast', '-crf', String(spec.crf ?? 20), ...pix]
  if (spec.name === 'h264_amf') return ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '22', ...pix]
  return ['-c:v', spec.name, ...pix]
}

async function works(spec: EncoderSpec, pixelFormat: string): Promise<boolean> {
  const r = await runCapture(FFMPEG(), ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=24:d=1', '-t', '1', ...encoderArgs(spec, pixelFormat), '-f', 'null', '-'])
  return r.code === 0
}

export interface EncoderChoice {
  spec: EncoderSpec
  /** True when the answer came from `state/encoder.json` instead of a probe. */
  cached: boolean
}

/**
 * The first encoder of `config/render.md` that encodes 1 s of black on this machine. The answer is kept in `<data>/state/encoder.json` and
 * probed again only when the file is missing or names an encoder that is no longer in the config. `force` (a name) skips the probe.
 */
export async function chooseEncoder(dataDir: string, cfg: RenderConfig, force?: string): Promise<EncoderChoice> {
  if (force) return { spec: cfg.encoders.find((e) => e.name === force) ?? { name: force, ...(force === 'libx264' ? { preset: 'veryfast', crf: 20 } : {}) }, cached: false }
  const file = path.join(dataDir, 'state', 'encoder.json')
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as { encoder?: string }
    const spec = cfg.encoders.find((e) => e.name === saved.encoder)
    if (spec) return { spec, cached: true }
  } catch {
    /* no cache yet */
  }
  const tried: { name: string; ok: boolean }[] = []
  for (const spec of cfg.encoders) {
    const ok = await works(spec, cfg.pixelFormat)
    tried.push({ name: spec.name, ok })
    if (ok) {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, JSON.stringify({ encoder: spec.name, probedAt: new Date().toISOString(), tried }, null, 2) + '\n')
      return { spec, cached: false }
    }
  }
  throw new Error(`no encoder of config/render.md works on this machine (tried ${tried.map((t) => t.name).join(', ')})`)
}

/** Forgets the cached encoder (after a render with it failed). */
export async function forgetEncoder(dataDir: string): Promise<void> {
  await fs.rm(path.join(dataDir, 'state', 'encoder.json'), { force: true })
}

// ---------------------------------------------------------------- frame pipe

/** An ffmpeg process that reads image frames from stdin and writes a video-only mp4. */
export class FramePipe {
  private readonly child: ChildProcessWithoutNullStreams
  private stderr = ''
  private readonly exited: Promise<number>
  private failed: Error | null = null

  constructor(opts: { out: string; fps: number; frameFormat: 'jpeg' | 'png'; encoder: EncoderSpec; pixelFormat: string }) {
    const args = [
      '-hide_banner', '-nostdin', '-y', '-v', 'error',
      '-f', 'image2pipe', '-framerate', String(opts.fps), '-c:v', opts.frameFormat === 'png' ? 'png' : 'mjpeg', '-i', '-',
      '-vf', `scale=in_range=auto:out_range=tv,format=${opts.pixelFormat}`,
      ...encoderArgs(opts.encoder, opts.pixelFormat),
      '-r', String(opts.fps), '-an', '-movflags', '+faststart', opts.out
    ]
    this.child = spawn(FFMPEG(), args, { windowsHide: true })
    this.child.stderr.on('data', (d: Buffer) => (this.stderr += d.toString()))
    this.child.stdin.on('error', (e) => (this.failed ??= e))
    this.exited = new Promise((resolve) => {
      this.child.on('error', (e) => {
        this.failed ??= e
        resolve(-1)
      })
      this.child.on('close', (code) => resolve(code ?? -1))
    })
  }

  /** Writes one encoded frame; waits when ffmpeg is behind. */
  async write(frame: Buffer): Promise<void> {
    if (this.failed) throw this.error()
    if (!this.child.stdin.write(frame)) await Promise.race([once(this.child.stdin, 'drain'), this.exited]).catch(() => undefined)
    if (this.failed) throw this.error()
  }

  private error(): Error {
    return new Error(`ffmpeg encode failed: ${this.stderr.trim().split('\n').slice(-6).join(' | ') || this.failed?.message}`)
  }

  async finish(): Promise<void> {
    this.child.stdin.end()
    const code = await this.exited
    if (code !== 0) throw this.error()
  }

  abort(): void {
    this.child.kill()
  }
}
