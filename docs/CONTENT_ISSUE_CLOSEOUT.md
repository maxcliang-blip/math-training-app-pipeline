# Closing a content issue

A content issue is one that delivers lessons or exercises. This is the close-out procedure for
one, and it exists because two issues were closed `done` with nothing on `main` behind them.

| Issue | Closed as | What `main` actually held |
| --- | --- | --- |
| [MAX-20](/MAX/issues/MAX-20) | `done` | `m8-l4` authored, on a branch, unmerged for weeks |
| [MAX-23](/MAX/issues/MAX-23) | `done` | `m5-l2` never authored at all |

Between them they cost the tracker four weeks of false completion, and M5 was still listed as
outstanding work with the freeze three weeks out. Neither failure is visible to any check that
exists today: `npm run content:check` validates the corpus in front of it, and a lesson that does
not exist is not a defect in a corpus that does not exist. So the close-out has to name what it
delivered, and something has to check that name.

## The procedure

Four steps. Steps 3 and 4 are the ones that were skipped.

### 1. Ship the work on its own branch, and open the PR

Content lands through a PR like anything else. Do not close the issue on the strength of the
branch being finished.

### 2. Merge it

```bash
git fetch origin
git log --oneline origin/main..origin/<your-branch>   # empty means it is merged
```

### 3. Record the ids it delivered in the close-out comment

This is the required line. Put it in the comment that sets the issue to `done`:

```
Delivered: m5-l2, m5-l2-fig-1, m5-l2-fig-2 (lesson + its two figures)
```

Name one id per thing the issue delivered — a lesson, a figure, a worked example, an exercise.
If the issue was not a content issue, or delivered nothing, say so — `Delivered: none (docs only)`
is a valid answer and a missing line is not. A close-out that names nothing has proved nothing.

### 4. Run the delivery check against `main`

```bash
npm run content:delivered -- m5-l2 m5-l2-fig-1
```

It reads `origin/main`'s tree, resolves each id against the records the tree holds, and exits
non-zero for any id that is not there. Copy the output into the close-out comment.

```
verify-delivery: DELIVERED  (ref origin/main)
  302 content files hold 1020 addressable ids  (38 lessons, 73 figures, 150 worked-examples, 759 exercises)
  ok    m5-l2  (lesson  content/lessons/m5-l2.json)
  ok    m5-l2-fig-1  (figure  lessons/m5-l2.sections.concept.figures[0])
```

For comparison, the same command against the commit before `m5-l2` was authored — which is what
MAX-23 looked like, four weeks of it (run against `769a33e^`, the parent of the commit that added
`content/lessons/m5-l2.json`):

```
verify-delivery: NOT DELIVERED  (ref 769a33e^)
  245 content files hold 939 addressable ids  (35 lessons, 61 figures, 138 worked-examples, 705 exercises)
  MISS  m5-l2
  MISS  m5-l2-fig-1

  m5-l2, m5-l2-fig-1 is not on 769a33e^.
  Either the work is not merged, or it was never written. Do not close the issue done.
```

Then close the issue. If the check fails, the issue is not done. Leave it `in_progress` and name
what is missing.

Exit 2 is different from exit 1: it means the check could not answer rather than that the answer
was no. That covers a usage error, a git error, and an id the ref holds **twice** — which the
check refuses to resolve rather than resolving to whichever record it read first.

## What the check can and cannot see

It resolves every id in `content/lessons` and `content/exercises`: lesson ids, figure ids
(`sections.<name>.figures[].id`), worked-example ids (`sections.<name>.examples[].id`) and
exercise ids. An earlier version of this script read top-level `record.id` only, and reported
`MISS` for a figure that was in the tree and `MISS` for one that was not — the same answer for a
delivered thing and an undelivered one, which is the only answer a gate must never give. On the
current corpus that version saw 38 of 1,020 addressable ids.

Two limits are stated here rather than left to be discovered:

- **A record with no id cannot be named, so it cannot be asserted delivered.** The check counts
  them and prints the count on every run — four of m5-l1's figure reservations are in that state,
  and they are reported because silence is how they stayed invisible.
- **Work that delivers no id-bearing record cannot be checked by this at all.** A change to the
  SVG sanitiser, or to the figure cache key, or to a gate rule, leaves nothing on `content/` for
  an id to resolve against, so `Delivered: none` is an honest close-out that this procedure does
  not check. Covering that needs a check over a declared manifest of paths rather than ids, which
  is tracked in [MAX-104](/MAX/issues/MAX-104).

`npm run content:delivered:selftest` proves the resolver can tell those two apart. It runs on a
throwaway corpus rather than on this one, and each case is asserted with its opposite — a figure
id that is present must resolve *and* a figure id that is absent must not — because the bug it
guards against was not a wrong answer but an answer that could not be wrong.

## Why the check reads the tree and not the history

It uses `git ls-tree`, deliberately. A test of the form
`git merge-base --is-ancestor <sha> origin/main` asks whether *that commit* is in the history of
the target ref, and the normal shape of landing content here is a single land commit that
cherry-picks lessons from several branches — so the content is reachable on `main` without the
commit that produced it ever being an ancestor. That test would fail a delivery that had in fact
landed, and it would pass a delivery whose lesson was never written, which is the case that
actually cost four weeks. The question worth asking is "does the target ref's tree hold these
lesson ids", and that is what `ls-tree` answers.

## Why a file count will not do

A file in `content/exercises/` is *either* one record or an array of them: 264 files hold 759
records at the current pin. Any gate that counts files undercounts the corpus by roughly two
thirds and passes anyway. `api/src/content.js` documents this at the loader, and
`lib/corpus-pins.mjs` documents it at the pin; read the loader's `readRecords()` before writing a
new check that counts anything.

## The corpus pin

Growing the corpus changes the counts in `lib/corpus-pins.mjs`, in the same commit as the content
that changed them:

```
corpus pins are stale: tests assert 38 lessons / 759 exercises,
content/ holds 39 lessons / 777 exercises
Raise CORPUS_PINS in lib/corpus-pins.mjs to 39 / 777 in the same commit.
```

`npm run content:check` and `npm test` both raise that message. It was left stale three times
before this gate existed — 648, 669, and the `cdf6986` baseline in [MAX-47](/MAX/issues/MAX-47) —
and each time the person who noticed was reading a diff.

## Template

Copy [`content-issue-template.md`](./content-issue-template.md) into the issue description when
opening a content issue.
