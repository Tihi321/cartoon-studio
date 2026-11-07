/**
 * What Electron main adds to `window.cartoonstudio` besides the engine events and commands (see src/preload/index.ts).
 * Types only, so the preload and the renderer can both import it.
 */
export type PickKind = 'image' | 'audio' | 'any'

export interface HostApi {
  /** The whole file as UTF-8 text, relative to the data folder. Null when missing or outside the folder. */
  readFile(rel: string): Promise<string | null>
  /** Text from a byte offset to the end, with the file size. A negative offset means the last N bytes. */
  tailFile(rel: string, fromByte: number): Promise<{ text: string; size: number } | null>
  /** Opens a folder inside the data folder in Explorer. */
  openFolder(rel: string): Promise<boolean>
  /** Opens a file inside the data folder with the program Windows has for it (an MP4 plays in the default player). */
  openFile(rel: string): Promise<boolean>
  /** Opens Explorer with a file inside the data folder selected. */
  showInFolder(rel: string): Promise<boolean>
  /** A folder picker. Resolves with the absolute path, or null when cancelled. */
  pickFolder(title?: string): Promise<string | null>
  /** A file picker. `kind` limits the file types. Resolves with the absolute path, or null when cancelled. */
  pickFile(title?: string, kind?: PickKind): Promise<string | null>
  getStartWithWindows(): Promise<boolean>
  setStartWithWindows(on: boolean): Promise<boolean>
}

/** The custom protocol that serves a series' files (`series/<slug>/...`: parts, sets, voices, clips, renders) from the data folder. */
export const FILE_SCHEME = 'cartoonstudio-file'

export function fileUrl(rel: string): string {
  return `${FILE_SCHEME}://data/${rel.split('/').map(encodeURIComponent).join('/')}`
}
