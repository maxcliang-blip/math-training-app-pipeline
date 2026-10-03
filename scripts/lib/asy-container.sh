#!/bin/sh
# Resolve how to run Asymptote on a host that has no `asymptote` package, for scripts/asy-docker
# and scripts/dvisvgm-docker.
#
# WHY THIS EXISTS
#
# The figure build gate compiles every figure in the corpus, and CI's `figures` job does it by
# `apt-get install -y --no-install-recommends asymptote dvisvgm` on ubuntu-latest. The content
# agents do not author on ubuntu-latest. They author here, on Oracle Linux 9.8, where
# `dnf list asymptote` cannot even reach a repository:
#
#   Error: Failed to download metadata for repo '45drives_enterprise':
#   repomd.xml GPG signature verification error: Bad GPG signature
#
# So `asy` is not installable, scripts/build-figures.mjs exits 3 with "needs a real Asymptote
# toolchain", and the one local gate that is left -- scripts/check-content-math.mjs -- compiles
# no figures at all. A content issue therefore authors figures blind and only learns whether they
# compile when a *different* agent lands its PR against a red CI. MAX-24 shipped 8 unverified
# figures that way (2 hard compile failures, 6 declared-vs-compiled drift rejections). MAX-62 and
# MAX-71 then each rebuilt the same toolchain privately in scratch space to unblock the landing.
# Three times is a missing script, not a missing package.
#
# WHAT THIS DOES
#
# The `asy-local` image on this box carries asy 2.87, dvisvgm 3.2.1, ghostscript and
# ImageMagick -- the same four things CI installs from apt. So the toolchain does not have to be
# reachable through the broken package manager; it only has to be reachable through a container.
# This file resolves a command prefix that runs one binary inside that image with the caller's
# working directory bind-mounted at /w, and scripts/asy-docker / scripts/dvisvgm-docker exec it.
#
# A native install wins. If `asymptote`/`asy`/`dvisvgm` is on PATH it answers `--version`, this
# wrapper never touches a container, and the two paths are indistinguishable from the outside.
# That is the whole end state to aim for if the 45drives repository ever starts verifying, and
# it is why nothing here needs to know which one it got: scripts/build-figures.mjs records the
# compiler's own version string in the manifest, and that string is the same either way.
#
# Environment
#   ASY_CONTAINER_ENGINE  force a runtime: docker | podman
#   ASY_CONTAINER_IMAGE    image to run (default asy-local:latest)
#   ASY_CONTAINER_SUDO    set to 0 to refuse to escalate to sudo (default: escalate if needed)
#   ASY_CONTAINER_MOUNT    set to 0 to skip the bind mount (only sane when the work dir is already
#                          visible inside the image)
#
# Sourced, not executed. Provides asy_shim_prefix <binary...> which prints the argv prefix to
# run a command, and asy_shim_preflight which fails loudly instead of silently doing nothing.

# Resolve a container runtime and print the argv prefix for running "$@" in ASY_CONTAINER_IMAGE.
# Exits 1 with a diagnosis on stderr when no runtime can reach the image.
asy_shim_prefix() {
  _asy_image="${ASY_CONTAINER_IMAGE:-asy-local:latest}"
  _asy_engine=""
  _asy_prefix=""

  # Two questions per runtime, and they are not the same question.
  #
  # "can you talk to your daemon" is answered by `ps`. On this box podman answers it
  # unprivileged, because rootless podman uses a per-user socket, while docker needs sudo for the
  # root-owned /var/run/docker.sock. So the engine probe is unprivileged first and the same probe
  # through sudo, and the escalation is for the socket only -- never for the mount or the uid.
  #
  # "can you run THIS image" is answered by `image inspect`, and it is the question that actually
  # decides. podman keeps its own image store: it answers `ps` happily while holding zero images,
  # so an engine chosen on `ps` alone is an engine that cannot run the toolchain. `podman ps`
  # working on this box is therefore not evidence that podman is usable, and the auto-selection
  # below requires the image to be present for exactly that reason.
  asy_shim_can_talk() {
    if "$1" ps >/dev/null 2>&1; then return 0; fi
    [ "${ASY_CONTAINER_SUDO:-1}" = "0" ] && return 1
    command -v sudo >/dev/null 2>&1 || return 1
    # -n, not -S: this must never block on a password prompt inside a non-interactive build.
    sudo -n "$1" ps >/dev/null 2>&1
  }

  asy_shim_has_image() {
    $1 image inspect "$_asy_image" >/dev/null 2>&1
  }

  if [ -n "${ASY_CONTAINER_ENGINE:-}" ]; then
    command -v "$ASY_CONTAINER_ENGINE" >/dev/null 2>&1 || {
      echo "asy-shim: ASY_CONTAINER_ENGINE=$ASY_CONTAINER_ENGINE is not on PATH" >&2
      return 1
    }
    asy_shim_can_talk "$ASY_CONTAINER_ENGINE" || {
      echo "asy-shim: $ASY_CONTAINER_ENGINE is installed but cannot list containers; check the engine socket" >&2
      return 1
    }
    _asy_engine="$ASY_CONTAINER_ENGINE"
    _asy_prefix="$ASY_CONTAINER_ENGINE"
    asy_shim_has_image "$_asy_prefix" || {
      echo "asy-shim: $ASY_CONTAINER_ENGINE cannot see $_asy_image." >&2
      echo "  Each engine has its own image store: podman on this box answers \`ps\` unprivileged while holding" >&2
      echo "  no images at all, so a store that looks empty is a different problem from a socket that is down." >&2
      echo "  Build it into that store, or unset ASY_CONTAINER_ENGINE and let the wrappers pick an engine that has it." >&2
      return 1
    }
  else
    for _cand in docker podman; do
      command -v "$_cand" >/dev/null 2>&1 || continue
      asy_shim_can_talk "$_cand" || continue
      _asy_engine="$_cand"
      if [ "$_cand" = docker ] && ! docker ps >/dev/null 2>&1 && [ "${ASY_CONTAINER_SUDO:-1}" != "0" ]; then
        _asy_prefix="sudo -n docker"
      else
        _asy_prefix="$_cand"
      fi
      asy_shim_has_image "$_asy_prefix" || continue
      break
    done
    if [ -z "$_asy_prefix" ] || ! asy_shim_has_image "$_asy_prefix" 2>/dev/null; then
      _asy_prefix=""
    fi
  fi

  if [ -z "$_asy_prefix" ]; then
    echo "asy-shim: no container runtime on this host can run $_asy_image." >&2
    echo "  Tried: docker, podman. Each must answer \`ps\` and hold that image." >&2
    echo "  On this box: \`docker ps\` needs \`sudo -n\`, \`podman ps\` works unprivileged, and only the docker" >&2
    echo "  store holds asy-local. Set ASY_CONTAINER_ENGINE, or ASY_CONTAINER_SUDO=0 to refuse escalation." >&2
    return 1
  fi

  if [ "${ASY_CONTAINER_MOUNT:-1}" = "0" ]; then
    printf '%s' "$_asy_prefix"
    return 0
  fi

  printf '%s run --rm --network none -u %s:%s -e HOME=/tmp -v %s:/w -w /w %s' \
    "$_asy_prefix" "$(id -u)" "$(id -g)" "$(pwd)" "$_asy_image"
}

# Fail with a diagnosis when the resolved prefix cannot actually reach the image, so the caller
# never passes a bad prefix to exec and reports the container engine's error instead.
asy_shim_preflight() {
  _asy_prefix="$(asy_shim_prefix)" || return 1
  # shellcheck disable=SC2086
  $_asy_prefix true >/dev/null 2>&1 || {
    echo "asy-shim: the container runtime answered \`ps\` but could not run ${ASY_CONTAINER_IMAGE:-asy-local:latest}." >&2
    echo "  Build it once:  docker build -t asy-local:latest - <<'EOF'" >&2
    echo "    FROM debian:bookworm-slim" >&2
    echo "    RUN apt-get update && apt-get install -y --no-install-recommends \\" >&2
    echo "          asymptote dvisvgm ghostscript imagemagick texlive-latex-base latex-bin && rm -rf /var/lib/apt/lists/*" >&2
    echo "  EOF" >&2
    echo "  Or point ASY_CONTAINER_IMAGE at an image that already has asy + dvisvgm." >&2
    return 1
  }
  return 0
}