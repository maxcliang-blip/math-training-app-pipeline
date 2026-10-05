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
//   this build        derives figureSvgUrl + figureHash + figurePipelineVersion + figureCacheKey
//
// Content must never carry the derived fields. Requiring them at import deadlocks authoring
// on the build and no figure can ever ship, so a derived field found in content is a
// warning here, not a requirement on the author.
//
// Usage:
//   node scripts/build-figures.mjs [contentRoot] [--out <dir>] [--allow-missing-toolchain]
//                                   [--record-aspect-ratios]
//
// --out takes a directory, and refuses a value beginning with `-` (MAX-130): the shared parser in
// scripts/lib/require-path-arg.mjs, so a mistyped flag cannot create a directory named after it.
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
  doubledBackslashAfterScript,
  doubledBackslashMacros,
  isRenderableFigure,
  lessonFigureSites,
  exerciseFigureKey,
} from "../lib/figure-contract.mjs";
import { requirePathArg } from "./lib/require-path-arg.mjs";

export { DERIVED_FIELDS, FIGURE_PAYLOAD_FIELDS };

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DEFAULT_CONTENT = join(REPO, "content");
const DEFAULT_OUT = join(REPO, "artifacts", "figures");

// What the emitter is, not what the environment happened to be. S5.5 puts this string in the
// cache key "so a renderer upgrade invalidates cleanly", and that only holds if a change of
// emitter is visible in it.
//
// An Asymptote upgrade *is* a change of emitter: the same source compiles to a different viewBox
// under a different asy, and the glyph shapes come from a different TeX Live font set on top of
// that. Both are measurable -- prepending only a `unitsize` to one source moves its compiled
// width by 40% -- so the toolchain fingerprint below is appended to the constant instead of being
// left to a manual bump.
//
// Without it this repository shipped one version string across three toolchains at once:
// bookworm's asy 2.85 in the Dockerfile figures stage, ubuntu-latest's asy 2.87 in
// .github/workflows/content.yml, and the 2.87 inside the scripts/asy-docker image. An SVG built by
// one and an SVG built by another hashed to the same key, so the cache could not tell them apart
// and neither could detect the other as stale. The audit that found this is MAX-60 S3.11.
//
// Bump this constant when the pipeline changes what it emits; the fingerprint covers the
// environment it emits in.
//
// @2 -> @3 (MAX-75): the emitted SVG is now minified and the sanitizer closes the <image> and
// url() gaps, so bytes built by the previous pipeline and bytes built by this one are not
// interchangeable and must not share a hash.
export const PIPELINE_VERSION = "asymptote-svg-sanitized@3";

// TeX Live's own banner carries the release year ("TeX Live 2023/Deb 2024"). pdfTeX's build number
// in front of it tracks the TeX Live *revision*, not the font set, so the year is the part worth
// keying on.
const TEXLIVE_RELEASE = /TeX Live\s+(\d{4})/i;

// Versions come off the `--version` line the toolchain probe already captured, reduced to the
// release number. The full line carries a build date and a host, and a cache key that moves for a
// reason that cannot change a glyph is not a key: every image rebuild would invalidate every
// figure for nothing.
function releaseOf(version, pattern) {
  const line = String(version || "").trim();
  if (!line) return null;
  if (pattern) {
    const matched = pattern.exec(line);
    if (matched) return matched[1];
  }
  return /(\d+\.\d+(?:\.\d+)?)/.exec(line)?.[1] ?? null;
}

// `unknown` rather than omission. A component that cannot be read is reported as unreadable,
// which is the truth: two environments that both fail to report TeX Live are genuinely
// indistinguishable from here, and printing nothing would claim they had been compared.
function fingerprintPart(label, version, pattern) {
  return `${label}-${releaseOf(version, pattern) ?? "unknown"}`;
}

// The value that goes into `figurePipelineVersion` and the manifest's `pipelineVersion`. The
// fingerprint is per-toolchain, so it is a function of the compiler rather than of this module --
// which is why PIPELINE_VERSION alone is not what either site writes.
export function pipelineVersionFor(toolchain) {
  if (!toolchain) return PIPELINE_VERSION;
  return `${PIPELINE_VERSION}+${[
    fingerprintPart("asy", toolchain.version),
    fingerprintPart("dvisvgm", toolchain.dvisvgmVersion),
    fingerprintPart("texlive", toolchain.texliveVersion, TEXLIVE_RELEASE),
  ].join("_")}`;
}

// Rendering Conventions §5.5 keys the client cache on sha256(asymptoteSource + "|" +
// pipelineVersion). Both inputs are here and only here: the source is the build's input and the
// pipeline version is this build's own, so the key is computed once per figure at ingest and
// shipped as a single opaque string instead of shipping the kilobytes of source the rule is
// written in terms of.
//
// It has to be computed here rather than by the client for the reason §5.5 gives the key in the
// first place: the cache is read *before* the fetch, so the client is holding the build identity
// before it asks for the bytes. A key the client derived after the response arrived would be a
// description of what it already fetched.
//
// The `sha256:` prefix matches figureHash and is part of the value, so the key is never
// mistaken for a source string and never parsed as one.
export function figureCacheKey(asymptoteSource, pipelineVersion = PIPELINE_VERSION) {
  return `sha256:${createHash("sha256").update(`${asymptoteSource}|${pipelineVersion}`).digest("hex")}`;
}

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

// Lower bound on each dimension of the declared size(W,H) ceiling, in the same units as the call.
// This is the *absolute size* counterpart to MIN_ASPECT/MAX_ASPECT, and it exists because the band
// above only constrains the shape of the box: a size(60,45) figure has a legal 1.333 ratio and
// passes every other extent check in the pipeline.
//
// WHY 80, MEASURED (MAX-95). Measured on asy 2.87 + dvisvgm 3.2.1 through this same compile path
// (scripts/asy-docker, --eps --no-fonts), over a 12-rung ladder from size(40,30) to size(640,480),
// each rung drawing a stroked line plus default-font labels:
//
//   1. size() does NOT scale type. The label glyph path is byte-identical at size(40,30) and
//      size(640,480) -- same absolute coordinates, only translated -- at a cap-height of 8.51pt =
//      11.38 CSS px. stroke-width stays 0.5pt at every rung too. So there is no "the text shrank"
//      regime to guard, and a floor pitched at type size would be guarding a number that does not
//      move. This is why the number below is a floor on the *box*, not on the font.
//   2. size(W,H) sets a uniform unitsize from the declared HEIGHT and lets width follow the
//      content's aspect ratio: declared size(80,60) emits 71x61pt, size(100,75) emits 89x75.
//      Consistent with MAX-59's "size() bounds the box, it does not fix it".
//   3. What degrades as the ceiling shrinks is therefore proportion, not type: glyph-box area as a
//      fraction of the emitted viewBox runs 0.204 at size(40,30), 0.048 at size(80,60), 0.025 at
//      size(111,83), 0.003 at size(320,240). Past roughly 5% the labels stop being annotations and
//      become the figure. asy never overlaps them -- glyphPairs was 0 at every rung, because it
//      shrinks the drawing instead -- so there is no hard collision edge to sit on, only a
//      gradient, and 80pt is where that gradient is still comfortably on the good side.
//
// 80pt declared is >= 106.7 CSS px of rendered figure, against a container that very nearly binds:
// web/src/styles.css gives .figure__svg `max-width: 100%` and never `width: 100%`, so the browser
// lays the <img> out at the SVG's intrinsic pt width * 4/3 inside a 736px `main` (704px inside
// article.exercise). Measured over the 91 artifacts a current container build emits, intrinsic
// widths run 169-641 CSS px -- the widest clears 91% of the container an exercise figure gets, so
// the ceiling is very nearly what sets the on-screen size of a figure today.
//
// The corpus is clear of this floor by 39%: on origin/main all 91 ceilings use the two-argument
// form, the smallest declared dimension is 111, and nothing is below 80. So this rejects nothing
// that passes today. That is also why the number is NOT derived from the corpus -- MAX-60 found 55
// of 78 ceilings equal to their own measured box, so the corpus distribution is a record of a
// writeback pass, not of author intent. 80 came from the ladder; the corpus merely clears it.
export const MIN_SIZE_FLOOR = 80;

// Defence in depth. The primary control is that only Asymptote output for approved figure
// sources is ever shipped; this removes the active-content vectors that could survive a
// compromised or unexpected source.
//
// Order matters and is load-bearing in two places. `<image>` is removed before the href rules
// run, because rewriting a data URI to `href="#"` leaves a live `<image>` element pointing at
// nothing: the payload is gone but the element the rule names is still there. And the `url()`
// rule runs before the `javascript:` rule so a `url(javascript:...)` is resolved as a reference
// rather than as a substring.
const SVG_DENY = [
  [/<script\b[\s\S]*?<\/script>/gi, ""],
  [/<!--[\s\S]*?-->/g, ""],
  [/\son[a-z]+\s*=\s*"[^"]*"/gi, ""],
  [/\son[a-z]+\s*=\s*'[^']*'/gi, ""],
  [/<foreignObject[\s\S]*?<\/foreignObject>/gi, ""],
  // An <image> is removed outright, paired or self-closing, whatever it points at. S5.3 says to
  // strip "any <image> with a data URI", and the href rules below already reduce such a payload
  // to `href="#"` -- which satisfies that sentence while leaving the element in place. Asymptote
  // emits no <image> at all, so there is nothing to lose and one fewer way in.
  [/<image\b[^>]*(?:\/>|>[\s\S]*?<\/image\s*>)/gi, ""],
  [/<a\b[^>]*>/gi, ""],
  [/<\/a>/gi, ""],
  [/(href|xlink:href)\s*=\s*"(?!#)[^"]*"/gi, 'href="#"'],
  [/(href|xlink:href)\s*=\s*'(?!#)[^']*'/gi, "href='#'"],
  // A CSS url() is a fetch exactly like href is, and neither the href rules nor the entity rules
  // reach one inside a <style> block or a style attribute. Only a same-document fragment survives,
  // which is what an internal gradient reference looks like; everything else becomes `none`, a
  // value every paint property accepts.
  [/url\(\s*(['"]?)(?!#)[^)]*\)/gi, "none"],
  [/@import\b/gi, ""],
  [/javascript:/gi, ""],
  [/<!ENTITY[\s\S]*?>/gi, ""],
  [/<!DOCTYPE[\s\S]*?>/gi, ""],
];

// The guarantees the deny list above makes, asserted on the emitted text rather than assumed.
// A new vector that slips past every pattern fails the build here instead of shipping.
const SVG_ACTIVE_CONTENT = /<script|<image|javascript:|\son[a-z]+\s*=|<foreignObject|<!ENTITY|@import/i;
const SVG_OFFSITE_URL = /url\(\s*(['"]?)(?!#)[^)]*\)/i;


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

  // The walk below is the shared counter's walk, not a second traversal of the same records.
  // MAX-76 measured a corpus twice: this function found 83 figures, the authoring gate reported
  // 150 for the same files, and neither number could be derived from the other. What counts as a
  // figure is now decided once, in lib/figure-contract.mjs, and this is one of the two readers.
  for (const { file, record: lesson } of lessonFiles) {
    for (const site of lessonFigureSites(lesson)) {
      figures.push({
        key: site.figureKey,
        source: site.record.asymptoteSource,
        alt: site.record.asymptoteAlt,
        declaredRatio: site.record.asymptoteAspectRatio,
        caption: site.record.captionLatex || null,
        file,
        record: site.record,
      });
    }
  }

  for (const { file, record: ex } of exerciseFiles) {
    if (!isRenderableFigure(ex)) continue;
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
    // Neither message may say that the reserved space is a function of the size() call. It is not,
    // and never was measurable as one: asymptoteAspectRatio is recorded from the compiled viewBox
    // (S5.4 item 4), so the box is known after layout and not before it. The old one-argument
    // message asserted exactly that ("with one argument the reserved space cannot be known before
    // layout") while the same rule's own second half retracted it -- MAX-59 S3.10 established that
    // two-argument size(W,H) is a ceiling and not a box, which is why the ratio comes from the
    // compiler. An author who read both halves was told the call decided the box and then told it
    // did not.
    //
    // What is left to require is the spelling. S5.2 asks for a two-dimensional ceiling and this is
    // the only spelling this gate reads; size(W) states one dimension. That is a statement about
    // the contract, so it is the one the message makes.
    problems.push(
      single
        ? "size(W,H) takes two arguments: S5.2 requires a two-dimensional ceiling and size(W) states only " +
          "one. The ceiling bounds the output, it does not fix the box -- asymptoteAspectRatio is recorded " +
          "from the compiled viewBox (S5.4 item 4)"
        : "figure source must call size(W,H)",
    );
    return { problems, box: null };
  }

  const width = Number(sizeCall[1]);
  const height = Number(sizeCall[2]);

  // The floor on the ceiling. MIN_ASPECT/MAX_ASPECT above constrain the *shape* of the declared
  // box; this constrains its absolute size, which nothing else in the pipeline does. The reason it
  // is a floor on the box and not on the font is measured, and it is the opposite of the intuitive
  // story: asy 2.87's size() does not scale type, so a figure's labels stay at 11.38 CSS px cap-
  // height whatever the ceiling says. Shrinking the ceiling does not make the text small -- it
  // shrinks the drawing out from under text that never shrank, so the labels stop being annotations
  // and become the figure. See MIN_SIZE_FLOOR above for the ladder.
  //
  // Reported per dimension rather than on the area or the minimum, because the two dimensions fail
  // for different reasons and an author needs to know which one to raise: a too-narrow W means the
  // figure cannot hold a label beside what it labels, a too-short H means it cannot hold a label
  // above and below. One message covers both and names the pair, because the fix is the same.
  const tooSmall = [["W", width], ["H", height]].filter(([, v]) => v < MIN_SIZE_FLOOR);
  if (tooSmall.length) {
    problems.push(
      `size(${width},${height}) declares a ceiling below the ${MIN_SIZE_FLOOR}pt legibility floor ` +
        `(${tooSmall.map(([n, v]) => `${n}=${v}`).join(", ")}). Asymptote's size() does not scale type, so a ` +
        `ceiling this small does not shrink the labels -- it shrinks the drawing underneath labels that ` +
        "stay the same size, and the figure stops being readable (S5.2). The ceiling still bounds the " +
        "output, it is not the box: asymptoteAspectRatio comes from the compiled viewBox (S5.4 item 4)",
    );
  }

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
  // renderer reserves space from. Both compared the wrong side. The ceiling is kept for the one
  // thing the source can still state before layout -- an upper bound on the output extent -- and is
  // read as no evidence at all about the box the figure renders at.
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

  // TeX Live is the third component of the pipeline fingerprint, not a build dependency. asy
  // renders text through LaTeX and dvips, so the glyph shapes in the SVG come from TeX Live's
  // fonts rather than from asy, and two hosts with the same asy can still differ there. Probed
  // best-effort: an absent or unusable `tex` must not fail a figure build whose compiler works,
  // and an unreadable version becomes `texlive-unknown` in the fingerprint rather than a claim
  // that the fonts were pinned.
  let texliveVersion = null;
  const tex = probeToolchainBin("tex");
  if (tex.ok) texliveVersion = tex.version;

  return {
    ...asy,
    dvisvgm: dvisvgm.bin,
    dvisvgmPath: dvisvgm.path,
    dvisvgmVersion: dvisvgm.version,
    texliveVersion,
  };
}

// ---------------------------------------------------------------------------
// Minify
// ---------------------------------------------------------------------------

//
// dvisvgm writes the compiler's full double precision: a coordinate on a 187pt-wide figure
// arrives as `380.847576`. One PostScript point is 1/72 inch, so the third decimal of one is
// 1/720000 inch -- finer than any renderer addresses. Rounding there is not a visible change at
// any zoom a learner can reach, and it is the single largest source of bytes in the output.
const SVG_COORD_DECIMALS = 3;

// One SVG number, as written by dvisvgm and asymptote: optional sign, digits with an optional
// fraction, optional exponent. Anchored so it cannot start mid-identifier -- `e5` in a colour
// like `#ffee00` is not a number, and `id='g1'` is not a number.
const SVG_NUMBER = /[+-]?(?:\d+\.\d+|\.\d+|\d+)(?:[eE][+-]?\d+)?/g;

// Shortest exact-enough spelling of one number: rounded, trailing zeros dropped, the leading
// zero before a bare fraction dropped. `380.847576` -> `380.848`, `0.500` -> `.5`, `1.000` -> `1`.
// Never returns an empty string, so a token cannot vanish and weld two tokens together.
function shortenNumber(token, decimals = SVG_COORD_DECIMALS) {
  const value = Number(token);
  if (!Number.isFinite(value)) return token;
  let short = value.toFixed(decimals);
  if (short.includes(".")) short = short.replace(/\.?0+$/, "");
  if (short === "-0") return "0";
  if (short.startsWith("0.")) short = short.slice(1);
  else if (short.startsWith("-0.")) short = `-${short.slice(2)}`;
  return short || "0";
}

function shortenNumbers(text) {
  return text.replace(SVG_NUMBER, (token) => shortenNumber(token));
}

// Attributes whose value is geometry, so rounding a number in it cannot change a colour, a
// font name, a URL or a text string. `width`/`height`/`viewBox` carry a unit suffix (`187pt`);
// the number is matched and the suffix is left alone, which is why this is a plain number scan
// and not a whole-value parse.
const GEOMETRY_ATTRS = new Set([
  "d", "points", "viewBox", "transform", "gradientTransform", "patternTransform",
  "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
  "offset", "stroke-width", "stroke-dashoffset", "font-size",
]);

// Shorten the numbers inside one `name='value'` / `name="value"` attribute.
//
// `d` gets the path pass rather than a number scan, because it is where the bytes are: 97% of a
// dvisvgm figure is path data, and most of that is a six-decimal absolute coordinate. A number
// scan shortens those and stops. Expressing them as deltas is what actually halves the file.
function shortenAttribute(name, value) {
  if (name === "d") return toRelativePathData(value) || shortenNumbers(value);
  if (!GEOMETRY_ATTRS.has(name)) return value;
  return shortenNumbers(value);
}

// Minify an SVG document.
//
// Three passes, in this order, each independently a no-op on input that has nothing to remove:
// inter-tag whitespace, attribute padding, then number precision. Nothing here drops an element,
// changes an attribute name, or rewrites markup structure -- the sanitiser owns that -- so a
// figure that renders before minification renders after it. `<text>`/`<tspan>` content is held
// out of the whitespace pass, because in text a newline is a space and dropping it would change
// what a screen reader reads.
export function minifySvg(svg) {
  // `<text>`/`<tspan>` content is held out of every pass. In text a newline is a space, so
  // dropping whitespace there changes what a screen reader reads, and a run of text can contain
  // the very shapes the other passes match on. Asymptote emits no text at all (`--no-fonts`
  // turns glyphs into paths), so this costs nothing today and removes a class of surprise if a
  // figure ever does carry a label.
  const textSpans = [];
  let out = svg.replace(/<(text|tspan)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (match) => {
    textSpans.push(match);
    return `\u0000${textSpans.length - 1}\u0000`;
  });
  const restore = (text) => text.replace(/\u0000(\d+)\u0000/g, (_, i) => textSpans[Number(i)]);

  // 1. Inter-element whitespace. dvisvgm writes one element per line with no indentation, and
  //    across the corpus that is thousands of bytes per figure spent on newlines.
  out = out.replace(/>\s+</g, "><").replace(/\s+\/>/g, "/>");

  // 2. Attribute padding: `<path  d='..' />` and `d = '..'` become single-spaced and tight. Both
  //    sides of every attribute match keep their original quote character, and the self-closing
  //    slash is carried through: dropping it would turn `<circle ... />` into an unclosed
  //    `<circle ...>` and produce a document that no longer parses.
  out = out.replace(
    /<([a-zA-Z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g,
    (tag, name, attrs, slash) => `<${name}${attrs.replace(/\s*=\s*/g, "=")}${slash}>`,
  );

  // 3. Geometry, inside geometry attributes only.
  out = out.replace(
    /([\w:.-]+)\s*=\s*(["'])([^"']*)\2/g,
    (match, name, quote, value) => `${name}=${quote}${shortenAttribute(name, value)}${quote}`,
  );

  return restore(out);
}

export function sanitizeSvg(svg) {
  let out = svg;
  for (const [pattern, replacement] of SVG_DENY) out = out.replace(pattern, replacement);
  // Asymptote emits an XML prolog ahead of the root element, so validate the root only
  // after the prolog is gone, and re-emit a canonical one.
  out = out.replace(/^\s*<\?xml[^>]*\?>\s*/i, "").replace(/^\s*<!DOCTYPE[^>]*>\s*/i, "").trim();
  if (!/^<svg[\s>]/i.test(out)) throw new Error("sanitized output has no svg root element");
  // Minified before the assertions, so what is asserted on is exactly what ships.
  out = minifySvg(out);
  if (SVG_ACTIVE_CONTENT.test(out)) throw new Error("active content survived sanitization");
  if (SVG_OFFSITE_URL.test(out)) throw new Error("a url() reference outside the document survived sanitization");
  return `<?xml version="1.0" encoding="UTF-8"?>${out}\n`;
}

// ---------------------------------------------------------------------------
// Path data
// ---------------------------------------------------------------------------

// Every path command: how many arguments it takes, and which of those arguments are the x and y
// of a point that becomes a delta when the command is made relative. dvisvgm emits only the
// absolute forms; the rest is here so the pass stays correct for any conformant producer.
//
// `H` carries an x and no y, `V` a y and no x, and `A`'s rx/ry/rotation/flags are not points at
// all. Getting those three right is the difference between a smaller file and a broken one.
const PATH_COMMANDS = {
  M: { arity: 2, delta: { 0: "x", 1: "y" } },
  L: { arity: 2, delta: { 0: "x", 1: "y" } },
  T: { arity: 2, delta: { 0: "x", 1: "y" } },
  H: { arity: 1, delta: { 0: "x" } },
  V: { arity: 1, delta: { 0: "y" } },
  C: { arity: 6, delta: { 0: "x", 1: "y", 2: "x", 3: "y", 4: "x", 5: "y" } },
  S: { arity: 4, delta: { 0: "x", 1: "y", 2: "x", 3: "y" } },
  Q: { arity: 4, delta: { 0: "x", 1: "y", 2: "x", 3: "y" } },
  A: { arity: 7, delta: { 5: "x", 6: "y" } },
  Z: { arity: 0, delta: {} },
};

// The tolerance, in user units, on how far the reconstructed point may drift from the original.
//
// This is the gate that makes relative path data safe here. Rounding an absolute coordinate
// bounds its error at half an ulp of the last decimal. Rounding a *delta* does not: the consumer
// sums the deltas, so the errors accumulate along the path, one rounding step per command. A
// dense polyline can walk off the shape it is supposed to draw. So the transform tracks the
// position a renderer will reconstruct and compares it against the original at every command, and
// a path that exceeds the tolerance is emitted in absolute form instead -- still shortened, still
// correct, just not the smallest. Nothing downstream has to trust the arithmetic; the pass
// refuses to emit a path it cannot vouch for.
const PATH_DRIFT_TOLERANCE = 0.05;

// One number in path data, up to the next separator or command letter. Exponent notation is
// included because the SVG grammar allows it even though dvisvgm does not emit it.
const PATH_NUMBER = /^[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/;

// Rewrite path data with absolute coordinates expressed as deltas, or return null if the input
// cannot be parsed or the rewrite would drift too far to vouch for.
//
// A null return is not a failure: the caller keeps the absolute form, which is always safe. The
// parse is strict on purpose and throws rather than guessing, because a half-understood path is
// worse than an unminified one.
export function toRelativePathData(d, decimals = SVG_COORD_DECIMALS, tolerance = PATH_DRIFT_TOLERANCE) {
  const src = String(d);
  const isSeparator = (c) => c === " " || c === "," || c === "\t" || c === "\n" || c === "\r";
  let i = 0;
  let exactX = 0;
  let exactY = 0;
  let startX = 0;
  let startY = 0;
  let drawnX = 0;
  let drawnY = 0;
  let started = false;
  let out = "";
  let previous = null;

  const skipSeparators = () => {
    while (i < src.length && isSeparator(src[i])) i++;
  };

  try {
    skipSeparators();
    while (i < src.length) {
      // A command letter, or an implicit repeat of the previous one. `M`'s implicit repeats are
      // `L` and `m`'s are `l`; every other command repeats itself.
      let letter;
      if (/[A-Za-z]/.test(src[i])) {
        letter = src[i];
        i++;
      } else if (previous === null) {
        throw new Error("path data does not start with a command");
      } else if (previous === "M") {
        letter = "L";
      } else if (previous === "m") {
        letter = "l";
      } else {
        letter = previous;
      }
      previous = letter;

      const upper = letter.toUpperCase();
      const spec = PATH_COMMANDS[upper];
      if (!spec) throw new Error(`unknown path command '${letter}'`);
      // A path has to open with a moveto: every other command needs a current point to be
      // relative to, and a document that opens with anything else is malformed anyway.
      if (!started && upper !== "M") throw new Error("path data does not open with a moveto");
      const isAbsolute = letter === upper;

      if (upper === "Z") {
        skipSeparators();
        out += `${letter} `;
        exactX = startX;
        exactY = startY;
        drawnX = startX;
        drawnY = startY;
        continue;
      }

      const isArc = upper === "A";
      const value = [];
      const emitted = [];
      for (let n = 0; n < spec.arity; n++) {
        skipSeparators();
        const isFlag = isArc && (n === 3 || n === 4);
        const match = (isFlag ? /^[01]/ : PATH_NUMBER).exec(src.slice(i));
        if (!match) throw new Error(`no path argument where argument ${n} of ${letter} was expected`);
        value.push(Number(match[0]));
        // Flags stay verbatim: they are single characters, not measurements.
        emitted.push(isFlag ? match[0] : shortenNumber(match[0], decimals));
        i += match[0].length;
      }

      // Which arguments hold the endpoint: the last x and the last y this command sets. `H` has an
      // x and no y, `V` a y and no x, and an arc's rx/ry/rotation/flags are not points at all.
      const xs = Object.keys(spec.delta).map(Number).filter((k) => spec.delta[k] === "x");
      const ys = Object.keys(spec.delta).map(Number).filter((k) => spec.delta[k] === "y");
      const endX = xs.length ? (isAbsolute ? value[xs[xs.length - 1]] : exactX + value[xs[xs.length - 1]]) : exactX;
      const endY = ys.length ? (isAbsolute ? value[ys[ys.length - 1]] : exactY + value[ys[ys.length - 1]]) : exactY;

      // Rewriting to a delta needs a current point to be relative to, and a command that is
      // already relative is already as short as it gets -- though its endpoint still has to be
      // tracked, because the next delta is measured from where it lands.
      const relative = isAbsolute && started;
      if (relative) {
        // Each argument is measured from the position the renderer is actually at, not from the
        // previous argument: in `C x1 y1 x2 y2 x y` all three pairs are deltas from the same
        // current point, not from each other.
        for (const [index, axis] of Object.entries(spec.delta)) {
          emitted[Number(index)] = shortenNumber(String(value[Number(index)] - (axis === "x" ? drawnX : drawnY)), decimals);
        }
        out += letter.toLowerCase();
      } else {
        out += letter;
      }
      // No separator is needed around a command letter: `M0 0l10 0` is the grammar's own canonical
      // spelling, and dropping the space is one byte per command across thousands of commands.
      out += emitted.join(" ");

      // Where a renderer lands after reading what was just emitted.
      const lastX = xs.length ? xs[xs.length - 1] : -1;
      const lastY = ys.length ? ys[ys.length - 1] : -1;
      const nextDrawnX = lastX < 0 ? drawnX : relative ? drawnX + Number(emitted[lastX]) : Number(emitted[lastX]);
      const nextDrawnY = lastY < 0 ? drawnY : relative ? drawnY + Number(emitted[lastY]) : Number(emitted[lastY]);

      // The gate. Nothing is emitted unless the reconstructed point is still within tolerance of
      // the real one, so accumulated rounding can never walk a path off the shape it draws. The
      // caller falls back to the absolute form, which is always safe.
      if (Math.abs(nextDrawnX - endX) > tolerance || Math.abs(nextDrawnY - endY) > tolerance) return null;

      exactX = endX;
      exactY = endY;
      drawnX = nextDrawnX;
      drawnY = nextDrawnY;
      if (upper === "M") {
        startX = endX;
        startY = endY;
      }
      started = true;
    }
  } catch {
    // Unparseable, or a shape this pass does not model.
    return null;
  }

  return out.trim() || null;
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

// ---------------------------------------------------------------------------
// Diagnosing a compile failure
// ---------------------------------------------------------------------------

// The doubled-backslash detector lives in lib/figure-contract.mjs, next to the TeX label
// extractor, and is imported rather than re-declared here. (MAX-119)
//
// It used to be a regex and a helper defined right here, called from exactly one place:
// diagnoseCompileFailure, below. That is the half of the defect that was already understood --
// Asymptote copies a string literal into the .tex it generates for a TeX label verbatim, so a macro
// written with `\\` reaches TeX as two backslashes -- and the half the authoring gate could not
// reach, because the detector sat behind a compile failure. One definition, in a module both
// consumers already import, is what lets checkAsymptote ask the same question on the pass path, and
// it means the two can no longer disagree about what a doubled backslash is.
//
// This file still matches over the *whole* source rather than over extracted label payloads, on
// purpose: the two answer different questions. The build must not add a new failure mode to a
// figure that compiles, and a payload this extractor does not recognise (a macro that builds its
// label some other way) still has to be diagnosable when TeX rejects it. The authoring gate asks
// the narrower question, on purpose, because it has to be right about every figure and cannot afford
// to guess. Both use the same definition of the defect, which is the part that had to be shared.

// The one line of a TeX log that says what went wrong.
//
// TeX prints `! <error>` where it happens and then keeps going; Asymptote's shipout aborts
// afterwards, so the last line of every TeX-side failure is plain_shipout.asy saying "shipout
// failed". The first `!` line is the cause and the tail is the symptom, which is why taking the
// tail — what this used to do — reported the renderer and not the figure.
function firstTexError(text) {
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (/^!\s*\S/.test(trimmed)) return trimmed;
  }
  return null;
}

// Name the cause, when the cause is one this pipeline knows.
//
// Returns null when nothing is recognised, and the caller then falls back to the raw compiler
// output. A diagnosis is only worth printing if it is more specific than the symptom it replaces,
// so each case below has to be evidence from the figure source or the compiler log rather than a
// guess from the shape of the failure.
function diagnoseCompileFailure(err, figure, logs) {
  const source = String((figure && figure.source) || "");
  const stderr = (err && (err.stderr || err.message)) || "";
  const compilerText = `${stderr}\n${logs}`;

  // The corpus-wide failure behind MAX-75's audit. Asymptote copies a string literal into the
  // .tex it generates for a TeX label *verbatim* — it does not process `\\` as an escape — so
  // `label("$90^\\circ$", ...)` reaches TeX as `^\\circ`. TeX's `^` takes exactly one token as
  // its argument, `\\` is a control symbol rather than a character, and the result is
  // `Missing { inserted` on every TeX Live, from every amsmath configuration, at every asy
  // version. Isolated: one backslash compiles, two do not. The compiler's own message names
  // shipout, so without this case the figure is unfixable from the build output alone.
  //
  // The `^`/`_` adjacency is what makes it a *compile* failure rather than a rendering one, and
  // it is the condition this keys on. A doubled backslash anywhere else -- `y=\\sqrt{x-2}` --
  // compiles perfectly and silently renders a line break followed by italic `sqrt`, which is
  // worse in a way no build output will ever report. The corpus currently carries 34 of those
  // (MAX-62); they are named here so the fix is not mistaken for "the five that happened to
  // fail".
  const scripting = doubledBackslashAfterScript(source);
  const elsewhere = doubledBackslashMacros(source);
  if (scripting.length) {
    const others = elsewhere.filter((m) => !scripting.some((s) => s.endsWith(m.slice(2))));
    // The same macro spelled the way it should be, so the fix line quotes it instead of
    // describing it.
    const bare = scripting[0].replace(/[\^_]\s*\\/, "");
    return (
      `cause: LaTeX macro${scripting.length > 1 ? "s" : ""} written with a doubled backslash immediately after ` +
      `^ or _ inside the Asymptote string literal (${scripting.join(", ")}). Asymptote copies string literals ` +
      `into the .tex it generates verbatim, so both backslashes reach TeX; TeX's ^ and _ take exactly one ` +
      `token, \\ is a control symbol rather than a character, and the result is the "Missing { inserted" above. ` +
      `Write one backslash (${bare}, not ${scripting[0]}). This is not a missing \\usepackage: adding amsmath ` +
      `changes nothing here.` +
      (others.length
        ? ` The same figure also carries ${others.length} doubled backslash${others.length > 1 ? "es" : ""} ` +
          `that do NOT break the compile but do render wrong -- ${others.join(", ")} -- because TeX reads \\ as ` +
          `a line break and then sets the bare macro name in italic. Fix those in the same edit.`
        : "")
    );
  }

  // A TeX Live without amsmath fails inside shipout too, and with the same last line. This is the
  // one other cause that is a property of the box rather than of the figure, so it is worth
  // naming separately: the fix is on the machine, not in the content.
  const missingFile = compilerText.match(/File `?'?([\w.-]+\.sty)'? not found/i);
  if (missingFile) {
    return `cause: TeX is missing ${missingFile[1]}. That is a toolchain property, not a figure defect: ` +
      `install the package providing it (CI: texlive-latex-base plus the package that ships the .sty).`;
  }
  if (/TeX capacity exceeded/i.test(compilerText)) {
    return `cause: TeX hit a capacity limit, which almost always means a LaTeX package the labels need ` +
      `is not installed (amsmath above all). Check \`kpsewhich amsmath.sty\` on the build host.`;
  }

  // execFileSync's timeout kills the child with SIGTERM and reports it as `killed`, not as an exit
  // code. Without naming it, a wedged compile is reported with whatever the compiler managed to
  // print first, which reads like a content defect.
  if ((err && (err.killed || err.signal === "SIGTERM" || err.code === "ETIMEDOUT")) ||
      /timed out|timeout/i.test(compilerText)) {
    return `cause: the compiler was killed by the ${(err && err.timeout) ? `${err.timeout}ms ` : ""}` +
      `timeout in compileFigure, not by the figure's source. Raise the budget or split the figure if this ` +
      `repeats; a label that typesets once should not need minutes.`;
  }

  const tex = firstTexError(compilerText);
  if (tex) return `cause: TeX reported \`${tex}\`. See the log tail below for the line it failed on.`;

  return null;
}

// Everything the compiler left behind that could name a cause, as one blob of text.
function readWorkLogs(work, names) {
  const logs = [];
  // asy writes one .tex per TeX-rendered label and a combined .log. The latex error is in the log,
  // and it names the macro — which is the only thing that points at the figure.
  for (const name of names.filter((f) => /\.log$|\.tex$|\.blg$/.test(f)).slice(0, 4)) {
    try {
      logs.push(readFileSync(join(work, name), "utf8"));
    } catch {
      // Unreadable is not worth reporting over the compiler's own words.
    }
  }
  return logs.join("\n");
}

export function describeCompileFailure(err, work, figure) {
  const parts = [];

  let left = [];
  try {
    left = readdirSync(work).filter((f) => f !== "figure.asy");
  } catch {
    // The work directory is gone; nothing more to report than the compiler said.
  }
  const logs = readWorkLogs(work, left);

  // The name of the cause goes first, because everything below it is evidence and the reader
  // needs the conclusion before the appendix. A caller that only prints the first line still gets
  // a diagnosis rather than "shipout failed".
  const diagnosis = diagnoseCompileFailure(err, figure, logs);
  if (diagnosis) parts.push(diagnosis);

  const stderr = (err.stderr || err.message || "").toString().trim();
  if (stderr) parts.push(stderr.split("\n").filter((l) => l.trim()).slice(-8).join(" | "));

  parts.push(`[${figure.key}] work dir held ${left.join(", ") || "nothing"}`);

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
  // The pipeline identity these bytes are being built under, computed once. MAX-77: this is the
  // constant plus a fingerprint of the compiler that will read it, and it is what both
  // figurePipelineVersion and figureCacheKey have to fold in -- a figure whose recorded version
  // says one toolchain and whose cache key says another is worse than either being absent.
  const pipelineVersion = pipelineVersionFor(toolchain);
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
    compiled.push({
      figureKey: figure.key,
      figureSvgUrl: `artifacts/figures/svg/${result.file}`,
      figureHash: `sha256:${createHash("sha256").update(result.svg).digest("hex")}`,
figurePipelineVersion: pipelineVersion,
      // §5.5's client cache key. Computed from the source and the pipeline version, so a rebuilt
      // figure -- same figureKey, different bytes -- lands on a different key and the client
      // cannot serve the previous build's SVG from its cache.
      //
      // It folds in the *fingerprinted* pipeline version, not the bare PIPELINE_VERSION constant,
      // because that is the value figurePipelineVersion above carries and therefore the identity
      // the bytes were actually built under. MAX-77 is what made those two differ: three
      // toolchains emitted under one version string, so a key built from the constant alone
      // would say "same build" across an asy upgrade and hand the client the same stale-slot
      // answer this field exists to prevent.
      figureCacheKey: figureCacheKey(figure.source, pipelineVersion),
      declaredAspectRatio: box.ratio,
      compiledAspectRatio: ratioNote,
      asymptoteVersion: toolchain.version,
      alt: figure.alt,
      captionLatex: figure.caption,
    });
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
  const positional = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : null;

  // `--out <dir>` takes the next argv token as its output directory, so `--out --any-flag` used to
  // resolve that flag against the cwd and build into a directory named after it -- the same defect
  // MAX-97 hit through check-content-math.mjs's `--json` and MAX-124 through check-push-authors.mjs's
  // `--report`, the third instance of it in this repository and the first one still on main. The
  // shared parser (scripts/lib/require-path-arg.mjs, MAX-130) is what every tool with a bare-path
  // flag now calls, so the next one gets the refusal by default instead of re-deriving it.
  //
  // First thing the CLI does, before the content-root check, for the reason MAX-97 had to fix twice:
  // the refusal and the configuration error below share exit code 2, so a run with both wrong can
  // only be told apart by which message printed. check-content-math.mjs's --selftest pins that
  // ordering by spawning this script with a corpus root that does not exist.
  const outArg = requirePathArg(args, "--out");
  if (!outArg.ok) {
    console.error(`build-figures: ARGUMENT: ${outArg.message}`);
    console.error("                     Nothing was written. Give --out a directory, or drop it to");
    console.error(`                     build into ${DEFAULT_OUT}.`);
    process.exit(2);
  }
  // The truthiness test is the original one: `--out` with no value, or `--out ""`, still means
  // "the default directory", unchanged.
  const contentRoot = positional || (process.env.CONTENT_ROOT ? resolve(process.env.CONTENT_ROOT) : DEFAULT_CONTENT);
  const outDir = outArg.value ? resolve(outArg.value) : DEFAULT_OUT;

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
    pipelineVersion: pipelineVersionFor(result.toolchain),
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
