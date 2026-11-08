import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { loadBlenderConfig } from './config'
import type { BlenderConfig } from './config'

/**
 * The Blender runner (HUB-30 decisions 12 and 13). The engine writes a job JSON and runs
 *
 *   blender -b --factory-startup --python-exit-code 1 --python <scripts>/run.py -- <job.json>
 *
 * with PYTHONNOUSERSITE=1. The Python side (`blender/run.py`) reads the job (`{command, ...}`), runs the command registered under that name
 * and prints one line per event on stdout: `CTS {"type":"progress"|"chunk"|"result"|"error", ...}`. Everything else goes to the log tail.
 * Later tickets add commands on the Python side only (`cts_blender.command`); this module does not change for them. Tests inject a fake
 * `BlenderRunner` with `setBlenderRunnerOverride`.
 */

export type BlenderEvent =
  | { type: 'progress'; done: number; total: number; stage?: string }
  | { type: 'chunk'; index: number; from: number; to: number; dir: string }
  | { type: 'result'; [key: string]: unknown }
  | { type: 'error'; code: string; message: string }

export type BlenderErrorCode = 'E_BLENDER_MISSING' | 'E_BLENDER_VERSION' | 'E_BLENDER_FAILED' | 'E_BLENDER_ABORTED' | (string & {})

export class BlenderError extends Error {
  /** The message without the code in front. */
  readonly detail: string
  constructor(
    readonly code: BlenderErrorCode,
    message: string,
    /** The last lines of Blender's output (E_BLENDER_FAILED). */
    readonly logTail: string[] = []
  ) {
    super(`${code}: ${message}`)
    this.detail = message
    this.name = 'BlenderError'
  }
}

export interface BlenderGpu {
  renderer: string
  vendor: string
  version: string
  backend: string
  deviceType: string
}

export type BlenderStatus =
  | { ok: true; path: string; version: string; versionLine: string; gpu: BlenderGpu | null; scriptsDir: string; gpuNote?: string }
  | { ok: false; code: BlenderErrorCode; message: string; path: string }

export interface BlenderRunOptions {
  signal?: AbortSignal
  onProgress?: (e: Extract<BlenderEvent, { type: 'progress' }>) => void
  onChunk?: (e: Extract<BlenderEvent, { type: 'chunk' }>) => void
  /** Every output line that is not a CTS event. */
  onLog?: (line: string) => void
}

export interface BlenderRunner {
  config: BlenderConfig
  /** Checks the executable and its version (once per runner) and asks the `probe` command for the GPU. Never throws: failures are `ok: false`. */
  status(): Promise<BlenderStatus>
  /** Runs one command; returns the payload of its `result` event. Throws `BlenderError`. */
  run(command: string, job: Record<string, unknown>, o?: BlenderRunOptions): Promise<Record<string, unknown>>
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess

export interface RunnerDeps {
  dataDir: string
  config: BlenderConfig
  /** The folder with `run.py`. Default: `findBlenderScripts()`. */
  scriptsDir?: string
  spawn?: SpawnFn
  env?: NodeJS.ProcessEnv
}

/** The `blender/` folder: `CTS_BLENDER_SCRIPTS`, else the first `blender/run.py` found walking up from the engine bundle (repo root, or `resources/` when packaged). */
export function findBlenderScripts(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CTS_BLENDER_SCRIPTS) return path.resolve(env.CTS_BLENDER_SCRIPTS)
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'blender')
    if (existsSync(path.join(candidate, 'run.py'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

const TAIL_LINES = 400
const FAIL_TAIL = 40

/** Kills Blender and everything it started. */
function killTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const k = nodeSpawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    k.on('error', () => child.kill())
  } else {
    child.kill('SIGKILL')
  }
}

/** Parses one stdout line: a CTS event, or null for any other output. */
export function parseCtsLine(line: string): BlenderEvent | null {
  if (!line.startsWith('CTS ')) return null
  try {
    const e = JSON.parse(line.slice(4)) as BlenderEvent
    return e && typeof e === 'object' && typeof e.type === 'string' ? e : null
  } catch {
    return null
  }
}

export function createBlenderRunner(deps: RunnerDeps): BlenderRunner {
  const config = deps.config
  const spawn = deps.spawn ?? (nodeSpawn as SpawnFn)
  const env = { ...(deps.env ?? process.env), PYTHONNOUSERSITE: '1' }
  const scriptsDir = deps.scriptsDir ?? findBlenderScripts(deps.env)
  let checked: Promise<{ version: string; versionLine: string }> | undefined
  let probed: Promise<BlenderGpu | null> | undefined

  const check = (): Promise<{ version: string; versionLine: string }> => {
    checked ??= (async () => {
      if (!config.path || !existsSync(config.path)) {
        throw new BlenderError('E_BLENDER_MISSING', `Blender was not found at ${config.path || '(empty path)'}. Install Blender ${config.version} and set the path in config/blender.md (cts_blender_config).`)
      }
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn(config.path, ['--version'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        let text = ''
        child.stdout?.on('data', (d: Buffer) => (text += d.toString()))
        child.on('error', (e) => reject(new BlenderError('E_BLENDER_MISSING', `cannot run ${config.path}: ${e.message}`)))
        child.on('close', () => resolve(text))
      })
      const line = out.split(/\r?\n/).find((l) => /^Blender \d/.test(l.trim()))?.trim() ?? ''
      const m = /^Blender (\d+)\.(\d+)(?:\.(\d+))?/.exec(line)
      if (!m) throw new BlenderError('E_BLENDER_FAILED', `${config.path} --version did not answer like Blender: ${out.slice(0, 200).trim() || '(no output)'}`)
      const version = `${m[1]}.${m[2]}.${m[3] ?? '0'}`
      if (`${m[1]}.${m[2]}` !== config.version && !config.allowUntestedVersion) {
        throw new BlenderError('E_BLENDER_VERSION', `Blender ${version} found, the scripts are written for ${config.version}.x. Install ${config.version} or set allowUntestedVersion: true in config/blender.md.`)
      }
      return { version, versionLine: line }
    })()
    // a failed check is not kept: the user may fix the path and ask again
    const current = checked
    current.catch(() => {
      if (checked === current) checked = undefined
    })
    return current
  }

  const exec = async (command: string, job: Record<string, unknown>, o: BlenderRunOptions): Promise<Record<string, unknown>> => {
    if (!scriptsDir || !existsSync(path.join(scriptsDir, 'run.py'))) throw new BlenderError('E_BLENDER_FAILED', 'blender/run.py was not found (set CTS_BLENDER_SCRIPTS to the blender folder)')
    const dir = path.join(deps.dataDir, 'state', 'blender')
    await fs.mkdir(dir, { recursive: true })
    const jobFile = path.join(dir, `job-${Date.now()}-${randomBytes(3).toString('hex')}.json`)
    await fs.writeFile(jobFile, JSON.stringify({ command, ...job }), 'utf8')
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        if (o.signal?.aborted) return reject(new BlenderError('E_BLENDER_ABORTED', 'stopped before Blender started'))
        const args = ['-b', '--factory-startup', '--python-exit-code', '1', '--python', path.join(scriptsDir, 'run.py'), '--', jobFile]
        const child = spawn(config.path, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        const tail: string[] = []
        let result: Record<string, unknown> | undefined
        let error: { code: string; message: string } | undefined
        let aborted = false
        const onAbort = () => {
          aborted = true
          killTree(child)
        }
        o.signal?.addEventListener('abort', onAbort, { once: true })
        const line = (raw: string) => {
          const l = raw.replace(/\r$/, '')
          if (!l) return
          const e = parseCtsLine(l)
          if (!e) {
            tail.push(l)
            if (tail.length > TAIL_LINES) tail.shift()
            o.onLog?.(l)
          } else if (e.type === 'progress') o.onProgress?.(e)
          else if (e.type === 'chunk') o.onChunk?.(e)
          else if (e.type === 'result') {
            const { type: _t, ...rest } = e
            result = rest
          } else if (e.type === 'error') error = { code: e.code, message: e.message }
        }
        const feed = (stream: NodeJS.ReadableStream | null) => {
          let buf = ''
          stream?.on('data', (d: Buffer) => {
            buf += d.toString('utf8')
            let i: number
            while ((i = buf.indexOf('\n')) >= 0) {
              line(buf.slice(0, i))
              buf = buf.slice(i + 1)
            }
          })
          stream?.on('end', () => buf && line(buf))
        }
        feed(child.stdout)
        feed(child.stderr)
        child.on('error', (e) => {
          o.signal?.removeEventListener('abort', onAbort)
          reject(new BlenderError('E_BLENDER_MISSING', `cannot run ${config.path}: ${e.message}`))
        })
        child.on('close', (code) => {
          o.signal?.removeEventListener('abort', onAbort)
          if (aborted) return reject(new BlenderError('E_BLENDER_ABORTED', 'stopped'))
          if (error) return reject(new BlenderError(error.code, error.message, tail.slice(-FAIL_TAIL)))
          if (code === 0 && result) return resolve(result)
          reject(new BlenderError('E_BLENDER_FAILED', code === 0 ? `${command} finished without a result` : `Blender exited with code ${code} during ${command}`, tail.slice(-FAIL_TAIL)))
        })
      })
    } finally {
      await fs.rm(jobFile, { force: true })
    }
  }

  return {
    config,
    async run(command, job, o = {}) {
      await check()
      return exec(command, job, o)
    },
    async status() {
      try {
        const { version, versionLine } = await check()
        let gpu: BlenderGpu | null = null
        let gpuNote: string | undefined
        try {
          probed ??= exec('probe', {}, {}).then((r) => (r as { gpu?: BlenderGpu | null }).gpu ?? null)
          gpu = await probed
        } catch (e) {
          probed = undefined
          gpuNote = (e as Error).message
        }
        return { ok: true, path: config.path, version, versionLine, gpu, scriptsDir: scriptsDir ?? '', ...(gpuNote ? { gpuNote } : {}) }
      } catch (e) {
        if (e instanceof BlenderError) return { ok: false, code: e.code, message: e.detail, path: config.path }
        throw e
      }
    }
  }
}

// ---------------------------------------------------------------- one runner per data folder

let override: BlenderRunner | undefined
const cache = new Map<string, { key: string; runner: BlenderRunner }>()

/** Tests: use this runner instead of Blender (`undefined` removes it). */
export function setBlenderRunnerOverride(runner: BlenderRunner | undefined): void {
  override = runner
}

/** The runner of a data folder: made from `config/blender.md`, kept (so the version is read once) until the config changes. */
export async function blenderRunnerFor(dataDir: string): Promise<BlenderRunner> {
  if (override) return override
  const config = await loadBlenderConfig(dataDir)
  const key = JSON.stringify(config)
  const hit = cache.get(dataDir)
  if (hit?.key === key) return hit.runner
  const runner = createBlenderRunner({ dataDir, config })
  cache.set(dataDir, { key, runner })
  return runner
}
