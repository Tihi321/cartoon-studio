import path from 'node:path'
import { z } from 'zod'
import { readMd, writeMd } from '../store/atomic'

export const DEFAULT_MCP_PORT = 7465

/** `config/mcp.md`: the MCP HTTP server. */
export const mcpConfigSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().int().min(0).max(65535).default(DEFAULT_MCP_PORT),
  /** Empty: no token. */
  token: z.string().default('')
})
export type McpConfig = z.infer<typeof mcpConfigSchema>

const MCP_MD_BODY = '# MCP server\n\nThe MCP server of Cartoon Studio (see seed/config/mcp.md for what each field does). Settings > MCP writes this file.\n'

export const mcpConfigFile = (dataDir: string): string => path.join(dataDir, 'config', 'mcp.md')

/** `config/mcp.md`; a missing or broken file gives the defaults. `CTS_MCP_PORT` and `CTS_MCP_TOKEN` override the port and the token. */
export async function loadMcpConfig(dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<McpConfig> {
  let data: Record<string, unknown> = {}
  try {
    data = (await readMd(mcpConfigFile(dataDir))).data
  } catch {
    /* defaults */
  }
  const parsed = mcpConfigSchema.safeParse(data)
  const c = parsed.success ? parsed.data : mcpConfigSchema.parse({})
  const port = Number(env.CTS_MCP_PORT)
  return {
    ...c,
    ...(env.CTS_MCP_PORT && Number.isInteger(port) && port >= 0 && port <= 65535 ? { port } : {}),
    ...(env.CTS_MCP_TOKEN ? { token: env.CTS_MCP_TOKEN } : {})
  }
}

/** Writes the given fields to config/mcp.md (the others and the notes below the frontmatter stay). */
export async function saveMcpConfigFile(dataDir: string, patch: { enabled: boolean; port: number; token?: string }): Promise<void> {
  const file = mcpConfigFile(dataDir)
  let doc: { data: Record<string, unknown>; body: string }
  try {
    doc = await readMd(file)
  } catch {
    doc = { data: {}, body: MCP_MD_BODY }
  }
  const cur = mcpConfigSchema.safeParse(doc.data)
  const next = mcpConfigSchema.parse({ enabled: patch.enabled, port: patch.port, token: patch.token ?? (cur.success ? cur.data.token : '') })
  await writeMd(file, { ...doc.data, kind: 'mcp', ...next }, doc.body)
}
