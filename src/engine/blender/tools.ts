import { promises as fs } from 'node:fs'
import { z } from 'zod'
import type { CtsService } from '../service'
import { ToolOutput } from '../mcp/tools'
import type { Tool, ToolDef } from '../mcp/tools'
import { SeriesStore } from '../series/service'
import { LANGS } from '../../shared/contracts'
import { enqueueBlenderJob, readBuildInfo, sha1, stillFrame } from './jobs'
import { loadBlenderConfig, saveBlenderConfig } from './config'
import { blenderRunnerFor } from './runner'

/**
 * MCP tools of the Blender backend (CTS-18): `cts_blender_status` (the executable, its version against the pinned one, the GPU) and
 * `cts_blender_config` (read or change `config/blender.md`), the character tools of CTS-20 (`cts_character_set`, `cts_character_build`,
 * `cts_character_get`) and the set tools of CTS-21. The job tools of assembling and rendering come with their tickets.
 */
export function blenderTools(svc: CtsService, def: ToolDef): Tool[] {
  const frame = z.object({ width: z.number().int().positive(), height: z.number().int().positive(), samples: z.number().int().positive() }).partial()
  return [
    def(
      'cts_blender_status',
      'Is Blender usable for the 3D render: the configured path exists (E_BLENDER_MISSING if not), its version is the pinned major.minor (E_BLENDER_VERSION if not, unless allowUntestedVersion), and which GPU EEVEE would use (from a headless probe run). Returns { ok: true, version, gpu, path } or { ok: false, code, message }. The version is read once per engine start (and again after cts_blender_config changes the file).',
      z.object({}),
      async () => (await blenderRunnerFor(svc.dataDir)).status()
    ),
    def(
      'cts_blender_config',
      'Read or change config/blender.md (the Blender path, the pinned version, allowUntestedVersion, chunkFrames, the preview and final size and samples). With no fields it only returns the current values. A change takes effect at once and Blender is checked again at the next use.',
      z.object({
        path: z.string().min(1).optional().describe('The Blender executable'),
        version: z.string().regex(/^\d+\.\d+$/).optional().describe('Accepted major.minor, for example "5.2"'),
        allowUntestedVersion: z.boolean().optional(),
        chunkFrames: z.number().int().positive().optional(),
        preview: frame.optional(),
        final: frame.optional()
      }),
      async (a) => {
        const current = await loadBlenderConfig(svc.dataDir)
        const { preview, final, ...rest } = a
        const patch = { ...rest, ...(preview ? { preview: { ...current.preview, ...preview } } : {}), ...(final ? { final: { ...current.final, ...final } } : {}) }
        const changed = Object.keys(patch).length > 0
        return { changed, config: changed ? await saveBlenderConfig(svc.dataDir, patch) : current }
      }
    )
  ,
    ...assetTools(svc, def),
    ...sceneTools(svc, def)
  ]
}

/** `cts_scene_assemble` and `cts_still` (CTS-25). */
function sceneTools(svc: CtsService, def: ToolDef): Tool[] {
  const series = z.string().describe('The series slug')
  const episode = z.string().describe('The episode id')
  return [
    def(
      'cts_scene_assemble',
      'Assemble the 3D scene of a Blender episode from its timeline (cts_timeline_build first) and the built characters and set: appends the assets, puts the actors on their marks, runs the acting library on the timeline actions, keys mouths, lids and pupils, frames the camera shots (wide, two, cu-<id>, ots-<a>-<b> or a named camera of the set), adds the title cards, and writes episodes/<ep>/render/<lang>/scene.blend and assembly.json (actions per actor, shots, spec and asset hashes, warnings). One job per language (all languages of the bible when lang is left out); returns job ids at once (cts_wait, cts_status). The job result is JSON { ok: true, blend, assembly, frames, actions, shots, warnings } or { ok: false, code, message } (E_ACTION_UNKNOWN, E_MARK_UNKNOWN, E_SHOT_UNKNOWN, E_ASSEMBLE_FAILED).',
      z.object({ series, episode, lang: z.enum(LANGS).optional() }),
      async (a) => {
        const st = new SeriesStore(svc.dataDir)
        const langs = a.lang ? [a.lang] : (await st.readBible(a.series)).languages
        const jobs: string[] = []
        for (const lang of langs) jobs.push(await enqueueBlenderJob(svc, { series: a.series, task: 'scene_assemble', role: 'background-artist', unit: `${a.episode}-${lang}`, label: `assemble ${a.episode} ${lang}`, body: { episode: a.episode, lang } }))
        return { jobs, hint: 'cts_wait {series}; then cts_still {series, episode, lang, t} to look at a frame, cts_render for the film' }
      }
    ),
    def(
      'cts_still',
      'One frame of the assembled 3D scene as a PNG (default 960x540, 4 samples): a quick look at the staging at time t (seconds), or the keyframe of a Flow clip. Needs cts_scene_assemble first. Runs Blender and waits (a few seconds). Returns the file path and the picture.',
      z.object({ series, episode, lang: z.enum(LANGS).default('hr'), t: z.number().min(0).describe('Seconds into the film'), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), samples: z.number().int().positive().optional() }),
      async (a) => {
        const r = await stillFrame({ dataDir: svc.dataDir, series: a.series, episode: a.episode, lang: a.lang, t: a.t, ...(a.width ? { width: a.width, height: a.height ?? Math.round((a.width * 9) / 16) } : {}), ...(a.samples ? { samples: a.samples } : {}) })
        const buf = await fs.readFile(r.file)
        const out = { file: r.file, frame: r.frame }
        return buf.length > 4_000_000 ? out : new ToolOutput(out, [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }])
      }
    )
  ]
}

async function withImage(file: string, data: Record<string, unknown>): Promise<unknown> {
  const buf = await fs.readFile(file).catch(() => null)
  if (!buf) return { ...data, sheet: null }
  const out = { ...data, sheet: file }
  return buf.length > 4_000_000 ? out : new ToolOutput(out, [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }])
}

/** `cts_character_*` (CTS-20) and `cts_set3d_*` (CTS-21). */
function assetTools(svc: CtsService, def: ToolDef): Tool[] {
  const store = () => new SeriesStore(svc.dataDir)
  const series = z.string().describe('The series slug')
  const cast = z.string().describe('The cast id')
  return [
    def(
      'cts_character_set',
      'Write the 3D spec of a character (cts.character3d/1: primitive parts on parented controls, a face, a motion profile; see seed/style/toon-3d.md and the character-spec prompt) to series/<slug>/cast/<cast>/character.json. The spec is checked first (every standard control, parts name a known control and palette colour, ...); a problem comes back as the error. Sets the `character` path of the cast member in the bible. Nothing is built: call cts_character_build.',
      z.object({ series, cast, spec: z.record(z.string(), z.unknown()).describe('The character spec object') }),
      async (a) => {
        const st = store()
        if (!(await st.seriesExists(a.series))) throw new Error(`no series "${a.series}"`)
        if (a.spec.id !== a.cast) throw new Error(`the spec id "${String(a.spec.id)}" must be the cast id "${a.cast}"`)
        await st.writeCharacter3d(a.series, a.cast, a.spec)
        const file = st.paths(a.series).characterFile(a.cast)
        const bible = await st.readBible(a.series)
        const member = bible.cast.find((c) => c.id === a.cast)
        const rel = `cast/${a.cast}/character.json`
        if (member && member.character !== rel) {
          member.character = rel
          await st.writeBible(a.series, bible)
        }
        return { file, specHash: sha1(await fs.readFile(file)), hint: 'cts_character_build {series, cast} makes character.blend and the sheet' }
      }
    ),
    def(
      'cts_character_build',
      'Build a character from its spec with Blender: cast/<cast>/character.blend, sheet.png (turnaround, six mouths, blink, half lid, happy, sad, surprised, looks; the pieces are in sheet/) and build.json (spec hash, controls, determinism hashes, warnings). Returns a job id at once (cts_wait, cts_status). The job result is JSON: { ok: true, blend, sheet, warnings, buildSeconds } or { ok: false, code, message } for a spec Blender cannot build (E_FACE_HIDDEN: the eyes or mouth are buried in the head). Read sheet.png (cts_character_get) after it.',
      z.object({ series, cast, sheet: z.boolean().default(true).describe('Also render sheet.png (default true)') }),
      async (a) => {
        const st = store()
        if (!(await st.exists(st.paths(a.series).characterFile(a.cast)))) throw new Error(`no character spec for "${a.cast}": cts_character_set first`)
        const job = await enqueueBlenderJob(svc, { series: a.series, task: 'character_build', role: 'character-designer', unit: a.cast, label: `build ${a.cast}`, body: { id: a.cast, sheet: a.sheet } })
        return { job, hint: 'cts_wait {series}; the job result says ok or the error code. Then cts_character_get {series, cast} shows the sheet' }
      }
    ),
    def(
      'cts_character_get',
      'The 3D spec of a character, its last build (build.json: hashes, controls, warnings), whether the build is stale (the spec changed since), and the sheet.png picture.',
      z.object({ series, cast }),
      async (a) => {
        const st = store()
        const p = st.paths(a.series)
        const specFile = p.characterFile(a.cast)
        if (!(await st.exists(specFile))) throw new Error(`no character spec for "${a.cast}"`)
        const raw = await fs.readFile(specFile)
        const build = await readBuildInfo(`${p.castDir(a.cast)}/build.json`)
        const specHash = sha1(raw)
        const data = { spec: JSON.parse(raw.toString('utf8')) as unknown, specHash, build, stale: !build || build.specHash !== specHash }
        return withImage(`${p.castDir(a.cast)}/sheet.png`, data)
      }
    )
    ,
    def(
      'cts_set3d_set',
      'Write the 3D spec of a set (cts.set3d/1: ground and patches, sky, props from the kit, marks, named cameras; see the set-spec prompt) to series/<slug>/sets/<set>/set3d.json. Checked first (ids, kinds, colours). Nothing is built: call cts_set3d_build.',
      z.object({ series, set: z.string().describe('The set id'), spec: z.record(z.string(), z.unknown()).describe('The set spec object') }),
      async (a) => {
        const st = store()
        if (!(await st.seriesExists(a.series))) throw new Error(`no series "${a.series}"`)
        if (a.spec.id !== a.set) throw new Error(`the spec id "${String(a.spec.id)}" must be the set id "${a.set}"`)
        await st.writeSet3d(a.series, a.set, a.spec)
        const file = st.paths(a.series).set3dFile(a.set)
        return { file, specHash: sha1(await fs.readFile(file)), hint: 'cts_set3d_build {series, set} makes set.blend and the four-view sheet' }
      }
    ),
    def(
      'cts_set3d_build',
      'Build a set from its spec with Blender: sets/<set>/set.blend, sheet.png (four views: wide, two stand-ins on the first two marks, and the first two named cameras) and build.json (spec hash, props, marks, cameras, warnings such as a mark inside a prop footprint or a bench without a seat). Returns a job id at once (cts_wait). The job result is JSON { ok: true, blend, sheet, warnings, buildSeconds } or { ok: false, code, message } (E_SET_INVALID).',
      z.object({ series, set: z.string().describe('The set id'), sheet: z.boolean().default(true) }),
      async (a) => {
        const st = store()
        if (!(await st.exists(st.paths(a.series).set3dFile(a.set)))) throw new Error(`no set spec for "${a.set}": cts_set3d_set first`)
        const job = await enqueueBlenderJob(svc, { series: a.series, task: 'set_build', role: 'background-artist', unit: a.set, label: `build set ${a.set}`, body: { id: a.set, sheet: a.sheet } })
        return { job, hint: 'cts_wait {series}; then read sets/<set>/sheet.png (cts_set3d_get)' }
      }
    ),
    def(
      'cts_set3d_get',
      'The 3D spec of a set, its last build (build.json), whether the build is stale, and the sheet.png picture.',
      z.object({ series, set: z.string().describe('The set id') }),
      async (a) => {
        const st = store()
        const p = st.paths(a.series)
        const specFile = p.set3dFile(a.set)
        if (!(await st.exists(specFile))) throw new Error(`no set spec for "${a.set}"`)
        const raw = await fs.readFile(specFile)
        const build = await readBuildInfo(`${p.setDir(a.set)}/build.json`)
        const specHash = sha1(raw)
        return withImage(`${p.setDir(a.set)}/sheet.png`, { spec: JSON.parse(raw.toString('utf8')) as unknown, specHash, build, stale: !build || build.specHash !== specHash })
      }
    )
  ]
}
