// Winning-close settlement: 0.2 bps deadband → asymmetric impact → 2% win fee (docs: "Asymmetric impact PnL").

import type { Instrument } from "../api/schemas.js";
import { fromWad } from "../util/num.js";

export interface ImpactParams {
  baseRate: number;
  rateMultiplier: number;
  positionMultiplier: number;
  referenceNotional: number;
  /** Fraction of price; liquidation fires this far before zero equity. */
  bustBuffer: number;
  maxLeverage: number;
  maxPositionNotional: number;
}

export const WIN_FEE = 0.02;
export const LOSS_FEE = 0.02;
export const DEADBAND = 1 / 50_000;

export function impactFromInstrument(i: Instrument): ImpactParams {
  return {
    baseRate: fromWad(i.baseRate),
    rateMultiplier: fromWad(i.rateMultiplier),
    positionMultiplier: fromWad(i.positionMultiplier),
    referenceNotional: fromWad(i.referenceNotional),
    bustBuffer: fromWad(i.bustBuffer),
    maxLeverage: i.maxLeverage,
    maxPositionNotional: fromWad(i.maxPositionNotional),
  };
}

/** Impact scale factor for a (post-deadband) move. */
export function impactScale(move: number, p: ImpactParams): number {
  if (move <= 0) return 0;
  const term1 = 1 / (move * p.rateMultiplier);
  const term2 = p.referenceNotional / (1e6 * move * p.positionMultiplier);
  return (1 - p.baseRate) / (1 + term1 + term2);
}

/** Fraction of the raw gain a winning close actually receives at a given favourable move. */
export function keepFraction(move: number, p: ImpactParams, winFee = WIN_FEE): number {
  if (move <= DEADBAND) return 0;
  const effective = move - DEADBAND;
  return (effective / move) * impactScale(effective, p) * (1 - winFee);
}

/** Price distance (fraction) from entry to the bust trigger at a given leverage. */
export function bustDistance(leverage: number, p: ImpactParams): number {
  return 1 / leverage - p.bustBuffer;
}
