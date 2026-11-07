import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { studioExe, studioRepo } from './config'
import type { StudioId, StudiosConfig } from './config'

export interface OpenArgs {
  /** Absolute path of the document or song to open. */
  open: string
  /** Absolute path the studio exports to on every save. */
  exportTo: string
  /** Chiptune Studio: `ogg` or `wav`. */
  exportFormat?: 'ogg' | 'wav'
}

export interface LaunchPlan {
  command: string
  args: string[]
  cwd?: string
}

/** The command that opens a window with a file, per the round-trip contract: `--open <path> --export-to <path> [--export-format F]`. */
export function launchPlan(c: StudiosConfig, studio: StudioId, o: OpenArgs): LaunchPlan {
  const flags = ['--open', o.open, '--export-to', o.exportTo]
  if (o.exportFormat) flags.push('--export-format', o.exportFormat)
  const exe = studioExe(c, studio)
  if (exe) return { command: exe, args: flags }
  const repo = studioRepo(c, studio)
  return { command: 'yarn', args: ['--cwd', repo, 'electron', '.', ...flags], cwd: repo }
}

/** One argument for a command line run through the Windows shell (yarn is `yarn.cmd`): quoted when it has spaces. */
const quote = (a: string): string => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)

export type Spawner = (command: string, args: string[], options: SpawnOptions) => ChildProcess

/**
 * Starts the studio window detached (it outlives this process) and resolves once it is spawned. Rejects when the program cannot be started
 * (no yarn, a wrong exe path or repo folder).
 */
export async function launchStudio(plan: LaunchPlan, spawner: Spawner = spawn): Promise<{ pid: number | undefined }> {
  if (plan.cwd) {
    try {
      await fs.access(plan.cwd)
    } catch {
      throw new Error(`the app folder ${plan.cwd} does not exist: set it in config/studios.md`)
    }
  }
  const win = process.platform === 'win32'
  return new Promise((resolve, reject) => {
    const child = spawner(win ? quote(plan.command) : plan.command, win ? plan.args.map(quote) : plan.args, { cwd: plan.cwd, detached: true, stdio: 'ignore', shell: win, windowsHide: false })
    child.once('error', (e) => reject(new Error(`could not start ${plan.command}: ${e.message}`)))
    child.once('spawn', () => {
      child.unref()
      resolve({ pid: child.pid })
    })
  })
}

export interface Watch {
  stop(): void
}

/**
 * Watches a file that another program writes. Calls `onChange` each time it appeared or changed and has stopped growing (two polls with the
 * same size and time). Polling, so it works for a file that does not exist yet and for editors that replace the file. Stops after `maxMs`.
 */
export function watchFile(file: string, onChange: (file: string) => void | Promise<void>, o: { intervalMs?: number; maxMs?: number } = {}): Watch {
  const interval = o.intervalMs ?? 700
  let last = ''
  let pending = ''
  let busy = false
  let stopped = false
  const sig = async (): Promise<string> => {
    try {
      const st = await fs.stat(file)
      return st.size > 0 ? `${st.mtimeMs}:${st.size}` : ''
    } catch {
      return ''
    }
  }
  const tick = async () => {
    if (stopped || busy) return
    busy = true
    try {
      const now = await sig()
      if (now && now !== last) {
        if (now === pending) {
          last = now
          pending = ''
          await onChange(file)
        } else pending = now
      } else pending = ''
    } catch {
      /* the callback's own errors must not stop the watch */
    } finally {
      busy = false
    }
  }
  void sig().then((s) => {
    last = s // a file that is already there (an older export) is not a change
  })
  const timer = setInterval(() => void tick(), interval)
  const limit = o.maxMs ? setTimeout(() => stop(), o.maxMs) : undefined
  function stop() {
    stopped = true
    clearInterval(timer)
    if (limit) clearTimeout(limit)
  }
  timer.unref?.()
  limit?.unref?.()
  return { stop }
}
