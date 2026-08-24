import { memo, type JSX, type ReactNode } from 'react'
import { highlightCode } from '../lib/highlight'
import { CopyButton } from './CopyButton'

export const RichText = memo(function RichText({ text, live = false }: { text: string; live?: boolean }) {
  if (live) {
    return <div className="rich-text rich-text--live">{text}</div>
  }
  const blocks = text.split('```')
  return (
    <div className="rich-text">
      {blocks.map((block, index) => {
        if (index % 2 === 0) return <MarkdownBlocks key={index} text={block} />
        const [maybeFirst, ...rest] = block.split('\n')
        const first = maybeFirst ?? ''
        const hasLanguage = /^[\w+-]+$/.test(first.trim())
        const language = hasLanguage ? first.trim() : undefined
        const code = hasLanguage ? rest.join('\n') : block
        return <CodeBlock key={index} code={code} language={language} />
      })}
    </div>
  )
})

function CodeBlock({ code, language }: { code: string; language?: string }) {
  return (
    <div className="md-code-block">
      <pre data-language={language}>
        <code>{highlightCode(code, language)}</code>
      </pre>
      <CopyButton text={code} label="Copy command" className="md-code-block__copy" />
    </div>
  )
}

const MarkdownBlocks = memo(function MarkdownBlocks({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const nodes: ReactNode[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    if (!trimmed) { index += 1; continue }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed)
    if (heading) {
      const level = (heading[1] ?? '').length
      const HeadingTag = `h${Math.min(level + 2, 6)}` as keyof JSX.IntrinsicElements
      nodes.push(<HeadingTag key={`heading-${index}`} className="md-heading">{inline(heading[2] ?? '')}</HeadingTag>)
      index += 1
      continue
    }

    if (isTableStart(lines, index)) {
      const tableLines = [lines[index] ?? '']
      index += 2
      while (index < lines.length && isTableRow(lines[index] ?? '')) {
        tableLines.push(lines[index] ?? '')
        index += 1
      }
      nodes.push(<MarkdownTable key={`table-${index}`} lines={tableLines} />)
      continue
    }

    if (/^[-*•]\s+/.test(trimmed)) {
      const items: string[] = []
      while (index < lines.length && /^[-*•]\s+/.test((lines[index] ?? '').trim())) {
        items.push((lines[index] ?? '').trim().replace(/^[-*•]\s+/, ''))
        index += 1
      }
      nodes.push(<ul key={`list-${index}`} className="md-list">{items.map((item, itemIndex) => <li key={`${itemIndex}-${item}`}>{inline(item)}</li>)}</ul>)
      continue
    }

    const paragraph = [line]
    index += 1
    while (
      index < lines.length &&
      (lines[index] ?? '').trim() &&
      !/^(#{1,4})\s+/.test((lines[index] ?? '').trim()) &&
      !/^[-*•]\s+/.test((lines[index] ?? '').trim()) &&
      !isTableStart(lines, index)
    ) {
      paragraph.push(lines[index] ?? '')
      index += 1
    }
    nodes.push(<p key={`paragraph-${index}`} className="md-paragraph">{inline(paragraph.join('\n'))}</p>)
  }

  return <>{nodes}</>
})

function MarkdownTable({ lines }: { lines: string[] }) {
  const [headerLine = '', ...bodyLines] = lines
  const headers = splitTableCells(headerLine)
  const rows = bodyLines.map(splitTableCells)
  return (
    <div className="md-table-wrap">
      <table className="md-table">
        <thead><tr>{headers.map((cell, index) => <th key={`${index}-${cell}`}>{inline(cell)}</th>)}</tr></thead>
        <tbody>{rows.map((row, rowIndex) => (
          <tr key={row.join('|') || rowIndex}>
            {headers.map((_, cellIndex) => <td key={cellIndex}>{inline(row[cellIndex] ?? '')}</td>)}
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function isTableStart(lines: string[], index: number): boolean {
  const current = lines[index] ?? ''
  const next = lines[index + 1] ?? ''
  return isTableRow(current) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next)
}

function isTableRow(line: string): boolean {
  return line.includes('|') && splitTableCells(line).length > 1
}

function splitTableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>
    return part
  })
}
