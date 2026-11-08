import { promises as fs } from 'node:fs'
import { z } from 'zod'
import type { CtsService } from '../service'
import { ToolOutput } from '../mcp/tools'
import type { Tool, ToolDef } from '../mcp/tools'
import { SeriesStore } from '../series/service'
import { enqueueBlenderJob, readBuildInfo, sha1 } from './jobs'
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
    ...assetTools(svc, def)
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
  ]
}
