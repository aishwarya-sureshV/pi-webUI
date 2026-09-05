/**
 * App state: manages open conversation tabs, each bound to a Timeline that
 * consumes the shared SSE event stream keyed by sessionKey.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  backendLabel,
  subscribeEvents,
  type AgentEvent,
  type AgentBackend,
  type ModelInfo,
  type ResumeSession,
  type SessionHistoryMessage,
  type SessionMutationResponse,
  type SessionState,
} from "./api";
import { Timeline } from "./timeline";
import { notify } from "./notify";
import { savedSessionTitle } from "./sessionTitle";
import { isAwaitingAnswer } from "./awaitingAnswer";
import {
  CLAUDE_DEFAULT_EFFORT,
  CLAUDE_DEFAULT_MODEL,
  claudeModelInfo,
} from "./claudeModels";

export interface ConversationTab {
  key: string;
  label: string;
  cwd: string;
  sessionPath?: string;
  backend: AgentBackend;
  /** Created from New session (as opposed to opening saved history). */
  isFresh: boolean;
  timeline: Timeline;
}

function timelineIsWorking(timeline: Timeline | undefined): boolean {
  return Boolean(
    timeline && (timeline.status === "working" || timeline.state?.isStreaming),
  );
}

interface StoreValue {
  tabs: ConversationTab[];
  activeKey: string;
  active: ConversationTab | undefined;
  workingKeys: ReadonlySet<string>;
  /** Sessions whose last turn ended on a question and are parked on an answer. */
  awaitingKeys: ReadonlySet<string>;
  resumeSessions: ResumeSession[];
  archivedSessions: ResumeSession[];
  openConversation: (
    cwd: string,
    label?: string,
    backend?: AgentBackend,
  ) => string;
  openDefaultConversation: () => Promise<string>;
  resumeConversation: (session: ResumeSession) => string;
  openForkedConversation: (args: {
    cwd: string;
    sessionPath: string;
    messages: SessionHistoryMessage[];
    state?: SessionState | null;
    label?: string;
    backend?: AgentBackend;
  }) => string;
  closeConversation: (key: string) => void;
  setActiveKey: (key: string) => void;
  setConversationSessionPath: (key: string, path?: string) => void;
  setConversationLabel: (key: string, label: string) => void;
  setConversationWorkspace: (key: string, cwd: string) => void;
  archiveSession: (session: ResumeSession) => Promise<SessionMutationResponse>;
  restoreSession: (session: ResumeSession) => Promise<SessionMutationResponse>;
  deleteSession: (session: ResumeSession) => Promise<SessionMutationResponse>;
  refreshSessions: () => void;
  setPreferredModel: (
    backend: AgentBackend,
    cwd: string,
    model: ModelInfo | null,
  ) => void;
  workspaceReveal: { key: string; nonce: number } | null;
  revealWorkspace: (key: string) => void;
}

const StoreContext = createContext<StoreValue | null>(null);
const timelines = new Map<string, Timeline>();
const pageSessionId = crypto.randomUUID();
let counter = 1;

interface PersistedOpenSession {
  cwd: string;
  label: string;
  backend: AgentBackend;
  sessionPath?: string;
  model?: ModelInfo | null;
  thinkingLevel?: string;
  active?: boolean;
}

function openSessionsStorageKey(backend: AgentBackend): string {
  return `pi-web.open-sessions.v1.${backend}`;
}

function readOpenSessions(backend: AgentBackend): PersistedOpenSession[] {
  try {
    const value = JSON.parse(
      localStorage.getItem(openSessionsStorageKey(backend)) ?? "[]",
    );
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is PersistedOpenSession =>
        entry &&
        typeof entry === "object" &&
        typeof entry.cwd === "string" &&
        typeof entry.label === "string" &&
        entry.backend === backend,
    );
  } catch {
    return [];
  }
}

function modelPreferenceKey(backend: AgentBackend, cwd: string): string {
  return `${backend}:${cwd}`;
}

function timelineFor(key: string): Timeline {
  let timeline = timelines.get(key);
  if (!timeline) {
    timeline = new Timeline(key);
    timelines.set(key, timeline);
  }
  return timeline;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<ConversationTab[]>([]);
  const [activeKey, setActiveKey] = useState("");
  const [workingKeys, setWorkingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [awaitingKeys, setAwaitingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [resumeSessions, setResumeSessions] = useState<ResumeSession[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<ResumeSession[]>([]);
  const [workspaceReveal, setWorkspaceReveal] = useState<{
    key: string;
    nonce: number;
  } | null>(null);
  const defaultCwd = useRef("");
  const defaultBackend = useRef<AgentBackend>(
    (() => {
      const requested = new URLSearchParams(window.location.search).get(
        "backend",
      );
      return requested === "claude" || requested === "grok" ? requested : "pi";
    })(),
  );
  const didOpenInitialSession = useRef(false);
  const didRenderRestoredSessions = useRef(false);
  const tabsRef = useRef<ConversationTab[]>([]);
  let firstStreamConnect = true;
  const preferredModels = useRef(new Map<string, ModelInfo>());
  const persistedOpenSessions = useRef(
    readOpenSessions(defaultBackend.current),
  );

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    // Server-side lease: the page renews a lease for every open conversation
    // and the server reaps agents whose page stopped heartbeating (tab closed,
    // browser quit). This is the single owner of process lifetime across
    // refreshes — the old pagehide beacon raced the server's adoptLiveAgent
    // and killed the very process a refresh was supposed to rebind. A refresh
    // never stops the agent now: the new page's /start adopts the live process.
    const sendHeartbeat = () => {
      const keys = tabsRef.current.map((tab) => tab.key);
      if (keys.length === 0) return;
      void api.heartbeat(keys).catch(() => {});
    };
    sendHeartbeat();
    const timer = window.setInterval(sendHeartbeat, 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") sendHeartbeat();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  const refreshSessions = useCallback(() => {
    void Promise.all([
      api.sessions("recent", defaultBackend.current),
      api.sessions("archived", defaultBackend.current),
    ]).then(([recent, archived]) => {
      if (recent.ok) setResumeSessions(recent.sessions);
      if (archived.ok) setArchivedSessions(archived.sessions);
    });
  }, []);

  useEffect(() => {
    refreshSessions();
    const unsubscribe = subscribeEvents(
      (event: AgentEvent) => {
        const key = event.sessionKey;
        if (!key) return;
        const timeline = timelines.get(key);
        timeline?.handle(event);
        setWorkingKeys((current) => {
          const working = timelineIsWorking(timeline);
          if (working === current.has(key)) return current;
          const next = new Set(current);
          if (working) next.add(key);
          else next.delete(key);
          return next;
        });
        if (event.type === "agent_settled") {
          notify(
            "Turn finished",
            `${timeline?.state?.sessionName || "A session"} is done.`,
            `done:${key}`,
          );
        }
        if (
          event.type === "agent_settled" ||
          event.type === "session_title_set"
        )
          refreshSessions();
      },
      (status) => {
        // Self-heal after a stream drop (server restart, network blip): a
        // mid-turn "working" flag can otherwise stick forever, because the
        // completion event is lost with the connection. On re-connect, ask
        // the server for each open session's true state and correct the
        // timeline. The first connect is skipped — tabs hydrate themselves
        // on mount and an optimistic pending run must not be clobbered.
        if (status !== "connected") return;
        if (firstStreamConnect) {
          firstStreamConnect = false;
          return;
        }
        for (const tab of tabsRef.current) {
          void api
            .sessionState(tab.key, tab.backend)
            .then((result) => {
              const timeline = timelines.get(tab.key);
              if (!timeline) return;
              if (result.state) timeline.setState(result.state);
              else timeline.clearPendingRun();
            })
            .catch(() => {
              /* server unreachable again; next reconnect retries */
            });
        }
      },
    );
    return unsubscribe;
  }, [refreshSessions]);

  // The generated title reaches the UI two ways: the session_title_set event
  // (live) and the saved session list (a reload, where that event belonged to
  // the previous page's session key). Feed the saved title into the timeline
  // so both paths land on the same sticky value instead of leaving a
  // refreshed tab on its prompt-derived — or cwd-derived — fallback.
  useEffect(() => {
    if (resumeSessions.length === 0) return;
    const savedByPath = new Map(
      resumeSessions.map((session) => [session.path, session]),
    );
    for (const tab of tabsRef.current) {
      const path = tab.sessionPath ?? tab.timeline.state?.sessionFile;
      const saved = path ? savedByPath.get(path) : undefined;
      if (!saved?.name) continue;
      // sessions.js falls back to `name || firstPrompt`; only a name that is
      // genuinely stored on the session is a real title.
      if (saved.name.trim() === (saved.firstPrompt ?? "").trim()) continue;
      tab.timeline.applySessionName(saved.name);
    }
  }, [resumeSessions]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshSessions();
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const timer = window.setInterval(refreshWhenVisible, 30_000);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.clearInterval(timer);
    };
  }, [refreshSessions]);

  useEffect(() => {
    const recompute = () => {
      setAwaitingKeys((current) => {
        const next = new Set<string>();
        for (const tab of tabsRef.current) {
          if (
            isAwaitingAnswer(
              tab.timeline.items,
              timelineIsWorking(tab.timeline),
            )
          )
            next.add(tab.key);
        }
        if (
          next.size === current.size &&
          [...next].every((key) => current.has(key))
        )
          return current;
        return next;
      });
    };
    recompute();
    // Timeline subscriptions, not the SSE stream: sending a prompt answers the
    // question locally and emits no server event, and the badge has to clear
    // right then rather than when the backend next says something.
    const unsubscribes = tabs.map((tab) => tab.timeline.subscribe(recompute));
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [tabs]);

  const createConversationTab = useCallback(
    (
      cwd: string,
      label?: string,
      sessionPath?: string,
      backend = defaultBackend.current,
    ): ConversationTab => {
      // Include a page-scoped UUID so separate browser windows never bind to the
      // same Pi RPC process (each page's local counter otherwise starts at 1).
      const key = `conv-${pageSessionId}-${counter++}`;
      const tab: ConversationTab = {
        key,
        label: label ?? cwd.split("/").filter(Boolean).at(-1) ?? cwd,
        cwd,
        sessionPath,
        backend,
        isFresh: sessionPath === undefined,
        timeline: timelineFor(key),
      };
      // Keep the ref in sync immediately. This prevents two quick clicks on
      // "New session" from racing the React state update and creating twins.
      tabsRef.current = [...tabsRef.current, tab];
      setTabs(tabsRef.current);
      setActiveKey(key);
      return tab;
    },
    [],
  );

  const openConversation = useCallback(
    (cwd: string, label?: string, backend = defaultBackend.current): string => {
      const freshTab = tabsRef.current.find(
        (candidate) =>
          candidate.backend === backend &&
          candidate.cwd === cwd &&
          candidate.isFresh &&
          !candidate.timeline.items.some(
            (item) =>
              item.kind === "user" ||
              item.kind === "assistant" ||
              item.kind === "tool",
          ),
      );
      if (freshTab) {
        setActiveKey(freshTab.key);
        return freshTab.key;
      }
      const tab = createConversationTab(cwd, label, undefined, backend);
      const preferredModel =
        backend === "claude"
          ? CLAUDE_DEFAULT_MODEL
          : preferredModels.current.get(modelPreferenceKey(backend, cwd));
      if (backend === "claude") {
        tab.timeline.setState({
          model: CLAUDE_DEFAULT_MODEL,
          thinkingLevel: CLAUDE_DEFAULT_EFFORT,
          isStreaming: false,
          sessionId: "",
          messageCount: 0,
          pendingMessageCount: 0,
        });
      }
      // Grok stays lazy even for fresh conversations: starting the agent just
      // to show an empty composer made grok write a session file (an empty
      // "Untitled session" ghost in the sidebar) per workbench visit. The
      // prompt route starts the agent on the first message, carrying this
      // tab's cwd/model/effort from the prompt context.
      if (backend === "grok") {
        tab.timeline.setState({
          model: preferredModel ?? null,
          thinkingLevel: "off",
          isStreaming: false,
          sessionId: "",
          messageCount: 0,
          pendingMessageCount: 0,
        });
        return tab.key;
      }
      void api
        .start(
          tab.key,
          cwd,
          backend,
          preferredModel,
          undefined,
          backend === "claude" ? CLAUDE_DEFAULT_EFFORT : undefined,
        )
        .then((result) => {
          if (result.ok && result.state) tab.timeline.setState(result.state);
          else if (!result.ok)
            tab.timeline.appendNotice(
              result.error ?? `${backendLabel(backend)} could not be started`,
              "error",
            );
        });
      return tab.key;
    },
    [createConversationTab],
  );

  const openDefaultConversation = useCallback(async (): Promise<string> => {
    let cwd = defaultCwd.current;
    if (!cwd) {
      const requestedCwd = new URLSearchParams(window.location.search)
        .get("cwd")
        ?.trim();
      if (requestedCwd) {
        cwd = requestedCwd;
      } else {
        // The workbench can land here while the API server is restarting
        // (e.g. immediately after switching backends reloads the page). Retry
        // instead of throwing and leaving no conversation open at all.
        for (let attempt = 0; attempt < 6; attempt += 1) {
          try {
            const result = await api.health();
            cwd = result.cwd || ".";
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 750));
          }
        }
      }
      defaultCwd.current = cwd || ".";
    }
    if (!cwd) return "";
    return openConversation(cwd);
  }, [openConversation]);

  /**
   * A reload during an executing turn loses everything streamed since the
   * turn began: the session file only records completed turns, so the
   * in-flight user message, partial assistant text, running tool cards, and
   * todo snapshots vanish. The server's runtime event log holds every event
   * of the live run — replaying it reconstructs the transcript and merges
   * with events that keep arriving over SSE. If the run settled while the
   * log was being fetched, its messages are persisted by then, so the
   * session file is re-read instead.
   */
  const restoreLiveTurn = useCallback((key: string, timeline: Timeline) => {
    void api.backendLog(key).then((result) => {
      if (!result.ok || !Array.isArray(result.entries)) return;
      const outcome = timeline.replayLiveTurn(result.entries);
      if (outcome === "live") return;
      // "settled" means the run finished while the log was in flight;
      // "none" means the log was too torn to replay. Either way the tail of
      // the turn is missing from what was hydrated a moment ago — including,
      // when the run ended on a question, the question itself, which left the
      // session looking like it had simply stopped. The session file has it.
      const sessionFile = timeline.state?.sessionFile;
      if (!sessionFile) return;
      void api.sessionMessages(sessionFile).then((refreshed) => {
        if (!refreshed.ok || !Array.isArray(refreshed.messages)) return;
        const state = timeline.state;
        if (!state) return;
        // A new turn may have started in the meantime (the user sent another
        // prompt); re-reading the file would drop its live items.
        if (timeline.status === "working" && outcome === "none") return;
        timeline.hydrate(refreshed.messages, { ...state, isStreaming: false });
      });
    });
  }, []);

  const resumeConversation = useCallback(
    (session: ResumeSession): string => {
      const existing = tabsRef.current.find(
        (tab) =>
          tab.sessionPath === session.path ||
          tab.timeline.state?.sessionFile === session.path,
      );
      if (existing) {
        setActiveKey(existing.key);
        // A tab opened under an older build (or during a backend hiccup) may
        // have resolved to an empty timeline and cached that. Re-fetch the
        // history instead of showing the ghost forever.
        if (
          existing.timeline.items.length === 0 &&
          (existing.sessionPath ?? existing.timeline.state?.sessionFile)
        ) {
          const existingKey = existing.key;
          const existingPath =
            existing.sessionPath ?? existing.timeline.state!.sessionFile!;
          void api.sessionMessages(existingPath).then((result) => {
            if (
              !result.ok ||
              !Array.isArray(result.messages) ||
              result.messages.length === 0
            )
              return;
            if (
              tabsRef.current.some(
                (candidate) =>
                  candidate.key === existingKey &&
                  candidate.timeline.items.length === 0,
              )
            ) {
              existing.timeline.hydrate(result.messages, {
                ...(existing.timeline.state ?? {
                  model: null,
                  thinkingLevel: "off",
                  isStreaming: false,
                  sessionId: "",
                  messageCount: 0,
                  pendingMessageCount: 0,
                }),
                isStreaming: false,
              });
            }
          });
        }
        return existing.key;
      }

      const tab = createConversationTab(
        session.cwd,
        savedSessionTitle(session.name, session.firstPrompt),
        session.path,
        session.backend ?? "pi",
      );
      const timeline = tab.timeline;
      const restoredModel =
        tab.backend === "claude" && session.lastModel
          ? claudeModelInfo(session.lastModel)
          : undefined;
      const placeholderState = {
        model: restoredModel ?? null,
        thinkingLevel:
          session.lastEffort ||
          (tab.backend === "claude" ? CLAUDE_DEFAULT_EFFORT : "off"),
        isStreaming: false,
        sessionId: "",
        sessionFile: session.path,
        messageCount: 0,
        pendingMessageCount: 0,
      };
      timeline.setState(placeholderState);
      // The transcript is read straight from disk; no agent process starts
      // until the first message is sent (the prompt route starts it on demand
      // with this session's context). Spawning the backend just to display
      // saved history made every session click feel like a round-trip.
      void api.sessionMessages(session.path).then((result) => {
        if (
          !result.ok ||
          !Array.isArray(result.messages) ||
          result.messages.length === 0
        )
          return;
        // Never let a from-disk hydration clobber a live run: if a
        // mid-turn reload adopted the streaming agent, this late-arriving
        // read is stale by definition.
        if (timeline.state?.isStreaming) return;
        timeline.hydrate(result.messages, {
          ...(timeline.state ?? placeholderState),
          isStreaming: false,
        });
      });
      if (tab.backend === "grok") {
        // Grok stays lazy for viewing — but a live process running this
        // session (page refreshed mid-turn) is adopted, never spawned, so
        // the in-flight run re-attaches without paying the ghost-session
        // cost that made grok lazy in the first place.
        void api
          .start(
            tab.key,
            session.cwd,
            "grok",
            undefined,
            session.path,
            undefined,
            true,
          )
          .then((adopted) => {
            if (!adopted.ok || !adopted.state?.isStreaming) return;
            // Order matters: mark streaming first (guards the generic
            // hydration above), then persisted history, then the replayed
            // live run on top of it.
            timeline.setState(adopted.state);
            void api.sessionMessages(session.path).then((persisted) => {
              if (
                persisted.ok &&
                Array.isArray(persisted.messages) &&
                persisted.messages.length > 0 &&
                adopted.state
              ) {
                timeline.hydrate(persisted.messages, adopted.state);
              }
              void restoreLiveTurn(tab.key, timeline);
            });
          });
        return tab.key;
      }
      void api
        .start(
          tab.key,
          session.cwd,
          tab.backend,
          restoredModel ?? undefined,
          session.path,
          tab.backend === "claude" ? session.lastEffort : undefined,
        )
        .then(async (startResult) => {
          if (!startResult.ok) {
            timeline.appendNotice(
              startResult.error ??
                `${backendLabel(tab.backend)} could not be started`,
              "error",
            );
            return;
          }
          if (startResult.state) {
            // Keep isStreaming as reported: the process may genuinely be
            // mid-run (e.g. the page was refreshed while the agent was
            // streaming) and the UI must show that run as active.
            const resumedState = startResult.state;
            if (
              Array.isArray(startResult.messages) &&
              startResult.messages.length > 0
            ) {
              timeline.hydrate(startResult.messages, resumedState);
            } else {
              timeline.setState(resumedState);
            }
            setTabs((current) =>
              current.map((candidate) =>
                candidate.key === tab.key
                  ? {
                      ...candidate,
                      sessionPath:
                        startResult.state?.sessionFile ?? session.path,
                    }
                  : candidate,
              ),
            );
            refreshSessions();
            if (resumedState.isStreaming) {
              // A refresh that adopted a live process must never fall through
              // to the resume branch below: switch_session aborts a running
              // turn ("request was aborted"), which is exactly the state the
              // reload was supposed to preserve. Restore it in place instead —
              // persisted history first (adopting returns state only), then
              // the in-flight turn, which exists solely in the server's
              // runtime log: partial text, tool cards, and todos.
              if (
                !Array.isArray(startResult.messages) ||
                startResult.messages.length === 0
              ) {
                const persisted = await api.sessionMessages(session.path);
                if (
                  persisted.ok &&
                  Array.isArray(persisted.messages) &&
                  persisted.messages.length > 0
                ) {
                  timeline.hydrate(persisted.messages, resumedState);
                }
              }
              void restoreLiveTurn(tab.key, timeline);
              return;
            }
            if (timeline.items.length > 0) return;
          }
          const result = await api.resume(tab.key, session.path);
          if (result.ok && result.state && Array.isArray(result.messages)) {
            // Same as above: a still-running turn stays visibly running
            // instead of being flattened (and aborted) on restore.
            timeline.hydrate(result.messages, result.state);
            setTabs((current) =>
              current.map((candidate) =>
                candidate.key === tab.key
                  ? {
                      ...candidate,
                      sessionPath: result.state?.sessionFile ?? session.path,
                    }
                  : candidate,
              ),
            );
            refreshSessions();
            if (result.state.isStreaming)
              void restoreLiveTurn(tab.key, timeline);
          } else {
            timeline.reset(startResult.state ?? null);
            timeline.appendNotice(
              result.error ??
                `Could not resume the ${backendLabel(tab.backend)} session`,
              "error",
            );
            void api.stop(tab.key);
          }
        })
        .catch((error) => {
          timeline.reset(null);
          timeline.appendNotice(
            `Could not resume the ${backendLabel(tab.backend)} session: ${String(error?.message ?? error)}`,
            "error",
          );
          void api.stop(tab.key);
        });
      return tab.key;
    },
    [createConversationTab, refreshSessions, restoreLiveTurn],
  );

  // A forked branch becomes its own conversation: seeded instantly with the
  // transcript up to the fork point, then started against the branch file.
  const openForkedConversation = useCallback(
    ({
      cwd,
      sessionPath,
      messages,
      state,
      label,
      backend,
    }: {
      cwd: string;
      sessionPath: string;
      messages: SessionHistoryMessage[];
      state?: SessionState | null;
      label?: string;
      backend?: AgentBackend;
    }): string => {
      const forkBackend = backend ?? defaultBackend.current;
      const tab = createConversationTab(
        cwd,
        label ?? `${cwd.split("/").filter(Boolean).at(-1) ?? cwd} · fork`,
        sessionPath,
        forkBackend,
      );
      const timeline = tab.timeline;
      timeline.setState({
        ...(state ?? {
          model: null,
          thinkingLevel:
            forkBackend === "claude" ? CLAUDE_DEFAULT_EFFORT : "off",
          sessionId: "",
          messageCount: 0,
          pendingMessageCount: 0,
        }),
        sessionFile: state?.sessionFile ?? sessionPath,
        isStreaming: false,
      });
      if (Array.isArray(messages) && messages.length > 0 && timeline.state) {
        timeline.hydrate(messages, timeline.state);
      }
      void api
        .start(
          tab.key,
          cwd,
          forkBackend,
          state?.model ?? undefined,
          sessionPath,
          state?.thinkingLevel,
        )
        .then((startResult) => {
          if (!startResult.ok) {
            timeline.appendNotice(
              startResult.error ?? "The forked session could not be started",
              "error",
            );
            return;
          }
          if (startResult.state) {
            const resumedState = startResult.state.isStreaming
              ? { ...startResult.state, isStreaming: false }
              : startResult.state;
            if (
              Array.isArray(startResult.messages) &&
              startResult.messages.length > 0
            ) {
              timeline.hydrate(startResult.messages, resumedState);
            } else {
              timeline.setState(resumedState);
            }
            setTabs((current) =>
              current.map((candidate) =>
                candidate.key === tab.key
                  ? {
                      ...candidate,
                      sessionPath:
                        startResult.state?.sessionFile ?? sessionPath,
                    }
                  : candidate,
              ),
            );
            refreshSessions();
          }
        })
        .catch((error) => {
          timeline.appendNotice(
            `Could not start the forked session: ${String(error?.message ?? error)}`,
            "error",
          );
        });
      return tab.key;
    },
    [createConversationTab, refreshSessions],
  );

  useEffect(() => {
    if (didOpenInitialSession.current) return;
    didOpenInitialSession.current = true;

    const stored = persistedOpenSessions.current;
    const split = localStorage.getItem("pi-web.session-layout") === "split";
    const sessionsToRestore = split
      ? stored
      : ([stored.find((session) => session.active) ?? stored.at(-1)].filter(
          Boolean,
        ) as PersistedOpenSession[]);
    if (sessionsToRestore.length === 0) {
      void openDefaultConversation();
      return;
    }

    let activeRestoredKey = "";
    for (const session of sessionsToRestore) {
      const key = session.sessionPath
        ? resumeConversation({
            path: session.sessionPath,
            name: session.label,
            cwd: session.cwd,
            createdAt: 0,
            modifiedAt: 0,
            messageCount: 0,
            backend: session.backend,
            lastModel: session.model?.id,
            lastEffort: session.thinkingLevel,
          })
        : openConversation(session.cwd, session.label, session.backend);
      if (session.active) activeRestoredKey = key;
    }
    if (activeRestoredKey) setActiveKey(activeRestoredKey);
  }, [openConversation, openDefaultConversation, resumeConversation]);

  useEffect(() => {
    if (!didOpenInitialSession.current) return;
    // Do not let the provider's first empty render erase the snapshot that the
    // restoration effect above still needs to consume.
    if (!didRenderRestoredSessions.current) {
      if (tabs.length === 0) return;
      didRenderRestoredSessions.current = true;
    }
    const snapshot: PersistedOpenSession[] = tabs.map((tab) => ({
      cwd: tab.cwd,
      label: tab.label,
      backend: tab.backend,
      sessionPath: tab.sessionPath ?? tab.timeline.state?.sessionFile,
      model: tab.timeline.state?.model,
      thinkingLevel: tab.timeline.state?.thinkingLevel,
      active: tab.key === activeKey,
    }));
    localStorage.setItem(
      openSessionsStorageKey(defaultBackend.current),
      JSON.stringify(snapshot),
    );
  }, [activeKey, tabs]);

  const closeConversation = useCallback((key: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.key !== key);
      tabsRef.current = next;
      setActiveKey((active) =>
        active === key ? (next.at(-1)?.key ?? "") : active,
      );
      return next;
    });
    timelines.delete(key);
    setWorkingKeys((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    void api.stop(key);
  }, []);

  const archiveSession = useCallback(
    async (session: ResumeSession): Promise<SessionMutationResponse> => {
      const result = await api.archiveSession(session.path);
      if (result.ok) refreshSessions();
      return result;
    },
    [refreshSessions],
  );

  const restoreSession = useCallback(
    async (session: ResumeSession): Promise<SessionMutationResponse> => {
      const result = await api.restoreSession(session.path);
      if (result.ok) refreshSessions();
      return result;
    },
    [refreshSessions],
  );

  const deleteSession = useCallback(
    async (session: ResumeSession): Promise<SessionMutationResponse> => {
      const matchingTabs = tabs.filter(
        (tab) =>
          tab.sessionPath === session.path ||
          tab.timeline.state?.sessionFile === session.path,
      );
      await Promise.all(matchingTabs.map((tab) => api.stop(tab.key)));
      const result = await api.deleteSession(session.path);
      if (!result.ok) return result;

      const removedKeys = new Set(matchingTabs.map((tab) => tab.key));
      setTabs((current) => {
        const next = current.filter((tab) => !removedKeys.has(tab.key));
        setActiveKey((currentActive) =>
          removedKeys.has(currentActive)
            ? (next.at(-1)?.key ?? "")
            : currentActive,
        );
        return next;
      });
      for (const tab of matchingTabs) timelines.delete(tab.key);
      setWorkingKeys((current) => {
        let changed = false;
        const next = new Set(current);
        for (const key of removedKeys) {
          if (next.delete(key)) changed = true;
        }
        return changed ? next : current;
      });
      refreshSessions();
      return result;
    },
    [refreshSessions, tabs],
  );

  const active = useMemo(
    () => tabs.find((tab) => tab.key === activeKey),
    [tabs, activeKey],
  );

  const setConversationSessionPath = useCallback(
    (key: string, path?: string) => {
      setTabs((current) =>
        current.map((tab) =>
          tab.key === key && (tab.sessionPath !== path || path === undefined)
            ? {
                ...tab,
                sessionPath: path,
                ...(path === undefined
                  ? {
                      label:
                        tab.cwd.split("/").filter(Boolean).at(-1) ?? tab.cwd,
                    }
                  : {}),
              }
            : tab,
        ),
      );
    },
    [],
  );

  const setConversationLabel = useCallback((key: string, label: string) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.key === key && tab.label !== label ? { ...tab, label } : tab,
      ),
    );
  }, []);

  const setConversationWorkspace = useCallback((key: string, cwd: string) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.key === key
          ? {
              ...tab,
              cwd,
              label: cwd.split("/").filter(Boolean).at(-1) ?? cwd,
              sessionPath: undefined,
            }
          : tab,
      ),
    );
  }, []);

  const revealWorkspace = useCallback((key: string) => {
    setWorkspaceReveal({ key, nonce: Date.now() });
  }, []);

  const setPreferredModel = useCallback(
    (backend: AgentBackend, cwd: string, model: ModelInfo | null) => {
      const key = modelPreferenceKey(backend, cwd);
      if (model) preferredModels.current.set(key, model);
      else preferredModels.current.delete(key);
    },
    [],
  );

  const value: StoreValue = {
    tabs,
    activeKey,
    active,
    workingKeys,
    awaitingKeys,
    resumeSessions,
    archivedSessions,
    openConversation,
    openDefaultConversation,
    resumeConversation,
    openForkedConversation,
    closeConversation,
    setActiveKey,
    setConversationSessionPath,
    setConversationLabel,
    setConversationWorkspace,
    archiveSession,
    restoreSession,
    deleteSession,
    refreshSessions,
    setPreferredModel,
    workspaceReveal,
    revealWorkspace,
  };

  return (
    <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
  );
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used under StoreProvider");
  return ctx;
}

/** Re-render the calling component whenever the timeline changes. */
export function useTimeline(timeline: Timeline | undefined) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!timeline) return;
    return timeline.subscribe(() => setTick((t) => t + 1));
  }, [timeline]);
  return timeline;
}
