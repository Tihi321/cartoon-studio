// The stage: loads a timeline's assets once, then draws output frame `i` as a pure function of (timeline, i).
//
// Conventions (documented in docs/player.md):
//  - timeline x/y are the actor's feet point in set pixels; camera `center` is in set pixels; the camera scale is
//    (frame height / set height) * zoom, so zoom 1 fits the whole set height into the frame.
//  - actor poses are sampled on the animation grid (fps.anim, 12), the camera at the output rate (fps.out, 24).
//  - the `bob` track is an amplitude 0..1 of the rig's `move.bobPx`; the bounce is |sin| over `move.stepSeconds` on the grid time.
//  - layers are drawn by `z`; actors are drawn at ACTOR_Z, so layers below it are behind the actors and layers at or above are in front.
//  - a layer with parallax k is shifted by (setCentre - cameraCentre) * (k - 1): k = 1 is fixed in the world.
import {
  timelineSchema,
  type EyeState,
  type MouthShape,
  type Timeline,
  type TimelineActor,
  type TimelineClip
} from '../shared/contracts'
import { sampleCamera, sampleNumber, sampleStep, snapToGrid } from '../shared/sample'
import { loadRigAssets, loadSetAssets, resolveUrl, type RigAssets, type SetAssets, type Sprite } from './assets'
import { drawActor, emotionFace, type Pose } from './puppet'

export const ACTOR_Z = 50

export interface LoadOptions {
  width: number
  height: number
  /** Clip id -> url of its first-frame still (relative to `baseUrl`, or absolute); drawn on the placeholder card. */
  clipStills?: Record<string, string>
  /** Use `cast/<id>/variants/<variant>/rig.json` instead of `cast/<id>/rig.json`. */
  variant?: string
}

/** Number of output frames for a timeline: ceil(duration * fps.out). */
export function frameCountFor(duration: number, fpsOut: number): number {
  return Math.max(0, Math.ceil(duration * fpsOut - 1e-9))
}
/** Start time in seconds of output frame `i`. */
export function frameTime(i: number, fpsOut: number): number {
  return i / fpsOut
}
/** The output frame shown at time `t`. */
export function frameAt(t: number, fpsOut: number): number {
  return Math.max(0, Math.floor(t * fpsOut + 1e-9))
}

export class Stage {
  timeline: Timeline | null = null
  private sets = new Map<string, SetAssets>()
  private rigs = new Map<string, RigAssets>()
  private stills = new Map<string, ImageBitmap>()
  width = 960
  height = 540

  frameCount(): number {
    return this.timeline ? frameCountFor(this.timeline.duration, this.timeline.fps.out) : 0
  }

  async load(timelineJson: unknown, baseUrl: string, opts: LoadOptions): Promise<void> {
    const tl = timelineSchema.parse(timelineJson)
    this.width = opts.width
    this.height = opts.height
    const base = new URL(baseUrl, document.baseURI).href.replace(/\/?$/, '/')

    const setIds = [...new Set(tl.scenes.map((s) => s.set))]
    const sets = new Map<string, SetAssets>()
    await Promise.all(setIds.map(async (id) => void sets.set(id, await loadSetAssets(`${base}sets/${id}/set.json`))))

    // Raster scale for SVG parts: the biggest on-screen scale the camera ever asks for.
    const maxZoom = Math.max(...tl.camera.map((c) => c.zoom))
    const fit = Math.max(...[...sets.values()].map((s) => opts.height / s.set.size[1]))
    const rigs = new Map<string, RigAssets>()
    await Promise.all(
      Object.keys(tl.actors).map(async (id) => {
        const dir = opts.variant ? `cast/${id}/variants/${opts.variant}/` : `cast/${id}/`
        const sc = Math.max(...[...sets.values()].map((s) => s.set.actorScale), 1)
        rigs.set(id, await loadRigAssets(`${base}${dir}rig.json`, fit * maxZoom * sc))
      })
    )

    const stills = new Map<string, ImageBitmap>()
    for (const [id, url] of Object.entries(opts.clipStills ?? {})) {
      const res = await fetch(resolveUrl(url, base), { cache: 'no-store' })
      if (res.ok) stills.set(id, await createImageBitmap(await res.blob()))
    }

    this.sets = sets
    this.rigs = rigs
    this.stills = stills
    this.timeline = tl
  }

  /** Draws output frame `i` on `ctx` (whose canvas must be `width` x `height`). */
  draw(ctx: CanvasRenderingContext2D, i: number): void {
    const tl = this.timeline
    if (!tl) throw new Error('cts.load() has not been called')
    const W = this.width
    const H = this.height
    const t = frameTime(i, tl.fps.out)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    const clip = tl.clips.find((c) => t >= c.t0 && t < c.t1)
    if (clip) {
      this.drawClipCard(ctx, clip, W, H)
      return
    }

    const title = (tl.titles ?? []).find((c) => t >= c.t0 && t < c.t1)
    if (title) {
      this.drawTitleCard(ctx, title.text, W, H)
      return
    }

    ctx.fillStyle = '#202020'
    ctx.fillRect(0, 0, W, H)
    const scene = this.sceneAt(tl, t)
    const setAssets = scene ? this.sets.get(scene.set) : undefined
    if (!setAssets) return
    const { set } = setAssets
    const cam = sampleCamera(tl.camera, t)
    const s = (H / set.size[1]) * cam.zoom
    const camMatrix = new DOMMatrix([s, 0, 0, s, W / 2 - cam.center[0] * s, H / 2 - cam.center[1] * s])

    type Item = { z: number; kind: number; y: number; id: string; run: () => void }
    const items: Item[] = []
    for (const l of set.layers) {
      const sprite = setAssets.layers.get(l.id)
      if (!sprite) continue
      items.push({ z: l.z, kind: 0, y: 0, id: l.id, run: () => this.drawLayer(ctx, camMatrix, set, l, sprite, cam.center) })
    }
    const tg = snapToGrid(t, tl.fps.anim)
    for (const [id, track] of Object.entries(tl.actors)) {
      const rig = this.rigs.get(id)
      if (!rig) continue
      if (sampleStep(track.visible, tg) === false) continue
      const pose = this.poseAt(rig, track, tg, t, tl.fps.anim)
      items.push({
        z: ACTOR_Z,
        kind: 1,
        y: pose.y,
        id,
        run: () => {
          ctx.setTransform(camMatrix)
          drawActor(ctx, rig, pose, set.actorScale)
        }
      })
    }
    items.sort((a, b) => a.z - b.z || a.kind - b.kind || a.y - b.y || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    for (const it of items) it.run()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }

  private sceneAt(tl: Timeline, t: number) {
    let found = tl.scenes[0]
    for (const sc of tl.scenes) if (sc.t0 <= t + 1e-9) found = sc
    return found
  }

  private poseAt(rig: RigAssets, a: TimelineActor, tg: number, t: number, animFps: number): Pose {
    const face = emotionFace(rig, sampleStep(a.emotion, tg) ?? 'neutral')
    const eyeTrack: EyeState = sampleStep(a.eyes, tg) ?? 'open'
    const eyes: EyeState = eyeTrack === 'open' ? face.eyes : eyeTrack
    const mouth: MouthShape = sampleStep(a.mouth, tg) ?? 'rest'
    const rot: Record<string, number> = {}
    for (const [part, track] of Object.entries(a.rot)) rot[part] = sampleNumber(track, t, animFps)
    const amp = a.bob.length ? sampleNumber(a.bob, t, animFps) : 0
    const { bobPx, stepSeconds } = rig.rig.move
    const bob = amp > 0 ? bobPx * amp * Math.abs(Math.sin((Math.PI * tg) / stepSeconds)) : 0
    return {
      x: sampleNumber(a.x, t, animFps),
      y: sampleNumber(a.y, t, animFps),
      facing: sampleStep(a.facing, tg) ?? rig.rig.drawnFacing,
      bobPx: bob,
      rot,
      brows: face.brows,
      eyes,
      mouth,
      poseImage: sampleStep(a.pose ?? [], tg) ?? null
    }
  }

  private drawLayer(
    ctx: CanvasRenderingContext2D,
    cam: DOMMatrix,
    set: SetAssets['set'],
    l: SetAssets['set']['layers'][number],
    sprite: Sprite,
    camCenter: [number, number]
  ): void {
    const k = l.parallax
    const dx = (set.size[0] / 2 - camCenter[0]) * (k - 1)
    const dy = (set.size[1] / 2 - camCenter[1]) * (k - 1)
    ctx.setTransform(cam)
    if (!l.at) {
      // a full-set backdrop: stretched over the set's size
      ctx.drawImage(sprite.bitmap, dx, dy, set.size[0], set.size[1])
      return
    }
    const w = sprite.w
    const h = sprite.h
    const [ax, ay] = l.at
    const x = (l.anchor === 'center' || l.anchor === 'bottom' ? ax - w / 2 : ax) + dx
    const y = (l.anchor === 'center' ? ay - h / 2 : l.anchor === 'bottom' ? ay - h : ay) + dy
    ctx.drawImage(sprite.bitmap, x, y, w, h)
  }

  /** A static title card: flat fixed-palette card, the text centred, wrapped and shrunk to fit. System sans-serif only (no late-loading fonts). */
  private drawTitleCard(ctx: CanvasRenderingContext2D, text: string, W: number, H: number): void {
    ctx.fillStyle = '#0d3b66'
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = '#f4d35e'
    const m = Math.round(H * 0.06)
    ctx.fillRect(m, m, W - 2 * m, Math.round(H * 0.012))
    ctx.fillRect(m, H - m - Math.round(H * 0.012), W - 2 * m, Math.round(H * 0.012))
    const boxW = W * 0.8
    const boxH = H * 0.6
    let size = Math.round(H * 0.16)
    let lines: string[] = []
    for (; size >= 12; size -= 2) {
      ctx.font = `700 ${size}px sans-serif`
      lines = wrapText(ctx, text, boxW)
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width))
      if (widest <= boxW && lines.length * size * 1.2 <= boxH) break
    }
    ctx.fillStyle = '#faf0ca'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const lh = size * 1.2
    const y0 = H / 2 - ((lines.length - 1) * lh) / 2
    lines.forEach((l, n) => ctx.fillText(l, W / 2, y0 + n * lh))
    ctx.textAlign = 'start'
    ctx.textBaseline = 'alphabetic'
  }

  /** A flat card: clip id and length, plus the clip's first-frame still when `load` got one. Same pixels for every frame of the range. */
  private drawClipCard(ctx: CanvasRenderingContext2D, clip: TimelineClip, W: number, H: number): void {
    ctx.fillStyle = '#16213e'
    ctx.fillRect(0, 0, W, H)
    const still = this.stills.get(clip.id)
    if (still) {
      const k = Math.min(W / still.width, H / still.height)
      const w = still.width * k
      const h = still.height * k
      ctx.drawImage(still, (W - w) / 2, (H - h) / 2, w, h)
    }
    const bar = Math.round(H * 0.16)
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(0, H - bar, W, bar)
    ctx.fillStyle = '#ffffff'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    ctx.font = `600 ${Math.round(bar * 0.42)}px sans-serif`
    const secs = Math.round((clip.t1 - clip.t0) * 10) / 10
    ctx.fillText(`CLIP ${clip.id}  ${secs.toFixed(1)} s`, W / 2, H - bar / 2)
    ctx.textAlign = 'start'
    ctx.textBaseline = 'alphabetic'
  }
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (line && ctx.measureText(next).width > maxW) {
        out.push(line)
        line = word
      } else line = next
    }
    out.push(line)
  }
  return out
}
