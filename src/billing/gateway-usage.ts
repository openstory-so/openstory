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
