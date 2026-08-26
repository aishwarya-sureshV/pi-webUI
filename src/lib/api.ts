/** Types shared with the pi-web server. */

export type RunStatus = 'stopped' | 'starting' | 'ready' | 'working' | 'error'
export type AgentBackend = 'pi' | 'claude'

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

export interface UsageWindow {
  label: string
  usedPercent: number
  resetsAt?: string
}

export interface ProviderUsage {
  available: boolean
  provider?: string
  plan?: string
  windows: UsageWindow[]
  tokens?: {
    input: number
    output: number
    total: number
  }
  updatedAt?: string
}

export interface ResumeSession {
  path: string
  name: string
  cwd: string
  createdAt: number
  modifiedAt: number
  messageCount: number
  backend: AgentBackend
  firstPrompt?: string
  lastModel?: string
  lastEffort?: string
}

export interface SlashCommand {
  name: string
  description?: string
  source?: string
  argumentHint?: string
}

export interface ImageAttachment {
  type: 'image'
  data: string
  mimeType: string
}

export interface SessionHistoryMessage {
  role?: string
  content?: unknown
  timestamp?: number
  toolCallId?: string
  toolName?: string
  details?: unknown
  isError?: boolean
  errorMessage?: string
  stopReason?: string
  [key: string]: unknown
}

export interface SessionSnapshotResponse {
  ok: boolean
  state?: SessionState
  messages?: SessionHistoryMessage[]
  error?: string
}

export interface SessionMutationResponse {
  ok: boolean
  error?: string
}

export interface DirectoryEntry {
  name: string
  path: string
  hidden: boolean
}

export interface DirectoryListingResponse {
  ok: boolean
  path?: string
  parent?: string | null
  home?: string
  entries?: DirectoryEntry[]
  error?: string
}

export interface PiSkillInfo {
  name: string
  description: string
  path: string
}

export interface PiExtensionInfo {
  name: string
  version: string
  description: string
  source: string
  spec: string
  path: string
}

export interface PiCatalogResponse {
  ok: boolean
  skills: PiSkillInfo[]
  extensions: PiExtensionInfo[]
  settings: {
    defaultProvider?: string
    defaultModel?: string
    defaultThinkingLevel?: string
    theme?: string
    quietStartup?: boolean
    hideThinkingBlock?: boolean
    themeCount?: number
    path?: string
  }
  error?: string
}

export interface AgentEvent {
  type: string
  sessionKey?: string
  [key: string]: unknown
}

export interface BackendLogEntry {
  id: string
  timestamp: number
  source: string
  type: string
  payload: Record<string, unknown>
}

async function post<T = unknown>(url: string, body: unknown, timeoutMs?: number): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  })
  return (await res.json()) as T
}

async function get<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url)
  return (await res.json()) as T
}

export const api = {
  health: () => get<{ ok: boolean; cwd: string }>('/api/health'),
  catalog: () => get<PiCatalogResponse>('/api/catalog'),
  directories: (path?: string) =>
    get<DirectoryListingResponse>(`/api/directories${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  sessionLogUrl: (sessionPath: string) => `/api/session-log?path=${encodeURIComponent(sessionPath)}`,
  sessionMessages: (sessionPath: string) =>
    get<{ ok: boolean; messages?: SessionHistoryMessage[]; error?: string }>(`/api/session-messages?path=${encodeURIComponent(sessionPath)}`),
  sessions: (view: 'recent' | 'archived' = 'recent', backend: AgentBackend = 'pi') => {
    const params = new URLSearchParams({ backend })
    if (view === 'archived') params.set('view', 'archived')
    return get<{ ok: boolean; sessions: ResumeSession[] }>(`/api/sessions?${params}`)
  },
  archiveSession: (sessionPath: string) =>
    post<SessionMutationResponse>('/api/sessions/archive', { sessionPath }),
  restoreSession: (sessionPath: string) =>
    post<SessionMutationResponse>('/api/sessions/restore', { sessionPath }),
  deleteSession: (sessionPath: string) =>
    post<SessionMutationResponse>('/api/sessions/delete', { sessionPath }),
  start: (key: string, cwd: string, backend: AgentBackend = 'pi', model?: ModelInfo, sessionPath?: string, thinkingLevel?: string) =>
    post<{ ok: boolean; state?: SessionState; messages?: SessionHistoryMessage[]; error?: string }>(`/api/${key}/start`, {
      cwd,
      backend,
      ...(model ? { model } : {}),
      ...(sessionPath ? { sessionPath } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    }),
  prompt: (key: string, message: string, images?: ImageAttachment[]) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/prompt`, { message, images }),
  steer: (key: string, message: string, images?: ImageAttachment[]) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/steer`, { message, images }),
  abort: (key: string) => post<{ ok: boolean; error?: string }>(`/api/${key}/abort`, {}),
  newSession: (key: string) => post<SessionSnapshotResponse>(`/api/${key}/new-session`, {}),
  resume: (key: string, sessionPath: string) =>
    post<SessionSnapshotResponse>(`/api/${key}/resume`, { sessionPath }, 30_000),
  fork: (key: string, timestamp: number) =>
    post<SessionSnapshotResponse>(`/api/${key}/fork`, { timestamp }),
  compact: (key: string, customInstructions?: string) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/compact`, { customInstructions }),
  setModel: (key: string, provider: string, modelId: string) =>
    post<{ ok: boolean; data?: ModelInfo; state?: SessionState; error?: string }>(`/api/${key}/set-model`, { provider, modelId }),
  setThinking: (key: string, level: string) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/set-thinking`, { level }),
  stop: (key: string) => post<{ ok: boolean; error?: string }>(`/api/${key}/stop`, {}),
  configure: (
    key: string,
    cwd: string,
    accessMode: 'workspace-write' | 'read-only',
    agentMode: 'standard' | 'plan',
    model?: ModelInfo | null,
    thinkingLevel?: string,
    sessionPath?: string,
    backend: AgentBackend = 'pi',
  ) => post<SessionSnapshotResponse>(`/api/${key}/configure`, {
    cwd,
    backend,
    accessMode,
    agentMode,
    model,
    thinkingLevel,
    sessionPath,
  }),
  upload: (key: string, name: string, mimeType: string, data: string) =>
    post<{ ok: boolean; path?: string; error?: string }>(`/api/${key}/upload`, { name, mimeType, data }),
  commands: (key: string, backend?: AgentBackend) =>
    get<{ ok: boolean; commands: SlashCommand[] }>(`/api/${key}/commands${backend ? `?backend=${backend}` : ''}`),
  models: (key: string, backend?: AgentBackend) =>
    get<{ ok: boolean; models: ModelInfo[] }>(`/api/${key}/models${backend ? `?backend=${backend}` : ''}`),
  thinkingLevels: (key: string, backend?: AgentBackend) =>
    get<{ ok: boolean; levels: string[] }>(`/api/${key}/thinking-levels${backend ? `?backend=${backend}` : ''}`),
  usage: (key: string, backend?: AgentBackend, refresh = false) => {
    const params = new URLSearchParams()
    if (backend) params.set('backend', backend)
    if (refresh) params.set('refresh', '1')
    const query = params.size > 0 ? `?${params}` : ''
    return get<{ ok: boolean; usage: ProviderUsage; error?: string }>(`/api/${key}/usage${query}`)
  },
  backendLog: (key: string) =>
    get<{ ok: boolean; entries: BackendLogEntry[]; error?: string }>(`/api/${key}/log`),
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
