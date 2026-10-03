// Fails the build when the figure bundle is reachable from a route that must not carry it.
//
// Rendering Conventions §5.5 is the rule being enforced:
//
//   "Lazy-loaded, only on routes that can contain figures (a lesson or exercise view). Never on
//    the dashboard, module list, or progress pages — those must not pull the figure bundle."
//
// §7 turns it into a budget with a hard requirement attached: figure bundle on non-figure routes
// is 0 KB, and no figure module may be imported outside lesson/exercise routes. §8.9 wants the
// absence verified by a network assertion in the Playwright suite.
//
// This is the static half of §8.9 and the half that can fail a pull request. It reads Vite's own
// manifest (`build.manifest`, set in web/vite.config.js) and walks the *static* import closure of
// every entry chunk. A dynamic import is not followed: `import()` is exactly the thing §5.5 asks
// for, and following it would fail the build for the correct implementation. So "in the payload"
// means "reachable by a plain `import` from the entry", which is what the browser does on first
// paint, and 0 KB follows from it.
//
// Why the manifest and not a grep of dist/: a minified bundle has no module boundaries left to
// grep, and searching for an identifier or a string is a bet that the minifier kept it. Rollup
// already recorded which chunk each module landed in and how it got there; asking it is the
// difference between a measurement and an inference.
//
// It fails closed in both directions. No manifest, no marker, no marker outside the lazy edge and
// no lazy edge at all are each a failure, because every one of those states is also what a build
// that silently stopped emitting figures looks like.
//
// Usage: node scripts/assert-figure-bundle-split.mjs [--dist web/dist] [--src web/src]

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// resolve, not join: `--src` is also how this gets pointed at a scratch copy when proving it can
// fail, and join would silently read REPO/<absolute path> instead.
const DIST = resolve(REPO, arg("--dist", "web/dist"));
const SRC = resolve(REPO, arg("--src", "web/src"));

// Markers for "this chunk contains the figure bundle". They are string literals on purpose: the
// minifier rewrites identifiers and cannot touch a string's contents, so these survive into the
// shipped output. Each one is unique to lib/figures.js or Figure.jsx — `/api/figures/` is the
// figure route and nothing else in the app fetches it, and the unavailable message is the one
// sentence of §5.6 that only FigureUnavailable draws.
//
// A marker set that grows a member which also appears in the entry would fail the build for a
// reason that has nothing to do with the bundle split. If you add one, check it against
// dist/assets/index-*.js first.
const FIGURE_MARKERS = [
  { label: "figure route", needle: "/api/figures/" },
  { label: "§5.6 unavailable message", needle: "Figure unavailable" }
];

// The figure modules, and the module set that is allowed to name them.
//
// The rule is not "App.jsx must not import Figure" — it is that no file *outside the figure
// bundle* may hold a static edge into it. Figure.jsx importing lib/figures.js is that edge, from
// inside the bundle, and it is what the lazy chunk is made of. React.lazy makes the bundle's
// single entry edge a dynamic one; Rollup's graph says the result, and this names the offender in
// a file a reviewer can open rather than a minified chunk hash.
const FIGURE_BUNDLE = ["components/LessonFigures.jsx", "components/Figure.jsx", "lib/figures.js"];

const violations = [];
const notes = [];

function fail(message) {
  violations.push(message);
}

function readManifest() {
  const path = join(DIST, ".vite", "manifest.json");
  if (!existsSync(path)) {
    fail(
      `no Vite manifest at ${relative(REPO, path)}. Run the web build (npm run build --workspace web); ` +
        "web/vite.config.js sets build.manifest because this assertion reads it."
    );
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`the Vite manifest at ${relative(REPO, path)} is not readable JSON: ${err.message}`);
    return null;
  }
}

// Every chunk an entry reaches with a plain `import`, transitively. `dynamicImports` is
// deliberately not followed; see the header.
function staticClosure(manifest, startKey) {
  const seen = new Set();
  const queue = [startKey];
  while (queue.length) {
    const key = queue.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) continue;
    for (const next of chunk.imports || []) queue.push(next);
  }
  return seen;
}

function markerHits(text) {
  return FIGURE_MARKERS.filter((marker) => text.includes(marker.needle));
}

function chunkPath(manifest, key) {
  const chunk = manifest[key];
  return chunk ? join(DIST, chunk.file) : null;
}

function chunkSize(key) {
  const path = chunkPath(manifest, key);
  if (!path || !existsSync(path)) return null;
  return statSync(path).size;
}

let manifest = readManifest();
const entryKeys = [];

if (manifest) {
  for (const [key, chunk] of Object.entries(manifest)) {
    if (chunk.isEntry) entryKeys.push(key);
  }

  if (entryKeys.length === 0) {
    // Without an entry there is no payload to be clean, so the assertion below would pass
    // vacuously on a build that produced nothing loadable.
    fail("the Vite manifest lists no entry chunk, so there is no dashboard payload to check");
  }

  // Which chunks hold the figure bundle, and how many bytes that is.
  const figureChunks = [];
  let totalJsBytes = 0;
  for (const key of Object.keys(manifest)) {
    const path = chunkPath(manifest, key);
    if (!path || !existsSync(path) || extname(path) !== ".js") continue;
    const text = readFileSync(path, "utf8");
    if (chunkSize(key) === null) continue;
    if (!manifest[key].isEntry && !manifest[key].imports && !manifest[key].dynamicImports) continue;
    const hits = markerHits(text);
    if (hits.length) figureChunks.push({ key, file: manifest[key].file, bytes: chunkSize(key), hits });
  }

  if (figureChunks.length === 0) {
    // Two ways to get here and neither is fine: the figure bundle was inlined into an entry (which
    // the per-entry check below then reports), or the build stopped emitting it (dead code, a
    // renamed marker, or a broken lazy edge). Both are build changes a person has to look at.
    fail(
      "no chunk contains the figure bundle. Either it was inlined into an entry — in which case §7's " +
        "0 KB budget is blown — or the bundle is no longer being emitted at all. Either way this " +
        "assertion cannot tell, which is why it refuses to pass."
    );
  }

  // The per-entry check: §5.5 and §7, measured.
  for (const entryKey of entryKeys) {
    const closure = staticClosure(manifest, entryKey);
    for (const key of closure) {
      const path = chunkPath(manifest, key);
      if (!path || !existsSync(path) || extname(path) !== ".js") continue;
      const hits = markerHits(readFileSync(path, "utf8"));
      if (!hits.length) continue;
      fail(
        `${relative(REPO, path)} carries the figure bundle (${hits.map((h) => h.label).join(", ")}) and is ` +
          `statically imported by the entry ${entryKey}. §5.5 says the figure bundle is never on a ` +
          "non-figure route and §7 budgets that at 0 KB. Reach it through React.lazy in App.jsx, " +
          `which is what ${FIGURE_BUNDLE[0]} exists for.`
      );
    }

    // And the other half: the bundle must still be reachable, or the split has been achieved by
    // deleting the figures. `dynamicImports` is where §5.5's "lazy-loaded" actually lives.
    const dynamic = new Set();
    const queue = [entryKey];
    const seen = new Set();
    while (queue.length) {
      const key = queue.pop();
      if (seen.has(key)) continue;
      seen.add(key);
      const chunk = manifest[key];
      if (!chunk) continue;
      for (const next of chunk.dynamicImports || []) dynamic.add(next);
      for (const next of chunk.imports || []) queue.push(next);
    }
    for (const { key, file, bytes } of figureChunks) {
      if (dynamic.has(key)) {
        notes.push(`${file} (${(bytes / 1024).toFixed(2)} KB) is lazily imported from ${entryKey}`);
      } else {
        fail(
          `${file} holds the figure bundle but no entry reaches it through a dynamic import, so it is ` +
            `dead code. §5.5 asks for the bundle on lesson/exercise routes; an unreachable one means the ` +
            "lesson renders a pending placeholder forever."
        );
      }
    }
  }

  for (const key of entryKeys) {
    const bytes = chunkSize(key);
    if (bytes) totalJsBytes += bytes;
  }
  notes.unshift(`entry payload ${(totalJsBytes / 1024).toFixed(2)} KB across ${entryKeys.length} entry chunk(s)`);
}

// --- the source half -------------------------------------------------------------------
//
// The build assertion proves the shipped graph. This proves the edit that produced it, and names
// the offender in a path a reviewer can open rather than a minified chunk hash.

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

// Comments name the modules in prose constantly, and this file's own header does it three times,
// so matching the raw text reports the comment above instead of the import below. Strip comments
// but keep string bodies: the import specifier *is* a string, and it is the thing being looked for.
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// The specifiers of a module's *static* edges. `import("x")` is removed first: §5.5 asks for
// exactly that edge, and an edge that the lazy boundary owns is the correct implementation rather
// than a violation. Static means `import ... from "x"`, a bare `import "x"`, and `export ... from
// "x"` -- a re-export is an edge too, and it is how a figure module would get back into an entry
// without anybody writing "import Figure".
const STATIC_IMPORT = /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;

function staticSpecifiers(text) {
  const withoutDynamic = code(text).replace(/\bimport\s*\(/g, "import(");
  const out = [];
  for (const match of withoutDynamic.matchAll(STATIC_IMPORT)) {
    const specifier = match[1] ?? match[2];
    if (specifier) out.push(specifier);
  }
  return out;
}

// Resolve a relative specifier to a path relative to SRC, so "./components/Figure.jsx" from
// App.jsx and "../lib/figures.js" from components/Figure.jsx both land on the bundle names above.
// Bare specifiers are npm packages and resolve to nothing here, which is correct: no figure module
// is published.
function resolveSpecifier(specifier, fromRel) {
  if (!specifier.startsWith(".")) return null;
  const base = fromRel.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  return base.join("/");
}

if (existsSync(SRC)) {
  const appPath = join(SRC, "App.jsx");
  const appText = existsSync(appPath) ? readFileSync(appPath, "utf8") : "";

  for (const path of walk(SRC)) {
    if (!/\.(jsx?|mjs)$/.test(path)) continue;
    const rel = relative(SRC, path).split("\\").join("/");
    // Inside the bundle, the modules name each other; that is what the chunk is made of.
    if (FIGURE_BUNDLE.includes(rel)) continue;

    for (const specifier of staticSpecifiers(readFileSync(path, "utf8"))) {
      const target = resolveSpecifier(specifier, rel);
      if (!target || !FIGURE_BUNDLE.includes(target)) continue;
      fail(
        `${relative(REPO, path)} statically imports ${target} (from "${specifier}"). §7 makes that a hard ` +
          "requirement: no figure module may be imported outside lesson/exercise routes. The only modules " +
          `allowed to name the figure bundle are ${FIGURE_BUNDLE.join(", ")}, and ${FIGURE_BUNDLE[0]} is ` +
          "the one App.jsx reaches through React.lazy."
      );
    }
  }

  // The boundary itself has to be behind a lazy import, or it is just another entry chunk wearing
  // a name. Asserted on App.jsx because that is where the call has to be for §5.5 to hold.
  if (appText && !/lazy\s*\(\s*\(\s*\)\s*=>\s*import\(/.test(appText)) {
    fail(
      `${relative(REPO, appPath)} does not reach the figure bundle through React.lazy(() => import(...)). ` +
        "Without that call there is no dynamic edge for the manifest to record, and the figure bundle " +
        "lands in the dashboard payload."
    );
  }
} else {
  fail(`no source tree at ${relative(REPO, SRC)}`);
}

// --- report -----------------------------------------------------------------------------

for (const note of notes) process.stdout.write(`  ${note}\n`);

if (violations.length) {
  process.stderr.write("\nfigure bundle split: FAILED\n");
  for (const violation of violations) process.stderr.write(`  - ${violation}\n`);
  process.stderr.write(
    "\nSee Rendering Conventions §5.5 (lazy-loaded, lesson/exercise routes only) and §7 (0 KB on every\n" +
      "other route, hard requirement). The fix is in web/src/App.jsx and web/src/components/LessonFigures.jsx.\n"
  );
  process.exit(1);
}

process.stdout.write("figure bundle split: ok\n");