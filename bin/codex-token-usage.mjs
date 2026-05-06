#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

const DATE_GROUPS = new Set(["day", "month"]);
const GROUPS = new Set(["none", "day", "month", "model", "cwd", "session"]);
const SORTS = new Set(["key", "total", "input", "output", "cached", "reasoning", "requests", "sessions"]);
const DEDUPE_SCOPES = new Set(["file", "global"]);
const DATE_FORMATTERS = new Map();
const TIME_FORMATTERS = new Map();
const DATE_KEY_CACHE = new Map();
const DATE_TIME_CACHE = new Map();

function usageZero() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
}

function normalizeUsage(value) {
  const usage = usageZero();
  if (!value || typeof value !== "object") {
    return usage;
  }
  for (const field of USAGE_FIELDS) {
    const n = Number(value[field] ?? 0);
    usage[field] = Number.isFinite(n) ? n : 0;
  }
  return usage;
}

function addUsage(target, source) {
  for (const field of USAGE_FIELDS) {
    target[field] += source[field] || 0;
  }
  return target;
}

function diffUsage(next, prev) {
  const usage = usageZero();
  for (const field of USAGE_FIELDS) {
    usage[field] = Math.max(0, (next[field] || 0) - (prev[field] || 0));
  }
  return usage;
}

function usageKey(usage) {
  return USAGE_FIELDS.map((field) => usage[field] || 0).join(":");
}

function hasUsage(usage) {
  return USAGE_FIELDS.some((field) => (usage[field] || 0) > 0);
}

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

export function parseArgs(argv) {
  const options = {
    codexHome: process.env.CODEX_HOME || path.join(homedir(), ".codex"),
    sessionsDir: null,
    fromMs: null,
    toMs: null,
    group: "month",
    sort: null,
    desc: false,
    limit: 0,
    dedupeScope: "global",
    timezone: defaultTimezone(),
    json: false,
    csv: false,
    help: false,
  };

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
      options.sessionsDir = expandHome(next());
    } else if (arg === "--from" || arg === "--since") {
      options.fromMs = parseDateBound(next());
    } else if (arg === "--to" || arg === "--until") {
      options.toMs = parseDateBound(next(), { endOfDate: true });
    } else if (arg === "--last") {
      options.fromMs = Date.now() - parseDuration(next());
      options.toMs = null;
    } else if (arg === "--today") {
      options.fromMs = parseLocalDateStart(formatDateKey(Date.now(), "day", options.timezone));
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
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--csv") {
      options.csv = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.codexHome = expandHome(options.codexHome);
  options.sessionsDir = options.sessionsDir || path.join(options.codexHome, "sessions");
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
  --sessions PATH         Sessions directory. Default: <codex-home>/sessions
  --from, --since DATE    Include token events at or after DATE
  --to, --until DATE      Include token events through DATE if DATE is YYYY-MM-DD
  --last DURATION         Include recent events, e.g. 24h, 7d, 4w
  --today                 Include events since local midnight
  --group VALUE           none, day, month, model, cwd, session. Default: month
  --sort VALUE            key, total, input, output, cached, reasoning, requests, sessions
  --asc / --desc          Sort direction. Date groups default ascending; others descending
  --limit N               Limit grouped rows. 0 means no limit
  --dedupe-scope VALUE    file or global. Default: global
  --timezone TZ           Timezone for day/month labels. Default: local timezone
  --json                  Emit machine-readable JSON
  --csv                   Emit grouped rows as CSV
  -h, --help              Show this help

Notes:
  - The tool reads local Codex JSONL session files and aggregates event_msg.token_count.
  - Duplicate token_count lines with the same cumulative total are skipped.
  - Global dedupe also skips copied historical token_count events embedded in later rollouts.
  - cached_input_tokens and reasoning_output_tokens are subsets; do not add them to total_tokens again.`;
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

function sessionIdFromPath(filePath) {
  const base = path.basename(filePath, ".jsonl");
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(base);
  return match ? match[1] : base;
}

export async function scanSessionFile(filePath) {
  const events = [];
  const seenTotals = new Set();
  const stats = {
    duplicateTokenEvents: 0,
    parseErrors: 0,
    tokenEvents: 0,
  };

  const session = {
    id: sessionIdFromPath(filePath),
    file: filePath,
    cwd: "",
    model: "",
    createdAtMs: null,
  };

  let context = { cwd: "", model: "" };
  let lastTotalUsage = usageZero();
  let sawPrimarySessionMeta = false;

  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (
      !line.includes('"token_count"') &&
      !line.includes('"turn_context"') &&
      !line.includes('"session_meta"')
    ) {
      continue;
    }

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      stats.parseErrors += 1;
      continue;
    }

    if (obj.type === "session_meta" && obj.payload) {
      if (!sawPrimarySessionMeta) {
        session.id = obj.payload.id || session.id;
        session.cwd = obj.payload.cwd || session.cwd;
        const created = Date.parse(obj.payload.timestamp || obj.timestamp || "");
        if (!Number.isNaN(created)) {
          session.createdAtMs = created;
        }
        sawPrimarySessionMeta = true;
      }
      continue;
    }

    if (obj.type === "turn_context" && obj.payload) {
      context = {
        cwd: obj.payload.cwd || context.cwd || session.cwd,
        model: obj.payload.model || context.model || session.model,
      };
      session.cwd = context.cwd || session.cwd;
      session.model = context.model || session.model;
      continue;
    }

    if (obj.type !== "event_msg" || obj.payload?.type !== "token_count") {
      continue;
    }

    stats.tokenEvents += 1;
    const info = obj.payload.info || {};
    const totalUsage = normalizeUsage(info.total_token_usage);
    const totalKey = usageKey(totalUsage);
    if (seenTotals.has(totalKey)) {
      stats.duplicateTokenEvents += 1;
      continue;
    }
    seenTotals.add(totalKey);

    let usage = normalizeUsage(info.last_token_usage);
    if (!hasUsage(usage)) {
      usage = diffUsage(totalUsage, lastTotalUsage);
    }
    lastTotalUsage = totalUsage;

    const timestampMs = Date.parse(obj.timestamp || "");
    events.push({
      timestampMs: Number.isNaN(timestampMs) ? session.createdAtMs : timestampMs,
      sessionCreatedAtMs: session.createdAtMs,
      sessionId: session.id,
      totalUsageKey: totalKey,
      file: filePath,
      cwd: context.cwd || session.cwd || "(unknown cwd)",
      model: context.model || session.model || "(unknown model)",
      usage,
    });
  }

  return { session, events, stats };
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
  };
  const groups = new Map();

  for (const event of events) {
    totals.sessions.add(event.sessionId);
    totals.requests += 1;
    addUsage(totals.usage, event.usage);

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
      };
      groups.set(key, row);
    }
    row.sessions.add(event.sessionId);
    row.requests += 1;
    addUsage(row.usage, event.usage);
  }

  const rows = Array.from(groups.values()).map((row) => ({
    key: row.key,
    sessions: row.sessions.size,
    requests: row.requests,
    ...withDerivedUsage(row.usage),
  }));

  rows.sort((a, b) => compareRows(a, b, options));
  const limitedRows = options.limit > 0 ? rows.slice(0, options.limit) : rows;

  return {
    totals: {
      sessions: totals.sessions.size,
      requests: totals.requests,
      ...withDerivedUsage(totals.usage),
    },
    rows: limitedRows,
    rowCount: rows.length,
  };
}

function withDerivedUsage(usage) {
  const out = { ...usage };
  out.uncached_input_tokens = Math.max(0, out.input_tokens - out.cached_input_tokens);
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

function table(rows) {
  const headers = [
    "group",
    "sessions",
    "requests",
    "input",
    "cached",
    "uncached",
    "output",
    "reasoning",
    "total",
    "cache%",
  ];
  const body = rows.map((row) => [
    row.key,
    fmtNum(row.sessions),
    fmtNum(row.requests),
    fmtNum(row.input_tokens),
    fmtNum(row.cached_input_tokens),
    fmtNum(row.uncached_input_tokens),
    fmtNum(row.output_tokens),
    fmtNum(row.reasoning_output_tokens),
    fmtNum(row.total_tokens),
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

function emitCsv(rows) {
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
    "cache_hit_ratio",
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
        row.cache_hit_ratio,
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
  lines.push(`Source: ${options.sessionsDir}`);
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
  lines.push(`  uncached_input_tokens: ${fmtNum(result.totals.uncached_input_tokens)}`);
  lines.push(`  output_tokens: ${fmtNum(result.totals.output_tokens)}`);
  lines.push(`  reasoning_output_tokens: ${fmtNum(result.totals.reasoning_output_tokens)}`);
  lines.push(`  total_tokens: ${fmtNum(result.totals.total_tokens)}`);

  if (options.group !== "none") {
    lines.push("");
    lines.push(`Grouped by ${options.group}${options.limit > 0 && result.rowCount > result.rows.length ? `, first ${result.rows.length} of ${result.rowCount}` : ""}:`);
    lines.push(result.rows.length > 0 ? table(result.rows) : "(no rows)");
  }

  return lines.join("\n");
}

export async function buildUsagePayload(options) {
  const files = await findJsonlFiles(options.sessionsDir);
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

  for (const file of files) {
    const scanned = await scanSessionFile(file);
    scanStats.duplicateTokenEvents += scanned.stats.duplicateTokenEvents;
    scanStats.parseErrors += scanned.stats.parseErrors;
    scanStats.rawTokenEvents += scanned.stats.tokenEvents;
    if (scanned.events.length > 0) {
      scanStats.filesWithUsage += 1;
    }
    for (const event of scanned.events) {
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

  const result = aggregate(events, options);
  const payload = {
    source: options.sessionsDir,
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
    stats: scanStats,
  };

  return payload;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return;
  }

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
  return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(`codex-token-usage: ${error.message}`);
    process.exitCode = 1;
  });
}
