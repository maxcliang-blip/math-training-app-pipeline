# syntax=docker/dockerfile:1.7
#
# Staging image for the math training app.
#
#   docker build -t math-training-app:staging .
#   docker run -d --name math-staging --network math-staging-net \
#     -p 127.0.0.1:18083:80 math-training-app:staging
#
# Three stages, and the split between them is the figure contract rather than an optimisation.
#
#   figures  owns the Asymptote toolchain, compiles every figure to sanitized SVG, and writes
#            artifacts/figures/manifest.json
#   build    owns node_modules, the web bundle, and the API test suite
#   runtime  serves both, and has no compiler installed at all
#
# The runtime stage deliberately has no asymptote, no ghostscript, and no dvisvgm, and there is no
# /api/asymptote/compile route. Figures are compiled here, at build time, once; a build that
# cannot compile fails the image rather than becoming a request-time problem for every learner.

# ---------------------------------------------------------------------------
# figures — compile the figure corpus, fail the build if it does not pass
# ---------------------------------------------------------------------------
FROM node:20.11.0-bookworm-slim AS figures

# texlive is a dependency of asymptote itself; ghostscript backs its EPS output and dvisvgm is
# what asy invokes to turn that output into SVG. build-figures.mjs probes for all three and
# refuses to write a manifest that does not have them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends asymptote ghostscript dvisvgm \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# build-figures.mjs needs the content tree and its two repository modules, and nothing else: it
# imports node builtins only otherwise, so this stage installs no npm dependencies at all.
#
# The module list is an allowlist, so it has to name every repository module the figure build
# reaches. It did not name scripts/lib/require-path-arg.mjs, and the omission was not silent: the
# image build died at `RUN node scripts/build-figures.mjs` with ERR_MODULE_NOT_FOUND, in the stage
# that has no other way to fail (MAX-130). Copying `scripts/lib/` instead of naming files would
# drag asy-container.sh into a stage that runs none of it, and would go stale the same way.
COPY lib/figure-contract.mjs lib/figure-contract.mjs
COPY scripts/lib/require-path-arg.mjs scripts/lib/require-path-arg.mjs
COPY scripts/build-figures.mjs scripts/build-figures.mjs
COPY content/ content/

# Exit 1 is a contract violation and must stop the build. Exit 3 (validated but not compiled)
# is also fatal here, because a runtime that cannot compile has nothing to serve.
RUN node scripts/build-figures.mjs

# ---------------------------------------------------------------------------
# build — install, test, and bundle
# ---------------------------------------------------------------------------
FROM node:20.11.0-bookworm-slim AS build

WORKDIR /repo

# Manifests first, so this layer is cached until a dependency actually changes.
COPY package.json package-lock.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
RUN npm ci

COPY lib/ lib/
COPY api/ api/
COPY web/ web/
# scripts/ because api/test/figures.test.js imports scripts/build-figures.mjs to exercise
# measureBox, classifyDrift and recordAspectRatios. Without this layer the suite fails with
# ERR_MODULE_NOT_FOUND inside the image, which is why this image could not be rebuilt from main at
# all: the build died at `npm test` before it ever reached the runtime stage.
COPY scripts/ scripts/
# deploy/ for the same reason: api/test/supervise.test.js imports deploy/supervise.mjs, and the
# test has to run against the file the container actually executes.
COPY deploy/ deploy/
# The suite asserts against the real corpus, so the corpus has to be in this stage. A build that
# ran the tests against an empty content/ would pass 25 assertions by accident.
COPY content/ content/

# The backend suite is the gate that keeps the three content-route rules true; it is fast enough
# to run on every image build.
RUN npm test --workspace api \
 && npm run build --workspace web

# ---------------------------------------------------------------------------
# runtime — serve the bundle and the API, with no toolchain
# ---------------------------------------------------------------------------
FROM node:20.11.0-bookworm-slim AS runtime

# nginx only. asymptote, ghostscript, and dvisvgm are deliberately absent: if a request ever
# reaches for a compiler, the answer has to be that this image does not have one.
RUN apt-get update \
 && apt-get install -y --no-install-recommends nginx \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/nginx/sites-enabled/default \
 && mkdir -p /opt/mta/.data \
 && chown -R node:node /opt/mta/.data

WORKDIR /opt/mta

# Provenance. A staging image that cannot say which commit it was built from cannot be checked
# against main, and an image that cannot be checked against main drifts silently: the container
# keeps serving whatever corpus it was baked with while main moves on. These two labels are what
# scripts/verify-staging-source.sh asserts, so a wrong build source fails a check instead of
# looking healthy on localhost.
ARG BUILD_REPO=https://github.com/maxcliang-blip/math-training-app-pipeline.git
ARG BUILD_COMMIT=unknown
LABEL org.opencontainers.image.source="${BUILD_REPO}" \
      org.opencontainers.image.revision="${BUILD_COMMIT}"

COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/package.json ./package.json
COPY --from=build --chown=node:node /repo/api ./api
COPY --from=build --chown=node:node /repo/lib ./lib
COPY --from=build --chown=node:node /repo/web/dist ./web/dist
COPY --from=build --chown=node:node /repo/web/index.html ./web/index.html

# The figure artifacts are the only thing the figures stage produced.
COPY --from=figures --chown=node:node /repo/artifacts/figures ./artifacts/figures
COPY --from=figures --chown=node:node /repo/content ./content

COPY --chown=node:node deploy/nginx-staging.conf /etc/nginx/conf.d/default.conf
COPY --chown=node:node deploy/entrypoint-staging.sh /usr/local/bin/entrypoint-staging.sh
# supervise.mjs is what keeps the API alive, so it has to be in the image. It lives in the repo
# (and in api/test/supervise.test.js) rather than being written inline here, because the test that
# proves the respawn path runs against the same file the container runs.
COPY --chown=node:node deploy/supervise.mjs /opt/mta/deploy/supervise.mjs
RUN chmod +x /usr/local/bin/entrypoint-staging.sh /opt/mta/deploy/supervise.mjs

ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT=3001 \
    CONTENT_ROOT=/opt/mta/content \
    FIGURE_MANIFEST=/opt/mta/artifacts/figures/manifest.json \
    DATA_DIR=/opt/mta/.data

EXPOSE 80

# Probed through nginx, not straight at the API's own port. Hitting 127.0.0.1:3001 said nothing
# about the only path a learner takes: if nginx wedges, or the proxy stops reaching the API, this
# goes unhealthy instead of reporting a container that is Up and serving 502s. During a respawn the
# API is unreachable for well under one check interval, so a single miss is not enough to flip the
# status — three consecutive failures are.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint-staging.sh"]
CMD ["nginx", "-g", "daemon off;"]