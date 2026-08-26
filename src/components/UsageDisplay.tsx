import type { ProviderUsage, UsageWindow } from '../lib/api'

function windowFor(usage: ProviderUsage, pattern: RegExp): UsageWindow | undefined {
  return usage.windows.find((window) => pattern.test(window.label.toLowerCase()))
}

function percent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function shortLabel(window: UsageWindow): string {
  const label = window.label.toLowerCase()
  if (label.includes('week')) return 'wk'
  if (label.includes('session') || label.includes('hour')) return '5h'
  return window.label.replace(/current\s+/i, '').slice(0, 7)
}

function displayWindows(usage: ProviderUsage): UsageWindow[] {
  const fiveHour = windowFor(usage, /session|hour/)
  const weekly = windowFor(usage, /week/) ?? (usage.windows.length > 1 ? usage.windows[1] : undefined)
  return [fiveHour, weekly].filter((window, index, all): window is UsageWindow => Boolean(window) && all.indexOf(window) === index)
}

function usageTitle(windows: UsageWindow[]): string {
  return windows.map((window) => `${window.label} ${percent(window.usedPercent)}% used${window.resetsAt ? ` · resets ${window.resetsAt}` : ''}`).join(' · ')
}

/** 4a — compact quota next to this session's model picker. */
export function UsageSummary({ usage }: { usage: ProviderUsage }) {
  if (!usage.available) return null
  const windows = displayWindows(usage)
  if (windows.length === 0 && usage.tokens) {
    return (
      <span className="usage-summary" title={`${usage.provider ?? 'Provider'} session tokens`}>
        <span className="usage-summary__label">used</span>
        <span>tokens <span className="usage-summary__value">{usage.tokens.total.toLocaleString()}</span></span>
      </span>
    )
  }
  if (windows.length === 0) return null
  return (
    <span className="usage-summary" title={usageTitle(windows)}>
      <span className="usage-summary__label">used</span>
      {windows.map((window, index) => (
        <span className="usage-summary__window" key={window.label}>
          {index > 0 && <span className="usage-summary__dot">·</span>}
          <span>{shortLabel(window)} <span className="usage-summary__value">{percent(window.usedPercent)}%</span></span>
        </span>
      ))}
    </span>
  )
}
