#!/bin/sh
# Assert that the running staging container was built from main of THIS repository.
#
# verify-staging.mjs checks what staging serves. It cannot tell you where that content came from,
# and that is the failure this script exists for: an image built from a working copy whose origin
# is a different repository keeps serving a corpus that exists on no branch, looks healthy on
# localhost, and is invisible to the content gate, because the gate reads the checkout, not the
# image.
#
# The image carries its build source in two OCI labels, and this script checks those labels against
# the repository it is run from, and independently counts the corpus inside the image against the
# corpus the expected commit holds. The second check does not trust the labels at all, so a stale
# or mislabelled image still fails.
#
# Usage: sh scripts/verify-staging-source.sh [container] [expectedCommit]
#
#   container      default math-staging
#   expectedCommit default origin/main, so the check follows main rather than a local HEAD

set -eu

CONTAINER="${1:-math-staging}"
EXPECTED_COMMIT="${2:-}"
REPO_URL="${BUILD_REPO:-https://github.com/maxcliang-blip/math-training-app-pipeline.git}"

failures=0
check() {
  if [ "$1" = "0" ]; then
    printf 'PASS  %s\n' "$2"
  else
    printf 'FAIL  %s\n' "$2"
    failures=$((failures + 1))
  fi
}

# `docker` needs the supplementary group when the session was started without it: plain `docker`
# fails with "permission denied ... /var/run/docker.sock", which reads exactly like a missing
# daemon.
#
# The arguments cannot be appended to the `sg` command -- this util-linux build drops everything
# after the -c string, so `sg docker -c 'docker "$@"' sh inspect ...` runs `docker` with no
# arguments at all -- and they cannot be interpolated into the string either, because a
# `--format` value contains spaces. One argument per line in a temp file, re-read as positional
# parameters by the child, is exact for every argument that is not itself a newline.
ARGS_FILE=$(mktemp)
export ARGS_FILE
trap 'rm -f "$ARGS_FILE"' EXIT INT TERM

VIA_SG=0
if docker info >/dev/null 2>&1; then
  VIA_SG=0
elif command -v sg >/dev/null 2>&1 && sg docker -c 'docker info' >/dev/null 2>&1; then
  VIA_SG=1
else
  echo "FAIL  docker daemon is unreachable for this user" >&2
  echo "      (plain 'docker' failing here is a supplementary-group artifact, not a missing socket)" >&2
  exit 1
fi

run_docker() {
  if [ "$VIA_SG" -eq 0 ]; then
    docker "$@"
    return
  fi
  : >"$ARGS_FILE"
  for arg in "$@"; do printf '%s\n' "$arg" >>"$ARGS_FILE"; done
  sg docker -c 'set --; while IFS= read -r line; do set -- "$@" "$line"; done <"$ARGS_FILE"; exec docker "$@"' env
}

if ! run_docker inspect "$CONTAINER" --format '{{.State.Status}}' >/dev/null 2>&1; then
  echo "FAIL  container $CONTAINER does not exist" >&2
  exit 1
fi
check 0 "container $CONTAINER exists"

if [ -z "$EXPECTED_COMMIT" ]; then
  EXPECTED_COMMIT=$(git rev-parse origin/main 2>/dev/null || git rev-parse HEAD)
fi

source_repo=$(run_docker inspect "$CONTAINER" --format '{{index .Config.Labels "org.opencontainers.image.source"}}')
source_commit=$(run_docker inspect "$CONTAINER" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')

# An image built before the labels existed reports "<no value>". That is not a pass.
if [ "$source_repo" = "$REPO_URL" ]; then check 0 "image build source is this repository ($source_repo)"; else
  check 1 "image build source is this repository (got ${source_repo:-<no value>}, want $REPO_URL)"; fi

if [ -n "$source_commit" ] && [ "$source_commit" != "unknown" ] && [ "$source_commit" != "<no value>" ]; then
  check 0 "image records the commit it was built from ($source_commit)"
else
  check 1 "image records the commit it was built from (got ${source_commit:-<no value>})"
fi

if [ "$source_commit" = "$EXPECTED_COMMIT" ]; then
  check 0 "image commit is the expected commit ($EXPECTED_COMMIT)"
else
  check 1 "image commit is the expected commit (got ${source_commit:-<none>}, want $EXPECTED_COMMIT)"
fi

# Corpus counted inside the image against the corpus in the commit. Independent of the labels.
image_lessons=$(run_docker exec "$CONTAINER" sh -c 'ls /opt/mta/content/lessons | wc -l' | tr -d '[:space:]')
repo_lessons=$(git ls-tree -r --name-only "$EXPECTED_COMMIT" content/lessons/ | wc -l | tr -d '[:space:]')

if [ -n "$image_lessons" ] && [ "$image_lessons" = "$repo_lessons" ]; then
  check 0 "lesson count in the image matches the repository ($image_lessons)"
else
  check 1 "lesson count in the image matches the repository (image ${image_lessons:-?}, repo ${repo_lessons:-?})"
fi

image_exercises=$(run_docker exec "$CONTAINER" sh -c 'ls /opt/mta/content/exercises | wc -l' | tr -d '[:space:]')
repo_exercises=$(git ls-tree -r --name-only "$EXPECTED_COMMIT" content/exercises/ | wc -l | tr -d '[:space:]')

if [ -n "$image_exercises" ] && [ "$image_exercises" = "$repo_exercises" ]; then
  check 0 "exercise file count in the image matches the repository ($image_exercises)"
else
  check 1 "exercise file count in the image matches the repository (image ${image_exercises:-?}, repo ${repo_exercises:-?})"
fi

# The content root is baked into the image, so the container resolves nothing from any checkout on
# this host. A bind mount here is exactly the shape that lets the next merge drift again.
mounts=$(run_docker inspect "$CONTAINER" --format '{{len .Mounts}}')
if [ "$mounts" = "0" ]; then
  check 0 "container resolves content from the image, not from a host checkout"
else
  check 1 "container resolves content from the image, not from a host checkout ($mounts mount(s))"
fi

if [ "$failures" -ne 0 ]; then
  printf '\n%d check(s) failed: staging is not provably built from this repository at %s.\n' \
    "$failures" "$EXPECTED_COMMIT"
  printf 'Rebuild per deploy/README.md with --build-arg BUILD_COMMIT=%s.\n' "$EXPECTED_COMMIT"
  exit 1
fi

printf '\nstaging is built from %s at %s\n' "$REPO_URL" "$source_commit"
