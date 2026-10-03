#!/bin/sh
# Point this repository at the committed hooks in .githooks/ so every worktree enforces them.
#
# The installed hooks -- and the gate script they call -- live in the shared .git dir, not in
# any working tree, and core.hooksPath is absolute. Both choices are load-bearing:
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
# are not reviewed -- .githooks/ and scripts/check-push-authors.mjs in the repository are the
# reviewed source of truth, and this script is the only thing that copies them into place.
# `--check` compares every installed file against its source, so drift is visible rather than
# assumed away.
#
# Both scripts the hook runs are copied in rather than referenced. A hook that resolves its gate
# out of a working tree keeps working exactly until that worktree is removed, and a guard that
# stops being found does not fail loudly: it fails by not running. The estate audit is copied for
# the same reason and not because it is small: a push from a worktree on a branch that predates
# `check --for-push` has to be refused by name, and the only copy it can rely on is this one.
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
gate_src="$src_root/scripts/check-push-authors.mjs"
audit_src="$src_root/scripts/agent-worktree.sh"

if [ "${1:-}" = "--check" ]; then
  configured=$(git -C "$src_root" config --get core.hooksPath || true)
  printf 'source hooks : %s\n' "$src_hooks"
  printf 'installed to : %s\n' "$dest"
  printf 'core.hooksPath: %s\n' "${configured:-<unset>}"
  rc=0
  check_one() {
    label=$1
    src=$2
    if [ ! -f "$src" ]; then
      printf '%-15s: MISSING from the source -- are you on a branch that predates it?\n' "$label"
      rc=1
      return
    fi
    if [ ! -f "$dest/$(basename "$src")" ]; then
      printf '%-15s: NOT INSTALLED -- run scripts/install-git-hooks.sh\n' "$label"
      rc=1
      return
    fi
    if ! cmp -s "$src" "$dest/$(basename "$src")"; then
      printf '%-15s: STALE -- installed copy differs from the committed source\n' "$label"
      rc=1
      return
    fi
    if [ "$3" = "exec" ] && [ ! -x "$dest/$(basename "$src")" ]; then
      printf '%-15s: NOT EXECUTABLE -- git never calls a non-executable hook\n' "$label"
      rc=1
      return
    fi
    printf '%-15s: installed and identical to source\n' "$label"
  }
  check_one "pre-push" "$src_hooks/pre-push" exec
  check_one "gate script" "$gate_src" node
  check_one "worktree audit" "$audit_src" node
  # `--for-push` is what the hook calls. An installed audit from before MAX-102 ignores the flag
  # and exits 1 on a row it always printed, so every push fails for a reason that is not the
  # push. The hook refuses that case too; this is where it gets noticed first.
  if [ -f "$audit_src" ] && [ -f "$dest/agent-worktree.sh" ] && ! cmp -s "$audit_src" "$dest/agent-worktree.sh"; then
    printf '%-15s: STALE for the push hook -- it resolves beside the hook, not from here\n' 'worktree audit'
    rc=1
  fi
  if [ "$configured" != "$dest" ]; then
    printf 'core.hooksPath is not the installed directory; git is running %s\n' "${configured:-nothing}"
    rc=1
  fi
  exit "$rc"
fi

if [ ! -f "$src_hooks/pre-push" ] || [ ! -f "$gate_src" ] || [ ! -f "$audit_src" ]; then
  printf 'install-git-hooks: %s/pre-push, %s and %s must all exist.\n' "$src_hooks" "$gate_src" "$audit_src" >&2
  printf '                   They are committed, not generated: merge origin/main and retry.\n' >&2
  exit 2
fi

mkdir -p "$dest"
for hook in "$src_hooks"/*; do
  [ -f "$hook" ] || continue
  name=$(basename "$hook")
  cp "$hook" "$dest/$name"
  chmod +x "$dest/$name"
done
cp "$gate_src" "$dest/check-push-authors.mjs"
cp "$audit_src" "$dest/agent-worktree.sh"
chmod +x "$dest/agent-worktree.sh"

# The gate script is resolved at push time by the hook itself, from the pushing worktree or
# from the checkout the hooks were installed from. Recording that root here means a worktree on
# a branch old enough to lack scripts/check-push-authors.mjs still finds the guard instead of
# silently pushing unverified.
printf '%s\n' "$src_root" >"$dest/.gate-root"

git -C "$src_root" config core.hooksPath "$dest"

printf 'installed hooks from %s\n' "$src_hooks"
printf '  -> %s\n' "$dest"
printf '  core.hooksPath = %s\n' "$dest"
printf '  gate and worktree audit installed alongside the hook, so no working tree has\n'
printf '  to outlive this\n'
printf '  fallback install root: %s\n' "$src_root"
printf 'enforced on every push from every worktree of this clone.\n'
printf 'verify: sh scripts/install-git-hooks.sh --check\n'
printf 'bypass: git push --no-verify defeats this. Use it only when a push is blocked for a\n'
printf '        stated reason, and say so on the issue.\n'
