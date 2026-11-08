import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { z } from 'zod'
import type { ClipEntry, Lang } from '../../shared/contracts'
import { budgetState, localIso } from '../budget/spend'
import { buildEpisodeTimelines } from '../anim/timeline'
import { renderEpisode } from '../render/render'
import { blenderContactSheet, renderBlenderEpisode } from '../render/blender'
import { contactSheet, poseSheet, rigSheetName } from '../render/sheet'
import { lintSeries } from '../series/lint'
import { voiceDeps } from '../voice/tools'
import { readManifest } from '../voice/manifest'
import { runVoice } from '../voice/run'
import { clipsGate } from './clips'
import { ask, relTo, requireChosen } from './env'
import type { Env } from './env'
import { assertClipId, generateClip, clipSheet, clipLocation, missingClips, readShots, upsertClip, videoDir } from './clips'
import type { reviewAnswer } from './tasks'

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
  const blender = (await e.store.readBible(e.series)).renderer === 'blender'
  const sheet = await clipSheet(file, path.join(videoDir(e.store, e.series, e.episode), 'review'), clip)
  const poses = blender
    ? who.map((id) => `cast/${id}/sheet.png`)
    : (await Promise.all(who.map(async (id) => await rigSheetName(p.castDir(id), p.castDir(id)).then((n) => (n ? `cast/${id}/${n}` : null))))).filter((x): x is string => !!x)
  const existing = await fs.readdir(path.join(p.episodeDir(e.episode), 'reviews')).catch(() => [] as string[])
  const n = existing.filter((f) => f.startsWith(`clip-${clip}-`)).length + 1
  const r = await ask<z.infer<typeof reviewAnswer>>(
    e,
    {
      id: `clip-review-${clip}-${n}`,
      role: 'frame-critic',
      kind: 'clip-review',
      prompt: blender
        ? `Review the Flow clip "${clip}": the first picture is six frames of the clip, the next ones are the Blender sheets of the characters. It must sit next to our Blender render: the same stylised toon 3D look (simple rounded characters, flat cel shading, thin dark outline, bright simple set) with the characters on model (shapes, colours, faces, accessories). Fail it for a photoreal or glossy look, a different art style, off-model faces or colours, extra or missing limbs, text, or anything frightening.`
        : `Review the Flow clip "${clip}": the first picture is six frames of the clip, the next ones are the pose sheets of the characters in it. It must read as a flat 2D paper-cutout cartoon with the characters on model (shapes, colours, faces). Fail it for a 3D look, shading, gradients, off-model faces or colours, extra limbs, text, or anything frightening.`,
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
  if (bible.renderer === 'blender') {
    for (const [i, lang] of bible.languages.entries()) {
      e.progress(i / bible.languages.length, `preview ${lang}`)
      const r = await renderBlenderEpisode({ dataDir: e.svc.dataDir, series: e.series, episode: e.episode, lang, quality: 'preview', signal: e.ctx.signal, onProgress: (done, total) => e.progress((i + done / Math.max(1, total)) / bible.languages.length, `preview ${lang} ${done}/${total}`) })
      const sheet = await blenderContactSheet({ dataDir: e.svc.dataDir, series: e.series, episode: e.episode, lang, count: 12, quality: 'preview' })
      const t = r.blenderTimes
      out.push(`${lang}: ${r.seconds.toFixed(1)} s in ${r.wallSeconds.toFixed(1)} s (${r.encoder}${t ? `, Blender warm mean ${t.warmMean.toFixed(3)} s a frame` : ''}), sheet ${relTo(e, sheet)}`)
    }
    return out.join('; ')
  }
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
    const r = await (bible.renderer === 'blender' ? renderBlenderEpisode : renderEpisode)({ dataDir: e.svc.dataDir, series: e.series, episode: e.episode, lang, quality: 'final', signal: e.ctx.signal, onProgress: (done, total) => e.progress((i + done / Math.max(1, total)) / bible.languages.length, `final ${lang} ${done}/${total}`) })
    languages[lang] = { ...(r.blenderTimes ? { blenderTimes: { frames: r.blenderTimes.frames, first: r.blenderTimes.first, warmMean: r.blenderTimes.warmMean, p95: r.blenderTimes.p95, total: r.blenderTimes.total } } : {}), file: relTo(e, r.file), seconds: Math.round(r.seconds * 10) / 10, renderSeconds: Math.round(r.wallSeconds * 10) / 10, encoder: r.encoder, frames: r.frames, loudnessInputLufs: r.loudness?.input_i ?? null, mixMinUnderDb: r.mixCheck?.minUnderDb ?? null, mixMedianUnderDb: r.mixCheck?.medianUnderDb ?? null, log: relTo(e, r.logFile), warnings: r.warnings }
    out.push(`${lang}: ${r.seconds.toFixed(1)} s in ${r.wallSeconds.toFixed(1)} s (${r.encoder}), loudness ${r.loudness?.input_i ?? 'n/a'} LUFS in, music min ${r.mixCheck?.minUnderDb ?? 'n/a'} dB under the voice`)
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

