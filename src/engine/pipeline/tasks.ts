import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import type { ZodType } from 'zod'
import {
  SCHEMAS_BY_TAG,
  bibleSchema,
  character3dSchema,
  episodeSchema,
  set3dSchema,
  facingSchema,
  idSchema,
  localizedSchema,
  nameSchema,
  pitchSchema,
  reviewSchema,
  rigSchema,
  textSchema,
  voiceSpecSchema
} from '../../shared/contracts'
import { parseMd } from '../../shared/md'
import type { ChatMessage } from '../models/types'
import type { JobContext } from '../queue/scheduler'
import { bodyPlanSchema } from '../images/sketch'
import { findSeedDir } from '../store/dataFolder'
import type { SeriesStore } from '../series/service'
import { chatJson } from './llm'

/**
 * The role task contract (CTS-07). Every model job of the pipeline is a role task:
 *
 *   { id, role, kind, prompt, inputs: { paths[], json }, output: { schema, path } }
 *
 * `role` is one of the eight roles, `kind` names the prompt template (`prompts/<role>/<kind>.md`), `prompt` is the task text, `inputs` are the files
 * (paths relative to the series folder: text files are shown, pictures are attached) and the JSON the role needs, `output.schema` names the schema
 * the answer must match (a key of `TASK_SCHEMAS`, or a file tag such as `cts.review/1`) and `output.path` is where the answer is written, relative to the
 * series folder. The request goes to the role's model (`client/claude-code` parks it: `cts_get_task` / `cts_submit_task`). The answer is checked against the
 * zod schema BEFORE anything is written; a failing answer goes back to the model as a retry with the zod errors (and the task's own checks), at most
 * `rounds` times.
 */

export interface RoleTask {
  id: string
  role: string
  kind: string
  prompt: string
  inputs: { paths: string[]; json?: unknown }
  output: { schema: string; path: string }
}

// ---- the answer schemas ----

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour is #rrggbb')
const point = z.tuple([z.number(), z.number()])
const loc = localizedSchema

export const pitchesAnswer = z.strictObject({
  pitches: z
    .array(pitchSchema)
    .length(3, 'exactly three pitches')
    .superRefine((list, ctx) => {
      list.forEach((p, i) => {
        if (p.leads.length !== 2) ctx.addIssue({ code: 'custom', path: [i, 'leads'], message: 'each pitch has exactly two leads' })
        if (p.sets.length < 1 || p.sets.length > 2) ctx.addIssue({ code: 'custom', path: [i, 'sets'], message: 'each pitch has one or two sets' })
      })
      if (new Set(list.map((p) => p.id)).size !== list.length) ctx.addIssue({ code: 'custom', message: 'pitch ids must differ (p1, p2, p3)' })
    })
})

export const bibleAnswer = z.strictObject({
  title: loc,
  logline: loc,
  tone: z.array(z.string()).min(1),
  rules: z.array(z.string()).min(1),
  style: z.strictObject({ look: z.string().min(5), palette: z.array(hex).min(3).max(8), outlinePx: z.number().positive(), refPrompt: z.string().min(10) }),
  cast: z
    .array(
      z.strictObject({
        id: idSchema,
        name: loc,
        role: z.string(),
        personality: z.string(),
        look: z.string().min(10),
        catchphrases: z.strictObject({ hr: z.array(z.string()), en: z.array(z.string()) }).optional()
      })
    )
    .min(2)
    .max(5),
  sets: z.array(z.strictObject({ id: idSchema, name: loc, description: z.string().min(5) })).min(1).max(3)
})

/** The character sheet's first answer: the image prompt and the body plan the app draws the sketch from (`images/sketch.ts`). */
export const bodyPlanAnswer = z.strictObject({ prompt: z.string().min(20), bodyPlan: bodyPlanSchema, notes: z.string().default('') })
export const refPickAnswer = z.strictObject({ pick: z.number().int().min(1).max(3), notes: z.string().default('') })

/** The claude-svg rig: `rig` and `parts` (the part SVGs by their path in the rig or by file name), or `viaTool: true` after `cts_rig_set` wrote them. */
export const rigClaudeAnswer = z
  .strictObject({ rig: rigSchema.optional(), parts: z.record(z.string(), z.string()).optional(), viaTool: z.boolean().optional(), notes: z.string().default('') })
  .superRefine((a, ctx) => {
    if (!a.viaTool && !(a.rig && a.parts)) ctx.addIssue({ code: 'custom', message: 'give rig and parts, or write them with cts_rig_set and answer {"viaTool": true}' })
  })

/** A face box `[x, y, width, height]` in pixels of ref.png. */
const faceBox = z.tuple([z.number().min(0), z.number().min(0), z.number().min(8), z.number().min(8)])

/** The raster rig: cut polygons and pivots in the pixels of ref.png; the code crops the parts. `parent` null is the root (the body; its pivot is the feet point). */
export const rigRasterAnswer = z.strictObject({
  height: z.number().positive().describe('the figure height in px of ref.png (feet to top of head)'),
  facing: z.enum(['left', 'right']).default('right'),
  parts: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
        parent: z.string().nullable(),
        polygon: z.array(point).min(3),
        pivot: point,
        z: z.number(),
        rot: z.tuple([z.number(), z.number()]).optional()
      })
    )
    .min(2),
  face: z.strictObject({ mouth: faceBox, eyes: faceBox, brows: faceBox }),
  overlap: z.number().min(0).max(24).default(6),
  notes: z.string().default('')
})

export const setPlanAnswer = z.strictObject({ backgroundPrompt: z.string().min(20), propName: z.string().nullable().default(null), propPrompt: z.string().nullable().default(null), notes: z.string().default('') })

export const setPlaceAnswer = z.strictObject({
  groundY: z.number(),
  actorScale: z.number().positive().default(1),
  propAt: point.nullable().default(null),
  marks: z.record(nameSchema, point),
  shots: z.record(nameSchema, z.strictObject({ center: point, zoom: z.number().positive() })),
  notes: z.string().default('')
})

/** CTS-27: the designer's answer for a 3D character or set: the whole spec (the tools `cts_character_set` / `cts_set3d_set` write the same file) and what it would still change. */
export const characterSpecAnswer = z.strictObject({ spec: character3dSchema, notes: z.string().default('') })
export const setSpecAnswer = z.strictObject({ spec: set3dSchema, notes: z.string().default('') })

export const scriptAnswer = z.strictObject({ script: episodeSchema, text: z.strictObject({ hr: textSchema, en: textSchema }), notes: z.string().default('') })

export const voiceCastAnswer = z.strictObject({
  voices: z.record(idSchema, z.strictObject({ hr: voiceSpecSchema, en: voiceSpecSchema })),
  audition: z.record(idSchema, z.strictObject({ hr: z.string().min(2), en: z.string().min(2) })),
  notes: z.string().default('')
})

export const musicAnswer = z.strictObject({
  tags: z.string().min(2),
  bpm: z.number().min(60).max(180),
  key: z.string().min(1),
  seed: z.number().int().min(0),
  seconds: z.number().min(20).max(60).optional(),
  sfx: z.array(z.strictObject({ name: z.string().min(1), prompt: z.string().min(2), seconds: z.number().min(1).max(10) })).max(2).optional(),
  notes: z.string().default('')
})

export const clipShotAnswer = z.strictObject({
  clips: z
    .array(
      z.strictObject({
        id: idSchema,
        who: z.array(idSchema).min(1).max(3),
        action: z.string().min(10),
        framing: z.string().default('medium shot'),
        move: z.string().default('static'),
        keyframe: z.string().min(10),
        /** What the keyframe still shows: our own player draws it (set, the leads at their marks, emotion, gesture peak). */
        staging: z.strictObject({
          set: idSchema,
          shot: nameSchema,
          actors: z
            .array(z.strictObject({ who: idSchema, mark: nameSchema, facing: facingSchema.default('right'), emotion: nameSchema.default('neutral'), gesture: nameSchema.optional() }))
            .min(1)
            .max(3)
        }),
        seconds: z.number().min(4).max(10).default(8)
      })
    )
    .min(1)
})

export const reviewAnswer = z.strictObject({
  verdict: z.enum(['pass', 'revise']),
  scores: z.record(z.string(), z.number()),
  notes: z.string(),
  problems: z.array(z.strictObject({ where: z.string(), what: z.string(), fix: z.string() }))
})

export interface TaskSchema {
  zod: ZodType
  /** The `schema` tag added to the written file (a review answer has none, the file does). */
  tag?: string
}

export const TASK_SCHEMAS: Record<string, TaskSchema> = {
  pitches: { zod: pitchesAnswer },
  bible: { zod: bibleAnswer },
  'body-plan': { zod: bodyPlanAnswer },
  'ref-pick': { zod: refPickAnswer },
  'rig-claude': { zod: rigClaudeAnswer },
  'rig-raster': { zod: rigRasterAnswer },
  'set-plan': { zod: setPlanAnswer },
  'set-place': { zod: setPlaceAnswer },
  'character-spec': { zod: characterSpecAnswer },
  'set-spec': { zod: setSpecAnswer },
  script: { zod: scriptAnswer },
  'voice-cast': { zod: voiceCastAnswer },
  music: { zod: musicAnswer },
  'clip-shots': { zod: clipShotAnswer },
  review: { zod: reviewAnswer, tag: 'cts.review/1' },
  'cts.bible/1': { zod: bibleSchema },
  'cts.review/1': { zod: reviewSchema }
}

/** The schema an `output.schema` name stands for: an answer schema above, or any file tag of the contracts. */
export function schemaFor(name: string): TaskSchema {
  const known = TASK_SCHEMAS[name]
  if (known) return known
  const tagged = (SCHEMAS_BY_TAG as Record<string, ZodType>)[name]
  if (tagged) return { zod: tagged }
  throw new Error(`unknown task schema "${name}" (${Object.keys(TASK_SCHEMAS).join(', ')} or a file tag such as cts.review/1)`)
}

// ---- prompts ----

/** Replaces `{{name}}` with the value. */
export function renderTemplate(template: string, vars: Record<string, string | number | undefined | null>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, k: string) => {
    const v = vars[k]
    return v === undefined || v === null ? '' : String(v)
  })
}

export async function readSeeded(dataDir: string, rel: string): Promise<string | null> {
  for (const root of [dataDir, findSeedDir()]) {
    if (!root) continue
    try {
      return await fs.readFile(path.join(root, rel), 'utf8')
    } catch {
      /* try the seed folder */
    }
  }
  return null
}

/** `prompts/<role>/<kind>.md` from the data folder (the seed folder when the data folder has none): the role's guide for this kind of task. */
export async function loadGuide(dataDir: string, role: string, kind: string): Promise<{ raw: string; body: string }> {
  const raw = await readSeeded(dataDir, path.join('prompts', role, `${kind}.md`))
  if (raw === null) throw new Error(`prompt template missing: prompts/${role}/${kind}.md`)
  return { raw, body: parseMd(raw, `${role}/${kind}.md`).body.trim() }
}

export async function loadRules(dataDir: string): Promise<{ raw: string; body: string }> {
  const raw = await readSeeded(dataDir, path.join('prompts', '_rules.md'))
  if (raw === null) return { raw: '', body: 'Follow the task exactly. Answer in the requested format only.' }
  return { raw, body: parseMd(raw, '_rules.md').body.trim() }
}

/** The part drawing rules and mouth reference drawings (`style/cutout-kids.md`). */
export async function loadStyleGuide(dataDir: string): Promise<string> {
  const raw = await readSeeded(dataDir, path.join('style', 'cutout-kids.md'))
  return raw === null ? '' : parseMd(raw, 'cutout-kids.md').body.trim()
}

/** The 3D guide (`style/toon-3d.md`: controls, shapes, face rules, the Pip, Bruno and park examples) for the designer tasks. */
export async function loadStyle3dGuide(dataDir: string): Promise<string> {
  const raw = await readSeeded(dataDir, path.join('style', 'toon-3d.md'))
  return raw === null ? '' : `## Guide: style/toon-3d.md\n\n${parseMd(raw, 'toon-3d.md').body.trim()}`
}

// ---- inputs ----

const IMAGE_RE = /\.(png|jpe?g|webp)$/i
const TEXT_LIMIT = 24_000

/** A picture for a message: shrunk to at most 1568 px on the long side and sent as JPEG (a rig sheet or a 1920 px background is too big as it is). */
export async function imagePart(file: string): Promise<{ type: 'image'; mime: string; data: string }> {
  const buf = await sharp(await fs.readFile(file)).flatten({ background: '#808080' }).resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 86 }).toBuffer()
  return { type: 'image', mime: 'image/jpeg', data: buf.toString('base64') }
}

/** The user message of a task: the prompt, the JSON input, the text files, then the pictures. */
export async function taskMessage(store: SeriesStore, series: string, task: RoleTask, extraImages: string[] = []): Promise<ChatMessage> {
  const texts: string[] = [task.prompt.trim()]
  if (task.inputs.json !== undefined) texts.push(`## Input\n\n\`\`\`json\n${JSON.stringify(task.inputs.json, null, 2)}\n\`\`\``)
  const images: string[] = [...extraImages]
  for (const rel of task.inputs.paths) {
    const abs = path.isAbsolute(rel) ? rel : store.resolve(series, rel)
    if (IMAGE_RE.test(rel)) {
      images.push(abs)
      continue
    }
    try {
      const text = await fs.readFile(abs, 'utf8')
      texts.push(`## File ${rel}\n\n${text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n... (cut)` : text}`)
    } catch {
      texts.push(`## File ${rel}\n\n(not there yet)`)
    }
  }
  if (images.length === 0) return { role: 'user', content: texts.join('\n\n') }
  const parts = await Promise.all(images.map((f) => imagePart(f)))
  const labels = images.map((f, i) => `[image ${i + 1}] ${path.basename(f)}`).join('\n')
  return { role: 'user', content: [{ type: 'text', text: `${texts.join('\n\n')}\n\n## Pictures (attached in this order)\n${labels}` }, ...parts] }
}

// ---- running a task ----

export interface RunTaskOptions {
  /** Pictures to attach besides the image paths in `inputs.paths` (absolute). */
  images?: string[]
  /** Extra text for the system message (for example the style guide). */
  system?: string
  /** Template variables of the guide. */
  vars?: Record<string, string | number | undefined | null>
  /** The task's own check of a valid answer: the problems go back to the model with the zod errors. Empty = fine. */
  check?: (value: unknown) => string[] | Promise<string[]>
  /** How many times the answer may be sent back with the errors (default 2). The first answer is not a retry. */
  rounds?: number
  maxTokens?: number
}

export interface RoleTaskResult<T = unknown> {
  value: T
  /** Absolute path of the written answer. */
  file: string
  costUsd: number
  /** How many answers were sent back with their errors. */
  retries: number
}

/**
 * Runs one role task on the job's model: builds the messages, asks for JSON, checks the answer against the task's schema and the task's own check,
 * sends a failing answer back with the errors, and writes the answer to `output.path` only once it is valid.
 */
export async function runRoleTask<T = unknown>(ctx: JobContext, store: SeriesStore, series: string, task: RoleTask, o: RunTaskOptions = {}): Promise<RoleTaskResult<T>> {
  const schema = schemaFor(task.output.schema)
  const dataDir = store.dataDir
  const [guide, rules] = await Promise.all([loadGuide(dataDir, task.role, task.kind), loadRules(dataDir)])
  ctx.usedTemplate(`${rules.raw}\n${guide.raw}`)
  const system = [rules.body, `## Your persona\n${ctx.agent.persona.trim()}`, `## Your guide for this task (${task.role}/${task.kind})\n${renderTemplate(guide.body, o.vars ?? {})}`, o.system ?? ''].filter(Boolean).join('\n\n')
  const messages: ChatMessage[] = [{ role: 'system', content: system }, await taskMessage(store, series, task, o.images)]
  const rounds = o.rounds ?? 2
  let costUsd = 0
  let retries = 0
  for (let round = 0; ; round++) {
    const r = await chatJson<unknown>(ctx, messages, schema.zod as ZodType<unknown>, { ...(o.maxTokens ? { maxTokens: o.maxTokens } : {}) })
    costUsd += r.cost
    const problems = o.check ? await o.check(r.value) : []
    if (problems.length === 0) {
      const body = schema.tag && r.value && typeof r.value === 'object' ? { schema: schema.tag, ...(r.value as object) } : r.value
      const file = await store.writeFile(series, task.output.path, `${JSON.stringify(body, null, 2)}\n`)
      return { value: r.value as T, file, costUsd, retries }
    }
    if (round >= rounds) throw new Error(`the answer for task ${task.id} is still not usable after ${rounds} retries: ${problems.slice(0, 6).join('; ')}`)
    retries++
    messages.push(
      { role: 'assistant', content: JSON.stringify(r.value).slice(0, 12_000) },
      { role: 'user', content: `Your answer was valid JSON but not usable yet:\n- ${problems.slice(0, 20).join('\n- ')}\nFix these and reply again with the whole JSON object only.` }
    )
  }
}

