import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { pickFile, pickFolder } from '../api'
import type { PickKind } from '../hostApi'
import { useCts } from '../store/hooks'

export type Tone = 'good' | 'bad' | 'warn' | 'dim' | 'accent'

/** A small label with a state. The words carry the meaning; the colour only backs them up. */
export function Pill({ tone = 'dim', children, title, testId }: { tone?: Tone; children: ReactNode; title?: string; testId?: string }) {
  return (
    <span className={`pill ${tone}`} title={title} data-testid={testId}>
      {children}
    </span>
  )
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * A dialog: focus moves into it, Tab and Shift+Tab stay inside, Escape closes it and the focus goes back to where it was.
 * `testId` goes on the dialog; the close button is `<testId>-close`.
 */
export function Modal({ title, onClose, children, width = 560, testId = 'modal' }: { title: string; onClose(): void; children: ReactNode; width?: number; testId?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const first = box.current?.querySelector<HTMLElement>('[data-autofocus]') ?? box.current?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
    return () => before?.focus?.()
  }, [])
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab' || !box.current) return
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement)
    if (items.length === 0) return
    const first = items[0] as HTMLElement
    const last = items[items.length - 1] as HTMLElement
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={onKey}>
      <div ref={box} className="modal sheet" style={{ width }} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId}>
        <div className="row spread">
          <h2 className="panel-title" id={titleId}>
            {title}
          </h2>
          <button onClick={onClose} data-testid={`${testId}-close`}>
            Close
          </button>
        </div>
        <div className="stack" style={{ marginTop: 8 }}>
          {children}
        </div>
      </div>
    </div>
  )
}

/** A path text box with a Browse button (the desktop app's picker); typing a path works too. */
export function PathField({
  value,
  onChange,
  mode,
  kind = 'any',
  placeholder,
  testId,
  label
}: {
  value: string
  onChange(v: string): void
  mode: 'folder' | 'file'
  kind?: PickKind
  placeholder?: string
  testId?: string
  label: string
}) {
  const canPick = typeof window !== 'undefined' && !!window.cartoonstudio?.pickFolder
  return (
    <div className="row" style={{ flexWrap: 'nowrap' }}>
      <input style={{ flex: 1, minWidth: 0 }} value={value} placeholder={placeholder} aria-label={label} onChange={(e) => onChange(e.target.value)} data-testid={testId} />
      <button
        disabled={!canPick}
        title={canPick ? undefined : 'Only in the desktop app'}
        data-testid={testId ? `${testId}-browse` : undefined}
        onClick={() => void (mode === 'folder' ? pickFolder('Choose a folder') : pickFile('Choose a file', kind)).then((p) => p && onChange(p))}
      >
        Browse...
      </button>
    </div>
  )
}

/** The newest error the engine reported for this series (or any command when no slug), if it is recent. */
export function useRecentError(slug: string | null, command?: string): string | null {
  const errors = useCts((s) => s.errors)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])
  const last = [...errors].reverse().find((e) => (slug === null || e.slug === slug || !e.slug) && (!command || e.command === command))
  return last && now - last.at < 30000 ? `${last.command}: ${last.message}` : null
}

export function ProgressBar({ fraction, label }: { fraction: number | null; label?: string }) {
  return (
    <div className="bar" role="progressbar" aria-label={label ?? 'Progress'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}>
      <div className={fraction === null ? 'bar-fill busy' : 'bar-fill'} style={fraction === null ? undefined : { width: `${Math.round(fraction * 100)}%` }} />
    </div>
  )
}

// ---- states: loading, empty, error ----

/** Something is on its way. Announced to screen readers; the motion stops under prefers-reduced-motion. */
export function Loading({ label = 'Loading', testId = 'loading' }: { label?: string; testId?: string }) {
  return (
    <div className="state loading" role="status" data-testid={testId}>
      <span className="loading-bar" aria-hidden="true" />
      <span>{label}...</span>
    </div>
  )
}

/** Nothing here yet: says what the page is for and what to do (`children` is the how). */
export function Empty({ title, children, testId = 'empty', level = 2 }: { title: string; children?: ReactNode; testId?: string; level?: 2 | 3 }) {
  const H = level === 2 ? 'h2' : 'h3'
  return (
    <div className="state empty" data-testid={testId}>
      <H className="state-title">{title}</H>
      {children && <div className="state-body">{children}</div>}
    </div>
  )
}

/** Something failed: says what, and how to go on. */
export function ErrorBox({ title, message, onRetry, testId = 'error' }: { title: string; message: string; onRetry?: () => void; testId?: string }) {
  return (
    <div className="state error" role="alert" data-testid={testId}>
      <h2 className="state-title">{title}</h2>
      <p className="state-body" data-testid={`${testId}-message`}>
        {message}
      </p>
      {onRetry && (
        <div>
          <button onClick={onRetry} data-testid={`${testId}-retry`}>
            Try again
          </button>
        </div>
      )}
    </div>
  )
}

/** The note shown where a ticket of the roadmap will fill in data that does not exist yet. */
export function Coming({ ticket, children, testId = 'coming' }: { ticket: string; children: ReactNode; testId?: string }) {
  return (
    <div className="state coming" data-testid={testId}>
      <div className="state-body">{children}</div>
      <p className="dim">
        Filled in by <code>{ticket}</code>.
      </p>
    </div>
  )
}

// ---- forms ----

/** A label tied to its control: `children` gets the id to put on the control (and the id of the hint for `aria-describedby`). */
export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: (id: string, describedBy?: string) => ReactNode; className?: string }) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  return (
    <div className={`field${className ? ` ${className}` : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children(id, hintId)}
      {hint && (
        <p className="dim field-hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  )
}

/** A command or path to copy: shown as code, with a button that copies it. */
export function CopyLine({ text, label, testId }: { text: string; label: string; testId: string }) {
  const [done, setDone] = useState(false)
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setDone(true)
        setTimeout(() => setDone(false), 1600)
      },
      () => undefined
    )
  }, [text])
  return (
    <div className="copyline">
      <code data-testid={testId}>{text}</code>
      <button onClick={copy} aria-label={`Copy: ${label}`} data-testid={`${testId}-copy`}>
        {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

// ---- tabs (the ARIA tabs pattern: arrow keys move, Home and End jump, one tab stop) ----

export interface TabSpec<T extends string> {
  id: T
  label: string
}

/** The tab buttons. Put the matching `TabPanel` below it. `prefix` names the ids and the test ids (`<prefix>-tab-<id>`). */
export function Tabs<T extends string>({ tabs, value, onChange, prefix, label }: { tabs: readonly TabSpec<T>[]; value: T; onChange(id: T): void; prefix: string; label: string }) {
  const refs = useRef(new Map<string, HTMLButtonElement>())
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === value)
    let next = -1
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    if (next < 0) return
    e.preventDefault()
    const id = (tabs[next] as TabSpec<T>).id
    onChange(id)
    refs.current.get(id)?.focus()
  }
  return (
    <div className="tablist" role="tablist" aria-label={label} onKeyDown={onKey} data-testid={`${prefix}-tabs`}>
      {tabs.map((t) => (
        <button
          key={t.id}
          ref={(el) => {
            if (el) refs.current.set(t.id, el)
            else refs.current.delete(t.id)
          }}
          role="tab"
          id={`${prefix}-tab-${t.id}`}
          aria-selected={t.id === value}
          aria-controls={`${prefix}-panel`}
          tabIndex={t.id === value ? 0 : -1}
          className={t.id === value ? 'tab on' : 'tab'}
          onClick={() => onChange(t.id)}
          data-testid={`${prefix}-tab-${t.id}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function TabPanel({ prefix, active, children }: { prefix: string; active: string; children: ReactNode }) {
  return (
    <div className="tabpanel sheet" role="tabpanel" id={`${prefix}-panel`} aria-labelledby={`${prefix}-tab-${active}`} tabIndex={0} data-testid={`${prefix}-panel-${active}`}>
      {children}
    </div>
  )
}
