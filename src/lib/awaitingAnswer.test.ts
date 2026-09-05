import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TimelineItem } from "./timeline.ts";
import { isAwaitingAnswer } from "./awaitingAnswer.ts";

let seq = 0;
const assistant = (text: string): TimelineItem => ({
  id: `a${seq++}`,
  kind: "assistant",
  text,
  live: false,
  timestamp: seq,
});
const user = (text: string): TimelineItem => ({
  id: `u${seq++}`,
  kind: "user",
  text,
  timestamp: seq,
});
const notice = (text: string): TimelineItem => ({
  id: `n${seq++}`,
  kind: "notice",
  text,
  tone: "info",
  timestamp: seq,
});

describe("isAwaitingAnswer", () => {
  it("flags a settled turn that ends on a question", () => {
    assert.equal(
      isAwaitingAnswer(
        [user("do it"), assistant("Docked on the right — correct?")],
        false,
      ),
      true,
    );
  });

  it("flags the numbered clarify shape even when it signs off", () => {
    const text = [
      "Before I build, three questions:",
      "1. Should the panel list changed files?",
      "2. Use local git credentials, or a sign-in flow?",
      "Let me know and I will start.",
    ].join("\n");
    assert.equal(isAwaitingAnswer([assistant(text)], false), true);
  });

  it("does not flag a closing report", () => {
    const text = [
      "1. What changed — greet.js: prefix is now hello.",
      "2. Verified — ran node -e, printed hello world.",
      "3. Next — nothing needed.",
    ].join("\n");
    assert.equal(isAwaitingAnswer([assistant(text)], false), false);
  });

  it("does not flag a running turn", () => {
    assert.equal(isAwaitingAnswer([assistant("Which one?")], true), false);
  });

  it("clears once the user answers", () => {
    assert.equal(
      isAwaitingAnswer([assistant("Which one?"), user("the first")], false),
      false,
    );
  });

  it("looks past a trailing notice", () => {
    assert.equal(
      isAwaitingAnswer(
        [assistant("Which one?"), notice("Auto mode is on.")],
        false,
      ),
      true,
    );
  });

  it("flags an ask fence even without a trailing question mark", () => {
    const text = [
      "```ask",
      JSON.stringify({
        questions: [
          { question: "Which page?", options: [{ label: "Fleet" }] },
        ],
      }),
      "```",
    ].join("\n");
    assert.equal(isAwaitingAnswer([assistant(text)], false), true);
  });
});
