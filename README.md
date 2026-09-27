# Math Training App

AMC-10/12/AIME level math training app: structured lessons, many exercises, full LaTeX (KaTeX) and optionally Asymptote rendering. Target: ready before the AIME in February.

Approved plan (MAX-1): React frontend + Node.js/Express backend, KaTeX for math rendering.

## Layout

- `web/` — React + Vite frontend (lessons, exercises, KaTeX rendering)
- `api/` — Node.js/Express backend (lesson CRUD, exercise handling, rendering support)
- `.github/workflows/ci.yml` — CI: install, lint, build, test

## Run locally

```bash
npm install
npm run dev:api   # Express API on :4000
npm run dev:web   # Vite dev server on :5173
```

## Roadmap

1. Repo + CI (this task)
2. UI/UX design spec
3. Backend: lesson CRUD, exercise endpoints
4. KaTeX (+ Asymptote) rendering in frontend
5. Testing & QA

Reference material on this machine: `/home/opc/amc10tooly` (existing AMC training SPA with scraped AoPS problem JSON) and `/home/opc/aime-mock-system` (mock generation scripts).
