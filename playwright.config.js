// The browser suite. It exists for one assertion — RC §5.4 items 1, 2 and 5, which are only
// observable in a real browser — and everything here is arranged to make that assertion possible
// rather than to be a general end-to-end suite.
//
// The measure is Cumulative Layout Shift from PerformanceObserver('layout-shift'), which is the
// number RC §7 budgets and the one a reader feels. Two numbers are asserted from the same run,
// because two documents budget two different things:
//
//   figure CLS = 0        RC §5.4 item 5 ("CLS contribution from a figure is 0 in both states")
//                          and RC §7 ("Layout shift from math/figures | CLS = 0")
//   page CLS   < 0.05     Lesson spec §9 #6
//
// Splitting them is not a way to make the figure number easier to pass. Layout-shift entries name
// their sources, so a figure entry is one whose sources are inside a figure box — a shift caused by a
// webfont swapping is a real shift on the same page and is not the figure's to answer for, and
// attributing it to the figure would make the figure assertion mean something weaker.
//
// The test navigates the real reader (module list -> module -> lesson), so what is measured is the
// lesson route rather than a hand-built page that happens to include Figure.

import { defineConfig, devices } from "@playwright/test";

const API_PORT = Number(process.env.E2E_API_PORT || 4183);
const WEB_PORT = Number(process.env.E2E_WEB_PORT || 5183);

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.js/,
  // One worker: the suite shares a fixture API and a fixture corpus through the filesystem, and a
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
      // and the readiness poll is against the IPv4 loopback, so the check times out against a server
      // that is actually up.
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