#!/bin/sh
# Point this repository at the committed hooks in .githooks/ so every worktree enforces them.
#
# The installed hooks live in the shared .git dir, not in any working tree, and core.hooksPath
# is absolute. Both choices are load-bearing:
#
#   * absolute, because git resolves a relative hooks path against the top level of the
#     *current* worktree and skips hooks silently when that directory is not there. A worktree
#     on a branch from before .githooks/ existed would lose the guard with no error at all --
#     the same class of silent skip this board keeps paying for.
#   * in .git, because a hooks directory inside a checkout belongs to whatever branch that
#     checkout happens to be on. Installing there would put untracked files into another
#     agent's working tree, which is the shared-state hazard this repository exists to remove.
#
# One call covers every current and future worktree of this clone: core.hooksPath is
# repository-local config, shared by all of them. The installed copies are not committed and
# are not reviewed -- .githooks/ in the repository is the reviewed source of truth, and this
# script is the only thing that copies it into place. `--check` compares the two, so drift is
# visible rather than assumed away.
#
# Usage: sh scripts/install-git-hooks.sh [--check]
#
#   --check   report the installed hooks and whether they still match the committed source;
#             change nothing. Exits 1 if the guard is missing or stale.

set -eu

# Resolve the repository that holds the committed hooks from this script's own location, not
# from the current directory: the whole point is that the caller may be a worktree on an older
# branch while the shared config still needs updating.
src_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
src_hooks="$src_root/.githooks"

if ! common=$(git -C "$src_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
  printf 'install-git-hooks: %s is not a git repository\n' "$src_root" >&2
  exit 2
fi
dest="$common/hooks-paperclip"

if [ "${1:-}" = "--check" ]; then
  configured=$(git -C "$src_root" config --get core.hooksPath || true)
  printf 'source hooks : %s\n' "$src_hooks"
  printf 'installed to : %s\n' "$dest"
  printf 'core.hooksPath: %s\n' "${configured:-<unset>}"
  rc=0
  if [ ! -f "$src_hooks/pre-push" ]; then
    printf 'pre-push      : MISSING from the source -- are you on a branch that predates it?\n'
    rc=1
  elif [ ! -f "$dest/pre-push" ]; then
    printf 'pre-push      : NOT INSTALLED -- run scripts/install-git-hooks.sh\n'
    rc=1
  elif ! cmp -s "$src_hooks/pre-push" "$dest/pre-push"; then
    printf 'pre-push      : STALE -- installed copy differs from the committed source\n'
    rc=1
  elif [ ! -x "$dest/pre-push" ]; then
    printf 'pre-push      : NOT EXECUTABLE -- git never calls a non-executable hook\n'
    rc=1
  else
    printf 'pre-push      : installed, executable, identical to source\n'
  fi
  if [ "$configured" != "$dest" ]; then
    printf 'core.hooksPath is not the installed directory; git is running %s\n' "${configured:-nothing}"
    rc=1
  fi
  exit "$rc"
fi

if [ ! -f "$src_hooks/pre-push" ]; then
  printf 'install-git-hooks: %s/pre-push does not exist.\n' "$src_hooks" >&2
  printf '                   The hooks are committed, not generated: merge origin/main and retry.\n' >&2
  exit 2
fi

mkdir -p "$dest"
for hook in "$src_hooks"/*; do
  [ -f "$hook" ] || continue
  name=$(basename "$hook")
  cp "$hook" "$dest/$name"
  chmod +x "$dest/$name"
done

# The gate script is resolved at push time by the hook itself, from the pushing worktree or
# from the checkout the hooks were installed from. Recording that root here means a worktree on
# a branch old enough to lack scripts/check-push-authors.mjs still finds the guard instead of
# silently pushing unverified.
printf '%s\n' "$src_root" >"$dest/.gate-root"

git -C "$src_root" config core.hooksPath "$dest"

printf 'installed hooks from %s\n' "$src_hooks"
printf '  -> %s\n' "$dest"
printf '  core.hooksPath = %s\n' "$dest"
printf '  gate script resolved from: %s\n' "$src_root"
printf 'enforced on every push from every worktree of this clone.\n'
printf 'verify: sh scripts/install-git-hooks.sh --check\n'
printf 'bypass: git push --no-verify defeats this. Use it only when a push is blocked for a\n'
printf '        stated reason, and say so on the issue.\n'
