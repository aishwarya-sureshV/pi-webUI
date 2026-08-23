/**
 * Timeline model: converts pi RPC events into renderable items, porting
 * AgentDeck's AgentWorkbench semantics (tool cards, rationale, streaming text).
 */
import type { AgentEvent, RunStatus, SessionState } from './api'

export type TimelineItem =
  | { id: string; kind: 'user'; text: string; timestamp: number }
  | { id: string; kind: 'rationale'; text: string; live: boolean }
  | { id: string; kind: 'assistant'; text: string; live: boolean }
  | {
      id: string
      kind: 'tool'
      name: string
      args: Record<string, unknown>
      details: Record<string, unknown>
      output: string
      status: 'running' | 'done' | 'error'
      startedAt: number
      elapsed?: number
    }
  | { id: string; kind: 'notice'; text: string; tone: 'info' | 'warning' | 'error' }

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function readableAgentError(value: unknown): string {
  if (typeof value !== 'string') return ''
  const raw = value.trim()
  if (!raw) return ''
  const jsonStart = raw.indexOf('{')
  if (jsonStart >= 0) {
    try {
      const payload = asRecord(JSON.parse(raw.slice(jsonStart)))
      const nested = asRecord(payload.error)
      if (typeof nested.message === 'string' && nested.message.trim()) return nested.message.trim()
      if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim()
    } catch { /* provider returned plain text after an HTTP status */ }
  }
  return raw
}

export function extractText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => {
      const record = asRecord(part)
      return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

export class Timeline {
  items: TimelineItem[] = []
  status: RunStatus = 'stopped'
  state: SessionState | null = null
  cycle = 0
  private listeners = new Set<() => void>()
  /** Pending in-flight text streams, applied as whole chunks (no per-char cursor). */
  private streams = new Map<string, { id: string; kind: 'rationale' | 'assistant'; pending: string; finalText?: string }>()

  constructor(public readonly key: string) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify() { for (const listener of this.listeners) listener() }

  private updateItems(updater: (current: TimelineItem[]) => TimelineItem[]) {
    this.items = updater(this.items)
    this.notify()
  }

  appendNotice(text: string, tone: 'info' | 'warning' | 'error') {
    if (!text) return
    this.updateItems((current) => [
      ...current,
      { id: crypto.randomUUID(), kind: 'notice', text, tone },
    ])
  }

  appendUser(text: string) {
    this.updateItems((current) => [
      ...current,
      { id: crypto.randomUUID(), kind: 'user', text, timestamp: Date.now() },
    ])
  }

  private upsertStream(id: string, kind: 'rationale' | 'assistant', text: string, final?: string) {
    const existing = this.streams.get(id)
    if (existing) {
      existing.pending += text
      if (final !== undefined) existing.finalText = final
    } else {
      this.streams.set(id, { id, kind, pending: text, finalText: final })
    }
    this.flushStreams()
  }

  /** Apply all pending stream text immediately (whole deltas, not char-by-char). */
  private flushStreams() {
    if (this.streams.size === 0) return
    const patches = [...this.streams.values()]
    // Only clear streams that have finished producing output for this flush.
    this.streams.clear()
    this.updateItems((current) => {
      let next = current
      for (const patch of patches) {
        const done = patch.finalText !== undefined && patch.pending.length === 0
        const text = patch.finalText !== undefined && patch.pending.length === 0 ? patch.finalText : patch.pending
        if (!text) continue
        const found = next.findIndex((item) => item.id === patch.id)
        if (found === -1) {
          next = [...next, { id: patch.id, kind: patch.kind, text, live: !done }]
        } else {
          next = next.map((item, index) =>
            index === found && (item.kind === 'rationale' || item.kind === 'assistant')
              ? {
                  ...item,
                  text: patch.finalText !== undefined && patch.pending.length === 0
                    ? patch.finalText
                    : `${item.text}${patch.pending}`,
                  live: !done,
                }
              : item,
          )
        }
      }
      return next
    })
  }

  handle(event: AgentEvent) {
    if (event.type === '__status') {
      this.status = (event.status as RunStatus) ?? 'ready'
      if (event.error) this.appendNotice(String(event.error), 'error')
      this.notify()
      return
    }
    if (event.type === 'stderr') {
      this.appendNotice(String(event.message ?? ''), 'warning')
      return
    }
    if (event.type === 'turn_start') { this.cycle += 1; return }

    if (event.type === 'message_update') {
      const update = asRecord(event.assistantMessageEvent)
      const contentIndex = typeof update.contentIndex === 'number' ? update.contentIndex : 0
      const updateType = String(update.type ?? '')
      const delta = typeof update.delta === 'string' ? update.delta : ''
      const content = typeof update.content === 'string' ? update.content : ''
      if (updateType === 'thinking_delta') {
        this.upsertStream(`rationale-${this.cycle}-${contentIndex}`, 'rationale', delta)
      } else if (updateType === 'thinking_end') {
        this.upsertStream(`rationale-${this.cycle}-${contentIndex}`, 'rationale', '', content)
      } else if (updateType === 'text_delta') {
        this.upsertStream(`assistant-${this.cycle}-${contentIndex}`, 'assistant', delta)
      } else if (updateType === 'text_end') {
        this.upsertStream(`assistant-${this.cycle}-${contentIndex}`, 'assistant', '', content)
      }
      return
    }

    if (event.type === 'message_end') {
      const message = asRecord(event.message)
      if (String(message.role ?? '') !== 'assistant') return
      const error = readableAgentError(message.errorMessage)
      if (error) { this.appendNotice(error, 'error'); return }
      // Authoritative final text: if deltas were suppressed (retries / exhausted
      // accounts), message_end still carries the whole assistant message.
      const finalText = extractText(message.content)
      if (finalText) {
        // Deltas may have already rendered this exact text at any content index
        // this cycle; only fall back to message_end when nothing matches.
        const already = this.items.some(
          (item) => item.kind === 'assistant' && item.id.startsWith(`assistant-${this.cycle}-`) && item.text.trim() === finalText.trim(),
        )
        if (!already) this.upsertStream(`assistant-${this.cycle}-0`, 'assistant', '', finalText)
      }
      return
    }

    if (event.type === 'tool_execution_start') {
      const id = String(event.toolCallId ?? crypto.randomUUID())
      const name = String(event.toolName ?? 'tool')
      const args = asRecord(event.args)
      this.updateItems((current) =>
        current.some((item) => item.kind === 'tool' && item.id === id)
          ? current
          : [
              ...current,
              { id, kind: 'tool', name, args, details: {}, output: '', status: 'running', startedAt: Date.now() },
            ],
      )
      return
    }

    if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      const id = String(event.toolCallId ?? '')
      const result = asRecord(event.type === 'tool_execution_end' ? event.result : event.partialResult)
      const output = extractText(result.content)
      this.updateItems((current) =>
        current.map((item) =>
          item.kind === 'tool' && item.id === id
            ? {
                ...item,
                details: asRecord(result.details),
                output: output || item.output,
                status: event.type === 'tool_execution_end' ? (event.isError ? 'error' : 'done') : 'running',
                elapsed: event.type === 'tool_execution_end' ? Date.now() - item.startedAt : undefined,
              }
            : item,
        ),
      )
      return
    }

    if (event.type === 'agent_settled') {
      this.status = 'ready'
      if (this.state) this.state = { ...this.state, isStreaming: false }
      this.notify()
      return
    }

    if (event.type === 'state') {
      this.state = event.state as SessionState
      this.notify()
      return
    }
  }
}
