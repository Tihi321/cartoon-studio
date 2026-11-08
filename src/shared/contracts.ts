import { z } from 'zod'

/**
 * The data contracts of a series: the only definition of every file under `series/<slug>/`. Other code imports these schemas and types and
 * never redefines them (docs/contracts.md explains each one in prose). Every file carries `schema: "cts.<kind>/1"`.
 *
 * Conventions: ids are `[a-z0-9-]+` (`Id`); a few names that are code words, not ids, may use more characters: rig part ids (`arm_l`),
 * mark, shot, gesture, cue and emotion names (`offL`, `cuLeft`). Times are seconds (float), coordinates are pixels with y down, paths in
 * a file are relative to the folder that file lives in, with two exceptions: a timeline's paths are relative to the series folder and a voice
 * manifest's `file` is relative to the episode folder (`voice/<lang>/<line>.wav`).
 * Objects are strict: an unknown key is an error, so a typo is found by the schema, not by a missing picture.
 */

// ---- shared pieces ----

export const ID_RE = /^[a-z0-9][a-z0-9-]*$/
export const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/

/** `[a-z0-9-]+`: series, cast, set, episode, scene, beat, line and clip ids. */
export const idSchema = z.string().regex(ID_RE, 'an id is lower-case letters, digits and - (not starting with -)')
/** A code word: rig part (`arm_l`), mark (`offL`), shot (`cuLeft`), gesture, cue, emotion. */
export const nameSchema = z.string().regex(NAME_RE, 'a name is letters, digits, _ and - (starting with a letter)')

export const LANGS = ['hr', 'en'] as const
export const langSchema = z.enum(LANGS)
export type Lang = z.infer<typeof langSchema>

export const localizedSchema = z.strictObject({ hr: z.string(), en: z.string() })
export type Localized = z.infer<typeof localizedSchema>

const point = z.tuple([z.number(), z.number()])
export type Point = z.infer<typeof point>
/** A relative file path (no drive, no `..`; the path guard checks the rest). */
const relPath = z.string().min(1)
const schemaTag = <K extends string>(kind: K) => z.literal(`cts.${kind}/1`)

export const MOUTH_SHAPES = ['rest', 'A', 'E', 'O', 'U', 'MBP', 'FV', 'L'] as const
export const mouthSchema = z.enum(MOUTH_SHAPES)
export type MouthShape = z.infer<typeof mouthSchema>

export const EYE_STATES = ['open', 'half', 'closed'] as const
export const eyeSchema = z.enum(EYE_STATES)
export type EyeState = z.infer<typeof eyeSchema>

export const BROW_STATES = ['neutral', 'happy', 'sad', 'surprised'] as const
export const browSchema = z.enum(BROW_STATES)
export type BrowState = z.infer<typeof browSchema>

export const facingSchema = z.enum(['left', 'right'])
export type Facing = z.infer<typeof facingSchema>

// ---- series bible: series/<slug>/bible.json ----

/** OmniVoice through ComfyUI: `instruct` is attribute tags only; `ref` is an optional reference WAV under `cast/<id>/voice/`. */
export const comfyVoiceSchema = z.strictObject({
  engine: z.string().min(1),
  instruct: z.string(),
  ref: relPath.nullable(),
  refText: z.string().nullable(),
  seed: z.number().int()
})

export const VOICE_PROVIDERS = ['auto', 'gemini', 'comfy', 'vibetts', 'paid'] as const
export const voiceSpecSchema = z.strictObject({
  provider: z.enum(VOICE_PROVIDERS),
  gemini: z.string().optional(),
  comfy: comfyVoiceSchema.optional(),
  vibetts: z.string().optional(),
  speed: z.number().positive().default(1),
  style: z.string().optional()
})
export type VoiceSpec = z.infer<typeof voiceSpecSchema>

export const castMemberSchema = z.strictObject({
  id: idSchema,
  name: localizedSchema,
  role: z.string(),
  personality: z.string(),
  /** What the character looks like, in a few concrete words (colours, shape, one telling detail): the reference prompt and the Flow clip prompts start from it. */
  look: z.string().optional(),
  catchphrases: z.strictObject({ hr: z.array(z.string()), en: z.array(z.string()) }).optional(),
  /** The default rig, relative to the series folder (`cast/<id>/rig.json`). */
  rig: relPath,
  voice: z.partialRecord(langSchema, voiceSpecSchema),
  /** CTS-12: set by `cts_sheet_approve` when the user approved the character sheet (`cast/<id>/sheet.png`): when, and the seed, denoise and image model the master was made with. Absent before the approval (and for characters made before the sheet step). */
  sheet: z.strictObject({ approvedAt: z.string(), seed: z.number().int(), denoise: z.number(), model: z.string() }).optional()
})
export type CastMember = z.infer<typeof castMemberSchema>

export const pitchSchema = z.strictObject({
  id: idSchema,
  title: localizedSchema,
  logline: localizedSchema,
  leads: z.array(z.strictObject({ name: z.string(), what: z.string() })).min(1),
  sets: z.array(z.string()),
  why: z.string()
})
export type Pitch = z.infer<typeof pitchSchema>

export const EPISODE_STATUSES = ['draft', 'in-progress', 'done'] as const

export const bibleSchema = z.strictObject({
  schema: schemaTag('bible'),
  slug: idSchema,
  title: localizedSchema,
  audience: z.strictObject({ ageMin: z.number().int(), ageMax: z.number().int() }),
  logline: localizedSchema,
  tone: z.array(z.string()),
  style: z.strictObject({
    look: z.string(),
    palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)),
    outlinePx: z.number().positive(),
    refPrompt: z.string()
  }),
  languages: z.array(langSchema).min(1),
  cast: z.array(castMemberSchema),
  sets: z.array(z.strictObject({ id: idSchema, name: localizedSchema, description: z.string(), file: relPath })),
  music: z.strictObject({ theme: relPath.optional(), stings: z.array(relPath).default([]) }).default({ stings: [] }),
  rules: z.array(z.string()),
  episodes: z.array(z.strictObject({ id: idSchema, title: localizedSchema, status: z.enum(EPISODE_STATUSES) })),
  /** The showrunner's 3 premises; the pipeline waits until `chosenPitch` (a pitch id) is set by the user. */
  pitches: z.array(pitchSchema).default([]),
  chosenPitch: idSchema.nullable().default(null),
  /** When the pitch was chosen (local ISO time); set by `cts_pitch_choose` (CTS-07). */
  chosenAt: z.string().optional()
})
export type Bible = z.infer<typeof bibleSchema>

// ---- rig: series/<slug>/cast/<id>/rig.json ----

export const rigPartSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  /** `parts/x.svg` or `parts/x.png`, relative to the folder of rig.json. */
  src: relPath.regex(/\.(svg|png)$/i, 'a part is an .svg or .png file'),
  parent: z.string().nullable(),
  /** In the part's own pixel coordinates. */
  pivot: point,
  /** Where the pivot sits in the parent part's coordinates (the root's `at` is [0, 0]). */
  at: point,
  z: z.number(),
  /** Rotation limits in degrees. */
  rot: z.tuple([z.number(), z.number()]).optional()
})
export type RigPart = z.infer<typeof rigPartSchema>

const eyesPlate = z.strictObject({ at: point, z: z.number(), states: z.partialRecord(eyeSchema, relPath) })
const browsPlate = z.strictObject({ at: point, z: z.number(), states: z.partialRecord(browSchema, relPath) })
const mouthPlate = z.strictObject({ at: point, z: z.number(), shapes: z.partialRecord(mouthSchema, relPath) })

/** The face is a plate on the head part. The states are optional in the schema so that `cts_lint` can report which one is missing (E_RIG_PART). */
export const rigFaceSchema = z.strictObject({ parent: z.string(), eyes: eyesPlate, brows: browsPlate, mouth: mouthPlate })

/**
 * A pose image (CTS-14): a full-body PNG of the character at a gesture's peak, made from the rig by image-to-image. `pivot` is the feet point in the
 * image's pixels (the actor's stage position, like the root part's pivot). `face` (optional) says where the face plates go: `at` is where the head
 * part's image top-left sits in the pose image, `scale` the head's scale there (1 = the rig's); without it the painted face shows and the mouth does
 * not move.
 */
export const rigPoseSchema = z.strictObject({
  src: relPath.regex(/.png$/i, 'a pose image is a .png file'),
  pivot: point,
  face: z.strictObject({ at: point, scale: z.number().positive() }).optional()
})
export type RigPose = z.infer<typeof rigPoseSchema>

export const rigGestureSchema = z.strictObject({
  part: z.string(),
  seconds: z.number().positive(),
  /** `[fraction of seconds 0..1, degrees]`, in time order. */
  keys: z.array(z.tuple([z.number().min(0).max(1), z.number()])).min(2),
  /** A pose image (a key of the rig's `poses`) drawn instead of the parts for the middle 60 % of the gesture. */
  pose: nameSchema.optional()
})

export const rigSchema = z.strictObject({
  schema: schemaTag('rig'),
  id: idSchema,
  kind: z.enum(['vector', 'raster']),
  drawnFacing: facingSchema,
  /** The figure's height in px at its own scale. */
  height: z.number().positive(),
  parts: z.array(rigPartSchema).min(1),
  face: rigFaceSchema,
  emotions: z.record(nameSchema, z.strictObject({ brows: browSchema, eyes: eyeSchema })),
  gestures: z.record(nameSchema, rigGestureSchema),
  /** Optional pose images by name; a gesture names one with `pose`. A rig without poses works as before. */
  poses: z.record(nameSchema, rigPoseSchema).optional(),
  move: z.strictObject({ bobPx: z.number().nonnegative(), stepSeconds: z.number().positive() })
})
export type Rig = z.infer<typeof rigSchema>

export const RIG_VARIANTS = ['a', 'c'] as const
export const rigVariantSchema = z.enum(RIG_VARIANTS)
export type RigVariant = z.infer<typeof rigVariantSchema>

// ---- set: series/<slug>/sets/<id>/set.json ----

export const setSchema = z.strictObject({
  schema: schemaTag('set'),
  id: idSchema,
  size: point,
  groundY: z.number(),
  actorScale: z.number().positive(),
  layers: z.array(
    z.strictObject({
      id: idSchema,
      src: relPath,
      z: z.number(),
      at: point.optional(),
      anchor: z.enum(['topleft', 'center', 'bottom']).optional(),
      parallax: z.number().default(1)
    })
  ),
  marks: z.record(nameSchema, point),
  /** `zoom` is relative to fitting the set's height into the frame (1 = the whole height). */
  shots: z.record(nameSchema, z.strictObject({ center: point, zoom: z.number().positive() }))
})
export type SetFile = z.infer<typeof setSchema>

// ---- episode script: episodes/<ep>/script.json (language-independent) ----

const beatBase = { id: idSchema, with: z.literal('prev').optional() }

export const BEAT_TYPES = ['line', 'move', 'turn', 'emote', 'gesture', 'look', 'camera', 'pause', 'sfx', 'music', 'title', 'clip'] as const

export const beatSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...beatBase,
    type: z.literal('line'),
    line: idSchema,
    speaker: idSchema,
    emotion: nameSchema.optional(),
    gesture: nameSchema.optional(),
    look: idSchema.optional(),
    pauseAfter: z.number().nonnegative().optional()
  }),
  z.strictObject({ ...beatBase, type: z.literal('move'), who: idSchema, to: nameSchema, seconds: z.number().positive() }),
  z.strictObject({ ...beatBase, type: z.literal('turn'), who: idSchema, facing: facingSchema }),
  z.strictObject({ ...beatBase, type: z.literal('emote'), who: idSchema, emotion: nameSchema }),
  z.strictObject({ ...beatBase, type: z.literal('gesture'), who: idSchema, gesture: nameSchema }),
  z.strictObject({ ...beatBase, type: z.literal('look'), who: idSchema, target: idSchema }),
  z.strictObject({ ...beatBase, type: z.literal('camera'), shot: nameSchema, transition: z.enum(['cut', 'pan']), seconds: z.number().positive().optional() }),
  z.strictObject({ ...beatBase, type: z.literal('pause'), seconds: z.number().positive() }),
  z.strictObject({ ...beatBase, type: z.literal('sfx'), cue: nameSchema }),
  z.strictObject({
    ...beatBase,
    type: z.literal('music'),
    cue: nameSchema,
    action: z.enum(['start', 'stop']),
    gain: z.number().min(0).max(1).optional(),
    fade: z.number().nonnegative().optional()
  }),
  /** A static title card: `key` is a string in `text/<lang>.json` `strings`. */
  z.strictObject({ ...beatBase, type: z.literal('title'), key: z.string().min(1), seconds: z.number().positive() }),
  /** A video clip (the Flow intro or outro; older series may still hold a hero clip); looked up in the episode's `clips/` first, then the series'. No beat runs `with: "prev"` over a clip. */
  z.strictObject({ ...beatBase, type: z.literal('clip'), clip: idSchema, seconds: z.number().positive(), audio: z.enum(['keep', 'mute']) })
])
export type Beat = z.infer<typeof beatSchema>

export const sceneSchema = z.strictObject({
  id: idSchema,
  set: idSchema,
  start: z.record(
    idSchema,
    z.strictObject({ mark: nameSchema, facing: facingSchema.optional(), emotion: nameSchema.optional() })
  ),
  shot: nameSchema,
  beats: z.array(beatSchema)
})
export type Scene = z.infer<typeof sceneSchema>

export const episodeSchema = z.strictObject({
  schema: schemaTag('episode'),
  series: idSchema,
  id: idSchema,
  /** The key in `text/<lang>.json` `strings` that holds the episode title. */
  titleKey: z.string(),
  cast: z.array(idSchema).min(1),
  scenes: z.array(sceneSchema).min(1),
  /** Cue name -> file, relative to the series folder. */
  music: z.record(nameSchema, relPath).default({}),
  sfx: z.record(nameSchema, relPath).default({})
})
export type Episode = z.infer<typeof episodeSchema>

// ---- text catalog: episodes/<ep>/text/<lang>.json ----

export const textSchema = z.strictObject({
  schema: schemaTag('text'),
  lang: langSchema,
  strings: z.record(z.string(), z.string()),
  lines: z.record(idSchema, z.strictObject({ text: z.string(), delivery: z.string().optional() }))
})
export type TextCatalog = z.infer<typeof textSchema>

// ---- voice manifest: episodes/<ep>/voice/<lang>/manifest.json ----

export const VOICE_STATUSES = ['ok', 'placeholder', 'failed'] as const

export const voiceLineSchema = z.strictObject({
  /** Relative to the episode folder (`voice/<lang>/<line>.wav`); the timeline's paths are relative to the series folder. */
  file: relPath,
  seconds: z.number().nonnegative(),
  provider: z.string(),
  engine: z.string().optional(),
  voice: z.string().optional(),
  speed: z.number().positive().optional(),
  /** `clipHash` of text + lang + voice + speed + style: a clip is re-made only when it changes. */
  hash: z.string(),
  /** Word times, when a provider or whisper gives them (phase 2). */
  words: z.array(z.strictObject({ w: z.string(), t0: z.number(), t1: z.number() })).nullable(),
  status: z.enum(VOICE_STATUSES)
})
export type VoiceLine = z.infer<typeof voiceLineSchema>

export const voiceManifestSchema = z.strictObject({
  schema: schemaTag('voice'),
  episode: idSchema,
  lang: langSchema,
  allocation: z.strictObject({ provider: z.string(), reason: z.string() }),
  lines: z.record(idSchema, voiceLineSchema),
  costUsd: z.number().nonnegative()
})
export type VoiceManifest = z.infer<typeof voiceManifestSchema>

// ---- lip-sync track: episodes/<ep>/lipsync/<lang>/<lineId>.json ----

export const lipsyncSchema = z.strictObject({
  schema: schemaTag('lipsync'),
  method: z.enum(['amplitude', 'words-hr', 'words-en']),
  fps: z.number().positive(),
  /** One shape per animation frame from the clip start. */
  shapes: z.array(mouthSchema)
})
export type Lipsync = z.infer<typeof lipsyncSchema>

// ---- timeline: episodes/<ep>/timeline.<lang>.json (built by code) ----

export const EASES = ['step', 'linear', 'inOut'] as const
export const easeSchema = z.enum(EASES)
export type Ease = z.infer<typeof easeSchema>

/** `[t, value, ease?]`. The ease belongs to the segment that starts at this key (key -> next key); the last key's ease is unused; default `linear`. */
export const numKeySchema = z.union([z.tuple([z.number(), z.number(), easeSchema]), z.tuple([z.number(), z.number()])])
export type NumKey = z.infer<typeof numKeySchema>
const numTrack = z.array(numKeySchema)
/** `[t, value]`: the value holds from t until the next key. */
const discTrack = <T extends z.ZodType>(v: T) => z.array(z.tuple([z.number(), v]))

export const timelineActorSchema = z.strictObject({
  x: numTrack,
  y: numTrack,
  facing: discTrack(facingSchema),
  visible: discTrack(z.boolean()),
  emotion: discTrack(nameSchema),
  eyes: discTrack(eyeSchema),
  mouth: discTrack(mouthSchema),
  rot: z.record(z.string(), numTrack),
  bob: numTrack,
  /** The pose image drawn instead of the parts (a key of the rig's `poses`), `null` for the parts; absent when the actor never uses one. */
  pose: discTrack(nameSchema.nullable()).optional()
})
export type TimelineActor = z.infer<typeof timelineActorSchema>

export const cameraKeySchema = z.strictObject({
  t: z.number(),
  center: point,
  zoom: z.number().positive(),
  /** How the camera leaves this key towards the next: `cut` (hold, then jump), `linear`, `inOut`. */
  ease: z.enum(['cut', 'linear', 'inOut'])
})
export type CameraKey = z.infer<typeof cameraKeySchema>

export const timelineAudioSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('voice'), line: idSchema, file: relPath, t: z.number(), gain: z.number() }),
  z.strictObject({
    kind: z.literal('music'),
    file: relPath,
    t: z.number(),
    until: z.number(),
    gain: z.number(),
    duckTo: z.number().optional(),
    fadeOut: z.number().optional()
  }),
  z.strictObject({ kind: z.literal('sfx'), file: relPath, t: z.number(), gain: z.number() })
])

export const timelineClipSchema = z.strictObject({
  id: idSchema,
  file: relPath,
  t0: z.number(),
  t1: z.number(),
  audio: z.enum(['keep', 'mute']),
  /** True when the clip file is missing or dropped: the render draws the cutout fallback (title card plus a bounce of the leads). */
  fallback: z.boolean()
})
export type TimelineClip = z.infer<typeof timelineClipSchema>

export const timelineSchema = z.strictObject({
  schema: schemaTag('timeline'),
  series: idSchema,
  episode: idSchema,
  lang: langSchema,
  /** sha1 of the bytes of script.json the timeline was built from. */
  scriptHash: z.string(),
  size: point,
  fps: z.strictObject({ anim: z.number().positive(), out: z.number().positive() }),
  duration: z.number().nonnegative(),
  seed: z.number().int(),
  scenes: z.array(z.strictObject({ id: idSchema, set: idSchema, t0: z.number(), t1: z.number() })),
  camera: z.array(cameraKeySchema).min(1),
  actors: z.record(idSchema, timelineActorSchema),
  audio: z.array(timelineAudioSchema),
  lines: z.array(z.strictObject({ id: idSchema, speaker: idSchema, t0: z.number(), t1: z.number() })),
  clips: z.array(timelineClipSchema).default([]),
  /** The beats in the order they ran with their start and end. Optional in the example; the builder writes it so the languages' order can be compared (E_LANG_ORDER). */
  beats: z.array(z.strictObject({ id: idSchema, t0: z.number(), t1: z.number() })).optional(),
  /** The `title` beats: a static card with the (already translated) text, shown from t0 to t1. Added by T4; absent in timelines without a title beat. */
  titles: z.array(z.strictObject({ id: idSchema, text: z.string(), t0: z.number(), t1: z.number() })).optional()
})
export type Timeline = z.infer<typeof timelineSchema>

// ---- series and episode records ----

/** series/<slug>/clips/clips.json: the series-level clips (the intro, reused by every episode); `episodes/<ep>/clips/clips.json` has the same shape. */
export const clipEntrySchema = z.strictObject({
  id: idSchema,
  /** Relative to the series folder (series clips) or the episode folder (episode clips). */
  file: relPath,
  seconds: z.number().positive(),
  credits: z.number().nonnegative(),
  flowMediaId: z.string().nullable(),
  prompt: z.string(),
  /** The frame-critic's review of the clip (`pass` | `revise` | not reviewed yet). */
  review: z.enum(['pass', 'revise']).nullable(),
  /** Dropped: the beat falls back to the cutout title card. */
  fallback: z.boolean().optional()
})
export const clipsFileSchema = z.strictObject({ schema: schemaTag('clips'), clips: z.array(clipEntrySchema) })
export type ClipEntry = z.infer<typeof clipEntrySchema>
export type ClipsFile = z.infer<typeof clipsFileSchema>

/** episodes/<ep>/budget.json: no file means both caps are 0, so nothing paid runs. */
export const budgetFileSchema = z.strictObject({
  schema: schemaTag('budget'),
  capUsd: z.number().nonnegative(),
  flowCreditsCap: z.number().nonnegative(),
  approvedBy: z.string(),
  approvedAt: z.string(),
  note: z.string()
})
export type BudgetFile = z.infer<typeof budgetFileSchema>

export const spendEntrySchema = z.strictObject({
  /** ISO time. */
  t: z.string(),
  provider: z.string(),
  model: z.string(),
  what: z.string(),
  currency: z.enum(['usd', 'credits']),
  amount: z.number().nonnegative()
})
/** episodes/<ep>/spend.json: the ledger, appended after each paid call. */
export const spendFileSchema = z.strictObject({ schema: schemaTag('spend'), entries: z.array(spendEntrySchema) })
export type SpendEntry = z.infer<typeof spendEntrySchema>
export type SpendFile = z.infer<typeof spendFileSchema>

/** Review JSON (Edu's shape): `reviews/safety.json`, `reviews/frames-<lang>-<n>.json`. */
export const reviewSchema = z.strictObject({
  schema: schemaTag('review'),
  verdict: z.enum(['pass', 'revise']),
  scores: z.record(z.string(), z.number()),
  notes: z.string(),
  problems: z.array(z.strictObject({ where: z.string(), what: z.string(), fix: z.string() }))
})
export type Review = z.infer<typeof reviewSchema>

/** episodes/<ep>/pipeline.json: the resumable pipeline state. T7 owns it and may extend the step list. */
export const PIPELINE_RUN_STATES = ['idle', 'running', 'waiting-on-user', 'waiting-on-client', 'failed', 'done'] as const
export const pipelineStateSchema = z.strictObject({
  schema: schemaTag('pipeline'),
  series: idSchema,
  episode: idSchema,
  state: z.enum(PIPELINE_RUN_STATES),
  steps: z.record(
    z.string(),
    z.strictObject({
      state: z.enum(['pending', 'running', 'done', 'failed', 'skipped']),
      startedAt: z.string().optional(),
      endedAt: z.string().optional(),
      error: z.string().optional(),
      /** CTS-07: the job that runs the step, a short note on how it ended, and the attempts so far. */
      job: z.string().optional(),
      detail: z.string().optional(),
      attempts: z.number().int().nonnegative().optional()
    })
  ),
  updatedAt: z.string(),
  /** CTS-07: the run counter (job ids end in `--r<run>`), what the run was asked (brief, options), why it waits, and the end summary. */
  run: z.number().int().nonnegative().optional(),
  brief: z.record(z.string(), z.unknown()).optional(),
  waitingOn: z.string().optional(),
  summary: z.record(z.string(), z.unknown()).optional()
})
export type PipelineState = z.infer<typeof pipelineStateSchema>

/** Every file kind by its `schema` tag, for tools that read a file without knowing its kind (docs check, lint). */
export const SCHEMAS_BY_TAG = {
  'cts.bible/1': bibleSchema,
  'cts.rig/1': rigSchema,
  'cts.set/1': setSchema,
  'cts.episode/1': episodeSchema,
  'cts.text/1': textSchema,
  'cts.voice/1': voiceManifestSchema,
  'cts.lipsync/1': lipsyncSchema,
  'cts.timeline/1': timelineSchema,
  'cts.clips/1': clipsFileSchema,
  'cts.budget/1': budgetFileSchema,
  'cts.spend/1': spendFileSchema,
  'cts.review/1': reviewSchema,
  'cts.pipeline/1': pipelineStateSchema
} as const
export type SchemaTag = keyof typeof SCHEMAS_BY_TAG
