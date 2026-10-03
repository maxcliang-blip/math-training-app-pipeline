#!/usr/bin/env node
// Engineering-owned CI build gate for the content corpus (Rendering Conventions S3.3, S9 #11).
//
// Author-side reference implementation: scripts/preflight-content.mjs (same rules, runnable
// with no app and no repo). This gate is the one CI runs, and it adds the three guarantees a
// preflight cannot make about itself:
//
//   1. Fail-closed environment. KaTeX must resolve at the pinned version. A gate that cannot
//      render is a failure, never a skip.
//   2. Fail-closed corpus. An absent or empty content root fails. "Nothing to check" is not a pass.
//   3. A non-vacuous gate. --selftest injects one defect per rule family and requires the engine
//      to catch every one of them; a rule with no enforcement makes the selftest fail.
//
// The figure build is a separate gate: scripts/build-figures.mjs.
//
// Usage:
//   node scripts/check-content-math.mjs [contentRoot] [--json <outPath>] [--selftest]
//
// Exit codes: 0 pass · 1 content or selftest failure · 2 environment/configuration error.

import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import katex from "katex";
import { run, KATEX_PINNED } from "./preflight-content.mjs";
import { collectFigures } from "./build-figures.mjs";
import { isRenderableFigure, lessonFigureRecords } from "../lib/figure-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DEFAULT_CONTENT = join(REPO, "content");
const DEFAULT_REPORT = join(REPO, "artifacts", "content-math-report.json");

// The pipeline compares the *compiled* box against the declared ratio, on S5.5's 2%/5% tiers
// (scripts/build-figures.mjs). There is no authoring-time ratio rule left here to hold content
// to a precision, and nothing in this file rounds a ratio.

// ---------------------------------------------------------------------------
// Fail-closed environment
// ---------------------------------------------------------------------------

export function checkEnvironment() {
  const problems = [];
  if (!katex || typeof katex.version !== "string") {
    problems.push("katex did not resolve; the gate cannot render anything");
  } else if (katex.version !== KATEX_PINNED) {
    problems.push(`katex ${katex.version} installed but Rendering Conventions S2 pins ${KATEX_PINNED}`);
  }
  return { problems, katexVersion: katex && katex.version };
}

function checkCorpusShape(contentRoot) {
  const problems = [];
  const counts = {};
  for (const kind of ["lessons", "exercises", "fixtures"]) {
    const dir = join(contentRoot, kind);
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      problems.push(`${kind}/ is missing under ${contentRoot}`);
      counts[kind] = 0;
      continue;
    }
    counts[kind] = files.length;
  }
  if (!problems.length) {
    // The fixture donor is how a rule proves it can fail. Losing it loses the evidence.
    if (counts.fixtures === 0) problems.push("fixtures/ is empty; the rule self-test has no donor");
    if (counts.lessons === 0) problems.push("lessons/ is empty; there is nothing to check");
    if (counts.exercises === 0) problems.push("exercises/ is empty; there is nothing to check");
  }
  return { problems, counts };
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export function checkCorpus(contentRoot) {
  const { report, errors } = run(contentRoot);
  return { report, errors };
}

function summarize(report) {
  const { status, corpus, totals, checksRun } = report;
  return [
    `check-content-math: ${status.toUpperCase()}  (${checksRun} checks, KaTeX ${report.katexInstalled})`,
    `  corpus: ${corpus.lessons} lessons, ${corpus.exercises} exercises, ${corpus.fixtures} fixtures, ${corpus.figures}/${corpus.figureBudget} figures`,
    `  errors ${totals.error} · warnings ${totals.warning} · advisories ${totals.advisory}`,
  ];
}

function printFindings(report, limit = 40) {
  const shown = report.findings.slice(0, limit);
  for (const f of shown) console.log(`  [${f.severity}] ${f.rule} ${f.path}: ${f.message}`);
  if (report.findings.length > limit) {
    console.log(`  … ${report.findings.length - limit} more findings in the report`);
  }
}

// ---------------------------------------------------------------------------
// Self-test: prove the gate can fail
// ---------------------------------------------------------------------------

function loadCorpus(contentRoot) {
  return {
    lessons: readdirSync(join(contentRoot, "lessons"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(contentRoot, "lessons", f), "utf8"))),
    exercises: readdirSync(join(contentRoot, "exercises"))
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => JSON.parse(readFileSync(join(contentRoot, "exercises", f), "utf8"))),
    fixtures: readdirSync(join(contentRoot, "fixtures"))
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => JSON.parse(readFileSync(join(contentRoot, "fixtures", f), "utf8"))),
  };
}

// The figure mutations mutate a real donor, so the donor must be located rather than assumed.
// readdirSync is not sorted, so "lessons[0]" is whichever file the filesystem returned first:
// on a corpus whose first lesson carries no concept figure the figure mutations would throw on
// undefined and report MISSED for a corpus that is actually fine. Scan in lesson-id order and take
// the first figure found, which is stable across filesystems and corpus growth.
//
// The donor must also be a figure the build would render. `asymptoteSource: null` is a legal
// authoring state -- m5-l1 and m5-l2 hold four reservations each while their Asymptote is written
// (MAX-76, S5.1-figure-reserved) -- and against a reservation the `figure-alt-missing` mutation
// below proves nothing: checkAsymptote's no-source branch demands a null alt, so blanking an
// already-absent alt raises nothing. Handing it a reservation makes the mutation silently vacuous
// on exactly the lessons most likely to be edited first.
function findLessonFigure(lessons) {
  const ordered = [...lessons].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const lesson of ordered) {
    const concept = lesson.sections && lesson.sections.concept;
    const figures = concept && concept.figures;
    if (!Array.isArray(figures)) continue;
    const donor = figures.find(isRenderableFigure);
    if (donor) return donor;
  }
  return undefined;
}

// Same discipline, for the worked-example donor. The S5.1 caption rule and the whole S5.2/S9
// authoring contract now run over worked-example figures (MAX-76) -- before that they ran over
// `concept.figures` alone, so all 8 example figures in the corpus had never been validated by
// anything. A rule that is newly reachable and unproved is a rule that will be quietly broken, so
// the mutations below aim at an example figure specifically: they fail if the scope is ever
// narrowed back.
function findLessonExampleFigure(lessons) {
  const ordered = [...lessons].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const lesson of ordered) {
    for (const section of Object.values(lesson.sections || {})) {
      const examples = section && section.examples;
      if (!Array.isArray(examples)) continue;
      const donor = examples.find(isRenderableFigure);
      if (donor) return donor;
    }
  }
  return undefined;
}

// Third donor, same discipline, for the other figure site. MAX-93 left S5.1's figure-number
// prohibition binding on exercises while exempting them from the caption requirement, so a rule
// that has to hold there needs a donor there too -- and the corpus's exercise figures carry no
// caption at all, which means nothing else in the corpus would ever exercise this path.
function findExerciseFigure(exercises) {
  const ordered = [...exercises].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return ordered.find(isRenderableFigure);
}

// One defect per rule family, each with the severity that family must raise and a rule
// token to look for. Rule ids are matched by substring so a renumber after a spec
// revision does not silently disarm the test.
export const MUTATIONS = [
  {
    id: "display-delimiters-in-bare-fragment",
    rule: "S3.1-no-dollar-dollar",
    severity: "error",
    apply(c) {
      c.exercises[2].answerLatex = "$$288$$";
    },
  },
  {
    id: "unrenderable-formula",
    rule: "S3.3-katex-render",
    severity: "error",
    apply(c) {
      c.exercises[1].answerLatex = "\\frac{1}{";
    },
  },
  {
    // MAX-89. The defect is a LaTeX macro whose name a JSON control escape ate, and the only
    // way to write one is to put the control character in the JS string: JSON.stringify then
    // emits it as a single-backslash `\n` in the file, which is exactly the shape that shipped
    // 11 times (MAX-87). A doubled backslash would not test anything -- it would arrive as a
    // real backslash and the macro would survive.
    //
    // The span is appended rather than substituted so the mutation leaves the donor exercise's
    // prompt otherwise intact: it keeps the plain-reading length above S3.3's floor and adds
    // exactly one new math span, so the only finding this can raise is this rule's. Appending
    // also puts the new span last, which keeps its `#math<n>` index independent of whatever
    // the donor's own prompt happens to contain.
    id: "macro-name-eaten-by-a-json-control-escape",
    rule: "json-escaped-macro",
    severity: "error",
    apply(c) {
      c.exercises[1].promptLatex += " $\\zeta \neq 1$";
    },
  },
  {
    id: "answer-not-in-choices",
    rule: "S3.3-answer-matches-choice",
    severity: "error",
    apply(c) {
      c.exercises[0].answerLatex = "\\frac{999}{9}";
    },
  },
  {
    id: "display-size-in-canonical-answer",
    rule: "S6-canonical",
    severity: "error",
    apply(c) {
      c.exercises[2].answerLatex = "\\dfrac{288}{1}";
    },
  },
  {
    id: "degree-marker-on-a-radian-answer",
    rule: "S6-angle-unit",
    severity: "error",
    apply(c) {
      const f = c.fixtures.find((x) => x.angleUnit) || c.fixtures[0];
      f.angleUnit = "rad";
      f.answerLatex = "90^\\circ";
    },
  },
  {
    id: "hint-rung-carries-the-method",
    rule: "S3.4-rung1-no-method",
    severity: "advisory",
    apply(c) {
      c.exercises[0].hintLatex[0] = "Multiply both sides by $12$, the least common multiple, to clear the denominators.";
    },
  },
  {
    id: "hint-count-above-ceiling",
    rule: "S8-hint-count",
    severity: "error",
    apply(c) {
      c.exercises[0].hintLatex = [...c.exercises[0].hintLatex, "A fourth rung the ladder has no room for."];
    },
  },
  {
    id: "choices-not-five",
    rule: "S3.3-choices-arity",
    severity: "error",
    apply(c) {
      c.exercises[0].choices = c.exercises[0].choices.slice(0, 2);
    },
  },
  {
    id: "macro-outside-allowlist",
    rule: "S3.2",
    severity: "error",
    apply(c) {
      c.exercises[2].solutionLatex = "\\newcommand{\\zz}{1}\n\n" + (c.exercises[2].solutionLatex || "");
    },
  },
  {
    id: "figure-alt-missing",
    rule: "S9-alt-mandatory",
    severity: "error",
    apply(c) {
      findLessonFigure(c.lessons).asymptoteAlt = "";
    },
  },
  {
    // S5.4-ratio-matches-size used to be asserted here by two mutations, one of them pitched at
    // the 2% authoring tolerance it supposedly replaced. That rule is gone: it required the
    // declared ratio to equal size(W,H)/size(W,H), which is false of Asymptote's two-argument
    // size() -- a ceiling under keepAspect, not the output box -- so it made every figure declare
    // a shape it did not render at. Its replacement, S5.5 (declared vs the compiled box), needs
    // a compiler and is proved able to fail by classifyDrift in api/test/figures.test.js, where a
    // mutation framework cannot reach it.
    id: "figure-size-single-argument",
    rule: "S5.4-ratio-unverifiable",
    severity: "advisory",
    apply(c) {
      const fig = findLessonFigure(c.lessons);
      fig.asymptoteSource = fig.asymptoteSource.replace(/size\s*\(\s*[\d.]+\s*,\s*[\d.]+\s*\)/, "size(300)");
    },
  },
  {
    // The comment lines go before the size call is removed, and the decoy goes back in
    // afterwards. That is the point of the ordering. A figure header that names the size
    // call it is describing gives S5.2-size-required a match in a figure that never calls
    // it, and the rule then reports itself unable to fail — which is what happened the
    // moment a header said size(W,H). The mutation has to defeat that: strip the real
    // call from the code, leave a comment that still spells one out, and the rule must
    // still fire. A rule that only passes this test because the fixture happens to be
    // comment-free proves nothing.
    id: "figure-without-size-call",
    rule: "S5.2-size-required",
    severity: "error",
    apply(c) {
      const fig = findLessonFigure(c.lessons);
      const code = fig.asymptoteSource
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n")
        .replace(/\bsize\s*\([^)]*\)/, "");
      fig.asymptoteSource = "// size(W,H) bounds the output.\n" + code;
    },
  },
  {
    // The caption check used to be `typeof f.captionLatex === "string" && !/^\s*Fig\.?\s*\d/`, so
    // `""` satisfied it: a concept figure with an empty caption was a caption-less figure wearing
    // a caption's type. It now requires a non-empty trimmed string. (MAX-76)
    id: "figure-caption-empty-string",
    rule: "S5.1-caption-sentence",
    severity: "error",
    apply(c) {
      findLessonFigure(c.lessons).captionLatex = "";
    },
  },
  {
    // Retargeted by MAX-93. This used to fire S5.1-caption-sentence, which then read
    // `nonEmpty && !isFigureNumber` as one rule. Splitting S5.1 by scope split that predicate in
    // two, and a `Fig. 3` caption is a non-empty string, so it now passes the binding check and is
    // caught by the prohibition alone -- which is the point: "there is a caption" and "the caption
    // is not a figure number" are separate claims and only one of them is scope-dependent.
    id: "figure-caption-is-a-figure-number",
    rule: "S5.1-no-figure-number",
    severity: "error",
    apply(c) {
      findLessonFigure(c.lessons).captionLatex = "Fig. 3 the altitude to the hypotenuse";
    },
  },
  {
    // Proves the half of S5.1 that binds EVERY figure, on the figures it binds everywhere.
    // MAX-93 narrowed the caption *requirement* to concept section figures and kept the
    // figure-number *prohibition* everywhere, so a `Fig. 1` on a worked-example figure is still an
    // error. Without this mutation the narrowing would look identical to deleting the rule outside
    // concept.figures -- which is exactly the scope MAX-76's fix was about losing once already.
    id: "example-figure-caption-is-a-figure-number",
    rule: "S5.1-no-figure-number",
    severity: "error",
    apply(c) {
      findLessonExampleFigure(c.lessons).captionLatex = "Fig. 1 the unit circle";
    },
  },
  {
    // The same prohibition on the other figure site: an exercise. The corpus's exercise figures
    // carry no caption today, so this is the only thing that proves the prohibition reaches them.
    id: "exercise-figure-caption-is-a-figure-number",
    rule: "S5.1-no-figure-number",
    severity: "error",
    apply(c) {
      findExerciseFigure(c.exercises).captionLatex = "Fig. 2 the region shaded";
    },
  },
  {
    // Proves S5.2 reaches worked-example figures. Every rule in checkAsymptote used to stop at
    // the edge of `concept.figures`, so an example figure could ship without size(), with file IO,
    // or with an unknown import and the gate would still have called the corpus clean (MAX-76).
    id: "example-figure-without-size-call",
    rule: "S5.2-size-required",
    severity: "error",
    apply(c) {
      const donor = findLessonExampleFigure(c.lessons);
      const code = donor.asymptoteSource
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n")
        .replace(/\bsize\s*\([^)]*\)/, "");
      donor.asymptoteSource = "// size(W,H) bounds the output.\n" + code;
    },
  },
  {
    // Proves S9 #8 reaches worked-example figures too, not just their concept siblings.
    id: "example-figure-alt-missing",
    rule: "S9-alt-mandatory",
    severity: "error",
    apply(c) {
      findLessonExampleFigure(c.lessons).asymptoteAlt = "";
    },
  },
  {
    // A reservation is not charged to a budget, and S5.1-figure-reserved is what says so out loud.
    // This corpus carries eight (m5-l1 and m5-l2, four each), and MAX-76's whole failure was a
    // silent disagreement about whether they were figures at all.
    id: "figure-reserved-without-source",
    rule: "S5.1-figure-reserved",
    severity: "advisory",
    apply(c) {
      const donor = findLessonFigure(c.lessons);
      donor.asymptoteSource = null;
      donor.asymptoteAlt = null;
      donor.asymptoteAspectRatio = null;
    },
  },
  {
    // The companion to the relaxation in checkAsymptote: an *absent* alt/ratio on a record with no
    // source is not a violation, but a *stray* one is. Without this mutation the relaxation below
    // could be pushed all the way to "no source, no rule" and the self-test would stay green.
    id: "figure-reservation-with-a-stray-alt",
    rule: "S9-alt-mandatory",
    severity: "error",
    apply(c) {
      const donor = findLessonFigure(c.lessons);
      donor.asymptoteSource = null;
      donor.asymptoteAspectRatio = null;
      donor.asymptoteAlt = "An alt text left behind on a figure that has no source.";
    },
  },
];


// Harness invariant, not a content rule: the authoring gate's corpus figure total and the build's
// own corpus scan must be the same number, and they must both move when the corpus moves.
//
// This exists because they were not, for a long time, and nothing said so. `run()` seeded the
// total with each lesson's *declared* concept figure records and then added one more per record
// whose source parsed, charging 63 figures twice, and counted eight `asymptoteSource: null`
// reservations the build never sees; meanwhile it never looked at the two figures this corpus
// hangs off an `objective` section. The gate reported 150/185 for a corpus the build scanned as 83
// figures, which is 81% of a budget spent to produce 45% of it (MAX-76). A ceiling that the thing
// it meters cannot reproduce is not a ceiling.
//
// Both sides now read one definition, in lib/figure-contract.mjs. This assertion is the second
// half of that: shared code makes them agree by construction, and this makes it impossible for
// either side to be edited back into disagreeing without the self-test going red. The second
// half matters because the pristine comparison alone is satisfiable by two constants that happen
// to be equal -- so the count is also taken after one figure's source is removed, and both must
// fall by exactly one.
function figureCountsAgree(contentRoot) {
  const gate = run(contentRoot).report.corpus.figures;
  const build = collectFigures(contentRoot).figures.length;
  return { caught: gate === build, gate, build, detail: `gate ${gate} vs build ${build}` };
}

function figureCountsTrackTheCorpus(contentRoot) {
  const dir = mkdtempSync(join(tmpdir(), "content-figcount-"));
  try {
    cpSync(contentRoot, dir, { recursive: true });
    const before = figureCountsAgree(dir);

    // Written back over the original file, not out under a new name. The mutation framework
    // deliberately leaves the pre-mutation records in place so a fresh finding can be told from
    // a recurring one; that doubling would drop the corpus count by a hundred and prove nothing
    // about whether the count moves. Here the corpus itself has to shrink by exactly one figure.
    const lessonsDir = join(dir, "lessons");
    const files = readdirSync(lessonsDir).filter((f) => f.endsWith(".json")).sort();
    const ordered = files
      .map((f) => ({ file: f, record: JSON.parse(readFileSync(join(lessonsDir, f), "utf8")) }))
      .sort((a, b) => String(a.record.id).localeCompare(String(b.record.id)));
    const victim = ordered.find(({ record }) => {
      const figures = record.sections && record.sections.concept && record.sections.concept.figures;
      return Array.isArray(figures) && figures.some(isRenderableFigure);
    });
    if (!victim) return { caught: false, detail: "no lesson figure with a source to remove" };
    findLessonFigure([victim.record]).asymptoteSource = null;
    writeFileSync(join(lessonsDir, victim.file), JSON.stringify(victim.record, null, 2) + "\n");

    const after = figureCountsAgree(dir);
    const dropped = before.gate - after.gate;
    const caught = after.caught && dropped === 1;
    const why = !after.caught
      ? `${after.detail} -- the two counters no longer agree`
      : dropped !== 1
        ? `emptying ${victim.record.id}'s only figure moved the total by ${dropped}, not 1`
        : `both totals fell by exactly 1 with ${victim.record.id}'s only figure emptied (${before.gate} -> ${after.gate})`;
    return { caught, detail: why };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The third reading of the same definition, and the one most easily over-applied: S5.1-figure-reserved
// must name exactly the declared figure records that carry no source -- and no more. The failure
// mode is not silence but noise. The first cut of this fix walked every entry of every `examples`
// array, which reported all 146 worked examples in the corpus as reserved figure slots, because
// they are entries in an array that can hold figures. A worked example that ships no figure has no
// asymptoteSource key at all; a reservation has the key with a null value. If the reported count
// and the declared count ever diverge, the walk and the report have stopped describing the same
// set of records, which is the shape MAX-76 took.
function reservationsAreReportedExactly(contentRoot) {
  const lessonsDir = join(contentRoot, "lessons");
  const lessons = readdirSync(lessonsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(lessonsDir, f), "utf8")));
  const declared = lessons.reduce(
    (n, lesson) => n + lessonFigureRecords(lesson).filter((s) => !isRenderableFigure(s.record)).length,
    0,
  );
  const reported = run(contentRoot).report.findings.filter((f) => f.rule === "S5.1-figure-reserved").length;
  return {
    caught: declared === reported,
    detail: `S5.1-figure-reserved names ${reported} record(s); the corpus declares ${declared} figure record(s) with no asymptoteSource`,
  };
}

// The S5.1 caption scope is a settled decision, and a settled decision that nothing asserts is a
// pending one waiting to be re-litigated by the next person to read "every figure". MAX-93 ruled
// that the caption *requirement* binds concept section figures only, and that the figure-number
// *prohibition* binds every figure. Both halves are pinned here, on a corpus with every caption
// stripped from every figure:
//
//   * concept figures with no caption raise S5.1-caption-sentence  -- the binding half still binds
//   * figures outside concept.figures with no caption raise nothing  -- the exemption is deliberate
//   * the advisory that named the open question is gone as a rule id, not merely quiet
//
// Without this, deleting the check outside concept.figures -- which is what a future reader of "a
// caption is not required for exercise figures" would reasonably write -- would pass every other
// test in this file, because the mutations above only prove rules can fire, not which figures they
// were reaching. That is the exact failure MAX-76 was: a narrower gate reporting a clean run.
function captionScopeIsDeliberate(contentRoot) {
  const dir = mkdtempSync(join(tmpdir(), "content-caption-scope-"));
  try {
    cpSync(contentRoot, dir, { recursive: true });
    const corpus = loadCorpus(dir);
    let stripped = 0;
    for (const lesson of corpus.lessons) {
      for (const site of lessonFigureRecords(lesson)) {
        if (site.record.asymptoteSource) {
          site.record.captionLatex = "";
          stripped += 1;
        }
      }
    }
    for (const ex of [...corpus.exercises, ...corpus.fixtures]) {
      if (ex.asymptoteSource) {
        ex.captionLatex = "";
        stripped += 1;
      }
    }
    for (const [kind, items] of Object.entries(corpus)) {
      writeFileSync(join(dir, kind, "captionless.json"), JSON.stringify(items, null, 2) + "\n");
    }

    const findings = run(dir).report.findings;
    const captionErrors = findings.filter((f) => f.rule === "S5.1-caption-sentence");
    const conceptCaptionless = captionErrors.filter((f) => /sections\.concept\.figures\[/.test(f.path)).length;
    const elsewhereCaptionless = captionErrors.filter((f) => !/sections\.concept\.figures\[/.test(f.path)).length;
    const pending = findings.filter((f) => f.rule === "S5.1-caption-sentence-elsewhere");

    const problems = [];
    if (!conceptCaptionless) problems.push("a concept figure with no caption raised no S5.1-caption-sentence error");
    if (elsewhereCaptionless) problems.push(`${elsewhereCaptionless} figure(s) outside concept.figures were charged for a caption`);
    if (pending.length) problems.push(`${pending.length} pending-question advisory finding(s) survived`);
    return {
      caught: problems.length === 0,
      detail: problems.length
        ? problems.join("; ")
        : `${stripped} figure(s) had every caption stripped: ${conceptCaptionless} concept figure(s) raised ` +
          `S5.1-caption-sentence, the ${stripped - conceptCaptionless} outside concept.figures raised nothing, and ` +
          "no pending-question advisory survived",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function selftest(contentRoot) {
  const pristine = mkdtempSync(join(tmpdir(), "content-selftest-"));
  const rows = [];
  let baselineClean = false;
  let baselineErrors = 0;
  let baselineFindings = new Set();

  // preflight-content.mjs hands back a copy of its findings array, so every report is a
  // snapshot and two runs never share state. The copy is what makes this invariant checkable;
  // when run() returned its live module-level array instead, a report captured from one corpus
  // was silently refilled by a run over another. Assert it, so the workaround below can be
  // deleted the day someone "optimises" the copy away, and be caught if they do.
  const key = (f) => `${f.rule}|${f.path}`;

  try {
    cpSync(contentRoot, pristine, { recursive: true });
    const { report, errors } = checkCorpus(pristine);
    baselineErrors = errors.length;
    baselineFindings = new Set([...report.findings].map(key));
    baselineClean = baselineErrors === 0;

    // Harness invariants: properties of the gate itself, which no corpus mutation can establish.
    {
      let caught = false;
      let detail = "";
      try {
        const agree = figureCountsAgree(pristine);
        caught = agree.caught;
        detail = agree.detail;
      } catch (err) {
        detail = `threw: ${err.message}`;
      }
      rows.push({
        id: "corpus-figure-count-matches-the-build-scan",
        rule: "harness-invariant",
        severity: "error",
        caught,
        detail: caught
          ? `${detail} (run() and collectFigures() read one definition in lib/figure-contract.mjs)`
          : `${detail} -- the S5.1 corpus ceiling is metered against a count the build cannot reproduce`,
      });
    }

    {
      let caught = false;
      let detail = "";
      try {
        const exact = reservationsAreReportedExactly(pristine);
        caught = exact.caught;
        detail = exact.detail;
      } catch (err) {
        detail = `threw: ${err.message}`;
      }
      rows.push({
        id: "figure-reservations-are-reported-exactly",
        rule: "harness-invariant",
        severity: "error",
        caught,
        detail,
      });
    }

    {
      let caught = false;
      let detail = "";
      try {
        const tracks = figureCountsTrackTheCorpus(pristine);
        caught = tracks.caught;
        detail = tracks.detail;
      } catch (err) {
        detail = `threw: ${err.message}`;
      }
      rows.push({
        id: "corpus-figure-count-tracks-the-corpus",
        rule: "harness-invariant",
        severity: "error",
        caught,
        detail,
      });
    }

    // Harness invariant, not a content rule: a report must not change under a later run().
    {
      const dir = mkdtempSync(join(tmpdir(), "content-alias-"));
      let caught = false;
      let detail = "";
      try {
        cpSync(pristine, dir, { recursive: true });
        const before = [...report.findings].map(key).sort().join("\n");
        const beforeCount = report.findings.length;
        const mutated = loadCorpus(dir);
        const victim = mutated.lessons.find((l) => l.sections && l.sections.concept &&
          l.sections.concept.conceptLatex !== undefined);
        victim.sections.concept.conceptLatex = "$\\frac{1";
        for (const [kind, items] of Object.entries(mutated)) {
          writeFileSync(join(dir, kind, "aliased.json"), JSON.stringify(items, null, 2) + "\n");
        }
        const second = checkCorpus(dir);
        const after = [...report.findings].map(key).sort().join("\n");
        const stable = before === after && report.findings.length === beforeCount;
        // The second run must actually have found something, or the test is vacuous.
        const secondFound = second.errors.length > 0;
        caught = stable && secondFound;
        detail = caught
          ? `report stayed at ${beforeCount} findings across a second run() that found ${second.errors.length} error(s)`
          : !secondFound
            ? "second run found no errors, so the aliasing check proved nothing"
            : `report mutated under a second run(): ${beforeCount} -> ${report.findings.length} findings`;
      } catch (err) {
        detail = `threw: ${err.message}`;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      rows.push({
        id: "report-is-not-aliased-across-runs",
        rule: "harness-invariant",
        severity: "error",
        caught,
        detail,
      });
    }

    {
      let caught = false;
      let detail = "";
      try {
        const scope = captionScopeIsDeliberate(pristine);
        caught = scope.caught;
        detail = scope.detail;
      } catch (err) {
        detail = `threw: ${err.message}`;
      }
      rows.push({
        id: "caption-scope-is-deliberate",
        rule: "harness-invariant",
        severity: "error",
        caught,
        detail,
      });
    }

    for (const mutation of MUTATIONS) {
      const dir = mkdtempSync(join(tmpdir(), "content-mutation-"));
      let caught = false;
      let detail = "";
      try {
        cpSync(pristine, dir, { recursive: true });
        const corpus = loadCorpus(dir);
        mutation.apply(corpus);
        for (const [kind, items] of Object.entries(corpus)) {
          writeFileSync(join(dir, kind, "mutated.json"), JSON.stringify(items, null, 2) + "\n");
        }
        const mutated = checkCorpus(dir);
        // The mutated corpus holds the original records alongside the mutated ones, so
        // a pre-existing finding recurs; only findings absent from the baseline count.
        const fresh = [...mutated.report.findings].filter((f) => !baselineFindings.has(key(f)));
        const hit = fresh.find((f) => f.rule.includes(mutation.rule) && f.severity === mutation.severity);
        caught = Boolean(hit);
        const raised = fresh.find((f) => f.rule.includes(mutation.rule));
        detail = hit
          ? `${hit.rule} — ${hit.message}`
          : raised
            ? `raised ${raised.severity}, expected ${mutation.severity}: ${raised.message}`
            : `no new finding matched "${mutation.rule}"`;
      } catch (err) {
        detail = `threw: ${err.message}`;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      rows.push({ ...mutation, caught, detail });
    }
  } finally {
    rmSync(pristine, { recursive: true, force: true });
  }

  const missed = rows.filter((r) => !r.caught);
  return { rows, missed, baselineClean, baselineErrors };
}

function reportSelftest(result) {
  console.log("");
  if (!result.baselineClean) {
    console.log(`  BASELINE IS DIRTY: ${result.baselineErrors} errors on the unmutated corpus, so no mutation is conclusive.`);
  }
  console.log(`  self-test: ${result.rows.length - result.missed.length}/${result.rows.length} rule families proved able to fail`);
  for (const r of result.rows) {
    console.log(`  ${r.caught ? "caught" : "MISSED"}  ${r.id}  (${r.rule})`);
    if (!r.caught) console.log(`          ${r.detail}`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const wantSelftest = args.includes("--selftest");
  const jsonIdx = args.indexOf("--json");
  const jsonValue = jsonIdx >= 0 ? args[jsonIdx + 1] : undefined;
  // `--json <outPath>` takes the next argv token as a path, so `--json --selftest` used to resolve
  // `--selftest` against the cwd and write the report to a file of that name. It reached main as a
  // 4KB tracked blob (MAX-97): a flag is not a path, and a mistyped flag must not leave a build
  // product behind silently. Refuse it, and refuse it as a configuration error (exit 2) rather
  // than by quietly falling back to DEFAULT_REPORT, which would hide the typo behind a pass.
  if (jsonValue !== undefined && jsonValue.startsWith("-")) {
    console.error(`check-content-math: ARGUMENT: --json takes an output path; got the flag "${jsonValue}".`);
    console.error(`                       Write the report to a path, or drop --json to use ${DEFAULT_REPORT}.`);
    process.exit(2);
  }
  const positional = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : null;
  const contentRoot = positional || (process.env.CONTENT_ROOT ? resolve(process.env.CONTENT_ROOT) : DEFAULT_CONTENT);
  const outPath = jsonValue !== undefined ? resolve(jsonValue) : DEFAULT_REPORT;

  const env = checkEnvironment();
  if (env.problems.length) {
    for (const p of env.problems) console.error(`check-content-math: ENVIRONMENT: ${p}`);
    process.exit(2);
  }

  const shape = checkCorpusShape(contentRoot);
  if (shape.problems.length) {
    for (const p of shape.problems) console.error(`check-content-math: CORPUS: ${p}`);
    process.exit(2);
  }

  let { report, errors } = checkCorpus(contentRoot);
  mkdirSync(dirname(outPath), { recursive: true });
  report.gate = {
    script: "scripts/check-content-math.mjs",
    contentRoot: contentRoot.replace(REPO + "/", ""),
    katexPinned: KATEX_PINNED,
    // Name the rule the figure ratio is actually policed by, so a reader who came here looking
    // for it is sent to the check that exists instead of concluding the gate is missing.
    figureRatioRule: "S5.5 (declared vs compiled box), scripts/build-figures.mjs",
  };
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");

  console.log(summarize(report).join("\n"));
  for (const line of printFindings(report) || []) console.log(line);
  console.log(`  report: ${outPath}`);

  let failed = errors.length > 0;
  if (errors.length) {
    console.log("");
    console.log(`  ${errors.length} error(s); content does not pass the gate.`);
  }

  if (wantSelftest) {
    const result = selftest(contentRoot);
    console.log("");
    reportSelftest(result);
    if (!result.baselineClean || result.missed.length) failed = true;
    writeFileSync(
      outPath.replace(/\.json$/, "-selftest.json"),
      JSON.stringify({ rows: result.rows, missed: result.missed.map((r) => r.id) }, null, 2) + "\n",
    );
  }

  process.exit(failed ? 1 : 0);
}
