# Content conventions no gate enforces

Every rule in `scripts/preflight-content.mjs` fails a build. That is what makes them trustworthy,
and it is also the limit of what they can tell you: a rule that fails a build gets obeyed, so
conventions that nobody enforces are the ones that drift, and they drift one author at a time.

This file is the other kind of rule — the ones a gate cannot check, written down so that the next
author does not resolve them again from scratch, and does not resolve them differently from the last
one. Each entry states what the convention is, what the gate *does* enforce (so the two are not
confused), and what the corpus measured on `origin/main` at the time of writing.

Settled on [MAX-70](/MAX/issues/MAX-70), 2026-10-05. Measurements below are from `origin/main`
`5153ae5`: 38 lessons, 759 exercise records. Re-measured at `ae40c51` (the SHA this branch merges
onto) and unchanged — `content/**` has not moved since, so every number below still holds.

Rule references below name the rule code, not a line number. A line number was in the first draft and
it went stale within one commit, because `preflight-content.mjs` gains lines faster than a doc on it
gets edited. Search the code.

---

## 1. A technique slug may be owned by more than one lesson

**The convention.** Two lessons may ship a technique card under the same slug. It is not a
duplicate to be cleaned up and not a collision to be resolved by renaming one of them.

**What the gate enforces.** `S3.4-deep-link` in `scripts/preflight-content.mjs` resolves every
`techniqueSlugs` entry against the anchors of **the exercise's own lesson**. That is the rule:
an exercise may only name a card its own page defines. Nothing anywhere checks that a slug belongs
to exactly one lesson, and adding such a check would be wrong — it would forbid the case below.

**Measured.** 338 distinct technique slugs across 38 lessons; **13 are owned by more than one**:

| slug | lessons |
| --- | --- |
| `complementary-count` | m3-l1, m3-l2, m7-l1, m7-l2 |
| `factorial-counting` | m3-l1, m7-l1 |
| `triangle-angle-sum` | m5-l1, m5-l2 |
| `similarity-aa` | m5-l2, m5-l3 |
| `area-scaling-from-scale` | m5-l2, m5-l4 |
| `sector-area-formula`, `radius-times-angle` | m5-l4, m8-l1 |
| `heron-area` | m5-l4, m8-l3 |
| `pythagorean-recovery`, `cofunction-substitution` | m8-l1, m8-l2 |
| `identity-selection` | m8-l2, m8-l3 |
| `negate-the-claim` | m9-l1, m9-l2 |
| `both-directions-of-biconditional` | m9-l1, m9-l4 |

Two shapes are already in use and both are intended. **Reuse at a different depth**: the same idea
taught twice, once as a first look and once where it pays off — `factorial-counting` in M3's
counting lesson and again in M7's, `triangle-angle-sum` in M5-L1 and M5-L2. **Reuse across
modules**: `complementary-count` in four lessons of two modules.

**How to decide a new one.** Ask whether a learner on the second page benefits from a card, not
whether the first page already has one. If the second page's exercises deep-link into it and the
first page's do not, it is a card the first page has no use for, and the two pages are not
duplicating each other. Reuse the slug so the technique is one thing with two homes.

**Where this came from.** `f6e72d8` ("Trim m7-l2 to the techniques it teaches") removed four cards
from `m7-l2` on the grounds that the following lessons develop those ideas properly, and in the
same commit kept `complementary-count` with the note that the repeat *"is legitimate: the same
concept taught twice at different depth."* One commit, one message, two readings of the same
convention. It was a judgement call that was never written down, which is why it read as a rule
for weeks afterwards.

---

## 2. A lesson's technique list covers that lesson's own practice; prose may preview a later lesson

**The convention.** A technique card exists so the exercises on that page can deep-link into it.
The list is therefore scoped to the lesson that ships it. A concept section may *introduce* an idea
in prose — define it, work one example — that a later lesson formalises with cards, and that is
not a gap. The prose owes the reader a definition; it does not owe them a card.

**Why it is worth stating.** `m7-l2` still teaches all four trimmed ideas in its concept section —
`$\mathbb{E}[X] = \sum_x x \cdot P(X = x)$`, linearity with the no-independence-hypothesis point
made explicitly, indicator variables worked twice — and its title and `expected-value` tag still
name expectation, while its card list does not. Every surface except the card list says L2 teaches
this. Read cold, that looks like a defect in the trim; it is the convention, applied. The trim
stands.

**What the gate enforces.** `S3.4-deep-link` and nothing else. There is no check that a card's
subject appears in the concept section, nor that the concept section's subjects all have cards.
Both directions are open on purpose.

---

## 3. An untagged exercise is honest; an invented tag is not

**The convention.** When no technique on the lesson's page is load-bearing in an exercise's
solution, `techniqueSlugs: []` is the correct value. Do not tag it with the nearest-looking slug to
satisfy a gate — no gate here asks for a non-empty list, so a tag added for that reason is a
fabrication with no reader to serve.

**Measured.** **10 of 759** exercise records name no technique, in two shapes the gate treats
identically because it reads `ex.techniqueSlugs || []`:

| shape | count | ids |
| --- | --- | --- |
| `techniqueSlugs: []` | 3 | `m7-l2-p15`, `p16`, `p19` |
| key omitted entirely | 7 | `m3-l2-p6`, `p10`, `p11`, `p12`, `m1`, `m2`, `m3` |

Both shapes are the same claim — there is no card on this page that the solution leans on. All ten
carry substantive `tags` (the `m7-l2` three carry `expected-value` and `random-variables`), so they
are still findable by search and they still appear in the lesson's practice and mastery lists. An
untagged exercise is reachable; it is just not deep-linkable to a technique, because there is no
technique to link to. Prefer the explicit `[]` over the omitted key — an absent key reads as an
oversight, and the next author cannot tell it from one.

**Where this came from.** `f6e72d8` retagged thirteen `m7-l2` exercises off the four removed cards
and left `p15`, `p16`, `p19` empty, recording that *"no technique m7-l2 teaches is load-bearing in
these three solutions."* Each of the three is an `expected-value-setup` drill in which every
probability is given in the prompt. That reasoning — retag to what the solution actually uses, and
leave it empty when nothing is — is the convention.

---

## 4. A lesson's mastery exercises are served and unreachable until there is a runner

**The convention.** `mastery.exerciseIds` is authored, tagged and served, and the web client does not
fetch it. That is the intended state of a reader, not a defect to fix by adding a fetch. When the
attempt runner lands, the client gains the mastery surface in the same commit that gains the runner.

**What the gate enforces.** `scripts/check-client-sections.mjs` reads three inputs — the API's
`SECTION_ID_FIELDS` (`api/src/content.js`), every `.js`/`.jsx` file under `web/src`, and the corpus —
and fails when they disagree. Specifically:

- a section the API serves with no reach decision in `lib/client-sections.mjs` is an error, so a
  fourth list cannot be added without answering what a client can reach;
- a section declared `served` that the client no longer names is an error;
- a section the client names that is not declared `served` is an error, which is what makes adding
  the mastery fetch a deliberate act rather than a quiet one;
- a `via-sibling` section must have every id carried by its `served` sibling, per lesson.

`npm run client:selftest` proves each of those can fail. `api/test/client-sections.test.js` runs the
same gate under `npm test`, so the disagreement is a local failure and not only a CI one.

**Measured** on `origin/main` `fe13feb`, re-measured for this entry: **645 practice** ids across 38
lessons, served and fetched; **114 mastery** ids across 38 lessons, served and not fetched; **645
solutions** ids, never named by the client and identical to the practice set, so their records arrive
inside the practice fetch. The sets are disjoint: 645 + 114 = 759, the whole corpus. Read those
numbers here or run `npm run client:check`; do not subtract 759 − 645 to recover them.

**Where this came from.** `7555756` was measured by [MAX-141](/MAX/issues/MAX-141), which recorded the
`masteryIds` gap and closed without taking it; [MAX-70](/MAX/issues/MAX-70) had recorded the same gap
earlier. [MAX-146](/MAX/issues/MAX-146) settled the intent and shipped the gate. The decision rests on
a fact about the client rather than on taste: `web/src` makes no write call at all, so there is no
attempt runner to record an answer against `passThreshold: 2`, and `api/src/state.js` only sets
`attempt.mastery` when the request body carries `mode: "mastery"`. Rendering three exercises per
lesson that no learner can answer would be worse than not rendering them.

---

## Changing a convention here

A convention is not edited because it is inconvenient. It is changed by:

1. **Measuring the corpus first.** Every number above was read off `origin/main`, not remembered.
   Re-measure before arguing; the corpus moves under these claims.
2. **Recording the decision on the issue that raised it**, with the branch or commit that produced
   the evidence, so the ruling has a provenance and not just a date.
3. **Replacing the measured block above**, not appending a second one. A stale measurement is worse
   than a missing one, because the next author cannot tell which is which.

If a convention here ever starts wanting to fail a build, that is a gate rule, and it belongs in
`scripts/preflight-content.mjs` with a fixture donor in `content/fixtures/` and a line in
`--selftest` — not in this file. `S8-*` codes are append-only.