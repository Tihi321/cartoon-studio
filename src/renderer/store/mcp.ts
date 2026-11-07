import type { EngineEvent } from '../../shared/protocol'

/** The MCP server state the Settings page shows: `null` until the engine answered `mcpStatus`. */
export type McpView = Extract<EngineEvent, { type: 'mcp.status' }>

export interface McpData {
  mcp: McpView | null
}

export const initialMcp = (): McpData => ({ mcp: null })

export function reduceMcp(_s: McpData, e: EngineEvent): Partial<McpData> {
  return e.type === 'mcp.status' ? { mcp: e } : {}
}
