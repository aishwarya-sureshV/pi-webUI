import type { ResumeSession } from "./api";

const BRANDS: Record<string, string> = {
  claude: "Claude",
  deepseek: "DeepSeek",
  gemini: "Gemini",
  glm: "GLM",
  gpt: "GPT",
  grok: "Grok",
  kimi: "Kimi",
  llama: "Llama",
  mistral: "Mistral",
  qwen: "Qwen",
};

/** `deepseek-v4-pro:cloud` → "DeepSeek V4 Pro". */
export function formatSessionModelName(id: string | undefined): string {
  const raw = String(id || "").trim();
  if (!raw) return "Unknown model";
  return raw
    .replace(/:cloud$/i, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (BRANDS[lower]) return BRANDS[lower];
      if (/^v\d/i.test(part)) return part.toUpperCase();
      if (/^\d/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(" ");
}

function sessionModelIds(
  session: Pick<ResumeSession, "models" | "lastModel">,
): string[] {
  if (session.models && session.models.length > 0) return session.models;
  return session.lastModel ? [session.lastModel] : [];
}

/** True when this session used `modelId` on any turn, including a single swap. */
export function sessionUsesModel(
  session: Pick<ResumeSession, "models" | "lastModel">,
  modelId: string,
): boolean {
  if (!modelId) return true;
  return sessionModelIds(session).includes(modelId);
}

export function uniqueSessionModels(
  sessions: Array<Pick<ResumeSession, "models" | "lastModel">>,
): { id: string; label: string }[] {
  const ids = new Set<string>();
  for (const session of sessions) {
    for (const id of sessionModelIds(session)) ids.add(id);
  }
  return [...ids]
    .sort((a, b) =>
      formatSessionModelName(a).localeCompare(formatSessionModelName(b)),
    )
    .map((id) => ({ id, label: formatSessionModelName(id) }));
}
