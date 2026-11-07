import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientProvider, ClientTaskQueue } from '../src/engine/models/client'
import type { ChatMessage } from '../src/engine/models/types'
import { emptyUsage } from '../src/engine/models/types'
import type { JobContext } from '../src/engine/queue/scheduler'
import { SeriesStore } from '../src/engine/series/service'
import { runRoleTask } from '../src/engine/pipeline/tasks'
import type { RoleTask } from '../src/engine/pipeline/tasks'

/**
 * The role task contract (CTS-07): a role job is a client task; the answer is checked against the named schema before anything is written. An answer
 * that fails comes back as a retry with the errors; a valid one is written to the task's output path. Tests drive the real client task queue the
 * way `cts_get_task` / `cts_submit_task` do, with no model and no service.
 */

let dir: string
let store: SeriesStore
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cts-task-'))
  store = new SeriesStore(dir)
  await store.createSeries('mini', { title: 'Mini' })
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

/** A job context whose model calls wait in a client task queue (what `client/claude-code` does). */
function clientCtx(queue: ClientTaskQueue): JobContext {
  const provider = new ClientProvider('client', queue)
  return {
    job: { id: 'mini--safety--ep00--r1', task: 'safety', role: 'child-safety-reviewer', book: 'mini' },
    agent: { id: 'a', role: 'child-safety-reviewer', name: 'Hugo', persona: 'You are Hugo, the reviewer.' },
    signal: new AbortController().signal,
    usedTemplate: (t: string) => t,
    log: () => undefined,
    chat: async (o: { messages: ChatMessage[]; schema?: Record<string, unknown> }) => {
      let text = ''
      for await (const ev of provider.chat({ model: 'claude-code', messages: o.messages, schema: o.schema, meta: { job: 'mini--safety--ep00--r1', role: 'child-safety-reviewer', task: 'safety', book: 'mini' } } as never)) if (ev.type === 'delta') text += ev.text
      return { text, usage: emptyUsage(), model: {} as never, costUsd: 0 }
    }
  } as unknown as JobContext
}

const task: RoleTask = {
  id: 'safety-1',
  role: 'child-safety-reviewer',
  kind: 'safety',
  prompt: 'Review the script.',
  inputs: { paths: [], json: { note: 'x' } },
  output: { schema: 'review', path: 'episodes/ep00/reviews/safety.json' }
}
const outFile = () => store.resolve('mini', task.output.path)
const exists = (f: string) => stat(f).then(() => true, () => false)

/** Waits until the queue has a task, leases it and returns it. */
async function lease(queue: ClientTaskQueue) {
  for (let i = 0; i < 200; i++) {
    const t = queue.lease({ role: 'child-safety-reviewer' })
    if (t) return t
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('no task reached the client queue')
}

describe('role tasks', () => {
  it('refuses an answer that fails its schema (the task stays, with the problems) and writes a valid one to its path', async () => {
    const queue = new ClientTaskQueue()
    const done = runRoleTask(clientCtx(queue), store, 'mini', task)
    const t = await lease(queue)
    expect(t.role).toBe('child-safety-reviewer')
    expect(JSON.stringify(t.schema)).toContain('verdict')
    // wrong verdict, missing fields: refused at submit with the problems, nothing written, the task is still ours
    const bad = queue.submit(t.id, JSON.stringify({ verdict: 'maybe' }))
    expect(bad.accepted).toBe(false)
    expect(bad).toMatchObject({ problems: expect.arrayContaining([expect.stringMatching(/verdict/)]) })
    expect(await exists(outFile())).toBe(false)
    expect(queue.state(t.id)).toBe('leased')
    const good = { verdict: 'pass', scores: { safety: 5 }, notes: 'ok', problems: [] }
    expect(queue.submit(t.id, JSON.stringify(good))).toEqual({ accepted: true })
    const r = await done
    expect(r.retries).toBe(0)
    expect(JSON.parse(await readFile(outFile(), 'utf8'))).toEqual({ schema: 'cts.review/1', ...good })
  })

  it('sends a valid-JSON answer that fails the task\'s own check back as a retry with the errors, then writes the fixed one', async () => {
    const queue = new ClientTaskQueue()
    const check = (v: unknown) => ((v as { verdict: string; problems: unknown[] }).verdict === 'revise' && (v as { problems: unknown[] }).problems.length === 0 ? ['a "revise" verdict needs at least one problem'] : [])
    const done = runRoleTask(clientCtx(queue), store, 'mini', task, { check })
    const first = await lease(queue)
    // fine for the JSON schema, not for the check
    expect(queue.submit(first.id, JSON.stringify({ verdict: 'revise', scores: {}, notes: 'n', problems: [] }))).toEqual({ accepted: true })
    expect(await exists(outFile())).toBe(false)
    const second = await lease(queue)
    expect(second.id).not.toBe(first.id)
    const lastUser = second.messages[second.messages.length - 1]!
    expect(typeof lastUser.content === 'string' ? lastUser.content : '').toMatch(/needs at least one problem/)
    const fixed = { verdict: 'revise', scores: { safety: 2 }, notes: 'n', problems: [{ where: 'l03 en', what: 'name-calling', fix: 'remove "silly goose"' }] }
    expect(queue.submit(second.id, JSON.stringify(fixed))).toEqual({ accepted: true })
    const r = await done
    expect(r.retries).toBe(1)
    expect(JSON.parse(await readFile(outFile(), 'utf8'))).toMatchObject({ schema: 'cts.review/1', verdict: 'revise', problems: [{ where: 'l03 en' }] })
  })
})
