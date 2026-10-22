import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { zstdCompressSync } from "node:zlib";
import test from "node:test";
import { scanSessionFileRange, SESSION_SCANNER_VERSION } from "../bin/session-scanner.mjs";
import { buildUsagePayload } from "../bin/usage-aggregation.mjs";
import { closeUsageIndex, ensureFreshIndex, getIndexStatus, openUsageIndex } from "../bin/usage-index.mjs";
import { createUsageQueryService } from "../bin/usage-query.mjs";

const exec = promisify(execFile);
const timestamp = "2026-10-01T00:00:01Z";
function event(input = 1000, second = 1) {
  return JSON.stringify({ timestamp: `2026-10-01T00:00:${String(second).padStart(2, "0")}Z`, type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: {
      input_tokens: input, cached_input_tokens: 100, cache_write_input_tokens: 50,
      output_tokens: 100, reasoning_output_tokens: 20, total_tokens: input + 100,
    } } } }) + "\n";
}
function log({ metadata = true, cwd = "/fixture" } = {}) {
  return (metadata ? JSON.stringify({ timestamp, type: "session_meta", payload: { id: "test-session", cwd } }) + "\n" : "") +
    JSON.stringify({ timestamp, type: "turn_context", payload: { model: "gpt-5-mini", cwd } }) + "\n" + event();
}
function options(root, extra = {}) {
  return { sessionsDirs: [root], fromMs: null, toMs: null, group: "day", timezone: "UTC",
    sort: "key", desc: false, limit: 0, dedupeScope: "global", ...extra };
}
async function fixture(t, indexOptions = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-compressed-test-"));
  const root = path.join(dir, "sessions");
  await mkdir(root);
  const dbPath = path.join(dir, "index.sqlite");
  const index = await openUsageIndex({ dbPath, scanCheckTtlMs: 0, enableGc: false, ...indexOptions });
  t.after(async () => { await closeUsageIndex(index); await rm(dir, { recursive: true, force: true }); });
  return { dir, root, index, dbPath, query: createUsageQueryService(index) };
}

test("plain and concatenated Zstd frames agree across UTF-8 chunks, missing metadata and no final newline", async (t) => {
  const { root } = await fixture(t);
  for (const metadata of [false, true]) {
    const text = log({ metadata, cwd: "/" + "x".repeat(65500) + "中文目录😀" }).trimEnd();
    const bytes = Buffer.from(text);
    const plain = path.join(root, `rollout-${metadata}.jsonl`);
    const packed = `${plain}.zst`;
    // Split even inside a JSON/UTF-8 sequence; Zstd frame boundaries are not line boundaries.
    await writeFile(plain, bytes);
    await writeFile(packed, Buffer.concat([zstdCompressSync(bytes.subarray(0, 65520)), zstdCompressSync(bytes.subarray(65520))]));
    const a = await scanSessionFileRange(plain), b = await scanSessionFileRange(packed);
    assert.deepEqual(b.events.map((row) => ({ ...row, file: plain })), a.events);
    assert.deepEqual(b.stats, a.stats);
    assert.equal(b.events.length, 1);
    assert.equal(b.decodedBytes, bytes.length);
    assert.equal(b.scannedBytes, (await stat(packed)).size);
    assert.equal(b.incrementalSafe, false);
    await assert.rejects(scanSessionFileRange(packed, { startOffset: 1 }), /beginning/);
  }
});

test("both formats dedupe globally and preserve file diagnostics and event-time filtering", async (t) => {
  const { root, index, query } = await fixture(t);
  // The filename date must never hide October events.
  const plain = path.join(root, "rollout-2020-01-01.jsonl");
  const text = log({ metadata: false });
  await writeFile(plain, text);
  await writeFile(`${plain}.zst`, zstdCompressSync(text));
  await ensureFreshIndex(index, [root]);
  for (const dedupeScope of ["global", "file"]) {
    const opts = options(root, { dedupeScope, fromMs: Date.parse("2026-10-01"), toMs: Date.parse("2026-10-02") });
    const direct = await buildUsagePayload(opts), cached = await query.query(opts, { refreshIndex: false });
    assert.deepEqual(cached.totals, direct.totals);
    assert.deepEqual(cached.rows, direct.rows);
    assert.equal(cached.totals.requests, dedupeScope === "global" ? 1 : 2);
    assert.ok(cached.totals.estimated_cost_usd > 0);
  }
});

test("unchanged compressed files do no content IO; appends only read the ordinary suffix", async (t) => {
  const calls = [];
  const { root, index } = await fixture(t, { scanFileImpl: (file, opts) => {
    calls.push(file); return scanSessionFileRange(file, opts);
  } });
  const plain = path.join(root, "plain.jsonl"), packed = path.join(root, "compressed.jsonl.zst");
  await writeFile(plain, log());
  await writeFile(packed, zstdCompressSync(log()));
  assert.equal((await ensureFreshIndex(index, [root])).cacheFiles, 0);
  calls.length = 0;
  const warm = await ensureFreshIndex(index, [root]);
  assert.deepEqual(calls, []);
  assert.equal(warm.scannedBytes, 0);
  assert.equal(warm.decodedBytes, 0);
  assert.equal(warm.cacheFiles, 2);
  await appendFile(plain, event(2000, 2));
  const appended = await ensureFreshIndex(index, [root]);
  assert.deepEqual(calls, [plain]);
  assert.equal(appended.incrementalFiles, 1);
  assert.equal(appended.cacheFiles, 1);
  assert.equal(appended.scannedBytes, Buffer.byteLength(event(2000, 2)));
  assert.equal(index.db.prepare("SELECT scanner_version FROM files WHERE path = ?").get(plain).scanner_version, SESSION_SCANNER_VERSION);
  calls.length = 0;
  await writeFile(packed, zstdCompressSync(log() + event(3000, 3)));
  const changed = await ensureFreshIndex(index, [root]);
  assert.deepEqual(calls, [packed]);
  assert.equal(changed.fullRescanFiles, 1);
  assert.equal(changed.decodedBytes, Buffer.byteLength(log() + event(3000, 3)));
  // Identity changes trigger a full read even if the compressed bytes and timestamps match.
  calls.length = 0;
  const before = await stat(packed);
  await writeFile(`${packed}.replacement`, await readFile(packed));
  await utimes(`${packed}.replacement`, before.atime, before.mtime);
  await rename(`${packed}.replacement`, packed);
  assert.equal((await ensureFreshIndex(index, [root])).fullRescanFiles, 1);
  assert.deepEqual(calls, [packed]);
});

test("schema 4 migrates additively without rescanning an existing scanner-6 ordinary log", async (t) => {
  const { root, index, dbPath } = await fixture(t);
  await writeFile(path.join(root, "old.jsonl"), log());
  await ensureFreshIndex(index, [root]);
  index.db.exec("DROP TABLE scan_failures; DROP TABLE index_publication; PRAGMA user_version = 4");
  await closeUsageIndex(index);
  const migrated = await openUsageIndex({ dbPath, scanFileImpl: () => { throw new Error("Unexpected rescan"); } });
  try {
    const sync = await ensureFreshIndex(migrated, [root]);
    assert.equal(sync.changedFiles, 0);
    assert.equal(sync.failedFiles, 0);
    assert.equal(sync.scannedBytes, 0);
    assert.equal(migrated.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
    assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 5);
  } finally { await closeUsageIndex(migrated); }
});

test("failed compressed replacement retains the old index, persists failures, and recovers atomically", async (t) => {
  let reads = 0;
  const { root, dbPath, index, query } = await fixture(t, { scanFileImpl: (...args) => { reads++; return scanSessionFileRange(...args); } });
  const plain = path.join(root, "rollout.jsonl"), packed = `${plain}.zst`;
  await writeFile(plain, log());
  await ensureFreshIndex(index, [root]);
  const before = await query.query(options(root), { refreshIndex: false });
  await rm(plain);
  const valid = zstdCompressSync(log() + event(2000, 2));
  await writeFile(packed, valid.subarray(0, valid.length - 3));
  const partial = await ensureFreshIndex(index, [root]);
  assert.equal(partial.failedFiles, 1);
  assert.equal(partial.deletedFiles, 0);
  const after = await query.query(options(root), { refreshIndex: false });
  assert.deepEqual(after.totals, before.totals);
  assert.equal(after.index.failures[0].usingPreviousIndex, true);
  assert.deepEqual(after.index.failures[0].retainedPaths, [plain]);
  const readsBefore = reads;
  await ensureFreshIndex(index, [root], { retryFailures: false });
  assert.equal(reads, readsBefore);
  const reopened = await openUsageIndex({ dbPath, scanFileImpl: () => { throw new Error("Must reuse persisted failure"); } });
  try {
    const skipped = await ensureFreshIndex(reopened, [root], { retryFailures: false });
    assert.equal(skipped.scannedBytes, 0);
    assert.match(getIndexStatus(reopened).failures[0].message, /end|Zstd|buffer/i);
  } finally { await closeUsageIndex(reopened); }
  await ensureFreshIndex(index, [root]);
  assert.equal(reads, readsBefore + 1); // Manual refresh retries unchanged failures.
  await writeFile(packed, valid);
  const recovered = await ensureFreshIndex(index, [root], { retryFailures: false });
  assert.equal(recovered.deletedFiles, 1);
  assert.equal(recovered.failedFiles, 0);
  const result = await query.query(options(root), { refreshIndex: false });
  assert.equal(result.totals.requests, 2);
  assert.equal(result.index.incomplete, false);
});

test("failed archive replacements match stable rollout IDs without retaining unrelated same-named custom files", async (t) => {
  const { dir, root, index } = await fixture(t);
  const archive = path.join(dir, "archive");
  await mkdir(archive);
  const uuid = "11111111-2222-3333-4444-555555555555";
  const rollout = path.join(root, `rollout-${uuid}.jsonl`);
  const custom = path.join(root, "custom.jsonl");
  await writeFile(rollout, log());
  await writeFile(custom, log());
  await ensureFreshIndex(index, [root, archive]);
  await rm(rollout);
  await rm(custom);
  await writeFile(path.join(archive, `rollout-${uuid}.jsonl.zst`), "corrupt");
  await writeFile(path.join(archive, "custom.jsonl.zst"), "corrupt");
  const sync = await ensureFreshIndex(index, [root, archive]);
  assert.equal(sync.deletedFiles, 1);
  assert.equal(index.db.prepare("SELECT path FROM files").get().path, rollout);
  const failures = getIndexStatus(index).failures;
  assert.equal(failures.find((row) => row.path.endsWith("custom.jsonl.zst")).usingPreviousIndex, false);
  assert.equal(failures.find((row) => row.path.includes(uuid)).usingPreviousIndex, true);
});

test("corruption and read errors are isolated; no decoded prefix is committed", async (t) => {
  const { root, index, query } = await fixture(t, { scanFileImpl: (file, opts) => {
    if (file.endsWith("unreadable.jsonl")) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return scanSessionFileRange(file, opts);
  } });
  await writeFile(path.join(root, "good.jsonl"), log());
  await writeFile(path.join(root, "unreadable.jsonl"), log());
  await writeFile(path.join(root, "bad.jsonl.zst"), Buffer.concat([zstdCompressSync(log()), Buffer.from("broken frame")]));
  await writeFile(path.join(root, "empty.jsonl.zst"), "");
  const sync = await ensureFreshIndex(index, [root]);
  assert.equal(sync.failedFiles, 3);
  assert.equal(sync.changedFiles, 1);
  const payload = await query.query(options(root), { refreshIndex: false });
  assert.equal(payload.totals.requests, 1);
  assert.equal(payload.index.incomplete, true);
  assert.equal(index.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
});

test("database write failures discard all staged successes and preserve publication", async (t) => {
  const { root, index, query } = await fixture(t);
  const file = path.join(root, "rollout.jsonl");
  await writeFile(file, log());
  await ensureFreshIndex(index, [root]);
  const old = await query.query(options(root), { refreshIndex: false });
  await appendFile(file, event(2000, 2));
  index.db.exec("CREATE TRIGGER reject_insert BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
  await assert.rejects(ensureFreshIndex(index, [root]), /disk failure/);
  const after = await query.query(options(root), { refreshIndex: false });
  assert.deepEqual(after.totals, old.totals);
  assert.equal(after.index.revision, old.index.revision);
  assert.equal(after.index.state, "failed");
  assert.equal(index.db.prepare("SELECT COUNT(*) AS n FROM sqlite_temp_master WHERE name LIKE 'refresh_%'").get().n, 0);
});

test("staging database failures are fatal, rather than downgraded to unreadable-file warnings", async (t) => {
  const { root, index } = await fixture(t);
  await writeFile(path.join(root, "new.jsonl.zst"), zstdCompressSync(log()));
  const prepare = index.db.prepare;
  t.mock.method(index.db, "prepare", function (sql) {
    if (sql.startsWith("INSERT INTO refresh_events")) {
      return { run() { throw new Error("staging storage failed"); } };
    }
    return prepare.call(this, sql);
  });
  await assert.rejects(ensureFreshIndex(index, [root]), /staging storage failed/);
  assert.equal(getIndexStatus(index).revision, 0);
  assert.equal(getIndexStatus(index).state, "failed");
  assert.equal(index.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
  assert.equal(index.db.prepare("SELECT COUNT(*) AS n FROM scan_failures").get().n, 0);
});

test("CLI publishes partial JSON/CSV with stderr diagnostics and exit code 2", async (t) => {
  const { dir, root } = await fixture(t);
  await writeFile(path.join(root, "good.jsonl.zst"), zstdCompressSync(log()));
  await writeFile(path.join(root, "bad.jsonl.zst"), "broken");
  for (const cache of [[], ["--cache-db", path.join(dir, "cli.sqlite")]]) {
    for (const format of ["--json", "--csv"]) {
      await assert.rejects(exec(process.execPath, ["bin/codex-token-usage.mjs", "--sessions", root, "--no-refresh-pricing", ...cache, format], {
        cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, CODEX_USAGE_PRICING_CACHE: path.join(dir, "prices.json") },
      }), (error) => {
        assert.equal(error.code, 2);
        assert.match(error.stderr, /Statistics incomplete/);
        assert.match(error.stderr, /bad.jsonl.zst/);
        if (format === "--json") assert.equal(JSON.parse(error.stdout).totals.requests, 1);
        else assert.match(error.stdout, /^group,sessions,requests,/);
        assert.doesNotMatch(error.stdout, /\[codex-usage\]/);
        return true;
      });
    }
  }
});
