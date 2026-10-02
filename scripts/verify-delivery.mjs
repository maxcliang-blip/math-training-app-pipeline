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
// lesson ids", which is exactly what ls-tree answers.
//
// Usage:
//   node scripts/verify-delivery.mjs [--ref <ref>] [--json] <lesson-id> [<lesson-id> ...]
//
//   --ref    the ref to check against. Defaults to origin/main, falling back to main.
//   --json   machine-readable result on stdout, in addition to the human summary.
//
// Exit codes: 0 every id is present on the ref · 1 at least one id is absent · 2 usage or git error.
//
// Lesson files are not named after their ids: content/lessons/pilot-lesson.json holds m1-l1. So
// the id is resolved against the records the tree holds, not against the filenames, and each file
// is read as either one record or an array of them - see the counting hazard in
// api/src/content.js and lib/corpus-pins.mjs. A resolver that assumes <id>.json, or that reads
// only the first record of a file, would report m1-l1 missing on a corpus that has it.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DEFAULT_REFS = ["origin/main", "main"];

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(" ")} failed: ${err.stderr || err.message}`);
  }
}

function resolveRef(explicit) {
  if (explicit) {
    if (git(["rev-parse", "--verify", "--quiet", `${explicit}^{commit}`], { allowFailure: true }) === null) {
      throw new Error(`--ref ${explicit} is not a commit in this repository`);
    }
    return explicit;
  }
  for (const ref of DEFAULT_REFS) {
    if (git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFailure: true }) !== null) return ref;
  }
  throw new Error(`none of ${DEFAULT_REFS.join(", ")} resolves here; pass --ref explicitly`);
}

// One batched cat-file for the whole lesson set rather than a `git show` per file: the ref's tree
// is read, not the working copy, so this answers "what does the branch hold" even when the author
// is sitting on an unmerged worktree that does hold it.
function lessonIdsAtRef(ref) {
  const listing = git(["ls-tree", "-r", "--name-only", ref, "--", "content/lessons"]).trim();
  const paths = listing ? listing.split("\n").filter((p) => p.endsWith(".json")) : [];
  if (!paths.length) throw new Error(`${ref} holds no JSON lesson files under content/lessons`);

  const ids = new Set();
  const byPath = new Map();
  const stdin = paths.map((p) => `${ref}:${p}`).join("\n") + "\n";
  let out = "";
  try {
    out = execFileSync("git", ["cat-file", "--batch"], {
      cwd: REPO,
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
  paths.forEach((path, i) => {
    const chunk = chunks[i];
    if (!chunk) return;
    const body = chunk.slice(chunk.indexOf("\n") + 1);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      throw new Error(`${ref}:${path} is not JSON, so the lesson ids it holds cannot be read: ${err.message}`);
    }
    const records = Array.isArray(parsed) ? parsed : [parsed];
    for (const record of records) {
      if (record && typeof record.id === "string") {
        ids.add(record.id);
        if (!byPath.has(record.id)) byPath.set(record.id, path);
      }
    }
  });

  return { ids, byPath, fileCount: paths.length };
}

export function verifyDelivery(ids, ref) {
  const target = resolveRef(ref);
  const { ids: present, byPath, fileCount } = lessonIdsAtRef(target);
  const rows = ids.map((id) => ({
    id,
    delivered: present.has(id),
    path: byPath.get(id) || null,
  }));
  return { ref: target, lessonFiles: fileCount, lessonsOnRef: present.size, rows, ok: rows.every((r) => r.delivered) };
}

function parseArgs(argv) {
  let ref = null;
  let json = false;
  const ids = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ref") {
      ref = argv[++i];
      if (!ref) throw new Error("--ref needs a value");
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      ids.push(arg);
    }
  }
  return { ref, json, ids, help: false };
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
    console.log("usage: node scripts/verify-delivery.mjs [--ref <ref>] [--json] <lesson-id> [...]");
    process.exit(0);
  }
  if (!parsed.ids.length) {
    // The check that never gets asked anything is the check MAX-20 and MAX-23 would have passed.
    console.error("verify-delivery: no lesson ids given; a close-out that names nothing proves nothing");
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
  console.log(`  ${result.lessonFiles} lesson files hold ${result.lessonsOnRef} lesson records`);
  for (const row of result.rows) {
    console.log(`  ${row.delivered ? "ok  " : "MISS"}  ${row.id}${row.path ? `  (${row.path})` : ""}`);
  }
  if (parsed.json) console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    const missing = result.rows.filter((r) => !r.delivered).map((r) => r.id);
    console.error("");
    console.error(`  ${missing.join(", ")} is not on ${result.ref}.`);
    console.error("  Either the work is not merged, or it was never written. Do not close the issue done.");
    process.exit(1);
  }
  process.exit(0);
}
