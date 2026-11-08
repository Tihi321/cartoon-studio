import { z } from 'zod'
import type { CtsService } from '../service'
import type { Tool, ToolDef } from '../mcp/tools'
import { loadBlenderConfig, saveBlenderConfig } from './config'
import { blenderRunnerFor } from './runner'

/**
 * MCP tools of the Blender backend (CTS-18): `cts_blender_status` (the executable, its version against the pinned one, the GPU) and
 * `cts_blender_config` (read or change `config/blender.md`). The job tools (character, set, assemble, render, still) come with their tickets.
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
  ]
}
