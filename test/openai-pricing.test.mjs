import assert from "node:assert/strict";
import test from "node:test";

import {
  LONG_CONTEXT_THRESHOLD_TOKENS,
  estimateUsageCostUsd,
  priceForModel,
  pricingMetadata,
} from "../bin/openai-pricing.mjs";

const STANDARD_USAGE = {
  input_tokens: 200_000,
  cached_input_tokens: 100_000,
  output_tokens: 20_000,
};

test("prices every GPT-5.6 tier and maps the unsuffixed alias to Sol", () => {
  const { model: aliasModel, ...aliasRates } = priceForModel("gpt-5.6");
  const { model: solModel, ...solRates } = priceForModel("gpt-5.6-sol");

  assert.equal(aliasModel, "gpt-5.6");
  assert.equal(solModel, "gpt-5.6-sol");
  assert.deepEqual(aliasRates, solRates);
  assert.equal(estimateUsageCostUsd("gpt-5.6 (high)", STANDARD_USAGE), 1.15);
  assert.equal(estimateUsageCostUsd("gpt-5.6-sol", STANDARD_USAGE), 1.15);
  assert.equal(estimateUsageCostUsd("gpt-5.6-terra", STANDARD_USAGE), 0.46);
  assert.equal(estimateUsageCostUsd("gpt-5.6-luna", STANDARD_USAGE), 0.046);
});

test("applies GPT-5.6 long-context rates only above 272K input tokens", () => {
  const thresholdUsage = {
    input_tokens: LONG_CONTEXT_THRESHOLD_TOKENS,
    cached_input_tokens: 200_000,
    output_tokens: 10_000,
  };
  const longUsage = { ...thresholdUsage, input_tokens: LONG_CONTEXT_THRESHOLD_TOKENS + 1 };

  assert.equal(estimateUsageCostUsd("gpt-5.6-sol", thresholdUsage), 0.76);
  assert.equal(estimateUsageCostUsd("gpt-5.6-sol", longUsage), 1.37001);
  assert.equal(estimateUsageCostUsd("gpt-5.6-terra", longUsage), 0.548004);
  assert.equal(estimateUsageCostUsd("gpt-5.6-luna", longUsage), 0.0548004);
});

test("publishes GPT-5.6 models and refreshed pricing metadata", () => {
  const metadata = pricingMetadata();

  assert.equal(metadata.updatedAt, "2026-08-20");
  assert.equal(metadata.longContextThresholdTokens, 272_000);
  assert.ok(metadata.pricedModels.includes("gpt-5.6"));
  assert.ok(metadata.pricedModels.includes("gpt-5.6-sol"));
  assert.ok(metadata.pricedModels.includes("gpt-5.6-terra"));
  assert.ok(metadata.pricedModels.includes("gpt-5.6-luna"));
});
