/**
 * Microdollar Arithmetic
 * 1 USD = 1,000,000 microdollars. All money values stored as integers
 * to eliminate floating-point accumulation errors.
 *
 * This is the ONLY file that should cast `number` to `Microdollars`.
 * All other code should use micros(), usdToMicros(), or arithmetic helpers.
 */
// eslint-disable-next-line @typescript/no-unsafe-type-assertion -- branded type boundary: all casts are contained here
/* oxlint-disable typescript/no-unsafe-type-assertion */

export type Microdollars = number & { readonly __brand: 'Microdollars' };

const MICROS_PER_USD = 1_000_000;

/** Brand a raw integer as Microdollars (no conversion, just type cast) */
export function micros(value: number): Microdollars {
  return value as Microdollars;
}

export const ZERO_MICROS = micros(0);

export function usdToMicros(usd: number): Microdollars {
  return micros(Math.round(usd * MICROS_PER_USD));
}

export function microsToUsd(micros: Microdollars): number {
  return micros / MICROS_PER_USD;
}

export function microsToDisplayUsd(micros: Microdollars): string {
  const usd = microsToUsd(micros);
  // Use 2 decimal places for >= $0.01, 4 for smaller amounts
  if (Math.abs(usd) >= 0.01 || usd === 0) {
    return `$${usd.toFixed(2)}`;
  }
  return `$${usd.toFixed(4)}`;
}

export function addMicros(a: Microdollars, b: Microdollars): Microdollars {
  return micros(a + b);
}

export function negateMicros(value: Microdollars): Microdollars {
  return subtractMicros(ZERO_MICROS, value);
}

export function subtractMicros(a: Microdollars, b: Microdollars): Microdollars {
  return micros(a - b);
}

export function multiplyMicros(
  value: Microdollars,
  factor: number
): Microdollars {
  return micros(Math.round(value * factor));
}
