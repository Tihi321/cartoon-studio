import { createRequire } from 'node:module'

/** API keys live in environment variables or the Windows credential store. Never in files. */
export const KEYRING_SERVICE = 'cartoon-studio'

interface KeyringEntry {
  setPassword(p: string): void
  getPassword(): string | null
  deletePassword(): boolean
}
type EntryCtor = new (service: string, account: string) => KeyringEntry

let entryCtor: EntryCtor | null | undefined

function loadEntry(): EntryCtor | null {
  if (entryCtor !== undefined) return entryCtor
  try {
    const req = createRequire(__filename)
    entryCtor = (req('@napi-rs/keyring') as { Entry: EntryCtor }).Entry
  } catch {
    entryCtor = null
  }
  return entryCtor
}

function entry(account: string, service: string): KeyringEntry {
  const Ctor = loadEntry()
  if (!Ctor) throw new Error('The credential store module (@napi-rs/keyring) could not be loaded')
  return new Ctor(service, account)
}

export function setStoredKey(account: string, value: string, service = KEYRING_SERVICE): void {
  entry(account, service).setPassword(value)
}

export function getStoredKey(account: string, service = KEYRING_SERVICE): string | undefined {
  try {
    return entry(account, service).getPassword() ?? undefined
  } catch {
    return undefined
  }
}

export function deleteStoredKey(account: string, service = KEYRING_SERVICE): boolean {
  try {
    return entry(account, service).deletePassword()
  } catch {
    return false
  }
}

export type KeyResolver = (envName: string) => string | undefined

/** The credential-store services of the sibling tools, tried after `cartoon-studio` (off with `CTS_SHARED_KEYS=0`). */
export const SHARED_KEY_SERVICES = ['scriptorium', 'book-translator'] as const

export type StoredKeyGetter = (account: string, service?: string) => string | undefined

/** Where a key came from: `the environment`, or `the <service> credential store`. Never the key itself. */
export interface KeyHit {
  value: string
  from: string
}

/**
 * The environment variable first, then the Windows credential store (account = the variable name): the `cartoon-studio` service, then the services of
 * Scriptorium and Book Translator, unless `CTS_SHARED_KEYS=0`.
 */
export function lookupKey(envName: string, getKey: StoredKeyGetter = getStoredKey, env: NodeJS.ProcessEnv = process.env): KeyHit | undefined {
  const fromEnv = env[envName]
  if (fromEnv) return { value: fromEnv, from: 'the environment' }
  const own = getKey(envName, KEYRING_SERVICE)
  if (own) return { value: own, from: `the ${KEYRING_SERVICE} credential store` }
  if (env.CTS_SHARED_KEYS === '0') return undefined
  for (const service of SHARED_KEY_SERVICES) {
    const v = getKey(envName, service)
    if (v) return { value: v, from: `the ${service} credential store` }
  }
  return undefined
}

export const resolveKey = (envName: string, getKey: StoredKeyGetter = getStoredKey, env: NodeJS.ProcessEnv = process.env): string | undefined => lookupKey(envName, getKey, env)?.value
