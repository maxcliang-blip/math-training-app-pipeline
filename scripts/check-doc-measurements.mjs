// The gate: the measurements docs/CONTENT_CONVENTIONS.md states are still measurements of this
// corpus.
//
// MAX-149. The doc's own rule is that "a stale measurement is worse than a missing one, because the
// next author cannot tell which is which" -- which is an argument for checking the numbers, and the
// reason this file exists. Until now they were prose: true when written, unverifiable afterwards,
// and going false in silence every time an exercise was authored. The claims now live in a marked
// block this reads back, and the corpus is read through the same loader and the same client-sections
// report the repository already trusts, so a green run means the two agree rather than that a
// literal was copied faithfully.
//
//   node scripts/check-doc-measurements.mjs [contentRoot] [docPath] [--json <outPath>] [--update]
//                                          [--init] [--selftest]
//
// Exit codes: 0 pass · 1 a stale or unreadable claim · 2 environment/configuration error.
//
// --selftest is the part CI runs. It requires every claim to be falsifiable in turn, the block to
// be refused when it is absent or malformed, --update to repair a wrong block rather than agree
// with it, and the corpus relations the doc asserts to be caught by mutating a corpus copy -- so a
// pass means the check measures the doc instead of restating it.
//
// --update re-measures and rewrites the numbers in place. --init adds the block to a doc that has
// none. Neither is needed on a tree where the doc is correct, which is the point: on origin/main
// both are no-ops, so a green first run is evidence the claims were already true.
//
// NOT the landing gate. scripts/check-landed-content.mjs's GATED_PREFIXES stays ["content/", "lib/",
// "scripts/"], and this is deliberately not wired into it. MAX-145 settled that question by
// measurement -- widening it produces no new failing branches and reclassifies merged branches from
// doc-branch to the silent pr-merged -- and widening it again here would re-decide it silently.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadContentStore } from "../api/src/content.js";
import { checkClientSections } from "./check-client-sections.mjs";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  CLAIMS,
  checkDocMeasurements,
  claimsFromMeasurement,
  emptyClaims,
  formatTables,
  measureCorpus,
  readClaim,
  readMeasuredBlock,
  renderBlock,
} from "../lib/doc-measurements.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DEFAULT_CONTENT = join(REPO, "content");
const DEFAULT_DOC = join(REPO, "docs", "CONTENT_CONVENTIONS.md");
const DEFAULT_REPORT = join(REPO, "artifacts", "doc-measurements-report.json");

// Measure. The client-sections report comes from the gate that already owns those numbers
// (MAX-146); it is asked for rather than recomputed so this file cannot hold a second, divergent
// count of the same set.
export function checkDoc({ contentRoot = DEFAULT_CONTENT, docPath = DEFAULT_DOC } = {}) {
  const store = loadContentStore(contentRoot);
  const client = checkClientSections({ contentRoot });
  if (!client.report || !client.report.practice || !client.report.mastery || !client.report.solutions) {
    throw new Error(
      `scripts/check-client-sections.mjs reported no per-section ids, so the section claims cannot be checked.\n` +
        `  Run \`npm run client:check\` first; its own problems are what make this report empty.`,
    );
  }
  const measured = measureCorpus({ store, clientReport: client.report });
  const markdown = readFileSync(docPath, "utf8");
  const block = readMeasuredBlock(markdown, { docPath: docLabel(docPath) });
  if (!block.ok) return { problems: [block.reason], measured, claims: null, markdown };
  const problems = checkDocMeasurements({ claims: block.claims, measured, docPath: docLabel(docPath) });
  return { problems, measured, claims: block.claims, markdown };
}

function docLabel(docPath) {
  return docPath.startsWith(REPO) ? docPath.slice(REPO.length + 1) : docPath;
}

// ---------------------------------------------------------------------------
// Writing the block back
// ---------------------------------------------------------------------------

// Replace the fenced JSON inside the markers, leaving the rest of the doc byte for byte. Only the
// numbers move: a rewrite that reflowed the surrounding prose would turn a re-measure into a diff
// nobody can read, and the prose is where the reasoning lives.
export function rewriteBlock(markdown, claims) {
  const begin = markdown.indexOf(BLOCK_BEGIN);
  const end = markdown.indexOf(BLOCK_END);
  if (begin === -1 || end === -1 || end < begin) return null;
  const inner = markdown.slice(begin, end);
  const fence = /(```json\r?\n)[\s\S]*?(\r?\n```)/;
  if (!fence.test(inner)) return null;
  const replaced = inner.replace(fence, (_, open, close) => `${open}${JSON.stringify(claims, null, 2)}${close}`);
  if (replaced === inner) return { text: markdown, changed: false };
  return { text: markdown.slice(0, begin) + replaced + markdown.slice(end), changed: true };
}

// --init, for a doc that has no block at all: put it immediately above the first `## ` heading, so
// the numbers sit in the preamble where a reader meets them and before any convention that cites
// them. Refuses if a block exists, because "add the block" and "rewrite the numbers" are different
// mistakes and guessing wrong on the second one discards a measurement.
export function initBlock(markdown, claims, { docPath = docLabel(DEFAULT_DOC) } = {}) {
  if (markdown.includes(BLOCK_BEGIN)) {
    return { ok: false, reason: `${docPath} already has a measured block; use --update to refresh it` };
  }
  const heading = markdown.search(/^## /m);
  if (heading === -1) {
    return { ok: false, reason: `${docPath} has no "## " heading to place the measured block above` };
  }
  const before = markdown.slice(0, heading);
  const after = markdown.slice(heading);
  const block = "## Measured on the corpus\n\n" + renderBlock(claims).replace(/^/, "") + "\n" + after;
  return { ok: true, text: before + block };
}

// ---------------------------------------------------------------------------
// Self-test: prove the gate can fail
// ---------------------------------------------------------------------------

// A scratch doc carrying the real block with one claim replaced. Built from the repository's own
// doc rather than a hand-written fixture, so the self-test cannot pass against a fixture that no
// longer resembles what is checked in CI.
function docWithClaims(claims) {
  const markdown = readFileSync(DEFAULT_DOC, "utf8");
  const written = rewriteBlock(markdown, claims);
  if (!written) throw new Error("the self-test could not find the measured block in docs/CONTENT_CONVENTIONS.md");
  return written.text;
}

function withDocCopy(text) {
  const dir = mkdtempSync(join(tmpdir(), "doc-measurements-"));
  const path = join(dir, basename(DEFAULT_DOC));
  writeFileSync(path, text);
  return path;
}

// A scratch corpus, mutated so a relation the doc asserts stops holding. cp -r of content/ is ~2 MB
// and happens once per case; cheaper than reasoning about which lesson file a case rewrote.
function withContentCopy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "doc-measurements-content-"));
  cpSync(DEFAULT_CONTENT, dir, { recursive: true });
  mutate(dir);
  return dir;
}

function rewriteLesson(contentRoot, lessonId, mutate) {
  const lessonsDir = join(contentRoot, "lessons");
  const file = readdirSync(lessonsDir).find((f) => {
    const parsed = JSON.parse(readFileSync(join(lessonsDir, f), "utf8"));
    return (Array.isArray(parsed) ? parsed : [parsed]).some((r) => r && r.id === lessonId);
  });
  if (!file) throw new Error(`the self-test could not find lesson ${lessonId} to mutate`);
  const path = join(lessonsDir, file);
  const records = JSON.parse(readFileSync(path, "utf8"));
  const target = (Array.isArray(records) ? records : [records]).find((r) => r && r.id === lessonId);
  mutate(target);
  writeFileSync(path, JSON.stringify(records, null, 2));
}

const SELFTEST_CASES = [
  // 1. Every claim, falsified one at a time, has to be caught. This is the whole gate: a check that
  //    watches one number and ignores the other nine reports the doc as verified.
  ...CLAIMS.map((claim) => ({
    id: `a-wrong-${claim.key.replace(/\./g, "-")}`,
    expect: new RegExp(`${escapeRegExp(claim.key)} is stale: .* claims \\d+, the corpus holds \\d+`),
    apply() {
      const claims = readMeasuredBlock(readFileSync(DEFAULT_DOC, "utf8")).claims;
      const parts = claim.key.split(".");
      let target = claims;
      for (const part of parts.slice(0, -1)) target = target[part];
      // +1 rather than an arbitrary wrong number, so the reported pair is always "one more than
      // true" and the expectation cannot be satisfied by a check comparing against itself.
      target[parts[parts.length - 1]] = claim.measure(measureNow()) + 1;
      return withDocCopy(docWithClaims(claims));
    },
  })),

  // 2. A block that is absent is not a block whose numbers are correct. Every one of these is a way
  //    the check can end up measuring nothing at all while still exiting 0.
  {
    id: "no-block-at-all",
    expect: /has no <!-- doc-measurements:begin --> marker/,
    apply() {
      return withDocCopy(readFileSync(DEFAULT_DOC, "utf8").split(BLOCK_BEGIN)[0] + "Nothing is checked here.\n");
    },
  },
  {
    id: "block-opened-and-never-closed",
    expect: /never closes it with <!-- doc-measurements:end -->/,
    apply() {
      const markdown = readFileSync(DEFAULT_DOC, "utf8");
      return withDocCopy(markdown.split(BLOCK_END)[0]);
    },
  },
  {
    id: "block-without-a-fence",
    expect: /has no ```json fence/,
    apply() {
      return withDocCopy(
        readFileSync(DEFAULT_DOC, "utf8").replace(/```json\n[\s\S]*?\n```/, "38 lessons, 759 exercises."),
      );
    },
  },
  {
    id: "block-that-is-not-json",
    expect: /measured block is not valid JSON/,
    apply() {
      return withDocCopy(
        readFileSync(DEFAULT_DOC, "utf8").replace(/```json\n[\s\S]*?\n```/, "```json\n{ lessons: 38,\n```"),
      );
    },
  },
  {
    id: "block-that-is-an-array",
    expect: /parses to an array, not an object of claims/,
    apply() {
      return withDocCopy(
        readFileSync(DEFAULT_DOC, "utf8").replace(/```json\n[\s\S]*?\n```/, "```json\n[38, 759]\n```"),
      );
    },
  },

  // 3. A claim in the block that nothing measures is the failure this change exists to end: a
  //    number in a doc that goes stale silently. It has to be refused, not ignored.
  {
    id: "claim-nobody-measures",
    expect: /figureLoadSeconds is in .* measured block but nothing here measures it/,
    apply() {
      const claims = readMeasuredBlock(readFileSync(DEFAULT_DOC, "utf8")).claims;
      claims.figureLoadSeconds = 2.5;
      return withDocCopy(docWithClaims(claims));
    },
  },
  {
    id: "claim-that-is-not-a-count",
    expect: /lessons is not a measurement: .* has "thirty-eight" where an integer count belongs/,
    apply() {
      const claims = readMeasuredBlock(readFileSync(DEFAULT_DOC, "utf8")).claims;
      claims.lessons = "thirty-eight";
      return withDocCopy(docWithClaims(claims));
    },
  },

  // 4. The relations, on a corpus that really broke them. Every count in the block stays true in
  //    both cases, so a check that only compared numbers would pass: this is what stops the doc's
  //    sentences from outliving the facts they describe.
  {
    id: "an-id-in-both-practice-and-mastery",
    expect: /practice and mastery are not disjoint/,
    apply() {
      const contentRoot = withContentCopy((root) => {
        rewriteLesson(root, "m1-l1", (lesson) => {
          const practice = lesson.sections.practice.exerciseIds;
          lesson.sections.mastery.exerciseIds = [practice[0], ...(lesson.sections.mastery.exerciseIds || [])];
        });
      });
      return { docPath: DEFAULT_DOC, contentRoot };
    },
  },
  {
    id: "an-exercise-no-section-lists",
    expect: /do not cover the corpus: they name \d+ distinct ids across \d+ exercise records/,
    apply() {
      const contentRoot = withContentCopy((root) => {
        rewriteLesson(root, "m1-l1", (lesson) => {
          lesson.sections.practice.exerciseIds = lesson.sections.practice.exerciseIds.slice(1);
          lesson.sections.solutions.exerciseIds = lesson.sections.practice.exerciseIds;
        });
      });
      return { docPath: DEFAULT_DOC, contentRoot };
    },
  },
  {
    id: "a-solution-outside-its-practice-list",
    expect: /solutions id\(s\) are outside their lesson's practice list/,
    apply() {
      const contentRoot = withContentCopy((root) => {
        rewriteLesson(root, "m1-l1", (lesson) => {
          lesson.sections.solutions.exerciseIds = [
            ...lesson.sections.solutions.exerciseIds,
            "not-in-practice-m1-l1",
          ];
        });
      });
      return { docPath: DEFAULT_DOC, contentRoot };
    },
  },
  {
    // The three cases above break a relation *and* move a count, so the numeric comparison could
    // have caught them. This one is the case that makes the relation assertions load-bearing: it
    // moves an id between two lessons' solutions lists, so every count in the doc's block stays
    // exactly right (645 solutions ids either way) and only "a lesson's solutions are its own
    // practice ids" is false. A check that only compared numbers would pass this.
    id: "a-solutions-id-moved-to-a-lesson-that-does-not-teach-it",
    expect: /solutions id\(s\) are outside their lesson's practice list \(m1-l2: m1-l1-/,
    apply() {
      const contentRoot = withContentCopy((root) => {
        let moved = null;
        rewriteLesson(root, "m1-l1", (lesson) => {
          moved = lesson.sections.solutions.exerciseIds[0];
          lesson.sections.solutions.exerciseIds = lesson.sections.solutions.exerciseIds.slice(1);
        });
        rewriteLesson(root, "m1-l2", (lesson) => {
          lesson.sections.solutions.exerciseIds = [...lesson.sections.solutions.exerciseIds, moved];
        });
      });
      return { docPath: DEFAULT_DOC, contentRoot };
    },
  },
  {
    id: "a-section-that-no-longer-reaches-every-lesson",
    expect: /the practice list spans \d+ of \d+ lessons/,
    apply() {
      const contentRoot = withContentCopy((root) => {
        rewriteLesson(root, "m1-l1", (lesson) => {
          lesson.sections.practice.exerciseIds = [];
        });
      });
      return { docPath: DEFAULT_DOC, contentRoot };
    },
  },
];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let measuredCache = null;
function measureNow() {
  if (!measuredCache) {
    const store = loadContentStore(DEFAULT_CONTENT);
    measuredCache = measureCorpus({ store, clientReport: checkClientSections({}).report });
  }
  return measuredCache;
}

export function selftest() {
  const problems = [];

  // 1. The real doc against the real corpus must pass, or every case below is vacuous -- and this
  //    is also the case CI would otherwise not cover: a doc whose numbers were wrong from the start
  //    would make the self-test green while the gate was reporting the truth.
  const clean = checkDoc();
  if (clean.problems.length > 0) {
    problems.push(
      "the gate fails on the repository as it stands, so the cases below would pass for the wrong reason:\n" +
        clean.problems.map((p) => `  ${p}`).join("\n"),
    );
  }

  // 2. Every mutation must be caught, by name.
  for (const c of SELFTEST_CASES) {
    let observed;
    try {
      const target = c.apply();
      observed = checkDoc(
        target.docPath ? { docPath: target.docPath, contentRoot: target.contentRoot } : { docPath: target },
      ).problems;
    } catch (error) {
      problems.push(`${c.id}: the gate threw instead of reporting: ${error && error.message}`);
      continue;
    }
    if (observed.length === 0) {
      problems.push(`${c.id}: MISSED -- the gate reported no problem`);
    } else if (!observed.some((p) => c.expect.test(p))) {
      problems.push(
        `${c.id}: reported something, but not the expected finding.\n  expected /${c.expect.source}/\n  got:\n` +
          observed.map((p) => `    ${p}`).join("\n"),
      );
    }
  }

  // 3. --update must repair a wrong block, not agree with it. An --update that cannot turn a red
  //    doc green is indistinguishable from an --update that cannot detect a wrong doc at all.
  try {
    const claims = readMeasuredBlock(readFileSync(DEFAULT_DOC, "utf8")).claims;
    claims.lessons = 1;
    const broken = docWithClaims(claims);
    const measured = measureNow();
    const rewritten = rewriteBlock(broken, claimsFromMeasurement(measured));
    if (!rewritten) {
      problems.push("--update: MISSED -- it could not find the block to rewrite");
    } else if (!rewritten.changed) {
      problems.push("--update: MISSED -- it reported no change to a block holding a wrong count");
    } else {
      const after = checkDoc({ docPath: withDocCopy(rewritten.text) }).problems;
      if (after.length > 0) {
        problems.push(
          "--update: wrote the measured numbers back and the gate still reports:\n" +
            after.map((p) => `    ${p}`).join("\n"),
        );
      }
    }
  } catch (error) {
    problems.push(`--update: threw instead of rewriting: ${error && error.message}`);
  }

  // 4. --update must not touch prose. A rewrite that reflowed the conventions would make every
  //    re-measure an unreadable diff, and the prose is where the reasoning lives.
  try {
    const markdown = readFileSync(DEFAULT_DOC, "utf8");
    const rewritten = rewriteBlock(markdown, claimsFromMeasurement(measureNow()));
    if (rewritten && rewritten.changed) {
      problems.push("--update: MISSED -- rewriting the block with the measured numbers changed a block that was already correct");
    }
    const stripped = (text) => text.slice(markdown.indexOf(BLOCK_BEGIN) + BLOCK_BEGIN.length, markdown.indexOf(BLOCK_END));
    if (rewritten && stripped(rewritten.text) !== stripped(markdown)) {
      problems.push("--update: MISSED -- it altered the prose inside the measured block's markers");
    }
  } catch (error) {
    problems.push(`--update (no-op): threw instead of leaving the doc alone: ${error && error.message}`);
  }

  // 5. And --init must refuse a doc that already has a block, since that is the mistake where
  //    "add the block" silently discards a measurement.
  try {
    const again = initBlock(readFileSync(DEFAULT_DOC, "utf8"), emptyClaims());
    if (again.ok) {
      problems.push("--init: MISSED -- it would add a second block to a doc that already has one");
    }
  } catch (error) {
    problems.push(`--init: threw instead of refusing: ${error && error.message}`);
  }

  return problems;
}

// ---------------------------------------------------------------------------

function main(argv) {
  const args = argv.slice(2);
  const jsonIndex = args.indexOf("--json");
  const jsonOut = jsonIndex === -1 ? null : args[jsonIndex + 1];
  const selftestOnly = args.includes("--selftest");
  const update = args.includes("--update");
  const init = args.includes("--init");
  const positional = args.filter((a, i) => !a.startsWith("--") && i !== jsonIndex + 1);
  const contentRoot = resolve(positional[0] || DEFAULT_CONTENT);
  const docPath = resolve(positional[1] || DEFAULT_DOC);

  if (!selftestOnly && (!existsSync(contentRoot) || !existsSync(docPath))) {
    process.stderr.write(
      `check-doc-measurements: ${!existsSync(contentRoot) ? contentRoot : docPath} is missing\n`,
    );
    return 2;
  }
  if (update && init) {
    process.stderr.write("check-doc-measurements: --update and --init do different things; pass one\n");
    return 2;
  }

  let problems = [];
  let measured = null;
  let status = "pass";
  let note = "";

  try {
    if (selftestOnly) {
      problems = selftest();
    } else if (update || init) {
      const store = loadContentStore(contentRoot);
      const client = checkClientSections({ contentRoot });
      measured = measureCorpus({ store, clientReport: client.report });
      const claims = claimsFromMeasurement(measured);
      const markdown = readFileSync(docPath, "utf8");
      const label = docLabel(docPath);

      if (init) {
        const added = initBlock(markdown, claims, { docPath: label });
        if (!added.ok) {
          process.stderr.write(`check-doc-measurements: ${added.reason}\n`);
          return 1;
        }
        writeFileSync(docPath, added.text);
        note = `added the measured block to ${label}`;
      } else {
        const rewritten = rewriteBlock(markdown, claims);
        if (!rewritten) {
          process.stderr.write(
            `check-doc-measurements: ${label} has no measured block to rewrite.\n` +
              `  Add one with:  npm run docs:check -- --init\n`,
          );
          return 1;
        }
        if (!rewritten.changed) {
          note = `${label} already matches the corpus`;
        } else {
          writeFileSync(docPath, rewritten.text);
          note = `rewrote the measured block in ${label}`;
        }
      }
      process.stdout.write(`check-doc-measurements: ${note}\n${formatTables(measured)}`);
      status = "pass";
    } else {
      const result = checkDoc({ contentRoot, docPath });
      problems = result.problems;
      measured = result.measured;
      status = problems.length === 0 ? "pass" : "fail";
    }
  } catch (error) {
    process.stderr.write(`check-doc-measurements: ${error && error.stack ? error.stack : error}\n`);
    return 2;
  }

  if (jsonOut) {
    mkdirSync(dirname(jsonOut), { recursive: true });
    writeFileSync(
      jsonOut,
      JSON.stringify(
        {
          status,
          doc: docLabel(docPath),
          claims: measured ? claimsFromMeasurement(measured) : null,
          measured: measured ? { ...measured, relations: undefined } : null,
          problems,
        },
        null,
        2,
      ) + "\n",
    );
  }

  if (problems.length > 0) {
    process.stderr.write(`check-doc-measurements: ${problems.length} problem(s)\n\n`);
    for (const p of problems) process.stderr.write(`${p}\n\n`);
    if (selftestOnly) process.stderr.write("selftest FAILED\n");
    return 1;
  }

  if (selftestOnly) {
    process.stdout.write(
      `check-doc-measurements: selftest passed (${SELFTEST_CASES.length + 5} cases)\n`,
    );
  } else if (!update && !init) {
    const m = measured;
    process.stdout.write(`check-doc-measurements: ok -- ${docLabel(docPath)}\n\n`);
    process.stdout.write(`claim  measured\n`);
    for (const claim of CLAIMS) {
      process.stdout.write(`${claim.key.padEnd(44)} ${String(claim.measure(m)).padStart(4)}\n`);
    }
    process.stdout.write(
      `\n${CLAIMS.length} claim(s) re-measured from content/, and the corpus relations hold.\n` +
        `${BLOCK_BEGIN} / ${BLOCK_END}\n`,
    );
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv));
}