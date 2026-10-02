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

# build-figures.mjs needs the content tree and the shared contract module, and nothing else: it
# imports node builtins only, so this stage installs no npm dependencies at all.
COPY lib/figure-contract.mjs lib/figure-contract.mjs
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
RUN chmod +x /usr/local/bin/entrypoint-staging.sh

ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT=3001 \
    CONTENT_ROOT=/opt/mta/content \
    FIGURE_MANIFEST=/opt/mta/artifacts/figures/manifest.json \
    DATA_DIR=/opt/mta/.data

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint-staging.sh"]
CMD ["nginx", "-g", "daemon off;"]