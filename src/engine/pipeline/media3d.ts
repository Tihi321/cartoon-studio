import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { z } from 'zod'
import type { Bible, Character3d, Set3d } from '../../shared/contracts'
import { assembleScene, buildCharacter, buildSet, sha1 } from '../blender/jobs'
import type { BuildResult } from '../blender/jobs'
import { EMOTIONS_3D, loadActingLibrary } from '../blender/library'
import type { ActingLibrary } from '../blender/library'
import { findSeedDir } from '../store/dataFolder'
import { shotNames3d } from '../series/lint'
import { castView, ask, relTo, requireChosen } from './env'
import type { Env } from './env'
import { loadStyle3dGuide } from './tasks'
import type { characterSpecAnswer, reviewAnswer } from './tasks'

/**
 * The steps of a `blender` series that the canvas pipeline does not have (CTS-27): `character` (the designer writes a spec, Blender builds it, the designer
 * reads `sheet.png` and revises at most twice), `set3d` (the same for a set), `assemble` (one scene per language), and the facts the writer, the clip shots and
 * the script checks need from the acting library and the 3D sets. Nothing here draws a picture with an image model: a character or a set is data.
 */

/** The designer may revise a spec this many times after the first build (a build error counts as a revision). */
export const MAX_REVISIONS = 2

const readJson = async (file: string): Promise<Record<string, unknown> | null> => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}
const exists = (file: string): Promise<boolean> => fs.stat(file).then((s) => s.isFile(), () => false)

/** Writes `style3d.json` from the seed's default look when the series has none yet; returns whether it wrote it. */
export async function ensureStyle3d(e: Pick<Env, 'store' | 'series' | 'svc'>): Promise<boolean> {
  const bible = await e.store.readBible(e.series)
  const file = e.store.paths(e.series).style3dFile(bible.style3d)
  if (await e.store.exists(file)) return false
  for (const root of [e.svc.dataDir, findSeedDir()]) {
    if (!root) continue
    try {
      const raw = await fs.readFile(path.join(root, 'style', 'style3d.json'), 'utf8')
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, raw.endsWith('\n') ? raw : `${raw}\n`)
      return true
    } catch {
      /* try the seed folder */
    }
  }
  await fs.writeFile(file, `${JSON.stringify({ schema: 'cts.style3d/1' }, null, 2)}\n`)
  return true
}

/** The spec of every other character that has one (id, height, palette, motion): the designer makes this one differ. */
async function otherSpecs(e: Env, bible: Bible, except: string): Promise<unknown[]> {
  const out: unknown[] = []
  for (const c of bible.cast) {
    if (c.id === except) continue
    const spec = await readJson(e.store.paths(e.series).characterFile(c.id))
    if (spec) out.push({ id: spec.id, height: spec.height, palette: spec.palette, motion: spec.motion })
  }
  return out
}

interface Asset {
  kind: 'character' | 'set'
  id: string
  /** `cast/<id>` or `sets/<id>`, relative to the series folder. */
  dir: string
  specFile: string
  /** The role, and the guide kinds of the spec task and the review task. */
  role: 'character-designer' | 'background-artist'
  specKind: 'character-spec' | 'set-spec'
  reviewKind: 'character-review' | 'set-review'
}

type SpecAnswer = { spec: Character3d | Set3d; notes: string }

/**
 * One character or set: build the spec that is there (or have the designer write one), build it in Blender, let the designer read `sheet.png`, and
 * revise at most `MAX_REVISIONS` times. A build error (E_FACE_HIDDEN, E_SET_INVALID) goes back to the designer like a review problem. Returns a short note.
 */
async function designAsset(e: Env, bible: Bible, a: Asset, o: { redo: boolean; userNote?: string; context: () => Promise<Record<string, unknown>> }): Promise<string> {
  const p = e.store.paths(e.series)
  const dir = a.kind === 'character' ? p.castDir(a.id) : p.setDir(a.id)
  const buildFile = path.join(dir, 'build.json')
  const sheetFile = path.join(dir, 'sheet.png')
  const hasSpec = await e.store.exists(a.specFile)
  const hash = hasSpec ? sha1(await fs.readFile(a.specFile)) : null
  const built = await readJson(buildFile)
  if (hasSpec && !o.redo && built?.specHash === hash && (await exists(sheetFile))) return `${a.id}: kept (spec ${hash!.slice(0, 8)}, built in ${built.buildSeconds ?? '?'} s)`

  const guide = await loadStyle3dGuide(e.svc.dataDir)
  let useExisting = hasSpec && !o.redo
  let previous: unknown = hasSpec ? await readJson(a.specFile) : null
  let feedback: Record<string, unknown> = {}
  let revisions = 0
  let verdict: string | undefined
  let result: Extract<BuildResult, { ok: true }> | undefined
  for (let round = 0; ; round++) {
    let spec: Character3d | Set3d
    if (useExisting) {
      useExisting = false
      spec = (a.kind === 'character' ? await e.store.readCharacter3d(e.series, a.id) : await e.store.readSet3d(e.series, a.id)) as Character3d | Set3d
    } else {
      e.progress(null, `${a.id}: the designer writes the ${a.kind} spec (round ${round + 1})`)
      const r = await ask<SpecAnswer>(
        e,
        {
          id: `${a.specKind}-${a.id}-${round + 1}`,
          role: a.role,
          kind: a.specKind,
          prompt:
            a.kind === 'character'
              ? `Design the 3D character "${a.id}" as a cts.character3d/1 spec (round ${round + 1}).${o.userNote ? ` The user looked at the last sheet and asked: ${o.userNote}` : ''}`
              : `Design the 3D set "${a.id}" as a cts.set3d/1 spec (round ${round + 1}).`,
          inputs: { paths: [], json: { ...(await o.context()), previousSpec: previous, ...feedback, ...(o.userNote ? { userNote: o.userNote } : {}), revision: revisions, maxRevisions: MAX_REVISIONS } },
          output: { schema: a.specKind, path: `tasks/${a.specKind}-${a.id}-${round + 1}.json` }
        },
        {
          system: guide,
          maxTokens: 16000,
          check: (v) => ((v as z.infer<typeof characterSpecAnswer>).spec.id !== a.id ? [`spec.id must be "${a.id}"`] : [])
        }
      )
      spec = r.value.spec
      if (a.kind === 'character') await e.store.writeCharacter3d(e.series, a.id, spec)
      else await e.store.writeSet3d(e.series, a.id, spec)
      const fresh = await e.store.readBible(e.series)
      if (a.kind === 'character' && fresh.cast.some((c) => c.id === a.id && c.character !== `cast/${a.id}/character.json`)) {
        await e.store.writeBible(e.series, { ...fresh, cast: fresh.cast.map((c) => (c.id === a.id ? { ...c, character: `cast/${a.id}/character.json` } : c)) })
      }
    }
    e.progress(null, `${a.id}: Blender builds the ${a.kind}`)
    const build = await (a.kind === 'character' ? buildCharacter : buildSet)({
      dataDir: e.svc.dataDir,
      series: e.series,
      id: a.id,
      signal: e.ctx.signal,
      onLog: (l) => e.log(l),
      onProgress: (fraction, message) => e.progress(fraction, `${a.id}: ${message ?? 'building'}`)
    })
    if (!build.ok) {
      if (revisions >= MAX_REVISIONS) throw new Error(`${a.kind} ${a.id}: the spec could not be built after ${MAX_REVISIONS} revisions: ${build.code} ${build.message}`)
      revisions++
      previous = spec
      feedback = { buildError: { code: build.code, message: build.message } }
      e.log(`${a.kind} ${a.id}: ${build.code}: ${build.message}; the designer revises (${revisions}/${MAX_REVISIONS})`)
      continue
    }
    result = build
    for (const w of build.warnings) e.log(`warning: ${a.id}: ${w}`)
    if (!build.sheet) {
      verdict = 'no sheet'
      break
    }
    e.progress(null, `${a.id}: the designer reads the sheet`)
    const review = await ask<z.infer<typeof reviewAnswer>>(e, {
      id: `${a.reviewKind}-${a.id}-${round + 1}`,
      role: a.role,
      kind: a.reviewKind,
      prompt:
        a.kind === 'character'
          ? `Read the sheet of "${a.id}" (picture 1: turnaround, six mouths, blink, half lid, emotions, looks) against your spec and the series look. Pass it, or list what to change.`
          : `Read the sheet of the set "${a.id}" (picture 1: wide view, two stand-ins on the first marks, the first named cameras). Pass it, or list what to change.`,
      inputs: { paths: [relTo(e, sheetFile)], json: { id: a.id, kind: a.kind, warnings: build.warnings, buildSeconds: build.buildSeconds, revision: revisions, maxRevisions: MAX_REVISIONS, series: { title: bible.title, tone: bible.tone, style: bible.style } } },
      output: { schema: 'review', path: `tasks/${a.reviewKind}-${a.id}-${round + 1}.json` }
    }, { check: (v) => ((v as z.infer<typeof reviewAnswer>).verdict === 'revise' && (v as z.infer<typeof reviewAnswer>).problems.length === 0 ? ['a "revise" verdict needs at least one problem with where, what and fix'] : []) })
    verdict = review.value.verdict
    if (review.value.verdict === 'pass' || revisions >= MAX_REVISIONS) {
      if (review.value.verdict !== 'pass') verdict = `revise (left as is after ${MAX_REVISIONS} revisions: ${review.value.problems.map((x) => x.what).join('; ').slice(0, 160)})`
      break
    }
    revisions++
    previous = spec
    feedback = { review: review.value.problems, warnings: build.warnings }
  }
  return `${a.id}: ${hasSpec && !o.redo && revisions === 0 ? 'built' : 'designed'}, ${revisions} revision(s), self-review ${verdict ?? 'none'}, built in ${result?.buildSeconds ?? '?'} s`
}

// ---------------------------------------------------------------- step: character

export async function characterStep(e: Env): Promise<string> {
  const bible = await requireChosen(e)
  const out: string[] = []
  for (const [i, member] of bible.cast.entries()) {
    e.progress(i / Math.max(1, bible.cast.length), `character ${member.id}`)
    const castDir = e.store.paths(e.series).castDir(member.id)
    const redoFile = path.join(castDir, 'sheet-redo.json')
    const redoNote = ((await readJson(redoFile))?.note as string | undefined) ?? undefined
    const note = await designAsset(
      e,
      bible,
      { kind: 'character', id: member.id, dir: `cast/${member.id}`, specFile: e.store.paths(e.series).characterFile(member.id), role: 'character-designer', specKind: 'character-spec', reviewKind: 'character-review' },
      {
        redo: !!redoNote || e.detail === 'redo',
        ...(redoNote ? { userNote: redoNote } : {}),
        context: async () => ({ series: { slug: e.series, title: bible.title, tone: bible.tone, style: bible.style, audience: bible.audience }, member: castView(member), others: await otherSpecs(e, bible, member.id) })
      }
    )
    await fs.rm(redoFile, { force: true })
    // the character path in the bible (a hand-written spec is linked as well)
    const fresh = await e.store.readBible(e.series)
    if (fresh.cast.some((c) => c.id === member.id && c.character !== `cast/${member.id}/character.json`)) {
      await e.store.writeBible(e.series, { ...fresh, cast: fresh.cast.map((c) => (c.id === member.id ? { ...c, character: `cast/${member.id}/character.json` } : c)) })
    }
    out.push(note)
  }
  return `characters: ${out.join(' | ')}; waiting for the user to approve the sheets`
}

// ---------------------------------------------------------------- step: set3d

export async function set3dStep(e: Env): Promise<string> {
  const bible = await requireChosen(e)
  const out: string[] = []
  const heights: Record<string, unknown> = {}
  for (const c of bible.cast) {
    const spec = await readJson(e.store.paths(e.series).characterFile(c.id))
    heights[c.id] = { name: c.name.en, height: spec?.height ?? null }
  }
  for (const [i, s] of bible.sets.entries()) {
    e.progress(i / Math.max(1, bible.sets.length), `set ${s.id}`)
    const specFile = e.store.paths(e.series).set3dFile(s.id)
    out.push(
      await designAsset(
        e,
        bible,
        { kind: 'set', id: s.id, dir: `sets/${s.id}`, specFile, role: 'background-artist', specKind: 'set-spec', reviewKind: 'set-review' },
        {
          redo: e.detail === 'redo',
          context: async () => ({ series: { slug: e.series, title: bible.title, tone: bible.tone, style: bible.style }, set: s, cast: heights, pitch: bible.pitches.find((p) => p.id === bible.chosenPitch) ?? null })
        }
      )
    )
    const fresh = await e.store.readBible(e.series)
    const want = `sets/${s.id}/set3d.json`
    if (fresh.sets.some((x) => x.id === s.id && x.file !== want)) await e.store.writeBible(e.series, { ...fresh, sets: fresh.sets.map((x) => (x.id === s.id ? { ...x, file: want } : x)) })
  }
  return `sets: ${out.join(' | ')}`
}

// ---------------------------------------------------------------- step: assemble

export async function assembleStep(e: Env): Promise<string> {
  await requireChosen(e)
  const bible = await e.store.readBible(e.series)
  const out: string[] = []
  for (const [i, lang] of bible.languages.entries()) {
    e.progress(i / bible.languages.length, `assemble ${lang}`)
    const r = await assembleScene({
      dataDir: e.svc.dataDir,
      series: e.series,
      episode: e.episode,
      lang,
      signal: e.ctx.signal,
      onLog: (l) => e.log(l),
      onProgress: (fraction, message) => e.progress((i + fraction) / bible.languages.length, `assemble ${lang}: ${message ?? 'working'}`)
    })
    if (!r.ok) throw new Error(`assemble ${lang}: ${r.code}: ${r.message}`)
    for (const w of r.warnings) e.log(`warning: assemble ${lang}: ${w}`)
    out.push(`${lang}: ${r.frames} frames, ${new Set(r.actions).size} distinct action(s), ${r.shots} shot(s), ${r.assembleSeconds} s${r.warnings.length ? `, ${r.warnings.length} warning(s)` : ''}`)
  }
  return `scenes assembled: ${out.join('; ')}`
}

// ---------------------------------------------------------------- facts for the writer and the clip shots

export interface Facts3d {
  library: ActingLibrary
  /** What the writer may put in a `gesture` beat or a line's `gesture`, with what each one needs. */
  actions: { name: string; kind: string; seconds: { min: number; default: number; max: number }; overLine: boolean; needsTarget: boolean }[]
  emotions: readonly string[]
  /** Per set id: the marks, the camera shot names and the props (a gesture target may be a prop id, a mark or a cast id; `sit` needs a prop with a seat). */
  sets: Record<string, { marks: string[]; shots: string[]; props: { id: string; kind: string; seat: boolean }[] }>
  /** The 3D set specs by id, for the checks. */
  specs: Record<string, Set3d>
}

/** The acting library names and the 3D sets of a series. */
export async function facts3d(e: Pick<Env, 'store' | 'series'>, bible: Bible): Promise<Facts3d> {
  const library = loadActingLibrary()
  const sets: Facts3d['sets'] = {}
  const specs: Record<string, Set3d> = {}
  for (const s of bible.sets) {
    const spec = await e.store.readSet3d(e.series, s.id).catch(() => null)
    if (!spec) continue
    specs[s.id] = spec
    sets[s.id] = { marks: Object.keys(spec.marks), shots: [...shotNames3d(spec, bible.cast.map((c) => c.id))], props: spec.props.map((p) => ({ id: p.id, kind: p.kind, seat: !!p.seat })) }
  }
  const actions = library.actions
    .filter((a) => library.scriptable.has(a.name) || a.kind === 'locomotion' || a.kind === 'camera')
    .map((a) => ({ name: a.name, kind: a.kind, seconds: a.seconds, overLine: a.overLine, needsTarget: a.needsTarget }))
  return { library, actions, emotions: EMOTIONS_3D, sets, specs }
}

/** Extra checks of a 3D script (on top of `scriptProblems`): a gesture that needs a target has a valid one, `sit` has a seat. */
export function scriptProblems3d(script: { cast: string[]; scenes: { id: string; set: string; beats: { id: string; type: string; gesture?: string; target?: string }[] }[] }, facts: Facts3d): string[] {
  const out: string[] = []
  for (const scene of script.scenes) {
    const set = facts.sets[scene.set]
    for (const b of scene.beats) {
      if (b.type !== 'gesture' || !b.gesture) continue
      const action = facts.library.byName.get(b.gesture)
      if (!action || !set) continue
      if (action.needsTarget && !b.target) out.push(`beat ${b.id}: "${b.gesture}" needs a "target" (a cast id, a prop id or a mark of set ${scene.set})`)
      if (b.target && !script.cast.includes(b.target) && !set.marks.includes(b.target) && !set.props.some((p) => p.id === b.target)) out.push(`beat ${b.id}: target "${b.target}" is not a cast id, a prop or a mark of set ${scene.set}`)
      if (b.gesture === 'sit' && b.target && !set.props.find((p) => p.id === b.target)?.seat) out.push(`beat ${b.id}: "sit" needs a prop with a seat; "${b.target}" has none (${set.props.filter((p) => p.seat).map((p) => p.id).join(', ') || 'no prop has a seat'})`)
    }
  }
  return out
}
