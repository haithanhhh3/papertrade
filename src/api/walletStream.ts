// SSE client for /state/user/live?wallet=… — keeps a live view of one account
// (balances, PAPER, session keys, open positions, pending intents) and surfaces
// closed positions and intent outcomes as they arrive in patches.

import { browserHeaders } from "../net/http.js";
import { logger, type Logger } from "../util/log.js";
import {
  WalletFrameSchema,
  WalletPatchSchema,
  type ClosedPosition,
  type IntentOutcome,
  type Operation,
  type Position,
} from "./schemas.js";

export interface WalletView {
  address: `0x${string}`;
  accountRevision: number;
  indexedThroughBlock: number;
  balance: bigint;
  queued: bigint;
  locked: bigint;
  availableBalance: bigint;
  availableQueued: bigint;
  paperBalance: bigint;
  paperStaked: bigint;
  sessionKeys: Map<string, number>; // address → expiry (unix seconds)
  positions: Map<bigint, Position>;
  operations: Map<string, Operation>;
}

export interface WalletStreamHandlers {
  onUpdate?: (view: WalletView) => void;
  onClosed?: (closed: ClosedPosition[], view: WalletView) => void;
  onOutcomes?: (outcomes: IntentOutcome[], view: WalletView) => void;
  /** Called after a full frame replaced the view (first connect or reconnect). */
  onSnapshot?: (view: WalletView) => void;
}

type FetchLike = typeof fetch;

export class WalletStream {
  private view: WalletView | null = null;
  private lastEventAt = 0;
  private stopped = false;
  private abort: AbortController | null = null;
  private retry = 0;
  private readonly log: Logger;

  constructor(
    readonly url: string,
    readonly label: string,
    private readonly handlers: WalletStreamHandlers = {},
    private readonly fetchImpl: FetchLike = fetch,
    private readonly silenceMs = 45_000,
  ) {
    this.log = logger(`wallet.${label}`);
  }

  current(): WalletView | null {
    return this.view;
  }

  /** Milliseconds since the last event of any kind (heartbeats included). */
  ageMs(now = Date.now()): number {
    return this.lastEventAt ? now - this.lastEventAt : Number.POSITIVE_INFINITY;
  }

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  /** Force a reconnect, which yields a fresh full frame. */
  resync(): void {
    this.abort?.abort();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        this.retry = 0;
      } catch (err) {
        if (!this.stopped) this.log.warn("stream error", { error: String(err) });
      }
      if (this.stopped) break;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.retry++, 5)) * (0.75 + Math.random() * 0.5);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  private async connectOnce(): Promise<void> {
    this.abort = new AbortController();
    const ctrl = this.abort;
    let watchdog: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => ctrl.abort(), this.silenceMs);
    };
    arm();
    try {
      const res = await this.fetchImpl(this.url, {
        headers: browserHeaders({ Accept: "text/event-stream" }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        arm();
        buffer += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
          this.handleBlock(block);
        }
      }
    } finally {
      clearTimeout(watchdog);
    }
  }

  /** Parse one SSE event block. Exposed for tests. */
  handleBlock(block: string): void {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    this.lastEventAt = Date.now();
    if (event !== "wallet" || data.length === 0) return;
    const payload = JSON.parse(data.join("\n"));
    if (payload && typeof payload === "object" && "addedPositions" in payload) this.applyPatch(payload);
    else this.applyFrame(payload);
  }

  private applyFrame(payload: unknown): void {
    const f = WalletFrameSchema.parse(payload);
    this.view = {
      address: f.address,
      accountRevision: f.accountRevision,
      indexedThroughBlock: f.indexedThroughBlock,
      balance: f.balance,
      queued: f.queued,
      locked: f.locked,
      availableBalance: f.funds.availableBalance,
      availableQueued: f.funds.availableQueued,
      paperBalance: f.paper.balance,
      paperStaked: f.paper.staked,
      sessionKeys: new Map(f.sessionKeys.map(([k, exp]) => [k, Number(exp)])),
      positions: new Map(f.openPositions.map((p) => [p.positionId, p])),
      operations: new Map(f.operations.map((o) => [o.intentId, o])),
    };
    this.handlers.onSnapshot?.(this.view);
    this.handlers.onUpdate?.(this.view);
  }

  private applyPatch(payload: unknown): void {
    const p = WalletPatchSchema.parse(payload);
    const v = this.view;
    if (!v) {
      // A patch without a base frame cannot be applied: reconnect for a full frame.
      this.resync();
      return;
    }
    if (p.accountRevision <= v.accountRevision) return; // stale or duplicate
    const s = p.state;
    if (s.indexedThroughBlock !== undefined) v.indexedThroughBlock = s.indexedThroughBlock;
    if (s.balance !== undefined) v.balance = s.balance;
    if (s.queued !== undefined) v.queued = s.queued;
    if (s.locked !== undefined) v.locked = s.locked;
    if (s.funds) {
      v.availableBalance = s.funds.availableBalance;
      v.availableQueued = s.funds.availableQueued;
    }
    if (s.paper) {
      v.paperBalance = s.paper.balance;
      v.paperStaked = s.paper.staked;
    }
    if (s.sessionKeys) v.sessionKeys = new Map(s.sessionKeys.map(([k, exp]) => [k, Number(exp)]));
    for (const id of p.removedPositionIds) v.positions.delete(BigInt(id));
    for (const pos of p.addedPositions) v.positions.set(pos.positionId, pos);
    for (const id of p.removedOperationIds) v.operations.delete(id);
    for (const op of p.addedOperations) v.operations.set(op.intentId, op);
    v.accountRevision = p.accountRevision;
    if (p.closedPositions?.length) this.handlers.onClosed?.(p.closedPositions, v);
    if (p.intentOutcomes?.length) this.handlers.onOutcomes?.(p.intentOutcomes, v);
    this.handlers.onUpdate?.(v);
  }
}
