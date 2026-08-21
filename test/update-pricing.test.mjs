import assert from "node:assert/strict";
import test from "node:test";
import { main, parseUpdateArgs } from "../bin/update-pricing.mjs";

test("parses runtime refresh and check modes", () => {
  assert.deepEqual(parseUpdateArgs([]), {
    check: false,
    seed: false,
    models: [],
    effectiveFrom: null,
    sourceUrl: null,
    help: false,
  });
  assert.deepEqual(parseUpdateArgs(["--check", "--model", "gpt-5.6-sol"]), {
    check: true,
    seed: false,
    models: ["gpt-5.6-sol"],
    effectiveFrom: null,
    sourceUrl: null,
    help: false,
  });
});

test("requires model, date, and source for a manual seed", () => {
  assert.throws(() => parseUpdateArgs(["--seed"]), /exactly one --model/);
  assert.throws(
    () => parseUpdateArgs(["--seed", "--model", "gpt-5.6-sol"]),
    /--effective-from/,
  );
  assert.throws(
    () =>
      parseUpdateArgs([
        "--seed",
        "--model",
        "gpt-5.6-sol",
        "--effective-from",
        "2026-07-09",
      ]),
    /--source-url/,
  );
});

test("accepts a complete manual seed command", () => {
  const parsed = parseUpdateArgs([
    "--seed",
    "--check",
    "--model",
    "gpt-5.6-sol",
    "--effective-from",
    "2026-07-09",
    "--source-url",
    "https://openai.com/index/gpt-5-6/",
  ]);
  assert.equal(parsed.seed, true);
  assert.equal(parsed.check, true);
  assert.equal(parsed.models[0], "gpt-5.6-sol");
});

test("prints help without attempting a pricing request", async () => {
  let fetched = false;
  let output = "";
  const originalLog = console.log;
  console.log = (value) => {
    output += String(value);
  };
  try {
    await main(["--help"], {
      fetchImpl: async () => {
        fetched = true;
        throw new Error("help must not fetch");
      },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(fetched, false);
  assert.match(output, /Usage:/);
});
