#!/usr/bin/env node
/**
 * The studio's browser harness: builds the renderer, loads it in headless Chromium (Playwright; the bundled Chromium, else Microsoft Edge)
 * with a stand-in for `window.cartoonstudio` (events, commands and `call(tool, args)`), visits the eight views plus the two engine pages,
 * screenshots each and fails on a console error, a page error or a failed request. Nothing touches ~/CartoonStudio, no key is read.
 *
 *   node scripts/studio-shots.mjs [--engine] [--out <dir>] [--no-build]
 *
 * Two modes:
 *   (default)   MOCKED tools: the bridge answers with the fixture `mini` (tests/fixtures/mini) in the shapes of the real tools, three pitches, and it plays
 *               engine events (voice clips, job progress) so the live parts of the views show.
 *   --engine    the REAL engine: starts `node out/engine/index.js --mcp-only` (CTS_AUTOSTART=0, port 7477) on a scratch data folder under
 *               .claude/temp/ that holds `mini` as a series with three pitches, and routes every `call` to it over MCP. It also renders a preview MP4
 *               (headless Chromium and ffmpeg, local, no paid call). Run `yarn build:engine` first.
 *
 *   --out <dir>   where the screenshots go (default .claude/temp/screens/studio, or studio-engine with --engine)
 *   --no-build    reuse the renderer build of the last run
 *
 * Exit 0 = every view loaded without a console error and showed what it should, 1 = a failed check, 3 = no browser can be launched.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const ENGINE = args.includes('--engine')
const ENGINE_PORT = 7477
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const OUT = path.resolve(ROOT, opt('out', ENGINE ? '.claude/temp/screens/studio-engine' : '.claude/temp/screens/studio'))
const HARNESS = path.join(ROOT, '.claude', 'temp', 'studio-harness')
const DIST = path.join(HARNESS, 'dist')
// the fixture mini, copied, with its timelines built by the engine code, so the real player has something to play
const DATA = path.join(HARNESS, ENGINE ? 'engine-data' : 'data')
const MINI = path.join(DATA, 'series', 'mini')
const PLAYER = path.join(ROOT, 'out', 'player')
const failures = []
const fail = (m) => {
  failures.push(m)
  console.error(`FAIL ${m}`)
}

const pitches = () => [
  {
    id: 'p1',
    title: { hr: 'Mia i Bobo u parku', en: 'Mia and Bobo in the park' },
    logline: { hr: 'Mia traži izgubljeni zmaj, a Bobo misli da je vjetar uzeo.', en: 'Mia looks for a lost kite and Bobo thinks the wind took it.' },
    leads: [
      { name: 'Mia', what: 'curious girl, 6, talks fast' },
      { name: 'Bobo', what: 'slow, kind bear who worries' }
    ],
    sets: ['park'],
    why: 'Two voices that differ, one set, a problem small enough for 60 seconds.'
  },
  {
    id: 'p2',
    title: { hr: 'Kiša u kutiji', en: 'Rain in a box' },
    logline: { hr: 'Bobo zatvori kišu u kutiju, ali sad nitko ne može sijati cvijeće.', en: 'Bobo traps the rain in a box, and now nobody can grow flowers.' },
    leads: [
      { name: 'Bobo', what: 'kind bear who tries too hard' },
      { name: 'Kiko', what: 'a cloud who is a bit shy' }
    ],
    sets: ['garden', 'park'],
    why: 'A cause and effect a four-year-old can follow; the cloud gives a second voice colour.'
  },
  {
    id: 'p3',
    title: { hr: 'Najdulji korak', en: 'The longest step' },
    logline: { hr: 'Mia vježba preskočiti lokvu, korak po korak.', en: 'Mia practises jumping over a puddle, step by step.' },
    leads: [
      { name: 'Mia', what: 'brave, a little proud' },
      { name: 'Pip', what: 'a sparrow who counts' }
    ],
    sets: ['street'],
    why: 'Counting and repetition; it is the cheapest to animate (walks and one jump).'
  }
]

async function prepareData() {
  fs.rmSync(DATA, { recursive: true, force: true })
  const code = `import { installMini } from './tests/fixtures/mini.ts'
import { SeriesStore } from './src/engine/series/service.ts'
import { buildTimeline } from './src/engine/anim/timeline.ts'
await installMini(process.argv[1])
const store = new SeriesStore(process.argv[1])
for (const lang of ['hr', 'en']) await buildTimeline(store, 'mini', 'ep00-mini', lang)`
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, DATA], { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(`could not build the fixture timelines (the player frame will show an error): ${(r.stderr || '').split(String.fromCharCode(10))[0]}`)
    fs.mkdirSync(path.join(DATA, 'series'), { recursive: true })
    fs.cpSync(path.join(ROOT, 'tests', 'fixtures', 'mini'), MINI, { recursive: true })
  }
  // three pitches and no choice yet (the fixture has one chosen pitch)
  const biblePath = path.join(MINI, 'bible.json')
  const bible = JSON.parse(fs.readFileSync(biblePath, 'utf8'))
  bible.pitches = pitches()
  bible.chosenPitch = null
  if (!ENGINE) bible.sets = [...bible.sets, { id: 'garden', name: { hr: 'Vrt', en: 'Garden' }, description: 'a garden behind the house', file: 'sets/garden/set.json' }]
  fs.writeFileSync(biblePath, JSON.stringify(bible, null, 2))
  if (!ENGINE) {
    // two rig variants with pose sheets (pictures from the parts), so the Cast view has something to show
    const sharp = (await import('sharp')).default
    for (const id of ['mia', 'bobo'])
      for (const v of ['a', 'c']) {
        const dir = path.join(MINI, 'cast', id, 'variants', v)
        fs.mkdirSync(dir, { recursive: true })
        await sharp(path.join(MINI, 'cast', id, 'parts', v === 'a' ? 'body.svg' : 'feet.svg')).resize(400, 300, { fit: 'contain', background: '#ffffff' }).png().toFile(path.join(dir, 'sheet.png'))
      }
  }
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

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.wav': 'audio/wav'
}

/** Serves the built renderer, the series files under /data/series/mini/ (and /files/mini/ for the player), and in mock mode the player page under /preview/. */
function serve() {
  const send = (res, file) => {
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  }
  const inside = (root, rel) => {
    const file = path.join(root, rel)
    return file.startsWith(root) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : null
  }
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0])
    const rel = url.replace(/^\/+/, '') || 'index.html'
    if (rel === 'favicon.ico') return res.writeHead(204).end()
    for (const prefix of ['data/series/mini/', 'files/mini/']) {
      if (!rel.startsWith(prefix)) continue
      const f = inside(MINI, rel.slice(prefix.length))
      return f ? send(res, f) : res.writeHead(404).end()
    }
    if (rel.startsWith('preview')) {
      const sub = rel.replace(/^preview\/?/, '') || 'index.html'
      const f = fs.existsSync(path.join(PLAYER, 'index.html')) ? inside(PLAYER, sub) : null
      if (f) return send(res, f)
      // no built player: a stand-in page so the frame has something to show
      res.writeHead(200, { 'Content-Type': TYPES['.html'] })
      return res.end('<!doctype html><title>player</title><body style="margin:0;background:#101418;color:#cfd6e4;font:14px sans-serif;display:grid;place-items:center;height:100vh">player stand-in (out/player not built)</body>')
    }
    const f = inside(DIST, rel)
    return f ? send(res, f) : res.writeHead(404).end()
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(MINI, rel), 'utf8'))

/** The data the mocked tools answer with, in the shapes of the real tools (see the tool code in src/engine/pipeline/tools.ts, images/tools.ts, render/tools.ts). */
function fixtures() {
  const manifest = (lang) => {
    const m = readJson(`episodes/ep00-mini/voice/${lang}/manifest.json`)
    if (lang === 'en') {
      m.lines.l02.status = 'placeholder'
      m.lines.l02.provider = 'placeholder'
    }
    if (lang === 'hr') {
      m.lines.l03.status = 'failed'
      m.lines.l03.provider = 'comfy'
    }
    return { allocation: m.allocation, lines: Object.fromEntries(Object.entries(m.lines).map(([id, v]) => [id, { status: v.status, provider: v.provider, seconds: v.seconds }])) }
  }
  return {
    bible: readJson('bible.json'),
    rigs: { mia: readJson('cast/mia/rig.json'), bobo: readJson('cast/bobo/rig.json') },
    set: readJson('sets/park/set.json'),
    script: readJson('episodes/ep00-mini/script.json'),
    texts: { hr: readJson('episodes/ep00-mini/text/hr.json'), en: readJson('episodes/ep00-mini/text/en.json') },
    voice: { hr: manifest('hr'), en: manifest('en') }
  }
}

/**
 * What the bridge installs before the page scripts run. It answers `snapshot`, `listSeries`, `studiosStatus` and `mcpStatus` like the engine does and
 * exposes `window.__emit(event)` so the script can play engine events. `call(tool, args)` runs the tools of the fixture in mock mode; with `engine`
 * it goes to `window.__callTool`, which the script routes to the real engine over MCP.
 */
function bridge({ fix, origin, engine, engineOrigin }) {
  const listeners = []
  const emit = (e) => setTimeout(() => listeners.forEach((l) => l(e)), 0)
  window.__emit = emit
  const at = new Date().toISOString()
  const state = { run: 'waiting-on-user', chosen: null, cap: null, renders: [] }
  const rigCheck = (cast, variant) => ({ cast, ...(variant ? { variant } : {}), ok: variant !== 'c', parts: fix.rigs[cast]?.parts.length ?? 0, issues: variant === 'c' ? [{ code: 'E_RIG_PART', severity: 'error', message: 'missing mouth shape "MBP"', file: `cast/${cast}/variants/c/rig.json`, where: 'face.mouth' }] : [] })
  const built = (s) => ({ path: s, status: 'built', startedAt: '2026-11-07T10:00:00.000', endedAt: '2026-11-07T10:20:00.000', wallSeconds: s === 'raster' ? 2410 : 1260, spendUsd: 0, spendCredits: 0, note: s === 'raster' ? 'keyed from the reference' : 'parts drawn by Claude as SVG from the reference' })
  const tools = {
    cts_series_get: () => ({
      bible: { ...fix.bible, chosenPitch: state.chosen },
      rigs: [],
      episodes: ['ep00-mini'],
      pipelines: [{ episode: 'ep00-mini', state: state.run, step: state.run === 'waiting-on-user' ? 'pitch_choice' : 'cast_sheet', hint: 'STOP: the user must choose a premise.', steps: '', }]
    }),
    cts_series_update: () => ({ bible: fix.bible }),
    cts_pitch_choose: (a) => {
      state.chosen = a.pitch
      state.run = 'running'
      return { chosenPitch: a.pitch, chosenAt: new Date().toISOString(), resumed: [] }
    },
    cts_cast_get: (a) => ({
      member: fix.bible.cast.find((c) => c.id === a.cast),
      rig: { height: fix.rigs[a.cast].height, kind: 'vector', parts: fix.rigs[a.cast].parts.map((p) => p.id), gestures: [], emotions: [] },
      variants: {
        schema: 'cts.variants/1',
        chosen: 'a',
        variants: { a: built('claude-svg'), b: { path: 'recraft-svg', status: 'not-run', startedAt: '2026-11-07T10:00:00.000', endedAt: '2026-11-07T10:00:00.000', wallSeconds: 0, spendUsd: 0, spendCredits: 0, note: 'not run: no budget' }, c: built('raster') }
      },
      checks: { chosen: rigCheck(a.cast), a: rigCheck(a.cast, 'a'), c: rigCheck(a.cast, 'c') },
      files: { ref: `cast/${a.cast}/parts/head.svg`, sheet: null }
    }),
    cts_pose_sheet: (a) => ({ file: `cast/${a.cast}/sheet.png` }),
    cts_set_get: (a) => ({ set: fix.set, layerFiles: fix.set.layers.map((l) => `sets/${a.set}/${l.src}`) }),
    cts_episode_get: () => ({
      script: fix.script,
      texts: fix.texts,
      voice: fix.voice,
      timelines: { hr: { duration: 5.4, lines: 3, clips: 0, scriptHash: 'x' }, en: { duration: 4.8, lines: 3, clips: 0, scriptHash: 'x' } },
      reviews: [],
      clips: { series: [], episode: [] },
      budget: {},
      pipeline: { state: state.run }
    }),
    cts_lint: () => ({
      series: 'mini',
      episode: 'ep00-mini',
      ok: true,
      errors: [],
      warnings: [{ code: 'W_LINE_LONG', severity: 'warning', message: 'line l03 is long for a 4 year old (14 words)', file: 'episodes/ep00-mini/text/en.json', where: 'l03', lang: 'en' }],
      rigs: [],
      stats: { lines: [], minShare: 0.72 }
    }),
    cts_timeline_build: () => ({ built: ['hr', 'en'] }),
    cts_status: () => ({ series: 'mini', jobs: { queued: 1, running: 1, done: 4, failed: 1 }, running: [{ id: 'mini--rig_build--mia-claude-svg--r1', task: 'rig_build', unit: 'mia-claude-svg' }], failed: [{ id: 'mini--image--set-garden--r1', failure: 'ComfyUI did not answer on :8188' }], clientTasks: { waiting: 2, leased: 1 } }),
    cts_pause_all: () => ({ paused: true }),
    cts_resume_all: () => ({ paused: false }),
    cts_stop_now: () => ({ paused: true, stopped: true }),
    cts_render: (a) => {
      const job = { id: `mini--render--${a.episode}-${a.langs[0]}-${a.quality}--r2`, state: 'running', progress: { done: 62, total: 148 }, startedAt: new Date().toISOString(), polls: 0 }
      state.renders.push(job)
      return { jobs: [{ ...job }] }
    },
    cts_render_status: () => {
      const abs = (f) => `C:\\harness\\CartoonStudio\\series\\mini\\${f}`
      for (const j of state.renders) if (j.state === 'running' && ++j.polls > 2) Object.assign(j, { state: 'done', progress: { done: 148, total: 148 }, result: { file: abs('episodes/ep00-mini/out/hr.preview.mp4'), seconds: 6.2, wallSeconds: 41.3, encoder: 'h264_amf', frames: 148 } })
      return {
        jobs: [
          { id: 'mini--render--ep00-mini-en-preview--r1', state: 'done', progress: { done: 120, total: 120 }, startedAt: '2026-11-07T11:00:00.000Z', result: { file: abs('episodes/ep00-mini/out/en.preview.mp4'), seconds: 5.9, wallSeconds: 35.7, encoder: 'h264_amf', frames: 120 } },
          { id: 'mini--render--ep00-mini-hr-final--r1', state: 'done', progress: { done: 130, total: 130 }, startedAt: '2026-11-07T11:10:00.000Z', result: { file: abs('episodes/ep00-mini/out/hr.mp4'), seconds: 6.4, wallSeconds: 172.9, encoder: 'libx264 veryfast', frames: 130 } },
          ...state.renders.map((j) => ({ id: j.id, state: j.state, progress: j.progress, startedAt: j.startedAt, ...(j.result ? { result: j.result } : {}) }))
        ]
      }
    },
    cts_client_tasks: () => ({
      waiting: 2,
      leased: 1,
      tasks: [
        { id: 'mini--script--ep00-mini--r1#1', job: 'mini--script--ep00-mini--r1', call: 1, role: 'writer', task: 'script', book: 'mini', agent: 'writer', unit: 'ep00-mini', client: 'claude-code', state: 'waiting', ageMs: 95000 },
        { id: 'mini--safety--ep00-mini--r1#1', job: 'mini--safety--ep00-mini--r1', call: 1, role: 'child-safety-reviewer', task: 'safety', book: 'mini', agent: 'safety', unit: 'ep00-mini', client: 'claude-code', state: 'waiting', ageMs: 41000 },
        { id: 'mini--rig--mia--r1#2', job: 'mini--rig--mia--r1', call: 2, role: 'character-designer', task: 'rig', book: 'mini', agent: 'designer', unit: 'mia', client: 'claude-code', state: 'leased', ageMs: 410000, leaseMsLeft: 1380000 }
      ]
    }),
    cts_release_task: () => ({ released: true }),
    cts_budget_get: () => {
      const c = state.cap
      return {
        approved: c !== null,
        capUsd: c?.capUsd ?? 0,
        flowCreditsCap: c?.flowCreditsCap ?? 50,
        spentUsd: 0,
        spentCredits: 18,
        leftUsd: c?.capUsd ?? 0,
        leftCredits: (c?.flowCreditsCap ?? 50) - 18,
        ledger: [
          { t: '2026-11-07T11:12:00.000', provider: 'flow', model: 'veo', what: 'intro clip, 8 s', currency: 'credits', amount: 18 },
          { t: '2026-11-07T11:40:00.000', provider: 'comfy', model: 'z-image-turbo', what: 'cast reference mia', currency: 'usd', amount: 0 }
        ]
      }
    },
    cts_budget_set: (a) => {
      state.cap = { capUsd: a.capUsd, flowCreditsCap: a.flowCreditsCap }
      return { budget: { schema: 'cts.budget/1', ...a, approvedAt: new Date().toISOString() } }
    }
  }
  state.cap = { capUsd: 0, flowCreditsCap: 50 }
  const callMock = async (tool, args) => {
    await new Promise((r) => setTimeout(r, 15))
    const fn = tools[tool]
    if (!fn) return { ok: false, error: `unknown tool "${tool}"` }
    return { ok: true, result: JSON.parse(JSON.stringify(fn(args ?? {}))) }
  }
  window.cartoonstudio = {
    fileBase: `${origin}/data`,
    on(h) {
      listeners.push(h)
      emit({ type: 'engine.ready', pid: 1, dataDir: 'C:\\harness\\CartoonStudio', at })
      return () => listeners.splice(listeners.indexOf(h), 1)
    },
    call: engine ? (tool, args) => window.__callTool(tool, args ?? {}) : callMock,
    openFile: async () => true,
    showInFolder: async () => true,
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
          secretsSet: ['FAL_KEY'],
          keyNames: ['FAL_KEY', 'RECRAFT_API_KEY'],
          at
        })
      }
      if (cmd.type === 'listSeries') {
        if (engine) void window.__callTool('cts_status', {}).then((r) => emit({ type: 'series.listed', series: (r.result?.series ?? []).map((s) => ({ slug: s.slug, title: s.title, updatedAt: at })) }))
        else emit({ type: 'series.listed', series: [{ slug: 'mini', title: 'Mini Test', updatedAt: '2026-11-07T12:00:00.000Z' }] })
      }
      if (cmd.type === 'mcpStatus') emit({ type: 'mcp.status', enabled: true, listening: true, url: `${engineOrigin}/mcp`, error: '', port: 7465, tokenSet: false })
      if (cmd.type === 'studiosStatus') {
        if (engine) void window.__callTool('cts_studios_status', {}).then((r) => emit({ type: 'studios.status', studios: r.result?.studios ?? [] }))
        else {
          const s = (id, name, ok, tools, hint) => ({ id, name, ok, url: `http://127.0.0.1/${id}`, error: ok ? '' : 'not reachable', repo: '', hint: hint ?? '', tools })
          emit({ type: 'studios.status', studios: [s('comfy', 'ComfyUI', true, 0), s('chiptune', 'Chiptune Studio', true, 38), s('flow', 'flow-music-mcp', false, 0, 'Start it with: scripts\\hub.ps1 start flow-music-mcp'), s('vibetts', 'VibeTTS', true, 24)] })
        }
      }
      if (cmd.type === 'clearSecret') emit({ type: 'secrets.updated', secretsSet: [], keyNames: ['FAL_KEY', 'RECRAFT_API_KEY'] })
    }
  }
  // the mcp.status the Settings page and the preview need, as the engine sends it once it listens
  setTimeout(() => emit({ type: 'mcp.status', enabled: true, listening: true, url: `${engineOrigin}/mcp`, error: '', port: 7465, tokenSet: false }), 30)
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

/** Starts the real engine headless on the scratch data folder and connects an MCP client to it. */
async function startEngine() {
  const entry = path.join(ROOT, 'out', 'engine', 'index.js')
  if (!fs.existsSync(entry)) throw new Error('out/engine/index.js is missing: run yarn build:engine first')
  const child = spawn(process.execPath, [entry, '--mcp-only', '--data', DATA, '--port', String(ENGINE_PORT), '--seed', path.join(ROOT, 'seed')], { cwd: ROOT, env: { ...process.env, CTS_AUTOSTART: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  const url = `http://127.0.0.1:${ENGINE_PORT}/mcp`
  const t0 = Date.now()
  while (!log.includes('MCP listening')) {
    if (child.exitCode !== null || Date.now() - t0 > 30000) throw new Error(`the engine did not start: ${log.slice(-500)}`)
    await new Promise((r) => setTimeout(r, 200))
  }
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const client = new Client({ name: 'studio-shots', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return { child, client, origin: `http://127.0.0.1:${ENGINE_PORT}` }
}

async function main() {
  await prepareData()
  await buildRenderer()
  const { chromium } = await import('playwright-core')
  const browser = await launch(chromium)
  if (!browser) {
    console.error('No browser can be launched (install Chromium with `yarn playwright install chromium`, or Microsoft Edge).')
    process.exit(3)
  }
  fs.mkdirSync(OUT, { recursive: true })
  const eng = ENGINE ? await startEngine() : null
  const server = await serve()
  const origin = `http://127.0.0.1:${server.address().port}`
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  const problems = []
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`))
  page.on('response', (r) => r.status() >= 400 && problems.push('http ' + r.status() + ': ' + r.url()))
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`))
  if (eng) {
    // every call of the studio goes to the real engine over MCP, the way an MCP client would send it
    await page.exposeFunction('__callTool', async (tool, a) => {
      try {
        const r = await eng.client.callTool({ name: tool, arguments: a }, undefined, { timeout: 300000 })
        if (r.isError) return { ok: false, error: r.content?.[0]?.text ?? 'failed' }
        return { ok: true, result: r.structuredContent ?? {} }
      } catch (e) {
        return { ok: false, error: String(e.message ?? e) }
      }
    })
  }
  await page.addInitScript(bridge, { fix: fixtures(), origin, engine: !!eng, engineOrigin: eng ? eng.origin : origin })
  await page.goto(`${origin}/index.html`)
  await page.waitForSelector('[data-testid="brand"]')

  const T = (id) => `[data-testid="${id}"]`
  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) })
    console.log(`ok   ${name} -> ${path.join(OUT, `${name}.png`)}`)
  }
  const must = async (what, selector, count, timeout = 8000) => {
    try {
      await page.waitForSelector(selector, { timeout })
      if (count !== undefined) {
        await page.waitForFunction(([s, n]) => document.querySelectorAll(s).length === n, [selector, count], { timeout: 4000 }).catch(() => undefined)
        const n = await page.locator(selector).count()
        if (n !== count) fail(`${what}: expected ${count} of ${selector}, found ${n}`)
      }
    } catch {
      fail(`${what}: ${selector} did not show`)
    }
  }
  const go = async (id) => {
    await page.click(T(`nav-${id}`))
    await must(`view ${id}`, T(`page-${id}`))
  }
  const text = async (sel) => (await page.locator(sel).first().innerText()).trim()
  await page.setViewportSize({ width: 1280, height: 1500 })

  try {
    // 1. Series and bible: three pitch cards, Choose moves the series out of "waiting for you"
    await go('series')
    await must('series list', T('series-mini'))
    await must('pitch cards', '.pitch', 3)
    await must('waiting banner', T('series-waiting'))
    await shot('1-series-pitches')
    await page.click(T('pitch-p2-choose'))
    await must('chosen pill', T('pitch-p2-chosen'))
    await page.waitForSelector(T('series-waiting'), { state: 'detached', timeout: 5000 }).catch(() => fail('the series is still waiting for the user after a pitch was chosen'))
    const runState = await text(T('run-state'))
    if (runState !== 'running') fail(`run state after Choose is "${runState}", expected "running"`)
    await must('bible form', T('bible-title-en'))
    if (eng) {
      // the choice is on disk: a fresh read of the series still shows it
      const again = await eng.client.callTool({ name: 'cts_series_get', arguments: { series: 'mini' } })
      if (again.structuredContent?.bible?.chosenPitch !== 'p2') fail('the engine did not record the chosen pitch p2')
      await page.fill(T('bible-title-en'), 'Mini Test (edited)')
      await page.click(T('bible-save'))
      await page.waitForFunction(() => document.querySelector('[data-testid="bible-msg"]')?.textContent === 'Saved.', null, { timeout: 5000 }).catch(() => fail('the bible was not saved'))
    }
    await shot('1-series-chosen')

    // 2. Cast: three rig variants side by side, rig check, voices, the pose sheet
    await go('cast')
    await must('cast variants', '.variant', 3)
    await must('rig check of the cast member', T('cast-rig-check'))
    await must('voice rows', T('voice-hr-play'))
    await must('pose sheet', `${T('cast-sheet-live')}, ${T('cast-sheet')}`)
    if (!ENGINE) {
      await must('variant c check', T('variant-c-check'))
      await must('variant pictures', `${T('variant-a-img')}`)
    }
    await page.waitForTimeout(1500)
    await shot('2-cast')

    // 3. Sets: the overlay has the four shot rectangles and five marks
    await go('sets')
    await must('set overlay', T('set-overlay'))
    await must('shot rectangles', '[data-testid^="set-shot-rect-"]', 4)
    await must('mark dots', '[data-testid^="set-mark-dot-"]', 5)
    await shot('3-sets')

    // 4. Episode: three lines, a status per language, then live events
    await go('episode')
    await must('lines', '.line-beat', 3)
    await must('hr/en text', T('line-l01-en-text'))
    if (!ENGINE) {
      await page.waitForFunction(() => document.querySelector('[data-testid="line-l02-en-status"]')?.textContent === 'placeholder', null, { timeout: 5000 }).catch(() => fail('line l02 in English is not shown as a placeholder'))
      await page.waitForFunction(() => document.querySelector('[data-testid="line-l03-hr-status"]')?.textContent === 'failed', null, { timeout: 5000 }).catch(() => fail('line l03 in Croatian is not shown as failed'))
    } else {
      await page.waitForFunction(() => document.querySelector('[data-testid="line-l01-hr-status"]')?.textContent === 'ok', null, { timeout: 5000 }).catch(() => fail('line l01 in Croatian is not shown as ok from the real manifest'))
    }
    await page.evaluate(() => window.__emit({ type: 'job.progress', jobId: 'mini--voice--en--r1', series: 'mini', task: 'voice', episode: 'ep00-mini', lang: 'en', line: 'l03', fraction: 0.5 }))
    await page.waitForFunction(() => document.querySelector('[data-testid="line-l03-en-status"]')?.textContent === 'making', null, { timeout: 5000 }).catch(() => fail('a job.progress event did not mark l03 in English as being made'))
    await page.evaluate(() => window.__emit({ type: 'voice.clip', series: 'mini', episode: 'ep00-mini', lang: 'en', line: 'l03', status: 'ok', provider: 'vibetts', seconds: 1.4, file: 'voice/en/l03.wav' }))
    await page.waitForFunction(() => document.querySelector('[data-testid="line-l03-en-status"]')?.textContent === 'ok', null, { timeout: 5000 }).catch(() => fail('a voice.clip event did not mark l03 in English as ok'))
    await page.evaluate(() => window.__emit({ type: 'job.done', jobId: 'mini--voice--en--r1', agent: 'voice', ok: true }))
    await must('lint', T('lint-warnings'))
    await shot('4-episode')

    // 5. Timeline preview: the player frame (the real player page of the engine in --engine mode)
    await go('preview')
    await must('player frame', T('preview-player'))
    const src = await page.locator(T('preview-player')).getAttribute('src')
    if (!src || !src.includes('/preview/?') || !src.includes('preview=1') || !src.includes('series=mini') || !src.includes('lang=hr')) fail(`player url is wrong: ${src}`)
    if (ENGINE && !src?.startsWith(`http://127.0.0.1:${ENGINE_PORT}/`)) fail(`the player does not come from the engine: ${src}`)
    await page.click(T('preview-lang-en'))
    await page.waitForFunction(() => document.querySelector('[data-testid="preview-player"]')?.getAttribute('src')?.includes('lang=en'), null, { timeout: 5000 }).catch(() => fail('the language switch did not change the player url'))
    await page.waitForTimeout(1200)
    await shot('5-preview')

    // 6. Render and jobs
    await go('render')
    await must('queue counts', T('queue-count-running'))
    await page.click(T('render-hr-preview'))
    await must('render message', T('render-msg'))
    await must('job row', '[data-testid^="job-mini--render--ep00-mini-hr-preview"]')
    await shot('6-render-running')
    // the finished MP4 shows up in the table (the real render takes a while)
    await must('renders table', T('render-row-hr-preview'), undefined, ENGINE ? 240000 : 15000)
    await must('open mp4', T('render-open-hr-preview'))
    await shot('6-render')

    // 7. Client tasks
    await go('tasks')
    if (ENGINE) await must('no task parked', T('tasks-empty'))
    else await must('tasks', '[data-testid^="task-"][data-testid$="-state"]', 3)
    await shot('7-tasks')

    // 8. Settings: studios, providers, budget with a confirm dialog, keys
    await go('settings')
    await must('studios', '[data-testid^="studio-"][data-testid$="-state"]', 4)
    await must('budget', T('budget-credits'))
    await must('voice providers', T('voice-provider-mia-hr'))
    if (ENGINE && !(await page.locator(T('budget-unset')).count())) fail('an episode without a budget file should say that no budget is set')
    await shot('8-settings')
    await page.click(T('budget-edit'))
    await must('cap dialog', T('cap-dialog'))
    if (!(await page.locator(T('cap-save')).isDisabled())) fail('the cap can be saved without a confirmation')
    await page.fill(T('cap-usd'), '1.5')
    await page.fill(T('cap-note'), 'pilot extra')
    await page.check(T('cap-confirm'))
    await page.click(T('cap-save'))
    await page.waitForSelector(T('cap-dialog'), { state: 'detached', timeout: 5000 }).catch(() => fail('the cap dialog did not close after saving'))
    await page.waitForFunction(() => document.querySelector('[data-testid="budget-usd"]')?.textContent?.includes('$1.50'), null, { timeout: 5000 }).catch(() => fail('the new cap is not shown'))
    if ((await page.locator(T('set-key-value')).inputValue()) !== '') fail('the key box is not empty')

    // the two engine pages inherited from the scaffold
    await page.click(T('nav-models'))
    await page.waitForTimeout(300)
    await shot('9-models')
    await page.click(T('nav-agents'))
    await must('agents view', T('page-agents'))
    await shot('10-agents')
  } catch (e) {
    fail(`the harness stopped: ${e.message}`)
  }

  for (const p of problems) fail(p)
  await browser.close()
  server.close()
  if (eng) {
    await eng.client.close().catch(() => undefined)
    eng.child.kill()
  }
  if (failures.length) process.exit(1)
  console.log(`studio-shots passed${ENGINE ? ' (real engine)' : ' (mocked tools)'}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
