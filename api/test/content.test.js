import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContentStore, loadContentStore, loadModuleMeta, toExerciseResponse, toLessonResponse, DEFAULT_CONTENT_ROOT } from "../src/content.js";
import { FIGURE_PAYLOAD_FIELDS, FIGURE_REFERENCE_FIELDS } from "../../lib/figure-contract.mjs";

// The store is what every route answers from, so these tests are about the corpus as it will be
// served: the shape a client sees, and the two things that are load-bearing about it - that the
// whole corpus is actually loaded, and that figure payloads do not ride along on content routes.

const store = loadContentStore();

test("every lesson and every exercise in the repository is loaded", () => {
  // Both file shapes exist in the corpus - 42 single-record files and 24 arrays. A loader that
  // assumes one of them silently serves about a third of the exercises, and the only symptom is
  // a 404 on an exercise the board can see listed. Pin the count so the drop cannot come back.
  //
  // Raising a pinned count is part of adding exercises. 669 is the count cc48b1a left behind:
  // it topped m1-l1, m5-l1 and m9-l3 up to 15 practice exercises each and the pin still said 648,
  // so main went red on three tests that have nothing to do with content authoring. The pin is
  // worth keeping -- a loader that drops exercises is invisible otherwise -- but it is only worth
  // something if the person who grows the corpus moves it in the same commit.
  const stats = store.stats();
  assert.equal(stats.lessons, 35);
  assert.equal(stats.exercises, 705);
  assert.ok(stats.modules >= 8, `expected at least the eight authored modules, got ${stats.modules}`);
});

test("a lesson route reports ids for practice, mastery and solutions, and the prose sections survive", () => {
  const lesson = store.getLesson("m1-l2");
  assert.equal(lesson.id, "m1-l2");
  assert.equal(lesson.moduleId, "M1");
  assert.ok(Array.isArray(lesson.sections.practiceIds));
  assert.ok(lesson.sections.practiceIds.length > 0);
  assert.ok(Array.isArray(lesson.sections.masteryIds));
  // Length, not just Array.isArray: "solutions" does not strip to "solution", so a derived
  // section name made this list empty on every lesson while the two beside it stayed healthy.
  assert.ok(lesson.sections.solutionIds.length > 0, "lesson route reports no solutions");
  for (const id of lesson.sections.solutionIds) {
    const ex = store.exercises.get(id);
    assert.ok(ex, `solution ${id} does not resolve`);
    assert.equal(ex.lessonId, lesson.id, `solution ${id} belongs to ${ex.lessonId}`);
  }
  // The pass threshold drives "Mastery check passed" in lesson spec S4, so it must not be lost
  // by flattening the section into an id list.
  assert.equal(typeof lesson.sections.mastery.passThreshold, "number");
  // Prose sections stay prose.
  assert.ok(lesson.sections.concept.conceptLatex.length > 0);
  assert.ok(Array.isArray(lesson.sections.techniques.items));
  assert.ok(Array.isArray(lesson.sections.pitfalls.items));
});

test("every exercise id a lesson lists resolves, and the ones that would not are reported", () => {
  for (const lesson of store.lessons.values()) {
    for (const field of ["practiceIds", "masteryIds", "solutionIds"]) {
      for (const id of store.getLesson(lesson.id).sections[field]) {
        assert.ok(store.exercises.has(id), `lesson ${lesson.id} ${field} names ${id}, which no file defines`);
      }
    }
  }
  // Nothing currently dangles, so the only warning the corpus should produce is about the
  // missing module catalogue. If that stops being true, this test fails and says why.
  const dangling = store.warnings.filter((w) => /lists .*, which no exercise file defines/.test(w));
  assert.deepEqual(dangling, []);
});

test("a dangling reference is reported rather than silently dropped from the lesson", () => {
  // Built by hand, because the shipped corpus is clean and this path would otherwise be untested.
  const broken = new ContentStore({
    root: DEFAULT_CONTENT_ROOT,
    modules: [],
  });
  // A synthetic lesson whose practice list names an id that does not exist.
  const lesson = {
    id: "synthetic-l1",
    moduleId: "SX",
    order: 1,
    title: "synthetic",
    prerequisites: [],
    sections: { practice: { exerciseIds: ["does-not-exist"] }, mastery: { exerciseIds: [] } },
  };
  broken.lessons.set("synthetic-l1", lesson);
  broken.checkReferences();
  const response = toLessonResponse(broken, lesson);
  // The id is kept, so the client sees exactly what the content asked for.
  assert.deepEqual(response.sections.practiceIds, ["does-not-exist"]);
  assert.ok(broken.warnings.some((w) => w.includes("does-not-exist")));
});

test("an exercise carrying a figure exposes figureKey and none of the payload fields", () => {
  const response = store.getExercise("m6-l3-p6");
  assert.equal(response.figureKey, "m6-l3-p6");
  for (const field of FIGURE_PAYLOAD_FIELDS) {
    if (field === "figureKey") continue;
    assert.equal(field in response, false, `${field} must not appear on an exercise response`);
  }
  // The authored Asymptote source is a build input, not a learner-facing payload, and it is
  // several kilobytes per figure.
  assert.equal("asymptoteSource" in response, false);
});

test("an exercise with no figure carries no figure information at all", () => {
  const response = store.getExercise("m1-l2-p3");
  assert.equal("figureKey" in response, false);
  for (const field of FIGURE_PAYLOAD_FIELDS) assert.equal(field in response, false);
});

test("a lesson's figure lists become references, and the Asymptote source does not ship", () => {
  const lesson = store.getLesson("m1-l3");
  const figures = lesson.sections.concept.figures;
  assert.ok(figures.length > 0, "m1-l3 has a figure in its concept section");
  for (const ref of figures) {
    assert.deepEqual(Object.keys(ref), FIGURE_REFERENCE_FIELDS);
    assert.match(ref.figureKey, /^m1-l3\.sections\.concept\.figures\[\d+\]$/);
  }
  // The raw source is kilobytes of Asymptote per figure and belongs to the build.
  assert.equal(JSON.stringify(lesson).includes("size(299,241)"), false);
});

test("no Asymptote build input reaches any lesson, including inside worked examples", () => {
  // Worked examples carry figure fields of their own, and a figure in an example is the same kind
  // of figure as a figure in a section list. Walking every lesson rather than one hand-picked
  // record is the point: four lessons had a figure-bearing example and the projection used to miss
  // all four, because only `sections.*.figures` was reduced to references.
  const offenders = [];
  for (const lessonId of store.lessons.keys()) {
    const json = JSON.stringify(store.getLesson(lessonId));
    for (const field of ["asymptoteSource", "asymptoteAlt", "asymptoteAspectRatio"]) {
      if (json.includes(`"${field}"`)) offenders.push(`${lessonId}:${field}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("a figure-bearing worked example becomes a reference, and an example without one is untouched", () => {
  const lesson = store.getLesson("m4-l2");
  const examples = lesson.sections.concept.examples;
  const withFigure = examples.find((e) => "figureKey" in e);
  assert.ok(withFigure, "m4-l2 has a worked example with a figure");
  assert.deepEqual(Object.keys(withFigure).filter((k) => k === "figureKey"), ["figureKey"]);
  assert.match(withFigure.figureKey, /^m4-l2\.sections\.concept\.examples\[\d+\]$/);
  // The prose of the example survives the projection; only the figure fields are dropped.
  assert.ok(withFigure.titleLatex);
  assert.ok(withFigure.bodyLatex);
  const withoutFigure = examples.find((e) => !("figureKey" in e));
  assert.equal("asymptoteSource" in withoutFigure, false);
});

test("a free-response exercise withholds its key; a multiple-choice exercise ships it", () => {
  // §3.3: "v1 ships the answer for MC, withholds it for free-response."
  const free = store.getExercise("m1-l2-p3");
  assert.equal(free.mode, "free-response");
  assert.equal(free.answerWithheld, true);
  assert.equal("answerLatex" in free, false);

  const choice = store.getExercise("m1-l2-p1");
  assert.equal(choice.mode, "choice");
  assert.equal(choice.answerLatex, "64");
  assert.equal("answerWithheld" in choice, false);
});

test("a free-response exercise withholds its worked solution too", () => {
  // The solution is the answer written out, so withholding the key while shipping the derivation
  // withholds nothing. It also made the solution route's three-attempt lock decorative: the client
  // already had the text the lock exists to protect.
  const free = store.getExercise("m1-l2-p3");
  assert.equal(free.solutionWithheld, true);
  assert.equal("solutionLatex" in free, false);
  assert.equal("solutionWithheld" in store.getExercise("m1-l2-p1"), false);
  // Multiple choice keeps its solution; only the free-response key is secret in v1.
  assert.ok(store.getExercise("m1-l2-p1").solutionLatex);
});

test("raw LaTeX in, raw LaTeX out - the exercise route never pre-renders", () => {
  const response = store.getExercise("m1-l2-p1");
  assert.equal(response.promptLatex, "Simplify the expression $\\left(2^{3}\\right)^{2}$ into a single value.");
  for (const key of Object.keys(response)) {
    const value = response[key];
    if (typeof value === "string") assert.equal(value.includes("<span"), false, `${key} looks pre-rendered`);
  }
});

test("GET /api/modules has the shape IA §7 specifies, catalogue or no catalogue", () => {
  const { modules, missingTitle } = store.listModules();
  assert.ok(modules.length >= 8);
  const m1 = modules.find((m) => m.code === "M1");
  assert.equal(m1.id, "M1");
  assert.equal(typeof m1.order, "number");
  assert.equal(typeof m1.lessonCount, "number");
  assert.equal(typeof m1.exerciseCount, "number");
  assert.ok(Array.isArray(m1.tiers));

  // Title resolution depends on whether content/modules.json exists, which is a content
  // decision landing independently of this branch. Both outcomes are asserted, and neither one
  // is a failure: a title is either resolved from the catalogue or reported as missing, and
  // missingTitle lists exactly the ones that are not resolved.
  const { present } = loadModuleMeta(DEFAULT_CONTENT_ROOT);
  if (present) {
    assert.equal(typeof m1.title, "string");
    assert.equal(m1.title.length > 0, true);
    assert.deepEqual(missingTitle, []);
  } else {
    // Without a catalogue a title is null rather than guessed from a lesson, because the
    // catalogue and the corpus can disagree about which module is which.
    assert.equal(m1.title, null);
    assert.ok(missingTitle.includes("M1"));
  }

  // Module order is numeric, so M2 sorts before M10 rather than after it.
  const codes = modules.map((m) => m.code);
  assert.deepEqual(codes, [...codes].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));

  // A module with no lessons yet still declares its tiers, and a tier badge that renders as
  // nothing is not something a test suite notices by itself. Every catalogue module reports the
  // tiers it declares, and `tiers` agrees with `declaredTiers` whenever the corpus is empty.
  for (const m of modules) {
    if (m.declaredTiers.length) {
      assert.ok(m.tiers.length > 0, `${m.code} reports no tiers at all`);
      if (m.lessonCount === 0) assert.deepEqual(m.tiers, m.declaredTiers, `${m.code} has no lessons, so its tiers are the declared ones`);
    }
  }
});

test("a batched exercise fetch is one call, capped, and reports ids it could not resolve", () => {
  const found = store.queryExercises({ ids: ["m1-l2-p1", "m1-l2-p2", "nope-1"] });
  assert.deepEqual(found.map((e) => e.id), ["m1-l2-p1", "m1-l2-p2"]);
  const byLesson = store.queryExercises({ lessonId: "m1-l2" });
  assert.ok(byLesson.length >= 15);
  assert.ok(byLesson.every((e) => e.lessonId === "m1-l2"));
});

test("every filter a query carries narrows the batch, not just lessonId and ids", () => {
  // These filters used to be built by the route and then dropped on the floor, so
  // `?moduleId=M3` answered with the whole corpus sorted by id - which looks like a result.
  const total = store.queryExercises({}).length;
  const byModule = store.queryExercises({ moduleId: "M1" });
  assert.ok(byModule.length > 0 && byModule.length < total, `moduleId returned ${byModule.length} of ${total}`);
  assert.equal(byModule.every((e) => e.moduleId === "M1"), true);

  const byTier = store.queryExercises({ moduleId: "M1", tiers: ["10"] });
  assert.ok(byTier.length < byModule.length);
  assert.equal(byTier.every((e) => e.moduleId === "M1" && String(e.tier) === "10"), true);

  const byTag = store.queryExercises({ tags: ["no-such-tag"] });
  assert.deepEqual(byTag, [], "a tag that matches nothing must answer empty, not everything");
  assert.deepEqual(store.queryExercises({ moduleId: "M99" }), []);

  // Filters compose with lessonId, and the lesson's own authored order is kept when it is the
  // only filter: a lesson page lists what the lesson said, in the order it said it.
  const lessonOnly = store.queryExercises({ lessonId: "m1-l2" });
  assert.deepEqual(lessonOnly, store.queryExercises({ ids: lessonOnly.map((e) => e.id) }));
  const lessonFiltered = store.queryExercises({ lessonId: "m1-l2", tiers: ["10"] });
  assert.equal(lessonFiltered.every((e) => e.lessonId === "m1-l2" && String(e.tier) === "10"), true);
  assert.ok(lessonFiltered.length > 0 && lessonFiltered.length <= lessonOnly.length);

  // Difficulty is a range, and it is the one filter that is order-sensitive.
  const easy = store.queryExercises({ difficultyMin: 1, difficultyMax: 2 });
  assert.equal(easy.every((e) => Number(e.difficulty) >= 1 && Number(e.difficulty) <= 2), true);
  assert.ok(easy.length < total);
});

test("practice filtering returns a stable order for the same filters", () => {
  // Session resume depends on this: the same filters on a different host must produce the same
  // itemIds, or "resume last session" silently becomes "a different session".
  const a = store.searchExercises({ moduleId: "M1", tiers: ["10"] }).map((e) => e.id);
  const b = store.searchExercises({ moduleId: "M1", tiers: ["10"] }).map((e) => e.id);
  assert.deepEqual(a, b);
  assert.deepEqual(a, [...a].sort());
  assert.equal(store.searchExercises({ moduleId: "M1", tiers: ["10"] }).every((e) => e.tier === "10"), true);
  assert.deepEqual(store.searchExercises({ tags: ["no-such-tag"] }), []);
});

test("the grading record is the only place the answer key is assembled", () => {
  const ex = store.exercises.get("m1-l2-p3");
  const response = toExerciseResponse(store, ex);
  // The record that grades has the key; the record a client fetches does not.
  assert.equal(typeof ex.answerLatex, "string");
  assert.equal("answerLatex" in response, false);
});

test("a missing module catalogue is a warning, not a failure", () => {
  // When content/modules.json is absent the store still loads and warns; when it is present the
  // modules get titles. Asserting the absent case unconditionally would fail the day the
  // catalogue lands, so both are covered through the same contract.
  const { modules, present, path } = loadModuleMeta(DEFAULT_CONTENT_ROOT);
  assert.ok(present ? modules.length > 0 : modules.length === 0);
  assert.ok(path.endsWith("modules.json"));
  if (!present) {
    assert.ok(store.warnings.some((w) => w.includes("module catalogue")));
  } else {
    assert.equal(store.warnings.some((w) => w.includes("module catalogue")), false);
  }
});

test("warnings only describe real gaps, and a clean corpus produces none", () => {
  // Every warning the loader can emit names an id that does not resolve. This asserts the shape
  // of a warning and, separately, that the loader does not invent one for content that is fine.
  const clean = new ContentStore({ root: DEFAULT_CONTENT_ROOT, modules: [] });
  const dangling = clean.warnings.filter((w) => /which no (exercise|lesson) file defines/.test(w));
  for (const warning of dangling) assert.match(warning, /\b(m|l)\d/);
  // A catalogue supplied explicitly removes the catalogue warning and nothing else.
  const withCatalogue = new ContentStore({
    root: DEFAULT_CONTENT_ROOT,
    modules: [{ id: "M1", title: "Algebra Foundations", order: 1 }],
  });
  assert.equal(withCatalogue.warnings.some((w) => w.includes("module catalogue")), false);
});

test("the shipped corpus has no dangling references", () => {
  // The tests above keep the route contract state-agnostic, which is right, but it means nothing
  // on its own holds the corpus still. This does: a lesson that lists an exercise nobody authored,
  // an exercise that claims a lesson that does not exist, or a prerequisite pointing nowhere has
  // to fail here instead of shipping. It reached zero when the counting lessons moved to M3 and
  // m4-l4's prerequisite m3-l2 resolved; it should stay there.
  assert.deepEqual(store.warnings, []);
});

test("every lesson and every exercise claims a module the catalogue declares", () => {
  // The regression guard for this change. The counting lessons were filed under M7, which the
  // catalogue gives to Probability, and nothing complained: the codes looked plausible and the
  // store only compared ids, never the two files against each other. M3 and M7 mean different
  // topics, so a lesson under the wrong one is invisible to every other check.
  const catalogue = new Map(
    JSON.parse(readFileSync(join(DEFAULT_CONTENT_ROOT, "modules.json"), "utf8")).modules.map((m) => [m.id, m.title]),
  );
  for (const lesson of store.lessons.values()) {
    assert.ok(catalogue.has(lesson.moduleId), `lesson ${lesson.id} claims module ${lesson.moduleId}, which the catalogue does not declare`);
  }
  for (const ex of store.exercises.values()) {
    assert.ok(catalogue.has(ex.moduleId), `exercise ${ex.id} claims module ${ex.moduleId}, which the catalogue does not declare`);
  }
  // And the two codes this branch moved between really do name different topics.
  assert.equal(catalogue.get("M3"), "Counting & Combinatorics");
  assert.equal(catalogue.get("M7"), "Probability");
  // This assertion used to be `getLesson("m7-l1") === null`, which was true only while M7 happened
  // to be empty. It is not the guard the misfiling needed: both codes are declared, so "M7 is
  // empty" was a coincidence of the corpus, not the absence of the bug. M7 now holds its own
  // probability lessons, and the invariant that must not come back is the one below - each module
  // holds the topic the catalogue gives it.
  assert.ok(store.getLesson("m3-l1"), "the counting lessons are m3-l1/m3-l2");
  assert.ok(store.getLesson("m3-l2"), "the counting lessons are m3-l1/m3-l2");
  assert.equal(store.getLesson("m3-l1").moduleId, "M3");
  assert.equal(store.getLesson("m3-l2").moduleId, "M3");
  assert.ok(store.getLesson("m7-l1"), "M7 holds probability lessons of its own now");
  assert.equal(store.getLesson("m7-l1").moduleId, "M7");
  // Topic is asserted from the lesson tags, because that is the only thing in a content file that
  // states what it actually teaches. The code in the id and the moduleId both agreed in the
  // original bug; only the prose was on the wrong module.
  const COUNTING_TAGS = [
    "fundamental-counting", "permutations", "inclusion-exclusion", "stars-and-bars", "pigeonhole-principle",
  ];
  const PROBABILITY_TAGS = [
    "probability", "conditional-probability", "geometric-probability", "bayes-theorem", "expected-value", "independence",
  ];
  // "complementary-counting" is deliberately in neither list: it is genuinely shared by M3 and M7,
  // so a cross-module tag must not be able to satisfy either side of this.
  for (const lesson of store.lessons.values()) {
    const tags = lesson.tags || [];
    const counting = tags.filter((t) => COUNTING_TAGS.includes(t));
    const probability = tags.filter((t) => PROBABILITY_TAGS.includes(t));
    if (lesson.moduleId === "M3") {
      assert.ok(counting.length > 0, `counting lesson ${lesson.id} carries no counting tag: ${tags}`);
      assert.equal(probability.length, 0, `counting lesson ${lesson.id} carries probability tags ${probability}`);
    }
    if (lesson.moduleId === "M7") {
      assert.ok(probability.length > 0, `lesson ${lesson.id} is filed under Probability and teaches ${tags}`);
      assert.equal(counting.length, 0, `lesson ${lesson.id} is filed under Probability but carries counting tags ${counting}`);
    }
  }
  // The exercises follow their lesson, so one anchor on each side catches an exercise authored
  // against the wrong module even if its lesson is filed correctly.
  assert.equal(store.exercises.get("m7-l1-p1").moduleId, "M7");
  assert.equal(store.exercises.get("m3-l1-p1").moduleId, "M3");
});

test("a dangling reference is still reported, so zero warnings means clean rather than unchecked", () => {
  // The other half of the zero above. Detection must survive the corpus being clean, or a green
  // run would only mean the check had been switched off.
  const root = mkdtempSync(join(tmpdir(), "math-dangling-"));
  try {
    mkdirSync(join(root, "lessons"), { recursive: true });
    mkdirSync(join(root, "exercises"), { recursive: true });
    writeFileSync(join(root, "lessons", "l1.json"), JSON.stringify({
      id: "l1", moduleId: "M1", order: 1, title: "T",
      prerequisites: ["l0"],
      sections: { practice: { exerciseIds: ["e-missing"] } },
    }));
    writeFileSync(join(root, "exercises", "e1.json"), JSON.stringify({ id: "e1", lessonId: "l0", moduleId: "M1" }));
    const warnings = new ContentStore({ root }).warnings;
    assert.ok(warnings.some((w) => w.includes("prerequisite l0")), `expected the missing prerequisite to be reported, got ${warnings}`);
    assert.ok(warnings.some((w) => w.includes("e-missing")), `expected the missing practice id to be reported, got ${warnings}`);
    assert.ok(warnings.some((w) => w.includes("claims lesson l0")), `expected the orphaned exercise to be reported, got ${warnings}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
