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

export function ToolCard({ item, onOpenFile }: { item: ToolItem; onOpenFile: (view: ToolFileView) => void }) {
  const shownName = displayToolName(item.name)
  const [open, setOpen] = useState(isFileEditTool(item.name))

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
