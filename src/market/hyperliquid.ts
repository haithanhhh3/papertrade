// Hyperliquid market data: top of book (the BBO Papertrade prices from), mark/oracle for sanity
// checks, and 1-minute candles for realised volatility.

import { HttpError, requestJson } from "../net/http.js";
import { logger } from "../util/log.js";

export interface Quote {
  coin: string;
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  at: number; // local receive time (ms)
}

export interface AssetContext {
  mark: number;
  oracle: number;
  at: number;
}

const log = logger("hl");

export class HyperliquidMarket {
  private quotes = new Map<string, Quote>();
  private contexts = new Map<string, AssetContext>();
  private hourlyVol = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  private ws?: WebSocket;
  private wsRetry = 0;
  private stopped = false;
  /** REST requests are skipped until this time after an HTTP 429. */
  private restBackoffUntil = 0;

  constructor(
    readonly infoUrl: string,
    readonly coins: string[],
    readonly wsUrl = infoUrl.replace(/^http/, "ws").replace(/\/info$/, "/ws"),
  ) {}

  private async info(body: unknown, timeoutMs = 5000): Promise<unknown> {
    if (Date.now() < this.restBackoffUntil) throw new Error("hyperliquid REST backing off after HTTP 429");
    try {
      return await requestJson(this.infoUrl, { body, timeoutMs, headers: { Accept: "application/json" } });
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) this.restBackoffUntil = Date.now() + 30_000;
      throw err;
    }
  }

  /** Top-of-book stream (primary quote source). Prices only arrive on change; pongs refresh liveness. */
  private connectWs(): void {
    if (this.stopped) return;
    let ping: NodeJS.Timeout | undefined;
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.wsRetry = 0;
      for (const coin of this.coins) ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "bbo", coin } }));
      ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ method: "ping" })), 2000);
    };
    ws.onmessage = (ev) => {
      let m: { channel?: string; data?: { coin?: string; bbo?: [{ px: string } | null, { px: string } | null] } };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const now = Date.now();
      if (m.channel === "pong") {
        for (const q of this.quotes.values()) if (now - q.at < 10_000) q.at = now;
      } else if (m.channel === "bbo" && m.data?.coin) {
        const bid = Number(m.data.bbo?.[0]?.px);
        const ask = Number(m.data.bbo?.[1]?.px);
        if (bid > 0 && ask >= bid) this.setQuote(m.data.coin, bid, ask, now);
      }
    };
    ws.onclose = () => {
      clearInterval(ping);
      if (this.stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.wsRetry++, 5));
      log.warn("hyperliquid websocket closed; reconnecting", { delayMs: delay });
      setTimeout(() => this.connectWs(), delay);
    };
    ws.onerror = () => {
      // onclose follows and handles the reconnect
    };
  }

  private setQuote(coin: string, bid: number, ask: number, at: number): Quote {
    const mid = (bid + ask) / 2;
    const q: Quote = { coin, bid, ask, mid, spreadBps: ((ask - bid) / mid) * 1e4, at };
    this.quotes.set(coin, q);
    return q;
  }

  async refreshQuote(coin: string): Promise<Quote> {
    const book = (await this.info({ type: "l2Book", coin })) as { levels?: [{ px: string }[], { px: string }[]] };
    const bid = Number(book.levels?.[0]?.[0]?.px);
    const ask = Number(book.levels?.[1]?.[0]?.px);
    if (!(bid > 0 && ask > 0 && ask >= bid)) throw new Error(`bad book for ${coin}`);
    return this.setQuote(coin, bid, ask, Date.now());
  }

  async refreshContexts(): Promise<void> {
    const res = (await this.info({ type: "metaAndAssetCtxs" }, 8000)) as [
      { universe: { name: string }[] },
      { markPx: string; oraclePx: string }[],
    ];
    const [meta, ctxs] = res;
    meta.universe.forEach((u, i) => {
      const c = ctxs[i];
      if (c && this.coins.includes(u.name)) {
        this.contexts.set(u.name, { mark: Number(c.markPx), oracle: Number(c.oraclePx), at: Date.now() });
      }
    });
  }

  /** Hourly volatility from the last `minutes` 1-minute closes (EWMA of squared log returns). */
  async refreshVol(coin: string, minutes = 240): Promise<number | undefined> {
    const end = Date.now();
    const candles = (await this.info(
      { type: "candleSnapshot", req: { coin, interval: "1m", startTime: end - minutes * 60_000, endTime: end } },
      10_000,
    )) as { c: string }[];
    const closes = candles.map((c) => Number(c.c)).filter((x) => x > 0);
    const vol = hourlyVolFromCloses(closes);
    if (vol !== undefined) this.hourlyVol.set(coin, vol);
    return vol;
  }

  quote(coin: string): Quote | undefined {
    return this.quotes.get(coin);
  }

  context(coin: string): AssetContext | undefined {
    return this.contexts.get(coin);
  }

  vol(coin: string): number | undefined {
    return this.hourlyVol.get(coin);
  }

  start(intervals: { quoteMs: number; contextMs: number; candlesMs: number }): void {
    const guard = (name: string, fn: () => Promise<unknown>) => async () => {
      try {
        await fn();
      } catch (err) {
        log.warn(`${name} refresh failed`, { error: String(err) });
      }
    };
    this.stopped = false;
    this.connectWs();
    // REST fallback only for coins whose stream quote is older than 3 s.
    const quoteTick = guard("quote", () =>
      Promise.all(this.coins.filter((c) => Date.now() - (this.quotes.get(c)?.at ?? 0) > 3000).map((c) => this.refreshQuote(c))),
    );
    const ctxTick = guard("context", () => this.refreshContexts());
    const volTick = guard("vol", () => Promise.all(this.coins.map((c) => this.refreshVol(c))));
    void quoteTick();
    void ctxTick();
    void volTick();
    this.timers.push(setInterval(quoteTick, intervals.quoteMs));
    this.timers.push(setInterval(ctxTick, intervals.contextMs));
    this.timers.push(setInterval(volTick, intervals.candlesMs));
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.ws?.close();
  }
}

/** EWMA (half-life 60 samples) of squared 1-minute log returns, scaled to one hour. */
export function hourlyVolFromCloses(closes: number[], halfLife = 60): number | undefined {
  if (closes.length < 30) return undefined;
  const lambda = Math.pow(0.5, 1 / halfLife);
  let v = 0;
  let w = 0;
  for (let i = 1; i < closes.length; i++) {
    const r = Math.log(closes[i]! / closes[i - 1]!);
    v = lambda * v + (1 - lambda) * r * r;
    w = lambda * w + (1 - lambda);
  }
  const perMinute = Math.sqrt(v / w);
  return perMinute * Math.sqrt(60);
}
