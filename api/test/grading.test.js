import { test } from "node:test";
import assert from "node:assert";

import { canonicalize, evaluateNumber, gradeChoice, gradeFreeResponse, expectedFormOf, radicalsAgree } from "../src/grading.js";

// Rendering Conventions §6 fixes both the canonicalisation order and the comparison ladder. These
// tests are transcription, not opinion: each case names the rule it pins, because a grader that
// passes for a different reason than the spec's will still pass here and then fail in a learner's
// browser.

function freeAnswer(answerLatex, extra = {}) {
  return { id: "x", answerLatex, answerAlternatives: [], solutionLatex: null, hintLatex: [], choices: null, ...extra };
}

test("§6 step 2: outer math delimiters are removed, and a stray one inside does not reject the answer", () => {
  assert.equal(canonicalize("$x^2+1$"), "x^2+1");
  assert.equal(canonicalize("\\[x^2+1\\]"), "x^2+1");
  assert.equal(canonicalize("\\(x^2+1\\)"), "x^2+1");
  assert.equal(canonicalize("x^2+$1"), "x^2+1");
});

test("§6 steps 5-6: a leading plus and trailing sentence punctuation are dropped, sizing commands are not meaning", () => {
  assert.equal(canonicalize("+42."), "42");
  assert.equal(canonicalize("42\\!"), "42");
  assert.equal(canonicalize("\\left(\\frac{1}{2}\\right)"), "(\\frac12)");
});

test("§6 step 4: thousands separators go, but a comma between non-digits is a tuple and stays", () => {
  assert.equal(canonicalize("1{,}234"), "1234");
  assert.equal(canonicalize("1,234"), "1234");
  assert.equal(canonicalize("(1,2)"), "(1,2)");
  assert.equal(canonicalize("(1,2,3)"), "(1,2,3)");
  // Four digits after the comma is not a thousands group.
  assert.equal(canonicalize("1,2345"), "1,2345");
});

test("§6 step 7: unicode from a keyboard maps to the LaTeX the corpus is written in", () => {
  assert.equal(canonicalize("2×3"), "2\\times3");
  assert.equal(canonicalize("−3"), "-3");
  assert.equal(canonicalize("50°"), "50");
  assert.equal(canonicalize("x²"), "x^{2}");
});

test("§6 steps 8-9: every fraction spelling canonicalises to one form; a decimal is handled by comparison", () => {
  const fractionForms = ["1/2", "\\frac{1}{2}", "\\frac12", "\\dfrac{1}{2}"];
  for (const f of fractionForms) assert.equal(canonicalize(f), "\\frac12", `${f} should be the shared spelling`);
  assert.equal(canonicalize("\\frac{1}{4}"), "\\frac14");
  // A decimal is not rewritten into a fraction: step 8 converts fraction spellings, and rung 2 of
  // the comparison ladder is what makes the decimal agree with it.
  assert.equal(canonicalize("0.5"), "0.5");
  // Multi-digit arguments keep their braces so 12/3 and 1/23 cannot collide.
  assert.equal(canonicalize("\\frac{12}{3}"), "\\frac{12}{3}");
  assert.notEqual(canonicalize("\\frac{12}{3}"), canonicalize("\\frac{1}{23}"));
});

test("§6 step 10: degrees are the default, radians only when the exercise declares them", () => {
  assert.equal(canonicalize("50^\\circ"), "50");
  assert.equal(canonicalize("50^\\circ", { angleUnit: "rad" }), "50^\\circ");
  assert.equal(canonicalize("50^\\circ", { answerAngle: "deg" }), "50");
});

test("the numeric rung is arithmetic, and refuses anything with an identifier in it", () => {
  assert.equal(evaluateNumber("2\\pi"), Math.PI * 2);
  assert.equal(evaluateNumber("\\frac{1}{2}"), 0.5);
  assert.equal(evaluateNumber("\\sqrt{2}"), Math.SQRT2);
  assert.equal(evaluateNumber("2\\sqrt{3}"), 2 * Math.sqrt(3));
  assert.equal(evaluateNumber("2^10"), 1024);
  assert.equal(evaluateNumber("3(4)"), 12);
  // No variables, so no symbolic comparison sneaks in through the numeric rung.
  assert.equal(evaluateNumber("x+1"), null);
  assert.equal(evaluateNumber("2x"), null);
  // Degenerate arithmetic is not a number.
  assert.equal(evaluateNumber("\\frac{1}{0}"), null);
  assert.equal(evaluateNumber("\\sqrt{-1}"), null);
});

test("§6 rung 3: pure radicals agree through a light canonicalisation", () => {
  assert.equal(radicalsAgree("2\\sqrt{3}", "\\sqrt{12}"), true);
  assert.equal(radicalsAgree("\\sqrt{50}", "5\\sqrt{2}"), true);
  assert.equal(radicalsAgree("\\sqrt{12}", "3\\sqrt{3}"), false);
  // A sum of radicals is explicitly out of scope in v1.
  assert.equal(radicalsAgree("1+\\sqrt{2}", "\\sqrt{2}"), false);
});

test("§6 rungs 1-4 in order: 0.5, 1/2 and \\frac12 all pass for \\frac{1}{2}, and 0.51 does not", () => {
  const exercise = freeAnswer("\\frac{1}{2}");
  assert.equal(gradeFreeResponse(exercise, "0.5").correct, true);
  assert.equal(gradeFreeResponse(exercise, "1/2").correct, true);
  assert.equal(gradeFreeResponse(exercise, "\\frac12").correct, true);
  assert.equal(gradeFreeResponse(exercise, "\\dfrac{1}{2}").correct, true);
  assert.equal(gradeFreeResponse(exercise, "0.51").correct, false);
});

test("§6 rung 4: answerAlternatives are canonicalised too, so a decimal alternative is reachable", () => {
  const exercise = freeAnswer("\\frac{1}{4}", { answerAlternatives: ["0.25"] });
  assert.equal(gradeFreeResponse(exercise, "0.25").correct, true);
  assert.equal(gradeFreeResponse(exercise, "1/4").correct, true);
  assert.equal(gradeFreeResponse(exercise, "0.3").correct, false);
});

test("an empty or whitespace response is never correct", () => {
  const exercise = freeAnswer("\\frac{1}{2}");
  assert.equal(gradeFreeResponse(exercise, "").method, "empty");
  assert.equal(gradeFreeResponse(exercise, "   ").method, "empty");
  assert.equal(gradeFreeResponse(exercise, null).correct, false);
});

test("a grader never returns the answer, only the learner's own canonical input", () => {
  const exercise = freeAnswer("\\frac{1}{2}", { solutionLatex: "the secret derivation" });
  const verdict = gradeFreeResponse(exercise, "0.6");
  assert.equal(verdict.correct, false);
  assert.deepEqual(Object.keys(verdict).sort(), ["correct", "method", "normalized"]);
  assert.equal(verdict.normalized, "0.6");
});

test("expectedForm describes the shape of the answer and never its value", () => {
  assert.equal(expectedFormOf(freeAnswer("64")), "number");
  assert.equal(expectedFormOf(freeAnswer("\\frac{5\\pi}{6}")), "number");
  assert.equal(expectedFormOf(freeAnswer("2\\sqrt{3}")), "radical");
  assert.equal(expectedFormOf(freeAnswer("\\text{all real numbers}")), "expression");
  assert.equal(expectedFormOf({ answerLatex: "64", choices: ["64", "63"] }), "choice");
  for (const form of [expectedFormOf(freeAnswer("64")), expectedFormOf(freeAnswer("2\\sqrt{3}"))]) {
    assert.ok(!form.includes("6"), "expectedForm must not carry the answer");
  }
});

test("§3.3: multiple choice grades by index, by letter, and by the choice text itself", () => {
  const exercise = { choices: ["64", "36", "8", "128", "12"], answerLatex: "64", answerAlternatives: [] };
  assert.equal(gradeChoice(exercise, 0).correct, true);
  assert.equal(gradeChoice(exercise, "A").correct, true);
  assert.equal(gradeChoice(exercise, "0").correct, true);
  assert.equal(gradeChoice(exercise, "64").correct, true);
  assert.equal(gradeChoice(exercise, 3).correct, false);
  assert.equal(gradeChoice(exercise, 99).method, "invalid-choice");
  assert.equal(gradeChoice(exercise, "Z").method, "invalid-choice");
});
