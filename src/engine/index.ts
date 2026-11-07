import path from 'node:path'
import { keySet, probe } from './cli'
import { runStdioMcp } from './mcp/stdio'
import { Engine } from './engine'
import { argValue, initDataFolder, resolveDataDir } from './store/dataFolder'
import { acquireEngineLock, EngineLockHeldError } from './store/lock'
import { watchDataFolder } from './store/watcher'
import { getParentPort, ParentPortTransport, StdoutTransport } from './transport'
import type { EngineTransport } from '../shared/protocol'

const USAGE = `Cartoon Studio engine

Usage:
  yarn engine [--data <dir>] [--seed <dir>] [--once] [--heartbeat <ms>]
  yarn mcp [--port <n>] [--data <dir>]   the engine without Electron, serving MCP over HTTP (= node out/engine/index.js --mcp-only)
  yarn engine probe [--model <provider/model>] [--data <dir>]
  yarn key:set <ENV_NAME>
  yarn engine -- mcp                  the MCP server on stdio: relays to the running engine's MCP, else runs its own (claude mcp add cartoon-studio -- yarn engine -- mcp)

  --data <dir>      Data folder. Default: CTS_DATA, else ~/CartoonStudio
  --seed <dir>      Seed folder to copy from. Default: the repo's seed/ (or CTS_SEED)
  --once            Create the data folder from the seed and exit
  --heartbeat <ms>  Heartbeat interval. Default 3000
  --mcp-only        Serve MCP over HTTP (config/mcp.md, even when it is off there) and print "MCP listening on <url>"; exit 1 if the port or the data folder is taken
  --port <n>        With --mcp-only: the MCP port (default: config/mcp.md, else 7465; CTS_MCP_PORT, CTS_MCP_TOKEN)
  probe             Stream one short reply from Strata (or --model) and embed one string
  key-set <NAME>    Store an API key in the Windows credential store (hidden prompt); NAME may also be fal or recraft
`

function log(message: string): void {
  process.stdout.write(`[engine] ${message}\n`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'))
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE)
    return
  }
  if (argv[0] === 'probe') {
    process.exitCode = await probe(argv.slice(1))
    return
  }
  if (argv[0] === 'mcp') {
    process.exitCode = await runStdioMcp(argv.slice(1))
    return
  }
  if (argv[0] === 'key-set') {
    process.exitCode = await keySet(argv.slice(1))
    return
  }

  const once = argv.includes('--once') || argv.includes('--init-only')
  const heartbeatMs = Number(argValue(argv, 'heartbeat') ?? 3000)
  const dataDir = resolveDataDir({ argv })
  const mcpOnly = argv.includes('--mcp-only')
  const portArg = argValue(argv, 'port')
  const mcpPort = portArg === undefined ? undefined : Number(portArg)
  if (mcpPort !== undefined && !(Number.isInteger(mcpPort) && mcpPort >= 0 && mcpPort <= 65535)) {
    process.stderr.write(`[engine] --port must be a port number, not "${portArg}"\n`)
    process.exitCode = 1
    return
  }
  const parentPort = getParentPort()
  // headless MCP has no one reading engine events: stdout stays for the "MCP listening" line
  const transport: EngineTransport = parentPort ? new ParentPortTransport(parentPort) : mcpOnly ? { send: () => undefined, onMessage: () => () => undefined, close: () => undefined } : new StdoutTransport()

  // one engine per data folder: a second one would re-queue the first one's running jobs
  const lock = once
    ? undefined
    : await acquireEngineLock(dataDir).catch((err: unknown) => {
        if (!(err instanceof EngineLockHeldError)) throw err
        process.stderr.write(`[engine] ${err.message}\n`)
        transport.send({ type: 'engine.warning', message: err.message })
        return null
      })
  if (lock === null) {
    process.exitCode = 1
    return
  }

  const seed = argValue(argv, 'seed')
  const init = await initDataFolder(dataDir, seed ? path.resolve(seed) : undefined)
  log(`data folder: ${dataDir}`)
  log(`seed: copied ${init.copied.length} file(s), kept ${init.skipped.length} existing, created ${init.createdDirs} folder(s)`)
  if (init.updated.length) log(`seed: updated ${init.updated.length} seeded file(s) you had not changed: ${init.updated.join(', ')}`)
  if (init.migrated.length) log(`seed: applied ${init.migrated.length} one-time migration(s) to your config: ${init.migrated.join(', ')}`)
  if (init.updateAvailable.length) log(`seed: update available for ${init.updateAvailable.length} seeded file(s) you edited (yours are kept): ${init.updateAvailable.join(', ')}`)
  if (once) return

  const startedAt = Date.now()
  const engine = new Engine({ dataDir, emit: (e) => transport.send(e), log, lock })
  await engine.start()
  const watcher = watchDataFolder(dataDir, (e) => {
    log(`changed: ${e.kind} ${e.change} ${e.rel}`)
    void engine.handleWatch(e)
  })
  await watcher.ready
  const mcp = await engine.startMcp({ port: mcpPort, force: mcpOnly })
  if (mcpOnly) {
    if (!mcp.listening) {
      process.stderr.write(`[engine] ${mcp.error || 'the MCP server did not start'}\n`)
      await watcher.close()
      await engine.stop()
      process.exit(1)
    }
    process.stdout.write(`MCP listening on ${mcp.url}\n`)
  }
  transport.onMessage((cmd) => {
    engine.handleCommand(cmd).catch((err) => log(`command ${cmd.type} failed: ${(err as Error).message}`))
  })

  let n = 0
  const beat = setInterval(() => {
    n++
    transport.send({ type: 'engine.heartbeat', n, at: new Date().toISOString(), uptimeMs: Date.now() - startedAt })
  }, heartbeatMs)

  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    clearInterval(beat)
    await watcher.close()
    await engine.stop()
    transport.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())

  transport.send({ type: 'engine.ready', pid: process.pid, dataDir, at: new Date().toISOString() })
  transport.send({ type: 'engine.heartbeat', n: 0, at: new Date().toISOString(), uptimeMs: 0 })
}

main().catch((err) => {
  process.stderr.write(`[engine] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
})
