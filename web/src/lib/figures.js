// Fetching and validating figure payloads against the figure contract.
//
// The contract is a single file shared by the build, the API and this module, so a field added
// for build debugging is not automatically served and not automatically rendered. The whitelist
// here is `FIGURE_PAYLOAD_FIELDS` from that file, imported rather than copied, which is the whole
// point of putting it there.
//
// The cache key is the other half of the contract. `figureCacheKey` arrives on the figure
// reference from the content route, is derived by the build from the Asymptote source and the
// pipeline version, and is what this module keys its cache on — see figureCacheSlot below and
// Rendering Conventions §5.5.
//
// The 503 case is the one that matters. `GET /api/figures` answers 503 `toolchain-missing` when
// the build has not produced a manifest, and a client that treats that as an error has no way to
// tell "figures are broken" from "there are no figures here". A learner should see the prose and
// a quiet placeholder, never a red error box over a lesson that is otherwise fine.

import {
  FIGURE_PAYLOAD_FIELDS,
  toFigurePayload,
  usableRatio
} from "../../../lib/figure-contract.mjs";

// A 503 from the figure route carries the pipeline status. This is the shape of that body,
// minus the guarantee that it has one: a proxy in front of the API can 503 with anything.
export function isToolchainMissing(body) {
  if (!body || typeof body !== "object") return false;
  return body.status === "toolchain-missing" || body.error === "toolchain-missing";
}

// Keep only the fields the contract says may reach a learner, and require the three that make a
// payload renderable. A payload missing figureSvgUrl cannot be drawn, and drawing a figure with
// a caption and no image looks like a bug to the learner, so it is rejected here rather than
// half-rendered by the component.
const REQUIRED = ["figureKey", "figureSvgUrl", "figureHash"];

export function validateFigurePayload(raw) {
  const payload = toFigurePayload(raw);
  if (!payload) return { ok: false, reason: "not-an-object" };
  for (const field of REQUIRED) {
    if (typeof payload[field] !== "string" || payload[field] === "") {
      return { ok: false, reason: `missing:${field}`, payload };
    }
  }
  // A figureSvgUrl off-origin is either a build mistake or a way to pull the learner's browser
  // somewhere the app does not control. Same-origin relative paths are what the API emits.
  if (!isSameOriginPath(payload.figureSvgUrl)) {
    return { ok: false, reason: "off-origin-figureSvgUrl", payload };
  }
  return { ok: true, payload, fields: FIGURE_PAYLOAD_FIELDS };
}

export function isSameOriginPath(url) {
  if (typeof url !== "string" || url === "") return false;
  if (url.startsWith("/")) return !url.startsWith("//");
  return /^https?:\/\//i.test(url) === false;
}

// figureKey is "<lessonId>:<exerciseId>" style and contains dots, brackets and spaces. Encoding it
// as a path segment is not optional: a raw key turns `/api/figures/m1.sections.intro.figures[0]`
// into a route that does not match, and the learner sees a 404 instead of a figure.
export function figureRoute(figureKey, apiBase = "") {
  if (typeof figureKey !== "string" || figureKey === "") return null;
  return `${apiBase}/api/figures/${encodeURIComponent(figureKey)}`;
}

export function figureAssetUrl(figureSvgUrl, origin = "") {
  if (typeof figureSvgUrl !== "string" || figureSvgUrl === "") return null;
  return figureSvgUrl.startsWith("/") ? `${origin}${figureSvgUrl}` : figureSvgUrl;
}

// How far a ratio may drift before it counts as a discrepancy. The manifest rounds to three
// decimals, so anything inside this band is rounding and not a disagreement.
const RATIO_TOLERANCE = 0.02;

// The ratio a figure box is sized at when nothing authored one. From Rendering Conventions §5.4
// item 1 ("default 1.333", IA §7 gap 1). A box with no ratio is not neutral, it is unreserved: it
// collapses to the height of its content, so it is a thin line while nothing is in it and a
// different height once something is. That is the reflow the reserved box exists to prevent, and
// the degraded state is where it is most visible, because there the content arriving is two lines
// of text inside a box that is supposed to hold a diagram.
export const DEFAULT_FIGURE_ASPECT_RATIO = 1.333;


// Which aspect ratio the figure box is sized at, and whether the manifest's numbers disagree.
//
// Three ratios are in play and they are not equally trustworthy: the author's declaration, the
// compiler's measurement of the built SVG, and the browser's measurement once the SVG decodes.
//
// The box is sized from the author's declaration and from nothing else, once, on the figure's
// first paint. That is the whole no-reflow contract (§5.4 items 1 and 5): the reserved box and the
// loaded box must be the same box, so nothing that arrives later may resize it. Applying the
// browser's measurement to the box is what made the layout depend on load timing — the measured
// ratio replaced the reservation after first paint, and on the deployed corpus the reservation and
// the measurement disagree on 65 of 69 figures, so the box changed height under the reader.
//
// The compiler's and the browser's numbers are still worth having: they say whether the authored
// declaration is true. They are returned as drift, and the component records it, because a figure
// drawn at the wrong shape is a build defect to fix in the authoring record or the compiler and
// not in the stylesheet. The <img> is laid into the box with object-fit: contain, so a declaration
// that turns out to be wrong letterboxes the picture instead of distorting the geometry.
// "Is this a shape", asked with the contract's own predicate rather than a second copy of it. The
// number reaches the client as JSON and the authoring record holds it as whatever the author typed,
// so the same value arrives here as a number on one path and a string on the other -- and two copies
// of the predicate are two chances to disagree about which strings are ratios.
const usable = usableRatio;

export function resolveFigureRatio({ declaredAspectRatio, compiledAspectRatio, measuredAspectRatio } = {}) {
  const declared = usable(declaredAspectRatio);
  const compiled = usable(compiledAspectRatio);
  const measured = usable(measuredAspectRatio);

  // The authored declaration wins because it is the only one available at first paint; the
  // compiler's measurement is the fallback for a figure that somehow reached the client without
  // one. The measurement is deliberately not in this expression.
  const reserved = declared ?? compiled ?? DEFAULT_FIGURE_ASPECT_RATIO;

  const drift = [];
  if (declared && compiled && Math.abs(declared - compiled) / compiled > RATIO_TOLERANCE) {
    drift.push({ kind: "declared-vs-compiled", expected: declared, actual: compiled });
  }
  if (reserved && measured && Math.abs(reserved - measured) / measured > RATIO_TOLERANCE) {
    drift.push({ kind: "reserved-vs-measured", expected: reserved, actual: measured });
  }

  return { reserved, declared, compiled, measured, drift };
}

// The build identity a call carries, or null. Whitespace is not an identity: a blank key would be
// a cache slot shared by every figure that had one, which is the same failure as keying on the
// address, and it would fail silently rather than loudly.
export function figureBuildKey(figureCacheKey) {
  return typeof figureCacheKey === "string" && figureCacheKey.trim() !== "" ? figureCacheKey : null;
}

// Which cache entry a getFigure call reads and writes.
//
// Rendering Conventions §5.5: the client cache is keyed on sha256(asymptoteSource + "|" +
// pipelineVersion), so "pipeline version is part of the key" and "the cache key is the source
// hash plus the pipeline version". The build computes that key (scripts/build-figures.mjs) and
// the API carries it on the figure reference, because §5.5 reads the cache *before* the fetch:
// "client hit ⇒ render immediately, no request". A key derived from the response could only ever
// describe bytes already in hand.
//
// Keying this on figureKey alone — which is what the address is, and what it used to be keyed on —
// says nothing about which build produced the SVG. figureKey is the figure's position in the
// content record (`m1-l3.sections.concept.figures[0]`) and is deliberately stable across rebuilds,
// so a figure recompiled under a new PIPELINE_VERSION, or after a source edit, hit the same slot
// and served the previous build's bytes for the life of the tab with nothing to indicate it.
//
// The two prefixes are namespaces, not decoration. They keep a build-derived identity from ever
// sharing a slot with a fallback that means something weaker, and they let the caller below store
// only what a build key authorizes: a `ready` payload is never memoized under `figure:`, because
// an entry in that namespace was fetched with no build identity and so cannot be proven current.
export function figureCacheSlot(figureKey, figureCacheKey) {
  const build = figureBuildKey(figureCacheKey);
  return build === null ? `figure:${figureKey}` : `build:${build}`;
}

// Per-key cache. Figures are immutable for a given figureHash, and a lesson page asks for the
// same figure every time the learner navigates back to it — keyed on the build that produced it,
// so a rebuilt figure is fetched again rather than served from the previous build's entry.
export function createFigureClient({ fetchImpl, apiBase = "", origin = "" } = {}) {
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  const cache = new Map();

  async function getFigure(figureKey, { figureCacheKey = null } = {}) {
    if (!doFetch) return { status: "unavailable", reason: "no-fetch", figureKey };
    const url = figureRoute(figureKey, apiBase);
    if (!url) return { status: "invalid", reason: "empty-figureKey", figureKey };

    const build = figureBuildKey(figureCacheKey);
    const slot = figureCacheSlot(figureKey, build);
    if (cache.has(slot)) return cache.get(slot);

    let response;
    try {
      response = await doFetch(url);
    } catch (error) {
      // Network failure is not a figure problem. The lesson still renders.
      return { status: "unavailable", reason: "network", figureKey, error: String(error) };
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (response.status === 503 || isToolchainMissing(body)) {
      const result = { status: "toolchain-missing", reason: "pipeline-not-run", figureKey };
      // Cached with or without a build key: a pipeline that has not run is not a payload, so
      // there are no bytes here that a later build could contradict. The next view that arrives
      // with a cache key lands in a different slot and asks again.
      cache.set(slot, result);
      return result;
    }
    if (!response.ok) {
      return { status: "unavailable", reason: `http-${response.status}`, figureKey };
    }

    const validated = validateFigurePayload(body);
    if (!validated.ok) {
      return { status: "invalid", reason: validated.reason, figureKey };
    }

    const result = {
      status: "ready",
      figureKey,
      ...validated.payload,
      src: figureAssetUrl(validated.payload.figureSvgUrl, origin)
    };
    // Only a build-keyed payload is memoized. Without a figureCacheKey there is no way to tell a
    // current render from a rebuilt one, so the bytes are returned and not kept: the honest cost
    // is a repeat request, and the bug this replaces was stale bytes served with no signal.
    if (build !== null) cache.set(slot, result);
    return result;
  }

  return { getFigure };
}

// The one sentence the degraded state shows. Verbatim from Rendering Conventions §5.6, because the
// wording is the contract: the learner is told the figure is missing and told that what follows is
// the whole description of it, which is what makes the state usable rather than alarming.
//
// The status that produced it is not in this sentence. toolchain-missing, a 404 and a dropped
// connection are different bugs with different fixes, and they stay readable on data-reason -- but
// they are deployment facts, and a learner cannot act on one. "Figure not built yet" as the whole
// message told a learner nothing about the figure they were trying to read.
export const FIGURE_UNAVAILABLE_MESSAGE = "Figure unavailable — the description below is complete.";

// The alt text for whichever figure this is.
//
// The payload's alt wins over the prop: it came from the authoring record that owns the figure, so
// it describes that figure rather than whatever placeholder text a caller passed. In the degraded
// state there is no payload to win, so the answer is the description the reference carried -- which
// is why FIGURE_REFERENCE_FIELDS carries asymptoteAlt, since the degraded state is the one state in
// which the figure route cannot supply it.
export function resolveFigureAlt(payloadAlt, propAlt) {
  for (const candidate of [payloadAlt, propAlt]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return null;
}

// Everything the degraded box shows, decided here rather than in the component.
//
// Two reasons it is not JSX. The first is the repo's rule that anything assertable stays out of a
// component (see web/test/latex.test.js). The second is that this is the state with no test
// coverage to speak of until now, and §8.6 asks for an assertion that the alt text is in the DOM as
// visible text when the figure endpoint fails -- which needs the whole chain (endpoint failure, the
// view this produces, the box the component draws) to be reachable from a test.
//
// aspectRatio is the reserved ratio, so the box keeps the size it was reserved at. The figure never
// arrives, so there is no measurement to correct it with and nothing should change the box: a
// degraded box that collapses to the height of two lines of text is a reflow at the exact moment
// the reader is already looking at something that went wrong.
export function figureUnavailableView(result, { alt, declaredAspectRatio } = {}) {
  return {
    kind: "unavailable",
    message: FIGURE_UNAVAILABLE_MESSAGE,
    detail: result?.reason ?? null,
    alt: resolveFigureAlt(result?.alt, alt),
    aspectRatio: resolveFigureRatio({ declaredAspectRatio }).reserved ?? DEFAULT_FIGURE_ASPECT_RATIO
  };
}
