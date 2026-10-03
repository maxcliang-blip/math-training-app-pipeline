# Math Training App

AMC-10/12/AIME level math training app: structured lessons, many exercises, full LaTeX (KaTeX) and optionally Asymptote rendering. Target: ready before the AIME in February.

Approved plan (MAX-1): React frontend + Node.js/Express backend, KaTeX for math rendering.

## Layout

- `web/` — React + Vite frontend (lessons, exercises, KaTeX rendering)
- `api/` — Node.js/Express backend (lesson CRUD, exercise handling, rendering support)
- `content/` — the authored corpus: `lessons/`, `exercises/`, `fixtures/`. This is the import
  source of truth, so it lives in the repository and not beside it.
- `scripts/` — the content and figure build gates, plus the agent git tooling below
- `.githooks/` — the hooks git runs on every push. `scripts/install-git-hooks.sh` installs them
- `.github/workflows/ci.yml` — CI: install, build, test, and the delivery-integrity gate
- `.github/workflows/content.yml` — CI: content math gate and figure build

## Content build gates

Content is not allowed to reach import unverified. Two gates, both in `scripts/`:

```bash
npm run content:check      # lint every field against Rendering Conventions S2-S9
npm run content:selftest   # the same, plus proof that each rule family can fail
npm run content:figures    # pre-render Asymptote to sanitized SVG, write the figure manifest
```

`content:selftest` is the one CI runs. It injects one defect per rule family into a throwaway
copy of the corpus and requires the engine to catch every one, so a pass means something. A
rule that stops being enforced fails the build instead of passing quietly.

`content:figures` needs an Asymptote toolchain (`ASYMPTOTE_BIN`, or `asymptote` on PATH). With
no toolchain it exits 3 rather than reporting success: figures validated but not compiled is
not a build. `content:figures:authoring` is the authoring-only variant for local work.

### Compiling figures on a host with no Asymptote package

`npm run content:figures:container` is `content:figures` with `ASYMPTOTE_BIN` and `DVISVGM_BIN`
pointed at `scripts/asy-docker` and `scripts/dvisvgm-docker`, which run the compiler inside the
`asy-local` image (asy 2.87 + dvisvgm 3.2.1 + ghostscript + ImageMagick — the same four packages
CI's `figures` job installs from apt) with the working directory bind-mounted in. Use it to find
your own figure bugs instead of leaving the land issue to find them in CI. A native
`asymptote`/`dvisvgm` on PATH takes precedence inside both wrappers, so this becomes a no-op if
the packages ever become installable. Details and the runtime fallbacks are in
`scripts/lib/asy-container.sh`.

Figures are compiled on the server side, not in the browser. The division of labour is
one-directional and load-bearing:

| Authored in `content/` | Derived by `content:figures` |
| --- | --- |
| `asymptoteSource`, `asymptoteAlt`, `asymptoteAspectRatio` | `figureSvgUrl`, `figureHash`, `figurePipelineVersion` |

Content must never carry the derived three. Requiring them at import deadlocks authoring on
the build, and no figure can ever ship.

### The figure box is a measurement, not an arithmetic consequence

`size(W,H)` does not produce a W by H picture. Under Asymptote's default `keepAspect=Aspect` the
picture is scaled "with its aspect ratio preserved such that the final width is no more than x
and the final height is no more than y" (manual, *Frames and pictures* 6.5), and `label()` is a
true-size object that `size` does not scale. The real box is whatever the geometry and the
installed font metrics jointly produce, which is why the compiled box is compared with a
tolerance (S5.5: warn at 2%, reject at 5%) rather than for equality.

`npm run content:figures:record` is the bootstrap for that: it compiles with a real toolchain
and rewrites each figure's `size(W,H)` and `asymptoteAspectRatio` to what the compiler produced,
so the corpus declares a box it can actually hit. It edits the raw text, not a JSON round trip,
because the corpus is prettier-formatted and a round trip would bury two numbers in a whole-file
rewrite. Use it when adopting a new TeX Live, review the diff, and let the strict gate hold the
line afterwards.

### Figure contract

`lib/figure-contract.mjs` is the single definition of how a figure is addressed and which fields
reach a learner, shared by the build, the API (`api/src/figures.js`) and the frontend:

- the address is `figureKey` — `m1-l1.sections.concept.figures[0]` for a lesson section figure,
  `m5-l2-f3` for an exercise — and never a filename or an array index, because a key that shifts
  serves a learner the wrong figure
- the figure payload is exactly `figureKey`, `figureSvgUrl`, `figureHash`,
  `figurePipelineVersion`, `declaredAspectRatio`, `compiledAspectRatio`, `alt`, `captionLatex`
- a lesson or exercise response carries `figureReference()` and nothing more: `figureKey` and
  `asymptoteAlt`, never an inline SVG, hash or pipeline version. The description is on the
  reference because the figure route is the thing that can fail — a manifest that did not pass is
  a 503 for every key — and the degraded figure box renders that description visibly rather than
  leaving a blank region
- the payload is served only from a manifest with `status: "pass"` and a `figureHash` on the
  figure. Absent, unbuilt or unhashed means the route does not answer; it is not an empty
  catalogue

## Run locally

```bash
npm install
npm run dev:api   # Express API on :4000
npm run dev:web   # Vite dev server on :5173
```

## One worktree per agent

Several agents work this repository at the same time, so the git working directory is shared
mutable state unless something stops it. On 2026-10-02 it was not stopped: Bob staged three
files and committed on `max-61-staging-source`, and Carol ran her own `git commit` in the same
directory seconds later. Her commit landed on his branch. The branch carried two commits, the
pull request reported 26 changed files instead of 3, and it was squash-merged under his title —
22 files of her geometry content on `main`, unreviewed, under a stranger's commit message
(MAX-69).

Scoping `git add` does not prevent this. It protects the files you stage, not the branch you are
standing on. Three things are shared in one checkout — the checked-out branch, the index, and the
working tree — and only one of them is ever being looked at.

```bash
sh scripts/install-git-hooks.sh            # once per clone: install the push guard
sh scripts/agent-worktree.sh add carol content/max-70-m5-l3
sh scripts/agent-worktree.sh check         # audit every worktree on this box
```

`add` creates `/home/opc/wt/<agent>-<branch>` off `origin/main` (override with `WT_ROOT`), gives
it its own `user.name`/`user.email` in **worktree** config, points it at the shared hooks, and
prints the `cd`. Separate HEAD, separate index, separate identity: nothing two agents can land on
each other.

The primary checkout stays as a control surface — that is where `install-git-hooks.sh` and
`worktree list` run — but not as a place work happens. A push that introduces commits from it is
refused by the guard's place rule below, because that is the one checkout where authorship cannot
be attributed to the agent who wrote it.

`identity` records an agent's name and email in `.git/agent-identities` in the shared `.git` dir,
so `add <agent>` needs no environment variables. That file is machine state, deliberately not
committed: it is a statement about who runs here, not about the corpus.

### Dependencies

`node_modules` is not in this repository. It was once, as a symlink to
`/home/opc/math-training-app/node_modules` — one host's absolute path, in the tree
`deploy/README.md` tells every operator to build from, reproduced by `git archive` (MAX-81). Note
the ignore rule: `node_modules/` does **not** match a symlink named `node_modules`, because a
trailing-slash pattern matches real directories and git does not follow symlinks. The rule here is
the bare `node_modules`, which matches both, and CI asserts the tree carries neither.

A worktree installs its own: `npm ci`. Sharing one install across checkouts is supported, because
110 packages per checkout is real work, but it is opt-in and it has a cost worth stating: npm's
workspace links inside the install are relative, so `node_modules/api -> ../api` resolves to the
checkout that ran the install, not to yours. Fine for running tooling, not fine for trusting
`npm test` about your own source.

```bash
SHARED_NODE_MODULES=/home/opc/.shared-node-modules sh scripts/agent-worktree.sh add carol content/max-70-m5-l3
sh scripts/agent-worktree.sh deps /home/opc/wt/carol-content-max-70-m5-l3 /home/opc/.shared-node-modules
```

`check` and `list` report what every worktree's `node_modules` actually resolves to, and a dangling
link is a `check` failure — a link to a path that does not exist is the same broken state MAX-81
shipped, one level of indirection closer.

### The push guard

`scripts/check-push-authors.mjs` refuses two things, and names what it refused either way. It runs
from `.githooks/pre-push`, installed into the shared `.git` dir with an absolute `core.hooksPath`
so a worktree on an older branch still gets it. `npm run git:guard:selftest` proves each rule can
still fail, end to end against real repositories, and CI runs it.

1. **Authorship.** A push may not introduce a commit authored by anyone other than the identity
   configured for that checkout. This is the MAX-69 rule.
2. **Place.** A push may not come from the repository's **primary working tree** — the shared root.
   This is MAX-101, and it exists because rule 1 cannot see there: identity is a property of the
   checkout, so in the shared root every commit carries its configured identity no matter which
   agent typed it, and rule 1 passes by construction. The MAX-77 ruling landed exactly that way, as
   a commit attributed to Bob, pushed clean by an agent who is not Bob.

Rule 2 decides "primary working tree" from git rather than from a path convention: in the primary
tree `--git-dir` and `--git-common-dir` are the same directory, and in a linked worktree the first
is that worktree's private slot under the second. The refusal names every commit the push would
attribute to the checkout's identity and points at `scripts/agent-worktree.sh add`.

```bash
git config agent.allowSharedRoot true   # or AGENT_PUSH_ALLOW_SHARED_ROOT=1, if a checkout really is yours alone
```

That waives rule 2 only. Rule 1 still applies, and `agent-worktree.sh check` reports the shared
root as `SHARED ROOT, not isolated` whatever config says.

What it does **not** catch, so nobody assumes it does:

- **A squashed foreign commit.** A squash rewrites authorship to the first commit's author. This
  is why the guard is one layer and not the whole answer.
- **A linked worktree whose identity is wrong.** A worktree configured as `Bob` in which Carol
  commits still passes rule 1, because the author does match. `agent-worktree.sh check` compares
  every worktree's identity against the registry, which is the half nothing else can do.
- **An agent pushing with `--no-verify`.** The guard is a default, not a lock.

## Roadmap

1. Repo + CI (this task)
2. UI/UX design spec
3. Backend: lesson CRUD, exercise endpoints
4. KaTeX (+ Asymptote) rendering in frontend
5. Testing & QA

Reference material on this machine: `/home/opc/amc10tooly` (existing AMC training SPA with scraped AoPS problem JSON) and `/home/opc/aime-mock-system` (mock generation scripts).
