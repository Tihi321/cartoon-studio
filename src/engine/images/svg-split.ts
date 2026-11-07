import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * A small hand parser for flat SVGs (what Recraft or the character-designer role writes): it reads `<path>` and the basic shapes, works out
 * where each element lies (the centre of its bounding box, with the ancestor `<g transform>`s applied), and
 *  - `splitSvg`: gives every element to the first part whose polygon contains that centre and writes one SVG per part, each keeping the
 *    ORIGINAL viewBox/width/height so the parts register on top of each other;
 *  - `sliceSheet`: cuts a sheet SVG into grid cells; every cell is its own SVG whose viewBox is the cell rectangle (original coordinates).
 * No XML library: a tag scanner is enough for the SVGs this studio accepts (no scripts, filters or external hrefs: `cts_rig_check` rejects those).
 * The curve flattening is coarse (end points and control points), which is plenty for "which part does this path belong to".
 */

export type Pt = [number, number]
export interface PartPolygon {
  id: string
  /** In viewBox coordinates. */
  polygon: Pt[]
}

export interface ViewBox {
  x: number
  y: number
  w: number
  h: number
}

interface Node {
  /** The element's own markup, as written. */
  raw: string
  /** The open tags of the groups around it (as written), outermost first. */
  groups: string[]
  /** Centre of its bounding box, in viewBox coordinates. */
  centre: Pt | null
}

export interface ParsedSvg {
  viewBox: ViewBox
  /** The `<svg ...>` open tag, as written. */
  open: string
  /** `<defs>` blocks (gradients, clip paths), copied into every output. */
  defs: string
  nodes: Node[]
}

type Matrix = [number, number, number, number, number, number]
const IDENT: Matrix = [1, 0, 0, 1, 0, 0]
const mul = (a: Matrix, b: Matrix): Matrix => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]]
const apply = (m: Matrix, p: Pt): Pt => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]

const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag)?.slice(2).find((v) => v !== undefined)
const nums = (s: string): number[] => (s.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []).map(Number)

/** `translate`, `scale`, `rotate`, `matrix` (a list of them) to one matrix. */
export function parseTransform(t: string | undefined): Matrix {
  let m = IDENT
  if (!t) return m
  for (const [, fn, args] of t.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = nums(args ?? '')
    let n: Matrix = IDENT
    if (fn === 'translate') n = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]
    else if (fn === 'scale') n = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]
    else if (fn === 'matrix' && a.length === 6) n = a as Matrix
    else if (fn === 'rotate') {
      const r = ((a[0] ?? 0) * Math.PI) / 180
      const rot: Matrix = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]
      n = a.length === 3 ? mul(mul([1, 0, 0, 1, a[1]!, a[2]!], rot), [1, 0, 0, 1, -a[1]!, -a[2]!]) : rot
    }
    m = mul(m, n)
  }
  return m
}

/** The points of a path `d` (end points and control points, absolute). Arcs contribute their end point. */
export function pathPoints(d: string): Pt[] {
  const pts: Pt[] = []
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  for (const [, cmd, rest] of d.matchAll(/([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g)) {
    const a = nums(rest ?? '')
    const rel = cmd === cmd!.toLowerCase()
    const c = cmd!.toUpperCase()
    if (c === 'Z') {
      cx = sx
      cy = sy
    } else if (c === 'H') {
      for (const x of a) pts.push([(cx = (rel ? cx : 0) + x), cy])
    } else if (c === 'V') {
      for (const y of a) pts.push([cx, (cy = (rel ? cy : 0) + y)])
    } else {
      const stride = c === 'M' || c === 'L' || c === 'T' ? 2 : c === 'S' || c === 'Q' ? 4 : c === 'C' ? 6 : 7
      for (let i = 0; i + stride <= a.length; i += stride) {
        const bx = rel ? cx : 0
        const by = rel ? cy : 0
        if (c === 'A') {
          pts.push([(cx = bx + a[i + 5]!), (cy = by + a[i + 6]!)])
        } else {
          for (let j = 0; j < stride; j += 2) pts.push([bx + a[i + j]!, by + a[i + j + 1]!])
          cx = bx + a[i + stride - 2]!
          cy = by + a[i + stride - 1]!
        }
        if (c === 'M' && i === 0) {
          sx = cx
          sy = cy
        }
      }
    }
  }
  return pts
}

function shapePoints(tag: string, name: string): Pt[] {
  const n = (k: string) => Number(attr(tag, k) ?? 0)
  if (name === 'path') return pathPoints(attr(tag, 'd') ?? '')
  if (name === 'rect') return [[n('x'), n('y')], [n('x') + n('width'), n('y') + n('height')]]
  if (name === 'circle') return [[n('cx') - n('r'), n('cy') - n('r')], [n('cx') + n('r'), n('cy') + n('r')]]
  if (name === 'ellipse') return [[n('cx') - n('rx'), n('cy') - n('ry')], [n('cx') + n('rx'), n('cy') + n('ry')]]
  if (name === 'line') return [[n('x1'), n('y1')], [n('x2'), n('y2')]]
  const v = nums(attr(tag, 'points') ?? '')
  const out: Pt[] = []
  for (let i = 0; i + 1 < v.length; i += 2) out.push([v[i]!, v[i + 1]!])
  return out
}

const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline'])

export function parseSvg(svg: string): ParsedSvg {
  const open = /<svg\b[^>]*>/.exec(svg)?.[0]
  if (!open) throw new Error('not an SVG: no <svg> element')
  const vb = nums(attr(open, 'viewBox') ?? '')
  const viewBox: ViewBox = vb.length === 4 ? { x: vb[0]!, y: vb[1]!, w: vb[2]!, h: vb[3]! } : { x: 0, y: 0, w: Number.parseFloat(attr(open, 'width') ?? '0'), h: Number.parseFloat(attr(open, 'height') ?? '0') }
  if (!(viewBox.w > 0 && viewBox.h > 0)) throw new Error('the SVG has no viewBox (and no width/height)')
  const defs = [...svg.matchAll(/<defs\b[\s\S]*?<\/defs>/g)].map((m) => m[0]).join('\n')
  const body = svg.slice(open.length, svg.lastIndexOf('</svg>') >= 0 ? svg.lastIndexOf('</svg>') : undefined).replace(/<defs\b[\s\S]*?<\/defs>/g, '').replace(/<!--[\s\S]*?-->/g, '')
  const nodes: Node[] = []
  const groups: string[] = []
  const matrices: Matrix[] = [IDENT]
  for (const m of body.matchAll(/<(\/?)(\w+)\b([^>]*?)(\/?)>/g)) {
    const [raw, close, name, , selfClose] = m
    if (name === 'g') {
      if (close) {
        groups.pop()
        matrices.pop()
      } else if (!selfClose) {
        groups.push(raw)
        matrices.push(mul(matrices[matrices.length - 1]!, parseTransform(attr(raw, 'transform'))))
      }
    } else if (!close && SHAPES.has(name!)) {
      const mat = mul(matrices[matrices.length - 1]!, parseTransform(attr(raw, 'transform')))
      const pts = shapePoints(raw, name!).map((p) => apply(mat, p))
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      nodes.push({ raw, groups: [...groups], centre: pts.length ? [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2] : null })
    }
  }
  return { viewBox, open, defs, nodes }
}

/** Ray casting. */
export function inPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!
    const [xj, yj] = poly[j]!
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function emit(parsed: ParsedSvg, nodes: Node[], viewBox: ViewBox | null): string {
  let open = parsed.open
  if (viewBox) {
    const set = (tag: string, name: string, v: string) => (attr(tag, name) === undefined ? tag.replace(/\s*\/?>$/, ` ${name}="${v}">`) : tag.replace(new RegExp(`(\\s${name}\\s*=\\s*)("[^"]*"|'[^']*')`), `$1"${v}"`))
    open = set(set(set(open, 'viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`), 'width', String(viewBox.w)), 'height', String(viewBox.h))
  }
  const body = nodes.map((n) => `${n.groups.join('')}${n.raw}${'</g>'.repeat(n.groups.length)}`).join('\n')
  return `${open}\n${parsed.defs ? parsed.defs + '\n' : ''}${body}\n</svg>\n`
}

export interface SplitResult {
  /** part id -> written file */
  files: Record<string, string>
  /** part id -> number of elements */
  counts: Record<string, number>
  /** Elements whose centre is in no polygon (they are in no output). */
  unassigned: number
}

/** Writes `<outDir>/<part id>.svg` for every part (with its elements, the original viewBox, width and height). */
export async function splitSvg(svg: string, parts: PartPolygon[], outDir: string): Promise<SplitResult> {
  const parsed = parseSvg(svg)
  const byPart = new Map<string, Node[]>(parts.map((p) => [p.id, []]))
  let unassigned = 0
  for (const n of parsed.nodes) {
    const part = n.centre ? parts.find((p) => inPolygon(n.centre!, p.polygon)) : undefined
    if (part) byPart.get(part.id)!.push(n)
    else unassigned++
  }
  await fs.mkdir(outDir, { recursive: true })
  const files: Record<string, string> = {}
  const counts: Record<string, number> = {}
  for (const [id, nodes] of byPart) {
    files[id] = path.join(outDir, `${id}.svg`)
    counts[id] = nodes.length
    await fs.writeFile(files[id], emit(parsed, nodes, null))
  }
  return { files, counts, unassigned }
}

/** Cuts a sheet into `cols x rows` cells (row-major ids from `ids`, default `r<row>c<col>`); each cell's viewBox is its rectangle. */
export async function sliceSheet(svg: string, grid: { cols: number; rows: number; ids?: string[] }, outDir: string): Promise<SplitResult> {
  const parsed = parseSvg(svg)
  const { cols, rows } = grid
  if (!(cols >= 1 && rows >= 1)) throw new Error('grid needs cols >= 1 and rows >= 1')
  if (grid.ids && grid.ids.length !== cols * rows) throw new Error(`grid has ${cols * rows} cells but ${grid.ids.length} ids`)
  const { x, y, w, h } = parsed.viewBox
  const cw = w / cols
  const ch = h / rows
  const cell: Node[][] = Array.from({ length: cols * rows }, () => [])
  let unassigned = 0
  for (const n of parsed.nodes) {
    if (!n.centre) {
      unassigned++
      continue
    }
    const c = Math.min(cols - 1, Math.max(0, Math.floor((n.centre[0] - x) / cw)))
    const r = Math.min(rows - 1, Math.max(0, Math.floor((n.centre[1] - y) / ch)))
    cell[r * cols + c]!.push(n)
  }
  await fs.mkdir(outDir, { recursive: true })
  const files: Record<string, string> = {}
  const counts: Record<string, number> = {}
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      const id = grid.ids?.[i] ?? `r${r}c${c}`
      files[id] = path.join(outDir, `${id}.svg`)
      counts[id] = cell[i]!.length
      await fs.writeFile(files[id], emit(parsed, cell[i]!, { x: x + c * cw, y: y + r * ch, w: cw, h: ch }))
    }
  }
  return { files, counts, unassigned }
}
