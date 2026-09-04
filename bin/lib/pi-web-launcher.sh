#!/usr/bin/env bash
# Shared launcher helpers for pi-web's bin/pi and bin/claude-web wrappers.
# Sourced by both; LAUNCHER_NAME must be set by the caller for messages.
set -euo pipefail

# Resolve the real launcher location before finding the project root. Homebrew
# exposes these scripts through symlinks, and BASH_SOURCE otherwise points at
# the symlink instead of the pi-web checkout.
resolve_pi_web_root() {
  local launcher_path="${BASH_SOURCE[1]}"
  while [[ -L "$launcher_path" ]]; do
    local launcher_dir
    launcher_dir="$(cd -P "$(dirname "$launcher_path")" && pwd)"
    local link_target
    link_target="$(readlink "$launcher_path")"
    if [[ "$link_target" == /* ]]; then
      launcher_path="$link_target"
    else
      launcher_path="$launcher_dir/$link_target"
    fi
  done
  PI_WEB_ROOT="$(cd -P "$(dirname "$launcher_path")/.." && pwd)"
  PORT="${PI_WEB_PORT:-4319}"
  HOST="${PI_WEB_HOST:-127.0.0.1}"
  # One place for the server log path; overridable per invocation.
  PI_WEB_LOG="${PI_WEB_LOG:-${TMPDIR:-/tmp}/pi-web.log}"
}

health_json() {
  curl -sf --connect-timeout 0.3 --max-time 0.75 "http://$HOST:$PORT/api/health" 2>/dev/null || true
}

health_ready() {
  curl -sf --connect-timeout 0.2 --max-time 0.4 "http://$HOST:$PORT/api/health" >/dev/null 2>&1
}

clear_unresponsive_project_server() {
  local server_pid server_cwd server_command
  server_pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  [[ -z "$server_pid" ]] && return 0
  server_cwd="$(lsof -a -p "$server_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  server_command="$(ps -p "$server_pid" -o command= 2>/dev/null || true)"
  if [[ "$server_cwd" == "$PI_WEB_ROOT" && "$server_command" == *"server/index.js"* ]]; then
    echo "$LAUNCHER_NAME: recovering an unresponsive local workbench…" >&2
    kill "$server_pid"
    for _ in $(seq 1 20); do
      lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || return 0
      sleep 0.1
    done
    echo "$LAUNCHER_NAME: the previous workbench did not release port $PORT" >&2
    exit 1
  fi
  echo "$LAUNCHER_NAME: port $PORT is in use by another application; set PI_WEB_PORT to use a different port" >&2
  exit 1
}

ensure_build() {
  if [[ ! -f "$PI_WEB_ROOT/package.json" || ! -f "$PI_WEB_ROOT/server/index.js" ]]; then
    echo "$LAUNCHER_NAME: launcher could not find the project at $PI_WEB_ROOT" >&2
    exit 1
  fi
  if [[ ! -d "$PI_WEB_ROOT/dist" ]]; then
    echo "$LAUNCHER_NAME: building web assets (first run)…" >&2
    (cd "$PI_WEB_ROOT" && npm run build) >&2
  fi
}

# A long-running local server may still be serving a previous checkout build.
# Replace only a process that identifies itself as pi-web through /api/health.
refresh_stale_server() {
  local local_build_id health_json running_build_id stale_pid
  local_build_id="$(shasum -a 256 "$PI_WEB_ROOT/dist/index.html" | awk '{print substr($1, 1, 12)}')"
  health_json="$(health_json)"
  running_build_id="$(printf '%s' "$health_json" | sed -n 's/.*"buildId":"\([^"]*\)".*/\1/p')"
  if [[ -n "$health_json" && "$running_build_id" != "$local_build_id" ]]; then
    stale_pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$stale_pid" ]]; then
      echo "$LAUNCHER_NAME: refreshing the running workbench…" >&2
      kill "$stale_pid"
      for _ in $(seq 1 30); do
        health_ready || break
        sleep 0.1
      done
    fi
  fi
}

start_server() {
  if ! health_ready; then
    clear_unresponsive_project_server
    nohup node "$PI_WEB_ROOT/server/index.js" </dev/null >"$PI_WEB_LOG" 2>&1 &
    for _ in $(seq 1 30); do
      health_ready && break
      sleep 0.1
    done
    if ! health_ready; then
      echo "$LAUNCHER_NAME: server failed to start; see $PI_WEB_LOG" >&2
      exit 1
    fi
  fi
}

open_workbench() {
  local query="$1"
  local launch_cwd encoded_cwd
  launch_cwd="$(pwd -P)"
  encoded_cwd="$(node -p 'encodeURIComponent(process.argv[1])' "$launch_cwd")"
  open "http://$HOST:$PORT/?$query&cwd=$encoded_cwd&fresh=$(date +%s)"
}
