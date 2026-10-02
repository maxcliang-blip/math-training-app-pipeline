#!/bin/sh
# Single-origin staging shape: nginx serves the built web app and proxies /api and /artifacts to
# the Node process, so the browser never makes a cross-origin request and the app needs no runtime
# API base URL.
#
# The API boots first and has to answer /api/health before nginx starts. A container that serves a
# site whose every /api call 502s is worse than a container that refuses to start, because "the
# page loads" reads as success.
set -e

export NODE_ENV=production
export HOST=127.0.0.1
export PORT=3001
export CONTENT_ROOT=/opt/mta/content
export FIGURE_MANIFEST=/opt/mta/artifacts/figures/manifest.json
export DATA_DIR=/opt/mta/.data

node /opt/mta/api/src/index.js &
API_PID=$!

# Fail fast and loudly if the API dies at boot, rather than serving a site whose every /api call
# 502s.
sleep 2
if ! kill -0 "$API_PID" 2>/dev/null; then
  echo "math-training API failed to start" >&2
  exit 1
fi

# nginx runs in the foreground as PID 1's child; the API dies with it.
trap 'kill "$API_PID" 2>/dev/null || true' EXIT INT TERM

exec "$@"