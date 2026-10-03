#!/usr/bin/env node
// Delivery-integrity gate: refuse to push commits authored by somebody else.
//
// The incident this exists for (MAX-69): /home/opc/math-training-app was one working
// directory with one .git and several agents in it. On branch `max-61-staging-source`
// Bob staged three files and committed; Carol, mid-flight in the same directory, ran her
// own `git commit` a second later. Her commit landed on his branch. The branch carried
// two commits, the PR said 26 changed files instead of 3, and 22 files of geometry
// content reached main squashed under a commit titled "Copy scripts/ into the image
// build" -- unreviewed, under a stranger's name.
//
// Scoping `git add` does not prevent this. It protects the files you stage, not the
// branch you are standing on, and the checked-out branch is shared mutable state that
// nobody is looking at. The structural fix is one worktree per agent
// (scripts/agent-worktree.sh). This gate is the cheap layer that turns a silent bad
// merge into a failed push, for the window where a shared checkout still exists.
//
// What it checks, in two independent layers:
//
//   1. Authorship. For every ref being pushed, every commit that push would introduce
//      must be authored by the identity configured for this checkout.
//   2. Place (MAX-101). The push must not come from the repository's *primary* working
//      tree -- the shared root -- because layer 1 cannot see there. Identity is a
//      property of the checkout, so in the shared root the author of a commit always
//      matches the configured identity, whoever typed it. The MAX-77 ruling landed as
//      0c0e3f8, authored `Bob <bob@math-training.app>`, pushed clean out of the shared
//      root by an agent who is not Bob.
//
// Layer 1 is the MAX-69 gate and is unchanged. Layer 2 is one more comparison, in the
// same shape, against the same input. Neither layer catches a squash, which rewrites
// authorship to the first commit's author: that is why the PR-body check (item 4 of
// MAX-69) is a separate layer and not optional.
//
// Deliberately NOT a check on `Co-Authored-By:` trailers. Every commit on this board
// carries `Co-Authored-By: Paperclip <noreply@paperclip.ing>`, so treating a trailer as
// an author would fail every push.
//
// Usage:
//   node scripts/check-push-authors.mjs            # read pre-push lines on stdin
//   node scripts/check-push-authors.mjs --selftest # prove each rule can still fail
//   node scripts/check-push-authors.mjs --report <out.json>
//
// Exit codes: 0 pass · 1 refused (foreign authorship, or a push out of the shared root)
//             · 2 configuration/environment error.
//
// Escape hatch, named rather than discovered: `git config agent.allowSharedRoot true`
// or AGENT_PUSH_ALLOW_SHARED_ROOT=1. It has to be set deliberately, it only waives
// layer 2, and layer 1 still applies.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const ZERO = /^0+$/;
const FIELD = "\x1f";
const FIELD_END = "\x1e";

// Identity every agent commit on this board carries. Listed so a reader can see the
// gate distinguishes "a co-author trailer" from "the author of the commit".
export const PAPERCLIP_TRAILER = "Co-Authored-By: Paperclip <noreply@paperclip.ing>";

// ---------------------------------------------------------------------------
// Pure decision layer: no git, no filesystem. Everything here is what the selftest
// drives, so a rule that stops being enforced fails --selftest instead of passing
// quietly.
// ---------------------------------------------------------------------------

// A pre-push hook receives one line per ref:
//   <local ref> SP <local sha> SP <remote ref> SP <remote sha>
// Dangling values are all-zero for "this side does not exist".
export function parseHookInput(text) {
  const updates = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const [localRef, localSha, remoteRef, remoteSha] = parts;
    updates.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return updates;
}

// The commit range a push would introduce, as a pair of revisions; the caller composes
// `from..to`. Returning the basis as well as the range is the point -- a range computed against
// the wrong base is a range that hides commits, and an unexplained range is indistinguishable
// from a guard that does nothing.
export function rangeForUpdate(update, { baseSha }) {
  if (ZERO.test(update.localSha)) return null; // ref deletion: nothing is introduced
  if (!ZERO.test(update.remoteSha)) {
    return { from: update.remoteSha, to: update.localSha, basis: "remote-tracking ref" };
  }
  if (!baseSha || ZERO.test(baseSha)) return null;
  return { from: baseSha, to: update.localSha, basis: "push base (new branch)" };
}

export function normalizeIdentity(entry) {
  const match = /^\s*(.*?)\s*<([^>]*)>\s*$/.exec(String(entry || ""));
  if (!match) return null;
  const name = match[1].trim();
  const email = match[2].trim().toLowerCase();
  if (!name || !email) return null;
  return `${name.toLowerCase()} <${email}>`;
}

export function identityOf(commit) {
  return normalizeIdentity(`${commit.authorName} <${commit.authorEmail}>`);
}

// MAX-101: where is this push coming from?
//
// A repository has exactly one primary working tree and any number of linked worktrees, and git
// is the only thing that can tell them apart without a naming convention: in the primary tree
// `--git-dir` and `--git-common-dir` are the same directory, and in a linked worktree `--git-dir`
// is that worktree's private slot under `<common>/worktrees/`. Comparing those two paths is what
// makes this a property of the checkout instead of a name in a script.
//
// The shared root is the primary working tree. It is the one checkout every agent shares, which is
// exactly why authorship cannot be trusted there: the identity it is configured with belongs to one
// agent, and it stamps that identity on whatever anybody commits.
//
// `bare` is a deliberate carve-out, not an exemption: a repository with no working tree has no
// shared working directory to be a hazard, so there is nothing for this rule to protect. `unknown`
// means git would not say, and unknown is reported rather than assumed either way -- the guard's
// standing rule is that anything it could not check is a problem, never a silent pass.
export function classifyCheckout({ gitDir, commonDir, bare } = {}) {
  if (bare) return "bare";
  if (!gitDir || !commonDir) return "unknown";
  return normalizePath(gitDir) === normalizePath(commonDir) ? "shared-root" : "worktree";
}

// git prints these relative to the cwd it was run in, and a hook may run from anywhere inside the
// working tree, so two spellings of one directory have to compare equal or the rule fires at random.
function normalizePath(p) {
  return resolve(String(p)).replace(/\/+$/, "") || "/";
}

// The whole verdict. `updates` is the parsed hook input, `ranges` maps a local sha to
// the commits in the range it would introduce, and `expected` is the allowed identity
// set. Anything unexpected is a violation rather than a pass: this gate reports what it
// could not check.
//
// `place` is the checkout classification from classifyCheckout (plus whether the shared
// root was waived on purpose). It is optional so the authorship layer can be driven on
// its own; absent means "nothing was said about where this push came from", which is the
// pre-MAX-101 behaviour and not an implicit pass for the shared root.
export function evaluatePush({ updates, ranges, expected, expectedSource, place }) {
  const checked = [];
  const problems = [];
  const sharedRoot = [];
  let introduced = 0;

  for (const update of updates) {
    const range = rangeForUpdate(update, { baseSha: expected.baseSha });
    if (!range) {
      if (ZERO.test(update.localSha)) continue; // deletion, intentionally not checked
      problems.push({
        kind: "unresolved-range",
        ref: update.localRef,
        detail: "no push base to compare a new branch against; set agent.pushBase (a ref or sha)",
      });
      continue;
    }
    const commits = ranges[update.localSha] || [];
    if (!commits.length) {
      problems.push({
        kind: "unresolved-range",
        ref: update.localRef,
        detail: `no commits found in ${range.from}..${range.to}`,
      });
      continue;
    }
    introduced += commits.length;
    const foreign = commits.filter((c) => !expected.identities.has(identityOf(c)));
    const row = {
      ref: update.localRef,
      remoteRef: update.remoteRef,
      basis: range.basis,
      commits: commits.length,
      foreign: foreign.map((c) => describeCommit(c)),
    };
    checked.push(row);

    // MAX-101. In the shared root, the commits this gate cannot vouch for are the ones it would
    // otherwise call clean: they carry the checkout's configured identity, which any agent typing
    // there gets for free. Those are named here; the commits authored by somebody else are already
    // named above as foreign. Between them, every commit in the range is accounted for.
    if (place && place.kind === "shared-root" && !place.allowed) {
      const unverifiable = commits.filter((c) => expected.identities.has(identityOf(c)));
      if (unverifiable.length) {
        sharedRoot.push({
          ref: update.localRef,
          checkout: place.topLevel,
          commits: unverifiable.map((c) => describeCommit(c)),
        });
      }
    }
  }

  if (place && place.kind === "unknown") {
    problems.push({
      kind: "unknown-checkout",
      ref: "(checkout)",
      detail:
        "cannot tell whether this is the shared root or a worktree, so the push cannot be checked " +
        "for MAX-101. git would not report --git-dir/--git-common-dir here.",
    });
  }

  const violations = checked.filter((c) => c.foreign.length);
  return {
    ok: problems.length === 0 && violations.length === 0 && sharedRoot.length === 0,
    introduced,
    refs: checked,
    violations,
    sharedRoot,
    problems,
    expected: { identities: [...expected.identities], source: expectedSource },
    place: place ? { kind: place.kind, allowed: !!place.allowed, topLevel: place.topLevel } : null,
  };
}

function describeCommit(c) {
  return { sha: c.sha.slice(0, 7), author: `${c.authorName} <${c.authorEmail}>`, subject: c.subject };
}

// ---------------------------------------------------------------------------
// git adapter
// ---------------------------------------------------------------------------

export function git(args, cwd = REPO) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// stderr is swallowed on purpose. These probes are allowed to fail -- an absent push base, an
// unresolvable sha -- and the guard reports the failure in its own words. A raw `fatal:` from
// git printed on top of that reads like two separate problems, and the hook's exit code is the
// only part git reports to the pusher.
export function gitOptional(args, cwd = REPO) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

// `agent.pushBase` overrides the default base for a brand-new branch. Default is
// origin/HEAD when the remote publishes one, else origin/main.
export function resolvePushBase(cwd = REPO) {
  const configured = gitOptional(["config", "--get", "agent.pushBase"], cwd);
  if (configured) return configured;
  const head = gitOptional(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd);
  if (head) return head.replace(/^refs\/remotes\//, "");
  return "origin/main";
}

export function collectRanges(updates, baseRef, cwd = REPO) {
  const baseSha = gitOptional(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], cwd);
  const ranges = {};
  for (const update of updates) {
    if (ZERO.test(update.localSha)) continue;
    const range = rangeForUpdate(update, { baseSha });
    if (!range) continue;
    const format = ["%H", "%aN", "%aE", "%s"].join(FIELD) + FIELD_END;
    const out = gitOptional(["log", `--format=${format}`, `${range.from}..${range.to}`], cwd);
    ranges[update.localSha] = out
      ? out
          .split(FIELD_END)
          .map((s) => s.replace(/^\n+/, ""))
          .filter((s) => s.trim())
          .map((s) => {
            const [sha, authorName, authorEmail, ...subject] = s.split(FIELD);
            return { sha, authorName, authorEmail, subject: subject.join(FIELD) };
          })
      : [];
  }
  return { ranges, baseSha };
}

export function readExpectedIdentity(cwd = REPO, env = {}) {
  // `--worktree` first: with extensions.worktreeConfig an agent's identity can be
  // per-worktree, which is what makes one worktree per agent actually mean something.
  const name =
    gitOptional(["config", "--worktree", "--get", "user.name"], cwd) || gitOptional(["config", "--get", "user.name"], cwd);
  const email =
    gitOptional(["config", "--worktree", "--get", "user.email"], cwd) ||
    gitOptional(["config", "--get", "user.email"], cwd);
  const identities = new Set();
  const source = [];
  if (name && email) {
    identities.add(normalizeIdentity(`${name} <${email}>`));
    source.push("user.name/user.email");
  }
  const allowed = [
    ...gitOptional(["config", "--get-all", "agent.allowedAuthors"], cwd).split("\n"),
    ...(env.AGENT_PUSH_ALLOWED_AUTHORS || "").split(","),
  ].filter((s) => s.trim());
  for (const entry of allowed) {
    const id = normalizeIdentity(entry);
    if (id) {
      identities.add(id);
      source.push(`allowlist:${entry.trim()}`);
    }
  }
  return { name, email, identities, baseSha: undefined, allowed };
}

export function checkEnvironment({ name, email, identities }) {
  const problems = [];
  if (!name || !email) {
    problems.push(
      "user.name/user.email is not set for this checkout; authorship cannot be verified, so this is a configuration error rather than a pass. Set it per worktree: scripts/agent-worktree.sh does this for you.",
    );
  }
  if (identities.size === 0) problems.push("no allowed identity resolved");
  return problems;
}

// Where this push is coming from, read from git rather than from a path convention.
//
// `--path-format=absolute` matters: a pre-push hook may run from a subdirectory of the checkout,
// and the relative form would then resolve against that subdirectory and compare unequal to itself.
export function readCheckoutPlace(cwd = REPO, env = {}) {
  const gitDir = gitOptional(["rev-parse", "--path-format=absolute", "--git-dir"], cwd);
  const commonDir = gitOptional(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  const bare = gitOptional(["rev-parse", "--is-bare-repository"], cwd) === "true";
  const kind = classifyCheckout({ gitDir, commonDir, bare });

  // The waiver is read once, in one place, for both spellings, so "how do I turn this off" has
  // exactly one answer and the refusal can quote it.
  const configured = gitOptional(["config", "--get", "agent.allowSharedRoot"], cwd);
  const viaEnv = isTrue(env.AGENT_PUSH_ALLOW_SHARED_ROOT);
  const allowed = isTrue(configured) || viaEnv;

  return {
    kind,
    allowed: kind === "shared-root" && allowed,
    topLevel: gitOptional(["rev-parse", "--show-toplevel"], cwd) || cwd,
    gitDir,
    commonDir,
    bare,
    waiver: allowed ? (viaEnv ? "AGENT_PUSH_ALLOW_SHARED_ROOT=1" : "agent.allowSharedRoot=true") : null,
  };
}

function isTrue(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

// ---------------------------------------------------------------------------
// Selftest: a throwaway repo with two identities. Each case must FAIL to be evidence;
// a case the engine passes is reported as missed.
// ---------------------------------------------------------------------------

function seedRepo(dir) {
  const run = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  run("init", "-q", "-b", "main");
  run("config", "user.name", "Bob");
  run("config", "user.email", "bob@math-training.app");
  run("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "one\n");
  run("add", "a.txt");
  run("commit", "-q", "-m", "base");
  // A second seed commit so `base^` exists: the baseline case needs a real parent to
  // diff against, and a root commit would make the git adapter throw instead of report.
  writeFileSync(join(dir, "a2.txt"), "two\n");
  run("add", "a2.txt");
  run("commit", "-q", "-m", "base 2");
  return run;
}

function commitAs(dir, { name, email, file, body, message }) {
  const run = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  writeFileSync(join(dir, file), body);
  run("add", file);
  run("-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "-m", message);
}

function sha(dir) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

// The MAX-101 cases that need no repository at all: what git's two directory answers mean, and
// what the rule does with each of them. A classification that quietly returned "worktree" for the
// primary tree would make every rule below pass while enforcing nothing.
function classificationCases(rows) {
  const cases = [
    {
      id: "classify-primary-tree-is-the-shared-root",
      detail: "git-dir == git-common-dir means the primary working tree, which is the shared root",
      expect: "shared-root",
      run: () =>
        classifyCheckout({ gitDir: "/repo/.git", commonDir: "/repo/.git", bare: false }),
    },
    {
      id: "classify-linked-worktree-is-not-the-shared-root",
      detail: "a linked worktree has its own git dir under <common>/worktrees/, which is the whole basis of the rule",
      expect: "worktree",
      run: () =>
        classifyCheckout({
          gitDir: "/repo/.git/worktrees/carol",
          commonDir: "/repo/.git",
          bare: false,
        }),
    },
    {
      id: "classify-is-cwd-independent",
      detail: "the same directory spelled relative must classify the same way, or the rule fires at random",
      expect: "shared-root",
      run: () => classifyCheckout({ gitDir: ".git", commonDir: ".git", bare: false }),
    },
    {
      id: "classify-bare-repository-has-no-shared-working-tree",
      detail: "no working tree means no shared working directory; the rule has nothing to protect",
      expect: "bare",
      run: () => classifyCheckout({ gitDir: "/repo.git", commonDir: "/repo.git", bare: true }),
    },
    {
      id: "classify-unresolvable-is-unknown-not-a-pass",
      detail: "git would not say: unknown is its own answer, never silently worktree",
      expect: "unknown",
      run: () => classifyCheckout({ gitDir: "", commonDir: "", bare: false }),
    },
  ];
  for (const c of cases) {
    const got = c.run();
    rows.push({ id: c.id, detail: c.detail, expected: c.expect, got, ok: got === c.expect });
  }
}

export function selftest() {
  const dir = mkdtempSync(join(tmpdir(), "push-authors-"));
  const rows = [];
  let missed = null;
  let baselineClean = false;
  try {
    const run = seedRepo(dir);
    const base = sha(dir);
    const bob = { name: "Bob", email: "bob@math-training.app" };
    const carol = { name: "Carol", email: "carol@paperclip.local" };

    commitAs(dir, { ...bob, file: "b.txt", body: "bob\n", message: "Bob: add b" });
    const bobSha = sha(dir);
    commitAs(dir, { ...carol, file: "c.txt", body: "carol\n", message: "Carol: add c" });
    const mixedSha = sha(dir);

    const expect = (identities) => ({ identities: new Set(identities), baseSha: base });
    const bobIds = [normalizeIdentity("Bob <bob@math-training.app>")];
    const bothIds = [...bobIds, normalizeIdentity("Carol <carol@paperclip.local>")];
    // Explicit `from..to`, mirroring what the git adapter builds for a push, so the
    // selftest ranges and the production ranges are the same shape.
    const commitsOf = (from, to) => {
      const out = run("log", "--format=%H%x1f%aN%x1f%aE%x1f%s", `${from}..${to}`);
      return out
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          const [s, n, e, ...subj] = l.split(FIELD);
          return { sha: s, authorName: n, authorEmail: e, subject: subj.join(FIELD) };
        });
    };

    const cases = [
      {
        id: "clean-single-author",
        detail: "one commit by the checkout identity must pass",
        expect: "pass",
        run: () =>
          evaluatePush({
            updates: parseHookInput(`refs/heads/x ${bobSha} refs/heads/x ${base}`),
            ranges: { [bobSha]: commitsOf(base, bobSha) },
            expected: expect(bobIds),
            expectedSource: "test",
          }),
      },
      {
        id: "mixed-authors-on-one-branch",
        detail: "the MAX-69 shape: my commit plus another agent's commit on my branch must fail",
        expect: "fail",
        run: () =>
          evaluatePush({
            updates: parseHookInput(`refs/heads/x ${mixedSha} refs/heads/x ${base}`),
            ranges: { [mixedSha]: commitsOf(base, mixedSha) },
            expected: expect(bobIds),
            expectedSource: "test",
          }),
      },
      {
        id: "new-branch-off-base",
        detail: "a brand-new branch compares against the push base, so a foreign commit is still caught",
        expect: "fail",
        run: () =>
          evaluatePush({
            updates: parseHookInput(`refs/heads/new ${mixedSha} refs/heads/new ${"0".repeat(40)}`),
            ranges: { [mixedSha]: commitsOf(base, mixedSha) },
            expected: expect(bobIds),
            expectedSource: "test",
          }),
      },
      {
        id: "new-branch-clean",
        detail: "the same new branch with only my commits must pass",
        expect: "pass",
        run: () =>
          evaluatePush({
            updates: parseHookInput(`refs/heads/new ${bobSha} refs/heads/new ${"0".repeat(40)}`),
            ranges: { [bobSha]: commitsOf(base, bobSha) },
            expected: expect(bobIds),
            expectedSource: "test",
          }),
      },
      {
        id: "allowlist-admits-the-other-agent",
        detail: "an explicit agent.allowedAuthors entry is honoured, so a shared/paired identity still pushes",
        expect: "pass",
        run: () =>
          evaluatePush({
            updates: parseHookInput(`refs/heads/x ${mixedSha} refs/heads/x ${base}`),
            ranges: { [mixedSha]: commitsOf(base, mixedSha) },
            expected: expect(bothIds),
            expectedSource: "test",
          }),
      },
      {
        id: "email-case-and-space-insensitive",
        detail: "Author <BOB@Math-Training.App> is the same identity as the configured one",
        expect: "pass",
        run: () =>
          evaluatePush({
            updates: parseHookInput(`refs/heads/x ${bobSha} refs/heads/x ${base}`),
            ranges: {
              [bobSha]: [{ sha: bobSha, authorName: " Bob ", authorEmail: "BOB@Math-Training.App", subject: "s" }],
            },
            expected: expect(bobIds),
            expectedSource: "test",
          }),
      },
      {
        id: "ref-deletion-is-not-a-violation",
        detail: "pushing a deletion introduces no commits and must not fail",
        expect: "pass",
        run: () =>
          evaluatePush({
            updates: parseHookInput(`refs/heads/gone ${"0".repeat(40)} refs/heads/gone ${base}`),
            ranges: {},
            expected: expect(bobIds),
            expectedSource: "test",
          }),
      },
      {
        id: "unresolved-base-is-a-failure-not-a-pass",
        detail: "no push base for a new branch must fail closed, never silently pass",
        expect: "fail",
        run: () =>
          evaluatePush({
            updates: parseHookInput(`refs/heads/new ${mixedSha} refs/heads/new ${"0".repeat(40)}`),
            ranges: { [mixedSha]: commitsOf(base, mixedSha) },
            expected: { identities: new Set(bobIds), baseSha: "" },
            expectedSource: "test",
          }),
      },
      {
        id: "missing-identity-is-a-configuration-error",
        detail: "an unconfigured checkout reports problems rather than reporting success",
        expect: "fail",
        run: () =>
          evaluatePush({
            updates: parseHookInput(`refs/heads/x ${bobSha} refs/heads/x ${base}`),
            ranges: { [bobSha]: commitsOf(base, bobSha) },
            expected: { identities: new Set(), baseSha: base },
            expectedSource: "test",
          }),
      },
      {
        id: "trailer-is-not-an-author",
        detail: "Co-Authored-By: Paperclip on every commit must not read as foreign authorship",
        expect: "pass",
        run: () =>
          evaluatePush({
            updates: parseHookInput(`refs/heads/x ${bobSha} refs/heads/x ${base}`),
            ranges: {
              [bobSha]: [
                {
                  sha: bobSha,
                  authorName: "Bob",
                  authorEmail: "bob@math-training.app",
                  subject: `add b\n\n${PAPERCLIP_TRAILER}`,
                },
              ],
            },
            expected: expect(bobIds),
            expectedSource: "test",
          }),
      },

      // ---- MAX-101: the same commits, decided by where the push comes from ------------------
      //
      // Every case below is the identical commit and the identical expected identity. Only the
      // checkout changes. That is the whole claim of this ticket, and it is only evidence if the
      // two rows disagree.
      {
        id: "max-101-same-commit-passes-in-a-worktree",
        detail: "Bob's own commit, pushed from Bob's worktree: the MAX-69 rule's verdict, unchanged",
        expect: "pass",
        run: () =>
          evaluatePush({
            updates: parseHookInput(`refs/heads/x ${bobSha} refs/heads/x ${base}`),
            ranges: { [bobSha]: commitsOf(base, bobSha) },
            expected: expect(bobIds),
            expectedSource: "test",
            place: { kind: "worktree", allowed: false, topLevel: "/wt/bob-fix-x" },
          }),
      },
      {
        id: "max-101-same-commit-refused-in-the-shared-root",
        detail: "the MAX-101 fossil: the same commit, authored by the checkout's own identity, pushed out of the shared root",
        expect: "fail",
        run: () =>
          evaluatePush({
            updates: parseHookInput(`refs/heads/x ${bobSha} refs/heads/x ${base}`),
            ranges: { [bobSha]: commitsOf(base, bobSha) },
            expected: expect(bobIds),
            expectedSource: "test",
            place: { kind: "shared-root", allowed: false, topLevel: "/repo" },
          }),
      },
      {
        id: "max-101-refusal-names-the-commit",
        detail: "a refusal that does not say which commit is indistinguishable from a broken guard",
        expect: "Bob: add b",
        run: () => {
          const r = evaluatePush({
            updates: parseHookInput(`refs/heads/x ${bobSha} refs/heads/x ${base}`),
            ranges: { [bobSha]: commitsOf(base, bobSha) },
            expected: expect(bobIds),
            expectedSource: "test",
            place: { kind: "shared-root", allowed: false, topLevel: "/repo" },
          });
          // The subjects the refusal names, so a miss says what it named instead of nothing.
          const named = (r.sharedRoot || []).flatMap((s) => s.commits);
          return { ok: named.length === 1 && named[0].subject === "Bob: add b", got: named.map((c) => c.subject).join(" | ") || "(none)" };
        },
      },
      {
        id: "max-101-shared-root-refusal-is-not-a-blanket-refusal",
        detail: "a push that introduces no commits delivers nothing, so the shared root may still push it",
        expect: "pass",
        run: () =>
          evaluatePush({
            updates: parseHookInput(`refs/heads/gone ${"0".repeat(40)} refs/heads/gone ${base}`),
            ranges: {},
            expected: expect(bobIds),
            expectedSource: "test",
            place: { kind: "shared-root", allowed: false, topLevel: "/repo" },
          }),
      },
      {
        id: "max-101-deliberate-waiver-is-honoured",
        detail: "a checkout that really is one agent's can say so in config, and then authorship is still checked",
        expect: "pass",
        run: () =>
          evaluatePush({
            updates: parseHookInput(`refs/heads/x ${bobSha} refs/heads/x ${base}`),
            ranges: { [bobSha]: commitsOf(base, bobSha) },
            expected: expect(bobIds),
            expectedSource: "test",
            place: { kind: "shared-root", allowed: true, topLevel: "/repo" },
          }),
      },
      {
        id: "max-101-waived-shared-root-still-refuses-a-foreign-author",
        detail: "the waiver waives the place rule only; the MAX-69 rule is untouched by it",
        expect: "fail",
        run: () =>
          evaluatePush({
            updates: parseHookInput(`refs/heads/x ${mixedSha} refs/heads/x ${base}`),
            ranges: { [mixedSha]: commitsOf(base, mixedSha) },
            expected: expect(bobIds),
            expectedSource: "test",
            place: { kind: "shared-root", allowed: true, topLevel: "/repo" },
          }),
      },
      {
        id: "max-101-unknown-checkout-fails-closed",
        detail: "if the checkout cannot be classified the push is refused, never assumed to be a worktree",
        expect: "fail",
        run: () =>
          evaluatePush({
            updates: parseHookInput(`refs/heads/x ${bobSha} refs/heads/x ${base}`),
            ranges: { [bobSha]: commitsOf(base, bobSha) },
            expected: expect(bobIds),
            expectedSource: "test",
            place: { kind: "unknown", allowed: false, topLevel: "/repo" },
          }),
      },
      {
        id: "max-101-bare-repository-is-not-the-shared-root",
        detail: "a repository with no working tree has no shared directory; the rule stays out of its way",
        expect: "pass",
        run: () =>
          evaluatePush({
            updates: parseHookInput(`refs/heads/x ${bobSha} refs/heads/x ${base}`),
            ranges: { [bobSha]: commitsOf(base, bobSha) },
            expected: expect(bobIds),
            expectedSource: "test",
            place: { kind: "bare", allowed: false, topLevel: "" },
          }),
      },
    ];

    for (const c of cases) {
      const result = c.run();
      // A case that asserts something about what the gate reported hands in its own `got`, so a
      // miss names the wrong value instead of only saying pass/fail.
      const got = result.got !== undefined ? result.got : result.ok ? "pass" : "fail";
      rows.push({ id: c.id, detail: c.detail, expected: c.expect, got, ok: got === c.expect });
    }

    // Recorded limit, asserted so it stays a known limit. A squash rewrites authorship
    // to the first commit's author, so this gate cannot see a squashed foreign commit.
    run("reset", "-q", "--hard", base);
    commitAs(dir, { ...bob, file: "d.txt", body: "bob\n", message: "Bob: add d" });
    const bobOnly = sha(dir);
    commitAs(dir, { ...carol, file: "e.txt", body: "carol\n", message: "Carol: add e" });
    run("reset", "-q", "--hard", bobOnly);
    commitAs(dir, { ...bob, file: "f.txt", body: "squash\n", message: "Bob: squash of both" });
    const squashed = sha(dir);
    const squashedResult = evaluatePush({
      updates: parseHookInput(`refs/heads/s ${squashed} refs/heads/s ${base}`),
      ranges: { [squashed]: commitsOf(base, squashed) },
      expected: expect(bobIds),
      expectedSource: "test",
    });
    rows.push({
      id: "known-limit-squash-hides-foreign-author",
      detail: "documented limitation: a squash rewrites authorship, so the PR-body check must be the second layer",
      expected: "pass",
      got: squashedResult.ok ? "pass" : "fail",
      ok: squashedResult.ok,
    });

    // Baseline: the clean repo with nothing extra must pass, or every "fail" above is
    // evidence of a gate that fails at everything.
    baselineClean = evaluatePush({
      updates: parseHookInput(`refs/heads/base ${base} refs/heads/base ${"0".repeat(40)}`),
      ranges: { [base]: commitsOf(`${base}^`, base) },
      expected: expect(bobIds),
      expectedSource: "test",
    }).ok;

    // End-to-end through the real adapter: a throwaway repo with a real `origin`, the
    // actual CLI, real stdin in the pre-push wire format. The pure cases above prove the
    // decision layer; these prove the git plumbing and the exit code a hook actually sees,
    // which is the part a rewrite of collectRanges or resolvePushBase would silently break.
    //
    // A real origin is not optional here. Without one there is no push base, every new-branch
    // case fails closed for the wrong reason, and a guard that fails closed on everything
    // looks exactly like a guard that works.
    const originDir = mkdtempSync(join(tmpdir(), "push-authors-origin-"));
    const linkedParent = mkdtempSync(join(tmpdir(), "push-authors-wt-"));
    const linkedDir = join(linkedParent, "carol");
    try {
      execFileSync("git", ["init", "-q", "--bare", originDir], { encoding: "utf8" });
      run("remote", "add", "origin", originDir);
      run("push", "-q", "origin", `main:refs/heads/main`);
      run("fetch", "-q", "origin");

      // A real linked worktree, created the way scripts/agent-worktree.sh creates one. It is
      // checked out at bobSha and configured as Bob, so the commit under test is authored by the
      // identity both checkouts share -- the only difference between the two MAX-101 cases below
      // is which directory the push is coming from.
      run("worktree", "add", "-q", "-b", "wt-branch", linkedDir, bobSha);
      run("-C", linkedDir, "config", "extensions.worktreeConfig", "true");
      run("-C", linkedDir, "config", "--worktree", "user.name", bob.name);
      run("-C", linkedDir, "config", "--worktree", "user.email", bob.email);

      const spawn = (input, spawnCwd = dir, spawnEnv = {}) => {
        try {
          const stdout = execFileSync("node", [join(HERE, "check-push-authors.mjs")], {
            cwd: spawnCwd,
            input,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, ...spawnEnv },
          });
          return { code: 0, stdout };
        } catch (err) {
          return { code: err.status, stdout: `${err.stdout || ""}${err.stderr || ""}` };
        }
      };
      // This throwaway repo's primary tree *is* a shared root as far as MAX-101 is concerned --
      // it is the repository's only working tree. These cases are about the authorship layer, so
      // they waive the place rule explicitly rather than passing by accident. The place layer gets
      // its own end-to-end cases below, un-waived, in the same repository.
      const inSharedRoot = { AGENT_PUSH_ALLOW_SHARED_ROOT: "1" };
      const zeros = "0".repeat(40);
      const e2e = [
        {
          id: "end-to-end-clean-branch-exits-0",
          detail: "the hook path a good push takes: real repo, real stdin, exit 0",
          expect: { code: 0 },
          run: () => spawn(`refs/heads/clean ${bobSha} refs/heads/clean ${base}\n`, dir, inSharedRoot),
        },
        {
          id: "end-to-end-mixed-branch-exits-1-naming-the-commit",
          detail: "the MAX-69 shape: exit 1, and the refusal names the foreign commit rather than failing silently",
          expect: { code: 1, contains: "Carol" },
          run: () => spawn(`refs/heads/mixed ${mixedSha} refs/heads/mixed ${base}\n`, dir, inSharedRoot),
        },
        {
          id: "end-to-end-new-branch-compares-against-main",
          detail: "a new branch with no remote side is diffed against the push base and refused for the right reason",
          expect: { code: 1, contains: "push base (new branch)" },
          run: () => spawn(`refs/heads/brand-new ${mixedSha} refs/heads/brand-new ${zeros}\n`, dir, inSharedRoot),
        },
        {
          id: "end-to-end-new-branch-clean-exits-0",
          detail: "the same new-branch path with only my commits passes, so the base comparison is not a blanket refusal",
          expect: { code: 0, contains: "push base (new branch)" },
          run: () => spawn(`refs/heads/brand-new-clean ${bobSha} refs/heads/brand-new-clean ${zeros}\n`, dir, inSharedRoot),
        },
        {
          id: "end-to-end-waiver-does-not-admit-a-foreign-author",
          detail: "the shared-root waiver is read through the real adapter, and it waives the place rule only",
          expect: { code: 1, contains: "Carol" },
          run: () => spawn(`refs/heads/mixed ${mixedSha} refs/heads/mixed ${base}\n`),
        },
        {
          id: "end-to-end-waiver-in-env-is-honoured",
          detail: "AGENT_PUSH_ALLOW_SHARED_ROOT is the same switch, so a deliberate waiver is one env var away",
          expect: { code: 0 },
          run: () => spawn(`refs/heads/clean ${bobSha} refs/heads/clean ${base}\n`, dir, { AGENT_PUSH_ALLOW_SHARED_ROOT: "1" }),
        },

        // ---- MAX-101 end to end: the same commit, from two different checkouts ----------------
        //
        // `bobSha` is authored by the repository's configured identity, so the authorship rule
        // passes it -- from anywhere. These two cases are the ticket: out of the primary tree it
        // exits 1 and names the commit; out of a real worktree, the identical commit exits 0. A
        // guard that could not tell the two apart would fail one of them.
        {
          id: "end-to-end-max-101-shared-root-exits-1-naming-the-commit",
          detail: "pushing from the primary working tree refuses, and names the commit it refused",
          expect: { code: 1, contains: "Bob: add b" },
          run: () => spawn(`refs/heads/x ${bobSha} refs/heads/x ${base}\n`),
        },
        {
          id: "end-to-end-max-101-shared-root-exit-1-is-not-an-authorship-refusal",
          detail: "the refusal names the place, so it cannot be mistaken for a MAX-69 verdict the author check would also give",
          expect: { code: 1, contains: "shared root" },
          run: () => spawn(`refs/heads/x ${bobSha} refs/heads/x ${base}\n`),
        },
        {
          id: "end-to-end-max-101-same-commit-exits-0-from-a-worktree",
          detail: "the identical commit and the identical stdin, from a linked worktree that owns that identity: exit 0",
          expect: { code: 0 },
          run: () => spawn(`refs/heads/x ${bobSha} refs/heads/x ${base}\n`, linkedDir),
        },
      ];
      for (const c of e2e) {
        const result = c.run();
        const codeOk = result.code === c.expect.code;
        const textOk = !c.expect.contains || result.stdout.includes(c.expect.contains);
        rows.push({
          id: c.id,
          detail: c.detail,
          expected: `exit ${c.expect.code}${c.expect.contains ? ` mentioning ${c.expect.contains}` : ""}`,
          got: `exit ${result.code}${textOk ? "" : ` (output did not mention ${c.expect.contains})`}`,
          ok: codeOk && textOk,
        });
      }
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(linkedParent, { recursive: true, force: true });
    }

    classificationCases(rows);
    missed = rows.filter((r) => !r.ok).map((r) => r.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { rows, missed, baselineClean };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printResult(result) {
  const lines = [];
  lines.push("check-push-authors: branch authorship gate");
  for (const ref of result.refs) {
    lines.push(
      `  ${ref.ref} -> ${ref.remoteRef}: ${ref.commits} commit(s), basis ${ref.basis}` +
        (ref.foreign.length ? `, ${ref.foreign.length} FOREIGN` : ""),
    );
    for (const f of ref.foreign) lines.push(`    ${f.sha}  ${f.author}  ${f.subject}`);
  }
  for (const s of result.sharedRoot || []) {
    lines.push(
      `  ${s.ref}: ${s.commits.length} commit(s) would be attributed to this checkout's identity, from ${s.checkout}`,
    );
    for (const c of s.commits) lines.push(`    ${c.sha}  ${c.author}  ${c.subject}`);
  }
  for (const p of result.problems) lines.push(`  PROBLEM ${p.kind} ${p.ref}: ${p.detail}`);
  if (result.place) {
    lines.push(
      `  checkout: ${result.place.kind === "worktree" ? "a worktree" : result.place.kind}` +
        (result.place.topLevel ? ` at ${result.place.topLevel}` : "") +
        (result.place.allowed ? ` (shared root waived: ${result.place.waiver})` : ""),
    );
  }
  lines.push(`  allowed authors: ${result.expected.identities.join(", ") || "(none)"} (from ${result.expected.source})`);
  return lines;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);

  if (args.includes("--selftest")) {
    const result = selftest();
    console.log("check-push-authors selftest");
    for (const row of result.rows) {
      console.log(`  ${row.ok ? "ok  " : "MISS"} ${row.id} (expected ${row.expected}, got ${row.got})`);
    }
    if (!result.baselineClean) console.log("  MISS baseline-clean-repo-must-pass");
    const failed = result.missed.length > 0 || !result.baselineClean;
    console.log(
      failed
        ? `  ${result.missed.length + (result.baselineClean ? 0 : 1)} case(s) did not behave as required; the gate is not trustworthy.`
        : `  ${result.rows.length + 1} case(s) behaved as required.`,
    );
    process.exit(failed ? 1 : 0);
  }

  const cwd = process.env.GIT_DIR_CWD ? resolve(process.env.GIT_DIR_CWD) : process.cwd();
  const env = readExpectedIdentity(cwd);
  const envProblems = checkEnvironment(env);
  if (envProblems.length) {
    for (const p of envProblems) console.error(`check-push-authors: CONFIG: ${p}`);
    process.exit(2);
  }

  const updates = parseHookInput(readHookStdin());
  if (!updates.length) {
    console.log("check-push-authors: no refs on stdin; nothing to check.");
    process.exit(0);
  }
  const baseRef = resolvePushBase(cwd);
  const { ranges, baseSha } = collectRanges(updates, baseRef, cwd);
  const place = readCheckoutPlace(cwd, process.env);
  const result = evaluatePush({
    updates,
    ranges,
    expected: { identities: env.identities, baseSha },
    expectedSource: `${env.name} <${env.email}>`,
    place,
  });
  if (result.expected.source !== `${env.name} <${env.email}>`) result.expected.source += ` + ${env.allowed.join(", ")}`;
  result.place = { ...result.place, waiver: place.waiver };

  console.log(printResult(result).join("\n"));

  const jsonIdx = args.indexOf("--report");
  if (jsonIdx >= 0 && args[jsonIdx + 1]) {
    const out = resolve(args[jsonIdx + 1]);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ gate: "check-push-authors", baseRef, ...result }, null, 2) + "\n");
    console.log(`  report: ${out}`);
  }

  if (result.ok) {
    console.log(`  ${result.introduced} commit(s) introduced, all authored by this checkout's identity.`);
    process.exit(0);
  }
  console.error("");
  if (result.sharedRoot.length) {
    printSharedRootRefusal(result, place);
    process.exit(1);
  }
  console.error("check-push-authors: REFUSED. This push would deliver another agent's commits under your name.");
  console.error("  This is MAX-69: a shared checkout let a commit land on the wrong branch, and the PR that");
  console.error("  described something else merged it. Do not work around this with --no-verify.");
  console.error("  Fix it instead:");
  console.error("    1. move the foreign commits onto their own branch, or drop them from yours");
  console.error("       git rebase --onto <their-branch> <their-commit> <your-branch>");
  console.error("    2. give each agent its own checkout: scripts/agent-worktree.sh <agent> <branch>");
  console.error("    3. if the shared identity is deliberate, allow it explicitly:");
  console.error("       git config --add agent.allowedAuthors 'Name <email>'");
  process.exit(1);
}

// MAX-101's refusal. It names the commits, because a guard that refuses without saying what it
// refused is indistinguishable from a guard that is broken. The path it points at is the one that
// works: agent-worktree.sh add is the only way this repository hands out a checkout, and it records
// the identity, installs the hooks and tells you what the checkout's node_modules is.
function printSharedRootRefusal(result, place) {
  const who = result.expected.identities[0] || result.expected.source;
  const e = (line = "") => console.error(line);
  e("check-push-authors: REFUSED. This push would attribute work to a person who may not have written it.");
  e(`  ${place.topLevel} is the shared root: this repository's primary working tree, where every`);
  e("  agent on this box shares one branch, one index and one working tree. Identity belongs to the");
  e("  checkout, so a commit made here carries its configured identity whoever typed it -- which is");
  e(`  why these ${result.sharedRoot.reduce((n, s) => n + s.commits.length, 0)} commit(s) cannot be checked:`);
  for (const s of result.sharedRoot) {
    for (const c of s.commits) e(`    ${c.sha}  ${c.author}  ${c.subject}`);
  }
  e("  This is MAX-101, and the guard's authorship rule cannot see it: that rule asks whether the");
  e("  author matches this checkout, and in the shared root the answer is yes by construction. The");
  e("  MAX-77 ruling landed exactly this way, as a commit attributed to Bob, pushed clean.");
  e("");
  e("  Push from a checkout that is yours:");
  e(`    sh scripts/agent-worktree.sh add <your-agent> <branch>     # records identity, installs hooks`);
  e(`    sh scripts/agent-worktree.sh identity <your-agent> \"Your Name\" you@example.com`);
  e("    cd \"$WT_ROOT/<your-agent>-<branch>\" && npm ci             # deps: per-worktree npm ci");
  e(`    git push                                                  # attributed to you, and this passes`);
  e("  Then check what every checkout on this box is doing: sh scripts/agent-worktree.sh check");
  e("");
  e(`  If ${place.topLevel} really is yours alone, say so once and name it in config:`);
  e("    git config agent.allowSharedRoot true");
  e("  That waives this rule only. The authorship rule above still applies, and --no-verify defeats");
  e("  both; use it only when a push is blocked for a stated reason, and say so on the issue.");
  if (who) e(`  (allowed authors recorded for this checkout: ${result.expected.source})`);
}

// git hands the ref list to a pre-push hook on fd 0 and closes it, so a blocking read
// is the documented way to get it. Reading it in-process matters: the hook runs on every
// push, and a spawned interpreter here would be one more thing to be missing on a box
// where git itself works fine.
function readHookStdin() {
  try {
    if (process.stdin.isTTY) return "";
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
