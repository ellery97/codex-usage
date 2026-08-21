#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeUsageIndex, openUsageIndex, usagePayloadFromIndex } from "./usage-index.mjs";

const uniqueEvents = positiveInteger(process.env.CODEX_USAGE_BENCH_UNIQUE, 10_000);
const copies = positiveInteger(process.env.CODEX_USAGE_BENCH_COPIES, 20);
const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-benchmark-"));
const sessionsDir = path.join(directory, "sessions");
const dbPath = path.join(directory, "cache.sqlite");
const index = await openUsageIndex({ dbPath, enableGc: false });

try {
  const generatedAt = Date.now();
  const insertFile = index.db.prepare(`
    INSERT INTO files (
      path, size, mtime_ms, events_count, duplicate_token_events, parse_errors, raw_token_events,
      scanned_at_ms, scan_offset, parser_state_json, scanner_version, file_dev, file_ino, boundary_hash
    ) VALUES (?, 1, ?, ?, 0, 0, ?, ?, 0, NULL, 0, NULL, NULL, NULL)
  `);
  const insertEvent = index.db.prepare(`
    INSERT INTO events (
      file_path, event_index, timestamp_ms, session_created_at_ms, session_id, total_usage_key,
      cwd, model, input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
      reasoning_output_tokens, total_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const generationStartedAt = performance.now();
  index.db.exec("BEGIN IMMEDIATE");
  try {
    for (let copy = 0; copy < copies; copy += 1) {
      const filePath = path.join(sessionsDir, `copy-${String(copy).padStart(3, "0")}.jsonl`);
      insertFile.run(filePath, generatedAt, uniqueEvents, uniqueEvents, generatedAt);
      for (let eventIndex = 0; eventIndex < uniqueEvents; eventIndex += 1) {
        const input = 1_000 + eventIndex;
        const output = 100 + (eventIndex % 100);
        insertEvent.run(
          filePath,
          eventIndex,
          generatedAt - eventIndex * 1000,
          generatedAt - uniqueEvents * 1000,
          `session-${copy}`,
          `${input}:0:0:${output}:0:${input + output}`,
          `/benchmark/${copy}`,
          copy % 5 === 0 ? "codex-auto-review" : "gpt-5.6-luna",
          input,
          0,
          0,
          output,
          0,
          input + output,
        );
      }
    }
    index.db.exec("COMMIT");
  } catch (error) {
    index.db.exec("ROLLBACK");
    throw error;
  }
  const generationDurationMs = Math.round(performance.now() - generationStartedAt);

  const syncStats = {
    files: copies,
    filesWithUsage: copies,
    duplicateTokenEvents: 0,
    parseErrors: 0,
    rawTokenEvents: uniqueEvents * copies,
    indexedEvents: uniqueEvents * copies,
    changedFiles: 0,
    deletedFiles: 0,
    cacheFiles: copies,
    incrementalFiles: 0,
    fullRescanFiles: 0,
    scannedBytes: 0,
    scanDurationMs: 0,
    indexPath: dbPath,
  };
  const options = {
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

  const coldStartedAt = performance.now();
  const cold = usagePayloadFromIndex(index, syncStats, options);
  const coldDurationMs = Math.round(performance.now() - coldStartedAt);
  const warmStartedAt = performance.now();
  const warm = usagePayloadFromIndex(index, syncStats, options);
  const warmDurationMs = Math.round(performance.now() - warmStartedAt);

  console.log(
    JSON.stringify(
      {
        uniqueEvents,
        copies,
        indexedEvents: uniqueEvents * copies,
        generationDurationMs,
        coldDurationMs,
        coldDedupeDurationMs: cold.stats.dedupeDurationMs,
        coldAggregationDurationMs: cold.stats.aggregationDurationMs,
        warmDurationMs,
        warmDedupeDurationMs: warm.stats.dedupeDurationMs,
        warmAggregationDurationMs: warm.stats.aggregationDurationMs,
      },
      null,
      2,
    ),
  );
} finally {
  closeUsageIndex(index);
  await rm(directory, { recursive: true, force: true });
}

function positiveInteger(value, fallback) {
  const parsed = Number(value || fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}
