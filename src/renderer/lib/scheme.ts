/**
 * The studio's colour scheme: `system` follows `prefers-color-scheme`; `light` and `dark` are chosen on the Settings page and set
 * `data-studio-scheme` on <html> (src/renderer/styles.css reads it). Kept in localStorage. No DOM types here (the store is also loaded by
 * node tests), and every access is guarded, so a missing page or storage only means the choice is not kept.
 */
export type Scheme = 'system' | 'light' | 'dark'
export const SCHEMES: Scheme[] = ['system', 'light', 'dark']
const KEY = 'cartoon-studio:scheme'

interface Env {
  document?: { documentElement: { setAttribute(name: string, value: string): void; removeAttribute(name: string): void } }
  localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
}
const env = (): Env => globalThis as unknown as Env

export function readScheme(): Scheme {
  try {
    const v = env().localStorage?.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function applyScheme(scheme: Scheme): void {
  try {
    const root = env().document?.documentElement
    if (scheme === 'system') {
      root?.removeAttribute('data-studio-scheme')
      env().localStorage?.removeItem(KEY)
    } else {
      root?.setAttribute('data-studio-scheme', scheme)
      env().localStorage?.setItem(KEY, scheme)
    }
  } catch {
    // storage not available: the choice lasts until the page closes
  }
}
