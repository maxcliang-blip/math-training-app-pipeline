#!/usr/bin/env python3
"""A small recursive parser for the LaTeX numeric subset used in m8 answers.

Handles \\frac{a}{b}, \\sqrt{a}, \\pi, ^, unary minus, and implicit
multiplication. Returns a float.
"""
import math
import re

PI = math.pi


class P:
    def __init__(self, s):
        self.s = s
        self.i = 0

    def ws(self):
        while self.i < len(self.s) and self.s[self.i].isspace():
            self.i += 1

    def eof(self):
        self.ws()
        return self.i >= len(self.s)

    def peek(self):
        self.ws()
        return self.s[self.i] if self.i < len(self.s) else ""

    def eat(self, ch):
        self.ws()
        if self.i < len(self.s) and self.s[self.i] == ch:
            self.i += 1
            return True
        return False

    def expect(self, ch):
        if not self.eat(ch):
            raise ValueError(f"expected {ch!r} at {self.i} in {self.s!r}")

    # expr := term (('+'|'-') term)*
    def expr(self):
        v = self.term()
        while True:
            self.ws()
            if self.i < len(self.s) and self.s[self.i] in "+-":
                op = self.s[self.i]
                self.i += 1
                w = self.term()
                v = v + w if op == "+" else v - w
            else:
                return v

    # term := unary (('*' | '/') unary | implicit unary)*
    def term(self):
        v = self.unary()
        while True:
            self.ws()
            if self.i >= len(self.s):
                return v
            c = self.s[self.i]
            if c == "*":
                self.i += 1
                v = v * self.unary()
            elif c == "/":
                self.i += 1
                w = self.unary()
                if w == 0:
                    raise ZeroDivisionError("division by zero")
                v = v / w
            elif c in "+-" and not self._is_exponent_context():
                return v
            elif self._starts_atom():
                v = v * self.unary()
            else:
                return v

    def _is_exponent_context(self):
        return False

    def _starts_atom(self):
        rest = self.s[self.i:]
        return bool(re.match(r"\\(pi|frac|sqrt)|[A-Za-z(]", rest)) and not re.match(r"\\(cdot|times)", rest)

    # unary := '-' unary | atom ('^' unary)?
    def unary(self):
        self.ws()
        if self.eat("-"):
            return -self.unary()
        if self.eat("+"):
            return self.unary()
        v = self.atom()
        if self.eat("^"):
            e = self.unary()
            v = v ** e
        return v

    def atom(self):
        self.ws()
        if self.i >= len(self.s):
            raise ValueError("unexpected end")
        # \pi and friends
        m = re.match(r"\\pi", self.s[self.i:])
        if m:
            self.i += m.end()
            return PI
        m = re.match(r"\\(cdot|times)", self.s[self.i:])
        if m:
            self.i += m.end()
            return self.unary()
        m = re.match(r"\\d?frac", self.s[self.i:])
        if m:
            self.i += m.end()
            num = self.braced()
            den = self.braced()
            if den == 0:
                raise ZeroDivisionError("division by zero in \\frac")
            return num / den
        m = re.match(r"\\sqrt", self.s[self.i:])
        if m:
            self.i += m.end()
            return math.sqrt(self.braced())
        m = re.match(r"\\d?binom", self.s[self.i:])
        if m:
            self.i += m.end()
            n = self.braced()
            k = self.braced()
            return math.comb(int(n), int(k))
        if self.eat("("):
            v = self.expr()
            self.expect(")")
            return v
        if self.eat("{"):
            v = self.expr()
            self.expect("}")
            return v
        m = re.match(r"[0-9]*\.?[0-9]+(?![\w.])", self.s[self.i:])
        if m:
            self.i += m.end()
            return float(m.group(0))
        raise ValueError(f"cannot parse at {self.i}: {self.s[self.i:]!r}")

    def braced(self):
        self.expect("{")
        v = self.expr()
        self.expect("}")
        return v


def to_number(latex):
    s = latex.strip()
    for junk in ("\\left", "\\right", "\\middle", "^\\circ", "^{\\circ}",
                 "\\!", "\\,", "\\;", "\\ ", "~"):
        s = s.replace(junk, "")
    s = s.replace("\\circ", "").replace("\\angle", "")
    p = P(s)
    v = p.expr()
    if not p.eof():
        raise ValueError(f"trailing input at {p.i} in {s!r}")
    return v


if __name__ == "__main__":
    import sys
    for frag in sys.argv[1:]:
        print(frag, "=", to_number(frag))
