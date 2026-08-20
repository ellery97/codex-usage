import assert from "node:assert/strict";
import test from "node:test";
import {
  assumedPriceForModel,
  costStatsForUsage,
  estimateAssumedUsageCostUsd,
  estimateUsageCostDetails,
  estimateUsageCostUsd,
  priceForModel,
  pricingMetadata,
} from "../bin/openai-pricing.mjs";

const JULY_9 = Date.parse("2026-07-09T00:00:00.000Z");
const JULY_30 = Date.parse("2026-07-30T00:00:00.000Z");

test("resolves only the official GPT-5.6 alias to Sol", () => {
  assert.equal(priceForModel("gpt-5.6", JULY_30).model, "gpt-5.6-sol");
  assert.equal(priceForModel("gpt-5.6 (high)", JULY_30), null);
  assert.equal(priceForModel("gpt 5.6", JULY_30), null);
  assert.equal(priceForModel("gpt-5.2", JULY_30).model, "gpt-5.2");
  assert.equal(priceForModel("gpt-5.2-codex", JULY_30).model, "gpt-5.2-codex");
  assert.equal(priceForModel("gpt-5.1-codex-max", JULY_30).model, "gpt-5.1-codex-max");
});

test("selects GPT-5.6 historical prices at the UTC boundary", () => {
  assert.equal(priceForModel("gpt-5.6-luna", JULY_9 - 1), null);
  assert.equal(
    costStatsForUsage("gpt-5.6-luna", { input_tokens: 1, total_tokens: 1 }, JULY_9 - 1)
      .unpriced_requests,
    1,
  );
  assert.equal(priceForModel("gpt-5.6-luna", JULY_9).input, 1);
  assert.equal(priceForModel("gpt-5.6-luna", JULY_30 - 1).output, 6);
  assert.equal(priceForModel("gpt-5.6-luna", JULY_30).input, 0.2);
  assert.equal(priceForModel("gpt-5.6-terra", JULY_30 - 1).input, 2.5);
  assert.equal(priceForModel("gpt-5.6-terra", JULY_30).input, 2);
  assert.equal(priceForModel("gpt-5.6-sol", JULY_30).input, 5);
});

test("prices cache reads, cache writes, ordinary input, and output separately", () => {
  const usage = {
    input_tokens: 250_000,
    cached_input_tokens: 25_000,
    cache_write_input_tokens: 50_000,
    output_tokens: 100_000,
  };
  const estimate = estimateUsageCostDetails(
    "gpt-5.6-sol",
    usage,
    JULY_30,
  );
  assert.equal(estimate.costUsd, 4.2);
  assert.equal(estimateUsageCostUsd("gpt-5.6-sol", usage, JULY_30), 4.2);
  assert.equal(estimate.versionId, "gpt-5.6-sol-2026-07-09");
  assert.equal(estimate.provisional, false);
});

test("uses version-local long-context rates above 272K input tokens", () => {
  const estimate = estimateUsageCostDetails(
    "gpt-5.6-terra",
    {
      input_tokens: 300_000,
      cached_input_tokens: 100_000,
      cache_write_input_tokens: 50_000,
      output_tokens: 100_000,
    },
    JULY_30,
  );
  assert.equal(estimate.costUsd, 2.69);
});

test("keeps codex-auto-review outside official pricing and changes its assumed route by time", () => {
  assert.equal(priceForModel("codex-auto-review", JULY_30), null);
  assert.equal(assumedPriceForModel("codex-auto-review", Date.parse("2026-04-22T23:59:59Z")), null);
  const launch = assumedPriceForModel("codex-auto-review", Date.parse("2026-04-23T00:00:00Z"));
  assert.equal(launch.assumedModel, "gpt-5.4");
  assert.equal(launch.upperBoundModel, "gpt-5.6-sol");
  assert.match(launch.label, /launch-model/);
  const current = assumedPriceForModel("codex-auto-review", JULY_30);
  assert.equal(current.assumedModel, "gpt-5.6-luna");
  assert.equal(current.evidenceLevel, "openai-community-announcement");
});

test("calculates auto-review assumptions without adding them to official cost", () => {
  const usage = {
    input_tokens: 100_000,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 10_000,
    total_tokens: 110_000,
  };
  const launchTime = Date.parse("2026-07-22T00:00:00Z");
  const launch = estimateAssumedUsageCostUsd("codex-auto-review", usage, launchTime);
  assert.equal(launch.costUsd, 0.4);
  assert.equal(launch.upperBoundCostUsd, 0.8);
  const current = estimateAssumedUsageCostUsd("codex-auto-review", usage, JULY_30);
  assert.equal(current.costUsd, 0.032);
  assert.equal(current.upperBoundCostUsd, 0.8);

  const stats = costStatsForUsage("codex-auto-review", usage, launchTime);
  assert.equal(stats.estimated_cost_usd, 0);
  assert.equal(stats.assumed_cost_usd, 0.4);
  assert.equal(stats.assumed_requests, 1);
  assert.equal(stats.unpriced_requests, 0);
  assert.equal(stats.assumedRoute.assumedModel, "gpt-5.4");
});

test("reports provisional official price usage separately", () => {
  const stats = costStatsForUsage(
    "gpt-5.4",
    { input_tokens: 100_000, output_tokens: 0, total_tokens: 100_000 },
    Date.parse("2026-05-01T00:00:00Z"),
  );
  assert.equal(stats.estimated_cost_usd, 0.25);
  assert.equal(stats.provisional_priced_requests, 1);
  assert.equal(stats.provisional_priced_total_tokens, 100_000);
  assert.equal(stats.provisional_estimated_cost_usd, 0.25);
  assert.equal(costStatsForUsage("gpt-5.6-sol", { input_tokens: 1 }, JULY_30).provisional_priced_requests, 0);
});

test("exposes event-time pricing metadata and compatibility updatedAt", () => {
  const metadata = pricingMetadata();
  assert.equal(metadata.mode, "event-time");
  assert.equal(metadata.refreshStatus, "cached");
  assert.equal(metadata.updatedAt, metadata.checkedAt.slice(0, 10));
  assert.equal(metadata.latestEffectiveFrom, "2026-07-30T00:00:00.000Z");
  assert.equal(metadata.longContextThresholdTokens, 272_000);
  assert.equal(metadata.assumedModels[0].assumedModel, "gpt-5.6-luna");
  assert.equal(metadata.assumedModels[0].routes.length, 2);
  assert.ok(metadata.provisionalVersionCount > 0);
});
