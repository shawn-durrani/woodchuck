#!/usr/bin/env bash
# Install (or refresh) the launchd user agent that keeps Woodchuck running on
# macOS. It starts the app at login, restarts it if it ever stops, and brings
# it back after a reboot. The agent runs start.sh from this checkout.
#
# Idempotent: safe to re-run after a `git pull`. It unloads any earlier copy
# of the agent and stops a copy of the app you started by hand, so there's
# only ever one owner of the port.
#
# Usage:  service/install-service.sh        (run from the checkout to serve)
# Undo:   launchctl bootout gui/$(id -u)/dev.woodchuck.server
set -euo pipefail

cd "$(dirname "$0")/.."
APP_DIR="$(pwd -P)"
LABEL="dev.woodchuck.server"
TEMPLATE="service/${LABEL}.plist.template"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"

[ "$(uname -s)" = "Darwin" ] || {
  echo "✗ this installer is for macOS. docs/OPERATIONS.md says how to run Woodchuck elsewhere." >&2
  exit 1
}
[ -f "$TEMPLATE" ] || { echo "✗ template not found: $TEMPLATE" >&2; exit 1; }

# Same port rule as the server: the shell first, then .env, then the default,
# so the step that stops a hand-started copy looks at the port it really holds.
env_setting() {
  [ -f .env ] && sed -n "s/^[[:space:]]*$1=//p" .env | tail -n 1 || true
}
PORT="${WOODCHUCK_PORT:-$(env_setting WOODCHUCK_PORT)}"
PORT="${PORT:-8905}"

# launchd starts agents with a bare PATH. Put the directory of the node this
# shell finds first, wherever it was installed from, so start.sh can run npm.
NODE="$(command -v node 2>/dev/null)" || {
  echo "✗ node isn't on your PATH. Install Node 24 or newer, then run this again." >&2
  exit 1
}
AGENT_PATH="$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$HOME/Library/LaunchAgents" "$APP_DIR/data"
sed -e "s#{{APP_DIR}}#${APP_DIR}#g" \
    -e "s#{{HOME}}#${HOME}#g" \
    -e "s#{{PATH}}#${AGENT_PATH}#g" \
    "$TEMPLATE" > "$DEST"

# The written plist must be valid and fully filled in before launchd sees it.
plutil -lint "$DEST" > /dev/null
if grep -q '{{' "$DEST"; then
  echo "✗ a placeholder was left unfilled in $DEST" >&2
  exit 1
fi

# One owner: drop any earlier agent, then stop a hand-started copy still
# holding the port, before launchd starts the one real copy.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null && echo "→ unloaded the earlier $LABEL" || true
for pid in $(lsof -tnP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
  echo "→ stopping a copy started by hand (pid $pid), so the agent owns port $PORT"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -9 "$pid" 2>/dev/null || true
done
launchctl bootstrap "$DOMAIN" "$DEST"

echo "✓ installed. Woodchuck now starts at login and restarts if it stops."
echo "  logs:    tail -f $APP_DIR/data/service.log"
echo "  restart: launchctl kickstart -k $DOMAIN/$LABEL"
echo "  remove:  launchctl bootout $DOMAIN/$LABEL"

# The first start installs packages and builds the web app, which takes a while.
for _ in $(seq 1 60); do
  if curl -sf --max-time 2 "http://127.0.0.1:$PORT/api/health" > /dev/null; then
    echo "✓ running on http://127.0.0.1:$PORT"
    exit 0
  fi
  sleep 3
done
echo "✗ Woodchuck hasn't answered yet. Check $APP_DIR/data/service.log" >&2
exit 1
