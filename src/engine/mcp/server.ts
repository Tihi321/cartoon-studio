import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import guideText from '../../../docs/mcp-guide.md?raw'
import { callTool, toolList } from './tools'
import type { Tool } from './tools'

/**
 * The MCP server object: `initialize`, `tools/list`, `tools/call` and the guide resource, on the SDK's `Server`. `http.ts` makes one per
 * HTTP session, `stdio.ts` one for the stdio transport. The tools drive the same service as the app and the CLI, so Claude Code (or
 * any agent) can see the series and the queue and do the model work of the jobs.
 *
 *   claude mcp add --transport http cartoon-studio http://127.0.0.1:7465/mcp
 *   claude mcp add cartoon-studio -- yarn --cwd <repo> engine -- mcp
 */

export const SERVER_INFO = { name: 'cartoon-studio', version: '0.0.1' }
export const GUIDE_URI = 'cartoon-studio://guide'
export const GUIDE = guideText

/** The short workflow every client gets in `initialize`; the full guide is the resource `cartoon-studio://guide`. */
export const INSTRUCTIONS = `Cartoon Studio makes a series of 3D toon cartoons for children (ages 4 to 8): Blender 5.2 builds the characters and sets once from specs and reuses them, each episode has a Croatian and an English voice track over the same animation, and Blender renders it locally to MP4. 3D (Blender) is the route for new work: pass cts_run_pipeline options.renderer "blender" for a new series (cts_blender_status checks Blender); the older cutout (canvas) renderer is kept only so the old series still lint and re-render. To make an episode from an idea use cts_run_pipeline {series, episode, brief, options: {renderer: "blender"}} (pitches, then it STOPS until the user chooses one: show them the pitches and call cts_pitch_choose; then characters, a pause until the user approves every sheet (cts_sheet_approve), sets, script, safety review, voice casting, a pause until the user approves the voices (cts_voice_approve), voices, music, Flow intro and outro clips, timelines, assemble, previews, finals; call it again to resume, cts_status shows the state and what to do next). Do the model work yourself: a role or agent set to the model client/claude-code (config/roles.md) parks its jobs; cts_wait then returns with clientTasks, and you loop cts_get_task -> write the answer -> cts_submit_task until none (cts_client_tasks lists them, cts_release_task gives one back). cts_status shows the job queue (of one series, or of all), cts_wait waits until a series has nothing left to run, cts_studios_status checks the generators (ComfyUI, Chiptune Studio, Google Flow, VibeTTS), cts_pause_all / cts_resume_all / cts_stop_now control the queue. Long calls return job ids at once. Read the resource ${GUIDE_URI} for the full guide.`

export interface McpHost {
  tools: readonly Tool[]
  /** Text of the guide resource (default: docs/mcp-guide.md). */
  guide?: string
  /** `instructions` of initialize (default: INSTRUCTIONS). */
  instructions?: string
}

export function createMcpServer(host: McpHost): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {}, resources: {} }, instructions: host.instructions ?? INSTRUCTIONS })
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolList(host.tools) }))
  // each call is its own async handler, so a long `wait` never holds back the other calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => callTool(host.tools, request.params.name, request.params.arguments))
  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [{ uri: GUIDE_URI, name: 'Cartoon Studio guide', description: 'The workflow and the tools.', mimeType: 'text/markdown' }] }))
  server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    if (request.params.uri !== GUIDE_URI) throw new Error(`Unknown resource ${request.params.uri}`)
    return { contents: [{ uri: GUIDE_URI, mimeType: 'text/markdown', text: host.guide ?? GUIDE }] }
  })
  return server
}
