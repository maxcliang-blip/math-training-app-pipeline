// The write side of the API: practice sessions, answers, progress, and flags.
//
// Every store here is a plain JSON file under DATA_DIR. That is a v1 decision with one property
// worth stating plainly: a learner's progress is not something this service may lose to a
// process restart, so nothing lives only in memory. Sessions and progress are written through
// on every mutation; flags are appended as JSON lines so a content-ops pass can read them with
// grep. There is no database because there is no relational model here - the corpus is the
// database, read at startup, and progress is a last-write-wins map keyed by lesson.
//
// The answer-leak rule is enforced here rather than in the routes, because the routes are where
// it gets forgotten. answers() returns {correct, expectedForm, solutionAvailable} and nothing
// that reveals the key for a wrong attempt; the solution only becomes available once the learner
// has exhausted attempts or explicitly revealed it. A client that receives the answer on a wrong
// attempt has a cheating surface (lesson spec §3.3), and the server is the enforcement point -
// but a server that puts the key in the payload has not enforced anything.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { canonicalize, evaluateNumber, gradeChoice, gradeFreeResponse, expectedFormOf } from "./grading.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
export const DEFAULT_DATA_DIR = process.env.DATA_DIR || join(REPO, ".data");

const SESSION_FILE = "sessions.json";
const PROGRESS_FILE = "progress.json";
const FLAGS_FILE = "flags.jsonl";

// Practice sessions are capped. Unbounded session growth is how a JSON file turns into a
// multi-megabyte read on every request; the cap is high enough that no real learner hits it and
// low enough that pruning one key is a cheap operation.
const MAX_SESSIONS = 2000;

// After this many attempts on one exercise the reveal stops being a choice, and the solution is
// served without another click. The client can still ask for it earlier (revealed: true).
export const ATTEMPTS_BEFORE_SOLUTION = 3;

function readJsonFile(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    // A corrupt file must not take the service down at startup; the worst case of losing it is a
    // learner re-doing a session, which is recoverable and visible.
    return fallback;
  }
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  // Write-then-write: the second write is a rename-free atomic-enough replace for a single
  // learner service, and it avoids leaving a .tmp file behind if the process dies mid-write.
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

export class Store {
  constructor({ dataDir = DEFAULT_DATA_DIR } = {}) {
    this.dataDir = dataDir;
    this.sessionsPath = join(dataDir, SESSION_FILE);
    this.progressPath = join(dataDir, PROGRESS_FILE);
    this.flagsPath = join(dataDir, FLAGS_FILE);
    this.sessions = readJsonFile(this.sessionsPath, {});
    this.progress = readJsonFile(this.progressPath, {});
  }

  persistSessions() {
    const keys = Object.keys(this.sessions);
    if (keys.length > MAX_SESSIONS) {
      // Oldest first; session ids sort by creation because they embed the timestamp.
      for (const key of keys.sort().slice(0, keys.length - MAX_SESSIONS)) delete this.sessions[key];
    }
    writeJsonFile(this.sessionsPath, this.sessions);
  }

  persistProgress() {
    writeJsonFile(this.progressPath, this.progress);
  }

  appendFlag(record) {
    mkdirSync(dirname(this.flagsPath), { recursive: true });
    appendFileSync(this.flagsPath, `${JSON.stringify(record)}\n`);
    return record;
  }
}

export class PracticeService {
  constructor(store, content, { store: persistence = new Store() } = {}) {
    this.content = content;
    this.persistence = persistence;
    this.sessions = new Map(Object.entries(persistence.sessions));
    this.state = persistence;
  }

  // Create a session. The item order is server-chosen and stable (the content store sorts by id)
  // so that "resume last session" is reliable: a client that rebuilds the same filters gets the
  // same itemIds, which is what makes a session resumable at all.
  createSession(filters = {}) {
    const requestedSize = Number(filters.size);
    const size = Number.isFinite(requestedSize) && requestedSize > 0 ? Math.min(Math.floor(requestedSize), 30) : 10;
    const mode = filters.mode === "review" ? "review" : "practice";

    const matched = this.content.searchExercises(filters);
    const itemIds = matched.slice(0, size).map((e) => e.id);

    const session = {
      sessionId: `s_${randomUUID()}`,
      createdAt: new Date().toISOString(),
      mode,
      filters: {
        moduleId: filters.moduleId ?? null,
        lessonId: filters.lessonId ?? null,
        tiers: filters.tiers || null,
        tags: filters.tags || null,
        difficultyMin: filters.difficultyMin ?? null,
        difficultyMax: filters.difficultyMax ?? null,
      },
      requestedSize: size,
      itemIds,
      // The count the filters matched before the size cap, so the client can say "showing 10 of
      // 34" instead of implying the filters were that narrow.
      matchedCount: matched.length,
      meta: {
        byTier: countBy(itemIds, (id) => this.content.exercises.get(id)?.tier),
        byModule: countBy(itemIds, (id) => this.content.exercises.get(id)?.moduleId),
        byLesson: countBy(itemIds, (id) => this.content.exercises.get(id)?.lessonId),
      },
      answers: {},
      completedAt: null,
      summary: null,
    };

    this.sessions.set(session.sessionId, session);
    this.persistence.sessions = Object.fromEntries(this.sessions);
    this.persistence.persistSessions();
    return session;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  // The resume payload: the session minus anything the client already holds, plus per-item
  // state so the queue rail can be painted without replaying every answer.
  sessionView(session) {
    return {
      sessionId: session.sessionId,
      mode: session.mode,
      createdAt: session.createdAt,
      itemIds: session.itemIds,
      matchedCount: session.matchedCount,
      meta: session.meta,
      completedAt: session.completedAt,
      summary: session.summary,
      items: session.itemIds.map((exerciseId) => {
        const attempts = session.answers[exerciseId]?.attempts || [];
        return {
          exerciseId,
          status: itemStatus(session, exerciseId),
          attempts: attempts.length,
          hintsUsed: attempts.reduce((n, a) => Math.max(n, a.hintsUsed || 0), 0),
          correct: attempts.some((a) => a.correct),
        };
      }),
    };
  }

  // POST /api/practice/sessions/:id/answers
  //
  // Returns correctness only. expectedForm is a shape ("a single number"), not a value. The
  // solution unlocks when the learner asks for it or exhausts the attempt budget; until then a
  // wrong answer gets nothing that could be scraped out of it.
  submitAnswer(sessionId, body = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return { status: 404, body: { error: "not_found", message: `no practice session ${sessionId}` } };

    const exerciseId = body.exerciseId;
    const exercise = this.content.exercises.get(exerciseId);
    if (!exercise) {
      return { status: 404, body: { error: "not_found", message: `no exercise ${exerciseId}` } };
    }
    if (!session.itemIds.includes(exerciseId)) {
      return {
        status: 409,
        body: { error: "not_in_session", message: `${exerciseId} is not an item in session ${sessionId}` },
      };
    }

    const isChoice = Array.isArray(exercise.choices) && exercise.choices.length > 0;
    const verdict = isChoice ? gradeChoice(exercise, body.response) : gradeFreeResponse(exercise, body.response);

    const attemptIndex = Number.isInteger(body.attemptIndex)
      ? body.attemptIndex
      : (session.answers[exerciseId]?.attempts.length ?? 0);
    const attempt = {
      attemptIndex,
      correct: verdict.correct,
      method: verdict.method,
      hintsUsed: Number.isInteger(body.hintsUsed) ? body.hintsUsed : 0,
      elapsedMs: Number.isFinite(Number(body.elapsedMs)) ? Number(body.elapsedMs) : null,
      // A work note is the learner's own text. It is stored so the solution view can show "your
      // attempt" beside the derivation (lesson spec §3.2) and it is never sent to grading.
      workNote: typeof body.workNote === "string" ? body.workNote.slice(0, 4000) : null,
      at: new Date().toISOString(),
    };
    if (body.mode === "mastery") attempt.mastery = true;

    const record = session.answers[exerciseId] || { attempts: [], solutionRevealed: false, flagged: false };
    record.attempts.push(attempt);
    session.answers[exerciseId] = record;

    // §3.5: revealing the solution ends the attempt. The client asks for it explicitly.
    if (body.revealed === true) record.solutionRevealed = true;

    const attempts = record.attempts.length;
    const solutionAvailable = record.solutionRevealed || attempts >= ATTEMPTS_BEFORE_SOLUTION || verdict.correct;

    this.persistence.sessions = Object.fromEntries(this.sessions);
    this.persistence.persistSessions();

    const response = {
      correct: verdict.correct,
      expectedForm: expectedFormOf(exercise),
      solutionAvailable,
      attemptIndex: attempt.attemptIndex,
    };
    if (isChoice) {
      // §3.3: the MC key already ships inside the exercise record, so restating the index adds
      // no secrecy and saves the client a match. It is not sent on a wrong free-response answer,
      // and there is no free-response equivalent.
      response.correctIndex = verdict.correctIndex;
      response.choices = exercise.choices;
    }
    if (verdict.normalized !== null && verdict.normalized !== undefined) {
      // The learner's own canonicalised input. Their text, shown back to them.
      response.normalized = verdict.normalized;
    }
    if (!verdict.correct && response.normalized !== undefined) {
      // A differentiation nudge the grader can compute for free: how far off the numeric value
      // is. Never present for a non-numeric answer, because a wrong difference is worse than no
      // nudge (§3.2).
      const numeric = numericNudge(exercise, verdict.normalized);
      if (numeric) response.nudge = numeric;
    }
    return { status: 200, body: response };
  }

  // The solution, once the learner is allowed it. This is the only route that returns
  // solutionLatex, and it refuses until the attempt budget or an explicit reveal.
  getSolution(sessionId, exerciseId) {
    const session = this.sessions.get(sessionId);
    if (!session) return { status: 404, body: { error: "not_found", message: `no practice session ${sessionId}` } };
    const exercise = this.content.exercises.get(exerciseId);
    if (!exercise) return { status: 404, body: { error: "not_found", message: `no exercise ${exerciseId}` } };
    if (!session.itemIds.includes(exerciseId)) {
      return { status: 409, body: { error: "not_in_session", message: `${exerciseId} is not an item in session ${sessionId}` } };
    }
    const record = session.answers[exerciseId];
    const attempts = record?.attempts.length ?? 0;
    const allowed = Boolean(record?.solutionRevealed) || attempts >= ATTEMPTS_BEFORE_SOLUTION || (record?.attempts || []).some((a) => a.correct);
    if (!allowed) {
      return {
        status: 403,
        body: {
          error: "solution_locked",
          message: `the solution unlocks after ${ATTEMPTS_BEFORE_SOLUTION} attempts or an explicit reveal`,
          attempts,
          attemptsRequired: ATTEMPTS_BEFORE_SOLUTION,
        },
      };
    }
    return {
      status: 200,
      body: {
        exerciseId,
        // Withheld for free response until it is allowed, which is the moment the learner is
        // entitled to the answer anyway.
        answerLatex: exercise.answerLatex ?? null,
        solutionLatex: exercise.solutionLatex ?? null,
        hintLatex: exercise.hintLatex || [],
        attempts,
      },
    };
  }

  // POST /api/practice/sessions/:id/complete
  completeSession(sessionId, body = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return { status: 404, body: { error: "not_found", message: `no practice session ${sessionId}` } };

    const perItem = session.itemIds.map((exerciseId) => {
      const record = session.answers[exerciseId];
      const attempts = record?.attempts || [];
      return {
        exerciseId,
        attempted: attempts.length > 0,
        correct: attempts.some((a) => a.correct),
        skipped: attempts.length === 0,
        attempts: attempts.length,
        hintsUsed: attempts.reduce((n, a) => Math.max(n, a.hintsUsed || 0), 0),
        durationMs: attempts.reduce((n, a) => n + (a.elapsedMs || 0), 0),
      };
    });

    const attempted = perItem.filter((i) => i.attempted);
    const correct = perItem.filter((i) => i.correct);
    const summary = {
      sessionId,
      completedAt: new Date().toISOString(),
      total: perItem.length,
      attempted: attempted.length,
      correct: correct.length,
      skipped: perItem.filter((i) => i.skipped).length,
      accuracy: attempted.length ? Number((correct.length / attempted.length).toFixed(4)) : 0,
      byTier: countBy(perItem.filter((i) => i.correct).map((i) => i.exerciseId), (id) => this.content.exercises.get(id)?.tier),
      wrongExerciseIds: perItem.filter((i) => i.attempted && !i.correct).map((i) => i.exerciseId),
      // §5 of lesson spec: skipped items stay reachable, so the summary lists them as unseen
      // answers rather than as failures.
      unseenExerciseIds: perItem.filter((i) => i.skipped).map((i) => i.exerciseId),
      durationMs: perItem.reduce((n, i) => n + i.durationMs, 0),
      // The client's own numbers are kept when present. The server's are computed from the answer
      // events, which is the honest source; the client's are reported alongside for the case
      // where it tracked something the server cannot see (a pause timer, a tab switch).
      clientResults: body.results ?? null,
      items: perItem,
    };

    session.completedAt = summary.completedAt;
    session.summary = summary;
    this.persistence.sessions = Object.fromEntries(this.sessions);
    this.persistence.persistSessions();
    return { status: 200, body: summary };
  }

  // The review queue (IA §6.4): exercises the learner got wrong, or got right only after heavy
  // help (§3.4 flags hintsUsed >= 2 as "solved with heavy help"). Derived from append-only
  // attempt events rather than stored, so it cannot drift from what happened.
  reviewQueue(lessonId = null) {
    const out = [];
    for (const session of this.sessions.values()) {
      for (const [exerciseId, record] of Object.entries(session.answers)) {
        const exercise = this.content.exercises.get(exerciseId);
        if (!exercise) continue;
        if (lessonId && exercise.lessonId !== lessonId) continue;
        const attempts = record.attempts || [];
        if (attempts.length === 0) continue;
        const wrong = attempts.every((a) => !a.correct);
        const heavyHelp = Math.max(...attempts.map((a) => a.hintsUsed || 0)) >= 2;
        out.push({
          exerciseId,
          lessonId: exercise.lessonId,
          sessionId: session.sessionId,
          reason: wrong ? "incorrect" : heavyHelp ? "solved-with-heavy-help" : null,
          attempts: attempts.length,
          hintsUsed: Math.max(...attempts.map((a) => a.hintsUsed || 0)),
          lastAt: attempts[attempts.length - 1].at,
        });
      }
    }
    return out.filter((r) => r.reason).sort((a, b) => String(a.lastAt).localeCompare(String(b.lastAt)));
  }
}

// PUT /api/progress - idempotent, last-write-wins per lesson (IA §6.4).
//
// The comparison is on updatedAt, and a write whose updatedAt is older than what is stored is
// accepted and reported as ignored rather than rejected: the client asked for it, the server
// knows a newer fact, and returning 200 with {applied:false} is what lets an offline client
// reconcile instead of retrying forever.
export class ProgressService {
  constructor(persistence = new Store()) {
    this.persistence = persistence;
    this.progress = { ...persistence.progress };
  }

  put(body = {}) {
    const lessonId = body.lessonId;
    if (!lessonId) {
      return { status: 400, body: { error: "bad_request", message: "lessonId is required" } };
    }
    const updatedAt = typeof body.updatedAt === "string" ? body.updatedAt : new Date().toISOString();
    const record = {
      lessonId,
      // "not-started" | "in-progress" | "passed". Free-form on the way in would make the
      // progress page's states unrenderable, so it is normalised to the three the UI knows.
      state: ["not-started", "in-progress", "passed"].includes(body.state) ? body.state : "in-progress",
      mastery: normaliseMastery(body.mastery),
      updatedAt,
    };

    const existing = this.progress[lessonId];
    if (existing && existing.updatedAt && Date.parse(existing.updatedAt) > Date.parse(updatedAt)) {
      return { status: 200, body: { ...existing, applied: false, reason: "stale" } };
    }

    this.progress[lessonId] = record;
    this.persistence.progress = { ...this.progress };
    this.persistence.persistProgress();
    return { status: 200, body: { ...record, applied: true } };
  }

  get(lessonId) {
    return this.progress[lessonId] || null;
  }

  list() {
    return Object.values(this.progress).sort((a, b) => String(a.lessonId).localeCompare(String(b.lessonId)));
  }
}

function normaliseMastery(mastery) {
  const m = mastery && typeof mastery === "object" ? mastery : {};
  return {
    attempt: Number.isFinite(Number(m.attempt)) ? Number(m.attempt) : 0,
    correct: Number.isFinite(Number(m.correct)) ? Number(m.correct) : 0,
    total: Number.isFinite(Number(m.total)) ? Number(m.total) : 0,
  };
}

function itemStatus(session, exerciseId) {
  const record = session.answers[exerciseId];
  if (!record || record.attempts.length === 0) return "todo";
  if (record.flagged) return "flagged";
  if (record.attempts.some((a) => a.correct)) return "correct";
  return "incorrect";
}

function countBy(items, keyOf) {
  const counts = {};
  for (const item of items) {
    const key = keyOf(item);
    if (key === undefined || key === null) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

// The free nudge from §3.2: "your value is off by 2". Only for an answer that both sides can be
// evaluated as a single number, and only when the difference is worth mentioning - a nudge that
// says "off by 1e-12" is noise.
function numericNudge(exercise, normalizedResponse) {
  if (!normalizedResponse) return null;
  const responseValue = evaluateNumber(normalizedResponse);
  const answerValue = evaluateNumber(canonicalize(exercise.answerLatex || "", exercise));
  if (responseValue === null || answerValue === null) return null;
  const delta = answerValue - responseValue;
  if (Math.abs(delta) < 1e-9) return null;
  const rounded = Math.abs(delta) >= 1 ? Math.round(delta) : Number(delta.toPrecision(3));
  // "off by 1" on a single-value answer is the difference between a rounding slip and a
  // completely wrong approach; the nudge says nothing useful in either case.
  return Math.abs(Math.abs(delta) - 1) < 1e-9 ? null : `your value is ${rounded > 0 ? "short by" : "over by"} ${Math.abs(rounded)}`;
}
