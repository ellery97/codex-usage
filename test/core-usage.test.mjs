import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  aggregate,
  buildUsagePayload,
  parseArgs,
  scanSessionFile,
} from "../bin/codex-token-usage.mjs";

test("parseArgs applies stable group sorting defaults", () => {
  const day = parseArgs(["--sessions", "/tmp/sessions", "--group", "day"]);
  assert.equal(day.sort, "key");
  assert.equal(day.desc, false);

  const model = parseArgs(["--sessions", "/tmp/sessions", "--group", "model"]);
  assert.equal(model.sort, "total");
  assert.equal(model.desc, true);

  const explicit = parseArgs([
    "--sessions",
    "/tmp/sessions",
    "--group",
    "model",
    "--sort",
    "cost",
    "--asc",
  ]);
  assert.equal(explicit.sort, "cost");
  assert.equal(explicit.desc, false);
});

test("scanSessionFile restores context, skips duplicate cumulative totals, and falls back to deltas", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-scan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "rollout-session-a.jsonl");

  const firstTotal = usage(1_000, 400, 100, 20, 1_100);
  const secondTotal = usage(1_600, 500, 180, 30, 1_780);
  const lines = [
    {
      timestamp: "2026-08-20T00:00:00.000Z",
      type: "session_meta",
      payload: { id: "session-a", cwd: "/workspace/project" },
    },
    {
      timestamp: "2026-08-20T00:00:00.100Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-sol", cwd: "/workspace/project" },
    },
    tokenEvent("2026-08-20T00:00:01.000Z", firstTotal, firstTotal),
    tokenEvent("2026-08-20T00:00:01.500Z", firstTotal, firstTotal),
    tokenEvent("2026-08-20T00:00:02.000Z", secondTotal, null),
    '{"type":"event_msg","payload":{"type":"token_count"',
  ];

  await writeFile(
    file,
    `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`,
  );

  const scanned = await scanSessionFile(file);
  assert.equal(scanned.session.id, "session-a");
  assert.equal(scanned.events.length, 2);
  assert.equal(scanned.stats.tokenEvents, 3);
  assert.equal(scanned.stats.duplicateTokenEvents, 1);
  assert.equal(scanned.stats.parseErrors, 1);
  assert.equal(scanned.events[0].model, "gpt-5.6-sol");
  assert.equal(scanned.events[0].cwd, "/workspace/project");
  assert.deepEqual(scanned.events[1].usage, usage(600, 100, 80, 10, 680));
});

test("buildUsagePayload globally deduplicates copied historical token events", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-global-dedupe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const total = usage(2_000, 800, 200, 40, 2_200);
  for (const [name, sessionId] of [
    ["a.jsonl", "session-a"],
    ["b.jsonl", "session-b"],
  ]) {
    await writeFile(
      path.join(directory, name),
      `${[
        {
          timestamp: "2026-08-20T00:00:00.000Z",
          type: "session_meta",
          payload: { id: sessionId, cwd: "/workspace/project" },
        },
        {
          timestamp: "2026-08-20T00:00:00.100Z",
          type: "turn_context",
          payload: { model: "gpt-5.6-sol", cwd: "/workspace/project" },
        },
        tokenEvent("2026-08-20T00:00:01.000Z", total, total),
      ]
        .map(JSON.stringify)
        .join("\n")}\n`,
    );
  }

  const options = parseArgs([
    "--sessions",
    directory,
    "--group",
    "none",
    "--dedupe-scope",
    "global",
    "--no-refresh-pricing",
  ]);
  const payload = await buildUsagePayload(options);
  assert.equal(payload.totals.requests, 1);
  assert.equal(payload.totals.total_tokens, 2_200);
  assert.equal(payload.stats.globalDuplicateTokenEvents, 1);
});

test("aggregate keeps usage subsets out of total token arithmetic", () => {
  const result = aggregate(
    [
      {
        timestampMs: Date.parse("2026-08-20T00:00:01.000Z"),
        sessionCreatedAtMs: Date.parse("2026-08-20T00:00:00.000Z"),
        sessionId: "session-a",
        cwd: "/workspace/project",
        model: "gpt-5.6-sol",
        usage: usage(1_000, 400, 100, 20, 1_100),
      },
    ],
    { group: "model", timezone: "UTC", sort: "total", desc: true, limit: 0 },
  );

  assert.equal(result.totals.total_tokens, 1_100);
  assert.equal(result.totals.uncached_input_tokens, 600);
  assert.equal(result.totals.cache_hit_ratio, 0.4);
  assert.equal(result.rows[0].key, "gpt-5.6-sol");
});

function usage(input, cached, output, reasoning, total) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total,
  };
}

function tokenEvent(timestamp, totalUsage, lastUsage) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: totalUsage,
        ...(lastUsage ? { last_token_usage: lastUsage } : {}),
      },
    },
  };
}
