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

const titleEvent = (key: string, title: string): AgentEvent =>
  ({
    type: "session_title_set",
    sessionKey: key,
    title,
  }) as unknown as AgentEvent;

test("a title that arrives before any state is kept, not dropped", () => {
  const timeline = new Timeline("conv-1");
  timeline.handle(
    titleEvent("conv-1", "Shrink Running Pill and Input Spacing"),
  );
  timeline.setState(state());
  assert.equal(
    timeline.state?.sessionName,
    "Shrink Running Pill and Input Spacing",
  );
});

test("a later backend state event does not clobber the generated title", () => {
  const timeline = new Timeline("conv-1");
  timeline.setState(state());
  timeline.handle(
    titleEvent("conv-1", "Shrink Running Pill and Input Spacing"),
  );
  // pi reports the name it knew when the process started — usually empty.
  timeline.setState(state({ isStreaming: true }));
  assert.equal(
    timeline.state?.sessionName,
    "Shrink Running Pill and Input Spacing",
  );
  timeline.hydrate([], state());
  assert.equal(
    timeline.state?.sessionName,
    "Shrink Running Pill and Input Spacing",
  );
});

test("a saved title from the session list survives a hydrate", () => {
  const timeline = new Timeline("conv-1");
  timeline.setState(state());
  timeline.applySessionName("Restore Codex Models From Ollama");
  timeline.hydrate([], state({ isStreaming: true }));
  assert.equal(timeline.state?.sessionName, "Restore Codex Models From Ollama");
});
