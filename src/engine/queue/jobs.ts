import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseMdWith } from '../../shared/md'
import { jobSchema } from '../../shared/schemas'
import type { JobFrontmatter } from '../../shared/schemas'
import { renameRetry, writeMd } from '../store/atomic'

export type JobState = 'queued' | 'running' | 'done' | 'failed'
export const JOB_STATES: JobState[] = ['queued', 'running', 'done', 'failed']

export interface JobFile {
  id: string
  state: JobState
  data: JobFrontmatter
  body: string
}

/** What a caller gives to enqueue. Everything but id, task and role has a default. */
export type NewJob = { id: string; task: string; role: string } & Partial<Omit<JobFrontmatter, 'id' | 'task' | 'role'>>

/**
 * Jobs are files: one markdown file per job in jobs/<state>/. Moving a file between folders is the status change.
 * A single engine process does the claiming, and the rename makes it safe.
 */
export class JobStore {
  constructor(private readonly dataDir: string) {}

  dir(state: JobState): string {
    return path.join(this.dataDir, 'jobs', state)
  }
  file(state: JobState, id: string): string {
    return path.join(this.dir(state), `${id}.md`)
  }

  async ids(state: JobState): Promise<string[]> {
    try {
      return (await fs.readdir(this.dir(state))).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))
    } catch {
      return []
    }
  }

  async read(state: JobState, id: string): Promise<JobFile | null> {
    const file = this.file(state, id)
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      return null
    }
    const doc = parseMdWith(text, jobSchema, file)
    return { id, state, data: { ...doc.data, id }, body: doc.body }
  }

  async list(state: JobState): Promise<JobFile[]> {
    const out: JobFile[] = []
    for (const id of await this.ids(state)) {
      try {
        const j = await this.read(state, id)
        if (j) out.push(j)
      } catch {
        /* an invalid job file is skipped, and shows up in the log */
      }
    }
    return out
  }

  async find(id: string): Promise<JobFile | null> {
    for (const s of JOB_STATES) {
      const j = await this.read(s, id)
      if (j) return j
    }
    return null
  }

  /** Writes a new job to queued/. Returns false (and writes nothing) when a job with this id exists in any state. */
  async enqueue(job: NewJob, body = ''): Promise<boolean> {
    for (const s of JOB_STATES) {
      try {
        await fs.access(this.file(s, job.id))
        return false
      } catch {
        /* not there */
      }
    }
    const data = jobSchema.parse({ kind: 'job', created: new Date().toISOString(), ...job })
    await writeMd(this.file('queued', job.id), data, body)
    return true
  }

  /** Moves queued/<id> to running/<id>. Returns null when someone else got it first. */
  async claim(id: string): Promise<JobFile | null> {
    try {
      await renameRetry(this.file('queued', id), this.file('running', id))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
      // still locked after the retries: leave the job queued, the next scheduler tick tries again
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') return null
      throw err
    }
    return this.read('running', id)
  }

  /** Rewrites a job file in place (same state). */
  async update(state: JobState, id: string, patch: Partial<JobFrontmatter>, body?: string): Promise<void> {
    const cur = await this.read(state, id)
    if (!cur) return
    await writeMd(this.file(state, id), { ...cur.data, ...patch }, body ?? cur.body)
  }

  /** running -> done. The done file is written first, so a crash in between leaves both and recovery drops the running one. */
  async complete(id: string, patch: Partial<JobFrontmatter>, body: string): Promise<void> {
    await this.finish('done', id, patch, body)
  }

  async fail(id: string, patch: Partial<JobFrontmatter>, body: string): Promise<void> {
    await this.finish('failed', id, patch, body)
  }

  private async finish(to: 'done' | 'failed', id: string, patch: Partial<JobFrontmatter>, body: string): Promise<void> {
    const cur = await this.read('running', id)
    if (!cur) return
    await writeMd(this.file(to, id), { ...cur.data, ...patch }, body)
    await fs.rm(this.file('running', id), { force: true })
  }

  /** running -> queued, for a job that was stopped or has to wait. */
  async requeue(id: string, patch: Partial<JobFrontmatter> = {}): Promise<void> {
    try {
      await renameRetry(this.file('running', id), this.file('queued', id))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    if (Object.keys(patch).length > 0) await this.update('queued', id, patch)
  }

  /** failed -> queued with the attempts reset, for a book that is retried. The old request and failure text are dropped from the body. */
  async retry(id: string): Promise<boolean> {
    const cur = await this.read('failed', id)
    if (!cur) return false
    const body = cur.body.split(/^## (?:Request|Failed)$/m)[0]!.trimEnd()
    await writeMd(this.file('queued', id), { ...cur.data, attempts: 0, not_before: null, failure: null, paid: null }, body ? body + '\n' : '')
    await fs.rm(this.file('failed', id), { force: true })
    return true
  }

  /**
   * On start: every job left in running/ moves back to queued/ with attempts + 1.
   * A job that also exists in done/ or failed/ (crash during the move) is just dropped from running/.
   */
  async recoverRunning(): Promise<{ requeued: string[]; dropped: string[] }> {
    const requeued: string[] = []
    const dropped: string[] = []
    // temporary files left by a write that was cut short
    for (const state of JOB_STATES) {
      for (const f of await fs.readdir(this.dir(state)).catch(() => [] as string[])) {
        if (f.includes('.tmp-')) await fs.rm(path.join(this.dir(state), f), { force: true })
      }
    }
    for (const id of await this.ids('running')) {
      const finished = (await this.read('done', id)) ?? (await this.read('failed', id))
      if (finished) {
        await fs.rm(this.file('running', id), { force: true })
        dropped.push(id)
        continue
      }
      const cur = await this.read('running', id)
      if (!cur) continue
      await this.requeue(id, { attempts: cur.data.attempts + 1, paid: null })
      requeued.push(id)
    }
    return { requeued, dropped }
  }
}
