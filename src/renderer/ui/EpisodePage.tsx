import { useEffect } from 'react'
import { LANGS } from '../../shared/contracts'
import type { Beat, Episode, Lang } from '../../shared/contracts'
import { episodeFile, normalizeEpisode, seconds, useTool } from '../lib/studio'
import type { EpisodeInfo, IssueView, LintView } from '../lib/studio'
import { lineVoice, lineVoiceFromLines } from '../store/episode'
import { useCts } from '../store/hooks'
import { ctsStore } from '../store/store'
import { Pill } from './common'
import { LANG_NAME, NeedSeries, PlayButton, ToolGate, VoicePill, useSeries } from './studio'

/** Episode: the script beat by beat, each line in both languages with the state of its voice, and what the lint says. */
export function EpisodePage() {
  const slug = useCts((s) => s.selection.series)
  const ep = useCts((s) => s.selection.episode)
  const info = useSeries()
  return (
    <div className="page-body" data-testid="page-episode">
      <header className="page-head">
        <h1>Episode</h1>
      </header>
      {!slug && <NeedSeries />}
      {slug && (
        <ToolGate state={info} tool="cts_series_get" testId="episode-series">
          {!ep ? (
            <p className="dim" data-testid="episode-none">
              No episode yet. The pipeline writes the script after the premise is chosen.
            </p>
          ) : (
            <EpisodeView key={`${slug}/${ep}`} slug={slug} ep={ep} />
          )}
        </ToolGate>
      )}
    </div>
  )
}

function EpisodeView({ slug, ep }: { slug: string; ep: string }) {
  const t = useTool('cts_episode_get', { series: slug, episode: ep }, normalizeEpisode)
  // the lint is a real tool of this engine, it answers even when the episode tool is not there yet
  const lint = useTool<LintView>('cts_lint', { series: slug, episode: ep })
  return (
    <>
      <LintPanel state={lint} />
      <ToolGate state={t} tool="cts_episode_get" testId="episode-detail">
        {t.data && t.data.episode && <Script slug={slug} ep={ep} data={t.data} script={t.data.episode} />}
        {t.data && !t.data.episode && (
          <p className="dim" data-testid="episode-no-script">
            This episode has no script yet{t.data.state ? ` (pipeline: ${t.data.state})` : ''}.
          </p>
        )}
      </ToolGate>
    </>
  )
}

function LintPanel({ state }: { state: { data: LintView | null; error: Error | null; loading: boolean } }) {
  if (state.loading && !state.data) return null
  if (state.error || !state.data) return null
  const d = state.data
  const all: IssueView[] = [...d.errors, ...d.warnings]
  return (
    <section className="sheet panel" aria-labelledby="ep-lint" data-testid="episode-lint">
      <div className="row spread">
        <h2 className="panel-title" id="ep-lint">
          Lint
        </h2>
        <span className="row">
          <Pill tone={d.errors.length ? 'bad' : 'good'} testId="lint-errors">
            {d.errors.length} error{d.errors.length === 1 ? '' : 's'}
          </Pill>
          <Pill tone={d.warnings.length ? 'warn' : 'dim'} testId="lint-warnings">
            {d.warnings.length} warning{d.warnings.length === 1 ? '' : 's'}
          </Pill>
          {d.stats.minShare !== null && <Pill tone="dim">mouth open in at least {Math.round(d.stats.minShare * 100)}% of every line</Pill>}
        </span>
      </div>
      {all.length === 0 ? (
        <p className="dim">Nothing to fix.</p>
      ) : (
        <ul className="plain issues" data-testid="lint-list">
          {all.slice(0, 40).map((i, n) => (
            <li key={n} className={i.severity === 'error' ? 'issue bad' : 'issue'}>
              <code>{i.code}</code> {i.message}
              {(i.file || i.where) && <span className="dim"> {[i.file, i.where].filter(Boolean).join(' ')}</span>}
            </li>
          ))}
          {all.length > 40 && <li className="dim">and {all.length - 40} more</li>}
        </ul>
      )}
    </section>
  )
}

function Script({ slug, ep, data, script }: { slug: string; ep: string; data: EpisodeInfo; script: Episode }) {
  const info = useSeries()
  const cast = info.data?.bible.cast ?? []
  const name = (id: string) => cast.find((c) => c.id === id)?.name.en ?? id
  // put what the manifests say into the state; live events then overwrite single lines
  useEffect(() => {
    for (const lang of LANGS) {
      const m = data.voice[lang]
      if (m) ctsStore.getState().seedVoice(slug, ep, lang, lineVoiceFromLines(lang, m))
    }
  }, [slug, ep, data.voice])
  const lines = script.scenes.flatMap((s) => s.beats).filter((b) => b.type === 'line').length
  return (
    <section aria-labelledby="ep-script" data-testid="episode-script">
      <div className="row spread">
        <h2 className="panel-title" id="ep-script">
          Script <span className="dim title-alt">{lines} lines, {script.scenes.length} scene{script.scenes.length === 1 ? '' : 's'}</span>
        </h2>
        <VoiceTotals slug={slug} ep={ep} script={script} />
      </div>
      {script.scenes.map((scene) => (
        <div className="scene" key={scene.id} data-testid={`scene-${scene.id}`}>
          <h3 className="scene-head">
            <span className="scene-id">{scene.id}</span>
            <span className="dim">set {scene.set}, opens on shot {scene.shot}</span>
          </h3>
          <ol className="beats">
            {scene.beats.map((b) => (
              <li key={b.id} className={`beat beat-${b.type}${b.with ? ' with-prev' : ''}`} data-testid={`beat-${b.id}`}>
                {b.type === 'line' ? <LineBeat slug={slug} ep={ep} beat={b} speaker={name(b.speaker)} data={data} /> : <OtherBeat beat={b} name={name} data={data} />}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  )
}

function VoiceTotals({ slug, ep, script }: { slug: string; ep: string; script: Episode }) {
  const voice = useCts((s) => s.voiceLines)
  const ids = script.scenes.flatMap((s) => s.beats).flatMap((b) => (b.type === 'line' ? [b.line] : []))
  return (
    <span className="row">
      {LANGS.map((lang) => {
        const states = ids.map((id) => lineVoice({ voiceLines: voice }, slug, ep, lang, id).status)
        const ok = states.filter((s) => s === 'ok').length
        const bad = states.filter((s) => s === 'failed' || s === 'placeholder').length
        return (
          <Pill key={lang} tone={ok === ids.length && ids.length ? 'good' : bad ? 'warn' : 'dim'} testId={`voice-total-${lang}`}>
            {lang}: {ok} of {ids.length} voiced
          </Pill>
        )
      })}
    </span>
  )
}

function LineBeat({ slug, ep, beat, speaker, data }: { slug: string; ep: string; beat: Extract<Beat, { type: 'line' }>; speaker: string; data: EpisodeInfo }) {
  const voice = useCts((s) => s.voiceLines)
  return (
    <div className="line-beat">
      <div className="line-meta">
        <b className="speaker">{speaker}</b>
        <code className="dim">{beat.line}</code>
        {beat.emotion && <Pill tone="dim">{beat.emotion}</Pill>}
        {beat.with && <Pill tone="dim">with the line before</Pill>}
      </div>
      <div className="line-langs">
        {LANGS.map((lang: Lang) => {
          const v = lineVoice({ voiceLines: voice }, slug, ep, lang, beat.line)
          const text = data.text[lang]?.lines[beat.line]?.text
          return (
            <div className="line-lang" lang={lang} key={lang} data-testid={`line-${beat.line}-${lang}`}>
              <span className="lang-tag" aria-label={LANG_NAME[lang]}>
                {lang}
              </span>
              <p className={text ? 'line-text' : 'line-text dim'} data-testid={`line-${beat.line}-${lang}-text`}>
                {text ?? 'no text yet'}
              </p>
              <div className="line-voice">
                <VoicePill status={v.status} testId={`line-${beat.line}-${lang}-status`} title={v.error} />
                <span className="dim line-voice-detail" data-testid={`line-${beat.line}-${lang}-detail`}>
                  {v.provider ? v.provider : ''}
                  {v.provider && v.seconds !== undefined ? ', ' : ''}
                  {v.seconds !== undefined ? seconds(v.seconds) : ''}
                </span>
                <PlayButton src={v.file && v.status !== 'pending' ? episodeFile(slug, ep, v.file) : null} label={`${beat.line} in ${LANG_NAME[lang]}`} testId={`line-${beat.line}-${lang}-play`} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function OtherBeat({ beat, name, data }: { beat: Beat; name: (id: string) => string; data: EpisodeInfo }) {
  return (
    <div className="other-beat">
      <code className="beat-type">{beat.type}</code>
      <span>{describe(beat, name, data)}</span>
    </div>
  )
}

function describe(b: Beat, name: (id: string) => string, data: EpisodeInfo): string {
  switch (b.type) {
    case 'line':
      return b.line
    case 'move':
      return `${name(b.who)} walks to ${b.to} in ${seconds(b.seconds)}`
    case 'turn':
      return `${name(b.who)} turns ${b.facing}`
    case 'emote':
      return `${name(b.who)} feels ${b.emotion}`
    case 'gesture':
      return `${name(b.who)} does ${b.gesture}`
    case 'look':
      return `${name(b.who)} looks at ${b.target}`
    case 'camera':
      return `${b.transition === 'cut' ? 'cut' : 'pan'} to shot ${b.shot}${b.seconds ? ` over ${seconds(b.seconds)}` : ''}`
    case 'pause':
      return `pause ${seconds(b.seconds)}`
    case 'sfx':
      return `sound ${b.cue}`
    case 'music':
      return `music ${b.cue} ${b.action}${b.gain !== undefined ? ` at ${Math.round(b.gain * 100)}%` : ''}`
    case 'title':
      return `title card: ${data.text.en?.strings[b.key] ?? b.key} (${seconds(b.seconds)})`
    case 'clip':
      return `video clip ${b.clip}, ${seconds(b.seconds)}, sound ${b.audio === 'keep' ? 'kept' : 'muted'}`
  }
}
