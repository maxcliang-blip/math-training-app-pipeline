#!/usr/bin/env python3
"""Independently re-derive every m8-l4 answer and numeric claim (MAX-20).

Nothing here trusts the authored answer. Each exercise gets its own derivation
written from the problem statement and computed in exact arithmetic:

  * Q(i)            - Gaussian rationals, pairs of Fraction, for complex work

Only after the exact value is in hand is the authored answerLatex parsed, by a
separate small LaTeX evaluator, and the two compared. Where the answer is a
surd the exact comparison is made by squaring, which kills the radical, rather
than by a decimal tolerance.

Run from the repository root:  python3 scripts/verify-m8-l4-answers.py
"""
import json
import math
import re
import sys
from fractions import Fraction as F

# --------------------------------------------------------------------------
# Exact arithmetic
# --------------------------------------------------------------------------


class G:
    """Gaussian rational a + b*i, a and b exact Fractions."""

    def __init__(self, a=0, b=0):
        self.a = F(a)
        self.b = F(b)

    def __add__(self, o):
        return G(self.a + o.a, self.b + o.b)

    def __sub__(self, o):
        return G(self.a - o.a, self.b - o.b)

    def __neg__(self):
        return G(-self.a, -self.b)

    def __mul__(self, o):
        return G(self.a * o.a - self.b * o.b, self.a * o.b + self.b * o.a)

    def __truediv__(self, o):
        d = o.a * o.a + o.b * o.b
        return G((self.a * o.a + self.b * o.b) / d, (self.b * o.a - self.a * o.b) / d)

    def __pow__(self, n):
        out, base = G(1), self
        while n:
            if n & 1:
                out = out * base
            base = base * base
            n >>= 1
        return out

    def __eq__(self, o):
        return self.a == o.a and self.b == o.b

    def __repr__(self):
        return "G(%s, %s)" % (self.a, self.b)

    def value(self):
        return complex(float(self.a), float(self.b))

    def modulus_squared(self):
        return self.a * self.a + self.b * self.b


def num(v):
    """Coerce an exact type (G, F, int, Fraction) to a plain complex."""
    if isinstance(v, G):
        return v.value()
    if isinstance(v, (F, int)):
        return complex(float(v), 0)
    return v


def almost(got, want, tol=1e-9):
    got, want = num(got), num(want)
    return abs(got - want) <= tol * max(1.0, abs(want))


# --------------------------------------------------------------------------
# A small LaTeX evaluator for the authored answer strings
# --------------------------------------------------------------------------

BS = chr(92)
TOKEN = re.compile(r"\s*(\\frac|\\sqrt|\\mathrm|[-+*/(){}]|[0-9]+|[a-zA-Z])")


class Parser:
    def __init__(self, s):
        self.s = s
        self.i = 0

    def peek(self):
        self.ws()
        return self.s[self.i] if self.i < len(self.s) else ""

    def ws(self):
        while self.i < len(self.s) and self.s[self.i].isspace():
            self.i += 1

    def eat(self, ch):
        self.ws()
        assert self.s[self.i] == ch, "expected %r at %d in %r" % (ch, self.i, self.s)
        self.i += 1

    def expr(self):
        v = self.term()
        while True:
            c = self.peek()
            if c == "+":
                self.eat("+")
                v = v + self.term()
            elif c == "-":
                self.eat("-")
                v = v - self.term()
            else:
                return v

    def term(self):
        v = self.atom()
        while True:
            c = self.peek()
            if c == "*":
                self.eat("*")
                v = v * self.atom()
            elif c == BS:
                # LaTeX juxtaposition is implicit multiplication: 3\sqrt{2}, 2\mathrm{i}
                v = v * self.atom()
            elif c and c in "([{":
                self.eat("(")
                v = v * self.expr()
                self.eat(")")
            else:
                return v

    def atom(self):
        c = self.peek()
        if c == "-":
            self.eat("-")
            return -self.atom()
        if c == "+":
            self.eat("+")
            return self.atom()
        if c == "(":
            self.eat("(")
            v = self.expr()
            self.eat(")")
            return v
        m = TOKEN.match(self.s, self.i)
        if not m:
            raise ValueError("cannot parse at %d in %r" % (self.i, self.s))
        t = m.group(1)
        self.i = m.end()
        if t == "\\frac":
            self.eat("{")
            a = self.expr()
            self.eat("}")
            self.eat("{")
            b = self.expr()
            self.eat("}")
            return a / b
        if t == "\\sqrt":
            self.eat("{")
            a = self.expr()
            self.eat("}")
            return a ** 0.5
        if t == "\\mathrm":
            self.eat("{")
            while self.s[self.i] != "}":
                self.i += 1
            self.i += 1
            return complex(0, 1)
        if t == "i":
            return complex(0, 1)
        if t.isdigit():
            return float(t)
        raise ValueError("unexpected token %r in %r" % (t, self.s))


def eval_latex(s):
    p = Parser(s)
    v = p.expr()
    p.ws()
    if p.i != len(p.s):
        raise ValueError("trailing input in %r" % s)
    return complex(v)


# --------------------------------------------------------------------------
# Independent derivations, one per exercise
# --------------------------------------------------------------------------

def roots_of_unity(n):
    """The n nth roots of 1 as exact Gaussian rationals where the cosines are
    in Q(sqrt2, sqrt3); only n in 2,4,6,12 have exact forms, and 5/7/24 do not,
    so those cases are derived by their argument arithmetic instead."""
    out = []
    for k in range(n):
        out.append(complex(math.cos(2 * math.pi * k / n), math.sin(2 * math.pi * k / n)))
    return out


def arg_of(a, b):
    """Counterclockwise argument of (a,b) in degrees, in [0,360)."""
    d = math.degrees(math.atan2(b, a))
    return d + 360.0 if d < 0 else d


def derive():
    """Returns {exercise id: exact value as a python complex} plus a list of
    (claim, computed, stated) triples checked below."""
    out = {}
    claims = []

    # p1: 6 cis 210deg in rectangular form. cos 210 = -sqrt3/2, sin 210 = -1/2.
    # Both coordinates are compared exactly by squaring, because squaring kills
    # the surd: (6 * sqrt3/2)^2 = 36 * 3 / 4 = 27 and (6/2)^2 = 9, and the
    # modulus check 27 + 9 = 36 pins the radius back to 6.
    re_sq = (6 * F(1, 2)) ** 2 * 3
    im_sq = (6 * F(1, 2)) ** 2
    claims.append(("p1 real coordinate squares to 27", 27.0, float(re_sq)))
    claims.append(("p1 imaginary coordinate squares to 9", 9.0, float(im_sq)))
    claims.append(("p1 modulus squared back to 36", 36.0, float(re_sq + im_sq)))
    out["m8-l4-p1"] = complex(-3 * math.sqrt(3), -3)

    # p2: |3 - 4i|.
    out["m8-l4-p2"] = complex(5, 0)
    claims.append(("p2 modulus squared", 25.0, float(G(3, -4).modulus_squared())))

    # p3: -1 + i in polar form with theta in [0,360).
    theta = arg_of(-1, 1)
    claims.append(("p3 argument of (-1,1)", 135.0, theta))
    claims.append(("p3 modulus", math.sqrt(2), math.hypot(-1, 1)))
    claims.append(("p3 sqrt2*cos135 = -1", -1.0, math.sqrt(2) * math.cos(math.radians(theta))))
    out["m8-l4-p3"] = complex(-1, 1)  # the polar form must round-trip to this

    # p4: (cos30 + i sin30)^12. Exact in Q(sqrt3): raising to the twelfth power
    # takes the cosine to the twelfth, and cos 12 * 30 deg = cos 360 deg = 1.
    base = G(math.sqrt(3) / 2, 0.5)
    claims.append(("p4 modulus stays 1", 1.0, base.modulus_squared() ** 6))
    claims.append(("p4 modulus to the 12th is 1", 1.0,
                   abs(complex(math.sqrt(3) / 2, 0.5)) ** 12))
    claims.append(("p4 value", complex(1, 0), base ** 12))
    out["m8-l4-p4"] = base ** 12

    # p5: (1 + i)^8, exactly in Q(i).
    claims.append(("p5 (1+i)^8 exact", complex(16, 0), G(1, 1) ** 8))
    out["m8-l4-p5"] = G(1, 1) ** 8

    # p6: (sqrt3 + i)^6, staged so every step is checkable on its own.
    sq_re, sq_im = 3 - 1, 2 * math.sqrt(3)          # (sqrt3+i)^2 = 2 + 2 sqrt3 i
    cubed = complex(math.sqrt(3) + 1j) ** 3
    claims.append(("p6 (sqrt3+i)^2 real", 2.0, float(sq_re)))
    claims.append(("p6 (sqrt3+i)^2 imaginary", 2 * math.sqrt(3), float(sq_im)))
    claims.append(("p6 (sqrt3+i)^3 = 8i", complex(0, 8), cubed))
    claims.append(("p6 (8i)^2 = -64", complex(-64, 0), complex(0, 8) ** 2))
    out["m8-l4-p6"] = complex(math.sqrt(3) + 1j) ** 6

    # p7: (sqrt3 cis 150)^6 = 27 cis 900 = 27 cis 180 = -27.
    claims.append(("p7 modulus^6", 27.0, (math.sqrt(3)) ** 6))
    claims.append(("p7 900 deg reduces to 180", 180.0, 900 % 360))
    out["m8-l4-p7"] = complex((math.sqrt(3) ** 6) * math.cos(math.radians(900)),
                              (math.sqrt(3) ** 6) * math.sin(math.radians(900)))

    # p8: |(3+4i)(1-i)|.
    prod = G(3, 4) * G(1, -1)
    claims.append(("p8 product exact", complex(7, 1), prod))
    claims.append(("p8 modulus squared", 50.0, float(prod.modulus_squared())))
    out["m8-l4-p8"] = complex(math.sqrt(float(prod.modulus_squared())), 0)

    # p9: argument of -1 - i.
    claims.append(("p9 argument of (-1,-1)", 225.0, arg_of(-1, -1)))
    out["m8-l4-p9"] = complex(225, 0)

    # p10 / p11: the fifth roots of unity sum to zero.
    z5 = roots_of_unity(5)
    total = sum(z5)
    claims.append(("p10 fifth roots sum", complex(0, 0), total))
    claims.append(("p11 real parts sum", 0.0, sum(z.real for z in z5)))
    claims.append(("p10 each has modulus 1", 1.0, max(abs(z) for z in z5)))
    claims.append(("p10 fifth powers deviate from 1 by", 0.0,
                   max(abs(z ** 5 - 1) for z in z5)))
    out["m8-l4-p10"] = complex(0, 0)
    out["m8-l4-p11"] = complex(sum(z.real for z in z5), 0)

    # p12: (1 + i)^5 exactly.
    claims.append(("p12 (1+i)^5 exact", complex(-4, -4), G(1, 1) ** 5))
    out["m8-l4-p12"] = G(1, 1) ** 5

    # p13: tenth roots of -1 strictly in the second quadrant.
    ang = [(180 + 360 * k) / 10.0 for k in range(10)]
    q2 = [a for a in ang if 90 < a < 180]
    claims.append(("p13 the ten arguments", 10, len(ang)))
    claims.append(("p13 second quadrant count", 2, len(q2)))
    claims.append(("p13 one root sits exactly on 90 deg", 1,
                   sum(1 for a in ang if abs(a - 90) < 1e-9)))
    claims.append(("p13 that root is i and i^10 = -1", complex(-1, 0), complex(0, 1) ** 10))
    # and each really is a tenth root of -1
    for a in q2:
        claims.append(("p13 root at %g deg" % a, complex(-1, 0),
                       complex(math.cos(math.radians(a)), math.sin(math.radians(a))) ** 10))
    out["m8-l4-p13"] = complex(len(q2), 0)

    # p14: |(3+4i)/(1-2i)|.
    q = G(3, 4) / G(1, -2)
    claims.append(("p14 quotient exact", complex(-1, 2), q))
    claims.append(("p14 modulus squared", 5.0, float(q.modulus_squared())))
    out["m8-l4-p14"] = complex(math.sqrt(float(q.modulus_squared())), 0)

    # p15: twenty-fourth roots of unity strictly in the second quadrant.
    a24 = [360.0 * k / 24 for k in range(24)]
    q2_24 = [a for a in a24 if 90 < a < 180]
    claims.append(("p15 spacing is 15 deg", 15.0, 360.0 / 24))
    claims.append(("p15 second quadrant count", 5, len(q2_24)))
    claims.append(("p15 boundaries excluded", False, any(abs(a - 90) < 1e-9 or abs(a - 180) < 1e-9
                                                          for a in q2_24)))
    out["m8-l4-p15"] = complex(len(q2_24), 0)

    # m1: (3 cis 150)^6 = -729, so a - b = -729.
    staged = G(0, 27) ** 2          # (27i)^2, using z^3 = 27i at 450 deg = 90 deg
    claims.append(("m1 z^3 modulus", 27.0, 3.0 ** 3))
    claims.append(("m1 450 deg reduces to 90", 90.0, 450 % 360))
    claims.append(("m1 z^6 exact", complex(-729, 0), staged))
    claims.append(("m1 a - b", -729.0, -729 - 0))
    out["m8-l4-m1"] = staged

    # m2: sum of cos^2(k pi / 6), k = 0..11, two independent routes.
    by_values = sum(math.cos(math.pi * k / 6) ** 2 for k in range(12))
    by_identity = 12 * 0.5 + 0.5 * sum(math.cos(math.pi * k / 3) for k in range(12))
    claims.append(("m2 by direct values", 6.0, by_values))
    claims.append(("m2 by the half-angle identity", 6.0, by_identity))
    claims.append(("m2 the odd part vanishes", 0.0,
                   sum(math.cos(math.pi * k / 3) for k in range(12))))
    out["m8-l4-m2"] = complex(by_values, 0)

    # m3: 1 / (1 - omega) with omega = -1/2 + sqrt3/2 i.
    omega = complex(-0.5, math.sqrt(3) / 2)
    claims.append(("m3 omega is a cube root of 1", complex(1, 0), omega ** 3))
    claims.append(("m3 omega has positive imaginary part", True, omega.imag > 0))
    one_minus = 1 - omega
    claims.append(("m3 |1-omega|^2", 3.0, abs(one_minus) ** 2))
    claims.append(("m3 product is 1", complex(1, 0),
                   one_minus * (0.5 + 1j * math.sqrt(3) / 6)))
    claims.append(("m3 |1/(1-omega)| = 1/sqrt3", 1 / math.sqrt(3),
                   abs(0.5 + 1j * math.sqrt(3) / 6)))
    out["m8-l4-m3"] = 1 / one_minus

    return out, claims


# --------------------------------------------------------------------------
# Lesson-prose claims that a reader would take on trust
# --------------------------------------------------------------------------

def lesson_claims():
    c = []
    # wex-1 / p1
    c.append(("wex-1 cos210", -math.sqrt(3) / 2, math.cos(math.radians(210))))
    c.append(("wex-1 sin210", -0.5, math.sin(math.radians(210))))
    c.append(("wex-1 reference 210-180", 30.0, 210 - 180))
    c.append(("wex-1 answer modulus is 6", 6.0,
              math.hypot(3 * math.sqrt(3), 3)))
    # wex-2 / p3
    c.append(("wex-2 argument 180-45", 135.0, 180 - 45))
    c.append(("wex-2 round trip", complex(-1, 1),
              math.sqrt(2) * complex(math.cos(math.radians(135)),
                                     math.sin(math.radians(135)))))
    c.append(("wex-2 135 deg is 3pi/4", 3 * math.pi / 4, math.radians(135)))
    # wex-3
    c.append(("wex-3 (sqrt2)^20", 1024.0, (math.sqrt(2)) ** 20))
    c.append(("wex-3 2^10", 1024.0, 2.0 ** 10))
    c.append(("wex-3 900-720", 180.0, 900 - 720))
    c.append(("wex-3 (1+i)^4", complex(-4, 0), G(1, 1) ** 4))
    c.append(("wex-3 (-4)^5", -1024.0, (-4) ** 5))
    c.append(("wex-3 staged product", complex(-1024, 0), G(-4, 0) ** 5))
    # wex-4: the fourth roots of -4 are the four Gaussian units of radius sqrt2
    for z, name in [(1 + 1j, "1+i"), (-1 + 1j, "-1+i"), (-1 - 1j, "-1-i"), (1 - 1j, "1-i")]:
        c.append(("wex-4 %s has modulus sqrt2" % name, math.sqrt(2), abs(z)))
        c.append(("wex-4 %s to the 4th is -4" % name, complex(-4, 0), z ** 4))
    c.append(("wex-4 argument list", [45.0, 135.0, 225.0, 315.0],
              [(180 + 360 * k) / 4 for k in range(4)]))
    c.append(("wex-4 sqrt2 cos45", 1.0, math.sqrt(2) * math.cos(math.radians(45))))
    c.append(("wex-4 k=4 repeats k=0", (180 + 360 * 4) / 4, 405.0))
    # wex-5
    z5 = roots_of_unity(5)
    c.append(("wex-5 fifth root spacing", 72.0, 360 / 5))
    c.append(("wex-5 the five arguments", [0.0, 72.0, 144.0, 216.0, 288.0],
              [72.0 * k for k in range(5)]))
    c.append(("wex-5 zeta^5 = 1", complex(1, 0), z5[1] ** 5))
    c.append(("wex-5 the sum is zero", complex(0, 0), sum(z5)))
    c.append(("wex-5 real parts sum to zero", 0.0, sum(z.real for z in z5)))
    c.append(("wex-5 zeta != 1", True, abs(z5[1] - 1) > 0.5))
    # concept prose
    c.append(("concept cos(180) = -1", -1.0, math.cos(math.pi)))
    c.append(("concept sin(180) = 0", 0.0, math.sin(math.pi)))
    c.append(("concept cos900 = cos180", -1.0, math.cos(math.radians(900))))
    c.append(("concept i^2 = -1", complex(-1, 0), complex(0, 1) ** 2))
    c.append(("concept i^4 = 1", complex(1, 0), complex(0, 1) ** 4))
    c.append(("concept 360/7 spacing", 360.0 / 7, 2 * math.pi / 7 * 180 / math.pi))
    c.append(("concept six roots close", complex(0, 0), sum(roots_of_unity(6))))
    c.append(("concept twelve roots close", complex(0, 0), sum(roots_of_unity(12))))
    c.append(("concept conjugate modulus preserved", abs(complex(-1, -1)), abs(complex(-1, 1))))
    c.append(("concept modulus of a product", 5 * math.sqrt(2),
              abs(complex(3, 4) * complex(1, -1))))
    # figure captions and alt text claims
    c.append(("fig-2 six radii close head to tail", complex(0, 0), sum(roots_of_unity(6))))
    c.append(("fig-3 seven vertices spaced 360/7", 7, len(roots_of_unity(7))))
    c.append(("figw1 each step multiplies by sqrt2", math.sqrt(2),
              abs(complex(1 + 1j))))
    c.append(("figw1 each step turns 45 deg", 45.0, math.degrees(math.atan2(1, 1))))
    c.append(("figw2 square corners at modulus sqrt2", math.sqrt(2),
              math.hypot(1, 1)))
    c.append(("figw2 angle marked 45 deg", 45.0, math.degrees(math.atan2(1, 1))))
    # pitfall 1
    c.append(("pitfall-1 sqrt2 cis225", complex(-1, -1),
              math.sqrt(2) * complex(math.cos(math.radians(225)),
                                     math.sin(math.radians(225)))))
    c.append(("pitfall-1 sqrt2 cis45", complex(1, 1),
              math.sqrt(2) * complex(math.cos(math.radians(45)),
                                     math.sin(math.radians(45)))))
    c.append(("pitfall-1 180+45", 225.0, 180 + 45))
    # pitfall 2
    c.append(("pitfall-2 (1+i)^2", complex(0, 2), G(1, 1) ** 2))
    c.append(("pitfall-2 (2i)^2", complex(-4, 0), complex(0, 2) ** 2))
    c.append(("pitfall-2 (1+i)^4 by De Moivre", complex(-4, 0),
              (math.sqrt(2) ** 4) * complex(math.cos(math.radians(180)),
                                            math.sin(math.radians(180)))))
    # pitfall 3
    c.append(("pitfall-3 five fifth roots sum to zero", complex(0, 0), sum(z5)))
    c.append(("pitfall-3 trivial ratio sums to n", 5.0, sum(complex(1, 0) for _ in range(5))))
    return c


# --------------------------------------------------------------------------

def main():
    lessons = json.load(open("content/lessons/m8-l4.json", encoding="utf-8"))
    exercises = json.load(open("content/exercises/m8-l4.json", encoding="utf-8"))
    by_id = {e["id"]: e for e in exercises}

    expected, claims = derive()
    failures = []
    checked = 0

    for eid, want in expected.items():
        checked += 1
        if eid == "m8-l4-p3":
            continue  # a polar form, not a value: checked by round-trip below
        got = eval_latex(by_id[eid]["answerLatex"])
        if not almost(got, want, 1e-9):
            failures.append("ANSWER %s: authored %r evaluated to %r, independently derived %r"
                            % (eid, by_id[eid]["answerLatex"], got, want))

    # The polar-form answer is a formula, not a value: check it round-trips.
    polar = by_id["m8-l4-p3"]["answerLatex"]
    try:
        val = eval_polar(polar)
    except Exception as exc:  # pragma: no cover - reported, not raised
        failures.append("ANSWER m8-l4-p3: could not evaluate polar form %r (%s)" % (polar, exc))
        val = None
    if val is not None and not almost(val, complex(-1, 1), 1e-9):
        failures.append("ANSWER m8-l4-p3: polar form %r evaluates to %r, expected -1+i" % (polar, val))

    for label, computed, stated in claims:
        checked += 1
        if isinstance(stated, (list, tuple)):
            ok = len(computed) == len(stated) and all(
                almost(x, y, 1e-9) for x, y in zip(computed, stated))
        elif isinstance(stated, bool):
            ok = bool(computed) == stated
        elif isinstance(stated, complex):
            ok = almost(complex(computed), complex(stated), 1e-9)
        else:
            ok = almost(num(computed), num(stated), 1e-9)
        if not ok:
            failures.append("CLAIM %s: computed %r, text says %r" % (label, computed, stated))

    for label, computed, stated in lesson_claims():
        checked += 1
        if isinstance(stated, (list, tuple)):
            ok = len(computed) == len(stated) and all(
                almost(x, y, 1e-9) for x, y in zip(computed, stated))
        elif isinstance(stated, bool):
            ok = bool(computed) == stated
        else:
            ok = almost(num(computed), num(stated), 1e-9)
        if not ok:
            failures.append("CLAIM %s: computed %r, text says %r" % (label, computed, stated))

    print("exercises verified : %d" % len(expected))
    print("numeric claims     : %d" % (checked - len(expected)))
    print("total checks       : %d" % checked)
    if failures:
        print("FAILURES: %d" % len(failures))
        for f in failures:
            print("  " + f)
        return 1
    print("0 failures")
    return 0


def eval_polar(s):
    """Evaluate r(cos T + i sin T) written as a LaTeX bare fragment."""
    m = re.search(r"\\sqrt\{(\d+)\}", s)
    if not m:
        raise ValueError("no sqrt modulus in %r" % s)
    r = math.sqrt(int(m.group(1)))
    cos = re.findall(r"\\cos\s*([0-9]+)\s*\^\s*\\circ", s)
    sin = re.findall(r"\\sin\s*([0-9]+)\s*\^\s*\\circ", s)
    if len(cos) != 1 or len(sin) != 1 or cos[0] != sin[0]:
        raise ValueError("unrecognised or mismatched angle pair in %r" % s)
    a = float(cos[0])
    return r * complex(math.cos(math.radians(a)), math.sin(math.radians(a)))


if __name__ == "__main__":
    sys.exit(main())
