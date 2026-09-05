import type { TimelineItem } from "./timeline";

export interface ExportMeta {
  title: string;
  backend: string;
  model?: string;
  cwd?: string;
  exportedAt?: Date;
}

/** Fenced blocks in tool output would otherwise break out of their own fence. */
function fence(body: string): string {
  const longest = [...body.matchAll(/`{3,}/g)].reduce(
    (max, match) => Math.max(max, match[0].length),
    2,
  );
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}\n${body}\n${ticks}`;
}

function trim(text: string, limit = 4000): string {
  const clean = text.replace(/\s+$/, "");
  return clean.length > limit
    ? `${clean.slice(0, limit)}\n… (${clean.length - limit} more characters)`
    : clean;
}

/**
 * Render a transcript as Markdown: one heading per turn, tool calls collapsed
 * into details blocks so the prose stays readable, and permission decisions
 * kept because "what did I let it do" is half the value of an exported log.
 */
export function timelineToMarkdown(
  items: TimelineItem[],
  meta: ExportMeta,
): string {
  const when = meta.exportedAt ?? new Date();
  const lines: string[] = [
    `# ${meta.title}`,
    "",
    `- **Agent:** ${meta.backend}${meta.model ? ` (${meta.model})` : ""}`,
    ...(meta.cwd ? [`- **Workspace:** \`${meta.cwd}\``] : []),
    `- **Exported:** ${when.toISOString()}`,
    "",
    "---",
    "",
  ];

  for (const item of items) {
    if (item.kind === "user") {
      lines.push(`## User`, "", trim(item.text), "");
      continue;
    }
    if (item.kind === "assistant") {
      lines.push(`### Assistant`, "", trim(item.text), "");
      continue;
    }
    if (item.kind === "rationale") {
      lines.push(`<details><summary>Reasoning</summary>`, "", trim(item.text), "", `</details>`, "");
      continue;
    }
    if (item.kind === "tool") {
      const args = JSON.stringify(item.args ?? {}, null, 2);
      lines.push(
        `<details><summary>Tool · ${item.name} (${item.status})</summary>`,
        "",
        fence(trim(args, 1500)),
        "",
        ...(item.output ? [fence(trim(item.output))] : []),
        "",
        `</details>`,
        "",
      );
      continue;
    }
    if (item.kind === "notice") {
      lines.push(`> _${item.tone}_: ${trim(item.text, 500)}`, "");
    }
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** Filesystem-safe, dated filename for the exported transcript. */
export function exportFilename(title: string, at = new Date()): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "session";
  const stamp = at.toISOString().slice(0, 10);
  return `${slug}-${stamp}.md`;
}
