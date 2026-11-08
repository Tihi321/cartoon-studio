import { rigSheetName } from '../render/sheet'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { z } from 'zod'
import type { Bible, Episode, Lang } from '../../shared/contracts'
import { localIso } from '../budget/spend'
import type { Engine } from '../engine'
import { generateTheme } from '../music/comfy'
import { isAbortError } from '../models/types'
import type { JobContext } from '../queue/scheduler'
import { normaliseWav } from '../voice/audio'
import { loadVoiceConfig } from '../voice/run'
import { checkOmniInstruct, comfySpeaker } from '../voice/providers/comfy'
import { vibettsSpeaker } from '../voice/providers/vibetts'
import { voiceDeps } from '../voice/tools'
import type { ClipJob } from '../voice/providers/types'
import { INTRO_ID, OUTRO_ID, badClipIds, buildScreenplay, clipBeats, missingClips, readClipEntry, readShots, upsertClip, videoDir } from './clips'
import { lintSeries } from '../series/lint'
import { ask, castView, makeEnv, relTo, requireChosen } from './env'
import type { Env } from './env'
import { buildRig, clipsStep, finalRenderStep, castSheetStep, makeClip, previewRenderStep, reviewClip, rigStep, setStep, timelineStep, voiceStep, frameReviews } from './media'
import { poseJob, posesStep } from './poses'
import { RIG_PATHS } from './rig'
import type { RigPath } from './rig'
import { Pipeline } from './run'
import { STEPS, emptyState, taskOf } from './steps'
import type { StepDef } from './steps'
import type { bibleAnswer, clipShotAnswer, musicAnswer, pitchesAnswer, reviewAnswer, scriptAnswer, voiceCastAnswer } from './tasks'
import { OMNIVOICE_TAGS } from '../voice/providers/comfy'

/**
 * The job handlers of the pipeline (CTS-07): one per step (`steps.ts`), plus the handlers of the long tool calls (`rig_build`, `clip_generate`,
 * `clip_review`). A step handler does its work, then marks its step done and advances the pipeline, which enqueues the next step's job. The
 * request of every job is the JSON `{episode, step}` in its body; everything else is read from the series folder, so a job that is run again
 * (a restart, a retry) finds what the earlier try left and goes on.
 */

type StepResult = string | { reopened: string }

/** The request is the JSON at the top of the job body (the scheduler's log lines may follow it after a restart). */
export function requestOf(body: string): Record<string, unknown> {
  const text = body.trim()
  if (!text) return {}
  const end = text.indexOf('\n}')
  return JSON.parse(end >= 0 ? text.slice(0, end + 2) : text) as Record<string, unknown>
}

const words = (s: string): number => (s.match(/[\p{L}\p{N}'’-]+/gu) ?? []).length

// ---------------------------------------------------------------- step 1: pitches

async function pitchStep(e: Env): Promise<string> {
  const bible = await e.store.readBible(e.series)
  if (bible.pitches.length === 3 && !e.redo) return 'kept the 3 pitches'
  const b = e.brief
  const r = await ask<z.infer<typeof pitchesAnswer>>(e, {
    id: 'pitches',
    role: 'showrunner',
    kind: 'pitches',
    prompt: `Pitch THREE different premises for a cutout-puppet cartoon series for children aged ${bible.audience.ageMin} to ${bible.audience.ageMax}, from the brief. Each pitch: id (p1, p2, p3), title and logline in Croatian and English, exactly two leads (name and what makes them fun), one or two sets, and why it works. Nothing visual is made until the user picks one.`,
    inputs: { paths: [], json: { brief: b, series: { slug: e.series, title: bible.title, audience: bible.audience, tone: bible.tone, rules: bible.rules } } },
    output: { schema: 'pitches', path: 'tasks/pitches.json' }
  })
  await e.store.writeBible(e.series, { ...bible, pitches: r.value.pitches, chosenPitch: null, chosenAt: undefined })
  return `3 pitches: ${r.value.pitches.map((p) => p.title.en).join(' | ')}; waiting for the user`
}

// ---------------------------------------------------------------- step 1b: bible

async function bibleStep(e: Env): Promise<string> {
  const bible = await requireChosen(e)
  const pitch = bible.pitches.find((p) => p.id === bible.chosenPitch)!
  const keepVoices = new Map(bible.cast.map((c) => [c.id, c.voice]))
  const r = await ask<z.infer<typeof bibleAnswer>>(
    e,
    {
      id: 'bible',
      role: 'showrunner',
      kind: 'bible',
      prompt: 'Turn the chosen premise into the series bible: title, logline, tone, rules, the visual style (look, palette of 4 to 6 colours, outline width, a reference prompt), the cast (the two leads of the pitch, plus at most two more if the premise needs them) with a concrete look for each, and the sets of the pitch. Voices are filled in later.',
      inputs: { paths: [], json: { brief: e.brief, chosenPitch: pitch, audience: bible.audience, current: { tone: bible.tone, rules: bible.rules, style: bible.style } } },
      output: { schema: 'bible', path: 'tasks/bible.json' }
    },
    {
      check: (v) => {
        const a = v as z.infer<typeof bibleAnswer>
        const out: string[] = []
        if (new Set(a.cast.map((c) => c.id)).size !== a.cast.length) out.push('cast ids must differ')
        if (new Set(a.sets.map((s) => s.id)).size !== a.sets.length) out.push('set ids must differ')
        if (a.cast.length < 2) out.push('at least the two leads of the pitch')
        return out
      }
    }
  )
  const v = r.value
  await e.store.writeBible(e.series, {
    ...bible,
    title: v.title,
    logline: v.logline,
    tone: v.tone,
    rules: v.rules,
    style: { ...bible.style, ...v.style },
    cast: v.cast.map((c) => ({ id: c.id, name: c.name, role: c.role, personality: c.personality, look: c.look, ...(c.catchphrases ? { catchphrases: c.catchphrases } : {}), rig: `cast/${c.id}/rig.json`, voice: keepVoices.get(c.id) ?? {} })),
    sets: v.sets.map((s) => ({ id: s.id, name: s.name, description: s.description, file: `sets/${s.id}/set.json` }))
  })
  return `bible: ${v.cast.map((c) => c.id).join(', ')}; sets ${v.sets.map((s) => s.id).join(', ')}`
}

// ---------------------------------------------------------------- step 5: script

const ALLOWED_BEATS = ['line', 'move', 'turn', 'emote', 'gesture', 'look', 'camera', 'pause', 'sfx', 'music', 'title', 'clip']

async function rigFacts(e: Env, bible: Bible): Promise<Record<string, { gestures: string[]; emotions: string[] }>> {
  const out: Record<string, { gestures: string[]; emotions: string[] }> = {}
  for (const c of bible.cast) {
    const rig = await e.store.readRig(e.series, c.id).catch(() => null)
    out[c.id] = { gestures: Object.keys(rig?.gestures ?? {}), emotions: Object.keys(rig?.emotions ?? {}) }
  }
  return out
}

async function setFacts(e: Env, bible: Bible): Promise<Record<string, { marks: string[]; shots: string[] }>> {
  const out: Record<string, { marks: string[]; shots: string[] }> = {}
  for (const s of bible.sets) {
    const set = await e.store.readSet(e.series, s.id).catch(() => null)
    out[s.id] = { marks: Object.keys(set?.marks ?? {}), shots: Object.keys(set?.shots ?? {}) }
  }
  return out
}

/** Everything the writer's script must satisfy before it is written (the `cts_lint` references and `W_LINE_LONG`, checked up front). */
export function scriptProblems(a: z.infer<typeof scriptAnswer>, o: { series: string; episode: string; bible: Bible; rigs: Record<string, { gestures: string[]; emotions: string[] }>; sets: Record<string, { marks: string[]; shots: string[] }>; lineRange: [number, number]; maxWords: number }): string[] {
  const out: string[] = []
  const s = a.script
  if (s.series !== o.series) out.push(`script.series must be "${o.series}"`)
  if (s.id !== o.episode) out.push(`script.id must be "${o.episode}"`)
  const cast = new Set(o.bible.cast.map((c) => c.id))
  for (const c of s.cast) if (!cast.has(c)) out.push(`cast "${c}" is not in the bible`)
  const lines: string[] = []
  const beatIds = new Set<string>()
  let after: string | null = null
  for (const scene of s.scenes) {
    const set = o.sets[scene.set]
    if (!set) {
      out.push(`scene ${scene.id}: set "${scene.set}" is not in the bible`)
      continue
    }
    if (!set.shots.includes(scene.shot)) out.push(`scene ${scene.id}: shot "${scene.shot}" is not a shot of set ${scene.set} (${set.shots.join(', ')})`)
    for (const [who, st] of Object.entries(scene.start)) {
      if (!cast.has(who)) out.push(`scene ${scene.id}: start actor "${who}" is not in the cast`)
      if (!set.marks.includes(st.mark)) out.push(`scene ${scene.id}: start mark "${st.mark}" is not a mark of set ${scene.set} (${set.marks.join(', ')})`)
    }
    for (const b of scene.beats) {
      if (beatIds.has(b.id)) out.push(`beat id "${b.id}" is used twice`)
      beatIds.add(b.id)
      if (!ALLOWED_BEATS.includes(b.type)) out.push(`beat ${b.id}: type "${b.type}" does not exist`)
      if (b.with === 'prev' && (b.type === 'clip' || after === 'clip')) out.push(`beat ${b.id}: no beat runs with "prev" over a clip`)
      after = b.type
      const actor = 'who' in b ? b.who : b.type === 'line' ? b.speaker : null
      if (actor && !cast.has(actor)) out.push(`beat ${b.id}: "${actor}" is not in the cast`)
      if (b.type === 'move' && !set.marks.includes(b.to)) out.push(`beat ${b.id}: mark "${b.to}" is not a mark of set ${scene.set}`)
      if (b.type === 'camera' && !set.shots.includes(b.shot)) out.push(`beat ${b.id}: shot "${b.shot}" is not a shot of set ${scene.set}`)
      const facts = actor ? o.rigs[actor] : undefined
      if ((b.type === 'gesture' || b.type === 'line') && b.gesture && facts && !facts.gestures.includes(b.gesture)) out.push(`beat ${b.id}: gesture "${b.gesture}" does not exist for ${actor} (${facts.gestures.join(', ')})`)
      if ((b.type === 'emote' || b.type === 'line') && b.emotion && facts && !facts.emotions.includes(b.emotion)) out.push(`beat ${b.id}: emotion "${b.emotion}" does not exist for ${actor} (${facts.emotions.join(', ')})`)
      if (b.type === 'line') lines.push(b.line)
    }
  }
  if (new Set(lines).size !== lines.length) out.push('a line id is used by two line beats')
  if (lines.length < o.lineRange[0] || lines.length > o.lineRange[1]) out.push(`the script has ${lines.length} lines; it must have ${o.lineRange[0]} to ${o.lineRange[1]}`)
  for (const lang of ['hr', 'en'] as const) {
    const t = a.text[lang]
    if (t.lang !== lang) out.push(`text.${lang}.lang must be "${lang}"`)
    if (!t.strings[s.titleKey]) out.push(`text.${lang}.strings.${s.titleKey} (the episode title) is missing`)
    for (const id of lines) {
      const entry = t.lines[id]
      if (!entry) out.push(`text.${lang}.lines.${id} is missing`)
      else if (words(entry.text) > o.maxWords) out.push(`W_LINE_LONG: ${lang} ${id} has ${words(entry.text)} words (at most ${o.maxWords}): shorten it`)
    }
    for (const b of s.scenes.flatMap((x) => x.beats)) if (b.type === 'title' && !t.strings[b.key]) out.push(`text.${lang}.strings.${b.key} (title card) is missing`)
  }
  const clips = clipBeats(s)
  if (clips.filter((c) => c.clip === INTRO_ID).length > 1) out.push('the intro clip appears twice')
  if (clips.filter((c) => c.clip === OUTRO_ID).length > 1) out.push('the outro clip appears twice')
  for (const id of badClipIds(s)) out.push(`clip "${id}" is not allowed: the only clips are "intro" and "outro" (no hero clip)`)
  for (const [cue, file] of [...Object.entries(s.music), ...Object.entries(s.sfx)]) if (!/^music\/[A-Za-z0-9_.-]+\.(ogg|wav)$/.test(file)) out.push(`cue ${cue}: file "${file}" must be music/<name>.ogg`)
  return out
}

async function scriptStep(e: Env): Promise<string> {
  const bible = await requireChosen(e)
  const p = e.store.paths(e.series)
  if ((await e.store.exists(p.scriptFile(e.episode))) && !e.redo) {
    const cur = await e.store.readScript(e.series, e.episode)
    if (cur.scenes.some((s) => s.beats.some((b) => b.type === 'line'))) return 'kept the script'
  }
  const b = e.brief
  const range = Array.isArray(b.lineRange) && b.lineRange.length === 2 ? ([Number(b.lineRange[0]), Number(b.lineRange[1])] as [number, number]) : ([12, 16] as [number, number])
  const rigs = await rigFacts(e, bible)
  const sets = await setFacts(e, bible)
  const revise = e.detail.startsWith('revise') ? await e.store.readReview(e.series, e.episode, 'safety').catch(() => null) : null
  const previous = revise ? await e.store.readScript(e.series, e.episode).catch(() => null) : null
  const wantIntro = b.intro !== false
  const wantOutro = b.outro !== false
  const r = await ask<z.infer<typeof scriptAnswer>>(
    e,
    {
      id: 'script',
      role: 'writer',
      kind: 'script',
      prompt: `Write episode "${e.episode}" for the series: the language-independent script (scenes, beats in order) and the texts in Croatian and English. ${range[0]} to ${range[1]} spoken lines in all, each at most 12 words in BOTH languages. Use only the beat types ${ALLOWED_BEATS.join(', ')}, only the marks, shots, gestures and emotions listed in "facts". ${wantIntro ? 'Start with one clip beat {"type":"clip","clip":"intro","seconds":8,"audio":"keep"} (the series intro; no beat runs "with":"prev" over it).' : 'No intro clip.'} ${wantOutro ? 'End with one clip beat {"type":"clip","clip":"outro","seconds":8,"audio":"keep"} (the series outro, the last beat). There is no other clip: no hero clip.' : 'No outro clip, and no other clip either.'} Music cue "theme" is music/theme.ogg; a sound effect cue is music/sfx-<cue>.ogg (at most two). The target length is about ${b.seconds ?? 60} seconds.${revise ? ' This is a REVISION: fix every problem of the safety review and keep what was fine.' : ''}`,
      inputs: {
        paths: [],
        json: {
          brief: b,
          series: e.series,
          episode: e.episode,
          bible: { title: bible.title, logline: bible.logline, tone: bible.tone, rules: bible.rules, cast: bible.cast.map(castView), sets: bible.sets },
          facts: { gesturesAndEmotionsByCast: rigs, marksAndShotsBySet: sets },
          ...(revise ? { safetyReview: revise, previousScript: previous } : {})
        }
      },
      output: { schema: 'script', path: `tasks/script-${e.episode}.json` }
    },
    { check: (v) => scriptProblems(v as z.infer<typeof scriptAnswer>, { series: e.series, episode: e.episode, bible, rigs, sets, lineRange: range, maxWords: 12 }), rounds: 3, maxTokens: 16000 }
  )
  const { script, text } = r.value
  await e.store.writeScript(e.series, e.episode, { ...script, series: e.series, id: e.episode })
  await e.store.writeText(e.series, e.episode, 'hr', { ...text.hr, lang: 'hr' })
  await e.store.writeText(e.series, e.episode, 'en', { ...text.en, lang: 'en' })
  const fresh = await e.store.readBible(e.series)
  if (!fresh.episodes.some((x) => x.id === e.episode)) {
    await e.store.writeBible(e.series, { ...fresh, episodes: [...fresh.episodes, { id: e.episode, title: { hr: text.hr.strings[script.titleKey] ?? e.episode, en: text.en.strings[script.titleKey] ?? e.episode }, status: 'draft' }] })
  }
  const n = script.scenes.flatMap((s) => s.beats).filter((x) => x.type === 'line').length
  return `script ${e.episode}: ${n} lines, ${script.scenes.length} scene(s)`
}

// ---------------------------------------------------------------- step 6: safety

async function safetyStep(e: Env): Promise<StepResult> {
  await requireChosen(e)
  const round = e.state.steps.safety?.attempts ?? 1
  const r = await ask<z.infer<typeof reviewAnswer>>(
    e,
    {
      id: `safety-${round}`,
      role: 'child-safety-reviewer',
      kind: 'safety',
      prompt: `Review episode "${e.episode}" for children aged 4 to 8 (review round ${round}). Read the script and both texts. Verdict "pass" only if nothing frightens, shames or teaches something unsafe; "revise" with every problem (where, what, fix) otherwise. Scores 1 to 5: warmth, clarity, age-fit, safety.`,
      inputs: { paths: [`episodes/${e.episode}/script.json`, `episodes/${e.episode}/text/hr.json`, `episodes/${e.episode}/text/en.json`], json: { audience: (await e.store.readBible(e.series)).audience, rules: (await e.store.readBible(e.series)).rules } },
      output: { schema: 'review', path: `episodes/${e.episode}/reviews/safety.json` }
    },
    { check: (v) => ((v as z.infer<typeof reviewAnswer>).verdict === 'revise' && (v as z.infer<typeof reviewAnswer>).problems.length === 0 ? ['a "revise" verdict needs at least one problem with where, what and fix'] : []) }
  )
  if (r.value.verdict === 'pass') return `safety pass (round ${round})`
  if (round <= 2) {
    await e.pipe.reopen(e.series, e.episode, ['script', 'safety'], `revise ${round}: ${r.value.problems.length} problem(s)`)
    return { reopened: `safety asked for a revision (round ${round}): ${r.value.problems.map((p) => p.what).join('; ').slice(0, 200)}` }
  }
  throw new Error(`the child-safety review did not pass after 2 revisions: ${r.value.problems.map((p) => `${p.where}: ${p.what}`).join('; ').slice(0, 400)}`)
}

// ---------------------------------------------------------------- step 7: voice cast

const GEMINI_VOICES = ['Charon', 'Aoede', 'Gacrux', 'Puck', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Algenib', 'Sulafat', 'Achird', 'Zephyr', 'Umbriel', 'Vindemiatrix', 'Iapetus', 'Erinome']

async function auditionLine(e: Env, bible: Bible, castId: string, lang: Lang, text: string, spec: NonNullable<Bible['cast'][number]['voice'][Lang]>): Promise<string | null> {
  const { deps, config } = await voiceDeps(e.svc, { autoStart: true, log: (m) => e.log(m) })
  const dir = path.join(e.store.paths(e.series).castDir(castId), 'voice')
  await fs.mkdir(dir, { recursive: true })
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cts-audition-'))
  try {
    const job: ClipJob = {
      id: `audition-${lang}`,
      lang,
      speaker: castId,
      text,
      style: '',
      speed: spec.speed,
      hash: `audition-${castId}-${lang}`,
      voice: { gemini: spec.gemini ?? 'Kore', vibetts: spec.vibetts ?? '', comfy: { engine: spec.comfy?.engine ?? config.engine, instruct: spec.comfy?.instruct ?? '', ref: null, refText: null, seed: spec.comfy?.seed ?? 7 } }
    }
    const speaker = lang === 'hr' ? comfySpeaker({ comfy: deps.comfy, defaultEngine: config.engine, dataDir: e.svc.dataDir, series: e.series, chunkChars: config.chunkChars, kindSwitch: deps.kindSwitch }) : vibettsSpeaker({ client: deps.vibetts, voices: await deps.vibetts.listVoices() })
    let made: string | null = null
    const outcome = await speaker.speak([job], {
      tmp,
      signal: e.ctx.signal,
      log: (m) => e.log(m),
      onSpoken: async (_j, s) => {
        const out = path.join(dir, `${lang}.wav`)
        await normaliseWav(s.file, out)
        made = out
      }
    })
    if (!made && outcome.failed[0]) e.log(`audition ${castId} ${lang}: ${outcome.failed[0].error}`)
    return made
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

async function voiceCastStep(e: Env): Promise<string> {
  const bible = await requireChosen(e)
  const config = await loadVoiceConfig(e.svc.dataDir)
  let english: string[] = []
  try {
    const { deps } = await voiceDeps(e.svc, { autoStart: false })
    english = (await deps.vibetts.listVoices()).voices.filter((v) => v.languages.includes('en')).map((v) => v.id)
  } catch {
    /* VibeTTS is not up: the director picks from the usual Kokoro names */
  }
  const r = await ask<z.infer<typeof voiceCastAnswer>>(
    e,
    {
      id: 'voice-cast',
      role: 'voice-director',
      kind: 'voice-cast',
      prompt: 'Give every character a voice in Croatian and in English, and one short audition line each (in the character\'s own voice and language). Croatian: OmniVoice attribute tags only (comma separated, one per category), a fixed seed, and a Supertonic fallback voice id. English: a Kokoro voice, different for each lead. Also name a Gemini voice for each (used only when the free quota allows).',
      inputs: { paths: [], json: { cast: bible.cast.map(castView), omniVoiceTags: OMNIVOICE_TAGS, omniVoiceEngine: config.engine, kokoroVoices: english.length ? english : ['af_bella', 'af_heart', 'af_nicole', 'af_sarah', 'af_sky', 'am_adam', 'am_michael', 'bf_emma', 'bm_george'], geminiVoices: GEMINI_VOICES, supertonicFallback: ['supertonic:F1', 'supertonic:F2', 'supertonic:F3', 'supertonic:M1', 'supertonic:M2', 'supertonic:M3'], note: 'the voice record shape is {provider:"auto", gemini, comfy:{engine,instruct,ref:null,refText:null,seed}, vibetts, speed:1, style}' } },
      output: { schema: 'voice-cast', path: 'tasks/voice-cast.json' }
    },
    {
      check: (v) => {
        const a = v as z.infer<typeof voiceCastAnswer>
        const out: string[] = []
        const enVoices = new Set<string>()
        for (const c of bible.cast) {
          const vv = a.voices[c.id]
          if (!vv) {
            out.push(`voices.${c.id} is missing`)
            continue
          }
          if (!a.audition[c.id]) out.push(`audition.${c.id} is missing`)
          if (!vv.hr.comfy?.instruct) out.push(`voices.${c.id}.hr.comfy.instruct (OmniVoice tags) is missing`)
          else for (const prob of checkOmniInstruct(vv.hr.comfy.instruct).problems) out.push(`voices.${c.id}.hr: ${prob}`)
          if (!vv.hr.vibetts) out.push(`voices.${c.id}.hr.vibetts (the Supertonic fallback) is missing`)
          if (!vv.en.vibetts) out.push(`voices.${c.id}.en.vibetts (a Kokoro voice) is missing`)
          else if (enVoices.has(vv.en.vibetts)) out.push(`voices.${c.id}.en.vibetts "${vv.en.vibetts}" is used by another character: each one needs its own`)
          else enVoices.add(vv.en.vibetts)
        }
        return out
      }
    }
  )
  const fresh = await e.store.readBible(e.series)
  await e.store.writeBible(e.series, { ...fresh, cast: fresh.cast.map((c) => ({ ...c, voice: r.value.voices[c.id] ? { hr: r.value.voices[c.id]!.hr, en: r.value.voices[c.id]!.en } : c.voice })) })
  const heard: string[] = []
  for (const c of bible.cast) {
    for (const lang of ['hr', 'en'] as const) {
      try {
        const spec = r.value.voices[c.id]?.[lang]
        const text = r.value.audition[c.id]?.[lang]
        if (spec && text && (await auditionLine(e, bible, c.id, lang, text, spec))) heard.push(`${c.id}/${lang}`)
      } catch (err) {
        e.log(`audition ${c.id} ${lang} failed: ${(err as Error).message.split('\n')[0]}`)
      }
    }
  }
  return `voices for ${bible.cast.map((c) => c.id).join(', ')}; auditions ${heard.length ? heard.join(', ') : 'none (the voice services were not up)'}`
}

// ---------------------------------------------------------------- step 9: music

function cueFiles(script: Episode): { music: string[]; sfx: string[] } {
  const music = new Set<string>()
  const sfx = new Set<string>()
  for (const s of script.scenes) for (const b of s.beats) if (b.type === 'music') music.add(b.cue)
  for (const s of script.scenes) for (const b of s.beats) if (b.type === 'sfx') sfx.add(b.cue)
  return { music: [...music], sfx: [...sfx] }
}

async function musicStep(e: Env): Promise<string> {
  const bible = await requireChosen(e)
  const script = await e.store.readScript(e.series, e.episode)
  const cues = cueFiles(script)
  const p = e.store.paths(e.series)
  if ((await e.store.exists(path.join(p.root, 'music', 'theme.ogg'))) && !e.redo) return 'kept the theme'
  const r = await ask<z.infer<typeof musicAnswer>>(
    e,
    {
      id: 'music',
      role: 'composer',
      kind: 'music',
      prompt: `Pick the theme for the series (a 40 second instrumental, soft background music for a children's cartoon under dialogue): the style tags, the tempo (bpm), the key and a seed. If the script has sound effect cues, plan one effect per cue (at most two; "name" is the cue name, "prompt" describes the sound).`,
      inputs: { paths: [], json: { tone: bible.tone, logline: bible.logline, style: bible.style.look, audience: bible.audience, scriptCues: cues } },
      output: { schema: 'music', path: 'tasks/music.json' }
    },
    { check: (v) => ((v as z.infer<typeof musicAnswer>).sfx ?? []).flatMap((s) => (s.name && cues.sfx.includes(s.name) ? [] : [`sfx name "${s.name ?? ''}" is not a cue of the script (${cues.sfx.join(', ') || 'none'})`])) }
  )
  const comfy = await e.svc.comfy({ autoStart: true, log: (m) => e.log(m) })
  const v = r.value
  const res = await generateTheme({
    comfy,
    store: e.store,
    dataDir: e.svc.dataDir,
    request: { series: e.series, tags: v.tags, bpm: v.bpm, key: v.key, seed: v.seed, ...(v.seconds ? { seconds: v.seconds } : {}), ...(v.sfx?.length ? { sfx: v.sfx.map((s) => ({ name: `sfx-${s.name}`, prompt: s.prompt, seconds: s.seconds })) } : {}) },
    log: (m) => e.log(m),
    signal: e.ctx.signal
  })
  for (const w of res.warnings) e.log(`warning: ${w}`)
  // the script's cues point at the files that exist; a cue without a file is dropped (a title card needs no music)
  const have = new Set([...(res.theme ? [res.theme.file] : []), ...res.sfx.map((s) => s.file)])
  const music = Object.fromEntries(Object.entries(script.music).filter(([, f]) => have.has(f)))
  if (res.theme && !Object.values(music).includes(res.theme.file) && cues.music.length > 0) for (const cue of cues.music) music[cue] = res.theme.file
  const sfx = Object.fromEntries(Object.entries(script.sfx).filter(([, f]) => have.has(f)))
  for (const s of res.sfx) {
    const cue = s.file.replace(/^music\/sfx-/, '').replace(/\.[a-z]+$/, '')
    if (cues.sfx.includes(cue)) sfx[cue] = s.file
  }
  const scenes = script.scenes.map((s) => ({ ...s, beats: s.beats.filter((b) => (b.type === 'music' ? cues.music.length > 0 && b.cue in music : b.type === 'sfx' ? b.cue in sfx : true)) }))
  await e.store.writeScript(e.series, e.episode, { ...script, scenes, music, sfx })
  return res.theme ? `theme ${res.theme.file} (${res.theme.seconds.toFixed(1)} s, ${res.theme.engine}, ${res.theme.wallSeconds} s wall), ${res.sfx.length} effect(s)${res.warnings.length ? `; ${res.warnings.length} warning(s)` : ''}` : `NO MUSIC: ${res.warnings[0] ?? 'ComfyUI did not answer'}`
}

// ---------------------------------------------------------------- step 9b: clip shots

async function clipShotsStep(e: Env): Promise<string> {
  const bible = await requireChosen(e)
  const need = await missingClips(e.store, e.series, e.episode)
  if (need.length === 0) return 'no clips needed'
  const script = await e.store.readScript(e.series, e.episode)
  const ids = need.map((n) => n.clip)
  const r = await ask<z.infer<typeof clipShotAnswer>>(
    e,
    {
      id: 'clip-shots',
      role: 'showrunner',
      kind: 'clip-shots',
      prompt: `Write the shot for each missing Flow clip (${ids.join(', ')}): who is in it (cast ids, at most 3), what happens in 8 seconds as flat 2D cutout motion, the framing and move, and what the first frame (keyframe) shows. The intro is the series intro with the two leads; the outro is the closing moment with the two leads. Also give staging for the keyframe still that our own player draws: the set, a camera shot of it, and each lead's mark, facing, emotion and optional gesture (only names listed in the input; the sets' marks and shots are in "sets", the emotions and gestures in "cast"). No speech, no 3D, no shading.`,
      inputs: { paths: [], json: { missing: need, series: { title: bible.title, logline: bible.logline, style: bible.style }, cast: bible.cast.map(castView), sets: bible.sets, scriptBeatsAround: script.scenes.map((s) => ({ scene: s.id, set: s.set, beats: s.beats.map((b) => ({ id: b.id, type: b.type, ...('clip' in b ? { clip: b.clip } : {}), ...('speaker' in b ? { speaker: b.speaker } : {}) })) })) } },
      output: { schema: 'clip-shots', path: 'tasks/clip-shots-new.json' }
    },
    {
      check: (v) => {
        const a = v as z.infer<typeof clipShotAnswer>
        const out: string[] = []
        for (const id of ids) if (!a.clips.some((c) => c.id === id)) out.push(`the shot for "${id}" is missing`)
        for (const c of a.clips) {
          if (!ids.includes(c.id)) out.push(`"${c.id}" is not a missing clip (${ids.join(', ')})`)
          for (const w of c.who) if (!bible.cast.some((x) => x.id === w)) out.push(`clip ${c.id}: "${w}" is not in the cast`)
        }
        return out
      }
    }
  )
  const prev = await readShots(e.store, e.series)
  const merged = [...(prev?.clips ?? []).filter((c) => !r.value.clips.some((n) => n.id === c.id)), ...r.value.clips]
  await e.store.writeFile(e.series, 'tasks/clip-shots.json', `${JSON.stringify({ clips: merged }, null, 2)}\n`)
  const { screenplay, shotIds } = buildScreenplay(e.series, e.episode, bible, merged)
  const dir = videoDir(e.store, e.series, e.episode)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'screenplay.json'), `${JSON.stringify(screenplay, null, 2)}\n`)
  await fs.writeFile(path.join(dir, 'clips-map.json'), `${JSON.stringify(shotIds, null, 2)}\n`)
  return `shots for ${ids.join(', ')}; video-plan input at ${relTo(e, path.join(dir, 'screenplay.json'))}`
}

// ---------------------------------------------------------------- step 12: frame review

async function frameReviewStep(e: Env): Promise<string> {
  await requireChosen(e)
  const bible = await e.store.readBible(e.series)
  const lint = await lintSeries(e.store, e.series, { episode: e.episode, requireAudio: true })
  const out: string[] = []
  for (const lang of bible.languages) {
    const prior = await frameReviews(e, lang)
    const round = (prior[prior.length - 1]?.round ?? 0) + 1
    if (round > 2) {
      out.push(`${lang}: 2 rounds done, ${prior[prior.length - 1]!.problems} open problem(s)`)
      continue
    }
    const sheet = path.join(e.store.paths(e.series).episodeDir(e.episode), 'render', lang, 'sheet-12.png')
    if (!(await e.store.exists(sheet))) throw new Error(`no contact sheet for ${lang} (${relTo(e, sheet)}): the preview_render step makes it`)
    const r = await ask<z.infer<typeof reviewAnswer>>(
      e,
      {
        id: `frames-${lang}-${round}`,
        role: 'frame-critic',
        kind: 'frames',
        prompt: `Review the contact sheet of the ${lang} preview (round ${round} of at most 2): the first picture is 12 frames of the episode in time order, the others are the pose sheets of the characters. Look for: a character off model, parts detached or overlapping wrongly, the mouth open in silence or closed while speaking, the wrong facing, an actor off frame, a missing or wrong background. For each problem say where (time and character), what, and the data fix (a mark, an SVG, a beat) and who owns it.`,
        inputs: { paths: [relTo(e, sheet), ...(await Promise.all(bible.cast.map(async (c) => rigSheetName(e.store.paths(e.series).castDir(c.id), e.store.paths(e.series).castDir(c.id)).then((n) => (n ? `cast/${c.id}/${n}` : null))))).filter((x): x is string => !!x)], json: { lang, round, lintWarnings: lint.warnings.slice(0, 12).map((w) => `${w.code} ${w.message}`), mouthOpenShare: lint.stats.lines.filter((l) => l.lang === lang).map((l) => ({ line: l.line, share: Math.round(l.share * 100) / 100 })) } },
        output: { schema: 'review', path: `episodes/${e.episode}/reviews/frames-${lang}-${round}.json` }
      },
      { check: (v) => ((v as z.infer<typeof reviewAnswer>).verdict === 'revise' && (v as z.infer<typeof reviewAnswer>).problems.length === 0 ? ['a "revise" verdict needs at least one problem'] : []) }
    )
    out.push(`${lang} round ${round}: ${r.value.verdict}${r.value.problems.length ? `, ${r.value.problems.length} problem(s)` : ''}`)
  }
  return out.join('; ')
}

// ---------------------------------------------------------------- registration

type StepFn = (e: Env) => Promise<StepResult>

const STEP_FNS: Record<string, StepFn> = {
  pitch: pitchStep,
  bible: bibleStep,
  cast_sheet: castSheetStep,
  rig: rigStep,
  poses: posesStep,
  set: setStep,
  script: scriptStep,
  safety: safetyStep,
  voice_cast: voiceCastStep,
  voice: voiceStep,
  music: musicStep,
  clip_shots: clipShotsStep,
  clips: clipsStep,
  timeline: timelineStep,
  preview_render: previewRenderStep,
  frame_review: frameReviewStep,
  final_render: finalRenderStep
}

function envFor(svc: Engine['cts'], pipe: Pipeline, ctx: JobContext, state: Awaited<ReturnType<Pipeline['read']>>, stepId: string, episode: string): Env {
  return makeEnv({ svc, pipe, ctx, series: ctx.job.book as string, episode, stepId, state: state! })
}

/** The job handlers (`ENGINE_MODULES`): one per step, and the ones behind the long tool calls. */
export function registerPipeline(engine: Engine): void {
  const svc = engine.cts
  const pipe = new Pipeline(svc)
  for (const step of STEPS) {
    if (step.kind === 'gate') continue
    const fn = STEP_FNS[step.id]
    if (!fn) throw new Error(`no handler for step ${step.id}`)
    engine.queue.register(taskOf(step), (ctx) => runStep(svc, pipe, step, fn, ctx), { noModel: step.kind === 'code' })
  }

  // ---- the long tool calls ----
  engine.queue.register(
    'rig_build',
    async (ctx) => {
      const series = ctx.job.book as string
      const req = requestOf(ctx.jobBody)
      const episode = String(req.episode)
      const state = await pipe.read(series, episode)
      const e = makeEnv({ svc, pipe, ctx, series, episode, stepId: 'rig', state: state ?? (await emptyFor(svc, series, episode)) })
      const bible = await requireChosen(e)
      const rp = String(req.path) as RigPath
      if (!(RIG_PATHS as readonly string[]).includes(rp)) throw new Error(`unknown rig path "${rp}" (${RIG_PATHS.join(', ')})`)
      const r = await buildRig(e, bible, String(req.cast), rp)
      return { result: `${req.cast} variant ${r.variant} (${rp}): ${r.status} in ${r.wallSeconds} s${r.note ? ` - ${r.note}` : ''}` }
    },
    {}
  )
  engine.queue.register(
    'pose_make',
    async (ctx) => {
      const series = ctx.job.book as string
      const req = requestOf(ctx.jobBody)
      const episode = String(req.episode)
      const e = makeEnv({ svc, pipe, ctx, series, episode, stepId: 'rig', state: (await pipe.read(series, episode)) ?? (await emptyFor(svc, series, episode)) })
      return { result: await poseJob(e, String(req.cast), String(req.gesture), req.facePlates === true) }
    },
    {}
  )
  engine.queue.register(
    'clip_generate',
    async (ctx) => {
      const series = ctx.job.book as string
      const req = requestOf(ctx.jobBody)
      const episode = String(req.episode)
      const e = makeEnv({ svc, pipe, ctx, series, episode, stepId: 'clips', state: (await pipe.read(series, episode)) ?? (await emptyFor(svc, series, episode)) })
      return { result: await makeClip(e, String(req.clip), Number(req.maxCredits), req.polish === true) }
    },
    {}
  )
  engine.queue.register(
    'clip_review',
    async (ctx) => {
      const series = ctx.job.book as string
      const req = requestOf(ctx.jobBody)
      const episode = String(req.episode)
      const e = makeEnv({ svc, pipe, ctx, series, episode, stepId: 'clips', state: (await pipe.read(series, episode)) ?? (await emptyFor(svc, series, episode)) })
      const clip = String(req.clip)
      const { entry, level } = await readClipEntry(e.store, series, episode, clip)
      if (!entry) throw new Error(`no clip "${clip}" in clips.json`)
      const abs = e.store.resolve(series, level === 'series' ? entry.file : `episodes/${episode}/${entry.file}`)
      const shots = await readShots(e.store, series)
      const verdict = await reviewClip(e, clip, abs, shots?.clips.find((c) => c.id === clip)?.who ?? [])
      await upsertClip(e.store, series, episode, level, { ...entry, review: verdict })
      return { result: `clip ${clip}: ${verdict}` }
    },
    {}
  )
}

async function emptyFor(svc: Engine['cts'], series: string, episode: string) {
  return emptyState(series, episode, localIso(new Date()))
}

async function runStep(svc: Engine['cts'], pipe: Pipeline, step: StepDef, fn: StepFn, ctx: JobContext): Promise<{ result: string }> {
  const series = ctx.job.book
  if (!series) throw new Error(`a ${step.id} job needs a series`)
  const episode = String(requestOf(ctx.jobBody).episode ?? ctx.job.unit ?? '')
  const state = await pipe.read(series, episode)
  if (!state) throw new Error(`no pipeline state for ${series}/${episode}`)
  const e = envFor(svc, pipe, ctx, state, step.id, episode)
  e.progress(null, `${step.label}`)
  try {
    const r = await fn(e)
    if (typeof r === 'string') await pipe.markDone(series, episode, step.id, r)
    await pipe.advanceQuietly(series, episode)
    return { result: typeof r === 'string' ? r : r.reopened }
  } catch (err) {
    if (!isAbortError(err) && !ctx.signal.aborted) await pipe.noteFailure(series, episode, step.id, (err as Error).message)
    throw err
  }
}

