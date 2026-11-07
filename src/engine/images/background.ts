import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { comfyKindSwitch } from '../comfy/kind-switch'
import { keyOut } from './key'
import { pick } from './provider'
import type { ImageContext } from './provider'
import { removeBackground } from './comfy'

/**
 * Set art (CTS-07, step 4): a 1920x1080 background from ComfyUI, upscaled 1.5x with sharp (lanczos) so a 1.5 zoom stays sharp, and one foreground prop on a flat
 * grey keyed to alpha (BiRefNet through ComfyUI only if the colour key leaves a fringe). Local and free.
 */

export const BG_SIZE = { width: 1920, height: 1080 } as const
export const SET_SIZE: [number, number] = [2880, 1620]
export const BG_SUFFIX = 'A wide flat children\'s cartoon background, solid flat colours with a simple dark outline, a clear open floor strip in the lower third where characters can stand, nothing in the middle foreground, no characters, no people, no animals in the middle, no text, no logos.'
export const PROP_SUFFIX = 'One single object, centred, whole object visible, on a plain flat solid #808080 grey background, no shadow, no floor. Flat solid colours, thick dark outline, children\'s paper-cutout cartoon style, no text.'

/** The share of opaque pixels that are still close to the key grey after the key: a fringe the colour key could not remove. */
export async function fringeShare(png: Buffer, key = { r: 128, g: 128, b: 128 }, tol = 40): Promise<number> {
  const data = await sharp(png).ensureAlpha().raw().toBuffer()
  let opaque = 0
  let grey = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < 200) continue
    opaque++
    if (Math.hypot(data[i]! - key.r, data[i + 1]! - key.g, data[i + 2]! - key.b) < tol) grey++
  }
  return opaque === 0 ? 0 : grey / opaque
}

export interface SetArt {
  background: string
  prop: string | null
  model: string
  secondsBackground: number
  secondsProp: number
  usedBiRefNet: boolean
}

export async function makeSetArt(o: { ctx: ImageContext; setDir: string; backgroundPrompt: string; propPrompt: string | null; seed: number; log: (m: string) => void; signal?: AbortSignal }): Promise<SetArt> {
  await comfyKindSwitch('image', { dataDir: o.ctx.svc.dataDir, log: o.log })
  const provider = await pick('comfy', o.ctx)
  const layers = path.join(o.setDir, 'layers')
  await fs.mkdir(layers, { recursive: true })
  const t0 = Date.now()
  const bg = await provider.generate({ prompt: `${o.backgroundPrompt.trim().replace(/[.\s]*$/, '.')} ${BG_SUFFIX}`, size: BG_SIZE, format: 'png', out: path.join(layers, 'bg-1x'), seed: o.seed, signal: o.signal })
  const background = path.join(layers, 'bg.png')
  await sharp(bg.file).resize({ width: SET_SIZE[0], height: SET_SIZE[1], kernel: 'lanczos3' }).png().toFile(background)
  const secondsBackground = Math.round((Date.now() - t0) / 100) / 10
  o.log(`background ${background} (${SET_SIZE.join('x')}, ${secondsBackground} s, ${bg.model})`)
  let prop: string | null = null
  let secondsProp = 0
  let usedBiRefNet = false
  if (o.propPrompt) {
    const t1 = Date.now()
    const raw = await provider.generate({ prompt: `${o.propPrompt.trim().replace(/[.\s]*$/, '.')} ${PROP_SUFFIX}`, size: { width: 1024, height: 1024 }, format: 'png', out: path.join(layers, 'prop-raw'), seed: o.seed + 1, signal: o.signal })
    const bytes = await fs.readFile(raw.file)
    let keyed = await keyOut(bytes)
    if ((await fringeShare(keyed)) > 0.005) {
      const cut = await removeBackground({ svc: o.ctx.svc }, bytes, o.signal).catch(() => null)
      if (cut) {
        keyed = cut
        usedBiRefNet = true
      }
    }
    prop = path.join(layers, 'prop.png')
    await sharp(keyed).trim().png().toFile(prop)
    secondsProp = Math.round((Date.now() - t1) / 100) / 10
    o.log(`prop ${prop} (${secondsProp} s${usedBiRefNet ? ', BiRefNet' : ''})`)
  }
  return { background, prop, model: bg.model, secondsBackground, secondsProp, usedBiRefNet }
}
