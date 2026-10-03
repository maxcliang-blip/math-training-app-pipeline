import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API is proxied rather than hard-coded so a test harness (and a second dev server on another
// machine) can point the dev server at its own API. The default is the port api/src/index.js
// listens on, so nothing has to set this to run the app locally.
//
// /artifacts is here for the same reason /api is: the compiled SVGs are served by the API out of
// the build output, not out of web/public, so without this every figure 404s in dev and the figure
// work can only be verified against a production build.
const apiTarget = process.env.API_PROXY_TARGET || "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT || 5173),
    strictPort: true,
    proxy: { "/api": apiTarget, "/artifacts": apiTarget }
  },
  preview: {
    port: Number(process.env.WEB_PORT || 5173),
    strictPort: true,
    proxy: { "/api": apiTarget, "/artifacts": apiTarget }
  }
});