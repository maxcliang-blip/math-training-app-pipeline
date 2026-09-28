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
// Usage: node scripts/preflight-content.mjs [contentRoot] [--json <outPath>]

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import katex from "katex";

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
  `frac dfrac tfrac sqrt binom dbinom tbinom left right middle mathbb mathcal mathfrak mathscr mathbf mathrm mathmathit mathsf operatorname text textbf textit emph overline underline widetilde widehat vec bar hat dot ddot
   matrix pmatrix bmatrix vmatrix cases array aligned gathered smallmatrix substack boxed overbrace underbrace displaystyle textstyle limits nolimits
   sum prod int oint lim max min gcd deg mod pmod
   , ! ; : quad qquad dots cdots vdots ddots infty
   equiv approx ne le ge propto angle triangle perp parallel sim to rightarrow mapsto implies iff`
    .split(/\s+/)
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
const MAX_FIGURES_PER_EXERCISE = 1;
const MAX_FIGURES_IN_CONCEPT = 4;
const MAX_FIGURES_IN_EXAMPLES = 2;
const MAX_FIGURES_PER_LESSON = 8;
const MAX_CORPUS_FIGURES = 185;
const MAX_ASPECT = 3;
const MIN_ASPECT = 0.5;
// Content declares aspect ratios to 3 decimals, so every ratio comparison in the pipeline
// rounds to the same precision. Both sides are rounded, so the declaration's own quantization
// cannot masquerade as drift in either direction. Shared with scripts/build-figures.mjs.
const RATIO_DECIMALS = 3;

const TIERS = new Set(["10", "12", "A", "A+"]);
const TAGS = new Set([
  "linear-equations", "inequalities", "absolute-value", "fractions", "domain",
  "exponents", "quadratics", "factoring", "radicals", "word-problem", "counting-integers",
  "region-split", "intervals", "distributive-law", "angles", "circles", "chords",
  "pythagorean", "trig-conversion", "triangles",
]);

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

function scanMath(value, path, { allowCommandsOutside = false } = {}) {
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
    check("error", "S9-alt-mandatory", path, !alt && ratio === null,
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
  check("error", "S5.2-size-required", path, /\bsize\s*\(/.test(source),
    "figure source must call size(...) so the pipeline knows its dimensions (S5.2)");
  const sizeCall = source.match(/size\s*\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)/);
  if (sizeCall && typeof ratio === "number") {
    // S5.4 authoring rule: exact at the declared precision, not a percentage tolerance.
    // Both sides come from integers written in the same record, so this is a transcription
    // check with no physical uncertainty to absorb. A tolerance here only hides mistakes,
    // and worse, it disagrees with the figure build, which compares at the same precision:
    // content inside the old 2% band would pass authoring and then fail CI. Rule S5.4a
    // (declared vs size()) is exact; the compiled-box drift is S5.5 and carries the 2%/5% tiers.
    const declared = Number(sizeCall[1]) / Number(sizeCall[2]);
    const atPrecision = Number(declared.toFixed(RATIO_DECIMALS));
    check("error", "S5.4-ratio-matches-size", path, ratio === atPrecision,
      `asymptoteAspectRatio ${ratio} is not size(${sizeCall[1]},${sizeCall[2]}) = ${atPrecision} ` +
      `(${declared.toFixed(4)} rounded to ${RATIO_DECIMALS} decimals); S5.4a is exact at the declared precision`);
    check("advisory", "S5.2-size-arity", path, true,
      "two-argument size() is what makes the declared ratio exact; size(300) alone leaves the ratio to the natural bounding box");
  } else if (!sizeCall) {
    fail("advisory", "S5.4-ratio-unverifiable", path,
      "single-argument size(): the real aspect ratio is not knowable until compile, so S5.4a cannot be checked at authoring time and only S5.5 applies");
  }
  check("error", "S5.2-no-file-io", path, !/\b(input|include|write|open)\s*\(/.test(source),
    "figure source must not do file IO (S5.2)");
  check("error", "S5.2-no-interactivity", path, !/\banimate|add\s*\(\s*\)/.test(source),
    "figure source must not be interactive or animated (S5.2)");
  check("error", "S5.2-no-external-import", path,
    !/^\s*import\s+(?!geometry\b|math\b|graph\b|graph3\b|three\b|patterns\b|stats\b|OIJ\b|OIM\b)/m.test(source),
    "only the standard Asymptote modules are allowed (S5.2)");
  check("error", "S5.2-no-answer-in-figure", path, !/\$[-\d.]+\$/.test(alt),
    "alt text must not restate a numeric answer (S5.2)");
  const primitives = (source.match(/\b(draw|dot|label|filldraw|fill|clip|path)\s*\(/g) || []).length;
  check("advisory", "S5.2-primitive-budget", path, primitives <= 20,
    `figure uses ${primitives} drawing primitives, budget is 20 (S5.2)`);
  return true;
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
  return { hasFigure };
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
  const conceptFigures = lesson.sections.concept.figures || [];
  const exampleFigures = (lesson.sections.concept.examples || []).filter((e) => e.asymptoteSource).length;
  check("advisory", "S5.1-concept-figure-budget", where("sections.concept"),
    conceptFigures.length <= MAX_FIGURES_IN_CONCEPT,
    `concept section carries ${conceptFigures.length} figures, ceiling is ${MAX_FIGURES_IN_CONCEPT}`);
  check("advisory", "S5.1-example-figure-budget", where("sections.concept.examples"),
    exampleFigures <= MAX_FIGURES_IN_EXAMPLES,
    `worked examples carry ${exampleFigures} figures, ceiling is ${MAX_FIGURES_IN_EXAMPLES}`);
  let lessonFigures = conceptFigures.length + exampleFigures;
  for (const [i, f] of conceptFigures.entries()) {
    if (checkAsymptote(f.asymptoteSource, f.asymptoteAlt, f.asymptoteAspectRatio,
      `${where(`sections.concept.figures[${i}]`)}`)) lessonFigures += 1;
    scanMath(f.captionLatex || "", where(`sections.concept.figures[${i}].captionLatex`), { allowCommandsOutside: true });
    check("error", "S5.1-caption-sentence", where(`sections.concept.figures[${i}].captionLatex`),
      typeof f.captionLatex === "string" && !/^\s*Fig\.?\s*\d/.test(f.captionLatex),
      "a figure caption is a sentence in the prose, never a figure number (S5.1)");
  }
  check("advisory", "S5.1-lesson-figure-budget", path, lessonFigures <= MAX_FIGURES_PER_LESSON,
    `lesson carries ${lessonFigures} figures, ceiling is ${MAX_FIGURES_PER_LESSON}`);

  return { figures: lessonFigures };
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

  let figures = 0;
  let blocksRendered = 0;
  const exerciseById = new Map([...exercises, ...fixtures].map((e) => [e.id, e]));
  for (const l of lessons) figures += checkLesson(l, exerciseIds, exerciseById).figures;
  for (const e of [...exercises, ...fixtures]) {
    const { hasFigure } = checkExercise(e, lessonIndex);
    if (hasFigure) figures += 1;
    blocksRendered += splitBlocks(e.solutionLatex).blocks.length;
  }
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

  const outPath = jsonIdx >= 0 ? args[jsonIdx + 1] : join(REPO, "artifacts", "content-math-report.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");

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
