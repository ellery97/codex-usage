import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  formatDateKey,
  formatDateTime,
} from "./codex-token-usage.mjs";
import {
  costStatsForUsage,
  pricingCatalogVersion,
  pricingMetadata,
} from "./openai-pricing.mjs";
import { sqlPathFilter } from "./path-utils.mjs";
import { scanSessionFileRange } from "./session-scanner.mjs";
import { refreshUsageIndex, pathInRoots } from "./usage-index-refresh.mjs";
import { assumedModelsFromAggregatedRows } from "./usage-costs.mjs";
import {
  CANONICAL_SCHEMA_SQL,
  ensureCanonicalScope,
} from "./usage-canonical.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

export const DEFAULT_DB_PATH = path.join(ROOT, ".codex-usage", "cache.sqlite");
export const DEFAULT_SCAN_CHECK_TTL_MS = 1000;
export const DEFAULT_SCAN_CONCURRENCY = 8;
const USAGE_INDEX_SCHEMA_VERSION = 5;

const COST_AGGREGATE_COLUMNS = `
  COALESCE(SUM(COALESCE(estimated_cost_usd, 0)), 0) AS estimated_cost_usd,
  COALESCE(SUM(COALESCE(assumed_cost_usd, 0)), 0) AS assumed_cost_usd,
  COALESCE(SUM(COALESCE(assumed_upper_bound_cost_usd, 0)), 0) AS assumed_upper_bound_cost_usd,
  COALESCE(SUM(CASE WHEN estimated_cost_usd IS NOT NULL THEN 1 ELSE 0 END), 0) AS priced_requests,
  COALESCE(SUM(CASE WHEN estimated_cost_usd IS NULL AND assumed_cost_usd IS NOT NULL THEN 1 ELSE 0 END), 0) AS assumed_requests,
  COALESCE(SUM(CASE WHEN estimated_cost_usd IS NULL AND assumed_cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unpriced_requests,
  COALESCE(SUM(CASE WHEN estimated_cost_usd IS NOT NULL THEN total_tokens ELSE 0 END), 0) AS priced_total_tokens,
  COALESCE(SUM(CASE WHEN estimated_cost_usd IS NULL AND assumed_cost_usd IS NOT NULL THEN total_tokens ELSE 0 END), 0) AS assumed_total_tokens,
  COALESCE(SUM(CASE WHEN estimated_cost_usd IS NULL AND assumed_cost_usd IS NULL THEN total_tokens ELSE 0 END), 0) AS unpriced_total_tokens,
  COALESCE(SUM(provisional_priced_requests), 0) AS provisional_priced_requests,
  COALESCE(SUM(provisional_priced_total_tokens), 0) AS provisional_priced_total_tokens,
  COALESCE(SUM(provisional_estimated_cost_usd), 0) AS provisional_estimated_cost_usd`;

export async function openUsageIndex({
  dbPath = DEFAULT_DB_PATH,
  scanCheckTtlMs = DEFAULT_SCAN_CHECK_TTL_MS,
  scanConcurrency = DEFAULT_SCAN_CONCURRENCY,
  enableGc = true,
  scanFileImpl = scanSessionFileRange,
} = {}) {
  const resolvedDbPath = path.resolve(dbPath);
  await mkdir(path.dirname(resolvedDbPath), { recursive: true });
  const db = new DatabaseSync(resolvedDbPath);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = -4096;
      PRAGMA temp_store = FILE;

      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        events_count INTEGER NOT NULL,
        duplicate_token_events INTEGER NOT NULL,
        parse_errors INTEGER NOT NULL,
        raw_token_events INTEGER NOT NULL,
        scanned_at_ms INTEGER NOT NULL,
        scan_offset INTEGER NOT NULL DEFAULT 0,
        parser_state_json TEXT,
        scanner_version INTEGER NOT NULL DEFAULT 0,
        file_dev TEXT,
        file_ino TEXT,
        boundary_hash TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        file_path TEXT NOT NULL,
        event_index INTEGER NOT NULL,
        timestamp_ms INTEGER,
        has_event_timestamp INTEGER NOT NULL DEFAULT 0,
        session_created_at_ms INTEGER,
        session_id TEXT NOT NULL,
        total_usage_key TEXT NOT NULL,
        cwd TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        cached_input_tokens INTEGER NOT NULL,
        cache_write_input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        reasoning_output_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_file ON events(file_path);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp_ms);
      CREATE INDEX IF NOT EXISTS idx_events_model ON events(model);
      CREATE INDEX IF NOT EXISTS idx_events_cwd ON events(cwd);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    `);
    migrateUsageIndexSchema(db);
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the schema error, which is more useful than a close failure.
    }
    throw new Error(`Failed to migrate usage index at ${resolvedDbPath}: ${error.message}`, {
      cause: error,
    });
  }
  db.function("codex_date_key", (timestampMs, group, timezone) => {
    if (timestampMs == null) return null;
    return formatDateKey(Number(timestampMs), String(group), String(timezone));
  });
  db.function("codex_date_time", (timestampMs, timezone) => {
    if (timestampMs == null) return null;
    return formatDateTime(Number(timestampMs), String(timezone));
  });
  db.function(
    "codex_cost_stats_json",
    (timestampMs, model, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, totalTokens) => {
      const stats = costStatsForUsage(
        String(model || ""),
        usageFromSql(inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, totalTokens),
        timestampMs == null ? null : Number(timestampMs),
      );
      return JSON.stringify({
        estimated_cost_usd: stats.priced_requests ? stats.estimated_cost_usd : null,
        assumed_cost_usd: stats.assumed_requests ? stats.assumed_cost_usd : null,
        assumed_upper_bound_cost_usd: stats.assumed_requests
          ? stats.assumed_upper_bound_cost_usd
          : null,
        provisional_priced_requests: stats.provisional_priced_requests,
        provisional_priced_total_tokens: stats.provisional_priced_total_tokens,
        provisional_estimated_cost_usd: stats.provisional_estimated_cost_usd,
        assumed_route_id: stats.assumedRoute?.routeId || null,
        assumed_model: stats.assumedRoute?.assumedModel || null,
        assumed_upper_bound_model: stats.assumedRoute?.upperBoundModel || null,
        assumed_label: stats.assumedRoute?.label || null,
        assumed_source_url: stats.assumedRoute?.sourceUrl || null,
        assumed_evidence_level: stats.assumedRoute?.evidenceLevel || null,
        assumed_effective_from: stats.assumedRoute?.effectiveFrom || null,
      });
    },
  );

  return {
    db,
    dbPath: resolvedDbPath,
    scanCheckTtlMs: Number(scanCheckTtlMs),
    scanConcurrency: Math.max(1, Math.min(32, Number(scanConcurrency || DEFAULT_SCAN_CONCURRENCY))),
    enableGc,
    scanFileImpl,
    activity: { state: "idle", phase: "idle" },
    pendingFailures: [],
    closing: false,
    controller: null,
    checkedAt: 0,
    lastSync: null,
    refreshPromise: null,
    refreshKey: null,
    generation: Number(db.prepare("SELECT revision FROM index_publication WHERE id = 1").get().revision),
    costCacheKey: null,
    statements: {
      allFiles: db.prepare("SELECT * FROM files"),
      fileKeys: db.prepare("SELECT total_usage_key FROM events WHERE file_path = ?"),
    },
  };
}

export function closeUsageIndex(index) {
  if (!index || index.closePromise) return index?.closePromise;
  index.closing = true;
  index.controller?.abort();
  if (!index.refreshPromise) {
    index.db.close();
    index.closePromise = Promise.resolve();
  } else {
    index.closePromise = index.refreshPromise.catch(() => {}).then(() => index.db.close());
  }
  return index.closePromise;
}

export function syncPublishedRevision(index) {
  const publication = index.db.prepare("SELECT * FROM index_publication WHERE id = 1").get();
  if (index.generation !== Number(publication.revision)) {
    invalidateUsageCaches(index);
    index.generation = Number(publication.revision);
    index.checkedAt = 0;
  }
  return publication;
}

export function getIndexStatus(index, roots = null) {
  const publication = syncPublishedRevision(index);
  const failures = new Map(index.db.prepare("SELECT * FROM scan_failures").all().map((row) => [row.path, {
    path: row.path, signature: row.signature, code: row.error_code, message: row.message,
    attemptedAt: row.attempted_at_ms, retainedPaths: JSON.parse(row.retained_paths_json),
  }]));
  for (const failure of index.pendingFailures) failures.set(failure.path, failure);
  const selected = [...failures.values()].filter((row) => !roots || pathInRoots(row.path, roots));
  const running = Boolean(index.refreshPromise);
  const incomplete = running || selected.length > 0 || index.activity.state === "failed" || !publication.has_snapshot;
  return {
    files: 0, pendingFiles: null, completedFiles: 0, scannedBytes: 0, decodedBytes: 0,
    ...index.activity,
    running, incomplete, hasSnapshot: Boolean(publication.has_snapshot),
    revision: Number(publication.revision), publishedAt: publication.published_at_ms,
    failedFiles: selected.length,
    failures: selected.map((row) => ({ ...row, usingPreviousIndex: row.retainedPaths.length > 0 })),
  };
}

export function invalidateUsageCaches(index, { bumpGeneration = false } = {}) {
  if (!index?.db) return;
  index.db.exec("DROP TABLE IF EXISTS temp.request_costed_events");
  index.costCacheKey = null;
  if (bumpGeneration) index.generation += 1;
}

export function modelsInUsageIndex(index, sessionsDirs = null) {
  if (!Array.isArray(sessionsDirs) || sessionsDirs.length === 0) {
    return index.db
      .prepare("SELECT DISTINCT model FROM events WHERE model NOT IN ('', '(unknown model)') ORDER BY model")
      .all()
      .map((row) => String(row.model));
  }
  const filter = sqlPathFilter("file_path", sessionsDirs);
  return index.db
    .prepare(`SELECT DISTINCT model FROM events WHERE model NOT IN ('', '(unknown model)') AND ${filter.sql} ORDER BY model`)
    .all(...filter.params)
    .map((row) => String(row.model));
}

export async function ensureFreshIndex(index, sessionsDirs, {
  force = false, onProgress = null, retryFailures = true,
} = {}) {
  const roots = Array.from(new Set(sessionsDirs.map((dir) => path.resolve(dir)))).sort();
  const key = sessionsKey(roots);
  while (index.refreshPromise) {
    if (index.refreshKey === key) return index.refreshPromise;
    // A different scope is serialized even if the preceding refresh failed.
    await index.refreshPromise.catch(() => {});
  }
  if (index.closing) throw new Error("Usage index is closing");
  syncPublishedRevision(index);
  if (!force && index.lastSync?.sessionsKey === key && Date.now() - index.checkedAt < index.scanCheckTtlMs) {
    return index.lastSync;
  }
  index.refreshKey = key;
  index.controller = new AbortController();
  index.activity = { state: "running", phase: "discover", startedAt: Date.now() };
  index.pendingFailures = [];
  index.refreshPromise = refreshUsageIndex(index, roots, {
    retryFailures, onProgress, signal: index.controller.signal,
  }).then((result) => {
    syncPublishedRevision(index);
    const sync = { ...cachedIndexStats(index, roots), ...result, publishedRevision: index.generation, indexRefreshSkipped: false };
    index.checkedAt = Date.now();
    index.lastSync = sync;
    Object.assign(index.activity, { state: result.failedFiles ? "partial" : "complete", phase: "idle", finishedAt: Date.now() });
    if (index.enableGc && typeof globalThis.gc === "function") globalThis.gc();
    return sync;
  }).catch((error) => {
    Object.assign(index.activity, { state: "failed", phase: "idle", error: error.message, finishedAt: Date.now() });
    throw error;
  }).finally(() => {
    index.refreshPromise = null;
    index.refreshKey = null;
    index.controller = null;
    index.pendingFailures = [];
  });
  return index.refreshPromise;
}

export function cachedIndexStats(index, sessionsDirs) {
  const fileSummary = fileStatsForSessions(index, sessionsDirs);
  const files = Number(fileSummary.files || 0);
  return {
    sessionsDirs,
    sessionsKey: sessionsKey(sessionsDirs),
    files,
    filesWithUsage: Number(fileSummary.filesWithUsage || 0),
    duplicateTokenEvents: Number(fileSummary.duplicateTokenEvents || 0),
    parseErrors: Number(fileSummary.parseErrors || 0),
    rawTokenEvents: Number(fileSummary.rawTokenEvents || 0),
    indexedEvents: Number(fileSummary.indexedEvents || 0),
    changedFiles: 0,
    deletedFiles: 0,
    cacheFiles: files,
    incrementalFiles: 0,
    fullRescanFiles: 0,
    scannedBytes: 0,
    decodedBytes: 0,
    failedFiles: getIndexStatus(index, sessionsDirs).failedFiles,
    scanDurationMs: 0,
    indexRefreshSkipped: true,
    indexPath: index.dbPath,
  };
}

export function prewarmCanonicalScope(index, sessionsDirs) {
  return ensureCanonicalScope(index.db, sessionsDirs);
}

export function usagePayloadFromIndex(index, syncStats, options) {
  const dedupeStats =
    options.dedupeScope === "global"
      ? ensureCanonicalScope(index.db, options.sessionsDirs)
      : {
          scopeId: null,
          canonicalEvents: 0,
          canonicalRebuilt: false,
          canonicalUpdatedKeys: 0,
          dedupeDurationMs: 0,
        };
  const aggregationStartedAt = performance.now();
  const costCacheHit = materializeCostedEvents(index, options, dedupeStats.scopeId, {
    force:
      Boolean(dedupeStats.canonicalRebuilt) ||
      Number(dedupeStats.canonicalUpdatedKeys || 0) > 0,
  });
  const totals = index.db
    .prepare(`
        SELECT
          COUNT(DISTINCT session_id) AS sessions,
          COUNT(*) AS requests,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
          COALESCE(SUM(cache_write_input_tokens), 0) AS cache_write_input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          ${COST_AGGREGATE_COLUMNS}
        FROM request_costed_events
    `)
    .get();

  const rows = groupedRowsFromIndex(index, options);
  rows.sort((a, b) => compareRows(a, b, options));
  const rowCount = rows.length;
  const limitedRows = options.limit > 0 ? rows.slice(0, options.limit) : rows;
  const globalDupes =
    options.dedupeScope === "global"
      ? Math.max(0, Number(syncStats.indexedEvents || 0) - dedupeStats.canonicalEvents)
      : 0;
  const assumedModels = assumedModelsFromIndex(index);
  const unpricedModels = unpricedModelsFromIndex(index);
  const aggregationDurationMs = Math.round(performance.now() - aggregationStartedAt);

  return {
      source: options.sessionsDirs,
      range: {
        from: options.fromMs == null ? null : new Date(options.fromMs).toISOString(),
        to: options.toMs == null ? null : new Date(options.toMs).toISOString(),
      },
      timezone: options.timezone,
      group: options.group,
      sort: options.sort,
      desc: options.desc,
      sourceScope: options.sourceScope || "all",
      dedupeScope: options.dedupeScope,
      totals: {
        sessions: Number(totals.sessions || 0),
        requests: Number(totals.requests || 0),
        ...withDerivedUsage(totals),
      },
      rows: limitedRows,
      rowCount,
      assumedModels,
      unpricedModels,
      stats: {
        files: syncStats.files,
        filesWithUsage: syncStats.filesWithUsage,
        duplicateTokenEvents: syncStats.duplicateTokenEvents,
        parseErrors: syncStats.parseErrors,
        rawTokenEvents: syncStats.rawTokenEvents,
        globalDuplicateTokenEvents: globalDupes,
        changedFiles: syncStats.changedFiles,
        deletedFiles: syncStats.deletedFiles,
        cacheFiles: syncStats.cacheFiles,
        incrementalFiles: syncStats.incrementalFiles || 0,
        fullRescanFiles: syncStats.fullRescanFiles || 0,
        scannedBytes: syncStats.scannedBytes || 0,
        decodedBytes: syncStats.decodedBytes || 0,
        failedFiles: syncStats.failedFiles || 0,
        scanDurationMs: syncStats.scanDurationMs,
        dedupeDurationMs: dedupeStats.dedupeDurationMs,
        aggregationDurationMs,
        indexRefreshSkipped: Boolean(syncStats.indexRefreshSkipped),
        queryCacheHit: false,
        costCacheHit,
        totalDurationMs:
          Number(syncStats.scanDurationMs || 0) +
          Number(dedupeStats.dedupeDurationMs || 0) +
          aggregationDurationMs,
        canonicalRebuilt: dedupeStats.canonicalRebuilt,
        canonicalUpdatedKeys: dedupeStats.canonicalUpdatedKeys,
        indexPath: syncStats.indexPath,
      },
      index: getIndexStatus(index, options.sessionsDirs),
      pricing: pricingMetadata(),
  };
}

function materializeCostedEvents(index, options, scopeId, { force = false } = {}) {
  const cacheKey = costSliceKey(index, options, scopeId);
  if (!force && index.costCacheKey === cacheKey && tempCostTableExists(index)) {
    return true;
  }
  index.db.exec("DROP TABLE IF EXISTS temp.request_costed_events");
  const filters = ["e.timestamp_ms IS NOT NULL"];
  const params = [];
  let source;
  if (options.dedupeScope === "global") {
    source = "canonical_events canonical INNER JOIN events e ON e.id = canonical.event_id";
    filters.push("canonical.scope_id = ?");
    params.push(scopeId);
  } else {
    source = "events e";
    const sourceFilter = sqlPathFilter("e.file_path", options.sessionsDirs);
    filters.push(sourceFilter.sql);
    params.push(...sourceFilter.params);
  }
  if (options.fromMs != null) {
    filters.push("e.timestamp_ms >= ?");
    params.push(options.fromMs);
  }
  if (options.toMs != null) {
    filters.push("e.timestamp_ms < ?");
    params.push(options.toMs);
  }

  index.db
    .prepare(`
      CREATE TEMP TABLE request_costed_events AS
      WITH priced AS MATERIALIZED (
        SELECT
          e.timestamp_ms,
          e.session_created_at_ms,
          e.session_id,
          e.cwd,
          e.model,
          e.input_tokens,
          e.cached_input_tokens,
          e.cache_write_input_tokens,
          e.output_tokens,
          e.reasoning_output_tokens,
          e.total_tokens,
          codex_cost_stats_json(
            e.timestamp_ms, e.model, e.input_tokens, e.cached_input_tokens,
            e.cache_write_input_tokens, e.output_tokens, e.total_tokens
          ) AS cost_json
        FROM ${source}
        WHERE ${filters.join(" AND ")}
      )
      SELECT
        timestamp_ms,
        session_created_at_ms,
        session_id,
        cwd,
        model,
        input_tokens,
        cached_input_tokens,
        cache_write_input_tokens,
        output_tokens,
        reasoning_output_tokens,
        total_tokens,
        json_extract(cost_json, '$.estimated_cost_usd') AS estimated_cost_usd,
        json_extract(cost_json, '$.assumed_cost_usd') AS assumed_cost_usd,
        json_extract(cost_json, '$.assumed_upper_bound_cost_usd') AS assumed_upper_bound_cost_usd,
        COALESCE(json_extract(cost_json, '$.provisional_priced_requests'), 0) AS provisional_priced_requests,
        COALESCE(json_extract(cost_json, '$.provisional_priced_total_tokens'), 0) AS provisional_priced_total_tokens,
        COALESCE(json_extract(cost_json, '$.provisional_estimated_cost_usd'), 0) AS provisional_estimated_cost_usd,
        json_extract(cost_json, '$.assumed_route_id') AS assumed_route_id,
        json_extract(cost_json, '$.assumed_model') AS assumed_model,
        json_extract(cost_json, '$.assumed_upper_bound_model') AS assumed_upper_bound_model,
        json_extract(cost_json, '$.assumed_label') AS assumed_label,
        json_extract(cost_json, '$.assumed_source_url') AS assumed_source_url,
        json_extract(cost_json, '$.assumed_evidence_level') AS assumed_evidence_level,
        json_extract(cost_json, '$.assumed_effective_from') AS assumed_effective_from
      FROM priced
    `)
    .run(...params);
  index.costCacheKey = cacheKey;
  return false;
}

function costSliceKey(index, options, scopeId) {
  const roots = Array.from(new Set(options.sessionsDirs.map((dir) => path.resolve(dir)))).sort();
  return JSON.stringify({
    roots,
    dedupeScope: options.dedupeScope,
    scopeId,
    fromMs: options.fromMs ?? null,
    toMs: options.toMs ?? null,
    generation: index.generation,
    pricingVersion: pricingCatalogVersion(),
  });
}

function tempCostTableExists(index) {
  return Boolean(
    index.db
      .prepare("SELECT 1 FROM sqlite_temp_master WHERE type = 'table' AND name = 'request_costed_events'")
      .get(),
  );
}

function groupedRowsFromIndex(index, options) {
  if (options.group === "none") {
    return [];
  }

  if (options.group === "day" || options.group === "month") {
    return index.db
      .prepare(`
        SELECT
          codex_date_key(timestamp_ms, ?, ?) AS key,
          COUNT(DISTINCT session_id) AS sessions,
          COUNT(*) AS requests,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
          COALESCE(SUM(cache_write_input_tokens), 0) AS cache_write_input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          ${COST_AGGREGATE_COLUMNS}
        FROM request_costed_events
        GROUP BY key
      `)
      .all(options.group, options.timezone)
      .map(rowFromSql);
  }

  if (options.group === "model" || options.group === "cwd") {
    const field = options.group === "model" ? "model" : "cwd";
    return index.db
      .prepare(`
        SELECT
          ${field} AS key,
          COUNT(DISTINCT session_id) AS sessions,
          COUNT(*) AS requests,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
          COALESCE(SUM(cache_write_input_tokens), 0) AS cache_write_input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          ${COST_AGGREGATE_COLUMNS}
        FROM request_costed_events
        GROUP BY key
      `)
      .all()
      .map(rowFromSql);
  }

  return index.db
    .prepare(`
      SELECT
        session_id,
        MIN(COALESCE(session_created_at_ms, timestamp_ms)) AS key_ms,
        COUNT(DISTINCT session_id) AS sessions,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(cache_write_input_tokens), 0) AS cache_write_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        ${COST_AGGREGATE_COLUMNS}
      FROM request_costed_events
      GROUP BY session_id
    `)
    .all()
    .map((row) =>
      rowFromSql({
        ...row,
        key: `${formatDateTime(Number(row.key_ms || 0), options.timezone)} ${row.session_id}`,
      }),
    );
}

function unpricedModelsFromIndex(index) {
  return index.db
    .prepare(`
      SELECT
        model,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        MIN(timestamp_ms) AS first_seen_ms,
        MAX(timestamp_ms) AS last_seen_ms
      FROM request_costed_events
      WHERE estimated_cost_usd IS NULL AND assumed_cost_usd IS NULL
      GROUP BY model
      ORDER BY total_tokens DESC, requests DESC, model ASC
      LIMIT 100
    `)
    .all()
    .map((row) => ({
      model: String(row.model || "(unknown model)"),
      requests: Number(row.requests || 0),
      input_tokens: Number(row.input_tokens || 0),
      output_tokens: Number(row.output_tokens || 0),
      total_tokens: Number(row.total_tokens || 0),
      first_seen: row.first_seen_ms == null ? null : new Date(Number(row.first_seen_ms)).toISOString(),
      last_seen: row.last_seen_ms == null ? null : new Date(Number(row.last_seen_ms)).toISOString(),
    }));
}

function assumedModelsFromIndex(index) {
  const rows = index.db
    .prepare(`
      SELECT
        model,
        assumed_route_id,
        assumed_model,
        assumed_upper_bound_model,
        assumed_label,
        assumed_source_url,
        assumed_evidence_level,
        assumed_effective_from,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(assumed_cost_usd), 0) AS assumed_cost_usd,
        COALESCE(SUM(assumed_upper_bound_cost_usd), 0) AS assumed_upper_bound_cost_usd,
        MIN(timestamp_ms) AS first_seen_ms,
        MAX(timestamp_ms) AS last_seen_ms
      FROM request_costed_events
      WHERE estimated_cost_usd IS NULL AND assumed_cost_usd IS NOT NULL
      GROUP BY
        model, assumed_route_id, assumed_model, assumed_upper_bound_model,
        assumed_label, assumed_source_url, assumed_evidence_level, assumed_effective_from
      ORDER BY model ASC, assumed_effective_from ASC
    `)
    .all();
  return assumedModelsFromAggregatedRows(rows).slice(0, 100);
}

function rowFromSql(row) {
  return {
    key: String(row.key ?? ""),
    sessions: Number(row.sessions || 0),
    requests: Number(row.requests || 0),
    ...withDerivedUsage(row),
  };
}

function withDerivedUsage(row) {
  const input = Number(row.input_tokens || 0);
  const cached = Number(row.cached_input_tokens || 0);
  const cacheWrite = Number(row.cache_write_input_tokens || 0);
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: Number(row.output_tokens || 0),
    reasoning_output_tokens: Number(row.reasoning_output_tokens || 0),
    total_tokens: Number(row.total_tokens || 0),
    uncached_input_tokens: Math.max(0, input - cached - cacheWrite),
    cache_hit_ratio: input > 0 ? cached / input : 0,
    estimated_cost_usd: Number(row.estimated_cost_usd || 0),
    assumed_cost_usd: Number(row.assumed_cost_usd || 0),
    assumed_upper_bound_cost_usd: Number(row.assumed_upper_bound_cost_usd || 0),
    reference_total_cost_usd:
      Number(row.estimated_cost_usd || 0) + Number(row.assumed_cost_usd || 0),
    reference_total_upper_bound_cost_usd:
      Number(row.estimated_cost_usd || 0) + Number(row.assumed_upper_bound_cost_usd || 0),
    priced_requests: Number(row.priced_requests || 0),
    assumed_requests: Number(row.assumed_requests || 0),
    unpriced_requests: Number(row.unpriced_requests || 0),
    priced_total_tokens: Number(row.priced_total_tokens || 0),
    assumed_total_tokens: Number(row.assumed_total_tokens || 0),
    unpriced_total_tokens: Number(row.unpriced_total_tokens || 0),
    provisional_priced_requests: Number(row.provisional_priced_requests || 0),
    provisional_priced_total_tokens: Number(row.provisional_priced_total_tokens || 0),
    provisional_estimated_cost_usd: Number(row.provisional_estimated_cost_usd || 0),
  };
}

function migrateUsageIndexSchema(db) {
  const eventColumns = new Set(db.prepare("PRAGMA table_info(events)").all().map((row) => row.name));
  const fileColumns = new Set(db.prepare("PRAGMA table_info(files)").all().map((row) => row.name));
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!eventColumns.has("cache_write_input_tokens")) {
      db.exec("ALTER TABLE events ADD COLUMN cache_write_input_tokens INTEGER NOT NULL DEFAULT 0");
    }
    if (!eventColumns.has("has_event_timestamp")) {
      // A stored timestamp alone cannot distinguish an event time from a
      // session fallback. Scanner version 6 recovers the source from JSONL.
      db.exec("ALTER TABLE events ADD COLUMN has_event_timestamp INTEGER NOT NULL DEFAULT 0");
    }
    addColumn(db, fileColumns, "scan_offset", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, fileColumns, "parser_state_json", "TEXT");
    addColumn(db, fileColumns, "scanner_version", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, fileColumns, "file_dev", "TEXT");
    addColumn(db, fileColumns, "file_ino", "TEXT");
    addColumn(db, fileColumns, "boundary_hash", "TEXT");
    db.exec(CANONICAL_SCHEMA_SQL);
    db.exec(`
      CREATE TABLE IF NOT EXISTS index_publication (
        id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL,
        published_at_ms INTEGER, has_snapshot INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO index_publication
        SELECT 1, 0, NULL, EXISTS(SELECT 1 FROM files);
      CREATE TABLE IF NOT EXISTS scan_failures (
        path TEXT PRIMARY KEY, signature TEXT, error_code TEXT NOT NULL,
        message TEXT NOT NULL, attempted_at_ms INTEGER NOT NULL, retained_paths_json TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_canonical_source_time_order
        ON events(total_usage_key, has_event_timestamp DESC, timestamp_ms IS NULL, timestamp_ms, file_path COLLATE BINARY, event_index);
      DROP INDEX IF EXISTS idx_events_canonical_time_order;
      DROP INDEX IF EXISTS idx_events_total_order;
    `);
    db.exec(`PRAGMA user_version = ${USAGE_INDEX_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function addColumn(db, columns, name, definition) {
  if (columns.has(name)) return;
  db.exec(`ALTER TABLE files ADD COLUMN ${name} ${definition}`);
  columns.add(name);
}

function usageFromSql(inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, totalTokens) {
  return {
    input_tokens: Number(inputTokens || 0),
    cached_input_tokens: Number(cachedInputTokens || 0),
    cache_write_input_tokens: Number(cacheWriteInputTokens || 0),
    output_tokens: Number(outputTokens || 0),
    total_tokens: Number(totalTokens || 0),
  };
}

function sortValue(row, sort) {
  if (sort === "key") return row.key;
  if (sort === "total") return row.total_tokens;
  if (sort === "input") return row.input_tokens;
  if (sort === "output") return row.output_tokens;
  if (sort === "cached") return row.cached_input_tokens;
  if (sort === "reasoning") return row.reasoning_output_tokens;
  if (sort === "requests") return row.requests;
  if (sort === "sessions") return row.sessions;
  if (sort === "cost") return row.reference_total_cost_usd;
  return row.key;
}

function compareRows(a, b, options) {
  const left = sortValue(a, options.sort);
  const right = sortValue(b, options.sort);
  let result;
  if (typeof left === "number" && typeof right === "number") {
    result = left - right;
  } else {
    result = String(left).localeCompare(String(right));
  }
  if (result === 0 && options.sort !== "key") {
    result = String(a.key).localeCompare(String(b.key));
  }
  return options.desc ? -result : result;
}

function fileStatsForSessions(index, sessionsDirs) {
  const filter = sqlPathFilter("path", sessionsDirs);
  return index.db
    .prepare(`
      SELECT
        COUNT(*) AS files,
        COALESCE(SUM(CASE WHEN events_count > 0 THEN 1 ELSE 0 END), 0) AS filesWithUsage,
        COALESCE(SUM(duplicate_token_events), 0) AS duplicateTokenEvents,
        COALESCE(SUM(parse_errors), 0) AS parseErrors,
        COALESCE(SUM(raw_token_events), 0) AS rawTokenEvents,
        COALESCE(SUM(events_count), 0) AS indexedEvents
      FROM files
      WHERE ${filter.sql}
    `)
    .get(...filter.params);
}

function sessionsKey(sessionsDirs) {
  return sessionsDirs.join("\n");
}
