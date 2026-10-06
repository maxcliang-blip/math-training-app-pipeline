import { test, before, after } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../src/app.js";
import { loadContentStore } from "../src/content.js";
import { FigureStore } from "../src/figures.js";
import { FIGURE_PAYLOAD_FIELDS, FIGURE_REFERENCE_FIELDS } from "../../lib/figure-contract.mjs";

// Route-level acceptance for the API surface IA §7 lists as P0, plus the two rules that are
// cheaper to assert here than to discover in a learner's browser: no figure payload on a
// content route, and no free-response answer key before the learner has earned it.

let server;
let base;
let dataDir;
let content;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "math-api-test-"));
  // The store is injected so the health assertions below can read the counts off the very object
  // the routes answer from. Reloading the directory inside the test would assert against a second
  // corpus, not this app's.
  content = loadContentStore();
  server = createApp({ dataDir, content }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
});

async function get(path, options = {}) {
  const res = await fetch(`${base}${path}`, options);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, headers: res.headers, body };
}

async function post(path, payload) {
  return get(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
}

async function put(path, payload) {
  return get(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
}

// Walk any JSON and collect every key name present anywhere in it, so "no payload field on this
// route" is a check about the whole document rather than about the fields someone remembered.
function collectKeys(value, into = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return into;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

// Every object that names itself a figure reference: an object with a figureKey string. Walking for
// the shape rather than for known paths is deliberate — a figure in a section list, a figure on a
// worked example and a figure on an exercise are three different places, and a check that knows the
// first two and not the third is how four lessons ended up shipping their Asymptote source.
//
// Such an object is not *only* a reference: a worked example keeps its prose and an exercise keeps
// its prompt. What is asserted about it is narrower — nothing figure-shaped rides along except the
// reference fields themselves.
const FIGURE_SHAPED_KEYS = [
  ...new Set([...FIGURE_PAYLOAD_FIELDS, ...FIGURE_REFERENCE_FIELDS, "asymptoteSource", "asymptoteAlt"])
];

function walkReferences(value, into) {
  if (Array.isArray(value)) {
    for (const item of value) walkReferences(item, into);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (typeof value.figureKey === "string") into.push(value);
  for (const child of Object.values(value)) walkReferences(child, into);
}

test("health reports the corpus it actually loaded", async () => {
  const { status, body } = await get("/api/health");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
// Against the store the routes answer from, not a literal: this test is about the route's
  // honesty about its own corpus. The pinned corpus counts are asserted once, in content.test.js,
  // from lib/corpus-pins.mjs.
  const loaded = content.stats();
  assert.equal(body.content.exercises, loaded.exercises);
  assert.equal(body.content.lessons, loaded.lessons);
  assert.equal(typeof body.figures.usable, "boolean");
});

test("GET /api/modules returns the P0 list, one call, no N+1", async () => {
  const { status, body } = await get("/api/modules");
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  const m1 = body.find((m) => m.code === "M1");
  assert.equal(m1.lessonCount, 5);
  assert.ok(m1.exerciseCount > 0);
  assert.ok(Array.isArray(m1.tiers));
});

test("GET /api/modules/:id resolves prerequisite titles server-side, including cross-module", async () => {
  const { status, body } = await get("/api/modules/M1");
  assert.equal(status, 200);
  assert.equal(body.module.id, "M1");
  assert.ok(body.lessons.length >= 1);
  assert.ok(Array.isArray(body.prerequisitesFlat));
  for (const entry of body.prerequisitesFlat) {
    assert.equal(typeof entry.id, "string");
    if (entry.title !== null) assert.equal(typeof entry.title, "string");
  }
  assert.equal((await get("/api/modules/M42")).status, 404);
});

test("GET /api/lessons/:id returns ids for practice and mastery, and the ids resolve", async () => {
  const { status, body } = await get("/api/lessons/m1-l2");
  assert.equal(status, 200);
  assert.ok(body.sections.practiceIds.length > 0);
  assert.equal(typeof body.sections.mastery.passThreshold, "number");
  assert.equal(body.lock.mode, "soft");
  const batch = await get(`/api/exercises?ids=${body.sections.practiceIds.join(",")}`);
  assert.equal(batch.status, 200);
  assert.equal(batch.body.length, body.sections.practiceIds.length);
});

test("GET /api/exercises honours the filters it accepts, not only lessonId", async () => {
  // The route builds moduleId / tier / tag / difficultyMin / difficultyMax into a filter object;
  // all of them used to be discarded on the way into the store, so every one of these calls
  // answered with the whole corpus sorted by id. That is a plausible-looking body, which is why
  // it survived: nothing errored and nothing was empty.
  const all = (await get("/api/exercises")).body;
  const m1 = (await get("/api/exercises?moduleId=M1")).body;
  assert.ok(m1.length > 0 && m1.length < all.length, `?moduleId=M1 returned ${m1.length} of ${all.length}`);
  assert.equal(m1.every((e) => e.moduleId === "M1"), true);

  const tier = (await get("/api/exercises?moduleId=M1&tier=10")).body;
  assert.ok(tier.length > 0 && tier.length < m1.length);
  assert.equal(tier.every((e) => e.moduleId === "M1" && String(e.tier) === "10"), true);

  assert.deepEqual((await get("/api/exercises?tag=no-such-tag")).body, []);
  assert.deepEqual((await get("/api/exercises?moduleId=M99")).body, []);

  const ranged = (await get("/api/exercises?difficultyMin=1&difficultyMax=2")).body;
  assert.ok(ranged.length > 0 && ranged.length < all.length);
  assert.equal(ranged.every((e) => Number(e.difficulty) >= 1 && Number(e.difficulty) <= 2), true);

  // lessonId alone still answers in the lesson's authored order, so a lesson page is unaffected.
  const byLesson = (await get("/api/exercises?lessonId=m1-l2")).body;
  const practice = (await get("/api/lessons/m1-l2")).body.sections.practiceIds;
  assert.ok(byLesson.some((e) => e.id === practice[0]));
  assert.equal(byLesson.every((e) => e.lessonId === "m1-l2"), true);

  // ?limit still applies after filtering, not before.
  const limited = (await get("/api/exercises?moduleId=M1&limit=3")).body;
  assert.equal(limited.length, 3);
});

test("a lesson route lists solutions the client can actually render", async () => {
  // Lesson spec S3.6 renders solutions as their own list. It used to come back empty on every
  // lesson: "solutionIds" stripped to the section name "solution", the corpus section is
  // "solutions", and the empty result sat next to two correct lists.
  const { status, body } = await get("/api/lessons/m1-l2");
  assert.equal(status, 200);
  assert.ok(body.sections.solutionIds.length > 0, "lesson route reported no solutions");
  const resolved = await get(`/api/exercises?ids=${body.sections.solutionIds.join(",")}`);
  assert.equal(resolved.body.length, body.sections.solutionIds.length);
  assert.equal(resolved.body.every((e) => e.lessonId === "m1-l2"), true);

  // Every lesson, not just the one that was looked at: the bug was in the field mapping, so it
  // applied to the whole corpus.
  for (const lesson of (await get("/api/lessons")).body) {
    assert.ok(lesson.sections.solutionIds.length > 0, `${lesson.id} reported no solutions`);
  }
});

test("a module with no lessons yet still declares its tiers", async (t) => {
  // Every module in content/modules.json now has at least one authored lesson, so there is no
  // longer a module to run this against. Skipping says that in the output; a vacuous pass would
  // read as coverage that still exists. This comes back on its own the day a module is declared
  // ahead of its lessons, which is the normal way a new module enters the catalogue.
  const { body } = await get("/api/modules");
  const unauthored = body.filter((m) => m.lessonCount === 0);
  if (unauthored.length === 0) {
    return t.skip("every declared module has lessons authored, so there is nothing to check");
  }
  for (const m of unauthored) {
    assert.ok(m.tiers.length > 0, `${m.code} has no lessons and reports no tiers`);
    assert.deepEqual(m.tiers, m.declaredTiers);
  }
});

test("an authored module reports the tiers its lessons actually carry", async () => {
  const { body } = await get("/api/modules");
  // A module with lessons reports the union of the tiers its lessons actually carry. That union is
  // not required to equal the catalogue: M1's lessons claim A and the catalogue does not, M4 and
  // M8's claim 10 and A+ and the catalogue does not. Both numbers are reported so a client can
  // see the disagreement instead of inheriting one side of it.
  const authored = body.filter((m) => m.lessonCount > 0);
  assert.ok(authored.length > 0);
  for (const m of authored) {
    const { body: lessons } = await get(`/api/modules/${m.code}`);
    const fromLessons = [...new Set(lessons.lessons.flatMap((l) => l.tiers || []))];
    assert.deepEqual(m.tiers, fromLessons.sort(), `${m.code} tiers disagree with its lessons`);
    assert.deepEqual(m.tiers, [...m.tiers].sort());
    assert.deepEqual(m.declaredTiers, [...m.declaredTiers].sort());
  }
});

test("a batched exercise fetch refuses more than 60 ids and reports the ones it missed", async () => {
  const tooMany = await get(`/api/exercises?ids=${Array.from({ length: 61 }, (_, i) => `x${i}`).join(",")}`);
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.error, "too_many_ids");

  const partial = await get("/api/exercises?ids=m1-l2-p1,no-such-exercise");
  assert.equal(partial.status, 200);
  assert.equal(partial.body.length, 1);
  assert.match(partial.headers.get("x-content-warnings"), /no-such-exercise/);
});

test("no figure payload field appears anywhere on a content route", async () => {
  // figureKey, asymptoteAlt and figureCacheKey are the three payload-named fields a content route
  // may carry, because they are the reference, not the payload: FIGURE_REFERENCE_FIELDS. The other
  // six are the figure route's alone. figureCacheKey is on the reference because §5.5 reads the
  // client cache before the fetch; it is the build's hash of the source, never the source.
  const allowed = new Set(FIGURE_PAYLOAD_FIELDS.filter((f) => !FIGURE_REFERENCE_FIELDS.includes(f)));
  for (const path of ["/api/modules", "/api/modules/M1", "/api/lessons/m1-l3", "/api/exercises?lessonId=m6-l3", "/api/exercises/m6-l3-p6"]) {
    const { body } = await get(path);
    const keys = collectKeys(body);
    for (const field of allowed) {
      assert.equal(keys.has(field), false, `${field} leaked onto ${path}`);
    }
  }
  // And the references that do appear carry nothing beyond the reference fields. No manifest is
  // readable in this process, so there is no build identity to hand out and the key is absent --
  // which is the degraded state, not a leak.
  const withFigure = await get("/api/exercises/m6-l3-p6");
  const figureish = Object.keys(withFigure.body).filter((k) => /figure|alt|caption|aspect|hash|pipeline/i.test(k));
  for (const field of figureish) {
    assert.ok(FIGURE_REFERENCE_FIELDS.includes(field), `${field} is not a reference field`);
  }
  assert.ok(withFigure.body.asymptoteAlt, "the description rides along with the key");
});

test("a lesson and an exercise reference carry the build's cache key, and no build input", async () => {
  // The whole of §5.5's key on a content route, asserted end to end: the build hashes the source
  // and the pipeline version, the API carries the hash, and the source itself never ships. A
  // client can therefore key its cache on which build produced a figure without holding the input
  // that produced it — which is what lets the cache be right and the payload stay small.
  const built = createApp({
    dataDir,
    figureStore: new FigureStore({
      pipelineVersion: "asymptote-svg-sanitized@2",
      status: "pass",
      toolchain: { bin: "asymptote", version: "Asymptote version 2.87" },
      figures: [
        {
          figureKey: "m6-l3-p6",
          figureSvgUrl: "artifacts/figures/svg/m6-l3-p6.svg",
          figureHash: "sha256:deadbeef",
          figurePipelineVersion: "asymptote-svg-sanitized@2",
          figureCacheKey: "sha256:c0ffee",
          declaredAspectRatio: 0.661,
          compiledAspectRatio: 0.66,
          asymptoteVersion: "Asymptote version 2.87",
          alt: "A circle lies mostly in the second quadrant.",
          captionLatex: null,
        },
      ],
    }),
  }).listen(0);
  const url = `http://127.0.0.1:${built.address().port}`;
  try {
    const exercise = await (await fetch(`${url}/api/exercises/m6-l3-p6`)).json();
    assert.equal(exercise.figureCacheKey, "sha256:c0ffee");
    assert.equal("asymptoteSource" in exercise, false, "the build input still does not ship");

    const lesson = await (await fetch(`${url}/api/lessons/m1-l3`)).json();
    const refs = lesson.sections.concept.figures;
    assert.ok(refs.length > 0);
    for (const ref of refs) {
      // This manifest knows one figure and it is not one of these, so the lesson's references
      // carry no key at all rather than a borrowed one. Same rule, other direction.
      assert.equal("figureCacheKey" in ref, false, `${ref.figureKey} is not in the manifest`);
      // Everything on the reference is a reference field, and the two the content record owns --
      // the description and the authored ratio -- are there. Written as a filter rather than as
      // deepEqual on a literal key list, because a record that authored no ratio legitimately
      // produces a reference without one and the invariant under test is the boundary, not the
      // spelling of the list.
      assert.deepEqual(
        Object.keys(ref).filter((k) => !FIGURE_REFERENCE_FIELDS.includes(k)),
        [],
        `${ref.figureKey} carried something that is not a reference field`
      );
      assert.equal(typeof ref.asymptoteAspectRatio, "number", "the box has to be reservable");
    }
    assert.equal(JSON.stringify(lesson).includes("size(299,241)"), false, "no Asymptote source in a lesson");
  } finally {
    await new Promise((resolve) => built.close(resolve));
  }
});

// The numbers a figure reference carries are asserted where they are a deliberate exception rather
// than as an absence: every figure reference in the corpus must carry the authored ratio, because a
// client that has to fetch the ratio in order to reserve the box reserves nothing, and the box then
// moves when the SVG lands (Rendering Conventions §5.4 items 1 and 5). The second half of the
// assertion is the one that keeps the exception from becoming a leak: nothing figure-shaped beyond
// the reference fields may ride along with it.
test("every figure reference in the corpus carries the authored ratio, and nothing else", async () => {
  const lessons = await get("/api/lessons");
  let references = 0;
  for (const summary of lessons.body) {
    const { body } = await get(`/api/lessons/${summary.id}`);
    const found = [];
    walkReferences(body, found);
    for (const ref of found) {
      references += 1;
      assert.deepEqual(
        Object.keys(ref).filter((k) => FIGURE_SHAPED_KEYS.includes(k) && !FIGURE_REFERENCE_FIELDS.includes(k)),
        [],
        `figure reference on ${summary.id} carried something else: ${JSON.stringify(ref)}`
      );
      assert.equal(
        typeof ref.asymptoteAspectRatio,
        "number",
        `figure reference ${ref.figureKey} on ${summary.id} has no ratio to reserve from`
      );
    }
  }
  assert.ok(references > 0, "the corpus has figure references to check");
});

// asymptoteSource is not a payload field, so a payload-field check cannot see it. It is the one
// figure input that must never reach a content route at any width.
//
// asymptoteAlt and asymptoteAspectRatio are deliberately absent from that list. Both are reference
// fields rather than build input: the description because the degraded state renders it while the
// figure route is failing for every key (§5.6, §8.6), and the ratio because §5.4 item 1 sizes the
// reserved box from it at first paint, which is before that route has answered. The test above is
// where they are pinned instead, so widening the reference cannot quietly become a wider leak.
test("no Asymptote build input appears anywhere on a content route", async () => {
  const buildInput = ["asymptoteSource"];

  const lessons = await get("/api/lessons");
  for (const summary of lessons.body) {
    for (const path of [`/api/lessons/${summary.id}`, `/api/exercises?lessonId=${summary.id}`]) {
      const { body } = await get(path);
      const keys = collectKeys(body);
      for (const field of buildInput) {
        assert.equal(keys.has(field), false, `${field} leaked onto ${path}`);
      }
    }
  }
});

test("a free-response exercise on the wire ships neither the key nor the derivation", async () => {
  const { status, body } = await get("/api/exercises/m1-l1-m2");
  assert.equal(status, 200);
  assert.equal(body.choices, null);
  assert.equal(body.answerWithheld, true);
  assert.equal(body.solutionWithheld, true);
  assert.equal("answerLatex" in body, false);
  assert.equal("solutionLatex" in body, false);
  // The string "5" is the answer to this exercise. It must not be reachable from the record.
  assert.equal(JSON.stringify(body).includes("=4$ and $b=9$"), false);
});

// A manifest the build did not pass. Constructed here rather than read off disk: artifacts/ is
// gitignored, so a test that reads the shipped manifest asserts whatever the last local Asymptote
// run happened to leave behind — which is how this suite passed against toolchain-missing and
// then failed the moment a real image ran the build.
const unusableManifest = () =>
  new FigureStore({
    pipelineVersion: "asymptote-svg-sanitized@2",
    status: "toolchain-missing",
    toolchain: null,
    figures: [],
  });

test("GET /api/figures is a hard 503 when the build did not produce a usable manifest", async () => {
// The contract is explicit that a build which never produced a usable manifest must be a 503
  // and never an empty list.
  const unusable = createApp({ dataDir, figureStore: unusableManifest() });
  const server3 = unusable.listen(0);
  await new Promise((resolve) => server3.once("listening", resolve));
  const url = `http://127.0.0.1:${server3.address().port}`;
  try {
    const res = await fetch(`${url}/api/figures`);
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.ok(body.error.startsWith("figure-pipeline-"));
    assert.match(body.message, /content:figures/);
  } finally {
    await new Promise((resolve) => server3.close(resolve));
  }
});

test("a figure key lookup against an unusable manifest is a 503, not a 404", async () => {
  // A 404 here would tell a client the figure does not exist. The truth is that no build ran, and
  // those are different bugs with different fixes.
  const unusable = createApp({ dataDir, figureStore: unusableManifest() });
  const server3 = unusable.listen(0);
  await new Promise((resolve) => server3.once("listening", resolve));
  const url = `http://127.0.0.1:${server3.address().port}`;
  try {
    const res = await fetch(`${url}/api/figures/m6-l3-p6`);
    assert.equal(res.status, 503);
  } finally {
    await new Promise((resolve) => server3.close(resolve));
  }
});

test("with the figure endpoint failing, the lesson and exercise still describe the figure", async () => {
  // Rendering Conventions §8.6, from the server's side of the boundary: with the figure endpoint
  // forced to fail, the alt text has to reach the client or there is nothing for the degraded box
  // to show. The figure route is the thing that is failing here, so it cannot be the source of the
  // description -- which is the whole reason asymptoteAlt is on the reference.
  const unusable = createApp({ dataDir, figureStore: unusableManifest() });
  const server4 = unusable.listen(0);
  await new Promise((resolve) => server4.once("listening", resolve));
  const url = `http://127.0.0.1:${server4.address().port}`;
  try {
    // The endpoint really is failing, for every key.
    assert.equal((await fetch(`${url}/api/figures/m6-l3-p6`)).status, 503);
    assert.equal((await fetch(`${url}/api/figures`)).status, 503);

    const exercise = await (await fetch(`${url}/api/exercises/m6-l3-p6`)).json();
    assert.equal(exercise.figureKey, "m6-l3-p6");
    assert.match(exercise.asymptoteAlt, /^A circle lies mostly in the second quadrant/);

    const lesson = await (await fetch(`${url}/api/lessons/m1-l3`)).json();
    const refs = lesson.sections.concept.figures;
    assert.ok(refs.length > 0);
    for (const ref of refs) {
      assert.ok(ref.asymptoteAlt, `${ref.figureKey} has no description to degrade to`);
      assert.match(ref.asymptoteAlt, /\S/);
    }
  } finally {
    await new Promise((resolve) => server4.close(resolve));
  }
});

test("with a passing manifest, the figure route serves exactly the contract payload", async () => {
  const passing = createApp({
    dataDir,
    figureStore: new FigureStore({
      pipelineVersion: "asymptote-svg-sanitized@2",
      status: "pass",
      toolchain: { bin: "asymptote", version: "Asymptote version 2.87" },
      figures: [
        {
          figureKey: "m6-l3-p6",
          figureSvgUrl: "artifacts/figures/svg/m6-l3-p6.svg",
          figureHash: "sha256:deadbeef",
          figurePipelineVersion: "asymptote-svg-sanitized@2",
          figureCacheKey: "sha256:c0ffee",
          declaredAspectRatio: 0.661,
          compiledAspectRatio: 0.66,
          asymptoteVersion: "Asymptote version 2.87",
          alt: "A circle lies mostly in the second quadrant.",
          captionLatex: null,
        },
      ],
    }),
  });
  const server2 = passing.listen(0);
  await new Promise((resolve) => server2.once("listening", resolve));
  const url = `http://127.0.0.1:${server2.address().port}`;

  try {
    const list = await fetch(`${url}/api/figures`);
    assert.equal(list.status, 200);
    assert.equal(list.headers.get("cache-control"), "public, max-age=31536000, immutable");
    const listed = await list.json();
    assert.equal(listed.status, "pass");
    assert.deepEqual(Object.keys(listed.figures[0]).sort(), [...FIGURE_PAYLOAD_FIELDS].sort());
    // Build provenance stays behind the build.
    assert.equal("asymptoteVersion" in listed.figures[0], false);

    const one = await fetch(`${url}/api/figures/m6-l3-p6`);
    assert.equal(one.status, 200);
    // figureHash is a sha256 over the sanitised SVG, which makes it a usable strong ETag and
    // safe to cache immutably.
    assert.equal(one.headers.get("etag"), "sha256:deadbeef");
    assert.equal((await one.json()).declaredAspectRatio, 0.661);

    assert.equal((await fetch(`${url}/api/figures/m1-l1.sections.concept.figures[0]`)).status, 404);
  } finally {
    await new Promise((resolve) => server2.close(resolve));
  }
});

test("POST /api/grade is the fallback and the server's verdict is the whole reply", async () => {
  const correct = await post("/api/grade", { response: "81", exerciseId: "m1-l2-p3" });
  assert.equal(correct.status, 200);
  assert.equal(correct.body.correct, true);
  assert.equal(correct.body.gradedBy, "server");
  assert.equal(correct.body.expectedForm, "number");
  // The fallback must not become a back door onto the answer key.
  assert.equal("answerLatex" in correct.body, false);
  assert.equal("solutionLatex" in correct.body, false);

  const wrong = await post("/api/grade", { response: "0.51", exerciseId: "m1-l2-p3" });
  assert.equal(wrong.status, 200);
  assert.equal(wrong.body.correct, false);
  // The learner's own canonical input, and nothing of the answer's.
  assert.equal(wrong.body.normalized, "0.51");
  assert.equal(JSON.stringify(wrong.body).includes("81"), false);

  assert.equal((await post("/api/grade", { response: "1" })).status, 400);
  assert.equal((await post("/api/grade", { response: "1", exerciseId: "nope" })).status, 404);
});

test("a practice session is created from filters and answered one item at a time", async () => {
  const created = await post("/api/practice/sessions", { filters: { moduleId: "M1", tiers: ["10"], size: 5 } });
  assert.equal(created.status, 201);
  const { sessionId, itemIds } = created.body;
  assert.equal(itemIds.length, 5);
  assert.equal(created.body.meta.byTier["10"], 5);

  const first = itemIds[0];
  const exercise = await get(`/api/exercises/${first}`);
  const isChoice = exercise.body.choices !== null;
  const response = isChoice ? 0 : "0.5";

  const answer = await post(`/api/practice/sessions/${sessionId}/answers`, {
    exerciseId: first,
    response,
    attemptIndex: 0,
    hintsUsed: 0,
    elapsedMs: 4200,
  });
  assert.equal(answer.status, 200);
  assert.equal(typeof answer.body.correct, "boolean");
  assert.equal(typeof answer.body.expectedForm, "string");
  assert.equal(typeof answer.body.solutionAvailable, "boolean");

  const complete = await post(`/api/practice/sessions/${sessionId}/complete`, {});
  assert.equal(complete.status, 200);
  assert.equal(complete.body.total, 5);
  assert.equal(complete.body.attempted, 1);
  assert.equal(complete.body.skipped, 4);
  // Skipped items are listed as unseen answers rather than failures (§5 of lesson spec).
  assert.equal(complete.body.unseenExerciseIds.length, 4);
  assert.equal(complete.body.wrongExerciseIds.length, answer.body.correct ? 0 : 1);

  const resumed = await get(`/api/practice/sessions/${sessionId}`);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.items.length, 5);
  assert.equal(resumed.body.items[0].status, answer.body.correct ? "correct" : "incorrect");
});

test("a free-response answer returns correctness and nothing that reveals the key", async () => {
  const free = await get("/api/exercises/m1-l2-p3");
  assert.equal(free.body.choices, null);

  const created = await post("/api/practice/sessions", { filters: { lessonId: "m1-l2", size: 30 } });
  const { sessionId } = created.body;
  assert.ok(created.body.itemIds.includes("m1-l2-p3"));

  const wrong = await post(`/api/practice/sessions/${sessionId}/answers`, {
    exerciseId: "m1-l2-p3",
    response: "0.51",
    attemptIndex: 0,
  });
  assert.equal(wrong.status, 200);
  assert.equal(wrong.body.correct, false);
  const serialised = JSON.stringify(wrong.body);
  assert.equal(serialised.includes("answerLatex"), false);
  assert.equal(serialised.includes("solutionLatex"), false);
  // "81" is the answer to this exercise. If it appears anywhere in a wrong-answer payload, the
  // leak is in place regardless of what the field is called.
  assert.equal(serialised.includes("81"), false);
  // The learner gets their own canonical input back, which is theirs to see.
  assert.equal(wrong.body.normalized, "0.51");

  // §3.5: revealing is an explicit act, and it is the only way to the solution early.
  const locked = await get(`/api/practice/sessions/${sessionId}/exercises/m1-l2-p3/solution`);
  assert.equal(locked.status, 403);
  assert.equal(locked.body.error, "solution_locked");

  const revealed = await post(`/api/practice/sessions/${sessionId}/answers`, {
    exerciseId: "m1-l2-p3",
    response: "0.51",
    revealed: true,
  });
  assert.equal(revealed.body.solutionAvailable, true);
  const solution = await get(`/api/practice/sessions/${sessionId}/exercises/m1-l2-p3/solution`);
  assert.equal(solution.status, 200);
  assert.equal(solution.body.answerLatex, "81");
  assert.ok(solution.body.solutionLatex.length > 0);
});

test("three wrong attempts unlock the solution without a reveal click", async () => {
  const created = await post("/api/practice/sessions", { filters: { lessonId: "m1-l2", size: 30 } });
  const { sessionId } = created.body;
  let available = false;
  for (let i = 0; i < 3; i++) {
    const answer = await post(`/api/practice/sessions/${sessionId}/answers`, {
      exerciseId: "m1-l2-p3",
      response: "0.51",
      attemptIndex: i,
    });
    available = answer.body.solutionAvailable;
  }
  assert.equal(available, true);
  const solution = await get(`/api/practice/sessions/${sessionId}/exercises/m1-l2-p3/solution`);
  assert.equal(solution.status, 200);
});

test("an answer for an exercise outside the session is refused", async () => {
  const created = await post("/api/practice/sessions", { filters: { lessonId: "m1-l2", size: 3 } });
  const { sessionId } = created.body;
  // A real exercise, just not one this session selected. 404 would be the wrong answer: the
  // exercise exists, the session is what does not contain it.
  const elsewhere = (await get("/api/exercises?lessonId=m6-l3")).body[0].id;
  const stray = await post(`/api/practice/sessions/${sessionId}/answers`, {
    exerciseId: elsewhere,
    response: "x",
  });
  assert.equal(stray.status, 409);
  assert.equal(stray.body.error, "not_in_session");

  const unknown = await post(`/api/practice/sessions/${sessionId}/answers`, {
    exerciseId: "no-such-exercise",
    response: "x",
  });
  assert.equal(unknown.status, 404);
  assert.equal((await post("/api/practice/sessions/s_nope/answers", {})).status, 404);
});

test("PUT /api/progress is idempotent and last-write-wins per lesson", async () => {
  const first = await put("/api/progress", {
    lessonId: "m1-l2",
    state: "in-progress",
    mastery: { attempt: 3, correct: 2, total: 3 },
    updatedAt: "2026-10-02T10:00:00.000Z",
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.applied, true);

  // The same write again is a no-op, not a duplicate and not an error.
  const again = await put("/api/progress", {
    lessonId: "m1-l2",
    state: "in-progress",
    mastery: { attempt: 3, correct: 2, total: 3 },
    updatedAt: "2026-10-02T10:00:00.000Z",
  });
  assert.equal(again.body.applied, true);
  assert.equal((await get("/api/progress")).body.filter((p) => p.lessonId === "m1-l2").length, 1);

  // A newer write wins.
  const newer = await put("/api/progress", {
    lessonId: "m1-l2",
    state: "passed",
    mastery: { attempt: 4, correct: 4, total: 4 },
    updatedAt: "2026-10-02T11:00:00.000Z",
  });
  assert.equal(newer.body.state, "passed");

  // A stale write from an offline client is accepted and reported as not applied, so the client
  // reconciles instead of retrying forever.
  const stale = await put("/api/progress", {
    lessonId: "m1-l2",
    state: "in-progress",
    updatedAt: "2026-10-02T09:00:00.000Z",
  });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.applied, false);
  assert.equal(stale.body.reason, "stale");
  assert.equal(stale.body.state, "passed");

  assert.equal((await put("/api/progress", { state: "passed" })).status, 400);
});

test("reporting a problem writes a content-ops flag row", async () => {
  const flagged = await post("/api/exercises/m1-l2-p3/flagged", {
    sessionId: "s_test",
    attemptIndex: 0,
    response: "0.51",
    kind: "wrong-answer",
    note: "the grader rejects 0.5 as wrong",
  });
  assert.equal(flagged.status, 201);
  assert.equal(flagged.body.accepted, true);

  const feedback = await post("/api/exercises/m1-l2-p3/feedback", { kind: "broken-latex" });
  assert.equal(feedback.status, 201);

  assert.equal((await post("/api/exercises/nope/flagged", {})).status, 404);
  const lines = readFileSync(join(dataDir, "flags.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].kind, "wrong-answer");
  assert.equal(lines[1].kind, "broken-latex");
  assert.ok(existsSync(join(dataDir, "flags.jsonl")));
});

test("an unknown API path answers with the same JSON error shape as everything else", async () => {
  const { status, body } = await get("/api/nope");
  assert.equal(status, 404);
  assert.equal(body.error, "not_found");
  assert.equal(typeof body.message, "string");
});

test("the corpus warnings are reachable, so a dangling reference is not only a startup log line", async () => {
  const { status, body } = await get("/api/content/warnings");
  assert.equal(status, 200);
  // The endpoint contract is asserted, not the corpus's current health: content fixes land
  // independently of this branch, and a test that fails because a content bug got fixed is a
  // test that has to be deleted before the fix can merge.
  assert.ok(Array.isArray(body.warnings));
  assert.equal(typeof body.stats.exercises, "number");
  for (const warning of body.warnings) assert.equal(typeof warning, "string");
});

test("a corpus that does have a gap puts that gap on the warnings route", async () => {
  // The warnings route test above asserts the endpoint contract over whatever corpus is shipped.
  // This one proves the route is a real report rather than an empty array by construction: a
  // corpus with a dangling prerequisite and an unresolved practice id has to show both, and the
  // lesson still serves with the id that does not resolve, because the loader reports gaps rather
  // than patching them out.
  const root = mkdtempSync(join(tmpdir(), "math-api-dangling-"));
  const gapDataDir = mkdtempSync(join(tmpdir(), "math-api-dangling-data-"));
  mkdirSync(join(root, "lessons"), { recursive: true });
  writeFileSync(join(root, "lessons", "l1.json"), JSON.stringify({
    id: "l1", moduleId: "M1", order: 1, title: "T",
    prerequisites: ["l0"],
    sections: { practice: { exerciseIds: ["e-missing"] } },
  }));
  const gapped = createApp({ dataDir: gapDataDir, content: loadContentStore(root) }).listen(0);
  try {
    await new Promise((resolve) => gapped.once("listening", resolve));
    const at = `http://127.0.0.1:${gapped.address().port}`;
    const res = await fetch(`${at}/api/content/warnings`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.warnings.some((w) => w.includes("prerequisite l0")), `expected the dangling prerequisite on the route, got ${body.warnings}`);
    assert.ok(body.warnings.some((w) => w.includes("e-missing")), `expected the unresolved practice id on the route, got ${body.warnings}`);
    const lesson = await (await fetch(`${at}/api/lessons/l1`)).json();
    assert.deepEqual(lesson.prerequisites, ["l0"]);
    assert.deepEqual(lesson.sections.practiceIds, ["e-missing"]);
  } finally {
    await new Promise((resolve) => gapped.close(resolve));
    rmSync(root, { recursive: true, force: true });
    rmSync(gapDataDir, { recursive: true, force: true });
  }
});
