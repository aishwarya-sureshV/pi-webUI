# pi-web workbench

A DeepSeek-harness-style **web UI for local coding agents**. Typing `pi` in a
terminal opens the pi-backed workbench, while `claude-web` opens the same
workbench backed by Claude Code. The classic pi terminal TUI is one flag away.

- **Backend** (`server/`) spawns one agent process per conversation: either
  `pi --mode rpc` or Claude Code's long-lived stream-json mode. Both adapters
  fan events out to the browser over the same Server-Sent Events stream. Session
  history is discovered independently from `~/.pi/agent/sessions` and
  `~/.claude/projects`.
- **Frontend** (`src/`) is React + Vite and mirrors deepseek-harness's shell:
  responsive three-column layout (collapsible sidebar | conversation | details), its light/dark design tokens
  (`design-platform.css`), hero empty state with glow, and the docked composer card
  (content width + 32px). Message rendering is ported from AgentDeck's
  `AgentWorkbench`: collapsed tool cards for reads/shell, expanded diff cards for
  `edit`/`write` with +/− stats and a full-file viewer, reasoning-summary rows,
  a thinking loader and the thin animated activity line. Each conversation also
  has a **Backend log** tab that records the full live event stream, including
  command requests/responses, RPC events, tool activity, status changes, stderr,
  and raw expandable JSON payloads.

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

The optional `backend` URL query parameter selects the agent for new sessions:
`backend=claude` selects Claude Code, while an absent or unknown value defaults
to `pi` for compatibility with existing links and bookmarks. Claude Code is
spawned without API-key environment variables so it uses the user's existing
Claude.ai subscription login.

## Develop

```bash
npm run dev        # vite (5319, proxies /api) + server (4319)
npm run build      # production bundle in dist/
npm run preview    # serve the built app via the API server
npm run typecheck
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
does not replace or modify the real `claude` executable.
