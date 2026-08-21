import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  aggregate,
  emitCsv,
  scanSessionFile,
  scanSessionFileRange,
} from "../bin/codex-token-usage.mjs";

const execFileAsync = promisify(execFile);

test("appends provisional price fields to the existing CSV columns", () => {
  const headers = emitCsv([]).split(",");
  assert.deepEqual(headers.slice(0, 15), [
    "group",
    "sessions",
    "requests",
    "input_tokens",
    "cached_input_tokens",
    "uncached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
    "estimated_cost_usd",
    "priced_requests",
    "unpriced_requests",
    "priced_total_tokens",
    "unpriced_total_tokens",
    "cache_hit_ratio",
  ]);
  assert.deepEqual(headers.slice(-3), [
    "provisional_priced_requests",
    "provisional_priced_total_tokens",
    "provisional_estimated_cost_usd",
  ]);
});

test("keeps JSON stdout valid when startup pricing falls back", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-json-warning-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      path.resolve("bin/codex-token-usage.mjs"),
      "--sessions",
      directory,
      "--group",
      "none",
      "--json",
    ],
    {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        CODEX_USAGE_PRICING_CACHE: path.join(directory, "pricing-history.json"),
        CODEX_USAGE_PRICING_REFRESH: "1",
        CODEX_USAGE_PRICING_TIMEOUT_MS: "1",
      },
      timeout: 10_000,
    },
  );
  assert.equal(JSON.parse(stdout).pricing.usedFallback, true);
  assert.match(stderr, /Pricing refresh failed/);
});

test("preserves cache-write tokens from Codex JSONL logs", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "rollout.jsonl");
  const usage = {
    input_tokens: 1_000,
    cached_input_tokens: 200,
    cache_write_input_tokens: 300,
    output_tokens: 100,
    reasoning_output_tokens: 40,
    total_tokens: 1_100,
  };
  const lines = [
    { timestamp: "2026-07-22T00:00:00.000Z", type: "session_meta", payload: { id: "session-1", cwd: directory } },
    { timestamp: "2026-07-22T00:00:00.000Z", type: "turn_context", payload: { model: "gpt-5.6-luna", cwd: directory } },
    { timestamp: "2026-07-22T00:00:01.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } } },
  ];
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

  const scanned = await scanSessionFile(file);
  assert.equal(scanned.events[0].usage.cache_write_input_tokens, 300);

  const result = aggregate(scanned.events, {
    group: "none",
    timezone: "UTC",
    sort: "total",
    desc: true,
    limit: 0,
  });
  assert.equal(result.totals.cache_write_input_tokens, 300);
  assert.equal(result.totals.uncached_input_tokens, 500);
  assert.equal(result.totals.estimated_cost_usd, 0.001495);
  assert.equal(result.totals.reference_total_cost_usd, 0.001495);
  assert.equal(result.totals.assumed_requests, 0);
});

test("aggregates codex-auto-review as an assumed model instead of an unpriced model", () => {
  const result = aggregate(
    [
      {
        timestampMs: Date.parse("2026-07-22T00:00:00.000Z"),
        sessionCreatedAtMs: Date.parse("2026-07-22T00:00:00.000Z"),
        sessionId: "review-session",
        cwd: "/tmp/review",
        model: "codex-auto-review",
        usage: {
          input_tokens: 100_000,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 10_000,
          reasoning_output_tokens: 5_000,
          total_tokens: 110_000,
        },
      },
    ],
    {
      group: "model",
      timezone: "UTC",
      sort: "cost",
      desc: true,
      limit: 0,
    },
  );

  assert.equal(result.totals.estimated_cost_usd, 0);
  assert.equal(result.totals.assumed_cost_usd, 0.4);
  assert.equal(result.totals.assumed_upper_bound_cost_usd, 0.8);
  assert.equal(result.totals.reference_total_cost_usd, 0.4);
  assert.equal(result.totals.reference_total_upper_bound_cost_usd, 0.8);
  assert.equal(result.totals.assumed_requests, 1);
  assert.equal(result.totals.unpriced_requests, 0);
  assert.equal(result.rows[0].reference_total_cost_usd, 0.4);
  assert.equal(result.assumedModels[0].assumedModel, "gpt-5.4");
  assert.equal(result.assumedModels[0].upperBoundModel, "gpt-5.6-sol");
  assert.equal(result.assumedModels[0].routes[0].effectiveFrom, "2026-04-23T00:00:00.000Z");
  assert.deepEqual(result.unpricedModels, []);
});

test("splits codex-auto-review reference estimates across routing periods", () => {
  const usage = {
    input_tokens: 100_000,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 10_000,
    reasoning_output_tokens: 0,
    total_tokens: 110_000,
  };
  const events = ["2026-07-22T00:00:00.000Z", "2026-08-01T00:00:00.000Z"].map(
    (timestamp, index) => ({
      timestampMs: Date.parse(timestamp),
      sessionCreatedAtMs: Date.parse(timestamp),
      sessionId: `review-${index}`,
      cwd: "/tmp/review",
      model: "codex-auto-review",
      usage,
    }),
  );
  const result = aggregate(events, {
    group: "model",
    timezone: "UTC",
    sort: "cost",
    desc: true,
    limit: 0,
  });
  assert.ok(Math.abs(result.totals.assumed_cost_usd - 0.432) < 1e-12);
  assert.equal(result.totals.assumed_upper_bound_cost_usd, 1.6);
  assert.deepEqual(
    result.assumedModels[0].routes.map((route) => [route.assumedModel, route.requests]),
    [
      ["gpt-5.4", 1],
      ["gpt-5.6-luna", 1],
    ],
  );
});

test("resumes a JSONL scan from a saved line boundary without changing events", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-range-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "rollout.jsonl");
  const firstUsage = {
    input_tokens: 100,
    cached_input_tokens: 20,
    cache_write_input_tokens: 0,
    output_tokens: 10,
    reasoning_output_tokens: 2,
    total_tokens: 110,
  };
  const secondTotal = {
    input_tokens: 160,
    cached_input_tokens: 30,
    cache_write_input_tokens: 0,
    output_tokens: 25,
    reasoning_output_tokens: 5,
    total_tokens: 185,
  };
  const lines = [
    { timestamp: "2026-08-19T00:00:00.000Z", type: "session_meta", payload: { id: "session-1", cwd: `${directory}/中文` } },
    { timestamp: "2026-08-19T00:00:00.000Z", type: "turn_context", payload: { model: "gpt-5.6-luna", cwd: `${directory}/中文` } },
    { timestamp: "2026-08-19T00:00:01.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: firstUsage, last_token_usage: firstUsage } } },
    { timestamp: "2026-08-19T00:00:02.000Z", type: "turn_context", payload: { model: "gpt-5.6-terra", cwd: `${directory}/续扫` } },
    { timestamp: "2026-08-19T00:00:03.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: firstUsage, last_token_usage: firstUsage } } },
    { timestamp: "2026-08-19T00:00:04.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: secondTotal } } },
  ];
  const text = lines.map((line) => JSON.stringify(line)).join("\n");
  await writeFile(file, text);
  const fileSize = (await stat(file)).size;
  const full = await scanSessionFile(file);
  const comparable = (events) =>
    events.map(({ timestampMs, sessionId, totalUsageKey, cwd, model, usage }) => ({
      timestampMs,
      sessionId,
      totalUsageKey,
      cwd,
      model,
      usage,
    }));
  const bytes = Buffer.from(text);
  const unicodeStart = bytes.indexOf(Buffer.from("中文"));
  const lineBoundary =
    Buffer.byteLength(lines.slice(0, 3).map((line) => JSON.stringify(line)).join("\n")) + 1;
  const partialEvent =
    Buffer.byteLength(lines.slice(0, 4).map((line) => JSON.stringify(line)).join("\n")) + 7;

  for (const splitOffset of [unicodeStart + 1, lineBoundary, partialEvent, fileSize - 1]) {
    const first = await scanSessionFileRange(file, { endOffset: splitOffset });
    const second = await scanSessionFileRange(file, {
      startOffset: first.processedOffset,
      endOffset: fileSize,
      state: first.state,
      seenTotals: new Set(first.events.map((event) => event.totalUsageKey)),
    });
    const combined = [...first.events, ...second.events];

    assert.deepEqual(comparable(combined), comparable(full.events), `split at byte ${splitOffset}`);
    assert.equal(first.stats.tokenEvents + second.stats.tokenEvents, full.stats.tokenEvents);
    assert.equal(
      first.stats.duplicateTokenEvents + second.stats.duplicateTokenEvents,
      full.stats.duplicateTokenEvents,
    );
    assert.equal(combined.at(-1).model, "gpt-5.6-terra");
    assert.equal(combined.at(-1).usage.input_tokens, 60);
    assert.equal(second.processedOffset, fileSize);
  }
});

test("stops at a fixed byte snapshot and leaves later appends for the next scan", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-snapshot-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "rollout.jsonl");
  const firstUsage = {
    input_tokens: 100,
    cached_input_tokens: 20,
    cache_write_input_tokens: 0,
    output_tokens: 10,
    reasoning_output_tokens: 2,
    total_tokens: 110,
  };
  const secondUsage = {
    input_tokens: 160,
    cached_input_tokens: 30,
    cache_write_input_tokens: 0,
    output_tokens: 25,
    reasoning_output_tokens: 5,
    total_tokens: 185,
  };
  const initialLines = [
    { timestamp: "2026-08-19T00:00:00.000Z", type: "session_meta", payload: { id: "snapshot", cwd: `${directory}/中文` } },
    { timestamp: "2026-08-19T00:00:00.000Z", type: "turn_context", payload: { model: "gpt-5.6-luna", cwd: `${directory}/中文` } },
    { timestamp: "2026-08-19T00:00:01.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: firstUsage, last_token_usage: firstUsage } } },
  ];
  await writeFile(file, `${initialLines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  const snapshotSize = (await stat(file)).size;
  const appendedLine = {
    timestamp: "2026-08-19T00:00:02.000Z",
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: secondUsage } },
  };
  await appendFile(file, `${JSON.stringify(appendedLine)}\n`);

  const first = await scanSessionFileRange(file, { endOffset: snapshotSize });
  assert.equal(first.events.length, 1);
  assert.equal(first.processedOffset, snapshotSize);

  const second = await scanSessionFileRange(file, {
    startOffset: first.processedOffset,
    endOffset: (await stat(file)).size,
    state: first.state,
    seenTotals: new Set(first.events.map((event) => event.totalUsageKey)),
  });
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].usage.input_tokens, 60);
  assert.equal(second.events[0].cwd, `${directory}/中文`);
});
