/** The gateway's platform fee (docs/architecture/model-gateway.md § The platform fee). */

import { getEnv } from '#env';
import { z } from 'zod';

const feeBps = z
  .string()
  .regex(/^\d{1,5}$/)
  .transform(Number)
  .pipe(z.number().max(10_000));

/** `GATEWAY_PLATFORM_FEE_BPS` in basis points of provider cost; unset is 0, anything but 0-10000 throws. */
export function gatewayPlatformFeeBps(): number {
  const raw = getEnv().GATEWAY_PLATFORM_FEE_BPS;
  if (raw === undefined || raw === '') return 0;
  const parsed = feeBps.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      'GATEWAY_PLATFORM_FEE_BPS must be a whole number from 0 to 10000'
    );
  }
  return parsed.data;
}
