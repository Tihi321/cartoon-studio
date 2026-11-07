import type { EngineEvent, SeriesSummaryView } from '../../shared/protocol'

export interface CommandErrorView {
  command: string
  message: string
  slug?: string
  at: number
}

/** The series part of the UI state: what the engine answered about the series, and the recent command errors. */
export interface SeriesData {
  /** The series in the data folder, once the engine answered `listSeries`. */
  series: SeriesSummaryView[]
  seriesLoaded: boolean
  /** The last 20 command errors. */
  errors: CommandErrorView[]
}

export function initialSeries(): SeriesData {
  return { series: [], seriesLoaded: false, errors: [] }
}

/** Pure reducer for the series events. Returns only what changed. */
export function reduceSeries(s: SeriesData, e: EngineEvent, now = Date.now()): Partial<SeriesData> {
  switch (e.type) {
    case 'series.listed':
      return { series: e.series, seriesLoaded: true }
    case 'command.error':
      return { errors: [...s.errors.slice(-19), { command: e.command, message: e.message, slug: e.slug, at: now }] }
    default:
      return {}
  }
}
