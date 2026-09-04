/**
 * Tests for the workspace path confinement used by the file-explorer
 * endpoints. The confinement logic lives in its own module (index.js cannot
 * be imported by tests — it calls server.listen at module top level).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confinePath, isWithinRoot } from "./workspace-paths.js";

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-confine-"));
  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("isWithinRoot", () => {
  it("accepts the root itself and paths under it", () => {
    assert.equal(isWithinRoot("/a/b", "/a"), true);
    assert.equal(isWithinRoot("/a", "/a"), true);
  });

  it("rejects siblings and parents", () => {
    assert.equal(isWithinRoot("/a-b/c", "/a"), false);
    assert.equal(isWithinRoot("/a2", "/a"), false);
    assert.equal(isWithinRoot("/", "/a"), false);
    assert.equal(isWithinRoot("/etc", "/a"), false);
  });
});

describe("confinePath", () => {
  it("rejects paths outside the roots", async () => {
    const { dir, cleanup } = await scratch();
    try {
      await mkdir(join(dir, "project"));
      const roots = [join(dir, "project")];
      assert.throws(() => confinePath("/etc/passwd", roots), /outside/);
      assert.throws(() => confinePath(join(dir, "other"), roots), /outside/);
      assert.throws(() => confinePath("", roots), /Missing path/);
    } finally {
      await cleanup();
    }
  });

  it("accepts paths inside the roots, including new files", async () => {
    const { dir, cleanup } = await scratch();
    try {
      await mkdir(join(dir, "project"));
      const roots = [join(dir, "project")];
      const inside = confinePath(join(dir, "project", "src", "new.ts"), roots);
      assert.equal(inside, join(dir, "project", "src", "new.ts"));
    } finally {
      await cleanup();
    }
  });

  it("rejects a symlink that escapes the root", async () => {
    const { dir, cleanup } = await scratch();
    try {
      await mkdir(join(dir, "project"));
      await writeFile(join(dir, "secret.txt"), "s");
      await symlink(join(dir, "secret.txt"), join(dir, "project", "link.txt"));
      const roots = [join(dir, "project")];
      assert.throws(() => confinePath(join(dir, "project", "link.txt"), roots), /outside/);
    } finally {
      await cleanup();
    }
  });

  it("accepts a symlink that stays inside the root", async () => {
    const { dir, cleanup } = await scratch();
    try {
      await mkdir(join(dir, "project", "sub"), { recursive: true });
      await writeFile(join(dir, "project", "real.txt"), "s");
      await symlink(join(dir, "project", "real.txt"), join(dir, "project", "sub", "link.txt"));
      const roots = [join(dir, "project")];
      const inside = confinePath(join(dir, "project", "sub", "link.txt"), roots);
      assert.equal(inside, join(dir, "project", "sub", "link.txt"));
    } finally {
      await cleanup();
    }
  });
});
