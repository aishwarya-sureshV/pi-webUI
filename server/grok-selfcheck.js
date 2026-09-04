#!/usr/bin/env node
/**
 * Verifies grok-agent.js's ACP integration still works against whatever
 * `grok` CLI version is currently installed. Run this after any grok update
 * (grok has `auto_update = true` by default, so it can change out from under
 * pi-web silently) -- each check maps to a specific behavior grok-agent.js
 * relies on that isn't part of grok's documented/stable surface, discovered
 * by live-probing rather than reading docs. A failure here points at the
 * exact place in grok-agent.js to look, instead of "Grok feels broken again."
 *
 * Runs entirely in a disposable scratch directory and deletes the grok
 * session it creates when done, so it leaves no trace in real project
 * session history.
 *
 * Usage: node server/grok-selfcheck.js   (or: npm run check:grok)
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrokAgentPool } from "./grok-agent.js";

const results = [];

function check(name, relianceNote) {
  return {
    pass(detail) {
      results.push({ name, ok: true, detail });
      console.log(`  ok  ${name}${detail ? ` -- ${detail}` : ""}`);
    },
    fail(detail) {
      results.push({ name, ok: false, detail, relianceNote });
      console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
      console.log(`       relies on: ${relianceNote}`);
    },
  };
}

async function main() {
  let grokVersion = "(unknown)";
  try {
    grokVersion = execFileSync("grok", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    console.log(`Could not run 'grok --version': ${error.message}`);
    console.log("Is the grok CLI installed and on PATH?");
    process.exit(1);
  }
  console.log(`grok-agent.js self-check against: ${grokVersion}\n`);

  const scratchDir = await mkdtemp(join(tmpdir(), "grok-selfcheck-"));
  const pool = new GrokAgentPool();
  const agent = pool.get("selfcheck");
  let sessionFile;

  try {
    // 1. Session creation
    const c1 = check("start() creates a session", "GrokAgentProcess.start(), the non-resume branch");
    const start = await agent.start(scratchDir, {});
    if (start.ok && start.state?.sessionId) {
      sessionFile = start.state.sessionFile;
      c1.pass(`sessionId ${start.state.sessionId}`);
    } else {
      c1.fail(start.error ?? "no sessionId in state");
      throw new Error("cannot continue without a session");
    }

    // 2. Tool call visibility + shell-tool name mapping
    const c2 = check(
      "tool calls fire with the expected shell-tool name",
      'grok-agent.js SHELL_TOOL_NAMES = ["run_terminal_command"] -- drives the live "running $ ..." indicator',
    );
    const toolEvents = [];
    const unsub = agent.onEvent((e) => {
      if (e.type === "tool_execution_start") toolEvents.push(e);
    });
    const p1 = await agent.prompt("Run `pwd` using your shell tool right now, then stop.");
    unsub();
    if (!p1.ok) {
      c2.fail(p1.error ?? "prompt failed");
    } else if (toolEvents.length === 0) {
      c2.fail("model didn't call a tool for an explicit tool-use instruction (or the flow itself broke)");
    } else if (!toolEvents.some((e) => e.toolName === "run_terminal_command")) {
      c2.fail(`tool call used name(s) ${JSON.stringify(toolEvents.map((e) => e.toolName))}, not "run_terminal_command" -- update SHELL_TOOL_NAMES in grok-agent.js`);
    } else if (!toolEvents.some((e) => e.execKind === "execute")) {
      c2.fail("tool call fired but execKind wasn't set to \"execute\" -- check the SHELL_TOOL_NAMES fallback logic");
    } else {
      c2.pass(`tool(s): ${toolEvents.map((e) => e.toolName).join(", ")}`);
    }

    // 3. Model catalog
    const c3 = check("getAvailableModels() returns models", "fetchModelCatalog() hitting cli-chat-proxy.grok.com/v1/models");
    const models = await agent.getAvailableModels();
    if (models.ok && models.models?.length > 0) c3.pass(models.models.map((m) => m.id).join(", "));
    else c3.fail(models.error ?? "empty model list");

    // 4. Thinking levels
    const c4 = check("getThinkingLevels() returns effort levels", "reasoning_efforts field on the model catalog entries");
    const levels = await agent.getThinkingLevels();
    if (levels.ok && levels.levels?.length > 0) c4.pass(levels.levels.join(", "));
    else c4.fail(levels.error ?? "empty levels list");

    // 5. Model switching
    const c5 = check(
      "setModel() succeeds via session/set_mode",
      "connection.setSessionMode({modeId: <model id>}) -- setSessionModel is known broken, set_mode is the workaround",
    );
    const otherModel = models.models?.find((m) => m.id !== start.state.model?.id) ?? models.models?.[0];
    if (otherModel) {
      const sm = await agent.setModel("grok-sdk", otherModel.id);
      if (sm.ok) c5.pass(`switched to ${otherModel.id}`);
      else c5.fail(sm.error);
    } else {
      c5.fail("no alternate model available to test switching");
    }

    // 6. Thinking-level switching
    const c6 = check(
      "setThinkingLevel() succeeds via session/set_mode",
      "connection.setSessionMode({modeId: <effort id>}) -- same set_mode call, different id namespace",
    );
    const level = levels.levels?.[0];
    if (level) {
      const stl = await agent.setThinkingLevel(level);
      if (stl.ok) c6.pass(level);
      else c6.fail(stl.error);
    } else {
      c6.fail("no effort level available to test switching");
    }

    // 7. Commands
    const c7 = check("getCommands() returns available_commands_update data", "handleSessionUpdate capturing available_commands_update notifications");
    const commands = await agent.getCommands();
    if (commands.ok && commands.commands?.length > 0) c7.pass(`${commands.commands.length} commands`);
    else c7.fail(commands.error ?? "empty commands list");

    // 8. Usage / auth
    const c8 = check("getUsage() reaches the billing endpoint", "~/.grok/auth.json token against cli-chat-proxy.grok.com/v1/billing");
    const usage = await agent.getUsage(true);
    if (usage.ok) c8.pass(usage.usage?.available ? "usage data available" : "reachable, no usage data (fine if this account has none)");
    else c8.fail(usage.error);

    agent.stop();

    // 9. Full resume/replay pipeline
    const c9 = check(
      "resume replays history with tool calls intact",
      "connection.loadSession() + replayHistory()'s turn-boundary detection on user_message_chunk",
    );
    if (!sessionFile) {
      c9.fail("no sessionFile recorded from step 1");
    } else {
      const agent2 = pool.get("selfcheck-resumed");
      const resumed = await agent2.start(scratchDir, { sessionPath: sessionFile });
      if (!resumed.ok) {
        c9.fail(resumed.error);
      } else {
        const assistantMsg = resumed.messages?.find((m) => m.role === "assistant");
        const hasToolCall = assistantMsg?.content?.some((c) => c.type === "toolCall");
        if (resumed.messages?.length >= 2 && hasToolCall) {
          c9.pass(`${resumed.messages.length} messages replayed, tool call present`);
        } else {
          c9.fail(`replayed ${resumed.messages?.length ?? 0} messages, tool call present: ${Boolean(hasToolCall)}`);
        }
      }
      agent2.stop();
    }
  } finally {
    agent.stop();
    pool.stop();
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    if (sessionFile) {
      // sessionFile's grandparent dir is the encoded-cwd folder; only remove
      // the one session directory this run created, not the whole tree.
      const { dirname } = await import("node:path");
      await rm(dirname(sessionFile), { recursive: true, force: true }).catch(() => {});
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.log("\nFailed checks and what to do:");
    for (const f of failed) {
      console.log(`- ${f.name}\n  ${f.detail ?? ""}\n  Fix in: server/grok-agent.js (${f.relianceNote})`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("Self-check crashed:", error);
  process.exit(1);
});
