/**
 * The monthly spend cap a user sets on the consent screen for an app that
 * asks for `models:invoke` (docs/architecture/model-gateway.md § Apps and
 * user-pays). Client-safe: the consent page and Settings read the bounds.
 */

import { z } from 'zod';

/** The scope that spends the picked organization's credits through the gateway. */
export const MODELS_INVOKE_SCOPE = 'models:invoke';

/** The cap the consent screen offers first, in dollars. */
export const DEFAULT_MONTHLY_CAP_USD = 20;
/** The smallest cap a user can set, in dollars. */
export const MIN_MONTHLY_CAP_USD = 1;
/** The largest cap a user can set, in dollars. */
export const MAX_MONTHLY_CAP_USD = 1000;

const MICROS_PER_USD = 1_000_000;

/** Whole dollars to microdollars. */
export function monthlyCapUsdToMicros(usd: number): number {
  return Math.round(usd * MICROS_PER_USD);
}

/** A monthly cap in microdollars: whole dollars between the bounds. */
export const monthlyCapMicrosSchema = z
  .number()
  .int()
  .min(MIN_MONTHLY_CAP_USD * MICROS_PER_USD)
  .max(MAX_MONTHLY_CAP_USD * MICROS_PER_USD)
  .refine((value) => value % MICROS_PER_USD === 0, {
    message: 'A monthly cap is a whole number of dollars',
  });

/** True when a space-separated scope string asks for `models:invoke`. */
export function requestsModelsInvoke(scope: string): boolean {
  return scope.split(' ').includes(MODELS_INVOKE_SCOPE);
}
