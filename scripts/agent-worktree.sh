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
#   sh scripts/agent-worktree.sh check [--for-push]
#   sh scripts/agent-worktree.sh remove <agent> <branch>
#   sh scripts/agent-worktree.sh identity <agent> "Name" <email> [--registry-only]
#
#   add      create <wt-root>/<agent>-<branch-slug> off <base> (default origin/main), give it
#            its own git identity and the shared hooks, and print the cd command
#   list     every worktree with the identity it will commit under, and what its node_modules
#            resolves to. Exits 1 if any checkout runs against another checkout's install, or
#            against a link that does not resolve: both are silent failures (MAX-109)
#   check    audit every worktree: hooks installed, each agent's identity its own, and what its
#            node_modules actually is. Exits 1 when anything is unisolated, so it can be read by
#            a person or a script
#   check --for-push
#            the same audit, exiting only on what makes this clone unsafe to deliver from. The
#            push hook runs this, so the audit happens without anyone choosing to run it (MAX-102).
#            Conditions that are real but not actionable from a push -- the shared root, a
#            dependency link that does not resolve -- are printed, named, and do not fail it
#   remove   drop a worktree; refuses if its working tree is dirty
#   deps     point an existing worktree's node_modules at a shared install, and report what that
#            link resolves to -- including a refusal in print when the target is another
#            checkout of this repo rather than a shared install (MAX-109)
#   identity record or update an agent's name/email in the shared registry, and re-apply it to
#            that agent's existing worktrees (--registry-only to record it and stop there)
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

# A git hook is invoked with GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and any `-c` overrides
# exported, all naming the *pushing* checkout. `git -C <another worktree> config --get
# user.email` does not ignore them -- it reads the file GIT_DIR points at -- so from inside
# pre-push every row of an audit would come back as the pushing worktree's identity: bob-2
# grading carol's worktree as bob-2, and every healthy row disagreeing with the registry. The
# whole table is wrong, silently, which is the one failure mode an audit cannot have. Clearing
# them puts every read back on the directory it names; discovery then walks up from the
# directory this was run in, which is what the next line already required.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_CONFIG_PARAMETERS
unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0

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

# Every registered worktree of this clone, one path per line, in physical form. Called out to its
# own function because deps classification needs the estate's membership, not just its layout: the
# difference between a supported shared install and another agent's checkout is *which checkout*,
# and that is only answerable from `git worktree list`.
worktree_paths() {
  git -C "$main_root" worktree list --porcelain | sed -n 's/^worktree //p' |
    while IFS= read -r wt; do physical "$wt"; printf '\n'; done
}

# Physical form of an existing path: `..` collapsed, intermediate symlinks resolved. String
# comparison alone is not enough to decide which checkout a link lands in --
# `node_modules -> ../other/node_modules` and `node_modules -> /abs/other/node_modules` are the
# same link and were two different answers -- and a relative link into another agent's checkout
# reads as a perfectly good shared install if you only compare the strings. Falls back to the
# input when the path does not exist, because the callers check that separately and a diagnostic
# must not die on a dangling target.
physical() {
  (cd -P -- "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"
}

# Absolute form of a symlink target, read the way the kernel reads it: a relative link resolves
# against the directory holding the link, not the directory the reader happens to be in. Reporting
# the raw `readlink` string would let `../other/node_modules` read as a path nothing else here
# ever produces.
abs_target() {
  dir=$1
  target=$2
  case "$target" in
    /*) printf '%s' "$target" ;;
    *) printf '%s' "$dir/${target#./}" ;;
  esac
}

# Is $1 a checkout of this clone other than the shared root? The shared root is excluded by name,
# and so is a directory that is not a checkout at all: /home/opc/.shared-node-modules is a
# supported install that lives outside the estate, and calling it a cross-agent leak would be
# wrong. Read line by line rather than through `$(...)` in a for loop, because a worktree path may
# contain a space and a split one would silently audit a directory nobody has.
in_estate() {
  probe=$1
  ret=1
  while IFS= read -r wt; do
    [ -n "$wt" ] || continue
    [ "$wt" = "$main_root" ] && continue
    if [ "$wt" = "$probe" ]; then
      ret=0
      break
    fi
  done <<EOF
$(worktree_paths)
EOF
  return "$ret"
}

# The directory containing a path, in physical form. Fails when there is no directory part.
parent_of() {
  base=${1%/*}
  [ "$base" != "$1" ] || return 1
  [ -n "$base" ] || base=/
  physical "$base"
}

# What a worktree's node_modules is, read rather than assumed. MAX-81's tracked symlink pointed
# at /home/opc/math-training-app/node_modules, which was itself a symlink to that same path: a
# self-referential loop, so every worktree that inherited it had a node_modules it could not
# resolve and did not know was broken. `shared -> path` therefore only ever reports what the link
# resolves to now.
#
# Four states plus one, and the new ones are the reason this function reads the estate. A link that
# resolves into *another agent's checkout* is a working directory: every test in it runs, every gate
# passes, and it loads that other agent's dependency tree while reporting this worktree's name in
# the results. `shared ->` was the wrong word for it, which is exactly why it survived -- the row
# looked like the intended design. It is now FOREIGN and carries whose tree it is, because a gate
# that cannot say whose dependencies it loaded cannot detect a cross-agent leak.
#
# Resolution follows the whole chain, not the first hop, so the reported answer is the install that
# is actually loaded: a link to another checkout's node_modules that is itself a link to the shared
# root does load the shared install. That is not the same as being pointed at it, though. Such a
# chain is VIA, and it is a fault of its own -- the tree it loads today is correct only for as long
# as the other agent leaves that intermediate link alone, and `npm ci` or one `deps` call over there
# repoints it with nothing here changing. A row that reads `shared` cannot tell those two apart.
deps_state() {
  dir=$1
  nm=$dir/node_modules
  if [ -L "$nm" ]; then
    target=$(readlink "$nm")
    immediate=$(abs_target "$dir" "$target")
    resolved=$(physical "$immediate")
    if [ ! -d "$nm" ]; then
      printf 'shared -> %s (DANGLING)' "$target"
      return 0
    fi
    at_shared=no
    if [ "$resolved" = "$(physical "$main_root/node_modules")" ]; then at_shared=yes; fi
    if owner=$(deps_owner "$immediate"); then
      if [ "$at_shared" = yes ]; then
        printf 'VIA[%s] -> %s' "$owner" "$target"
      else
        printf 'FOREIGN[%s] -> %s' "$owner" "$target"
      fi
      return 0
    fi
    if [ "$at_shared" = yes ]; then
      printf 'shared -> %s' "$target"
    else
      printf 'external -> %s' "$target"
    fi
  elif [ -d "$nm" ]; then
    printf 'local'
  else
    printf 'missing'
  fi
}

# Whose link is this path, if it is one? Prints the registry agent owning the checkout that
# contains it, or fails when the path is not inside a checkout of this clone. The shared root is
# deliberately not "somebody's link": it is the estate's own install and everyone may share it.
deps_owner() {
  owner=$(parent_of "$1") || return 1
  in_estate "$owner" || return 1
  owner=$(agent_for_path "$owner")
  [ -n "$owner" ] || owner='unregistered'
  printf '%s' "$owner"
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
    return 0
  fi

  # The other way a link can be wrong is by resolving. Pointing a checkout at another agent's
  # node_modules produces a worktree that runs, tests green, and loads that agent's dependency
  # tree -- and reads as `shared ->` in every listing, because until MAX-109 nothing said whose
  # install it was. Refusing it here would break the legitimate case of an install outside the
  # estate, so it is named instead: the person who just created it is the one who can undo it.
  parent=$(physical "${shared%/node_modules}")
  if [ "$parent" != "$shared" ] && owner=$(deps_owner "$shared"); then
    printf 'WARNING: %s is another checkout of this repo' "$shared" >&2
    printf '         (physical path %s, agent %s), not a shared install.\n' "$parent" "$owner" >&2
    printf '         %s will now load that agent'"'"'s dependency tree and its npm workspace links,\n' "$dir" >&2
    printf '         under its own name -- silently, because nothing else reported it (MAX-109).\n' >&2
    printf '         If that is deliberate, say so on the issue. Otherwise:\n' >&2
    printf '           sh scripts/agent-worktree.sh deps %s %s\n' "$dir" "$main_root/node_modules" >&2
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
        "detached"|"detached "*)
          # `detached` arrives bare -- no trailing space, no ref after it -- so a `"detached "*`
          # pattern matched nothing at all and every detached worktree fell out of both tables.
          # That is a checkout whose node_modules nothing here could see, which is the one shape
          # this table exists to catch.
          email=$(git -C "$path" config --get user.email 2>/dev/null || echo '<unset>')
          printf '%-36s %-42s %-28s %s\n' "$path" '(detached)' "$email" "$hookspath"
          ;;
      esac
    done <<EOF
$(git -C "$main_root" worktree list --porcelain)
EOF
    printf '\ndeps\n'
    # `list` exits non-zero on the states where a checkout's dependency tree is not its own to
    # trust -- a link into another agent's checkout (FOREIGN), a link that reaches the shared
    # install only through another agent's link (VIA), and one that does not resolve. `missing`
    # is counted and printed but is not a failure: `add` without SHARED_NODE_MODULES deliberately
    # leaves a worktree to its own `npm ci`, so a new worktree reads `missing` for the length of
    # one npm run. An exit code that fires on that window would be red on every healthy machine
    # and get ignored, which is how MAX-69's exit 1 went unread for a week.
    foreign=0
    via=0
    dangling=0
    missing=0
    path=""
    while IFS= read -r line; do
      case "$line" in
        "worktree "*)
          path=${line#worktree }
          ;;
        "branch "*|"detached"|"detached "*)
          state=$(deps_state "$path")
          case "$state" in
            FOREIGN*) foreign=$((foreign + 1)) ;;
            VIA*) via=$((via + 1)) ;;
            *DANGLING*) dangling=$((dangling + 1)) ;;
            missing) missing=$((missing + 1)) ;;
          esac
          printf '%-36s %s\n' "$path" "$state"
          ;;
      esac
    done <<EOF
$(git -C "$main_root" worktree list --porcelain)
EOF
    if [ "$foreign" -ne 0 ]; then
      printf '\nFOREIGN: %s checkout(s) above load another agent'"'"'s node_modules.\n' "$foreign"
      printf '  They resolve, so nothing fails and no gate says whose tree it loaded: a\n'
      printf '  package.json or lockfile delta on the owning branch lands in every one of them.\n'
    fi
    if [ "$via" -ne 0 ]; then
      printf '\nVIA: %s checkout(s) above reach the shared install through another checkout'"'"'s\n' "$via"
      printf '  link. They load the right tree today and the wrong one the moment that agent\n'
      printf '  runs npm ci or repoints it. Point them at the shared install themselves.\n'
    fi
    if [ "$foreign" -ne 0 ] || [ "$via" -ne 0 ]; then
      printf '  Repoint each at the shared install (one command per row, no directory is clobbered):\n'
      printf '    sh scripts/agent-worktree.sh deps <worktree-dir> %s\n' "$main_root/node_modules"
      printf '  or run npm ci in that worktree and keep its own install.\n'
    fi
    if [ "$dangling" -ne 0 ]; then
      printf '\nDANGLING: %s checkout(s) above have a node_modules that does not resolve.\n' "$dangling"
      printf '  npm ci in the worktree, or `deps <worktree-dir> %s`.\n' "$main_root/node_modules"
    fi
    if [ "$missing" -ne 0 ]; then
      printf '\n%d checkout(s) have no node_modules yet: npm ci in each, or share the install.\n' "$missing"
    fi
    if [ "$foreign" -ne 0 ] || [ "$via" -ne 0 ] || [ "$dangling" -ne 0 ]; then
      printf '\nregistry: %s\n' "$registry"
      [ -f "$registry" ] && cat "$registry"
      printf '\nagent-worktree: %s foreign, %s via another checkout, %s dangling -- see above.\n' \
        "$foreign" "$via" "$dangling"
      exit 1
    fi
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
    #
    # Two exit codes, and the difference is the whole point (MAX-102). A human reading this table
    # wants to know everything. A push needs to know only what makes *this repository* unsafe to
    # deliver from, because a check wired into the push path that also fails on conditions nobody
    # can fix from a keyboard is a check that gets bypassed. So:
    #
    #   blocking   an identity that disagrees with the registry, an identity git cannot find at
    #              all, the push guard not installed, or node_modules tracked in the tree. Every
    #              one of these is a fact about this clone, and each is fixed by one command.
    #   reported   the shared root (MAX-101: it cannot be removed from its own clone, the gate
    #              refuses its pushes by name, and the row is the audit saying so), and a
    #              dependency link that is dangling (MAX-98) or foreign -- resolving into
    #              another agent's checkout (MAX-109). Both are repaired per worktree by
    #              whoever owns that worktree, not by whoever happened to run the audit.
    #
    # `--for-push` reports all of it and exits on the blocking half only. `AGENT_WORKTREE_CHECK=0`
    # waives the blocking half, and says so on stdout, so a waiver is a printed fact rather than a
    # missing line in a log.
    for_push=no
    case "${2:-}" in
      '') ;;
      --for-push) for_push=yes ;;
      *) die "unknown flag for check: $2 (expected --for-push)" ;;
    esac
    [ $# -le 2 ] || die "check takes at most one flag: --for-push"
    if [ "$for_push" = yes ] && [ "${AGENT_WORKTREE_CHECK:-}" = 0 ]; then
      printf 'agent-worktree: AGENT_WORKTREE_CHECK=0 -- the worktree audit is WAIVED for this push.\n'
      printf '                  Say so on the issue; a waiver nobody reads is how this came back.\n'
      exit 0
    fi

    rc=0
    reported=0
    # One fault, one accounting. In the human mode every fault is the same number, which is what
    # this exit code has always meant. --for-push is the only mode that tells them apart.
    note_fault() {
      if [ "$for_push" = yes ]; then reported=$((reported + 1)); else rc=1; fi
    }

    # A clone with no registry is either a CI runner or a delivery host where somebody deleted it.
    # Those look identical from here, so this does not guess: it says which one it cannot tell
    # apart, names the command that creates one, and lets the push through -- because the gate's
    # refusal has to be actionable, and "there is nothing to check" is not an action. It is a
    # printed line, never a silent skip: silence is how a broken gate and a gate that passed end
    # up indistinguishable.
    if [ ! -f "$registry" ]; then
      printf 'WARN  no identity registry at %s.\n' "$registry"
      printf '      No worktree on this clone can be accounted for: the audit below reads the\n'
      printf '      registry, not the checkout. Record an agent with\n'
      printf '        sh scripts/agent-worktree.sh identity <agent> "Name" <email>\n'
      printf '      On a CI runner or a fresh clone there is no estate to audit, which is why this is\n'
      printf '      reported rather than fatal.\n'
      reported=$((reported + 1))
    fi
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
      printf 'WARN  node_modules is tracked in the checkout at %s:\n' "$main_root"
      git -C "$main_root" ls-tree -l HEAD -- node_modules | sed 's/^/        /'
      printf '      A tracked node_modules symlink carries one host'"'"'s absolute path into every\n'
      printf '      export (MAX-81). Remove it with `git rm --cached node_modules`, and see\n'
      printf '      whether this branch predates the fix on main.\n'
      rc=1
    fi

    printf '\n%-36s %-40s %-28s %s\n' WORKTREE AGENT IDENTITY STATUS
    path=""
    first=yes
    while IFS= read -r line; do
      case "$line" in
        "worktree "*)
          path=${line#worktree }
          email=$(git -C "$path" config --get user.email 2>/dev/null || echo '<unset>')
          name=$(git -C "$path" config --get user.name 2>/dev/null || echo '<unset>')
          agent=$(agent_for_path "$path")
          is_root=no
          if [ "$first" = yes ]; then
            first=no
            is_root=yes
          fi
          status=ok
          if [ "$email" = '<unset>' ]; then
            status='NO IDENTITY'
            # An agent worktree with no identity commits under whatever git invents from the
            # system account, which is the MAX-69 class. The shared root is different: it is not
            # a place work happens, its pushes are refused by name (MAX-101), and a fresh clone or
            # a CI runner legitimately has no identity there at all. Refusing those would refuse
            # every push on any clone nobody has configured.
            if [ "$is_root" = yes ]; then note_fault; else rc=1; fi
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
          # A dependency link that is dangling, or that resolves into another agent's checkout, is
          # a fault reported by name rather than folded into the identity status: it is not an
          # identity fault and the fix belongs to the worktree's owner. Neither is push-blocking,
          # because a bulk rewrite of checkouts other agents are working in is MAX-69's hazard --
          # that repair is one `deps` command per worktree, run by whoever owns it (MAX-109).
          # The state itself is on the second line, because "shared", "shared but broken" and
          # "another agent's tree" have to be told apart from a listing.
          deps=$(deps_state "$path")
          case "$deps" in
            *DANGLING*)
              status="$status; node_modules does not resolve"
              note_fault
              ;;
            FOREIGN*)
              status="$status; node_modules is another checkout's install"
              note_fault
              ;;
            VIA*)
              status="$status; node_modules reaches the shared install via another checkout"
              note_fault
              ;;
          esac
          # The shared root is the first entry `git worktree list` prints, and it is the one
          # checkout on this box that every agent shares. Identity there belongs to whoever
          # configured it, so authorship is unverifiable and the push guard refuses to deliver
          # from it (MAX-101). An audit that called this checkout `ok` would be auditing the one
          # directory where isolation is known not to hold.
          #
          # It cannot be blocking: it is the primary working tree of the clone, so it cannot be
          # removed, and MAX-101 already refuses its pushes by name. A row that is always red and
          # always red for a reason nobody can act on trains people to read the exit code as noise,
          # which is how MAX-69's exit 1 went unread for a week.
          if [ "$is_root" = yes ]; then
            if [ "$path" != "$main_root" ]; then
              printf 'WARN  %s is not listed first by `git worktree list`; assuming the first entry\n' "$path"
            fi
            root_status='SHARED ROOT, not isolated; pushes from here are refused (MAX-101)'
            if [ "$status" = ok ]; then
              status="$root_status"
            else
              status="$root_status; $status"
            fi
            note_fault
          fi
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
    printf 'fix the shared root: it is a control surface, not a place work happens.\n'
    printf '  sh scripts/agent-worktree.sh add <agent> <branch>   # then commit and push in there\n'
    printf '  a shared-root push is refused by scripts/check-push-authors.mjs; to say the checkout\n'
    printf '  really is yours alone: git -C %s config agent.allowSharedRoot true\n' "$main_root"
    printf 'fix a dangling node_modules: npm ci in that worktree, or\n'
    printf '  sh scripts/agent-worktree.sh deps <worktree> %s   # tracked as MAX-98\n' "$main_root/node_modules"
    printf 'fix a FOREIGN node_modules: this checkout loads another agent'"'"'s install, so its gates\n'
    printf '  report their dependencies under this worktree'"'"'s name. Repoint the owner at the shared\n'
    printf '  install -- one command, no directory is clobbered -- or npm ci in that worktree:\n'
    printf '  sh scripts/agent-worktree.sh deps <worktree> %s   # tracked as MAX-109\n' "$main_root/node_modules"
    printf 'fix a VIA node_modules: it loads the shared install, but through a link another agent\n'
    printf '  can repoint. Same one command, so nothing here depends on their node_modules.\n'
    if [ "$for_push" = yes ]; then
      if [ "$rc" -ne 0 ]; then
        printf '\n--for-push: REFUSED. A worktree above commits under an identity the registry\n'
        printf 'does not record, or this clone cannot say who is pushing. Delivering from here\n'
        printf 'would put commits on a branch that no checkout is accountable for. Fix the rows\n'
        printf 'marked above and push again.\n'
        printf '  To deliver anyway, and say so on the issue: AGENT_WORKTREE_CHECK=0 git push ...\n'
      elif [ "$reported" -ne 0 ]; then
        printf '\n--for-push: ok. %s condition(s) above do not block a push, and none of them is\n' "$reported"
        printf 'something a push can fix: the shared root cannot be removed from its own clone\n'
        printf '(MAX-101, and its pushes are refused by name), and a dependency link that does not\n'
        printf 'resolve or that resolves into another agent'"'"'s checkout is repaired per worktree\n'
        printf 'by whoever owns that worktree (MAX-98, MAX-109). This is\n'
        printf 'why plain `check` and the push path do not always give the same answer.\n'
      else
        printf '\n--for-push: ok. Every worktree is isolated and commits under its own identity.\n'
      fi
    fi
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
    [ $# -ge 4 ] || die "usage: agent-worktree.sh identity <agent> \"Name\" <email> [--registry-only]"
    agent=$2
    name=$3
    email=$4
    registry_only=${5:-}
    [ -z "$registry_only" ] || [ "$registry_only" = '--registry-only' ] \
      || die "unknown option: $registry_only (expected --registry-only)"
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

    # Re-apply to the worktrees this agent already has. Recording an identity and leaving the
    # existing checkouts on the old one is how MAX-102 was found: three of bob-2's five worktrees
    # were created under `bob2@paperclip.local`, the registry was corrected to
    # `bob2@users.noreply.github.com`, and `check` went red for every push from then on with
    # nothing to point at except a hand-written `git config` per directory. The registry is the
    # decision; a checkout that disagrees with it is the thing that is wrong.
    if [ "$registry_only" = '--registry-only' ]; then
      printf 'registry only: existing worktrees keep the identity they were created with.\n'
      exit 0
    fi
    reapplied=0
    path=""
    while IFS= read -r line; do
      case "$line" in
        "worktree "*)
          path=${line#worktree }
          [ "$(agent_for_path "$path")" = "$agent" ] || continue
          have_name=$(git -C "$path" config --get user.name 2>/dev/null || echo '')
          have_email=$(git -C "$path" config --get user.email 2>/dev/null || echo '')
          [ "$have_name" = "$name" ] && [ "$have_email" = "$email" ] && continue
          git -C "$path" config extensions.worktreeConfig true
          git -C "$path" config --worktree user.name "$name"
          git -C "$path" config --worktree user.email "$email"
          printf 're-applied to %-46s was %s <%s>\n' "$path" "${have_name:-<unset>}" "${have_email:-<unset>}"
          reapplied=$((reapplied + 1))
          ;;
      esac
    done <<EOF
$(git -C "$main_root" worktree list --porcelain)
EOF
    if [ "$reapplied" -eq 0 ]; then
      printf 'no existing worktree of %s held a different identity.\n' "$agent"
    else
      printf 're-applied to %s worktree(s). Commits already made keep the identity they were\n' "$reapplied"
      printf 'authored with: rewriting them is a separate, deliberate decision.\n'
    fi
    ;;

  check|list|remove|identity)
    die "unknown command: $cmd (expected add, list, check, remove, deps or identity)"
    ;;
esac
