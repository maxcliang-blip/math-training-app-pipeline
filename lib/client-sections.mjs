// Which lesson exercise sections the web client reaches, declared once and checked from both ends.
//
// MAX-146. The API serves three exercise lists per lesson: practiceIds, masteryIds and solutionIds
// (api/src/content.js SECTION_ID_FIELDS). The client's only exercise fetch asks for practice. That
// left a corpus the client cannot see and no gate that could see it: `grep -rn mastery web/src` is
// empty, nothing in scripts/check-content-math.mjs looks at the client at all, and every count
// record in lib/corpus-pins.mjs passes. 114 exercises across all 38 lessons were authored, tagged,
// listed, served and unreachable from a browser, and MAX-70 and MAX-141 each recorded that fact on
// their way past it.
//
// Prose does not fix that. A sentence in a doc is read once and then contradicted by the source, and
// nothing notices. So the intent is a declaration here, and two checks read it:
//
//   1. Every section the API serves has a reach decision in this file. A new section added to
//      SECTION_ID_FIELDS without one is a build failure, which is the property that stops the
//      recurrence: you cannot add a client-invisible section again without answering this.
//   2. The client's own source agrees with the declaration. A section declared `served` must be
//      named in web/src, and a section declared `api-only` must not be. Adding the mastery surface
//      is allowed and is probably wanted one day -- it fails this check on purpose, because the
//      reach decision and the doc are then wrong and have to move with it.
//
// REACH values, and what each one asserts:
//
//   served        the client names this section, so a learner can reach the exercises through it
//   api-only      the API serves it and no client view asks for it; the reason is recorded below,
//                 and the check prints the count so nobody gets to it by subtraction
//   via-sibling   the client never names this section, but its ids are a subset of a `served`
//                 section's, so the records still arrive in the browser under that sibling's fetch.
//                 Asserted as a subset per lesson, not assumed: a corpus that gave a lesson a
//                 solution its practice list does not carry would fail here instead of quietly
//                 becoming a fourth unreachable set.
//
// The client scan is a name scan over the source text, not a JSX parse: web/src has no build step
// available to `node --test`, and web/test/latex.test.js records why the renderable logic is kept
// out of the component. What that costs is stated plainly rather than papered over -- the scan can
// be fooled by a computed property access, and every failure message below names the strings it
// looked for so a reader can check the answer by hand. It holds for the code that exists, and it
// fails loudly the day the code stops being greppable in this shape, which is the day this needs
// replacing with a real contract.

// The sections the API serves per lesson, in api/src/content.js SECTION_ID_FIELDS order. `section`
// is the corpus section name, `field` is what GET /api/lessons/:id calls it. The two are carried
// separately for the reason SECTION_ID_FIELDS documents: "solutions" does not strip to "solution",
// and a derived name makes the lookup miss while the lists beside it stay healthy.
export const CLIENT_REACH = [
  {
    section: "practice",
    field: "practiceIds",
    reach: "served",
    via: null,
    why: "web/src/App.jsx builds /api/exercises?ids= from sections.practice.exerciseIds. This is the client's only exercise fetch.",
  },
  {
    section: "mastery",
    field: "masteryIds",
    reach: "api-only",
    via: null,
    why:
      "Deliberate, settled on MAX-146. The reader is a reader: web/src makes no write call at all " +
      "(one GET fetch, no POST), so there is no attempt runner to record a result against " +
      "passThreshold: 2, and api/src/state.js only marks an attempt mastery when the request body " +
      "carries mode: \"mastery\". A mastery surface today would render three exercises per lesson " +
      "that no learner could answer and no progress record could reflect, which is worse than not " +
      "showing them. It ships with the runner, and the check below fails when either half moves.",
  },
  {
    section: "solutions",
    field: "solutionIds",
    reach: "via-sibling",
    via: "practice",
    why:
      "Never named by the client and not needed: on this corpus a lesson's solutionIds are exactly " +
      "its practiceIds (645 = 645, set-equal), so every solution record arrives inside the practice " +
      "fetch and App.jsx renders it from exercise.solutionLatex. Asserted as a subset per lesson " +
      "rather than trusted -- a lesson whose solutions drifted outside its practice list would fail " +
      "here instead of becoming a fourth unreachable set.",
  },
];

// The sections the API serves, as { section, field } pairs. Compared against api/src/content.js's
// own SECTION_ID_FIELDS by the gate, not by a second copy of it: this file says what reach each
// section has, content.js says which sections exist.
export function declaredSectionNames() {
  return CLIENT_REACH.map((d) => d.section);
}

export function sectionIdsIn(lesson, sectionName) {
  const sections = lesson && lesson.sections;
  const section = sections && sections[sectionName];
  if (!section || typeof section !== "object") return [];
  const ids = section.exerciseIds;
  return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
}

// Does this source read the section? Three spellings count, because a client can reach a lesson
// section three ways and the check should not depend on which one it picked:
//
//   sections.practice.exerciseIds     property path, including optional chaining
//   ["practice", "mastery"]            a name in a list, e.g. a loop over sections
//   { practiceIds } = lesson.sections  the route's field name, destructured
//
// The field-name form is deliberately restricted to a destructuring key or an object key. Matching
// the bare word instead is what the first version of this did, and it is a false positive waiting
// to happen: `const practiceIds = lesson.data?.sections?.practice?.exerciseIds` names practiceIds
// three times in a file that stops reading the practice section, so a scan that matched the word
// would keep reporting the section as served after the fetch was gone. A gate that cannot be
// observed failing is worse than no gate, because it reads as coverage.
//
// The property form accepts `?.` as well as `.`, which the first version also got wrong:
// App.jsx reads `sections?.practice?.exerciseIds`, and a regex requiring a bare dot before the name
// does not match `?.practice` -- so the gate reported the section unreached on the real corpus while
// the selftest's first version could not reproduce it. Both mistakes were found by the selftest
// asserting against the untouched repository, which is why that assertion is here and not merely
// implied.
export function mentionsSection(source, sectionName, fieldName) {
  const text = String(source);
  const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const name = escaped(sectionName);
  const field = escaped(fieldName);
  const asProperty = new RegExp(`(?:\\?\\.|\\.)\\s*${name}\\s*(?:\\?\\.|\\.|\\[|\\)|,|;|$)`, "m");
  const asString = new RegExp(`["'\`]\\s*${name}\\s*["'\`]`);
  const asKey = new RegExp(`[{,]\\s*${name}\\s*[:,}]`, "m");
  const asFieldKey = new RegExp(`[{,]\\s*${field}\\s*[:,}]`, "m");
  return (
    asProperty.test(text) || asString.test(text) || asKey.test(text) || asFieldKey.test(text)
  );
}

export function declarationsFor(apiSections) {
  const known = new Set(CLIENT_REACH.map((d) => d.section));
  return (apiSections || [])
    .filter((name) => !known.has(name))
    .map((name) => ({
      section: name,
      reach: "undeclared",
      why:
        `the API serves a "${name}" exercise list and lib/client-sections.mjs has no reach decision ` +
        `for it. Declare it served, api-only or via-sibling, with the reason, in the same commit. ` +
        `MAX-146 is what an undeclared section costs: 114 exercises reachable from nothing, and no ` +
        `gate able to say so.`,
    }));
}

// Client agreement. `sources` is [{ path, source }] for every file under web/src.
//
// Two failures and one subtlety. The first is a `served` section the client never names -- the
// declaration has drifted from the code. The second is a section the client names that is not
// declared `served`, which includes the case that matters: someone adds the mastery fetch. That is
// not forbidden, it is required to be recorded here and in the docs first, so the reach decision
// and the source move in one commit instead of one of them being discovered later.
export function checkClientAgreement(sources) {
  const problems = [];
  const declared = new Map(CLIENT_REACH.map((d) => [d.section, d]));
  const seen = new Set();

  for (const { path, source } of sources || []) {
    for (const d of CLIENT_REACH) {
      if (!mentionsSection(source, d.section, d.field)) continue;
      seen.add(d.section);
      if (d.reach !== "served") {
        problems.push(
          `${path} names the "${d.section}" exercise list, which is declared ${d.reach} in ` +
            `lib/client-sections.mjs.\n` +
            `  If that is the intent, change its reach to "served" and update docs/CONTENT_CONVENTIONS.md\n` +
            `  in the same commit, and say what the client now does with the answers.\n` +
            `  If it is not, the reference is a leftover.\n` +
            `  Declared reason: ${d.why}`,
        );
      }
    }
  }

  for (const d of CLIENT_REACH) {
    if (d.reach === "served" && !seen.has(d.section)) {
      problems.push(
        `no file under web/src names the "${d.section}" exercise list, which is declared served in ` +
          `lib/client-sections.mjs.\n` +
          `  The client no longer reaches it. Either the declaration is stale or a fetch was removed.`,
      );
    }
  }
  if (!sources || sources.length === 0) {
    problems.push("client reach could not be checked: no files under web/src were read");
  }
  return problems;
}

// Sibling coverage: for every lesson, a `via-sibling` section's ids must all appear in the section it
// rides along with. Checked against the corpus, per lesson, so the answer is a lesson id rather
// than a total somebody has to reconcile against a lesson count.
export function checkSiblingCoverage(lessons) {
  const problems = [];
  if (!Array.isArray(lessons) || lessons.length === 0) {
    return ["sibling coverage could not be checked: no lessons were reported"];
  }
  const byName = new Map(CLIENT_REACH.map((d) => [d.section, d]));
  for (const lesson of lessons) {
    for (const d of CLIENT_REACH) {
      if (d.reach !== "via-sibling") continue;
      const carrier = byName.get(d.via);
      if (!carrier || carrier.reach !== "served") {
        problems.push(
          `${d.section} rides along with "${d.via}", which is not a served section; ` +
            `declare the carrier before claiming coverage.`,
        );
        continue;
      }
      const carried = new Set(sectionIdsIn(lesson, carrier.section));
      for (const id of sectionIdsIn(lesson, d.section)) {
        if (!carried.has(id)) {
          problems.push(
            `lesson ${lesson.id} lists ${id} in ${d.field}, which its ${carrier.field} does not ` +
              `carry, so no client fetch can reach it.\n` +
              `  Add the id to ${lesson.id}'s ${carrier.section} list, or stop declaring ${d.section} ` +
              `as via-sibling and give it a reach of its own.`,
          );
        }
      }
    }
  }
  return problems;
}

// The counts, so the next person reads them instead of subtracting 759 - 645 by hand. This is the
// deliverable of the card: an answer in the repository rather than an arithmetic exercise.
export function reachReport(lessons) {
  const sections = new Map();
  for (const d of CLIENT_REACH) sections.set(d.section, { reach: d.reach, lessons: 0, ids: new Set() });
  for (const lesson of lessons || []) {
    for (const name of sections.keys()) {
      const ids = sectionIdsIn(lesson, name);
      if (ids.length === 0) continue;
      const row = sections.get(name);
      row.lessons += 1;
      for (const id of ids) row.ids.add(id);
    }
  }
  const report = {};
  for (const [name, row] of sections) report[name] = { reach: row.reach, lessons: row.lessons, ids: row.ids.size };
  return report;
}

// One call, so a caller cannot check half of this. Order is declaration order for readability and
// the union for the API-vs-declaration half, which is the one that has to run against the real
// SECTION_ID_FIELDS rather than a copy.
export function checkClientSurface({ apiSections, sources, lessons }) {
  const problems = [
    ...declarationsFor(apiSections).map((d) => d.why),
    ...checkClientAgreement(sources),
    ...checkSiblingCoverage(lessons),
  ];
  return { problems, report: reachReport(lessons) };
}

export function formatReport(report) {
  const rows = Object.entries(report || {});
  if (rows.length === 0) return "no sections reported";
  const width = Math.max(...rows.map(([name]) => name.length));
  return rows
    .map(([name, r]) => `${name.padEnd(width)}  ${String(r.ids).padStart(4)} ids in ${String(r.lessons).padStart(3)} lessons  ${r.reach}`)
    .join("\n");
}