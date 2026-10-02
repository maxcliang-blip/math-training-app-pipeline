// Turning stored LaTeX into HTML. Two rules, and everything here follows from them.
//
// One: a malformed expression must never blank the page. The corpus is machine-authored and
// some of it is wrong; a render error that throws takes out the whole exercise with it. Every
// segment renders independently and a segment that cannot be rendered degrades to its source
// text, visibly marked, so a bad string is a visible bug report instead of a blank screen.
//
// Two: nothing here trusts the content. KaTeX is configured with trust:false and strict:"warn",
// so \\href, \\url and \\includegraphics cannot turn stored content into an injection vector and
// an unsupported macro degrades to a warning instead of a thrown exception.

import katex from "katex";

// The delimiters the corpus actually uses. `\(...\)` and `\[...\]` are LaTeX's own; the corpus
// also carries `$...$` and `$$...$$` from the authoring tools, and a learner must not see the
// difference between the two conventions.
const SEGMENT_PATTERNS = [
  { name: "display", re: /\$\$([\s\S]+?)\$\$/ },
  { name: "bracket-display", re: /\\\[([\s\S]+?)\\\]/ },
  { name: "paren", re: /\\\(([\s\S]+?)\\\)/ },
  { name: "inline", re: /\$([^$\n]+?)\$/ }
];

// Render one LaTeX source string to HTML. Never throws.
//
// Returns `{ ok: true, html }` or `{ ok: false, html, error }` where `html` is the escaped
// source, so a caller can always put something on screen.
export function renderLatex(source, { displayMode = false } = {}) {
  if (typeof source !== "string" || source.trim() === "") {
    return { ok: false, html: "", error: "empty", failed: false };
  }
  try {
    const html = katex.renderToString(source, {
      displayMode,
      throwOnError: true,
      trust: false,
      strict: "warn",
      output: "html"
    });
    return { ok: true, html, error: null };
  } catch (error) {
    return {
      ok: false,
      html: escapeHtml(source),
      error: String(error && error.message ? error.message : error),
      failed: true
    };
  }
}

// Split a mixed prose-and-math string into alternating segments.
//
// Text segments carry `{ type: "text" }` and math segments `{ type: "math", display }`. An
// unbalanced delimiter — a stray `$` with no partner — is left as text rather than swallowing the
// rest of the string, because swallowing the rest of the string is how one typo costs a learner
// the entire lesson.
export function splitMath(input) {
  if (typeof input !== "string" || input === "") return [];
  const segments = [];
  let rest = input;
  let guard = 0;

  while (rest.length > 0) {
    if (++guard > 1000) {
      // Pathological nesting. Emit the remainder as text and stop rather than spin.
      segments.push({ type: "text", value: rest });
      break;
    }

    let best = null;
    for (const { name, re } of SEGMENT_PATTERNS) {
      const match = re.exec(rest);
      if (match && (best === null || match.index < best.index)) {
        best = { name, match, index: match.index };
      }
    }

    if (!best) {
      segments.push({ type: "text", value: rest });
      break;
    }

    if (best.index > 0) {
      segments.push({ type: "text", value: rest.slice(0, best.index) });
    }
    segments.push({
      type: "math",
      display: best.name === "display" || best.name === "bracket-display",
      value: best.match[1]
    });
    rest = rest.slice(best.index + best.match[0].length);
  }

  return segments;
}

// Split and render in one pass. Returns the segment list with `html` filled in, which is the
// shape MathBlock consumes. `displayMode` is forced on any display segment so that KaTeX emits
// the right wrapper regardless of what the caller passed.
export function renderMixed(input, { displayMode = false } = {}) {
  return splitMath(input).map((segment) => {
    if (segment.type === "text") return { ...segment, html: escapeHtml(segment.value) };
    const rendered = renderLatex(segment.value, { displayMode: segment.display || displayMode });
    return { ...segment, ...rendered };
  });
}

// Convenience for the single-expression case: a prompt that is one big expression, or an answer
// field. Tries the whole string as math first, because `\(\frac{1}{2}\)` split into segments is
// more work for no gain, and falls back to mixed rendering when it is not valid math on its own.
export function renderLatexBlock(source) {
  const whole = renderLatex(source, { displayMode: true });
  if (whole.ok) return { ...whole, segments: [{ type: "math", display: true, ...whole }] };
  const segments = renderMixed(source);
  const failed = segments.some((segment) => segment.failed);
  return { ok: !failed, html: "", error: failed ? "mixed" : null, segments };
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Which segments failed, so MathBlock can mark exactly the broken ones instead of the whole block.
export function failedSegments(segments) {
  return segments.filter((segment) => segment.failed).map((segment) => segment.value);
}
