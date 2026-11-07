// Generates the placeholder voice lines of the fixture series (tests/fixtures/mini/episodes/ep00-mini/voice/<lang>/<line>.wav).
// They are plain sine-tone clips, NOT speech. Copied from Edu Studio's scripts/make-fixture-audio.mjs and adapted:
// one tone per line, with the length the voice manifest of the fixture states. Usage: node scripts/make-fixture-audio.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RATE = 8000
export const FIXTURE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'mini')

/** The lines of the fixture episode: seconds per language (hr is longer than en) and the tone of each line. */
export const FIXTURE_LINES = {
  l01: { hr: 1.2, en: 1.0, freq: 440 },
  l02: { hr: 1.0, en: 0.8, freq: 550 },
  l03: { hr: 1.4, en: 1.2, freq: 330 }
}

/** 16-bit mono PCM WAV of one sine tone (`freq` Hz), `seconds` long, with a 5 ms fade at each end. */
export function tone({ seconds, freq }) {
  const n = Math.round(RATE * seconds)
  const fade = Math.round(RATE * 0.005)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - 1 - i) / fade)
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / RATE) * 0.5 * env * 32767), i * 2)
  }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20) // PCM
  head.writeUInt16LE(1, 22) // mono
  head.writeUInt32LE(RATE, 24)
  head.writeUInt32LE(RATE * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

/** Writes `voice/<lang>/<line>.wav` under `episodeDir`. */
export function writeFixtureAudio(episodeDir = path.join(FIXTURE_ROOT, 'episodes', 'ep00-mini')) {
  for (const lang of ['hr', 'en']) {
    const dir = path.join(episodeDir, 'voice', lang)
    mkdirSync(dir, { recursive: true })
    for (const [id, l] of Object.entries(FIXTURE_LINES)) {
      const wav = tone({ seconds: l[lang], freq: l.freq })
      writeFileSync(path.join(dir, `${id}.wav`), wav)
      console.log(`voice/${lang}/${id}.wav: ${wav.length} bytes`)
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) writeFixtureAudio()
