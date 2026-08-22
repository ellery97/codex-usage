import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "../bin/codex-token-usage.mjs";
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
    all: [path.resolve("/cached/all")],
    local: [path.resolve("/cached/local")],
    wsl: [path.resolve("/cached/wsl")],
    windows: [path.resolve("/cached/windows")],
  };

  await runUsage(queryService, new URLSearchParams({ refreshIndex: "0" }), sourceRegistry);
  await runUsage(queryService, new URLSearchParams({ sourceScope: "windows" }), sourceRegistry);
  await runUsage(queryService, new URLSearchParams({ sourceScope: "wsl" }), sourceRegistry);
  assert.equal(calls[0].queryPolicy.refreshIndex, false);
  assert.deepEqual(calls[0].queryOptions.sessionsDirs, sourceRegistry.all);
  assert.equal(calls[1].queryPolicy.refreshIndex, true);
  assert.deepEqual(calls[1].queryOptions.sessionsDirs, sourceRegistry.windows);
  assert.deepEqual(calls[2].queryOptions.sessionsDirs, sourceRegistry.wsl);
});

test("empty registered source stays empty instead of falling back to auto-discovery", () => {
  const sourceRegistry = { all: [], local: [], wsl: [], windows: [] };
  const options = optionsFromQuery(new URLSearchParams({ sourceScope: "wsl" }), { sourceRegistry });
  assert.deepEqual(options.sessionsDirs, []);
  assert.equal(options.sessionsExplicit, true);
});

test("rolling web ranges reuse one minute bucket and expire at the next minute", async (t) => {
  const fixture = await usageFixture(t);
  const { index } = fixture;
  await ensureFreshIndex(index, [fixture.sessionsDir], { force: true });
  const service = createUsageQueryService(index);
  const searchParams = new URLSearchParams({
    sourceScope: "all",
    range: "24h",
    group: "model",
    refreshIndex: "0",
  });
  const sourceRegistry = { all: [fixture.sessionsDir] };

  const firstOptions = optionsFromQuery(searchParams, {
    sourceRegistry,
    nowMs: Date.parse("2026-08-21T12:34:05.000Z"),
  });
  const sameBucketOptions = optionsFromQuery(searchParams, {
    sourceRegistry,
    nowMs: Date.parse("2026-08-21T12:34:59.999Z"),
  });
  const nextBucketOptions = optionsFromQuery(searchParams, {
    sourceRegistry,
    nowMs: Date.parse("2026-08-21T12:35:00.000Z"),
  });
  assert.equal(firstOptions.fromMs, Date.parse("2026-08-20T12:34:00.000Z"));
  assert.equal(sameBucketOptions.fromMs, firstOptions.fromMs);
  assert.equal(nextBucketOptions.fromMs, firstOptions.fromMs + 60_000);

  const first = await service.query(firstOptions, { refreshIndex: false });
  const sameBucket = await service.query(sameBucketOptions, { refreshIndex: false });
  const nextBucket = await service.query(nextBucketOptions, { refreshIndex: false });
  assert.equal(first.stats.queryCacheHit, false);
  assert.equal(sameBucket.stats.queryCacheHit, true);
  assert.equal(nextBucket.stats.queryCacheHit, false);
  assert.equal(nextBucket.stats.costCacheHit, false);
});

test("today follows the target timezone across midnight and DST regardless of argument order", async (t) => {
  const timezone = "America/Los_Angeles";
  const beforeMidnight = Date.parse("2026-03-09T06:59:59.999Z");
  const afterMidnight = Date.parse("2026-03-09T07:00:00.000Z");
  const todayFirst = parseArgs(["--today", "--timezone", timezone], { nowMs: beforeMidnight });
  const timezoneFirst = parseArgs(["--timezone", timezone, "--today"], {
    nowMs: beforeMidnight,
  });
  const nextDay = parseArgs(["--today", "--timezone", timezone], { nowMs: afterMidnight });
  assert.equal(todayFirst.fromMs, Date.parse("2026-03-08T08:00:00.000Z"));
  assert.equal(timezoneFirst.fromMs, todayFirst.fromMs);
  assert.equal(nextDay.fromMs, Date.parse("2026-03-09T07:00:00.000Z"));
  assert.equal(nextDay.fromMs - todayFirst.fromMs, 23 * 60 * 60 * 1000);

  const fixture = await usageFixture(t);
  const { index } = fixture;
  await ensureFreshIndex(index, [fixture.sessionsDir], { force: true });
  const service = createUsageQueryService(index);
  const base = options(fixture.sessionsDir);
  const first = await service.query(
    { ...base, rangeKey: "today", timezone, fromMs: todayFirst.fromMs },
    { refreshIndex: false },
  );
  const repeated = await service.query(
    { ...base, rangeKey: "today", timezone, fromMs: timezoneFirst.fromMs },
    { refreshIndex: false },
  );
  const rolled = await service.query(
    { ...base, rangeKey: "today", timezone, fromMs: nextDay.fromMs },
    { refreshIndex: false },
  );
  assert.equal(first.stats.queryCacheHit, false);
  assert.equal(repeated.stats.queryCacheHit, true);
  assert.equal(rolled.stats.queryCacheHit, false);
});

test("absolute and unbounded web ranges do not depend on the injected clock", () => {
  const sourceRegistry = { all: ["/cached/all"] };
  const firstNow = Date.parse("2026-08-21T00:00:00.000Z");
  const laterNow = Date.parse("2027-01-01T00:00:00.000Z");
  const allFirst = optionsFromQuery(new URLSearchParams({ range: "all" }), {
    sourceRegistry,
    nowMs: firstNow,
  });
  const allLater = optionsFromQuery(new URLSearchParams({ range: "all" }), {
    sourceRegistry,
    nowMs: laterNow,
  });
  assert.equal(allFirst.fromMs, null);
  assert.equal(allLater.fromMs, null);

  const customParams = new URLSearchParams({
    range: "custom",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-20T00:00:00.000Z",
  });
  const customFirst = optionsFromQuery(customParams, { sourceRegistry, nowMs: firstNow });
  const customLater = optionsFromQuery(customParams, { sourceRegistry, nowMs: laterNow });
  assert.equal(customFirst.fromMs, customLater.fromMs);
  assert.equal(customFirst.toMs, customLater.toMs);
});

test("cache-only filters keep the indexed snapshot until an explicit refresh", async (t) => {
  const fixture = await usageFixture(t);
  const { index } = fixture;
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
  const { index } = fixture;
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
  const { index } = fixture;
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
  let dashboard = null;
  t.after(async () => {
    closeUsageIndex(dashboard?.usageIndex);
    await rm(directory, { recursive: true, force: true });
  });
  const previousCodexHome = process.env.CODEX_HOME;
  const previousSessions = process.env.CODEX_USAGE_SESSIONS;
  process.env.CODEX_HOME = directory;
  t.after(() => {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });

  const sessionsDir = path.join(directory, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  process.env.CODEX_USAGE_SESSIONS = sessionsDir;
  t.after(() => {
    if (previousSessions == null) delete process.env.CODEX_USAGE_SESSIONS;
    else process.env.CODEX_USAGE_SESSIONS = previousSessions;
  });
  await writeFile(
    path.join(sessionsDir, "rollout.jsonl"),
    sessionText("fresh-model", "new-valid-model", directory, usage(100, 10)),
  );
  let refreshedModels = null;
  dashboard = await initializeDashboard({
    dbPath: path.join(directory, "cache.sqlite"),
    enableGc: false,
    initializePricingImpl: async () => {},
    refreshPricingImpl: async ({ models }) => {
      refreshedModels = models;
      return { warning: null, refreshStatus: "fresh" };
    },
  });

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
  let index = null;
  t.after(async () => {
    closeUsageIndex(index);
    await rm(directory, { recursive: true, force: true });
  });
  const sessionsDir = path.join(directory, "sessions");
  const sessionFile = path.join(sessionsDir, "rollout.jsonl");
  const dbPath = path.join(directory, "cache.sqlite");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(sessionFile, sessionText("session", "gpt-5.6-luna", directory, usage(100, 10)));
  index = await openUsageIndex({ dbPath, scanCheckTtlMs: 0, enableGc: false });
  return { directory, sessionsDir, sessionFile, dbPath, index };
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
