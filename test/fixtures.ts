import type { ImpactParams } from "../src/model/impact.js";

/** BTC instrument parameters at launch (docs + /state/trading). */
export const BTC: ImpactParams = {
  baseRate: 0.1,
  rateMultiplier: 15_000,
  positionMultiplier: 814.598,
  referenceNotional: 100_000,
  bustBuffer: 0.000476,
  maxLeverage: 1000,
  maxPositionNotional: 10_000_000,
};
