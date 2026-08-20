import { assumedPriceForModel } from "./openai-pricing.mjs";

const COST_FIELDS = [
  "estimated_cost_usd",
  "assumed_cost_usd",
  "assumed_upper_bound_cost_usd",
  "reference_total_cost_usd",
  "reference_total_upper_bound_cost_usd",
  "priced_requests",
  "assumed_requests",
  "unpriced_requests",
  "priced_total_tokens",
  "assumed_total_tokens",
  "unpriced_total_tokens",
  "provisional_priced_requests",
  "provisional_priced_total_tokens",
  "provisional_estimated_cost_usd",
];

export function costZero() {
  return {
    estimated_cost_usd: 0,
    assumed_cost_usd: 0,
    assumed_upper_bound_cost_usd: 0,
    reference_total_cost_usd: 0,
    reference_total_upper_bound_cost_usd: 0,
    priced_requests: 0,
    assumed_requests: 0,
    unpriced_requests: 0,
    priced_total_tokens: 0,
    assumed_total_tokens: 0,
    unpriced_total_tokens: 0,
    provisional_priced_requests: 0,
    provisional_priced_total_tokens: 0,
    provisional_estimated_cost_usd: 0,
  };
}

export function addCostStats(target, source) {
  for (const field of COST_FIELDS) {
    target[field] += Number(source[field] || 0);
  }
  return target;
}

export function addAssumedModel(target, event, eventCost) {
  const assumption = eventCost.assumedRoute || assumedPriceForModel(event.model, event.timestampMs);
  if (!assumption) return;
  const usage = event.usage || {};
  addAssumedAggregate(target, {
    model: event.model || "(unknown model)",
    route: assumption,
    requests: 1,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    assumedCostUsd: eventCost.assumed_cost_usd,
    assumedUpperBoundCostUsd: eventCost.assumed_upper_bound_cost_usd,
    firstSeenMs: event.timestampMs,
    lastSeenMs: event.timestampMs,
  });
}

export function assumedModelsFromAggregatedRows(rows) {
  const models = new Map();
  for (const row of rows) {
    addAssumedAggregate(models, {
      model: String(row.model || "(unknown model)"),
      route: {
        routeId: nullableString(row.assumed_route_id),
        effectiveFrom: nullableString(row.assumed_effective_from),
        assumedModel: nullableString(row.assumed_model),
        upperBoundModel: nullableString(row.assumed_upper_bound_model),
        label: nullableString(row.assumed_label),
        sourceUrl: nullableString(row.assumed_source_url),
        evidenceLevel: nullableString(row.assumed_evidence_level),
      },
      requests: row.requests,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
      assumedCostUsd: row.assumed_cost_usd,
      assumedUpperBoundCostUsd: row.assumed_upper_bound_cost_usd,
      firstSeenMs: row.first_seen_ms,
      lastSeenMs: row.last_seen_ms,
    });
  }
  return assumedModelsFromMap(models);
}

export function addUnpricedModel(target, event) {
  const model = event.model || "(unknown model)";
  const usage = event.usage || {};
  const current = target.get(model) || {
    model,
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    first_seen_ms: null,
    last_seen_ms: null,
  };
  current.requests += 1;
  current.input_tokens += Number(usage.input_tokens || 0);
  current.output_tokens += Number(usage.output_tokens || 0);
  current.total_tokens += Number(usage.total_tokens || 0);
  updateTimeRange(current, event.timestampMs, event.timestampMs);
  target.set(model, current);
}

export function unpricedModelsFromMap(models) {
  return Array.from(models.values())
    .sort(compareModelUsage)
    .map((row) => ({
      model: row.model,
      requests: row.requests,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      total_tokens: row.total_tokens,
      first_seen: isoTime(row.first_seen_ms),
      last_seen: isoTime(row.last_seen_ms),
    }));
}

export function assumedModelsFromMap(models) {
  return Array.from(models.values())
    .sort(compareModelUsage)
    .map((row) => {
      const routes = Array.from(row.routes.values())
        .sort((a, b) => String(a.effectiveFrom || "").localeCompare(String(b.effectiveFrom || "")))
        .map(({ first_seen_ms, last_seen_ms, ...route }) => ({
          ...route,
          first_seen: isoTime(first_seen_ms),
          last_seen: isoTime(last_seen_ms),
        }));
      const currentRoute = routes.at(-1) || {};
      return {
        model: row.model,
        assumedModel: currentRoute.assumedModel || null,
        upperBoundModel: currentRoute.upperBoundModel || null,
        label: currentRoute.label || null,
        sourceUrl: currentRoute.sourceUrl || null,
        requests: row.requests,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        total_tokens: row.total_tokens,
        assumed_cost_usd: row.assumed_cost_usd,
        assumed_upper_bound_cost_usd: row.assumed_upper_bound_cost_usd,
        first_seen: isoTime(row.first_seen_ms),
        last_seen: isoTime(row.last_seen_ms),
        routes,
      };
    });
}

function addAssumedAggregate(target, values) {
  const current = target.get(values.model) || {
    model: values.model,
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    assumed_cost_usd: 0,
    assumed_upper_bound_cost_usd: 0,
    first_seen_ms: null,
    last_seen_ms: null,
    routes: new Map(),
  };
  addUsageAndCost(current, values);

  const routeKey =
    values.route.routeId ||
    values.route.id ||
    `${values.route.effectiveFrom || "baseline"}:${values.route.assumedModel}`;
  const route = current.routes.get(routeKey) || {
    id: routeKey,
    effectiveFrom: values.route.effectiveFrom || null,
    assumedModel: values.route.assumedModel,
    upperBoundModel: values.route.upperBoundModel,
    label: values.route.label,
    sourceUrl: values.route.sourceUrl,
    evidenceLevel: values.route.evidenceLevel || null,
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    assumed_cost_usd: 0,
    assumed_upper_bound_cost_usd: 0,
    first_seen_ms: null,
    last_seen_ms: null,
  };
  addUsageAndCost(route, values);
  current.routes.set(routeKey, route);
  target.set(values.model, current);
}

function addUsageAndCost(target, values) {
  target.requests += Number(values.requests || 0);
  target.input_tokens += Number(values.inputTokens || 0);
  target.output_tokens += Number(values.outputTokens || 0);
  target.total_tokens += Number(values.totalTokens || 0);
  target.assumed_cost_usd += Number(values.assumedCostUsd || 0);
  target.assumed_upper_bound_cost_usd += Number(values.assumedUpperBoundCostUsd || 0);
  updateTimeRange(target, values.firstSeenMs, values.lastSeenMs);
}

function updateTimeRange(target, firstSeenMs, lastSeenMs) {
  if (firstSeenMs != null) {
    const first = Number(firstSeenMs);
    target.first_seen_ms = target.first_seen_ms == null ? first : Math.min(target.first_seen_ms, first);
  }
  if (lastSeenMs != null) {
    const last = Number(lastSeenMs);
    target.last_seen_ms = target.last_seen_ms == null ? last : Math.max(target.last_seen_ms, last);
  }
}

function compareModelUsage(left, right) {
  return (
    right.total_tokens - left.total_tokens ||
    right.requests - left.requests ||
    left.model.localeCompare(right.model)
  );
}

function isoTime(timestampMs) {
  return timestampMs == null ? null : new Date(timestampMs).toISOString();
}

function nullableString(value) {
  return value == null ? null : String(value);
}
