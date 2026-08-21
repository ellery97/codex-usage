#!/usr/bin/env node

import { existsSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  costStatsForUsage,
  initializePricing,
  pricingMetadata,
  refreshPricing,
} from "./openai-pricing.mjs";
import {
  scanSessionFile,
  scanSessionFileRange,
  SESSION_SCANNER_VERSION,
} from "./session-scanner.mjs";
import { addUsage, usageZero } from "./usage-values.mjs";
import {
  addAssumedModel,
  addCostStats,
  addUnpricedModel,
  assumedModelsFromMap,
  costZero,
  unpricedModelsFromMap,
} from "./usage-costs.mjs";

export { scanSessionFile, scanSessionFileRange, SESSION_SCANNER_VERSION };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_DB_PATH = path.join(ROOT, ".codex-usage", "cache.sqlite");

const DATE_GROUPS = new Set(["day", "month"]);
const GROUPS = new Set(["none", "day", "month", "model", "cwd", "session"]);
const SORTS = new Set(["key", "total", "input", "output", "cached", "reasoning", "requests", "sessions", "cost"]);
const DEDUPE_SCOPES = new Set(["file", "global"]);
const DATE_FORMATTERS = new Map();
const TIME_FORMATTERS = new Map();
const DATE_KEY_CACHE = new Map();
const DATE_TIME_CACHE = new Map();
export const DEFAULT_WINDOWS_USERS_ROOT = "/mnt/c/Users";
const DEFAULT_WINDOWS_USER =
  process.env.CODEX_USAGE_WINDOWS_USER || process.env.USERNAME || process.env.USER || "windows-user";
export const DEFAULT_WINDOWS_SESSIONS_DIR = path.join(
  DEFAULT_WINDOWS_USERS_ROOT,
  DEFAULT_WINDOWS_USER,
  ".codex",
  "sessions",
);
export const DEFAULT_WINDOWS_ARCHIVED_SESSIONS_DIR = path.join(
  DEFAULT_WINDOWS_USERS_ROOT,
  DEFAULT_WINDOWS_USER,
  ".codex",
  "archived_sessions",
);
const SESSION_DIR_SEPARATOR = ":";
const SKIP_WINDOWS_USER_DIRS = new Set(["All Users", "Default", "Default User", "Public"]);

function expandHome(inputPath) {
  if (!inputPath) {
    return inputPath;
  }
  if (inputPath === "~") {
    return homedir();
  }
  if (inputPath.startsWith("~/")) {
    return path.join(homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function normalizeSessionDirs(dirs) {
  const seen = new Set();
  const normalized = [];
  for (const dir of dirs) {
    const expanded = expandHome(dir);
    if (!expanded) {
      continue;
    }
    const resolved = path.resolve(expanded);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    normalized.push(resolved);
  }
  return normalized;
}

function envSessionDirs() {
  return String(process.env.CODEX_USAGE_SESSIONS || "")
    .split(SESSION_DIR_SEPARATOR)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function defaultWindowsSessionDirs() {
  const dirs = [];
  if (existsSync(DEFAULT_WINDOWS_USERS_ROOT)) {
    try {
      for (const entry of readdirSync(DEFAULT_WINDOWS_USERS_ROOT, { withFileTypes: true })) {
        if (!entry.isDirectory() || SKIP_WINDOWS_USER_DIRS.has(entry.name)) {
          continue;
        }
        const userCodexHome = path.join(DEFAULT_WINDOWS_USERS_ROOT, entry.name, ".codex");
        dirs.push(path.join(userCodexHome, "sessions"));
        dirs.push(path.join(userCodexHome, "archived_sessions"));
      }
    } catch {
      dirs.push(DEFAULT_WINDOWS_SESSIONS_DIR, DEFAULT_WINDOWS_ARCHIVED_SESSIONS_DIR);
    }
  } else {
    dirs.push(DEFAULT_WINDOWS_SESSIONS_DIR, DEFAULT_WINDOWS_ARCHIVED_SESSIONS_DIR);
  }
  return normalizeSessionDirs(dirs.filter((dir) => existsSync(dir)));
}

function defaultSessionDirs(codexHome) {
  const dirs = [path.join(codexHome, "sessions"), ...defaultWindowsSessionDirs()];
  return normalizeSessionDirs(dirs);
}

function defaultTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function parseLocalDateStart(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) {
      throw new Error(`Invalid date/time: ${value}`);
    }
    return ms;
  }
  const [, year, month, day] = match.map(Number);
  return new Date(year, month - 1, day).getTime();
}

function parseDateBound(value, { endOfDate = false } = {}) {
  const ms = parseLocalDateStart(value);
  if (endOfDate && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return ms + 24 * 60 * 60 * 1000;
  }
  return ms;
}

function parseDuration(value) {
  const match = /^(\d+)([hdw])$/.exec(value);
  if (!match) {
    throw new Error(`Invalid duration for --last: ${value}. Use values like 24h, 7d, or 4w.`);
  }
  const n = Number(match[1]);
  const unit = match[2];
  const hour = 60 * 60 * 1000;
  if (unit === "h") return n * hour;
  if (unit === "d") return n * 24 * hour;
  return n * 7 * 24 * hour;
}

function zonedDateKey(timestampMs, timezone) {
  const { year, month, day } = dateParts(timestampMs, timezone);
  return `${year}-${month}-${day}`;
}

function startOfDateInTimezone(dateKey, timezone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) {
    throw new Error(`Invalid date: ${dateKey}`);
  }
  const [, year, month, day] = match.map(Number);
  const utcGuess = Date.UTC(year, month - 1, day);
  let low = utcGuess - 36 * 60 * 60 * 1000;
  let high = utcGuess + 36 * 60 * 60 * 1000;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (zonedDateKey(middle, timezone) < dateKey) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (zonedDateKey(low, timezone) !== dateKey) {
    throw new Error(`Date ${dateKey} does not exist in timezone ${timezone}`);
  }
  return low;
}

export function startOfDayInTimezone(timestampMs, timezone) {
  const now = Number(timestampMs);
  if (!Number.isFinite(now)) {
    throw new Error(`Invalid timestamp: ${timestampMs}`);
  }
  return startOfDateInTimezone(zonedDateKey(now, timezone), timezone);
}

export function parseArgs(argv, { nowMs = Date.now() } = {}) {
  const currentTimeMs = Number(nowMs);
  if (!Number.isFinite(currentTimeMs)) {
    throw new Error(`Invalid current time: ${nowMs}`);
  }
  const options = {
    codexHome: process.env.CODEX_HOME || path.join(homedir(), ".codex"),
    sessionsDir: null,
    sessionsDirs: [],
    sessionsExplicit: false,
    fromMs: null,
    toMs: null,
    group: "month",
    sort: null,
    desc: false,
    limit: 0,
    dedupeScope: "global",
    timezone: defaultTimezone(),
    useCache: false,
    cacheDbPath: path.resolve(process.env.CODEX_USAGE_DB || DEFAULT_DB_PATH),
    json: false,
    csv: false,
    help: false,
    refreshPricing: process.env.CODEX_USAGE_PRICING_REFRESH !== "0",
  };
  let relativeFrom = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[i];
    };

    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--codex-home") {
      options.codexHome = expandHome(next());
    } else if (arg === "--sessions" || arg === "--sessions-dir") {
      options.sessionsDirs.push(next());
      options.sessionsExplicit = true;
    } else if (arg === "--from" || arg === "--since") {
      options.fromMs = parseDateBound(next());
      relativeFrom = null;
    } else if (arg === "--to" || arg === "--until") {
      options.toMs = parseDateBound(next(), { endOfDate: true });
    } else if (arg === "--last") {
      relativeFrom = { type: "last", durationMs: parseDuration(next()) };
      options.toMs = null;
    } else if (arg === "--today") {
      relativeFrom = { type: "today" };
      options.toMs = null;
    } else if (arg === "--group") {
      options.group = next();
      if (!GROUPS.has(options.group)) {
        throw new Error(`Invalid --group: ${options.group}. Valid values: ${Array.from(GROUPS).join(", ")}`);
      }
    } else if (arg === "--sort") {
      options.sort = next();
      if (!SORTS.has(options.sort)) {
        throw new Error(`Invalid --sort: ${options.sort}. Valid values: ${Array.from(SORTS).join(", ")}`);
      }
    } else if (arg === "--desc") {
      options.desc = true;
    } else if (arg === "--asc") {
      options.desc = false;
    } else if (arg === "--limit") {
      options.limit = Number(next());
      if (!Number.isInteger(options.limit) || options.limit < 0) {
        throw new Error("--limit must be a non-negative integer");
      }
    } else if (arg === "--dedupe-scope") {
      options.dedupeScope = next();
      if (!DEDUPE_SCOPES.has(options.dedupeScope)) {
        throw new Error(`Invalid --dedupe-scope: ${options.dedupeScope}. Valid values: ${Array.from(DEDUPE_SCOPES).join(", ")}`);
      }
    } else if (arg === "--timezone" || arg === "--tz") {
      options.timezone = next();
    } else if (arg === "--use-cache") {
      options.useCache = true;
    } else if (arg === "--cache-db") {
      options.cacheDbPath = path.resolve(expandHome(next()));
      options.useCache = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--csv") {
      options.csv = true;
    } else if (arg === "--no-refresh-pricing") {
      options.refreshPricing = false;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (relativeFrom?.type === "last") {
    options.fromMs = currentTimeMs - relativeFrom.durationMs;
  } else if (relativeFrom?.type === "today") {
    options.fromMs = startOfDayInTimezone(currentTimeMs, options.timezone);
  }

  options.codexHome = expandHome(options.codexHome);
  if (!options.sessionsExplicit) {
    const fromEnv = envSessionDirs();
    if (fromEnv.length > 0) {
      options.sessionsDirs = fromEnv;
      options.sessionsExplicit = true;
    }
  }
  options.sessionsDirs = options.sessionsExplicit
    ? normalizeSessionDirs(options.sessionsDirs)
    : defaultSessionDirs(options.codexHome);
  options.sessionsDir = options.sessionsDirs[0] || path.join(options.codexHome, "sessions");
  options.sort = options.sort || (DATE_GROUPS.has(options.group) ? "key" : "total");
  options.desc = argv.includes("--desc") || (!DATE_GROUPS.has(options.group) && !argv.includes("--asc"));
  return options;
}

function helpText() {
  return `Usage:
  codex-token-usage [options]
  node ./bin/codex-token-usage.mjs [options]

Options:
  --codex-home PATH       Codex home directory. Default: $CODEX_HOME or ~/.codex
  --sessions PATH         Sessions directory. Can be repeated. Default: <codex-home>/sessions plus Windows sessions when present
  --from, --since DATE    Include token events at or after DATE
  --to, --until DATE      Include token events through DATE if DATE is YYYY-MM-DD
  --last DURATION         Include recent events, e.g. 24h, 7d, 4w
  --today                 Include events since midnight in --timezone
  --group VALUE           none, day, month, model, cwd, session. Default: month
  --sort VALUE            key, total, input, output, cached, reasoning, requests, sessions, cost
  --asc / --desc          Sort direction. Date groups default ascending; others descending
  --limit N               Limit grouped rows. 0 means no limit
  --dedupe-scope VALUE    file or global. Default: global
  --timezone TZ           Timezone for date labels and --today. Default: local timezone
  --use-cache             Use the SQLite index also used by the Web dashboard
  --cache-db PATH         SQLite index path. Implies --use-cache. Default: .codex-usage/cache.sqlite
  --json                  Emit machine-readable JSON
  --csv                   Emit grouped rows as CSV
  --no-refresh-pricing    Use the last validated local price catalog without network refresh
  -h, --help              Show this help

Notes:
  - The tool reads local Codex JSONL session files and aggregates event_msg.token_count.
  - CODEX_USAGE_SESSIONS can provide multiple sessions directories separated by ":".
  - --use-cache stores a local SQLite index, tails safe appends, and fully rescans rewritten files.
  - Duplicate token_count lines with the same cumulative total are skipped.
  - Global dedupe also skips copied historical token_count events embedded in later rollouts.
  - estimated_cost_usd contains only models with published prices; reference totals additionally include explicitly labelled model assumptions.
  - Prices are selected at each event timestamp and estimate Standard API usage, not a personal ChatGPT/Codex bill.
  - cached_input_tokens, cache_write_input_tokens, and reasoning_output_tokens are subsets; do not add them to total_tokens again.`;
}

export async function findJsonlFiles(root) {
  const files = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }

  await walk(root);
  return files;
}

export function inRange(event, options) {
  const ts = event.timestampMs;
  if (ts == null) {
    return false;
  }
  if (options.fromMs != null && ts < options.fromMs) {
    return false;
  }
  if (options.toMs != null && ts >= options.toMs) {
    return false;
  }
  return true;
}

function dateParts(timestampMs, timezone) {
  let formatter = DATE_FORMATTERS.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    DATE_FORMATTERS.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(new Date(timestampMs));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: byType.year, month: byType.month, day: byType.day };
}

export function formatDateKey(timestampMs, group, timezone) {
  const cacheKey = `${timezone}:${group}:${timestampMs}`;
  const cached = DATE_KEY_CACHE.get(cacheKey);
  if (cached) return cached;
  const { year, month, day } = dateParts(timestampMs, timezone);
  if (group === "month") {
    const value = `${year}-${month}`;
    DATE_KEY_CACHE.set(cacheKey, value);
    return value;
  }
  const value = `${year}-${month}-${day}`;
  DATE_KEY_CACHE.set(cacheKey, value);
  return value;
}

export function formatDateTime(timestampMs, timezone) {
  const cacheKey = `${timezone}:${timestampMs}`;
  const cached = DATE_TIME_CACHE.get(cacheKey);
  if (cached) return cached;
  const { year, month, day } = dateParts(timestampMs, timezone);
  let formatter = TIME_FORMATTERS.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    TIME_FORMATTERS.set(timezone, formatter);
  }
  const timeParts = formatter.formatToParts(new Date(timestampMs));
  const byType = Object.fromEntries(timeParts.map((part) => [part.type, part.value]));
  const value = `${year}-${month}-${day} ${byType.hour}:${byType.minute}`;
  DATE_TIME_CACHE.set(cacheKey, value);
  return value;
}

function groupKey(event, group, timezone) {
  if (group === "day" || group === "month") {
    return formatDateKey(event.timestampMs, group, timezone);
  }
  if (group === "model") {
    return event.model || "(unknown model)";
  }
  if (group === "cwd") {
    return event.cwd || "(unknown cwd)";
  }
  if (group === "session") {
    return `${formatDateTime(event.sessionCreatedAtMs || event.timestampMs, timezone)} ${event.sessionId}`;
  }
  return "total";
}

export function aggregate(events, options) {
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

    if (options.group === "none") {
      continue;
    }

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

function fmtNum(value) {
  return Math.round(value || 0).toLocaleString("en-US");
}

function fmtPct(value) {
  return `${(100 * (value || 0)).toFixed(1)}%`;
}

function fmtUsd(value) {
  const n = Number(value || 0);
  if (Math.abs(n) >= 1) {
    return `$${n.toFixed(2)}`;
  }
  return `$${n.toFixed(4)}`;
}

function sourceLabel(options) {
  return options.sessionsDirs.join(", ");
}

function table(rows) {
  const headers = [
    "group",
    "sessions",
    "requests",
    "input",
    "cached",
    "cache-write",
    "uncached",
    "output",
    "reasoning",
    "total",
    "official-cost",
    "reference-cost",
    "cache%",
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
  const renderRow = (row) =>
    row
      .map((cell, idx) => {
        const value = String(cell);
        return idx === 0 ? value.padEnd(widths[idx]) : value.padStart(widths[idx]);
      })
      .join("  ");
  return [renderRow(headers), renderRow(widths.map((w) => "-".repeat(w))), ...body.map(renderRow)].join("\n");
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function emitCsv(rows) {
  const headers = [
    "group",
    "sessions",
    "requests",
    "input_tokens",
    "cached_input_tokens",
    "uncached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
    "estimated_cost_usd",
    "priced_requests",
    "unpriced_requests",
    "priced_total_tokens",
    "unpriced_total_tokens",
    "cache_hit_ratio",
    "cache_write_input_tokens",
    "assumed_cost_usd",
    "assumed_upper_bound_cost_usd",
    "reference_total_cost_usd",
    "reference_total_upper_bound_cost_usd",
    "assumed_requests",
    "assumed_total_tokens",
    "provisional_priced_requests",
    "provisional_priced_total_tokens",
    "provisional_estimated_cost_usd",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.key,
        row.sessions,
        row.requests,
        row.input_tokens,
        row.cached_input_tokens,
        row.uncached_input_tokens,
        row.output_tokens,
        row.reasoning_output_tokens,
        row.total_tokens,
        row.estimated_cost_usd,
        row.priced_requests,
        row.unpriced_requests,
        row.priced_total_tokens,
        row.unpriced_total_tokens,
        row.cache_hit_ratio,
        row.cache_write_input_tokens,
        row.assumed_cost_usd,
        row.assumed_upper_bound_cost_usd,
        row.reference_total_cost_usd,
        row.reference_total_upper_bound_cost_usd,
        row.assumed_requests,
        row.assumed_total_tokens,
        row.provisional_priced_requests,
        row.provisional_priced_total_tokens,
        row.provisional_estimated_cost_usd,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return lines.join("\n");
}

function rangeLabel(options) {
  const from = options.fromMs == null ? "beginning" : new Date(options.fromMs).toISOString();
  const to = options.toMs == null ? "now" : new Date(options.toMs).toISOString();
  return `${from} .. ${to}`;
}

function textOutput(result, options, scanStats) {
  const lines = [];
  lines.push("Codex token usage");
  lines.push(`Source: ${sourceLabel(options)}`);
  lines.push(`Range: ${rangeLabel(options)}`);
  lines.push(`Timezone: ${options.timezone}`);
  lines.push(
    `Scanned: ${fmtNum(scanStats.files)} files, ${fmtNum(scanStats.filesWithUsage)} with token events, ${fmtNum(scanStats.duplicateTokenEvents)} duplicate token_count lines skipped`,
  );
  if (scanStats.globalDuplicateTokenEvents > 0) {
    lines.push(`Global dedupe: ${fmtNum(scanStats.globalDuplicateTokenEvents)} copied historical token_count events skipped`);
  }
  if (scanStats.parseErrors > 0) {
    lines.push(`Parse warnings: ${fmtNum(scanStats.parseErrors)} token/context lines could not be parsed`);
  }
  lines.push("");
  lines.push("Totals:");
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
    lines.push(
      `  provisional_priced: ${fmtNum(result.totals.provisional_priced_requests)} requests / ${fmtUsd(result.totals.provisional_estimated_cost_usd)}`,
    );
  }
  if (result.totals.assumed_requests > 0) {
    lines.push(
      `  assumed_cost_usd: ${fmtUsd(result.totals.assumed_cost_usd)} .. ${fmtUsd(result.totals.assumed_upper_bound_cost_usd)}`,
    );
  }
  lines.push(
    `  reference_total_cost_usd: ${fmtUsd(result.totals.reference_total_cost_usd)} .. ${fmtUsd(result.totals.reference_total_upper_bound_cost_usd)}`,
  );
  if (result.assumedModels?.length > 0) {
    const topModels = result.assumedModels
      .slice(0, 8)
      .map((row) => `${row.model} -> ${row.assumedModel} (${fmtNum(row.total_tokens)} tokens)`)
      .join(", ");
    lines.push(`  assumed_models: ${topModels}${result.assumedModels.length > 8 ? ", ..." : ""}`);
  }
  if (result.totals.unpriced_total_tokens > 0) {
    lines.push(`  unpriced_total_tokens: ${fmtNum(result.totals.unpriced_total_tokens)}`);
  }
  if (result.unpricedModels?.length > 0) {
    const topModels = result.unpricedModels
      .slice(0, 8)
      .map((row) => `${row.model} (${fmtNum(row.total_tokens)} tokens)`)
      .join(", ");
    lines.push(`  unpriced_models: ${topModels}${result.unpricedModels.length > 8 ? ", ..." : ""}`);
  }

  if (options.group !== "none") {
    lines.push("");
    lines.push(`Grouped by ${options.group}${options.limit > 0 && result.rowCount > result.rows.length ? `, first ${result.rows.length} of ${result.rowCount}` : ""}:`);
    lines.push(result.rows.length > 0 ? table(result.rows) : "(no rows)");
  }

  return lines.join("\n");
}

export async function buildUsagePayload(options) {
  if (options.useCache) {
    return buildUsagePayloadFromCache(options);
  }

  const files = [];
  for (const sessionsDir of options.sessionsDirs) {
    const dirFiles = await findJsonlFiles(sessionsDir);
    files.push(...dirFiles);
  }
  const events = [];
  const scanStats = {
    files: files.length,
    filesWithUsage: 0,
    duplicateTokenEvents: 0,
    parseErrors: 0,
    rawTokenEvents: 0,
    globalDuplicateTokenEvents: 0,
  };
  const globalSeenTotals = new Set();
  const observedModels = new Set();

  for (const file of files) {
    const scanned = await scanSessionFile(file);
    scanStats.duplicateTokenEvents += scanned.stats.duplicateTokenEvents;
    scanStats.parseErrors += scanned.stats.parseErrors;
    scanStats.rawTokenEvents += scanned.stats.tokenEvents;
    if (scanned.events.length > 0) {
      scanStats.filesWithUsage += 1;
    }
    for (const event of scanned.events) {
      if (event.model) observedModels.add(event.model);
      if (options.dedupeScope === "global") {
        if (globalSeenTotals.has(event.totalUsageKey)) {
          scanStats.globalDuplicateTokenEvents += 1;
          continue;
        }
        globalSeenTotals.add(event.totalUsageKey);
      }
      if (inRange(event, options)) {
        events.push(event);
      }
    }
  }

  await preparePricingForModels(observedModels, options);
  const result = aggregate(events, options);
  const payload = {
    source: options.sessionsDirs,
    range: {
      from: options.fromMs == null ? null : new Date(options.fromMs).toISOString(),
      to: options.toMs == null ? null : new Date(options.toMs).toISOString(),
    },
    timezone: options.timezone,
    group: options.group,
    sort: options.sort,
    desc: options.desc,
    dedupeScope: options.dedupeScope,
    totals: result.totals,
    rows: result.rows,
    rowCount: result.rowCount,
    assumedModels: result.assumedModels,
    unpricedModels: result.unpricedModels,
    stats: scanStats,
    pricing: pricingMetadata(),
  };

  return payload;
}

async function buildUsagePayloadFromCache(options) {
  const { closeUsageIndex, ensureFreshIndex, modelsInUsageIndex, openUsageIndex, usagePayloadFromIndex } = await import("./usage-index.mjs");
  const index = await openUsageIndex({ dbPath: options.cacheDbPath, scanCheckTtlMs: 0, enableGc: false });
  const startedAt = performance.now();
  try {
    const syncStats = await ensureFreshIndex(index, options.sessionsDirs);
    await preparePricingForModels(modelsInUsageIndex(index, options.sessionsDirs), options);
    const payload = usagePayloadFromIndex(index, syncStats, options);
    payload.stats.cacheMode = true;
    payload.stats.totalDurationMs = Math.round(performance.now() - startedAt);
    return payload;
  } finally {
    closeUsageIndex(index);
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
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

function isDirectRun() {
  return process.argv[1] && __filename === path.resolve(process.argv[1]);
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(`codex-token-usage: ${error.message}`);
    process.exitCode = 1;
  });
}
