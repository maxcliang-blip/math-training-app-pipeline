// The measurements docs/CONTENT_CONVENTIONS.md states about the corpus, as something re-measurable.
//
// MAX-149. The doc carries measured claims -- 38 lessons, 759 exercise records, 645 practice and
// 114 mastery ids, 338 technique slugs of which 13 are shared, 10 untagged exercises split 3/7 --
// and every one of them is a claim about `main` that goes false the moment the corpus moves. The
// doc says so itself ("A stale measurement is worse than a missing one, because the next author
// cannot tell which is which"), which is the argument for checking it and not a substitute for
// checking it. Nothing did, so the doc was free to drift on exactly the terms it warns about.
//
// The doc's own closing rule says a gate rule belongs in scripts/preflight-content.mjs, not in the
// doc. This is not that. preflight-content.mjs judges content against rules about content, and its
// fixtures are corpora that are wrong on purpose; a doc has no corpus. This is the other shape: a
// doc asserts a number, and the number is read back off the corpus it describes. Nothing here
// decides what the corpus should be -- that is still the authors' -- and nothing here fails a
// build for a corpus that is merely different from what the doc says. It fails because the doc and
// the corpus stopped agreeing, which is a documentation defect and is fixed by re-measuring.
//
// NOT prose parsing. The claims live in a fenced block between two markers, because a regex over
// the surrounding sentences is a measurement that fails silently: rewrite "13 are owned by more
// than one" as "thirteen" and the check passes on a doc it never read. A block is a contract this
// file can require, report a missing one for, and rewrite in place with --update.
//
// REUSED, NOT RE-DERIVED, wherever the repository already measures the same thing:
//   - the lesson and exercise counts come from the loader in api/src/content.js, the same loader
//     lib/corpus-pins.mjs is compared against, so this file cannot disagree with the corpus pin
//     about what the corpus holds (and the two are cross-checked below, so neither can be raised
//     without the other);
//   - the per-section id counts come from scripts/check-client-sections.mjs, which already
//     computes them and already proves the client reaches what it says it reaches (MAX-146);
//   - nothing here counts files. A file in content/exercises/ is one record or an array of them:
//     264 files hold 759 records, so a gate that counted files would report roughly a third of the
//     corpus and pass anyway. See lib/corpus-pins.mjs for the long version.

import { CORPUS_PINS } from "./corpus-pins.mjs";

export const BLOCK_BEGIN = "<!-- doc-measurements:begin -->";
export const BLOCK_END = "<!-- doc-measurements:end -->";

// The fence the claims are written in. A block with no fence is a block nobody can read back, so
// the extractor requires one rather than scanning for the first `{` and hoping.
const FENCE_LANG = "json";

// ---------------------------------------------------------------------------
// The claims, and where they come from
// ---------------------------------------------------------------------------

// Every claim in the doc, with the corpus reading that produces it. The order here is the order
// they appear in the doc and the order a drift report prints them in.
//
// A claim is a *count*. The doc also prints the ids and slugs behind two of the counts (the ten
// untagged exercises, the thirteen shared technique slugs); those tables are the content of the
// conventions rather than the claim under test, and they are re-derived and printed by --update so
// that re-measuring surfaces them. Asserting them here would mean parsing a markdown table in
// prose, which is the thing this file exists not to do.
export const CLAIMS = [
  { key: "lessons", measure: (m) => m.lessons, reads: "lesson records under content/lessons" },
  { key: "exerciseRecords", measure: (m) => m.exerciseRecords, reads: "exercise records under content/exercises" },
  { key: "sectionIds.practice", measure: (m) => m.sectionIds.practice, reads: "distinct practice ids across the corpus" },
  { key: "sectionIds.mastery", measure: (m) => m.sectionIds.mastery, reads: "distinct mastery ids across the corpus" },
  { key: "sectionIds.solutions", measure: (m) => m.sectionIds.solutions, reads: "distinct solutions ids across the corpus" },
  { key: "techniqueSlugs.distinct", measure: (m) => m.techniqueSlugs.distinct, reads: "distinct technique slugs defined by lessons" },
  { key: "techniqueSlugs.sharedByMultipleLessons", measure: (m) => m.techniqueSlugs.sharedByMultipleLessons, reads: "technique slugs defined by more than one lesson" },
  { key: "untaggedExercises.total", measure: (m) => m.untaggedExercises.total, reads: "exercise records naming no technique" },
  { key: "untaggedExercises.explicitEmptyArray", measure: (m) => m.untaggedExercises.explicitEmptyArray, reads: "records carrying techniqueSlugs: []" },
  { key: "untaggedExercises.keyOmitted", measure: (m) => m.untaggedExercises.keyOmitted, reads: "records omitting the techniqueSlugs key" },
];

// Read the corpus. `store` is the ContentStore from api/src/content.js and `clientReport` is the
// report from scripts/check-client-sections.mjs; both are passed in rather than imported so that
// this file has no opinion about where content lives on disk and the selftest can point it at a
// scratch copy.
//
// The section counts come from the client-sections report, not from a second walk of the lessons:
// one number for two consumers is how 645 and 645 drift into two different claims about the same
// set. That report counts *distinct* ids, which is the claim the doc makes ("645 practice ids
// across 38 lessons"), and the per-lesson walk below only supplies the shape assertions that no
// report carries.
export function measureCorpus({ store, clientReport }) {
  const lessons = [...store.lessons.values()];
  const exercises = [...store.exercises.values()];

  // One walk of the lessons for the claims the report does not carry. Authored sections first, then
  // whatever the lesson did not list, which is how the loader itself orders a lesson's exercises.
  const slugOwners = new Map();
  const sectionIds = new Map(["practice", "mastery", "solutions"].map((s) => [s, new Set()]));
  const sectionLessons = new Map(["practice", "mastery", "solutions"].map((s) => [s, new Set()]));
  const solutionsNotInPractice = [];

  for (const lesson of lessons) {
    // techniques is an { items: [...] } section, not an { exerciseIds: [...] } one. Both shapes are
    // walked separately on purpose: reading techniques as exerciseIds yields no slugs at all, and
    // "0 distinct technique slugs" would then match a doc claiming 0.
    for (const item of sectionItemsOf(lesson, "techniques")) {
      const slug = typeof item?.slug === "string" ? item.slug : null;
      if (!slug) continue;
      if (!slugOwners.has(slug)) slugOwners.set(slug, new Set());
      slugOwners.get(slug).add(lesson.id);
    }
    for (const name of ["practice", "mastery", "solutions"]) {
      const ids = sectionIdsOf(lesson, name);
      if (ids.length === 0) continue;
      sectionLessons.get(name).add(lesson.id);
      for (const id of ids) sectionIds.get(name).add(id);
    }
    // Per-lesson, from this lesson's own lists -- not from the accumulated corpus-wide set, which
    // by this point holds every lesson's solutions and would report every id as an outsider.
    const practice = new Set(sectionIdsOf(lesson, "practice"));
    for (const id of sectionIdsOf(lesson, "solutions")) {
      if (!practice.has(id)) solutionsNotInPractice.push(`${lesson.id}: ${id}`);
    }
  }

  let untaggedTotal = 0;
  let explicitEmptyArray = 0;
  let keyOmitted = 0;
  for (const record of exercises) {
    // The gate reads `ex.techniqueSlugs || []`, so an omitted key and an empty list are the same
    // claim to it; the doc counts them separately because it recommends one over the other. Read
    // them the way the doc distinguishes them, not the way the gate collapses them.
    const named = Array.isArray(record.techniqueSlugs) ? record.techniqueSlugs : [];
    if (named.length > 0) continue;
    untaggedTotal += 1;
    if (Array.isArray(record.techniqueSlugs)) explicitEmptyArray += 1;
    else keyOmitted += 1;
  }

  return {
    lessons: lessons.length,
    exerciseRecords: exercises.length,
    sectionIds: {
      practice: clientReport.practice.ids,
      mastery: clientReport.mastery.ids,
      solutions: clientReport.solutions.ids,
    },
    techniqueSlugs: {
      distinct: slugOwners.size,
      sharedByMultipleLessons: [...slugOwners.values()].filter((owners) => owners.size > 1).length,
    },
    untaggedExercises: { total: untaggedTotal, explicitEmptyArray, keyOmitted },
    // Not claims. Relations between the claims above, asserted every run because a number in a doc
    // can be edited to agree with anything, while a relation can only agree with something true.
    relations: {
      // Counted as the intersection rather than as either side's exclusive remainder: the claim is
      // about ids in *both* lists, and deriving that as |practice| - |practice only mastery| is
      // what makes the finding name the overlap instead of a per-side count that reads as a total.
      // (It also does not invert: `countOnlyIn(a, b)` counts a's remainder, so reading it as the
      // overlap reports every id in the corpus as a collision and fails on a clean tree.)
      sharedIds: intersectionSize(sectionIds.get("practice"), sectionIds.get("mastery")),
      sectionUnion: unionSize(sectionIds),
      sectionLessons: Object.fromEntries([...sectionLessons].map(([k, v]) => [k, v.size])),
      solutionsOutsidePractice: solutionsNotInPractice.sort(),
      // The two tables the doc prints, re-derived. Not asserted; printed so a re-measure shows them.
      sharedSlugLessons: [...slugOwners]
        .filter(([, owners]) => owners.size > 1)
        .map(([slug, owners]) => [slug, [...owners].sort()])
        .sort(([a], [b]) => a.localeCompare(b)),
      untaggedExerciseIds: exercises
        .filter((r) => !Array.isArray(r.techniqueSlugs) || r.techniqueSlugs.length === 0)
        .map((r) => r.id)
        .sort(),
    },
  };
}

function sectionIdsOf(lesson, section) {
  const ids = lesson?.sections?.[section]?.exerciseIds;
  return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
}

function sectionItemsOf(lesson, section) {
  const items = lesson?.sections?.[section]?.items;
  return Array.isArray(items) ? items : [];
}

function intersectionSize(a, b) {
  let n = 0;
  for (const id of a) if (b.has(id)) n += 1;
  return n;
}

function unionSize(maps) {
  const all = new Set();
  for (const ids of maps.values()) for (const id of ids) all.add(id);
  return all.size;
}

// ---------------------------------------------------------------------------
// The block
// ---------------------------------------------------------------------------

// Claims as a nested object, in the shape the doc writes them. Built from CLAIMS so the block's
// shape and the set of claims cannot drift apart: a claim added here appears in the doc's block and
// in every drift report, and a claim that only exists in the doc is reported as unreadable.
export function emptyClaims() {
  return {
    lessons: null,
    exerciseRecords: null,
    sectionIds: { practice: null, mastery: null, solutions: null },
    techniqueSlugs: { distinct: null, sharedByMultipleLessons: null },
    untaggedExercises: { total: null, explicitEmptyArray: null, keyOmitted: null },
  };
}

// The measured corpus as claims, for --update.
export function claimsFromMeasurement(measured) {
  const out = emptyClaims();
  for (const claim of CLAIMS) {
    const parts = claim.key.split(".");
    let target = out;
    for (const part of parts.slice(0, -1)) target = target[part];
    target[parts[parts.length - 1]] = claim.measure(measured);
  }
  return out;
}

export function readClaim(claims, key) {
  return key.split(".").reduce((node, part) => (node == null ? undefined : node[part]), claims);
}

export function renderBlock(claims) {
  return `${BLOCK_BEGIN}\n` +
    "<!--\n" +
    "  Machine-checked by `npm run docs:check`, which re-measures the corpus and fails when a number\n" +
    "  here disagrees with it. Refresh with `npm run docs:check -- --update`, which rewrites the\n" +
    "  numbers below from the corpus and prints the id tables behind them.\n" +
    "\n" +
    "  Do not hand-edit a number to make the check pass. The corpus is the claim; this block is a\n" +
    "  transcript of it, and the two are supposed to be the same thing.\n" +
    "-->\n" +
    "```" + FENCE_LANG + "\n" +
    JSON.stringify(claims, null, 2) + "\n" +
    "```\n" +
    `${BLOCK_END}\n`;
}

// Pull the claims out of the markdown. Returns { ok: true, claims, start, end } on success, or
// { ok: false, reason } with a reason an author can act on. Every failure is a failure rather than
// an empty claim set: a doc with no readable block is not a doc whose numbers are correct, and
// reporting "no claims" as a pass is how a check becomes decorative.
export function readMeasuredBlock(markdown, { docPath = "docs/CONTENT_CONVENTIONS.md" } = {}) {
  if (typeof markdown !== "string" || markdown.length === 0) {
    return { ok: false, reason: `${docPath} is empty or unreadable, so its measurements cannot be checked` };
  }
  const begin = markdown.indexOf(BLOCK_BEGIN);
  if (begin === -1) {
    return {
      ok: false,
      reason: `${docPath} has no ${BLOCK_BEGIN} marker.\n` +
        `  Every measured claim in it is currently unfalsifiable. Add the block:\n` +
        `    npm run docs:check -- --init`,
    };
  }
  const end = markdown.indexOf(BLOCK_END, begin + BLOCK_BEGIN.length);
  if (end === -1) {
    return { ok: false, reason: `${docPath} opens the measured block at ${BLOCK_BEGIN} and never closes it with ${BLOCK_END}` };
  }
  const inner = markdown.slice(begin, end);
  const fence = new RegExp("```" + FENCE_LANG + "\\r?\\n([\\s\\S]*?)\\r?\\n```", "");
  const fenced = inner.match(fence);
  if (!fenced) {
    return {
      ok: false,
      reason: `${docPath}'s measured block has no ` + "```" + FENCE_LANG + ` fence.\n` +
        `  The claims have to live in a fenced ${FENCE_LANG} block for this to read them back; a prose list cannot be rewritten in place.`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(fenced[1]);
  } catch (error) {
    return { ok: false, reason: `${docPath}'s measured block is not valid JSON: ${error.message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: `${docPath}'s measured block parses to ${describe(parsed)}, not an object of claims` };
  }
  return { ok: true, claims: parsed, start: begin, end: end + BLOCK_END.length };
}

function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

// The failure message is the deliverable, not decoration. Name the claim, both numbers, and where
// the fix is -- `669 == 648` was the whole of what MAX-52 left behind and it names neither the
// corpus nor the author of the drift.
export function driftMessage(claim, claimed, measured) {
  return (
    `${claim.key} is stale: docs/CONTENT_CONVENTIONS.md claims ${format(claimed)}, ` +
    `the corpus holds ${format(measured)} (${claim.reads}).\n` +
    `  If the corpus is right, re-measure the doc:  npm run docs:check -- --update\n` +
    `  If the doc is right, the corpus moved without it and the claim above needs a decision on the issue that moved it.`
  );
}

function format(value) {
  return typeof value === "number" ? String(value) : `${JSON.stringify(value)}`;
}



// observed: { claims, measured } as returned by measureCorpus and readMeasuredBlock.
// `pins` is lib/corpus-pins.mjs's CORPUS_PINS. Nothing here recounts anything: every number is the
// loader's or the client-sections report's, so this file cannot pass while disagreeing with either.
export function checkDocMeasurements({ claims, measured, docPath = "docs/CONTENT_CONVENTIONS.md" }) {
  const problems = [];

  // 1. Every claim in the doc's block must be a number this file knows how to measure. A claim here
  //    that is not in CLAIMS is a claim no run will ever check, which is the failure this whole
  //    change exists to end -- so it is an error rather than an ignored key.
  for (const claim of CLAIMS) {
    const value = readClaim(claims, claim.key);
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      problems.push(
        `${claim.key} is not a measurement: docs/CONTENT_CONVENTIONS.md has ${format(value)} where an integer count belongs.\n` +
          `  ${format(claim.measure(measured))} is what the corpus holds. Refresh with:  npm run docs:check -- --update`,
      );
    }
  }

  // 2. And the other way round: a number in the block that nothing checks is a number that goes
  //    stale silently, which is the shape of the problem this gate was written for.
  for (const key of claimKeysIn(claims)) {
    if (!CLAIMS.some((c) => c.key === key)) {
      problems.push(
        `${key} is in docs/CONTENT_CONVENTIONS.md's measured block but nothing here measures it,\n` +
          `  so it will go stale exactly the way the numbers beside it used to. Either add it to CLAIMS in\n` +
          `  lib/doc-measurements.mjs with the corpus reading that produces it, or take it out of the block.`,
      );
    }
  }

  // 3. Compare. Only where both sides are usable, so one unreadable claim does not produce a second
  //    finding saying the same number is also wrong.
  for (const claim of CLAIMS) {
    const claimed = readClaim(claims, claim.key);
    if (typeof claimed !== "number" || !Number.isInteger(claimed)) continue;
    const actual = claim.measure(measured);
    if (claimed !== actual) problems.push(driftMessage(claim, claimed, actual));
  }

  // 4. The doc and lib/corpus-pins.mjs both state the lesson and exercise counts. Two copies of one
  //    number, and until this existed neither could catch the other: content:check compares the pin
  //    to the corpus and says nothing about the doc. Assert both against the corpus, and assert
  //    them against each other, so the pin and the doc move in the same commit or the build is red.
  if (CORPUS_PINS.lessons !== measured.lessons || CORPUS_PINS.exercises !== measured.exerciseRecords) {
    problems.push(
      `the corpus pins in lib/corpus-pins.mjs are themselves stale: pinned ${CORPUS_PINS.lessons} lessons / ` +
        `${CORPUS_PINS.exercises} exercises, corpus holds ${measured.lessons} / ${measured.exerciseRecords}.\n` +
        `  That is CORPUS_PINS's own failure (content:check reports it too); raising it is not this gate's to do.`,
    );
  } else if (
    typeof readClaim(claims, "lessons") === "number" &&
    typeof readClaim(claims, "exerciseRecords") === "number"
  ) {
    const pinned = { lessons: CORPUS_PINS.lessons, exerciseRecords: CORPUS_PINS.exercises };
    for (const key of ["lessons", "exerciseRecords"]) {
      const claimed = readClaim(claims, key);
      if (claimed !== readClaim(pinned, key)) {
        problems.push(
          `${key} disagrees with the corpus pin: docs/CONTENT_CONVENTIONS.md claims ${format(claimed)}, ` +
            `lib/corpus-pins.mjs pins ${format(readClaim(pinned, key))}, and the corpus holds ${measured[key === "lessons" ? "lessons" : "exerciseRecords"]}.\n` +
            `  Two files state one number. Raise them in the same commit:  npm run docs:check -- --update`,
        );
      }
    }
  }

  // 5. The relations. These are what stop the numbers being satisfied by a coincidence: every count
  //    above can be edited to any value, but "practice and mastery are disjoint and together are
  //    the whole corpus" is either true of this corpus or it is not.
  const r = measured.relations;
  if (r.sharedIds > 0) {
    problems.push(
      `practice and mastery are not disjoint: ${r.sharedIds} id(s) appear in both lists.\n` +
        `  docs/CONTENT_CONVENTIONS.md convention 4 states they are disjoint and that 645 + 114 is the whole corpus.\n` +
        `  An exercise in both lists is served twice and counted twice, which is the claim going false behind the claim.`,
    );
  }
  if (r.sectionUnion !== measured.exerciseRecords) {
    problems.push(
      `the practice and mastery lists do not cover the corpus: they name ${r.sectionUnion} distinct ids ` +
        `across ${measured.exerciseRecords} exercise records.\n` +
        `  docs/CONTENT_CONVENTIONS.md convention 4 states the two sets are disjoint and sum to the whole corpus.`,
    );
  }
  for (const name of ["practice", "mastery", "solutions"]) {
    if (r.sectionLessons[name] !== measured.lessons) {
      problems.push(
        `the ${name} list spans ${r.sectionLessons[name]} of ${measured.lessons} lessons.\n` +
          `  docs/CONTENT_CONVENTIONS.md states each list runs "across 38 lessons"; a lesson with an empty ${name} list is a gap in that sentence.`,
      );
    }
  }
  if (r.solutionsOutsidePractice.length > 0) {
    problems.push(
      `${r.solutionsOutsidePractice.length} solutions id(s) are outside their lesson's practice list ` +
        `(${r.solutionsOutsidePractice.slice(0, 5).join(", ")}${r.solutionsOutsidePractice.length > 5 ? ", ..." : ""}).\n` +
        `  docs/CONTENT_CONVENTIONS.md convention 4 states the solutions set is identical to the practice set.\n` +
        `  client:check reports this per lesson too; it is asserted here so the sentence cannot outlive the fact.`,
    );
  }

  return problems;
}

// Every dotted key present in a claims object, so an unexpected one can be named rather than
// silently carried.
function claimKeysIn(claims, prefix = "") {
  const keys = [];
  if (claims === null || typeof claims !== "object" || Array.isArray(claims)) return keys;
  for (const [name, value] of Object.entries(claims)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...claimKeysIn(value, key));
    } else {
      keys.push(key);
    }
  }
  return keys;
}

// The tables the doc prints beside two of its counts. Printed by --update so that re-measuring
// surfaces the ids and slugs too, without this file parsing a markdown table to police them.
export function formatTables(measured) {
  const r = measured.relations;
  const lines = [];
  lines.push("");
  lines.push("technique slugs defined by more than one lesson");
  lines.push("--------------------------------------------------");
  for (const [slug, lessons] of r.sharedSlugLessons) lines.push(`  ${slug}  ${lessons.join(", ")}`);
  lines.push("");
  lines.push("exercise records naming no technique");
  lines.push("------------------------------------");
  for (const id of r.untaggedExerciseIds) lines.push(`  ${id}`);
  lines.push("");
  return lines.join("\n");
}