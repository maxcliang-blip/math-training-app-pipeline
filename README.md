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
- a lesson or exercise response carries `figureReference()` and nothing more: a key, never an
  inline SVG, hash or pipeline version
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

`identity` records an agent's name and email in `.git/agent-identities` in the shared `.git` dir,
so `add <agent>` needs no environment variables. That file is machine state, deliberately not
committed: it is a statement about who runs here, not about the corpus.

### The push guard

`scripts/check-push-authors.mjs` refuses a push that would introduce a commit authored by anyone
other than the identity configured for that checkout, and names the offending commits. It runs
from `.githooks/pre-push`, installed into the shared `.git` dir with an absolute `core.hooksPath`
so a worktree on an older branch still gets it. `npm run git:guard:selftest` proves each rule can
still fail, end to end against real repositories, and CI runs it.

What it does **not** catch, so nobody assumes it does:

- **A squashed foreign commit.** A squash rewrites authorship to the first commit's author. This
  is why the guard is one layer and not the whole answer.
- **A worktree whose identity is wrong.** If a checkout is configured as `Bob` and Carol commits
  in it, the commit says Bob and the guard passes. `agent-worktree.sh check` exists for exactly
  this half.
- **An agent pushing with `--no-verify`.** The guard is a default, not a lock.

## Roadmap

1. Repo + CI (this task)
2. UI/UX design spec
3. Backend: lesson CRUD, exercise endpoints
4. KaTeX (+ Asymptote) rendering in frontend
5. Testing & QA

Reference material on this machine: `/home/opc/amc10tooly` (existing AMC training SPA with scraped AoPS problem JSON) and `/home/opc/aime-mock-system` (mock generation scripts).
