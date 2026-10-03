// The defect this covers (MAX-33): `exec "$@"` in the entrypoint replaced the shell with nginx, so
// the API was unsupervised for the rest of the container's life. Once it died, every /api call
// 502'd with nothing watching, and `docker ps` said Up the whole time.
//
// These tests drive deploy/supervise.mjs — the same file the image runs — against stand-in API and
// frontend processes, because asserting on a real container means asserting on Docker, the image
// build, and a race with the host all at once.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getEventListeners } from "node:events";

import { supervise, waitForHealthy } from "../../deploy/supervise.mjs";

const SUPERVISOR = new URL("../../deploy/supervise.mjs", import.meta.url).pathname;

// A stand-in API: answers /api/health on $PORT and records every pid it has ever been, so a test
// can tell "restarted" from "still the original process". It never exits on its own, so the only
// way it dies is a test killing it — which is the failure mode being covered.
function writeFakeApi(dir) {
  const file = join(dir, "fake-api.mjs");
  writeFileSync(
    file,
    `import http from "node:http";
import { appendFileSync } from "node:fs";
const pid = process.pid;
appendFileSync(process.env.PID_LOG, "api " + pid + "\\n");
http.createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, pid }));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(Number(process.env.PORT), "127.0.0.1");
`,
  );
  return file;
}

// A stand-in frontend: stays up until signalled, exactly as `nginx -g daemon off;` does, and logs
// its own pid under a separate key so the two are distinguishable.
function writeFakeFrontend(dir) {
  const file = join(dir, "fake-frontend.mjs");
  writeFileSync(
    file,
    `import { appendFileSync } from "node:fs";
appendFileSync(process.env.PID_LOG, "front " + process.pid + "\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
  );
  return file;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mta-supervise-"));
  return { dir, api: writeFakeApi(dir), frontend: writeFakeFrontend(dir), pidLog: join(dir, "pids.log") };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Reads the pid log, which is appended to by processes that may still be running, so a partial
// final line is possible and is ignored rather than read as a pid.
function logEntries(pidLog) {
  try {
    return readFileSync(pidLog, "utf8")
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter(([kind, pid]) => (kind === "api" || kind === "front") && Number.isInteger(Number(pid)))
      .map(([kind, pid]) => ({ kind, pid: Number(pid) }));
  } catch {
    return [];
  }
}

const apiPids = (pidLog) => logEntries(pidLog).filter((e) => e.kind === "api").map((e) => e.pid);
const frontPids = (pidLog) => logEntries(pidLog).filter((e) => e.kind === "front").map((e) => e.pid);

async function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await delay(intervalMs);
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("a killed API is respawned and healthy again", async () => {
  const f = fixture();
  const port = await freePort();
  const events = [];

  const supervisor = supervise({
    apiCommand: process.execPath,
    apiArgs: [f.api],
    apiEnv: { PORT: String(port), PID_LOG: f.pidLog },
    frontCommand: process.execPath,
    frontArgs: [f.frontend],
    frontEnv: { PID_LOG: f.pidLog },
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    healthTimeoutMs: 8_000,
    onEvent: (event) => events.push(event),
  });
  const done = supervisor.start();

  // Ordering is the boot guarantee: nginx must not come up before the API can answer, or the
  // container serves a site whose every /api call 502s.
  assert.ok(await waitFor(() => frontPids(f.pidLog).length === 1), "nginx should start after a healthy API");
  const kinds = events.map((e) => e.type);
  assert.equal(kinds.indexOf("api-healthy") >= 0, true, "the API must be probed before nginx starts");
  assert.ok(
    kinds.indexOf("api-healthy") < kinds.indexOf("nginx-started"),
    `nginx started before the API was healthy: ${kinds.join(",")}`,
  );

  const [first] = apiPids(f.pidLog);
  assert.ok(first, "the API should have started");
  assert.equal(supervisor.childCount(), 2, "both processes should be supervised");

  // Kill it the way the reported outage killed it: a signal, not a clean shutdown.
  process.kill(first, "SIGKILL");
  assert.ok(await waitFor(() => apiPids(f.pidLog).length >= 2), "the API should be respawned");

  const [second] = apiPids(f.pidLog).slice(1);
  assert.notEqual(second, first, "the replacement must be a different process");
  assert.ok(!(await alive(first)), "the killed process must stay dead");
  assert.ok(await waitFor(() => events.some((e) => e.type === "api-healthy" && e.reason === "restart")));

  // The frontend is still up: the whole point is that one dead process no longer takes the
  // container's serving path with it.
  assert.equal(supervisor.childCount(), 2);
  assert.ok(await alive(frontPids(f.pidLog)[0]), "nginx must still be running");

  supervisor.stop();
  assert.equal(await done, 0, "a clean stop should exit 0");
});

test("the frontend outlives repeated API deaths", async () => {
  const f = fixture();
  const port = await freePort();

  const supervisor = supervise({
    apiCommand: process.execPath,
    apiArgs: [f.api],
    apiEnv: { PORT: String(port), PID_LOG: f.pidLog },
    frontCommand: process.execPath,
    frontArgs: [f.frontend],
    frontEnv: { PID_LOG: f.pidLog },
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    healthTimeoutMs: 8_000,
  });
  const done = supervisor.start();
  assert.ok(await waitFor(() => frontPids(f.pidLog).length === 1), "nginx should start");
  const front = frontPids(f.pidLog)[0];

  // Three kills in a row. Under the old `exec "$@"` entrypoint the first one was the last thing
  // that ever happened to that container.
  for (let round = 1; round <= 3; round += 1) {
    const before = apiPids(f.pidLog);
    process.kill(before.at(-1), "SIGKILL");
    assert.ok(await waitFor(() => apiPids(f.pidLog).length >= round + 1), `round ${round}: API respawn`);
    assert.equal(supervisor.childCount(), 2, `round ${round}: nginx must survive the API restart`);
    assert.ok(await alive(front), `round ${round}: nginx must still be running`);
  }

  supervisor.stop();
  assert.equal(await done, 0);
});

test("an API that never answers exits non-zero instead of serving a dead site", async () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), "mta-supervise-hung-"));
  const hung = join(dir, "hung-api.mjs");
  // Alive, holding the process open, and never listening: what a wedged API looks like from outside.
  // A bind failure exits instead, and the crash-loop path below covers that separately.
  writeFileSync(hung, "setInterval(() => {}, 1000);\n");

  const supervisor = supervise({
    apiCommand: process.execPath,
    apiArgs: [hung],
    frontCommand: process.execPath,
    frontArgs: [f.frontend],
    frontEnv: { PID_LOG: f.pidLog },
    healthUrl: `http://127.0.0.1:${(await freePort())}/api/health`,
    healthTimeoutMs: 800,
  });
  const done = supervisor.start();
  const code = await done;

  assert.equal(code, 1, "a container whose API never answers must exit non-zero");
  assert.equal(supervisor.childCount(), 0, "nothing may be left running");
  assert.equal(frontPids(f.pidLog).length, 0, "nginx must never start against a dead API");
});

test("a frontend that dies takes the container down and leaves nothing behind", async () => {
  const f = fixture();
  const port = await freePort();

  const supervisor = supervise({
    apiCommand: process.execPath,
    apiArgs: [f.api],
    apiEnv: { PORT: String(port), PID_LOG: f.pidLog },
    frontCommand: process.execPath,
    frontArgs: [f.frontend],
    frontEnv: { PID_LOG: f.pidLog },
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    healthTimeoutMs: 8_000,
  });
  const done = supervisor.start();
  assert.ok(await waitFor(() => frontPids(f.pidLog).length === 1), "nginx should start");
  const front = frontPids(f.pidLog)[0];
  const api = apiPids(f.pidLog)[0];

  // nginx is the front door. A container with no frontend has nothing to serve even if the API is
  // fine, so it exits instead of lingering Up — and it must not orphan the API.
  process.kill(front, "SIGKILL");

  assert.equal(await done, 0, "a clean frontend exit is a clean container exit");
  assert.equal(supervisor.childCount(), 0, "the API must not outlive a dead frontend");
  assert.ok(!(await alive(api)), "the API should have been stopped");
});

test("an API that will not stay up exits instead of respawning forever", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mta-supervise-crash-"));
  const crashing = join(dir, "crashing-api.mjs");
  writeFileSync(crashing, 'process.exit(3);\n');
  const f = { ...fixture(), crashing };

  const supervisor = supervise({
    apiCommand: process.execPath,
    apiArgs: [f.crashing],
    frontCommand: process.execPath,
    frontArgs: [f.frontend],
    frontEnv: { PID_LOG: f.pidLog },
    healthUrl: "http://127.0.0.1:1/api/health",
    healthTimeoutMs: 400,
    crashLimit: 3,
    crashWindowMs: 60_000,
  });
  const code = await supervisor.start();

  // A crash loop is a broken build, and hiding it behind a container that flaps forever is worse
  // than exiting and letting the restart policy back off.
  assert.notEqual(code, 0, "a crash loop must not exit 0");
  assert.ok(supervisor.isShuttingDown());
});

// Readiness is a retry loop that reuses one abort signal, so each attempt attaches a listener to it.
// Anything left behind accumulates for the life of the container and node's MaxListenersExceeded
// warning fires on the eleventh — which in a real container is the tenth second of the first outage.
test("readiness probing does not leak abort listeners", async () => {
  const port = await freePort();
  const controller = new AbortController();

  // Nothing is listening, so every attempt fails and the loop retries — the worst case for listener
  // accumulation, and exactly what happens while an API is dead.
  await assert.rejects(
    waitForHealthy(`http://127.0.0.1:${port}/api/health`, {
      timeoutMs: 1_500,
      signal: controller.signal,
    }),
  );

  const listeners = getEventListeners(controller.signal, "abort").length;
  assert.equal(listeners, 0, `expected no leftover abort listeners, found ${listeners}`);
});

// The container runs supervise.mjs as its own process, so prove that path end to end: the CLI wires
// up the real API path from the environment, and SIGTERM produces a prompt exit rather than a hang.
test("the CLI path supervises and exits promptly on SIGTERM", async () => {
  const f = fixture();
  const port = await freePort();

  const child = spawn(process.execPath, [SUPERVISOR, process.execPath, f.frontend], {
    env: {
      ...process.env,
      SUPERVISE_API_COMMAND: process.execPath,
      SUPERVISE_API_ARGS: f.api,
      SUPERVISE_API_ENV: `PORT=${port},PID_LOG=${f.pidLog}`,
      SUPERVISE_FRONT_ENV: `PID_LOG=${f.pidLog}`,
      SUPERVISE_HEALTH_URL: `http://127.0.0.1:${port}/api/health`,
      SUPERVISE_HEALTH_TIMEOUT_MS: "8000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  assert.ok(await waitFor(() => frontPids(f.pidLog).length === 1), `nginx never started; stderr: ${stderr}`);
  const front = frontPids(f.pidLog)[0];
  const api = apiPids(f.pidLog)[0];

  // SIGTERM must reach both children; that is what keeps `docker stop` inside its 10s window. The
  // timeout has to be cleared when the child wins, or it keeps the test process alive for the full
  // 6s and every run of this file pays for a race it already settled.
  let timer;
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  const gaveUp = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), 6_000);
  });
  child.kill("SIGTERM");
  const result = await Promise.race([exited, gaveUp]);

  assert.ok(result, `the supervisor did not exit on SIGTERM; stderr: ${stderr}`);
  assert.equal(result.code, 0, "SIGTERM should exit 0");
  assert.ok(!stderr.includes("failed to start"), `unexpected boot failure; stderr: ${stderr}`);
  assert.ok(!(await alive(front)) && !(await alive(api)), "both children should be stopped");
});
