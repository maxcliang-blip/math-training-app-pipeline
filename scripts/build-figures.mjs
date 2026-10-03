#!/usr/bin/env node
// Figure build gate: pre-render Asymptote to sanitized SVG at ingest.
//
// Rendering Conventions S5 puts Asymptote on the server side, not the browser: the same
// figure ships to every learner, the reserved-space ratio is known before layout, and no
// production browser Asymptote exists. This is the ingest step that produces those figures.
//
// The import contract is one-directional, and it is the whole point of this file:
//
//   content authors   asymptoteSource + asymptoteAlt + asymptoteAspectRatio
//   this build        derives figureSvgUrl + figureHash + figurePipelineVersion
//
// Content must never carry the derived three. Requiring them at import deadlocks authoring
// on the build and no figure can ever ship, so a derived field found in content is a
// warning here, not a requirement on the author.
//
// Usage:
//   node scripts/build-figures.mjs [contentRoot] [--out <dir>] [--allow-missing-toolchain]
//                                   [--record-aspect-ratios]
//
// Exit codes: 0 validated and compiled · 1 contract violation · 2 configuration error
//             3 validated but not compiled (no asymptote toolchain)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DERIVED_FIELDS,
  FIGURE_PAYLOAD_FIELDS,
  figureAssetPath,
  isRootRelativeFigurePath,
  lessonFigureKey,
  exampleFigureKey,
  exerciseFigureKey
} from "../lib/figure-contract.mjs";

export { DERIVED_FIELDS, FIGURE_PAYLOAD_FIELDS };

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DEFAULT_CONTENT = join(REPO, "content");
const DEFAULT_OUT = join(REPO, "artifacts", "figures");

// Bump when the pipeline changes what it emits, so a stale figure is detectable by hash
// rather than by inspection.
export const PIPELINE_VERSION = "asymptote-svg-sanitized@2";

// Content declares a ratio at 3 decimal places. Both sides of every comparison below are
// rounded to that precision first, so the declaration's own quantization cannot masquerade as
// drift in either direction. Shared with the authoring band check in
// scripts/preflight-content.mjs.
const RATIO_DECIMALS = 3;
// S5.5 thresholds, from Rendering Conventions S5.4 item 4. These are the only ratio check in
// the pipeline, and they govern the *compiled* box.
const RATIO_WARN = 0.02;
const RATIO_REJECT = 0.05;
// S9 #8 band, shared with the authoring check in scripts/preflight-content.mjs. A figure outside
// it renders as a sliver or a letterbox inside the box it reserves, so neither authoring nor the
// record pass is allowed to bless one.
const MIN_ASPECT = 0.5;
const MAX_ASPECT = 3;

// Defence in depth. The primary control is that only Asymptote output for approved figure
// sources is ever shipped; this removes the active-content vectors that could survive a
// compromised or unexpected source.
const SVG_DENY = [
  [/<script\b[\s\S]*?<\/script>/gi, ""],
  [/<!--[\s\S]*?-->/g, ""],
  [/\son[a-z]+\s*=\s*"[^"]*"/gi, ""],
  [/\son[a-z]+\s*=\s*'[^']*'/gi, ""],
  [/<foreignObject[\s\S]*?<\/foreignObject>/gi, ""],
  [/<a\b[^>]*>/gi, ""],
  [/<\/a>/gi, ""],
  [/(href|xlink:href)\s*=\s*"(?!#)[^"]*"/gi, 'href="#"'],
  [/(href|xlink:href)\s*=\s*'(?!#)[^']*'/gi, "href='#'"],
  [/javascript:/gi, ""],
  [/<!ENTITY[\s\S]*?>/gi, ""],
  [/<!DOCTYPE[\s\S]*?>/gi, ""],
];


// ---------------------------------------------------------------------------
// Corpus scan
// ---------------------------------------------------------------------------

function loadDir(dir, flat) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  // Sorted, because the figure keys the selftest mutates are resolved in lesson-id order and an
  // unsorted readdir makes which file is "first" a property of the filesystem rather than of
  // the corpus. The `flat` files hold an array of records and the rest hold a single record;
  // both are returned as one flat list carrying the file each record came from, so a record
  // mode can write back to the right file without re-deriving it.
  return files.flatMap((f) => {
    const file = join(dir, f);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const records = flat && Array.isArray(parsed) ? parsed : [parsed];
    return records.filter((r) => r && typeof r === "object").map((record) => ({ file, record }));
  });
}

export function collectFigures(contentRoot) {
  const figures = [];
  const warnings = [];

  const lessonFiles = loadDir(join(contentRoot, "lessons"), false);
  const exerciseFiles = [...loadDir(join(contentRoot, "exercises"), true), ...loadDir(join(contentRoot, "fixtures"), true)];

  for (const { file, record: lesson } of lessonFiles) {
    for (const [sectionName, section] of Object.entries(lesson.sections || {})) {
      const list = section && section.figures;
      if (Array.isArray(list)) {
        list.forEach((fig, i) => {
          if (!fig || !fig.asymptoteSource) return;
          figures.push({
            key: lessonFigureKey(lesson.id, sectionName, i),
            source: fig.asymptoteSource,
            alt: fig.asymptoteAlt,
            declaredRatio: fig.asymptoteAspectRatio,
            caption: fig.captionLatex || null,
            file,
            record: fig,
          });
        });
      }
      // Worked examples carry figures too. They are compiled here for the same reason: an example
      // whose asymptoteSource reaches a client is build input on the request path, and the
      // figureKey the API emits has to resolve or the example just loses its figure.
      const examples = section && section.examples;
      if (Array.isArray(examples)) {
        examples.forEach((example, i) => {
          if (!example || !example.asymptoteSource) return;
          figures.push({
            key: exampleFigureKey(lesson.id, sectionName, i),
            source: example.asymptoteSource,
            alt: example.asymptoteAlt,
            declaredRatio: example.asymptoteAspectRatio,
            caption: example.captionLatex || null,
            file,
            record: example,
          });
        });
      }
    }
  }

  for (const { file, record: ex } of exerciseFiles) {
    if (!ex.asymptoteSource) continue;
    figures.push({
      key: exerciseFigureKey(ex.id),
      source: ex.asymptoteSource,
      alt: ex.asymptoteAlt,
      declaredRatio: ex.asymptoteAspectRatio,
      caption: ex.captionLatex || null,
      file,
      record: ex,
    });
  }

  for (const [owner, files] of [["lessons", lessonFiles], ["exercises", exerciseFiles]]) {
    for (const { file, record } of files) {
      const found = DERIVED_FIELDS.filter((f) => record[f] !== undefined && record[f] !== null);
      if (found.length) {
        warnings.push({
          path: `${owner}/${record.id}`,
          message: `content carries derived field(s) ${found.join(", ")}; the build owns these and overwrites them`,
        });
      }
    }
  }

  return { figures, warnings };
}

// ---------------------------------------------------------------------------
// Authoring contract
// ---------------------------------------------------------------------------

export function validateFigure(figure) {
  const problems = [];
  const sizeCall = figure.source.match(/size\s*\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)/);

  if (!sizeCall) {
    const single = figure.source.match(/size\s*\(\s*(\d+(?:\.\d+)?)\s*\)/);
    problems.push(
      single
        ? "size(W,H) takes two arguments: with one argument the reserved space cannot be known before layout"
        : "figure source must call size(W,H)",
    );
    return { problems, box: null };
  }

  const width = Number(sizeCall[1]);
  const height = Number(sizeCall[2]);

  // The declared ratio is content's own assertion about the box this figure renders at, and it is
  // what S5.4 item 4 compares against the compiled viewBox. It is NOT width/height: Asymptote's
  // two-argument size() is a ceiling the output is fitted under, so a figure that calls
  // size(320,240) and draws a 321x37 strip renders at 8.676, and requiring the declaration to
  // equal 1.333 is what let 60 of the corpus's 65 figures declare a shape they do not render at.
  //
  // This function used to reject any figure whose declaration disagreed with that ceiling, which
  // is S5.4-ratio-matches-size under a second name, and the drift gate below then compared the
  // compiled box against the ceiling too -- so the gate compared the compiler's output to the
  // author's guess about their own ceiling rather than to the number the manifest serves and the
  // renderer reserves space from. Both compared the wrong side. The ceiling is kept, because S5.2
  // still requires a figure to reserve space it can be laid out against; it is simply not evidence
  // about the output box.
  if (typeof figure.declaredRatio !== "number") {
    problems.push("asymptoteAspectRatio is mandatory with a figure");
  }

  if (typeof figure.alt !== "string" || figure.alt.trim().length < 20) {
    problems.push("asymptoteAlt is mandatory with a figure and must be at least one sentence");
  } else if (figure.alt.includes("$")) {
    problems.push("asymptoteAlt is read by a screen reader before any math renders; keep it plain prose");
  }

  if (/(input|include|write|open)\s*\(/.test(figure.source)) {
    problems.push("figure source must not touch the filesystem");
  }

  return { problems, box: { width, height, ratio: figure.declaredRatio } };
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

// Resolve ASYMPTOTE_BIN / DVISVGM_BIN against the repository when they name a path, so both the
// probe and the compile exec the same absolute file.
//
// Nothing resolved these before, and that made a repository-relative toolchain unusable rather
// than merely awkward. Two different cwds were at work: the compile runs with cwd set to a fresh
// temp directory, and execFile resolves a relative command against the *child's* cwd, so
// `ASYMPTOTE_BIN=scripts/asy-docker` probed fine from the repo root and then returned ENOENT for
// all 91 figures. And the probe itself was cwd-dependent, so the same value did not even resolve
// when the build was invoked from anywhere but the repository root -- which is a real workflow,
// since contentRoot is an argument. An absolute path would have worked and is not portable, so
// the fix is to resolve rather than to document around.
//
// Only a path-shaped value is resolved; a bare `asymptote` stays a PATH lookup. `bin` keeps the
// spelling the caller used, so the manifest and the console line do not record one checkout's
// absolute path.
export function resolveToolchainBin(bin) {
  if (!bin.includes("/") || isAbsolute(bin)) return bin;
  return resolve(REPO, bin);
}

// Probe one candidate binary. Kept separate from findToolchain because the probe's stderr is the
// only place a toolchain wrapper can explain itself: scripts/asy-docker knows that its image is
// missing or its engine socket is unreachable, and prints exactly that on the way out. Discovery
// captures the stderr so that a failed toolchain reports the real reason instead of "NOT FOUND —
// set ASYMPTOTE_BIN or install asymptote", which on this host is advice that cannot be taken:
// asymptote is not installable here, and the thing that IS broken is usually the container image.
export function probeToolchainBin(candidate) {
  const path = resolveToolchainBin(candidate);
  const probe = spawnSync(path, ["--version"], { encoding: "utf8" });
  const lines = (probe.stdout || probe.stderr || "").split("\n")[0].trim();
  // First line only. This is the `--version` probe, so the useful text is whatever the candidate
  // leads with, and a wrapper's own diagnostics lead with a marker line (scripts/asy-docker writes
  // "asy-shim: ..." first, then its longer hint). Taking the tail instead would report the last
  // line of a hint and lose the sentence that says what is actually broken.
  const stderr = (probe.stderr || "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) || "";
  return {
    ok: !probe.error && probe.status === 0,
    path,
    version: lines,
    // ENOENT has no stderr to report; the candidate's own spelling is the diagnosis.
    reason: stderr || (probe.error ? probe.error.code || String(probe.error) : `exited ${probe.status}`),
  };
}

// Why the last findToolchain() call found nothing, most specific first. Set on every discovery so
// the CLI can print it instead of a generic instruction.
export let toolchainProbeReasons = [];

export function findToolchain() {
  toolchainProbeReasons = [];
  let asy = null;
  for (const candidate of [process.env.ASYMPTOTE_BIN, "asymptote", "asy"]) {
    if (!candidate) continue;
    const probe = probeToolchainBin(candidate);
    if (!probe.ok) {
      toolchainProbeReasons.push(`${candidate}: ${probe.reason}`);
      continue;
    }
    asy = { bin: candidate, path: probe.path, version: probe.version };
    break;
  }
  if (!asy) return null;

  // asy 2.87 — what apt gives you on ubuntu-latest — accepts `-svg` and then writes EPS anyway,
  // and its `-outdir=DIR` swallows the following file argument as a module name. Neither failure
  // is loud: the compiler exits 0 and leaves an .eps behind. So SVG is produced by running the
  // compiler with no -outdir from inside the work directory, then converting with dvisvgm.
  // A toolchain without dvisvgm cannot make an SVG at all, and that has to be fatal rather than
  // a skip: a figure build that compiles nothing must not pass.
  let dvisvgm = null;
  for (const candidate of [process.env.DVISVGM_BIN, "dvisvgm"]) {
    if (!candidate) continue;
    const probe = probeToolchainBin(candidate);
    if (!probe.ok) {
      toolchainProbeReasons.push(`${candidate}: ${probe.reason}`);
      continue;
    }
    dvisvgm = { bin: candidate, path: probe.path, version: probe.version };
    break;
  }
  if (!dvisvgm) {
    return { ...asy, bin: null, missing: "dvisvgm" };
  }
  return { ...asy, dvisvgm: dvisvgm.bin, dvisvgmPath: dvisvgm.path, dvisvgmVersion: dvisvgm.version };
}

export function sanitizeSvg(svg) {
  let out = svg;
  for (const [pattern, replacement] of SVG_DENY) out = out.replace(pattern, replacement);
  // Asymptote emits an XML prolog ahead of the root element, so validate the root only
  // after the prolog is gone, and re-emit a canonical one.
  out = out.replace(/^\s*<\?xml[^>]*\?>\s*/i, "").replace(/^\s*<!DOCTYPE[^>]*>\s*/i, "").trim();
  if (!/^<svg[\s>]/i.test(out)) throw new Error("sanitized output has no svg root element");
  if (/<script|javascript:|\son[a-z]+\s*=/i.test(out)) throw new Error("active content survived sanitization");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${out}\n`;
}

// Measure the compiled box, for the S5.5 declared-vs-compiled drift check.
//
// Only the root <svg> element is read. A previous version matched width/height anywhere in
// the document, so it could pick up a child's attribute, and it required double quotes and a
// short fixed unit list, so it silently returned null on real compiler output: every one of the
// 55 figures reported measuredWidth: null, compiledAspectRatio: null, and because null was not
// an error the drift check never evaluated a single figure while still reporting zero violations.
// A measurement that fails to parse and a measurement that finds no drift must not look alike.
//
// Returns null only when the root element genuinely declares no usable box.
export function measureBox(svg) {
  const root = /<svg\b([^>]*)>/i.exec(svg);
  if (!root) return null;
  const attrs = root[1];

  // width/height may carry any CSS unit, be unitless, and may be quoted either way. Units are
  // dropped rather than converted: S5.5 is a ratio, so every unit cancels and only relative
  // scale matters.
  const length = (name) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']?\\s*(-?[\\d.]+)\\s*(?:pt|px|mm|cm|in|em)?\\s*["']?`, "i").exec(attrs);
    return m ? Number(m[1]) : null;
  };
  const width = length("width");
  const height = length("height");
  if (width > 0 && height > 0) return { width, height };

  // viewBox="minX minY width height", separators may be spaces or commas.
  const vb = /\bviewBox\s*=\s*["']([^"']*)["']/i.exec(attrs);
  if (vb) {
    const parts = vb[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) return { width: parts[2], height: parts[3] };
  }
  return null;
}

// The S5.5 declared-vs-compiled drift gate, as a pure function so that "it can actually fail"
// is a test and not a claim.
//
// WHAT THIS CHECK IS FOR, since it looks at first glance like it can never fire.
//
// After a record pass the declaration is the measured box, so declared == compiled and the drift
// is 0 for a clean corpus. That is not a reason to delete this check, it is the reason it exists.
// The declaration is a *committed assertion about what the compiler will produce*. Someone edits
// a figure's source -- one more label, a longer axis, a different radius -- and the rendered box
// moves with it while the committed declaration does not, because restating it is a separate,
// deliberate act that requires a real toolchain. This gate is what makes that omission visible.
// So: clean corpus means declared equals measured, and any non-zero drift means a source edit
// that was not restated. Roughly what that is worth, from MAX-31's own corpus: 51 of 55 figures
// were more than 5% away from their declaration while every one of them passed authoring, because
// the check that used to stand in this place derived the correct ratio from size(W,H) and never
// looked at the SVG at all.
//
// The tolerance is a *cosmetics* threshold, not a physics one. CLS is already 0 in both states
// because the reserved box is sized from the declared ratio and the SVG is object-fit:contain, so
// a mismatch never reflows the page -- it only leaves a sunken gutter. At a 480px figure width,
// 2% is about 7px (imperceptible) and 5% is about 18px (visible). A tighter single threshold,
// such as the 0.5% this previously used, rejects figures the spec says to warn about and has no
// layout justification behind it.
export function classifyDrift(declaredRatio, measuredRatio) {
  const drift = Math.abs(measuredRatio - declaredRatio) / declaredRatio;
  const level = drift > RATIO_REJECT ? "reject" : drift > RATIO_WARN ? "warn" : "pass";
  return { drift, level };
}

function compileFigure(toolchain, figure, outDir) {
  const work = mkdtempSync(join(tmpdir(), "figure-build-"));
  try {
    const stem = figure.key.replace(/[^a-zA-Z0-9._-]+/g, "_");
    // The working source name is deliberately dotless and nothing to do with the key. asy
    // derives its output name by stripping the last two dot-separated components off the source
    // name, so `m1-l3.sections.concept.figures_0_.asy` compiles to `m1-l3.sections.concept.eps`
    // and the expected output never appears. Every lesson figure key contains dots, so this
    // silently failed 46 of 55 figures on asy 2.85 (Debian bookworm) while looking like a
    // content problem. A fixed dotless name makes the output name predictable on every asy
    // version; the artifact is written under the real stem below either way.
    const asyFile = "figure.asy";
    writeFileSync(join(work, asyFile), figure.source);
    // No -outdir: asy 2.87 mis-parses it and eats the source filename. cwd is already the work
    // directory, so the compiler writes its output next to the source.
    execFileSync(toolchain.path, ["-svg", asyFile], {
      cwd: work,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    const svgPath = join(work, "figure.svg");
    if (!existsSync(svgPath)) {
      // asy without dvisvgm support lands EPS here, whatever version it is. Convert it; anything
      // else means the compiler produced nothing.
      const epsPath = join(work, "figure.eps");
      if (!existsSync(epsPath)) {
        const leftover = readdirSync(work).filter((f) => !f.endsWith(".asy"));
        return {
          error: `compiler produced no svg or eps for ${figure.key} (saw: ${leftover.join(", ") || "nothing"})`,
        };
      }
      execFileSync(toolchain.dvisvgmPath, ["--eps", "--no-fonts", "-o", "figure.svg", "figure.eps"], {
        cwd: work,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      });
    }
    if (!existsSync(svgPath)) return { error: `dvisvgm produced no svg for ${figure.key}` };
    const raw = readFileSync(svgPath, "utf8");
    const svg = sanitizeSvg(raw);
    mkdirSync(join(outDir, "svg"), { recursive: true });
    const file = `${stem}.svg`;
    writeFileSync(join(outDir, "svg", file), svg);
    return { svg, file, box: measureBox(svg) };
  } catch (err) {
    // The compiler's own last few lines are the symptom; plain_shipout.asy saying "shipout
    // failed" is the symptom every TeX-side failure wears. What actually failed is in the
    // work directory, which the finally below deletes, so gather it here while it exists:
    // the source asy was handed, everything it left behind, and the tail of any log or TeX
    // file in there. Without this a figure that dies on one run and compiles on the next is
    // indistinguishable from a flake, and gets re-run instead of diagnosed.
    return { error: `compile failed: ${describeCompileFailure(err, work, figure)}` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function describeCompileFailure(err, work, figure) {
  const parts = [];
  const stderr = (err.stderr || err.message || "").toString().trim();
  if (stderr) parts.push(stderr.split("\n").filter((l) => l.trim()).slice(-8).join(" | "));

  let left = [];
  try {
    left = readdirSync(work).filter((f) => f !== "figure.asy");
  } catch {
    // The work directory is gone; nothing more to report than the compiler said.
  }
  parts.push(`[${figure.key}] work dir held ${left.join(", ") || "nothing"}`);

  // asy writes one .tex per TeX-rendered label and a combined .log. The latex error is in the
  // log, and it names the macro — which is the only thing that points at the figure.
  for (const name of left.filter((f) => /\.log$|\.tex$|\.blg$/.test(f)).slice(0, 4)) {
    try {
      const tail = readFileSync(join(work, name), "utf8").trim().split("\n").filter((l) => l.trim()).slice(-12);
      if (tail.length) parts.push(`${name}: ${tail.join(" | ")}`);
    } catch {
      // Unreadable is not worth reporting over the compiler's own words.
    }
  }

  parts.push(`source: ${figure.source.split("\n").map((l) => l.trim()).filter(Boolean).join(" ; ")}`);
  return parts.join("\n      ");
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildFigures(contentRoot, outDir, { requireToolchain = true } = {}) {
  const { figures, warnings } = collectFigures(contentRoot);
  const toolchain = findToolchain();
  // asy without dvisvgm cannot emit SVG. Skipping every figure would report "no toolchain" for a
  // box that is half-present, and --allow-missing-toolchain would wave it through as authoring.
  if (toolchain && !toolchain.bin) {
    throw new Error(
      `asymptote ${toolchain.version} is installed but ${toolchain.missing} is not, and ${toolchain.missing} ` +
        `is what turns the compiler's output into SVG on this Asymptote version. ` +
        `Install ${toolchain.missing} (CI: apt-get install -y --no-install-recommends asymptote ${toolchain.missing}).`,
    );
  }
  const violations = [];
  const compiled = [];
  const skipped = [];
  // Recorded for every figure the compiler actually saw, including the ones that then failed
  // the ratio check. Without this a mismatch reports "wrong number" and not "here is the
  // number", which is the one thing the author needs in order to fix it.
  const measurements = [];

  for (const figure of figures) {
    const { problems, box } = validateFigure(figure);
    if (problems.length) {
      violations.push({ key: figure.key, problems });
      continue;
    }
    if (!toolchain) {
      skipped.push({ key: figure.key, box });
      continue;
    }
    const result = compileFigure(toolchain, figure, outDir);
    if (result.error) {
      violations.push({ key: figure.key, problems: [result.error] });
      continue;
    }
    const measured = result.box;
    if (!measured) {
      // Fail closed. A figure whose compiled box cannot be read is not a figure that drifted,
      // it is a figure nobody measured, and reporting it as "no violation" would let a broken
      // measurement path pass unnoticed behind a green build. This is the same trap as the
      // -svg flag that exited 0 while writing EPS: the compiler succeeded, so nothing objected.
      violations.push({
        key: figure.key,
        problems: [
          `compiled svg for ${figure.key} declares no measurable box, so S5.5 cannot compare it to the ` +
            `declared ${box.ratio}. This is a measurement failure, not a clean figure: the root <svg> must ` +
            `carry width and height or a viewBox.`,
        ],
      });
      continue;
    }
    const sizeCall = figure.source.match(/size\s*\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)/);
    const measurement = {
      key: figure.key,
      file: figure.file,
      source: figure.source,
      declaredSize: sizeCall ? `size(${sizeCall[1]},${sizeCall[2]})` : null,
      declaredRatio: box.ratio,
      measuredWidth: measured ? measured.width : null,
      measuredHeight: measured ? measured.height : null,
      measuredRatio: null,
    };
    let ratioNote = null;
    if (measured && measured.height > 0) {
      measurement.measuredRatio = Number((measured.width / measured.height).toFixed(RATIO_DECIMALS));
      const verdict = classifyDrift(box.ratio, measurement.measuredRatio);
      if (verdict.level === "reject") {
        violations.push({
          key: figure.key,
          problems: [
            `compiled box is ${measured.width}x${measured.height} (ratio ${measurement.measuredRatio}) but content declared ` +
            `${box.ratio}: ${(verdict.drift * 100).toFixed(1)}% drift exceeds the ${RATIO_REJECT * 100}% reject threshold (S5.5). ` +
            `size(W,H) bounds the output under Asymptote's default keepAspect rather than fixing it, so the ` +
            `declaration has to be the box the compiler produces. Re-run \`npm run content:figures -- ` +
            `--record-aspect-ratios\` against a real toolchain to restate it from a measurement.`,
          ],
        });
        measurements.push(measurement);
        continue;
      }
      if (verdict.level === "warn") {
        warnings.push({
          key: figure.key,
          message: `compiled box is ${measured.width}x${measured.height} (ratio ${measurement.measuredRatio}) against declared ` +
            `${box.ratio}: ${(verdict.drift * 100).toFixed(1)}% drift is over the ${RATIO_WARN * 100}% warn threshold (S5.5)`,
        });
      }
      ratioNote = measurement.measuredRatio;
    }
    measurements.push(measurement);
    // Root-relative, from the shared contract rather than a template literal here: the URL is
    // what the browser resolves, so a missing leading slash is a broken figure on every route
    // except the one the app happens to have today, and a broken figure whose request answers 200
    // text/html. Asserted immediately below so it cannot ship.
    const svgUrl = figureAssetPath(result.file);
    compiled.push({
      figureKey: figure.key,
      figureSvgUrl: svgUrl,
      figureHash: `sha256:${createHash("sha256").update(result.svg).digest("hex")}`,
      figurePipelineVersion: PIPELINE_VERSION,
      declaredAspectRatio: box.ratio,
      compiledAspectRatio: ratioNote,
      asymptoteVersion: toolchain.version,
      alt: figure.alt,
      captionLatex: figure.caption,
    });
    if (!isRootRelativeFigurePath(svgUrl)) {
      // Fail closed. A manifest whose asset URLs are not root-relative is a manifest that serves
      // HTML where an SVG belongs, and the failure looks like a working page.
      violations.push({
        key: figure.key,
        problems: [
          `figureSvgUrl "${svgUrl}" is not root-relative. It must start with a single "/", because the ` +
            "browser resolves a bare relative path against the document: on /learn/<moduleId> that url " +
            "requests the SPA fallback and answers 200 text/html. Build it with figureAssetPath() from " +
            "lib/figure-contract.mjs.",
        ],
      });
    }
  }

  const status = violations.length ? "fail" : toolchain ? (skipped.length ? "partial" : "pass") : "toolchain-missing";
  return { status, figures, toolchain, violations, compiled, skipped, warnings, measurements };
}

// Rewrite each figure's declared box to the box the compiler actually produced.
//
// This is a bootstrap tool, not a gate. It exists because the box a figure ends up with is
// decided by the compiler and by the TeX Live fonts it happens to have, which no amount of
// reading the source predicts: Asymptote's size(W,H) bounds the output under the default
// keepAspect and does not scale labels, so the real box is a measurement. Run it once against a
// real toolchain, review the diff, commit it, and the strict S5.5 comparison in buildFigures is
// what keeps the corpus honest from then on: it fires on a source edit that moved the rendered
// box without the declaration being restated.
//
// It refuses a measured box outside the S9 #8 band. Recording an out-of-band figure would turn a
// figure that has to be redrawn into a "recorded" declaration, which is the same defect wearing a
// recorded hat. Redraw first, record second.
//
// It restates asymptoteAspectRatio and nothing else. It used to rewrite the figure's own
// size(W,H) to the measured box as well, on the theory that the declaration and the call should
// agree. They cannot: size(W,H) is a ceiling that binds, so setting it to the measured box makes
// the compiler rescale the content to fit that ceiling, the measured box moves again, and the next
// run records a slightly larger one. Measured on the corpus, that loop ran 14 changes, then 7,
// then 6, then 3, each one a point taller, with no fixed point in sight. A bootstrap whose output
// depends on how many times you have run it is not a bootstrap. The ceiling stays the author's;
// the number the drift gate reads is what the compiler produced.
//
// The edits are made on the raw text rather than through a JSON round trip because the corpus is
// prettier-formatted: a round trip expands every inline array and turns a two-number change into
// a whole-file rewrite that buries the two numbers that actually moved.
// Rewrite the one asymptoteAspectRatio belonging to each figure object that holds the source we
// located, rather than the first one in the file.
//
// A file-wide search for the ratio is ambiguous whenever two figures declare the same box, which
// is the normal case: a lesson with three size(320,240) figures has three `1.333` ratios. Refusing
// to run there is safe but useless, and taking the first match is neither. The source token pins
// the figure, and JSON.stringify escapes newlines so each field sits on its own line within one
// object. So: for every occurrence of the source, walk out to the first ratio line reached and
// stop at the line that closes the object.
//
// The ratio is matched by shape, not by the number it is expected to hold. Matching on the value
// is a trap: JSON writes 1 as `1`, `1.0` or `1e0` depending on what wrote it, prettier preserves
// whatever was there, and a figure declaring `"asymptoteAspectRatio": 1.0` has the JS value 1. So
// the token built from the declared value, `"asymptoteAspectRatio": 1`, is a *prefix* of the text
// on the line, and replacing it turns `1.0` into `1.015.0` -- which is not a number, so the corpus
// stops being JSON and the next run of anything that reads it dies on a parse error. That is what
// this pass did to m3-l3 and m3-l4. Match the field, take the number off it, and never assume the
// two spellings agree.
// A source can legitimately appear more than once -- a lesson reuses a concept's figure inside its
// examples -- and those occurrences are the same figure, so they must all be rewritten together.
function recordFigureRatios(text, sourceToken, newRatio) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (index) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const endsObject = (line) => /^\s*\}/.test(line);
  const RATIO_FIELD = /("asymptoteAspectRatio"\s*:\s*)(-?[\d.eE+]+)(?![\d.])/;

  const edits = [];
  let from = 0;
  let found = 0;
  for (;;) {
    const at = text.indexOf(sourceToken, from);
    if (at === -1) break;
    found++;
    from = at + sourceToken.length;

    const startLine = lineOf(at);
    for (const step of [1, -1]) {
      let hit = false;
      for (let i = startLine + step; i >= 0 && i < lineStarts.length; i += step) {
        const start = lineStarts[i];
        const line = text.slice(start, lineStarts[i + 1] ?? text.length);
        if (RATIO_FIELD.test(line)) {
          edits.push({ start, end: start + line.length, insert: line.replace(RATIO_FIELD, `$1${newRatio}`) });
          hit = true;
          break;
        }
        if (endsObject(line)) break;
      }
      if (hit) break;
    }
  }

  if (!found) return { ok: false, error: "no occurrence of the source token remains in the file" };
  // Ratio edits are whole lines that sit between source occurrences, so they can overlap the next
  // source edit's span only if the source and the ratio share a line, which prettier never emits.
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + e.insert + out.slice(e.end);
  return { ok: true, text: out, occurrences: found };
}

// Group by source first. A lesson that reuses a concept's figure inside its examples presents the
// same asymptoteSource two or more times; those are one figure, they compile to one box, and the
// declarations have to move together. Recording them one measurement at a time would have the
// second pass find no source left to edit and mistake that for a corpus it does not understand.
export function recordAspectRatios(result) {
  const changes = [];
  const grouped = new Map();

  // Every figure has to come back from the compiler with a box, or this pass is recording a
  // partial corpus and saying so in a way that reads like completeness. A figure that failed to
  // compile has no measurement, so it is absent from result.measurements rather than marked, and
  // skipping it silently is how a figure kept its fictional declaration through a pass that
  // reported every box recorded.
  if (Array.isArray(result.figures)) {
    const measuredKeys = new Set(result.measurements.map((m) => m.key));
    const unmeasured = result.figures.map((f) => f.key).filter((k) => !measuredKeys.has(k));
    if (unmeasured.length) {
      return {
        ok: false,
        error: `${unmeasured.length} figure(s) came back from the compiler with no box, so this pass would record ` +
          `a partial corpus and report success: ${unmeasured.join(", ")}. Fix the compile failures first -- they are in ` +
          `the figure build's own output above -- then re-run the record pass.`,
      };
    }
  }

  for (const m of result.measurements) {
    if (!m.file || !m.measuredWidth || !m.measuredHeight || !m.measuredRatio) continue;
    const width = Math.round(m.measuredWidth);
    const height = Math.round(m.measuredHeight);
    if (m.measuredRatio === m.declaredRatio) continue;
    // Refuse to record a box outside the S9 #8 band. A figure that compiles to 321x37 is not a
    // measurement to be blessed, it is a figure to be redrawn, and writing 8.676 into the corpus
    // would convert a defect into a "recorded" declaration that then reads as authoritative. The
    // order this pass is meant to run in is figures first, record second; this makes a bad figure
    // fail the record pass instead of silently passing through it.
    if (m.measuredRatio < MIN_ASPECT || m.measuredRatio > MAX_ASPECT) {
      return {
        ok: false,
        error: `${m.key} in ${m.file} compiles to ${width}x${height} (ratio ${m.measuredRatio}), outside the ` +
          `[${MIN_ASPECT}, ${MAX_ASPECT}] band S9 #8 requires; refusing to record it. Redraw the figure so its ` +
          `content fills the box its size() call reserves -- extending it vertically -- rather than stretching ` +
          `the output with keepAspect=false, which distorts every TeX label in it.`,
      };
    }
    // A NUL cannot appear in a file path or in the JSON-escaped source text, so it is a
    // separator that two distinct (file, source) pairs can never collide on. It is written as
    // an escape rather than a literal byte: a literal NUL makes this file read as binary to
    // grep, diff and anything else that sniffs for it, which is how the record pass got
    // reviewed as a binary diff.
    const groupKey = `${m.file}\u0000${m.source}`;
    if (!grouped.has(groupKey)) grouped.set(groupKey, []);
    grouped.get(groupKey).push({ m });
  }

  for (const members of grouped.values()) {
    const { m } = members[0];

    const text = readFileSync(m.file, "utf8");
    const sourceToken = JSON.stringify(m.source).slice(1, -1);
    const scoped = recordFigureRatios(text, sourceToken, m.measuredRatio);
    if (!scoped.ok) {
      return { ok: false, error: `cannot record ${m.key} in ${m.file}: ${scoped.error}` };
    }

    writeFileSync(m.file, scoped.text);
    for (const other of members) {
      changes.push({
        figureKey: other.m.key,
        file: other.m.file.replace(REPO + "/", ""),
        from: { size: other.m.declaredSize, declaredAspectRatio: other.m.declaredRatio },
        to: { size: other.m.declaredSize, declaredAspectRatio: m.measuredRatio },
      });
    }
    changes[changes.length - 1].occurrences = scoped.occurrences;
  }

  return { ok: true, changes };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const allowMissing = args.includes("--allow-missing-toolchain");
  const record = args.includes("--record-aspect-ratios");
  const outIdx = args.indexOf("--out");
  const positional = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : null;
  const contentRoot = positional || (process.env.CONTENT_ROOT ? resolve(process.env.CONTENT_ROOT) : DEFAULT_CONTENT);
  const outDir = outIdx >= 0 && args[outIdx + 1] ? resolve(args[outIdx + 1]) : DEFAULT_OUT;

  if (!existsSync(contentRoot)) {
    console.error(`build-figures: CONFIG: content root ${contentRoot} does not exist`);
    process.exit(2);
  }

  // Record mode needs the measurements even for the figures it is about to fix, and it must not
  // be satisfied by a toolchain it never found: rewriting a corpus from no measurements would
  // quietly produce an empty diff that looks like "nothing needed changing".
  if (record && !allowMissing && !findToolchain()) {
    console.error("build-figures: CONFIG: --record-aspect-ratios needs a real Asymptote toolchain; none was found");
    process.exit(2);
  }

  let result;
  try {
    result = buildFigures(contentRoot, outDir, { requireToolchain: !allowMissing });
  } catch (err) {
    console.error(`build-figures: CONFIG: ${err.message}`);
    process.exit(2);
  }

  if (record) {
    const recorded = recordAspectRatios(result);
    if (!recorded.ok) {
      console.error(`build-figures: CONFIG: ${recorded.error}`);
      process.exit(2);
    }
    console.log(`build-figures: RECORDED ${recorded.changes.length} figure box declarations from a real compile`);
    for (const c of recorded.changes) {
      console.log(`  ${c.figureKey}  ${c.file}`);
      console.log(`    ${c.from.size} (${c.from.declaredAspectRatio})  ->  ${c.to.size} (${c.to.declaredAspectRatio})`);
    }
    if (!recorded.changes.length) {
      console.log("  every figure already declares the box the compiler produces");
    }
    console.log("  review the diff and commit it. This mode is a bootstrap, not a gate.");

    // The violations reported below were measured against the declarations this run has just
    // rewritten, so re-reporting them as a failure would make the bootstrap fail at exactly the
    // moment it did its job. It already returned early above for anything that genuinely went
    // wrong: a missing toolchain, an unmeasurable figure, a ratio it could not scope to a figure.
    // Whether the recorded corpus is now clean is a question for the next ordinary gating run.
    process.exit(0);
  }

  for (const w of result.warnings) console.log(`  [warn] ${w.path || w.key}: ${w.message}`);
  for (const v of result.violations) {
    for (const p of v.problems) console.log(`  [error] ${v.key}: ${p}`);
  }

  const toolchainLine = result.toolchain
    ? `${result.toolchain.bin} (${result.toolchain.version})`
    : ["NOT FOUND — set ASYMPTOTE_BIN, install asymptote, or use scripts/asy-docker", ...toolchainProbeReasons].join(
        "\n    ",
      );
  console.log(`build-figures: ${result.status.toUpperCase()}  (${result.figures.length} figures, ${toolchainLine})`);
  console.log(`  compiled ${result.compiled.length} · contract violations ${result.violations.length} · not compiled ${result.skipped.length}`);

  mkdirSync(outDir, { recursive: true });
  const manifest = {
    pipelineVersion: PIPELINE_VERSION,
    toolchain: result.toolchain,
    status: result.status,
    generatedFrom: contentRoot.replace(REPO + "/", ""),
    figures: result.compiled,
    notCompiled: result.skipped.map((s) => ({ figureKey: s.key, declaredAspectRatio: s.box && s.box.ratio })),
    // What the compiler measured, for every figure it compiled including the ones that then
    // failed S5.5. A ratio mismatch is only actionable if the report says what the compiler
    // produced, and this is where a follow-up run reads it from.
    measurements: result.measurements.map((m) => ({
      figureKey: m.key,
      declaredSize: m.declaredSize,
      declaredAspectRatio: m.declaredRatio,
      measuredWidth: m.measuredWidth,
      measuredHeight: m.measuredHeight,
      measuredAspectRatio: m.measuredRatio,
    })),
  };
  const manifestPath = join(outDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`  manifest: ${manifestPath}`);

  if (result.violations.length) process.exit(1);
  if (!result.toolchain && !allowMissing) {
    console.log("");
    console.log("  Figures validated but NOT compiled. A build that ships no figure is not a pass.");
    console.log("  Provision the toolchain in CI, or re-run with --allow-missing-toolchain for an authoring-only check.");
    process.exit(3);
  }
  process.exit(0);
}
