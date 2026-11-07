import { LANGS } from '../../shared/contracts'
import type { CastMember, Lang, RigVariant, VoiceSpec } from '../../shared/contracts'
import { normalizeCast, seconds, seriesFile, useTool } from '../lib/studio'
import type { RigCheckView, VariantInfo } from '../lib/studio'
import { useCts } from '../store/hooks'
import { ctsStore } from '../store/store'
import { Pill } from './common'
import { LANG_NAME, NeedSeries, Picture, PlayButton, ToolGate, useSeries } from './studio'

const PATH_NAME: Record<RigVariant, string> = { a: 'Claude draws SVG parts', b: 'Recraft SVG, split into parts', c: 'Raster cut-out from the reference' }

/** Cast: the reference image, the pose sheet, the rig made by each path side by side, the rig check and the voice of each character. */
export function CastPage() {
  const slug = useCts((s) => s.selection.series)
  const castId = useCts((s) => s.selection.cast)
  const info = useSeries()
  const cast = info.data?.bible.cast ?? []
  const member = cast.find((c) => c.id === castId) ?? null
  return (
    <div className="page-body" data-testid="page-cast">
      <header className="page-head">
        <h1>Cast</h1>
      </header>
      {!slug && <NeedSeries />}
      {slug && (
        <ToolGate state={info} tool="cts_series_get" testId="cast-series">
          {cast.length === 0 ? (
            <p className="dim" data-testid="cast-none">
              The cast is made after you choose a premise.
            </p>
          ) : (
            <>
              <ul className="series-strip" data-testid="cast-list">
                {cast.map((c) => (
                  <li key={c.id}>
                    <button className={c.id === castId ? 'series-tab on' : 'series-tab'} aria-pressed={c.id === castId} onClick={() => ctsStore.getState().select({ cast: c.id })} data-testid={`cast-pick-${c.id}`}>
                      <span className="series-tab-title">{c.name.en}</span>
                      <span className="dim series-tab-date">{c.role}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {member && <CastMemberView key={`${slug}/${member.id}`} slug={slug} member={member} />}
            </>
          )}
        </ToolGate>
      )}
    </div>
  )
}

function CastMemberView({ slug, member }: { slug: string; member: CastMember }) {
  const t = useTool('cts_cast_get', { series: slug, cast: member.id }, normalizeCast)
  const base = useTool<RigCheckView>('cts_rig_check', { series: slug, cast: member.id })
  return (
    <>
      <section className="sheet panel" aria-labelledby="cast-who" data-testid="cast-who">
        <h2 className="panel-title" id="cast-who">
          {member.name.en} <span className="dim title-alt">{member.name.hr}</span>
        </h2>
        <p>{member.personality}</p>
        <div className="row">
          <Pill tone="dim">{member.role}</Pill>
          <RigCheckPill state={base} testId="cast-rig-check" />
        </div>
      </section>

      <ToolGate state={t} tool="cts_cast_get" testId="cast-detail">
        {t.data && (
          <>
            <section className="look-pair" aria-label="Look" data-testid="cast-look">
              <figure className="plate">
                <Picture src={t.data.ref ? seriesFile(slug, t.data.ref) : null} alt={`Reference image of ${member.name.en}`} testId="cast-ref" />
                <figcaption>Reference image</figcaption>
              </figure>
              <figure className="plate wide">
                <Picture src={t.data.sheet ? seriesFile(slug, t.data.sheet) : null} alt={`Pose sheet of ${member.name.en}`} testId="cast-sheet" />
                <figcaption>Pose sheet: neutral, each emotion, gestures, 8 mouths, 3 eye states</figcaption>
              </figure>
            </section>

            <section aria-labelledby="cast-variants" data-testid="cast-variants">
              <h2 className="panel-title" id="cast-variants">
                Rig variants
              </h2>
              <ul className="variants">
                {(['a', 'b', 'c'] as const).map((v) => (
                  <VariantCard key={v} slug={slug} cast={member.id} v={v} info={t.data?.variants.find((x) => x.variant === v)} />
                ))}
              </ul>
            </section>

            <VoiceSection slug={slug} member={member} audition={t.data.audition} />
          </>
        )}
      </ToolGate>
    </>
  )
}

function RigCheckPill({ state, testId }: { state: { data: RigCheckView | null; error: Error | null; loading: boolean }; testId: string }) {
  if (state.loading && !state.data) return <Pill testId={testId}>checking the rig</Pill>
  if (state.error || !state.data) return <Pill tone="dim" testId={testId} title={state.error?.message}>rig not checked</Pill>
  const errors = state.data.issues.filter((i) => i.severity === 'error').length
  const warns = state.data.issues.length - errors
  return (
    <Pill tone={state.data.ok ? 'good' : 'bad'} testId={testId} title={state.data.issues.map((i) => `${i.code}: ${i.message}`).join('\n')}>
      {state.data.ok ? `rig ok, ${state.data.parts} parts` : `${errors} rig error${errors === 1 ? '' : 's'}`}
      {warns > 0 && `, ${warns} warning${warns === 1 ? '' : 's'}`}
    </Pill>
  )
}

function VariantCard({ slug, cast, v, info }: { slug: string; cast: string; v: RigVariant; info: VariantInfo | undefined }) {
  const state = info?.state ?? 'not-run'
  const check = useTool<RigCheckView>('cts_rig_check', state === 'done' ? { series: slug, cast, variant: v } : null)
  return (
    <li className={info?.chosen ? 'variant chosen' : state === 'not-run' ? 'variant idle' : 'variant'} data-testid={`variant-${v}`}>
      <div className="row spread">
        <h3 className="variant-name">
          <span className="variant-letter">({v})</span> {PATH_NAME[v]}
        </h3>
        {info?.chosen && <Pill tone="accent">used in the film</Pill>}
      </div>
      <Picture src={info?.preview ? seriesFile(slug, info.preview) : null} alt={`Rig by path ${v}`} testId={`variant-${v}-img`} />
      <dl className="variant-facts">
        <dt>State</dt>
        <dd data-testid={`variant-${v}-state`}>{state === 'done' ? 'made' : state === 'running' ? 'being made' : 'not run'}</dd>
        <dt>Time</dt>
        <dd data-testid={`variant-${v}-time`}>{info?.seconds !== undefined ? seconds(info.seconds) : 'none'}</dd>
        <dt>Spend</dt>
        <dd data-testid={`variant-${v}-spend`}>{info ? spendText(info) : 'none'}</dd>
        <dt>Rig check</dt>
        <dd>{state === 'done' ? <RigCheckPill state={check} testId={`variant-${v}-check`} /> : <span className="dim">nothing to check</span>}</dd>
      </dl>
      {info?.note && <p className="dim variant-note">{info.note}</p>}
    </li>
  )
}

function spendText(i: VariantInfo): string {
  const parts: string[] = []
  if (i.costUsd !== undefined) parts.push(`$${i.costUsd.toFixed(2)}`)
  if (i.credits) parts.push(`${i.credits} credits`)
  return parts.length ? parts.join(' and ') : '$0.00'
}

function VoiceSection({ slug, member, audition }: { slug: string; member: CastMember; audition: Partial<Record<Lang, string>> }) {
  return (
    <section className="sheet panel" aria-labelledby="cast-voice" data-testid="cast-voice">
      <h2 className="panel-title" id="cast-voice">
        Voice
      </h2>
      <ul className="plain voices">
        {LANGS.map((lang) => {
          const spec: VoiceSpec | undefined = member.voice[lang]
          const clip = audition[lang]
          return (
            <li key={lang} className="voice-row" data-testid={`voice-${lang}`}>
              <b className="voice-lang">{LANG_NAME[lang]}</b>
              <span data-testid={`voice-${lang}-spec`}>{spec ? voiceText(spec) : <span className="dim">no voice set yet</span>}</span>
              <span className="voice-audition">
                <PlayButton src={clip ? seriesFile(slug, clip) : null} label={`${member.name.en} in ${LANG_NAME[lang]}`} testId={`voice-${lang}-play`} />
                <span className="dim">{clip ? 'audition' : 'no audition yet'}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function voiceText(s: VoiceSpec): string {
  const detail = s.provider === 'comfy' ? s.comfy?.engine : s.provider === 'vibetts' ? s.vibetts : s.provider === 'gemini' ? s.gemini : undefined
  return `${s.provider}${detail ? `, ${detail}` : ''}${s.speed !== 1 ? `, speed ${s.speed}` : ''}`
}
