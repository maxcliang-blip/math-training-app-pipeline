import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // The figure bundle split is asserted against this file, not against a grep of dist/:
    // scripts/assert-figure-bundle-split.mjs walks the static import closure of every entry using
    // Vite's own account of it. Rollup's own answer is what "not in the entry payload" means, and
    // a regex over minified output would be guessing at it.
    manifest: true,
  },
  server: {
    proxy: { "/api": "http://localhost:4000" }
  }
});
