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
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DERIVED_FIELDS, FIGURE_PAYLOAD_FIELDS, lessonFigureKey, exerciseFigureKey } from "../lib/figure-contract.mjs";

export { DERIVED_FIELDS, FIGURE_PAYLOAD_FIELDS };

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DEFAULT_CONTENT = join(REPO, "content");
const DEFAULT_OUT = join(REPO, "artifacts", "figures");

// Bump when the pipeline changes what it emits, so a stale figure is detectable by hash
// rather than by inspection.
export const PIPELINE_VERSION = "asymptote-svg-sanitized@2";

// Content declares a ratio at 3 decimal places, and the authoring check that ties that
// declaration to the author's own size(W,H) call is exact at that precision. It lives in
// scripts/preflight-content.mjs (S5.4a) because it is a property of the source text and needs
// no compiler. The two checks are different and must not be given the same number.
const RATIO_DECIMALS = 3;
// S5.5 thresholds, from rendering_conventions 5.4 item 4. These govern the *compiled* box
// only. The authoring check (S5.4a, declared ratio vs size(w,h)) is exact at RATIO_DECIMALS
// and lives in scripts/preflight-content.mjs; the two are different checks and must not be
// given the same number.
const RATIO_WARN = 0.02;
const RATIO_REJECT = 0.05;

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
      if (!Array.isArray(list)) continue;
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
  const derived = width / height;
  const atDeclaredPrecision = Number(derived.toFixed(RATIO_DECIMALS));

  if (typeof figure.declaredRatio !== "number") {
    problems.push("asymptoteAspectRatio is mandatory with a figure");
  } else if (figure.declaredRatio !== atDeclaredPrecision) {
    problems.push(
      `asymptoteAspectRatio ${figure.declaredRatio} is not size(${width},${height}) = ${atDeclaredPrecision} at ${RATIO_DECIMALS} decimals`,
    );
  }

  if (typeof figure.alt !== "string" || figure.alt.trim().length < 20) {
    problems.push("asymptoteAlt is mandatory with a figure and must be at least one sentence");
  } else if (figure.alt.includes("$")) {
    problems.push("asymptoteAlt is read by a screen reader before any math renders; keep it plain prose");
  }

  if (/(input|include|write|open)\s*\(/.test(figure.source)) {
    problems.push("figure source must not touch the filesystem");
  }

  return { problems, box: { width, height, ratio: atDeclaredPrecision } };
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

export function findToolchain() {
  for (const candidate of [process.env.ASYMPTOTE_BIN, "asymptote", "asy"]) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) {
      return { bin: candidate, version: (probe.stdout || probe.stderr || "").split("\n")[0].trim() };
    }
  }
  return null;
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

function measureBox(svg) {
  const width = svg.match(/\bwidth\s*=\s*"([\d.]+)(pt|px|mm|cm|in)?"/i);
  const height = svg.match(/\bheight\s*=\s*"([\d.]+)(pt|px|mm|cm|in)?"/i);
  const viewBox = svg.match(/\bviewBox\s*=\s*"([\d.\s-]+)"/i);
  if (width && height) return { width: Number(width[1]), height: Number(height[1]) };
  if (viewBox) {
    const [, , w, h] = viewBox[1].trim().split(/\s+/).map(Number);
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  return null;
}

function compileFigure(toolchain, figure, outDir) {
  const work = mkdtempSync(join(tmpdir(), "figure-build-"));
  try {
    const stem = figure.key.replace(/[^a-zA-Z0-9._-]+/g, "_");
    writeFileSync(join(work, `${stem}.asy`), figure.source);
    execFileSync(toolchain.bin, ["-outdir=" + work, "-svg", `${stem}.asy`], {
      cwd: work,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    const produced = readdirSync(work).filter((f) => f.endsWith(".svg"));
    if (produced.length !== 1) {
      return { error: `expected one svg out of ${figure.key}, got ${produced.length}` };
    }
    const raw = readFileSync(join(work, produced[0]), "utf8");
    const svg = sanitizeSvg(raw);
    mkdirSync(join(outDir, "svg"), { recursive: true });
    const file = `${stem}.svg`;
    writeFileSync(join(outDir, "svg", file), svg);
    return { svg, file, box: measureBox(svg) };
  } catch (err) {
    return { error: `compile failed: ${(err.stderr || err.message || "").toString().trim().split("\n").slice(-2).join(" ")}` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildFigures(contentRoot, outDir, { requireToolchain = true } = {}) {
  const { figures, warnings } = collectFigures(contentRoot);
  const toolchain = findToolchain();
  const violations = [];
  const compiled = [];
  const skipped = [];

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
    let ratioNote = null;
    if (measured && measured.height > 0) {
      const measuredRatio = Number((measured.width / measured.height).toFixed(RATIO_DECIMALS));
      // S5.5 compiled-box drift, two tiers, exactly as rendering_conventions 5.4 item 4:
      // over 2% is a warning, over 5% rejects the figure. Both sides are rounded to the
      // declared precision first, so the declaration's own quantization is not counted as drift.
      //
      // The tolerance is a *cosmetics* threshold, not a physics one. CLS is already 0 in both
      // states because the reserved box is sized from the declared ratio and the SVG is
      // object-fit:contain, so a mismatch never reflows the page -- it only leaves a sunken
      // gutter. At a 480px figure width, 2% is about 7px (imperceptible) and 5% is about 18px
      // (visible). A tighter single threshold, such as the 0.5% this previously used, rejects
      // figures the spec says to warn about and has no layout justification behind it.
      const drift = Math.abs(measuredRatio - box.ratio) / box.ratio;
      if (drift > RATIO_REJECT) {
        violations.push({
          key: figure.key,
          problems: [
            `compiled box is ${measured.width}x${measured.height} (ratio ${measuredRatio}) but content declared ` +
            `${box.ratio}: ${(drift * 100).toFixed(1)}% drift exceeds the ${RATIO_REJECT * 100}% reject threshold (S5.5). ` +
            `The drawing overflows its size() call; fix the size() or scale the content.`,
          ],
        });
        continue;
      }
      if (drift > RATIO_WARN) {
        warnings.push({
          key: figure.key,
          message: `compiled box is ${measured.width}x${measured.height} (ratio ${measuredRatio}) against declared ` +
            `${box.ratio}: ${(drift * 100).toFixed(1)}% drift is over the ${RATIO_WARN * 100}% warn threshold (S5.5)`,
        });
      }
      ratioNote = measuredRatio;
    }
    compiled.push({
      figureKey: figure.key,
      figureSvgUrl: `artifacts/figures/svg/${result.file}`,
      figureHash: `sha256:${createHash("sha256").update(result.svg).digest("hex")}`,
      figurePipelineVersion: PIPELINE_VERSION,
      declaredAspectRatio: box.ratio,
      compiledAspectRatio: ratioNote,
      asymptoteVersion: toolchain.version,
      alt: figure.alt,
      captionLatex: figure.caption,
    });
  }

  const status = violations.length ? "fail" : toolchain ? (skipped.length ? "partial" : "pass") : "toolchain-missing";
  return { status, figures, toolchain, violations, compiled, skipped, warnings };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const allowMissing = args.includes("--allow-missing-toolchain");
  const outIdx = args.indexOf("--out");
  const positional = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : null;
  const contentRoot = positional || (process.env.CONTENT_ROOT ? resolve(process.env.CONTENT_ROOT) : DEFAULT_CONTENT);
  const outDir = outIdx >= 0 && args[outIdx + 1] ? resolve(args[outIdx + 1]) : DEFAULT_OUT;

  if (!existsSync(contentRoot)) {
    console.error(`build-figures: CONFIG: content root ${contentRoot} does not exist`);
    process.exit(2);
  }

  const result = buildFigures(contentRoot, outDir, { requireToolchain: !allowMissing });

  for (const w of result.warnings) console.log(`  [warn] ${w.path}: ${w.message}`);
  for (const v of result.violations) {
    for (const p of v.problems) console.log(`  [error] ${v.key}: ${p}`);
  }

  const toolchainLine = result.toolchain
    ? `${result.toolchain.bin} (${result.toolchain.version})`
    : "NOT FOUND — set ASYMPTOTE_BIN or install asymptote";
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
