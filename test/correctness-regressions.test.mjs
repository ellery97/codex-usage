import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildUsagePayload, parseArgs } from "../bin/codex-token-usage.mjs";

const firstUsage = {
  input_tokens: 1_000,
  cached_input_tokens: 200,
  cache_write_input_tokens: 0,
  output_tokens: 100,
  reasoning_output_tokens: 20,
  total_tokens: 1_100,
};

test("direct and SQLite global dedupe choose the same representative across reversed roots", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-canonical-parity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const aDir = path.join(directory, "a-sessions");
  const zDir = path.join(directory, "z-sessions");
  const dbPath = path.join(directory, "cache.sqlite");
  await mkdir(aDir, { recursive: true });
  await mkdir(zDir, { recursive: true });

  await writeFile(
    path.join(aDir, "rollout.jsonl"),
    sessionText("session-a", "gpt-5.6-sol", "/workspace/a", firstUsage),
  );
  await writeFile(
    path.join(zDir, "rollout.jsonl"),
    sessionText("session-z", "gpt-5.6-terra", "/workspace/z", firstUsage),
  );

  const options = parseArgs([
    "--sessions",
    zDir,
    "--sessions",
    aDir,
    "--group",
    "model",
    "--dedupe-scope",
    "global",
    "--no-refresh-pricing",
  ]);
  const direct = await buildUsagePayload(options);
  const cached = await buildUsagePayload({ ...options, useCache: true, cacheDbPath: dbPath });

  assert.equal(direct.totals.requests, 1);
  assert.equal(cached.totals.requests, 1);
  assert.equal(direct.rows[0].key, "gpt-5.6-sol");
  assert.deepEqual(cached.totals, direct.totals);
  assert.deepEqual(cached.rows, direct.rows);
  assert.deepEqual(cached.unpricedModels, direct.unpricedModels);
  assert.equal(direct.stats.globalDuplicateTokenEvents, 1);
  assert.equal(cached.stats.globalDuplicateTokenEvents, 1);
});

test("all-time queries retain truly unknown timestamps as unpriced usage", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-unknown-time-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionsDir = path.join(directory, "sessions");
  const dbPath = path.join(directory, "cache.sqlite");
  await mkdir(sessionsDir, { recursive: true });

  await writeFile(
    path.join(sessionsDir, "rollout.jsonl"),
    `${[
      {
        timestamp: "2026-08-20T00:00:00.100Z",
        type: "turn_context",
        payload: { model: "gpt-5.6-sol", cwd: "/workspace/unknown-time" },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: firstUsage, last_token_usage: firstUsage },
        },
      },
    ].map(JSON.stringify).join("\n")}\n`,
  );

  const modelOptions = parseArgs([
    "--sessions",
    sessionsDir,
    "--group",
    "model",
    "--no-refresh-pricing",
  ]);
  const direct = await buildUsagePayload(modelOptions);
  const cached = await buildUsagePayload({ ...modelOptions, useCache: true, cacheDbPath: dbPath });

  for (const payload of [direct, cached]) {
    assert.equal(payload.totals.requests, 1);
    assert.equal(payload.totals.unpriced_requests, 1);
    assert.equal(payload.totals.unpriced_total_tokens, firstUsage.total_tokens);
    assert.equal(payload.rows[0].key, "gpt-5.6-sol");
    assert.equal(payload.stats.unknownTimestampEvents, 1);
    assert.equal(payload.stats.unknownTimestampTokens, firstUsage.total_tokens);
    assert.equal(payload.stats.excludedUnknownTimestampEvents, 0);
    assert.equal(payload.unpricedModels[0].model, "gpt-5.6-sol");
    assert.equal(payload.unpricedModels[0].first_seen, null);
  }
  assert.deepEqual(cached.totals, direct.totals);
  assert.deepEqual(cached.rows, direct.rows);

  const dayOptions = { ...modelOptions, group: "day", sort: "key", desc: false };
  const directDay = await buildUsagePayload(dayOptions);
  const cachedDay = await buildUsagePayload({ ...dayOptions, useCache: true, cacheDbPath: dbPath });
  assert.equal(directDay.rows[0].key, "(unknown time)");
  assert.deepEqual(cachedDay.rows, directDay.rows);
});

test("bounded time ranges report truly unknown timestamps as explicitly excluded", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-unknown-time-range-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionsDir = path.join(directory, "sessions");
  const dbPath = path.join(directory, "cache.sqlite");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    path.join(sessionsDir, "rollout.jsonl"),
    `${[
      {
        type: "turn_context",
        payload: { model: "gpt-5.6-sol", cwd: "/workspace/unknown-time" },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: firstUsage, last_token_usage: firstUsage },
        },
      },
    ].map(JSON.stringify).join("\n")}\n`,
  );

  const options = parseArgs([
    "--sessions",
    sessionsDir,
    "--from",
    "2026-08-01",
    "--timezone",
    "UTC",
    "--group",
    "model",
    "--no-refresh-pricing",
  ]);
  const direct = await buildUsagePayload(options);
  const cached = await buildUsagePayload({ ...options, useCache: true, cacheDbPath: dbPath });

  for (const payload of [direct, cached]) {
    assert.equal(payload.totals.requests, 0);
    assert.equal(payload.stats.unknownTimestampEvents, 1);
    assert.equal(payload.stats.unknownTimestampTokens, firstUsage.total_tokens);
    assert.equal(payload.stats.excludedUnknownTimestampEvents, 1);
    assert.equal(payload.stats.excludedUnknownTimestampTokens, firstUsage.total_tokens);
  }
  assert.deepEqual(cached.totals, direct.totals);
  assert.deepEqual(cached.rows, direct.rows);
});

test("README contracts match read-only GET and scanner context behavior", () => {
  const zh = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const en = readFileSync(new URL("../README.en.md", import.meta.url), "utf8");

  assert.match(zh, /event_msg\.thread_settings_applied/);
  assert.match(zh, /POST \/api\/index\/refresh/);
  assert.match(zh, /缺省为 `0`/);
  assert.match(zh, /excludedUnknownTimestampEvents/);

  assert.match(en, /event_msg\.thread_settings_applied/);
  assert.match(en, /POST \/api\/index\/refresh/);
  assert.match(en, /snapshot-only by default/);
  assert.match(en, /excludedUnknownTimestampEvents/);
});

function sessionText(id, model, cwd, usage) {
  return `${[
    {
      timestamp: "2026-08-20T00:00:00.000Z",
      type: "session_meta",
      payload: { id, cwd },
    },
    {
      timestamp: "2026-08-20T00:00:00.100Z",
      type: "turn_context",
      payload: { model, cwd },
    },
    {
      timestamp: "2026-08-20T00:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: usage, last_token_usage: usage },
      },
    },
  ].map(JSON.stringify).join("\n")}\n`;
}
