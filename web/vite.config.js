import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import katexFontDisplay from "./vite-katex-font-display.js";

// The API target for the preview server, which is what the browser suite (RC §7's math half of
// "Layout shift from math/figures | CLS = 0") runs against. `vite build` rewrites every KaTeX
// @font-face url to a hashed asset under dist/assets, so the claim that math settles before first
// paint is only observable against the build rather than the dev server — see e2e/.
//
// The default is the port api/src/index.js listens on, so nothing has to set this to serve the built
// app locally.
const apiTarget = process.env.API_PROXY_TARGET || "http://localhost:4000";

export default defineConfig({
  plugins: [react(), katexFontDisplay()],
  server: {
    proxy: { "/api": "http://localhost:4000" }
  },
  preview: {
    proxy: { "/api": apiTarget }
  }
});