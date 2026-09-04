import { useCallback, useEffect, useRef, useState } from "react";
import { api, type GitChange, type GitChangesResponse } from "../lib/api";
import { DiffPreview } from "./ToolCard";
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

const STATUS_LETTER: Record<GitChange["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
};

/**
 * Post-turn "Changes" card: lists the working tree's uncommitted changes and
 * offers a one-click commit + push to the repo's origin (GitHub). Renders
 * nothing unless the repo is connected and something actually changed.
 */
export function ChangesPanel({
  sessionKey,
  cwd,
  streaming,
}: {
  sessionKey: string;
  cwd?: string;
  streaming: boolean;
}) {
  const [data, setData] = useState<GitChangesResponse | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, ToolDiff | undefined>>({});
  const [message, setMessage] = useState("");
  const [push, setPush] = useState<{
    busy: boolean;
    ok?: boolean;
    text?: string;
  }>({ busy: false });
  const [reloadToken, setReloadToken] = useState(0);
  const wasStreaming = useRef(streaming);
  const fetchToken = useRef(0);

  const refresh = useCallback(async () => {
    const token = ++fetchToken.current;
    try {
      const result = await api.gitChanges(sessionKey, cwd || "");
      if (token === fetchToken.current) setData(result);
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
      setReloadToken((token) => token + 1);
    }
  }, [streaming]);

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
        }
      } catch {
        // A failed fetch collapses the row; toggling again retries.
        setOpenFile(null);
      }
    }
  };

  const pushToGithub = async () => {
    if (push.busy) return;
    setPush({ busy: true });
    try {
      const result = await api.gitCommitPush(
        sessionKey,
        cwd || "",
        message.trim() || "Update from pi-web",
      );
      if (result.ok) {
        setPush({
          busy: false,
          ok: true,
          text: "Committed and pushed to GitHub.",
        });
        setMessage("");
        setOpenFile(null);
        setDiffs({});
        setReloadToken((token) => token + 1);
      } else {
        setPush({
          busy: false,
          ok: false,
          text: result.error ?? "Push failed.",
        });
      }
    } catch (error) {
      setPush({
        busy: false,
        ok: false,
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const changes = data?.changes ?? [];
  if (!data?.repo || !data.connected || changes.length === 0 || dismissed)
    return null;

  return (
    <section className="changes" aria-label="Code changes">
      <header className="changes__head">
        <strong>Changes</strong>
        <span className="changes__meta">
          {data.branch} · {changes.length} file
          {changes.length === 1 ? "" : "s"}
        </span>
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
            <button
              type="button"
              className="changes__file"
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
            {openFile === change.path &&
              (diffs[change.path] ? (
                <div className="changes__diff">
                  <DiffPreview diff={diffs[change.path]!} />
                </div>
              ) : (
                <div className="changes__diff changes__diff--empty">
                  Loading diff…
                </div>
              ))}
          </li>
        ))}
      </ul>
      <footer className="changes__foot">
        <input
          type="text"
          className="changes__commit-input"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Commit message (optional)"
          aria-label="Commit message"
          disabled={push.busy}
        />
        <button
          type="button"
          className="changes__push"
          onClick={() => void pushToGithub()}
          disabled={push.busy}
        >
          {push.busy ? "Pushing…" : "Push to GitHub"}
        </button>
      </footer>
      {push.text && (
        <p
          className={`changes__message${push.ok === false ? " is-error" : ""}`}
        >
          {push.text}
        </p>
      )}
    </section>
  );
}
