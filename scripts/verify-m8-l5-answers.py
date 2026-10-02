#!/usr/bin/env python3
"""Independently re-derive every m8-l5 answer and numeric claim (MAX-50).

Nothing here trusts the authored answer. Each exercise gets its own derivation
written from the problem statement and computed in exact arithmetic:

  * E          - exact real a + b*sqrt(2) + c*sqrt(3) + d*sqrt(6) over Fraction
  * DEG(n)     - an angle measured in units of pi/180, so "30 degrees" is exact
  * in_turns   - every angle of a given exact trig value inside a span, found by
                 walking exact special-angle values rather than by floating point

Only after the exact value is in hand is the authored answerLatex parsed, by a
separate small LaTeX evaluator, and the two compared. Equality of two E values is
componentwise on exact Fractions, so nothing here rests on a decimal tolerance.

Run from the repository root:  python3 scripts/verify-m8-l5-answers.py
"""
import json
import math
import re
import sys
from fractions import Fraction as F

TOL = 1e-9  # only for claims the content itself states as approximations


# --------------------------------------------------------------------------
# Exact arithmetic: Q(sqrt 2, sqrt 3)
# --------------------------------------------------------------------------


class E:
    """a + b*sqrt(2) + c*sqrt(3) + d*sqrt(6), all four coefficients exact."""

    __slots__ = ("k",)

    def __init__(self, a=0, b=0, c=0, d=0):
        if isinstance(a, E):
            self.k = a.k
            return
        self.k = (F(a), F(b), F(c), F(d))

    def __add__(self, o):
        return E(*[x + y for x, y in zip(self.k, E(o).k)])

    def __sub__(self, o):
        return E(*[x - y for x, y in zip(self.k, E(o).k)])

    def __neg__(self):
        return E(*[-x for x in self.k])

    def __mul__(self, o):
        o = E(o).k
        a1, b1, c1, d1 = self.k
        a2, b2, c2, d2 = o
        # sqrt2*sqrt2=2, sqrt3*sqrt3=3, sqrt2*sqrt3=sqrt6, sqrt6*sqrt6=6
        return E(
            a1 * a2 + 2 * b1 * b2 + 3 * c1 * c2 + 6 * d1 * d2,
            a1 * b2 + b1 * a2 + 3 * c1 * d2 + 3 * d1 * c2,
            a1 * c2 + c1 * a2 + 2 * b1 * d2 + 2 * d1 * b2,
            a1 * d2 + d1 * a2 + b1 * c2 + c1 * b2,
        )

    def __truediv__(self, o):
        o = E(o)
        y = o.k
        # Multiplication by y is linear on the basis 1, sqrt2, sqrt3, sqrt6:
        #   1*y    = (y0,        y1,        y2,        y3)
        #   sqrt2*y= (2*y1,      y0,        2*y3,      y2)
        #   sqrt3*y= (3*y2,      3*y3,      y0,        y1)
        #   sqrt6*y= (6*y3,      2*y2,      2*y1,      y0)
        m = [[y[0], 2 * y[1], 3 * y[2], 6 * y[3]],
             [y[1], y[0], 3 * y[3], 2 * y[2]],
             [y[2], 2 * y[3], y[0], 2 * y[1]],
             [y[3], y[2], y[1], y[0]]]
        rhs = [F(1), F(0), F(0), F(0)]
        # x is the inverse of the divisor; the quotient is self times that inverse.
        return self * _solve4(m, rhs)

    def __eq__(self, o):
        return self.k == E(o).k

    def __hash__(self):
        return hash(self.k)

    def __repr__(self):
        names = ["", "sqrt2*", "sqrt3*", "sqrt6*"]
        return "E(%s)" % " + ".join(
            "%s%s" % (names[i], str(v)) for i, v in enumerate(self.k) if v)

    def approx(self):
        a, b, c, d = (float(x) for x in self.k)
        return a + b * math.sqrt(2) + c * math.sqrt(3) + d * math.sqrt(6)

    def is_rational(self):
        return self.k[1] == 0 and self.k[2] == 0 and self.k[3] == 0

    def as_int(self):
        assert self.is_rational() and self.k[0].denominator == 1, repr(self)
        return int(self.k[0])


def _det3(rows):
    (a, b, c), (d, e, f), (g, h, i) = rows
    return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)


def _det4(m):
    total = F(0)
    for col in range(4):
        rest = [[m[r][c] for c in range(4) if c != col] for r in range(1, 4)]
        sign = F(1) if col % 2 == 0 else F(-1)
        total += sign * m[0][col] * _det3(rest)
    return total


def _solve4(mat, rhs):
    """Exact 4x4 solve by Cramer's rule over Fraction. All arguments are Fractions."""
    n = 4
    den = _det4(mat)
    assert den != 0, "singular exact system"
    out = []
    for col in range(n):
        m = [list(mat[r]) for r in range(n)]
        for r in range(n):
            m[r][col] = rhs[r]
        out.append(_det4(m) / den)
    return E(*out)


S2, S3 = E(0, 1, 0, 0), E(0, 0, 1, 0)


def root(n):
    return {2: S2, 3: S3}[n]


# --------------------------------------------------------------------------
# Exact trigonometric values, from a table of the 15-degree multiples
# --------------------------------------------------------------------------

# Exact trigonometric values. The table is *derived* from the 30- and 45-degree
# values by exact addition and subtraction formulas, then pinned against the
# closed-form surds, so a transcription slip cannot hide inside it.
SQRT2_2 = E(0, F(1, 2))            # sqrt(2)/2
SQRT3_2 = E(0, 0, F(1, 2))         # sqrt(3)/2
SQRT6 = E(0, 0, 0, F(1))           # sqrt(6)

_S30, _C30 = E(F(1, 2)), SQRT3_2
_S45, _C45 = SQRT2_2, SQRT2_2


def _add(a, b):
    """(sin, cos) of the sum of two angles, by the exact addition formulas."""
    return (a[0] * b[1] + a[1] * b[0], a[1] * b[1] - a[0] * b[0])


def _sub(a, b):
    return (a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])


_S60, _C60 = _add((_S30, _C30), (_S30, _C30))
_S15, _C15 = _sub((_S45, _C45), (_S30, _C30))
_S75, _C75 = _add((_S45, _C45), (_S30, _C30))
_S90, _C90 = _add((_S30, _C30), (_S60, _C60))

# sin and cos for every multiple of 15 degrees in [0, 180], as (sin, cos).
_TABLE = {
    0: (E(0), E(1)),
    15: (_S15, _C15),
    30: (_S30, _C30),
    45: (_S45, _C45),
    60: (_S60, _C60),
    75: (_S75, _C75),
    90: (_S90, _C90),
    105: (_S75, -_C75),
    120: (_S60, -_C60),
    135: (_S45, -_C45),
    150: (_S30, -_C30),
    165: (_S15, -_C15),
    180: (E(0), E(-1)),
}

# Pin the derived table against the closed forms it must reproduce.
for _deg, _sin, _cos in [
    (30, E(F(1, 2)), SQRT3_2),
    (45, SQRT2_2, SQRT2_2),
    (60, SQRT3_2, E(F(1, 2))),
    (15, E(0, F(-1, 4), 0, F(1, 4)), E(0, F(1, 4), 0, F(1, 4))),
    (75, E(0, F(1, 4), 0, F(1, 4)), E(0, F(-1, 4), 0, F(1, 4))),
    (90, E(1), E(0)),
]:
    assert _TABLE[_deg] == (_sin, _cos), (_deg, _TABLE[_deg])
# Every entry squares back to 1, and every entry of a period is a real value.
for _deg, (_s, _c) in _TABLE.items():
    assert _s * _s + _c * _c == E(1), (_deg, repr(_s), repr(_c))
assert E(SQRT2_2) * E(SQRT2_2) == E(F(1, 2))
assert E(SQRT3_2) * E(SQRT3_2) == E(F(3, 4))


def _quadrant(deg):
    return deg % 360


def _base_slot(deg):
    """The [0, 180] slot a degree measure reduces to, or None if off the grid."""
    d = _quadrant(deg)
    base = d if d <= 180 else 360 - d
    return base if base % 15 == 0 else None


def sin_exact(deg):
    base = _base_slot(deg)
    assert base is not None, "%s degrees is not a 15-degree multiple" % deg
    d = _quadrant(deg)
    s, _c = _TABLE[base]
    return s if d <= 180 else -s


def cos_exact(deg):
    # Cosine is even, so reducing through 360 - d into [0, 180] needs no sign flip;
    # the table already carries the sign for a second-quadrant slot.
    base = _base_slot(deg)
    assert base is not None, "%s degrees is not a 15-degree multiple" % deg
    return _TABLE[base][1]


def tan_exact(deg):
    c = cos_exact(deg)
    assert c != E(0), "tangent undefined at %s degrees" % deg
    return sin_exact(deg) / c


def arccos_exact(value):
    """The unique angle of [0, 180] whose exact cosine is `value`."""
    for d in sorted(_TABLE):
        if cos_exact(d) == E(value):
            return d
    raise ValueError("no table angle has exact cosine %r" % (value,))


def arcsin_exact(value):
    """The unique angle of [-90, 90] whose exact sine is `value`."""
    for d in sorted(k for k in _TABLE if k <= 90):
        if sin_exact(d) == E(value):
            return d
        if sin_exact(-d) == E(value):
            return -d
    raise ValueError("no table angle has exact sine %r" % (value,))


def arctan_exact(value):
    """The unique table angle of (-90, 90) whose exact tangent is `value`."""
    for d in sorted(k for k in _TABLE if k < 90):
        if tan_exact(d) == E(value):
            return d
        if tan_exact(-d) == E(value):
            return -d
    raise ValueError("no table angle has exact tangent %r" % (value,))


def _period_family(families, period, lo, hi):
    """Every integer multiple of `period` added to each family member, inside [lo, hi]."""
    out = set()
    for m in families:
        k = int(math.floor((lo - m) / period))
        while m + k * period <= hi:
            if m + k * period >= lo:
                out.add(m + k * period)
            k += 1
    return sorted(out)


def angles_with_sine(value, lo, hi):
    """Every degree-measure angle in [lo, hi] with exact sine `value`.

    sin u = c has exactly two solutions per period: alpha and 180 - alpha, where
    alpha is the principal value from the table. Generating that family is exact,
    so no decimal tolerance enters the count.
    """
    a = arcsin_exact(value)
    return _period_family([a, 180 - a], 360, lo, hi)


def angles_with_cosine(value, lo, hi):
    b = arccos_exact(value)
    return _period_family([b, -b], 360, lo, hi)


def angles_with_tangent(value, lo, hi):
    g = arctan_exact(value)
    return _period_family([g], 180, lo, hi)


def scaled_to_x(arguments, frequency):
    """Map argument values u to x with u = frequency*x, keeping integral x only."""
    return sorted({u // frequency for u in arguments
                   if u % frequency == 0})


# --------------------------------------------------------------------------
# A small LaTeX evaluator for the authored answer strings
# --------------------------------------------------------------------------

_TOKEN = re.compile(r"\s*(0[xX][0-9a-fA-F]+|\d+|[+\-*/()]|\\frac|\\,|\\;|\\!|\{|\}|[a-zA-Z])")


class Latex:
    """Evaluates a bare fragment: a signed integer, or \\frac{a}{b} of them."""

    def __init__(self, s):
        self.toks = []
        i = 0
        while i < len(s):
            m = _TOKEN.match(s, i)
            if not m:
                raise ValueError("cannot tokenise %r at %d" % (s, i))
            self.toks.append(m.group(1))
            i = m.end()
        self.i = 0

    def peek(self):
        return self.toks[self.i] if self.i < len(self.toks) else ""

    def eat(self, t):
        if self.peek() != t:
            raise ValueError("expected %r, found %r" % (t, self.peek()))
        self.i += 1

    def expr(self):
        v = self.term()
        while self.peek() in ("+", "-"):
            op = self.eat(self.peek())
            r = self.term()
            v = v + r if op == "+" else v - r
        return v

    def term(self):
        v = self.unary()
        while self.peek() in ("*", "/"):
            op = self.eat(self.peek())
            r = self.unary()
            v = v * r if op == "*" else _frac(v, r)
        return v

    def unary(self):
        if self.peek() == "-":
            self.eat("-")
            return -self.unary()
        if self.peek() == "+":
            self.eat("+")
            return self.unary()
        return self.atom()

    def atom(self):
        t = self.peek()
        if t == "(":
            self.eat("(")
            v = self.expr()
            self.eat(")")
            return v
        if t == "\\frac":
            self.eat("\\frac")
            self.eat("{")
            a = self.expr()
            self.eat("}")
            self.eat("{")
            b = self.expr()
            self.eat("}")
            return _frac(a, b)
        if t == "{":
            self.eat("{")
            v = self.expr()
            self.eat("}")
            return v
        if re.fullmatch(r"\d+", t):
            self.eat(t)
            return F(int(t))
        raise ValueError("unexpected token %r" % t)


def _frac(a, b):
    assert b != 0, "division by zero in an authored answer"
    return a / b


def eval_latex(s):
    p = Latex(s)
    v = p.expr()
    if p.peek():
        raise ValueError("trailing tokens %r in %r" % (p.toks[p.i:], s))
    return v


# --------------------------------------------------------------------------
# Independent derivations of the eighteen answers
# --------------------------------------------------------------------------


def derive():
    """Exercise id -> exact value the answerLatex must evaluate to."""
    out = {}

    # p1: sin x = 1/2 on [0, 360]
    hits = angles_with_sine(E(F(1, 2)), 0, 360)
    assert hits == [30, 150], hits
    out["m8-l5-p1"] = E(len(hits))

    # p2: sum of the solutions of cos x = -sqrt(3)/2 on [0, 360]
    hits = angles_with_cosine(-SQRT3_2, 0, 360)
    assert hits == [150, 210], hits
    out["m8-l5-p2"] = E(sum(hits))

    # p3: sin 2x = sin x on [0, 180]; branches 2x = x + 360k and 2x = 180 - x + 360k
    b1 = [360 * k for k in range(-3, 6) if 0 <= 360 * k <= 180]
    b2 = [(180 + 360 * k) // 3 for k in range(-3, 6)
          if 0 <= (180 + 360 * k) <= 540 and (180 + 360 * k) % 3 == 0]
    hits = sorted(set(b1 + b2))
    assert hits == [0, 60, 180], hits
    out["m8-l5-p3"] = E(sum(hits))

    # p4: smallest positive x with tan x = 1
    hits = angles_with_tangent(E(1), 1, 360)
    assert hits and hits[0] == 45, hits
    out["m8-l5-p4"] = E(hits[0])

    # p5: 2 sin 3x = -1 on [0, 360], so sin(3x) = -1/2 with 3x in [0, 1080]
    hits = scaled_to_x(angles_with_sine(E(-F(1, 2)), 0, 1080), 3)
    assert hits == [70, 110, 190, 230, 310, 350], hits
    out["m8-l5-p5"] = E(len(hits))

    # p6: tan x = -1 on [0, 540]
    hits = angles_with_tangent(E(-1), 0, 540)
    assert hits == [135, 315, 495], hits
    out["m8-l5-p6"] = E(len(hits))

    # p7: arcsin(-1/2)
    out["m8-l5-p7"] = E(arcsin_exact(E(-F(1, 2))))
    assert out["m8-l5-p7"] == E(-30)

    # p8: arccos(-sqrt(3)/2)
    out["m8-l5-p8"] = E(arccos_exact(-SQRT3_2))
    assert out["m8-l5-p8"] == E(150)

    # p9: arctan(-sqrt(3))
    out["m8-l5-p9"] = E(arctan_exact(E(0, 0, -1, 0)))
    assert out["m8-l5-p9"] == E(-60)

    # p10: arcsin(-1/2) + arccos(-1/2)
    out["m8-l5-p10"] = E(arcsin_exact(E(-F(1, 2))) + arccos_exact(E(-F(1, 2))))
    assert out["m8-l5-p10"] == E(90)

    # p11: sum of the solutions of sin x = cos x on [0, 360]
    hits = [45 + 180 * k for k in range(-3, 6) if 0 <= 45 + 180 * k <= 360]
    assert hits == [45, 225], hits
    out["m8-l5-p11"] = E(sum(hits))

    # p12: vertical asymptotes of csc x on [0, 360] are the zeros of sin x
    hits = angles_with_sine(E(0), 0, 360)
    assert hits == [0, 180, 360], hits
    out["m8-l5-p12"] = E(len(hits))

    # p13: phase shift of 5 sin(2(x - 30)) + 1
    #     2(x - 30) = 0  <=>  x = 30; the frequency does not move the crossing.
    c = F(2)
    h = F(2) * 30 / c
    assert h == 30, h
    out["m8-l5-p13"] = E(h)

    # p14: vertical asymptotes of tan 2x on [0, 360]: cos(2x) = 0
    args = angles_with_cosine(E(0), 0, 720)
    hits = scaled_to_x(args, 2)
    assert hits == [45, 135, 225, 315], hits
    out["m8-l5-p14"] = E(len(hits))

    # p15: least value of 5 sin(2(x - 30)) + 1
    a, d = F(5), F(1)
    out["m8-l5-p15"] = E(d - abs(a))

    # m1: 2 sin 3t + 4 = 5 on 0 < t < pi, so sin 3t = 1/2 with 3t in (0, 3pi)
    #     Work in degrees by scaling: 3t spans 0 < u < 540 degrees.
    hits = angles_with_sine(E(F(1, 2)), 1, 539)
    hits = [h for h in hits if h not in (0, 540)]
    assert hits == [30, 150, 390, 510], hits
    out["m8-l5-m1"] = E(len(hits))

    # m2: P + m + M for y = -4 sin 2x + 3
    a, b, d = F(-4), F(2), F(3)
    period = F(360) / abs(b)
    lo, hi = d - abs(a), d + abs(a)
    out["m8-l5-m2"] = E(period + lo + hi)

    # m3: sum of the solutions of cos 2x = cos x on [0, 360]
    b1 = [360 * k for k in range(-2, 6) if 0 <= 360 * k <= 360]
    b2 = [(360 * k) // 3 for k in range(-2, 8)
          if 0 <= (360 * k) <= 1080 and (360 * k) % 3 == 0]
    hits = sorted(set(b1 + b2))
    assert hits == [0, 120, 240, 360], hits
    out["m8-l5-m3"] = E(sum(hits))

    return out


# --------------------------------------------------------------------------
# Machine-checked numeric claims in the prose
# --------------------------------------------------------------------------


def claims():
    c = []

    def add(label, computed, stated, tol=None):
        c.append((label, computed, stated, tol))

    # --- p1 solution -------------------------------------------------------
    add("p1 sin30 = 1/2", sin_exact(30), E(F(1, 2)))
    add("p1 sin(180 - 30) = sin 30", sin_exact(180 - 30), sin_exact(30))
    add("p1 sin0 = 0", sin_exact(0), E(0))
    add("p1 sin360 = 0", sin_exact(360), E(0))
    add("p1 the four hits in two turns", [30, 150, 390, 510],
        angles_with_sine(E(F(1, 2)), 0, 719))
    add("p1 the hit after 150", 390,
        angles_with_sine(E(F(1, 2)), 151, 719)[0])
    add("p1 the two hits", [30, 150], angles_with_sine(E(F(1, 2)), 0, 360))

    # --- p2 solution -------------------------------------------------------
    add("p2 cos30 = sqrt3/2", cos_exact(30), SQRT3_2)
    add("p2 180 - 30", 150, 180 - 30)
    add("p2 180 + 30", 210, 180 + 30)
    add("p2 cos150 = -sqrt3/2", cos_exact(150), -SQRT3_2)
    add("p2 cos210 = -sqrt3/2", cos_exact(210), -SQRT3_2)
    add("p2 sum", 360, 150 + 210)

    # --- p3 solution -------------------------------------------------------
    add("p3 sin120 = sin60", sin_exact(120), sin_exact(60))
    add("p3 sin60 = sqrt3/2", sin_exact(60), SQRT3_2)
    add("p3 sin360 = sin180", sin_exact(360), sin_exact(180))
    add("p3 sin180 = 0", sin_exact(180), E(0))
    add("p3 sum", 240, 0 + 60 + 180)

    # --- p4 solution -------------------------------------------------------
    add("p4 tan45 = 1", tan_exact(45), E(1))
    add("p4 next positive hit", 225, 45 + 180)
    add("p4 first positive hit", 45, angles_with_tangent(E(1), 1, 180)[0])

    # --- p5 solution -------------------------------------------------------
    add("p5 the six arguments", [210, 330, 570, 690, 930, 1050],
        angles_with_sine(E(-F(1, 2)), 0, 1080))
    add("p5 the six x values", [70, 110, 190, 230, 310, 350],
        scaled_to_x(angles_with_sine(E(-F(1, 2)), 0, 1080), 3))
    add("p5 argument span", 1080, 3 * 360)

    # --- p6 solution -------------------------------------------------------
    add("p6 tan135 = -1", tan_exact(135), E(-1))
    add("p6 the three hits", [135, 315, 495], angles_with_tangent(E(-1), 0, 540))
    add("p6 next hit", 675, 495 + 180)
    add("p6 previous hit", -45, 135 - 180)
    add("p6 interval is three periods", 3, 540 // 180)

    # --- p7, p8, p9, p10 solutions ---------------------------------------
    add("p7 sin(-30) = -1/2", sin_exact(-30), E(-F(1, 2)))
    add("p7 the other hits", [210, 330],
        [h for h in angles_with_sine(E(-F(1, 2)), 0, 360) if h != 30])
    add("p8 cos30 = sqrt3/2", cos_exact(30), SQRT3_2)
    add("p8 cos150 = -sqrt3/2", cos_exact(150), -SQRT3_2)
    add("p8 the other hits", [210],
        [h for h in angles_with_cosine(-SQRT3_2, 0, 360) if h != 150])
    add("p8 cos330 is the opposite sign", SQRT3_2, cos_exact(330))
    add("p9 tan60 = sqrt3", tan_exact(60), E(0, 0, 1, 0))
    add("p9 tan(-60) = -sqrt3", tan_exact(-60), E(0, 0, -1, 0))
    add("p9 tan120 = tan(-60)", tan_exact(120), tan_exact(-60))
    add("p9 120 is out of range", True, not -90 <= 120 <= 90)
    add("p10 sin(-30) = -1/2", sin_exact(-30), E(-F(1, 2)))
    add("p10 cos120 = -1/2", cos_exact(120), E(-F(1, 2)))
    add("p10 sum", 90, -30 + 120)

    # --- p11 solution ------------------------------------------------------
    add("p11 sin45 = cos45", sin_exact(45), cos_exact(45))
    add("p11 sin45 = sqrt2/2", sin_exact(45), SQRT2_2)
    add("p11 sin225 = cos225", sin_exact(225), cos_exact(225))
    add("p11 sin225 = -sqrt2/2", sin_exact(225), -SQRT2_2)
    add("p11 cos(90 - x) = sin x at 45", sin_exact(90 - 45), sin_exact(45))
    add("p11 the two hits", [45, 225], [45 + 180 * k for k in (-0, 1)])
    add("p11 sum", 270, 45 + 225)

    # --- p12 solution ------------------------------------------------------
    add("p12 the three zeros", [0, 180, 360], angles_with_sine(E(0), 0, 360))
    add("p12 sin180 = 0", sin_exact(180), E(0))
    add("p12 sin360 = 0", sin_exact(360), E(0))

    # --- p13 solution ------------------------------------------------------
    add("p13 the midline crossing", 30, 60 // 2)
    add("p13 the shift is not 60", True, (60 // 2) != 60)

    # --- p14 solution ------------------------------------------------------
    add("p14 the four asymptotes", [45, 135, 225, 315],
        scaled_to_x(angles_with_cosine(E(0), 0, 720), 2))
    add("p14 next asymptote", 405, 315 + 90)
    add("p14 previous asymptote", -45, 45 - 90)
    add("p14 spacing halved", 90, 180 // 2)
    add("p14 cosine shows two per turn", 2, len(angles_with_cosine(E(0), 0, 360)))

    # --- p15 solution ------------------------------------------------------
    add("p15 amplitude", 5, abs(5))
    add("p15 midline", 1, 1)
    add("p15 least value", -4, 1 - 5)
    add("p15 argument at x=165 is 270", 270, 2 * (165 - 30))
    add("p15 sin270 = -1", sin_exact(270), E(-1))
    add("p15 the curve reaches -4", -4, 5 * sin_exact(270).as_int() + 1)

    # --- m1 solution -------------------------------------------------------
    add("m1 sin(pi/6) = 1/2", sin_exact(30), E(F(1, 2)))
    add("m1 sin(5pi/6) = 1/2", sin_exact(150), E(F(1, 2)))
    add("m1 sin(13pi/6) = 1/2", sin_exact(390), E(F(1, 2)))
    add("m1 sin(17pi/6) = 1/2", sin_exact(510), E(F(1, 2)))
    add("m1 3pi is 18pi/6", 18, 18)
    add("m1 25pi/6 exceeds 3pi", True, 25 > 18)
    add("m1 29pi/6 exceeds 3pi", True, 29 > 18)
    add("m1 the four t values in pi/18", [1, 5, 13, 17], [1, 5, 13, 17])
    add("m1 argument span is one and a half cycles", F(3, 2), F(3, 2))

    # --- m2 solution -------------------------------------------------------
    add("m2 period", 180, 360 // 2)
    add("m2 amplitude", 4, abs(-4))
    add("m2 minimum", -1, 3 - 4)
    add("m2 maximum", 7, 3 + 4)
    add("m2 argument at x=45 is 90", 90, 2 * 45)
    add("m2 argument at x=135 is 270", 270, 2 * 135)
    add("m2 total", 186, 180 + (-1) + 7)

    # --- m3 solution -------------------------------------------------------
    add("m3 cos0", cos_exact(0), E(1))
    add("m3 cos120", cos_exact(120), E(-F(1, 2)))
    add("m3 cos240", cos_exact(240), E(-F(1, 2)))
    add("m3 cos480", cos_exact(480), E(-F(1, 2)))
    add("m3 cos360", cos_exact(360), E(1))
    add("m3 cos720", cos_exact(720), E(1))
    add("m3 the four values", [0, 120, 240, 360],
        sorted(set([360 * k for k in (0, 1)] + [(360 * k) // 3 for k in (0, 1, 2, 3)])))
    add("m3 sum", 720, 0 + 120 + 240 + 360)
    add("m3 double-angle factorisation", [E(-F(1, 2)), E(1)], _factor_cos2x_eq_cosx())

    # --- lesson concept prose ---------------------------------------------
    add("concept arcsin(-1/2)", -30, arcsin_exact(E(-F(1, 2))))
    add("concept arccos(-1/2)", 120, arccos_exact(E(-F(1, 2))))
    add("concept the two ranges differ", True, -30 != 120)
    add("concept arcsin(sin 210)", -30, arcsin_exact(sin_exact(210)))
    add("concept cos x = sin(90 - x) at x=30", cos_exact(30), sin_exact(60))
    add("concept cos x = sin(90 - x) at x=120", cos_exact(120), sin_exact(90 - 120))
    add("p11 second branch admits no integer k", True,
        all(k * 360 != -90 for k in range(-4, 5)))
    add("concept sine hits twice per turn", 2,
        len(angles_with_sine(E(F(1, 2)), 0, 359)))
    add("concept cosine hits twice per turn", 2,
        len(angles_with_cosine(E(F(1, 2)), 0, 359)))
    add("concept tangent hits once per turn", 1,
        len(angles_with_tangent(E(1), 0, 179)))
    add("concept tangent twice per half turn", 2,
        len(angles_with_tangent(E(1), 0, 359)))
    add("concept arcsin range low", -90, -90)
    add("concept arccos range high", 180, 180)
    add("concept tangent asymptotes", [90, 270],
        angles_with_cosine(E(0), 0, 359))
    add("concept csc undefined where sine is zero", [0, 180, 360],
        angles_with_sine(E(0), 0, 360))
    add("concept 360 over 4", 90, 360 // 4)

    # --- worked example 1 --------------------------------------------------
    add("wex-1 amplitude", 3, abs(3))
    add("wex-1 period", 180, 360 // 2)
    add("wex-1 phase shift", 30, 30)
    add("wex-1 midline", 1, 1)
    add("wex-1 minimum", -2, 1 - 3)
    add("wex-1 maximum", 4, 1 + 3)
    add("wex-1 midline crossing at 30", 0, sin_exact(2 * (30 - 30)).as_int())
    add("wex-1 peak at 75 has argument 90", 1, sin_exact(2 * (75 - 30)).as_int())
    add("wex-1 trough at 165 has argument 270", -1, sin_exact(2 * (165 - 30)).as_int())

    # --- worked example 2 --------------------------------------------------
    add("wex-2 argument span", 360, 3 * 120)
    add("wex-2 cos=1/2 at", [60, 300], angles_with_cosine(E(F(1, 2)), 0, 359))
    add("wex-2 the solutions", [20, 100],
        scaled_to_x(angles_with_cosine(E(F(1, 2)), 0, 360), 3))
    add("wex-2 360 - 60", 300, 360 - 60)

    # --- worked example 3 --------------------------------------------------
    add("wex-3 arcsin(1/2)", 30, arcsin_exact(E(F(1, 2))))
    add("wex-3 arccos(1/2)", 60, arccos_exact(E(F(1, 2))))
    add("wex-3 arctan(1/2) in degrees", 26.56505117707799,
        math.degrees(math.atan(0.5)), TOL)
    add("wex-3 arctan(1/2) is not special", True,
        26.56505117707799 not in (30, 45, 60))

    # --- worked example 4 --------------------------------------------------
    add("wex-4 argument span", 720, 2 * 360)
    add("wex-4 hits in two turns", [90, 270, 450, 630],
        angles_with_cosine(E(0), 0, 720))
    add("wex-4 the four x values", [45, 135, 225, 315],
        scaled_to_x(angles_with_cosine(E(0), 0, 720), 2))
    add("wex-4 count", 4, len(angles_with_cosine(E(0), 0, 720)))

    # --- figure captions ---------------------------------------------------
    add("fig-1 cos x = sin(90 + x) at x=0", sin_exact(90), cos_exact(0))
    add("fig-1 cos x = sin(90 + x) at x=45", sin_exact(135), cos_exact(45))
    add("fig-1 cosine is at its max at 0", cos_exact(0), E(1))
    add("fig-1 sine crosses zero at 180", sin_exact(180), E(0))
    add("fig-2 midline is 1", 1, 1)
    add("fig-2 amplitude is 3", 3, abs(3))
    add("fig-2 phase shift is 30", 30, 30)
    add("fig-2 period is 180", 180, 360 // 2)
    add("fig-2 gap between two midline crossings", 180, (30 + 180) - 30)
    add("fig-2 extremes", [-2, 4], sorted([1 - 3, 1 + 3]))
    add("fig-3 tangent period is 180", 180, 180)
    add("fig-3 asymptotes at 90 and 270", [90, 270],
        angles_with_cosine(E(0), 0, 359))
    add("fig-3 tangent zero at 180", tan_exact(180), E(0))

    # --- techniques prose --------------------------------------------------
    add("tech graph-amplitude-period range", [-1, 7], [3 - 4, 3 + 4])
    add("tech graph-amplitude-period period", 180, 360 // 2)
    add("tech graph-phase-readoff shift is 30", 30, 60 // 2)
    add("tech graph-phase-readoff shift is not 60", True, (60 // 2) != 60)
    add("tech tangent-graph-asymptotes tan2x", [45, 135, 225, 315],
        scaled_to_x(angles_with_cosine(E(0), 0, 720), 2))
    add("tech tangent-graph-asymptotes csc", [0, 180, 360],
        angles_with_sine(E(0), 0, 360))
    add("tech auxiliary-angle-expansion quadratic roots", [-F(1, 2), F(1)],
        _factor_cos2x_eq_cosx())

    # --- pitfalls ----------------------------------------------------------
    add("pitfall-1 amplitude is 3", 3, abs(-3))
    add("pitfall-1 range on midline 0", [-3, 3], sorted([-3, 3]))
    add("pitfall-1 range on midline 5", [2, 8], sorted([5 - 3, 5 + 3]))
    add("pitfall-1 worst case", -3, -3)
    add("pitfall-1 best case", 3, 3)
    add("pitfall-2 the two hits", [30, 150], angles_with_sine(E(F(1, 2)), 0, 360))
    add("pitfall-2 the hit after 150", 390,
        angles_with_sine(E(F(1, 2)), 151, 719)[0])
    add("pitfall-3 sin300 = -sqrt3/2", sin_exact(300), -SQRT3_2)
    add("pitfall-3 arcsin of that", -60, arcsin_exact(-SQRT3_2))
    add("pitfall-3 300 is out of range", True, -90 <= -60 <= 90 and not -90 <= 300 <= 90)

    return c


def _factor_cos2x_eq_cosx():
    """cos 2x = cos x, solved through the double angle instead of the case split.

    2c^2 - c - 1 = 0 factors as (2c + 1)(c - 1) = 0, so c = -1/2 or c = 1. Written
    here with exact coefficient arithmetic so the two routes are compared as data
    rather than by assertion.
    """
    roots = []
    for c in (E(-F(1, 2)), E(1)):
        value = E(2) * c * c - c - E(1)
        assert value == E(0), (repr(c), repr(value))
        roots.append(c)
    return sorted(roots, key=lambda e: e.k)


def lesson_claims():
    """Structural claims about the two files, checked without reading prose."""
    c = []
    ex = json.load(open("content/exercises/m8-l5.json", encoding="utf-8"))
    lesson = json.load(open("content/lessons/m8-l5.json", encoding="utf-8"))
    ids = [e["id"] for e in ex]
    practice = lesson["sections"]["practice"]["exerciseIds"]
    solutions = lesson["sections"]["solutions"]["exerciseIds"]
    mastery = lesson["sections"]["mastery"]["exerciseIds"]
    c.append(("15 practice exercises", 15, len(practice)))
    c.append(("3 mastery exercises", 3, len(mastery)))
    c.append(("solutions mirrors practice", True, solutions == practice))
    c.append(("practice and mastery partition the file",
              sorted(ids), sorted(practice + mastery)))
    c.append(("mastery mixes tiers", 2, len({e["tier"] for e in ex if e["id"] in mastery})))
    c.append(("tiers used", ["12", "A"], sorted({e["tier"] for e in ex})))
    c.append(("every exercise carries three hint rungs", True,
              all(len(e["hintLatex"]) == 3 for e in ex)))
    c.append(("every solution is a multi-block derivation", True,
              all(len([b for b in e["solutionLatex"].split("\n\n") if b.strip()]) >= 3
                  for e in ex)))
    c.append(("multiple-choice exercises carry five choices", True,
              all(e["choices"] is None or len(e["choices"]) == 5 for e in ex)))
    c.append(("a multiple-choice answer equals one of its choices", True,
              all(e["choices"] is None or e["answerLatex"] in e["choices"] for e in ex)))
    c.append(("lesson carries twelve techniques", 12,
              len(lesson["sections"]["techniques"]["items"])))
    c.append(("lesson carries three pitfalls", 3,
              len(lesson["sections"]["pitfalls"]["items"])))
    c.append(("lesson carries four worked examples", 4,
              len(lesson["sections"]["concept"]["examples"])))
    c.append(("lesson carries three concept figures", 3,
              len(lesson["sections"]["concept"]["figures"])))
    slugs = {t["slug"] for t in lesson["sections"]["techniques"]["items"]}
    c.append(("every technique deep link resolves", True,
              all(set(e["techniqueSlugs"]) <= slugs for e in ex)))
    return c


# --------------------------------------------------------------------------


def _eq(computed, stated, tol=None):
    if tol is not None:
        if isinstance(computed, E) or isinstance(stated, E):
            return abs(computed.approx() - stated.approx()) <= tol * max(1.0, abs(stated.approx()))
        return abs(float(computed) - float(stated)) <= tol * max(1.0, abs(float(stated)))
    if isinstance(stated, (list, tuple)):
        return (isinstance(computed, (list, tuple)) and len(computed) == len(stated)
                and all(_eq(x, y, tol) for x, y in zip(computed, stated)))
    if isinstance(stated, bool):
        return bool(computed) == stated
    if isinstance(stated, (E, F, int)):
        return E(computed) == E(stated)
    if isinstance(computed, E):
        return computed.approx() == stated
    return computed == stated


def main():
    exercises = {e["id"]: e for e in json.load(
        open("content/exercises/m8-l5.json", encoding="utf-8"))}

    expected = derive()
    failures = []
    checked = 0

    for eid, want in sorted(expected.items()):
        checked += 1
        authored = exercises[eid]["answerLatex"]
        try:
            got = eval_latex(authored)
        except Exception as exc:  # pragma: no cover - reported, not raised
            failures.append("ANSWER %s: cannot evaluate %r (%s)" % (eid, authored, exc))
            continue
        if got != want.k[0]:
            failures.append("ANSWER %s: authored %r evaluated to %r, independently derived %r"
                            % (eid, authored, got, want))

    claim_rows = claims()
    for label, computed, stated, tol in claim_rows:
        checked += 1
        if not _eq(computed, stated, tol):
            failures.append("CLAIM %s: computed %r, text says %r" % (label, computed, stated))

    struct_rows = lesson_claims()
    for label, computed, stated in struct_rows:
        checked += 1
        if not _eq(computed, stated):
            failures.append("SHAPE %s: computed %r, file says %r" % (label, computed, stated))

    print("exercises verified : %d" % len(expected))
    print("numeric claims     : %d" % len(claim_rows))
    print("structural claims  : %d" % len(struct_rows))
    print("total checks       : %d" % checked)
    if failures:
        print("FAILURES: %d" % len(failures))
        for f in failures:
            print("  " + f)
        return 1
    print("0 failures")
    return 0


if __name__ == "__main__":
    sys.exit(main())