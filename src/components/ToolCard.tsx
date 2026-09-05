import { useState } from 'react'
import type { TimelineItem } from '../lib/timeline'
import {
  displayToolName,
  getToolDiff,
  getToolFileView,
  isFileEditTool,
  summarizeTool,
  toolPath,
  type ToolDiff,
  type ToolFileView,
} from '../lib/toolCards'
import { langFromPath } from '../lib/toolCards'
import { NumberedCode } from '../lib/highlight'

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>

export function ToolCard({
  item,
  onOpenFile,
  children = [],
}: {
  item: ToolItem
  onOpenFile: (view: ToolFileView) => void
  /** Calls a subagent made under this one, when this is a Task-style call. */
  children?: ToolItem[]
}) {
  const shownName = displayToolName(item.name)
  const [open, setOpen] = useState(isFileEditTool(item.name))
  // A subagent's work is collapsed by default: the point of delegating is not
  // having to watch it, but it must be one click away when it goes wrong.
  const [childrenOpen, setChildrenOpen] = useState(false)
  const runningChildren = children.filter((child) => child.status === 'running').length

  const summary = summarizeTool(item.name, item.args)
  const diff = getToolDiff(item)
  const fileView = getToolFileView(item)
  const path = toolPath(item.args)
  const language = langFromPath(path)

  return (
    <article className="tl tl--tool">
      <span className="tl__node" />
      <div className={`tool tool--${item.status}`}>
        <div className="tool__head">
          <button type="button" className="tool__toggle" onClick={() => setOpen((v) => !v)}>
            <span>{open ? '▼' : '▶'}</span>
            <em title={shownName !== item.name ? item.name : undefined}>{shownName}</em>
            <strong>{summary}</strong>
            {diff && (
              <span className="diff-stats" aria-label={`${diff.added} added, ${diff.removed} removed`}>
                <b>+{diff.added}</b>
                <i>−{diff.removed}</i>
              </span>
            )}
            {children.length > 0 && (
              <span className="tool__subagents" title={`${children.length} subagent tool calls`}>
                {children.length} nested
                {runningChildren > 0 ? ` · ${runningChildren} running` : ''}
              </span>
            )}
            <span className="tool__state">
              {item.status === 'running'
                ? 'running'
                : item.status === 'error'
                  ? 'failed'
                  : item.elapsed
                    ? `${(item.elapsed / 1000).toFixed(1)}s`
                    : 'done'}
            </span>
          </button>
          {fileView && (
            <button
              type="button"
              className="tool__open"
              title="Open full file"
              aria-label="Open full file"
              onClick={() => onOpenFile(fileView)}
            >
              ⤢
            </button>
          )}
        </div>
        {open && (
          <div className="tool__body">
            {diff ? (
              <DiffPreview diff={diff} />
            ) : item.output ? (
              <NumberedCode code={item.output} language={language} />
            ) : (
              <NumberedCode code={JSON.stringify(item.args, null, 2)} language="json" />
            )}
          </div>
        )}
        {children.length > 0 && (
          <div className="tool__nested">
            <button
              type="button"
              className="tool__nested-toggle"
              aria-expanded={childrenOpen}
              onClick={() => setChildrenOpen((v) => !v)}
            >
              <span>{childrenOpen ? '▼' : '▶'}</span>
              {childrenOpen ? 'Hide' : 'Show'} what the subagent did (
              {children.length})
            </button>
            {childrenOpen && (
              <div className="tool__nested-list">
                {children.map((child) => (
                  <ToolCard key={child.id} item={child} onOpenFile={onOpenFile} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  )
}

export function DiffPreview({ diff }: { diff: ToolDiff }) {
  const numbered = diff.lines.some((line) => line.lineNo != null)
  const width = String(Math.max(0, ...diff.lines.map((line) => line.lineNo ?? 0))).length
  return (
    <div className="diff">
      {diff.lines.map((line, index) => (
        <div key={`${index}-${line.text}`} className={`diff__line is-${line.kind}`}>
          {numbered && (
            <span className="diff__no" aria-hidden="true" style={{ minWidth: `${width}ch` }}>
              {line.kind === 'meta' ? '' : line.lineNo ?? ''}
            </span>
          )}
          <span className="diff__mark">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span>
          <code>{line.text}</code>
        </div>
      ))}
    </div>
  )
}
