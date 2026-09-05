import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  api,
  type AgentSettings,
  type McpServerInfo,
  type PiCatalogResponse,
} from "../lib/api";
import type { WorkbenchView } from "../lib/navigation";
import {
  IconCube,
  IconExtension,
  IconRefresh,
  IconSearch,
  IconSettings,
} from "./icons";
import {
  notificationPermission,
  notificationsEnabled,
  notify,
  requestNotifications,
  setNotificationsEnabled,
} from "../lib/notify";

const EMPTY_CATALOG: PiCatalogResponse = {
  ok: true,
  skills: [],
  extensions: [],
  settings: {},
};

export function WorkbenchPage({
  view,
  theme,
  onThemeChange,
  showThinking,
  onShowThinkingChange,
  sessionKey,
}: {
  view: Exclude<WorkbenchView, "sessions" | "fleet">;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  showThinking: boolean;
  onShowThinkingChange: (show: boolean) => void;
  /** Active conversation, if any — MCP status comes from its running agent. */
  sessionKey?: string;
}) {
  const [catalog, setCatalog] = useState<PiCatalogResponse>(EMPTY_CATALOG);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  const refresh = () => {
    setLoading(true);
    void api.catalog().then((result) => {
      setCatalog(result);
      setLoading(false);
    });
  };

  useEffect(refresh, []);
  useEffect(() => setQuery(""), [view]);

  const normalizedQuery = query.trim().toLowerCase();
  const skills = useMemo(
    () =>
      catalog.skills.filter(
        (item) =>
          !normalizedQuery ||
          `${item.name} ${item.description}`
            .toLowerCase()
            .includes(normalizedQuery),
      ),
    [catalog.skills, normalizedQuery],
  );
  const extensions = useMemo(
    () =>
      catalog.extensions.filter(
        (item) =>
          !normalizedQuery ||
          `${item.name} ${item.description} ${item.spec}`
            .toLowerCase()
            .includes(normalizedQuery),
      ),
    [catalog.extensions, normalizedQuery],
  );

  const title =
    view === "skills"
      ? "Skills"
      : view === "extensions"
        ? "Extensions"
        : "Settings";
  const description =
    view === "skills"
      ? "Specialized instructions available to your local Pi agent."
      : view === "extensions"
        ? "Packages and local extensions loaded by Pi."
        : "Workbench appearance and your current Pi defaults.";

  return (
    <div className="resource-page">
      <header className="resource-page__header">
        <div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <button
          type="button"
          className="resource-page__refresh"
          onClick={refresh}
          disabled={loading}
        >
          <IconRefresh /> Refresh
        </button>
      </header>

      {!catalog.ok && (
        <div className="resource-page__error" role="alert">
          {catalog.error ?? "Pi resources could not be loaded."}
        </div>
      )}

      {view !== "settings" && (
        <label className="resource-page__search">
          <IconSearch />
          <input
            type="search"
            aria-label={`Search ${title.toLowerCase()}`}
            placeholder={`Search ${title.toLowerCase()}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}

      <div className="resource-page__content" aria-busy={loading}>
        {loading && (
          <div className="resource-page__empty">
            Loading {title.toLowerCase()}…
          </div>
        )}
        {!loading && view === "skills" && (
          <SkillsView
            skills={skills}
            query={normalizedQuery}
            onChanged={refresh}
          />
        )}
        {!loading && view === "extensions" && (
          <ResourceList
            items={extensions.map((extension) => ({
              key: `${extension.source}:${extension.path}`,
              icon: <IconExtension size={18} />,
              title: extension.name,
              description: extension.description,
              badge: [extension.source, extension.version]
                .filter(Boolean)
                .join(" · "),
              metadata: extension.spec,
            }))}
            empty={
              normalizedQuery
                ? "No extensions match this search."
                : "No Pi extensions are installed."
            }
          />
        )}
        {!loading && view === "settings" && (
          <SettingsView
            catalog={catalog}
            theme={theme}
            onThemeChange={onThemeChange}
            showThinking={showThinking}
            onShowThinkingChange={onShowThinkingChange}
            sessionKey={sessionKey}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Opt-in for the two notifications the workbench sends. Kept behind an
 * explicit toggle: the browser only grants the permission from a real click,
 * and an agent that pings you unasked is worse than one that stays quiet.
 */
function NotificationsCard() {
  const [permission, setPermission] = useState(() => notificationPermission());
  const [enabled, setEnabled] = useState(() => notificationsEnabled());

  const unsupported = permission === "unsupported";
  const blocked = permission === "denied";

  const toggle = async () => {
    if (enabled) {
      setNotificationsEnabled(false);
      setEnabled(false);
      return;
    }
    const granted = await requestNotifications();
    setPermission(notificationPermission());
    setEnabled(granted);
    if (granted) {
      notify(
        "Notifications on",
        "This is what an alert looks like.",
        "pi-web-test",
        { force: true },
      );
    }
  };

  return (
    <section className="settings-card">
      <div className="settings-card__heading">
        <IconSettings />
        <div>
          <strong>Notifications</strong>
          <span>
            Ping this device when an agent needs permission or finishes a turn.
          </span>
        </div>
      </div>
      {unsupported ? (
        <p className="settings-card__note">
          This browser does not support notifications.
        </p>
      ) : blocked ? (
        <p className="settings-card__note">
          Notifications are blocked for this site. Allow them in your
          browser&apos;s site settings, then reload.
        </p>
      ) : (
        <div
          className="settings-card__theme"
          role="group"
          aria-label="Notifications"
        >
          <button
            type="button"
            className={enabled ? "is-active" : ""}
            aria-pressed={enabled}
            onClick={() => void toggle()}
          >
            {enabled ? "On" : "Off"}
          </button>
        </div>
      )}
      {enabled && (
        <p className="settings-card__note">
          Sent only while this page is open and in the background.
        </p>
      )}
    </section>
  );
}

/**
 * MCP servers as the running agent sees them — which is the only view that
 * distinguishes "configured" from "actually connected". Needs a live session,
 * so it says so rather than showing an empty list that looks like "none".
 */
function McpCard({ sessionKey }: { sessionKey?: string }) {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!sessionKey) {
      setServers(null);
      setError("");
      return;
    }
    let cancelled = false;
    void api
      .mcpServers(sessionKey)
      .then((result) => {
        if (cancelled) return;
        if (result.ok && result.data) {
          setServers(result.data.servers);
          setError("");
        } else {
          setServers(null);
          setError(result.error ?? "MCP status unavailable.");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setServers(null);
          setError("MCP status unavailable.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  return (
    <section className="settings-card">
      <div className="settings-card__heading">
        <IconExtension />
        <div>
          <strong>MCP servers</strong>
          <span>
            Model Context Protocol servers available to the current session.
          </span>
        </div>
      </div>
      {sessionKey ? (
        error ? (
          <p className="settings-card__note">{error}</p>
        ) : servers === null ? (
          <p className="settings-card__note">Loading…</p>
        ) : servers.length === 0 ? (
          <p className="settings-card__note">
            No MCP servers configured. Add one with <code>claude mcp add</code>.
          </p>
        ) : (
          <dl className="settings-card__rows">
            {servers.map((server) => (
              <div key={server.name}>
                <dt>{server.name}</dt>
                <dd>
                  {server.status}
                  {server.scope ? ` · ${server.scope}` : ""}
                  {server.toolCount === null
                    ? ""
                    : ` · ${server.toolCount} tools`}
                  {server.error ? ` — ${server.error}` : ""}
                </dd>
              </div>
            ))}
          </dl>
        )
      ) : (
        <p className="settings-card__note">
          Open a session to see its MCP servers.
        </p>
      )}
    </section>
  );
}

/**
 * Claude Code's own settings as the running agent resolved them: what is in
 * force, which file each scope came from, and every hook that will fire.
 *
 * Read-only. The CLI's settings-write control request accepts a single key
 * (outputStyle), so it cannot honestly back an editor — the files are listed
 * with their paths instead, and the workspace explorer edits them.
 */
function AgentSettingsCard({ sessionKey }: { sessionKey?: string }) {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [error, setError] = useState("");
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    if (!sessionKey) {
      setSettings(null);
      setError("");
      return;
    }
    let cancelled = false;
    void api
      .settings(sessionKey)
      .then((result) => {
        if (cancelled) return;
        if (result.ok && result.data) {
          setSettings(result.data);
          setError("");
        } else {
          setSettings(null);
          setError(result.error ?? "Settings unavailable.");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSettings(null);
          setError("Settings unavailable.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  return (
    <section className="settings-card">
      <div className="settings-card__heading">
        <IconSettings />
        <div>
          <strong>Agent settings and hooks</strong>
          <span>
            What the running Claude session actually resolved, and where each
            part came from.
          </span>
        </div>
      </div>
      {sessionKey ? (
        error ? (
          <p className="settings-card__note">{error}</p>
        ) : settings ? (
          <>
            <dl className="settings-card__rows">
              {settings.sources.map((source) => (
                <div key={source.source}>
                  <dt>{source.source}</dt>
                  <dd>{Object.keys(source.settings).join(", ") || "empty"}</dd>
                </div>
              ))}
            </dl>

            <p className="settings-card__note">
              <strong>{settings.hooks.length}</strong>{" "}
              {settings.hooks.length === 1 ? "hook" : "hooks"} in force
              {settings.hooks.length > 0 ? ":" : "."}
            </p>
            {settings.hooks.length > 0 && (
              <dl className="settings-card__rows">
                {settings.hooks.map((hook, index) => (
                  <div key={`${hook.event}-${index}`}>
                    <dt>
                      {hook.event}
                      {hook.matcher && hook.matcher !== "*"
                        ? ` · ${hook.matcher}`
                        : ""}
                    </dt>
                    <dd>
                      <code className="settings-card__hook">
                        {hook.command || hook.type}
                      </code>
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            <p className="settings-card__note">
              Settings files (edit these in the workspace explorer):
            </p>
            <code className="settings-card__path">
              {settings.files.userSettings}
            </code>
            <code className="settings-card__path">
              {settings.files.projectSettings}
            </code>
            <code className="settings-card__path">
              {settings.files.localSettings}
            </code>

            <button
              type="button"
              className="settings-card__reveal"
              onClick={() => setShowRaw((v) => !v)}
            >
              {showRaw ? "Hide" : "Show"} resolved settings
            </button>
            {showRaw && (
              <pre className="settings-card__raw">
                {JSON.stringify(settings.effective, null, 2)}
              </pre>
            )}
          </>
        ) : (
          <p className="settings-card__note">Loading…</p>
        )
      ) : (
        <p className="settings-card__note">
          Open a session to see its resolved settings.
        </p>
      )}
    </section>
  );
}

type SkillDraft = { name: string; description: string; body: string };
const EMPTY_DRAFT: SkillDraft = { name: "", description: "", body: "" };

/**
 * Skills, with authoring. A skill is a directory holding a SKILL.md, so
 * creating one is writing that file; the server slugs the name and re-checks
 * it against the skills root before any write.
 */
function SkillsView({
  skills,
  query,
  onChanged,
}: {
  skills: PiCatalogResponse["skills"];
  query: string;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const startNew = () => {
    setEditingName(null);
    setError("");
    setDraft({ ...EMPTY_DRAFT });
  };

  const startEdit = async (name: string, description: string) => {
    setError("");
    setBusy(true);
    try {
      const result = await api.readSkill(name);
      // Strip the frontmatter: it is regenerated from the fields on save, so
      // editing it by hand here would silently lose the change.
      const body = (result.source ?? "").replace(/^---\n[\s\S]*?\n---\n*/, "");
      setEditingName(name);
      setDraft({ name, description, body });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.writeSkill(draft);
      if (!result.ok) {
        setError(result.error ?? "Could not save the skill.");
        return;
      }
      setDraft(null);
      setEditingName(null);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setBusy(true);
    setError("");
    try {
      const result = await api.deleteSkill(name);
      if (!result.ok) {
        setError(result.error ?? "Could not delete the skill.");
        return;
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="skills-view">
      <div className="skills-view__bar">
        <button
          type="button"
          className="skills-view__new"
          onClick={startNew}
          disabled={busy}
        >
          New skill
        </button>
        {error && <span className="skills-view__error">{error}</span>}
      </div>

      {draft && (
        <section className="settings-card">
          <div className="settings-card__heading">
            <IconCube />
            <div>
              <strong>
                {editingName ? `Edit ${editingName}` : "New skill"}
              </strong>
              <span>Saved to your local Pi skills as a SKILL.md file.</span>
            </div>
          </div>
          <label className="skills-view__field">
            <span>Name</span>
            <input
              value={draft.name}
              disabled={editingName !== null}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
              placeholder="Release checklist"
            />
          </label>
          <label className="skills-view__field">
            <span>Description</span>
            <input
              value={draft.description}
              onChange={(event) =>
                setDraft({ ...draft, description: event.target.value })
              }
              placeholder="When to use this skill"
            />
          </label>
          <label className="skills-view__field">
            <span>Instructions</span>
            <textarea
              rows={10}
              value={draft.body}
              onChange={(event) =>
                setDraft({ ...draft, body: event.target.value })
              }
              placeholder="What the agent should do when this skill applies."
            />
          </label>
          <div className="skills-view__actions">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !draft.name.trim()}
            >
              {busy ? "Saving…" : "Save skill"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setEditingName(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {skills.length === 0 ? (
        <div className="resource-page__empty">
          {query
            ? "No skills match this search."
            : "No local Pi skills are installed."}
        </div>
      ) : (
        <div className="resource-grid">
          {skills.map((skill) => (
            <article key={skill.path} className="resource-card">
              <div className="resource-card__icon">
                <IconCube size={18} />
              </div>
              <div className="resource-card__body">
                <div className="resource-card__title">
                  <strong>{skill.name}</strong>
                  <div className="skills-view__row-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void startEdit(skill.name, skill.description)
                      }
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(skill.name)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <p>{skill.description}</p>
                <code title={skill.path}>{skill.path}</code>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function ResourceList({
  items,
  empty,
}: {
  items: Array<{
    key: string;
    icon: ReactNode;
    title: string;
    description: string;
    badge?: string;
    metadata: string;
  }>;
  empty: string;
}) {
  if (items.length === 0)
    return <div className="resource-page__empty">{empty}</div>;
  return (
    <div className="resource-grid">
      {items.map((item) => (
        <article className="resource-card" key={item.key}>
          <span className="resource-card__icon">{item.icon}</span>
          <div className="resource-card__body">
            <div className="resource-card__title">
              <strong>{item.title}</strong>
              {item.badge && <span>{item.badge}</span>}
            </div>
            <p>{item.description}</p>
            <code title={item.metadata}>{item.metadata}</code>
          </div>
        </article>
      ))}
    </div>
  );
}

function SettingsView({
  catalog,
  theme,
  onThemeChange,
  showThinking,
  onShowThinkingChange,
  sessionKey,
}: {
  catalog: PiCatalogResponse;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  showThinking: boolean;
  onShowThinkingChange: (show: boolean) => void;
  sessionKey?: string;
}) {
  const settings = catalog.settings;
  const rows = [
    ["Default provider", settings.defaultProvider || "Not set"],
    ["Default model", settings.defaultModel || "Not set"],
    ["Default effort", settings.defaultThinkingLevel || "off"],
    ["Pi terminal theme", settings.theme || "Default"],
    ["Installed terminal themes", String(settings.themeCount ?? 0)],
    ["Thinking blocks", settings.hideThinkingBlock ? "Hidden" : "Visible"],
    ["Startup", settings.quietStartup ? "Quiet" : "Standard"],
  ];
  return (
    <div className="settings-stack">
      <section className="settings-card">
        <div className="settings-card__heading">
          <IconSettings />
          <div>
            <strong>Workbench appearance</strong>
            <span>Choose how Pi Workbench looks.</span>
          </div>
        </div>
        <div
          className="settings-card__theme"
          role="group"
          aria-label="Workbench appearance"
        >
          <button
            type="button"
            className={theme === "light" ? "is-active" : ""}
            aria-pressed={theme === "light"}
            onClick={() => onThemeChange("light")}
          >
            Light
          </button>
          <button
            type="button"
            className={theme === "dark" ? "is-active" : ""}
            aria-pressed={theme === "dark"}
            onClick={() => onThemeChange("dark")}
          >
            Dark
          </button>
        </div>
      </section>
      <section className="settings-card">
        <div className="settings-card__heading">
          <IconSettings />
          <div>
            <strong>Thinking blocks</strong>
            <span>Show the agent's reasoning text between its replies.</span>
          </div>
        </div>
        <div
          className="settings-card__theme"
          role="group"
          aria-label="Thinking blocks"
        >
          <button
            type="button"
            className={!showThinking ? "is-active" : ""}
            aria-pressed={!showThinking}
            onClick={() => onShowThinkingChange(false)}
          >
            Hidden
          </button>
          <button
            type="button"
            className={showThinking ? "is-active" : ""}
            aria-pressed={showThinking}
            onClick={() => onShowThinkingChange(true)}
          >
            Shown
          </button>
        </div>
      </section>
      <NotificationsCard />
      <McpCard sessionKey={sessionKey} />
      <AgentSettingsCard sessionKey={sessionKey} />
      <section className="settings-card">
        <div className="settings-card__heading">
          <IconCube />
          <div>
            <strong>Pi defaults</strong>
            <span>Read from your local Pi settings.</span>
          </div>
        </div>
        <dl className="settings-card__rows">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {settings.path && (
          <code className="settings-card__path">{settings.path}</code>
        )}
      </section>
    </div>
  );
}
