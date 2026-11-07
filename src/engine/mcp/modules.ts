import type { CtsService } from '../service'
import { seriesCheckTools } from '../series/tools'
import { voiceTools } from '../voice/tools'
import { imageTools } from '../images/tools'
import { renderTools } from '../render/tools'
import type { McpOptions, Tool, ToolDef } from './tools'

/**
 * The MCP tool modules. A module is a function that gets the service, the `def` helper and the options and returns its tools:
 *
 *   export function seriesTools(svc: CtsService, def: ToolDef, opts: McpOptions): Tool[] {
 *     return [def('cts_series_create', 'Create a series ...', z.object({ ... }), async (a) => { ... })]
 *   }
 *
 * To add one: import the function here and put it in `TOOL_MODULES` (one line each, so tickets that add tools do not touch each other's code).
 * `buildTools` (`tools.ts`) appends the tools of every module after the core ones, and the HTTP server, the stdio server and `tools/list`
 * all come from that one array.
 */
export type ToolModule = (svc: CtsService, def: ToolDef, opts: McpOptions) => Tool[]

export const TOOL_MODULES: ToolModule[] = [seriesCheckTools, imageTools, voiceTools, renderTools]
