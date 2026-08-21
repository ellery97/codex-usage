#!/usr/bin/env node

import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  knownPricingModels,
  pricingCatalogSnapshot,
  PRICING_SNAPSHOT_PATH,
  refreshPricing,
} from "./openai-pricing.mjs";
import { normalizePricingCatalog } from "./pricing-catalog.mjs";
import {
  applyVerifiedSeedVersion,
  modelPricingUrl,
  parseModelPricingMarkdown,
} from "./pricing-refresh.mjs";

const __filename = fileURLToPath(import.meta.url);

export function parseUpdateArgs(argv) {
  const options = {
    check: false,
    seed: false,
    models: [],
    effectiveFrom: null,
    sourceUrl: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${arg}.`);
      return argv[index];
    };
    if (arg === "--check") options.check = true;
    else if (arg === "--seed") options.seed = true;
    else if (arg === "--model") options.models.push(next());
    else if (arg === "--effective-from") options.effectiveFrom = next();
    else if (arg === "--source-url") options.sourceUrl = next();
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.seed) {
    if (options.models.length !== 1) throw new Error("--seed requires exactly one --model.");
    if (!options.effectiveFrom) throw new Error("--seed requires --effective-from YYYY-MM-DD.");
    if (!options.sourceUrl) throw new Error("--seed requires --source-url.");
  } else if (options.effectiveFrom || options.sourceUrl) {
    throw new Error("--effective-from and --source-url are only valid with --seed.");
  }
  return options;
}

export async function main(argv = process.argv.slice(2), { fetchImpl = globalThis.fetch } = {}) {
  const options = parseUpdateArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }
  if (options.seed) {
    await seedBuiltInCatalog(options, fetchImpl);
    return;
  }

  const result = await refreshPricing({
    models: options.models.length > 0 ? options.models : knownPricingModels(),
    includeCatalogModels: options.models.length === 0,
    force: true,
    checkOnly: options.check,
    fetchImpl,
  });
  printRefreshResult(result, options.check);
  if (result.successes.length === 0 && result.failures.length > 0) {
    throw new Error("No official model page could be refreshed; the cached catalog was left unchanged.");
  }
}

async function seedBuiltInCatalog(options, fetchImpl) {
  const model = options.models[0];
  const response = await fetchImpl(modelPricingUrl(model), {
    headers: { accept: "text/markdown" },
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Failed to fetch ${model}: ${response.status} ${response.statusText}`);
  const parsed = parseModelPricingMarkdown(await response.text(), model);
  const builtIn = normalizePricingCatalog(JSON.parse(await readFile(PRICING_SNAPSHOT_PATH, "utf8")));
  const result = applyVerifiedSeedVersion(builtIn, {
    model,
    parsed,
    effectiveFrom: options.effectiveFrom,
    sourceUrl: options.sourceUrl,
  });
  if (!result.changed) {
    console.log(`${model} already has that verified ${options.effectiveFrom} price version.`);
    return;
  }
  if (options.check) {
    console.log(`Would add ${model} effective ${options.effectiveFrom}; built-in catalog was not changed.`);
    return;
  }
  await writeCatalogAtomically(PRICING_SNAPSHOT_PATH, result.snapshot);
  console.log(`Added ${model} effective ${options.effectiveFrom} to ${PRICING_SNAPSHOT_PATH}`);
}

async function writeCatalogAtomically(filePath, snapshot) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

function printRefreshResult(result, checkOnly) {
  const action = checkOnly ? "Checked" : "Refreshed";
  console.log(`${action} ${result.successes.length} official model page(s); status=${result.refreshStatus}.`);
  for (const change of result.changes) {
    console.log(`${change.model}: ${formatRates(change.previous)} -> ${formatRates(change.current)} (provisional)`);
  }
  if (result.changes.length === 0) console.log("No price changes detected.");
  if (result.failures.length > 0) {
    console.warn(`Kept cached prices for: ${result.failures.map(({ model }) => model).join(", ")}`);
  }
  if (!checkOnly) {
    const snapshot = pricingCatalogSnapshot();
    console.log(`Runtime catalog checked at ${snapshot.checkedAt || "unknown"}.`);
  }
}

function formatRates(rates) {
  if (!rates) return "new";
  return `${rates.input}/${rates.cachedInput ?? "-"}/${rates.cacheWrite ?? "-"}/${rates.output}`;
}

function helpText() {
  return `Usage:
  npm run update-pricing
  npm run update-pricing -- --check
  npm run update-pricing -- --model gpt-5.6-sol
  npm run update-pricing -- --seed --model MODEL --effective-from YYYY-MM-DD --source-url URL

The normal command force-refreshes the runtime cache from official per-model Markdown pages.
--check reports differences without writing. --seed adds a manually verified dated version to the built-in catalog.`;
}

function isDirectRun() {
  return process.argv[1] && __filename === path.resolve(process.argv[1]);
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(`update-pricing: ${error.message}`);
    process.exitCode = 1;
  });
}
