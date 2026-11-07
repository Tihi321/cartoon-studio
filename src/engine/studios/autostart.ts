import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { readMd } from '../store/atomic'
import { loadStudiosConfig } from './config'
import type { StudiosConfig } from './config'
import type { Spawner } from './launch'

/**
 * Starts the services a job needs when they are down: Chiptune Studio and ComfyUI. The commands, ports and health URLs come
 * from the creative hub's `services.json` (one source of truth); whether a service may be started is decided here (`canStart`).
 * See `config/autostart.md`.
 */

/** The services Cartoon Studio calls and may start. */
export const KNOWN_SERVICES = ['chiptune-studio', 'comfyui'] as const
/** Never started, whatever the config says: Scriptorium resumes a paid book factory, Strata uses most of the GPU. */
export const NEVER_STARTED = ['scriptorium', 'strata']

export const DEFAULT_REGISTRY = '../creative-hub/services.json'
/** After a failed start, the same service is not started again for this long. */
export const COOLDOWN_MS = 5 * 60_000
const DEFAULT_START_TIMEOUT_S = 60
const POLL_MS = 500

/** `config/autostart.md`. */
export const autostartConfigSchema = z.object({
  enabled: z.boolean().default(true),
  registry: z.string().default(DEFAULT_REGISTRY),
  /** Can only narrow the known list. */
  services: z.array(z.string()).default([...KNOWN_SERVICES]),
  /** 0: the registry's `startTimeout`, else 60 s. */
  startTimeoutS: z.number().min(0).default(0),
  stopOnExit: z.boolean().default(false)
})
export type AutostartConfig = z.infer<typeof autostartConfigSchema>

/** `config/autostart.md`; a missing or broken file gives the defaults. `CTS_AUTOSTART=0` turns it off. */
export async function loadAutostartConfig(dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<AutostartConfig> {
  let data: Record<string, unknown> = {}
  try {
    data = (await readMd(path.join(dataDir, 'config', 'autostart.md'))).data
  } catch {
    /* defaults */
  }
  const parsed = autostartConfigSchema.safeParse(data)
  const c = parsed.success ? parsed.data : autostartConfigSchema.parse({})
  return env.CTS_AUTOSTART === '0' ? { ...c, enabled: false } : c
}

// ---- the registry (the hub's services.json) ----

const startSchema = z
  .object({
    kind: z.string().optional(),
    path: z.string().optional(),
    cwd: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional()
  })
  .passthrough()

const entrySchema = z
  .object({
    id: z.string(),
    repo: z.string().nullable().optional(),
    port: z.number().int().optional(),
    mcp: z.string().optional(),
    http: z.string().optional(),
    managed: z.boolean().optional(),
    warning: z.string().optional(),
    startTimeout: z.number().positive().optional(),
    start: startSchema.optional()
  })
  .passthrough()
export type RegistryEntry = z.infer<typeof entrySchema>

export interface Registry {
  file: string
  entries: RegistryEntry[]
}

/** Parses the hub's `services.json`. Throws a message that says what is wrong. */
export function loadRegistry(file: string): Registry {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    throw new Error(`registry ${file} cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`, { cause: e })
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (e) {
    throw new Error(`registry ${file} is not JSON (${(e as Error).message})`, { cause: e })
  }
  const list = (json as { services?: unknown })?.services
  if (!Array.isArray(list)) throw new Error(`registry ${file} has no "services" list`)
  const entries: RegistryEntry[] = []
  for (const item of list) {
    const p = entrySchema.safeParse(item)
    if (p.success) entries.push(p.data)
  }
  return { file, entries }
}

// ---- policy and plan ----

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** True when Cartoon Studio may start `entry` for a call to `url`; else the reason it may not. */
export function canStart(entry: RegistryEntry, url: string, config: Pick<AutostartConfig, 'enabled' | 'services'>): true | string {
  if (!config.enabled) return 'auto-start is off (config/autostart.md or CTS_AUTOSTART=0)'
  if (NEVER_STARTED.includes(entry.id)) return `${entry.id} is never started by Cartoon Studio`
  if (!(KNOWN_SERVICES as readonly string[]).includes(entry.id) || !config.services.includes(entry.id)) return `${entry.id} is not in the services Cartoon Studio starts`
  if (entry.managed !== true) return `${entry.id} is not managed by the hub registry`
  if (entry.warning) return `${entry.id} has a warning in the registry, so it is not started automatically`
  const kind = entry.start?.kind
  if (kind !== 'electron' && kind !== 'exe') return `${entry.id} has start kind "${kind ?? 'none'}", which Cartoon Studio does not run`
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return `"${url}" is not a URL`
  }
  if (!LOOPBACK.has(u.hostname)) return `${u.hostname} is not on this machine: a remote service is never started`
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
  if (port !== entry.port) return `port ${port} is not the registry's port ${entry.port} for ${entry.id}`
  return true
}

export interface StartPlan {
  file: string
  args: string[]
  cwd?: string
  env: NodeJS.ProcessEnv
}

const expandHome = (s: string, home: string): string => (s === '~' || /^~[\\/]/.test(s) ? home + s.slice(1) : s)

/** How to run `entry`: the program, its arguments, folder and environment; or the reason it cannot be run (nothing is spawned then). */
export function startPlan(
  entry: RegistryEntry,
  o: { studios?: Pick<StudiosConfig, 'chiptuneStudioExe'>; home?: string; env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean; platform?: NodeJS.Platform } = {}
): StartPlan | string {
  const home = o.home ?? os.homedir()
  const exists = o.exists ?? existsSync
  const win = (o.platform ?? process.platform) === 'win32'
  const start = entry.start ?? {}
  const env: NodeJS.ProcessEnv = { ...(o.env ?? process.env), ...(start.env ?? {}) }
  // the desktop app runs the engine as an Electron utility process with this set; it would turn electron.exe into node
  delete env.ELECTRON_RUN_AS_NODE
  const args = (start.args ?? []).map((a) => expandHome(a, home))
  const repo = entry.repo ? expandHome(entry.repo, home) : undefined
  if (start.kind === 'electron') {
    if (!repo) return `${entry.id} has no repo in the registry`
    const exe = entry.id === 'chiptune-studio' ? o.studios?.chiptuneStudioExe : ''
    if (exe) {
      if (!exists(exe)) return `${exe} (set in config/studios.md) does not exist`
      return { file: exe, args: ['--mcp-only'], ...(exists(repo) ? { cwd: repo } : {}), env }
    }
    if (!exists(path.join(repo, 'out'))) return `${entry.id} is not built: run hub.ps1 build ${entry.id}`
    const electron = path.join(repo, 'node_modules', 'electron', 'dist', win ? 'electron.exe' : 'electron')
    if (!exists(electron)) return `${entry.id} has no Electron at ${electron}: run yarn install in ${repo}`
    return { file: electron, args, cwd: repo, env }
  }
  if (start.kind === 'exe') {
    if (!start.path) return `${entry.id} has no start path in the registry`
    const file = expandHome(start.path, home)
    if (!exists(file)) return `${file} does not exist`
    const cwd = start.cwd ? expandHome(start.cwd, home) : repo
    return { file, args, ...(cwd ? { cwd } : {}), env }
  }
  return `${entry.id} has start kind "${start.kind ?? 'none'}", which Cartoon Studio does not run`
}

// ---- the starter ----

export interface StarterDeps {
  dataDir: string
  env?: NodeJS.ProcessEnv
  log?: (message: string) => void
  spawner?: Spawner
  /** Does the service answer? Default: GET of the entry's `http` (2xx), else a TCP connect to its port. */
  probe?: (entry: RegistryEntry) => Promise<boolean>
  /** Opens a log file for appending (writing a header line first) and returns its descriptor. */
  openLog?: (file: string, header: string) => number
  closeFd?: (fd: number) => void
  kill?: (pid: number) => Promise<void>
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  loadConfig?: () => Promise<AutostartConfig>
  loadStudios?: () => Promise<StudiosConfig>
  loadRegistry?: (file: string) => Registry
  exists?: (p: string) => boolean
  /** The last lines of a file (the reason a child exited). */
  tail?: (file: string, lines: number) => string
  home?: string
}

interface Started {
  id: string
  pid: number | undefined
  exited: boolean
}

export interface EnsureOptions {
  signal?: AbortSignal
  log?: (message: string) => void
}

const defaultProbe = async (entry: RegistryEntry): Promise<boolean> => {
  if (entry.http) {
    try {
      const r = await fetch(entry.http, { signal: AbortSignal.timeout(2000) })
      return r.ok
    } catch {
      return false
    }
  }
  const port = entry.port
  if (!port) return false
  return new Promise<boolean>((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' })
    const done = (ok: boolean) => {
      s.destroy()
      resolve(ok)
    }
    s.setTimeout(1000, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

const defaultOpenLog = (file: string, header: string): number => {
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, header)
  return openSync(file, 'a')
}

const defaultKill = (pid: number): Promise<void> =>
  new Promise((resolve) => {
    if (process.platform === 'win32') {
      const k = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      k.once('error', () => resolve())
      k.once('exit', () => resolve())
      return
    }
    try {
      process.kill(-pid)
    } catch {
      /* already gone */
    }
    resolve()
  })

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

const defaultTail = (file: string, lines: number): string => {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n')
  } catch {
    return ''
  }
}

export class ServiceStarter {
  private readonly inflight = new Map<string, Promise<true | string>>()
  private readonly failed = new Map<string, { until: number; reason: string }>()
  private readonly started: Started[] = []
  private warnedRegistry = false

  constructor(private readonly deps: StarterDeps) {}

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env
  }
  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
  private say(message: string, o?: EnsureOptions): void {
    this.deps.log?.(message)
    o?.log?.(message)
  }
  private config(): Promise<AutostartConfig> {
    return this.deps.loadConfig ? this.deps.loadConfig() : loadAutostartConfig(this.deps.dataDir, this.env)
  }
  private registry(file: string): Registry | string {
    try {
      return (this.deps.loadRegistry ?? loadRegistry)(file)
    } catch (e) {
      const msg = (e as Error).message
      if (!this.warnedRegistry) {
        this.warnedRegistry = true
        this.deps.log?.(`autostart: off, ${msg}`)
      }
      return msg
    }
  }

  /** The known service id a loopback URL belongs to (by port), or null. */
  async idForUrl(url: string): Promise<string | null> {
    const cfg = await this.config()
    if (!cfg.enabled) return null
    const reg = this.registry(cfg.registry)
    if (typeof reg === 'string') return null
    for (const e of reg.entries) if (typeof canStart(e, url, cfg) !== 'string') return e.id
    return null
  }

  /**
   * Makes sure the service answers: true when it does (already, or after starting it); else the reason it does not (nothing was started or the
   * start failed). Never throws. Concurrent calls for one service share one start; a failed start is not repeated for 5 minutes.
   */
  async ensure(id: string, url: string, o: EnsureOptions = {}): Promise<true | string> {
    const cfg = await this.config()
    if (!cfg.enabled) return 'auto-start is off (config/autostart.md or CTS_AUTOSTART=0)'
    const reg = this.registry(cfg.registry)
    if (typeof reg === 'string') return reg
    const entry = reg.entries.find((e) => e.id === id)
    if (!entry) return `${id} is not in the registry ${reg.file}`
    const ok = canStart(entry, url, cfg)
    if (ok !== true) return ok
    const probe = this.deps.probe ?? defaultProbe
    if (await probe(entry)) return true
    const running = this.inflight.get(id)
    if (running) return this.raceSignal(running, o.signal)
    if (id === 'comfyui') {
      const strata = reg.entries.find((e) => e.id === 'strata')
      if (strata && (await probe(strata))) {
        const reason = 'ComfyUI not started: Strata is running and uses most of the GPU'
        this.say(`autostart ${id}: ${reason}`, o)
        return reason
      }
    }
    const failed = this.failed.get(id)
    if (failed && this.now() < failed.until) return failed.reason
    const run = this.start(entry, reg, cfg, o).finally(() => this.inflight.delete(id))
    this.inflight.set(id, run)
    return this.raceSignal(run, o.signal)
  }

  private raceSignal(p: Promise<true | string>, signal?: AbortSignal): Promise<true | string> {
    if (!signal) return p
    if (signal.aborted) return Promise.resolve('stopped')
    return new Promise((resolve) => {
      const onAbort = () => resolve('stopped')
      signal.addEventListener('abort', onAbort, { once: true })
      void p.then((r) => {
        signal.removeEventListener('abort', onAbort)
        resolve(r)
      })
    })
  }

  private fail(id: string, reason: string, o: EnsureOptions): string {
    this.failed.set(id, { until: this.now() + COOLDOWN_MS, reason })
    this.say(`autostart ${id}: failed: ${reason}`, o)
    return reason
  }

  private async start(entry: RegistryEntry, reg: Registry, cfg: AutostartConfig, o: EnsureOptions): Promise<true | string> {
    const id = entry.id
    const studios = await (this.deps.loadStudios ? this.deps.loadStudios() : loadStudiosConfig(this.deps.dataDir, this.env)).catch(() => undefined)
    const plan = startPlan(entry, { studios, home: this.deps.home, env: this.env, exists: this.deps.exists })
    if (typeof plan === 'string') return this.fail(id, plan, o)
    const t0 = this.now()
    const logDir = path.join(path.dirname(reg.file), 'logs')
    const outFile = path.join(logDir, `${id}.out.log`)
    const errFile = path.join(logDir, `${id}.err.log`)
    const header = `--- started by Cartoon Studio ${new Date(t0).toISOString()} ---\n`
    const open = this.deps.openLog ?? defaultOpenLog
    const closeFd = this.deps.closeFd ?? closeSync
    let outFd: number | undefined
    let errFd: number | undefined
    let child: ReturnType<Spawner>
    try {
      outFd = open(outFile, header)
      errFd = open(errFile, header)
      child = (this.deps.spawner ?? spawn)(plan.file, plan.args, { cwd: plan.cwd, env: plan.env, detached: true, windowsHide: true, shell: false, stdio: ['ignore', outFd, errFd] })
    } catch (e) {
      return this.fail(id, `could not start ${plan.file}: ${(e as Error).message}`, o)
    } finally {
      // the child has its own copies; the parent never keeps them
      for (const fd of [outFd, errFd]) if (fd !== undefined) closeFd(fd)
    }
    const rec: Started = { id, pid: child.pid, exited: false }
    this.started.push(rec)
    let exitInfo: string | null = null
    child.once('exit', (code, signal) => {
      rec.exited = true
      exitInfo = `exited with code ${code ?? signal ?? '?'}`
    })
    child.once('error', (e) => {
      rec.exited = true
      exitInfo = `could not run: ${e.message}`
    })
    child.unref()
    this.say(`autostart ${id}: down, starting ${plan.file} ${plan.args.join(' ')} in ${plan.cwd ?? '.'} (pid ${child.pid ?? '?'}), log ${errFile}`, o)

    const timeoutS = cfg.startTimeoutS > 0 ? cfg.startTimeoutS : (entry.startTimeout ?? DEFAULT_START_TIMEOUT_S)
    const probe = this.deps.probe ?? defaultProbe
    const sleep = this.deps.sleep ?? defaultSleep
    const deadline = t0 + timeoutS * 1000
    for (;;) {
      if (await probe(entry)) {
        this.failed.delete(id)
        this.say(`autostart ${id}: up after ${((this.now() - t0) / 1000).toFixed(1)} s`, o)
        return true
      }
      if (exitInfo) {
        const tail = (this.deps.tail ?? defaultTail)(errFile, 20)
        return this.fail(id, `${id} ${exitInfo} before it answered (is its desktop app open and holding its lock?)${tail ? `. Last lines of ${errFile}:\n${tail}` : ''}`, o)
      }
      if (this.now() >= deadline) return this.fail(id, `${id} did not answer within ${timeoutS} s (see ${errFile})`, o)
      await sleep(POLL_MS)
    }
  }

  /** With `stopOnExit`: stops the services this run started (the process trees), those still alive. Otherwise does nothing. */
  async stopStarted(): Promise<string[]> {
    const cfg = await this.config()
    if (!cfg.stopOnExit) return []
    const stopped: string[] = []
    for (const s of this.started) {
      if (s.exited || s.pid === undefined) continue
      await (this.deps.kill ?? defaultKill)(s.pid)
      s.exited = true
      stopped.push(s.id)
      this.deps.log?.(`autostart ${s.id}: stopped (pid ${s.pid})`)
    }
    return stopped
  }
}
