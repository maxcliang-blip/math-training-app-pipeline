import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FIGURE_PAYLOAD_FIELDS, figureReference, toFigurePayload } from "../../lib/figure-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const DEFAULT_MANIFEST = join(REPO, "artifacts", "figures", "manifest.json");

// The figure manifest, as the API consumes it.
//
// The manifest is written by scripts/build-figures.mjs and is the only source of the derived
// three (figureSvgUrl, figureHash, figurePipelineVersion). This module is the read side of that
// contract, kept next to the contract itself so MAX-4's routes and MAX-5's renderer cannot each
// invent their own idea of what a figure is.
//
// Two rules are load-bearing and are the reason this is a module and not a JSON import:
//
// 1. Fail closed. A missing manifest, a manifest that did not pass, or a figure with no hash is
//    not "no figure, carry on". It is a figure route that must not answer, because a learner
//    shown a figure with no hash has no way to tell a stale render from a current one and no way
//    to cache it safely. A build that shipped nothing is a broken build, not an empty catalogue.
//
// 2. The payload does not travel on other routes. Lesson and exercise responses carry
//    figureReference() and nothing else: a key, not an SVG, a hash, or a pipeline version. A
//    lesson list with three figures would otherwise carry three inline SVG documents, and the
//    hash would be the only way a client could tell that a lesson's figure had been rebuilt.
export class FigureStore {
  constructor(manifest, { path = DEFAULT_MANIFEST } = {}) {
    this.path = path;
    this.manifest = manifest;
    this.byKey = new Map();
    for (const entry of manifest.figures || []) {
      if (entry && entry.figureKey) this.byKey.set(entry.figureKey, entry);
    }
  }

  // A manifest that did not pass the build is served as a failure, not as a partial catalogue.
  get usable() {
    return this.manifest.status === "pass" && this.manifest.figures.length > 0;
  }

  get pipelineVersion() {
    return this.manifest.pipelineVersion;
  }

  get toolchain() {
    return this.manifest.toolchain;
  }

  keys() {
    return [...this.byKey.keys()];
  }

  has(figureKey) {
    return this.byKey.has(figureKey);
  }

  // The build's client cache key for a figure, or null. This is sha256(asymptoteSource + "|" +
  // pipelineVersion) computed at ingest (Rendering Conventions §5.5) and read here so a content
  // route can carry it on the figure reference without ever touching the source.
  //
  // Gated on `usable` for the same reason `get` is: a manifest the build did not pass attributes
  // nothing to a figure, so there is no build identity to hand out. A reference without one is
  // the degraded state, where the client has nothing to cache and refetches into the 503.
  cacheKey(figureKey) {
    if (!this.usable) return null;
    const entry = this.byKey.get(figureKey);
    if (!entry || typeof entry.figureCacheKey !== "string" || entry.figureCacheKey === "") return null;
    return entry.figureCacheKey;
  }

  // Every cache key the usable manifest knows, keyed by figureKey. The content store takes this
  // once at startup and reads it while building lesson and exercise responses, so the figure
  // store stays the only thing that knows what a figure is.
  cacheKeys() {
    const out = new Map();
    if (!this.usable) return out;
    for (const figureKey of this.byKey.keys()) {
      const key = this.cacheKey(figureKey);
      if (key) out.set(figureKey, key);
    }
    return out;
  }

  // The payload for the figure route, or null when there is nothing safe to serve. Null is the
  // only failure signal, and it is deliberately not an exception: an absent figure is an
  // expected answer for a figure that the build has not produced yet, and the route turns it
  // into a 404 rather than a 500.
  get(figureKey) {
    // Fail closed before the lookup, not after it: a manifest the build did not pass is not a
    // catalogue with a few bad rows in it, it is a build that did not finish.
    if (!this.usable) return null;
    const entry = this.byKey.get(figureKey);
    if (!entry) return null;
    if (!entry.figureHash || !entry.figureSvgUrl) return null;
    return toFigurePayload(entry);
  }

  // Every field a payload must carry, for the route's own contract test and for the check below.
  static get payloadFields() {
    return FIGURE_PAYLOAD_FIELDS;
  }
}

// Resolve a figure payload or throw with a reason a reader can act on. The route layer uses
// this when the figure is not optional, so a missing figure is a 503 naming the build rather
// than a 404 that looks like a bad request.
export function requireFigure(store, figureKey) {
  const payload = store.get(figureKey);
  if (payload) return payload;
  const reason = !store.usable
    ? `figure manifest at ${store.path} is not usable (status ${store.manifest.status}, ${store.manifest.figures.length} figures); run npm run content:figures`
    : store.has(figureKey)
      ? `figure ${figureKey} is in the manifest without a figureHash or figureSvgUrl`
      : `figure ${figureKey} is not in the manifest`;
  const err = new Error(reason);
  // 503 when the build has not produced a usable manifest: the figure is not wrong, the
  // pipeline is not done. 404 when the manifest is fine and this particular key is not in it.
  err.status = !store.usable ? 503 : 404;
  throw err;
}

export function loadFigureStore(path = process.env.FIGURE_MANIFEST || DEFAULT_MANIFEST) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `figure manifest ${path} is unreadable (${err.code || err.message}); the figure routes cannot answer without it and npm run content:figures writes it`,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`figure manifest ${path} is not valid JSON: ${err.message}`);
  }
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.figures)) {
    throw new Error(`figure manifest ${path} has no figures array; it is not a figure manifest`);
  }
  if (typeof manifest.pipelineVersion !== "string") {
    throw new Error(`figure manifest ${path} has no pipelineVersion; a figure cannot be attributed to a build`);
  }
  return new FigureStore({ status: "unknown", ...manifest }, { path });
}

export { figureReference, toFigurePayload, FIGURE_PAYLOAD_FIELDS };
