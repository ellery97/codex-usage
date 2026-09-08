import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildUsagePayload, parseArgs } from "../bin/codex-token-usage.mjs";
import { scanSessionFile, scanSessionFileRange } from "../bin/session-scanner.mjs";
import { ensureCanonicalScope } from "../bin/usage-canonical.mjs";
import { closeUsageIndex, ensureFreshIndex, openUsageIndex } from "../bin/usage-index.mjs";
import { usageEventFingerprint, usageKey } from "../bin/usage-values.mjs";

const firstUsage = usage(100_000, 80_000, 1_000);
const secondTotal = usage(150_000, 110_000, 1_500);
const secondUsage = usage(50_000, 30_000, 500);
const timestamp = "2026-09-04T00:01:00.000Z";
const copiedTimestamp = "2026-09-05T10:01:00.000Z";

test("turn fingerprints survive rewritten timestamps and separate independent turns", () => {
  const fingerprint = (turnId, timestampMs, fallbackIdentity) => usageEventFingerprint({
    turnId, timestampMs, fallbackIdentity, totalUsage: firstUsage, lastUsage: firstUsage,
  });
  const original = fingerprint("original-turn", Date.parse(timestamp), "original-session");
  assert.equal(original, fingerprint("original-turn", Date.parse(copiedTimestamp), "child-session"));
  assert.equal(original, fingerprint("original-turn", null, "child-session"));
  assert.notEqual(original, fingerprint("independent-turn", Date.parse(timestamp), "other-session"));

  assert.notEqual(fingerprint(null, Date.parse(timestamp)), fingerprint(null, Date.parse(copiedTimestamp)));
  assert.notEqual(fingerprint(null, null, "session-a"), fingerprint(null, null, "session-b"));
});

test("direct and cached scans dedupe rewritten fork history and retain the child's new usage", async (t) => {
  const directory = await temporaryDirectory(t);
  const originalFile = path.join(directory, "a-original.jsonl");
  const childFile = path.join(directory, "b-child.jsonl");
  const independentFile = path.join(directory, "c-independent.jsonl");
  await writeLines(originalFile, sessionLines("original-session", "shared-turn", timestamp));
  await writeLines(childFile, sessionLines("child-session", "shared-turn", copiedTimestamp));
  await writeLines(independentFile, sessionLines("independent-session", "independent-turn", timestamp));

  const options = parseArgs([
    "--sessions", directory, "--group", "none", "--no-refresh-pricing",
  ]);
  options.cacheDbPath = path.join(directory, "cache.sqlite");
  const direct = await buildUsagePayload(options);
  const cached = await buildUsagePayload({ ...options, useCache: true });
  assert.equal(direct.totals.requests, 2);
  assert.equal(direct.totals.reference_total_cost_usd, 0.66);
  assert.equal(direct.stats.globalDuplicateTokenEvents, 1);
  assert.deepEqual(cached.totals, direct.totals);
  assert.equal(cached.stats.globalDuplicateTokenEvents, 1);

  // The child's inherited usage must be removed without discarding new work.
  await appendFile(childFile, encodeLines([
    { type: "event_msg", payload: { type: "task_started", turn_id: "child-turn" } },
    turnContext("child-turn"),
    tokenEvent("2026-09-05T10:02:00.000Z", secondTotal, secondUsage),
  ]));
  const updatedDirect = await buildUsagePayload(options);
  const updatedCache = await buildUsagePayload({ ...options, useCache: true });
  assert.equal(updatedDirect.totals.requests, 3);
  assert.equal(updatedDirect.totals.input_tokens, 250_000);
  assert.equal(updatedCache.stats.incrementalFiles, 1);
  assert.equal(updatedCache.stats.fullRescanFiles, 0);
  assert.equal(updatedCache.stats.globalDuplicateTokenEvents, 1);
  assert.deepEqual(updatedCache.totals, updatedDirect.totals);
});

test("saved turn identity survives appends and does not charge a repeated total at a new turn", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "rollout.jsonl");
  await writeLines(file, sessionLines("session", "first-turn", timestamp));
  const first = await scanSessionFile(file);
  assert.equal(first.state.context.turnId, "first-turn");

  await appendFile(file, encodeLines([
    tokenEvent("2026-09-04T00:01:01.000Z", secondTotal, secondUsage),
    { type: "event_msg", payload: { type: "task_started", turn_id: "second-turn" } },
    // Rate-limit updates can repeat the previous last_token_usage after a new
    // turn starts. File-local cumulative dedupe must still reject that replay.
    tokenEvent("2026-09-04T00:01:02.000Z", secondTotal, secondUsage),
  ]));
  const resumed = await scanSessionFileRange(file, {
    startOffset: first.processedOffset,
    endOffset: (await stat(file)).size,
    state: first.state,
    seenTotals: first.events.map((event) => event.totalUsageKey),
  });
  const full = await scanSessionFile(file);
  assert.deepEqual([...first.events, ...resumed.events], full.events);
  assert.equal(resumed.stats.duplicateTokenEvents, 1);
  assert.equal(resumed.events[0].totalUsageKey, expectedKey("first-turn", secondTotal, secondUsage));
});

test("task starts supply identity before model context and late metadata preserves it", async (t) => {
  const directory = await temporaryDirectory(t);
  const files = [path.join(directory, "a.jsonl"), path.join(directory, "b.jsonl")];
  for (const [index, file] of files.entries()) {
    await writeLines(file, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "shared-turn" } },
      tokenEvent(index === 0 ? timestamp : copiedTimestamp, firstUsage, firstUsage),
      sessionMeta(`session-${index}`),
      { type: "event_msg", payload: {
        type: "thread_settings_applied", thread_settings: { model: "gpt-6-astra" },
      } },
      tokenEvent(index === 0 ? timestamp : copiedTimestamp, secondTotal, secondUsage),
    ]);
  }
  const [first, copied] = await Promise.all(files.map((file) => scanSessionFile(file)));
  assert.deepEqual(first.events.map((event) => event.totalUsageKey), copied.events.map((event) => event.totalUsageKey));
  assert.equal(first.events[0].model, "gpt-6-astra");
  assert.equal(first.events[0].totalUsageKey, expectedKey("shared-turn", firstUsage, firstUsage));
  assert.equal(first.events[1].totalUsageKey, expectedKey("shared-turn", secondTotal, secondUsage));
});

test("missing turn IDs and completed turns do not inherit a stale identity", async (t) => {
  const directory = await temporaryDirectory(t);
  const boundaries = [
    turnContext(null),
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "old-turn" } },
    { type: "event_msg", payload: { type: "turn_aborted", turn_id: "old-turn" } },
  ];
  for (const [index, boundary] of boundaries.entries()) {
    const file = path.join(directory, `${index}.jsonl`);
    await writeLines(file, [
      sessionMeta("session"), turnContext("old-turn"), boundary,
      tokenEvent(timestamp, firstUsage, firstUsage),
      // A later context must not retroactively assign this earlier event to a
      // different turn, even when model/cwd backfill recomputes fingerprints.
      turnContext("future-turn"),
    ]);
    const scanned = await scanSessionFile(file);
    assert.equal(scanned.events[0].totalUsageKey, expectedKey(null, firstUsage, firstUsage, timestamp));
  }
});

test("earliest copied-event time controls month, price version, and bounded queries", async (t) => {
  const directory = await temporaryDirectory(t);
  const archiveDir = path.join(directory, "archived_sessions");
  const originalDir = path.join(directory, "sessions");
  await mkdir(archiveDir);
  await mkdir(originalDir);
  const copyFile = path.join(archiveDir, "copy.jsonl");
  const originalFile = path.join(originalDir, "original.jsonl");
  const originalLines = sessionLines("original", "shared-turn", "2026-07-29T12:00:00.000Z", "gpt-5.6-luna");
  await writeLines(copyFile, sessionLines("copy", "shared-turn", "2026-08-01T12:00:00.000Z", "gpt-5.6-luna"));
  await writeLines(originalFile, originalLines);
  const options = parseArgs([
    "--sessions", directory, "--group", "month", "--timezone", "UTC", "--no-refresh-pricing",
  ]);
  options.cacheDbPath = path.join(directory, "cache.sqlite");

  for (const useCache of [false, true]) {
    const all = await buildUsagePayload({ ...options, useCache });
    assert.equal(all.totals.requests, 1);
    assert.equal(all.rows[0].key, "2026-07");
    assert.equal(all.totals.reference_total_cost_usd, 0.034);

    const july = await buildUsagePayload({
      ...options, useCache,
      fromMs: Date.parse("2026-07-01T00:00:00.000Z"),
      toMs: Date.parse("2026-08-01T00:00:00.000Z"),
    });
    const august = await buildUsagePayload({
      ...options, useCache, fromMs: Date.parse("2026-08-01T00:00:00.000Z"),
    });
    assert.equal(july.totals.requests, 1);
    assert.equal(august.totals.requests, 0);
  }

  // Dirty-key repair must use the same ordering as the initial rebuild.
  await rm(originalFile);
  const withoutOriginal = await buildUsagePayload({ ...options, useCache: true });
  assert.equal(withoutOriginal.rows[0].key, "2026-08");
  assert.equal(withoutOriginal.totals.reference_total_cost_usd, 0.0068);
  assert.equal(withoutOriginal.stats.canonicalRebuilt, false);

  await writeLines(originalFile, originalLines);
  const restored = await buildUsagePayload({ ...options, useCache: true });
  assert.equal(restored.rows[0].key, "2026-07");
  assert.equal(restored.totals.reference_total_cost_usd, 0.034);
  assert.equal(restored.stats.canonicalRebuilt, false);
  assert.equal(restored.stats.canonicalUpdatedKeys, 1);
});

test("a copy without any timestamp cannot displace a dated event", async (t) => {
  const directory = await temporaryDirectory(t);
  await writeLines(path.join(directory, "a-undated.jsonl"), [
    { type: "session_meta", payload: { id: "undated", cwd: "/workspace/project" } },
    turnContext("shared-turn"),
    tokenEvent(null, firstUsage, firstUsage),
  ]);
  await writeLines(path.join(directory, "z-dated.jsonl"), sessionLines("dated", "shared-turn", timestamp));
  const options = parseArgs(["--sessions", directory, "--group", "none", "--no-refresh-pricing"]);
  options.cacheDbPath = path.join(directory, "cache.sqlite");
  for (const useCache of [false, true]) {
    const payload = await buildUsagePayload({ ...options, useCache });
    assert.equal(payload.totals.priced_requests, 1);
    assert.equal(payload.stats.unknownTimestampEvents, 0);
    assert.equal(payload.totals.reference_total_cost_usd, 0.33);
    const bounded = await buildUsagePayload({
      ...options, useCache, fromMs: Date.parse("2026-09-01T00:00:00.000Z"),
    });
    assert.equal(bounded.totals.requests, 1);
    assert.equal(bounded.stats.excludedUnknownTimestampEvents, 0);
  }
});

test("canonical rule changes rebuild a legacy scope even with pending tracked changes", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-legacy-scope-"));
  let index;
  t.after(async () => {
    closeUsageIndex(index);
    await rm(directory, { recursive: true, force: true });
  });
  const copyFile = path.join(directory, "a-copy.jsonl");
  const originalFile = path.join(directory, "z-original.jsonl");
  await writeLines(copyFile, sessionLines("copy", "shared-turn", copiedTimestamp));
  await writeLines(originalFile, sessionLines("original", "shared-turn", timestamp));
  index = await openUsageIndex({ dbPath: path.join(directory, "cache.sqlite"), enableGc: false });
  await ensureFreshIndex(index, [directory]);
  const initial = ensureCanonicalScope(index.db, [directory]);

  // Recreate the prior rule's scope identity and path-first representative.
  const legacyId = createHash("sha256").update(JSON.stringify([directory])).digest("hex");
  for (const table of ["dedupe_scopes", "dedupe_scope_roots", "canonical_events"]) {
    index.db.prepare(`UPDATE ${table} SET scope_id = ? WHERE scope_id = ?`).run(legacyId, initial.scopeId);
  }
  const copiedId = index.db.prepare("SELECT id FROM events WHERE file_path = ?").get(copyFile).id;
  index.db.prepare("UPDATE canonical_events SET event_id = ? WHERE scope_id = ?").run(copiedId, legacyId);
  index.db.prepare("INSERT INTO canonical_dirty_scopes (scope_id) VALUES (?)").run(legacyId);
  index.db.exec("UPDATE files SET scanned_at_ms = scanned_at_ms + 1");

  const rebuilt = ensureCanonicalScope(index.db, [directory]);
  assert.notEqual(rebuilt.scopeId, legacyId);
  assert.equal(rebuilt.canonicalRebuilt, true);
  const selected = index.db.prepare(`
    SELECT e.file_path FROM canonical_events c JOIN events e ON e.id = c.event_id
    WHERE c.scope_id = ?
  `).get(rebuilt.scopeId);
  assert.equal(selected.file_path, originalFile);
});

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-fork-dedupe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function usage(input, cached, output) {
  return {
    input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0,
    output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output,
  };
}

function sessionMeta(id) {
  return { timestamp, type: "session_meta", payload: { id, cwd: "/workspace/project" } };
}

function turnContext(turnId, model = "gpt-6-astra") {
  return { type: "turn_context", payload: {
    ...(turnId ? { turn_id: turnId } : {}), model, cwd: "/workspace/project",
  } };
}

function tokenEvent(time, totalUsage, lastUsage) {
  return { timestamp: time, type: "event_msg", payload: {
    type: "token_count", info: { total_token_usage: totalUsage, last_token_usage: lastUsage },
  } };
}

function sessionLines(sessionId, turnId, time, model) {
  return [sessionMeta(sessionId), turnContext(turnId, model), tokenEvent(time, firstUsage, firstUsage)];
}

function expectedKey(turnId, totalUsage, lastUsage, time = null) {
  return `${usageEventFingerprint({ turnId, totalUsage, lastUsage, timestampMs: time == null ? null : Date.parse(time) })}|${usageKey(totalUsage)}`;
}

function encodeLines(lines) {
  return `${lines.map(JSON.stringify).join("\n")}\n`;
}

async function writeLines(file, lines) {
  await writeFile(file, encodeLines(lines));
}
