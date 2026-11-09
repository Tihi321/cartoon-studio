import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSeedState, refreshStarterAgents, saveSeedState, syncSeedFile } from './seedRefresh'
import type { SeedState } from './seedRefresh'
import { applySeedMigrations } from './seedMigrations'

/** Folders created inside the data folder (see the README). */
export const DATA_LAYOUT = [
  'config',
  'agents',
  'prompts',
  'state',
  'series',
  'jobs/queued',
  'jobs/running',
  'jobs/done',
  'jobs/failed',
  'logs/agents',
  'logs/spend'
] as const

export interface ResolveOptions {
  argv?: readonly string[]
  env?: NodeJS.ProcessEnv
  homedir?: string
}

/** Reads `--data <dir>` or `--data=<dir>` from an argument list. */
export function argValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === `--${name}`) return argv[i + 1]
    if (a?.startsWith(`--${name}=`)) return a.slice(name.length + 3)
  }
  return undefined
}

/** `--data` argument, then the CTS_DATA env var, then `~/CartoonStudio`. */
export function resolveDataDir(opts: ResolveOptions = {}): string {
  const argv = opts.argv ?? process.argv.slice(2)
  const env = opts.env ?? process.env
  const chosen = argValue(argv, 'data') || env.CTS_DATA || path.join(opts.homedir ?? os.homedir(), 'CartoonStudio')
  return path.resolve(chosen)
}

/** Finds the repo's `seed/` folder: CTS_SEED, else walk up from this file. */
export function findSeedDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CTS_SEED) return path.resolve(env.CTS_SEED)
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'seed')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export interface InitResult {
  dataDir: string
  createdDirs: number
  copied: string[]
  skipped: string[]
  /** Seeded files that were still as seeded and got the newer seed version (see `store/seedRefresh.ts`). */
  updated: string[]
  /** Seeded files you edited that have a newer seed version: yours are kept. */
  updateAvailable: string[]
  /** One-time additive migrations that changed an edited config file (see `store/seedMigrations.ts`). */
  migrated: string[]
}

async function copyTree(src: string, dest: string, root: string, result: InitResult, skipDirs: Set<string>, state: SeedState): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      const rel = path.relative(root, to).split(path.sep).join('/')
      if (skipDirs.has(rel)) {
        result.skipped.push(`${rel}/`)
        continue
      }
      await copyTree(from, to, root, result, skipDirs, state)
    } else if (entry.isFile()) {
      const rel = path.relative(root, to).split(path.sep).join('/')
      if (rel.startsWith('agents/')) {
        // the starter staff is only ever copied, never refreshed: it is yours to change
        try {
          // COPYFILE_EXCL: never overwrite a file that already exists.
          await fs.copyFile(from, to, 1)
          result.copied.push(rel)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') result.skipped.push(rel)
          else throw err
        }
        continue
      }
      const action = await syncSeedFile(rel, from, to, state)
      if (action === 'copy') result.copied.push(rel)
      else if (action === 'update') result.updated.push(rel)
      else result.skipped.push(rel)
    }
  }
}

/**
 * Creates the data folder layout and copies `seed/` into it. A file you edited is never overwritten; one that is still as it was seeded gets
 * the newer seed version, and an edited one with a newer version is listed in `updateAvailable` (see `store/seedRefresh.ts`).
 * The starter staff (`agents/`) is copied only while the data folder has no `agents/` folder: after that the staff is
 * yours to hire and fire, and a fired starter agent doesn't come back at the next start.
 */
export async function initDataFolder(dataDir: string, seedDir: string | undefined = findSeedDir()): Promise<InitResult> {
  const result: InitResult = { dataDir, createdDirs: 0, copied: [], skipped: [], updated: [], updateAvailable: [], migrated: [] }
  await fs.mkdir(dataDir, { recursive: true })
  const skipDirs = new Set(existsSync(path.join(dataDir, 'agents')) ? ['agents'] : [])
  if (seedDir && existsSync(seedDir)) {
    const state = await loadSeedState(dataDir)
    await copyTree(seedDir, dataDir, dataDir, result, skipDirs, state)
    if (skipDirs.has('agents')) result.updated.push(...(await refreshStarterAgents(seedDir, dataDir)))
    result.migrated = await applySeedMigrations(dataDir, seedDir, state)
    await saveSeedState(dataDir, state)
    result.updateAvailable = [...state.updateAvailable].sort()
  }
  for (const rel of DATA_LAYOUT) {
    const dir = path.join(dataDir, ...rel.split('/'))
    if (!existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true })
      result.createdDirs++
    }
  }
  return result
}
