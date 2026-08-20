const MILLION = 1_000_000;

export const PRICING_UPDATED_AT = "2026-08-20";
export const PRICING_CURRENCY = "USD";
export const PRICING_BASIS = "OpenAI API standard text-token pricing per 1M tokens";
export const LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;
export const PRICING_SOURCE_URLS = [
  "https://developers.openai.com/api/docs/pricing/",
  "https://developers.openai.com/api/docs/models/gpt-5.6-sol/",
  "https://developers.openai.com/api/docs/models/gpt-5.6-terra/",
  "https://developers.openai.com/api/docs/models/gpt-5.6-luna/",
  "https://developers.openai.com/api/docs/models/gpt-5.5/",
  "https://developers.openai.com/api/docs/models/gpt-5.4/",
  "https://developers.openai.com/api/docs/models/gpt-5.4-mini/",
  "https://developers.openai.com/api/docs/models/gpt-5.3-codex/",
  "https://developers.openai.com/api/docs/models/gpt-5.2-codex/",
  "https://developers.openai.com/api/docs/models/gpt-5-codex/",
  "https://developers.openai.com/api/docs/models/gpt-5.1/",
  "https://developers.openai.com/api/docs/models/gpt-5.1-codex/",
  "https://developers.openai.com/api/docs/models/gpt-5.1-codex-max/",
  "https://developers.openai.com/api/docs/models/gpt-5.1-codex-mini/",
  "https://developers.openai.com/api/docs/models/gpt-4o/",
  "https://developers.openai.com/api/docs/models/gpt-4o-mini/",
];

const MODEL_PRICES = new Map(
  [
    ["gpt-5.6", { input: 5, cachedInput: 0.5, output: 30, longContext: { input: 10, cachedInput: 1, output: 45 } }],
    ["gpt-5.6-sol", { input: 5, cachedInput: 0.5, output: 30, longContext: { input: 10, cachedInput: 1, output: 45 } }],
    ["gpt-5.6-terra", { input: 2, cachedInput: 0.2, output: 12, longContext: { input: 4, cachedInput: 0.4, output: 18 } }],
    ["gpt-5.6-luna", { input: 0.2, cachedInput: 0.02, output: 1.2, longContext: { input: 0.4, cachedInput: 0.04, output: 1.8 } }],
    ["gpt-5.5", { input: 5, cachedInput: 0.5, output: 30, longContext: { input: 10, cachedInput: 1, output: 45 } }],
    ["gpt-5.4", { input: 2.5, cachedInput: 0.25, output: 15, longContext: { input: 5, cachedInput: 0.5, output: 22.5 } }],
    ["gpt-5.4-mini", { input: 0.75, cachedInput: 0.075, output: 4.5 }],
    ["gpt-5.2-codex", { input: 1.75, cachedInput: 0.175, output: 14 }],
    ["gpt-5.3-codex", { input: 1.75, cachedInput: 0.175, output: 14 }],
    ["gpt-5.2", { input: 1.75, cachedInput: 0.175, output: 14 }],
    ["gpt-5.3-chat-latest", { input: 1.75, cachedInput: 0.175, output: 14 }],
    ["gpt-5-codex", { input: 1.25, cachedInput: 0.125, output: 10 }],
    ["gpt-5.1-codex-max", { input: 1.25, cachedInput: 0.125, output: 10 }],
    ["gpt-5.1-codex", { input: 1.25, cachedInput: 0.125, output: 10 }],
    ["gpt-5.1", { input: 1.25, cachedInput: 0.125, output: 10 }],
    ["gpt-5", { input: 1.25, cachedInput: 0.125, output: 10 }],
    ["gpt-5-chat-latest", { input: 1.25, cachedInput: 0.125, output: 10 }],
    ["gpt-5.1-codex-mini", { input: 0.25, cachedInput: 0.025, output: 2 }],
    ["gpt-5-mini", { input: 0.25, cachedInput: 0.025, output: 2 }],
    ["gpt-4o", { input: 2.5, cachedInput: 1.25, output: 10 }],
    ["gpt-4o-mini", { input: 0.15, cachedInput: 0.075, output: 0.6 }],
  ].map(([model, rates]) => [model, { model, ...rates }]),
);

export function normalizeModelForPricing(model) {
  return String(model || "")
    .trim()
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+/g, "-");
}

export function priceForModel(model) {
  const normalized = normalizeModelForPricing(model);
  return MODEL_PRICES.get(normalized) || null;
}

export function estimateUsageCostUsd(model, usage) {
  const price = priceForModel(model);
  if (!price) {
    return null;
  }

  const input = positiveNumber(usage?.input_tokens);
  const cached = Math.min(input, positiveNumber(usage?.cached_input_tokens));
  const uncached = Math.max(0, input - cached);
  const output = positiveNumber(usage?.output_tokens);
  const rates = price.longContext && input > LONG_CONTEXT_THRESHOLD_TOKENS ? price.longContext : price;
  const cachedInputRate = Number.isFinite(rates.cachedInput) ? rates.cachedInput : rates.input;
  return (uncached * rates.input + cached * cachedInputRate + output * rates.output) / MILLION;
}

export function costStatsForUsage(model, usage) {
  const cost = estimateUsageCostUsd(model, usage);
  const totalTokens = positiveNumber(usage?.total_tokens) || positiveNumber(usage?.input_tokens) + positiveNumber(usage?.output_tokens);
  if (cost == null) {
    return {
      estimated_cost_usd: 0,
      priced_requests: 0,
      unpriced_requests: 1,
      priced_total_tokens: 0,
      unpriced_total_tokens: totalTokens,
    };
  }
  return {
    estimated_cost_usd: cost,
    priced_requests: 1,
    unpriced_requests: 0,
    priced_total_tokens: totalTokens,
    unpriced_total_tokens: 0,
  };
}

export function pricingMetadata() {
  return {
    currency: PRICING_CURRENCY,
    basis: PRICING_BASIS,
    updatedAt: PRICING_UPDATED_AT,
    sourceUrls: PRICING_SOURCE_URLS,
    longContextThresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
    pricedModels: Array.from(MODEL_PRICES.keys()).sort(),
  };
}

function positiveNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
