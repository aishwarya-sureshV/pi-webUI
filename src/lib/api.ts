/** Types shared with the pi-web server. */

export type RunStatus = "stopped" | "starting" | "ready" | "working" | "error";
export type AgentBackend = "pi" | "claude" | "grok";

export function backendLabel(backend: AgentBackend): string {
  if (backend === "claude") return "Claude";
  if (backend === "grok") return "Grok";
  return "Pi";
}

export interface ModelInfo {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
}

export interface SessionState {
  model: ModelInfo | null;
  thinkingLevel: string;
  isStreaming: boolean;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  messageCount: number;
  pendingMessageCount: number;
}

export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt?: string;
}

export interface ProviderUsage {
  available: boolean;
  provider?: string;
  plan?: string;
  windows: UsageWindow[];
  tokens?: {
    input: number;
    output: number;
    total: number;
  };
  updatedAt?: string;
}

export interface ResumeSession {
  path: string;
  name: string;
  cwd: string;
  createdAt: number;
  modifiedAt: number;
  messageCount: number;
  backend: AgentBackend;
  firstPrompt?: string;
  /** Tail of the final assistant message, when it is the last message in the
   *  session — the sidebar runs the awaiting-answer rule on it. */
  lastAssistantText?: string;
  lastModel?: string;
  /** Every model that produced a turn in this session, including one-off swaps. */
  models?: string[];
  lastEffort?: string;
}

export interface GitChange {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
}

export interface GitChangesResponse {
  ok: boolean;
  error?: string;
  /** False when cwd is not a git repo. */
  repo?: boolean;
  /** True when an origin remote exists (push target available). */
  connected?: boolean;
  remote?: string;
  branch?: string;
  changes?: GitChange[];
}

export interface SlashCommand {
  name: string;
  description?: string;
  source?: string;
  argumentHint?: string;
}

export interface ImageAttachment {
  type: "image";
  data: string;
  mimeType: string;
}

export interface SessionHistoryMessage {
  role?: string;
  content?: unknown;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  errorMessage?: string;
  stopReason?: string;
  [key: string]: unknown;
}

export interface SessionSnapshotResponse {
  ok: boolean;
  state?: SessionState;
  messages?: SessionHistoryMessage[];
  error?: string;
  /** Pi: true when the live session was restored and `state` describes the fork. */
  restored?: boolean;
  /** Pi: worktree path for the forked session (falls back to the original cwd). */
  forkCwd?: string;
}

export interface SessionMutationResponse {
  ok: boolean;
  error?: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
}

export interface DirectoryListingResponse {
  ok: boolean;
  path?: string;
  parent?: string | null;
  home?: string;
  entries?: DirectoryEntry[];
  error?: string;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  hidden: boolean;
}

export interface WorkspaceListingResponse {
  ok: boolean;
  path?: string;
  parent?: string | null;
  truncated?: boolean;
  entries?: WorkspaceEntry[];
  error?: string;
}

export interface WorkspaceFileResponse {
  ok: boolean;
  path?: string;
  name?: string;
  content?: string;
  size?: number;
  binary?: boolean;
  truncated?: boolean;
  error?: string;
}

export interface PiSkillInfo {
  name: string;
  description: string;
  path: string;
}

export interface PiExtensionInfo {
  name: string;
  version: string;
  description: string;
  source: string;
  spec: string;
  path: string;
}

export interface PiCatalogResponse {
  ok: boolean;
  skills: PiSkillInfo[];
  extensions: PiExtensionInfo[];
  settings: {
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel?: string;
    theme?: string;
    quietStartup?: boolean;
    hideThinkingBlock?: boolean;
    themeCount?: number;
    path?: string;
  };
  error?: string;
}

export interface AgentEvent {
  type: string;
  sessionKey?: string;
  [key: string]: unknown;
}

export interface BackendLogEntry {
  id: string;
  timestamp: number;
  source: string;
  type: string;
  payload: Record<string, unknown>;
}

/** Hosted UI on Pages talks to the local API started by `pi`. Same-origin when served locally. */
export function apiOrigin(): string {
  if (typeof window === "undefined") return "";
  const fromQuery = new URLSearchParams(window.location.search).get("api");
  if (fromQuery) {
    // Only a local origin may override where the UI sends its API + SSE
    // traffic. A hosted-page link could otherwise redirect every request to
    // an attacker's origin; anything non-local is ignored.
    try {
      const url = new URL(fromQuery);
      const host = url.hostname;
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host === "[::1]"
      ) {
        return fromQuery.replace(/\/$/, "");
      }
    } catch {
      /* malformed; fall through to the default */
    }
  }
  const { hostname } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1") return "";
  return "http://127.0.0.1:4319";
}

export function apiUrl(path: string): string {
  const origin = apiOrigin();
  return origin ? `${origin}${path}` : path;
}

/** Thrown when the server rejects a request with 401 (token required). */
export class AuthError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "AuthError";
  }
}

let authToken: string | null = (() => {
  try {
    return localStorage.getItem("pi-web.token");
  } catch {
    return null;
  }
})();

/** Persist the token the user entered at the auth gate. */
export function setAuthToken(token: string | null): void {
  authToken = token;
  try {
    if (token) localStorage.setItem("pi-web.token", token);
    else localStorage.removeItem("pi-web.token");
  } catch {
    /* storage unavailable; token stays in memory */
  }
}

export function hasAuthToken(): boolean {
  return authToken !== null;
}

async function request<T = unknown>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);
  const res = await fetch(apiUrl(url), { ...init, headers });
  if (res.status === 401) throw new AuthError();
  if (res.status === 413)
    throw new Error("That request was too large for the server.");
  return (await res.json()) as T;
}

async function post<T = unknown>(
  url: string,
  body: unknown,
  timeoutMs?: number,
): Promise<T> {
  return request<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
}

async function get<T = unknown>(url: string): Promise<T> {
  return request<T>(url);
}

async function put<T = unknown>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const api = {
  health: () => get<{ ok: boolean; cwd: string }>("/api/health"),
  catalog: () => get<PiCatalogResponse>("/api/catalog"),
  directories: (path?: string) =>
    get<DirectoryListingResponse>(
      `/api/directories${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),
  workspace: (path: string) =>
    get<WorkspaceListingResponse>(
      `/api/workspace?path=${encodeURIComponent(path)}`,
    ),
  workspaceFile: (path: string) =>
    get<WorkspaceFileResponse>(
      `/api/workspace/file?path=${encodeURIComponent(path)}`,
    ),
  workspaceSave: (path: string, content: string) =>
    put<WorkspaceFileResponse>("/api/workspace/file", { path, content }),
  workspaceRename: (path: string, name: string) =>
    post<{
      ok: boolean;
      path?: string;
      name?: string;
      from?: string;
      error?: string;
    }>("/api/workspace/rename", { path, name }),
  workspaceDelete: (path: string) =>
    post<{ ok: boolean; path?: string; error?: string }>(
      "/api/workspace/delete",
      { path },
    ),
  workspaceCopy: (path: string, destination: string) =>
    post<{ ok: boolean; path?: string; name?: string; error?: string }>(
      "/api/workspace/copy",
      { path, destination },
    ),
  workspaceMove: (path: string, destination: string) =>
    post<{ ok: boolean; path?: string; name?: string; error?: string }>(
      "/api/workspace/move",
      { path, destination },
    ),
  workspaceReveal: (path: string) =>
    post<{ ok: boolean; error?: string }>("/api/workspace/reveal", { path }),
  workspaceOpen: (path: string, app?: string) =>
    post<{ ok: boolean; error?: string }>("/api/workspace/open", { path, app }),
  workspaceTerminal: (path: string) =>
    post<{ ok: boolean; error?: string }>("/api/workspace/terminal", { path }),
  workspaceApps: () =>
    get<{ ok: boolean; apps: { id: string; label: string }[] }>(
      "/api/workspace/apps",
    ),
  sessionLogUrl: (sessionPath: string) =>
    apiUrl(`/api/session-log?path=${encodeURIComponent(sessionPath)}`),
  sessionMessages: (sessionPath: string) =>
    get<{ ok: boolean; messages?: SessionHistoryMessage[]; error?: string }>(
      `/api/session-messages?path=${encodeURIComponent(sessionPath)}`,
    ),
  sessions: (
    view: "recent" | "archived" = "recent",
    backend: AgentBackend = "pi",
  ) => {
    const params = new URLSearchParams({ backend });
    if (view === "archived") params.set("view", "archived");
    return get<{ ok: boolean; sessions: ResumeSession[] }>(
      `/api/sessions?${params}`,
    );
  },
  archiveSession: (sessionPath: string) =>
    post<SessionMutationResponse>("/api/sessions/archive", { sessionPath }),
  restoreSession: (sessionPath: string) =>
    post<SessionMutationResponse>("/api/sessions/restore", { sessionPath }),
  deleteSession: (sessionPath: string) =>
    post<SessionMutationResponse>("/api/sessions/delete", { sessionPath }),
  start: (
    key: string,
    cwd: string,
    backend: AgentBackend = "pi",
    model?: ModelInfo,
    sessionPath?: string,
    thinkingLevel?: string,
    adoptOnly?: boolean,
  ) =>
    post<{
      ok: boolean;
      state?: SessionState;
      messages?: SessionHistoryMessage[];
      error?: string;
    }>(`/api/${key}/start`, {
      cwd,
      backend,
      ...(model ? { model } : {}),
      ...(sessionPath ? { sessionPath } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(adoptOnly ? { adoptOnly: true } : {}),
    }),
  prompt: (
    key: string,
    message: string,
    options?: {
      images?: ImageAttachment[];
      // Session context for lazily-resumed conversations: a session opened
      // for display has no agent process yet, so the first prompt carries
      // what the server needs to start one (grok only today).
      cwd?: string;
      backend?: AgentBackend;
      sessionPath?: string;
      model?: ModelInfo | null;
      thinkingLevel?: string | null;
    },
  ) => {
    const body: Record<string, unknown> = {
      message,
      ...(options?.images ? { images: options.images } : null),
    };
    if (options?.cwd) body.cwd = options.cwd;
    if (options?.backend) body.backend = options.backend;
    if (options?.sessionPath) body.sessionPath = options.sessionPath;
    if (options?.model) body.model = options.model;
    if (options?.thinkingLevel) body.thinkingLevel = options.thinkingLevel;
    return post<{ ok: boolean; error?: string }>(`/api/${key}/prompt`, body);
  },
  steer: (key: string, message: string, images?: ImageAttachment[]) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/steer`, {
      message,
      images,
    }),
  abort: (key: string) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/abort`, {}),
  newSession: (key: string) =>
    post<SessionSnapshotResponse>(`/api/${key}/new-session`, {}),
  resume: (key: string, sessionPath: string) =>
    post<SessionSnapshotResponse>(
      `/api/${key}/resume`,
      { sessionPath },
      30_000,
    ),
  fork: (key: string, timestamp: number) =>
    post<SessionSnapshotResponse>(`/api/${key}/fork`, { timestamp }),
  truncate: (key: string, userTimestamp: number, sessionPath?: string) =>
    post<SessionSnapshotResponse>(
      `/api/${key}/truncate`,
      { userTimestamp, sessionPath },
      30_000,
    ),
  goal: (key: string, text: string) =>
    post<{ ok: boolean; text?: string; cleared?: boolean; error?: string }>(
      `/api/${key}/goal`,
      { text },
    ),
  gitRun: (key: string, cwd: string, op: "push" | "pull") =>
    post<{ ok: boolean; output?: string; error?: string }>(
      `/api/${key}/git`,
      { cwd, op },
      120_000,
    ),
  gitChanges: (key: string, cwd: string) =>
    get<GitChangesResponse>(
      `/api/${key}/git-changes?cwd=${encodeURIComponent(cwd)}`,
    ),
  gitFileDiff: (key: string, cwd: string, file: string) =>
    get<{ ok: boolean; diff?: string; error?: string }>(
      `/api/${key}/git-changes?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}`,
    ),
  gitCommitPush: (key: string, cwd: string, message: string) =>
    post<{ ok: boolean; output?: string; error?: string }>(
      `/api/${key}/git`,
      { cwd, op: "commit-push", message },
      120_000,
    ),
  compact: (key: string, customInstructions?: string) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/compact`, {
      customInstructions,
    }),
  setModel: (key: string, provider: string, modelId: string) =>
    post<{
      ok: boolean;
      data?: ModelInfo;
      state?: SessionState;
      error?: string;
    }>(`/api/${key}/set-model`, { provider, modelId }),
  setThinking: (key: string, level: string) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/set-thinking`, {
      level,
    }),
  stop: (key: string) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/stop`, {}),
  configure: (
    key: string,
    cwd: string,
    accessMode: "workspace-write" | "read-only",
    agentMode: "standard" | "plan",
    model?: ModelInfo | null,
    thinkingLevel?: string,
    sessionPath?: string,
    backend: AgentBackend = "pi",
  ) =>
    post<SessionSnapshotResponse>(`/api/${key}/configure`, {
      cwd,
      backend,
      accessMode,
      agentMode,
      model,
      thinkingLevel,
      sessionPath,
    }),
  upload: (key: string, name: string, mimeType: string, data: string) =>
    post<{ ok: boolean; path?: string; error?: string }>(`/api/${key}/upload`, {
      name,
      mimeType,
      data,
    }),
  commands: (key: string, backend?: AgentBackend) =>
    get<{ ok: boolean; commands: SlashCommand[] }>(
      `/api/${key}/commands${backend ? `?backend=${backend}` : ""}`,
    ),
  models: (key: string, backend?: AgentBackend) =>
    get<{ ok: boolean; models: ModelInfo[] }>(
      `/api/${key}/models${backend ? `?backend=${backend}` : ""}`,
    ),
  thinkingLevels: (key: string, backend?: AgentBackend) =>
    get<{ ok: boolean; levels: string[] }>(
      `/api/${key}/thinking-levels${backend ? `?backend=${backend}` : ""}`,
    ),
  usage: (key: string, backend?: AgentBackend, refresh = false) => {
    const params = new URLSearchParams();
    if (backend) params.set("backend", backend);
    if (refresh) params.set("refresh", "1");
    const query = params.size > 0 ? `?${params}` : "";
    return get<{ ok: boolean; usage: ProviderUsage; error?: string }>(
      `/api/${key}/usage${query}`,
    );
  },
  backendLog: (key: string) =>
    get<{ ok: boolean; entries: BackendLogEntry[]; error?: string }>(
      `/api/${key}/log`,
    ),
  /** Exchange the token for a session cookie + one-time SSE/WS ticket. */
  auth: (token: string) =>
    post<{ ok: boolean; enabled?: boolean; ticket?: string }>("/api/auth", {
      token,
    }),
  authStatus: () => get<{ ok: boolean }>("/api/auth/status"),
  /** Renew the server-side lease for the given conversation keys. */
  heartbeat: (keys: string[]) =>
    post<{ ok: boolean }>("/api/heartbeat", { keys }),
};

/**
 * Subscribe to the server event fan-out.
 *
 * EventSource cannot send Authorization headers, so with a token configured
 * the connection authenticates via the HttpOnly cookie (same-origin) or a
 * one-time ticket in the URL (cross-origin). Tickets are single-use, so on a
 * connection error the stream is re-created with a freshly minted ticket
 * instead of relying on EventSource's auto-reconnect (which would replay the
 * consumed URL and 401 forever).
 */
export function subscribeEvents(
  onEvent: (event: AgentEvent) => void,
): () => void {
  let source: EventSource | null = null;
  let closed = false;
  let retryTimer: number | undefined;

  const connect = async () => {
    if (closed) return;
    let url = apiUrl("/api/events");
    if (authToken) {
      try {
        const result = await api.auth(authToken);
        if (result.ok && result.ticket) {
          url = `${url}?ticket=${encodeURIComponent(result.ticket)}`;
        }
      } catch {
        /* cookie may already authenticate; fall through */
      }
    }
    source = new EventSource(url);
    source.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data) as AgentEvent);
      } catch {
        /* ignore malformed */
      }
    };
    source.onerror = () => {
      source?.close();
      retryTimer = window.setTimeout(() => {
        void connect();
      }, 2000);
    };
  };

  void connect();
  return () => {
    closed = true;
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    source?.close();
  };
}
