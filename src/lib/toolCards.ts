/** Tool card derivation: summaries, diffs, and full-file views (ported from AgentDeck). */
import type { TimelineItem } from './timeline'
import { asRecord } from './timeline'

export interface DiffLine { kind: 'add' | 'remove' | 'context' | 'meta'; text: string }
export interface ToolDiff { added: number; removed: number; lines: DiffLine[] }
export interface ToolFileView { title: string; language?: string; content?: string; diff?: ToolDiff }

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>

export function summarizeTool(name: string, args: Record<string, unknown>): string {
  for (const key of ['path', 'file_path', 'command', 'query', 'url']) {
    if (typeof args[key] === 'string') return truncate(String(args[key]), 86)
  }
  const keys = Object.keys(args)
  return keys.length ? truncate(JSON.stringify(args), 86) : name
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', mts: 'ts', cts: 'ts', js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'cs', swift: 'swift', kt: 'kotlin',
  scala: 'scala', dart: 'dart', php: 'php', css: 'css', scss: 'scss', less: 'less',
  html: 'html', xml: 'xml', svg: 'svg', json: 'json', jsonl: 'json', yml: 'yaml', yaml: 'yaml',
  toml: 'toml', sql: 'sql', lua: 'lua', sh: 'bash', bash: 'bash', zsh: 'bash',
  md: 'markdown', markdown: 'markdown',
}

export function langFromPath(path: string): string | undefined {
  const ext = path.split('?')[0]?.split('.').at(-1)?.toLowerCase()
  return ext ? (LANG_BY_EXT[ext] ?? ext) : undefined
}

const CODE_EXTENSIONS = new Set([
  'ts','tsx','mts','cts','js','mjs','cjs','jsx','vue','svelte','py','pyi','rb','go','rs','java',
  'kt','kts','scala','c','h','cpp','cc','cxx','hpp','cs','swift','dart','php','groovy','clj',
  'cljs','edn','ex','exs','elm','hs','jl','lua','pl','ps1','r','css','scss','sass','less',
  'html','htm','sql','sh','bash','zsh','fish','vim',
])

function isCodePath(path: string): boolean {
  const ext = path.split('?')[0]?.split('.').at(-1)?.toLowerCase()
  return ext !== undefined && CODE_EXTENSIONS.has(ext)
}

export function getToolFileView(item: ToolItem): ToolFileView | null {
  const path = String(item.args.path ?? item.args.file_path ?? '')
  const toolName = item.name.toLowerCase()
  if (!isCodePath(path)) return null
  if (toolName === 'write' && typeof item.args.content === 'string') {
    return { title: path, language: langFromPath(path), content: item.args.content }
  }
  if (toolName === 'read' && item.output) {
    return { title: path, language: langFromPath(path), content: item.output }
  }
  if (toolName === 'edit') {
    const diff = getToolDiff(item)
    if (diff) return { title: path, diff }
  }
  return null
}

export function getToolDiff(item: ToolItem): ToolDiff | null {
  if (item.name.toLowerCase() === 'edit') {
    const patch = item.details.patch
    if (typeof patch === 'string' && patch) return parseUnifiedPatch(patch)
    const edits = Array.isArray(item.args.edits) ? item.args.edits.map(asRecord) : [item.args]
    const lines: DiffLine[] = []
    for (const edit of edits) {
      const oldText = typeof edit.oldText === 'string' ? edit.oldText : edit.old_string
      const newText = typeof edit.newText === 'string' ? edit.newText : edit.new_string
      if (typeof oldText === 'string') lines.push(...splitDisplayLines(oldText).map((text) => ({ kind: 'remove' as const, text })))
      if (typeof newText === 'string') lines.push(...splitDisplayLines(newText).map((text) => ({ kind: 'add' as const, text })))
    }
    if (!lines.length) return null
    return {
      added: lines.filter((l) => l.kind === 'add').length,
      removed: lines.filter((l) => l.kind === 'remove').length,
      lines,
    }
  }
  if (item.name === 'write' && typeof item.args.content === 'string') {
    const lines = splitDisplayLines(item.args.content).map((text) => ({ kind: 'add' as const, text }))
    return { added: lines.length, removed: 0, lines }
  }
  return null
}

function parseUnifiedPatch(patch: string): ToolDiff {
  let added = 0
  let removed = 0
  const lines: DiffLine[] = []
  for (const rawLine of patch.split('\n')) {
    if (rawLine.startsWith('+++') || rawLine.startsWith('---') || rawLine.startsWith('diff ')) continue
    if (rawLine.startsWith('@@')) lines.push({ kind: 'meta', text: rawLine })
    else if (rawLine.startsWith('+')) { added += 1; lines.push({ kind: 'add', text: rawLine.slice(1) }) }
    else if (rawLine.startsWith('-')) { removed += 1; lines.push({ kind: 'remove', text: rawLine.slice(1) }) }
    else if (rawLine.startsWith(' ')) lines.push({ kind: 'context', text: rawLine.slice(1) })
  }
  return { added, removed, lines }
}

function splitDisplayLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.length ? lines : ['']
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
