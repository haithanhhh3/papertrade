// Economics of one hedged pair: open a long and a short of equal notional at the same price,
// close both when the price has moved `target`. The loser's loss equals the winner's raw gain,
// so the cost of a cycle is loss × (1 − keep(target)) and the PAPER minted is E × basis.

import { bustDistance, keepFraction, LOSS_FEE, type ImpactParams } from "./impact.js";

export interface PairSizingInput {
  target: number;
  impact: ImpactParams;
  /** Hourly volatility of the asset (fraction). */
  hourlyVol: number;
  /** Relayer latency (seconds) for one intent to land. */
  latencySec: number;
  bustSafetyMultiple: number;
  minNotional: number;
  minMargin: number;
  notionalBuffer: number;
  /** Preferred margin per leg (an even split of free capital). */
  marginPerLeg: number;
  /** Upper bound on margin per leg; a candidate may go above the preferred size up to this to meet minimums. */
  maxMarginPerLeg?: number;
}

export interface PairEconomicsInput {
  /** Mint rate expected when the cycle closes. */
  mintRate: number;
  queueActive: boolean;
  /** Value of a queued payout relative to an immediate one. */
  queuedPayoutValue: number;
}

export interface Candidate {
  target: number;
  leverage: number;
  marginPerLeg: number;
  notional: number;
  keep: number;
  bustDistance: number;
  cycleHours: number;
  costPerCycle: number;
  paperPerCycle: number;
  costPerPaper: number;
  spendPerHour: number;
  paperPerHour: number;
}

/** Price move expected during one relayer round trip, at ~2 sigma. */
export function latencyMove(hourlyVol: number, latencySec: number): number {
  return 2 * hourlyVol * Math.sqrt(Math.max(latencySec, 0) / 3600);
}

/** Highest leverage whose bust distance still clears `bustSafetyMultiple × target` plus latency slippage. */
export function leverageForTarget(target: number, impact: ImpactParams, hourlyVol: number, latencySec: number, k: number): number {
  const needed = k * target + impact.bustBuffer + latencyMove(hourlyVol, latencySec);
  return Math.max(0, Math.min(impact.maxLeverage, Math.floor(1 / needed)));
}

/** Expected hours for the price to first leave the band ±target, plus open and close latency. */
export function expectedCycleHours(target: number, hourlyVol: number, latencySec: number): number {
  return (target / hourlyVol) ** 2 + (2 * latencySec) / 3600;
}

/** Returns undefined when the pair cannot be sized within the protocol minimums and our margin. */
export function evaluatePair(s: PairSizingInput, e: PairEconomicsInput): Candidate | undefined {
  const leverage = leverageForTarget(s.target, s.impact, s.hourlyVol, s.latencySec, s.bustSafetyMultiple);
  if (leverage < 1) return undefined;
  const requiredNotional = s.minNotional * (1 + s.notionalBuffer);
  const requiredMargin = Math.ceil(Math.max(s.minMargin, requiredNotional / leverage) * 100) / 100;
  if (requiredMargin > (s.maxMarginPerLeg ?? s.marginPerLeg)) return undefined;
  let margin = Math.max(s.marginPerLeg, requiredMargin);
  if (margin * leverage > s.impact.maxPositionNotional) margin = s.impact.maxPositionNotional / leverage;
  margin = Math.floor(margin * 100) / 100; // whole cents
  const notional = margin * leverage;
  if (notional < requiredNotional) return undefined;

  const keep = keepFraction(s.target, s.impact);
  const q = e.queueActive ? e.queuedPayoutValue : 1;
  const basisFactor = e.queueActive ? 1 : 1 - LOSS_FEE;
  const costPerCycle = notional * s.target * (1 - q * keep);
  const paperPerCycle = e.mintRate * basisFactor * notional * s.target;
  const cycleHours = expectedCycleHours(s.target, s.hourlyVol, s.latencySec);
  return {
    target: s.target,
    leverage,
    marginPerLeg: margin,
    notional,
    keep,
    bustDistance: bustDistance(leverage, s.impact),
    cycleHours,
    costPerCycle,
    paperPerCycle,
    costPerPaper: paperPerCycle > 0 ? costPerCycle / paperPerCycle : Number.POSITIVE_INFINITY,
    spendPerHour: costPerCycle / cycleHours,
    paperPerHour: paperPerCycle / cycleHours,
  };
}
