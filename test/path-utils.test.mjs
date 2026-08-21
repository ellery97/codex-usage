import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
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
