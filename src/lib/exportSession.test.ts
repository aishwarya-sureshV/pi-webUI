import { strict as assert } from "node:assert";
import { test } from "node:test";
import { timelineToMarkdown, exportFilename } from "./exportSession.ts";
import type { TimelineItem } from "./timeline.ts";

const at = new Date("2026-09-05T12:00:00.000Z");
const meta = { title: "Fix the gauge", backend: "claude", model: "sonnet-5", exportedAt: at };

test("renders turns in order with a header", () => {
  const items: TimelineItem[] = [
    { id: "1", kind: "user", text: "hello", timestamp: 1 },
    { id: "2", kind: "assistant", text: "hi", live: false, timestamp: 2 },
  ];
  const md = timelineToMarkdown(items, meta);
  assert.match(md, /^# Fix the gauge/);
  assert.match(md, /\*\*Agent:\*\* claude \(sonnet-5\)/);
  assert.ok(md.indexOf("## User") < md.indexOf("### Assistant"));
});

test("tool output containing a fence cannot escape its own block", () => {
  const items: TimelineItem[] = [
    {
      id: "t", kind: "tool", name: "bash", args: {}, details: {},
      output: "```\nnested\n```", status: "done", startedAt: 1,
    },
  ];
  const md = timelineToMarkdown(items, meta);
  // The wrapper must be longer than the longest run inside it.
  assert.ok(md.includes("````"), "expected a longer fence than the nested one");
});

test("long output is truncated with a count, not silently cut", () => {
  const items: TimelineItem[] = [
    {
      id: "t", kind: "tool", name: "bash", args: {}, details: {},
      output: "x".repeat(5000), status: "done", startedAt: 1,
    },
  ];
  assert.match(timelineToMarkdown(items, meta), /… \(1000 more characters\)/);
});

test("filenames are slugged and dated", () => {
  assert.equal(exportFilename("Fix the Gauge!", at), "fix-the-gauge-2026-09-05.md");
  assert.equal(exportFilename("", at), "session-2026-09-05.md");
});
