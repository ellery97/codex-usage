import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_FALLBACK_PORTS,
  DEFAULT_PORT,
  listenWithFallback,
  parsePort,
  parsePortArgv,
  portCandidates,
  resolvePortConfig,
} from "../bin/server-port.mjs";
import { startDashboard } from "../bin/codex-usage-server.mjs";
import { closeUsageIndex } from "../bin/usage-index.mjs";

test("server port arguments and environment precedence are deterministic", () => {
  assert.deepEqual(parsePortArgv(["--port", "1234"]), {
    port: 1234,
    explicit: true,
    source: "cli",
  });
  assert.deepEqual(parsePortArgv(["--port=1234"]), {
    port: 1234,
    explicit: true,
    source: "cli",
  });
  assert.deepEqual(parsePortArgv(["-p", "1234"]), {
    port: 1234,
    explicit: true,
    source: "cli",
  });
  assert.deepEqual(parsePortArgv(["-p=1234"]), {
    port: 1234,
    explicit: true,
    source: "cli",
  });
  assert.deepEqual(
    resolvePortConfig({ argv: ["--port", "1234"], env: { PORT: "2345", CODEX_USAGE_PORT: "3456" } }),
    { port: 1234, explicit: true, source: "cli" },
  );
  assert.deepEqual(
    resolvePortConfig({ argv: [], env: { PORT: "2345", CODEX_USAGE_PORT: "3456" } }),
    { port: 2345, explicit: true, source: "PORT" },
  );
  assert.deepEqual(
    resolvePortConfig({ argv: [], env: { CODEX_USAGE_PORT: "3456" } }),
    { port: 3456, explicit: true, source: "CODEX_USAGE_PORT" },
  );
  assert.deepEqual(resolvePortConfig({ argv: [], env: {} }), {
    port: DEFAULT_PORT,
    explicit: false,
    source: "default",
  });
  assert.equal(resolvePortConfig({ argv: ["--port", "0"], env: {} }).port, 0);
  assert.throws(() => parsePort("-1", "--port"), /0 to 65535/);
  assert.throws(() => parsePort("65536", "--port"), /0 to 65535/);
  assert.throws(() => parsePortArgv(["--port"]), /Missing value/);
});

test("default port fallback tries candidates and returns the actual OS port", async () => {
  const attempts = [];
  const closed = [];
  const failures = new Map([
    [DEFAULT_PORT, "EACCES"],
    [DEFAULT_FALLBACK_PORTS[0], "EADDRINUSE"],
    [DEFAULT_FALLBACK_PORTS[1], "EACCES"],
    [DEFAULT_FALLBACK_PORTS[2], "EADDRINUSE"],
  ]);
  const result = await listenWithFallback({
    port: DEFAULT_PORT,
    explicit: false,
    host: "127.0.0.1",
    createServer: (candidate) => ({ candidate }),
    listenServer: async (server, candidate) => {
      attempts.push(candidate);
      const code = failures.get(candidate);
      if (code) {
        const error = new Error(code);
        error.code = code;
        throw error;
      }
      return 43123;
    },
    closeServer: async (server) => {
      closed.push(server?.candidate);
    },
  });

  assert.deepEqual(attempts, [DEFAULT_PORT, ...DEFAULT_FALLBACK_PORTS]);
  assert.deepEqual(closed, [DEFAULT_PORT, ...DEFAULT_FALLBACK_PORTS.slice(0, -1)]);
  assert.equal(result.requestedPort, 0);
  assert.equal(result.port, 43123);
});

test("explicit port errors fail without changing the requested port", async () => {
  const attempts = [];
  await assert.rejects(
    listenWithFallback({
      port: 4321,
      explicit: true,
      host: "127.0.0.1",
      createServer: () => ({}),
      listenServer: async (_server, candidate) => {
        attempts.push(candidate);
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      },
      closeServer: async () => {},
    }),
    (error) => error.code === "EACCES" && error.attemptedPorts[0].port === 4321,
  );
  assert.deepEqual(attempts, [4321]);
  assert.deepEqual(portCandidates({ port: 4321, explicit: true }), [4321]);
});

test("startDashboard binds an ephemeral port and serves health", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-dashboard-port-test-"));
  const sessionsDir = path.join(directory, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const previousSessions = process.env.CODEX_USAGE_SESSIONS;
  process.env.CODEX_USAGE_SESSIONS = sessionsDir;
  t.after(() => {
    if (previousSessions == null) delete process.env.CODEX_USAGE_SESSIONS;
    else process.env.CODEX_USAGE_SESSIONS = previousSessions;
  });

  let dashboard = null;
  t.after(async () => {
    if (dashboard?.server?.listening) {
      await new Promise((resolve, reject) => {
        dashboard.server.close((error) => (error ? reject(error) : resolve()));
      });
    } else if (dashboard?.usageIndex) {
      closeUsageIndex(dashboard.usageIndex);
    }
    await rm(directory, { recursive: true, force: true });
  });

  dashboard = await startDashboard({
    port: 0,
    dbPath: path.join(directory, "cache.sqlite"),
    enableGc: false,
    initializePricingImpl: async () => {},
    refreshPricingImpl: async () => ({ warning: null, refreshStatus: "fresh" }),
  });

  assert.ok(dashboard.port > 0);
  const response = await fetch(`http://127.0.0.1:${dashboard.port}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
