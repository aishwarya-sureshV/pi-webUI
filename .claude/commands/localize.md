---
description: Use when a bug's location is unknown — "X is broken", "why does Y not work", an error message, a stack trace, unexpected UI behavior — and history is not the clue. Localizes in ONE grep pass (tree + hit list in a single call), commits to named candidate files and symbols, then reads only those ranges. Do NOT use for regressions (something that used to work) — use bisect for those.
argument-hint: <symptom, error text, or "X does not work">
allowed-tools: Bash, Read, Grep
---

# /localize — one-shot localization, by hand

Symptom: **$ARGUMENTS**

This is Agentless phase 1. pi-web is ~48 tracked files; the entire file tree plus
every grep hit fits in one tool result. Localization here should cost **one bash
call and one commitment**, not an exploration session.

The failure mode this command exists to prevent: opening `Conversation.tsx`
"to look around", then `store.tsx`, then `timeline.ts`, and burning 40k of
context before forming a hypothesis. Do not open anything before Step 2.

## Step 0 — extract keywords (no tools)

From the symptom, write down 3–6 literal strings that would appear in the code:
error text, a visible UI label, a prop or field name, a CSS class, an event name,
an API route. Prefer strings the code must literally contain over concepts.
If the symptom is a stack trace, the frame filenames are keywords too.

## Step 1 — ONE bash call

Emit the tree and every keyword's hit list in a single call. Substitute your
keywords for `KW1|KW2|KW3`:

```bash
\
echo "=== TREE ===" && git ls-files && \
echo "=== HITS (files only) ===" && \
git grep -lEi 'KW1|KW2|KW3' -- src server bin && \
echo "=== HITS (per keyword, counted) ===" && \
for k in KW1 KW2 KW3; do printf '%s: ' "$k"; git grep -lci "$k" -- src server bin | tr '\n' ' '; echo; done && \
echo "=== EXPORTED SYMBOLS in hit files ===" && \
git grep -nE '^(export |function |const [A-Za-z]+ = \(|async function )' -- $(git grep -lEi 'KW1|KW2|KW3' -- src server bin)
```

If a keyword returns zero files, it was a concept, not a string — replace it and
rerun. Rerunning Step 1 is cheap. Reading files to compensate for a bad keyword
is not.

## Step 2 — commit, in writing, before reading anything

State in your response, as a list:

- **≤3 candidate files**, ranked.
- **The named symbol in each** (function, component, handler, reducer case).
- **One sentence of mechanism per candidate**: why *this* symbol would produce
  *this* symptom.

If you cannot name a mechanism for a file, it is not a candidate — cut it.
If nothing survives, go back to Step 1 with better keywords. Do not "read a bit
to see." A candidate list of five files means Step 0 was skipped.

## Step 3 — read only the committed ranges

For each surviving candidate, get line numbers first, then read the window:

```bash
git grep -n 'symbolName' -- src server        # find the line
sed -n '120,190p' src/components/Foo.tsx      # read only that range
```

Budget: **±40 lines** around each named symbol. Widen only when the read shows
the symptom is genuinely elsewhere, and say so when you widen.

Read a whole file only when a 4th targeted range in that same file is needed —
at that point the file is the unit and slicing it costs more than reading it.

## Step 4 — fix or re-localize

If the read confirms a mechanism, fix it. If it refutes all candidates, say so
explicitly, then return to Step 1 with keywords learned from what you just read.
An honest second pass is cheaper than drifting into a file-by-file crawl.

## When NOT to use this

- **It used to work and now it doesn't** → `/bisect`. Delta debugging returns a
  commit, not 45k of context.
- **"How does X work?" / architecture questions** → query the graph
  (`graphify query "..."`), which already knows the file relationships.

`/localize` is for a defect whose location is unknown and whose history is not.
