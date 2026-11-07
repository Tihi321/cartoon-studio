import { z } from 'zod'
import { rigVariantSchema } from '../../shared/contracts'
import type { CtsService } from '../service'
import type { Tool, ToolDef } from '../mcp/tools'
import { checkRig, lintSeries } from './lint'
import { SeriesStore } from './service'

/** The MCP tools of the series store: the checks (`cts_lint`, `cts_rig_check`). The series CRUD tools are added by the pipeline ticket on top of `SeriesStore`. */
export function seriesCheckTools(svc: CtsService, def: ToolDef): Tool[] {
  const store = () => new SeriesStore(svc.dataDir)
  const series = z.string().describe('The series slug')
  return [
    def(
      'cts_lint',
      'Check a series, or one episode of it: schemas, cast/set/mark/shot/gesture references, line texts and audio per language, rig part files, timeline staleness, mouth in silence, language order, clips. Returns errors (E_*) and warnings (W_*) with file and where, the per-rig results and the mouth-open share per line (stats). Errors must be 0 before a render.',
      z.object({ series, episode: z.string().optional(), requireAudio: z.boolean().optional().describe('A missing voice manifest or file is an error (after the voice step)') }),
      async (a) => lintSeries(store(), a.series, { episode: a.episode, requireAudio: a.requireAudio })
    ),
    def(
      'cts_rig_check',
      'Check one rig against the part rules: every part and face file exists, SVG parts are flat (no text, filter, script, external href; size limits), PNG parts have alpha, all 8 mouth shapes, 3 eye states and 4 brow states exist. variant a|b|c checks cast/<id>/variants/<v>/rig.json.',
      z.object({ series, cast: z.string().describe('The cast id'), variant: rigVariantSchema.optional() }),
      async (a) => checkRig(store(), a.series, a.cast, a.variant)
    )
  ]
}
