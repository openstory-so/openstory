/** The gateway's platform fee (docs/architecture/model-gateway.md § The platform fee). */

import { getEnv } from '#env';
import type { Microdollars } from '@/billing/money';
import { gatewayCharge } from '@/gateway/charge-lines';
import { z } from 'zod';

/** A wrangler var in every block; unset only in unit tests, where it is 0. */
const feeBps = z
  .string()
  .regex(/^\d{1,5}$/)
  .default('0')
  .transform(Number)
  .pipe(z.number().max(10_000));

/** `GATEWAY_PLATFORM_FEE_BPS` in basis points of provider cost; anything but 0-10000 throws. */
export function gatewayPlatformFeeBps(): number {
  const parsed = feeBps.safeParse(getEnv().GATEWAY_PLATFORM_FEE_BPS);
  if (!parsed.success) {
    throw new Error(
      'GATEWAY_PLATFORM_FEE_BPS must be a whole number from 0 to 10000'
    );
  }
  return parsed.data;
}

/** An estimate plus the fee at this fee: every line of the charge it would settle to. */
export function gatewayHoldMicros(
  estimate: Microdollars,
  platformFeeBps: number = gatewayPlatformFeeBps()
): Microdollars {
  return gatewayCharge({ providerCostMicros: estimate, platformFeeBps })
    .totalMicros;
}
