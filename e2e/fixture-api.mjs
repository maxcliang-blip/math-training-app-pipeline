// Boots the API against a synthetic corpus and figure manifest, for the browser tests.
//
// Two things make this a script rather than a `webServer.command` that runs `npm run dev:api`.
//
// The first is CONTENT_ROOT. A layout-shift measurement is only about the figure if the figure's
// shape is known and stated, and the shipped corpus has 69 figures whose authored ratios disagree
// with their compiled SVGs. Testing against it would assert whatever the corpus happens to be doing
// today. The fixture corpus has one figure, one declared ratio and one SVG, with the arithmetic in
// e2e/fixtures/figure-fixture.mjs.
//
// The second is the SVG's location. api/src/app.js serves compiled figures out of
// <repo>/artifacts/figures/svg, because that is where the build puts them; there is no env var for
// it and adding one would be a change to the API for the sake of a test. So the fixture writes into
// that directory — the gitignored build output — and takes it away again afterwards, and only if it
// was not already there.
//
// It boots the API in-process rather than spawning `node api/src/index.js`, so a failure to start is
// this script's stack trace instead of Playwright's "webServer did not become ready" timeout.

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTENT_ROOT_FILES, SVG_FILE, SVG_SOURCE, fixtureManifest } from "./fixtures/figure-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const FIXTURE_DIR = join(REPO, ".e2e-tmp");
const CONTENT_ROOT = join(FIXTURE_DIR, "content");
const MANIFEST = join(FIXTURE_DIR, "figure-manifest.json");
const DATA_DIR = join(FIXTURE_DIR, "data");
const SVG_PATH = join(REPO, "artifacts", "figures", "svg", SVG_FILE);

function writeFiles(root, files) {
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`);
  }
}

export function writeFixture() {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(CONTENT_ROOT, { recursive: true });
  writeFiles(CONTENT_ROOT, CONTENT_ROOT_FILES);
  writeFileSync(MANIFEST, `${JSON.stringify(fixtureManifest(), null, 2)}\n`);
  mkdirSync(dirname(SVG_PATH), { recursive: true });
  writeFileSync(SVG_PATH, SVG_SOURCE);
  return { contentRoot: CONTENT_ROOT, manifest: MANIFEST, dataDir: DATA_DIR, svgPath: SVG_PATH };
}

export function removeFixture() {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  rmSync(SVG_PATH, { force: true });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const fixture = writeFixture();
  process.env.CONTENT_ROOT = fixture.contentRoot;
  process.env.FIGURE_MANIFEST = fixture.manifest;
  process.env.DATA_DIR = fixture.dataDir;
  process.env.PORT = process.env.E2E_API_PORT || "4183";
  process.on("exit", removeFixture);
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  // eslint-disable-next-line no-console
  console.log(`[e2e] fixture corpus at ${fixture.contentRoot}; API on :${process.env.PORT}`);
  await import("../api/src/index.js");
}