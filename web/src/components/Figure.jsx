// Figure — renders one figure for a lesson or exercise.
//
// The parent hands over a reference ({ figureKey } and nothing else) exactly as the API sends it;
// the payload is fetched here, once, against the figure route. That is the whole point of the
// contract: a lesson response carries a key and no figure bytes, so a lesson page costs one
// figure request, not one per figure in the lesson body.
//
// Nothing here renders an error state for a missing figure. A 503 means the build has not run,
// which is a deployment fact and not the learner's problem; the prose around it is still correct
// and still worth showing.

import React, { useEffect, useState } from "react";
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

  const { reserved, resolved: ratio, drift } = resolveFigureRatio({
    declaredAspectRatio: state?.declaredAspectRatio ?? declaredAspectRatio,
    compiledAspectRatio: state?.compiledAspectRatio,
    measuredAspectRatio: measured
  });

  const driftKey = drift.map((d) => `${d.kind}:${d.expected}->${d.actual}`).join(" ");
  useEffect(() => {
    if (!driftKey || !IS_DEV) return;
    console.warn(
      `[figure ${figureKey}] ${driftKey} — the box uses the measured SVG ratio (${measured?.toFixed(3)}). ` +
        "Fix the authoring record or the compiler, not the stylesheet."
    );
  }, [driftKey, figureKey, measured]);

  if (!figureKey) return null;

  // Loading is the same visual state as unavailable on purpose: a placeholder that never claims
  // the figure is coming and then withdraws it does not flicker.
  if (!state) {
    return <div className="figure figure--pending" aria-hidden="true" />;
  }

  if (state.status !== "ready") {
    const placeholder = figurePlaceholder(state);
    return (
      <div className="figure figure--unavailable" data-reason={placeholder.detail}>
        <span className="figure__placeholder">{placeholder.label}</span>
      </div>
    );
  }

  // The alt on the payload wins over the prop: it came from the authoring record that owns the
  // figure, so it describes this figure rather than whatever placeholder text the caller passed.
  const altText = state.alt || alt || "Figure";

  return (
    <figure className="figure figure--ready">
      <img
        className="figure__svg"
        src={state.src}
        alt={altText}
        // Reserve the box at the manifest's ratio so the lesson does not reflow under the reader as
        // the SVG arrives, then correct it to the ratio the browser actually measured. Holding the
        // reserved ratio after the image has loaded is what stretches a diagram that does not match
        // its own declared shape, so `resolved` deliberately prefers the measurement.
        style={ratio ? { aspectRatio: String(ratio) } : undefined}
        onLoad={(event) => {
          const img = event.currentTarget;
          if (img.naturalWidth && img.naturalHeight) {
            setMeasured(img.naturalWidth / img.naturalHeight);
          }
        }}
        data-figure-ratio={reserved ? String(reserved) : undefined}
        data-figure-ratio-drift={driftKey || undefined}
        loading="lazy"
      />
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
export function FigureRef({ reference }) {
  if (!reference || typeof reference.figureKey !== "string") return null;
  return <Figure figureKey={reference.figureKey} />;
}
