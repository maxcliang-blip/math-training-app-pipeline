# Staging deployment

Staging is the container a reviewer or a learner hits. It is built from `main` of this
repository, and nothing else.

```bash
git switch main && git pull --ff-only
docker build -t math-training-app:staging \
  --build-arg BUILD_COMMIT="$(git rev-parse HEAD)" .
docker rm -f math-staging
docker run -d --name math-staging \
  --network math-staging-net \
  --restart unless-stopped \
  -p 127.0.0.1:18083:80 \
  math-training-app:staging
sh scripts/verify-staging-source.sh
node scripts/verify-staging.mjs http://127.0.0.1:18083
```

`--restart unless-stopped` is not optional. Supervision inside the container handles a single API
death; the restart policy handles the case supervision deliberately hands back — an API that will
not stay up, where the container exits non-zero so Docker can back off instead of hot-looping.

`BUILD_COMMIT` is not decoration. The image carries it as
`org.opencontainers.image.revision`, and `verify-staging-source.sh` compares it against
`origin/main`, so a staging container built from the wrong tree or a stale commit fails a check
instead of serving a corpus that exists on no branch. Build without it and the check reports the
image as unprovenanced, which is a failure.

## Supervision: what keeps the API alive

The container runs two processes — the API and nginx — and one supervisor that owns both.
`deploy/entrypoint-staging.sh` starts nothing itself; it hands off to `deploy/supervise.mjs` with
`exec`, which is safe precisely because the supervisor is what nginx and the API hang off:

| Event | Behaviour |
| --- | --- |
| API never answers `/api/health` at boot | exit 1 — never start nginx against a dead API |
| API dies later | respawn immediately; nginx keeps serving throughout |
| API dies 5 times in 60s | exit non-zero, so `--restart unless-stopped` applies backoff |
| nginx dies | exit with nginx's code, stopping the API with it |
| `SIGTERM` / `SIGINT` | forwarded to both children; waits for them, so `docker stop` is prompt |

The entrypoint previously did `exec "$@"` after backgrounding the API. That replaced the shell with
nginx, so the shell's `trap` died with the shell and the API was unsupervised for the rest of the
container's life. Any later API death 502'd every `/api` call with nothing watching, while
`docker ps` reported `Up` — a container that looks healthy and serves nothing, which no restart
policy can act on because the container never exited.

`HEALTHCHECK` probes `http://127.0.0.1/api/health` **through nginx**, not the API's own port. A
direct probe to `:3001` says nothing about the path a learner takes: it would still read `healthy`
with nginx wedged. During a respawn the API is unreachable for well under one 30s check interval,
and one miss is not enough to flip the status — three consecutive failures are.

### Measured recovery

Killing the API inside a running container with `kill -9`, polling `/api/health` every 20ms:

```
kill -> first HTTP 200  : 980 ms
container state         : running
docker health           : healthy
API pid                 : 17 -> 321
```

Detection is effectively immediate — the supervisor reacts to the child's `exit` event, not to a
poll, and logs `api healthy again after 840ms` where the 840ms is the API's own cold boot (it reads
a 38-lesson, 759-exercise corpus and a 91-figure manifest). The client-visible window is therefore
the API's boot time, not a detection delay. Closing that last ~1s means making the API boot faster,
which is a change to `api/src/index.js`, not to supervision.

### Checking supervision yourself

```sh
# Do not pkill the API from the host: pkill walks the host /proc, so it matches container processes
# too. That is how this was found, and it is a trigger rather than the defect.
docker exec math-staging sh -c 'kill -9 $(for p in /proc/[0-9]*; do tr "\0" " " < $p/cmdline | grep -q "api/src/index.js" && echo ${p#/proc/}; done | head -1)'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18083/api/health   # recovers in ~1s
docker inspect math-staging --format '{{.State.Status}} {{.State.Health.Status}}'
```

`api/test/supervise.test.js` asserts all of it without needing a container: respawn on kill, nginx
surviving repeated API deaths, non-zero exit when the API never comes up, exit when nginx dies,
SIGTERM tearing both children down, and no aborted-readiness leak across the retry loop.

## If plain `docker` says "permission denied ... /var/run/docker.sock"

That is not a missing daemon. The socket is `root:docker` `srw-rw----`, so `docker` works only if
this session has the `docker` supplementary group. Prefix the command:

```bash
sg docker -c 'docker info'
```

An image can therefore be rebuilt from a session whose bare `docker` fails, which is the opposite
of the conclusion that gets drawn. `verify-staging-source.sh` handles both cases on its own.

## Building from a clean export

`git switch main` in a shared checkout is not enough if that checkout has untracked content: the
Dockerfile copies `content/` from the build context, so untracked lessons and exercises are baked
into the image and then served as though they were on `main`. To build exactly what `main` holds:

```bash
rm -rf /tmp/mta-build && mkdir -p /tmp/mta-build
git archive main | tar -x -C /tmp/mta-build
docker build -t math-training-app:staging \
  --build-arg BUILD_COMMIT="$(git rev-parse main)" /tmp/mta-build
```

`verify-staging-source.sh` catches this afterwards by counting lesson and exercise files inside the
image against the same counts in the commit.

`math-staging-tunnel` reaches the container by name over `math-staging-net`, so both the
container name and the network have to survive the recreate. Drop either and the tunnel
goes quiet while the container still looks healthy on localhost.

## Which corpus this serves

The corpus is whatever `content/` holds on `main` when the image is built. Do not write the
counts down: read them back. `scripts/verify-staging-source.sh` counts lessons and exercise
files inside the image and compares them against the same two counts in `origin/main`
(`git ls-tree -r --name-only origin/main -- content/lessons`, and `-- content/exercises`), so
a number written here would be a third thing to keep in sync, and the one that would go stale
silently while the deploy kept passing. The served numbers come from the image:

```bash
curl -s http://127.0.0.1:18083/api/content/warnings
# {"warnings":[],"stats":{"lessons":N,"exercises":M,"modules":K,"warnings":0}}
```

That is the corpus the backend under review reads and the corpus the figure build compiles,
so it is the one staging serves. Staging previously served a different 10-lesson corpus (`m1-linear-equations`,
`m3-permutations-combinations`, `m7-bayes-theorem`) from a different repository, which is
why a reviewer hitting staging was not looking at the code under review.

One consequence to keep in view: a redeploy serves whatever corpus `main` held when the image was
built, so the served numbers move as content lands. That is not a defect, and it is also why
`curl -s http://127.0.0.1:18083/api/content/warnings` is the check to run before believing any
measurement taken against staging: it reports `{"lessons":N,"exercises":M}` straight from the
image.

## Why there is no /api/asymptote/compile

Figures are compiled at build time, in the `figures` stage, and the runtime image has no
compiler installed. A runtime compiler is a different project with a different security and
latency profile, and `FIGURE_REFERENCE_FIELDS` is `["figureKey", "asymptoteAlt"]` so that a
lesson list carries an address and one sentence of description rather than kilobytes of
Asymptote per figure. The description is there because the figure route is the thing that goes
missing: when a build produces no usable manifest it 503s for every key, and the degraded box
still has to say what the figure showed (Rendering Conventions §5.6).

`GET /api/figures` fails closed: a manifest that did not pass the build is a 503 naming the
build, never an empty catalogue. If staging ever answers 503 there, the figure build is what
to read, not the API.

## What to check after a deploy

`scripts/verify-staging.mjs <baseUrl>` is the acceptance check. It asserts against the live
service that the compile route is gone, that a free-response exercise withholds both its key
and its worked solution, and that no lesson or exercise response carries `asymptoteSource` or
`asymptoteAspectRatio`. It also asserts the things that must *not* break:
multiple choice still ships its key, and the figure route serves exactly the eight contract
fields.

```bash
curl -s http://127.0.0.1:18083/api/health
# {"figures":{"usable":true,"status":"pass","count":83,...}}
```

## CI runs the same two checks

`.github/workflows/ci.yml` has a `staging-image` job that builds this image from the commit under
test, runs it, and then runs `scripts/verify-staging-source.sh` and `scripts/verify-staging.mjs`
against it. Every other job in the repository reads a checkout, so nothing else would notice that
the image had become unbuildable or unprovable — which is how an image went months carrying no
`org.opencontainers.image.source`, serving a 31-lesson corpus from a different repository, with
CI green throughout. Keep the deploy procedure and that job in step: a check that only runs by
hand is the check that eventually does not run.

`figures.usable: false` means the build step did not run. The image build fails on a figure
build that does not pass, so `usable: false` in a running staging means the manifest in the
image is not the one this Dockerfile produces.