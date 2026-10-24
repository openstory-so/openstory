/**
 * Quantity `@tanstack/ai` 1.0 reports as `usage.billed`.
 *
 * `TokenUsage.unitsBilled` is gone. Adapters now pair the count with its unit
 * (`units` for fal's opaque billable units, `seconds` for a video, and so on).
 * Our ledger still stores that count as `unitsBilled` and prices it with the
 * endpoint's unit price, which already knows the unit.
 */
export function billedQuantity(usage: unknown): number | undefined {
  if (typeof usage !== 'object' || usage === null || !('billed' in usage)) {
    return undefined;
  }
  const billed = usage.billed;
  if (
    typeof billed !== 'object' ||
    billed === null ||
    !('quantity' in billed)
  ) {
    return undefined;
  }
  const quantity = billed.quantity;
  return typeof quantity === 'number' && Number.isFinite(quantity)
    ? quantity
    : undefined;
}
