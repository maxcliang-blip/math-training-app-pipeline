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
  -p 127.0.0.1:18083:80 \
  math-training-app:staging
sh scripts/verify-staging-source.sh
node scripts/verify-staging.mjs http://127.0.0.1:18083
```

`BUILD_COMMIT` is not decoration. The image carries it as
`org.opencontainers.image.revision`, and `verify-staging-source.sh` compares it against
`origin/main`, so a staging container built from the wrong tree or a stale commit fails a check
instead of serving a corpus that exists on no branch. Build without it and the check reports the
image as unprovenanced, which is a failure.

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

The 27 lessons in `content/lessons`, ids `mN-lN`, plus 474 exercises. That is the corpus
the backend under review reads and the corpus the figure build compiles, so it is the one
staging serves. Staging previously served a different 10-lesson corpus (`m1-linear-equations`,
`m3-permutations-combinations`, `m7-bayes-theorem`) from a different repository, which is
why a reviewer hitting staging was not looking at the code under review.

One consequence to keep in view: the corpus files are being renumbered by
[ MAX-35](/MAX/issues/MAX-35), which files the counting lessons under M3 to match the
module catalogue. A redeploy before that lands serves the old numbering, and a redeploy
after it serves the corrected one. Neither is a defect; the image is simply a build of
whatever `main` held when it was built.

## Why there is no /api/asymptote/compile

Figures are compiled at build time, in the `figures` stage, and the runtime image has no
compiler installed. A runtime compiler is a different project with a different security and
latency profile, and `FIGURE_REFERENCE_FIELDS` is exactly `["figureKey"]` so that a lesson
list carries addresses rather than kilobytes of Asymptote per figure.

`GET /api/figures` fails closed: a manifest that did not pass the build is a 503 naming the
build, never an empty catalogue. If staging ever answers 503 there, the figure build is what
to read, not the API.

## What to check after a deploy

`scripts/verify-staging.mjs <baseUrl>` is the acceptance check. It asserts against the live
service that the compile route is gone, that a free-response exercise withholds both its key
and its worked solution, and that no lesson or exercise response carries `asymptoteSource`,
`asymptoteAlt`, or `asymptoteAspectRatio`. It also asserts the things that must *not* break:
multiple choice still ships its key, and the figure route serves exactly the eight contract
fields.

```bash
curl -s http://127.0.0.1:18083/api/health
# {"figures":{"usable":true,"status":"pass","count":61,...}}
```

`figures.usable: false` means the build step did not run. The image build fails on a figure
build that does not pass, so `usable: false` in a running staging means the manifest in the
image is not the one this Dockerfile produces.