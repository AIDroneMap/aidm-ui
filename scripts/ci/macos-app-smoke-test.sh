#!/usr/bin/env bash
# Opens AIDM UI from its disk image the way a pilot does, on a Mac: copies the
# app out of the image and opens it with Finder's "open". Checks that the
# launcher returns, that one server serves the interface on the default port
# and keeps running, and that opening the app again leaves that one server.
#
#   scripts/ci/macos-app-smoke-test.sh <disk image> <version>
#
# It uses the default data folder, so it is for a fresh machine only.
set -euo pipefail

dmg="$1"
version="$2"
# The real path: the launcher starts the server by its real path, and pgrep matches the command line.
work="$(cd "$(mktemp -d)" && pwd -P)"
app="$work/Applications/AIDM UI.app"
server="$app/Contents/MacOS/aidm-ui"
data="$HOME/Library/Application Support/aidm-ui"

fail() {
  echo "::error::$1"
  [ -f "$data/logs/aidm-ui.log" ] && cat "$data/logs/aidm-ui.log"
  exit 1
}
servers() {
  pgrep -f "^$server\$" || true
}
cleanup() {
  for pid in $(servers); do kill "$pid" || true; done
  if [ -d "$work/mnt" ]; then hdiutil detach "$work/mnt" -quiet || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

[ ! -e "$data/aidm-ui.lock" ] || fail "$data already holds a lock: this test needs a fresh machine."

mkdir "$work/mnt" "$work/Applications"
hdiutil attach -nobrowse -readonly -mountpoint "$work/mnt" "$dmg"
ditto "$work/mnt/AIDM UI.app" "$app"
hdiutil detach "$work/mnt"
rmdir "$work/mnt"

open "$app"
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8823/api/health > "$work/health.json" 2> /dev/null; then break; fi
  sleep 1
done
cat "$work/health.json" || fail "Nothing answered on port 8823 within 60 seconds of opening the app."
grep -q '"app":"aidm-ui"' "$work/health.json" || fail "Port 8823 does not answer as aidm-ui."
grep -q "\"version\":\"$version\"" "$work/health.json" || fail "The server is not version $version."
curl -fsS http://127.0.0.1:8823/ | grep -q '<div id="root">' || fail "The interface is not served."

first="$(servers)"
[ "$(echo "$first" | wc -l | tr -d ' ')" = 1 ] && [ -n "$first" ] || fail "Expected one server from the app, found: '$first'."
pgrep -f aidm-ui-launcher > /dev/null && fail "The launcher is still running."
grep -q "\"pid\":$first," "$data/aidm-ui.lock" || fail "The lock does not name the app's server."
grep -q "aidm-ui $version starts" "$data/logs/aidm-ui.log" || fail "The log has no start line."

# Opening the app again starts a copy that attaches to the running one and exits.
open "$app"
sleep 10
second="$(servers)"
[ "$second" = "$first" ] || fail "After a second open, expected only server $first, found: '$second'."
curl -fsS http://127.0.0.1:8823/api/health > /dev/null || fail "The server stopped answering after a second open."

echo "The app started server $first, and a second open kept it as the only one."
echo "macOS $(sw_vers -productVersion), $(uname -m)"
echo "Mac app smoke test passed"
