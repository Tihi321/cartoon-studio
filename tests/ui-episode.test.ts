import { describe, expect, it } from 'vitest'
import type { EngineEvent } from '../src/shared/protocol'
import { initialEpisode, lineVoice, reduceEpisode } from '../src/renderer/store/episode'
import type { EpisodeData } from '../src/renderer/store/episode'
import { ctsStore } from '../src/renderer/store/store'

/** The episode store is fed engine events the way the app feeds it; the views only read what it holds (the views are checked by scripts/studio-shots.mjs). */
const feed = (s: EpisodeData, events: EngineEvent[]): EpisodeData => events.reduce((acc, e) => ({ ...acc, ...reduceEpisode(acc, e, 1000) }), s)

describe('the episode store', () => {
  it('shows each line status per language from voice.clip and job.progress events', () => {
    const at = (line: string, lang: 'hr' | 'en') => lineVoice(s, 'mini', 'ep00-mini', lang, line).status
    let s = initialEpisode()
    expect(at('l01', 'hr')).toBe('pending')

    // the voice step starts the Croatian clip of l01: the line shows as being made, English is untouched
    s = feed(s, [{ type: 'job.progress', jobId: 'mini--voice--hr--r1', series: 'mini', task: 'voice', episode: 'ep00-mini', lang: 'hr', line: 'l01', fraction: 0.1 }])
    expect(at('l01', 'hr')).toBe('running')
    expect(at('l01', 'en')).toBe('pending')
    expect(s.jobs['mini--voice--hr--r1']).toMatchObject({ state: 'running', fraction: 0.1 })

    // the clips come in: ok in Croatian, a placeholder in English, a failure for l02 in Croatian
    s = feed(s, [
      { type: 'voice.clip', series: 'mini', episode: 'ep00-mini', lang: 'hr', line: 'l01', status: 'ok', provider: 'comfy', seconds: 2.4, file: 'voice/hr/l01.wav' },
      { type: 'voice.clip', series: 'mini', episode: 'ep00-mini', lang: 'en', line: 'l01', status: 'placeholder', provider: 'placeholder', seconds: 1.8 },
      { type: 'voice.clip', series: 'mini', episode: 'ep00-mini', lang: 'hr', line: 'l02', status: 'failed', error: 'ComfyUI down' },
      { type: 'job.progress', jobId: 'mini--voice--hr--r1', series: 'mini', task: 'voice', fraction: 1 }
    ])
    expect(at('l01', 'hr')).toBe('ok')
    expect(lineVoice(s, 'mini', 'ep00-mini', 'hr', 'l01')).toMatchObject({ provider: 'comfy', seconds: 2.4, file: 'voice/hr/l01.wav' })
    expect(at('l01', 'en')).toBe('placeholder')
    expect(at('l02', 'hr')).toBe('failed')
    expect(at('l02', 'en')).toBe('pending')

    // making a finished clip again shows it as being made until the new voice.clip comes
    s = feed(s, [{ type: 'job.progress', jobId: 'mini--voice--hr--r2', series: 'mini', task: 'voice', episode: 'ep00-mini', lang: 'hr', line: 'l01', fraction: 0.5 }])
    expect(at('l01', 'hr')).toBe('running')
  })

  it('moves the series out of waiting-on-user when a pitch is chosen', () => {
    let s = feed(initialEpisode(), [{ type: 'series.state', series: 'mini', state: 'waiting-on-user', step: 'pitch' }])
    expect(s.runState.mini).toBe('waiting-on-user')
    s = feed(s, [{ type: 'pitch.chosen', series: 'mini', pitch: 'p2' }])
    expect(s.runState.mini).toBe('running')
    expect(s.chosenPitch.mini).toBe('p2')
  })

  it('applies the same events through the app store', () => {
    ctsStore.getState().applyEvents([
      { type: 'series.state', series: 'mini', state: 'waiting-on-user' },
      { type: 'voice.clip', series: 'mini', episode: 'ep00-mini', lang: 'en', line: 'l03', status: 'ok', seconds: 1 },
      { type: 'pitch.chosen', series: 'mini', pitch: 'p1' }
    ])
    const st = ctsStore.getState()
    expect(st.runState.mini).toBe('running')
    expect(lineVoice(st, 'mini', 'ep00-mini', 'en', 'l03').status).toBe('ok')
  })
})
