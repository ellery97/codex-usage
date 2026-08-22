import assert from "node:assert/strict";
import test from "node:test";

import { optionsFromQuery, refreshUsage, runUsage } from "../bin/codex-usage-server.mjs";
import { costStatsForUsage } from "../bin/openai-pricing.mjs";
import { parseArgs } from "../bin/usage-options.mjs";
import { usageEventFingerprint } from "../bin/usage-values.mjs";

const usage = {
  input_tokens: 2_000,
  cached_input_tokens: 800,
  cache_write_input_tokens: 0,
  output_tokens: 200,
  reasoning_output_tokens: 40,
  total_tokens: 2_200,
};

const sourceRegistry = {
  all: ["/tmp/codex-usage-test"],
  local: ["/tmp/codex-usage-test"],
  windows: ["/tmp/codex-usage-test"],
};

test("global event fingerprints preserve copied events but not unrelated same-token events", () => {
  const copiedA = usageEventFingerprint({
    timestampMs: Date.parse("2026-08-20T00:00:01.000Z"),
    totalUsage: usage,
    lastUsage: usage,
    fallbackIdentity: "session-a",
  });
  const copiedB = usageEventFingerprint({
    timestampMs: Date.parse("2026-08-20T00:00:01.000Z"),
    totalUsage: usage,
    lastUsage: usage,
    fallbackIdentity: "session-b",
  });
  const independent = usageEventFingerprint({
    timestampMs: Date.parse("2026-08-20T00:00:02.000Z"),
    totalUsage: usage,
    lastUsage: usage,
    fallbackIdentity: "session-b",
  });

  assert.equal(copiedA, copiedB);
  assert.notEqual(copiedA, independent);
});

test("missing-timestamp fingerprints use fallback identity", () => {
  const first = usageEventFingerprint({ totalUsage: usage, lastUsage: usage, fallbackIdentity: "session-a" });
  const second = usageEventFingerprint({ totalUsage: usage, lastUsage: usage, fallbackIdentity: "session-b" });
  assert.notEqual(first, second);
});

test("date-only bounds honor the selected timezone even when timezone appears last", () => {
  const options = parseArgs([
    "--sessions",
    "/tmp/codex-usage-test",
    "--from",
    "2026-11-01",
    "--to",
    "2026-11-01",
    "--timezone",
    "America/Los_Angeles",
  ]);

  assert.equal(new Date(options.fromMs).toISOString(), "2026-11-01T07:00:00.000Z");
  assert.equal(new Date(options.toMs).toISOString(), "2026-11-02T08:00:00.000Z");
  assert.equal(options.toMs - options.fromMs, 25 * 60 * 60 * 1000);
});

test("date-only bounds reject normalized calendar dates", () => {
  assert.throws(
    () =>
      parseArgs([
        "--sessions",
        "/tmp/codex-usage-test",
        "--from",
        "2026-02-30",
        "--timezone",
        "UTC",
      ]),
    /Invalid date: 2026-02-30/,
  );
});

test("dashboard custom dates use the requested timezone", () => {
  const options = optionsFromQuery(
    new URLSearchParams({
      range: "custom",
      from: "2026-11-01",
      to: "2026-11-01",
      timezone: "America/Los_Angeles",
    }),
    { sourceRegistry },
  );
  assert.equal(new Date(options.fromMs).toISOString(), "2026-11-01T07:00:00.000Z");
  assert.equal(new Date(options.toMs).toISOString(), "2026-11-02T08:00:00.000Z");
});

test("usage API reads are snapshot-only by default and refresh endpoint opts into writes", async () => {
  const calls = [];
  const queryService = {
    async query(_options, flags) {
      calls.push(flags);
      return { ok: true };
    },
  };

  await runUsage(queryService, new URLSearchParams(), sourceRegistry);
  await refreshUsage(queryService, new URLSearchParams(), sourceRegistry);

  assert.deepEqual(calls, [{ refreshIndex: false }, { refreshIndex: true }]);
});

test("dashboard rejects invalid enum query parameters instead of silently falling back", () => {
  assert.throws(
    () => optionsFromQuery(new URLSearchParams({ group: "bogus" }), { sourceRegistry }),
    (error) => error?.statusCode === 400 && /Invalid group/.test(error.message),
  );
});

test("events without timestamps are not priced using the latest catalog version", () => {
  const cost = costStatsForUsage("gpt-5.6-sol", usage, null);
  assert.equal(cost.priced_requests, 0);
  assert.equal(cost.assumed_requests, 0);
  assert.equal(cost.unpriced_requests, 1);
  assert.equal(cost.unpriced_total_tokens, usage.total_tokens);
  assert.equal(cost.reference_total_cost_usd, 0);
});
