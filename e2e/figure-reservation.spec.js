// RC §5.4 items 1, 2 and 5, asserted in a browser. They are only observable in one, and before this
// suite the repository had no browser test at all — RC §7 names the instrument ("Asserted in a
// Playwright check on one lesson per module") and there was nothing to run it with.
//
// The figure has two arrivals, and the test owns both of them. The payload (the manifest entry) is
// what turns a placeholder into a figure; the SVG (the bytes) is what lets the browser measure
// anything. page.route() handlers are parked on promises the test opens by hand, so "before the
// payload arrives" and "before the SVG arrives" are steps rather than intervals whose length is the
// network's business. The second is the one that matters: an implementation which resized the box in
// onLoad (what MAX-72 removed) is indistinguishable from a correct one until the SVG is deliberately
// made late.
//
// The fixture is a figure whose authored ratio (4:1) and whose SVG's intrinsic ratio (1:1) disagree
// by 300%; see e2e/fixtures/figure-fixture.mjs. Every assertion below is chosen to fail loudly if the
// reservation is absent, if it is applied too late, or if anything about the load resizes the box.

import { expect, test } from "@playwright/test";

import { AUTHORED_ASPECT_RATIO, FIGURE_KEY, SVG_INTRINSIC_RATIO } from "./fixtures/figure-fixture.mjs";

// Cumulative Layout Shift, split by whether the shifted element is inside a figure box.
//
// Installed before any page script runs, and buffered, because a shift that happened before the
// observer existed is one the measurement silently misses — which is how a suite reports CLS 0 on a
// page that moved. `sources` are kept because they are what distinguishes a figure shift from a
// webfont swap, and RC §5.4 item 5 is a claim about figures.
const OBSERVER = `
  window.__shifts = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      window.__shifts.push({
        value: entry.value,
        hadRecentInput: entry.hadRecentInput,
        sources: (entry.sources || []).map((s) => ({
          node: s.node ? (s.node.nodeName || "?") + (s.node.className ? "." + String(s.node.className).split(" ")[0] : "") : "(detached)",
          insideFigure: !!(s.node && s.node.closest && s.node.closest(".figure"))
        }))
      });
    }
  }).observe({ type: "layout-shift", buffered: true });
`;

// The instrument: Cumulative Layout Shift from PerformanceObserver('layout-shift'), which is the
// number RC §7 budgets and the one a reader feels.
//
// Installed before any page script runs, and buffered, because a shift that happened before the
// observer existed is one the measurement silently misses — which is how a suite reports CLS 0 on a
// page that moved.
//
// The claim asserted is total CLS = 0 over the whole lesson route, for three reasons that each cost a
// plausible-sounding narrowing:
//
//   * "CLS < 0.05" (Lesson spec §9 #6) is satisfied by 0, and asserting the smaller bound would be
//     asserting less than RC §7 already requires. The looser number is reported in the failure
//     message so a regression is legible against both documents' budgets.
//
//   * Scoping to "shifts whose sources are inside a figure box" looks like the figure's own number
//     and is not. When a box grows, what moves is everything *below* it — the measured sources on
//     the failing-before run were the two <section class="lesson-section"> elements under the figure,
//     not anything inside it. A figure-scoped metric scores 0 for an implementation that moves the
//     page by 350px, which is the one thing this test exists to catch. So which sources were inside a
//     figure is carried in the failure message as diagnosis, not used as the budget.
//
//   * Dropping entries with hadRecentInput is correct for CLS and fatal for this test. Chromium marks
//     any shift within 500ms of a discrete input as input-caused, and a test that clicks through the
//     reader and then measures excludes the figure's shift for exactly that reason: the run that
//     found this recorded a 0.069 shift on a page whose box had grown by 350px, reported as 0. The
//     tests therefore wait the page out before letting the figure arrive (settle), assert that the
//     page has settled at that point, and then count every entry.
//
//   * What "the page has settled" has to mean is *no further shift for a while*, not a fixed number
//     of milliseconds -- and the difference is not a nicety, it was the whole of the first red run.
//     The reader typesets prose with KaTeX, whose ~19 webfonts are requested lazily as each formula
//     renders. Until they arrive, every formula is laid out in the fallback face, and the swap
//     re-lays the prose out: the measured shift was CLS 0.00011 on a <span class="base"> inside
//     <span class="katex-html">, its box going 341x26 -> 311x24 as KaTeX_Main loaded. A 750ms wait
//     does not outlast that -- the swap landed at ~500ms -- so the figure arrived while the prose was
//     still reflowing and every assertion below failed on a shift that had nothing to do with
//     figures, in a run whose figure behaviour was correct.
//
//     It is also not the figure's shift to answer for. A webfont swap is a real shift on the same
//     page (playwright.config.js says so) and RC §7's row is "Layout shift from math/figures", not
//     "every byte of KaTeX's font loading". So the settle puts the swap behind the baseline and the
//     assertions below measure the window in which the figure arrives. The swap is not hidden by
//     that: expectNoFigureShift asserts, over the *whole run* including everything before the
//     settle, that no recorded shift has a source inside a figure box, and the pre-settle number is
//     printed on every failure. The KaTeX swap as a page-level shift is MAX-142's subject.
// The reader has finished rendering before anything figure-shaped is released. Two numbers come
// back and they are not the same claim:
//
//   sinceMark   CLS recorded *after* the settle -- the window in which the figure arrives. This is
//               the figure's contribution and it is budgeted at 0, because RC §5.4 item 5 states it
//               as a number and RC §7 budgets layout shift from math/figures at 0.
//   value       CLS over the whole run. The pre-settle part of it is the page's own -- KaTeX's font
//               swap, on this fixture CLS 0.00011 -- and is budgeted against the Lesson spec §9 #6
//               page budget rather than held at 0, because a webfont swap in the prose is not this
//               suite's subject and pretending otherwise would make a figure assertion mean
//               something weaker. That residual is MAX-142's to remove; when it is gone the number
//               this suite reports stops being non-zero without anything here changing.
const shifts = (page) =>
  page.evaluate(() => {
    const sum = (list) => list.reduce((total, s) => total + s.value, 0);
    const entries = window.__shifts;
    const mark = window.__figureMark ?? 0;
    return {
      value: sum(entries),
      sinceMark: sum(entries.slice(mark)),
      figureAttributed: sum(entries.filter((s) => s.sources.some((x) => x.insideFigure))),
      entries
    };
  });

const NO_SHIFT = { timeout: 5_000 };

// How long the observer must see nothing before the page counts as settled. Comfortably longer than
// Chromium's 500ms input window, because a shift inside that window is excluded from the CLS metric
// anyway and this suite counts every entry regardless; and comfortably longer than the ~500ms the
// KaTeX swap above took, for the same reason.
const QUIET_MS = 1_200;

// Wait for the page to stop moving, rather than for a duration to elapse, and mark where it stopped.
//
// The entry count is polled rather than diffed: the observer is buffered and fires on the browser's
// own schedule, so "the same number for QUIET_MS" is the only statement available from Node that
// means "no further shift". A page that never settles has to fail rather than hang, hence the
// deadline -- and on that deadline the callers' own assertions report the entries, which is the
// diagnosis worth having.
//
// The mark is written into the page rather than returned, because the figure assertions below run
// from several different places and re-deriving "which entries are the figure's" from a Node-side
// index is exactly the kind of arithmetic that is wrong once and stays wrong.
const settle = async (page) => {
  const deadline = Date.now() + 20_000;
  let last = null;
  let quietSince = Date.now();
  for (;;) {
    const { count } = await page.evaluate(() => window.__shifts.length);
    if (count !== last) {
      last = count;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= QUIET_MS) {
      break;
    }
    if (Date.now() > deadline) break;
    await page.waitForTimeout(50);
  }
  return page.evaluate(() => {
    window.__figureMark = window.__shifts.length;
  });
};

// RC §5.4 item 5, exactly: the figure's own contribution is 0 in both states. Measured over the
// window in which the figure arrived, which is the whole of what this suite gates open.
//
// This is not a narrowed budget dressed up as a strict one. The figure's contribution is 0 whether
// it is measured over the window or over the run -- a box that grew by 350px is recorded either way,
// and expectNoFigureShift below reads the entire run regardless of where the mark fell. What the
// window buys is that a shift the figure provably did not cause is reported against the document that
// budgets it, instead of being counted as the figure's.
const expectNoLayoutShift = async (page, what) => {
  const measured = await shifts(page);
  return expect(
    measured.sinceMark,
    `${what}: the figure shifted the lesson route by CLS ${measured.sinceMark} once it arrived ` +
      `(figure-sourced ${measured.figureAttributed}; RC §7 budgets layout shift from math/figures at 0; ` +
      `route total including the pre-settle typesetter swap ${measured.value}); ` +
      `entries ${JSON.stringify(measured.entries, null, 2)}`
  ).toBe(0);
};

// The page budget, over the whole run. This is Lesson spec §9 #6's number and it is asserted
// separately rather than folded into the figure's, so that the figure's stays at 0 and the page's is
// visibly a different claim. On today's fixture the page total is the KaTeX font swap alone
// (~0.00011 against a 0.05 budget); if this assertion is what went red, the reader typesetting is
// what moved, and MAX-142 is where that is fixed.
const expectPageWithinBudget = async (page, what) => {
  const { value, sinceMark, figureAttributed } = await shifts(page);
  return expect(
    value,
    `${what}: the lesson route shifted by CLS ${value} over the whole run ` +
      `(${sinceMark} of it after the figure arrived, ${figureAttributed} of it figure-sourced); ` +
      `Lesson spec §9 #6 budgets a lesson route at < 0.05`
  ).toBeLessThan(0.05);
};

// RC §5.4 item 5 over the whole run, not only the measurement window.
//
// This is the assertion that the mark cannot be used to hide a figure. It reads every entry the
// observer has ever recorded -- before the settle, during it, and after the figure arrives -- so a
// box that resized itself, appeared, or grew by 350px cannot be argued away by the timing of when
// this assertion ran. A growing box names the elements it pushed rather than anything inside
// itself, which is why the total stays a budget too; this one is here so that the settle is not a
// place a figure could hide.
//
// It is deliberately not a budget: a figure shift is a figure shift at any magnitude. The number
// only goes in the message, because the number says whether this was one span or the whole lesson.
const expectNoFigureShift = async (page, what) => {
  const { figureAttributed, value, entries } = await shifts(page);
  return expect(
    figureAttributed,
    `${what}: a shift on the lesson route had a source inside a figure box ` +
      `(figure-sourced CLS ${figureAttributed}, route total ${value}); ` +
      `entries ${JSON.stringify(entries, null, 2)}`
  ).toBe(0);
};

// The box element itself. Asserted with a named failure because its absence *is* the regression this
// suite was written for, and Playwright's default "waiting for locator" timeout would turn the most
// informative failure in the file into a 60-second wait for a div that was never going to appear.
const box = (page) => page.locator(".figure__box");

const expectBox = async (page) => {
  await expect(
    box(page),
    "the reserved box is an element (.figure__box) sized by aspect-ratio — RC §5.4 item 1"
  ).toHaveCount(1, NO_SHIFT);
  return box(page).first();
};

// The box's content box, which is what an absolutely positioned child at inset:0 with width and
// height 100% actually fills: clientWidth/clientHeight exclude the border, getBoundingClientRect
// does not. Comparing a child's painted box to the wrong one of those two is how "the image fills the
// box" passes by two pixels and means nothing.
//
// `shape` is the assertion that matters, stated as a ratio rather than a height: the box has the
// authored shape, however wide the lesson column is and whether or not the box carries a border.
const content = (page) =>
  box(page)
    .first()
    .evaluate((el) => ({
      width: el.clientWidth,
      height: el.clientHeight,
      shape: el.clientWidth ? el.clientHeight / el.clientWidth : 0
    }), NO_SHIFT);

const expectAuthoredShape = async (page, ratio) =>
  expect((await content(page)).shape, `the reserved box has the authored ${ratio}:1 shape`).toBeCloseTo(
    1 / ratio,
    1
  );

// A promise the test resolves by hand.
const gate = () => {
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
};

// The real reader: module list, then the module, then the lesson. Not a hand-built page that happens
// to include Figure — RC §5.4 is about the lesson route, and a fixture page would be measuring a
// layout the product does not have.
const openLesson = async (page) => {
  await page.goto("/");
  await page.getByRole("button", { name: /e2e fixture module/i }).click();
  await page.getByRole("button", { name: /a lesson with one square figure/i }).click();
};

test.describe("the no-reflow contract for figures (Rendering Conventions §5.4)", () => {
  test("a figure's arrival causes no layout shift on the lesson route", async ({ page }) => {
    // The headline assertion, and deliberately the first one: it is written against selectors that
    // exist both before and after the fix (.figure, .figure__svg), so it fails with a CLS number
    // rather than with a missing element. The tests below assert the geometry, and they need the
    // elements the fix introduced.
    await page.addInitScript(OBSERVER);

    const payload = gate();
    const svg = gate();
    await page.route("**/api/figures/**", async (route) => {
      await payload.opened;
      await route.continue();
    });
    await page.route("**/artifacts/figures/svg/*", async (route) => {
      await svg.opened;
      await route.continue();
    });

    await openLesson(page);
    await expect(page.locator(".figure")).toHaveCount(1);

    const before = await page.locator(".figure").first().boundingBox();
    // Nothing may move until the page has settled -- which is a measurement of the page, not a
    // duration; see settle() for why, and for what it is waiting out.
    await settle(page);
    expect(
      (await shifts(page)).sinceMark,
      "the lesson settled before the figure arrived, so every shift after this is the figure's"
    ).toBe(0);

    payload.open();
    await expect(page.locator(".figure__svg")).toHaveCount(1);
    svg.open();
    // The figure has bytes and the browser has decoded them: onLoad has run, which is where the old
    // implementation replaced the reservation with the measurement. Waiting on the component's own
    // post-load attribute rather than on a timeout is what makes this a statement about the state
    // after the load rather than about the load.
    await expect(page.locator(".figure__svg")).toHaveAttribute("data-figure-ratio-drift", /./, NO_SHIFT);
    const after = await page.locator(".figure").first().boundingBox();

    // CLS first, and the box height second, so that when this fails it fails with the number the
    // documents budget rather than with a second measurement of the same defect.
    await expectNoLayoutShift(page, "a figure arriving");
    await expectNoFigureShift(page, "a figure arriving");
    await expectPageWithinBudget(page, "a figure arriving");

    // The same claim without a CLS budget in the way: the box the reader was looking at before the
    // SVG is the box they are looking at after it.
    expect(
      after.height,
      `the figure box changed height when the SVG arrived (${before.height} -> ${after.height})`
    ).toBeCloseTo(before.height, 0);
  });

  test("the box is reserved from the authored ratio before the payload arrives", async ({ page }) => {
    await page.addInitScript(OBSERVER);

    const payload = gate();
    const svg = gate();
    await page.route("**/api/figures/**", async (route) => {
      await payload.opened;
      await route.continue();
    });
    await page.route("**/artifacts/figures/svg/*", async (route) => {
      await svg.opened;
      await route.continue();
    });

    await openLesson(page);

    // --- state 1: the payload has not arrived -----------------------------------------------
    await expect(page.locator(".figure--pending")).toHaveCount(1);
    const reserved = await (await expectBox(page)).boundingBox();
    expect(reserved.height, "the reserved box has height before anything has loaded").toBeGreaterThan(0);

    // §5.4 item 1, the whole of it: sized from the authored ratio, and painted as a sunken surface
    // rather than as a hole.
    await expectAuthoredShape(page, AUTHORED_ASPECT_RATIO);
    const sunken = await box(page).first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(sunken, "the reserved box is painted with --surface-sunken").toBe("rgb(246, 247, 249)");

    // §5.4 item 3, first clause: no skeleton spinner that resizes, nothing inside the box yet. The
    // claim is that the box is empty, so it is asserted as a child count: a selector union also
    // reports matches against detached or invisible nodes.
    expect(await box(page).first().evaluate((el) => el.children.length), "nothing is inside the box yet").toBe(0);

    // --- state 2: the payload has arrived, the SVG has not -----------------------------------
    // Nothing between here and the end of the test may be an input-attributed shift, so the reader's
    // own clicks have to be out of Chromium's 500ms window before anything is released.
    await settle(page);
    payload.open();
    const img = page.locator(".figure__svg");
    await expect(img).toHaveCount(1, NO_SHIFT);
    expect(await img.evaluate((el) => el.complete, NO_SHIFT), "the SVG has not loaded yet").toBe(false);

    // The box is the same box. This is where an implementation that took the box's shape from the
    // payload would already be halfway to failing: the payload carries compiledAspectRatio 1, and
    // applying it here would make the box square.
    const withImg = await (await expectBox(page)).boundingBox();
    expect(withImg.height, "the box did not change when the payload arrived").toBeCloseTo(
      reserved.height,
      0
    );
    await expectAuthoredShape(page, AUTHORED_ASPECT_RATIO);

    // §5.4 item 2: the <img> is absolutely positioned and fills the box, so it contributes no
    // dimension of its own even while it has nothing to paint.
    const before = await img.evaluate(
      (el) => {
        const style = getComputedStyle(el);
        return { position: style.position, objectFit: style.objectFit, rect: el.getBoundingClientRect() };
      },
      NO_SHIFT
    );
    expect(before.position, "§5.4 item 2: absolutely positioned").toBe("absolute");
    expect(before.objectFit, "§5.4 item 2: object-fit contain").toBe("contain");
    const filled = await content(page);
    expect(
      before.rect.width,
      "the <img> fills the reserved box before it has any bytes"
    ).toBeCloseTo(filled.width, 0);
    expect(before.rect.height).toBeCloseTo(filled.height, 0);

    // --- state 3: the SVG has arrived -------------------------------------------------------
    svg.open();
    await expect(img).toHaveAttribute("data-figure-ratio", String(AUTHORED_ASPECT_RATIO), NO_SHIFT);
    await expect(img).toHaveAttribute("data-figure-ratio-drift", /reserved-vs-measured/, NO_SHIFT);

    const loaded = await (await expectBox(page)).boundingBox();
    expect(loaded.height, "the box did not change when the SVG arrived").toBeCloseTo(reserved.height, 0);
    await expectAuthoredShape(page, AUTHORED_ASPECT_RATIO);

    const after = await img.evaluate(
      (el) => ({
        rect: el.getBoundingClientRect(),
        natural: { width: el.naturalWidth, height: el.naturalHeight }
      }),
      NO_SHIFT
    );
    expect(after.natural, "the fixture's SVG really is square").toEqual({ width: 400, height: 400 });

    // The <img>'s own box is still exactly the box's content box after the load. Combined with the
    // 1:1 intrinsic size and `object-fit: contain`, that is the no-distortion property: the element
    // box is 4:1 and the picture inside it is 1:1, so contain letterboxes it — painted at the box's
    // height, centred — instead of stretching it across the full width. The element rect is not
    // itself evidence of that (object-fit changes how content is painted inside the element, not the
    // element's box), which is why the computed object-fit is asserted rather than inferred from a
    // measurement that cannot see it.
    const painted = await content(page);
    expect(
      after.rect.width,
      "the <img> is the box, not something laid out beside it"
    ).toBeCloseTo(painted.width, 0);
    expect(after.rect.height).toBeCloseTo(painted.height, 0);
    expect(after.rect.width / after.rect.height).toBeCloseTo(AUTHORED_ASPECT_RATIO, 1);

    // The disagreement is reported rather than applied, and it is not a rounding artefact: the
    // authored ratio is 4:1, the compiler measured 1:1, and the browser measured 1:1.
    const drift = await img.getAttribute("data-figure-ratio-drift");
    expect(drift).toContain(`reserved-vs-measured:${AUTHORED_ASPECT_RATIO}->${SVG_INTRINSIC_RATIO}`);
    expect(drift).toContain(`declared-vs-compiled:${AUTHORED_ASPECT_RATIO}->${SVG_INTRINSIC_RATIO}`);

    await expectNoLayoutShift(page, "a figure arriving");
    await expectNoFigureShift(page, "a figure arriving");
    await expectPageWithinBudget(page, "a figure arriving");
  });

  test("a figure whose payload fails keeps its reserved size and still shifts nothing", async ({ page }) => {
    // RC §5.4 item 5 says "in both states", and §5.6 says the degraded state keeps the box size. The
    // reservation has to be a property of the reference rather than of a successful payload, or a
    // 503 collapses the box and the lesson reflows under the reader for a reason they cannot act on.
    await page.addInitScript(OBSERVER);

    // The failure is held rather than answered immediately, for the same reason the other tests hold
    // their routes: a 503 that lands inside the reader's click window would be measured as an
    // input-attributed shift and excluded, which would make this test pass for an implementation that
    // reflows the lesson when a figure cannot be built.
    const payload = gate();
    await page.route("**/api/figures/**", async (route) => {
      await payload.opened;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "toolchain-missing", status: "toolchain-missing" })
      });
    });

    await openLesson(page);
    await expect(page.locator(".figure--pending")).toHaveCount(1);
    await settle(page);
    payload.open();

    await expect(page.locator(".figure--unavailable")).toHaveCount(1);
    await expectBox(page);
    await expectAuthoredShape(page, AUTHORED_ASPECT_RATIO);
    // §5.6: the degraded state is visibly degraded, so the placeholder is on the page for everyone.
    await expect(page.locator(".figure__placeholder")).toBeVisible();

    await expectNoLayoutShift(page, "a figure whose payload failed");
    await expectNoFigureShift(page, "a figure whose payload failed");
    await expectPageWithinBudget(page, "a figure whose payload failed");
  });
});

test("the figure the fixture serves is the one the lesson reserved from", async ({ request }) => {
  // A guard on the guard. CLS 0 is also what you measure if the lesson never rendered a figure at
  // all, so the payload's shape is asserted directly: the fixture must disagree with itself by 300%,
  // because that disagreement is what makes the box mutation visible in the tests above.
  const payload = await request.get(`/api/figures/${encodeURIComponent(FIGURE_KEY)}`);
  expect(payload.status()).toBe(200);
  const body = await payload.json();
  expect(body.declaredAspectRatio).toBe(AUTHORED_ASPECT_RATIO);
  expect(body.compiledAspectRatio).toBe(SVG_INTRINSIC_RATIO);
});

test("the lesson reserves from a ratio the lesson response carries, not from the figure route", async ({
  request
}) => {
  // The reservation cannot come from the figure route: it has not answered yet, at first paint. So
  // the reference has to carry the authored ratio, and this is the assertion that keeps that true
  // rather than leaving it to a comment.
  const lesson = await request.get(`/api/lessons/e2e-l1`);
  expect(lesson.status()).toBe(200);
  const figures = (await lesson.json()).sections.concept.figures;
  expect(figures).toHaveLength(1);
  expect(figures[0].figureKey).toBe(FIGURE_KEY);
  expect(figures[0].asymptoteAspectRatio).toBe(AUTHORED_ASPECT_RATIO);
});