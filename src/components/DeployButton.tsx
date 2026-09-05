import { useCallback, useEffect, useRef, useState } from "react";
import { api, type DeployStatusResponse } from "../lib/api";
import { IconChevronDown, IconCloud, IconLaptop } from "./icons";

/**
 * One-click deploy, split button:
 *   - Primary click: deploy LOCAL (default) — build the working tree as-is
 *     + restart the API server + reload the page. Uncommitted changes
 *     included; nothing is pulled or pushed.
 *   - Caret ▾: menu with the two flavors. Cloud runs git pull --ff-only +
 *     npm install + build + restart, i.e. deploys the latest pushed commit.
 *
 * Progress is read back through /api/deploy/status — the deployer is a
 * detached process that outlives the server restart.
 */

type Phase = "idle" | "deploying" | "restarting" | "failed";
type Variant = "local" | "cloud";

const IDLE_POLL_MS = 15_000;
const ACTIVE_POLL_MS = 1_500;
const RESTART_TIMEOUT_MS = 120_000;

function formatAgo(ts?: number | null): string {
  if (!ts) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function DeployButton() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [variant, setVariant] = useState<Variant>("local");
  const [status, setStatus] = useState<DeployStatusResponse | null>(null);
  const [deployStartedAt, setDeployStartedAt] = useState<number | null>(null);
  const [message, setMessage] = useState<string>("");
  const [menuOpen, setMenuOpen] = useState(false);
  const mountedRef = useRef(true);
  const groupRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Close the dropdown on any click outside it.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (groupRef.current && !groupRef.current.contains(event.target as Node))
        setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  const fetchStatus =
    useCallback(async (): Promise<DeployStatusResponse | null> => {
      try {
        return await api.deployStatus();
      } catch {
        return null;
      }
    }, []);

  // Idle polling: keep the "un-deployed changes" dot and menu info fresh.
  useEffect(() => {
    if (phase !== "idle") return;
    let cancelled = false;
    const tick = async () => {
      const next = await fetchStatus();
      if (!cancelled && mountedRef.current && next?.ok) {
        setStatus(next);
        // Another pane (or a page reload mid-deploy) started a deploy — adopt it.
        if (next.deploying) {
          setVariant(next.last?.mode === "cloud" ? "cloud" : "local");
          setDeployStartedAt(next.last?.startedAt ?? Date.now());
          setPhase("deploying");
        }
      }
    };
    void tick();
    const timer = setInterval(tick, IDLE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, fetchStatus]);

  // While deploying: poll status until the deployer reports success/failed.
  useEffect(() => {
    if (phase !== "deploying") return;
    let cancelled = false;
    const timer = setInterval(async () => {
      const next = await fetchStatus();
      if (cancelled || !mountedRef.current || !next?.ok) return;
      setStatus(next);
      const last = next.last;
      if (next.stale) {
        setPhase("failed");
        setMessage("Deploy timed out — check the backend log.");
        return;
      }
      if (
        last?.status === "failed" &&
        (deployStartedAt === null ||
          (last.finishedAt ?? 0) > deployStartedAt - 2000)
      ) {
        setPhase("failed");
        setMessage(last.error || "Deploy failed — hover for details.");
        return;
      }
      if (
        last?.status === "success" &&
        (last.finishedAt ?? 0) > (deployStartedAt ?? 0)
      ) {
        setPhase("restarting");
      }
    }, ACTIVE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, deployStartedAt, fetchStatus]);

  // While restarting: wait for the server to come back up with a new boot id,
  // then reload the page so the UI picks up the new build.
  useEffect(() => {
    if (phase !== "restarting") return;
    let cancelled = false;
    const deadline = Date.now() + RESTART_TIMEOUT_MS;
    const timer = setInterval(async () => {
      try {
        const health = await api.health();
        if (cancelled || !mountedRef.current || !health?.ok) return;
        const bootedAfterDeploy =
          (health.bootMs ?? 0) > (deployStartedAt ?? 0) ||
          (deployStartedAt === null && health.ok);
        if (bootedAfterDeploy) {
          clearInterval(timer);
          window.location.reload();
          return;
        }
      } catch {
        // Server is down mid-restart — expected, keep waiting.
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        setPhase("failed");
        setMessage(
          "Deployed, but the server never came back — restart it manually.",
        );
      }
    }, ACTIVE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, deployStartedAt]);

  const startDeploy = useCallback(
    async (which: Variant) => {
      if (phase === "deploying" || phase === "restarting") return;
      setMenuOpen(false);
      try {
        const result = await api.deploy(which);
        if (!result.ok) {
          setVariant(which);
          setPhase("failed");
          setMessage(result.error || "Failed to start deploy.");
          return;
        }
        setVariant(which);
        setDeployStartedAt(Date.now());
        setMessage("");
        setPhase("deploying");
      } catch (error) {
        setVariant(which);
        setPhase("failed");
        setMessage(
          error instanceof Error ? error.message : "Failed to start deploy.",
        );
      }
    },
    [phase],
  );

  const deploying = phase === "deploying" || phase === "restarting";
  const failed = phase === "failed";
  // Primary click: retry the failed variant if the last deploy failed,
  // otherwise default to local.
  const primaryVariant: Variant = failed ? variant : "local";
  const busyOnPrimary = deploying && variant === primaryVariant;
  const failedOnPrimary = failed && variant === primaryVariant;
  const label = busyOnPrimary
    ? phase === "restarting"
      ? "Restarting…"
      : "Deploying…"
    : failedOnPrimary
      ? "Deploy failed — retry"
      : "Deploy";

  // Pending dot: the working tree differs from the most recent deploy of
  // either kind (commit or tree signature).
  const head = status?.head ?? null;
  const records = [status?.lastLocal, status?.lastCloud].filter(
    (record): record is NonNullable<typeof record> => Boolean(record),
  );
  const lastSuccessful =
    records.length > 0
      ? records.reduce((a, b) =>
          (a.finishedAt ?? 0) >= (b.finishedAt ?? 0) ? a : b,
        )
      : status?.last?.status === "success"
        ? status.last
        : null;
  const hasPending =
    Boolean(lastSuccessful) &&
    ((Boolean(head) &&
      Boolean(lastSuccessful?.commit) &&
      head !== lastSuccessful?.commit) ||
      (Boolean(status?.signature) &&
        Boolean(lastSuccessful?.signature) &&
        status?.signature !== lastSuccessful?.signature));

  const primaryTitle = [
    primaryVariant === "local" ? "Deploy (local)" : "Deploy (cloud)",
    `Last local deploy: ${formatAgo(status?.lastLocal?.finishedAt)}`,
  ].join("\n");

  const cloudSub = status?.lastCloud?.commit
    ? `Last deploy: @ ${status.lastCloud.commit} · HEAD: ${head ?? "unknown"}`
    : "No cloud deploy yet";

  return (
    <span className="conversation-header__deploy-group" ref={groupRef}>
      <button
        type="button"
        className={`conversation-header__deploy${busyOnPrimary ? " is-busy" : ""}${
          failedOnPrimary ? " is-failed" : ""
        }${hasPending && phase === "idle" ? " has-pending" : ""}`}
        onClick={() => void startDeploy(primaryVariant)}
        disabled={deploying}
        title={primaryTitle}
        aria-label={`Deploy (${primaryVariant})${deploying ? " in progress" : ""}`}
      >
        <span className="conversation-header__deploy-icon">
          {primaryVariant === "cloud" ? (
            <IconCloud size={14} />
          ) : (
            <IconLaptop size={14} />
          )}
        </span>
        <span className="conversation-header__deploy-label">{label}</span>
        {failedOnPrimary && message && (
          <span className="conversation-header__deploy-error" role="status">
            {message}
          </span>
        )}
        {hasPending && phase === "idle" && (
          <span
            className="conversation-header__deploy-dot"
            aria-hidden="true"
          />
        )}
      </button>
      <button
        type="button"
        className="conversation-header__deploy-caret"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="Deploy options"
        title="Deploy options"
        onClick={() => setMenuOpen((open) => !open)}
        disabled={deploying}
      >
        <IconChevronDown size={12} />
      </button>
      {menuOpen && (
        <div className="conversation-header__deploy-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="conversation-header__deploy-menu-item"
            onClick={() => void startDeploy("local")}
            disabled={deploying}
          >
            <span className="conversation-header__deploy-menu-head">
              <IconLaptop size={14} /> Local
            </span>
            <span className="conversation-header__deploy-menu-sub">
              Last deploy: {formatAgo(status?.lastLocal?.finishedAt)}
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="conversation-header__deploy-menu-item"
            onClick={() => void startDeploy("cloud")}
            disabled={deploying}
          >
            <span className="conversation-header__deploy-menu-head">
              <IconCloud size={14} /> Cloud
            </span>
            <span className="conversation-header__deploy-menu-sub">
              {cloudSub}
            </span>
          </button>
        </div>
      )}
    </span>
  );
}
