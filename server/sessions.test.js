/**
 * Tests for sessions.js path discipline — the highest-risk logic in the repo.
 * Only failure paths are exercised (they mutate nothing); success paths would
 * write into the real ~/.pi/agent session store.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveSession, deleteSession, loadSessionLog, readSessionMessages } from "./sessions.js";

describe("session path confinement", () => {
  it("rejects non-jsonl paths", async () => {
    const result = await archiveSession("/etc/passwd");
    assert.equal(result.ok, false);
    assert.match(result.error, /Invalid saved session path/);
  });

  it("rejects jsonl files outside the session roots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-sessions-test-"));
    try {
      const outside = join(dir, "not-a-session.jsonl");
      await writeFile(outside, "{}");
      const result = await archiveSession(outside);
      assert.equal(result.ok, false);
      assert.match(result.error, /not a saved Pi, Claude, or Grok session/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects missing files", async () => {
    const result = await loadSessionLog("/tmp/does-not-exist.jsonl");
    assert.equal(result.ok, false);
  });

  it("rejects empty and non-string paths", async () => {
    assert.equal((await archiveSession("")).ok, false);
    assert.equal((await deleteSession(undefined)).ok, false);
  });

  it("readSessionMessages never throws on hostile input", async () => {
    const result = await readSessionMessages("/tmp/not-a-session.jsonl");
    assert.equal(result.ok, false);
    assert.deepEqual(result.messages, []);
  });
});
