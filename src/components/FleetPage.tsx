import { useStore, useTimeline, type ConversationTab } from "../lib/store";
import { backendLabel } from "../lib/api";
import { formatRelativeTime } from "../lib/time";
import { IconFolder } from "./icons";

/**
 * One board for every open conversation.
 *
 * The sidebar already lists sessions; what it cannot show is which of several
 * parallel runs is working, which finished, and which is sitting waiting for
 * an answer. That question is the whole reason this view exists, so the cards
 * are ordered by how much they want attention, not by name.
 */
export function FleetPage({
  onFocusSession,
}: {
  onFocusSession: (key: string) => void;
}) {
  const { tabs, workingKeys, awaitingKeys, activeKey } = useStore();

  const rank = (tab: ConversationTab) =>
    awaitingKeys.has(tab.key) ? 0 : workingKeys.has(tab.key) ? 1 : 2;
  const ordered = [...tabs].sort((left, right) => rank(left) - rank(right));

  return (
    <div className="resource-page">
      <header className="resource-page__header">
        <div>
          <h1>Fleet</h1>
          <p>
            Every conversation you have open, with the ones that want attention
            first.
          </p>
        </div>
      </header>
      <div className="resource-page__content">
        {ordered.length === 0 ? (
          <div className="resource-page__empty">
            No conversations are open yet.
          </div>
        ) : (
          <div className="fleet-grid">
            {ordered.map((tab) => (
              <FleetCard
                key={tab.key}
                tab={tab}
                working={workingKeys.has(tab.key)}
                awaiting={awaitingKeys.has(tab.key)}
                active={tab.key === activeKey}
                onFocus={() => onFocusSession(tab.key)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FleetCard({
  tab,
  working,
  awaiting,
  active,
  onFocus,
}: {
  tab: ConversationTab;
  working: boolean;
  awaiting: boolean;
  active: boolean;
  onFocus: () => void;
}) {
  // Subscribing per card keeps each one live without the board re-rendering
  // whenever any other conversation ticks.
  const timeline = useTimeline(tab.timeline);
  const items = timeline?.items ?? [];
  const state = timeline?.state;

  const lastMeaningful = items.findLast(
    (item) =>
      item.kind === "assistant" || item.kind === "tool" || item.kind === "user",
  );
  const activity =
    lastMeaningful?.kind === "tool"
      ? `${lastMeaningful.name}${lastMeaningful.status === "running" ? "…" : ""}`
      : lastMeaningful?.kind === "assistant" || lastMeaningful?.kind === "user"
        ? lastMeaningful.text.replace(/\s+/g, " ").trim().slice(0, 110)
        : "Nothing yet";
  const at =
    lastMeaningful?.kind === "tool"
      ? lastMeaningful.startedAt
      : lastMeaningful?.timestamp;

  const status = awaiting
    ? { label: "Waiting on you", tone: "awaiting" }
    : working
      ? { label: "Working", tone: "working" }
      : { label: "Idle", tone: "idle" };

  const queued = state?.queuedMessages?.length ?? 0;

  return (
    <button
      type="button"
      className={`fleet-card fleet-card--${status.tone}${active ? " is-active" : ""}`}
      onClick={onFocus}
    >
      <div className="fleet-card__head">
        <span className={`fleet-card__dot fleet-card__dot--${status.tone}`} />
        <strong>{tab.label || "Untitled"}</strong>
        <em>{status.label}</em>
      </div>
      <p className="fleet-card__activity">{activity}</p>
      <div className="fleet-card__meta">
        <span>
          <IconFolder size={12} /> {tab.cwd.split("/").filter(Boolean).at(-1)}
        </span>
        <span>{backendLabel(tab.backend)}</span>
        {state?.model?.name && <span>{state.model.name}</span>}
        {queued > 0 && <span>{queued} queued</span>}
        {at && <span>{formatRelativeTime(at)}</span>}
      </div>
    </button>
  );
}
