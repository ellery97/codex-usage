import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  contentHash,
  mergePricingCatalogs,
  normalizeModelForPricing,
  normalizePricingCatalog,
  PricingCatalog,
} from "./pricing-catalog.mjs";
import {
  DEFAULT_PRICING_TIMEOUT_MS,
  readRuntimePricingCache,
  refreshPricingSnapshot,
  writeRuntimePricingCache,
} from "./pricing-refresh.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
export const PRICING_SNAPSHOT_PATH = path.join(ROOT, "pricing", "openai-pricing.snapshot.json");
export const DEFAULT_PRICING_CACHE_PATH = path.join(ROOT, ".codex-usage", "pricing-history.json");

const BUILT_IN_SNAPSHOT = loadBuiltInSnapshot();
let catalog = new PricingCatalog(BUILT_IN_SNAPSHOT, {
  refreshStatus: "cached",
  usedFallback: false,
});
let initializedCachePath = null;

export const PRICING_UPDATED_AT = BUILT_IN_SNAPSHOT.checkedAt?.slice(0, 10) || "unknown";
export const PRICING_CURRENCY = BUILT_IN_SNAPSHOT.currency;
export const PRICING_BASIS = BUILT_IN_SNAPSHOT.basis;
export const PRICING_ESTIMATE_LABEL = BUILT_IN_SNAPSHOT.estimateLabel;
export const PRICING_SOURCE_URLS = BUILT_IN_SNAPSHOT.sourceUrls;

export { normalizeModelForPricing };

export function defaultPricingCachePath(dbPath) {
  if (process.env.CODEX_USAGE_PRICING_CACHE) {
    return path.resolve(process.env.CODEX_USAGE_PRICING_CACHE);
  }
  return dbPath ? path.join(path.dirname(path.resolve(dbPath)), "pricing-history.json") : DEFAULT_PRICING_CACHE_PATH;
}

export async function initializePricing({ dbPath, cachePath, preserveCorrupt = true } = {}) {
  const resolvedCachePath = path.resolve(cachePath || defaultPricingCachePath(dbPath));
  if (initializedCachePath === resolvedCachePath) return pricingMetadata();
  const loaded = await readRuntimePricingCache(resolvedCachePath, { preserveCorrupt });
  const merged = mergePricingCatalogs(BUILT_IN_SNAPSHOT, loaded.snapshot);
  catalog.replace(merged, {
    cachePath: resolvedCachePath,
    refreshStatus: "cached",
    usedFallback: Boolean(loaded.error),
    warning: loaded.error
      ? `Pricing cache was invalid${loaded.corruptBackupPath ? ` and preserved at ${loaded.corruptBackupPath}` : ""}; the built-in catalog is in use.`
      : null,
  });
  initializedCachePath = resolvedCachePath;
  return pricingMetadata();
}

export async function refreshPricing({
  models = [],
  dbPath,
  cachePath,
  timeoutMs = pricingTimeoutMs(),
  concurrency = 6,
  force = false,
  includeCatalogModels = true,
  checkOnly = false,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  enabled = process.env.CODEX_USAGE_PRICING_REFRESH !== "0",
} = {}) {
  await initializePricing({ dbPath, cachePath, preserveCorrupt: !checkOnly });
  if (!enabled) {
    catalog.state.refreshStatus = "cached";
    return { snapshot: catalog.snapshot, changes: [], successes: [], failures: [], ...catalog.state };
  }

  const previousSnapshot = catalog.snapshot;
  const result = await refreshPricingSnapshot(catalog.snapshot, {
    models,
    fetchImpl,
    timeoutMs,
    concurrency,
    force,
    includeCatalogModels,
    now,
  });
  if (!checkOnly) {
    catalog.replace(result.snapshot, {
      ...catalog.state,
      refreshStatus: result.refreshStatus,
      usedFallback: result.usedFallback,
      warning: result.warning,
    });
    if (result.successes.length > 0) {
      try {
        const savedSnapshot = await writeRuntimePricingCache(catalog.state.cachePath, catalog.snapshot);
        catalog.replace(savedSnapshot, catalog.state);
        result.snapshot = savedSnapshot;
      } catch (error) {
        const warning = `Pricing refresh could not update the runtime cache: ${error.message}; the previous validated catalog is in use.`;
        catalog.replace(previousSnapshot, {
          ...catalog.state,
          refreshStatus: "cached",
          usedFallback: true,
          warning,
        });
        return {
          ...result,
          snapshot: previousSnapshot,
          refreshStatus: "cached",
          usedFallback: true,
          warning,
          writeError: error,
        };
      }
    }
  }
  return result;
}

export function knownPricingModels() {
  return Object.keys(catalog.snapshot.models).sort();
}

export function priceForModel(model, timestampMs = null) {
  return catalog.priceForModel(model, timestampMs);
}

export function estimateUsageCostDetails(model, usage, timestampMs = null) {
  return catalog.estimateUsageCost(model, usage, timestampMs);
}

export function estimateUsageCostUsd(model, usage, timestampMs = null) {
  return estimateUsageCostDetails(model, usage, timestampMs)?.costUsd ?? null;
}

export function assumedPriceForModel(model, timestampMs = null) {
  return catalog.assumedPriceForModel(model, timestampMs);
}

export function estimateAssumedUsageCostUsd(model, usage, timestampMs = null) {
  return catalog.estimateAssumedUsageCost(model, usage, timestampMs);
}

export function costStatsForUsage(model, usage, timestampMs = null) {
  if (timestampMs == null) {
    const totalTokens =
      positiveNumber(usage?.total_tokens) ||
      positiveNumber(usage?.input_tokens) + positiveNumber(usage?.output_tokens);
    return {
      estimated_cost_usd: 0,
      assumed_cost_usd: 0,
      assumed_upper_bound_cost_usd: 0,
      reference_total_cost_usd: 0,
      reference_total_upper_bound_cost_usd: 0,
      priced_requests: 0,
      assumed_requests: 0,
      unpriced_requests: 1,
      priced_total_tokens: 0,
      assumed_total_tokens: 0,
      unpriced_total_tokens: totalTokens,
      provisional_priced_requests: 0,
      provisional_priced_total_tokens: 0,
      provisional_estimated_cost_usd: 0,
    };
  }
  return catalog.costStatsForUsage(model, usage, timestampMs);
}

export function pricingMetadata() {
  return catalog.metadata();
}

export function pricingCatalogSnapshot() {
  return structuredClone(catalog.snapshot);
}

export function pricingCatalogVersion() {
  return contentHash(
    JSON.stringify({
      aliases: catalog.snapshot.aliases,
      models: catalog.snapshot.models,
      assumedRoutes: catalog.snapshot.assumedRoutes,
    }),
  );
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function pricingTimeoutMs() {
  const value = Number(process.env.CODEX_USAGE_PRICING_TIMEOUT_MS || DEFAULT_PRICING_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PRICING_TIMEOUT_MS;
}

function loadBuiltInSnapshot() {
  try {
    return normalizePricingCatalog(JSON.parse(readFileSync(PRICING_SNAPSHOT_PATH, "utf8")), {
      source: `built-in pricing catalog ${PRICING_SNAPSHOT_PATH}`,
    });
  } catch (error) {
    throw new Error(`Failed to read pricing catalog at ${PRICING_SNAPSHOT_PATH}: ${error.message}`, {
      cause: error,
    });
  }
}
