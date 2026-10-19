#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
API_PID=""

cleanup() {
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

OPTIONS_API_HOST=127.0.0.1 OPTIONS_API_PORT=4174 python3 "$APP_DIR/api_server.py" &
API_PID=$!
npm --prefix "$APP_DIR" run dev:vite -- "$@"
