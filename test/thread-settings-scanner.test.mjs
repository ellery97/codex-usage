import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { scanSessionFile, SESSION_SCANNER_VERSION } from "../bin/codex-token-usage.mjs";

test("scanner uses thread_settings_applied model before the first turn_context", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-thread-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "rollout.jsonl");

  const firstUsage = usage(100, 10);
  const secondTotal = usage(160, 25);
  const lines = [
    {
      timestamp: "2026-08-20T00:00:00.000Z",
      type: "session_meta",
      payload: { id: "session-thread-settings", cwd: "/workspace/project" },
    },
    {
      timestamp: "2026-08-20T00:00:00.100Z",
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: { model: "gpt-5.6-sol" },
      },
    },
    tokenEvent("2026-08-20T00:00:01.000Z", firstUsage, firstUsage),
    {
      timestamp: "2026-08-20T00:00:02.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-terra", cwd: "/workspace/project" },
    },
    tokenEvent("2026-08-20T00:00:03.000Z", secondTotal, null),
  ];
  await writeFile(file, `${lines.map(JSON.stringify).join("\n")}\n`);

  const scanned = await scanSessionFile(file);
  assert.equal(SESSION_SCANNER_VERSION, 3);
  assert.equal(scanned.events.length, 2);
  assert.equal(scanned.events[0].model, "gpt-5.6-sol");
  assert.equal(scanned.events[1].model, "gpt-5.6-terra");
  assert.equal(scanned.events[0].cwd, "/workspace/project");
});

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
    payload: {
      type: "token_count",
      info: {
        total_token_usage: totalUsage,
        ...(lastUsage ? { last_token_usage: lastUsage } : {}),
      },
    },
  };
}
