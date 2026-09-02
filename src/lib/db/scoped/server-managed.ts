import { typedEntries, typedFromEntries } from '@/shared/utils/typed-object';

/**
 * Runtime scrub for server-managed columns.
 *
 * The scoped write methods exclude server-managed columns (isPublic,
 * isTemplate, …) from their parameter types, but that is compile-time only:
 * TypeScript's excess-property check applies just to fresh object literals,
 * so any non-literal object can carry extra keys past an Omit<> parameter —
 * and drizzle's .values()/.set() writes any key that matches a real table
 * column. This helper enforces the exclusion at runtime, before the spread.
 */
export function stripServerManagedColumns<
  T extends Record<string, unknown>,
  K extends PropertyKey,
>(data: T, columns: Readonly<Record<K, true>>): Omit<T, K> {
  // Widened to string keys: the rebuilt record is asserted as Omit<T, K>
  // below, and TS can't compare a Record keyed by Extract<keyof T, string>
  // against Omit<T, K> for a generic T.
  const kept: [string, T[keyof T]][] = typedEntries(data).filter(
    ([key]) => !Object.hasOwn(columns, key)
  );
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- no type-level way to express "kept lacks exactly the K keys"; the filter guarantees it at runtime
  return typedFromEntries(kept) as Omit<T, K>;
}
