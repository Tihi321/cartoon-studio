import { useEffect, useRef } from 'react'
import { useCts } from './store/hooks'
import { PAGES, ctsStore } from './store/store'
import { AgentsPage } from './ui/AgentsPage'
import { ModelsPage } from './ui/ModelsPage'
import { SeriesPage } from './ui/SeriesPage'
import { SettingsPage } from './ui/SettingsPage'

/**
 * The shell: a left rail (the margin of the exercise book, with the red rule beside it) with the nav and the engine state, and the page.
 * The first thing in the tab order is the skip link. Moving to another page moves the focus to the page, so a keyboard or screen-reader user
 * starts at its top.
 */
export function App() {
  const page = useCts((s) => s.page)
  const connected = useCts((s) => s.connected)
  const warnings = useCts((s) => s.warnings)
  const spend = useCts((s) => s.spend)
  const main = useRef<HTMLElement>(null)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    main.current?.focus({ preventScroll: true })
    main.current?.scrollTo?.(0, 0)
  }, [page])
  const warning = warnings[warnings.length - 1]
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
        <nav aria-label="Studio">
          <ul className="nav">
            {PAGES.map((p) => (
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
          {page === 'series' && <SeriesPage />}
          {page === 'models' && <ModelsPage />}
          {page === 'agents' && <AgentsPage />}
          {page === 'settings' && <SettingsPage />}
        </main>
      </div>
    </div>
  )
}
