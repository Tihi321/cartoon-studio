import { useEffect, useState } from 'react'
import { LANGS, VOICE_PROVIDERS } from '../../shared/contracts'
import type { Lang, VoiceSpec } from '../../shared/contracts'
import { getStartWithWindows, sendCommand, setStartWithWindows } from '../api'
import { callTool, normalizeBlenderConfig, normalizeBudget, normalizeMediaConfig, useTool } from '../lib/studio'
import type { BlenderStatusView, BudgetInfo } from '../lib/studio'
import { useCts } from '../store/hooks'
import { SCHEMES, type Scheme } from '../lib/scheme'
import { ctsStore } from '../store/store'
import { Field, Modal, Pill } from './common'
import { McpSettings } from './McpSettings'
import { LANG_NAME, ToolGate, useSeries } from './studio'

const SCHEME_LABEL: Record<Scheme, string> = { system: 'Follow the system', light: 'Light paper', dark: 'Night desk' }

export function SettingsPage() {
  const dataDir = useCts((s) => s.dataDir)
  const scheme = useCts((s) => s.scheme)
  const [login, setLogin] = useState<boolean | null>(null)

  useEffect(() => {
    void getStartWithWindows().then(setLogin)
  }, [])
  return (
    <div className="page-body settings" data-testid="page-settings">
      <header className="page-head">
        <h1>Settings</h1>
      </header>

      <Studios />
      <MediaEngines />
      <BlenderSettings />
      <VoiceProviders />
      <Budget />

      <section className="sheet panel" aria-labelledby="set-data">
        <h2 className="panel-title" id="set-data">
          Data folder
        </h2>
        <Field label="Cartoon Studio data folder" hint="Set with --data or the CTS_DATA environment variable. The default is ~/CartoonStudio. Restart to change it.">
          {(id, described) => <input id={id} aria-describedby={described} value={dataDir} readOnly data-testid="set-dataDir" />}
        </Field>
      </section>

      <section className="sheet panel" aria-labelledby="set-mcp">
        <h2 className="panel-title" id="set-mcp">
          MCP server
        </h2>
        <McpSettings />
      </section>

      <Keys />

      <section className="sheet panel" aria-labelledby="set-look">
        <h2 className="panel-title" id="set-look">
          Look of the studio
        </h2>
        <fieldset className="scheme" data-testid="set-scheme">
          <legend>Colours</legend>
          {SCHEMES.map((s) => (
            <label key={s} className="inline">
              <input type="radio" name="scheme" value={s} checked={scheme === s} onChange={() => ctsStore.getState().setScheme(s)} data-testid={`set-scheme-${s}`} />
              {SCHEME_LABEL[s]}
            </label>
          ))}
        </fieldset>
        <label className="inline">
          <input type="checkbox" checked={login === true} disabled={login === null} data-testid="set-login" onChange={(e) => void setStartWithWindows(e.target.checked).then(setLogin)} />
          Start Cartoon Studio with Windows{login === null ? ' (only in the desktop app)' : ''}
        </label>
      </section>
    </div>
  )
}

/** What each generator makes for the studio, shown next to whether it answers. */
const STUDIO_USE: Record<string, string> = {
  comfy: 'images (Z-Image), theme music and sound effects, the Croatian voice (OmniVoice)',
  flow: 'Gemini voices and the intro and outro video clips (credits); no images',
  vibetts: 'local voices: English (Kokoro), Croatian fallback'
}

/**
 * The image and music engines and the order of fallbacks, read-only (cts_media_config): the engines are chosen in config/providers.md (`comfy.imageModel`,
 * `comfy.musicModel`), which the engine reloads without a restart. Editing them here needs an engine command that writes that file; there is none yet.
 */
function MediaEngines() {
  const slug = useCts((s) => s.selection.series)
  const ep = useCts((s) => s.selection.episode)
  const t = useTool('cts_media_config', slug && ep ? { series: slug, episode: ep } : {}, normalizeMediaConfig)
  return (
    <section className="sheet panel" aria-labelledby="set-media" data-testid="set-media">
      <h2 className="panel-title" id="set-media">
        Image and music engines
      </h2>
      <ToolGate state={t} tool="cts_media_config" testId="media">
        {t.data && (
          <>
            <dl className="variant-facts">
              <dt>Music engine</dt>
              <dd data-testid="media-music-model">
                {t.data.music.model} <span className="dim">(alternatives: {t.data.music.alternatives.join(', ') || 'none'}; sound effects: {t.data.music.sfx})</span>
              </dd>
              <dt>Image model</dt>
              <dd data-testid="media-image-model">{t.data.image.model}</dd>
              <dt>Paid image fallback</dt>
              <dd data-testid="media-gemini-cap">
                Nano Banana (gemini): {t.data.gemini.refused ? `refused, the USD cap is $${t.data.gemini.capUsd.toFixed(2)}` : `allowed up to $${t.data.gemini.capUsd.toFixed(2)}`}
              </dd>
            </dl>
            <p className="dim">Fallback order when the image model cannot hold a character or a pose:</p>
            <ol data-testid="media-image-order">
              {t.data.image.order.map((o) => (
                <li key={o.id}>
                  {o.label} <span className="dim">({o.cost})</span>
                </li>
              ))}
            </ol>
            <p className="dim">Read-only: change the engines in config/providers.md (comfy.imageModel, comfy.musicModel).</p>
          </>
        )}
      </ToolGate>
    </section>
  )
}

/**
 * Blender (CTS-27): where the 3D render finds it, the version it found against the pinned one, the GPU EEVEE would use and the frame settings of the
 * preview and the final. The path is saved to config/blender.md with cts_blender_config and checked again with cts_blender_status.
 */
function BlenderSettings() {
  const status = useTool('cts_blender_status', {}, (r) => r as unknown as BlenderStatusView)
  const config = useTool('cts_blender_config', {}, normalizeBlenderConfig)
  const [path, setPath] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const shown = path ?? config.data?.path ?? ''
  const save = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await callTool('cts_blender_config', { path: shown.trim() })
      setMsg({ ok: true, text: 'Saved to config/blender.md.' })
      setPath(null)
      config.reload()
      status.reload()
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const st = status.data
  return (
    <section className="sheet panel" aria-labelledby="set-blender" data-testid="set-blender">
      <div className="row spread">
        <h2 className="panel-title" id="set-blender">
          Blender
        </h2>
        <button onClick={() => status.reload()} disabled={status.loading} data-testid="blender-check">
          Check now
        </button>
      </div>
      <p className="dim">Blender draws the 3D series (characters, sets, the render). Cartoon Studio never installs or bundles it: install the pinned version and set where it is.</p>
      <ToolGate state={config} tool="cts_blender_config" testId="blender-config">
        {config.data && (
          <>
            <Field label="Blender executable" hint={`Accepted version: ${config.data.version}.x${config.data.allowUntestedVersion ? ' (other versions allowed)' : ''}`}>
              {(id, described) => <input id={id} aria-describedby={described} value={shown} onChange={(e) => setPath(e.target.value)} data-testid="blender-path" />}
            </Field>
            <div className="row">
              <button onClick={() => void save()} disabled={busy || path === null || !shown.trim()} data-testid="blender-save">
                {busy ? 'Saving...' : 'Save the path'}
              </button>
              {msg && (
                <span className={msg.ok ? 'inline-ok' : 'inline-error'} role="status" data-testid="blender-msg">
                  {msg.text}
                </span>
              )}
            </div>
            <dl className="variant-facts">
              <dt>Status</dt>
              <dd>
                {status.loading && !st ? (
                  <span className="dim" data-testid="blender-status">
                    checking...
                  </span>
                ) : st?.ok ? (
                  <Pill tone="good" testId="blender-status" title={st.path}>
                    usable
                  </Pill>
                ) : (
                  <Pill tone="bad" testId="blender-status" title={st?.message}>
                    {st?.code ?? 'not checked'}
                  </Pill>
                )}
              </dd>
              <dt>Version found</dt>
              <dd data-testid="blender-version">{st?.ok ? st.version : st?.message ? <span className="dim">{st.message}</span> : 'unknown'}</dd>
              <dt>GPU for EEVEE</dt>
              <dd data-testid="blender-gpu">{st?.ok ? (st.gpu ? `${st.gpu.renderer} (${st.gpu.backend})` : 'not reported') : 'unknown'}</dd>
              <dt>Preview</dt>
              <dd data-testid="blender-samples-preview">
                {config.data.preview.width} x {config.data.preview.height}, {config.data.preview.samples} samples
              </dd>
              <dt>Final</dt>
              <dd data-testid="blender-samples-final">
                {config.data.final.width} x {config.data.final.height}, {config.data.final.samples} samples
              </dd>
              <dt>Chunk</dt>
              <dd>{config.data.chunkFrames} frames</dd>
            </dl>
            <p className="dim">Sizes and samples are read from config/blender.md (cts_blender_config changes them).</p>
          </>
        )}
      </ToolGate>
    </section>
  )
}

function Studios() {
  const studios = useCts((s) => s.studios)
  const connected = useCts((s) => s.connected)
  const [asked, setAsked] = useState(false)
  useEffect(() => {
    if (connected) {
      sendCommand({ type: 'studiosStatus' })
      setAsked(true)
    }
  }, [connected])
  return (
    <section className="sheet panel" aria-labelledby="set-studios" data-testid="set-studios">
      <div className="row spread">
        <h2 className="panel-title" id="set-studios">
          Studios
        </h2>
        <button onClick={() => sendCommand({ type: 'studiosStatus' })} disabled={!connected} data-testid="studios-check">
          Check now
        </button>
      </div>
      {studios.length === 0 ? (
        <p className="dim" data-testid="studios-none">
          {asked ? 'Checking the studios...' : 'The engine is not connected.'}
        </p>
      ) : (
        <ul className="plain studios">
          {studios.map((s) => (
            <li key={s.id} className="studio-row" data-testid={`studio-${s.id}`}>
              <div>
                <b>{s.name}</b> <span className="dim">{STUDIO_USE[s.id]}</span>
                {!s.ok && <div className="dim studio-hint">{s.hint || s.error}</div>}
              </div>
              <Pill tone={s.ok ? 'good' : 'bad'} testId={`studio-${s.id}-state`} title={s.url}>
                {s.ok ? 'answers' : 'not reachable'}
              </Pill>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The voice provider of each character in each language (the bible's `voice.<lang>.provider`). Saved with cts_series_update. */
function VoiceProviders() {
  const info = useSeries()
  const slug = info.slug
  const cast = info.data?.bible.cast ?? []
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const change = async (id: string, lang: Lang, current: VoiceSpec | undefined, provider: string) => {
    setMsg(null)
    try {
      // the patch is a piece of the bible: the cast list with this one voice changed
      const next = cast.map((c) => (c.id === id ? { ...c, voice: { ...c.voice, [lang]: { ...(current ?? { speed: 1 }), provider } } } : c))
      await callTool('cts_series_update', { series: slug, cast: next })
      setMsg({ ok: true, text: 'Saved.' })
      info.reload()
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    }
  }
  return (
    <section className="sheet panel" aria-labelledby="set-providers" data-testid="set-providers">
      <h2 className="panel-title" id="set-providers">
        Provider choice
      </h2>
      <p className="dim">
        Images and music come from ComfyUI (the models in config/providers.md); Flow makes video clips only, and the paid providers only behind the budget below. Voices: auto picks Gemini within its free quota, else the local engines.
      </p>
      {!slug && <p className="dim">Choose a series to set its voices.</p>}
      {slug && cast.length === 0 && <p className="dim">The cast is made after you choose a premise.</p>}
      {cast.length > 0 && (
        <table className="table" data-testid="voice-providers">
          <thead>
            <tr>
              <th scope="col">Character</th>
              {LANGS.map((l) => (
                <th scope="col" key={l}>
                  {LANG_NAME[l]} voice
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cast.map((c) => (
              <tr key={c.id}>
                <th scope="row">{c.name.en}</th>
                {LANGS.map((l) => (
                  <td key={l}>
                    <select aria-label={`${c.name.en}, ${LANG_NAME[l]} voice provider`} value={c.voice[l]?.provider ?? 'auto'} onChange={(e) => void change(c.id, l, c.voice[l], e.target.value)} data-testid={`voice-provider-${c.id}-${l}`}>
                      {VOICE_PROVIDERS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {msg && (
        <p className={msg.ok ? 'inline-ok' : 'inline-error'} role="status" data-testid="voice-providers-msg">
          {msg.text}
        </p>
      )}
    </section>
  )
}

/** The budget of the chosen episode: cap, what is spent, the ledger. Changing a cap needs a confirmation. */
function Budget() {
  const slug = useCts((s) => s.selection.series)
  const ep = useCts((s) => s.selection.episode)
  const t = useTool('cts_budget_get', slug && ep ? { series: slug, episode: ep } : null, normalizeBudget)
  const [editing, setEditing] = useState(false)
  return (
    <section className="sheet panel" aria-labelledby="set-budget" data-testid="set-budget">
      <div className="row spread">
        <h2 className="panel-title" id="set-budget">
          Budget {ep ? <span className="dim title-alt">{ep}</span> : null}
        </h2>
        <button onClick={() => setEditing(true)} disabled={!t.data} data-testid="budget-edit">
          Change the cap
        </button>
      </div>
      {!slug || !ep ? (
        <p className="dim" data-testid="budget-none">
          Choose a series and an episode.
        </p>
      ) : (
        <ToolGate state={t} tool="cts_budget_get" testId="budget">
          {t.data && <BudgetBody b={t.data} />}
        </ToolGate>
      )}
      {editing && t.data && slug && ep && (
        <CapDialog
          b={t.data}
          onClose={() => setEditing(false)}
          onSave={async (capUsd, flowCreditsCap, note) => {
            await callTool('cts_budget_set', { series: slug, episode: ep, capUsd, flowCreditsCap, approvedBy: 'user', note })
            setEditing(false)
            t.reload()
          }}
        />
      )}
    </section>
  )
}

function BudgetBody({ b }: { b: BudgetInfo }) {
  const usdCap = b.budget?.capUsd ?? 0
  const credCap = b.budget?.flowCreditsCap ?? 0
  const frac = (spent: number, cap: number) => (cap > 0 ? Math.min(1, spent / cap) : 0)
  return (
    <>
      {!b.budget && (
        <p className="inline-warn" data-testid="budget-unset">
          No budget is set for this episode, so both caps are 0 and nothing paid runs.
        </p>
      )}
      <div className="meters">
        <div data-testid="budget-usd">
          <div className="row spread">
            <b>Money</b>
            <span>
              ${b.spentUsd.toFixed(2)} of ${usdCap.toFixed(2)}
            </span>
          </div>
          <div className="meter" role="img" aria-label={`$${b.spentUsd.toFixed(2)} spent of $${usdCap.toFixed(2)}`}>
            <span style={{ width: `${frac(b.spentUsd, usdCap) * 100}%` }} />
          </div>
        </div>
        <div data-testid="budget-credits">
          <div className="row spread">
            <b>Flow credits</b>
            <span>
              {b.spentCredits} of {credCap}
            </span>
          </div>
          <div className="meter" role="img" aria-label={`${b.spentCredits} credits spent of ${credCap}`}>
            <span style={{ width: `${frac(b.spentCredits, credCap) * 100}%` }} />
          </div>
        </div>
      </div>

      {b.ledger.length === 0 ? (
        <p className="dim" data-testid="ledger-none">
          Nothing spent yet.
        </p>
      ) : (
        <table className="table" data-testid="ledger">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">What</th>
              <th scope="col">Provider</th>
              <th scope="col" className="num">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {b.ledger.map((e, i) => (
              <tr key={i}>
                <td>{e.t.slice(0, 16).replace('T', ' ')}</td>
                <td>{e.what}</td>
                <td>
                  {e.provider} {e.model}
                </td>
                <td className="num">{e.currency === 'usd' ? `$${e.amount.toFixed(2)}` : `${e.amount} credits`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

function CapDialog({ b, onClose, onSave }: { b: BudgetInfo; onClose(): void; onSave(capUsd: number, credits: number, note: string): Promise<void> }) {
  const [usd, setUsd] = useState(String(b.budget?.capUsd ?? 0))
  const [credits, setCredits] = useState(String(b.budget?.flowCreditsCap ?? 0))
  const [note, setNote] = useState('')
  const [sure, setSure] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nUsd = Number(usd)
  const nCred = Number(credits)
  const valid = Number.isFinite(nUsd) && nUsd >= 0 && Number.isFinite(nCred) && nCred >= 0 && note.trim().length > 0
  return (
    <Modal title="Change the budget cap" onClose={onClose} testId="cap-dialog" width={520}>
      <p>Money and credits are spent for real once a cap allows it. This records your approval with your note.</p>
      <Field label="Money cap (USD)">{(id) => <input id={id} inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} data-autofocus data-testid="cap-usd" />}</Field>
      <Field label="Flow credits cap">{(id) => <input id={id} inputMode="numeric" value={credits} onChange={(e) => setCredits(e.target.value)} data-testid="cap-credits" />}</Field>
      <Field label="Why" hint="Written into the budget file next to your approval.">
        {(id, d) => <input id={id} aria-describedby={d} value={note} onChange={(e) => setNote(e.target.value)} data-testid="cap-note" />}
      </Field>
      <label className="inline">
        <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} data-testid="cap-confirm" />
        I approve spending up to ${Number.isFinite(nUsd) ? nUsd.toFixed(2) : '?'} and {Number.isFinite(nCred) ? nCred : '?'} Flow credits on this episode.
      </label>
      {error && (
        <p className="inline-error" role="alert" data-testid="cap-error">
          {error}
        </p>
      )}
      <div className="row">
        <button
          className="primary"
          disabled={!sure || !valid || busy}
          data-testid="cap-save"
          onClick={() => {
            setBusy(true)
            setError(null)
            onSave(nUsd, nCred, note.trim()).catch((e: Error) => {
              setError(e.message)
              setBusy(false)
            })
          }}
        >
          {busy ? 'Saving...' : 'Set the cap'}
        </button>
        <button onClick={onClose} data-testid="cap-cancel">
          Cancel
        </button>
      </div>
    </Modal>
  )
}

function Keys() {
  const secretsSet = useCts((s) => s.secretsSet)
  /** The key variables the engine reports (`api_key_env` of every provider, custom ones too). It refuses names that are not in providers.md. */
  const keyNames = useCts((s) => s.keyNames)
  const [picked, setKeyName] = useState('')
  const [keyValue, setKeyValue] = useState('')
  const names = [...new Set([...keyNames, ...secretsSet])]
  const keyName = names.includes(picked) ? picked : (names[0] ?? '')
  const keySet = secretsSet.includes(keyName)
  return (
    <section className="sheet panel" aria-labelledby="set-keys" data-testid="set-keys">
      <h2 className="panel-title" id="set-keys">
        Provider API keys
      </h2>
      <p className="dim">Stored in the Windows credential store, never in a file, and never shown here again. Only paid providers need one.</p>
      {names.length === 0 ? (
        <p className="dim" data-testid="keys-none">
          No provider takes a key yet.
        </p>
      ) : (
        <>
          <Field label="Key">
            {(id) => (
              <select id={id} value={keyName} onChange={(e) => setKeyName(e.target.value)} data-testid="set-key-name">
                {names.map((n) => (
                  <option key={n} value={n}>
                    {n}
                    {secretsSet.includes(n) ? ' (set)' : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Value">
            {(id) => (
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input
                  id={id}
                  type="password"
                  autoComplete="off"
                  style={{ flex: 1, minWidth: 0 }}
                  value={keyValue}
                  placeholder={keySet ? 'Key is set. Type to replace' : 'Paste the key'}
                  onChange={(e) => setKeyValue(e.target.value)}
                  data-testid="set-key-value"
                />
                <button
                  disabled={!keyValue || !keyName}
                  data-testid="set-key-save"
                  onClick={() => {
                    sendCommand({ type: 'setSecret', name: keyName, value: keyValue })
                    setKeyValue('')
                  }}
                >
                  Store key
                </button>
                <button disabled={!keySet} data-testid="set-key-clear" onClick={() => sendCommand({ type: 'clearSecret', name: keyName })}>
                  Clear key
                </button>
              </div>
            )}
          </Field>
        </>
      )}
    </section>
  )
}
