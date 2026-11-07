import path from 'node:path'
import type { EngineEvent } from '../shared/protocol'
import { Engine } from './engine'
import type { EngineOptions } from './engine'
import { initDataFolder, resolveDataDir } from './store/dataFolder'
import { acquireEngineLock } from './store/lock'

/**
 * Starts an engine without Electron for a command line: takes the data-folder lock, makes the data folder from the seed and starts the engine
 * (used by the stdio MCP server). `o` overrides the engine options (tests pass fakes). The caller stops it with `engine.stop()`.
 */
export async function startHeadless(argv: readonly string[], o: Partial<EngineOptions> & { print?: boolean } = {}): Promise<Engine> {
  const dataDir = resolveDataDir({ argv })
  const lock = await acquireEngineLock(dataDir)
  const seedIdx = argv.indexOf('--seed')
  const verbose = argv.includes('--verbose')
  const engine = new Engine({
    dataDir,
    lock,
    emit: (e: EngineEvent) => {
      o.emit?.(e)
    },
    log: (m) => {
      if (verbose) process.stderr.write(`[engine] ${m}\n`)
    },
    ...o
  })
  try {
    await initDataFolder(dataDir, seedIdx >= 0 && argv[seedIdx + 1] ? path.resolve(argv[seedIdx + 1]!) : undefined)
    await engine.start()
  } catch (e) {
    await lock.release()
    throw e
  }
  return engine
}
