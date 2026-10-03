// LessonFigures — the lazy boundary for the figure bundle.
//
// Rendering Conventions §5.5: "Lazy-loaded, only on routes that can contain figures (a lesson or
// exercise view). Never on the dashboard, module list, or progress pages — those must not pull the
// figure bundle." §7 budgets that at 0 KB and names the rule as a hard requirement: no figure
// module imported statically from anything a non-figure route loads.
//
// So this file exists to be the single edge out of the entry chunk and into the figure bundle.
// `Figure.jsx` and `lib/figures.js` are not imported by `App.jsx`, `ModuleList` or `ModuleView`;
// they are reached through here, and here is reached through `React.lazy` in App.jsx, which does
// not evaluate its import until the lazy component is first rendered. The dashboard, the module
// list and the progress view render no lesson figure, so the browser is never asked for the chunk
// at all — that is what "0 KB" means, as opposed to "downloaded and then not drawn".
//
// Everything a figure needs is in this chunk and nothing outside it is needed to draw one: the
// client, the payload validation, the ratio resolver and the components. `MathBlock` stays in the
// entry chunk because a caption is prose and a lesson without figures still has math in it, so
// pulling the figure bundle for a caption would be the same mistake one level down.
//
// One component crosses the boundary, not two. A lesson carries a figure in two shapes — an
// exercise or a worked example has `figureKey` on the record, a lesson section has a `reference`
// object — and each renders a different component in Figure.jsx. Binding `React.lazy` to a single
// export that accepts both is what makes it impossible to route the reference to the component
// that only reads `figureKey`: there is no second wiring to get wrong, and the boundary has one
// prop shape to test. (It was get-able. It was got wrong, and the lesson rendered an empty div and
// asked the figure route for nothing — a silent loss of every lesson-section figure that no unit
// test saw, because the bug was in which export the lazy import named.)
//
// The assertion that the split still holds is `npm run build --workspace web`, which runs
// scripts/assert-figure-bundle-split.mjs and fails when any statically imported chunk reachable
// from an entry carries this bundle.

import React from "react";
import Figure, { FigureRef, FigureUnavailable } from "./Figure.jsx";

// The two shapes a lesson and an exercise carry a figure in. A `reference` wins over a bare
// `figureKey`, because a reference is the more specific statement and it carries the description
// the degraded box needs; `FigureRef` forwards that description and `Figure` alone cannot.
export function LessonFigure({ reference, figureKey, alt, captionLatex, declaredAspectRatio }) {
  if (reference && typeof reference.figureKey === "string") {
    return <FigureRef reference={reference} />;
  }
  return <Figure figureKey={figureKey} alt={alt} captionLatex={captionLatex} declaredAspectRatio={declaredAspectRatio} />;
}

export { Figure, FigureRef, FigureUnavailable };

export default LessonFigure;