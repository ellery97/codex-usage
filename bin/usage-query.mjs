import path from "node:path";
import { pricingCatalogVersion } from "./openai-pricing.mjs";
import {
  cachedIndexStats,
  ensureFreshIndex,
  invalidateUsageCaches,
} from "./usage-index.mjs";
import { usagePayloadFromIndex } from "./usage-index-view.mjs";

export const DEFAULT_QUERY_CACHE_ENTRIES = 64;

export function createUsageQueryService(index, { maxEntries = DEFAULT_QUERY_CACHE_ENTRIES } = {}) {
  const resultCache = new Map();
  const capacity = Math.max(1, Number(maxEntries) || DEFAULT_QUERY_CACHE_ENTRIES);
  let activePricingVersion = pricingCatalogVersion();

  function clear() {
    resultCache.clear();
    invalidateUsageCaches(index);
  }

  function syncPricingVersion() {
    const current = pricingCatalogVersion();
    if (current !== activePricingVersion) {
      activePricingVersion = current;
      clear();
    }
    return current;
  }

  function cachedPayload(key, startedAt) {
    const cached = resultCache.get(key);
    if (!cached) return null;

    resultCache.delete(key);
    resultCache.set(key, cached);
    const payload = structuredClone(cached);
    resetCachedTimings(payload.stats, performance.now() - startedAt);
    return payload;
  }

  function cachePayload(key, payload) {
    resultCache.set(key, structuredClone(payload));
    evictOldResults(resultCache, capacity);
  }

  async function query(options, { refreshIndex = true } = {}) {
    const startedAt = performance.now();
    syncPricingVersion();

    let syncStats;
    if (refreshIndex) {
      syncStats = await ensureFreshIndex(index, options.sessionsDirs, { force: true });
      clear();
    } else {
      // refreshIndex=false means "do not start a refresh", not "read a database
      // while another refresh is publishing file-by-file transactions". Waiting
      // here gives readers a stable post-refresh generation without triggering IO.
      if (index.refreshPromise) {
        await index.refreshPromise;
      }
      syncStats = cachedIndexStats(index, options.sessionsDirs);
    }

    const currentPricingVersion = syncPricingVersion();
    const key = resultCacheKey(index, options, currentPricingVersion);
    const cached = cachedPayload(key, startedAt);
    if (cached) return cached;

    const payload = usagePayloadFromIndex(index, syncStats, options);
    payload.stats.indexRefreshSkipped = !refreshIndex;
    payload.stats.queryCacheHit = false;
    payload.stats.totalDurationMs = Math.round(performance.now() - startedAt);
    cachePayload(key, payload);
    return payload;
  }

  return {
    clear,
    query,
    get size() {
      return resultCache.size;
    },
  };
}

function resultCacheKey(index, options, pricingVersion) {
  return JSON.stringify({
    roots: Array.from(new Set(options.sessionsDirs.map((dir) => path.resolve(dir)))).sort(),
    dedupeScope: options.dedupeScope,
    fromMs: options.fromMs ?? null,
    toMs: options.toMs ?? null,
    timezone: options.timezone,
    group: options.group,
    sort: options.sort,
    desc: Boolean(options.desc),
    limit: Number(options.limit || 0),
    sourceScope: options.sourceScope || "all",
    rangeKey: options.rangeKey || null,
    generation: index.generation,
    pricingVersion,
  });
}

function resetCachedTimings(stats, elapsedMs) {
  Object.assign(stats, {
    changedFiles: 0,
    deletedFiles: 0,
    incrementalFiles: 0,
    fullRescanFiles: 0,
    scannedBytes: 0,
    scanDurationMs: 0,
    dedupeDurationMs: 0,
    aggregationDurationMs: 0,
    totalDurationMs: Math.round(elapsedMs),
    canonicalRebuilt: false,
    canonicalUpdatedKeys: 0,
    indexRefreshSkipped: true,
    queryCacheHit: true,
    costCacheHit: true,
  });
}

function evictOldResults(cache, capacity) {
  while (cache.size > capacity) {
    cache.delete(cache.keys().next().value);
  }
}
