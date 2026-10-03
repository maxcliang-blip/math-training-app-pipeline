#!/usr/bin/env node
// Pull request body coverage gate (MAX-83, item 4 of MAX-69).
//
// The incident this exists for: PR #19 was opened with a body describing a Dockerfile change and
// merged with 26 changed files. A reviewer reading the body had no way to know that 23 of those
// files were somebody else's lesson content. Nothing failed. CI was green, the push guard passed,
// the merge succeeded, and the only signal that existed was `changed_files 26` in the PR metadata,
// which nobody was reading as an assertion.
//
// `scripts/check-push-authors.mjs` (PR #25) closes the *next* occurrence earlier, at push time, by
// refusing a branch that carries another agent's commit. It cannot close this one, and says so in
// its own header: a squash rewrites authorship to the first commit's author, and a worktree with
// the wrong identity produces commits that match the configured identity. So this is the second
// layer, and it asks a different question. Not "who wrote these commits" but "does this pull
// request's own description account for the files this pull request changes".
//
// Two rules, and the second one is the one that matters:
//
//   1. Coverage. Every changed path must be matched by a path, glob, directory prefix or blob URL
//      named in the body. An unmatched path is reported by name.
//   2. A prose claim per top-level area. Every top-level area the change touches needs at least
//      one block of the body that mentions it and carries a sentence's worth of non-path words.
//
// Rule 1 alone is a rubber stamp. PR #19's body could have listed all 26 paths and passed a
// coverage check while telling a reviewer nothing at all -- and the failure it reproduces is not
// "the reviewer cannot enumerate the files", it is "the reviewer has no idea what they are being
// asked to approve". Rule 2 is what forces the description to actually say something, and it is
// deliberately cheap to satisfy: name the area once, in a sentence, in your own words.
//
// What this is not: a judge of intent. It cannot tell an honest account of somebody else's carried
// content from a dishonest one, and it does not try -- a wrong claim is a reviewer's problem, not a
// workflow's. The failure message says so, and points at the human. Deciding intent belongs to the
// reviewer reading the description, which is exactly the step that was skipped in PR #19.
//
// Limits, stated here so nobody assumes otherwise:
//   - A lie passes. "23 lessons of geometry, carried from Carol's worktree as noted in MAX-69" is a
//     claim this script cannot audit. It has to be a claim a human can check.
//   - A vague sentence passes rule 2. `MIN_CLAIM_WORDS` is a floor on volume, not on quality.
//   - Only the body is read. The title is not a description of the change.
//
// Usage:
//   node scripts/check-pr-body-coverage.mjs --body <body.md> --files <changed.txt> [--pr <url>]
//   node scripts/check-pr-body-coverage.mjs --selftest
//
// Exit codes: 0 pass · 1 unaccounted files or missing prose claims · 2 configuration error.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A top-level area is one sentence of explanation. Chosen against the shortest honest sentence a
// person actually writes ("content/lessons: 23 geometry lessons carried over from another agent's
// worktree, see MAX-69") and against the shortest *fake* one, so it is low enough not to push
// people into writing README prose and high enough that `files:` and a glob are not enough.
export const MIN_CLAIM_WORDS = 10;

// A token has to look like a file path before it counts as naming one. Bare prose words do not,
// which is the whole reason the MAX-69 case is caught: a body that says "this changes the
// Dockerfile to copy scripts/ into the build" is not a claim on `content/`, and this rule is what
// makes that true rather than a matter of taste.
const PATH_TOKEN = /[A-Za-z0-9_@*?[\]!(){}.-]+(?:\/[A-Za-z0-9_@*?[\]!(){}.-]+)*/g;
const FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,5}$/;
const GLOB_CHAR = /[*?[\]]/;
const GLOBBY_DIR = /[\\/]$/;

// ---------------------------------------------------------------------------
// Body parsing. Pure: no git, no filesystem, no network. Everything the selftest
// drives lives here, so a rule that stops being enforced fails --selftest instead
// of passing quietly.
// ---------------------------------------------------------------------------

// HTML comments are invisible when the body is rendered, so a path that only
// appears inside one has not been disclosed to anybody reading the PR.
function stripHtmlComments(text) {
  return String(text ?? "").replace(/<!--[\s\S]*?-->/g, " ");
}

// Fenced blocks are separated out rather than deleted, because they count as
// *naming* (a `git diff --stat` in the body does account for the files) and must
// not count as *explaining* (a pasted listing is not a claim, and treating it as
// one is precisely the rubber stamp this gate exists to refuse).
export function splitFences(text) {
  const prose = [];
  const fenced = [];
  let inFence = null;
  for (const line of String(text ?? "").split("\n")) {
    const open = line.match(/^\s*(?:```|~~~)/);
    if (inFence === null && open) {
      inFence = open[1];
      continue;
    }
    if (inFence !== null) {
      if (line.trimStart().startsWith(inFence)) inFence = null;
      else fenced.push(line);
      continue;
    }
    prose.push(line);
  }
  // An unterminated fence is still a fence. Treating the rest of the body as prose would let a
  // truncated diff carry claims it never made.
  if (inFence !== null) fenced.push(...prose.splice(0));
  return { prose: prose.join("\n"), fenced: fenced.join("\n") };
}

// Inline code spans and markdown links are the two ways a body names a path on
// purpose, so their contents are candidate claims even when they are a bare word
// (`scripts`). Link *targets* are extracted too, because a permalink to a file is
// a way of naming that file.
export function extractDelimited(text) {
  const quoted = [];
  const fromLinks = [];
  let clean = "";
  const src = String(text ?? "");
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "`") {
      const ticks = /^`+/.exec(src.slice(i))[0];
      const end = src.indexOf(ticks, i + ticks.length);
      if (end === -1) {
        clean += src.slice(i);
        break;
      }
      quoted.push(src.slice(i + ticks.length, end).trim());
      clean += " ";
      i = end + ticks.length;
      continue;
    }
    if (ch === "[") {
      const close = src.indexOf("]", i);
      if (close !== -1 && src[close + 1] === "(") {
        const paren = src.indexOf(")", close + 2);
        if (paren !== -1) {
          const label = src.slice(i + 1, close);
          const target = src.slice(close + 2, paren);
          quoted.push(label);
          for (const p of pathsInUrl(target)) fromLinks.push(p);
          clean += ` ${label} `;
          i = paren + 1;
          continue;
        }
      }
    }
    clean += ch;
    i += 1;
  }
  return { clean, quoted, fromLinks };
}

// `/blob/<ref>/<path>` and `/tree/<ref>/<path>` in a GitHub URL. A permalink in
// the body is naming the file at that path, which is the one case where a body
// can be ambiguous about which repo it is pointing at -- so the host is ignored
// and only the path after the ref counts.
export function pathsInUrl(url) {
  const m = /\/blob\/[^/]+\/(.+)$/.exec(String(url ?? "")) || /\/tree\/[^/]+\/(.+)$/.exec(String(url ?? ""));
  if (!m) return [];
  return [m[1].split("#")[0]];
}

// Trim the punctuation that surrounds a path in prose. Backticks and quotes are
// already gone; this catches `(...path...)`, `path,` and `- path:`.
function normalizeClaim(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/^[([{"'`]+/, "")
    .replace(/[)\]}"'`]+$/, "")
    .replace(/^\.\//, "")
    .replace(/[.,;:!?]+$/, "")
    .replace(/\/+$/, "")
    .trim();
}

// Whether a bare token counts as naming a path. A token qualifies when it is
// quoted (handled by the caller), contains a slash, carries a file extension, or
// is exactly the file name of something the change really touches. The last
// clause is what lets `the Dockerfile` in running prose cover `Dockerfile` while
// `the content of this change` covers nothing at all.
export function qualifiesAsClaim(token, { quoted = false, basenames = new Set() } = {}) {
  if (!token) return false;
  if (quoted || token.includes("/")) return true;
  if (FILE_EXTENSION.test(token)) return true;
  return basenames.has(token);
}

// The literal prefix of a pattern: everything before the first glob character.
// Used both for matching a directory prefix and for deciding which top-level area
// a pattern mentions, so `content/lessons/**` mentions `content` and
// `**/*.json` mentions nothing in particular.
export function patternPrefix(pattern) {
  const i = pattern.search(GLOB_CHAR);
  return (i === -1 ? pattern : pattern.slice(0, i)).replace(/\/+$/, "");
}

export function globToRegExp(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const slashed = pattern[i + 2] === "/";
        re += slashed ? "(?:.*/)?" : ".*";
        i += slashed ? 2 : 1;
      } else {
        re += "[^/]*";
      }
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      continue;
    }
    if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
      continue;
    }
    re += c;
  }
  return new RegExp(`^${re}$`);
}

// One pattern, one path. A literal pattern covers the path itself and anything
// under it; a glob covers what it matches. Nothing else: `scripts` must not cover
// `scripts-extra/a.mjs`, and `content/lessons/a.json` must not cover
// `content/lessons/a.json.bak`.
export function patternCovers(pattern, path) {
  if (!pattern) return false;
  if (GLOB_CHAR.test(pattern)) return globToRegExp(pattern).test(path);
  return path === pattern || path.startsWith(`${pattern}/`);
}

// The top-level area a change lives in: the first path segment, or the file name
// for something at the repository root. Root files each get their own area, so a
// pull request touching `Dockerfile` and `package.json` needs a sentence about
// each. That is more claims to write than grouping them under ".", and it is the
// right trade: the claim is the thing being enforced, and "and also the root
// files" is not a sentence about anything.
export function topLevelArea(path) {
  const clean = String(path ?? "").replace(/^\.\//, "");
  const i = clean.indexOf("/");
  return i === -1 ? clean : clean.slice(0, i);
}

// Words that are not path-like tokens, not inside a code span, and not inside a
// fenced block. This is the measure of "explanation", and it is deliberately
// crude: a floor on volume, not a judgement of meaning. Meaning is the reviewer's
// call and this script says so in its failure message.
export function proseWords(blockText) {
  const { clean, quoted } = extractDelimited(stripHtmlComments(blockText));
  const withoutUrls = clean.replace(/https?:\/\/\S+/g, " ");
  const words = [];
  for (const tok of withoutUrls.match(/[A-Za-z][A-Za-z'’-]*/g) || []) {
    if (qualifiesAsClaim(tok)) continue;
    words.push(tok);
  }
  // `quoted` is consumed by extractDelimited but unused here on purpose: the code
  // spans were already removed from `clean`. Kept explicit so the two-step
  // contract (extract first, count after) is readable.
  void quoted;
  return words;
}

// A block is a maximal run of non-blank lines: a paragraph, a single list item, a
// single table row. Blocks rather than lines, so a claim that wraps across two
// source lines still counts as one claim.
function blocksOf(text) {
  const blocks = [];
  let current = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) {
      if (current.length) blocks.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

// Parse a body into the two things the gate reasons about: the set of path
// patterns it names anywhere, and per-block the patterns and prose it contains.
export function parseBody(body, { basenames = new Set() } = {}) {
  const { prose, fenced } = splitFences(stripHtmlComments(String(body ?? "")));

  const nameIn = (text) => {
    const { clean, quoted, fromLinks } = extractDelimited(text);
    const found = new Set();
    for (const q of [...quoted, ...fromLinks]) {
      const norm = normalizeClaim(q);
      if (norm && qualifiesAsClaim(norm, { quoted: true, basenames })) found.add(norm);
    }
    for (const tok of clean.replace(/https?:\/\/\S+/g, " ").match(PATH_TOKEN) || []) {
      const norm = normalizeClaim(tok);
      if (norm && qualifiesAsClaim(norm, { basenames })) found.add(norm);
    }
    return [...found];
  };

  const blocks = blocksOf(prose).map((text) => ({
    text,
    patterns: nameIn(text),
    words: proseWords(text),
  }));

  // Fenced content names files but never explains them.
  const patterns = new Set();
  for (const p of [...nameIn(prose), ...nameIn(fenced)]) patterns.add(p);

  return { patterns: [...patterns], blocks };
}

// ---------------------------------------------------------------------------
// The decision. Pure, and the only thing the selftest asserts against.
// ---------------------------------------------------------------------------

export function evaluate({ body, files, minClaimWords = MIN_CLAIM_WORDS, title = "" } = {}) {
  const changed = [...new Set((files || []).map((f) => String(f).trim()).filter(Boolean))].sort();
  const basenames = new Set(changed.map((p) => p.slice(p.lastIndexOf("/") + 1)));
  const parsed = parseBody(body, { basenames });
  const patterns = parsed.patterns;

  const coversOf = (path) => patterns.filter((p) => patternCovers(p, path));
  const covered = changed.filter((p) => coversOf(p).length > 0);
  const unmentioned = changed.filter((p) => coversOf(p).length === 0);

  // Area claims. A block claims an area when it names something in that area --
  // a literal pattern whose prefix and the area share a boundary in either
  // direction -- and carries enough prose to be a sentence. Naming is necessary
  // and not sufficient; that is the whole rule 2.
  const areas = [];
  for (const path of changed) {
    const area = topLevelArea(path);
    let entry = areas.find((a) => a.area === area);
    if (!entry) {
      entry = { area, paths: [], claimed: false, claimedBy: null };
      areas.push(entry);
    }
    if (!entry.paths.includes(path)) entry.paths.push(path);
  }
  for (const entry of areas) {
    for (let b = 0; b < parsed.blocks.length; b += 1) {
      const block = parsed.blocks[b];
      if (block.words.length < minClaimWords) continue;
      const names = block.patterns.some((p) => {
        const prefix = patternPrefix(p);
        return prefix === entry.area || prefix.startsWith(`${entry.area}/`) || entry.area.startsWith(`${prefix}/`);
      });
      if (names) {
        entry.claimed = true;
        entry.claimedBy = b;
        break;
      }
    }
  }
  const missingClaims = areas.filter((a) => !a.claimed).map((a) => a.area);

  const problems = [];
  if (!String(body ?? "").trim()) {
    problems.push({
      kind: "empty-body",
      detail: "the pull request has no body, so it describes nothing that could be checked against the files",
    });
  }
  if (!changed.length) {
    problems.push({ kind: "no-changed-files", detail: "the changed-file list is empty; the check was handed nothing to check" });
  }

  return {
    ok: unmentioned.length === 0 && missingClaims.length === 0 && problems.length === 0,
    title: String(title ?? ""),
    changed,
    patterns,
    covered: covered.map((p) => ({ path: p, by: coversOf(p) })),
    unmentioned,
    areas,
    missingClaims,
    blocks: parsed.blocks,
    minClaimWords,
    problems,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

// Workflow annotations, so the failure lands on the file in the diff view rather
// than only in a log nobody opens.
const ANNOTATION_CAP = 10;

export function render(result, { prUrl = "" } = {}) {
  const lines = [];
  const where = prUrl ? ` (${prUrl})` : "";
  lines.push(`check-pr-body-coverage${where}${result.title ? ` — ${result.title}` : ""}`);
  lines.push(`  ${result.changed.length} changed file(s); ${result.patterns.length} path pattern(s) named in the body`);

  for (const p of result.problems) lines.push(`  PROBLEM ${p.kind}: ${p.detail}`);

  if (result.unmentioned.length) {
    lines.push("");
    lines.push(
      `  ${result.unmentioned.length} of ${result.changed.length} changed file(s) are not named anywhere in this pull request's body:`,
    );
    for (const p of result.unmentioned) lines.push(`    ${p}`);
    lines.push("");
    lines.push("  Name each one, or name the directory or glob that covers it. A body that");
    lines.push("  describes one file out of twenty-six is the MAX-69 failure this gate exists for.");
  }

  if (result.missingClaims.length) {
    lines.push("");
    lines.push(`  ${result.missingClaims.length} top-level area(s) have no prose claim in the body:`);
    for (const area of result.missingClaims) {
      const count = result.areas.find((a) => a.area === area)?.paths.length ?? 0;
      lines.push(`    ${area} — ${count} file(s); needs one sentence saying what changed there and why`);
    }
    lines.push("");
    lines.push("  Listing the paths is not the same as saying what they are. One sentence per area,");
    lines.push(`  at least ${result.minClaimWords} words that are not paths, is the bar.`);
  }

  if (!result.ok) {
    lines.push("");
    lines.push("  This gate can only tell you the description does not account for the change. It");
    lines.push("  cannot tell whether a claim is true. A human reviewer still has to read the");
    lines.push("  description and judge it -- which is the step PR #19 skipped.");
  }
  return lines;
}

export function annotations(result) {
  const out = [];
  const summary = result.unmentioned.length
    ? `${result.unmentioned.length} changed file(s) not accounted for by this PR's body: ${result.unmentioned.slice(0, 5).join(", ")}${result.unmentioned.length > 5 ? ", …" : ""}`
    : "";
  if (summary) out.push(`::error title=Unaccounted for in the PR body::${summary}`);
  for (const p of result.unmentioned.slice(0, ANNOTATION_CAP)) {
    out.push(`::error file=${p}::this file changed but no path in the PR body covers it`);
  }
  for (const area of result.missingClaims) {
    out.push(`::error title=No prose claim for ${area}::the body must say what changed in ${area} and why, in a sentence that is not a file list`);
  }
  return out;
}

// The same verdict as a pull request comment. A check nobody reads is a check
// that did not happen, and the whole point of this gate is getting a reviewer in
// front of the description -- so the failure has to land where a reviewer is
// already looking, not only in a run log.
export function markdown(result, { prUrl = "" } = {}) {
  const lines = [];
  const head = result.ok
    ? "**Body coverage: pass.**"
    : "**Body coverage: fail.** This pull request's body does not account for everything it changes.";
  lines.push(head, "");
  lines.push(
    `${result.changed.length} changed file(s); ${result.covered.length} named in the body; ` +
      `${result.unmentioned.length} unmentioned; ${result.areas.length} top-level area(s), ` +
      `${result.areas.length - result.missingClaims.length} with a prose claim.`,
  );
  if (prUrl) lines.push("", `Run: ${prUrl}/checks`);
  if (result.problems.length) {
    lines.push("", ...result.problems.map((p) => `- \`${p.kind}\`: ${p.detail}`));
  }
  if (result.unmentioned.length) {
    lines.push("", `**Unmentioned (${result.unmentioned.length}):**`, "");
    for (const p of result.unmentioned) lines.push(`- \`${p}\``);
    lines.push("", "Name each one, or name the directory or glob that covers it.");
  }
  if (result.missingClaims.length) {
    lines.push("", `**Top-level area(s) with no prose claim (${result.missingClaims.length}):**`, "");
    for (const area of result.missingClaims) {
      const count = result.areas.find((a) => a.area === area)?.paths.length ?? 0;
      lines.push(`- \`${area}\` — ${count} file(s). Needs one sentence saying what changed there and why.`);
    }
    lines.push("", `A list of paths is not a description of them. One sentence per area, at least ${result.minClaimWords} words that are not paths.`);
  }
  lines.push(
    "",
    "---",
    "",
    "This gate can only tell you the description does not account for the change. It cannot tell",
    "whether a claim is **true** — that is the reviewer's read, and it is the step PR #19 skipped.",
    "`scripts/check-pr-body-coverage.mjs` checks accounting; `scripts/check-push-authors.mjs` checks",
    "authorship; neither replaces a human deciding whether a pull request should merge.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Selftest
//
// Two properties, both required, and neither is optional:
//
//   A. It can fail. The first row injects the MAX-69 shape -- a body that accounts
//      for three files while twenty-three more really change -- and requires the
//      check to name them. Every other row is a rule that must fail on a body of
//      the shape it is meant to catch.
//   B. It is not a rubber stamp. A body that names all twenty-six paths and says
//      nothing about any of them must still fail, on rule 2. That row is the one
//      that keeps rule 1 from quietly becoming the only rule.
//
// The harness invariant row is a partition check: `covered` and `unmentioned`
// must between them be exactly `changed`, with no file on both sides and none on
// neither. A coverage check that under-reports its own misses is worse than no
// check, because it is trusted.
// ---------------------------------------------------------------------------

const LESSONS = [
  "content/lessons/algebra-a.json",
  "content/lessons/geometry-b.json",
  "content/lessons/number-theory-c.json",
];

function max69Files() {
  const files = ["Dockerfile", "scripts/copy-scripts.sh", "scripts/lib/copy.mjs"];
  for (let i = 0; i < 23; i += 1) files.push(`content/lessons/extra-${String(i).padStart(2, "0")}.json`);
  return files;
}

// The PR #19 body, in shape: it accounts for three files and says nothing about
// the twenty-three that arrived with somebody else's commit.
const max69Body = [
  "Copy `scripts/` into the image build so `api/test/figures.test.js` can resolve its helpers.",
  "",
  "The Dockerfile's build stage copied `lib/`, `api/` and `web/` but not `scripts/`, so the suite",
  "passed in the checkout and failed in the image.",
].join("\n");

export function selftest() {
  const rows = [];
  const missed = [];

  // expect: "fail" means the injected body must be rejected, and `require` gets
  // to say what "rejected" has to mean beyond a boolean. A check that fails for
  // the wrong reason has not tested the rule.
  const caseOf = (id, rule, detail, files, body, expect, require) => {
    const result = evaluate({ body, files });
    let pass = result.ok === (expect === "pass");
    let why = pass ? null : `expected ${expect}, got ${result.ok ? "pass" : "fail"}`;
    if (pass && require) {
      try {
        require(result);
      } catch (err) {
        pass = false;
        why = err.message;
      }
    }
    rows.push({ id, rule, severity: "error", caught: pass, detail: pass ? detail : `${detail} — ${why}` });
    if (!pass) missed.push(id);
  };

  // --- A. It can fail -------------------------------------------------------

  caseOf(
    "max69-body-omits-23-changed-files",
    "coverage",
    "the MAX-69 shape: a Dockerfile body with 26 changed files must be rejected",
    max69Files(),
    max69Body,
    "fail",
    (r) => {
      if (r.unmentioned.length !== 23) throw new Error(`named ${r.unmentioned.length} unmentioned paths, expected 23`);
      if (r.covered.length !== 3) throw new Error(`covered ${r.covered.length} files, expected 3`);
      if (!r.unmentioned.includes("content/lessons/extra-00.json")) {
        throw new Error("did not name an unmentioned lesson file");
      }
      if (!r.missingClaims.includes("content")) throw new Error("did not report content/ as unclaimed");
    },
  );

  caseOf(
    "one-sibling-omitted-from-a-listed-sibling",
    "coverage",
    "naming one lesson file must not account for the lesson file next to it",
    [...LESSONS, "scripts/a.mjs"],
    [
      "`content/lessons/algebra-a.json` — added one lesson.",
      "",
      "`scripts/a.mjs` grew a helper that the lesson validator calls, so the two changes belong",
      "in the same pull request and the tests exercise both together.",
    ].join("\n"),
    "fail",
    (r) => {
      if (r.unmentioned.join(",") !== "content/lessons/geometry-b.json,content/lessons/number-theory-c.json") {
        throw new Error(`unmentioned was ${JSON.stringify(r.unmentioned)}`);
      }
    },
  );

  caseOf(
    "bare-word-content-is-not-a-path-claim",
    "coverage",
    "the word `content` in prose must not account for every file under content/",
    ["content/lessons/a.json", "Dockerfile"],
    "The content of this change is a Dockerfile fix: the build stage stopped copying scripts/.",
    "fail",
    (r) => {
      if (!r.unmentioned.includes("content/lessons/a.json")) throw new Error("bare word `content` covered a directory");
    },
  );

  caseOf(
    "hidden-html-comment-does-not-disclose",
    "coverage",
    "a path mentioned only inside an HTML comment has not been disclosed to a reader",
    ["content/lessons/a.json", "scripts/a.mjs"],
    [
      "`scripts/a.mjs` — added a helper; the lesson validator calls it, and the fixture for it is",
      "the second lesson file, which the tests exercise on every run of the suite.",
      "",
      "<!-- content/lessons/a.json -->",
    ].join("\n"),
    "fail",
    (r) => {
      if (!r.unmentioned.includes("content/lessons/a.json")) throw new Error("an HTML comment counted as disclosure");
    },
  );

  caseOf(
    "unrelated-glob-covers-nothing",
    "coverage",
    "a glob naming an area the change never touches must not pass the change",
    ["content/lessons/a.json"],
    "`docs/**` — the contributor guide needed a section on lesson file layout.",
    "fail",
  );

  caseOf(
    "empty-body-is-not-a-description",
    "coverage",
    "a pull request with no body describes nothing and must fail",
    ["scripts/a.mjs"],
    "   \n\n",
    "fail",
    (r) => {
      if (!r.problems.some((p) => p.kind === "empty-body")) throw new Error("empty body did not report empty-body");
    },
  );

  caseOf(
    "empty-file-list-is-a-configuration-error",
    "harness",
    "an empty changed-file list must be reported, not silently passed",
    [],
    "`scripts/a.mjs` — changed, and this sentence exists so the area claim is satisfied too.",
    "fail",
    (r) => {
      if (!r.problems.some((p) => p.kind === "no-changed-files")) throw new Error("empty file list passed");
    },
  );

  // --- B. Not a rubber stamp ------------------------------------------------

  caseOf(
    "rubber-stamp-listing-every-path",
    "prose-claim",
    "a body that lists all 26 paths and explains none of them must still fail (this is the PR #19 body a coverage check alone would accept)",
    max69Files(),
    ["# What this changes", "", ...max69Files().map((p) => `- \`${p}\``)].join("\n"),
    "fail",
    (r) => {
      if (r.unmentioned.length) throw new Error("the listing did not cover the paths, so this row is not testing rule 2");
      if (r.missingClaims.length !== 3) throw new Error(`missingClaims was ${JSON.stringify(r.missingClaims)}`);
    },
  );

  caseOf(
    "pasted-file-listing-is-not-a-claim",
    "prose-claim",
    "a fenced `git diff --stat` dump names the files and explains nothing",
    max69Files(),
    ["```", " Dockerfile                 |  4 +-", " scripts/copy-scripts.sh    | 88 +++++", "```"].join("\n"),
    "fail",
    (r) => {
      if (!r.missingClaims.includes("Dockerfile")) throw new Error("a fenced listing counted as a claim");
    },
  );

  caseOf(
    "wildcard-everything-is-not-a-claim",
    "prose-claim",
    "a body that claims `**` covers every path and still owes an explanation for each area",
    ["scripts/a.mjs", "content/lessons/a.json"],
    "`**` — everything.",
    "fail",
  );

  caseOf(
    "one-claimed-area-leaves-the-others-unclaimed",
    "prose-claim",
    "a claim for one area must not silently claim the next",
    ["scripts/a.mjs", "content/lessons/a.json"],
    [
      "`scripts/a.mjs` — added a helper the lesson validator calls, so lesson authoring gets a",
      "clearer error message than the stack trace it used to produce.",
    ].join("\n"),
    "fail",
    (r) => {
      if (JSON.stringify(r.missingClaims) !== JSON.stringify(["content"])) {
        throw new Error(`missingClaims was ${JSON.stringify(r.missingClaims)}`);
      }
    },
  );

  caseOf(
    "claim-must-be-a-sentence",
    "prose-claim",
    "naming an area in a fragment below the word floor is not a claim",
    ["scripts/a.mjs"],
    ["# Fix", "", "`scripts/a.mjs`: helper."].join("\n"),
    "fail",
  );

  // --- C. Bodies that must pass --------------------------------------------

  caseOf(
    "directory-prefix-covers",
    "coverage",
    "`scripts/` covers everything under scripts/",
    ["scripts/a.mjs", "scripts/lib/b.mjs", "README.md"],
    [
      "`scripts/` — the staging verifier and its source check moved here, so the image provenance",
      "assertion and the script that feeds it stay in one place.",
      "",
      "`README.md` documents the pair and says which of the two CI actually runs on a pull request.",
    ].join("\n"),
    "pass",
    (r) => {
      if (r.unmentioned.length) throw new Error(`rejected a legitimate directory claim: ${r.unmentioned}`);
    },
  );

  caseOf(
    "glob-prefix-covers",
    "coverage",
    "`content/lessons/**` covers files under content/lessons",
    ["content/lessons/a.json", "content/lessons/m5/b.json", "scripts/a.mjs"],
    [
      "`content/lessons/**` — every lesson in the M5 set gained the objective section the figure",
      "build needs, which is why the figure count moved from 150 to 185.",
      "",
      "`scripts/a.mjs` reads the objective block, so it is in the same change as the corpus.",
    ].join("\n"),
    "pass",
  );

  caseOf(
    "blob-url-covers",
    "coverage",
    "a permalink to the file names the file",
    ["scripts/a.mjs", "content/lessons/a.json"],
    [
      "Reworked [scripts/a.mjs](https://github.com/maxcliang-blip/math-training-app-pipeline/blob/main/scripts/a.mjs)",
      "so it stops guessing the content root and asks the manifest where the lessons actually are.",
      "",
      "`content/lessons/` — the manifest is written by the lesson importer, which is why it lands",
      "here rather than in the API layer.",
    ].join("\n"),
    "pass",
  );

  caseOf(
    "dot-slash-and-trailing-slash-normalized",
    "coverage",
    "`./scripts/` and `scripts` are the same claim",
    ["scripts/a.mjs"],
    [
      "`./scripts/` — normalised the pre-push hook install path so it works from a worktree whose",
      "checkout sits one level deeper than the main clone.",
    ].join("\n"),
    "pass",
  );

  caseOf(
    "bare-filename-in-prose-covers",
    "coverage",
    "`the Dockerfile` in running prose names the file",
    ["Dockerfile", "package.json"],
    [
      "The Dockerfile gained a build stage that copies the helper scripts, which is the change",
      "this pull request is about.",
      "",
      "package.json records the new scripts and the gate that runs them.",
    ].join("\n"),
    "pass",
  );

  caseOf(
    "claim-spanning-wrapped-lines-counts",
    "prose-claim",
    "a claim that wraps across two source lines is still one claim",
    ["scripts/a.mjs", "content/lessons/a.json"],
    [
      "`scripts/a.mjs` — the pre-push guard now also refuses a branch carrying another agent's",
      "commit, so the shared-checkout race is caught at push time instead of at review time.",
      "",
      "`content/lessons/` — the corpus is unchanged here; the lesson files are carried so the",
      "guard's own fixture has a real lesson tree to run against.",
    ].join("\n"),
    "pass",
  );

  caseOf(
    "table-row-claim-counts",
    "prose-claim",
    "a table row naming an area with a sentence is a claim",
    ["scripts/a.mjs", "content/lessons/a.json"],
    [
      "| area | what changed and why |",
      "| --- | --- |",
      "| `scripts/a.mjs` | the pre-push guard refuses a branch carrying another agent's commit, so the race is caught at push time |",
      "| `content/lessons/` | carried unchanged, as the fixture tree the guard runs against in its own selftest |",
    ].join("\n"),
    "pass",
  );

  // --- D. Harness invariant -------------------------------------------------

  const partition = evaluate({ body: max69Body, files: max69Files() });
  const partitionOk =
    partition.covered.length + partition.unmentioned.length === partition.changed.length &&
    partition.changed.every((p) => partition.covered.some((c) => c.path === p) !== partition.unmentioned.includes(p)) &&
    partition.covered.every((c) => !partition.unmentioned.includes(c.path));
  rows.push({
    id: "covered-and-unmentioned-partition-changed",
    rule: "harness-invariant",
    severity: "error",
    caught: partitionOk,
    detail: partitionOk
      ? `${partition.covered.length} covered + ${partition.unmentioned.length} unmentioned = ${partition.changed.length} changed, disjoint`
      : "covered and unmentioned do not partition the changed-file list, so the report under-counts its own misses",
  });
  if (!partitionOk) missed.push("covered-and-unmentioned-partition-changed");

  const baseline = evaluate({
    body: [
      "`scripts/check-pr-body-coverage.mjs` — the check itself, with a selftest that requires it to",
      "reject a body omitting files that really changed and a body listing them with no explanation.",
      "",
      "`.github/workflows/ci.yml` — a job that runs that selftest and then runs the check against",
      "the pull request's own body and changed-file list on every pull request event.",
      "",
      "`package.json` — scripts for both invocations, matching the names the existing gates use.",
      "",
      "`README.md` — the new gate is documented next to the push guard, including what it does not",
      "catch, so the next reader does not assume a reviewer is no longer needed.",
    ].join("\n"),
    files: [
      ".github/workflows/ci.yml",
      "README.md",
      "package.json",
      "scripts/check-pr-body-coverage.mjs",
    ],
  });
  rows.push({
    id: "baseline-well-written-body-passes",
    rule: "harness-invariant",
    severity: "error",
    caught: baseline.ok,
    detail: baseline.ok
      ? "a body that names every path and claims every area passes, so the gate is not unsatisfiable"
      : `rejected a body that does account for the change: unmentioned=${JSON.stringify(baseline.unmentioned)} missingClaims=${JSON.stringify(baseline.missingClaims)}`,
  });
  if (!baseline.ok) missed.push("baseline-well-written-body-passes");

  return { rows, missed, baselineClean: baseline.ok };
}

export function reportSelftest(result) {
  const lines = ["check-pr-body-coverage selftest"];
  for (const row of result.rows) {
    lines.push(`  ${row.caught ? "ok  " : "MISS"} ${row.id} [${row.rule}] ${row.detail}`);
  }
  const failed = result.missed.length > 0 || !result.baselineClean;
  lines.push(
    failed
      ? `  ${result.missed.length} case(s) did not behave as required; the gate is not trustworthy.`
      : `  ${result.rows.length} case(s) behaved as required.`,
  );
  return lines;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readInput(path, what) {
  try {
    return readFileSync(resolve(path), "utf8");
  } catch (err) {
    console.error(`check-pr-body-coverage: CONFIG: cannot read ${what} at ${path}: ${err.message}`);
    process.exit(2);
  }
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);

  if (args.includes("--selftest")) {
    const result = selftest();
    console.log(reportSelftest(result).join("\n"));
    const outPath = argValue(args, "--json");
    if (outPath) {
      mkdirSync(dirname(resolve(outPath)), { recursive: true });
      writeFileSync(resolve(outPath), JSON.stringify({ rows: result.rows, missed: result.missed }, null, 2) + "\n");
    }
    process.exit(result.missed.length === 0 && result.baselineClean ? 0 : 1);
  }

  const bodyPath = argValue(args, "--body");
  const filesPath = argValue(args, "--files");
  if (!bodyPath || !filesPath) {
    console.error(
      "check-pr-body-coverage: CONFIG: --body <body.md> and --files <changed.txt> are both required\n" +
        "  Collect them in the workflow with actions/github-script (pulls.get for the body,\n" +
        "  pulls.listFiles for the paths); a `git diff` in a shallow checkout is not the same list.",
    );
    process.exit(2);
  }

  const body = readInput(bodyPath, "the pull request body");
  const files = readInput(filesPath, "the changed-file list")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const result = evaluate({ body, files, title: argValue(args, "--title") || "" });

  console.log(render(result, { prUrl: argValue(args, "--pr") || "" }).join("\n"));
  for (const a of annotations(result)) console.log(a);

  const prUrl = argValue(args, "--pr") || "";
  const mdPath = argValue(args, "--report-md");
  if (mdPath) {
    mkdirSync(dirname(resolve(mdPath)), { recursive: true });
    writeFileSync(resolve(mdPath), `${markdown(result, { prUrl })}\n`);
    console.log(`  comment: ${mdPath}`);
  }

  const outPath = argValue(args, "--json");
  if (outPath) {
    mkdirSync(dirname(resolve(outPath)), { recursive: true });
    writeFileSync(resolve(outPath), JSON.stringify(result, null, 2) + "\n");
    console.log(`  report: ${outPath}`);
  }

  process.exit(result.ok ? 0 : 1);
}