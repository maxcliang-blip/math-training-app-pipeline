#!/usr/bin/env python3
"""Corpus-wide audit: does every `answerLatex` follow from its own `solutionLatex`?

This is the numeric verification layer, not the content gate. The gate in
`preflight-content.mjs` is a static checker: it proves `answerLatex` is a bare
fragment, that a multiple-choice answer equals one of its choices, and that a
relational answer declares its alternatives. It cannot tell whether the answer
is the value the derivation reaches, so a record can pass the gate and still
mark a correct submission wrong. This script closes that gap by reading the
derivation.

Method
------
For every record with a numeric `answerLatex` and a `solutionLatex`:

1. Harvest every arithmetic claim in the solution, from three sources:
     - inline `$...$` and display `$$...$$` / `\\[...\\]` math spans,
     - bare-prose arithmetic equalities (`12 + 10 - 2 = 20`), which several
       m7 records use instead of math delimiters,
     - the same claims inside `hintLatex`, as a weaker corroborating signal.
2. Split each claim on top-level `=`, `\\implies`, `\\iff` and evaluate every
   side with `latexnum.to_number`.
3. Mark a claim as *consumed* when its text reappears, token-bounded, inside a
   later claim. Unconsumed claims are the values the derivation lands on.

Verdicts
--------
`agrees`            the answer is a value the derivation lands on.
`agrees-narrated`   the answer is a count the prose states in words
                    ("two distinct triangles"), with no digits to match.
`unreachable`       FINDING. The derivation is arithmetically sound and never
                    produces the answer. This is the m7-l2 bug class: the
                    answer contradicts the derivation in its own record.
`intermediate`      FINDING. The answer appears only as a value the derivation
                    consumes on the way somewhere else, so the solution never
                    lands on it.
`broken-chain`      FINDING. An `a = b` claim inside the solution is false, so
                    the derivation contradicts itself and the comparison above
                    it is not meaningful.
`no-arithmetic`     FINDING. The solution has no evaluable arithmetic at all,
                    so nothing could be checked. Needs a human read.
`not-numeric`       the answer is an interval, a function, a complex number or
                    a proof verdict. Out of scope for a numeric comparison.

Nothing here writes to the corpus. A wrong answer is a content change and gets
the same review as any other content change.

Usage
-----
    python3 scripts/verify-answers-vs-solutions.py
    python3 scripts/verify-answers-vs-solutions.py --json
    python3 scripts/verify-answers-vs-solutions.py --selftest

Exits 1 when any `unreachable` or `broken-chain` finding survives, so it can sit
in CI as a numeric guard without ever editing content.
"""
import argparse
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from latexnum import to_number  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOL = 1e-9

MATH_SPAN = re.compile(r"\$\$(.+?)\$\$|\\\[(.+?)\\\]|\$([^$\n]+?)\$", re.S)
SEPS = ("\\implies", "\\iff", "\\Rightarrow", "\\to", "=")
# A bare-prose claim: digits, operators, brackets, braces, spaces and LaTeX
# macros, with `=` in the middle. Several m7 records state their arithmetic
# outside math delimiters, e.g. "12 + 10 - 2 = 20" and "\binom{7}{2} = 21", and
# a checker that only reads $...$ spans cannot see those at all. Ordinary prose
# is excluded because letters other than a leading backslash are not in the
# alphabet, and a claim may not run past the end of its line. Whatever still
# slips through is discarded unless two or more of its sides evaluate, so a
# lone number in a sentence can never register as a step.
#
# NB the class is built without a raw string, because r"...\u2308..." would put
# the six characters \ u 2 3 0 8 in the class and let plain prose through.
_CLAIM_CHARS = "0-9+\\-*/().{}\\[\\]\u2308\u2309\u230a\u230b \t"
_ATOM = "(?:\\\\[A-Za-z]+|[" + _CLAIM_CHARS + "])"
# lazy on the left so the chain starts at the first `=`, greedy after, and
# repeated so that `a = b = c` is captured whole rather than split in two
BARE_ARITH = re.compile(_ATOM + "*?=" + _ATOM + "*(?:=" + _ATOM + "*)*")
WORDY = re.compile(r"[A-Za-z0-9]")

# Small counts the prose may state in words where the digits never appear.
NUMBER_WORDS = {
    0: ("no", "none", "zero"), 1: ("one", "once", "single"), 2: ("two", "twice", "both", "a pair"),
    3: ("three", "triple"), 4: ("four",), 5: ("five",), 6: ("six",), 7: ("seven",), 8: ("eight",),
    9: ("nine",), 10: ("ten",), 11: ("eleven",), 12: ("twelve", "a dozen"),
    15: ("fifteen",), 20: ("twenty",),
}

# Answers that MAX-29 corrected. Recorded so the detector can be shown to fire
# on the defect class it exists to catch, not merely to pass on a clean corpus.
REGRESSION = {
    "m7-l2-m1": "45", "m7-l2-m2": "10", "m7-l2-m3": "17",
    "m7-l2-p10": "17", "m7-l2-p11": "19",
}

FINDINGS = ("unreachable", "intermediate", "broken-chain", "no-arithmetic")
BLOCKING = ("unreachable", "broken-chain")


# --------------------------------------------------------------- corpus
def load_corpus(repo):
    """id -> record, exercises first, then fixtures. First file wins."""
    recs = {}
    for pattern in ("content/exercises/*.json", "content/fixtures/*.json"):
        for path in sorted(glob.glob(os.path.join(repo, pattern))):
            data = json.load(open(path))
            for e in (data if isinstance(data, list) else [data]):
                recs.setdefault(e["id"], e)
    return recs


# --------------------------------------------------------------- parsing
def split_top_level(s):
    """Split on =, \\implies, \\iff, \\Rightarrow, \\to at bracket depth 0."""
    parts, buf, depth, i = [], [], 0, 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            buf.append(s[i:i + 2])
            i += 2
            continue
        if c in "{([":
            depth += 1
        elif c in "})]":
            depth -= 1
        if depth == 0:
            hit = next((sep for sep in SEPS if s.startswith(sep, i)), None)
            if hit:
                parts.append("".join(buf))
                buf = []
                i += len(hit)
                continue
        buf.append(c)
        i += 1
    parts.append("".join(buf))
    return parts


def ev(fragment):
    try:
        return to_number(fragment)
    except Exception:
        return None


def close(a, b):
    return abs(a - b) <= TOL * max(1.0, abs(a), abs(b))


def norm(s):
    return re.sub(r"\s+", "", s)


def consumed_by(raw, later):
    """True when `raw` reappears as a standalone token inside `later`.

    Token-bounded, so the claim `40` is not treated as consumed by `40x^{2}`.
    """
    r = norm(raw)
    if not r:
        return False
    return bool(re.search(r"(?<![A-Za-z0-9])" + re.escape(r) + r"(?![A-Za-z0-9])", later))


def context_of(text, pos):
    """The line of `text` around offset `pos`, trimmed, for reporting."""
    start = text.rfind("\n", 0, pos) + 1
    end = text.find("\n", pos)
    line = text[start:end if end != -1 else len(text)].strip()
    return line[:150]


def claims(text):
    """Every arithmetic claim in `text`, in document order.

    Math spans contribute each of their top-level segments. The prose left
    between the spans contributes only claims that are pure arithmetic, so a
    stray digit in a sentence is never mistaken for a step. Each claim records
    the line it came from, so a finding can name the step that diverges.
    """
    out = []
    spans = []
    for m in MATH_SPAN.finditer(text):
        body = m.group(1) or m.group(2) or m.group(3)
        spans.append((m.start(), m.end()))
        for seg in split_top_level(body):
            seg = seg.strip()
            if seg:
                out.append({"raw": seg, "val": ev(seg), "source": "math",
                            "line": context_of(text, m.start())})
    chunks, prev = [], 0
    for s0, s1 in spans:
        chunks.append((prev, s0))
        prev = s1
    chunks.append((prev, len(text)))
    for c0, c1 in chunks:
        chunk = text[c0:c1]
        for m in BARE_ARITH.finditer(chunk):
            sides = [s.strip().strip(" .,;:") for s in split_top_level(m.group(0))]
            values = [ev(s) for s in sides if s]
            # A real equation has at least two sides that evaluate. One that
            # merely reads `\lceil 14.2857... \rceil = 15` still counts, because
            # the unevaluable middle is skipped rather than disqualifying it.
            if sum(v is not None for v in values) < 2:
                continue
            for side, v in zip(sides, values):
                if v is not None:
                    out.append({"raw": side, "val": v, "source": "prose",
                                "line": context_of(text, c0 + m.start())})
    return out


def chains(text):
    """Per-span equality chains.

    A chain is only *broken* when a pair of adjacent sides both evaluate and
    disagree. A side that will not evaluate (`x' + y' + z + w = 5`) leaves the
    pair unchecked, which is not the same as a false equality.
    """
    out = []
    for m in MATH_SPAN.finditer(text):
        body = m.group(1) or m.group(2) or m.group(3)
        segs = [s.strip() for s in split_top_level(body) if s.strip()]
        vals = [ev(s) for s in segs]
        broken = [(segs[i], segs[i + 1], vals[i], vals[i + 1])
                  for i in range(len(segs) - 1)
                  if vals[i] is not None and vals[i + 1] is not None and not close(vals[i], vals[i + 1])]
        out.append({"body": body.strip(), "segs": segs, "vals": vals, "broken": broken})
    return out


def narrative_match(sol, val):
    """A small integer the prose states in words, e.g. 'two distinct triangles'."""
    if abs(val - round(val)) > 1e-12 or not 0 <= val <= 20:
        return None
    for word in NUMBER_WORDS.get(int(round(val)), ()):
        if re.search(r"\b%s\b" % re.escape(word), sol, re.I):
            return word
    return None


# --------------------------------------------------------------- verdict
def audit(ex):
    sol = ex.get("solutionLatex") or ""
    try:
        answer = to_number(ex["answerLatex"])
    except Exception as exc:
        return {"verdict": "not-numeric", "why": str(exc)[:70]}

    steps = claims(sol)
    for i, s in enumerate(steps):
        later = "".join(norm(t["raw"]) for t in steps[i + 1:])
        s["consumed"] = consumed_by(s["raw"], later)
    reached = [s for s in steps if s["val"] is not None]
    sinks = [s for s in reached if not s["consumed"]]

    out = {
        "answer": answer,
        "answerLatex": ex["answerLatex"],
        "reached": [{"raw": s["raw"], "val": s["val"], "line": s["line"]} for s in reached],
        "sinks": [{"raw": s["raw"], "val": s["val"], "line": s["line"]} for s in sinks],
    }

    if not reached:
        out["verdict"] = "no-arithmetic"
        out["why"] = "solutionLatex contains no evaluable arithmetic"
        return out

    broken = [c for c in chains(sol) if c["broken"]]
    if broken:
        out["verdict"] = "broken-chain"
        seg_a, seg_b, va, vb = broken[0]["broken"][0]
        out["why"] = "`%s = %s` evaluates to %s, not %s" % (seg_a, seg_b, fmt(va), fmt(vb))
        out["broken"] = broken
        return out

    if any(close(s["val"], answer) for s in sinks):
        out["verdict"] = "agrees"
        return out

    hit = [s for s in reached if close(s["val"], answer)]
    if hit:
        out["verdict"] = "intermediate"
        out["why"] = "the answer appears only as an intermediate value the derivation moves past"
        out["where"] = hit[0]["line"]
        return out

    word = narrative_match(sol, answer)
    if word:
        out["verdict"] = "agrees-narrated"
        out["why"] = "the solution states the count in words (%r), with no digits to match" % word
        return out

    out["verdict"] = "unreachable"
    out["why"] = "the derivation lands on %s" % (
        ", ".join("%s = %g" % (s["raw"], s["val"]) for s in sinks[-4:]) or "no terminal value")
    if sinks:
        out["where"] = sinks[-1]["line"]
    return out


# --------------------------------------------------------------- reporting
def fmt(x):
    return ("%.10g" % x) if isinstance(x, float) else str(x)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--json", action="store_true", help="emit the full result as JSON")
    ap.add_argument("--ids", help="comma-separated exercise ids to report in full")
    ap.add_argument("--selftest", action="store_true",
                    help="replay the five pre-MAX-29 wrong answers and assert each is caught")
    args = ap.parse_args()

    recs = load_corpus(REPO)
    if args.selftest:
        return selftest(recs)

    results = {eid: audit(e) for eid, e in sorted(recs.items())}
    tally = {}
    for r in results.values():
        tally[r["verdict"]] = tally.get(r["verdict"], 0) + 1

    findings = {k: [eid for eid, r in results.items() if r["verdict"] == k] for k in FINDINGS}

    if args.json:
        print(json.dumps({"tally": tally, "results": results}, indent=2, sort_keys=True))
        return 0

    free = sum(1 for e in recs.values() if not e.get("choices"))
    print("audited %d records (%d free-response, %d multiple-choice)" % (len(recs), free, len(recs) - free))
    for v in sorted(tally, key=lambda k: -tally[k]):
        print("  %-18s %d" % (v, tally[v]))

    for kind in FINDINGS:
        ids = findings[kind]
        print("\n=== %s (%d)" % (kind, len(ids)))
        for eid in ids:
            r = results[eid]
            print("  %-14s answerLatex=%-22s parsed=%s" % (eid, r.get("answerLatex", "?"),
                                                          fmt(r["answer"]) if "answer" in r else "-"))
            if r.get("why"):
                print("      why: %s" % r["why"])
            if r.get("where"):
                print("      at:  %s" % r["where"])
            for s in r.get("sinks", [])[-3:]:
                print("      final claim: %s = %s" % (s["raw"], fmt(s["val"])))
            if kind == "intermediate" and r.get("reached"):
                print("      reached: %s" % ", ".join(fmt(s["val"]) for s in r["reached"][:16]))

    if args.ids:
        print("\n=== requested records")
        for eid in [x.strip() for x in args.ids.split(",")]:
            print("  %s: %s" % (eid, json.dumps(results.get(eid, {"verdict": "unknown"}))))

    return 1 if any(findings[k] for k in BLOCKING) else 0


def selftest(recs):
    """The detector must fire on the defect class, not just pass a clean corpus.

    Each entry in REGRESSION is the wrong answer MAX-29 removed, paired with the
    record's own solution. Feeding the wrong answer back in must produce
    `unreachable`; the current answer must not.
    """
    bad = 0
    for eid, wrong in sorted(REGRESSION.items()):
        ex = recs.get(eid)
        if ex is None:
            print("FAIL %s: not in the corpus" % eid)
            bad += 1
            continue
        shadow = dict(ex, answerLatex=wrong)
        got = audit(shadow)["verdict"]
        now = audit(ex)["verdict"]
        ok = got == "unreachable" and now != "unreachable"
        bad += not ok
        print("%s %-12s wrong answer %-4s -> %-12s | current answer -> %s"
              % ("ok  " if ok else "FAIL", eid, wrong, got, now))
    print("\n%s" % ("selftest passed" if not bad else "%d selftest failure(s)" % bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
