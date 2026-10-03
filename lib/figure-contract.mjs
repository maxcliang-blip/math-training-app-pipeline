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

export const DERIVED_FIELDS = ["figureSvgUrl", "figureHash", "figurePipelineVersion", "figureCacheKey"];

export const AUTHORED_FIELDS = ["asymptoteSource", "asymptoteAlt", "asymptoteAspectRatio"];

// The figure payload. These nine fields and no others reach a figure route. Everything else in
// a manifest entry (asymptoteVersion, declaredAspectRatio tolerance internals) is build
// provenance and stays behind the build.
export const FIGURE_PAYLOAD_FIELDS = [
  "figureKey",
  "figureSvgUrl",
  "figureHash",
  "figurePipelineVersion",
  "figureCacheKey",
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
//
// figureCacheKey is the third field here and the only one that is not about the learner. It is
// sha256(asymptoteSource + "|" + pipelineVersion) — Rendering Conventions §5.5's cache key,
// computed by the build where both of its inputs exist and shipped as one opaque string. The rule
// asks for it because §5.5's cache is consulted *before* the fetch ("client hit ⇒ render
// immediately, no request"), so the client has to be holding the build identity before it asks for
// anything. The two fields that could have supplied it cannot: figureHash and
// figurePipelineVersion are on the payload, which is the answer to the question the key is asked
// on the way to. So the key rides here, next to the figureKey it belongs to, at 71 bytes per
// figure.
//
// This is the only reference field that can be missing, and its absence is meaningful rather than
// incidental: the build computes it, so a reference without one is a figure no build has
// compiled, which is the degraded state where the figure route cannot answer anyway. The two
// fields above it are built from the content record and are there precisely when the build has
// *not* run. See figureReference() for what the client does with that.
export const FIGURE_REFERENCE_FIELDS = ["figureKey", "asymptoteAlt", "figureCacheKey"];

export function lessonFigureKey(lessonId, sectionName, index) {
  return `${lessonId}.sections.${sectionName}.figures[${index}]`;
}

// --- What a figure is -------------------------------------------------------
//
// Three consumers count figures and they must not disagree: the build scans the corpus to decide
// what to compile, the authoring gate meters the S5.1 ceilings, and both report a total a human
// reads. They used to have three answers for one corpus (MAX-76): the gate reported 150 figures
// for an 83-figure corpus because it seeded the total with the declared figure records and then
// added one more for every record whose source parsed, double-counting all 63 of them, and
// because a reserved-but-unwritten record (`asymptoteSource: null` plus the caption and alt it
// will need) is a figure slot and not a figure. A budget that cannot be reproduced by the build
// it meters is not a budget, so the definition lives here and both sides call it.
//
// The definition: a figure is a record the build will render, which means a non-empty
// `asymptoteSource`. A record with `asymptoteSource: null` or `""` is a reservation -- the corpus
// holds several, four each in m5-l1 and m5-l2, authored ahead of their Asymptote. It renders
// nothing, it costs no compile, and counting it would put the §5.1 ceiling years ahead of the
// work. Reservations stay visible rather than silently uncounted: S5.1-figure-reserved in
// scripts/preflight-content.mjs reports every one of them.

export function isRenderableFigure(record) {
  return Boolean(record && record.asymptoteSource);
}

// Whether a record claims a figure slot at all. A worked example that ships no figure has no
// asymptoteSource, no alt and no ratio -- not null ones, no keys -- and it is not a figure waiting
// to be written, it is a worked example. A record that *does* spell the fields is claiming the
// slot, whether it has filled it (`asymptoteSource` non-empty) or reserved it (null).
//
// This is what separates a reservation from a non-figure, and it is why the walk below is not
// just "every entry in figures[] and examples[]": all 146 worked examples in the corpus are
// entries in an examples array, and reporting 146 of them as reserved figure slots would be the
// same category error MAX-76 was filed for, one level down.
export function declaresFigure(record) {
  if (!record || typeof record !== "object") return false;
  return AUTHORED_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(record, field));
}

// Every figure record a lesson declares, filled or reserved, in the order the build walks it:
// each section's `figures` then that same section's worked-example figures, sections in record
// order. Each entry carries the figureKey the build addresses it under, so a consumer that reports
// or checks a figure cannot invent a different address for it.
//
// `kind` is "section" or "example" -- the only distinction the S5.1 ceilings need, because the
// per-concept ceiling counts section figures and the worked-example ceiling counts example
// figures. `sectionName` is kept because the address contains it and a lesson may hang a figure
// off a section other than `concept` (m9-l3 and m9-l4 do, on `objective`).
//
// Reservations are in this list on purpose. A reserved record is not a figure, but it is still a
// record an author can get wrong -- an alt text or a ratio left on a figure with no source is a
// contradiction, and S9-alt-mandatory is the rule that catches it -- so validation reads this list
// while budgets read lessonFigureSites below.
export function lessonFigureRecords(lesson) {
  const records = [];
  for (const [sectionName, section] of Object.entries((lesson && lesson.sections) || {})) {
    const list = section && section.figures;
    if (Array.isArray(list)) {
      list.forEach((record, index) => {
        if (!declaresFigure(record)) return;
        records.push({
          figureKey: lessonFigureKey(lesson.id, sectionName, index),
          kind: "section",
          sectionName,
          index,
          record,
        });
      });
    }
    const examples = section && section.examples;
    if (Array.isArray(examples)) {
      examples.forEach((record, index) => {
        if (!declaresFigure(record)) return;
        // Worked examples carry figures too, and they are figures on the same terms: an example
        // whose asymptoteSource reaches a client is build input on the request path, and the
        // figureKey the API emits has to resolve or the example just loses its figure.
        records.push({
          figureKey: exampleFigureKey(lesson.id, sectionName, index),
          kind: "example",
          sectionName,
          index,
          record,
        });
      });
    }
  }
  return records;
}

// The figures: the subset of lessonFigureRecords the build will compile. This is the list every
// figure *count* is taken from -- per section, per lesson, per corpus -- and the list the build
// compiles. There is no second count anywhere.
export function lessonFigureSites(lesson) {
  return lessonFigureRecords(lesson).filter((site) => isRenderableFigure(site.record));
}

export function lessonFigureCount(lesson) {
  return lessonFigureSites(lesson).length;
}

// The corpus total, over the same records the build scans. An exercise or fixture carries at most
// one figure, so the count is the number of records with a source -- but it is counted here rather
// than by each consumer's own filter, for the reason above.
export function countFigures(lessons, exercises) {
  let total = 0;
  for (const lesson of lessons || []) total += lessonFigureCount(lesson);
  for (const exercise of exercises || []) if (isRenderableFigure(exercise)) total += 1;
  return total;
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
//
// cacheKey is the one input that cannot come from the content record, because it is a hash of the
// source folded together with the pipeline version and neither is knowable without the build. It
// is passed in from the figure store and omitted when the store has no entry for the key, so the
// shape here is: always figureKey, asymptoteAlt when the author wrote one, figureCacheKey when a
// build produced this figure.
export function figureReference(figureKey, alt, cacheKey) {
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
    if (field === "figureCacheKey") {
      // Omitted when the build produced no entry for this key, and never defaulted to the
      // figureKey: a client that falls back to the address is back to serving the previous
      // build's bytes for the life of the tab, which is the bug this field exists to remove.
      // A reference with no cache key says "no build, no bytes", and the client refetches rather
      // than memoizing under an identity that means nothing.
      if (typeof cacheKey === "string" && cacheKey.trim() !== "") ref[field] = cacheKey;
      continue;
    }
    ref[field] = figureKey;
  }
  return ref;
}
