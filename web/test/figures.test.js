// Unit tests for the figure client.
//
// The two things worth testing hard here are the 503 path and the payload whitelist, because both
// are contract requirements rather than implementation choices: the API is required to make
// toolchain-missing a hard 503, and only eight named fields may reach a learner.

import test from "node:test";
import assert from "node:assert/strict";
import {
  createFigureClient,
  figureCacheSlot,
  figureRoute,
  figureAssetUrl,
  validateFigurePayload,
  isToolchainMissing,
  isSameOriginPath,
  figureUnavailableView,
  resolveFigureAlt,
  DEFAULT_FIGURE_ASPECT_RATIO,
  FIGURE_UNAVAILABLE_MESSAGE,
  resolveFigureRatio

} from "../src/lib/figures.js";

const KEY = "m1-linear-equations.figures[0]";

// Two build identities for the same figure, shaped like the keys scripts/build-figures.mjs emits:
// sha256(asymptoteSource + "|" + pipelineVersion). They differ only in the pipeline version, which
// is what makes them the same figure at two points in time.
const BUILD_A = `sha256:${"a".repeat(64)}`;
const BUILD_B = `sha256:${"b".repeat(64)}`;

function payload(overrides = {}) {
  return {
    figureKey: KEY,
    figureSvgUrl: "/artifacts/figures/svg/m1-linear-equations-figures-0.svg",
    figureHash: "sha256:abc123",
    figurePipelineVersion: "3",
    figureCacheKey: "sha256:" + "a".repeat(64),
    declaredAspectRatio: 1.5,
    compiledAspectRatio: 1.49,
    alt: "A line crossing the x-axis at two units",
    captionLatex: "The roots of $x^2 - 2x = 0$",
    ...overrides
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

test("encodes the figure key into a path segment", () => {
  // Unencoded, this key contains dots, brackets and a space, and the route does not match.
  const route = figureRoute(KEY);
  assert.equal(route, `/api/figures/${encodeURIComponent(KEY)}`);
  assert.ok(!route.includes("["), "brackets are encoded");
  assert.ok(!route.includes(" "), "spaces are encoded");
  assert.equal(decodeURIComponent(route.replace("/api/figures/", "")), KEY, "it round-trips");
});

test("an empty figure key has no route", () => {
  assert.equal(figureRoute(""), null);
  assert.equal(figureRoute(null), null);
  assert.equal(figureRoute(undefined), null);
});

test("fetches a passing manifest entry and serves it ready", async () => {
  const client = createFigureClient({ fetchImpl: async () => jsonResponse(200, payload()) });
  const result = await client.getFigure(KEY);
  assert.equal(result.status, "ready");
  assert.equal(result.figureKey, KEY);
  assert.equal(result.src, "/artifacts/figures/svg/m1-linear-equations-figures-0.svg");
});

test("a 503 is toolchain-missing, not a broken figure", async () => {
  const client = createFigureClient({
    fetchImpl: async () =>
      jsonResponse(503, { error: "toolchain-missing", status: "toolchain-missing" })
  });
  const result = await client.getFigure(KEY);
  assert.equal(result.status, "toolchain-missing");
  assert.equal(result.reason, "pipeline-not-run");
  // Not what the learner is told. The status stays on data-reason; the sentence does not.
  assert.equal(figureUnavailableView(result).message, FIGURE_UNAVAILABLE_MESSAGE);
  assert.equal(figureUnavailableView(result).detail, "pipeline-not-run");
});

test("a build that never ran and a 404 do not look the same", async () => {
  // The whole reason toolchain-missing is a hard 503 rather than an empty list: the client has to
  // be able to tell them apart.
  const missing = createFigureClient({
    fetchImpl: async () => jsonResponse(503, { status: "toolchain-missing" })
  });
  const notFound = createFigureClient({ fetchImpl: async () => jsonResponse(404, {}) });
  assert.notEqual((await missing.getFigure(KEY)).status, (await notFound.getFigure(KEY)).status);
});

test("a 503 with an HTML body from a proxy is still toolchain-missing", async () => {
  const client = createFigureClient({
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error("Unexpected token < in JSON");
      }
    })
  });
  const result = await client.getFigure(KEY);
  assert.equal(result.status, "toolchain-missing");
});

test("recognises the toolchain-missing status in a few shapes", () => {
  assert.equal(isToolchainMissing({ status: "toolchain-missing" }), true);
  assert.equal(isToolchainMissing({ error: "toolchain-missing" }), true);
  assert.equal(isToolchainMissing({ status: "ok" }), false);
  assert.equal(isToolchainMissing(null), false);
});

test("a network failure is unavailable, never toolchain-missing", async () => {
  // A learner on a train is not the same as a broken build, and reporting it as one hides a real
  // outage behind a message that says "we have not run the build yet".
  const client = createFigureClient({
    fetchImpl: async () => {
      throw new Error("network down");
    }
  });
  const result = await client.getFigure(KEY);
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "network");
});

test("rejects a payload missing a field needed to render", () => {
  for (const field of ["figureKey", "figureSvgUrl", "figureHash"]) {
    const broken = payload();
    delete broken[field];
    const result = validateFigurePayload(broken);
    assert.equal(result.ok, false, `${field} is required`);
    assert.equal(result.reason, `missing:${field}`);
  }
});

test("accepts a payload carrying build provenance, and drops it", () => {
  // The whitelist is the point: asymptoteSource is kilobytes of build input per figure and must
  // never reach a learner even if it arrives on the wire.
  const result = validateFigurePayload(
    payload({ asymptoteSource: "import graph; size(200,200);", asymptoteVersion: "3.1" })
  );
  assert.equal(result.ok, true);
  assert.equal("asymptoteSource" in result.payload, false);
  assert.equal("asymptoteVersion" in result.payload, false);
});

test("rejects a payload whose figureSvgUrl leaves the origin", () => {
  const result = validateFigurePayload(payload({ figureSvgUrl: "https://cdn.evil.example/x.svg" }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "off-origin-figureSvgUrl");
});

test("accepts a same-origin path and rejects a protocol-relative one", () => {
  assert.equal(isSameOriginPath("/artifacts/figures/svg/a.svg"), true);
  assert.equal(isSameOriginPath("//cdn.evil.example/a.svg"), false);
  assert.equal(isSameOriginPath("https://cdn.evil.example/a.svg"), false);
  assert.equal(isSameOriginPath(""), false);
});

test("a non-object payload is invalid, not a crash", () => {
  for (const value of [null, undefined, "svg", 7]) {
    assert.equal(validateFigurePayload(value).ok, false);
  }
});

test("caches per build key so revisiting a lesson does not refetch", async () => {
  let calls = 0;
  const client = createFigureClient({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(200, payload());
    }
  });
  await client.getFigure(KEY, { figureCacheKey: BUILD_A });
  await client.getFigure(KEY, { figureCacheKey: BUILD_A });
  assert.equal(calls, 1);
});

test("a rebuilt figure is refetched: same figureKey, new cache key, no stale bytes", async () => {
  // The bug this is filed for. figureKey is the figure's position in the content record and is
  // deliberately stable across rebuilds, so keying the cache on it alone meant a figure
  // recompiled under a new PIPELINE_VERSION -- or after a source edit -- hit the same slot and
  // served the previous build's SVG for the life of the tab, with nothing to indicate it.
  //
  // Both halves matter. The first getFigure has to populate the cache (or this test passes against
  // a client with no cache at all, which is the mistake a single-fetch test cannot catch), and the
  // second has to arrive with a different build identity and get different bytes.
  const served = [];
  let calls = 0;
  const client = createFigureClient({
    fetchImpl: async () => {
      calls += 1;
      const current = payload({ figureSvgUrl: `/artifacts/figures/svg/rebuild-${calls}.svg` });
      served.push(current.figureSvgUrl);
      return jsonResponse(200, current);
    }
  });

  const first = await client.getFigure(KEY, { figureCacheKey: BUILD_A });
  assert.equal(first.status, "ready");
  assert.equal(calls, 1);

  // Same key: the cache is working, and this is the assertion that distinguishes it from no cache.
  const cached = await client.getFigure(KEY, { figureCacheKey: BUILD_A });
  assert.equal(calls, 1, "an unchanged build is served from the cache");
  assert.equal(cached.src, first.src);

  // Same figureKey, new build: the cache must miss and the new bytes must arrive.
  const rebuilt = await client.getFigure(KEY, { figureCacheKey: BUILD_B });
  assert.equal(calls, 2, "a changed build key must not be served from the cache");
  assert.notEqual(rebuilt.src, first.src);
  assert.deepEqual(served, ["/artifacts/figures/svg/rebuild-1.svg", "/artifacts/figures/svg/rebuild-2.svg"]);

  // And the old entry is still there for a learner who navigates back to the pre-rebuild view.
  assert.equal((await client.getFigure(KEY, { figureCacheKey: BUILD_A })).src, first.src);
  assert.equal(calls, 2);
});

test("the cache slot is the build identity, and only falls back to the address when there is none", () => {
  // Two slots, not one, because a fallback key cannot tell a current render from a rebuilt one.
  assert.equal(figureCacheSlot(KEY, BUILD_A), `build:${BUILD_A}`);
  assert.notEqual(figureCacheSlot(KEY, BUILD_A), figureCacheSlot(KEY, BUILD_B));
  assert.equal(figureCacheSlot(KEY, null), `figure:${KEY}`);
  // A figureKey can never share a slot with a hash, even if some future key format looks like one.
  assert.notEqual(figureCacheSlot(KEY, null), figureCacheSlot(BUILD_A, null));
  for (const blank of ["", "   ", 7, undefined]) {
    assert.equal(figureCacheSlot(KEY, blank), `figure:${KEY}`, `${JSON.stringify(blank)} is not a build key`);
  }
});

test("a payload fetched with no build key is returned but never memoized", async () => {
  // The honest cost of a missing figureCacheKey is a repeat request. The bug it replaces was
  // stale bytes with no signal, and there is no third option: without a build identity, nothing in
  // hand says whether the cached render is the current one.
  let calls = 0;
  const client = createFigureClient({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(200, payload());
    }
  });
  assert.equal((await client.getFigure(KEY)).status, "ready");
  assert.equal((await client.getFigure(KEY)).status, "ready");
  assert.equal(calls, 2, "no build key, no memoized bytes");

  // The moment a key arrives the cache is used again, from the same client.
  assert.equal((await client.getFigure(KEY, { figureCacheKey: BUILD_A })).status, "ready");
  assert.equal((await client.getFigure(KEY, { figureCacheKey: BUILD_A })).status, "ready");
  assert.equal(calls, 3);
});

test("caches the toolchain-missing result too, but not a network failure", async () => {
  // A build can start and finish between requests, so a 503 is cached for the session. A network
  // blip is not: caching that would leave a figure permanently missing after one bad request.
  let missingCalls = 0;
  const missing = createFigureClient({
    fetchImpl: async () => {
      missingCalls += 1;
      return jsonResponse(503, { status: "toolchain-missing" });
    }
  });
  await missing.getFigure(KEY);
  await missing.getFigure(KEY);
  assert.equal(missingCalls, 1);

  let netCalls = 0;
  const flaky = createFigureClient({
    fetchImpl: async () => {
      netCalls += 1;
      throw new Error("down");
    }
  });
  await flaky.getFigure(KEY);
  await flaky.getFigure(KEY);
  assert.equal(netCalls, 2);
});

test("an empty key is invalid without a request", async () => {
  let called = false;
  const client = createFigureClient({
    fetchImpl: async () => {
      called = true;
      return jsonResponse(200, payload());
    }
  });
  assert.equal((await client.getFigure("")).status, "invalid");
  assert.equal(called, false);
});

test("every status has a degraded view, so a new status cannot ship unstyled", () => {
  for (const status of ["ready", "unavailable", "invalid", "toolchain-missing"]) {
    const view = figureUnavailableView({ status, reason: "x" });
    assert.equal(view.kind, "unavailable");
    assert.ok(view.message.length > 0);
  }
});

// --- the degraded state (Rendering Conventions §5.6) ----------------------
//
// §5.6: "SVG missing / fetch failed | Reserved box keeps its size, alt text rendered *visibly* |
// 'Figure unavailable — the description below is complete.'" and "The degraded state is visibly
// degraded, not silently empty: the alt text is shown to everyone, not just assistive tech."
//
// The interesting property is not that the copy is right. It is that the copy is reachable: in
// every degraded status there is no payload, so `alt` has to come from the reference the caller
// passed, and the reference is the only thing a client still has when the figure route has failed.

test("the degraded copy is §5.6's sentence, for every status that degrades", () => {
  assert.equal(
    FIGURE_UNAVAILABLE_MESSAGE,
    "Figure unavailable — the description below is complete."
  );
  for (const status of ["unavailable", "invalid", "toolchain-missing"]) {
    const view = figureUnavailableView({ status, reason: "http-503" });
    assert.equal(view.message, FIGURE_UNAVAILABLE_MESSAGE);
    assert.equal(view.detail, "http-503", `${status} stays distinguishable on data-reason`);
  }
});

test("the description survives the endpoint failing, because it came from the reference", async () => {
  const reference = { figureKey: KEY, asymptoteAlt: "A line crossing the x-axis at two units" };
  const client = createFigureClient({
    fetchImpl: async () => jsonResponse(503, { status: "toolchain-missing" })
  });
  const result = await client.getFigure(reference.figureKey);
  const view = figureUnavailableView(result, { alt: reference.asymptoteAlt });
  assert.equal(view.alt, reference.asymptoteAlt);
});

test("the payload's alt wins over the prop, and an absent one is null rather than a blank", () => {
  assert.equal(resolveFigureAlt("from the payload", "from the caller"), "from the payload");
  assert.equal(resolveFigureAlt(null, "from the caller"), "from the caller");
  assert.equal(resolveFigureAlt(undefined, undefined), null);
  for (const blank of ["", "   "]) {
    assert.equal(resolveFigureAlt(blank, blank), null, `${JSON.stringify(blank)} is not a description`);
  }
});

test("the degraded box keeps its size: the reserved ratio, or the documented default", () => {
  // A degraded box that collapses to the height of two lines of text is a reflow, and §5.4 forbids
  // one. With no payload there is no compiled ratio to reserve from, so the authored one is used
  // and the documented default is the floor.
  assert.equal(figureUnavailableView({ status: "unavailable" }).aspectRatio, DEFAULT_FIGURE_ASPECT_RATIO);
  assert.equal(DEFAULT_FIGURE_ASPECT_RATIO, 1.333);
  assert.equal(
    figureUnavailableView({ status: "unavailable" }, { declaredAspectRatio: 0.661 }).aspectRatio,
    0.661
  );
  assert.equal(
    figureUnavailableView({ status: "unavailable" }, { declaredAspectRatio: -3 }).aspectRatio,
    DEFAULT_FIGURE_ASPECT_RATIO,
    "a nonsense ratio falls back rather than handing the browser a value it has to reject"
  );
});

test("a missing reason is null, not the string 'undefined'", () => {
  assert.equal(figureUnavailableView({ status: "unavailable" }).detail, null);
  assert.equal(figureUnavailableView(null).detail, null);
});

test("resolves a relative asset url against an origin", () => {
  assert.equal(figureAssetUrl("/a.svg", "https://app.example"), "https://app.example/a.svg");
  assert.equal(figureAssetUrl("https://x/a.svg", "https://app.example"), "https://x/a.svg");
  assert.equal(figureAssetUrl("", "https://app.example"), null);
});

// --- aspect ratio resolution ----------------------------------------------
//
// These exist because the ratio sizes the box, so a wrong one does not look broken — it either
// moves the page under the reader or draws the figure at the wrong shape. The regression that
// motivated them: a manifest declaring 2.667 next to an SVG whose intrinsic ratio is 4.505
// rendered a number line 41% too tall, and then resized the box again when the SVG decoded.

test("the box is sized from the authored ratio, before anything is fetched", () => {
  // RC §5.4 item 1: sized from asymptoteAspectRatio at first paint. The authored ratio is the only
  // one on the element at first paint, because the payload has not been asked yet.
  const r = resolveFigureRatio({ declaredAspectRatio: 1.5 });
  assert.equal(r.reserved, 1.5);
  assert.deepEqual(r.drift, []);
});

test("the compiler's ratio stands in for a figure that declares none", () => {
  const r = resolveFigureRatio({ compiledAspectRatio: 1.49 });
  assert.equal(r.reserved, 1.49);
});

test("a figure that declares nothing is reserved at the documented default", () => {
  // 1.333 is the default RC §5.4 item 1 names. The failure this replaces was worse than a wrong
  // default: with no ratio at all the box was a min-height, so it was 3rem tall while pending and
  // full height once the SVG landed, and that transition is the layout shift.
  for (const input of [{}, { declaredAspectRatio: null }, { declaredAspectRatio: 0 }, { declaredAspectRatio: -2 }]) {
    assert.equal(resolveFigureRatio(input).reserved, 1.333, JSON.stringify(input));
  }
  assert.equal(DEFAULT_FIGURE_ASPECT_RATIO, 1.333, "the default is one value, named once");
});

test("the browser's measurement never resizes the box", () => {
  // The whole point. Applying the measurement after load is what made the box depend on when the
  // SVG decoded, and on the deployed corpus the two numbers disagree on 65 of 69 figures.
  const r = resolveFigureRatio({ declaredAspectRatio: 2.667, compiledAspectRatio: 2.5, measuredAspectRatio: 4.505 });
  assert.equal(r.reserved, 2.667, "the box keeps the ratio it was reserved at");
  assert.equal(r.reserved, r.reserved, "stable across the load");
  // It is not discarded though: the disagreement is the report.
  assert.deepEqual(r.drift, [
    { kind: "declared-vs-compiled", expected: 2.667, actual: 2.5 },
    { kind: "reserved-vs-measured", expected: 2.667, actual: 4.505 }
  ]);
  assert.equal(r.measured, 4.505, "the measurement is returned for the report");
});

test("declared and compiled disagreeing is reported, not resolved silently", () => {
  const r = resolveFigureRatio({ declaredAspectRatio: 3, compiledAspectRatio: 1.5 });
  assert.equal(r.reserved, 3, "the authored ratio still sizes the box");
  assert.deepEqual(r.drift, [{ kind: "declared-vs-compiled", expected: 3, actual: 1.5 }]);
});

test("a reserved ratio that disagrees with the SVG is reported", () => {
  const r = resolveFigureRatio({ declaredAspectRatio: 2.667, measuredAspectRatio: 4.505 });
  assert.deepEqual(r.drift, [{ kind: "reserved-vs-measured", expected: 2.667, actual: 4.505 }]);
});

test("rounding inside the tolerance is not drift", () => {
  // The manifest rounds to three decimals, so 1.49 and 1.5 are the same picture.
  const r = resolveFigureRatio({ declaredAspectRatio: 1.5, compiledAspectRatio: 1.49, measuredAspectRatio: 1.495 });
  assert.deepEqual(r.drift, []);
});

test("both drift kinds are reported when both are wrong", () => {
  const r = resolveFigureRatio({ declaredAspectRatio: 3, compiledAspectRatio: 1.5, measuredAspectRatio: 4 });
  assert.deepEqual(
    r.drift.map((d) => d.kind),
    ["declared-vs-compiled", "reserved-vs-measured"]
  );
});

test("a nonsense measurement is ignored rather than reserved", () => {
  // A browser that reports 0x0 for a decode it could not size must not be able to size a box.
  const r = resolveFigureRatio({ declaredAspectRatio: 1.5, measuredAspectRatio: 0 });
  assert.equal(r.reserved, 1.5);
  assert.equal(r.measured, null);
  assert.deepEqual(r.drift, []);
});

test("a numeric string ratio is read, not discarded", () => {
  // The manifest is JSON written by the build and the authoring record is JSON written by a person;
  // neither should be able to reserve an unreserved box by quoting a number.
  assert.equal(resolveFigureRatio({ declaredAspectRatio: "2.5" }).reserved, 2.5);
  assert.equal(resolveFigureRatio({ declaredAspectRatio: "wide" }).reserved, 1.333);
});

test("no inputs at all is not a crash", () => {
  assert.equal(resolveFigureRatio().reserved, 1.333);
  assert.deepEqual(resolveFigureRatio().drift, []);
});
