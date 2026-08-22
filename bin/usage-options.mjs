import { parseArgs as parseLegacyArgs, startOfDayInTimezone } from "./codex-token-usage.mjs";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const FROM_FLAGS = new Set(["--from", "--since"]);
const TO_FLAGS = new Set(["--to", "--until"]);

export function parseArgs(argv, options = {}) {
  return parseLegacyArgs(normalizeDateBoundArgv(argv), options);
}

export function normalizeDateBoundArgv(argv) {
  const args = Array.from(argv || [], String);
  const timezone = selectedTimezone(args);
  validateTimezone(timezone);

  const normalized = args.slice();
  for (let index = 0; index < normalized.length; index += 1) {
    const flag = normalized[index];
    if (!FROM_FLAGS.has(flag) && !TO_FLAGS.has(flag)) continue;
    if (index + 1 >= normalized.length) continue;
    const value = normalized[index + 1];
    if (!DATE_ONLY.test(value)) continue;

    const dateKey = TO_FLAGS.has(flag) ? nextDateKey(value) : validatedDateKey(value);
    normalized[index + 1] = new Date(startOfDateInTimezone(dateKey, timezone)).toISOString();
    index += 1;
  }
  return normalized;
}

function selectedTimezone(argv) {
  let timezone = defaultTimezone();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--timezone" && argv[index] !== "--tz") continue;
    if (index + 1 < argv.length) timezone = argv[index + 1];
    index += 1;
  }
  return timezone;
}

function defaultTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function validateTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new Error(`Invalid timezone: ${timezone}`);
  }
}

function validatedDateKey(value) {
  const match = DATE_ONLY.exec(value);
  if (!match) throw new Error(`Invalid date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date: ${value}`);
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function nextDateKey(value) {
  const dateKey = validatedDateKey(value);
  const [year, month, day] = dateKey.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  probe.setUTCDate(probe.getUTCDate() + 1);
  return [
    String(probe.getUTCFullYear()).padStart(4, "0"),
    String(probe.getUTCMonth() + 1).padStart(2, "0"),
    String(probe.getUTCDate()).padStart(2, "0"),
  ].join("-");
}
