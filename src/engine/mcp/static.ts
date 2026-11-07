import { createReadStream, promises as fs } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

/**
 * The read-only static routes next to `/mcp`:
 *
 *   GET /preview/...                the player bundle (`out/player/`), the page `/preview/` plays an episode
 *   GET /files/<series>/...         files under the data folder's `series/<series>/` (clips, parts, voices, renders), nothing else
 *
 * Both are GET and HEAD only and are guarded: a path never leaves its root (no `..`, no drive letters, no backslashes, no symlink that points
 * outside), and `/files/` serves only a lower-case series slug as its first segment. Range requests work, so audio and video can seek.
 */

export interface StaticRoots {
  /** The folder of the built player (`out/player`). Missing: `/preview/` answers 404. */
  previewDir?: string
  /** `<data>/series`. Missing: `/files/` answers 404. */
  seriesRoot?: string
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2'
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

/** The url path split into decoded segments, or null when anything about it is unsafe. */
export function safeSegments(pathname: string): string[] | null {
  const out: string[] = []
  for (const raw of pathname.split('/').filter((s) => s !== '')) {
    let seg: string
    try {
      seg = decodeURIComponent(raw)
    } catch {
      return null
    }
    if (seg === '.' || seg === '..' || /[\\:\0/]/.test(seg)) return null
    out.push(seg)
  }
  return out
}

/** Resolves `segments` under `root` and checks (with real paths) that the file is inside it. Null when it is not a regular file inside. */
export async function resolveInside(root: string, segments: string[]): Promise<string | null> {
  try {
    const base = await fs.realpath(root)
    const full = await fs.realpath(path.join(base, ...segments))
    const rel = path.relative(base, full)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
    const st = await fs.stat(full)
    return st.isFile() ? full : null
  } catch {
    return null
  }
}

/** True when the request is for one of the static routes (so the caller does not answer 404 for it). */
export function isStaticPath(pathname: string): boolean {
  return pathname === '/preview' || pathname.startsWith('/preview/') || pathname.startsWith('/files/')
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found.' }))
}

/** Answers a static GET/HEAD. The caller has checked Host/Origin and the token. */
export async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, roots: StaticRoots): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end()
    return
  }
  const segs = safeSegments(pathname)
  if (!segs) return notFound(res)
  let file: string | null = null
  if (segs[0] === 'preview') {
    if (!roots.previewDir) return notFound(res)
    const rest = segs.slice(1)
    file = await resolveInside(roots.previewDir, rest.length ? rest : ['index.html'])
  } else if (segs[0] === 'files') {
    if (!roots.seriesRoot || segs.length < 3 || !SLUG_RE.test(segs[1]!)) return notFound(res)
    file = await resolveInside(roots.seriesRoot, segs.slice(1))
  }
  if (!file) return notFound(res)
  const st = await fs.stat(file)
  const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  const headers: Record<string, string | number> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  let start = 0
  let end = st.size - 1
  let status = 200
  if (range && st.size > 0) {
    if (range[1] === '' && range[2] !== '') {
      start = Math.max(0, st.size - Number(range[2]))
    } else {
      start = Number(range[1])
      if (range[2] !== '') end = Math.min(end, Number(range[2]))
    }
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end()
      return
    }
    status = 206
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`
  }
  headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1
  res.writeHead(status, headers)
  if (req.method === 'HEAD' || st.size === 0) {
    res.end()
    return
  }
  createReadStream(file, { start, end })
    .on('error', () => res.destroy())
    .pipe(res)
}
