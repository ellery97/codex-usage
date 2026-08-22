import { sqlPathFilter } from "./path-utils.mjs";
import { ensureCanonicalScope } from "./usage-canonical.mjs";
import { usagePayloadFromIndex as baseUsagePayloadFromIndex } from "./usage-index.mjs";
import { aggregateUsageEvents } from "./usage-aggregation.mjs";

export function usagePayloadFromIndex(index, syncStats, options) {
  const startedAt = performance.now();
  const payload = baseUsagePayloadFromIndex(index, syncStats, options);
  const source = selectedSource(index, options);
  const unknown = unknownTimestampStats(index, source);
  const boundedRange = options.fromMs != null || options.toMs != null;

  payload.stats.unknownTimestampEvents = unknown.requests;
  payload.stats.unknownTimestampTokens = unknown.totalTokens;
  payload.stats.excludedUnknownTimestampEvents = boundedRange ? unknown.requests : 0;
  payload.stats.excludedUnknownTimestampTokens = boundedRange ? unknown.totalTokens : 0;

  if (boundedRange || unknown.requests === 0) {
    return payload;
  }

  const result = aggregateUsageEvents(selectedEvents(index, source), options);
  payload.totals = result.totals;
  payload.rows = result.rows;
  payload.rowCount = result.rowCount;
  payload.assumedModels = result.assumedModels;
  payload.unpricedModels = result.unpricedModels;
  payload.stats.costCacheHit = false;
  payload.stats.aggregationDurationMs += Math.round(performance.now() - startedAt);
  return payload;
}

function selectedSource(index, options) {
  if (options.dedupeScope === "global") {
    const { scopeId } = ensureCanonicalScope(index.db, options.sessionsDirs);
    return {
      from: "canonical_events canonical INNER JOIN events e ON e.id = canonical.event_id",
      filters: ["canonical.scope_id = ?"],
      params: [scopeId],
    };
  }

  const filter = sqlPathFilter("e.file_path", options.sessionsDirs);
  return {
    from: "events e",
    filters: [filter.sql],
    params: [...filter.params],
  };
}

function unknownTimestampStats(index, source) {
  const row = index.db
    .prepare(`
      SELECT
        COUNT(*) AS requests,
        COALESCE(SUM(e.total_tokens), 0) AS total_tokens
      FROM ${source.from}
      WHERE ${[...source.filters, "e.timestamp_ms IS NULL"].join(" AND ")}
    `)
    .get(...source.params);
  return {
    requests: Number(row?.requests || 0),
    totalTokens: Number(row?.total_tokens || 0),
  };
}

function selectedEvents(index, source) {
  return index.db
    .prepare(`
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
        e.total_tokens
      FROM ${source.from}
      WHERE ${source.filters.join(" AND ")}
      ORDER BY e.file_path COLLATE BINARY, e.event_index
    `)
    .all(...source.params)
    .map((row) => ({
      timestampMs: row.timestamp_ms == null ? null : Number(row.timestamp_ms),
      sessionCreatedAtMs:
        row.session_created_at_ms == null ? null : Number(row.session_created_at_ms),
      sessionId: String(row.session_id || ""),
      cwd: String(row.cwd || "(unknown cwd)"),
      model: String(row.model || "(unknown model)"),
      usage: {
        input_tokens: Number(row.input_tokens || 0),
        cached_input_tokens: Number(row.cached_input_tokens || 0),
        cache_write_input_tokens: Number(row.cache_write_input_tokens || 0),
        output_tokens: Number(row.output_tokens || 0),
        reasoning_output_tokens: Number(row.reasoning_output_tokens || 0),
        total_tokens: Number(row.total_tokens || 0),
      },
    }));
}
