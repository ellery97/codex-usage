import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { scanSessionFile, SESSION_SCANNER_VERSION } from "../bin/codex-token-usage.mjs";
import {
  closeUsageIndex,
  ensureFreshIndex,
  openUsageIndex,
  usagePayloadFromIndex,
} from "../bin/usage-index.mjs";

test("scanner backfills a model that is applied after the first token events", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-thread-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "rollout.jsonl");

  const firstTotal = usage(100, 10);
  const secondTotal = usage(160, 25);
  const thirdTotal = usage(220, 40);
  const lines = [
    sessionMeta("session-thread-settings", "/workspace/project"),
    tokenEvent("2026-08-20T00:00:01.000Z", firstTotal, firstTotal),
    threadSettings("gpt-5.6-sol"),
    tokenEvent("2026-08-20T00:00:02.000Z", secondTotal, null),
    {
      timestamp: "2026-08-20T00:00:02.500Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-terra", cwd: "/workspace/project" },
    },
    tokenEvent("2026-08-20T00:00:03.000Z", thirdTotal, null),
  ];
  await writeFile(file, `${lines.map(JSON.stringify).join("\n")}\n`);

  const scanned = await scanSessionFile(file);
  assert.equal(SESSION_SCANNER_VERSION, 4);
  assert.equal(scanned.events.length, 3);
  assert.deepEqual(
    scanned.events.map((event) => event.model),
    ["gpt-5.6-sol", "gpt-5.6-sol", "gpt-5.6-terra"],
  );
  assert.equal(scanned.events[0].cwd, "/workspace/project");
  assert.equal(scanned.incrementalSafe, true);
  assert.equal(scanned.state.scannerVersion, SESSION_SCANNER_VERSION);
});

test("scanner backfills other late session context without overwriting later known values", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-late-context-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "late-context.jsonl");
  const total = usage(100, 10);

  await writeFile(
    file,
    `${[
      tokenEvent(null, total, total),
      sessionMeta("authoritative-session", "/workspace/late"),
      threadSettings("gpt-5.6-sol"),
    ]
      .map(JSON.stringify)
      .join("\n")}\n`,
  );

  const scanned = await scanSessionFile(file);
  assert.equal(scanned.events.length, 1);
  assert.equal(scanned.events[0].sessionId, "authoritative-session");
  assert.equal(scanned.events[0].sessionCreatedAtMs, Date.parse("2026-08-20T00:00:00.000Z"));
  assert.equal(scanned.events[0].timestampMs, Date.parse("2026-08-20T00:00:00.000Z"));
  assert.equal(scanned.events[0].cwd, "/workspace/late");
  assert.equal(scanned.events[0].model, "gpt-5.6-sol");
  assert.equal(scanned.incrementalSafe, true);
});

test("index fully rescans when late model context crosses an incremental boundary", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-late-model-index-"));
  let index = null;
  t.after(async () => {
    closeUsageIndex(index);
    await rm(directory, { recursive: true, force: true });
  });
  const sessionsDir = path.join(directory, "sessions");
  const sessionFile = path.join(sessionsDir, "rollout.jsonl");
  const dbPath = path.join(directory, "cache.sqlite");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    sessionFile,
    `${[
      sessionMeta("late-model", "/workspace/project"),
      tokenEvent("2026-08-20T00:00:01.000Z", usage(100, 10), usage(100, 10)),
    ]
      .map(JSON.stringify)
      .join("\n")}\n`,
  );

  index = await openUsageIndex({ dbPath, scanCheckTtlMs: 0, enableGc: false });
  const options = usageOptions(sessionsDir);

  const firstSync = await ensureFreshIndex(index, [sessionsDir]);
  const firstPayload = usagePayloadFromIndex(index, firstSync, options);
  assert.equal(firstPayload.rows[0].key, "(unknown model)");
  assert.equal(index.db.prepare("SELECT scanner_version FROM files").get().scanner_version, 4);
  assert.equal(
    JSON.parse(index.db.prepare("SELECT parser_state_json FROM files").get().parser_state_json)
      .incrementalSafe,
    false,
  );

  await appendFile(sessionFile, `${JSON.stringify(threadSettings("gpt-5.6-sol"))}\n`);
  const correctedSync = await ensureFreshIndex(index, [sessionsDir]);
  const corrected = usagePayloadFromIndex(index, correctedSync, options);
  assert.equal(correctedSync.fullRescanFiles, 1);
  assert.equal(correctedSync.incrementalFiles, 0);
  assert.equal(corrected.rows.length, 1);
  assert.equal(corrected.rows[0].key, "gpt-5.6-sol");
  assert.equal(corrected.unpricedModels.some((row) => row.model === "(unknown model)"), false);

  await appendFile(
    sessionFile,
    `${JSON.stringify(tokenEvent("2026-08-20T00:00:02.000Z", usage(160, 25), null))}\n`,
  );
  const incrementalSync = await ensureFreshIndex(index, [sessionsDir]);
  const finalPayload = usagePayloadFromIndex(index, incrementalSync, options);
  assert.equal(incrementalSync.incrementalFiles, 1);
  assert.equal(incrementalSync.fullRescanFiles, 0);
  assert.equal(finalPayload.totals.requests, 2);
  assert.equal(finalPayload.rows[0].key, "gpt-5.6-sol");
});

function usageOptions(sessionsDir) {
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

function sessionMeta(id, cwd) {
  return {
    timestamp: "2026-08-20T00:00:00.000Z",
    type: "session_meta",
    payload: { id, cwd },
  };
}

function threadSettings(model) {
  return {
    timestamp: "2026-08-20T00:00:01.500Z",
    type: "event_msg",
    payload: {
      type: "thread_settings_applied",
      thread_settings: { model },
    },
  };
}

function tokenEvent(timestamp, totalUsage, lastUsage) {
  return {
    ...(timestamp ? { timestamp } : {}),
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
