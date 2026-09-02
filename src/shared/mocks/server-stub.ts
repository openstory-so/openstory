// Chainable no-op stub used by .storybook/server-stub-plugin.ts.
// Every property access returns the same stub; calling it returns the same
// stub; constructing returns the same stub. Lets named imports of any shape
// (function, builder, class, constant) resolve without crashing at load.
//
// `then` returns a thenable that never resolves, so awaiting the result of
// a stubbed server fn (e.g. inside a TanStack Query queryFn) hangs forever
// instead of resolving to the stub itself. That keeps any pre-populated
// query cache data intact — without this, refetchInterval polls would
// overwrite mock data with the stub and crash downstream code that
// destructures it. The first await emits a console.warn so developers see
// when a story is relying on the hang (typically a missing setQueryData).

/* eslint-disable @typescript-eslint/no-explicit-any */

const target = function noop() {};

let warnedOnAwait = false;

const handler: ProxyHandler<typeof target> = {
  get: (_t, prop) => {
    if (prop === 'then') {
      return (_res: unknown, _rej: unknown) => {
        if (!warnedOnAwait) {
          warnedOnAwait = true;
          console.warn(
            '[storybook-server-stub] A server-only fn was awaited. The promise will hang to preserve any pre-populated query cache. If your story is stuck on a skeleton, pre-populate via queryClient.setQueryData(...).'
          );
        }
        // Return the stub so manual chains (`fn().then(...).catch(...)`) stay
        // thenable instead of yielding undefined. `await` ignores this return
        // value and waits for a resolve/reject that never fires, so the hang
        // semantics are preserved either way.
        return stub;
      };
    }
    if (prop === '__esModule') return true;
    if (prop === Symbol.toPrimitive) return () => '';
    return stub;
  },
  apply: () => stub,
  construct: () => target,
};

export const stub: any = new Proxy(target, handler);
