// The HTTP surface, assembled from a ContentStore and the write-side services.
//
// createApp() returns an Express app rather than starting a listener, because the acceptance
// criteria for this task are assertions about routes and the cheapest way to assert about a
// route is to mount it in-process and call it. index.js is the four lines that turn this into a
// server.
//
// Three rules are enforced across every route here rather than per route, because a rule
// enforced per route is a rule that gets forgotten on the route written last:
//
//  1. Figure payloads never appear on a lesson, module, or exercise response. Those carry
//     figureKey and nothing else; the eight payload fields belong to the figure route.
//
//  2. Free-response answer keys are withheld, and solutions are locked until the learner earns
//     them. Multiple choice is the documented exception and ships its key, because §3.3 says the
//     MC key is not secret and pretending otherwise is theatre.
//
//  3. A missing figure and a broken figure pipeline are different answers. 404 for a key the
//     build never produced; 503 when the manifest itself did not pass, because "the build has
//     not run" and "this figure does not exist" must not look the same to a client.

import express from "express";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadContentStore, DEFAULT_CONTENT_ROOT } from "./content.js";
import { FigureStore, loadFigureStore, requireFigure, figureReference } from "./figures.js";
import { FIGURE_PAYLOAD_FIELDS } from "../../lib/figure-contract.mjs";
import { PracticeService, ProgressService, Store, DEFAULT_DATA_DIR, ATTEMPTS_BEFORE_SOLUTION } from "./state.js";
import { gradeChoice, gradeFreeResponse, canonicalize, expectedFormOf } from "./grading.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

const MAX_BATCH_IDS = 60; // IA §7: "<= 60 ids practical" for one batched call.
const ONE_YEAR_SECONDS = 31536000;

function sendError(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: code, message, ...extra });
}

export function createApp({
  content = loadContentStore(),
  figureStore = null,
  dataDir = DEFAULT_DATA_DIR,
  persistence = null,
} = {}) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  const store = persistence || new Store({ dataDir });
  const practice = new PracticeService(store, content, { store });
  const progress = new ProgressService(store);
  // The figure store is optional at construction so a missing manifest cannot stop the service
  // from booting: the content routes are the product, and a figure build that never ran degrades
  // the figure route to a 503 rather than taking down lessons.
  const figures = figureStore === null ? tryLoadFigureStore() : figureStore;

  // ---------------------------------------------------------------------
  // Health and metadata
  // ---------------------------------------------------------------------

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      service: "math-training-api",
      content: content.stats(),
      figures: figures
        ? { usable: figures.usable, status: figures.manifest.status, count: figures.keys().length, pipelineVersion: figures.pipelineVersion }
        : { usable: false, status: "manifest-unreadable", count: 0 },
      attemptsBeforeSolution: ATTEMPTS_BEFORE_SOLUTION,
    });
  });

  // Every reference the corpus has that does not resolve. A content bug that costs a learner an
  // explanation is worth surfacing on a route a human can curl, rather than only in a startup log.
  app.get("/api/content/warnings", (_req, res) => {
    res.json({ warnings: content.warnings, stats: content.stats() });
  });

  // ---------------------------------------------------------------------
  // Modules and lessons
  // ---------------------------------------------------------------------

  app.get("/api/modules", (_req, res) => {
    const { modules, missingTitle } = content.listModules();
    // The header is set before the body: a header written after res.json() is silently dropped
    // by Express, and the warning is the whole reason it exists. The array body stays exactly
    // the shape IA §7 specifies.
    if (missingTitle.length) res.set("X-Content-Warnings", `unresolved module titles: ${missingTitle.join(",")}`);
    res.json(modules);
  });

  app.get("/api/modules/:moduleId", (req, res) => {
    const moduleId = req.params.moduleId;
    const { module, lessons } = content.getModule(moduleId);
    // A module is real if any lesson claims it, or if a catalogue entry declares it. A module
    // with no lessons yet is still listable - the catalogue is wider than the corpus - so
    // "no lessons" and "no module" have to be told apart.
    const known = lessons.length > 0 || content.moduleMeta.has(moduleId);
    if (!known) return sendError(res, 404, "not_found", `no module ${moduleId}`);
    // Prerequisite titles resolved here, once, for every lesson in the module - including
    // prerequisites that live in another module. The UI asks for this as one call with no N+1.
    const prerequisiteIds = [...new Set(lessons.flatMap((l) => l.prerequisites || []))];
    res.json({
      module,
      lessons: lessons.map((l) => ({
        id: l.id,
        order: l.order,
        title: l.title,
        tiers: l.tiers || [],
        estimatedMinutes: l.estimatedMinutes ?? null,
        lockMode: l.lockMode || "soft",
        prerequisites: (l.prerequisites || []).slice(),
        exerciseCount: content.practiceIds(l.id).length,
      })),
      prerequisitesFlat: prerequisiteIds
        .map((id) => {
          const lesson = content.lessons.get(id);
          return lesson ? { id: lesson.id, title: lesson.title } : { id, title: null };
        })
        .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    });
  });

  app.get("/api/lessons", (req, res) => {
    const { moduleId, ids } = req.query;
    if (ids) return sendBatchLessons(res, content, ids);
    let lessons = [...content.lessons.values()];
    if (moduleId) lessons = lessons.filter((l) => l.moduleId === moduleId);
    const response = lessons
      .sort((a, b) => (a.moduleId === b.moduleId ? a.order - b.order : String(a.moduleId).localeCompare(String(b.moduleId))))
      .map((l) => content.getLesson(l.id));
    res.json(response);
  });

  app.get("/api/lessons/:lessonId", (req, res) => {
    const lesson = content.getLesson(req.params.lessonId);
    if (!lesson) return sendError(res, 404, "not_found", `no lesson ${req.params.lessonId}`);
    // Soft locks are a content decision (IA §7 gap 6): a lesson with unmet prerequisites is
    // visible and openable, so the response reports the lock state rather than refusing.
    const unmet = lesson.prerequisites.filter((id) => !progress.get(id)?.state || progress.get(id).state !== "passed");
    res.json({
      ...lesson,
      lock: {
        mode: lesson.lockMode,
        blocked: lesson.lockMode === "hard" && unmet.length > 0,
        unmetPrerequisites: lesson.lockMode === "hard" ? unmet : [],
      },
      mastery: progress.get(lesson.id) || null,
    });
  });

  // ---------------------------------------------------------------------
  // Exercises
  // ---------------------------------------------------------------------

  app.get("/api/exercises", (req, res) => {
    const { ids, lessonId, moduleId, tier, difficultyMin, difficultyMax, tag, limit } = req.query;
    if (ids) {
      const list = String(ids)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length > MAX_BATCH_IDS) {
        return sendError(res, 400, "too_many_ids", `batch fetch takes at most ${MAX_BATCH_IDS} ids, got ${list.length}`);
      }
      const found = content.queryExercises({ ids: list });
      // A batch that names an id nothing serves answers 200 with what exists and reports the
      // misses: a 404 would be wrong (some ids resolved) and silently dropping them would hide a
      // content or client bug.
      const foundIds = new Set(found.map((e) => e.id));
      const missing = list.filter((id) => !foundIds.has(id));
      if (missing.length) res.set("X-Content-Warnings", `unknown exercise ids: ${missing.join(",")}`);
      return res.json(found);
    }

    const filters = {};
    if (lessonId) filters.lessonId = String(lessonId);
    if (moduleId) filters.moduleId = String(moduleId);
    if (tier) filters.tiers = String(tier).split(",").map((s) => s.trim()).filter(Boolean);
    if (tag) filters.tags = String(tag).split(",").map((s) => s.trim()).filter(Boolean);
    if (difficultyMin !== undefined) filters.difficultyMin = Number(difficultyMin);
    if (difficultyMax !== undefined) filters.difficultyMax = Number(difficultyMax);
    const found = content.queryExercises(filters);
    res.json(limit ? found.slice(0, Number(limit)) : found);
  });

  app.get("/api/exercises/:exerciseId", (req, res) => {
    const exercise = content.getExercise(req.params.exerciseId);
    if (!exercise) return sendError(res, 404, "not_found", `no exercise ${req.params.exerciseId}`);
    res.json(exercise);
  });

  // The grader fallback (IA §7, R §6). The client grades locally and posts here only when it is
  // unsure; the server's verdict wins. It accepts either a response alone (self-contained
  // grading, for a session answer) or a response plus an exerciseId (grading against the corpus).
  app.post("/api/grade", (req, res) => {
    const { response, exerciseId, answerLatex, answerAlternatives, choices, angleUnit, answerAngle } = req.body || {};
    let exercise;
    if (exerciseId) {
      const record = content.exercises.get(exerciseId);
      if (!record) return sendError(res, 404, "not_found", `no exercise ${exerciseId}`);
      exercise = record;
    } else if (typeof answerLatex === "string") {
      // Self-contained grading needs the key from the caller. It is a deliberate, documented
      // capability rather than a leak: a client that already holds the key has already been told
      // the answer, so this route grants no new information.
      exercise = { id: "inline", answerLatex, answerAlternatives, choices, angleUnit, answerAngle };
    } else {
      return sendError(res, 400, "bad_request", "grade needs exerciseId or answerLatex");
    }

    const isChoice = Array.isArray(exercise.choices) && exercise.choices.length > 0;
    const verdict = isChoice ? gradeChoice(exercise, response) : gradeFreeResponse(exercise, response);
    res.json({
      correct: verdict.correct,
      method: verdict.method,
      // The learner's own canonicalised input. Never the answer.
      normalized: verdict.normalized ?? canonicalize(response ?? "", exercise),
      expectedForm: expectedFormOf(exercise),
      gradedBy: "server",
    });
  });

  // ---------------------------------------------------------------------
  // Figures
  // ---------------------------------------------------------------------

  app.get("/api/figures", (_req, res) => {
    if (!figures || !figures.usable) {
      // Hard 503, never an empty list (MAX-11 contract). A build that never ran and a figure list
      // that is genuinely empty must not look the same to a client.
      return sendError(res, 503, figures ? `figure-pipeline-${figures.manifest.status}` : "figure-manifest-unreadable", figures
        ? `figure manifest status is ${figures.manifest.status}; run npm run content:figures`
        : "figure manifest could not be read; run npm run content:figures", {
        pipelineVersion: figures?.pipelineVersion ?? null,
        figureCount: figures?.keys().length ?? 0,
      });
    }
    res.set("Cache-Control", `public, max-age=${ONE_YEAR_SECONDS}, immutable`);
    res.json({
      pipelineVersion: figures.pipelineVersion,
      status: figures.manifest.status,
      toolchain: figures.toolchain,
      figures: figures.keys()
        .sort()
        .map((key) => requireFigure(figures, key)),
    });
  });

  app.get("/api/figures/:figureKey(*)", (req, res) => {
    if (!figures) return sendError(res, 503, "figure-manifest-unreadable", "figure manifest could not be read");
    try {
      const payload = requireFigure(figures, req.params.figureKey);
      // figureHash is a sha256 over the sanitised SVG, which makes it a strong ETag and safe to
      // cache immutably: a rebuilt figure has a new hash, so a stale client cannot hold it.
      res.set("ETag", payload.figureHash);
      res.set("Cache-Control", `public, max-age=${ONE_YEAR_SECONDS}, immutable`);
      res.json(payload);
    } catch (err) {
      return sendError(res, err.status || 500, err.status === 503 ? "figure-pipeline-incomplete" : "not_found", err.message);
    }
  });

  // The compiled SVG itself, served from the build output with the hash as its ETag.
  app.get("/artifacts/figures/svg/:file", (req, res) => {
    const dir = join(REPO, "artifacts", "figures", "svg");
    const path = join(dir, req.params.file);
    if (!path.startsWith(`${dir}/`) || !existsSync(path) || !statSync(path).isFile()) {
      return sendError(res, 404, "not_found", `no compiled figure ${req.params.file}`);
    }
    const entry = figures?.byKey ? findEntryForFile(figures, path) : null;
    if (entry?.figureHash) res.set("ETag", entry.figureHash);
    res.set("Cache-Control", `public, max-age=${ONE_YEAR_SECONDS}, immutable`);
    res.type("image/svg+xml");
    createReadStream(path).pipe(res);
  });

  // ---------------------------------------------------------------------
  // Practice
  // ---------------------------------------------------------------------

  app.post("/api/practice/sessions", (req, res) => {
    const session = practice.createSession(req.body?.filters || {});
    res.status(201).json({
      sessionId: session.sessionId,
      itemIds: session.itemIds,
      meta: session.meta,
      mode: session.mode,
      matchedCount: session.matchedCount,
      createdAt: session.createdAt,
    });
  });

  app.get("/api/practice/sessions/:sessionId", (req, res) => {
    const session = practice.getSession(req.params.sessionId);
    if (!session) return sendError(res, 404, "not_found", `no practice session ${req.params.sessionId}`);
    res.json(practice.sessionView(session));
  });

  app.post("/api/practice/sessions/:sessionId/answers", (req, res) => {
    const result = practice.submitAnswer(req.params.sessionId, req.body || {});
    return res.status(result.status).json(result.body);
  });

  app.get("/api/practice/sessions/:sessionId/exercises/:exerciseId/solution", (req, res) => {
    const result = practice.getSolution(req.params.sessionId, req.params.exerciseId);
    return res.status(result.status).json(result.body);
  });

  app.post("/api/practice/sessions/:sessionId/complete", (req, res) => {
    const result = practice.completeSession(req.params.sessionId, req.body || {});
    return res.status(result.status).json(result.body);
  });

  app.get("/api/practice/review-queue", (req, res) => {
    res.json({ items: practice.reviewQueue(req.query.lessonId ? String(req.query.lessonId) : null) });
  });

  // ---------------------------------------------------------------------
  // Progress
  // ---------------------------------------------------------------------

  app.put("/api/progress", (req, res) => {
    const result = progress.put(req.body || {});
    return res.status(result.status).json(result.body);
  });

  app.get("/api/progress", (req, res) => {
    res.json(progress.list());
  });

  app.get("/api/progress/:lessonId", (req, res) => {
    const record = progress.get(req.params.lessonId);
    if (!record) return sendError(res, 404, "not_found", `no progress for ${req.params.lessonId}`);
    res.json(record);
  });

  // ---------------------------------------------------------------------
  // The false-negative escape hatch (R §6, §6 callout 9)
  //
  // Every exercise card carries "Report a problem". It is one endpoint and no modal, and the
  // queue it feeds is the only mechanism by which a grader that wrongly rejects a right answer
  // gets corrected rather than taught into the learner.
  // ---------------------------------------------------------------------

  const flag = (req, res) => {
    const exerciseId = req.params.exerciseId;
    if (!content.exercises.has(exerciseId)) {
      return sendError(res, 404, "not_found", `no exercise ${exerciseId}`);
    }
    const body = req.body || {};
    const record = {
      id: `flag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      exerciseId,
      sessionId: body.sessionId ?? null,
      attemptIndex: Number.isInteger(body.attemptIndex) ? body.attemptIndex : null,
      response: typeof body.response === "string" ? body.response.slice(0, 2000) : null,
      // kind is the reason from the report form: wrong answer, ambiguous wording, broken LaTeX,
      // figure wrong. It is free-form-tolerant because a content bug rarely fits the four boxes.
      kind: typeof body.kind === "string" ? body.kind.slice(0, 80) : "unspecified",
      note: typeof body.note === "string" ? body.note.slice(0, 2000) : null,
      at: new Date().toISOString(),
    };
    store.appendFlag(record);
    return res.status(201).json({ accepted: true, id: record.id, queue: store.flagsPath });
  };
  app.post("/api/exercises/:exerciseId/flagged", flag);
  app.post("/api/exercises/:exerciseId/feedback", flag);

  // ---------------------------------------------------------------------
  // Not found, and the error handler
  // ---------------------------------------------------------------------

  app.use("/api", (_req, res) => sendError(res, 404, "not_found", "no route for this path"));

  // One JSON error shape for the whole service. An unhandled throw becomes a 500 with no stack
  // in the body; the stack goes to the log, which is where a learner-facing payload must not put
  // filesystem paths.
  app.use((err, _req, res, _next) => {
    const status = err.status && Number.isInteger(err.status) ? err.status : 500;
    if (status >= 500) console.error(`[api] ${err.stack || err.message}`);
    res.status(status).json({ error: status === 500 ? "internal_error" : "error", message: err.message });
  });

  app.locals.content = content;
  app.locals.practice = practice;
  app.locals.progress = progress;
  app.locals.figures = figures;
  app.locals.store = store;
  return app;
}

function sendBatchLessons(res, content, ids) {
  const list = String(ids).split(",").map((s) => s.trim()).filter(Boolean);
  const found = list.map((id) => content.getLesson(id)).filter(Boolean);
  const foundIds = new Set(found.map((l) => l.id));
  const missing = list.filter((id) => !foundIds.has(id));
  if (missing.length) res.set("X-Content-Warnings", `unknown lesson ids: ${missing.join(",")}`);
  res.json(found);
}

function findEntryForFile(figureStore, path) {
  const wanted = path.split("/").pop();
  for (const entry of figureStore.manifest.figures || []) {
    if (typeof entry.figureSvgUrl === "string" && entry.figureSvgUrl.endsWith(`/${wanted}`)) return entry;
  }
  return null;
}

// A missing or broken manifest degrades the figure routes; it does not stop the service. The
// reason is returned in /api/health so the failure is visible to whoever is watching, rather than
// only to whoever happened to load a lesson with a figure.
function tryLoadFigureStore() {
  try {
    return loadFigureStore();
  } catch (err) {
    console.warn(`[api] figures unavailable: ${err.message}`);
    return null;
  }
}

export { FigureStore, figureReference, FIGURE_PAYLOAD_FIELDS, DEFAULT_CONTENT_ROOT };
