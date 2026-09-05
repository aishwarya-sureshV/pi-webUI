import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useStore } from "../lib/store";
import { createPortal } from "react-dom";
import {
  api,
  backendLabel,
  type AgentBackend,
  type SessionSearchResult,
} from "../lib/api";
import type { WorkbenchView } from "../lib/navigation";
import { formatRelativeTime } from "../lib/time";
import { savedSessionTitle } from "../lib/sessionTitle";
import { textAwaitsAnswer } from "../lib/awaitingAnswer";
import {
  formatSessionModelName,
  sessionUsesModel,
  uniqueSessionModels,
} from "../lib/sessionModels";
import {
  FishLogo,
  IconArchive,
  IconChevronDown,
  IconCode,
  IconCube,
  IconDots,
  IconExtension,
  IconFilter,
  IconFolder,
  IconMoon,
  IconNewChat,
  IconPanel,
  IconRestore,
  IconSearch,
  IconSettings,
  IconSun,
  IconTrash,
  IconColumns,
} from "./icons";

function workspaceLabel(cwd: string): string {
  if (/^\/Users\/[^/]+\/?$/.test(cwd)) return "Home";
  return cwd.split("/").filter(Boolean).at(-1) || cwd || "Other";
}

export function Sidebar({
  collapsed,
  onToggle,
  theme,
  onThemeToggle,
  view,
  onViewChange,
  splitSessions,
  onSplitSessionsToggle,
  onSessionFocus,
  onSessionSplit,
  openTabKeys,
  onResizePointerDown,
  onResizeKeyDown,
}: {
  collapsed: boolean;
  onToggle: () => void;
  theme: "light" | "dark";
  onThemeToggle: () => void;
  view: WorkbenchView;
  onViewChange: (view: WorkbenchView) => void;
  splitSessions: boolean;
  onSplitSessionsToggle: () => void;
  onSessionFocus: (key: string) => void;
  onSessionSplit: (key: string) => void;
  openTabKeys: string[];
  onResizePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onResizeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  const [sessionView, setSessionView] = useState<"recent" | "archived">(
    "recent",
  );
  const [modelFilter, setModelFilter] = useState(
    () => localStorage.getItem("pi-web.session-model-filter") || "",
  );
  // Full-text search across saved transcripts, not just their titles.
  const [transcriptQuery, setTranscriptQuery] = useState("");
  const [transcriptHits, setTranscriptHits] = useState<SessionSearchResult[]>(
    [],
  );
  const [transcriptSearching, setTranscriptSearching] = useState(false);
  // Collapsed by default: search and filters open from icons in the header.
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [openSessionMenu, setOpenSessionMenu] = useState<string | null>(null);

  const [openWorkspaceMenu, setOpenWorkspaceMenu] = useState<string | null>(
    null,
  );
  const [backendMenuOpen, setBackendMenuOpen] = useState(false);
  const requestedBackend = new URLSearchParams(window.location.search).get(
    "backend",
  );
  const currentBackend: AgentBackend =
    requestedBackend === "claude" || requestedBackend === "grok"
      ? requestedBackend
      : "pi";
  // Debounced: reading transcripts is far heavier than filtering titles, so
  // it waits for a pause in typing rather than firing per keystroke.
  useEffect(() => {
    const query = transcriptQuery.trim();
    if (query.length < 2) {
      setTranscriptHits([]);
      setTranscriptSearching(false);
      return;
    }
    let cancelled = false;
    setTranscriptSearching(true);
    const timer = window.setTimeout(() => {
      void api
        .searchSessions(query, currentBackend)
        .then((result) => {
          if (cancelled) return;
          setTranscriptHits(result.ok ? (result.results ?? []) : []);
          setTranscriptSearching(false);
        })
        .catch(() => {
          if (cancelled) return;
          setTranscriptHits([]);
          setTranscriptSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [transcriptQuery, currentBackend]);

  const [sessionMenuOpensUp, setSessionMenuOpensUp] = useState(false);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<
    ReadonlySet<string>
  >(new Set());
  const initializedWorkspaceGroups = useRef(false);
  const {
    tabs,
    activeKey,
    workingKeys,
    awaitingKeys,
    setActiveKey,
    closeConversation,
    openDefaultConversation,
    openConversation,
    resumeConversation,
    revealWorkspace,
    resumeSessions,
    archivedSessions,
    archiveSession,
    restoreSession,
    deleteSession,
  } = useStore();

  const openTabs = openTabKeys.flatMap((key) => {
    const tab = tabs.find((candidate) => candidate.key === key);
    return tab ? [tab] : [];
  });
  const savedSessions =
    sessionView === "archived" ? archivedSessions : resumeSessions;
  const modelOptions = useMemo(() => {
    const options = uniqueSessionModels(savedSessions);
    if (modelFilter && !options.some((option) => option.id === modelFilter)) {
      options.unshift({
        id: modelFilter,
        label: formatSessionModelName(modelFilter),
      });
    }
    return options;
  }, [modelFilter, savedSessions]);
  const visibleSessions = useMemo(() => {
    const matched = modelFilter
      ? savedSessions.filter((session) =>
          sessionUsesModel(session, modelFilter),
        )
      : savedSessions;
    return modelFilter ? matched : matched.slice(0, 60);
  }, [modelFilter, savedSessions]);
  const workspaceGroups = useMemo(() => {
    const groups = new Map<string, typeof visibleSessions>();
    for (const session of visibleSessions) {
      const key = session.cwd || "Other";
      groups.set(key, [...(groups.get(key) ?? []), session]);
    }
    return [...groups.entries()].map(([cwd, sessions]) => ({
      cwd,
      label: workspaceLabel(cwd),
      sessions,
    }));
  }, [visibleSessions]);

  useEffect(() => {
    if (initializedWorkspaceGroups.current || workspaceGroups.length === 0)
      return;
    initializedWorkspaceGroups.current = true;
    const openWorkspaces = new Set(tabs.map((tab) => tab.cwd));
    setCollapsedWorkspaces(
      new Set(
        workspaceGroups
          .filter((group) => !openWorkspaces.has(group.cwd))
          .map((group) => group.cwd),
      ),
    );
  }, [tabs, workspaceGroups]);

  useEffect(() => {
    if (!openSessionMenu && !openWorkspaceMenu && !backendMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        !target.closest(".sidebar__floating-menu")
      ) {
        setOpenSessionMenu(null);
        setOpenWorkspaceMenu(null);
        setBackendMenuOpen(false);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenSessionMenu(null);
        setOpenWorkspaceMenu(null);
        setBackendMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openSessionMenu, openWorkspaceMenu, backendMenuOpen]);

  const startFresh = async (cwd?: string) => {
    onViewChange("sessions");
    const key = cwd ? openConversation(cwd) : await openDefaultConversation();
    onSessionFocus(key);
  };

  const switchBackend = (next: AgentBackend) => {
    setBackendMenuOpen(false);
    if (next === currentBackend) return;
    const params = new URLSearchParams(window.location.search);
    if (next === "claude" || next === "grok") params.set("backend", next);
    else params.delete("backend");
    const query = params.toString();
    window.location.assign(
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
  };

  const handleArchive = async (session: (typeof savedSessions)[number]) => {
    setOpenSessionMenu(null);
    const result = await archiveSession(session);
    if (!result.ok)
      window.alert(result.error ?? "The session could not be archived.");
  };

  const handleRestore = async (session: (typeof savedSessions)[number]) => {
    setOpenSessionMenu(null);
    const result = await restoreSession(session);
    if (!result.ok)
      window.alert(result.error ?? "The session could not be restored.");
  };

  const handleDelete = async (session: (typeof savedSessions)[number]) => {
    setOpenSessionMenu(null);
    const confirmed = window.confirm(
      `Permanently delete “${session.name}”?\n\nThis removes the saved ${backendLabel(session.backend)} session and cannot be undone.`,
    );
    if (!confirmed) return;
    const result = await deleteSession(session);
    if (!result.ok)
      window.alert(result.error ?? "The session could not be deleted.");
  };

  const toggleWorkspace = (cwd: string) => {
    setCollapsedWorkspaces((current) => {
      const next = new Set(current);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  };

  const chooseModelFilter = (next: string) => {
    setModelFilter(next);
    if (next) localStorage.setItem("pi-web.session-model-filter", next);
    else localStorage.removeItem("pi-web.session-model-filter");
  };

  const chooseView = (next: WorkbenchView) => {
    onViewChange(next);
    setOpenSessionMenu(null);
    setOpenWorkspaceMenu(null);
  };

  const focusOpenSession = (key: string) => {
    setActiveKey(key);
    onSessionFocus(key);
    chooseView("sessions");
  };

  const splitOpenSession = (key: string) => {
    onSessionSplit(key);
    setActiveKey(key);
    chooseView("sessions");
  };

  const openSearchHit = (hit: SessionSearchResult) => {
    const key = resumeConversation({
      path: hit.path,
      name: hit.name,
      cwd: hit.cwd,
      createdAt: hit.modifiedAt,
      modifiedAt: hit.modifiedAt,
      messageCount: hit.messageCount,
      backend: hit.backend,
    });
    onSessionFocus(key);
    chooseView("sessions");
  };

  const focusSavedSession = (session: (typeof savedSessions)[number]) => {
    const key = resumeConversation(session);
    onSessionFocus(key);
    chooseView("sessions");
  };

  const splitSavedSession = (session: (typeof savedSessions)[number]) => {
    const key = resumeConversation(session);
    onSessionSplit(key);
    chooseView("sessions");
  };

  return (
    <aside className={`sidebar${collapsed ? " is-collapsed" : ""}`}>
      <div className="sidebar__brand-row">
        {!collapsed && (
          <div className="sidebar__brand">
            <FishLogo size={25} />
            <div className="sidebar__backend-menu sidebar__floating-menu">
              <button
                type="button"
                className="sidebar__backend-trigger"
                aria-haspopup="menu"
                aria-expanded={backendMenuOpen}
                aria-label={`Current workbench: ${backendLabel(currentBackend)}. Open workbench menu.`}
                onClick={() => {
                  setOpenSessionMenu(null);
                  setOpenWorkspaceMenu(null);
                  setBackendMenuOpen((open) => !open);
                }}
              >
                <span>{currentBackend}</span>
                <IconChevronDown size={14} />
              </button>
              {backendMenuOpen && (
                <div
                  className="sidebar__session-popover sidebar__backend-popover"
                  role="menu"
                >
                  <button
                    type="button"
                    role="menuitem"
                    className={
                      currentBackend === "pi" ? "is-active" : undefined
                    }
                    onClick={() => switchBackend("pi")}
                  >
                    Pi
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={
                      currentBackend === "claude" ? "is-active" : undefined
                    }
                    onClick={() => switchBackend("claude")}
                  >
                    Claude
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={
                      currentBackend === "grok" ? "is-active" : undefined
                    }
                    onClick={() => switchBackend("grok")}
                  >
                    Grok
                  </button>
                </div>
              )}
            </div>
            <em>WORKBENCH</em>
          </div>
        )}
        <button
          type="button"
          className="sidebar__icon-btn sidebar__toggle"
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed && (
            <span className="sidebar__rail-fish">
              <FishLogo size={24} />
            </span>
          )}
          <span className="sidebar__panel-icon">
            <IconPanel size={collapsed ? 18 : 16} />
          </span>
        </button>
      </div>

      <button
        type="button"
        className="sidebar__new"
        onClick={() => startFresh()}
        aria-label="New session"
      >
        <IconNewChat size={collapsed ? 18 : 15} />
        {!collapsed && <span>New session</span>}
      </button>

      <nav className="sidebar__nav" aria-label="Workbench">
        <SidebarNavButton
          collapsed={collapsed}
          active={view === "sessions"}
          label="Sessions"
          live={workingKeys.size > 0}
          onClick={() => chooseView("sessions")}
          icon={<IconFolder size={18} />}
        />
        <SidebarNavButton
          collapsed={collapsed}
          active={view === "fleet"}
          label="Fleet"
          live={workingKeys.size > 1}
          onClick={() => chooseView("fleet")}
          icon={<IconPanel size={18} />}
        />
        <SidebarNavButton
          collapsed={collapsed}
          active={view === "skills"}
          label="Skills"
          onClick={() => chooseView("skills")}
          icon={<IconCube size={18} />}
        />
        <SidebarNavButton
          collapsed={collapsed}
          active={view === "extensions"}
          label="Extensions"
          onClick={() => chooseView("extensions")}
          icon={<IconExtension size={18} />}
        />
        <SidebarNavButton
          collapsed={collapsed}
          active={view === "settings"}
          label="Settings"
          onClick={() => chooseView("settings")}
          icon={<IconSettings size={18} />}
        />
      </nav>

      {!collapsed && (
        <div className="sidebar__section">
          {openTabs.length > 0 && (
            <div className="sidebar__open-head">
              <div className="sidebar__heading">Open</div>
              <button
                type="button"
                className={splitSessions ? "is-active" : ""}
                aria-pressed={splitSessions}
                aria-label={
                  splitSessions
                    ? "Show one session at a time"
                    : "Show sessions side by side"
                }
                title={splitSessions ? "Focus one session" : "Split sessions"}
                onClick={onSplitSessionsToggle}
              >
                <IconColumns />
              </button>
            </div>
          )}
          {openTabs.map((tab) => (
            <div className="sidebar__item-row" key={tab.key}>
              <button
                type="button"
                className={`sidebar__item${tab.key === activeKey && view === "sessions" ? " is-active" : ""}${workingKeys.has(tab.key) ? " is-running" : ""}${awaitingKeys.has(tab.key) ? " is-awaiting" : ""}`}
                aria-label={
                  workingKeys.has(tab.key)
                    ? `${tab.label}, running`
                    : awaitingKeys.has(tab.key)
                      ? `${tab.label}, waiting for your answer`
                      : undefined
                }
                onClick={() => focusOpenSession(tab.key)}
                title={tab.cwd}
              >
                {workingKeys.has(tab.key) && (
                  <span
                    className="sidebar__run-dot"
                    title="Running"
                    aria-hidden="true"
                  />
                )}
                {!workingKeys.has(tab.key) && awaitingKeys.has(tab.key) && (
                  <span
                    className="sidebar__await-dot"
                    title="Waiting for your answer"
                    aria-hidden="true"
                  />
                )}
                <span className="sidebar__item-label">{tab.label}</span>
              </button>
              <button
                type="button"
                className="sidebar__item-split"
                aria-label={`Split with ${tab.label}`}
                title="Open in split view"
                onClick={() => splitOpenSession(tab.key)}
              >
                <IconColumns size={14} />
              </button>
              <button
                type="button"
                className="sidebar__item-close"
                aria-label={`Close ${tab.label}`}
                onClick={() => closeConversation(tab.key)}
              >
                ×
              </button>
            </div>
          ))}

          <div className="sidebar__saved-head">
            <span className="sidebar__heading">Sessions</span>
            <div className="sidebar__saved-tools">
              <button
                type="button"
                className={`sidebar__tool-btn${searchOpen ? " is-active" : ""}`}
                aria-label="Search transcripts"
                aria-expanded={searchOpen}
                title="Search transcripts"
                onClick={() => {
                  setSearchOpen(true);
                  setFiltersOpen(false);
                }}
              >
                <IconSearch size={13} />
              </button>
              <button
                type="button"
                className={`sidebar__tool-btn${
                  filtersOpen || modelFilter || sessionView !== "recent"
                    ? " is-active"
                    : ""
                }`}
                aria-label="Session filters"
                aria-expanded={filtersOpen}
                title="Filters"
                onClick={() => setFiltersOpen((open) => !open)}
              >
                <IconFilter size={13} />
              </button>
            </div>
          </div>
          {searchOpen &&
            createPortal(
              <div
                className="sidebar__search-modal"
                role="dialog"
                aria-label="Search transcripts"
                onClick={() => setSearchOpen(false)}
              >
                <div
                  className="sidebar__search-panel"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="sidebar__search-bar">
                    <IconSearch size={14} />
                    <input
                      autoFocus
                      type="search"
                      aria-label="Search session transcripts"
                      placeholder="Search transcripts"
                      value={transcriptQuery}
                      onChange={(event) =>
                        setTranscriptQuery(event.target.value)
                      }
                    />
                    <button
                      type="button"
                      className="sidebar__search-close"
                      aria-label="Close search"
                      onClick={() => {
                        setSearchOpen(false);
                        setTranscriptQuery("");
                      }}
                    >
                      ×
                    </button>
                  </div>
                  <div className="sidebar__search-results">
                    {transcriptSearching && (
                      <p className="sidebar__search-note">Searching…</p>
                    )}
                    {!transcriptSearching &&
                      transcriptQuery.trim().length >= 2 &&
                      transcriptHits.length === 0 && (
                        <p className="sidebar__search-note">
                          No transcripts match.
                        </p>
                      )}
                    {transcriptQuery.trim().length < 2 && (
                      <p className="sidebar__search-note">
                        Type at least 2 characters to search transcripts.
                      </p>
                    )}
                    {transcriptHits.map((hit) => (
                      <button
                        key={hit.path}
                        type="button"
                        className="sidebar__search-hit"
                        onClick={() => {
                          openSearchHit(hit);
                          setSearchOpen(false);
                          setTranscriptQuery("");
                        }}
                      >
                        <strong>{hit.name || "Untitled session"}</strong>
                        {hit.snippets.slice(0, 2).map((snippet, index) => (
                          <span key={index}>
                            <em>{snippet.role}</em> {snippet.text}
                          </span>
                        ))}
                      </button>
                    ))}
                  </div>
                </div>
              </div>,
              document.body,
            )}
          {filtersOpen && (
            <>
              <div
                className="sidebar__backdrop"
                onClick={() => setFiltersOpen(false)}
              />
              <div className="sidebar__filters">
                <label className="sidebar__saved-select">
                  <span className="sr-only">Saved session view</span>
                  <select
                    aria-label="Saved session view"
                    value={sessionView}
                    onChange={(event) => {
                      setSessionView(
                        event.target.value as "recent" | "archived",
                      );
                      setOpenSessionMenu(null);
                    }}
                  >
                    <option value="recent">Recent</option>
                    <option value="archived">Archived</option>
                  </select>
                  <IconChevronDown size={12} />
                </label>
                <label className="sidebar__saved-select sidebar__saved-select--model">
                  <span className="sr-only">Filter sessions by model</span>
                  <select
                    aria-label="Filter sessions by model"
                    value={modelFilter}
                    onChange={(event) => chooseModelFilter(event.target.value)}
                  >
                    <option value="">All models</option>
                    {modelOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <IconChevronDown size={12} />
                </label>
              </div>
            </>
          )}

          {workspaceGroups.map((group) => {
            const groupCollapsed =
              !modelFilter && collapsedWorkspaces.has(group.cwd);
            return (
              <section className="sidebar__workspace" key={group.cwd}>
                <div className="sidebar__workspace-head">
                  <button
                    type="button"
                    className="sidebar__workspace-toggle"
                    aria-expanded={!groupCollapsed}
                    onClick={() => toggleWorkspace(group.cwd)}
                    title={group.cwd}
                  >
                    <span
                      className={`sidebar__workspace-chevron${groupCollapsed ? " is-collapsed" : ""}`}
                    >
                      ⌄
                    </span>
                    <IconFolder size={15} />
                    <span>{group.label}</span>
                    <em>{group.sessions.length}</em>
                  </button>
                  <div className="sidebar__workspace-menu sidebar__floating-menu">
                    <button
                      type="button"
                      className="sidebar__workspace-actions"
                      aria-label={`Actions for workspace ${group.label}`}
                      aria-expanded={openWorkspaceMenu === group.cwd}
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenSessionMenu(null);
                        setOpenWorkspaceMenu((current) =>
                          current === group.cwd ? null : group.cwd,
                        );
                      }}
                    >
                      <IconDots />
                    </button>
                    {openWorkspaceMenu === group.cwd && (
                      <div className="sidebar__session-popover sidebar__workspace-popover">
                        <button
                          type="button"
                          onClick={() => {
                            setOpenWorkspaceMenu(null);
                            startFresh(group.cwd);
                          }}
                        >
                          <IconNewChat /> New session here
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setOpenWorkspaceMenu(null);
                            const matching = tabs.find(
                              (tab) => tab.cwd === group.cwd,
                            );
                            const key =
                              matching?.key ?? openConversation(group.cwd);
                            revealWorkspace(key);
                            onSessionFocus(key);
                            chooseView("sessions");
                          }}
                        >
                          <IconCode /> View workspace
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setOpenWorkspaceMenu(null);
                            toggleWorkspace(group.cwd);
                          }}
                        >
                          <IconFolder />{" "}
                          {groupCollapsed
                            ? "Expand workspace"
                            : "Collapse workspace"}
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {!groupCollapsed &&
                  group.sessions.map((session) => {
                    const matchingTab = tabs.find(
                      (tab) =>
                        tab.sessionPath === session.path ||
                        tab.timeline.state?.sessionFile === session.path,
                    );
                    const isOpen = Boolean(matchingTab);
                    const isRunning = Boolean(
                      matchingTab && workingKeys.has(matchingTab.key),
                    );
                    // An open session is judged from its live timeline; a
                    // closed one from the tail the server sent, so a session
                    // parked on a question is visible before you open it.
                    const isAwaiting = matchingTab
                      ? !isRunning && awaitingKeys.has(matchingTab.key)
                      : textAwaitsAnswer(session.lastAssistantText);
                    const title = savedSessionTitle(
                      session.name,
                      session.firstPrompt,
                    );
                    return (
                      <div className="sidebar__saved-row" key={session.path}>
                        <button
                          type="button"
                          className={`sidebar__item${isOpen ? " is-active-session" : ""}${isRunning ? " is-running" : ""}${isAwaiting ? " is-awaiting" : ""}`}
                          aria-label={
                            isRunning
                              ? `${title}, running`
                              : isAwaiting
                                ? `${title}, waiting for your answer`
                                : undefined
                          }
                          title={session.path}
                          onClick={() => focusSavedSession(session)}
                        >
                          {isRunning && (
                            <span
                              className="sidebar__run-dot"
                              title="Running"
                              aria-hidden="true"
                            />
                          )}
                          {isAwaiting && (
                            <span
                              className="sidebar__await-dot"
                              title="Waiting for your answer"
                              aria-hidden="true"
                            />
                          )}
                          <span className="sidebar__item-label">{title}</span>
                          <span className="sidebar__item-meta">
                            {formatRelativeTime(session.modifiedAt)}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="sidebar__saved-split"
                          aria-label={`Split with ${title}`}
                          title="Open in split view"
                          onClick={() => splitSavedSession(session)}
                        >
                          <IconColumns size={14} />
                        </button>
                        <div className="sidebar__session-menu sidebar__floating-menu">
                          <button
                            type="button"
                            className="sidebar__session-trigger"
                            aria-label={`Actions for ${title}`}
                            aria-expanded={openSessionMenu === session.path}
                            onClick={(event) => {
                              event.stopPropagation();
                              const rect =
                                event.currentTarget.getBoundingClientRect();
                              setSessionMenuOpensUp(
                                window.innerHeight - rect.bottom < 116,
                              );
                              setOpenWorkspaceMenu(null);
                              setOpenSessionMenu((current) =>
                                current === session.path ? null : session.path,
                              );
                            }}
                          >
                            <IconDots />
                          </button>
                          {openSessionMenu === session.path && (
                            <div
                              className={`sidebar__session-popover${sessionMenuOpensUp ? " is-upwards" : ""}`}
                            >
                              {sessionView === "recent" ? (
                                <button
                                  type="button"
                                  onClick={() => void handleArchive(session)}
                                >
                                  <IconArchive /> Archive
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => void handleRestore(session)}
                                >
                                  <IconRestore /> Restore
                                </button>
                              )}
                              <button
                                type="button"
                                className="is-danger"
                                onClick={() => void handleDelete(session)}
                              >
                                <IconTrash /> Delete permanently
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </section>
            );
          })}

          {visibleSessions.length === 0 && (
            <div className="sidebar__empty">
              {modelFilter
                ? `No sessions used ${formatSessionModelName(modelFilter)}.`
                : sessionView === "archived"
                  ? "No archived sessions."
                  : "No saved sessions yet."}
            </div>
          )}
        </div>
      )}

      {!collapsed && (
        <button
          type="button"
          className="sidebar-resizer"
          aria-label="Resize sidebar"
          title="Drag to resize sidebar"
          onPointerDown={onResizePointerDown}
          onKeyDown={onResizeKeyDown}
        />
      )}
      <button
        type="button"
        className="sidebar__footer"
        onClick={onThemeToggle}
        aria-label={theme === "dark" ? "Use light theme" : "Use dark theme"}
      >
        {theme === "dark" ? <IconSun /> : <IconMoon />}
        {!collapsed && (
          <span>
            {theme === "dark" ? "Light appearance" : "Dark appearance"}
          </span>
        )}
      </button>
    </aside>
  );
}

function SidebarNavButton({
  collapsed,
  active,
  label,
  icon,
  live = false,
  onClick,
}: {
  collapsed: boolean;
  active: boolean;
  label: string;
  icon: ReactNode;
  live?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`sidebar__nav-item${active ? " is-active" : ""}`}
      aria-current={active ? "page" : undefined}
      aria-label={live ? `${label}, session running` : label}
      onClick={onClick}
    >
      {icon}
      {!collapsed && <span>{label}</span>}
      {live && (
        <span
          className="sidebar__run-dot"
          title="A session is running"
          aria-hidden="true"
        />
      )}
    </button>
  );
}
