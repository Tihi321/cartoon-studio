import { promises as fs } from 'node:fs'
import path from 'node:path'
import { atomicWrite } from './atomic'

/**
 * The data-folder lock: `<dataDir>/state/engine.lock` names the engine that owns the folder, so two engines never run on it
 * (the second would re-queue the first one's running jobs at start). The file holds `{pid, startedAt, mcpUrl}`; `mcpUrl` is
 * where the owner serves MCP, so a second `yarn engine -- mcp` can relay to it. A lock whose process is gone is stale and replaced.
 */

export const LOCK_FILE = 'engine.lock'

export interface LockInfo {
  pid: number
  startedAt: string
  /** The owner's MCP endpoint, or null while it has none (disabled, not bound yet). */
  mcpUrl: string | null
}

export interface LockOptions {
  pid?: number
  /** Is this process alive? Default: `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean
}

/** The message of a refused start. */
export function heldMessage(info: LockInfo): string {
  return `Cartoon Studio is already running on this data folder (pid ${info.pid}). ${info.mcpUrl ? `Use its MCP at ${info.mcpUrl} or close it.` : 'Close it first.'}`
}

export class EngineLockHeldError extends Error {
  constructor(readonly info: LockInfo) {
    super(heldMessage(info))
    this.name = 'EngineLockHeldError'
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: the process exists but is not ours
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface EngineLock {
  readonly info: LockInfo
  /** Records where this engine serves MCP (null: nowhere). */
  setMcpUrl(url: string | null): Promise<void>
  /** Removes the lock file, if it is still ours. */
  release(): Promise<void>
}

const lockPath = (dataDir: string) => path.join(dataDir, 'state', LOCK_FILE)

async function readInfo(file: string): Promise<LockInfo | null> {
  try {
    const j = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<LockInfo>
    if (typeof j.pid !== 'number') return null
    return { pid: j.pid, startedAt: String(j.startedAt ?? ''), mcpUrl: typeof j.mcpUrl === 'string' ? j.mcpUrl : null }
  } catch {
    return null
  }
}

/** The live engine that holds the folder, or null (no lock, an unreadable one, or one whose process is gone). */
export async function readEngineLock(dataDir: string, o: LockOptions = {}): Promise<LockInfo | null> {
  const info = await readInfo(lockPath(dataDir))
  return info && (o.isAlive ?? pidAlive)(info.pid) ? info : null
}

/** Takes the lock (created with `wx`). Throws `EngineLockHeldError` when a live engine holds it. */
export async function acquireEngineLock(dataDir: string, o: LockOptions = {}): Promise<EngineLock> {
  const file = lockPath(dataDir)
  const pid = o.pid ?? process.pid
  const alive = o.isAlive ?? pidAlive
  await fs.mkdir(path.dirname(file), { recursive: true })
  const info: LockInfo = { pid, startedAt: new Date().toISOString(), mcpUrl: null }
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.writeFile(file, JSON.stringify(info) + '\n', { flag: 'wx' })
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const held = await readInfo(file)
      if (held && alive(held.pid)) throw new EngineLockHeldError(held)
      // stale (or garbage): replace it. Another starter may do the same at once: wx lets only one of us win.
      if (attempt >= 5) throw new Error(`could not take ${file}`, { cause: e })
      await fs.rm(file, { force: true })
    }
  }
  const write = (next: LockInfo) => atomicWrite(file, JSON.stringify(next) + '\n')
  return {
    info,
    async setMcpUrl(url) {
      info.mcpUrl = url
      if ((await readInfo(file))?.pid === pid) await write(info)
    },
    async release() {
      if ((await readInfo(file))?.pid === pid) await fs.rm(file, { force: true })
    }
  }
}
