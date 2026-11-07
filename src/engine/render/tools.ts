import { promises as fs } from 'node:fs'
import { z } from 'zod'
import { LANGS, RIG_VARIANTS } from '../../shared/contracts'
import { ToolOutput } from '../mcp/tools'
import type { Tool, ToolDef } from '../mcp/tools'
import type { CtsService } from '../service'
import { assertId, assertSlug } from '../series/paths'
import { renderEpisode } from './render'
import type { RenderResult } from './render'
import { contactSheet, poseSheet } from './sheet'

/**
 * MCP tools of the render (CTS-05): `cts_render` (a long call: it returns job ids at once; `cts_render_status` shows them, or pass
 * `wait: true`), `cts_frames` (contact sheet of an episode) and `cts_pose_sheet` (pose sheet of a rig). Both sheet tools return the PNG path and
 * the picture itself.
 *
 * The render jobs live in this process (not in the markdown job queue: a render needs no model and no agent); the id is
 * `<series>--render--<episode>-<lang>-<quality>--r<n>`.
 */

export interface RenderJob {
  id: string
  state: 'running' | 'done' | 'failed'
  progress: { done: number; total: number }
  startedAt: string
  result?: Pick<RenderResult, 'file' | 'seconds' | 'wallSeconds' | 'encoder' | 'frames' | 'logFile' | 'warnings'> & {
    /** The least dB the music is under the voice over the lines (final renders; null without music or voice). */
    minUnderDb: number | null
  }
  error?: string
}

const jobs = new Map<string, RenderJob>()
const runs = new Map<string, number>()
const MAX_KEPT = 50

async function withImage(file: string, data: Record<string, unknown>): Promise<unknown> {
  const buf = await fs.readFile(file)
  const out = { file, ...data }
  return buf.length > 4_000_000 ? out : new ToolOutput(out, [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }])
}

export function renderTools(svc: CtsService, def: ToolDef): Tool[] {
  const series = z.string().describe('The series slug')
  const episode = z.string().describe('The episode id')
  const lang = z.enum(LANGS)

  return [
    def(
      'cts_render',
      'Render an episode to MP4 with the Canvas player in headless Chromium and ffmpeg: out/<lang>.mp4 (quality final, 1920x1080, real Flow clips spliced in) or out/<lang>.preview.mp4 (quality preview, 960x540, clips show a placeholder card), under the episode folder. Audio is mixed (voices, music ducked under voices, sfx), normalised to -16 LUFS. Every input is brought to its level relative to the voice first (render.md mix: music 18 dB under while a voice plays, 8 dB under in the gaps); a final render writes render/<lang>/mix-check.json and the result has minUnderDb (the least dB the music is under the voice over the lines). Long: returns one job id per language at once; follow with cts_render_status, or pass wait true to get the results. render/<lang>/render.log has the frame count, stage times and encoder.',
      z.object({
        series,
        episode,
        langs: z.array(lang).min(1).default([...LANGS]),
        quality: z.enum(['preview', 'final']).default('preview'),
        maxSeconds: z.number().positive().optional().describe('Render only the first seconds (quick look)'),
        wait: z.boolean().default(false)
      }),
      async (a) => {
        assertSlug(a.series)
        assertId(a.episode, 'episode id')
        const started: RenderJob[] = []
        for (const l of a.langs) {
          const key = `${a.series}--render--${a.episode}-${l}-${a.quality}`
          const run = (runs.get(key) ?? 0) + 1
          runs.set(key, run)
          const job: RenderJob = { id: `${key}--r${run}`, state: 'running', progress: { done: 0, total: 0 }, startedAt: new Date().toISOString() }
          jobs.set(job.id, job)
          while (jobs.size > MAX_KEPT) jobs.delete(jobs.keys().next().value as string)
          const p = renderEpisode({
            dataDir: svc.dataDir,
            series: a.series,
            episode: a.episode,
            lang: l,
            quality: a.quality,
            ...(a.maxSeconds ? { maxSeconds: a.maxSeconds } : {}),
            onProgress: (done, total) => (job.progress = { done, total })
          }).then(
            (r) => {
              job.state = 'done'
              job.progress = { done: r.frames, total: r.frames }
              job.result = { file: r.file, seconds: r.seconds, wallSeconds: r.wallSeconds, encoder: r.encoder, frames: r.frames, logFile: r.logFile, warnings: r.warnings, minUnderDb: r.mixCheck?.minUnderDb ?? null }
              svc.log(`render ${job.id} done: ${r.file} (${r.wallSeconds.toFixed(1)} s, ${r.encoder})`)
            },
            (err: Error) => {
              job.state = 'failed'
              job.error = err.message
              svc.log(`render ${job.id} failed: ${err.message}`)
            }
          )
          started.push(job)
          if (a.wait) await p
        }
        return { jobs: started }
      }
    ),
    def(
      'cts_render_status',
      'Status of render jobs started by cts_render: state (running | done | failed), progress in frames, and the result (file, seconds, wall time, encoder) or the error. Without id: all jobs of this session.',
      z.object({ id: z.string().optional() }),
      async (a) => ({ jobs: a.id ? [jobs.get(a.id)].filter((j): j is RenderJob => !!j) : [...jobs.values()] })
    ),
    def(
      'cts_frames',
      'Contact sheet of an episode: N frames evenly spread (count, default 12) or at the given times in seconds, each labelled with its time, in one PNG at episodes/<ep>/render/<lang>/sheet-<n>.png. Returns the path and the picture. Clip ranges show the placeholder card.',
      z.object({ series, episode, lang: lang.default('hr'), count: z.number().int().min(1).max(60).optional(), times: z.array(z.number().min(0)).max(60).optional() }),
      async (a) => {
        const file = await contactSheet({ dataDir: svc.dataDir, series: a.series, episode: a.episode, lang: a.lang, ...(a.count ? { count: a.count } : {}), ...(a.times ? { times: a.times } : {}) })
        return withImage(file, {})
      }
    ),
    def(
      'cts_pose_sheet',
      'Pose sheet of a cast member: neutral, every emotion, every gesture at its peak, the 8 mouths and the 3 eye states, labelled, drawn from the rig. Written to cast/<id>/rig-sheet.png (or cast/<id>/variants/<a|c>/rig-sheet.png); cast/<id>/sheet.png is the character sheet of the cast_sheet step and is not touched. Returns the path and the picture.',
      z.object({ series, cast: z.string(), variant: z.enum(RIG_VARIANTS).optional() }),
      async (a) => {
        const file = await poseSheet({ dataDir: svc.dataDir, series: a.series, cast: a.cast, ...(a.variant ? { variant: a.variant } : {}) })
        return withImage(file, {})
      }
    )
  ]
}
