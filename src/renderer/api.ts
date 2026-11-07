import type { Command, EngineEvent, CartoonStudioApi } from '../shared/protocol'
import { fileUrl, type HostApi, type PickKind } from './hostApi'
import { ctsStore } from './store/store'

/** The host (Electron preload) API. Every extra is optional, so a plain browser page can still load. */
export type RendererApi = CartoonStudioApi &
  Partial<HostApi> & {
    /** Where series files are served from instead of the `cartoonstudio-file://` protocol (the browser harness sets it). */
    fileBase?: string
  }

declare global {
  interface Window {
    cartoonstudio: RendererApi
  }
}

export function sendCommand(command: Command): void {
  window.cartoonstudio.send(command)
}

/**
 * Connects the store to the engine: events are queued and applied every 50 ms,
 * so a burst of streamed tokens causes one render, not hundreds.
 * Returns a function that disconnects.
 */
export function connectEngine(api: RendererApi = window.cartoonstudio): () => void {
  let queue: EngineEvent[] = []
  let scheduled = false
  const flush = () => {
    scheduled = false
    const batch = queue
    queue = []
    ctsStore.getState().applyEvents(batch)
  }
  const off = api.on((event) => {
    queue.push(event)
    if (!scheduled) {
      scheduled = true
      setTimeout(flush, 50)
    }
  })
  api.send({ type: 'snapshot' })
  api.send({ type: 'listSeries' })
  return () => {
    off()
    queue = []
  }
}

/** URL of a file in the data folder, such as `series/pilot/cast/mia/ref.png`. */
export function seriesFileUrl(rel: string): string {
  const base = typeof window !== 'undefined' ? window.cartoonstudio?.fileBase : undefined
  return base ? `${base.replace(/\/$/, '')}/${rel.split('/').map(encodeURIComponent).join('/')}` : fileUrl(rel)
}

export async function openFolder(rel: string): Promise<boolean> {
  return (await window.cartoonstudio.openFolder?.(rel)) ?? false
}

/** Opens a file of the data folder (an MP4) with its default program. */
export async function openFile(rel: string): Promise<boolean> {
  return (await window.cartoonstudio.openFile?.(rel)) ?? false
}

/** Shows a file of the data folder selected in Explorer. */
export async function showInFolder(rel: string): Promise<boolean> {
  return (await window.cartoonstudio.showInFolder?.(rel)) ?? false
}

/** Folder picker (desktop app only; null when cancelled or in a plain browser). */
export async function pickFolder(title?: string): Promise<string | null> {
  return (await window.cartoonstudio.pickFolder?.(title)) ?? null
}

export async function pickFile(title?: string, kind: PickKind = 'any'): Promise<string | null> {
  return (await window.cartoonstudio.pickFile?.(title, kind)) ?? null
}

/** The end of a file in the data folder (a series' log.md), or null. */
export async function tailText(rel: string, bytes: number): Promise<string | null> {
  const r = await window.cartoonstudio.tailFile?.(rel, -bytes)
  return r ? r.text : null
}

export async function readText(rel: string): Promise<string | null> {
  return (await window.cartoonstudio.readFile?.(rel)) ?? null
}

export async function getStartWithWindows(): Promise<boolean | null> {
  return (await window.cartoonstudio.getStartWithWindows?.()) ?? null
}

export async function setStartWithWindows(on: boolean): Promise<boolean | null> {
  return (await window.cartoonstudio.setStartWithWindows?.(on)) ?? null
}
