import path from 'node:path'
import chokidar from 'chokidar'
import { TMP_MARKER } from './atomic'

export type WatchKind = 'config' | 'agent' | 'prompt'
export type WatchChange = 'add' | 'change' | 'unlink'

export interface WatchEvent {
  kind: WatchKind
  change: WatchChange
  /** Absolute path. */
  path: string
  /** Path relative to the data folder, with forward slashes. */
  rel: string
}

export interface DataWatcher {
  close(): Promise<void>
  ready: Promise<void>
}

export interface WatchOptions {
  debounceMs?: number
  /** Emit events for files that already exist at start. Default false. */
  initial?: boolean
}

function kindOf(rel: string): WatchKind | undefined {
  if (rel.startsWith('config/')) return 'config'
  if (rel.startsWith('agents/')) return 'agent'
  if (rel.startsWith('prompts/')) return 'prompt'
  return undefined
}

/**
 * Watches config/, agents/ and prompts/ and emits typed, debounced change events.
 * Temporary files written by atomicWrite (`*.tmp-*`) are ignored.
 */
export function watchDataFolder(
  dataDir: string,
  onEvent: (event: WatchEvent) => void,
  opts: WatchOptions = {}
): DataWatcher {
  const debounceMs = opts.debounceMs ?? 150
  const pending = new Map<string, { change: WatchChange; timer: NodeJS.Timeout }>()

  const watcher = chokidar.watch(
    [
      path.join(dataDir, 'config'),
      path.join(dataDir, 'agents'),
      path.join(dataDir, 'prompts')
    ],
    {
      ignoreInitial: !opts.initial,
      ignored: (p) => path.basename(p).includes(TMP_MARKER),
      persistent: true
    }
  )

  const handle = (change: WatchChange) => (file: string) => {
    const rel = path.relative(dataDir, file).split(path.sep).join('/')
    const kind = kindOf(rel)
    if (!kind || !rel.endsWith('.md')) return
    const prev = pending.get(file)
    if (prev) clearTimeout(prev.timer)
    // add then change collapses to add; anything then unlink is unlink
    const effective: WatchChange = prev?.change === 'add' && change === 'change' ? 'add' : change
    const timer = setTimeout(() => {
      pending.delete(file)
      onEvent({ kind, change: effective, path: file, rel })
    }, debounceMs)
    pending.set(file, { change: effective, timer })
  }

  watcher.on('add', handle('add')).on('change', handle('change')).on('unlink', handle('unlink'))

  const ready = new Promise<void>((resolve) => watcher.once('ready', () => resolve()))
  return {
    ready,
    async close() {
      for (const p of pending.values()) clearTimeout(p.timer)
      pending.clear()
      await watcher.close()
    }
  }
}
