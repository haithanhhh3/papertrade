// fetch wrapper. Papertrade sits behind Cloudflare, which 404s requests without browser-like headers.

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class TimeoutError extends Error {
  constructor(readonly url: string) {
    super(`timeout: ${url}`);
    this.name = "TimeoutError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export function browserHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "User-Agent": BROWSER_UA,
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    ...extra,
  };
}

export async function requestJson(url: string, opts: RequestOptions = {}): Promise<unknown> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const headers = browserHeaders(opts.headers);
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal,
      redirect: "error",
    });
  } catch (err) {
    if (timeout.aborted) throw new TimeoutError(url);
    throw err;
  }
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text.length ? JSON.parse(text) : {};
  } catch {
    // keep raw text
  }
  if (!res.ok) {
    throw new HttpError(`HTTP ${res.status} ${url}`, res.status, parsed);
  }
  return parsed;
}
