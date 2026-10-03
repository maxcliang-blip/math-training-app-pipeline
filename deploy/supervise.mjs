#!/usr/bin/env node
// Supervise the two processes the staging container actually runs.
//
// The shape this replaces was:
//
//     node /opt/mta/api/src/index.js &
//     API_PID=$!
//     trap 'kill "$API_PID"' EXIT INT TERM
//     exec "$@"
//
// `exec` replaces the shell with nginx, so the trap is discarded and the API is never supervised
// again. Once the API dies — crash, OOM kill, stray signal — nginx keeps answering, every /api
// call 502s, and `docker ps` still says Up, because the container never exited and nothing was
// watching. That outage is silent until a learner reports it.
//
// So nginx is not exec'd here. It runs as a child of this process, which stays alive to watch both:
//
//   - The API must answer /api/health before nginx starts. A boot where the API cannot bind exits
//     non-zero, exactly as before: refusing to start beats serving a site whose every /api call
//     fails.
//   - If the API dies later, it is respawned immediately. Detection is the child's `exit` event,
//     not a poll, so the 502 window is the replacement's boot time and nothing else.
//   - If the API dies *repeatedly*, this exits non-zero instead of spinning. Docker's restart
//     policy handles that case with backoff; a hot respawn loop does not.
//   - If nginx dies, this exits with nginx's code.
//   - SIGTERM/SIGINT are forwarded to both children and this waits for them, so `docker stop`
//     still tears the container down promptly instead of waiting out the 10s kill timeout.
//
// Docker HEALTHCHECK on this image hits /api/health *through* nginx, so the health status tracks
// the path a learner actually takes rather than just the API's own port.

import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// A crash loop is a deploy bug or a broken corpus, not a transient blip. Respawning forever would
// hide it behind a container that keeps flapping between healthy and unhealthy.
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 5;

// How long one /api/health attempt may take before that attempt counts as failed.
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_INTERVAL_MS = 100;

// One request, one socket, closed with the response. `fetch` would leave the connection to a
// keep-alive pool, and a pooled socket keeps the event loop alive after both children are gone, so
// the container would sit there instead of exiting.
function probe(rawUrl, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const url = new URL(rawUrl);
    // Every attempt attaches an abort listener to the same signal, and readiness is a retry loop —
    // so the listener has to come off when the request settles. Left on, node hits
    // MaxListenersExceededWarning after ten attempts and then the leak is unbounded.
    const onAbort = () => req.destroy(new Error("aborted"));
    const settle = (fn) => (value) => {
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const ok = settle(resolve);
    const fail = settle(reject);

    const req = http.get(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        agent: false,
        headers: { accept: "application/json" },
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          ok({ ok: status >= 200 && status < 300, status });
        });
        res.on("error", fail);
      },
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("probe timed out")));
    req.on("error", fail);
  });
}

// A respawn that starts the instant the child reports `exit` can lose a race it should never lose:
// the kernel releases a killed process's listening socket when the process is reaped, which is
// after the exit event fires. Spawning into that window fails with EADDRINUSE, the replacement dies
// on startup, and every one of those failed attempts is more 502. So wait for the port to actually
// stop accepting connections before starting the replacement.
function portInUse(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

export async function waitForPortFree(rawUrl, { timeoutMs = 5_000 } = {}) {
  const url = new URL(rawUrl);
  const host = url.hostname;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (!(await portInUse(host, port, 500))) return;
    if (Date.now() >= deadline) {
      throw new Error(`${host}:${port} still accepted connections after ${timeoutMs}ms`);
    }
    await delay(PROBE_INTERVAL_MS);
  }
}

const stamp = () => new Date().toISOString();

function log(message) {
  process.stdout.write(`[supervise ${stamp()}] ${message}\n`);
}

function warn(message) {
  process.stderr.write(`[supervise ${stamp()}] ${message}\n`);
}

// Resolve when the API actually serves /api/health, not merely when its process exists. `kill -0`
// passes for a node process still reading a corpus it cannot parse; a bound port answering is the
// only evidence the API can serve a request.
//
// Rejects with the last failure seen, so a boot that never comes up says why instead of just
// reporting a timeout.
export async function waitForHealthy(url, { timeoutMs, label = "startup", signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt completed";

  for (;;) {
    if (signal?.aborted) throw new Error(`${label}: aborted`);
    if (Date.now() >= deadline) {
      throw new Error(`${label}: ${url} did not answer within ${timeoutMs}ms (${lastError})`);
    }
    const remaining = Math.max(0, deadline - Date.now());
    try {
      const { ok, status } = await probe(url, Math.min(PROBE_TIMEOUT_MS, remaining || 1), signal);
      if (ok) return;
      lastError = `HTTP ${status}`;
    } catch (err) {
      if (signal?.aborted) throw new Error(`${label}: aborted`);
      lastError = err?.message ?? String(err);
    }
    await delay(PROBE_INTERVAL_MS);
  }
}

export function supervise(config) {
  const {
    apiCommand,
    apiArgs = [],
    apiEnv = {},
    frontCommand,
    frontArgs = [],
    frontEnv = {},
    healthUrl,
    healthTimeoutMs = 15_000,
    crashLimit = CRASH_LIMIT,
    crashWindowMs = CRASH_WINDOW_MS,
    // Injected by tests so restart timing can be asserted without racing the wall clock.
    now = () => Date.now(),
    onEvent = () => {},
  } = config;

  const children = new Map();
  const recentDeaths = [];
  // Aborted on shutdown so an in-flight readiness probe cannot hold the container open.
  const aborting = new AbortController();
  let shuttingDown = false;
  let settled = false;
  let exitCode = 0;

  // Resolves once both children are gone. Holding the process open until then is what makes
  // SIGTERM tear the container down rather than orphaning nginx.
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });

  function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    exitCode = code;
    aborting.abort();
    for (const [name, child] of children) {
      log(`stopping ${name} (pid ${child.pid})`);
      child.kill("SIGTERM");
    }
    // A child that ignores SIGTERM must not hold the container open forever.
    const hard = setTimeout(() => {
      for (const [name, child] of children) {
        warn(`${name} ignored SIGTERM; sending SIGKILL`);
        child.kill("SIGKILL");
      }
    }, 8_000);
    hard.unref();
    void finished.finally(() => clearTimeout(hard));
    maybeFinish();
  }

  // The container stays alive exactly as long as it has something to supervise, and no longer. This
  // is what makes `docker stop` prompt instead of a 10s timeout, and what makes an API death a
  // restart rather than an exit.
  function maybeFinish() {
    if (shuttingDown && children.size === 0) finish(exitCode);
  }

  function startApi(reason) {
    const startedAt = now();
    const child = spawn(apiCommand, apiArgs, {
      env: { ...process.env, ...apiEnv },
      stdio: ["ignore", "inherit", "inherit"],
    });
    track("api", child);
    return waitForHealthy(healthUrl, {
      timeoutMs: healthTimeoutMs,
      label: reason === "restart" ? "api respawn" : "api startup",
      signal: aborting.signal,
    }).then(() => {
      const ms = now() - startedAt;
      log(reason === "restart" ? `api healthy again after ${ms}ms` : `api healthy after ${ms}ms`);
      onEvent({ type: "api-healthy", reason, ms });
    });
  }

  function track(name, child) {
    children.set(name, child);
    child.on("exit", (code, signal) => {
      children.delete(name);
      onEvent({ type: "exit", name, code, signal });
      maybeFinish();
      if (shuttingDown) return;

      if (name === "api") {
        // The respawn below is the only thing standing between a dead API and an indefinite 502.
        // The gap is logged as a duration so it stays visible instead of becoming folklore.
        const at = now();
        recentDeaths.push(at);
        while (recentDeaths.length && at - recentDeaths[0] > crashWindowMs) recentDeaths.shift();
        if (recentDeaths.length >= crashLimit) {
          warn(
            `api died ${recentDeaths.length} times in ${crashWindowMs}ms ` +
              `(code=${code} signal=${signal ?? "none"}); giving up so the restart policy can apply backoff`,
          );
          shutdown(typeof code === "number" && code !== 0 ? code : 1);
          return;
        }
        warn(`api exited unexpectedly (code=${code} signal=${signal ?? "none"}); respawning now`);
        // Free the port before spawning: an EADDRINUSE on the replacement is another dead process
        // and another stretch of 502, so this waits instead of racing the kernel's reap.
        waitForPortFree(healthUrl)
          .then(() => startApi("restart"))
          .catch((err) => {
            if (shuttingDown) return;
            warn(`api respawn failed: ${err.message}; exiting so the restart policy can recover`);
            shutdown(1);
          });
        return;
      }

      // nginx is the front door. If it is gone the container has nothing left to serve.
      log(`nginx exited (code=${code} signal=${signal ?? "none"}); stopping the container`);
      shutdown(typeof code === "number" && code !== 0 ? code : 0);
    });
    return child;
  }

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      log(`${signal} received; shutting down`);
      shutdown(0);
    });
  }

  // Resolve to the exit code once both children are gone. Deliberately does NOT touch
  // process.exitCode: the CLI below owns that, so importing this module (as api/test/supervise.test.js
  // does) cannot change the exit status of the process that imported it.
  function settle() {
    return finished.then(() => {
      if (settled) return exitCode;
      settled = true;
      if (exitCode !== 0) warn(`exiting with code ${exitCode}`);
      else log("all children stopped; exiting 0");
      return exitCode;
    });
  }

  return {
    finished: settle,
    start: async () => {
      try {
        // Readiness is a precondition, not a nicety: nginx starting against a dead API is the exact
        // state this file exists to prevent.
        await startApi("startup");
      } catch (err) {
        if (!shuttingDown) warn(`math-training API failed to start: ${err.message}`);
        shutdown(1);
        return settle();
      }
      track(
        "nginx",
        spawn(frontCommand, frontArgs, {
          env: { ...process.env, ...frontEnv },
          stdio: ["ignore", "inherit", "inherit"],
        }),
      );
      log("api healthy; starting nginx");
      onEvent({ type: "nginx-started" });
      return settle();
    },
    stop: (code = 0) => shutdown(code),
    isShuttingDown: () => shuttingDown,
    childCount: () => children.size,
  };
}

// "KEY=value,KEY2=value2" into an object. One comma-separated string rather than JSON so it survives
// being set through `docker run -e` without quoting gymnastics.
function parseEnv(raw) {
  if (!raw) return {};
  return Object.fromEntries(
    raw.split(",").map((pair) => {
      const eq = pair.indexOf("=");
      return [pair.slice(0, eq), pair.slice(eq + 1)];
    }),
  );
}

function fromEnvironment(argv) {
  return {
    apiCommand: process.env.SUPERVISE_API_COMMAND ?? process.execPath,
    apiArgs: process.env.SUPERVISE_API_ARGS
      ? process.env.SUPERVISE_API_ARGS.split(" ").filter(Boolean)
      : ["/opt/mta/api/src/index.js"],
    apiEnv: parseEnv(process.env.SUPERVISE_API_ENV),
    frontCommand: argv[0] ?? "nginx",
    frontArgs: argv.slice(1),
    frontEnv: parseEnv(process.env.SUPERVISE_FRONT_ENV),
    healthUrl:
      process.env.SUPERVISE_HEALTH_URL ??
      `http://127.0.0.1:${process.env.PORT ?? 3001}/api/health`,
    healthTimeoutMs: Number(process.env.SUPERVISE_HEALTH_TIMEOUT_MS ?? 15_000),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The container's exit status is the supervisor's verdict, so a crash-loop or an unbindable API
  // surfaces as a non-zero exit and the restart policy gets a chance at it.
  process.exitCode = await supervise(fromEnvironment(process.argv.slice(2))).start();
}
