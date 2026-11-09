import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { BROW_STATES, EYE_STATES, MOUTH_SHAPES, PATH_MARK_TOLERANCE, isVehicle } from '../../shared/contracts'
import { character3dSchema, style3dSchema } from '../../shared/contracts'
import type { Bible, Character3d, Episode, Lang, PathKind, Rig, RigVariant, Set3d, SetFile, TextCatalog, Timeline, Timeline3d, VehicleCharacter3d, VoiceManifest } from '../../shared/contracts'
import { SIX_VISEMES, textHasLabial } from '../anim/visemes'
import { bodyCannot, bodyOf, loadActingLibrary, moveAction } from '../blender/library'
import { blockedPaths, distanceToPath, pathsAt, propFootprint } from '../blender/props'
import type { ActingLibrary } from '../blender/library'
import { loadRenderConfig } from '../render/ffmpeg'
import { readMixCheck } from '../render/mixcheck'
import { sampleCamera, sampleNumber, sampleStep } from '../../shared/sample'
import { SeriesFileError, SeriesStore, hashScript } from './service'
import type { SeriesPaths } from './paths'

/**
 * `cts_lint`: the checks on a series and an episode, with fixed codes (errors fail a pipeline step, warnings are listed). The same code runs
 * the per-rig check (`checkRig`, behind `cts_rig_check`). Nothing here writes a file.
 */

export const LINT_CODES = [
  'E_SCHEMA',
  'E_CAST_UNKNOWN',
  'E_SET_UNKNOWN',
  'E_MARK_UNKNOWN',
  'E_MARK_BLOCKED',
  'E_SHOT_UNKNOWN',
  'E_GESTURE_UNKNOWN',
  'E_ACTION_UNKNOWN',
  'E_LINE_NO_TEXT',
  'E_LINE_NO_AUDIO',
  'E_RIG_PART',
  'E_TIMELINE_STALE',
  'E_MOUTH_SILENT',
  'E_LANG_ORDER',
  'E_CLIP_MISSING',
  'E_VEHICLE_LIMB',
  'E_ACTION_BODY',
  'E_MARK_OFF_PATH',
  'E_OFF_TRACK',
  'E_PATH_BLOCKED',
  'W_LINE_LONG',
  'W_OFF_FRAME',
  'W_GESTURE_OVER_LINE',
  'W_VISEME_FLAT',
  'W_LANG_DRIFT',
  'W_PLACEHOLDER',
  'W_MIX_MUSIC_LOUD'
] as const
export type LintCode = (typeof LINT_CODES)[number]

export interface LintIssue {
  code: LintCode
  severity: 'error' | 'warning'
  message: string
  /** The file, relative to the series folder, when the issue belongs to one. */
  file?: string
  /** Where inside it (a beat id, a part id). */
  where?: string
  lang?: Lang
}

export interface RigCheck {
  cast: string
  variant?: RigVariant
  /** True when there is no error (warnings do not fail a rig). */
  ok: boolean
  parts: number
  issues: LintIssue[]
}

/** How much of a line's frames the mouth is open (A9: at least 60 % non-`rest`). */
export interface LineStat {
  lang: Lang
  line: string
  speaker: string
  frames: number
  nonRest: number
  /** nonRest / frames (0 when the line has no frames). */
  share: number
}

export interface LintResult {
  series: string
  episode?: string
  /** No errors. */
  ok: boolean
  errors: LintIssue[]
  warnings: LintIssue[]
  rigs: RigCheck[]
  stats: { lines: LineStat[]; minShare: number | null }
}

export interface LintOptions {
  episode?: string
  /** A missing voice manifest or file is an error (the pipeline sets it after the voice step). Default: only a manifest that exists is checked. */
  requireAudio?: boolean
}

const MAX_LINE_WORDS = 12
const MAX_LINE_SECONDS = 5
const LANG_DRIFT = 0.25
const SVG_MAX_BYTES = 30 * 1024
const SVG_PATTERN_MAX_BYTES = 200 * 1024

const isErrorCode = (code: LintCode) => code.startsWith('E_')

class Issues {
  readonly list: LintIssue[] = []
  add(code: LintCode, message: string, extra: { file?: string; where?: string; lang?: Lang } = {}): void {
    this.list.push({ code, severity: isErrorCode(code) ? 'error' : 'warning', message, ...extra })
  }
}

/** Reads a file with its schema; a missing or bad file becomes an issue (E_SCHEMA, or `missingCode`) and null. */
async function load<T>(issues: Issues, rel: string, read: () => Promise<T>, missingCode: LintCode = 'E_SCHEMA', lang?: Lang): Promise<T | null> {
  try {
    return await read()
  } catch (e) {
    if (e instanceof SeriesFileError) {
      const code = e.kind === 'missing' ? missingCode : 'E_SCHEMA'
      issues.add(code, e.kind === 'missing' ? `${rel} not found` : `${rel}: ${e.kind === 'json' ? 'not valid JSON' : 'schema'}: ${e.issues.slice(0, 6).join('; ')}`, { file: rel, ...(lang ? { lang } : {}) })
      return null
    }
    throw e
  }
}

const exists = (file: string) => fs.stat(file).then((s) => s.isFile(), () => false)

// ---- SVG and PNG part rules ----

/** The problems of one SVG part file against the part rules (flat fills and strokes only, nothing active or external). */
export function svgProblems(svg: string, bytes: number): string[] {
  const out: string[] = []
  if (!/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(svg)) out.push('not an SVG document')
  const vb = /viewBox\s*=\s*["']([^"']+)["']/i.exec(svg)
  if (!vb || vb[1]!.trim().split(/[\s,]+/).filter((n) => Number.isFinite(Number(n))).length !== 4) out.push('no px viewBox (four numbers)')
  if (/<(text|tspan|textPath)[\s>/]/i.test(svg)) out.push('contains <text> (turn text into paths)')
  if (/<filter[\s>/]|[\s;"']filter\s*[:=]/i.test(svg)) out.push('uses a filter')
  if (/<script[\s>/]|\son[a-z]+\s*=/i.test(svg)) out.push('contains a script or an event handler')
  if (/<foreignObject[\s>/]/i.test(svg)) out.push('contains <foreignObject>')
  if (/<(linear|radial)Gradient[\s>/]|<meshgradient[\s>/]/i.test(svg)) out.push('uses a gradient (flat fills only)')
  if (/<style[^>]*>[\s\S]*?(@import|url\(\s*["']?https?:)/i.test(svg)) out.push('<style> imports something external')
  const patterns = svg.match(/<pattern[\s>/]/gi) ?? []
  if (patterns.length > 1) out.push('more than one <pattern>')
  const outsidePatterns = svg.replace(/<pattern[\s\S]*?<\/pattern>/gi, '')
  if (/<image[\s>/]/i.test(outsidePatterns)) out.push('an <image> outside a <pattern>')
  for (const m of svg.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
    const v = m[1]!.trim()
    if (v.startsWith('#')) continue
    if (/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(v) && patterns.length === 1) continue
    out.push(`external or data href "${v.slice(0, 30)}"${patterns.length ? '' : ' (data-URI images are allowed only inside one <pattern>)'}`)
  }
  const patternIds = new Set([...svg.matchAll(/<pattern[^>]*\sid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!))
  for (const m of svg.matchAll(/(?:fill|stroke)\s*[=:]\s*["']?\s*url\(\s*["']?([^)"'\s]*)/gi)) {
    const ref = m[1]!
    if (!ref.startsWith('#') || !patternIds.has(ref.slice(1))) out.push(`fill/stroke refers to "${ref.slice(0, 30)}" (only a <pattern> in the same file)`)
  }
  for (const m of svg.matchAll(/url\(\s*["']?(?!#)([^)"']*)/gi)) {
    if (!/^(fill|stroke)/.test(m[0])) out.push(`external url(${m[1]!.slice(0, 30)})`)
  }
  const limit = patterns.length ? SVG_PATTERN_MAX_BYTES : SVG_MAX_BYTES
  if (bytes > limit) out.push(`${Math.round(bytes / 1024)} KB is over the ${limit / 1024} KB limit${patterns.length ? '' : ' (200 KB with a <pattern>)'}`)
  return [...new Set(out)]
}

// ---- rig check ----

/**
 * Checks one rig: `rig.json` and its schema, every part and face file (exists; SVG rules; PNG has alpha), all 8 mouth shapes, the 3 eye states
 * and the 4 brow states, parents, gesture parts and emotions. Without `variant` the rig at `cast/<id>/rig.json`, else `variants/<v>/rig.json`.
 */
export async function checkRig(store: SeriesStore, series: string, cast: string, variant?: RigVariant): Promise<RigCheck> {
  const issues = new Issues()
  const p = store.paths(series)
  const rigFile = p.rigFile(cast, variant)
  const rel = relTo(p, rigFile)
  const rig = await load(issues, rel, () => store.readRig(series, cast, variant), 'E_RIG_PART')
  if (rig) await checkRigContent(issues, p, rig, cast, variant)
  const list = issues.list
  return { cast, ...(variant ? { variant } : {}), ok: !list.some((i) => i.severity === 'error'), parts: rig?.parts.length ?? 0, issues: list }
}

const relTo = (p: SeriesPaths, abs: string) => abs.slice(p.root.length + 1).replace(/\\/g, '/')

/** A PNG face plate (CTS-13 face patches) may be at most this big. */
export const PNG_PLATE_MAX_BYTES = 512 * 1024

async function checkRigContent(issues: Issues, p: SeriesPaths, rig: Rig, cast: string, variant?: RigVariant): Promise<void> {
  const dir = p.rigDir(cast, variant)
  const file = relTo(p, p.rigFile(cast, variant))
  const bad = (where: string, message: string) => issues.add('E_RIG_PART', message, { file, where })

  if (rig.id !== cast) bad('id', `rig id "${rig.id}" is not the cast id "${cast}"`)
  const ids = new Set<string>()
  for (const part of rig.parts) {
    if (ids.has(part.id)) bad(part.id, `part id "${part.id}" appears twice`)
    ids.add(part.id)
  }
  const roots = rig.parts.filter((x) => x.parent === null)
  if (roots.length !== 1) bad('parts', `a rig has exactly one root part (parent null); found ${roots.length}`)
  for (const part of rig.parts) if (part.parent !== null && !ids.has(part.parent)) bad(part.id, `parent "${part.parent}" is not a part`)
  if (!ids.has(rig.face.parent)) bad('face', `face parent "${rig.face.parent}" is not a part`)
  for (const [name, g] of Object.entries(rig.gestures)) {
    if (!ids.has(g.part)) bad(`gestures.${name}`, `gesture part "${g.part}" is not a part`)
    if (g.keys.some((k, i) => i > 0 && k[0] < g.keys[i - 1]![0])) bad(`gestures.${name}`, 'gesture keys are not in time order')
    if (g.pose && !rig.poses?.[g.pose]) bad(`gestures.${name}`, `gesture uses pose "${g.pose}" which the rig does not have`)
  }

  const need = (label: string, have: Record<string, string | undefined>, names: readonly string[]) => {
    for (const n of names) if (!have[n]) bad(label, `missing ${label} "${n}" (a rig has all of: ${names.join(', ')})`)
  }
  need('face.mouth', rig.face.mouth.shapes, MOUTH_SHAPES)
  need('face.eyes', rig.face.eyes.states, EYE_STATES)
  need('face.brows', rig.face.brows.states, BROW_STATES)
  if (!rig.emotions.neutral) bad('emotions', 'missing emotion "neutral"')
  for (const [name, e] of Object.entries(rig.emotions)) {
    if (!rig.face.brows.states[e.brows]) bad(`emotions.${name}`, `emotion uses brows "${e.brows}" which the rig does not have`)
    if (!rig.face.eyes.states[e.eyes]) bad(`emotions.${name}`, `emotion uses eyes "${e.eyes}" which the rig does not have`)
  }

  const files: { where: string; src: string; face: boolean; pose?: boolean }[] = [
    ...rig.parts.map((x) => ({ where: x.id, src: x.src, face: false })),
    ...Object.entries(rig.face.eyes.states).map(([k, v]) => ({ where: `face.eyes.${k}`, src: v as string, face: true })),
    ...Object.entries(rig.face.brows.states).map(([k, v]) => ({ where: `face.brows.${k}`, src: v as string, face: true })),
    ...Object.entries(rig.face.mouth.shapes).map(([k, v]) => ({ where: `face.mouth.${k}`, src: v as string, face: true })),
    ...Object.entries(rig.poses ?? {}).map(([k, v]) => ({ where: `poses.${k}`, src: v.src, face: false, pose: true }))
  ]
  for (const f of files) {
    let abs: string
    try {
      abs = p.resolve(f.src, dir)
    } catch (e) {
      bad(f.where, (e as Error).message)
      continue
    }
    const st = await fs.stat(abs).catch(() => null)
    if (!st?.isFile()) {
      bad(f.where, `file ${f.src} is missing`)
      continue
    }
    if (/\.svg$/i.test(f.src)) {
      for (const problem of svgProblems(await fs.readFile(abs, 'utf8'), st.size)) bad(f.where, `${f.src}: ${problem}`)
    } else {
      if (rig.kind === 'vector' && !f.face && !f.pose) bad(f.where, `${f.src}: a vector rig has SVG parts`)
      try {
        const meta = await sharp(abs).metadata()
        if (meta.format !== 'png') bad(f.where, `${f.src}: not a PNG`)
        else if (!meta.hasAlpha) bad(f.where, `${f.src}: PNG part has no alpha channel`)
        else if (f.face && st.size > PNG_PLATE_MAX_BYTES) bad(f.where, `${f.src}: PNG face plate is ${Math.round(st.size / 1024)} KB (at most ${PNG_PLATE_MAX_BYTES / 1024} KB)`)
      } catch {
        bad(f.where, `${f.src}: not a readable PNG`)
      }
    }
  }
}

// ---- series and episode lint ----

/** Lints a series (its bible, cast rigs, sets) and, with `episode`, one episode (script, texts, voice, timelines). */
export async function lintSeries(store: SeriesStore, series: string, opts: LintOptions = {}): Promise<LintResult> {
  const issues = new Issues()
  const rigs: RigCheck[] = []
  const stats: LineStat[] = []
  const p = store.paths(series)
  const bible = await load(issues, 'bible.json', () => store.readBible(series))
  let ok = false
  if (bible) {
    ok = true
    let script: Episode | null = null
    if (opts.episode) {
      const rel = relTo(p, p.scriptFile(opts.episode))
      script = await load(issues, rel, () => store.readScript(series, opts.episode!))
    }
    const castIds = script ? script.cast : bible.cast.map((c) => c.id)
    const rigOf = new Map<string, Rig>()
    const charOf = new Map<string, Character3d>()
    const blender = bible.renderer === 'blender'
    if (blender) await lintStyle3d(issues, store, series, bible)
    for (const id of castIds) {
      if (!bible.cast.some((c) => c.id === id)) {
        issues.add('E_CAST_UNKNOWN', `cast id "${id}" is not in the bible`, { file: 'bible.json', where: id })
        continue
      }
      if (blender) {
        const spec = await lintCharacter3d(issues, store, series, bible, id)
        if (spec) charOf.set(id, spec)
        continue
      }
      const check = await checkRig(store, series, id)
      rigs.push(check)
      issues.list.push(...check.issues)
      const rig = check.parts ? await store.readRig(series, id).catch(() => null) : null
      if (rig) rigOf.set(id, rig)
    }
    const setIds = script ? [...new Set(script.scenes.map((s) => s.set))] : bible.sets.map((s) => s.id)
    const setOf = new Map<string, SetFile>()
    const set3dOf = new Map<string, Set3d>()
    for (const id of setIds) {
      if (blender) {
        const set = await lintSet3d(issues, store, series, bible, id)
        if (set) set3dOf.set(id, set)
        continue
      }
      const set = await lintSet(issues, store, series, bible, id)
      if (set) setOf.set(id, set)
    }
    if (script && opts.episode) await lintEpisode(issues, stats, store, series, opts, bible, script, rigOf, setOf, blender ? set3dOf : undefined, charOf)
  }
  const errors = issues.list.filter((i) => i.severity === 'error')
  const shares = stats.map((s) => s.share)
  return {
    series,
    ...(opts.episode ? { episode: opts.episode } : {}),
    ok: ok && errors.length === 0,
    errors,
    warnings: issues.list.filter((i) => i.severity === 'warning'),
    rigs,
    stats: { lines: stats, minShare: shares.length ? Math.min(...shares) : null }
  }
}

/** A Blender series: `style3d.json` (or the file the bible names) parses. */
async function lintStyle3d(issues: Issues, store: SeriesStore, series: string, bible: Bible): Promise<void> {
  const p = store.paths(series)
  let file: string
  try {
    file = p.style3dFile(bible.style3d)
  } catch (e) {
    issues.add('E_SCHEMA', (e as Error).message, { file: 'bible.json', where: 'style3d' })
    return
  }
  const rel = relTo(p, file)
  await load(issues, rel, () => store.readJson(file, style3dSchema))
}

/** A Blender series: the character spec of a cast member parses and is the character of that cast id. */
async function lintCharacter3d(issues: Issues, store: SeriesStore, series: string, bible: Bible, id: string): Promise<Character3d | null> {
  const p = store.paths(series)
  const member = bible.cast.find((c) => c.id === id)
  let file: string
  try {
    file = member?.character ? p.resolve(member.character) : p.characterFile(id)
  } catch (e) {
    issues.add('E_SCHEMA', (e as Error).message, { file: 'bible.json', where: id })
    return null
  }
  const rel = relTo(p, file)
  // E_VEHICLE_LIMB comes from the schema (its message starts with the code): report it by name, the other schema issues as E_SCHEMA
  const character = await load(issues, rel, async () => {
    try {
      return await store.readJson(file, character3dSchema)
    } catch (e) {
      if (!(e instanceof SeriesFileError) || e.kind !== 'schema' || !e.issues.some((i) => i.includes('E_VEHICLE_LIMB:'))) throw e
      for (const i of e.issues.filter((x) => x.includes('E_VEHICLE_LIMB:'))) issues.add('E_VEHICLE_LIMB', i.split('E_VEHICLE_LIMB: ')[1]!, { file: rel, where: i.split(':')[0] })
      const rest = e.issues.filter((x) => !x.includes('E_VEHICLE_LIMB:'))
      if (rest.length) throw new SeriesFileError(e.file, 'schema', rest)
      return null
    }
  })
  if (character && character.id !== id) issues.add('E_SCHEMA', `character id "${character.id}" is not the cast id "${id}"`, { file: rel, where: 'id' })
  return character
}

/** A Blender series: the set spec (`set3d.json`) parses, prop ids are unique, marks and props are not named twice. */
async function lintSet3d(issues: Issues, store: SeriesStore, series: string, bible: Bible, id: string): Promise<Set3d | null> {
  const p = store.paths(series)
  if (!bible.sets.some((s) => s.id === id)) {
    issues.add('E_SET_UNKNOWN', `set "${id}" is not in the bible`, { file: 'bible.json', where: id })
    return null
  }
  const rel = relTo(p, p.set3dFile(id))
  const set = await load(issues, rel, () => store.readSet3d(series, id), 'E_SET_UNKNOWN')
  if (!set) return null
  const seen = new Set<string>()
  for (const prop of set.props) {
    if (seen.has(prop.id)) issues.add('E_SCHEMA', `prop id "${prop.id}" appears twice`, { file: rel, where: prop.id })
    seen.add(prop.id)
  }
  if (set.id !== id) issues.add('E_SCHEMA', `set id "${set.id}" is not "${id}"`, { file: rel, where: 'id' })
  // a mark inside a prop's footprint puts an actor into a tree or a bench
  for (const [name, m] of Object.entries(set.marks)) {
    for (const prop of set.props) {
      let r: number
      try {
        r = propFootprint(prop.kind, prop.scale ?? 1)
      } catch {
        continue
      }
      const d = Math.hypot(m[0] - prop.at[0], m[1] - prop.at[1])
      if (r > 0 && d < r) issues.add('E_MARK_BLOCKED', `mark "${name}" is inside the footprint of prop "${prop.id}" (${prop.kind}, radius ${r.toFixed(2)} m, ${d.toFixed(2)} m away): an actor would stand in it`, { file: rel, where: name })
    }
  }
  // a road or a track that runs through a tree or a house
  for (const b of blockedPaths(set))
    issues.add('E_PATH_BLOCKED', `path "${b.path}" runs through the footprint of prop "${b.prop}" (${b.kind}): its centre line passes ${b.distance.toFixed(2)} m from the prop and needs ${b.clear.toFixed(2)} m (the footprint plus half the path width)`, { file: rel, where: `paths.${b.path}` })
  return set
}

/** The camera names a Blender script may use in a set: the set's own cameras and the computed shots (`wide`, `two`, `cu-<id>`, `ots-<a>-<b>`). */
export function shotNames3d(set: Set3d, cast: readonly string[]): Set<string> {
  const names = new Set<string>(['wide', 'two', ...Object.keys(set.cameras)])
  for (const a of cast) {
    names.add(`cu-${a}`)
    for (const b of cast) if (a !== b) names.add(`ots-${a}-${b}`)
  }
  return names
}

async function lintSet(issues: Issues, store: SeriesStore, series: string, bible: Bible, id: string): Promise<SetFile | null> {
  const p = store.paths(series)
  const listed = bible.sets.find((s) => s.id === id)
  if (!listed) {
    issues.add('E_SET_UNKNOWN', `set "${id}" is not in the bible`, { file: 'bible.json', where: id })
    return null
  }
  const rel = relTo(p, p.setFile(id))
  const set = await load(issues, rel, () => store.readSet(series, id), 'E_SET_UNKNOWN')
  if (!set) return null
  for (const layer of set.layers) {
    let abs: string
    try {
      abs = p.resolve(layer.src, p.setDir(id))
    } catch (e) {
      issues.add('E_SET_UNKNOWN', (e as Error).message, { file: rel, where: layer.id })
      continue
    }
    if (!(await exists(abs))) issues.add('E_SET_UNKNOWN', `set layer file ${layer.src} is missing`, { file: rel, where: layer.id })
  }
  return set
}

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length

async function lintEpisode(
  issues: Issues,
  stats: LineStat[],
  store: SeriesStore,
  series: string,
  opts: LintOptions,
  bible: Bible,
  script: Episode,
  rigOf: Map<string, Rig>,
  setOf: Map<string, SetFile>,
  /** Blender series (`renderer: "blender"`): the 3D sets by id. Absent for a canvas series. */
  set3dOf?: Map<string, Set3d>,
  /** Blender series: the character specs that parsed, by cast id (the body kind decides E_ACTION_BODY and the path checks). */
  charOf: Map<string, Character3d> = new Map()
): Promise<void> {
  const ep = opts.episode!
  const b3d = !!set3dOf
  let library: ActingLibrary | null = null
  if (b3d) {
    try {
      library = loadActingLibrary()
    } catch (e) {
      issues.add('E_SCHEMA', `the acting library could not be read: ${(e as Error).message}`, { where: 'blender/cts_blender/acting/library.json' })
    }
  }
  const p = store.paths(series)
  const scriptRel = relTo(p, p.scriptFile(ep))
  const inScript = new Set(script.cast)
  const inBible = new Set(bible.cast.map((c) => c.id))
  const checkActor = (id: string, where: string) => {
    if (!inScript.has(id) || !inBible.has(id)) issues.add('E_CAST_UNKNOWN', `"${id}" is not in this episode's cast`, { file: scriptRel, where })
  }

  const lines: { id: string; speaker: string }[] = []
  const clipBeats: { id: string; where: string }[] = []
  const titleKeys = new Set<string>([script.titleKey])
  for (const scene of script.scenes) {
    const set = setOf.get(scene.set)
    const set3d = set3dOf?.get(scene.set)
    const sceneWhere = `scenes.${scene.id}`
    if (!set && !bible.sets.some((s) => s.id === scene.set)) issues.add('E_SET_UNKNOWN', `scene "${scene.id}" uses set "${scene.set}" which is not in the bible`, { file: scriptRel, where: sceneWhere })
    const mark = (name: string, where: string) => {
      if (set && !set.marks[name]) issues.add('E_MARK_UNKNOWN', `mark "${name}" is not in set "${scene.set}" (${Object.keys(set.marks).join(', ')})`, { file: scriptRel, where })
      if (set3d && !set3d.marks[name]) issues.add('E_MARK_UNKNOWN', `mark "${name}" is not in set "${scene.set}" (${Object.keys(set3d.marks).join(', ')})`, { file: scriptRel, where })
    }
    const shot = (name: string, where: string) => {
      if (set && !set.shots[name]) issues.add('E_SHOT_UNKNOWN', `shot "${name}" is not in set "${scene.set}" (${Object.keys(set.shots).join(', ')})`, { file: scriptRel, where })
      if (set3d) {
        const names = shotNames3d(set3d, script.cast)
        if (!names.has(name)) issues.add('E_SHOT_UNKNOWN', `shot "${name}" is not a camera of set "${scene.set}" or a computed shot (${[...names].join(', ')})`, { file: scriptRel, where })
      }
    }
    /** A gesture name: the actor's rig (canvas) or the acting library (Blender). Returns the library action when there is one. */
    const gesture = (actor: string, name: string, where: string) => {
      if (b3d) {
        const action = library?.byName.get(name)
        if (library && !library.scriptable.has(name)) {
          issues.add('E_ACTION_UNKNOWN', `action "${name}" is not a gesture of the acting library (${[...library.scriptable].join(', ')})`, { file: scriptRel, where })
          return undefined
        }
        body(actor, action?.name, where)
        return action
      }
      const rig = rigOf.get(actor)
      if (rig && !rig.gestures[name]) issues.add('E_GESTURE_UNKNOWN', `gesture "${name}" is not in the rig of "${actor}" (${Object.keys(rig.gestures).join(', ')})`, { file: scriptRel, where })
      return undefined
    }
    /** The target of a gesture (Blender): a cast id of the episode, a prop of the set or a mark; `sit` needs a prop with a seat. */
    const target = (name: string, target: string | undefined, where: string) => {
      const action = library?.byName.get(name)
      if (!action || !set3d) return
      if (!target) {
        if (action.needsTarget) issues.add('E_SCHEMA', `"${name}" needs a target (a cast id, a prop or a mark)`, { file: scriptRel, where })
        return
      }
      const prop = set3d.props.find((x) => x.id === target)
      if (!script.cast.includes(target) && !prop && !set3d.marks[target]) issues.add('E_MARK_UNKNOWN', `target "${target}" is not a cast id, a prop or a mark of set "${scene.set}"`, { file: scriptRel, where })
      else if (name === 'sit' && !prop?.seat) issues.add('E_MARK_UNKNOWN', `"sit" needs a prop with a seat; "${target}" has none`, { file: scriptRel, where })
    }
    /** E_ACTION_BODY: an action this cast member's body (a creature, a car, a train) cannot do. */
    const body = (actor: string, name: string | undefined, where: string) => {
      const action = name ? library?.byName.get(name) : undefined
      const spec = charOf.get(actor)
      if (!action || !spec) return
      const why = bodyCannot(action, bodyOf(spec))
      if (why) issues.add('E_ACTION_BODY', `"${actor}" cannot do it: ${why}`, { file: scriptRel, where })
    }
    /** A vehicle move: both marks lie on a path of its kind (E_MARK_OFF_PATH, once per mark), and a train's two marks on one track path (E_OFF_TRACK). */
    const offPath = new Set<string>()
    const pathMove = (who: string, spec: VehicleCharacter3d, from: string | undefined, to: string, where: string) => {
      if (!set3d) return
      const kind: PathKind = spec.vehicle.track ? 'track' : 'road'
      const near = (m: string | undefined) => {
        const p = m ? set3d.marks[m] : undefined
        return p ? pathsAt(set3d, p, kind) : null
      }
      for (const m of [from, to]) {
        const p = m ? set3d.marks[m] : undefined
        if (!m || !p || offPath.has(`${m}:${kind}`) || near(m)!.length) continue
        offPath.add(`${m}:${kind}`)
        const all = Object.values(set3d.paths ?? {}).filter((x) => x.kind === kind)
        const d = all.length ? Math.min(...all.map((x) => distanceToPath(p, x))) : null
        const why = d === null ? `set "${scene.set}" has no ${kind} path` : `it is ${d.toFixed(2)} m from the nearest ${kind} path (at most ${PATH_MARK_TOLERANCE} m)`
        issues.add('E_MARK_OFF_PATH', `mark "${m}", used by a move of the ${spec.vehicle.type} "${who}", is not on a ${kind}: ${why}`, { file: scriptRel, where })
      }
      if (kind !== 'track') return
      const a = near(from)
      const b = near(to)
      if (a && b && !a.some((id) => b.includes(id)))
        issues.add('E_OFF_TRACK', `the train "${who}" moves from "${from}" to "${to}", which are not on one track path (${a.join(', ') || 'no track'} / ${b.join(', ') || 'no track'})`, { file: scriptRel, where })
    }
    /** Where each actor stands in this scene (its start mark, then the target of its last move). */
    const at = new Map<string, string>(Object.entries(scene.start).map(([id, s]) => [id, s.mark]))
    // beats that run together (a beat without `with: "prev"` starts a group): who speaks, and which gestures may not overlap a line
    let groupSpeakers: string[] = []
    let groupGestures: { who: string; name: string; where: string }[] = []
    const overLine = (who: string, name: string, where: string) => {
      const action = library?.byName.get(name)
      if (action && !action.overLine) issues.add('W_GESTURE_OVER_LINE', `"${name}" of "${who}" runs while "${who}" speaks, and the acting library says it should not`, { file: scriptRel, where })
    }
    for (const [actor, s] of Object.entries(scene.start)) {
      checkActor(actor, `${sceneWhere}.start.${actor}`)
      mark(s.mark, `${sceneWhere}.start.${actor}`)
    }
    shot(scene.shot, sceneWhere)
    let prev: (typeof scene.beats)[number] | undefined
    for (const b of scene.beats) {
      const where = `${sceneWhere}.${b.id}`
      if (b.with !== 'prev') {
        groupSpeakers = []
        groupGestures = []
      }
      switch (b.type) {
        case 'line':
          lines.push({ id: b.line, speaker: b.speaker })
          checkActor(b.speaker, where)
          if (b.look) checkActor(b.look, where)
          if (b.gesture) {
            gesture(b.speaker, b.gesture, where)
            overLine(b.speaker, b.gesture, where)
          }
          for (const g of groupGestures) if (g.who === b.speaker) overLine(g.who, g.name, g.where)
          groupSpeakers.push(b.speaker)
          break
        case 'move': {
          checkActor(b.who, where)
          mark(b.to, where)
          const spec = charOf.get(b.who)
          if (b3d) body(b.who, moveAction(b.style, spec ?? null), where)
          if (spec && isVehicle(spec)) pathMove(b.who, spec, at.get(b.who), b.to, where)
          at.set(b.who, b.to)
          break
        }
        case 'turn':
          checkActor(b.who, where)
          if (b3d) body(b.who, 'turn', where)
          break
        case 'emote':
          checkActor(b.who, where)
          break
        case 'gesture':
          checkActor(b.who, where)
          gesture(b.who, b.gesture, where)
          target(b.gesture, b.target, where)
          if (groupSpeakers.includes(b.who)) overLine(b.who, b.gesture, where)
          groupGestures.push({ who: b.who, name: b.gesture, where })
          break
        case 'look':
          checkActor(b.who, where)
          checkActor(b.target, where)
          break
        case 'camera':
          shot(b.shot, where)
          break
        case 'title':
          titleKeys.add(b.key)
          break
        case 'clip':
          clipBeats.push({ id: b.clip, where })
          if (b.with === 'prev') issues.add('E_SCHEMA', 'a clip beat cannot run with "prev"', { file: scriptRel, where })
          break
        default:
          break
      }
      if (prev?.type === 'clip' && b.with === 'prev') issues.add('E_SCHEMA', 'no beat runs with "prev" over a clip', { file: scriptRel, where })
      prev = b
    }
  }

  const langs = bible.languages
  const texts = new Map<Lang, TextCatalog>()
  const manifests = new Map<Lang, VoiceManifest>()
  const timelines = new Map<Lang, Timeline | Timeline3d>()
  const hash = hashScript(await fs.readFile(p.scriptFile(ep)))

  for (const lang of langs) {
    const textRel = relTo(p, p.textFile(ep, lang))
    if (await exists(p.textFile(ep, lang))) {
      const t = await load(issues, textRel, () => store.readText(series, ep, lang), 'E_SCHEMA', lang)
      if (t) texts.set(lang, t)
    }
    const text = texts.get(lang)
    for (const l of lines) {
      const entry = text?.lines[l.id]
      if (!entry) issues.add('E_LINE_NO_TEXT', `line "${l.id}" has no ${lang} text${text ? '' : ` (${textRel} not found)`}`, { file: textRel, where: l.id, lang })
      else if (wordCount(entry.text) > MAX_LINE_WORDS) issues.add('W_LINE_LONG', `line "${l.id}" (${lang}) has ${wordCount(entry.text)} words (over ${MAX_LINE_WORDS})`, { file: textRel, where: l.id, lang })
    }
    for (const key of titleKeys) {
      if (text && !(key in text.strings)) issues.add('E_LINE_NO_TEXT', `string "${key}" is missing in ${lang}`, { file: textRel, where: key, lang })
    }

    const manifestFile = p.voiceManifest(ep, lang)
    const manifestRel = relTo(p, manifestFile)
    if (await exists(manifestFile)) {
      const m = await load(issues, manifestRel, () => store.readVoiceManifest(series, ep, lang), 'E_SCHEMA', lang)
      if (m) manifests.set(lang, m)
    }
    const m = manifests.get(lang)
    if (m) {
      for (const l of lines) {
        const e = m.lines[l.id]
        if (!e || e.status === 'failed') {
          issues.add('E_LINE_NO_AUDIO', `line "${l.id}" has no ${lang} audio${e ? ' (status failed)' : ''}`, { file: manifestRel, where: l.id, lang })
          continue
        }
        let abs: string
        try {
          abs = p.resolve(e.file, p.episodeDir(ep))
        } catch (err) {
          issues.add('E_LINE_NO_AUDIO', (err as Error).message, { file: manifestRel, where: l.id, lang })
          continue
        }
        if (!(await exists(abs))) issues.add('E_LINE_NO_AUDIO', `${lang} audio file ${e.file} for line "${l.id}" is missing`, { file: manifestRel, where: l.id, lang })
        if (e.status === 'placeholder') issues.add('W_PLACEHOLDER', `line "${l.id}" (${lang}) is a silent placeholder`, { file: manifestRel, where: l.id, lang })
        if (e.seconds > MAX_LINE_SECONDS) issues.add('W_LINE_LONG', `line "${l.id}" (${lang}) lasts ${e.seconds.toFixed(1)} s (over ${MAX_LINE_SECONDS} s)`, { file: manifestRel, where: l.id, lang })
      }
    } else if (opts.requireAudio) {
      for (const l of lines) issues.add('E_LINE_NO_AUDIO', `line "${l.id}" has no ${lang} audio (no voice manifest)`, { file: manifestRel, where: l.id, lang })
    }

    const tlFile = p.timelineFile(ep, lang)
    const tlRel = relTo(p, tlFile)
    if (await exists(tlFile)) {
      const tl = await load<Timeline | Timeline3d>(issues, tlRel, () => (b3d ? store.readTimeline3d(series, ep, lang) : store.readTimeline(series, ep, lang)), 'E_SCHEMA', lang)
      if (tl) timelines.set(lang, tl)
    }
    const tl = timelines.get(lang)
    if (tl) {
      if (tl.scriptHash !== hash) issues.add('E_TIMELINE_STALE', `timeline.${lang}.json was built from another script.json (rebuild it)`, { file: tlRel, lang })
      // the mouth and framing checks read the canvas timeline; the 3D ones come with the viseme lint (CTS-24)
      if (!b3d) {
        lintMouth(issues, tl as Timeline, tlRel, lang)
        lintOffFrame(issues, tl as Timeline, tlRel, lang, setOf)
      }
      if (b3d) {
        lintMouth3d(issues, tl as Timeline3d, tlRel, lang)
        await lintVisemes(issues, store, series, ep, lang, lines, texts.get(lang), manifests.get(lang))
      }
      await lintMix(issues, p, ep, lang, store.dataDir)
    }
    stats.push(...(await lineStats(store, series, ep, lang, b3d ? null : ((tl as Timeline | undefined) ?? null), lines)))
  }

  // the languages share one script: same beat order, similar length
  const tlList = langs.map((l) => [l, timelines.get(l)] as const).filter((x): x is readonly [Lang, Timeline | Timeline3d] => !!x[1])
  const base = tlList[0]
  for (const [lang, tl] of tlList.slice(1)) {
    const a = sequenceOf(base![1])
    const b = sequenceOf(tl)
    if (a.join(',') !== b.join(',')) issues.add('E_LANG_ORDER', `the ${base![0]} and ${lang} timelines run different beat sequences`, { file: relTo(p, p.timelineFile(ep, lang)), lang })
    const longer = Math.max(base![1].duration, tl.duration)
    if (longer > 0 && Math.abs(base![1].duration - tl.duration) / longer > LANG_DRIFT)
      issues.add('W_LANG_DRIFT', `durations differ by more than ${LANG_DRIFT * 100} %: ${base![0]} ${base![1].duration.toFixed(1)} s, ${lang} ${tl.duration.toFixed(1)} s`, { lang })
  }

  // clips: a file in the episode's clips/, else in the series' clips/, unless the clip is marked fallback
  const fallbackIn = async (rels: string[]) => {
    const ids = new Set<string>()
    for (const rel of rels) {
      const f = rel === 'series' ? p.clipsFile : p.episodeClipsFile(ep)
      if (await exists(f)) {
        const c = await load(issues, relTo(p, f), () => store.readClips(series, rel === 'series' ? undefined : ep))
        for (const e of c?.clips ?? []) if (e.fallback) ids.add(e.id)
      }
    }
    return ids
  }
  const fallbacks = await fallbackIn(['episode', 'series'])
  for (const { id, where } of clipBeats) {
    const found = (await exists(`${p.episodeClipsDir(ep)}/${id}.mp4`)) || (await exists(`${p.clipsDir}/${id}.mp4`))
    const inTimelines = tlList.length > 0 && tlList.every(([, tl]) => tl.clips.some((c) => c.id === id && c.fallback))
    if (!found && !fallbacks.has(id) && !inTimelines) issues.add('E_CLIP_MISSING', `clip "${id}" is in neither episodes/${ep}/clips nor clips (and is not marked fallback)`, { file: scriptRel, where })
  }
}

/** The order the beats ran in; when a timeline has no `beats`, the lines then the clips. */
function sequenceOf(tl: Timeline | Timeline3d): string[] {
  return tl.beats ? tl.beats.map((b) => b.id) : [...tl.lines.map((l) => `line:${l.id}`), ...tl.clips.map((c) => `clip:${c.id}`)]
}

/** W_MIX_MUSIC_LOUD: the mix check of the last final render (render/<lang>/mix-check.json) has the music closer to the voice than `mix.minUnderVoiceDb`. */
async function lintMix(issues: Issues, p: SeriesPaths, ep: string, lang: Lang, dataDir: string): Promise<void> {
  const file = path.join(p.episodeDir(ep), 'render', lang, 'mix-check.json')
  const check = await readMixCheck(file)
  if (!check || check.minUnderDb === null) return
  const { mix } = await loadRenderConfig(dataDir)
  if (check.minUnderDb < mix.minUnderVoiceDb) {
    const worst = [...check.lines].filter((l) => l.underDb !== null).sort((a, b) => a.underDb! - b.underDb!)[0]
    issues.add('W_MIX_MUSIC_LOUD', `the music is only ${check.minUnderDb} dB under the voice at its loudest line${worst ? ` ("${worst.id}")` : ''} (floor ${mix.minUnderVoiceDb} dB); lower the music gain or the mix levels in config/render.md`, { file: relTo(p, file), ...(worst ? { where: worst.id } : {}), lang })
  }
}

/** E_MOUTH_SILENT: the mouth of an actor is not `rest` outside every line interval of that actor. */
function lintMouth(issues: Issues, tl: Timeline, file: string, lang: Lang): void {
  const tol = 1 / tl.fps.anim
  for (const [actor, track] of Object.entries(tl.actors)) {
    const own = tl.lines.filter((l) => l.speaker === actor).map((l) => [l.t0 - tol, l.t1 + tol] as const)
    for (let i = 0; i < track.mouth.length; i++) {
      const [t0, shape] = track.mouth[i]!
      if (shape === 'rest') continue
      const t1 = track.mouth[i + 1]?.[0] ?? tl.duration
      if (!own.some(([a, b]) => t0 >= a - 1e-6 && t1 <= b + 1e-6)) {
        issues.add('E_MOUTH_SILENT', `"${actor}" has the mouth "${shape}" from ${t0.toFixed(2)} s to ${t1.toFixed(2)} s outside any of its lines`, { file, where: actor, lang })
        break
      }
    }
  }
}

/** E_MOUTH_SILENT (Blender series): the mouth of an actor is `rest` outside every line interval of that actor (the same rule as the canvas timeline, at 24 fps). */
function lintMouth3d(issues: Issues, tl: Timeline3d, file: string, lang: Lang): void {
  const tol = 1 / tl.fps
  for (const [actor, track] of Object.entries(tl.actors)) {
    const own = tl.lines.filter((l) => l.speaker === actor).map((l) => [l.t0 - tol, l.t1 + tol] as const)
    for (let i = 0; i < track.mouth.length; i++) {
      const [t0, shape] = track.mouth[i]!
      if (shape === 'rest') continue
      const t1 = track.mouth[i + 1]?.[0] ?? tl.duration
      if (!own.some(([a, b]) => t0 >= a - 1e-6 && t1 <= b + 1e-6)) {
        issues.add('E_MOUTH_SILENT', `"${actor}" has the mouth "${shape}" from ${t0.toFixed(2)} s to ${t1.toFixed(2)} s outside any of its lines`, { file, where: actor, lang })
        break
      }
    }
  }
}

/** Blender series: every spoken line has a six-viseme lip-sync file with a moving mouth (E_MOUTH_SILENT) that is not flat (W_VISEME_FLAT). */
const MIN_NON_REST = 0.6
const MIN_DISTINCT_VISEMES = 3
async function lintVisemes(issues: Issues, store: SeriesStore, series: string, ep: string, lang: Lang, lines: { id: string }[], text?: TextCatalog, manifest?: VoiceManifest): Promise<void> {
  const p = store.paths(series)
  const seen = new Set<string>()
  for (const l of lines) {
    if (seen.has(l.id)) continue
    seen.add(l.id)
    if (manifest?.lines[l.id]?.status !== 'ok') continue // missing and placeholder audio have their own codes
    const file = relTo(p, p.lipsyncFile(ep, lang, l.id))
    const track = await store.readLipsync(series, ep, lang, l.id).catch(() => null)
    const at = { file, where: l.id, lang }
    if (!track) {
      issues.add('E_MOUTH_SILENT', `line "${l.id}" (${lang}) has no lip-sync file: the mouth would stay shut`, at)
      continue
    }
    if (track.method === 'amplitude') {
      issues.add('E_MOUTH_SILENT', `line "${l.id}" (${lang}) has an amplitude lip-sync (canvas); a Blender series needs the six-viseme method (words-${lang} or text-${lang})`, at)
      continue
    }
    const moving = track.shapes.filter((s) => s !== 'rest')
    if (moving.length === 0) {
      issues.add('E_MOUTH_SILENT', `line "${l.id}" (${lang}) has only rest frames in its lip-sync`, at)
      continue
    }
    const stray = [...new Set(track.shapes.filter((s) => !SIX_VISEMES.includes(s)))]
    if (stray.length) issues.add('E_MOUTH_SILENT', `line "${l.id}" (${lang}) uses mouth shapes the six-viseme set does not have: ${stray.join(', ')}`, at)
    const said = text?.lines[l.id]?.text
    if (said && textHasLabial(said, lang) && !track.shapes.includes('MBP')) issues.add('E_MOUTH_SILENT', `line "${l.id}" (${lang}) has a lip sound ("${said}") but no MBP closure in its lip-sync`, at)
    const share = moving.length / track.shapes.length
    const distinct = new Set(moving).size
    if (share < MIN_NON_REST) issues.add('W_VISEME_FLAT', `line "${l.id}" (${lang}) has the mouth open in only ${Math.round(share * 100)} % of its frames (under ${MIN_NON_REST * 100} %)`, at)
    if (distinct < MIN_DISTINCT_VISEMES) issues.add('W_VISEME_FLAT', `line "${l.id}" (${lang}) uses only ${distinct} distinct mouth shape(s) (under ${MIN_DISTINCT_VISEMES})`, at)
  }
}

/** W_OFF_FRAME: the feet point of a speaking actor lies outside the camera rectangle while the line runs. */
function lintOffFrame(issues: Issues, tl: Timeline, file: string, lang: Lang, setOf: Map<string, SetFile>): void {
  const aspect = tl.size[0] / tl.size[1]
  for (const line of tl.lines) {
    const actor = tl.actors[line.speaker]
    if (!actor) continue
    const steps = Math.max(1, Math.ceil((line.t1 - line.t0) / 0.25))
    for (let i = 0; i <= steps; i++) {
      const t = line.t0 + ((line.t1 - line.t0) * i) / steps
      if (sampleStep(actor.visible, t) === false) continue
      const scene = tl.scenes.find((s) => t >= s.t0 && t < s.t1) ?? tl.scenes[tl.scenes.length - 1]
      const set = scene ? setOf.get(scene.set) : undefined
      if (!set) break
      const cam = sampleCamera(tl.camera, t)
      const h = set.size[1] / cam.zoom
      const w = h * aspect
      const x = sampleNumber(actor.x, t, tl.fps.anim)
      const y = sampleNumber(actor.y, t, tl.fps.anim)
      if (x < cam.center[0] - w / 2 || x > cam.center[0] + w / 2 || y < cam.center[1] - h / 2 || y > cam.center[1] + h / 2) {
        issues.add('W_OFF_FRAME', `"${line.speaker}" speaks line "${line.id}" with the feet point (${Math.round(x)}, ${Math.round(y)}) outside the camera at ${t.toFixed(2)} s`, { file, where: line.id, lang })
        break
      }
    }
  }
}

/** Per line and language: the share of animation frames whose mouth is not `rest`. From the timeline; else from the lipsync tracks. */
async function lineStats(store: SeriesStore, series: string, ep: string, lang: Lang, tl: Timeline | null, lines: { id: string; speaker: string }[]): Promise<LineStat[]> {
  const out: LineStat[] = []
  const seen = new Set<string>()
  for (const l of lines) {
    if (seen.has(l.id)) continue
    seen.add(l.id)
    let frames: number
    let nonRest = 0
    const tlLine = tl?.lines.find((x) => x.id === l.id)
    const actor = tl?.actors[l.speaker]
    if (tl && tlLine && actor) {
      frames = Math.max(0, Math.round((tlLine.t1 - tlLine.t0) * tl.fps.anim))
      for (let f = 0; f < frames; f++) {
        const t = tlLine.t0 + f / tl.fps.anim + 1e-6
        if (sampleStep(actor.mouth, t) !== 'rest') nonRest++
      }
    } else {
      const ls = await store.readLipsync(series, ep, lang, l.id).catch(() => null)
      if (!ls) continue
      frames = ls.shapes.length
      nonRest = ls.shapes.filter((s) => s !== 'rest').length
    }
    out.push({ lang, line: l.id, speaker: l.speaker, frames, nonRest, share: frames ? nonRest / frames : 0 })
  }
  return out
}

