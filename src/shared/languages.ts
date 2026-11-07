import { UI_STRINGS } from './ui-strings'
import type { Lang } from './media'

/**
 * The languages a series can use: the built-in table (37 languages, with player strings for Croatian so far) and a registry
 * that `config/languages.md` adds to or overrides. Which text-to-speech engine reads a language is no longer a language
 * property: the local engines report their own coverage in `cts_voice_status`.
 */

export const LANGUAGE_SCRIPTS = ['latin', 'cyrillic', 'greek', 'arabic', 'hebrew', 'devanagari', 'han', 'kana', 'hangul', 'thai', 'other'] as const
export type LanguageScript = (typeof LANGUAGE_SCRIPTS)[number]

export interface LanguageInfo {
  /** Lowercase code such as `en`, `hr` or `pt-br`; the file name of its edition. */
  code: string
  /** English name. */
  name: string
  /** Name in the language itself (shown in the player's language switch). */
  native: string
  rtl?: boolean
  script: LanguageScript
  /** The player's UI strings in this language (`old` -> `new`): the built-in table (`ui-strings.ts`), with the `ui` of `config/languages.md` over it. Without it the menus stay in English. */
  ui?: Record<string, string>
  /** A font with the glyphs of the language: an absolute path, or a file name in `<data>/fonts/` (`font` in `config/languages.md`). */
  font?: string
  /** The bold face of `font`. Without it the regular face is used for bold text. */
  fontBold?: string
}

/** The languages the first series use (Croatian and English). */
export const LEGACY_LANGS = ['en', 'hr']

type Row = [code: string, name: string, native: string, script: LanguageScript, rtl?: true]
const ROWS: Row[] = [
  ['en', 'English', 'English', 'latin'],
  ['hr', 'Croatian', 'Hrvatski', 'latin'],
  ['ko', 'Korean', '한국어', 'hangul'],
  ['ja', 'Japanese', '日本語', 'kana'],
  ['ar', 'Arabic', 'العربية', 'arabic', true],
  ['bg', 'Bulgarian', 'Български', 'cyrillic'],
  ['cs', 'Czech', 'Čeština', 'latin'],
  ['da', 'Danish', 'Dansk', 'latin'],
  ['de', 'German', 'Deutsch', 'latin'],
  ['el', 'Greek', 'Ελληνικά', 'greek'],
  ['es', 'Spanish', 'Español', 'latin'],
  ['et', 'Estonian', 'Eesti', 'latin'],
  ['fi', 'Finnish', 'Suomi', 'latin'],
  ['fr', 'French', 'Français', 'latin'],
  ['hi', 'Hindi', 'हिन्दी', 'devanagari'],
  ['hu', 'Hungarian', 'Magyar', 'latin'],
  ['id', 'Indonesian', 'Bahasa Indonesia', 'latin'],
  ['it', 'Italian', 'Italiano', 'latin'],
  ['lt', 'Lithuanian', 'Lietuvių', 'latin'],
  ['lv', 'Latvian', 'Latviešu', 'latin'],
  ['nl', 'Dutch', 'Nederlands', 'latin'],
  ['pl', 'Polish', 'Polski', 'latin'],
  ['pt', 'Portuguese', 'Português', 'latin'],
  ['ro', 'Romanian', 'Română', 'latin'],
  ['ru', 'Russian', 'Русский', 'cyrillic'],
  ['sk', 'Slovak', 'Slovenčina', 'latin'],
  ['sl', 'Slovenian', 'Slovenščina', 'latin'],
  ['sv', 'Swedish', 'Svenska', 'latin'],
  ['tr', 'Turkish', 'Türkçe', 'latin'],
  ['uk', 'Ukrainian', 'Українська', 'cyrillic'],
  ['vi', 'Vietnamese', 'Tiếng Việt', 'latin'],
  ['sr', 'Serbian', 'Српски', 'cyrillic'],
  ['bs', 'Bosnian', 'Bosanski', 'latin'],
  ['no', 'Norwegian', 'Norsk', 'latin'],
  ['he', 'Hebrew', 'עברית', 'hebrew', true],
  ['fa', 'Persian', 'فارسی', 'arabic', true],
  ['zh', 'Chinese', '中文', 'han']
]

export const BUILTIN_LANGUAGES: readonly LanguageInfo[] = ROWS.map(([code, name, native, script, rtl]) => {
  const info: LanguageInfo = { code, name, native, script }
  if (rtl) info.rtl = true
  const ui = UI_STRINGS[code]
  if (ui) info.ui = { ...ui }
  return info
})

const registry = new Map<string, LanguageInfo>()

/** Back to the built-in table (for tests, and before `config/languages.md` is read again). */
export function resetLanguages(): void {
  registry.clear()
  for (const l of BUILTIN_LANGUAGES) registry.set(l.code, l)
}
resetLanguages()

export type LanguageInput = Pick<LanguageInfo, 'code' | 'name'> & Partial<LanguageInfo>

/**
 * Adds languages. An entry for a code that exists (a built-in one) is merged into it: `ui` key by key, any other field given replaces the
 * built-in one. A new language gets `script` `other` when missing.
 */
export function registerLanguages(list: readonly LanguageInput[]): void {
  for (const l of list) {
    const code = l.code.trim().toLowerCase()
    const base = registry.get(code)
    const given = Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined)) as Partial<LanguageInfo>
    if (base) {
      registry.set(code, { ...base, ...given, code, ui: base.ui || given.ui ? { ...base.ui, ...given.ui } : undefined })
      continue
    }
    registry.set(code, { ...l, code, native: l.native ?? l.name, script: l.script ?? 'other' })
  }
}

export const languages = (): LanguageInfo[] => [...registry.values()]
export const languageInfo = (code: string): LanguageInfo | undefined => registry.get(code)
export const isKnownLang = (code: string): boolean => registry.has(code)

/** The code if the language is known, else an error that lists the known ones. */
export function assertKnownLang(code: string): Lang {
  if (!registry.has(code)) throw new Error(`unknown language "${code}": use one of ${[...registry.keys()].join(', ')}, or add it in config/languages.md`)
  return code
}
