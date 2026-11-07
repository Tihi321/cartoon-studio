// Writes the fixture series tests/fixtures/mini (two tiny vector rigs, one set with a 320x180 PNG, one episode of 3 lines, texts hr/en,
// voice manifests and their WAVs). The files are committed; run this only to change them: node scripts/make-fixture-mini.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { FIXTURE_LINES, FIXTURE_ROOT, writeFixtureAudio } from './make-fixture-audio.mjs'

const root = FIXTURE_ROOT
const put = (rel, content) => {
  const file = path.join(root, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
}
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>\n`
const S = 'stroke="#222222" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"'

const eyes = {
  open: svg(40, 12, `<circle cx="10" cy="6" r="4" fill="#ffffff" ${S}/><circle cx="30" cy="6" r="4" fill="#ffffff" ${S}/><circle cx="10" cy="6" r="1.5" fill="#222222"/><circle cx="30" cy="6" r="1.5" fill="#222222"/>`),
  half: svg(40, 12, `<path d="M6 6 H14 A4 4 0 0 1 6 6 Z" fill="#ffffff" ${S}/><path d="M26 6 H34 A4 4 0 0 1 26 6 Z" fill="#ffffff" ${S}/>`),
  closed: svg(40, 12, `<path d="M6 6 H14" fill="none" ${S}/><path d="M26 6 H34" fill="none" ${S}/>`)
}
const brows = {
  neutral: svg(40, 8, `<path d="M5 4 H15" fill="none" ${S}/><path d="M25 4 H35" fill="none" ${S}/>`),
  happy: svg(40, 8, `<path d="M5 5 Q10 1 15 5" fill="none" ${S}/><path d="M25 5 Q30 1 35 5" fill="none" ${S}/>`),
  sad: svg(40, 8, `<path d="M5 6 L15 2" fill="none" ${S}/><path d="M25 2 L35 6" fill="none" ${S}/>`),
  surprised: svg(40, 8, `<path d="M5 6 Q10 0 15 6" fill="none" ${S}/><path d="M25 6 Q30 0 35 6" fill="none" ${S}/>`)
}
const mouths = {
  rest: svg(20, 12, `<path d="M3 6 H17" fill="none" ${S}/>`),
  A: svg(20, 12, `<ellipse cx="10" cy="6" rx="7" ry="5" fill="#7a1f1f" ${S}/>`),
  E: svg(20, 12, `<ellipse cx="10" cy="6" rx="8" ry="3" fill="#7a1f1f" ${S}/>`),
  O: svg(20, 12, `<circle cx="10" cy="6" r="4" fill="#7a1f1f" ${S}/>`),
  U: svg(20, 12, `<ellipse cx="10" cy="6" rx="3" ry="4" fill="#7a1f1f" ${S}/>`),
  MBP: svg(20, 12, `<path d="M4 6 H16" fill="none" stroke="#222222" stroke-width="3" stroke-linecap="round"/>`),
  FV: svg(20, 12, `<path d="M3 4 H17 L15 8 H5 Z" fill="#ffffff" ${S}/>`),
  L: svg(20, 12, `<ellipse cx="10" cy="6" rx="6" ry="4" fill="#7a1f1f" ${S}/><rect x="7" y="6" width="6" height="3" fill="#e57373"/>`)
}

function rig(id, skin, shirt) {
  const dir = `cast/${id}`
  put(`${dir}/parts/body.svg`, svg(60, 70, `<rect x="5" y="2" width="50" height="66" rx="8" fill="${shirt}" ${S}/>`))
  put(`${dir}/parts/feet.svg`, svg(40, 10, `<rect x="2" y="2" width="36" height="6" rx="3" fill="#444444" ${S}/>`))
  put(`${dir}/parts/head.svg`, svg(60, 50, `<rect x="4" y="2" width="52" height="46" rx="16" fill="${skin}" ${S}/>`))
  put(`${dir}/parts/arm_l.svg`, svg(12, 40, `<rect x="2" y="2" width="8" height="36" rx="4" fill="${skin}" ${S}/>`))
  put(`${dir}/parts/arm_r.svg`, svg(12, 40, `<rect x="2" y="2" width="8" height="36" rx="4" fill="${skin}" ${S}/>`))
  for (const [k, v] of Object.entries(eyes)) put(`${dir}/parts/eyes_${k}.svg`, v)
  for (const [k, v] of Object.entries(brows)) put(`${dir}/parts/brows_${k}.svg`, v)
  for (const [k, v] of Object.entries(mouths)) put(`${dir}/parts/mouth_${k}.svg`, v)
  put(`${dir}/rig.json`, {
    schema: 'cts.rig/1',
    id,
    kind: 'vector',
    drawnFacing: 'right',
    height: 120,
    parts: [
      { id: 'body', src: 'parts/body.svg', parent: null, pivot: [30, 70], at: [0, 0], z: 10 },
      { id: 'feet', src: 'parts/feet.svg', parent: 'body', pivot: [20, 5], at: [30, 68], z: 8 },
      { id: 'head', src: 'parts/head.svg', parent: 'body', pivot: [30, 50], at: [30, 5], z: 20, rot: [-12, 12] },
      { id: 'arm_l', src: 'parts/arm_l.svg', parent: 'body', pivot: [6, 4], at: [4, 15], z: 5, rot: [-160, 40] },
      { id: 'arm_r', src: 'parts/arm_r.svg', parent: 'body', pivot: [6, 4], at: [56, 15], z: 25, rot: [-160, 40] }
    ],
    face: {
      parent: 'head',
      eyes: { at: [30, 20], z: 30, states: Object.fromEntries(Object.keys(eyes).map((k) => [k, `parts/eyes_${k}.svg`])) },
      brows: { at: [30, 10], z: 31, states: Object.fromEntries(Object.keys(brows).map((k) => [k, `parts/brows_${k}.svg`])) },
      mouth: { at: [30, 38], z: 32, shapes: Object.fromEntries(Object.keys(mouths).map((k) => [k, `parts/mouth_${k}.svg`])) }
    },
    emotions: {
      neutral: { brows: 'neutral', eyes: 'open' },
      happy: { brows: 'happy', eyes: 'open' },
      sad: { brows: 'sad', eyes: 'half' },
      surprised: { brows: 'surprised', eyes: 'open' }
    },
    gestures: {
      wave: { part: 'arm_r', seconds: 1.0, keys: [[0, -10], [0.25, -150], [0.5, -120], [0.75, -150], [1, -10]] },
      point: { part: 'arm_r', seconds: 0.8, keys: [[0, -10], [0.3, -85], [1, -85]] },
      shrug: { part: 'arm_l', seconds: 0.8, keys: [[0, -10], [0.4, -40], [1, -10]] }
    },
    move: { bobPx: 3, stepSeconds: 0.33 }
  })
}
rig('mia', '#f4d35e', '#ee964b')
rig('bobo', '#faf0ca', '#0d3b66')

// the set: a 320x180 solid PNG
const bg = await sharp({ create: { width: 320, height: 180, channels: 4, background: { r: 140, g: 200, b: 120, alpha: 1 } } }).png().toBuffer()
mkdirSync(path.join(root, 'sets/park/layers'), { recursive: true })
writeFileSync(path.join(root, 'sets/park/layers/bg.png'), bg)
put('sets/park/set.json', {
  schema: 'cts.set/1',
  id: 'park',
  size: [320, 180],
  groundY: 150,
  actorScale: 1,
  layers: [{ id: 'bg', src: 'layers/bg.png', z: 0, parallax: 1 }],
  marks: { offL: [-40, 150], left: [90, 150], center: [160, 150], right: [230, 150], offR: [360, 150] },
  shots: {
    wide: { center: [160, 90], zoom: 1 },
    two: { center: [160, 80], zoom: 1.25 },
    cuLeft: { center: [100, 70], zoom: 1.5 },
    cuRight: { center: [220, 70], zoom: 1.5 }
  }
})

const comfy = { engine: 'omnivoice', instruct: 'female, child, high pitch', ref: null, refText: null, seed: 7 }
const voiceHr = (vibetts) => ({ provider: 'auto', gemini: 'Leda', comfy, vibetts, speed: 1 })
const voiceEn = (vibetts) => ({ provider: 'auto', gemini: 'Leda', vibetts, speed: 1 })
put('bible.json', {
  schema: 'cts.bible/1',
  slug: 'mini',
  title: { hr: 'Mala proba', en: 'Mini Test' },
  audience: { ageMin: 4, ageMax: 8 },
  logline: { hr: 'Mia i Bobo se igraju u parku.', en: 'Mia and Bobo play in the park.' },
  tone: ['gentle humour', 'every episode ends warm'],
  style: { look: 'flat paper cutout, solid colours, 2 px outline', palette: ['#f4d35e', '#ee964b', '#0d3b66', '#faf0ca', '#222222'], outlinePx: 2, refPrompt: 'a child in a flat paper cutout style' },
  languages: ['hr', 'en'],
  cast: [
    {
      id: 'mia', name: { hr: 'Mia', en: 'Mia' }, role: 'lead', personality: 'curious, talks fast',
      catchphrases: { hr: ['Hajde!'], en: ['Come on!'] }, rig: 'cast/mia/rig.json',
      voice: { hr: voiceHr('supertonic:F3'), en: voiceEn('af_bella') }
    },
    {
      id: 'bobo', name: { hr: 'Bobo', en: 'Bobo' }, role: 'lead', personality: 'calm, friendly',
      rig: 'cast/bobo/rig.json',
      voice: { hr: voiceHr('supertonic:M1'), en: voiceEn('am_adam') }
    }
  ],
  sets: [{ id: 'park', name: { hr: 'Park', en: 'Park' }, description: 'a green park', file: 'sets/park/set.json' }],
  music: { stings: [] },
  rules: ['lines of at most 12 words', 'no name-calling'],
  episodes: [{ id: 'ep00-mini', title: { hr: 'Mala proba', en: 'Mini Test' }, status: 'draft' }],
  pitches: [{ id: 'p1', title: { hr: 'Mala proba', en: 'Mini Test' }, logline: { hr: 'Dvoje prijatelja u parku.', en: 'Two friends in a park.' }, leads: [{ name: 'Mia', what: 'curious' }, { name: 'Bobo', what: 'calm' }], sets: ['park'], why: 'the smallest series that exercises everything' }],
  chosenPitch: 'p1'
})

const ep = 'episodes/ep00-mini'
put(`${ep}/script.json`, {
  schema: 'cts.episode/1',
  series: 'mini',
  id: 'ep00-mini',
  titleKey: 'title',
  cast: ['mia', 'bobo'],
  scenes: [
    {
      id: 's1',
      set: 'park',
      start: { mia: { mark: 'left', facing: 'right', emotion: 'happy' }, bobo: { mark: 'offR', facing: 'left' } },
      shot: 'wide',
      beats: [
        { id: 'b01', type: 'move', who: 'bobo', to: 'right', seconds: 1.0 },
        { id: 'b02', type: 'line', line: 'l01', speaker: 'mia', emotion: 'happy', gesture: 'wave', look: 'bobo', pauseAfter: 0.3 },
        { id: 'b03', type: 'camera', shot: 'cuLeft', transition: 'cut' },
        { id: 'b04', type: 'line', line: 'l02', speaker: 'bobo', emotion: 'surprised', with: 'prev' },
        { id: 'b05', type: 'line', line: 'l03', speaker: 'mia', emotion: 'happy' }
      ]
    }
  ],
  music: {},
  sfx: {}
})
const texts = {
  hr: { title: 'Mala proba', l01: 'Bok! Ja sam Mia.', l02: 'Vau, kakav lijep dan!', l03: 'Hajdemo se igrati!' },
  en: { title: 'A Small Test', l01: 'Hi! I am Mia.', l02: 'Wow, what a nice day!', l03: 'Let us play!' }
}
for (const lang of ['hr', 'en']) {
  const t = texts[lang]
  put(`${ep}/text/${lang}.json`, {
    schema: 'cts.text/1',
    lang,
    strings: { title: t.title },
    lines: { l01: { text: t.l01, delivery: 'cheerful' }, l02: { text: t.l02 }, l03: { text: t.l03, delivery: 'cheerful' } }
  })
  put(`${ep}/voice/${lang}/manifest.json`, {
    schema: 'cts.voice/1',
    episode: 'ep00-mini',
    lang,
    allocation: { provider: 'vibetts', reason: 'fixture: placeholder tones' },
    lines: Object.fromEntries(
      Object.entries(FIXTURE_LINES).map(([id, l]) => [
        id,
        { file: `voice/${lang}/${id}.wav`, seconds: l[lang], provider: 'vibetts', engine: 'fixture', voice: 'tone', speed: 1, hash: `fixture-${lang}-${id}`, words: null, status: 'ok' }
      ])
    ),
    costUsd: 0
  })
}
writeFixtureAudio(path.join(root, ep))
