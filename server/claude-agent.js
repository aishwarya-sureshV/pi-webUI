/**
 * Claude Code stream-json process pool.
 *
 * Each workbench session owns one long-lived `claude -p` process. The adapter
 * translates Claude's stream-json events into the event vocabulary already
 * consumed by pi-web's Timeline, while exposing the same public surface as
 * PiAgentProcess.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CO_PARTNER_PROMPT, CLARIFY_PROMPT } from "./co-partner-prompt.js";

function formatClaudeModelName(value) {
  const stripped = String(value || "")
    .trim()
    .replace(/\[1m\]$/i, "")
    .replace(/-20\d{6}(?:-v\d+)?$/i, "")
    .replace(/^claude[\s_-]+/i, "");
  const parts = stripped.split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 0) return stripped || String(value || "");
  const title = (part) =>
    part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  const family = title(parts[0] ?? "");
  const version = [];
  const extras = [];
  for (const part of parts.slice(1)) {
    if (/^\d/.test(part) && extras.length === 0) version.push(part);
    else extras.push(title(part));
  }
  return [family, version.join("."), ...extras].filter(Boolean).join(" ");
}

const CLAUDE_MODELS = [
  "claude-opus-5",
  "claude-fable-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-sonnet-4-5",
  "claude-opus-4-5",
  "claude-haiku-4-5",
].map((id) => ({ provider: "anthropic", id, name: formatClaudeModelName(id) }));
const CLAUDE_ALIASES = {
  fable: "claude-fable-5",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
};
const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const DEFAULT_CLAUDE_MODEL_ID = "claude-sonnet-5";
const DEFAULT_CLAUDE_EFFORT = "high";
const USAGE_TTL_MS = 5 * 60_000;
let usageCache = { at: 0, promise: undefined, result: undefined };

function claudeModelInfo(modelId) {
  const raw = String(modelId || "").trim();
  if (!raw) return null;
  const alias = CLAUDE_ALIASES[raw.toLowerCase()];
  const stripped = raw
    .replace(/\[1m\]$/i, "")
    .replace(/-20\d{6}(?:-v\d+)?$/i, "");
  const known = CLAUDE_MODELS.find(
    (model) =>
      model.id === raw ||
      model.id === alias ||
      model.id === stripped ||
      raw === model.id ||
      stripped === model.id ||
      raw.startsWith(`${model.id}-`) ||
      stripped.startsWith(`${model.id}-`),
  );
  if (known) return { ...known };
  const label = stripped.replace(/^claude-/, "").replace(/-/g, " ");
  return {
    provider: "anthropic",
    id: alias || raw,
    name: formatClaudeModelName(alias || stripped || raw),
  };
}

function parseClaudeUsageText(stdout) {
  let resultText = String(stdout || "");
  try {
    const parsed = JSON.parse(resultText);
    if (typeof parsed?.result === "string") resultText = parsed.result;
    else if (typeof parsed?.text === "string") resultText = parsed.text;
  } catch {
    for (const line of resultText.split("\n")) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "result" && typeof event.result === "string")
          resultText = event.result;
      } catch {
        /* ignore non-JSON output */
      }
    }
  }
  return [
    ...resultText.matchAll(
      /^(Current session|Current week[^:]*):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+))?$/gim,
    ),
  ].map((match) => ({
    label: /^Current session$/i.test(match[1])
      ? "Current session"
      : "Current week",
    usedPercent: Number(match[2]),
    ...(match[3] ? { resetsAt: match[3].trim() } : {}),
  }));
}

async function readClaudeSessionRuntime(path) {
  if (!path || !existsSync(path)) return {};
  try {
    const contents = await readFile(path, "utf8");
    let model;
    let effort;
    for (const line of contents.split("\n")) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== "assistant") continue;
      const id = entry.message?.model;
      if (typeof id === "string" && id && id !== "<synthetic>") model = id;
      if (typeof entry.effort === "string" && entry.effort.trim())
        effort = entry.effort.trim();
    }
    return { model, effort };
  } catch {
    return {};
  }
}

function loadClaudeUsage() {
  return new Promise((resolve) => {
    const child = spawn(
      resolveClaudeExecutable(),
      [
        "-p",
        "/usage",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--dangerously-skip-permissions",
      ],
      {
        cwd: homedir(),
        env: subscriptionEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        child.kill();
      } catch {
        /* already exited */
      }
      resolve(result);
    };
    const timeout = setTimeout(
      () => finish({ ok: false, error: "Claude usage check timed out." }),
      25_000,
    );
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => finish({ ok: false, error: error.message }));
    child.once("exit", (code) => {
      if (settled) return;
      const windows = parseClaudeUsageText(stdout);
      if (windows.length > 0) {
        finish({
          ok: true,
          usage: {
            available: true,
            provider: "Claude",
            windows,
            updatedAt: new Date().toISOString(),
          },
        });
        return;
      }
      finish({
        ok: code === 0,
        usage: { available: false, provider: "Claude", windows: [] },
        ...(code === 0
          ? {}
          : {
              error:
                stderr.trim() || `Claude usage check exited with code ${code}`,
            }),
      });
    });
  });
}

function resolveClaudeExecutable() {
  return process.env.PI_WEB_CLAUDE_BIN || "claude";
}

function subscriptionEnvironment() {
  const env = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
  // Claude Code otherwise silently prefers API/third-party billing over the
  // user's Claude.ai OAuth subscription when these are inherited by the server.
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ])
    delete env[name];
  return env;
}

function sessionIdFromPath(path) {
  const name = basename(String(path || ""));
  return name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : "";
}

function expectedSessionPath(cwd, sessionId) {
  if (!cwd || !sessionId) return undefined;
  return join(
    homedir(),
    ".claude",
    "projects",
    cwd.replaceAll("/", "-"),
    `${sessionId}.jsonl`,
  );
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text" && typeof part.text === "string")
        return part.text;
      if (part.type === "tool_result") {
        if (typeof part.content === "string") return part.content;
        return contentText(part.content);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeHistoryEntry(entry) {
  const timestamp = Date.parse(entry?.timestamp ?? "") || Date.now();
  const message = entry?.message;
  if (!message || typeof message !== "object") return [];
  if (entry.type === "assistant") {
    const content = Array.isArray(message.content)
      ? message.content.map((part) => {
          if (part?.type === "tool_use") {
            return {
              type: "toolCall",
              id: part.id,
              name: part.name,
              arguments: part.input ?? {},
            };
          }
          return part;
        })
      : [];
    return [{ ...message, role: "assistant", content, timestamp }];
  }
  if (entry.type !== "user") return [];
  const content = message.content;
  const text = typeof content === "string" ? content : contentText(content);
  if (/<local-command-caveat>|<command-name>|<command-message>/.test(text))
    return [];
  if (
    Array.isArray(content) &&
    content.some((part) => part?.type === "tool_result")
  ) {
    return content
      .filter((part) => part?.type === "tool_result")
      .map((part) => ({
        role: "toolResult",
        toolCallId: String(part.tool_use_id ?? ""),
        toolName: String(entry.toolUseResult?.name ?? ""),
        content: [{ type: "text", text: contentText(part.content) }],
        isError: Boolean(part.is_error),
        timestamp,
      }));
  }
  return [
    {
      role: "user",
      content:
        typeof content === "string"
          ? [{ type: "text", text: content }]
          : content,
      timestamp,
    },
  ];
}

export function messagesFromClaudeLog(contents) {
  return String(contents || "")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return normalizeHistoryEntry(JSON.parse(line));
      } catch {
        return [];
      }
    });
}

export class ClaudeAgentProcess {
  constructor(sessionKey) {
    this.sessionKey = sessionKey;
    this.process = undefined;
    this.decoder = new StringDecoder("utf8");
    this.stdoutBuffer = "";
    this.status = "stopped";
    this.cwd = homedir();
    this.options = {};
    this.sessionId = "";
    this.sessionFile = undefined;
    this.model = claudeModelInfo(DEFAULT_CLAUDE_MODEL_ID);
    this.thinkingLevel = DEFAULT_CLAUDE_EFFORT;
    this.messageCount = 0;
    this.pendingTurns = [];
    this.activeStreams = new Map();
    this.streamGenerations = new Map();
    this.intentionalExit = false;
    this.initialized = false;
    this.availableTools = [];
    this.slashCommands = [];
    this.skills = new Set();
    this.seenSubagents = new Set();
    /** @type {Set<(event: object) => void>} */
    this.listeners = new Set();
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* listener errors must not kill the pump */
      }
    }
  }

  setStatus(status, error) {
    this.status = status;
    this.emit({
      type: "__status",
      sessionKey: this.sessionKey,
      status,
      ...(error ? { error } : {}),
    });
  }

  getState() {
    return Promise.resolve({
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      isStreaming: this.status === "working",
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      messageCount: this.messageCount,
      pendingMessageCount: this.pendingTurns.length,
    });
  }

  async start(cwd, options = {}) {
    if (cwd && !existsSync(cwd)) {
      cwd = homedir();
      queueMicrotask(() =>
        this.emit({
          type: "stderr",
          sessionKey: this.sessionKey,
          message: `cwd not found; opened in ${cwd} instead`,
        }),
      );
    }
    if (this.process) return { ok: true, state: await this.getState() };
    this.cwd = cwd || homedir();
    this.options = { ...options };
    this.thinkingLevel =
      options.thinkingLevel || this.thinkingLevel || DEFAULT_CLAUDE_EFFORT;
    if (options.sessionPath) {
      this.sessionFile = options.sessionPath;
      this.sessionId = sessionIdFromPath(options.sessionPath);
      const runtime = await readClaudeSessionRuntime(options.sessionPath);
      this.model = options.model?.id
        ? (claudeModelInfo(options.model.id) ?? {
            provider: "anthropic",
            id: options.model.id,
            name: options.model.name || options.model.id,
          })
        : runtime.model
          ? (claudeModelInfo(runtime.model) ?? {
              provider: "anthropic",
              id: runtime.model,
              name: runtime.model,
            })
          : null;
      if (!options.thinkingLevel && runtime.effort)
        this.thinkingLevel = runtime.effort;
    } else {
      this.model = options.model?.id
        ? (claudeModelInfo(options.model.id) ?? {
            provider: "anthropic",
            id: options.model.id,
            name: options.model.name || options.model.id,
          })
        : claudeModelInfo(DEFAULT_CLAUDE_MODEL_ID);
    }
    try {
      await this.spawnProcess();
      const state = await this.getState();
      if (!this.sessionFile) return { ok: true, state };
      const messages = await this.getMessages();
      this.messageCount = messages.length;
      return { ok: true, state, messages };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async spawnProcess(extraArgs = []) {
    this.setStatus("starting");
    this.stdoutBuffer = "";
    this.activeStreams.clear();
    this.initialized = false;
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--forward-subagent-text",
      "--include-hook-events",
      "--verbose",
      "--append-system-prompt",
      `${CO_PARTNER_PROMPT}\n\n${CLARIFY_PROMPT}`,
    ];
    if (this.options.agentMode === "plan") {
      args.push("--permission-mode", "plan");
    } else if (this.options.accessMode === "read-only") {
      args.push("--disallowedTools", "Bash Write Edit");
    } else {
      // Verified in Claude Code 2.1.239 help as the explicit bypass-all-
      // permission-checks mode; avoids an unanswerable prompt in headless mode.
      args.push("--dangerously-skip-permissions");
    }
    if (this.sessionId) args.push("--resume", this.sessionId);
    if (this.model?.id) args.push("--model", this.model.id);
    if (this.thinkingLevel) args.push("--effort", this.thinkingLevel);
    args.push(...extraArgs);

    const child = spawn(resolveClaudeExecutable(), args, {
      cwd: this.cwd,
      env: subscriptionEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.process = child;
    this.intentionalExit = false;
    child.stdout.on("data", (chunk) => this.readStdout(chunk));
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message)
        this.emit({ type: "stderr", sessionKey: this.sessionKey, message });
    });
    child.once("error", (error) => {
      this.failPending(error);
      this.process = undefined;
      this.setStatus("error", error.message);
    });
    child.once("exit", (code, signal) => {
      this.flushStdout();
      this.process = undefined;
      if (this.intentionalExit) return;
      const error = new Error(`Claude exited (${signal ?? code ?? "unknown"})`);
      this.failPending(error);
      if (this.status !== "stopped") {
        const message =
          code && code !== 0 ? `Claude exited with code ${code}` : undefined;
        this.setStatus(message ? "error" : "stopped", message);
      }
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    this.setStatus("ready");
  }

  prompt(message, images) {
    return this.sendTurn(message, images, "prompt");
  }
  steer(message, images) {
    return this.sendTurn(message, images, "steer");
  }
  followUp(message, images) {
    return this.sendTurn(message, images, "follow_up");
  }

  sendTurn(message, images, kind = "prompt") {
    if (!this.process)
      return Promise.resolve({
        ok: false,
        error: "Claude process is not running",
      });
    const content = [{ type: "text", text: String(message ?? "") }];
    for (const image of images ?? []) {
      if (!image?.data || !image?.mimeType) continue;
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: image.mimeType,
          data: image.data,
        },
      });
    }
    const payload = { type: "user", message: { role: "user", content } };
    this.messageCount += 1;
    const joinsActiveRun = kind === "steer" && this.pendingTurns.length > 0;
    if (joinsActiveRun) {
      return new Promise((resolve) => {
        this.process.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
          resolve(
            error
              ? { ok: false, error: error.message }
              : { ok: true, data: { accepted: true, mode: "steer" } },
          );
        });
      });
    }
    const startsRun = this.pendingTurns.length === 0;
    if (startsRun) {
      this.setStatus("working");
      this.emit({ type: "agent_start", sessionKey: this.sessionKey });
    }
    return new Promise((resolve) => {
      const pending = { resolve, kind };
      this.pendingTurns.push(pending);
      this.process.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        const index = this.pendingTurns.indexOf(pending);
        if (index !== -1) this.pendingTurns.splice(index, 1);
        resolve({ ok: false, error: error.message });
      });
    });
  }

  async abort() {
    if (!this.process) return { ok: true };
    const resumeId = this.sessionId;
    await this.terminateProcess(new Error("Claude run aborted"));
    if (resumeId) this.sessionId = resumeId;
    try {
      await this.spawnProcess();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async newSession() {
    await this.terminateProcess(new Error("Claude session replaced"));
    this.sessionId = "";
    this.sessionFile = undefined;
    this.messageCount = 0;
    this.model = claudeModelInfo(DEFAULT_CLAUDE_MODEL_ID);
    this.thinkingLevel = DEFAULT_CLAUDE_EFFORT;
    try {
      await this.spawnProcess();
      return { ok: true, state: await this.getState(), messages: [] };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async switchSession(sessionPath) {
    const sessionId = sessionIdFromPath(sessionPath);
    if (!sessionId) return { ok: false, error: "Invalid Claude session path." };
    await this.terminateProcess(new Error("Claude session switched"));
    this.sessionId = sessionId;
    this.sessionFile = sessionPath;
    const runtime = await readClaudeSessionRuntime(sessionPath);
    this.model = runtime.model
      ? (claudeModelInfo(runtime.model) ?? {
          provider: "anthropic",
          id: runtime.model,
          name: runtime.model,
        })
      : null;
    if (runtime.effort) this.thinkingLevel = runtime.effort;
    try {
      await this.spawnProcess();
      const messages = await this.getMessages();
      this.messageCount = messages.length;
      return { ok: true, state: await this.getState(), messages };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  compact(customInstructions) {
    const suffix = customInstructions ? ` ${customInstructions}` : "";
    return this.sendTurn(`/compact${suffix}`);
  }

  async setModel(_provider, modelId) {
    this.model = claudeModelInfo(modelId) ?? {
      provider: "anthropic",
      id: modelId,
      name: modelId,
    };
    const result = await this.restart();
    return result.ok
      ? { ok: true, data: this.model, state: await this.getState() }
      : result;
  }

  async setThinkingLevel(level) {
    this.thinkingLevel = level;
    return this.restart();
  }

  async restart(extraArgs = []) {
    await this.terminateProcess(new Error("Claude process reconfigured"));
    try {
      await this.spawnProcess(extraArgs);
      return { ok: true, state: await this.getState() };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async getEntries() {
    if (!this.sessionFile) return [];
    const contents = await readFile(this.sessionFile, "utf8");
    return contents
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  }

  async getMessages() {
    const entries = await this.getEntries();
    return entries.flatMap(normalizeHistoryEntry);
  }

  async forkAt() {
    if (!this.sessionId)
      return { ok: false, error: "No Claude session is available to fork." };
    const messages = await this.getMessages();
    const result = await this.restart(["--fork-session"]);
    if (!result.ok) return result;
    this.sessionId = "";
    this.sessionFile = undefined;
    return { ok: true, state: await this.getState(), messages };
  }

  getCommands() {
    return Promise.resolve({
      ok: true,
      commands: this.slashCommands.map((name) => ({
        name,
        source: this.skills.has(name) ? "skill" : "claude",
      })),
    });
  }
  getAvailableModels() {
    const models = [...CLAUDE_MODELS];
    if (this.model?.id && !models.some((model) => model.id === this.model.id)) {
      models.unshift(this.model);
    }
    return Promise.resolve({ ok: true, models });
  }
  getThinkingLevels() {
    return Promise.resolve({ ok: true, levels: CLAUDE_EFFORT_LEVELS });
  }

  getUsage(force = false) {
    const now = Date.now();
    if (!force && usageCache.result && now - usageCache.at < USAGE_TTL_MS)
      return Promise.resolve(usageCache.result);
    if (usageCache.promise) return usageCache.promise;
    usageCache.promise = loadClaudeUsage()
      .then((result) => {
        if (result?.ok) {
          usageCache = { at: Date.now(), promise: undefined, result };
        } else {
          usageCache.promise = undefined;
        }
        return result;
      })
      .catch((error) => {
        usageCache.promise = undefined;
        return {
          ok: false,
          error: String(error?.message ?? error),
          usage: { available: false, provider: "Claude", windows: [] },
        };
      });
    return usageCache.promise;
  }

  readStdout(chunk) {
    this.stdoutBuffer += this.decoder.write(chunk);
    this.drainStdout();
  }

  flushStdout() {
    this.stdoutBuffer += this.decoder.end();
    this.drainStdout();
    this.stdoutBuffer = "";
  }

  drainStdout() {
    let index = this.stdoutBuffer.indexOf("\n");
    while (index !== -1) {
      let line = this.stdoutBuffer.slice(0, index);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line) this.handleLine(line);
      index = this.stdoutBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      this.emit({
        type: "claude_raw_line",
        sessionKey: this.sessionKey,
        raw: line,
      });
      return;
    }

    // Keep the provider's original stream event alongside the normalized
    // events used by the conversation UI. This makes the backend log useful
    // when Claude introduces a new event shape or a translation loses detail.
    this.emit({
      type: "claude_raw_event",
      sessionKey: this.sessionKey,
      rawType: event.type,
      event,
    });

    if (event.type === "system" && event.subtype === "init") {
      this.initialized = true;
      const authSource = event.apiKeySource ?? event.api_key_source;
      if (authSource && authSource !== "none") {
        const error = new Error(
          `Claude subscription auth required; received ${authSource}.`,
        );
        this.emit({
          type: "stderr",
          sessionKey: this.sessionKey,
          message: error.message,
        });
        void this.terminateProcess(error);
        this.setStatus("error", error.message);
        return;
      }
      if (typeof event.session_id === "string")
        this.sessionId = event.session_id;
      if (typeof event.cwd === "string") this.cwd = event.cwd;
      if (typeof event.model === "string")
        this.model = claudeModelInfo(event.model) ?? {
          provider: "anthropic",
          id: event.model,
          name: event.model,
        };
      if (Array.isArray(event.tools))
        this.availableTools = event.tools.filter(
          (tool) => typeof tool === "string",
        );
      this.skills = new Set(
        Array.isArray(event.skills)
          ? event.skills.filter((skill) => typeof skill === "string")
          : [],
      );
      this.slashCommands = [
        ...new Set(
          [
            ...(Array.isArray(event.slash_commands)
              ? event.slash_commands
              : []),
            ...(Array.isArray(event.terminal_slash_commands)
              ? event.terminal_slash_commands
              : []),
          ].filter((command) => typeof command === "string"),
        ),
      ].sort((left, right) => left.localeCompare(right));
      this.sessionFile =
        this.sessionFile ?? expectedSessionPath(this.cwd, this.sessionId);
      this.emit({
        type: "claude_init",
        sessionKey: this.sessionKey,
        apiKeySource: authSource ?? "unknown",
        sessionId: this.sessionId,
        tools: this.availableTools,
        slashCommands: this.slashCommands,
      });
      void this.getState().then((state) =>
        this.emit({ type: "state", sessionKey: this.sessionKey, state }),
      );
      return;
    }

    if (event.type === "stream_event") {
      this.handleStreamEvent(event.event, event.parent_tool_use_id);
      return;
    }

    if (event.type === "assistant" && event.message) {
      const source = event.parent_tool_use_id || "root";
      if (
        event.parent_tool_use_id &&
        !this.seenSubagents.has(event.parent_tool_use_id)
      ) {
        this.seenSubagents.add(event.parent_tool_use_id);
        this.emit({
          type: "subagent_start",
          sessionKey: this.sessionKey,
          parentToolUseId: event.parent_tool_use_id,
        });
      }
      const activeStream =
        this.activeStreams.get(source) ?? this.beginMessageStream(source);
      const content = Array.isArray(event.message.content)
        ? event.message.content
        : [];
      content.forEach((part) => {
        if (part?.type !== "tool_use") return;
        this.emit({
          type: "tool_execution_start",
          sessionKey: this.sessionKey,
          toolCallId: part.id,
          toolName: part.name,
          args: part.input ?? {},
        });
      });
      const message = {
        ...event.message,
        content: content.map((part) =>
          part?.type === "tool_use"
            ? {
                type: "toolCall",
                id: part.id,
                name: part.name,
                arguments: part.input ?? {},
              }
            : part,
        ),
        timestamp: Date.now(),
      };
      this.emit({
        type: "message_end",
        sessionKey: this.sessionKey,
        streamKey: activeStream.key,
        message,
      });
      this.messageCount += 1;
      this.activeStreams.delete(source);
      return;
    }

    if (event.type === "user" && event.message) {
      const content = Array.isArray(event.message.content)
        ? event.message.content
        : [];
      for (const part of content) {
        if (part?.type !== "tool_result") continue;
        this.emit({
          type: "tool_execution_end",
          sessionKey: this.sessionKey,
          toolCallId: part.tool_use_id,
          result: {
            content: [{ type: "text", text: contentText(part.content) }],
            details: event.toolUseResult ?? {},
          },
          isError: Boolean(part.is_error),
        });
      }
      return;
    }

    if (event.type === "result") {
      const pending = this.pendingTurns.shift();
      const ok = event.is_error !== true && event.subtype !== "error";
      pending?.resolve(
        ok
          ? { ok: true, data: event }
          : {
              ok: false,
              error: String(event.result ?? "Claude request failed"),
            },
      );
      this.emit({
        type: "turn_result",
        sessionKey: this.sessionKey,
        requestKind: pending?.kind ?? "unknown",
        ok,
        result: event.result,
      });
      if (this.pendingTurns.length === 0) {
        this.setStatus("ready");
        this.emit({ type: "agent_settled", sessionKey: this.sessionKey });
      } else {
        this.setStatus("working");
      }
      void this.getState().then((state) =>
        this.emit({ type: "state", sessionKey: this.sessionKey, state }),
      );
      return;
    }

    if (event.type === "rate_limit_event") {
      this.emit({
        type: "rate_limit_event",
        sessionKey: this.sessionKey,
        rate_limit_info: event.rate_limit_info,
      });
      return;
    }

    // Claude adds event types frequently. Preserve unknown system/hook events
    // on the shared SSE stream so the UI can surface supported lifecycle data
    // without making the adapter brittle to new fields.
    this.emit({ ...event, sessionKey: this.sessionKey });
  }

  handleStreamEvent(streamEvent, parentToolUseId) {
    if (!streamEvent || typeof streamEvent !== "object") return;
    const source = parentToolUseId || "root";
    if (streamEvent.type === "message_start") {
      if (parentToolUseId && !this.seenSubagents.has(parentToolUseId)) {
        this.seenSubagents.add(parentToolUseId);
        this.emit({
          type: "subagent_start",
          sessionKey: this.sessionKey,
          parentToolUseId,
        });
      }
      this.beginMessageStream(source);
      return;
    }
    const index = typeof streamEvent.index === "number" ? streamEvent.index : 0;
    if (streamEvent.type === "content_block_start") {
      const activeStream =
        this.activeStreams.get(source) ?? this.beginMessageStream(source);
      const block = streamEvent.content_block ?? {};
      activeStream.blocks.set(index, {
        type: block.type,
        text: block.text ?? block.thinking ?? "",
      });
      return;
    }
    if (streamEvent.type === "content_block_delta") {
      const activeStream =
        this.activeStreams.get(source) ?? this.beginMessageStream(source);
      const delta = streamEvent.delta ?? {};
      const block = activeStream.blocks.get(index) ?? {
        type: delta.type === "thinking_delta" ? "thinking" : "text",
        text: "",
      };
      const text =
        delta.type === "thinking_delta"
          ? delta.thinking
          : delta.type === "text_delta"
            ? delta.text
            : "";
      if (typeof text !== "string" || !text) return;
      block.text += text;
      activeStream.blocks.set(index, block);
      this.emit({
        type: "message_update",
        sessionKey: this.sessionKey,
        streamKey: activeStream.key,
        assistantMessageEvent: {
          type:
            delta.type === "thinking_delta" ? "thinking_delta" : "text_delta",
          contentIndex: index,
          delta: text,
        },
      });
      return;
    }
    if (streamEvent.type === "content_block_stop") {
      const activeStream = this.activeStreams.get(source);
      if (!activeStream) return;
      const block = activeStream.blocks.get(index);
      if (!block || !["text", "thinking"].includes(block.type)) return;
      this.emit({
        type: "message_update",
        sessionKey: this.sessionKey,
        streamKey: activeStream.key,
        assistantMessageEvent: {
          type: block.type === "thinking" ? "thinking_end" : "text_end",
          contentIndex: index,
          content: block.text,
        },
      });
    }
  }

  beginMessageStream(source) {
    const generation = (this.streamGenerations.get(source) ?? 0) + 1;
    this.streamGenerations.set(source, generation);
    const stream = { key: `claude-${source}-${generation}`, blocks: new Map() };
    this.activeStreams.set(source, stream);
    this.emit({
      type: "turn_start",
      sessionKey: this.sessionKey,
      streamKey: stream.key,
    });
    return stream;
  }

  failPending(error) {
    for (const pending of this.pendingTurns.splice(0)) {
      pending.resolve({ ok: false, error: String(error?.message ?? error) });
    }
  }

  async terminateProcess(error) {
    const child = this.process;
    this.process = undefined;
    this.intentionalExit = true;
    this.failPending(error);
    if (!child) return;
    this.signalProcess(child, "SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null)
        return resolve();
      const timeout = setTimeout(() => {
        this.signalProcess(child, "SIGKILL");
        resolve();
      }, 1200);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  signalProcess(child, signal) {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        /* process group already exited */
      }
    }
    try {
      child.kill(signal);
    } catch {
      /* process already exited */
    }
  }

  stop() {
    this.status = "stopped";
    void this.terminateProcess(new Error("Claude process stopped"));
    this.emit({
      type: "__status",
      sessionKey: this.sessionKey,
      status: "stopped",
    });
  }
}

export class ClaudeAgentPool {
  constructor() {
    /** @type {Map<string, ClaudeAgentProcess>} */
    this.agents = new Map();
  }

  get(sessionKey) {
    let agent = this.agents.get(sessionKey);
    if (!agent) {
      agent = new ClaudeAgentProcess(sessionKey);
      this.agents.set(sessionKey, agent);
    }
    return agent;
  }

  stop(sessionKey) {
    if (sessionKey) {
      this.agents.get(sessionKey)?.stop();
      this.agents.delete(sessionKey);
      return;
    }
    for (const agent of this.agents.values()) agent.stop();
    this.agents.clear();
  }
}
