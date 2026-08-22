#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_WINDOWS_SESSIONS_DIR,
  defaultWindowsSessionDirs,
} from "./codex-token-usage.mjs";
import { parseArgs } from "./usage-options.mjs";
import {
  closeUsageIndex,
  DEFAULT_DB_PATH,
  ensureFreshIndex,
  modelsInUsageIndex,
  openUsageIndex,
  prewarmCanonicalScope,
} from "./usage-index.mjs";
import { initializePricing, refreshPricing } from "./openai-pricing.mjs";
import { createUsageQueryService } from "./usage-query.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");

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
const RANGES = new Set(["all", "today", "24h", "7d", "30d", "12w", "custom"]);
const RANGE_TO_LAST = new Map([
  ["24h", "24h"],
  ["7d", "7d"],
  ["30d", "30d"],
  ["12w", "12w"],
]);
const RELATIVE_RANGE_BUCKET_MS = 60 * 1000;

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
]);

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function methodNotAllowed(res, allowed) {
  json(res, 405, { error: "Method not allowed" }, { allow: allowed.join(", ") });
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function validateChoice(searchParams, name, allowed, fallback) {
  const value = searchParams.get(name);
  if (value == null || value === "") return fallback;
  if (!allowed.has(value)) {
    throw new HttpError(400, `Invalid ${name}: ${value}`);
  }
  return value;
}

function localSessionsDir() {
  return path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions");
}

function sourceScopeFromQuery(searchParams) {
  return validateChoice(searchParams, "sourceScope", SOURCE_SCOPES, "all");
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

function usageArgvFromQuery(searchParams, sourceRegistry = null) {
  const group = validateChoice(searchParams, "group", GROUPS, "month");
  const sort = validateChoice(
    searchParams,
    "sort",
    SORTS,
    group === "day" || group === "month" ? "key" : "total",
  );
  const dedupeScope = validateChoice(searchParams, "dedupeScope", DEDUPE_SCOPES, "global");
  const range = validateChoice(searchParams, "range", RANGES, "all");
  const sourceScope = sourceScopeFromQuery(searchParams);
  const args = ["--group", group, "--sort", sort];

  if (sourceRegistry) {
    for (const dir of sourceRegistry[sourceScope] || []) {
      args.push("--sessions", dir);
    }
  } else if (sourceScope === "local") {
    args.push("--sessions", localSessionsDir());
  } else if (sourceScope === "windows") {
    addWindowsSessionArgs(args);
  }

  const rawLimit = searchParams.get("limit");
  if (rawLimit != null && rawLimit !== "" && !/^\d+$/.test(rawLimit)) {
    throw new HttpError(400, `Invalid limit: ${rawLimit}`);
  }
  const limit = clampInt(rawLimit, group === "cwd" || group === "session" ? 30 : 0, 0, 500);
  if (limit > 0) {
    args.push("--limit", String(limit));
  }

  args.push("--dedupe-scope", dedupeScope);

  const desc = searchParams.get("desc");
  const asc = searchParams.get("asc");
  if (desc != null && !["0", "1", "false", "true"].includes(desc)) {
    throw new HttpError(400, `Invalid desc: ${desc}`);
  }
  if (asc != null && !["0", "1", "false", "true"].includes(asc)) {
    throw new HttpError(400, `Invalid asc: ${asc}`);
  }
  if (desc === "1" || desc === "true") {
    args.push("--desc");
  } else if (asc === "1" || asc === "true") {
    args.push("--asc");
  }

  if (range === "today") {
    args.push("--today");
  } else if (RANGE_TO_LAST.has(range)) {
    args.push("--last", RANGE_TO_LAST.get(range));
  } else if (range === "custom") {
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    if (!from && !to) {
      throw new HttpError(400, "Custom range requires from and/or to");
    }
    if (from) args.push("--from", from);
    if (to) args.push("--to", to);
  }

  const timezone = searchParams.get("timezone");
  if (timezone) {
    args.push("--timezone", timezone);
  }

  return args;
}

export function optionsFromQuery(
  searchParams,
  { sourceRegistry = null, nowMs = Date.now() } = {},
) {
  const rangeKey = validateChoice(searchParams, "range", RANGES, "all");
  const rangeNowMs = RANGE_TO_LAST.has(rangeKey)
    ? Math.floor(Number(nowMs) / RELATIVE_RANGE_BUCKET_MS) * RELATIVE_RANGE_BUCKET_MS
    : Number(nowMs);
  try {
    const options = parseArgs(usageArgvFromQuery(searchParams, sourceRegistry), {
      nowMs: rangeNowMs,
    });
    options.sourceScope = sourceScopeFromQuery(searchParams);
    options.rangeKey = rangeKey;
    return options;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, error.message);
  }
}

export async function runUsage(
  queryService,
  searchParams,
  sourceRegistry = null,
  { refreshIndex = null } = {},
) {
  const options = optionsFromQuery(searchParams, { sourceRegistry });
  const requestedRefresh = searchParams.get("refreshIndex") === "1";
  return queryService.query(options, {
    // GET is read-only by default. refreshIndex=1 is retained temporarily for
    // dashboard/backward compatibility; new callers should use POST /api/index/refresh.
    refreshIndex: refreshIndex == null ? requestedRefresh : Boolean(refreshIndex),
  });
}

export async function refreshUsage(queryService, searchParams, sourceRegistry = null) {
  return runUsage(queryService, searchParams, sourceRegistry, { refreshIndex: true });
}

export function discoverSourceRegistry() {
  const windowsDirs = defaultWindowsSessionDirs();
  return {
    all: parseArgs([]).sessionsDirs,
    local: [localSessionsDir()],
    windows: windowsDirs.length > 0 ? windowsDirs : [DEFAULT_WINDOWS_SESSIONS_DIR],
  };
}

async function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    methodNotAllowed(res, ["GET", "HEAD"]);
    return;
  }
  const safePathname = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(PUBLIC_DIR, safePathname.replace(/^\/+/, ""));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
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
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(filePath);
    stream.on("error", () => {
      if (!res.headersSent) {
        json(res, 500, { error: "Failed to read static asset" });
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

export async function initializeDashboard({
  dbPath = DB_PATH,
  scanCheckTtlMs = SCAN_CHECK_TTL_MS,
  scanConcurrency = SCAN_CONCURRENCY,
  enableGc = ENABLE_GC,
  initializePricingImpl = initializePricing,
  refreshPricingImpl = refreshPricing,
} = {}) {
  const usageIndex = await openUsageIndex({
    dbPath,
    scanCheckTtlMs,
    scanConcurrency,
    enableGc,
  });
  try {
    const sourceRegistry = discoverSourceRegistry();
    const allOptions = optionsFromQuery(new URLSearchParams(), { sourceRegistry });
    const startupSync = await ensureFreshIndex(usageIndex, allOptions.sessionsDirs, { force: true });

    await initializePricingImpl({ dbPath });
    const pricingRefresh = await refreshPricingImpl({
      dbPath,
      models: modelsInUsageIndex(usageIndex, allOptions.sessionsDirs),
    });
    if (pricingRefresh.warning) {
      console.warn(`Pricing: ${pricingRefresh.warning}`);
    }

    await prewarmDashboardScopes(usageIndex, sourceRegistry);
    const queryService = createUsageQueryService(usageIndex);
    await queryService.query(optionsFromQuery(defaultDashboardSearchParams(), { sourceRegistry }), {
      refreshIndex: false,
    });
    return { usageIndex, queryService, sourceRegistry, pricingRefresh, startupSync };
  } catch (error) {
    closeUsageIndex(usageIndex);
    throw error;
  }
}

export async function startDashboard({ port = PORT, host = HOST, ...initializeOptions } = {}) {
  const dashboard = await initializeDashboard(initializeOptions);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
    try {
      if (url.pathname === "/api/usage") {
        if (req.method !== "GET") {
          methodNotAllowed(res, ["GET"]);
          return;
        }
        const payload = await runUsage(
          dashboard.queryService,
          url.searchParams,
          dashboard.sourceRegistry,
        );
        json(res, 200, payload);
        return;
      }
      if (url.pathname === "/api/index/refresh") {
        if (req.method !== "POST") {
          methodNotAllowed(res, ["POST"]);
          return;
        }
        const payload = await refreshUsage(
          dashboard.queryService,
          url.searchParams,
          dashboard.sourceRegistry,
        );
        json(res, 200, payload);
        return;
      }
      if (url.pathname === "/api/health") {
        if (req.method !== "GET") {
          methodNotAllowed(res, ["GET"]);
          return;
        }
        json(res, 200, { ok: true });
        return;
      }
      await serveStatic(req, res, url.pathname);
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500);
      if (statusCode >= 500) {
        console.error(`codex-usage-server: ${error.message}`);
      }
      json(res, statusCode, {
        error: statusCode >= 500 ? "Internal server error" : error.message,
      });
    }
  });
  server.once("close", () => closeUsageIndex(dashboard.usageIndex));

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    closeUsageIndex(dashboard.usageIndex);
    throw error;
  }
  console.log(`Codex usage dashboard: http://${host}:${port}`);
  console.log(`SQLite index: ${dashboard.usageIndex.dbPath}`);
  return { ...dashboard, server };
}

async function prewarmDashboardScopes(index, sourceRegistry) {
  const seen = new Set();
  for (const sourceScope of ["all", "local", "windows"]) {
    const options = optionsFromQuery(new URLSearchParams({ sourceScope }), { sourceRegistry });
    const key = options.sessionsDirs.slice().sort().join("\n");
    if (seen.has(key) || !(await anyDirectoryExists(options.sessionsDirs))) continue;
    prewarmCanonicalScope(index, options.sessionsDirs);
    seen.add(key);
  }
}

async function anyDirectoryExists(dirs) {
  for (const dir of dirs) {
    try {
      if ((await stat(dir)).isDirectory()) return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return false;
}

function defaultDashboardSearchParams() {
  return new URLSearchParams({
    sourceScope: "all",
    range: "7d",
    group: "day",
    sort: "key",
    desc: "1",
    limit: "60",
    dedupeScope: "global",
  });
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === __filename;
}

if (isMainModule()) {
  startDashboard().catch((error) => {
    console.error(`codex-usage-server: ${error.message}`);
    process.exitCode = 1;
  });
}
