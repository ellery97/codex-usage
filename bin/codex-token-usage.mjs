#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDateBoundArgv } from "./date-bound-argv.mjs";
import { parseArgs as parseCoreArgs } from "./codex-token-usage-core.mjs";

export * from "./codex-token-usage-core.mjs";

const __filename = fileURLToPath(import.meta.url);
const CORE_PATH = fileURLToPath(new URL("./codex-token-usage-core.mjs", import.meta.url));

export function parseArgs(argv, options = {}) {
  return parseCoreArgs(normalizeDateBoundArgv(argv), options);
}

function isDirectRun() {
  return process.argv[1] && path.resolve(process.argv[1]) === __filename;
}

if (isDirectRun()) {
  const result = spawnSync(
    process.execPath,
    [CORE_PATH, ...normalizeDateBoundArgv(process.argv.slice(2))],
    { stdio: "inherit", env: process.env },
  );
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}
