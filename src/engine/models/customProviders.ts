import { isMap, isSeq, parseDocument } from 'yaml'
import type { Document, YAMLMap, YAMLSeq } from 'yaml'
import { splitFrontmatter } from '../../shared/md'

/**
 * Providers added in the Models page's Add provider form: entries of config/providers.md with `custom: true`. Only those are ever
 * added, changed or removed here; the rest of the file (seed providers, comments, the text below) stays as it is.
 */

/** Ids the form never hands out: the seed providers, the role aliases and the test provider. */
export const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set(['paid', 'strata', 'lmstudio', 'deepseek', 'openrouter', 'anthropic', 'gemini', 'ollama', 'client', 'acp', 'mock'])

export interface CustomProviderInput {
  /** Set when editing: the id of the custom provider to change. */
  id?: string
  name: string
  baseUrl: string
  /** True when a key is stored for the provider (so `api_key_env` is written). */
  hasKey: boolean
  free: boolean
  jsonSchema: boolean
  concurrency: number | 'auto'
  enabled: boolean
}

/** `ACP proxy (home)` -> `acp-proxy-home`. Empty when the name has no letter or digit. */
export function slugOf(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** The credential-store name of a custom provider's key: `acp-home` -> `CUSTOM_ACP_HOME_API_KEY`. */
export function keyNameOf(id: string): string {
  return `CUSTOM_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/** The URL as stored (no trailing slash), or an error text when it is not an http(s) address. */
export function checkBaseUrl(raw: string): { url: string } | { error: string } {
  const text = raw.trim()
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return { error: 'the base URL is not a valid address (for example http://127.0.0.1:7461/v1)' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'the base URL must start with http:// or https://' }
  return { url: text.replace(/\/+$/, '') }
}

interface Parsed {
  doc: Document
  providers: YAMLSeq
  eol: string
  body: string
}

function parseProviders(text: string): Parsed {
  const { frontmatter, body } = splitFrontmatter(text)
  if (frontmatter === null) throw new Error('config/providers.md has no frontmatter')
  const doc = parseDocument(frontmatter)
  if (doc.errors.length > 0) throw new Error(`config/providers.md: ${doc.errors[0]!.message}`)
  let providers = doc.get('providers', true)
  if (!isSeq(providers)) {
    doc.set('providers', doc.createNode([]))
    providers = doc.get('providers', true)
  }
  return { doc, providers: providers as YAMLSeq, eol: text.includes('\r\n') ? '\r\n' : '\n', body }
}

function render(p: Parsed): string {
  const fm = p.doc.toString({ lineWidth: 0 }).replace(/\r?\n/g, p.eol)
  return `---${p.eol}${fm}---${p.eol}${p.body}`
}

const idOf = (m: YAMLMap): string => String(m.get('id') ?? '')

/** The ids of every provider in a providers.md text, and which of them are custom. */
export function providerIdsOf(text: string): { all: string[]; custom: string[] } {
  const { providers } = parseProviders(text)
  const maps = providers.items.filter(isMap)
  return { all: maps.map(idOf), custom: maps.filter((m) => m.get('custom') === true).map(idOf) }
}

/**
 * Adds a custom provider to the providers.md text, or changes the custom provider `input.id`. Returns the new text and the id.
 * Throws a short message when the name gives no id, the id is taken (or a seed id), or the id is not a custom provider.
 */
export function upsertCustomProvider(text: string, input: CustomProviderInput): { text: string; id: string } {
  const p = parseProviders(text)
  const url = checkBaseUrl(input.baseUrl)
  if ('error' in url) throw new Error(url.error)
  const name = input.name.trim()
  if (!name) throw new Error('give the provider a name')
  const maps = p.providers.items.filter(isMap)
  const keyEnv = (id: string) => keyNameOf(id)
  if (input.id) {
    const entry = maps.find((m) => idOf(m) === input.id)
    if (!entry || entry.get('custom') !== true) throw new Error(`"${input.id}" is not a custom provider`)
    entry.set('name', name)
    entry.set('enabled', input.enabled)
    entry.set('local', input.free)
    entry.set('base_url', url.url)
    entry.set('json_schema', input.jsonSchema)
    entry.set('concurrency', input.concurrency)
    if ((input.hasKey || !input.free) && !entry.has('api_key_env')) entry.set('api_key_env', keyEnv(input.id))
    return { text: render(p), id: input.id }
  }
  const id = slugOf(name)
  if (!id) throw new Error('the name needs at least one letter or digit')
  if (RESERVED_PROVIDER_IDS.has(id)) throw new Error(`"${id}" is the name of a built-in provider: pick another name`)
  if (maps.some((m) => idOf(m) === id)) throw new Error(`a provider "${id}" exists already: pick another name`)
  const entry: Record<string, unknown> = { id, name, custom: true, kind: 'openai-compat', enabled: input.enabled, base_url: url.url }
  if (input.hasKey || !input.free) entry.api_key_env = keyEnv(id)
  Object.assign(entry, { local: input.free, json_schema: input.jsonSchema, concurrency: input.concurrency, discover: true, models: [] })
  p.providers.add(p.doc.createNode(entry))
  return { text: render(p), id }
}

/** Removes the custom provider `id` from the providers.md text. Throws when there is no such custom provider. */
export function removeCustomProviderEntry(text: string, id: string): { text: string; keyEnv?: string } {
  const p = parseProviders(text)
  const i = p.providers.items.findIndex((m) => isMap(m) && idOf(m) === id)
  const entry = i >= 0 ? (p.providers.items[i] as YAMLMap) : undefined
  if (!entry || entry.get('custom') !== true) throw new Error(`"${id}" is not a custom provider`)
  const keyEnv = entry.get('api_key_env')
  p.providers.items.splice(i, 1)
  return { text: render(p), keyEnv: typeof keyEnv === 'string' ? keyEnv : undefined }
}
