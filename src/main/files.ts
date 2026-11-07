import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Resolves a path given by the renderer against the data folder.
 * Returns null for anything that is not strictly inside it: absolute paths, drive letters, `..`, NUL bytes.
 */
export function resolveInside(dataDir: string, rel: unknown): string | null {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0')) return null
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\') || rel.startsWith('/')) return null
  const parts = rel.split(/[\\/]+/)
  if (parts.some((p) => p === '..')) return null
  const root = path.resolve(dataDir)
  const full = path.resolve(root, rel)
  const inside = path.relative(root, full)
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) return null
  return full
}

const MAX_READ = 8 * 1024 * 1024

export async function readFileInside(dataDir: string, rel: unknown): Promise<string | null> {
  const full = resolveInside(dataDir, rel)
  if (!full) return null
  try {
    const stat = await fs.stat(full)
    if (!stat.isFile() || stat.size > MAX_READ) return null
    return await fs.readFile(full, 'utf8')
  } catch {
    return null
  }
}

/** Text from `fromByte` to the end. A negative `fromByte` means the last N bytes. */
export async function tailFileInside(dataDir: string, rel: unknown, fromByte: unknown): Promise<{ text: string; size: number } | null> {
  const full = resolveInside(dataDir, rel)
  if (!full || typeof fromByte !== 'number' || !Number.isFinite(fromByte)) return null
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(full, 'r')
    const stat = await handle.stat()
    if (!stat.isFile()) return null
    const size = stat.size
    let start = fromByte < 0 ? Math.max(0, size + fromByte) : Math.min(fromByte, size)
    const length = Math.min(size - start, MAX_READ)
    if (length < size - start) start = size - length
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    let text = buffer.toString('utf8')
    // a cut in the middle of a character or a line: drop the broken first bit
    if (start > 0) {
      text = text.replace(/^[^\n]*\n/, '')
    }
    return { text, size }
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

/** The content types the file protocol serves. Anything else is refused. */
const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json; charset=utf-8'
}

/** A file the protocol may serve, and the folder it must stay inside. */
export interface ServedFile {
  file: string
  type: string
  /** The confinement root: the data folder. */
  root: string
}

/**
 * Maps a `cartoonstudio-file://data/<rel>` URL to a file path. Served: `series/<slug>/...` from the data folder, only the file types above.
 */
export function fileUrlToPath(dataDir: string, url: string): ServedFile | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'cartoonstudio-file:') return null
  let rel: string
  try {
    rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
  } catch {
    return null
  }
  if (!/^series\/[a-z0-9][a-z0-9-]*\/.+/.test(rel)) return null
  const file = resolveInside(dataDir, rel)
  if (!file) return null
  const type = TYPES[path.extname(file).toLowerCase()]
  return type ? { file, type, root: dataDir } : null
}

/**
 * Reads a `Range: bytes=a-b` header for a file of `size` bytes. `null`: no range (send the whole file). `'invalid'`: answer 416.
 * Only one range is supported (a media element asks for one).
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return header.trim().startsWith('bytes=') ? 'invalid' : null
  let start: number
  let end: number
  if (m[1] === '') {
    // the last N bytes
    const n = Number(m[2])
    if (n === 0) return 'invalid'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (size === 0 || start >= size || start > end) return 'invalid'
  return { start, end }
}
