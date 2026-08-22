#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDateBoundArgv } from "./usage-options.mjs";

const target = fileURLToPath(new URL("./codex-token-usage.mjs", import.meta.url));
process.argv = [process.argv[0], target, ...normalizeDateBoundArgv(process.argv.slice(2))];
await import(`./${path.basename(target)}`);
