import path from "node:path";
import { pricingCatalogVersion, pricingMetadata } from "./openai-pricing.mjs";
import {
  cachedIndexStats,
  getIndexStatus,
  syncPublishedRevision,
  ensureFreshIndex,
  invalidateUsageCaches,
} from "./usage-index.mjs";
import { usagePayloadFromIndex } from "./usage-index-view.mjs";

export const DEFAULT_QUERY_CACHE_ENTRIES = 64;

export function createUsageQueryService(index, {
  maxEntries = DEFAULT_QUERY_CACHE_ENTRIES,
  pricingRefreshState = { running: false, revision: 0 },
} = {}) {
  const resultCache = new Map();
  const capacity = Math.max(1, Number(maxEntries) || DEFAULT_QUERY_CACHE_ENTRIES);
  let activePricingVersion = pricingCatalogVersion();

  function status(sessionsDirs) {
    return {
      ...getIndexStatus(index, sessionsDirs),
      pricingRefresh: { ...pricingRefreshState },
    };
  }

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

    let refreshedStats;
    if (refreshIndex) {
      refreshedStats = await ensureFreshIndex(index, options.sessionsDirs, { force: true });
      clear();
    }

    // A CLI process can publish between our synchronous SQLite statements.
    // Retry a raced read rather than labeling old totals with a new revision.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      syncPublishedRevision(index);
      const generation = index.generation;
      const syncStats = attempt === 0 && refreshedStats?.publishedRevision === generation
        ? refreshedStats : cachedIndexStats(index, options.sessionsDirs);
      const key = resultCacheKey(index, options, syncPricingVersion());
      const cached = cachedPayload(key, startedAt);
      const payload = cached || usagePayloadFromIndex(index, syncStats, options);
      payload.index = status(options.sessionsDirs);
      // A 304 or failed pricing check changes metadata without changing rates.
      // Keep the cached aggregation, but never cache its refresh warning/status.
      if (cached) payload.pricing = pricingMetadata();
      if (index.generation !== generation) {
        clear();
        continue;
      }
      if (!cached) {
        payload.stats.indexRefreshSkipped = !refreshIndex;
        payload.stats.queryCacheHit = false;
        payload.stats.totalDurationMs = Math.round(performance.now() - startedAt);
        cachePayload(key, payload);
      }
      return payload;
    }
    throw new Error("Usage index kept changing during this query; retry the request.");
  }

  return {
    clear,
    query,
    status,
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
    decodedBytes: 0,
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
