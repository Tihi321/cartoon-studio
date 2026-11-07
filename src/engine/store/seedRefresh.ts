import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { atomicWrite } from './atomic'

/**
 * Seed refresh. The data folder is made from `seed/` and never overwritten, so a prompt or config improved in a new release never reached
 * an existing data folder. This keeps the hash of each seed file as it was copied (`.seed-hashes.json`):
 *
 * - the file is not there: copy it;
 * - it is the same as the seed: nothing to do;
 * - it is still the seed version that was copied (its hash is the recorded one, or a known earlier seed version): untouched, so update it;
 * - otherwise you edited it (or the app did): keep it, and note that an update is available.
 *
 * Text is hashed with line endings normalised (Windows checkouts have CRLF).
 */

export const SEED_HASHES_FILE = '.seed-hashes.json'

export const seedHash = (content: string | Buffer): string => createHash('sha1').update(content.toString('utf8').replace(/\r\n/g, '\n')).digest('hex')

/**
 * The hashes of earlier seed versions, per file (a file whose hash is in here was never edited, so a newer seed version may replace it).
 * A release that changes a seed file adds the hash of the old version here. Empty: nothing was released before this repo's first commit.
 */
export const SEED_HISTORY: Record<string, string[]> = {}

export interface SeedState {
  version: 1
  /** Seed file (relative, `/`) -> hash of the seed version that was last copied or confirmed. */
  files: Record<string, string>
  /** Files you edited that have a newer seed version. */
  updateAvailable: string[]
  /** Ids of the one-time migrations that ran (see `seedMigrations.ts`). */
  migrations: string[]
}

export const emptySeedState = (): SeedState => ({ version: 1, files: {}, updateAvailable: [], migrations: [] })

export type SeedAction = 'copy' | 'same' | 'update' | 'keep'

/**
 * What to do with one seed file. `destHash` is null when the file is not in the data folder. Returns the action and the new state of that file
 * (`recorded`: the hash to remember, or undefined to forget; `pending`: an update is available for the edited file).
 */
export function planSeedFile(rel: string, seed: string, destHash: string | null, state: Pick<SeedState, 'files'>, history: Record<string, string[]> = SEED_HISTORY): { action: SeedAction; recorded: string | undefined; pending: boolean } {
  const recorded = state.files[rel]
  if (destHash === null) return { action: 'copy', recorded: seed, pending: false }
  if (destHash === seed) return { action: 'same', recorded: seed, pending: false }
  const past = history[rel] ?? []
  const untouched = destHash === recorded || past.includes(destHash)
  if (untouched) return { action: 'update', recorded: seed, pending: false }
  // edited by you. A seed that did not change since the version your file came from has no update; a changed one does.
  const seedChanged = recorded !== undefined ? recorded !== seed : !past.includes(seed)
  return { action: 'keep', recorded: recorded ?? (seedChanged ? undefined : seed), pending: seedChanged }
}

export async function loadSeedState(dataDir: string): Promise<SeedState> {
  try {
    const j = JSON.parse(await fs.readFile(path.join(dataDir, SEED_HASHES_FILE), 'utf8')) as Partial<SeedState>
    return { version: 1, files: { ...(j.files ?? {}) }, updateAvailable: [...(j.updateAvailable ?? [])], migrations: [...(j.migrations ?? [])] }
  } catch {
    return emptySeedState()
  }
}

export async function saveSeedState(dataDir: string, state: SeedState): Promise<void> {
  const sorted: SeedState = { version: 1, files: Object.fromEntries(Object.entries(state.files).sort(([a], [b]) => a.localeCompare(b))), updateAvailable: [...state.updateAvailable].sort(), migrations: [...state.migrations] }
  await atomicWrite(path.join(dataDir, SEED_HASHES_FILE), JSON.stringify(sorted, null, 2) + '\n')
}

/** The seeded files with a newer version that you edited (kept), from the last `initDataFolder`. */
export async function readSeedNotes(dataDir: string): Promise<{ updateAvailable: string[] }> {
  return { updateAvailable: (await loadSeedState(dataDir)).updateAvailable }
}

/** Applies `planSeedFile` to one file on disk and updates the state. Returns the action taken. */
export async function syncSeedFile(rel: string, from: string, to: string, state: SeedState): Promise<SeedAction> {
  const seedBytes = await fs.readFile(from)
  const seed = seedHash(seedBytes)
  let destHash: string | null = null
  try {
    destHash = seedHash(await fs.readFile(to))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const plan = planSeedFile(rel, seed, destHash, state)
  if (plan.action === 'copy' || plan.action === 'update') {
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.writeFile(to, seedBytes)
  }
  if (plan.recorded === undefined) delete state.files[rel]
  else state.files[rel] = plan.recorded
  state.updateAvailable = state.updateAvailable.filter((f) => f !== rel)
  if (plan.pending) state.updateAvailable.push(rel)
  return plan.action
}
