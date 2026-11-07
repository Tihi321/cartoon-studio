import { useEffect, useRef } from 'react'
import { useCts } from './store/hooks'
import { PAGES, ctsStore } from './store/store'
import type { Page } from './store/store'
import { AgentsPage } from './ui/AgentsPage'
import { CastPage } from './ui/CastPage'
import { EpisodePage } from './ui/EpisodePage'
import { ModelsPage } from './ui/ModelsPage'
import { PreviewPage } from './ui/PreviewPage'
import { RenderPage } from './ui/RenderPage'
import { SeriesPage } from './ui/SeriesPage'
import { SetsPage } from './ui/SetsPage'
import { SettingsPage } from './ui/SettingsPage'
import { TasksPage } from './ui/TasksPage'
import { SeriesProvider, useAutoSelect, useSeriesInfo } from './ui/studio'

const VIEWS: Record<Page, () => React.JSX.Element> = {
  series: SeriesPage,
  cast: CastPage,
  sets: SetsPage,
  episode: EpisodePage,
  preview: PreviewPage,
  render: RenderPage,
  tasks: TasksPage,
  settings: SettingsPage,
  models: ModelsPage,
  agents: AgentsPage
}

/**
 * The shell: a left rail (the margin of the exercise book, with the red rule beside it) with the series picker, the nav and the engine
 * state, and the page. The first thing in the tab order is the skip link. Moving to another page moves the focus to the page, so a keyboard
 * or screen-reader user starts at its top.
 */
export function App() {
  const page = useCts((s) => s.page)
  const connected = useCts((s) => s.connected)
  const warnings = useCts((s) => s.warnings)
  const spend = useCts((s) => s.spend)
  const main = useRef<HTMLElement>(null)
  const first = useRef(true)
  const info = useSeriesInfo()
  useAutoSelect(info.data)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    main.current?.focus({ preventScroll: true })
    main.current?.scrollTo?.(0, 0)
  }, [page])
  const warning = warnings[warnings.length - 1]
  const View = VIEWS[page]
  return (
    <div className="app">
      <a
        className="skip-link"
        href="#main"
        data-testid="skip-link"
        onClick={(e) => {
          e.preventDefault()
          main.current?.focus()
        }}
      >
        Skip to the page
      </a>
      <aside className="rail">
        <div className="brand" data-testid="brand">
          <span className="brand-name">Cartoon Studio</span>
          <span className="brand-sub">cutout cartoons for children</span>
        </div>
        <Pickers episodes={info.data?.episodes ?? []} />
        <nav aria-label="Studio">
          {(['studio', 'engine'] as const).map((group) => (
            <ul className="nav" key={group} data-testid={`nav-group-${group}`}>
              {group === 'engine' && <li className="nav-label">Engine</li>}
              {PAGES.filter((p) => p.group === group).map((p) => (
                <li key={p.id}>
                  <button
                    className={page === p.id ? 'nav-item on' : 'nav-item'}
                    aria-current={page === p.id ? 'page' : undefined}
                    onClick={() => ctsStore.getState().setPage(p.id)}
                    data-testid={`nav-${p.id}`}
                  >
                    {p.label}
                  </button>
                </li>
              ))}
            </ul>
          ))}
        </nav>
        <div className="rail-foot" data-testid="engine-status">
          <span className={connected ? 'dot on' : 'dot'} aria-hidden="true" />
          <span>
            {connected ? 'Engine connected' : 'Engine not connected'}
            {connected && <span className="dim rail-spend"> Spent today ${spend.today.toFixed(2)}</span>}
          </span>
        </div>
      </aside>
      <div className="main-col">
        {warning && (
          <div className="warnbar" role="status" data-testid="warnbar">
            {warning}
            {warnings.length > 1 && <span className="dim"> ({warnings.length - 1} earlier)</span>}
          </div>
        )}
        <main id="main" ref={main} tabIndex={-1} className="page">
          <SeriesProvider value={info}>
            <View />
          </SeriesProvider>
        </main>
      </div>
    </div>
  )
}

/** Which series and which episode the views show. */
function Pickers({ episodes }: { episodes: { id: string; title: { en: string } }[] }) {
  const series = useCts((s) => s.series)
  const sel = useCts((s) => s.selection)
  if (series.length === 0) return null
  return (
    <div className="pickers" data-testid="pickers">
      <label className="picker">
        <span>Series</span>
        <select value={sel.series ?? ''} onChange={(e) => ctsStore.getState().select({ series: e.target.value || null })} data-testid="pick-series">
          {series.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.title}
            </option>
          ))}
        </select>
      </label>
      {episodes.length > 0 && (
        <label className="picker">
          <span>Episode</span>
          <select value={sel.episode ?? ''} onChange={(e) => ctsStore.getState().select({ episode: e.target.value || null })} data-testid="pick-episode">
            {episodes.map((e) => (
              <option key={e.id} value={e.id}>
                {e.id} {e.title.en}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}
