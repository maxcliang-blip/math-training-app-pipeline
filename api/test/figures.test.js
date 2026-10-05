import { test } from "node:test";
import assert from "node:assert";
import { cpSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
        figureCacheKey: "sha256:feedface",
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
  const ref = figureReference("m1-l1.sections.concept.figures[0]", "a number line with five dots", "sha256:feedface", 2.667);
  assert.deepEqual(Object.keys(ref), FIGURE_REFERENCE_FIELDS);
  assert.equal(ref.asymptoteAlt, "a number line with five dots");
  assert.equal(ref.asymptoteAspectRatio, 2.667);
  // The payload fields that are not reference fields are the figure route's alone. The ones that
  // are on both are on the reference because the client reads them before the fetch (§5.5 for the
  // cache key, §5.4 item 1 for the ratio).
  for (const field of FIGURE_PAYLOAD_FIELDS.filter((f) => !FIGURE_REFERENCE_FIELDS.includes(f))) {

    assert.equal(field in ref, false, `${field} must not appear on a lesson or exercise response`);
  }
});


test("a reference carries the build's cache key, and omits it rather than inventing one", () => {
  // §5.5: the client cache is read before the fetch, so the build identity has to be on the
  // reference. It is a hash of the source folded with the pipeline version, computed by the build
  // because the source itself never leaves it.
  const keyed = figureReference("m1-l1.sections.concept.figures[0]", "dots", "sha256:feedface");
  assert.equal(keyed.figureCacheKey, "sha256:feedface");

  // No usable build means no key. Substituting the figureKey here is the bug this field was added
  // to fix: an address that survives a rebuild cannot tell a current render from a stale one.
  for (const none of [null, undefined, "", "   "]) {
    const ref = figureReference("m1-l1.sections.concept.figures[0]", "dots", none);
    assert.equal("figureCacheKey" in ref, false, `${JSON.stringify(none)} is not a build key`);
    assert.equal(ref.figureKey, "m1-l1.sections.concept.figures[0]", "the address is still there");
  }
});

test("a reference with no authored description omits it rather than blanking it", () => {
  // An empty description reads as "this figure has no description", which is a different and wrong
  // claim, and the degraded box would render an empty paragraph where the description belongs.
  assert.deepEqual(Object.keys(figureReference("k", "   ", "sha256:feedface", 4)), ["figureKey", "figureCacheKey", "asymptoteAspectRatio"]);
  assert.deepEqual(Object.keys(figureReference("k", undefined, null, 4)), ["figureKey", "asymptoteAspectRatio"]);
  assert.deepEqual(Object.keys(figureReference("k")), ["figureKey"]);
  assert.deepEqual(Object.keys(figureReference("k", null, null)), ["figureKey"]);
  assert.equal(figureReference(""), null);
});

test("\u00a75.5's cache key is sha256(source | pipelineVersion), computed at ingest", async () => {
  // Rendering Conventions \u00a75.5 names the key and the API names the two jobs it has to do:
  // "The same source produces the same SVG for the same pipeline version -- the cache key is the
  // source hash plus the pipeline version", and "Pipeline version is part of the key so a renderer
  // upgrade invalidates cleanly." Both are assertions about this one function, and both are made
  // here rather than inferred, because a key that quietly stopped including the pipeline version
  // would invalidate on a source edit and not on the upgrade it exists for.
  const { figureCacheKey, PIPELINE_VERSION } = await import("../../scripts/build-figures.mjs");
  const { createHash } = await import("node:crypto");
  const source = "import graph;\nsize(200,100);\ndraw((0,0)--(1,1));\n";

  // The rule, literally, with the sha256: prefix that figureHash also uses.
  assert.equal(
    figureCacheKey(source, PIPELINE_VERSION),
    `sha256:${createHash("sha256").update(`${source}|${PIPELINE_VERSION}`).digest("hex")}`
  );
  assert.equal(figureCacheKey(source, PIPELINE_VERSION), figureCacheKey(source, PIPELINE_VERSION));
  // A source edit is a different figure.
  assert.notEqual(figureCacheKey(source, PIPELINE_VERSION), figureCacheKey(`${source}// edit\n`, PIPELINE_VERSION));
  // A renderer upgrade is a different build of the same figure, which is the bullet that matters.
  // The counter-version is derived from the constant rather than written as a literal: MAX-75
  // moved PIPELINE_VERSION to asymptote-svg-sanitized@3, so a hardcoded "@3" is this build's own
  // version and the assertion would compare a value with itself and pass for the wrong reason.
  assert.notEqual(figureCacheKey(source, PIPELINE_VERSION), figureCacheKey(source, `${PIPELINE_VERSION}-next`));
  // And the version that actually reaches the key is the fingerprinted one, not the constant:
  // MAX-77 made figurePipelineVersion pipelineVersionFor(toolchain), so a build that recorded the
  // bare constant beside a fingerprinted key would be describing two different builds at once.
  const { pipelineVersionFor } = await import("../../scripts/build-figures.mjs");
  const fingerprinted = pipelineVersionFor({ version: "Asymptote version 2.87", dvisvgmVersion: "dvisvgm 3.2.1", texliveVersion: "TeX Live 2023" });
  assert.notEqual(figureCacheKey(source, PIPELINE_VERSION), figureCacheKey(source, fingerprinted));
  // The default is this build's own version, so the build cannot emit a key for a pipeline it did
  // not run.
  assert.equal(figureCacheKey(source), figureCacheKey(source, PIPELINE_VERSION));
  // It reaches the client, which is the reason it is computed here and not in the browser.
  assert.ok(FIGURE_PAYLOAD_FIELDS.includes("figureCacheKey"));
  assert.ok(FIGURE_REFERENCE_FIELDS.includes("figureCacheKey"));
});

test("the figure store hands the build's cache keys to the content store, or none at all", () => {
  // The usable manifest is the only source of a cache key. An unusable one attributes nothing to
  // a figure, so the reference falls back to carrying no key and the client has nothing to cache.
  const usable = new FigureStore(manifest());
  assert.equal(usable.cacheKey("m1-l1.sections.concept.figures[0]"), "sha256:feedface");
  assert.deepEqual([...usable.cacheKeys()], [["m1-l1.sections.concept.figures[0]", "sha256:feedface"]]);
  assert.equal(usable.cacheKey("not-in-the-manifest"), null);

  const failed = new FigureStore(manifest({ status: "fail" }));
  assert.equal(failed.cacheKey("m1-l1.sections.concept.figures[0]"), null);
  assert.equal(failed.cacheKeys().size, 0);

  // A manifest written before this field existed has none, and is not given one by guessing.
  const legacy = new FigureStore(manifest({ figures: [{ ...manifest().figures[0], figureCacheKey: undefined }] }));
  assert.equal(legacy.cacheKey("m1-l1.sections.concept.figures[0]"), null);
});

test("a figure that declares no usable ratio gets no ratio on its reference", () => {
  // Omitted rather than blanked, and certainly not defaulted here: the default belongs to the
  // renderer (web/src/lib/figures.js), so the value in the document is always one that was authored.
  for (const value of [undefined, null, 0, -1, NaN, "wide", {}]) {
    const ref = figureReference("k", null, null, value);
    assert.deepEqual(Object.keys(ref), ["figureKey"], `${JSON.stringify(value)} must not invent a shape`);
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

test("the drift gate fires on a source edit that was never restated, and is not dead code", async () => {
  const { classifyDrift } = await import("../../scripts/build-figures.mjs");

  // The steady state, and the reason this check looks dead: the record pass writes declared =
  // measured, so a clean corpus drifts 0. That is the design. The declaration is a committed
  // assertion about what the compiler will produce, and restating it is a separate deliberate
  // act. Editing a figure's source moves the rendered box and leaves the assertion behind --
  // which is what this catches, and it is exactly what MAX-31's corpus did 51 times out of 55
  // while every figure passed authoring.
  assert.deepEqual(classifyDrift(2, 2), { drift: 0, level: "pass" });

  // The un-restated edit. A figure declared 1.333 that compiles 321x240 does not quietly render
  // wrong; it is rejected.
  const drifted = classifyDrift(1.333, 1);
  assert.equal(drifted.level, "reject");
  assert.ok(drifted.drift > 0.05, `expected a real drift, got ${drifted.drift}`);

  // Symmetric: a figure that got *taller* drifts the same way.
  assert.equal(classifyDrift(1.333, 4).level, "reject");

  // The two tiers, on S5.4 item 4's numbers, and they are not loosened to fit this corpus.
  assert.equal(classifyDrift(1, 1.015).level, "pass");
  assert.equal(classifyDrift(1, 1.03).level, "warn");
  assert.equal(classifyDrift(1, 1.06).level, "reject");
});

test("the build refuses to record a figure whose ceiling is below the legibility floor", async () => {
  const { validateFigure } = await import("../../scripts/build-figures.mjs");
  const base = {
    declaredRatio: 1.333,
    alt: "A figure description long enough to satisfy the alt text rule.",
  };

  // The gap MAX-95 was raised against: size(60,45) has a perfectly legal 1.333 ratio, so it clears
  // MIN_ASPECT/MAX_ASPECT and every other extent check in the pipeline. Before this floor it passed
  // validateFigure() and rendered too small to read.
  const tiny = validateFigure({ ...base, source: "draw((0,0)--(1,1)); size(60,45);" });
  assert.equal(tiny.problems.length, 1);
  assert.match(tiny.problems[0], /80pt legibility floor/);
  assert.match(tiny.problems[0], /W=60, H=45/);
  // The box is still read and returned, so the rejection is about the ceiling and nothing else --
  // an author who raises the ceiling gets a usable box back, not a null.
  assert.deepEqual(tiny.box, { width: 60, height: 45, ratio: 1.333 });

  // One dimension is enough to fail, and it names itself. A figure too thin to hold a label beside
  // what it labels is a real failure while its height is generous.
  const thin = validateFigure({ ...base, source: "draw((0,0)--(1,1)); size(60,240);" });
  assert.equal(thin.problems.length, 1);
  assert.match(thin.problems[0], /W=60/);
  assert.doesNotMatch(thin.problems[0], /H=240pt/);

  // The floor is on absolute size, not on ratio: the accepted cases span ratios from 0.5 to 3.
  for (const source of [
    "draw((0,0)--(1,1)); size(80,240);", // 0.333 -- under the aspect band, so rejected, but by S9
    "draw((0,0)--(1,1)); size(240,80);",
    "draw((0,0)--(1,1)); size(80,80);", // exactly on the floor, and it is allowed
    "draw((0,0)--(1,1)); size(320,240);",
    "draw((0,0)--(1,1)); size(640,120);", // 5.33 -- over the aspect band, but the floor is not why
  ]) {
    const result = validateFigure({ ...base, source });
    const floor = result.problems.filter((p) => p.includes("legibility floor"));
    assert.equal(
      floor.length,
      0,
      `unexpected floor rejection for ${source}: ${JSON.stringify(result.problems)}`,
    );
  }

  // Nothing that passed before this floor is rejected now. On origin/main all 91 corpus ceilings use
  // the two-argument form, the smallest declared dimension is 111, and nothing is under 80 -- so
  // the floor is additive and changes no existing verdict. size(320,240) is the shape the existing
  // "the size() verdict is unchanged" test on this gate already pins, and it must stay clean.
  assert.deepEqual(validateFigure({ ...base, source: "draw((0,0)--(1,1)); size(320,240);" }).problems, []);
});

test("the build gate and the authoring rule read the same floor", async () => {
  // Two files declare MIN_SIZE_FLOOR, because scripts/preflight-content.mjs is documented as
  // runnable with no repo and cannot import the build script, while the build script deliberately
  // has no dependency on the authoring gate or on katex. The cost of that split is a measured
  // constant that could drift apart silently, so this pins them together.
  const build = await import("../../scripts/build-figures.mjs");
  const preflight = await import("../../scripts/preflight-content.mjs");

  assert.equal(build.MIN_SIZE_FLOOR, 80);
  assert.equal(preflight.MIN_SIZE_FLOOR, 80);

  // And they have to agree on behaviour, not only on the number: a ceiling the build accepts must
  // not be one the authoring rule reports. Driven through the authoring rule's own engine over a
  // copy of the real corpus, with one figure's ceiling rewritten in place, so the assertion covers
  // the rule rather than a synthetic fixture that could pass for the wrong reason.
  const dir = mkdtempSync(join(tmpdir(), "size-floor-"));
  try {
    cpSync(join(REPO, "content"), dir, { recursive: true });
    const lessonsDir = join(dir, "lessons");
    const files = readdirSync(lessonsDir).filter((f) => f.endsWith(".json")).sort();
    const ordered = files
      .map((f) => ({ file: f, record: JSON.parse(readFileSync(join(lessonsDir, f), "utf8")) }))
      .sort((a, b) => String(a.record.id).localeCompare(String(b.record.id)));
    const victim = ordered.find(({ record }) => {
      const figures = record.sections && record.sections.concept && record.sections.concept.figures;
      return Array.isArray(figures) && figures.some((f) => typeof f.asymptoteSource === "string");
    });
    assert.ok(victim, "the corpus must contain a figure with a source to rewrite");

    const restate = (w, h) => {
      const [fig] = victim.record.sections.concept.figures.filter(
        (f) => typeof f.asymptoteSource === "string",
      );
      fig.asymptoteSource = fig.asymptoteSource.replace(
        /size\s*\(\s*[\d.]+\s*,\s*[\d.]+\s*\)/,
        `size(${w}, ${h})`,
      );
      writeFileSync(join(lessonsDir, victim.file), JSON.stringify(victim.record, null, 2) + "\n");
      return preflight.run(dir).report.findings.filter((f) => f.rule === "S5.2-size-floor");
    };

    assert.equal(restate(60, 45).length, 1, "size(60,45) must be reported");
    assert.equal(restate(60, 240).length, 1, "a too-thin width alone must be reported");

    // The exact boundary, both sides of it: on the floor passes, one unit under fails.
    assert.equal(restate(80, 80).length, 0, "a ceiling exactly on the floor must pass");
    assert.equal(restate(79, 240).length, 1, "one unit under the floor must fail");

    // And a one-argument call keeps its own single verdict: it declares no box to read a floor
    // from, so S5.2-size-floor must stay quiet and S5.4-ratio-unverifiable must be the finding.
    const [oneArgFigure] = victim.record.sections.concept.figures.filter(
      (f) => typeof f.asymptoteSource === "string",
    );
    oneArgFigure.asymptoteSource = oneArgFigure.asymptoteSource.replace(
      /size\s*\(\s*[\d.]+\s*,\s*[\d.]+\s*\)/,
      "size(300)",
    );
    writeFileSync(join(lessonsDir, victim.file), JSON.stringify(victim.record, null, 2) + "\n");
    const single = preflight.run(dir).report.findings;
    assert.equal(single.some((f) => f.rule === "S5.2-size-floor"), false);
    assert.equal(single.some((f) => f.rule === "S5.4-ratio-unverifiable"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the record pass refuses to bless a figure that compiles outside the S9 #8 band", async () => {
  const { recordAspectRatios } = await import("../../scripts/build-figures.mjs");
  const dir = mkdtempSync(join(tmpdir(), "record-band-"));
  const file = join(dir, "m2-l1.json");
  const source = "// a number line\nsize(320,240);\ndraw((0,0)--(320,0));";
  writeFileSync(
    file,
    JSON.stringify({ sections: [{ figures: [{ asymptoteSource: source, asymptoteAlt: "a horizontal number line", asymptoteAspectRatio: 1.333 }] }] }, null, 2) + "\n",
  );

  // 321x37 is what the corpus's number line really compiles to, and it renders as a sliver in
  // the box it reserves. Recording 8.676 would turn a figure that has to be redrawn into a
  // declaration that looks authoritative, so the pass stops instead.
  const out = recordAspectRatios({
    measurements: [
      { key: "m2-l1.sections.concept.figures[0]", file, source, declaredSize: "size(320,240)", declaredRatio: 1.333, measuredWidth: 321, measuredHeight: 37, measuredRatio: 8.676 },
    ],
  });

  assert.equal(out.ok, false);
  assert.match(out.error, /outside the \[0.5, 3\] band/);
  assert.match(out.error, /Redraw the figure/);
  // The corpus must be left exactly as it was found: a refused pass writes nothing.
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.sections[0].figures[0].asymptoteAspectRatio, 1.333);
  assert.ok(after.sections[0].figures[0].asymptoteSource.includes("size(320,240)"));

  rmSync(dir, { recursive: true, force: true });
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
  // Each figure gets its own measured ratio.
  assert.equal(a.asymptoteAspectRatio, 1.25);
  assert.equal(b.asymptoteAspectRatio, 2);
  // Neither figure's size(W,H) is touched: it is a ceiling that binds, so writing the measured
  // box into it would make the compiler rescale and move the measurement again. See
  // "A bootstrap whose output depends on how many times you have run it is not a bootstrap."
  assert.equal(a.asymptoteSource, "size(320,240);\ndraw((0,0)--(1,1));");
  assert.equal(b.asymptoteSource, "size(320,240);\ndraw((0,0)--(2,1));");

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
  // The shared source is left exactly as the author wrote it, once, in both places.
  assert.ok(after.sections[0].figures[0].asymptoteSource.includes("size(300,200)"));
  assert.ok(after.sections[0].examples[1].asymptoteSource.includes("size(300,200)"));

  rmSync(dir, { recursive: true, force: true });
});

test("recording a ratio written as 1.0 leaves valid JSON behind", async () => {
  const { recordAspectRatios } = await import("../../scripts/build-figures.mjs");
  const dir = mkdtempSync(join(tmpdir(), "record-spelling-"));
  const file = join(dir, "m3-l4.json");
  const source = "// a path on five dots\nsize(400,400);\nfor (int i = 0; i < 5; ++i) dot((i,0));";
  writeFileSync(
    file,
    [
      "{",
      '  "figures": [',
      '    {',
      `      "asymptoteSource": ${JSON.stringify(source)},`,
      '      "asymptoteAlt": "five dots in a row joined by four segments",',
      // Prettier preserves the spelling it was given, so this file says 1.0 where the parsed
      // value is 1. A pass that rebuilt its search token from the parsed value would match the
      // "1" and leave the ".0" behind.
      '      "asymptoteAspectRatio": 1.0',
      "    }",
      "  ]",
      "}",
      "",
    ].join("\n"),
  );

  const recorded = recordAspectRatios({
    measurements: [
      { key: "k", file, source, declaredSize: "size(400,400)", declaredRatio: 1, measuredWidth: 406, measuredHeight: 400, measuredRatio: 1.015 },
    ],
  });

  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  // The failure this pins is not a wrong number, it is a corpus that no longer parses.
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.figures[0].asymptoteAspectRatio, 1.015);
  assert.match(readFileSync(file, "utf8"), /"asymptoteAspectRatio": 1\.015\s*\n/);

  rmSync(dir, { recursive: true, force: true });
});

test("the record pass reaches a fixed point instead of walking the corpus", async () => {
  const { recordAspectRatios } = await import("../../scripts/build-figures.mjs");
  const dir = mkdtempSync(join(tmpdir(), "record-fixed-point-"));
  const file = join(dir, "m3-l1.json");
  const source = "// a grid of dots\nsize(300,200);\ndraw((0,0)--(3,1));";
  writeFileSync(
    file,
    JSON.stringify({ sections: [{ figures: [{ asymptoteSource: source, asymptoteAlt: "a grid of dots in a wide frame", asymptoteAspectRatio: 1.5 }] }] }, null, 2) + "\n",
  );

  // A record pass whose output depends on how many times you have run it cannot be reviewed or
  // re-run safely. The loop it used to be in: size(W,H) is a ceiling, so writing the measured box
  // into it makes the compiler rescale the content, the measurement moves up, and the next pass
  // records a slightly taller box. On the corpus that ran 14 changes, then 7, then 6, then 3, each
  // a point taller. Restating only asymptoteAspectRatio leaves the compiler's input alone, so the
  // second pass has nothing to do.
  const measurement = () => [
    {
      key: "m3-l1.sections.concept.figures[0]",
      file,
      source,
      declaredSize: "size(300,200)",
      declaredRatio: JSON.parse(readFileSync(file, "utf8")).sections[0].figures[0].asymptoteAspectRatio,
      measuredWidth: 421,
      measuredHeight: 311,
      measuredRatio: 1.354,
    },
  ];

  const first = recordAspectRatios({ measurements: measurement() });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.changes.length, 1);

  const second = recordAspectRatios({ measurements: measurement() });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(second.changes, [], "a second pass over an already-recorded corpus must be a no-op");

  const third = recordAspectRatios({ measurements: measurement() });
  assert.deepEqual(third.changes, [], "and it must stay a no-op, not drift one point per run");

  rmSync(dir, { recursive: true, force: true });
});

// MAX-77. Rendering Conventions S5.2 told authors to "prefer size(300)" twice while the gate
// rejected size(300), and the rejection message justified itself by claiming the reserved space was
// a function of the size() call. That premise was retired by MAX-59: size(W,H) is a ceiling, and
// asymptoteAspectRatio is recorded from the compiled viewBox, so the box is known after layout.
// These three tests pin the two facts that came out of the ruling so neither can come back
// unnoticed -- the messages an author reads, and the version string the cache key is built from.

test("no size() rejection message claims the reserved space depends on the call", async () => {
  const { validateFigure } = await import("../../scripts/build-figures.mjs");
  const base = { declaredRatio: 1.333, alt: "A figure description long enough to satisfy the alt rule." };

  const oneArg = validateFigure({ ...base, source: "draw((0,0)--(1,1)); size(300);" });
  const noCall = validateFigure({ ...base, source: "draw((0,0)--(1,1));" });

  assert.equal(oneArg.problems.length, 1);
  assert.equal(noCall.problems.length, 1);

  // The retired premise in its three forms. "cannot be known before layout" is the sentence that
  // was wrong; the other two are the shapes the same wrong belief takes when it is reworded.
  for (const { problems } of [oneArg, noCall]) {
    for (const premise of [
      "cannot be known before layout",
      "reserved space cannot be known",
      "so the pipeline knows its dimensions",
    ]) {
      assert.equal(
        problems.some((p) => p.includes(premise)),
        false,
        `a size() rejection still asserts a retired premise: ${JSON.stringify(problems)}`,
      );
    }
  }

  // Both rejections must also say what the call actually is, or the author is left with a rule and
  // no reason. The correction is the point, not a softened version of the wrong claim.
  assert.match(oneArg.problems[0], /ceiling bounds the output/);
  assert.match(oneArg.problems[0], /compiled viewBox/);
});

test("the size() verdict is unchanged: the ceiling is still required and still read as two numbers", async () => {
  const { validateFigure } = await import("../../scripts/build-figures.mjs");
  const base = { declaredRatio: 1.333, alt: "A figure description long enough to satisfy the alt rule." };

  // The two-argument form 66 of 83 corpus figures use is accepted, and the ceiling is still read
  // out of it -- the fix was to the message, not to the gate.
  const two = validateFigure({ ...base, source: "draw((0,0)--(1,1)); size(320,240);" });
  assert.deepEqual(two.problems, []);
  assert.deepEqual(two.box, { width: 320, height: 240, ratio: 1.333 });

  // Every one of these still rejects. MAX-60 S3.9 recorded all four; the ruling under review was
  // about what the rule *says*, and none of these verdicts was on the table to change.
  for (const source of [
    "draw((0,0)--(1,1));",
    "draw((0,0)--(1,1)); size(300);",
    "draw((0,0)--(1,1)); size(300,300,ignore);",
    "draw((0,0)--(1,1)); size((300,300),ignore);",
  ]) {
    const result = validateFigure({ ...base, source });
    assert.equal(result.problems.length > 0, true, `expected a rejection for ${source}`);
    assert.equal(result.box, null);
  }
});

test("the pipeline version keys on the toolchain, not only on the emitter constant", async () => {
  const { PIPELINE_VERSION, pipelineVersionFor } = await import("../../scripts/build-figures.mjs");

  // The bug: PIPELINE_VERSION is a fixed string, so an SVG built by bookworm's asy 2.85 and one
  // built by ubuntu-latest's asy 2.87 hashed to the same cache key and neither could detect the
  // other as stale. This repository had both, plus a third in scripts/asy-docker.
  const bookworm = { version: "Asymptote version 2.85 (Debian 2:2.85-1)", dvisvgmVersion: "dvisvgm 2.11.1", texliveVersion: "pdfTeX 3.141592653-2.6-1.40.24 (TeX Live 2022/Deb 2022)" };
  const ubuntu = { version: "Asymptote version 2.87 (built 2023)", dvisvgmVersion: "dvisvgm 3.2.1", texliveVersion: "pdfTeX 3.141592653-2.6-1.40.26 (TeX Live 2023/Deb 2024)" };
  assert.notEqual(pipelineVersionFor(bookworm), pipelineVersionFor(ubuntu));

  // Different fonts, same asy: still a different artifact, so still a different key.
  const otherFonts = { ...ubuntu, texliveVersion: "pdfTeX 3.141592653-2.6-1.40.26 (TeX Live 2025)" };
  assert.notEqual(pipelineVersionFor(ubuntu), pipelineVersionFor(otherFonts));

  // A key that moved for a reason that cannot change a glyph is not a key: the build date and
  // host on the same --version line must not invalidate every figure on an image rebuild.
  assert.equal(pipelineVersionFor(ubuntu), pipelineVersionFor({ ...ubuntu, version: "Asymptote version 2.87 (built 2024)" }));

  // The emitter constant is still the prefix, so a pipeline change is still visible in the key.
  for (const t of [bookworm, ubuntu]) assert.ok(pipelineVersionFor(t).startsWith(`${PIPELINE_VERSION}+`));

  // No toolchain is the authoring-only path, and it has no environment to report.
  assert.equal(pipelineVersionFor(null), PIPELINE_VERSION);

  // An unreadable component is named, not omitted: "unknown" is what two environments differing
  // only in fonts are, from here.
  assert.match(pipelineVersionFor({ ...ubuntu, texliveVersion: null }), /texlive-unknown/);
});
