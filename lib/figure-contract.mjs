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

// ---------------------------------------------------------------------------
// TeX label payloads: the string literals a figure hands to TeX
// ---------------------------------------------------------------------------
//
// This lives here, not in either of its two consumers, because the two of them are the failure
// this section exists to close (MAX-119).
//
// Asymptote copies a string literal into the .tex it generates for a TeX label *verbatim*. It does
// not read `\\` as an escape, so a LaTeX macro written with a doubled backslash inside label("...")
// reaches TeX as two backslashes. What happens then depends on where it is:
//
//   * immediately after `^` or `_`  -> FATAL. TeX's ^ takes exactly one token, `\\` is a control
//     symbol rather than a character, and the figure fails to compile with "Missing { inserted".
//   * anywhere else                 -> the figure COMPILES CLEAN and renders the wrong glyphs.
//     TeX reads `\\` as a line break and then sets the bare macro name in italic. Nothing reports
//     it, at authoring time or at build time.
//
// The build (scripts/build-figures.mjs) has always known this -- `diagnoseCompileFailure` calls
// doubledBackslashMacros -- but it calls it from the failure path, so a figure that compiles clean
// never reaches the only code that could have named it. MAX-62 found 34 such sites by hand and
// MAX-111 repaired 12 figures one at a time; both are re-runs of work a rule does automatically.
//
// The authoring gate (scripts/preflight-content.mjs) never looked inside a label(...) at all. So
// the two halves were: a detector that runs only when the figure is already broken, and a gate
// that never runs.
//
// It has to be a source-shape rule and not a render rule, and that is not a preference. Measured
// against the pinned katex@0.16.11, every one of these broken label bodies renders without error:
//
//     \frac{a}{b}   \sqrt{x-2}   b\cos C   \lceil 7/3 \rceil   \theta
//     3^{2}\equiv 1\pmod{8}   4 \cdot 3 \cdot 2 = 24   \angle AOB
//     \frac{a}{\sin A} = 2R
//
// Only `90^\circ` is rejected, and only because the doubling happens to sit after a `^`. So the
// one case a render-based rule catches is precisely the case that already fails loudly on its own.
// A rule that asks "does it render?" is blind to this class by construction: the broken form is
// valid TeX, so the answer is always yes.
//
// Hence: extract the string literals and look at their shape. No KaTeX, no compiler, no toolchain.

// Two literal backslashes in a regex literal is two escaped backslashes, i.e. two characters.
// Not exported: both consumers want the de-duplicated macro lists below rather than the raw match,
// and a raw-match export is one more thing to call with the wrong flags.
const DOUBLED_BACKSLASH_MACRO = /\\\\[A-Za-z]+/g;
const DOUBLED_BACKSLASH_AFTER_SCRIPT = /[\^_]\s*\\\\[A-Za-z]+/g;

// Every LaTeX macro written with a doubled backslash, in source order and de-duplicated.
export function doubledBackslashMacros(source) {
  return [...new Set(String(source || "").match(DOUBLED_BACKSLASH_MACRO) || [])];
}

// The same, restricted to the doubling that sits immediately after `^` or `_`. A subset of the
// above, and kept separately because the consequence is different: that one is a compile failure
// the build will report, the rest are silent wrong glyphs. Two rule ids for two failure modes is
// worth one extra regex; a reader who is told "the figure did not compile" should not have to
// work out whether their `\\frac` was the reason.
export function doubledBackslashAfterScript(source) {
  return [...new Set(String(source || "").match(DOUBLED_BACKSLASH_AFTER_SCRIPT) || [])];
}

// The Asymptote calls whose string arguments are copied into the generated .tex and therefore
// reach TeX. `label` is the one the corpus uses 572 times; `Label` is its constructor, so
// `label(Label("$x$", N), p)` names its TeX payload the same way and is covered by matching the
// identifier rather than a call shape.
//
// `usepackage("amsmath")` is deliberately NOT in this list, though the corpus carries six of them
// and they are string literals too: that argument names a TeX *package*, not a TeX *label*, and it
// is not copied into the generated label file. Treating every string literal in the source as a
// TeX payload would make the rule sound and useless.
const TEX_LABEL_FUNCTIONS = new Set(["label", "Label"]);

// The string literals a figure source hands to a TeX label, in source order, with the offset at
// which each one starts.
//
// This is a quote-aware walk, not a parser, and it does not need to understand Asymptote to be
// right about a doubled backslash. What it must get right is three things a regex gets wrong:
//
//   * a `//` comment or a `/* ... */` block is not code. A figure header that writes
//     `label("$x$")` in prose is how S5.2-size-required was defeated once already (MAX-64), and
//     the same defence would defeat this rule if comments were scanned.
//   * a `)` inside a string literal does not close a call. `label("$f(x)$", p)` is one call; a
//     naive paren matcher sees `)` after `$f(x` and closes the call early.
//   * a doubled backslash is not an escape *in the payload*, but `\"` does have to be recognised
//     when finding where the literal ends, or `label("$a\"$", p)` runs on into the next line.
//
// Inside a literal a backslash is treated as escaping the next character for boundary-finding
// only. That is the conservative choice for locating the end of the literal and it does not
// change the payload: the substring handed to the detectors is the raw source text, backslashes
// intact, which is the whole point.
export function texLabelLiterals(source) {
  const src = String(source || "");
  const out = [];
  // Depth-indexed flags: callStack[d] is true when the parenthesis at depth d belongs to a call
  // named in TEX_LABEL_FUNCTIONS. A label() call nested inside another call's arguments is still
  // a label call, so the flag is per depth rather than a single boolean.
  const callStack = [];
  let depth = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") { inBlockComment = false; i += 2; continue; }
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") { inLineComment = true; i += 2; continue; }
    if (c === "/" && next === "*") { inBlockComment = true; i += 2; continue; }

    if (c === '"') {
      const start = i + 1;
      let j = start;
      while (j < src.length) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === '"' || src[j] === "\n") break;
        j += 1;
      }
      const body = src.slice(start, Math.min(j, src.length));
      // The innermost open call is the one the literal is an argument to. A literal in a
      // non-label call is not a TeX payload.
      if (callStack[depth]) out.push({ text: body, offset: start });
      // Resume after the closing quote when there was one, past the newline when the literal ran
      // off the end of its line unterminated.
      i = src[j] === '"' ? j + 1 : j + 1;
      continue;
    }

    if (c === "(") {
      // A call's name is the identifier immediately before the parenthesis, allowing for
      // whitespace. `mylabel(` is not `label(`, and the trailing `\w*` in the pattern is what keeps
      // it from matching: the identifier is captured whole, so `mylabel` is read as `mylabel` and
      // then rejected by the set, rather than as the `label` that happens to end it.
      const before = src.slice(0, i);
      const name = (before.match(/([A-Za-z_]\w*)\s*$/) || [])[1];
      depth += 1;
      // Recorded at the depth the *body* of the call lives at, which is the depth a literal
      // between this parenthesis and its partner is seen at.
      callStack[depth] = Boolean(name) && TEX_LABEL_FUNCTIONS.has(name);
      i += 1;
      continue;
    }
    if (c === ")") {
      if (depth > 0) {
        callStack[depth] = undefined;
        depth -= 1;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return out;
}

// Every TeX label payload in a figure source that carries a doubled-backslash macro, one entry per
// offending literal, in source order.
//
// `afterScript` distinguishes the two failure modes so the caller can name them: a doubling that
// follows `^`/`_` is a compile failure and anything else is a silent wrong glyph. Both are
// reported, because both are defects, but they are not the same defect and a message that said
// "Missing { inserted" for a figure that compiled fine would be lying.
export function doubledBackslashInTexLabels(source) {
  return texLabelLiterals(source)
    .map((lit) => ({
      text: lit.text,
      offset: lit.offset,
      afterScript: doubledBackslashAfterScript(lit.text),
      macros: doubledBackslashMacros(lit.text),
    }))
    .filter((hit) => hit.macros.length > 0);
}
