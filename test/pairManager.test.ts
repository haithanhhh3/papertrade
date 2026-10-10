import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { IntentRejected } from "../src/api/client.js";
import type { ClosedPosition, Position } from "../src/api/schemas.js";
import type { WalletView } from "../src/api/walletStream.js";
import type { OpenParams, SubmitResult } from "../src/exec/executor.js";
import type { Quote } from "../src/market/hyperliquid.js";
import { Ledger } from "../src/strategy/ledger.js";
import { PairManager, type LegExecutor, type PairSpec } from "../src/strategy/pairManager.js";

let counter = 0;
const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

class FakeExec implements LegExecutor {
  opens: { params: OpenParams; intentId: Hex }[] = [];
  closes: { ids: bigint[]; intentId: Hex }[] = [];
  cancels: Hex[] = [];
  rejectOpen = false;
  constructor(readonly label: string) {}
  async open(params: OpenParams): Promise<SubmitResult> {
    if (this.rejectOpen) throw new IntentRejected("admission_rejected", "openInterest", 409, {});
    const intentId = hex(++counter);
    this.opens.push({ params, intentId });
    return { intentId, deadlineSec: BigInt(Math.floor(clock / 1000) + 3600) };
  }
  async close(ids: bigint[]): Promise<SubmitResult> {
    const intentId = hex(++counter);
    this.closes.push({ ids, intentId });
    return { intentId, deadlineSec: BigInt(Math.floor(clock / 1000) + 3600) };
  }
  async cancel(intentId: Hex): Promise<unknown> {
    this.cancels.push(intentId);
    return {};
  }
}

function view(): WalletView {
  return {
    address: "0x0000000000000000000000000000000000000001",
    accountRevision: 1,
    indexedThroughBlock: 1,
    balance: 0n,
    queued: 0n,
    locked: 0n,
    availableBalance: 0n,
    availableQueued: 0n,
    paperBalance: 0n,
    paperStaked: 0n,
    sessionKeys: new Map(),
    positions: new Map(),
    operations: new Map(),
  };
}

let clock = 1_791_600_000_000;
const flush = () => new Promise((r) => setTimeout(r, 0));
let positionSeq = 100n;

function fill(v: WalletView, intentId: Hex, isLong: boolean, entry = 820_000n): Position {
  const p: Position = {
    positionId: positionSeq++,
    instrumentId: 0,
    isLong,
    useDebt: false,
    entryPriceRaw: entry, // $82,000 at priceScale 10
    marginRaw: 112n * 10n ** 18n,
    leverage: 150,
    bustPriceRaw: isLong ? 814_900n : 825_100n, // ~0.62% away
    openedAtMs: clock,
    intentId,
  };
  v.positions.set(p.positionId, p);
  return p;
}

function closed(p: Position, pnl: number, paper: number, liquidated = false): ClosedPosition {
  return {
    positionId: p.positionId,
    instrumentId: 0,
    isLong: p.isLong,
    marginRaw: p.marginRaw,
    leverage: p.leverage,
    liquidated,
    netPnlRaw: BigInt(Math.round(pnl * 1e6)) * 10n ** 12n,
    paperMintedRaw: BigInt(Math.round(paper * 1e6)) * 10n ** 12n,
  };
}

const spec: PairSpec = {
  symbol: "BTC",
  instrumentId: 0,
  priceScale: 10,
  target: 0.003,
  leverage: 150,
  marginUsd: 112,
  expectedCycleHours: 1,
  expectedCostUsd: 9,
  expectedSpendPerHour: 9,
};

describe("PairManager", () => {
  let a: FakeExec, b: FakeExec, va: WalletView, vb: WalletView, quote: Quote, ledger: Ledger, pm: PairManager;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "ptbot-pm-"));
    a = new FakeExec("A");
    b = new FakeExec("B");
    va = view();
    vb = view();
    quote = { coin: "BTC", bid: 81_999.5, ask: 82_000.5, mid: 82_000, spreadBps: 0.1, at: clock };
    ledger = new Ledger(dir);
    pm = new PairManager({
      executors: { A: a, B: b },
      wallets: ["A", "B"],
      view: (l) => (l === "A" ? va : vb),
      resync: () => {},
      quote: () => quote,
      ledger,
      dataDir: dir,
      now: () => clock,
      settings: { confirmTimeoutSec: 90, maxHoldMultiple: 4, emergencyBustFraction: 0.7, singleWalletHedge: false, closeRetryLimit: 5, strayGraceSec: 120 },
    });
  });

  async function openBoth() {
    const pair = await pm.openPair(spec);
    expect(a.opens).toHaveLength(1);
    expect(b.opens).toHaveLength(1);
    expect(a.opens[0]!.params.isLong).toBe(true);
    expect(b.opens[0]!.params.isLong).toBe(false);
    expect(a.opens[0]!.params.marginRaw).toBe(112n * 10n ** 18n);
    const pa = fill(va, a.opens[0]!.intentId, true);
    const pb = fill(vb, b.opens[0]!.intentId, false);
    pm.onUpdate("A", va);
    pm.onUpdate("B", vb);
    pm.tick();
    expect(pair.status).toBe("open");
    return { pair, pa, pb };
  }

  it("opens both legs, closes both at the target and records cost and PAPER", async () => {
    const { pair, pa, pb } = await openBoth();
    quote = { ...quote, mid: 82_000 * 1.0029 };
    pm.tick();
    expect(a.closes).toHaveLength(0);
    quote = { ...quote, mid: 82_000 * 1.0031 };
    pm.tick();
    await flush();
    expect(pair.status).toBe("closing");
    expect(a.closes[0]!.ids).toEqual([pa.positionId]);
    expect(b.closes[0]!.ids).toEqual([pb.positionId]);
    va.positions.delete(pa.positionId);
    vb.positions.delete(pb.positionId);
    pm.onClosed("A", [closed(pa, 41.5, 0)]);
    pm.onClosed("B", [closed(pb, -50.4, 4939)]);
    pm.tick();
    expect(pm.active()).toHaveLength(0);
    expect(ledger.today(clock).pairs).toBe(1);
    expect(ledger.today(clock).spentUsd).toBeCloseTo(8.9, 6);
    expect(ledger.today(clock).paper).toBeCloseTo(4939, 6);
  });

  it("closes the surviving leg when the other is rejected (orphan)", async () => {
    b.rejectOpen = true;
    const pair = await pm.openPair(spec);
    expect(pair.legs[1]!.status).toBe("failed");
    const pa = fill(va, a.opens[0]!.intentId, true);
    pm.onUpdate("A", va);
    pm.tick();
    await flush();
    expect(pair.status).toBe("closing");
    expect(a.closes[0]!.ids).toEqual([pa.positionId]);
    va.positions.delete(pa.positionId);
    pm.onClosed("A", [closed(pa, -0.2, 0)]);
    pm.tick();
    expect(pm.active()).toHaveLength(0);
  });

  it("cancels a leg that has not landed when the other failed", async () => {
    const pair = await pm.openPair(spec);
    pm.onOutcomes("B", [{ intentId: b.opens[0]!.intentId, outcome: "failed" }]);
    pm.tick();
    expect(a.cancels).toEqual([a.opens[0]!.intentId]);
    pm.onOutcomes("A", [{ intentId: a.opens[0]!.intentId, outcome: "cancelled" }]);
    pm.tick();
    expect(pair.status).toBe("done");
  });

  it("closes the other leg immediately when one is liquidated", async () => {
    const { pair, pa, pb } = await openBoth();
    vb.positions.delete(pb.positionId);
    pm.onClosed("B", [closed(pb, -112, 11_200, true)]);
    pm.tick();
    await flush();
    expect(pair.status).toBe("closing");
    expect(a.closes[0]!.ids).toEqual([pa.positionId]);
  });

  it("emergency-closes before the bust price", async () => {
    const { pair } = await openBoth();
    pm.tick();
    // Long bust at 81,490 (0.62% below entry); 70% of that distance is ~0.435% — beyond the 0.3% target too,
    // so test with a wider target to isolate the emergency rule.
    pair.target = 0.05;
    quote = { ...quote, mid: 82_000 * (1 - 0.0045) };
    pm.tick();
    expect(pair.status).toBe("closing");
    expect(pair.closeReason).toMatch(/emergency/);
  });

  it("retries a close that failed", async () => {
    const { pair } = await openBoth();
    quote = { ...quote, mid: 82_000 * 0.996 };
    pm.tick();
    await flush();
    expect(a.closes).toHaveLength(1);
    pm.onOutcomes("A", [{ intentId: a.closes[0]!.intentId, outcome: "failed" }]);
    expect(pair.legs[0]!.status).toBe("open");
    clock += 16_000;
    pm.tick();
    await flush();
    expect(a.closes).toHaveLength(2);
  });

  it("closes stray positions after the grace period", async () => {
    va.positions.set(999n, { ...fill(va, hex(424242), true), positionId: 999n });
    pm.tick();
    expect(a.closes).toHaveLength(0);
    clock += 121_000;
    pm.tick();
    expect(a.closes.map((c) => c.ids)).toContainEqual([999n]);
  });

  it("resumes active pairs from disk after a restart", async () => {
    const { pair } = await openBoth();
    const again = new PairManager({ ...(pm as unknown as { deps: ConstructorParameters<typeof PairManager>[0] }).deps });
    expect(again.active().map((p) => p.id)).toEqual([pair.id]);
    expect(again.active()[0]!.legs[0]!.positionId).toBe(pair.legs[0]!.positionId);
  });
});
