import test from "node:test";
import assert from "node:assert/strict";

import { Timeline } from "./timeline.ts";
import type { AgentEvent, SessionState } from "./api.ts";

/**
 * Repro for "reload mid-turn loses the thinking/working indicators": an
 * adopted run's carried runtime log opens with pre-run bookkeeping events
 * (__status / trailing state / command responses) before the turn's
 * agent_start. replayLiveTurn must find the in-flight turn and keep the
 * timeline streaming instead of reporting a torn buffer.
 */
test("replay of an adopted mid-run log keeps streaming", () => {
  // Shaped like a real carried log: process-start noise, then the in-flight
  // turn, with no agent_end yet.
  const entries = [
    {
      id: "a",
      timestamp: 1,
      source: "pi",
      payload: { type: "__status", status: "ready" },
    },
    {
      id: "b",
      timestamp: 2,
      source: "pi",
      payload: { type: "state", state: { isStreaming: false } },
    },
    { id: "c", timestamp: 3, source: "pi", payload: { type: "agent_start" } },
    {
      id: "d",
      timestamp: 4,
      source: "pi",
      payload: {
        type: "message_start",
        message: { role: "user", content: "do it" },
      },
    },
    {
      id: "e",
      timestamp: 5,
      source: "pi",
      payload: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "working on it" },
      },
    },
  ] as unknown as Parameters<Timeline["replayLiveTurn"]>[0];

  const timeline = new Timeline("conv-repro");
  const state: SessionState = {
    model: null,
    thinkingLevel: "off",
    isStreaming: true,
    sessionId: "s",
    sessionFile: "/tmp/fake.jsonl",
    messageCount: 0,
    pendingMessageCount: 0,
  };
  // What resumeConversation does on adoption: state first, then replay.
  timeline.setState(state);
  timeline.handle({ type: "message_update" } as unknown as AgentEvent); // noop warm-up, mirrors live page
  const outcome = timeline.replayLiveTurn(entries);
  assert.equal(outcome, "live", "an in-flight turn must replay as live");
  assert.equal(timeline.status, "working");
  assert.equal(timeline.state?.isStreaming, true);
  assert.ok(
    timeline.items.some(
      (item) => item.kind === "user" && item.text === "do it",
    ),
    "the in-flight user message must be restored",
  );
});
