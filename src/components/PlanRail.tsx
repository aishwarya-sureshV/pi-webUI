import type { SessionState } from '../lib/api'
import type { TimelineItem } from '../lib/timeline'

export type PlanStep = {
  number: number
  text: string
  completed: boolean
}

function cleanStepText(value: string): string {
  return value
    .replace(/\[DONE:\d+\]/gi, '')
    .replace(/^\*\*(.*?)\**\s*[-—:]?\s*/, '$1 — ')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function planFromText(text: string): PlanStep[] {
  const lines = text.split(/\r?\n/)
  let header = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*(?:#{1,6}\s*)?plan\s*:?[\s*]*$/i.test(lines[index] ?? '')) header = index
  }
  if (header < 0) return []

  const steps: PlanStep[] = []
  for (const line of lines.slice(header + 1)) {
    if (steps.length > 0 && /^\s*#{1,6}\s+/.test(line)) break
    const numbered = line.match(/^\s*(\d+)[.)]\s+(?:\[([ xX~>])\]\s*)?(.+?)\s*$/)
    const checked = line.match(/^\s*[-*]\s+\[([ xX~>])\]\s+(.+?)\s*$/)
    if (!numbered && !checked) continue
    const number = numbered ? Number(numbered[1]) : steps.length + 1
    const marker = numbered ? numbered[2] : checked?.[1]
    const rawText = numbered ? numbered[3] : checked?.[2]
    const stepText = cleanStepText(rawText ?? '')
    if (!stepText) continue
    steps.push({ number, text: stepText, completed: marker?.toLowerCase() === 'x' })
  }
  return steps
}

export function extractPlanSteps(items: TimelineItem[]): PlanStep[] {
  const assistantText = items
    .filter((item): item is Extract<TimelineItem, { kind: 'assistant' }> => item.kind === 'assistant')
    .map((item) => item.text)
  let steps: PlanStep[] = []
  for (const text of assistantText) {
    const candidate = planFromText(text)
    if (candidate.length > 0) steps = candidate
  }

  const completed = new Set<number>()
  for (const text of assistantText) {
    for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) completed.add(Number(match[1]))
  }
  return steps.map((step) => ({ ...step, completed: step.completed || completed.has(step.number) }))
}

function estimateContext(items: TimelineItem[], state: SessionState | null) {
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

function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}

export function PlanRail({
  items,
  state,
  streaming,
  executing,
  onExecute,
  onRefine,
}: {
  items: TimelineItem[]
  state: SessionState | null
  streaming: boolean
  executing: boolean
  onExecute: (steps: PlanStep[]) => void
  onRefine: () => void
}) {
  const steps = extractPlanSteps(items)
  const context = estimateContext(items, state)
  const completedCount = steps.filter((step) => step.completed).length
  const activeNumber = executing ? steps.find((step) => !step.completed)?.number : undefined
  const hasPrompt = items.some((item) => item.kind === 'user')

  return (
    <aside className="plan-rail" aria-label="Plan">
      <section className="plan-rail__context">
        <div className="plan-rail__section-head">
          <span>context</span>
          <strong>{context.percent}% of {compactTokens(context.contextWindow)}</strong>
        </div>
        <div className="plan-rail__meter" title={`Approximately ${context.estimatedTokens.toLocaleString()} tokens used`}>
          <span style={{ width: `${context.percent}%` }} />
        </div>
        <p>~{compactTokens(Math.max(0, context.contextWindow - context.estimatedTokens))} reclaimable</p>
      </section>

      <section className="plan-rail__plan">
        <div className="plan-rail__section-head">
          <span>plan</span>
          {steps.length > 0 && <strong>{completedCount}/{steps.length}</strong>}
        </div>
        {steps.length > 0 ? (
          <ol className="plan-rail__steps">
            {steps.map((step) => {
              const active = step.number === activeNumber
              return (
                <li className={`${step.completed ? 'is-complete' : ''}${active ? ' is-active' : ''}`} key={`${step.number}-${step.text}`}>
                  <span aria-hidden="true">{step.completed ? '✓' : active ? '▸' : '○'}</span>
                  <span>{step.text}</span>
                </li>
              )
            })}
          </ol>
        ) : (
          <p className="plan-rail__empty">
            {!hasPrompt ? 'Describe the task to begin planning.' : streaming ? 'Exploring and preparing the plan…' : 'The response did not contain a numbered Plan section.'}
          </p>
        )}
        {steps.length > 0 && !executing && (
          <div className="plan-rail__actions">
            <button type="button" className="is-primary" disabled={streaming} onClick={() => onExecute(steps)}>Execute plan</button>
            <button type="button" disabled={streaming} onClick={onRefine}>Refine</button>
          </div>
        )}
        {executing && steps.length > 0 && (
          <div className="plan-rail__execution">
            <span className={streaming ? 'is-live' : ''} />
            {completedCount === steps.length ? 'Plan complete' : streaming ? 'Executing current step' : 'Ready to continue'}
          </div>
        )}
      </section>

      <div className="plan-rail__mode">
        <strong>{executing ? 'EXECUTION MODE' : 'PLAN MODE'}</strong>
        <span>{executing ? 'Full workspace tools enabled' : 'Read-only exploration; edits are blocked'}</span>
      </div>
    </aside>
  )
}
