/**
 * Per-isolate startup (template seed, Better Auth `$context`) is one promise
 * cached for the life of the Worker. workerd ties that promise's I/O to the
 * request that created it. If the client disconnects first, the I/O is
 * dropped and the promise never settles, so every later request on that
 * instance hangs (#2073).
 *
 * `ctx.waitUntil` keeps the request context alive after the disconnect (up
 * to 30s) so the same promise can still resolve. Call it in the Worker
 * `fetch` handler, synchronously, before the first await of the promise —
 * and from there, not from a single route, because whichever request arrives
 * first is the one that creates it.
 *
 * The handler passed to `waitUntil` settles either way. A rejection must
 * still reach whoever awaits `promise` (sign-in should fail visibly), and
 * must not also surface as an unhandled `waitUntil` rejection.
 */
export function holdInstanceStartup(
  ctx: { waitUntil(promise: Promise<unknown>): void },
  promise: Promise<unknown>
): void {
  ctx.waitUntil(
    promise.then(
      () => undefined,
      () => undefined
    )
  );
}
