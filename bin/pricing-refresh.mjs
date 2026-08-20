import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  contentHash,
  mergePricingCatalogs,
  normalizeModelForPricing,
  normalizePricingCatalog,
  ratesEqual,
  selectVersion,
} from "./pricing-catalog.mjs";

export const OFFICIAL_MODEL_MARKDOWN_BASE = "https://developers.openai.com/api/docs/models/";
export const DEFAULT_PRICING_TIMEOUT_MS = 8000;
export const DEFAULT_PRICING_CONCURRENCY = 6;
const LOCK_STALE_MS = 30_000;

export function modelPricingUrl(model) {
  const normalized = normalizeModelForPricing(model);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new Error(`Invalid model ID for pricing refresh: ${model}.`);
  }
  return `${OFFICIAL_MODEL_MARKDOWN_BASE}${encodeURIComponent(normalized)}.md`;
}

export function parseModelPricingMarkdown(markdown, expectedModel) {
  const model = normalizeModelForPricing(expectedModel);
  const modelId = readModelId(markdown);
  if (!modelId) throw new Error("Model page does not contain a Model ID.");
  if (modelId.trim() !== model) {
    throw new Error(`Model ID mismatch: expected ${model}, received ${modelId}.`);
  }

  const pricing = markdownSection(markdown, 2, "Pricing");
  if (!pricing) throw new Error("Model page does not contain a Pricing section.");
  const textTokens = markdownSection(pricing, 3, "Text tokens");
  if (!textTokens) throw new Error("Model page does not contain Pricing / Text tokens.");

  const rows = readTokenPriceRows(textTokens);
  const input = rows.get("input");
  const output = rows.get("output");
  if (!isPositiveRate(input) || !isPositiveRate(output)) {
    throw new Error("Text-token pricing is missing positive Input or Output rates.");
  }
  const rates = { input, output };
  const cachedInput = rows.get("cachedinput");
  if (isPositiveRate(cachedInput)) rates.cachedInput = cachedInput;
  const explicitCacheWrite = rows.get("cachewrite") ?? rows.get("cachedwrite");
  const cacheWriteMultiplier = readMultiplier(textTokens, /cache\s+writes?[\s\S]{0,160}?(\d+(?:\.\d+)?)\s*[×x]/i);
  if (isPositiveRate(explicitCacheWrite)) {
    rates.cacheWrite = explicitCacheWrite;
  } else if (cacheWriteMultiplier && isPositiveRate(input * cacheWriteMultiplier)) {
    rates.cacheWrite = multiplyRate(input, cacheWriteMultiplier);
  }

  const threshold = readLongContextThreshold(textTokens);
  const longContextMultipliers = readLongContextMultipliers(textTokens);
  const inputMultiplier = longContextMultipliers.input;
  const outputMultiplier = longContextMultipliers.output;
  if (threshold && inputMultiplier && outputMultiplier) {
    rates.longContextThresholdTokens = threshold;
    rates.longContext = {
      input: multiplyRate(rates.input, inputMultiplier),
      output: multiplyRate(rates.output, outputMultiplier),
    };
    if (rates.cachedInput != null) {
      rates.longContext.cachedInput = multiplyRate(rates.cachedInput, inputMultiplier);
    }
    if (rates.cacheWrite != null) {
      rates.longContext.cacheWrite = multiplyRate(rates.cacheWrite, inputMultiplier);
    }
  }

  return {
    ...rates,
    model,
    serviceTier: "standard",
    sourceUrl: modelPricingUrl(model),
    contentHash: contentHash(markdown),
    evidenceLevel: "official-model-page",
  };
}

export async function readRuntimePricingCache(cachePath, { preserveCorrupt = true } = {}) {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8"));
    return {
      snapshot: normalizePricingCatalog(parsed, { source: `pricing cache ${cachePath}` }),
      corruptBackupPath: null,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { snapshot: null, corruptBackupPath: null };
    let corruptBackupPath = null;
    if (preserveCorrupt) {
      corruptBackupPath = `${cachePath}.corrupt-${Date.now()}`;
      try {
        const cacheStat = await stat(cachePath);
        if (!cacheStat.isFile()) throw new Error("Pricing cache path is not a file.");
        await rename(cachePath, corruptBackupPath);
      } catch {
        corruptBackupPath = null;
      }
    }
    return { snapshot: null, corruptBackupPath, error };
  }
}

export async function writeRuntimePricingCache(cachePath, snapshot, { lockTimeoutMs = 2000 } = {}) {
  const normalized = normalizePricingCatalog(snapshot);
  await mkdir(path.dirname(cachePath), { recursive: true });
  return withCacheLock(cachePath, lockTimeoutMs, async () => {
    let snapshotToWrite = normalized;
    try {
      const current = JSON.parse(await readFile(cachePath, "utf8"));
      snapshotToWrite = mergePricingCatalogs(normalized, current);
      snapshotToWrite.httpCache = mergeHttpCacheByValidationTime(
        current.httpCache,
        normalized.httpCache,
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const tempPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(snapshotToWrite, null, 2)}\n`, { mode: 0o600 });
      await rename(tempPath, cachePath);
      return snapshotToWrite;
    } finally {
      await unlink(tempPath).catch(() => {});
    }
  });
}

export async function refreshPricingSnapshot(snapshotInput, {
  models = [],
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_PRICING_TIMEOUT_MS,
  concurrency = DEFAULT_PRICING_CONCURRENCY,
  force = false,
  includeCatalogModels = true,
  now = new Date(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Pricing refresh requires fetch().");
  const snapshot = normalizePricingCatalog(snapshotInput);
  const requestedModels = new Set(
    [
      ...(includeCatalogModels ? Object.keys(snapshot.models) : []),
      ...Array.from(models, normalizeModelForPricing),
    ].map((model) => snapshot.aliases[model] || model),
  );
  for (const assumedModel of Object.keys(snapshot.assumedRoutes)) requestedModels.delete(assumedModel);
  requestedModels.delete("");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Pricing refresh timed out.")), timeoutMs);
  const successes = [];
  const failures = [];
  const changes = [];
  try {
    const workerCount = Math.min(
      DEFAULT_PRICING_CONCURRENCY,
      Math.max(1, Number(concurrency) || DEFAULT_PRICING_CONCURRENCY),
    );
    await mapLimit(Array.from(requestedModels).sort(), workerCount, async (model) => {
      let url;
      try {
        url = modelPricingUrl(model);
      } catch (error) {
        failures.push({ model, error: error.message });
        return;
      }
      const conditional = snapshot.httpCache?.[model] || {};
      const headers = { accept: "text/markdown" };
      if (!force && conditional.etag) headers["if-none-match"] = conditional.etag;
      if (!force && conditional.lastModified) headers["if-modified-since"] = conditional.lastModified;

      try {
        const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: "error" });
        if (response.status === 304) {
          if (!snapshot.models[model]) throw new Error("Received 304 without a cached model entry.");
          snapshot.httpCache ||= {};
          snapshot.httpCache[model] = {
            etag: response.headers.get("etag") || conditional.etag || null,
            lastModified: response.headers.get("last-modified") || conditional.lastModified || null,
            validatedAt: now.toISOString(),
            sourceUrl: url,
          };
          successes.push({ model, status: 304 });
          return;
        }
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
        if (new URL(response.url || url).origin !== "https://developers.openai.com") {
          throw new Error("Official model page redirected outside developers.openai.com.");
        }
        const markdown = await response.text();
        const parsed = parseModelPricingMarkdown(markdown, model);
        const change = applyObservedVersion(snapshot, model, parsed, now);
        snapshot.httpCache ||= {};
        snapshot.httpCache[model] = {
          etag: response.headers.get("etag") || conditional.etag || null,
          lastModified: response.headers.get("last-modified") || conditional.lastModified || null,
          validatedAt: now.toISOString(),
          sourceUrl: url,
        };
        if (change) changes.push(change);
        successes.push({ model, status: response.status });
      } catch (error) {
        failures.push({ model, error: error?.message || String(error) });
      }
    });
  } finally {
    clearTimeout(timeout);
  }

  if (successes.length > 0) {
    snapshot.checkedAt = now.toISOString();
    snapshot.updatedAt = now.toISOString().slice(0, 10);
  }
  const refreshStatus = failures.length === 0 ? "fresh" : successes.length > 0 ? "partial" : "cached";
  return {
    snapshot,
    changes,
    successes,
    failures,
    refreshStatus,
    usedFallback: failures.length > 0,
    warning:
      failures.length > 0
        ? `Pricing refresh failed for ${failures.length} model${failures.length === 1 ? "" : "s"}; cached versions were kept.`
        : null,
  };
}

export function applyObservedVersion(snapshotInput, modelInput, parsed, now = new Date()) {
  const snapshot = snapshotInput;
  const model = normalizeModelForPricing(modelInput);
  const entry = (snapshot.models[model] ||= { sourceUrl: parsed.sourceUrl || modelPricingUrl(model), versions: [] });
  const latest = selectVersion(entry.versions, Number.POSITIVE_INFINITY);
  if (latest && ratesEqual(latest, parsed)) return null;
  const observedAt = now.toISOString();
  const version = {
    ...rateFields(parsed),
    id: `${model}-observed-${compactTimestamp(observedAt)}-${parsed.contentHash.slice(0, 8)}`,
    effectiveFrom: observedAt,
    provisional: true,
    serviceTier: "standard",
    sourceUrl: parsed.sourceUrl || modelPricingUrl(model),
    observedAt,
    contentHash: parsed.contentHash,
    evidenceLevel: "official-model-page-first-observed",
  };
  entry.sourceUrl = version.sourceUrl;
  entry.versions.push(version);
  return { model, previous: latest ? rateFields(latest) : null, current: rateFields(version), version };
}

export function applyVerifiedSeedVersion(snapshotInput, {
  model: modelInput,
  parsed,
  effectiveFrom,
  sourceUrl,
  observedAt = new Date().toISOString(),
} = {}) {
  if (!effectiveFrom) throw new Error("--effective-from is required when seeding a price version.");
  if (!sourceUrl) throw new Error("--source-url is required when seeding a price version.");
  const parsedDate = Date.parse(`${effectiveFrom}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) || !Number.isFinite(parsedDate)) {
    throw new Error("--effective-from must be YYYY-MM-DD.");
  }
  const source = new URL(sourceUrl);
  if (source.protocol !== "https:" || !isOfficialOpenAiHost(source.hostname)) {
    throw new Error("--source-url must be an official OpenAI HTTPS URL.");
  }
  const snapshot = normalizePricingCatalog(snapshotInput);
  const model = normalizeModelForPricing(modelInput);
  if (!model || parsed.model !== model) throw new Error(`Parsed model does not match --model ${model}.`);
  const effectiveIso = new Date(parsedDate).toISOString();
  const entry = (snapshot.models[model] ||= { sourceUrl: modelPricingUrl(model), versions: [] });
  const existing = entry.versions.find(
    (version) => version.effectiveFrom === effectiveIso && ratesEqual(version, parsed) && !version.supersededBy,
  );
  if (existing && !existing.provisional) return { snapshot, version: existing, changed: false };
  const baseId = `${model}-${effectiveFrom}`;
  const id = entry.versions.some((candidate) => candidate.id === baseId)
    ? `${baseId}-${parsed.contentHash.slice(0, 8)}`
    : baseId;
  const version = {
    ...rateFields(parsed),
    id,
    effectiveFrom: effectiveIso,
    provisional: false,
    serviceTier: "standard",
    sourceUrl,
    observedAt,
    contentHash: parsed.contentHash,
    evidenceLevel: "manually-verified-official",
  };
  for (const old of entry.versions) {
    if (
      (old.provisional && old.effectiveFrom && ratesEqual(old, version)) ||
      (old.effectiveFrom === effectiveIso && !ratesEqual(old, version))
    ) {
      old.supersededBy = id;
    }
  }
  entry.versions.push(version);
  snapshot.checkedAt = observedAt;
  snapshot.updatedAt = observedAt.slice(0, 10);
  return { snapshot: normalizePricingCatalog(snapshot), version, changed: true };
}

async function withCacheLock(cachePath, timeoutMs, callback) {
  const lockPath = `${cachePath}.lock`;
  const deadline = Date.now() + Math.max(100, timeoutMs);
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError.code === "ENOENT") continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for pricing cache lock: ${lockPath}`);
      await delay(50);
    }
  }
  try {
    await handle.writeFile(`${process.pid}\n`);
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

function readModelId(markdown) {
  const patterns = [
    /(?:^|\n)\s*(?:\*\*)?Model ID(?::)?(?:\*\*)?\s*:?\s*`([^`]+)`/i,
    /\|\s*(?:\*\*)?Model ID(?:\*\*)?\s*\|\s*`?([a-z0-9][a-z0-9._-]*)`?\s*\|/i,
    /(?:^|\n)\s*Model ID\s*\n\s*`([a-z0-9][a-z0-9._-]*)`/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(markdown);
    if (match) return match[1].trim();
  }
  return null;
}

function markdownSection(markdown, level, title) {
  const marker = "#".repeat(level);
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = new RegExp(`^${marker}\\s+${escaped}\\s*$`, "im").exec(markdown);
  if (!start) return null;
  const bodyStart = start.index + start[0].length;
  const next = new RegExp(`^#{1,${level}}\\s+`, "m").exec(markdown.slice(bodyStart));
  return markdown.slice(bodyStart, next ? bodyStart + next.index : markdown.length);
}

function readTokenPriceRows(section) {
  const rows = new Map();
  for (const line of section.split(/\r?\n/)) {
    if (!line.includes("|")) continue;
    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (cells.length < 2 || cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    const key = cells[0].toLowerCase().replace(/[^a-z]/g, "");
    if (!["input", "cachedinput", "cachewrite", "cachedwrite", "output"].includes(key)) continue;
    if (!cells.some((cell) => /(?:1\s*M|1,?000,?000)\s+tokens?/i.test(cell))) continue;
    const priceCell = cells.slice(1).find((cell) => /\$\s*[0-9]/.test(cell));
    if (!priceCell) continue;
    const match = /\$\s*([0-9][0-9,]*(?:\.\d+)?)/.exec(priceCell);
    if (match) rows.set(key, Number(match[1].replaceAll(",", "")));
  }
  return rows;
}

function readLongContextThreshold(markdown) {
  const match = /(?:>|above|over)\s*([0-9][0-9,.]*)\s*([kKmM])?\s+input\s+tokens?/i.exec(markdown);
  if (!match) return null;
  const base = Number(match[1].replaceAll(",", ""));
  const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2] ? 1_000 : 1;
  return Number.isFinite(base) ? base * multiplier : null;
}

function readLongContextMultipliers(markdown) {
  const thresholdMatch = /(?:>|above|over)\s*[0-9][0-9,.]*\s*[kKmM]?\s+input\s+tokens?/i.exec(markdown);
  const text = thresholdMatch ? markdown.slice(thresholdMatch.index, thresholdMatch.index + 600) : "";
  const result = {};
  for (const pattern of [
    /(\d+(?:\.\d+)?)\s*[×x]\s*(?:for\s+)?(input|output)\b/gi,
    /\b(input|output)(?:\s+tokens?)?\s+(?:are\s+)?(?:priced\s+(?:at\s+)?)?(\d+(?:\.\d+)?)\s*[×x]/gi,
  ]) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const field = Number.isFinite(Number(match[1])) ? match[2].toLowerCase() : match[1].toLowerCase();
      const value = Number.isFinite(Number(match[1])) ? Number(match[1]) : Number(match[2]);
      if (isPositiveRate(value)) result[field] = value;
    }
  }
  return result;
}

function readMultiplier(markdown, pattern) {
  const match = pattern.exec(markdown);
  const value = match ? Number(match[1]) : null;
  return isPositiveRate(value) ? value : null;
}

function rateFields(value) {
  return Object.fromEntries(
    ["input", "cachedInput", "cacheWrite", "output", "longContextThresholdTokens", "longContext"]
      .filter((field) => value[field] != null)
      .map((field) => [field, structuredClone(value[field])]),
  );
}

function compactTimestamp(iso) {
  return iso.replace(/[-:.TZ]/g, "").slice(0, 14);
}

function isOfficialOpenAiHost(hostname) {
  return hostname === "openai.com" || hostname.endsWith(".openai.com");
}

function isPositiveRate(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function multiplyRate(value, multiplier) {
  return Number((Number(value) * Number(multiplier)).toPrecision(12));
}

function mergeHttpCacheByValidationTime(...caches) {
  const merged = {};
  for (const cache of caches) {
    for (const [model, candidate] of Object.entries(cache || {})) {
      const current = merged[model];
      const currentAt = Date.parse(current?.validatedAt || 0) || 0;
      const candidateAt = Date.parse(candidate?.validatedAt || 0) || 0;
      if (!current || candidateAt >= currentAt) merged[model] = structuredClone(candidate);
    }
  }
  return merged;
}

async function mapLimit(items, limit, mapper) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
