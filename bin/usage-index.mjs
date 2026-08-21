import { createHash } from "node:crypto";
import { mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  findJsonlFiles,
  formatDateKey,
  formatDateTime,
} from "./codex-token-usage.mjs";
import {
  costStatsForUsage,
  pricingCatalogVersion,
  pricingMetadata,
} from "./openai-pricing.mjs";
import { sqlPathFilter } from "./path-utils.mjs";
import { scanSessionFileRange, SESSION_SCANNER_VERSION } from "./session-scanner.mjs";
import { assumedModelsFromAggregatedRows } from "./usage-costs.mjs";
import {
  CANONICAL_SCHEMA_SQL,
  ensureCanonicalScope,
  markCanonicalChange,
} from "./usage-canonical.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

export const DEFAULT_DB_PATH = path.join(ROOT, ".codex-usage", "cache.sqlite");
export const DEFAULT_SCAN_CHECK_TTL_MS = 1000;
export const DEFAULT_SCAN_CONCURRENCY = 8;
const USAGE_INDEX_SCHEMA_VERSION = 3;
const BOUNDARY_HASH_BYTES = 64 * 1024;

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
      CREATE INDEX IF NOT EXISTS idx_events_total_order ON events(total_usage_key, file_path, event_index);
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
    checkedAt: 0,
    lastSync: null,
    refreshPromise: null,
    refreshKey: null,
    generation: 0,
    costCacheKey: null,
    statements: {
      allFiles: db.prepare("SELECT * FROM files"),
      deleteEvents: db.prepare("DELETE FROM events WHERE file_path = ?"),
      deleteFile: db.prepare("DELETE FROM files WHERE path = ?"),
      fileKeys: db.prepare("SELECT total_usage_key FROM events WHERE file_path = ?"),
      insertFile: db.prepare(`
        INSERT INTO files (
          path, size, mtime_ms, events_count, duplicate_token_events, parse_errors, raw_token_events,
          scanned_at_ms, scan_offset, parser_state_json, scanner_version, file_dev, file_ino, boundary_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateFile: db.prepare(`
        UPDATE files
        SET size = ?,
            mtime_ms = ?,
            events_count = ?,
            duplicate_token_events = ?,
            parse_errors = ?,
            raw_token_events = ?,
            scanned_at_ms = ?,
            scan_offset = ?,
            parser_state_json = ?,
            scanner_version = ?,
            file_dev = ?,
            file_ino = ?,
            boundary_hash = ?
        WHERE path = ?
      `),
      insertEvent: db.prepare(`
        INSERT INTO events (
          file_path, event_index, timestamp_ms, session_created_at_ms, session_id, total_usage_key, cwd, model,
          input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
    },
  };
}

export function closeUsageIndex(index) {
  index?.db?.close?.();
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

export async function ensureFreshIndex(index, sessionsDirs, { force = false } = {}) {
  const now = Date.now();
  const key = sessionsKey(sessionsDirs);
  if (!force && index.lastSync?.sessionsKey === key && now - index.checkedAt < index.scanCheckTtlMs) {
    return index.lastSync;
  }
  if (index.refreshPromise) {
    if (index.refreshKey === key) {
      return index.refreshPromise;
    }
    await index.refreshPromise;
    if (
      !force &&
      index.lastSync?.sessionsKey === key &&
      Date.now() - index.checkedAt < index.scanCheckTtlMs
    ) {
      return index.lastSync;
    }
  }

  index.refreshKey = key;
  index.refreshPromise = refreshIndex(index, sessionsDirs, key).finally(() => {
    index.refreshPromise = null;
    index.refreshKey = null;
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

async function refreshIndex(index, sessionsDirs, key) {
  const startedAt = Date.now();
  const filePaths = await collectJsonlFiles(sessionsDirs);
  const currentPaths = new Set(filePaths);
  const knownFiles = new Map(index.statements.allFiles.all().map((row) => [row.path, row]));

  let deletedFiles = 0;
  for (const filePath of knownFiles.keys()) {
    if (filePathInSessions(filePath, sessionsDirs) && !currentPaths.has(filePath)) {
      deleteIndexedFile(index, filePath);
      deletedFiles += 1;
      knownFiles.delete(filePath);
    }
  }

  const fileStats = await mapLimit(filePaths, 32, async (filePath) => {
    const fileStat = await stat(filePath);
    return {
      filePath,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      dev: String(fileStat.dev),
      ino: String(fileStat.ino),
    };
  });

  let changedFiles = 0;
  let incrementalFiles = 0;
  let fullRescanFiles = 0;
  let scannedBytes = 0;
  await mapLimit(fileStats, index.scanConcurrency, async (fileInfo) => {
    const cached = knownFiles.get(fileInfo.filePath);
    if (isUnchangedFile(cached, fileInfo)) {
      return;
    }

    const result = await scanChangedFile(index, fileInfo, cached);
    if (result.mode === "incremental") {
      appendScannedFile(index, fileInfo, cached, result);
      incrementalFiles += 1;
    } else {
      replaceScannedFile(index, fileInfo, result);
      fullRescanFiles += 1;
    }
    scannedBytes += result.scanned.scannedBytes;
    changedFiles += 1;
  });

  if (changedFiles > 0 || deletedFiles > 0) {
    invalidateUsageCaches(index, { bumpGeneration: true });
  }

  const fileSummary = fileStatsForSessions(index, sessionsDirs);
  const sync = {
    sessionsDirs,
    sessionsKey: key,
    files: Number(fileSummary.files || 0),
    filesWithUsage: Number(fileSummary.filesWithUsage || 0),
    duplicateTokenEvents: Number(fileSummary.duplicateTokenEvents || 0),
    parseErrors: Number(fileSummary.parseErrors || 0),
    rawTokenEvents: Number(fileSummary.rawTokenEvents || 0),
    indexedEvents: Number(fileSummary.indexedEvents || 0),
    changedFiles,
    deletedFiles,
    cacheFiles: Math.max(0, fileStats.length - changedFiles),
    incrementalFiles,
    fullRescanFiles,
    scannedBytes,
    scanDurationMs: Date.now() - startedAt,
    indexRefreshSkipped: false,
    indexPath: index.dbPath,
  };
  index.checkedAt = Date.now();
  index.lastSync = sync;
  maybeCollectGarbage(index);
  return sync;
}

function isUnchangedFile(cached, fileInfo) {
  if (
    !cached ||
    Number(cached.scanner_version) !== SESSION_SCANNER_VERSION ||
    Number(cached.size) !== fileInfo.size ||
    Math.abs(Number(cached.mtime_ms) - fileInfo.mtimeMs) >= 0.001
  ) {
    return false;
  }

  return (
    String(cached.file_dev || "") === fileInfo.dev &&
    String(cached.file_ino || "") === fileInfo.ino
  );
}

async function scanChangedFile(index, fileInfo, cached) {
  const savedState = parseScannerState(cached);
  if (await canScanIncrementally(fileInfo, cached, savedState)) {
    const seenTotals = new Set(
      index.statements.fileKeys.all(fileInfo.filePath).map((row) => row.total_usage_key),
    );
    const scanned = await scanSessionFileRange(fileInfo.filePath, {
      startOffset: Number(cached.scan_offset || 0),
      endOffset: fileInfo.size,
      state: savedState,
      seenTotals,
    });
    return {
      mode: "incremental",
      scanned,
      boundaryHash: await boundaryHash(fileInfo.filePath, scanned.processedOffset),
    };
  }

  const scanned = await scanSessionFileRange(fileInfo.filePath, { endOffset: fileInfo.size });
  return {
    mode: "full",
    scanned,
    boundaryHash: await boundaryHash(fileInfo.filePath, scanned.processedOffset),
  };
}

async function canScanIncrementally(fileInfo, cached, savedState) {
  if (
    !cached ||
    fileInfo.size <= Number(cached.size) ||
    Number(cached.scanner_version) !== SESSION_SCANNER_VERSION ||
    !savedState ||
    String(cached.file_dev || "") !== fileInfo.dev ||
    String(cached.file_ino || "") !== fileInfo.ino
  ) {
    return false;
  }
  const scanOffset = Number(cached.scan_offset);
  if (!Number.isSafeInteger(scanOffset) || scanOffset < 0 || scanOffset > Number(cached.size)) {
    return false;
  }
  return (await boundaryHash(fileInfo.filePath, scanOffset)) === String(cached.boundary_hash || "");
}

function parseScannerState(cached) {
  if (!cached?.parser_state_json) return null;
  try {
    const state = JSON.parse(cached.parser_state_json);
    return Number(state.scannerVersion) === SESSION_SCANNER_VERSION ? state : null;
  } catch {
    return null;
  }
}

async function boundaryHash(filePath, offset) {
  const end = Math.max(0, Number(offset || 0));
  const length = Math.min(BOUNDARY_HASH_BYTES, end);
  const hash = createHash("sha256");
  if (length === 0) return hash.digest("hex");

  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, end - length);
    hash.update(buffer.subarray(0, bytesRead));
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function deleteIndexedFile(index, filePath) {
  const oldKeys = index.statements.fileKeys.all(filePath).map((row) => row.total_usage_key);
  index.db.exec("BEGIN IMMEDIATE");
  try {
    markCanonicalChange(index.db, filePath, oldKeys);
    index.statements.deleteEvents.run(filePath);
    index.statements.deleteFile.run(filePath);
    index.db.exec("COMMIT");
  } catch (error) {
    index.db.exec("ROLLBACK");
    throw error;
  }
}

function replaceScannedFile(index, fileInfo, result) {
  const { scanned, boundaryHash: hash } = result;
  const oldKeys = index.statements.fileKeys.all(fileInfo.filePath).map((row) => row.total_usage_key);
  const changedKeys = [...oldKeys, ...scanned.events.map((event) => event.totalUsageKey)];
  index.db.exec("BEGIN IMMEDIATE");
  try {
    markCanonicalChange(index.db, fileInfo.filePath, changedKeys);
    index.statements.deleteEvents.run(fileInfo.filePath);
    index.statements.deleteFile.run(fileInfo.filePath);
    index.statements.insertFile.run(
      fileInfo.filePath,
      fileInfo.size,
      fileInfo.mtimeMs,
      scanned.events.length,
      scanned.stats.duplicateTokenEvents,
      scanned.stats.parseErrors,
      scanned.stats.tokenEvents,
      Date.now(),
      scanned.processedOffset,
      JSON.stringify(scanned.state),
      SESSION_SCANNER_VERSION,
      fileInfo.dev,
      fileInfo.ino,
      hash,
    );
    insertEvents(index, fileInfo.filePath, scanned.events, 0);
    index.db.exec("COMMIT");
  } catch (error) {
    index.db.exec("ROLLBACK");
    throw error;
  }
}

function appendScannedFile(index, fileInfo, cached, result) {
  const { scanned, boundaryHash: hash } = result;
  const eventCount = Number(cached.events_count || 0);
  index.db.exec("BEGIN IMMEDIATE");
  try {
    markCanonicalChange(
      index.db,
      fileInfo.filePath,
      scanned.events.map((event) => event.totalUsageKey),
    );
    insertEvents(index, fileInfo.filePath, scanned.events, eventCount);
    index.statements.updateFile.run(
      fileInfo.size,
      fileInfo.mtimeMs,
      eventCount + scanned.events.length,
      Number(cached.duplicate_token_events || 0) + scanned.stats.duplicateTokenEvents,
      Number(cached.parse_errors || 0) + scanned.stats.parseErrors,
      Number(cached.raw_token_events || 0) + scanned.stats.tokenEvents,
      Date.now(),
      scanned.processedOffset,
      JSON.stringify(scanned.state),
      SESSION_SCANNER_VERSION,
      fileInfo.dev,
      fileInfo.ino,
      hash,
      fileInfo.filePath,
    );
    index.db.exec("COMMIT");
  } catch (error) {
    index.db.exec("ROLLBACK");
    throw error;
  }
}

function insertEvents(index, filePath, events, startIndex) {
  events.forEach((event, relativeIndex) => {
    const usage = event.usage || {};
    index.statements.insertEvent.run(
      filePath,
      startIndex + relativeIndex,
      event.timestampMs ?? null,
      event.sessionCreatedAtMs ?? null,
      event.sessionId || "",
      event.totalUsageKey || "",
      event.cwd || "(unknown cwd)",
      event.model || "(unknown model)",
      usage.input_tokens || 0,
      usage.cached_input_tokens || 0,
      usage.cache_write_input_tokens || 0,
      usage.output_tokens || 0,
      usage.reasoning_output_tokens || 0,
      usage.total_tokens || 0,
    );
  });
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
    addColumn(db, fileColumns, "scan_offset", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, fileColumns, "parser_state_json", "TEXT");
    addColumn(db, fileColumns, "scanner_version", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, fileColumns, "file_dev", "TEXT");
    addColumn(db, fileColumns, "file_ino", "TEXT");
    addColumn(db, fileColumns, "boundary_hash", "TEXT");
    db.exec(CANONICAL_SCHEMA_SQL);
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

async function collectJsonlFiles(sessionsDirs) {
  const files = [];
  for (const sessionsDir of sessionsDirs) {
    const dirFiles = await findJsonlFiles(sessionsDir);
    files.push(...dirFiles);
  }
  return files;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function sessionsKey(sessionsDirs) {
  return sessionsDirs.join("\n");
}

function filePathInSessions(filePath, sessionsDirs) {
  const resolved = path.resolve(filePath);
  return sessionsDirs.some((dir) => resolved === dir || resolved.startsWith(`${dir}${path.sep}`));
}

function maybeCollectGarbage(index) {
  if (index.enableGc && typeof globalThis.gc === "function") {
    globalThis.gc();
  }
}
