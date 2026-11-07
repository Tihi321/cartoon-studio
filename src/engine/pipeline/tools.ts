import { promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { RIG_VARIANTS, bibleSchema, castMemberSchema, langSchema, setSchema, episodeSchema, textSchema } from '../../shared/contracts'
import type { Lang } from '../../shared/contracts'
import { buildEpisodeTimelines } from '../anim/timeline'
import { budgetState } from '../budget/spend'
import { ToolOutput } from '../mcp/tools'
import type { Tool, ToolDef } from '../mcp/tools'
import { assertId, assertSlug } from '../series/paths'
import { checkRig } from '../series/lint'
import { SeriesStore } from '../series/service'
import type { CtsService } from '../service'
import { readManifest } from '../voice/manifest'
import { clipLocation, missingClips, videoDir } from './clips'
import { RIG_PATHS, chooseVariant, compareVariants, readVariants, writeRigSet } from './rig'
import { Pipeline } from './run'

/**
 * The series, rig, set, episode, pipeline and clip tools (CTS-07). The model work of the pipeline is done through the `client` tools of the core
 * (`cts_get_task` / `cts_submit_task`); `cts_run_pipeline` starts and resumes the run. Long calls (`cts_rig_build`, `cts_clip_generate`,
 * `cts_clip_review`) return a job id at once: `cts_wait`, then `cts_status`.
 */

const series = z.string().describe('The series slug')
const episode = z.string().describe('The episode id, e.g. ep00-pilot')
const cast = z.string().describe('The cast id, e.g. mia')
const variant = z.enum(RIG_VARIANTS)

const HUB_COMMAND = 'node <creative-hub>/scripts/video-plan.mjs'

/** The next free job id of `<series>--<task>--<unit>--r<n>`. Explicit requests go before the pipeline's own jobs (priority 1). */
async function enqueueJob(svc: CtsService, o: { series: string; task: string; role: string; unit: string; label: string; body: unknown; vision?: boolean }): Promise<string> {
  for (let run = 1; run <= 999; run++) {
    const id = `${o.series}--${o.task}--${o.unit}--r${run}`
    if (await svc.deps.jobs.enqueue({ id, task: o.task, role: o.role, book: o.series, unit: o.unit, round: run, requested_by: 'you', label: o.label, priority: 1, ...(o.vision ? { vision: true } : {}) }, JSON.stringify(o.body, null, 2))) {
      svc.deps.kick?.()
      return id
    }
  }
  throw new Error('too many jobs for this unit')
}

async function withImage(file: string, data: Record<string, unknown>): Promise<unknown> {
  const buf = await fs.readFile(file)
  return buf.length > 4_000_000 ? { file, ...data } : new ToolOutput({ file, ...data }, [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }])
}

/** `cts_status {series}` also shows the pipelines of the series: state, current step, what waits. */
export async function pipelineSummaries(svc: CtsService, slug: string): Promise<unknown[]> {
  const pipe = new Pipeline(svc)
  const out: unknown[] = []
  for (const ep of await pipe.episodesWithPipeline(slug)) {
    const r = await pipe.status(slug, ep)
    if (r) out.push({ episode: ep, state: r.state, step: r.step, waitingOn: r.waitingOn, hint: r.hint, steps: r.steps.map((s) => `${s.id}:${s.state}`).join(' '), ...(r.summary ? { summary: r.summary } : {}) })
  }
  return out
}

export function pipelineTools(svc: CtsService, def: ToolDef): Tool[] {
  const store = () => new SeriesStore(svc.dataDir)
  const pipe = () => new Pipeline(svc)

  /** The episode of a clip call: the one given, else the series' only episode. */
  async function episodeOf(slug: string, given?: string): Promise<string> {
    if (given) return assertId(given, 'episode id')
    const eps = await store().listEpisodes(slug)
    if (eps.length === 1) return eps[0]!
    throw new Error(`name the episode (the series has ${eps.length}: ${eps.join(', ') || 'none'}); a clip is charged to the budget of one episode`)
  }

  return [
    // ---------------------------------------------------------------- series
    def(
      'cts_series_create',
      'Create a series: series/<slug>/bible.json with a stub bible (no cast, sets or pitches yet). Usually not needed: cts_run_pipeline creates the series from its brief. Returns the bible.',
      z.object({ slug: z.string(), title: z.string().optional(), logline: z.string().optional(), ageMin: z.number().int().min(1).max(12).optional(), ageMax: z.number().int().min(1).max(14).optional(), languages: z.array(langSchema).min(1).optional() }),
      async (a) => {
        assertSlug(a.slug)
        const bible = await store().createSeries(a.slug, { title: a.title ?? a.slug, logline: a.logline ?? '', ageMin: a.ageMin, ageMax: a.ageMax, languages: a.languages })
        svc.emit({ type: 'series.listed', series: await svc.listSeries() })
        return { bible }
      }
    ),
    def(
      'cts_pitch_choose',
      'The user\'s pick of a premise: sets bible.chosenPitch (with the time) to a pitch id and lets every pipeline that waits on it go on. Call it ONLY with the pitch the user chose; the pipeline stops at "waiting-on-user" after the pitches and nothing visual is made before this. Returns the pick and the resumed pipelines.',
      z.object({ series, pitch: z.string().describe('The pitch id: p1, p2 or p3') }),
      async (a) => pipe().choosePitch(a.series, a.pitch)
    ),
    def(
      'cts_series_get',
      'Read a series: the bible (title, logline, tone, rules, style, cast with voices, sets, music, episodes), the pitches and the chosen one (with the time), the rig variants and the pipelines. Use it to show the user the pitches while the pipeline waits.',
      z.object({ series }),
      async (a) => {
        const st = store()
        const bible = await st.readBible(a.series)
        const rigs = await Promise.all(bible.cast.map(async (c) => ({ cast: c.id, variants: (await readVariants(st, a.series, c.id)).variants, chosen: (await readVariants(st, a.series, c.id)).chosen, hasRef: await st.exists(path.join(st.paths(a.series).castDir(c.id), 'ref.png')), hasRig: await st.exists(st.paths(a.series).rigFile(c.id)) })))
        return { bible, rigs, episodes: await st.listEpisodes(a.series), pipelines: await pipelineSummaries(svc, a.series) }
      }
    ),
    def(
      'cts_series_update',
      'Change the series bible: title, logline, tone, rules, audience, languages, style, music, cast (the whole list), sets (the whole list). The pitches and the chosen pitch cannot be changed here (cts_pitch_choose chooses). The result is validated against the bible schema before it is written.',
      z.object({
        series,
        title: bibleSchema.shape.title.optional(),
        logline: bibleSchema.shape.logline.optional(),
        tone: z.array(z.string()).optional(),
        rules: z.array(z.string()).optional(),
        audience: bibleSchema.shape.audience.optional(),
        languages: bibleSchema.shape.languages.optional(),
        style: bibleSchema.shape.style.partial().optional(),
        music: bibleSchema.shape.music.optional(),
        cast: z.array(castMemberSchema).optional(),
        sets: bibleSchema.shape.sets.optional()
      }),
      async (a) => {
        const { series: slug, style, ...rest } = a
        const bible = await store().readBible(slug)
        const next = { ...bible, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), ...(style ? { style: { ...bible.style, ...style } } : {}) }
        return { bible: await store().writeBible(slug, next) }
      }
    ),
    def(
      'cts_cast_get',
      'Read one cast member (or all): the bible entry, the rig at cast/<id>/rig.json (parts, gestures, emotions), the variants (path, wall time, spend), the cts_rig_check result of the rig and of each variant, and the reference and pose sheet paths.',
      z.object({ series, cast: cast.optional() }),
      async (a) => {
        const st = store()
        const bible = await st.readBible(a.series)
        const p = st.paths(a.series)
        const ids = a.cast ? [a.cast] : bible.cast.map((c) => c.id)
        const out = []
        for (const id of ids) {
          const member = bible.cast.find((c) => c.id === id)
          if (!member) throw new Error(`no cast member "${id}" in "${a.series}" (${bible.cast.map((c) => c.id).join(', ')})`)
          const rig = await st.readRig(a.series, id).catch(() => null)
          const variants = await readVariants(st, a.series, id)
          const checks: Record<string, unknown> = {}
          if (rig) checks.chosen = await checkRig(st, a.series, id)
          for (const v of RIG_VARIANTS) if (variants.variants[v]?.status === 'built') checks[v] = await checkRig(st, a.series, id, v)
          out.push({ member, rig: rig ? { height: rig.height, kind: rig.kind, parts: rig.parts.map((x) => x.id), gestures: Object.keys(rig.gestures), emotions: Object.keys(rig.emotions) } : null, variants, checks, files: { ref: (await st.exists(path.join(p.castDir(id), 'ref.png'))) ? `cast/${id}/ref.png` : null, sheet: (await st.exists(path.join(p.castDir(id), 'sheet.png'))) ? `cast/${id}/sheet.png` : null } })
        }
        return a.cast ? out[0] : { cast: out }
      }
    ),

    // ---------------------------------------------------------------- rigs
    def(
      'cts_rig_set',
      'Write a rig: rig.json plus its part SVGs. rig is the rig object (cts.rig/1), parts maps a file of the rig (its path "parts/body.svg", or just "body.svg" or "body") to the SVG text; a file the rig names that is not in parts must already be on disk. variant a|b|c writes under cast/<id>/variants/<v>/ (without it: cast/<id>/). Validates the schema, writes the files, then runs cts_rig_check and returns its result: fix every error and call again. Nothing is written when the rig does not parse or a file is missing.',
      z.object({ series, cast, variant: variant.optional(), rig: z.unknown(), parts: z.record(z.string(), z.string()).default({}) }),
      async (a) => writeRigSet(store(), a.series, a.cast, a.variant, a.rig, a.parts)
    ),
    def(
      'cts_rig_build',
      'Build one rig path of one character as a variant under cast/<id>/variants/<v>/ (claude-svg = a, recraft-svg = b, raster = c): the character-designer role task (answer it with cts_get_task / cts_submit_task), the pose sheet, and the wall time and spend recorded in variants.json. recraft-svg is paid and is refused at a $0 cap (recorded as not-run). Returns a job id at once.',
      z.object({ series, episode, cast, path: z.enum(RIG_PATHS).default('claude-svg') }),
      async (a) => {
        if (!(await svc.seriesExists(a.series))) throw new Error(`no series "${a.series}"`)
        const job = await enqueueJob(svc, { series: a.series, task: 'rig_build', role: 'character-designer', unit: `${a.cast}-${a.path}`, label: `rig ${a.cast} (${a.path})`, body: { episode: a.episode, cast: a.cast, path: a.path }, vision: true })
        return { job, hint: 'cts_wait {series}; answer the client tasks; then cts_cast_get {series, cast}' }
      }
    ),
    def(
      'cts_rig_compare',
      'Render one comparison sheet of the built variants of a character side by side (the pose sheets: neutral, every emotion, the gesture peaks, the A/E/O/MBP mouths and the eye states), each under a label with its path, wall time and spend. Written to cast/<id>/variants/compare.png and returned as a picture. Variants that are not built are listed in `missing`.',
      z.object({ series, cast }),
      async (a) => {
        const r = await compareVariants({ dataDir: svc.dataDir, store: store(), series: a.series, cast: a.cast })
        return withImage(r.file, { variants: r.variants, missing: r.missing, record: (await readVariants(store(), a.series, a.cast)).variants })
      }
    ),
    def(
      'cts_rig_choose',
      'Choose the variant (a, b or c) that becomes the character\'s rig: copies variants/<v>/rig.json, parts/ and sheet.png up to cast/<id>/ and runs cts_rig_check on it. Returns the check.',
      z.object({ series, cast, variant }),
      async (a) => ({ chosen: a.variant, check: await chooseVariant(store(), a.series, a.cast, a.variant) })
    ),

    // ---------------------------------------------------------------- sets
    def(
      'cts_set_get',
      'Read a set (or the list of sets): set.json (size, ground, layers, marks, shots) and the layer files.',
      z.object({ series, set: z.string().optional() }),
      async (a) => {
        const st = store()
        if (!a.set) return { sets: await st.listSets(a.series) }
        const s = await st.readSet(a.series, a.set)
        return { set: s, layerFiles: s.layers.map((l) => `sets/${a.set}/${l.src}`) }
      }
    ),
    def(
      'cts_set_update',
      'Change a set: groundY, actorScale, layers, marks and/or shots (marks and shots are merged by name; send null for a name to remove it). Validated against the set schema before it is written.',
      z.object({ series, set: z.string(), groundY: z.number().optional(), actorScale: z.number().positive().optional(), layers: setSchema.shape.layers.optional(), marks: z.record(z.string(), z.tuple([z.number(), z.number()]).nullable()).optional(), shots: z.record(z.string(), z.strictObject({ center: z.tuple([z.number(), z.number()]), zoom: z.number().positive() }).nullable()).optional() }),
      async (a) => {
        const cur = await store().readSet(a.series, a.set)
        const merge = <T>(base: Record<string, T>, patch: Record<string, T | null> | undefined): Record<string, T> => {
          const out = { ...base }
          for (const [k, v] of Object.entries(patch ?? {})) {
            if (v === null) delete out[k]
            else out[k] = v
          }
          return out
        }
        const next = { ...cur, ...(a.groundY !== undefined ? { groundY: a.groundY } : {}), ...(a.actorScale !== undefined ? { actorScale: a.actorScale } : {}), ...(a.layers ? { layers: a.layers } : {}), marks: merge(cur.marks, a.marks), shots: merge(cur.shots, a.shots) }
        return { set: await store().writeSet(a.series, a.set, next) }
      }
    ),

    // ---------------------------------------------------------------- episodes
    def(
      'cts_episode_create',
      'Create an episode by hand: the folder with a one-scene stub script (a pause beat) for the given cast and set, registered in the bible. The pipeline writes its own script (cts_run_pipeline); use this for a hand-made episode, then cts_script_set.',
      z.object({ series, episode, title: z.union([z.string(), z.strictObject({ hr: z.string().optional(), en: z.string().optional() })]).optional(), cast: z.array(z.string()).min(1), set: z.string(), shot: z.string().optional(), mark: z.string().optional() }),
      async (a) => ({ script: await store().createEpisode(a.series, a.episode, { title: a.title, cast: a.cast, set: a.set, shot: a.shot, mark: a.mark }) })
    ),
    def(
      'cts_episode_get',
      'Read an episode: the script, both texts, the voice status per line and language, the timelines (durations), the reviews, the clips, the budget and spend, and the pipeline state. Without an episode: the list of episodes.',
      z.object({ series, episode: episode.optional() }),
      async (a) => {
        const st = store()
        const ep = a.episode
        if (!ep) return { episodes: await st.listEpisodes(a.series) }
        const p = st.paths(a.series)
        const bible = await st.readBible(a.series)
        const script = await st.readScript(a.series, ep).catch(() => null)
        const texts: Record<string, unknown> = {}
        const voice: Record<string, unknown> = {}
        const timelines: Record<string, unknown> = {}
        for (const l of bible.languages) {
          texts[l] = await st.readText(a.series, ep, l).catch(() => null)
          const m = await readManifest(st, a.series, ep, l)
          voice[l] = m ? { allocation: m.allocation, lines: Object.fromEntries(Object.entries(m.lines).map(([id, v]) => [id, { status: v.status, provider: v.provider, seconds: v.seconds }])) } : null
          const t = await st.readTimeline(a.series, ep, l).catch(() => null)
          timelines[l] = t ? { duration: t.duration, lines: t.lines.length, clips: t.clips.length, scriptHash: t.scriptHash } : null
        }
        const reviewsDir = path.join(p.episodeDir(ep), 'reviews')
        const reviews = await Promise.all((await fs.readdir(reviewsDir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).map(async (f) => {
          const r = await st.readReview(a.series, ep, f.replace(/\.json$/, '')).catch(() => null)
          return { name: f, verdict: r?.verdict ?? 'unreadable', problems: r?.problems.length ?? 0 }
        }))
        return { script, texts, voice, timelines, reviews, clips: { series: (await st.readClips(a.series)).clips, episode: (await st.readClips(a.series, ep)).clips }, budget: await budgetState(st, a.series, ep), pipeline: await pipe().status(a.series, ep) }
      }
    ),
    def(
      'cts_script_set',
      'Write the episode script (cts.episode/1, language-independent: scenes with beats). Validated against the schema before it is written; lint (cts_lint) checks the references afterwards. A changed script makes the timelines stale: cts_timeline_build.',
      z.object({ series, episode, script: z.unknown() }),
      async (a) => {
        const s = episodeSchema.safeParse(a.script)
        if (!s.success) throw new Error(`the script does not match its schema: ${s.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`)
        const saved = await store().writeScript(a.series, a.episode, { ...s.data, series: a.series, id: a.episode })
        return { script: saved, hash: await store().scriptHash(a.series, a.episode) }
      }
    ),
    def(
      'cts_text_set',
      'Write the text of one language of an episode. Either text (the whole cts.text/1 object) or strings and/or lines merged into the existing catalog: lines is {"l01": {"text": "...", "delivery": "cheerful"}}. Validated before it is written. A changed line is spoken again by the voice step (its hash changes).',
      z.object({ series, episode, lang: langSchema, text: z.unknown().optional(), strings: z.record(z.string(), z.string()).optional(), lines: z.record(z.string(), z.strictObject({ text: z.string(), delivery: z.string().optional() })).optional() }),
      async (a) => {
        const st = store()
        let next: unknown
        if (a.text !== undefined) {
          const t = textSchema.safeParse(a.text)
          if (!t.success) throw new Error(`the text does not match its schema: ${t.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`)
          next = { ...t.data, lang: a.lang }
        } else {
          const cur = await st.readText(a.series, a.episode, a.lang).catch(() => ({ schema: 'cts.text/1' as const, lang: a.lang as Lang, strings: {}, lines: {} }))
          next = { ...cur, strings: { ...cur.strings, ...(a.strings ?? {}) }, lines: { ...cur.lines, ...(a.lines ?? {}) } }
        }
        return { text: await st.writeText(a.series, a.episode, a.lang, next) }
      }
    ),
    def(
      'cts_timeline_build',
      'Lip-sync every line of every language from its voice clip, then build timeline.<lang>.json for each language from the one script (same beat order, durations from the voices). Needs the voice step first (silent placeholders otherwise). Returns the durations, line and clip counts and warnings. cts_lint {requireAudio: true} must then have 0 errors.',
      z.object({ series, episode }),
      async (a) => buildEpisodeTimelines(store(), a.series, a.episode)
    ),

    // ---------------------------------------------------------------- the pipeline
    def(
      'cts_run_pipeline',
      'Start or resume the episode pipeline: pitch (3 premises) -> STOP until the user chooses (cts_pitch_choose) -> bible -> character references -> rigs -> sets -> script -> child-safety review -> voice casting -> voices -> music -> Flow clips -> lip-sync/timelines/lint -> preview renders -> frame review -> final renders (hr and en MP4s). Call it again with the same series and episode to resume (it never skips the pause). The first call needs a brief {idea, title?, ageMin?, ageMax?, notes?, seconds?, lineRange?: [12,16], intro?: false, heroClip?: false}. retry: true puts failed steps back; from: "<step>" redoes that step and all after it. options: rigPaths {castId: ["claude-svg","raster"]} (extra rig variants), rigChoice {castId: "a"|"b"|"c"}, skipClips: true (drop the Flow clips), clipCredits {clipId: max_credits}. Model work is done through cts_get_task / cts_submit_task; the answer says what to do next (hint) and shows every step.',
      z.object({
        series,
        episode,
        brief: z.record(z.string(), z.unknown()).optional(),
        options: z.record(z.string(), z.unknown()).optional(),
        retry: z.boolean().optional(),
        from: z.string().optional()
      }),
      async (a) => pipe().run({ series: a.series, episode: a.episode, brief: a.brief, options: a.options, retry: a.retry, from: a.from })
    ),

    // ---------------------------------------------------------------- Flow clips
    def(
      'cts_clip_plan',
      'The Flow clips of an episode: which clip beats have no file (the intro lives at series level, one hero clip per episode at most), their shots (written by the clip_shots step), the Flow credit cap and spend, and the exact video-plan.mjs commands for the hub session: plan (estimate), next (the max_credits of each call), record. Cartoon Studio copies no price table: the hub\'s scripts/video-plan.mjs owns it. Then cts_clip_generate {series, episode, clip, maxCredits}.',
      z.object({ series, episode }),
      async (a) => {
        const st = store()
        const need = await missingClips(st, a.series, a.episode)
        const dir = videoDir(st, a.series, a.episode)
        const budget = await budgetState(st, a.series, a.episode)
        const map = await fs.readFile(path.join(dir, 'clips-map.json'), 'utf8').then((t) => JSON.parse(t) as Record<string, string>, () => ({} as Record<string, string>))
        const shots = await fs.readFile(st.resolve(a.series, 'tasks/clip-shots.json'), 'utf8').then((t) => (JSON.parse(t) as { clips: unknown[] }).clips, () => [])
        const hasPlan = await st.exists(path.join(dir, 'screenplay.json'))
        return {
          needed: need.map((n) => ({ ...n, shot: map[n.clip] ?? null, location: clipLocation(a.episode, n.clip) })),
          shots,
          videoDir: dir,
          screenplay: hasPlan ? path.join(dir, 'screenplay.json') : null,
          budget: { flowCreditsCap: budget.flowCreditsCap, spentCredits: budget.spentCredits, approved: budget.approved },
          commands: hasPlan
            ? [
                `${HUB_COMMAND} plan "${dir}" --budget ${budget.flowCreditsCap || '<cap>'} --model omni-720p   (estimate; writes plan.json)`,
                `${HUB_COMMAND} next "${dir}" --cap ${budget.flowCreditsCap || '<cap>'}   (the next shot and its max_credits)`,
                `${HUB_COMMAND} record "${dir}" <shot id> @result.json   (after cts_clip_generate: {clips: [{credits, file}]})`
              ]
            : ['run the pipeline to the clip_shots step first (cts_run_pipeline), it writes screenplay.json'],
          next: need.length ? 'ask the user for a Flow credit cap (cts_budget_set {flowCreditsCap}), run plan/next, then cts_clip_generate per clip, or cts_run_pipeline {options: {clipCredits: {...}}}' : 'no clips missing'
        }
      }
    ),
    def(
      'cts_clip_generate',
      'Make one Flow clip: a free keyframe from the characters\' reference pictures and pose sheets (flow_generate image, max_credits 0), then the 8 s video scene (Omni 1.1 Flash 720p, first_frame = the keyframe) with max_credits = maxCredits, charged to the episode\'s Flow credit cap; the file goes to series/<slug>/clips/intro.mp4 (the intro) or episodes/<ep>/clips/<id>.mp4, then the frame-critic reviews six frames (revise = one retry, a second fail marks the clip fallback). REFUSES without a recorded flowCreditsCap (cts_budget_set, after the user\'s yes) and past it (FLOW_CREDITS_EXCEEDED, nothing spent); at most one hero clip per episode. Returns a job id at once.',
      z.object({ series, episode: episode.optional().describe('The episode whose budget pays (default: the only episode)'), clip: z.string().describe('The clip id: intro, or the hero clip id'), maxCredits: z.number().positive().describe('The max_credits for this call, from video-plan.mjs next') }),
      async (a) => {
        const ep = await episodeOf(a.series, a.episode)
        const b = await budgetState(store(), a.series, ep)
        if (b.flowCreditsCap <= 0) throw new Error(`cts_clip_generate refuses without a recorded flowCreditsCap for episode "${ep}": ask the user for a cap, then cts_budget_set {series, episode, capUsd: 0, flowCreditsCap, approvedBy, note}`)
        const job = await enqueueJob(svc, { series: a.series, task: 'clip_generate', role: 'frame-critic', unit: `${ep}-${a.clip}`, label: `Flow clip ${a.clip}`, body: { episode: ep, clip: a.clip, maxCredits: a.maxCredits }, vision: true })
        return { job, hint: 'cts_wait {series}; answer the review task (frame-critic) with cts_get_task / cts_submit_task; then cts_clip_plan or cts_episode_get to see the clip' }
      }
    ),
    def(
      'cts_clip_review',
      'Have an existing clip reviewed again by the frame-critic (six frames next to the pose sheets); the verdict goes into clips.json. Returns a job id at once.',
      z.object({ series, episode: episode.optional(), clip: z.string() }),
      async (a) => {
        const ep = await episodeOf(a.series, a.episode)
        const job = await enqueueJob(svc, { series: a.series, task: 'clip_review', role: 'frame-critic', unit: `${ep}-${a.clip}`, label: `review clip ${a.clip}`, body: { episode: ep, clip: a.clip }, vision: true })
        return { job }
      }
    )
  ]
}
