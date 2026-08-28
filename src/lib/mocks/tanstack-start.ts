/**
 * Mock for @tanstack/react-start used in Storybook.
 *
 * Replaces createServerFn and createMiddleware so server functions
 * become no-ops that return never-resolving promises. This lets
 * React Query use pre-populated cache data without triggering
 * real HTTP calls to /_serverFn/.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

function createBuilder(handler?: (...args: any[]) => any) {
  const builder: Record<string, any> = {};

  // Every chained method returns the same builder
  for (const method of [
    'middleware',
    'inputValidator',
    'validator',
    'options',
    'server',
    'client',
  ]) {
    builder[method] = () => builder;
  }

  // .handler() terminates the chain and returns the callable function.
  // The returned fn never resolves — React Query keeps cached data instead
  // of overwriting it with the stub. First call per server fn emits a warn
  // so a missing setQueryData surfaces in the console.
  builder.handler = () => {
    let warned = false;
    const serverFn = () => {
      if (!warned) {
        warned = true;
        console.warn(
          '[storybook-mock] A stubbed server fn was called. Promise will hang. Pre-populate the query cache via queryClient.setQueryData(...) if your story renders this query.'
        );
      }
      return new Promise<never>(() => {});
    };
    // Attach builder methods to the function too (some code chains after .handler())
    Object.assign(serverFn, builder);
    return serverFn;
  };

  return handler ? builder.handler(handler) : builder;
}

export function createServerFn(_opts?: any) {
  return createBuilder();
}

export function createMiddleware(_opts?: any) {
  return createBuilder();
}

export function createCsrfMiddleware(_opts?: any) {
  return createBuilder();
}

// Re-export stubs for subpath imports (@tanstack/react-start/server)
export function getRequest() {
  return new Request('http://localhost');
}

// Other exports that might be imported from @tanstack/react-start
export function json(data: any, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...Object.fromEntries(new Headers(init?.headers).entries()),
    },
  });
}

export function createIsomorphicFn() {
  return createBuilder();
}

// `createServerOnlyFn(fn)` wraps a function that should only run on the server.
// In Storybook we just run the handler — `process.env` is polyfilled in
// .storybook/preview.tsx so handlers reading env vars work. Handlers that
// touch genuinely server-only things (db, fs, …) will fail at call time,
// which is the same failure mode as on the real client.
export function createServerOnlyFn(handler?: (...args: any[]) => any) {
  if (typeof handler === 'function') {
    return handler;
  }
  return createBuilder();
}

export function getRequestHeaders(): Record<string, string> {
  return {};
}
