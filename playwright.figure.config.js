// The figure browser suite — RC §5.4 items 1, 2 and 5 — in its own config because it needs its own
// server and main's config is not a template it can be run under.
//
// The two browser suites make claims that require different servers, and running either against the
// other's server reports the wrong number rather than an error:
//
//   this suite  needs the dev server, proxying /api and /artifacts to e2e/fixture-api.mjs, because
//               the claim is figure geometry and the fixture states a declared 4:1 box against a
//               1:1 SVG — one file, no Asymptote, no artifacts/, and the disagreement is the test
//   math-layout needs the production build, served by `vite preview`, because `vite build` is what
//               turns the KaTeX @font-face urls into the requests a reader makes. Under a dev server
//               those faces come from node_modules filesystem paths, so the run would assert about
//               requests no reader makes — and in a shared-node_modules worktree it measures a 404,
//               which is a page stuck in the fallback that reports CLS 0 for the wrong reason
//
// So each config names its own spec files and the two scripts run them separately (npm run test:e2e,
// npm run test:e2e:figure). A new spec file therefore has to pick a config rather than being picked
// up by whichever server happens to be configured — a silent run against the wrong server is exactly
// the failure this split exists to make impossible.
//
// The measure is Cumulative Layout Shift from PerformanceObserver('layout-shift'), which is the
// number RC §7 budgets and the one a reader feels. Two budgets are asserted from the same run,
// because two documents budget two different things, and they are deliberately separate assertions
// rather than one number with two names:
//
//   figure CLS = 0        RC §5.4 item 5 ("CLS contribution from a figure is 0 in both states")
//                          and RC §7 ("Layout shift from math/figures | CLS = 0"), measured over the
//                          window in which the figure arrives
//   page CLS   < 0.05     Lesson spec §9 #6, over the whole run
//
// The split is not a way to make the figure number easier to pass, and the suite carries the
// assertions that close the obvious ways to abuse it. See e2e/figure-reservation.spec.js for the
// full argument; the short version is that a figure-scoped "CLS inside .figure" metric is useless
// (when a box grows, what moves is everything *below* it, so it scores 0 for an implementation that
// moves the page by 350px), while a blanket total=0 charges the figure for the reader's webfont
// loading. So the figure's own contribution is asserted at 0 over the arrival window, no shift
// anywhere in the run is allowed to have a source inside a figure box, and the box's own geometry is
// asserted before and after the load.
//
// The test navigates the real reader (module list -> module -> lesson), so what is measured is the
// lesson route rather than a hand-built page that happens to include Figure.

import { defineConfig, devices } from "@playwright/test";

const API_PORT = Number(process.env.E2E_API_PORT || 4183);
const WEB_PORT = Number(process.env.E2E_WEB_PORT || 5183);

export default defineConfig({
  testDir: "./e2e",
  testMatch: /figure-reservation\.spec\.js$/,
  // One worker: the suite shares one fixture API and one fixture corpus through the filesystem, and a
  // second worker racing the same SVG file would turn a layout assertion into a flake report.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure"
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // The API, against the fixture corpus rather than content/, so the figure's declared ratio
      // and the SVG's real ratio are stated in one file instead of depending on a local build.
      command: "node e2e/fixture-api.mjs",
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      env: { E2E_API_PORT: String(API_PORT) }
    },
    {
      // The dev server, proxying /api and /artifacts to the fixture API. Vite rather than a build
      // plus a static server: the claim under test is about layout, and a build step that can fail
      // for unrelated reasons only adds ways for the run to be red without saying anything about
      // layout shift.
      // 127.0.0.1 rather than localhost: vite's default host resolves to ::1 first on this runner
      // and the readiness poll is against the IPv4 loopback, so the check times out against a
      // server that is actually up.
      command: "npm run dev --workspace web -- --strictPort --host 127.0.0.1",
      url: `http://127.0.0.1:${WEB_PORT}/`,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
      env: { API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`, WEB_PORT: String(WEB_PORT) }
    }
  ]
});
