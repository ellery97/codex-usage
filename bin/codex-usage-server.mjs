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
  parseArgs,
} from "./codex-token-usage.mjs";
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
const RANGE_TO_LAST = new Map([
  ["24h", "24h"],
  ["7d", "7d"],
  ["30d", "30d"],
  ["12w", "12w"],
]);

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

function usageArgvFromQuery(searchParams, sourceRegistry = null) {
  const group = searchParams.get("group") || "month";
  const sort = searchParams.get("sort") || (group === "day" || group === "month" ? "key" : "total");
  const dedupeScope = searchParams.get("dedupeScope") || "global";
  const range = searchParams.get("range") || "all";
  const sourceScope = sourceScopeFromQuery(searchParams);
  const args = ["--group", GROUPS.has(group) ? group : "month", "--sort", SORTS.has(sort) ? sort : "total"];

  if (sourceRegistry) {
    for (const dir of sourceRegistry[sourceScope] || []) {
      args.push("--sessions", dir);
    }
  } else if (sourceScope === "local") {
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

export function optionsFromQuery(searchParams, { sourceRegistry = null } = {}) {
  const options = parseArgs(usageArgvFromQuery(searchParams, sourceRegistry));
  options.sourceScope = sourceScopeFromQuery(searchParams);
  options.rangeKey = searchParams.get("range") || "all";
  return options;
}

export async function runUsage(queryService, searchParams, sourceRegistry = null) {
  const options = optionsFromQuery(searchParams, { sourceRegistry });
  return queryService.query(options, {
    refreshIndex: searchParams.get("refreshIndex") !== "0",
  });
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
    createReadStream(filePath).pipe(res);
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
        const payload = await runUsage(
          dashboard.queryService,
          url.searchParams,
          dashboard.sourceRegistry,
        );
        json(res, 200, payload);
        return;
      }
      await serveStatic(req, res, url.pathname);
    } catch (error) {
      json(res, 500, { error: error.message });
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
