// REST client for exchange.papertrade.xyz (read endpoints + intent submission).

import { get } from "node:https";
import { browserHeaders, HttpError, requestJson } from "../net/http.js";
import {
  IntentAcceptedSchema,
  ProtocolSummarySchema,
  QueueSummarySchema,
  TradingStateSchema,
  type IntentAccepted,
  type ProtocolSummary,
  type TradingState,
} from "./schemas.js";

export type IntentAction =
  | "registerSessionKey"
  | "openPosition"
  | "closePositions"
  | "withdrawToCore"
  | "paperStake"
  | "paperUnstake"
  | "paperClaim";

/** Error returned by the relayer with a machine-readable code (see docs/relayer-api.md). */
export class IntentRejected extends Error {
  constructor(
    readonly code: string,
    readonly reason: string | undefined,
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(`intent rejected: ${code}${reason ? `/${reason}` : ""} (HTTP ${status})`);
    this.name = "IntentRejected";
  }

  /** Codes after which the same signed intent can never succeed. */
  get definitive(): boolean {
    return [
      "admission_rejected",
      "invalid_intent",
      "deadline_expired",
      "unauthorized_intent",
      "intent_conflict",
      "intake_action_paused",
      "below_minimum_paper_stake",
      "below_minimum_withdrawal",
    ].includes(this.code);
  }
}

export class PapertradeApi {
  private buildId?: string;
  private buildIdAt = 0;

  constructor(
    readonly baseUrl: string,
    private readonly fixedBuildId?: string,
  ) {}

  private url(path: string): string {
    return this.baseUrl.replace(/\/$/, "") + path;
  }

  /**
   * The frontend tags intent submissions with its build id (X-Papertrade-Build). We read the current id
   * from the app's build module so submissions look like the current frontend's; refreshed hourly.
   */
  async currentBuildId(): Promise<string | undefined> {
    if (this.buildId && Date.now() - this.buildIdAt < 3_600_000) return this.buildId;
    if (this.fixedBuildId) return this.fixedBuildId;
    try {
      // node:https rather than fetch: fetch always sends `sec-fetch-mode: cors`, for which the app host returns 404.
      const html = await getText(this.url("/"), { Accept: "text/html" });
      const mod = html.match(/\/assets\/build-[A-Za-z0-9_-]+\.js/)?.[0];
      if (mod) {
        const js = await getText(this.url(mod), { Accept: "*/*" });
        const id = js.match(/`([0-9a-f]{8,64})`/)?.[1];
        if (id) {
          this.buildId = id;
          this.buildIdAt = Date.now();
        }
      }
    } catch {
      // keep the previous id (or none)
    }
    return this.buildId;
  }

  async tradingState(): Promise<TradingState> {
    return TradingStateSchema.parse(await requestJson(this.url("/state/trading"), { timeoutMs: 5000 }));
  }

  async protocolSummary(): Promise<ProtocolSummary> {
    return ProtocolSummarySchema.parse(await requestJson(this.url("/query/protocol/summary"), { timeoutMs: 8000 }));
  }

  async queueSummary(): Promise<{ total: bigint; count: number }> {
    const q = QueueSummarySchema.parse(await requestJson(this.url("/query/protocol/queue-summary"), { timeoutMs: 8000 }));
    return { total: q.total, count: q.count };
  }

  async relayerHealthy(): Promise<boolean> {
    try {
      const r = (await requestJson(this.url("/relayer/health"), { timeoutMs: 5000 })) as { ok?: boolean; ready?: boolean };
      return r.ok === true && r.ready === true;
    } catch {
      return false;
    }
  }

  liveUrl(wallet: string): string {
    return this.url(`/state/user/live?wallet=${encodeURIComponent(wallet.toLowerCase())}`);
  }

  /** POST /intents. Throws IntentRejected for relayer-coded errors; other errors mean "outcome unknown". */
  async submit(action: IntentAction, signed: Record<string, unknown>): Promise<IntentAccepted> {
    return this.post("/intents", { action, signed });
  }

  async cancel(intentId: string, signed: Record<string, unknown>): Promise<IntentAccepted> {
    return this.post(`/intents/${intentId}/cancel`, signed);
  }

  private async post(path: string, body: unknown): Promise<IntentAccepted> {
    let res: unknown;
    const build = await this.currentBuildId();
    try {
      res = await requestJson(this.url(path), { body, timeoutMs: 35_000, headers: build ? { "X-Papertrade-Build": build } : {} });
    } catch (err) {
      if (err instanceof HttpError) {
        const p = (err.body ?? {}) as { code?: unknown; error?: unknown; reason?: unknown };
        const code = typeof p.code === "string" ? p.code : typeof p.error === "string" ? p.error : err.status === 429 ? "rate_limited" : "request_failed";
        throw new IntentRejected(code, typeof p.reason === "string" ? p.reason : undefined, err.status, err.body);
      }
      throw err;
    }
    const r = res as { ok?: unknown; error?: unknown; code?: unknown; reason?: unknown };
    if (r.ok === false || typeof r.error === "string") {
      const code = typeof r.code === "string" ? r.code : String(r.error ?? "request_failed");
      throw new IntentRejected(code, typeof r.reason === "string" ? r.reason : undefined, 200, res);
    }
    return IntentAcceptedSchema.parse(res);
  }
}

/** Plain HTTPS GET with browser-like headers (no fetch-added sec-fetch-* headers). */
function getText(url: string, headers: Record<string, string>, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: browserHeaders(headers), timeout: timeoutMs }, (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} ${url}`));
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve(body));
    });
    req.on("timeout", () => req.destroy(new Error(`timeout: ${url}`)));
    req.on("error", reject);
  });
}
