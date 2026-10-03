# Math Training App

AMC-10/12/AIME level math training app: structured lessons, many exercises, full LaTeX (KaTeX) and optionally Asymptote rendering. Target: ready before the AIME in February.

Approved plan (MAX-1): React frontend + Node.js/Express backend, KaTeX for math rendering.

## Layout

- `web/` — React + Vite frontend (lessons, exercises, KaTeX rendering)
- `api/` — Node.js/Express backend (lesson CRUD, exercise handling, rendering support)
- `content/` — the authored corpus: `lessons/`, `exercises/`, `fixtures/`. This is the import
  source of truth, so it lives in the repository and not beside it.
- `lib/` — contracts shared between the api and the gates, including which lesson exercise lists the
  client reaches ([`lib/client-sections.mjs`](lib/client-sections.mjs))
- `scripts/` — the content and figure build gates, the content close-out delivery check, and the
  agent git tooling below
- `docs/` — the content issue close-out procedure and its template, and the authoring conventions
  that no build gate enforces ([`docs/CONTENT_CONVENTIONS.md`](docs/CONTENT_CONVENTIONS.md))
- `.githooks/` — the hooks git runs on every push. `scripts/install-git-hooks.sh` installs them
- `.github/workflows/ci.yml` — CI: install, build, test, the browser layout suite, and the delivery-integrity gate
- `.github/workflows/content.yml` — CI: content math gate and figure build
- `.github/workflows/landed.yml` — CI: the landing gate (a gated branch with no pull request)

## Content build gates

Content is not allowed to reach import unverified. Two gates, both in `scripts/`:

```bash
npm run content:check      # lint every field against Rendering Conventions S2-S9
npm run content:selftest   # the same, plus proof that each rule family can fail
npm run content:figures    # pre-render Asymptote to sanitized SVG, write the figure manifest
npm run content:delivered -- m5-l2   # is the lesson id on origin/main? for a close-out
npm run client:check       # which lesson exercise lists a learner can actually reach
npm run client:selftest    # the same, plus proof each disagreement can be caught
```

`content:selftest` is the one CI runs. It injects one defect per rule family into a throwaway
copy of the corpus and requires the engine to catch every one, so a pass means something. A
rule that stops being enforced fails the build instead of passing quietly.

`content:delivered` closes the loop from the other end. A content issue can be closed `done` with
its lesson on a branch, or never written at all, and neither is visible to a gate that only looks
at the corpus in front of it — MAX-20 and MAX-23 were both. So a content issue names the lesson
ids it delivered and this command is run against `origin/main` before the issue closes. See
[`docs/CONTENT_ISSUE_CLOSEOUT.md`](docs/CONTENT_ISSUE_CLOSEOUT.md).

### What the client can reach

A lesson serves three exercise lists. The client fetches one of them, and nothing else in the
repository could tell you that — the content gate counts sections and records, the corpus pins count
the corpus, and neither reads `web/src`. 114 mastery exercises were in exactly that state, authored
and served and unreachable, until MAX-146 made the split declared and checked.

`npm run client:check` prints it:

```
section  client reach
practice    645 ids in  38 lessons  served
mastery     114 ids in  38 lessons  api-only
solutions   645 ids in  38 lessons  via-sibling
```

`mastery` is **api-only on purpose**, not a bug. The reader makes no write call, so there is no
attempt runner to record an answer against `passThreshold: 2`; the surface ships with the runner.
`solutions` is never named by the client and does not need to be — its ids are exactly the practice
ids, so those records arrive inside the practice fetch. That one is asserted per lesson rather than
assumed, so a lesson whose solutions drifted outside its practice list fails instead of quietly
becoming a fourth unreachable set.

The reach decisions live in [`lib/client-sections.mjs`](lib/client-sections.mjs), and the gate reads
them against the API's own `SECTION_ID_FIELDS`, `web/src`, and the corpus. Adding a section the API
serves without declaring its reach is a failure, and adding the mastery fetch without recording the
decision is a failure too. The rationale is in
[`docs/CONTENT_CONVENTIONS.md` §4](docs/CONTENT_CONVENTIONS.md#4-a-lessons-mastery-exercises-are-served-and-unreachable-until-there-is-a-runner).

### The corpus pins

`lib/corpus-pins.mjs` holds the lesson and exercise counts the repo asserts, in one place. Both
`npm test` and `npm run content:check` compare them against the corpus they loaded, so growing the
corpus without moving the pin is a local failure rather than a red `main`:

```
corpus pins are stale: tests assert 38 lessons / 759 exercises,
content/ holds 39 lessons / 777 exercises
```

These were three literals in three test files and had been left stale three times, each caught by
a person reading a diff. Only `api/test/content.test.js` asserts against the pin;
`api/test/health.test.js` and `api/test/routes.test.js` compare the route's numbers against the
store it loaded, because what they are testing is the route's honesty, not the corpus size.

Count records, not files, anywhere you count the corpus: a file in `content/exercises/` is either
one record or an array of them, so 264 files hold 759 records. `api/src/content.js` says so at the
loader.

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

### What the emitted SVG is

`figure.svg` is sanitized and minified, and both are enforced rather than assumed.
`sanitizeSvg()` strips `<script>`, `on*` handlers, `<foreignObject>`, external
`href`/`xlink:href`, every `<image>` outright, and any `url()` that does not point inside the
document — a CSS `url()` is an off-origin fetch exactly like `href` is, and neither reaches the
other. What survives the deny list is then asserted on before the file is written, so a vector no
pattern catches fails the build instead of shipping.

`minifySvg()` then removes the bytes that carry no information: inter-element whitespace,
attribute padding, and the compiler's full double precision — `380.847576` becomes `380.848`, and
path coordinates become deltas (`M380.848 396.192h-168.559`) rather than absolute repeats. Path
data is about 97% of a dvisvgm figure, so that is where the budget is won: across the corpus,
total bytes fall ~38% and the 95th percentile lands under the 40 KB ceiling in Rendering
Conventions S7.

Making a coordinate relative is only safe if the arithmetic is checked, because a consumer sums
the deltas and the rounding errors accumulate along the path. So `toRelativePathData()` tracks
the position a renderer will reconstruct alongside the real one, and a path that drifts more than
`PATH_DRIFT_TOLERANCE` is emitted in absolute form instead. A minified figure is never one this
pipeline has not proved it drew the same shape.

### When a figure will not compile

A compile failure is reported with the cause named, not with the symptom. Asymptote aborts inside
`shipout()` for every TeX-side failure, so the last line of the log is always "shipout failed" and
the interesting line is the first one. `describeCompileFailure()` leads with the diagnosis and
keeps the raw output as evidence.

The one worth knowing about: **a LaTeX macro written with a doubled backslash inside the Asymptote
string literal**. Asymptote copies string literals into the `.tex` it generates verbatim, so
`label("$90^\\circ$", ...)` reaches TeX as `^\\circ`; TeX reads `\\` as a line break and then
tries to typeset a bare `circ`, which fails identically on every TeX Live and is not fixed by
`\usepackage("amsmath")`. Write one backslash.

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
- a lesson or exercise response carries `figureReference()` and nothing more: `figureKey`,
  `asymptoteAlt`, `figureCacheKey` and the authored `asymptoteAspectRatio`, never an inline SVG,
  hash or pipeline version. The description is on the reference because the figure route is the
  thing that can fail — a manifest that did not pass is a 503 for every key — and the degraded
  figure box renders that description visibly rather than leaving a blank region. The ratio is on
  the reference because of the reservation below — see "The figure box is reserved, not measured"

- the payload is served only from a manifest with `status: "pass"` and a `figureHash` on the
  figure. Absent, unbuilt or unhashed means the route does not answer; it is not an empty
  catalogue

### The figure box is reserved, not measured

Rendering Conventions S5.4 makes the figure box a promise about layout, and S5.4 item 5 states the
promise as a number: **CLS contribution from a figure is 0 in both states**, unloaded and loaded.
Three rules in the implementation carry it.

- **The reservation is on the element at first paint.** `.figure__box` is sized by
  `aspect-ratio: var(--fig-ratio, 1.333)` and painted `var(--surface-sunken)` in the pending,
  unavailable and loaded states alike. The 1.333 is the default S5.4 item 1 names, and it exists
  because a box with no ratio is not neutral — it collapses to its content's height, so it is
  near-zero while pending and full height once the SVG lands.
- **The reservation comes from the reference, not from the figure route.** First paint of a figure
  happens before its payload has been fetched, so a client that has to ask for the ratio in order
  to know how much room it needs reserves nothing. `Figure.jsx` latches the ratio on the figure's
  first render and never re-reads it.
- **Nothing that arrives later resizes the box.** The `<img>` is `position: absolute; inset: 0;
  width: 100%; height: 100%; object-fit: contain`, so its arrival contributes no dimension. The
  browser's measurement of the decoded SVG is recorded as drift
  (`data-figure-ratio-drift`) and warned about in development; it is never applied to the box. A
  declaration that turns out to be wrong letterboxes the picture rather than distorting the
  geometry, and `npm run content:figures:record` is the fix for a wrong declaration.

The browser suite in `e2e/` asserts all of it:

```bash
npm run test:e2e:figure     # drives the lesson route in Chromium and measures layout shift
npm run test:e2e:install    # once per machine: download the browser
```

Its own script and its own config, `playwright.figure.config.js`, because it needs the dev server
rather than the production build `npm run test:e2e` serves. The two browser suites assert different
things against different servers, and running either under the other's server reports the wrong
number rather than failing: this one needs a dev server proxying to a fixture API it controls, and
the math suite needs `vite build` because that is what turns KaTeX's `@font-face` urls into the
requests a reader makes. `npm run test:e2e:all` runs both.

It boots its own API against a fixture corpus (`e2e/fixture-api.mjs`) rather than against
`content/`, because a layout test that runs against whatever the corpus happens to declare proves
nothing: the fixture's figure declares a 4:1 box and its SVG is 1:1, so an implementation that
resizes the box on load fails loudly instead of accidentally agreeing. No Asymptote and no
`artifacts/` are needed. Measured on that fixture, the box went 50px → 400px and the route shifted
CLS 0.069 before this change, and holds at the reserved 4:1 with the figure's own contribution 0
after.

**Two numbers, because two documents budget two things.** The figure's contribution is asserted at
exactly `0`, over the window in which the figure arrives. The route's total is asserted against the
Lesson spec S9 #6 budget of `< 0.05`, separately, and on today's build it is not zero: the reader
typesets prose with KaTeX, whose webfonts arrive after first paint and re-lay the prose out for
CLS ~0.0001. That is a real shift and it is **MAX-142**'s subject; it is not charged to the figure,
and the suite refuses to let it hide one — `expectNoFigureShift` reads every shift the run ever
recorded, including before the settle, and fails if any of them has a source inside a figure box.
See the header of `e2e/figure-reservation.spec.js` for why the obvious narrower metrics are worse.

## Run locally

```bash
npm install
npm run dev:api   # Express API on :4000
npm run dev:web   # Vite dev server on :5173
```

## Browser suite

```bash
npm run test:e2e:install   # once per clone: the chromium the suite drives
npm run test:e2e          # math layout assertions in a real browser
npm run test:e2e:figure   # figure layout assertions, dev server + fixture corpus
npm run test:e2e:all      # both suites, in that order
```

This section is the math half. The figure half is a second Playwright suite with its own config and
script — see *Reserve the figure box before the SVG arrives* above for why the two cannot share one.

RC §7 budgets layout shift at 0 and §8.5 makes it an acceptance criterion, naming the instrument:
"Asserted in a Playwright check". `npm test` cannot see layout — it renders no page — so this is a
separate suite against the **production build**, not the dev server: `vite build` is what turns
KaTeX's `@font-face` urls into the requests a reader makes, and a suite run against the dev server
would be asserting about filesystem paths that only exist on a developer machine.

It boots the API on `:4000` and serves `web/dist` on `:5184`, and navigates the real reader
(module list → module → lesson) against the shipped corpus.

### Why the KaTeX faces settle, and why `optional`

KaTeX declares twenty `@font-face` families with no `font-display`, so they inherit `auto`: a block
period, then a swap whenever the face lands. A face is only *requested* once a formula has rendered,
which is after the bundle has loaded and React has run — so the swap is always after first paint.
Until it lands every formula is laid out in the fallback serif; when it lands, the browser re-lays the
prose. Measured on `m1-l1`, that is `CLS 1.1e-6` from one `SPAN.base` inside `SPAN.katex-html`, which
is inside the Lesson spec §9 #6 budget (`< 0.05`) and outside RC §7's (`= 0`) at the same time.

`web/vite-katex-font-display.js` rewrites those declarations to `font-display: optional` and preloads
the one face that carries prose (`KaTeX_Main-Regular`). `optional` has **no swap period**: the browser
gives the face a short block period and then, if it has not arrived, uses the fallback for the life of
the page and never changes its mind. Preloading or reordering only makes the face arrive sooner —
it cannot make it arrive before first paint on a connection where it does not, so the defect survives
as a timing race and the number changes with the machine. The cost of `optional` is stated rather than
hidden: on a first visit on a slow connection the math renders once in the fallback serif, and the
face is cached from then on.

Two traps this went through, both of which look like a working fix in a diff:

- **A duplicate `@font-face` only overrides the original because the last one declared wins.** That is
  a cascade detail, not a guarantee. The transform rewrites the declaration in place instead, so there
  is one rule with one `font-display` that every browser has to honour.
- **KaTeX's declarations do not end in a semicolon**, because a CSS block's last declaration does not
  need one. Appending `font-display:optional` straight onto the end produces
  `src:url(...) format("truetype")font-display:optional`, where the policy is swallowed into the
  value of `src` and the face silently keeps the default. The symptom is the layout shift still being
  there, with nothing in the emitted CSS to explain it.

`e2e/math-font-settle.spec.js` covers both: it parks every KaTeX font response until the page has
painted and then releases them, so a fix that only makes the faces arrive sooner fails the suite on
any machine, fast or slow.

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

It also **re-applies** that identity to the agent's existing worktrees, and prints each one it
changed. Recording an identity and leaving the checkouts on the old one is how the estate drifted
in the first place: three of five worktrees were created under one address, the registry was
corrected to another, and every later push from those worktrees was wrong while `check` — the only
thing that could see it — had to be run by hand (MAX-102). `--registry-only` records without
touching any worktree.

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

`check` and `list` report what every worktree's `node_modules` actually resolves to. A link that
does not resolve is a `check` failure — a link to a path that does not exist is the same broken
state MAX-81 shipped, one level of indirection closer.

**A link into another agent's checkout is its own state, and it is the dangerous one** (MAX-109).
Such a link resolves, so every test in the worktree runs and every gate passes, while the worktree
loads that other agent's dependency tree *and* npm's workspace links — `node_modules/api -> ../api`
— and reports the results under its own name. Nothing fails, which is why the shape survived every
check: until MAX-109 a listing called any resolved symlink `shared -> <path>`, so a checkout
pointing into a colleague's branch read exactly like the intended design.

`list` and `check` classify what a link resolves to, naming the agent who owns the tree:

| row | meaning |
| --- | --- |
| `shared -> <path>` | the shared install: the shared root's `node_modules`, or one outside this clone |
| `local` | this checkout's own `npm ci`, no sharing |
| `external -> <path>` | a real install that is not a checkout of this repo, e.g. `/home/opc/.shared-node-modules` |
| `FOREIGN[<agent>] -> <path>` | another agent's checkout. **Their** dependency tree, under this worktree's name |
| `VIA[<agent>] -> <path>` | another agent's link that reaches the shared install. Right tree today; theirs to repoint tomorrow |
| `missing` | no install yet, and none needed until something runs |

Resolution follows the whole chain, not the first hop, so the answer is the install that is actually
loaded — a link to another checkout's `node_modules` that is itself a link to the shared root does
load the shared install. `VIA` reports that case separately, because "correct until someone else
repoints it" is a real hazard and a row that just said `shared` could not tell it apart.

Both `list` and `check` fail on `FOREIGN` and `VIA`, and `deps` prints a warning naming the repair
when it is asked to create such a link, so the leak is caught where it is created. Neither is a
*push* failure: the repair is a per-worktree `npm ci` or one `deps` command belonging to that
worktree's owner, and a bulk rewrite of checkouts other agents are working in is the MAX-69 hazard.

```bash
sh scripts/agent-worktree.sh list                        # exits 1 on FOREIGN or a dangling link
sh scripts/agent-worktree.sh deps /home/opc/wt/<wt> /home/opc/math-training-app/node_modules
```

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

#### What rule 1 is asked about (MAX-105)

Rule 1 compares commits in a range, and the range is computed against the **push's own base**: the
remote-tracking ref for a branch that already exists, the push base for a new one. After a rebase
that range also contains main's own commits, and main is what the board squash-merges, so they are
authored by `maxcliang-blip`. Rule 1 then refuses every landing in this repository by listing main's
history as another agent's work delivered under your name — MAX-69's own message, about commits
already on `main`. Four waivers were needed on MAX-103 for exactly this.

So commits reachable from the push base are subtracted before the authorship comparison, and the
count and the base are printed on the ref line:

```
refs/heads/fix/max-102-worktree-gate -> refs/heads/fix/max-102-worktree-gate: 1 commit(s), basis remote-tracking ref, 6 already on origin/main (not judged as new work)
```

The distinction is not who wrote the commit but whether the push is delivering it: a commit the
base already has is the base, and this push neither adds nor changes it. This is deliberately
**not** "reachable from any ref other than the one being pushed" — that would also swallow a commit
another agent has on a branch of their own, which is the MAX-69 shape one step earlier, and it would
swallow a branch being landed on purpose (MAX-84) with no waiver, no PR body and no review.

Two boundaries keep the subtraction from becoming a way to switch rule 1 off:

- It does not run at all if the push base does not resolve, or if the branch being pushed is already
  contained in the push base. The second is the `agent.pushBase`-aimed-at-your-own-branch case: the
  subtraction would empty the range, so the whole range is judged instead. Both are printed on the
  ref line rather than passing quietly.
- A range that comes back empty *because* of the subtraction is a pass — a push with no commit the
  base lacks delivers no new work. An empty range with no subtraction behind it is still
  `unresolved-range` and still refuses.

What rule 1 still does with what the subtraction leaves: another agent's commit is refused whether
they put it on your branch by accident (MAX-69) or on purpose (MAX-84) — a deliberate landing is
waived with `agent.allowedAuthors` and carries its provenance in the PR body (MAX-69 item 4,
MAX-83). The guard cannot tell those two apart, and does not try to.

What it does **not** catch, so nobody assumes it does:

- **A squashed foreign commit.** A squash rewrites authorship to the first commit's author. This
  is why the guard is one layer and not the whole answer.
- **An agent pushing with `--no-verify`.** The guard is a default, not a lock.

### The worktree audit on every push

Rule 1 compares a commit's author to *this checkout's* identity, so it passes whenever those two
agree. That is not a gap in the rule; it is what the rule means, and it is why MAX-92's commit
could be authored as Bob inside bob-2's worktree and pass. The missing half compares the checkout
against something it cannot agree with by itself: the registry, in `.git`, which says who runs here.

So `check` runs from the same hook, as `check --for-push`:

```bash
npm run git:worktrees:check         # the full audit, exit 1 on anything
npm run git:worktrees:check:push    # what the push hook runs
AGENT_WORKTREE_CHECK=0 git push ... # waive it, in writing, on the issue
```

`--for-push` prints the whole table and exits only on what makes *this clone* unsafe to deliver
from: an identity that disagrees with the registry, an identity git cannot find, the push guard
not installed, or `node_modules` tracked in the tree. Each is one command away. Two conditions are
reported and do not block: the shared root, which cannot be removed from its own clone and whose
pushes the guard already refuses by name (MAX-101), and a dependency link that is dangling or
foreign (MAX-98, MAX-109). A gate
that always fails for a reason nobody can act on gets read as noise — that is how MAX-69's exit 1
went unread for a week.

A clone with no identity registry — a CI runner, a fresh `git clone` — has nothing to account for.
It says so, names the command that creates a registry, and exits 0. It does not skip silently:
silence is what a broken gate and a gate that passed look identical like. CI runs the same mode in
`delivery-integrity`, on a clone whose guard is installed, so the path cannot rot.

### The landing gate

The push guard above asks *who* is delivering and *from where*. It cannot ask whether the delivery
is ever going to arrive, and on 2026-10-03 that was the whole problem: MAX-111 repaired twelve
figures, was marked `done`, and its commit sat on `fix/max-111-doubled-backslash-labels` with no
pull request ever opened. `content:check` on `origin/main` reported 0 errors with the twelve wrong
glyphs still in place — main was not red, it was blind.

Every other gate in `scripts/` is downstream of that blind spot. A gate can only catch a defect that
reaches the branch it watches, and the hole does not get smaller as the suite grows.

```bash
npm run land:check                # every branch: gated commits with no PR for them
npm run land:check -- --branch fix/max-95-figure-size-floor   # one branch, the way CI asks on a push
npm run land:selftest             # prove each rule can still fail
```

A branch is a finding when all of these hold: it carries commits touching `content/**`, `lib/**`
or `scripts/**`; those commits are not reachable from `origin/main`; no **open or merged** pull
request has that branch as its head; and the issue it belongs to is finished.

"Open or merged" is load-bearing — this repository squash-merges, so a merged branch's commits are
usually not ancestors of main, and judging on reachability alone would fail every squash-merged
branch in the repository. A PR that was closed without merging is a finding: the work is not on
main and nothing is pending.

### Work in progress is not a finding

The last condition is the one that keeps the gate usable. A branch named after an issue that is
still open (`fix/max-64-…`, `gate/max-64-…`) is work somebody is doing *now*; a branch named
after an issue that is `done` or `cancelled` is work that stopped without shipping. Without the
distinction the gate reported three findings on the dev checkout, all of them MAX-64's live
branches — and a gate that cries wolf on your own in-flight work gets muted rather than fixed.

The exemption is keyed to the issue, not to the branch name. A branch naming an issue the gate was
never told about is still a finding, because a naming convention is not evidence; that is MAX-111's
shape, and a renamed branch must not buy it an exemption.

```bash
npm run land:check                                   # asks the tracker when the session has it
npm run land:check -- --issues-json statuses.json    # or replay a recorded status list
```

A recorded list is an array of `{"identifier": "MAX-64", "status": "in_review"}` (or an object
keyed by identifier). With neither source the gate applies no exemption and says so on stdout,
rather than guessing. `--issue-source` forces one: `file`, `paperclip`, or `none`.

### Exit codes, and where the output goes

| code | meaning |
| --- | --- |
| 0 | nothing to report |
| 1 | a finding: gated commits on a branch with no PR |
| 2 | the question could not be asked — no base ref, no PR list, unreadable issue statuses, truncated listing, git failure |

2 is neither 0 nor 1. A gate that cannot reach the PR list has not established that a PR exists,
and reporting that as a pass is how a branch goes invisible again — the MAX-111 failure wearing a
different hat. Everything else in `scripts/` treats an absent toolchain the same way (see
`build-figures.mjs` exiting 3).

**Everything the gate has to say goes to stdout, `--quiet` included.** It used to go to stderr and
`--quiet` suppressed exactly that, so `npm run land:check --silent` against a failing gate printed
nothing at all and exited 1 — a silent failure that reads as a silent pass. `--quiet` now drops the
per-branch inventory and keeps the notes, the findings and the one-line verdict. stderr carries only
an unexpected crash. `--json` prints the payload and nothing else, so it stays parseable.

CI runs it in `.github/workflows/landed.yml`, in three jobs: a hermetic `gate-can-fail` proof that
the check still knows how to fail (no token, no network, both directions asserted); `branch-push`,
the real check on every push to `fix/*` and `land/*`; and `full-audit`, the weekly inventory. The
weekly job is the one MAX-111 needed and did not have — nobody ever pushed to that branch again, so
a check that only runs on push never sees it.

The PR list comes from `gh` when it is on PATH, otherwise the REST API with `GITHUB_TOKEN` (which
is what Actions provides). `--pr-json <path>` replays a recorded list in either client shape, which
is how the CI proof above stays hermetic and how the REST and `gh` paths are proven to reach the
same verdict.

### The pull request body gate

`scripts/check-pr-body-coverage.mjs` fails a pull request whose body does not account for the files
it changes. CI runs it on every `pull_request` event, as the `pr-body-coverage` job.

It exists because the push guard cannot cover the case. A squash rewrites authorship, and a
worktree with the wrong identity produces commits that match the configured one — so PR #19 reached
`main` with a body describing a Dockerfile change and 26 changed files, 23 of them somebody else's
lesson content. CI was green, the guard passed, the merge succeeded. The signal existed as
`changed_files 26` in the pull request metadata and nobody read it as an assertion.

Two rules, and the second is the one that matters:

1. **Coverage.** Every changed path must be matched by a path, glob, directory prefix or blob URL
   named in the body. Unmatched paths are reported by name, as annotations on the diff.
2. **A prose claim per top-level area.** Every top-level area the change touches needs one block of
   the body that names it and carries at least 10 words that are not paths.

Rule 1 alone is a rubber stamp: PR #19's body could have listed all 26 paths and passed a coverage
check while telling a reviewer nothing. Rule 2 is what forces the description to say something. It
is cheap to satisfy — one sentence per area, in your own words. A fenced `git diff --stat` dump
names files but does not claim them; neither does `**`.

```bash
npm run pr:body:selftest                                    # prove each rule can still fail
npm run pr:body:check -- --body body.md --files changed.txt  # check one locally
```

What it does **not** catch, so nobody assumes it does:

- **A lie.** "23 geometry lessons carried over from another agent's worktree" is a claim this
  script cannot audit. It has to be a claim a human can check.
- **A vague sentence.** The word floor is a floor on volume, not a judge of meaning.
- **Content, not coverage.** It says the description mentions the files. It cannot say the
  description is correct.

A coverage check nobody can fail is a check nobody can trust, so the selftest requires the check to
reject the MAX-69 shape (a Dockerfile body with 26 changed files) and requires a body that lists all
26 paths with no explanation to still fail on rule 2. CI runs the selftest **before** the check, so
a change that guts the gate fails on that.

Set **Require status checks to pass before merging** with `CI / pr-body-coverage` enabled on
`main`, or the check is advisory and the board is relying on someone remembering to read it.

## Roadmap

1. Repo + CI (this task)
2. UI/UX design spec
3. Backend: lesson CRUD, exercise endpoints
4. KaTeX (+ Asymptote) rendering in frontend
5. Testing & QA

Reference material on this machine: `/home/opc/amc10tooly` (existing AMC training SPA with scraped AoPS problem JSON) and `/home/opc/aime-mock-system` (mock generation scripts).
