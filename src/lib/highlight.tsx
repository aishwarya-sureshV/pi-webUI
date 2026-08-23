import { Fragment, type ReactNode } from 'react'

/**
 * Tiny, dependency-free syntax highlighter for prose (markdown) code blocks
 * rendered by <RichText/>. It is intentionally approximate — good enough for an
 * IDE-like feel (keywords, strings, comments, numbers, functions, types) without
 * pulling in shiki/prism.
 *
 * It is deliberately NOT applied to tool-output code blocks (read/edit/write/etc.),
 * which keep their plain single-color treatment.
 */

const C_LIKE = new Set([
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'mts',
  'cts',
  'json5',
  'go',
  'rust',
  'rs',
  'java',
  'c',
  'h',
  'cpp',
  'cc',
  'cxx',
  'hpp',
  'c++',
  'cs',
  'csharp',
  'swift',
  'kotlin',
  'kt',
  'scala',
  'dart',
  'php',
  'groovy',
  'less',
  'scss',
  'sass',
  'php',
])

const HASH_LANGS = new Set([
  'python',
  'py',
  'rb',
  'ruby',
  'sh',
  'bash',
  'zsh',
  'shell',
  'shellsession',
  'yaml',
  'yml',
  'toml',
  'ini',
  'r',
  'perl',
  'pl',
  'dockerfile',
  'makefile',
  'make',
  'ps1',
  'powershell',
  'conf',
  'gitconfig',
  'gitignore',
  'dockerfile',
])

const DASH_LANGS = new Set(['sql', 'lua', 'haskell', 'hs', 'ada'])
const MARKUP_LANGS = new Set(['html', 'xml', 'svg', 'vue', 'svelte', 'markdown', 'md'])

const KEYWORDS = [
  // declarations / control flow (broad union across common languages)
  'const',
  'let',
  'var',
  'function',
  'def',
  'fn',
  'func',
  'class',
  'struct',
  'enum',
  'interface',
  'trait',
  'impl',
  'extends',
  'implements',
  'namespace',
  'module',
  'package',
  'import',
  'export',
  'from',
  'use',
  'require',
  'return',
  'yield',
  'if',
  'elif',
  'else',
  'for',
  'foreach',
  'while',
  'do',
  'loop',
  'switch',
  'case',
  'match',
  'default',
  'break',
  'continue',
  'pass',
  'new',
  'delete',
  'del',
  'async',
  'await',
  'try',
  'catch',
  'finally',
  'throw',
  'throws',
  'raise',
  'except',
  'with',
  'as',
  'in',
  'is',
  'of',
  'not',
  'and',
  'or',
  'lambda',
  'global',
  'nonlocal',
  'assert',
  'static',
  'final',
  'abstract',
  'public',
  'private',
  'protected',
  'readonly',
  'override',
  'virtual',
  'get',
  'set',
  'type',
  'alias',
  'typedef',
  'infer',
  'keyof',
  'satisfies',
  'declare',
  'constructor',
  'super',
  'this',
  'self',
  'mut',
  'pub',
  'ref',
  'move',
  'dyn',
  'where',
  'unsafe',
  'go',
  'defer',
  'chan',
  'map',
  'range',
  'select',
  // SQL (uppercase) — kept here so they win over the generic type rule
  'SELECT',
  'FROM',
  'WHERE',
  'INSERT',
  'INTO',
  'UPDATE',
  'DELETE',
  'CREATE',
  'TABLE',
  'DROP',
  'ALTER',
  'ADD',
  'COLUMN',
  'VALUES',
  'SET',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'OUTER',
  'ON',
  'GROUP',
  'BY',
  'ORDER',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'PRIMARY',
  'KEY',
  'FOREIGN',
  'REFERENCES',
  'INDEX',
  'UNIQUE',
  'DISTINCT',
  'AS',
  'AND',
  'OR',
  'NOT',
  'NULL',
  'IS',
]

const BOOLS = ['true', 'false', 'null', 'undefined', 'True', 'False', 'None', 'nil', 'NaN', 'Infinity']

function buildKeywordSource(words: string[]): string {
  const sorted = [...new Set(words)].sort((a, b) => b.length - a.length)
  return `\\b(?:${sorted.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`
}

function commentSource(lang: string | undefined): string {
  const parts: string[] = []
  const l = (lang ?? '').toLowerCase()
  if (MARKUP_LANGS.has(l)) parts.push('<!--[\\s\\S]*?-->')
  // Block comments are common across C-like, css, sql, etc.
  parts.push('/\\*[\\s\\S]*?\\*/')
  if (C_LIKE.has(l) || ['css', 'scss', 'less', 'sass', 'go', 'rust', 'rs', 'swift', 'java', 'c', 'cpp', 'cs', 'php'].includes(l)) {
    parts.push('//[^\\n]*')
  }
  if (HASH_LANGS.has(l)) parts.push('#[^\\n]*')
  if (DASH_LANGS.has(l)) parts.push('--[^\\n]*')
  // For languages we don't recognize, allow // and # comments defensively (best-effort).
  if (!l) {
    parts.push('//[^\\n]*')
  }
  return parts.join('|')
}

function buildRegex(lang: string | undefined): RegExp {
  const comment = commentSource(lang)
  const string = [
    '"""[\\s\\S]*?"""',
    "'''[\\s\\S]*?'''",
    '`(?:\\\\.|[^`\\\\])*`',
    '"(?:\\\\.|[^"\\\\])*"',
    "'(?:\\\\.|[^'\\\\])*'",
  ].join('|')
  const number = '\\b0x[0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b'
  const decorator = '@[A-Za-z_]\\w*'
  const bool = `\\b(?:${BOOLS.join('|')})\\b`
  const keyword = buildKeywordSource(KEYWORDS)
  const func = '[A-Za-z_$][\\w$]*(?=\\s*\\()'
  const type = '\\b[A-Z][A-Za-z0-9_]*\\b'

  const source = [
    `(?<comment>${comment})`,
    `(?<string>${string})`,
    `(?<number>${number})`,
    `(?<decorator>${decorator})`,
    `(?<bool>${bool})`,
    `(?<keyword>${keyword})`,
    `(?<func>${func})`,
    `(?<type>${type})`,
  ].join('|')

  return new RegExp(source, 'g')
}

const TOKEN_CLASS: Record<string, string> = {
  comment: 'agent-workbench__tok-comment',
  string: 'agent-workbench__tok-string',
  number: 'agent-workbench__tok-number',
  decorator: 'agent-workbench__tok-decorator',
  bool: 'agent-workbench__tok-bool',
  keyword: 'agent-workbench__tok-keyword',
  func: 'agent-workbench__tok-func',
  type: 'agent-workbench__tok-type',
}

const regexCache = new Map<string, RegExp>()

function getRegex(lang: string | undefined): RegExp {
  const key = lang ?? ''
  let re = regexCache.get(key)
  if (!re) {
    re = buildRegex(lang)
    regexCache.set(key, re)
  }
  return re
}

export function highlightCode(code: string, language: string | undefined): ReactNode[] {
  if (!code) return []
  const re = getRegex(language)
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = re.exec(code)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(<Fragment key={`t${key++}`}>{code.slice(lastIndex, match.index)}</Fragment>)
    }
    const groups = match.groups ?? {}
    let token: string | undefined
    for (const name of Object.keys(TOKEN_CLASS)) {
      if (groups[name] !== undefined) {
        token = name
        break
      }
    }
    if (token) {
      nodes.push(
        <span key={`k${key++}`} className={TOKEN_CLASS[token]}>
          {match[0]}
        </span>,
      )
    } else {
      nodes.push(<Fragment key={`p${key++}`}>{match[0]}</Fragment>)
    }
    lastIndex = re.lastIndex
    if (match.index === re.lastIndex) re.lastIndex++ // guard against zero-width
  }
  if (lastIndex < code.length) {
    nodes.push(<Fragment key={`t${key++}`}>{code.slice(lastIndex)}</Fragment>)
  }
  return nodes
}