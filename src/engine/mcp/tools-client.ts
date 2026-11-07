import { z } from 'zod'
import { DEFAULT_LEASE_MS } from '../models/client'
import type { ClientTask } from '../models/client'
import type { ChatMessage } from '../models/types'
import type { CtsService } from '../service'
import { ToolOutput } from './tools'
import type { McpOptions, Tool, ToolDef } from './tools'

const JSON_OUTPUT = 'Reply with one JSON object that matches `schema`. No prose, no code fence.'
const WEB_SEARCH_OUTPUT =
  'This is a web search: do it yourself with your own web search and fetch tools, read the pages, and prefer primary, official and recent sources. Reply with one JSON object that matches `schema`: {results: [{title, url, content, published?}]}, where content is a verbatim excerpt of the page (at most 1500 characters) and url is a page you really read. Never invent a URL. An empty results list is fine when you find nothing. No prose, no code fence.'
const TEXT_OUTPUT = 'Reply with the text only: no preamble, no notes, no code fence.'

/** A message's text, with `[image n]` where an image sat. `seen` counts the images across the messages. */
function textOf(m: ChatMessage, seen: { n: number }): string {
  if (typeof m.content === 'string') return m.content
  return m.content.map((p) => (p.type === 'text' ? p.text : `[image ${++seen.n}]`)).join('\n')
}

/**
 * What `cts_get_task` shows of a leased task. Every text goes out once. A single turn (one user message) is `system` + `user`; a task with
 * several turns (a repair round) is `system` + `messages` (the turns after the system text, in order) and no `user`.
 */
export function taskView(t: ClientTask): { view: Record<string, unknown>; images: { mime: string; data: string }[] } {
  const seen = { n: 0 }
  const texts = t.messages.map((m) => ({ role: m.role, content: textOf(m, seen) }))
  const system = texts.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const turns = texts.filter((m) => m.role !== 'system')
  const multi = turns.filter((m) => m.role === 'user').length > 1 || turns.some((m) => m.role === 'assistant')
  const view: Record<string, unknown> = {
    taskId: t.id,
    meta: { job: t.job, call: t.call, role: t.role, task: t.task, series: t.book, agent: t.agent, unit: t.unit, client: t.client },
    turns: multi ? 'multi' : 'single',
    system,
    ...(multi ? { messages: turns } : { user: turns.map((m) => m.content).join('\n\n') }),
    ...(t.schema ? { schema: t.schema } : {}),
    ...(t.maxTokens ? { maxTokens: t.maxTokens } : {}),
    output: t.task === 'web_search' ? WEB_SEARCH_OUTPUT : t.schema ? JSON_OUTPUT : TEXT_OUTPUT,
    leaseMinutes: DEFAULT_LEASE_MS / 60_000
  }
  if (t.images?.length) view.images = `${t.images.length} image(s) follow as image content, in order ([image 1] ...)`
  return { view, images: t.images ?? [] }
}

/** The tools that let an MCP client answer the model calls of a `client/...` model (the engine's client task queue). */
export function clientTools(svc: CtsService, def: ToolDef, opts: McpOptions): Tool[] {
  const queue = () => opts.clientQueue ?? svc.deps.registry.clientQueue
  return [
    def(
      'cts_client_tasks',
      'List the model calls waiting for you (roles or agents set to a client/... model, for example client/claude-code) and the ones leased to a client. See the guide section "Do the model work yourself".',
      z.object({}),
      async () => ({ ...queue().counts(), tasks: queue().list() })
    ),
    def(
      'cts_get_task',
      'Take the oldest waiting model call (leased to you for 30 minutes). Returns the prompt, each text once (`turns: single` gives system and user; `turns: multi`, a repair round, gives system and messages, the turns in order, and no user), the JSON schema if the answer must be JSON, and how to answer. Write the answer and send it with cts_submit_task. Vision tasks (frame-critic) also return the images. {none: true} when nothing waits. A task is for one client model: without `client` you get the claude-code ones; Antigravity passes client: "antigravity".',
      z.object({
        client: z.string().optional().describe('The client model you are, the id after client/: claude-code (the default) or antigravity. Antigravity passes client: "antigravity"'),
        role: z.string().optional().describe('Only a task of this role, for example showrunner or writer'),
        series: z.string().optional().describe('Only a task of this series (slug)'),
        task: z.string().optional().describe('Only this task, for example pitches or script')
      }),
      async (a) => {
        const t = queue().lease({ client: a.client, role: a.role, book: a.series, task: a.task }, DEFAULT_LEASE_MS)
        if (!t) return { none: true, waiting: queue().counts().waiting }
        const { view, images } = taskView(t)
        return images.length ? new ToolOutput(view, images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mime }))) : view
      }
    ),
    def(
      'cts_submit_task',
      'Answer a task from cts_get_task. When the task has a schema the text is checked: a failed check returns {accepted: false, problems} and the task stays yours, so fix the text and submit again.',
      z.object({ taskId: z.string().describe('The taskId from cts_get_task'), text: z.string().describe('The answer: one JSON object when the task has a schema, else the text only') }),
      async (a) => queue().submit(a.taskId, a.text)
    ),
    def('cts_release_task', 'Give a task back without answering it, so another client can take it.', z.object({ taskId: z.string() }), async (a) => ({ released: queue().release(a.taskId) }))
  ]
}
