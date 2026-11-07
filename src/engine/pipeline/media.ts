import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import type { z } from 'zod'
import type { Bible, ClipEntry, Lang, RigVariant } from '../../shared/contracts'
import { budgetState, localIso } from '../budget/spend'
import { isAbortError } from '../models/types'
import { makeSetArt, SET_SIZE } from '../images/background'
import { comfyInpaint } from '../images/face'
import { REF_SIZE, SHEET_CANDIDATES, SHEET_DENOISE, composeSheet, generateFromSketch, readSheetMeta, refPrompt } from '../images/reference'
import type { SheetMeta } from '../images/reference'
import { SHEET_POSES, SKETCH_BACKGROUND, SKETCH_SIZE, bodyPlanProblems, poseSketch, renderSketch, sketchProblems } from '../images/sketch'
import { buildEpisodeTimelines } from '../anim/timeline'
import { renderEpisode } from '../render/render'
import { contactSheet, poseSheet, rigSheetName } from '../render/sheet'
import { checkRig, lintSeries } from '../series/lint'
import { voiceDeps } from '../voice/tools'
import { readManifest } from '../voice/manifest'
import { runVoice } from '../voice/run'
import { clipsGate } from './clips'
import { ask, castView, imageCtx, relTo, requireChosen, seedOf, loadStyleGuide } from './env'
import type { Env } from './env'
import {
  RIG_PATHS,
  VARIANT_OF,
  buildRasterRig,
  chooseVariant,
  compareVariants,
  readVariants,
  recordVariant,
  writeRigSet
} from './rig'
import type { RigPath } from './rig'
import { assertClipId, generateClip, clipSheet, clipLocation, missingClips, readShots, upsertClip, videoDir } from './clips'
import type { bodyPlanAnswer, rigRasterAnswer, rigClaudeAnswer, refPickAnswer, setPlanAnswer, setPlaceAnswer, reviewAnswer } from './tasks'

type Raster = z.infer<typeof rigRasterAnswer>
type Claude = z.infer<typeof rigClaudeAnswer>

const exists = (f: string): Promise<boolean> => fs.stat(f).then((s) => s.isFile(), () => false)

// ---------------------------------------------------------------- step 2: character sheets

const readJson = async <T>(file: string): Promise<T | null> => fs.readFile(file, 'utf8').then((t) => JSON.parse(t) as T, () => null)

/**
 * Step `cast_sheet` (CTS-12), per character: the designer answers a body plan and an image prompt; the app draws the front sketch; Z-Image image-to-image
 * (denoise 0.8, seeds seed..seed+2) makes three candidates; the designer picks one -> `ref.png` (the master); three pose sketches (wave, point, shrug) at
 * the picked seed -> `sheet/<pose>.png`; `sheet.png` puts the master and the poses side by side. The time of every image goes to the log and the result.
 * The gate `sheet_review` after it waits for `cts_sheet_approve`; a redo note (`sheet-redo.json`) makes that character's sheet again with the note in the prompt.
 */
export async function castSheetStep(e: Env): Promise<string> {
  const bible = await requireChosen(e)
  const style = await loadStyleGuide(e.store.dataDir)
  const made: string[] = []
  for (const [i, c] of bible.cast.entries()) {
    const dir = e.store.paths(e.series).castDir(c.id)
    const redoNote = await readJson<{ note: string; attempt: number }>(path.join(dir, 'sheet-redo.json'))
    const before = await readSheetMeta(dir)
    const done = before && (await exists(path.join(dir, 'ref.png'))) && (await exists(path.join(dir, 'sheet.png')))
    if (done && !redoNote && e.detail !== 'redo') continue
    const attempt = redoNote?.attempt ?? (before ? before.attempt + 1 : 0)
    const note = redoNote?.note ?? null
    const baseSeed = seedOf(c.id) + attempt * 10
    const log = (m: string) => e.log(`${c.id}: ${m}`)
    e.progress(i / bible.cast.length, `sheet of ${c.id}`)
    const oldPlan = note ? await readJson<unknown>(path.join(dir, 'body-plan.json')) : null
    const palette = bible.style.palette
    const plan = await ask<z.infer<typeof bodyPlanAnswer>>(
      e,
      {
        id: `body-plan-${c.id}${attempt ? `-${attempt}` : ''}`,
        role: 'character-designer',
        kind: 'body-plan',
        prompt: `Design the character sheet of ${c.name.en}: the image prompt (the character only) and the body plan the app draws the front sketch from (flat palette colours on ${SKETCH_BACKGROUND}, ${SKETCH_SIZE.width}x${SKETCH_SIZE.height}). Z-Image will redraw the sketch at denoise ${SHEET_DENOISE}, so the silhouette you draw is the silhouette you get: read the rules of your guide.${note ? ` The user asked to make it again with this note: "${note}". Change the prompt and the body plan to follow it.` : ''}`,
        inputs: { paths: [], json: { character: castView(c), style: bible.style, palette, otherCharacters: bible.cast.filter((o) => o.id !== c.id).map(castView), audience: bible.audience, canvas: SKETCH_SIZE, poses: SHEET_POSES, ...(oldPlan ? { previousAnswerToRevise: oldPlan } : {}) } },
        output: { schema: 'body-plan', path: `tasks/body-plan-${c.id}.json` }
      },
      {
        // no style guide here: its drawing rules are for SVG parts (CTS-17 rewrites it); the body-plan guide has the sketch rules
        check: async (v) => {
          const a = v as z.infer<typeof bodyPlanAnswer>
          const out = bodyPlanProblems(a.bodyPlan, palette)
          if (out.length === 0) out.push(...(await sketchProblems(await renderSketch(a.bodyPlan))))
          return out
        }
      }
    )
    const bodyPlan = plan.value.bodyPlan
    await e.store.writeFile(e.series, 'body-plan.json', `${JSON.stringify(bodyPlan, null, 2)}\n`, dir)
    const sketch = await e.store.writeFile(e.series, 'sketch.png', await renderSketch(bodyPlan), dir)
    const prompt = refPrompt(plan.value.prompt, bible.style, note ?? undefined)
    const ctx = imageCtx(e, `character ${c.id} sheet`)
    await fs.rm(path.join(dir, 'ref'), { recursive: true, force: true })
    await fs.rm(path.join(dir, 'sheet'), { recursive: true, force: true })

    // three candidates of the front view
    const seconds: Record<string, number> = {}
    const cands: { k: number; file: string }[] = []
    const errors: string[] = []
    let model = ''
    for (let k = 0; k < SHEET_CANDIDATES; k++) {
      try {
        const r = await generateFromSketch({ ctx, prompt, sketch, out: path.join(dir, 'ref', `c${k + 1}`), seed: baseSeed + k, log, signal: e.ctx.signal })
        cands.push({ k, file: r.file })
        seconds[`c${k + 1}`] = r.seconds
        model = r.model
      } catch (err) {
        if (isAbortError(err) || e.ctx.signal.aborted) throw err
        errors.push((err as Error).message.split('\n')[0]!)
        log(`candidate ${k + 1} failed: ${errors[errors.length - 1]}`)
      }
    }
    if (cands.length === 0) throw new Error(`ComfyUI made no sheet image for ${c.id}: ${errors.join('; ')}`)
    const picked = await ask<z.infer<typeof refPickAnswer>>(
      e,
      {
        id: `ref-pick-${c.id}${attempt ? `-${attempt}` : ''}`,
        role: 'character-designer',
        kind: 'ref-pick',
        prompt: `Pick the best of the ${cands.length} master pictures of ${c.name.en} (numbered in the order attached; Z-Image drew them over your sketch): the clearest separate arms and legs attached at the shoulders, the colours of the character's look, a readable face, the closest to your body plan.${note ? ` The user's note: "${note}".` : ''}`,
        inputs: { paths: cands.map((x) => relTo(e, x.file)), json: { character: castView(c), count: cands.length } },
        output: { schema: 'ref-pick', path: `tasks/ref-pick-${c.id}.json` }
      },
      { system: style, check: (v) => ((v as z.infer<typeof refPickAnswer>).pick > cands.length ? [`pick must be 1 to ${cands.length}`] : []) }
    )
    const chosen = cands[Math.min(cands.length, Math.max(1, picked.value.pick)) - 1]!
    const seed = baseSeed + chosen.k
    const refPng = path.join(dir, 'ref.png')
    await fs.copyFile(chosen.file, refPng)
    const dims = await sharp(refPng).metadata()
    if (dims.width !== REF_SIZE.width || dims.height !== REF_SIZE.height) throw new Error(`the master of ${c.id} is ${dims.width}x${dims.height}, not ${REF_SIZE.width}x${REF_SIZE.height}`)

    // the three pose sketches, the picked seed and prompt (plus the pose in words)
    const poseFiles: string[] = []
    for (const pose of SHEET_POSES) {
      const pSketch = await e.store.writeFile(e.series, `sheet/sketch-${pose}.png`, await poseSketch(bodyPlan, bodyPlan.poses[pose]!), dir)
      const r = await generateFromSketch({ ctx, prompt: refPrompt(plan.value.prompt, bible.style, note ?? undefined, pose), sketch: pSketch, out: path.join(dir, 'sheet', pose), seed, log, signal: e.ctx.signal })
      seconds[pose] = r.seconds
      poseFiles.push(r.file)
    }
    await composeSheet([refPng, ...poseFiles], path.join(dir, 'sheet.png'))
    const meta: SheetMeta = { prompt, seed, denoise: SHEET_DENOISE, model, attempt, note, picked: chosen.k + 1, notes: picked.value.notes, seconds }
    await e.store.writeFile(e.series, 'sheet/meta.json', `${JSON.stringify(meta, null, 2)}\n`, dir)
    await fs.rm(path.join(dir, 'sheet-redo.json'), { force: true })
    // a sheet made again must be approved again
    const fresh = await e.store.readBible(e.series)
    if (fresh.cast.some((x) => x.id === c.id && x.sheet)) await e.store.writeBible(e.series, { ...fresh, cast: fresh.cast.map((x) => (x.id === c.id ? { ...x, sheet: undefined } : x)) })
    made.push(`${c.id} (seed ${seed}; ${Object.entries(seconds).map(([k, s]) => `${k} ${s} s`).join(', ')})`)
  }
  return made.length ? `sheets of ${made.join('; ')}; waiting for the user's look` : 'sheets kept'
}

// ---------------------------------------------------------------- step 3: rigs

async function spentUsd(e: Env): Promise<number> {
  return (await budgetState(e.store, e.series, e.episode)).spentUsd
}

async function buildClaude(e: Env, bible: Bible, castId: string, variant: RigVariant, style: string): Promise<string> {
  const c = bible.cast.find((x) => x.id === castId)!
  const r = await ask<Claude>(
    e,
    {
      id: `rig-claude-${castId}-${variant}`,
      role: 'character-designer',
      kind: 'rig-claude',
      prompt: `Draw the rig of ${c.name.en} as flat SVG parts from the reference picture (path claude-svg, variant ${variant}). Redraw the figure; do not trace the picture. Answer with {"rig": <rig.json>, "parts": {"<file path in the rig>": "<svg text>"}}, or write the files with cts_rig_set {series, cast: "${castId}", variant: "${variant}"} and answer {"viaTool": true}.`,
      inputs: { paths: [`cast/${castId}/ref.png`], json: { character: castView(c), style: bible.style, outlinePx: bible.style.outlinePx, palette: bible.style.palette, folder: `cast/${castId}/variants/${variant}/` } },
      output: { schema: 'rig-claude', path: `tasks/rig-claude-${castId}-${variant}.json` }
    },
    {
      system: style,
      rounds: 2,
      check: async (v) => {
        const a = v as Claude
        try {
          const res = a.viaTool ? { check: await checkRig(e.store, e.series, castId, variant) } : await writeRigSet(e.store, e.series, castId, variant, a.rig, a.parts ?? {})
          return res.check.ok ? [] : res.check.issues.filter((i) => i.severity === 'error').map((i) => `${i.where ?? i.file ?? ''}: ${i.message}`)
        } catch (err) {
          return [(err as Error).message]
        }
      }
    }
  )
  return r.value.notes || 'drawn'
}

async function rasterTask(e: Env, bible: Bible, castId: string, variant: RigVariant, style: string, extraImages: string[], kind: string, note: string): Promise<Raster> {
  const c = bible.cast.find((x) => x.id === castId)!
  const r = await ask<Raster>(
    e,
    {
      id: `${kind}-${castId}`,
      role: 'character-designer',
      kind,
      prompt: note,
      inputs: { paths: [`cast/${castId}/ref.png`, ...extraImages], json: { character: castView(c), imageSize: REF_SIZE, variant } },
      output: { schema: 'rig-raster', path: `tasks/${kind}-${castId}.json` }
    },
    { system: style }
  )
  return r.value
}

async function buildVariant(e: Env, bible: Bible, castId: string, rp: RigPath, style: string): Promise<{ status: 'built' | 'not-run'; note: string }> {
  const variant = VARIANT_OF[rp]
  const log = (m: string) => e.log(m)
  if (rp === 'claude-svg') return { status: 'built', note: await buildClaude(e, bible, castId, variant, style) }
  if (rp === 'raster') {
    const answer = await rasterTask(e, bible, castId, variant, style, [], 'rig-raster', `Cut ${castId}'s master picture into rotatable parts for path raster (variant c): a polygon per part in the pixels of ref.png (the picture is ${REF_SIZE.width}x${REF_SIZE.height}), the pivot of each part, the z order, and the boxes of the mouth, the eyes and the brows. The code keys the grey away, crops the parts with an overlap at the joints and makes the face states as image patches of those boxes.`)
    const sheet = await readSheetMeta(e.store.paths(e.series).castDir(castId))
    const member = bible.cast.find((x) => x.id === castId)!
    const res = await buildRasterRig({
      store: e.store,
      series: e.series,
      cast: castId,
      answer,
      prompt: sheet?.prompt ?? `${member.name.en}. ${member.look ?? ''}`,
      seed: sheet?.seed ?? seedOf(castId),
      inpaint: comfyInpaint(imageCtx(e, `character ${castId} face`), REF_SIZE, { log, signal: e.ctx.signal }),
      log,
      signal: e.ctx.signal
    })
    for (const r of res.face) if (!r.ok) log(`face ${castId}: ${r.kind}/${r.state} stayed under its minimum difference (${r.diff} < ${r.minDiff}): read the pose sheet`)
    if (!res.check.ok) throw new Error(`raster rig of ${castId} fails cts_rig_check: ${res.check.issues.filter((i) => i.severity === 'error').slice(0, 5).map((i) => i.message).join('; ')}`)
    return { status: 'built', note: answer.notes || 'cut from the keyed master, face patches by inpaint' }
  }
  throw new Error(`unknown rig path "${String(rp)}"`)
}

/** Builds one path of one character as a variant, times it and records it in `variants.json`. */
export async function buildRig(e: Env, bible: Bible, castId: string, rp: RigPath): Promise<{ variant: RigVariant; status: string; note: string; wallSeconds: number }> {
  const style = await loadStyleGuide(e.store.dataDir)
  const variant = VARIANT_OF[rp]
  const startedAt = localIso(new Date())
  const t0 = Date.now()
  const usd0 = await spentUsd(e)
  let status: 'built' | 'failed' | 'not-run'
  let note: string
  let failure: Error | null = null
  try {
    const r = await buildVariant(e, bible, castId, rp, style)
    status = r.status
    note = r.note
  } catch (err) {
    if ((err as Error).name === 'AbortError' || e.ctx.signal.aborted) throw err
    status = 'failed'
    failure = err as Error
    note = failure.message.slice(0, 400)
  }
  const wallSeconds = (Date.now() - t0) / 1000
  const over = wallSeconds > 45 * 60 ? ' (over the 45 min time box)' : ''
  await recordVariant(e.store, e.series, castId, variant, { path: rp, status, startedAt, endedAt: localIso(new Date()), wallSeconds: Math.round(wallSeconds), spendUsd: Math.round(((await spentUsd(e)) - usd0) * 1e6) / 1e6, spendCredits: 0, note: `${note}${over}` })
  if (status === 'built') await poseSheet({ dataDir: e.svc.dataDir, series: e.series, cast: castId, variant }).catch((err) => e.log(`pose sheet of ${castId} ${variant}: ${(err as Error).message.split('\n')[0]}`))
  if (failure && rp === 'claude-svg') throw failure
  return { variant, status, note, wallSeconds: Math.round(wallSeconds) }
}

export async function rigStep(e: Env): Promise<string> {
  const bible = await requireChosen(e)
  const paths = (e.options.rigPaths ?? {}) as Record<string, string[]>
  const choice = (e.options.rigChoice ?? {}) as Record<string, string>
  const notes: string[] = []
  for (const [i, c] of bible.cast.entries()) {
    e.progress(i / bible.cast.length, `rig of ${c.id}`)
    const wanted = [...new Set(paths[c.id] ?? ['raster'])].filter((p): p is RigPath => (RIG_PATHS as readonly string[]).includes(p))
    for (const rp of wanted) {
      const rec = (await readVariants(e.store, e.series, c.id)).variants[VARIANT_OF[rp]]
      if (rec && (rec.status === 'built' || rec.status === 'not-run') && !e.redo) continue
      const r = await buildRig(e, bible, c.id, rp)
      notes.push(`${c.id}/${r.variant} ${rp}: ${r.status}, ${r.wallSeconds} s`)
    }
    const rec = await readVariants(e.store, e.series, c.id)
    const built = (['a', 'c'] as const).filter((v) => rec.variants[v]?.status === 'built')
    if (built.length > 1) await compareVariants({ dataDir: e.svc.dataDir, store: e.store, series: e.series, cast: c.id }).catch((err) => e.log(`rig comparison of ${c.id}: ${(err as Error).message.split('\n')[0]}`))
    const want = choice[c.id] as RigVariant | undefined
    const pickV = want && built.includes(want) ? want : built.includes('a') ? 'a' : built[0]
    if (!pickV) throw new Error(`no rig of ${c.id} was built`)
    const check = await chooseVariant(e.store, e.series, c.id, pickV)
    if (!check.ok) throw new Error(`the chosen rig (${pickV}) of ${c.id} fails cts_rig_check: ${check.issues.filter((x) => x.severity === 'error').slice(0, 5).map((x) => x.message).join('; ')}`)
    await poseSheet({ dataDir: e.svc.dataDir, series: e.series, cast: c.id }).catch((err) => e.log(`pose sheet of ${c.id}: ${(err as Error).message.split('\n')[0]}`))
    notes.push(`${c.id}: chose ${pickV}`)
  }
  return notes.join('; ')
}

// ---------------------------------------------------------------- step 4: sets

const REQUIRED_MARKS = ['offL', 'left', 'center', 'right', 'offR']
const REQUIRED_SHOTS = ['wide', 'two', 'cuLeft', 'cuRight']

export async function setStep(e: Env): Promise<string> {
  const bible = await requireChosen(e)
  const made: string[] = []
  for (const [i, s] of bible.sets.entries()) {
    const file = e.store.paths(e.series).setFile(s.id)
    if ((await exists(file)) && !e.redo) continue
    e.progress(i / bible.sets.length, `set ${s.id}`)
    const plan = await ask<z.infer<typeof setPlanAnswer>>(e, {
      id: `set-plan-${s.id}`,
      role: 'background-artist',
      kind: 'set-plan',
      prompt: `Write the image prompts for the set "${s.name.en}": the background (wide, empty middle, a clear floor strip) and, if the set needs one, a single foreground prop.`,
      inputs: { paths: [], json: { set: s, style: bible.style, tone: bible.tone, cast: bible.cast.map(castView) } },
      output: { schema: 'set-plan', path: `tasks/set-plan-${s.id}.json` }
    })
    const setDir = e.store.paths(e.series).setDir(s.id)
    const art = await makeSetArt({ ctx: imageCtx(e, `set ${s.id}`), setDir, backgroundPrompt: plan.value.backgroundPrompt, propPrompt: plan.value.propPrompt, seed: seedOf(s.id), log: (m) => e.log(m), signal: e.ctx.signal })
    const heights = Object.fromEntries(await Promise.all(bible.cast.map(async (c) => [c.id, (await e.store.readRig(e.series, c.id).catch(() => null))?.height ?? null])))
    const place = await ask<z.infer<typeof setPlaceAnswer>>(
      e,
      {
        id: `set-place-${s.id}`,
        role: 'background-artist',
        kind: 'set-place',
        prompt: `Read the picture(s) and place the set: the ground line, the marks the actors stand on (${REQUIRED_MARKS.join(', ')}), the camera shots (${REQUIRED_SHOTS.join(', ')}), and where the prop goes. Coordinates are pixels of the ${SET_SIZE.join('x')} background.`,
        inputs: { paths: [relTo(e, art.background), ...(art.prop ? [relTo(e, art.prop)] : [])], json: { size: SET_SIZE, requiredMarks: REQUIRED_MARKS, requiredShots: REQUIRED_SHOTS, rigHeights: heights, aspect: '16:9' } },
        output: { schema: 'set-place', path: `tasks/set-place-${s.id}.json` }
      },
      {
        check: (v) => {
          const a = v as z.infer<typeof setPlaceAnswer>
          const out: string[] = []
          for (const m of REQUIRED_MARKS) if (!a.marks[m]) out.push(`marks.${m} is missing`)
          for (const m of REQUIRED_SHOTS) if (!a.shots[m]) out.push(`shots.${m} is missing`)
          return out
        }
      }
    )
    const v = place.value
    const layers: unknown[] = [{ id: 'bg', src: 'layers/bg.png', z: 0, parallax: 1 }]
    if (art.prop) layers.push({ id: 'prop', src: 'layers/prop.png', z: 100, at: v.propAt ?? [Math.round(SET_SIZE[0] * 0.78), v.groundY + 60], anchor: 'bottom', parallax: 1.1 })
    await e.store.writeSet(e.series, s.id, { schema: 'cts.set/1', id: s.id, size: SET_SIZE, groundY: v.groundY, actorScale: v.actorScale, layers, marks: v.marks, shots: v.shots })
    made.push(`${s.id} (${art.secondsBackground} s background${art.prop ? `, ${art.secondsProp} s prop` : ''})`)
  }
  return made.length ? `sets ${made.join(', ')}` : 'sets kept'
}

// ---------------------------------------------------------------- step 8: voice

export async function voiceStep(e: Env): Promise<string> {
  await requireChosen(e)
  const { deps, config } = await voiceDeps(e.svc, { autoStart: true, log: (m) => e.log(m) })
  e.progress(0, 'speaking the lines')
  const report = await runVoice({ store: e.store, series: e.series, episode: e.episode, config, deps, dataDir: e.svc.dataDir, signal: e.ctx.signal, log: (m) => e.log(m) })
  for (const w of report.warnings) e.log(`warning: ${w}`)
  const bible = await e.store.readBible(e.series)
  for (const lang of bible.languages) {
    const m = await readManifest(e.store, e.series, e.episode, lang)
    for (const [line, v] of Object.entries(m?.lines ?? {})) {
      e.svc.emit({ type: 'voice.clip', series: e.series, episode: e.episode, lang, line, status: v.status, provider: v.provider, seconds: v.seconds, file: v.file })
    }
  }
  return `voices: ${report.made.length} made, ${report.kept.length} kept, ${report.placeholders.length} placeholder(s); seconds ${JSON.stringify(report.seconds)}`
}

// ---------------------------------------------------------------- step 9b: clips

/** The sheet and the review of one clip. Returns the verdict. */
export async function reviewClip(e: Env, clip: string, file: string, who: string[]): Promise<'pass' | 'revise'> {
  const p = e.store.paths(e.series)
  const sheet = await clipSheet(file, path.join(videoDir(e.store, e.series, e.episode), 'review'), clip)
  const poses = (await Promise.all(who.map(async (id) => await rigSheetName(p.castDir(id), p.castDir(id)).then((n) => (n ? `cast/${id}/${n}` : null))))).filter((x): x is string => !!x)
  const existing = await fs.readdir(path.join(p.episodeDir(e.episode), 'reviews')).catch(() => [] as string[])
  const n = existing.filter((f) => f.startsWith(`clip-${clip}-`)).length + 1
  const r = await ask<z.infer<typeof reviewAnswer>>(
    e,
    {
      id: `clip-review-${clip}-${n}`,
      role: 'frame-critic',
      kind: 'clip-review',
      prompt: `Review the Flow clip "${clip}": the first picture is six frames of the clip, the next ones are the pose sheets of the characters in it. It must read as a flat 2D paper-cutout cartoon with the characters on model (shapes, colours, faces). Fail it for a 3D look, shading, gradients, off-model faces or colours, extra limbs, text, or anything frightening.`,
      inputs: { paths: [relTo(e, sheet), ...poses], json: { clip, characters: who } },
      output: { schema: 'review', path: `episodes/${e.episode}/reviews/clip-${clip}-${n}.json` }
    }
  )
  return r.value.verdict
}

/** Makes one clip and has it reviewed: `revise` gets at most one retry, a second fail sets `fallback: true` (the spend stays recorded). */
export async function makeClip(e: Env, clip: string, maxCredits: number, polish = false): Promise<string> {
  const shots = await readShots(e.store, e.series)
  const who = shots?.clips.find((c) => c.id === clip)?.who ?? []
  const loc = clipLocation(e.episode, clip)
  assertClipId(clip)
  let last: ClipEntry | null = null
  let credits = 0
  for (let attempt = 1; attempt <= 2; attempt++) {
    e.progress((attempt - 1) / 2, `clip ${clip}, attempt ${attempt}`)
    let gen
    try {
      gen = await generateClip({ svc: e.svc, store: e.store, series: e.series, episode: e.episode, clip, maxCredits, ...(polish ? { polish } : {}), log: (m) => e.log(m), signal: e.ctx.signal })
    } catch (err) {
      if (attempt === 2 && last) {
        last = { ...last, fallback: true, review: 'revise' }
        await upsertClip(e.store, e.series, e.episode, loc.level, last)
        return `clip ${clip}: retry refused (${(err as Error).message.slice(0, 120)}): dropped, fallback`
      }
      throw err
    }
    credits += gen.credits
    const verdict = await reviewClip(e, clip, gen.file, who)
    last = { ...gen.entry, review: verdict }
    await upsertClip(e.store, e.series, e.episode, loc.level, last)
    if (verdict === 'pass') return `clip ${clip}: pass, ${credits} credits`
  }
  last = { ...last!, fallback: true, review: 'revise' }
  await upsertClip(e.store, e.series, e.episode, loc.level, last)
  return `clip ${clip}: failed review twice, fallback; ${credits} credits spent`
}

export async function clipsStep(e: Env): Promise<string> {
  await requireChosen(e)
  const need = await missingClips(e.store, e.series, e.episode)
  if (need.length === 0) return 'no clips missing'
  if (e.options.skipClips === true) {
    for (const n of need) {
      const entry: ClipEntry = { id: n.clip, file: n.level === 'series' ? n.file : `clips/${n.clip}.mp4`, seconds: n.seconds, credits: 0, flowMediaId: null, prompt: '', review: null, fallback: true }
      await upsertClip(e.store, e.series, e.episode, n.level, entry)
    }
    return `clips NOT RUN (skipClips): ${need.map((n) => n.clip).join(', ')} fall back to a title card`
  }
  const why = await clipsGate(e.store, e.series, e.episode, e.options)
  if (why) throw new Error(`the clips are not ready to be made: ${why}`)
  const credits = (e.options.clipCredits ?? {}) as Record<string, number>
  const out: string[] = []
  for (const n of need) out.push(await makeClip(e, n.clip, credits[n.clip]!))
  return out.join('; ')
}

// ---------------------------------------------------------------- steps 10-13

export async function timelineStep(e: Env): Promise<string> {
  await requireChosen(e)
  e.progress(0, 'lip-sync and timelines')
  const sum = await buildEpisodeTimelines(e.store, e.series, e.episode)
  const lint = await lintSeries(e.store, e.series, { episode: e.episode, requireAudio: true })
  if (lint.errors.length > 0) throw new Error(`cts_lint found ${lint.errors.length} error(s): ${lint.errors.slice(0, 6).map((i) => `${i.code} ${i.message}`).join(' | ')}`)
  return `timelines ${sum.languages.map((l) => `${l.lang} ${l.duration.toFixed(1)} s`).join(', ')}; lint 0 errors, ${lint.warnings.length} warning(s)`
}

export async function previewRenderStep(e: Env): Promise<string> {
  await requireChosen(e)
  const bible = await e.store.readBible(e.series)
  const out: string[] = []
  for (const [i, lang] of bible.languages.entries()) {
    e.progress(i / bible.languages.length, `preview ${lang}`)
    const r = await renderEpisode({ dataDir: e.svc.dataDir, series: e.series, episode: e.episode, lang, quality: 'preview', signal: e.ctx.signal, onProgress: (done, total) => e.progress((i + done / Math.max(1, total)) / bible.languages.length, `preview ${lang} ${done}/${total}`) })
    const sheet = await contactSheet({ dataDir: e.svc.dataDir, series: e.series, episode: e.episode, lang, count: 12 })
    out.push(`${lang}: ${r.seconds.toFixed(1)} s in ${r.wallSeconds.toFixed(1)} s (${r.encoder}), sheet ${relTo(e, sheet)}`)
  }
  for (const c of bible.cast) await poseSheet({ dataDir: e.svc.dataDir, series: e.series, cast: c.id }).catch((err) => e.log(`pose sheet of ${c.id}: ${(err as Error).message.split('\n')[0]}`))
  return out.join('; ')
}

/** The frame reviews so far for a language, newest round last. */
export async function frameReviews(e: Env, lang: Lang): Promise<{ round: number; file: string; verdict: string; problems: number }[]> {
  const dir = path.join(e.store.paths(e.series).episodeDir(e.episode), 'reviews')
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => new RegExp(`^frames-${lang}-\\d+\\.json$`).test(f)).sort()
  const out = []
  for (const f of names) {
    const r = await e.store.readReview(e.series, e.episode, f.replace(/\.json$/, '')).catch(() => null)
    if (r) out.push({ round: Number(/-(\d+)\.json$/.exec(f)![1]), file: `episodes/${e.episode}/reviews/${f}`, verdict: r.verdict, problems: r.problems.length })
  }
  return out
}

export async function finalRenderStep(e: Env): Promise<string> {
  await requireChosen(e)
  const bible = await e.store.readBible(e.series)
  const languages: Record<string, unknown> = {}
  const open: { lang: string; where: string; what: string; fix: string }[] = []
  const out: string[] = []
  for (const [i, lang] of bible.languages.entries()) {
    e.progress(i / bible.languages.length, `final ${lang}`)
    const r = await renderEpisode({ dataDir: e.svc.dataDir, series: e.series, episode: e.episode, lang, quality: 'final', signal: e.ctx.signal, onProgress: (done, total) => e.progress((i + done / Math.max(1, total)) / bible.languages.length, `final ${lang} ${done}/${total}`) })
    languages[lang] = { file: relTo(e, r.file), seconds: Math.round(r.seconds * 10) / 10, renderSeconds: Math.round(r.wallSeconds * 10) / 10, encoder: r.encoder, frames: r.frames, loudnessInputLufs: r.loudness?.input_i ?? null, log: relTo(e, r.logFile), warnings: r.warnings }
    out.push(`${lang}: ${r.seconds.toFixed(1)} s in ${r.wallSeconds.toFixed(1)} s (${r.encoder})`)
    const reviews = await frameReviews(e, lang)
    const lastReview = reviews[reviews.length - 1]
    if (lastReview && lastReview.verdict === 'revise') {
      const full = await e.store.readReview(e.series, e.episode, path.basename(lastReview.file).replace(/\.json$/, ''))
      for (const p of full.problems) open.push({ lang, ...p })
    }
  }
  const safety = await e.store.readReview(e.series, e.episode, 'safety').catch(() => null)
  const lint = await lintSeries(e.store, e.series, { episode: e.episode, requireAudio: true })
  const clips = { series: (await e.store.readClips(e.series)).clips, episode: (await e.store.readClips(e.series, e.episode)).clips }
  const budget = await budgetState(e.store, e.series, e.episode)
  await e.pipe.setSummary(e.series, e.episode, { languages, openProblems: open, safety: safety?.verdict ?? null, lint: { errors: lint.errors.length, warnings: lint.warnings.length }, clips, spend: { usd: budget.spentUsd, credits: budget.spentCredits, capUsd: budget.capUsd, flowCreditsCap: budget.flowCreditsCap }, finishedAt: localIso(new Date()) })
  return out.join('; ')
}

