#!/usr/bin/env node
/**
 * The studio's browser harness: builds the renderer, loads it in headless Chromium (Playwright; the bundled Chromium, else Microsoft Edge)
 * with a MOCKED `window.cartoonstudio`, visits every page, screenshots each at 1280x800 and fails on a console error or a page error.
 * CTS-09 (the studio UI) extends it to the eight views on the pilot data. Nothing touches ~/CartoonStudio, no service is started and no key
 * is read.
 *
 *   node scripts/studio-shots.mjs [--out <dir>] [--no-build]
 *
 *   --out <dir>   where the screenshots go (default .claude/temp/screens/studio)
 *   --no-build    reuse the renderer build of the last run
 *
 * Exit 0 = every page loaded without a console error, 1 = a failed check, 3 = no browser can be launched.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const OUT = path.resolve(ROOT, opt('out', '.claude/temp/screens/studio'))
const DIST = path.join(ROOT, '.claude', 'temp', 'studio-harness', 'dist')
const PAGES = ['series', 'models', 'agents', 'settings']
const failures = []
const fail = (m) => {
  failures.push(m)
  console.error(`FAIL ${m}`)
}

async function buildRenderer() {
  if (args.includes('--no-build') && fs.existsSync(path.join(DIST, 'index.html'))) return
  const { build } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  fs.rmSync(DIST, { recursive: true, force: true })
  await build({
    root: path.join(ROOT, 'src', 'renderer'),
    configFile: false,
    base: './',
    logLevel: 'warn',
    plugins: [react()],
    build: { outDir: DIST, emptyOutDir: true, minify: false }
  })
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'index.html'
    if (rel === 'favicon.ico') {
      res.writeHead(204).end()
      return
    }
    const file = path.join(DIST, rel)
    if (!file.startsWith(DIST) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/** What the mocked bridge installs before the page scripts run: it answers `snapshot` and `listSeries` like the engine does. */
function bridge() {
  const listeners = []
  const emit = (e) => setTimeout(() => listeners.forEach((l) => l(e)), 0)
  const at = new Date().toISOString()
  window.cartoonstudio = {
    on(h) {
      listeners.push(h)
      emit({ type: 'engine.ready', pid: 1, dataDir: 'C:\\harness\\CartoonStudio', at })
      return () => listeners.splice(listeners.indexOf(h), 1)
    },
    send(cmd) {
      if (cmd.type === 'snapshot') {
        emit({
          type: 'snapshot',
          dataDir: 'C:\\harness\\CartoonStudio',
          uptimeMs: 1,
          paused: false,
          agents: [],
          models: [],
          providers: [],
          roleDefaults: {},
          servers: [],
          spend: { today: 0, month: 0, dailyCap: 0, monthlyCap: 0 },
          running: [],
          settings: { fallbacks: ['client/claude-code'], fallbackShared: false, lmstudioParallel: 4, lmstudioContext: 131072, lmstudioTtlMinutes: 60 },
          secretsSet: [],
          keyNames: [],
          at
        })
      }
      if (cmd.type === 'listSeries') emit({ type: 'series.listed', series: [] })
      if (cmd.type === 'mcpStatus') emit({ type: 'mcp.status', enabled: true, listening: true, url: 'http://127.0.0.1:7465/mcp', error: '', port: 7465, tokenSet: false })
    }
  }
}

async function launch(chromium) {
  for (const opts of [{}, { channel: 'msedge' }, { channel: 'chrome' }]) {
    try {
      return await chromium.launch({ headless: true, ...opts })
    } catch {
      /* try the next one */
    }
  }
  return null
}

async function main() {
  await buildRenderer()
  const { chromium } = await import('playwright-core')
  const browser = await launch(chromium)
  if (!browser) {
    console.error('No browser can be launched (install Chromium with `yarn playwright install chromium`, or Microsoft Edge).')
    process.exit(3)
  }
  fs.mkdirSync(OUT, { recursive: true })
  const server = await serve()
  const url = `http://127.0.0.1:${server.address().port}/index.html`
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  const problems = []
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`))
  page.on('response', (r) => r.status() >= 400 && problems.push('http ' + r.status() + ': ' + r.url()))
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`))
  await page.addInitScript(bridge)
  await page.goto(url)
  await page.waitForSelector('[data-testid="brand"]')
  for (const id of PAGES) {
    await page.click(`[data-testid="nav-${id}"]`)
    await page.waitForSelector('main')
    await page.screenshot({ path: path.join(OUT, `${id}.png`) })
    console.log(`ok   ${id} -> ${path.join(OUT, `${id}.png`)}`)
  }
  await page.click('[data-testid="nav-series"]')
  try {
    await page.waitForSelector('[data-testid="series-empty"]', { timeout: 5000 })
  } catch {
    fail('the Series view did not show its empty state')
  }
  for (const p of problems) fail(p)
  await browser.close()
  server.close()
  if (failures.length) process.exit(1)
  console.log('studio-shots passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
