import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDashboard, optionsFromQuery, runUsage } from "../bin/codex-usage-server.mjs";
import { closeUsageIndex, ensureFreshIndex, openUsageIndex } from "../bin/usage-index.mjs";
import { createUsageQueryService } from "../bin/usage-query.mjs";

test("API defaults to index refresh while refreshIndex=0 uses registered source roots", async () => {
  const calls = [];
  const queryService = {
    async query(queryOptions, queryPolicy) {
      calls.push({ queryOptions, queryPolicy });
      return { ok: true };
    },
  };
  const sourceRegistry = {
    all: ["/cached/all"],
    local: ["/cached/local"],
    windows: ["/cached/windows"],
  };

  await runUsage(queryService, new URLSearchParams({ refreshIndex: "0" }), sourceRegistry);
  await runUsage(queryService, new URLSearchParams({ sourceScope: "windows" }), sourceRegistry);
  assert.equal(calls[0].queryPolicy.refreshIndex, false);
  assert.deepEqual(calls[0].queryOptions.sessionsDirs, ["/cached/all"]);
  assert.equal(calls[1].queryPolicy.refreshIndex, true);
  assert.deepEqual(calls[1].queryOptions.sessionsDirs, ["/cached/windows"]);
});

test("cache-only filters keep the indexed snapshot until an explicit refresh", async (t) => {
  const fixture = await usageFixture(t);
  const index = await openUsageIndex({ dbPath: fixture.dbPath, scanCheckTtlMs: 0, enableGc: false });
  t.after(() => closeUsageIndex(index));
  await ensureFreshIndex(index, [fixture.sessionsDir], { force: true });
  const service = createUsageQueryService(index);

  const first = await service.query(options(fixture.sessionsDir), { refreshIndex: false });
  assert.equal(first.totals.requests, 1);
  assert.equal(first.stats.indexRefreshSkipped, true);
  assert.equal(first.stats.queryCacheHit, false);
  assert.equal(first.stats.costCacheHit, false);

  const repeated = await service.query(options(fixture.sessionsDir), { refreshIndex: false });
  assert.equal(repeated.totals.requests, 1);
  assert.equal(repeated.stats.queryCacheHit, true);
  assert.equal(repeated.stats.scanDurationMs, 0);
  assert.equal(repeated.stats.dedupeDurationMs, 0);
  assert.equal(repeated.stats.aggregationDurationMs, 0);

  await appendFile(
    fixture.sessionFile,
    `${JSON.stringify(tokenEvent("2026-08-21T00:00:02.000Z", usage(200, 20), usage(100, 10)))}\n`,
  );
  const stale = await service.query(options(fixture.sessionsDir), { refreshIndex: false });
  assert.equal(stale.totals.requests, 1);
  assert.equal(stale.stats.queryCacheHit, true);

  const refreshed = await service.query(options(fixture.sessionsDir), { refreshIndex: true });
  assert.equal(refreshed.totals.requests, 2);
  assert.equal(refreshed.stats.indexRefreshSkipped, false);
  assert.equal(refreshed.stats.queryCacheHit, false);
  assert.equal(refreshed.stats.costCacheHit, false);
  assert.equal(refreshed.stats.incrementalFiles, 1);
});

test("group, sort, and limit changes reuse one costed event slice", async (t) => {
  const fixture = await usageFixture(t);
  const index = await openUsageIndex({ dbPath: fixture.dbPath, scanCheckTtlMs: 0, enableGc: false });
  t.after(() => closeUsageIndex(index));
  await ensureFreshIndex(index, [fixture.sessionsDir], { force: true });
  const service = createUsageQueryService(index);

  const first = await service.query(options(fixture.sessionsDir), { refreshIndex: false });
  const regrouped = await service.query(
    { ...options(fixture.sessionsDir), group: "cwd", sort: "key", desc: false, limit: 1 },
    { refreshIndex: false },
  );
  assert.equal(first.stats.costCacheHit, false);
  assert.equal(regrouped.stats.queryCacheHit, false);
  assert.equal(regrouped.stats.costCacheHit, true);
  assert.equal(regrouped.totals.total_tokens, first.totals.total_tokens);

  const fileScoped = await service.query(
    { ...options(fixture.sessionsDir), dedupeScope: "file" },
    { refreshIndex: false },
  );
  assert.equal(fileScoped.stats.costCacheHit, false);
});

test("query result cache evicts the least recently used entry", async (t) => {
  const fixture = await usageFixture(t);
  const index = await openUsageIndex({ dbPath: fixture.dbPath, scanCheckTtlMs: 0, enableGc: false });
  t.after(() => closeUsageIndex(index));
  await ensureFreshIndex(index, [fixture.sessionsDir], { force: true });
  const service = createUsageQueryService(index, { maxEntries: 2 });
  const base = options(fixture.sessionsDir);

  await service.query({ ...base, limit: 1 }, { refreshIndex: false });
  await service.query({ ...base, limit: 2 }, { refreshIndex: false });
  await service.query({ ...base, limit: 3 }, { refreshIndex: false });
  assert.equal(service.size, 2);
  const evicted = await service.query({ ...base, limit: 1 }, { refreshIndex: false });
  assert.equal(evicted.stats.queryCacheHit, false);
  assert.equal(evicted.stats.costCacheHit, true);
});

test("web startup indexes logs before refreshing newly observed models", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-dashboard-startup-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = directory;
  t.after(() => {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });

  const sessionsDir = path.join(directory, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    path.join(sessionsDir, "rollout.jsonl"),
    sessionText("fresh-model", "new-valid-model", directory, usage(100, 10)),
  );
  let refreshedModels = null;
  const dashboard = await initializeDashboard({
    dbPath: path.join(directory, "cache.sqlite"),
    enableGc: false,
    initializePricingImpl: async () => {},
    refreshPricingImpl: async ({ models }) => {
      refreshedModels = models;
      return { warning: null, refreshStatus: "fresh" };
    },
  });
  t.after(() => closeUsageIndex(dashboard.usageIndex));

  assert.equal(dashboard.startupSync.changedFiles, 1);
  assert.deepEqual(refreshedModels, ["new-valid-model"]);
  const warmedOptions = optionsFromQuery(
    new URLSearchParams({
      sourceScope: "all",
      range: "7d",
      group: "day",
      sort: "key",
      desc: "1",
      limit: "60",
      dedupeScope: "global",
    }),
  );
  const warmed = await dashboard.queryService.query(warmedOptions, { refreshIndex: false });
  assert.equal(warmed.stats.queryCacheHit, true);
});

async function usageFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-query-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionsDir = path.join(directory, "sessions");
  const sessionFile = path.join(sessionsDir, "rollout.jsonl");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(sessionFile, sessionText("session", "gpt-5.6-luna", directory, usage(100, 10)));
  return { directory, sessionsDir, sessionFile, dbPath: path.join(directory, "cache.sqlite") };
}

function options(sessionsDir) {
  return {
    sessionsDirs: [sessionsDir],
    fromMs: null,
    toMs: null,
    group: "model",
    sort: "total",
    desc: true,
    limit: 0,
    dedupeScope: "global",
    timezone: "UTC",
    sourceScope: "all",
    rangeKey: "all",
  };
}

function usage(inputTokens, outputTokens) {
  return {
    input_tokens: inputTokens,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: outputTokens,
    reasoning_output_tokens: 0,
    total_tokens: inputTokens + outputTokens,
  };
}

function tokenEvent(timestamp, totalUsage, lastUsage) {
  return {
    timestamp,
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: totalUsage, last_token_usage: lastUsage } },
  };
}

function sessionText(id, model, cwd, eventUsage) {
  return `${[
    { timestamp: "2026-08-21T00:00:00.000Z", type: "session_meta", payload: { id, cwd } },
    { timestamp: "2026-08-21T00:00:00.000Z", type: "turn_context", payload: { model, cwd } },
    tokenEvent("2026-08-21T00:00:01.000Z", eventUsage, eventUsage),
  ]
    .map((line) => JSON.stringify(line))
    .join("\n")}\n`;
}
