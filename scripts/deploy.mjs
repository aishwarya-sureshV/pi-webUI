#!/usr/bin/env node
/**
 * pi-web deployer: spawned detached by the server's POST /api/deploy.
 *
 * Flow:
 *   1. cloud mode only: `git pull --ff-only` + `npm install` (local mode
 *      assumes your working tree IS the deployment).
 *   2. `npm run build` (vite build -> dist/).
 *   3. Record success + git HEAD in the deploy state file, then SIGTERM the
 *      API server so the supervisor (scripts/supervise.mjs) restarts it with
 *      fresh code and the freshly built dist/.
 *
 * The deployer must survive the server's death: it is spawned detached and
 * communicates only through the state file the next server process reads.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";

const ROOT = process.cwd();
const STATE_PATH = process.env.PI_WEB_DEPLOY_STATE;
const MODE = process.env.PI_WEB_DEPLOY_MODE === "cloud" ? "cloud" : "local";
const SERVER_PID = Number(process.env.PI_WEB_SERVER_PID || 0);
const STEP_TIMEOUT_MS = 10 * 60_000;
const MAX_LOG_CHARS = 6000;

if (!STATE_PATH) {
  console.error(
    "[deploy] PI_WEB_DEPLOY_STATE is not set — cannot report status.",
  );
  process.exit(1);
}

const startedAt = Date.now();
const steps = [];

// When pi-web was started through npm, npm_execpath points at npm-cli.js and
// we can run it via process.execPath. Otherwise fall back to bare `npm` on
// PATH (systemd, `node scripts/supervise.mjs` directly, etc.).
const npmCommand = process.env.npm_execpath ? process.execPath : "npm";
function npmArgs(args) {
  return process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args;
}

function persist(extra = {}) {
  const base = (() => {
    try {
      return JSON.parse(readFileSync(STATE_PATH, "utf8"));
    } catch {
      return {};
    }
  })();
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify(
      { ...base, status: "running", mode: MODE, startedAt, steps, ...extra },
      null,
      2,
    ),
  );
  renameSync(tmp, STATE_PATH);
}

function runStep(name, command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: STEP_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  const ok = result.status === 0 && !result.signal;
  steps.push({
    name,
    ok,
    exit: result.status,
    signal: result.signal || null,
    detail: ok ? output.slice(-800) || "" : output.slice(-MAX_LOG_CHARS),
  });
  persist({ log: output.slice(-MAX_LOG_CHARS) });
  return ok;
}

function gitHead() {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 10_000,
  });
  return result.status === 0 ? String(result.stdout || "").trim() : null;
}

// Must match the server's workingTreeSignature() exactly — the Deploy button
// compares this stored value against the live tree to light the pending dot,
// so uncommitted edits count too.
function treeSignature() {
  const result = spawnSync(
    "sh",
    ["-c", "git rev-parse HEAD && git status --porcelain && git diff HEAD"],
    {
      cwd: ROOT,
      encoding: "buffer",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.status !== 0) return null;
  return createHash("sha256").update(result.stdout).digest("hex").slice(0, 16);
}
persist({ finishedAt: null, error: null, commit: null });

if (MODE === "cloud") {
  if (!runStep("git pull --ff-only", "git", ["pull", "--ff-only"])) {
    persist({
      status: "failed",
      finishedAt: Date.now(),
      error: "git pull failed — resolve/push first, then deploy again.",
    });
    process.exit(1);
  }
  // package.json/lock may have changed in the pull — npm install is a fast
  // no-op when nothing changed.
  if (
    !runStep(
      "npm install",
      npmCommand,
      npmArgs(["install", "--no-audit", "--no-fund"]),
    )
  ) {
    persist({
      status: "failed",
      finishedAt: Date.now(),
      error: "npm install failed — see log for details.",
    });
    process.exit(1);
  }
}

const buildOk = runStep("npm run build", npmCommand, npmArgs(["run", "build"]));
if (!buildOk) {
  persist({
    status: "failed",
    finishedAt: Date.now(),
    error: "Build failed — see log for details.",
  });
  process.exit(1);
}

persist({
  status: "success",
  finishedAt: Date.now(),
  commit: gitHead(),
  signature: treeSignature(),
  error: null,
  // Per-mode history so the UI can show "last local deploy" (time) and
  // "last cloud deploy" (time + commit) side by side.
  ...(MODE === "cloud"
    ? {
        lastCloud: {
          finishedAt: Date.now(),
          commit: gitHead(),
          signature: treeSignature(),
        },
      }
    : {
        lastLocal: {
          finishedAt: Date.now(),
          commit: gitHead(),
          signature: treeSignature(),
        },
      }),
});

if (SERVER_PID) {
  try {
    process.kill(SERVER_PID, "SIGTERM");
  } catch (error) {
    // Server already gone (e.g. crashed mid-deploy) — the supervisor will
    // have restarted it on its own; nothing to signal.
    steps.push({
      name: "restart server",
      ok: false,
      exit: null,
      signal: null,
      detail: String(error?.message || error),
    });
    persist();
  }
}
