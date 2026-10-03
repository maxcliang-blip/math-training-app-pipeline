// Figure — renders one figure for a lesson or exercise.
//
// The parent hands over a reference ({ figureKey, asymptoteAspectRatio }) exactly as the API sends
// it; the payload is fetched here, once, against the figure route. That is the whole point of the
// contract: a lesson response carries a key and the shape to reserve, not figure bytes, so a
// lesson page costs one figure request, not one per figure in the lesson body.
//
// The shape is on the reference and not on the payload because of Rendering Conventions §5.4: the
// box is sized from asymptoteAspectRatio at first paint, and first paint of a figure happens before
// its payload exists. The figure is laid into that box with object-fit: contain, so what arrives
// later cannot move anything — not the box, and not the geometry of the drawing.
//
// Nothing here renders an error state for a missing figure. A 503 means the build has not run,
// which is a deployment fact and not the learner's problem; the prose around it is still correct
// and still worth showing.

import React, { useEffect, useRef, useState } from "react";
import { createFigureClient, figurePlaceholder, resolveFigureRatio } from "../lib/figures.js";
import MathBlock from "./MathBlock.jsx";

let sharedClient = null;
function client() {
  if (!sharedClient) sharedClient = createFigureClient({ apiBase: "", origin: "" });
  return sharedClient;
}

// Vite substitutes import.meta.env at build time; the guard keeps this module importable outside a
// Vite build, where the ratio drift is still recorded on the element but not warned about.
const IS_DEV = typeof import.meta.env === "undefined" ? false : Boolean(import.meta.env.DEV);

export default function Figure({ figureKey, alt, captionLatex, declaredAspectRatio }) {
  const [state, setState] = useState(null);
  const [measured, setMeasured] = useState(null);

  // The box is sized once per figure, on that figure's first paint, and never resized afterwards
  // (Rendering Conventions §5.4 items 1 and 5). The ref is the mechanism: a later re-render — the
  // payload arriving, the SVG decoding — reads the same number it already committed to, so a box
  // that has been painted cannot change under the reader. Keyed on figureKey so a different figure
  // in the same slot reserves its own shape rather than inheriting the previous one's.
  //
  // This has to happen during render rather than in an effect, because an effect runs after the
  // browser has already laid the box out; swapping the ratio then is precisely the shift the
  // reservation exists to prevent.
  const reservation = useRef(null);
  if (reservation.current?.figureKey !== figureKey) {
    reservation.current = {
      figureKey,
      ratio: resolveFigureRatio({ declaredAspectRatio }).reserved
    };
  }
  const ratio = reservation.current.ratio;
  const boxStyle = { "--fig-ratio": String(ratio) };

  useEffect(() => {
    if (!figureKey) return;
    let live = true;
    setState(null);
    // The previous figure's measurement belongs to the previous figure.
    setMeasured(null);
    client()
      .getFigure(figureKey)
      .then((result) => {
        if (live) setState(result);
      });
    return () => {
      live = false;
    };
  }, [figureKey]);

  // The payload's own numbers, reported rather than applied. `declaredAspectRatio` from the
  // reference is what the box was reserved from, so it wins over the payload's copy when both
  // exist; the payload's is the build's view of the same authored field.
  const { drift } = resolveFigureRatio({
    declaredAspectRatio: declaredAspectRatio ?? state?.declaredAspectRatio,
    compiledAspectRatio: state?.compiledAspectRatio,
    measuredAspectRatio: measured
  });

  const driftKey = drift.map((d) => `${d.kind}:${d.expected}->${d.actual}`).join(" ");
  useEffect(() => {
    if (!driftKey || !IS_DEV) return;
    console.warn(
      `[figure ${figureKey}] ${driftKey} — the box is reserved at ${ratio} and the <img> is ` +
        "`object-fit: contain`ed into it, so the picture is letterboxed rather than stretched. " +
        "Fix the authoring record or the compiler, not the stylesheet."
    );
  }, [driftKey, figureKey, ratio]);

  if (!figureKey) return null;

  // Loading is the same visual state as unavailable on purpose: a placeholder that never claims
  // the figure is coming and then withdraws it does not flicker. Both keep the reserved box, so
  // the arrival of the payload changes no dimension.
  if (!state) {
    return (
      <div className="figure figure--pending" aria-hidden="true" style={boxStyle}>
        <div className="figure__box" />
      </div>
    );
  }

  if (state.status !== "ready") {
    const placeholder = figurePlaceholder(state);
    return (
      <div className="figure figure--unavailable" style={boxStyle} data-reason={placeholder.detail}>
        <div className="figure__box">
          <span className="figure__placeholder">{placeholder.label}</span>
        </div>
      </div>
    );
  }

  // The alt on the payload wins over the prop: it came from the authoring record that owns the
  // figure, so it describes this figure rather than whatever placeholder text the caller passed.
  const altText = state.alt || alt || "Figure";

  return (
    <figure className="figure figure--ready" style={boxStyle}>
      {/* The box owns the reserved aspect ratio and nothing else. The <img> is absolutely
          positioned inside it, so the image fills the box without ever contributing a dimension of
          its own — which is what makes the box the same size before and after the SVG lands. */}
      <div className="figure__box">
        <img
          className="figure__svg"
          src={state.src}
          alt={altText}
          onLoad={(event) => {
            // Recorded, and deliberately not applied. The measurement is how we know the
            // declaration is wrong; making it the box's ratio is how the box used to resize itself
            // after first paint.
            const img = event.currentTarget;
            if (img.naturalWidth && img.naturalHeight) {
              setMeasured(img.naturalWidth / img.naturalHeight);
            }
          }}
          data-figure-ratio={String(ratio)}
          data-figure-ratio-drift={driftKey || undefined}
          loading="lazy"
        />
      </div>
      {state.captionLatex || captionLatex ? (
        <figcaption className="figure__caption">
          <MathBlock source={state.captionLatex || captionLatex} />
        </figcaption>
      ) : null}
    </figure>
  );
}

// The form a lesson or exercise record actually carries. Extracted so that a caller passing the
// whole exercise object does not accidentally thread a payload through from some other response.
//
// asymptoteAspectRatio comes off the reference rather than the figure route, because the box has
// to be reserved before that route is asked. Fetching it first would mean asking for the ratio in
// order to know how much room the ratio needs.
export function FigureRef({ reference }) {
  if (!reference || typeof reference.figureKey !== "string") return null;
  return <Figure figureKey={reference.figureKey} declaredAspectRatio={reference.asymptoteAspectRatio} />;
}
