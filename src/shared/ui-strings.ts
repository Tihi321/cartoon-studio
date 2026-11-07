/**
 * The preview page's menu strings in each built-in language other than English (`old` -> `new`; the keys are the strings as they appear in
 * the player, which is written in English). English has no table. A language that has no table keeps the English text. CTS-03 extends the
 * key set with the player's own strings.
 *
 * The tables were written by a language model, not by native speakers: native review is welcome.
 */
export const UI_STRINGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  hr: {
    Language: 'Jezik',
    Play: 'Pokreni',
    Pause: 'Pauza'
  }
}
