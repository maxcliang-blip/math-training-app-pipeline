import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkClientSections } from "../../scripts/check-client-sections.mjs";

// The reader's exercise scope, asserted where `npm test` runs rather than only where a content gate
// does. MAX-146 recorded the gap three times on the way to closing it, and none of those closures
// failed: the corpus pins count records, the content gate counts sections, and nothing in either
// looks at web/src. So the assertion that the client's reach matches the corpus belongs next to the
// other tests a change has to pass.
//
// It is deliberately one test that runs the whole gate rather than four that poke at the pieces. The
// failure this guards against is a disagreement between three inputs -- the API's SECTION_ID_FIELDS,
// the client source, and the corpus -- and a disagreement is exactly what per-piece tests stop being
// able to see. The gate's own selftest (scripts/check-client-sections.mjs --selftest) is what proves
// each half can fail.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WEB_SRC = join(REPO, "web", "src");

test("every lesson exercise list the API serves has a declared client reach, and the client agrees", () => {
  const { problems, report } = checkClientSections();
  assert.deepEqual(problems, [], problems.join("\n\n"));

  // The counts, asserted as the answer to "what does the client reach" rather than left to be
  // worked out from the corpus total. 645 + 114 = 759 and the two sets are disjoint, so a learner
  // sees 645 of the corpus and the remaining 114 are the declared api-only set -- a fact to read
  // rather than 759 - 645 to compute.
  assert.deepEqual(
    report,
    {
      practice: { reach: "served", lessons: 38, ids: 645 },
      mastery: { reach: "api-only", lessons: 38, ids: 114 },
      solutions: { reach: "via-sibling", lessons: 38, ids: 645 },
    },
    `client reach report moved; update the numbers here and in lib/client-sections.mjs: ${JSON.stringify(report)}`,
  );

  // A pin on the reach decisions themselves, not only on the numbers: the numbers can hold while
  // someone flips mastery from api-only to served without changing a single exercise id, and that
  // flip is the decision this card made.
  assert.equal(report.mastery.reach, "api-only");
  assert.ok(report.mastery.ids > 0, "mastery is non-empty, which is what makes api-only a declaration rather than a shrug");
});

test("the reader still makes no write call, which is why mastery is declared api-only", () => {
  // The api-only decision rests on a fact about the client, not on taste: there is no attempt runner
  // to record an answer against passThreshold, and api/src/state.js only marks an attempt mastery
  // when the body carries mode: "mastery". A client that grew a POST would make the declaration
  // stale without changing a byte of the corpus, so the fact is asserted next to the declaration.
  const files = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(d, entry.name));
      else if (/\.(js|jsx)$/.test(entry.name)) files.push(join(d, entry.name));
    }
  };
  walk(WEB_SRC);

  const writers = files.filter((f) => /method:\s*["']POST["']|\.post\(/.test(readFileSync(f, "utf8")));
  assert.deepEqual(
    writers.map((f) => f.slice(REPO.length + 1)),
    [],
    "the client now writes to the API; re-decide the mastery reach in lib/client-sections.mjs and say what the runner records",
  );
});