// Fixed-point helpers. Papertrade accounts USD and PAPER with 18 decimals.

export const WAD = 10n ** 18n;

/** USD (or PAPER) amount as a float → 18-decimal integer, rounded down to the cent-free wei. */
export function toWad(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new Error(`toWad: invalid value ${value}`);
  // Go through a fixed 6-decimal string to avoid float artefacts in the low digits.
  const micros = BigInt(Math.floor(value * 1e6));
  return micros * 10n ** 12n;
}

/** 18-decimal integer → float. Only for display and model maths, never for signing. */
export function fromWad(raw: bigint): number {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const whole = Number(abs / WAD);
  const frac = Number(abs % WAD) / 1e18;
  const v = whole + frac;
  return negative ? -v : v;
}

/** Parse a decimal integer string (as sent by the API) into bigint. */
export function big(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`big: unsafe number ${value}`);
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value)) throw new Error(`big: not an integer string: ${value}`);
  return BigInt(value);
}

export function bps(x: number): number {
  return x * 1e4;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function round(x: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
