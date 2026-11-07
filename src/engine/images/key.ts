import sharp from 'sharp'

/**
 * The colour key for pictures drawn on a flat grey (or any flat) background, and the Z-Image halo cleanup (decision 11).
 *  1. Key: a pixel within `tolerance` (euclidean RGB distance) of the key colour becomes transparent; up to `tolerance + feather` it fades.
 *     The key colour is the average of the four corner pixels unless given.
 *  2. Rim: Z-Image draws a near-white sticker outline round a figure. Near-white pixels (all channels >= `whiteMin`) that touch the transparent
 *     area are removed, `rimPx` times, so only the outline goes and white inside the figure stays.
 */

export interface KeyOptions {
  key?: { r: number; g: number; b: number }
  tolerance?: number
  feather?: number
  /** Passes of rim removal (pixels deep). 0 = off. Default 3. */
  rimPx?: number
  whiteMin?: number
}

export async function keyOut(input: Buffer, opts: KeyOptions = {}): Promise<Buffer> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: w, height: h } = info
  const px = (x: number, y: number) => (y * w + x) * 4
  let key = opts.key
  if (!key) {
    const cs = [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)]
    key = { r: avg(cs.map((i) => data[i]!)), g: avg(cs.map((i) => data[i + 1]!)), b: avg(cs.map((i) => data[i + 2]!)) }
  }
  const tol = opts.tolerance ?? 40
  const feather = opts.feather ?? 24
  for (let i = 0; i < data.length; i += 4) {
    const d = Math.hypot(data[i]! - key.r, data[i + 1]! - key.g, data[i + 2]! - key.b)
    if (d <= tol) data[i + 3] = 0
    else if (d < tol + feather) data[i + 3] = Math.round((data[i + 3]! * (d - tol)) / feather)
  }
  const whiteMin = opts.whiteMin ?? 235
  const near = (i: number) => data[i + 3]! > 0 && data[i]! >= whiteMin && data[i + 1]! >= whiteMin && data[i + 2]! >= whiteMin
  for (let pass = 0; pass < (opts.rimPx ?? 3); pass++) {
    const drop: number[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = px(x, y)
        if (!near(i)) continue
        const clear = (nx: number, ny: number) => nx < 0 || ny < 0 || nx >= w || ny >= h || data[px(nx, ny) + 3]! === 0
        if (clear(x - 1, y) || clear(x + 1, y) || clear(x, y - 1) || clear(x, y + 1)) drop.push(i)
      }
    }
    if (drop.length === 0) break
    for (const i of drop) data[i + 3] = 0
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()
}

const avg = (v: number[]) => Math.round(v.reduce((a, b) => a + b, 0) / v.length)
