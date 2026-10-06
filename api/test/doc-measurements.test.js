import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkDoc } from "../../scripts/check-doc-measurements.mjs";

// The numbers docs/CONTENT_CONVENTIONS.md states, asserted where `npm test` runs rather than only
// where a content gate does. MAX-149 is the second half of a pair: MAX-146 found that 114 mastery
// exercises were served and unreachable, and its lesson is that a finding recorded on an issue does
// not survive. The measurements in that doc were the same kind of record -- true when written,
// unverifiable afterwards, and going false in silence the first time an exercise was authored.
//
// The doc's block is the only copy of these numbers, and client-sections.test.js is the only copy of
// the reach report above. Two files stating one measurement is the defect being fixed here rather
// than committed, so this test reads the doc's claims back out of the block and compares them to the
// corpus, and fails with both numbers and the fix when they disagree. It is the same relationship
// scripts/check-doc-measurements.mjs enforces in CI; running it under `npm test` is what makes a
// stale doc a local failure and not only a CI one.
//
// What this does NOT do is re-measure. checkDoc reads the corpus through the loader in
// api/src/content.js and the client-sections report, so this file cannot hold a third count.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOC = join(REPO, "docs", "CONTENT_CONVENTIONS.md");

test("the measured claims in docs/CONTENT_CONVENTIONS.md are true of this corpus", () => {
  const { problems, measured, claims } = checkDoc();

  assert.ok(claims, "the doc's measured block could not be read, so nothing below is checked");
  assert.deepEqual(
    problems,
    [],
    `the doc's measured claims no longer match the corpus:\n${problems.join("\n\n")}\n` +
      `If the corpus is right, re-measure:  npm run docs:check -- --update`,
  );

  // The measurements themselves, named. This is the assertion a reader of the doc is relying on when
  // they cite "13 shared technique slugs" or "10 untagged exercises", and it is asserted as numbers
  // rather than left to whoever runs the gate to read off stdout.
  assert.deepEqual(
    {
      lessons: measured.lessons,
      exerciseRecords: measured.exerciseRecords,
      practice: measured.sectionIds.practice,
      mastery: measured.sectionIds.mastery,
      solutions: measured.sectionIds.solutions,
      distinctSlugs: measured.techniqueSlugs.distinct,
      sharedSlugs: measured.techniqueSlugs.sharedByMultipleLessons,
      untagged: measured.untaggedExercises.total,
      untaggedExplicitEmpty: measured.untaggedExercises.explicitEmptyArray,
      untaggedKeyOmitted: measured.untaggedExercises.keyOmitted,
    },
    {
      lessons: 38,
      exerciseRecords: 759,
      practice: 645,
      mastery: 114,
      solutions: 645,
      distinctSlugs: 338,
      sharedSlugs: 13,
      untagged: 10,
      untaggedExplicitEmpty: 3,
      untaggedKeyOmitted: 7,
    },
    "the corpus measurements moved; update this test and docs/CONTENT_CONVENTIONS.md's block together",
  );

  // The doc's block must hold the measured numbers, not merely be well-formed. A block that parses
  // but is empty would satisfy the check's own error path -- every claim reported as "not a
  // measurement" -- so this asserts the block is the transcript it claims to be.
  assert.equal(claims.lessons, measured.lessons);
  assert.equal(claims.exerciseRecords, measured.exerciseRecords);
  assert.deepEqual(claims.sectionIds, measured.sectionIds);
  assert.deepEqual(claims.techniqueSlugs, measured.techniqueSlugs);
  assert.deepEqual(claims.untaggedExercises, measured.untaggedExercises);
});

test("the doc's measured block is a single block, not two competing transcripts", () => {
  const markdown = readFileSync(DOC, "utf8");
  const opens = markdown.split("<!-- doc-measurements:begin -->").length - 1;
  const closes = markdown.split("<!-- doc-measurements:end -->").length - 1;

  // The doc's own rule is that a stale measurement is worse than a missing one "because the next
  // author cannot tell which is which". A second block is exactly that failure state, and the
  // extractor reads the first and ignores the rest -- so a duplicated block would be checked while
  // being wrong, and nothing else in the repository would notice.
  assert.equal(opens, 1, `docs/CONTENT_CONVENTIONS.md has ${opens} measured blocks; exactly one is checked, the rest drift silently`);
  assert.equal(closes, opens, `docs/CONTENT_CONVENTIONS.md has ${opens} begin markers and ${closes} end markers`);
});