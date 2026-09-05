import type { ModelInfo } from "./api";

const CLAUDE_DEFAULT_MODEL_ID = "claude-sonnet-5";
export const CLAUDE_DEFAULT_EFFORT = "high";
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** "claude-opus-4-8" / "Claude Opus 4.8" → "Opus 4.8"; works for future families too. */
export function formatClaudeModelName(value: string | undefined): string {
  const stripped = String(value || "")
    .trim()
    .replace(/\[1m\]$/i, "")
    .replace(/-20\d{6}(?:-v\d+)?$/i, "")
    .replace(/^claude[\s_-]+/i, "");
  const parts = stripped.split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 0) return stripped || String(value || "");
  const title = (part: string) =>
    part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  const family = title(parts[0] ?? "");
  const version: string[] = [];
  const extras: string[] = [];
  for (const part of parts.slice(1)) {
    if (/^\d/.test(part) && extras.length === 0) version.push(part);
    else extras.push(title(part));
  }
  return [family, version.join("."), ...extras].filter(Boolean).join(" ");
}

export const CLAUDE_MODELS: ModelInfo[] = [
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

const CLAUDE_ALIASES: Record<string, string> = {
  fable: "claude-fable-5",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
};

export function claudeModelInfo(modelId: string | undefined): ModelInfo | null {
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

export const CLAUDE_DEFAULT_MODEL: ModelInfo = claudeModelInfo(
  CLAUDE_DEFAULT_MODEL_ID,
)!;
