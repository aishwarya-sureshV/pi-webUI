# pi-web workbench

A DeepSeek-harness-style **web UI for local coding agents**. Typing `pi` in a
terminal opens the pi-backed workbench, while `claude-web` opens the same
workbench backed by Claude Code. The classic pi terminal TUI is one flag away.

- **Backend** (`server/`) spawns one agent process per conversation: `pi --mode
  rpc`, Claude Code's long-lived stream-json mode, or grok's ACP `agent stdio`.
  All three adapters fan events out to the browser over the same Server-Sent
  Events stream. Session history is discovered independently from
  `~/.pi/agent/sessions`, `~/.claude/projects`, and `~/.grok/sessions`.
- **Frontend** (`src/`) is React + Vite and mirrors deepseek-harness's shell:
  responsive three-column layout (collapsible sidebar | conversation | details),
  its light/dark design tokens (`theme.css`/`app.css`), hero empty state with
  glow, and the docked composer card (content width + 32px). Message rendering
  is ported from AgentDeck's `AgentWorkbench`: collapsed tool cards for
  reads/shell, expanded diff cards for `edit`/`write` with +/− stats and a
  full-file viewer, reasoning-summary rows, a thinking loader and the thin
  animated activity line. Each conversation also has a **Backend log** tab that
  records the full live event stream, including command requests/responses, RPC
  events, tool activity, status changes, stderr, and raw expandable JSON
  payloads.

## Use

```bash
pi            # open the web workbench (starts the local server if needed)
claude-web    # open the web workbench, backed by Claude Code
pi --tui      # classic terminal TUI
pi --help/-p/--mode/...   # anything CLI-shaped passes straight through
```

Environment:

- `PI_WEB_PORT` (default `4319`), `PI_WEB_HOST` (default `127.0.0.1`)
- `PI_WEB_PI_BIN` — path/name of the pi binary to spawn (default `pi`)
- `PI_WEB_CLAUDE_BIN` — path/name of the Claude Code binary to spawn (default `claude`)
- `PI_WEB_TOKEN` — optional bearer token. When set, every API call, the SSE
  stream, and the terminal WebSocket require it. The UI shows a lock screen;
  entering the token exchanges it for an HttpOnly cookie (same-origin) and a
  one-time ticket (cross-origin EventSource/WebSocket), so the token never
  appears in a URL or a log line.
- `PI_WEB_UI_ORIGIN` — exact origin of a hosted UI (e.g. a Cloudflare Pages
  deployment) that may talk to the local API. Only this exact origin and
  localhost are trusted; public signup namespaces like `*.pages.dev` are never
  accepted by suffix match.
- `PI_WEB_WORKSPACE_ROOTS` — colon-separated extra directories the file
  explorer may read and edit, beyond the launch directory and open session
  cwds. Mutations (write/rename/delete/copy/move) and the git endpoint are
  confined to these roots; read-only browsing is confined to the user's home.
- `PI_WEB_LOG` — where the launcher writes the server log (default
  `${TMPDIR:-/tmp}/pi-web.log`).

The optional `backend` URL query parameter selects the agent for new sessions:
`backend=claude` selects Claude Code, `backend=grok` selects grok, while an
absent or unknown value defaults to `pi` for compatibility with existing links
and bookmarks. Claude Code is spawned without API-key environment variables so
it uses the user's existing Claude.ai subscription login. Ollama models are
auto-discovered from the local daemon and synced to `~/.pi/agent/models.json`.
The `api` query parameter overrides the API origin, but only local origins
(`localhost`/`127.0.0.1`/`[::1]`) are accepted.

## Security model

- The server binds `127.0.0.1` and validates the `Origin` header on every
  request **and** the terminal WebSocket upgrade against an exact-host
  allowlist (localhost + `PI_WEB_UI_ORIGIN`). WebSockets are not subject to
  CORS, so the server checks Origin itself.
- Workspace file mutations and the git endpoint are confined to the workspace
  roots (launch directory + open session cwds + `PI_WEB_WORKSPACE_ROOTS`),
  mirroring the realpath + root-containment discipline of `sessions.js`.
- Process lifetime is owned by a server-side lease: the page heartbeats its
  open conversations and the server reaps agents whose page went away. A page
  refresh never stops the agent — the new page adopts the live process.

## Develop

```bash
npm run dev        # vite (5319, proxies /api) + server (4319)
npm run build      # production bundle in dist/
npm run preview    # serve the built app via the API server
npm run typecheck
npm test           # node:test — server confinement + frontend helpers
npm run check:grok # verify the grok ACP adapter against the installed CLI
```

The server also serves `dist/` in production, so after `npm run build` the `pi`
launcher needs no dev server.

## How it was wired

`/opt/homebrew/bin/pi` is a symlink to `pi-web/bin/pi` (a thin wrapper). To
restore the stock terminal-only behavior:

```bash
ln -sfn ../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js /opt/homebrew/bin/pi
```

`~/.local/bin/claude-web` is a separate symlink to `pi-web/bin/claude-web`; it
does not replace or modify the real `claude` executable. Both launchers share
`bin/lib/pi-web-launcher.sh`.
