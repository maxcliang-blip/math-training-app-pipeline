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
// MAX-132 adds a fourth condition, because the first three have no notion of work in progress:
//
//   4. the owning issue is still open. A branch whose name carries max-NNN, where MAX-NNN is
//      not done/cancelled, is work somebody is still doing -- not a stranded branch. Without
//      this the gate reported three violations on the dev checkout, all of them MAX-64's live
//      branches, and a gate that cries wolf on the operator's own in-flight work gets muted
//      rather than fixed.
//
// Condition 4 is keyed to the *issue*, not to the branch name. A branch named after an issue
// that does not resolve, or that resolves to nothing the gate was told about, gets no
// exemption: that is the MAX-111 shape, and a naming convention is not evidence. The
// exemption also does not cover a closed-unmerged PR. "No PR ever" and "PR rejected" are
// different facts, and only the first of them is silence.
//
// Where the issue statuses come from, in order:
//
//   --issues-json <path> / LANDED_ISSUES_JSON   a recorded status list, replayable offline
//   PAPERCLIP_API_URL + PAPERCLIP_COMPANY_ID     the issue tracker, when this runs in a
//                                                session that has it
//
// With neither, the gate applies no exemption at all and says so. It does not guess, and it
// does not fail closed to exit 2 either: an unavailable *exemption* is not an unavailable
// finding, so the branches it would have covered are reported exactly as MAX-126 reported
// them. A configured-but-unreadable source is different -- that is a question the gate was
// asked and could not answer, and it exits 2 rather than guessing in the other direction.
//
// Exit codes, and why "cannot ask" is not "pass":
//
//   0  nothing to report
//   1  a violation: gated commits on a branch with no PR          <- the finding
//   2  the question could not be asked: no base ref, no PR source,
//      an unreadable issue-status list, a git failure, or a truncated listing
//
// 2 is deliberately not 0 and deliberately not 1. A gate that cannot reach the PR list has not
// established that a PR exists, and reporting that as a pass is how a branch ends up invisible
// again -- the MAX-111 failure wearing a different hat. Every other gate in scripts/ treats an
// absent toolchain as a failure (see build-figures.mjs exiting 3) for the same reason.
//
// Everything this gate has to say -- the per-branch inventory, the failures, the notes, the
// verdict line -- goes to stdout, including under --quiet. MAX-132 measured the old behaviour:
// every line went to stderr and --quiet suppressed precisely that, so `npm run land:check
// --silent` against a failing gate printed nothing at all and exited 1. That is the same trap
// this gate exists to close, reached from the other side: a gate that fails silently has not
// told anybody it failed. stderr carries only an unexpected crash. --json prints the report and
// nothing else, so it stays parseable.
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
//   --issue-source <s>      none | file | paperclip            (default: a recorded file if one
//                           is named, else the tracker if this session has it, else none)
//   --issues-json <path>    recorded issue statuses; no network. An array of {identifier,
//                           status}, or an object keyed by identifier
//   --repo <owner/name>     repository to ask about            (default: origin's URL)
//   --local-only / --remote-only   narrow which refs are enumerated in the full audit
//   --json                  machine-readable report on stdout
//   --quiet                 only the verdict, the notes and the failures
//
// Environment:
//   GITHUB_TOKEN / GH_TOKEN   used for the PR list when present. Unauthenticated works for a
//                             public repository and costs 60 requests/hour; a token costs
//                             5000/hour and is what Actions provides
//   GITHUB_REPOSITORY         used as the default --repo inside Actions
//   LANDED_BASE_REF            default for --base
//   LANDED_ISSUES_JSON         default for --issues-json

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

// ---------------------------------------------------------------------------
// Issue facts: is the work still in progress?
// ---------------------------------------------------------------------------
//
// The branch name is the only link between a branch and the issue it belongs to, and it is a
// weak one, so it is read strictly. A segment must be `max-NNN` on its own or `max-NNN-...`:
// `gate/max-64-corpus-pins-rebase` yields 64, `max63-m5-l2` yields 63, and `fix/matrix-12-thing`
// yields nothing at all. Anchoring on the segment rather than searching the whole name is what
// keeps a substring from becoming an owning issue -- a wrong match here exempts a branch from
// the gate, so a loose one is a hole, not a convenience.
//
// The key is the digits, not `MAX-64`. Both sides of the lookup normalize the same way, so
// MAX-64, max-64 and MAX64 all find each other and the gate never has to be told this
// repository's prefix.
export const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"];

export function issueIdFromBranchName(name) {
  for (const segment of String(name).split("/")) {
    const m = /^max-?(\d+)(?:[-_].*)?$/i.exec(segment);
    if (m) return m[1];
  }
  return null;
}

export function normalizeIssueKey(identifier) {
  return String(identifier ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function isTerminalIssueStatus(status) {
  return TERMINAL_ISSUE_STATUSES.includes(String(status ?? "").toLowerCase());
}

// Accepts the three shapes a status list arrives in, so a fixture recorded from the tracker
// replays unchanged: an array of {identifier, status}, an array of bare identifiers with a
// separate status map, and an object keyed by identifier. Anything else is an error rather
// than an empty map, because an empty map reads as "no issue owns anything" and would exempt
// nothing while looking as though it had been asked.
export function buildIssueIndex(raws) {
  if (raws && !Array.isArray(raws) && typeof raws === "object" && !("issues" in raws)) {
    // An object keyed by identifier. Only own keys, so `length` and friends cannot become issues.
    const index = new Map();
    for (const [identifier, status] of Object.entries(raws)) {
      if (!/^[a-z]+-\d+$/i.test(identifier)) continue;
      index.set(normalizeIssueKey(identifier), { identifier, status: String(status) });
    }
    if (index.size === 0) throw new Error("no {identifier: status} entries in the issue status list");
    return index;
  }
  const list = Array.isArray(raws) ? raws : raws?.issues;
  if (!Array.isArray(list)) {
    throw new Error("the issue status list is neither an array nor an object of {identifier: status}");
  }
  const index = new Map();
  for (const raw of list) {
    const identifier = raw?.identifier ?? raw?.key ?? raw?.id;
    if (!identifier || raw?.status === undefined) continue;
    index.set(normalizeIssueKey(identifier), { identifier, status: String(raw.status) });
  }
  if (index.size === 0) throw new Error("the issue status list has no entries with an identifier and a status");
  return index;
}

// Verdicts, in the order they are tested. The order is the specification:
//   'landed'        every commit is reachable from the base: nothing is outstanding
//   'doc-branch'    no gated paths in the unlanded commits: this branch cannot ship a content
//                   defect, so demanding a PR of it would be noise
//   'pr-open'       somebody is already reviewing it
//   'pr-merged'     it shipped (usually as a squash, which is why reachability is not enough)
//   'in-flight'     nobody has opened a PR, and the owning issue is still open: work in
//                   progress, not a finding (MAX-132)
//   'violation'     gated commits, unlanded, and no PR
//   'unknown'       the PR question, or the issue-status question, could not be answered --
//                   never a pass
//
// 'in-flight' sits after the PR states on purpose. An open or merged PR is a stronger and more
// specific statement about a branch than its issue's status, so it is reported as such, and the
// exemption is only reached where MAX-126 would have called the branch a violation.
export const VERDICTS = [
  "landed",
  "doc-branch",
  "pr-open",
  "pr-merged",
  "in-flight",
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
    // undefined means "no issue source was configured"; null means "one was configured and it
    // could not be read". Only the second is a question the gate could not answer.
    issueIndex,
  } = branch;

  const issueId = issueIdFromBranchName(name);
  const issue = issueIndex == null ? null : issueIndex.get(normalizeIssueKey(`max-${issueId}`)) ?? null;
  // Why the exemption did not apply, in the operator's words. Each of these is a different
  // situation and they are not interchangeable: a done issue is a finding, an unknown issue is
  // a finding, and a status nobody supplied is a gate running with one of its conditions off.
  const issueClause = issue
    ? ` (${issue.identifier} is ${issue.status})`
    : issueId === null
      ? ""
      : issueIndex === null
        ? `, and the status of the issue it names (MAX-${issueId}) could not be read`
        : `, and no status for MAX-${issueId} was available, so it cannot be called in flight`;

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
      reason: "pr-list-unreadable",
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
      // Not exempt, even when the issue is open. A closed PR without a merge is a decision, not
      // silence: somebody looked at this branch and did not take it. Work that is genuinely
      // still in progress belongs on a branch with an open PR.
      violations.push({
        verdict: "violation",
        reason: "closed-unmerged-pr",
        detail:
          `#${closed.map((p) => p.number).join(", #")} was closed without merging; the gated ` +
          `commits are still unlanded${issue ? ` (${issue.identifier} is ${issue.status})` : ""}`,
      });
    } else if (issueId && issue === null && issueIndex === null) {
      // A configured-but-unreadable issue source, on the one shape where the answer would have
      // changed the verdict. Unknown, never a pass and never a violation: guessing either way is
      // how this gate ends up wrong in the direction nobody notices.
      violations.push({
        verdict: "unknown",
        reason: "issue-status-unreadable",
        detail:
          "no pull request has ever been opened with this branch as its head, and the status of " +
          `the issue it names (MAX-${issueId}) could not be read, so it cannot be called in ` +
          "flight or stranded",
      });
    } else if (issue && !isTerminalIssueStatus(issue.status)) {
      violations.push({
        verdict: "in-flight",
        reason: "issue-open",
        detail: `no pull request yet, and ${issue.identifier} is ${issue.status}: work in progress`,
      });
    } else {
      violations.push({
        verdict: "violation",
        reason: "no-pr",
        detail: "no pull request has ever been opened with this branch as its head" + issueClause,
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
    issueId: issueId ? `MAX-${issueId}` : null,
    issueStatus: issue?.status ?? null,
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
// Issue sources
// ---------------------------------------------------------------------------

// A recorded file wins over the tracker, because a recorded list is how a run is made
// reproducible and how CI asserts the rule without network access. With neither, the answer is
// "none" and the gate applies no exemption -- it says so rather than pretending there is no work
// in progress.
export function chooseIssueSource(explicit, { issuesJson, hasPaperclip }) {
  if (explicit) return explicit;
  if (issuesJson) return "file";
  if (hasPaperclip) return "paperclip";
  return "none";
}

export function readIssueStatusesFromFile(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return buildIssueIndex(parsed);
}

// The tracker this repository's issues actually live in. Only the status and the identifier are
// read, and the answer is refused rather than truncated for the same reason the PR list is: a
// status list that silently lost its `done` entries would exempt branches whose work is finished,
// which is the MAX-111 direction.
const ISSUE_PAGE_SIZE = 500;
const ISSUE_MAX_PAGES = 20;

export async function fetchIssueStatusesFromPaperclip({ baseUrl, companyId, token }) {
  const headers = { accept: "application/json", "user-agent": "check-landed-content" };
  if (token) headers.authorization = `Bearer ${token}`;
  const all = [];
  for (let page = 1; page <= ISSUE_MAX_PAGES; page += 1) {
    const url =
      `${String(baseUrl).replace(/\/api\/?$/, "").replace(/\/$/, "")}` +
      `/api/companies/${companyId}/issues?limit=${ISSUE_PAGE_SIZE}&offset=${(page - 1) * ISSUE_PAGE_SIZE}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`the issue tracker returned ${res.status} for ${url}`);
    const items = await res.json();
    const list = Array.isArray(items) ? items : items?.issues;
    if (!Array.isArray(list)) throw new Error(`the issue tracker returned a non-list for ${url}`);
    all.push(...list);
    if (list.length < ISSUE_PAGE_SIZE) return all;
  }
  throw new Error(
    `the issue list is longer than ${ISSUE_MAX_PAGES * ISSUE_PAGE_SIZE} entries; refusing to call ` +
      `anything in flight from a partial status list.`,
  );
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
  return classifyBranch({
    name,
    baseRef: ctx.baseRef,
    unlandedCommits: commits,
    gatedPaths: gated,
    prs,
    local,
    issueIndex: ctx.issueIndex,
  });
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
    issueIndex,
    issueSource = "none",
    quiet = false,
    json = false,
    // Notes the caller collected before the audit ran -- an unreadable PR list, an absent issue
    // source. They are printed with the rest so that --json is the only thing on stdout when
    // --json was asked for, and --quiet is not the same as silent.
    extraNotes = [],
  } = options;

  const notes = [...extraNotes];
  if (!gitLines(["rev-parse", "--verify", `${baseRef}^{commit}`])) {
    return {
      exitCode: 2,
      rows: [],
      notes: [
        `${baseRef} does not resolve to a commit. Fetch it (git fetch origin) or pass --base.`,
      ],
      repo,
      prSource,
      issueSource,
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
      return { exitCode: 2, rows: [], notes: [`no such branch: ${branch}`], repo, prSource, issueSource };
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

  const ctx = { baseRef, prIndex, issueIndex };
  const rows = [];
  for (const target of targets) {
    const row = await auditBranch(target, ctx);
    if (row) rows.push(row);
  }

  const counts = {};
  for (const v of VERDICTS) counts[v] = rows.filter((r) => r.verdict === v).length;
  const failures = rows.filter((r) => r.verdict === "violation");
  const unknowns = rows.filter((r) => r.verdict === "unknown");

  // stdout, always, including under --quiet. MAX-132 measured the old arrangement: the whole
  // report went to stderr and --quiet dropped exactly that, so a failing gate under
  // `npm run land:check --silent` printed nothing and exited 1. Silent is not the same as
  // passing, and a gate whose failure is invisible gets switched off rather than fixed.
  //
  // --json is the one exception: the payload is on stdout and has to stay parseable, and it
  // carries the counts and the exit code that the prose here would have said.
  if (!json) {
    if (!quiet) {
      const width = Math.max(...rows.map((r) => r.branch.length), 4);
      for (const row of rows) {
        if (row.unlandedCount === 0) continue;
        const tag =
          {
            violation: "FAIL ",
            unknown: "ASK  ",
            "in-flight": "wip  ",
            "pr-open": "open ",
            "pr-merged": "landed",
            "doc-branch": "doc  ",
            landed: "same ",
          }[row.verdict] ?? "?????";
        console.log(`${tag}  ${row.branch.padEnd(width)}  ${row.unlandedRange}  ${row.detail}`);
      }
    }
    for (const note of notes) console.log(`note  ${note}`);
    if (repo && prSource && prSource !== "none") {
      console.log(`note  PR list from ${prSource} for ${repo}`);
    }
    if (issueSource && issueSource !== "none") {
      console.log(`note  issue statuses from ${issueSource}`);
    }
    // The verdict. Not conditional on --quiet: a quiet run that prints nothing at all is exactly
    // the silent failure this line exists to prevent.
    console.log(
      `      ${rows.length} branch(es) examined: ${counts["violation"]} violation, ` +
        `${counts.unknown} unanswered, ${counts["in-flight"]} in flight on an open issue, ` +
        `${counts["pr-open"]} with an open PR, ` +
        `${counts["pr-merged"]} merged, ${counts["doc-branch"]} doc/tooling only, ` +
        `${counts.landed} already in ${baseRef}`,
    );
  }

  let exitCode = 0;
  if (failures.length > 0) exitCode = 1;
  else if (unknowns.length > 0) exitCode = 2;

  return { exitCode, rows, failures, unknowns, counts, notes, repo, prSource, issueSource };
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

  // --- the fourth condition: work in progress (MAX-132) --------------------
  //
  // The three cases above are all still true; these pin the exemption to the issue's status
  // rather than to the branch's name, which is the only way the exemption can be safe.

  const openIssue = buildIssueIndex([
    { identifier: "MAX-64", status: "in_review" },
    { identifier: "MAX-111", status: "done" },
    { identifier: "MAX-120", status: "cancelled" },
    { identifier: "MAX-132", status: "in_progress" },
  ]);

  check("gated commits on a branch whose issue is still open is in flight, not a violation", () => {
    // The real shape that made MAX-132 necessary: MAX-64's three live branches, no PR yet,
    // issue in_review. Before the fourth condition this was a violation, on the operator's own
    // work, on every run.
    const row = classifyBranch({
      name: "gate/max-64-corpus-pins-rebase",
      baseRef: "origin/main",
      unlandedCommits: commit("3b90dfb"),
      gatedPaths: ["content/lessons/m1-l1.json", "scripts/preflight-content.mjs"],
      prs: [],
      issueIndex: openIssue,
    });
    return [
      eq(row.verdict, "in-flight", "verdict"),
      eq(row.reason, "issue-open", "reason"),
      eq(row.issueId, "MAX-64", "issue id"),
      eq(row.issueStatus, "in_review", "issue status"),
      row.detail.includes("MAX-64 is in_review") ? null : `detail does not name the issue: ${row.detail}`,
    ];
  });

  check("the same branch is a violation once its issue is done", () => {
    // MAX-111's shape, with the exemption turned off by the status rather than by the name.
    const row = classifyBranch({
      name: "fix/max-111-doubled-backslash-labels",
      baseRef: "origin/main",
      unlandedCommits: commit("3f1c9ab"),
      gatedPaths: ["content/lessons/m1-l3.json"],
      prs: [],
      issueIndex: openIssue,
    });
    return [
      eq(row.verdict, "violation", "verdict"),
      eq(row.reason, "no-pr", "reason"),
      row.detail.includes("MAX-111 is done") ? null : `detail does not name the issue: ${row.detail}`,
    ];
  });

  check("a cancelled issue is not work in progress either", () => {
    const row = classifyBranch({
      name: "fix/max-120-abandoned",
      baseRef: "origin/main",
      unlandedCommits: commit("aaa1111"),
      gatedPaths: ["content/lessons/m1-l1.json"],
      prs: [],
      issueIndex: openIssue,
    });
    return [eq(row.verdict, "violation", "verdict")];
  });

  check("a branch naming an issue the gate was never told about is a violation", () => {
    // The case that matters: max-132-shaped naming with no answer behind it. An exemption
    // granted by the branch name alone would pass MAX-111 with a renamed branch.
    const row = classifyBranch({
      name: "fix/max-999-nobody-heard-of-it",
      baseRef: "origin/main",
      unlandedCommits: commit("bbb2222"),
      gatedPaths: ["content/lessons/m1-l1.json"],
      prs: [],
      issueIndex: openIssue,
    });
    return [eq(row.verdict, "violation", "verdict"), eq(row.reason, "no-pr", "reason")];
  });

  check("a branch naming no issue at all is a violation", () => {
    const row = classifyBranch({
      name: "land/four-families-of-geometry",
      baseRef: "origin/main",
      unlandedCommits: commit("ccc3333"),
      gatedPaths: ["content/lessons/m1-l1.json"],
      prs: [],
      issueIndex: openIssue,
    });
    return [eq(row.verdict, "violation", "verdict"), eq(row.issueId, null, "issue id")];
  });

  check("no issue source at all exempts nothing, and says so in the verdict", () => {
    // What CI gets, where no status list is configured. The gate must behave exactly as MAX-126
    // wrote it rather than inventing exemptions -- and the operator must be able to see that it
    // is running without them.
    const row = classifyBranch({
      name: "gate/max-64-corpus-pins-rebase",
      baseRef: "origin/main",
      unlandedCommits: commit("3b90dfb"),
      gatedPaths: ["content/lessons/m1-l1.json"],
      prs: [],
    });
    return [eq(row.verdict, "violation", "verdict"), eq(row.issueStatus, null, "issue status")];
  });

  check("an unreadable issue list is unknown on exactly the branches it would have changed", () => {
    // issueIndex null is "configured and unreadable". Guessing `violation` here would cry wolf
    // on every in-flight branch; guessing `in-flight` would wave MAX-111 through. Neither is
    // available, so it is exit 2 -- and only for a branch whose name names an issue at all.
    const inFlight = classifyBranch({
      name: "gate/max-64-corpus-pins-rebase",
      baseRef: "origin/main",
      unlandedCommits: commit("3b90dfb"),
      gatedPaths: ["content/lessons/m1-l1.json"],
      prs: [],
      issueIndex: null,
    });
    const noIssue = classifyBranch({
      name: "land/no-issue-here",
      baseRef: "origin/main",
      unlandedCommits: commit("ddd4444"),
      gatedPaths: ["content/lessons/m1-l1.json"],
      prs: [],
      issueIndex: null,
    });
    const openPr = classifyBranch({
      name: "fix/max-64-with-a-pr",
      baseRef: "origin/main",
      unlandedCommits: commit("3b90dfb"),
      gatedPaths: ["content/lessons/m1-l1.json"],
      prs: [{ number: 58, state: "open" }],
      issueIndex: null,
    });
    return [
      eq(inFlight.verdict, "unknown", "verdict"),
      eq(inFlight.reason, "issue-status-unreadable", "reason"),
      eq(noIssue.verdict, "violation", "a branch with no issue cannot be exempted by a status"),
      eq(openPr.verdict, "pr-open", "an open PR needs no issue status"),
    ];
  });

  check("the branch name resolves an issue only on a segment of its own", () => {
    const problems = [];
    const yes = {
      "fix/max-111-doubled-backslash-labels": "111",
      "gate/max-64-corpus-pins-rebase": "64",
      max63: "63",
      "max-103-unlanded": "103",
      "content/MAX-20-m8-l4": "20",
    };
    const no = {
      "fix/matrix-12-thing": null,
      "docs/maximum-2-ideas": null,
      "land/no-issue-here": null,
      "fix/max--12": null,
      "fix/12-max": null,
      "fix/prefix-max-12": null,
      // A directory called max and a segment called 7 is not a name this repository uses, and
      // reading one as an owning issue would be a guess that exempts a branch from the gate.
      "max/7": null,
    };
    for (const [name, expected] of Object.entries(yes)) {
      const got = issueIdFromBranchName(name);
      if (got !== expected) problems.push(`${name}: expected ${expected}, got ${got}`);
    }
    for (const name of Object.keys(no)) {
      const got = issueIdFromBranchName(name);
      if (got !== null) problems.push(`${name}: expected no issue, got ${got}`);
    }
    return problems;
  });

  check("issue keys match however the identifier is spelled", () => {
    // MAX-64, max-64 and MAX64 are one key. If they were not, an exemption would hinge on
    // somebody's capitalisation.
    const index = buildIssueIndex([{ identifier: "MAX-64", status: "in_review" }]);
    return [
      eq(issueIdFromBranchName("gate/max-64-corpus-pins-rebase"), "64", "digits"),
      eq(index.get("max64")?.status, "in_review", "lookup"),
      eq(normalizeIssueKey("Max-64"), "max64", "normalization"),
    ];
  });

  check("the issue status source prefers a recorded file, then the tracker, then none", () => {
    return [
      eq(chooseIssueSource(null, { issuesJson: "p.json", hasPaperclip: true }), "file", "file wins"),
      eq(chooseIssueSource(null, { issuesJson: null, hasPaperclip: true }), "paperclip", "tracker next"),
      eq(chooseIssueSource(null, { issuesJson: null, hasPaperclip: false }), "none", "none last"),
      eq(chooseIssueSource("none", { issuesJson: "p.json", hasPaperclip: true }), "none", "explicit wins"),
    ];
  });

  check("an empty or shapeless status list is an error, not an empty map", () => {
    // buildIssueIndex throws rather than returning a map with nothing in it: an empty map would
    // exempt nothing and read as though the gate had been told the answer.
    const problems = [];
    for (const bad of [[], {}, { issues: [] }, "MAX-64=in_review", null]) {
      try {
        buildIssueIndex(bad);
        problems.push(`expected a throw for ${JSON.stringify(bad)}`);
      } catch {
        // expected
      }
    }
    return problems;
  });

  check("both status list shapes replay to the same verdict", () => {
    // A fixture recorded from the tracker's own list and one hand-written as an object must not
    // disagree about whether work is in flight.
    const fromList = buildIssueIndex([{ identifier: "MAX-64", status: "in_review" }]);
    const fromObject = buildIssueIndex({ "MAX-64": "in_review", "MAX-111": "done" });
    const shape = (index) => ({
      name: "gate/max-64-corpus-pins-rebase",
      baseRef: "origin/main",
      unlandedCommits: commit("3b90dfb"),
      gatedPaths: ["content/lessons/m1-l1.json"],
      prs: [],
      issueIndex: index,
    });
    return [
      eq(classifyBranch(shape(fromList)).verdict, "in-flight", "list shape"),
      eq(classifyBranch(shape(fromObject)).verdict, "in-flight", "object shape"),
    ];
  });

  check("the terminal statuses are the ones that end work, and only those", () => {
    const problems = [];
    for (const s of ["done", "DONE", "cancelled", "Cancelled"]) {
      if (!isTerminalIssueStatus(s)) problems.push(`expected terminal: ${s}`);
    }
    for (const s of ["in_progress", "in_review", "todo", "backlog", "blocked", "", null, undefined]) {
      if (isTerminalIssueStatus(s)) problems.push(`expected in flight: ${s}`);
    }
    return problems;
  });

  check("a closed PR is a violation even on an open issue", () => {
    // "No PR yet" is silence; a closed unmerged PR is somebody declining it. Exempting the
    // second would hide a rejected branch behind an open issue.
    const row = classifyBranch({
      name: "gate/max-64-corpus-pins-rebase",
      baseRef: "origin/main",
      unlandedCommits: commit("3b90dfb"),
      gatedPaths: ["content/lessons/m1-l1.json"],
      prs: [{ number: 61, state: "closed" }],
      issueIndex: openIssue,
    });
    return [eq(row.verdict, "violation", "verdict"), eq(row.reason, "closed-unmerged-pr", "reason")];
  });

  check("an open PR on an open issue is reported as an open PR, not as work in flight", () => {
    const row = classifyBranch({
      name: "gate/max-64-corpus-pins-rebase",
      baseRef: "origin/main",
      unlandedCommits: commit("3b90dfb"),
      gatedPaths: ["content/lessons/m1-l1.json"],
      prs: [{ number: 58, state: "open" }],
      issueIndex: openIssue,
    });
    return [eq(row.verdict, "pr-open", "verdict")];
  });

  check("the in-flight verdict is in the counted set, so the summary line can name it", () => {
    return [
      VERDICTS.includes("in-flight") ? null : "in-flight is missing from VERDICTS",
      eq(VERDICTS.length, new Set(VERDICTS).size, "no duplicate verdicts"),
    ];
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
    issueSource: null,
    issuesJson: null,
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
      case "--issue-source": opts.issueSource = next(); break;
      case "--issues-json": opts.issuesJson = next(); break;
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

Exit: 0 nothing to report · 1 a gated branch with no PR · 2 the question could not be asked

A branch whose issue is still open is work in progress, not a finding. Give the gate the
statuses with --issues-json <path>, or let it read the tracker from PAPERCLIP_API_URL and
PAPERCLIP_COMPANY_ID. Everything this gate prints -- including under --quiet -- is on stdout.`;

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    // stdout, like everything else here: a usage error under `npm run land:check --silent` that
    // prints nothing is the same silent failure as a finding that prints nothing.
    console.log(`check-landed-content: ${err.message}`);
    console.log(HELP);
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  if (opts.selftest) return runSelftest();

  const baseRef = opts.base ?? process.env.LANDED_BASE_REF ?? "origin/main";
  const quiet = opts.quiet;
  const issuesJson = opts.issuesJson ?? process.env.LANDED_ISSUES_JSON ?? null;
  const prelude = [];

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
    prelude.push(`check-landed-content: PR list unavailable: ${err.message}`);
    prIndex = null;
    prSource = "none";
  }

  // The fourth condition's data. undefined = not configured, so no exemption is claimed and the
  // gate says so. null = configured and unreadable, so the branches whose verdict would have
  // depended on it come out `unknown` and the run exits 2 rather than guessing.
  let issueIndex;
  let issueSource = chooseIssueSource(opts.issueSource, {
    issuesJson,
    hasPaperclip: Boolean(process.env.PAPERCLIP_API_URL && process.env.PAPERCLIP_COMPANY_ID),
  });

  if (issueSource === "none") {
    issueIndex = undefined;
    prelude.push(
      "no issue-status source: a branch whose issue is still open is reported as a violation. " +
        "Pass --issues-json <path>, or set PAPERCLIP_API_URL and PAPERCLIP_COMPANY_ID to exempt " +
        "work in progress.",
    );
  } else {
    try {
      let raws;
      if (issueSource === "file") {
        if (!issuesJson) throw new Error("--issue-source file needs --issues-json <path>");
        raws = readIssueStatusesFromFile(issuesJson);
      } else {
        raws = buildIssueIndex(
          await fetchIssueStatusesFromPaperclip({
            baseUrl: process.env.PAPERCLIP_API_URL,
            companyId: process.env.PAPERCLIP_COMPANY_ID,
            token: process.env.PAPERCLIP_API_KEY,
          }),
        );
      }
      issueIndex = raws;
    } catch (err) {
      prelude.push(`issue statuses unavailable: ${err.message}`);
      issueIndex = null;
      issueSource = "none";
    }
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
      issueIndex,
      issueSource,
      quiet,
      json: opts.json,
      extraNotes: prelude,
    });
  } catch (err) {
    // An exception escaping the audit is the one thing that still goes to stderr: it is a crash
    // report for whoever maintains this file, not a verdict about a branch.
    console.error(`check-landed-content: ${err.message}`);
    return 2;
  }

  if (opts.json) {
    console.log(JSON.stringify({
      baseRef,
      repo,
      prSource,
      issueSource,
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
        issueId: r.issueId,
        issueStatus: r.issueStatus,
      })),
    }, null, 2));
  } else {
    // Printed in every mode, --quiet included. The old code printed these to stderr under
    // `if (!quiet)`, which made a failing --quiet run a silent one.
    for (const row of result.failures ?? []) console.log(formatFailure(row));
    for (const row of result.unknowns ?? []) {
      console.log(`ASK   ${row.branch}: ${row.detail}`);
      // The two `unknown` reasons leave a different question unasked, and naming the wrong one
      // sends the reader to look at a list that was read perfectly well.
      console.log(
        row.reason === "issue-status-unreadable"
          ? `      Cannot say whether the issue is still open, so this is not a pass and not a finding.`
          : `      Cannot say whether a pull request exists, so this is not a pass and not a finding.`,
      );
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
