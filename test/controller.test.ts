import { describe, expect, it } from "vitest";
import { decide, type ControllerInput } from "../src/strategy/controller.js";
import { BTC } from "./fixtures.js";

function input(over: Partial<ControllerInput> = {}): ControllerInput {
  return {
    assets: [{ symbol: "BTC", instrumentId: 0, impact: BTC, hourlyVol: 0.005, oiHeadroomUsd: 1e9 }],
    minNotional: 10_000,
    minMargin: 10,
    mint: { trackedLp: 0, tail: 0, params: { cliff: 2e6, flat: 100, scale: 1.2e8 }, velocityPerHour: 0 },
    queueActive: false,
    budget: { dailyUsd: 200, spentTodayUsd: 0, committedUsd: 0, openSpendPerHour: 0 },
    freeMarginUsd: 450,
    openPairs: 0,
    latencySec: 10,
    settings: {
      maxPairs: 4,
      maxCostPerPaper: 0.0025,
      bustSafetyMultiple: 2,
      notionalBuffer: 0.1,
      targetGrid: [0.002, 0.003, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.03],
      urgencyKappa: 1,
      maxFrontLoad: 2,
      queuedPayoutValue: 0.5,
    },
    ...over,
  };
}

describe("controller", () => {
  it("opens a pair under the cost cap when budget and capital allow", () => {
    const d = decide(input());
    expect(d.action).toBe("open");
    expect(d.choice!.costPerPaper).toBeLessThanOrEqual(0.0025);
    expect(d.choice!.marginPerLeg).toBeLessThanOrEqual(450);
    expect(d.targetSpendPerHour).toBeCloseTo(200 / 24, 6);
  });

  it("holds when the daily budget is used", () => {
    const d = decide(input({ budget: { dailyUsd: 200, spentTodayUsd: 190, committedUsd: 15, openSpendPerHour: 0 } }));
    expect(d.action).toBe("hold");
    expect(d.reason).toMatch(/budget/);
  });

  it("holds when open pairs already spend at the target rate", () => {
    const d = decide(input({ budget: { dailyUsd: 200, spentTodayUsd: 0, committedUsd: 10, openSpendPerHour: 9 }, openPairs: 1 }));
    expect(d.action).toBe("hold");
  });

  it("prefers a wider, cheaper target when a smaller budget can be spent that way", () => {
    const cheap = decide(input({ budget: { dailyUsd: 20, spentTodayUsd: 0, committedUsd: 0, openSpendPerHour: 0 } }));
    const fast = decide(input({ budget: { dailyUsd: 400, spentTodayUsd: 0, committedUsd: 0, openSpendPerHour: 0 } }));
    expect(cheap.choice!.target).toBeGreaterThan(fast.choice!.target);
    expect(cheap.choice!.costPerPaper).toBeLessThan(fast.choice!.costPerPaper);
  });

  it("front-loads the allowance when the mint rate is projected to fall", () => {
    const calm = decide(input());
    const urgent = decide(input({ mint: { trackedLp: 1_900_000, tail: 0, params: { cliff: 2e6, flat: 100, scale: 1.2e8 }, velocityPerHour: 2_000_000 } }));
    expect(urgent.urgency).toBeGreaterThan(0.2);
    expect(urgent.allowanceUsd).toBeGreaterThan(calm.allowanceUsd);
    expect(urgent.allowanceUsd).toBeLessThanOrEqual(400);
  });

  it("skips everything above the cost cap", () => {
    const d = decide(input({ settings: { ...input().settings, maxCostPerPaper: 0.0005 } }));
    expect(d.action).toBe("hold");
  });

  it("respects OI headroom", () => {
    const d = decide(input({ assets: [{ symbol: "BTC", instrumentId: 0, impact: BTC, hourlyVol: 0.005, oiHeadroomUsd: 5_000 }] }));
    expect(d.action).toBe("hold");
  });
});
