# pi-web workbench

A DeepSeek-harness-style **web UI for your local pi coding agent**. Typing `pi`
in a terminal now opens this web workbench in your browser; the classic terminal
TUI is one flag away.

- **Backend** (`server/`) spawns one `pi --mode rpc` process per conversation
  (the same per-session process model AgentDeck uses) and fans its JSONL events
  out to the browser over Server-Sent Events. Session history is discovered from
  `~/.pi/agent/sessions`.
- **Frontend** (`src/`) is React + Vite and mirrors deepseek-harness's shell:
  responsive three-column layout (collapsible sidebar | conversation | details), its light/dark design tokens
  (`design-platform.css`), hero empty state with glow, and the docked composer card
  (content width + 32px). Message rendering is ported from AgentDeck's
  `AgentWorkbench`: collapsed tool cards for reads/shell, expanded diff cards for
  `edit`/`write` with +/− stats and a full-file viewer, reasoning-summary rows,
  a thinking loader and the thin animated activity line.

## Use

```bash
pi            # open the web workbench (starts the local server if needed)
pi --tui      # classic terminal TUI
pi --help/-p/--mode/...   # anything CLI-shaped passes straight through
```

Environment:

- `PI_WEB_PORT` (default `4319`), `PI_WEB_HOST` (default `127.0.0.1`)
- `PI_WEB_PI_BIN` — path/name of the pi binary to spawn (default `pi`)

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
