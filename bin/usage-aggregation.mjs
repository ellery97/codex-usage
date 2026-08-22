import {
  emitCsv,
  findJsonlFiles,
  formatDateKey,
  formatDateTime,
  scanSessionFile,
} from "./codex-token-usage-core.mjs";
import {
  costStatsForUsage,
  initializePricing,
  pricingMetadata,
  refreshPricing,
} from "./openai-pricing.mjs";
import {
  addAssumedModel,
  addCostStats,
  addUnpricedModel,
  assumedModelsFromMap,
  costZero,
  unpricedModelsFromMap,
} from "./usage-costs.mjs";
import { addUsage, usageZero } from "./usage-values.mjs";

export const UNKNOWN_TIME = "(unknown time)";

export function compareCanonicalFilePaths(left, right) {
  return Buffer.compare(Buffer.from(String(left), "utf8"), Buffer.from(String(right), "utf8"));
}

export function inRange(event, options) {
  const ts = event.timestampMs;
  if (ts == null) {
    return options.fromMs == null && options.toMs == null;
  }
  if (options.fromMs != null && ts < options.fromMs) return false;
  if (options.toMs != null && ts >= options.toMs) return false;
  return true;
}

function groupKey(event, group, timezone) {
  if (group === "day" || group === "month") {
    return event.timestampMs == null ? UNKNOWN_TIME : formatDateKey(event.timestampMs, group, timezone);
  }
  if (group === "model") return event.model || "(unknown model)";
  if (group === "cwd") return event.cwd || "(unknown cwd)";
  if (group === "session") {
    const keyMs = event.sessionCreatedAtMs ?? event.timestampMs;
    const time = keyMs == null ? UNKNOWN_TIME : formatDateTime(keyMs, timezone);
    return `${time} ${event.sessionId}`;
  }
  return "total";
}

export function aggregateUsageEvents(events, options) {
  const totals = {
    sessions: new Set(),
    requests: 0,
    usage: usageZero(),
    cost: costZero(),
    assumedModels: new Map(),
    unpricedModels: new Map(),
  };
  const groups = new Map();

  for (const event of events) {
    const eventCost = costStatsForUsage(event.model, event.usage, event.timestampMs);
    totals.sessions.add(event.sessionId);
    totals.requests += 1;
    addUsage(totals.usage, event.usage);
    addCostStats(totals.cost, eventCost);
    if (eventCost.assumed_requests > 0) {
      addAssumedModel(totals.assumedModels, event, eventCost);
    } else if (eventCost.unpriced_requests > 0) {
      addUnpricedModel(totals.unpricedModels, event);
    }

    if (options.group === "none") continue;
    const key = groupKey(event, options.group, options.timezone);
    let row = groups.get(key);
    if (!row) {
      row = {
        key,
        sessions: new Set(),
        requests: 0,
        usage: usageZero(),
        cost: costZero(),
      };
      groups.set(key, row);
    }
    row.sessions.add(event.sessionId);
    row.requests += 1;
    addUsage(row.usage, event.usage);
    addCostStats(row.cost, eventCost);
  }

  const rows = Array.from(groups.values()).map((row) => ({
    key: row.key,
    sessions: row.sessions.size,
    requests: row.requests,
    ...withDerivedUsage(row.usage),
    ...row.cost,
  }));
  rows.sort((a, b) => compareRows(a, b, options));
  const limitedRows = options.limit > 0 ? rows.slice(0, options.limit) : rows;

  return {
    totals: {
      sessions: totals.sessions.size,
      requests: totals.requests,
      ...withDerivedUsage(totals.usage),
      ...totals.cost,
    },
    rows: limitedRows,
    rowCount: rows.length,
    assumedModels: assumedModelsFromMap(totals.assumedModels),
    unpricedModels: unpricedModelsFromMap(totals.unpricedModels),
  };
}

function withDerivedUsage(usage) {
  const out = { ...usage };
  out.uncached_input_tokens = Math.max(
    0,
    out.input_tokens - out.cached_input_tokens - out.cache_write_input_tokens,
  );
  out.cache_hit_ratio = out.input_tokens > 0 ? out.cached_input_tokens / out.input_tokens : 0;
  return out;
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

export async function buildUsagePayload(options) {
  if (options.useCache) return buildUsagePayloadFromCache(options);

  const files = [];
  for (const sessionsDir of options.sessionsDirs) {
    files.push(...(await findJsonlFiles(sessionsDir)));
  }
  files.sort(compareCanonicalFilePaths);

  const events = [];
  const scanStats = {
    files: files.length,
    filesWithUsage: 0,
    duplicateTokenEvents: 0,
    parseErrors: 0,
    rawTokenEvents: 0,
    globalDuplicateTokenEvents: 0,
    unknownTimestampEvents: 0,
    unknownTimestampTokens: 0,
    excludedUnknownTimestampEvents: 0,
    excludedUnknownTimestampTokens: 0,
  };
  const globalSeenTotals = new Set();
  const observedModels = new Set();
  const boundedRange = options.fromMs != null || options.toMs != null;

  for (const file of files) {
    const scanned = await scanSessionFile(file);
    scanStats.duplicateTokenEvents += scanned.stats.duplicateTokenEvents;
    scanStats.parseErrors += scanned.stats.parseErrors;
    scanStats.rawTokenEvents += scanned.stats.tokenEvents;
    if (scanned.events.length > 0) scanStats.filesWithUsage += 1;

    for (const event of scanned.events) {
      if (event.model) observedModels.add(event.model);
      if (options.dedupeScope === "global") {
        if (globalSeenTotals.has(event.totalUsageKey)) {
          scanStats.globalDuplicateTokenEvents += 1;
          continue;
        }
        globalSeenTotals.add(event.totalUsageKey);
      }

      if (event.timestampMs == null) {
        const tokens = Number(event.usage?.total_tokens || 0);
        scanStats.unknownTimestampEvents += 1;
        scanStats.unknownTimestampTokens += tokens;
        if (boundedRange) {
          scanStats.excludedUnknownTimestampEvents += 1;
          scanStats.excludedUnknownTimestampTokens += tokens;
        }
      }
      if (inRange(event, options)) events.push(event);
    }
  }

  await preparePricingForModels(observedModels, options);
  const result = aggregateUsageEvents(events, options);
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
    totals: result.totals,
    rows: result.rows,
    rowCount: result.rowCount,
    assumedModels: result.assumedModels,
    unpricedModels: result.unpricedModels,
    stats: scanStats,
    pricing: pricingMetadata(),
  };
}

async function buildUsagePayloadFromCache(options) {
  const [indexModule, viewModule] = await Promise.all([
    import("./usage-index.mjs"),
    import("./usage-index-view.mjs"),
  ]);
  const index = await indexModule.openUsageIndex({
    dbPath: options.cacheDbPath,
    scanCheckTtlMs: 0,
    enableGc: false,
  });
  const startedAt = performance.now();
  try {
    const syncStats = await indexModule.ensureFreshIndex(index, options.sessionsDirs);
    await preparePricingForModels(indexModule.modelsInUsageIndex(index, options.sessionsDirs), options);
    const payload = viewModule.usagePayloadFromIndex(index, syncStats, options);
    payload.stats.cacheMode = true;
    payload.stats.totalDurationMs = Math.round(performance.now() - startedAt);
    return payload;
  } finally {
    indexModule.closeUsageIndex(index);
  }
}

async function preparePricingForModels(models, options) {
  if (typeof options.refreshPricing !== "boolean") return;
  await initializePricing({ dbPath: options.cacheDbPath });
  const result = await refreshPricing({
    models,
    dbPath: options.cacheDbPath,
    enabled: options.refreshPricing,
  });
  if (result.warning && typeof options.onPricingWarning === "function") {
    options.onPricingWarning(result.warning);
  }
}

function fmtNum(value) {
  return Math.round(value || 0).toLocaleString("en-US");
}

function fmtPct(value) {
  return `${(100 * (value || 0)).toFixed(1)}%`;
}

function fmtUsd(value) {
  const n = Number(value || 0);
  return Math.abs(n) >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

function table(rows) {
  const headers = [
    "group", "sessions", "requests", "input", "cached", "cache-write", "uncached",
    "output", "reasoning", "total", "official-cost", "reference-cost", "cache%",
  ];
  const body = rows.map((row) => [
    row.key,
    fmtNum(row.sessions),
    fmtNum(row.requests),
    fmtNum(row.input_tokens),
    fmtNum(row.cached_input_tokens),
    fmtNum(row.cache_write_input_tokens),
    fmtNum(row.uncached_input_tokens),
    fmtNum(row.output_tokens),
    fmtNum(row.reasoning_output_tokens),
    fmtNum(row.total_tokens),
    fmtUsd(row.estimated_cost_usd),
    fmtUsd(row.reference_total_cost_usd),
    fmtPct(row.cache_hit_ratio),
  ]);
  const widths = headers.map((header, idx) =>
    Math.max(header.length, ...body.map((row) => String(row[idx]).length)),
  );
  const renderRow = (row) => row.map((cell, idx) => {
    const value = String(cell);
    return idx === 0 ? value.padEnd(widths[idx]) : value.padStart(widths[idx]);
  }).join("  ");
  return [renderRow(headers), renderRow(widths.map((w) => "-".repeat(w))), ...body.map(renderRow)].join("\n");
}

function textOutput(result, options, scanStats) {
  const lines = [
    "Codex token usage",
    `Source: ${options.sessionsDirs.join(", ")}`,
    `Range: ${options.fromMs == null ? "beginning" : new Date(options.fromMs).toISOString()} .. ${options.toMs == null ? "now" : new Date(options.toMs).toISOString()}`,
    `Timezone: ${options.timezone}`,
    `Scanned: ${fmtNum(scanStats.files)} files, ${fmtNum(scanStats.filesWithUsage)} with token events, ${fmtNum(scanStats.duplicateTokenEvents)} duplicate token_count lines skipped`,
  ];
  if (scanStats.globalDuplicateTokenEvents > 0) {
    lines.push(`Global dedupe: ${fmtNum(scanStats.globalDuplicateTokenEvents)} copied historical token_count events skipped`);
  }
  if (scanStats.parseErrors > 0) {
    lines.push(`Parse warnings: ${fmtNum(scanStats.parseErrors)} token/context lines could not be parsed`);
  }
  if (scanStats.unknownTimestampEvents > 0) {
    if (scanStats.excludedUnknownTimestampEvents > 0) {
      lines.push(`Unknown timestamps: ${fmtNum(scanStats.excludedUnknownTimestampEvents)} events / ${fmtNum(scanStats.excludedUnknownTimestampTokens)} tokens excluded by the bounded time range`);
    } else {
      lines.push(`Unknown timestamps: ${fmtNum(scanStats.unknownTimestampEvents)} events / ${fmtNum(scanStats.unknownTimestampTokens)} tokens included as unpriced usage`);
    }
  }
  lines.push("", "Totals:");
  lines.push(`  sessions: ${fmtNum(result.totals.sessions)}`);
  lines.push(`  requests: ${fmtNum(result.totals.requests)}`);
  lines.push(`  input_tokens: ${fmtNum(result.totals.input_tokens)}`);
  lines.push(`  cached_input_tokens: ${fmtNum(result.totals.cached_input_tokens)} (${fmtPct(result.totals.cache_hit_ratio)})`);
  lines.push(`  cache_write_input_tokens: ${fmtNum(result.totals.cache_write_input_tokens)}`);
  lines.push(`  uncached_input_tokens: ${fmtNum(result.totals.uncached_input_tokens)}`);
  lines.push(`  output_tokens: ${fmtNum(result.totals.output_tokens)}`);
  lines.push(`  reasoning_output_tokens: ${fmtNum(result.totals.reasoning_output_tokens)}`);
  lines.push(`  total_tokens: ${fmtNum(result.totals.total_tokens)}`);
  lines.push(`  official_estimated_cost_usd: ${fmtUsd(result.totals.estimated_cost_usd)}`);
  if (result.totals.provisional_priced_requests > 0) {
    lines.push(`  provisional_priced: ${fmtNum(result.totals.provisional_priced_requests)} requests / ${fmtUsd(result.totals.provisional_estimated_cost_usd)}`);
  }
  if (result.totals.assumed_requests > 0) {
    lines.push(`  assumed_cost_usd: ${fmtUsd(result.totals.assumed_cost_usd)} .. ${fmtUsd(result.totals.assumed_upper_bound_cost_usd)}`);
  }
  lines.push(`  reference_total_cost_usd: ${fmtUsd(result.totals.reference_total_cost_usd)} .. ${fmtUsd(result.totals.reference_total_upper_bound_cost_usd)}`);
  if (result.assumedModels?.length > 0) {
    const topModels = result.assumedModels.slice(0, 8)
      .map((row) => `${row.model} -> ${row.assumedModel} (${fmtNum(row.total_tokens)} tokens)`)
      .join(", ");
    lines.push(`  assumed_models: ${topModels}${result.assumedModels.length > 8 ? ", ..." : ""}`);
  }
  if (result.totals.unpriced_total_tokens > 0) {
    lines.push(`  unpriced_total_tokens: ${fmtNum(result.totals.unpriced_total_tokens)}`);
  }
  if (result.unpricedModels?.length > 0) {
    const topModels = result.unpricedModels.slice(0, 8)
      .map((row) => `${row.model} (${fmtNum(row.total_tokens)} tokens)`)
      .join(", ");
    lines.push(`  unpriced_models: ${topModels}${result.unpricedModels.length > 8 ? ", ..." : ""}`);
  }
  if (options.group !== "none") {
    lines.push("", `Grouped by ${options.group}${options.limit > 0 && result.rowCount > result.rows.length ? `, first ${result.rows.length} of ${result.rowCount}` : ""}:`);
    lines.push(result.rows.length > 0 ? table(result.rows) : "(no rows)");
  }
  return lines.join("\n");
}

function helpText() {
  return `Usage:\n  codex-token-usage [options]\n  node ./bin/codex-token-usage.mjs [options]\n\nOptions:\n  --codex-home PATH       Codex home directory. Default: $CODEX_HOME or ~/.codex\n  --sessions PATH         Sessions directory. Can be repeated. Default: all discovered WSL/Linux and Windows sources\n  --from, --since DATE    Include token events at or after DATE\n  --to, --until DATE      Include token events through DATE if DATE is YYYY-MM-DD\n  --last DURATION         Include recent events, e.g. 24h, 7d, 4w\n  --today                 Include events since midnight in --timezone\n  --group VALUE           none, day, month, model, cwd, session. Default: month\n  --sort VALUE            key, total, input, output, cached, reasoning, requests, sessions, cost\n  --asc / --desc          Sort direction. Date groups default ascending; others descending\n  --limit N               Limit grouped rows. 0 means no limit\n  --dedupe-scope VALUE    file or global. Default: global\n  --timezone TZ           Timezone for date labels and --today. Default: local timezone\n  --use-cache             Use the SQLite index also used by the Web dashboard\n  --cache-db PATH         SQLite index path. Implies --use-cache. Default: .codex-usage/cache.sqlite\n  --json                  Emit machine-readable JSON\n  --csv                   Emit grouped rows as CSV\n  --no-refresh-pricing    Use the last validated local price catalog without network refresh\n  -h, --help              Show this help`;
}

export async function runCli(argv, { parseArgs }) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }
  options.onPricingWarning = (message) => console.error(`codex-token-usage: ${message}`);
  const payload = await buildUsagePayload(options);
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (options.csv) {
    console.log(emitCsv(payload.rows));
  } else {
    console.log(textOutput(payload, options, payload.stats));
  }
}
