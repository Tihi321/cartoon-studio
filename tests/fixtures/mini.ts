import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'

/** The fixture series `mini` (two vector rigs, one set, one episode of 3 lines, texts hr/en, voice manifests). Written by `scripts/make-fixture-mini.mjs`. */
export const MINI_DIR = path.resolve(__dirname, 'mini')

/** Copies the fixture to `<dataDir>/series/<slug>` so a test can change it freely. Returns the series folder. */
export async function installMini(dataDir: string, slug = 'mini'): Promise<string> {
  const dest = path.join(dataDir, 'series', slug)
  await mkdir(path.dirname(dest), { recursive: true })
  await cp(MINI_DIR, dest, { recursive: true })
  return dest
}
