#!/usr/bin/env node
// Content-side preflight for the math training app corpus.
//
// Deliberately NOT named check-content-math.mjs: that script is the CI build
// gate owned by engineering (MAX-5). This is the author-side reference
// implementation of the same rules, runnable today with no app and no repo, so
// that content never reaches import unverified. It emits the same report shape
// (artifacts/content-math-report.json) so the two can be diffed.
//
// Rules implemented, by source document:
//   Rendering Conventions S2  - KaTeX options (mirrored here, must stay in sync)
//   Rendering Conventions S3.1- field conventions (bare fragments, no $$, ...)
//   Rendering Conventions S3.2- macro policy (approved list + denylist)
//   Rendering Conventions S3.3- the linter's own five checks
//   Rendering Conventions S5.1- figure budget ceilings
//   Rendering Conventions S5.2- asymptoteSource authoring contract
//   Rendering Conventions S6  - answer canonical form (no false negatives)
//   Rendering Conventions S9  - asymptoteAlt / asymptoteAspectRatio mandatory
//   Interaction Spec S8       - the nine content requirements
//
// Two families have no source document, and are deliberately not numbered like one:
//
//   MAX-89  - json-escaped-macro: a JSON control escape inside a math span ate the macro
//             it introduced. The gate is the only thing that can see this, so it is stated
//             here rather than waited for. A document half would belong to whoever owns
//             rendering_conventions; it does not exist yet and this rule does not wait for it.
//
//   MAX-106 - figure-id-unique / worked-example-id-unique: a figure or worked-example id is an
//             address, and two records sharing one make it resolve to whichever came first. The
//             delivery gate on MAX-104 resolves by figure id, so a duplicate there would be
//             reported as delivered without being evidence of anything. Same reasoning as
//             MAX-89: the gate is the only thing that can see this.
//
//   MAX-107 - figure-id-required: a figure id is an address, and a record that declares none
//             cannot be named by anything that would have to assert it shipped -- least of all
//             the delivery gate on MAX-104, whose whole premise is that a close-out names ids
//             and the ref's tree is asked whether it holds them. Four of m5-l1's figure
//             reservations declared no id at all. Same reasoning as MAX-89: the gate is the
//             only thing that can see this, and the document half would belong to whoever owns
//             the figure authoring contract.
//
// What this file is not, and why the landing gate is not in it: every rule above runs with no app
// and no repository, on a corpus directory, and stays that way on purpose -- an author can run it
// from a checkout of content and nowhere else. The sibling scripts/check-landed-content.mjs
// (MAX-126, `npm run land:check`) asks a question that needs git, a remote and a pull-request
// list: this branch carries gated commits, no PR has ever had it as its head, and the issue it
// belongs to is finished, so nothing here will ever ship (MAX-132 added that last condition -- work
// in progress is not a finding). Folding it in would take the repository dependency with it and
// cost the author workflow the only gate it can run anywhere.
//
// Usage: node scripts/preflight-content.mjs [contentRoot] [--json [<outPath>]]
//   --json           print the report to stdout
//   --json <path>    write the report to <path> instead

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import katex from "katex";
import {
  countFigures,
  doubledBackslashInTexLabels,
  isRenderableFigure,
  lessonFigureRecords,
} from "../lib/figure-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

export const KATEX_PINNED = "0.16.11";

// Rendering Conventions S2. The app passes throwOnError:false so a bad formula
// degrades in the UI; the linter overrides it to true so a bad formula is a
// content failure instead of a learner-facing red box.
const RENDER_OPTIONS = {
  output: "htmlAndMathml",
  throwOnError: true,
  errorColor: "#b91c1c",
  strict: "warn",
  displayMode: false,
  trust: false,
  macros: {},
  maxSize: 20,
  maxExpand: 1000,
  strictIgnores: ["\\text", "\\middle"],
};

// ---------------------------------------------------------------------------
// Policy tables
// ---------------------------------------------------------------------------

// S3.2 "Approved - use freely"
const APPROVED = new Set(
  `frac dfrac tfrac sqrt binom dbinom tbinom left right middle mathbb mathcal mathfrak mathscr mathbf mathrm mathmathit mathit mathsf operatorname text textbf textit emph overline underline widetilde widehat vec bar hat dot ddot
   matrix pmatrix bmatrix vmatrix cases array aligned gathered smallmatrix substack boxed overbrace underbrace displaystyle textstyle limits nolimits
   sum prod int oint lim max min gcd deg mod pmod
   log ln exp sin cos tan sec csc cot arcsin arccos arctan
   , ! ; : quad qquad dots cdots vdots ddots infty ldots
   equiv approx neq ne le ge propto angle triangle perp parallel sim to rightarrow nearrow mapsto implies iff
   cdot`.split(/\s+/)
    .filter(Boolean),
);

// S3.2 app macro table
const APP_MACROS = new Set(["dbinom", "dfrac", "Zmod", "dvd", "ang", "Prob", "unit"]);

// KaTeX core symbols and atoms. These are not macros, so S3.2's macro list does
// not name them, but the doc's own "write the alternative" table maps unicode to
// them (pi, sqrt, sum, le). Anything here is allowed; anything outside both
// lists is an advisory asking Alice to add it to S3.2.
const CORE_SYMBOLS = new Set(
  `alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi chi psi omega
   Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega
   in notin cup cap subset subseteq supset supseteq emptyset infty times div pm mp ast star circ prime ldots langle rangle
   lfloor rfloor lceil rceil vert parallel perp
   aleph hbar imath ell wp Re Im
   mid nmid bmod vmod
   varphi
   % $ & # _ { } | {`
    .split(/\s+/)
    .filter(Boolean),
);

const ALLOWED_ENVIRONMENTS = new Set(
  "matrix pmatrix bmatrix vmatrix cases array aligned gathered smallmatrix".split(" "),
);

// S3.2 "Not available - write the alternative" + hard bans. Any of these is an
// error even if some future KaTeX happens to accept it.
const DENIED = new Set(
  `newcommand renewcommand def let providecommand newenvironment
   textcolor colorbox fcolorbox includegraphics graphicspath
   qty dv bra ket coloneqq dcoloneqq prescript usetikzlibrary tikz
   input include write special`
    .split(/\s+/)
    .filter(Boolean),
);

// Unicode that must be written as LaTeX in content fields (S3.2).
const UNICODE_MATH = /[≤≥≠±×÷−√πθΠ∞≡≈≤]/g;

// Figure budget (S5.1) - per-lesson and per-exercise ceilings.
//
// These four numbers are the S5.1 ceilings and they are unchanged by MAX-76. What changed is
// what they are measured against: a ceiling that counted declared records and then the build
// counted renderable ones could not be checked, and the corpus ceiling reported 150/185 for a
// corpus holding 83 figures (MAX-76). Every ceiling below now meters `lessonFigureSites` -- the
// records the build will actually compile -- and nothing is counted twice. A reserved but
// unwritten figure (`asymptoteSource: null`) is reported by S5.1-figure-reserved rather than
// charged to a budget it will not spend.
const MAX_FIGURES_PER_EXERCISE = 1;
const MAX_FIGURES_IN_CONCEPT = 4;
const MAX_FIGURES_IN_EXAMPLES = 2;
const MAX_FIGURES_PER_LESSON = 8;
const MAX_CORPUS_FIGURES = 185;
const MAX_ASPECT = 3;
const MIN_ASPECT = 0.5;

const TIERS = new Set(["10", "12", "A", "A+"]);

// Exercise tags are a CLOSED vocabulary so that a tag means the same thing on every exercise
// and "show me everything tagged X" is a real query. Closed does not mean fixed: it means
// every module contributes its own set, and the union is the vocabulary. A list that is not
// module-complete rejects every exercise in every module it does not cover -- which is
// exactly what happened to Module 9 (proof): 36 authored exercises, 115 S3.3-tag-vocabulary
// errors, all one cause, and not one of them the author's mistake.
//
// Two roles, deliberately kept distinguishable:
//   topic     -- what the exercise is about, so "all divisibility exercises" is answerable.
//   technique -- how it is meant to be solved, so "all pigeonhole exercises" is answerable.
// A tag belongs to exactly one role. Do not merge a technique into a topic just because a
// given exercise is both.
const TAG_TOPIC = [
  // Module 1: algebra foundations, and the geometry the AMC-10 front half leans on.
  "linear-equations", "inequalities", "absolute-value", "fractions", "domain",
  "exponents", "quadratics", "factoring", "radicals", "word-problem", "counting-integers",
  "region-split", "intervals", "distributive-law", "angles", "circles", "chords",
  "pythagorean", "trig-conversion", "triangles",
  // Module 2: number sense and computation.
  "gcd-lcm", "congruences", "crt", "place-value", "digit-problems",
  // Module 9: proof.
  "quantifiers", "divisibility", "prime-factorization", "modular-arithmetic", "residues",
  "symmetry", "floor-ceiling", "binomial-coefficients", "combinations",
  // Module 6: analytic geometry, conics, and complex numbers.
  "coordinates", "distance-formula", "midpoint", "reflections", "slopes", "parallel-lines",
  "systems-of-equations", "conics", "parabolas", "ellipses", "hyperbolas",
  "complex-numbers", "loci", "transformations",
  // Module 4: sequences and series.
  "sequences", "arithmetic-sequences", "geometric-sequences", "series", "sigma-notation",
  "telescoping", "infinite-sums", "series-convergence", "recurrences", "multinomial-coefficients",
  "partial-sums",
  // Module 5: geometry. Topics are what the exercise is about; the techniques in the
  // list below are how a geometry argument is actually built.
  "perpendicular-lines", "transversals", "angle-bisectors", "polygons", "quadrilaterals",
  "regular-polygons", "interior-angles", "arcs", "tangents", "central-angles",
  "inscribed-angles", "congruence", "similarity", "area-of-triangles", "perimeter",
  // Module 8: trigonometry.
  "unit-circle", "radians", "special-angles", "exact-trig-values", "trig-identities",
  "trig-equations", "trig-graphing", "inverse-trig", "law-of-sines", "law-of-cosines",
  "triangle-area", "triangle-solving", "sss-triangles", "sas-triangles", "ssa-triangles",
  "cyclic-quadrilaterals", "angle-chasing", "oblique-triangles", "trigonometric-area",
  // Module 8, lesson 4 (MAX-20): the polar and roots-of-unity half of trigonometry. The
  // topics already filed under Module 6 ("complex-numbers") are what an exercise is about;
  // these two name the parts of it a learner can ask for on their own.
  "polar-form", "complex-powers",
  // Module 8, lesson 5 (MAX-50): the equations, inverse functions and graphs half of
  // trigonometry. "trig-equations", "inverse-trig" and "trig-graphing" were already
  // declared here and unused; these two name what a learner asks for inside them that
  // is not itself an equation or a graph.
  "amplitude-period-shift", "trig-function-ranges",
  // Module 7: counting and probability.
  "fundamental-counting", "permutations", "combinations", "inclusion-exclusion",
  "stars-and-bars", "complementary-counting", "pigeonhole-principle", "probability",
  "conditional-probability", "independence", "bayes-theorem", "expected-value",
  "geometric-probability", "random-variables", "distributions", "binomial-distribution",
  "hypergeometric-distribution",
  // Module 3, second half: what the graph and lattice half of counting (m3-l4) is about.
  // Appended in MAX-53. Without these four, the only way to file a Cayley exercise was as a
  // combination, so the two obvious queries -- every lattice-path exercise, every
  // spanning-tree exercise -- had no answer at all.
  "lattice-paths", "trees", "spanning-trees", "graph-trails",
  // Module 5, lessons 3 and 4 (MAX-24). M5 shipped "circles", "arcs", "chords", "tangents",
  // "central-angles", "inscribed-angles" and "cyclic-quadrilaterals" back when the pilot
  // declared them, but the two lessons that actually teach them did not exist until now, and
  // four things had no word at all: the external-point product (every tangent-secant and
  // two-secant problem was filed as a bare "circles" exercise), the chord-chord product
  // inside the circle, and the whole area-and-volume half the module summary promised. The
  // rest are the faces of a solid, which no topic named.
  //
  // "power-of-a-point" and "intersecting-chords" stay separate on purpose. One is measured
  // from a point outside the circle and pairs an outside length with a whole length; the
  // other is measured from a point inside and pairs the two halves of one chord. Same
  // underlying invariant, opposite pairings, and the pairing is the whole of the arithmetic.
  "power-of-a-point", "intersecting-chords", "trapezoids", "circle-area", "arc-length",
  "volume", "surface-area", "composite-solids", "inradius", "midsegment", "areas",
];

const TAG_TECHNIQUE = [
  // Module 1.
  "chain-of-equivalences", "case-split", "structure-spotting", "counting-cases", "extremal",
  // Module 2: how a number-theory argument is actually built.
  "euclidean-algorithm", "valuation-counting", "unitary-decomposition", "periodicity",
  // Module 9: the proof-writing techniques the AIME proofs are actually built from.
  "proof", "direct-proof", "contradiction", "pigeonhole", "invariants", "wlog",
  "counterexample", "biconditionals", "induction", "strong-induction",
  // Module 6: how an analytic-geometry or complex-number argument is actually built.
  "point-slope-form", "distance-to-line-formula", "linear-elimination", "substitution",
  "completing-the-square", "conic-standard-form", "focus-directrix", "complex-modulus",
  "conjugate-arithmetic", "de-moivre", "roots-of-unity",
  // Module 4: how a sequence, a sum, or a coefficient is actually extracted.
  "common-difference-detection", "common-ratio-detection", "difference-table",
  "nth-term-formula", "nth-term-from-two-terms", "explicit-from-recursive",
  "threshold-crossing", "geometric-modeling", "fractional-ratio",
  "arithmetic-sum-formula", "symmetric-pairing", "sigma-index-shift",
  "telescoping-split", "subseries-split", "counting-by-sigma",
  "finite-geometric-formula", "ratio-one-case", "negative-ratio-case",
  "infinite-geometric-sum", "convergence-test", "geometric-mean",
  "reindex-and-subtract", "growth-decay-modeling",
  "pascal-triangle", "binomial-symmetry", "binomial-expansion", "specific-term",
  "coefficient-extraction", "multinomial-coefficients", "combinatorial-counting", "sum-of-binomials",
  // Module 5: how a plane-geometry argument is actually built.
  "parallel-line-angle-transfer", "corresponding-angles", "alternate-interior-angles",
  "co-interior-angles", "perpendicular-line-transfer", "angle-chase-setup",
  "triangle-angle-sum", "isosceles-base-angles", "exterior-angle-theorem",
  "angle-bisector-split", "sides-angles-sides-check",
  "congruence-sss", "congruence-sas", "congruence-asa", "congruence-aas", "cpctc",
  "right-triangle-altitude-similarity", "hypotenuse-leg",
  "similarity-aa", "similarity-sas", "similarity-sss", "parallel-line-similarity",
  "area-scaling-from-scale", "missing-length-in-similar-triangles",
  "polygon-interior-angle-sum", "polygon-exterior-angle-count", "triangulate-a-polygon",
  "apothem-perimeter", "polygon-rectangle-decomposition", "exterior-angle-runs-around",
  "radius-perpendicular-to-chord", "equal-chords-equal-arcs", "tangent-radius-perpendicular",
  "tangent-length-equal", "tangent-secant-power", "two-secants-power",
  "inscribed-angle-is-half-the-central", "cyclic-quadrilateral-opposite-angles",
  "chord-length-vs-central-angle", "arc-addition", "polygon-angles-in-a-circle",
  // Module 8: how a trigonometric argument is actually built.
  "degree-radian-conversion", "unit-circle-construction", "reference-angle",
  "quadrant-sign-analysis", "special-triangle-drop", "cofunction-substitution",
  "odd-angle-reduction", "pythagorean-recovery", "identity-selection",
  "convert-to-sine-and-cosine", "one-side-one-angle", "two-sides-one-angle",
  "three-sides", "radii-and-chords", "heron-area", "angle-sum-of-triangle",
  "inscribed-angle-theorem", "ambiguous-case-analysis", "supplementary-angle-case",
  "simplify-before-substituting", "factor-the-expression",
  "radius-times-angle", "sector-area-formula", "double-angle-recovery",
  "angle-addition-expansion", "identity-proof-strategy", "area-from-two-sides-angle",
  "chord-angle-relation", "sine-law-inverse-solve", "angles-in-a-quadrilateral",
  // Module 8, lesson 4 (MAX-20): how a polar-form or roots-of-unity argument is built.
  // "complex-modulus", "conjugate-arithmetic", "de-moivre" and "roots-of-unity" are
  // already filed under Module 6 and are reused here rather than restated.
  "modulus-and-argument", "polar-rectangular-conversion", "argument-quadrant-fix",
  "de-moivre-power", "angle-multiplication-reduction", "nth-root-extraction",
  "root-of-unity-sums", "regular-polygon-vertices",
  // Module 8, lesson 5 (MAX-50): how a trigonometric-equation, inverse-function or
  // graph argument is built. "supplementary-angle-case-split" from Module 5 is about
  // plane geometry and is deliberately not reused here; the angle split in this lesson
  // is the one that picks two angles inside a single turn of a trig curve.
  "isolate-the-trig-value", "general-solution-capture", "angle-pair-case-split",
  "interval-solution-count", "principal-value-range", "inverse-composition",
  "auxiliary-angle-expansion", "graph-amplitude-period", "graph-phase-readoff",
  "graph-construction", "tangent-graph-asymptotes", "reciprocal-graph-reflection",
  // Module 7: how a counting or probability argument is actually built.
  "multiplication-principle", "factorial-counting", "complementary-count",
  "inclusion-exclusion-principle", "stars-and-bars-method", "pigeonhole-application",
  "probability-as-fraction", "conditional-probability-formula", "independence-check",
  "bayes-reversal", "linearity-of-expectation", "indicator-variables",
  "geometric-probability-setup", "distribution-identification", "binomial-model",
  "hypergeometric-model", "symmetry-argument",
  // Module 3, second half: how a graph or lattice counting argument is actually built.
  // Appended in MAX-53. The reflection move is what every barrier problem -- a path above a
  // line, a sign sequence, a coin prefix -- is really one of. Cayley and the code that
  // bijects trees with sequences stay two tags rather than one, because naming the count of
  // labeled trees and naming the encoding are different techniques.
  "reflection-argument", "catalan-count", "ballot-count", "cayley-formula", "prufer-code",
  "euler-circuit-count", "hamiltonian-count", "characteristic-roots", "recurrence-from-splitting",
  // Module 5, lesson 3 (MAX-24): how a circle argument is actually built. Everything below is
  // a *move* -- convert an inscribed angle into an arc, decide whether a vertex is inside or
  // outside before choosing a rule, then pair the right two lengths. "radius-perpendicular-to-chord",
  // "equal-chords-equal-arcs", "tangent-radius-perpendicular", "tangent-length-equal",
  // "tangent-secant-power", "two-secants-power", "inscribed-angle-is-half-the-central",
  // "cyclic-quadrilateral-opposite-angles" and "arc-addition" were already declared under
  // Module 5 and are reused here rather than restated.
  //
  // The two arc-angle moves are deliberately distinct because the *sign* is the move:
  // "intersecting-chords-angle" adds the two intercepted arcs and "external-secant-angle"
  // subtracts them, and a learner who has only one of them will apply the wrong one.
  "intersecting-chords-angle", "external-secant-angle", "angles-in-the-same-segment",
  "angle-in-a-semicircle", "radius-bisects-both-arcs", "intersecting-chords-product",
  "exterior-angle-of-a-cyclic-quadrilateral", "arc-measure-as-central-angle", "power-of-a-point",
  // Module 5, lesson 4 (MAX-24): how an area or volume argument is actually built. The circle
  // and sector moves ("radius-times-angle", "sector-area-formula"), the similarity move
  // ("area-scaling-from-scale"), the decomposition move ("polygon-rectangle-decomposition"),
  // the apothem move ("apothem-perimeter"), Heron ("heron-area") and the triangle-inequality
  // material are already declared and are reused.
  "triangle-area-from-base-height", "rhombus-diagonal-area", "trapezoid-midsegment-area",
  "regular-polygon-triangulation", "apothem-area", "circle-area-formula",
  "arc-length-from-central-angle", "prism-and-cylinder-volume", "pyramid-and-cone-volume",
  "sphere-volume-and-area", "surface-area-lateral-plus-base", "inradius-from-area",
];

// Rule for the next module: add its topics and its techniques to the two lists above. Do not
// widen a tag's meaning, and do not delete a tag that authored content already uses -- a
// removed tag breaks every exercise carrying it, which is why the vocabulary is append-only.
//
// Module 9's technique block is now complete: "induction" and "strong-induction" were the
// two omissions (MAX-29). If this comment ever describes an unfinished module again, the fix
// is to finish that module's block here, not to retag the exercises -- an exercise retagged
// to fit the vocabulary stops answering the query it was written for.
//
// Module 3's block is now complete in both roles as well (MAX-53): the graph and lattice half
// of m3-l4 had no words at all until then, so its exercises were filed under "combinations".
// "trees" and "spanning-trees" are deliberately separate -- an exercise is about trees as
// objects, or about counting a specific graph's spanning trees, and those are different
// queries -- and "cayley-formula"/"prufer-code" likewise, because naming the count of labeled
// trees and naming the code that bijects them with sequences are different techniques.
const TAGS = new Set([...TAG_TOPIC, ...TAG_TECHNIQUE]);

// ---------------------------------------------------------------------------
// Finding collector
// ---------------------------------------------------------------------------

const findings = [];
let checksRun = 0;

function fail(severity, rule, path, message) {
  findings.push({ severity, rule, path, message });
}

function check(severity, rule, path, ok, message) {
  checksRun += 1;
  if (!ok) fail(severity, rule, path, message);
}

function stripOuterMath(s) {
  const t = s.trim();
  if (t.length > 1 && t.startsWith("$") && t.endsWith("$") && !t.slice(1, -1).includes("$")) {
    return { inner: t.slice(1, -1), wrapped: true };
  }
  return { inner: t, wrapped: false };
}

// ---------------------------------------------------------------------------
// Block model
// ---------------------------------------------------------------------------
// Deterministic, and the one thing the three docs leave implicit: how a
// multi-block field such as solutionLatex becomes several MathBlock instances.
//
//   - a block containing $...$ is prose: rendered inline (displayMode false)
//   - a block with no $ at all is display math: rendered with displayMode true
//   - blocks are separated by a blank line
//
// The $$ form is accepted as a fallback for legacy content, is reported as an
// advisory, and must not be mixed with the blank-line form in one field.

function splitBlocks(value) {
  if (value.includes("$$")) {
    const parts = value
      .split("$$")
      .map((p) => p.replace(/^\s*\n/, "").trim())
      .filter((p) => p.length > 0);
    return { blocks: parts, style: "dollars", display: parts.map(() => true) };
  }
  const parts = value
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return { blocks: parts, style: "blank-line", display: parts.map((p) => !p.includes("$")) };
}

const INLINE_SEGMENT = /\$([^$]*)\$/g;

function renderBlocks(value, path, { allowDisplayDollar = true, label = "field" } = {}) {
  const { blocks, style, display } = splitBlocks(value);
  if (style === "dollars") {
    check("advisory", "S3.1-blockstyle", path, allowDisplayDollar,
      `${label} uses $$…$$ block delimiters; content convention is blank-line separated blocks with no $$`);
  }
  let failed = 0;
  blocks.forEach((block, i) => {
    const blockPath = `${path}#block${i + 1}`;
    if (display[i]) {
      checksRun += 1;
      try {
        katex.renderToString(block, { ...RENDER_OPTIONS, displayMode: true });
      } catch (err) {
        failed += 1;
        fail("error", "S3.3-katex-render", blockPath,
          `display block does not render: ${err.message.replace(/\n/g, " ")}`);
      }
      return;
    }
    // prose block: math must live entirely inside $...$
    const dollars = (block.match(/\$/g) || []).length;
    check("error", "S3.1-balanced-dollars", blockPath, dollars % 2 === 0,
      `unbalanced $ in ${label} (${dollars} occurrences)`);
    const outside = block.replace(INLINE_SEGMENT, " ").trim();
    check("error", "S3.1-no-math-outside-delimiters", blockPath,
      !/\\[a-zA-Z]+/.test(outside),
      `math command outside $…$ delimiters in a prose block: ${outside.slice(0, 60)}`);
    let m;
    INLINE_SEGMENT.lastIndex = 0;
    let blockFailed = 0;
    while ((m = INLINE_SEGMENT.exec(block)) !== null) {
      checksRun += 1;
      try {
        katex.renderToString(m[1], { ...RENDER_OPTIONS, displayMode: false });
      } catch (err) {
        blockFailed += 1;
        fail("error", "S3.3-katex-render", blockPath,
          `inline math does not render: ${err.message.replace(/\n/g, " ")}`);
      }
    }
    if (blockFailed) failed += 1;
  });
  return { count: blocks.length, failed, style };
}

// ---------------------------------------------------------------------------
// Field-level checks
// ---------------------------------------------------------------------------

const HTML_TAG = /<\/?[a-zA-Z][a-zA-Z0-9]*(\s[^<>]*)?>/;
const HTML_ENTITY = /&(?!amp;|lt;|gt;|nbsp;)[a-zA-Z]{2,8};/;
const COMMAND = /\\([a-zA-Z]+|.)/g;

// ---------------------------------------------------------------------------
// MAX-89: a LaTeX macro whose name was eaten by a JSON control escape
// ---------------------------------------------------------------------------
// `\n`, `\r`, `\t`, `\f` and `\b` are JSON's control escapes. A LaTeX field written with a
// SINGLE backslash before a macro whose name starts with one of those letters therefore
// parses to the control character plus the tail of the name as literal text:
//
//     in the file   "$\zeta \neq 1$"      (one backslash)
//     parses to     "$\zeta " LF "eq 1$"
//     renders as    "ζ eq 1"
//
// Nothing else in this file sees it. The field parses, S3.3-katex-render passes because KaTeX
// renders letters perfectly happily, and S3.2 never reaches the macro allowlist because no
// backslash is left to match. So the corruption reached the corpus 12 times, in 11 math spans
// across 4 content files, before MAX-87 repaired it -- and the same escape still destroys
// \newcommand, \nearrow, \nolimits, \right, \notin and every other macro beginning n, r, t,
// b or f.
//
// Severity is error, and the reason is the comparison with the two families it sits between.
// S3.2-macro-allowlist is an advisory because it fires on macros that render *correctly* and
// only asks that the convention catch up; the render is never wrong. S3.3-katex-render is an
// error because the field does not produce the author's formula. This is the same defect as
// S3.3 with the failure inverted: the formula renders and it is still not what the author
// wrote, the student reads letters where a relation sign belongs, and nothing on screen says
// so. An advisory would be indistinguishable from no rule at all, because the only thing that
// acts on this class of finding is the gate itself.
//
// The discriminator is "control character inside a math span", not "newline in a LaTeX field".
// The corpus uses \n\n for paragraph breaks in solutionLatex and bodyLatex and is full of them:
// 5,808 control characters sit in the scanned fields, and 12 of them are inside a math span. A
// rule about newlines would fire on the other 5,796 and mean nothing. Inside a `$...$` or
// `$$...$$` span there is no legitimate reading -- the block model separates blocks with a blank
// line, and a math span is one span.
//
// The one place this rule knowingly leaves a same-shaped defect alone is a display block, a
// block with no `$` at all: 13 of the corpus's control characters are `\text` eaten inside
// display blocks in m5-l1 and m5-l2, and a display block cannot be searched for a control
// character without also catching the 29 line feeds that legitimately lay a display block out
// over several lines. Tab-in-a-display-block is therefore its own rule, filed separately,
// rather than a widening of this one.
//
// Deliberate false positive, recorded so it is a decision and not an accident: an author who
// wants a math span laid out over several source lines will draw this finding. The convention
// already has a way to say that -- separate blocks with a blank line -- and S3.1-blockstyle
// separately reports `$$…$$` as a legacy fallback. The corpus contains no `$$` field and no
// multi-line math span, so this rule adds no finding to the corpus as it stands today.

const CONTROL_CHAR = /[\n\r\t\f\b]/;
const CONTROL_NAMES = {
  "\n": "line feed (JSON \\n)",
  "\r": "carriage return (JSON \\r)",
  "\t": "tab (JSON \\t)",
  "\f": "form feed (JSON \\f)",
  "\b": "backspace (JSON \\b)",
};

// The path label is `<field>#math<n>`, n counting the math spans of the field from 1 in the
// order they appear. The field is what the author has to open; the span index is what tells
// them which of a dozen formulas in a long bodyLatex is the broken one. `#math<n>` sits beside
// renderBlocks' existing `#block<n>` rather than replacing it: they count different things and
// a report that reused one label for both would make the two unresolvable.
function checkEscapedMacro(value, path) {
  const { blocks, style } = splitBlocks(value);
  let spans = 0;
  const report = (span, at) => {
    const tail = span.slice(at + 1, at + 13).replace(/[\n\r\t\f\b]/g, " ").trim();
    fail("error", "json-escaped-macro", `${path}#math${spans}`,
      `${CONTROL_NAMES[span[at]]} inside a math span, followed by ${JSON.stringify(tail)}: ` +
      "the source almost certainly wrote the macro before it with a single backslash, so JSON " +
      "read the escape and the macro name became literal text. Double the backslash in the JSON " +
      "source (\\\\neq), or write it as \\u005cneq, which JSON cannot mistake for an escape");
  };
  for (const block of blocks) {
    if (style === "dollars") {
      // splitBlocks already stripped the $$ delimiters: the block IS the span.
      spans += 1;
      const at = block.search(CONTROL_CHAR);
      if (at >= 0) report(block, at);
      continue;
    }
    let m;
    INLINE_SEGMENT.lastIndex = 0;
    while ((m = INLINE_SEGMENT.exec(block)) !== null) {
      spans += 1;
      const at = m[1].search(CONTROL_CHAR);
      if (at >= 0) report(m[1], at);
    }
  }
}

function scanMath(value, path, { allowCommandsOutside = false } = {}) {
  checkEscapedMacro(value, path);
  const uni = value.match(UNICODE_MATH);
  check("error", "S3.2-no-unicode-math", path, !uni,
    `raw unicode math in content: ${uni ? [...new Set(uni)].join(" ") : ""} - write the LaTeX command`);
  check("error", "S3.1-no-raw-html", path, !HTML_TAG.test(value) && !HTML_ENTITY.test(value),
    "raw HTML is not allowed in a LaTeX field");
  let m;
  COMMAND.lastIndex = 0;
  while ((m = COMMAND.exec(value)) !== null) {
    const cmd = m[1];
    if (cmd === "begin" || cmd === "end") continue;
    if (DENIED.has(cmd)) {
      fail("error", "S3.2-macro-policy", path, `\\${cmd} is not available in content (S3.2 "write the alternative")`);
    } else if (cmd === "left" || cmd === "right" || cmd === "middle" || cmd === "!") {
      // fine
    } else if (APPROVED.has(cmd) || APP_MACROS.has(cmd) || CORE_SYMBOLS.has(cmd)) {
      // fine
    } else {
      fail("advisory", "S3.2-macro-allowlist", path,
        `\\${cmd} is not in the S3.2 approved list (KaTeX renders it, but the convention does not sanction it)`);
    }
  }
  // environments
  const envs = [...value.matchAll(/\\begin\{([a-zA-Z*]+)\}/g)].map((x) => x[1]);
  for (const env of envs) {
    check("error", "S3.2-environment", path, ALLOWED_ENVIRONMENTS.has(env),
      `\\begin{${env}} is not in the S3.2 approved environment list`);
  }
  if (!allowCommandsOutside) {
    check("error", "S3.1-no-commands-outside-math", path, true, "");
  }
}

function plainReading(value) {
  return value
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$]*\$/g, " ")
    .replace(/\\[a-zA-Z]+|[{}]/g, " ")
    .replace(/\s+/g, "")
    .length;
}

function checkBareFragment(value, path, label) {
  check("error", "S3.1-bare-fragment", path, !value.includes("$"),
    `${label} must be a bare inline fragment with no $ delimiters (S3.1)`);
  check("error", "S3.1-no-dollar-dollar", path, !value.includes("$$"),
    `${label} must not contain $$ (S3.1)`);
  check("error", "S3.1-no-boxed", path, !value.includes("\\boxed"),
    `${label} must not wrap its answer in \\boxed (S3.1)`);
  check("error", "S3.1-no-trailing-period", path, !/[.,;:]$/.test(value.trim()),
    `${label} must not end with punctuation (S3.1)`);
  check("error", "S3.1-no-leading-plus", path, !value.trim().startsWith("+"),
    `${label} must not start with + (S3.1)`);
  check("error", "S3.1-no-tight-space", path, !value.includes("\\!") && !value.includes("\\,"),
    `${label} must not carry spacing hacks (\\! or \\,) (S3.1)`);
  scanMath(value, path);
  const res = renderBlocks(value, path, { allowDisplayDollar: false, label });
  check("error", "S3.3-renders", path, res.failed === 0,
    `${label} has ${res.failed} block(s) that do not render`);
}

// S6: the canonical answer must be canonical, or v1 grading produces false negatives.
function checkAnswerCanonical(ex, path) {
  const a = ex.answerLatex;
  check("advisory", "S6-canonical", path, !/\\left|\\right|\\middle/.test(a),
    "canonical answer uses \\left/\\right, which S6 step 6 strips on both sides; harmless but noise");
  // The real false-negative risk: an answer in set or interval notation, or one
  // that a learner would reasonably paraphrase, with no declared alternative.
  const STRUCTURAL = /\\in|\\cup|\\cap|\\text|\\subseteq?|\\{ |\\\{|\\\}|\\land|\\lor/;
  if (STRUCTURAL.test(a)) {
    check("error", "S6-false-negative-risk", path, (ex.answerAlternatives || []).length > 0,
      "answer is in set/interval/prose notation with no answerAlternatives: S6 step 4 has nothing to match a learner's phrasing against");
  } else if (/[<>]|\\le|\\ge|=/.test(a)) {
    check("advisory", "S6-relational-answer", path, (ex.answerAlternatives || []).length > 0,
      "relational answer with no alternatives: only an exact canonical match will be accepted");
  }
  check("error", "S6-canonical", path, !/\\dfrac|\\tfrac/.test(a),
    "canonical answer must use \\frac, not \\dfrac/\\tfrac (normalized on both sides)");
  check("error", "S6-canonical", path, !/^[\s+]/.test(a), "canonical answer must not start with whitespace");
  if (ex.angleUnit === "rad") {
    check("error", "S6-angle-unit", path, !/\^?\{?\\circ|°/.test(a),
      "answer is declared in radians and must not carry a degree marker (S6 step 10)");
  }
  for (const [i, alt] of (ex.answerAlternatives || []).entries()) {
    checkBareFragment(alt, `${path}.answerAlternatives[${i}]`, "answer alternative");
    check("error", "S6-alternatives-distinct", `${path}.answerAlternatives[${i}]`, alt !== a,
      "answer alternative duplicates the canonical answer");
  }
}

function checkAsymptote(source, alt, ratio, path) {
  if (!source) {
    // "must be null" means "must carry no value", not "must spell the literal null". A record
    // that declares a figure at all spells every field -- the eight reservations in m5-l1 and
    // m5-l2 carry `"asymptoteAlt": null` next to `"asymptoteSource": null` -- but a worked example
    // that ships no figure has no figure fields whatsoever, and reading that absence as a
    // violation produced 146 errors the moment S5.1 was extended to example figures (MAX-76).
    // An absent field is no value; a stray one is.
    check("error", "S9-alt-mandatory", path, !alt && (ratio === null || ratio === undefined),
      "asymptoteAlt / asymptoteAspectRatio must be null when there is no figure");
    return;
  }
  check("error", "S9-alt-mandatory", path, typeof alt === "string" && alt.trim().length >= 20,
    "asymptoteAlt is mandatory with asymptoteSource and must be at least one sentence (S9 #8)");
  check("error", "S9-alt-plain", path, !alt || !alt.includes("$"),
    "asymptoteAlt should be plain prose for screen readers, not LaTeX");
  check("error", "S9-ratio-mandatory", path, typeof ratio === "number" && ratio >= MIN_ASPECT && ratio <= MAX_ASPECT,
    `asymptoteAspectRatio is mandatory and must be within [${MIN_ASPECT}, ${MAX_ASPECT}] (S9 #8)`);

  const lines = source.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//"));
  check("error", "S5.2-line-budget", path, lines.length <= 40,
    `figure source is ${lines.length} lines, budget is 40 (S5.2)`);
  // The rules below read the figure's code, not its header. A source that says
  // size(W,H) in a comment and never calls it declares no ceiling, and a rule that
  // matched the comment would call that a figure: it is exactly how this header was able
  // to defeat the S5.2 self-test while every figure it described was unmeasurable.
  const code = lines.join("\n");
  check("error", "S5.2-size-required", path, /\bsize\s*\(/.test(code),
    "figure source must call size(...) to state a ceiling on the output extent (S5.2). The ceiling " +
    "bounds the output, it is not the box: asymptoteAspectRatio comes from the compiled viewBox (S5.4)");
  // There is deliberately no authoring-time check here that the declared ratio equals
  // size(W,H)/size(W,H). One used to live here, as S5.4-ratio-matches-size, and it was the
  // source of the drift this gate now exists to catch: Asymptote's two-argument size() is a
  // *ceiling* on the output box under the default keepAspect, not the box itself, so requiring
  // declared == size() forced every figure to declare a shape it does not render at. 60 of the
  // 65 figures in the corpus cleared that rule while rendering at a ratio more than 5% away
  // from it, and the compiled box that MAX-4 serves and MAX-5 renders was recorded as null.
  //
  // Rendering Conventions S5.4 item 4 states the rule that does hold, and it compares the
  // declaration to the rendered SVG: within 2% warns, over 5% rejects. That is S5.5, it runs
  // where a compiler exists (scripts/build-figures.mjs), and it is the only ratio check.
  const sizeCall = code.match(/size\s*\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)/);
  if (!sizeCall) {
    fail("advisory", "S5.4-ratio-unverifiable", path,
      "single-argument size() bounds the output but declares no box, so asymptoteAspectRatio cannot be derived " +
      "from the source at authoring time and only S5.5 (declared vs the compiled box) checks it");
  }
  check("error", "S5.2-no-file-io", path, !/\b(input|include|write|open)\s*\(/.test(code),
    "figure source must not do file IO (S5.2)");
  check("error", "S5.2-no-interactivity", path, !/\banimate|add\s*\(\s*\)/.test(code),
    "figure source must not be interactive or animated (S5.2)");
  check("error", "S5.2-no-external-import", path,
    !/^\s*import\s+(?!geometry\b|math\b|graph\b|graph3\b|three\b|patterns\b|stats\b|OIJ\b|OIM\b)/m.test(source),
    "only the standard Asymptote modules are allowed (S5.2)");
  check("error", "S5.2-no-answer-in-figure", path, !/\$[-\d.]+\$/.test(alt),
    "alt text must not restate a numeric answer (S5.2)");
  const primitives = (code.match(/\b(draw|dot|label|filldraw|fill|clip|path)\s*\(/g) || []).length;
  check("advisory", "S5.2-primitive-budget", path, primitives <= 20,
    `figure uses ${primitives} drawing primitives, budget is 20 (S5.2)`);

  // S5.2-tex-label-doubled-backslash: a LaTeX macro written with a doubled backslash inside a
  // label(...) payload. (MAX-119)
  //
  // This is the pass-path half of a rule the build already had on its failure path, and until now
  // the authoring gate had no half at all: scanMath -- which carries json-escaped-macro, S3.2 and
  // S3.3 -- was never pointed at asymptoteSource, so nothing in `content:check` had ever read the
  // inside of a label. Meanwhile scripts/build-figures.mjs carried the detector
  // (doubledBackslashMacros) and called it from diagnoseCompileFailure alone, so the only code that
  // could name this defect ran after a figure had already failed to build.
  //
  // The consequence is measured and it is the reason this is a source-shape rule rather than a
  // render rule. Asymptote copies a string literal into the .tex it generates *verbatim* -- it
  // does not read `\\` as an escape -- so a doubled backslash reaches TeX as two backslashes:
  //
  //   after `^` or `_`   the figure FAILS to compile ("Missing { inserted").
  //   anywhere else       the figure COMPILES CLEAN and renders wrong glyphs. TeX reads `\\` as a
  //                      line break and then sets the bare macro name in italic.
  //
  // Pointing scanMath or S3.3-renders at these payloads would not have caught it, because KaTeX
  // accepts the broken form. Every one of `\frac{a}{b}`, `\sqrt{x-2}`, `b\cos C`,
  // `\lceil 7/3 \rceil`, `\theta`, `3^{2}\equiv 1\pmod{8}`, `4 \cdot 3 \cdot 2 = 24`,
  // `\angle AOB` and `\frac{a}{\sin A} = 2R` renders without error against the pinned
  // katex@0.16.11. Only `90^\circ` is rejected, and only because the doubling happens to sit after
  // a `^` -- which is the one case that already fails loudly by itself. A gate that asks "does it
  // render?" is blind to this class by construction: the broken form is valid TeX.
  //
  // So this reads the shape of the payload and needs neither KaTeX nor a compiler. It sits in
  // checkAsymptote, which is the only place all three figure sites arrive: concept/objective/
  // other section figures and worked-example figures (below, via lessonFigureRecords) and exercise
  // figures. That reach is the whole point of putting it here rather than at one call site -- the
  // asymmetry MAX-76 was about was a rule that ran on lesson figures and not on the other two.
  const badLabels = doubledBackslashInTexLabels(source);
  for (const bad of badLabels) {
    // Two rule ids for two consequences, not two rules to remember. After `^`/`_` the figure does
    // not build, and the build's own diagnosis (DOUBLED_BACKSLASH_AFTER_SCRIPT) says so. Anywhere
    // else it builds fine and ships wrong glyphs, which is the case no compiler output will ever
    // mention. A message claiming "Missing { inserted" for a figure that compiles clean would be
    // wrong in the one situation this rule most needs to be believed about.
    const afterScript = bad.afterScript.length > 0;
    check("error", afterScript ? "S5.2-tex-label-doubled-backslash-after-script"
                               : "S5.2-tex-label-doubled-backslash", path, false,
      `LaTeX macro${bad.macros.length > 1 ? "s" : ""} written with a doubled backslash in a TeX label payload ` +
      `(${bad.macros.join(", ")}). Asymptote copies string literals into the .tex it generates verbatim, so both ` +
      `backslashes reach TeX` +
      (afterScript
        ? `, and immediately after ^ or _ TeX takes exactly one token as its argument, so this figure fails to ` +
          `compile with "Missing { inserted".`
        : `, where TeX reads \\\\ as a line break and then sets the bare macro name in italic: the figure ` +
          `COMPILES CLEAN and renders the wrong glyphs, which is why KaTeX renders it without complaint and ` +
          `why only the build's failure path used to notice.`) +
      ` Write one backslash: ${bad.macros[0].replace(/\\\\/g, "\\")}, not ${bad.macros[0]}.`);
  }
  return true;
}

// S5.1: "Every figure has a caption sentence in the prose, not a `Fig. 1` label."
//
// The rule is about figures, so it has to run on figures. It used to run over `concept.figures`
// and nothing else: a worked-example figure was never passed to checkAsymptote at all, so its
// source, its alt text and its caption went unvalidated while the gate reported a clean run
// (MAX-76). All 8 worked-example figures in the corpus carry no `captionLatex` and every one of
// them passed.
//
// Which figures the rule *binds* was left open here and reported as an advisory while MAX-60
// measured it. MAX-93 settled it, and §5.1 now splits in two, so the check splits with it:
//
//   S5.1-no-figure-number binds EVERY figure, wherever a figure lives. The prohibition is the part
//   of §5.1 that is unconditional -- "the UI has no figure-numbering convention and shouldn't
//   acquire one" -- and a `Fig. 1` on a worked-example or exercise figure would be exactly the
//   thing §5.1 is written to stop. This is the half that must not be lost by narrowing scope, so it
//   runs on every figure and is an error.
//
//   S5.1-caption-sentence binds concept section figures only. A caption is prose the reader sees in
//   the figure's own block, and a worked-example or exercise figure already has one: a worked
//   example's figure is introduced by the example's own body, and an exercise figure is introduced
//   by its prompt and then described by `asymptoteAlt`, which S9 #8 already makes mandatory. A
//   third description of one figure is noise. The description that has to survive is not the
//   caption but the alt text, because §5.6 renders the alt *visibly* in the degraded state and no
//   caption at all -- the caption is decorative, and §5.3's renderer contract already types it
//   `caption?`. So requiring one outside concept.figures would demand prose that no state needs.
//
// `binding` is therefore the concept-figure flag and nothing else. Worked-example and exercise
// figures still pass through here -- MAX-76's real fix was that this function reaches them at all,
// and it still does -- so a figure number on any of them is an error even though a missing caption
// is not. What is deleted is the advisory that named the open question; the question is answered.
function checkCaption(record, path, { binding }) {
  const caption = record.captionLatex;
  scanMath(caption || "", path, { allowCommandsOutside: true });
  // An absent caption is not a figure number, so this holds for a record that carries none.
  check("error", "S5.1-no-figure-number", path,
    !(typeof caption === "string" && /^\s*Fig\.?\s*\d/.test(caption)),
    "a figure caption is a sentence in the prose, never a figure number (S5.1)");
  if (!binding) return;
  check("error", "S5.1-caption-sentence", path,
    typeof caption === "string" && caption.trim().length > 0,
    "a concept section figure carries a caption sentence in the prose (S5.1)");
}

// A declared figure record with no source. The record is a reservation: the caption and the alt
// text are authored ahead of the Asymptote, and the build compiles nothing for it. It is a figure
// the corpus has promised itself and not yet delivered, which is worth seeing and is not worth
// charging to an S5.1 ceiling. Advisory, because the reservation is legitimate authoring state --
// m5-l1 and m5-l2 each hold four while their figures are written.
function checkFigureReserved(record, path) {
  check("advisory", "S5.1-figure-reserved", path, isRenderableFigure(record),
    "figure record reserves a slot but carries no asymptoteSource, so the build compiles nothing for it; " +
    "it is not counted against an S5.1 budget until its source lands");
}

// A figure id is the name an author gives a figure, and it is the name everything else reaches for
// when it means that figure: a content drop, a review comment, and the delivery gate on MAX-104,
// which walks sections.<name>.figures[] for the id it was asked about. A record that declares no id
// cannot be named, so nothing can assert it shipped. It exists, it renders, and it is invisible to
// every check that could say whether it was delivered -- which is the defect, not a cosmetic one.
//
// MAX-106's figure-id-unique cannot catch this, and correctly so: a record with no id cannot collide.
// It is a separate rule because it is a separate question. Four of m5-l1's figure reservations
// declared none, which is what MAX-107 is about: they had captions, alt text slots and aspect-ratio
// slots, and no name.
//
// Reservations are included, and they are the case that matters most. A reservation is not a figure
// yet -- it is the promise of one, authored ahead of the Asymptote -- and it is the state an author
// adds a record in and leaves alone. The id is the one field an author has to invent rather than
// transcribe, so it is the one that gets left out. Filling in the source later does not add it.
//
// Scoped to section figures, `sections.<name>.figures[]`, because that is the set MAX-104's resolver
// walks. Worked-example figures live in `sections.<name>.examples[]` and exercise figures hang off an
// exercise id, which is already the record's own address; neither is resolved by figure id by
// anything today. Widening this to them is a separate decision, and a deliberate one -- not an
// oversight to be read as permission.
//
// The site is named in the same spelling figure-id-unique uses -- `lessons/<id>.sections.<name>.
// figures[<i>]` -- because the two rules answer about the same records and a reader holding one
// finding should be able to find the other without translating.
function checkFigureIdRequired(site, sitePath) {
  if (site.kind !== "section") return;
  const id = site.record.id;
  check("error", "figure-id-required", `${sitePath}.id`,
    typeof id === "string" && id.trim() !== "",
    "figure record declares no id, so nothing can name it: a content drop, a review comment and the " +
    "delivery gate all address a figure by its id, and a close-out cannot assert delivery of a " +
    `record it cannot refer to. Author it as <lesson-id>-fig-<n>, counting within the section (MAX-107)`);
}

function checkExercise(ex, lessonIndex) {
  const path = `exercises/${ex.id}`;
  const where = (f) => `${path}.${f}`;

  check("error", "S3.3-enum", where("tier"), TIERS.has(String(ex.tier)),
    `tier must be one of 10|12|A|A+ (got ${JSON.stringify(ex.tier)})`);
  check("error", "S3.3-enum", where("difficulty"),
    Number.isInteger(ex.difficulty) && ex.difficulty >= 1 && ex.difficulty <= 5,
    "difficulty must be an integer 1-5");
  for (const t of ex.tags || []) {
    check("error", "S3.3-tag-vocabulary", where("tags"), TAGS.has(t),
      `tag ${JSON.stringify(t)} is not in the closed vocabulary`);
  }

  // prompt
  scanMath(ex.promptLatex, where("promptLatex"), { allowCommandsOutside: true });
  const pr = renderBlocks(ex.promptLatex, where("promptLatex"), { label: "prompt" });
  check("error", "S3.3-renders", where("promptLatex"), pr.failed === 0,
    `prompt has ${pr.failed} block(s) that do not render`);
  const chars = plainReading(ex.promptLatex);
  check("error", "S3.3-plain-reading", where("promptLatex"), chars >= 20,
    `plain-text reading of the prompt is ${chars} characters, minimum is 20 (S3.3 rule 3)`);

  // choices
  if (ex.choices !== null && ex.choices !== undefined) {
    check("error", "S3.3-choices-arity", where("choices"), ex.choices.length === 5,
      `choices must be null or exactly 5 entries (got ${ex.choices.length})`);
    ex.choices.forEach((c, i) => {
      checkBareFragment(c, `${where("choices")}[${i}]`, "choice");
      const ok = ex.choices.filter((x) => x === c).length === 1;
      check("error", "S3.3-choices-distinct", `${where("choices")}[${i}]`, ok, "duplicate choice");
    });
  }

  // answer
  checkBareFragment(ex.answerLatex, where("answerLatex"), "answerLatex");
  checkAnswerCanonical(ex, where("answerLatex"));
  if (ex.choices) {
    check("error", "S3.3-answer-matches-choice", where("answerLatex"),
      ex.choices.includes(ex.answerLatex),
      "for a multiple-choice exercise the canonical answer must equal one of the choice strings exactly");
  } else {
    check("error", "S3.3-fr-response-single", where("answerLatex"),
      !/\\text|\\begin\{(array|cases)\}/.test(ex.answerLatex),
      "free-response answers in v1 must be a single comparable value or a declared alternative set");
  }
  check("error", "S3.1-degrees-field", where("answerAngle"),
    ex.answerAngle === undefined || ex.answerAngle === "deg",
    "answerAngle may only be \"deg\" when present (default is degrees)");
  check("error", "S3.1-degrees-field", where("angleUnit"),
    ex.angleUnit === undefined || ex.angleUnit === "rad",
    "angleUnit may only be \"rad\" when present (default is degrees)");

  // hints - S3.4 ladder: three rungs, rung 1 direction only
  const hints = ex.hintLatex || [];
  check("error", "S8-hint-count", where("hintLatex"), hints.length >= 1 && hints.length <= 3,
    `hintLatex must have 1-3 entries (got ${hints.length})`);
  hints.forEach((h, i) => {
    scanMath(h, `${where("hintLatex")}[${i}]`);
    const r = renderBlocks(h, `${where("hintLatex")}[${i}]`, { label: `hint ${i + 1}` });
    check("error", "S3.3-renders", `${where("hintLatex")}[${i}]`, r.failed === 0,
      `hint ${i + 1} does not render`);
    const sentences = h.split(/[.!?]\s+/).filter((s) => s.trim()).length;
    check("advisory", "S3.4-hint-length", `${where("hintLatex")}[${i}]`, sentences <= 2,
      `hint ${i + 1} is ${sentences} sentences, target is at most 2`);
  });
  if (hints[0]) {
    const methodWords = /\b(multiply both sides|divide both sides|set |factor|split the real line into|rearrange|rewrite)\b/i;
    check("advisory", "S3.4-rung1-no-method", `${where("hintLatex")}[0]`, !methodWords.test(hints[0]),
      "rung 1 must be a direction, not a method (S3.4)");
  }

  // solution
  scanMath(ex.solutionLatex, where("solutionLatex"), { allowCommandsOutside: true });
  const sr = renderBlocks(ex.solutionLatex, where("solutionLatex"), { label: "solution" });
  check("error", "S3.3-renders", where("solutionLatex"), sr.failed === 0,
    `solution has ${sr.failed} block(s) that do not render`);
  check("advisory", "S3.1-full-derivation", where("solutionLatex"), sr.count >= 2,
    "a solution must be a derivation, not an answer (spec S3.5)");

  // technique deep links must resolve on the same lesson page
  const lesson = lessonIndex.get(ex.lessonId);
  if (lesson) {
    const slugs = new Set(lesson.sections.techniques.items.map((t) => t.slug));
    for (const s of ex.techniqueSlugs || []) {
      check("error", "S3.4-deep-link", where("techniqueSlugs"), slugs.has(s),
        `technique slug ${JSON.stringify(s)} has no #tech-${s} anchor on lesson ${ex.lessonId} (broken deep link)`);
    }
  }

  const hasFigure = checkAsymptote(ex.asymptoteSource, ex.asymptoteAlt, ex.asymptoteAspectRatio, path) === true;
  check("error", "S5.1-figure-per-exercise", path,
    !(hasFigure && [ex, ex.figure].filter(Boolean).length > MAX_FIGURES_PER_EXERCISE),
    "an exercise carries at most one figure (S5.1)");
  // Same function, same reach. An exercise figure does not owe a caption (MAX-93 settled §5.1's
  // scope against concept section figures), but it still may not carry a figure number, so it is
  // passed with `binding: false` rather than skipped: checkAsymptote and S5.1-no-figure-number both
  // live in that call.
  if (hasFigure) checkCaption(ex, `${where("captionLatex")}`, { binding: false });
}

// ---------------------------------------------------------------------------
// Ids are addresses (MAX-106)
// ---------------------------------------------------------------------------
//
// A figure id is the name an author gives a figure and the name everyone reaches for when they
// mean it -- a content drop, a review comment, and the delivery gate on MAX-104, which walks
// sections.<name>.figures[] looking for the id it was asked about. Nothing enforced that, and
// that is how two records ended up holding one: m9-l3 and m9-l4 each hung a figure on the
// `objective` section whose id was the id of the lesson's own `concept` figure, the same record
// copied byte for byte. It broke nothing, precisely because nothing resolved by id yet.
//
// It becomes a key the moment anything does, and then a duplicate does not fail loudly. A
// resolver that finds two records for one id returns whichever it saw first, and the gate reports
// that figure as delivered -- a check that cannot say which of two things it meant is not
// evidence of anything. So the collision is an error here, before the consumer that would have to
// guess at it, and not left to that consumer to detect.
//
// Corpus-wide rather than per-lesson. The id is meant to be an address, and an address scoped to
// one file is not an address. Every finding names every site holding the id, because "m9-l3-fig-1
// is used twice" is not actionable and "m9-l3-fig-1 is held by sections.objective.figures[0] and
// sections.concept.figures[0]" is.
//
// Worked examples get the same check for the same reason and because the same two lessons had
// them: m9-l3-ex-1, m9-l3-ex-2, m9-l4-ex-1 and m9-l4-ex-2 were each authored into `objective`
// and `concept`, the objective copies being the pre-markup drafts of the concept ones -- same
// ids, and text that renders `n \ge 2` literally because it never learned the $...$ spans. A
// record that carries no id is not a collision and is skipped rather than reported: four of
// m5-l1's figure reservations declare no id at all, which is a separate gap and not this rule.
function checkIdUniqueness(lessons) {
  const figures = new Map();
  const examples = new Map();

  const claim = (into, id, site) => {
    if (typeof id !== "string" || id.trim() === "") return;
    if (!into.has(id)) into.set(id, []);
    into.get(id).push(site);
  };

  for (const lesson of lessons) {
    // `lessonFigureRecords` is the one walk over figures -- section figures on any section and
    // worked-example figures, reservations included -- so the sites named here are the same
    // addresses the build compiles under, not a second spelling of them.
    for (const site of lessonFigureRecords(lesson)) {
      const field = site.kind === "example" ? "examples" : "figures";
      claim(figures, site.record.id, `lessons/${lesson.id}.sections.${site.sectionName}.${field}[${site.index}]`);
    }
    for (const [sectionName, section] of Object.entries((lesson && lesson.sections) || {})) {
      for (const [index, record] of (section.examples || []).entries()) {
        claim(examples, record && record.id, `lessons/${lesson.id}.sections.${sectionName}.examples[${index}]`);
      }
    }
  }

  const report = (rule, claimed, kind) => {
    for (const [id, sites] of claimed) {
      if (sites.length < 2) continue;
      check("error", rule, "corpus", false,
        `${kind} id ${JSON.stringify(id)} is claimed by ${sites.length} records (${sites.join(", ")}); ` +
        "an id is an address, and two records sharing one resolve to whichever came first");
    }
  };
  report("figure-id-unique", figures, "figure");
  report("worked-example-id-unique", examples, "worked-example");
}

function checkLesson(lesson, exerciseIds, exerciseById) {
  const path = `lessons/${lesson.id}`;
  const where = (f) => `${path}.${f}`;
  const ORDER = ["objective", "prerequisites", "concept", "techniques", "pitfalls", "practice", "solutions", "mastery"];

  check("error", "S8-section-order", where("sections"),
    JSON.stringify(Object.keys(lesson.sections)) === JSON.stringify(ORDER),
    "the 8 sections must be present, in order, with the fixed ids");

  for (const [field, value] of [
    ["objectiveLatex", lesson.sections.objective.objectiveLatex],
    ["noteLatex", lesson.sections.prerequisites.noteLatex],
    ["conceptLatex", lesson.sections.concept.conceptLatex],
  ]) {
    if (value === undefined) continue;
    scanMath(value, where(field), { allowCommandsOutside: true });
    const r = renderBlocks(value, where(field), { label: field });
    check("error", "S3.3-renders", where(field), r.failed === 0,
      `${field} has ${r.failed} block(s) that do not render`);
  }

  const words = lesson.sections.concept.conceptLatex
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$]*\$/g, " ")
    .split(/\s+/)
    .filter((w) => /[a-zA-Z]/.test(w)).length;
  check("advisory", "S8-concept-length", where("sections.concept"), words >= 400 && words <= 900,
    `concept section is ${words} words, template requires 400-900`);

  const examples = lesson.sections.concept.examples || [];
  check("error", "S8-worked-examples", where("sections.concept.examples"), examples.length >= 3,
    `concept needs at least 3 worked examples (got ${examples.length})`);
  examples.forEach((ex, i) => {
    for (const f of ["titleLatex", "bodyLatex"]) {
      scanMath(ex[f], `${where(`sections.concept.examples[${i}].${f}`)}`, { allowCommandsOutside: true });
      const r = renderBlocks(ex[f], `${where(`sections.concept.examples[${i}].${f}`)}`, { label: f });
      check("error", "S3.3-renders", `${where(`sections.concept.examples[${i}].${f}`)}`, r.failed === 0,
        `${f} of worked example ${i + 1} does not render`);
    }
  });

  const slugs = new Set();
  for (const [i, t] of lesson.sections.techniques.items.entries()) {
    check("error", "S8-technique-slug", where(`sections.techniques.items[${i}].slug`),
      typeof t.slug === "string" && /^[a-z0-9-]+$/.test(t.slug) && !slugs.has(t.slug),
      `technique slug must be unique kebab-case (got ${JSON.stringify(t.slug)})`);
    slugs.add(t.slug);
    for (const f of ["summaryLatex", "bodyLatex"]) {
      scanMath(t[f], where(`sections.techniques.items[${i}].${f}`), { allowCommandsOutside: true });
      const r = renderBlocks(t[f], where(`sections.techniques.items[${i}].${f}`), { label: f });
      check("error", "S3.3-renders", where(`sections.techniques.items[${i}].${f}`), r.failed === 0,
        `${f} of technique ${t.slug} does not render`);
    }
  }

  const pitfalls = lesson.sections.pitfalls.items || [];
  check("advisory", "S8-pitfall-count", where("sections.pitfalls"), pitfalls.length >= 2 && pitfalls.length <= 3,
    `template requires 2-3 pitfalls (got ${pitfalls.length})`);
  for (const [i, p] of pitfalls.entries()) {
    check("error", "S8-pitfall-wrong-answer", where(`sections.pitfalls.items[${i}].wrongLatex`),
      typeof p.wrongLatex === "string" && p.wrongLatex.trim().length > 0,
      "a pitfall must show the wrong answer explicitly (spec S8 #4)");
    for (const f of ["wrongLatex", "whyLatex", "fixLatex"]) {
      scanMath(p[f], where(`sections.pitfalls.items[${i}].${f}`), { allowCommandsOutside: true });
      const r = renderBlocks(p[f], where(`sections.pitfalls.items[${i}].${f}`), { label: f });
      check("error", "S3.3-renders", where(`sections.pitfalls.items[${i}].${f}`), r.failed === 0,
        `${f} of pitfall ${i + 1} does not render`);
    }
  }

  // id lists, not embedded copies
  const practice = lesson.sections.practice.exerciseIds;
  const solutions = lesson.sections.solutions.exerciseIds;
  const mastery = lesson.sections.mastery.exerciseIds;
  check("error", "S8-id-lists", where("sections.practice"),
    practice.every((id) => exerciseIds.has(id)), "practice references an unknown exercise id");
  check("error", "S8-id-lists", where("sections.solutions"),
    solutions.length === practice.length && solutions.every((id) => practice.includes(id)),
    "the solutions section must mirror the practice list");
  check("error", "S8-mastery-count", where("sections.mastery"), mastery.length === 3,
    `the mastery check must be exactly 3 exercises (got ${mastery.length})`);
  check("error", "S8-no-embedded-copies", where("sections.practice"),
    !JSON.stringify(lesson.sections.practice).includes("promptLatex"),
    "practice must be an id list, not embedded exercise copies");
  const masteryTiers = new Set(mastery.map((id) => (exerciseById.get(id) || {}).tier));
  check("advisory", "S8-mastery-mixed-tier", where("sections.mastery"),
    masteryTiers.size >= 2 && !masteryTiers.has(undefined),
    `the mastery check should mix tiers (found ${[...masteryTiers].join(", ") || "none"})`);

  // figures in the lesson
  //
  // One walk, two readings, counted once. The previous version seeded the total with
  // `conceptFigures.length` and then added one more inside the loop for every figure whose source
  // parsed, so each concept figure was charged twice (63 of them), and it seeded the total with the
  // *declared* records, including the eight reservations whose `asymptoteSource` is null. It also
  // never looked at a figure outside `concept.figures`, of which this corpus had exactly two: the
  // `objective`-section figures on m9-l3 and m9-l4, each a byte-for-byte copy of that lesson's own
  // concept figure under the same id. MAX-106 removed both, so the corpus now hangs every figure
  // off `concept` -- and this walk is what stops that being load-bearing, since the next lesson to
  // hang one elsewhere is validated here either way.
  //
  // `lessonFigureRecords` is every declared figure-bearing record and is what gets validated: a
  // reservation is not a figure, but it is still a record an author can contradict, and dropping
  // it from validation would have quietly stopped S9-alt-mandatory from firing on a figure with no
  // source and a stray alt text. `lessonFigureSites` is the renderable subset and is what every
  // budget below is metered against, which is the same walk the figure build compiles (MAX-76).
  const declared = lessonFigureRecords(lesson);
  const sites = declared.filter((s) => isRenderableFigure(s.record));
  const conceptFiguresRendered = sites.filter((s) => s.kind === "section" && s.sectionName === "concept").length;
  const exampleFigures = sites.filter((s) => s.kind === "example").length;

  for (const site of declared) {
    const sitePath = where(`sections.${site.sectionName}.${site.kind === "example" ? "examples" : "figures"}[${site.index}]`);
    checkFigureIdRequired(site, sitePath);
    checkFigureReserved(site.record, `${sitePath}.asymptoteSource`);
    checkAsymptote(site.record.asymptoteSource, site.record.asymptoteAlt,
      site.record.asymptoteAspectRatio, sitePath);
    // Every figure the lesson owns still comes through here: section figures on any section, and
    // worked-example figures. The example figures were the gap -- an unvalidated example figure is
    // a figure whose source and alt text have never met a rule at all. `binding` is what MAX-93
    // narrowed, not the set of figures reached: an example figure may not carry a `Fig. 1`, and a
    // section figure outside concept may not either.
    checkCaption(site.record, `${sitePath}.captionLatex`, {
      binding: site.kind === "section" && site.sectionName === "concept",
    });
  }

  check("advisory", "S5.1-concept-figure-budget", where("sections.concept"),
    conceptFiguresRendered <= MAX_FIGURES_IN_CONCEPT,
    `concept section carries ${conceptFiguresRendered} figures, ceiling is ${MAX_FIGURES_IN_CONCEPT}` +
    (conceptFiguresRendered === 0 ? " (the lesson reserves none with a source yet)" : ""));
  check("advisory", "S5.1-example-figure-budget", where("sections.concept.examples"),
    exampleFigures <= MAX_FIGURES_IN_EXAMPLES,
    `worked examples carry ${exampleFigures} figures, ceiling is ${MAX_FIGURES_IN_EXAMPLES}`);
  check("advisory", "S5.1-lesson-figure-budget", path, sites.length <= MAX_FIGURES_PER_LESSON,
    `lesson carries ${sites.length} figures, ceiling is ${MAX_FIGURES_PER_LESSON}`);

}

// ---------------------------------------------------------------------------
// Load and run
// ---------------------------------------------------------------------------

function loadDir(dir, files) {
  if (!files.length) return [];
  return files.flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

export function run(contentRoot) {
  findings.length = 0;
  checksRun = 0;
  const lessons = loadDir(join(contentRoot, "lessons"), readdirSync(join(contentRoot, "lessons")));
  const exercises = loadDir(join(contentRoot, "exercises"), readdirSync(join(contentRoot, "exercises")));
  const fixtures = loadDir(join(contentRoot, "fixtures"), readdirSync(join(contentRoot, "fixtures")));
  const lessonIndex = new Map(lessons.map((l) => [l.id, l]));
  const exerciseIds = new Set([...exercises, ...fixtures].map((e) => e.id));

  let blocksRendered = 0;
  const exerciseById = new Map([...exercises, ...fixtures].map((e) => [e.id, e]));
  for (const l of lessons) checkLesson(l, exerciseIds, exerciseById);
  for (const e of [...exercises, ...fixtures]) {
    checkExercise(e, lessonIndex);
    blocksRendered += splitBlocks(e.solutionLatex).blocks.length;
  }
  // After the per-lesson passes, not inside one of them: an id is unique across the corpus, so a
  // check that ran per lesson could only ever catch a collision inside a single file (MAX-106).
  checkIdUniqueness(lessons);
  // The corpus figure total comes from the shared counter, not from summing the per-lesson
  // returns. Summing a return value is how this number drifted from the build's in the first
  // place: the build's scan and the gate's tally were two independent expressions of "figure",
  // and the gate's added each lesson's declared records *and* each lesson's rendered ones.
  // scripts/check-content-math.mjs asserts this total against collectFigures() on every self-test
  // run, so the two can no longer disagree without CI going red (MAX-76).
  const figures = countFigures(lessons, [...exercises, ...fixtures]);
  check("advisory", "S5.1-corpus-figure-budget", "corpus", figures <= MAX_CORPUS_FIGURES,
    `corpus declares ${figures} figures, budget is ${MAX_CORPUS_FIGURES}`);

  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  const advisories = findings.filter((f) => f.severity === "advisory");
  return {
    report: {
      generator: "scripts/preflight-content.mjs",
      katexVersion: KATEX_PINNED,
      katexInstalled: katex.version,
      renderOptions: RENDER_OPTIONS,
      corpus: {
        lessons: lessons.length,
        exercises: exercises.length,
        fixtures: fixtures.length,
        figures,
        figureBudget: MAX_CORPUS_FIGURES,
      },
      checksRun,
      totals: { error: errors.length, warning: warnings.length, advisory: advisories.length },
      status: errors.length === 0 ? "pass" : "fail",
      // Copy, do not alias: `findings` is module-level and is truncated in place by the next
      // run(). Returning it directly meant a caller holding one report saw it refilled by a
      // second run() on a different corpus, while `totals` above kept the old counts — a
      // report that contradicted itself. Any caller that compares two reports was comparing
      // one array with itself.
      findings: findings.map((f) => ({ ...f })),
    },
    errors,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const jsonIdx = args.indexOf("--json");
  const contentRoot = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : join(REPO, "content");
  const { report, errors } = run(contentRoot);

  // `--json` with no path used to read `args[jsonIdx + 1]`, which is undefined, and died in
  // dirname() with a bare TypeError — so the documented way to read the numbers
  // (`preflight-content.mjs --json`, the command the MAX-76 verification names) printed a stack
  // trace instead of a report. Bare --json now means stdout, which is what a flag of that name
  // means everywhere else; `--json <path>` keeps writing the file, and the artifact is written
  // either way so CI still uploads it.
  const jsonPath = jsonIdx >= 0 ? args[jsonIdx + 1] : undefined;
  const jsonToPath = Boolean(jsonPath) && !jsonPath.startsWith("--");
  const outPath = jsonToPath ? jsonPath : join(REPO, "artifacts", "content-math-report.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
  if (jsonIdx >= 0 && !jsonToPath) console.log(JSON.stringify(report, null, 2));

  const { status, corpus, totals, checksRun: n } = report;
  console.log(`preflight-content: ${status.toUpperCase()}  (${n} checks, KaTeX ${katex.version})`);
  console.log(`  corpus: ${corpus.lessons} lessons, ${corpus.exercises} exercises, ${corpus.fixtures} fixtures, ${corpus.figures}/${corpus.figureBudget} figures`);
  console.log(`  errors ${totals.error} · warnings ${totals.warning} · advisories ${totals.advisory}`);
  for (const f of errors) console.log(`  [error] ${f.rule} ${f.path}: ${f.message}`);
  for (const f of report.findings.filter((x) => x.severity !== "error")) {
    console.log(`  [${f.severity}] ${f.rule} ${f.path}: ${f.message}`);
  }
  console.log(`  report: ${outPath}`);
  process.exit(report.status === "pass" ? 0 : 1);
}
