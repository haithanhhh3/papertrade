// Speed controller. Decides whether to open a new hedged pair now and with which asset,
// target move, leverage and margin. "Speed" is the rate at which the daily budget is spent:
// - the allowance is the daily budget, front-loaded when the mint rate is projected to fall;
// - the desired spend rate is that allowance spread over 24h, minus what open pairs already spend;
// - among feasible (asset, target) candidates under the cost cap, pick the one that mints the most
//   PAPER per hour at the desired spend rate, which favours wide (cheap) targets unless capital
//   is too small to spend the budget that way.

import type { ImpactParams } from "../model/impact.js";
import { evaluatePair, type Candidate } from "../model/economics.js";
import { mintRate, projectedMintRate, type MintParams, type MintState } from "../model/mint.js";

export interface AssetInput {
  symbol: string;
  instrumentId: number;
  impact: ImpactParams;
  hourlyVol: number;
  /** USD notional that still fits under the OI cap on the tighter of the two sides. */
  oiHeadroomUsd: number;
}

export interface ControllerInput {
  assets: AssetInput[];
  minNotional: number;
  minMargin: number;
  mint: MintState & { params: MintParams; velocityPerHour: number };
  queueActive: boolean;
  budget: {
    dailyUsd: number;
    spentTodayUsd: number;
    /** Expected cost of cycles currently open. */
    committedUsd: number;
    /** Expected spend per hour of pairs currently open. */
    openSpendPerHour: number;
  };
  /** Free margin per wallet (the smaller of the two), after the reserve and open pairs. */
  freeMarginUsd: number;
  openPairs: number;
  latencySec: number;
  settings: {
    maxPairs: number;
    maxCostPerPaper: number;
    bustSafetyMultiple: number;
    notionalBuffer: number;
    targetGrid: number[];
    urgencyKappa: number;
    maxFrontLoad: number;
    queuedPayoutValue: number;
  };
}

export interface ScoredCandidate extends Candidate {
  symbol: string;
  instrumentId: number;
  pairs: number;
  effectiveSpendPerHour: number;
  score: number;
}

export interface Decision {
  action: "open" | "hold";
  reason: string;
  mintRateNow: number;
  mintRate24h: number;
  urgency: number;
  allowanceUsd: number;
  budgetLeftUsd: number;
  targetSpendPerHour: number;
  choice?: ScoredCandidate;
  /** Best few candidates, for logging. */
  ranked: ScoredCandidate[];
}

export function decide(input: ControllerInput): Decision {
  const { mint, settings: s, budget } = input;
  const mintRateNow = mintRate(mint, mint.params);
  const mintRate24h = projectedMintRate(mint, mint.params, mint.velocityPerHour, 24);
  const urgency = mintRateNow > 0 ? Math.max(0, (mintRateNow - mintRate24h) / mintRateNow) : 0;
  const allowanceUsd = budget.dailyUsd * Math.min(s.maxFrontLoad, 1 + s.urgencyKappa * urgency);
  const budgetLeftUsd = allowanceUsd - budget.spentTodayUsd - budget.committedUsd;
  const targetSpendPerHour = allowanceUsd / 24;
  const base = { mintRateNow, mintRate24h, urgency, allowanceUsd, budgetLeftUsd, targetSpendPerHour, ranked: [] as ScoredCandidate[] };

  if (budgetLeftUsd <= 0) return { ...base, action: "hold", reason: "daily budget used" };
  const slots = s.maxPairs - input.openPairs;
  if (slots <= 0) return { ...base, action: "hold", reason: "max pairs open" };
  const rNew = targetSpendPerHour - budget.openSpendPerHour;
  if (rNew <= 0) return { ...base, action: "hold", reason: "open pairs already spend at the target rate" };
  if (input.freeMarginUsd <= 0) return { ...base, action: "hold", reason: "no free margin" };

  const marginPerLeg = input.freeMarginUsd / slots;
  const scored: ScoredCandidate[] = [];
  for (const a of input.assets) {
    for (const target of s.targetGrid) {
      const cycleGuess = (target / a.hourlyVol) ** 2;
      const rate = projectedMintRate(mint, mint.params, mint.velocityPerHour, cycleGuess);
      const c = evaluatePair(
        {
          target,
          impact: a.impact,
          hourlyVol: a.hourlyVol,
          latencySec: input.latencySec,
          bustSafetyMultiple: s.bustSafetyMultiple,
          minNotional: input.minNotional,
          minMargin: input.minMargin,
          notionalBuffer: s.notionalBuffer,
          marginPerLeg,
          maxMarginPerLeg: input.freeMarginUsd,
        },
        { mintRate: rate, queueActive: input.queueActive, queuedPayoutValue: s.queuedPayoutValue },
      );
      if (!c) continue;
      if (c.costPerPaper > s.maxCostPerPaper) continue;
      if (c.costPerCycle > budgetLeftUsd) continue;
      const byOi = Math.floor(a.oiHeadroomUsd / c.notional);
      const byMargin = Math.floor(input.freeMarginUsd / c.marginPerLeg);
      const maxPairs = Math.min(slots, byOi, byMargin);
      if (maxPairs < 1) continue;
      const pairs = Math.min(maxPairs, Math.max(1, Math.ceil(rNew / c.spendPerHour)));
      const effectiveSpendPerHour = pairs * c.spendPerHour;
      const score = Math.min(rNew, effectiveSpendPerHour) / c.costPerPaper;
      scored.push({ ...c, symbol: a.symbol, instrumentId: a.instrumentId, pairs, effectiveSpendPerHour, score });
    }
  }
  if (scored.length === 0) return { ...base, action: "hold", reason: "no candidate fits cost cap, margin, OI and budget" };

  // Avoid burning the day's budget in a burst: prefer candidates that stay within 1.5× the desired rate.
  const paced = scored.filter((c) => c.effectiveSpendPerHour <= 1.5 * rNew);
  const pool = paced.length ? paced : [...scored].sort((x, y) => x.effectiveSpendPerHour - y.effectiveSpendPerHour).slice(0, 1);
  pool.sort((x, y) => y.score - x.score || x.costPerPaper - y.costPerPaper);
  const ranked = [...scored].sort((x, y) => y.score - x.score).slice(0, 5);
  const choice = pool[0]!;
  return { ...base, ranked, action: "open", reason: paced.length ? "best paced candidate" : "slowest feasible candidate", choice };
}
