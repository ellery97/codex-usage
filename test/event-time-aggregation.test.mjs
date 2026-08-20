import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  aggregate,
  emitCsv,
  scanSessionFile,
} from "../bin/codex-token-usage.mjs";

const execFileAsync = promisify(execFile);
const ORIGINAL_CSV_COLUMNS = [
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
];

test("appends event-time pricing fields without reordering existing CSV columns", () => {
  const headers = emitCsv([]).split(",");
  assert.deepEqual(headers.slice(0, ORIGINAL_CSV_COLUMNS.length), ORIGINAL_CSV_COLUMNS);
  assert.deepEqual(headers.slice(ORIGINAL_CSV_COLUMNS.length), [
    "cache_write_input_tokens",
    "assumed_cost_usd",
    "assumed_upper_bound_cost_usd",
    "reference_total_cost_usd",
    "reference_total_upper_bound_cost_usd",
    "assumed_requests",
    "assumed_total_tokens",
    "provisional_priced_requests",
    "provisional_priced_total_tokens",
    "provisional_estimated_cost_usd",
  ]);
});

test("preserves cache-write tokens from Codex JSONL logs", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-pricing-scan-"));
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

  const result = aggregate(scanned.events, aggregateOptions("none"));
  assert.equal(result.totals.cache_write_input_tokens, 300);
  assert.equal(result.totals.uncached_input_tokens, 500);
  assert.equal(result.totals.estimated_cost_usd, 0.001495);
  assert.equal(result.totals.reference_total_cost_usd, 0.001495);
});

test("keeps auto-review assumptions separate and splits route periods", () => {
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
  const result = aggregate(events, aggregateOptions("model"));

  assert.equal(result.totals.estimated_cost_usd, 0);
  assert.ok(Math.abs(result.totals.assumed_cost_usd - 0.432) < 1e-12);
  assert.equal(result.totals.assumed_upper_bound_cost_usd, 1.6);
  assert.equal(result.totals.assumed_requests, 2);
  assert.equal(result.totals.unpriced_requests, 0);
  assert.deepEqual(
    result.assumedModels[0].routes.map((route) => [route.assumedModel, route.requests]),
    [
      ["gpt-5.4", 1],
      ["gpt-5.6-luna", 1],
    ],
  );
});

test("keeps JSON stdout valid when startup pricing refresh falls back", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-pricing-warning-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [path.resolve("bin/codex-token-usage.mjs"), "--sessions", directory, "--group", "none", "--json"],
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

function aggregateOptions(group) {
  return {
    group,
    timezone: "UTC",
    sort: "cost",
    desc: true,
    limit: 0,
  };
}
