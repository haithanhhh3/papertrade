import { describe, expect, it } from "vitest";
import { evaluatePair, leverageForTarget } from "../src/model/economics.js";
import { bustDistance, keepFraction } from "../src/model/impact.js";
import { lpVelocity, mintRate, projectedMintRate } from "../src/model/mint.js";
import { hourlyVolFromCloses } from "../src/market/hyperliquid.js";
import { BTC } from "./fixtures.js";

const MINT = { cliff: 2_000_000, flat: 100, scale: 120_000_000 };

describe("impact", () => {
  it("matches the docs: BTC keeps ~88% of a 1% move and ~74% of a 0.1% move before the win fee", () => {
    expect(keepFraction(0.01, BTC) / 0.98).toBeCloseTo(0.88, 2);
    expect(keepFraction(0.001, BTC) / 0.98).toBeCloseTo(0.74, 2);
  });

  it("pays nothing inside the 0.2 bps deadband and never more than (1 − baseRate)(1 − fee)", () => {
    expect(keepFraction(0.00001, BTC)).toBe(0);
    expect(keepFraction(0.5, BTC)).toBeLessThan(0.9 * 0.98);
  });

  it("bust distance at 1000x is about 5 bps", () => {
    expect(bustDistance(1000, BTC)).toBeCloseTo(0.000524, 5);
  });
});

describe("mint curve", () => {
  it("is flat below the threshold, including underwater", () => {
    expect(mintRate({ trackedLp: -1_000_000, tail: 0 }, MINT)).toBe(100);
    expect(mintRate({ trackedLp: 1_999_999, tail: 0 }, MINT)).toBe(100);
  });

  it("decays as 100·(S/(S+H))² past the threshold (docs: H=$100M → ~30)", () => {
    expect(mintRate({ trackedLp: 3_000_000, tail: 100_000_000 }, MINT)).toBeCloseTo(29.75, 1);
    expect(mintRate({ trackedLp: 3_000_000, tail: 3_000_000 }, MINT)).toBeCloseTo(95.18, 1);
  });

  it("projects only the growth above the threshold into tail progress", () => {
    // From $1M at $1M/h for 3h → $4M: $2M of tail progress.
    expect(projectedMintRate({ trackedLp: 1_000_000, tail: 0 }, MINT, 1_000_000, 3)).toBeCloseTo(mintRate({ trackedLp: 4e6, tail: 2e6 }, MINT), 6);
    expect(projectedMintRate({ trackedLp: 0, tail: 0 }, MINT, -5_000, 24)).toBe(100);
  });

  it("estimates LP velocity in USD/hour", () => {
    const t0 = 1_700_000_000_000;
    const samples = [0, 1, 2, 3, 4].map((i) => [t0 + i * 600_000, 1000 + i * 500] as const);
    expect(lpVelocity(samples)).toBeCloseTo(3000, 6); // $500 per 10 min
  });
});

describe("pair economics", () => {
  const sizing = {
    impact: BTC,
    hourlyVol: 0.005,
    latencySec: 10,
    bustSafetyMultiple: 2,
    minNotional: 10_000,
    minMargin: 10,
    notionalBuffer: 0.1,
    marginPerLeg: 112.5,
    maxMarginPerLeg: 450,
  };
  const econ = { mintRate: 100, queueActive: false, queuedPayoutValue: 0.5 };

  it("keeps the bust at least k × target away", () => {
    for (const target of [0.002, 0.005, 0.01, 0.03]) {
      const lev = leverageForTarget(target, BTC, 0.005, 10, 2);
      expect(bustDistance(lev, BTC)).toBeGreaterThanOrEqual(2 * target);
    }
  });

  it("costs (1 − keep)/98 per PAPER with an empty queue", () => {
    const c = evaluatePair({ ...sizing, target: 0.01 }, econ)!;
    expect(c.costPerPaper).toBeCloseTo((1 - keepFraction(0.01, BTC)) / 98, 8);
    expect(c.notional).toBeGreaterThanOrEqual(11_000);
  });

  it("raises margin above the even split when the minimum notional requires it", () => {
    const c = evaluatePair({ ...sizing, target: 0.01 }, econ)!;
    expect(c.marginPerLeg).toBeGreaterThan(112.5);
    expect(c.marginPerLeg * c.leverage).toBeGreaterThanOrEqual(11_000);
    expect(evaluatePair({ ...sizing, target: 0.03, maxMarginPerLeg: 112.5 }, econ)).toBeUndefined();
  });

  it("is more expensive while the queue is active (winner payout discounted)", () => {
    const a = evaluatePair({ ...sizing, target: 0.005 }, econ)!;
    const b = evaluatePair({ ...sizing, target: 0.005 }, { ...econ, queueActive: true })!;
    expect(b.costPerPaper).toBeGreaterThan(a.costPerPaper);
  });
});

describe("volatility", () => {
  it("recovers the hourly vol of a synthetic random walk", () => {
    let p = 100_000;
    const closes = [p];
    let seed = 42;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 2000; i++) {
      const z = Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());
      p *= Math.exp(0.001 * z); // 0.1% per minute
      closes.push(p);
    }
    expect(hourlyVolFromCloses(closes)!).toBeGreaterThan(0.001 * Math.sqrt(60) * 0.7);
    expect(hourlyVolFromCloses(closes)!).toBeLessThan(0.001 * Math.sqrt(60) * 1.3);
  });
});
