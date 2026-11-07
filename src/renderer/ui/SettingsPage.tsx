import { useEffect, useState } from 'react'
import { getStartWithWindows, sendCommand, setStartWithWindows } from '../api'
import { useCts } from '../store/hooks'
import { SCHEMES, type Scheme } from '../lib/scheme'
import { ctsStore } from '../store/store'
import { Field } from './common'
import { McpSettings } from './McpSettings'

const SCHEME_LABEL: Record<Scheme, string> = { system: 'Follow the system', light: 'Light paper', dark: 'Night desk' }

export function SettingsPage() {
  const secretsSet = useCts((s) => s.secretsSet)
  /** The key variables the engine reports (`api_key_env` of every provider, custom ones too). It refuses names that are not in providers.md. */
  const keyNames = useCts((s) => s.keyNames)
  const dataDir = useCts((s) => s.dataDir)
  const scheme = useCts((s) => s.scheme)
  const [picked, setKeyName] = useState('')
  const [keyValue, setKeyValue] = useState('')
  const [login, setLogin] = useState<boolean | null>(null)

  useEffect(() => {
    void getStartWithWindows().then(setLogin)
  }, [])
  const names = [...new Set([...keyNames, ...secretsSet])]
  const keyName = names.includes(picked) ? picked : (names[0] ?? '')
  const keySet = secretsSet.includes(keyName)
  return (
    <div className="page-body settings" data-testid="page-settings">
      <header className="page-head">
        <h1>Settings</h1>
      </header>

      <section className="sheet panel" aria-labelledby="set-look">
        <h2 id="set-look" className="panel-title">
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
        <p className="dim">This only changes the studio window. The choice is kept on this computer.</p>
      </section>

      <section className="sheet panel" aria-labelledby="set-data">
        <h2 id="set-data" className="panel-title">
          Data folder
        </h2>
        <Field label="Cartoon Studio data folder" hint="Set with --data or the CTS_DATA environment variable. The default is ~/CartoonStudio. Restart to change it.">
          {(id, described) => <input id={id} aria-describedby={described} value={dataDir} readOnly data-testid="set-dataDir" />}
        </Field>
      </section>

      <section className="sheet panel" aria-labelledby="set-mcp">
        <h2 id="set-mcp" className="panel-title">
          MCP server
        </h2>
        <McpSettings />
      </section>

      <section className="sheet panel" aria-labelledby="set-keys">
        <h2 id="set-keys" className="panel-title">
          Provider API key
        </h2>
        <p className="dim">Stored in the Windows credential store, never in a file.</p>
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
            </div>
          )}
        </Field>
      </section>

      <section className="sheet panel" aria-labelledby="set-start">
        <h2 id="set-start" className="panel-title">
          Start-up
        </h2>
        <label className="inline">
          <input type="checkbox" checked={login === true} disabled={login === null} data-testid="set-login" onChange={(e) => void setStartWithWindows(e.target.checked).then(setLogin)} />
          Start Cartoon Studio with Windows{login === null ? ' (only in the desktop app)' : ''}
        </label>
      </section>
    </div>
  )
}
