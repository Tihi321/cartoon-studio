import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'

/** The fixture series `mini3d` (renderer "blender": two characters, one with legs and one without, a set with a bench, 3 beats, texts and fake voice manifests hr/en). */
export const MINI3D_DIR = path.resolve(__dirname, 'mini3d')

/** Copies the fixture to `<dataDir>/series/<slug>` so a test can change it freely. Returns the series folder. */
export async function installMini3d(dataDir: string, slug = 'mini3d'): Promise<string> {
  const dest = path.join(dataDir, 'series', slug)
  await mkdir(path.dirname(dest), { recursive: true })
  await cp(MINI3D_DIR, dest, { recursive: true })
  return dest
}
