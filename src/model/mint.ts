// PAPER mint curve (docs: "PAPER mint curve"): flat below the threshold, then flat · (S/(S+H))².

export interface MintParams {
  /** lpFlatThresholdUsd */
  cliff: number;
  /** flatRate, PAPER per $1 of mint basis */
  flat: number;
  /** tailDecayScaleUsd */
  scale: number;
}

export interface MintState {
  trackedLp: number;
  /** tailProgressUsd: high-water mark of LP gain past the threshold. */
  tail: number;
}

export function mintRate(s: MintState, p: MintParams): number {
  if (s.trackedLp < p.cliff) return p.flat;
  const r = p.scale / (p.scale + Math.max(0, s.tail));
  return p.flat * r * r;
}

/** Projected mint rate after `hours`, extrapolating tracked LP at `velocityPerHour` (USD/h). */
export function projectedMintRate(s: MintState, p: MintParams, velocityPerHour: number, hours: number): number {
  const growth = Math.max(0, velocityPerHour) * hours;
  const lp = s.trackedLp + growth;
  if (lp < p.cliff) return p.flat;
  // Tail progress only advances by the part of the growth that happens above the threshold.
  const aboveBefore = Math.max(0, s.trackedLp - p.cliff);
  const aboveAfter = lp - p.cliff;
  const tail = Math.max(s.tail, s.tail + (aboveAfter - aboveBefore));
  return mintRate({ trackedLp: lp, tail }, p);
}

/** Linear-regression slope (USD/hour) of tracked LP samples [(ms, usd)]. */
export function lpVelocity(samples: ReadonlyArray<readonly [number, number]>): number {
  if (samples.length < 3) return 0;
  const t0 = samples[0]![0];
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const [t, y] of samples) {
    const x = (t - t0) / 3_600_000;
    n++;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const den = n * sxx - sx * sx;
  return den > 0 ? (n * sxy - sx * sy) / den : 0;
}
