import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerSaveBlocker, protocol, shell, Tray } from 'electron'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isCommand } from '../shared/protocol'
import type { EngineEvent, ToolCallResult } from '../shared/protocol'
import { FILE_SCHEME } from '../renderer/hostApi'
import { argValue, resolveDataDir } from '../engine/store/dataFolder'
import { readEngineLock } from '../engine/store/lock'
import { startEngine } from './engineClient'
import { fileUrlToPath, parseRange, readFileInside, resolveInside, tailFileInside } from './files'

const EVENT_CHANNEL = 'engine:event'
const COMMAND_CHANNEL = 'engine:command'

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let dataDir: string | null = null
let allPaused = false
let loginItemInMemory = false
// set when the engine ended because another engine holds the data folder: the window shows it (persistently) once it has loaded
let engineBlocked: EngineEvent | null = null
const runningJobs = new Set<string>()
let blockerId: number | null = null
// tool calls from the renderer (window.cartoonstudio.call) waiting for their `tool.result`
const pendingCalls = new Map<string, (r: ToolCallResult) => void>()
let callSeq = 0
const CALL_TIMEOUT_MS = 15 * 60_000

// --mcp-only: headless MCP, no window and no tray (the engine runs with --mcp-only and serves MCP over HTTP).
const mcpOnly = process.argv.includes('--mcp-only')
// CTS_NO_WINDOW=1 runs the engine without the main window (for scripted checks).
const noWindow = process.env.CTS_NO_WINDOW === '1' || mcpOnly
const startHidden = process.argv.includes('--hidden')
// Series files (parts, sets, voices, clips) are served by this scheme, from the data folder only (see files.ts).
protocol.registerSchemesAsPrivileged([{ scheme: FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])

function forwardedEngineArgs(): string[] {
  const i = process.argv.findIndex((a) => a === '--data')
  const value = i >= 0 ? process.argv[i + 1] : undefined
  const args = value ? ['--data', value] : []
  if (mcpOnly) {
    args.push('--mcp-only')
    const port = argValue(process.argv, 'port')
    if (port) args.push('--port', port)
  }
  // The engine cannot find `seed/` from inside the archive, so a packaged app hands it the copy in resources.
  if (app.isPackaged) args.push('--seed', path.join(process.resourcesPath, 'seed'))
  return args
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Cartoon Studio',
    backgroundColor: '#14121c',
    show: !startHidden,
    icon: appIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // Closing the window hides it. The engine keeps working. Quit is in the tray menu.
  w.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      w.hide()
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void w.loadFile(path.join(__dirname, '../renderer/index.html'))
  return w
}

function showWindow(): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function appIcon(): Electron.NativeImage | undefined {
  for (const c of [path.join(process.resourcesPath, 'icon.png'), path.join(app.getAppPath(), 'build/icon.png')]) {
    if (existsSync(c)) return nativeImage.createFromPath(c)
  }
  return undefined
}

function trayImage(): Electron.NativeImage {
  const candidates = [
    path.join(process.resourcesPath, 'icon.png'), // packaged
    path.join(app.getAppPath(), 'build/icon.png') // development
  ]
  for (const c of candidates) {
    if (existsSync(c)) {
      const img = nativeImage.createFromPath(c)
      if (!img.isEmpty()) return img.resize({ width: 16, height: 16 })
    }
  }
  // a plain 16x16 square if the picture is missing
  return nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')).resize({ width: 16, height: 16 })
}

function rebuildTrayMenu(sendCommand: (c: { type: 'pauseAll' | 'resumeAll' }) => void): void {
  if (!tray) return
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: win?.isVisible() ? 'Hide Cartoon Studio' : 'Show Cartoon Studio', click: () => (win?.isVisible() ? win.hide() : showWindow()) },
      {
        label: allPaused ? 'Resume all' : 'Pause all',
        click: () => {
          sendCommand({ type: allPaused ? 'resumeAll' : 'pauseAll' })
          allPaused = !allPaused
          rebuildTrayMenu(sendCommand)
        }
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  )
}

function updatePowerBlocker(): void {
  if (runningJobs.size > 0 && blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension')
  else if (runningJobs.size === 0 && blockerId !== null) {
    powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
}

function loginItemOn(): boolean {
  if (process.env.CTS_NO_LOGIN_ITEM === '1') return loginItemInMemory
  return app.getLoginItemSettings().openAtLogin
}

function setLoginItem(on: boolean): boolean {
  if (process.env.CTS_NO_LOGIN_ITEM === '1') loginItemInMemory = on
  else {
    // In development this is electron.exe plus the app folder; packaged, it is the app itself.
    const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden']
    app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args })
  }
  return loginItemOn()
}

if (!app.requestSingleInstanceLock()) {
  if (mcpOnly) {
    // headless MCP next to a running app: say where its MCP is, then leave
    void readEngineLock(resolveDataDir({ argv: process.argv.slice(1) })).then((live) => {
      console.error(`Cartoon Studio is already running${live ? ` (pid ${live.pid})` : ''}${live?.mcpUrl ? ` with MCP at ${live.mcpUrl}` : ''}. Use it, or close it first.`)
      app.exit(1)
    })
  } else app.quit()
} else {
  app.on('second-instance', () => showWindow())

  void app.whenReady().then(() => {
    // headless: the engine ending (the port or the data folder is taken) ends the process with its exit code
    const engine = startEngine(path.join(__dirname, '../engine/index.js'), forwardedEngineArgs(), (code) => {
      if (quitting || code === 0) return
      if (mcpOnly) return app.exit(code ?? 1)
      void readEngineLock(dataDir ?? resolveDataDir({ argv: process.argv.slice(1) })).then((live) => {
        if (!live) return
        engineBlocked = { type: 'engine.warning', message: `Cartoon Studio is already running headless (pid ${live.pid}${live.mcpUrl ? `, MCP ${live.mcpUrl}` : ''}). Stop it (Ctrl+C in its terminal) and restart the app.` }
        if (win && !win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, engineBlocked)
      })
    })
    const sendCommand = (c: Parameters<typeof engine.send>[0]) => engine.send(c)

    protocol.handle(FILE_SCHEME, async (request) => {
      const hit = dataDir ? fileUrlToPath(dataDir, request.url) : null
      if (!hit) return new Response('not found', { status: 404 })
      try {
        // a link inside the folder that points elsewhere is refused too
        const real = await fs.realpath(hit.file)
        const rootReal = await fs.realpath(hit.root)
        if (!resolveInside(rootReal, path.relative(rootReal, real))) return new Response('not found', { status: 404 })
        const size = (await fs.stat(real)).size
        const headers: Record<string, string> = {
          'content-type': hit.type,
          'accept-ranges': 'bytes',
          // the page (the dev server or a file) loads these as images, audio and fonts: fonts need CORS
          'access-control-allow-origin': '*',
          // media only: no scripts, no network
          'content-security-policy': "default-src 'none'; img-src cartoonstudio-file: data:; media-src cartoonstudio-file:"
        }
        const range = parseRange(request.headers.get('range'), size)
        if (range === 'invalid') return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } })
        if (range) {
          const handle = await fs.open(real, 'r')
          try {
            const length = range.end - range.start + 1
            const buf = Buffer.alloc(length)
            await handle.read(buf, 0, length, range.start)
            return new Response(new Uint8Array(buf), { status: 206, headers: { ...headers, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': String(length) } })
          } finally {
            await handle.close()
          }
        }
        const body = await fs.readFile(real)
        return new Response(new Uint8Array(body), { headers: { ...headers, 'content-length': String(body.length) } })
      } catch {
        return new Response('not found', { status: 404 })
      }
    })

    engine.onMessage((event: EngineEvent) => {
      if (event.type === 'tool.result') {
        pendingCalls.get(event.id)?.({ ok: event.ok, result: event.result, error: event.error })
        return
      }
      if (event.type === 'engine.heartbeat') console.log(`[main] heartbeat #${event.n} relayed (${event.at})`)
      else console.log(`[main] engine event: ${event.type}`)
      if (win && !win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, event)
      switch (event.type) {
        case 'engine.ready':
          dataDir = event.dataDir
          break
        case 'snapshot':
          allPaused = event.paused
          for (const r of event.running) runningJobs.add(r.jobId)
          updatePowerBlocker()
          rebuildTrayMenu(sendCommand)
          break
        case 'factory.paused':
          allPaused = event.paused
          rebuildTrayMenu(sendCommand)
          break
        case 'job.started':
          runningJobs.add(event.jobId)
          updatePowerBlocker()
          break
        case 'job.done':
          runningJobs.delete(event.jobId)
          updatePowerBlocker()
          break
        default:
          break
      }
    })

    ipcMain.on(COMMAND_CHANNEL, (_e, command: unknown) => {
      if (isCommand(command)) engine.send(command)
    })
    ipcMain.handle('engine:call', (_e, tool: unknown, args: unknown) => {
      if (typeof tool !== 'string' || !/^cts_[a-z0-9_]+$/.test(tool)) return Promise.resolve<ToolCallResult>({ ok: false, error: 'not a cts_ tool name' })
      const id = `ui-${++callSeq}`
      return new Promise<ToolCallResult>((resolve) => {
        const timer = setTimeout(() => {
          pendingCalls.delete(id)
          resolve({ ok: false, error: `${tool} did not answer in time` })
        }, CALL_TIMEOUT_MS)
        pendingCalls.set(id, (r) => {
          clearTimeout(timer)
          pendingCalls.delete(id)
          resolve(r)
        })
        engine.send({ type: 'call', id, tool, args: typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {} })
      })
    })
    ipcMain.handle('host:openFile', async (_e, rel: unknown) => {
      const full = dataDir ? resolveInside(dataDir, rel) : null
      if (!full) return false
      return (await shell.openPath(full)) === ''
    })
    ipcMain.handle('host:showInFolder', (_e, rel: unknown) => {
      const full = dataDir ? resolveInside(dataDir, rel) : null
      if (!full) return false
      shell.showItemInFolder(full)
      return true
    })
    ipcMain.handle('host:readFile', (_e, rel: unknown) => (dataDir ? readFileInside(dataDir, rel) : null))
    ipcMain.handle('host:tailFile', (_e, rel: unknown, from: unknown) => (dataDir ? tailFileInside(dataDir, rel, from) : null))
    ipcMain.handle('host:openFolder', async (_e, rel: unknown) => {
      const full = dataDir ? resolveInside(dataDir, rel) : null
      if (!full) return false
      return (await shell.openPath(full)) === ''
    })
    ipcMain.handle('host:pickFolder', async (_e, title: unknown) => {
      const options: Electron.OpenDialogOptions = { title: typeof title === 'string' ? title : 'Choose a folder', properties: ['openDirectory'] }
      const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
    })
    ipcMain.handle('host:pickFile', async (_e, title: unknown, kind: unknown) => {
      const filters: Electron.FileFilter[] =
        kind === 'image'
          ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
          : kind === 'audio'
            ? [{ name: 'Audio', extensions: ['mp3', 'ogg', 'wav', 'flac', 'opus', 'm4a'] }]
            : []
      const options: Electron.OpenDialogOptions = { title: typeof title === 'string' ? title : 'Choose a file', properties: ['openFile'], filters }
      const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
    })
    ipcMain.handle('host:getLogin', () => loginItemOn())
    ipcMain.handle('host:setLogin', (_e, on: unknown) => setLoginItem(on === true))

    if (!noWindow) {
      win = createWindow()
      // The renderer asks for a first state once it has loaded.
      win.webContents.on('did-finish-load', () => {
        engine.send({ type: 'ping', id: 'startup' })
        engine.send({ type: 'snapshot' })
        if (engineBlocked) win?.webContents.send(EVENT_CHANNEL, engineBlocked)
      })
      if (process.env.CTS_NO_TRAY !== '1') {
        tray = new Tray(trayImage())
        tray.setToolTip('Cartoon Studio')
        tray.on('click', () => (win?.isVisible() ? win.hide() : showWindow()))
        win.on('show', () => rebuildTrayMenu(sendCommand))
        win.on('hide', () => rebuildTrayMenu(sendCommand))
        rebuildTrayMenu(sendCommand)
      }
    }

    // Quit ends the engine.
    app.on('before-quit', (e) => {
      if (quitting) return
      quitting = true
      e.preventDefault()
      if (blockerId !== null) powerSaveBlocker.stop(blockerId)
      // stopNow would leave the queue paused for the next start, so the engine is just ended:
      // jobs that were running are recovered into the queue when it starts again.
      engine.close()
      tray?.destroy()
      setTimeout(() => app.exit(0), 200)
    })
    app.on('window-all-closed', () => {
      // closing the window only hides it; the engine keeps working
      if (noWindow) return
    })
  })
}
