// The figure contract, in one place, because two consumers depend on it and they must not drift.
//
// The build (scripts/build-figures.mjs) writes the figure manifest. The API (MAX-4) serves it
// and the frontend (MAX-5) renders it. All three need the same two things: how a figure is
// addressed, and which fields travel to a learner. Both live here so a change to either is a
// single edit that every consumer picks up, instead of three copies that disagree at runtime.
//
// The address is figureKey, a stable string derived from the content record that owns the
// figure. It is not a filename and not an array index into a response: a lesson section gains
// and loses figures as the corpus grows, and a key that shifts means a learner is served the
// wrong figure.

export const DERIVED_FIELDS = ["figureSvgUrl", "figureHash", "figurePipelineVersion"];

export const AUTHORED_FIELDS = ["asymptoteSource", "asymptoteAlt", "asymptoteAspectRatio"];

// The figure payload. These eight fields and no others reach a figure route. Everything else in
// a manifest entry (asymptoteVersion, declaredAspectRatio tolerance internals) is build
// provenance and stays behind the build.
export const FIGURE_PAYLOAD_FIELDS = [
  "figureKey",
  "figureSvgUrl",
  "figureHash",
  "figurePipelineVersion",
  "declaredAspectRatio",
  "compiledAspectRatio",
  "alt",
  "captionLatex",
];

// On a lesson or exercise response a consumer gets the reference, not the payload: the bytes come
// from the figure route. This list is the whole of what figure information may appear on a
// non-figure route, and the api tests assert that the payload fields never do.
//
// asymptoteAspectRatio is on the reference and not behind the figure route because of the no-reflow
// contract (Rendering Conventions §5.4 item 1): the reserved box has to be sized at first paint,
// and first paint of a figure happens before its payload has been fetched. A client that has to
// ask for the ratio in order to know the ratio cannot reserve anything, and the box then changes
// size when the SVG lands. It is one number rather than kilobytes of Asymptote source, and the two
// build inputs that *are* bulky or authoring-only -- asymptoteSource and asymptoteAlt -- stay
// behind the figure route. The client uses the number for the reservation only; the ratio the
// SVG actually has is still the payload's business.
export const FIGURE_REFERENCE_FIELDS = ["figureKey", "asymptoteAspectRatio"];

export function lessonFigureKey(lessonId, sectionName, index) {
  return `${lessonId}.sections.${sectionName}.figures[${index}]`;
}

export function exerciseFigureKey(exerciseId) {
  return `${exerciseId}`;
}

// A figure on a worked example. Derived from the record that owns it for the same reason section
// figures are: a lesson gains and loses worked examples, and a key that shifts with them means a
// learner is served the wrong figure.
export function exampleFigureKey(lessonId, sectionName, index) {
  return `${lessonId}.sections.${sectionName}.examples[${index}]`;
}

export function isPayloadField(field) {
  return FIGURE_PAYLOAD_FIELDS.includes(field);
}

// Project a manifest entry to the figure-route payload. A whitelist, not a blacklist: a field
// added to the manifest for build debugging is not automatically served to a learner.
export function toFigurePayload(entry) {
  if (!entry || typeof entry !== "object") return null;
  const payload = {};
  for (const field of FIGURE_PAYLOAD_FIELDS) {
    if (entry[field] !== undefined) payload[field] = entry[field];
  }
  return payload;
}

// What a lesson or exercise record carries instead of the payload. Built from the content
// record, not from the manifest, so a lesson still lists its figure reference when the build
// has not run -- and, for the same reason, the reservation is available before the figure route
// has ever answered.
export function figureReference(figureKey, aspectRatio) {
  if (!figureKey) return null;
  const ref = {};
  for (const field of FIGURE_REFERENCE_FIELDS) {
    if (field === "asymptoteAspectRatio") {
      // Omitted rather than blanked when the record did not author one: a null ratio on a
      // reference reads as "this figure has no shape", which is a different and wrong claim. The
      // client falls back to the documented default instead.
      const ratio = usableRatio(aspectRatio);
      if (ratio !== null) ref[field] = ratio;
      continue;
    }
    ref[field] = figureKey;
  }
  return ref;
}

// A ratio is usable when it is a positive finite number. Anything else -- null, 0, a negative
// number, a string, NaN -- is not a shape, and passing it through would put a value into a CSS
// aspect-ratio that the browser then has to reject.
export function usableRatio(value) {
  const ratio = typeof value === "number" ? value : Number(value);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}
