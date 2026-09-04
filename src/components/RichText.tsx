import { memo, type JSX, type ReactNode } from 'react'
import { highlightCode, NumberedCode } from '../lib/highlight'
import { CopyButton } from './CopyButton'

type Segment =
  | { type: 'prose'; text: string }
  | { type: 'code'; text: string; language?: string }

export const RichText = memo(function RichText({ text, live = false }: { text: string; live?: boolean }) {
  const segments = splitFencedBlocks(text, live)
  return (
    <div className={`rich-text${live ? ' rich-text--live' : ''}`}>
      {segments.map((segment, index) => (
        segment.type === 'code'
          ? <CodeBlock key={index} code={segment.text} language={segment.language} />
          : <MarkdownBlocks key={index} text={segment.text} />
      ))}
    </div>
  )
})

function CodeBlock({ code, language }: { code: string; language?: string }) {
  return (
    <div className="md-code-block">
      <NumberedCode code={code} language={language} />
      <CopyButton text={code} label="Copy command" className="md-code-block__copy" iconOnly />
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

/**
 * CommonMark-style fences: must start a line (0–3 spaces), use 3+ ` or ~,
 * and close with a same-character fence at least as long. Mid-line ``` and
 * unmatched fences in finished messages stay as prose so messages *about*
 * markdown don't swallow the rest of the reply.
 */
function splitFencedBlocks(text: string, live: boolean): Segment[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const segments: Segment[] = []
  let prose: string[] = []

  const flushProse = () => {
    if (prose.length === 0) return
    const chunk = prose.join('\n')
    prose = []
    if (chunk.length) segments.push({ type: 'prose', text: chunk })
  }

  for (let i = 0; i < lines.length; i++) {
    const opening = matchOpeningFence(lines[i] ?? '')
    if (!opening) {
      prose.push(lines[i] ?? '')
      continue
    }

    let close = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (isClosingFence(lines[j] ?? '', opening.char, opening.length)) {
        close = j
        break
      }
    }

    if (close === -1) {
      // Streaming: keep an open fence as a code block. Finished messages leave
      // unmatched ``` as prose so examples/discussion of fences don't swallow
      // the rest of the reply.
      if (live) {
        flushProse()
        segments.push({
          type: 'code',
          text: lines.slice(i + 1).join('\n'),
          language: opening.language,
        })
        return segments
      }
      prose.push(lines[i] ?? '')
      continue
    }

    flushProse()
    segments.push({
      type: 'code',
      text: lines.slice(i + 1, close).join('\n'),
      language: opening.language,
    })
    i = close
  }

  flushProse()
  return segments.length ? segments : [{ type: 'prose', text: '' }]
}

function matchOpeningFence(line: string): { char: string; length: number; language?: string } | null {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line)
  if (!match) return null
  const marker = match[2] ?? ''
  const rest = match[3] ?? ''
  const char = marker[0] ?? '`'
  if (char === '`' && rest.includes('`')) return null
  const info = rest.trim()
  const token = info.split(/\s+/, 1)[0] ?? ''
  const language = /^[\w.+#-]+$/.test(token) ? token : undefined
  return { char, length: marker.length, language }
}

function isClosingFence(line: string, char: string, length: number): boolean {
  const match = /^( {0,3})(`{3,}|~{3,})\s*$/.exec(line)
  if (!match) return false
  const marker = match[2] ?? ''
  return marker[0] === char && marker.length >= length
}

function inline(text: string): ReactNode {
  const nodes: ReactNode[] = []
  let buffer = ''
  let key = 0

  const flush = () => {
    if (!buffer) return
    nodes.push(buffer)
    buffer = ''
  }

  let i = 0
  while (i < text.length) {
    const char = text[i] ?? ''

    if (char === '\\' && i + 1 < text.length && '*_`~\\'.includes(text[i + 1] ?? '')) {
      buffer += text[i + 1]
      i += 2
      continue
    }

    if (char === '`') {
      let ticks = 0
      while (text[i + ticks] === '`') ticks += 1
      const closer = '`'.repeat(ticks)
      const end = text.indexOf(closer, i + ticks)
      if (end !== -1 && end !== i + ticks) {
        let code = text.slice(i + ticks, end)
        if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1)
        flush()
        const language = inlineLanguage(code)
        nodes.push(
          <code key={key++} className="md-inline-code">
            {language ? highlightCode(code, language) : code}
          </code>,
        )
        i = end + ticks
        continue
      }
    }

    if (text.startsWith('***', i)) {
      const end = findDelimiter(text, '***', i + 3)
      if (end !== -1) {
        flush()
        nodes.push(<strong key={key++}><em>{inline(text.slice(i + 3, end))}</em></strong>)
        i = end + 3
        continue
      }
    }

    if (text.startsWith('**', i)) {
      const end = findDelimiter(text, '**', i + 2)
      if (end !== -1) {
        flush()
        nodes.push(<strong key={key++}>{inline(text.slice(i + 2, end))}</strong>)
        i = end + 2
        continue
      }
    }

    if (char === '*' && isEmphOpen(text, i, '*')) {
      const end = findEmClose(text, i + 1, '*')
      if (end !== -1) {
        flush()
        nodes.push(<em key={key++}>{inline(text.slice(i + 1, end))}</em>)
        i = end + 1
        continue
      }
    }

    if (char === '_' && isEmphOpen(text, i, '_') && !isWordChar(text[i - 1])) {
      const end = findEmClose(text, i + 1, '_')
      if (end !== -1 && !isWordChar(text[end + 1])) {
        flush()
        nodes.push(<em key={key++}>{inline(text.slice(i + 1, end))}</em>)
        i = end + 1
        continue
      }
    }

    buffer += char
    i += 1
  }

  flush()
  return nodes
}

function isEmphOpen(text: string, index: number, marker: '*' | '_'): boolean {
  const next = text[index + 1]
  return Boolean(next && next !== marker && next !== ' ' && next !== '\n')
}

function isWordChar(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9]/.test(char))
}

function findDelimiter(text: string, delim: string, from: number): number {
  let i = from
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue }
    if (text.startsWith(delim, i)) return i
    i += 1
  }
  return -1
}

function findEmClose(text: string, from: number, marker: '*' | '_'): number {
  const doubled = marker + marker
  let i = from
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue }
    if (text.startsWith(doubled, i)) { i += 2; continue }
    if (text[i] === marker && text[i - 1] !== ' ' && text[i - 1] !== '\n') return i
    i += 1
  }
  return -1
}

function inlineLanguage(code: string): string | undefined {
  const trimmed = code.trim()
  if (/^(?:const|let|var|function|class|interface|type|import|export)\b/.test(trimmed)) return 'ts'
  if (/^(?:def|class|from|import|print)\b/.test(trimmed)) return 'python'
  if (/^(?:SELECT|INSERT|UPDATE|DELETE|CREATE)\b/i.test(trimmed)) return 'sql'
  if (/^(?:npm|pnpm|yarn|git|cd|ls|rg|grep|curl)\b/.test(trimmed)) return 'bash'
  if (/^[{[]/.test(trimmed)) return 'json'
  return undefined
}
