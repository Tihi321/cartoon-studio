// Preview controls (`?preview=1`): play/pause, scrub, language switch and best-effort audio. The wall clock lives only here;
// frames come from `cts.renderFrame(i)`, so what you see at frame i is what the renderer would draw.
import { LANGS, type Lang, type Timeline } from '../shared/contracts'
import { fetchJson } from './assets'
import { frameAt, frameTime } from './stage'

export interface PreviewApi {
  timeline(): Timeline | null
  frameCount(): number
  renderFrame(i: number): Promise<void>
  loadLang(lang: Lang): Promise<void>
  /** Base url of the series folder (ends with `/`). */
  baseUrl: string
}

export interface PreviewParams {
  lang: Lang
  t: number
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, testid: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.dataset.testid = testid
  if (text) e.textContent = text
  return e
}

export function mountPreview(root: HTMLElement, api: PreviewApi, params: PreviewParams): void {
  const bar = el('div', 'cts-controls')
  bar.className = 'cts-controls'
  const play = el('button', 'cts-play', 'Play')
  play.type = 'button'
  const scrub = el('input', 'cts-scrub')
  scrub.type = 'range'
  scrub.min = '0'
  scrub.step = '1'
  const time = el('span', 'cts-time', '0.00 / 0.00')
  const lang = el('select', 'cts-lang')
  for (const l of LANGS) {
    const o = document.createElement('option')
    o.value = l
    o.textContent = l.toUpperCase()
    lang.append(o)
  }
  lang.value = params.lang
  const status = el('span', 'cts-status', '')
  const audioBox = el('div', 'cts-audio')
  audioBox.hidden = true
  bar.append(play, scrub, time, lang, status)
  root.append(bar, audioBox)

  let audios: { el: HTMLAudioElement; t0: number; t1: number }[] = []
  let frame = 0
  let playing = false
  let t0Wall = 0
  let t0Time = 0
  let busy = false

  const fps = () => api.timeline()?.fps.out ?? 24
  const duration = () => api.timeline()?.duration ?? 0

  function buildAudio(): void {
    for (const a of audios) {
      a.el.pause()
      a.el.remove()
    }
    audios = []
    const tl = api.timeline()
    if (!tl) return
    tl.audio.forEach((a, n) => {
      const e = document.createElement('audio')
      e.dataset.testid = `cts-audio-${n}`
      e.preload = 'auto'
      e.src = new URL(a.file, api.baseUrl).href
      e.volume = Math.max(0, Math.min(1, a.gain))
      audioBox.append(e)
      audios.push({ el: e, t0: a.t, t1: a.kind === 'music' ? a.until : Number.POSITIVE_INFINITY })
    })
  }

  function syncAudio(t: number): void {
    for (const a of audios) {
      const local = t - a.t0
      const live = playing && local >= 0 && t < a.t1 && !(a.el.duration && local > a.el.duration)
      if (!live) {
        if (!a.el.paused) a.el.pause()
        continue
      }
      if (a.el.paused) {
        a.el.currentTime = local
        void a.el.play().catch(() => undefined)
      } else if (Math.abs(a.el.currentTime - local) > 0.25) {
        a.el.currentTime = local
      }
    }
  }

  async function show(i: number): Promise<void> {
    const n = api.frameCount()
    frame = Math.max(0, Math.min(Math.max(0, n - 1), i))
    await api.renderFrame(frame)
    scrub.value = String(frame)
    time.textContent = `${frameTime(frame, fps()).toFixed(2)} / ${duration().toFixed(2)}`
  }

  function setPlaying(on: boolean): void {
    playing = on
    play.textContent = on ? 'Pause' : 'Play'
    if (on) {
      if (frame >= api.frameCount() - 1) frame = 0
      t0Wall = performance.now()
      t0Time = frameTime(frame, fps())
      requestAnimationFrame(tick)
    } else {
      syncAudio(frameTime(frame, fps()))
    }
  }

  function tick(now: number): void {
    if (!playing) return
    const t = t0Time + (now - t0Wall) / 1000
    if (t >= duration()) {
      void show(api.frameCount() - 1)
      setPlaying(false)
      return
    }
    if (!busy) {
      busy = true
      void show(frameAt(t, fps())).finally(() => (busy = false))
    }
    syncAudio(t)
    requestAnimationFrame(tick)
  }

  async function reloadTimeline(l: Lang): Promise<void> {
    status.textContent = 'loading...'
    const t = frameTime(frame, fps())
    setPlaying(false)
    try {
      await api.loadLang(l)
      buildAudio()
      scrub.max = String(Math.max(0, api.frameCount() - 1))
      await show(frameAt(t, fps()))
      status.textContent = ''
    } catch (e) {
      status.textContent = `error: ${(e as Error).message}`
    }
  }

  play.addEventListener('click', () => setPlaying(!playing))
  scrub.addEventListener('input', () => {
    if (playing) setPlaying(false)
    void show(Number(scrub.value))
    syncAudio(frameTime(frame, fps()))
  })
  lang.addEventListener('change', () => void reloadTimeline(lang.value as Lang))

  scrub.max = String(Math.max(0, api.frameCount() - 1))
  buildAudio()
  void show(frameAt(params.t, fps()))
}

/** Fetches `episodes/<ep>/timeline.<lang>.json` under the series folder. */
export function fetchTimeline(baseUrl: string, episode: string, lang: Lang): Promise<unknown> {
  return fetchJson(new URL(`episodes/${episode}/timeline.${lang}.json`, baseUrl).href)
}
