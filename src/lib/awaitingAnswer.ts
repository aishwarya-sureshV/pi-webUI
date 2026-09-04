import type { TimelineItem } from "./timeline.ts";

/**
 * "This session is waiting on you."
 *
 * CLARIFY_PROMPT tells the agent to ask up to three numbered questions and
 * stop, so a settled turn whose last word is a question is not a finished
 * task — it is a turn parked on an answer. Without a marker for it, a session
 * left in that state is indistinguishable from one that crashed or was
 * interrupted, which is exactly how it reads when you come back to it.
 */
export function textAwaitsAnswer(text: string | undefined): boolean {
  const body = (text ?? "").trim();
  if (!body) return false;
  // Trailing markdown (emphasis, a stray quote marker) must not hide the "?".
  if (body.replace(/[*_`>\s]+$/g, "").endsWith("?")) return true;
  // A numbered list of questions with a closing line after it — the shape
  // CLARIFY_PROMPT asks for — still counts even when the message signs off.
  const numberedQuestions = body
    .split("\n")
    .filter((line) => /^\s*\d+[.)]\s/.test(line) && line.includes("?"));
  return numberedQuestions.length >= 2;
}

export function isAwaitingAnswer(
  items: readonly TimelineItem[],
  working: boolean,
): boolean {
  if (working) return false;
  // Notices (mode switches, errors) are chrome, not conversation: a question
  // followed by one still leaves the session waiting.
  const last = [...items]
    .reverse()
    .find(
      (item) =>
        item.kind === "user" ||
        item.kind === "assistant" ||
        item.kind === "tool",
    );
  if (!last || last.kind !== "assistant") return false;
  return textAwaitsAnswer(last.text);
}
