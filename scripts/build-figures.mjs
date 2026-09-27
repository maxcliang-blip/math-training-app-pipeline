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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DEFAULT_CONTENT = join(REPO, "content");
const DEFAULT_OUT = join(REPO, "artifacts", "figures");

// Bump when the pipeline changes what it emits, so a stale figure is detectable by hash
// rather than by inspection.
export const PIPELINE_VERSION = "asymptote-svg-sanitized@1";

// Content declares a ratio at 3 decimal places, so the build compares at the same
// precision rather than at S5.4's 2% authoring tolerance: the true box is known here.
const RATIO_DECIMALS = 3;
const RATIO_TOLERANCE = 0.005;

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

export const DERIVED_FIELDS = ["figureSvgUrl", "figureHash", "figurePipelineVersion"];

// ---------------------------------------------------------------------------
// Corpus scan
// ---------------------------------------------------------------------------

function loadDir(dir, flat) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const parsed = files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  return flat ? parsed.flat() : parsed;
}

export function collectFigures(contentRoot) {
  const figures = [];
  const warnings = [];

  const lessonRecords = loadDir(join(contentRoot, "lessons"), false);
  const exerciseRecords = [...loadDir(join(contentRoot, "exercises"), true), ...loadDir(join(contentRoot, "fixtures"), true)];

  for (const lesson of lessonRecords) {
    for (const [sectionName, section] of Object.entries(lesson.sections || {})) {
      const list = section && section.figures;
      if (!Array.isArray(list)) continue;
      list.forEach((fig, i) => {
        if (!fig || !fig.asymptoteSource) return;
        figures.push({
          key: `${lesson.id}.sections.${sectionName}.figures[${i}]`,
          source: fig.asymptoteSource,
          alt: fig.asymptoteAlt,
          declaredRatio: fig.asymptoteAspectRatio,
          caption: fig.captionLatex || null,
          record: fig,
        });
      });
    }
  }

  for (const ex of exerciseRecords) {
    if (!ex.asymptoteSource) continue;
    figures.push({
      key: `${ex.id}`,
      source: ex.asymptoteSource,
      alt: ex.asymptoteAlt,
      declaredRatio: ex.asymptoteAspectRatio,
      caption: ex.captionLatex || null,
      record: ex,
    });
  }

  for (const [owner, records] of [["lessons", lessonRecords], ["exercises", exerciseRecords]]) {
    for (const record of records) {
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
      if (Math.abs(measuredRatio - box.ratio) / box.ratio > RATIO_TOLERANCE) {
        violations.push({
          key: figure.key,
          problems: [
            `compiled box is ${measured.width}x${measured.height} (ratio ${measuredRatio}) but content declared ${box.ratio}`,
          ],
        });
        continue;
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
