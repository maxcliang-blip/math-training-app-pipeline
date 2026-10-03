// Rendering Conventions §8.6: "With the figure endpoint forced to fail, the alt text is visible,
// the box keeps its size, and the lesson remains fully usable."
//
// This is the assertion for that sentence, and it is the only place in web/test that renders a
// component. web/test/latex.test.js records why the rest of the suite does not: "these run under
// node --test with no DOM and no build step ... a JSX component cannot be unit-tested without a
// transform, so anything that can be tested is deliberately not in the component." That rule stays
// in force -- the decisions this test exercises all live in src/lib/figures.js -- but §8.6 is about
// what a learner can see, so it needs the box the component actually draws.
//
// So this test compiles Figure.jsx with the project's own build tool (vite, a declared devDependency
// with @vitejs/plugin-react, the same pair vite.config.js uses), renders it with react-dom/server,
// and reads the HTML. No jsdom, no playwright, no second toolchain: node --test still runs it, and it
// costs one 0.3s build. The bundle is written inside web/test so its bare `react` imports resolve the
// way they do in the app.
//
// What it is not: a browser. It cannot measure a layout shift, so it does not claim §5.4. It asserts
// what is in the DOM — the text, and the ratio the box is sized at — which is the part of §8.6 that
// was missing.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "vite";
import react from "@vitejs/plugin-react";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createFigureClient, figureUnavailableView, FIGURE_UNAVAILABLE_MESSAGE } from "../src/lib/figures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRIES = {
  // Figure.jsx on its own: the box the lesson draws when the endpoint fails.
  figure: path.resolve(HERE, "../src/components/Figure.jsx"),
  // LessonFigures.jsx is the whole lazy boundary — the component App.jsx's React.lazy actually
  // resolves to, with Figure.jsx and lib/figures.js behind it. Compiling it separately is what
  // makes the boundary's own prop contract testable; see the tests at the bottom of this file.
  boundary: path.resolve(HERE, "../src/components/LessonFigures.jsx")
};

let FigureUnavailable;
let LessonFigure;
let scratch;

before(async () => {
  // The same transform the app is built with. configFile: false because this is a library build, not
  // the app's dev server, and it must not inherit the dev proxy.
  const result = await build({
    configFile: false,
    root: path.resolve(HERE, ".."),
    logLevel: "error",
    plugins: [react()],
    build: {
      ssr: true,
      write: false,
      target: "node20",
      rollupOptions: { input: ENTRIES, output: { entryFileNames: "[name].mjs" } }
    }
  });
  const output = Array.isArray(result) ? result[0].output : result.output;
  const entry = (name) => {
    const chunk = output.find((c) => c.type === "chunk" && c.isEntry && c.name === name);
    assert.ok(chunk, `${name} compiled to an entry chunk`);
    return chunk.code;
  };
  scratch = await mkdtemp(path.join(HERE, ".degraded-"));
  const write = async (name, code) => {
    const file = path.join(scratch, `${name}.mjs`);
    await writeFile(file, code);
    return pathToFileURL(file).href;
  };
  ({ FigureUnavailable } = await import(await write("figure", entry("figure"))));
  ({ LessonFigure } = await import(await write("boundary", entry("boundary"))));
});

after(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const KEY = "m6-l3-p6";
const DESCRIPTION = "A circle lies mostly in the second quadrant.";

// The reference exactly as the API sends it: a key and the authored description, no payload. This
// is the whole of what a client holds on the lessons page when the figure route 503s.
const REFERENCE = { figureKey: KEY, asymptoteAlt: DESCRIPTION };

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Force the figure endpoint to fail, then render the box the lesson would render from the result.
// The endpoint failures are the ones the corpus actually produces: a build that produced no usable
// manifest (hard 503, every key), a key the build never emitted (404), and a dropped connection.
const FAILURES = {
  "toolchain-missing (no usable manifest)": () => jsonResponse(503, { status: "toolchain-missing" }),
  "http-404 (key not in the manifest)": () => jsonResponse(404, {}),
  network: () => {
    throw new Error("connection reset");
  }
};

async function degradedHtml(failure, props = {}) {
  const client = createFigureClient({ fetchImpl: async () => failure() });
  const result = await client.getFigure(REFERENCE.figureKey);
  const { message, detail, alt, aspectRatio } = figureUnavailableView(result, {
    alt: REFERENCE.asymptoteAlt,
    ...props
  });
  assert.notEqual(result.status, "ready", "the endpoint really did fail");
  const html = renderToStaticMarkup(React.createElement(FigureUnavailable, { message, detail, alt, aspectRatio }));
  return { result, html };
}

for (const [name, failure] of Object.entries(FAILURES)) {
  test(`§8.6: the alt text is visible when the figure endpoint fails — ${name}`, async () => {
    const { html } = await degradedHtml(failure);

    // Visible text, not an attribute. An alt= attribute is what a screen reader gets and nobody
    // else; §5.6 says the alt text is rendered *visibly*, so it has to be in the text of the page.
    assert.ok(html.includes(DESCRIPTION), `the description is not in the DOM: ${html}`);
    assert.match(html, /figure__alt">A circle lies mostly in the second quadrant\.<\/p>/);
    assert.equal(/alt="/.test(html), false, `the description is only an attribute: ${html}`);

    // Not hidden from anyone. The pending box is aria-hidden because it is a placeholder; the
    // degraded box is content, so hiding it from assistive tech would hide the content itself.
    assert.equal(html.includes("aria-hidden"), false);

    // The spec's copy, verbatim, as page text.
    assert.equal(FIGURE_UNAVAILABLE_MESSAGE, "Figure unavailable — the description below is complete.");
    assert.ok(html.includes(FIGURE_UNAVAILABLE_MESSAGE), `the copy is not in the DOM: ${html}`);
  });
}

test("§8.6: the box keeps its size — the reserved ratio survives the failure", async () => {
  // The SVG is not coming, so nothing will ever correct this box. It is sized once, from the
  // authored ratio, and that is what keeps the lesson from reflowing under the reader.
  const { html } = await degradedHtml(FAILURES.network, { declaredAspectRatio: 0.661 });
  assert.match(html, /aspect-ratio:\s*0\.661/);

  // With no ratio authored anywhere, the documented default rather than an unreserved box.
  const { html: defaulted } = await degradedHtml(FAILURES.network);
  assert.match(defaulted, /aspect-ratio:\s*1\.333/);
});

test("§8.6: the lesson stays usable — the reason is inspectable and the prose is untouched", async () => {
  // data-reason is how QA tells a build that never ran from a key the build did not emit, and it
  // costs the learner nothing: it is not what the sentence says. toolchain-missing is a deployment
  // fact, so it is available for debugging and absent from the copy.
  const built = await degradedHtml(FAILURES["toolchain-missing (no usable manifest)"]);
  assert.match(built.html, /data-reason="pipeline-not-run"/);
  assert.equal(built.html.includes("not built yet"), false, "the deployment fact is not the copy");
  assert.equal(built.html.includes("toolchain"), false, "and it is not what the learner reads");

  const missing = await degradedHtml(FAILURES["http-404 (key not in the manifest)"]);
  assert.match(missing.html, /data-reason="http-404"/);

  // Both render the same visible content, which is the point: a learner who cannot load a figure
  // gets the same description whichever way it failed.
  assert.equal(
    built.html.replace(/data-reason="[^"]*"/, ""),
    missing.html.replace(/data-reason="[^"]*"/, "").replace("http-404", "pipeline-not-run")
  );
});

test("a figure with no authored description degrades to the sentence alone, not to a blank", async () => {
  // Every figure in the corpus authors one, but a reference that carries none must not produce an
  // empty paragraph where the description should be.
  const client = createFigureClient({ fetchImpl: async () => FAILURES.network() });
  const result = await client.getFigure(KEY);
  const view = figureUnavailableView(result, { alt: undefined });
  const html = renderToStaticMarkup(React.createElement(FigureUnavailable, view));
  assert.equal(view.alt, null);
  assert.equal(html.includes("figure__alt"), false);
  assert.ok(html.includes("Figure unavailable"), "it still says the figure is missing");
});

// --- the lazy boundary -------------------------------------------------------------------
//
// MAX-74 moved the figure bundle behind `React.lazy(() => import("./components/LessonFigures.jsx"))`,
// so what a lesson renders now crosses a dynamic import boundary. The failure mode for that is
// silent and total: bind the lazy import to the wrong export and `Figure` receives `reference`,
// never finds a `figureKey`, returns null, and the lesson renders an empty div — with every
// figure-section figure gone and no error anywhere. Nothing above notices, because the lesson
// itself renders perfectly.
//
// So these assert the boundary's prop contract behaviourally: LessonFigure is the component
// App.jsx's lazy import resolves to, and each of the two shapes a lesson carries a figure in has
// to come out the other side as a figure box that asked the route for its payload. Rendering with
// a failing fetch means "did it reach the client at all" is observable — the box either has the
// degraded sentence and the description, or it is empty.

test("the lazy boundary renders an exercise/worked-example figure from figureKey", async () => {
  const html = renderToStaticMarkup(
    React.createElement(LessonFigure, { figureKey: KEY, alt: DESCRIPTION, declaredAspectRatio: 0.661 })
  );
  // renderToStaticMarkup cannot await a fetch, so this is the pending box — and it is the whole
  // claim: the component mounted, ran its effect, and asked for the key. Empty means it did not.
  assert.match(html, /class="figure figure--pending"/);
  assert.ok(!html.includes("</div></div>"), `the boundary rendered nothing for a figureKey: ${html}`);
});

test("the lazy boundary renders a lesson-section figure from a reference object", async () => {
  const html = renderToStaticMarkup(React.createElement(LessonFigure, { reference: REFERENCE }));
  // This is the one that was silently empty. A reference is not a figureKey, and the component it
  // was bound to reads figureKey — so the assertion that the box exists is the assertion that the
  // reference reached the component that understands it. It passes the reference through whole, so
  // asymptoteAlt travels with it and the degraded box still has a description to show (§5.6).
  assert.match(html, /class="figure figure--pending"/);
});

test("the lazy boundary renders nothing for a figure that is not there", async () => {
  // No key and no reference is the one input that should produce no box, and it is what a section
  // with an empty figures array hands the boundary.
  assert.equal(renderToStaticMarkup(React.createElement(LessonFigure, {})), "");
  assert.equal(renderToStaticMarkup(React.createElement(LessonFigure, { reference: {} })), "");
});
