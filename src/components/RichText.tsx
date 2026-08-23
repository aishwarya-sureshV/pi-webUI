import { memo } from 'react'
import { highlightCode } from '../lib/highlight'

export const RichText = memo(function RichText({ text, live = false }: { text: string; live?: boolean }) {
  if (live) {
    return <div className="rich-text">{text}</div>
  }
  const blocks = text.split('```')
  return (
    <div className="rich-text">
      {blocks.map((block, index) => {
        if (index % 2 === 0) return <MarkdownBlocks key={index} text={block} />
        const [maybeFirst, ...rest] = block.split('\n')
        const first = maybeFirst ?? ''
        const hasLanguage = /^[\w+-]+$/.test(first.trim())
        return (
          <pre key={index} data-language={hasLanguage ? first.trim() : undefined}>
            <code>
              {highlightCode(hasLanguage ? rest.join('\n') : block, hasLanguage ? first.trim() : undefined)}
            </code>
          </pre>
        )
      })}
    </div>
  )
})

const MarkdownBlocks = memo(function MarkdownBlocks({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <>
      {lines.map((line, index) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('### ')) return <h4 key={index}>{inline(trimmed.slice(4))}</h4>
        if (trimmed.startsWith('## ')) return <h3 key={index}>{inline(trimmed.slice(3))}</h3>
        if (trimmed.startsWith('# ')) return <h2 key={index}>{inline(trimmed.slice(2))}</h2>
        if (/^[-*•] /.test(trimmed)) return <p key={index}>• {inline(trimmed.slice(2))}</p>
        if (trimmed === '') return <br key={index} />
        return <p key={index}>{inline(line)}</p>
      })}
    </>
  )
})

function inline(text: string): React.ReactNode {
  const parts = text.split('`')
  if (parts.length === 1) return text
  return parts.map((part, index) =>
    index % 2 === 1 ? <code key={index}>{part}</code> : <span key={index}>{part}</span>,
  )
}
