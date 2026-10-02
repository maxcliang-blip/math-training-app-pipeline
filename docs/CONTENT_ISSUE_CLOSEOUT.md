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

### 3. Record the lesson ids in the close-out comment

This is the required line. Put it in the comment that sets the issue to `done`:

```
Delivered: m5-l2 (18 exercises)
```

One lesson id per lesson the issue delivered, comma-separated. If the issue was not a content
issue, or delivered nothing, say so — `Delivered: none (docs only)` is a valid answer and a
missing line is not. A close-out that names nothing has proved nothing.

### 4. Run the delivery check against `main`

```bash
npm run content:delivered -- m5-l2
```

It reads `origin/main`'s tree, resolves each id against the lesson records the tree holds, and
exits non-zero for any id that is not there. Copy the output into the close-out comment.

```
verify-delivery: DELIVERED  (ref origin/main)
  36 lesson files hold 36 lesson records
  ok    m5-l2  (content/lessons/m5-l2.json)
```

For comparison, the same command while `m5-l2` was genuinely absent — which is what MAX-23 looked
like, four weeks of it:

```
verify-delivery: NOT DELIVERED  (ref origin/main)
  35 lesson files hold 35 lesson records
  MISS  m5-l2

  m5-l2 is not on origin/main.
  Either the work is not merged, or it was never written. Do not close the issue done.
```

Then close the issue. If the check fails, the issue is not done. Leave it `in_progress` and name
what is missing.

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

A file in `content/exercises/` is *either* one record or an array of them: 228 files hold 723
records at the current pin. Any gate that counts files undercounts the corpus by roughly two
thirds and passes anyway. `api/src/content.js` documents this at the loader, and
`lib/corpus-pins.mjs` documents it at the pin; read the loader's `readRecords()` before writing a
new check that counts anything.

## The corpus pin

Growing the corpus changes the counts in `lib/corpus-pins.mjs`, in the same commit as the content
that changed them:

```
corpus pins are stale: tests assert 36 lessons / 723 exercises,
content/ holds 37 lessons / 741 exercises
Raise CORPUS_PINS in lib/corpus-pins.mjs to 37 / 741 in the same commit.
```

`npm run content:check` and `npm test` both raise that message. It was left stale three times
before this gate existed — 648, 669, and the `cdf6986` baseline in [MAX-47](/MAX/issues/MAX-47) —
and each time the person who noticed was reading a diff.

## Template

Copy [`content-issue-template.md`](./content-issue-template.md) into the issue description when
opening a content issue.
