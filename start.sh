#!/usr/bin/env bash
# Starts Woodchuck from this checkout: installs packages and builds the web
# app when they're missing or stale, then runs the server on port 8905. Run
# it by hand, or let service/install-service.sh hand it to launchd on macOS.
set -euo pipefail
cd "$(dirname "$0")"
umask 077
mkdir -p data

if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  npm ci --no-audit --no-fund
  touch node_modules
fi
# Rebuild the web app when any of its source is newer than the last build.
if [ ! -f packages/web/dist/index.html ] || [ -n "$(find packages/web/src packages/core/src packages/web/index.html -newer packages/web/dist/index.html -print -quit)" ]; then
  npm run build
fi

# A setting from the environment, else from .env, without loading the rest
# of .env into this shell.
setting() {
  local value="${!1:-}"
  if [ -z "$value" ] && [ -f .env ]; then
    value="$(sed -n "s/^[[:space:]]*$1=//p" .env | tail -n 1)"
    value="${value%\"}" && value="${value#\"}"
  fi
  printf '%s' "$value"
}

# Remote access over your tailnet, when you ask for it with
# WOODCHUCK_TAILSCALE_SERVE=1. It never uses Funnel, and its failure never
# stops the app, which keeps serving on 127.0.0.1 either way.
if [ "$(setting WOODCHUCK_TAILSCALE_SERVE)" = "1" ]; then
  bash scripts/tailscale-serve.sh || true
fi

# A clean environment: only what .env provides reaches Claude's API.
exec ./node_modules/.bin/tsx --env-file-if-exists=.env packages/server/src/index.ts
