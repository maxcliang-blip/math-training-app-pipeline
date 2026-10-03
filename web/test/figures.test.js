// Unit tests for the figure client.
//
// The two things worth testing hard here are the 503 path and the payload whitelist, because both
// are contract requirements rather than implementation choices: the API is required to make
// toolchain-missing a hard 503, and only eight named fields may reach a learner.

import test from "node:test";
import assert from "node:assert/strict";
import {
  createFigureClient,
  figureRoute,
  figureAssetUrl,
  validateFigurePayload,
  isToolchainMissing,
  isSameOriginPath,
  figurePlaceholder,
  resolveFigureRatio,
  DEFAULT_FIGURE_ASPECT_RATIO
} from "../src/lib/figures.js";

const KEY = "m1-linear-equations.figures[0]";

function payload(overrides = {}) {
  return {
    figureKey: KEY,
    figureSvgUrl: "/artifacts/figures/svg/m1-linear-equations-figures-0.svg",
    figureHash: "sha256:abc123",
    figurePipelineVersion: "3",
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
  assert.ok(figurePlaceholder(result).label.includes("not built"));
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

test("caches per key so revisiting a lesson does not refetch", async () => {
  let calls = 0;
  const client = createFigureClient({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(200, payload());
    }
  });
  await client.getFigure(KEY);
  await client.getFigure(KEY);
  assert.equal(calls, 1);
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

test("every status has a placeholder, so a new status cannot ship unstyled", () => {
  for (const status of ["ready", "unavailable", "invalid", "toolchain-missing"]) {
    const placeholder = figurePlaceholder({ status, reason: "x" });
    assert.equal(placeholder.kind, "unavailable");
    assert.ok(placeholder.label.length > 0);
  }
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
