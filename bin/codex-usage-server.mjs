#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_WINDOWS_SESSIONS_DIR,
  defaultWindowsSessionDirs,
  findJsonlFiles,
  formatDateKey,
  formatDateTime,
  parseArgs,
  scanSessionFile,
} from "./codex-token-usage.mjs";
import {
  costStatsForUsage,
  initializePricing,
  pricingMetadata,
  refreshPricing,
} from "./openai-pricing.mjs";
import { assumedModelsFromAggregatedRows } from "./usage-costs.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DEFAULT_DB_PATH = path.join(ROOT, ".codex-usage", "cache.sqlite");

const PORT = Number(process.env.PORT || process.env.CODEX_USAGE_PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const SCAN_CHECK_TTL_MS = Number(process.env.CODEX_USAGE_SCAN_CHECK_TTL_MS || 1000);
const SCAN_CONCURRENCY = Math.max(1, Math.min(32, Number(process.env.CODEX_USAGE_SCAN_CONCURRENCY || 8)));
const DB_PATH = path.resolve(process.env.CODEX_USAGE_DB || DEFAULT_DB_PATH);
const ENABLE_GC = process.env.CODEX_USAGE_GC !== "0";

const GROUPS = new Set(["none", "day", "month", "model", "cwd", "session"]);
const SORTS = new Set(["key", "total", "input", "output", "cached", "reasoning", "requests", "sessions", "cost"]);
const DEDUPE_SCOPES = new Set(["global", "file"]);
const SOURCE_SCOPES = new Set(["all", "local", "windows"]);
const RANGE_TO_LAST = new Map([
  ["24h", "24h"],
  ["7d", "7d"],
  ["30d", "30d"],
  ["12w", "12w"],
]);

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

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
]);

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function localSessionsDir() {
  return path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions");
}

function sourceScopeFromQuery(searchParams) {
  const value = searchParams.get("sourceScope") || "all";
  return SOURCE_SCOPES.has(value) ? value : "all";
}

function addWindowsSessionArgs(args) {
  const dirs = defaultWindowsSessionDirs();
  if (dirs.length === 0) {
    args.push("--sessions", DEFAULT_WINDOWS_SESSIONS_DIR);
    return;
  }
  for (const dir of dirs) {
    args.push("--sessions", dir);
  }
}

function usageArgvFromQuery(searchParams) {
  const group = searchParams.get("group") || "month";
  const sort = searchParams.get("sort") || (group === "day" || group === "month" ? "key" : "total");
  const dedupeScope = searchParams.get("dedupeScope") || "global";
  const range = searchParams.get("range") || "all";
  const sourceScope = sourceScopeFromQuery(searchParams);
  const args = ["--group", GROUPS.has(group) ? group : "month", "--sort", SORTS.has(sort) ? sort : "total"];

  if (sourceScope === "local") {
    args.push("--sessions", localSessionsDir());
  } else if (sourceScope === "windows") {
    addWindowsSessionArgs(args);
  }

  const limit = clampInt(searchParams.get("limit"), group === "cwd" || group === "session" ? 30 : 0, 0, 500);
  if (limit > 0) {
    args.push("--limit", String(limit));
  }

  if (DEDUPE_SCOPES.has(dedupeScope)) {
    args.push("--dedupe-scope", dedupeScope);
  }

  if (searchParams.get("desc") === "1" || searchParams.get("desc") === "true") {
    args.push("--desc");
  } else if (searchParams.get("asc") === "1" || searchParams.get("asc") === "true") {
    args.push("--asc");
  }

  if (range === "today") {
    args.push("--today");
  } else if (RANGE_TO_LAST.has(range)) {
    args.push("--last", RANGE_TO_LAST.get(range));
  } else if (range === "custom") {
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    if (from) args.push("--from", from);
    if (to) args.push("--to", to);
  }

  return args;
}

function optionsFromQuery(searchParams) {
  const options = parseArgs(usageArgvFromQuery(searchParams));
  options.sourceScope = sourceScopeFromQuery(searchParams);
  return options;
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

function maybeCollectGarbage() {
  if (ENABLE_GC && typeof globalThis.gc === "function") {
    globalThis.gc();
  }
}

async function openUsageIndex() {
  await mkdir(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
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
      scanned_at_ms INTEGER NOT NULL
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
      cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
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
  migratePricingColumns(db);
  db.function("codex_date_key", (timestampMs, group, timezone) => {
    if (timestampMs == null) return null;
    return formatDateKey(Number(timestampMs), String(group), String(timezone));
  });
  db.function(
    "codex_cost_stats_json",
    (timestampMs, model, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, totalTokens) => {
      const stats = costStatsForUsage(
        String(model || ""),
        {
          input_tokens: Number(inputTokens || 0),
          cached_input_tokens: Number(cachedInputTokens || 0),
          cache_write_input_tokens: Number(cacheWriteInputTokens || 0),
          output_tokens: Number(outputTokens || 0),
          total_tokens: Number(totalTokens || 0),
        },
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
    checkedAt: 0,
    lastSync: null,
    refreshPromise: null,
    refreshKey: null,
    statements: {
      allFiles: db.prepare("SELECT path, size, mtime_ms FROM files"),
      deleteEvents: db.prepare("DELETE FROM events WHERE file_path = ?"),
      deleteFile: db.prepare("DELETE FROM files WHERE path = ?"),
      insertFile: db.prepare(`
        INSERT INTO files (
          path, size, mtime_ms, events_count, duplicate_token_events, parse_errors, raw_token_events, scanned_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertEvent: db.prepare(`
        INSERT INTO events (
          file_path, event_index, timestamp_ms, session_created_at_ms, session_id, total_usage_key, cwd, model,
          input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      fileStats: db.prepare(`
        SELECT
          COUNT(*) AS files,
          COALESCE(SUM(CASE WHEN events_count > 0 THEN 1 ELSE 0 END), 0) AS filesWithUsage,
          COALESCE(SUM(duplicate_token_events), 0) AS duplicateTokenEvents,
          COALESCE(SUM(parse_errors), 0) AS parseErrors,
          COALESCE(SUM(raw_token_events), 0) AS rawTokenEvents
        FROM files
      `),
      globalDupes: db.prepare(`
        SELECT COUNT(*) - COUNT(DISTINCT total_usage_key) AS globalDuplicateTokenEvents
        FROM events
      `),
    },
  };
}

function migratePricingColumns(db) {
  const eventColumns = new Set(db.prepare("PRAGMA table_info(events)").all().map((row) => row.name));
  if (eventColumns.has("cache_write_input_tokens")) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE events ADD COLUMN cache_write_input_tokens INTEGER NOT NULL DEFAULT 0");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw new Error(`Failed to migrate pricing columns in ${DB_PATH}: ${error.message}`, {
      cause: error,
    });
  }
}

function sessionsKey(sessionsDirs) {
  return sessionsDirs.join("\n");
}

function filePathInSessions(filePath, sessionsDirs) {
  const resolved = path.resolve(filePath);
  return sessionsDirs.some((dir) => resolved === dir || resolved.startsWith(`${dir}${path.sep}`));
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}

function filePathFilter(column, sessionsDirs) {
  const parts = [];
  const params = [];
  for (const sessionsDir of sessionsDirs) {
    parts.push(`(${column} = ? OR ${column} LIKE ? ESCAPE '\\')`);
    params.push(sessionsDir, `${escapeLike(sessionsDir)}${path.sep}%`);
  }
  return {
    sql: parts.length ? `(${parts.join(" OR ")})` : "1 = 0",
    params,
  };
}

function fileStatsForSessions(index, sessionsDirs) {
  const filter = filePathFilter("path", sessionsDirs);
  return index.db
    .prepare(`
      SELECT
        COUNT(*) AS files,
        COALESCE(SUM(CASE WHEN events_count > 0 THEN 1 ELSE 0 END), 0) AS filesWithUsage,
        COALESCE(SUM(duplicate_token_events), 0) AS duplicateTokenEvents,
        COALESCE(SUM(parse_errors), 0) AS parseErrors,
        COALESCE(SUM(raw_token_events), 0) AS rawTokenEvents
      FROM files
      WHERE ${filter.sql}
    `)
    .get(...filter.params);
}

function globalDupesForSessions(index, sessionsDirs) {
  const filter = filePathFilter("file_path", sessionsDirs);
  const row = index.db
    .prepare(`
      SELECT COUNT(*) - COUNT(DISTINCT total_usage_key) AS globalDuplicateTokenEvents
      FROM events
      WHERE ${filter.sql}
    `)
    .get(...filter.params);
  return Number(row.globalDuplicateTokenEvents || 0);
}

function modelsInUsageIndex(index) {
  return index.db
    .prepare("SELECT DISTINCT model FROM events WHERE model NOT IN ('', '(unknown model)') ORDER BY model")
    .all()
    .map((row) => String(row.model));
}

async function collectJsonlFiles(sessionsDirs) {
  const files = [];
  for (const sessionsDir of sessionsDirs) {
    const dirFiles = await findJsonlFiles(sessionsDir);
    files.push(...dirFiles);
  }
  return files;
}

async function ensureFreshIndex(index, sessionsDirs) {
  const now = Date.now();
  const key = sessionsKey(sessionsDirs);
  if (index.lastSync?.sessionsKey === key && now - index.checkedAt < SCAN_CHECK_TTL_MS) {
    return index.lastSync;
  }
  if (index.refreshPromise) {
    if (index.refreshKey === key) {
      return index.refreshPromise;
    }
    await index.refreshPromise;
    if (index.lastSync?.sessionsKey === key && Date.now() - index.checkedAt < SCAN_CHECK_TTL_MS) {
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

async function refreshIndex(index, sessionsDirs, key) {
  const startedAt = Date.now();
  const filePaths = await collectJsonlFiles(sessionsDirs);
  const currentPaths = new Set(filePaths);
  const knownFiles = new Map(index.statements.allFiles.all().map((row) => [row.path, row]));

  let deletedFiles = 0;
  for (const filePath of knownFiles.keys()) {
    if (filePathInSessions(filePath, sessionsDirs) && !currentPaths.has(filePath)) {
      index.db.exec("BEGIN IMMEDIATE");
      try {
        index.statements.deleteEvents.run(filePath);
        index.statements.deleteFile.run(filePath);
        index.db.exec("COMMIT");
      } catch (error) {
        index.db.exec("ROLLBACK");
        throw error;
      }
      deletedFiles += 1;
      knownFiles.delete(filePath);
    }
  }

  const fileStats = await mapLimit(filePaths, 32, async (filePath) => {
    const fileStat = await stat(filePath);
    return { filePath, size: fileStat.size, mtimeMs: fileStat.mtimeMs };
  });

  let changedFiles = 0;
  await mapLimit(fileStats, SCAN_CONCURRENCY, async (fileInfo) => {
    const cached = knownFiles.get(fileInfo.filePath);
    if (cached && cached.size === fileInfo.size && Math.abs(cached.mtime_ms - fileInfo.mtimeMs) < 0.001) {
      return;
    }

    const scanned = await scanSessionFile(fileInfo.filePath);
    writeScannedFile(index, fileInfo, scanned);
    changedFiles += 1;
  });

  const fileSummary = fileStatsForSessions(index, sessionsDirs);
  const sync = {
    sessionsDirs,
    sessionsKey: key,
    files: Number(fileSummary.files || 0),
    filesWithUsage: Number(fileSummary.filesWithUsage || 0),
    duplicateTokenEvents: Number(fileSummary.duplicateTokenEvents || 0),
    parseErrors: Number(fileSummary.parseErrors || 0),
    rawTokenEvents: Number(fileSummary.rawTokenEvents || 0),
    changedFiles,
    deletedFiles,
    cacheFiles: Math.max(0, fileStats.length - changedFiles),
    scanDurationMs: Date.now() - startedAt,
    indexPath: DB_PATH,
  };
  index.checkedAt = Date.now();
  index.lastSync = sync;
  maybeCollectGarbage();
  return sync;
}

function writeScannedFile(index, fileInfo, scanned) {
  index.db.exec("BEGIN IMMEDIATE");
  try {
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
    );

    scanned.events.forEach((event, eventIndex) => {
      const usage = event.usage || {};
      index.statements.insertEvent.run(
        fileInfo.filePath,
        eventIndex,
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

    index.db.exec("COMMIT");
  } catch (error) {
    index.db.exec("ROLLBACK");
    throw error;
  }
}

function sourceCte(options) {
  const filters = ["timestamp_ms IS NOT NULL"];
  const params = [];
  const sourceFilter = filePathFilter("file_path", options.sessionsDirs);
  if (options.fromMs != null) {
    filters.push("timestamp_ms >= ?");
    params.push(options.fromMs);
  }
  if (options.toMs != null) {
    filters.push("timestamp_ms < ?");
    params.push(options.toMs);
  }

  const source =
    options.dedupeScope === "global"
      ? `
        ranked AS (
          SELECT
            e.*,
            ROW_NUMBER() OVER (
              PARTITION BY total_usage_key
              ORDER BY file_path, event_index
            ) AS rn
          FROM events e
          WHERE ${sourceFilter.sql}
        ),
        source AS (
          SELECT * FROM ranked WHERE rn = 1
        )`
      : `
        source AS (
          SELECT * FROM events WHERE ${sourceFilter.sql}
        )`;

  return {
    sql: `WITH ${source}, filtered AS (SELECT * FROM source WHERE ${filters.join(" AND ")})`,
    params: [...sourceFilter.params, ...params],
  };
}

function usagePayloadFromIndex(index, syncStats, options) {
  try {
    materializeCostedEvents(index, options);
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
        ? globalDupesForSessions(index, options.sessionsDirs)
        : 0;

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
      assumedModels: assumedModelsFromIndex(index),
      unpricedModels: unpricedModelsFromIndex(index),
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
        scanDurationMs: syncStats.scanDurationMs,
        indexPath: syncStats.indexPath,
      },
      pricing: pricingMetadata(),
    };
  } finally {
    index.db.exec("DROP TABLE IF EXISTS temp.request_costed_events");
  }
}

function materializeCostedEvents(index, options) {
  index.db.exec("DROP TABLE IF EXISTS temp.request_costed_events");
  const { sql: cte, params } = sourceCte(options);
  index.db
    .prepare(`
      CREATE TEMP TABLE request_costed_events AS
      ${cte},
      priced AS MATERIALIZED (
        SELECT
          filtered.*,
          codex_cost_stats_json(
            timestamp_ms, model, input_tokens, cached_input_tokens,
            cache_write_input_tokens, output_tokens, total_tokens
          ) AS cost_json
        FROM filtered
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

async function runUsage(index, searchParams) {
  const options = optionsFromQuery(searchParams);
  const syncStats = await ensureFreshIndex(index, options.sessionsDirs);
  const payload = usagePayloadFromIndex(index, syncStats, options);
  maybeCollectGarbage();
  return payload;
}

async function serveStatic(req, res, pathname) {
  const safePathname = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    json(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    res.writeHead(200, {
      "content-type": MIME_TYPES.get(path.extname(filePath)) || "application/octet-stream",
      "cache-control": "no-cache",
    });
    createReadStream(filePath).pipe(res);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

const usageIndex = await openUsageIndex();
await initializePricing({ dbPath: DB_PATH });
const pricingRefresh = await refreshPricing({
  models: modelsInUsageIndex(usageIndex),
  dbPath: DB_PATH,
});
if (pricingRefresh.warning) {
  console.warn(`codex-usage-server: ${pricingRefresh.warning}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
  try {
    if (url.pathname === "/api/usage") {
      const payload = await runUsage(usageIndex, url.searchParams);
      json(res, 200, payload);
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Codex usage dashboard: http://${HOST}:${PORT}`);
  console.log(`SQLite index: ${DB_PATH}`);
});
