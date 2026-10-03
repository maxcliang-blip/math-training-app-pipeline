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
// What it checks: for every ref being pushed, every commit that push would introduce
// must be authored by the identity configured for this checkout. What it cannot check,
// stated here so nobody assumes it can: a squash rewrites authorship to the first
// commit's author, so a squashed foreign commit passes this gate. That is why the
// PR-body check (item 4 of MAX-69) is a second layer and not optional.
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
// Exit codes: 0 pass · 1 foreign authorship · 2 configuration/environment error.

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

// The whole verdict. `updates` is the parsed hook input, `ranges` maps a local sha to
// the commits in the range it would introduce, and `expected` is the allowed identity
// set. Anything unexpected is a violation rather than a pass: this gate reports what it
// could not check.
export function evaluatePush({ updates, ranges, expected, expectedSource }) {
  const checked = [];
  const problems = [];
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
    checked.push({
      ref: update.localRef,
      remoteRef: update.remoteRef,
      basis: range.basis,
      commits: commits.length,
      foreign: foreign.map((c) => ({
        sha: c.sha.slice(0, 7),
        author: `${c.authorName} <${c.authorEmail}>`,
        subject: c.subject,
      })),
    });
  }

  const violations = checked.filter((c) => c.foreign.length);
  return {
    ok: problems.length === 0 && violations.length === 0,
    introduced,
    refs: checked,
    violations,
    problems,
    expected: { identities: [...expected.identities], source: expectedSource },
  };
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
    ];

    for (const c of cases) {
      const result = c.run();
      const got = result.ok ? "pass" : "fail";
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
    try {
      execFileSync("git", ["init", "-q", "--bare", originDir], { encoding: "utf8" });
      run("remote", "add", "origin", originDir);
      run("push", "-q", "origin", `main:refs/heads/main`);
      run("fetch", "-q", "origin");

      const spawn = (input) => {
        try {
          const stdout = execFileSync("node", [join(HERE, "check-push-authors.mjs")], {
            cwd: dir,
            input,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          return { code: 0, stdout };
        } catch (err) {
          return { code: err.status, stdout: `${err.stdout || ""}${err.stderr || ""}` };
        }
      };
      const zeros = "0".repeat(40);
      const e2e = [
        {
          id: "end-to-end-clean-branch-exits-0",
          detail: "the hook path a good push takes: real repo, real stdin, exit 0",
          expect: { code: 0 },
          run: () => spawn(`refs/heads/clean ${bobSha} refs/heads/clean ${base}\n`),
        },
        {
          id: "end-to-end-mixed-branch-exits-1-naming-the-commit",
          detail: "the MAX-69 shape: exit 1, and the refusal names the foreign commit rather than failing silently",
          expect: { code: 1, contains: "Carol" },
          run: () => spawn(`refs/heads/mixed ${mixedSha} refs/heads/mixed ${base}\n`),
        },
        {
          id: "end-to-end-new-branch-compares-against-main",
          detail: "a new branch with no remote side is diffed against the push base and refused for the right reason",
          expect: { code: 1, contains: "push base (new branch)" },
          run: () => spawn(`refs/heads/brand-new ${mixedSha} refs/heads/brand-new ${zeros}\n`),
        },
        {
          id: "end-to-end-new-branch-clean-exits-0",
          detail: "the same new-branch path with only my commits passes, so the base comparison is not a blanket refusal",
          expect: { code: 0, contains: "push base (new branch)" },
          run: () => spawn(`refs/heads/brand-new-clean ${bobSha} refs/heads/brand-new-clean ${zeros}\n`),
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
    }

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
  for (const p of result.problems) lines.push(`  PROBLEM ${p.kind} ${p.ref}: ${p.detail}`);
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
  const result = evaluatePush({
    updates,
    ranges,
    expected: { identities: env.identities, baseSha },
    expectedSource: `${env.name} <${env.email}>`,
  });
  if (result.expected.source !== `${env.name} <${env.email}>`) result.expected.source += ` + ${env.allowed.join(", ")}`;

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
