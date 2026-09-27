# Math Training App

AMC-10/12/AIME level math training app: structured lessons, many exercises, full LaTeX (KaTeX) and optionally Asymptote rendering. Target: ready before the AIME in February.

Approved plan (MAX-1): React frontend + Node.js/Express backend, KaTeX for math rendering.

## Layout

- `web/` — React + Vite frontend (lessons, exercises, KaTeX rendering)
- `api/` — Node.js/Express backend (lesson CRUD, exercise handling, rendering support)
- `content/` — the authored corpus: `lessons/`, `exercises/`, `fixtures/`. This is the import
  source of truth, so it lives in the repository and not beside it.
- `scripts/` — the content and figure build gates
- `.github/workflows/ci.yml` — CI: install, build, test
- `.github/workflows/content.yml` — CI: content math gate and figure build

## Content build gates

Content is not allowed to reach import unverified. Two gates, both in `scripts/`:

```bash
npm run content:check      # lint every field against Rendering Conventions S2-S9
npm run content:selftest   # the same, plus proof that each rule family can fail
npm run content:figures    # pre-render Asymptote to sanitized SVG, write the figure manifest
```

`content:selftest` is the one CI runs. It injects one defect per rule family into a throwaway
copy of the corpus and requires the engine to catch every one, so a pass means something. A
rule that stops being enforced fails the build instead of passing quietly.

`content:figures` needs an Asymptote toolchain (`ASYMPTOTE_BIN`, or `asymptote` on PATH). With
no toolchain it exits 3 rather than reporting success: figures validated but not compiled is
not a build. `content:figures:authoring` is the authoring-only variant for local work.

Figures are compiled on the server side, not in the browser. The division of labour is
one-directional and load-bearing:

| Authored in `content/` | Derived by `content:figures` |
| --- | --- |
| `asymptoteSource`, `asymptoteAlt`, `asymptoteAspectRatio` | `figureSvgUrl`, `figureHash`, `figurePipelineVersion` |

Content must never carry the derived three. Requiring them at import deadlocks authoring on
the build, and no figure can ever ship.

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
