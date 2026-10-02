import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FigureStore, requireFigure, loadFigureStore } from "../src/figures.js";
import { FIGURE_PAYLOAD_FIELDS, FIGURE_REFERENCE_FIELDS, figureReference, toFigurePayload, exerciseFigureKey, lessonFigureKey } from "../../lib/figure-contract.mjs";

function manifest(overrides = {}) {
  return {
    pipelineVersion: "asymptote-svg-sanitized@2",
    status: "pass",
    toolchain: { bin: "asymptote", version: "Asymptote version 2.86" },
    figures: [
      {
        figureKey: "m1-l1.sections.concept.figures[0]",
        figureSvgUrl: "artifacts/figures/svg/m1-l1.svg",
        figureHash: "sha256:abc123",
        figurePipelineVersion: "asymptote-svg-sanitized@2",
        declaredAspectRatio: 2.667,
        compiledAspectRatio: 2.66,
        asymptoteVersion: "Asymptote version 2.86",
        alt: "A number line with two marked points.",
        captionLatex: null,
      },
    ],
    ...overrides,
  };
}

test("figure keys address a figure the way the build writes them", () => {
  // These three strings are the whole addressing contract. A key that shifts is a learner
  // served the wrong figure, so they are pinned here rather than only in the build.
  assert.equal(lessonFigureKey("m1-l1", "concept", 0), "m1-l1.sections.concept.figures[0]");
  assert.equal(exerciseFigureKey("m5-l2-f3"), "m5-l2-f3");
});

test("a figure payload carries the contract fields and nothing else", () => {
  const store = new FigureStore(manifest());
  const payload = store.get("m1-l1.sections.concept.figures[0]");

  assert.deepEqual(Object.keys(payload).sort(), [...FIGURE_PAYLOAD_FIELDS].sort());
  assert.equal(payload.figureHash, "sha256:abc123");
  // asymptoteVersion is build provenance and stays behind the build.
  assert.equal("asymptoteVersion" in payload, false);
});

test("a non-figure route gets the reference and never the payload", () => {
  const ref = figureReference("m1-l1.sections.concept.figures[0]");
  assert.deepEqual(Object.keys(ref), FIGURE_REFERENCE_FIELDS);
  for (const field of FIGURE_PAYLOAD_FIELDS) {
    if (field === "figureKey") continue;
    assert.equal(field in ref, false, `${field} must not appear on a lesson or exercise response`);
  }
});

test("a manifest that did not pass the build serves no figure", () => {
  const store = new FigureStore(manifest({ status: "fail" }));
  assert.equal(store.usable, false);
  assert.equal(store.get("m1-l1.sections.concept.figures[0]"), null);
  assert.throws(() => requireFigure(store, "m1-l1.sections.concept.figures[0]"), (err) => {
    assert.match(err.message, /not usable/);
    assert.equal(err.status, 503);
    return true;
  });
});

test("an empty manifest is not a usable catalogue", () => {
  const store = new FigureStore(manifest({ figures: [] }));
  assert.equal(store.usable, false);
});

test("a figure with no hash is not served", () => {
  const bad = manifest();
  delete bad.figures[0].figureHash;
  const store = new FigureStore(bad);
  assert.equal(store.usable, true, "the manifest itself passed; this figure is the problem");
  assert.equal(store.get("m1-l1.sections.concept.figures[0]"), null);
  assert.throws(() => requireFigure(store, "m1-l1.sections.concept.figures[0]"), (err) => {
    assert.match(err.message, /without a figureHash/);
    assert.equal(err.status, 404);
    return true;
  });
});

test("an unknown figure is a 404 and says so", () => {
  const store = new FigureStore(manifest());
  assert.throws(() => requireFigure(store, "m9-l9.sections.concept.figures[0]"), (err) => {
    assert.match(err.message, /not in the manifest/);
    assert.equal(err.status, 404);
    return true;
  });
});

test("a manifest from an older pipeline version is still readable, and says which", () => {
  const store = new FigureStore(manifest({ pipelineVersion: "asymptote-svg-sanitized@1" }));
  assert.equal(store.pipelineVersion, "asymptote-svg-sanitized@1");
  assert.equal(store.get("m1-l1.sections.concept.figures[0]").figurePipelineVersion, "asymptote-svg-sanitized@2");
});

test("a missing or malformed manifest is a load error, not a silent empty catalogue", () => {
  const dir = mkdtempSync(join(tmpdir(), "figure-store-"));
  try {
    assert.throws(() => loadFigureStore(join(dir, "nope.json")), /unreadable/);

    const badJson = join(dir, "bad.json");
    writeFileSync(badJson, "{ not json");
    assert.throws(() => loadFigureStore(badJson), /not valid JSON/);

    const noFigures = join(dir, "no-figures.json");
    writeFileSync(noFigures, JSON.stringify({ pipelineVersion: "x" }));
    assert.throws(() => loadFigureStore(noFigures), /no figures array/);

    const noVersion = join(dir, "no-version.json");
    writeFileSync(noVersion, JSON.stringify({ figures: [] }));
    assert.throws(() => loadFigureStore(noVersion), /no pipelineVersion/);

    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify(manifest()));
    const store = loadFigureStore(good);
    assert.equal(store.usable, true);
    assert.deepEqual(store.keys(), ["m1-l1.sections.concept.figures[0]"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toFigurePayload whitelists rather than passing an entry through", () => {
  const payload = toFigurePayload({ figureKey: "k", figureHash: "sha256:x", somethingNew: "leaks" });
  assert.equal("somethingNew" in payload, false);
  assert.equal(toFigurePayload(null), null);
});

test("measureBox reads the compiled box off the root svg element", async () => {
  const { measureBox } = await import("../../scripts/build-figures.mjs");

  // Asymptote emits a unit-suffixed, double-quoted root element. This is the shape that used to
  // return null, which left every corpus figure reporting measuredWidth: null.
  assert.deepEqual(
    measureBox('<svg width="283.46pt" height="141.73pt" viewBox="0 0 283 141" version="1.1">'),
    { width: 283.46, height: 141.73 },
  );

  // dvisvgm --eps, single quotes and no units.
  assert.deepEqual(measureBox("<svg width='320' height='240'>"), { width: 320, height: 240 });

  // viewBox-only, comma separated, which the width/height pair cannot rescue.
  assert.deepEqual(measureBox('<svg viewBox="0,0,100,50">'), { width: 100, height: 50 });

  // viewBox is the fallback, not the first choice: width/height win when both are present.
  assert.deepEqual(measureBox('<svg width="200" height="100" viewBox="0 0 400 400">'), {
    width: 200,
    height: 100,
  });
});

test("measureBox reports no box rather than guessing one", async () => {
  const { measureBox } = await import("../../scripts/build-figures.mjs");

  // A root element with neither a usable size nor a viewBox is unmeasurable. It must return null
  // so the build can fail closed; a guessed 0x0 would read as zero drift and pass silently.
  assert.equal(measureBox('<svg version="1.1" xmlns="http://www.w3.org/2000/svg"></svg>'), null);
  assert.equal(measureBox('<svg width="0" height="0"></svg>'), null);
  assert.equal(measureBox('<svg width="100%"></svg>'), null);
  assert.equal(measureBox("not an svg at all"), null);

  // Only the root element counts. A child's width attribute must never be mistaken for the
  // figure's box, which is what an unanchored document-wide match used to risk.
  assert.equal(measureBox('<svg><rect width="500" height="400"/></svg>'), null);
});

test("recording a ratio edits the figure whose source was located, not the first in the file", async () => {
  const { recordAspectRatios } = await import("../../scripts/build-figures.mjs");
  const dir = mkdtempSync(join(tmpdir(), "record-box-"));
  const file = join(dir, "m2-l3.json");

  // The shape that broke the bootstrap: two figures in one file declaring the same box, so a
  // file-wide search for `"asymptoteAspectRatio": 1.333` has two matches and either refuses to
  // run or rewrites the wrong figure. The second figure is the one whose box really moved.
  writeFileSync(
    file,
    JSON.stringify(
      {
        sections: [
          {
            figures: [
              { asymptoteSource: "size(320,240);\ndraw((0,0)--(1,1));", asymptoteAlt: "a diagonal line in a square frame", asymptoteAspectRatio: 1.333 },
              { asymptoteSource: "size(320,240);\ndraw((0,0)--(2,1));", asymptoteAlt: "a shallow line in a wide frame", asymptoteAspectRatio: 1.333 },
            ],
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );

  const sourceA = "size(320,240);\ndraw((0,0)--(1,1));";
  const sourceB = "size(320,240);\ndraw((0,0)--(2,1));";
  const result = {
    measurements: [
      { key: "m2-l3.sections.concept.figures[0]", file, source: sourceA, declaredSize: "size(320,240)", declaredRatio: 1.333, measuredWidth: 300, measuredHeight: 240, measuredRatio: 1.25 },
      { key: "m2-l3.sections.concept.figures[1]", file, source: sourceB, declaredSize: "size(320,240)", declaredRatio: 1.333, measuredWidth: 480, measuredHeight: 240, measuredRatio: 2 },
    ],
  };

  const recorded = recordAspectRatios(result);
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  assert.equal(recorded.changes.length, 2);

  const after = JSON.parse(readFileSync(file, "utf8"));
  const [a, b] = after.sections[0].figures;
  // Each figure keeps its own source and gains its own measured box.
  assert.equal(a.asymptoteSource, "size(300,240);\ndraw((0,0)--(1,1));");
  assert.equal(a.asymptoteAspectRatio, 1.25);
  assert.equal(b.asymptoteSource, "size(480,240);\ndraw((0,0)--(2,1));");
  assert.equal(b.asymptoteAspectRatio, 2);

  rmSync(dir, { recursive: true, force: true });
});

test("a figure reused by a lesson's examples is recorded once, across both occurrences", async () => {
  const { recordAspectRatios } = await import("../../scripts/build-figures.mjs");
  const dir = mkdtempSync(join(tmpdir(), "record-reuse-"));
  const file = join(dir, "m8-l3.json");

  // A lesson reuses a concept's figure inside its examples, so the same asymptoteSource appears
  // under both figures[] and examples[]. Those are one figure compiled once; recording has to move
  // both declarations together, and must not treat the second pass finding nothing as an error.
  const source = "// a circle inscribed in a triangle\nsize(300,200);\npair O=(0,0);\ndraw(circle(O,1));";
  writeFileSync(
    file,
    JSON.stringify(
      {
        sections: [
          {
            figures: [{ asymptoteSource: source, asymptoteAlt: "a circle drawn inside a triangular frame", asymptoteAspectRatio: 1.5 }],
            examples: [
              { label: "first" },
              { asymptoteSource: source, asymptoteAlt: "a circle drawn inside a triangular frame", asymptoteAspectRatio: 1.5 },
            ],
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );

  const recorded = recordAspectRatios({
    measurements: [
      { key: "m8-l3.sections.concept.figures[0]", file, source, declaredSize: "size(300,200)", declaredRatio: 1.5, measuredWidth: 400, measuredHeight: 200, measuredRatio: 2 },
      { key: "m8-l3.sections.concept.examples[1]", file, source, declaredSize: "size(300,200)", declaredRatio: 1.5, measuredWidth: 400, measuredHeight: 200, measuredRatio: 2 },
    ],
  });

  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  assert.equal(recorded.changes.length, 2);

  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.sections[0].figures[0].asymptoteAspectRatio, 2);
  assert.equal(after.sections[0].examples[1].asymptoteAspectRatio, 2);
  assert.ok(after.sections[0].figures[0].asymptoteSource.includes("size(400,200)"));
  assert.ok(after.sections[0].examples[1].asymptoteSource.includes("size(400,200)"));

  rmSync(dir, { recursive: true, force: true });
});
