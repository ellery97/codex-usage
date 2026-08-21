import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildUsagePayload } from "../bin/codex-token-usage.mjs";
import { SESSION_SCANNER_VERSION } from "../bin/session-scanner.mjs";
import {
  closeUsageIndex,
  ensureFreshIndex,
  openUsageIndex,
  usagePayloadFromIndex,
} from "../bin/usage-index.mjs";

test("migrates old indexes in place without discarding derived rows", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-index-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, "cache.sqlite");
  const oldDb = new DatabaseSync(dbPath);
  oldDb.exec(`
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      events_count INTEGER NOT NULL,
      duplicate_token_events INTEGER NOT NULL,
      parse_errors INTEGER NOT NULL,
      raw_token_events INTEGER NOT NULL,
      scanned_at_ms INTEGER NOT NULL
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL,
      event_index INTEGER NOT NULL,
      timestamp_ms INTEGER,
      session_created_at_ms INTEGER,
      session_id TEXT NOT NULL,
      total_usage_key TEXT NOT NULL,
      cwd TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      cached_input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      reasoning_output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL
    );
    INSERT INTO files VALUES ('rollout.jsonl', 1, 1, 1, 0, 0, 1, 1);
    INSERT INTO events VALUES (
      1, 'rollout.jsonl', 0, 1, 1, 'session-1', 'usage-1', '/tmp', 'gpt-5.6-sol',
      100, 10, 20, 5, 120
    );
  `);
  oldDb.close();

  const index = await openUsageIndex({ dbPath, enableGc: false });
  try {
    const columns = index.db.prepare("PRAGMA table_info(events)").all().map((row) => row.name);
    const fileColumns = index.db.prepare("PRAGMA table_info(files)").all().map((row) => row.name);
    assert.ok(columns.includes("cache_write_input_tokens"));
    assert.ok(fileColumns.includes("scan_offset"));
    assert.ok(fileColumns.includes("parser_state_json"));
    assert.equal(index.db.prepare("SELECT COUNT(*) AS count FROM events").get().count, 1);
    assert.equal(index.db.prepare("SELECT COUNT(*) AS count FROM files").get().count, 1);
    assert.equal(index.db.prepare("SELECT scanner_version FROM files").get().scanner_version, 0);
    assert.equal(index.db.prepare("PRAGMA user_version").get().user_version, 3);
  } finally {
    closeUsageIndex(index);
  }
});

test("fully rebuilds unchanged legacy rows with current usage keys and cache writes", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-legacy-rebuild-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionsDir = path.join(directory, "sessions");
  const dbPath = path.join(directory, "cache.sqlite");
  const freshDbPath = path.join(directory, "fresh.sqlite");
  await mkdir(sessionsDir, { recursive: true });

  const usage = {
    input_tokens: 1_000,
    cached_input_tokens: 100,
    cache_write_input_tokens: 200,
    output_tokens: 100,
    reasoning_output_tokens: 20,
    total_tokens: 1_100,
  };
  const sessionFiles = ["a-rollout.jsonl", "b-rollout.jsonl"].map((name) =>
    path.join(sessionsDir, name),
  );
  await Promise.all(
    sessionFiles.map((filePath, index) =>
      writeFile(filePath, sessionText(`legacy-${index}`, "gpt-5.6-luna", directory, usage)),
    ),
  );
  const fileStats = await Promise.all(sessionFiles.map((filePath) => stat(filePath)));

  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      events_count INTEGER NOT NULL,
      duplicate_token_events INTEGER NOT NULL,
      parse_errors INTEGER NOT NULL,
      raw_token_events INTEGER NOT NULL,
      scanned_at_ms INTEGER NOT NULL
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL,
      event_index INTEGER NOT NULL,
      timestamp_ms INTEGER,
      session_created_at_ms INTEGER,
      session_id TEXT NOT NULL,
      total_usage_key TEXT NOT NULL,
      cwd TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      cached_input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      reasoning_output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL
    );
  `);
  const insertLegacyFile = legacyDb.prepare(
    "INSERT INTO files VALUES (?, ?, ?, 1, 0, 0, 1, ?)",
  );
  const insertLegacyEvent = legacyDb.prepare(
    `INSERT INTO events VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  sessionFiles.forEach((filePath, index) => {
    insertLegacyFile.run(filePath, fileStats[index].size, fileStats[index].mtimeMs, Date.now());
    insertLegacyEvent.run(
      index + 1,
      filePath,
      Date.parse("2026-08-19T00:00:01.000Z"),
      Date.parse("2026-08-19T00:00:00.000Z"),
      `legacy-${index}`,
      `legacy-five-field-key-${index}`,
      directory,
      "gpt-5.6-luna",
      usage.input_tokens,
      usage.cached_input_tokens,
      usage.output_tokens,
      usage.reasoning_output_tokens,
      usage.total_tokens,
    );
  });
  legacyDb.close();

  const options = usageOptions(sessionsDir);
  const index = await openUsageIndex({ dbPath, scanCheckTtlMs: 0, enableGc: false });
  const freshIndex = await openUsageIndex({ dbPath: freshDbPath, scanCheckTtlMs: 0, enableGc: false });
  try {
    const migratedSync = await ensureFreshIndex(index, [sessionsDir]);
    assert.equal(migratedSync.fullRescanFiles, 2);
    assert.equal(migratedSync.incrementalFiles, 0);
    assert.equal(
      migratedSync.scannedBytes,
      fileStats.reduce((total, fileStat) => total + fileStat.size, 0),
    );
    assert.deepEqual(
      index.db.prepare("SELECT DISTINCT scanner_version FROM files").all().map((row) => row.scanner_version),
      [SESSION_SCANNER_VERSION],
    );

    const storedEvents = index.db
      .prepare(
        `SELECT total_usage_key, cache_write_input_tokens
         FROM events
         ORDER BY file_path, event_index`,
      )
      .all();
    assert.deepEqual(
      storedEvents.map((row) => ({ ...row })),
      sessionFiles.map(() => ({
        total_usage_key: "1000:100:200:100:20:1100",
        cache_write_input_tokens: 200,
      })),
    );

    const freshSync = await ensureFreshIndex(freshIndex, [sessionsDir]);
    const [migratedPayload, freshPayload, directPayload] = await Promise.all([
      Promise.resolve(usagePayloadFromIndex(index, migratedSync, options)),
      Promise.resolve(usagePayloadFromIndex(freshIndex, freshSync, options)),
      buildUsagePayload(options),
    ]);
    assert.deepEqual(migratedPayload.totals, freshPayload.totals);
    assert.deepEqual(migratedPayload.totals, directPayload.totals);
    assert.deepEqual(migratedPayload.rows, freshPayload.rows);
    assert.deepEqual(migratedPayload.rows, directPayload.rows);
    assert.equal(migratedPayload.totals.requests, 1);
    assert.equal(migratedPayload.totals.cache_write_input_tokens, 200);
    assert.equal(migratedPayload.totals.uncached_input_tokens, 700);
    assert.equal(migratedPayload.stats.globalDuplicateTokenEvents, 1);

    const unchangedSync = await ensureFreshIndex(index, [sessionsDir]);
    assert.equal(unchangedSync.changedFiles, 0);
    assert.equal(unchangedSync.fullRescanFiles, 0);
    assert.equal(unchangedSync.cacheFiles, 2);

    const nextUsage = {
      input_tokens: 1_500,
      cached_input_tokens: 200,
      cache_write_input_tokens: 250,
      output_tokens: 150,
      reasoning_output_tokens: 30,
      total_tokens: 1_650,
    };
    const appendedText = `${JSON.stringify(
      tokenEvent("2026-08-19T00:00:02.000Z", nextUsage),
    )}\n`;
    await appendFile(sessionFiles[0], appendedText);
    const appendedSync = await ensureFreshIndex(index, [sessionsDir]);
    assert.equal(appendedSync.incrementalFiles, 1);
    assert.equal(appendedSync.fullRescanFiles, 0);
    assert.equal(appendedSync.scannedBytes, Buffer.byteLength(appendedText));
  } finally {
    closeUsageIndex(freshIndex);
    closeUsageIndex(index);
  }
});

test("rolls back an incompatible schema migration and reports its database", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-migration-failure-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, "cache.sqlite");
  const malformedDb = new DatabaseSync(dbPath);
  malformedDb.exec(`
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      events_count INTEGER NOT NULL,
      duplicate_token_events INTEGER NOT NULL,
      parse_errors INTEGER NOT NULL,
      raw_token_events INTEGER NOT NULL,
      scanned_at_ms INTEGER NOT NULL
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL,
      event_index INTEGER NOT NULL,
      timestamp_ms INTEGER,
      session_created_at_ms INTEGER,
      session_id TEXT NOT NULL,
      total_usage_key TEXT NOT NULL,
      cwd TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      cached_input_tokens INTEGER NOT NULL,
      cache_write_input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      reasoning_output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL
    );
    CREATE TABLE canonical_events (scope_id TEXT NOT NULL);
  `);
  malformedDb.close();

  await assert.rejects(
    openUsageIndex({ dbPath, enableGc: false }),
    (error) => error.message.includes("Failed to migrate usage index") && error.message.includes(dbPath),
  );

  const verifiedDb = new DatabaseSync(dbPath);
  try {
    const fileColumns = verifiedDb.prepare("PRAGMA table_info(files)").all().map((row) => row.name);
    assert.equal(fileColumns.includes("scan_offset"), false);
    assert.equal(
      verifiedDb
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'dedupe_scopes'")
        .get().count,
      0,
    );
    assert.equal(verifiedDb.prepare("PRAGMA user_version").get().user_version, 0);
  } finally {
    verifiedDb.close();
  }
});

test("appends only the new JSONL suffix and falls back after a rewrite", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-incremental-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionsDir = path.join(directory, "sessions");
  const dbPath = path.join(directory, "cache.sqlite");
  const sessionFile = path.join(sessionsDir, "rollout.jsonl");
  await mkdir(sessionsDir, { recursive: true });

  const firstUsage = usageValue(100, 10);
  const initialLines = [
    sessionMeta("session-1", directory),
    turnContext("gpt-5.6-luna", directory),
    tokenEvent("2026-08-19T00:00:01.000Z", firstUsage, firstUsage),
  ];
  const initialText = `${initialLines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  await writeFile(sessionFile, initialText);

  const index = await openUsageIndex({ dbPath, scanCheckTtlMs: 0, enableGc: false });
  try {
    const firstSync = await ensureFreshIndex(index, [sessionsDir]);
    assert.equal(firstSync.fullRescanFiles, 1);
    assert.equal(firstSync.incrementalFiles, 0);

    const secondTotal = usageValue(160, 25);
    const appendedLines = [
      turnContext("gpt-5.6-terra", `${directory}/next`),
      tokenEvent("2026-08-19T00:00:02.000Z", secondTotal),
    ];
    const appendedText = `${appendedLines.map((line) => JSON.stringify(line)).join("\n")}\n`;
    await appendFile(sessionFile, appendedText);
    const secondSync = await ensureFreshIndex(index, [sessionsDir]);
    assert.equal(secondSync.incrementalFiles, 1);
    assert.equal(secondSync.fullRescanFiles, 0);
    assert.equal(secondSync.scannedBytes, Buffer.byteLength(appendedText));

    const events = index.db
      .prepare("SELECT model, cwd, input_tokens, output_tokens FROM events ORDER BY event_index")
      .all();
    assert.equal(events.length, 2);
    assert.deepEqual({ ...events[1] }, {
      model: "gpt-5.6-terra",
      cwd: `${directory}/next`,
      input_tokens: 60,
      output_tokens: 15,
    });

    usagePayloadFromIndex(index, secondSync, usageOptions(sessionsDir));
    await appendFile(
      sessionFile,
      `${JSON.stringify(turnContext("gpt-5.6-terra", `${directory}/waiting`))}\n`,
    );
    const contextOnlySync = await ensureFreshIndex(index, [sessionsDir]);
    const contextOnlyPayload = usagePayloadFromIndex(index, contextOnlySync, usageOptions(sessionsDir));
    assert.equal(contextOnlySync.incrementalFiles, 1);
    assert.equal(contextOnlyPayload.stats.canonicalRebuilt, false);
    assert.equal(contextOnlyPayload.stats.canonicalUpdatedKeys, 0);

    const replacementUsage = usageValue(50, 5);
    await writeFile(
      sessionFile,
      `${[
        sessionMeta("replacement", directory),
        turnContext("gpt-5.6-luna", directory),
        tokenEvent("2026-08-19T00:00:03.000Z", replacementUsage, replacementUsage),
      ]
        .map((line) => JSON.stringify(line))
        .join("\n")}\n`,
    );
    const thirdSync = await ensureFreshIndex(index, [sessionsDir]);
    assert.equal(thirdSync.incrementalFiles, 0);
    assert.equal(thirdSync.fullRescanFiles, 1);
    assert.equal(index.db.prepare("SELECT COUNT(*) AS count FROM events").get().count, 1);
    assert.equal(index.db.prepare("SELECT session_id FROM events").get().session_id, "replacement");
  } finally {
    closeUsageIndex(index);
  }
});

test("fully rescans a same-metadata file when its inode changes", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-inode-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionsDir = path.join(directory, "sessions");
  const dbPath = path.join(directory, "cache.sqlite");
  const sessionFile = path.join(sessionsDir, "rollout.jsonl");
  const replacementFile = path.join(sessionsDir, "replacement.jsonl.tmp");
  await mkdir(sessionsDir, { recursive: true });
  const usage = usageValue(100, 10);
  await writeFile(sessionFile, sessionText("session-a", "model-a", directory, usage));
  const fixedTime = new Date("2026-08-19T00:00:00.000Z");
  await utimes(sessionFile, fixedTime, fixedTime);

  const index = await openUsageIndex({ dbPath, scanCheckTtlMs: 0, enableGc: false });
  try {
    await ensureFreshIndex(index, [sessionsDir]);
    const originalStat = await stat(sessionFile);
    await writeFile(replacementFile, sessionText("session-b", "model-b", directory, usage));
    await utimes(replacementFile, fixedTime, fixedTime);
    await rename(replacementFile, sessionFile);
    const replacementStat = await stat(sessionFile);
    assert.equal(replacementStat.size, originalStat.size);
    assert.equal(Math.abs(replacementStat.mtimeMs - originalStat.mtimeMs) < 0.001, true);
    assert.notEqual(String(replacementStat.ino), String(originalStat.ino));

    const sync = await ensureFreshIndex(index, [sessionsDir]);
    assert.equal(sync.incrementalFiles, 0);
    assert.equal(sync.fullRescanFiles, 1);
    assert.equal(index.db.prepare("SELECT model FROM events").get().model, "model-b");
  } finally {
    closeUsageIndex(index);
  }
});

test("fully rescans a growing file when its saved boundary hash changes", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-boundary-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionsDir = path.join(directory, "sessions");
  const dbPath = path.join(directory, "cache.sqlite");
  const sessionFile = path.join(sessionsDir, "rollout.jsonl");
  await mkdir(sessionsDir, { recursive: true });
  const firstUsage = usageValue(100, 10);
  const initialText = sessionText("session-a", "model-a", directory, firstUsage);
  await writeFile(sessionFile, initialText);

  const index = await openUsageIndex({ dbPath, scanCheckTtlMs: 0, enableGc: false });
  try {
    await ensureFreshIndex(index, [sessionsDir]);
    await writeFile(sessionFile, initialText.replace("model-a", "model-b"));
    await appendFile(
      sessionFile,
      `${JSON.stringify(tokenEvent("2026-08-19T00:00:02.000Z", usageValue(160, 20)))}\n`,
    );

    const sync = await ensureFreshIndex(index, [sessionsDir]);
    assert.equal(sync.incrementalFiles, 0);
    assert.equal(sync.fullRescanFiles, 1);
    assert.equal(index.db.prepare("SELECT COUNT(*) AS count FROM events").get().count, 2);
    assert.deepEqual(
      index.db.prepare("SELECT DISTINCT model FROM events").all().map((row) => row.model),
      ["model-b"],
    );
  } finally {
    closeUsageIndex(index);
  }
});

test("updates canonical representatives when an earlier file appears and disappears", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-canonical-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionsDir = path.join(directory, "sessions");
  const dbPath = path.join(directory, "cache.sqlite");
  const laterFile = path.join(sessionsDir, "b-rollout.jsonl");
  const earlierFile = path.join(sessionsDir, "a-rollout.jsonl");
  await mkdir(sessionsDir, { recursive: true });
  const usage = usageValue(100, 10);
  await writeFile(laterFile, sessionText("later", "gpt-5.6-terra", directory, usage));

  const index = await openUsageIndex({ dbPath, scanCheckTtlMs: 0, enableGc: false });
  const options = usageOptions(sessionsDir);
  try {
    let sync = await ensureFreshIndex(index, [sessionsDir]);
    let payload = usagePayloadFromIndex(index, sync, options);
    assert.equal(payload.rows[0].key, "gpt-5.6-terra");
    assert.equal(payload.stats.globalDuplicateTokenEvents, 0);

    await writeFile(earlierFile, sessionText("earlier", "gpt-5.6-luna", directory, usage));
    sync = await ensureFreshIndex(index, [sessionsDir]);
    payload = usagePayloadFromIndex(index, sync, options);
    assert.equal(payload.rows.length, 1);
    assert.equal(payload.rows[0].key, "gpt-5.6-luna");
    assert.equal(payload.stats.globalDuplicateTokenEvents, 1);
    assert.ok(payload.stats.canonicalUpdatedKeys >= 1);

    await rm(earlierFile);
    sync = await ensureFreshIndex(index, [sessionsDir]);
    payload = usagePayloadFromIndex(index, sync, options);
    assert.equal(payload.rows[0].key, "gpt-5.6-terra");
    assert.equal(payload.stats.globalDuplicateTokenEvents, 0);
  } finally {
    closeUsageIndex(index);
  }
});

test("keeps an incomplete trailing line for the next incremental scan", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-tail-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionsDir = path.join(directory, "sessions");
  const dbPath = path.join(directory, "cache.sqlite");
  const sessionFile = path.join(sessionsDir, "rollout.jsonl");
  await mkdir(sessionsDir, { recursive: true });
  const usage = usageValue(100, 10);
  const prefix = `${[sessionMeta("tail", directory), turnContext("gpt-5.6-luna", directory)]
    .map((line) => JSON.stringify(line))
    .join("\n")}\n`;
  const tokenLine = JSON.stringify(tokenEvent("2026-08-19T00:00:01.000Z", usage, usage));
  const split = Math.floor(tokenLine.length / 2);
  await writeFile(sessionFile, `${prefix}${tokenLine.slice(0, split)}`);

  const index = await openUsageIndex({ dbPath, scanCheckTtlMs: 0, enableGc: false });
  try {
    let sync = await ensureFreshIndex(index, [sessionsDir]);
    assert.equal(sync.fullRescanFiles, 1);
    assert.equal(index.db.prepare("SELECT COUNT(*) AS count FROM events").get().count, 0);
    const fileRow = index.db.prepare("SELECT size, scan_offset, parse_errors FROM files").get();
    assert.ok(fileRow.scan_offset < fileRow.size);
    assert.equal(fileRow.parse_errors, 0);

    await appendFile(sessionFile, `${tokenLine.slice(split)}\n`);
    sync = await ensureFreshIndex(index, [sessionsDir]);
    assert.equal(sync.incrementalFiles, 1);
    assert.equal(sync.fullRescanFiles, 0);
    assert.equal(index.db.prepare("SELECT COUNT(*) AS count FROM events").get().count, 1);
    assert.equal(index.db.prepare("SELECT parse_errors FROM files").get().parse_errors, 0);
  } finally {
    closeUsageIndex(index);
  }
});

test("isolates canonical scopes and applies date filters after representative selection", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-scope-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const firstDir = path.join(directory, "a-sessions");
  const secondDir = path.join(directory, "b-sessions");
  const dbPath = path.join(directory, "cache.sqlite");
  await mkdir(firstDir, { recursive: true });
  await mkdir(secondDir, { recursive: true });
  const usage = usageValue(100, 10);
  await writeFile(
    path.join(firstDir, "rollout.jsonl"),
    sessionTextAt("first", "gpt-5.6-luna", directory, usage, "2026-08-18T00:00:01.000Z"),
  );
  await writeFile(
    path.join(secondDir, "rollout.jsonl"),
    sessionTextAt("second", "gpt-5.6-terra", directory, usage, "2026-08-19T00:00:01.000Z"),
  );

  const index = await openUsageIndex({ dbPath, scanCheckTtlMs: 0, enableGc: false });
  try {
    await ensureFreshIndex(index, [firstDir]);
    await ensureFreshIndex(index, [secondDir]);
    const sync = await ensureFreshIndex(index, [firstDir, secondDir]);
    const allOptions = {
      ...usageOptions([firstDir, secondDir]),
      fromMs: Date.parse("2026-08-19T00:00:00.000Z"),
    };
    const allPayload = usagePayloadFromIndex(index, sync, allOptions);
    assert.equal(allPayload.totals.requests, 0);
    assert.equal(allPayload.stats.globalDuplicateTokenEvents, 1);

    const secondSync = await ensureFreshIndex(index, [secondDir]);
    const secondPayload = usagePayloadFromIndex(index, secondSync, {
      ...usageOptions(secondDir),
      fromMs: Date.parse("2026-08-19T00:00:00.000Z"),
    });
    assert.equal(secondPayload.totals.requests, 1);
    assert.equal(secondPayload.rows[0].key, "gpt-5.6-terra");
    assert.equal(secondPayload.stats.globalDuplicateTokenEvents, 0);
  } finally {
    closeUsageIndex(index);
  }
});

test("rebuilds a canonical scope after an untracked legacy index change", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-fingerprint-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionsDir = path.join(directory, "sessions");
  const dbPath = path.join(directory, "cache.sqlite");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    path.join(sessionsDir, "rollout.jsonl"),
    sessionText("session", "gpt-5.6-luna", directory, usageValue(100, 10)),
  );

  const index = await openUsageIndex({ dbPath, scanCheckTtlMs: 0, enableGc: false });
  try {
    const sync = await ensureFreshIndex(index, [sessionsDir]);
    const options = usageOptions(sessionsDir);
    usagePayloadFromIndex(index, sync, options);
    index.db.exec("DELETE FROM canonical_dirty_keys; DELETE FROM canonical_dirty_scopes");
    index.db.prepare("UPDATE files SET scanned_at_ms = scanned_at_ms + 1").run();

    const payload = usagePayloadFromIndex(index, sync, options);
    assert.equal(payload.stats.canonicalRebuilt, true);
    assert.equal(payload.totals.requests, 1);
  } finally {
    closeUsageIndex(index);
  }
});

test("cached aggregation matches direct scanning across groups and dedupe scopes", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-parity-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionsDir = path.join(directory, "sessions");
  const dbPath = path.join(directory, "cache.sqlite");
  await mkdir(sessionsDir, { recursive: true });

  const first = usageValue(100, 10);
  const second = usageValue(180, 25);
  const third = usageValue(250, 40);
  await writeFile(
    path.join(sessionsDir, "a-rollout.jsonl"),
    `${[
      sessionMeta("session-a", `${directory}/a`),
      turnContext("gpt-5.6-luna", `${directory}/a`),
      tokenEvent("2026-08-18T00:00:01.000Z", first, first),
      turnContext("codex-auto-review", `${directory}/review`),
      tokenEvent("2026-08-19T00:00:01.000Z", second, usageValue(80, 15)),
    ]
      .map((line) => JSON.stringify(line))
      .join("\n")}\n`,
  );
  await writeFile(
    path.join(sessionsDir, "b-rollout.jsonl"),
    `${[
      sessionMeta("session-b", `${directory}/b`),
      turnContext("gpt-5.6-terra", `${directory}/b`),
      tokenEvent("2026-08-20T00:00:01.000Z", first, first),
      turnContext("unknown-model", `${directory}/unknown`),
      tokenEvent("2026-08-21T00:00:01.000Z", third, usageValue(150, 30)),
    ]
      .map((line) => JSON.stringify(line))
      .join("\n")}\n`,
  );

  const index = await openUsageIndex({ dbPath, scanCheckTtlMs: 0, enableGc: false });
  try {
    const sync = await ensureFreshIndex(index, [sessionsDir]);
    for (const dedupeScope of ["global", "file"]) {
      for (const group of ["none", "day", "month", "model", "cwd", "session"]) {
        const options = {
          sessionsDirs: [sessionsDir],
          fromMs: null,
          toMs: null,
          group,
          sort: group === "day" || group === "month" ? "key" : "total",
          desc: group !== "day" && group !== "month",
          limit: 0,
          dedupeScope,
          timezone: "UTC",
          sourceScope: "all",
          useCache: false,
        };
        const direct = await buildUsagePayload(options);
        const cached = usagePayloadFromIndex(index, sync, options);
        assert.deepEqual(cached.totals, direct.totals, `${dedupeScope}/${group} totals`);
        assert.deepEqual(cached.rows, direct.rows, `${dedupeScope}/${group} rows`);
        assert.equal(cached.rowCount, direct.rowCount, `${dedupeScope}/${group} rowCount`);
        assert.deepEqual(cached.assumedModels, direct.assumedModels, `${dedupeScope}/${group} assumed`);
        assert.deepEqual(cached.unpricedModels, direct.unpricedModels, `${dedupeScope}/${group} unpriced`);
        assert.equal(
          cached.stats.globalDuplicateTokenEvents,
          direct.stats.globalDuplicateTokenEvents,
          `${dedupeScope}/${group} global duplicates`,
        );
      }
    }
  } finally {
    closeUsageIndex(index);
  }
});

test("keeps at most eight canonical source scopes", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-scope-lru-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionsDir = path.join(directory, "sessions");
  const dbPath = path.join(directory, "cache.sqlite");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    path.join(sessionsDir, "rollout.jsonl"),
    sessionText("session", "gpt-5.6-luna", directory, usageValue(100, 10)),
  );

  const index = await openUsageIndex({ dbPath, scanCheckTtlMs: 0, enableGc: false });
  try {
    const sync = await ensureFreshIndex(index, [sessionsDir]);
    for (let i = 0; i < 9; i += 1) {
      usagePayloadFromIndex(index, sync, {
        ...usageOptions([sessionsDir, path.join(directory, `unused-${i}`)]),
      });
    }
    assert.equal(index.db.prepare("SELECT COUNT(*) AS count FROM dedupe_scopes").get().count, 8);
  } finally {
    closeUsageIndex(index);
  }
});

function usageValue(inputTokens, outputTokens) {
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
  return { timestamp: "2026-08-19T00:00:00.000Z", type: "session_meta", payload: { id, cwd } };
}

function turnContext(model, cwd) {
  return { timestamp: "2026-08-19T00:00:00.000Z", type: "turn_context", payload: { model, cwd } };
}

function tokenEvent(timestamp, totalUsage, lastUsage = null) {
  const info = { total_token_usage: totalUsage };
  if (lastUsage) info.last_token_usage = lastUsage;
  return { timestamp, type: "event_msg", payload: { type: "token_count", info } };
}

function sessionText(id, model, cwd, usage) {
  return sessionTextAt(id, model, cwd, usage, "2026-08-19T00:00:01.000Z");
}

function sessionTextAt(id, model, cwd, usage, timestamp) {
  return `${[
    sessionMeta(id, cwd),
    turnContext(model, cwd),
    tokenEvent(timestamp, usage, usage),
  ]
    .map((line) => JSON.stringify(line))
    .join("\n")}\n`;
}

function usageOptions(sessionsDir) {
  const sessionsDirs = Array.isArray(sessionsDir) ? sessionsDir : [sessionsDir];
  return {
    sessionsDirs,
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

test("SQLite aggregation matches codex-auto-review reference pricing semantics", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-index-assumed-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionsDir = path.join(directory, "sessions");
  const dbPath = path.join(directory, "cache.sqlite");
  const sessionFile = path.join(sessionsDir, "rollout.jsonl");
  await mkdir(sessionsDir, { recursive: true });
  const usage = {
    input_tokens: 100_000,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 10_000,
    reasoning_output_tokens: 5_000,
    total_tokens: 110_000,
  };
  const lines = [
    {
      timestamp: "2026-07-22T00:00:00.000Z",
      type: "session_meta",
      payload: { id: "review-session", cwd: directory },
    },
    {
      timestamp: "2026-07-22T00:00:00.000Z",
      type: "turn_context",
      payload: { model: "codex-auto-review", cwd: directory },
    },
    {
      timestamp: "2026-07-22T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } },
    },
  ];
  await writeFile(sessionFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

  const index = await openUsageIndex({ dbPath, scanCheckTtlMs: 0, enableGc: false });
  try {
    const syncStats = await ensureFreshIndex(index, [sessionsDir]);
    const payload = usagePayloadFromIndex(index, syncStats, {
      sessionsDirs: [sessionsDir],
      fromMs: null,
      toMs: null,
      group: "model",
      sort: "cost",
      desc: true,
      limit: 0,
      dedupeScope: "global",
      timezone: "UTC",
      sourceScope: "all",
    });

    assert.equal(payload.totals.estimated_cost_usd, 0);
    assert.equal(payload.totals.assumed_cost_usd, 0.4);
    assert.equal(payload.totals.assumed_upper_bound_cost_usd, 0.8);
    assert.equal(payload.totals.reference_total_cost_usd, 0.4);
    assert.equal(payload.totals.assumed_requests, 1);
    assert.equal(payload.totals.unpriced_requests, 0);
    assert.equal(payload.rows[0].reference_total_upper_bound_cost_usd, 0.8);
    assert.equal(payload.assumedModels[0].assumedModel, "gpt-5.4");
    assert.deepEqual(payload.unpricedModels, []);
  } finally {
    closeUsageIndex(index);
  }
});

test("SQLite and direct aggregation expose identical auto-review route history", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-index-route-history-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionsDir = path.join(directory, "sessions");
  const dbPath = path.join(directory, "cache.sqlite");
  await mkdir(sessionsDir, { recursive: true });
  const beforeUsage = usageValue(100_000, 10_000);
  const afterUsage = usageValue(200_000, 20_000);
  await writeFile(
    path.join(sessionsDir, "before.jsonl"),
    sessionTextAt("before", "codex-auto-review", directory, beforeUsage, "2026-07-22T00:00:01.000Z"),
  );
  await writeFile(
    path.join(sessionsDir, "after.jsonl"),
    sessionTextAt("after", "codex-auto-review", directory, afterUsage, "2026-08-01T00:00:01.000Z"),
  );

  const options = usageOptions(sessionsDir);
  const direct = await buildUsagePayload(options);
  const index = await openUsageIndex({ dbPath, scanCheckTtlMs: 0, enableGc: false });
  try {
    const sync = await ensureFreshIndex(index, [sessionsDir]);
    const cached = usagePayloadFromIndex(index, sync, options);
    assert.deepEqual(cached.assumedModels, direct.assumedModels);
    assert.deepEqual(
      cached.assumedModels[0].routes.map((route) => [route.assumedModel, route.requests]),
      [
        ["gpt-5.4", 1],
        ["gpt-5.6-luna", 1],
      ],
    );
  } finally {
    closeUsageIndex(index);
  }
});

test("SQLite and direct aggregation agree across GPT-5.6 price boundaries", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-index-price-boundary-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionsDir = path.join(directory, "sessions");
  const dbPath = path.join(directory, "cache.sqlite");
  await mkdir(sessionsDir, { recursive: true });
  const cases = [
    ["terra-before", "gpt-5.6-terra", "2026-07-29T23:59:59.000Z", usageValue(100_000, 10_000)],
    ["terra-after", "gpt-5.6-terra", "2026-07-30T00:00:00.000Z", usageValue(110_000, 11_000)],
    ["luna-before", "gpt-5.6-luna", "2026-07-29T23:59:59.000Z", usageValue(120_000, 12_000)],
    ["luna-after", "gpt-5.6-luna", "2026-07-30T00:00:00.000Z", usageValue(130_000, 13_000)],
  ];
  for (const [id, model, timestamp, usage] of cases) {
    await writeFile(
      path.join(sessionsDir, `${id}.jsonl`),
      sessionTextAt(id, model, directory, usage, timestamp),
    );
  }

  const options = usageOptions(sessionsDir);
  const direct = await buildUsagePayload(options);
  const index = await openUsageIndex({ dbPath, scanCheckTtlMs: 0, enableGc: false });
  try {
    const sync = await ensureFreshIndex(index, [sessionsDir]);
    const cached = usagePayloadFromIndex(index, sync, options);
    assert.ok(Math.abs(direct.totals.estimated_cost_usd - 0.9856) < 1e-12);
    assert.deepEqual(cached.totals, direct.totals);
    assert.deepEqual(cached.rows, direct.rows);
  } finally {
    closeUsageIndex(index);
  }
});
