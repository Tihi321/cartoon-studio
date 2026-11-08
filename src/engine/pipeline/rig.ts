import path from 'node:path'
import { z } from 'zod'
import { rigVariantSchema } from '../../shared/contracts'
import { SeriesStore } from '../series/service'

/**
 * `cast/<id>/variants/variants.json` of a `canvas` series (pilots 1 and 2): which rig paths were built as variants `a` (claude-svg) and `c` (raster), their
 * wall time and spend. Reading only: cutout rig building was retired in CTS-28 (`cts_cast_get` and `cts_series_get` still show the record, `cts_rig_check`
 * still checks the rigs).
 */

export const RIG_PATHS = ['claude-svg', 'raster'] as const

const variantRecord = z.strictObject({
  path: z.enum(RIG_PATHS),
  status: z.enum(['built', 'failed', 'not-run']),
  startedAt: z.string(),
  endedAt: z.string(),
  wallSeconds: z.number().nonnegative(),
  spendUsd: z.number().nonnegative(),
  spendCredits: z.number().nonnegative().default(0),
  note: z.string()
})
export const variantsFileSchema = z.strictObject({ schema: z.literal('cts.variants/1'), chosen: rigVariantSchema.nullable(), variants: z.partialRecord(rigVariantSchema, variantRecord) })
export type VariantsFile = z.infer<typeof variantsFileSchema>

export const variantsFile = (store: SeriesStore, series: string, cast: string): string => path.join(store.paths(series).castDir(cast), 'variants', 'variants.json')

export async function readVariants(store: SeriesStore, series: string, cast: string): Promise<VariantsFile> {
  const f = variantsFile(store, series, cast)
  if (!(await store.exists(f))) return { schema: 'cts.variants/1', chosen: null, variants: {} }
  return store.readJson(f, variantsFileSchema)
}
