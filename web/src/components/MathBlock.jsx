// MathBlock — renders a stored string that mixes prose and LaTeX.
//
// The contract is one HTML string per segment plus a `failed` flag, so this component contains no
// parsing and no error handling. Every decision about what a bad expression looks like was made
// in latex.js and is unit-tested there. `dangerouslySetInnerHTML` is safe here only because
// latex.js renders with katex trust:false and escapes every text segment; that pairing is what the
// test "a stored <script> in a prompt renders as text" pins down.

import React, { useMemo } from "react";
import { renderMixed, renderLatexBlock, failedSegments } from "../lib/latex.js";

function Segmented({ segments }) {
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === "text") {
          return <React.Fragment key={index}>{segment.html}</React.Fragment>;
        }
        if (segment.failed) {
          return (
            <code
              key={index}
              className="math-block__failed"
              role="img"
              aria-label="This expression could not be rendered"
              title={segment.error}
            >
              {segment.value}
            </code>
          );
        }
        return (
          <span
            key={index}
            className={segment.display ? "math-block__display" : "math-block__inline"}
            dangerouslySetInnerHTML={{ __html: segment.html }}
          />
        );
      })}
    </>
  );
}

export default function MathBlock({ children, source, block = false, className = "" }) {
  const text = source ?? children ?? "";
  const mode = useMemo(() => {
    if (block) return { kind: "block" };
    return { kind: "auto" };
  }, [block]);

  const segments = useMemo(() => {
    if (typeof text !== "string" || text === "") return [];
    if (mode.kind === "block") return renderLatexBlock(text).segments;
    return renderMixed(text);
  }, [text, mode.kind]);

  if (segments.length === 0) return null;

  const broken = failedSegments(segments);
  const classes = ["math-block", block ? "math-block--block" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      data-broken={broken.length > 0 ? "true" : undefined}
      data-broken-count={broken.length || undefined}
    >
      <Segmented segments={segments} />
    </div>
  );
}

// KaTeX ships its stylesheet as CSS. Importing it from the component means the math is styled
// anywhere MathBlock is used, instead of depending on someone remembering a <link> in index.html.
import "katex/dist/katex.min.css";
