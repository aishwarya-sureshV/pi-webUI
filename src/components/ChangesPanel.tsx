import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  api,
  type GitChange,
  type GitChangesResponse,
  type GitOp,
  type GitOpOptions,
} from "../lib/api";
import { DiffPreview } from "./ToolCard";
import { IconChevronDown } from "./icons";
import type { DiffLine, ToolDiff } from "../lib/toolCards";

/** Cap rendered diff lines so a huge generated file can't freeze the tab. */
const MAX_DIFF_LINES = 2000;

/** Parse a unified diff into the shared DiffPreview model. */
function parseUnifiedDiff(text: string): ToolDiff {
  const rows = text.split("\n").slice(0, MAX_DIFF_LINES);
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let newLineNo = 0;
  for (const raw of rows) {
    if (
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("Binary files") ||
      raw.startsWith("old mode") ||
      raw.startsWith("new mode") ||
      raw.startsWith("\\")
    ) {
      lines.push({ kind: "meta", text: raw });
    } else if (raw.startsWith("@@")) {
      const match = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) newLineNo = Number(match[1]);
      lines.push({ kind: "meta", text: raw });
    } else if (raw.startsWith("+")) {
      added += 1;
      lines.push({ kind: "add", text: raw.slice(1), lineNo: newLineNo });
      newLineNo += 1;
    } else if (raw.startsWith("-")) {
      removed += 1;
      lines.push({ kind: "remove", text: raw.slice(1) });
    } else {
      lines.push({ kind: "context", text: raw.slice(1), lineNo: newLineNo });
      newLineNo += 1;
    }
  }
  return { added, removed, lines };
}

/** The "@@ …" headers of a unified diff, in the order git emits them. */
function diffHunkHeaders(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("@@"))
    .map((line) => line.replace(/^(@@[^@]*@@).*$/, "$1"));
}

const STATUS_LETTER: Record<GitChange["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  conflicted: "!",
};

/** What git calls the operation behind each in-progress state. */
const STATE_VERB: Record<string, string> = {
  merging: "merge",
  rebasing: "rebase",
  "cherry-picking": "cherry-pick",
  reverting: "revert",
};

/**
 * `git stash list` labels every entry "WIP on <branch>: <sha> <subject>" (or
 * "On <branch>: <message>" when named). The branch is already in the header,
 * so drop the prefix and keep the part that tells the stashes apart.
 */
function stashLabel(label: string, ref: string): string {
  const trimmed = label.replace(/^(?:WIP )?[Oo]n [^:]+:\s*/, "").trim();
  return trimmed || label || ref;
}

/** Human name per op, used for both the busy state and the result line. */
const OP_LABEL: Record<GitOp, string> = {
  push: "Push",
  pull: "Pull",
  "pull-rebase": "Pull (rebase)",
  fetch: "Fetch",
  commit: "Commit",
  "commit-push": "Commit and push",
  stash: "Stash",
  "stash-apply": "Apply stash",
  "stash-pop": "Pop stash",
  "stash-drop": "Drop stash",
  "branch-create": "Create branch",
  "branch-switch": "Switch branch",
  "undo-commit": "Undo last commit",
  continue: "Continue",
  abort: "Abort",
};

/**
 * Post-turn "Changes" card: lists the working tree's uncommitted changes and
 * offers a one-click commit + push to the repo's origin (GitHub). Everything
 * beyond that primary action — fetch, pull (merge or rebase), push, commit
 * without pushing, branch create/switch, and the stash list — lives behind the
 * one "Git" menu so the card stays a card. Renders nothing outside a git repo.
 */
export function ChangesPanel({
  sessionKey,
  cwd,
  streaming,
  onAskAgent,
}: {
  sessionKey: string;
  cwd?: string;
  streaming: boolean;
  /** Drops a prompt in the composer; the user still presses send. */
  onAskAgent?: (prompt: string) => void;
}) {
  const [data, setData] = useState<GitChangesResponse | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // Always collapsed: the card stays a one-line pill until clicked.
  const [collapsed, setCollapsed] = useState(true);
  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem("pi-web.changes-collapsed", next ? "1" : "0");
      } catch {
        /* storage unavailable; choice lasts this mount only */
      }
      return next;
    });
  }, []);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, ToolDiff | undefined>>({});
  // Hunk headers per file, so each change can be reverted on its own.
  const [hunks, setHunks] = useState<Record<string, string[]>>({});
  const [revertingHunk, setRevertingHunk] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [pushBusy, setPushBusy] = useState(false);
  // Only one secondary op runs at a time; this is which.
  const [busyOp, setBusyOp] = useState<GitOp | null>(null);
  // Every git outcome — primary push included — lands here and is shown as a
  // floating toast. Inline result lines pushed the card's own controls around
  // and scrolled out of view with the transcript.
  const [feedback, setFeedback] = useState<{
    ok: boolean;
    title: string;
    output?: string;
  } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Stays on screen after a successful push (which empties the change list)
  // so the outcome is visible in-app instead of only on GitHub.
  const [pushed, setPushed] = useState<{
    branch?: string;
    output?: string;
    files: number;
    remote: boolean;
  } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  // Files the user unchecked. Persisted per repo so the exclusion survives
  // pushes AND future turns' change boxes until the user re-includes them.
  const excludedKey = `pi-web.changes-excluded:${cwd || "default"}`;
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const saveExcluded = useCallback(
    (next: ReadonlySet<string>) => {
      try {
        localStorage.setItem(excludedKey, JSON.stringify([...next]));
      } catch {
        /* storage unavailable; exclusion lasts this session only */
      }
    },
    [excludedKey],
  );
  useEffect(() => {
    try {
      const raw = localStorage.getItem(excludedKey);
      setExcluded(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch {
      setExcluded(new Set());
    }
  }, [excludedKey]);
  const toggleExcluded = useCallback(
    (path: string) => {
      setExcluded((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        saveExcluded(next);
        return next;
      });
    },
    [saveExcluded],
  );
  const wasStreaming = useRef(streaming);
  const fetchToken = useRef(0);

  const refresh = useCallback(async () => {
    const token = ++fetchToken.current;
    try {
      const result = await api.gitChanges(sessionKey, cwd || "");
      if (token === fetchToken.current) {
        setData(result);
        // Prune exclusions whose files left the working tree (committed
        // elsewhere, reverted); the rest stay unchecked across turns.
        const paths = new Set((result.changes ?? []).map((c) => c.path));
        setExcluded((current) => {
          const next = new Set([...current].filter((p) => paths.has(p)));
          if (next.size === current.size) return current;
          saveExcluded(next);
          return next;
        });
      }
    } catch {
      /* offline or unauthed; keep the previous snapshot */
    }
  }, [sessionKey, cwd]);

  // Initial load + explicit reloads (e.g. after a push).
  useEffect(() => {
    void refresh();
  }, [refresh, reloadToken]);

  // A turn that just finished (streaming -> idle) re-reads the working tree
  // and un-dismisses the card so fresh changes surface again.
  useEffect(() => {
    const was = wasStreaming.current;
    wasStreaming.current = streaming;
    if (was && !streaming) {
      setDismissed(false);
      setOpenFile(null);
      setDiffs({});
      setPushed(null);
      setReloadToken((token) => token + 1);
    }
  }, [streaming]);

  // A success speaks for itself and clears itself; a failure stays until the
  // user dismisses it, because it is the only place the git error is shown.
  useEffect(() => {
    if (!feedback?.ok) return;
    const timer = window.setTimeout(() => setFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  // Popover hygiene: a click anywhere else, or Escape, closes the Git menu.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const toggleFile = async (path: string) => {
    if (openFile === path) {
      setOpenFile(null);
      return;
    }
    setOpenFile(path);
    if (diffs[path] === undefined) {
      try {
        const result = await api.gitFileDiff(sessionKey, cwd || "", path);
        const parsed = result.ok
          ? parseUnifiedDiff(result.diff ?? "")
          : undefined;
        if (parsed) {
          setDiffs((current) => ({ ...current, [path]: parsed }));
          setHunks((current) => ({
            ...current,
            [path]: diffHunkHeaders(result.diff ?? ""),
          }));
        }
      } catch {
        // A failed fetch collapses the row; toggling again retries.
        setOpenFile(null);
      }
    }
  };

  // `remote` false commits without pushing — the same staging path, minus the
  // network step, for work that is not ready to leave the machine.
  const pushToGithub = async (remote = true) => {
    if (pushBusy || busyOp) return;
    setMenuOpen(false);
    const paths = changes
      .filter((change) => !excluded.has(change.path))
      .map((change) => change.path);
    if (paths.length === 0) {
      setFeedback({
        ok: false,
        title: "No files selected — re-include a file first.",
      });
      return;
    }
    setPushBusy(true);
    try {
      const result = await api.gitCommitPush(
        sessionKey,
        cwd || "",
        message.trim() || "Update from pi-web",
        paths,
        remote,
      );
      if (result.ok) {
        const count = `${paths.length} file${paths.length === 1 ? "" : "s"}`;
        // The receipt card keeps the git output; the toast only announces it.
        setFeedback({
          ok: true,
          title: remote
            ? `Committed and pushed ${count} to GitHub.`
            : `Committed ${count} locally — not pushed.`,
        });
        setPushed({
          branch: data?.branch,
          output: result.output,
          files: paths.length,
          remote,
        });
        setMessage("");
        setOpenFile(null);
        setDiffs({});
        setReloadToken((token) => token + 1);
      } else {
        setFeedback({
          ok: false,
          title: remote ? "Push failed." : "Commit failed.",
          output: result.error,
        });
      }
    } catch (error) {
      setFeedback({
        ok: false,
        title: remote ? "Push failed." : "Commit failed.",
        output: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPushBusy(false);
    }
  };

  // Every secondary git op goes through here: one in flight at a time, one
  // result line, and a refresh so the header counters follow the repo.
  const runGit = async (op: GitOp, options?: GitOpOptions) => {
    if (busy) return;
    setMenuOpen(false);
    setBusyOp(op);
    try {
      const result = await api.gitRun(sessionKey, cwd || "", op, options);
      setFeedback({
        ok: result.ok,
        title: result.ok ? `${OP_LABEL[op]} done.` : `${OP_LABEL[op]} failed.`,
        output: result.ok ? result.output : (result.error ?? result.output),
      });
      if (result.ok) {
        setOpenFile(null);
        setDiffs({});
        setReloadToken((token) => token + 1);
      }
    } catch (error) {
      setFeedback({
        ok: false,
        title: `${OP_LABEL[op]} failed.`,
        output: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyOp(null);
    }
  };

  const changes = data?.changes ?? [];
  // Pill diffstat: the whole turn's additions/deletions, GitHub style.
  const totalAdd = changes.reduce((sum, change) => sum + change.additions, 0);
  const totalDel = changes.reduce((sum, change) => sum + change.deletions, 0);
  const stashes = data?.stashes ?? [];
  const branches = data?.branches ?? [];
  const ahead = data?.ahead ?? 0;
  const behind = data?.behind ?? 0;
  const connected = Boolean(data?.connected);
  const remoteBranches = data?.remoteBranches ?? [];
  const conflicts = data?.conflicts ?? [];
  // "Not clean" is the gate, not the conflict count: a merge stays in progress
  // after the last file is resolved, right up until it is concluded.
  const inProgress = Boolean(data?.state && data.state !== "clean");
  const verb = STATE_VERB[data?.state ?? ""] ?? "operation";
  const busy = pushBusy || busyOp !== null;
  const included = changes.filter((change) => !excluded.has(change.path));
  // A partial selection stashes exactly what is checked; a full one stashes
  // the tree, which is what "stash" means everywhere else.
  const stashPaths =
    included.length && included.length < changes.length
      ? included.map((change) => change.path)
      : undefined;

  const createBranch = () => {
    const name = newBranch.trim();
    if (!name) return;
    setNewBranch("");
    void runGit("branch-create", { branch: name });
  };

  const gitMenu = (
    <div
      className="changes__menu-wrap"
      ref={menuRef}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="changes__git"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={busy}
        onClick={() => setMenuOpen((open) => !open)}
        title="Git actions"
      >
        {busyOp ? `${OP_LABEL[busyOp]}…` : "Git"}
        <span className="changes__caret" aria-hidden>
          ▾
        </span>
      </button>
      {menuOpen && (
        <div className="changes__menu" role="menu">
          <p className="changes__menu-head">Sync</p>
          <button
            type="button"
            role="menuitem"
            disabled={!connected}
            onClick={() => void runGit("fetch")}
          >
            Fetch <span>refresh remote refs</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!connected || inProgress}
            onClick={() => void runGit("pull")}
          >
            Pull <span>merge{behind ? ` · ${behind} behind` : ""}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!connected || inProgress}
            onClick={() => void runGit("pull-rebase")}
          >
            Pull <span>rebase</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!connected || inProgress}
            onClick={() => void runGit("push")}
          >
            Push <span>{ahead ? `${ahead} ahead` : "commits only"}</span>
          </button>
          {changes.length > 0 && (
            <button
              type="button"
              role="menuitem"
              disabled={included.length === 0 || inProgress}
              onClick={() => void pushToGithub(false)}
            >
              Commit <span>no push</span>
            </button>
          )}
          {/* Only for commits the remote has not seen: a soft reset there can
              never leave the branch needing a force-push. */}
          {ahead > 0 && !inProgress && (
            <button
              type="button"
              role="menuitem"
              onClick={() => void runGit("undo-commit")}
            >
              Undo last commit <span>keeps the changes</span>
            </button>
          )}

          <p className="changes__menu-head">Branch</p>
          <div className="changes__menu-form">
            <input
              type="text"
              value={newBranch}
              placeholder="new-branch-name"
              aria-label="New branch name"
              onChange={(event) => setNewBranch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  createBranch();
                }
              }}
            />
            <button
              type="button"
              disabled={!newBranch.trim()}
              onClick={createBranch}
            >
              Create
            </button>
          </div>
          {branches
            .filter((name) => name !== data?.branch)
            .slice(0, 5)
            .map((name) => (
              <button
                key={name}
                type="button"
                role="menuitem"
                onClick={() => void runGit("branch-switch", { branch: name })}
              >
                <span className="changes__menu-branch">{name}</span>
                <span>switch</span>
              </button>
            ))}
          {remoteBranches.slice(0, 4).map((name) => (
            <button
              key={`remote:${name}`}
              type="button"
              role="menuitem"
              onClick={() => void runGit("branch-switch", { branch: name })}
            >
              <span className="changes__menu-branch">{name}</span>
              <span>from remote</span>
            </button>
          ))}

          <p className="changes__menu-head">
            Stash{stashes.length ? ` · ${stashes.length}` : ""}
          </p>
          <button
            type="button"
            role="menuitem"
            disabled={changes.length === 0 || inProgress}
            onClick={() =>
              void runGit("stash", {
                ...(message.trim() ? { message: message.trim() } : {}),
                ...(stashPaths ? { files: stashPaths } : {}),
              })
            }
          >
            {stashPaths ? "Stash selected" : "Stash all changes"}{" "}
            <span>
              {changes.length
                ? `${(stashPaths ?? changes).length} file${(stashPaths ?? changes).length === 1 ? "" : "s"}`
                : "nothing to stash"}
            </span>
          </button>
          {stashes.map((stash) => (
            <div key={stash.ref} className="changes__stash">
              <span className="changes__stash-label" title={stash.label}>
                {stashLabel(stash.label, stash.ref)}
              </span>
              <span className="changes__stash-acts">
                <span className="changes__stash-age">{stash.age}</span>
                <button
                  type="button"
                  title="Apply and remove this stash"
                  onClick={() => void runGit("stash-pop", { ref: stash.ref })}
                >
                  Pop
                </button>
                <button
                  type="button"
                  title="Apply but keep this stash"
                  onClick={() => void runGit("stash-apply", { ref: stash.ref })}
                >
                  Apply
                </button>
                <button
                  type="button"
                  className="is-danger"
                  title="Delete this stash for good"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Drop ${stash.ref}? Its changes are gone for good.`,
                      )
                    )
                      void runGit("stash-drop", { ref: stash.ref });
                  }}
                >
                  Drop
                </button>
              </span>
            </div>
          ))}
          {stashes.length === 0 && (
            <p className="changes__menu-empty">Nothing stashed.</p>
          )}
        </div>
      )}
    </div>
  );

  // While a merge/rebase is unfinished this replaces the commit footer: the
  // three things you can actually do, and no path to committing markers.
  const conflictBar = inProgress && (
    <div className="changes__conflict">
      <p className="changes__conflict-text">
        <strong>
          {conflicts.length > 0
            ? `Conflict in ${conflicts.length} file${conflicts.length === 1 ? "" : "s"}`
            : `${verb[0].toUpperCase()}${verb.slice(1)} in progress`}
        </strong>{" "}
        {conflicts.length > 0
          ? `— fix the markers, then continue the ${verb}. Committing is blocked until then.`
          : "— finish it or abort it before committing."}
      </p>
      <div className="changes__conflict-acts">
        {onAskAgent && conflicts.length > 0 && (
          <button
            type="button"
            className="changes__conflict-ask"
            onClick={() =>
              onAskAgent(
                `Resolve the git ${verb} conflict in: ${conflicts.join(", ")}. Edit each file to remove the conflict markers, keeping the right combination of both sides. Don't commit — I'll finish the ${verb} from the UI.`,
              )
            }
          >
            Ask the agent to resolve
          </button>
        )}
        <button
          type="button"
          className="changes__conflict-continue"
          disabled={busy}
          onClick={() => void runGit("continue")}
          title={`Stage the resolved files and finish the ${verb}`}
        >
          {busyOp === "continue" ? "Continuing…" : `Continue ${verb}`}
        </button>
        <button
          type="button"
          className="changes__conflict-abort"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                `Abort the ${verb}? The repo goes back to where it was before it started.`,
              )
            )
              void runGit("abort");
          }}
        >
          {busyOp === "abort" ? "Aborting…" : `Abort ${verb}`}
        </button>
      </div>
    </div>
  );

  // Floating, not inline: git output is incidental to the card and belongs
  // out of the transcript's flow, where it cannot reflow the controls that
  // produced it or scroll away with the conversation.
  const toast =
    feedback &&
    createPortal(
      <div
        className={`git-toast${feedback.ok ? "" : " is-error"}`}
        role="status"
        aria-live="polite"
      >
        <div className="git-toast__head">
          <span className="git-toast__mark" aria-hidden>
            {feedback.ok ? "✓" : "!"}
          </span>
          <strong>{feedback.title}</strong>
          <button
            type="button"
            className="git-toast__close"
            aria-label="Dismiss"
            onClick={() => setFeedback(null)}
          >
            ×
          </button>
        </div>
        {feedback.output && (
          <pre className="git-toast__output">
            {feedback.output.trim().slice(0, 800)}
          </pre>
        )}
      </div>,
      document.body,
    );

  // Branch + how far it has drifted from its upstream: the one line of repo
  // state worth showing even when the tree is clean.
  const branchMeta = (
    <span className="changes__meta">
      {data?.branch}
      {data?.upstream === false && " · unpushed branch"}
      {ahead > 0 && ` · ↑${ahead}`}
      {behind > 0 && ` · ↓${behind}`}
      {stashes.length > 0 &&
        ` · ${stashes.length} stash${stashes.length === 1 ? "" : "es"}`}
    </span>
  );

  // Dismissing the card must not swallow a git error the user has not read.
  if (!data?.repo || dismissed) return <>{toast}</>;

  // Nothing to commit: collapse to a one-line repo bar so the Git menu (pull,
  // branches, stashes) stays reachable without a card's worth of chrome. The
  // post-push receipt keeps its ✓ heading until the next turn clears it.
  if (changes.length === 0) {
    return (
      <section
        className={`changes changes--clean${pushed ? " changes--pushed" : ""}${
          inProgress ? " changes--conflict" : ""
        }`}
        aria-label={pushed ? "Pushed to GitHub" : "Repository"}
      >
        <header className="changes__head">
          {pushed && (
            <span className="changes__check" aria-hidden>
              ✓
            </span>
          )}
          <strong>
            {pushed
              ? pushed.remote
                ? "Pushed to GitHub"
                : "Committed locally"
              : "Repo"}
          </strong>
          {pushed ? (
            <span className="changes__meta">
              {pushed.branch && `${pushed.branch} · `}
              {pushed.files} file{pushed.files === 1 ? "" : "s"}
            </span>
          ) : (
            branchMeta
          )}
          {gitMenu}
          <button
            type="button"
            className="changes__dismiss"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => setDismissed(true)}
          >
            ×
          </button>
        </header>
        {pushed?.output && (
          <pre className="changes__output">{pushed.output.slice(0, 800)}</pre>
        )}
        {conflictBar}
        {toast}
      </section>
    );
  }

  // Clicking anywhere on the pill (except a real control) toggles the card.
  const headerClick = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest("button, input")) return;
    toggleCollapsed();
  };

  return (
    <section
      className={`changes${inProgress ? " changes--conflict" : ""}${
        collapsed ? " changes--collapsed" : ""
      }`}
      aria-label="Code changes"
    >
      <header className="changes__head" onClick={headerClick}>
        <button
          type="button"
          className="changes__pill"
          aria-expanded={!collapsed}
          onClick={toggleCollapsed}
        >
          <strong>Changes</strong>
          <span className="changes__meta">
            {data.branch}
            {ahead > 0 && ` ↑${ahead}`}
            {behind > 0 && ` ↓${behind}`} · {changes.length} file
            {changes.length === 1 ? "" : "s"}
            {stashes.length > 0 && ` · ${stashes.length} stashed`}
          </span>
          <span className="changes__diffstat">
            <b>+{totalAdd.toLocaleString()}</b>
            <i>−{totalDel.toLocaleString()}</i>
          </span>
          <span
            className={`changes__pill-chevron${collapsed ? " is-closed" : ""}`}
            aria-hidden
          >
            <IconChevronDown size={14} />
          </span>
        </button>
        {/* Git actions only matter on the expanded card. */}
        {!collapsed && gitMenu}
        {!collapsed && (
          <button
            type="button"
            className="changes__collapse"
            aria-expanded={!collapsed}
            aria-label="Collapse changes"
            title="Collapse changes"
            onClick={toggleCollapsed}
          >
            <IconChevronDown size={14} />
          </button>
        )}
        <button
          type="button"
          className="changes__dismiss"
          aria-label="Dismiss changes"
          title="Dismiss"
          onClick={() => setDismissed(true)}
        >
          ×
        </button>
      </header>
      <ul className="changes__files">
        {changes.map((change) => (
          <li key={change.path}>
            <div className="changes__file">
              <input
                type="checkbox"
                className="changes__file-check"
                checked={!excluded.has(change.path)}
                onChange={() => toggleExcluded(change.path)}
                aria-label={`Commit ${change.path}`}
                disabled={busy}
              />
              <button
                type="button"
                className="changes__file-toggle"
                aria-expanded={openFile === change.path}
                onClick={() => void toggleFile(change.path)}
              >
                <span
                  className={`changes__status is-${change.status}`}
                  title={change.status}
                >
                  {STATUS_LETTER[change.status]}
                </span>
                <span className="changes__path" title={change.path}>
                  {change.path}
                </span>
                <span className="changes__stats">
                  <b>+{change.additions}</b>
                  <i>−{change.deletions}</i>
                </span>
              </button>
            </div>
            {openFile === change.path &&
              (diffs[change.path] ? (
                <div className="changes__diff">
                  <DiffPreview diff={diffs[change.path]!} />
                  {(hunks[change.path]?.length ?? 0) > 1 && (
                    <div className="changes__hunks">
                      {hunks[change.path]!.map((header, index) => {
                        const id = `${change.path}#${index}`;
                        return (
                          <div key={id} className="changes__hunk">
                            <code>{header}</code>
                            <button
                              type="button"
                              disabled={revertingHunk !== null}
                              onClick={async () => {
                                setRevertingHunk(id);
                                try {
                                  const result = await api.revertHunk(
                                    sessionKey,
                                    cwd || "",
                                    change.path,
                                    index,
                                  );
                                  if (result.ok) {
                                    // The diff just changed underneath us —
                                    // drop it so the next open re-fetches.
                                    setOpenFile(null);
                                    setDiffs({});
                                    setHunks({});
                                    setReloadToken((token) => token + 1);
                                  } else {
                                    setFeedback({
                                      ok: false,
                                      title:
                                        result.error ??
                                        "Could not revert that hunk.",
                                    });
                                  }
                                } finally {
                                  setRevertingHunk(null);
                                }
                              }}
                            >
                              {revertingHunk === id ? "Reverting…" : "Revert"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="changes__diff changes__diff--empty">
                  Loading diff…
                </div>
              ))}
          </li>
        ))}
      </ul>
      {conflictBar}
      {!inProgress && (
        <footer className="changes__foot">
          <input
            type="text"
            className="changes__commit-input"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Commit message (optional)"
            aria-label="Commit message"
            disabled={busy}
          />
          <button
            type="button"
            className="changes__push"
            onClick={() => void pushToGithub()}
            disabled={busy || included.length === 0 || inProgress}
            title={
              changes.every((change) => excluded.has(change.path))
                ? "No files selected"
                : undefined
            }
          >
            {pushBusy ? "Pushing…" : `Push to GitHub (${included.length})`}
          </button>
        </footer>
      )}
      {toast}
    </section>
  );
}
