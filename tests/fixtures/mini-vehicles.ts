import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * The fixture series `mini-vehicles` (HUB-31, renderer "blender"): a car (pip) and a train (bruno), a crossing set with a road and a track path,
 * a script with a drive, a honk with its sfx beat, a chug and a react, texts and fake voice manifests hr/en (both en lines are fake ElevenLabs
 * lines with word times and `wordsFrom: "elevenlabs"`; the hr lines have no word times).
 */
export const MINI_VEHICLES_DIR = path.resolve(__dirname, 'mini-vehicles')

/** Copies the fixture to `<dataDir>/series/<slug>` so a test can change it freely. Returns the series folder. */
export async function installMiniVehicles(dataDir: string, slug = 'mini-vehicles'): Promise<string> {
  const dest = path.join(dataDir, 'series', slug)
  await mkdir(path.dirname(dest), { recursive: true })
  await cp(MINI_VEHICLES_DIR, dest, { recursive: true })
  return dest
}
