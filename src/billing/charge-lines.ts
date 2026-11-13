/**
 * Charge lines (docs/architecture/model-gateway.md § Money): the parts one
 * wallet debit is made of. Client-safe.
 */

export const CHARGE_LINE_KINDS = [
  'provider_cost',
  'platform_fee',
  'app_margin',
  'app_charge',
] as const;

export type ChargeLineKind = (typeof CHARGE_LINE_KINDS)[number];

/** A short capture fills lines in this order, so payee lines are cut first and the provider cost last. */
const SHORT_CAPTURE_FILL_ORDER: readonly ChargeLineKind[] = [
  'provider_cost',
  'platform_fee',
  'app_charge',
  'app_margin',
];

/** Lines in the order a short capture fills them; stable within a kind. */
export function inFillOrder<T extends { kind: ChargeLineKind }>(
  lines: readonly T[]
): T[] {
  return lines
    .map((line, index) => ({ line, index }))
    .sort(
      (a, b) =>
        SHORT_CAPTURE_FILL_ORDER.indexOf(a.line.kind) -
          SHORT_CAPTURE_FILL_ORDER.indexOf(b.line.kind) || a.index - b.index
    )
    .map(({ line }) => line);
}

/** A payee line's earning matures into wallet credit this many days after the charge. */
export const EARNING_HOLD_DAYS = 14;

const EARNING_STATUSES = ['pending', 'matured', 'cancelled'] as const;
export type EarningStatus = (typeof EARNING_STATUSES)[number];
