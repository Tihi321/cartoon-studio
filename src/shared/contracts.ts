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
const vec3 = z.tuple([z.number(), z.number(), z.number()])
const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour is #rrggbb')
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

export const RENDERERS = ['canvas', 'blender'] as const
export const rendererSchema = z.enum(RENDERERS)
export type Renderer = z.infer<typeof rendererSchema>

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
  /** The default rig, relative to the series folder (`cast/<id>/rig.json`). Canvas series only: a `blender` series has `character` instead. */
  rig: relPath.optional(),
  /** The 3D character spec (`cts.character3d/1`), relative to the series folder (`cast/<id>/character.json`). Blender series only. */
  character: relPath.optional(),
  voice: z.partialRecord(langSchema, voiceSpecSchema),
  /** CTS-12: set by `cts_sheet_approve` when the user approved the character sheet (`cast/<id>/sheet.png`): when, and the seed, denoise and image model the master was made with. Absent before the approval (and for characters made before the sheet step). */
  sheet: z
    .strictObject({
      approvedAt: z.string(),
      /** Cutout sheets: the seed, denoise and image model of the master. A 3D sheet holds `specHash` (sha1 of `character.json` when it was approved) instead. */
      seed: z.number().int().optional(),
      denoise: z.number().optional(),
      model: z.string().optional(),
      specHash: z.string().optional()
    })
    .optional()
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
  chosenAt: z.string().optional(),
  /** HUB-30: who draws the episodes. `canvas` is the frozen cutout player (pilots 1 and 2, the `mini` fixture); `blender` builds 3D characters and sets and renders in Blender. */
  renderer: z.enum(RENDERERS).default('canvas'),
  /** The look file of a `blender` series (`cts.style3d/1`), relative to the series folder. Default `style3d.json`. */
  style3d: relPath.optional()
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

/** `walk hop run tiptoe` move a creature; `drive zoom reverse` a car and `chug` a train (HUB-31). */
export const MOVE_STYLES = ['walk', 'hop', 'run', 'tiptoe', 'drive', 'zoom', 'reverse', 'chug'] as const
export type MoveStyle = (typeof MOVE_STYLES)[number]

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
  z.strictObject({
    ...beatBase,
    type: z.literal('move'),
    who: idSchema,
    to: nameSchema,
    seconds: z.number().positive(),
    /** Blender series: how the actor travels (default: the character's motion profile). */
    style: z.enum(MOVE_STYLES).optional()
  }),
  z.strictObject({ ...beatBase, type: z.literal('turn'), who: idSchema, facing: facingSchema }),
  z.strictObject({ ...beatBase, type: z.literal('emote'), who: idSchema, emotion: nameSchema }),
  z.strictObject({
    ...beatBase,
    type: z.literal('gesture'),
    who: idSchema,
    gesture: nameSchema,
    /** Blender series: what the gesture is aimed at (point at, sit on, look at): a cast id, a prop id of the set or a mark. */
    target: nameSchema.optional()
  }),
  z.strictObject({ ...beatBase, type: z.literal('look'), who: idSchema, target: idSchema }),
  z.strictObject({ ...beatBase, type: z.literal('camera'), shot: nameSchema, transition: z.enum(['cut', 'pan', 'push']), seconds: z.number().positive().optional() }),
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
  /** Word times, when a provider or whisper gives them. For a Blender series: the script words that whisper heard (script spelling, whisper times). */
  words: z.array(z.strictObject({ w: z.string(), t0: z.number(), t1: z.number() })).nullable(),
  /** Share of the script words in `words` (0..1), set with them; under 0.7 the lip-sync uses the text method. */
  wordsCoverage: z.number().min(0).max(1).optional(),
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

export const LIPSYNC_METHODS = ['amplitude', 'words-hr', 'words-en', 'text-hr', 'text-en'] as const
export const lipsyncSchema = z.strictObject({
  schema: schemaTag('lipsync'),
  /** `amplitude`: 12 fps, A/E/rest (canvas). The others are the six-viseme methods of a Blender series at 24 fps: `words-<lang>` (whisper word times), `text-<lang>` (text + voiced segments). */
  method: z.enum(LIPSYNC_METHODS),
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

export const timelineLineSchema = z.strictObject({ id: idSchema, speaker: idSchema, t0: z.number(), t1: z.number() })
export const timelineBeatSchema = z.strictObject({ id: idSchema, t0: z.number(), t1: z.number() })
export const timelineTitleSchema = z.strictObject({ id: idSchema, text: z.string(), t0: z.number(), t1: z.number() })

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
  lines: z.array(timelineLineSchema),
  clips: z.array(timelineClipSchema).default([]),
  /** The beats in the order they ran with their start and end. Optional in the example; the builder writes it so the languages' order can be compared (E_LANG_ORDER). */
  beats: z.array(timelineBeatSchema).optional(),
  /** The `title` beats: a static card with the (already translated) text, shown from t0 to t1. Added by T4; absent in timelines without a title beat. */
  titles: z.array(timelineTitleSchema).optional()
})
export type Timeline = z.infer<typeof timelineSchema>

// ---- 3D (renderer "blender", HUB-30): characters, sets, the look, the timeline ----
// Units are metres, z is up, a rotation is degrees (x, y, z). A character faces -y at yaw 0 (the camera looks along +y).

/** The body kinds of a 3D character (HUB-31): a `creature` (arms, optional legs) or a `vehicle` (wheels, no arms or legs). */
export const BODY_KINDS = ['creature', 'vehicle'] as const
export const bodyKindSchema = z.enum(BODY_KINDS)
export type BodyKind = z.infer<typeof bodyKindSchema>
export const VEHICLE_TYPES = ['car', 'train'] as const
export const vehicleTypeSchema = z.enum(VEHICLE_TYPES)
export type VehicleType = z.infer<typeof vehicleTypeSchema>

/** The controls every creature has (parented empties, HUB-30 decision 6). Legs, ears, tails, brows, hands and accessory chains are optional. */
export const REQUIRED_CONTROLS = ['root', 'squash', 'body', 'head', 'arm_L', 'arm_R', 'lid_L', 'lid_R', 'pupil_L', 'pupil_R', 'mouth'] as const
export const OPTIONAL_CONTROL_RE = /^(hand_[LR]|leg_[LR]|brow_[LR]|ear_[LR]\d+|tail\d+|acc_[A-Za-z0-9-]+\d+)$/
/** The controls every vehicle has (HUB-31 decision 8), plus at least one `wheel_<n>`. `head` is the front face block. */
export const REQUIRED_VEHICLE_CONTROLS = ['root', 'squash', 'body', 'head', 'lid_L', 'lid_R', 'pupil_L', 'pupil_R', 'mouth'] as const
export const WHEEL_CONTROL_RE = /^wheel_\d+$/
/** Optional vehicle controls: wheels, lamp hoods (`brow_L/R`), the puff sources, the horn, the antenna spring chain and accessory chains. */
export const OPTIONAL_VEHICLE_CONTROL_RE = /^(wheel_\d+|brow_[LR]|chimney|exhaust|horn|antenna\d+|acc_[A-Za-z0-9-]+\d+)$/
/** Arm, hand and leg controls: an error on a vehicle. The schema message starts with `E_VEHICLE_LIMB:` so lint reports it under that code. */
export const LIMB_CONTROL_RE = /^(arm|hand|leg)_/
export const PART_SHAPES = ['ellipsoid', 'cone', 'box', 'capsule', 'torus', 'arc', 'spines', 'cylinder'] as const
export const WALK_STYLES = ['walk', 'hop', 'waddle'] as const
/** How a vehicle drives: `zip` (quick starts, bouncy) or `chug` (slow start, heavy late settle). */
export const DRIVE_STYLES = ['zip', 'chug'] as const

const size3 = z.array(z.number().positive()).min(1).max(3)
const controlName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/)

export const character3dPartSchema = z.strictObject({
  id: nameSchema,
  shape: z.enum(PART_SHAPES),
  /** Radii or extents, one to three numbers (an ellipsoid has three radii, a cone a radius and a height, a cylinder a radius and a length ...). */
  size: size3,
  at: vec3,
  rot: vec3.optional(),
  /** A key of `palette`. */
  colour: controlName,
  /** The control (empty) the part hangs on. */
  control: controlName,
  /** Outline width in metres; default from the style. */
  outline: z.number().nonnegative().optional(),
  spines: z.strictObject({ count: z.number().int().positive(), length: z.number().positive(), radius: z.number().positive(), keep: z.enum(['back', 'top', 'all']), lean: z.number() }).optional()
})
export type Character3dPart = z.infer<typeof character3dPartSchema>

const motionBase = {
  /** Gesture speed factor (Pip 1.4, Bruno 0.75). */
  tempo: z.number().positive(),
  /** Amplitude of gestures and idle motion. */
  energy: z.number().positive(),
  /** Hop and idle bob (a vehicle: the suspension bob). */
  bounce: z.number().nonnegative()
}
/** The motion profile of a creature. */
export const creatureMotionSchema = z.strictObject({
  ...motionBase,
  walk: z.strictObject({ style: z.enum(WALK_STYLES), stride: z.number().positive(), cadence: z.number().positive() })
})
export type CreatureMotion = z.infer<typeof creatureMotionSchema>
/** The motion profile of a vehicle: `topSpeed` in m/s, `accel` in m/s², `suspension` 0 (stiff) to 1 (soft: bouncy, settles late). */
export const vehicleMotionSchema = z.strictObject({
  ...motionBase,
  drive: z.strictObject({ style: z.enum(DRIVE_STYLES), topSpeed: z.number().positive(), accel: z.number().positive(), suspension: z.number().min(0).max(1) })
})
export type VehicleMotion = z.infer<typeof vehicleMotionSchema>

/** The `vehicle` block: the type, the wheel radius in metres, the wheel controls (each spins on its own axis), and `track` (a train: true, it moves only along a track path; a car: false). */
export const vehicleBlockSchema = z.strictObject({
  type: vehicleTypeSchema,
  wheelRadius: z.number().positive(),
  wheels: z.array(controlName).min(1),
  track: z.boolean()
})
export type VehicleBlock = z.infer<typeof vehicleBlockSchema>

/** `cast/<id>/character.json`: a character as primitives (no AI image is an input). The builder (`blender/`) makes `character.blend` from it. */
export const character3dSchema = z
  .strictObject({
    schema: schemaTag('character3d'),
    id: idSchema,
    units: z.literal('m'),
    /** HUB-31: the body kind; default `creature` (so every pilot 3 spec parses unchanged). */
    kind: bodyKindSchema.default('creature'),
    /** Standing height in metres (a vehicle: to the roof). */
    height: z.number().positive(),
    palette: z.record(controlName, hexColour),
    /** A creature has `walk`, a vehicle `drive` (the refinement checks it against `kind`). */
    motion: z.union([creatureMotionSchema, vehicleMotionSchema]),
    /** Vehicles only, and required for them. */
    vehicle: vehicleBlockSchema.optional(),
    controls: z.record(controlName, z.strictObject({ parent: controlName.nullable(), at: vec3, rot: vec3.optional() })),
    /** Spring of a secondary chain (`ear_L`, `tail`, `acc_scarf`, `antenna`): stiffness and damping. A chain without an entry uses the library default. */
    springs: z.record(controlName, z.strictObject({ stiffness: z.number().positive(), damping: z.number().nonnegative() })).optional(),
    parts: z.array(character3dPartSchema).min(1),
    face: z.strictObject({
      control: z.literal('head'),
      eyes: z.strictObject({
        x: z.number(),
        z: z.number(),
        r: z.number().positive(),
        faceY: z.number(),
        pupil: z.strictObject({ size: z.number().positive(), lead: z.number().nonnegative() }),
        /** HUB-31: lamp eyes (a vehicle's front lamps): the colour they glow with when they flash, and the palette colour of the lamp rim. */
        lamp: z.strictObject({ glow: hexColour, rim: controlName }).optional()
      }),
      lids: z.strictObject({ colour: controlName }),
      brows: z.strictObject({ colour: controlName, at: vec3, length: z.number().positive() }).optional(),
      mouth: z.strictObject({ at: vec3, scale: z.number().positive(), inner: hexColour, tongue: hexColour.optional() })
    }),
    accessories: z.array(character3dPartSchema).optional()
  })
  .superRefine((c, ctx) => {
    const bad = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message })
    const vehicle = c.kind === 'vehicle'
    const required: readonly string[] = vehicle ? REQUIRED_VEHICLE_CONTROLS : REQUIRED_CONTROLS
    for (const name of required) if (!c.controls[name]) bad(['controls', name], `a ${c.kind} has the control "${name}"`)
    for (const [name, ctl] of Object.entries(c.controls)) {
      if (vehicle && LIMB_CONTROL_RE.test(name)) bad(['controls', name], `E_VEHICLE_LIMB: a vehicle has no arms, hands or legs ("${name}")`)
      else if (vehicle && !required.includes(name) && !OPTIONAL_VEHICLE_CONTROL_RE.test(name))
        bad(['controls', name], `"${name}" is not a standard vehicle control (wheel_1.., brow_L/R, chimney, exhaust, horn, antenna1.., acc_<name>1..)`)
      else if (!vehicle && !required.includes(name) && !OPTIONAL_CONTROL_RE.test(name))
        bad(['controls', name], `"${name}" is not a standard control (hand_L/R, leg_L/R, brow_L/R, ear_L1.., ear_R1.., tail1.., acc_<name>1..)`)
      if (ctl.parent !== null && !c.controls[ctl.parent]) bad(['controls', name, 'parent'], `parent "${ctl.parent}" is not a control`)
      if (ctl.parent === null && name !== 'root') bad(['controls', name, 'parent'], 'only root has no parent')
    }
    if (c.controls.root && c.controls.root.parent !== null) bad(['controls', 'root', 'parent'], 'root has no parent (null)')
    if (vehicle) {
      const wheels = Object.keys(c.controls).filter((n) => WHEEL_CONTROL_RE.test(n))
      if (!wheels.length) bad(['controls'], 'a vehicle has at least one wheel control (wheel_1, wheel_2 ..)')
      if (!('drive' in c.motion)) bad(['motion'], 'a vehicle has motion.drive (not walk)')
      if (!c.vehicle) bad(['vehicle'], 'a vehicle has a vehicle block { type, wheelRadius, wheels, track }')
      else {
        c.vehicle.wheels.forEach((w, i) => {
          if (!WHEEL_CONTROL_RE.test(w) || !c.controls[w]) bad(['vehicle', 'wheels', i], `"${w}" is not a wheel control of this vehicle`)
        })
        for (const w of wheels) if (!c.vehicle.wheels.includes(w)) bad(['vehicle', 'wheels'], `wheel control "${w}" is not listed in vehicle.wheels`)
        if (c.vehicle.type === 'train' && !c.vehicle.track) bad(['vehicle', 'track'], 'a train runs on a track (track: true)')
        if (c.vehicle.type === 'car' && c.vehicle.track) bad(['vehicle', 'track'], 'a car does not run on a track (track: false)')
      }
    } else {
      if (!('walk' in c.motion)) bad(['motion'], 'a creature has motion.walk (not drive)')
      if (c.vehicle) bad(['vehicle'], 'only a vehicle (kind: "vehicle") has a vehicle block')
    }
    if (c.face.eyes.lamp && !c.palette[c.face.eyes.lamp.rim]) bad(['face', 'eyes', 'lamp', 'rim'], `colour "${c.face.eyes.lamp.rim}" is not in the palette`)
    const lists = [['parts', c.parts], ['accessories', c.accessories ?? []]] as const
    for (const [label, list] of lists) {
      list.forEach((part, i) => {
        if (!c.palette[part.colour]) bad([label, i, 'colour'], `colour "${part.colour}" is not in the palette`)
        if (!c.controls[part.control]) bad([label, i, 'control'], `control "${part.control}" is not a control of this character`)
      })
    }
    if (!c.palette[c.face.lids.colour]) bad(['face', 'lids', 'colour'], `colour "${c.face.lids.colour}" is not in the palette`)
    if (c.face.brows && !c.palette[c.face.brows.colour]) bad(['face', 'brows', 'colour'], `colour "${c.face.brows.colour}" is not in the palette`)
  })
export type Character3d = z.infer<typeof character3dSchema>
export type VehicleCharacter3d = Character3d & { kind: 'vehicle'; motion: VehicleMotion; vehicle: VehicleBlock }

/** A parsed spec is a vehicle (the schema guarantees `motion.drive` and `vehicle` for it). */
export const isVehicle = (c: Character3d): c is VehicleCharacter3d => c.kind === 'vehicle'

/** The prop kit (`blender/cts_blender/props.json`); HUB-31 adds the road and rail kit `road track crossing platform signal buffer_stop`. */
export const PROP_KINDS = ['tree_round', 'tree_cone', 'bush', 'bench', 'rock', 'flowers', 'fence', 'house', 'cloud', 'road', 'track', 'crossing', 'platform', 'signal', 'buffer_stop'] as const
export type PropKind = (typeof PROP_KINDS)[number]
/** Path kinds of a set (HUB-31): a car drives on a `road`, a train runs on a `track`. */
export const PATH_KINDS = ['road', 'track'] as const
export const pathKindSchema = z.enum(PATH_KINDS)
export type PathKind = z.infer<typeof pathKindSchema>
/** The width in metres of a path that gives none. */
export const PATH_WIDTH_DEFAULT: Readonly<Record<PathKind, number>> = { road: 3, track: 1.6 }
/** A mark is on a path when it lies within this many metres of the path's centre line (E_MARK_OFF_PATH, E_OFF_TRACK). */
export const PATH_MARK_TOLERANCE = 0.3
/** The prop kinds built along a path: their `path` names a path of this kind and their `at` is not used. */
export const PATH_PROP_KINDS: Readonly<Partial<Record<PropKind, PathKind>>> = { road: 'road', track: 'track' }

/** A path of a set: a centre line on the ground (x, y in metres, at least two points) that vehicles follow; `width` in metres. */
export const set3dPathSchema = z.strictObject({ kind: pathKindSchema, points: z.array(point).min(2), width: z.number().positive().optional() })
export type Set3dPath = z.infer<typeof set3dPathSchema>

/** `sets/<id>/set3d.json`: ground, sky, props from the kit, marks (ground points actors walk to), named cameras and (HUB-31) paths. The builder makes `set.blend`. */
export const set3dSchema = z
  .strictObject({
    schema: schemaTag('set3d'),
    id: idSchema,
    ground: z.strictObject({
      /** Width and depth in metres. */
      size: point,
      colour: hexColour,
      patches: z.array(z.strictObject({ shape: z.enum(['disc', 'rect']), at: point, size: point, colour: hexColour })).default([])
    }),
    sky: z.strictObject({ top: hexColour, horizon: hexColour }),
    props: z.array(
      z.strictObject({
        id: idSchema,
        kind: z.enum(PROP_KINDS),
        /** Ground position (x, y) in metres. */
        at: point,
        rot: z.number().optional(),
        scale: z.number().positive().optional(),
        colours: z.record(controlName, hexColour).optional(),
        /** Where an actor sits (`sit`): the seat height and the seat point relative to the prop. */
        seat: z.strictObject({ height: z.number().positive(), at: point }).optional(),
        /** HUB-31: a `road` or `track` prop is built along this path of the set (a path of the same kind). */
        path: idSchema.optional()
      })
    ),
    /** Ground points (x, y): `walk` goes to them, actors start on them. */
    marks: z.record(nameSchema, point),
    cameras: z.record(nameSchema, z.strictObject({ loc: vec3, target: vec3, lens: z.number().positive() })).default({}),
    /** HUB-31: the roads and tracks vehicles follow, by id. Optional, so sets without vehicles parse unchanged. */
    paths: z.record(idSchema, set3dPathSchema).optional()
  })
  .superRefine((s, ctx) => {
    s.props.forEach((p, i) => {
      const bad = (message: string) => ctx.addIssue({ code: 'custom', path: ['props', i, 'path'], message })
      const need = PATH_PROP_KINDS[p.kind]
      if (!need) {
        if (p.path !== undefined) bad(`a ${p.kind} is not built along a path (only road and track are)`)
        return
      }
      const path = p.path === undefined ? undefined : s.paths?.[p.path]
      if (!path) bad(`a ${p.kind} prop names the ${need} path it is built along (${p.path === undefined ? 'none given' : `"${p.path}" is not a path of the set`})`)
      else if (path.kind !== need) bad(`a ${p.kind} prop is built along a ${need} path; "${p.path}" is a ${path.kind}`)
    })
  })
export type Set3d = z.infer<typeof set3dSchema>

const skyColours = z.strictObject({ top: hexColour, horizon: hexColour })

/** `style3d.json`: the look of a series. The defaults are the probe's clean look, so `{ "schema": "cts.style3d/1" }` is a valid file. */
export const style3dSchema = z.strictObject({
  schema: schemaTag('style3d'),
  toon: z.strictObject({ shade: z.number().min(0).max(1).default(0.74), threshold: z.number().min(0).max(1).default(0.36) }).default({ shade: 0.74, threshold: 0.36 }),
  outline: z.strictObject({ colour: hexColour.default('#2b2118'), scale: z.number().positive().default(1) }).default({ colour: '#2b2118', scale: 1 }),
  world: z.strictObject({ sky: skyColours.default({ top: '#86cdf0', horizon: '#e4f6fb' }) }).default({ sky: { top: '#86cdf0', horizon: '#e4f6fb' } }),
  /** The sun (no shadows): rotation in degrees (x, y, z) and strength. */
  sun: z.strictObject({ angle: vec3.default([50, -10, -35]), energy: z.number().positive().default(3.2) }).default({ angle: [50, -10, -35], energy: 3.2 }),
  samples: z.strictObject({ final: z.number().int().positive().default(16), preview: z.number().int().positive().default(4) }).default({ final: 16, preview: 4 }),
  post: z.enum(['none', 'paper', 'posterize']).default('none'),
  /** Hold poses on twos for a stop-motion feel. */
  stepped: z.boolean().default(false)
})
export type Style3d = z.infer<typeof style3dSchema>

/** The viseme a 3D mouth shows: the six of the Blender methods (`rest A E O U MBP`). */
export const VISEMES = ['rest', 'A', 'E', 'O', 'U', 'MBP'] as const
export const visemeSchema = z.enum(VISEMES)
export type Viseme = z.infer<typeof visemeSchema>

export const SHOT_TRANSITIONS = ['cut', 'pan', 'push'] as const

/**
 * `episodes/<ep>/timeline.<lang>.json` of a `blender` series: the beats as semantic actions with times (the Python assembler turns them into a scene).
 * `audio`, `lines`, `clips`, `titles` and `beats` have the shapes of `cts.timeline/1`, so the mix, the clip splice and E_LANG_ORDER are shared.
 */
export const timeline3dSchema = z.strictObject({
  schema: schemaTag('timeline3d'),
  series: idSchema,
  episode: idSchema,
  lang: langSchema,
  /** sha1 of the bytes of script.json the timeline was built from. */
  scriptHash: z.string(),
  fps: z.literal(24),
  size: point,
  duration: z.number().nonnegative(),
  seed: z.number().int(),
  scenes: z.array(z.strictObject({ id: idSchema, set: idSchema, t0: z.number(), t1: z.number() })),
  actors: z.record(
    idSchema,
    z.strictObject({
      start: z.strictObject({ mark: nameSchema, facing: z.union([facingSchema, z.number()]) }),
      actions: z.array(z.strictObject({ beat: idSchema, action: nameSchema, t0: z.number(), t1: z.number(), params: z.record(z.string(), z.unknown()).default({}) })),
      /** `[t, target]`: from t the actor looks at a cast id, a prop id or a mark; null looks ahead. */
      look: z.array(z.tuple([z.number(), nameSchema.nullable()])).default([]),
      emotion: z.array(z.tuple([z.number(), nameSchema])).default([]),
      mouth: z.array(z.tuple([z.number(), visemeSchema])).default([]),
      blinks: z.array(z.number()).default([]),
      /** The intervals of the actor's own lines. */
      speaking: z.array(z.tuple([z.number(), z.number()])).default([]),
      /** Word onsets inside the actor's lines: small head and hand accents. */
      accents: z.array(z.number()).default([])
    })
  ),
  shots: z.array(z.strictObject({ t: z.number(), shot: nameSchema, transition: z.enum(SHOT_TRANSITIONS), seconds: z.number().positive().optional() })).min(1),
  audio: z.array(timelineAudioSchema),
  lines: z.array(timelineLineSchema),
  clips: z.array(timelineClipSchema).default([]),
  beats: z.array(timelineBeatSchema).optional(),
  titles: z.array(timelineTitleSchema).optional()
})
export type Timeline3d = z.infer<typeof timeline3dSchema>

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
  'cts.character3d/1': character3dSchema,
  'cts.set3d/1': set3dSchema,
  'cts.style3d/1': style3dSchema,
  'cts.timeline3d/1': timeline3dSchema,
  'cts.clips/1': clipsFileSchema,
  'cts.budget/1': budgetFileSchema,
  'cts.spend/1': spendFileSchema,
  'cts.review/1': reviewSchema,
  'cts.pipeline/1': pipelineStateSchema
} as const
export type SchemaTag = keyof typeof SCHEMAS_BY_TAG
