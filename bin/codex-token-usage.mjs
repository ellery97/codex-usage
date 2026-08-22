#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDateBoundArgv } from "./date-bound-argv.mjs";
import { parseArgs as parseCoreArgs } from "./codex-token-usage-core.mjs";
import {
  aggregateUsageEvents,
  buildUsagePayload as buildRuntimeUsagePayload,
  inRange as runtimeInRange,
  runCli,
} from "./usage-aggregation.mjs";

export * from "./codex-token-usage-core.mjs";
export { aggregateUsageEvents as aggregate, runtimeInRange as inRange };

const __filename = fileURLToPath(import.meta.url);

export function parseArgs(argv, options = {}) {
  return parseCoreArgs(normalizeDateBoundArgv(argv), options);
}

export async function buildUsagePayload(options) {
  return buildRuntimeUsagePayload(options);
}

function isDirectRun() {
  return process.argv[1] && path.resolve(process.argv[1]) === __filename;
}

if (isDirectRun()) {
  runCli(process.argv.slice(2), { parseArgs }).catch((error) => {
    console.error(`codex-token-usage: ${error.message}`);
    process.exitCode = 1;
  });
}
