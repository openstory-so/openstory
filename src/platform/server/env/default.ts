import { createServerOnlyFn } from '@tanstack/react-start';

// Vitest and Node scripts only; every shipped runtime is workerd. Typed as the
// Worker env so callers see one shape on both branches of `#env`.
export const getEnv = createServerOnlyFn(
  (): Cloudflare.Env =>
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the one cast: bindings are absent under Node
    process.env as unknown as Cloudflare.Env
);
