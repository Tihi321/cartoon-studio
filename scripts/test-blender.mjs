// Runs the Blender-side tests (blender/tests) in Blender's own Python. Fails, not skips, when Blender is missing.
// Blender: CTS_BLENDER, else the installer's folder under ProgramFiles (the default of config/blender.md). Usage: yarn test:blender
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const exe = process.env.CTS_BLENDER || path.join(process.env.ProgramFiles ?? '', 'Blender Foundation', 'Blender 5.2', 'blender.exe')
if (!fs.existsSync(exe)) {
  console.error(`test:blender FAILED: Blender not found at ${exe} (install Blender 5.2 or set CTS_BLENDER)`)
  process.exit(1)
}
const r = spawnSync(exe, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', path.join(root, 'blender', 'tests', 'run.py')], {
  stdio: 'inherit',
  env: { ...process.env, PYTHONNOUSERSITE: '1' }
})
process.exit(r.status ?? 1)
