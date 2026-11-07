import { useMemo, useState } from 'react'
import { LANGS } from '../../shared/contracts'
import type { Lang } from '../../shared/contracts'
import { openFile, showInFolder } from '../api'
import { callTool, duration, normalizeEpisode, useTool } from '../lib/studio'
import type { RenderInfo } from '../lib/studio'
import type { JobView } from '../store/episode'
import { useCts } from '../store/hooks'
import { Pill, ProgressBar } from './common'
import { LANG_NAME, NeedSeries, ToolGate } from './studio'

interface StatusView {
  jobs: { queued: number; running: number; done: number; failed: number }
  running: { id: string; task: string; unit: string | null }[]
  failed: { id: string; failure: string }[]
  clientTasks?: { waiting: number; leased: number }
}

/** Render and jobs: the queue with its switches, the render buttons per language and quality, and the finished MP4s. */
export function RenderPage() {
  const slug = useCts((s) => s.selection.series)
  const ep = useCts((s) => s.selection.episode)
  return (
    <div className="page-body" data-testid="page-render">
      <header className="page-head">
        <h1>Render and jobs</h1>
      </header>
      {!slug ? <NeedSeries /> : <RenderBody slug={slug} ep={ep} />}
    </div>
  )
}

function RenderBody({ slug, ep }: { slug: string; ep: string | null }) {
  const status = useTool<StatusView>('cts_status', { series: slug })
  return (
    <>
      <QueuePanel status={status.data} reload={status.reload} />
      {ep ? <RenderButtons slug={slug} ep={ep} /> : <p className="dim">This series has no episode yet.</p>}
      <JobList slug={slug} status={status.data} />
      {ep && <Renders slug={slug} ep={ep} />}
    </>
  )
}

function QueuePanel({ status, reload }: { status: StatusView | null; reload(): void }) {
  const paused = useCts((s) => s.paused)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (tool: string) => {
    setBusy(true)
    setError(null)
    try {
      await callTool(tool)
      reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const c = status?.jobs
  return (
    <section className="sheet panel" aria-labelledby="rn-queue" data-testid="render-queue">
      <div className="row spread">
        <h2 className="panel-title" id="rn-queue">
          Queue {paused && <Pill tone="warn" testId="queue-paused">paused</Pill>}
        </h2>
        <div className="row">
          {paused ? (
            <button className="primary" disabled={busy} onClick={() => void run('cts_resume_all')} data-testid="queue-resume">
              Resume
            </button>
          ) : (
            <button disabled={busy} onClick={() => void run('cts_pause_all')} data-testid="queue-pause">
              Pause
            </button>
          )}
          <button disabled={busy} onClick={() => void run('cts_stop_now')} data-testid="queue-stop" title="Stops the running jobs now; they run again after Resume">
            Stop now
          </button>
        </div>
      </div>
      <dl className="counts" data-testid="queue-counts">
        {(['queued', 'running', 'done', 'failed'] as const).map((k) => (
          <div key={k} className={k === 'failed' && c?.failed ? 'count bad' : 'count'}>
            <dd data-testid={`queue-count-${k}`}>{c ? c[k] : 0}</dd>
            <dt>{k}</dt>
          </div>
        ))}
      </dl>
      {error && (
        <p className="inline-error" role="alert" data-testid="queue-error">
          {error}
        </p>
      )}
    </section>
  )
}

function RenderButtons({ slug, ep }: { slug: string; ep: string }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const go = async (lang: Lang, quality: 'preview' | 'final') => {
    const key = `${lang}-${quality}`
    setBusy(key)
    setMsg(null)
    try {
      const r = await callTool<{ jobId?: string }>('cts_render', { series: slug, episode: ep, lang, quality })
      setMsg({ ok: true, text: r.jobId ? `Started ${r.jobId}.` : 'Started.' })
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }
  return (
    <section className="sheet panel" aria-labelledby="rn-go" data-testid="render-buttons">
      <h2 className="panel-title" id="rn-go">
        Render {ep}
      </h2>
      <div className="render-grid">
        {LANGS.map((lang) => (
          <div className="render-col" key={lang}>
            <b>{LANG_NAME[lang]}</b>
            <button disabled={busy !== null} onClick={() => void go(lang, 'preview')} data-testid={`render-${lang}-preview`}>
              Preview <span className="dim">960 x 540</span>
            </button>
            <button className="primary" disabled={busy !== null} onClick={() => void go(lang, 'final')} data-testid={`render-${lang}-final`}>
              Final <span className="render-size">1920 x 1080</span>
            </button>
          </div>
        ))}
      </div>
      {msg && (
        <p className={msg.ok ? 'inline-ok' : 'inline-error'} role="status" data-testid="render-msg">
          {msg.text}
        </p>
      )}
    </section>
  )
}

function JobList({ slug, status }: { slug: string; status: StatusView | null }) {
  const jobs = useCts((s) => s.jobs)
  const rows = useMemo(() => Object.values(jobs).filter((j) => j.series === slug).sort((a, b) => b.startedAt - a.startedAt), [jobs, slug])
  const known = new Set(rows.map((r) => r.id))
  // jobs the engine runs that this window did not see start (it opened later)
  const unseen = (status?.running ?? []).filter((r) => !known.has(r.id))
  return (
    <section aria-labelledby="rn-jobs" data-testid="render-jobs">
      <h2 className="panel-title" id="rn-jobs">
        Jobs
      </h2>
      {rows.length === 0 && unseen.length === 0 ? (
        <p className="dim" data-testid="jobs-none">
          Nothing has run in this window yet.
        </p>
      ) : (
        <ul className="jobs">
          {unseen.map((r) => (
            <li className="job" key={r.id} data-testid={`job-${r.id}`}>
              <div className="row spread">
                <span>
                  <b>{r.task}</b> <span className="dim">{r.unit ?? ''}</span>
                </span>
                <Pill tone="accent">running</Pill>
              </div>
              <ProgressBar fraction={null} label={r.id} />
            </li>
          ))}
          {rows.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </ul>
      )}
      {(status?.failed ?? []).length > 0 && (
        <ul className="plain issues" data-testid="jobs-failed">
          {status?.failed.map((f) => (
            <li key={f.id} className="issue bad">
              <code>{f.id}</code> {f.failure}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function JobRow({ job }: { job: JobView }) {
  const tone = job.state === 'failed' ? 'bad' : job.state === 'done' ? 'good' : 'accent'
  const took = job.endedAt ? duration((job.endedAt - job.startedAt) / 1000) : null
  return (
    <li className="job" data-testid={`job-${job.id}`}>
      <div className="row spread">
        <span>
          <b>{job.task}</b> <span className="dim">{job.unit ?? ''}</span>
        </span>
        <span className="row">
          {took && <span className="dim">{took}</span>}
          <Pill tone={tone}>{job.state}</Pill>
        </span>
      </div>
      <ProgressBar fraction={job.state === 'running' ? job.fraction : job.state === 'done' ? 1 : (job.fraction ?? 0)} label={job.id} />
      {(job.message || job.error) && <p className={job.error ? 'inline-error' : 'dim'}>{job.error ?? job.message}</p>}
    </li>
  )
}

function Renders({ slug, ep }: { slug: string; ep: string }) {
  const t = useTool('cts_episode_get', { series: slug, episode: ep }, normalizeEpisode)
  return (
    <section aria-labelledby="rn-files" data-testid="render-files">
      <h2 className="panel-title" id="rn-files">
        Finished MP4s
      </h2>
      <ToolGate state={t} tool="cts_episode_get" testId="render-files-gate">
        {t.data && t.data.renders.length === 0 && (
          <p className="dim" data-testid="renders-none">
            No MP4 yet. Render a preview first.
          </p>
        )}
        {t.data && t.data.renders.length > 0 && (
          <table className="table" data-testid="renders-table">
            <thead>
              <tr>
                <th scope="col">Language</th>
                <th scope="col">Quality</th>
                <th scope="col">Length</th>
                <th scope="col">Render time</th>
                <th scope="col">Encoder</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {t.data.renders.map((r) => (
                <RenderRow key={`${r.lang}-${r.quality}`} slug={slug} r={r} />
              ))}
            </tbody>
          </table>
        )}
      </ToolGate>
    </section>
  )
}

function RenderRow({ slug, r }: { slug: string; r: RenderInfo }) {
  const rel = `series/${slug}/${r.file}`
  const id = `${r.lang}-${r.quality}`
  return (
    <tr data-testid={`render-row-${id}`}>
      <td>{LANG_NAME[r.lang]}</td>
      <td>{r.quality}</td>
      <td>{duration(r.seconds)}</td>
      <td data-testid={`render-row-${id}-time`}>{duration(r.wallSeconds)}</td>
      <td>{r.encoder}</td>
      <td className="actions-cell">
        <button onClick={() => void openFile(rel)} data-testid={`render-open-${id}`}>
          Open MP4
        </button>
        <button onClick={() => void showInFolder(rel)} data-testid={`render-folder-${id}`}>
          Show in folder
        </button>
      </td>
    </tr>
  )
}
