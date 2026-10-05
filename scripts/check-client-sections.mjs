// The gate: every lesson exercise list the API serves has a declared client reach, and the client
// agrees with the declaration.
//
// MAX-146 shipped the finding that 114 mastery exercises were served and unreachable, and settled
// the intent: the reader serves practice only until an attempt runner exists. A finding in a comment
// does not survive, so this reads that intent back out of the repository -- from the API's own
// SECTION_ID_FIELDS, from web/src, and from the corpus -- and fails when the three disagree.
//
//   node scripts/check-client-sections.mjs [contentRoot] [--json <outPath>] [--selftest]
//
// Exit codes: 0 pass · 1 a reach disagreement · 2 environment/configuration error.
//
// --selftest is the part CI runs. It mutates each of the three inputs and requires the gate to
// catch every one, so a pass means the gate can fail: an undeclared section, a client that reaches
// a section declared api-only, a served section the client stopped fetching, a solution outside its
// lesson's practice list, and a vacuous scan over zero files.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { SECTION_ID_FIELDS, loadContentStore } from "../api/src/content.js";
import { CLIENT_REACH, checkClientSurface, formatReport } from "../lib/client-sections.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DEFAULT_CONTENT = join(REPO, "content");
const WEB_SRC = join(REPO, "web", "src");
const DEFAULT_REPORT = join(REPO, "artifacts", "client-sections-report.json");

// Every .js/.jsx file under web/src. Recursive because a future route or a component folder is
// exactly where a second exercise fetch would land, and a scan that only reads App.jsx would
// report "the client names practice only" while a second fetch sat two directories away.
// A label for a file the scan found. It has to name the file, because every finding this scan emits
// leads with it -- a finding that says "names the practice list" and not which file is not a finding
// anyone can act on.
//
// The selftest scans scratch copies under os.tmpdir(), which are not under the repository, so this
// cannot be arithmetic on the repo root. The previous `path.slice(REPO.length + 1)` was: on a runner
// where REPO is longer than the temp path the slice produced the empty string, so the message read
// " names the practice exercise list" and the selftest case failed on the name alone. It passed
// locally only because a long TMPDIR left a fragment that still ended in App.jsx -- a label correct
// by luck of directory depth, which is the kind of pass that stops meaning anything the moment the
// runner's paths change. Relative when the file is in the repository, absolute when it is not; both
// keep the basename, and the check below refuses to emit a label that does not.
function labelFor(path) {
  const rel = relative(REPO, path);
  const insideRepo = rel !== "" && !rel.startsWith(`..${sep}`) && rel !== "..";
  const label = (insideRepo ? rel : path).split(sep).join("/");
  if (!label.endsWith(basename(path))) {
    throw new Error(
      `client scan produced a label that does not name its file: ${JSON.stringify(label)} for ${path}`,
    );
  }
  return label;
}

function readClientSources(dir = WEB_SRC) {
  const sources = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.(js|jsx)$/.test(entry.name)) {
        sources.push({ path: labelFor(path), source: readFileSync(path, "utf8") });
      }
    }
  };
  walk(dir);
  return sources.sort((a, b) => a.path.localeCompare(b.path));
}

export function checkClientSections({ contentRoot = DEFAULT_CONTENT, clientDir = WEB_SRC } = {}) {
  const store = loadContentStore(contentRoot);
  const lessons = [...store.lessons.values()];
  const result = checkClientSurface({
    apiSections: SECTION_ID_FIELDS.map((s) => s.section),
    sources: readClientSources(clientDir),
    lessons,
  });
  return { problems: result.problems, report: result.report, lessons: lessons.length };
}

// ---------------------------------------------------------------------------
// Self-test: prove the gate can fail
// ---------------------------------------------------------------------------

// A scratch tree holding a copy of the client, so a mutation touches a temp dir and not the working
// tree. web/src is a dozen files; copying it per case is cheaper than reasoning about which one a
// case rewrote.
function withClientCopy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "client-sections-"));
  const src = join(dir, "src");
  cpSync(WEB_SRC, src, { recursive: true });
  mutate(src);
  return src;
}

// The corpus half, mutated in place: a lesson file is rewritten with the named section mutated.
function withContentCopy(contentRoot, lessonId, mutate) {
  const dir = mkdtempSync(join(tmpdir(), "client-sections-content-"));
  cpSync(contentRoot, dir, { recursive: true });
  const lessonsDir = join(dir, "lessons");
  const file = readdirSync(lessonsDir).find((f) => {
    const parsed = JSON.parse(readFileSync(join(lessonsDir, f), "utf8"));
    const records = Array.isArray(parsed) ? parsed : [parsed];
    return records.some((r) => r && r.id === lessonId);
  });
  const path = join(lessonsDir, file);
  const records = JSON.parse(readFileSync(path, "utf8"));
  const target = (Array.isArray(records) ? records : [records]).find((r) => r && r.id === lessonId);
  mutate(target);
  writeFileSync(path, JSON.stringify(records, null, 2));
  return dir;
}

const SELFTEST_CASES = [
  {
    id: "api-serves-a-section-nobody-declared",
    // The recurrence MAX-146 exists to stop: a fourth list appears on the lesson route and nothing
    // says whether a client can reach it.
    apply() {
      return { contentRoot: DEFAULT_CONTENT, clientDir: WEB_SRC, apiSections: [...SECTION_ID_FIELDS.map((s) => s.section), "retired"] };
    },
    expect: /no reach decision.*retired|retired.*no reach decision/s,
  },
  {
    id: "client-fetches-a-section-declared-api-only",
    // Adding the mastery fetch is allowed and probably wanted. It has to be recorded, and this is
    // what forces that: the reach decision and the source move in one commit.
    apply() {
      const dir = withClientCopy((src) => {
        const p = join(src, "App.jsx");
        writeFileSync(
          p,
          readFileSync(p, "utf8").replace(
            "sections?.practice?.exerciseIds",
            "sections?.mastery?.exerciseIds",
          ),
        );
      });
      return { contentRoot: DEFAULT_CONTENT, clientDir: dir, apiSections: SECTION_ID_FIELDS.map((s) => s.section) };
    },
    expect: /App\.jsx names the "mastery" exercise list, which is declared api-only/,
  },
  {
    id: "client-stopped-fetching-a-declared-served-section",
    apply() {
      const dir = withClientCopy((src) => {
        const p = join(src, "App.jsx");
        writeFileSync(
          p,
          readFileSync(p, "utf8").replace(/sections\?\.practice\?\.exerciseIds/, "undefinedIds"),
        );
      });
      return { contentRoot: DEFAULT_CONTENT, clientDir: dir, apiSections: SECTION_ID_FIELDS.map((s) => s.section) };
    },
    expect: /names the "practice" exercise list, which is declared served/,
  },
  {
    id: "a-solution-outside-its-lessons-practice-list",
    // solutions is covered because it rides along with practice. Stop it riding along and the
    // declaration is wrong, which is the point of asserting coverage rather than trusting it.
    apply() {
      const dir = withContentCopy(DEFAULT_CONTENT, "m1-l1", (lesson) => {
        const ids = (lesson.sections.solutions && lesson.sections.solutions.exerciseIds) || [];
        lesson.sections.solutions.exerciseIds = [...ids, "not-in-practice-m1-l1"];
      });
      return { contentRoot: dir, clientDir: WEB_SRC, apiSections: SECTION_ID_FIELDS.map((s) => s.section) };
    },
    expect: /lists not-in-practice-m1-l1 in solutionIds, which its practiceIds does not carry/,
  },
];

export function selftest() {
  const problems = [];

  // 1. The real corpus must pass, or every case below is vacuous: a gate that fails on the
  //    untouched tree proves nothing about what it detects.
  const clean = checkClientSections();
  if (clean.problems.length > 0) {
    problems.push(
      "the gate fails on the repository as it stands, so the cases below would pass for the wrong reason:\n" +
        clean.problems.map((p) => `  ${p}`).join("\n"),
    );
  }

  // 2. Every mutation must be caught, by name.
  for (const c of SELFTEST_CASES) {
    const { apiSections, contentRoot, clientDir } = c.apply();
    let observed;
    try {
      observed = checkClientSurface({
        apiSections,
        sources: readClientSources(clientDir),
        lessons: [...loadContentStore(contentRoot).lessons.values()],
      }).problems;
    } catch (error) {
      problems.push(`${c.id}: the gate threw instead of reporting: ${error && error.message}`);
      continue;
    }
    if (observed.length === 0) {
      problems.push(`${c.id}: MISSED -- the gate reported no problem`);
    } else if (!observed.some((p) => c.expect.test(p))) {
      problems.push(`${c.id}: reported something, but not the expected finding.\n  expected /${c.expect.source}/\n  got:\n${observed.map((p) => `    ${p}`).join("\n")}`);
    }
  }

  // 3. And the vacuous case, which is the one that has bitten this repository before: a scan that
  //    reads no files must not report that the client reaches exactly what it was told it reaches.
  const vacuous = checkClientSurface({
    apiSections: SECTION_ID_FIELDS.map((s) => s.section),
    sources: [],
    lessons: [...loadContentStore(DEFAULT_CONTENT).lessons.values()],
  }).problems;
  if (!vacuous.some((p) => /no files under web\/src were read/.test(p))) {
    problems.push("no-files-scanned: MISSED -- a scan over zero files is not a pass");
  }

  return problems;
}

// ---------------------------------------------------------------------------

function main(argv) {
  const args = argv.slice(2);
  const jsonIndex = args.indexOf("--json");
  const jsonOut = jsonIndex === -1 ? null : args[jsonIndex + 1];
  const selftestOnly = args.includes("--selftest");
  const positional = args.filter((a, i) => !a.startsWith("--") && i !== jsonIndex + 1);
  const contentRoot = resolve(positional[0] || DEFAULT_CONTENT);

  if (!existsSync(contentRoot) || !existsSync(WEB_SRC)) {
    process.stderr.write(`check-client-sections: ${!existsSync(contentRoot) ? contentRoot : WEB_SRC} is missing\n`);
    return 2;
  }

  let problems = [];
  let report = null;
  let lessons = 0;
  try {
    if (selftestOnly) {
      problems = selftest();
    } else {
      const result = checkClientSections({ contentRoot });
      problems = result.problems;
      report = result.report;
      lessons = result.lessons;
    }
  } catch (error) {
    process.stderr.write(`check-client-sections: ${error && error.stack ? error.stack : error}\n`);
    return 2;
  }

  if (jsonOut) {
    mkdirSync(dirname(jsonOut), { recursive: true });
    writeFileSync(
      jsonOut,
      JSON.stringify({ status: problems.length === 0 ? "pass" : "fail", lessons, report, problems }, null, 2) + "\n",
    );
  }

  if (problems.length > 0) {
    process.stderr.write(`check-client-sections: ${problems.length} problem(s)\n\n`);
    for (const p of problems) process.stderr.write(`${p}\n\n`);
    if (selftestOnly) process.stderr.write("selftest FAILED\n");
    return 1;
  }

  if (selftestOnly) {
    process.stdout.write(`check-client-sections: selftest passed (${SELFTEST_CASES.length + 1} cases)\n`);
  } else {
    process.stdout.write(`check-client-sections: ok -- ${lessons} lessons\n\n`);
    process.stdout.write(`section  client reach\n`);
    process.stdout.write(`${formatReport(report)}\n`);
    for (const d of CLIENT_REACH) {
      process.stdout.write(`\n${d.section} (${d.reach}): ${d.why}\n`);
    }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv));
}