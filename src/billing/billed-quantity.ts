/**
 * Read `usage.billed` from a @tanstack/ai 1.0 `TokenUsage`.
 *
 * `TokenUsage.unitsBilled` is gone. Adapters pair the count with its unit
 * (`units` for fal's opaque billable units, `seconds` for a video, and so on).
 * Our ledger still stores the count as `unitsBilled` and prices it with the
 * endpoint's unit price, which already knows the unit. The span records both.
 *
 * A present `billed` that is not `{ quantity: finite number, unit: string }`
 * is `malformed`. Callers charge nothing and say so. They do not read another
 * field: tokens and the old `unitsBilled` count are different denominations.
 */

const MALFORMED_BILLED_REASON = 'usage.billed did not match { quantity, unit }';

export type BilledUsageRead =
  | { status: 'reported'; quantity: number; unit: string }
  | { status: 'absent' }
  | { status: 'malformed' };

export function readBilledUsage(usage: unknown): BilledUsageRead {
  if (typeof usage !== 'object' || usage === null || !('billed' in usage)) {
    return { status: 'absent' };
  }
  const billed = usage.billed;
  if (billed === undefined) return { status: 'absent' };
  if (
    typeof billed === 'object' &&
    billed !== null &&
    'quantity' in billed &&
    'unit' in billed &&
    typeof billed.quantity === 'number' &&
    Number.isFinite(billed.quantity) &&
    typeof billed.unit === 'string' &&
    billed.unit.length > 0
  ) {
    return {
      status: 'reported',
      quantity: billed.quantity,
      unit: billed.unit,
    };
  }
  return { status: 'malformed' };
}

/** Ledger count, span unit, and the reason a fal charge must stay at $0. */
export function billedFields(usage: unknown): {
  unitsBilled?: number;
  billedUnit?: string;
  missingUnitsReason?: string;
} {
  const read = readBilledUsage(usage);
  if (read.status === 'reported') {
    return { unitsBilled: read.quantity, billedUnit: read.unit };
  }
  if (read.status === 'malformed') {
    return { missingUnitsReason: MALFORMED_BILLED_REASON };
  }
  return {};
}
