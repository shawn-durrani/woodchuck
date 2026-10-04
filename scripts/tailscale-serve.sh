#!/usr/bin/env bash
# scripts/tailscale-serve.sh: tailnet-only remote access for Woodchuck.
#
# Serves the app on 127.0.0.1 (port 8905 by default) on its own HTTPS port
# on your own tailnet, through `tailscale serve`. It never runs Funnel, which
# would put the app on the public internet, and it refuses to set anything
# up while Funnel is on. The app stays on 127.0.0.1 throughout: the tailnet
# is a private path to it, and the owner lock stands behind that.
#
# start.sh runs this when WOODCHUCK_TAILSCALE_SERVE=1, and its failure never
# stops the app. It's safe to run again any time, since `tailscale serve`
# just reaffirms the route. With no Tailscale, or Tailscale signed out, it
# says so and skips.
#
# Usage:
#   scripts/tailscale-serve.sh           # set up (or reaffirm) the route
#   scripts/tailscale-serve.sh --status  # report the route; changes nothing
set -uo pipefail
cd "$(dirname "$0")/.."

# A setting from the environment, else from .env beside the app, without
# loading the rest of .env. start.sh reads its own the same way.
setting() {
  local value="${!1:-}"
  if [ -z "$value" ] && [ -f .env ]; then
    value="$(sed -n "s/^[[:space:]]*$1=//p" .env | tail -n 1)"
    value="${value%\"}" && value="${value#\"}"
  fi
  printf '%s' "$value"
}

WOODCHUCK_PORT="$(setting WOODCHUCK_PORT)"
WOODCHUCK_TAILSCALE_PORT="$(setting WOODCHUCK_TAILSCALE_PORT)"
WOODCHUCK_TAILSCALE_BIN="$(setting WOODCHUCK_TAILSCALE_BIN)"
PORT="${WOODCHUCK_PORT:-8905}"
# Its own HTTPS port, so Woodchuck gets its own origin on the tailnet name
# and every absolute path it uses lands on Woodchuck, never on another app
# served at the root of that name.
TS_PORT="${WOODCHUCK_TAILSCALE_PORT:-8445}"
TARGET="http://127.0.0.1:${PORT}"

warn() { printf '\033[1;33m%s\033[0m\n' "$*" >&2; }
ok()   { printf '%s\n' "$*"; }

# ---- the tailscale command: PATH first, then WOODCHUCK_TAILSCALE_BIN ----
# Never a guessed path. A test that clears PATH must find nothing, and must
# never reach a real install. On a Mac the command sits inside the app, so
# name it with WOODCHUCK_TAILSCALE_BIN.
TS_BIN=""
if command -v tailscale >/dev/null 2>&1; then
  TS_BIN="tailscale"
elif [ -n "$WOODCHUCK_TAILSCALE_BIN" ] && [ -x "$WOODCHUCK_TAILSCALE_BIN" ]; then
  TS_BIN="$WOODCHUCK_TAILSCALE_BIN"
fi

if [ -z "$TS_BIN" ]; then
  warn "Tailscale remote access: SKIPPED. There's no 'tailscale' command on PATH."
  warn "  On a Mac, the command lives inside the Tailscale app. Name it in .env:"
  warn "    WOODCHUCK_TAILSCALE_BIN=/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  warn "  then run scripts/tailscale-serve.sh again."
  warn "  No Tailscale at all? Install it from https://tailscale.com/download first."
  warn "  Woodchuck keeps serving on http://127.0.0.1:${PORT} either way."
  exit 0
fi

# ---- tailscaled running, and this computer on a tailnet ----
if ! "$TS_BIN" status >/dev/null 2>&1; then
  warn "Tailscale remote access: SKIPPED. Tailscale isn't running, or this"
  warn "  computer isn't signed in to a tailnet. Run 'tailscale up', then run"
  warn "  scripts/tailscale-serve.sh again."
  warn "  Woodchuck keeps serving on http://127.0.0.1:${PORT} either way."
  exit 0
fi

# ---- Funnel on anywhere on this device means stop ----
# Reads both the plain readout and the JSON config. It only reads.
public_route() {
  local text json
  text="$("$TS_BIN" serve status 2>&1 || true)"
  printf '%s\n' "$text"
  if printf '%s\n' "$text" | grep -qi "funnel on"; then
    return 0
  fi
  json="$("$TS_BIN" serve status --json 2>/dev/null || true)"
  printf '%s' "$json" | tr -d '\n' | grep -Eq '"AllowFunnel"[[:space:]]*:[[:space:]]*\{[^}]*:[[:space:]]*true'
}

refuse() {
  warn "REFUSING: Funnel appears to be ON for this device. Woodchuck must never be"
  warn "  reachable from the public internet. Turn it off first:"
  warn "    ${TS_BIN} funnel reset"
  warn "  then run scripts/tailscale-serve.sh again."
  exit 1
}

status_only=0
if [ "${1:-}" = "--status" ]; then
  status_only=1
fi

if [ "$status_only" -eq 0 ]; then
  # Checked before the route exists, so the route never joins a Funnel.
  if public_route >/dev/null; then
    refuse
  fi
  ok "Serving on your tailnet only: :${TS_PORT} -> ${TARGET}"
  err_file="$(mktemp)"
  trap 'rm -f "$err_file"' EXIT
  if ! "$TS_BIN" serve --bg --https="$TS_PORT" "$TARGET" 2>"$err_file"; then
    warn "Tailscale remote access: 'tailscale serve' failed. It said:"
    sed 's/^/    /' "$err_file" >&2 2>/dev/null || true
    warn "  Check the syntax for your version with: ${TS_BIN} serve --help"
    warn "  Woodchuck keeps serving on http://127.0.0.1:${PORT} either way."
    exit 0
  fi
fi

# ---- read the live route back, and refuse if Funnel is on ----
if public_route; then
  refuse
fi

# ---- say where to open it, never a secret ----
dns_name="$("$TS_BIN" status --json 2>/dev/null | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  try {
    process.stdout.write(String(JSON.parse(s).Self?.DNSName ?? "").replace(/\.$/, ""));
  } catch {}
});
' 2>/dev/null || true)"

if [ -n "$dns_name" ]; then
  ok "Woodchuck is on your tailnet at: https://${dns_name}:${TS_PORT}/"
  ok "It answers that name only once it's in .env, then restart Woodchuck:"
  ok "  WOODCHUCK_TRUSTED_HOSTS=${dns_name}"
else
  ok "The route is set. Run '${TS_BIN} status' for this computer's tailnet name,"
  ok "then open https://<that name>:${TS_PORT}/ on your phone."
  ok "That name has to be in WOODCHUCK_TRUSTED_HOSTS in .env too."
fi
