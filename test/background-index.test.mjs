import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import test from "node:test";
import { startDashboard } from "../bin/codex-usage-server.mjs";
import { scanSessionFileRange } from "../bin/session-scanner.mjs";
import { closeUsageIndex, ensureFreshIndex, getIndexStatus, openUsageIndex } from "../bin/usage-index.mjs";
import { createUsageQueryService } from "../bin/usage-query.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
async function waitForGate(gate, signal) {
  signal.throwIfAborted();
  let reject;
  const aborted = new Promise((_, r) => { reject = r; });
  const onAbort = () => reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try { await Promise.race([gate.promise, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
function event(n) {
  return JSON.stringify({ timestamp: `2026-10-01T00:00:0${n}Z`, type: "event_msg", payload: {
    type: "token_count", info: { total_token_usage: { input_tokens: n * 100, output_tokens: n * 10, total_tokens: n * 110 } },
  } }) + "\n";
}
function log(n = 1) {
  return JSON.stringify({ timestamp: "2026-10-01T00:00:00Z", type: "session_meta", payload: { id: `test-${n}`, cwd: "/fixture" } }) + "\n" +
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-5-mini", cwd: "/fixture" } }) + "\n" + event(n);
}
function options(root) {
  return { sessionsDirs: [root], group: "day", timezone: "UTC", dedupeScope: "global", sort: "key", limit: 0 };
}
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-background-test-"));
  const root = path.join(dir, "sessions"), dbPath = path.join(dir, "index.sqlite");
  await mkdir(root);
  const indexes = [];
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    for (const index of indexes) await closeUsageIndex(index);
    await rm(dir, { recursive: true, force: true });
  });
  const open = async (extra = {}) => {
    const index = await openUsageIndex({ dbPath, scanCheckTtlMs: 0, enableGc: false, ...extra });
    indexes.push(index);
    return index;
  };
  return { dir, root, dbPath, open, cleanups };
}

test("queries return the published snapshot during a blocked scan, then invalidate cached costs", async (t) => {
  const { root, open } = await fixture(t);
  const index = await open(), query = createUsageQueryService(index);
  const file = path.join(root, "old.jsonl");
  await writeFile(file, log());
  await ensureFreshIndex(index, [root]);
  const before = await query.query(options(root), { refreshIndex: false });
  const gate = deferred(), entered = deferred();
  index.scanFileImpl = async (file, opts) => { entered.resolve(); await waitForGate(gate, opts.signal); return scanSessionFileRange(file, opts); };
  await appendFile(file, event(2));
  const job = ensureFreshIndex(index, [root]);
  await entered.promise;
  const during = await query.query(options(root), { refreshIndex: false });
  assert.deepEqual(during.totals, before.totals);
  assert.equal(during.index.running, true);
  assert.equal(during.index.incomplete, true);
  assert.equal(during.index.revision, before.index.revision);
  gate.resolve();
  await job;
  const after = await query.query(options(root), { refreshIndex: false });
  assert.equal(after.totals.requests, 2);
  assert.ok(after.totals.estimated_cost_usd > before.totals.estimated_cost_usd);
  assert.ok(after.index.revision > before.index.revision);
  assert.equal(after.index.incomplete, false);
});

test("parallel compression is capped at two within the total worker limit", async (t) => {
  const { root, open } = await fixture(t);
  for (let i = 0; i < 6; i++) await writeFile(path.join(root, `a-${i}.jsonl.zst`), zstdCompressSync(log()));
  for (let i = 0; i < 2; i++) await writeFile(path.join(root, `z-${i}.jsonl`), log());
  const gate = deferred(), entered = deferred();
  let active = 0, compressed = 0, maxActive = 0, maxCompressed = 0;
  const index = await open({ scanConcurrency: 3, scanFileImpl: async (file, opts) => {
    active++;
    if (file.endsWith(".zst")) compressed++;
    maxActive = Math.max(maxActive, active);
    maxCompressed = Math.max(maxCompressed, compressed);
    if (active === 3) entered.resolve();
    try { await waitForGate(gate, opts.signal); return await scanSessionFileRange(file, opts); }
    finally { active--; if (file.endsWith(".zst")) compressed--; }
  } });
  const job = ensureFreshIndex(index, [root]);
  await entered.promise;
  assert.equal(maxCompressed, 2);
  gate.resolve();
  const sync = await job;
  assert.equal(sync.changedFiles, 8);
  assert.equal(maxActive, 3);
  assert.equal(maxCompressed, 2);
});

test("same-scope refreshes coalesce and other scopes serialize", async (t) => {
  const { dir, root, open } = await fixture(t);
  const other = path.join(dir, "other");
  await mkdir(other);
  await writeFile(path.join(root, "a.jsonl"), log());
  await writeFile(path.join(other, "b.jsonl"), log(2));
  const gate = deferred(), entered = deferred();
  const calls = [];
  const index = await open({ scanFileImpl: async (file, opts) => {
    calls.push(file);
    if (file.startsWith(root)) { entered.resolve(); await waitForGate(gate, opts.signal); }
    return scanSessionFileRange(file, opts);
  } });
  const a = ensureFreshIndex(index, [root]);
  await entered.promise;
  const same = ensureFreshIndex(index, [root]);
  const b = ensureFreshIndex(index, [other]);
  assert.equal(calls.length, 1);
  gate.resolve();
  const [first, shared] = await Promise.all([a, same, b]);
  assert.equal(first, shared);
  assert.equal(calls.length, 2);
});

test("publication conflicts discard staging and readers see another process's published revision", async (t) => {
  const { root, open } = await fixture(t);
  const one = await open(), two = await open(), query = createUsageQueryService(one);
  const file = path.join(root, "rollout.jsonl");
  await writeFile(file, log());
  await ensureFreshIndex(one, [root]);
  const before = await query.query(options(root), { refreshIndex: false });
  await appendFile(file, event(2));
  const gate = deferred(), entered = deferred();
  one.scanFileImpl = async (file, opts) => { entered.resolve(); await waitForGate(gate, opts.signal); return scanSessionFileRange(file, opts); };
  const job = ensureFreshIndex(one, [root]);
  const rejected = assert.rejects(job, { code: "INDEX_PUBLICATION_CONFLICT" });
  await entered.promise;
  await ensureFreshIndex(two, [root]);
  const latest = await query.query(options(root), { refreshIndex: false });
  assert.equal(latest.totals.requests, 2);
  assert.ok(latest.index.revision > before.index.revision);
  gate.resolve();
  await rejected;
  assert.equal(one.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 2);
});

test("a publication between query statements cannot pair old totals with the new revision", async (t) => {
  const { root, open } = await fixture(t);
  const one = await open(), two = await open();
  await writeFile(path.join(root, "rollout.jsonl"), log());
  await ensureFreshIndex(one, [root]);
  const previous = getIndexStatus(one).revision;
  const prepare = one.db.prepare;
  let publish = true;
  t.mock.method(one.db, "prepare", function (sql) {
    if (publish && sql.includes("COUNT(DISTINCT session_id) AS sessions")) {
      publish = false;
      // Simulate an independent publisher replacing a previously costed row.
      two.db.exec(`BEGIN IMMEDIATE;
        UPDATE events SET input_tokens = 200, total_tokens = 210, total_usage_key = total_usage_key || '-replacement';
        UPDATE files SET raw_token_events = 2;
        UPDATE index_publication SET revision = revision + 1;
        COMMIT;`);
    }
    return prepare.call(this, sql);
  });
  const result = await createUsageQueryService(one).query({ ...options(root), dedupeScope: "file" }, { refreshIndex: false });
  assert.equal(result.index.revision, previous + 1);
  assert.equal(result.totals.total_tokens, 210);
  assert.equal(result.stats.rawTokenEvents, 2);
});

test("closing aborts active workers, drains them, and never publishes their staged results", async (t) => {
  const { root, open } = await fixture(t);
  const gate = deferred(), entered = deferred();
  let released = false;
  const index = await open({ scanFileImpl: async (_, opts) => {
    entered.resolve();
    try { await waitForGate(gate, opts.signal); }
    finally { released = true; }
  } });
  await writeFile(path.join(root, "rollout.jsonl.zst"), zstdCompressSync(log()));
  const job = ensureFreshIndex(index, [root]);
  const rejected = assert.rejects(job, { name: "AbortError" });
  await entered.promise;
  await closeUsageIndex(index);
  await rejected;
  assert.equal(released, true);
  const reopened = await open();
  assert.equal(getIndexStatus(reopened).revision, 0);
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
});

test("Web listens and serves the old snapshot before startup scanning ends; async refresh shares the job", async (t) => {
  const { root, dbPath, open, cleanups } = await fixture(t);
  const savedEnv = process.env.CODEX_USAGE_SESSIONS;
  process.env.CODEX_USAGE_SESSIONS = root;
  let dashboard;
  cleanups.push(async () => {
    if (dashboard) {
      const stopped = new Promise((resolve) => dashboard.server.close(resolve));
      await dashboard.close();
      await stopped;
    }
    if (savedEnv === undefined) delete process.env.CODEX_USAGE_SESSIONS;
    else process.env.CODEX_USAGE_SESSIONS = savedEnv;
  });
  const seed = await open();
  await writeFile(path.join(root, "old.jsonl"), log());
  await ensureFreshIndex(seed, [root]);
  await closeUsageIndex(seed);
  await writeFile(path.join(root, "new.jsonl.zst"), zstdCompressSync(log(2)));
  const gate = deferred(), entered = deferred();
  let reads = 0;
  dashboard = await startDashboard({ port: 0, host: "127.0.0.1", dbPath, initializePricingImpl: async () => {},
    refreshPricingEnabled: false, scanFileImpl: async (file, opts) => {
      reads++; entered.resolve(); await waitForGate(gate, opts.signal); return scanSessionFileRange(file, opts);
    } });
  await entered.promise;
  const url = `http://127.0.0.1:${dashboard.port}`;
  const get = async (endpoint, init = {}) => {
    const response = await fetch(url + endpoint, { ...init, signal: AbortSignal.timeout(2000) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await fetch(url, { signal: AbortSignal.timeout(2000) })).status, 200);
  const old = await get("/api/usage?range=all");
  assert.equal(old.body.totals.requests, 1);
  assert.equal(old.body.index.running, true);
  const first = await get("/api/index/refresh?async=1", { method: "POST" });
  const second = await get("/api/index/refresh?async=1", { method: "POST" });
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(first.body.startedAt, second.body.startedAt);
  assert.equal(reads, 1);
  const status = await get("/api/index/status");
  assert.equal(status.body.running, true);
  gate.resolve();
  await dashboard.startupPromise;
  const done = await get("/api/usage?range=all");
  assert.equal(done.body.totals.requests, 2);
  assert.equal(done.body.index.running, false);
  assert.ok(done.body.index.revision > old.body.index.revision);
  await writeFile(path.join(root, "bad.jsonl.zst"), "corrupt");
  assert.equal((await get("/api/index/refresh?async=1", { method: "POST" })).status, 202);
  await dashboard.usageIndex.refreshPromise;
  const partial = await get("/api/usage?range=all");
  assert.equal(partial.body.totals.requests, 2);
  assert.equal(partial.body.index.incomplete, true);
  assert.equal(partial.body.index.failedFiles, 1);
  assert.match(partial.body.index.failures[0].path, /bad.jsonl.zst$/);
  await writeFile(path.join(root, "bad.jsonl.zst"), zstdCompressSync(log(3)));
  const retry = await get("/api/index/refresh?range=all", { method: "POST" });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.totals.requests, 3);
  assert.equal(retry.body.index.incomplete, false);
});

test("a new Web index returns a building-index empty snapshot without waiting for its first scan", async (t) => {
  const { root, dbPath, cleanups } = await fixture(t);
  const previous = process.env.CODEX_USAGE_SESSIONS;
  process.env.CODEX_USAGE_SESSIONS = root;
  const gate = deferred(), entered = deferred();
  let dashboard;
  cleanups.push(async () => {
    if (dashboard) {
      const stopped = new Promise((resolve) => dashboard.server.close(resolve));
      await dashboard.close();
      await stopped;
    }
    if (previous === undefined) delete process.env.CODEX_USAGE_SESSIONS;
    else process.env.CODEX_USAGE_SESSIONS = previous;
  });
  await writeFile(path.join(root, "first.jsonl.zst"), zstdCompressSync(log()));
  dashboard = await startDashboard({ port: 0, host: "127.0.0.1", dbPath, initializePricingImpl: async () => {},
    refreshPricingEnabled: false, scanFileImpl: async (file, opts) => {
      entered.resolve(); await waitForGate(gate, opts.signal); return scanSessionFileRange(file, opts);
    } });
  await entered.promise;
  const response = await fetch(`http://127.0.0.1:${dashboard.port}/api/usage`, { signal: AbortSignal.timeout(2000) });
  const payload = await response.json();
  assert.equal(payload.index.hasSnapshot, false);
  assert.equal(payload.index.running, true);
  assert.equal(payload.index.incomplete, true);
  assert.equal(payload.totals.requests, 0);
  gate.resolve();
  await dashboard.startupPromise;
});
