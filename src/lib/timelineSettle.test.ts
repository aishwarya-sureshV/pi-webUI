import test from "node:test";
import assert from "node:assert/strict";

import { Timeline } from "./timeline.ts";
import type { AgentEvent, SessionState } from "./api.ts";

const state = (over: Partial<SessionState> = {}): SessionState => ({
  model: null,
  thinkingLevel: "off",
  isStreaming: false,
  sessionId: "",
  messageCount: 0,
  pendingMessageCount: 0,
  ...over,
});

const event = (payload: Record<string, unknown>): AgentEvent =>
  payload as unknown as AgentEvent;

/** A timeline mid-turn: prompt sent, one live text block, one running tool. */
function midTurn(): Timeline {
  const timeline = new Timeline("conv-1");
  timeline.setState(state());
  timeline.appendUser("do it");
  timeline.markPendingRun();
  timeline.handle(
    event({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "working on it",
      },
    }),
  );
  timeline.handle(
    event({
      type: "tool_execution_start",
      toolUseId: "t1",
      name: "bash",
      args: { command: "ls" },
    }),
  );
  return timeline;
}

const live = (timeline: Timeline) =>
  timeline.items.filter(
    (item) =>
      (item.kind === "assistant" || item.kind === "rationale") && item.live,
  ).length;

const runningTools = (timeline: Timeline) =>
  timeline.items.filter(
    (item) => item.kind === "tool" && item.status === "running",
  ).length;

test("agent_settled clears live text as well as running tools", () => {
  const timeline = midTurn();
  assert.ok(live(timeline) > 0, "expected a live text block mid-turn");
  assert.equal(runningTools(timeline), 1);

  timeline.handle(event({ type: "agent_settled" }));

  assert.equal(live(timeline), 0, "a settled agent has no live text");
  assert.equal(runningTools(timeline), 0);
  assert.equal(timeline.state?.isStreaming, false);
});

test("a backend that stops mid-turn ends the run instead of spinning", () => {
  const timeline = midTurn();
  assert.equal(timeline.state?.isStreaming, true);

  // A clean exit carries no error — the silent case that left the composer
  // showing "thinking" forever on a process that was already gone.
  timeline.handle(event({ type: "__status", status: "stopped" }));

  assert.equal(timeline.state?.isStreaming, false);
  assert.equal(live(timeline), 0);
  assert.equal(runningTools(timeline), 0);
  assert.ok(
    timeline.items.some(
      (item) => item.kind === "notice" && item.tone === "error",
    ),
    "the user must be told the backend stopped before answering",
  );
});

test("stopping outside a turn stays quiet", () => {
  const timeline = new Timeline("conv-1");
  timeline.setState(state());
  timeline.appendUser("do it");

  timeline.handle(event({ type: "__status", status: "stopped" }));

  assert.equal(
    timeline.items.some((item) => item.kind === "notice"),
    false,
    "an idle session that stops is routine, not an error",
  );
});
