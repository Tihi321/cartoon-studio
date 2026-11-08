/// <reference lib="dom" />
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Lang, RigVariant, Timeline } from '../../shared/contracts'
import { SeriesStore } from '../series/service'
import { withPlayer } from './browser'

/**
 * Sheets drawn by the player in the headless browser (so the labels use the browser's fonts):
 *   `contactSheet`  N frames of an episode, evenly spread or at given times, each with its time -> `episodes/<ep>/render/<lang>/sheet-<n>.png`
 *   `poseRender`    one rig at the peak of a gesture on flat grey, 1024x1536 (the input of a pose image, CTS-14), with where its feet and head are
 *   `poseSheet`     the labelled pose grid of a rig -> `cast/<id>/rig-sheet.png` (or `cast/<id>/variants/<v>/rig-sheet.png`; `cast/<id>/sheet.png` is the character sheet the user approves)
 */

interface SheetWindow {
  cts: {
    load(tl: unknown, base: string, o: { width: number; height: number }): Promise<void>
    renderFrame(i: number): Promise<void>
    canvas: HTMLCanvasElement
    ready: Promise<void>
    error: string | null
    poseInfo: { gesture: string; k: number; pivot: [number, number]; head: [number, number] } | null
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

/** The rig's pose sheet. (`sheet.png` beside it is the character sheet of the cast_sheet step.) */
export const RIG_SHEET = 'rig-sheet.png'

/**
 * The rig pose sheet in a rig folder, as a name: `rig-sheet.png`, else (series made before pilot 2, which have no `sheet/meta.json`, so their
 * `sheet.png` is a pose sheet) `sheet.png`, else null.
 */
export async function rigSheetName(rigDir: string, castDir: string): Promise<string | null> {
  const has = (f: string) => fs.stat(f).then((s) => s.isFile(), () => false)
  if (await has(path.join(rigDir, RIG_SHEET))) return RIG_SHEET
  if ((await has(path.join(rigDir, 'sheet.png'))) && !(await has(path.join(castDir, 'sheet', 'meta.json')))) return 'sheet.png'
  return null
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
  const file = path.join(paths.rigDir(req.cast, req.variant), RIG_SHEET)
  await fs.writeFile(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
  return file
}

export interface PoseRenderRequest {
  dataDir: string
  series: string
  cast: string
  gesture: string
  variant?: RigVariant
  /** Absolute output path (a PNG). */
  out: string
  playerDir?: string
}

export interface PoseRender {
  file: string
  /** Canvas pixels per rig pixel (1, or less when the figure does not fit 1024x1536). */
  k: number
  /** The feet point in the picture, in px. */
  pivot: [number, number]
  /** The head part's image top-left in the picture, in px. */
  head: [number, number]
}

/** The rig at the peak of one gesture, neutral face, on flat #808080 (player `?sheet=<cast>&pose=<gesture>`). */
export async function poseRender(req: PoseRenderRequest): Promise<PoseRender> {
  const query = `?series=${encodeURIComponent(req.series)}&sheet=${encodeURIComponent(req.cast)}&pose=${encodeURIComponent(req.gesture)}${req.variant ? `&variant=${req.variant}` : ''}`
  const got = await withPlayer({ dataDir: req.dataDir, query, ...(req.playerDir ? { playerDir: req.playerDir } : {}) }, async ({ page }) => {
    await page.evaluate(() => (window as unknown as SheetWindow).cts.ready).catch(() => undefined)
    const err = await page.evaluate(() => (window as unknown as SheetWindow).cts.error)
    if (err) throw new Error(`pose render of ${req.cast}/${req.gesture}: ${err}`)
    return page.evaluate(() => {
      const c = (window as unknown as SheetWindow).cts
      return { url: c.canvas.toDataURL('image/png'), info: c.poseInfo }
    })
  })
  if (!got.info) throw new Error(`pose render of ${req.cast}/${req.gesture}: the player gave no pose info`)
  await fs.mkdir(path.dirname(req.out), { recursive: true })
  await fs.writeFile(req.out, Buffer.from(got.url.slice(got.url.indexOf(',') + 1), 'base64'))
  return { file: req.out, k: got.info.k, pivot: got.info.pivot, head: got.info.head }
}

export interface StillFrameRequest {
  dataDir: string
  series: string
  /** A one-scene timeline (see `buildStillTimeline`); frame 0 is drawn. */
  timeline: Timeline
  /** Absolute output path (a PNG). */
  out: string
  width?: number
  height?: number
  playerDir?: string
}

/** One frame of a timeline drawn by the player (no label), saved as a PNG: the clip keyframe. Default 1280x720. Returns `out`. */
export async function stillFrame(req: StillFrameRequest): Promise<string> {
  const width = req.width ?? 1280
  const height = req.height ?? 720
  const dataUrl = await withPlayer({ dataDir: req.dataDir, ...(req.playerDir ? { playerDir: req.playerDir } : {}) }, async ({ page, origin }) => {
    await page.evaluate(
      async ([timeline, base, w, h]) => {
        const win = window as unknown as SheetWindow
        await win.cts.load(timeline, base as string, { width: w as number, height: h as number })
        await win.cts.renderFrame(0)
      },
      [req.timeline, `${origin}/files/${req.series}/`, width, height] as const
    )
    return page.evaluate(() => (window as unknown as SheetWindow).cts.canvas.toDataURL('image/png'))
  })
  await fs.mkdir(path.dirname(req.out), { recursive: true })
  await fs.writeFile(req.out, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
  return req.out
}
