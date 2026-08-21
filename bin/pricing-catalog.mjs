import { createHash } from "node:crypto";

const MILLION = 1_000_000;
const DEFAULT_BASIS = "OpenAI API standard text-token pricing per 1M tokens";
const DEFAULT_LABEL = "Event-time Standard API-equivalent estimate for local Codex token logs";

export function normalizeModelForPricing(model) {
  return String(model || "").trim().toLowerCase();
}

export function contentHash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function normalizePricingCatalog(input, { source = "pricing catalog" } = {}) {
  if (!input || typeof input !== "object") {
    throw new Error(`${source} must be a JSON object.`);
  }
  const catalog = Number(input.schemaVersion) === 2 ? structuredClone(input) : migrateV1(input);
  catalog.schemaVersion = 2;
  catalog.currency ||= "USD";
  catalog.basis ||= DEFAULT_BASIS;
  catalog.estimateLabel ||= DEFAULT_LABEL;
  catalog.checkedAt ||= catalog.updatedAt ? `${catalog.updatedAt}T00:00:00.000Z` : null;
  if (catalog.checkedAt != null) {
    const checkedAtMs = Date.parse(catalog.checkedAt);
    if (!Number.isFinite(checkedAtMs)) throw new Error(`${source} has an invalid checkedAt.`);
    catalog.checkedAt = new Date(checkedAtMs).toISOString();
    catalog.updatedAt = catalog.checkedAt.slice(0, 10);
  }
  catalog.aliases ||= {};
  catalog.models ||= {};
  catalog.assumedRoutes ||= {};
  catalog.assumptions = Array.isArray(catalog.assumptions) ? catalog.assumptions : [];
  catalog.sourceUrls = Array.isArray(catalog.sourceUrls) ? catalog.sourceUrls : [];

  validateAliases(catalog);
  for (const [rawModel, entry] of Object.entries(catalog.models)) {
    const model = normalizeModelForPricing(rawModel);
    if (!model || model !== rawModel || !entry || !Array.isArray(entry.versions)) {
      throw new Error(`${source} has an invalid model entry: ${rawModel}.`);
    }
    entry.sourceUrl ||= null;
    entry.versions = entry.versions.map((version, index) =>
      normalizeVersion(model, version, `${source} models.${model}.versions[${index}]`),
    );
    if (entry.versions.length === 0) {
      throw new Error(`${source} has no price versions for ${model}.`);
    }
    if (new Set(entry.versions.map((version) => version.id)).size !== entry.versions.length) {
      throw new Error(`${source} has duplicate price version IDs for ${model}.`);
    }
  }
  validateAssumedRoutes(catalog, source);
  return catalog;
}

export function mergePricingCatalogs(seedInput, runtimeInput) {
  const seed = normalizePricingCatalog(seedInput, { source: "built-in pricing catalog" });
  if (!runtimeInput) return seed;
  const runtime = normalizePricingCatalog(runtimeInput, { source: "runtime pricing cache" });
  const merged = structuredClone(seed);
  merged.checkedAt = laterIso(seed.checkedAt, runtime.checkedAt);
  merged.httpCache = { ...(seed.httpCache || {}), ...(runtime.httpCache || {}) };
  merged.sourceUrls = Array.from(new Set([...seed.sourceUrls, ...runtime.sourceUrls]));

  for (const [model, runtimeEntry] of Object.entries(runtime.models)) {
    const target = (merged.models[model] ||= { sourceUrl: runtimeEntry.sourceUrl || null, versions: [] });
    target.sourceUrl = runtimeEntry.sourceUrl || target.sourceUrl;
    const byId = new Map(target.versions.map((version) => [version.id, version]));
    for (const version of runtimeEntry.versions) {
      if (byId.has(version.id)) continue;
      const runtimeVersion = structuredClone(version);
      if (
        runtimeVersion.effectiveFrom == null &&
        target.versions.some((candidate) => ratesEqual(candidate, runtimeVersion))
      ) {
        continue;
      }
      const formal = target.versions.find(
        (candidate) =>
          !candidate.provisional &&
          !candidate.supersededBy &&
          ratesEqual(candidate, runtimeVersion) &&
          Date.parse(candidate.effectiveFrom || 0) <= Date.parse(runtimeVersion.effectiveFrom || 0),
      );
      if (runtimeVersion.provisional && runtimeVersion.effectiveFrom && formal) {
        runtimeVersion.supersededBy ||= formal.id;
      }
      byId.set(version.id, runtimeVersion);
    }
    target.versions = Array.from(byId.values());
  }
  return normalizePricingCatalog(merged, { source: "merged pricing catalog" });
}

export class PricingCatalog {
  constructor(snapshot, state = {}) {
    this.replace(snapshot, state);
  }

  replace(snapshot, state = {}) {
    this.snapshot = normalizePricingCatalog(snapshot);
    this.state = {
      refreshStatus: state.refreshStatus || "cached",
      usedFallback: Boolean(state.usedFallback),
      warning: state.warning || null,
      cachePath: state.cachePath || null,
      ...state,
    };
    this.modelEntries = new Map(Object.entries(this.snapshot.models));
    this.versionIndexes = new Map(
      Object.entries(this.snapshot.models).map(([model, entry]) => [
        model,
        buildVersionIndex(entry.versions),
      ]),
    );
    this.aliases = new Map(Object.entries(this.snapshot.aliases));
    this.routes = new Map(Object.entries(this.snapshot.assumedRoutes));
  }

  priceForModel(model, timestampMs = null) {
    const requestedModel = normalizeModelForPricing(model);
    const canonical = this.aliases.get(requestedModel) || requestedModel;
    const entry = this.modelEntries.get(canonical);
    if (!entry) return null;
    const version = selectIndexedVersion(this.versionIndexes.get(canonical), timestampMs);
    if (!version) return null;
    return {
      ...version,
      requestedModel,
      model: canonical,
      sourceUrl: version.sourceUrl || entry.sourceUrl || null,
      versionId: version.id,
    };
  }

  assumedPriceForModel(model, timestampMs = null) {
    const requestedModel = normalizeModelForPricing(model);
    const route = selectRoute(this.routes.get(requestedModel), timestampMs);
    if (!route) return null;
    const price = this.priceForModel(route.model, timestampMs);
    const upperBoundPrice =
      this.priceForModel(route.upperBoundModel, timestampMs) ||
      this.priceForModel(route.upperBoundModel, null);
    if (!price || !upperBoundPrice) return null;
    return {
      requestedModel,
      assumedModel: price.model,
      upperBoundModel: upperBoundPrice.model,
      label: route.label || `${price.model} reference estimate`,
      sourceUrl: route.sourceUrl || null,
      evidenceLevel: route.evidenceLevel || "assumption",
      effectiveFrom: route.effectiveFrom,
      routeId: route.id,
      price,
      upperBoundPrice,
    };
  }

  estimateUsageCost(model, usage, timestampMs = null) {
    const price = this.priceForModel(model, timestampMs);
    if (!price) return null;
    return {
      costUsd: estimateUsageCostWithPrice(price, usage),
      model: price.model,
      versionId: price.versionId,
      effectiveFrom: price.effectiveFrom,
      provisional: Boolean(price.provisional),
      evidenceLevel: price.evidenceLevel,
    };
  }

  estimateAssumedUsageCost(model, usage, timestampMs = null) {
    const assumption = this.assumedPriceForModel(model, timestampMs);
    if (!assumption) return null;
    return {
      costUsd: estimateUsageCostWithPrice(assumption.price, usage),
      upperBoundCostUsd: estimateUsageCostWithPrice(assumption.upperBoundPrice, usage),
      assumedModel: assumption.assumedModel,
      upperBoundModel: assumption.upperBoundModel,
      label: assumption.label,
      sourceUrl: assumption.sourceUrl,
      evidenceLevel: assumption.evidenceLevel,
      effectiveFrom: assumption.effectiveFrom,
      routeId: assumption.routeId,
      priceVersionId: assumption.price.versionId,
      priceEffectiveFrom: assumption.price.effectiveFrom,
      priceProvisional: Boolean(assumption.price.provisional),
      upperBoundPriceVersionId: assumption.upperBoundPrice.versionId,
      upperBoundPriceEffectiveFrom: assumption.upperBoundPrice.effectiveFrom,
      upperBoundPriceProvisional: Boolean(assumption.upperBoundPrice.provisional),
    };
  }

  costStatsForUsage(model, usage, timestampMs = null) {
    const totalTokens =
      positiveNumber(usage?.total_tokens) ||
      positiveNumber(usage?.input_tokens) + positiveNumber(usage?.output_tokens);
    const official = this.estimateUsageCost(model, usage, timestampMs);
    if (official) {
      return {
        estimated_cost_usd: official.costUsd,
        assumed_cost_usd: 0,
        assumed_upper_bound_cost_usd: 0,
        reference_total_cost_usd: official.costUsd,
        reference_total_upper_bound_cost_usd: official.costUsd,
        priced_requests: 1,
        assumed_requests: 0,
        unpriced_requests: 0,
        priced_total_tokens: totalTokens,
        assumed_total_tokens: 0,
        unpriced_total_tokens: 0,
        provisional_priced_requests: official.provisional ? 1 : 0,
        provisional_priced_total_tokens: official.provisional ? totalTokens : 0,
        provisional_estimated_cost_usd: official.provisional ? official.costUsd : 0,
        pricingVersionId: official.versionId,
        pricingEffectiveFrom: official.effectiveFrom,
        pricingProvisional: official.provisional,
      };
    }

    const assumed = this.estimateAssumedUsageCost(model, usage, timestampMs);
    if (assumed) {
      return {
        estimated_cost_usd: 0,
        assumed_cost_usd: assumed.costUsd,
        assumed_upper_bound_cost_usd: assumed.upperBoundCostUsd,
        reference_total_cost_usd: assumed.costUsd,
        reference_total_upper_bound_cost_usd: assumed.upperBoundCostUsd,
        priced_requests: 0,
        assumed_requests: 1,
        unpriced_requests: 0,
        priced_total_tokens: 0,
        assumed_total_tokens: totalTokens,
        unpriced_total_tokens: 0,
        provisional_priced_requests: 0,
        provisional_priced_total_tokens: 0,
        provisional_estimated_cost_usd: 0,
        assumedRoute: assumed,
      };
    }

    return {
      estimated_cost_usd: 0,
      assumed_cost_usd: 0,
      assumed_upper_bound_cost_usd: 0,
      reference_total_cost_usd: 0,
      reference_total_upper_bound_cost_usd: 0,
      priced_requests: 0,
      assumed_requests: 0,
      unpriced_requests: 1,
      priced_total_tokens: 0,
      assumed_total_tokens: 0,
      unpriced_total_tokens: totalTokens,
      provisional_priced_requests: 0,
      provisional_priced_total_tokens: 0,
      provisional_estimated_cost_usd: 0,
    };
  }

  metadata() {
    const activeVersions = Object.values(this.snapshot.models).flatMap((entry) =>
      entry.versions.filter((version) => !version.supersededBy),
    );
    const effectiveDates = activeVersions
      .map((version) => version.effectiveFrom)
      .filter(Boolean)
      .sort();
    const longContextThresholds = Array.from(
      new Set(
        activeVersions
          .map((version) => version.longContextThresholdTokens)
          .filter((value) => Number.isFinite(Number(value))),
      ),
    );
    return {
      mode: "event-time",
      currency: this.snapshot.currency,
      basis: this.snapshot.basis,
      estimateLabel: this.snapshot.estimateLabel,
      checkedAt: this.snapshot.checkedAt,
      updatedAt: this.snapshot.checkedAt ? this.snapshot.checkedAt.slice(0, 10) : "unknown",
      latestEffectiveFrom: effectiveDates.at(-1) || null,
      sourceUrls: this.snapshot.sourceUrls,
      assumptions: this.snapshot.assumptions,
      longContextThresholdTokens:
        longContextThresholds.length === 1 ? Number(longContextThresholds[0]) : null,
      refreshStatus: this.state.refreshStatus,
      usedFallback: Boolean(this.state.usedFallback),
      warning: this.state.warning || null,
      provisionalVersionCount: activeVersions.filter((version) => version.provisional).length,
      pricedModels: Array.from(new Set([...this.modelEntries.keys(), ...this.aliases.keys()])).sort(),
      assumedModels: Array.from(this.routes.entries())
        .map(([model, sourceRoutes]) => {
          const routes = structuredClone(sourceRoutes).sort((left, right) =>
            String(left.effectiveFrom || "").localeCompare(String(right.effectiveFrom || "")),
          );
          const current = routes.at(-1) || {};
          return {
            model,
            assumedModel: current.model || null,
            upperBoundModel: current.upperBoundModel || null,
            label: current.label || null,
            sourceUrl: current.sourceUrl || null,
            routes,
          };
        })
        .sort((a, b) => a.model.localeCompare(b.model)),
    };
  }
}

export function selectVersion(versions, timestampMs) {
  return selectIndexedVersion(buildVersionIndex(versions), timestampMs);
}

function buildVersionIndex(versions) {
  let baseline = null;
  const dated = [];
  for (const version of versions || []) {
    if (version.supersededBy) continue;
    if (version.effectiveFrom == null) {
      baseline = preferVersion(baseline, version);
      continue;
    }
    dated.push({ effectiveMs: Date.parse(version.effectiveFrom), version });
  }
  dated.sort((left, right) => left.effectiveMs - right.effectiveMs);
  return { baseline, dated };
}

function selectIndexedVersion(index, timestampMs) {
  if (!index) return null;
  const at = normalizeTimestamp(timestampMs);
  let low = 0;
  let high = index.dated.length - 1;
  let selected = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const candidate = index.dated[middle];
    if (candidate.effectiveMs <= at) {
      selected = candidate.version;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return selected || index.baseline;
}

export function selectRoute(routes, timestampMs) {
  if (!Array.isArray(routes)) return null;
  const at = normalizeTimestamp(timestampMs);
  let selected = null;
  for (const route of routes) {
    const effectiveMs = route.effectiveFrom == null ? Number.NEGATIVE_INFINITY : Date.parse(route.effectiveFrom);
    if (effectiveMs <= at && (!selected || effectiveMs > routeStartMs(selected))) selected = route;
  }
  return selected;
}

export function ratesEqual(left, right) {
  const fields = ["input", "cachedInput", "cacheWrite", "output", "longContextThresholdTokens"];
  if (fields.some((field) => nullableNumber(left?.[field]) !== nullableNumber(right?.[field]))) return false;
  for (const field of ["input", "cachedInput", "cacheWrite", "output"]) {
    if (nullableNumber(left?.longContext?.[field]) !== nullableNumber(right?.longContext?.[field])) return false;
  }
  return true;
}

export function estimateUsageCostWithPrice(price, usage) {
  const input = positiveNumber(usage?.input_tokens);
  const cached = Math.min(input, positiveNumber(usage?.cached_input_tokens));
  const cacheWrite = Math.min(Math.max(0, input - cached), positiveNumber(usage?.cache_write_input_tokens));
  const uncached = Math.max(0, input - cached - cacheWrite);
  const output = positiveNumber(usage?.output_tokens);
  const threshold = positiveNumber(price.longContextThresholdTokens);
  const rates = price.longContext && threshold > 0 && input > threshold ? price.longContext : price;
  const cachedInputRate = Number.isFinite(rates.cachedInput) ? rates.cachedInput : rates.input;
  const cacheWriteRate = Number.isFinite(rates.cacheWrite) ? rates.cacheWrite : rates.input;
  return (
    uncached * rates.input +
    cached * cachedInputRate +
    cacheWrite * cacheWriteRate +
    output * rates.output
  ) / MILLION;
}

function migrateV1(input) {
  const sourceUrl = Array.isArray(input.sourceUrls) ? input.sourceUrls[0] || null : null;
  const observedAt = input.updatedAt ? `${input.updatedAt}T00:00:00.000Z` : null;
  const models = {};
  for (const [model, rates] of Object.entries(input.models || {})) {
    models[normalizeModelForPricing(model)] = {
      sourceUrl,
      versions: [
        {
          ...structuredClone(rates),
          id: `legacy-${normalizeModelForPricing(model)}`,
          effectiveFrom: null,
          provisional: true,
          serviceTier: "standard",
          sourceUrl,
          observedAt,
          contentHash: contentHash(JSON.stringify(rates)),
          evidenceLevel: "legacy-snapshot",
          longContextThresholdTokens: rates.longContext
            ? input.longContextThresholdTokens || null
            : null,
        },
      ],
    };
  }
  const assumedRoutes = {};
  for (const [model, assumption] of Object.entries(input.assumedAliases || {})) {
    assumedRoutes[normalizeModelForPricing(model)] = [
      {
        id: `legacy-${normalizeModelForPricing(model)}`,
        effectiveFrom: null,
        model: normalizeModelForPricing(assumption.model),
        upperBoundModel: normalizeModelForPricing(assumption.upperBoundModel),
        label: assumption.label || null,
        sourceUrl: assumption.sourceUrl || null,
        evidenceLevel: "legacy-assumption",
      },
    ];
  }
  return {
    ...structuredClone(input),
    schemaVersion: 2,
    checkedAt: observedAt,
    models,
    assumedRoutes,
  };
}

function normalizeVersion(model, version, label) {
  if (!version || typeof version !== "object") throw new Error(`${label} must be an object.`);
  const normalized = structuredClone(version);
  normalized.id ||= contentHash(`${model}:${JSON.stringify(normalized)}`).slice(0, 20);
  normalized.effectiveFrom = normalizeEffectiveFrom(normalized.effectiveFrom, label);
  normalized.provisional = Boolean(normalized.provisional);
  normalized.serviceTier ||= "standard";
  if (normalized.serviceTier !== "standard") throw new Error(`${label} is not Standard service tier.`);
  for (const field of ["input", "output"]) {
    if (!isPositiveRate(normalized[field])) throw new Error(`${label} has invalid ${field} rate.`);
    normalized[field] = Number(normalized[field]);
  }
  for (const field of ["cachedInput", "cacheWrite"]) {
    if (normalized[field] != null && !isPositiveRate(normalized[field])) {
      throw new Error(`${label} has invalid ${field} rate.`);
    }
    if (normalized[field] != null) normalized[field] = Number(normalized[field]);
  }
  if (normalized.longContext) {
    if (!isPositiveRate(normalized.longContext.input) || !isPositiveRate(normalized.longContext.output)) {
      throw new Error(`${label} has invalid long-context rates.`);
    }
    if (!isPositiveRate(normalized.longContextThresholdTokens)) {
      throw new Error(`${label} is missing longContextThresholdTokens.`);
    }
    normalized.longContextThresholdTokens = Number(normalized.longContextThresholdTokens);
    for (const field of ["input", "cachedInput", "cacheWrite", "output"]) {
      if (normalized.longContext[field] != null && !isPositiveRate(normalized.longContext[field])) {
        throw new Error(`${label} has invalid long-context ${field} rate.`);
      }
      if (normalized.longContext[field] != null) {
        normalized.longContext[field] = Number(normalized.longContext[field]);
      }
    }
  }
  normalized.sourceUrl ||= null;
  normalized.observedAt ||= null;
  normalized.contentHash ||= contentHash(JSON.stringify(rateFingerprint(normalized)));
  normalized.evidenceLevel ||= normalized.provisional ? "provisional" : "official";
  return normalized;
}

function validateAliases(catalog) {
  for (const [alias, target] of Object.entries(catalog.aliases)) {
    if (normalizeModelForPricing(alias) !== alias || normalizeModelForPricing(target) !== target) {
      throw new Error(`Invalid pricing alias: ${alias} -> ${target}.`);
    }
    if (!catalog.models[target]) throw new Error(`Pricing alias ${alias} targets unknown model ${target}.`);
  }
}

function validateAssumedRoutes(catalog, source) {
  for (const [model, routes] of Object.entries(catalog.assumedRoutes)) {
    if (normalizeModelForPricing(model) !== model) {
      throw new Error(`${source} has an invalid assumed-route model: ${model}.`);
    }
    if (!Array.isArray(routes)) throw new Error(`${source} has invalid assumed routes for ${model}.`);
    for (const [index, route] of routes.entries()) {
      route.id ||= `${model}-${index}`;
      route.effectiveFrom = normalizeEffectiveFrom(route.effectiveFrom, `${source} assumed route ${model}`);
      route.model = normalizeModelForPricing(route.model);
      route.upperBoundModel = normalizeModelForPricing(route.upperBoundModel);
      for (const field of ["model", "upperBoundModel"]) {
        const target = catalog.aliases[route[field]] || route[field];
        if (!target || !catalog.models[target]) {
          throw new Error(`${source} assumed route ${model} has unknown ${field}: ${route[field] || "(missing)"}.`);
        }
      }
      route.evidenceLevel ||= "assumption";
    }
  }
}

function normalizeEffectiveFrom(value, label) {
  if (value == null || value === "") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} has invalid effectiveFrom.`);
  return new Date(parsed).toISOString();
}

function normalizeTimestamp(value) {
  if (value == null || value === "") return Number.POSITIVE_INFINITY;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function preferVersion(left, right) {
  if (!left) return right;
  const leftObserved = Date.parse(left.observedAt || 0) || 0;
  const rightObserved = Date.parse(right.observedAt || 0) || 0;
  return rightObserved >= leftObserved ? right : left;
}

function routeStartMs(route) {
  return route.effectiveFrom == null ? Number.NEGATIVE_INFINITY : Date.parse(route.effectiveFrom);
}

function rateFingerprint(version) {
  return Object.fromEntries(
    ["input", "cachedInput", "cacheWrite", "output", "longContextThresholdTokens", "longContext"]
      .filter((field) => version[field] != null)
      .map((field) => [field, version[field]]),
  );
}

function isPositiveRate(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function nullableNumber(value) {
  return value == null ? null : Number(value);
}

function positiveNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function laterIso(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}
