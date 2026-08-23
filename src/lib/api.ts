/** Types shared with the pi-web server. */

export type RunStatus = 'stopped' | 'starting' | 'ready' | 'working' | 'error'

export interface ModelInfo {
  id: string
  name?: string
  provider: string
  contextWindow?: number
}

export interface SessionState {
  model: ModelInfo | null
  thinkingLevel: string
  isStreaming: boolean
  sessionFile?: string
  sessionId: string
  sessionName?: string
  messageCount: number
  pendingMessageCount: number
}

export interface ResumeSession {
  path: string
  name: string
  cwd: string
  createdAt: number
  modifiedAt: number
  messageCount: number
}

export interface SlashCommand {
  name: string
  description?: string
  source?: string
  argumentHint?: string
}

export interface AgentEvent {
  type: string
  sessionKey?: string
  [key: string]: unknown
}

async function post<T = unknown>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as T
}

async function get<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url)
  return (await res.json()) as T
}

export const api = {
  health: () => get<{ ok: boolean }>('/api/health'),
  sessions: () => get<{ ok: boolean; sessions: ResumeSession[] }>('/api/sessions'),
  start: (key: string, cwd: string) =>
    post<{ ok: boolean; state?: SessionState; error?: string }>(`/api/${key}/start`, { cwd }),
  prompt: (key: string, message: string) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/prompt`, { message }),
  steer: (key: string, message: string) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/steer`, { message }),
  abort: (key: string) => post<{ ok: boolean; error?: string }>(`/api/${key}/abort`, {}),
  newSession: (key: string) => post<{ ok: boolean; error?: string }>(`/api/${key}/new-session`, {}),
  resume: (key: string, sessionPath: string) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/resume`, { sessionPath }),
  compact: (key: string, customInstructions?: string) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/compact`, { customInstructions }),
  setModel: (key: string, provider: string, modelId: string) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/set-model`, { provider, modelId }),
  setThinking: (key: string, level: string) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/set-thinking`, { level }),
  commands: (key: string) =>
    get<{ ok: boolean; commands: SlashCommand[] }>(`/api/${key}/commands`),
  models: (key: string) => get<{ ok: boolean; models: ModelInfo[] }>(`/api/${key}/models`),
  thinkingLevels: (key: string) =>
    get<{ ok: boolean; levels: string[] }>(`/api/${key}/thinking-levels`),
}

/** Subscribe to the server event fan-out. */
export function subscribeEvents(onEvent: (event: AgentEvent) => void): () => void {
  const source = new EventSource('/api/events')
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as AgentEvent)
    } catch {
      /* ignore malformed */
    }
  }
  return () => source.close()
}
