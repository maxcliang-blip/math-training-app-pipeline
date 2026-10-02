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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DEFAULT_CONTENT = join(REPO, "content");
const DEFAULT_REPORT = join(REPO, "artifacts", "content-math-report.json");

// S5.4 states a 2% ratio tolerance at authoring time. The pipeline compares the *derived*
// figure box, where the true dimensions are known, so it holds content to the declared
// value at the precision content actually declares (3 decimal places).
const RATIO_DECIMALS = 3;

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
// on a corpus whose first lesson carries no concept figure the four figure mutations would
// throw on undefined and report MISSED for a corpus that is actually fine. Scan in lesson-id
// order and take the first figure found, which is stable across filesystems and corpus growth.
function findLessonFigure(lessons) {
  const ordered = [...lessons].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const lesson of ordered) {
    const concept = lesson.sections && lesson.sections.concept;
    const figures = concept && concept.figures;
    if (figures && figures.length) return figures[0];
  }
  return undefined;
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
    id: "figure-ratio-disagrees-with-size",
    rule: "S5.4-ratio-matches-size",
    severity: "error",
    apply(c) {
      findLessonFigure(c.lessons).asymptoteAspectRatio = 9.9;
    },
  },
  {
    // The mutation that actually pins S5.4a to exactness. 9.9 is caught by any threshold
    // whatsoever, so it cannot tell a 2% rule apart from an exact one. This one lands inside
    // the band the old 2% authoring tolerance accepted (1.31 is 1.75% off size(320,240)=1.3333)
    // and outside the exact value, so it passes under a tolerance and fails under S5.4a. That
    // is the whole defect: content could clear authoring review and then fail the figure build,
    // which compares at the declared precision. If this mutation ever goes MISSED, the rule has
    // silently degraded back into a tolerance and review-passing content can break CI again.
    id: "figure-ratio-inside-old-tolerance-band",
    rule: "S5.4-ratio-matches-size",
    severity: "error",
    apply(c) {
      const fig = findLessonFigure(c.lessons);
      const m = fig.asymptoteSource.match(/size\s*\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)/);
      const exact = Number(m[1]) / Number(m[2]);
      const true_ = exact / 1.0175; // ~1.75% off, inside the retired 2% band, not the exact value
      fig.asymptoteAspectRatio = Number(true_.toFixed(3));
    },
  },
  {
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
];


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
  const positional = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : null;
  const contentRoot = positional || (process.env.CONTENT_ROOT ? resolve(process.env.CONTENT_ROOT) : DEFAULT_CONTENT);
  const outPath = jsonIdx >= 0 && args[jsonIdx + 1] ? resolve(args[jsonIdx + 1]) : DEFAULT_REPORT;

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
    ratioDecimals: RATIO_DECIMALS,
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
