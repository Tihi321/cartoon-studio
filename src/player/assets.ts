// Asset loading for the player. Everything is decoded in `load` (never lazily during a frame), so `renderFrame(i)` has no I/O and no
// timing dependence. SVG parts go through a blob-URL Image and are rasterised once per needed scale into an ImageBitmap; PNG parts are
// decoded directly. A sprite remembers its size in rig pixels (`w`, `h`), whatever the raster scale was.
import { rigSchema, setSchema, type Rig, type SetFile } from '../shared/contracts'

export interface Sprite {
  bitmap: ImageBitmap
  /** Size in rig (or set) pixels: the bitmap is drawn at this size. */
  w: number
  h: number
}

export interface RigAssets {
  rig: Rig
  parts: Map<string, Sprite>
  eyes: Map<string, Sprite>
  brows: Map<string, Sprite>
  mouths: Map<string, Sprite>
}

export interface SetAssets {
  set: SetFile
  layers: Map<string, Sprite>
}

const MAX_SIDE = 4096

export async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`cannot load ${url}: HTTP ${res.status}`)
  return res.json()
}

/** Resolves `rel` against `baseUrl` (a file url, or a folder url ending in `/`). */
export function resolveUrl(rel: string, baseUrl: string): string {
  return new URL(rel, new URL(baseUrl, document.baseURI)).href
}

/** The size of an SVG in px: its viewBox, else width/height attributes, else 100x100. */
export function svgSize(text: string): { w: number; h: number } {
  const vb = /viewBox\s*=\s*["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)\s*["']/.exec(text)
  if (vb) {
    const w = Number(vb[3])
    const h = Number(vb[4])
    if (w > 0 && h > 0) return { w, h }
  }
  const w = /<svg[^>]*\swidth\s*=\s*["']([\d.]+)/.exec(text)
  const h = /<svg[^>]*\sheight\s*=\s*["']([\d.]+)/.exec(text)
  return { w: w ? Number(w[1]) : 100, h: h ? Number(h[1]) : 100 }
}

const spriteCache = new Map<string, Promise<Sprite>>()

/** Loads one image. `scale` is the raster scale wanted for an SVG (bitmap pixels per rig pixel); a PNG ignores it. */
export function loadSprite(url: string, scale: number): Promise<Sprite> {
  const isSvg = /\.svg(\?|$)/i.test(url)
  const s = isSvg ? Math.round(scale * 100) / 100 : 1
  const key = `${url}@${s}`
  let p = spriteCache.get(key)
  if (!p) {
    p = isSvg ? rasterSvg(url, s) : decodePng(url)
    spriteCache.set(key, p)
  }
  return p
}

export function clearSpriteCache(): void {
  spriteCache.clear()
}

async function decodePng(url: string): Promise<Sprite> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`cannot load ${url}: HTTP ${res.status}`)
  const bitmap = await createImageBitmap(await res.blob())
  return { bitmap, w: bitmap.width, h: bitmap.height }
}

async function rasterSvg(url: string, scale: number): Promise<Sprite> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`cannot load ${url}: HTTP ${res.status}`)
  const text = await res.text()
  const { w, h } = svgSize(text)
  const blobUrl = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = blobUrl
    await img.decode()
    const k = Math.min(Math.max(scale, 0.25), 8, MAX_SIDE / w, MAX_SIDE / h)
    const pw = Math.max(1, Math.ceil(w * k))
    const ph = Math.max(1, Math.ceil(h * k))
    const canvas = new OffscreenCanvas(pw, ph)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, pw, ph)
    return { bitmap: await createImageBitmap(canvas), w, h }
  } catch (e) {
    throw new Error(`cannot rasterise ${url}: ${(e as Error).message}`, { cause: e })
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

/** Loads rig.json at `rigUrl` and every part and face state it names (paths are relative to the folder of rig.json). */
export async function loadRigAssets(rigUrl: string, scale: number): Promise<RigAssets> {
  const rig = rigSchema.parse(await fetchJson(rigUrl))
  const get = (rel: string) => loadSprite(resolveUrl(rel, rigUrl), scale)
  const parts = new Map<string, Sprite>()
  const eyes = new Map<string, Sprite>()
  const brows = new Map<string, Sprite>()
  const mouths = new Map<string, Sprite>()
  const jobs: Promise<void>[] = []
  const add = (map: Map<string, Sprite>, id: string, rel: string | undefined) => {
    if (rel) jobs.push(get(rel).then((s) => void map.set(id, s)))
  }
  for (const p of rig.parts) add(parts, p.id, p.src)
  for (const [id, rel] of Object.entries(rig.face.eyes.states)) add(eyes, id, rel)
  for (const [id, rel] of Object.entries(rig.face.brows.states)) add(brows, id, rel)
  for (const [id, rel] of Object.entries(rig.face.mouth.shapes)) add(mouths, id, rel)
  await Promise.all(jobs)
  return { rig, parts, eyes, brows, mouths }
}

export async function loadSetAssets(setUrl: string): Promise<SetAssets> {
  const set = setSchema.parse(await fetchJson(setUrl))
  const layers = new Map<string, Sprite>()
  await Promise.all(set.layers.map(async (l) => void layers.set(l.id, await loadSprite(resolveUrl(l.src, setUrl), 1))))
  return { set, layers }
}
