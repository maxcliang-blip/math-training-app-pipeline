// Answer grading, and the only reader of answerLatex in this service.
//
// Everything here is transcription of Rendering Conventions §6 and lesson spec §3.2/§3.3, in
// the order those documents fix. The order is not incidental: "0.5, 1/2 and \frac12 agree" is
// true only because canonicalisation runs before comparison, and a grader that compares first
// and canonicalises on mismatch produces a false negative on every learner's first attempt.
//
// What this file deliberately is not: a computer algebra system. §6 rule 9 forbids one in v1, and
// a symbolic evaluator is also the thing that would let a grader disagree with the client and
// mark a right answer wrong. So the comparison ladder stops after four rungs and rung 5 is an
// honest "no" that hands the learner the solution and the false-negative report path. A wrong
// answer marked wrong is a recoverable annoyance; a right answer marked wrong is the bug that
// teaches a learner to distrust the app.
//
// Two safety properties hold throughout:
//
//   * No rung ever returns correct on a parse it did not fully understand. `NaN` is not close to
//     a number, and `Infinity` is not a finite answer, so both fail the numeric rung rather than
//     comparing equal to themselves.
//   * Rung 4 (answerAlternatives) is checked against the canonical forms of the alternatives,
//     not the raw strings, so an alternative written as "0.25" is reachable by "1/4".

const RADICAL_TOLERANCE = { relative: 1e-9, absolute: 1e-12 };

// Unicode from a phone keyboard is normal input, not an error (R §6 step 7). These are the
// characters the corpus and the keyboards actually produce.
const UNICODE_TO_LATEX = [
  ["−", "-"], // minus sign, not a hyphen
  ["≤", "\\leq"],
  ["≥", "\\geq"],
  ["≠", "\\neq"],
  ["±", "\\pm"],
  ["×", "\\times"],
  ["÷", "\\div"],
  ["√", "\\sqrt"],
  ["π", "\\pi"],
  ["θ", "\\theta"],
  ["°", "^\\circ"],
  ["∞", "\\infty"],
  ["≡", "\\equiv"],
  ["⁄", "/"], // fraction slash
];

const SPACING_COMMANDS = ["\\!", "\\,", "\\;", "\\:", "\\ ", "\\quad", "\\qquad", "~"];

const SIZING_COMMANDS = ["\\left", "\\right", "\\middle"];

// Unicode sub/superscript digits. Written as a map rather than a range because the digit runs
// are not contiguous and a range check would map subscript 3 to the wrong codepoint.
const SUPERSCRIPTS = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9" };
const SUBSCRIPTS = { "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9" };

function collapseWhitespace(input) {
  return input.replace(/\s+/g, " ");
}

// R §6 step 2. Outer delimiters are removed once; an unbalanced delimiter *inside* the answer is
// a typo the learner made mid-formula, and stripping it means "x^2 + 1" is not rejected for a
// stray dollar.
function stripDelimiters(input) {
  let s = input;
  // Paired blocks first, so "\[$1$2$]" does not become "$1$2".
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, "$1");
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, "$1");
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, "$1");
  // Unpaired leftovers, anywhere.
  s = s.replace(/\$/g, "").replace(/\\\[|\\\]/g, "").replace(/\\\(|\\\)/g, "");
  return s;
}

function stripSpacing(input) {
  let s = input;
  for (const cmd of SPACING_COMMANDS) s = s.split(cmd).join("");
  return s.replace(/[\u00a0\u2009\u200a\u2007]/g, "");
}

// R §6 step 4. Thousands separators only, and only between digits: removing every comma would turn
// the ordered pair (1,2) into 12, which is a different mathematical object. Both spellings of the
// separator LaTeX and a human produce are handled - "1,234" and "1{,}234" - and the lookahead
// requires exactly three digits followed by a non-digit so "1,2345" is left alone.
function stripThousandsSeparators(input) {
  return input
    .replace(/(\d)\{?,(\d{3})(?!\d)/g, "$1$2")
    .replace(/(\d)\{,\}(\d{3})(?!\d)/g, "$1$2");
}

function stripLeadingPlus(input) {
  return input.replace(/^\s*\+/, "");
}

function stripTrailingPunctuation(input) {
  return input.replace(/(?:\.|\\[!,])\s*$/, "");
}

function stripSizing(input) {
  let s = input;
  for (const cmd of SIZING_COMMANDS) s = s.split(cmd).join("");
  return s;
}

function mapUnicode(input) {
  let s = input;
  for (const [from, to] of UNICODE_TO_LATEX) s = s.split(from).join(to);
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (run) => `^{${[...run].map((c) => SUPERSCRIPTS[c]).join("")}}`);
  s = s.replace(/[₀₁₂₃₄₅₆₇₈₉]+/g, (run) => `_{${[...run].map((c) => SUBSCRIPTS[c]).join("")}}`);
  return s;
}

// R §6 step 8/9. Fractions canonicalise to the same spelling on both sides: "\frac{1}{2}", "1/2",
// "\dfrac{1}{2}" and "\frac12" are one string by the end. Braces are dropped only when both
// arguments are a single token, so "\frac{12}{3}" and "\frac{1}{23}" cannot collide.
function normalizeFractions(input) {
  let s = input.replace(/\\[dt]frac/g, "\\frac");
  let previous;
  do {
    previous = s;
    s = s.replace(/\\frac\s*([0-9]+|[A-Za-z])\s*([0-9]+|[A-Za-z])(?![0-9A-Za-z])/g, "\\frac$1$2");
    s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (m, a, b) => fracSpelling(a, b));
  } while (s !== previous);
  return s;
}

function fracSpelling(a, b) {
  const single = (t) => /^(?:[0-9]|[A-Za-z])$/.test(t.trim());
  return single(a) && single(b) ? `\\frac${a.trim()}${b.trim()}` : `\\frac{${a}}{${b}}`;
}

// A bare "1/2" with numeric operands is a fraction a learner typed as a division. Only numeric
// operands convert, so a pair like "(1,2)" and a ratio "x/y" are left alone.
function expandSlashFractions(input) {
  return input.replace(
    /(?<![0-9A-Za-z})])(-?[0-9]+(?:\.[0-9]+)?)\s*\/\s*(-?[0-9]+(?:\.[0-9]+)?)(?![0-9A-Za-z}])/g,
    (m, num, den) => `\\frac{${num}}{${den}}`,
  );
}

// R §6 step 10. Degrees are the default, so "50" is accepted for "50^\circ". Radians are only
// accepted when the exercise declares them, which is why this is the last step: it needs the
// exercise, not just the string.
function stripDegrees(input, exercise = {}) {
  const radiansDeclared = exercise.angleUnit === "rad";
  const degreesDeclared = exercise.answerAngle === "deg" || exercise.answerUnit === "deg";
  if (radiansDeclared && !degreesDeclared) return input;
  return input.replace(/\^\s*\{\s*\\circ\s*\}/g, "").replace(/\^\\circ/g, "").replace(/\\circ/g, "");
}

// The whole of R §6 steps 1-10, in that order. Exported because the API echoes the canonical
// form back for a learner whose answer was marked wrong: showing them what their input became
// is the difference between "try again" and "I typed it right".
export function canonicalize(input, exercise = {}) {
  if (input === null || input === undefined) return "";
  let s = String(input);
  s = collapseWhitespace(s).trim();
  s = stripDelimiters(s);
  for (const cmd of SPACING_COMMANDS) s = s.split(cmd).join("");
  s = stripSpacing(s);
  s = stripThousandsSeparators(s);
  s = collapseWhitespace(s).trim();
  s = stripLeadingPlus(s);
  s = stripSizing(s);
  s = mapUnicode(s);
  s = expandSlashFractions(s);
  s = normalizeFractions(s);
  s = stripTrailingPunctuation(s);
  s = stripDegrees(s, exercise);
  s = collapseWhitespace(s).trim();
  return s;
}

// ---------------------------------------------------------------------------
// A restricted numeric evaluator. Numbers, the four operations, ^, parentheses,
// \pi, \frac, \sqrt. No identifiers, therefore no variables and therefore no
// symbolic comparison. A token it does not recognise is a parse failure, which
// ends the numeric rung instead of guessing.
// ---------------------------------------------------------------------------

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m;
    if ((m = /^(\d+\.?\d*|\.\d+)/.exec(rest))) {
      // Immediately after \frac, a run of digits is two single-digit arguments, not one number:
      // "\frac12" is one half, and reading it as frac(12) makes the canonical form of every
      // answer the corpus writes as \frac12 fail to parse as a number at all.
      const digits = tokens[tokens.length - 1]?.t === "frac" ? m[1][0] : m[1];
      tokens.push({ t: "num", v: Number(digits) });
      i += digits.length;
      continue;
    }
    if (rest[0] === "{") {
      tokens.push({ t: "{" });
      i += 1;
      continue;
    }
    if (rest[0] === "}") {
      tokens.push({ t: "}" });
      i += 1;
      continue;
    }
    if ((m = /^\\frac/.exec(rest))) {
      tokens.push({ t: "frac" });
      i += m[0].length;
      continue;
    }
    if ((m = /^\\sqrt/.exec(rest))) {
      tokens.push({ t: "sqrt" });
      i += m[0].length;
      continue;
    }
    if (rest.startsWith("\\pi")) {
      tokens.push({ t: "num", v: Math.PI });
      i += 3;
      continue;
    }
    if (rest.startsWith("\\times") || rest.startsWith("\\cdot")) {
      tokens.push({ t: "op", v: "*" });
      i += rest.startsWith("\\times") ? 6 : 5;
      continue;
    }
    if (rest.startsWith("\\div")) {
      tokens.push({ t: "op", v: "/" });
      i += 4;
      continue;
    }
    if (rest.startsWith("\\pm")) {
      tokens.push({ t: "pm" });
      i += 3;
      continue;
    }
    if ("+-*/^".includes(rest[0])) {
      tokens.push({ t: "op", v: rest[0] });
      i += 1;
      continue;
    }
    if (rest[0] === "(" || rest[0] === ")") {
      tokens.push({ t: rest[0] });
      i += 1;
      continue;
    }
    if (rest[0] === " ") {
      i += 1;
      continue;
    }
    return null; // an identifier, an unknown macro, anything not arithmetic
  }
  return tokens;
}

// Returns a number, or null when the string is not a pure numeric expression.
export function evaluateNumber(src) {
  if (typeof src !== "string" || src === "") return null;
  const tokens = tokenize(src);
  if (!tokens || tokens.length === 0) return null;
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parsePrimary() {
    const tok = next();
    if (!tok) return NaN;
    if (tok.t === "num") return tok.v;
    if (tok.t === "(") {
      const v = parseExpression();
      if (peek()?.t !== ")") return NaN;
      next();
      return v;
    }
    if (tok.t === "{") {
      const v = parseExpression();
      if (peek()?.t !== "}") return NaN;
      next();
      return v;
    }
    if (tok.t === "frac") {
      const num = parseBracedArg();
      const den = parseBracedArg();
      if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return NaN;
      return num / den;
    }
    if (tok.t === "sqrt") {
      const arg = parseBracedArg();
      if (arg < 0) return NaN;
      return Math.sqrt(arg);
    }
    if (tok.t === "pm") return parseExpression(); // "1 \pm 2" is never a single number
    return NaN;
  }

  // \frac takes either a braced group or a single token, so both spellings parse.
  function parseBracedArg() {
    if (peek()?.t === "{") {
      next();
      const v = parseExpression();
      if (peek()?.t !== "}") return NaN;
      next();
      return v;
    }
    return parsePrimary();
  }

  function parseUnary() {
    if (peek()?.t === "op" && peek().v === "-") {
      next();
      return -parseUnary();
    }
    if (peek()?.t === "op" && peek().v === "+") {
      next();
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePower() {
    const base = parseUnary();
    if (peek()?.t === "op" && peek().v === "^") {
      next();
      const exp = parseUnary();
      return Math.pow(base, exp);
    }
    return base;
  }

  function parseTerm() {
    let v = parsePower();
    for (;;) {
      const tok = peek();
      if (tok?.t === "op" && (tok.v === "*" || tok.v === "/")) {
        next();
        const rhs = parsePower();
        if (tok.v === "/") {
          if (rhs === 0) return NaN;
          v /= rhs;
        } else {
          v *= rhs;
        }
        continue;
      }
      // Implicit multiplication: "2\pi", "2\sqrt{3}", "3(4)". This is arithmetic, not symbolic
      // algebra - an identifier still cannot be tokenized, so nothing with a variable in it
      // reaches this at all - and without it a learner who types the answer as the textbook
      // writes it is marked wrong for omitting an asterisk.
      if (tok && (tok.t === "num" || tok.t === "(" || tok.t === "{" || tok.t === "frac" || tok.t === "sqrt")) {
        v *= parsePower();
        continue;
      }
      return v;
    }
  }

  function parseExpression() {
    let v = parseTerm();
    while (peek()?.t === "op" && (peek().v === "+" || peek().v === "-")) {
      const op = next().v;
      const rhs = parseTerm();
      v = op === "+" ? v + rhs : v - rhs;
    }
    return v;
  }

  const value = parseExpression();
  if (pos !== tokens.length) return null; // trailing junk: not a single number
  if (Number.isNaN(value) || !Number.isFinite(value)) return null;
  return value;
}

function numbersAgree(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(a - b);
  if (diff <= RADICAL_TOLERANCE.absolute) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale > 0 && diff / scale <= RADICAL_TOLERANCE.relative;
}

// ---------------------------------------------------------------------------
// Pure radicals. R §6 rung 3 exists for exactly two shapes: "2\sqrt{3}" against
// "\sqrt{12}". Both sides must be a rational multiple of a square root of a
// positive integer, and nothing else - no sums of radicals, no nested roots
// beyond a rational one, no variables.
// ---------------------------------------------------------------------------

function integerSquareRoot(n) {
  if (!Number.isInteger(n) || n < 0) return null;
  let r = Math.round(Math.sqrt(n));
  // Correction step, so a float sqrt near an integer boundary cannot mis-slot.
  while (r * r > n) r -= 1;
  while ((r + 1) * (r + 1) <= n) r += 1;
  return r * r === n ? r : null;
}

// Exact rational, kept as {n, d} with d > 0 so coefficient comparison is integer
// arithmetic rather than two floats deciding whether a learner was right.
function rational(n, d = 1) {
  if (d === 0) return null;
  if (d < 0) {
    n = -n;
    d = -d;
  }
  const g = gcd(Math.abs(n), d) || 1;
  return { n: n / g, d: d / g };
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function ratEqual(a, b) {
  return a && b && a.n === b.n && a.d === b.d;
}

// Split "c\sqrt{d}" / "\sqrt{d}" into an exact rational coefficient and an
// integer radicand. Returns null for anything else.
function parseRadical(src) {
  let s = src.trim();
  if (s === "") return null;

  let coefficient = rational(1);
  let radicand = null;

  const rootMatch = /\\sqrt\s*(?:\{([^{}]+)\}|([0-9]+))/.exec(s);
  if (!rootMatch) return null;

  const before = s.slice(0, rootMatch.index).trim();
  const radicandSrc = (rootMatch[1] ?? rootMatch[2]).trim();
  const after = s.slice(rootMatch.index + rootMatch[0].length).trim();
  if (after !== "") return null; // a sum or a product of two radicals: out of scope

  // The radicand must be a positive integer. A nested root or a variable is not a pure radical.
  if (!/^\d+$/.test(radicandSrc)) return null;
  const radicandValue = Number(radicandSrc);
  if (radicandValue <= 0) return null;

  if (before !== "") {
    const asFrac = /^\\frac\{([^{}]+)\}\{([^{}]+)\}$/.exec(before);
    if (asFrac) {
      const n = Number(asFrac[1]);
      const d = Number(asFrac[2]);
      if (!Number.isInteger(n) || !Number.isInteger(d) || d === 0) return null;
      coefficient = rational(n, d);
    } else if (/^-?\d+$/.test(before)) {
      coefficient = rational(Number(before));
    } else {
      return null;
    }
  }

  // Pull out every square factor: sqrt(12) -> 2 * sqrt(3).
  radicand = radicandValue;
  for (let f = 2; f * f <= radicand; f++) {
    while (radicand % (f * f) === 0) {
      radicand /= f * f;
      coefficient = rational(coefficient.n * f, coefficient.d);
    }
  }
  return { coefficient, radicand };
}

function radicalsAgree(a, b) {
  const left = parseRadical(a);
  const right = parseRadical(b);
  if (!left || !right) return false;
  return left.radicand === right.radicand && ratEqual(left.coefficient, right.coefficient);
}

// A shape label, never a value. expectedForm travels back with a wrong answer and its whole
// job is to tell the learner what kind of thing was expected ("a single number") without
// handing over what it was.
export function expectedFormOf(exercise) {
  if (Array.isArray(exercise.choices) && exercise.choices.length > 0) return "choice";
  const canonical = canonicalize(exercise.answerLatex || "", exercise);
  if (parseRadical(canonical)) return "radical";
  if (evaluateNumber(canonical) !== null) return "number";
  return "expression";
}

function comparePair(responseCanonical, answerCanonical, exercise) {
  // Rung 1: exact equality on canonical forms.
  if (responseCanonical === answerCanonical) return { correct: true, method: "exact" };

  // Rung 2: both sides a single number. This is what makes 0.5, 1/2 and \frac12 agree.
  const a = evaluateNumber(responseCanonical);
  const b = evaluateNumber(answerCanonical);
  if (a !== null && b !== null && numbersAgree(a, b)) return { correct: true, method: "numeric" };

  // Rung 3: pure radicals on both sides, light canonicalisation, then compare.
  if (responseCanonical.includes("\\sqrt") && answerCanonical.includes("\\sqrt")) {
    if (radicalsAgree(responseCanonical, answerCanonical)) return { correct: true, method: "radical" };
  }

  // Rung 4 happens in the caller, because it needs the alternatives list.
  return { correct: false, method: "no-match", numeric: { response: a, answer: b } };
}

// Grade a free-response answer against an exercise record.
//
// Returns {correct, method, normalized} and never the answer. `normalized` is the learner's own
// input after canonicalisation, which is theirs to see; `expectedForm` is a shape, not a value.
export function gradeFreeResponse(exercise, response) {
  const normalized = canonicalize(response, exercise);
  if (normalized === "") return { correct: false, method: "empty", normalized: "" };

  const answerCanonical = canonicalize(exercise.answerLatex || "", exercise);
  const direct = comparePair(normalized, answerCanonical, exercise);
  if (direct.correct) return { correct: true, method: direct.method, normalized };

  for (const alternative of exercise.answerAlternatives || []) {
    const alternativeCanonical = canonicalize(alternative, exercise);
    const viaAlternative = comparePair(normalized, alternativeCanonical, exercise);
    if (viaAlternative.correct) {
      return { correct: true, method: `${direct.method === "no-match" ? "alternative" : direct.method}`, normalized };
    }
  }

  return { correct: false, method: "no-match", normalized };
}

// Grade a multiple-choice answer. §3.3 says plainly that MC ships its answer with the exercise,
// so this returns the same verdict shape rather than pretending the key is secret.
export function gradeChoice(exercise, response) {
  const choices = exercise.choices || [];
  const answerCanonical = canonicalize(exercise.answerLatex || "", exercise);
  const correctIndex = choices.findIndex((c) => canonicalize(c, exercise) === answerCanonical);

  let index = null;
  if (typeof response === "number") {
    index = response;
  } else if (typeof response === "string") {
    const asText = response.trim();
    // Choice text first. "64" is both a valid index-shaped token and a valid choice in the
    // example above, and the learner who typed the text meant the text.
    const asTextIndex = choices.findIndex((c) => canonicalize(c, exercise) === canonicalize(asText, exercise));
    if (asTextIndex >= 0) {
      index = asTextIndex;
    } else if (/^\d+$/.test(asText)) {
      index = Number(asText);
    } else {
      const letter = asText.toUpperCase().charCodeAt(0) - 65;
      index = letter >= 0 && letter < choices.length ? letter : null;
    }
  }

  if (index === null || index < 0 || index >= choices.length) {
    return { correct: false, method: "invalid-choice", index: null, correctIndex, normalized: null };
  }
  return {
    correct: correctIndex >= 0 && index === correctIndex,
    method: "choice",
    index,
    // Safe to return: §3.3 ships the MC key in the exercise record itself.
    correctIndex,
    normalized: choices[index],
  };
}

export { numbersAgree, parseRadical, radicalsAgree, ratEqual, rational };
