// KaTeX's webfonts settle before first paint, or they never settle at all.
//
// KaTeX ships twenty @font-face families and declares none of them with a `font-display`, so they
// inherit `auto`: a three-second block period, then a swap, whenever the face finishes loading. The
// faces are only *requested* once a formula has rendered, which on this app is after the bundle has
// loaded and React has run — so the swap is always after first paint. Until it lands, every formula
// is laid out in the fallback serif; when it lands the browser re-lays the prose around it, and RC §7
// ("Layout shift from math/figures | CLS = 0") is broken by ~1e-4 on a page that is otherwise still.
//
// `font-display: optional` is the fix, and it is the only one that makes the number zero rather than
// smaller. The other two answers both leave a swap in the page:
//
//   * Preloading or reordering only makes the face arrive sooner. It cannot make it arrive before
//     first paint on a connection where it does not, so the defect survives as a timing race — and a
//     gate that depends on a race is a gate that reports a different number on a slow runner.
//   * A metric-overridden fallback (`size-adjust`, `ascent-override`) can match a fallback's line box
//     height exactly and its advance widths only approximately, so the swap still moves something.
//
// `optional` has no swap period at all: the browser gives the face a short block period and then, if
// it has not arrived, uses the fallback for the lifetime of the page and never changes its mind. A
// face that arrives early is used; a face that arrives late is not used at all. Either way the page
// does not move, which is the whole claim.
//
// The cost is stated rather than hidden: on a first visit on a connection slow enough to miss the
// block period, the math renders once in the fallback serif, and the face is cached from then on. The
// preload below is what keeps that window from being the common case.
//
// This is a transform rather than a second set of @font-face rules in the app's own stylesheet on
// purpose. A duplicate face with the same family, weight and style only overrides the original
// because the last one declared wins, which is a cascade detail rather than a guarantee — and if a
// browser disagreed, the override would silently stop working. Rewriting the declaration in place
// leaves one rule, with one `font-display`, that every browser has to honour.

const KATEX_CSS = /[\\/]katex[\\/]dist[\\/]katex(\.min)?\.css(\?.*)?$/;

// Every @font-face in KaTeX's stylesheet, with the swap removed. Faces that already declare a
// display policy are left alone rather than overridden, so this stays correct if KaTeX grows one.
//
// The separator matters. KaTeX's declarations do not end in a semicolon, because a CSS block's last
// declaration does not need one — so appending `font-display:optional` directly to the body produces
// `src:url(...) format("truetype")font-display:optional`, where the display policy is swallowed into
// the value of `src` and the face silently keeps the default. That is invisible in the emitted CSS
// unless you look for it, and the only symptom is the layout shift still being there.
const settleFontDisplay = (css) =>
  css.replace(/@font-face\s*\{([^}]*)\}/g, (block, body) =>
    /font-display\s*:/.test(body) ? block : `@font-face{${body.replace(/;\s*$/, "")};font-display:optional}`
  );

// KaTeX_Main-Regular is the one face preloaded, and it is preloaded for a stated reason: it is the
// face that carries prose. `.katex .base` is laid out in KaTeX_Main, and MathBlock renders a
// paragraph of prose with no `$` in it as a single math box (web/src/lib/latex.js), so this face
// arriving late resizes a box the width of a paragraph and moves everything under it. The other
// faces are requested the moment a formula that needs them renders, which on this reader is after the
// app has loaded and a connection is warm, and they are two orders of magnitude smaller.
//
// The href is taken from the emitted asset rather than written out, because the build hashes it and a
// hard-coded path is a 404 that only shows up in production.
const PRELOADED_FACE = /(^|\/)KaTeX_Main-Regular-[^/\\]*\.woff2$/;

export default function katexFontDisplay() {
  return {
    name: "katex-font-display",

    transform(code, id) {
      if (!KATEX_CSS.test(id)) return null;
      return { code: settleFontDisplay(code), map: null };
    },

    transformIndexHtml: {
      // After Vite has written the asset filenames, which is the only point at which they exist.
      order: "post",
      handler(html, ctx) {
        const asset = Object.values(ctx.bundle || {}).find(
          (file) => file && PRELOADED_FACE.test(file.fileName)
        );
        if (!asset) return html;
        // crossorigin even though the face is served from our own origin: a font is always fetched
        // in CORS mode, and a preload without it is a second, unused request for the same file.
        const link = `<link rel="preload" href="/${asset.fileName}" as="font" type="font/woff2" crossorigin>`;
        return html.replace("</head>", `  ${link}\n  </head>`);
      }
    }
  };
}