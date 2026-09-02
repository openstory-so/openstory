/**
 * Type-safe Object.entries() that preserves key types.
 *
 * Only use on objects where you control all keys (module-level consts, enums).
 * Not safe for objects that may have extra properties at runtime.
 */
export function typedEntries<T extends Record<string, unknown>>(
  obj: T
): [Extract<keyof T, string>, T[keyof T]][] {
  // eslint-disable-next-line @typescript/no-unsafe-type-assertion - this is safe because we control the keys
  return Object.entries(obj) as [Extract<keyof T, string>, T[keyof T]][];
}

/**
 * Type-safe Object.fromEntries() that preserves key types.
 *
 * Note the asymmetry with typedEntries: an entries array may cover only a
 * subset of a source object's keys (e.g. after a filter), so this returns
 * Record<K, V> built from what's actually present — never assert it back to
 * the source object type.
 */
export function typedFromEntries<K extends string, V>(
  entries: readonly (readonly [K, V])[]
): Record<K, V> {
  // eslint-disable-next-line @typescript/no-unsafe-type-assertion - Record<K, V> is exactly what fromEntries builds from these pairs
  return Object.fromEntries(entries) as Record<K, V>;
}
