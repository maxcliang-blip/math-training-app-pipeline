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

// Which aspect ratio the <img> box should use, and whether the manifest's numbers disagree.
//
// Two ratios come from the build (declared is the author's, compiled is the compiler's) and a third
// from the browser once the SVG decodes. They are not equally trustworthy, and treating them as
// interchangeable is how a diagram ends up drawn at the wrong shape: applying the declared ratio to
// an SVG whose intrinsic ratio differs stretches the picture, and a stretched geometry figure
// teaches the wrong thing. The measured ratio wins for layout because it is the only one that
// describes the bytes actually being painted.
//
// The declared/compiled numbers still have a job — reserving the box before the SVG arrives — and a
// disagreement between them is a build defect worth reporting rather than silently picking a
// winner. This returns both so the component can reserve, then correct, then say so.
export function resolveFigureRatio({ declaredAspectRatio, compiledAspectRatio, measuredAspectRatio } = {}) {
  const usable = (value) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

  const declared = usable(declaredAspectRatio);
  const compiled = usable(compiledAspectRatio);
  const measured = usable(measuredAspectRatio);

  // Before the SVG arrives the compiler's measurement beats the author's declaration.
  const reserved = compiled ?? declared;
  const resolved = measured ?? reserved;

  const drift = [];
  if (declared && compiled && Math.abs(declared - compiled) / compiled > RATIO_TOLERANCE) {
    drift.push({ kind: "declared-vs-compiled", expected: declared, actual: compiled });
  }
  if (reserved && measured && Math.abs(reserved - measured) / measured > RATIO_TOLERANCE) {
    drift.push({ kind: "reserved-vs-measured", expected: reserved, actual: measured });
  }

  return { reserved, resolved, drift };
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
