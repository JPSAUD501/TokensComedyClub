#!/bin/sh
set -eu

bun run build:web
bun run preview:web &
WEB_PID="$!"

cleanup() {
  if kill -0 "$WEB_PID" 2>/dev/null; then
    kill "$WEB_PID" 2>/dev/null || true
    wait "$WEB_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

bun run start:stream
