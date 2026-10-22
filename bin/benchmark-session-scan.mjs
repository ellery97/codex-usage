#!/usr/bin/env node
// Synthetic inputs only. Each worker is a fresh process so peak RSS is comparable.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createZstdCompress } from "node:zlib";
import { startDashboard } from "./codex-usage-server.mjs";
import { closeUsageIndex, ensureFreshIndex, openUsageIndex } from "./usage-index.mjs";

const exec = promisify(execFile);
const cases = ["cold", "unchanged", "append-plain", "change-compressed"];
const argument = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const worker = argument("worker", null);
const plainRoot = argument("plain-root", null);
const runs = Number(argument("runs", "5"));
const sizes = argument("sizes", "8,32,128").split(",").map(Number);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function token(n, id) {
  return JSON.stringify({ timestamp: new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString(), type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: n * 100, output_tokens: n * 10, total_tokens: n * 110 } } },
    id }) + "\n";
}
function log(id, count = 40) {
  return JSON.stringify({ timestamp: "2026-10-01T00:00:00Z", type: "session_meta", payload: { id, cwd: "/synthetic" } }) + "\n" +
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-5-mini", cwd: "/synthetic", turn_id: id } }) + "\n" +
    Array.from({ length: count }, (_, n) => token(n + 1, id)).join("");
}
async function compressed(file, id, mib, count = 40) {
  const line = Buffer.from(JSON.stringify({ type: "response_item", payload: { text: "x".repeat(4000) } }) + "\n");
  async function* chunks() {
    yield log(id, count);
    for (let written = 0; written < mib * 1024 * 1024; written += line.length) yield line;
  }
  await pipeline(Readable.from(chunks()), createZstdCompress(), createWriteStream(file));
}

async function measure(scenario, mib) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-scan-benchmark-"));
  const root = path.join(directory, "sessions"), dbPath = path.join(directory, "index.sqlite");
  let dashboard;
  const oldSource = process.env.CODEX_USAGE_SESSIONS;
  const consoleLog = console.log;
  try {
    await mkdir(root);
    for (let n = 0; n < 64; n++) await writeFile(path.join(root, `plain-${n}.jsonl`), log(`plain-${n}`));
    for (let n = 0; n < 4; n++) await compressed(path.join(root, `packed-${n}.jsonl.zst`), `packed-${n}`, mib);
    if (scenario !== "cold") {
      const seed = await openUsageIndex({ dbPath, enableGc: false });
      try { await ensureFreshIndex(seed, [root]); } finally { await closeUsageIndex(seed); }
    }
    if (scenario === "append-plain") await appendFile(path.join(root, "plain-0.jsonl"), token(41, "plain-0"));
    if (scenario === "change-compressed") await compressed(path.join(root, "packed-0.jsonl.zst"), "packed-0", mib, 41);
    process.env.CODEX_USAGE_SESSIONS = root;
    console.log = (...args) => console.error(...args);
    const started = performance.now();
    dashboard = await startDashboard({ port: 0, host: "127.0.0.1", dbPath, enableGc: false,
      initializePricingImpl: async () => {}, refreshPricingEnabled: false });
    const listeningMs = performance.now() - started;
    let done = false;
    const job = dashboard.startupPromise.finally(() => { done = true; });
    const latencies = [];
    let queriesBeforePublication = 0;
    do {
      const begin = performance.now();
      const response = await fetch(`http://127.0.0.1:${dashboard.port}/api/usage?range=all`, { signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200);
      const payload = await response.json();
      latencies.push(performance.now() - begin);
      if (payload.index.running) queriesBeforePublication++;
      if (!done) await delay(10);
    } while (!done);
    const sync = await job;
    if (scenario === "unchanged") {
      assert.equal(sync.scannedBytes, 0);
      assert.equal(sync.decodedBytes, 0);
    }
    if (scenario === "append-plain") {
      assert.equal(sync.incrementalFiles, 1);
      assert.equal(sync.fullRescanFiles, 0);
      assert.equal(sync.decodedBytes, sync.scannedBytes);
    }
    if (scenario === "change-compressed") assert.equal(sync.fullRescanFiles, 1);
    if (scenario === "cold") assert.ok(queriesBeforePublication > 0, "HTTP must respond before cold scanning finishes");
    const maxRss = process.resourceUsage().maxRSS * 1024;
    return { scanMs: sync.scanDurationMs, listeningMs, peakRssBytes: maxRss,
      scannedBytes: sync.scannedBytes, decodedBytes: sync.decodedBytes,
      apiMedianMs: median(latencies), apiMaxMs: Math.max(...latencies), queriesBeforePublication };
  } finally {
    console.log = consoleLog;
    if (dashboard) {
      const stopped = new Promise((resolve) => dashboard.server.close(resolve));
      await dashboard.close();
      await stopped;
    }
    if (oldSource === undefined) delete process.env.CODEX_USAGE_SESSIONS;
    else process.env.CODEX_USAGE_SESSIONS = oldSource;
    await rm(directory, { recursive: true, force: true });
  }
}

async function measurePlain(root) {
  const module = await import(pathToFileURL(path.resolve(root, "bin/usage-index.mjs")));
  const directory = await mkdtemp(path.join(tmpdir(), "codex-plain-benchmark-"));
  const sessions = path.join(directory, "sessions");
  let index;
  try {
    await mkdir(sessions);
    for (let n = 0; n < 300; n++) await writeFile(path.join(sessions, `${n}.jsonl`), log(`plain-${n}`));
    index = await module.openUsageIndex({ dbPath: path.join(directory, "index.sqlite"), scanCheckTtlMs: 0, enableGc: false });
    await module.ensureFreshIndex(index, [sessions]);
    const warmMs = [], appendMs = [];
    // Discard two warm-up cycles, then compare at least five on the same host.
    for (let n = 0; n < runs + 2; n++) {
      let started = performance.now();
      const warm = await module.ensureFreshIndex(index, [sessions]);
      const warmTime = performance.now() - started;
      assert.equal(warm.scannedBytes, 0);
      await appendFile(path.join(sessions, "0.jsonl"), token(41 + n, "plain-0"));
      started = performance.now();
      const appended = await module.ensureFreshIndex(index, [sessions]);
      const appendTime = performance.now() - started;
      assert.equal(appended.incrementalFiles, 1);
      if (n >= 2) { warmMs.push(warmTime); appendMs.push(appendTime); }
    }
    return { root, node: process.version, files: 300, eventsPerFile: 40,
      warmMs, appendMs, warmMedianMs: median(warmMs), appendMedianMs: median(appendMs) };
  } finally {
    await module.closeUsageIndex(index);
    await rm(directory, { recursive: true, force: true });
  }
}

if (plainRoot) {
  assert.ok(Number.isInteger(runs) && runs >= 5, "Use at least five runs");
  console.log(JSON.stringify(await measurePlain(plainRoot), null, 2));
} else if (worker) {
  assert.ok(cases.includes(worker));
  console.log(JSON.stringify(await measure(worker, Number(argument("mib", "8")))));
} else {
  assert.ok(Number.isInteger(runs) && runs >= 5, "Use at least five runs");
  assert.ok(sizes.length >= 3 && sizes.every((n) => Number.isFinite(n) && n > 0));
  async function sample(scenario, mib) {
    const observations = [];
    for (let run = 0; run < runs; run++) {
      const { stdout } = await exec(process.execPath, ["--no-warnings", process.argv[1], `--worker=${scenario}`, `--mib=${mib}`], { maxBuffer: 1024 * 1024 });
      observations.push(JSON.parse(stdout));
    }
    return { scenario, compressedFiles: 4, irrelevantMiBPerFile: mib, runs,
      medians: Object.fromEntries(Object.keys(observations[0]).map((key) => [key, median(observations.map((row) => row[key]))])), observations };
  }
  const scenarios = [];
  for (const scenario of cases) scenarios.push(await sample(scenario, sizes[0]));
  const memoryScaling = [scenarios[0]];
  for (const mib of sizes.slice(1)) memoryScaling.push(await sample("cold", mib));
  console.log(JSON.stringify({ node: process.version, platform: process.platform, scenarios, memoryScaling }, null, 2));
}
