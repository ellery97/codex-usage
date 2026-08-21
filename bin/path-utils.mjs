import path from "node:path";

export function splitPathList(value, delimiter = path.delimiter) {
  const text = String(value ?? "");
  if (!text) return [];
  if (!delimiter) {
    throw new Error("Path-list delimiter must not be empty");
  }
  return text
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function escapeSqlLike(value) {
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function sqlPathFilter(column, roots, separator = path.sep) {
  const parts = [];
  const params = [];
  for (const root of roots || []) {
    const value = String(root);
    const descendantPrefix = value.endsWith(separator) ? value : `${value}${separator}`;
    parts.push(`(${column} = ? OR ${column} LIKE ? ESCAPE '\\')`);
    params.push(value, `${escapeSqlLike(descendantPrefix)}%`);
  }
  return {
    sql: parts.length ? `(${parts.join(" OR ")})` : "1 = 0",
    params,
  };
}
