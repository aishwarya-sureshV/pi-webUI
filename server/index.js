/**
 * pi-web server: static file serving (production build), JSON command API,
 * and a Server-Sent Events stream that fans out pi RPC events to the browser.
 *
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/sessions?view=archived       -> persisted ~/.pi sessions
 *   POST /api/sessions/archive             { sessionPath }
 *   POST /api/sessions/restore             { sessionPath }
 *   POST /api/sessions/delete              { sessionPath }
 *   GET  /api/workspace?path=              -> files + folders in a project directory
 *   GET  /api/workspace/file?path=         -> text contents of a source file
 *   PUT  /api/workspace/file               { path, content }
 *   POST /api/workspace/rename|delete|copy|move|reveal|open
 *   GET  /api/events                       -> SSE stream of all agent events
 *   POST /api/:sessionKey/start            { cwd }
 *   POST /api/:sessionKey/prompt           { message }
 *   POST /api/:sessionKey/steer            { message }
 *   POST /api/:sessionKey/abort
 *   POST /api/:sessionKey/stop
 *   GET  /api/:sessionKey/log
 *   POST /api/:sessionKey/new-session
 *   POST /api/:sessionKey/fork              { timestamp }
 *   POST /api/:sessionKey/compact          { customInstructions? }
 *   POST /api/:sessionKey/set-model        { provider, modelId }
 *   POST /api/:sessionKey/set-thinking     { level }
 *   GET  /api/:sessionKey/git-changes?cwd=  -> branch, remote, per-file working-tree changes
 *   GET  /api/:sessionKey/git-changes?cwd=&file= -> one file's diff vs HEAD
 *   POST /api/:sessionKey/git              { cwd, op } where op is one of
 *                                          push|pull|pull-rebase|fetch|commit|
 *                                          commit-push|stash|stash-apply|
 *                                          stash-pop|stash-drop|branch-create|
 *                                          branch-switch|undo-commit|continue|
 *                                          abort
 *   GET  /api/:sessionKey/commands
 *   GET  /api/:sessionKey/models
 *   GET  /api/:sessionKey/thinking-levels
 */
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open as openFile,
  readdir,
  readlink,
  rename,
  rm,
  cp,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawn, execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import { PiAgentPool, generateSessionTitle } from "./pi-agent.js";
import { ClaudeAgentPool } from "./claude-agent.js";
import { GrokAgentPool } from "./grok-agent.js";
import {
  archiveSession,
  deleteSession,
  listSessions,
  searchSessions,
  loadSessionLog,
  readSessionMessages,
  restoreSession,
} from "./sessions.js";
import { deleteSkill, loadCatalog, readSkill, writeSkill } from "./catalog.js";
import { listOllamaModels, syncOllamaModelsJson } from "./ollama-models.js";
import { confinePath, defaultWorkspaceRoots } from "./workspace-paths.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");
const PORT = Number(process.env.PI_WEB_PORT || 4319);
const HOST = process.env.PI_WEB_HOST || "127.0.0.1";
const ACCESS_TOKEN = String(process.env.PI_WEB_TOKEN || "").trim();
const execFileAsync = promisify(execFile);

/**
 * Workspace roots for the file-explorer endpoints. Starts from the launch
 * directory plus PI_WEB_WORKSPACE_ROOTS; session cwds are added as agents
 * start so saved sessions from other projects stay browsable. Mutations
 * (write/rename/delete/copy/move) and external-app actions are confined to
 * these roots; read-only browsing is confined to the user's home directory.
 */
const workspaceRoots = new Set(defaultWorkspaceRoots());

function addWorkspaceRoot(path) {
  if (typeof path === "string" && path.trim())
    workspaceRoots.add(resolve(path));
}

/** Directories never worth walking for a file picker. */
const SEARCH_SKIP = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "graphify-out",
  // Git worktrees hold a second copy of the whole repo; every file would
  // otherwise show up twice in the picker.
  "worktrees",
]);
const SEARCH_MAX_MATCHES = 40;
const SEARCH_MAX_VISITS = 20000;

/**
 * Breadth-first walk of a workspace root, returning paths that match `query`.
 * Breadth-first so shallow files — the ones a person is most likely to mean —
 * are found before deep ones, and both the match count and the total number of
 * entries visited are capped so a huge tree cannot stall the request.
 */
async function searchWorkspaceFiles(root, query) {
  const matches = [];
  const queue = [root];
  let visits = 0;
  while (queue.length > 0 && matches.length < SEARCH_MAX_MATCHES) {
    const dir = queue.shift();
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory; keep going
    }
    for (const entry of entries) {
      if (++visits > SEARCH_MAX_VISITS)
        return rankSearchMatches(matches, query);
      if (entry.name.startsWith(".") && entry.name !== ".claude") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SEARCH_SKIP.has(entry.name)) queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(root, full);
      if (query && !relativePath.toLowerCase().includes(query)) continue;
      matches.push({ path: full, relativePath, name: entry.name });
      if (matches.length >= SEARCH_MAX_MATCHES) break;
    }
  }
  return rankSearchMatches(matches, query);
}

/** Basename hits first, then shallower paths, then alphabetical. */
function rankSearchMatches(matches, query) {
  return matches
    .map((match) => ({
      ...match,
      score:
        (query && match.name.toLowerCase().startsWith(query) ? 0 : 2) +
        (query && match.name.toLowerCase().includes(query) ? 0 : 1),
      depth: match.relativePath.split("/").length,
    }))
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.depth - right.depth ||
        left.relativePath.localeCompare(right.relativePath),
    )
    .slice(0, SEARCH_MAX_MATCHES)
    .map(({ path, relativePath, name }) => ({ path, relativePath, name }));
}

/**
 * Split one file's unified diff into its header and its hunks. A patch that
 * applies only hunk N is the header plus that hunk and nothing else — which is
 * what makes reverting a single hunk possible without touching the others.
 */
function splitDiffHunks(diff) {
  const lines = String(diff ?? "").split("\n");
  const header = [];
  const hunks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current) hunks.push(current);
      current = { header: line, lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
    else header.push(line);
  }
  if (current) hunks.push(current);
  return { header, hunks };
}

function confineWorkspacePath(requested) {
  return confinePath(requested, [...workspaceRoots]);
}

function confineHomePath(requested) {
  return confinePath(requested, [...workspaceRoots, homedir()]);
}

/**
 * One-time auth tickets for browser transports that cannot send headers or
 * cookies (cross-origin EventSource, WebSocket). Minted by /api/auth after a
 * successful token check; consumed by the first request that presents them.
 * Short-lived and single-use, so a ticket that leaks into a log line is
 * worthless to a replay attacker.
 */
const AUTH_TICKETS = new Map();
const AUTH_TICKET_TTL_MS = 30_000;

function mintAuthTicket() {
  const ticket = randomUUID();
  AUTH_TICKETS.set(ticket, Date.now() + AUTH_TICKET_TTL_MS);
  return ticket;
}

function consumeAuthTicket(ticket) {
  if (typeof ticket !== "string" || !ticket) return false;
  const expiresAt = AUTH_TICKETS.get(ticket);
  if (!expiresAt) return false;
  AUTH_TICKETS.delete(ticket);
  return Date.now() < expiresAt;
}

function pruneAuthTickets() {
  const now = Date.now();
  for (const [ticket, expiresAt] of AUTH_TICKETS) {
    if (expiresAt < now) AUTH_TICKETS.delete(ticket);
  }
}

/**
 * Session leases: a page heartbeats the keys of its open conversations and
 * the sweep stops agents whose page went away (tab closed, browser quit).
 * This is the single owner of process lifetime across page refreshes — the
 * old pagehide beacon raced adoptLiveAgent and killed the very process a
 * refresh was supposed to rebind. With leases, a refresh never stops the
 * agent: the new page's /start adopts the live process, and only a page that
 * stops heartbeating (a real close) lets the sweep reap it.
 */
const SESSION_LEASES = new Map();
const LEASE_TIMEOUT_MS = 5 * 60_000;
const LEASE_SWEEP_MS = 60_000;

function renewLease(sessionKey) {
  SESSION_LEASES.set(sessionKey, Date.now());
}

function sweepExpiredLeases() {
  const now = Date.now();
  for (const [key, lastHeartbeat] of SESSION_LEASES) {
    if (now - lastHeartbeat <= LEASE_TIMEOUT_MS) continue;
    SESSION_LEASES.delete(key);
    const backend = sessionBackends.get(key);
    if (!backend) continue;
    poolFor(backend).stop(key);
    sessionBackends.delete(key);
    clearSessionGoal(key);
  }
  for (const key of [...SESSION_LEASES.keys()]) {
    if (!sessionBackends.has(key)) SESSION_LEASES.delete(key);
  }
}

setInterval(sweepExpiredLeases, LEASE_SWEEP_MS).unref();
setInterval(pruneAuthTickets, 60_000).unref();

/**
 * Standing goals (/goal): the agent gets a deterministic follow-up check-in
 * when idle — after 30 minutes, then 1h, then every 2h — so a long task does
 * not silently stall. In-memory per session key; /goal off clears it.
 */
const CONVERSATION_GOALS = new Map();
const GOAL_CHECKIN_DELAYS_MS = [30, 60, 120].map((minutes) => minutes * 60_000);

function clearSessionGoal(sessionKey) {
  const goal = CONVERSATION_GOALS.get(sessionKey);
  if (goal?.timer) clearTimeout(goal.timer);
  CONVERSATION_GOALS.delete(sessionKey);
}

function scheduleGoalCheckIn(sessionKey) {
  const goal = CONVERSATION_GOALS.get(sessionKey);
  if (!goal) return;
  const delay =
    GOAL_CHECKIN_DELAYS_MS[
      Math.min(goal.checkIns, GOAL_CHECKIN_DELAYS_MS.length - 1)
    ];
  goal.timer = setTimeout(() => {
    if (!CONVERSATION_GOALS.has(sessionKey)) return;
    const backend = sessionBackends.get(sessionKey);
    const agent = backend ? poolFor(backend).get(sessionKey) : undefined;
    if (!agent || agent.status === "stopped" || agent.status === "error") {
      CONVERSATION_GOALS.delete(sessionKey);
      return;
    }
    if (agent.status === "ready") {
      goal.checkIns += 1;
      void agent
        .followUp(
          `Goal check-in ("${goal.text}"): report progress in one line. If the goal is fully achieved, reply with exactly "GOAL DONE" plus one line of proof; otherwise continue working on it now.`,
        )
        .catch(() => {
          /* re-armed below; the next check-in retries */
        });
    }
    scheduleGoalCheckIn(sessionKey);
  }, delay);
  goal.timer.unref?.();
}

function setSessionGoal(sessionKey, text) {
  if (!text || /^off$/i.test(text)) {
    clearSessionGoal(sessionKey);
    return { ok: true, cleared: true };
  }
  clearSessionGoal(sessionKey);
  CONVERSATION_GOALS.set(sessionKey, { text, checkIns: 0 });
  scheduleGoalCheckIn(sessionKey);
  return { ok: true, text };
}
const BUILD_ID = existsSync(join(DIST, "index.html"))
  ? createHash("sha256")
      .update(readFileSync(join(DIST, "index.html")))
      .digest("hex")
      .slice(0, 12)
  : "dev";

/**
 * One-click deploy (the Deploy button in the conversation header).
 *
 * The server never rebuilds itself: POST /api/deploy spawns scripts/deploy.mjs
 * as a detached process and answers immediately. The deployer (git pull in
 * cloud mode -> npm run build) reports progress only through this state file,
 * then SIGTERMs this process so the supervisor restarts it with fresh code.
 */
const BOOT_MS = Date.now();
const DEPLOY_STATE_PATH = join(ROOT, ".pi-web-deploy.json");
const DEPLOY_MODE =
  process.env.PI_WEB_DEPLOY_MODE === "cloud" ? "cloud" : "local";

function readDeployState() {
  try {
    return JSON.parse(readFileSync(DEPLOY_STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeDeployState(patch) {
  const base = readDeployState() || {};
  try {
    writeFileSync(
      DEPLOY_STATE_PATH,
      JSON.stringify({ ...base, ...patch }, null, 2),
    );
  } catch {
    // Best-effort status reporting; a missing state file just means the UI
    // shows "never deployed".
  }
}

function currentGitHead() {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * Content signature of the whole working tree: HEAD + status + diff, hashed.
 * The deployer stores this at deploy time, so /api/deploy/status can answer
 * "does the working tree differ from what is running?" — including uncommitted
 * edits, which HEAD alone can't see.
 */
function workingTreeSignature() {
  try {
    const out = execSync(
      "git rev-parse HEAD && git status --porcelain && git diff HEAD",
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return createHash("sha256").update(out).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

function uncommittedFileCount() {
  try {
    const out = execSync("git status --porcelain", {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
      .toString()
      .trim();
    return out ? out.split("\n").length : 0;
  } catch {
    return null;
  }
}

const piPool = new PiAgentPool();
const claudePool = new ClaudeAgentPool();
const grokPool = new GrokAgentPool();
/** @type {Map<string, 'pi' | 'claude'>} */
const sessionBackends = new Map();
/** @type {Set<import('node:http').ServerResponse>} */
const sseClients = new Set();
/** @type {Map<string, Array<{ id: string, timestamp: number, source: string, type: string, payload: object }>>} */
const runtimeLogs = new Map();
const MAX_RUNTIME_LOG_ENTRIES = 25_000;
const MAX_RUNTIME_LOG_TOTAL = 100_000;
let runtimeLogTotal = 0;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {
      /* dropped */
    }
  }
}

// Heartbeat so a client can tell an idle stream from a half-open socket
// (sleep/wake, a proxy dropping the connection without a reset) and reconnect
// when the beats stop. Carries no sessionKey, so the UI ignores it.
setInterval(() => broadcast({ type: "__ping" }), 10_000).unref();

function logPayload(event) {
  if (event && typeof event === "object" && !Array.isArray(event)) return event;
  return { value: event };
}

function recordRuntimeEvent(sessionKey, source, event) {
  const entry = {
    id: randomUUID(),
    timestamp: Date.now(),
    source,
    type: String(event?.type ?? "unknown"),
    payload: logPayload(event),
  };
  const entries = runtimeLogs.get(sessionKey) ?? [];
  entries.push(entry);
  if (entries.length > MAX_RUNTIME_LOG_ENTRIES)
    entries.splice(0, entries.length - MAX_RUNTIME_LOG_ENTRIES);
  runtimeLogs.set(sessionKey, entries);
  runtimeLogTotal += 1;
  // Hard global bound: many session keys must not grow memory without limit.
  while (runtimeLogTotal > MAX_RUNTIME_LOG_TOTAL) {
    let largestKey;
    let largest = 0;
    for (const [key, log] of runtimeLogs) {
      if (log.length > largest) {
        largest = log.length;
        largestKey = key;
      }
    }
    if (!largestKey) break;
    const log = runtimeLogs.get(largestKey);
    const drop = Math.max(1, Math.ceil(log.length / 2));
    log.splice(0, drop);
    runtimeLogTotal -= drop;
    if (log.length === 0) runtimeLogs.delete(largestKey);
  }
  return entry;
}

function publishRuntimeEvent(sessionKey, source, event) {
  const entry = recordRuntimeEvent(sessionKey, source, event);
  broadcast({
    ...event,
    sessionKey,
    __logId: entry.id,
    __loggedAt: entry.timestamp,
    __logSource: source,
  });
  return entry;
}

function commandMetadata(body) {
  const metadata = {};
  if (body && typeof body.cwd === "string") metadata.cwd = body.cwd;
  if (body && typeof body.backend === "string")
    metadata.backend = backendName(body.backend);
  if (body && typeof body.message === "string") metadata.message = body.message;
  if (body?.model && typeof body.model === "object") {
    metadata.model = {
      provider: body.model.provider,
      id: body.model.id,
    };
  }
  if (body && Array.isArray(body.images)) {
    metadata.images = body.images.map((image) => ({
      type: image?.type,
      mimeType: image?.mimeType,
      attached: Boolean(image?.data),
    }));
  }
  return metadata;
}

async function runLoggedCommand(sessionKey, action, body, run) {
  const requestId = randomUUID();
  publishRuntimeEvent(sessionKey, "server", {
    type: "backend_request",
    requestId,
    action,
    payload: commandMetadata(body),
  });
  let result;
  try {
    result = await run();
  } catch (error) {
    result = { ok: false, error: String(error?.message ?? error) };
  }
  publishRuntimeEvent(sessionKey, "server", {
    type: "backend_response",
    requestId,
    action,
    ok: Boolean(result?.ok),
    ...(result?.error ? { error: result.error } : {}),
    ...(result?.data === undefined ? {} : { data: result.data }),
    ...(result?.state === undefined ? {} : { state: result.state }),
    ...(Array.isArray(result?.messages)
      ? { messageCount: result.messages.length }
      : {}),
  });
  return result;
}

// Fan every pool event out to all SSE clients (events carry their sessionKey).
function backendName(value) {
  if (value === "claude") return "claude";
  if (value === "grok") return "grok";
  return "pi";
}

// This was previously sent to the active model as ordinary text when it was
// entered in the composer. It is a display-only shortcut, though: forwarding
// it starts an unnecessary agent turn (and a stale client can keep doing so).
function isUsageShortcut(message, images) {
  return (
    !images?.length &&
    /^\/(?:grok-cli-usage|grok-usage)$/i.test(String(message ?? "").trim())
  );
}

function poolFor(backend) {
  if (backend === "claude") return claudePool;
  if (backend === "grok") return grokPool;
  return piPool;
}

/**
 * Claude-style session titles for Pi sessions: after the first prompt, a
 * short-lived ephemeral pi process summarizes it into a concise title, which
 * is persisted via set_session_name (a session_info entry the sidebar already
 * reads). Best-effort and fire-and-forget — failures leave the prompt-derived
 * fallback in place.
 */
const piTitleInFlight = new Set();

/**
 * Resolves when the agent's current turn ends. The listener is attached by the
 * caller *before* any await, so a turn that settles while the title is being
 * generated is never missed. `agent.status` is not a reliable idle check right
 * after a prompt is dispatched (the RPC acks before agent_start arrives), so
 * an early exit is only taken on a state read that says the agent is idle.
 */
function whenTurnSettles(agent, isSettled, waiters) {
  if (isSettled()) return Promise.resolve();
  return new Promise((resolve) => {
    // unref'd: a pending title write must never hold the server open.
    const timer = setTimeout(resolve, 20 * 60_000);
    timer.unref?.();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    waiters.add(done);
    void agent
      .getState()
      .then((state) => {
        if (!state?.isStreaming) {
          waiters.delete(done);
          done();
        }
      })
      .catch(() => {});
  });
}

/**
 * Two separate steps, because they have opposite timing needs:
 *
 *  - Generating the title is a bare, ephemeral pi process that never touches
 *    the live agent, so it runs immediately and the UI is relabelled the
 *    moment it lands (a couple of seconds), while the turn keeps streaming.
 *  - Persisting it is a set_session_name RPC *on the live process*. Issuing
 *    that mid-stream raced the running turn (it could stop sibling sessions
 *    or leave the new one stuck "thinking"), so the write waits for the turn
 *    to settle.
 */
function maybeGeneratePiTitle(sessionKey, agent, message) {
  if (piTitleInFlight.has(sessionKey)) return;
  piTitleInFlight.add(sessionKey);
  let settled = false;
  const waiters = new Set();
  // Attached synchronously: a turn that ends during generation still counts.
  const off = agent.onEvent((event) => {
    if (event.type !== "agent_settled") return;
    settled = true;
    for (const resolve of waiters) resolve();
    waiters.clear();
  });
  void (async () => {
    try {
      // Always read fresh state: lastState is not updated by set_session_name,
      // so a second prompt would otherwise regenerate (and overwrite) the title.
      const state = await agent.getState();
      if (state?.sessionName) return;
      const title = await generateSessionTitle(message, state?.model);
      if (!title) return;
      // Publish first: the label updates in the background, independently of
      // when (or whether) the write to the session file succeeds.
      publishRuntimeEvent(sessionKey, "pi", {
        type: "session_title_set",
        title,
      });
      await whenTurnSettles(agent, () => settled, waiters);
      await agent.setSessionName(title);
    } catch {
      /* title generation is best-effort */
    } finally {
      off();
      waiters.clear();
      piTitleInFlight.delete(sessionKey);
    }
  })();
}

/**
 * A page refresh re-opens saved sessions under fresh tab keys. If a process
 * is already live for the same session file, rebind it to the new key
 * instead of spawning a duplicate — otherwise the original run keeps
 * streaming invisibly in the background and both processes append to the
 * same session file. Returns the adopted agent, if any.
 */
function adoptLiveAgent(sessionKey, backend, sessionPath) {
  if (!sessionPath) return undefined;
  const pool = poolFor(backendName(backend));
  for (const [key, candidate] of pool.agents) {
    if (key === sessionKey) continue;
    if (!candidate.process) continue;
    const candidateFile =
      candidate.sessionFile ?? candidate.lastState?.sessionFile;
    if (candidateFile !== sessionPath) continue;
    if (candidate.status === "stopped" || candidate.status === "error")
      continue;
    pool.agents.delete(key);
    pool.agents.set(sessionKey, candidate);
    candidate.sessionKey = sessionKey;
    sessionBackends.delete(key);
    // The lease belongs to the conversation, not the tab: carry it to the
    // adopting key so the sweep does not reap a freshly refreshed session.
    const lease = SESSION_LEASES.get(key);
    if (lease) {
      SESSION_LEASES.delete(key);
      SESSION_LEASES.set(sessionKey, lease);
    }
    // The runtime event log belongs to the conversation too — carry it over
    // so /api/<newKey>/log includes the in-flight turn's pre-reload events
    // (needed to replay the live run after a page refresh). Entry counts
    // move, they are not duplicated, so the global budget is unchanged.
    const previousLog = runtimeLogs.get(key);
    if (previousLog && previousLog.length > 0) {
      runtimeLogs.delete(key);
      const currentLog = runtimeLogs.get(sessionKey) ?? [];
      runtimeLogs.set(
        sessionKey,
        [...previousLog, ...currentLog].sort(
          (left, right) => left.timestamp - right.timestamp,
        ),
      );
    }
    // A parked goal belongs to the conversation, not the browser tab.
    const goal = CONVERSATION_GOALS.get(key);
    if (goal) {
      clearSessionGoal(key);
      CONVERSATION_GOALS.set(sessionKey, goal);
      scheduleGoalCheckIn(sessionKey);
    }
    return candidate;
  }
  return undefined;
}

function watch(sessionKey, requestedBackend) {
  const backend =
    requestedBackend === undefined
      ? (sessionBackends.get(sessionKey) ?? "pi")
      : backendName(requestedBackend);
  sessionBackends.set(sessionKey, backend);
  const agent = poolFor(backend).get(sessionKey);
  // Rebind rather than register once: adoptLiveAgent moves a running process
  // to the refreshed page's key, and a listener still closed over the old key
  // published the whole in-flight turn under a key no client is listening on
  // — the reloaded page sat frozen on its restored snapshot until the turn
  // ended. Re-registering keeps exactly one publisher, on the current key.
  if (agent.__watchedKey !== sessionKey || agent.__watchedBackend !== backend) {
    agent.__unwatch?.();
    agent.__watchedKey = sessionKey;
    agent.__watchedBackend = backend;
    agent.__unwatch = agent.onEvent((event) =>
      publishRuntimeEvent(sessionKey, backend, event),
    );
  }
  return agent;
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname;
    // Exact hosts only. Public signup namespaces like *.pages.dev / *.workers.dev
    // are attacker-ownable and must never be trusted by suffix match.
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]"
    )
      return true;
    return origin === process.env.PI_WEB_UI_ORIGIN;
  } catch {
    return false;
  }
}

function corsHeaders(req) {
  const origin = String(req.headers.origin || "");
  if (!isAllowedOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    // Only granted to allowlisted origins (the legit hosted UI). This is what
    // lets Chrome's Private Network Access gate public->localhost requests:
    // an attacker's page gets no CORS headers at all, so the browser blocks it.
    "Access-Control-Allow-Private-Network": "true",
    Vary: "Origin",
  };
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    ...corsHeaders(res.req || { headers: {} }),
  });
  res.end(data);
}

async function readBody(req) {
  let text = "";
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new BodyTooLargeError();
    text += chunk;
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large.");
    this.statusCode = 413;
  }
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;

function serveStatic(res, pathname) {
  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const abs = join(DIST, filePath);
  // Trailing-separator check: a sibling "dist-anything" directory must not be
  // served as if it were the build output.
  if (
    !abs.startsWith(DIST + sep) ||
    !existsSync(abs) ||
    !statSync(abs).isFile()
  ) {
    // SPA fallback
    const index = join(DIST, "index.html");
    if (existsSync(index)) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
        Pragma: "no-cache",
      });
      res.end(readFileSyncSafe(index));
      return;
    }
    res.writeHead(404);
    res.end("Not found (run npm run build)");
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[extname(abs)] ?? "application/octet-stream",
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
  });
  res.end(readFileSyncSafe(abs));
}

function readFileSyncSafe(p) {
  try {
    return readFileSync(p);
  } catch {
    return "";
  }
}

// Git operations the UI is allowed to run. Anything outside this set falls
// back to `push`; anything user-typed (branch name, stash ref, file paths) is
// pattern-validated before it reaches argv.
const GIT_WRITE_OPS = new Set([
  "push",
  "pull",
  "pull-rebase",
  "fetch",
  "commit",
  "commit-push",
  "stash",
  "stash-apply",
  "stash-pop",
  "stash-drop",
  "branch-create",
  "branch-switch",
  "undo-commit",
  "continue",
  "abort",
]);

/**
 * Which half-finished operation the repo is sitting in. git records these as
 * marker files in the git dir; until one is concluded, an ordinary commit
 * would bake the working tree (conflict markers included) into history.
 */
function gitStateFromDir(gitDir) {
  const marker = (name) => Boolean(gitDir) && existsSync(join(gitDir, name));
  if (marker("MERGE_HEAD")) return "merging";
  if (marker("rebase-merge") || marker("rebase-apply")) return "rebasing";
  if (marker("CHERRY_PICK_HEAD")) return "cherry-picking";
  if (marker("REVERT_HEAD")) return "reverting";
  return "clean";
}

async function gitProgressState(dir) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", dir, "rev-parse", "--absolute-git-dir"],
      { timeout: 10_000 },
    );
    return gitStateFromDir(String(stdout).trim());
  } catch {
    return "clean";
  }
}

/** git check-ref-format's rules, tightened: no globs, no leading dash. */
function isSafeBranchName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 200 &&
    /^[A-Za-z0-9._/+-]+$/.test(name) &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock") &&
    !name.includes("..") &&
    !name.includes("//")
  );
}

const MAX_WORKSPACE_FILE_BYTES = 1_048_576;
const MAX_WORKSPACE_WRITE_BYTES = 2_097_152;
const MAX_WORKSPACE_ENTRIES = 2_000;
const HEAVY_WORKSPACE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "DerivedData",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".turbo",
  ".cache",
  "Pods",
]);
const HEAVY_WORKSPACE_ENTRIES = 80;
const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "bmp",
  "psd",
  "ai",
  "pdf",
  "zip",
  "gz",
  "tgz",
  "tar",
  "bz2",
  "7z",
  "rar",
  "xz",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "mp4",
  "mov",
  "webm",
  "wav",
  "ogg",
  "flac",
  "m4a",
  "avi",
  "mkv",
  "dmg",
  "pkg",
  "exe",
  "dll",
  "so",
  "dylib",
  "class",
  "jar",
  "wasm",
  "bin",
  "dat",
  "o",
  "a",
  "pyc",
  "pyo",
]);

function workspaceIoError(error, kind) {
  const code = error?.code;
  if (code === "ENOENT")
    return kind === "file"
      ? "That file does not exist."
      : "That directory does not exist.";
  if (code === "EACCES")
    return kind === "file"
      ? "Pi cannot read that file."
      : "Pi cannot read that directory.";
  if (code === "EISDIR") return "That path is a directory.";
  return String(error?.message ?? error);
}

async function listWorkspace(requested) {
  const path = resolve(requested);
  const info = await stat(path);
  if (!info.isDirectory())
    return { ok: false, error: "That path is not a directory." };
  const dirents = await readdir(path, { withFileTypes: true });
  const heavy = HEAVY_WORKSPACE_DIRS.has(basename(path));
  const limit = heavy ? HEAVY_WORKSPACE_ENTRIES : MAX_WORKSPACE_ENTRIES;
  const entries = [];
  for (const entry of dirents) {
    if (entries.length >= limit) break;
    let type = entry.isDirectory()
      ? "directory"
      : entry.isFile()
        ? "file"
        : null;
    if (!type && entry.isSymbolicLink()) {
      try {
        const target = await stat(join(path, entry.name));
        type = target.isDirectory()
          ? "directory"
          : target.isFile()
            ? "file"
            : null;
      } catch {
        continue;
      }
    }
    if (!type) continue;
    entries.push({
      name: entry.name,
      path: join(path, entry.name),
      type,
      hidden: entry.name.startsWith("."),
    });
  }
  entries.sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
    });
  });
  return {
    ok: true,
    path,
    parent: path === dirname(path) ? null : dirname(path),
    truncated: dirents.length > entries.length,
    entries,
  };
}

async function readWorkspaceFile(requested) {
  const path = resolve(requested);
  const info = await stat(path);
  if (info.isDirectory())
    return { ok: false, error: "That path is a directory." };
  if (!info.isFile()) return { ok: false, error: "That path is not a file." };
  const name = basename(path);
  const extension = extname(path).slice(1).toLowerCase();
  if (BINARY_EXTENSIONS.has(extension)) {
    return { ok: true, path, name, binary: true, size: info.size };
  }
  const file = await openFile(path, "r");
  try {
    const length = Math.min(info.size, MAX_WORKSPACE_FILE_BYTES);
    const buffer = Buffer.alloc(Number(length));
    const { bytesRead } = await file.read(buffer, 0, Number(length), 0);
    const slice = buffer.subarray(0, bytesRead);
    if (slice.includes(0))
      return { ok: true, path, name, binary: true, size: info.size };
    return {
      ok: true,
      path,
      name,
      content: slice.toString("utf8"),
      size: info.size,
      truncated: info.size > bytesRead,
    };
  } finally {
    await file.close();
  }
}

function uniqueDestination(directory, name) {
  const dest = join(directory, name);
  if (!existsSync(dest)) return dest;
  const extension = extname(name);
  const stem = basename(name, extension);
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = join(directory, `${stem} ${index}${extension}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(directory, `${stem}-${Date.now()}${extension}`);
}

async function writeWorkspaceFile(requested, content) {
  const path = resolve(requested);
  if (typeof content !== "string")
    return { ok: false, error: "Missing file contents." };
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_WORKSPACE_WRITE_BYTES)
    return { ok: false, error: "That file is too large to save here." };
  if (existsSync(path)) {
    const info = await stat(path);
    if (info.isDirectory())
      return { ok: false, error: "That path is a directory." };
  } else {
    await mkdir(dirname(path), { recursive: true });
  }
  await writeFile(path, content, "utf8");
  return { ok: true, path, name: basename(path), size: bytes };
}

async function renameWorkspacePath(requested, nextName) {
  const path = resolve(requested);
  const name = String(nextName ?? "").trim();
  if (
    !name ||
    name.includes("/") ||
    name.includes("\\") ||
    name === "." ||
    name === ".."
  ) {
    return { ok: false, error: "Enter a valid name." };
  }
  const to = join(dirname(path), name);
  if (to === path) return { ok: true, path, name };
  if (existsSync(to))
    return { ok: false, error: "Something already has that name." };
  await rename(path, to);
  return { ok: true, path: to, name, from: path };
}

async function deleteWorkspacePath(requested) {
  const path = resolve(requested);
  if (path === "/" || path === homedir() || [...workspaceRoots].includes(path))
    return { ok: false, error: "That path cannot be deleted." };
  await rm(path, { recursive: true, force: false });
  return { ok: true, path };
}

async function transferWorkspacePath(requested, destinationDir, mode) {
  const path = resolve(requested);
  const directory = resolve(destinationDir);
  const info = await stat(directory);
  if (!info.isDirectory())
    return { ok: false, error: "That destination is not a folder." };
  if (directory === path || directory.startsWith(`${path}/`)) {
    return { ok: false, error: "Cannot move a folder into itself." };
  }
  const to = uniqueDestination(directory, basename(path));
  if (mode === "move") await rename(path, to);
  else await cp(path, to, { recursive: true });
  return { ok: true, path: to, name: basename(to), from: path };
}

const MAC_APPS = [
  { id: "Visual Studio Code", label: "Visual Studio Code" },
  { id: "Cursor", label: "Cursor" },
  { id: "Zed", label: "Zed" },
  { id: "TextEdit", label: "TextEdit" },
  { id: "Sublime Text", label: "Sublime Text" },
  { id: "iTerm", label: "iTerm" },
];

function listWorkspaceApps() {
  if (process.platform !== "darwin")
    return [{ id: "default", label: "Default App" }];
  return [
    { id: "default", label: "Default App" },
    ...MAC_APPS.filter((app) => existsSync(`/Applications/${app.id}.app`)),
  ];
}

async function revealWorkspacePath(requested) {
  const path = resolve(requested);
  if (process.platform === "darwin") await execFileAsync("open", ["-R", path]);
  else if (process.platform === "linux")
    await execFileAsync("xdg-open", [dirname(path)]);
  else await execFileAsync("explorer", ["/select,", path.replace(/\//g, "\\")]);
  return { ok: true, path };
}

async function openWorkspacePath(requested, app) {
  const path = resolve(requested);
  if (process.platform === "darwin") {
    // Only apps the server itself advertises may be launched; a client-supplied
    // app name would otherwise let any caller launch arbitrary applications.
    const knownApp =
      app && MAC_APPS.some((candidate) => candidate.id === app)
        ? app
        : undefined;
    if (knownApp) await execFileAsync("open", ["-a", knownApp, path]);
    else await execFileAsync("open", [path]);
  } else if (process.platform === "linux") {
    await execFileAsync("xdg-open", [path]);
  } else {
    await execFileAsync("cmd", ["/c", "start", "", path]);
  }
  return { ok: true, path };
}

async function openWorkspaceTerminal(requested) {
  const path = resolve(requested);
  const info = await stat(path);
  const folder = info.isDirectory() ? path : dirname(path);
  if (process.platform === "darwin")
    await execFileAsync("open", ["-a", "Terminal", folder]);
  else if (process.platform === "linux")
    await execFileAsync("xdg-open", [folder]);
  else await execFileAsync("cmd", ["/c", "start", "", folder]);
  return { ok: true, path: folder };
}

function requestHasAccess(req, url) {
  if (!ACCESS_TOKEN) return true;
  const header = String(req.headers.authorization || "");
  if (header === `Bearer ${ACCESS_TOKEN}`) return true;
  if (header.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const password = decoded.includes(":")
        ? decoded.slice(decoded.indexOf(":") + 1)
        : decoded;
      if (password === ACCESS_TOKEN) return true;
    } catch {
      /* invalid basic auth */
    }
  }
  const cookie = String(req.headers.cookie || "");
  if (
    cookie
      .split(";")
      .some((part) => part.trim() === `pi-web-token=${ACCESS_TOKEN}`)
  )
    return true;
  // One-time ticket for transports that cannot send headers or cookies
  // (cross-origin EventSource / WebSocket). The raw token is deliberately not
  // accepted in the query string: it would leak into server logs and history.
  return consumeAuthTicket(url.searchParams.get("ticket"));
}

function denyAccess(res) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="pi-web"',
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(res.req || { headers: {} }),
  });
  res.end("Unauthorized");
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { ok: false, error: "Malformed URL." });
  }

  if (pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      version: "0.1.0",
      buildId: BUILD_ID,
      bootMs: BOOT_MS,
      pid: process.pid,
      cwd: process.cwd(),
    });
  }

  if (pathname === "/api/auth" && req.method === "POST") {
    if (!ACCESS_TOKEN) return sendJson(res, 200, { ok: true, enabled: false });
    const body = await readBody(req);
    const header = String(req.headers.authorization || "");
    const headerToken = header.startsWith("Bearer ") ? header.slice(7) : "";
    const candidate = typeof body.token === "string" ? body.token : headerToken;
    if (!candidate || candidate !== ACCESS_TOKEN) return denyAccess(res);
    const ticket = mintAuthTicket();
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      Pragma: "no-cache",
      ...corsHeaders(req),
    };
    // HttpOnly cookie so same-origin EventSource/WebSocket authenticate without
    // exposing the token to script. Only set when the token is a safe cookie
    // value; otherwise the client relies on the ticket + Authorization header.
    if (/^[A-Za-z0-9._-]+$/.test(ACCESS_TOKEN)) {
      headers["Set-Cookie"] =
        `pi-web-token=${ACCESS_TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true, ticket }));
    return;
  }

  if (ACCESS_TOKEN && !requestHasAccess(req, url)) return denyAccess(res);

  if (pathname === "/api/auth/status" && req.method === "GET") {
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/deploy/status" && req.method === "GET") {
    const state = readDeployState();
    const stale = Boolean(
      state?.status === "running" &&
        Date.now() - (state.startedAt || 0) > 15 * 60_000,
    );
    return sendJson(res, 200, {
      ok: true,
      mode: DEPLOY_MODE,
      head: currentGitHead(),
      signature: workingTreeSignature(),
      dirtyFiles: uncommittedFileCount(),
      deploying: state?.status === "running" && !stale,
      stale,
      last: state,
      lastLocal: state?.lastLocal ?? null,
      lastCloud: state?.lastCloud ?? null,
    });
  }

  if (pathname === "/api/deploy" && req.method === "POST") {
    // Requested mode comes from the button clicked; the env default only
    // applies to callers that don't specify one.
    const body = await readBody(req);
    const requestedMode =
      body?.mode === "cloud" || body?.mode === "local"
        ? body.mode
        : DEPLOY_MODE;
    const state = readDeployState();
    if (
      state?.status === "running" &&
      Date.now() - (state.startedAt || 0) < 15 * 60_000
    ) {
      return sendJson(res, 409, {
        ok: false,
        error: "A deploy is already running.",
      });
    }
    writeDeployState({
      status: "running",
      mode: requestedMode,
      startedAt: Date.now(),
      finishedAt: null,
      commit: currentGitHead(),
      steps: [],
      log: "",
      error: null,
    });
    try {
      const child = spawn(
        process.execPath,
        [join(ROOT, "scripts", "deploy.mjs")],
        {
          cwd: ROOT,
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            PI_WEB_DEPLOY_MODE: requestedMode,
            PI_WEB_DEPLOY_STATE: DEPLOY_STATE_PATH,
            PI_WEB_SERVER_PID: String(process.pid),
          },
        },
      );
      child.unref();
    } catch (error) {
      writeDeployState({
        status: "failed",
        finishedAt: Date.now(),
        error: `Failed to start deployer: ${error?.message || error}`,
      });
      return sendJson(res, 500, {
        ok: false,
        error: "Failed to start deploy.",
      });
    }
    return sendJson(res, 200, { ok: true, mode: requestedMode });
  }

  if (pathname === "/api/directories" && req.method === "GET") {
    const requested = url.searchParams.get("path")?.trim() || homedir();
    try {
      const path = resolve(requested);
      const info = await stat(path);
      if (!info.isDirectory())
        return sendJson(res, 400, {
          ok: false,
          error: "That path is not a directory.",
        });
      const entries = (await readdir(path, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          path: join(path, entry.name),
          hidden: entry.name.startsWith("."),
        }))
        .sort((left, right) =>
          left.name.localeCompare(right.name, undefined, {
            sensitivity: "base",
          }),
        );
      return sendJson(res, 200, {
        ok: true,
        path,
        parent: path === dirname(path) ? null : dirname(path),
        home: homedir(),
        entries,
      });
    } catch (error) {
      const message =
        error?.code === "ENOENT"
          ? "That directory does not exist."
          : error?.code === "EACCES"
            ? "Pi cannot read that directory."
            : String(error?.message ?? error);
      return sendJson(res, 400, { ok: false, error: message });
    }
  }

  if (pathname === "/api/workspace" && req.method === "GET") {
    const requested = url.searchParams.get("path")?.trim();
    if (!requested)
      return sendJson(res, 400, {
        ok: false,
        error: "Missing workspace path.",
      });
    try {
      confineHomePath(requested);
      const result = await listWorkspace(requested);
      return sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: workspaceIoError(error, "directory"),
      });
    }
  }

  // Backs the composer's "@" file picker. Deliberately not Claude Code's
  // file_suggestions control request: this works for every backend, and the
  // CLI's matcher is inconsistent for partial path fragments.
  if (pathname === "/api/workspace/search" && req.method === "GET") {
    const root = url.searchParams.get("root")?.trim();
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    if (!root)
      return sendJson(res, 400, { ok: false, error: "Missing search root." });
    try {
      confineHomePath(root);
      const matches = await searchWorkspaceFiles(root, query);
      return sendJson(res, 200, { ok: true, matches });
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: workspaceIoError(error, "directory"),
      });
    }
  }

  if (pathname === "/api/workspace/file" && req.method === "GET") {
    const requested = url.searchParams.get("path")?.trim();
    if (!requested)
      return sendJson(res, 400, { ok: false, error: "Missing file path." });
    try {
      confineHomePath(requested);
      const result = await readWorkspaceFile(requested);
      return sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: workspaceIoError(error, "file"),
      });
    }
  }

  if (pathname === "/api/workspace/file" && req.method === "PUT") {
    const body = await readBody(req);
    try {
      confineWorkspacePath(String(body.path ?? ""));
      const result = await writeWorkspaceFile(
        String(body.path ?? ""),
        body.content,
      );
      return sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: workspaceIoError(error, "file"),
      });
    }
  }

  if (pathname === "/api/workspace/apps" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, apps: listWorkspaceApps() });
  }

  if (pathname.startsWith("/api/workspace/") && req.method === "POST") {
    const action = pathname.slice("/api/workspace/".length);
    const body = await readBody(req);
    const path = String(body.path ?? "");
    try {
      confineWorkspacePath(path);
      if (action === "copy" || action === "move")
        confineWorkspacePath(String(body.destination ?? ""));
      const result =
        action === "rename"
          ? await renameWorkspacePath(path, body.name)
          : action === "delete"
            ? await deleteWorkspacePath(path)
            : action === "copy"
              ? await transferWorkspacePath(
                  path,
                  String(body.destination ?? ""),
                  "copy",
                )
              : action === "move"
                ? await transferWorkspacePath(
                    path,
                    String(body.destination ?? ""),
                    "move",
                  )
                : action === "reveal"
                  ? await revealWorkspacePath(path)
                  : action === "open"
                    ? await openWorkspacePath(
                        path,
                        typeof body.app === "string" ? body.app : undefined,
                      )
                    : action === "terminal"
                      ? await openWorkspaceTerminal(path)
                      : { ok: false, error: "unknown workspace action" };
      return sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: workspaceIoError(error, "file"),
      });
    }
  }

  if (pathname === "/api/catalog" && req.method === "GET") {
    return sendJson(res, 200, await loadCatalog());
  }

  // Skill authoring. Confinement to the skills root lives in catalog.js, next
  // to the writes it protects.
  if (pathname === "/api/catalog/skill" && req.method === "GET") {
    const name = url.searchParams.get("name") ?? "";
    const result = await readSkill(name);
    return sendJson(res, result.ok ? 200 : 400, result);
  }
  if (pathname === "/api/catalog/skill" && req.method === "PUT") {
    const body = await readBody(req);
    const result = await writeSkill({
      name: String(body.name ?? ""),
      description: String(body.description ?? ""),
      body: String(body.body ?? ""),
    });
    return sendJson(res, result.ok ? 200 : 400, result);
  }
  if (pathname === "/api/catalog/skill" && req.method === "DELETE") {
    const name = url.searchParams.get("name") ?? "";
    const result = await deleteSkill(name);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (pathname === "/api/session-log" && req.method === "GET") {
    const result = await loadSessionLog(url.searchParams.get("path") ?? "");
    if (!result.ok) return sendJson(res, 400, result);
    const filename = basename(result.path).replace(/[^a-zA-Z0-9._-]/g, "_");
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, max-age=0",
      ...corsHeaders(req),
    });
    res.end(result.contents);
    return;
  }

  if (pathname === "/api/session-messages" && req.method === "GET") {
    return sendJson(
      res,
      200,
      await readSessionMessages(url.searchParams.get("path") || ""),
    );
  }

  if (pathname === "/api/sessions/search" && req.method === "GET") {
    return sendJson(
      res,
      200,
      await searchSessions({
        query: url.searchParams.get("q") ?? "",
        backend: backendName(url.searchParams.get("backend")),
      }),
    );
  }

  if (pathname === "/api/sessions" && req.method === "GET") {
    return sendJson(
      res,
      200,
      await listSessions({
        archived: url.searchParams.get("view") === "archived",
        backend: backendName(url.searchParams.get("backend")),
      }),
    );
  }

  if (pathname.startsWith("/api/sessions/") && req.method === "POST") {
    const action = pathname.slice("/api/sessions/".length);
    const body = await readBody(req);
    const sessionPath = String(body.sessionPath ?? "");
    const result =
      action === "archive"
        ? await archiveSession(sessionPath)
        : action === "restore"
          ? await restoreSession(sessionPath)
          : action === "delete"
            ? await deleteSession(sessionPath)
            : { ok: false, error: "unknown session action" };
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...corsHeaders(req),
    });
    res.write(`data: ${JSON.stringify({ type: "__hello" })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (pathname === "/api/heartbeat" && req.method === "POST") {
    const body = await readBody(req);
    const keys = Array.isArray(body.keys)
      ? body.keys.filter((key) => typeof key === "string" && key)
      : [];
    for (const key of keys) renewLease(key);
    return sendJson(res, 200, { ok: true });
  }

  const m = pathname.match(/^\/api\/([^/]+)(?:\/([^/]+))?$/);
  if (!m) {
    if (pathname.startsWith("/api/"))
      return sendJson(res, 404, { ok: false, error: "unknown route" });
    return serveStatic(res, pathname);
  }
  const [, sessionKey, action] = m;
  renewLease(sessionKey);

  if (req.method === "GET" && action === "log") {
    return sendJson(res, 200, {
      ok: true,
      entries: runtimeLogs.get(sessionKey) ?? [],
    });
  }

  if (req.method === "POST" && action === "start") {
    const body = await readBody(req);
    addWorkspaceRoot(body.cwd);
    // Reuse a process that is already running this session file (e.g. the
    // page was refreshed and the tab key changed) instead of spawning a
    // duplicate — its live state, including isStreaming, carries over.
    adoptLiveAgent(sessionKey, body.backend, body.sessionPath);
    const agent = watch(sessionKey, body.backend);
    // adoptOnly: attach to a live process but never spawn one. Grok stays
    // lazy for mere viewing (starting it wrote ghost session files); this
    // lets a refreshed tab re-adopt a mid-run grok turn without that cost.
    if (body.adoptOnly && !agent.process) {
      return sendJson(res, 200, { ok: false, error: "no live agent to adopt" });
    }
    const result = await runLoggedCommand(sessionKey, "start", body, () =>
      agent.start(body.cwd || process.cwd(), {
        model:
          body.model && typeof body.model === "object"
            ? {
                provider: String(body.model.provider || ""),
                id: String(body.model.id || ""),
              }
            : undefined,
        sessionPath:
          typeof body.sessionPath === "string" && body.sessionPath
            ? body.sessionPath
            : undefined,
        thinkingLevel:
          typeof body.thinkingLevel === "string"
            ? body.thinkingLevel
            : undefined,
      }),
    );
    return sendJson(res, result.ok ? 200 : 500, result);
  }
  if (req.method === "POST" && action === "prompt") {
    const body = await readBody(req);
    addWorkspaceRoot(body.cwd);
    const message = String(body.message ?? "");
    const images = Array.isArray(body.images) ? body.images : undefined;
    if (isUsageShortcut(message, images)) {
      const result = await runLoggedCommand(sessionKey, "usage", {}, () =>
        watch(sessionKey).getUsage(true),
      );
      return sendJson(res, result.ok ? 200 : 500, result);
    }
    // Lazy (re)start: opening a session only reads its history; the agent
    // process starts here, on the first message, using the session context
    // the client attaches to the prompt. This also self-heals dead
    // processes — a pi/claude RPC child that exited (idle exit, server
    // restart, page refresh) comes back with its session file on the next
    // message instead of failing with "process is not running".
    const promptBackend = backendName(
      body.backend ?? sessionBackends.get(sessionKey),
    );
    const promptAgent = watch(sessionKey, promptBackend);
    const agentAlive =
      promptBackend === "grok"
        ? Boolean(promptAgent.connection)
        : Boolean(promptAgent.process);
    if (!agentAlive) {
      const started = await runLoggedCommand(sessionKey, "start", body, () =>
        promptAgent.start(String(body.cwd || process.cwd()), {
          sessionPath:
            typeof body.sessionPath === "string" && body.sessionPath
              ? body.sessionPath
              : undefined,
          model:
            body.model && typeof body.model === "object"
              ? {
                  provider: String(body.model.provider || ""),
                  id: String(body.model.id || ""),
                }
              : undefined,
          thinkingLevel:
            typeof body.thinkingLevel === "string"
              ? body.thinkingLevel
              : undefined,
        }),
      );
      if (!started.ok) return sendJson(res, 500, started);
    }
    const result = await runLoggedCommand(sessionKey, "prompt", body, () =>
      watch(sessionKey).prompt(message, images),
    );
    if (promptBackend === "pi")
      maybeGeneratePiTitle(sessionKey, promptAgent, message);
    return sendJson(res, result.ok ? 200 : 500, result);
  }
  if (req.method === "POST" && action === "steer") {
    const body = await readBody(req);
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "steer", body, () =>
        watch(sessionKey).steer(
          String(body.message ?? ""),
          Array.isArray(body.images) ? body.images : undefined,
        ),
      ),
    );
  }
  if (req.method === "POST" && action === "queue") {
    const body = await readBody(req);
    const agent = watch(sessionKey);
    if (typeof agent.enqueue !== "function")
      return sendJson(res, 400, {
        ok: false,
        error: "This backend does not queue messages",
      });
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "queue", body, () =>
        agent.enqueue(
          String(body.message ?? ""),
          Array.isArray(body.images) ? body.images : undefined,
        ),
      ),
    );
  }
  if (req.method === "POST" && action === "queue-cancel") {
    const body = await readBody(req);
    const agent = watch(sessionKey);
    if (typeof agent.cancelQueued !== "function")
      return sendJson(res, 400, {
        ok: false,
        error: "This backend does not queue messages",
      });
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "queue-cancel", body, () =>
        agent.cancelQueued(
          typeof body.id === "string" && body.id ? body.id : undefined,
        ),
      ),
    );
  }
  if (req.method === "POST" && action === "abort") {
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "abort", {}, () =>
        watch(sessionKey).abort(),
      ),
    );
  }
  if (req.method === "POST" && action === "stop") {
    const backend = sessionBackends.get(sessionKey) ?? "pi";
    const result = await runLoggedCommand(sessionKey, "stop", {}, () => {
      poolFor(backend).stop(sessionKey);
      sessionBackends.delete(sessionKey);
      return { ok: true };
    });
    return sendJson(res, 200, result);
  }
  if (req.method === "POST" && action === "configure") {
    const body = await readBody(req);
    addWorkspaceRoot(body.cwd);
    const currentBackend = sessionBackends.get(sessionKey) ?? "pi";
    poolFor(currentBackend).stop(sessionKey);
    sessionBackends.delete(sessionKey);
    const agent = watch(sessionKey, body.backend);
    // A not-yet-started grok conversation (fresh or lazily resumed) has
    // nothing to reconfigure server-side: just record the requested backend
    // and return placeholder state instead of spawning an agent that writes
    // an empty session file. The first prompt starts it with the new cwd.
    if (
      backendName(body.backend) === "grok" &&
      !agent.connection &&
      !body.sessionPath
    ) {
      return sendJson(res, 200, {
        ok: true,
        state: {
          model:
            body.model && typeof body.model === "object" ? body.model : null,
          thinkingLevel:
            typeof body.thinkingLevel === "string" ? body.thinkingLevel : "off",
          isStreaming: false,
          sessionId: "",
          messageCount: 0,
          pendingMessageCount: 0,
        },
      });
    }
    const result = await runLoggedCommand(sessionKey, "configure", body, () =>
      agent.start(String(body.cwd || process.cwd()), {
        accessMode:
          body.accessMode === "read-only" ? "read-only" : "workspace-write",
        agentMode: body.agentMode === "plan" ? "plan" : "standard",
        sessionPath:
          typeof body.sessionPath === "string" && body.sessionPath
            ? body.sessionPath
            : undefined,
        model:
          body.model && typeof body.model === "object"
            ? {
                provider: String(body.model.provider || ""),
                id: String(body.model.id || ""),
              }
            : undefined,
        thinkingLevel:
          typeof body.thinkingLevel === "string"
            ? body.thinkingLevel
            : undefined,
      }),
    );
    if (result.ok && body.sessionPath) {
      try {
        result.messages = await agent.getMessages();
      } catch (error) {
        return sendJson(res, 500, {
          ok: false,
          error: String(error?.message ?? error),
        });
      }
    }
    return sendJson(res, result.ok ? 200 : 500, result);
  }
  if (req.method === "POST" && action === "upload") {
    const body = await readBody(req);
    const data = typeof body.data === "string" ? body.data : "";
    const bytes = Buffer.from(data, "base64");
    if (!data || bytes.length === 0)
      return sendJson(res, 400, {
        ok: false,
        error: "The uploaded file was empty.",
      });
    if (bytes.length > 20 * 1024 * 1024)
      return sendJson(res, 413, {
        ok: false,
        error: "Files must be 20 MB or smaller.",
      });
    const safeSession = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeName = basename(String(body.name || "attachment")).replace(
      /[^a-zA-Z0-9._ -]/g,
      "_",
    );
    const directory = join(tmpdir(), "pi-web-uploads", safeSession);
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${Date.now()}-${safeName}`);
    await writeFile(path, bytes);
    return sendJson(res, 200, { ok: true, path });
  }
  if (req.method === "POST" && action === "new-session") {
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "new-session", {}, () =>
        watch(sessionKey).newSession(),
      ),
    );
  }
  if (req.method === "POST" && action === "resume") {
    const body = await readBody(req);
    const sessionPath = String(body.sessionPath ?? "");
    const resumeAgent = watch(sessionKey);
    // switch_session aborts a running turn on purpose: a *persisted* session
    // can carry a stale isStreaming flag from another pi process. But when
    // this agent is already live on the requested file (a page refresh
    // adopted it mid-run), that abort kills the very turn the reload is
    // supposed to preserve — the "request was aborted" a refresh produced.
    // Hand back the live transcript instead of switching into it.
    const liveFile =
      resumeAgent.sessionFile ?? resumeAgent.lastState?.sessionFile;
    if (sessionPath && liveFile === sessionPath) {
      const liveState = await resumeAgent.getState().catch(() => undefined);
      if (liveState?.isStreaming) {
        const messages = await resumeAgent.getMessages().catch(() => []);
        return sendJson(res, 200, { ok: true, state: liveState, messages });
      }
    }
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "resume", body, () =>
        resumeAgent.switchSession(sessionPath),
      ),
    );
  }
  if (req.method === "POST" && action === "fork") {
    const body = await readBody(req);
    const result = await runLoggedCommand(sessionKey, "fork", body, () =>
      watch(sessionKey).forkAt(Number(body.timestamp)),
    );
    return sendJson(res, result.ok ? 200 : 500, result);
  }
  if (req.method === "GET" && action === "settings") {
    const agent = watch(sessionKey);
    if (typeof agent.getSettings !== "function")
      return sendJson(res, 200, {
        ok: false,
        error: "This backend does not expose settings",
      });
    return sendJson(res, 200, await agent.getSettings());
  }
  if (req.method === "GET" && action === "mcp") {
    const agent = watch(sessionKey);
    if (typeof agent.getMcpServers !== "function")
      return sendJson(res, 200, {
        ok: false,
        error: "This backend does not expose MCP servers",
      });
    return sendJson(res, 200, await agent.getMcpServers());
  }
  if (req.method === "GET" && action === "context") {
    const agent = watch(sessionKey);
    if (typeof agent.getContextUsage !== "function")
      return sendJson(res, 200, {
        ok: false,
        error: "This backend does not report context usage",
      });
    return sendJson(res, 200, await agent.getContextUsage());
  }
  if (req.method === "POST" && action === "rewind-files") {
    const body = await readBody(req);
    const agent = watch(sessionKey);
    if (typeof agent.rewindFiles !== "function")
      return sendJson(res, 400, {
        ok: false,
        error: "This backend does not checkpoint files",
      });
    // Restoring happens after the turn, so the agent may have been reaped
    // since. Resume it first — the control request needs a live CLI.
    const rewindCwd = typeof body.cwd === "string" ? body.cwd : "";
    const rewindSessionPath =
      typeof body.sessionPath === "string" ? body.sessionPath : "";
    if (agent.status !== "ready" && agent.status !== "working" && rewindCwd) {
      await runLoggedCommand(sessionKey, "start", { cwd: rewindCwd }, () =>
        agent.start(
          rewindCwd,
          rewindSessionPath ? { sessionPath: rewindSessionPath } : {},
        ),
      );
    }
    const result = await runLoggedCommand(
      sessionKey,
      "rewind-files",
      body,
      () =>
        agent.rewindFiles(
          Number(body.timestamp),
          body.dryRun === true,
          rewindSessionPath || undefined,
        ),
    );
    return sendJson(res, result.ok ? 200 : 500, result);
  }
  if (req.method === "POST" && action === "truncate") {
    const body = await readBody(req);
    const agent = watch(sessionKey);
    if (typeof agent.truncateAt !== "function")
      return sendJson(res, 400, {
        ok: false,
        error:
          "This backend cannot rewind a conversation yet. Use \u201cRestore files to this point\u201d to undo the edits instead.",
      });
    const result = await runLoggedCommand(sessionKey, "truncate", body, () =>
      agent.truncateAt(
        Number(body.userTimestamp),
        typeof body.sessionPath === "string" && body.sessionPath
          ? body.sessionPath
          : undefined,
      ),
    );
    return sendJson(res, result.ok ? 200 : 500, result);
  }
  if (req.method === "POST" && action === "goal") {
    const body = await readBody(req);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    return sendJson(res, 200, setSessionGoal(sessionKey, text));
  }
  // Working-tree changes for the post-turn "Changes" card: branch, GitHub
  // connectivity (an `origin` remote must exist — push errors surface on push),
  // and per-file status plus line counts. `?file=` returns that file's diff.
  // Read-only git, but the target dir still gets confined because the output
  // discloses repo contents.
  if (req.method === "GET" && action === "git-changes") {
    const cwdParam = url.searchParams.get("cwd") || "";
    let dir;
    try {
      dir = cwdParam ? confineWorkspacePath(cwdParam) : process.cwd();
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: String(error?.message ?? error),
      });
    }
    const git = async (args) => {
      try {
        const { stdout, stderr } = await execFileAsync(
          "git",
          ["-C", dir, ...args],
          { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
        );
        return { ok: true, stdout: String(stdout), stderr: String(stderr) };
      } catch (error) {
        return {
          ok: false,
          stdout: String(error?.stdout ?? ""),
          stderr: String(error?.stderr || error?.message || error),
        };
      }
    };
    const inside = await git(["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.trim() !== "true")
      return sendJson(res, 200, {
        ok: true,
        repo: false,
        connected: false,
        changes: [],
      });
    if (url.searchParams.has("file")) {
      const file = String(url.searchParams.get("file"));
      if (
        isAbsolute(file) ||
        file.split(/[\\/]/).includes("..") ||
        file.startsWith(":")
      )
        return sendJson(res, 400, { ok: false, error: "Invalid file path." });
      // Untracked files never appear in `git diff HEAD`; probe first.
      const probed = await git([
        "status",
        "--porcelain=v1",
        "--no-renames",
        "--",
        file,
      ]);
      const line = probed.stdout.split("\n").find((row) => row.length > 3);
      const diff = line?.startsWith("??")
        ? await git(["diff", "--no-index", "--", "/dev/null", file])
        : await git(["diff", "HEAD", "--", file]);
      const text = `${diff.stdout}${diff.stderr}`.trim();
      return sendJson(res, 200, {
        ok: true,
        diff: text.slice(0, 200_000),
      });
    }
    const [
      remoteProbe,
      branchProbe,
      statusProbe,
      numstatProbe,
      trackingProbe,
      gitDirProbe,
      stashProbe,
      branchListProbe,
      remoteListProbe,
    ] = await Promise.all([
      git(["remote", "get-url", "origin"]),
      git(["branch", "--show-current"]),
      git(["status", "--porcelain=v1", "--no-renames"]),
      git(["diff", "--numstat", "HEAD"]),
      // Fails (not ok) when the branch has no upstream — that is the signal
      // for "never pushed", not an error worth surfacing.
      git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
      git(["rev-parse", "--absolute-git-dir"]),
      git(["stash", "list", "--format=%gd%x09%gs%x09%cr"]),
      git([
        "for-each-ref",
        "--sort=-committerdate",
        "--count=30",
        "--format=%(refname:short)",
        "refs/heads",
      ]),
      // Remote-tracking refs so a branch someone else pushed is reachable
      // after a fetch; `git switch <name>` turns one into a local branch.
      git([
        "for-each-ref",
        "--sort=-committerdate",
        "--count=30",
        "--format=%(refname:short)",
        "refs/remotes",
      ]),
    ]);
    const remote = remoteProbe.ok ? remoteProbe.stdout.trim() : "";
    const branch = branchProbe.stdout.trim() || "(detached)";
    const counts = new Map();
    for (const row of numstatProbe.stdout.split("\n")) {
      const match = row.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (match)
        counts.set(match[3].replace(/^"|"$/g, ""), {
          additions: Number(match[1]) || 0,
          deletions: Number(match[2]) || 0,
        });
    }
    const changes = [];
    for (const row of statusProbe.stdout.split("\n")) {
      if (row.length < 4) continue;
      const code = row.slice(0, 2);
      const path = row.slice(3).replace(/^"|"$/g, "");
      const untracked = code.startsWith("??");
      // Unmerged index states: both/either side added, deleted or modified.
      // They are NOT "modified" — committing one writes conflict markers.
      const conflicted = code === "AA" || code === "DD" || code.includes("U");
      const letter = untracked ? "A" : code[1] === "." ? code[0] : code[1];
      if (untracked) {
        const probe = await git([
          "diff",
          "--no-index",
          "--numstat",
          "--",
          "/dev/null",
          path,
        ]);
        const match = probe.stdout.match(/^(\d+|-)\t(\d+|-)\t/);
        counts.set(path, {
          additions: match ? Number(match[1]) || 0 : 0,
          deletions: match ? Number(match[2]) || 0 : 0,
        });
      }
      const stat = counts.get(path) ?? { additions: 0, deletions: 0 };
      changes.push({
        path,
        status: conflicted
          ? "conflicted"
          : letter === "A"
            ? "added"
            : letter === "D"
              ? "deleted"
              : "modified",
        additions: stat.additions,
        deletions: stat.deletions,
      });
      // One row per file: a path can appear staged AND worktree-modified;
      // skip duplicates (deeper status merge would double-count).
      counts.delete(path);
    }
    const tracking = trackingProbe.stdout.trim().match(/^(\d+)\s+(\d+)$/);
    const state = gitStateFromDir(gitDirProbe.stdout.trim());
    const stashes = [];
    for (const row of stashProbe.stdout.split("\n")) {
      const [ref, label, age] = row.split("\t");
      if (!/^stash@\{\d+\}$/.test(ref ?? "")) continue;
      stashes.push({ ref, label: label ?? "", age: age ?? "" });
    }
    const branches = branchListProbe.stdout
      .split("\n")
      .map((row) => row.trim())
      .filter(Boolean);
    const local = new Set(branches);
    // Strip the remote prefix and drop anything already checked out locally or
    // pointing at HEAD — what is left is "branches you could switch to".
    const remoteBranches = [];
    for (const row of remoteListProbe.stdout.split("\n")) {
      const ref = row.trim();
      const slash = ref.indexOf("/");
      if (slash < 0 || ref.endsWith("/HEAD")) continue;
      const name = ref.slice(slash + 1);
      if (local.has(name) || remoteBranches.includes(name)) continue;
      remoteBranches.push(name);
    }
    return sendJson(res, 200, {
      ok: true,
      repo: true,
      connected: Boolean(remote),
      remote,
      branch,
      changes,
      upstream: trackingProbe.ok,
      ahead: tracking ? Number(tracking[1]) : 0,
      behind: tracking ? Number(tracking[2]) : 0,
      stashes,
      branches,
      remoteBranches,
      state,
      conflicts: changes
        .filter((change) => change.status === "conflicted")
        .map((change) => change.path),
    });
  }
  // Revert a single hunk of a file's working-tree changes: rebuild a patch
  // containing just that hunk and apply it in reverse.
  if (req.method === "POST" && action === "git-hunk") {
    const body = await readBody(req);
    const dir =
      typeof body.cwd === "string" && body.cwd ? body.cwd : process.cwd();
    const file = String(body.file ?? "");
    const hunkIndex = Number(body.hunkIndex);
    try {
      confineWorkspacePath(dir);
      if (
        !file ||
        isAbsolute(file) ||
        file.split(/[\\/]/).includes("..") ||
        file.startsWith(":")
      )
        throw new Error(`Invalid file path: ${file}`);
      if (!Number.isInteger(hunkIndex) || hunkIndex < 0)
        throw new Error("Invalid hunk index.");
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: String(error?.message ?? error),
      });
    }
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "git-hunk", body, async () => {
        let diff = "";
        try {
          const { stdout } = await execFileAsync(
            "git",
            ["-C", dir, "diff", "--unified=3", "--", file],
            { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
          );
          diff = String(stdout);
        } catch (error) {
          return {
            ok: false,
            error: String(error?.stderr || error?.message || error),
          };
        }
        if (!diff.trim())
          return {
            ok: false,
            error:
              "No tracked changes for that file — an untracked file has no hunks to revert.",
          };
        const { header, hunks } = splitDiffHunks(diff);
        const hunk = hunks[hunkIndex];
        if (!hunk)
          return { ok: false, error: "That hunk is no longer in the diff." };
        const patch = `${[...header, ...hunk.lines].join("\n").replace(/\n*$/, "")}\n`;
        const applied = await new Promise((resolve) => {
          const child = spawn(
            "git",
            ["-C", dir, "apply", "--reverse", "--recount", "-"],
            { stdio: ["pipe", "pipe", "pipe"] },
          );
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("error", (error) =>
            resolve({ ok: false, error: String(error?.message ?? error) }),
          );
          child.on("close", (code) =>
            resolve(
              code === 0
                ? { ok: true }
                : {
                    ok: false,
                    error: stderr.trim() || `git apply exited ${code}`,
                  },
            ),
          );
          child.stdin.end(patch);
        });
        if (!applied.ok) return applied;
        return {
          ok: true,
          data: { file, hunkIndex, remaining: hunks.length - 1 },
        };
      }),
    );
  }

  if (req.method === "POST" && action === "git") {
    const body = await readBody(req);
    const op = GIT_WRITE_OPS.has(body.op) ? body.op : "push";
    const dir =
      typeof body.cwd === "string" && body.cwd ? body.cwd : process.cwd();
    // git pull/push run repo hooks (post-merge, pre-push) as this user, so the
    // target must be a repo inside the workspace roots — never an arbitrary dir.
    try {
      confineWorkspacePath(dir);
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: String(error?.message ?? error),
      });
    }
    const result = await runLoggedCommand(
      sessionKey,
      `git-${op}`,
      body,
      async () => {
        const run = (args) =>
          execFileAsync("git", ["-C", dir, ...args], {
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024,
          });
        const text = (done) => `${done.stdout}${done.stderr}`.trim();
        // Optional file selection: when the client sends `files`, act on only
        // those (paths are repo-relative and validated); otherwise act on the
        // whole tree. Returns undefined when the client sent no selection.
        const pickFiles = () => {
          if (!Array.isArray(body.files)) return undefined;
          const files = body.files.filter((f) => typeof f === "string" && f);
          if (files.length === 0) throw new Error("No files selected.");
          for (const file of files) {
            if (
              isAbsolute(file) ||
              file.split(/[\\/]/).includes("..") ||
              file.startsWith(":")
            )
              throw new Error(`Invalid file path: ${file}`);
          }
          return files;
        };
        // Paths git still considers unmerged. `git add` + `git commit` on one
        // of these silently records the conflict markers as the resolution,
        // so every op that commits has to refuse while any exist.
        const unmergedPaths = async () => {
          try {
            const done = await run(["diff", "--name-only", "--diff-filter=U"]);
            return done.stdout.split("\n").filter(Boolean);
          } catch {
            return [];
          }
        };
        try {
          if (op === "continue" || op === "abort") {
            const state = await gitProgressState(dir);
            if (state === "clean")
              return {
                ok: false,
                error: "No merge, rebase, cherry-pick or revert in progress.",
              };
            const command =
              state === "merging"
                ? "merge"
                : state === "rebasing"
                  ? "rebase"
                  : state === "cherry-picking"
                    ? "cherry-pick"
                    : "revert";
            if (op === "abort") {
              const done = await run([command, "--abort"]);
              return {
                ok: true,
                output:
                  text(done) ||
                  `Aborted the ${command}; the repo is back where it started.`,
              };
            }
            // An unmerged index entry is not itself a blocker — git keeps one
            // until the resolution is staged, which is what Continue does
            // next. What must not pass is a file still holding markers.
            const unresolved = [];
            for (const path of await unmergedPaths()) {
              try {
                const content = readFileSync(join(dir, path), "utf8");
                if (/^<{7}/m.test(content) || /^>{7}/m.test(content))
                  unresolved.push(path);
              } catch {
                /* deleted or binary: let git judge it at --continue */
              }
            }
            if (unresolved.length)
              return {
                ok: false,
                error: `Conflict markers are still in:\n${unresolved.join("\n")}`,
              };
            // Stage the resolutions, then let git write the merge/rebase commit
            // with its own prepared message (GIT_EDITOR=true accepts it).
            await run(["add", "-A"]);
            const done = await execFileAsync(
              "git",
              ["-C", dir, command, "--continue"],
              {
                timeout: 120_000,
                maxBuffer: 4 * 1024 * 1024,
                env: { ...process.env, GIT_EDITOR: "true" },
              },
            );
            return {
              ok: true,
              output: text(done) || `Finished the ${command}.`,
            };
          }
          if (op === "commit" || op === "commit-push") {
            const message =
              typeof body.message === "string" ? body.message.trim() : "";
            if (!message)
              return { ok: false, error: "Commit message required." };
            const blocked = await unmergedPaths();
            if (blocked.length)
              return {
                ok: false,
                error: `Cannot commit with an unresolved conflict in:\n${blocked.join("\n")}\nResolve them, then use Continue.`,
              };
            const out = [];
            const files = pickFiles();
            // A selective commit takes a pathspec rather than the bare index,
            // so files staged outside this request (a manual git add, an old
            // client) can never ride along.
            try {
              await run(files ? ["add", "--", ...files] : ["add", "-A"]);
              const commit = await run(
                files
                  ? ["commit", "-m", message, "--", ...files]
                  : ["commit", "-m", message],
              );
              out.push(text(commit));
            } catch (error) {
              const failure = String(error?.stderr || error?.message || error);
              if (!/nothing to commit|no changes added/i.test(failure))
                return { ok: false, error: failure };
              out.push("Nothing new to commit.");
            }
            if (op === "commit")
              return { ok: true, output: out.filter(Boolean).join("\n") };
            try {
              const push = await run(["push"]);
              out.push(text(push));
            } catch (error) {
              const failure = String(error?.stderr || error?.message || error);
              if (!/no upstream|has no upstream/i.test(failure))
                return { ok: false, error: failure };
              // First push of a fresh branch: bind it to origin.
              try {
                const retry = await run(["push", "-u", "origin", "HEAD"]);
                out.push(text(retry));
              } catch (error2) {
                return {
                  ok: false,
                  error: String(error2?.stderr || error2?.message || error2),
                };
              }
            }
            return { ok: true, output: out.filter(Boolean).join("\n") };
          }
          if (op === "stash") {
            const label =
              typeof body.message === "string" ? body.message.trim() : "";
            // -u so a stash actually empties the tree the Changes list shows;
            // untracked files are the common case for a fresh agent turn.
            const args = ["stash", "push", "--include-untracked"];
            if (label) args.push("-m", label.slice(0, 200));
            const files = pickFiles();
            if (files) args.push("--", ...files);
            const done = await run(args);
            return { ok: true, output: text(done) || "Nothing to stash." };
          }
          if (
            op === "stash-apply" ||
            op === "stash-pop" ||
            op === "stash-drop"
          ) {
            const ref = typeof body.ref === "string" ? body.ref : "stash@{0}";
            if (!/^stash@\{\d{1,3}\}$/.test(ref))
              return { ok: false, error: "Invalid stash reference." };
            const sub = op.slice("stash-".length);
            const done = await run(["stash", sub, ref]);
            return { ok: true, output: text(done) || `Stash ${sub} done.` };
          }
          if (op === "branch-create" || op === "branch-switch") {
            const branch =
              typeof body.branch === "string" ? body.branch.trim() : "";
            if (!isSafeBranchName(branch))
              return { ok: false, error: `Invalid branch name: ${branch}` };
            // `switch` refuses to clobber a dirty tree on its own, which is the
            // safe default here: no silent carry-over of the agent's edits.
            const done = await run(
              op === "branch-create"
                ? ["switch", "--create", branch]
                : ["switch", branch],
            );
            return { ok: true, output: text(done) || `On ${branch}.` };
          }
          if (op === "undo-commit") {
            // --soft: the commit disappears, its content lands back in the
            // working tree. The UI only offers this for unpushed commits, so
            // it can never leave the branch needing a force-push.
            const done = await run(["reset", "--soft", "HEAD~1"]);
            return {
              ok: true,
              output:
                text(done) ||
                "Last commit undone; its changes are back in the working tree.",
            };
          }
          if (op === "fetch") {
            // --prune so branches deleted on the remote stop showing as
            // upstream candidates; no working-tree side effects.
            const done = await run(["fetch", "--prune"]);
            return { ok: true, output: text(done) || "Already up to date." };
          }
          // --no-rebase merges divergent history instead of failing on git's
          // pull.rebase prompt; --rebase replays local commits on top instead.
          // --autostash lets either run with the agent's uncommitted work in
          // the tree and puts it back afterwards.
          const args =
            op === "pull"
              ? ["pull", "--no-rebase", "--autostash"]
              : op === "pull-rebase"
                ? ["pull", "--rebase", "--autostash"]
                : ["push"];
          const done = await run(args);
          return { ok: true, output: text(done) };
        } catch (error) {
          return {
            ok: false,
            error: String(error?.stderr || error?.message || error),
          };
        }
      },
    );
    return sendJson(res, 200, result);
  }
  if (req.method === "POST" && action === "compact") {
    const body = await readBody(req);
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "compact", body, () =>
        watch(sessionKey).compact(body.customInstructions),
      ),
    );
  }
  if (req.method === "POST" && action === "set-model") {
    const body = await readBody(req);
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "set-model", body, () =>
        watch(sessionKey).setModel(String(body.provider), String(body.modelId)),
      ),
    );
  }
  if (req.method === "POST" && action === "set-thinking") {
    const body = await readBody(req);
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "set-thinking", body, () =>
        watch(sessionKey).setThinkingLevel(String(body.level)),
      ),
    );
  }
  if (req.method === "GET" && action === "state") {
    // Live state snapshot for the stream-reconnect self-heal: after the SSE
    // connection drops, the UI asks whether a mid-turn "working" flag is
    // still true instead of trusting its stale local copy.
    try {
      const state = await watch(
        sessionKey,
        url.searchParams.get("backend") || undefined,
      ).getState();
      return sendJson(res, 200, { ok: true, state: state ?? null });
    } catch {
      return sendJson(res, 200, { ok: true, state: null });
    }
  }
  if (req.method === "GET" && action === "commands")
    return sendJson(
      res,
      200,
      await watch(
        sessionKey,
        url.searchParams.get("backend") || undefined,
      ).getCommands(),
    );
  if (req.method === "GET" && action === "models")
    return sendJson(
      res,
      200,
      await watch(
        sessionKey,
        url.searchParams.get("backend") || undefined,
      ).getAvailableModels(),
    );
  if (req.method === "GET" && action === "thinking-levels")
    return sendJson(
      res,
      200,
      await watch(
        sessionKey,
        url.searchParams.get("backend") || undefined,
      ).getThinkingLevels(),
    );
  if (req.method === "GET" && action === "usage") {
    const refresh = url.searchParams.get("refresh") === "1";
    const result = await watch(
      sessionKey,
      url.searchParams.get("backend") || undefined,
    ).getUsage(refresh);
    return sendJson(res, result.ok ? 200 : 500, result);
  }

  return sendJson(res, 404, { ok: false, error: "unknown route" });
}

const server = createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }
  route(req, res).catch((error) =>
    sendJson(res, error?.statusCode ?? 500, {
      ok: false,
      error: String(error?.message ?? error),
    }),
  );
});

const terminalSockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || `${HOST}:${PORT}`}`,
  );
  // WebSockets are not subject to CORS — the server must validate Origin
  // itself. Browsers always send it; a missing Origin (non-browser client) is
  // allowed, a non-allowlisted one is destroyed before any bytes are exchanged.
  const origin = String(req.headers.origin || "");
  if (origin && !isAllowedOrigin(origin)) {
    socket.destroy();
    return;
  }
  if (
    url.pathname !== "/api/terminal" ||
    (ACCESS_TOKEN && !requestHasAccess(req, url))
  ) {
    socket.destroy();
    return;
  }
  terminalSockets.handleUpgrade(req, socket, head, (webSocket) =>
    terminalSockets.emit("connection", webSocket, req, url),
  );
});

terminalSockets.on("connection", (socket, _request, url) => {
  const requestedCwd = url.searchParams.get("cwd") || homedir();
  const cwd =
    existsSync(requestedCwd) && statSync(requestedCwd).isDirectory()
      ? requestedCwd
      : homedir();
  const shell = process.env.SHELL || "/bin/zsh";
  let terminal;
  try {
    terminal = pty.spawn(shell, ["-l"], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
  } catch (error) {
    socket.send(
      `\r\n\x1b[31mCould not start the shell: ${String(error?.message ?? error)}\x1b[0m\r\n`,
    );
    socket.close();
    return;
  }
  terminal.onData((data) => {
    if (socket.readyState === socket.OPEN) socket.send(data);
  });
  terminal.onExit(() => {
    clearInterval(cwdTimer);
    socket.close();
  });

  // Track the shell's live working directory (cd inside the terminal moves
  // the SHELL process, not the spawned cwd) and push it to the UI. Control
  // messages are prefixed with NUL — real terminal output never starts a
  // chunk with NUL + '{'. Polling: /proc on Linux, lsof on macOS.
  let lastCwd = cwd;
  const pushCwd = async () => {
    try {
      let cwdNow;
      if (process.platform === "darwin") {
        const { stdout } = await execFileAsync(
          "lsof",
          ["-a", "-p", String(terminal.pid), "-d", "cwd", "-Fn"],
          { timeout: 5_000 },
        );
        const line = String(stdout)
          .split("\n")
          .find((row) => row.startsWith("n/"));
        cwdNow = line ? line.slice(1) : undefined;
      } else {
        cwdNow = await readlink(join("/proc", String(terminal.pid), "cwd"));
      }
      if (cwdNow && cwdNow !== lastCwd && socket.readyState === socket.OPEN) {
        lastCwd = cwdNow;
        socket.send(`\u0000${JSON.stringify({ type: "cwd", cwd: cwdNow })}`);
      }
    } catch {
      /* shell exited or lsof unavailable; the interval just no-ops */
    }
  };
  const cwdTimer = setInterval(() => void pushCwd(), 3_000);
  setTimeout(() => void pushCwd(), 500);
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.type === "input" && typeof message.data === "string")
      terminal.write(message.data);
    if (message.type === "resize") {
      const cols = Math.max(2, Math.min(500, Number(message.cols) || 80));
      const rows = Math.max(1, Math.min(200, Number(message.rows) || 24));
      terminal.resize(cols, rows);
    }
  });
  socket.on("close", () => {
    clearInterval(cwdTimer);
    terminal.kill();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`pi-web ready: http://${HOST}:${PORT}`);
  listOllamaModels()
    .then((models) => syncOllamaModelsJson(models))
    .catch(() => {});
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    piPool.stop();
    claudePool.stop();
    grokPool.stop();
    sessionBackends.clear();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
