import { useMemo, useState } from 'react'
import type { TimelineItem } from '../lib/timeline'
import { displayToolName } from '../lib/toolCards'

type TrajectoryRecord = {
  item: TimelineItem
  index: number
  timestamp: number
  duration: number
  summary: string
  searchable: string
}

type TrajectoryTurn = {
  number: number
  records: TrajectoryRecord[]
}

function itemTimestamp(item: TimelineItem): number {
  return item.kind === 'tool' ? item.startedAt : item.timestamp
}

function itemText(item: TimelineItem): string {
  if (item.kind !== 'tool') return item.text
  return [item.name, JSON.stringify(item.args), JSON.stringify(item.details), item.output].filter(Boolean).join(' ')
}

function compact(value: string, limit = 190): string {
  const singleLine = value.replace(/\s+/g, ' ').trim()
  return singleLine.length > limit ? `${singleLine.slice(0, limit - 1)}…` : singleLine
}

function kindLabel(item: TimelineItem): string {
  switch (item.kind) {
    case 'user': return 'USER'
    case 'rationale': return 'REASONING'
    case 'assistant': return 'ASSISTANT'
    case 'tool': return 'TOOL'
    case 'notice': return item.tone === 'error' ? 'ERROR' : 'NOTICE'
  }
}

function laneFor(item: TimelineItem): 'input' | 'model' | 'tools' {
  if (item.kind === 'user') return 'input'
  if (item.kind === 'tool') return 'tools'
  return 'model'
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`
}

function buildTrajectory(items: TimelineItem[]): TrajectoryTurn[] {
  const records = items.map((item, index) => {
    const timestamp = itemTimestamp(item)
    const nextTimestamp = items[index + 1] ? itemTimestamp(items[index + 1]!) : timestamp
    const duration = item.kind === 'tool'
      ? Math.max(0, item.elapsed ?? Math.max(0, Date.now() - item.startedAt))
      : Math.max(0, nextTimestamp - timestamp)
    const text = itemText(item)
    return {
      item,
      index: index + 1,
      timestamp,
      duration,
      summary: item.kind === 'tool'
        ? `${displayToolName(item.name)} ${compact(JSON.stringify(item.args), 110)}${item.output ? ` → ${compact(item.output, 110)}` : ''}`
        : compact(text),
      searchable: `${kindLabel(item)} ${text}`.toLowerCase(),
    }
  })

  const turns: TrajectoryTurn[] = []
  let current: TrajectoryTurn | null = null
  for (const record of records) {
    if (record.item.kind === 'user' || current === null) {
      current = { number: turns.length + 1, records: [] }
      turns.push(current)
    }
    current.records.push(record)
  }
  return turns
}

export function Trajectory({ items }: { items: TimelineItem[] }) {
  const turns = useMemo(() => buildTrajectory(items), [items])
  const [actualDuration, setActualDuration] = useState(true)
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(new Set())
  const [callsCollapsed, setCallsCollapsed] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const records = turns.flatMap((turn) => turn.records)
  const needle = query.trim().toLowerCase()
  const matching = new Set(records.filter((record) => !needle || record.searchable.includes(needle)).map((record) => record.item.id))
  const allTurnsCollapsed = turns.length > 0 && turns.every((turn) => collapsedTurns.has(turn.number))
  const minimum = Math.min(...records.map((record) => record.timestamp), Date.now())
  const maximum = Math.max(...records.map((record) => record.timestamp + Math.max(1, record.duration)), minimum + 1)
  const span = Math.max(1, maximum - minimum)

  const toggleAllTurns = () => {
    setCollapsedTurns(allTurnsCollapsed ? new Set() : new Set(turns.map((turn) => turn.number)))
  }

  const focusRecord = (record: TrajectoryRecord) => {
    setCollapsedTurns((current) => {
      const owningTurn = turns.find((turn) => turn.records.includes(record))
      if (!owningTurn || !current.has(owningTurn.number)) return current
      const next = new Set(current)
      next.delete(owningTurn.number)
      return next
    })
    if (record.item.kind === 'tool') setCallsCollapsed(false)
    setSelectedId(record.item.id)
    requestAnimationFrame(() => document.getElementById(`trajectory-${record.item.id}`)?.scrollIntoView({ block: 'center' }))
  }

  return (
    <div className="trajectory">
      <div className="trajectory__toolbar" role="toolbar" aria-label="Trajectory controls">
        <div className="trajectory__toolbar-actions">
          <button type="button" className={actualDuration ? 'is-active' : ''} aria-pressed={actualDuration} onClick={() => setActualDuration((value) => !value)}>
            <span aria-hidden="true">◷</span> Duration
          </button>
          <button type="button" aria-pressed={allTurnsCollapsed} onClick={toggleAllTurns}>
            <span aria-hidden="true">{allTurnsCollapsed ? '⊞' : '⊟'}</span> Turns
          </button>
          <button type="button" aria-pressed={callsCollapsed} onClick={() => setCallsCollapsed((value) => !value)}>
            <span aria-hidden="true">{callsCollapsed ? '⊞' : '⊟'}</span> Calls
          </button>
        </div>
        <label className="trajectory__search">
          <span aria-hidden="true">⌕</span>
          <input type="search" aria-label="Search trajectory" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>

      {records.length > 0 && (
        <div className="trajectory__overview" aria-label="Session activity overview">
          <div className="trajectory__lane-labels" aria-hidden="true"><span>Input</span><span>Model</span><span>Tools</span></div>
          <div className="trajectory__lanes">
            {(['input', 'model', 'tools'] as const).map((lane) => (
              <div className={`trajectory__lane trajectory__lane--${lane}`} key={lane}>
                {records.filter((record) => laneFor(record.item) === lane).map((record) => {
                  const left = actualDuration ? ((record.timestamp - minimum) / span) * 100 : ((record.index - 1) / records.length) * 100
                  const width = actualDuration ? Math.max(0.35, (Math.max(1, record.duration) / span) * 100) : Math.max(0.35, 82 / records.length)
                  return (
                    <button
                      type="button"
                      key={record.item.id}
                      className={`${matching.has(record.item.id) ? '' : 'is-dimmed'}${selectedId === record.item.id ? ' is-selected' : ''}`}
                      style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                      aria-label={`${kindLabel(record.item)} record ${record.index}`}
                      title={`${kindLabel(record.item)} · ${new Date(record.timestamp).toLocaleTimeString()} · ${formatDuration(record.duration)}`}
                      onClick={() => focusRecord(record)}
                    />
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="trajectory__ledger">
        {records.length === 0 && <div className="trajectory__empty">Trajectory appears after the first message.</div>}
        {turns.map((turn) => {
          const collapsed = collapsedTurns.has(turn.number)
          const visible = turn.records.filter((record) => matching.has(record.item.id) && (!callsCollapsed || record.item.kind !== 'tool'))
          if (needle && visible.length === 0) return null
          return (
            <section className="trajectory__turn" key={turn.number}>
              <button
                type="button"
                className="trajectory__turn-head"
                aria-expanded={!collapsed}
                onClick={() => setCollapsedTurns((current) => {
                  const next = new Set(current)
                  if (next.has(turn.number)) next.delete(turn.number)
                  else next.add(turn.number)
                  return next
                })}
              >
                <span>Turn {turn.number}</span>
                <span>{turn.records.length} records</span>
                <span aria-hidden="true">{collapsed ? '›' : '⌄'}</span>
              </button>
              {!collapsed && visible.map((record) => {
                const selected = selectedId === record.item.id
                return (
                  <div className={`trajectory__record${selected ? ' is-selected' : ''}`} id={`trajectory-${record.item.id}`} key={record.item.id}>
                    <button type="button" className="trajectory__record-main" aria-expanded={selected} onClick={() => setSelectedId(selected ? null : record.item.id)}>
                      <span className="trajectory__index">#{record.index}</span>
                      <span className={`trajectory__badge is-${record.item.kind}`}>{kindLabel(record.item)}</span>
                      <span className="trajectory__summary">{record.summary || '(empty)'}</span>
                      <span className="trajectory__duration">{formatDuration(record.duration)}</span>
                    </button>
                    {selected && <TrajectoryDetail record={record} />}
                  </div>
                )
              })}
            </section>
          )
        })}
        {needle && records.length > 0 && matching.size === 0 && <div className="trajectory__empty">No trajectory records match “{query}”.</div>}
      </div>
    </div>
  )
}

function TrajectoryDetail({ record }: { record: TrajectoryRecord }) {
  const { item } = record
  return (
    <div className="trajectory__detail">
      <dl>
        <div><dt>Record</dt><dd>#{record.index}</dd></div>
        <div><dt>Kind</dt><dd>{kindLabel(item)}</dd></div>
        <div><dt>ID</dt><dd>{item.id}</dd></div>
        <div><dt>Started</dt><dd>{new Date(record.timestamp).toLocaleString()}</dd></div>
        <div><dt>Duration</dt><dd>{formatDuration(record.duration)}</dd></div>
        {item.kind === 'tool' && <div><dt>Status</dt><dd>{item.status}</dd></div>}
        {(item.kind === 'assistant' || item.kind === 'rationale') && <div><dt>Streaming</dt><dd>{item.live ? 'Yes' : 'No'}</dd></div>}
        {item.kind === 'notice' && <div><dt>Tone</dt><dd>{item.tone}</dd></div>}
      </dl>
      {item.kind === 'tool' ? (
        <>
          <div className="trajectory__detail-block"><strong>Input</strong><pre>{JSON.stringify(item.args, null, 2)}</pre></div>
          <div className="trajectory__detail-block"><strong>Metadata</strong><pre>{JSON.stringify(item.details, null, 2)}</pre></div>
          <div className="trajectory__detail-block"><strong>Output</strong><pre>{item.output || '(no output)'}</pre></div>
        </>
      ) : (
        <div className="trajectory__detail-block"><strong>Content</strong><pre>{item.text}</pre></div>
      )}
    </div>
  )
}
