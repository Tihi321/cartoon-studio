import { useEffect, useMemo, useState } from 'react'
import type { SetFile } from '../../shared/contracts'
import { normalizeSet, normalizeSet3d, seconds, seriesFile, useTool } from '../lib/studio'
import { useCts } from '../store/hooks'
import { ctsStore } from '../store/store'
import { NeedSeries, Picture, ToolGate, useSeries } from './studio'

/** The camera shapes of the player: a shot's visible height is the set's height over its zoom, the width follows the 16:9 frame. */
const FRAME_ASPECT = 16 / 9

export function shotRect(set: Pick<SetFile, 'size'>, shot: { center: [number, number]; zoom: number }) {
  const h = set.size[1] / shot.zoom
  const w = h * FRAME_ASPECT
  return { x: shot.center[0] - w / 2, y: shot.center[1] - h / 2, w, h }
}

const SHOT_COLORS = ['#c8283f', '#2747c9', '#1f7a4d', '#b8860b', '#7a3fbf', '#d2691e']

/** Sets: each background with its layers, the marks where actors stand and a rectangle for what each shot's camera sees. */
export function SetsPage() {
  const slug = useCts((s) => s.selection.series)
  const setId = useCts((s) => s.selection.set)
  const info = useSeries()
  const sets = info.data?.bible.sets ?? []
  return (
    <div className="page-body" data-testid="page-sets">
      <header className="page-head">
        <h1>Sets</h1>
      </header>
      {!slug && <NeedSeries />}
      {slug && (
        <ToolGate state={info} tool="cts_series_get" testId="sets-series">
          {sets.length === 0 ? (
            <p className="dim" data-testid="sets-none">
              The sets are made after you choose a premise.
            </p>
          ) : (
            <>
              <ul className="series-strip" data-testid="sets-list">
                {sets.map((s) => (
                  <li key={s.id}>
                    <button className={s.id === setId ? 'series-tab on' : 'series-tab'} aria-pressed={s.id === setId} onClick={() => ctsStore.getState().select({ set: s.id })} data-testid={`sets-pick-${s.id}`}>
                      <span className="series-tab-title">{s.name.en}</span>
                      <span className="dim series-tab-date">{s.name.hr}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {setId && info.data?.bible.renderer === 'blender' && <SetView3d key={`${slug}/${setId}`} slug={slug} setId={setId} description={sets.find((s) => s.id === setId)?.description ?? ''} />}
              {setId && info.data?.bible.renderer !== 'blender' && <SetView key={`${slug}/${setId}`} slug={slug} setId={setId} description={sets.find((s) => s.id === setId)?.description ?? ''} />}
            </>
          )}
        </ToolGate>
      )}
    </div>
  )
}

/** A set of a Blender series: the four-view sheet Blender rendered from the spec, with the spec hash, the build and the marks and cameras the script may use. */
function SetView3d({ slug, setId, description }: { slug: string; setId: string; description: string }) {
  const t = useTool('cts_set3d_get', { series: slug, set: setId }, normalizeSet3d)
  return (
    <ToolGate state={t} tool="cts_set3d_get" testId="set3d-detail">
      {t.data && (
        <div className="set-grid">
          <section className="sheet panel stage-panel" aria-labelledby="set3d-sheet-title" data-testid="set3d-panel">
            <h2 className="panel-title" id="set3d-sheet-title">
              {setId} <span className="dim title-alt">3D set sheet: wide, two stand-ins on the first marks, the first named cameras</span>
            </h2>
            {description && <p className="dim">{description}</p>}
            <Picture src={seriesFile(slug, `sets/${setId}/sheet.png`)} alt={`Set sheet of ${setId}`} testId="set3d-sheet" />
          </section>
          <aside className="set-side">
            <section className="sheet panel" aria-labelledby="set3d-facts" data-testid="set3d-facts">
              <h2 className="panel-title" id="set3d-facts">
                Build
              </h2>
              <dl className="variant-facts">
                <dt>Spec hash</dt>
                <dd data-testid="set3d-spec-hash" title={t.data.specHash}>
                  {t.data.specHash.slice(0, 12)}
                </dd>
                <dt>Build</dt>
                <dd data-testid="set3d-build-time">{t.data.build?.buildSeconds != null ? `built in ${seconds(t.data.build.buildSeconds)}` : 'not built yet'}</dd>
                <dt>Up to date</dt>
                <dd data-testid="set3d-stale">{t.data.stale ? 'no: the spec changed after the last build' : 'yes'}</dd>
                <dt>Props</dt>
                <dd>{t.data.spec.props.length}</dd>
              </dl>
              {(t.data.build?.warnings?.length ?? 0) > 0 && (
                <p className="inline-warn" data-testid="set3d-warnings">
                  {t.data.build!.warnings!.join('; ')}
                </p>
              )}
            </section>
            <section className="sheet panel" aria-labelledby="set3d-marks-title" data-testid="set3d-marks">
              <h2 className="panel-title" id="set3d-marks-title">
                Marks
              </h2>
              <ul className="plain marks">
                {Object.entries(t.data.spec.marks).map(([name, p]) => (
                  <li key={name} data-testid={`set3d-mark-${name}`}>
                    <b>{name}</b> <span className="dim">{p.join(', ')} m</span>
                  </li>
                ))}
              </ul>
            </section>
            <section className="sheet panel" aria-labelledby="set3d-cams-title" data-testid="set3d-cameras">
              <h2 className="panel-title" id="set3d-cams-title">
                Cameras
              </h2>
              <ul className="plain marks">
                {Object.entries(t.data.spec.cameras).map(([name, c]) => (
                  <li key={name} data-testid={`set3d-camera-${name}`}>
                    <b>{name}</b> <span className="dim">lens {c.lens} mm</span>
                  </li>
                ))}
                <li className="dim">and the computed shots: wide, two, cu-&lt;cast&gt;, ots-&lt;a&gt;-&lt;b&gt;</li>
              </ul>
            </section>
          </aside>
        </div>
      )}
    </ToolGate>
  )
}

function SetView({ slug, setId, description }: { slug: string; setId: string; description: string }) {
  const t = useTool('cts_set_get', { series: slug, set: setId }, normalizeSet)
  return (
    <ToolGate state={t} tool="cts_set_get" testId="set-detail">
      {t.data && <SetStage slug={slug} setId={setId} set={t.data} description={description} />}
    </ToolGate>
  )
}

function SetStage({ slug, setId, set, description }: { slug: string; setId: string; set: SetFile; description: string }) {
  const shots = Object.entries(set.shots)
  const marks = Object.entries(set.marks)
  const [focus, setFocus] = useState<string | null>(null)
  const [showMarks, setShowMarks] = useState(true)
  const [W, H] = set.size
  const pad = W * 0.14
  const font = Math.max(W, H) / 46
  const layers = [...set.layers].sort((a, b) => a.z - b.z)
  const sizes = useLayerSizes(slug, setId, set)
  return (
    <div className="set-grid">
      <section className="sheet panel stage-panel" aria-labelledby="set-stage" data-testid="set-stage">
        <div className="row spread">
          <h2 className="panel-title" id="set-stage">
            {setId} <span className="dim title-alt">{W} x {H}, ground at {set.groundY}</span>
          </h2>
        </div>
        {description && <p className="dim">{description}</p>}
        <svg className="stage" viewBox={`${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}`} role="img" aria-label={`Set ${setId} with ${marks.length} marks and ${shots.length} shots`} data-testid="set-overlay">
          <rect x={0} y={0} width={W} height={H} className="stage-paper" />
          {layers.map((l) => {
            const size = sizes[l.id]
            const at = l.at ?? [0, 0]
            const ox = l.anchor === 'center' ? -(size?.w ?? 0) / 2 : 0
            const oy = l.anchor === 'center' ? -(size?.h ?? 0) / 2 : l.anchor === 'bottom' ? -(size?.h ?? 0) : 0
            const ax = l.anchor === 'bottom' ? -(size?.w ?? 0) / 2 : 0
            return <image key={l.id} href={seriesFile(slug, `sets/${setId}/${l.src}`)} x={at[0] + ox + ax} y={at[1] + oy} width={size?.w} height={size?.h} data-testid={`set-layer-${l.id}`} />
          })}
          <line x1={-pad} x2={W + pad} y1={set.groundY} y2={set.groundY} className="stage-ground" />
          <rect x={0} y={0} width={W} height={H} className="stage-edge" />
          {shots.map(([name, shot], i) => {
            const r = shotRect(set, shot)
            const color = SHOT_COLORS[i % SHOT_COLORS.length]
            const on = focus === null || focus === name
            return (
              <g key={name} opacity={on ? 1 : 0.18} data-testid={`set-shot-rect-${name}`}>
                <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke={color} strokeWidth={Math.max(W, H) / 220} strokeDasharray={`${font * 0.9} ${font * 0.5}`} />
                <text x={r.x + font * 0.4} y={r.y + font * 1.2} fontSize={font} fill={color} className="stage-label">
                  {name}
                </text>
              </g>
            )
          })}
          {showMarks &&
            marks.map(([name, p]) => (
              <g key={name} data-testid={`set-mark-dot-${name}`}>
                <circle cx={p[0]} cy={p[1]} r={font * 0.42} className="stage-mark" />
                <text x={p[0]} y={p[1] - font * 0.8} fontSize={font} textAnchor="middle" className="stage-label mark-label">
                  {name}
                </text>
              </g>
            ))}
        </svg>
      </section>

      <aside className="set-side">
        <section className="sheet panel" aria-labelledby="set-shots" data-testid="set-shots">
          <h2 className="panel-title" id="set-shots">
            Shots
          </h2>
          <ul className="plain legend">
            {shots.map(([name, shot], i) => (
              <li key={name}>
                <button className={focus === name ? 'legend-item on' : 'legend-item'} aria-pressed={focus === name} onClick={() => setFocus(focus === name ? null : name)} data-testid={`set-shot-${name}`}>
                  <span className="swatch" style={{ background: SHOT_COLORS[i % SHOT_COLORS.length] }} aria-hidden="true" />
                  <b>{name}</b>
                  <span className="dim">zoom {shot.zoom}, centre {shot.center.join(', ')}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="sheet panel" aria-labelledby="set-marks" data-testid="set-marks">
          <div className="row spread">
            <h2 className="panel-title" id="set-marks">
              Marks
            </h2>
            <label className="inline">
              <input type="checkbox" checked={showMarks} onChange={(e) => setShowMarks(e.target.checked)} data-testid="set-marks-toggle" />
              Show
            </label>
          </div>
          <ul className="plain marks">
            {marks.map(([name, p]) => (
              <li key={name} data-testid={`set-mark-${name}`}>
                <b>{name}</b> <span className="dim">{p.join(', ')}</span>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  )
}

/** The natural size of each layer's picture, for anchors that need it. */
function useLayerSizes(slug: string, setId: string, set: SetFile): Record<string, { w: number; h: number }> {
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({})
  const key = useMemo(() => set.layers.map((l) => l.src).join('|'), [set.layers])
  useEffect(() => {
    let live = true
    for (const l of set.layers) {
      const img = new Image()
      img.onload = () => live && setSizes((s) => ({ ...s, [l.id]: { w: img.naturalWidth, h: img.naturalHeight } }))
      img.src = seriesFile(slug, `sets/${setId}/${l.src}`)
    }
    return () => {
      live = false
    }
  }, [slug, setId, key])
  return sizes
}
