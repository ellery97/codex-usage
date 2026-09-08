import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { scanSessionFileRange, SESSION_SCANNER_VERSION } from "../bin/session-scanner.mjs";
import { closeUsageIndex, ensureFreshIndex, openUsageIndex } from "../bin/usage-index.mjs";

const execFileAsync = promisify(execFile);

test("daily usage entry reuses the index and keeps JSON/CSV stdout free of progress", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-cli-progress-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionsDir = path.join(directory, "sessions");
  await mkdir(sessionsDir);
  await writeFile(path.join(sessionsDir, "session.jsonl"), sessionText());
  const { scripts } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const [command, ...scriptArgs] = scripts.usage.split(/\s+/);
  assert.equal(command, "node");
  const run = (format) => execFileAsync(process.execPath, [
    ...scriptArgs,
    "--sessions", sessionsDir,
    "--no-refresh-pricing",
    format,
  ], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      CODEX_USAGE_DB: path.join(directory, "cache.sqlite"),
      CODEX_USAGE_PRICING_CACHE: path.join(directory, "pricing-history.json"),
    },
    timeout: 15_000,
  });

  const cold = await run("--json");
  const coldPayload = JSON.parse(cold.stdout);
  assert.equal(coldPayload.stats.cacheMode, true);
  assert.equal(coldPayload.stats.fullRescanFiles, 1);
  assert.match(cold.stderr, /1 new, 0 scanner upgrades/);
  assert.match(cold.stderr, /1\/1 files; read/);
  assert.match(cold.stderr, /Loading local model prices/);
  assert.match(cold.stderr, /Aggregating usage/);

  const warm = await run("--json");
  const warmPayload = JSON.parse(warm.stdout);
  assert.deepEqual(warmPayload.totals, coldPayload.totals);
  assert.equal(warmPayload.stats.scannedBytes, 0);
  assert.equal(warmPayload.stats.changedFiles, 0);
  assert.match(warm.stderr, /1 cached.*0\/0 files; read 0 B/);

  const csv = await run("--csv");
  assert.match(csv.stdout, /^group,sessions,requests,/);
  assert.equal(csv.stdout.trim().split("\n").length, 2);
  assert.doesNotMatch(csv.stdout, /\[codex-usage\]/);
  assert.match(csv.stderr, /Done in/);
});

test("index progress distinguishes scanner upgrades and appends with exact read totals", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-index-progress-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionsDir = path.join(directory, "sessions");
  await mkdir(sessionsDir);
  const upgradeFile = path.join(sessionsDir, "upgrade.jsonl");
  const appendPath = path.join(sessionsDir, "append.jsonl");
  const original = sessionText();
  await Promise.all([writeFile(upgradeFile, original), writeFile(appendPath, original)]);
  const index = await openUsageIndex({
    dbPath: path.join(directory, "cache.sqlite"),
    scanCheckTtlMs: 0,
    enableGc: false,
  });
  t.after(() => closeUsageIndex(index));
  await ensureFreshIndex(index, [sessionsDir]);
  index.db.prepare("UPDATE files SET scanner_version = ? WHERE path = ?")
    .run(SESSION_SCANNER_VERSION - 1, upgradeFile);
  const appended = `${JSON.stringify(tokenEvent(2_000, "2026-09-05T00:00:02.000Z"))}\n`;
  await appendFile(appendPath, appended);

  const updates = [];
  const sync = await ensureFreshIndex(index, [sessionsDir], {
    onProgress: (progress) => updates.push(progress),
  });
  assert.deepEqual(updates.slice(0, 2).map((progress) => progress.phase), ["discover", "check"]);
  const scans = updates.filter((progress) => progress.phase === "scan");
  assert.equal(scans[0].upgradeFiles, 1);
  assert.equal(scans[0].modifiedFiles, 1);
  assert.equal(scans[0].newFiles, 0);
  const last = scans.at(-1);
  assert.equal(last.done, true);
  assert.equal(last.completedFiles, 2);
  assert.equal(last.incrementalFiles, 1);
  assert.equal(last.fullRescanFiles, 1);
  assert.equal(last.scannedBytes, Buffer.byteLength(original) + Buffer.byteLength(appended));
  assert.equal(last.scannedBytes, sync.scannedBytes);
  assert.ok(scans.every((progress, i) => i === 0 || progress.scannedBytes >= scans[i - 1].scannedBytes));
});

test("scanner reports byte progress within one large file without changing its result", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-byte-progress-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "large.jsonl");
  const contents = `${sessionText()}${JSON.stringify({ type: "irrelevant", text: "x".repeat(256 * 1024) })}\n`;
  await writeFile(file, contents);
  const bytes = [];
  const reported = await scanSessionFileRange(file, { onProgress: (count) => bytes.push(count) });
  const plain = await scanSessionFileRange(file);
  assert.deepEqual(reported, plain);
  assert.ok(bytes.length > 1);
  assert.ok(bytes[0] < Buffer.byteLength(contents));
  assert.equal(bytes.at(-1), Buffer.byteLength(contents));
  assert.ok(bytes.every((count, i) => i === 0 || count > bytes[i - 1]));
});

function sessionText() {
  return [
    { timestamp: "2026-09-05T00:00:00.000Z", type: "session_meta", payload: { id: "session", cwd: "/fixture" } },
    { timestamp: "2026-09-05T00:00:00.000Z", type: "turn_context", payload: { model: "gpt-6-astra", cwd: "/fixture" } },
    tokenEvent(1_000, "2026-09-05T00:00:01.000Z"),
  ].map(JSON.stringify).join("\n") + "\n";
}

function tokenEvent(input, timestamp) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: input, cached_input_tokens: 100, output_tokens: 100, total_tokens: input + 100 },
      },
    },
  };
}
