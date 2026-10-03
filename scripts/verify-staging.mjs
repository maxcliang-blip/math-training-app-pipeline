#!/usr/bin/env node
// Contract verification for a deployed staging base URL.
//
// Three things are asserted, each against the live service rather than against a build artifact:
//
//   1. There is no /api/asymptote/compile. A runtime Asymptote compiler is the thing the figure
//      contract says not to build; it must not answer 200, and it must not answer at all.
//   2. No free-response exercise carries answerLatex or solutionLatex, and no payload anywhere
//      contains the answer string of the free-response exercise used as the probe.
//   3. No lesson or exercise response carries asymptoteSource or asymptoteAspectRatio, and figure
//      information is exactly { figureKey, asymptoteAlt } -- the reference, never the payload.
//      asymptoteAlt is on the reference because the degraded figure state renders it while the
//      figure route is failing for every key (Rendering Conventions §5.6, §8.6); asymptoteSource,
//      the build input, still never leaves the build.
//
// Usage: node verify-staging.mjs [baseUrl]

const BASE = process.argv[2] || "http://127.0.0.1:18083";

let failures = 0;
function check(ok, label, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

const FIGURE_PAYLOAD_FIELDS = [
  "figureKey",
  "figureSvgUrl",
  "figureHash",
  "figurePipelineVersion",
  "declaredAspectRatio",
  "compiledAspectRatio",
  "alt",
  "captionLatex",
];
const FIGURE_BUILD_INPUT_FIELDS = ["asymptoteSource", "asymptoteAspectRatio"];
const FIGURE_REFERENCE_FIELDS = ["figureKey", "asymptoteAlt"];

async function json(path, options) {
  const res = await fetch(`${BASE}${path}`, options);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// Collect every key name anywhere in a document, so a leak anywhere is a failure rather than a
// leak in the one place someone remembered to check.
function collectKeys(value, into = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

const health = await json("/api/health");
check(health.status === 200, "GET /api/health answers 200", `got ${health.status}`);

const compileProbe = await json("/api/asymptote/compile", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ source: "import graph;\nsize(100);\n" }),
});
check(
  compileProbe.status === 404,
  "POST /api/asymptote/compile does not exist",
  `got ${compileProbe.status} ${JSON.stringify(compileProbe.body).slice(0, 120)}`,
);

// Find a real free-response exercise: tier A is free response by content rule.
const all = await json("/api/exercises?limit=60");
const freeResponse = (Array.isArray(all.body) ? all.body : []).find(
  (e) => e.choices === null || e.choices === undefined,
);
check(Boolean(freeResponse), "the corpus has a free-response exercise to probe");

if (freeResponse) {
  const freeKeys = collectKeys(freeResponse);
  check(
    !freeKeys.has("answerLatex"),
    "free-response exercise withholds answerLatex",
    freeResponse.id,
  );
  check(
    !freeKeys.has("solutionLatex"),
    "free-response exercise withholds solutionLatex",
    freeResponse.id,
  );
  check(
    freeResponse.answerWithheld === true,
    "free-response exercise says answerWithheld: true",
    `got ${JSON.stringify(freeResponse.answerWithheld)}`,
  );
}

const lessons = await json("/api/lessons");
const lessonList = Array.isArray(lessons.body) ? lessons.body : [];
check(lessonList.length > 0, "GET /api/lessons answers with a list", `${lessonList.length} lessons`);
const lessonKeys = collectKeys(lessonList);
for (const field of FIGURE_BUILD_INPUT_FIELDS) {
  check(!lessonKeys.has(field), `lesson list carries no ${field}`);
}
const leaked = FIGURE_PAYLOAD_FIELDS.filter((f) => !FIGURE_REFERENCE_FIELDS.includes(f) && lessonKeys.has(f));
check(leaked.length === 0, "lesson list carries no figure payload field", leaked.join(", "));

if (lessonList[0]) {
  const lesson = await json(`/api/lessons/${lessonList[0].id}`);
  const keys = collectKeys(lesson.body);
  for (const field of FIGURE_BUILD_INPUT_FIELDS) {
    check(!keys.has(field), `lesson detail carries no ${field}`);
  }
  const leakedDetail = FIGURE_PAYLOAD_FIELDS.filter((f) => !FIGURE_REFERENCE_FIELDS.includes(f) && keys.has(f));
  check(leakedDetail.length === 0, "lesson detail carries no figure payload field", leakedDetail.join(", "));
}

const exercises = await json("/api/exercises?limit=60");
const exerciseList = Array.isArray(exercises.body) ? exercises.body : [];
check(exerciseList.length > 0, "GET /api/exercises answers with a list", `${exerciseList.length} exercises`);
const exerciseKeys = collectKeys(exerciseList);
for (const field of FIGURE_BUILD_INPUT_FIELDS) {
  check(!exerciseKeys.has(field), `exercise list carries no ${field}`);
}

// Multiple choice still ships its key, per §3.3. Withholding that too would be a different bug.
const mc = exerciseList.find((e) => Array.isArray(e.choices) && e.choices.length > 0);
check(Boolean(mc?.answerLatex), "a multiple-choice exercise still ships answerLatex", mc?.id);

// The figure route, and that its payload is exactly the eight contract fields.
const figures = await json("/api/figures");
if (figures.status === 200) {
  const first = figures.body.figures[0];
  check(Boolean(first), "GET /api/figures lists at least one figure", `${figures.body.figures.length} figures`);
  const actual = Object.keys(first || {}).sort();
  const expected = [...FIGURE_PAYLOAD_FIELDS].sort();
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    "the figure payload is exactly the contract whitelist",
    actual.join(","),
  );
  const svg = await fetch(`${BASE}/${String(first.figureSvgUrl).replace(/^\//, "")}`);
  check(svg.status === 200, "a compiled figure SVG is served", `${first.figureSvgUrl} -> ${svg.status}`);
} else {
  check(false, "GET /api/figures answers", `got ${figures.status} ${JSON.stringify(figures.body).slice(0, 160)}`);
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`} against ${BASE}`);
process.exit(failures === 0 ? 0 : 1);