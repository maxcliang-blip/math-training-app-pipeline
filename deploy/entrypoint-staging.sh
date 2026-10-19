#!/bin/sh
# Single-origin staging shape: nginx serves the built web app and proxies /api and /artifacts to
# the Node process, so the browser never makes a cross-origin request and the app needs no runtime
# API base URL.
#
# This script does not start anything itself and never execs "$@". Handing the container's process
# slot to nginx is what used to strand the API: the API ran as a background child of this shell,
# `exec "$@"` then replaced the shell with nginx, the shell's `trap` died with the shell, and the
# API was unsupervised for the rest of the container's life. Any API death after that point 502'd
# every /api call with nothing watching, while `docker ps` reported Up the whole time.
#
# So supervision lives in supervise.mjs, which stays alive as PID 1's child and owns both
# processes. It still keeps the boot-time failure signal: if the API cannot answer /api/health
# before nginx starts, the container exits non-zero rather than serving a site whose every /api
# call fails.
set -e

export NODE_ENV=production
export HOST=127.0.0.1
export PORT=3001
export CONTENT_ROOT=/opt/mta/content
export FIGURE_MANIFEST=/opt/mta/artifacts/figures/manifest.json
export DATA_DIR=/opt/mta/.data

exec node /opt/mta/deploy/supervise.mjs "$@"
