import { useState } from 'react'
import { LANGS } from '../../shared/contracts'
import type { CastMember, RigVariant, VoiceSpec } from '../../shared/contracts'
import { callTool, engineOrigin, normalizeCast, playerUrl, seconds, seriesFile, useTool } from '../lib/studio'
import type { RigCheckView, VariantInfo } from '../lib/studio'
import { useCts } from '../store/hooks'
import { ctsStore } from '../store/store'
import { Pill } from './common'
import { LANG_NAME, NeedSeries, Picture, PlayButton, ToolGate, useSeries } from './studio'

const PATH_NAME: Record<RigVariant, string> = { a: 'Claude draws SVG parts', c: 'Raster cut-out from the reference' }

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
  return (
    <>
      <section className="sheet panel" aria-labelledby="cast-who" data-testid="cast-who">
        <h2 className="panel-title" id="cast-who">
          {member.name.en} <span className="dim title-alt">{member.name.hr}</span>
        </h2>
        <p>{member.personality}</p>
        <div className="row">
          <Pill tone="dim">{member.role}</Pill>
          {t.data && <RigCheckPill check={t.data.check} testId="cast-rig-check" none="no rig yet" />}
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
                <PoseSheet slug={slug} cast={member.id} sheet={t.data.sheet} hasRig={!!t.data.rig} onSaved={t.reload} />
                <figcaption>Pose sheet: neutral, each emotion, gestures, 8 mouths, 3 eye states</figcaption>
              </figure>
            </section>

            <section aria-labelledby="cast-variants" data-testid="cast-variants">
              <h2 className="panel-title" id="cast-variants">
                Rig variants
              </h2>
              <ul className="variants">
                {t.data.variants.map((v) => (
                  <VariantCard key={v.variant} slug={slug} v={v} />
                ))}
              </ul>
            </section>

            <VoiceSection slug={slug} member={member} />
          </>
        )}
      </ToolGate>
    </>
  )
}

/**
 * The pose sheet: the rig-sheet.png when it exists, else the player drawing it live from the rig (its ?sheet=<cast> mode). "Save as rig-sheet.png" makes the file
 * with cts_pose_sheet, which the frame critic and the comparison sheet read.
 */
function PoseSheet({ slug, cast, sheet, hasRig, onSaved }: { slug: string; cast: string; sheet: string | null; hasRig: boolean; onSaved(): void }) {
  const mcp = useCts((s) => s.mcp)
  const origin = mcp?.listening ? engineOrigin(mcp.url) : null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await callTool('cts_pose_sheet', { series: slug, cast })
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (sheet) return <Picture src={seriesFile(slug, sheet)} alt={`Pose sheet of ${cast}`} testId="cast-sheet" />
  return (
    <div className="sheet-live">
      {hasRig && origin ? (
        <iframe className="sheet-frame" title={`Pose sheet of ${cast}`} src={playerUrl(origin, { series: slug, sheet: cast }).replace('preview=1&', '')} data-testid="cast-sheet-live" />
      ) : (
        <Picture src={null} alt="" testId="cast-sheet" />
      )}
      {hasRig && (
        <div className="row">
          <button onClick={() => void save()} disabled={busy} data-testid="cast-sheet-save">
            {busy ? 'Saving...' : 'Save as rig-sheet.png'}
          </button>
          {error && (
            <span className="bad-text" role="alert" data-testid="cast-sheet-error">
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function RigCheckPill({ check, testId, none = 'not checked' }: { check: RigCheckView | null | undefined; testId: string; none?: string }) {
  if (!check)
    return (
      <Pill tone="dim" testId={testId}>
        {none}
      </Pill>
    )
  const errors = check.issues.filter((i) => i.severity === 'error').length
  const warns = check.issues.length - errors
  return (
    <Pill tone={check.ok ? 'good' : 'bad'} testId={testId} title={check.issues.map((i) => `${i.code}: ${i.message}`).join('\n')}>
      {check.ok ? `rig ok, ${check.parts} parts` : `${errors} rig error${errors === 1 ? '' : 's'}`}
      {warns > 0 && `, ${warns} warning${warns === 1 ? '' : 's'}`}
    </Pill>
  )
}

const STATE_TEXT = { done: 'made', failed: 'failed', 'not-run': 'not run' } as const

function VariantCard({ slug, v }: { slug: string; v: VariantInfo }) {
  return (
    <li className={v.chosen ? 'variant chosen' : v.state === 'not-run' ? 'variant idle' : 'variant'} data-testid={`variant-${v.variant}`}>
      <div className="row spread">
        <h3 className="variant-name">
          <span className="variant-letter">({v.variant})</span> {PATH_NAME[v.variant]}
        </h3>
        {v.chosen && <Pill tone="accent">the rig</Pill>}
      </div>
      <Picture src={v.preview ? seriesFile(slug, v.preview) : null} alt={`Rig by path ${v.variant}`} testId={`variant-${v.variant}-img`} />
      <dl className="variant-facts">
        <dt>State</dt>
        <dd data-testid={`variant-${v.variant}-state`}>{STATE_TEXT[v.state]}</dd>
        <dt>Time</dt>
        <dd data-testid={`variant-${v.variant}-time`}>{v.seconds !== undefined ? seconds(v.seconds) : 'none'}</dd>
        <dt>Spend</dt>
        <dd data-testid={`variant-${v.variant}-spend`}>{v.costUsd === undefined ? 'none' : spendText(v)}</dd>
        <dt>Rig check</dt>
        <dd>{v.state === 'done' ? <RigCheckPill check={v.check} testId={`variant-${v.variant}-check`} /> : <span className="dim">nothing to check</span>}</dd>
      </dl>
      {v.note && <p className="dim variant-note">{v.note}</p>}
    </li>
  )
}

function spendText(i: VariantInfo): string {
  const parts = [`$${(i.costUsd ?? 0).toFixed(2)}`]
  if (i.credits) parts.push(`${i.credits} credits`)
  return parts.join(' and ')
}

function VoiceSection({ slug, member }: { slug: string; member: CastMember }) {
  const [missing, setMissing] = useState<Record<string, boolean>>({})
  return (
    <section className="sheet panel" aria-labelledby="cast-voice" data-testid="cast-voice">
      <h2 className="panel-title" id="cast-voice">
        Voice
      </h2>
      <ul className="plain voices">
        {LANGS.map((lang) => {
          const spec: VoiceSpec | undefined = member.voice[lang]
          return (
            <li key={lang} className="voice-row" data-testid={`voice-${lang}`}>
              <b className="voice-lang">{LANG_NAME[lang]}</b>
              <span data-testid={`voice-${lang}-spec`}>{spec ? voiceText(spec) : <span className="dim">no voice set yet</span>}</span>
              <span className="voice-audition">
                <PlayButton src={seriesFile(slug, `cast/${member.id}/voice/${lang}.wav`)} label={`${member.name.en} in ${LANG_NAME[lang]}`} testId={`voice-${lang}-play`} onFail={() => setMissing((m) => ({ ...m, [lang]: true }))} />
                <span className="dim" data-testid={`voice-${lang}-note`}>
                  {missing[lang] ? 'no audition yet' : 'audition'}
                </span>
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
