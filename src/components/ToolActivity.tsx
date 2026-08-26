import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { TimelineItem } from '../lib/timeline'
import { summarizeTool } from '../lib/toolCards'
import { langFromPath } from '../lib/toolCards'
import { highlightCode } from '../lib/highlight'
import { CopyButton } from './CopyButton'

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>

export interface ToolGroup {
  key: string
  label: string
  title: string
  icon: string
  items: ToolItem[]
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function duration(items: ToolItem[]): string {
  const elapsed = items.reduce((total, item) => total + (item.elapsed ?? 0), 0)
  return elapsed > 0 ? `${(elapsed / 1000).toFixed(1)}s` : ''
}

export function groupToolActivity(items: ToolItem[]): ToolGroup[] {
  const shell = items.filter((item) => item.name.toLowerCase() === 'bash')
  const reads = items.filter((item) => item.name.toLowerCase() === 'read')
  const searches = items.filter((item) => ['grep', 'find', 'ls'].includes(item.name.toLowerCase()))
  const categorized = new Set([...shell, ...reads, ...searches].map((item) => item.id))
  const other = items.filter((item) => !categorized.has(item.id))
  const groups: ToolGroup[] = []

  if (reads.length) {
    const firstPath = String(reads[0]?.args.path ?? reads[0]?.args.file_path ?? '')
    groups.push({
      key: 'read',
      title: reads.length === 1 ? `Read ${firstPath || 'file'}` : `${reads.length} files read`,
      label: reads.length === 1 ? `read ${basename(firstPath) || 'file'}` : `${reads.length} files read`,
      icon: '⌕',
      items: reads,
    })
  }
  if (searches.length) {
    groups.push({
      key: 'search',
      title: `${searches.length} search ${searches.length === 1 ? 'call' : 'calls'}`,
      label: `${searches.length} ${searches.length === 1 ? 'search' : 'searches'}`,
      icon: '⌕',
      items: searches,
    })
  }
  if (shell.length) {
    groups.push({
      key: 'shell',
      title: `${shell.length} shell ${shell.length === 1 ? 'command' : 'commands'}`,
      label: `${shell.length} shell ${shell.length === 1 ? 'command' : 'commands'}`,
      icon: '$',
      items: shell,
    })
  }
  if (other.length) {
    groups.push({
      key: 'tools',
      title: `${other.length} tool ${other.length === 1 ? 'call' : 'calls'}`,
      label: `${other.length} tool ${other.length === 1 ? 'call' : 'calls'}`,
      icon: '◇',
      items: other,
    })
  }
  return groups
}

export function ToolActivitySummary({
  items,
  onOpen,
}: {
  items: ToolItem[]
  onOpen: (group: ToolGroup) => void
}) {
  const groups = useMemo(() => groupToolActivity(items), [items])
  if (!groups.length) return null

  return (
    <div className="tool-summary" aria-label="Completed tool activity">
      {groups.map((group) => (
        <button key={group.key} type="button" className="tool-summary__chip" onClick={() => onOpen(group)}>
          <span>{group.icon}</span>
          <strong>{group.label}</strong>
          {duration(group.items) && <em>{duration(group.items)}</em>}
        </button>
      ))}
    </div>
  )
}

function commandText(item: ToolItem): string {
  if (typeof item.args.command === 'string') return item.args.command
  if (typeof item.args.path === 'string') return item.args.path
  if (typeof item.args.file_path === 'string') return item.args.file_path
  return summarizeTool(item.name, item.args)
}

export function ToolDetailsRail({ group, onClose }: { group: ToolGroup; onClose: () => void }) {
  const [width, setWidth] = useState(() => Number(localStorage.getItem('pi-web.tool-rail-width')) || 480)
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])

  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = width
    const move = (moveEvent: PointerEvent) => {
      setWidth(Math.min(Math.max(startWidth + startX - moveEvent.clientX, 340), window.innerWidth * 0.9))
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      setWidth((current) => {
        localStorage.setItem('pi-web.tool-rail-width', String(Math.round(current)))
        return current
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  return (
    <div className="tool-rail-layer">
      <button type="button" className="tool-rail__backdrop" aria-label="Close command details" onClick={onClose} />
      <aside className="tool-rail" aria-label={group.title} style={{ width }}>
        <button type="button" className="tool-rail__resize" aria-label="Resize file details" onPointerDown={beginResize} />
        <header className="tool-rail__header">
          <div><span>{group.icon}</span><strong>{group.title}</strong></div>
          <button type="button" aria-label="Close command details" onClick={onClose}>×</button>
        </header>
        <div className="tool-rail__list">
          {group.items.map((item, index) => {
            const command = commandText(item)
            return (
              <details key={item.id} className="tool-rail__item" open={group.items.length === 1}>
                <summary>
                  <span>{index + 1}</span>
                  <code>{command}</code>
                  <em>{item.status === 'error' ? 'failed' : item.elapsed ? `${(item.elapsed / 1000).toFixed(1)}s` : item.status}</em>
                </summary>
                <div className="tool-rail__detail">
                  <div className="tool-rail__command">
                    <code>{command}</code>
                    <CopyButton text={command} label="Copy command" className="tool-rail__copy" iconOnly />
                  </div>
                  {item.output && (
                    <pre><code>{highlightCode(item.output, langFromPath(String(item.args.path ?? item.args.file_path ?? '')))}</code></pre>
                  )}
                </div>
              </details>
            )
          })}
        </div>
      </aside>
    </div>
  )
}

function runningLabel(command: string): string {
  const file = command.match(/(?:^|\s)([^\s;&|]+\.(?:py|js|ts|sh|rb|go|rs))(?:\s|$)/i)?.[1]
  if (file) return basename(file)
  const tokens = command.trim().split(/\s+/)
  return basename(tokens[0] || 'shell command')
}

export function ActiveRunIndicator({ item, onInterrupt }: { item: ToolItem; onInterrupt: () => void }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100)
    const interrupt = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onInterrupt()
    }
    window.addEventListener('keydown', interrupt)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('keydown', interrupt)
    }
  }, [onInterrupt])
  const command = String(item.args.command ?? '')
  const elapsed = Math.max(0, now - item.startedAt)

  return (
    <button type="button" className="active-run" onClick={onInterrupt} title="Interrupt command">
      <span className="active-run__dot" />
      <strong>running {runningLabel(command)}</strong>
      <em>· {(elapsed / 1000).toFixed(1)}s · esc to interrupt</em>
    </button>
  )
}
