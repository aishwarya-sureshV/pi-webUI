import type { SessionState } from './api'
import type { TimelineItem } from './timeline'

export interface ContextUsage {
  estimatedTokens: number
  contextWindow: number
  percent: number | null
  /** True when the backend counted the tokens instead of us guessing from characters. */
  exact?: boolean
  /** Token count at which the backend will auto-compact, when it reports one. */
  autoCompactAt?: number
  categories?: Array<{ name: string; tokens: number }>
}

/** A conservative fallback for backends that do not expose context stats. */
export function estimateContext(items: TimelineItem[], state: SessionState | null): ContextUsage {
  const characters = items.reduce((total, item) => {
    if (item.kind === 'tool') {
      return total + item.output.length + JSON.stringify(item.args).length + JSON.stringify(item.details).length
    }
    return total + item.text.length
  }, 0)
  const estimatedTokens = Math.ceil(characters / 4) + 2_000
  const contextWindow = state?.model?.contextWindow ?? 1_000_000
  const percent = Math.max(0, Math.min(100, Math.round((estimatedTokens / contextWindow) * 100)))
  return { estimatedTokens, contextWindow, percent }
}

export function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}

