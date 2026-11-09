import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ZodType, z } from 'zod'
import {
  bibleSchema,
  budgetFileSchema,
  character3dSchema,
  clipsFileSchema,
  episodeSchema,
  lipsyncSchema,
  pipelineStateSchema,
  reviewSchema,
  rigSchema,
  set3dSchema,
  setSchema,
  spendFileSchema,
  style3dSchema,
  textSchema,
  timeline3dSchema,
  timelineSchema,
  voiceManifestSchema
} from '../../shared/contracts'
import type {
  Bible,
  BudgetFile,
  Character3d,
  ClipsFile,
  Episode,
  Lang,
  Lipsync,
  PipelineState,
  Review,
  Rig,
  RigVariant,
  Set3d,
  SetFile,
  SpendFile,
  Style3d,
  TextCatalog,
  Timeline,
  Timeline3d,
  VoiceManifest
} from '../../shared/contracts'
import { atomicWrite } from '../store/atomic'
import { SeriesPaths, assertId, assertSlug, seriesDir } from './paths'

/**
 * The series store: reads and writes the files of `contracts.ts` under `<data>/series/<slug>`. Every read validates against the schema (a bad
 * file throws a `SeriesFileError` with the zod issues), every write validates first and then writes atomically. Binary files (parts,
 * backgrounds, clips) go through `writeFile` / `resolve`, which stay inside the series folder.
 *
 * Plain `dataDir` in, no engine needed: lint, tests and the tools all build one with `new SeriesStore(dataDir)`.
 */

/** A file that is missing, not JSON, or fails its schema. `issues` are `path: message` lines. */
export class SeriesFileError extends Error {
  constructor(
    readonly file: string,
    readonly kind: 'missing' | 'json' | 'schema',
    readonly issues: string[]
  ) {
    super(`${file}: ${kind === 'missing' ? 'file not found' : kind === 'json' ? 'not valid JSON' : 'does not match its schema'}${issues.length ? ` (${issues.slice(0, 5).join('; ')})` : ''}`)
  }
}

export function zodIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
}

/** The brief a series is created from: the stub bible gets its title and logline; the showrunner fills the rest. */
export interface SeriesBrief {
  title?: string | { hr?: string; en?: string }
  logline?: string | { hr?: string; en?: string }
  ageMin?: number
  ageMax?: number
  languages?: Lang[]
  /** `canvas` gives the stub the old flat-cutout style; anything else (the default) the 3D toon style of `seed/style/toon-3d.md`. */
  renderer?: 'canvas' | 'blender'
}

const loc = (v: SeriesBrief['title'], fallback: string): { hr: string; en: string } => {
  if (typeof v === 'string') return { hr: v, en: v }
  return { hr: v?.hr ?? v?.en ?? fallback, en: v?.en ?? v?.hr ?? fallback }
}

/** sha1 of the bytes of `script.json`: what a timeline's `scriptHash` holds. */
export function hashScript(raw: string | Buffer): string {
  return createHash('sha1').update(raw).digest('hex')
}

export class SeriesStore {
  constructor(readonly dataDir: string) {}

  paths(slug: string): SeriesPaths {
    return new SeriesPaths(this.dataDir, slug)
  }

  // ---- generic ----

  async readJson<S extends ZodType>(file: string, schema: S): Promise<z.output<S>> {
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch {
      throw new SeriesFileError(file, 'missing', [])
    }
    let json: unknown
    try {
      json = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
    } catch (e) {
      throw new SeriesFileError(file, 'json', [(e as Error).message])
    }
    const r = schema.safeParse(json)
    if (!r.success) throw new SeriesFileError(file, 'schema', zodIssues(r.error))
    return r.data
  }

  /** Validates, then writes `file` atomically (2-space JSON, a final newline). Returns the validated (defaults applied) value. */
  async writeJson<S extends ZodType>(file: string, schema: S, value: unknown): Promise<z.output<S>> {
    const r = schema.safeParse(value)
    if (!r.success) throw new SeriesFileError(file, 'schema', zodIssues(r.error))
    await atomicWrite(file, `${JSON.stringify(r.data, null, 2)}\n`)
    return r.data
  }

  async exists(file: string): Promise<boolean> {
    return fs.stat(file).then((s) => s.isFile(), () => false)
  }

  /** An absolute path inside the series for a path relative to the series folder (or to `base`). Throws when it would leave the series. */
  resolve(slug: string, rel: string, base?: string): string {
    return this.paths(slug).resolve(rel, base)
  }

  /** Writes a binary or text file (a part SVG, a PNG layer) atomically; the path is relative to `base` (default: the series folder) and guarded. */
  async writeFile(slug: string, rel: string, data: string | Buffer, base?: string): Promise<string> {
    const abs = this.paths(slug).resolve(rel, base)
    if (typeof data === 'string') await atomicWrite(abs, data)
    else {
      const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(tmp, data)
      await fs.rename(tmp, abs)
    }
    return abs
  }

  // ---- series ----

  /** A series exists when it has a `bible.json` (CTS-38: a folder that only holds episode files, e.g. a budget set first, is not a series yet). */
  async seriesExists(slug: string): Promise<boolean> {
    return fs.stat(this.paths(slug).bible).then((s) => s.isFile(), () => false)
  }

  /** The slugs of the series folders that have a `bible.json`. */
  async listSeries(): Promise<string[]> {
    const entries = await fs.readdir(seriesDir(this.dataDir), { withFileTypes: true }).catch(() => [])
    const out: string[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      try {
        assertSlug(e.name)
      } catch {
        continue
      }
      if (await this.exists(path.join(seriesDir(this.dataDir), e.name, 'bible.json'))) out.push(e.name)
    }
    return out.sort()
  }

  /** Creates the series folder with a stub bible from a brief (no cast, sets, pitches or episodes yet). Throws when the series exists. */
  async createSeries(slug: string, brief: SeriesBrief = {}): Promise<Bible> {
    const p = this.paths(slug)
    if (await this.seriesExists(slug)) throw new Error(`series "${slug}" already exists`)
    const bible = bibleSchema.parse({
      schema: 'cts.bible/1',
      slug,
      title: loc(brief.title, slug),
      audience: { ageMin: brief.ageMin ?? 4, ageMax: brief.ageMax ?? 8 },
      logline: loc(brief.logline, ''),
      tone: ['gentle humour', 'no peril beyond mild', 'every episode ends warm'],
      style:
        brief.renderer === 'canvas'
          ? { look: 'flat paper cutout, solid colours, 6 px black outline', palette: ['#f4d35e', '#ee964b', '#0d3b66', '#faf0ca', '#222222'], outlinePx: 6, refPrompt: '' }
          : { look: 'toon 3D, soft rounded shapes, flat two-tone cel shading, a thin dark outline, a bright simple world', palette: ['#f4d35e', '#ee964b', '#0d3b66', '#faf0ca', '#222222'], outlinePx: 2, refPrompt: 'a toon 3D character, soft rounded shapes, flat cel shading, a thin dark outline' },
      languages: brief.languages ?? ['hr', 'en'],
      cast: [],
      sets: [],
      music: { stings: [] },
      rules: ['lines of at most 12 words', 'no name-calling'],
      episodes: [],
      pitches: [],
      chosenPitch: null
    })
    // the folder may already hold episode files (a budget set before the series): they are kept
    await fs.mkdir(p.root, { recursive: true })
    await this.writeJson(p.bible, bibleSchema, bible)
    return bible
  }

  readBible(slug: string): Promise<Bible> {
    return this.readJson(this.paths(slug).bible, bibleSchema)
  }
  writeBible(slug: string, bible: unknown): Promise<Bible> {
    return this.writeJson(this.paths(slug).bible, bibleSchema, bible)
  }

  // ---- cast and sets ----

  readRig(slug: string, cast: string, variant?: RigVariant): Promise<Rig> {
    return this.readJson(this.paths(slug).rigFile(cast, variant), rigSchema)
  }
  writeRig(slug: string, cast: string, rig: unknown, variant?: RigVariant): Promise<Rig> {
    return this.writeJson(this.paths(slug).rigFile(cast, variant), rigSchema, rig)
  }
  /** The cast ids that have a folder under `cast/`. */
  async listCast(slug: string): Promise<string[]> {
    return this.subdirs(path.join(this.paths(slug).root, 'cast'))
  }
  /** The variants (`a`, `c`) that have a `rig.json` under `cast/<id>/variants/`. */
  async listRigVariants(slug: string, cast: string): Promise<RigVariant[]> {
    const dirs = await this.subdirs(path.join(this.paths(slug).castDir(cast), 'variants'))
    return dirs.filter((d): d is RigVariant => d === 'a' || d === 'c')
  }
  readSet(slug: string, set: string): Promise<SetFile> {
    return this.readJson(this.paths(slug).setFile(set), setSchema)
  }
  writeSet(slug: string, set: string, value: unknown): Promise<SetFile> {
    return this.writeJson(this.paths(slug).setFile(set), setSchema, value)
  }
  readCharacter3d(slug: string, cast: string): Promise<Character3d> {
    return this.readJson(this.paths(slug).characterFile(cast), character3dSchema)
  }
  writeCharacter3d(slug: string, cast: string, value: unknown): Promise<Character3d> {
    return this.writeJson(this.paths(slug).characterFile(cast), character3dSchema, value)
  }
  readSet3d(slug: string, set: string): Promise<Set3d> {
    return this.readJson(this.paths(slug).set3dFile(set), set3dSchema)
  }
  writeSet3d(slug: string, set: string, value: unknown): Promise<Set3d> {
    return this.writeJson(this.paths(slug).set3dFile(set), set3dSchema, value)
  }
  /** The look of a Blender series: the file the bible names (`style3d`), else `style3d.json`. */
  readStyle3d(slug: string, rel?: string): Promise<Style3d> {
    return this.readJson(this.paths(slug).style3dFile(rel), style3dSchema)
  }
  async listSets(slug: string): Promise<string[]> {
    return this.subdirs(path.join(this.paths(slug).root, 'sets'))
  }

  // ---- episodes ----

  /** The episode ids: folders under `episodes/` with a `script.json`, plus those listed in the bible without one yet. */
  async listEpisodes(slug: string): Promise<string[]> {
    const p = this.paths(slug)
    const dirs = await this.subdirs(p.episodesDir)
    const ids = new Set(dirs)
    try {
      for (const e of (await this.readBible(slug)).episodes) ids.add(e.id)
    } catch {
      /* no readable bible: the folders are the list */
    }
    return [...ids].sort()
  }

  /** Creates the episode folder with an empty script for the cast and registers it in the bible. */
  async createEpisode(slug: string, episode: string, o: { title?: string | { hr?: string; en?: string }; cast: string[]; set: string; shot?: string; mark?: string }): Promise<Episode> {
    const p = this.paths(slug)
    assertId(episode, 'episode id')
    if (await this.exists(p.scriptFile(episode))) throw new Error(`episode "${episode}" already exists`)
    const script = episodeSchema.parse({
      schema: 'cts.episode/1',
      series: slug,
      id: episode,
      titleKey: 'title',
      cast: o.cast,
      scenes: [{ id: 's1', set: o.set, start: Object.fromEntries(o.cast.map((c) => [c, { mark: o.mark ?? 'center' }])), shot: o.shot ?? 'wide', beats: [{ id: 'b01', type: 'pause', seconds: 1 }] }],
      music: {},
      sfx: {}
    })
    await this.writeJson(p.scriptFile(episode), episodeSchema, script)
    const bible = await this.readBible(slug)
    if (!bible.episodes.some((e) => e.id === episode)) {
      bible.episodes.push({ id: episode, title: loc(o.title, episode), status: 'draft' })
      await this.writeBible(slug, bible)
    }
    return script
  }

  readScript(slug: string, episode: string): Promise<Episode> {
    return this.readJson(this.paths(slug).scriptFile(episode), episodeSchema)
  }
  writeScript(slug: string, episode: string, script: unknown): Promise<Episode> {
    return this.writeJson(this.paths(slug).scriptFile(episode), episodeSchema, script)
  }
  /** sha1 of the script.json bytes, the value a timeline's `scriptHash` must hold. */
  async scriptHash(slug: string, episode: string): Promise<string> {
    return hashScript(await fs.readFile(this.paths(slug).scriptFile(episode)))
  }
  readText(slug: string, episode: string, lang: Lang): Promise<TextCatalog> {
    return this.readJson(this.paths(slug).textFile(episode, lang), textSchema)
  }
  writeText(slug: string, episode: string, lang: Lang, text: unknown): Promise<TextCatalog> {
    return this.writeJson(this.paths(slug).textFile(episode, lang), textSchema, text)
  }
  readVoiceManifest(slug: string, episode: string, lang: Lang): Promise<VoiceManifest> {
    return this.readJson(this.paths(slug).voiceManifest(episode, lang), voiceManifestSchema)
  }
  writeVoiceManifest(slug: string, episode: string, lang: Lang, m: unknown): Promise<VoiceManifest> {
    return this.writeJson(this.paths(slug).voiceManifest(episode, lang), voiceManifestSchema, m)
  }
  readLipsync(slug: string, episode: string, lang: Lang, line: string): Promise<Lipsync> {
    return this.readJson(this.paths(slug).lipsyncFile(episode, lang, line), lipsyncSchema)
  }
  writeLipsync(slug: string, episode: string, lang: Lang, line: string, v: unknown): Promise<Lipsync> {
    return this.writeJson(this.paths(slug).lipsyncFile(episode, lang, line), lipsyncSchema, v)
  }
  readTimeline(slug: string, episode: string, lang: Lang): Promise<Timeline> {
    return this.readJson(this.paths(slug).timelineFile(episode, lang), timelineSchema)
  }
  writeTimeline(slug: string, episode: string, lang: Lang, v: unknown): Promise<Timeline> {
    return this.writeJson(this.paths(slug).timelineFile(episode, lang), timelineSchema, v)
  }
  /** The timeline of a Blender series (same file name as the canvas timeline, another schema). */
  readTimeline3d(slug: string, episode: string, lang: Lang): Promise<Timeline3d> {
    return this.readJson(this.paths(slug).timelineFile(episode, lang), timeline3dSchema)
  }
  writeTimeline3d(slug: string, episode: string, lang: Lang, v: unknown): Promise<Timeline3d> {
    return this.writeJson(this.paths(slug).timelineFile(episode, lang), timeline3dSchema, v)
  }
  readReview(slug: string, episode: string, name: string): Promise<Review> {
    return this.readJson(this.paths(slug).reviewFile(episode, name), reviewSchema)
  }
  writeReview(slug: string, episode: string, name: string, v: unknown): Promise<Review> {
    return this.writeJson(this.paths(slug).reviewFile(episode, name), reviewSchema, v)
  }

  // ---- clips, budget, spend, pipeline ----

  /** The series clips (`clips/clips.json`), or the episode's when `episode` is given. Missing file: no clips. */
  async readClips(slug: string, episode?: string): Promise<ClipsFile> {
    const p = this.paths(slug)
    const file = episode ? p.episodeClipsFile(episode) : p.clipsFile
    if (!(await this.exists(file))) return { schema: 'cts.clips/1', clips: [] }
    return this.readJson(file, clipsFileSchema)
  }
  writeClips(slug: string, v: unknown, episode?: string): Promise<ClipsFile> {
    const p = this.paths(slug)
    return this.writeJson(episode ? p.episodeClipsFile(episode) : p.clipsFile, clipsFileSchema, v)
  }
  /** `budget.json`, or null when there is none (both caps are then 0). */
  async readBudget(slug: string, episode: string): Promise<BudgetFile | null> {
    const file = this.paths(slug).budgetFile(episode)
    return (await this.exists(file)) ? this.readJson(file, budgetFileSchema) : null
  }
  writeBudget(slug: string, episode: string, v: unknown): Promise<BudgetFile> {
    return this.writeJson(this.paths(slug).budgetFile(episode), budgetFileSchema, v)
  }
  /** `spend.json`, or an empty ledger. */
  async readSpend(slug: string, episode: string): Promise<SpendFile> {
    const file = this.paths(slug).spendFile(episode)
    if (!(await this.exists(file))) return { schema: 'cts.spend/1', entries: [] }
    return this.readJson(file, spendFileSchema)
  }
  writeSpend(slug: string, episode: string, v: unknown): Promise<SpendFile> {
    return this.writeJson(this.paths(slug).spendFile(episode), spendFileSchema, v)
  }
  async readPipeline(slug: string, episode: string): Promise<PipelineState | null> {
    const file = this.paths(slug).pipelineFile(episode)
    return (await this.exists(file)) ? this.readJson(file, pipelineStateSchema) : null
  }
  writePipeline(slug: string, episode: string, v: unknown): Promise<PipelineState> {
    return this.writeJson(this.paths(slug).pipelineFile(episode), pipelineStateSchema, v)
  }

  // ---- helpers ----

  private async subdirs(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  }
}
