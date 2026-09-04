/**
 * Grok agent, driven directly over ACP (Agent Client Protocol) instead of
 * through `pi`.
 *
 * Background: `pi --provider grok-sdk` never surfaces tool calls -- confirmed
 * by capturing its raw RPC event stream directly (thinking/text content only,
 * even when explicitly told "use your bash tool now"). That's a bug in pi's
 * native grok-sdk adapter, not in pi-web, and pi's extension system can't
 * redirect a built-in provider id to different request-building code.
 *
 * The real `grok` CLI (xAI's own harness, "grok-build") speaks ACP natively
 * via `grok agent stdio` and does emit proper tool_call/tool_call_update
 * notifications -- this adapter drives that directly and translates ACP
 * session updates into the same event vocabulary PiAgentProcess/
 * ClaudeAgentProcess already emit (message_start/message_update with
 * assistantMessageEvent envelopes, turn_end, agent_start/agent_settled),
 * captured empirically from a live pi RPC session so the existing frontend
 * needs no changes to render it.
 *
 * Session resume uses ACP's `loadSession` (confirmed working: grok replays
 * full history as session/update notifications on a fresh connection given
 * just the sessionId). Model and reasoning-effort switching both go through
 * ACP's standard `session/set_mode` -- grok exposes both models and effort
 * levels as flat "mode" options (confirmed empirically; grok's own
 * setSessionModel method rejects the standard ACP request shape, but
 * setSessionMode accepts model ids and effort ids interchangeably).
 *
 * Known gap: ACP's `prompt()` runs a turn to completion before returning, so
 * there's no protocol-level way to interject mid-turn the way pi/claude's
 * "steer" does -- steer() rejects while a turn is in flight instead of
 * silently queuing or corrupting state.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
} from "@zed-industries/agent-client-protocol";

const GROK_HOME = () => process.env.GROK_HOME || join(homedir(), ".grok");
const GROK_HOME_AUTH = () => join(GROK_HOME(), "auth.json");
export const GROK_SESSIONS_ROOT = () => join(GROK_HOME(), "sessions");
const PROXY_BASE = "https://cli-chat-proxy.grok.com/v1";
const PROXY_HEADERS = {
  "User-Agent": "grok-cli",
  "x-xai-token-auth": "xai-grok-cli",
};
const ACP_PROTOCOL_VERSION = 1;

function formatResetTime(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) return undefined;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(epochSeconds * 1000));
}

async function readGrokToken() {
  try {
    const auth = JSON.parse(await readFile(GROK_HOME_AUTH(), "utf8"));
    return (
      auth?.["https://accounts.x.ai/sign-in"]?.key ??
      Object.values(auth ?? {}).find((entry) => typeof entry?.key === "string")
        ?.key
    );
  } catch {
    // Missing or corrupt auth file simply means "not logged in"; callers
    // surface that as their own error instead of an unhandled throw.
    return undefined;
  }
}

function resolveGrokExecutable() {
  return process.env.GROK_EXECUTABLE || "grok";
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function acpTextOf(block) {
  return block?.type === "text" ? (block.text ?? "") : "";
}

// grok's ACP tool_call notifications don't populate the optional `kind`
// field (confirmed empirically), so shell-command detection falls back to
// known tool names -- this is what lets the UI show a live "running $ ..."
// indicator instead of a generic thinking spinner during shell execution.
const SHELL_TOOL_NAMES = new Set(["run_terminal_command"]);

function toolResultText(content) {
  return (content ?? [])
    .map((entry) => (entry?.type === "content" ? acpTextOf(entry.content) : ""))
    .filter(Boolean)
    .join("\n");
}

// GROK_SESSIONS_ROOT/<encodeURIComponent(cwd)>/<sessionId>/chat_history.jsonl
// -- grok's own on-disk layout. sessions.js discovers past sessions by
// scanning this directly; this adapter only needs to go the other direction
// (recover a sessionId from a chat_history.jsonl path) to resume one.
function sessionFilePathFor(cwd, sessionId) {
  return join(GROK_SESSIONS_ROOT(), encodeURIComponent(cwd), sessionId, "chat_history.jsonl");
}

function sessionIdFromPath(sessionPath) {
  return basename(dirname(sessionPath));
}

class GrokAgentProcess {
  constructor(sessionKey) {
    this.sessionKey = sessionKey;
    this.process = undefined;
    this.connection = undefined;
    this.status = "stopped";
    this.sessionId = undefined;
    this.cwd = undefined;
    this.model = undefined;
    this.sessionFile = undefined;
    this.lastState = undefined;
    this.listeners = new Set();
    this.turn = undefined;
    this.replayMode = undefined;
    // Set while replaying a resumed session's history. Replayed turns are
    // returned synchronously from start()/replayHistory() and the callers
    // hydrate from that; re-emitting them as live events would only double-
    // render the history (and, once resume is lazy, interleave it into an
    // already-rendered timeline). stderr stays visible — auth/usage failures
    // surface there.
    this.suppressReplayEvents = false;
    this.availableCommands = [];
    this.modelCatalog = undefined;
    this.messages = [];
    this.usageCache = { at: 0, result: undefined };
    this.usageRequest = undefined;
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    if (this.suppressReplayEvents && event.type !== "stderr") return;
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

  async start(cwd, options = {}) {
    if (this.process) return { ok: true, state: await this.getState() };
    let effectiveCwd = cwd;
    if (effectiveCwd && !existsSync(effectiveCwd)) {
      effectiveCwd = homedir();
      queueMicrotask(() =>
        this.emit({
          type: "stderr",
          sessionKey: this.sessionKey,
          message: `cwd not found; opened in ${effectiveCwd} instead`,
        }),
      );
    }
    this.cwd = effectiveCwd;
    this.setStatus("starting");

    try {
      const child = spawn(resolveGrokExecutable(), ["agent", "stdio"], {
        cwd: effectiveCwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.process = child;
      child.stderr.on("data", (chunk) => {
        const message = chunk.toString("utf8").trim();
        if (message)
          this.emit({ type: "stderr", sessionKey: this.sessionKey, message });
      });
      child.once("error", (error) => {
        this.process = undefined;
        this.connection = undefined;
        this.setStatus("error", error.message);
      });
      child.once("exit", (code, signal) => {
        this.process = undefined;
        if (this.turn) {
          this.turn.reject?.(new Error(`Grok exited (${signal ?? code ?? "unknown"})`));
          this.turn = undefined;
        }
        if (this.status !== "stopped") {
          this.setStatus(
            code && code !== 0 ? "error" : "stopped",
            code && code !== 0 ? `Grok exited with code ${code}` : undefined,
          );
        }
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });

      const stream = ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout),
      );
      const self = this;
      this.connection = new ClientSideConnection(
        () => ({
          async sessionUpdate(notification) {
            self.handleSessionUpdate(notification);
          },
          async requestPermission(params) {
            const options = params.options ?? [];
            const chosen =
              options.find((o) => o.kind === "allow_always") ??
              options.find((o) => o.kind === "allow_once") ??
              options[0];
            return chosen
              ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
              : { outcome: { outcome: "cancelled" } };
          },
          async writeTextFile() {
            throw new Error("writeTextFile not supported by pi-web's grok client");
          },
          async readTextFile() {
            throw new Error("readTextFile not supported by pi-web's grok client");
          },
        }),
        stream,
      );

      await this.connection.initialize({
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });

      let replayedMessages;
      if (options.sessionPath) {
        this.sessionId = sessionIdFromPath(options.sessionPath);
        this.model = options.model?.id
          ? { provider: "grok-sdk", id: options.model.id }
          : { provider: "grok-sdk", id: "grok-4.6" };
        replayedMessages = await this.replayHistory(effectiveCwd);
      } else {
        const newSession = await this.connection.newSession({
          cwd: effectiveCwd,
          mcpServers: [],
        });
        this.sessionId = newSession.sessionId;
        this.messages = [];
        this.model = options.model?.id
          ? { provider: "grok-sdk", id: options.model.id }
          : { provider: "grok-sdk", id: "grok-4.6" };
        if (options.model?.id) {
          try {
            await this.connection.setSessionMode({
              sessionId: this.sessionId,
              modeId: options.model.id,
            });
          } catch {
            /* model selection is best-effort at session creation */
          }
        }
      }
      if (options.thinkingLevel) {
        try {
          await this.connection.setSessionMode({
            sessionId: this.sessionId,
            modeId: options.thinkingLevel,
          });
        } catch {
          /* effort selection is best-effort at session creation */
        }
      }
      this.sessionFile = sessionFilePathFor(effectiveCwd, this.sessionId);
      this.setStatus("ready");
      const state = await this.getState();
      // Resume relies on the response carrying the replayed history directly
      // -- mirrors PiAgentProcess/ClaudeAgentProcess.start(), which read the
      // session file and return `messages` synchronously rather than relying
      // on the caller's SSE listener already being attached in time to catch
      // events emitted during this same call.
      return replayedMessages
        ? { ok: true, state, messages: replayedMessages }
        : { ok: true, state };
    } catch (error) {
      // A failed initialize()/loadSession must not orphan the child: it holds
      // a lock on the session's events.jsonl and would keep running (and
      // streaming to nobody) until the server exits.
      this.killChild();
      this.setStatus("error", String(error?.message ?? error));
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  // Replays a resumed session's full history. loadSession() streams the
  // whole conversation back as session/update notifications on the same
  // channel live turns use; a user_message_chunk marks the start of each
  // historical turn, so it's the boundary signal for splitting the replay
  // into discrete (user, assistant) message pairs that reuse the exact same
  // per-block accumulation logic as a live turn (appendDelta/startToolCall/
  // updateToolCall/closeOpenBlock all read and write plain "turn" objects,
  // agnostic to whether the turn is live or replayed).
  async replayHistory(cwd) {
    this.emit({ type: "agent_start", sessionKey: this.sessionKey });
    let turnIndex = 0;
    this.messages = [];
    const replayedMessages = [];

    const finalizeTurn = () => {
      if (!this.turn) return;
      this.closeOpenBlock(this.turn);
      const assistantMessage = this.turn.message;
      assistantMessage.stopReason = "end_turn";
      this.emit({ type: "turn_end", sessionKey: this.sessionKey, message: assistantMessage });
      this.emit({
        type: "agent_end",
        sessionKey: this.sessionKey,
        messages: [this.turn.userMessage, assistantMessage],
      });
      replayedMessages.push(this.turn.userMessage, assistantMessage);
      this.messages.push(this.turn.userMessage, assistantMessage);
      this.turn = undefined;
    };

    const startTurn = (userText) => {
      turnIndex += 1;
      this.emit({ type: "turn_start", sessionKey: this.sessionKey });
      const userMessage = {
        role: "user",
        content: [{ type: "text", text: userText }],
        timestamp: Date.now(),
      };
      this.emit({ type: "message_start", sessionKey: this.sessionKey, message: userMessage });
      this.emit({ type: "message_end", sessionKey: this.sessionKey, message: userMessage });
      const assistantMessage = {
        role: "assistant",
        content: [],
        api: "grok-sdk",
        provider: "grok-sdk",
        model: this.model?.id ?? "grok-4.6",
        usage: zeroUsage(),
        stopReason: "pending",
        timestamp: Date.now(),
      };
      this.emit({ type: "message_start", sessionKey: this.sessionKey, message: assistantMessage });
      this.turn = {
        content: assistantMessage.content,
        openKind: undefined,
        openIndex: undefined,
        toolIndex: new Map(),
        message: assistantMessage,
        userMessage,
      };
    };

    this.replayMode = {
      onUserChunk: (text) => {
        finalizeTurn();
        startTurn(text);
      },
    };
    this.suppressReplayEvents = true;
    try {
      // replayMode is armed before this call so every history notification
      // loadSession() streams back lands in handleSessionUpdate above.
      await this.connection.loadSession({
        sessionId: this.sessionId,
        cwd,
        mcpServers: [],
      });
    } finally {
      finalizeTurn();
      this.replayMode = undefined;
      this.suppressReplayEvents = false;
    }
    return replayedMessages;
  }

  handleSessionUpdate(notification) {
    const update = notification.update;
    if (update.sessionUpdate === "available_commands_update") {
      this.availableCommands = Array.isArray(update.availableCommands)
        ? update.availableCommands
        : [];
    }
    if (update.sessionUpdate === "user_message_chunk" && this.replayMode) {
      this.replayMode.onUserChunk(acpTextOf(update.content));
      return;
    }
    const turn = this.turn;
    if (!turn) {
      this.emit({ type: "grok_session_update", sessionKey: this.sessionKey, update });
      return;
    }
    switch (update.sessionUpdate) {
      case "agent_thought_chunk":
        this.appendDelta(turn, "thinking", acpTextOf(update.content));
        return;
      case "agent_message_chunk":
        this.appendDelta(turn, "text", acpTextOf(update.content));
        return;
      case "tool_call":
        this.startToolCall(turn, update);
        return;
      case "tool_call_update":
        this.updateToolCall(turn, update);
        return;
      default:
        // plan / current_mode_update / etc. -- preserve on the shared event
        // stream rather than dropping silently.
        this.emit({
          type: "grok_session_update",
          sessionKey: this.sessionKey,
          update,
        });
    }
  }

  closeOpenBlock(turn) {
    if (turn.openKind === "text") {
      const block = turn.content[turn.openIndex];
      this.emitUpdate(turn, {
        type: "text_end",
        contentIndex: turn.openIndex,
        content: block.text,
      });
    } else if (turn.openKind === "thinking") {
      const block = turn.content[turn.openIndex];
      this.emitUpdate(turn, {
        type: "thinking_end",
        contentIndex: turn.openIndex,
        content: block.thinking,
      });
    }
    turn.openKind = undefined;
    turn.openIndex = undefined;
  }

  appendDelta(turn, kind, delta) {
    if (!delta) return;
    if (turn.openKind !== kind) {
      this.closeOpenBlock(turn);
      turn.content.push(
        kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" },
      );
      turn.openIndex = turn.content.length - 1;
      turn.openKind = kind;
      this.emitUpdate(turn, {
        type: kind === "text" ? "text_start" : "thinking_start",
        contentIndex: turn.openIndex,
      });
    }
    const block = turn.content[turn.openIndex];
    if (kind === "text") block.text += delta;
    else block.thinking += delta;
    this.emitUpdate(turn, {
      type: kind === "text" ? "text_delta" : "thinking_delta",
      contentIndex: turn.openIndex,
      delta,
    });
  }

  startToolCall(turn, update) {
    this.closeOpenBlock(turn);
    const name = update.title ?? update.toolCallId;
    const block = {
      type: "toolCall",
      id: update.toolCallId,
      name,
      kind: update.kind,
      arguments: update.rawInput ?? {},
    };
    turn.content.push(block);
    const index = turn.content.length - 1;
    turn.toolIndex.set(update.toolCallId, index);
    this.emitUpdate(turn, { type: "toolcall_start", contentIndex: index });
    this.emit({
      type: "tool_execution_start",
      sessionKey: this.sessionKey,
      toolCallId: update.toolCallId,
      toolName: name,
      args: block.arguments,
      execKind: update.kind ?? (SHELL_TOOL_NAMES.has(name) ? "execute" : undefined),
    });
    if (update.status === "completed" || update.status === "failed") {
      this.finishToolCall(turn, index, update);
    }
  }

  updateToolCall(turn, update) {
    const index = turn.toolIndex.get(update.toolCallId);
    if (index === undefined) return; // update for a call we didn't see start
    const block = turn.content[index];
    if (update.title != null) block.name = update.title;
    if (update.rawInput != null) block.arguments = update.rawInput;
    this.emitUpdate(turn, {
      type: "toolcall_delta",
      contentIndex: index,
      delta: "",
    });
    if (update.status === "completed" || update.status === "failed") {
      this.finishToolCall(turn, index, update);
    }
  }

  finishToolCall(turn, index, update) {
    const block = turn.content[index];
    this.emitUpdate(turn, {
      type: "toolcall_end",
      contentIndex: index,
      toolCall: { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments },
    });
    this.emit({
      type: "tool_execution_end",
      sessionKey: this.sessionKey,
      toolCallId: update.toolCallId,
      result: {
        content: [{ type: "text", text: toolResultText(update.content) }],
        details: update.rawOutput ?? {},
      },
      isError: update.status === "failed",
    });
  }

  emitUpdate(_turn, assistantMessageEvent) {
    this.emit({
      type: "message_update",
      sessionKey: this.sessionKey,
      usage: zeroUsage(),
      assistantMessageEvent,
    });
  }

  async runTurn(kind, message, images) {
    if (!this.connection || !this.sessionId)
      return { ok: false, error: "Grok session is not running" };
    if (this.turn)
      return {
        ok: false,
        error:
          kind === "steer"
            ? "Grok agent does not support steering mid-turn yet"
            : "A Grok turn is already in progress",
      };

    const promptBlocks = [{ type: "text", text: message }];
    for (const image of images ?? []) {
      if (image?.data && image?.mimeType)
        promptBlocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
    }

    const userMessage = {
      role: "user",
      content: [{ type: "text", text: message }],
      timestamp: Date.now(),
    };
    this.emit({ type: "agent_start", sessionKey: this.sessionKey });
    this.emit({ type: "turn_start", sessionKey: this.sessionKey });
    this.emit({ type: "message_start", sessionKey: this.sessionKey, message: userMessage });
    this.emit({ type: "message_end", sessionKey: this.sessionKey, message: userMessage });

    const assistantMessage = {
      role: "assistant",
      content: [],
      api: "grok-sdk",
      provider: "grok-sdk",
      model: this.model?.id ?? "grok-4.6",
      usage: zeroUsage(),
      stopReason: "pending",
      timestamp: Date.now(),
    };
    this.emit({ type: "message_start", sessionKey: this.sessionKey, message: assistantMessage });

    this.turn = {
      content: assistantMessage.content,
      openKind: undefined,
      openIndex: undefined,
      toolIndex: new Map(),
    };
    this.setStatus("working");

    try {
      const response = await this.connection.prompt({
        sessionId: this.sessionId,
        prompt: promptBlocks,
      });
      this.closeOpenBlock(this.turn);
      assistantMessage.stopReason = response.stopReason;
      this.emit({ type: "turn_end", sessionKey: this.sessionKey, message: assistantMessage });
      this.emit({
        type: "agent_end",
        sessionKey: this.sessionKey,
        messages: [userMessage, assistantMessage],
      });
      this.messages.push(userMessage, assistantMessage);
      this.turn = undefined;
      this.setStatus("ready");
      this.emit({ type: "agent_settled", sessionKey: this.sessionKey });
      const state = await this.getState();
      this.emit({ type: "state", sessionKey: this.sessionKey, state });
      return { ok: true, state };
    } catch (error) {
      this.turn = undefined;
      this.setStatus("ready");
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  prompt(message, images) {
    return this.runTurn("prompt", message, images);
  }

  steer(message, images) {
    return this.runTurn("steer", message, images);
  }

  // grok's own slash commands (compact, always-approve, context, ...) are
  // plain prompt text as far as ACP is concerned -- grok's harness parses
  // the leading "/name" itself, same convention its own CLI uses.
  compact(customInstructions) {
    const text = customInstructions ? `/compact ${customInstructions}` : "/compact";
    return this.runTurn("prompt", text);
  }

  async abort() {
    if (!this.connection || !this.sessionId) return { ok: true };
    try {
      await this.connection.cancel({ sessionId: this.sessionId });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  // Hot-swaps an already-running process onto a different saved session,
  // mirroring PiAgentProcess.switchSession. ACP has no "rebind this
  // connection to another session" primitive, so this restarts the
  // underlying grok process against the requested session.
  async switchSession(sessionPath) {
    if (!sessionPath) return { ok: false, error: "sessionPath is required" };
    if (sessionPath === this.sessionFile) {
      try {
        return { ok: true, state: await this.getState() };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    }
    const cwd = this.cwd ?? homedir();
    this.stop();
    return this.start(cwd, { sessionPath });
  }

  async getMessages() {
    return this.messages;
  }

  // Starts a fresh session on the same underlying grok process -- ACP
  // supports multiple sessionIds per connection, so this doesn't need to
  // respawn the child the way switchSession does.
  async newSession() {
    if (!this.connection) return { ok: false, error: "Grok process is not running" };
    try {
      const session = await this.connection.newSession({
        cwd: this.cwd ?? homedir(),
        mcpServers: [],
      });
      this.sessionId = session.sessionId;
      this.sessionFile = sessionFilePathFor(this.cwd ?? homedir(), this.sessionId);
      this.messages = [];
      this.availableCommands = [];
      return { ok: true, state: await this.getState() };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  // Branching a conversation (pi's fork/truncate) needs either a documented
  // ACP extension for it or reverse-engineering grok's own rewind_points
  // format -- grok's ACP init response does advertise a `cancelRewind`
  // capability, suggesting something exists, but its shape isn't confirmed.
  // Fail clearly rather than guess at a protocol extension and risk silently
  // corrupting session state.
  async forkAt() {
    return { ok: false, error: "Forking a Grok conversation isn't supported yet." };
  }

  async truncateAt() {
    return { ok: false, error: "Rewinding a Grok conversation isn't supported yet." };
  }

  async getState() {
    const state = {
      status: this.status,
      isStreaming: this.status === "working",
      sessionId: this.sessionId,
      cwd: this.cwd,
      model: this.model,
      sessionFile: this.sessionFile,
    };
    this.lastState = state;
    return state;
  }

  async getCommands() {
    return {
      ok: true,
      commands: this.availableCommands.map((command) => ({
        name: command.name,
        description: command.description,
        argumentHint: command.input?.hint,
      })),
    };
  }

  async fetchModelCatalog() {
    if (this.modelCatalog) return this.modelCatalog;
    const token = await readGrokToken();
    if (!token) throw new Error("Not logged into grok-cli");
    const response = await fetch(`${PROXY_BASE}/models`, {
      headers: {
        ...PROXY_HEADERS,
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`models fetch failed: ${response.status}`);
    const payload = await response.json();
    const raw = Array.isArray(payload)
      ? payload
      : Object.values(payload?.models ?? payload?.data ?? {}).map(
          (entry) => entry?.info ?? entry,
        );
    this.modelCatalog = raw.filter((m) => m?.id ?? m?.model);
    return this.modelCatalog;
  }

  async getAvailableModels() {
    try {
      const raw = await this.fetchModelCatalog();
      const models = raw
        .filter((m) => m.hidden !== true && m.supported_in_api !== false)
        .map((m) => ({
          provider: "grok-sdk",
          id: m.id ?? m.model,
          name: m.name ?? m.id ?? m.model,
        }));
      return { ok: true, models };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async getThinkingLevels() {
    try {
      const raw = await this.fetchModelCatalog();
      const currentId = this.model?.id ?? raw[0]?.id ?? raw[0]?.model;
      const current = raw.find((m) => (m.id ?? m.model) === currentId) ?? raw[0];
      const efforts = Array.isArray(current?.reasoning_efforts)
        ? current.reasoning_efforts
        : [];
      return { ok: true, levels: efforts.map((effort) => effort.id ?? effort.value) };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async setModel(provider, modelId) {
    this.model = { provider, id: modelId };
    if (this.connection && this.sessionId) {
      try {
        await this.connection.setSessionMode({ sessionId: this.sessionId, modeId: modelId });
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    }
    return { ok: true, state: await this.getState() };
  }

  async setThinkingLevel(level) {
    if (this.connection && this.sessionId) {
      try {
        await this.connection.setSessionMode({ sessionId: this.sessionId, modeId: level });
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    }
    return { ok: true };
  }

  async getUsage(force = false) {
    const now = Date.now();
    if (!force && this.usageCache.result && now - this.usageCache.at < 5 * 60_000) {
      return this.usageCache.result;
    }
    if (this.usageRequest) return this.usageRequest;
    this.usageRequest = this.loadUsage()
      .then((result) => {
        if (result?.ok) this.usageCache = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        this.usageRequest = undefined;
      });
    return this.usageRequest;
  }

  async loadUsage() {
    try {
      const token = await readGrokToken();
      if (!token)
        return { ok: true, usage: { available: false, provider: "Grok", windows: [] } };
      const response = await fetch(`${PROXY_BASE}/billing?format=credits`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...PROXY_HEADERS,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Grok usage returned ${response.status}`);
      const payload = await response.json();
      const config = payload?.config ?? payload;
      const usedPercent = Number(config?.creditUsagePercent);
      const resetAt =
        Date.parse(String(config?.currentPeriod?.end ?? config?.billingPeriodEnd ?? "")) / 1000;
      const resetsAt = formatResetTime(resetAt);
      const windows = Number.isFinite(usedPercent)
        ? [{ label: "Current week", usedPercent, ...(resetsAt ? { resetsAt } : {}) }]
        : [];
      return {
        ok: true,
        usage: {
          available: windows.length > 0,
          provider: "Grok",
          windows,
          updatedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  killChild() {
    const child = this.process;
    this.process = undefined;
    this.connection = undefined;
    if (!child) return;
    // grok agent stdio doesn't reliably exit on SIGTERM alone -- observed
    // processes surviving well past stop() with an open write handle on
    // the session's events.jsonl, which then lock-contends with anything
    // else (including grok's own dashboard) trying to open that session.
    // Escalate to SIGKILL if it hasn't exited shortly after.
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!exited) child.kill("SIGKILL");
    }, 2000).unref();
  }

  stop() {
    this.status = "stopped";
    this.turn = undefined;
    this.replayMode = undefined;
    this.killChild();
    this.emit({ type: "__status", sessionKey: this.sessionKey, status: "stopped" });
  }
}

export class GrokAgentPool {
  constructor() {
    this.agents = new Map();
  }

  get(sessionKey) {
    let agent = this.agents.get(sessionKey);
    if (!agent) {
      agent = new GrokAgentProcess(sessionKey);
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
