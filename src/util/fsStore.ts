// Crash-safe JSON persistence: write to a temp file, fsync, then rename over the target.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, appendFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { $big: value.toString() } : value;
}

function jsonReviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && "$big" in value && Object.keys(value).length === 1) {
    return BigInt((value as { $big: string }).$big);
  }
  return value;
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"), jsonReviver) as T;
}

export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, JSON.stringify(value, jsonReplacer, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  chmodSync(path, mode);
}

export function appendJsonLine(path: string, value: unknown): void {
  ensureDir(dirname(path));
  appendFileSync(path, JSON.stringify(value, jsonReplacer) + "\n", { mode: 0o600 });
}
