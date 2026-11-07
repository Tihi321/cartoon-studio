#!/usr/bin/env node
/**
 * The studio's browser harness: builds the renderer, loads it in headless Chromium (Playwright; the bundled Chromium, else Microsoft Edge)
 * with a MOCKED `window.cartoonstudio` (events, commands and `call(tool, args)`), visits the eight views plus the two engine pages, screenshots
 * each and fails on a console error, a page error or a failed request. The mock answers with the fixture `mini` (tests/fixtures/mini) and
 * three pitches, and it plays a few engine events (voice clips, job progress) so the live parts of the views show. Nothing touches
 * ~/CartoonStudio, no service is started and no key is read.
 *
 *   node scripts/studio-shots.mjs [--out <dir>] [--no-build]
 *
 *   --out <dir>   where the screenshots go (default .claude/temp/screens/studio)
 *   --no-build    reuse the renderer build of the last run
 *
 * Exit 0 = every view loaded without a console error and showed what it should, 1 = a failed check, 3 = no browser can be launched.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const OUT = path.resolve(ROOT, opt('out', '.claude/temp/screens/studio'))
const DIST = path.join(ROOT, '.claude', 'temp', 'studio-harness', 'dist')
const DATA = path.join(ROOT, '.claude', 'temp', 'studio-harness', 'data')
// the fixture mini, copied, with its timelines built by the engine code, so the real player has something to play
const MINI = path.join(DATA, 'series', 'mini')
const PLAYER = path.join(ROOT, 'out', 'player')
const failures = []
const fail = (m) => {
  failures.push(m)
  console.error(`FAIL ${m}`)
}

function prepareData() {
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

/** Serves the built renderer, the fixture's files under /data/series/mini/, and the player page under /preview/ (the built player when there is one). */
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

/** The data the mocked tools answer with: the fixture `mini` plus what the fixture does not have (3 pitches, variants, renders, budget ...). */
function fixtures() {
  const bible = readJson('bible.json')
  bible.chosenPitch = null
  bible.pitches = [
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
      leads: [{ name: 'Mia', what: 'brave, a little proud' }, { name: 'Pip', what: 'a sparrow who counts' }],
      sets: ['street'],
      why: 'Counting and repetition; it is the cheapest to animate (walks and one jump).'
    }
  ]
  bible.sets = [...bible.sets, { id: 'garden', name: { hr: 'Vrt', en: 'Garden' }, description: 'a garden behind the house', file: 'sets/garden/set.json' }]
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
    return m
  }
  const rig = (id) => readJson(`cast/${id}/rig.json`)
  return {
    bible,
    rigs: { mia: rig('mia'), bobo: rig('bobo') },
    set: readJson('sets/park/set.json'),
    episode: {
      episode: readJson('episodes/ep00-mini/script.json'),
      text: { hr: readJson('episodes/ep00-mini/text/hr.json'), en: readJson('episodes/ep00-mini/text/en.json') },
      voice: { hr: manifest('hr'), en: manifest('en') },
      renders: [
        { lang: 'hr', quality: 'preview', file: 'episodes/ep00-mini/out/hr.preview.mp4', seconds: 6.4, wallSeconds: 38.2, encoder: 'h264_amf' },
        { lang: 'en', quality: 'preview', file: 'episodes/ep00-mini/out/en.preview.mp4', seconds: 5.9, wallSeconds: 35.7, encoder: 'h264_amf' },
        { lang: 'hr', quality: 'final', file: 'episodes/ep00-mini/out/hr.mp4', seconds: 6.4, wallSeconds: 172.9, encoder: 'libx264 veryfast' }
      ]
    }
  }
}

/**
 * What the mocked bridge installs before the page scripts run. It answers `snapshot`, `listSeries`, `studiosStatus` and `mcpStatus` like the
 * engine does, runs the tools of the fixture in `call`, and exposes `window.__emit(event)` so the script can play engine events.
 */
function bridge({ fix, origin }) {
  const listeners = []
  const emit = (e) => setTimeout(() => listeners.forEach((l) => l(e)), 0)
  window.__emit = emit
  const at = new Date().toISOString()
  const state = { run: 'waiting-on-user', cap: { capUsd: 0, flowCreditsCap: 50, approvedBy: 'user', approvedAt: '2026-11-07T10:00:00.000Z', note: 'user decision 7' } }
  const bible = () => ({ ...fix.bible, chosenPitch: state.chosen ?? null })
  const rigCheck = (cast, variant) => ({ cast, ...(variant ? { variant } : {}), ok: variant !== 'c', parts: fix.rigs[cast]?.parts.length ?? 0, issues: variant === 'c' ? [{ code: 'E_RIG_PART', severity: 'error', message: 'missing mouth shape "MBP"', file: `cast/${cast}/variants/c/rig.json`, where: 'face.mouth' }] : [] })
  const tools = {
    cts_series_get: () => ({ bible: bible(), state: state.run }),
    cts_series_update: () => ({ ok: true }),
    cts_pitch_choose: (a) => {
      state.chosen = a.pitch
      state.run = 'running'
      return { chosen: a.pitch }
    },
    cts_cast_get: (a) => ({
      id: a.cast,
      rig: fix.rigs[a.cast],
      ref: `cast/${a.cast}/parts/head.svg`,
      sheet: null,
      variants: [
        { variant: 'a', state: 'done', seconds: 1260, costUsd: 0, preview: `cast/${a.cast}/parts/body.svg`, chosen: true, note: 'Parts drawn by Claude as SVG from the reference.' },
        { variant: 'b', state: 'not-run', note: 'Recraft is not run: no budget.' },
        { variant: 'c', state: 'done', seconds: 2410, costUsd: 0, preview: `cast/${a.cast}/parts/feet.svg` }
      ],
      audition: { hr: 'episodes/ep00-mini/voice/hr/l01.wav', en: 'episodes/ep00-mini/voice/en/l01.wav' }
    }),
    cts_rig_check: (a) => rigCheck(a.cast, a.variant),
    cts_set_get: () => ({ set: fix.set }),
    cts_episode_get: () => ({ ...fix.episode, state: state.run }),
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
    cts_status: () => ({ series: 'mini', jobs: { queued: 1, running: 1, done: 4, failed: 1 }, running: [{ id: 'mini--render--en--r1', task: 'render', unit: 'en' }], failed: [{ id: 'mini--image--set-garden--r1', failure: 'ComfyUI did not answer on :8188' }], clientTasks: { waiting: 2, leased: 1 } }),
    cts_pause_all: () => ({ paused: true }),
    cts_resume_all: () => ({ paused: false }),
    cts_stop_now: () => ({ paused: true, stopped: true }),
    cts_render: (a) => {
      const jobId = `mini--render--${a.lang}-${a.quality}--r2`
      emit({ type: 'job.started', jobId, agent: 'renderer', task: 'render', book: 'mini' })
      emit({ type: 'job.progress', jobId, series: 'mini', task: 'render', unit: `${a.lang}-${a.quality}`, fraction: 0.42, message: 'frame 62 of 148' })
      return { jobId }
    },
    cts_client_tasks: () => ({
      waiting: 2,
      leased: 1,
      tasks: [
        { id: 'mini--script--ep00-mini--r1#1', job: 'mini--script--ep00-mini--r1', call: 1, role: 'writer', task: 'script', book: 'mini', agent: 'writer', unit: 'ep00-mini', client: 'claude-code', state: 'waiting', ageMs: 95000 },
        { id: 'mini--safety--ep00-mini--r1#1', job: 'mini--safety--ep00-mini--r1', call: 1, role: 'child-safety-reviewer', task: 'safety', book: 'mini', agent: 'safety', unit: 'ep00-mini', client: 'claude-code', state: 'waiting', ageMs: 41000 },
        { id: 'mini--rig--mia--r1#2', job: 'mini--rig--mia--r1', call: 2, role: 'character-designer', task: 'rig', book: 'mini', agent: 'designer', unit: 'mia', client: 'claude-code', state: 'leased', ageMs: 410000, leaseMsLeft: 1380000, summary: 'Draw the parts of Mia as flat SVG from ref.png' }
      ]
    }),
    cts_release_task: () => ({ released: true }),
    cts_budget_get: () => ({
      budget: state.cap,
      spentUsd: 0,
      spentCredits: 18,
      ledger: [
        { t: '2026-11-07T11:12:00.000Z', provider: 'flow', model: 'veo', what: 'intro clip, 8 s', currency: 'credits', amount: 18 },
        { t: '2026-11-07T11:40:00.000Z', provider: 'comfy', model: 'z-image-turbo', what: 'cast reference mia', currency: 'usd', amount: 0 }
      ]
    }),
    cts_budget_set: (a) => {
      state.cap = { capUsd: a.capUsd, flowCreditsCap: a.flowCreditsCap, approvedBy: a.approvedBy, approvedAt: new Date().toISOString(), note: a.note }
      return { ok: true }
    }
  }
  window.cartoonstudio = {
    fileBase: `${origin}/data`,
    on(h) {
      listeners.push(h)
      emit({ type: 'engine.ready', pid: 1, dataDir: 'C:\\harness\\CartoonStudio', at })
      return () => listeners.splice(listeners.indexOf(h), 1)
    },
    async call(tool, args) {
      await new Promise((r) => setTimeout(r, 15))
      const fn = tools[tool]
      if (!fn) return { ok: false, error: `unknown tool "${tool}"` }
      return { ok: true, result: JSON.parse(JSON.stringify(fn(args ?? {}))) }
    },
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
      if (cmd.type === 'listSeries') emit({ type: 'series.listed', series: [{ slug: 'mini', title: 'Mini Test', updatedAt: '2026-11-07T12:00:00.000Z' }] })
      if (cmd.type === 'mcpStatus') emit({ type: 'mcp.status', enabled: true, listening: true, url: `${origin}/mcp`, error: '', port: 7465, tokenSet: false })
      if (cmd.type === 'studiosStatus') {
        const s = (id, name, ok, tools, hint) => ({ id, name, ok, url: `http://127.0.0.1/${id}`, error: ok ? '' : 'not reachable', repo: '', hint: hint ?? '', tools })
        emit({ type: 'studios.status', studios: [s('comfy', 'ComfyUI', true, 0), s('chiptune', 'Chiptune Studio', true, 38), s('flow', 'flow-music-mcp', false, 0, 'Start it with: scripts\\hub.ps1 start flow-music-mcp'), s('vibetts', 'VibeTTS', true, 24)] })
      }
      if (cmd.type === 'clearSecret') emit({ type: 'secrets.updated', secretsSet: [], keyNames: ['FAL_KEY', 'RECRAFT_API_KEY'] })
    }
  }
  // the mcp.status the Settings page and the preview need, as the engine sends it once it listens
  setTimeout(() => emit({ type: 'mcp.status', enabled: true, listening: true, url: `${origin}/mcp`, error: '', port: 7465, tokenSet: false }), 30)
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
  prepareData()
  await buildRenderer()
  const { chromium } = await import('playwright-core')
  const browser = await launch(chromium)
  if (!browser) {
    console.error('No browser can be launched (install Chromium with `yarn playwright install chromium`, or Microsoft Edge).')
    process.exit(3)
  }
  fs.mkdirSync(OUT, { recursive: true })
  const server = await serve()
  const origin = `http://127.0.0.1:${server.address().port}`
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  const problems = []
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`))
  page.on('response', (r) => r.status() >= 400 && problems.push('http ' + r.status() + ': ' + r.url()))
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`))
  await page.addInitScript(bridge, { fix: fixtures(), origin })
  await page.goto(`${origin}/index.html`)
  await page.waitForSelector('[data-testid="brand"]')

  const T = (id) => `[data-testid="${id}"]`
  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) })
    console.log(`ok   ${name} -> ${path.join(OUT, `${name}.png`)}`)
  }
  const must = async (what, selector, count) => {
    try {
      await page.waitForSelector(selector, { timeout: 5000 })
      if (count !== undefined) {
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
  await page.setViewportSize({ width: 1280, height: 1500 })

  // 1. Series and bible: three pitch cards, Choose moves the series out of "waiting for you"
  await go('series')
  await must('series list', T('series-mini'))
  await must('pitch cards', '.pitch', 3)
  await must('waiting banner', T('series-waiting'))
  await shot('1-series-pitches')
  await page.click(T('pitch-p2-choose'))
  await must('chosen pill', T('pitch-p2-chosen'))
  try {
    await page.waitForSelector(T('series-waiting'), { state: 'detached', timeout: 3000 })
  } catch {
    fail('the series is still waiting for the user after a pitch was chosen')
  }
  const runState = (await page.locator(T('run-state')).first().innerText()).trim()
  if (runState !== 'running') fail(`run state after Choose is "${runState}", expected "running"`)
  await must('bible form', T('bible-title-en'))
  await shot('1-series-chosen')

  // 2. Cast: three rig variants side by side, rig check, voices
  await go('cast')
  await must('cast variants', '.variant', 3)
  await must('variant c check', T('variant-c-check'))
  await must('voice rows', T('voice-hr-play'))
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
  await page.waitForFunction(() => document.querySelector('[data-testid="line-l02-en-status"]')?.textContent === 'placeholder', null, { timeout: 5000 }).catch(() => fail('line l02 in English is not shown as a placeholder'))
  await page.waitForFunction(() => document.querySelector('[data-testid="line-l03-hr-status"]')?.textContent === 'failed', null, { timeout: 5000 }).catch(() => fail('line l03 in Croatian is not shown as failed'))
  await page.evaluate(() => window.__emit({ type: 'job.progress', jobId: 'mini--voice--en--r1', series: 'mini', task: 'voice', episode: 'ep00-mini', lang: 'en', line: 'l03', fraction: 0.5 }))
  await page.waitForFunction(() => document.querySelector('[data-testid="line-l03-en-status"]')?.textContent === 'making', null, { timeout: 5000 }).catch(() => fail('a voice.job.progress event did not mark l03 in English as being made'))
  await page.evaluate(() => window.__emit({ type: 'voice.clip', series: 'mini', episode: 'ep00-mini', lang: 'en', line: 'l03', status: 'ok', provider: 'vibetts', seconds: 1.4, file: 'voice/en/l03.wav' }))
  await page.waitForFunction(() => document.querySelector('[data-testid="line-l03-en-status"]')?.textContent === 'ok', null, { timeout: 5000 }).catch(() => fail('a voice.clip event did not mark l03 in English as ok'))
  await must('lint', T('lint-warnings'))
  await shot('4-episode')

  // 5. Timeline preview: the player frame
  await go('preview')
  await must('player frame', T('preview-player'))
  const src = await page.locator(T('preview-player')).getAttribute('src')
  if (!src || !src.includes('/preview/?') || !src.includes('preview=1') || !src.includes('series=mini') || !src.includes('lang=hr')) fail(`player url is wrong: ${src}`)
  await page.click(T('preview-lang-en'))
  await page.waitForFunction(() => document.querySelector('[data-testid="preview-player"]')?.getAttribute('src')?.includes('lang=en'), null, { timeout: 5000 }).catch(() => fail('the language switch did not change the player url'))
  await page.waitForTimeout(800)
  await shot('5-preview')

  // 6. Render and jobs
  await go('render')
  await must('queue counts', T('queue-count-running'))
  await page.click(T('render-hr-preview'))
  await must('render message', T('render-msg'))
  await page.evaluate(() => window.__emit({ type: 'job.done', jobId: 'mini--voice--hr--r1', agent: 'voice', ok: true }))
  await must('job row', T('job-mini--render--hr-preview--r2'))
  await must('renders table', '[data-testid^="render-row-"][data-testid$="-time"]', 3)
  await must('open mp4', T('render-open-hr-final'))
  await shot('6-render')

  // 7. Client tasks
  await go('tasks')
  await must('tasks', '[data-testid^="task-"][data-testid$="-state"]', 3)
  await shot('7-tasks')

  // 8. Settings: studios, providers, budget with a confirm dialog, keys
  await go('settings')
  await must('studios', '[data-testid^="studio-"][data-testid$="-state"]', 4)
  await must('budget', T('budget-credits'))
  await must('voice providers', T('voice-provider-mia-hr'))
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
