// The emitted SVG, asserted on directly.
//
// Three properties of what a figure ships as, each of which has been wrong at some point and
// each of which a reader of the figure is the only one who can detect:
//
//   sanitisation  an <image> is removed rather than merely defused, and no url() survives that
//                 points anywhere but inside the document
//   minification  the bytes the manifest hashes are the bytes a browser receives, and they are
//                 small enough that the corpus fits the budget Rendering Conventions S7 sets
//   diagnosability a figure that will not compile says why, in terms the author can act on
//
// These live in the api workspace's test run because that is where the only test script wired
// into `npm test` is, and because it already reaches across the repo for lib/figure-contract.mjs.

import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sanitizeSvg, minifySvg, toRelativePathData, describeCompileFailure } from "../../scripts/build-figures.mjs";

// A real slice of what dvisvgm emits: full double precision, single quotes, one element per line,
// and a self-closing <circle>.
const REAL_OUTPUT = `<?xml version="1.0" encoding="UTF-8"?>
<svg version='1.1' xmlns='http://www.w3.org/2000/svg' width='187pt' height='121pt' viewBox='0 -121 187 121'>
<g id='page1'>
<g transform='matrix(1 0 0 -1 -212 335)'>
<circle cx='292.344' cy='493.855' r='.5' />
<path d='M380.847576 396.191548H212.288944L388.347573 396.191548V394.17983Z' stroke='#000' fill='none' stroke-width='.5' stroke-miterlimit='10' stroke-linecap='round' stroke-linejoin='round'/>
</g>
</g>
</svg>
`;

function wrap(inner, attrs = "") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg version='1.1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' width='10pt' height='10pt' viewBox='0 0 10 10'${attrs}>
${inner}
</svg>`;
}

// ---------------------------------------------------------------------------
// The sanitiser's payload table
// ---------------------------------------------------------------------------

// Each row is an attack and the property that has to hold afterwards. `gone` names something the
// output must not contain at all; `present` names something it must still contain, so a fix that
// deletes the whole document passes the `gone` half and fails the other one.
const PAYLOADS = [
  {
    name: "a script element",
    payload: "<script>fetch('//evil.test')</script><path d='M0 0'/>",
    gone: /<script|fetch\(/i,
    present: /<path/,
  },
  {
    name: "an on* event handler",
    payload: "<path d='M0 0' onload='steal()' onclick='x()'/>",
    gone: /onload|onclick|steal/i,
    present: /<path/,
  },
  {
    name: "a foreignObject",
    payload: "<foreignObject><iframe src='//evil.test'/></foreignObject><path d='M0 0'/>",
    gone: /foreignObject|iframe/i,
    present: /<path/,
  },
  {
    name: "a remote href",
    payload: "<use href='https://evil.test/x.svg#g'/>",
    gone: /evil\.test/i,
    present: /<use/,
  },
  {
    name: "an external xlink:href",
    payload: "<use xlink:href='//evil.test/x.svg#g'/>",
    gone: /evil\.test/i,
    present: /<use/,
  },
  {
    name: "an external entity",
    payload: "<!ENTITY xxe SYSTEM 'file:///etc/passwd'><path d='M0 0'/>",
    gone: /ENTITY|xxe|passwd/i,
    present: /<path/,
  },
  {
    // The one S5.3 names and the one the previous sanitiser missed: it rewrote the data URI to
    // href="#" and left the element, which satisfies the sentence and not the intent.
    name: "an <image> with a data URI",
    payload: "<image xlink:href='data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='/><path d='M0 0'/>",
    gone: /<image|data:|base64|PHN2Zz/i,
    present: /<path/,
  },
  {
    name: "an <image> with a plain data URI href",
    payload: "<image href='data:image/png;base64,iVBORw0KGgo='/><path d='M0 0'/>",
    gone: /<image|data:|base64/i,
    present: /<path/,
  },
  {
    name: "an <image> with a remote href",
    payload: "<image href='https://evil.test/pixel.png' width='10' height='10'/><path d='M0 0'/>",
    gone: /<image|evil\.test/i,
    present: /<path/,
  },
  {
    // Not named in S5.3, and a real off-origin fetch that no href rule reaches.
    name: "a remote url() inside a <style> block",
    payload: "<style>.a{fill:url(https://evil.test/x#g)}</style><path d='M0 0'/>",
    gone: /evil\.test|url\(\s*['\"]?https/i,
    present: /<path/,
  },
  {
    name: "a remote url() in a style attribute",
    payload: "<path d='M0 0' style='fill:url(https://evil.test/x#g)'/>",
    gone: /evil\.test/i,
    present: /<path/,
  },
  {
    name: "a javascript: url()",
    payload: "<path d='M0 0' style='fill:url(javascript:alert(1))'/>",
    gone: /javascript:|alert\(1\)/i,
    present: /<path/,
  },
  {
    name: "a css @import",
    payload: "<style>@import url('//evil.test/x.css');</style><path d='M0 0'/>",
    gone: /@import|evil\.test/i,
    present: /<path/,
  },
];

for (const row of PAYLOADS) {
  test(`sanitizeSvg removes ${row.name} and leaves the rest of the document alone`, () => {
    const out = sanitizeSvg(wrap(row.payload));
    assert.doesNotMatch(out, row.gone, `sanitised output still carries the payload:\n${out}`);
    assert.match(out, row.present, `sanitisation deleted the drawing instead of the payload:\n${out}`);
    // And the guarantee holds as an invariant on the emitted text, not only for this row.
    assert.doesNotMatch(out, /<image|data:|javascript:|@import/i);
  });
}

test("sanitizeSvg keeps a url() that points inside the document", () => {
  // The deny is `url(` outside `#`. A gradient reference is a same-document reference and is the
  // one legitimate use; over-reaching here would silently break any figure that uses one.
  const out = sanitizeSvg(wrap("<defs><linearGradient id='g'/></defs><path d='M0 0' fill='url(#g)'/>"));
  assert.match(out, /url\(#g\)/);
});

test("sanitizeSvg refuses to emit a document with no svg root", () => {
  // The post-conditions are what make the deny list a guarantee rather than a list of intentions:
  // whatever survives the patterns is asserted on before it is returned. Input that is not an SVG
  // document at all is rejected here rather than written to the artifact directory and served.
  assert.throws(() => sanitizeSvg("not markup at all"), /svg root/);
  assert.throws(() => sanitizeSvg("<html><body>hi</body></html>"), /svg root/);
});

// ---------------------------------------------------------------------------
// Minification
// ---------------------------------------------------------------------------

test("minifySvg removes the bytes that carry no information", () => {
  const min = minifySvg(REAL_OUTPUT);
  // Inter-element whitespace: one line, no indentation.
  assert.ok(!/>\s+</.test(min), `inter-tag whitespace survived:\n${min}`);
  // Attribute padding.
  assert.ok(!/\s=/.test(min), `padding around = survived:\n${min}`);
  assert.ok(!/\s{2,}/.test(min), `a double space survived:\n${min}`);
  // Full double precision is gone.
  assert.ok(!min.includes("380.847576"), `a six-decimal coordinate survived:\n${min}`);
  assert.ok(min.length < REAL_OUTPUT.length, "minification did not make the document smaller");
});

test("minifySvg preserves the document's structure", () => {
  // Minification is not allowed to change what the figure is. Element names, attribute names,
  // the quote character, the self-closing slash and the viewBox all carry meaning.
  const min = minifySvg(REAL_OUTPUT);
  for (const element of ["<svg", "<g", "<circle", "<path", "</g>", "</svg>"]) {
    assert.ok(min.includes(element), `${element} did not survive minification:\n${min}`);
  }
  assert.match(min, /<circle[^>]*\/>/, "a self-closing <circle/> lost its slash and no longer parses");
  assert.match(min, /viewBox='0 -121 187 121'/);
  assert.match(min, /width='187pt'/);
  assert.match(min, /transform='matrix\(1 0 0 -1 -212 335\)'/);
  assert.match(min, /stroke-linecap='round'/);
});

test("minifySvg leaves text content alone", () => {
  // A newline inside <text> is a space. Dropping it changes what a screen reader reads, which is
  // the one thing this pipeline cannot trade bytes for.
  const withText = wrap("<text x='0' y='0'>one\ntwo</text><path d='M0 0'/>");
  assert.match(minifySvg(withText), /one\ntwo/);
});

test("sanitizeSvg emits a minified, well-formed, single-line document", () => {
  const out = sanitizeSvg(REAL_OUTPUT);
  assert.equal(out.split("\n").length, 2, "expected the prolog and one line of document");
  assert.ok(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  // Every tag opened is closed or self-closed, which is the property the />/ carry-through exists
  // to protect.
  const opened = [...out.matchAll(/<([a-zA-Z][\w:.-]*)\b([^>]*)>/g)];
  for (const [, name, attrs] of opened) {
    if (attrs.trimEnd().endsWith("/")) continue;
    assert.ok(out.includes(`</${name}>`), `<${name}> is neither self-closed nor closed:\n${out}`);
  }
});

test("toRelativePathData expresses coordinates as deltas without moving the shape", () => {
  // The size win is here and nowhere else: path data is ~97% of an emitted figure. The safety
  // argument is that the rewrite is checked against the geometry it was given.
  const rewritten = toRelativePathData("M380.847576 396.191548H212.288944L388.347573 396.191548V394.17983Z");
  // Six decimals of absolute coordinates become three decimals of deltas, and the one space left
  // between `l` and its two arguments is the only separator the grammar needs there.
  assert.equal(rewritten, "M380.848 396.192h-168.559l176.059 0v-2.012Z");
});

test("toRelativePathData returns null rather than emitting a path it cannot vouch for", () => {
  // null is the safe answer, not a failure: the caller keeps the absolute form. These are the
  // inputs where guessing would be worse than not minifying.
  assert.equal(toRelativePathData("M0 0 L"), null, "a truncated path");
  assert.equal(toRelativePathData("L10 10"), null, "a path that does not start with a moveto");
  assert.equal(toRelativePathData("M0 0 K5 5"), null, "a command letter this pass does not model");
  assert.equal(toRelativePathData(""), null, "empty path data");
});

test("toRelativePathData reads arcs, whose flags are not numbers", () => {
  // `a1 1 0 011 1` is one arc, not an arc whose flags are 011 and 1. Reading the flags as
  // ordinary numbers turns a valid document into a different, invalid one.
  assert.equal(toRelativePathData("M5 5A3 3 0 011 1"), "M5 5a3 3 0 0 1 -4 -4");
});

test("toRelativePathData leaves a path alone when the deltas would drift too far", () => {
  // A relative rewrite accumulates one rounding step per command. With the tolerance at 0 the
  // gate rejects anything that is not exact, which is the strictest version of the same check.
  const exact = "M0 0L1.5 -2.25L3 4.5L4.5 -6";
  assert.equal(toRelativePathData(exact, 3, 0), "M0 0l1.5 -2.25l1.5 6.75l1.5 -10.5");
  assert.equal(toRelativePathData(exact, 1, 0), null, "1 decimal cannot represent 2.25 exactly, so it must be refused");
});

// ---------------------------------------------------------------------------
// Diagnosing a compile failure
// ---------------------------------------------------------------------------

test("describeCompileFailure names the doubled-backslash LaTeX macro", () => {
  // The whole point. Figures in the corpus failed for this one reason and the diagnostic said
  // "plain_shipout.asy: runtime: shipout failed", which points at the renderer, not the figure.
  const work = mkdtempSync(join(tmpdir(), "figure-diag-"));
  try {
    writeFileSync(
      join(work, "figure.log"),
      "! Missing { inserted.\n<inserted text>\n                $\nl.116 \\\\newcommand\\circ\n                 \\\\circ\n",
    );
    // Asymptote source, in a JS template literal: two backslashes in the value, as the compiler
    // would have been handed them.
    const source = 'size(200,100);\nlabel("$90^\\\\circ$", (0,0));\nlabel("$\\\\sin x$", (1,1));';
    const described = describeCompileFailure(
      { stderr: "plain_shipout.asy: 116.11: runtime: shipout failed\n" },
      work,
      { key: "m8-l5.sections.concept.figures[0]", source },
    );
    assert.match(described, /doubled backslash immediately after \^ or _/, `the cause was not named:\n${described}`);
    assert.match(described, /\^\\\\circ/, "the offending macro was not quoted back");
    assert.match(described, /Write one backslash \(\\circ, not \^\\\\circ\)/, "the fix was not spelled out");
    assert.match(described, /Missing \{ inserted/, "the TeX error it explains was not carried through");
    assert.match(described, /m8-l5\.sections\.concept\.figures\[0\]/, "the figure key was not carried through");
    // The other macro in the same figure does not break the compile but does render wrong, so the
    // diagnosis has to name it too -- otherwise the fix stops at the five that happened to fail.
    assert.match(described, /do NOT break the compile but do render wrong/);
    assert.match(described, /\\\\sin/);
    // It must lead, so a reader who sees one line sees the cause rather than the symptom.
    assert.ok(described.startsWith("cause:"), `the diagnosis is not first:\n${described}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("describeCompileFailure does not blame a doubled backslash that cannot break the compile", () => {
  // `y=\\sqrt{x-2}` renders a line break followed by italic `sqrt`, but TeX compiles it
  // perfectly. A diagnosis that fired on any doubled backslash would send an author to fix the
  // wrong thing on a failure that has nothing to do with this.
  const work = mkdtempSync(join(tmpdir(), "figure-diag-"));
  try {
    const described = describeCompileFailure(
      { stderr: "plain_shipout.asy: 116.11: runtime: shipout failed\n" },
      work,
      { key: "m1-l3.sections.concept.figures[0]", source: 'label("$y=\\\\sqrt{x-2}$",(0,0));' },
    );
    assert.ok(!described.includes("doubled backslash"), `invented a cause:\n${described}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("describeCompileFailure names the doubled backslash even when the log was already deleted", () => {
  // The evidence is the figure's own source, so a work directory that got cleaned up first does
  // not cost the diagnosis.
  const work = mkdtempSync(join(tmpdir(), "figure-diag-"));
  try {
    const described = describeCompileFailure(
      { stderr: "plain_shipout.asy: 116.11: runtime: shipout failed\n" },
      work,
      { key: "m8-l4.sections.concept.examples[2]", source: 'label("$180^\\\\circ$", (0,0));' },
    );
    assert.match(described, /doubled backslash immediately after/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("describeCompileFailure distinguishes a broken toolchain from a broken figure", () => {
  // Same symptom, same last line, different owner: this one is fixed on the machine, not in the
  // content, and an author who reads "your figure is wrong" here loses an afternoon.
  const work = mkdtempSync(join(tmpdir(), "figure-diag-"));
  try {
    const missingPackage = describeCompileFailure(
      { stderr: "! LaTeX Error: File `amsmath.sty' not found.\n" },
      work,
      { key: "m1-l1.sections.concept.figures[0]", source: 'label("$x$", (0,0));' },
    );
    assert.match(missingPackage, /missing amsmath\.sty/);
    assert.match(missingPackage, /toolchain property, not a figure defect/);

    const timedOut = describeCompileFailure(
      { stderr: "", killed: true, signal: "SIGTERM", timeout: 60000 },
      work,
      { key: "m1-l1.sections.concept.figures[0]", source: 'label("$x$", (0,0));' },
    );
    assert.match(timedOut, /killed by the 60000ms timeout/);
    assert.match(timedOut, /not by the figure's source/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("describeCompileFailure falls back to the compiler's own words", () => {
  // Nothing recognised: the diagnosis must not invent a cause. The raw material still ships.
  const work = mkdtempSync(join(tmpdir(), "figure-diag-"));
  try {
    const described = describeCompileFailure(
      { stderr: "asy: some failure nobody has named\n" },
      work,
      { key: "m1-l1.sections.concept.figures[0]", source: "size(10,10);" },
    );
    assert.match(described, /some failure nobody has named/);
    assert.ok(!described.includes("doubled backslash"), "invented a cause for a failure it does not recognise");
    assert.match(described, /source: size\(10,10\);/, "dropped the evidence it does have");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
