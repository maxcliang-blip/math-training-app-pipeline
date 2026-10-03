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
// asymptoteAlt is on the reference, and not behind the figure route, because of Rendering
// Conventions §5.6: in the degraded state the alt text is rendered *visibly* -- "the degraded state
// is visibly degraded, not silently empty". The degraded state is precisely the state in which the
// figure route never answered: a build that produced no usable manifest makes that route a hard 503
// for every key, so there is no payload and no `alt` to read. An alt text that only exists on the
// route that failed is an alt text no learner ever sees, which is the bug this field fixes. It is
// one authored sentence per figure, it is written for a reader rather than for the build, and it is
// what lets §8.6 be asserted: with the endpoint forced to fail the description is still there.
//
// asymptoteSource stays behind the build. It is the build input, it is kilobytes per figure, and
// the description being available without it does not make the source available without it.
export const FIGURE_REFERENCE_FIELDS = ["figureKey", "asymptoteAlt"];

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
// has not run -- which is also the only moment the description is of any use, because it is the
// degraded state that has to render it (see FIGURE_REFERENCE_FIELDS).
export function figureReference(figureKey, alt) {
  if (!figureKey) return null;
  const ref = {};
  for (const field of FIGURE_REFERENCE_FIELDS) {
    if (field === "asymptoteAlt") {
      // Omitted rather than blanked when the record authored none: an empty alt text reads as
      // "this figure has no description", which is a different and wrong claim. Every figure in
      // the corpus authors one, and a reference without one leaves the degraded box saying only
      // that the figure is gone.
      if (typeof alt === "string" && alt.trim() !== "") ref[field] = alt;
      continue;
    }
    ref[field] = figureKey;
  }
  return ref;
}
