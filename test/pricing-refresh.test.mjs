import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  mergePricingCatalogs,
  normalizePricingCatalog,
  selectVersion,
} from "../bin/pricing-catalog.mjs";
import {
  applyVerifiedSeedVersion,
  parseModelPricingMarkdown,
  readRuntimePricingCache,
  refreshPricingSnapshot,
  writeRuntimePricingCache,
} from "../bin/pricing-refresh.mjs";

function modelPage(model, {
  input = 5,
  cachedInput = 0.5,
  output = 30,
  cacheWrite = false,
  longContext = false,
  boldId = false,
} = {}) {
  const modelId = boldId ? `**Model ID:** \`${model}\`` : `Model ID: \`${model}\``;
  return `# ${model}

${modelId}

## Pricing

### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $${input} | 1M tokens |
| Cached input | ${cachedInput == null ? "-" : `$${cachedInput}`} | 1M tokens |
| Output | $${output} | 1M tokens |

${cacheWrite ? "- Cache writes are billed at 1.25x the uncached input token rate." : ""}
${longContext ? "- Prompts with >272K input tokens are priced at 2x input and 1.5x output for the full request." : ""}

### Quick comparison

| Model | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| some-other-model | $0.01 | $0.001 | $0.02 |
`;
}

function oneModelCatalog(model = "gpt-test") {
  return normalizePricingCatalog({
    schemaVersion: 2,
    currency: "USD",
    basis: "test",
    estimateLabel: "test",
    checkedAt: "2026-08-01T00:00:00.000Z",
    aliases: {},
    assumedRoutes: {},
    sourceUrls: [],
    models: {
      [model]: {
        sourceUrl: `https://developers.openai.com/api/docs/models/${model}.md`,
        versions: [
          {
            id: `${model}-baseline`,
            effectiveFrom: null,
            provisional: true,
            serviceTier: "standard",
            input: 5,
            cachedInput: 0.5,
            output: 30,
            sourceUrl: `https://developers.openai.com/api/docs/models/${model}.md`,
            observedAt: "2026-08-01T00:00:00.000Z",
            contentHash: "baseline",
            evidenceLevel: "test",
          },
        ],
      },
    },
  });
}

test("migrates a v1 flat snapshot into provisional history", () => {
  const migrated = normalizePricingCatalog({
    currency: "USD",
    updatedAt: "2026-08-01",
    longContextThresholdTokens: 272000,
    sourceUrls: ["https://developers.openai.com/api/docs/pricing"],
    aliases: {},
    assumedAliases: {},
    models: { "gpt-old": { input: 1, cachedInput: 0.1, output: 6 } },
  });
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.models["gpt-old"].versions[0].effectiveFrom, null);
  assert.equal(migrated.models["gpt-old"].versions[0].provisional, true);
});

test("parses only the official model page Pricing / Text tokens section", () => {
  const parsed = parseModelPricingMarkdown(
    modelPage("gpt-5.6-sol", { cacheWrite: true, longContext: true, boldId: true }),
    "gpt-5.6-sol",
  );
  assert.deepEqual(
    {
      input: parsed.input,
      cachedInput: parsed.cachedInput,
      cacheWrite: parsed.cacheWrite,
      output: parsed.output,
      threshold: parsed.longContextThresholdTokens,
      long: parsed.longContext,
    },
    {
      input: 5,
      cachedInput: 0.5,
      cacheWrite: 6.25,
      output: 30,
      threshold: 272_000,
      long: { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 45 },
    },
  );
});

test("ignores pricing modifiers outside the Text tokens subsection", () => {
  const page = modelPage("gpt-section-scope").replace(
    "### Quick comparison",
    `### Other pricing notes

Cache writes are billed at 1.25x the uncached input token rate.
Prompts with >272K input tokens are priced at 2x input and 1.5x output.

### Quick comparison`,
  );
  const parsed = parseModelPricingMarkdown(page, "gpt-section-scope");
  assert.equal(parsed.cacheWrite, undefined);
  assert.equal(parsed.longContext, undefined);
});

test("supports Pro pages without a cached-input discount", () => {
  const parsed = parseModelPricingMarkdown(
    modelPage("gpt-5.5-pro", { input: 30, cachedInput: null, output: 180 }),
    "gpt-5.5-pro",
  );
  assert.equal(parsed.input, 30);
  assert.equal(parsed.output, 180);
  assert.equal(parsed.cachedInput, undefined);
});

test("rejects the wrong Model ID and missing text-token prices", () => {
  assert.throws(
    () => parseModelPricingMarkdown(modelPage("gpt-other"), "gpt-expected"),
    /Model ID mismatch/,
  );
  assert.throws(
    () => parseModelPricingMarkdown(modelPage("GPT-EXPECTED"), "gpt-expected"),
    /Model ID mismatch/,
  );
  assert.throws(
    () =>
      parseModelPricingMarkdown(
        "# Empty\n\nModel ID: `gpt-empty`\n\n## Pricing\n\n### Text tokens\n\nNo rates.",
        "gpt-empty",
      ),
    /missing positive Input or Output/,
  );
  assert.throws(
    () =>
      parseModelPricingMarkdown(
        modelPage("gpt-wrong-unit").replaceAll("1M tokens", "1K tokens"),
        "gpt-wrong-unit",
      ),
    /missing positive Input or Output/,
  );
});

test("uses conditional headers and does not append a duplicate version", async () => {
  const snapshot = oneModelCatalog();
  snapshot.httpCache = { "gpt-test": { etag: '"abc"', lastModified: "Tue, 18 Aug 2026 00:00:00 GMT" } };
  let receivedHeaders;
  const result = await refreshPricingSnapshot(snapshot, {
    fetchImpl: async (_url, options) => {
      receivedHeaders = options.headers;
      return new Response(null, { status: 304 });
    },
    now: new Date("2026-08-19T12:00:00.000Z"),
  });
  assert.equal(receivedHeaders["if-none-match"], '"abc"');
  assert.equal(receivedHeaders["if-modified-since"], "Tue, 18 Aug 2026 00:00:00 GMT");
  assert.equal(result.refreshStatus, "fresh");
  assert.equal(result.changes.length, 0);
  assert.equal(result.snapshot.models["gpt-test"].versions.length, 1);
  assert.equal(result.snapshot.httpCache["gpt-test"].validatedAt, "2026-08-19T12:00:00.000Z");
});

test("can restrict a manual refresh to explicitly requested models", async () => {
  const snapshot = oneModelCatalog("gpt-one");
  snapshot.models["gpt-two"] = structuredClone(snapshot.models["gpt-one"]);
  snapshot.models["gpt-two"].versions[0].id = "gpt-two-baseline";
  const requested = [];
  await refreshPricingSnapshot(snapshot, {
    models: ["gpt-two"],
    includeCatalogModels: false,
    fetchImpl: async (url) => {
      requested.push(url);
      return new Response(modelPage("gpt-two"), { status: 200 });
    },
  });
  assert.equal(requested.length, 1);
  assert.match(requested[0], /gpt-two\.md$/);
});

test("refreshes an observed official alias through its canonical model page", async () => {
  const snapshot = oneModelCatalog("gpt-canonical");
  snapshot.aliases = { "gpt-alias": "gpt-canonical" };
  const requested = [];
  const result = await refreshPricingSnapshot(snapshot, {
    models: ["gpt-alias"],
    includeCatalogModels: false,
    fetchImpl: async (url) => {
      requested.push(url);
      return new Response(modelPage("gpt-canonical"), { status: 200 });
    },
  });
  assert.equal(result.refreshStatus, "fresh");
  assert.equal(requested.length, 1);
  assert.match(requested[0], /gpt-canonical\.md$/);
});

test("skips invalid observed model IDs without treating them as refresh failures", async () => {
  const snapshot = oneModelCatalog("gpt-valid");
  const requested = [];
  const result = await refreshPricingSnapshot(snapshot, {
    models: ["(unknown model)", "", "bad model", "GPT-VALID"],
    includeCatalogModels: false,
    fetchImpl: async (url) => {
      requested.push(url);
      return new Response(modelPage("gpt-valid"), { status: 200 });
    },
  });

  assert.equal(requested.length, 1);
  assert.match(requested[0], /gpt-valid\.md$/);
  assert.deepEqual(result.skippedModels, ["", "(unknown model)", "bad model"]);
  assert.deepEqual(result.failures, []);
  assert.equal(result.refreshStatus, "fresh");
  assert.equal(result.usedFallback, false);
  assert.equal(result.warning, null);
});

test("adds a changed price once as a first-observed provisional version", async () => {
  let snapshot = oneModelCatalog();
  const now = new Date("2026-08-19T12:34:56.000Z");
  const fetchImpl = async () =>
    new Response(modelPage("gpt-test", { input: 4, cachedInput: 0.4, output: 24 }), {
      status: 200,
      headers: { etag: '"new"' },
    });
  const first = await refreshPricingSnapshot(snapshot, { fetchImpl, now });
  assert.equal(first.changes.length, 1);
  assert.equal(first.changes[0].version.effectiveFrom, now.toISOString());
  assert.equal(first.changes[0].version.provisional, true);
  snapshot = first.snapshot;
  const second = await refreshPricingSnapshot(snapshot, { fetchImpl, now: new Date(now.getTime() + 1000) });
  assert.equal(second.changes.length, 0);
  assert.equal(second.snapshot.models["gpt-test"].versions.length, 2);
});

test("records an official page that removes optional pricing modifiers", async () => {
  const snapshot = oneModelCatalog("gpt-modified");
  Object.assign(snapshot.models["gpt-modified"].versions[0], {
    cacheWrite: 6.25,
    longContextThresholdTokens: 272000,
    longContext: { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 45 },
  });
  const result = await refreshPricingSnapshot(snapshot, {
    fetchImpl: async () => new Response(modelPage("gpt-modified"), { status: 200 }),
  });
  assert.equal(result.refreshStatus, "fresh");
  assert.equal(result.changes.length, 1);
  assert.equal(result.snapshot.models["gpt-modified"].versions.length, 2);
  assert.equal(result.changes[0].version.cacheWrite, undefined);
  assert.equal(result.changes[0].version.longContext, undefined);
});

test("keeps successful models when another official page fails", async () => {
  const snapshot = oneModelCatalog("gpt-one");
  snapshot.models["gpt-two"] = structuredClone(snapshot.models["gpt-one"]);
  snapshot.models["gpt-two"].sourceUrl = "https://developers.openai.com/api/docs/models/gpt-two.md";
  snapshot.models["gpt-two"].versions[0].id = "gpt-two-baseline";
  const result = await refreshPricingSnapshot(snapshot, {
    fetchImpl: async (url) =>
      url.includes("gpt-one")
        ? new Response(modelPage("gpt-one"), { status: 200 })
        : new Response("not found", { status: 404, statusText: "Not Found" }),
  });
  assert.equal(result.refreshStatus, "partial");
  assert.equal(result.usedFallback, true);
  assert.equal(result.successes.length, 1);
  assert.equal(result.failures.length, 1);
});

test("caps official page fetches at six concurrent requests", async () => {
  const snapshot = oneModelCatalog("gpt-0");
  for (let index = 1; index < 9; index += 1) {
    const model = `gpt-${index}`;
    snapshot.models[model] = structuredClone(snapshot.models["gpt-0"]);
    snapshot.models[model].sourceUrl = `https://developers.openai.com/api/docs/models/${model}.md`;
    snapshot.models[model].versions[0].id = `${model}-baseline`;
  }
  let active = 0;
  let maximum = 0;
  await refreshPricingSnapshot(snapshot, {
    concurrency: 99,
    fetchImpl: async (url) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const model = decodeURIComponent(url.split("/").at(-1).replace(/\.md$/, ""));
      return new Response(modelPage(model), { status: 200 });
    },
  });
  assert.equal(maximum, 6);
});

test("enforces the overall refresh timeout and falls back to cache", async () => {
  const result = await refreshPricingSnapshot(oneModelCatalog(), {
    timeoutMs: 20,
    fetchImpl: async (_url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  });
  assert.equal(result.refreshStatus, "cached");
  assert.equal(result.usedFallback, true);
  assert.equal(result.failures.length, 1);
});

test("preserves a corrupt cache and atomically serializes concurrent writers", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-pricing-cache-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cachePath = path.join(directory, "pricing-history.json");
  await writeFile(cachePath, "{broken");
  const corrupt = await readRuntimePricingCache(cachePath);
  assert.equal(corrupt.snapshot, null);
  assert.ok(corrupt.corruptBackupPath);
  assert.equal(await readFile(corrupt.corruptBackupPath, "utf8"), "{broken");

  const first = oneModelCatalog("gpt-one");
  const second = oneModelCatalog("gpt-two");
  await Promise.all([
    writeRuntimePricingCache(cachePath, first),
    writeRuntimePricingCache(cachePath, second),
  ]);
  const loaded = await readRuntimePricingCache(cachePath, { preserveCorrupt: false });
  assert.ok(loaded.snapshot.models["gpt-one"]);
  assert.ok(loaded.snapshot.models["gpt-two"]);

  const newerMetadata = oneModelCatalog("gpt-newer-metadata");
  newerMetadata.httpCache = {
    shared: { etag: '"newer"', validatedAt: "2026-08-19T02:00:00.000Z" },
  };
  const olderMetadata = oneModelCatalog("gpt-older-metadata");
  olderMetadata.httpCache = {
    shared: { etag: '"older"', validatedAt: "2026-08-19T01:00:00.000Z" },
  };
  await writeRuntimePricingCache(cachePath, newerMetadata);
  await writeRuntimePricingCache(cachePath, olderMetadata);
  const mergedMetadata = await readRuntimePricingCache(cachePath, { preserveCorrupt: false });
  assert.equal(mergedMetadata.snapshot.httpCache.shared.etag, '"newer"');

  const directoryPath = path.join(directory, "not-a-cache-file");
  await mkdir(directoryPath);
  const invalidType = await readRuntimePricingCache(directoryPath);
  assert.equal(invalidType.snapshot, null);
  assert.equal(invalidType.corruptBackupPath, null);
  assert.equal((await stat(directoryPath)).isDirectory(), true);
});

test("keeps first-observed audit versions but ignores them after formal seeding", () => {
  const snapshot = oneModelCatalog();
  const parsed = parseModelPricingMarkdown(modelPage("gpt-test"), "gpt-test");
  snapshot.models["gpt-test"].versions.push({
    ...parsed,
    id: "gpt-test-observed",
    effectiveFrom: "2026-08-19T00:00:00.000Z",
    provisional: true,
    observedAt: "2026-08-19T00:00:00.000Z",
  });
  const seeded = applyVerifiedSeedVersion(snapshot, {
    model: "gpt-test",
    parsed,
    effectiveFrom: "2026-08-10",
    sourceUrl: "https://openai.com/index/example/",
  });
  const observed = seeded.snapshot.models["gpt-test"].versions.find(
    (version) => version.id === "gpt-test-observed",
  );
  assert.equal(observed.supersededBy, "gpt-test-2026-08-10");
  assert.equal(
    selectVersion(seeded.snapshot.models["gpt-test"].versions, Date.parse("2026-08-20T00:00:00Z")).id,
    "gpt-test-2026-08-10",
  );
});

test("a newer built-in formal version supersedes the matching runtime observation", () => {
  const runtime = oneModelCatalog();
  runtime.models["gpt-test"].versions.push({
    ...runtime.models["gpt-test"].versions[0],
    id: "gpt-test-observed",
    effectiveFrom: "2026-08-19T00:00:00.000Z",
    observedAt: "2026-08-19T00:00:00.000Z",
  });
  const seed = oneModelCatalog();
  seed.models["gpt-test"].versions.push({
    ...seed.models["gpt-test"].versions[0],
    id: "gpt-test-2026-08-10",
    effectiveFrom: "2026-08-10T00:00:00.000Z",
    provisional: false,
  });
  const merged = mergePricingCatalogs(seed, runtime);
  const observed = merged.models["gpt-test"].versions.find(
    (version) => version.id === "gpt-test-observed",
  );
  assert.equal(observed.supersededBy, "gpt-test-2026-08-10");
});
