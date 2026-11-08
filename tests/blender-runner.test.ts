import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { blenderConfigSchema } from '../src/engine/blender/config'
import { BlenderError, createBlenderRunner, parseCtsLine } from '../src/engine/blender/runner'

/** The runner against a fake Blender process: version pin, missing executable, the CTS protocol and a crash. */

let dir: string
afterEach(async () => dir && (await rm(dir, { recursive: true, force: true })))

/** A fake `spawn`: `--version` prints `versionLine`; a job run prints `lines` and exits with `code`. */
function fakeSpawn(versionLine: string, lines: string[], code: number) {
  return (_cmd: string, args: string[]) => {
    const child = new EventEmitter() as ChildProcess & EventEmitter
    const stdout = new PassThrough()
    Object.assign(child, { stdout, stderr: new PassThrough(), pid: undefined })
    setImmediate(() => {
      stdout.end((args[0] === '--version' ? [versionLine, ''] : [...lines, '']).join('\n'))
      setImmediate(() => child.emit('close', args[0] === '--version' ? 0 : code))
    })
    return child
  }
}

async function setup(versionLine: string, lines: string[], code: number, over: Record<string, unknown> = {}) {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cts-blender-'))
  const exe = path.join(dir, 'blender.exe')
  await writeFile(exe, '')
  await writeFile(path.join(dir, 'run.py'), '')
  return createBlenderRunner({ dataDir: dir, scriptsDir: dir, config: blenderConfigSchema.parse({ path: exe, ...over }), spawn: fakeSpawn(versionLine, lines, code) })
}

describe('blender runner', () => {
  it('parses progress and result lines, and the version patch is free', async () => {
    const runner = await setup('Blender 5.2.9 LTS', ['hello', 'CTS {"type":"progress","done":1,"total":4,"stage":"x"}', 'CTS {"type":"result","files":["a.png"]}'], 0)
    const progress: unknown[] = []
    const logs: string[] = []
    await expect(runner.run('probe', {}, { onProgress: (e) => progress.push(e.done), onLog: (l) => logs.push(l) })).resolves.toEqual({ files: ['a.png'] })
    expect(progress).toEqual([1])
    expect(logs).toEqual(['hello'])
    expect(parseCtsLine('not an event')).toBeNull()
  })

  it('refuses another major.minor (E_BLENDER_VERSION) and a missing executable (E_BLENDER_MISSING)', async () => {
    const wrong = await setup('Blender 5.3.0', [], 0)
    await expect(wrong.status()).resolves.toMatchObject({ ok: false, code: 'E_BLENDER_VERSION' })
    const missing = createBlenderRunner({ dataDir: dir, scriptsDir: dir, config: blenderConfigSchema.parse({ path: path.join(dir, 'nope.exe') }) })
    await expect(missing.status()).resolves.toMatchObject({ ok: false, code: 'E_BLENDER_MISSING' })
  })

  it('a crash without a result is E_BLENDER_FAILED with the last 40 log lines; an error event keeps its code', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `line ${i}`)
    const crash = await setup('Blender 5.2.2', many, 1)
    const e = await crash.run('build-character', {}).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(BlenderError)
    expect(e).toMatchObject({ code: 'E_BLENDER_FAILED' })
    expect((e as BlenderError).logTail).toHaveLength(40)
    expect((e as BlenderError).logTail.at(-1)).toBe('line 59')
    const bad = await setup('Blender 5.2.2', ['CTS {"type":"error","code":"E_FACE_HIDDEN","message":"mouth buried"}'], 1)
    await expect(bad.run('build-character', {})).rejects.toMatchObject({ code: 'E_FACE_HIDDEN' })
  })
})
