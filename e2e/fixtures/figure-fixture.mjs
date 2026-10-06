// A figure fixture for the browser tests, written by scripts that both the API fixture server and
// the teardown import.
//
// It exists because the no-reflow contract (Rendering Conventions §5.4) is only testable in a
// browser, and a browser test that runs against whatever the last local Asymptote build happened to
// leave in artifacts/ is a test that passes for the wrong reason. Worse: the corpus's authored
// ratios disagree with their compiled SVGs on 65 of 69 figures (MAX-61's subject), so a test that
// happens to agree with the corpus proves nothing about a figure that does not.
//
// So the fixture is the worst case on purpose, and it is written with a stated arithmetic:
//
//   declared (and therefore reserved) ratio : 4.000
//   compiled SVG's intrinsic ratio         : 1.000
//
// A box reserved at 4:1 and an SVG that is 1:1 disagree by 300%, which is the largest disagreement
// expressible as "the reservation is wrong and the picture is not". An implementation that applies
// the measurement to the box after load (which is what MAX-72 removed) changes the box height by
// 4x on this figure and reports a layout shift. An implementation that reserves once and lays the
// <img> in with object-fit: contain reports none.
//
// 4:1 and 1:1 were chosen over two awkward ratios because both are exactly representable, so the
// test asserts exact pixel geometry rather than a tolerance band it would then have to justify.

export const FIGURE_KEY = "e2e-l1.sections.concept.figures[0]";
export const SVG_FILE = "e2e-figure-square.svg";
export const SVG_URL = `/artifacts/figures/svg/${SVG_FILE}`;
export const SVG_INTRINSIC_RATIO = 1; // 400 x 400
export const AUTHORED_ASPECT_RATIO = 4; // 1600 x 400 reserved
export const LESSON_ID = "e2e-l1";
export const MODULE_ID = "M1";

// 400 x 400 with no viewBox tricks: intrinsic ratio exactly 1. Inline-free, so it behaves the same
// through <img> as a sanitised build output would.
export const SVG_SOURCE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">' +
  '<rect x="0" y="0" width="400" height="400" fill="#ffffff"/>' +
  '<circle cx="200" cy="200" r="120" fill="#dbeafe" stroke="#1d4ed8" stroke-width="8"/>' +
  '<line x1="40" y1="200" x2="360" y2="200" stroke="#1d4ed8" stroke-width="8"/>' +
  '<line x1="200" y1="40" x2="200" y2="360" stroke="#1d4ed8" stroke-width="8"/>' +
  "</svg>\n";

const HASH = "sha256:e2e-fixture-square-400";

// One lesson, one module, one figure, no exercises.
//
// The lesson deliberately has prose *below* the figure, and that is load-bearing rather than
// decorative. A layout shift is only reported for elements that are in the viewport and that move;
// a figure box at the bottom of a page can change height by any amount and move nothing that anyone
// can see, so an implementation that resized it would report CLS 0. The paragraph after the figure
// is what the shift moves, and it is why the shape of the fixture lesson is part of the fixture
// rather than incidental to it.
export const CONTENT_ROOT_FILES = {
  "modules.json": [{ id: MODULE_ID, code: MODULE_ID, title: "E2E fixture module", tiers: ["10"] }],
  "lessons/e2e-l1.json": {
    id: LESSON_ID,
    moduleId: MODULE_ID,
    order: 1,
    title: "A lesson with one square figure",
    tiers: ["10"],
    tags: ["e2e"],
    prerequisites: [],
    sections: {
      concept: {
        conceptLatex: "One figure, reserved before it arrives.",
        figures: [
          {
            asymptoteSource: "draw((0,0)--(100,0)--(0,100)--cycle);",
            asymptoteAlt: "A right triangle with a horizontal and a vertical leg",
            asymptoteAspectRatio: AUTHORED_ASPECT_RATIO
          }
        ]
      },
      method: {
        conceptLatex:
          "This paragraph sits below the figure on purpose. A box that changes height pushes " +
          "everything under it, and that movement is what the browser reports as a layout shift, " +
          "so this is the text that a resizing figure would move."
      }
    }
  },
  "exercises/.keep": ""
};

// A manifest the API will accept as usable, describing the fixture SVG. status must be "pass" and
// there must be at least one figure, or the figure route degrades to a 503 and the test would be
// asserting the placeholder rather than the reservation.
export function fixtureManifest() {
  return {
    pipelineVersion: "e2e-fixture@1",
    status: "pass",
    toolchain: { asymptote: "fixture", dvisvgm: "fixture" },
    figures: [
      {
        figureKey: FIGURE_KEY,
        figureSvgUrl: SVG_URL,
        figureHash: HASH,
        figurePipelineVersion: "e2e-fixture@1",
        // The build disagrees with the author, exactly as the deployed corpus does. This is what
        // produces the drift record the test also checks.
        declaredAspectRatio: AUTHORED_ASPECT_RATIO,
        compiledAspectRatio: SVG_INTRINSIC_RATIO,
        alt: "A right triangle with a horizontal and a vertical leg",
        captionLatex: ""
      }
    ]
  };
}