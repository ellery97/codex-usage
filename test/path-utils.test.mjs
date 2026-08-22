import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseArgs } from "../bin/codex-token-usage.mjs";
import { splitPathList, sqlPathFilter } from "../bin/path-utils.mjs";

test("splitPathList preserves Windows drive-letter colons", () => {
  assert.deepEqual(
    splitPathList(String.raw`C:\Users\Alice\.codex\sessions;D:\Codex\sessions`, ";"),
    [String.raw`C:\Users\Alice\.codex\sessions`, String.raw`D:\Codex\sessions`],
  );
});

test("splitPathList supports POSIX path lists", () => {
  assert.deepEqual(splitPathList("/home/alice/.codex/sessions:/srv/codex/sessions", ":"), [
    "/home/alice/.codex/sessions",
    "/srv/codex/sessions",
  ]);
});

test("CODEX_USAGE_SESSIONS uses the native platform path-list delimiter", () => {
  const previous = process.env.CODEX_USAGE_SESSIONS;
  const roots =
    process.platform === "win32"
      ? [String.raw`C:\Codex\sessions`, String.raw`D:\Codex\sessions`]
      : ["/tmp/codex-a/sessions", "/tmp/codex-b/sessions"];
  process.env.CODEX_USAGE_SESSIONS = roots.join(path.delimiter);
  try {
    const options = parseArgs([]);
    assert.deepEqual(options.sessionsDirs, roots.map((root) => path.resolve(root)));
  } finally {
    if (previous == null) delete process.env.CODEX_USAGE_SESSIONS;
    else process.env.CODEX_USAGE_SESSIONS = previous;
  }
});

test("--codex-home participates in native Windows default discovery", async (t) => {
  if (process.platform !== "win32") return;

  const directory = await mkdtemp(path.join(tmpdir(), "codex-custom-home-test-"));
  const sessionsDir = path.join(directory, "sessions");
  const archivedDir = path.join(directory, "archived_sessions");
  await mkdir(sessionsDir);
  await mkdir(archivedDir);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const envKeys = [
    "CODEX_HOME",
    "CODEX_USAGE_SESSIONS",
    "CODEX_USAGE_WINDOWS_ROOT",
    "CODEX_USAGE_WSL_DISTROS",
  ];
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.CODEX_USAGE_WINDOWS_ROOT = path.join(directory, "windows-users");
  process.env.CODEX_USAGE_WSL_DISTROS = "CodexUsageMissingDistro";
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_USAGE_SESSIONS;
  t.after(() => {
    for (const [key, value] of previousEnv) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const options = parseArgs(["--codex-home", directory]);
  assert.ok(options.sessionsDirs.includes(path.resolve(sessionsDir)));
  assert.ok(options.sessionsDirs.includes(path.resolve(archivedDir)));
});

test("sqlPathFilter keeps the Windows descendant wildcard active", () => {
  const root = String.raw`C:\Users\Windows11\.codex\sessions`;
  const child = String.raw`C:\Users\Windows11\.codex\sessions\2026\08\rollout.jsonl`;
  const outside = String.raw`C:\Users\Windows11\.codex\archived_sessions\rollout.jsonl`;
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE files (path TEXT PRIMARY KEY)");
    const insert = db.prepare("INSERT INTO files (path) VALUES (?)");
    insert.run(root);
    insert.run(child);
    insert.run(outside);

    const filter = sqlPathFilter("path", [root], "\\");
    assert.equal(filter.params[1].slice(-3), "\\\\%");
    const matches = db
      .prepare(`SELECT path FROM files WHERE ${filter.sql} ORDER BY path`)
      .all(...filter.params)
      .map((row) => row.path);
    assert.deepEqual(matches.sort(), [root, child].sort());
  } finally {
    db.close();
  }
});

test("sqlPathFilter escapes LIKE metacharacters in directory names", () => {
  const root = String.raw`C:\Users\50%_done\sessions`;
  const child = String.raw`C:\Users\50%_done\sessions\rollout.jsonl`;
  const lookalike = String.raw`C:\Users\50XXdone\sessions\rollout.jsonl`;
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE files (path TEXT PRIMARY KEY)");
    const insert = db.prepare("INSERT INTO files (path) VALUES (?)");
    insert.run(child);
    insert.run(lookalike);

    const filter = sqlPathFilter("path", [root], "\\");
    const matches = db
      .prepare(`SELECT path FROM files WHERE ${filter.sql}`)
      .all(...filter.params)
      .map((row) => row.path);
    assert.deepEqual(matches, [child]);
  } finally {
    db.close();
  }
});
