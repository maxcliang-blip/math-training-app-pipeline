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
  figureUnavailableView,
  resolveFigureAlt,
  DEFAULT_FIGURE_ASPECT_RATIO,
  FIGURE_UNAVAILABLE_MESSAGE,
  resolveFigureRatio
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
// These exist because the ratio is applied to the <img> box, so a wrong one does not look broken —
// it draws the figure at the wrong shape. The regression that motivated them: a manifest declaring
// 2.667 next to an SVG whose intrinsic ratio is 4.505 rendered a number line 41% too tall.

test("reserves the compiled ratio before the SVG has loaded", () => {
  const r = resolveFigureRatio({ declaredAspectRatio: 1.5, compiledAspectRatio: 1.49 });
  assert.equal(r.reserved, 1.49, "the compiler's measurement beats the author's declaration");
  assert.equal(r.resolved, 1.49);
  assert.deepEqual(r.drift, []);
});

test("a measured ratio overrides the reserved one rather than stretching the figure", () => {
  const r = resolveFigureRatio({ declaredAspectRatio: 2.667, measuredAspectRatio: 4.505 });
  assert.equal(r.reserved, 2.667, "what the manifest claimed");
  assert.equal(r.resolved, 4.505, "what the browser actually measured");
});

test("declared and compiled disagreeing is reported, not resolved silently", () => {
  const r = resolveFigureRatio({ declaredAspectRatio: 3, compiledAspectRatio: 1.5 });
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

test("missing or nonsense ratios leave the box unconstrained", () => {
  for (const value of [null, undefined, 0, -2, NaN, Infinity, "2", {}]) {
    const r = resolveFigureRatio({ declaredAspectRatio: value, compiledAspectRatio: value });
    assert.equal(r.reserved, null, `${JSON.stringify(value)} must not reserve a box`);
    assert.equal(r.resolved, null);
    assert.deepEqual(r.drift, []);
  }
  assert.equal(resolveFigureRatio().resolved, null, "no inputs at all is not a crash");
});
