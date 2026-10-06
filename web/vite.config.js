import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import katexFontDisplay from "./vite-katex-font-display.js";

// The API target for both the dev server and the preview server. `vite build` rewrites every KaTeX
// @font-face url to a hashed asset under dist/assets, so the claim that math settles before first
// paint is only observable against the build rather than the dev server — see e2e/.
//
// The default is the port api/src/index.js listens on, so nothing has to set this to serve the built
// app locally. Both servers read it, deliberately: the two browser suites each boot their own API
// on their own port and point their server at it this way, and a dev server that hard-coded 4000
// could not be aimed at the figure suite's fixture API at all.
//
// /artifacts is here for the same reason /api is: the compiled SVGs are served by the API out of the
// build output, not out of web/public, so without this every figure 404s in dev and the figure work
// can only be verified against a production build.
const apiTarget = process.env.API_PROXY_TARGET || "http://localhost:4000";

// WEB_PORT is read by both servers so a harness can run a second instance on another port without
// editing this file; strictPort is what turns "the port was taken" into a failed run rather than a
// silent fall-through to 5174, which for a layout suite would mean measuring the wrong server. The
// suites also pass --port on the command line, and the command line wins.
const port = Number(process.env.WEB_PORT || 5173);
const proxy = { "/api": apiTarget, "/artifacts": apiTarget };

export default defineConfig({
  plugins: [react(), katexFontDisplay()],
  server: { port, strictPort: true, proxy },
  preview: { port, strictPort: true, proxy }
});
