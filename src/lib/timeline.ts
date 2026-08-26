/**
 * Timeline model: converts pi RPC events into renderable items, porting
 * AgentDeck's AgentWorkbench semantics (tool cards, rationale, streaming text).
 */
import type { AgentEvent, BackendLogEntry, RunStatus, SessionHistoryMessage, SessionState } from './api'

export type TimelineItem =
  | { id: string; kind: 'user'; text: string; timestamp: number }
  | { id: string; kind: 'rationale'; text: string; live: boolean; timestamp: number }
  | { id: string; kind: 'assistant'; text: string; live: boolean; timestamp: number; provider?: string; modelId?: string }
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
  | { id: string; kind: 'notice'; text: string; tone: 'info' | 'warning' | 'error'; timestamp: number }

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

function extractHistoryText(value: unknown, imageLabel = ''): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => {
      const record = asRecord(part)
      if (record.type === 'text' && typeof record.text === 'string') return record.text
      if (imageLabel && record.type === 'image') return imageLabel
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function historyTimestamp(message: SessionHistoryMessage): number {
  return typeof message.timestamp === 'number' ? message.timestamp : Date.now()
}

export class Timeline {
  items: TimelineItem[] = []
  backendLog: BackendLogEntry[] = []
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
      { id: crypto.randomUUID(), kind: 'notice', text, tone, timestamp: Date.now() },
    ])
  }

  appendUser(text: string) {
    this.updateItems((current) => [
      ...current,
      { id: crypto.randomUUID(), kind: 'user', text, timestamp: Date.now() },
    ])
  }

  appendAssistant(text: string) {
    if (!text) return
    this.updateItems((current) => [
      ...current,
      { id: crypto.randomUUID(), kind: 'assistant', text, live: false, timestamp: Date.now() },
    ])
  }

  private appendBackendEvent(event: AgentEvent) {
    if (event.type === '__hello') return
    const id = typeof event.__logId === 'string' ? event.__logId : crypto.randomUUID()
    if (this.backendLog.some((entry) => entry.id === id)) return
    const timestamp = typeof event.__loggedAt === 'number' ? event.__loggedAt : Date.now()
    const source = typeof event.__logSource === 'string' ? event.__logSource : 'agent'
    const payload = Object.fromEntries(
      Object.entries(event).filter(([key]) => !key.startsWith('__')),
    )
    this.backendLog = [...this.backendLog, {
      id,
      timestamp,
      source,
      type: event.type,
      payload,
    }]
    this.notify()
  }

  hydrateBackendLog(entries: BackendLogEntry[]) {
    const byId = new Map(this.backendLog.map((entry) => [entry.id, entry]))
    entries.forEach((entry) => {
      if (!entry || typeof entry.id !== 'string' || byId.has(entry.id)) return
      byId.set(entry.id, {
        id: entry.id,
        timestamp: Number(entry.timestamp) || Date.now(),
        source: String(entry.source || 'agent'),
        type: String(entry.type || 'unknown'),
        payload: asRecord(entry.payload),
      })
    })
    this.backendLog = [...byId.values()].sort((left, right) => left.timestamp - right.timestamp)
    this.notify()
  }

  reset(state: SessionState | null = this.state) {
    this.items = []
    this.streams.clear()
    this.cycle = 0
    this.state = state
    this.status = state?.isStreaming ? 'working' : 'ready'
    this.notify()
  }

  hydrate(messages: SessionHistoryMessage[], state: SessionState) {
    const items: TimelineItem[] = []
    const tools = new Map<string, number>()

    messages.forEach((message, messageIndex) => {
      const role = String(message.role ?? '')
      const timestamp = historyTimestamp(message)
      if (role === 'user') {
        const text = extractHistoryText(message.content, '[Image attachment]')
        if (text) items.push({ id: `history-user-${messageIndex}`, kind: 'user', text, timestamp })
        return
      }

      if (role === 'assistant') {
        const error = readableAgentError(message.errorMessage)
        if (error) {
          items.push({ id: `history-error-${messageIndex}`, kind: 'notice', text: error, tone: 'error', timestamp })
        }
        const provider = typeof message.provider === 'string' ? message.provider : undefined
        const modelId = typeof message.model === 'string' ? message.model : undefined
        if (!Array.isArray(message.content)) return
        message.content.forEach((part, contentIndex) => {
          const content = asRecord(part)
          const type = String(content.type ?? '')
          if (type === 'thinking') {
            const text = typeof content.thinking === 'string' ? content.thinking : ''
            if (text) items.push({ id: `history-rationale-${messageIndex}-${contentIndex}`, kind: 'rationale', text, live: false, timestamp })
          } else if (type === 'text') {
            const text = typeof content.text === 'string' ? content.text : ''
            if (text) items.push({ id: `history-assistant-${messageIndex}-${contentIndex}`, kind: 'assistant', text, live: false, timestamp, provider, modelId })
          } else if (type === 'toolCall') {
            const id = String(content.id ?? `history-tool-${messageIndex}-${contentIndex}`)
            const tool: TimelineItem = {
              id,
              kind: 'tool',
              name: String(content.name ?? 'tool'),
              args: asRecord(content.arguments),
              details: {},
              output: '',
              status: 'running',
              startedAt: timestamp,
            }
            tools.set(id, items.length)
            items.push(tool)
          }
        })
        return
      }

      if (role === 'toolResult') {
        const id = String(message.toolCallId ?? '')
        const output = extractHistoryText(message.content, '[Image output]')
        const found = tools.get(id)
        if (found !== undefined) {
          const tool = items[found]
          if (tool?.kind === 'tool') {
            items[found] = {
              ...tool,
              name: String(message.toolName ?? tool.name),
              details: asRecord(message.details),
              output,
              status: message.isError ? 'error' : 'done',
              elapsed: Math.max(0, timestamp - tool.startedAt),
            }
          }
        } else {
          items.push({
            id: id || `history-tool-result-${messageIndex}`,
            kind: 'tool',
            name: String(message.toolName ?? 'tool'),
            args: {},
            details: asRecord(message.details),
            output,
            status: message.isError ? 'error' : 'done',
            startedAt: timestamp,
            elapsed: 0,
          })
        }
      }
    })

    this.items = items
    this.streams.clear()
    this.cycle = 0
    this.state = state
    this.status = state.isStreaming ? 'working' : 'ready'
    this.notify()
  }

  setState(state: SessionState) {
    this.state = state
    this.status = state.isStreaming ? 'working' : 'ready'
    this.notify()
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
          next = [...next, { id: patch.id, kind: patch.kind, text, live: !done, timestamp: Date.now() }]
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
    this.appendBackendEvent(event)
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
    if (event.type === 'subagent_start') {
      this.appendNotice('Subagent started. Its progress will appear inline.', 'info')
      return
    }
    if (event.type === 'system' && String(event.subtype ?? '').toLowerCase().includes('hook')) {
      const subtype = String(event.subtype ?? 'hook').replaceAll('_', ' ')
      const name = String(event.hook_name ?? event.hookName ?? event.hook_event ?? '').trim()
      this.appendNotice(`${subtype}${name ? ` · ${name}` : ''}`, 'info')
      return
    }
    if (event.type === 'turn_start') { this.cycle += 1; return }

    if (event.type === 'agent_start') {
      this.status = 'working'
      if (this.state) this.state = { ...this.state, isStreaming: true }
      this.notify()
      return
    }

    if (event.type === 'message_update') {
      const update = asRecord(event.assistantMessageEvent)
      const contentIndex = typeof update.contentIndex === 'number' ? update.contentIndex : 0
      const updateType = String(update.type ?? '')
      const delta = typeof update.delta === 'string' ? update.delta : ''
      const content = typeof update.content === 'string' ? update.content : ''
      const streamKey = typeof event.streamKey === 'string' ? event.streamKey : String(this.cycle)
      if (updateType === 'thinking_delta') {
        this.upsertStream(`rationale-${streamKey}-${contentIndex}`, 'rationale', delta)
      } else if (updateType === 'thinking_end') {
        this.upsertStream(`rationale-${streamKey}-${contentIndex}`, 'rationale', '', content)
      } else if (updateType === 'text_delta') {
        this.upsertStream(`assistant-${streamKey}-${contentIndex}`, 'assistant', delta)
      } else if (updateType === 'text_end') {
        this.upsertStream(`assistant-${streamKey}-${contentIndex}`, 'assistant', '', content)
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
      const finalTimestamp = historyTimestamp(message)
      const streamKey = typeof event.streamKey === 'string' ? event.streamKey : String(this.cycle)
      // Ground truth for "which model actually answered": the RPC layer tags
      // every assistant message with the model that produced it, independent
      // of what the model's own text claims (self-identification is unreliable).
      const provider = typeof message.provider === 'string' ? message.provider : undefined
      const modelId = typeof message.model === 'string' ? message.model : undefined
      if (finalText) {
        // Deltas may have already rendered this exact text at any content index
        // this cycle; only fall back to message_end when nothing matches.
        const already = this.items.some(
          (item) => item.kind === 'assistant' && item.id.startsWith(`assistant-${streamKey}-`) && item.text.trim() === finalText.trim(),
        )
        if (!already) this.upsertStream(`assistant-${streamKey}-0`, 'assistant', '', finalText)
        this.updateItems((current) => current.map((item) =>
          item.kind === 'assistant' && item.id.startsWith(`assistant-${streamKey}-`)
            ? { ...item, timestamp: finalTimestamp, provider, modelId }
            : item,
        ))
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
      this.setState(event.state as SessionState)
      return
    }
  }
}
