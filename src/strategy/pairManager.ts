// Lifecycle of hedged pairs: open a long and a short together, watch them, close both together.
//
//   opening ──both legs open──▶ open ──trigger──▶ closing ──both legs closed──▶ done
//      │                                              ▲
//      └── one leg failed / timed out ── cancel the other, close it if it opened (orphan)
//
// Positions are linked to legs through the intent id we computed when signing, so a lost
// acknowledgement never leaves a leg untracked. Positions in our wallets that belong to no leg
// ("strays") are closed after a grace period.

import { join } from "node:path";
import type { Hex } from "viem";
import { IntentRejected } from "../api/client.js";
import type { ClosedPosition, IntentOutcome, Position } from "../api/schemas.js";
import type { WalletView } from "../api/walletStream.js";
import type { OpenParams, SubmitResult } from "../exec/executor.js";
import type { Quote } from "../market/hyperliquid.js";
import { logger } from "../util/log.js";
import { fromWad, toWad } from "../util/num.js";
import { readJson, writeJsonAtomic } from "../util/fsStore.js";
import type { Ledger } from "./ledger.js";

export interface LegExecutor {
  readonly label: string;
  open(p: OpenParams): Promise<SubmitResult>;
  close(positionIds: bigint[]): Promise<SubmitResult>;
  cancel(intentId: Hex): Promise<unknown>;
}

export type LegStatus = "submitting" | "pending" | "open" | "closing" | "closed" | "failed";

export interface Leg {
  wallet: string;
  isLong: boolean;
  status: LegStatus;
  openIntentId?: Hex;
  openDeadlineSec?: number;
  openSubmittedAt?: number;
  cancelRequestedAt?: number;
  positionId?: bigint;
  entryPriceRaw?: bigint;
  bustPriceRaw?: bigint;
  openedAtMs?: number;
  closeIntentId?: Hex;
  closeSubmittedAt?: number;
  closeDeadlineSec?: number;
  closeAttempts: number;
  missingSince?: number;
  result?: { netPnlUsd: number; paper: number; liquidated: boolean; unknown?: boolean };
  error?: string;
}

export type PairStatus = "opening" | "open" | "closing" | "done";

export interface Pair {
  id: string;
  symbol: string;
  instrumentId: number;
  priceScale: number;
  target: number;
  leverage: number;
  marginUsd: number;
  notionalUsd: number;
  expectedCycleHours: number;
  expectedCostUsd: number;
  expectedSpendPerHour: number;
  createdAtMs: number;
  openedAtMs?: number;
  closedAtMs?: number;
  status: PairStatus;
  closeReason?: string;
  legs: Leg[];
}

export interface PairSpec {
  symbol: string;
  instrumentId: number;
  priceScale: number;
  target: number;
  leverage: number;
  marginUsd: number;
  expectedCycleHours: number;
  expectedCostUsd: number;
  expectedSpendPerHour: number;
}

export interface PairManagerSettings {
  confirmTimeoutSec: number;
  maxHoldMultiple: number;
  emergencyBustFraction: number;
  singleWalletHedge: boolean;
  closeRetryLimit: number;
  /** Seconds a position may sit in our wallets without belonging to a pair before it is closed. */
  strayGraceSec: number;
}

export interface PairManagerDeps {
  executors: Record<string, LegExecutor>;
  /** Wallet labels in order [A, B]. */
  wallets: [string, string];
  view(label: string): WalletView | null;
  resync(label: string): void;
  quote(symbol: string): Quote | undefined;
  ledger: Ledger;
  dataDir: string;
  settings: PairManagerSettings;
  now?: () => number;
}

interface Persisted {
  seq: number;
  pairs: Pair[];
}

export class PairManager {
  private readonly log = logger("pairs");
  private readonly path: string;
  private state: Persisted;
  private readonly inFlight = new Set<string>();
  private readonly strays = new Map<string, number>(); // `${wallet}:${positionId}` → first seen
  private readonly strayClosing = new Map<string, number>();
  private readonly latencies: number[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: PairManagerDeps) {
    this.path = join(deps.dataDir, "pairs.json");
    this.state = readJson<Persisted>(this.path, { seq: 0, pairs: [] });
    this.now = deps.now ?? Date.now;
  }

  // ---------- queries ----------

  active(): Pair[] {
    return this.state.pairs.filter((p) => p.status !== "done");
  }

  openSpendPerHour(): number {
    return this.active().reduce((s, p) => s + p.expectedSpendPerHour, 0);
  }

  committedUsd(): number {
    return this.active().reduce((s, p) => s + p.expectedCostUsd, 0);
  }

  /** Margin of a wallet's legs in a given set of states. */
  marginIn(label: string, states: LegStatus[]): number {
    let m = 0;
    for (const p of this.active()) for (const l of p.legs) if (l.wallet === label && states.includes(l.status)) m += p.marginUsd;
    return m;
  }

  /** Margin sent in open intents not yet reflected as positions (not yet deducted from available balance). */
  pendingMargin(label: string): number {
    return this.marginIn(label, ["submitting", "pending"]);
  }

  /** Margin locked in our open positions. */
  lockedMargin(label: string): number {
    return this.marginIn(label, ["open", "closing"]);
  }

  hasOpening(): boolean {
    return this.active().some((p) => p.status === "opening");
  }

  /** 90th percentile of observed open latency (seconds), if enough samples. */
  latencyP90(): number | undefined {
    if (this.latencies.length < 3) return undefined;
    const s = [...this.latencies].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]! / 1000;
  }

  // ---------- persistence ----------

  private save(): void {
    writeJsonAtomic(this.path, { seq: this.state.seq, pairs: this.active() });
  }

  // ---------- actions ----------

  async openPair(spec: PairSpec): Promise<Pair> {
    const [a, b] = this.deps.wallets;
    const flip = this.state.seq % 2 === 1;
    const longWallet = flip ? b : a;
    const shortWallet = this.deps.settings.singleWalletHedge ? longWallet : flip ? a : b;
    const pair: Pair = {
      ...spec,
      id: `p${Date.now().toString(36)}-${this.state.seq++}`,
      notionalUsd: spec.marginUsd * spec.leverage,
      createdAtMs: this.now(),
      status: "opening",
      legs: [
        { wallet: longWallet, isLong: true, status: "submitting", closeAttempts: 0 },
        { wallet: shortWallet, isLong: false, status: "submitting", closeAttempts: 0 },
      ],
    };
    this.state.pairs.push(pair);
    this.save();
    this.log.info("opening pair", { id: pair.id, symbol: pair.symbol, target: pair.target, leverage: pair.leverage, margin: pair.marginUsd });
    await this.withLock(pair, async () => {
      await Promise.all(pair.legs.map((leg) => this.submitOpen(pair, leg)));
    });
    return pair;
  }

  private async submitOpen(pair: Pair, leg: Leg): Promise<void> {
    const exec = this.deps.executors[leg.wallet];
    if (!exec) {
      leg.status = "failed";
      leg.error = `no executor for wallet ${leg.wallet}`;
      return;
    }
    try {
      leg.openSubmittedAt = this.now();
      const r = await exec.open({
        instrumentId: pair.instrumentId,
        isLong: leg.isLong,
        marginRaw: toWad(pair.marginUsd),
        leverage: pair.leverage,
        useDebt: false,
      });
      leg.openIntentId = r.intentId;
      leg.openDeadlineSec = Number(r.deadlineSec);
      if (leg.status === "submitting") leg.status = "pending";
      this.linkLeg(pair, leg);
    } catch (err) {
      leg.status = "failed";
      leg.error = err instanceof IntentRejected ? `${err.code}${err.reason ? `/${err.reason}` : ""}` : String(err);
      this.log.warn("open leg failed", { id: pair.id, wallet: leg.wallet, isLong: leg.isLong, error: leg.error });
    } finally {
      this.save();
    }
  }

  /** Close every active pair (kill switch, stale data, shutdown). */
  closeAll(reason: string): void {
    for (const p of this.active()) {
      if (p.status === "opening") {
        p.closeReason ??= reason;
        for (const l of p.legs) if (l.status === "pending") this.requestCancel(p, l);
      }
      if (p.status === "open") this.beginClose(p, reason);
    }
    this.save();
  }

  // ---------- stream events ----------

  onUpdate(label: string, view: WalletView): void {
    for (const p of this.active()) for (const l of p.legs) if (l.wallet === label) this.linkLeg(p, l, view);
  }

  onOutcomes(label: string, outcomes: IntentOutcome[]): void {
    for (const o of outcomes) {
      for (const p of this.active()) {
        for (const l of p.legs) {
          if (l.wallet !== label) continue;
          if (l.openIntentId === o.intentId && (l.status === "pending" || l.status === "submitting") && o.outcome !== "succeeded") {
            l.status = "failed";
            l.error = `open ${o.outcome}`;
            this.log.warn("open intent did not succeed", { id: p.id, wallet: label, outcome: o.outcome });
          }
          if (l.closeIntentId === o.intentId && l.status === "closing" && o.outcome !== "succeeded") {
            l.status = "open"; // retried by tick()
            l.closeIntentId = undefined;
            l.error = `close ${o.outcome}`;
            this.log.warn("close intent did not succeed", { id: p.id, wallet: label, outcome: o.outcome });
          }
        }
      }
    }
    this.save();
  }

  onClosed(label: string, closed: ClosedPosition[]): void {
    for (const c of closed) {
      this.strays.delete(`${label}:${c.positionId}`);
      this.strayClosing.delete(`${label}:${c.positionId}`);
      for (const p of this.state.pairs) {
        for (const l of p.legs) {
          if (l.wallet === label && l.positionId === c.positionId && l.status !== "closed") {
            l.status = "closed";
            l.result = { netPnlUsd: fromWad(c.netPnlRaw), paper: fromWad(c.paperMintedRaw), liquidated: c.liquidated };
            this.log.info("leg closed", { id: p.id, wallet: label, isLong: l.isLong, pnl: l.result.netPnlUsd, paper: l.result.paper, liquidated: c.liquidated });
          }
        }
      }
    }
    this.save();
  }

  private linkLeg(pair: Pair, leg: Leg, view = this.deps.view(leg.wallet)): void {
    if (!view || !leg.openIntentId || (leg.status !== "pending" && leg.status !== "submitting" && leg.status !== "failed")) return;
    let found: Position | undefined;
    for (const pos of view.positions.values()) if (pos.intentId === leg.openIntentId) found = pos;
    if (!found) return;
    // A leg we had written off (timeout/cancel race) that did open is adopted, then closed by tick().
    leg.status = "open";
    leg.positionId = found.positionId;
    leg.entryPriceRaw = found.entryPriceRaw;
    leg.bustPriceRaw = found.bustPriceRaw;
    leg.openedAtMs = found.openedAtMs;
    if (leg.openSubmittedAt) {
      this.latencies.push(Math.max(0, this.now() - leg.openSubmittedAt));
      if (this.latencies.length > 50) this.latencies.shift();
    }
    this.log.info("leg open", { id: pair.id, wallet: leg.wallet, isLong: leg.isLong, positionId: found.positionId, entry: Number(found.entryPriceRaw) / pair.priceScale });
    this.save();
  }

  // ---------- main loop ----------

  tick(): void {
    const now = this.now();
    for (const p of this.active()) {
      if (this.inFlight.has(p.id)) continue;
      this.reconcileMissing(p, now);
      this.expirePending(p, now);
      switch (p.status) {
        case "opening":
          this.tickOpening(p);
          break;
        case "open":
          this.tickOpen(p, now);
          break;
        case "closing":
          this.tickClosing(p, now);
          break;
      }
    }
    this.handleStrays(now);
    this.save();
  }

  private tickOpening(p: Pair): void {
    const open = p.legs.filter((l) => l.status === "open");
    const failed = p.legs.filter((l) => l.status === "failed" || l.status === "closed");
    const pending = p.legs.filter((l) => l.status === "pending" || l.status === "submitting");
    if (open.length === p.legs.length) {
      p.status = "open";
      p.openedAtMs = Math.max(...open.map((l) => l.openedAtMs ?? this.now()));
      if (p.closeReason) this.beginClose(p, p.closeReason); // closeAll() arrived while opening
      return;
    }
    if (failed.length > 0 && pending.length > 0) {
      for (const l of pending) this.requestCancel(p, l);
      return;
    }
    if (pending.length === 0) {
      if (open.length > 0) this.beginClose(p, p.closeReason ?? "orphan: other leg failed");
      else this.finalize(p);
      return;
    }
    if (p.closeReason) for (const l of pending) this.requestCancel(p, l);
  }

  private tickOpen(p: Pair, now: number): void {
    if (p.legs.some((l) => l.status === "closed" || l.status === "failed")) {
      this.beginClose(p, "leg closed externally");
      return;
    }
    const q = this.deps.quote(p.symbol);
    if (!q) return;
    let worstAdverse = 0;
    let worstBustUse = 0;
    for (const l of p.legs) {
      if (!l.entryPriceRaw) continue;
      const entry = Number(l.entryPriceRaw) / p.priceScale;
      const adverse = l.isLong ? (entry - q.mid) / entry : (q.mid - entry) / entry;
      worstAdverse = Math.max(worstAdverse, adverse);
      if (l.bustPriceRaw) {
        const bust = Number(l.bustPriceRaw) / p.priceScale;
        const room = Math.abs(entry - bust) / entry;
        if (room > 0) worstBustUse = Math.max(worstBustUse, adverse / room);
      }
    }
    if (worstBustUse >= this.deps.settings.emergencyBustFraction) this.beginClose(p, `emergency: ${(worstBustUse * 100).toFixed(0)}% of bust distance used`);
    else if (worstAdverse >= p.target) this.beginClose(p, "target reached");
    else if (p.openedAtMs && now - p.openedAtMs > this.deps.settings.maxHoldMultiple * p.expectedCycleHours * 3_600_000) this.beginClose(p, "max hold time");
  }

  private tickClosing(p: Pair, now: number): void {
    const toClose = p.legs.filter((l) => l.status === "open");
    const retryable = toClose.filter((l) => !l.closeSubmittedAt || now - l.closeSubmittedAt >= Math.min(120_000, 15_000 * Math.max(1, l.closeAttempts)));
    if (retryable.length) this.submitCloses(p, retryable);
    for (const l of p.legs) {
      if (l.status !== "closing") continue;
      // A close whose intent deadline passed without a closed position: make it retryable.
      const expired = l.closeDeadlineSec !== undefined && now / 1000 > l.closeDeadlineSec + 60;
      // A close stuck for 5 minutes while the position is still listed: retry as well.
      const view = this.deps.view(l.wallet);
      const stillListed = l.positionId !== undefined && view?.positions.has(l.positionId) === true;
      const stuck = stillListed && l.closeSubmittedAt !== undefined && now - l.closeSubmittedAt > 300_000;
      if (expired || stuck) {
        l.status = "open";
        l.closeIntentId = undefined;
      }
    }
    if (p.legs.every((l) => l.status === "closed" || l.status === "failed")) this.finalize(p);
  }

  private beginClose(p: Pair, reason: string): void {
    if (p.status !== "closing") this.log.info("closing pair", { id: p.id, reason });
    p.status = "closing";
    p.closeReason ??= reason;
    const open = p.legs.filter((l) => l.status === "open");
    if (open.length) this.submitCloses(p, open);
  }

  private submitCloses(p: Pair, legs: Leg[]): void {
    const byWallet = new Map<string, Leg[]>();
    for (const l of legs) if (l.positionId !== undefined) byWallet.set(l.wallet, [...(byWallet.get(l.wallet) ?? []), l]);
    void this.withLock(p, async () => {
      await Promise.all(
        [...byWallet].map(async ([wallet, group]) => {
          const exec = this.deps.executors[wallet];
          if (!exec) return;
          for (const l of group) {
            l.status = "closing";
            l.closeAttempts++;
            l.closeSubmittedAt = this.now();
          }
          try {
            const r = await exec.close(group.map((l) => l.positionId!));
            for (const l of group) {
              l.closeIntentId = r.intentId;
              l.closeDeadlineSec = Number(r.deadlineSec);
            }
          } catch (err) {
            const code = err instanceof IntentRejected ? `${err.code}${err.reason ? `/${err.reason}` : ""}` : String(err);
            const alreadyClosed = err instanceof IntentRejected && err.reason === "noOpenPositions";
            for (const l of group) {
              // noOpenPositions: the position is gone or already has a close pending — wait for the stream.
              if (!alreadyClosed) l.status = "open";
              l.error = code;
            }
            const level = group.some((l) => l.closeAttempts >= this.deps.settings.closeRetryLimit) ? "error" : "warn";
            this.log[level]("close failed", { id: p.id, wallet, error: code, attempts: group[0]?.closeAttempts });
          }
        }),
      );
      this.save();
    });
  }

  private requestCancel(p: Pair, l: Leg): void {
    if (l.cancelRequestedAt || !l.openIntentId) return;
    const exec = this.deps.executors[l.wallet];
    if (!exec) return;
    l.cancelRequestedAt = this.now();
    const intentId = l.openIntentId;
    exec.cancel(intentId).then(
      () => this.log.info("cancel requested", { id: p.id, wallet: l.wallet, intentId }),
      (err) => this.log.warn("cancel failed (intent may already be processing)", { id: p.id, wallet: l.wallet, error: String(err) }),
    );
  }

  private expirePending(p: Pair, now: number): void {
    for (const l of p.legs) {
      if (l.status !== "pending" && l.status !== "submitting") continue;
      if (l.openSubmittedAt && now - l.openSubmittedAt > this.deps.settings.confirmTimeoutSec * 1000) this.requestCancel(p, l);
      if (l.openDeadlineSec && now / 1000 > l.openDeadlineSec + 120) {
        l.status = "failed";
        l.error = "open intent expired";
      }
    }
  }

  /** Legs whose position disappeared without a closed-position record (e.g. patch missed on reconnect). */
  private reconcileMissing(p: Pair, now: number): void {
    for (const l of p.legs) {
      if ((l.status !== "open" && l.status !== "closing") || l.positionId === undefined) continue;
      const view = this.deps.view(l.wallet);
      if (!view) continue;
      if (view.positions.has(l.positionId)) {
        l.missingSince = undefined;
        continue;
      }
      l.missingSince ??= now;
      const age = now - l.missingSince;
      if (age > 20_000 && age < 21_500) this.deps.resync(l.wallet);
      if (age > 60_000) {
        l.status = "closed";
        l.result = { netPnlUsd: 0, paper: 0, liquidated: false, unknown: true };
        this.log.warn("leg position vanished without a close record; result unknown", { id: p.id, wallet: l.wallet, positionId: l.positionId });
      }
    }
  }

  private finalize(p: Pair): void {
    const now = this.now();
    p.status = "done";
    p.closedAtMs = now;
    const pnl = p.legs.reduce((s, l) => s + (l.result?.netPnlUsd ?? 0), 0);
    const paper = p.legs.reduce((s, l) => s + (l.result?.paper ?? 0), 0);
    const cost = -pnl;
    this.deps.ledger.record(cost, paper, now, {
      id: p.id,
      symbol: p.symbol,
      target: p.target,
      leverage: p.leverage,
      margin: p.marginUsd,
      reason: p.closeReason,
      heldMin: p.openedAtMs ? (now - p.openedAtMs) / 60_000 : 0,
      costPerPaper: paper > 0 ? cost / paper : null,
      legs: p.legs.map((l) => ({ wallet: l.wallet, isLong: l.isLong, status: l.status, error: l.error, ...l.result })),
    });
    this.log.info("pair done", { id: p.id, costUsd: cost, paper, costPerPaper: paper > 0 ? cost / paper : null, reason: p.closeReason });
    this.state.pairs = this.state.pairs.filter((x) => x.id !== p.id);
  }

  private handleStrays(now: number): void {
    const known = new Set<string>();
    for (const p of this.state.pairs) for (const l of p.legs) if (l.positionId !== undefined) known.add(`${l.wallet}:${l.positionId}`);
    const pendingIntents = new Set<string>();
    for (const p of this.active()) for (const l of p.legs) if (l.openIntentId) pendingIntents.add(l.openIntentId);
    for (const label of this.deps.wallets) {
      const view = this.deps.view(label);
      if (!view) continue;
      for (const pos of view.positions.values()) {
        const key = `${label}:${pos.positionId}`;
        if (known.has(key) || (pos.intentId && pendingIntents.has(pos.intentId))) continue;
        const first = this.strays.get(key) ?? now;
        this.strays.set(key, first);
        const lastClose = this.strayClosing.get(key) ?? 0;
        if (now - first > this.deps.settings.strayGraceSec * 1000 && now - lastClose > 60_000) {
          this.strayClosing.set(key, now);
          const exec = this.deps.executors[label];
          this.log.warn("closing stray position", { wallet: label, positionId: pos.positionId });
          exec?.close([pos.positionId]).catch((err) => this.log.warn("stray close failed", { wallet: label, error: String(err) }));
        }
      }
    }
  }

  private async withLock(p: Pair, fn: () => Promise<void>): Promise<void> {
    this.inFlight.add(p.id);
    try {
      await fn();
    } finally {
      this.inFlight.delete(p.id);
    }
  }
}
