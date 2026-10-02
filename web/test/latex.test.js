// Unit tests for the math rendering layer.
//
// These run under node --test with no DOM and no build step, which is the reason the parsing and
// rendering logic lives in lib/latex.js and MathBlock stays a thin wrapper. A JSX component cannot
// be unit-tested without a transform, so anything that can be tested is deliberately not in the
// component.

import test from "node:test";
import assert from "node:assert/strict";
import katex from "katex";
import {
  renderLatex,
  renderMixed,
  renderLatexBlock,
  splitMath,
  escapeHtml,
  failedSegments
} from "../src/lib/latex.js";

test("renders a valid expression", () => {
  const result = renderLatex("\\frac{1}{2}");
  assert.equal(result.ok, true);
  assert.match(result.html, /katex/);
});

test("a malformed expression degrades to its source instead of throwing", () => {
  const result = renderLatex("\\frac{1}{");
  assert.equal(result.ok, false);
  assert.equal(result.failed, true);
  assert.equal(result.html, "\\frac{1}{");
  assert.ok(result.error, "an error message is available for the bug report path");
});

test("an empty source is not a failure, it is nothing to render", () => {
  for (const value of ["", "   ", null, undefined, 42]) {
    const result = renderLatex(value);
    assert.equal(result.ok, false);
    assert.equal(result.failed, false, `${JSON.stringify(value)} is empty, not broken`);
  }
});

test("splits prose and inline math on dollar delimiters", () => {
  const segments = splitMath("What is $x^2$ plus $y$?");
  assert.deepEqual(
    segments.map((s) => s.type),
    ["text", "math", "text", "math", "text"]
  );
  assert.equal(segments[1].value, "x^2");
  assert.equal(segments[1].display, false);
});

test("splits display math and marks it as display", () => {
  for (const input of ["$$x^2$$", "\\[x^2\\]"]) {
    const segments = splitMath(input);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].type, "math");
    assert.equal(segments[0].display, true, `${input} is display math`);
  }
});

test("splits LaTeX's own delimiters, not only the authoring tool's", () => {
  // The corpus mixes conventions: \\( \\) from hand-written LaTeX, $ $ and $$ $$ from the
  // authoring tools. A learner must not see the difference.
  const segments = splitMath("see \\(a\\) and $$b$$");
  assert.deepEqual(
    segments.map((s) => s.value),
    ["see ", "a", " and ", "b"]
  );
  assert.deepEqual(
    segments.map((s) => s.type),
    ["text", "math", "text", "math"]
  );
});

test("an unbalanced delimiter does not swallow the rest of the string", () => {
  // The failure mode this pins: a stray $ makes a naive non-greedy match run to the end of the
  // paragraph, so one typo costs the learner every sentence after it.
  const segments = splitMath("costs $5. Then: solve for x.");
  assert.equal(segments.filter((s) => s.type === "math").length, 0);
  const text = segments.map((s) => s.value).join("");
  assert.ok(text.includes("solve for x"), "the trailing sentence survives as text");
});

test("plain prose with no math is one text segment", () => {
  const segments = splitMath("Just words, no symbols at all.");
  assert.deepEqual(segments, [{ type: "text", value: "Just words, no symbols at all." }]);
});

test("empty and non-string input produces no segments", () => {
  assert.deepEqual(splitMath(""), []);
  assert.deepEqual(splitMath(null), []);
  assert.deepEqual(splitMath(undefined), []);
});

test("text segments are HTML-escaped", () => {
  const segments = renderMixed("<script>alert(1)</script> $x$");
  const text = segments[0];
  assert.equal(text.type, "text");
  assert.ok(!text.html.includes("<script>"), "a stored script tag renders as text, never as markup");
  assert.match(text.html, /&lt;script&gt;/);
});

test("a stored payload cannot reach KaTeX's dangerous commands", () => {
  // trust:false is what makes dangerouslySetInnerHTML in MathBlock safe. This is the test that
  // fails loudly if someone flips it to true for a nicer \\href.
  const attempt = renderLatex("\\href{https://evil.example}{click}");
  const rendered = katex.renderToString("\\href{https://evil.example}{click}", {
    throwOnError: true,
    trust: true,
    strict: "ignore"
  });
  assert.ok(rendered.includes("evil.example"), "with trust:true it would render a live link");
  assert.ok(!attempt.html.includes("evil.example"), "with trust:false it does not");
});

test("renders each segment independently so one bad expression is not fatal", () => {
  const segments = renderMixed("Good $a$ then $\\frac{1}{$ then $b$");
  assert.equal(failedSegments(segments).length, 1, "exactly one segment is broken");
  const math = segments.filter((s) => s.type === "math");
  assert.equal(math[0].ok, true, "the valid expressions still render");
  assert.equal(math[math.length - 1].ok, true);
});

test("failedSegments reports the broken source, for the bug report path", () => {
  const segments = renderMixed("$a$ $\\frac{1}{$ $b$");
  assert.deepEqual(failedSegments(segments), ["\\frac{1}{"]);
});

test("renderLatexBlock prefers a whole-string render when the string is one expression", () => {
  const result = renderLatexBlock("\\frac{1}{2}");
  assert.equal(result.ok, true);
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].type, "math");
});

test("renderLatexBlock falls back to mixed rendering for prose", () => {
  const result = renderLatexBlock("Compute $x^2$ now.");
  assert.ok(result.segments.length > 1);
  assert.equal(result.failed, undefined);
});

test("display mode is forced on display segments regardless of the caller flag", () => {
  const [segment] = renderMixed("$$x^2$$", { displayMode: false });
  assert.ok(segment.html.includes("katex-display"), "a $$ block renders as display math");
});

test("escapeHtml covers the characters that matter in an attribute or a text node", () => {
  assert.equal(escapeHtml(`<a href="x">&</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
});
