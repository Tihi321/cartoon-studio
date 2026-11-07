// The Canvas player entry: defines `window.cts` (see docs/player.md) and starts preview or sheet mode from the url.
import './preview.css'
import { LANGS, type Lang, type Timeline } from '../shared/contracts'
import { loadRigAssets } from './assets'
import { mountPreview, fetchTimeline } from './preview'
import { drawSheet, sheetSize } from './sheet'
import { Stage, frameAt, frameTime, type LoadOptions } from './stage'

export interface CtsApi {
  /** Loads every asset the timeline needs. `baseUrl` is the series folder url (cast/, sets/, ...); resolves when all is decoded. */
  load(timeline: unknown, baseUrl: string, opts: LoadOptions): Promise<void>
  /** ceil(duration * fps.out) of the loaded timeline. */
  frameCount(): number
  /** Draws output frame i (time i / fps.out) on `canvas`; depends only on (timeline, i). */
  renderFrame(i: number): Promise<void>
  /** Output frame i's start time and the frame shown at time t. */
  frameTime(i: number): number
  frameAt(t: number): number
  /** Pose sheet of a rig: `cast/<castId>/rig.json` (or `variants/<variant>/`) under `baseUrl`; resizes the canvas to the sheet. */
  loadSheet(baseUrl: string, castId: string, variant?: string): Promise<void>
  canvas: HTMLCanvasElement
  /** Resolves when the url-driven start (preview or sheet mode) has finished loading; resolves at once when the url asks for none. */
  ready: Promise<void>
  /** Set when `ready` rejected. */
  error: string | null
}

declare global {
  interface Window {
    cts: CtsApi
  }
}

const canvas = document.getElementById('stage') as HTMLCanvasElement
const ctx = canvas.getContext('2d')
if (!ctx) throw new Error('no 2d canvas context')
const stage = new Stage()
const params = new URLSearchParams(location.search)

function sizeCanvas(w: number, h: number): void {
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
}

const cts: CtsApi = {
  async load(timeline, baseUrl, opts) {
    sizeCanvas(opts.width, opts.height)
    await stage.load(timeline, baseUrl, opts)
  },
  frameCount: () => stage.frameCount(),
  async renderFrame(i) {
    stage.draw(ctx, i)
  },
  frameTime: (i) => frameTime(i, stage.timeline?.fps.out ?? 24),
  frameAt: (t) => frameAt(t, stage.timeline?.fps.out ?? 24),
  async loadSheet(baseUrl, castId, variant) {
    const base = new URL(baseUrl, document.baseURI).href.replace(/\/?$/, '/')
    const dir = variant ? `cast/${castId}/variants/${variant}/` : `cast/${castId}/`
    const rig = await loadRigAssets(`${base}${dir}rig.json`, 3)
    const { width, height } = sheetSize(rig)
    sizeCanvas(width, height)
    drawSheet(ctx, rig, `${castId}${variant ? ` (variant ${variant})` : ''}`)
  },
  canvas,
  ready: Promise.resolve(),
  error: null
}
window.cts = cts

function filesBase(): string {
  const files = params.get('files') ?? new URL('../files/', location.href).href
  return files.replace(/\/?$/, '/')
}

function seriesUrl(series: string): string {
  return `${filesBase()}${encodeURIComponent(series)}/`
}

function message(text: string): void {
  const m = document.createElement('div')
  m.className = 'cts-message'
  m.dataset.testid = 'cts-message'
  m.textContent = text
  document.getElementById('app')?.append(m)
}

async function start(): Promise<void> {
  const series = params.get('series')
  const sheet = params.get('sheet')
  if (sheet) {
    if (!series) throw new Error('sheet mode needs ?series=<slug>&sheet=<castId>')
    await cts.loadSheet(seriesUrl(series), sheet, params.get('variant') ?? undefined)
    document.body.dataset.ready = 'sheet'
    return
  }
  if (params.get('preview') !== '1') return
  document.body.classList.add('preview')
  const episode = params.get('episode')
  if (!series || !episode) {
    message('Preview needs ?preview=1&series=<slug>&episode=<id>[&lang=hr|en][&t=<seconds>]')
    return
  }
  const base = seriesUrl(series)
  const w = Number(params.get('w')) || 960
  const h = Number(params.get('h')) || 540
  const wantLang = params.get('lang') as Lang | null
  const lang: Lang = wantLang && (LANGS as readonly string[]).includes(wantLang) ? wantLang : 'hr'
  let tl: Timeline | null = null
  const loadLang = async (l: Lang): Promise<void> => {
    const json = await fetchTimeline(base, episode, l)
    await cts.load(json, base, { width: w, height: h })
    tl = stage.timeline
  }
  await loadLang(lang)
  const root = document.getElementById('app') as HTMLElement
  mountPreview(
    root,
    {
      timeline: () => tl,
      frameCount: () => cts.frameCount(),
      renderFrame: (i) => cts.renderFrame(i),
      loadLang,
      baseUrl: base
    },
    { lang, t: Number(params.get('t')) || 0 }
  )
  document.body.dataset.ready = 'preview'
}

cts.ready = start().catch((e: unknown) => {
  cts.error = e instanceof Error ? e.message : String(e)
  message(`error: ${cts.error}`)
  document.body.dataset.ready = 'error'
})

