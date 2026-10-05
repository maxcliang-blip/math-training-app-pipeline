// One parser for "this flag takes a bare path", shared by every tool that has one. MAX-130.
//
// Why this file exists, measured rather than predicted:
//
//   scripts/check-content-math.mjs --json <outPath>   resolved the next argv token as a path,
//                                                        with nothing checking the token was one.
//                                                        `--json --selftest` wrote a 4KB JSON file
//                                                        named `--selftest` to the repository root,
//                                                        and that file is tracked on main (MAX-97).
//   scripts/check-push-authors.mjs --report <out.json> the identical three lines, written
//                                                        independently, in a second tool (MAX-124).
//
// Two tools each re-deriving "a flag is not a path" is how a third one will get it wrong too. The
// recurrence is the defect; this module is the fix for the recurrence rather than the third copy.
//
// The contract, deliberately small:
//
//   requirePathArg(argv, flag)
//     -> { ok: true,  value }      the token after `flag`, or undefined
//     -> { ok: false, message }    the token was a flag; `message` names the flag and the token
//
// undefined is deliberately not an error. `--out` alone, and `--out --other-flag` where the caller
// has already parsed its own flags, both mean "the caller decides": check-push-authors.mjs is
// invoked by .githooks/pre-push as `exec node "$gate" "$@"` with git's own
// `<remote-name> <remote-url>`, so a missing value has to stay quiet rather than fail a push. The
// caller owns its default (a report path, stdout, a directory) and owns its exit code; this module
// only answers whether the token it was handed can be a path.
//
// The message shape is fixed by the two callers that already print one, so switching a call site
// to this function is a byte-identical message:
//
//   <flag> takes an output path; got the flag "<token>".
//
// Every tool that takes a bare path calls this, and the table below is wired into
// `npm run content:selftest` (ci.yml runs it), which is what stops this from being a helper that
// merely exists: dropping the refusal below fails that suite instead of passing quietly. Run the
// table alone with `node scripts/lib/require-path-arg.mjs`.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function requirePathArg(argv, flag) {
  const idx = argv.indexOf(flag);
  const value = idx >= 0 ? argv[idx + 1] : undefined;
  if (value !== undefined && value.startsWith("-")) {
    return { ok: false, message: `${flag} takes an output path; got the flag "${value}".` };
  }
  return { ok: true, value };
}

// The table. Every row is a property of the function above, asserted by calling it -- so a
// regression in the shared parser fails here once, rather than once per tool that forgot to keep
// its own copy. The rows carry the same shape check-content-math.mjs's harness prints
// (`id`, `rule`, `severity`, `caught`, `detail`) because check-content-math.mjs runs this table
// inside its own; a selftest that cannot fail is the failure mode this file exists to prevent, and
// these rows are all about refusing (or not refusing) one specific token.
const CASES = [
  {
    id: "max-130-path-arg-refuses-a-flag-as-a-path",
    rule: "argument-contract",
    detail: "`[\"--report\",\"--selftest\"]` is refused, and the message names the flag and the token",
    check: () => {
      const r = requirePathArg(["--report", "--selftest"], "--report");
      if (r.ok) return { caught: false, detail: "it accepted the flag as a path" };
      if (r.message !== '--report takes an output path; got the flag "--selftest".') {
        return { caught: false, detail: `message is ${JSON.stringify(r.message)}` };
      }
      return { caught: true, detail: "refused, naming the flag and the token" };
    },
  },
  {
    id: "max-130-path-arg-accepts-a-real-path",
    rule: "argument-contract",
    // The refusal must not be a blanket refusal: MAX-97's and MAX-124's gates both still write a
    // report when given a path, and a helper that refused everything would break both.
    detail: "`[\"--report\",\"out.json\"]` is accepted and yields the path unchanged",
    check: () => {
      const r = requirePathArg(["--report", "out.json"], "--report");
      if (!r.ok) return { caught: false, detail: `it refused a real path: ${r.message}` };
      if (r.value !== "out.json") return { caught: false, detail: `value is ${JSON.stringify(r.value)}` };
      return { caught: true, detail: "accepted, unresolved -- the caller resolves it" };
    },
  },
  {
    id: "max-130-path-arg-refuses-a-flag-for-any-tool",
    rule: "argument-contract",
    // The third tool's case, which is the whole reason for the module: a different flag, a
    // different tool, the same answer, with nothing re-derived per call site.
    detail: "`[\"--out\",\"--allow-missing-toolchain\"]` is refused for a different flag and tool",
    check: () => {
      const r = requirePathArg(["--out", "--allow-missing-toolchain"], "--out");
      if (r.ok) return { caught: false, detail: "it accepted a flag as a directory" };
      return { caught: true, detail: `refused: ${r.message}` };
    },
  },
  {
    id: "max-130-path-arg-only-the-leading-character-matters",
    rule: "argument-contract",
    // The test is "starts with -", not "contains a dash". A relative path that begins with one is
    // legal on disk and refusing it would be a new failure mode rather than a guard.
    detail: "`[\"--out\",\"./-figures\"]` is accepted: a dash inside the path is not a flag",
    check: () => {
      const r = requirePathArg(["--out", "./-figures"], "--out");
      if (!r.ok) return { caught: false, detail: `it refused a legal path: ${r.message}` };
      return { caught: true, detail: "accepted" };
    },
  },
  {
    id: "max-130-path-arg-flag-with-no-value-is-the-callers-decision",
    rule: "argument-contract",
    // `.githooks/pre-push` forwards git's `<remote-name> <remote-url>`, and a hook that forwards
    // arguments must not fail over one it was never given a value for. MAX-124's table pins this
    // end to end; here it is the property itself, and undefined is what the caller branches on.
    detail: "`[\"--report\"]` yields undefined with no refusal, so the caller can fall back",
    check: () => {
      const r = requirePathArg(["--report"], "--report");
      if (!r.ok) return { caught: false, detail: `a valueless flag was refused: ${r.message}` };
      if (r.value !== undefined) return { caught: false, detail: `value is ${JSON.stringify(r.value)}` };
      return { caught: true, detail: "ok:true, value undefined" };
    },
  },
  {
    id: "max-130-path-arg-absent-flag-is-the-callers-decision",
    rule: "argument-contract",
    detail: "`[]` and `[\"--selftest\"]` yield undefined: the flag is simply not there",
    check: () => {
      const a = requirePathArg([], "--report");
      const b = requirePathArg(["--selftest"], "--report");
      if (!a.ok || a.value !== undefined) return { caught: false, detail: "empty argv did not yield undefined" };
      if (!b.ok || b.value !== undefined) return { caught: false, detail: "an unrelated flag did not yield undefined" };
      return { caught: true, detail: "ok:true, value undefined in both" };
    },
  },
  {
    id: "max-130-path-arg-empty-value-is-not-a-flag",
    rule: "argument-contract",
    // `--report ""` is not a path either, but it is not a flag, and MAX-124's guard deliberately
    // left it to the caller's existing truthiness test. Refusing it here would change a case a
    // reviewed commit already asserted.
    detail: "`[\"--report\",\"\"]` yields the empty string, not a refusal",
    check: () => {
      const r = requirePathArg(["--report", ""], "--report");
      if (!r.ok) return { caught: false, detail: `an empty value was refused: ${r.message}` };
      if (r.value !== "") return { caught: false, detail: `value is ${JSON.stringify(r.value)}` };
      return { caught: true, detail: "ok:true, value '' -- the caller's own test decides" };
    },
  },
  {
    id: "max-130-path-arg-first-occurrence-wins",
    rule: "argument-contract",
    // Both callers use `args.indexOf(flag)`, so the helper has to mean the same thing or the
    // caller's own diff would change which token is read.
    detail: "with the flag twice, the value after the first occurrence is the one returned",
    check: () => {
      const r = requirePathArg(["--report", "first.json", "--report", "--selftest"], "--report");
      if (!r.ok) return { caught: false, detail: `refused: ${r.message}` };
      if (r.value !== "first.json") return { caught: false, detail: `value is ${JSON.stringify(r.value)}` };
      return { caught: true, detail: "the first occurrence's value" };
    },
  },
];

/**
 * Run the table. Returns rows shaped like check-content-math.mjs's own selftest rows, so that
 * harness can print and gate them with no second format to keep in sync.
 */
export function selftest() {
  const rows = CASES.map((c) => {
    let caught = false;
    let detail = "";
    try {
      const r = c.check();
      caught = Boolean(r.caught);
      detail = r.detail;
    } catch (err) {
      detail = `threw: ${err.message}`;
    }
    return { id: c.id, rule: c.rule, severity: "error", caught, detail: caught ? detail : `${c.detail} -- got: ${detail}` };
  });
  return { rows, missed: rows.filter((r) => !r.caught) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = selftest();
  console.log("require-path-arg selftest");
  for (const r of result.rows) console.log(`  ${r.caught ? "caught" : "MISSED"}  ${r.id}  (${r.rule})`);
  for (const r of result.missed) console.log(`          ${r.detail}`);
  console.log(`  self-test: ${result.rows.length - result.missed.length}/${result.rows.length} cases caught`);
  process.exit(result.missed.length ? 1 : 0);
}
