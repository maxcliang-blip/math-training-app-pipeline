#!/usr/bin/env node
// Content landing gate: a branch that carries gated commits and has no pull request.
//
// MAX-126. MAX-111 repaired twelve figures, was marked `done`, and shipped to nobody: the commit
// sat on `fix/max-111-doubled-backslash-labels` with no PR ever opened, so it never reached main.
// Measured on origin/main @ 1179978 afterwards:
//
//     content:check @ 1179978 -> errors 0, warnings 0, advisories 132, exit 0
//
// main was not red. It was blind. Twelve figures drew the wrong glyphs and every gate on main
// passed, because a gate can only catch a defect that reaches the branch it watches.
//
// The other gates in this repository do not close that hole, and none of them can:
//
//   MAX-119's gate (213b83)   catches the defect at authoring time, on the branch that has it.
//   MAX-64's PR #21           asserts a `done` content issue is reachable from main, per issue.
//   this gate                 catches the branch that never gets a PR at all.
//
// So this is upstream of the rest of the suite, and the hole does not get smaller as the suite
// grows (39 families and counting). It fails when all three of these hold:
//
//   1. the branch carries commits that touch gated paths (content/**, lib/**, scripts/**)
//   2. those commits are not reachable from the base (origin/main)
//   3. no open or merged pull request has that branch as its head
//
// Condition 3 says "open or merged" on purpose. This repository squash-merges, so a merged
// branch's commits are usually *not* ancestors of main and condition 2 is false for work that
// demonstrably shipped. Judging on reachability alone would fail every squash-merged branch in
// the repository, which is the fastest way to get a gate switched off.
//
// Exit codes, and why "cannot ask" is not "pass":
//
//   0  nothing to report
//   1  a violation: gated commits on a branch with no PR          <- the finding
//   2  the question could not be asked: no base ref, no PR source,
//      a git failure, or a truncated PR listing
//
// 2 is deliberately not 0 and deliberately not 1. A gate that cannot reach the PR list has not
// established that a PR exists, and reporting that as a pass is how a branch ends up invisible
// again -- the MAX-111 failure wearing a different hat. Every other gate in scripts/ treats an
// absent toolchain as a failure (see build-figures.mjs exiting 3) for the same reason.
//
// This is deliberately NOT folded into preflight-content.mjs. That script is the author-side
// reference implementation and is documented as runnable with no app and no repository; a check
// that needs git, a remote and a PR list cannot live there. It is a sibling under scripts/, wired
// into the same package.json and CI, and cross-referenced from that file's header.
//
// Usage:
//   node scripts/check-landed-content.mjs                      audit every branch (local + origin)
//   node scripts/check-landed-content.mjs --branch <name>      audit one branch (the push check)
//   node scripts/check-landed-content.mjs --selftest           prove each rule can still fail
//
// Options:
//   --base <ref>            base to measure against           (default: origin/main)
//   --pr-source <s>         gh | api | file                   (default: gh if on PATH, else api)
//   --pr-json <path>        recorded PR list; no network at all. Accepts either the `gh pr list
//                           --json` shape or the REST /pulls shape, so a fixture recorded from
//                           either source can be replayed
//   --repo <owner/name>     repository to ask about            (default: origin's URL)
//   --local-only / --remote-only   narrow which refs are enumerated in the full audit
//   --json                  machine-readable report on stdout
//   --quiet                 only the verdict and the failures
//
// Environment:
//   GITHUB_TOKEN / GH_TOKEN   used for the PR list when present. Unauthenticated works for a
//                             public repository and costs 60 requests/hour; a token costs
//                             5000/hour and is what Actions provides
//   GITHUB_REPOSITORY         used as the default --repo inside Actions

import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// What counts as gated
// ---------------------------------------------------------------------------
//
// The question this gate answers is "can a defect reach a learner without anybody seeing it",
// so the path set is the set of files whose change can make a gate pass or lie:
//
//   content/**  the corpus a learner is served
//   lib/**      figure-contract.mjs, which every content gate imports. MAX-64 landed a change
//               here and it is a gate input exactly as much as a check script is
//   scripts/**  the gates themselves. Editing a gate on a branch nobody reviews is how a
//               repository ends up green by construction, so these are gated too -- and this
//               file is itself under scripts/, which means the gate gates its own weakening.
//
// Not gated: README, docs, Dockerfile, web/**, api/**, package.json, CI config. A branch that
// only touches those is a doc or tooling branch and passes with no PR -- false positives on
// that class are what gets a gate muted. Widening the set is one edit to GATED_PREFIXES below.
export const GATED_PREFIXES = ["content/", "lib/", "scripts/"];

export function isGatedPath(path) {
  const p = String(path).replace(/^\.\//, "");
  return GATED_PREFIXES.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Decision layer: pure, no git, no network. This is what --selftest drives.
// ---------------------------------------------------------------------------

// A PR is "open" if GitHub says open; "merged" if it has a merge commit date; "closed"
// otherwise. A closed PR with no merge is a rejected or abandoned branch, which is a violation
// under exactly the same reasoning as never having opened one -- the work is not on main and
// nothing is pending.
export function prState(pr) {
  if (pr.mergedAt) return "merged";
  if (pr.merged_at) return "merged";
  // Case-insensitive on purpose: `gh pr list --json state` returns OPEN/CLOSED/MERGED and the
  // REST API returns open/closed, and a gate that only understood one spelling would read every
  // gh-reported open PR as a closed one -- i.e. as a violation, on every PR, forever.
  const state = String(pr.state ?? "").toLowerCase();
  if (state === "merged") return "merged";
  if (state === "open") return "open";
  return "closed";
}

// Both the `gh pr list --json` shape and the REST /pulls shape normalize to one record, so a
// fixture recorded from either source replays identically and a change in one client cannot
// quietly change the verdict.
export function normalizePr(raw) {
  return {
    number: raw.number ?? null,
    state: prState(raw),
    head: raw.headRefName ?? raw.head?.ref ?? null,
    base: raw.baseRefName ?? raw.base?.ref ?? null,
    url: raw.url ?? raw.html_url ?? null,
    title: raw.title ?? null,
  };
}

export function buildPrIndex(raws) {
  const index = new Map();
  for (const raw of raws) {
    const pr = normalizePr(raw);
    if (!pr.head) continue;
    if (!index.has(pr.head)) index.set(pr.head, []);
    index.get(pr.head).push(pr);
  }
  return index;
}

// Verdicts, in the order they are tested. The order is the specification:
//   'landed'        every commit is reachable from the base: nothing is outstanding
//   'doc-branch'    no gated paths in the unlanded commits: this branch cannot ship a content
//                   defect, so demanding a PR of it would be noise
//   'pr-open'       somebody is already reviewing it
//   'pr-merged'     it shipped (usually as a squash, which is why reachability is not enough)
//   'violation'     gated commits, unlanded, and no PR
//   'unknown'       the PR question could not be answered -- never a pass
export const VERDICTS = [
  "landed",
  "doc-branch",
  "pr-open",
  "pr-merged",
  "violation",
  "unknown",
];

export function classifyBranch(branch) {
  const {
    name,
    baseRef,
    unlandedCommits = [],
    gatedPaths = [],
    prs = null, // null means "could not be asked", not "none"
    local = false,
  } = branch;

  const violations = [];
  if (unlandedCommits.length === 0) {
    violations.push({
      verdict: "landed",
      detail: `no commits outside ${baseRef}; the branch adds nothing that is still missing`,
    });
  } else if (gatedPaths.length === 0) {
    violations.push({
      verdict: "doc-branch",
      detail: `${unlandedCommits.length} commit(s) outside ${baseRef}, none touching ${GATED_PREFIXES.join(", ")}`,
    });
  } else if (prs === null) {
    violations.push({
      verdict: "unknown",
      detail: `${unlandedCommits.length} commit(s) outside ${baseRef} touch ${gatedPaths.length} gated path(s), and the PR list could not be read`,
    });
  } else {
    // Normalized here rather than trusting the caller. The PR records arrive from two different
    // clients with two different state spellings, and the only place that knows about both is
    // normalizePr; a caller that remembered to do it and a caller that forgot would otherwise
    // get different verdicts for the same repository.
    const list = prs.map(normalizePr);
    const open = list.filter((p) => p.state === "open");
    const merged = list.filter((p) => p.state === "merged");
    const closed = list.filter((p) => p.state === "closed");
    if (open.length > 0) {
      violations.push({
        verdict: "pr-open",
        detail: `#${open.map((p) => p.number).join(", #")} is open`,
      });
    } else if (merged.length > 0) {
      violations.push({
        verdict: "pr-merged",
        detail: `#${merged.map((p) => p.number).join(", #")} is merged`,
      });
    } else if (closed.length > 0) {
      violations.push({
        verdict: "violation",
        reason: "closed-unmerged-pr",
        detail: `#${closed.map((p) => p.number).join(", #")} was closed without merging; the gated commits are still unlanded`,
      });
    } else {
      violations.push({
        verdict: "violation",
        reason: "no-pr",
        detail: "no pull request has ever been opened with this branch as its head",
      });
    }
  }

  const verdict = violations[0];
  return {
    branch: name,
    baseRef,
    local,
    verdict: verdict.verdict,
    reason: verdict.reason ?? verdict.verdict,
    detail: verdict.detail,
    unlandedCount: unlandedCommits.length,
    unlandedRange: `${baseRef}..${name}`,
    unlandedCommits,
    gatedPaths,
    prs: prs ?? null,
  };
}

// The line a person reads. It names the branch and the range, because "one branch is
// unlanded" out of forty is not a finding -- "<branch>, commits <base>..<branch>" is.
export function formatFailure(row) {
  const commits = row.unlandedCommits
    .map((c) => `    ${c.sha}  ${c.subject}`)
    .join("\n");
  const paths = row.gatedPaths.slice(0, 10).join("\n");
  const more = row.gatedPaths.length > 10 ? `\n    ... and ${row.gatedPaths.length - 10} more` : "";
  const scope = row.local ? " (local only -- not pushed)" : "";
  return [
    `FAIL  ${row.branch}${scope}: ${row.detail}`,
    `      unlanded commits: ${row.unlandedRange}  (${row.unlandedCount})`,
    commits,
    `      gated paths:`,
    paths + more,
    `      open a pull request for ${row.branch} -> ${row.baseRef.replace(/^origin\//, "")},`,
    `      or land the commits on ${row.baseRef}, or delete the branch if its work shipped another way.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Git facts
// ---------------------------------------------------------------------------

function git(args, { allowFail = false } = {}) {
  try {
    // stderr is piped rather than inherited: a failed `git rev-parse` of a ref that does not
    // exist is an expected answer here (readCommits returns null for it), and its diagnostics
    // must not land in the middle of a gate's output.
    return execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(" ")} failed: ${String(err.stderr || err.message).trim()}`);
  }
}

function gitLines(args) {
  const out = git(args, { allowFail: true });
  if (out === null) return null;
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

export function parseCommits(lines) {
  if (!lines) return null;
  return lines.map((line) => {
    const m = /^([0-9a-f]{7,40})\s+(.*)$/.exec(line);
    return { sha: m ? m[1] : line, subject: m ? m[2] : "" };
  });
}

export function readCommits(baseRef, branchRef) {
  // `--format=%h %s` with an explicit range: no separator commits, no merge noise, oldest
  // first, so the printed range reads the way it was written.
  const lines = gitLines(["log", "--reverse", "--format=%h %s", `${baseRef}..${branchRef}`]);
  return parseCommits(lines);
}

export function readGatedPaths(baseRef, branchRef) {
  // Three dots: the diff against the merge base, which is "what this branch changes" even when
  // the base has moved on since. Two dots would compare against the base tip and report files
  // main changed after the branch point as if this branch had changed them.
  const lines = gitLines(["diff", "--name-only", `${baseRef}...${branchRef}`]);
  return lines === null ? null : lines.filter(isGatedPath);
}

export function listRefs({ includeLocal = true, includeRemote = true } = {}) {
  const refs = [];
  if (includeRemote) {
    // `%(symref)` is how origin/HEAD is recognised. Filtering on the name does not work: git's
    // short-name rules render refs/remotes/origin/HEAD as plain `origin`, and a repository that
    // audited a symref would report main itself as an unlanded branch with no PR, on every run,
    // forever -- a false positive in the exact spot the operator looks first.
    const rows = gitSymrefRows("refs/remotes/origin");
    for (const { ref, symref } of rows) {
      if (symref) continue;
      if (ref === "origin/HEAD") continue;
      refs.push({ name: ref.replace(/^origin\//, ""), ref, local: false });
    }
  }
  if (includeLocal) {
    for (const { ref } of gitSymrefRows("refs/heads")) {
      refs.push({ name: ref, ref, local: true });
    }
  }
  return refs;
}

function gitSymrefRows(namespace) {
  const lines = gitLines(["for-each-ref", "--format=%(refname:short) %(symref)", namespace]);
  if (lines === null) throw new Error(`cannot enumerate ${namespace}`);
  return lines.map((line) => {
    const at = line.lastIndexOf(" ");
    // The symref target is empty for a real branch, so a line with no space is a real branch
    // whose name contains no space -- which cannot happen, but is handled rather than truncated.
    return at === -1 ? { ref: line, symref: "" } : { ref: line.slice(0, at), symref: line.slice(at + 1) };
  });
}

export function defaultRepo() {
  const url = gitLines(["remote", "get-url", "origin"]);
  if (!url || url.length === 0) return null;
  const m = /github\.com[:/]+([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url[0]);
  return m ? `${m[1]}/${m[2]}` : null;
}

// ---------------------------------------------------------------------------
// PR facts
// ---------------------------------------------------------------------------

// gh first when it is on PATH: its JSON is a stable shape and it needs no URL construction.
// The REST fallback exists because gh is not installed on every clone in this fleet, and a gate
// that only runs where gh happens to be is a gate that runs in CI and nowhere else.
export function choosePrSource(explicit, { prJson, hasGh, hasToken }) {
  if (explicit) return explicit;
  if (prJson) return "file";
  if (hasGh) return "gh";
  if (hasToken) return "api";
  // No gh and no token still gets an attempt: this repository is public, and an unauthenticated
  // read works. It is rate limited to 60/hour, which the output says out loud.
  return "api";
}

export async function fetchPrsFromGh(repo) {
  const out = execFileSync(
    "gh",
    ["pr", "list", "--repo", repo, "--state", "all", "--limit", "1000",
      "--json", "number,state,mergedAt,headRefName,baseRefName,url,title"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out);
  if (!Array.isArray(parsed)) throw new Error("gh pr list did not return an array");
  return parsed;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 25;

export async function fetchPrsFromApi(repo, { token, baseUrl = "https://api.github.com" } = {}) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "check-landed-content",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `${baseUrl}/repos/${repo}/pulls?state=all&per_page=${PAGE_SIZE}&page=${page}`;
    const res = await fetch(url, { headers });
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      throw new Error(
        `GitHub rate limit refused the PR list (${res.status}, ${remaining ?? "?"} requests left).` +
          ` Set GITHUB_TOKEN for 5000/hour, or record a list with --pr-json.`,
      );
    }
    if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${url}`);
    const page_items = await res.json();
    if (!Array.isArray(page_items)) throw new Error(`GitHub returned a non-array for ${url}`);
    all.push(...page_items);
    if (page_items.length < PAGE_SIZE) return all;
  }
  // Truncation is not a pass. A repository with more than MAX_PAGES * PAGE_SIZE pull requests
  // would report "no PR" for branches whose PR sits on a page this loop never read.
  throw new Error(
    `the PR list is longer than ${MAX_PAGES * PAGE_SIZE} entries; refusing to report "no PR" from a partial list.`,
  );
}

export function readPrsFromFile(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${path} is not a JSON array of pull requests`);
  return parsed;
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

export async function auditBranch({ name, ref, local }, ctx) {
  const commits = readCommits(ctx.baseRef, ref);
  if (commits === null) return null; // ref vanished between enumeration and read
  const gated = readGatedPaths(ctx.baseRef, ref);
  if (gated === null) return null;
  const prs = ctx.prIndex === null ? null : ctx.prIndex.get(name) ?? [];
  return classifyBranch({ name, baseRef: ctx.baseRef, unlandedCommits: commits, gatedPaths: gated, prs, local });
}

export async function runAudit(options) {
  const {
    baseRef,
    branch,
    includeLocal,
    includeRemote,
    prIndex,
    repo,
    prSource,
    prJson,
    quiet = false,
  } = options;

  const notes = [];
  if (!gitLines(["rev-parse", "--verify", `${baseRef}^{commit}`])) {
    return {
      exitCode: 2,
      rows: [],
      notes: [
        `${baseRef} does not resolve to a commit. Fetch it (git fetch origin) or pass --base.`,
      ],
      repo,
      prSource,
    };
  }

  let targets;
  if (branch) {
    // Prefer the remote ref: in Actions the pushed branch is a local branch pointing at the
    // same commit, but a local branch that was pushed and then amended is not the same state.
    const remoteRef = `origin/${branch}`;
    const hasRemote = gitLines(["rev-parse", "--verify", `${remoteRef}^{commit}`]) !== null;
    const hasLocal = gitLines(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]) !== null;
    if (!hasRemote && !hasLocal) {
      return { exitCode: 2, rows: [], notes: [`no such branch: ${branch}`], repo, prSource };
    }
    targets = [
      hasRemote
        ? { name: branch, ref: remoteRef, local: false }
        : { name: branch, ref: `refs/heads/${branch}`, local: true },
    ];
    if (!hasRemote && hasLocal) {
      notes.push(`${branch} exists only locally; its commits are not on the remote at all.`);
    }
  } else {
    targets = listRefs({ includeLocal, includeRemote });
    // The base itself is not a branch carrying unlanded work; measuring main against main prints
    // an empty inventory and reads like the gate found nothing when it never looked.
    targets = targets.filter((t) => t.name !== baseRef && t.name !== baseRef.replace(/^origin\//, ""));
  }

  const ctx = { baseRef, prIndex };
  const rows = [];
  for (const target of targets) {
    const row = await auditBranch(target, ctx);
    if (row) rows.push(row);
  }

  const counts = {};
  for (const v of VERDICTS) counts[v] = rows.filter((r) => r.verdict === v).length;
  const failures = rows.filter((r) => r.verdict === "violation");
  const unknowns = rows.filter((r) => r.verdict === "unknown");

  if (!quiet) {
    const width = Math.max(...rows.map((r) => r.branch.length), 4);
    for (const row of rows) {
      if (row.unlandedCount === 0) continue;
      const tag =
        {
          violation: "FAIL ",
          unknown: "ASK  ",
          "pr-open": "open ",
          "pr-merged": "landed",
          "doc-branch": "doc  ",
          landed: "same ",
        }[row.verdict] ?? "?????";
      console.log(`${tag}  ${row.branch.padEnd(width)}  ${row.unlandedRange}  ${row.detail}`);
    }
    for (const note of notes) console.log(`note  ${note}`);
    if (repo) console.log(`note  PR list from ${prSource} for ${repo}`);
    console.log(
      `      ${rows.length} branch(es) examined: ${counts["violation"]} violation, ` +
        `${counts.unknown} unanswered, ${counts["pr-open"]} with an open PR, ` +
        `${counts["pr-merged"]} merged, ${counts["doc-branch"]} doc/tooling only, ` +
        `${counts.landed} already in ${baseRef}`,
    );
  }

  let exitCode = 0;
  if (failures.length > 0) exitCode = 1;
  else if (unknowns.length > 0) exitCode = 2;

  return { exitCode, rows, failures, unknowns, counts, notes, repo, prSource };
}

// ---------------------------------------------------------------------------
// Selftest
// ---------------------------------------------------------------------------
//
// The rule a selftest has to protect is the one above: a check nobody can make fail is
// indistinguishable from a check that does not work. Every case here is a real branch shape,
// and each asserts the verdict AND, for the failing ones, that the message names the branch and
// the unlanded range -- a finding that does not say where it is has to be re-derived by hand.

export function selftest() {
  const results = [];
  const check = (name, fn) => {
    try {
      const problems = (fn() ?? []).filter(Boolean);
      results.push({ name, ok: problems.length === 0, problems });
    } catch (err) {
      results.push({ name, ok: false, problems: [`threw: ${err.message}`] });
    }
  };
  const eq = (actual, expected, what) =>
    actual === expected ? null : `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  const commit = (sha) => [{ sha, subject: `work ${sha}` }];

  // --- the three acceptance cases, plus the adjacent shapes ---------------

  check("content commits and no PR at all is a violation", () => {
    const row = classifyBranch({
      name: "fix/max-111-doubled-backslash-labels",
      baseRef: "origin/main",
      unlandedCommits: commit("3f1c9ab"),
      gatedPaths: ["content/lessons/m1-l3.json"],
      prs: [],
    });
    return [
      eq(row.verdict, "violation", "verdict"),
      eq(row.reason, "no-pr", "reason"),
      eq(row.unlandedRange, "origin/main..fix/max-111-doubled-backslash-labels", "range"),
    ];
  });

  check("content commits and an open PR passes", () => {
    const row = classifyBranch({
      name: "fix/max-119-label-doubled-backslash",
      baseRef: "origin/main",
      unlandedCommits: commit("abc1234"),
      gatedPaths: ["scripts/check-content-math.mjs"],
      prs: [{ number: 55, state: "open" }],
    });
    return [eq(row.verdict, "pr-open", "verdict")];
  });

  check("content commits and a merged PR passes (squash merges are not ancestors)", () => {
    // The real shape: PR #56 was squash-merged, so land/max-111's commit is not reachable from
    // main. Judging on reachability alone would fail this branch forever.
    const row = classifyBranch({
      name: "land/max-111-doubled-backslash-labels",
      baseRef: "origin/main",
      unlandedCommits: commit("deadbee"),
      gatedPaths: ["content/lessons/m1-l3.json"],
      prs: [{ number: 56, state: "closed", merged_at: "2026-10-03T15:00:00Z" }],
    });
    return [eq(row.verdict, "pr-merged", "verdict")];
  });

  check("a closed, unmerged PR is still a violation", () => {
    const row = classifyBranch({
      name: "fix/max-99-rejected",
      baseRef: "origin/main",
      unlandedCommits: commit("aaa1111"),
      gatedPaths: ["content/lessons/m3-l1.json"],
      prs: [{ number: 60, state: "closed" }],
    });
    return [eq(row.verdict, "violation", "verdict"), eq(row.reason, "closed-unmerged-pr", "reason")];
  });

  check("a doc/tooling branch with no PR passes", () => {
    const row = classifyBranch({
      name: "docs/readme-wording",
      baseRef: "origin/main",
      unlandedCommits: commit("bbb2222"),
      gatedPaths: [],
      prs: [],
    });
    return [eq(row.verdict, "doc-branch", "verdict")];
  });

  check("a branch already contained in the base passes with no PR", () => {
    const row = classifyBranch({
      name: "fix/max-64-merged-by-merge-commit",
      baseRef: "origin/main",
      unlandedCommits: [],
      gatedPaths: ["content/lessons/m1-l3.json"],
      prs: [],
    });
    return [eq(row.verdict, "landed", "verdict")];
  });

  // --- the exit-code-2 cases: an unanswerable question is not a pass ------

  check("an unreadable PR list is unknown, never ok", () => {
    const row = classifyBranch({
      name: "fix/max-126-unknown",
      baseRef: "origin/main",
      unlandedCommits: commit("ccc3333"),
      gatedPaths: ["content/lessons/m1-l3.json"],
      prs: null,
    });
    return [eq(row.verdict, "unknown", "verdict"), eq(row.unlandedCount, 1, "commit count")];
  });

  check("an unanswerable PR list on a doc branch still needs no PR", () => {
    // Ordering matters and this pins it: with no gated paths there is nothing a PR could be
    // needed for, so the gate must not turn a missing PR list into a red run.
    const row = classifyBranch({
      name: "docs/readme-wording",
      baseRef: "origin/main",
      unlandedCommits: commit("ddd4444"),
      gatedPaths: [],
      prs: null,
    });
    return [eq(row.verdict, "doc-branch", "verdict")];
  });

  check("an unreadable PR list on a landed branch is still ok", () => {
    const row = classifyBranch({
      name: "fix/max-64-landed",
      baseRef: "origin/main",
      unlandedCommits: [],
      gatedPaths: [],
      prs: null,
    });
    return [eq(row.verdict, "landed", "verdict")];
  });

  // --- normalization: two clients, one verdict ---------------------------

  check("the gh shape and the REST shape normalize identically", () => {
    const gh = buildPrIndex([
      { number: 55, state: "CLOSED", mergedAt: "2026-10-03T15:00:00Z", headRefName: "fix/a", baseRefName: "main", url: "u", title: "t" },
      { number: 56, state: "OPEN", mergedAt: null, headRefName: "land/b", baseRefName: "main", url: "u2", title: "t2" },
    ]);
    const rest = buildPrIndex([
      { number: 55, state: "closed", merged_at: "2026-10-03T15:00:00Z", head: { ref: "fix/a", base: { ref: "main" } }, html_url: "u", title: "t" },
      { number: 56, state: "open", merged_at: null, head: { ref: "land/b", base: { ref: "main" } }, html_url: "u2", title: "t2" },
    ]);
    return [
      eq(gh.get("fix/a")[0].state, "merged", "gh merged"),
      eq(rest.get("fix/a")[0].state, "merged", "rest merged"),
      eq(gh.get("land/b")[0].state, "open", "gh open"),
      eq(rest.get("land/b")[0].state, "open", "rest open"),
      eq(gh.get("fix/a")[0].url, rest.get("fix/a")[0].url, "url"),
    ];
  });

  check("a closed PR with no merge date is closed, not merged", () => {
    // GitHub reports a squash-merged PR as state=closed; only merged_at separates it from a
    // rejected one. Reading state alone would pass every abandoned branch in the repository.
    const index = buildPrIndex([{ number: 7, state: "closed", merged_at: null, head: { ref: "fix/x" } }]);
    return [eq(index.get("fix/x")[0].state, "closed", "state")];
  });

  check("a PR with no head ref is dropped instead of matching nothing", () => {
    const index = buildPrIndex([{ number: 8, state: "open", headRefName: null, head: {} }]);
    return [eq(index.size, 0, "index size")];
  });

  // --- the path set ------------------------------------------------------

  check("the gated path set covers content, the contract and the gates", () => {
    const problems = [];
    const yes = ["content/lessons/m1-l3.json", "content/modules.json", "lib/figure-contract.mjs",
      "scripts/check-content-math.mjs", "scripts/check-landed-content.mjs", "scripts/agent-worktree.sh",
      "scripts/lib/asy-container.sh", "scripts/verify-m8-answers.py", "content/exercises/m7-l1-m1.json"];
    const no = ["README.md", "Dockerfile", "package.json", "package-lock.json", "web/src/App.tsx",
      "api/src/server.js", "deploy/README.md", ".github/workflows/ci.yml", "node_modules/x/index.js"];
    for (const p of yes) if (!isGatedPath(p)) problems.push(`expected gated: ${p}`);
    for (const p of no) if (isGatedPath(p)) problems.push(`expected not gated: ${p}`);
    return problems;
  });

  check("a leading ./ does not smuggle a gated path past the matcher", () => {
    return [isGatedPath("./content/lessons/m1-l3.json") ? null : "expected gated: ./content/..."];
  });

  // --- the failure text --------------------------------------------------

  check("the failure names the branch, the range and the gated paths", () => {
    const row = classifyBranch({
      name: "fix/max-111-doubled-backslash-labels",
      baseRef: "origin/main",
      unlandedCommits: [
        { sha: "3f1c9ab", subject: "De-double the backslashes in 12 figure labels" },
        { sha: "9d0e5c2", subject: "And the figure ids" },
      ],
      gatedPaths: ["content/lessons/m1-l3.json"],
      prs: [],
    });
    const text = formatFailure(row);
    const problems = [];
    if (!text.includes("fix/max-111-doubled-backslash-labels")) problems.push("does not name the branch");
    if (!text.includes("origin/main..fix/max-111-doubled-backslash-labels")) problems.push("does not name the range");
    if (!text.includes("3f1c9ab") || !text.includes("9d0e5c2")) problems.push("does not list the commits");
    if (!text.includes("content/lessons/m1-l3.json")) problems.push("does not name the gated path");
    if (!text.includes("no pull request")) problems.push("does not say what is wrong");
    return problems;
  });

  check("the failure marks a local-only branch as unpushed", () => {
    const row = classifyBranch({
      name: "fix/max-126-local",
      baseRef: "origin/main",
      unlandedCommits: commit("1112223"),
      gatedPaths: ["content/lessons/m1-l3.json"],
      prs: [],
      local: true,
    });
    return [formatFailure(row).includes("not pushed") ? null : "does not say the branch was never pushed"];
  });

  // --- commit parsing ---------------------------------------------------

  check("commit lines parse into sha and subject", () => {
    const parsed = parseCommits(["3f1c9ab De-double the backslashes", "9d0e5c2 subject: with colon"]);
    return [
      eq(parsed[0].sha, "3f1c9ab", "sha"),
      eq(parsed[0].subject, "De-double the backslashes", "subject"),
      eq(parsed[1].subject, "subject: with colon", "subject with a colon"),
    ];
  });

  check("a failed git read is null, not an empty list", () => {
    // An empty list would read as "nothing unlanded" and pass. Null is how the caller tells
    // "the ref is gone" from "the ref is clean".
    return [readCommits("origin/main", "refs/heads/does-not-exist-6f2a") === null ? null : "expected null"];
  });

  check("listRefs never returns the origin symref or a ref named origin", () => {
    // git renders refs/remotes/origin/HEAD as plain `origin`. Included in an audit it would be
    // main measured against main, reported as a branch with unlanded content and no PR.
    let refs;
    try {
      refs = listRefs();
    } catch {
      return null; // not a repository: nothing to prove here
    }
    const problems = [];
    if (refs.some((r) => r.ref === "origin/HEAD" || r.name === "origin/HEAD")) {
      problems.push("origin/HEAD is in the audit set");
    }
    if (refs.some((r) => r.ref === "origin" && !r.local)) {
      problems.push("a ref named 'origin' is in the audit set");
    }
    if (refs.some((r) => !r.name || !r.ref)) problems.push("an unnamed ref is in the audit set");
    return problems;
  });

  // --- the PR source choice --------------------------------------------

  check("the PR source prefers gh, then a token, then the public API", () => {
    return [
      eq(choosePrSource(null, { hasGh: true, hasToken: true }), "gh", "gh wins"),
      eq(choosePrSource(null, { hasGh: false, hasToken: true }), "api", "token"),
      eq(choosePrSource(null, { hasGh: false, hasToken: false }), "api", "public fallback"),
      eq(choosePrSource("gh", { hasGh: false, hasToken: true }), "gh", "explicit wins"),
      eq(choosePrSource(null, { prJson: "p.json", hasGh: true, hasToken: true }), "file", "fixture wins"),
    ];
  });

  return results;
}

function runSelftest() {
  const results = selftest();
  let failed = 0;
  console.log("check-landed-content selftest");
  for (const r of results) {
    if (r.ok) {
      console.log(`  ok    ${r.name}`);
    } else {
      failed += 1;
      console.log(`  FAIL  ${r.name}`);
      for (const p of r.problems) console.log(`          ${p}`);
    }
  }
  console.log(`${results.length - failed}/${results.length} cases`);
  if (failed === 0) {
    console.log(
      "Each case above is a branch shape that occurred in this repository. The violation case is\n" +
        "MAX-111: gated commits, unlanded, no PR. If this file can no longer say that, the gate it\n" +
        "guards has stopped guarding.",
    );
  }
  return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    branch: null,
    base: null,
    repo: null,
    prSource: null,
    prJson: null,
    json: false,
    quiet: false,
    selftest: false,
    includeLocal: true,
    includeRemote: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };
    switch (arg) {
      case "--branch": case "-b": opts.branch = next(); break;
      case "--base": opts.base = next(); break;
      case "--repo": opts.repo = next(); break;
      case "--pr-source": opts.prSource = next(); break;
      case "--pr-json": opts.prJson = next(); break;
      case "--json": opts.json = true; break;
      case "--quiet": opts.quiet = true; break;
      case "--selftest": opts.selftest = true; break;
      case "--local-only": opts.includeRemote = false; break;
      case "--remote-only": opts.includeLocal = false; break;
      case "-h": case "--help": opts.help = true; break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
        opts.branch = arg;
    }
  }
  return opts;
}

const HELP = `Usage:
  node scripts/check-landed-content.mjs                       audit every branch
  node scripts/check-landed-content.mjs --branch <name>       audit one branch (push check)
  node scripts/check-landed-content.mjs --selftest            prove each rule can still fail

Exit: 0 nothing to report · 1 a gated branch with no PR · 2 the question could not be asked`;

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`check-landed-content: ${err.message}`);
    console.error(HELP);
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  if (opts.selftest) return runSelftest();

  const baseRef = opts.base ?? process.env.LANDED_BASE_REF ?? "origin/main";
  const quiet = opts.quiet || opts.json;

  let prIndex = null;
  let repo = opts.repo ?? process.env.GITHUB_REPOSITORY ?? defaultRepo();
  let prSource = opts.prSource ?? choosePrSource(null, {
    prJson: opts.prJson,
    hasGh: Boolean(which("gh")),
    hasToken: Boolean(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN),
  });

  try {
    let raws;
    if (prSource === "file") {
      if (!opts.prJson) throw new Error("--pr-source file needs --pr-json <path>");
      raws = readPrsFromFile(opts.prJson);
    } else if (prSource === "gh") {
      if (!repo) throw new Error("cannot determine the repository; pass --repo owner/name");
      raws = await fetchPrsFromGh(repo);
    } else {
      if (!repo) throw new Error("cannot determine the repository; pass --repo owner/name");
      raws = await fetchPrsFromApi(repo, { token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN });
    }
    prIndex = buildPrIndex(raws);
  } catch (err) {
    // Not a pass and not a violation: the gate could not ask. Exit 2 with the reason, and keep
    // going, so a single-branch push check still reports what it can about branches it can.
    console.error(`check-landed-content: PR list unavailable: ${err.message}`);
    prIndex = null;
    prSource = "none";
  }

  let result;
  try {
    result = await runAudit({
      baseRef,
      branch: opts.branch,
      includeLocal: opts.includeLocal,
      includeRemote: opts.includeRemote,
      prIndex,
      repo,
      prSource,
      prJson: opts.prJson,
      quiet,
    });
  } catch (err) {
    console.error(`check-landed-content: ${err.message}`);
    return 2;
  }

  for (const note of result.notes ?? []) console.error(`check-landed-content: ${note}`);

  if (opts.json) {
    console.log(JSON.stringify({
      baseRef,
      repo,
      prSource,
      exitCode: result.exitCode,
      counts: result.counts ?? null,
      rows: (result.rows ?? []).map((r) => ({
        branch: r.branch,
        verdict: r.verdict,
        reason: r.reason,
        detail: r.detail,
        unlandedRange: r.unlandedRange,
        unlandedCount: r.unlandedCount,
        unlandedCommits: r.unlandedCommits,
        gatedPaths: r.gatedPaths,
        local: r.local,
      })),
    }, null, 2));
  } else if (!quiet) {
    for (const row of result.failures ?? []) console.error(formatFailure(row));
    for (const row of result.unknowns ?? []) {
      console.error(`ASK   ${row.branch}: ${row.detail}`);
      console.error(`      Cannot say whether a pull request exists, so this is not a pass and not a finding.`);
    }
  }

  return result.exitCode;
}

function which(cmd) {
  // Each PATH entry is a chance for the binary; a missing one is normal, so an unreadable
  // directory must not throw on the way to "not installed".
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    try {
      accessSync(`${dir}/${cmd}`, constants.X_OK);
      return `${dir}/${cmd}`;
    } catch {
      continue;
    }
  }
  return null;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`check-landed-content: ${err?.stack ?? err}`);
      process.exit(2);
    },
  );
}

export { HERE };
