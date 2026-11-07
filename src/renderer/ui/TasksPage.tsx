import { useEffect, useState } from 'react'
import { callTool, useTool } from '../lib/studio'
import type { ClientTaskRow } from '../lib/studio'
import { useCts } from '../store/hooks'
import { CopyLine, Empty, Pill } from './common'
import { ToolGate } from './studio'

interface TasksView {
  waiting: number
  leased: number
  tasks: ClientTaskRow[]
}

const minutes = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`)

/**
 * Client tasks: the model calls parked for Claude Code (roles set to client/claude-code). Waiting ones are for the next cts_get_task; a
 * leased one is held by a client until it answers or the lease runs out. Release gives a leased or waiting task back.
 */
export function TasksPage() {
  const connected = useCts((s) => s.connected)
  const slug = useCts((s) => s.selection.series)
  const t = useTool<TasksView>('cts_client_tasks', {}, (r) => ({ waiting: Number(r.waiting ?? 0), leased: Number(r.leased ?? 0), tasks: (r.tasks as ClientTaskRow[] | undefined) ?? [] }))
  const [all, setAll] = useState(false)
  // tasks come and go without a job event: look again every few seconds
  const { reload } = t
  useEffect(() => {
    if (!connected) return
    const id = setInterval(reload, 4000)
    return () => clearInterval(id)
  }, [connected, reload])
  const rows = (t.data?.tasks ?? []).filter((r) => all || !slug || r.book === slug || r.book === '')
  return (
    <div className="page-body" data-testid="page-tasks">
      <header className="page-head">
        <h1>Client tasks</h1>
        <div className="head-actions">
          <label className="inline">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} data-testid="tasks-all" />
            Every series
          </label>
          <button onClick={reload} data-testid="tasks-refresh">
            Refresh
          </button>
        </div>
      </header>
      <p className="lede dim">
        Roles set to <code>client/claude-code</code> park their model calls here. Claude Code takes them with <code>cts_get_task</code> and answers with <code>cts_submit_task</code>.
      </p>
      <ToolGate state={t} tool="cts_client_tasks" testId="tasks">
        <div className="row" data-testid="tasks-counts">
          <Pill tone={t.data?.waiting ? 'warn' : 'dim'} testId="tasks-waiting">
            {t.data?.waiting ?? 0} waiting
          </Pill>
          <Pill tone={t.data?.leased ? 'accent' : 'dim'} testId="tasks-leased">
            {t.data?.leased ?? 0} leased
          </Pill>
        </div>
        {rows.length === 0 ? (
          <Empty title="No task is parked" testId="tasks-empty">
            <p>When the pipeline needs a model answer from Claude Code, the task shows up here.</p>
            <CopyLine text="cts_get_task" label="the tool that takes the oldest task" testId="tasks-hint" />
          </Empty>
        ) : (
          <table className="table" data-testid="tasks-table">
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">What it asks</th>
                <th scope="col">Series</th>
                <th scope="col">State</th>
                <th scope="col">Waiting</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <TaskRow key={r.id} row={r} onChanged={reload} />
              ))}
            </tbody>
          </table>
        )}
      </ToolGate>
    </div>
  )
}

function TaskRow({ row, onChanged }: { row: ClientTaskRow; onChanged(): void }) {
  const [error, setError] = useState<string | null>(null)
  const release = async () => {
    setError(null)
    try {
      await callTool('cts_release_task', { taskId: row.id })
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const summary = row.summary ?? `${row.task}${row.unit ? ` for ${row.unit}` : ''}`
  return (
    <tr data-testid={`task-${row.id}`}>
      <td>
        <b>{row.role || 'unknown'}</b>
        <div className="dim">{row.client}</div>
      </td>
      <td>
        <span data-testid={`task-${row.id}-summary`}>{summary}</span>
        <div className="dim ellipsis">{row.job}</div>
      </td>
      <td>{row.book || 'none'}</td>
      <td>
        <Pill tone={row.state === 'leased' ? 'accent' : 'warn'} testId={`task-${row.id}-state`}>
          {row.state === 'leased' ? `leased, ${minutes(row.leaseMsLeft ?? 0)} left` : 'waiting'}
        </Pill>
      </td>
      <td>{minutes(row.ageMs)}</td>
      <td className="actions-cell">
        <button onClick={() => void release()} data-testid={`task-${row.id}-release`}>
          Release
        </button>
        {error && <span className="bad-text">{error}</span>}
      </td>
    </tr>
  )
}
