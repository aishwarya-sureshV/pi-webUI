import {
  Fragment,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type FormEvent,
} from "react";
import { StoreProvider, useStore } from "./lib/store";
import { AuthError, api, setAuthToken } from "./lib/api";
import { Sidebar } from "./components/Sidebar";
import { Conversation } from "./components/Conversation";
import { WorkbenchPage } from "./components/WorkbenchPage";
import { TerminalPage } from "./components/TerminalPage";
import { FishLogo } from "./components/icons";
import type { WorkbenchView } from "./lib/navigation";
import "./styles/app.css";
import "./styles/conversation.css";

function Frame() {
  const { tabs, active, activeKey, setActiveKey, closeConversation } =
    useStore();
  const [view, setView] = useState<WorkbenchView>("sessions");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("pi-web.sidebar") === "collapsed",
  );
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem("pi-web.sidebar-width"));
    return Number.isFinite(stored) ? Math.min(480, Math.max(200, stored)) : 264;
  });
  const [splitSessions, setSplitSessions] = useState(
    () => localStorage.getItem("pi-web.session-layout") === "split",
  );
  const [splitSessionKeys, setSplitSessionKeys] = useState<string[]>([]);
  const [paneWidths, setPaneWidths] = useState<Record<string, number>>({});
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    localStorage.getItem("pi-web.theme.v2") === "dark" ? "dark" : "light",
  );
  // Terminal lives in a right-docked pane next to the conversation; the
  // expand button swaps it to a full-width view without unmounting the PTYs.
  const [terminalPane, setTerminalPane] = useState(
    () => localStorage.getItem("pi-web.terminal-pane") === "open",
  );
  const [terminalExpanded, setTerminalExpanded] = useState(false);
  const [terminalWidth, setTerminalWidth] = useState(() => {
    const stored = Number(localStorage.getItem("pi-web.terminal-width"));
    return Number.isFinite(stored) && stored > 0
      ? Math.min(760, Math.max(280, stored))
      : 420;
  });

  useEffect(() => {
    document.body.toggleAttribute("data-ds-dark-theme", theme === "dark");
    localStorage.setItem("pi-web.theme.v2", theme);
  }, [theme]);

  const toggleSidebar = () =>
    setSidebarCollapsed((collapsed) => {
      localStorage.setItem(
        "pi-web.sidebar",
        collapsed ? "expanded" : "collapsed",
      );
      return !collapsed;
    });

  const openTerminalPane = () => {
    localStorage.setItem("pi-web.terminal-pane", "open");
    setTerminalExpanded(false);
    setTerminalPane(true);
    if (view !== "sessions") setView("sessions");
  };

  const closeTerminalPane = () => {
    localStorage.setItem("pi-web.terminal-pane", "closed");
    setTerminalPane(false);
    setTerminalExpanded(false);
  };

  const toggleTerminalPane = () =>
    terminalPane && view === "sessions"
      ? closeTerminalPane()
      : openTerminalPane();

  // Leaving (or re-entering) sessions always un-expands the terminal pane so
  // the sessions nav button never looks dead while the pane is expanded.
  const changeView = (next: WorkbenchView) => {
    setTerminalExpanded(false);
    setView(next);
  };

  const startTerminalResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = terminalWidth;
    const onMove = (moveEvent: PointerEvent) => {
      // Left edge drag: moving left widens the pane.
      const next = Math.min(
        760,
        Math.max(280, startWidth + (startX - moveEvent.clientX)),
      );
      setTerminalWidth(next);
      localStorage.setItem("pi-web.terminal-width", String(next));
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.classList.remove("is-resizing-sessions");
    };
    document.body.classList.add("is-resizing-sessions");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  };

  const toggleSplitSessions = () => {
    if (splitSessions) {
      focusSession(activeKey);
      return;
    }
    localStorage.setItem("pi-web.session-layout", "split");
    setSplitSessionKeys(tabs.map((tab) => tab.key));
    setSplitSessions(true);
  };

  const focusSession = (key: string) => {
    localStorage.setItem("pi-web.session-layout", "focus");
    if (key) setActiveKey(key);
    setSplitSessions(false);
    setSplitSessionKeys([]);
  };

  const splitWithSession = (key: string) => {
    localStorage.setItem("pi-web.session-layout", "split");
    setSplitSessionKeys((current) => {
      const base = current.length > 0 ? current : [activeKey];
      return [...new Set([...base, key])].filter(Boolean);
    });
    setSplitSessions(true);
  };

  const visibleTabs = splitSessions
    ? tabs.filter(
        (tab) =>
          splitSessionKeys.length === 0 || splitSessionKeys.includes(tab.key),
      )
    : active
      ? [active]
      : [];

  const persistSidebarWidth = (width: number) => {
    const next = Math.min(480, Math.max(200, width));
    setSidebarWidth(next);
    localStorage.setItem("pi-web.sidebar-width", String(next));
    return next;
  };

  const startSidebarResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (sidebarCollapsed) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const onMove = (moveEvent: PointerEvent) => {
      persistSidebarWidth(startWidth + moveEvent.clientX - startX);
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.classList.remove("is-resizing-sidebar");
    };
    document.body.classList.add("is-resizing-sidebar");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  };

  const resizeSidebarWithKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    persistSidebarWidth(sidebarWidth + (event.key === "ArrowRight" ? 24 : -24));
  };

  const startPaneResize = (
    event: ReactPointerEvent<HTMLButtonElement>,
    key: string,
  ) => {
    const pane = event.currentTarget
      .previousElementSibling as HTMLElement | null;
    if (!pane) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = pane.getBoundingClientRect().width;
    const onMove = (moveEvent: PointerEvent) => {
      setPaneWidths((current) => ({
        ...current,
        [key]: Math.max(420, startWidth + moveEvent.clientX - startX),
      }));
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.classList.remove("is-resizing-sessions");
    };
    document.body.classList.add("is-resizing-sessions");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  };

  const resizePaneWithKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    key: string,
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const pane = event.currentTarget
      .previousElementSibling as HTMLElement | null;
    if (!pane) return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 48 : -48;
    setPaneWidths((current) => ({
      ...current,
      [key]: Math.max(
        420,
        (current[key] ?? pane.getBoundingClientRect().width) + delta,
      ),
    }));
  };

  return (
    <div
      className="app-frame"
      style={{
        gridTemplateColumns: `${sidebarCollapsed ? 56 : sidebarWidth}px minmax(0, 1fr)`,
        ["--pw-sidebar-width" as string]: `${sidebarCollapsed ? 56 : sidebarWidth}px`,
      }}
    >
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={toggleSidebar}
        theme={theme}
        onThemeToggle={() =>
          setTheme((current) => (current === "dark" ? "light" : "dark"))
        }
        view={view}
        onViewChange={changeView}
        terminalOpen={terminalPane}
        onTerminalToggle={toggleTerminalPane}
        splitSessions={splitSessions}
        onSplitSessionsToggle={toggleSplitSessions}
        onSessionFocus={focusSession}
        onSessionSplit={splitWithSession}
        openTabKeys={tabs.map((tab) => tab.key)}
        onResizePointerDown={startSidebarResize}
        onResizeKeyDown={resizeSidebarWithKeyboard}
      />
      <main className="center">
        <div
          className={`center__body${terminalPane && terminalExpanded ? " is-hidden" : ""}`}
        >
          {view === "sessions" ? (
            <>
              {tabs.length > 0 ? (
                <div
                  className={`session-grid${visibleTabs.length > 1 ? " is-split" : ""}`}
                >
                  {tabs.map((tab) => {
                    const visibleIndex = visibleTabs.findIndex(
                      (visible) => visible.key === tab.key,
                    );
                    const visible = visibleIndex >= 0;
                    return (
                      <Fragment key={tab.key}>
                        <div
                          className={`session-pane-slot${visible ? "" : " is-background"}`}
                          hidden={!visible}
                          aria-hidden={!visible}
                        >
                          <section
                            className={`session-pane${tab.key === activeKey ? " is-active" : ""}`}
                            aria-label={`Session ${tab.label}`}
                            style={
                              visible && paneWidths[tab.key]
                                ? {
                                    flexBasis: `${paneWidths[tab.key]}px`,
                                    width: `${paneWidths[tab.key]}px`,
                                  }
                                : undefined
                            }
                            onPointerDownCapture={() => setActiveKey(tab.key)}
                          >
                            <Conversation
                              tab={tab}
                              split={visibleTabs.length > 1}
                              paneIndex={Math.max(0, visibleIndex)}
                              paneCount={Math.max(1, visibleTabs.length)}
                              onClose={
                                visible && visibleTabs.length > 1
                                  ? () => closeConversation(tab.key)
                                  : undefined
                              }
                            />
                          </section>
                        </div>
                        {visible && visibleIndex < visibleTabs.length - 1 && (
                          <button
                            type="button"
                            className="session-resizer"
                            role="separator"
                            aria-orientation="vertical"
                            aria-label={`Resize ${tab.label}`}
                            title="Drag to resize session"
                            onPointerDown={(event) =>
                              startPaneResize(event, tab.key)
                            }
                            onKeyDown={(event) =>
                              resizePaneWithKeyboard(event, tab.key)
                            }
                          />
                        )}
                      </Fragment>
                    );
                  })}
                </div>
              ) : (
                <EmptyCenter />
              )}
            </>
          ) : (
            <WorkbenchPage view={view} theme={theme} onThemeChange={setTheme} />
          )}
        </div>
        {terminalPane && view === "sessions" && !terminalExpanded && (
          <button
            type="button"
            className="terminal-pane-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize terminal pane"
            title="Drag to resize terminal"
            onPointerDown={startTerminalResize}
          />
        )}
        {terminalPane && view === "sessions" && (
          <aside
            className={`terminal-pane${terminalExpanded ? " is-expanded" : ""}`}
            aria-label="Terminal pane"
            style={
              terminalExpanded ? undefined : { width: `${terminalWidth}px` }
            }
          >
            <TerminalPage
              cwd={active?.cwd}
              theme={theme}
              pane
              expanded={terminalExpanded}
              onExpand={() => setTerminalExpanded(true)}
              onCollapse={() => setTerminalExpanded(false)}
              onClose={closeTerminalPane}
            />
          </aside>
        )}
      </main>
    </div>
  );
}

function EmptyCenter() {
  return (
    <div className="conversation">
      <div className="hero">
        <div className="hero__glow" />
        <div className="hero__stack">
          <div className="hero__headline">
            <span className="hero__fish">
              <FishLogo size={34} />
            </span>
            <span className="hero__title">Onwards & Upwards</span>
            <span className="hero__badge">Preview</span>
          </div>
          <div className="hero__opening">Opening your workspace…</div>
        </div>
      </div>
    </div>
  );
}

export function App() {
  return (
    <AuthGate>
      <StoreProvider>
        <Frame />
      </StoreProvider>
    </AuthGate>
  );
}

/**
 * Token gate: when the server has PI_WEB_TOKEN set, every API call 401s until
 * the user enters the token. The token is exchanged for an HttpOnly cookie
 * (same-origin) and a one-time ticket (cross-origin EventSource/WebSocket),
 * then stored locally so later requests carry the Authorization header.
 */
function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "authed" | "denied">(
    "checking",
  );
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .authStatus()
      .then(() => {
        if (!cancelled) setState("authed");
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof AuthError) setState("denied");
        else setState("authed"); // server unreachable; let the app surface it
      });
    // A token rotation or expiry mid-session re-locks the UI instead of
    // failing silently per-request.
    const onUnhandled = (event: PromiseRejectionEvent) => {
      if (event.reason instanceof AuthError) setState("denied");
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    return () => {
      cancelled = true;
      window.removeEventListener("unhandledrejection", onUnhandled);
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const result = await api.auth(token.trim());
      if (!result.ok) {
        setError("Invalid token.");
        return;
      }
      setAuthToken(token.trim());
      setState("authed");
    } catch {
      setError("Could not reach the server.");
    }
  };

  if (state === "checking") {
    return (
      <div className="auth-gate">
        <div className="auth-gate__card">Checking…</div>
      </div>
    );
  }
  if (state === "denied") {
    return (
      <div className="auth-gate">
        <form className="auth-gate__card" onSubmit={submit}>
          <h1>pi-web is locked</h1>
          <p>
            The server requires a token. Enter the value of PI_WEB_TOKEN to
            continue.
          </p>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="PI_WEB_TOKEN"
            autoFocus
          />
          <button type="submit">Unlock</button>
          {error && <p className="auth-gate__error">{error}</p>}
        </form>
      </div>
    );
  }
  return <>{children}</>;
}
