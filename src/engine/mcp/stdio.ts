import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolveDataDir } from '../store/dataFolder'
import { EngineLockHeldError, readEngineLock } from '../store/lock'
import { startHeadless } from '../headless'
import { loadMcpConfig } from './config'
import { createRelay } from './relay'
import { createMcpServer } from './server'
import { buildTools } from './tools'

/**
 * `yarn engine -- mcp`: MCP on stdio for clients that cannot speak HTTP. When an engine already runs on the data folder (the app, or
 * `yarn mcp`) the stdio side relays to its HTTP endpoint, so the app shows what the agent does and there is still one engine. Otherwise
 * it starts its own engine (taking the data-folder lock) and serves the tools itself. stdout is the protocol: everything else goes to stderr.
 */
export async function runStdioMcp(argv: readonly string[]): Promise<number> {
  const err = (m: string) => process.stderr.write(`${m}\n`)
  const dataDir = resolveDataDir({ argv })
  const live = await readEngineLock(dataDir)
  if (live) {
    if (!live.mcpUrl) {
      err(`Cartoon Studio is already running on this data folder (pid ${live.pid}) and it has no MCP endpoint (its MCP server is off in config/mcp.md, or it is another stdio session). Close it, or turn the server on in Settings > MCP.`)
      return 1
    }
    err(`relaying to the running Cartoon Studio at ${live.mcpUrl}`)
    const relay = createRelay({ url: live.mcpUrl, token: (await loadMcpConfig(dataDir)).token, stdio: new StdioServerTransport(), log: err })
    await relay.start()
    await new Promise<void>((resolve) => {
      const stop = (): void => resolve()
      process.stdin.once('end', stop)
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
    await relay.close()
    return 0
  }
  let engine
  try {
    engine = await startHeadless(argv, { print: false })
  } catch (e) {
    if (!(e instanceof EngineLockHeldError)) throw e
    err(e.message)
    return 1
  }
  const server = createMcpServer({ tools: buildTools(engine.cts, { control: engine.mcpControl(), clientQueue: engine.clientQueue }) })
  await server.connect(new StdioServerTransport())
  await new Promise<void>((resolve) => {
    const stop = (): void => resolve()
    process.stdin.once('end', stop)
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  await server.close().catch(() => undefined)
  await engine.stop()
  return 0
}
