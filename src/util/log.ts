// Minimal structured logger: one JSON object per line on stdout (journald/systemd friendly).

export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = (process.env.LOG_LEVEL as Level) in ORDER ? (process.env.LOG_LEVEL as Level) : "info";

export function setLogLevel(level: Level): void {
  threshold = level;
}

function serialize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

function emit(level: Level, scope: string, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, scope, msg, ...fields }, (_k, v) => serialize(v));
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function logger(scope: string): Logger {
  return {
    debug: (m, f) => emit("debug", scope, m, f),
    info: (m, f) => emit("info", scope, m, f),
    warn: (m, f) => emit("warn", scope, m, f),
    error: (m, f) => emit("error", scope, m, f),
    child: (s) => logger(`${scope}.${s}`),
  };
}
