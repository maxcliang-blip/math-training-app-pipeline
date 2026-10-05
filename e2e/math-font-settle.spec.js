// RC §7's math half of "Layout shift from math/figures | CLS = 0", asserted in a browser.
//
// KaTeX ships twenty @font-face families and asks the network for them lazily: a face is only
// requested once a formula has rendered, which is after the bundle has loaded and React has run.
// Until a face arrives, every formula is laid out in the fallback serif; when it lands the browser
// re-lays the prose around it. That swap is a layout shift, it is the only shift on the lesson
// route, and it is worth ~1e-4 on a page that is otherwise completely still — small enough that the
// Lesson spec §9 #6 budget (< 0.05) has never noticed it, and large enough to be non-zero, which is
// what RC §7 names.
//
// Two tests, and the second is the one that matters:
//
//   1. "the lesson route settles at CLS 0" — a normal load, which is the number RC §7 budgets.
//   2. "a face that arrives after first paint costs nothing" — every KaTeX font response is parked
//      until the page has painted, then released. A fix that only makes the faces arrive sooner
//      passes (1) on a fast runner and fails (2) everywhere; only a fix that makes the swap
//      *incapable* of moving the page passes both. Timing is the network's business, so a gate that
//      depends on timing is a gate that reports a different number on a slower machine — which is
//      how this defect stayed at ~1e-4 for a year while every budget said the page was fine.
//
// Neither test may pass by measuring nothing. Every CLS assertion is preceded by one that the
// lesson rendered formulas, and that one formula is the width of a paragraph; and test (1) also
// asserts that real KaTeX faces are loaded, so deleting the webfonts reports red rather than green.

import { expect, test } from "@playwright/test";

// Cumulative Layout Shift from PerformanceObserver('layout-shift').
//
// Installed before any page script runs, and buffered, because a shift that happened before the
// observer existed is one the measurement silently misses — which is how a suite reports CLS 0 on a
// page that moved. `sources` are kept because "the reader typesetting moved" and "the figure moved"
// are different defects, and a failure that cannot say which one it saw is a failure that gets
// re-investigated from scratch.
const OBSERVER = `
  window.__shifts = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      window.__shifts.push({
        value: entry.value,
        hadRecentInput: entry.hadRecentInput,
        sources: (entry.sources || []).map((s) => ({
          node: s.node ? (s.node.nodeName || "?") + (s.node.className ? "." + String(s.node.className).split(" ")[0] : "") : "(detached)",
          inKatex: !!(s.node && s.node.closest && s.node.closest(".katex")),
          text: s.node && s.node.textContent ? s.node.textContent.slice(0, 60) : ""
        }))
      });
    }
  }).observe({ type: "layout-shift", buffered: true });
`;

const shifts = (page) =>
  page.evaluate(() => {
    const sum = (list) => list.reduce((total, s) => total + s.value, 0);
    const entries = window.__shifts || [];
    return {
      value: sum(entries),
      katexAttributed: sum(entries.filter((s) => s.sources.some((x) => x.inKatex))),
      entries
    };
  });

// Every entry counts, including the ones Chromium marks hadRecentInput. Dropping those would be
// correct for a real-world CLS number and fatal here: Chromium marks any shift within 500ms of a
// discrete input as input-caused, and this reader is navigated by clicking, so a suite that clicks
// through to the lesson and then measures would exclude the shift it exists to find.
const expectNoLayoutShift = async (page, what) => {
  const measured = await shifts(page);
  return expect(
    measured.value,
    `${what}: the lesson route shifted by CLS ${measured.value}` +
      ` (math-sourced ${measured.katexAttributed}; RC §7 budgets CLS = 0 for math/figures); ` +
      `entries ${JSON.stringify(measured.entries, null, 2)}`
  ).toBe(0);
};

// The page must be still, and it must stay still. Asserted with a fixed wait rather than a font
// event because "no shift for this long" is the only statement available that does not presuppose
// the answer.
const expectSettled = async (page, what) => {
  await page.waitForTimeout(1_200);
  return expectNoLayoutShift(page, what);
};

// The lesson this suite measures.
//
// m1-l1 is chosen for a reason that is the whole mechanism: MathBlock renders a block-mode
// paragraph by trying the entire string as one LaTeX expression first (web/src/lib/latex.js), and a
// paragraph of prose with no `$` in it parses, so the paragraph comes back as a *single* `.katex
// .base` box. A box that is a paragraph rather than an inline fragment is what turns a face swap
// into page movement: KaTeX_Main is narrower and shorter than the fallback, so that box changes
// width and height and every section below it moves with it. A lesson whose math is only inline
// fragments resizes without moving anything and would report CLS 0 with the defect fully present.
const MODULE_ID = "M1";
const LESSON_ID = "m1-l1";

// Navigate the real reader: module list -> module -> lesson. The reader keeps its place in state
// rather than the URL, so the buttons have to be clicked, and they are located by index resolved
// from the API rather than by title text — a corpus retitle should not be a red layout test, and a
// locator that quietly matches nothing is how that happens.
async function openLesson(page, request) {
  const modules = await (await request.get("/api/modules")).json();
  const moduleIndex = modules.findIndex((m) => m.id === MODULE_ID);
  expect(moduleIndex, `${MODULE_ID} is in the corpus`).toBeGreaterThanOrEqual(0);
  const lessons = (await (await request.get(`/api/modules/${MODULE_ID}`)).json()).lessons;
  const lessonIndex = lessons.findIndex((l) => l.id === LESSON_ID);
  expect(lessonIndex, `${LESSON_ID} is in ${MODULE_ID}`).toBeGreaterThanOrEqual(0);

  await page.addInitScript(OBSERVER);
  // domcontentloaded, not load: test 2 parks the font responses, and a parked font is also a parked
  // <link rel="preload">, so waiting for `load` would wait on a resource the test itself is holding
  // back. The reader's own readiness is asserted by the clicks below.
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator(".modules button").nth(moduleIndex).click();
  await page.locator(".lessons button").nth(lessonIndex).click();
  await expect(page.locator(".katex").first()).toBeVisible();
}

// Proof that the lesson rendered formulas, so a CLS 0 is a measurement of math rather than a
// measurement of an empty page — and proof that it rendered a *paragraph* as one math box, because
// that is the shape whose resize moves the page.
const expectMathRendered = async (page) => {
  const rendered = await page.evaluate(() => {
    const widths = Array.from(document.querySelectorAll(".katex .base"), (el) =>
      el.getBoundingClientRect().width
    );
    return {
      katexSpans: document.querySelectorAll(".katex").length,
      bases: widths.length,
      widestBase: widths.length ? Math.max(...widths) : 0
    };
  });
  expect(rendered.katexSpans, "the lesson rendered formulas").toBeGreaterThan(0);
  expect(rendered.bases, "the lesson rendered formula bodies").toBeGreaterThan(0);
  expect(
    rendered.widestBase,
    "the lesson typesets a whole paragraph as one math box, which is the shape that reflows the page"
  ).toBeGreaterThan(300);
  return rendered;
};

const rectOf = (locator) =>
  locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  });

// Which KaTeX faces the page declared and which of them are loaded. This is the guard against the
// cheapest way to make a layout-shift test green, which is to delete the webfonts.
const fontReport = (page) =>
  page.evaluate(() =>
    Array.from(document.fonts).map((f) => ({
      family: f.family,
      weight: f.weight,
      style: f.style,
      status: f.status
    }))
  );

test.describe("KaTeX webfonts settle before first paint", () => {
  test("the lesson route settles at CLS 0 and still uses the real KaTeX faces", async ({ page, request }) => {
    await openLesson(page, request);
    await expectMathRendered(page);
    await expectSettled(page, "after load");

    const faces = (await fontReport(page)).filter((f) => f.family.startsWith("KaTeX"));
    expect(faces.length, `KaTeX declares its faces on the page (${JSON.stringify(faces)})`).toBeGreaterThan(0);
    expect(
      faces.filter((f) => f.status === "loaded").length,
      "the faces the lesson needs are loaded, not avoided"
    ).toBeGreaterThan(0);
  });

  test("a face that arrives after first paint costs nothing", async ({ page, request }) => {
    // Every KaTeX font response is parked on a promise this test opens by hand, so "before the faces
    // arrive" and "after they arrive" are steps rather than intervals whose length is the network's
    // business.
    let release;
    const parked = new Promise((resolve) => {
      release = resolve;
    });
    let parkedCount = 0;
    await page.route(/KaTeX_.*\.woff2$/, async (route) => {
      parkedCount += 1;
      await parked;
      await route.continue();
    });

    await openLesson(page, request);
    await expectMathRendered(page);

    // Every formula is laid out in the fallback serif right now, because none of the faces has
    // arrived.
    await expectSettled(page, "with every KaTeX face still in flight");
    const before = await rectOf(page.locator(".katex .base").first());

    release();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1_500);

    expect(
      parkedCount,
      "the fixture actually withheld at least one KaTeX face, so the test measured something"
    ).toBeGreaterThan(0);

    // Geometry first, then the score. A box that changed shape and happened to score 0 would be a
    // different regression, and CLS alone cannot tell a reader which one they are looking at.
    const after = await rectOf(page.locator(".katex .base").first());
    expect(
      after,
      "the formula body occupies the same box with and without the webfont"
    ).toEqual(before);

    await expectNoLayoutShift(page, "after the parked faces finally arrived");
  });
});