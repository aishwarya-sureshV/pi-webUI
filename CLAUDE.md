## Development workflow

- Typecheck: `npm run typecheck` (tsc --noEmit)
- Build: `npm run build`
- Development server: `npm run dev` (runs server + vite concurrently)
- Check ports before starting another server.
- Prefer reusing an existing healthy development server.
- Main conversation UI: `src/components/Conversation.tsx`
- Conversation styling: `src/styles/conversation.css`

## Ports

- API server: `4319` (`PI_WEB_PORT`), vite dev server: `5319` (proxies `/api` → 4319).
- Health check: `curl -sf http://127.0.0.1:4319/api/health`.

## Debugging protocol — triage before you open anything

Pick a lane in one sentence, say which lane you picked, then stay in it. Opening
files to decide is the thing this protocol exists to prevent.

| The question is… | Do this | Not this |
| --- | --- | --- |
| "How does X work?" / what talks to what | `graphify query "<question>"` — the graph in `graphify-out/` already holds file relationships | grepping the tree to rebuild architecture from scratch |
| "X is broken", never worked / unknown history | `/localize` — tree + grep hits in **one** call, commit to ≤3 files and named symbols, then read only those ranges | reading `Conversation.tsx`, then `store.tsx`, then `timeline.ts` "to look around" |
| "X used to work" (regression) | `/bisect` — write a failing predicate, `git bisect run`, read the returned diff | reading code to guess what changed |

Rules that hold in every lane:

- **Form the hypothesis before the first Read.** Name the file *and* the symbol
  *and* the mechanism. A candidate you can't name a mechanism for isn't one.
- This repo is ~48 tracked files. The full tree plus every grep hit fits in a
  single tool result — so localization costs one bash call, and there is never a
  reason to discover the file list incrementally.
- **Delta debugging returns a commit, not 45k of context.** If it's a regression,
  bisect wins even when reading "feels faster".
- Keep commits small and self-contained. Bisect resolution is only as precise as
  the commit it lands on.

## Knowledge graph

`graphify-out/` holds a persistent graph of this repo — 543 nodes, 1081 edges,
18 communities, built from AST extraction of all 40 source files plus the docs.
Gitignored; rebuild with `graphify . --update`. Query it instead of re-deriving
structure by grep:

```bash
graphify path "PiAgentProcess" "Conversation()"
```

```bash
graphify explain "Timeline"
```

```bash
graphify query "how does a pi agent event reach the Conversation UI" --budget 1500
```

Which of the three to reach for:

- **`path`** is the sharpest — it answers "how does A reach B" in one line, and it
  crosses the backend/frontend seam that grep can't follow. `PiAgentProcess →
  pi-agent.js → pi --mode rpc → SSE fan-out → api.ts → Conversation.tsx` is six
  hops of real wiring for one call.
- **`explain <symbol>`** gives a node's full edge list with `file:line` for each —
  the cheapest way to find every caller and reference of a symbol.
- **`query`** is BFS and goes broad; the default budget truncates hard on this
  graph (108 nodes found, ~29 shown). Raise `--budget` or prefer `path`/`explain`
  when you already know the endpoints.

God nodes (the core abstractions, by edge count): `ClaudeAgentProcess` (36),
`PiAgentProcess` (36), `Timeline` (21), `route()` (16), `Conversation()` (16),
`highlightCode()` (13), `StoreProvider()`/`useStore()` (9). No import cycles.
