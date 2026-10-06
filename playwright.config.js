// The browser suite. It exists for one claim — RC §7's "Layout shift from math/figures | CLS = 0",
// for the math half — and everything here is arranged to make that assertion possible rather than to
// be a general end-to-end suite.
//
// The measure is Cumulative Layout Shift from PerformanceObserver('layout-shift'), which is the
// number RC §7 budgets and the one a reader feels. e2e/math-font-settle.spec.js navigates the real
// reader (module list -> module -> lesson) against the shipped corpus, so what is measured is the
// lesson route rather than a hand-built page that happens to contain some math.
//
// The suite serves the production build rather than the dev server, which is the opposite of what
// MAX-72's figure suite does and is load-bearing here. The claim is about when a webfont arrives,
// and the build is where that is decided: `vite build` rewrites every KaTeX @font-face url to a
// hashed asset in dist/assets, which is what a reader downloads. Under the dev server those same
// faces are served out of node_modules at filesystem paths, so a suite run there measures a
// different set of requests than the one that ships — and in a worktree whose node_modules is a
// shared symlink it measures a 404, which is a page that renders in the fallback forever and
// therefore reports CLS 0 for the wrong reason.
//
// The API runs on the port web/vite.config.js proxies to, which is why there is no API_PORT here.
//
// MAX-72's figure suite is a second browser suite needing the opposite server — a dev server against
// a fixture API rather than a preview server against the shipped one — so it has its own config,
// playwright.figure.config.js. testMatch below names this config's spec files rather than every
// *.spec.js under e2e/, because a suite run against the other suite's server reports the wrong
// number rather than failing. See that file for the argument; `npm run test:e2e:all` runs both.

import { defineConfig, devices } from "@playwright/test";

const WEB_PORT = Number(process.env.E2E_WEB_PORT || 5184);

export default defineConfig({
  testDir: "./e2e",
  testMatch: /math-font-settle\.spec\.js$/,
  // One worker: the suite shares one preview server and one API, and a second worker racing the
  // same ports would turn a layout assertion into a flake report.
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
      command: "npm run dev:api",
      url: "http://127.0.0.1:4000/api/health",
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000
    },
    {
      // Build, then serve the build. The build step is part of the measurement rather than a way
      // for the run to go red: it is what turns the @font-face urls into the requests a reader
      // makes, and a suite that skipped it would be asserting about the dev server's font paths.
      // 127.0.0.1 rather than localhost: vite's default host resolves to ::1 first on this runner
      // and the readiness poll is against the IPv4 loopback, so the check times out against a
      // server that is actually up.
      command:
        `npm run build --workspace web && ` +
        `npm run preview --workspace web -- --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}/`,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000
    }
  ]
});