/**
 * Narrow a partial test double to the wide type it stands in for.
 * Call sites pass only the surface the subject reads; this is the one
 * unsafe assertion those stubs are allowed.
 */
export function asStub<T>(stub: unknown): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the single test-double cast
  return stub as T;
}
