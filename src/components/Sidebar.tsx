import { useState } from 'react'
import { useStore } from '../lib/store'
import { api } from '../lib/api'

function relTime(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

export function Sidebar() {
  const { tabs, activeKey, setActiveKey, closeConversation, openConversation, resumeSessions, refreshSessions } = useStore()
  const [cwd, setCwd] = useState('')
  const [picking, setPicking] = useState(false)

  const startFresh = () => {
    const target = cwd.trim() || undefined
    if (!target) { setPicking(true); return }
    openConversation(target)
    setCwd('')
    setPicking(false)
  }

  const resume = (path: string, sessionCwd: string, name: string) => {
    const key = openConversation(sessionCwd || '/Users', name)
    void api.resume(key, path).then(refreshSessions)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__mark">π</span>
        <span>pi workbench</span>
      </div>

      <button type="button" className="sidebar__new" onClick={() => setPicking((v) => !v)}>
        + New session
      </button>
      {picking && (
        <div style={{ padding: '0 8px 8px' }}>
          <input
            autoFocus
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') startFresh()
              if (e.key === 'Escape') setPicking(false)
            }}
            placeholder="~/project path, Enter to start"
            style={{
              width: '100%',
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-layer-2)',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: 13,
              outline: 'none',
            }}
          />
        </div>
      )}

      <div className="sidebar__section">
        {tabs.length > 0 && <div className="sidebar__heading">Open</div>}
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`sidebar__item${tab.key === activeKey ? ' is-active' : ''}`}
            onClick={() => setActiveKey(tab.key)}
          >
            <span className="sidebar__item-label">{tab.label}</span>
            <span
              className="sidebar__item-meta"
              role="button"
              aria-label="Close"
              onClick={(e) => { e.stopPropagation(); closeConversation(tab.key) }}
            >
              ×
            </span>
          </button>
        ))}

        <div className="sidebar__heading">Recent</div>
        {resumeSessions.slice(0, 25).map((session) => (
          <button
            key={session.path}
            type="button"
            className="sidebar__item"
            title={session.path}
            onClick={() => resume(session.path, session.cwd, session.name)}
          >
            <span className="sidebar__item-label">{session.name}</span>
            <span className="sidebar__item-meta">{relTime(session.modifiedAt)}</span>
          </button>
        ))}
        {resumeSessions.length === 0 && (
          <div style={{ padding: '8px 10px', color: 'var(--dsw-alias-label-caption)', fontSize: 12 }}>
            No saved sessions yet.
          </div>
        )}
      </div>
    </aside>
  )
}
