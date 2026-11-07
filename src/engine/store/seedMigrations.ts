import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseDocument } from 'yaml'
import type { Document } from 'yaml'
import { splitFrontmatter } from '../../shared/md'
import { atomicWrite } from './atomic'
import type { SeedState } from './seedRefresh'

/**
 * One-time, additive migrations of config files you edited. The seed refresh (`seedRefresh.ts`) never touches an edited file, so an entry
 * added to a seed file in a later release would never reach it. A migration adds a missing entry or field and never overwrites a value.
 * Its id is recorded in `.seed-hashes.json` once it ran (even when it changed nothing), so an entry you delete later does not come back.
 * A file that is missing or does not parse is skipped and not recorded: the migration runs again at the next start.
 */
export interface SeedMigration {
  id: string
  /** The seed file, relative to the data folder (`/`). */
  file: string
  /** Edits the frontmatter in place and says whether it changed anything. `seed` is the same file in the seed folder, or null when it does not parse. */
  apply(doc: Document, seed: Document | null): boolean
}

/**
 * The migrations of Cartoon Studio's seed files. None yet: the repo started with the seed as it is. A later release that adds an entry to
 * a seeded config file adds a migration here (the mechanism is the one of Edu Studio).
 */
export const SEED_MIGRATIONS: SeedMigration[] = []

async function readFrontmatterDoc(file: string): Promise<{ doc: Document; text: string; frontmatter: string; body: string } | null> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
  const { frontmatter, body } = splitFrontmatter(text)
  if (frontmatter === null) return null
  const doc = parseDocument(frontmatter)
  if (doc.errors.length > 0) return null
  return { doc, text, frontmatter, body }
}

/** Runs the migrations that did not run yet. Returns the ids that changed a file. */
export async function applySeedMigrations(dataDir: string, seedDir: string, state: SeedState, migrations: SeedMigration[] = SEED_MIGRATIONS): Promise<string[]> {
  const changed: string[] = []
  for (const mig of migrations) {
    if (state.migrations.includes(mig.id)) continue
    const rel = mig.file.split('/')
    const mine = await readFrontmatterDoc(path.join(dataDir, ...rel))
    if (!mine) continue
    const seed = await readFrontmatterDoc(path.join(seedDir, ...rel))
    if (mig.apply(mine.doc, seed?.doc ?? null)) {
      const eol = mine.text.includes('\r\n') ? '\r\n' : '\n'
      const fm = mine.doc.toString({ lineWidth: 0 }).replace(/\r?\n/g, eol)
      await atomicWrite(path.join(dataDir, ...rel), `---${eol}${fm}---${eol}${mine.body}`)
      changed.push(mig.id)
    }
    state.migrations.push(mig.id)
  }
  return changed
}
