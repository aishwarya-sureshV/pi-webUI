/**
 * Structured clarifying questions.
 *
 * CLARIFY_PROMPT tells every backend to ask its questions inside an ```ask
 * fence holding JSON, so the UI can render pickable options instead of asking
 * the user to type an answer to a question the model already enumerated. The
 * fence is the whole protocol: no tool channel, which matters because pi
 * (RPC), claude (SDK) and grok (ACP) have three different ones.
 */

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}

/** A fenced ```ask block anywhere in the message. */
const ASK_FENCE = /(^|\n)[ ]{0,3}(?:`{3,}|~{3,})[ \t]*ask[ \t]*(\n|$)/;

export function hasAskBlock(text: string | undefined): boolean {
  return ASK_FENCE.test(text ?? "");
}

/** Body of the first complete ```ask fence, or null if none has closed yet. */
export function firstAskPayload(text: string | undefined): string | null {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^( {0,3})(`{3,}|~{3,})[ \t]*ask[ \t]*$/.exec(lines[i] ?? "");
    if (!open) continue;
    const marker = open[2] ?? "```";
    const char = marker[0];
    for (let j = i + 1; j < lines.length; j++) {
      const close = /^( {0,3})(`{3,}|~{3,})\s*$/.exec(lines[j] ?? "");
      if (
        close &&
        (close[2] ?? "")[0] === char &&
        (close[2] ?? "").length >= marker.length
      ) {
        return lines.slice(i + 1, j).join("\n");
      }
    }
    return null;
  }
  return null;
}

/** Parsed questions from the first complete ask fence; later duplicates ignored. */
export function firstAsk(text: string | undefined): AskQuestion[] | null {
  const payload = firstAskPayload(text);
  return payload == null ? null : parseAsk(payload);
}

/**
 * Parse an ask block's payload. Returns null for anything malformed — a
 * half-streamed fence, or a model that wrote prose in it — so callers fall
 * back to rendering the raw block rather than showing a broken card.
 */
export function parseAsk(raw: string): AskQuestion[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list)) return null;

  const questions: AskQuestion[] = [];
  for (const entry of list) {
    const row = entry as Partial<AskQuestion> | null;
    const question = typeof row?.question === "string" ? row.question : "";
    const options: AskOption[] = [];
    for (const raw of Array.isArray(row?.options) ? row.options : []) {
      // Models drop to a bare string list about as often as they follow the
      // object shape; both mean the same thing.
      if (typeof raw === "string" && raw) options.push({ label: raw });
      else if (typeof (raw as AskOption)?.label === "string")
        options.push({
          label: (raw as AskOption).label,
          description:
            typeof (raw as AskOption).description === "string"
              ? (raw as AskOption).description
              : undefined,
        });
    }
    if (!question || options.length === 0) continue;
    questions.push({
      question,
      header: typeof row?.header === "string" ? row.header : undefined,
      options,
      multiSelect: row?.multiSelect === true,
    });
  }
  return questions.length > 0 ? questions : null;
}
