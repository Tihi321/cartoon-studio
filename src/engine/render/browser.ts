/// <reference lib="dom" />
import { existsSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { chromium } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { serveStatic } from '../mcp/static'

/**
 * The headless Chromium of the render and the small static server it loads the player from.
 *
 * The render does not depend on the MCP server running (or on its token): `startPlayerServer` serves the built player at `/preview/` and the
 * series folders at `/files/<series>/...` on a random 127.0.0.1 port, with the same routes and path guard as `mcp/static.ts` (it reuses
 * `serveStatic`). `withPlayer` opens one page on it; the page API is in `docs/player.md`.
 */

/** The built player (out/player: has an assets folder; src/player is the source and has none), found next to the engine bundle or in the repo; CTS_PLAYER_DIR overrides it. */
export function findPlayerDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CTS_PLAYER_DIR) return path.resolve(env.CTS_PLAYER_DIR)
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    for (const candidate of [path.join(dir, 'player'), path.join(dir, 'out', 'player')]) if (existsSync(path.join(candidate, 'index.html')) && existsSync(path.join(candidate, 'assets'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export interface PlayerServer {
  /** `http://127.0.0.1:<port>` */
  origin: string
  close(): Promise<void>
}

export interface ServerOptions {
  dataDir: string
  /** The built player folder (default: `findPlayerDir()`: `out/player`, or `CTS_PLAYER_DIR`). */
  playerDir?: string
}

export async function startPlayerServer(opts: ServerOptions): Promise<PlayerServer> {
  const previewDir = opts.playerDir ?? findPlayerDir()
  if (!previewDir) throw new Error('the player is not built (out/player is missing): run `yarn build:player` or `yarn build:engine`')
  const roots = { previewDir, seriesRoot: path.join(opts.dataDir, 'series') }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    serveStatic(req, res, url.pathname, roots).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
  }
}

/** Launches Chromium: the bundled one when installed, else the system Edge. Throws a clear message when neither starts. */
export async function launchBrowser(): Promise<Browser> {
  const args = ['--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text']
  try {
    return await chromium.launch({ headless: true, args })
  } catch (bundled) {
    try {
      return await chromium.launch({ headless: true, channel: 'msedge', args })
    } catch (edge) {
      throw new Error(`no browser to render with: bundled Chromium failed (${firstLine(bundled)}), Edge failed (${firstLine(edge)}). Run \`npx playwright install chromium\`.`, { cause: edge })
    }
  }
}

const firstLine = (e: unknown): string => String((e as Error).message ?? e).split('\n')[0]!

export interface PlayerSession {
  page: Page
  origin: string
}

/** Runs `fn` with a page on the player (`/preview/`, nothing loaded yet); the page, browser and server are closed afterwards. */
export async function withPlayer<T>(opts: ServerOptions & { query?: string }, fn: (s: PlayerSession) => Promise<T>): Promise<T> {
  const server = await startPlayerServer(opts)
  let browser: Browser | null = null
  try {
    browser = await launchBrowser()
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
    await page.goto(`${server.origin}/preview/${opts.query ?? ''}`)
    await page.waitForFunction(() => (window as unknown as { cts?: unknown }).cts !== undefined)
    return await fn({ page, origin: server.origin })
  } finally {
    await browser?.close().catch(() => undefined)
    await server.close()
  }
}
