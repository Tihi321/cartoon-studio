import { z } from 'zod'
import { jsonSchemaOf } from '../pipeline/llm'
import type { CtsService } from '../service'
import type { ClientTaskQueue } from '../models/client'
import { clientTools } from './tools-client'
import { TOOL_MODULES } from './modules'
import { pipelineSummaries } from '../pipeline/tools'

/**
 * The MCP tools. They drive the same `CtsService` as the app, so a shared engine shows what an agent does in the UI (the service emits its
 * own events). `server.ts` serves them over HTTP and stdio, `callTool` runs one. The core tools are here (status, wait, the client task loop,
 * the queue switches, the services check); every other tool lives in a module listed in `modules.ts`.
 */

export interface Tool {
  name: string
  description: string
  schema: z.ZodType
  run: (args: never) => Promise<unknown>
}

export interface McpOptions {
  /** How long a `wait` call waits at most (ms). Default 10 minutes. */
  waitTimeoutMs?: number
  /** The queue switches of the engine (`cts_pause_all`, `cts_resume_all`, `cts_stop_now`). Without it those tools say they are unavailable. */
  control?: { setPaused(paused: boolean): Promise<void>; stopNow(opts?: { drop?: boolean; slug?: string }): Promise<void>; clearQueue(slug?: string): Promise<{ dropped: number; series: string[] }> }
  /** The engine's client task queue (model calls of `client/...` models). Default: the one of the service's registry. */
  clientQueue?: ClientTaskQueue
}

/** Makes a tool: the arguments are parsed with `schema` before `run` sees them. */
export type ToolDef = <S extends z.ZodType>(name: string, description: string, schema: S, run: (args: z.output<S>) => Promise<unknown>) => Tool
export const def: ToolDef = (name, description, schema, run) => ({ name, description, schema, run: run as Tool['run'] })

/** A tool result with extra content blocks (images) besides its data. */
export class ToolOutput {
  constructor(
    readonly data: unknown,
    readonly extra: { type: 'image'; data: string; mimeType: string }[]
  ) {}
}

/** The result of a `tools/call`: a readable text item plus the same data as `structuredContent`. */
export interface ToolResult {
  [key: string]: unknown
  /** The first block is the text; image blocks may follow. */
  content: [{ type: 'text'; text: string }, ...{ type: 'image'; data: string; mimeType: string }[]]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

const series = z.string().describe('The series slug (see the series folders in the data folder)')

/** What `wait` says when jobs wait for the client: how many tasks, and what to do. */
export function clientHint(n: number): { clientTasks?: number; hint?: string } {
  return n > 0 ? { clientTasks: n, hint: 'Model calls are waiting for you: call cts_get_task, answer with cts_submit_task, repeat until none, then cts_wait again.' } : {}
}

/**
 * The tool list, bound to a service. The core tools come first, then the tools of every module in `TOOL_MODULES` (`modules.ts`): a module is
 * a function `(svc, def, opts) => Tool[]` that builds its tools with `def(name, description, schema, run)`.
 */
export function buildTools(svc: CtsService, opts: McpOptions = {}): Tool[] {
  const timeoutMs = opts.waitTimeoutMs ?? 10 * 60_000
  const queue = () => opts.clientQueue ?? svc.deps.registry.clientQueue
  const control = () => {
    if (!opts.control) throw new Error('the queue switches are not available here')
    return opts.control
  }

  return [
    def(
      'cts_status',
      'The state of the job queue: with a series slug, the jobs of that series (queued, running, done, failed, and the failures) and its pipelines (state: running, waiting-on-user after the pitches until cts_pitch_choose, waiting-on-client, failed, done; the current step, a hint, the run summary); without one, the series in the data folder. clientTasks: the model calls waiting for you or leased (see cts_get_task).',
      z.object({ series: series.optional() }),
      async (a) => {
        if (a.series) return { series: a.series, ...(await svc.status(a.series)), pipelines: await pipelineSummaries(svc, a.series), clientTasks: queue().counts() }
        const list = await svc.listSeries()
        return { dataDir: svc.dataDir, series: await Promise.all(list.map(async (s) => ({ slug: s.slug, title: s.title, jobs: await svc.jobCounts(s.slug) }))), clientTasks: queue().counts() }
      }
    ),
    def(
      'cts_wait',
      'Wait until a series (or every series) has nothing left to run (or the timeout passes), then say how it ended. Other calls keep working while this one waits.',
      z.object({ series: series.optional().describe('Default: every series'), timeoutSeconds: z.number().positive().optional().describe('Default: 600') }),
      async (a) => {
        const r = await svc.waitIdle(a.series ?? null, { timeoutMs: Math.min(a.timeoutSeconds ? a.timeoutSeconds * 1000 : 600_000, timeoutMs) })
        return { timedOut: r.timedOut, failedJobs: r.failed, ...clientHint(r.clientTasks), ...(a.series ? { status: await svc.status(a.series) } : {}) }
      }
    ),

    // ---- generators ----
    def('cts_studios_status', 'Are ComfyUI, Chiptune Studio, flow-music-mcp (Google Flow: images, Gemini voices) and VibeTTS (local text-to-speech; a tray app that Cartoon Studio never starts) reachable, and how to start them if not.', z.object({}), async () => ({ studios: await svc.studiosStatus() })),

    // ---- model work done by the MCP client (client/... models) ----
    ...clientTools(svc, def, opts),

    // ---- queue switches ----
    def('cts_pause_all', 'Pause the whole queue: running jobs finish, no new job starts (it stays paused after a restart).', z.object({}), async () => {
      await control().setPaused(true)
      return { paused: true }
    }),
    def('cts_resume_all', 'Resume the queue.', z.object({}), async () => {
      await control().setPaused(false)
      return { paused: false }
    }),
    def(
      'cts_stop_now',
      'Pause the queue and stop every running job at once (they go back to the queue, and run again after cts_resume_all, oldest first). drop: true also deletes the queued jobs (of the series slug, or of every series).',
      z.object({ drop: z.boolean().optional().describe('Also drop the queued jobs'), slug: z.string().optional().describe('With drop: only the jobs of this series') }),
      async (a) => {
        await control().stopNow({ drop: a.drop, slug: a.slug })
        return { paused: true, stopped: true, ...(a.drop ? { dropped: true } : {}) }
      }
    ),

    // ---- the tools of the other modules (series store, voice, render, pipeline ...) ----
    ...TOOL_MODULES.flatMap((mod) => mod(svc, def, opts))
  ]
}

/** Runs one tool: the arguments are checked against its schema; a failure is an error result, never a throw. */
export async function callTool(tools: readonly Tool[], name: string, args: unknown): Promise<ToolResult> {
  const fail = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] })
  const tool = tools.find((t) => t.name === name)
  if (!tool) return fail(`unknown tool "${name}"`)
  const parsed = tool.schema.safeParse(args ?? {})
  if (!parsed.success) return fail(`invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`)
  try {
    const out = await tool.run(parsed.data as never)
    const result = out instanceof ToolOutput ? out.data : out
    const extra = out instanceof ToolOutput ? out.extra : []
    const structured = (result !== null && typeof result === 'object' && !Array.isArray(result) ? result : { result }) as Record<string, unknown>
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }, ...extra], structuredContent: JSON.parse(JSON.stringify(structured)) as Record<string, unknown> }
  } catch (e) {
    return fail((e as Error).message)
  }
}

/** The tools as `tools/list` shows them. */
export function toolList(tools: readonly Tool[]): { name: string; description: string; inputSchema: { type: 'object'; [k: string]: unknown } }[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: jsonSchemaOf(t.schema) as { type: 'object'; [k: string]: unknown } }))
}
