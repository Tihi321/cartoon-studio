import path from 'node:path'
import type { Lang, RigVariant } from '../../shared/contracts'
import { ID_RE } from '../../shared/contracts'

/**
 * Where a series keeps its files, and the guard that keeps every path inside `<data>/series/<slug>`. Nothing outside this module builds a
 * series path from user input: a slug, an id or a relative path from a file goes through `assertSlug`, `assertId` or `SeriesPaths.resolve`.
 */

/** A series slug (`[a-z0-9-]+`); throws on anything else, so a slug never leaves the `series/` folder. */
export function assertSlug(slug: string): string {
  if (!ID_RE.test(slug)) throw new Error(`invalid series slug "${slug}" (lower-case letters, digits and -)`)
  return slug
}

/** An id of a cast member, set, episode or clip (`[a-z0-9-]+`). */
export function assertId(id: string, what = 'id'): string {
  if (!ID_RE.test(id)) throw new Error(`invalid ${what} "${id}" (lower-case letters, digits and -)`)
  return id
}

/** `<data>/series`, one folder per series. */
export const seriesDir = (dataDir: string): string => path.join(dataDir, 'series')

/** True when `child` is `parent` or lies inside it. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export class SeriesPaths {
  /** The series folder, absolute. */
  readonly root: string

  constructor(dataDir: string, readonly slug: string) {
    this.root = path.resolve(seriesDir(dataDir), assertSlug(slug))
  }

  /**
   * An absolute path inside the series folder for a path relative to `base` (default: the series folder). Throws for an absolute path,
   * a drive letter, or any `..` that leaves the series folder.
   */
  resolve(rel: string, base: string = this.root): string {
    if (!rel || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.includes('\0')) throw new Error(`path "${rel}" is not a relative path inside the series`)
    const abs = path.resolve(base, rel)
    if (!isInside(this.root, abs)) throw new Error(`path "${rel}" leaves the series folder`)
    return abs
  }

  /** `bible.json` */
  get bible(): string {
    return path.join(this.root, 'bible.json')
  }
  castDir(cast: string): string {
    return path.join(this.root, 'cast', assertId(cast, 'cast id'))
  }
  /** The folder of a rig: the cast folder, or `variants/<a|b|c>` under it. Part paths in `rig.json` are relative to it. */
  rigDir(cast: string, variant?: RigVariant): string {
    return variant ? path.join(this.castDir(cast), 'variants', variant) : this.castDir(cast)
  }
  rigFile(cast: string, variant?: RigVariant): string {
    return path.join(this.rigDir(cast, variant), 'rig.json')
  }
  setDir(set: string): string {
    return path.join(this.root, 'sets', assertId(set, 'set id'))
  }
  setFile(set: string): string {
    return path.join(this.setDir(set), 'set.json')
  }
  get clipsDir(): string {
    return path.join(this.root, 'clips')
  }
  get clipsFile(): string {
    return path.join(this.clipsDir, 'clips.json')
  }
  get episodesDir(): string {
    return path.join(this.root, 'episodes')
  }
  episodeDir(episode: string): string {
    return path.join(this.episodesDir, assertId(episode, 'episode id'))
  }
  scriptFile(episode: string): string {
    return path.join(this.episodeDir(episode), 'script.json')
  }
  textFile(episode: string, lang: Lang): string {
    return path.join(this.episodeDir(episode), 'text', `${lang}.json`)
  }
  voiceManifest(episode: string, lang: Lang): string {
    return path.join(this.episodeDir(episode), 'voice', lang, 'manifest.json')
  }
  lipsyncFile(episode: string, lang: Lang, line: string): string {
    return path.join(this.episodeDir(episode), 'lipsync', lang, `${assertId(line, 'line id')}.json`)
  }
  timelineFile(episode: string, lang: Lang): string {
    return path.join(this.episodeDir(episode), `timeline.${lang}.json`)
  }
  budgetFile(episode: string): string {
    return path.join(this.episodeDir(episode), 'budget.json')
  }
  spendFile(episode: string): string {
    return path.join(this.episodeDir(episode), 'spend.json')
  }
  pipelineFile(episode: string): string {
    return path.join(this.episodeDir(episode), 'pipeline.json')
  }
  episodeClipsDir(episode: string): string {
    return path.join(this.episodeDir(episode), 'clips')
  }
  episodeClipsFile(episode: string): string {
    return path.join(this.episodeClipsDir(episode), 'clips.json')
  }
  reviewFile(episode: string, name: string): string {
    return path.join(this.episodeDir(episode), 'reviews', `${name.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  }
  /** `render/<lang>`, `out/` and so on are made by the render step; this is only their folder. */
  outDir(episode: string): string {
    return path.join(this.episodeDir(episode), 'out')
  }
}
