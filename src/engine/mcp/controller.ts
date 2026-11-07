import type { EngineEvent } from '../../shared/protocol'
import type { EngineLock } from '../store/lock'
import path from 'node:path'
import { existsSync } from 'node:fs'
import type { CtsService } from '../service'
import { loadMcpConfig, saveMcpConfigFile } from './config'
import type { McpConfig } from './config'
import { McpHttpServer } from './http'
import type { McpHttpStatus } from './http'
import { buildTools } from './tools'
import type { McpOptions } from './tools'

/** The built player (`out/player`), found next to the engine bundle (`out/engine`) or in the repo; `CTS_PLAYER_DIR` overrides it. */
export function findPlayerDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CTS_PLAYER_DIR) return path.resolve(env.CTS_PLAYER_DIR)
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'player')
    if (existsSync(path.join(candidate, 'index.html'))) return candidate
    const outPlayer = path.join(dir, 'out', 'player')
    if (existsSync(path.join(outPlayer, 'index.html'))) return outPlayer
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export type McpStatusEvent = Extract<EngineEvent, { type: 'mcp.status' }>

export interface McpControllerOptions {
  dataDir: string
  svc: CtsService
  /** The queue switches for `cts_pause_all` and friends. */
  control: McpOptions['control']
  /** The engine's client task queue, for `cts_get_task` and friends. */
  clientQueue?: McpOptions['clientQueue']
  emit: (e: EngineEvent) => void
  log?: (message: string) => void
  /** The data-folder lock: told where the server listens, so a stdio client can relay to it. */
  lock?: EngineLock
  /** A port that wins over the config and the environment (`--mcp-only --port N`). */
  port?: number
  /** Serve even when `config/mcp.md` says `enabled: false` (headless `--mcp-only` exists to serve). */
  force?: boolean
  env?: NodeJS.ProcessEnv
  /** `McpOptions.waitTimeoutMs`. */
  waitTimeoutMs?: number
}

/** The MCP HTTP server of an engine: starts from `config/mcp.md`, follows changes to it, and reports `mcp.status`. */
export class McpController {
  private server: McpHttpServer | null = null
  private applied: McpConfig | null = null
  private http: McpHttpStatus = { running: false, url: null, sessions: 0 }
  private config: McpConfig = { enabled: false, port: 0, token: '' }
  private busy: Promise<void> = Promise.resolve()

  constructor(private readonly opts: McpControllerOptions) {}

  private log(m: string): void {
    this.opts.log?.(m)
  }

  status(): McpStatusEvent {
    const c = this.config
    return { type: 'mcp.status', enabled: c.enabled, listening: this.http.running, url: this.http.url, error: this.http.error ?? '', port: this.http.running ? Number(new URL(this.http.url!).port) : c.port, tokenSet: !!c.token }
  }

  /** Reads the config and starts the server when it is enabled. Never throws (a bind failure is in `status().error`). */
  start(): Promise<McpStatusEvent> {
    return this.queue(() => this.apply(true))
  }

  /** The config file changed: restarts the server when enabled, port or token changed. */
  reload(): Promise<McpStatusEvent> {
    return this.queue(() => this.apply(false))
  }

  /** Writes config/mcp.md (a missing token keeps the old one; an empty one clears it) and applies it. */
  save(patch: { enabled: boolean; port: number; token?: string }): Promise<McpStatusEvent> {
    return this.queue(async () => {
      await saveMcpConfigFile(this.opts.dataDir, patch)
      await this.apply(false)
    })
  }

  async stop(): Promise<void> {
    await this.queue(async () => {
      await this.stopServer()
    })
  }

  private async queue(job: () => Promise<void>): Promise<McpStatusEvent> {
    const run = this.busy.then(job, job)
    this.busy = run.catch(() => undefined)
    await run
    return this.status()
  }

  private async stopServer(): Promise<void> {
    const s = this.server
    this.server = null
    this.applied = null
    if (s) await s.stop()
    this.http = { running: false, url: null, sessions: 0 }
    await this.opts.lock?.setMcpUrl(null).catch(() => undefined)
  }

  private async apply(first: boolean): Promise<void> {
    const loaded = await loadMcpConfig(this.opts.dataDir, this.opts.env)
    const next = { ...loaded, ...(this.opts.port !== undefined ? { port: this.opts.port } : {}), ...(this.opts.force ? { enabled: true } : {}) }
    this.config = next
    // a server that could not bind is tried again on every reload
    const same = this.applied && this.applied.enabled === next.enabled && this.applied.port === next.port && this.applied.token === next.token && (this.http.running || !next.enabled)
    if (same && !first) {
      this.opts.emit(this.status())
      return
    }
    await this.stopServer()
    if (next.enabled) {
      const server = new McpHttpServer({
        host: { tools: buildTools(this.opts.svc, { control: this.opts.control, clientQueue: this.opts.clientQueue, waitTimeoutMs: this.opts.waitTimeoutMs }) },
        port: next.port,
        token: next.token,
        log: this.opts.log,
        static: { previewDir: findPlayerDir(this.opts.env), seriesRoot: path.join(this.opts.dataDir, 'series') },
        onStatus: (st) => {
          if (this.server !== server) return
          this.http = st
          this.opts.emit(this.status())
        }
      })
      this.server = server
      this.http = await server.start()
      if (this.http.running) {
        this.log(`MCP listening on ${this.http.url}`)
        await this.opts.lock?.setMcpUrl(this.http.url).catch(() => undefined)
      } else this.server = null
    }
    this.applied = next
    this.opts.emit(this.status())
  }
}
