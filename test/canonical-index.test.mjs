import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { sqlPathFilter } from "../bin/path-utils.mjs";
import { ensureCanonicalScope } from "../bin/usage-canonical.mjs";
import { closeUsageIndex, openUsageIndex } from "../bin/usage-index.mjs";

test("canonical time ordering is covered by the index without a temporary sort", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-canonical-index-"));
  let index;
  t.after(async () => {
    closeUsageIndex(index);
    await rm(directory, { recursive: true, force: true });
  });
  index = await openUsageIndex({ dbPath: path.join(directory, "cache.sqlite"), enableGc: false });
  const filter = sqlPathFilter("e.file_path", [
    path.join(directory, "sessions"),
    path.join(directory, "archived_sessions"),
  ]);
  const plan = index.db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT id, total_usage_key FROM (
      SELECT e.id, e.total_usage_key,
        ROW_NUMBER() OVER (
          PARTITION BY e.total_usage_key
          ORDER BY e.has_event_timestamp DESC, e.timestamp_ms IS NULL, e.timestamp_ms, e.file_path COLLATE BINARY, e.event_index
        ) AS rn
      FROM events e WHERE ${filter.sql}
    ) WHERE rn = 1
  `).all(...filter.params).map((row) => row.detail).join("\n");
  assert.match(plan, /USING COVERING INDEX/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);
});

test("opening an existing index replaces the obsolete order index without changing representatives", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-order-index-migration-"));
  const dbPath = path.join(directory, "cache.sqlite");
  let index;
  t.after(async () => {
    closeUsageIndex(index);
    await rm(directory, { recursive: true, force: true });
  });
  index = await openUsageIndex({ dbPath, enableGc: false });
  index.db.prepare(`
    INSERT INTO events (
      file_path, event_index, timestamp_ms, has_event_timestamp, session_id, total_usage_key, cwd, model,
      input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens
    ) VALUES
      (?, 0, 2000, 1, 'copy', 'shared', ?, 'model', 100, 0, 0, 10, 0, 110),
      (?, 0, 1000, 1, 'original', 'shared', ?, 'model', 100, 0, 0, 10, 0, 110);
  `).run(path.join(directory, "a-copy.jsonl"), directory, path.join(directory, "z-original.jsonl"), directory);
  const initial = ensureCanonicalScope(index.db, [directory]);
  assert.equal(initial.canonicalEvents, 1);
  const before = index.db.prepare("SELECT * FROM canonical_events ORDER BY scope_id, total_usage_key").all();
  closeUsageIndex(index);
  index = null;

  const legacy = new DatabaseSync(dbPath);
  try {
    legacy.exec(`
      CREATE INDEX idx_events_total_order ON events(total_usage_key, file_path, event_index);
      CREATE INDEX idx_events_canonical_time_order
        ON events(total_usage_key, timestamp_ms IS NULL, timestamp_ms, file_path COLLATE BINARY, event_index);
      DROP INDEX idx_events_canonical_source_time_order;
    `);
  } finally {
    legacy.close();
  }

  index = await openUsageIndex({ dbPath, enableGc: false });
  const names = index.db.prepare("PRAGMA index_list(events)").all().map((row) => row.name);
  assert.ok(names.includes("idx_events_canonical_source_time_order"));
  assert.ok(!names.includes("idx_events_canonical_time_order"));
  assert.ok(!names.includes("idx_events_total_order"));
  index.db.prepare("UPDATE dedupe_scopes SET source_fingerprint = '' WHERE scope_id = ?").run(initial.scopeId);
  const rebuilt = ensureCanonicalScope(index.db, [directory]);
  assert.equal(rebuilt.canonicalRebuilt, true);
  assert.equal(rebuilt.canonicalEvents, 1);
  assert.deepEqual(index.db.prepare("SELECT * FROM canonical_events ORDER BY scope_id, total_usage_key").all(), before);
  assert.equal(index.db.prepare("SELECT COUNT(*) AS count FROM events").get().count, 2);
});
