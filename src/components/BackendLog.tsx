import { useMemo, useState } from 'react'
import type { BackendLogEntry } from '../lib/api'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function compact(value: string, limit = 180): string {
  const singleLine = value.replace(/\s+/g, ' ').trim()
  return singleLine.length > limit ? `${singleLine.slice(0, limit - 1)}…` : singleLine
}

function stringify(value: unknown): string {
  try { return JSON.stringify(value, null, 2) }
  catch { return String(value) }
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.${String(date.getMilliseconds()).padStart(3, '0')}`
}

function summary(entry: BackendLogEntry): string {
  const payload = entry.payload
  if (entry.type === 'backend_request') {
    const request = asRecord(payload.payload)
    const message = typeof request.message === 'string' ? compact(request.message, 130) : ''
    return [String(payload.action ?? 'command'), message].filter(Boolean).join(' · ')
  }
  if (entry.type === 'backend_response') {
    return `${String(payload.action ?? 'command')} · ${payload.ok === false ? 'failed' : 'completed'}${payload.error ? ` · ${compact(String(payload.error), 130)}` : ''}`
  }
  if (entry.type === 'tool_execution_start') {
    return `${String(payload.toolName ?? 'tool')} · ${compact(stringify(payload.args), 140)}`
  }
  if (entry.type === 'tool_execution_update' || entry.type === 'tool_execution_end') {
    const result = asRecord(payload.result)
    return `${String(payload.toolName ?? 'tool')} · ${compact(stringify(result.content ?? result.details ?? result), 150)}`
  }
  if (entry.type === 'message_update') {
    const update = asRecord(payload.assistantMessageEvent)
    return `${String(update.type ?? 'message update')}${update.delta ? ` · ${compact(String(update.delta), 140)}` : ''}`
  }
  if (entry.type === 'message_end') {
    const message = asRecord(payload.message)
    return `${String(message.role ?? 'message')} · ${compact(stringify(message.content), 145)}`
  }
  if (entry.type === 'response') {
    return `${payload.success === false ? 'RPC failed' : 'RPC response'}${payload.id ? ` · ${String(payload.id)}` : ''}`
  }
  if (entry.type === 'stderr') return compact(String(payload.message ?? ''))
  if (entry.type === '__status') return `${String(payload.status ?? 'status')}${payload.error ? ` · ${compact(String(payload.error), 140)}` : ''}`
  if (entry.type === 'state') {
    const state = asRecord(payload.state)
    const model = asRecord(state.model)
    return [String(state.isStreaming ? 'streaming' : 'ready'), model.provider && model.id ? `${model.provider}/${model.id}` : ''].filter(Boolean).join(' · ')
  }
  if (entry.type === 'system') {
    return [String(payload.subtype ?? 'system'), payload.hook_name ?? payload.hookName].filter(Boolean).join(' · ')
  }
  return compact(stringify(payload), 190)
}

export function BackendLog({ entries, live }: { entries: BackendLogEntry[]; live: boolean }) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [copied, setCopied] = useState(false)
  const needle = query.trim().toLowerCase()
  const visible = useMemo(() => entries.filter((entry) => {
    if (!needle) return true
    return `${entry.source} ${entry.type} ${summary(entry)} ${stringify(entry.payload)}`.toLowerCase().includes(needle)
  }), [entries, needle])

  const copyLog = async () => {
    try {
      await navigator.clipboard.writeText(stringify(entries))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch { /* clipboard may be unavailable in a non-secure local context */ }
  }

  return (
    <div className="backend-log">
      <div className="backend-log__toolbar" role="toolbar" aria-label="Backend log controls">
        <div className="backend-log__title">
          <span className={`backend-log__live-dot${live ? ' is-live' : ''}`} aria-hidden="true" />
          <strong>Live backend stream</strong>
          <span>{entries.length.toLocaleString()} events</span>
        </div>
        <div className="backend-log__actions">
          <button type="button" onClick={() => void copyLog()} disabled={entries.length === 0}>{copied ? 'Copied' : 'Copy JSON'}</button>
          <label className="backend-log__search">
            <span aria-hidden="true">⌕</span>
            <input type="search" aria-label="Search backend log" placeholder="Filter events" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
        </div>
      </div>

      <div className="backend-log__intro">
        Every command and backend event is recorded in order. Click any row to inspect its complete payload.
      </div>

      <div className="backend-log__list">
        {visible.map((entry) => {
          const isExpanded = expanded.has(entry.id)
          return (
            <div className={`backend-log__entry${isExpanded ? ' is-expanded' : ''}`} key={entry.id}>
              <button
                type="button"
                className="backend-log__entry-head"
                aria-expanded={isExpanded}
                onClick={() => setExpanded((current) => {
                  const next = new Set(current)
                  if (next.has(entry.id)) next.delete(entry.id)
                  else next.add(entry.id)
                  return next
                })}
              >
                <span className="backend-log__time">{formatTime(entry.timestamp)}</span>
                <span className={`backend-log__source is-${entry.source}`}>{entry.source}</span>
                <span className="backend-log__type">{entry.type}</span>
                <span className="backend-log__summary">{summary(entry) || '(empty event)'}</span>
                <span className="backend-log__chevron" aria-hidden="true">{isExpanded ? '⌄' : '›'}</span>
              </button>
              {isExpanded && (
                <div className="backend-log__payload">
                  <div className="backend-log__payload-meta"><span>{entry.id}</span><span>{new Date(entry.timestamp).toLocaleString()}</span></div>
                  <pre>{stringify(entry.payload)}</pre>
                </div>
              )}
            </div>
          )
        })}
        {entries.length === 0 && <div className="backend-log__empty">Backend events will appear after you send a prompt.</div>}
        {entries.length > 0 && visible.length === 0 && <div className="backend-log__empty">No backend events match “{query}”.</div>}
      </div>
    </div>
  )
}
