import { z } from 'zod';

/** The ranges the Settings usage view offers, in days. */
export const gatewayUsageDaysSchema = z.union([
  z.literal(7),
  z.literal(30),
  z.literal(90),
]);

export type GatewayUsageDays = z.infer<typeof gatewayUsageDaysSchema>;

export const GATEWAY_USAGE_DAYS: readonly GatewayUsageDays[] =
  gatewayUsageDaysSchema.options.map((option) => option.value);

/** Midnight UTC opening the last `days` UTC days, today included, so the view shows exactly that many. */
export function gatewayUsageSince(days: GatewayUsageDays, now: Date): Date {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  return new Date(today - (days - 1) * 86_400_000);
}
