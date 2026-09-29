#!/usr/bin/env python3
"""Independent recomputation of every m8 answer.

Does not trust the shipped solution. Each exercise's `answerLatex` is parsed
into a number by the small evaluator below, then compared against a value
derived here by a different route (closed forms, exact rationals, law of
cosines). A transcription error in the content or in the solution shows up as
a mismatch.
"""
import glob
import json
import math
import os
import re
import sys
from fractions import Fraction

REPO = "/home/opc/math-training-app"
TOL = 1e-9
PI = math.pi


# --------------------------------------------------------------- latex -> py
def latex_to_py(s):
    s = s.strip()
    s = s.replace("\\left", "").replace("\\right", "").replace("\\middle", "")
    s = s.replace("\\dfrac", "\\frac").replace("\\tfrac", "\\frac")
    s = s.replace("\\cdot", "*").replace("\\times", "*")
    s = s.replace("^\\circ", "").replace("^{\\circ}", "")
    s = s.replace("\\pi", "PI")
    s = s.replace("\\sqrt", "@")
    s = s.replace("\\,", "").replace("\\!", "").replace("\\;", "").replace("~", "")
    # \frac{a}{b} -> (a)/(b); braces become parens first, then the name is dropped
    s = s.replace("\\frac", "@f")
    s = s.replace("{", "(").replace("}", ")")
    s = s.replace("\\", "")
    # @f(a)(b) -> (a)/(b)
    out = []
    i = 0
    while i < len(s):
        if s.startswith("@f(", i):
            depth = 0
            j = i + 2
            start_num = j + 1
            while j < len(s) and depth:
                if s[j] == "(":
                    depth += 1
                elif s[j] == ")":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            num = s[start_num:j]
            j += 1
            if j < len(s) and s[j] == "(":
                depth = 0
                k = j + 1
                start_den = j + 1
                while k < len(s) and depth:
                    if s[k] == "(":
                        depth += 1
                    elif s[k] == ")":
                        depth -= 1
                        if depth == 0:
                            break
                    k += 1
                den = s[start_den:k]
                out.append(f"(({num})/({den}))")
                i = k + 1
                continue
            out.append(f"({num})")
            i = j
            continue
        out.append(s[i])
        i += 1
    return "".join(out)


def to_number(latex):
    """Evaluate a bare LaTeX numeric fragment. Returns a float."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from latexnum import to_number as tn
    return tn(latex)


# --------------------------------------------------------------- exact tools
def surd(a, b=0, c=1):
    """a + b*sqrt(c), exact as a pair so near-equalities cannot hide."""
    return (Fraction(a), Fraction(b), Fraction(c))


def surd_val(s):
    a, b, c = s
    return float(a) + float(b) * math.sqrt(float(c))


# ------------------------------------------------------------------- checks
def build_checks():
    """id -> (recomputed float, how it was derived)."""
    ch = {}

    # ---------------- m8-l1 ----------------
    ch["m8-l1-p1"] = (5 * PI / 6, "150/360 of 2pi")
    ch["m8-l1-p2"] = (math.cos(math.radians(300)), "cos 300 deg")
    ch["m8-l1-p3"] = (0.0, "placeholder, qualitative")   # compared as text
    ch["m8-l1-p4"] = (9 * 2 * PI / 3, "r*theta with r=9")
    ch["m8-l1-p5"] = (PI * 25 / 4, "quarter of pi*25")
    ch["m8-l1-p6"] = (0.5 * 64 * 5 * PI / 3, "half r^2 theta")
    ch["m8-l1-p7"] = (70.0, "250-180")
    ch["m8-l1-p8"] = (-math.sqrt(1 - Fraction(9, 25)), "-(4/5) from pythagoras")
    ch["m8-l1-p9"] = (-math.sqrt(1 - Fraction(25, 169)), "-(12/13) from pythagoras")
    ch["m8-l1-p10"] = (2 / math.sqrt(13), "2/sqrt(13) from a 2:3 triangle")
    ch["m8-l1-p11"] = (Fraction(4, 5) / Fraction(-3, 5), "tan from sin/cos")
    ch["m8-l1-p12"] = (math.sin(math.radians(210)), "sin 210 deg")
    ch["m8-l1-p13"] = (math.tan(math.radians(210)), "tan 210 deg")
    ch["m8-l1-p14"] = (6 * PI / (2 * PI / 3), "s/theta")
    ch["m8-l1-p15"] = (-math.sqrt(1 - Fraction(3, 4)), "-(1/2) from pythagoras")
    ch["m8-l1-m1"] = (PI * 16 / 3, "third of pi*16")
    ch["m8-l1-m2"] = (math.sin(math.radians(30) + math.radians(270)), "sin(30+270)")
    ch["m8-l1-m3"] = (8 * (24 * PI / 32), "r*theta with theta from the area")

    # ---------------- m8-l2 ----------------
    # p1 sin 2x with sin x=3/5 cos x=4/5
    ch["m8-l2-p1"] = (2 * Fraction(3, 5) * Fraction(4, 5), "2 sin x cos x")
    # p2 sin x cos x with sin x = cos x = sqrt2/2
    ch["m8-l2-p2"] = (Fraction(2, 4), "sqrt2/2 squared")
    # p3 (1-cos^2 x)/sin x  -> sin x = 3/5
    ch["m8-l2-p3"] = (Fraction(3, 5), "reduces to sin x")
    # p4 cos 2x with cos x=4/5 sin x=3/5
    ch["m8-l2-p4"] = (2 * Fraction(16, 25) - 1, "2cos^2 - 1")
    # p5 tan 2x with tan x = 3/4
    t = Fraction(3, 4)
    ch["m8-l2-p5"] = (2 * t / (1 - t * t), "2t/(1-t^2)")
    # p6 sec^2 x given tan x = 3/4
    ch["m8-l2-p6"] = (1 + Fraction(9, 16), "1 + tan^2")
    # p7 sin(x+y) with (3/5,4/5) and (5/13,12/13)
    ch["m8-l2-p7"] = (Fraction(3, 5) * Fraction(12, 13) + Fraction(4, 5) * Fraction(5, 13),
                      "sin x cos y + cos x sin y")
    # p8 cos(x-y) same data
    ch["m8-l2-p8"] = (Fraction(4, 5) * Fraction(12, 13) + Fraction(3, 5) * Fraction(5, 13),
                      "cos x cos y + sin x sin y")
    # p9 exact value of sin 75 deg
    ch["m8-l2-p9"] = (math.sin(math.radians(75)), "sin 75 deg")
    # p10 exact value of cos 105 deg
    ch["m8-l2-p10"] = (math.cos(math.radians(105)), "cos 105 deg")
    # p11 (1+cos x)/(1-cos x) with cos x = 3/5
    ch["m8-l2-p11"] = ((1 + Fraction(3, 5)) / (1 - Fraction(3, 5)), "direct ratio")
    # p12 (cos x + sin x)(cos x - sin x)
    ch["m8-l2-p12"] = (Fraction(16, 25) - Fraction(9, 25), "cos^2 - sin^2")
    # p13 (1+cos x)/sin x with sin x=12/13 cos x=5/13
    ch["m8-l2-p13"] = ((1 + Fraction(5, 13)) / (Fraction(12, 13)), "direct ratio")
    # p14 smallest positive x in (0,pi) with sin 2x = 0
    ch["m8-l2-p14"] = (PI / 2, "2x = k pi")
    # p15 cos 2x given tan x = 1/2, cos x > 0
    ch["m8-l2-p15"] = ((1 - Fraction(1, 4)) / (1 + Fraction(1, 4)), "(1-t^2)/(1+t^2)")
    # m1 sin 2x from sin x - cos x = 1/2
    ch["m8-l2-m1"] = (1 - Fraction(1, 4), "1 - (1/2)^2")
    # m2 cos 2x with sin x = 5/13, cos x = 12/13
    ch["m8-l2-m2"] = (Fraction(144, 169) - Fraction(25, 169), "cos^2 - sin^2")
    # m3 exact value of sin 15 deg
    ch["m8-l2-m3"] = (math.sin(math.radians(15)), "sin 15 deg")

    # ---------------- m8-l3 ----------------
    def cl(a_, b_, C):
        return a_ * a_ + b_ * b_ - 2 * a_ * b_ * math.cos(math.radians(C))

    def area(a_, b_, C):
        return 0.5 * a_ * b_ * math.sin(math.radians(C))

    # p1 law of cosines, a=3 b=8 C=60
    ch["m8-l3-p1"] = (math.sqrt(cl(3, 8, 60)), "sqrt(a^2+b^2-2ab cos C)")
    # p2 a=3 b=5 C=120
    ch["m8-l3-p2"] = (math.sqrt(cl(3, 5, 120)), "sqrt(a^2+b^2-2ab cos C)")
    # p3 area a=5 b=8 C=120
    ch["m8-l3-p3"] = (area(5, 8, 120), "half ab sin C")
    # p4 area a=6 b=8 C=45
    ch["m8-l3-p4"] = (area(6, 8, 45), "half ab sin C")
    # p5 sine law a=6 A=30 B=90 -> b
    ch["m8-l3-p5"] = (6 / math.sin(math.radians(30)) * math.sin(math.radians(90)), "a/sin A * sin B")
    # p6 sine law a=6 A=45 C=90 -> b
    ch["m8-l3-p6"] = (6 / math.sin(math.radians(45)) * math.sin(math.radians(90)), "a/sin A * sin C")
    # p7 angle sum 80 + 60 -> C = 40
    ch["m8-l3-p7"] = (180 - 80 - 60, "angle sum")
    # p8 chord 2R sin 30 with R=10
    ch["m8-l3-p8"] = (2 * 10 * math.sin(math.radians(30)), "2R sin theta")
    # p9 a = 2R with R=13 -> A = 90
    ch["m8-l3-p9"] = (90.0, "chord equals diameter")
    # p10 SSS 7, 8, 13 -> angle between 7 and 8
    ch["m8-l3-p10"] = (math.degrees(math.acos((49 + 64 - 169) / (2 * 7 * 8))), "acos of (a^2+b^2-c^2)/2ab")
    # p11 SSA count: a=5 A=30 b=6 -> two triangles
    ch["m8-l3-p11"] = (2.0, "both sine branches pass the angle-sum test")
    # p12 cyclic quadrilateral angle
    ch["m8-l3-p12"] = (180 - 110, "opposite angles supplementary")
    # p13 SSA count: a=5 A=30 b=9 -> two triangles
    ch["m8-l3-p13"] = (2.0, "both sine branches pass the angle-sum test")
    # p14 sin of the opposite angle of 60
    ch["m8-l3-p14"] = (math.sin(math.radians(120)), "sin of a supplementary angle")
    # p15 sides 5, 6, 7 -> area via Heron, times 2*longest
    ss = (5 + 6 + 7) / 2
    heron = math.sqrt(ss * (ss - 5) * (ss - 6) * (ss - 7))
    ch["m8-l3-p15"] = (heron * 14, "Heron area times twice the longest side")
    # m1 circumradius 10, side 10 sqrt 3 -> A = 120
    ch["m8-l3-m1"] = (120.0, "longest side forces the obtuse branch")
    # m2 cyclic quadrilateral total area, sides 6 and 9 at 120
    ch["m8-l3-m2"] = (2 * area(6, 9, 120), "two triangles, equal sines")
    # m3 right triangle 7, 13: c^2 + 4K
    ch["m8-l3-m3"] = (cl(7, 13, 90) + 4 * area(7, 13, 90), "c^2 + 4K at a right angle")

    return ch


QUALITATIVE = {"m8-l1-p3"}

# lesson worked-example and prose claims, keyed by a label
PROSE = [
    ("wex1 sin(4pi/3)", -math.sqrt(3) / 2, math.sin(math.radians(240))),
    ("wex2 cos from sin 3/5 QII", -4 / 5, -math.sqrt(1 - 9 / 25)),
    ("wex3 arc r6 th2pi/3", 4 * PI, 6 * 2 * PI / 3),
    ("wex3 sector r6 th2pi/3", 12 * PI, 0.5 * 36 * 2 * PI / 3),
    ("wex3 sector is a third of the disk", 12 * PI, (1 / 3) * PI * 36),
    ("prose tan 30", 1 / math.sqrt(3), math.tan(math.radians(30))),
    ("prose tan 60", math.sqrt(3), math.tan(math.radians(60))),
    ("prose tan 45", 1.0, math.tan(math.radians(45))),
    ("prose sin 30", 0.5, math.sin(math.radians(30))),
    ("prose cos 30", math.sqrt(3) / 2, math.cos(math.radians(30))),
    ("prose sin 60", math.sqrt(3) / 2, math.sin(math.radians(60))),
    ("prose sin 45", math.sqrt(2) / 2, math.sin(math.radians(45))),
    ("prose ref angle of 5pi/3", PI / 3, 2 * PI - 5 * PI / 3),
    ("prose ref angle of 7pi/6", PI / 6, 7 * PI / 6 - PI),
    ("prose half-turn arc is half the circumference", 6 * PI, (2 * PI * 6) / 2),
    ("prose 90 deg arc r=6 is 3pi", 3 * PI, 6 * PI / 2),
    ("prose sin 2x at x=30 deg is sin 60", math.sin(math.radians(60)), 2 * 0.5 * math.sqrt(3) / 2),
    ("prose l2 wex1 sin 75", (math.sqrt(6) + math.sqrt(2)) / 4, math.sin(math.radians(75))),
    ("prose l2 wex2 cos2x from cos=3/5", -7 / 25, 2 * (3 / 5) ** 2 - 1),
    ("prose l2 wex2 sin x from cos=3/5", 4 / 5, math.sqrt(1 - 9 / 25)),
    ("prose l2 wex2 sin2x from 3/5,4/5", 24 / 25, 2 * (3 / 5) * (4 / 5)),
    ("prose l2 m2 cos2x from 5/13,12/13", 119 / 169, (12 / 13) ** 2 - (5 / 13) ** 2),
    ("prose l2 m2 sin2x is 120/169", 120 / 169, 2 * (5 / 13) * (12 / 13)),
    ("prose l2 m2 identity holds", 1.0, (119 ** 2 + 120 ** 2) / 169 ** 2),
    ("prose l2 p5 tan2x direct", 24 / 7, (2 * (3 / 5) * (4 / 5)) / ((16 - 9) / 25)),
    ("prose l2 p13 half-angle check", 2 / 3, math.sqrt((1 - 5 / 13) / (1 + 5 / 13))),
    ("prose l2 p11 half-angle check", 1 / 2, math.sqrt((1 - 3 / 5) / (1 + 3 / 5))),
    ("prose l2 p2 sin2x is 1", 1.0, 2 * 0.5),
]


def main():
    checks = build_checks()
    records = {}

    for path in sorted(glob.glob(os.path.join(REPO, "content", "exercises", "m8-l*.json"))):
        for e in json.load(open(path)):
            records[e["id"]] = e
    for path in sorted(glob.glob(os.path.join(REPO, "content", "fixtures", "*.json"))):
        for e in json.load(open(path)):
            records.setdefault(e["id"], e)

    fails = []
    for eid, (expected, how) in sorted(checks.items()):
        e = records.get(eid)
        if e is None:
            fails.append(f"{eid}: not found in the corpus")
            print(f"FAIL {eid}: MISSING")
            continue
        if eid in QUALITATIVE:
            print(f"skip {eid}: qualitative answer, compared as text by the linter")
            continue
        try:
            got = to_number(e["answerLatex"])
        except Exception as exc:  # noqa: BLE001
            fails.append(f"{eid}: could not evaluate {e['answerLatex']!r}: {exc}")
            print(f"FAIL {eid}: unparsable {e['answerLatex']!r} ({exc})")
            continue
        exp = float(expected)
        if abs(got - exp) <= TOL * max(1.0, abs(exp)):
            print(f"ok   {eid}: {got:.10g} == {exp:.10g}  ({how})")
        else:
            msg = f"{eid}: authored {got:.10g} but recomputed {exp:.10g} ({how})"
            fails.append(msg)
            print(f"FAIL {msg}")

    print()
    for label, a, b in PROSE:
        if abs(a - b) <= TOL * max(1.0, abs(b)):
            print(f"ok   {label}: {a:.10g} == {b:.10g}")
        else:
            msg = f"{label}: {a} != {b}"
            fails.append(msg)
            print(f"FAIL {msg}")

    print(f"\n{len(fails)} failure(s)")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
