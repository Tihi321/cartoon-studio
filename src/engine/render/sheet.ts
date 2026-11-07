/// <reference lib="dom" />
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Lang, RigVariant, Timeline } from '../../shared/contracts'
import { SeriesStore } from '../series/service'
import { withPlayer } from './browser'

/**
 * Sheets drawn by the player in the headless browser (so the labels use the browser's fonts):
 *   `contactSheet`  N frames of an episode, evenly spread or at given times, each with its time -> `episodes/<ep>/render/<lang>/sheet-<n>.png`
 *   `poseSheet`     the labelled pose grid of a rig -> `cast/<id>/sheet.png` (or `cast/<id>/variants/<v>/sheet.png`)
 */

interface SheetWindow {
  cts: {
    load(tl: unknown, base: string, o: { width: number; height: number }): Promise<void>
    renderFrame(i: number): Promise<void>
    canvas: HTMLCanvasElement
    ready: Promise<void>
    error: string | null
  }
  __frames?: ImageBitmap[]
}

export interface ContactSheetRequest {
  dataDir: string
  series: string
  episode: string
  lang: Lang
  /** How many frames, evenly spread over the episode (default 12). Ignored when `times` is given. */
  count?: number
  /** Seconds to grab. */
  times?: number[]
  /** Width of one cell in px (default 480). */
  cellWidth?: number
  /** Read this timeline instead of `timeline.<lang>.json`. */
  timeline?: Timeline
  playerDir?: string
}

/** The times of an even spread: the middle of each of `count` equal slices. */
export function evenTimes(duration: number, count: number): number[] {
  return Array.from({ length: count }, (_, k) => Math.round(((k + 0.5) / count) * duration * 100) / 100)
}

export async function contactSheet(req: ContactSheetRequest): Promise<string> {
  const store = new SeriesStore(req.dataDir)
  const paths = store.paths(req.series)
  const tl = req.timeline ?? (await store.readTimeline(req.series, req.episode, req.lang))
  const fps = tl.fps.out
  const frameTotal = Math.max(1, Math.ceil(tl.duration * fps))
  const times = req.times && req.times.length ? req.times : evenTimes(tl.duration, Math.max(1, Math.min(req.count ?? 12, 60)))
  const cellW = req.cellWidth ?? 480
  const cellH = Math.round((cellW * 9) / 16)
  const frames = times.map((t) => Math.min(frameTotal - 1, Math.max(0, Math.round(t * fps))))

  const dataUrl = await withPlayer({ dataDir: req.dataDir, ...(req.playerDir ? { playerDir: req.playerDir } : {}) }, async ({ page, origin }) => {
    await page.evaluate(
      async ([timeline, base, w, h]) => {
        await (window as unknown as SheetWindow).cts.load(timeline, base as string, { width: w as number, height: h as number })
        ;(window as unknown as SheetWindow).__frames = []
      },
      [tl, `${origin}/files/${req.series}/`, cellW, cellH] as const
    )
    for (const i of frames) {
      await page.evaluate(async (idx) => {
        const w = window as unknown as SheetWindow
        await w.cts.renderFrame(idx)
        w.__frames!.push(await createImageBitmap(w.cts.canvas))
      }, i)
    }
    return page.evaluate(
      ([labels, w, h]) => {
        const win = window as unknown as SheetWindow
        const bitmaps = win.__frames!
        const cols = Math.min(bitmaps.length, bitmaps.length > 6 ? 4 : 3)
        const rows = Math.ceil(bitmaps.length / cols)
        const cw = w as number
        const ch = h as number
        const label = 24
        const gap = 4
        const sheet = document.createElement('canvas')
        sheet.width = cols * (cw + gap) + gap
        sheet.height = rows * (ch + label + gap) + gap
        const ctx = sheet.getContext('2d')!
        ctx.fillStyle = '#111'
        ctx.fillRect(0, 0, sheet.width, sheet.height)
        ctx.font = '15px sans-serif'
        ctx.textBaseline = 'middle'
        bitmaps.forEach((b, k) => {
          const x = gap + (k % cols) * (cw + gap)
          const y = gap + Math.floor(k / cols) * (ch + label + gap)
          ctx.drawImage(b, x, y, cw, ch)
          ctx.fillStyle = '#eee'
          ctx.fillText(labels[k] as string, x + 4, y + ch + label / 2)
        })
        return sheet.toDataURL('image/png')
      },
      [times.map((t, k) => `${t.toFixed(2)} s   frame ${frames[k]}`), cellW, cellH] as const
    )
  })

  const dir = path.join(paths.episodeDir(req.episode), 'render', req.lang)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `sheet-${times.length}.png`)
  await fs.writeFile(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
  return file
}

export interface PoseSheetRequest {
  dataDir: string
  series: string
  cast: string
  variant?: RigVariant
  playerDir?: string
}

export async function poseSheet(req: PoseSheetRequest): Promise<string> {
  const paths = new SeriesStore(req.dataDir).paths(req.series)
  const query = `?series=${encodeURIComponent(req.series)}&sheet=${encodeURIComponent(req.cast)}${req.variant ? `&variant=${req.variant}` : ''}`
  const dataUrl = await withPlayer({ dataDir: req.dataDir, query, ...(req.playerDir ? { playerDir: req.playerDir } : {}) }, async ({ page }) => {
    await page.evaluate(() => (window as unknown as SheetWindow).cts.ready).catch(() => undefined)
    const err = await page.evaluate(() => (window as unknown as SheetWindow).cts.error)
    if (err) throw new Error(`pose sheet of ${req.cast}: ${err}`)
    return page.evaluate(() => (window as unknown as SheetWindow).cts.canvas.toDataURL('image/png'))
  })
  const file = path.join(paths.rigDir(req.cast, req.variant), 'sheet.png')
  await fs.writeFile(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
  return file
}
