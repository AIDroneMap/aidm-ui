#!/usr/bin/env bash
# Starts a compiled executable with no arguments and checks that it serves the
# interface and its icons on the default port, and that a second start attaches
# to the running copy and exits.
set -euo pipefail

exe="$1"
work="$(mktemp -d)"
export AIDM_UI_DATA_DIR="$work/data"

"$exe" > "$work/first.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; rm -rf "$work"' EXIT

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8823/api/health > "$work/health.json" 2>/dev/null; then
    break
  fi
  sleep 1
done
cat "$work/health.json"
grep -q '"app":"aidm-ui"' "$work/health.json"
curl -fsS http://127.0.0.1:8823/ > "$work/page.html"
grep -q '<div id="root">' "$work/page.html"
grep -q '<link rel="icon" href="/favicon.svg"' "$work/page.html"
grep -q '<link rel="apple-touch-icon" href="/apple-touch-icon.png"' "$work/page.html"
curl -fsS -o /dev/null -w '%{content_type}\n' http://127.0.0.1:8823/favicon.svg | grep -q '^image/svg+xml'
curl -fsS -o /dev/null -w '%{content_type}\n' http://127.0.0.1:8823/apple-touch-icon.png | grep -q '^image/png'

timeout 15 "$exe" > "$work/second.log" 2>&1
cat "$work/second.log"
grep -q "already running" "$work/second.log"

kill "$pid"
wait "$pid" || true
echo "Smoke test passed"
