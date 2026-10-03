// Fetching and validating figure payloads against the figure contract.
//
// The contract is a single file shared by the build, the API and this module, so a field added
// for build debugging is not automatically served and not automatically rendered. The whitelist
// here is `FIGURE_PAYLOAD_FIELDS` from that file, imported rather than copied, which is the whole
// point of putting it there.
//
// The 503 case is the one that matters. `GET /api/figures` answers 503 `toolchain-missing` when
// the build has not produced a manifest, and a client that treats that as an error has no way to
// tell "figures are broken" from "there are no figures here". A learner should see the prose and
// a quiet placeholder, never a red error box over a lesson that is otherwise fine.

import {
  FIGURE_PAYLOAD_FIELDS,
  toFigurePayload
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

// The ratio a figure box is sized at when the authoring record declares none. Named by Rendering
// Conventions §5.4 item 1, which sizes the box from asymptoteAspectRatio "(default 1.333, from the
// IA doc §7 gap 1)". A box with no ratio at all is not a neutral default, it is an unreserved box:
// it collapses to the height of its content, so it is zero-height while pending and full-height
// once the SVG lands. That transition is the layout shift the whole section exists to forbid.
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

function usable(value) {
  if (typeof value === "string" && value.trim() !== "") value = Number(value);
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

// Per-key cache. Figures are immutable for a given figureHash, and a lesson page asks for the
// same figure every time the learner navigates back to it.
export function createFigureClient({ fetchImpl, apiBase = "", origin = "" } = {}) {
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  const cache = new Map();

  async function getFigure(figureKey) {
    if (!doFetch) return { status: "unavailable", reason: "no-fetch", figureKey };
    const url = figureRoute(figureKey, apiBase);
    if (!url) return { status: "invalid", reason: "empty-figureKey", figureKey };

    if (cache.has(figureKey)) return cache.get(figureKey);

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
      cache.set(figureKey, result);
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
    cache.set(figureKey, result);
    return result;
  }

  return { getFigure };
}

// What a learner should see for each status. Kept next to the statuses so a new status cannot be
// added without deciding what it looks like.
export function figurePlaceholder(result) {
  switch (result.status) {
    case "toolchain-missing":
      return { kind: "unavailable", label: "Figure not built yet", detail: result.reason };
    case "invalid":
      return { kind: "unavailable", label: "Figure unavailable", detail: result.reason };
    default:
      return { kind: "unavailable", label: "Figure unavailable", detail: result.reason };
  }
}
