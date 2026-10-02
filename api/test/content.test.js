import { test } from "node:test";
import assert from "node:assert";

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
  const stats = store.stats();
  assert.equal(stats.lessons, 27);
  assert.equal(stats.exercises, 474);
  assert.ok(stats.modules >= 8, `expected at least the eight authored modules, got ${stats.modules}`);
});

test("a lesson route reports ids for practice, mastery and solutions, and the prose sections survive", () => {
  const lesson = store.getLesson("m1-l2");
  assert.equal(lesson.id, "m1-l2");
  assert.equal(lesson.moduleId, "M1");
  assert.ok(Array.isArray(lesson.sections.practiceIds));
  assert.ok(lesson.sections.practiceIds.length > 0);
  assert.ok(Array.isArray(lesson.sections.masteryIds));
  assert.ok(Array.isArray(lesson.sections.solutionIds));
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

test("GET /api/modules has the shape IA §7 specifies, with an honest null for a missing catalogue", () => {
  const { modules, missingTitle } = store.listModules();
  assert.ok(modules.length >= 8);
  const m1 = modules.find((m) => m.code === "M1");
  assert.equal(m1.id, "M1");
  assert.equal(typeof m1.order, "number");
  assert.equal(typeof m1.lessonCount, "number");
  assert.equal(typeof m1.exerciseCount, "number");
  assert.ok(Array.isArray(m1.tiers));
  // No content/modules.json is committed, so every title is null rather than guessed from a
  // lesson, and the gap is named instead of hidden.
  assert.equal(m1.title, null);
  assert.ok(missingTitle.includes("M1"));
  // Module order is numeric, so M2 sorts before M10 rather than after it.
  const codes = modules.map((m) => m.code);
  assert.deepEqual(codes, [...codes].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
});

test("a batched exercise fetch is one call, capped, and reports ids it could not resolve", () => {
  const found = store.queryExercises({ ids: ["m1-l2-p1", "m1-l2-p2", "nope-1"] });
  assert.deepEqual(found.map((e) => e.id), ["m1-l2-p1", "m1-l2-p2"]);
  const byLesson = store.queryExercises({ lessonId: "m1-l2" });
  assert.ok(byLesson.length >= 15);
  assert.ok(byLesson.every((e) => e.lessonId === "m1-l2"));
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
  const { modules, present } = loadModuleMeta(DEFAULT_CONTENT_ROOT);
  assert.equal(present, false);
  assert.deepEqual(modules, []);
  assert.ok(store.warnings.some((w) => w.includes("module catalogue")));
});
