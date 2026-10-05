#!/usr/bin/env node
// Delivery check for a content issue close-out (MAX-64).
//
// Why this exists: two content issues were closed `done` with nothing on main behind them.
//   - MAX-20 - `done`, m8-l4 authored on a branch for weeks and never merged.
//   - MAX-23 - `done`, m5-l2 never authored at all.
// Four weeks of false completion, and nothing in CI could see either one: `content:check` and
// `npm test` validate the corpus in front of them, and a lesson that does not exist is not a
// defect in a corpus that does not exist.
//
// So the close-out has to say what it delivered, and something has to check it against the branch
// the work is supposed to be on. That something is this script.
//
// WHY `git ls-tree` AND NOT `git merge-base --is-ancestor <sha> <ref>`
// A reachability test on the original commit says whether that commit is in the history of the
// target ref. Cherry-picked content is reachable without the original commit being an ancestor -
// and a land commit that cherry-picks three lessons from three branches is the normal shape of
// work here. So the question is not "is the commit there" but "does the ref's tree hold these
// ids", which is exactly what ls-tree answers.
//
// WHY EVERY ID NAMESPACE, NOT JUST `record.id` (MAX-104)
// The first version of this resolver read top-level `record.id` and nothing else. A figure id lives
// at `sections.<name>.figures[].id` and a worked-example id at `sections.<name>.examples[].id`, so
// the resolver could not see either. It answered MISS for a figure that was in the tree and MISS
// for one that was not - the same answer for a delivered thing and an undelivered one, which is
// the only answer a gate must never give. On the corpus at the time: 38 ids it could read, 73
// figure ids and 150 worked-example ids it could not. Adding exercises makes it 1,020 addressable
// ids against the 38 this used to see, so three quarters of what a content issue can deliver was
// invisible to the check that exists to prove delivery.
//
// The unit is the id, not the record kind, and that is deliberate. An id is what a close-out
// names, and it is the only spelling that survives a squash, a rebase, a cherry-pick, conflict
// resolution, a subject rewrite and the deletion of the branch it was authored on. A patch-id
// assertion survives none of those (MAX-104 measured that: N commits squash-merged into one makes
// `git cherry` report `+` about work that is fully merged, and a deleted branch makes it exit 128).
//
// Usage:
//   node scripts/verify-delivery.mjs [--ref <ref>] [--json] <id> [<id> ...]
//   node scripts/verify-delivery.mjs --selftest
//
//   --ref       the ref to check against. Defaults to origin/main, falling back to main.
//   --json      machine-readable result on stdout, in addition to the human summary.
//   --selftest  prove the resolver on a throwaway corpus. See `selftest` below.
//
// Exit codes: 0 every id is present on the ref · 1 at least one id is absent · 2 usage, git, or
// ambiguity error - including an id the ref holds twice, which this refuses to resolve at all
// rather than resolving to whichever record it read first.
//
// Lesson files are not named after their ids: content/lessons/pilot-lesson.json holds m1-l1. So
// the id is resolved against the records the tree holds, not against the filenames, and each file
// is read as either one record or an array of them - see the counting hazard in
// api/src/content.js and lib/corpus-pins.mjs. A resolver that assumes <id>.json, or that reads
// only the first record of a file, would report m1-l1 missing on a corpus that has it.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DEFAULT_REFS = ["origin/main", "main"];

// Every directory whose records carry an id a close-out might name. `content/fixtures` is not one:
// fixtures are inputs to the test suite, not content a content issue delivers.
const CONTENT_DIRS = ["content/lessons", "content/exercises"];

// The id namespaces, in the order they are reported. `figure` and `worked-example` are ids on
// records nested inside a lesson; `lesson` and `exercise` are ids on the records themselves.
const KINDS = ["lesson", "figure", "worked-example", "exercise"];

function git(args, { allowFailure = false, cwd = REPO } = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(" ")} failed: ${err.stderr || err.message}`);
  }
}

function resolveRef(explicit, { cwd = REPO } = {}) {
  if (explicit) {
    if (git(["rev-parse", "--verify", "--quiet", `${explicit}^{commit}`], { allowFailure: true, cwd }) === null) {
      throw new Error(`--ref ${explicit} is not a commit in this repository`);
    }
    return explicit;
  }
  for (const ref of DEFAULT_REFS) {
    if (git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFailure: true, cwd }) !== null) return ref;
  }
  throw new Error(`none of ${DEFAULT_REFS.join(", ")} resolves here; pass --ref explicitly`);
}

// One batched cat-file for the whole content set rather than a `git show` per file: the ref's tree
// is read, not the working copy, so this answers "what does the branch hold" even when the author
// is sitting on an unmerged worktree that does hold it.
function recordsAtRef(ref, cwd) {
  const listing = [];
  for (const dir of CONTENT_DIRS) {
    const paths = git(["ls-tree", "-r", "--name-only", ref, "--", dir], { cwd })
      .trim()
      .split("\n")
      .filter((p) => p.endsWith(".json"));
    listing.push(...paths);
  }
  if (!listing.length) throw new Error(`${ref} holds no JSON content files under ${CONTENT_DIRS.join(", ")}`);

  const stdin = listing.map((p) => `${ref}:${p}`).join("\n") + "\n";
  let out = "";
  try {
    out = execFileSync("git", ["cat-file", "--batch"], {
      cwd,
      input: stdin,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`git cat-file --batch failed: ${err.stderr || err.message}`);
  }

  // --batch emits "<oid> <type> <size>\n<contents>\n" per request; split on the header line so a
  // record containing a newline cannot desynchronise the walk.
  const chunks = out.split(/\n(?=[0-9a-f]{40} (?:blob|commit|tree) )/);
  const files = [];
  listing.forEach((path, i) => {
    const chunk = chunks[i];
    if (!chunk) return;
    const body = chunk.slice(chunk.indexOf("\n") + 1);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      throw new Error(`${ref}:${path} is not JSON, so the ids it holds cannot be read: ${err.message}`);
    }
    files.push({ path, records: Array.isArray(parsed) ? parsed : [parsed] });
  });
  return files;
}

// A record with no id cannot collide, so MAX-106's uniqueness rule skips it - and it is equally
// unaddressable by anything that resolves by id, which is the premise this whole script rests on.
// So they are counted and named rather than dropped: a figure that exists but can never be asserted
// delivered is the same blind spot as a figure the resolver cannot see, one level down, and the
// close-out should be able to see it in the gate's own coverage line. Four of m5-l1's figure
// reservations are in this state today.
function idIndexAtRef(ref, cwd = REPO) {
  const files = recordsAtRef(ref, cwd);
  const holders = new Map();
  const first = new Map();
  const unaddressable = [];

  // A nested record is addressed the way preflight-content.mjs addresses it in a figure-id-unique
  // finding -- `lessons/<lesson-id>.sections.<section>.figures[i]`, no filename - so a site printed
  // here can be pasted into a content:check finding and the other way round. The filename is kept
  // separately because the row is also meant to be clickable.
  const claim = (id, kind, path, where) => {
    if (typeof id !== "string" || id.trim() === "") return false;
    const site = where ? `${path}.${where}` : path;
    if (!holders.has(id)) holders.set(id, []);
    holders.get(id).push(`${kind} ${site}`);
    if (!first.has(id)) first.set(id, { id, kind, path, where, site });
    return true;
  };

  for (const { path, records } of files) {
    const isExercise = path.startsWith("content/exercises/");
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      if (isExercise) {
        claim(record.id, "exercise", path, "");
        continue;
      }
      claim(record.id, "lesson", path, "");
      for (const [sectionName, section] of Object.entries((record && record.sections) || {})) {
        if (!section || typeof section !== "object") continue;
        for (const [field, kind] of [["figures", "figure"], ["examples", "worked-example"]]) {
          for (const [index, child] of (Array.isArray(section[field]) ? section[field] : []).entries()) {
            if (!child || typeof child !== "object") continue;
            const where = `sections.${sectionName}.${field}[${index}]`;
            const holder = `lessons/${record.id}`;
            if (!claim(child.id, kind, holder, where)) {
              unaddressable.push({ kind, path, where: `${holder}.${where}` });
            }
          }
        }
      }
    }
  }

  const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const { kind } of first.values()) counts[kind] += 1;

  const collisions = [...holders.entries()]
    .filter(([, sites]) => sites.length > 1)
    .map(([id, sites]) => ({ id, sites }));

  return {
    ids: first,
    holders,
    counts,
    fileCount: files.length,
    unaddressable,
    collisions,
    total: first.size,
  };
}

export function verifyDelivery(ids, ref, { cwd = REPO } = {}) {
  const target = resolveRef(ref, { cwd });
  const index = idIndexAtRef(target, cwd);

  const rows = ids.map((id) => {
    const hit = index.ids.get(id) || null;
    const sites = index.holders.get(id) || [];
    return {
      id,
      // An id the ref holds twice is not delivered, it is unanswerable. Reporting it delivered
      // because one of the two records matched would be the MAX-106 failure mode reproduced inside
      // the consumer that motivated the rule, so `ambiguous` is its own state and `delivered` is
      // false until exactly one record holds the id.
      delivered: hit !== null && sites.length === 1,
      ambiguous: sites.length > 1,
      kind: hit ? hit.kind : null,
      path: hit ? hit.path : null,
      site: hit ? hit.site : null,
      holders: sites,
    };
  });

  const ambiguous = rows.filter((r) => r.ambiguous);
  return {
    ref: target,
    contentFiles: index.fileCount,
    addressableIds: index.total,
    idCounts: index.counts,
    unaddressableRecords: index.unaddressable.length,
    unaddressableSample: index.unaddressable.slice(0, 4),
    collisions: index.collisions,
    rows,
    ambiguous: ambiguous.map((r) => r.id),
    ok: rows.every((r) => r.delivered),
  };
}

function parseArgs(argv) {
  let ref = null;
  let json = false;
  let selftest = false;
  const ids = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ref") {
      ref = argv[++i];
      if (!ref) throw new Error("--ref needs a value");
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--selftest") {
      selftest = true;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      ids.push(arg);
    }
  }
  return { ref, json, ids, selftest, help: false };
}

// ---------------------------------------------------------------------------
// Self-test (MAX-104)
// ---------------------------------------------------------------------------
//
// The bug this fixes was not a wrong answer, it was an answer that could not be wrong: the
// resolver read one id namespace and reported MISS for a figure that was in the tree and MISS for
// one that was not, so every test written against it would have passed. A presence assertion
// cannot catch that, so each row below states the case and the opposite case together and asserts
// both - a figure id that is present must resolve, and a figure id that is absent must not.
//
// It runs on a throwaway git repository rather than on this corpus, because a corpus-derived
// fixture proves only that the ids it happens to contain resolve. The fixtures here are four
// records written to say what they are for.
export function selftest() {
  const dir = mkdtempSync(join(tmpdir(), "verify-delivery-selftest-"));
  const gitInit = (...args) =>
    execFileSync("git", ["-c", "user.name=selftest", "-c", "user.email=selftest@example.invalid", ...args], {
      cwd: dir,
      encoding: "utf8",
    });

  const rows = [];
  const row = (id, caught, detail) => rows.push({ id, caught, detail });

  try {
    mkdirSync(join(dir, "content/lessons"), { recursive: true });
    mkdirSync(join(dir, "content/exercises"), { recursive: true });

    const lesson = (id, figures, examples) => ({
      id,
      sections: {
        concept: {
          conceptLatex: `$x$`,
          ...(figures ? { figures } : {}),
          ...(examples ? { examples } : {}),
        },
      },
    });

    const held = lesson(
      "sel-l1",
      [{ id: "sel-l1-fig-1", asymptoteSource: "draw((0,0)--(1,1));" }],
      [{ id: "sel-l1-ex-1", bodyLatex: "$y$" }],
    );
    const second = lesson("sel-l2", [{ id: "sel-l2-fig-1", asymptoteSource: "draw((0,0)--(2,2));" }], []);
    // No id at all: the unaddressable case.
    const anonymous = lesson("sel-l3", [{ asymptoteSource: "draw((0,0)--(3,3));" }], []);
    // Two different lessons holding one id: the collision case. Split across a file boundary so it
    // is the corpus-wide rule being exercised, not a within-one-record duplicate.
    const clashA = lesson("sel-l4", [{ id: "sel-clash-fig-1", asymptoteSource: "draw((0,0)--(4,4));" }], []);
    const clashB = lesson("sel-l5", [{ id: "sel-clash-fig-1", asymptoteSource: "draw((0,0)--(5,5));" }], []);

    writeFileSync(join(dir, "content/lessons/held.json"), JSON.stringify(held, null, 2));
    writeFileSync(join(dir, "content/lessons/second.json"), JSON.stringify(second, null, 2));
    writeFileSync(join(dir, "content/lessons/anon.json"), JSON.stringify(anonymous, null, 2));
    writeFileSync(join(dir, "content/lessons/clash-a.json"), JSON.stringify(clashA, null, 2));
    writeFileSync(join(dir, "content/lessons/clash-b.json"), JSON.stringify(clashB, null, 2));
    writeFileSync(join(dir, "content/exercises/p1.json"), JSON.stringify({ id: "sel-l1-p1", lessonId: "sel-l1" }, null, 2));

    gitInit("init", "-q", "-b", "main");
    gitInit("add", "-A");
    gitInit("commit", "-q", "-m", "selftest corpus");

    const seen = (ids) => verifyDelivery(ids, "main", { cwd: dir });
    const problems = [];

    // 1. The regression that started this: a figure id that IS in the tree must resolve. A resolver
    //    that only reads top-level record.id returns MISS here, and only here.
    {
      const r = seen(["sel-l1-fig-1"]);
      const rowOk = r.rows[0].delivered === true && r.rows[0].kind === "figure" && r.ok === true;
      if (!rowOk) {
        problems.push(
          `sel-l1-fig-1 is in the tree but resolved as delivered=${r.rows[0].delivered} kind=${r.rows[0].kind} - a figure id the resolver cannot see is the MAX-104 defect`,
        );
      }
      row("figure-id-in-the-tree-resolves", rowOk, rowOk ? "sel-l1-fig-1 resolved as a figure in sections.concept.figures[0]" : problems.join("; "));
    }

    // 2. ...and the opposite case, so row 1 cannot be satisfied by a resolver that says ok to
    //    everything. This is the half the original bug could not distinguish.
    {
      const r = seen(["sel-l1-fig-404"]);
      const rowOk = r.rows[0].delivered === false && r.ok === false;
      if (!rowOk) problems.push(`sel-l1-fig-404 is not in the tree but resolved as delivered=${r.rows[0].delivered}`);
      row("figure-id-not-in-the-tree-is-miss", rowOk, rowOk ? "sel-l1-fig-404 is MISS" : problems.join("; "));
    }

    // 3. Worked examples and exercises are namespaces too, and the original resolver saw neither.
    {
      const r = seen(["sel-l1-ex-1", "sel-l1-p1", "sel-l1-p404"]);
      const kinds = r.rows.map((x) => `${x.id}:${x.delivered ? "ok" : "MISS"}/${x.kind || "-"}`).join(" ");
      const rowOk = r.rows[0].kind === "worked-example" && r.rows[0].delivered && r.rows[1].kind === "exercise" && r.rows[1].delivered && !r.rows[2].delivered;
      if (!rowOk) problems.push(`expected sel-l1-ex-1 ok/worked-example, sel-l1-p1 ok/exercise, sel-l1-p404 MISS; got ${kinds}`);
      row("worked-example-and-exercise-ids-resolve", rowOk, rowOk ? kinds : problems.join("; "));
    }

    // 4. A lesson id still resolves - the one namespace the original resolver did read, asserted so
    //    the fix cannot be a regression in the other direction.
    {
      const r = seen(["sel-l1"]);
      const rowOk = r.rows[0].delivered === true && r.rows[0].kind === "lesson";
      if (!rowOk) problems.push(`sel-l1 is in the tree but resolved as delivered=${r.rows[0].delivered} kind=${r.rows[0].kind}`);
      row("lesson-id-still-resolves", rowOk, rowOk ? "sel-l1 resolved as a lesson" : problems.join("; "));
    }

    // 5. An id held by two records is not resolved to whichever was read first. MAX-106's
    //    figure-id-unique rule makes this corpus invalid, which is the point: the consumer refuses
    //    rather than guessing, and says which two records hold it.
    {
      const r = seen(["sel-clash-fig-1"]);
      const rowOk = r.rows[0].ambiguous === true && r.rows[0].delivered === false && r.rows[0].holders.length === 2 && r.ok === false;
      if (!rowOk) problems.push(`sel-clash-fig-1 is held twice but resolved as delivered=${r.rows[0].delivered} holders=${JSON.stringify(r.rows[0].holders)}`);
      row("a-duplicate-id-is-reported-not-picked", rowOk, rowOk ? `sel-clash-fig-1 is ambiguous across ${r.rows[0].holders.join(" and ")}` : problems.join("; "));
    }

    // 6. A record with no id is counted, not dropped. It cannot collide and it cannot be addressed;
    //    silence about it is how the m5-l1 reservations stayed invisible.
    {
      const r = seen([]);
      const rowOk = r.unaddressableRecords === 1 && r.addressableIds === 10 && r.idCounts.lesson === 5 && r.idCounts.figure === 3 && r.idCounts["worked-example"] === 1 && r.idCounts.exercise === 1;
      if (!rowOk) problems.push(`expected 1 unaddressable record and 10 addressable ids (5 lessons, 3 figures, 1 worked example, 1 exercise); got ${r.unaddressableRecords}, ${r.addressableIds}, ${JSON.stringify(r.idCounts)}`);
      row("an-id-less-record-is-counted", rowOk, rowOk ? `${r.unaddressableRecords} record with no id, ${r.addressableIds} addressable ids ${JSON.stringify(r.idCounts)}` : problems.join("; "));
    }

    const ok = rows.every((r) => r.caught);
    return { ok, rows };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`verify-delivery: ${err.message}`);
    process.exit(2);
  }
  if (parsed.help) {
    console.log("usage: node scripts/verify-delivery.mjs [--ref <ref>] [--json] <id> [...]");
    console.log("       node scripts/verify-delivery.mjs --selftest");
    process.exit(0);
  }

  if (parsed.selftest) {
    let result;
    try {
      result = selftest();
    } catch (err) {
      console.error(`verify-delivery: selftest threw: ${err.message}`);
      process.exit(2);
    }
    for (const r of result.rows) {
      console.log(`  ${r.caught ? "ok  " : "FAIL"}  ${r.id}  --  ${r.detail}`);
    }
    console.log(`verify-delivery: selftest ${result.ok ? "PASS" : "FAIL"}  (${result.rows.length} rows)`);
    process.exit(result.ok ? 0 : 1);
  }

  if (!parsed.ids.length) {
    // The check that never gets asked anything is the check MAX-20 and MAX-23 would have passed.
    console.error("verify-delivery: no ids given; a close-out that names nothing proves nothing");
    process.exit(2);
  }

  let result;
  try {
    result = verifyDelivery(parsed.ids, parsed.ref);
  } catch (err) {
    console.error(`verify-delivery: ${err.message}`);
    process.exit(2);
  }

  console.log(`verify-delivery: ${result.ok ? "DELIVERED" : "NOT DELIVERED"}  (ref ${result.ref})`);
  console.log(
    `  ${result.contentFiles} content files hold ${result.addressableIds} addressable ids  ` +
      `(${KINDS.map((k) => `${result.idCounts[k]} ${k}s`).join(", ")})`,
  );
  if (result.unaddressableRecords) {
    console.log(
      `  ${result.unaddressableRecords} record(s) on ${result.ref} carry no id and cannot be addressed by this gate` +
        `  (e.g. ${result.unaddressableSample.map((u) => `${u.kind} ${u.where}`).join("; ")})`,
    );
  }
  // Corpus-wide, not just for the ids asked about. MAX-106's figure-id-unique rule makes this an
  // error at content:check, so it should not survive a merge - but the gate reports it anyway,
  // because a duplicate is exactly the state in which this script's answer is a guess, and a
  // check that can make a guess should say so even when the guess is not one it was asked for.
  if (result.collisions.length) {
    console.log(`  ${result.collisions.length} id(s) on ${result.ref} are held by more than one record:`);
    for (const c of result.collisions.slice(0, 5)) console.log(`    ${c.id}  ${c.sites.join("  AND  ")}`);
  }
  for (const row of result.rows) {
    const verdict = row.ambiguous ? "AMBIG" : row.delivered ? "ok  " : "MISS";
    const where = row.ambiguous ? row.holders.join("  AND  ") : row.delivered ? `${row.kind}  ${row.site}` : "";
    console.log(`  ${verdict}  ${row.id}${where ? `  (${where})` : ""}`);
  }
  if (parsed.json) console.log(JSON.stringify(result, null, 2));

  if (result.ambiguous.length) {
    console.error("");
    console.error(`  ${result.ambiguous.join(", ")} is held by more than one record on ${result.ref}.`);
    console.error("  This gate will not pick one. Run npm run content:check; figure-id-unique names every site.");
    process.exit(2);
  }
  if (!result.ok) {
    const missing = result.rows.filter((r) => !r.delivered).map((r) => r.id);
    console.error("");
    console.error(`  ${missing.join(", ")} is not on ${result.ref}.`);
    console.error("  Either the work is not merged, or it was never written. Do not close the issue done.");
    process.exit(1);
  }
  process.exit(0);
}