import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { randomSeed, snap16, type Graph } from './graphs'

/**
 * Custom workflow engines (`custom:<name>`): an API-format graph `<name>.json` plus a `<name>.map.yaml` that says which
 * node inputs receive the prompt, negative, size, seed, reference image, text, language and voice reference, and which
 * node produces the output. New generators and TTS engines plug in without code changes.
 */

const slotSchema = z.object({ node: z.coerce.string(), input: z.string() })
export type CustomSlot = z.infer<typeof slotSchema>

const outputSchema = z.union([z.coerce.string(), z.object({ node: z.coerce.string() })]).transform((v) => (typeof v === 'string' ? { node: v } : v))

export const customMappingSchema = z.object({
  prompt: slotSchema.optional(),
  negative: slotSchema.optional(),
  width: slotSchema.optional(),
  height: slotSchema.optional(),
  seed: slotSchema.optional(),
  steps: slotSchema.optional(),
  /** A LoadImage node input: the reference image (uploaded to ComfyUI first). */
  reference: slotSchema.optional(),
  /** Text to speak (TTS). */
  text: slotSchema.optional(),
  language: slotSchema.optional(),
  /** A LoadAudio node input: the voice reference (uploaded first). */
  voiceRef: slotSchema.optional(),
  /** The node whose output is returned. */
  output: outputSchema,
  /** Language code (`en`, `hr`) -> the value the language input expects, for example `English (en)`. */
  languages: z.record(z.string(), z.string()).optional(),
  /** What the workflow produces; decides which output kind is downloaded. Default: guessed from the output node. */
  kind: z.enum(['image', 'audio']).optional()
})
export type CustomMapping = z.output<typeof customMappingSchema>

export const MAPPABLE_FIELDS = ['prompt', 'negative', 'width', 'height', 'seed', 'steps', 'reference', 'text', 'language', 'voiceRef'] as const
export type MappableField = (typeof MAPPABLE_FIELDS)[number]

export interface CustomWorkflow {
  name: string
  graph: Graph
  mapping: CustomMapping
}

/** Values to put into a custom workflow. `reference` and `voiceRef` are ComfyUI input filenames (already uploaded). */
export interface CustomParams {
  prompt?: string
  negative?: string
  width?: number
  height?: number
  seed?: number
  steps?: number
  reference?: string
  text?: string
  /** `en` / `hr`, mapped through `languages` when the mapping has a table. */
  language?: string
  voiceRef?: string
}

export function isGraph(value: unknown): value is Graph {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.values(value as Record<string, unknown>)
  return entries.length > 0 && entries.every((n) => !!n && typeof n === 'object' && typeof (n as { class_type?: unknown }).class_type === 'string')
}

/** Checks the mapping against the graph: every node exists and no mapped input is a link. Returns the problems found. */
export function validateMapping(graph: Graph, mapping: CustomMapping): string[] {
  const problems: string[] = []
  for (const field of MAPPABLE_FIELDS) {
    const slot = mapping[field]
    if (!slot) continue
    const node = graph[slot.node]
    if (!node) {
      problems.push(`${field}: node "${slot.node}" is not in the workflow`)
      continue
    }
    if (Array.isArray(node.inputs[slot.input])) problems.push(`${field}: ${slot.node}.${slot.input} is linked to another node, not a value`)
  }
  if (!graph[mapping.output.node]) problems.push(`output: node "${mapping.output.node}" is not in the workflow`)
  if (mapping.language && mapping.languages) {
    for (const [code, value] of Object.entries(mapping.languages)) if (!value) problems.push(`languages.${code} is empty`)
  }
  return problems
}

/** Parses API-format JSON text, rejecting UI-format workflows with a hint. */
export function parseWorkflowJson(text: string, source = 'workflow'): Graph {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(`${source}: not valid JSON (${(e as Error).message})`, { cause: e })
  }
  if (raw && typeof raw === 'object' && 'nodes' in raw && 'links' in raw) {
    throw new Error(`${source}: this is a UI-format workflow; convert it first (ui-to-api)`)
  }
  if (!isGraph(raw)) throw new Error(`${source}: not an API-format workflow (every node needs a class_type)`)
  return raw
}

export function parseMapping(text: string, source = 'mapping'): CustomMapping {
  const parsed = customMappingSchema.safeParse(parseYaml(text))
  if (!parsed.success) {
    throw new Error(`${source}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`)
  }
  return parsed.data
}

/** Where workflows live: `<data>/config/workflows` (preferred), else `<data>/workflows` (where the seed copy lands). */
export function workflowDirs(dataDir: string): string[] {
  return [path.join(dataDir, 'config', 'workflows'), path.join(dataDir, 'workflows')]
}

async function findWorkflowFile(dirs: string[], name: string, ext: string): Promise<string | null> {
  for (const dir of dirs) {
    const file = path.join(dir, `${name}${ext}`)
    if (existsSync(file)) return file
  }
  return null
}

/** Loads `<name>.json` and `<name>.map.yaml` from the first folder that has them, and validates the mapping. */
export async function loadCustomWorkflow(dirs: string | string[], name: string): Promise<CustomWorkflow> {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`invalid workflow name "${name}"`)
  const list = Array.isArray(dirs) ? dirs : [dirs]
  const jsonFile = await findWorkflowFile(list, name, '.json')
  const mapFile = await findWorkflowFile(list, name, '.map.yaml')
  if (!jsonFile) throw new Error(`custom workflow "${name}": ${name}.json not found in ${list.join(' or ')}`)
  if (!mapFile) throw new Error(`custom workflow "${name}": ${name}.map.yaml not found next to the workflow`)
  const graph = parseWorkflowJson(await fs.readFile(jsonFile, 'utf8'), jsonFile)
  const mapping = parseMapping(await fs.readFile(mapFile, 'utf8'), mapFile)
  const problems = validateMapping(graph, mapping)
  if (problems.length > 0) throw new Error(`custom workflow "${name}": ${problems.join('; ')}`)
  return { name, graph, mapping }
}

/** Names of the custom workflows that have both files. */
export async function listCustomWorkflows(dirs: string | string[]): Promise<string[]> {
  const names = new Set<string>()
  for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
    if (!existsSync(dir)) continue
    const files = await fs.readdir(dir)
    for (const f of files) {
      if (f.endsWith('.map.yaml') && files.includes(f.replace(/\.map\.yaml$/, '.json'))) names.add(f.replace(/\.map\.yaml$/, ''))
    }
  }
  return [...names].sort()
}

/** The kind a workflow produces: from the mapping, else guessed from the output node's class. */
export function workflowKind(graph: Graph, mapping: CustomMapping): 'image' | 'audio' {
  if (mapping.kind) return mapping.kind
  const cls = graph[mapping.output.node]?.class_type ?? ''
  return /audio|speech|tts|voice|music/i.test(cls) ? 'audio' : 'image'
}

/** A copy of the graph with the mapped inputs filled. Unmapped fields are left as the workflow has them. */
export function fillWorkflow(workflow: CustomWorkflow, params: CustomParams): { graph: Graph; outputNode: string; seed: number } {
  const graph = structuredClone(workflow.graph)
  const { mapping } = workflow
  const seed = params.seed ?? randomSeed()
  const set = (slot: CustomSlot | undefined, value: unknown) => {
    if (!slot || value === undefined) return
    const node = graph[slot.node]
    if (node) node.inputs[slot.input] = value
  }
  set(mapping.prompt, params.prompt)
  set(mapping.negative, params.negative)
  set(mapping.width, params.width === undefined ? undefined : snap16(params.width))
  set(mapping.height, params.height === undefined ? undefined : snap16(params.height))
  set(mapping.seed, seed)
  set(mapping.steps, params.steps)
  set(mapping.reference, params.reference)
  set(mapping.text, params.text)
  set(mapping.voiceRef, params.voiceRef)
  if (params.language !== undefined) set(mapping.language, mapping.languages?.[params.language] ?? params.language)
  return { graph, outputNode: mapping.output.node, seed }
}
