import { useState } from 'react'
import type { TimelineItem } from '../lib/timeline'
import { getToolDiff, getToolFileView, summarizeTool, type ToolDiff, type ToolFileView } from '../lib/toolCards'
import { langFromPath } from '../lib/toolCards'
import { highlightCode } from '../lib/highlight'

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>

export function ToolCard({ item, onOpenFile }: { item: ToolItem; onOpenFile: (view: ToolFileView) => void }) {
  const [open, setOpen] = useState(item.name === 'edit' || item.name === 'write')

  const summary = summarizeTool(item.name, item.args)
  const diff = getToolDiff(item)
  const fileView = getToolFileView(item)
  const path = String(item.args.path ?? item.args.file_path ?? '')
  const language = langFromPath(path)

  return (
    <article className="tl tl--tool">
      <span className="tl__node" />
      <div className={`tool tool--${item.status}`}>
        <div className="tool__head">
          <button type="button" className="tool__toggle" onClick={() => setOpen((v) => !v)}>
            <span>{open ? '▼' : '▶'}</span>
            <em>{item.name}</em>
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
              <pre data-language={language}><code>{highlightCode(item.output, language)}</code></pre>
            ) : (
              <pre>{JSON.stringify(item.args, null, 2)}</pre>
            )}
          </div>
        )}
      </div>
    </article>
  )
}

export function DiffPreview({ diff }: { diff: ToolDiff }) {
  return (
    <div className="diff">
      {diff.lines.map((line, index) => (
        <div key={`${index}-${line.text}`} className={`diff__line is-${line.kind}`}>
          <span>{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span>
          <code>{line.text}</code>
        </div>
      ))}
    </div>
  )
}
