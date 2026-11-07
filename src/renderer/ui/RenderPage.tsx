import { useEffect, useMemo, useState } from 'react'
import { LANGS } from '../../shared/contracts'
import type { Lang } from '../../shared/contracts'
import { openFile, showInFolder } from '../api'
import { callTool, duration, renderOfJob, useTool } from '../lib/studio'
import type { RenderJobView } from '../lib/studio'
import type { JobView } from '../store/episode'
import { useCts } from '../store/hooks'
import { Pill, ProgressBar } from './common'
import { LANG_NAME, NeedSeries } from './studio'

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
  // render jobs live in the engine process and send no events: look at them again while one runs
  const renders = useTool('cts_render_status', {}, (r) => ((r.jobs as RenderJobView[] | undefined) ?? []).filter((j) => j.id.startsWith(`${slug}--render--`)))
  const running = (renders.data ?? []).some((j) => j.state === 'running')
  const { reload } = renders
  useEffect(() => {
    if (!running) return
    const id = setInterval(reload, 1500)
    return () => clearInterval(id)
  }, [running, reload])
  return (
    <>
      <QueuePanel status={status.data} reload={status.reload} />
      {ep ? <RenderButtons slug={slug} ep={ep} onStarted={renders.reload} /> : <p className="dim">This series has no episode yet.</p>}
      <JobList slug={slug} status={status.data} renders={renders.data ?? []} />
      {ep && <Renders slug={slug} ep={ep} jobs={renders.data ?? []} />}
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

function RenderButtons({ slug, ep, onStarted }: { slug: string; ep: string; onStarted(): void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const go = async (lang: Lang, quality: 'preview' | 'final') => {
    const key = `${lang}-${quality}`
    setBusy(key)
    setMsg(null)
    try {
      const r = await callTool<{ jobs?: { id: string }[] }>('cts_render', { series: slug, episode: ep, langs: [lang], quality })
      setMsg({ ok: true, text: r.jobs?.[0] ? `Started ${r.jobs[0].id}.` : 'Started.' })
      onStarted()
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

/** A render job of cts_render_status as a job row. */
function viewOfRender(j: RenderJobView, series: string): JobView {
  const m = /--render--(.+)--r\d+$/.exec(j.id)
  const t = j.progress.total
  return {
    id: j.id,
    series,
    task: 'render',
    unit: m?.[1],
    state: j.state,
    fraction: j.state === 'done' ? 1 : t > 0 ? j.progress.done / t : null,
    message: j.state === 'running' && t > 0 ? `frame ${j.progress.done} of ${t}` : undefined,
    startedAt: Date.parse(j.startedAt) || 0,
    endedAt: j.state === 'running' ? undefined : (Date.parse(j.startedAt) || 0) + (j.result?.wallSeconds ?? 0) * 1000,
    error: j.error
  }
}

function JobList({ slug, status, renders }: { slug: string; status: StatusView | null; renders: RenderJobView[] }) {
  const jobs = useCts((s) => s.jobs)
  const rows = useMemo(() => {
    const byId = new Map<string, JobView>()
    for (const j of Object.values(jobs)) if (j.series === slug) byId.set(j.id, j)
    for (const r of renders) byId.set(r.id, viewOfRender(r, slug))
    return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt)
  }, [jobs, slug, renders])
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
  const took = job.endedAt && job.startedAt ? duration((job.endedAt - job.startedAt) / 1000) : null
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

/** The MP4s the engine made in this session (the render jobs keep their results; the engine has no list of renders from earlier runs). */
function Renders({ slug, ep, jobs }: { slug: string; ep: string; jobs: RenderJobView[] }) {
  const rows = useMemo(() => {
    const latest = new Map<string, NonNullable<ReturnType<typeof renderOfJob>>>()
    for (const j of jobs) {
      const r = renderOfJob(j)
      if (r && r.episode === ep) latest.set(`${r.lang}-${r.quality}`, r)
    }
    return [...latest.values()].sort((a, b) => (a.quality === b.quality ? a.lang.localeCompare(b.lang) : a.quality === 'preview' ? -1 : 1))
  }, [jobs, ep])
  return (
    <section aria-labelledby="rn-files" data-testid="render-files">
      <h2 className="panel-title" id="rn-files">
        Finished MP4s
      </h2>
      {rows.length === 0 ? (
        <p className="dim" data-testid="renders-none">
          No MP4 made in this session yet. Render a preview first; files from earlier sessions are in the episode&apos;s out folder.
        </p>
      ) : (
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
            {rows.map((r) => {
              const rel = `series/${slug}/${r.file}`
              const id = `${r.lang}-${r.quality}`
              return (
                <tr key={id} data-testid={`render-row-${id}`}>
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
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
