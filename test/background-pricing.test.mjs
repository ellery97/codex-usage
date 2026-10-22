import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startDashboard } from "../bin/codex-usage-server.mjs";
import { pricingCatalogSnapshot, pricingCatalogVersion, pricingMetadata, refreshPricing } from "../bin/openai-pricing.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

for (const httpStatus of [304, 503, 200]) {
  test(`background pricing ${httpStatus} updates cached API metadata and publishes completion`, { timeout: 10000 }, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "codex-background-pricing-test-"));
    const sessions = path.join(directory, "sessions");
    const cache = path.join(directory, "pricing.json");
    const env = {
      CODEX_HOME: directory, CODEX_USAGE_SESSIONS: sessions, CODEX_USAGE_PRICING_CACHE: cache,
      CODEX_USAGE_WINDOWS_ROOT: path.join(directory, "windows"), CODEX_USAGE_WSL_DISTROS: "SyntheticMissingDistro",
    };
    const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
    const gate = deferred(), entered = deferred();
    let dashboard;
    t.after(async () => {
      gate.resolve();
      if (dashboard) {
        const stopped = new Promise((resolve) => dashboard.server.close(resolve));
        await dashboard.close();
        await stopped;
      }
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(directory, { recursive: true, force: true });
    });
    Object.assign(process.env, env);
    await mkdir(sessions);
    const model = "gpt-5.6-luna";
    const snapshot = pricingCatalogSnapshot();
    snapshot.checkedAt = "2026-10-01T00:00:00Z";
    snapshot.httpCache ||= {};
    snapshot.httpCache[model] = { etag: '"synthetic-etag"' };
    await writeFile(cache, JSON.stringify(snapshot));
    const timestamp = "2026-10-22T10:00:00Z";
    const usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
    await writeFile(path.join(sessions, "synthetic.jsonl"), [
      { timestamp, type: "session_meta", payload: { id: "synthetic-pricing", cwd: directory } },
      { timestamp, type: "turn_context", payload: { model, cwd: directory } },
      { timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");

    let networkRequests = 0;
    dashboard = await startDashboard({
      port: 0, host: "127.0.0.1", dbPath: path.join(directory, "index.sqlite"),
      enableGc: false, refreshPricingEnabled: true,
      refreshPricingImpl: (options) => refreshPricing({
        ...options, includeCatalogModels: false, now: new Date("2026-10-22T10:00:00Z"),
        fetchImpl: async (_url, options) => {
          networkRequests++;
          assert.equal(options.headers["if-none-match"], '"synthetic-etag"');
          entered.resolve();
          await gate.promise;
          const page = `# ${model}\n\nModel ID: \`${model}\`\n\n## Pricing\n\n### Text tokens\n\n` +
            "| Metric | Price | Unit |\n| --- | ---: | --- |\n| Input | $9 | 1M tokens |\n| Cached input | $0.9 | 1M tokens |\n| Output | $11 | 1M tokens |\n";
          return new Response(httpStatus === 200 ? page : null, { status: httpStatus });
        },
      }),
    });
    await entered.promise;
    const get = async (endpoint) => {
      const response = await fetch(`http://127.0.0.1:${dashboard.port}${endpoint}`, { signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 200);
      return response.json();
    };
    const before = await get("/api/usage?range=all&group=model");
    const pending = await get("/api/index/status");
    const priceVersion = pricingCatalogVersion();
    assert.equal(before.totals.requests, 1);
    assert.equal(before.index.running, false);
    assert.equal(before.pricing.refreshStatus, "cached");
    assert.equal(before.pricing.usedFallback, false);

    gate.resolve();
    await dashboard.startupPromise;
    const after = await get("/api/usage?range=all&group=model");
    const completed = await get("/api/index/status");
    assert.equal(networkRequests, 1);
    if (httpStatus === 200) {
      assert.equal(after.stats.queryCacheHit, false);
      assert.equal(after.stats.costCacheHit, false);
      assert.notEqual(pricingCatalogVersion(), priceVersion);
      assert.equal(after.totals.estimated_cost_usd, 0.00101);
      assert.notEqual(after.totals.estimated_cost_usd, before.totals.estimated_cost_usd);
    } else {
      assert.equal(after.stats.queryCacheHit, true, "Status-only changes should reuse aggregated results");
      assert.equal(after.stats.costCacheHit, true);
      assert.equal(pricingCatalogVersion(), priceVersion);
      assert.deepEqual(after.totals, before.totals);
    }
    assert.equal(after.index.revision, before.index.revision);
    assert.equal(after.index.running, false);
    assert.deepEqual(after.pricing, pricingMetadata());
    if (httpStatus !== 503) {
      assert.equal(after.pricing.refreshStatus, "fresh");
      assert.equal(after.pricing.checkedAt, "2026-10-22T10:00:00.000Z");
    } else {
      assert.equal(after.pricing.usedFallback, true);
      assert.match(after.pricing.warning, /Pricing refresh failed/);
    }
    assert.deepEqual(pending.pricingRefresh, { running: true, revision: 0 });
    assert.deepEqual(before.index.pricingRefresh, pending.pricingRefresh);
    assert.deepEqual(completed.pricingRefresh, { running: false, revision: 1 });
    assert.deepEqual(after.index.pricingRefresh, completed.pricingRefresh);
  });
}
