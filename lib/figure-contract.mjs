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

// On a lesson or exercise response the only thing a consumer gets is the reference. The payload
// is fetched from the figure route. This list is the whole of what figure information may
// appear on a non-figure route, and the api tests assert that the payload fields never do.
export const FIGURE_REFERENCE_FIELDS = ["figureKey"];

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
// has not run.
export function figureReference(figureKey) {
  if (!figureKey) return null;
  const ref = {};
  for (const field of FIGURE_REFERENCE_FIELDS) ref[field] = figureKey;
  return ref;
}
