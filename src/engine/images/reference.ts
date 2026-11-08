import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * The record of a cutout character sheet of a `canvas` series (pilots 1 and 2): `cast/<id>/sheet/meta.json`. The Z-Image sketch-to-sheet step that wrote
 * it was retired in CTS-28; the file is still read by `cts_sheet_approve` for those series.
 */

export interface SheetMeta {
  prompt: string
  /** The seed of the picked master. */
  seed: number
  denoise: number
  model: string
  /** 0 for the first sheet; a redo added 1 and moved the seeds by 10 per attempt. */
  attempt: number
  note: string | null
  picked: number
  notes: string
  /** Seconds per image. */
  seconds: Record<string, number>
}

export async function readSheetMeta(castDir: string): Promise<SheetMeta | null> {
  try {
    return JSON.parse(await readFile(path.join(castDir, 'sheet', 'meta.json'), 'utf8')) as SheetMeta
  } catch {
    return null
  }
}
