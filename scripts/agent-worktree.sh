#!/bin/sh
# One worktree per agent: the structural fix for MAX-69.
#
# /home/opc/math-training-app was one working directory with one .git and several agents in
# it. That makes three things shared mutable state: the checked-out branch, the index, and
# the working tree. On 2026-10-02 Bob staged three files and committed on
# `max-61-staging-source`; Carol ran her own `git commit` in the same directory seconds later
# and her commit landed on his branch. PR #19 then reported 26 changed files instead of 3 and
# was squash-merged under his title: 22 files of her geometry content on main, unreviewed,
# under a stranger's commit message.
#
# Scoping `git add` cannot prevent this. It protects the files you stage, not the branch you
# are standing on. One worktree per agent removes the sharing: separate HEAD, separate index,
# separate working tree, and a separate git identity so authorship is a property of the
# checkout rather than of whoever typed `git config` last.
#
# Usage:
#   sh scripts/agent-worktree.sh add <agent> <branch> [base]
#   sh scripts/agent-worktree.sh list
#   sh scripts/agent-worktree.sh check
#   sh scripts/agent-worktree.sh remove <agent> <branch>
#   sh scripts/agent-worktree.sh identity <agent> "Name" <email>
#
#   add      create <wt-root>/<agent>-<branch-slug> off <base> (default origin/main), give it
#            its own git identity and the shared hooks, and print the cd command
#   list     every worktree with the identity it will commit under
#   check    audit every worktree: hooks installed, each agent's identity its own, and what its
#            node_modules actually is. Exits 1 when anything is unisolated, so it can be read by
#            a person or a script
#   remove   drop a worktree; refuses if its working tree is dirty
#   deps     point an existing worktree's node_modules at a shared install, and report what that
#            link resolves to
#   identity record or update an agent's name/email in the shared registry
#
# Environment:
#   WT_ROOT        where worktrees live (default /home/opc/wt)
#   AGENT_GIT_NAME / AGENT_GIT_EMAIL   override the registry for a single `add`
#   SHARED_NODE_MODULES   if set, `add` links the new worktree's node_modules here instead of
#                  leaving it for a per-worktree `npm ci`. See the sharing note below.

# Dependency sharing belongs here, not in main (MAX-81). node_modules was committed to main as a
# symlink to one host's absolute path, so `git archive origin/main` handed every operator a
# dangling link, and a fresh clone inherited a path that means nothing on their machine. That is
# the same failure as MAX-61: a machine-specific absolute path baked into a build input.
#
# The sharing itself is real and worth having -- one install of ~110 packages instead of one per
# checkout. It is opt-in because a shared node_modules is shared mutable state, which is the
# MAX-69 hazard, and because npm's workspace links inside the install are relative to whichever
# checkout ran the install:
#
#   node_modules/api -> ../api      # relative to the install, not to your working tree
#
# So a shared install gives every worktree the same third-party packages and, quietly, the same
# api/ and web/ directories as the worktree that installed it. That is fine for running tooling
# (figure builds, the content gate) and not fine for trusting `npm test` output about your own
# source. Hence: off by default, and `check` reports which worktrees opted in.

set -eu

main_root=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
[ -n "$main_root" ] || { printf 'agent-worktree: not inside a git repository\n' >&2; exit 2; }
common=$(git -C "$main_root" rev-parse --path-format=absolute --git-common-dir)
registry="$common/agent-identities"
wt_root="${WT_ROOT:-/home/opc/wt}"

die() {
  printf 'agent-worktree: %s\n' "$1" >&2
  exit "${2:-2}"
}

slug() {
  printf '%s' "$1" | tr '/_' '--'
}

# Look up "agent<TAB>Name<TAB>email". The registry lives in the shared .git dir: it is
# machine-local on purpose, since it is a statement about who runs here, not about the corpus.
lookup() {
  [ -f "$registry" ] || return 1
  awk -F'\t' -v a="$1" '$1 == a { print $2 "\t" $3; found = 1 } END { exit found ? 0 : 1 }' "$registry"
}

# Longest registry key that prefixes a worktree directory name. `add bob-2 fix/x` produces
# `bob-2-fix-x`, and a naive split on the first dash reads that as agent "bob" -- which is a
# different agent with a different identity, so the naive split silently checks the wrong one.
agent_for_path() {
  base=${1##*/}
  best=""
  if [ -f "$registry" ]; then
    while IFS= read -r key; do
      [ -n "$key" ] || continue
      case "$base" in
        "$key"|"$key"-*)
          if [ ${#key} -gt ${#best} ]; then best=$key; fi
          ;;
      esac
    done <<EOF
$(cut -f1 "$registry")
EOF
  fi
  printf '%s' "$best"
}

identity_of() {
  agent=$1
  name=${AGENT_GIT_NAME:-}
  email=${AGENT_GIT_EMAIL:-}
  if [ -z "$name" ] || [ -z "$email" ]; then
    line=$(lookup "$agent") || die "$agent has no identity. Add one with:
  sh scripts/agent-worktree.sh identity $agent \"Your Name\" you@example.com
or set AGENT_GIT_NAME and AGENT_GIT_EMAIL for this one call."
    if [ -z "$name" ]; then name=$(printf '%s' "$line" | cut -f1); fi
    if [ -z "$email" ]; then email=$(printf '%s' "$line" | cut -f2); fi
  fi
  printf '%s\t%s' "$name" "$email"
}

# What a worktree's node_modules is, read rather than assumed. MAX-81's tracked symlink pointed
# at /home/opc/math-training-app/node_modules, which was itself a symlink to that same path: a
# self-referential loop, so every worktree that inherited it had a node_modules it could not
# resolve and did not know was broken. `shared -> path` therefore only ever reports what the link
# resolves to now.
deps_state() {
  nm=$1/node_modules
  if [ -L "$nm" ]; then
    target=$(readlink "$nm")
    if [ -d "$nm" ]; then
      printf 'shared -> %s' "$target"
    else
      printf 'shared -> %s (DANGLING)' "$target"
    fi
  elif [ -d "$nm" ]; then
    printf 'local'
  else
    printf 'missing'
  fi
}

# Point a worktree's node_modules at a shared install and say what the result resolves to.
# Refuses to clobber a real directory: replacing an install is a bigger decision than a
# provisioning helper should make on someone's behalf, and `npm ci` in the worktree is the
# answer when someone wants the other one.
link_deps() {
  dir=$1
  shared=${2:-}
  [ -d "$dir" ] || die "no such worktree: $dir"
  [ -n "$shared" ] || die "deps needs the shared install directory:
  sh scripts/agent-worktree.sh deps <worktree-dir> <shared-node-modules>"
  nm="$dir/node_modules"
  if [ -L "$nm" ]; then
    current=$(readlink "$nm")
    if [ "$current" = "$shared" ]; then
      printf '%s: node_modules already -> %s\n' "$dir" "$shared"
    else
      rm -f "$nm"
      ln -s "$shared" "$nm"
      printf '%s: node_modules relinked %s -> %s\n' "$dir" "$current" "$shared"
    fi
  elif [ -e "$nm" ]; then
    die "$nm is a real directory, not a link. Move it aside deliberately:
  mv $nm $nm.local && sh scripts/agent-worktree.sh deps $dir $shared
or leave it and run npm ci in $dir instead."
  else
    ln -s "$shared" "$nm"
    printf '%s: node_modules -> %s\n' "$dir" "$shared"
  fi

  # A link to a directory that does not exist yet is the same broken state MAX-81 shipped, one
  # level of indirection closer. Say so at the moment it is created, not when a test fails.
  if [ ! -d "$nm" ]; then
    printf 'warning: %s does not exist, so %s/node_modules does not resolve.\n' "$shared" "$dir" >&2
    printf '         create it once from a worktree that already installed:\n' >&2
    printf '           mkdir -p %s && mv <worktree>/node_modules %s\n' "$shared" "$shared" >&2
    printf '         or drop the link (rm %s) and run npm ci in the worktree.\n' "$nm" >&2
  fi
}

cmd=${1:-}
[ -n "$cmd" ] || die "usage: agent-worktree.sh add|list|check|remove|deps|identity ..."

case "$cmd" in
  add)
    [ $# -ge 3 ] || die "usage: agent-worktree.sh add <agent> <branch> [base]"
    agent=$2
    branch=$3
    base=${4:-origin/main}
    dir="$wt_root/$(slug "$agent")-$(slug "$branch")"

    [ ! -e "$dir" ] || die "$dir already exists. Work in it, or 'remove' it first."

    # Fetch before branching, not after: a worktree created from a stale origin/main is a
    # worktree whose first push is a merge, and the first push is where MAX-69 hurt.
    git -C "$main_root" fetch origin --quiet

    if git -C "$main_root" rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
      start="refs/heads/$branch"
    else
      start="$base"
    fi
    git -C "$main_root" rev-parse --verify --quiet "${start}^{commit}" >/dev/null \
      || die "cannot start from $start (fetched? does $branch exist?)"

    git -C "$main_root" worktree add -b "$branch" "$dir" "$start" >/dev/null \
      || die "git worktree add failed for $dir"

    identity=$(identity_of "$agent")
    name=$(printf '%s' "$identity" | cut -f1)
    email=$(printf '%s' "$identity" | cut -f2)

    # Worktree-scoped config, not repo config: repo config is shared again, which is the bug.
    # extensions.worktreeConfig is what makes --worktree mean anything.
    git -C "$dir" config extensions.worktreeConfig true
    git -C "$dir" config --worktree user.name "$name"
    git -C "$dir" config --worktree user.email "$email"

    # Commits here carry Paperclip's trailer by board rule. commit.template is per-worktree
    # config, so the trailer lands in this agent's commits and nowhere else. The template file
    # itself lives in the shared .git dir: a dotfile inside the worktree would be untracked
    # noise in `git status` and would make `remove` refuse the worktree.
    message_file="$common/commit-message.txt"
    printf 'Co-Authored-By: Paperclip <noreply@paperclip.ing>\n' >"$message_file"
    git -C "$dir" config --worktree commit.template "$message_file"

    # Install the shared hooks from *this* script's repository, not from the main checkout:
    # the main checkout may be on any branch, and the guard ships on main. Failing to install
    # is reported, not swallowed -- an agent working without the gate should know it.
    if sh "$(dirname -- "$0")/install-git-hooks.sh" >/dev/null; then
      hooks_state=$(git -C "$main_root" config --get core.hooksPath || echo '<unset>')
    else
      hooks_state='<not installed: run scripts/install-git-hooks.sh>'
    fi

    # Dependencies are provisioned here rather than committed to the branch (MAX-81), so this is
    # the one place that decides whether this worktree shares an install or runs its own.
    if [ -n "${SHARED_NODE_MODULES:-}" ]; then
      link_deps "$dir" "$SHARED_NODE_MODULES"
      deps_line=$(deps_state "$dir")
    else
      deps_line='per-worktree npm ci'
    fi

    printf 'worktree : %s\n' "$dir"
    printf 'branch   : %s (from %s)\n' "$branch" "$start"
    printf 'identity : %s <%s>\n' "$name" "$email"
    printf 'hooks    : core.hooksPath = %s\n' "$hooks_state"
    printf 'deps     : %s\n' "$deps_line"
    printf '\nnext:\n  cd %s\n' "$dir"
    ;;

  list)
    # Two passes over the porcelain output instead of shelling out to git from awk: a path
    # containing a space or a quote must not be able to turn a listing into a wrong answer.
    printf '%-36s %-42s %-28s %s\n' WORKTREE BRANCH IDENTITY HOOK
    hookspath=$(git -C "$main_root" config --get core.hooksPath || echo '<unset>')
    path=""
    while IFS= read -r line; do
      case "$line" in
        "worktree "*)
          path=${line#worktree }
          ;;
        "branch "*)
          br=${line#branch refs/heads/}
          email=$(git -C "$path" config --get user.email 2>/dev/null || echo '<unset>')
          printf '%-36s %-42s %-28s %s\n' "$path" "$br" "$email" "$hookspath"
          ;;
        "detached "*)
          email=$(git -C "$path" config --get user.email 2>/dev/null || echo '<unset>')
          printf '%-36s %-42s %-28s %s\n' "$path" '(detached)' "$email" "$hookspath"
          ;;
      esac
    done <<EOF
$(git -C "$main_root" worktree list --porcelain)
EOF
    printf '\ndeps\n'
    path=""
    while IFS= read -r line; do
      case "$line" in
        "worktree "*) path=${line#worktree } ;;
        "branch "*|"detached "*) printf '%-36s %s\n' "$path" "$(deps_state "$path")" ;;
      esac
    done <<EOF
$(git -C "$main_root" worktree list --porcelain)
EOF
    printf '\nregistry: %s\n' "$registry"
    [ -f "$registry" ] && cat "$registry"
    ;;

  remove)
    [ $# -ge 3 ] || die "usage: agent-worktree.sh remove <agent> <branch>"
    agent=$2
    branch=$3
    dir="$wt_root/$(slug "$agent")-$(slug "$branch")"
    [ -d "$dir" ] || die "no such worktree: $dir"
    # Refuse on a dirty tree. The tempting recovery -- `remove --force` over uncommitted work --
    # is how an agent's in-flight content disappears, which is a worse version of MAX-61.
    if [ -n "$(git -C "$dir" status --porcelain)" ]; then
      die "$dir has uncommitted changes. Commit them, stash them, or move them deliberately first."
    fi
    git -C "$main_root" worktree remove "$dir"
    printf 'removed %s\n' "$dir"
    ;;

  check)
    # The board-level view: is each agent actually isolated, or is isolation only half done?
    # The second half is identity. A per-agent worktree whose user.email is still the repo
    # default produces commits attributed to the wrong agent, and the push guard passes them
    # because the author matches the configured identity. Isolation without identity is a
    # worktree list that looks healthy and a git log that lies.
    #
    # The third column is the dependency link, because MAX-81 shipped a node_modules that pointed
    # at a path which resolved to itself: 15 of the 17 worktrees on this host had a
    # node_modules they could not read, and nothing in the checkout said so.
    rc=0
    hookspath=$(git -C "$main_root" config --get core.hooksPath || echo '')
    if [ -z "$hookspath" ]; then
      printf 'WARN  no core.hooksPath: the push guard is not installed. Run scripts/install-git-hooks.sh\n'
      rc=1
    elif [ ! -x "$hookspath/pre-push" ]; then
      printf 'WARN  core.hooksPath=%s has no executable pre-push\n' "$hookspath"
      rc=1
    fi

    # The tracked-symlink check is on the tree, not on any one worktree's branch: node_modules
    # living in main is what reached every operator's `git archive`, and a worktree on an older
    # branch is not where that gets decided.
    if git -C "$main_root" ls-files --error-unmatch node_modules >/dev/null 2>&1; then
      printf 'FAIL  node_modules is tracked in the checkout at %s:\n' "$main_root"
      git -C "$main_root" ls-tree -l HEAD -- node_modules | sed 's/^/        /'
      printf '      A tracked node_modules symlink carries one host'"'"'s absolute path into every\n'
      printf '      export (MAX-81). Remove it with `git rm --cached node_modules`.\n'
      rc=1
    fi

    printf '\n%-36s %-40s %-28s %s\n' WORKTREE AGENT IDENTITY STATUS
    path=""
    while IFS= read -r line; do
      case "$line" in
        "worktree "*)
          path=${line#worktree }
          email=$(git -C "$path" config --get user.email 2>/dev/null || echo '<unset>')
          name=$(git -C "$path" config --get user.name 2>/dev/null || echo '<unset>')
          agent=$(agent_for_path "$path")
          status=ok
          if [ "$email" = '<unset>' ]; then
            status='NO IDENTITY'
            rc=1
          elif [ -z "$agent" ]; then
            # Not created by `add`, so there is no agent to check it against. Informational:
            # a worktree with no registry entry may be a human's scratch checkout.
            status='no registry entry for this directory'
          else
            registered=$(lookup "$agent" | cut -f2)
            if [ "$registered" != "$email" ]; then
              status="commits as $email, registry says $agent <$registered>"
              rc=1
            fi
          fi
          deps=$(deps_state "$path")
          case "$deps" in
            *DANGLING*)
              status="$status; node_modules $deps"
              rc=1
              ;;
            shared*) status="$status; deps shared" ;;
          esac
          printf '%-36s %-40s %-28s %s\n' "$path" "$agent" "$name <$email>" "$status"
          printf '%-36s %-40s %s\n' '' 'node_modules' "$deps"
          ;;
      esac
    done <<EOF
$(git -C "$main_root" worktree list --porcelain)
EOF
    printf '\nregistry (%s):\n' "$registry"
    if [ -f "$registry" ]; then
      sed 's/^/  /' "$registry"
    else
      printf '  <none: sh scripts/agent-worktree.sh identity <agent> "Name" <email>>\n'
    fi
    printf '\nfix an identity:  git -C <worktree> config --worktree user.name "Name"\n'
    printf '                   git -C <worktree> config --worktree user.email <email>\n'
    exit "$rc"
    ;;

deps)
    [ $# -ge 2 ] || die "usage: agent-worktree.sh deps <worktree-dir> [shared-node-modules]
  creates or repairs <worktree-dir>/node_modules as a symlink to the shared install, and
  prints what the link resolves to. To use the same install for every future worktree:
    SHARED_NODE_MODULES=<shared> sh scripts/agent-worktree.sh add <agent> <branch>"
    link_deps "$2" "${3:-${SHARED_NODE_MODULES:-}}"
    ;;

  identity)
    [ $# -ge 4 ] || die "usage: agent-worktree.sh identity <agent> \"Name\" <email>"
    agent=$2
    name=$3
    email=$4
    mkdir -p "$(dirname "$registry")"
    tmp="$registry.tmp.$$"
    if [ -f "$registry" ]; then
      awk -F'\t' -v a="$agent" '$1 != a' "$registry" >"$tmp"
    else
      : >"$tmp"
    fi
    printf '%s\t%s\t%s\n' "$agent" "$name" "$email" >>"$tmp"
    mv "$tmp" "$registry"
    printf 'recorded %s as %s <%s> in %s\n' "$agent" "$name" "$email" "$registry"
    printf 'note: existing worktrees keep the identity they were created with. Re-run\n'
    printf '      git -C <worktree> config --worktree user.name/user.email to change one.\n'
    ;;

  check|list|remove|identity)
    die "unknown command: $cmd (expected add, list, check, remove, deps or identity)"
    ;;
esac
