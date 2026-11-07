import { useState } from 'react'
import { sendCommand } from '../api'
import { useAgentList, useCts } from '../store/hooks'
import { KNOWN_ROLES, modelOptions, PROBLEM_TITLES, VISION_ROLES } from './roles'

const STATE_LABEL: Record<string, string> = {
  working: 'working',
  reviewing: 'reviewing',
  'waiting-provider': 'waiting for the provider',
  'waiting-research': 'waiting',
  idle: 'idle',
  error: 'error',
  paused: 'paused'
}

/** Agents with a model picker each, and the default model per role (written to config/roles.md). */
export function AgentsPage() {
  const agents = useAgentList()
  const known = useCts((s) => s.models)
  const defaults = useCts((s) => s.roleDefaults)
  const [hiring, setHiring] = useState(false)
  return (
    <div className="page-body" data-testid="page-agents">
      <header className="page-head">
        <h1>Agents</h1>
        <div className="head-actions">
          <button onClick={() => setHiring(!hiring)} aria-expanded={hiring} data-testid="hire-open">
            Hire
          </button>
        </div>
      </header>
      {hiring && <HireForm onClose={() => setHiring(false)} />}
      <p className="lede dim">
        Each agent can have its own model. Empty means the role default below. The art-critic needs a vision model (one with <code>vision: true</code>).
      </p>
      <div className="stack" data-testid="agent-list">
        {agents.map((a) => {
          const vision = VISION_ROLES.has(a.role)
          const options = modelOptions(known, a.override, vision)
          const roleDefault = defaults[a.role]
          const paused = a.paused || a.state === 'paused'
          return (
            <div className="sheet panel" key={a.id} data-testid={`agent-${a.id}`}>
              <div className="row spread">
                <div>
                  <b>{a.name}</b> <span className="dim">{a.role}</span>
                </div>
                <span className="dim">
                  {STATE_LABEL[a.state] ?? a.state}
                  {a.task ? `: ${a.task}` : ''}
                </span>
              </div>
              <div className="row" style={{ gap: 8, marginTop: 6 }}>
                <select
                  style={{ flex: 1 }}
                  aria-label={`Model for ${a.name}`}
                  value={a.override ?? ''}
                  onChange={(e) => sendCommand({ type: 'setModel', model: e.target.value || null, agent: a.id })}
                  data-testid={`agent-model-${a.id}`}
                >
                  <option value="">{roleDefault ? `Role default (${roleDefault})` : 'Role default'}</option>
                  {options.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <button onClick={() => sendCommand({ type: paused ? 'resume' : 'pause', agent: a.id })} data-testid={`agent-pause-${a.id}`}>{paused ? 'Resume' : 'Pause'}</button>
                <button onClick={() => sendCommand({ type: 'stop', agent: a.id })} disabled={!a.jobId && a.state === 'idle'} data-testid={`agent-stop-${a.id}`}>
                  Stop job
                </button>
                <button onClick={() => sendCommand({ type: 'fire', agent: a.id })} title="Finishes the current job, then leaves" data-testid={`agent-fire-${a.id}`}>
                  Fire
                </button>
              </div>
              {a.problem && (
                <div className="agent-problem" title={a.problem.message}>
                  <b>{PROBLEM_TITLES[a.problem.kind] ?? 'Request failed'}</b> on {a.problem.model}
                </div>
              )}
            </div>
          )
        })}
        {!agents.length && (
          <div className="state empty" data-testid="agents-empty">
            <h3 className="state-title">No agents yet</h3>
            <p className="state-body">Hire one, or start the engine so the seed agents are copied into the data folder.</p>
          </div>
        )}
      </div>
      <RoleDefaults />
    </div>
  )
}

/** Default model per role: sends `setModel` with `role`. */
function RoleDefaults() {
  const shared = useCts((s) => s.settings?.fallbackShared ?? false)
  const known = useCts((s) => s.models)
  const defaults = useCts((s) => s.roleDefaults)
  const roles = [...new Set<string>([...KNOWN_ROLES, ...Object.keys(defaults)])]
  return (
    <div className="sheet panel" data-testid="role-defaults">
      <h2 className="panel-title">Role defaults</h2>
      <div className="stack">
        {roles.map((role) => (
          <div className="row" key={role} style={{ gap: 8 }}>
            <span style={{ width: 150 }}>{role}</span>
            <select
              style={{ flex: 1 }}
              aria-label={`Default model for the ${role} role`}
              data-testid={`role-model-${role}`}
              value={defaults[role] ?? ''}
              onChange={(e) => e.target.value && sendCommand({ type: 'setModel', model: e.target.value, role })}
            >
              {!defaults[role] && (
                <option value="" disabled>
                  (pick a model)
                </option>
              )}
              {modelOptions(known, defaults[role], VISION_ROLES.has(role)).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        ))}
        <span className="dim">
          Running jobs of the role switch at once. The engine writes config/roles.md.
          {shared ? ' With one fallback order for every role (Models page), the model takes the place of the first fallback row of its kind.' : ''}
        </span>
      </div>
    </div>
  )
}

function HireForm({ onClose }: { onClose(): void }) {
  const known = useCts((s) => s.models)
  const [role, setRole] = useState<string>(KNOWN_ROLES[0])
  const [name, setName] = useState('')
  const [model, setModel] = useState('')
  return (
    <div className="sheet panel" data-testid="hire-form">
      <div className="row" style={{ gap: 8 }}>
        <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)} data-testid="hire-role">
          {KNOWN_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="name (the engine picks one)" style={{ flex: 1 }} data-testid="hire-name" />
        <select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)} data-testid="hire-model">
          <option value="">Role default</option>
          {modelOptions(known, null, VISION_ROLES.has(role)).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <button onClick={onClose} data-testid="hire-cancel">
          Cancel
        </button>
        <button
          className="primary"
          data-testid="hire-submit"
          onClick={() => {
            sendCommand({ type: 'hire', role, ...(name.trim() ? { name: name.trim() } : {}), ...(model ? { model } : {}) })
            onClose()
          }}
        >
          Hire
        </button>
      </div>
    </div>
  )
}
