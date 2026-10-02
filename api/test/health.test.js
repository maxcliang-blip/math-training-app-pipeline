import { test, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../src/app.js";
import { Store, PracticeService, ProgressService, ATTEMPTS_BEFORE_SOLUTION } from "../src/state.js";
import { loadContentStore } from "../src/content.js";

// Health is the endpoint a deploy checks, so it has to report the thing that actually breaks:
// the corpus it loaded and the state of the figure pipeline. The second half of this file covers
// the property that makes the write side worth having at all - a learner's progress and a
// running session survive a process restart.

let dataDir;
let server;
let base;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "math-api-health-"));
  server = createApp({ dataDir }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
});

test("health is 200 with the corpus counts and the figure pipeline state", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.content.lessons, 32);
  assert.equal(body.content.exercises, 608);
  // The figure pipeline is reported rather than assumed, so a deploy can tell "the service is up"
  // from "the service is up and the figures are broken".
  assert.equal(typeof body.figures.usable, "boolean");
  assert.equal(typeof body.figures.count, "number");
  assert.equal(body.attemptsBeforeSolution, ATTEMPTS_BEFORE_SOLUTION);
});

test("progress and a running session survive a restart", async () => {
  const content = loadContentStore();
  const first = new Store({ dataDir });

  const progress = new ProgressService(first);
  const put = progress.put({ lessonId: "m1-l2", state: "passed", mastery: { attempt: 3, correct: 3, total: 3 }, updatedAt: "2026-10-02T12:00:00.000Z" });
  assert.equal(put.status, 200);

  const practice = new PracticeService(first, content, { store: first });
  const session = practice.createSession({ filters: { lessonId: "m1-l2", size: 5 } });
  const answered = practice.submitAnswer(session.sessionId, { exerciseId: session.itemIds[0], response: "wrong-answer-attempt", attemptIndex: 0 });
  assert.equal(answered.status, 200);

  // A brand new Store, as a restarted process would build.
  const second = new Store({ dataDir });
  const reloadedProgress = new ProgressService(second).get("m1-l2");
  assert.equal(reloadedProgress.state, "passed");
  assert.equal(reloadedProgress.mastery.correct, 3);

  const reloadedPractice = new PracticeService(second, content, { store: second });
  const reloadedSession = reloadedPractice.getSession(session.sessionId);
  assert.ok(reloadedSession, "a learner resuming after a deploy must still find their session");
  assert.deepEqual(reloadedSession.itemIds, session.itemIds);
  assert.equal(reloadedSession.answers[session.itemIds[0]].attempts.length, 1);
});

test("a corrupt state file does not stop the service from booting", async () => {
  const brokenDir = mkdtempSync(join(tmpdir(), "math-api-broken-"));
  try {
    // The worst case of losing this file is a learner re-doing a session, which is recoverable.
    // Refusing to start is not recoverable.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(brokenDir, "sessions.json"), "{not json");
    writeFileSync(join(brokenDir, "progress.json"), "[]");
    const app = createApp({ dataDir: brokenDir });
    assert.equal(app.locals.store.sessions && typeof app.locals.store.sessions === "object", true);
    assert.deepEqual(app.locals.store.progress, []);
  } finally {
    rmSync(brokenDir, { recursive: true, force: true });
  }
});

test("the data directory is created on demand rather than required to pre-exist", async () => {
  const freshDir = join(mkdtempSync(join(tmpdir(), "math-api-fresh-")), "nested", "data");
  const app = createApp({ dataDir: freshDir });
  const result = app.locals.progress.put({ lessonId: "m1-l1", state: "in-progress", updatedAt: new Date().toISOString() });
  assert.equal(result.status, 200);
  assert.equal(existsSync(join(freshDir, "progress.json")), true);
  rmSync(freshDir, { recursive: true, force: true });
});
