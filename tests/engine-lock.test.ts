import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireEngineLock, EngineLockHeldError, heldMessage, LOCK_FILE, readEngineLock } from '../src/engine/store/lock'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cts-lock-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const file = () => path.join(dir, 'state', LOCK_FILE)

describe('engine.lock', () => {
  it('acquires the lock, records the pid and releases it', async () => {
    const lock = await acquireEngineLock(dir, { pid: 4242, isAlive: () => true })
    const j = JSON.parse(await readFile(file(), 'utf8')) as { pid: number; startedAt: string; mcpUrl: string | null }
    expect(j).toMatchObject({ pid: 4242, mcpUrl: null })
    expect(Number.isNaN(Date.parse(j.startedAt))).toBe(false)
    await lock.release()
    await expect(readFile(file(), 'utf8')).rejects.toThrow()
    await lock.release() // twice is fine
  })

  it('refuses while a live engine holds it, and says where its MCP is', async () => {
    const first = await acquireEngineLock(dir, { pid: 4242, isAlive: () => true })
    await first.setMcpUrl('http://127.0.0.1:7465/mcp')
    expect(await readEngineLock(dir, { isAlive: () => true })).toMatchObject({ pid: 4242, mcpUrl: 'http://127.0.0.1:7465/mcp' })
    const err = await acquireEngineLock(dir, { pid: 5555, isAlive: () => true }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EngineLockHeldError)
    expect((err as Error).message).toBe('Cartoon Studio is already running on this data folder (pid 4242). Use its MCP at http://127.0.0.1:7465/mcp or close it.')
    expect(heldMessage({ pid: 1, startedAt: '', mcpUrl: null })).toMatch(/\(pid 1\)\. Close it first\.$/)
    // a refused start leaves the owner's lock alone
    expect(JSON.parse(await readFile(file(), 'utf8'))).toMatchObject({ pid: 4242 })
  })

  it('replaces a stale lock (its process is gone) and ignores a garbage file', async () => {
    await acquireEngineLock(dir, { pid: 111, isAlive: () => true })
    expect(await readEngineLock(dir, { isAlive: () => false })).toBeNull()
    const second = await acquireEngineLock(dir, { pid: 222, isAlive: (pid) => pid !== 111 })
    expect(JSON.parse(await readFile(file(), 'utf8'))).toMatchObject({ pid: 222 })
    await second.release()
    await writeFile(file(), 'not json')
    const third = await acquireEngineLock(dir, { pid: 333 })
    expect(JSON.parse(await readFile(file(), 'utf8'))).toMatchObject({ pid: 333 })
    await third.release()
  })
})
